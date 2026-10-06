import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { hashToken, type AuthenticatedDevice } from '../src/server/authService.js';
import { sha256Hex } from '../src/server/gitService.js';
import { API_VERSION, type DevicePushManifest, type PushResult } from '../src/shared/types.js';

const BASE = 'first\n\nunchanged middle\n\nlast\n';
const REMOTE = BASE.replace('first', 'remote');
const LOCAL = BASE.replace('last', 'local');
const MERGED = REMOTE.replace('last', 'local');
let commitSequence = 0;
const roots: string[] = [];
const servers: ObtsServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

type Fixture = { server: ObtsServer; auth: AuthenticatedDevice; token: string; m0: string };
type Writes = Record<string, string | Buffer | null>;

async function commit(f: Fixture, parent: string, writes: Writes): Promise<string> {
  const tree = await f.server.git.createTreeFromCommitWithChanges({
    vaultId: f.auth.vault.vault_id, sourceCommit: parent,
    writes: new Map(Object.entries(writes).filter((entry): entry is [string, string | Buffer] => entry[1] !== null)
      .map(([path, bytes]) => [path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])),
    deletes: Object.entries(writes).filter(([, bytes]) => bytes === null).map(([path]) => path)
  });
  return await f.server.git.createMainCommitFromTree({
    vaultId: f.auth.vault.vault_id, tree, parentMain: parent, subject: `fixture edit ${++commitSequence}`, body: '', actor: 'fixture'
  });
}

async function setMain(f: Fixture, main: string): Promise<void> {
  await f.server.git.updateRef(f.auth.vault.vault_id, 'refs/heads/main', main, await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main'));
  await f.server.store.mutate((db) => { db.vaults.find((v) => v.vault_id === f.auth.vault.vault_id)!.current_main = main; });
}

async function fixture(initial: Writes = { 'note.md': BASE, 'image.png': Buffer.from([0, 1]), 'inherited.md': 'base\n' }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-stale-proposal-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'stale-proposal-test-secret' });
  servers.push(server);
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'test-password-with-entropy' } });
  expect(setup.statusCode).toBe(201);
  const created = await server.app.inject({
    method: 'POST', url: '/api/v1/vaults',
    headers: { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token },
    payload: { display_name: 'Stale proposal fixture' }
  });
  expect(created.statusCode).toBe(201);
  const vaultId = created.json().vault_id as string;
  const token = 'stale-proposal-fixture-device-token';
  const tokenHash = hashToken(token);
  const timestamp = new Date().toISOString();
  await server.store.mutate((db) => {
    const user = db.users[0]!;
    const vault = db.vaults.find((v) => v.vault_id === vaultId)!;
    db.devices.push({
      device_id: 'dev_stale', vault_id: vaultId, user_id: user.user_id, device_name: 'Stale fixture',
      device_ref: 'refs/obts/devices/dev_stale', device_ref_head: vault.current_main, status: 'synced',
      last_applied_main: vault.current_main, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    });
    db.tokens.push({
      token_id: 'tok_stale', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
      user_id: user.user_id, vault_id: vaultId, device_id: 'dev_stale', expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp
    });
  });
  const auth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  const f = { server, auth, token, m0: auth.vault.current_main };
  f.m0 = await commit(f, f.m0, initial);
  await setMain(f, f.m0);
  await server.git.updateRef(vaultId, auth.device.device_ref, f.m0, null);
  await server.store.mutate((db) => {
    const device = db.devices.find((d) => d.device_id === auth.device.device_id)!;
    device.device_ref_head = f.m0;
    device.last_applied_main = f.m0;
  });
  f.auth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  return f;
}

async function manifest(f: Fixture, target: string, base: string | undefined = f.m0, attempt?: string, renamePairs?: DevicePushManifest['rename_pairs']): Promise<{ manifest: DevicePushManifest; pack: Buffer }> {
  const pack = await f.server.git.exportPack(f.auth.vault.vault_id, target, f.m0);
  return { pack, manifest: {
    api_version: API_VERSION, plugin_version: '0.5.13', vault_id: f.auth.vault.vault_id, device_id: f.auth.device.device_id,
    expected_device_ref: f.m0, target_commit: target,
    client_known_main: await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main'),
    packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length,
    ...(base === undefined ? {} : { base_commit: base }), ...(attempt ? { attempt_id: attempt } : {}),
    ...(renamePairs === undefined ? {} : { rename_pairs: renamePairs })
  } };
}

async function multipart(f: Fixture, request: Awaited<ReturnType<typeof manifest>>): Promise<{ status: number; result: PushResult }> {
  const boundary = 'obts-stale-proposal-boundary';
  const response = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.auth.vault.vault_id}/sync/push`,
    headers: { authorization: `Bearer ${f.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(request.manifest)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      request.pack, Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  });
  return { status: response.statusCode, result: response.json() as PushResult };
}

