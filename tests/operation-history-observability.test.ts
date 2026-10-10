import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { MetadataStore, type MetadataDb, type SyncOperationRow } from '../src/server/metadataStore.js';
import { OperationHistoryStore } from '../src/server/operationHistoryStore.js';
import { OperationalLog } from '../src/server/operationalLog.js';
import { commit, historyCheckpointFixture, manifest, multipart } from './helpers/historyCheckpointFixture.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];
const releases: Array<() => void> = [];
const privatePayload = 'synthetic-private-history-body';
const privatePath = 'private-history-note.md';
type Fixture = Awaited<ReturnType<typeof historyCheckpointFixture>>;

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: Parameters<typeof createObtsServer>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obts-history-observation-'));
  roots.push(root);
  const f = await historyCheckpointFixture(root);
  await f.server.app.close();
  f.server = await createObtsServer({ dataDir: root, sessionSecret: 'checkpoint-test-secret' }, options);
  servers.push(f.server);
  const session = await f.server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {
    username: 'owner', password: 'test-password-with-entropy'
  } });
  expect(session.statusCode).toBe(200);
  return { ...f, root, cookie: session.headers['set-cookie'], csrf: session.json().csrf_token as string };
}

async function addRows(f: Fixture, count = 3) {
  return await f.server.store.mutate((db) => Array.from({ length: count }, (_, index) => {
    const row = f.server.store.startOperation(db, {
      vault_id: f.auth.vault.vault_id, device_id: f.auth.device.device_id,
      operation_type: index % 2 ? 'conflict_create' : 'device_push', expected_refs: {}, target_refs: {}, target_commit: f.m0,
      ...(index % 2 ? { proposal_base: null } : {})
    });
    row.status = index % 2 ? 'committed' : 'aborted';
    row.prepared_manifest = { attempt_id: `historical_attempt_${index}`, attempt_hash: `hash_${index}`,
      rename_pairs: [{ source_path: privatePath, destination_path: 'renamed-history-note.md' }], payload: privatePayload };
    row.result = { outcome: row.status };
    return row;
  }));
}

function counts(rows: SyncOperationRow[]) {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.operation_type}:${row.status}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function publicationGate() {
  const entered = deferred();
  const gate = deferred();
  releases.push(gate.resolve);
  let armed = false;
  let sawDescriptor = false;
  return {
    entered: entered.promise, release: gate.resolve, arm: () => { armed = true; },
    adapter: { writeFile: async (path: string, data: string) => {
      const db = JSON.parse(data) as MetadataDb;
      const pending = Object.values(db.operation_history_by_vault ?? {}).some((state) => state.pending_batch !== null);
      if (armed && pending) sawDescriptor = true;
      if (armed && sawDescriptor && !pending) {
        armed = false;
        entered.resolve();
        await gate.promise;
      }
      await writeFile(path, data, { mode: 0o600 });
    } }
  };
}

