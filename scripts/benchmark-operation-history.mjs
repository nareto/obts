#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createObtsServer } from '../dist/src/server/app.js';
import { hashToken } from '../dist/src/server/authService.js';
import { MetadataStore } from '../dist/src/server/metadataStore.js';
import { API_VERSION } from '../dist/src/shared/types.js';
import { loadLegacyMetadataStore } from './benchmark-operation-history-baseline.mjs';

const args = new Map();
const allowed = new Set(['sizes', 'runs', 'dir', 'target-avg-bytes', 'baseline-ref']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/u, '');
  if (!allowed.has(key) || !process.argv[i + 1] || args.has(key)) throw new Error('Invalid benchmark arguments.');
  args.set(key, process.argv[i + 1]);
}
const sizes = (args.get('sizes') ?? '0,2000,8000,32000').split(',').map(Number);
const runs = Number(args.get('runs') ?? 5);
const parentDir = args.get('dir') ?? tmpdir();
const targetAvgBytes = Number(args.get('target-avg-bytes') ?? 1621);
if (!args.get('baseline-ref') || sizes.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(runs) || runs < 5 || !Number.isSafeInteger(targetAvgBytes) || targetAvgBytes < 0) {
  throw new Error('Use --baseline-ref REF, valid --sizes, --runs >= 5, and nonnegative --target-avg-bytes.');
}

let vaultId;
const devices = ['dev_BENCH0000000000000001', 'dev_BENCH0000000000000002', 'dev_BENCH0000000000000003'];
const hex = (seed, len = 40) => {
  let out = '';
  let x = (seed * 2654435761) >>> 0;
  while (out.length < len) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += x.toString(16).padStart(8, '0'); }
  return out.slice(0, len);
};
const timestamp = (i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 290_000).toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 1000) / 1000;
const elapsed = async (fn) => { const start = performance.now(); await fn(); return performance.now() - start; };
async function measure(fn) {
  const values = [];
  for (let i = 0; i < runs; i++) values.push(await elapsed(fn));
  return { median_ms: round(median(values)), samples_ms: values.map(round) };
}
const config = (root) => ({ dataDir: root, sessionSecret: 'synthetic-operation-history-benchmark-secret' });