async function push(f: Fixture, target: string, base = f.m0): Promise<PushResult> {
  const response = await multipart(f, await manifest(f, target, base));
  expect(response.status).toBe(200);
  return response.result;
}
async function blob(f: Fixture, main: string, path: string): Promise<string> {
  return (await f.server.git.readBlobAtPath(f.auth.vault.vault_id, main, path)).toString();
}
async function expectConflict(f: Fixture, result: PushResult, main: string): Promise<void> {
  expect(result.status).toBe('conflicted');
  expect(await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main')).toBe(main);
  const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
  expect(conflict.base_commit).toBe(f.m0);
  expect(conflict.current_main).toBe(main);
}

describe('explicit proposal base: authored paths and per-path identities', () => {
  it('merges disjoint stale Markdown from M0 despite parent C', async () => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, c);
    const d = await commit(f, c, { 'note.md': LOCAL });
    expect(await f.server.git.mergeBase(f.auth.vault.vault_id, c, d)).toBe(c);
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
  });

  it.each(['overlap', 'binary', 'delete'] as const)('conflicts on stale %s without moving main', async (kind) => {
    const f = await fixture();
    const c = await commit(f, f.m0, kind === 'binary' ? { 'image.png': Buffer.from([0, 2]) } : { 'note.md': REMOTE });
    await setMain(f, c);
    const d = await commit(f, c, kind === 'binary' ? { 'image.png': Buffer.from([0, 3]) }
      : { 'note.md': kind === 'delete' ? null : BASE.replace('first', 'overlap') });
    await expectConflict(f, await push(f, d), c);
  });

  it('never reverts inherited C paths when main advances again, including native merge output', async () => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE, 'image.png': Buffer.from([0, 2]), 'inherited.md': 'C\n' });
    const later = await commit(f, c, { 'image.png': Buffer.from([0, 4]), 'inherited.md': 'later\n' });
    await setMain(f, later);
    const d = await commit(f, c, { 'note.md': LOCAL });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
    expect(await blob(f, result.main, 'inherited.md')).toBe('later\n');
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'image.png')).toEqual(Buffer.from([0, 4]));
  });

  it('keeps main-only inherited content through the disjoint-overlay branch', async () => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'image.png': Buffer.from([0, 2]) });
    const later = await commit(f, c, { 'image.png': Buffer.from([0, 4]) });
    await setMain(f, later);
    const d = await commit(f, c, { 'new.md': 'new\n' });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'image.png')).toEqual(Buffer.from([0, 4]));
    expect(await blob(f, result.main, 'new.md')).toBe('new\n');
  });

  it('keeps inherited later main content when resolving an older-base conflict', async () => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE, 'inherited.md': 'C\n' });
    const main = await commit(f, c, { 'inherited.md': 'later main\n' });
    await setMain(f, main);
    const d = await commit(f, c, { 'note.md': BASE.replace('first', 'overlap'), 'new.md': 'local addition\n' });
    const result = await push(f, d);
    await expectConflict(f, result, main);
    if (result.status !== 'conflicted') throw new Error('conflict missing');
    const resolved = await f.server.sync.resolveConflict({
      actorUserId: f.auth.user.user_id, vaultId: f.auth.vault.vault_id, conflictId: result.conflict_id,
      expectedMain: main, resolutionKind: 'keep_server'
    });
    expect(resolved.status).toBe('resolved');
    expect(await blob(f, resolved.main, 'note.md')).toBe(REMOTE);
    expect(await blob(f, resolved.main, 'inherited.md')).toBe('later main\n');
    expect(await blob(f, resolved.main, 'new.md')).toBe('local addition\n');
  });

  it.each(['binary', 'delete', 'structural', 'malformed'] as const)('filters identical %s before classifying a mixed Markdown proposal', async (kind) => {
    const f = await fixture({ 'note.md': BASE, 'same.png': Buffer.from([0, 1]), 'same.md': 'old\n' });
    const c = await commit(f, f.m0, { 'note.md': REMOTE });
    const identity: Writes = kind === 'binary' ? { 'same.png': Buffer.from([0, 2]) }
      : kind === 'delete' ? { 'same.md': null }
      : kind === 'structural' ? { 'same.md': null, 'same.md/child.md': 'child\n' }
      : { 'same.md': '---\ninvalid: [\n---\n' };
    const main = await commit(f, c, identity);
    await setMain(f, main);
    const d = await commit(f, c, { 'note.md': LOCAL, ...identity });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
    const event = (await f.server.store.snapshot()).events.at(-1)!;
    expect(event.payload.changed_path_count).toBe(kind === 'structural' ? 3 : 2);
  });

  it('classifies stale edits inside an inherited file-to-directory transition without a processing failure', async () => {
    const f = await fixture({ 'folder.md': 'old file\n' });
    const c = await commit(f, f.m0, { 'folder.md': null, 'folder.md/child.md': BASE });
    await setMain(f, c);
    const d = await commit(f, c, { 'folder.md/child.md': LOCAL });
    const result = await multipart(f, await manifest(f, d));
    expect(result.status).toBe(200);
    await expectConflict(f, result.result, c);
  });

  it.each(['content', 'delete', 'structural'] as const)('accepts pure identical %s changes', async (kind) => {
    const f = await fixture();
    const writes: Writes = kind === 'content' ? { 'image.png': Buffer.from([0, 2]) }
      : kind === 'delete' ? { 'note.md': null } : { 'note.md': null, 'note.md/child.md': 'child\n' };
    const main = await commit(f, f.m0, writes);
    await setMain(f, main);
    const d = await commit(f, f.m0, writes);
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await f.server.git.treeHash(f.auth.vault.vault_id, result.main)).toBe(await f.server.git.treeHash(f.auth.vault.vault_id, main));
  });

  it.each(['different-target', 'delete', 'same-target', 'inferred-different-target'] as const)('retains identical absent rename source as causal provenance: %s', async (kind) => {
    const f = await fixture({ 'old.md': BASE });
    const main = await commit(f, f.m0, { 'old.md': null, 'server.md': BASE });
    await setMain(f, main);
    const d = await commit(f, f.m0, { 'old.md': null,
      ...(kind === 'delete' ? {} : { [kind === 'same-target' ? 'server.md' : 'device.md']: BASE }) });
    if (kind === 'inferred-different-target') {
      const changedPaths = f.server.git.changedPaths.bind(f.server.git);
      vi.spyOn(f.server.git, 'changedPaths').mockImplementation(async (...args) =>
        (await changedPaths(...args)).flatMap((entry) => entry.oldPath
          ? [{ status: 'D', path: entry.oldPath }, { status: 'A', path: entry.path }] : [entry]));
    }
    const result = await push(f, d);
    if (kind === 'same-target') {
      expect(result.status).toBe('merged');
      if (result.status !== 'merged') throw new Error('merge missing');
      expect(await f.server.git.treeHash(f.auth.vault.vault_id, result.main)).toBe(await f.server.git.treeHash(f.auth.vault.vault_id, main));
    } else {
      await expectConflict(f, result, main);
      const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
      expect(conflict.validator_results.reason).toBe(kind === 'delete' ? 'rename_delete_conflict' : 'rename_rename_conflict');
    }
  });

  it.each(['explicit', 'absent'] as const)('retains normal merge semantics with %s base equal to K', async (mode) => {
    const f = await fixture();
    const main = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, main);
    const d = await commit(f, f.m0, { 'note.md': LOCAL });
    const request = await manifest(f, d);
    if (mode === 'absent') delete request.manifest.base_commit;
    const result = (await multipart(f, request)).result;
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
  });

  it.each(['disjoint', 'untouched', 'overlap'] as const)('reused D1/D2 history with older M0: %s', async (kind) => {
    const f = await fixture();
    const d1Text = BASE.replace('unchanged middle', 'inherited D1 middle');
    const d1 = await commit(f, f.m0, { 'inherited.md': 'D1\n', 'note.md': d1Text });
    const integrated = await f.server.git.createMergeCommitObjectFromTree({
      vaultId: f.auth.vault.vault_id, tree: await f.server.git.treeHash(f.auth.vault.vault_id, d1),
      base: f.m0, currentMain: f.m0, deviceCommit: d1, mergeSequence: 1, strategy: 'disjoint_overlay'
    });
    const main = await commit(f, integrated, { 'note.md': d1Text.replace('first', 'remote'),
      ...(kind === 'untouched' ? { 'inherited.md': 'main-only after D1\n' } : {}) });
    await setMain(f, main);
    const d2 = await commit(f, d1, { 'note.md': kind === 'overlap' ? d1Text.replace('first', 'overlap') : d1Text.replace('last', 'local') });
    expect(await f.server.git.mergeBase(f.auth.vault.vault_id, main, d2)).toBe(d1);
    const request = await manifest(f, d2);
    request.manifest.expected_device_ref = null; // Re-pair retains M0 but reuses D2 history.
    await f.server.git.updateRef(f.auth.vault.vault_id, f.auth.device.device_ref, d1, f.m0);
    await f.server.store.mutate((db) => { db.devices[0]!.device_ref_head = d1; });
    const result = (await multipart(f, request)).result;
    if (kind === 'overlap') await expectConflict(f, result, main);
    else {
      expect(result.status).toBe('merged');
      if (result.status !== 'merged') throw new Error('merge missing');
      expect(await blob(f, result.main, 'note.md')).toBe(d1Text.replace('first', 'remote').replace('last', 'local'));
      expect(await blob(f, result.main, 'inherited.md')).toBe(kind === 'untouched' ? 'main-only after D1\n' : 'D1\n');
    }
  });
});

