import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { MemoryDataAdapter } from './helpers/memoryDataAdapter.js';

const require = createRequire(import.meta.url);
const { ObtsClientCore, installPathMutationGate } = require('../obsidian-plugin/src/main.cjs') as {
  ObtsClientCore: new (plugin: any) => any;
  installPathMutationGate: (adapter: MemoryDataAdapter, owner: object) => unknown;
};
const { createDataAdapterFs } = require('../obsidian-plugin/src/data-adapter-fs.cjs') as {
  createDataAdapterFs: (adapter: MemoryDataAdapter, gate?: unknown) => any;
};

const settings = { serverUrl: 'http://127.0.0.1:1', deviceName: 'heal-fixture' };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NOTE_A = 'alpha baseline\n';
const NOTE_B = 'beta baseline\n';
const NOTE_A_TARGET = 'alpha from the server\n';
const NOTE_B_TARGET = 'beta from the server\n';
const NOTE_NEW_TARGET = 'the delta adds this note\n';
const KEEP = 'unrelated note\n';
const EDITED_AFTER_CRASH = 'beta edited locally after the crash\n';
const NOTE_A_SECOND_TARGET = 'alpha from a later server main\n';

type Vault = {
  root: string;
  core: any;
  base: string;
  journalPath: string;
  ackPath: string;
  lockPath: string;
  targetSizes?: Record<string, number>;
};

async function readJson<T = any>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function fileBytes(filePath: string): Promise<string | null> {
  return await readFile(filePath, 'utf8').catch(() => null);
}

async function vault(files: Record<string, string>): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), 'obts-journal-heal-'));
  roots.push(root);
  for (const [filePath, bytes] of Object.entries(files)) await writeFile(join(root, filePath), bytes);
  const client = new ObtsPluginClient(root, settings);
  await client.initialize();
  const core = (client as any).client;
  const base = await core.createLocalCommit('baseline');
  await core.updateRef('refs/heads/main', base, null, true);
  await core.updateRef('refs/heads/local', base, null, true);
  await core.writeState(Object.assign({}, await core.readState(), {
    user_id: 'usr_heal_fixture',
    vault_id: 'vlt_heal_fixture',
    device_id: 'dev_heal_fixture',
    device_name: 'heal-fixture',
    device_ref: 'device-ref-heal',
    server_device_ref: base,
    local_main: base,
    local_head: base,
    initial_import_confirmed: true,
    status_label: 'Checking',
    last_error_code: null,
    last_event_seq: 7,
    last_applied_event_seq: 7,
    updated_at: new Date().toISOString()
  }));
  return {
    root,
    core,
    base,
    journalPath: join(root, '.obts', 'apply-journal.json'),
    ackPath: join(root, '.obts', 'pending-applied-ack.json'),
    lockPath: join(root, '.obts', 'apply.lock')
  };
}

/** Commit the server target tree, then restore the pre-apply working bytes. */
async function prepareTarget(value: Vault, next: Record<string, string>, removed: string[] = []): Promise<string> {
  const before: Record<string, string | null> = {};
  for (const filePath of [...Object.keys(next), ...removed]) {
    before[filePath] = await fileBytes(join(value.root, filePath));
  }
  const priorLocal = await value.core.resolveRef('refs/heads/local');
  for (const [filePath, bytes] of Object.entries(next)) await writeFile(join(value.root, filePath), bytes);
  for (const filePath of removed) await rm(join(value.root, filePath), { force: true });
  const target = await value.core.createLocalCommit('server target');
  await value.core.updateRef('refs/heads/local', priorLocal, null, true);
  value.targetSizes = Object.fromEntries(Object.entries(next).map(([filePath, bytes]) => [filePath, Buffer.byteLength(bytes)]));
  for (const [filePath, bytes] of Object.entries(before)) {
    if (bytes === null) await rm(join(value.root, filePath), { force: true });
    else await writeFile(join(value.root, filePath), bytes);
  }
  return target;
}

type CrashPlan = {
  crashIn?: 'writes' | 'planned' | 'tail' | 'tail-refresh' | 'refs';
  writeBeforeCrash?: string[];
  localEditAfterWrites?: Record<string, string>;
  rebuild?: boolean;
  cleanState?: boolean;
};

/**
 * Run a real ordinary apply and suspend it at a durable point. The recovery
 * bundle and its journal copy are produced by the plugin itself, so the
 * quarantine and checksum evidence used by recovery is genuine.
 */
async function applyUntilSuspension(value: Vault, target: string, plan: CrashPlan = {}): Promise<void> {
  const core = value.core;
  if (plan.crashIn === 'planned') {
    const retain = core.retainApplyProvenance.bind(core);
    let calls = 0;
    core.retainApplyProvenance = async (...args: any[]) => {
      await retain(...args);
      if (calls++ === 0) throw new Error('synthetic suspension before the bundle');
    };
  } else if (plan.crashIn === 'tail') {
    const acknowledge = core.writePendingAppliedAcknowledgement.bind(core);
    let suspended = false;
    core.writePendingAppliedAcknowledgement = async (...args: any[]) => {
      if (!suspended) {
        suspended = true;
        throw new Error('synthetic suspension in the apply tail');
      }
      return await acknowledge(...args);
    };
  } else if (plan.crashIn === 'tail-refresh') {
    // A committed journal whose tail has not reached its own capture yet: the
    // crash the next launch resumes from. No bundle is published in this pass.
    core.refreshDirectoryStateFromDisk = async () => { throw new Error('synthetic suspension in the apply tail'); };
  } else if (plan.crashIn === 'refs') {
    // A local edit lands after the writes and before the tail capture, so a
    // rebuild that sees it publishes its preserved-path bundle for the very
    // paths it wrote: the window then owns two bundles, not one.
    const retain = core.retainApplyProvenance.bind(core);
    core.retainApplyProvenance = async (...args: any[]) => {
      await retain(...args);
      if (args[1] !== true || !plan.localEditAfterWrites) return;
      for (const [filePath, bytes] of Object.entries(plan.localEditAfterWrites)) {
        await writeFile(join(value.root, filePath), bytes);
      }
      // Bundle identities are millisecond stamps; keep the tail's strictly newer.
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    };
    const updateRef = core.updateRef.bind(core);
    core.updateRef = async (ref: string, ...rest: any[]) => {
      if (ref === 'refs/heads/main') throw new Error('synthetic suspension before the refs move');
      return await updateRef(ref, ...rest);
    };
  } else {
    const writeTargets = core.writeTargetFilesFromJournal.bind(core);
    core.writeTargetFilesFromJournal = async (journal: any, entries: any, matched: any, sizes: any, scope: any) => {
      for (const filePath of plan.writeBeforeCrash || []) {
        await writeTargets({ ...journal, affected_paths: [filePath] }, entries, matched, sizes, scope);
      }
      throw new Error('synthetic suspension during the delta apply');
    };
  }
  const cleanState = plan.cleanState ?? true;
  await expect(core.applyTargetMain(target, [], true, [], cleanState, [], [], 41, cleanState, null, value.targetSizes,
    null, false, null, Boolean(plan.rebuild)))
    .rejects.toThrow('synthetic suspension');
}

/** Complete an ordinary apply so its horizon and recovery bundle survive. */
async function completeApply(value: Vault, target: string): Promise<void> {
  await expect(value.core.applyTargetMain(target, [], true, [], true, [], [], 41, true, null, value.targetSizes))
    .resolves.toBe(true);
  expect(await fileBytes(value.journalPath)).toBeNull();
  await rm(value.ackPath, { force: true });
}

type CorruptKind = 'empty' | 'not_json' | 'schema';

function corruptBytes(kind: CorruptKind, authentic: string): string {
  if (kind === 'empty') return '';
  if (kind === 'not_json') return authentic.slice(0, 40);
  const parsed = JSON.parse(authentic);
  return JSON.stringify({ ...parsed, phase: 'bogus', affected_paths: [...parsed.affected_paths, '../escape'] });
}