async function commit(server, parent, writes, deletes = []) {
  const tree = await server.git.createTreeFromCommitWithChanges({ vaultId, sourceCommit: parent,
    writes: new Map(Object.entries(writes).map(([path, text]) => [path, Buffer.from(text)])), deletes });
  return await server.git.createMainCommitFromTree({ vaultId, tree, parentMain: parent,
    subject: 'Synthetic benchmark edit', body: '', actor: 'history-benchmark' });
}
async function setMain(server, target) {
  await server.git.updateRef(vaultId, 'refs/heads/main', target, await server.git.getRef(vaultId, 'refs/heads/main'));
  await server.store.mutate((db) => { db.vaults.find((v) => v.vault_id === vaultId).current_main = target; });
}
async function addDevice(server, id, base) {
  const token = `synthetic-benchmark-token-${id}`;
  const tokenHash = hashToken(token);
  const ref = `refs/obts/devices/${id}`;
  await server.git.updateRef(vaultId, ref, base, null);
  await server.store.mutate((db) => {
    const owner = db.users[0];
    db.devices.push({
      device_id: id, vault_id: vaultId, user_id: owner.user_id, device_name: id, device_ref: ref,
      device_ref_head: base, status: 'synced', last_applied_main: base,
      last_applied_event_seq: 0, last_applied_explicit_dirs: [], pending_applied_main: null,
      pending_applied_event_seq: 0, pending_applied_explicit_dirs: null, last_seen_at: null,
      last_successful_sync_at: null, local_status_label: null, local_error_code: null, local_queue_status: null,
      local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp(0), created_at: timestamp(0), revoked_at: null
    });
    db.tokens.push({ token_id: `tok_${id}`, kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
      user_id: owner.user_id, vault_id: vaultId, device_id: id, expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp(0) });
  });
  return { token, auth: await server.auth.authenticateDevice(`Bearer ${token}`, vaultId) };
}
async function request(server, device, base, target, attempt, source, destination, directory) {
  const pack = await server.git.exportPack(vaultId, target, base);
  const body = { schema_version: 2, base_main: base, base_event_seq: 0,
    intents: [{ op: 'create', path: directory, intent_id: 'dir_1_0_012345abcdef', generation: 0,
      provenance: 'local_v2', base_main: base, base_event_seq: 0, replaces_intent_id: null,
      recreated_after_delete: false, created_at: null }] };
  return { pack, manifest: {
    api_version: API_VERSION, plugin_version: '0.5.13', vault_id: vaultId, device_id: device.auth.device.device_id,
    expected_device_ref: base, target_commit: target, client_known_main: await server.git.getRef(vaultId, 'refs/heads/main'),
    packfile_sha256: sha256(pack), packfile_bytes: pack.length, base_commit: base, attempt_id: attempt,
    rename_pairs: [{ source_path: source, destination_path: destination }],
    directory_proposal: { ...body, proposal_id: `dirprop_${sha256(JSON.stringify([device.auth.device.device_id, target, body]))}` }
  } };
}
async function coldAdmission(server, saved) {
  const { manifest } = saved;
  const hot = await server.store.read((db) => db.sync_operations.filter((row) => row.prepared_manifest?.attempt_id === manifest.attempt_id));
  assert.equal(hot.length, 0, 'successful retry admission must be cold, not a hot hit');
  const found = await server.store.findArchivedAttempt(vaultId, manifest.device_id, manifest.attempt_id);
  assert.ok(found);
  assert.equal(found.row.target_commit, manifest.target_commit);
  assert.deepEqual(found.row.prepared_manifest.rename_pairs, manifest.rename_pairs);
  assert.deepEqual(found.row.prepared_manifest.directory_proposal, manifest.directory_proposal);
  return found.row.operation_id;
}
async function effects(server) {
  const db = await server.store.snapshot();
  return {
    main: await server.git.getRef(vaultId, 'refs/heads/main'),
    device_refs: await Promise.all(db.devices.map(async (d) => [d.device_id, await server.git.getRef(vaultId, d.device_ref)])),
    directories: db.directory_state_by_vault, results: db.directory_proposal_results,
    conflicts: db.conflicts, events: db.events, audit: db.audit_log
  };
}
async function assertWorkload(server, fixture, recovered = false) {
  assert.equal((await server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
  const { saved, conflictRequest, conflictResult, successfulMain, original, conflictMain, conflictTarget } = fixture;
  assert.equal(await coldAdmission(server, saved), fixture.coldId);
  assert.equal((await server.git.readBlobAtPath(vaultId, successfulMain, 'moved.md')).toString(), 'rename payload\n');
  assert.equal(await server.git.readBlobAtPathIfPresent(vaultId, successfulMain, 'source.md'), null);
  const db = await server.store.snapshot();
  assert.ok(db.directory_state_by_vault[vaultId].explicit_dirs.includes('AcceptedEmpty'));
  const conflict = db.conflicts.find((row) => row.conflict_id === conflictResult.conflict_id);
  assert.equal(conflict.status, 'open');
  assert.deepEqual(conflict.rename_pairs, conflictRequest.manifest.rename_pairs);
  assert.equal(await coldAdmission(server, conflictRequest), fixture.conflictColdId);
  const pending = db.sync_operations.filter((row) => row.prepared_manifest?.attempt_id === fixture.pendingRequest.manifest.attempt_id);
  assert.equal(pending.length, recovered ? 0 : 1);
  if (!recovered) {
    assert.equal(pending[0].status, 'committed');
    assert.equal(pending[0].operation_id, fixture.pendingId);
    assert.equal(pending[0].target_commit, fixture.pendingRequest.manifest.target_commit);
    assert.deepEqual(pending[0].prepared_manifest.directory_proposal, fixture.pendingRequest.manifest.directory_proposal);
    assert.deepEqual(pending[0].prepared_manifest.rename_pairs, fixture.pendingRequest.manifest.rename_pairs);
    assert.equal(await server.git.isAncestor(vaultId, pending[0].target_commit, fixture.conflictMain), false);
    assert.equal(await server.git.getRef(vaultId, fixture.pendingDevice.auth.device.device_ref), pending[0].target_commit);
  } else {
    assert.equal(await coldAdmission(server, fixture.pendingRequest), fixture.pendingId);
    const main = await server.git.getRef(vaultId, 'refs/heads/main');
    assert.equal((await server.git.readBlobAtPath(vaultId, main, 'pending-moved.md')).toString(), 'pending payload\n');
    assert.equal(await server.git.readBlobAtPathIfPresent(vaultId, main, 'pending-source.md'), null);
    assert.ok(db.directory_state_by_vault[vaultId].explicit_dirs.includes('PendingEmpty'));
  }
  assert.equal(await server.git.isAncestor(vaultId, conflictTarget, conflictMain), false);
  for (const [suffix, oid] of [['base', successfulMain], ['current', conflictMain], ['device', conflictTarget]]) {
    assert.equal(await server.git.getRef(vaultId, `refs/obts/conflicts/${conflict.conflict_id}/${suffix}`), oid);
  }
  assert.equal((await server.git.readBlobAtPath(vaultId, successfulMain, 'conflict.md')).toString(), original);
  assert.equal((await server.git.readBlobAtPath(vaultId, conflictMain, 'conflict.md')).toString(), original.replace('line 50', 'REMOTE line 50'));
  assert.equal(await server.git.readBlobAtPathIfPresent(vaultId, conflictTarget, 'conflict.md'), null);
  assert.equal((await server.git.readBlobAtPath(vaultId, conflictTarget, 'disputed.md')).toString(), fixture.deviceContent);
  const review = await server.sync.getConflictReviewPackage(vaultId, conflict.conflict_id);
  assert.ok(review.path_conflicts.some((row) => row.base_path === 'conflict.md' && row.device_path === 'disputed.md'));
  return { retained_unresolved_device_push_rows: pending.length, open_conflicts: 1,
    cold_retry_operation_id: fixture.coldId, conflict_id: conflict.conflict_id };
}
async function createFixture(root) {
  const server = await createObtsServer(config(root));
  try {
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup',
      payload: { username: 'owner', password: 'synthetic-benchmark-password-with-entropy' } });
    assert.equal(setup.statusCode, 201);
    const created = await server.app.inject({ method: 'POST', url: '/api/v1/vaults',
      headers: { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token },
      payload: { display_name: 'Synthetic history benchmark' } });
    assert.equal(created.statusCode, 201);
    vaultId = created.json().vault_id;
    const original = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const rootCommit = await server.git.getRef(vaultId, 'refs/heads/main');
    const base = await commit(server, rootCommit, { 'source.md': 'rename payload\n', 'conflict.md': original, 'pending-source.md': 'pending payload\n' });
    await setMain(server, base);
    const retryDevice = await addDevice(server, 'dev_benchmark_retry', base);
    const target = await commit(server, base, { 'moved.md': 'rename payload\n' }, ['source.md']);
    const saved = await request(server, retryDevice, base, target, 'benchmark-cold-retry', 'source.md', 'moved.md', 'AcceptedEmpty');
    const first = await server.sync.pushDeviceCommit(retryDevice.auth, saved.manifest, saved.pack);
    assert.equal(first.status, 'merged');
    assert.equal(first.directory_ack.status, 'accepted');
    const successfulMain = first.main;
    const coldId = await coldAdmission(server, saved);
    const conflictDevice = await addDevice(server, 'dev_benchmark_conflict', successfulMain);
    const conflictMain = await commit(server, successfulMain, { 'conflict.md': original.replace('line 50', 'REMOTE line 50') });
    await setMain(server, conflictMain);
    const deviceContent = `local addition\n${original.replace('line 50', 'DEVICE line 50').split('\n').slice(40).join('\n')}`;
    const conflictTarget = await commit(server, conflictMain, { 'disputed.md': deviceContent }, ['conflict.md']);
    const conflictRequest = await request(server, conflictDevice, successfulMain, conflictTarget,
      'benchmark-open-conflict', 'conflict.md', 'disputed.md', 'ConflictedEmpty');
    const conflictResult = await server.sync.pushDeviceCommit(conflictDevice.auth, conflictRequest.manifest, conflictRequest.pack);
    assert.equal(conflictResult.status, 'conflicted');
    assert.equal(conflictResult.directory_ack.status, 'conflicted');
    const conflictColdId = await coldAdmission(server, conflictRequest);
    const pendingDevice = await addDevice(server, 'dev_benchmark_pending', conflictMain);
    const pendingTarget = await commit(server, conflictMain, { 'pending-moved.md': 'pending payload\n' }, ['pending-source.md']);
    const pendingRequest = await request(server, pendingDevice, conflictMain, pendingTarget,
      'benchmark-pending-continuation', 'pending-source.md', 'pending-moved.md', 'PendingEmpty');
    const interrupted = new Error('Synthetic benchmark interruption after committed device ref, before merge');
    const merge = server.sync.mergeDeviceCommit;
    server.sync.mergeDeviceCommit = async () => { throw interrupted; };
    try {
      await assert.rejects(server.sync.pushDeviceCommit(pendingDevice.auth, pendingRequest.manifest, pendingRequest.pack),
        (error) => error === interrupted);
    } finally {
      server.sync.mergeDeviceCommit = merge;
    }
    const pendingId = await server.store.read((db) => db.sync_operations.find((row) =>
      row.prepared_manifest?.attempt_id === pendingRequest.manifest.attempt_id)?.operation_id);
    assert.ok(pendingId);
    const fixture = { server, retryDevice, saved, conflictDevice, conflictRequest, conflictResult, successfulMain,
      original, deviceContent, conflictMain, conflictTarget, coldId, conflictColdId, pendingDevice, pendingRequest, pendingId };
    await assertWorkload(server, fixture);
    return fixture;
  } catch (error) {
    await server.app.close();
    throw error;
  }
}