describe('older-base native rename carry-through and ownership', () => {
  it.each([false, true])('retains stale edit through a main rename (independent addition: %s)', async (addition) => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'note.md': null, 'renamed.md': BASE });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL, ...(addition ? { 'addition.md': 'independent local\n' } : {}) });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'renamed.md')).toBe(LOCAL);
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, result.main, 'note.md')).toBeNull();
    expect(await blob(f, result.main, 'inherited.md')).toBe('K\n');
    if (addition) expect(await blob(f, result.main, 'addition.md')).toBe('independent local\n');
  });

  it.each(['disjoint', 'overlap'] as const)('matches base=K native outcome when main renames and edits: %s', async (kind) => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'note.md': null,
      'renamed.md': kind === 'disjoint' ? REMOTE : BASE.replace('last', 'remote last') });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const authored = await f.server.git.changedPaths(f.auth.vault.vault_id, k, d);
    const native = await f.server.git.tryPolicyMergeTree(f.auth.vault.vault_id, k, main, d,
      authored, ['note.md']);
    const result = await push(f, d);
    if (native) {
      expect(result.status).toBe('merged');
      if (result.status !== 'merged') throw new Error('merge missing');
      expect(await blob(f, result.main, 'renamed.md')).toBe(await blob(f, native.tree, 'renamed.md'));
      expect(await blob(f, result.main, 'renamed.md')).toContain('local');
    } else await expectConflict(f, result, main);
  });

  it('carries edits through inferred main rename pairs without Git rename records', async () => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'note.md': null, 'renamed.md': BASE });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const changedPaths = f.server.git.changedPaths.bind(f.server.git);
    vi.spyOn(f.server.git, 'changedPaths').mockImplementation(async (...args) =>
      (await changedPaths(...args)).flatMap((entry) => entry.oldPath
        ? [{ status: 'D', path: entry.oldPath }, { status: 'A', path: entry.path }] : [entry]));
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'renamed.md')).toBe(LOCAL);
  });

  it('fails closed on an unexplained native result difference instead of dropping it', async () => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, k);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const native = await f.server.git.tryPolicyMergeTree(f.auth.vault.vault_id, f.m0, k, d,
      await f.server.git.changedPaths(f.auth.vault.vault_id, k, d), ['note.md'], k);
    if (!native) throw new Error('native fixture merge missing');
    const unexplainedTree = await f.server.git.createTreeFromTreeWithChanges({
      vaultId: f.auth.vault.vault_id, sourceTree: native.tree,
      writes: new Map([['inherited.md', Buffer.from('unexplained native bytes\n')]])
    });
    const internals = f.server.git as unknown as {
      exec: (...args: any[]) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>
    };
    const exec = internals.exec.bind(f.server.git);
    vi.spyOn(internals, 'exec').mockImplementation(async (...args) => args[1]?.[0] === 'merge-tree'
      ? { stdout: unexplainedTree + '\n', stderr: '' } : await exec(...args));
    const result = await push(f, d);
    await expectConflict(f, result, k);
    const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
    expect(conflict.validator_results.reason).toBe('unexplained_native_merge_paths');
    expect(conflict.affected_paths).toEqual(['inherited.md', 'note.md']);
    expect(await f.server.git.isAncestor(f.auth.vault.vault_id, d, k)).toBe(false);
    expect(await blob(f, d, 'note.md')).toBe(LOCAL);
  });

  it('conflicts rather than dropping a new file moved by native directory-rename detection', async () => {
    const f = await fixture({ 'old/note.md': BASE, 'inherited.md': 'base\n' });
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'old/note.md': null, 'new/note.md': BASE });
    await setMain(f, main);
    const d = await commit(f, k, { 'old/note.md': LOCAL, 'old/addition.md': 'new local file\n' });
    const internals = f.server.git as unknown as { exec: (...args: any[]) => Promise<unknown> };
    await internals.exec(f.server.git.repoPath(f.auth.vault.vault_id), ['config', 'merge.directoryRenames', 'true']);
    const result = await push(f, d);
    await expectConflict(f, result, main);
    const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
    expect(conflict.validator_results.reason).toBe('unexplained_native_merge_paths');
    expect(conflict.affected_paths).toContain('new/addition.md');
    expect(await blob(f, d, 'old/addition.md')).toBe('new local file\n');
    expect(await blob(f, main, 'new/note.md')).toBe(BASE);
    expect(await f.server.git.isAncestor(f.auth.vault.vault_id, d, main)).toBe(false);
  });
});

describe('K-relative rename ownership adversarial cases', () => {
  it.each([false, true])('does not redirect a resurrected source through a pre-K rename (later destination edit: %s)', async (laterEdit) => {
    const f = await fixture({ 'old.md': BASE, 'note.md': BASE, 'inherited.md': 'base\n' });
    const k = await commit(f, f.m0, { 'old.md': null, 'renamed.md': BASE });
    const destination = laterEdit ? REMOTE : BASE;
    const main = await commit(f, k, { 'note.md': REMOTE, ...(laterEdit ? { 'renamed.md': destination } : {}) });
    await setMain(f, main);
    const d = await commit(f, k, { 'old.md': LOCAL, 'note.md': LOCAL });
    expect(await blob(f, d, 'renamed.md')).toBe(BASE);
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, k, 'old.md')).toBeNull();
    const result = await push(f, d);
    if (result.status === 'merged') {
      expect(await blob(f, result.main, 'old.md')).toBe(LOCAL);
      expect(await blob(f, result.main, 'renamed.md')).toBe(destination);
      expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
    } else {
      await expectConflict(f, result, main);
      expect(await blob(f, main, 'renamed.md')).toBe(destination);
      expect(await blob(f, d, 'old.md')).toBe(LOCAL);
      expect(await f.server.git.isAncestor(f.auth.vault.vault_id, d, main)).toBe(false);
    }
  });

  it.each(['disjoint', 'overlap'] as const)('preserves independent destination edits after a post-K rename: %s', async (kind) => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const renamed = await commit(f, k, { 'note.md': null, 'renamed.md': BASE });
    const main = await commit(f, renamed, { 'renamed.md': kind === 'disjoint' ? REMOTE : BASE.replace('last', 'remote') });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const result = await push(f, d);
    if (kind === 'disjoint') {
      expect(result.status).toBe('merged');
      if (result.status !== 'merged') throw new Error('merge missing');
      expect(await blob(f, result.main, 'renamed.md')).toBe(MERGED);
    } else await expectConflict(f, result, main);
  });

  it('does not carry onto a preexisting independently replaced destination', async () => {
    const f = await fixture({ 'note.md': BASE, 'target.md': 'preexisting different content\n', 'inherited.md': 'base\n' });
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'note.md': null, 'target.md': REMOTE });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    await expectConflict(f, await push(f, d), main);
  });

  it('rejects a native rewrite of an unrelated rename destination whose source is not authored', async () => {
    const f = await fixture({ 'old.md': BASE, 'note.md': BASE, 'inherited.md': 'base\n' });
    const k = await commit(f, f.m0, { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'old.md': null, 'renamed.md': BASE, 'note.md': REMOTE });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const native = await f.server.git.tryPolicyMergeTree(f.auth.vault.vault_id, f.m0, main, d,
      await f.server.git.changedPaths(f.auth.vault.vault_id, k, d), ['note.md'], k);
    if (!native) throw new Error('native fixture merge missing');
    const forged = await f.server.git.createTreeFromTreeWithChanges({
      vaultId: f.auth.vault.vault_id, sourceTree: native.tree, writes: new Map([['renamed.md', Buffer.from(LOCAL)]])
    });
    const internals = f.server.git as unknown as {
      exec: (...args: any[]) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>
    };
    const exec = internals.exec.bind(f.server.git);
    vi.spyOn(internals, 'exec').mockImplementation(async (...args) => args[1]?.[0] === 'merge-tree'
      ? { stdout: forged + '\n', stderr: '' } : await exec(...args));
    await expectConflict(f, await push(f, d), main);
    expect((await f.server.store.snapshot()).conflicts.at(-1)?.validator_results.reason).toBe('unexplained_native_merge_paths');
  });

  it('classifies edits after an inherited directory-to-file conversion', async () => {
    const f = await fixture({ 'folder.md/child.md': 'original unrelated child\n' });
    const tree = await f.server.git.createTreeFromCommitWithChanges({
      vaultId: f.auth.vault.vault_id, sourceCommit: f.m0, deletes: ['folder.md'], writes: new Map([['folder.md', Buffer.from(BASE)]])
    });
    const k = await f.server.git.createMainCommitFromTree({
      vaultId: f.auth.vault.vault_id, tree, parentMain: f.m0, subject: 'fixture conversion', body: '', actor: 'fixture'
    });
    await setMain(f, k);
    const d = await commit(f, k, { 'folder.md': LOCAL });
    await expectConflict(f, await push(f, d), k);
  });

  it('preserves inherited executable mode and OID in an older-base native result', async () => {
    const f = await fixture();
    const k = await commit(f, f.m0, { 'note.md': REMOTE });
    const entries = await f.server.git.listTreeEntries(f.auth.vault.vault_id, k);
    const inherited = entries.find((entry) => entry.path === 'inherited.md')!;
    const rawTree = entries.map((entry) => `${entry.path === 'inherited.md' ? '100755' : entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\n`).join('');
    const internals = f.server.git as unknown as {
      exec: (...args: any[]) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>
    };
    const tree = (await internals.exec(f.server.git.repoPath(f.auth.vault.vault_id), ['mktree'], Buffer.from(rawTree))).stdout.toString().trim();
    const main = await f.server.git.createMainCommitFromTree({
      vaultId: f.auth.vault.vault_id, tree, parentMain: k, subject: 'fixture executable mode', body: '', actor: 'fixture'
    });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': LOCAL });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    const output = (await f.server.git.listTreeEntries(f.auth.vault.vault_id, result.main)).find((entry) => entry.path === 'inherited.md')!;
    expect(output.mode).toBe('100755');
    expect(output.oid).toBe(inherited.oid);
  });

  it('binds omitted/null identity equivalently and rejects a later explicit retry base', async () => {
    const f = await fixture();
    const main = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, main);
    const d = await commit(f, f.m0, { 'note.md': LOCAL });
    const request = await manifest(f, d);
    delete request.manifest.base_commit;
    const fail = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit')
      .mockRejectedValueOnce(new Error('integration seam'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('integration seam');
    fail.mockRestore();
    const admitted = (await f.server.store.snapshot()).sync_operations.find((op) => op.operation_type === 'device_push' && op.target_commit === d)!;
    expect(admitted.proposal_base).toBeNull();
    const explicit = await manifest(f, d, f.m0);
    await expect(f.server.sync.pushDeviceCommit(f.auth, explicit.manifest, explicit.pack))
      .rejects.toMatchObject({ statusCode: 409, code: 'proposal_base_mismatch' });
    request.manifest.base_commit = null;
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
  });
});

