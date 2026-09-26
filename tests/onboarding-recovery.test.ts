import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it.each(['recovery-missing', 'recovery-corrupt', 'checksum', 'policy', 'oversized-missing', 'displacement-corrupt', 'concurrent-edit'])('blocks unsafe recovery without replacing evidence: %s', async fault => {
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
    if (fault === 'concurrent-edit') await writeFile(join(root, 'note.md'), 'edited during recovery\n');
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery' });
    await restarted.initialize();
    const resumed = (restarted as any).client;
    expect((await resumed.readState()).last_error_code).toBe('apply_journal_recovery_required');
    const reason = ({ 'recovery-missing': 'recovery_evidence_missing', 'oversized-missing': 'recovery_evidence_missing', 'recovery-corrupt': 'recovery_identity_mismatch', checksum: 'recovery_checksum_mismatch', policy: 'recovery_target_policy_mismatch', 'displacement-corrupt': 'recovery_checksum_mismatch', 'concurrent-edit': 'local_files_diverge_from_journal' } as Record<string, string>)[fault];
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
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe(fault === 'concurrent-edit' ? 'edited during recovery\n' : 'target bytes\n');
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