function manifestOperation(index, padding = 0) {
  const type = index % 50 < 25 ? 'device_push' : index % 50 < 49 ? 'server_merge' : 'conflict_create';
  const deviceId = devices[index % devices.length];
  const target = hex(index + 1);
  const main = hex(index + 3);
  const previous = hex(index + 5);
  const common = {
    vault_id: vaultId, device_id: type === 'conflict_create' ? null : deviceId, operation_type: type,
    expected_refs: { 'refs/heads/main': main }, target_refs: {}, target_commit: target,
    status: type === 'device_push' ? 'aborted' : 'committed',
    ...(type === 'device_push' ? { proposal_base: null } : {}),
    result: { decision: type === 'device_push' ? 'rejected' : type === 'server_merge' ? 'merged' : 'conflict' },
    created_at: timestamp(index), updated_at: timestamp(index)
  };
  const manifest = type === 'device_push' ? {
    attempt_id: `xfer_${hex(index + 7, 32)}`, attempt_hash: hex(index + 9, 64), proposal_base: null,
    requested_base_commit: index % 2 ? null : hex(index + 11), base_commit: null,
    rename_pairs: [{ source_path: `notes/${index}/old.md`, destination_path: `notes/${index}/new.md` }],
    directory_proposal: { proposal_id: `dir_${index}`, explicit_dirs: [`notes/${index}`], intents: [] },
    root_ignore_capability: 'root-ignore-v1', root_ignore_oid: null,
    validation: { object_integrity: 'ok', path_policy: 'ok', changed_path_policy: 'ok', fast_forward: 'fast_forward' }
  } : {
    merge_sequence: index, base_commit: hex(index + 11), current_main: main, device_commit: previous,
    decision: type === 'server_merge' ? 'merged' : 'conflict', rename_pairs: [{ source_path: 'old.md', destination_path: 'new.md' }],
    directory_plan: { explicit_dirs: [`notes/${index}`], intents: [] }, validator_results: { affected_path_count: 1 }
  };
  manifest.benchmark_synthetic = true;
  if (padding > 0) manifest.padding = 'x'.repeat(padding);
  return { ...common, prepared_manifest: manifest };
}