describe('immutable admitted base across re-entry', () => {
  it.each(['multipart', 'chunked', 'replacement-chunked'] as const)('reuses M0 after ref movement and rejects a different base (%s)', async (transport) => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, c);
    const d = await commit(f, c, { 'note.md': LOCAL });
    const request = await manifest(f, d, f.m0, 'original-admission');
    const fail = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit').mockRejectedValueOnce(new Error('injected failure after device ref'));
    let retry: () => Promise<PushResult>;
    if (transport === 'multipart') {
      expect((await multipart(f, request)).status).toBe(500);
      retry = async () => (await multipart(f, request)).result;
    } else {
      const { pack, manifest: m } = request;
      const transfer = await f.server.chunkTransfers.createPush(f.auth, { ...m, attempt_id: m.attempt_id!, chunk_count: 1, plan_sha256: sha256Hex('fixture-plan') });
      await f.server.chunkTransfers.putChunk(f.auth, transfer.descriptor.transfer_id, 0, pack, sha256Hex(pack));
      await expect(f.server.chunkTransfers.finalizePush(f.auth, transfer.descriptor.transfer_id)).rejects.toThrow('injected failure');
      retry = async () => {
        if (transport === 'chunked') return await f.server.chunkTransfers.finalizePush(f.auth, transfer.descriptor.transfer_id);
        // Expire the checkpoint on disk, then reconstruct with the same proposal base.
        const sessionPath = join(f.server.config.transferDir, transfer.descriptor.transfer_id, 'session.json');
        const session = JSON.parse(await readFile(sessionPath, 'utf8'));
        session.expires_at = new Date(Date.now() - 1_000).toISOString();
        await writeFile(sessionPath, JSON.stringify(session));
        await expect(f.server.chunkTransfers.getPush(f.auth, transfer.descriptor.transfer_id))
          .rejects.toMatchObject({ statusCode: 410, code: 'transfer_expired' });
        const replacement = await f.server.chunkTransfers.createPush(f.auth, {
          ...m, attempt_id: 'replacement-transfer', chunk_count: 1, plan_sha256: sha256Hex('fixture-plan')
        });
        await f.server.chunkTransfers.putChunk(f.auth, replacement.descriptor.transfer_id, 0, pack, sha256Hex(pack));
        return await f.server.chunkTransfers.finalizePush(f.auth, replacement.descriptor.transfer_id);
      };
    }
    fail.mockRestore();
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(d);
    const admitted = (await f.server.store.snapshot()).sync_operations.find((op) => op.operation_type === 'device_push' && op.target_commit === d)!;
    expect(admitted.proposal_base).toBe(f.m0);
    expect(admitted.prepared_manifest?.proposal_base).toBe(f.m0);
    const bad = await manifest(f, d, c, 'different-attempt');
    await expect(f.server.sync.pushDeviceCommit(f.auth, bad.manifest, bad.pack)).rejects.toMatchObject({ statusCode: 409, code: 'proposal_base_mismatch' });
    const omitted = await manifest(f, d, f.m0, 'omitted-base-attempt');
    delete omitted.manifest.base_commit;
    await expect(f.server.sync.pushDeviceCommit(f.auth, omitted.manifest, omitted.pack))
      .rejects.toMatchObject({ statusCode: 409, code: 'proposal_base_mismatch' });
    if (transport !== 'multipart') {
      const badTransfer = await f.server.chunkTransfers.createPush(f.auth, {
        ...bad.manifest, attempt_id: 'bad-chunked-attempt', chunk_count: 1, plan_sha256: sha256Hex('fixture-plan')
      });
      await f.server.chunkTransfers.putChunk(f.auth, badTransfer.descriptor.transfer_id, 0, bad.pack, sha256Hex(bad.pack));
      await expect(f.server.chunkTransfers.finalizePush(f.auth, badTransfer.descriptor.transfer_id))
        .rejects.toMatchObject({ statusCode: 409, code: 'proposal_base_mismatch' });
    }
    expect(await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main')).toBe(c);
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(d);
    const later = await commit(f, c, { 'inherited.md': 'main advanced during retry\n' });
    await setMain(f, later);
    const result = await retry();
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(MERGED);
    expect(await blob(f, result.main, 'inherited.md')).toBe('main advanced during retry\n');
    const merges = (await f.server.store.snapshot()).sync_operations.filter((op) => op.operation_type === 'server_merge');
    expect(merges.at(-1)?.prepared_manifest?.base_commit).toBe(f.m0);
  });

  it('legacy equal-ref re-entry uses natural base and binds that migration on subsequent retries', async () => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, c);
    const d = await commit(f, c, { 'note.md': LOCAL });
    const request = await manifest(f, d);
    const fail = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit').mockRejectedValueOnce(new Error('ref seam'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('ref seam');
    fail.mockRestore();
    await f.server.store.mutate((db) => {
      const op = db.sync_operations.find((o) => o.operation_type === 'device_push' && o.target_commit === d)!;
      delete op.proposal_base;
      delete op.prepared_manifest!.proposal_base;
      delete op.prepared_manifest!.requested_base_commit;
    });
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(LOCAL);
    const bad = await manifest(f, d, c);
    await expect(f.server.sync.pushDeviceCommit(f.auth, bad.manifest, bad.pack))
      .rejects.toMatchObject({ statusCode: 409, code: 'proposal_base_mismatch' });
    expect(await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main')).toBe(result.main);
  });

  it.each(['bound', 'legacy'] as const)('startup resumes persisted %s admission with its migration semantics', async (mode) => {
    const f = await fixture();
    const c = await commit(f, f.m0, { 'note.md': REMOTE });
    await setMain(f, c);
    const d = await commit(f, c, { 'note.md': LOCAL });
    const request = await manifest(f, d);
    const fail = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit').mockRejectedValueOnce(new Error('ref seam'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('ref seam');
    fail.mockRestore();
    if (mode === 'legacy') await f.server.store.mutate((db) => {
      const op = db.sync_operations.find((o) => o.operation_type === 'device_push' && o.target_commit === d)!;
      delete op.proposal_base;
      delete op.prepared_manifest!.proposal_base;
      delete op.prepared_manifest!.requested_base_commit;
    });
    await f.server.app.close();
    servers.splice(servers.indexOf(f.server), 1);
    const restarted = await createObtsServer(f.server.config);
    servers.push(restarted);
    const main = await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main');
    expect(main).not.toBe(c);
    expect(await blob(f, main!, 'note.md')).toBe(mode === 'bound' ? MERGED : LOCAL);
  });
});