/** Reproduce the torn-write shape: unreadable journal plus the 0.7.10 latch. */
async function latchAndCorrupt(value: Vault, kind: CorruptKind) {
  const authentic = await readFile(value.journalPath, 'utf8');
  const written = corruptBytes(kind, authentic);
  await value.core.writeState(Object.assign({}, await value.core.readState(), {
    status_label: 'Out of sync — local recovery required',
    last_error_code: 'apply_journal_recovery_required',
    apply_validation_reason: 'recovery_state_corrupt',
    updated_at: new Date().toISOString()
  }));
  await writeFile(value.journalPath, written);
  return { authentic, written, journal: JSON.parse(authentic) };
}

function restart(value: Vault, patch?: (core: any) => void) {
  const client = new ObtsPluginClient(value.root, settings);
  const core = (client as any).client;
  if (patch) patch(core);
  return { client, core };
}

async function quarantineNames(root: string): Promise<string[]> {
  const names = await readdir(join(root, '.obts', 'recovery-corrupt')).catch(() => [] as string[]);
  return names.filter((name) => !name.startsWith('.partial-')).sort();
}

async function quarantineEvidence(root: string) {
  const names = await quarantineNames(root);
  const dir = join(root, '.obts', 'recovery-corrupt', names[0] ?? 'missing');
  return {
    names,
    bytes: await fileBytes(join(dir, 'apply-journal.json')),
    receipt: await readJson(join(dir, 'reason.json'))
  };
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function bundleIds(root: string): Promise<string[]> {
  const names = await readdir(join(root, '.obts', 'recovery')).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith('rec_')).sort();
}

async function queuedBytes(core: any, filePath: string): Promise<string | null> {
  const queue = await core.readQueue();
  if (typeof queue.pending_commit !== 'string') return null;
  const blob = await core.readBlobIfPresent(queue.pending_commit, filePath);
  return blob === null ? null : blob.toString('utf8');
}

async function refExists(value: Vault, filePath: string): Promise<boolean> {
  return (await readFile(join(value.root, filePath), 'utf8').catch(() => null)) !== null;
}