function estimatePadding(count) {
  if (count === 0 || targetAvgBytes === 0) return 0;
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    bytes += Buffer.byteLength(JSON.stringify({ operation_id: 'op_' + '0'.repeat(20),
      operation_sequence: index + 6, ...manifestOperation(index, 1) })) - 1;
  }
  return Math.max(0, Math.round(targetAvgBytes - bytes / count));
}

async function appendOperations(store, start, count, padding) {
  for (let offset = 0; offset < count; offset += 256) {
    const batchSize = Math.min(256, count - offset);
    await store.mutate((db) => {
      for (let index = start + offset; index < start + offset + batchSize; index++) {
        const source = manifestOperation(index, padding);
        const row = store.startOperation(db, {
          vault_id: source.vault_id, device_id: source.device_id, operation_type: source.operation_type,
          expected_refs: source.expected_refs, target_refs: source.target_refs, target_commit: source.target_commit,
          ...(Object.hasOwn(source, 'proposal_base') ? { proposal_base: source.proposal_base } : {})
        });
        row.status = source.status;
        row.prepared_manifest = source.prepared_manifest;
        row.result = source.result;
        row.created_at = source.created_at;
        row.updated_at = source.updated_at;
      }
    });
    await store.archiveCompletedHistory(vaultId);
  }
}