const TIMESTAMP_RULES = [{ field: 'updated', strategy: 'latest_timestamp' as const }, { field: 'created', strategy: 'latest_timestamp' as const }];
function timestampNote(updated: number, created = 1, body = 'body\n'): string {
  // Keep field edits in separate Git hunks to exercise a genuinely clean native merge.
  return `---\nupdated: 2026-01-0${updated}T00:00:00Z\n# stable one\n# stable two\n# stable three\n# stable four\n# stable five\n# stable six\n# stable seven\ncreated: 2026-01-0${created}T00:00:00Z\n---\n${body}`;
}
async function saveSettings(f: Fixture, rootIgnore: string | null = null, rules = TIMESTAMP_RULES): Promise<string> {
  const vaultId = f.auth.vault.vault_id;
  const actorUserId = f.auth.user.user_id;
  const before = await f.server.sync.getVaultSyncSettings(vaultId, actorUserId);
  const input = { vaultId, actorUserId, expectedMain: String(before.current_main),
    expectedRootIgnoreOid: before.root_ignore_oid as string | null, rootIgnore, metadataConflictRules: rules };
  const preview = await f.server.sync.previewVaultSyncSettings(input);
  const saved = await f.server.sync.saveVaultSyncSettings({ ...input, expectedPreviewTree: String(preview.preview_tree),
    expectedReviewFingerprint: String(preview.review_fingerprint), expectedMetadataConflictRules: before.metadata_conflict_rules });
  return String(saved.current_main);
}
async function mergeEvidence(f: Fixture, main: string) {
  const operation = (await f.server.store.snapshot()).sync_operations.find((op) => op.operation_type === 'server_merge' && op.target_commit === main)!;
  expect(operation.status).toBe('committed');
  expect(operation.prepared_manifest?.metadata_conflict_rules).toEqual(TIMESTAMP_RULES);
  expect(operation.prepared_manifest?.metadata_conflict_rules_sha256).toBe(sha256Hex(JSON.stringify(TIMESTAMP_RULES)));
  return operation.prepared_manifest!.validator_results as Record<string, unknown>;
}