async function diagnostics(f: Awaited<ReturnType<typeof fixture>>) {
  return await f.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${f.auth.vault.vault_id}/diagnostics/export`, headers: { cookie: f.cookie } });
}

function ledgerPath(f: Awaited<ReturnType<typeof fixture>>) {
  return join(f.root, 'metadata', 'operation-history', f.auth.vault.vault_id, 'history.sqlite');
}

it('diagnostics count unique hot and cold operations across a real committed archive publication without disclosing payloads', async () => {
  const gate = publicationGate();
  const logs: string[] = [];
  const f = await fixture({ metadataPersistence: gate.adapter, operationalLog: new OperationalLog('debug', (line) => { logs.push(line); }) });
  const vaultId = f.auth.vault.vault_id;
  const first = await addRows(f);
  expect((await diagnostics(f)).json().operation_counts).toEqual(counts(first));
  await f.server.sync.archiveStartupHistory(vaultId);
  expect((await f.server.store.snapshot()).sync_operations).toEqual([]);
  expect((await diagnostics(f)).json().operation_counts).toEqual(counts(first));
  const second = await addRows(f, 2);
  expect((await diagnostics(f)).json().operation_counts).toEqual(counts([...first, ...second]));
  gate.arm();
  const archiving = f.server.sync.archiveStartupHistory(vaultId);
  await gate.entered;
  const persisted = JSON.parse(await readFile(join(f.root, 'metadata', 'phase1.json'), 'utf8')) as MetadataDb;
  expect(persisted.sync_operations).toEqual(second);
  expect(persisted.operation_history_by_vault![vaultId]!.pending_batch!.rows).toHaveLength(2);
  const ledger = new DatabaseSync(ledgerPath(f), { readOnly: true });
  try { expect(ledger.prepare('SELECT count(*) AS count FROM operations').get()!.count).toBe(5); }
  finally { ledger.close(); }
  const heldReady = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
  expect(heldReady.statusCode).toBe(503);
  expect(heldReady.json()).toMatchObject({ detail: 'metadata lifecycle durability is unavailable', checks: { metadata_store: false } });
  const requested = deferred();
  const authenticate = f.server.auth.authenticateSession.bind(f.server.auth);
  vi.spyOn(f.server.auth, 'authenticateSession').mockImplementation(async (...args) => {
    requested.resolve();
    return await authenticate(...args);
  });
  let observed = false;
  const concurrent = diagnostics(f).then((response) => { observed = true; return response; });
  try {
    await requested.promise;
    await nextTurn();
    expect(observed).toBe(false);
  } finally { gate.release(); await archiving; }
  const response = await concurrent;
  expect(response.statusCode).toBe(200);
  expect((await f.server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  expect(response.json().operation_counts).toEqual(counts([...first, ...second]));
  expect(await f.server.store.exportOperationHistory(vaultId)).toEqual([...first, ...second]);
  for (const url of [`/api/v1/vaults/${vaultId}/history/export`, `/api/v1/vaults/${vaultId}/operation-history`]) {
    const unavailable = await f.server.app.inject({ method: 'GET', url, headers: { cookie: f.cookie } });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.body).not.toContain(privatePayload);
  }
  for (const secret of [privatePayload, privatePath, f.token]) {
    expect(response.body).not.toContain(secret);
    expect(logs.join('')).not.toContain(secret);
  }
});

it('server shutdown drains a real sync archive publication, closes ledger handles and restarts with exact evidence', async () => {
  const gate = publicationGate();
  const f = await fixture({ metadataPersistence: gate.adapter });
  const first = await addRows(f);
  await f.server.sync.archiveStartupHistory(f.auth.vault.vault_id);
  const close = vi.spyOn(OperationHistoryStore.prototype, 'close');
  const closingStore = deferred();
  const closeStore = f.server.store.close.bind(f.server.store);
  vi.spyOn(f.server.store, 'close').mockImplementation(async () => {
    closingStore.resolve();
    await closeStore();
  });
  const target = await commit(f, f.m0, { 'new.md': 'shutdown content' });
  const request = await manifest(f, target, f.m0, 'shutdown_attempt');
  gate.arm();
  const pushing = f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
  await gate.entered;
  const disk = JSON.parse(await readFile(join(f.root, 'metadata', 'phase1.json'), 'utf8')) as MetadataDb;
  const expected = [...first, ...disk.sync_operations].sort((a, b) => a.operation_sequence! - b.operation_sequence!);
  expect(disk.operation_history_by_vault![f.auth.vault.vault_id]!.pending_batch).not.toBeNull();
  let closed = false;
  const closing = f.server.app.close().then(() => { closed = true; });
  try {
    await closingStore.promise;
    await nextTurn();
    expect(closed).toBe(false);
    expect(close).not.toHaveBeenCalled();
  } finally { gate.release(); }
  expect((await pushing).status).toBe('merged');
  await closing;
  expect(close).toHaveBeenCalledTimes(1);
  f.server = await createObtsServer({ dataDir: f.root, sessionSecret: 'checkpoint-test-secret' });
  servers.push(f.server);
  expect((await f.server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  expect(await f.server.store.exportOperationHistory(f.auth.vault.vault_id)).toEqual(expected);
});

it('missing acknowledged history blocks real readiness, diagnostics, history reads and push admission without unverified fallback', async () => {
  const logs: string[] = [];
  const f = await fixture({ operationalLog: new OperationalLog('debug', (line) => { logs.push(line); }) });
  const rows = await addRows(f);
  const vaultId = f.auth.vault.vault_id;
  await f.server.sync.archiveStartupHistory(vaultId);
  const target = await commit(f, f.m0, { 'outage.md': 'outage fixture' });
  const request = await manifest(f, target, f.m0, 'outage_attempt');
  const metadata = await readFile(join(f.root, 'metadata', 'phase1.json'));
  const saved = `${ledgerPath(f)}.saved`;
  await rename(ledgerPath(f), saved);
  const ready = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().checks.metadata_store).toBe(false);
  const diagnostic = await diagnostics(f);
  const history = await f.server.app.inject({ method: 'POST', url: `/api/v1/vaults/${vaultId}/history/query`, headers: { cookie: f.cookie }, payload: { path: 'old.md' } });
  const pushed = await multipart(f, request);
  expect(diagnostic.statusCode).toBe(500);
  expect(history.statusCode).toBe(500);
  expect(pushed.status).toBe(500);
  expect(diagnostic.json()).not.toHaveProperty('operation_counts');
  expect(history.json()).not.toHaveProperty('versions');
  await expect(f.server.store.exportOperationHistory(vaultId)).rejects.toThrow();
  expect(await f.server.git.getRef(vaultId, f.auth.device.device_ref)).toBe(f.m0);
  expect(await f.server.git.getRef(vaultId, 'refs/heads/main')).toBe(f.m0);
  expect(await readFile(join(f.root, 'metadata', 'phase1.json'))).toEqual(metadata);
  for (const secret of [privatePayload, privatePath, f.token]) {
    expect([ready.body, diagnostic.body, history.body, JSON.stringify(pushed), ...logs].join('')).not.toContain(secret);
  }
  await f.server.app.close();
  await rename(saved, ledgerPath(f));
  f.server = await createObtsServer({ dataDir: f.root, sessionSecret: 'checkpoint-test-secret' });
  servers.push(f.server);
  expect((await f.server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  expect(await f.server.store.exportOperationHistory(vaultId)).toEqual(rows);
});

it('redacts malformed historical JSON on real push failure and keeps readiness latched after byte repair', async () => {
  const logs: string[] = [];
  const f = await fixture({ operationalLog: new OperationalLog('debug', (line) => { logs.push(line); }) });
  const rows = await addRows(f);
  const vaultId = f.auth.vault.vault_id;
  await f.server.sync.archiveStartupHistory(vaultId);
  const target = await commit(f, f.m0, { 'unpublished.md': 'synthetic proposal' });
  const request = await manifest(f, target, f.m0, 'historical_attempt_0');
  const history = (f.server.store as unknown as { histories: Map<string, OperationHistoryStore> }).histories.get(vaultId)!;
  const ledger = (history as unknown as { db: DatabaseSync }).db;
  const original = ledger.prepare('SELECT canonical_json FROM operations WHERE operation_id=?').get(rows[0]!.operation_id)!.canonical_json!;
  const malformed = 'synthetic-confidential-malformed-json';
  ledger.prepare('UPDATE operations SET canonical_json=? WHERE operation_id=?').run(malformed, rows[0]!.operation_id);
  const response = await multipart(f, request);
  expect(response.status).toBe(500);
  expect(f.server.store.isDurabilityUncertain()).toBe(true);
  ledger.prepare('UPDATE operations SET canonical_json=? WHERE operation_id=?').run(original, rows[0]!.operation_id);
  const ready = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
  expect(ready.statusCode).toBe(503);
  expect(ready.json().checks.metadata_store).toBe(false);
  const diagnostic = await diagnostics(f);
  expect(diagnostic.statusCode).toBe(500);
  expect(await f.server.git.getRef(vaultId, f.auth.device.device_ref)).toBe(f.m0);
  expect(await f.server.git.getRef(vaultId, 'refs/heads/main')).toBe(f.m0);
  for (const value of [malformed, 'synthetic-confidential', privatePayload, privatePath, f.token]) {
    expect([JSON.stringify(response), ready.body, diagnostic.body, ...logs].join('')).not.toContain(value);
  }
  await f.server.app.close();
  f.server = await createObtsServer({ dataDir: f.root, sessionSecret: 'checkpoint-test-secret' });
  servers.push(f.server);
  expect((await f.server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  expect(await f.server.store.exportOperationHistory(vaultId)).toEqual(rows);
});

it('vault deletion waits for active sync archival ownership before erasure and cannot resurrect populated history', async () => {
  const gate = publicationGate();
  const f = await fixture({ metadataPersistence: gate.adapter });
  const vaultId = f.auth.vault.vault_id;
  await addRows(f);
  await f.server.sync.archiveStartupHistory(vaultId);
  const target = await commit(f, f.m0, { 'delete.md': privatePayload });
  const request = await manifest(f, target, f.m0, 'deletion_attempt');
  const settled = deferred();
  const releaseOwner = deferred();
  releases.push(releaseOwner.resolve);
  const archive = f.server.store.archiveCompletedHistory.bind(f.server.store);
  vi.spyOn(f.server.store, 'archiveCompletedHistory').mockImplementation(async (...args) => {
    await archive(...args);
    settled.resolve();
    await releaseOwner.promise;
  });
  gate.arm();
  const pushing = f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
  await gate.entered;
  let deletionAccepted = false;
  const deleting = f.server.lifecycle.beginDeletion({ ownerUserId: f.auth.user.user_id, vaultId, confirmation: `DELETE ${vaultId}` })
    .then((result) => { deletionAccepted = true; return result; });
  try {
    await nextTurn();
    expect(deletionAccepted).toBe(false);
    await access(ledgerPath(f));
  } finally { gate.release(); }
  await settled.promise;
  expect(await deleting).toMatchObject({ status: 'deleting', completed_at: null });
  const draining = await f.server.store.snapshot();
  expect(draining.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
  expect(draining.deletion_receipts).toEqual([]);
  const ledgerBytes = await readFile(ledgerPath(f));
  expect(ledgerBytes.includes(Buffer.from(privatePayload))).toBe(true);
  const ledgerId = draining.operation_history_by_vault![vaultId]!.ledger_id;
  const directory = join(f.root, 'metadata', 'operation-history', vaultId);
  const scratch = join(directory, `.recovery-${createHash('sha256').update(JSON.stringify([vaultId, ledgerId])).digest('hex')}`);
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(join(scratch, 'history.sqlite'), ledgerBytes, { mode: 0o600 });
  await writeFile(join(scratch, 'history.sqlite-journal'), privatePayload, { mode: 0o600 });
  await writeFile(join(directory, 'history.sqlite-journal'), privatePayload, { mode: 0o600 });
  await access(f.server.git.repoPath(vaultId));
  await expect(f.server.lifecycle.acquireAdmission(vaultId)).rejects.toMatchObject({ code: 'vault_deleting' });
  const denied = await diagnostics(f);
  expect(denied.statusCode).toBe(409);
  releaseOwner.resolve();
  expect((await pushing).status).toBe('merged');
  await vi.waitFor(async () => {
    expect((await f.server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(true);
  });
  const final = await f.server.store.snapshot();
  expect(final.sync_operations.filter((row) => row.vault_id === vaultId)).toEqual([]);
  expect(final.operation_history_by_vault?.[vaultId]).toBeUndefined();
  expect(JSON.stringify(final)).not.toContain(privatePayload);
  expect(Object.keys(final.deletion_receipts[0]!).sort()).toEqual(['completed_at', 'owner_user_id', 'requested_at', 'status', 'vault_id']);
  expect(final.deletion_receipts[0]!.status).toBe('deleted');
  await expect(access(join(f.root, 'metadata', 'operation-history', vaultId))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(f.server.git.repoPath(vaultId))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.server.app.close();
  f.server = await createObtsServer({ dataDir: f.root, sessionSecret: 'checkpoint-test-secret' });
  servers.push(f.server);
  expect((await f.server.store.snapshot()).deletion_receipts).toEqual(final.deletion_receipts);
  expect((await f.server.store.snapshot()).vaults).toEqual([]);
  await expect(access(join(f.root, 'metadata', 'operation-history', vaultId))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('populated server startup and real pending merge do not snapshot per old push or hydrate cold history for routine consumers', async () => {
  const startupSnapshots: number[] = [];
  const consumerSnapshots: number[] = [];
  const consumerQueries: number[] = [];
  for (const size of [8, 512]) {
    const f = await fixture();
    const vaultId = f.auth.vault.vault_id;
    await addRows(f, size);
    await f.server.sync.archiveStartupHistory(vaultId);
    const target = await commit(f, f.m0, { 'pending.md': 'pending work remains hot' });
    await f.server.git.updateRef(vaultId, f.auth.device.device_ref, target, f.m0);
    const pending = await f.server.store.mutate((db) => {
      db.devices.find((device) => device.device_id === f.auth.device.device_id)!.device_ref_head = target;
      const row = f.server.store.startOperation(db, { vault_id: vaultId, device_id: f.auth.device.device_id,
        operation_type: 'device_push', expected_refs: { [f.auth.device.device_ref]: f.m0 },
        target_refs: { [f.auth.device.device_ref]: target }, target_commit: target, proposal_base: f.m0 });
      row.status = 'committed';
      row.prepared_manifest = { attempt_id: 'pending_attempt', attempt_hash: 'pending_hash' };
      return row;
    });
    await f.server.sync.archiveStartupHistory(vaultId);
    expect((await f.server.store.snapshot()).sync_operations).toEqual([pending]);
    await f.server.app.close();
    const snapshot = vi.spyOn(MetadataStore.prototype, 'snapshot');
    const exportRows = vi.spyOn(OperationHistoryStore.prototype, 'exportRows');
    const exportHistory = vi.spyOn(MetadataStore.prototype, 'exportOperationHistory');
    const select = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const materializedQueries: string[] = [];
    const all = StatementSync.prototype.all;
    const materialize = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...args: unknown[]) {
      materializedQueries.push(this.sourceSQL);
      return Reflect.apply(all, this, args);
    });
    f.server = await createObtsServer({ dataDir: f.root, sessionSecret: 'checkpoint-test-secret' });
    servers.push(f.server);
    startupSnapshots.push(snapshot.mock.calls.length);
    expect(exportRows).not.toHaveBeenCalled();
    expect(exportHistory).not.toHaveBeenCalled();
    expect(await f.server.git.getRef(vaultId, 'refs/heads/main')).toBe(target);
    expect((await f.server.store.snapshot()).sync_operations).toEqual([]);
    snapshot.mockClear();
    select.mockClear();
    const request = await manifest(f, target, f.m0, `new_retry_${size}`);
    expect((await multipart(f, request)).status).toBe(200);
    await f.server.store.mutate((db) => { db.vaults[0]!.display_name = 'Routine mutation'; });
    expect((await diagnostics(f)).statusCode).toBe(200);
    consumerSnapshots.push(snapshot.mock.calls.length);
    expect(exportRows).not.toHaveBeenCalled();
    expect(exportHistory).not.toHaveBeenCalled();
    const sql = select.mock.calls.map(([query]) => query);
    const operationReads = sql.filter((query) => /\bSELECT\b.*\bFROM operations\b/iu.test(query));
    expect(operationReads.length).toBeGreaterThan(0);
    for (const query of operationReads) {
      expect(query).toMatch(/WHERE operation_id=\?|WHERE device_id=\?.*LIMIT 1|^SELECT MAX\(sequence\) AS sequence FROM operations$/u);
    }
    expect(sql.some((query) => /attempt_id=\?/u.test(query))).toBe(true);
    consumerQueries.push(sql.length);
    expect(materializedQueries.filter((query) => /\bFROM operations\b/iu.test(query))).toEqual([]);
    materialize.mockRestore();
    snapshot.mockRestore();
    exportRows.mockRestore();
    exportHistory.mockRestore();
    select.mockRestore();
  }
  expect(startupSnapshots[1]).toBeLessThanOrEqual(startupSnapshots[0]! + 2);
  expect(consumerSnapshots[1]).toBeLessThanOrEqual(consumerSnapshots[0]! + 2);
  expect(consumerQueries[1]).toBeLessThanOrEqual(consumerQueries[0]! + 2);
});