async function storageBytes(root) {
  const directory = join(root, 'metadata', 'operation-history', vaultId);
  const files = [];
  async function visit(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const relative = `${prefix}${item.name}`;
      if (item.isDirectory()) await visit(join(dir, item.name), `${relative}/`);
      else files.push({ path: relative, bytes: (await stat(join(dir, item.name))).size });
    }
  }
  await visit(directory);
  return { hot_json_bytes: (await stat(join(root, 'metadata', 'phase1.json'))).size,
    cold_ledger_and_sidecar_bytes: files.reduce((sum, file) => sum + file.bytes, 0), cold_files: files };
}

async function benchmarkSize(count, LegacyStore) {
  const root = await mkdtemp(join(parentDir, 'obts-history-bench-'));
  const legacyRoot = await mkdtemp(join(parentDir, 'obts-history-legacy-'));
  const migrationRoot = await mkdtemp(join(parentDir, 'obts-history-migration-'));
  let server;
  let legacy;
  let migration;
  try {
    const fixture = await createFixture(root);
    server = fixture.server;
    const padding = estimatePadding(count);
    await appendOperations(server.store, 0, count, padding);
    await server.sync.archiveStartupHistory(vaultId);
    const workload = await assertWorkload(server, fixture);
    const expectedEffects = await effects(server);
    const snapshot = await server.store.snapshot();
    const history = await server.store.exportOperationHistory(vaultId);
    const synthetic = history.filter((row) => row.prepared_manifest?.benchmark_synthetic === true);
    assert.equal(synthetic.length, count);
    const attempts = synthetic.filter((row) => row.operation_type === 'device_push');
    const first = attempts[0] ?? null;
    const last = attempts.at(-1) ?? null;
    const lookup = async (row) => {
      const found = await server.store.findArchivedAttempt(vaultId, row.device_id, row.prepared_manifest.attempt_id);
      assert.equal(found?.row.operation_id, row.operation_id);
      assert.equal(found.row.target_commit, row.target_commit);
    };
    const miss = async () => assert.equal(await server.store.findArchivedAttempt(vaultId, devices[0], 'benchmark-truly-missing-attempt'), null);
    const baselineDb = structuredClone(snapshot);
    baselineDb.sync_operations = structuredClone(history);
    delete baselineDb.operation_history_by_vault;
    baselineDb.schema_version = 7;
    for (const row of baselineDb.sync_operations) delete row.operation_sequence;
    await mkdir(join(legacyRoot, 'metadata'));
    await writeFile(join(legacyRoot, 'metadata', 'phase1.json'), `${JSON.stringify(baselineDb)}\n`, { mode: 0o600 });
    legacy = new LegacyStore(legacyRoot);
    await legacy.initialize();
    assert.deepEqual(await legacy.snapshot(), baselineDb);
    const legacyLookup = async (row) => await legacy.read((db) => {
      const found = db.sync_operations.find((candidate) => candidate.vault_id === vaultId && candidate.device_id === (row?.device_id ?? devices[0]) &&
        candidate.operation_type === 'device_push' && candidate.prepared_manifest?.attempt_id === (row?.prepared_manifest.attempt_id ?? 'benchmark-truly-missing-attempt'));
      assert.equal(found?.operation_id ?? null, row?.operation_id ?? null);
      return found ?? null;
    });
    const baseline = {
      hot_operation_rows: history.length, metadata_bytes: (await stat(join(legacyRoot, 'metadata', 'phase1.json'))).size,
      snapshot: await measure(() => legacy.snapshot()), durable_noop_mutate: await measure(() => legacy.mutate(() => undefined)),
      oldest_attempt_lookup: first ? await measure(() => legacyLookup(first)) : null,
      newest_attempt_lookup: last ? await measure(() => legacyLookup(last)) : null,
      missing_attempt_lookup: await measure(() => legacyLookup(null))
    };
    const after = {
      ...await storageBytes(root), hot_operation_rows: snapshot.sync_operations.length,
      archived_operation_rows: history.length - snapshot.sync_operations.length,
      snapshot: await measure(() => server.store.snapshot()), durable_noop_mutate: await measure(() => server.store.mutate(() => undefined)),
      oldest_attempt_lookup: first ? await measure(() => lookup(first)) : null,
      newest_attempt_lookup: last ? await measure(() => lookup(last)) : null,
      missing_attempt_lookup: await measure(miss)
    };
    await legacy.close();
    legacy = null;
    baseline.metadata_initialize_and_close = await measure(async () => {
      const store = new LegacyStore(legacyRoot);
      try { await store.initialize(); } finally { await store.close(); }
    });
    assert.equal(sha256(fixture.saved.pack), fixture.saved.manifest.packfile_sha256);
    assert.equal(fixture.saved.pack.length, fixture.saved.manifest.packfile_bytes);
    const retry = await measure(async () => {
      const result = await server.sync.pushDeviceCommit(fixture.retryDevice.auth, fixture.saved.manifest, fixture.saved.pack);
      assert.equal(result.status, 'noop');
      assert.equal(result.main, fixture.conflictMain);
      assert.equal(result.device_ref, fixture.saved.manifest.target_commit);
      assert.equal(result.directory_ack.status, 'duplicate');
    });
    assert.deepEqual(await effects(server), expectedEffects);
    await assertWorkload(server, fixture);
    const conflictRetry = await server.sync.pushDeviceCommit(fixture.conflictDevice.auth, fixture.conflictRequest.manifest, fixture.conflictRequest.pack);
    assert.deepEqual(conflictRetry, fixture.conflictResult);
    assert.deepEqual(await effects(server), expectedEffects);
    after.retry_added_operations = (await server.store.exportOperationHistory(vaultId)).length - history.length;
    assert.equal(after.retry_added_operations, runs + 1);
    await server.app.close();
    server = null;
    const firstRecoveryMs = await elapsed(async () => { server = await createObtsServer(config(root)); });
    await assertWorkload(server, fixture, true);
    const recoveredEffects = await effects(server);
    assert.notEqual(recoveredEffects.main, expectedEffects.main);
    assert.deepEqual(recoveredEffects.conflicts, expectedEffects.conflicts);
    assert.deepEqual(recoveredEffects.device_refs, expectedEffects.device_refs);
    await server.app.close();
    server = null;
    const startupSamples = [];
    for (let i = 0; i < runs; i++) {
      startupSamples.push(await elapsed(async () => { server = await createObtsServer(config(root)); }));
      assert.deepEqual(await effects(server), recoveredEffects);
      await assertWorkload(server, fixture, true);
      if (i === runs - 1) after.startup_total_operations = (await server.store.exportOperationHistory(vaultId)).length;
      await server.app.close();
      server = null;
    }
    after.first_full_server_pending_recovery_ms = round(firstRecoveryMs);
    after.full_server_startup = { median_ms: round(median(startupSamples)), samples_ms: startupSamples.map(round) };
    after.post_retry_storage = await storageBytes(root);
    const finalDb = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
    after.startup_hot_rows = finalDb.sync_operations.length;
    after.startup_archived_rows = after.startup_total_operations - after.startup_hot_rows;

    await mkdir(join(migrationRoot, 'metadata'));
    await writeFile(join(migrationRoot, 'metadata', 'phase1.json'), `${JSON.stringify(baselineDb)}\n`, { mode: 0o600 });
    migration = new MetadataStore(migrationRoot);
    const migrationMs = await elapsed(async () => {
      await migration.initialize();
      await migration.archiveStartupHistory(vaultId);
    });
    const migrated = await migration.exportOperationHistory(vaultId);
    assert.deepEqual(migrated.map(({ operation_sequence, ...row }) => row), baselineDb.sync_operations);
    const migrationHot = (await migration.snapshot()).sync_operations.length;
    await migration.close();
    migration = null;
    return {
      synthetic_history_size: count, zero_case: count === 0 ? 'No synthetic lookup hits; real successful/conflicted workload still populated.' : null,
      target_average_operation_bytes: targetAvgBytes, padding_bytes_per_operation: padding,
      actual_synthetic_average_operation_bytes: count ? round(synthetic.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) / count) : null,
      actual_total_operation_rows_before_retry: history.length,
      actual_total_average_operation_bytes: round(history.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) / history.length),
      synthetic_attempt_count: attempts.length,
      lookup_identities: { oldest: first?.operation_id ?? null, newest: last?.operation_id ?? null, miss: null },
      baseline, after,
      migration: { kind: 'single first schema-7 MetadataStore initialize plus conservative handoff; NOT full server startup',
        duration_ms: round(migrationMs), total_rows: migrated.length, retained_hot_rows: migrationHot },
      real_workload: { ...workload, exact_retry_noop: retry,
        pending_setup: 'One-shot benchmark-only interruption at mergeDeviceCommit entry after real push admission, pack import and device ref commit; method restored immediately, normal abort/archive run, first full startup resumes work.',
        pending_recovered_and_archived: true, saved_manifest_sha256: sha256(JSON.stringify(fixture.saved.manifest)),
        saved_pack_sha256: sha256(fixture.saved.pack), saved_pack_bytes: fixture.saved.pack.length,
        rename_directory_success: true, conflict_retry_preserved: true, canonical_refs_content_and_conflict_preserved: true }
    };
  } finally {
    if (server) await server.app.close();
    if (legacy) await legacy.close();
    if (migration) await migration.close();
    await Promise.all([root, legacyRoot, migrationRoot].map((path) => rm(path, { recursive: true, force: true })));
  }
}