/** A schema-valid journal for the synthetic fixtures the real apply cannot produce. */
function journalFixture(value: Vault, applyId: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(Object.assign({
    journal_version: 7,
    authoring_base: value.base,
    touched_paths: ['note-a.md'],
    target_root_ignore_oid: null,
    local_only_paths: [],
    local_only_presence: {},
    deferred_local_paths: [],
    apply_id: applyId,
    operation_type: 'pull_apply',
    target_main: value.base,
    target_file_sizes: {},
    expected_prior_local_main: value.base,
    expected_prior_local_device_ref: null,
    phase: 'writing_files',
    affected_paths: ['note-a.md'],
    preflight_sha256: { 'note-a.md': sha256(NOTE_A) },
    preflight_fingerprints: { 'note-a.md': { kind: 'file', sha256: sha256(NOTE_A), oid: '0'.repeat(40) } },
    directory_intents: [],
    explicit_directories: [],
    pre_apply_directories: [],
    pre_apply_directory_ctimes: {},
    confirmed_directory_roots: [],
    confirmed_directory_inventory: null,
    preserve_local_changes: true,
    event_seq: 41,
    recovery_bundle_id: null,
    last_completed_step: null,
    redacted_error_category: null
  }, extra), null, 2)}\n`;
}

/**
 * Drives the plugin core over the adapter shape an Obsidian mobile device
 * exposes: no native sync hooks, listing-based directories, byte-array reads
 * and writes. The vault is mirrored from disk first, so the fixture is the
 * same real evidence the desktop cases use.
 */
async function mobileCore(value: Vault, patch?: (core: any) => void) {
  const adapter = new MemoryDataAdapter();
  const seed = createDataAdapterFs(adapter).promises;
  const mirror = async (relative: string) => {
    for (const entry of await readdir(join(value.root, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await seed.mkdir(next, { recursive: true });
        await mirror(next);
      } else {
        await seed.writeFile(next, await readFile(join(value.root, next)));
      }
    }
  };
  await mirror('');
  const plugin = Object.create(value.core.plugin);
  plugin.app = { vault: { adapter, getName: () => 'heal-fixture' } };
  plugin.pathMutationGate = installPathMutationGate(adapter, plugin);
  const core = new ObtsClientCore(plugin);
  if (patch) patch(core);
  return {
    core,
    adapter,
    read: async (filePath: string): Promise<string | null> => core.fsp.readFile(filePath, 'utf8').catch(() => null),
    state: async (): Promise<any> => JSON.parse(await core.fsp.readFile('.obts/state.json', 'utf8').catch(() => 'null')),
    quarantine: async (): Promise<string[]> => (await core.fsp.readdir('.obts/recovery-corrupt').catch(() => [] as string[]))
      .filter((name: string) => !name.startsWith('.partial-')).sort()
  };
}

describe('unreadable apply journal containment and reconstruction', () => {
  it('case 1 resumes from an empty journal with a matching bundle and preserves an edit made after the crash', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET, 'note-new.md': NOTE_NEW_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    await writeFile(join(value.root, 'note-b.md'), EDITED_AFTER_CRASH);
    const { written } = await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(EDITED_AFTER_CRASH);
    expect(JSON.parse(await readFile(value.ackPath, 'utf8'))).toMatchObject({ target_main: target, event_seq: 41 });
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    const evidence = await quarantineEvidence(value.root);
    expect(evidence.names).toHaveLength(1);
    expect(evidence.bytes).toBe(written);
    expect(evidence.receipt).toMatchObject({ reason: 'empty', size: 0, sha256: sha256('') });
    expect(await queuedBytes(core, 'note-b.md')).toBe(EDITED_AFTER_CRASH);
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe(KEEP);
  }, 60_000);

  it('case 2 resumes from truncated JSON and records the not_json class', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-b.md'] });
    const { written } = await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    const evidence = await quarantineEvidence(value.root);
    expect(evidence.bytes).toBe(written);
    expect(evidence.receipt).toMatchObject({ reason: 'not_json', size: written.length, sha256: sha256(written) });
  }, 60_000);

  it('case 3 resumes from a schema-invalid journal and records the schema class', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-a.md'] });
    const { written } = await latchAndCorrupt(value, 'schema');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    const evidence = await quarantineEvidence(value.root);
    expect(evidence.bytes).toBe(written);
    expect(evidence.receipt).toMatchObject({ reason: 'schema', sha256: sha256(written) });
  }, 60_000);

  it('case 4 keeps a completed removal completed and archives its displaced preimage', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'gone.md': 'removed by the server\n', 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET }, ['gone.md']);
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['gone.md'] });
    expect(await fileBytes(join(value.root, 'gone.md'))).toBeNull();
    const { journal } = await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(join(value.root, 'gone.md'))).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    const archived = await fileBytes(join(value.root, '.obts', 'recovery-displaced', journal.apply_id,
      `${encodeURIComponent('gone.md')}.entry`));
    expect(archived).toBe('removed by the server\n');
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 5 finishes a committed tail once the local edit is preserved, without bundle explosion', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'tail' });
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    const committed = JSON.parse(await readFile(value.journalPath, 'utf8'));
    expect(committed.phase).toBe('committed');
    await writeFile(join(value.root, 'keep.md'), 'edited after the tail was interrupted\n');
    await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe('edited after the tail was interrupted\n');
    expect(JSON.parse(await readFile(value.ackPath, 'utf8'))).toMatchObject({ target_main: target, event_seq: 41 });
    expect(await queuedBytes(core, 'keep.md')).toBe('edited after the tail was interrupted\n');
    expect((await core.readQueue()).status).toBe('queued_local');
    expect(await bundleIds(value.root)).toHaveLength(2);
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 6 retires a bundle-less planned journal only when nothing visible moved', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    expect(await bundleIds(value.root)).toHaveLength(0);
    const { journal } = await latchAndCorrupt(value, 'not_json');
    // The suspension unwinds the release path, so restore the marker a real
    // crash leaves behind: it is the durable carrier of the interrupted apply.
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);
    expect(await fileBytes(value.lockPath)).not.toBeNull();

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B);
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe(KEEP);
    expect(core.inventoryRequestedSeq).toBeGreaterThan(core.inventoryCompletedSeq);
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    expect(state.local_main).toBe(value.base);
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 7 stays blocked when a displaced preimage exists but no bundle does', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const applyId = 'apply_ambiguous_fixture';
    await writeFile(value.journalPath, `${JSON.stringify({
      journal_version: 7,
      authoring_base: value.base,
      touched_paths: ['note-a.md'],
      target_root_ignore_oid: null,
      local_only_paths: [],
      local_only_presence: {},
      deferred_local_paths: [],
      apply_id: applyId,
      operation_type: 'pull_apply',
      target_main: value.base,
      target_file_sizes: {},
      expected_prior_local_main: value.base,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['note-a.md'],
      preflight_sha256: { 'note-a.md': sha256(NOTE_A) },
      preflight_fingerprints: { 'note-a.md': { kind: 'file', sha256: sha256(NOTE_A), oid: '0'.repeat(40) } },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: true,
      event_seq: 41,
      recovery_bundle_id: null,
      last_completed_step: null,
      redacted_error_category: null
    })}\n`);
    await mkdir(join(value.root, '.obts', 'apply-displaced', applyId), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', applyId, `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    const { written } = await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
    expect(await fileBytes(join(value.root, '.obts', 'recovery-displaced', applyId, `${encodeURIComponent('note-a.md')}.entry`))).toBeNull();
  }, 60_000);

  it('case 8 blocks when two different qualifying identities own a verified bundle', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const authentic = JSON.parse(await readFile(value.journalPath, 'utf8'));
    // A real interrupted apply leaves one qualifying horizon; a lingering
    // displaced directory claims a second identity, and the lock is torn so it
    // cannot arbitrate. Both identities then own a verified bundle.
    const otherId = 'apply_ambiguous_other';
    await mkdir(join(value.root, '.obts', 'apply-displaced', otherId), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', otherId, `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    await value.core.createRecoveryBundle('pull_apply', target, ['note-a.md'], authentic);
    await value.core.createRecoveryBundle('pull_apply', target, ['note-a.md'],
      { ...authentic, apply_id: otherId });
    expect(await bundleIds(value.root)).toHaveLength(2);
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    const { written } = await latchAndCorrupt(value, 'not_json');

    const carriers = await value.core.discoverApplyJournalCarriers();
    const evidence = await value.core.verifyApplyJournalBundleCandidates(carriers, await value.core.readState());
    expect(carriers.qualifyingApplyIds.size).toBe(2);
    expect(evidence.candidates).toHaveLength(2);
    expect(new Set(evidence.candidates.map((candidate: any) => candidate.applyId)).size).toBe(2);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    expect(await core.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await bundleIds(value.root)).toHaveLength(2);
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 9 quarantines the same corrupt bytes once across restarts', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    await writeFile(value.journalPath, `${JSON.stringify({
      journal_version: 7, apply_id: 'apply_no_bundle_fixture', operation_type: 'pull_apply',
      target_main: value.base, target_file_sizes: {}, expected_prior_local_main: value.base,
      expected_prior_local_device_ref: null, authoring_base: value.base, touched_paths: [],
      target_root_ignore_oid: null, local_only_paths: [], local_only_presence: {}, deferred_local_paths: [],
      phase: 'writing_files', affected_paths: ['note-a.md'],
      preflight_sha256: { 'note-a.md': sha256(NOTE_A) },
      preflight_fingerprints: { 'note-a.md': { kind: 'file', sha256: sha256(NOTE_A), oid: '0'.repeat(40) } },
      directory_intents: [], explicit_directories: [], pre_apply_directories: [],
      pre_apply_directory_ctimes: {}, confirmed_directory_roots: [], confirmed_directory_inventory: null,
      preserve_local_changes: true, event_seq: 41, recovery_bundle_id: null,
      last_completed_step: null, redacted_error_category: null
    })}\n`);
    await mkdir(join(value.root, '.obts', 'apply-displaced', 'apply_other_fixture'), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', 'apply_other_fixture', 'note-a.md.entry'), NOTE_A);
    const { written } = await latchAndCorrupt(value, 'not_json');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { core } = restart(value);
      await core.initialize();
      expect(await fileBytes(value.journalPath)).toBe(written);
    }

    const evidence = await quarantineEvidence(value.root);
    expect(evidence.names).toHaveLength(1);
    expect(evidence.bytes).toBe(written);
    expect(evidence.receipt).toMatchObject({ reason: 'not_json', sha256: sha256(written) });
  }, 60_000);

  it('case 10 refuses a reconstruction whose locked identity has no verified bundle', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    const authentic = JSON.parse(await readFile(value.journalPath, 'utf8'));
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: 'apply_foreign_lock', created_at: new Date().toISOString() }, null, 2)}`);
    const { written } = await latchAndCorrupt(value, 'empty');
    expect(authentic.recovery_bundle_id).toMatch(/^rec_/u);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B);
    expect(await fileBytes(value.lockPath)).not.toBeNull();
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
    expect(await core.resolveRef('refs/heads/main')).toBe(value.base);
    expect(await core.resolveRef('refs/heads/local')).toBe(value.base);
    expect(await readdir(join(value.root, '.obts', 'recovery', authentic.recovery_bundle_id))).toContain('journal');
  }, 60_000);

  it('case 11 keeps the latch and the active journal when the quarantine barrier fails', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-b.md'] });
    const { written } = await latchAndCorrupt(value, 'not_json');

    const failing = restart(value, (core) => {
      const syncFile = core.fsp.syncFile.bind(core.fsp);
      core.fsp.syncFile = async (filePath: string) => {
        if (filePath.includes('recovery-corrupt')) throw new Error('synthetic barrier failure');
        return await syncFile(filePath);
      };
    });
    await failing.core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await failing.core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect(await quarantineNames(value.root)).toHaveLength(0);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 12 leaves a readable journal on the ordinary recovery path with no quarantine', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await quarantineNames(value.root)).toHaveLength(0);
    expect(await core.readState()).toMatchObject({ last_error_code: null });
  }, 60_000);

  it('case 13 admits a new apply after a successful heal', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.initialize();
    await expect(core.admitApplyRecovery()).resolves.toBeUndefined();
    await core.fsp.rm(core.pendingAppliedAckPath, { force: true });

    await writeFile(join(value.root, 'note-later.md'), 'a later delta\n');
    const later = await core.createLocalCommit('later server target');
    await expect(core.applyTargetMain(later, [], true, [], true, [], [], 42, true, null, { 'note-later.md': Buffer.byteLength('a later delta\n') })).resolves.toBe(true);
    expect(await fileBytes(join(value.root, 'note-later.md'))).toBe('a later delta\n');
    expect(await core.readState()).toMatchObject({ local_main: later, last_error_code: null });
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 60_000);

  it('case 14 heals a torn journal on the first startup without losing local bytes', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, {
      'note-a.md': NOTE_A_TARGET,
      'note-b.md': NOTE_B_TARGET,
      'note-new.md': NOTE_NEW_TARGET
    });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md', 'note-a.md'] });
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B);
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    expect(journal.phase).toBe('writing_files');
    expect(await bundleIds(value.root)).toHaveLength(1);
    expect(await readdir(join(value.root, '.obts', 'apply-displaced', journal.apply_id)))
      .toEqual(['note-a.md.entry']);
    expect(await value.core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe(KEEP);
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(JSON.parse(await readFile(value.ackPath, 'utf8'))).toMatchObject({ target_main: target });
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.status_label).not.toBe('Out of sync — local recovery required');
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    expect((await core.readQueue()).changed_paths).toEqual([]);
  }, 60_000);

  it('case 15 preserves a path the user edited after the crash and never overwrites it', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, {
      'note-a.md': NOTE_A_TARGET,
      'note-b.md': NOTE_B_TARGET,
      'note-new.md': NOTE_NEW_TARGET
    });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md', 'note-a.md'] });
    await writeFile(join(value.root, 'note-b.md'), EDITED_AFTER_CRASH);
    await latchAndCorrupt(value, 'schema');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(EDITED_AFTER_CRASH);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await queuedBytes(core, 'note-b.md')).toBe(EDITED_AFTER_CRASH);
    expect((await core.readQueue()).status).toBe('queued_local');
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await core.readState()).toMatchObject({ status_label: 'Ahead', last_error_code: null });
  }, 60_000);

  it('case 16 lets the explicit rebuild proceed past an unreadable journal after quarantining it', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    await writeFile(value.journalPath, `${JSON.stringify({
      journal_version: 7, apply_id: 'apply_rebuild_escape_fixture', operation_type: 'pull_apply',
      target_main: value.base, target_file_sizes: {}, expected_prior_local_main: value.base,
      expected_prior_local_device_ref: null, authoring_base: value.base, touched_paths: [],
      target_root_ignore_oid: null, local_only_paths: [], local_only_presence: {}, deferred_local_paths: [],
      phase: 'writing_files', affected_paths: ['note-a.md'],
      preflight_sha256: { 'note-a.md': sha256(NOTE_A) },
      preflight_fingerprints: { 'note-a.md': { kind: 'file', sha256: sha256(NOTE_A), oid: '0'.repeat(40) } },
      directory_intents: [], explicit_directories: [], pre_apply_directories: [],
      pre_apply_directory_ctimes: {}, confirmed_directory_roots: [], confirmed_directory_inventory: null,
      preserve_local_changes: true, event_seq: 41, recovery_bundle_id: null,
      last_completed_step: null, redacted_error_category: null
    })}\n`);
    await mkdir(join(value.root, '.obts', 'apply-displaced', 'apply_rebuild_escape_fixture'), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', 'apply_rebuild_escape_fixture',
      `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: 'apply_rebuild_escape_fixture', created_at: new Date().toISOString() }, null, 2)}`);
    const { written } = await latchAndCorrupt(value, 'empty');

    const blocked = restart(value);
    await blocked.core.initialize();
    expect(await blocked.core.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });

    const { core } = restart(value, (patch) => {
      patch.readDeviceToken = async () => 'synthetic-device-token';
      patch.pull = async () => {
        throw new Error('synthetic network failure after journal admission');
      };
    });
    await expect(core.rebuildFromServerMain()).rejects.toThrow('synthetic network failure after journal admission');

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    expect(await fileBytes(join(value.root, '.obts', 'apply-displaced', 'apply_rebuild_escape_fixture',
      `${encodeURIComponent('note-a.md')}.entry`))).toBeNull();
    expect(await fileBytes(join(value.root, '.obts', 'recovery-displaced', 'apply_rebuild_escape_fixture',
      `${encodeURIComponent('note-a.md')}.entry`))).toBe(NOTE_A);
  }, 60_000);

  it('case 17 lets the explicit reset proceed past an unreadable journal after quarantining it', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    await writeFile(value.journalPath, `${JSON.stringify({
      journal_version: 7, apply_id: 'apply_reset_escape_fixture', operation_type: 'pull_apply',
      target_main: value.base, target_file_sizes: {}, expected_prior_local_main: value.base,
      expected_prior_local_device_ref: null, authoring_base: value.base, touched_paths: [],
      target_root_ignore_oid: null, local_only_paths: [], local_only_presence: {}, deferred_local_paths: [],
      phase: 'writing_files', affected_paths: ['note-a.md'],
      preflight_sha256: { 'note-a.md': sha256(NOTE_A) },
      preflight_fingerprints: { 'note-a.md': { kind: 'file', sha256: sha256(NOTE_A), oid: '0'.repeat(40) } },
      directory_intents: [], explicit_directories: [], pre_apply_directories: [],
      pre_apply_directory_ctimes: {}, confirmed_directory_roots: [], confirmed_directory_inventory: null,
      preserve_local_changes: true, event_seq: 41, recovery_bundle_id: null,
      last_completed_step: null, redacted_error_category: null
    })}\n`);
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: 'apply_reset_escape_fixture', created_at: new Date().toISOString() }, null, 2)}`);
    const { written } = await latchAndCorrupt(value, 'not_json');
    expect(await refExists(value, '.obts/apply-journal.json')).toBe(true);

    const { core } = restart(value);
    const result = await core.resetLocalPairingState();

    expect(result.status).toBe('Not paired');
    expect(typeof result.recoveryBundleId).toBe('string');
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
  }, 60_000);

  it('case 18 never replays the lingering horizon of a settled apply and keeps a torn lock blocked', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const settledTarget = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await completeApply(value, settledTarget);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    const provenance = await readJson(join(value.root, '.obts', 'stale-provenance.json'));
    expect(provenance.horizons).toHaveLength(1);
    const settled = provenance.horizons[0];
    expect(settled.base).toBe(value.base);

    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_SECOND_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    // The lock tears in the same no-fsync window as the journal, so the only
    // identity left on disk belongs to the settled apply.
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    await writeFile(join(value.root, 'note-a.md'), NOTE_A);
    const { written } = await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    // Nothing is replayed: the settled bundle's target is already the local
    // main, so it is not a carrier of this window. With no readable lock the
    // window can never be proven empty either, so the bytes stay blocked.
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B);
    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await fileBytes(value.ackPath)).toBeNull();
    const state = await core.readState();
    expect(state).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt',
      local_main: settledTarget
    });
    expect(await bundleIds(value.root)).toHaveLength(1);
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 60_000);

  it('case 19 reconstructs an interrupted rebuild from its own rebuild bundle', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-a.md'], rebuild: true });
    const bundleId = (await bundleIds(value.root))[0] as string;
    expect((await readJson(join(value.root, '.obts', 'recovery', bundleId, 'manifest.json'))).operation_type)
      .toBe('rebuild_from_server');
    await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await core.readState()).toMatchObject({ last_error_code: null });
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 20 resumes a readable interrupted rebuild that published a legacy pull_apply manifest', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    // 0.7.10 published every bundle with the literal pull_apply operation type,
    // so a readable rebuild journal already fails the identity check on upgrade.
    const finalize = value.core.finalizeRecoveryBundle.bind(value.core);
    value.core.finalizeRecoveryBundle = async (staged: any, _operation: string, ...rest: any[]) =>
      await finalize(staged, 'pull_apply', ...rest);
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-b.md'], rebuild: true });
    const bundleId = (await bundleIds(value.root))[0] as string;
    expect((await readJson(join(value.root, '.obts', 'recovery', bundleId, 'manifest.json'))).operation_type)
      .toBe('pull_apply');
    expect((await readJson(join(value.root, '.obts', 'recovery', bundleId, 'journal', 'apply-journal.json')))
      .operation_type).toBe('rebuild_from_server');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
  }, 60_000);

  it('case 21 retires a planned-phase tear even when an unrelated bundle exists', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const settledTarget = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await completeApply(value, settledTarget);
    const [historic] = await bundleIds(value.root);
    expect(historic).toMatch(/^rec_/u);
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_SECOND_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    // A replay of the settled bundle would settle an acknowledgement; retiring
    // the interrupted journal must not.
    expect(await fileBytes(value.ackPath)).toBeNull();
    expect(await bundleIds(value.root)).toEqual([historic]);
    expect(core.inventoryRequestedSeq).toBeGreaterThan(core.inventoryCompletedSeq);
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 60_000);

  it('case 22 blocks when the bundle naming the interrupted apply cannot be verified', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, {
      'note-a.md': NOTE_A_TARGET,
      'note-b.md': NOTE_B_TARGET,
      'note-new.md': NOTE_NEW_TARGET
    });
    // A create-only delta leaves no displaced pre-image, so the no-mutation
    // proof would otherwise accept a bundle that failed verification.
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    const bundleId = (await bundleIds(value.root))[0] as string;
    expect(await fileBytes(join(value.root, '.obts', 'apply-displaced', JSON.parse(
      await readFile(value.journalPath, 'utf8')).apply_id, `${encodeURIComponent('note-new.md')}.entry`))).toBeNull();
    const packPath = join(value.root, '.obts', 'recovery', bundleId, 'git', 'local-refs.pack');
    await writeFile(packPath, `${await readFile(packPath, 'utf8')}torn\n`);
    const { written } = await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B);
    expect(await readdir(join(value.root, '.obts', 'recovery', bundleId))).toContain('manifest.json');
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 23 refuses the no-mutation proof when the pending acknowledgement is unreadable', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    await writeFile(value.ackPath, '{"target_main": ');
    const { written } = await latchAndCorrupt(value, 'not_json');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await core.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 24 heals on the next start after a kill between journal removal and the latch write', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const interrupted = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: interrupted.journal.apply_id, created_at: new Date().toISOString() })}`);

    const killed = restart(value, (core) => {
      core.clearApplyJournalLatch = async () => { throw new Error('synthetic kill before the latch write'); };
    });
    await expect(killed.core.initialize()).rejects.toThrow('synthetic kill before the latch write');
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await killed.core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
  }, 60_000);

  it('case 25 lets the explicit rebuild drop an unparseable apply lock after quarantining', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    await writeFile(value.journalPath, journalFixture(value, 'apply_escape_torn_lock'));
    await mkdir(join(value.root, '.obts', 'apply-displaced', 'apply_escape_torn_lock'), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', 'apply_escape_torn_lock',
      `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    await writeFile(value.lockPath, '{"apply_id": "apply_escape_torn_lock');
    const { written } = await latchAndCorrupt(value, 'empty');

    const blocked = restart(value);
    await blocked.core.initialize();
    expect(await blocked.core.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await fileBytes(value.lockPath)).not.toBeNull();

    const { core } = restart(value, (patch) => {
      patch.readDeviceToken = async () => 'synthetic-device-token';
      patch.pull = async () => { throw new Error('synthetic network failure after journal admission'); };
    });
    await expect(core.rebuildFromServerMain()).rejects.toThrow('synthetic network failure after journal admission');

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    await expect(core.acquireApplyLock('apply_after_escape')).resolves.toBeUndefined();
  }, 60_000);

  it('case 26 never reuses a quarantine copy whose bytes do not match', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);
    const staleName = `20240101T000000000Z_${sha256(written).slice(0, 8)}`;
    const staleDir = join(value.root, '.obts', 'recovery-corrupt', staleName);
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, 'apply-journal.json'), written.slice(0, 12));
    await writeFile(join(staleDir, 'reason.json'), '{"version": 1}\n');

    const { core } = restart(value);
    await core.initialize();

    const names = await quarantineNames(value.root);
    expect(names).toHaveLength(2);
    expect(names).toContain(staleName);
    const fresh = names.find((name) => name !== staleName) as string;
    expect(await fileBytes(join(value.root, '.obts', 'recovery-corrupt', fresh, 'apply-journal.json'))).toBe(written);
    expect(await fileBytes(join(staleDir, 'apply-journal.json'))).toBe(written.slice(0, 12));
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 60_000);

  it('case 27 copies surviving journal siblings byte-exactly and sweeps stale partial staging', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);
    const tmpSibling = 'apply-journal.json.tmp-fixture01';
    const backupSibling = 'apply-journal.json.obts-replace-backup-fixture02';
    await writeFile(join(value.root, '.obts', tmpSibling), '{"phase": "writ');
    await writeFile(join(value.root, '.obts', backupSibling), '{"phase": ');
    const staleName = '.partial-20240101T000000000Z_deadbeef';
    await mkdir(join(value.root, '.obts', 'recovery-corrupt', staleName), { recursive: true });
    await writeFile(join(value.root, '.obts', 'recovery-corrupt', staleName, 'apply-journal.json'), 'stale');

    const { core } = restart(value, (patch) => {
      // The startup replacement sweep would consume the backup sibling before
      // the heal runs, so pin the on-disk state the quarantine must handle.
      patch.recoverInterruptedReplacements = async () => undefined;
    });
    await core.initialize();

    const names = await quarantineNames(value.root);
    expect(names).toHaveLength(1);
    const quarantined = join(value.root, '.obts', 'recovery-corrupt', names[0] as string);
    expect(await fileBytes(join(quarantined, 'apply-journal.json'))).toBe(written);
    expect(await fileBytes(join(quarantined, tmpSibling))).toBe('{"phase": "writ');
    expect(await fileBytes(join(quarantined, backupSibling))).toBe('{"phase": ');
    expect(await readdir(join(value.root, '.obts', 'recovery-corrupt'))).not.toContain(staleName);
    expect(await fileBytes(join(value.root, '.obts', tmpSibling))).toBe('{"phase": "writ');
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 60_000);

  it('case 28 records an over-budget journal sibling as skipped instead of reading it', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);
    const bigSibling = 'apply-journal.json.tmp-big0001';
    await writeFile(join(value.root, '.obts', bigSibling), 'x'.repeat(8192));

    const { core } = restart(value, (patch) => { patch.fileBufferBudgetBytes = 4096; });
    await core.initialize();

    const evidence = await quarantineEvidence(value.root);
    expect(evidence.names).toHaveLength(1);
    expect(evidence.receipt).toMatchObject({ reason: 'not_json', skipped: [bigSibling] });
    expect(await fileBytes(join(value.root, '.obts', 'recovery-corrupt', evidence.names[0] as string, bigSibling))).toBeNull();
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 60_000);

  it('case 29 clears the recorded validation reason when the replacement apply succeeds', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    await writeFile(value.journalPath, journalFixture(value, 'apply_escape_reason'));
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: 'apply_escape_reason', created_at: new Date().toISOString() })}`);
    await mkdir(join(value.root, '.obts', 'apply-displaced', 'apply_escape_reason'), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', 'apply_escape_reason', `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    await latchAndCorrupt(value, 'empty');

    const blocked = restart(value);
    await blocked.core.initialize();
    expect(await blocked.core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });

    const { core } = restart(value);
    await core.removeUnreadableApplyJournalAfterQuarantine();
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await expect(core.applyTargetMain(target, [], true, [], true, [], [], 41, true, null, value.targetSizes,
      null, false, null, true)).resolves.toBe(true);

    const state = await core.readState();
    expect(state.local_main).toBe(target);
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
  }, 60_000);

  it('case 33 blocks an over-budget journal without quarantining it', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    await writeFile(value.journalPath, journalFixture(value, 'apply_oversized_torn'));
    const { written } = await latchAndCorrupt(value, 'not_json');
    const oversized = written.padEnd(4096, ' ');
    await writeFile(value.journalPath, oversized);
    const { core } = restart(value, (patch) => { patch.fileBufferBudgetBytes = 128; });
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(oversized);
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect(await quarantineNames(value.root)).toHaveLength(0);
  }, 60_000);

  it('case 34 reconstructs an interrupted rebuild that published a legacy pull_apply manifest', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    const finalize = value.core.finalizeRecoveryBundle.bind(value.core);
    value.core.finalizeRecoveryBundle = async (staged: any, _operation: string, ...rest: any[]) =>
      await finalize(staged, 'pull_apply', ...rest);
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-a.md'], rebuild: true });
    const bundleId = (await bundleIds(value.root))[0] as string;
    expect((await readJson(join(value.root, '.obts', 'recovery', bundleId, 'manifest.json'))).operation_type)
      .toBe('pull_apply');
    await latchAndCorrupt(value, 'schema');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await core.readState()).toMatchObject({ last_error_code: null });
    expect((await quarantineEvidence(value.root)).names).toHaveLength(1);
  }, 60_000);

  it('case 35 heals a torn apply whose vault kept local head ahead of main', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    // A committed local proposal sits on the applied main: the working tree is
    // clean but local head stays ahead of local main for the whole apply.
    const proposalBytes = 'keep edited in the pending proposal\n';
    await writeFile(join(value.root, 'keep.md'), proposalBytes);
    const proposal = await value.core.createLocalCommit('obts: local proposal pending upload');
    expect(proposal).toMatch(/^[0-9a-f]{40}$/u);
    await value.core.writeQueue({
      pending_commit: proposal,
      expected_device_ref: value.base,
      status: 'queued_local',
      attempts: 0,
      change_seq: (await value.core.readQueue()).change_seq,
      changed_paths: [],
      updated_at: new Date().toISOString()
    });
    await value.core.writeState(Object.assign({}, await value.core.readState(), {
      local_head: proposal,
      status_label: 'Ahead'
    }));
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-a.md'] });
    const torn = await value.core.readState();
    expect(torn.local_head).toBe(proposal);
    expect(torn.local_main).toBe(value.base);
    const bundleId = (await bundleIds(value.root))[0] as string;
    // The lock tears in the same no-fsync window as the journal, so the horizon
    // and the displaced pre-image written before the writes are the identities
    // left behind.
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    const { written } = await latchAndCorrupt(value, 'not_json');

    expect(await fileBytes(value.lockPath)).not.toBeNull();

    const { core } = restart(value);
    await core.initialize();

    // The horizon of the interrupted apply still names the current main, so it
    // selects the verified bundle even though local head never caught up, and
    // the marker it leaves behind is the tear's own identity-less lock, not
    // another operation's: the resume finishes instead of dead-ending there.
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe(proposalBytes);
    const state = await core.readState();
    expect(state.local_main).toBe(target);
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    expect((await core.readQueue()).pending_commit).toBe(proposal);
  }, 90_000);

  it('case 41 resumes a tear in a vault whose local head is ahead through the horizon', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const proposalBytes = 'keep edited in the pending proposal\n';
    await writeFile(join(value.root, 'keep.md'), proposalBytes);
    const proposal = await value.core.createLocalCommit('obts: local proposal pending upload');
    await value.core.writeQueue({
      pending_commit: proposal,
      expected_device_ref: value.base,
      status: 'queued_local',
      attempts: 0,
      change_seq: (await value.core.readQueue()).change_seq,
      changed_paths: [],
      updated_at: new Date().toISOString()
    });
    await value.core.writeState(Object.assign({}, await value.core.readState(), {
      local_head: proposal,
      status_label: 'Ahead'
    }));
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    const { journal } = await (async () => {
      await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-a.md'] });
      const authentic = JSON.parse(await readFile(value.journalPath, 'utf8'));
      // A real crash leaves the lock that was written before the journal.
      await writeFile(value.lockPath, `${JSON.stringify({ apply_id: authentic.apply_id, created_at: new Date().toISOString() })}`);
      return await latchAndCorrupt(value, 'not_json');
    })();
    const torn = await value.core.readState();
    expect(torn.local_head).toBe(proposal);
    expect(torn.local_main).toBe(value.base);
    expect(journal.apply_id).toMatch(/^apply_/u);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await fileBytes(join(value.root, 'keep.md'))).toBe(proposalBytes);
    const state = await core.readState();
    expect(state.local_main).toBe(target);
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    expect(await core.readBlobIfPresent(proposal, 'keep.md')).toBeInstanceOf(Buffer);
  }, 60_000);

  it('case 36 retires a planned tear even when a settled tail bundle records the current main', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const firstTarget = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    // An ordinary pull apply that preserves nothing itself; its committed tail is
    // interrupted before the tail capture, which is where a killed app stops.
    await writeFile(join(value.root, 'keep.md'), EDITED_AFTER_CRASH);
    await applyUntilSuspension(value, firstTarget, { crashIn: 'tail-refresh', cleanState: false });
    expect(JSON.parse(await readFile(value.journalPath, 'utf8')).phase).toBe('committed');
    await rm(value.lockPath, { force: true });
    const resumed = restart(value);
    await resumed.core.initialize();
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect((await resumed.core.readState()).local_main).toBe(firstTarget);
    // The tail publishes its preserved-changes bundle after the state already
    // records the applied main, so that bundle's prior main is the current main
    // for every later heal in this vault.
    const manifests = await Promise.all((await bundleIds(value.root)).map(async (bundleId) =>
      await readJson(join(value.root, '.obts', 'recovery', bundleId, 'manifest.json'))));
    const settled = manifests.filter((manifest) => manifest.prior_local_main === firstTarget);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.some((manifest) => manifest.affected_paths.includes('keep.md'))).toBe(true);
    for (const manifest of settled) expect(manifest.prior_local_main).toBe((await resumed.core.readState()).local_main);
    await rm(value.ackPath, { force: true });

    const secondTarget = await prepareTarget(value, { 'note-a.md': NOTE_A_SECOND_TARGET });
    await applyUntilSuspension(value, secondTarget, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    // A real crash in the planned phase leaves the lock that was written before
    // the journal, so the interrupted identity is readable.
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await bundleIds(value.root)).toHaveLength(manifests.length);
    expect(core.inventoryRequestedSeq).toBeGreaterThan(core.inventoryCompletedSeq);
    const state = await core.readState();
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    expect(state.local_main).toBe(firstTarget);
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 90_000);

  it('case 37 never selects the settled rebuild whose target is its own base', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    // A rebuild whose target is the current main still runs for its affected
    // path, so its horizon base and its bundle target both equal the main.
    await expect(value.core.applyTargetMain(value.base, [], true, ['note-a.md'], false, [], [], 41, false, null,
      {}, null, false, null, true)).resolves.toBe(true);
    expect(await fileBytes(value.journalPath)).toBeNull();
    const manifests = await Promise.all((await bundleIds(value.root)).map(async (bundleId) =>
      await readJson(join(value.root, '.obts', 'recovery', bundleId, 'manifest.json'))));
    expect(manifests.some((manifest) => manifest.target_main === value.base)).toBe(true);
    await rm(value.ackPath, { force: true });
    const settledHorizons = (await readJson(join(value.root, '.obts', 'stale-provenance.json'))).horizons;
    expect(settledHorizons.length).toBeGreaterThan(0);
    expect(settledHorizons.every((horizon: any) => horizon.base === value.base)).toBe(true);

    const localBytes = 'alpha edited locally after the settled rebuild\n';
    await writeFile(join(value.root, 'note-a.md'), localBytes);
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_SECOND_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    expect(journal.apply_id).not.toBe(settledHorizons[0].apply_id);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(localBytes);
    expect(await fileBytes(value.ackPath)).toBeNull();
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt',
      local_main: value.base
    });
  }, 90_000);

  it('case 38 keeps a torn lock with no carrier and no bundle blocked instead of retiring', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    await writeFile(value.journalPath, journalFixture(value, 'apply_torn_lock_only'));
    const { written, journal } = await latchAndCorrupt(value, 'empty');
    expect(await bundleIds(value.root)).toHaveLength(0);
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await readdir(join(value.root, '.obts', 'apply-displaced')).catch(() => [])).toHaveLength(0);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt',
      local_main: value.base
    });
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await bundleIds(value.root)).toHaveLength(0);
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
    await expect(core.acquireApplyLock(journal.apply_id)).resolves.toBeUndefined();
  }, 60_000);

  it('case 39 archives the pre-image the explicit escape abandons so a later tear still retires', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const escaped = 'apply_escape_archive_fixture';
    await writeFile(value.journalPath, journalFixture(value, escaped));
    await mkdir(join(value.root, '.obts', 'apply-displaced', escaped), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', escaped, `${encodeURIComponent('note-a.md')}.entry`), NOTE_A);
    await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.removeUnreadableApplyJournalAfterQuarantine();

    expect(await fileBytes(join(value.root, '.obts', 'apply-displaced', escaped,
      `${encodeURIComponent('note-a.md')}.entry`))).toBeNull();
    expect(await fileBytes(join(value.root, '.obts', 'recovery-displaced', escaped,
      `${encodeURIComponent('note-a.md')}.entry`))).toBe(NOTE_A);

    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);

    const { core: second } = restart(value);
    await second.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    const state = await second.readState();
    expect(state.last_error_code).toBeNull();
    expect((await quarantineNames(value.root)).length).toBeGreaterThanOrEqual(2);
    expect((await quarantineEvidence(value.root)).bytes).toBeDefined();
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    expect(written.length).toBeGreaterThan(0);
  }, 90_000);

  it('case 42 reuses an existing quarantine copy whose name carries a collision counter', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);
    const countered = `20240101T000000000Z_${sha256(written).slice(0, 8)}-2`;
    const counteredDir = join(value.root, '.obts', 'recovery-corrupt', countered);
    await mkdir(counteredDir, { recursive: true });
    await writeFile(join(counteredDir, 'apply-journal.json'), written);
    await writeFile(join(counteredDir, 'reason.json'), '{"version": 1}\n');

    const { core } = restart(value);
    await core.initialize();

    expect(await quarantineNames(value.root)).toEqual([countered]);
    expect(await fileBytes(join(counteredDir, 'apply-journal.json'))).toBe(written);
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 60_000);

  it('case 43 sources a reconstruction from the pre-write bundle, never from a later bundle of the same window', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    const editedWhileApplying = 'alpha rewritten locally while the rebuild was running\n';
    // The rebuilt path reaches target bytes, then a local edit lands before the
    // tail capture, so the rebuild preserves exactly the path it affected.
    await applyUntilSuspension(value, target, {
      crashIn: 'refs',
      localEditAfterWrites: { 'note-a.md': editedWhileApplying },
      rebuild: true
    });
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(editedWhileApplying);

    const bundleAt = (bundleId: string, ...rest: string[]) => join(value.root, '.obts', 'recovery', bundleId, ...rest);
    const ids = await bundleIds(value.root);
    expect(ids).toHaveLength(2);
    const primaryId = ids[0] as string;
    const tailId = ids[1] as string;
    // The heal scans newest first, so the tail is exactly what it meets first.
    expect(primaryId < tailId).toBe(true);
    const primaryManifest = await readJson(bundleAt(primaryId, 'manifest.json'));
    const tailManifest = await readJson(bundleAt(tailId, 'manifest.json'));
    expect(primaryManifest.apply_id).toBe(tailManifest.apply_id);
    expect(primaryManifest.affected_paths).toEqual(['note-a.md']);
    expect(tailManifest.affected_paths).toEqual(['note-a.md']);
    expect((await readJson(bundleAt(primaryId, 'journal', 'apply-journal.json'))).recovery_bundle_id).toBeNull();
    expect((await readJson(bundleAt(tailId, 'journal', 'apply-journal.json'))).recovery_bundle_id).toBe(primaryId);
    // Only the pre-write bundle holds the pre-images; the tail holds post-apply bytes.
    expect(await fileBytes(bundleAt(primaryId, 'files', 'note-a.md'))).toBe(NOTE_A);
    expect(await fileBytes(bundleAt(tailId, 'files', 'note-a.md'))).toBe(editedWhileApplying);

    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    expect(journal.apply_id).toBe(primaryManifest.apply_id);
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}\n`);

    let reconstructed: any = null;
    const { core } = restart(value, (patch) => {
      const writeTargets = patch.writeTargetFilesFromJournal.bind(patch);
      patch.writeTargetFilesFromJournal = async (...args: any[]) => {
        reconstructed = await readJson(value.journalPath);
        return await writeTargets(...args);
      };
    });
    await core.initialize();

    expect(reconstructed).toMatchObject({
      phase: 'writing_files',
      last_completed_step: null,
      recovery_bundle_id: primaryId,
      target_main: target
    });
    // The named bundle still holds the bytes the interrupted write replaced.
    expect(sha256(await fileBytes(bundleAt(reconstructed.recovery_bundle_id, 'files', 'note-a.md')) as string))
      .toBe(reconstructed.preflight_fingerprints['note-a.md'].sha256);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(editedWhileApplying);
    expect(await queuedBytes(core, 'note-a.md')).toBe(editedWhileApplying);
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await core.readState()).toMatchObject({
      local_main: target,
      last_error_code: null,
      apply_validation_reason: null
    });
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 120_000);

  it('case 40 never treats an unreadable lock as an unparseable one', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    const applyId = 'apply_read_error_fixture';
    const marker = `${JSON.stringify({ apply_id: applyId, created_at: new Date().toISOString() })}\n`;

    await writeFile(value.lockPath, marker);
    const { core } = restart(value);
    core.fsp.readFile = async () => { throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' }); };
    await expect(core.dropApplyLockWithoutIdentity()).resolves.toBe(false);
    expect(await fileBytes(value.lockPath)).toBe(marker);

    await writeFile(value.lockPath, marker);
    const { core: flaky } = restart(value);
    const lstat = flaky.fsp.lstat.bind(flaky.fsp);
    let calls = 0;
    flaky.fsp.lstat = async (filePath: string, ...rest: any[]) => {
      if (`${filePath}`.includes('apply.lock') && calls++ === 0) throw Object.assign(new Error('synthetic stat failure'), { code: 'EIO' });
      return await lstat(filePath, ...rest);
    };
    await expect(flaky.dropApplyLockWithoutIdentity()).resolves.toBe(false);
    expect(await fileBytes(value.lockPath)).toBe(marker);

    await writeFile(value.lockPath, `{"apply_id": "${applyId}"`);
    const { core: unparseable } = restart(value);
    await expect(unparseable.dropApplyLockWithoutIdentity()).resolves.toBe(true);
    expect(await fileBytes(value.lockPath)).toBeNull();
  }, 60_000);

  it('case 44 heals a torn journal through a torn lock instead of dead-ending in apply_lock_active', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, {
      'note-a.md': NOTE_A_TARGET,
      'note-b.md': NOTE_B_TARGET,
      'note-new.md': NOTE_NEW_TARGET
    });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md', 'note-a.md'] });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    // The lock tears in the same no-fsync window as the journal.
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    expect(await readdir(join(value.root, '.obts', 'apply-displaced', journal.apply_id))).toEqual(['note-a.md.entry']);
    expect(await value.core.readState()).toMatchObject({ local_main: value.base });

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A_TARGET);
    expect(await fileBytes(join(value.root, 'note-b.md'))).toBe(NOTE_B_TARGET);
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    const state = await core.readState();
    expect(state.local_main).toBe(target);
    expect(state.last_error_code).toBeNull();
    expect(state.apply_validation_reason ?? null).toBeNull();
    expect((await core.readQueue()).changed_paths).toEqual([]);
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 120_000);

  it('case 45 lets the explicit rebuild clear an identity-less lock whose journal is gone', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    const torn = '{"apply_id": "apply_orphan_torn';
    await writeFile(value.lockPath, torn);
    expect(await fileBytes(value.journalPath)).toBeNull();

    const { core } = restart(value, (patch) => {
      patch.readDeviceToken = async () => 'synthetic-device-token';
      patch.pull = async () => { throw new Error('synthetic network failure after journal admission'); };
    });
    await expect(core.rebuildFromServerMain()).rejects.toThrow('synthetic network failure after journal admission');

    expect(await fileBytes(value.lockPath)).toBeNull();
    await expect(core.acquireApplyLock('apply_after_orphan_torn')).resolves.toBeUndefined();
    expect(await fileBytes(value.journalPath)).toBeNull();
  }, 90_000);

  it('case 46 reconstructs and resumes when the horizon is the only carrier left', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-new.md': NOTE_NEW_TARGET });
    // The apply only ever adds a file, so no displaced pre-image exists and the
    // torn lock identifies nothing: the horizon is the whole carrier set.
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md'] });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, '{"apply_id": "apply_torn_lock');
    expect(await readdir(join(value.root, '.obts', 'apply-displaced')).catch(() => [])).toHaveLength(0);
    const saved = await readJson(join(value.root, '.obts', 'stale-provenance.json'));
    expect(saved.horizons.filter((horizon: any) => horizon.apply_id === journal.apply_id))
      .toEqual([expect.objectContaining({ base: value.base })]);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect(await fileBytes(join(value.root, 'note-new.md'))).toBe(NOTE_NEW_TARGET);
    expect(await fileBytes(join(value.root, 'note-a.md'))).toBe(NOTE_A);
    const state = await core.readState();
    expect(state.local_main).toBe(target);
    expect(state.last_error_code).toBeNull();
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 120_000);

  it('case 47 archives an abandoned pre-image beside an unrelated same-identity archive so a later tear retires', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const escaped = 'apply_escape_archive_collision';
    const entry = `${encodeURIComponent('note-a.md')}.entry`;
    const earlier = 'pre-image archived by an earlier operation\n';
    await writeFile(value.journalPath, journalFixture(value, escaped));
    await mkdir(join(value.root, '.obts', 'apply-displaced', escaped), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', escaped, entry), NOTE_A);
    await mkdir(join(value.root, '.obts', 'recovery-displaced', escaped), { recursive: true });
    await writeFile(join(value.root, '.obts', 'recovery-displaced', escaped, entry), earlier);
    await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.removeUnreadableApplyJournalAfterQuarantine();

    expect(await fileBytes(join(value.root, '.obts', 'apply-displaced', escaped, entry))).toBeNull();
    expect(await fileBytes(join(value.root, '.obts', 'recovery-displaced', escaped, entry))).toBe(earlier);
    const archived = (await readdir(join(value.root, '.obts', 'recovery-displaced')))
      .filter((name) => name === escaped || name.startsWith(`${escaped}.`)).sort();
    expect(archived).toHaveLength(2);
    const sibling = archived.find((name) => name !== escaped) as string;
    expect(sibling).toMatch(new RegExp(`^${escaped}\\.[0-9]{8}T[0-9]{6}Z`, 'u'));
    expect(await fileBytes(join(value.root, '.obts', 'recovery-displaced', sibling, entry))).toBe(NOTE_A);

    // The leftover pre-image can no longer veto the next tear's proof.
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);

    const { core: second } = restart(value);
    await second.initialize();

    expect(await fileBytes(value.journalPath)).toBeNull();
    expect(await fileBytes(value.lockPath)).toBeNull();
    expect((await second.readState()).last_error_code).toBeNull();
  }, 120_000);

  it('case 48 blocks with a named code when the abandoned pre-image cannot be archived', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    const escaped = 'apply_escape_archive_error';
    const entry = `${encodeURIComponent('note-a.md')}.entry`;
    await writeFile(value.journalPath, journalFixture(value, escaped));
    await mkdir(join(value.root, '.obts', 'apply-displaced', escaped), { recursive: true });
    await writeFile(join(value.root, '.obts', 'apply-displaced', escaped, entry), NOTE_A);
    await latchAndCorrupt(value, 'empty');

    const { core } = restart(value, (patch) => {
      const rename = patch.fsp.rename.bind(patch.fsp);
      patch.fsp.rename = async (from: string, to: string) => {
        if (`${from}`.includes('apply-displaced')) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
        return await rename(from, to);
      };
    });
    await expect(core.removeUnreadableApplyJournalAfterQuarantine())
      .rejects.toMatchObject({ code: 'displaced_recovery_archive_failed' });

    expect(await fileBytes(join(value.root, '.obts', 'apply-displaced', escaped, entry))).toBe(NOTE_A);
    expect(await fileBytes(value.journalPath)).not.toBeNull();
    expect((await core.readState()).last_error_code).toBe('apply_journal_recovery_required');
  }, 60_000);

  it('case 49 keeps the journal when the lock naming the window cannot be reclaimed', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    const applyId = 'apply_unreclaimable_lock';
    await writeFile(value.journalPath, journalFixture(value, applyId));
    const { written } = await latchAndCorrupt(value, 'empty');
    // Parseable and naming the window, but not a marker this installation ever
    // publishes, so the lock protocol refuses to reclaim it.
    await writeFile(value.lockPath, `${JSON.stringify({
      apply_id: applyId,
      created_at: new Date().toISOString(),
      released_at: null
    })}\n`);

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await fileBytes(value.lockPath)).not.toBeNull();
    expect(await core.readState()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 60_000);

  it('case 50 keeps the journal when a readable acknowledgement is still pending', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'keep.md': KEEP });
    const applyId = 'apply_pending_ack_veto';
    await writeFile(value.journalPath, journalFixture(value, applyId));
    await writeFile(value.ackPath, `${JSON.stringify({
      target_main: value.base,
      event_seq: 41,
      created_at: new Date().toISOString()
    })}\n`);
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: applyId, created_at: new Date().toISOString() })}\n`);
    const { written } = await latchAndCorrupt(value, 'empty');

    const { core } = restart(value);
    await core.initialize();

    expect(await fileBytes(value.journalPath)).toBe(written);
    expect(await core.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect((await quarantineEvidence(value.root)).bytes).toBe(written);
  }, 60_000);
});