describe('stale proposals composed with vault settings and timestamp rules', () => {
  it.each(['native', 'fallback'] as const)('preserves inherited main bytes with older M0 in the %s timestamp path', async (branch) => {
    const f = await fixture({ 'note.md': timestampNote(1), 'inherited.md': timestampNote(1, 1, 'old inherited body\n') });
    await saveSettings(f);
    const k = await commit(f, f.m0, { 'note.md': timestampNote(2, 2), 'inherited.md': timestampNote(2, 2, 'K inherited body\n') });
    const inheritedMain = timestampNote(5, 3, 'later main body must remain byte exact\r\n');
    const main = await commit(f, k, { 'note.md': timestampNote(3), 'inherited.md': inheritedMain });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': branch === 'native' ? timestampNote(1, 4) : timestampNote(4) });
    expect(await f.server.git.mergeBase(f.auth.vault.vault_id, main, d)).toBe(k);
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(branch === 'native' ? timestampNote(3, 4) : timestampNote(4));
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'inherited.md')).toEqual(Buffer.from(inheritedMain));
    const evidence = await mergeEvidence(f, result.main);
    expect(evidence.native_git_merge).toBe(branch === 'native' ? 'clean' : 'conflicted');
    expect(evidence.metadata_timestamp_fields).toContainEqual({ path: 'note.md', field: 'updated', winner: branch === 'native' ? 'server' : 'device' });
  });

  it('filters binary and malformed-text identities before timestamp fallback', async () => {
    const sameBinary = Buffer.from([0, 9, 0xff]);
    const malformed = Buffer.from([0xff, 0xfe]);
    const f = await fixture({ 'note.md': timestampNote(1), 'image.png': Buffer.from([0, 1]), 'bad.md': 'initial\n' });
    await saveSettings(f);
    const k = await commit(f, f.m0, { 'note.md': timestampNote(2) });
    const main = await commit(f, k, { 'note.md': timestampNote(3), 'image.png': sameBinary, 'bad.md': malformed });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': timestampNote(4), 'image.png': sameBinary, 'bad.md': malformed });
    const result = await push(f, d);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(timestampNote(4));
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'image.png')).toEqual(sameBinary);
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'bad.md')).toEqual(malformed);
    expect((await mergeEvidence(f, result.main)).overlapping_path_count).toBe(1);
  });

  it('keeps unexplained native output a durable conflict without timestamp fallback', async () => {
    const f = await fixture({ 'note.md': timestampNote(1), 'inherited.md': 'protected\n' });
    await saveSettings(f);
    const k = await commit(f, f.m0, { 'note.md': timestampNote(2, 2) });
    const main = await commit(f, k, { 'note.md': timestampNote(3) });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': timestampNote(1, 4) });
    const native = await f.server.git.tryPolicyMergeTree(f.auth.vault.vault_id, f.m0, main, d,
      await f.server.git.changedPaths(f.auth.vault.vault_id, k, d), ['note.md'], k, [], TIMESTAMP_RULES);
    if (!native) throw new Error('native fixture missing');
    const forged = await f.server.git.createTreeFromTreeWithChanges({ vaultId: f.auth.vault.vault_id, sourceTree: native.tree,
      writes: new Map([['inherited.md', Buffer.from('unexplained\n')]]) });
    const internals = f.server.git as unknown as { exec: (...args: any[]) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>; trySemanticOverlayMergeTree: (...args: any[]) => Promise<unknown> };
    const fallback = vi.spyOn(internals, 'trySemanticOverlayMergeTree');
    const exec = internals.exec.bind(f.server.git);
    vi.spyOn(internals, 'exec').mockImplementation(async (...args) => args[1]?.[0] === 'merge-tree'
      ? { stdout: `${forged}\n`, stderr: '' } : await exec(...args));
    const result = await push(f, d);
    await expectConflict(f, result, main);
    expect(fallback).not.toHaveBeenCalled();
    const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
    expect(conflict.validator_results.reason).toBe('unexplained_native_merge_paths');
    expect(conflict.affected_paths).toEqual(['inherited.md', 'note.md']);
    expect(await blob(f, main, 'inherited.md')).toBe('protected\n');
    expect(await f.server.git.isAncestor(f.auth.vault.vault_id, d, main)).toBe(false);
    await saveSettings(f, null, []);
    await expectConflict(f, await push(f, d), main);
    expect((await f.server.store.snapshot()).conflicts.at(-1)?.conflict_id).toBe(conflict.conflict_id);
  });

  it.each(['pre-K', 'post-K', 'resurrection'] as const)('preserves rename ownership with rules enabled: %s', async (schedule) => {
    const source = timestampNote(1, 1, BASE);
    const local = timestampNote(1, 1, LOCAL);
    const f = await fixture({ 'old.md': source, 'note.md': timestampNote(1), 'inherited.md': 'base\n' });
    await saveSettings(f);
    const preK = schedule !== 'post-K';
    const k = await commit(f, f.m0, preK ? { 'old.md': null, 'renamed.md': source } : { 'inherited.md': 'K\n' });
    const main = await commit(f, k, { 'note.md': timestampNote(3), ...(preK ? {} : { 'old.md': null, 'renamed.md': source }) });
    await setMain(f, main);
    const writes: Writes = schedule === 'pre-K' ? { 'renamed.md': local }
      : schedule === 'post-K' ? { 'old.md': local } : { 'old.md': local, 'note.md': timestampNote(4) };
    const d = await commit(f, k, writes);
    const result = await push(f, d);
    if (schedule !== 'post-K') {
      // Pre-K destination edits already receive conservative structural refusal;
      // do not relax that classifier or redirect a resurrected source.
      await expectConflict(f, result, main);
      expect(await blob(f, main, 'renamed.md')).toBe(source);
      expect(await blob(f, d, schedule === 'pre-K' ? 'renamed.md' : 'old.md')).toBe(local);
      expect(await f.server.git.isAncestor(f.auth.vault.vault_id, d, main)).toBe(false);
    } else {
      expect(result.status).toBe('merged');
      if (result.status !== 'merged') throw new Error('merge missing');
      expect(await blob(f, result.main, 'renamed.md')).toBe(local);
      expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, result.main, 'old.md')).toBeNull();
    }
  });

  it('refuses absent rename-destination inputs and invalid UTF-8 without weakening validation', async () => {
    const f = await fixture({ 'old.md': timestampNote(1, 1, BASE) });
    await saveSettings(f);
    const k = await commit(f, f.m0, { 'extra.md': 'K\n' });
    const main = await commit(f, k, { 'old.md': null, 'renamed.md': timestampNote(1, 1, REMOTE) });
    const d = await commit(f, k, { 'old.md': timestampNote(1, 1, LOCAL) });
    const changes = await f.server.git.changedPaths(f.auth.vault.vault_id, k, d);
    expect(await f.server.git.tryPolicyMergeTree(f.auth.vault.vault_id, f.m0, main, d, changes,
      ['old.md', 'renamed.md'], k, [{ sourcePath: 'old.md', targetPath: 'renamed.md' }], TIMESTAMP_RULES)).toBeNull();
    const invalid = await commit(f, k, { 'old.md': Buffer.concat([Buffer.from(timestampNote(3)), Buffer.from([0xff])]) });
    const stale = await commit(f, k, { 'old.md': timestampNote(4) });
    await setMain(f, invalid);
    await expectConflict(f, await push(f, stale), invalid);
  });

  it('blocks a stale authored path after a settings exclusion rather than stripping or resurrecting it', async () => {
    const f = await fixture({ 'private/note.md': timestampNote(1), 'note.md': timestampNote(1) });
    await f.server.store.mutate((db) => { db.devices.find((device) => device.device_id === f.auth.device.device_id)!.path_capabilities = { root_ignore: true }; });
    const k = await commit(f, f.m0, { 'private/note.md': timestampNote(2) });
    await setMain(f, k);
    const main = await saveSettings(f, 'private/\n');
    const d = await commit(f, k, { 'private/note.md': timestampNote(4) });
    const request = await manifest(f, d);
    request.manifest.root_ignore_capability = 'root-ignore-v1';
    request.manifest.root_ignore_oid = null;
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    await expectConflict(f, result, main);
    const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
    expect(conflict.affected_paths).toContain('private/note.md');
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, main, 'private/note.md')).toBeNull();
    expect(await blob(f, d, 'private/note.md')).toBe(timestampNote(4));
    expect(await blob(f, main, '.gitignore')).toBe('private/\n');
  });

  it.each(['explicit', 'null'] as const)('keeps %s admission immutable through retries with pinned rules and uncertain CAS', async (mode) => {
    const f = await fixture({ 'note.md': timestampNote(1) });
    await saveSettings(f);
    const k = await commit(f, f.m0, { 'note.md': timestampNote(2) });
    const main = await commit(f, k, { 'note.md': timestampNote(3) });
    await setMain(f, main);
    const d = await commit(f, k, { 'note.md': timestampNote(4) });
    const request = await manifest(f, d, f.m0, 'rules-admission');
    if (mode === 'null') delete request.manifest.base_commit;
    const seam = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit').mockRejectedValueOnce(new Error('admission seam'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('admission seam');
    seam.mockRestore();
    const bound = (await f.server.store.snapshot()).sync_operations.find((op) => op.operation_type === 'device_push' && op.target_commit === d)!;
    expect(bound.proposal_base).toBe(mode === 'explicit' ? f.m0 : null);
    const bad = await manifest(f, d, mode === 'explicit' ? k : f.m0, 'changed-rules-base');
    await expect(f.server.sync.pushDeviceCommit(f.auth, bad.manifest, bad.pack)).rejects.toMatchObject({ code: 'proposal_base_mismatch' });
    const updateRef = f.server.git.updateRef.bind(f.server.git);
    vi.spyOn(f.server.git, 'updateRef').mockImplementation(async (...args) => {
      await updateRef(...args);
      if (args[1] === 'refs/heads/main') throw new Error('uncertain CAS after publication');
    });
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await blob(f, result.main, 'note.md')).toBe(timestampNote(4));
    const evidence = await mergeEvidence(f, result.main);
    expect(evidence.metadata_timestamp_fields).toContainEqual({ path: 'note.md', field: 'updated', winner: 'device' });
    const operation = (await f.server.store.snapshot()).sync_operations.find((op) => op.operation_type === 'server_merge' && op.target_commit === result.main)!;
    expect(operation.prepared_manifest?.base_commit).toBe(mode === 'explicit' ? f.m0 : k);
  });
});