const moduleRoot = await mkdtemp(join(parentDir, 'obts-history-baseline-code-'));
try {
  const legacy = await loadLegacyMetadataStore(args.get('baseline-ref'), moduleRoot);
  const samples = [];
  for (const count of sizes) samples.push(await benchmarkSize(count, legacy.MetadataStore));
  process.stdout.write(`${JSON.stringify({ node: process.version, hostname: hostname(), runs, filesystem_parent: parentDir,
    baseline_source: legacy.provenance,
    methodology: {
      units: 'milliseconds, logical file bytes',
      timing: 'Sequential in one driver; filesystem cache not flushed. Startup excludes close/assertions; retry includes direct push service and outcome assertions, not HTTP transport.',
      comparison: 'Actual legacy durable no-op mutate and snapshot on the same logical metadata; legacy metadata initialize is NOT comparable to full current server startup.',
      lookups: 'Synthetic aborted device-push admissions with realistic manifests; legacy read/find and current indexed read exclude outer admission mutation.',
      active_work: 'Real successful/conflicted rename-directory admissions are cold; open conflict refs stay protected. Separate real push interrupted at merge entry retains committed pending work until first startup recovers it.',
      memory: 'Not measured: driver retains exported history and legacy fixture; process RSS would not represent server working set.',
      startup: 'Repeated full createObtsServer on populated history; full history validation may remain linear. No legacy full server startup measurement.'
    }, samples }, null, 2)}\n`);
} finally {
  await rm(moduleRoot, { recursive: true, force: true });
}
