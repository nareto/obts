import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as deletionRoot from '../src/server/deletionRoot.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

import { OperationHistoryStore } from '../src/server/operationHistoryStore.js';

import { MetadataPublicationError, MetadataStore } from '../src/server/metadataStore.js';

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));

const roots: string[] = [];
const stores: MetadataStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(async (store) => await store.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(options: ConstructorParameters<typeof MetadataStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obts-operation-history-'));
  roots.push(root);
  const store = new MetadataStore(root, options);
  stores.push(store);
  await store.initialize();
  await store.mutate((db) => {
    db.vaults.push({
      vault_id: 'vlt_history', owner_user_id: 'usr_history', display_name: 'History', status: 'active',
      current_main: 'a'.repeat(40), root_commit: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
    });
  });
  return { root, store };
}

function addTerminalOperation(store: MetadataStore, operation: {
  target_commit: string | null;
  proposal_base?: string | null;
  attempt_id?: string;
  attempt_hash?: string;
  status?: 'committed' | 'aborted';
}) {
  return store.mutate((db) => {
    const row = store.startOperation(db, {
      vault_id: 'vlt_history', device_id: 'dev_history', operation_type: 'device_push',
      expected_refs: {}, target_refs: {}, target_commit: operation.target_commit,
      ...(Object.hasOwn(operation, 'proposal_base') ? { proposal_base: operation.proposal_base } : {})
    });
    row.status = operation.status ?? 'aborted';
    row.prepared_manifest = {
      ...(operation.attempt_id ? { attempt_id: operation.attempt_id } : {}),
      ...(operation.attempt_hash ? { attempt_hash: operation.attempt_hash } : {}),
      rename_pairs: [{ source: 'old.md', destination: 'new.md' }],
      directory_proposal: { proposal_id: 'dir_history', explicit_dirs: ['folder'] }
    };
    row.result = { outcome: row.status };
    return row;
  });
}

async function addPendingMerge(store: MetadataStore) {
  await store.mutate((db) => {
    db.devices.push({
      device_id: 'dev_history', vault_id: 'vlt_history', user_id: 'usr_history', device_name: 'Device',
      device_ref: 'refs/heads/device', device_ref_head: 'b'.repeat(40), status: 'ahead',
      last_applied_main: null, last_applied_event_seq: 0, last_applied_explicit_dirs: null,
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: null, last_successful_sync_at: null, local_status_label: null, path_capabilities: null,
      local_error_code: null, local_queue_status: null, local_main: null, local_head: null, plugin_version: null,
      last_status_report_at: null, onboarding_status: null, onboarding_mode: null, initial_proposal_kind: null,
      initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: null,
      created_at: '2026-01-01T00:00:00.000Z', revoked_at: null
    });
  });
  return await addTerminalOperation(store, { target_commit: 'b'.repeat(40), proposal_base: null, status: 'committed' });
}

async function leaveHotJournal(path: string, foreign = false): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA cache_size=5;');
    if (${foreign}) db.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, payload TEXT); BEGIN; WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<1000) INSERT INTO unrelated SELECT x, printf('%02000d',x) FROM seq; COMMIT;");
    db.exec(${JSON.stringify(foreign ? "BEGIN IMMEDIATE; UPDATE unrelated SET payload=replace(payload,'0','1')" : "BEGIN IMMEDIATE; UPDATE operations SET canonical_json=canonical_json||printf('%0200000d',1)")});
    console.log('ready');
    setInterval(() => {}, 1000);
  `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Hot-journal fixture exited before ready.')));
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  expect((await readFile(`${path}-journal`)).subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7');
}

async function ownedHotFixture(boundary: 'parent' | 'target' = 'parent') {
  const { root, store } = await fixture();
  await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'old-attempt', attempt_hash: 'old-hash', proposal_base: null });
  await store.archiveCompletedHistory('vlt_history');
  await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'pending-attempt', attempt_hash: 'pending-hash' });
  const expected = await store.exportOperationHistory('vlt_history');
  const commit = OperationHistoryStore.prototype.commitBatch;
  vi.spyOn(OperationHistoryStore.prototype, 'commitBatch').mockImplementationOnce(function (this: OperationHistoryStore, batch) {
    if (boundary === 'target') commit.call(this, batch);
    throw new Error('interrupted handoff');
  });
  await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow('interrupted handoff');
  await store.close();
  vi.restoreAllMocks();
  const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
  const path = join(directory, 'history.sqlite');
  const ledger = new DatabaseSync(path, { readOnly: true });
  const priorBatchId = ledger.prepare('SELECT batch_id FROM batches ORDER BY target_generation LIMIT 1').get()!.batch_id as string;
  ledger.close();
  await leaveHotJournal(path);
  const original = await pairDigest(path);
  return { root, directory, path, expected, original, priorBatchId };
}

async function pairDigest(path: string): Promise<string[]> {
  return await Promise.all([path, `${path}-journal`].map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')));
}

async function restartAndCheck(root: string, expected: Awaited<ReturnType<MetadataStore['exportOperationHistory']>>) {
  for (let restart = 0; restart < 2; restart++) {
    const store = new MetadataStore(root);
    stores.push(store);
    await store.initialize();
    expect((await store.snapshot()).sync_operations).toEqual([]);
    expect((await store.snapshot()).operation_history_by_vault!.vlt_history!.pending_batch).toBeNull();
    expect(await store.exportOperationHistory('vlt_history')).toEqual(expected);
    expect(await store.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 2 });
    for (const row of expected) expect((await store.findArchivedAttempt('vlt_history', 'dev_history', row.prepared_manifest!.attempt_id as string))?.row).toEqual(row);
    expect(store.isReady()).toBe(true);
    await store.close();
  }
}

async function pendingInitializationFixture() {
  const { root, store } = await fixture();
  await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'initial-attempt', proposal_base: null });
  const expected = await store.exportOperationHistory('vlt_history');
  const disk = await store.snapshot();
  disk.operation_history_by_vault!.vlt_history!.init_pending = true;
  await store.close();
  await writeFile(join(root, 'metadata', 'phase1.json'), JSON.stringify(disk));
  const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
  await rm(join(directory, 'history.sqlite'));
  const ledgerId = disk.operation_history_by_vault!.vlt_history!.ledger_id;
  const stage = join(directory, `.initial-${createHash('sha256').update(JSON.stringify(['vlt_history', ledgerId])).digest('hex')}`);
  return { root, directory, ledgerId, stage, expected };
}

describe('durable operation history', () => {
  it.each(['stage-file-sync', 'stage-directory-sync', 'rename', 'stage-cleanup'] as const)(
    'retains full hot evidence on initial %s failure and retries twice', async (boundary) => {
      const { root, directory, stage, expected } = await pendingInitializationFixture();
      const primary = new Error(`injected initial ${boundary}`);
      const sync = async (path: string) => {
        if (boundary === 'stage-file-sync' && path === join(stage, 'history.sqlite') ||
            boundary === 'stage-directory-sync' && path === stage) throw primary;
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      };
      const originalRename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        if (boundary === 'rename' && String(args[0]).endsWith('/history.sqlite')) throw primary;
        await originalRename(...args);
      });
      const remove = deletionRoot.removeEmptyDeletionRootDirectoryChild;
      vi.spyOn(deletionRoot, 'removeEmptyDeletionRootDirectoryChild').mockImplementation(async (...args) => {
        if (boundary === 'stage-cleanup' && args[1].startsWith('.initial-')) throw primary;
        await remove(...args);
      });
      const failed = new MetadataStore(root, { fsyncFile: sync, fsyncDirectory: sync });
      stores.push(failed);
      await expect(failed.initialize()).rejects.toBe(primary);
      expect(failed.isReady()).toBe(false);
      const disk = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
      expect(disk.sync_operations).toEqual(expected);
      expect(disk.operation_history_by_vault.vlt_history.init_pending).toBe(true);
      if (boundary !== 'stage-cleanup') await expect(fs.access(join(directory, 'history.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.access(stage);
      await failed.close();
      vi.restoreAllMocks();
      for (let restart = 0; restart < 2; restart++) {
        const recovered = new MetadataStore(root);
        stores.push(recovered);
        await recovered.initialize();
        expect(await recovered.exportOperationHistory('vlt_history')).toEqual(expected);
        expect(recovered.isReady()).toBe(true);
        expect(await readdir(directory)).toEqual(['history.sqlite']);
        await recovered.close();
      }
    }
  );

  it.each(['empty', 'partial-journal', 'committed'] as const)('disposes only the owned %s initial stage before retry', async (kind) => {
    const { root, directory, stage, expected } = await pendingInitializationFixture();
    await mkdir(stage, { mode: 0o700 });
    if (kind === 'partial-journal') {
      await writeFile(join(stage, 'history.sqlite'), '', { mode: 0o600 });
      await writeFile(join(stage, 'history.sqlite-journal'), 'partial staged journal', { mode: 0o600 });
    }
    if (kind === 'committed') {
      await writeFile(join(stage, 'history.sqlite'), '', { mode: 0o600 });
      const ledger = new DatabaseSync(join(stage, 'history.sqlite'));
      ledger.exec('CREATE TABLE incomplete(payload TEXT)');
      ledger.close();
    }
    const recovered = new MetadataStore(root);
    stores.push(recovered);
    await recovered.initialize();
    expect(await recovered.exportOperationHistory('vlt_history')).toEqual(expected);
    expect(await readdir(directory)).toEqual(['history.sqlite']);
  });

  it.each(['unknown-file', 'foreign-namespace', 'directory-mode', 'file-mode', 'symlink', 'hardlink', 'empty-final', 'foreign-final', 'acknowledged-missing'] as const)(
    'preserves unsafe initial residue or final authority (%s)', async (kind) => {
      const { root, directory, stage } = await pendingInitializationFixture();
      const path = kind === 'foreign-namespace' ? stage.replace(/.$/u, stage.endsWith('0') ? '1' : '0') : stage;
      if (kind === 'empty-final' || kind === 'foreign-final') {
        await writeFile(join(directory, 'history.sqlite'), kind === 'empty-final' ? '' : 'unrelated final evidence');
      } else {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, 'history.sqlite'), 'staged evidence', { mode: 0o600 });
        if (kind === 'unknown-file') await writeFile(join(path, 'unknown'), 'unrelated evidence');
        if (kind === 'directory-mode') await fs.chmod(path, 0o755);
        if (kind === 'file-mode') await fs.chmod(join(path, 'history.sqlite'), 0o644);
        if (kind === 'symlink' || kind === 'hardlink') {
          await writeFile(join(root, 'sentinel'), 'external evidence');
          await fs[kind === 'symlink' ? 'symlink' : 'link'](join(root, 'sentinel'), join(path, 'history.sqlite-journal'));
        }
        if (kind === 'acknowledged-missing') {
          const metadataPath = join(root, 'metadata', 'phase1.json');
          const disk = JSON.parse(await readFile(metadataPath, 'utf8'));
          disk.operation_history_by_vault.vlt_history.init_pending = false;
          await writeFile(metadataPath, JSON.stringify(disk));
        }
      }
      const originalNames = await readdir(directory);
      for (let restart = 0; restart < 2; restart++) {
        const recovered = new MetadataStore(root);
        stores.push(recovered);
        await expect(recovered.initialize()).rejects.toThrow();
        expect(recovered.isReady()).toBe(false);
        expect(await readdir(directory)).toEqual(originalNames);
        if (kind.endsWith('-final')) expect(await readFile(join(directory, 'history.sqlite'), 'utf8')).toBe(kind === 'empty-final' ? '' : 'unrelated final evidence');
        else expect(await readFile(join(path, 'history.sqlite'), 'utf8')).toBe('staged evidence');
        await recovered.close();
      }
    }
  );

  it('erases attributable interrupted initial database and journal without needing a final ledger', async () => {
    const { directory, stage, ledgerId } = await pendingInitializationFixture();
    await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, 'history.sqlite'), '', { mode: 0o600 });
    await writeFile(join(stage, 'history.sqlite-journal'), 'partial initial journal', { mode: 0o600 });
    await OperationHistoryStore.eraseDirectory(directory, { vaultId: 'vlt_history', ledgerId });
    await expect(fs.access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await OperationHistoryStore.eraseDirectory(directory, { vaultId: 'vlt_history', ledgerId });
  });

  it('refuses an unexplained final journal without publishing a database underneath it', async () => {
    const { root, directory, expected } = await pendingInitializationFixture();
    const path = join(directory, 'history.sqlite-journal');
    await writeFile(path, 'unrelated rollback evidence', { mode: 0o600 });
    for (let restart = 0; restart < 2; restart++) {
      const failed = new MetadataStore(root);
      stores.push(failed);
      await expect(failed.initialize()).rejects.toThrow('Operation history journal has no ledger.');
      expect(failed.isReady()).toBe(false);
      expect(await readdir(directory)).toEqual(['history.sqlite-journal']);
      expect(await readFile(path, 'utf8')).toBe('unrelated rollback evidence');
      expect(JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8')).sync_operations).toEqual(expected);
      await failed.close();
    }
  });

  it('preserves the primary initial publication error when descriptor closure also fails', async () => {
    const { root, stage } = await pendingInitializationFixture();
    const primary = new Error('initial publication failure');
    const close = deletionRoot.closeDeletionRoot;
    vi.spyOn(deletionRoot, 'closeDeletionRoot').mockImplementation(async (opened) => {
      await close(opened);
      if (opened.configuredPath === stage) throw new Error('secondary descriptor close failure');
    });
    const store = new MetadataStore(root, { fsyncFile: async (path) => {
      if (path === join(stage, 'history.sqlite')) throw primary;
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
    } });
    stores.push(store);
    await expect(store.initialize()).rejects.toBe(primary);
    expect(store.isReady()).toBe(false);
  });

  it.each(['before-begin', 'after-first-table', 'control'] as const)(
    'atomically publishes initial history across a stopped-child %s boundary and two restarts', async (boundary) => {
      const { root, store } = await fixture();
      await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'initial-attempt', attempt_hash: 'initial-hash', proposal_base: null });
      const expected = await store.exportOperationHistory('vlt_history');
      const legacy = { ...await store.snapshot(), schema_version: 7 };
      delete legacy.operation_history_by_vault;
      for (const row of legacy.sync_operations) delete row.operation_sequence;
      await store.close();
      await writeFile(join(root, 'metadata', 'phase1.json'), JSON.stringify(legacy));
      const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
      await rm(join(root, 'metadata', 'operation-history'), { recursive: true });
      const bundled = await build({ entryPoints: ['src/server/metadataStore.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
      const childPath = join(root, 'initialize.mjs');
      await writeFile(childPath, bundled.outputFiles[0]!.text + `
        const { DatabaseSync: SQLite } = await import('node:sqlite');
        const { writeSync } = await import('node:fs');
        const original = SQLite.prototype.exec;
        SQLite.prototype.exec = function(sql) {
          if (${JSON.stringify(boundary)} === 'before-begin' && sql === 'BEGIN IMMEDIATE') {
            writeSync(1, 'stopped'); process.kill(process.pid, 'SIGSTOP');
          }
          const result = original.call(this, sql);
          if (${JSON.stringify(boundary)} === 'after-first-table' && sql.startsWith('CREATE TABLE ledger_meta')) {
            writeSync(1, 'stopped'); process.kill(process.pid, 'SIGSTOP');
          }
          return result;
        };
        const store = new MetadataStore(${JSON.stringify(root)});
        await store.initialize(); await store.close();
      `);
      const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      if (boundary === 'control') expect(await exited, stderr).toEqual([0, null]);
      else {
        try {
          await new Promise<void>((resolve, reject) => {
            child.stdout!.once('data', () => resolve());
            child.once('error', reject);
            child.once('exit', () => reject(new Error(`Initialization child exited before stop: ${stderr}`)));
          });
        } finally { child.kill('SIGKILL'); await exited; }
        const disk = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
        expect(disk.operation_history_by_vault.vlt_history.init_pending).toBe(true);
        expect(disk.sync_operations).toEqual(expected);
        await expect(fs.access(join(directory, 'history.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
        const staged = (await readdir(directory)).find((name) => name.startsWith('.initial-'))!;
        expect(staged).toBeTruthy();
        expect((await fs.stat(join(directory, staged, 'history.sqlite'))).size).toBe(0);
        if (boundary === 'after-first-table') await fs.access(join(directory, staged, 'history.sqlite-journal'));
      }
      for (let restart = 0; restart < 2; restart++) {
        const recovered = new MetadataStore(root);
        stores.push(recovered);
        await recovered.initialize();
        expect(await recovered.exportOperationHistory('vlt_history')).toEqual(expected);
        await recovered.archiveCompletedHistory('vlt_history');
        expect((await recovered.snapshot()).sync_operations).toEqual([]);
        expect(await recovered.exportOperationHistory('vlt_history')).toEqual(expected);
        expect((await recovered.findArchivedAttempt('vlt_history', 'dev_history', 'initial-attempt'))?.row).toEqual(expected[0]);
        expect((await recovered.findArchivedTargetCandidates('vlt_history', 'dev_history', 'b'.repeat(40)))[0]?.row).toEqual(expected[0]);
        expect(await recovered.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 1 });
        expect(recovered.isReady()).toBe(true);
        expect(await readdir(directory)).toEqual(['history.sqlite']);
        await recovered.close();
      }
    }
  );

  it.each(['attempt', 'target', 'export', 'malformed-json', 'conflicting-copy', 'counts'] as const)(
    'latches known %s history failure until verified restart even after in-process repair', async (consumer) => {
      const { root, store } = await fixture();
      const row = await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'corrupt-attempt', proposal_base: null });
      await store.archiveCompletedHistory('vlt_history');
      const history = (store as unknown as { histories: Map<string, OperationHistoryStore> }).histories.get('vlt_history')!;
      const ledger = (history as unknown as { db: DatabaseSync }).db;
      const original = ledger.prepare('SELECT canonical_hash,canonical_json FROM operations').get()!;
      const primary = new Error('synthetic aggregate read failure');
      if (consumer === 'conflicting-copy') await store.mutate((db) => { db.sync_operations.push({ ...row, result: { changed: true } }); });
      else if (consumer === 'counts') vi.spyOn(history, 'countByTypeStatus').mockImplementationOnce(() => { throw primary; });
      else if (consumer === 'malformed-json') ledger.prepare('UPDATE operations SET canonical_json=?').run('synthetic-confidential-payload-invalid-json');
      else ledger.exec("UPDATE operations SET canonical_hash='synthetic-corruption'");
      const read = consumer === 'attempt' ? store.findArchivedAttempt('vlt_history', 'dev_history', 'corrupt-attempt') :
        consumer === 'target' ? store.findArchivedTargetCandidates('vlt_history', 'dev_history', 'b'.repeat(40)) :
        consumer === 'counts' ? store.operationHistoryCounts('vlt_history') : store.exportOperationHistory('vlt_history');
      if (consumer === 'counts') await expect(read).rejects.toBe(primary);
      else await expect(read).rejects.toThrow(consumer === 'conflicting-copy' ? 'Operation history contains conflicting copies.' : 'Operation history row payload is corrupt.');
      expect(store.isDurabilityUncertain()).toBe(true);
      expect(store.isReady()).toBe(false);
      ledger.prepare('UPDATE operations SET canonical_hash=?,canonical_json=?').run(original.canonical_hash!, original.canonical_json!);
      if (consumer === 'conflicting-copy') (store as unknown as { db: { sync_operations: unknown[] } }).db.sync_operations = [];
      await expect(store.findArchivedAttempt('vlt_history', 'dev_history', 'missing')).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.findArchivedTargetCandidates('vlt_history', 'dev_history', 'missing')).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.exportOperationHistory('vlt_history')).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.operationHistoryCounts('vlt_history')).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.mutate(() => {})).rejects.toBeInstanceOf(MetadataPublicationError);
      await expect(store.archiveCompletedHistory('vlt_history')).rejects.toBeInstanceOf(MetadataPublicationError);
      expect(store.isReady()).toBe(false);
      await store.close();
      if (consumer === 'conflicting-copy') {
        const path = join(root, 'metadata', 'phase1.json');
        const disk = JSON.parse(await readFile(path, 'utf8'));
        disk.sync_operations = [];
        await writeFile(path, JSON.stringify(disk));
      }
      const recovered = new MetadataStore(root);
      stores.push(recovered);
      await recovered.initialize();
      expect(recovered.isReady()).toBe(true);
      expect(await recovered.exportOperationHistory('vlt_history')).toEqual([row]);
      await recovered.mutate(() => {});
    }
  );

  it.each(['parent', 'target'] as const)('recovers an owned stopped-writer hot journal at the pending %s generation through two restarts', async (boundary) => {
    const { root, directory, expected } = await ownedHotFixture(boundary);
    await restartAndCheck(root, expected);
    expect(await readdir(directory)).toEqual(['history.sqlite']);
  });

  it.each(['generation', 'sequence', 'source', 'proof'] as const)('rejects hot-journal recovery before original mutation on invalid %s metadata evidence', async (corruption) => {
    const { root, path, directory, original } = await ownedHotFixture('target');
    const metadataPath = join(root, 'metadata', 'phase1.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const state = metadata.operation_history_by_vault.vlt_history;
    if (corruption === 'generation') state.pending_batch = null;
    if (corruption === 'sequence') state.next_sequence = 2;
    if (corruption === 'source') metadata.sync_operations[0].result = { changed: true };
    if (corruption === 'proof') state.pending_batch.batch_id = 'batch_foreign';
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow();
    expect(await pairDigest(path)).toEqual(original);
    expect((await readdir(directory)).sort()).toEqual(['history.sqlite', 'history.sqlite-journal']);
    expect(restarted.isReady()).toBe(false);
    await expect(restarted.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
  });

  it.each(['batch-id', 'row-identity'] as const)('rejects a parent pending %s collision before original recovery', async (collision) => {
    const { root, path, original, expected, priorBatchId } = await ownedHotFixture();
    const metadataPath = join(root, 'metadata', 'phase1.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const batch = metadata.operation_history_by_vault.vlt_history.pending_batch;
    if (collision === 'batch-id') batch.batch_id = priorBatchId;
    else {
      const row = expected[0]!;
      metadata.sync_operations = [row];
      const canonical = OperationHistoryStore.canonical(row);
      batch.rows = [{ operation_id: row.operation_id, sequence: row.operation_sequence, canonical: canonical.text, sha256: canonical.sha256 }];
    }
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('Operation history pending batch collides with existing evidence.');
    expect(await pairDigest(path)).toEqual(original);
    expect(restarted.isReady()).toBe(false);
  });

  it.each(['database-bytes', 'journal-bytes', 'database-identity', 'journal-identity'] as const)(
    'rejects %s changed after copy validation without recovering the original', async (change) => {
      const { root, directory, path, original } = await ownedHotFixture();
      const remove = deletionRoot.removeEmptyDeletionRootDirectoryChild;
      let changed: string[] = [];
      vi.spyOn(deletionRoot, 'removeEmptyDeletionRootDirectoryChild').mockImplementationOnce(async (...args) => {
        await remove(...args);
        const changedPath = change.startsWith('database') ? path : `${path}-journal`;
        if (change.endsWith('identity')) {
          const bytes = await readFile(changedPath);
          await rename(changedPath, `${changedPath}.previous`);
          await writeFile(changedPath, bytes);
          await rm(`${changedPath}.previous`);
        } else {
          const file = await open(changedPath, 'r+');
          try { await file.write(Buffer.from([7]), 0, 1, (await file.stat()).size); } finally { await file.close(); }
        }
        changed = await pairDigest(path);
      });
      const restarted = new MetadataStore(root);
      stores.push(restarted);
      await expect(restarted.initialize()).rejects.toThrow('Operation history recovery source changed.');
      if (change.endsWith('identity')) expect(changed).toEqual(original);
      else {
        const index = change.startsWith('database') ? 0 : 1;
        expect(changed[index]).not.toBe(original[index]);
        expect(changed[1 - index]).toBe(original[1 - index]);
      }
      expect(await pairDigest(path)).toEqual(changed);
      expect((await readdir(directory)).sort()).toEqual(['history.sqlite', 'history.sqlite-journal']);
      expect(restarted.isReady()).toBe(false);
    }
  );

  it('revalidates the actual writable state after an authorized original recovery and latches rejection', async () => {
    const { root, path } = await ownedHotFixture();
    const prototype = OperationHistoryStore.prototype as unknown as { verifyOpenState(state: unknown): void };
    const verify = prototype.verifyOpenState;
    let calls = 0;
    vi.spyOn(prototype, 'verifyOpenState').mockImplementation(function (this: OperationHistoryStore, state) {
      verify.call(this, state);
      if (++calls === 2) throw new Error('injected actual opened state rejection');
    });
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('injected actual opened state rejection');
    expect(calls).toBe(2);
    await expect(readFile(`${path}-journal`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restarted.isReady()).toBe(false);
    await expect(restarted.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
  });

  it.each([8, 5, 1])('does not copy or retry writable on other SQLite refusals (code %i)', async (errcode) => {
    const { root, path, original } = await ownedHotFixture();
    const identity = OperationHistoryStore as unknown as { verifyIdentity(): void; fingerprint(): Promise<string> };
    vi.spyOn(identity, 'verifyIdentity').mockImplementationOnce(() => { throw Object.assign(new Error('other SQLite refusal'), { code: 'ERR_SQLITE_ERROR', errcode }); });
    const fingerprint = vi.spyOn(identity, 'fingerprint');
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('other SQLite refusal');
    expect(fingerprint).not.toHaveBeenCalled();
    expect(await pairDigest(path)).toEqual(original);
  });

  it.each(['unknown', 'foreign-namespace', 'symlink'] as const)('blocks startup on %s scratch residue while preserving both originals', async (kind) => {
    const { root, directory, path, original } = await ownedHotFixture();
    const metadata = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
    const ledgerId = kind === 'foreign-namespace' ? 'hist_other' : metadata.operation_history_by_vault.vlt_history.ledger_id;
    const scratch = join(directory, `.recovery-${createHash('sha256').update(JSON.stringify(['vlt_history', ledgerId])).digest('hex')}`);
    await mkdir(scratch, { mode: 0o700 });
    if (kind === 'symlink') await fs.symlink(path, join(scratch, 'history.sqlite'));
    else await writeFile(join(scratch, kind === 'unknown' ? 'unknown' : 'history.sqlite'), 'unrelated bytes', { mode: 0o600 });
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow();
    expect(await pairDigest(path)).toEqual(original);
    expect(await readdir(scratch)).toHaveLength(1);
  });

  it.each(['empty', 'partial-database', 'database-only', 'partial-journal', 'recovered-copy'] as const)(
    'discards only owned %s recovery scratch on restart, retaining the original pair until cleanup succeeds', async (boundary) => {
      const { root, directory, path, original, expected } = await ownedHotFixture();
      const fsOpen = fs.open;
      let copies = 0;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (args[1] === 'wx') {
          copies++;
          if (boundary === 'empty' || boundary === 'database-only' && copies === 2) throw new Error('injected copy interruption');
          const handle = await fsOpen(...args);
          if (boundary === 'partial-database' || boundary === 'partial-journal' && copies === 2) {
            const write = handle.writeFile.bind(handle);
            vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data) => {
              await write((data as Buffer).subarray(0, 512));
              throw new Error('injected copy interruption');
            });
          }
          return handle;
        }
        return await fsOpen(...args);
      });
      const remove = deletionRoot.removeDeletionRootFileChild;
      vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockImplementation(async (...args) => {
        if (args[0].configuredPath.includes('.recovery-')) throw new Error('injected scratch cleanup failure');
        await remove(...args);
      });
      const removeDir = deletionRoot.removeEmptyDeletionRootDirectoryChild;
      vi.spyOn(deletionRoot, 'removeEmptyDeletionRootDirectoryChild').mockImplementation(async (...args) => {
        if (args[1].startsWith('.recovery-')) throw new Error('injected scratch cleanup failure');
        await removeDir(...args);
      });
      const failed = new MetadataStore(root);
      stores.push(failed);
      await expect(failed.initialize()).rejects.toThrow(boundary === 'recovered-copy' ? 'injected scratch cleanup failure' : 'injected copy interruption');
      expect(await pairDigest(path)).toEqual(original);
      const scratch = (await readdir(directory)).find((name) => name.startsWith('.recovery-'))!;
      expect(scratch).toBeTruthy();
      expect((await fs.stat(join(directory, scratch))).mode & 0o777).toBe(0o700);
      for (const name of await readdir(join(directory, scratch))) expect((await fs.stat(join(directory, scratch, name))).mode & 0o777).toBe(0o600);
      if (boundary === 'partial-database' || boundary === 'partial-journal') {
        expect((await fs.stat(join(directory, scratch, boundary === 'partial-database' ? 'history.sqlite' : 'history.sqlite-journal'))).size).toBe(512);
      }
      expect(failed.isReady()).toBe(false);
      await expect(failed.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
      await failed.close();
      vi.restoreAllMocks();
      await restartAndCheck(root, expected);
      expect(await readdir(directory)).toEqual(['history.sqlite']);
    }
  );

  it('preserves the copy validation error when confidential scratch cleanup also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-history-hot-cleanup-'));
    roots.push(root);
    const directory = join(root, 'history', 'vault');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'history.sqlite');
    await leaveHotJournal(path, true);
    const original = await pairDigest(path);
    vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockRejectedValue(new Error('injected cleanup failure'));
    await expect(OperationHistoryStore.open(directory, 'vlt_history', 'hist_expected', true)).rejects.toThrow('no such table: ledger_meta');
    expect(await pairDigest(path)).toEqual(original);
    expect((await readdir(directory)).some((name) => name.startsWith('.recovery-'))).toBe(true);
    vi.restoreAllMocks();
    await expect(OperationHistoryStore.open(directory, 'vlt_history', 'hist_expected', true)).rejects.toThrow('no such table: ledger_meta');
    expect(await pairDigest(path)).toEqual(original);
    expect((await readdir(directory)).sort()).toEqual(['history.sqlite', 'history.sqlite-journal']);
  });

  it('rejects a foreign stopped-writer hot journal without changing either original file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-history-hot-foreign-'));
    roots.push(root);
    const directory = join(root, 'history', 'vault');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'history.sqlite');
    await leaveHotJournal(path, true);
    const before = await readFile(path);
    const journal = await readFile(`${path}-journal`);
    const readonly = new DatabaseSync(path, { readOnly: true });
    try {
      expect(() => readonly.prepare('SELECT * FROM sqlite_schema').all()).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 776 }));
    } finally { readonly.close(); }
    await expect(OperationHistoryStore.open(directory, 'vlt_history', 'hist_expected', true)).rejects.toThrow();
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(digest(await readFile(path))).toBe(digest(before));
    expect(digest(await readFile(`${path}-journal`))).toBe(digest(journal));
    expect((await readdir(directory)).sort()).toEqual(['history.sqlite', 'history.sqlite-journal']);
  });
  it.each([
    'DROP TABLE operations',
    'DROP TABLE operation_counts',
    'DROP TABLE batches',
    'DROP TABLE ledger_meta',
    'DROP INDEX operations_attempt',
    'DROP INDEX operations_target_bound',
    'DROP INDEX operations_target_status',
    'DROP INDEX operations_pending',
    'DROP TRIGGER operations_count_insert',
    'DROP INDEX operations_attempt; CREATE INDEX operations_attempt ON operations(attempt_hash)',
    'UPDATE operation_counts SET count=count+1',
    'DELETE FROM operation_counts',
    'DELETE FROM batches',
    'UPDATE batches SET row_count=row_count+1',
    'UPDATE batches SET parent_generation=9',
    "UPDATE operations SET attempt_id='hidden-attempt'",
    "UPDATE operations SET canonical_hash='invalid'",
    'DELETE FROM operations',
    'UPDATE ledger_meta SET schema_version=2',
    'UPDATE ledger_meta SET max_sequence=0'
  ])('rejects incomplete or inconsistent existing evidence without repairing it: %s', async (corruption) => {
    const { root, store } = await fixture();
    await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'attempt-evidence' });
    await store.archiveCompletedHistory('vlt_history');
    await store.close();
    const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
    const path = join(directory, 'history.sqlite');
    const ledger = new DatabaseSync(path);
    ledger.exec(corruption);
    ledger.close();
    const before = await readFile(path);
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(restarted.isReady()).toBe(false);
    await expect(restarted.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-evidence')).rejects.toThrow();
  });

  it('does not modify a foreign existing database or add history schema to it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-history-foreign-'));
    roots.push(root);
    const directory = join(root, 'history', 'vault');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'history.sqlite');
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('evidence')");
    db.close();
    const before = await readFile(path);
    await expect(OperationHistoryStore.open(directory, 'vlt_history', 'hist_new', true)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(directory)).toEqual(['history.sqlite']);
  });

  it.each(['vault_id', 'ledger_id', 'schema_version', 'generation', 'max_sequence'] as const)(
    'gates each cached and evicted access on %s without a preceding health poll and latches failure', async (field) => {
      for (const evicted of [false, true]) {
        for (const access of ['snapshot', 'admission', 'diagnostics', 'export'] as const) {
          const { root, store } = await fixture();
          await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'attempt-cached' });
          await store.archiveCompletedHistory('vlt_history');
          if (evicted) {
            await store.mutate((db) => {
              for (let index = 0; index < 17; index++) db.vaults.push({
                ...db.vaults[0]!, vault_id: `vlt_eviction_${index}`
              });
            });
            expect((store as unknown as { histories: Map<string, unknown> }).histories.has('vlt_history')).toBe(false);
          }
          const ledger = new DatabaseSync(join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite'));
          const original = ledger.prepare(`SELECT ${field} AS value FROM ledger_meta`).get()!.value!;
          ledger.prepare(`UPDATE ledger_meta SET ${field}=?`).run(typeof original === 'string' ? 'foreign' : Number(original) + 1);
          const read = () => access === 'snapshot' ? store.snapshot() : access === 'admission'
            ? store.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-cached') : access === 'diagnostics'
              ? store.operationHistoryCounts('vlt_history') : store.exportOperationHistory('vlt_history');
          await expect(read()).rejects.toThrow();
          expect(store.isDurabilityUncertain()).toBe(true);
          ledger.prepare(`UPDATE ledger_meta SET ${field}=?`).run(original);
          ledger.close();
          await expect(read()).rejects.toBeInstanceOf(MetadataPublicationError);
          await store.close();
        }
      }
    }
  );

  it('does not rescan or hydrate history during hot access or cache eviction', async () => {
    const { root, store } = await fixture();
    const copy = vi.spyOn(OperationHistoryStore as unknown as { fingerprint(): Promise<string> }, 'fingerprint')
      .mockRejectedValue(new Error('unexpected history copy'));
    await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'attempt-indexed' });
    await store.archiveCompletedHistory('vlt_history');
    const verify = vi.spyOn(OperationHistoryStore.prototype as unknown as { verifyContents(): void }, 'verifyContents')
      .mockImplementation(() => { throw new Error('unexpected history scan'); });
    const hydrate = vi.spyOn(OperationHistoryStore.prototype, 'exportRows')
      .mockImplementation(() => { throw new Error('unexpected history hydration'); });
    await store.mutate((db) => {
      for (let index = 0; index < 17; index++) db.vaults.push({ ...db.vaults[0]!, vault_id: `vlt_other_${index}` });
    });
    expect((store as unknown as { histories: Map<string, unknown> }).histories.has('vlt_history')).toBe(false);
    expect((await store.snapshot()).sync_operations).toEqual([]);
    expect((await store.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-indexed'))?.row.prepared_manifest?.attempt_id).toBe('attempt-indexed');
    expect(await store.findArchivedAttempt('vlt_history', 'dev_history', 'missing')).toBeNull();
    expect(await store.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 1 });
    await store.mutate((db) => { db.vaults[0]!.display_name = 'Changed'; });
    expect(copy).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    const ledger = new DatabaseSync(join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite'), { readOnly: true });
    try {
      expect(ledger.prepare('EXPLAIN QUERY PLAN SELECT MAX(sequence) FROM operations').all()[0]?.detail).toContain('SEARCH operations USING COVERING INDEX');
    } finally {
      ledger.close();
    }
  });

  it('publishes ledger file and directory components bottom-up before acknowledging initialization', async () => {
    const calls: string[] = [];
    const sync = async (path: string) => {
      calls.push(path);
      const handle = await open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const { store, root } = await fixture({ fsyncFile: sync, fsyncDirectory: sync });
    const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
    const fileIndex = calls.indexOf(join(directory, 'history.sqlite'));
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(calls.slice(fileIndex, fileIndex + 4)).toEqual([
      join(directory, 'history.sqlite'), directory, join(root, 'metadata', 'operation-history'), join(root, 'metadata')
    ]);
    expect(calls.slice(fileIndex + 4).some((path) => path.includes('phase1.json'))).toBe(true);
    expect((await store.snapshot()).operation_history_by_vault!.vlt_history!.init_pending).toBe(false);
  });

  it.each(['file', 'vault-directory', 'history-parent', 'metadata-parent'] as const)(
    'retains hot evidence and blocks serving after %s initialization publication failure, then republishes on restart', async (boundary) => {
      const { store, root } = await fixture();
      const operation = await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'attempt-init' });
      const metadataPath = join(root, 'metadata', 'phase1.json');
      const legacy = { ...await store.snapshot(), schema_version: 7 };
      delete legacy.operation_history_by_vault;
      for (const row of legacy.sync_operations) delete row.operation_sequence;
      await store.close();
      await writeFile(metadataPath, JSON.stringify(legacy));
      await rm(join(root, 'metadata', 'operation-history'), { recursive: true });
      const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
      const target = boundary === 'file' ? join(directory, 'history.sqlite') : boundary === 'vault-directory' ? directory :
        boundary === 'history-parent' ? join(root, 'metadata', 'operation-history') : join(root, 'metadata');
      let ledgerPublished = false;
      const failSync = async (path: string) => {
        if (path.endsWith('history.sqlite')) ledgerPublished = true;
        if (ledgerPublished && path === target) throw new Error(`injected ${boundary} failure`);
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      };
      const failed = new MetadataStore(root, { fsyncFile: failSync, fsyncDirectory: failSync });
      stores.push(failed);
      await expect(failed.initialize()).rejects.toThrow(`injected ${boundary} failure`);
      const saved = JSON.parse(await readFile(metadataPath, 'utf8'));
      expect(saved.operation_history_by_vault.vlt_history.init_pending).toBe(true);
      expect(saved.sync_operations[0].operation_id).toBe(operation.operation_id);
      await expect(failed.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
      await failed.close();
      const calls: string[] = [];
      const sync = async (path: string) => {
        calls.push(path);
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      };
      const restarted = new MetadataStore(root, { fsyncFile: sync, fsyncDirectory: sync });
      stores.push(restarted);
      await restarted.initialize();
      expect(calls).toContain(target);
      expect((await restarted.snapshot()).sync_operations[0]?.operation_id).toBe(operation.operation_id);
      await restarted.archiveCompletedHistory('vlt_history');
      expect((await restarted.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-init'))?.row.operation_id).toBe(operation.operation_id);
    }
  );

  it('archives terminal rows without changing ordered retry, base, rename, directory, or export evidence', async () => {
    const { store, root } = await fixture();
    const first = await addTerminalOperation(store, {
      target_commit: 'b'.repeat(40), proposal_base: null, attempt_id: 'attempt-old', attempt_hash: 'hash-old'
    });
    await addTerminalOperation(store, {
      target_commit: 'b'.repeat(40), proposal_base: 'c'.repeat(40), attempt_id: 'attempt-new', attempt_hash: 'hash-new'
    });

    await store.archiveCompletedHistory('vlt_history');

    expect((await store.snapshot()).sync_operations).toEqual([]);
    expect(await store.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-old')).toMatchObject({
      sequence: first.operation_sequence,
      row: { operation_id: first.operation_id, proposal_base: null, prepared_manifest: {
        attempt_hash: 'hash-old', rename_pairs: [{ source: 'old.md', destination: 'new.md' }],
        directory_proposal: { proposal_id: 'dir_history', explicit_dirs: ['folder'] }
      } }
    });
    expect((await store.findArchivedTargetCandidates('vlt_history', 'dev_history', 'b'.repeat(40))).map(({ row, sequence }) => ({
      proposal_base: row.proposal_base, sequence
    }))).toEqual([{ proposal_base: null, sequence: first.operation_sequence }]);
    expect(await store.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 2 });
    expect((await store.exportOperationHistory('vlt_history')).map((row) => row.operation_sequence)).toEqual([1, 2]);

    await store.close();
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await restarted.initialize();
    expect((await restarted.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-old'))?.row.operation_id).toBe(first.operation_id);
    expect(restarted.isReady()).toBe(true);
  });

  it('migrates schema-7 rows in original array order despite tied timestamps and out-of-order IDs', async () => {
    const { root, store } = await fixture();
    const first = await addTerminalOperation(store, { target_commit: '1'.repeat(40), attempt_id: 'attempt-first', attempt_hash: 'hash-first' });
    const second = await addTerminalOperation(store, { target_commit: '2'.repeat(40), attempt_id: 'attempt-second', attempt_hash: 'hash-second' });
    const legacy = JSON.parse(JSON.stringify(await store.snapshot())) as Record<string, unknown>;
    legacy.schema_version = 7;
    delete legacy.operation_history_by_vault;
    const legacyOperations = legacy.sync_operations as Array<Record<string, unknown>>;
    legacyOperations.reverse();
    for (const row of legacyOperations) {
      delete row.operation_sequence;
      row.created_at = '2026-01-01T00:00:00.000Z';
      row.updated_at = '2026-01-01T00:00:00.000Z';
    }
    await store.close();
    await rm(join(root, 'metadata', 'operation-history', 'vlt_history'), { recursive: true, force: true });
    await writeFile(join(root, 'metadata', 'phase1.json'), `${JSON.stringify(legacy)}\n`);

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await restarted.initialize();
    expect((await restarted.snapshot()).schema_version).toBe(8);
    expect((await restarted.exportOperationHistory('vlt_history')).map((row) => row.operation_id))
      .toEqual([second.operation_id, first.operation_id]);
    expect((await restarted.exportOperationHistory('vlt_history')).map((row) => row.operation_sequence))
      .toEqual([1, 2]);
  });

  it('bounds open SQLite handles while keeping evicted ledgers validated and usable', async () => {
    const { store } = await fixture();
    await store.mutate((db) => {
      for (let index = 0; index < 20; index++) {
        const vaultId = `vlt_history_${index}`;
        db.vaults.push({
          vault_id: vaultId, owner_user_id: 'usr_history', display_name: `History ${index}`, status: 'active',
          current_main: 'a'.repeat(40), created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
        });
      }
    });
    expect((store as unknown as { histories: Map<string, unknown> }).histories.size).toBeLessThanOrEqual(16);
    expect(store.isReady()).toBe(true);
    await store.archiveCompletedHistory('vlt_history_0');
    expect((store as unknown as { histories: Map<string, unknown> }).histories.size).toBeLessThanOrEqual(16);
  });

  it('retains a committed device row while it is still pending merge work', async () => {
    const { store } = await fixture();
    const operation = await addPendingMerge(store);
    await store.archiveCompletedHistory('vlt_history');
    expect((await store.snapshot()).sync_operations.map((row) => row.operation_id)).toEqual([operation.operation_id]);
  });

  it.each([
    ['descriptor', 'write'], ['descriptor', 'file-sync'], ['descriptor', 'rename-before'],
    ['descriptor', 'rename-after'], ['descriptor', 'directory-sync'],
    ['final', 'write'], ['final', 'rename-before'], ['final', 'rename-after'], ['final', 'directory-sync']
  ] as const)('handoff JSON publication %s %s preserves exact restart evidence', async (phase, boundary) => {
    let armed = false;
    let writingPhase = '';
    let faults = 0;
    const fault = (step: string) => {
      if (armed && writingPhase === phase && step === boundary) {
        armed = false;
        faults++;
        throw new Error(`injected ${phase} ${boundary}`);
      }
    };
    const sync = async (path: string) => {
      const handle = await open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const { root, store } = await fixture({
      writeFile: async (path, data) => {
        const state = JSON.parse(data).operation_history_by_vault?.vlt_history;
        writingPhase = state?.pending_batch ? 'descriptor' : 'final';
        fault('write');
        await writeFile(path, data, { mode: 0o600, flag: 'wx' });
      },
      fsyncFile: async (path) => { fault('file-sync'); await sync(path); },
      rename: async (source, destination) => {
        fault('rename-before');
        await rename(source, destination);
        fault('rename-after');
      },
      fsyncDirectory: async (path) => { fault('directory-sync'); await sync(path); }
    });
    await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'first', attempt_hash: 'first-hash' });
    await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'second', attempt_hash: 'second-hash', proposal_base: null });
    const expected = await store.exportOperationHistory('vlt_history');
    armed = true;
    await expect(store.archiveCompletedHistory('vlt_history')).rejects.toMatchObject(
      boundary === 'write' || boundary === 'file-sync'
        ? { message: `injected ${phase} ${boundary}` }
        : { message: 'Metadata publication durability is uncertain.', cause: { message: `injected ${phase} ${boundary}` } }
    );
    expect(faults).toBe(1);
    expect(store.isReady()).toBe(false);
    await expect(store.mutate(() => {})).rejects.toBeInstanceOf(MetadataPublicationError);
    const persisted = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
    const published = boundary === 'rename-after' || boundary === 'directory-sync';
    const acknowledged = phase === 'final' && published;
    expect(persisted.sync_operations).toEqual(acknowledged ? [] : expected);
    expect(persisted.operation_history_by_vault.vlt_history.generation).toBe(acknowledged ? 1 : 0);
    const pending = persisted.operation_history_by_vault.vlt_history.pending_batch;
    if (acknowledged || phase === 'descriptor' && !published) expect(pending).toBeNull();
    else {
      expect(pending).toMatchObject({ vault_id: 'vlt_history', ledger_id: persisted.operation_history_by_vault.vlt_history.ledger_id, parent_generation: 0, target_generation: 1 });
      expect(pending.batch_id).toMatch(/^batch_/u);
      expect(pending.rows).toEqual(expected.map((row) => {
        const canonical = OperationHistoryStore.canonical(row);
        return { operation_id: row.operation_id, sequence: row.operation_sequence, canonical: canonical.text, sha256: canonical.sha256 };
      }));
    }
    await store.close();
    const ledger = new DatabaseSync(join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite'), { readOnly: true });
    expect(ledger.prepare('SELECT generation FROM ledger_meta').get()?.generation).toBe(phase === 'final' ? 1 : 0);
    expect(ledger.prepare('SELECT COUNT(*) AS n FROM operations').get()?.n).toBe(phase === 'final' ? 2 : 0);
    expect(ledger.prepare('SELECT COUNT(*) AS n FROM batches').get()?.n).toBe(phase === 'final' ? 1 : 0);
    ledger.close();
    for (let restart = 0; restart < 2; restart++) {
      const recovered = new MetadataStore(root);
      stores.push(recovered);
      await recovered.initialize();
      await recovered.archiveCompletedHistory('vlt_history');
      expect(recovered.isReady()).toBe(true);
      expect((await recovered.snapshot()).sync_operations).toEqual([]);
      expect((await recovered.snapshot()).operation_history_by_vault!.vlt_history).toMatchObject({ generation: 1, pending_batch: null });
      expect(await recovered.exportOperationHistory('vlt_history')).toEqual(expected);
      expect(await recovered.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 2 });
      for (const row of expected) expect((await recovered.findArchivedAttempt('vlt_history', 'dev_history', row.prepared_manifest!.attempt_id as string))?.row).toEqual(row);
      await recovered.close();
    }
  });

  it.each(['second-insert', 'proof', 'meta', 'commit-before', 'post-commit-sync'] as const)(
    'SQLite transaction internal %s failure preserves atomic rows and proof', async (boundary) => {
      const { root, store } = await fixture();
      await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'first', attempt_hash: 'first-hash' });
      await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'second', attempt_hash: 'second-hash', proposal_base: null });
      const expected = await store.exportOperationHistory('vlt_history');
      const history = (store as unknown as { histories: Map<string, OperationHistoryStore> }).histories.get('vlt_history')!;
      const internals = history as unknown as { db: DatabaseSync; syncFile(): void };
      const prepare = internals.db.prepare.bind(internals.db);
      const exec = internals.db.exec.bind(internals.db);
      let inserts = 0;
      let faults = 0;
      const fail = () => { faults++; throw new Error(`injected ${boundary}`); };
      vi.spyOn(internals.db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql);
        if (sql.startsWith('INSERT INTO operations') || sql.startsWith('INSERT INTO batches') || sql.startsWith('UPDATE ledger_meta')) {
          const run = statement.run.bind(statement);
          vi.spyOn(statement, 'run').mockImplementation((...args) => {
            if (sql.startsWith('INSERT INTO operations') && ++inserts === 2 && boundary === 'second-insert' ||
                sql.startsWith('INSERT INTO batches') && boundary === 'proof' ||
                sql.startsWith('UPDATE ledger_meta') && boundary === 'meta') fail();
            return run(...args);
          });
        }
        return statement;
      });
      vi.spyOn(internals.db, 'exec').mockImplementation((sql) => {
        if (sql === 'COMMIT' && boundary === 'commit-before') fail();
        return exec(sql);
      });
      if (boundary === 'post-commit-sync') vi.spyOn(internals, 'syncFile').mockImplementationOnce(fail);
      await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow(`injected ${boundary}`);
      expect(faults).toBe(1);
      expect(inserts).toBe(2);
      expect(store.isReady()).toBe(false);
      await expect(store.mutate(() => {})).rejects.toBeInstanceOf(MetadataPublicationError);
      vi.restoreAllMocks();
      const committed = boundary === 'post-commit-sync';
      expect(internals.db.prepare('SELECT COUNT(*) AS n FROM operations').get()?.n).toBe(committed ? 2 : 0);
      expect(internals.db.prepare('SELECT COUNT(*) AS n FROM batches').get()?.n).toBe(committed ? 1 : 0);
      expect(internals.db.prepare('SELECT operation_type,status,count FROM operation_counts').all()).toEqual(
        committed ? [{ operation_type: 'device_push', status: 'aborted', count: 2 }] : []
      );
      expect(internals.db.prepare('SELECT generation,max_sequence FROM ledger_meta').get()).toEqual({ generation: committed ? 1 : 0, max_sequence: committed ? 2 : 0 });
      const persisted = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
      expect(persisted.sync_operations).toEqual(expected);
      const batch = persisted.operation_history_by_vault.vlt_history.pending_batch;
      expect(batch).toMatchObject({ parent_generation: 0, target_generation: 1 });
      expect(history.hasBatch(batch)).toBe(committed);
      await store.close();
      await restartAndCheck(root, expected);
    }
  );

  it('recovers a ledger-committed handoff after the final hot-file publication fails', async () => {
    let failOnCall = 0;
    let fsyncCalls = 0;
    const { root, store } = await fixture({
      fsyncFile: async (path) => {
        fsyncCalls += 1;
        if (failOnCall !== 0 && fsyncCalls === failOnCall) throw new Error('injected final metadata fsync failure');
        const { open } = await import('node:fs/promises');
        const file = await open(path, 'r');
        try { await file.sync(); } finally { await file.close(); }
      }
    });
    const operation = await addTerminalOperation(store, {
      target_commit: 'd'.repeat(40), attempt_id: 'attempt-recover', attempt_hash: 'hash-recover'
    });
    failOnCall = fsyncCalls + 2;

    await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow('injected final metadata fsync failure');
    expect(store.isReady()).toBe(false);
    await store.close();

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await restarted.initialize();
    expect((await restarted.snapshot()).sync_operations).toEqual([]);
    expect((await restarted.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-recover'))?.row.operation_id).toBe(operation.operation_id);
    expect(await restarted.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 1 });
    await restarted.close();
    const twiceRestarted = new MetadataStore(root);
    stores.push(twiceRestarted);
    await twiceRestarted.initialize();
    expect((await twiceRestarted.findArchivedAttempt('vlt_history', 'dev_history', 'attempt-recover'))?.row.operation_id).toBe(operation.operation_id);
    expect(await twiceRestarted.operationHistoryCounts('vlt_history')).toEqual({ 'device_push:aborted': 1 });
  });

  it.each(['before', 'after'] as const)('recovers an interrupted SQLite commit on the %s-commit boundary', async (boundary) => {
    const { root, store } = await fixture();
    const operation = await addTerminalOperation(store, {
      target_commit: 'f'.repeat(40), attempt_id: `attempt-${boundary}`, attempt_hash: `hash-${boundary}`
    });
    const history = (store as unknown as { histories: Map<string, { commitBatch(batch: unknown): void }> }).histories.get('vlt_history')!;
    const commit = history.commitBatch.bind(history);
    vi.spyOn(history, 'commitBatch').mockImplementationOnce((batch) => {
      if (boundary === 'after') commit(batch);
      throw new Error(`injected ${boundary}-commit failure`);
    });

    await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow(`injected ${boundary}-commit failure`);
    await store.close();
    vi.restoreAllMocks();

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await restarted.initialize();
    expect((await restarted.snapshot()).sync_operations).toEqual([]);
    expect((await restarted.findArchivedAttempt('vlt_history', 'dev_history', `attempt-${boundary}`))?.row.operation_id).toBe(operation.operation_id);
  });

  it.each([
    'missing-source', 'nonterminal-source', 'reordered', 'duplicate', 'wrong-vault', 'wrong-ledger',
    'nonconsecutive', 'wrong-sequence', 'different-selection'
  ] as const)('valid ledger rejects a wrong %s handoff descriptor without removing evidence', async (fault) => {
    const { root, store } = await fixture();
    await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'first', attempt_hash: 'first-hash' });
    await addTerminalOperation(store, { target_commit: 'c'.repeat(40), attempt_id: 'second', attempt_hash: 'second-hash' });
    await addPendingMerge(store);
    const commit = OperationHistoryStore.prototype.commitBatch;
    vi.spyOn(OperationHistoryStore.prototype, 'commitBatch').mockImplementationOnce(function (this: OperationHistoryStore, batch) {
      commit.call(this, batch);
      throw new Error('capture target descriptor');
    });
    await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow('capture target descriptor');
    await store.close();
    vi.restoreAllMocks();
    const path = join(root, 'metadata', 'phase1.json');
    const db = JSON.parse(await readFile(path, 'utf8'));
    const state = db.operation_history_by_vault.vlt_history;
    const batch = state.pending_batch;
    const rowEntry = (row: typeof db.sync_operations[number]) => {
      const canonical = OperationHistoryStore.canonical(row);
      return { operation_id: row.operation_id, sequence: row.operation_sequence, canonical: canonical.text, sha256: canonical.sha256 };
    };
    expect(batch.rows).toHaveLength(2);
    if (fault === 'missing-source') db.sync_operations.shift();
    if (fault === 'nonterminal-source') {
      db.sync_operations[0].status = 'prepared';
      batch.rows[0] = rowEntry(db.sync_operations[0]);
    }
    if (fault === 'reordered') batch.rows.reverse();
    if (fault === 'duplicate') batch.rows[1] = structuredClone(batch.rows[0]);
    if (fault === 'wrong-vault') batch.vault_id = 'vlt_wrong';
    if (fault === 'wrong-ledger') batch.ledger_id = 'hist_wrong';
    if (fault === 'nonconsecutive') batch.target_generation++;
    if (fault === 'wrong-sequence') batch.rows[0].sequence++;
    if (fault === 'different-selection') batch.rows[1] = rowEntry(db.sync_operations[2]);
    const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
    OperationHistoryStore.verifyOnDisk(directory, 'vlt_history', state.ledger_id, 1, state.next_sequence);
    const verify = await OperationHistoryStore.open(directory, 'vlt_history', state.ledger_id, false);
    verify.close();
    await writeFile(path, `${JSON.stringify(db)}\n`);
    const beforeJson = await readFile(path, 'utf8');
    const beforeLedger = createHash('sha256').update(await readFile(join(directory, 'history.sqlite'))).digest('hex');
    for (let restart = 0; restart < 2; restart++) {
      const recovered = new MetadataStore(root);
      stores.push(recovered);
      const expected = fault === 'different-selection' ? 'Operation history archive proof is missing.'
        : ['wrong-vault', 'wrong-ledger', 'nonconsecutive'].includes(fault) ? 'Operation history handoff descriptor is inconsistent.'
        : 'Operation history source row does not match its handoff descriptor.';
      await expect(recovered.initialize()).rejects.toThrow(expected);
      expect(recovered.isReady()).toBe(false);
      await expect(recovered.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
      expect(await readFile(path, 'utf8')).toBe(beforeJson);
      expect(createHash('sha256').update(await readFile(join(directory, 'history.sqlite'))).digest('hex')).toBe(beforeLedger);
      await recovered.close();
    }
  });

  it.each(['behind', 'beyond-target', 'unrelated-one-ahead'] as const)(
    'valid whole-ledger %s checkpoint refuses pending handoff without evidence loss', async (fault) => {
      const { root, store } = await fixture();
      const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
      const ledgerPath = join(directory, 'history.sqlite');
      const jsonPath = join(root, 'metadata', 'phase1.json');
      const initialState = (await store.snapshot()).operation_history_by_vault!.vlt_history!;
      const initialLedger = await readFile(ledgerPath);
      await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'first', attempt_hash: 'first-hash' });
      await store.archiveCompletedHistory('vlt_history');
      const parentLedger = await readFile(ledgerPath);
      await addTerminalOperation(store, { target_commit: 'b'.repeat(40), attempt_id: 'second', attempt_hash: 'second-hash' });
      const future = await store.mutate((db) => store.startOperation(db, {
        vault_id: 'vlt_history', device_id: 'dev_history', operation_type: 'device_push',
        expected_refs: {}, target_refs: {}, target_commit: 'c'.repeat(40)
      }));
      const beforeDescriptor = await readFile(jsonPath);
      vi.spyOn(OperationHistoryStore.prototype, 'commitBatch').mockImplementationOnce(() => { throw new Error('capture parent descriptor'); });
      await expect(store.archiveCompletedHistory('vlt_history')).rejects.toThrow('capture parent descriptor');
      await store.close();
      vi.restoreAllMocks();
      const pendingJson = await readFile(jsonPath);
      let checkpoint = { bytes: initialLedger, state: initialState };
      if (fault !== 'behind') {
        if (fault === 'unrelated-one-ahead') {
          await writeFile(jsonPath, beforeDescriptor);
          await writeFile(ledgerPath, parentLedger);
        }
        const branch = new MetadataStore(root);
        stores.push(branch);
        await branch.initialize();
        await branch.archiveCompletedHistory('vlt_history');
        if (fault === 'beyond-target') {
          await branch.mutate((db) => { db.sync_operations.find((row) => row.operation_id === future.operation_id)!.status = 'aborted'; });
          await branch.archiveCompletedHistory('vlt_history');
        }
        checkpoint = { bytes: await readFile(ledgerPath), state: (await branch.snapshot()).operation_history_by_vault!.vlt_history! };
        await branch.close();
      }
      await writeFile(jsonPath, pendingJson);
      await writeFile(ledgerPath, checkpoint.bytes);
      OperationHistoryStore.verifyOnDisk(directory, 'vlt_history', checkpoint.state.ledger_id, checkpoint.state.generation, checkpoint.state.next_sequence);
      const verify = await OperationHistoryStore.open(directory, 'vlt_history', checkpoint.state.ledger_id, false);
      verify.close();
      const before = createHash('sha256').update(await readFile(ledgerPath)).digest('hex');
      for (let restart = 0; restart < 2; restart++) {
        const recovered = new MetadataStore(root);
        stores.push(recovered);
        await expect(recovered.initialize()).rejects.toThrow('Operation history archive proof is missing.');
        expect(recovered.isReady()).toBe(false);
        expect(await readFile(jsonPath)).toEqual(pendingJson);
        expect(createHash('sha256').update(await readFile(ledgerPath)).digest('hex')).toBe(before);
        await recovered.close();
      }
    }
  );

  it.each(['unknown-recovery-evidence', 'history.sqlite-wal', 'history.sqlite-shm'])(
    'active history refuses unsupported %s residue unchanged', async (name) => {
      const { root, store } = await fixture();
      await addTerminalOperation(store, { target_commit: 'a'.repeat(40), attempt_id: 'first', attempt_hash: 'first-hash' });
      await store.archiveCompletedHistory('vlt_history');
      await store.close();
      const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
      const residue = join(directory, name);
      await writeFile(residue, 'preserve unknown bytes', { mode: 0o600 });
      const before = await Promise.all((await readdir(directory)).sort().map(async (name) => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')]));
      for (let restart = 0; restart < 2; restart++) {
        const recovered = new MetadataStore(root);
        stores.push(recovered);
        await expect(recovered.initialize()).rejects.toThrow('Unexpected operation history residue.');
        expect(recovered.isReady()).toBe(false);
        expect(await Promise.all((await readdir(directory)).sort().map(async (name) => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')]))).toEqual(before);
        await recovered.close();
      }
    }
  );

  it('fails closed when an interrupted handoff source row differs from its descriptor', async () => {
    const { root, store } = await fixture();
    await addTerminalOperation(store, { target_commit: 'e'.repeat(40), attempt_id: 'attempt-source', attempt_hash: 'hash-source' });
    await store.mutate((db) => {
      const state = db.operation_history_by_vault!['vlt_history']!;
      const row = db.sync_operations[0]!;
      state.pending_batch = {
        vault_id: 'vlt_history', ledger_id: state.ledger_id, batch_id: 'batch_corrupt',
        parent_generation: state.generation, target_generation: state.generation + 1,
        rows: [{
          operation_id: row.operation_id, sequence: row.operation_sequence!, canonical: JSON.stringify(row),
          sha256: '0'.repeat(64)
        }]
      };
    });
    await store.close();

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('Operation history source row does not match its handoff descriptor.');
  });

  it('fails readiness and blocks metadata access when an open ledger path disappears', async () => {
    const { root, store } = await fixture();
    const ledgerPath = join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite');
    await rename(ledgerPath, `${ledgerPath}.missing`);
    expect(store.isReady()).toBe(false);
    await expect(store.snapshot()).rejects.toBeInstanceOf(MetadataPublicationError);
  });

  it('fails closed when an acknowledged ledger is ahead without a handoff descriptor', async () => {
    const { root, store } = await fixture();
    await addTerminalOperation(store, { target_commit: '9'.repeat(40), attempt_id: 'attempt-ahead', attempt_hash: 'hash-ahead' });
    await store.archiveCompletedHistory('vlt_history');
    await store.close();
    const ledger = new DatabaseSync(join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite'));
    ledger.exec('UPDATE ledger_meta SET generation=generation+1 WHERE singleton=1');
    ledger.close();

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('Operation history generation or sequence mismatch.');
  });

  it('fails closed when the acknowledged ledger belongs to another vault', async () => {
    const { root, store } = await fixture();
    await store.close();
    const ledger = new DatabaseSync(join(root, 'metadata', 'operation-history', 'vlt_history', 'history.sqlite'));
    ledger.prepare('UPDATE ledger_meta SET vault_id=? WHERE singleton=1').run('vlt_foreign');
    ledger.close();

    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('Operation history ledger identity mismatch.');
  });

  it('fails closed when an acknowledged ledger is missing', async () => {
    const { root, store } = await fixture();
    await store.close();
    await rm(join(root, 'metadata', 'operation-history', 'vlt_history'), { recursive: true, force: true });
    const restarted = new MetadataStore(root);
    stores.push(restarted);
    await expect(restarted.initialize()).rejects.toThrow('Acknowledged operation history ledger is missing.');
  });
});