describe('explicit rename pair proposals', () => {
  const pair = [{ source_path: 'source.md', destination_path: 'moved.md' }];

  it('merges a low-similarity move with a compatible source edit and retains unrelated main changes', async () => {
    const original = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const f = await fixture({ 'source.md': original, 'unrelated.md': 'base\n' });
    const remote = await commit(f, f.m0, { 'source.md': `${original}remote addition\n`, 'unrelated.md': 'canonical\n' });
    await setMain(f, remote);
    const movedContent = `local addition\n${Array.from({ length: 100 }, (_, index) => `line ${index}`).slice(40).join('\n')}\n`;
    const target = await commit(f, remote, { 'source.md': null, 'moved.md': movedContent });
    const request = await manifest(f, target, f.m0, undefined, pair);
    const response = await multipart(f, request);
    const result = response.result;
    expect(response.status).toBe(200);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('rename merge missing');
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, result.main, 'source.md')).toBeNull();
    expect(await blob(f, result.main, 'moved.md')).toBe(`${movedContent}remote addition\n`);
    expect(await blob(f, result.main, 'unrelated.md')).toBe('canonical\n');
  });

  it('merges a zero-similarity Canvas move through the existing semantic policy', async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      id: `node-${index}`, type: 'text', x: index * 10, y: index * 5, width: 200, height: 100, text: `payload-${index}`
    }));
    const original = JSON.stringify({ nodes, edges: [] }) + '\n';
    const canvasPair = [{ source_path: 'source.canvas', destination_path: 'moved.canvas' }];
    const f = await fixture({ 'source.canvas': original });
    const remoteNodes = nodes.map((node) => node.id === 'node-0' ? { ...node, color: '2' } : node);
    const remote = await commit(f, f.m0, { 'source.canvas': JSON.stringify({ nodes: remoteNodes, edges: [] }) + '\n' });
    await setMain(f, remote);
    const movedNodes = [nodes[0]!, {
      id: 'local-node', type: 'text', x: 1200, y: 0, width: 200, height: 100, text: 'local payload'
    }];
    const moved = JSON.stringify({ nodes: movedNodes, edges: [] }) + '\n';
    const target = await commit(f, remote, { 'source.canvas': null, 'moved.canvas': moved });
    const naturalChanges = await f.server.git.changedPaths(f.auth.vault.vault_id, remote, target);
    expect(naturalChanges.some((entry) => entry.oldPath === 'source.canvas')).toBe(false);
    expect(naturalChanges.map((entry) => entry.path)).toEqual(expect.arrayContaining(['source.canvas', 'moved.canvas']));
    const request = await manifest(f, target, f.m0, undefined, canvasPair);
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('Canvas rename merge missing');
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, result.main, 'source.canvas')).toBeNull();
    const merged = JSON.parse(await blob(f, result.main, 'moved.canvas')) as { nodes: Array<{ id: string; color?: string }> };
    expect(merged.nodes).toContainEqual(expect.objectContaining({ id: 'node-0', color: '2' }));
    expect(merged.nodes).toContainEqual(expect.objectContaining({ id: 'local-node' }));
  });

  it.each(['keep_server', 'use_device'] as const)('reviews a low-similarity explicit move and resolves both endpoints with %s', async (resolutionKind) => {
    const original = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const f = await fixture({ 'source.md': original });
    const remote = await commit(f, f.m0, { 'source.md': original.replace('line 50', 'REMOTE line 50') });
    await setMain(f, remote);
    const deviceContent = `local addition\n${original.replace('line 50', 'DEVICE line 50').split('\n').slice(40).join('\n')}`;
    const target = await commit(f, remote, { 'source.md': null, 'moved.md': deviceContent });
    const request = await manifest(f, target, f.m0, undefined, pair);
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    expect(result.status).toBe('conflicted');
    if (result.status !== 'conflicted') throw new Error('expected rename conflict');
    const review = await f.server.sync.getConflictReviewPackage(f.auth.vault.vault_id, result.conflict_id);
    expect(review.path_conflicts).toContainEqual(expect.objectContaining({
      base_path: 'source.md', server_path: 'source.md', device_path: 'moved.md',
      affected_paths: expect.arrayContaining(['source.md', 'moved.md'])
    }));
    const resolved = await f.server.sync.resolveConflict({ actorUserId: f.auth.user.user_id, vaultId: f.auth.vault.vault_id,
      conflictId: result.conflict_id, expectedMain: remote, resolutionKind });
    expect(resolved.status).toBe('resolved');
    if (resolutionKind === 'keep_server') {
      expect(await blob(f, resolved.main, 'source.md')).toBe(original.replace('line 50', 'REMOTE line 50'));
      expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, resolved.main, 'moved.md')).toBeNull();
    } else {
      expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, resolved.main, 'source.md')).toBeNull();
      expect(await blob(f, resolved.main, 'moved.md')).toBe(deviceContent);
    }
  });

  it('roundtrips rename identity in chunk sessions and merges binary moves without content merging', async () => {
    const bytes = Buffer.from([0, 255, 1, 128]);
    const f = await fixture({ 'source.md': bytes, 'unrelated.md': 'base\n' });
    const remote = await commit(f, f.m0, { 'unrelated.md': 'canonical\n' });
    await setMain(f, remote);
    const target = await commit(f, remote, { 'source.md': null, 'moved.md': bytes });
    const request = await manifest(f, target, f.m0, 'rename-chunk-attempt', pair);
    expect(f.server.chunkTransfers.capabilities().capabilities).toContain('rename-pairs-v1');
    const transfer = await f.server.chunkTransfers.createPush(f.auth, {
      ...request.manifest, attempt_id: 'rename-chunk-attempt', chunk_count: 1, plan_sha256: sha256Hex('rename-plan')
    });
    const session = JSON.parse(await readFile(join(f.server.config.transferDir, transfer.descriptor.transfer_id, 'session.json'), 'utf8')) as {
      manifest: DevicePushManifest;
    };
    expect(session.manifest.rename_pairs).toEqual(pair);
    await f.server.chunkTransfers.putChunk(f.auth, transfer.descriptor.transfer_id, 0, request.pack, sha256Hex(request.pack));
    const result = await f.server.chunkTransfers.finalizePush(f.auth, transfer.descriptor.transfer_id);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('binary rename merge missing');
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, result.main, 'source.md')).toBeNull();
    expect(await f.server.git.readBlobAtPath(f.auth.vault.vault_id, result.main, 'moved.md')).toEqual(bytes);
    expect(await blob(f, result.main, 'unrelated.md')).toBe('canonical\n');
  });

  it('requires explicit base identity and rejects malformed pairs before device ref movement', async () => {
    const f = await fixture({ 'source.md': BASE });
    const target = await commit(f, f.m0, { 'source.md': null, 'moved.md': BASE });
    const request = await manifest(f, target, f.m0, undefined, pair);
    delete request.manifest.base_commit;
    const result = await multipart(f, request);
    expect(result.status).toBe(400);
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(f.m0);
    const bad = await manifest(f, target);
    bad.manifest.rename_pairs = [{ source_path: '../source.md', destination_path: 'moved.md' }];
    const malformed = await multipart(f, bad);
    expect(malformed.status).toBe(400);
    const halfPairTarget = await commit(f, f.m0, { 'source.md': null });
    const halfPair = await manifest(f, halfPairTarget, f.m0, undefined, pair);
    expect((await multipart(f, halfPair)).result).toMatchObject({ error: { code: 'invalid_rename_pair' } });
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(f.m0);
  });

  it('rejects retry metadata changes, including omission and a new attempt ID', async () => {
    const f = await fixture({ 'source.md': BASE });
    const target = await commit(f, f.m0, { 'source.md': null, 'moved.md': BASE });
    const original = await manifest(f, target, f.m0, 'rename-attempt-original', pair);
    await expect(f.server.sync.pushDeviceCommit(f.auth, original.manifest, original.pack)).resolves.toMatchObject({ status: 'merged' });
    const exactReplay = await manifest(f, target, f.m0, 'rename-attempt-exact-replay', pair);
    await expect(f.server.sync.pushDeviceCommit(f.auth, exactReplay.manifest, exactReplay.pack)).resolves.toMatchObject({ status: 'noop' });
    const changedPairs: DevicePushManifest['rename_pairs'] = [{ source_path: 'source.md', destination_path: 'other.md' }];
    for (const [attempt, pairs] of [['rename-attempt-omitted', undefined], ['rename-attempt-changed', changedPairs]] as Array<[string, DevicePushManifest['rename_pairs']]>) {
      const retry = await manifest(f, target, f.m0, attempt, pairs);
      await expect(f.server.sync.pushDeviceCommit(f.auth, retry.manifest, retry.pack)).rejects.toMatchObject({ code: 'rename_pairs_mismatch' });
    }
  });

  it.each(['absent', 'null'] as const)('resumes an ordinary modern push with %s optional rename metadata', async (optionalMetadata) => {
    const f = await fixture();
    const target = await commit(f, f.m0, { 'note.md': LOCAL });
    const request = await manifest(f, target, f.m0, 'modern-unpaired-recovery');
    Object.assign(request.manifest, { root_ignore_capability: 'root-ignore-v1', root_ignore_oid: null });
    vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit')
      .mockRejectedValueOnce(new Error('simulated interruption after device ref'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('simulated interruption');
    await f.server.store.mutate((db) => {
      const operation = db.sync_operations.find((row) => row.target_commit === target)!;
      expect(operation.prepared_manifest?.rename_pairs).toBeNull();
      if (optionalMetadata === 'absent') delete operation.prepared_manifest!.rename_pairs;
    });
    vi.restoreAllMocks();
    const merge = vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: (...args: unknown[]) => Promise<PushResult> }, 'mergeDeviceCommit');
    await f.server.sync.resumePendingMerges();
    expect(merge.mock.calls[0]?.[7]).toMatchObject({ root_ignore_capability: 'root-ignore-v1', root_ignore_oid: null });
    const main = await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main');
    expect(await blob(f, main!, 'note.md')).toBe(LOCAL);
  });

  it.each([false, true])('resumes a device-ref-advanced rename using its admitted pair; modern=%s', async (modern) => {
    const original = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const f = await fixture({ 'source.md': original });
    const main = await commit(f, f.m0, { 'source.md': `${original}remote addition\n` });
    await setMain(f, main);
    const target = await commit(f, main, { 'source.md': null, 'moved.md': `local addition\n${original.split('\n').slice(40).join('\n')}` });
    const request = await manifest(f, target, f.m0, 'rename-recovery-attempt', pair);
    if (modern) Object.assign(request.manifest, { root_ignore_capability: 'root-ignore-v1', root_ignore_oid: null });
    vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit')
      .mockRejectedValueOnce(new Error('simulated interruption after device ref'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('simulated interruption');
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(target);
    const operation = (await f.server.store.snapshot()).sync_operations.find((row) => row.target_commit === target)!;
    expect(operation.prepared_manifest?.rename_pairs).toEqual(pair);
    vi.restoreAllMocks();
    await f.server.sync.resumePendingMerges();
    const resumedMain = await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main');
    expect(resumedMain).not.toBe(main);
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, resumedMain!, 'source.md')).toBeNull();
    expect(await blob(f, resumedMain!, 'moved.md')).toContain('remote addition');
  });

  it.each([
    [{ source_path: 'source.md', destination_path: 'moved.md', confidence: 'inferred' }], false, 0, ''
  ].map((corruptPairs) => ({ corruptPairs })))('fails closed when durable rename-pair evidence is corrupted before resume: $corruptPairs', async ({ corruptPairs }) => {
    const f = await fixture({ 'source.md': BASE });
    const target = await commit(f, f.m0, { 'source.md': null, 'moved.md': BASE });
    const request = await manifest(f, target, f.m0, 'rename-corrupt-resume', pair);
    vi.spyOn(f.server.sync as unknown as { mergeDeviceCommit: () => Promise<PushResult> }, 'mergeDeviceCommit')
      .mockRejectedValueOnce(new Error('simulated interruption after device ref'));
    await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toThrow('simulated interruption');
    const operation = (await f.server.store.snapshot()).sync_operations.find((row) => row.target_commit === target)!;
    await f.server.store.mutate((db) => {
      const row = db.sync_operations.find((candidate) => candidate.operation_id === operation.operation_id)!;
      row.prepared_manifest!.rename_pairs = corruptPairs;
    });
    vi.restoreAllMocks();
    await expect(f.server.sync.resumePendingMerges()).rejects.toThrow('Prepared rename pair identity is invalid.');
    expect(await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main')).toBe(f.m0);
    expect(await f.server.git.getRef(f.auth.vault.vault_id, f.auth.device.device_ref)).toBe(target);
    const preserved = (await f.server.store.snapshot()).sync_operations.find((row) => row.operation_id === operation.operation_id)!;
    expect(preserved.prepared_manifest?.rename_pairs).toEqual(corruptPairs);
  });

  it('protects both endpoints for overlapping edits and occupied destinations', async () => {
    const f = await fixture({ 'source.md': BASE });
    const main = await commit(f, f.m0, { 'source.md': BASE.replace('first', 'remote') });
    await setMain(f, main);
    const target = await commit(f, main, { 'source.md': null, 'moved.md': BASE.replace('first', 'device') });
    const request = await manifest(f, target, f.m0, undefined, pair);
    const result = await f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack);
    await expectConflict(f, result, main);
    const conflict = (await f.server.store.snapshot()).conflicts.at(-1)!;
    expect(conflict.affected_paths).toEqual(['moved.md', 'source.md']);
    expect(await blob(f, main, 'source.md')).toBe(BASE.replace('first', 'remote'));
    const resolved = await f.server.sync.resolveConflict({ actorUserId: f.auth.user.user_id, vaultId: f.auth.vault.vault_id,
      conflictId: conflict.conflict_id, expectedMain: main, resolutionKind: 'use_device' });
    expect(resolved.status).toBe('resolved');
    expect(await f.server.git.readBlobAtPathIfPresent(f.auth.vault.vault_id, resolved.main, 'source.md')).toBeNull();
    expect(await blob(f, resolved.main, 'moved.md')).toBe(BASE.replace('first', 'device'));

    const occupied = await fixture({ 'source.md': BASE });
    const collisionMain = await commit(occupied, occupied.m0, { 'moved.md': 'canonical occupant\n' });
    await setMain(occupied, collisionMain);
    const collisionTarget = await commit(occupied, occupied.m0, { 'source.md': null, 'moved.md': BASE });
    const collisionRequest = await manifest(occupied, collisionTarget, occupied.m0, undefined, pair);
    const collision = await occupied.server.sync.pushDeviceCommit(occupied.auth, collisionRequest.manifest, collisionRequest.pack);
    await expectConflict(occupied, collision, collisionMain);
    expect((await occupied.server.store.snapshot()).conflicts.at(-1)?.affected_paths).toEqual(['moved.md', 'source.md']);

    const competing = await fixture({ 'source.md': BASE });
    const competingMain = await commit(competing, competing.m0, {
      'source.md': null, 'other.md': BASE, 'moved.md': 'independent destination content\n'
    });
    await setMain(competing, competingMain);
    const competingTarget = await commit(competing, competing.m0, {
      'source.md': null, 'moved.md': 'device destination content\n'
    });
    const competingRequest = await manifest(competing, competingTarget, competing.m0, undefined, pair);
    const competingResult = await competing.server.sync.pushDeviceCommit(competing.auth, competingRequest.manifest, competingRequest.pack);
    expect(competingResult.status, JSON.stringify(competingResult)).toBe('conflicted');
    await expectConflict(competing, competingResult, competingMain);
    expect((await competing.server.store.snapshot()).conflicts.at(-1)?.affected_paths).toEqual(['moved.md', 'other.md', 'source.md']);
  });
});

it('retains the existing default-settings protected conflict for a pre-K destination edit', async () => {
  const f = await fixture({ 'old.md': BASE, 'inherited.md': 'base\n' });
  const k = await commit(f, f.m0, { 'old.md': null, 'renamed.md': BASE });
  await setMain(f, k);
  const d = await commit(f, k, { 'renamed.md': LOCAL });
  await expectConflict(f, await push(f, d), k);
  expect((await f.server.store.snapshot()).conflicts.at(-1)?.validator_results.reason).toBe('rename_path_collision');
  expect(await blob(f, k, 'renamed.md')).toBe(BASE);
  expect(await blob(f, d, 'renamed.md')).toBe(LOCAL);
});
