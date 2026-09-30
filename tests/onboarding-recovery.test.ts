import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';
import { parseDiagnosticEvent } from '../src/shared/diagnostics.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function client() {
  await mkdir('tmp/recovery-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/recovery-tests/client-'));
  roots.push(root);
  const wrapper = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
  await wrapper.initialize();
  return { root, core: (wrapper as any).client };
}

describe('durable onboarding recovery admission', () => {
  it.each([null, {}, { connection_secret: '' }, { connection_secret: 42 }])('preserves unfinished setup when the credential is incomplete: %j', async credential => {
    const { core } = await client();
    await core.writeOnboardingJournal({ version: 1, stage: 'blocked', connection: { connection_id: 'connection' }, analysis: null, selected_mode: 'use_server' });
    if (credential !== null) await core.fsp.writeFile(core.pendingConnectionPath, JSON.stringify(credential));
    const original = await core.fsp.readFile(core.onboardingJournalPath, 'utf8');
    await expect(core.readPendingOnboarding()).rejects.toMatchObject({ code: 'onboarding_context_required' });
    await expect(core.startOnboarding('vault')).rejects.toMatchObject({ code: 'onboarding_context_required' });
    expect(await core.fsp.readFile(core.onboardingJournalPath, 'utf8')).toBe(original);
    if (credential !== null) expect(await core.fsp.readFile(core.pendingConnectionPath, 'utf8')).toBe(JSON.stringify(credential));
  });
  it('rejects missing or malformed resume input before scanning', async () => {
    const { core } = await client();
    await core.fsp.writeFile(core.pendingConnectionPath, JSON.stringify({ connection_secret: 'synthetic' }));
    await core.writeOnboardingJournal({ version: 1, stage: 'blocked', connection: { connection_id: 'connection' }, analysis: null, selected_mode: 'merge', last_error_code: null });
    core.localSnapshotSummary = vi.fn();
    core.pollOnboarding = vi.fn();
    await expect(core.finishOnboarding('connection', 'synthetic', null, 'merge')).rejects.toMatchObject({ code: 'onboarding_context_required' });
    expect(core.localSnapshotSummary).not.toHaveBeenCalled();
    expect(core.pollOnboarding).not.toHaveBeenCalled();
  });

  it('preserves malformed acknowledgement evidence before same-target apply or pull', async () => {
    const { core, root } = await client();
    const file = join(root, '.obts/pending-applied-ack.json');
    await writeFile(file, '{');
    await expect(core.applyTargetMain('a'.repeat(40), [], true)).rejects.toMatchObject({ code: 'applied_main_acknowledgement_failed' });
    await expect(core.pull('vault', 'device', 'synthetic', null)).rejects.toMatchObject({ code: 'applied_main_acknowledgement_failed' });
    expect(await readFile(file, 'utf8')).toBe('{');
  });

  it.each(['recovery-missing', 'recovery-corrupt', 'checksum', 'policy', 'oversized-missing', 'displacement-corrupt'])('blocks unsafe recovery without replacing evidence: %s', async fault => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'original bytes\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'note.md'), 'target bytes\n');
    const target = await core.createLocalCommit('target');
    await writeFile(join(root, 'note.md'), 'original bytes\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
    const write = core.writeTargetFilesFromJournal.bind(core);
    core.writeTargetFilesFromJournal = async (...args: any[]) => { await write(...args); throw new Error('Synthetic process interruption'); };
    await expect(core.applyTargetMain(target, ['note.md'], true, [], false, [], [], 1, false, null, { 'note.md': 13 })).rejects.toThrow('Synthetic process interruption');
    const journalPath = join(root, '.obts/apply-journal.json');
    const saved = JSON.parse(await readFile(journalPath, 'utf8'));
    const bundleFile = join(root, '.obts/recovery', saved.recovery_bundle_id, 'complete.json');
    if (fault === 'recovery-missing' || fault === 'oversized-missing') await rm(bundleFile);
    if (fault === 'oversized-missing') await writeFile(journalPath, JSON.stringify({ ...saved, padding: 'SYNTHETIC_PRIVATE_MARKER'.repeat(30000) }));
    if (fault === 'checksum') await writeFile(join(root, '.obts/recovery', saved.recovery_bundle_id, 'checksums.sha256'), 'wrong checksum\n');
    if (fault === 'policy') await writeFile(journalPath, JSON.stringify({ ...saved, target_root_ignore_oid: 'b'.repeat(40) }));
    if (fault === 'recovery-corrupt') await writeFile(bundleFile, '{}');
    if (fault === 'displacement-corrupt') await writeFile(join(root, '.obts/apply-displaced', saved.apply_id, 'note.md.entry'), 'unexpected displaced bytes\n');
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await restarted.initialize();
    const resumed = (restarted as any).client;
    expect((await resumed.readState()).last_error_code).toBe('apply_journal_recovery_required');
    const reason = ({ 'recovery-missing': 'recovery_evidence_missing', 'oversized-missing': 'recovery_evidence_missing', 'recovery-corrupt': 'recovery_identity_mismatch', checksum: 'recovery_checksum_mismatch', policy: 'recovery_target_policy_mismatch', 'displacement-corrupt': 'recovery_checksum_mismatch' } as Record<string, string>)[fault];
    const context = await resumed.collectTroubleshootingContext();
    expect(context.recovery_summary.apply_error).toBe(reason);
    if (fault === 'oversized-missing') expect(context.recovery_summary.apply_read).toBe('oversized');
    expect(JSON.stringify(context)).not.toContain('note.md');
    expect(JSON.stringify(context)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(JSON.stringify(context)).not.toContain(target);
    await resumed.initialize();
    expect((await resumed.collectTroubleshootingContext()).recovery_summary.apply_error).toBe(reason);
    await expect(resumed.applyTargetMain(target, [], true)).rejects.toMatchObject({ code: 'apply_journal_recovery_required' });
    expect(JSON.parse(await readFile(journalPath, 'utf8')).apply_id).toBe(saved.apply_id);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('target bytes\n');
  });

  it('completes a diverged interrupted apply while preserving the edited path', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'original bytes\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'note.md'), 'target bytes\n');
    const target = await core.createLocalCommit('target');
    await writeFile(join(root, 'note.md'), 'original bytes\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
    const write = core.writeTargetFilesFromJournal.bind(core);
    core.writeTargetFilesFromJournal = async (...args: any[]) => { await write(...args); throw new Error('Synthetic process interruption'); };
    await expect(core.applyTargetMain(target, ['note.md'], true, [], false, [], [], 1, false, null, { 'note.md': 13 })).rejects.toThrow('Synthetic process interruption');
    await writeFile(join(root, 'note.md'), 'edited during recovery\n');

    const resumed = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await resumed.initialize();
    const recovered = (resumed as any).client;
    const recoveredState = await recovered.readState();
    expect(recoveredState.local_main).toBe(target);
    expect(recoveredState.last_error_code).toBeNull();
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('edited during recovery\n');
    expect(await recovered.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: recoveredState.local_head });
    await expect(readFile(join(root, '.obts/apply-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a displaced path while preserving the other edited path during automatic recovery', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'a.md'), 'a original\n');
    await writeFile(join(root, 'b.md'), 'b original\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'a.md'), 'a target\n');
    await writeFile(join(root, 'b.md'), 'b target\n');
    const target = await core.createLocalCommit('target');
    await writeFile(join(root, 'a.md'), 'a original\n');
    await writeFile(join(root, 'b.md'), 'b original\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
    const displace = core.displaceApplyPath.bind(core);
    let interrupted = false;
    core.displaceApplyPath = async (...args: any[]) => {
      const retainedFile = await displace(...args);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic interruption after displacement');
      }
      return retainedFile;
    };
    await expect(core.applyTargetMain(target, ['a.md', 'b.md'], true, [], false, [], [], 1, false, null, { 'a.md': 9, 'b.md': 9 }))
      .rejects.toThrow('Synthetic interruption after displacement');
    core.displaceApplyPath = displace;
    await writeFile(join(root, 'b.md'), 'b edited during recovery\n');

    const resumed = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await resumed.initialize();
    const recovered = (resumed as any).client;
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('a target\n');
    expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('b edited during recovery\n');
    const recoveredState = await recovered.readState();
    expect(recoveredState).toMatchObject({ local_main: target, last_error_code: null });
    expect(await recovered.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: recoveredState.local_head });
    await expect(readFile(join(root, '.obts/apply-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a diverged subtree when the target needs the conflicting parent path', async () => {
    const { core, root } = await client();
    await mkdir(join(root, 'notes.md'));
    await writeFile(join(root, 'notes.md', 'c.md'), 'child original\n');
    await writeFile(join(root, 'other.md'), 'other\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await rm(join(root, 'notes.md'), { recursive: true, force: true });
    await writeFile(join(root, 'notes.md'), 'target file\n');
    const target = await core.createLocalCommit('target');
    await rm(join(root, 'notes.md'), { force: true });
    await mkdir(join(root, 'notes.md'));
    await writeFile(join(root, 'notes.md', 'c.md'), 'child original\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
    const write = core.writeTargetFilesFromJournal.bind(core);
    core.writeTargetFilesFromJournal = async () => { throw new Error('Synthetic process interruption'); };
    await expect(core.applyTargetMain(target, ['notes.md', 'notes.md/c.md'], true, [], false, [], [], 1, false, null, { 'notes.md': 12, 'notes.md/c.md': 15 }))
      .rejects.toThrow('Synthetic process interruption');
    core.writeTargetFilesFromJournal = write;
    await writeFile(join(root, 'notes.md', 'c.md'), 'child edited during recovery\n');

    const resumed = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await resumed.initialize();
    const recovered = (resumed as any).client;
    expect((await lstat(join(root, 'notes.md'))).isDirectory()).toBe(true);
    expect(await readFile(join(root, 'notes.md', 'c.md'), 'utf8')).toBe('child edited during recovery\n');
    expect(await readFile(join(root, 'other.md'), 'utf8')).toBe('other\n');
    const recoveredState = await recovered.readState();
    expect(recoveredState).toMatchObject({ local_main: target, last_error_code: null });
    expect(await recovered.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: recoveredState.local_head });
    await expect(readFile(join(root, '.obts/apply-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('completes server apply while preserving repeated local edits made during writes and capture', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'base bytes\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'note.md'), 'server bytes\n');
    const target = await core.createLocalCommit('server');
    await writeFile(join(root, 'note.md'), 'base bytes\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({
      ...await core.readState(),
      vault_id: 'vault',
      device_id: 'device',
      local_main: base,
      local_head: base,
      server_device_ref: base
    });

    const write = core.writeTargetFilesFromJournal.bind(core);
    core.writeTargetFilesFromJournal = async (...args: any[]) => {
      await write(...args);
      await writeFile(join(root, 'note.md'), 'edit during apply\n');
    };
    const scan = core.localChangedPathsFromTree.bind(core);
    let editedDuringCapture = false;
    core.localChangedPathsFromTree = async (...args: any[]) => {
      const result = await scan(...args);
      if (args[1] === true && !editedDuringCapture) {
        editedDuringCapture = true;
        await writeFile(join(root, 'note.md'), 'edit during snapshot\n');
      }
      return result;
    };

    await expect(core.applyTargetMain(
      target, ['note.md'], true, ['note.md'], false, [], [], 1, false, null, { 'note.md': 13 }
    )).resolves.toBe(true);
    expect(editedDuringCapture).toBe(true);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('edit during snapshot\n');
    const state = await core.readState();
    const queue = await core.readQueue();
    expect(state).toMatchObject({ local_main: target, last_error_code: null, status_label: 'Ahead' });
    expect(queue).toMatchObject({ status: 'queued_local', pending_commit: state.local_head });
    const queuedTree = await core.listTreeBlobOids(queue.pending_commit);
    expect(await core.readBlobOid(queuedTree.get('note.md'))).toEqual(Buffer.from('edit during snapshot\n'));
    await expect(readFile(join(root, '.obts/apply-journal.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a file edited after displaced evidence is copied while applying independent target paths', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'base bytes\n');
    await writeFile(join(root, 'other.md'), 'base other\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'note.md'), 'server bytes\n');
    await writeFile(join(root, 'other.md'), 'server other\n');
    const target = await core.createLocalCommit('server');
    await writeFile(join(root, 'note.md'), 'base bytes\n');
    await writeFile(join(root, 'other.md'), 'base other\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({
      ...await core.readState(),
      vault_id: 'vault',
      device_id: 'device',
      local_main: base,
      local_head: base,
      server_device_ref: base
    });

    const matches = core.applyDisplacedEntryMatchesPreflight.bind(core);
    let edited = false;
    core.applyDisplacedEntryMatchesPreflight = async (...args: any[]) => {
      const result = await matches(...args);
      if (args[1] === 'note.md' && !edited) {
        edited = true;
        await writeFile(join(root, 'note.md'), 'edit during displacement\n');
      }
      return result;
    };

    await expect(core.applyTargetMain(
      target, ['note.md', 'other.md'], true, [], false, [], [], 1, false, null,
      { 'note.md': 13, 'other.md': 13 }
    )).resolves.toBe(true);
    expect(edited).toBe(true);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('edit during displacement\n');
    expect(await readFile(join(root, 'other.md'), 'utf8')).toBe('server other\n');
    const state = await core.readState();
    const queue = await core.readQueue();
    expect(state).toMatchObject({ local_main: target, last_error_code: null, status_label: 'Ahead' });
    expect(queue).toMatchObject({ status: 'queued_local', pending_commit: state.local_head });
  });

  it('binds a replacement baseline to its onboarding context', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'consented bytes\n');
    await core.writeState({ ...await core.readState(), vault_id: 'source-vault', device_id: 'source-device' });
    const context = {
      connection_id: 'connection-one',
      vault_id: 'vault-one',
      source_vault_id: 'source-vault',
      source_device_id: 'source-device',
      target_main: 'a'.repeat(40),
      affected_paths: ['note.md']
    };
    const bundleId = await core.createStableRecoveryBundle(
      'replace_local_with_server', context.target_main, context.affected_paths, 3, context
    );
    expect(bundleId).toMatch(/^rec_/u);
    await expect(core.readRecoveryBundleFingerprints(bundleId, context)).resolves.toHaveProperty('size', 1);
    const wrongOperationBundleId = await core.createStableRecoveryBundle(
      'initial_import', context.target_main, context.affected_paths, 3, context
    );
    await expect(core.readRecoveryBundleFingerprints(wrongOperationBundleId, context))
      .rejects.toMatchObject({ code: 'onboarding_context_required' });
    for (const mismatchedContext of [
      { ...context, connection_id: 'connection-two' },
      { ...context, vault_id: 'vault-two' },
      { ...context, source_vault_id: 'other-source-vault' },
      { ...context, source_device_id: 'other-source-device' },
      { ...context, target_main: 'b'.repeat(40) },
      { ...context, affected_paths: ['other.md'] }
    ]) {
      await expect(core.readRecoveryBundleFingerprints(bundleId, mismatchedContext))
        .rejects.toMatchObject({ code: 'onboarding_context_required' });
    }
  });

  it('reports the retained pre-write failure instead of claiming missing evidence with reason none', async () => {
    const { core, root } = await client();
    await writeFile(join(root, 'note.md'), 'original\n');
    const base = await core.createLocalCommit('base');
    await core.updateRef('refs/heads/main', base, null, true);
    await writeFile(join(root, 'note.md'), 'target\n');
    const target = await core.createLocalCommit('target');
    await writeFile(join(root, 'note.md'), 'original\n');
    await core.updateRef('refs/heads/local', base, null, true);
    await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
    core.finalizeRecoveryBundle = async () => { throw new Error('synthetic storage failure'); };
    await expect(core.applyTargetMain(target, ['note.md'], true, [], false, [], [], 1, false, null, { 'note.md': 7 }))
      .rejects.toMatchObject({ code: 'recovery_bundle_failed' });
    const before = JSON.parse(await readFile(join(root, '.obts/apply-journal.json'), 'utf8'));
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await restarted.initialize();
    await expect((restarted as any).client.admitApplyRecovery()).rejects.toThrow('(recovery_bundle_failed)');
    expect(JSON.parse(await readFile(join(root, '.obts/apply-journal.json'), 'utf8')).apply_id).toBe(before.apply_id);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('original\n');
  });

  it('does not replace an unresolved journal without a lock, including same-target apply', async () => {
    const { core, root } = await client();
    const journalPath = join(root, '.obts/apply-journal.json');
    const evidence = '{"incomplete":"preserve this evidence"}';
    await writeFile(journalPath, evidence);
    await core.writeState({ ...await core.readState(), local_main: 'a'.repeat(40) });
    await expect(core.applyTargetMain('a'.repeat(40), [], true)).rejects.toMatchObject({ code: 'apply_journal_recovery_required' });
    expect(await readFile(journalPath, 'utf8')).toBe(evidence);
  });

  it('uses a complete immutable checkpoint when canonical main advanced', async () => {
    const { core, root } = await client();
    const target = 'a'.repeat(40);
    // Checkpoint schema/object validation is exercised separately; this isolates admission.
    core.syncCapabilities = async () => ({ max_transfer_chunks: 100, max_transfer_bytes: 10000 });
    core.getDeviceSelf = async () => ({ current_main: 'b'.repeat(40) });
    core.commitExists = async () => true;
    core.pullChunk = vi.fn(async () => { throw new Error('bulk transfer restarted'); });
    core.validateCompleteTransferCheckpoint = vi.fn(async () => undefined);
    await writeFile(join(root, '.obts/pull-transfer.json'), JSON.stringify({ vault_id: 'vault', device_id: 'device', current_local_main: null, current_event_seq: 0, target_main: target, complete: true }));
    await expect(core.pull('vault', 'device', 'synthetic-token', null, 'latest', 0)).rejects.toMatchObject({ code: 'invalid_transfer_checkpoint' });
    expect(core.pullChunk).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.obts/pull-transfer.json'), 'utf8')).toContain(target);
  });
});

describe('bounded sanitized journal diagnostics', () => {
  const cap = 512 * 1024;
  function journal() {
    return { apply_id: 'apply_123_abcdef12', operation_type: 'pull_apply', target_main: 'a'.repeat(40), expected_prior_local_main: null, expected_prior_local_device_ref: null, phase: 'blocked_recovery', affected_paths: [], preflight_sha256: {}, recovery_bundle_id: null, last_completed_step: null, redacted_error_category: 'local_files_diverge_from_journal' };
  }
  it.each([256 * 1024 + 1, cap - 1, cap])('reads a valid journal of exactly %i bytes within the raised cap', async size => {
    const { core, root } = await client();
    const json = JSON.stringify(journal());
    await writeFile(join(root, '.obts/apply-journal.json'), json.padEnd(size));
    const context = await core.collectTroubleshootingContext();
    expect(context).toMatchObject({ apply_journal: 'blocked_recovery', recovery_summary: { apply_read: 'valid', apply_error: 'local_files_diverge_from_journal' } });
  });
  it('uses a fresh compact summary for an oversized journal after an ordinary validated read', async () => {
    const { core, root } = await client();
    const file = join(root, '.obts/apply-journal.json');
    await writeFile(file, JSON.stringify({ ...journal(), untrusted: 'SYNTHETIC_PRIVATE_MARKER'.repeat(30000) }));
    expect((await core.collectTroubleshootingContext()).recovery_summary.apply_read).toBe('oversized');
    await core.initialize();
    const context = await core.collectTroubleshootingContext();
    expect(context).toMatchObject({ apply_journal: 'blocked_recovery', safe_error_code: 'apply_journal_recovery_required', recovery_summary: { apply_read: 'oversized', apply_error: 'recovery_evidence_missing' } });
    expect(JSON.stringify(context)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(JSON.stringify(context)).not.toContain('a'.repeat(40));
    expect(JSON.stringify(context).length).toBeLessThan(4096);
    await writeFile(file, 'x'.repeat(cap + 1));
    expect(await core.collectTroubleshootingContext()).toMatchObject({ apply_journal: 'present_unclassified', recovery_summary: { apply_read: 'oversized' } });
  });
  it('reports bounded consent and phase observations for an oversized onboarding journal', async () => {
    const { core } = await client();
    await core.writeOnboardingJournal({ version: 1, stage: 'blocked', connection: { connection_id: 'synthetic' }, analysis: null, selected_mode: 'use_server', last_error_code: null,
      pending_summary: { fingerprint: 'b'.repeat(64), file_count: 1, bytes: 3 }, padding: 'SYNTHETIC_PRIVATE_MARKER'.repeat(30000) });
    const context = await core.collectTroubleshootingContext();
    expect(context).toMatchObject({ onboarding_journal: 'blocked', recovery_summary: { consent: 'saved' } });
    expect(JSON.stringify(context)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(JSON.stringify(context)).not.toContain('b'.repeat(64));
  });

  it('distinguishes malformed, oversized and unreadable and accepts old diagnostic payloads', async () => {
    const { core, root } = await client();
    const file = join(root, '.obts/apply-journal.json');
    await writeFile(file, 'x'.repeat(cap));
    expect((await core.collectTroubleshootingContext()).recovery_summary.apply_read).toBe('invalid');
    await writeFile(file, 'x'.repeat(cap + 1));
    expect((await core.collectTroubleshootingContext()).recovery_summary.apply_read).toBe('oversized');
    const read = core.fsp.readFileBounded.bind(core.fsp);
    core.fsp.readFileBounded = (path: string, ...args: unknown[]) => {
      if (path.endsWith('/apply-journal.json')) throw Object.assign(new Error('synthetic permission error'), { code: 'EACCES' });
      return read(path, ...args);
    };
    const context = await core.collectTroubleshootingContext();
    expect(context.recovery_summary.apply_read).toBe('unreadable');
    const event = { schema_version: 2, event_id: 'dgr_0123456789abcdef0123456789abcdef', plugin_version: '0.5.2', obsidian_version: '1.9.12', platform_family: 'ios', flow: 'recovery', stage: 'recovery', failure_code: 'troubleshooting_snapshot', error_class: 'unknown', retryable: false, breadcrumbs: [], context };
    expect(() => parseDiagnosticEvent(event)).not.toThrow();
    const { recovery_summary: _summary, ...legacyContext } = context;
    expect(() => parseDiagnosticEvent({ ...event, context: legacyContext })).not.toThrow();
    expect(() => parseDiagnosticEvent({ ...event, context: { ...context, recovery_summary: { ...context.recovery_summary, raw_path: 'disallowed' } } })).toThrow();
  });
});