describe('unreadable apply journal heal over the mobile adapter shape', () => {
  it('case 30 retires a bundle-less planned journal without native sync hooks', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { crashIn: 'planned' });
    const { journal, written } = await latchAndCorrupt(value, 'not_json');
    await writeFile(value.lockPath, `${JSON.stringify({ apply_id: journal.apply_id, created_at: new Date().toISOString() })}`);

    const mobile = await mobileCore(value);
    await mobile.core.initialize();

    expect(await mobile.read('.obts/apply-journal.json')).toBeNull();
    expect(await mobile.read('.obts/apply.lock')).toBeNull();
    const state = await mobile.state();
    expect(state.last_error_code).toBeNull();
    expect(state.local_main).toBe(value.base);
    const names = await mobile.quarantine();
    expect(names).toHaveLength(1);
    expect(await mobile.read(`.obts/recovery-corrupt/${names[0]}/apply-journal.json`)).toBe(written);
  }, 90_000);

  it('case 31 reconstructs and finishes the delta without native sync hooks', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, {
      'note-a.md': NOTE_A_TARGET,
      'note-b.md': NOTE_B_TARGET,
      'note-new.md': NOTE_NEW_TARGET
    });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-new.md', 'note-a.md'] });
    await writeFile(join(value.root, 'note-b.md'), EDITED_AFTER_CRASH);
    await latchAndCorrupt(value, 'not_json');

    const mobile = await mobileCore(value);
    await mobile.core.initialize();

    expect(await mobile.read('note-a.md')).toBe(NOTE_A_TARGET);
    expect(await mobile.read('note-b.md')).toBe(EDITED_AFTER_CRASH);
    expect(await mobile.read('note-new.md')).toBe(NOTE_NEW_TARGET);
    expect(await mobile.read('.obts/apply-journal.json')).toBeNull();
    expect(JSON.parse((await mobile.read('.obts/pending-applied-ack.json')) as string))
      .toMatchObject({ target_main: target });
    expect(await mobile.quarantine()).toHaveLength(1);
  }, 90_000);

  it('case 32 keeps the journal and the latch when publishing the quarantine fails', async () => {
    const value = await vault({ 'note-a.md': NOTE_A, 'note-b.md': NOTE_B, 'keep.md': KEEP });
    const target = await prepareTarget(value, { 'note-a.md': NOTE_A_TARGET, 'note-b.md': NOTE_B_TARGET });
    await applyUntilSuspension(value, target, { writeBeforeCrash: ['note-b.md'] });
    const { written } = await latchAndCorrupt(value, 'not_json');

    const mobile = await mobileCore(value, (core) => {
      // The adapter has no syncFile, so the observable loss is the rename that
      // publishes a verified staging directory.
      const rename = core.fsp.rename.bind(core.fsp);
      core.fsp.rename = async (from: string, to: string) => {
        if (`${from}${to}`.includes('recovery-corrupt')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return await rename(from, to);
      };
    });
    await mobile.core.initialize();

    expect(await mobile.read('.obts/apply-journal.json')).toBe(written);
    expect(await mobile.state()).toMatchObject({
      last_error_code: 'apply_journal_recovery_required',
      apply_validation_reason: 'recovery_state_corrupt'
    });
    expect(await mobile.quarantine()).toHaveLength(0);
    expect((await mobile.core.fsp.readdir('.obts/recovery-corrupt')).filter((name: string) => name.startsWith('.partial-')))
      .toHaveLength(0);
    expect(await mobile.read('note-a.md')).toBe(NOTE_A);
  }, 90_000);
});
