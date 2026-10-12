import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/server/gitService.js';
import { API_VERSION } from '../src/shared/types.js';
import { createObtsServer, type CreateObtsServerOptions, type ObtsServer } from '../src/server/app.js';
import type { DeviceRemovalCheckpoint } from '../src/server/deviceRemovalService.js';
import { DashboardHarness } from './helpers/dashboardHttpHarness.js';

const run = promisify(execFile);
const SECRET = 'device-removal-test-signing-secret';
const PASSWORD = 'correct horse battery staple';
const DEVICE_A_NAME = 'Synthetic Phone A';
const DEVICE_B_NAME = 'Synthetic Laptop B';

type Headers = { cookie: string; 'x-obts-csrf': string };
type Enrolled = { deviceId: string; token: string; headers: { authorization: string }; connectionId: string; connectionSecret: string; name: string };
type Fixture = {
  server: ObtsServer;
  owner: Headers;
  userId: string;
  vaultId: string;
  m0: string;
  a: Enrolled;
};

const roots: string[] = [];
const servers: ObtsServer[] = [];
const harness = new DashboardHarness();

afterEach(async () => {
  await harness.cleanup();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function boot(options: CreateObtsServerOptions = {}, dataDir?: string): Promise<ObtsServer> {
  let dir = dataDir;
  if (dir === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'obts-device-removal-'));
    roots.push(root);
    dir = join(root, 'data');
  }
  const server = await createObtsServer({ dataDir: dir, sessionSecret: SECRET }, { readiness: { autoStart: false }, ...options });
  servers.push(server);
  return server;
}

async function setupOwner(server: ObtsServer): Promise<{ owner: Headers; userId: string }> {
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: PASSWORD } });
  expect(setup.statusCode).toBe(201);
  return {
    owner: { cookie: String(setup.headers['set-cookie']).split(';')[0]!, 'x-obts-csrf': setup.json().csrf_token as string },
    userId: setup.json().user_id as string
  };
}

async function login(server: ObtsServer, username: string): Promise<Headers> {
  const response = await server.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-obts-csrf': response.json().csrf_token as string };
}

async function secondOwner(f: Fixture): Promise<Headers> {
  const created = await f.server.app.inject({
    method: 'POST', url: '/api/v1/admin/users', headers: f.owner,
    payload: { username: 'second', password: PASSWORD, display_name: 'Second' }
  });
  expect(created.statusCode).toBe(201);
  return await login(f.server, 'second');
}

async function currentMain(server: ObtsServer, vaultId: string): Promise<string> {
  return (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === vaultId)!.current_main;
}

async function enroll(server: ObtsServer, owner: Headers, vaultId: string, name: string): Promise<Enrolled> {
  const main = await currentMain(server, vaultId);
  const connection = await server.app.inject({
    method: 'POST', url: '/api/v1/connections', payload: {
      plugin_version: '0.6.0', device_name: name, local_vault_name: 'Synthetic local vault',
      local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    }
  });
  expect(connection.statusCode).toBe(201);
  const connectionId = connection.json().connection_id as string;
  const connectionSecret = connection.json().connection_secret as string;
  const approved = await server.app.inject({
    method: 'POST', url: `/api/v1/connections/${connectionId}/approve`, headers: owner,
    payload: { selection: 'existing_vault', vault_id: vaultId }
  });
  expect(approved.statusCode).toBe(200);
  const completed = await server.app.inject({
    method: 'POST', url: `/api/v1/connections/${connectionId}/complete`,
    headers: { authorization: `Bearer ${connectionSecret}` }, payload: { mode: 'use_server', expected_main: main, proposal_base: null }
  });
  expect(completed.statusCode).toBe(201);
  const token = completed.json().device_token as string;
  const headers = { authorization: `Bearer ${token}` };
  expect((await server.app.inject({ method: 'POST', url: `/api/v1/vaults/${vaultId}/sync/applied`, headers, payload: { applied_main: main } })).statusCode).toBe(200);
  expect((await server.app.inject({ method: 'POST', url: `/api/v1/vaults/${vaultId}/onboarding/complete`, headers, payload: { applied_main: main } })).statusCode).toBe(200);
  return { deviceId: completed.json().device_id as string, token, headers, connectionId, connectionSecret, name };
}

async function fixture(options: CreateObtsServerOptions = {}, existing?: ObtsServer): Promise<Fixture> {
  const server = existing ?? await boot(options);
  const { owner, userId } = await setupOwner(server);
  const vault = await server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: owner, payload: { display_name: 'Synthetic removal vault' } });
  expect(vault.statusCode).toBe(201);
  const vaultId = vault.json().vault_id as string;
  const a = await enroll(server, owner, vaultId, DEVICE_A_NAME);
  return { server, owner, userId, vaultId, m0: vault.json().current_main as string, a };
}

let sequence = 0;
async function commit(f: Fixture, parent: string, content?: string, path?: string): Promise<string> {
  const tree = await f.server.git.createTreeFromCommitWithChanges({
    vaultId: f.vaultId, sourceCommit: parent, writes: new Map([[path ?? `note-${++sequence}.md`, Buffer.from(`${content ?? `synthetic ${sequence}`}\n`)]]), deletes: []
  });
  return await f.server.git.createMainCommitFromTree({
    vaultId: f.vaultId, tree, parentMain: parent, subject: `removal fixture ${sequence}`, body: '', actor: 'fixture'
  });
}

async function push(f: Fixture, device: Enrolled, target: string, base: string) {
  const parts = await pushParts(f, device, target, base);
  return await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push`,
    headers: { ...device.headers, 'content-type': parts.contentType }, payload: parts.payload
  });
}

async function pushParts(f: Fixture, device: Enrolled, target: string, base: string): Promise<{ contentType: string; payload: Buffer }> {
  const pack = await f.server.git.exportPack(f.vaultId, target, base);
  const row = (await f.server.store.snapshot()).devices.find((candidate) => candidate.device_id === device.deviceId)!;
  const manifest = {
    api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: device.deviceId,
    expected_device_ref: row.device_ref_head, target_commit: target, client_known_main: base,
    packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length
  };
  const boundary = 'obts-removal-fixture';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      pack, Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

const refOf = (device: Enrolled) => `refs/obts/devices/${device.deviceId}`;

/** A device whose pushed commit was integrated into main, so its ref is an ancestor of main. */
async function pushMerged(f: Fixture, device: Enrolled): Promise<string> {
  const base = await currentMain(f.server, f.vaultId);
  const target = await commit(f, base);
  const response = await push(f, device, target, base);
  expect(response.statusCode).toBe(200);
  expect(await currentMain(f.server, f.vaultId)).toBe(target);
  expect(await f.server.git.getRef(f.vaultId, refOf(device))).toBe(target);
  return target;
}

/** Points the device ref at a commit that is not reachable from main, keeping the row consistent. */
async function makeUnmerged(f: Fixture, device: Enrolled): Promise<string> {
  const main = await currentMain(f.server, f.vaultId);
  const unmerged = await commit(f, main, 'unmerged device work');
  const previous = await f.server.git.getRef(f.vaultId, refOf(device));
  await f.server.git.updateRef(f.vaultId, refOf(device), unmerged, previous);
  await f.server.store.mutate((db) => { db.devices.find((row) => row.device_id === device.deviceId)!.device_ref_head = unmerged; });
  return unmerged;
}

async function revoke(f: Fixture, device: Enrolled) {
  const response = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/devices/${device.deviceId}/revoke`, headers: f.owner, payload: {}
  });
  expect(response.statusCode).toBe(200);
}

const phrase = (device: Enrolled) => `DELETE ${device.deviceId}`;
const discardPhrase = (device: Enrolled) => `DELETE ${device.deviceId} AND DISCARD UNMERGED WORK`;

async function remove(f: Fixture, device: Enrolled, payload: unknown, headers: Record<string, string> = f.owner, vaultId = f.vaultId) {
  return await f.server.app.inject({ method: 'DELETE', url: `/api/v1/vaults/${vaultId}/devices/${device.deviceId}`, headers, payload: payload as Record<string, unknown> });
}

async function snapshot(f: Fixture) {
  return await f.server.store.snapshot();
}

async function hasDevice(f: Fixture, device: Enrolled) {
  return (await snapshot(f)).devices.some((row) => row.device_id === device.deviceId);
}

async function journal(f: Fixture, device: Enrolled) {
  return (await snapshot(f)).device_removal_jobs.find((job) => job.device_id === device.deviceId) ?? null;
}

async function dashboardDevices(f: Fixture) {
  const response = await f.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${f.vaultId}/dashboard`, headers: { cookie: f.owner.cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().devices as Array<{ device_id: string; revoked_at: string | null; removal: { state: string; retryable: boolean; error_code: string | null } | null }>;
}

function failOnce(point: DeviceRemovalCheckpoint) {
  const state = { armed: true };
  return {
    state,
    options: {
      deviceRemoval: {
        checkpoint: (reached: DeviceRemovalCheckpoint) => {
          if (state.armed && reached === point) {
            state.armed = false;
            throw new Error(`injected failure at ${point}`);
          }
        }
      }
    } satisfies CreateObtsServerOptions
  };
}

async function deviceSelf(f: Fixture, device: Enrolled) {
  return await f.server.app.inject({ method: 'GET', url: '/api/v1/device/self', headers: device.headers });
}

async function replayConnection(f: Fixture, device: Enrolled) {
  return await f.server.app.inject({
    method: 'POST', url: `/api/v1/connections/${device.connectionId}/complete`,
    headers: { authorization: `Bearer ${device.connectionSecret}` },
    payload: { mode: 'use_server', expected_main: await currentMain(f.server, f.vaultId), proposal_base: null }
  });
}

async function transferDirs(f: Fixture): Promise<string[]> {
  try {
    return (await readdir(f.server.config.transferDir)).filter((name) => name.startsWith('trn_'));
  } catch {
    return [];
  }
}

async function gitRefs(f: Fixture, vaultId = f.vaultId): Promise<string[]> {
  const { stdout } = await run('git', ['--git-dir', join(f.server.config.dataDir, 'git', `${vaultId}.git`), 'for-each-ref', '--format=%(refname) %(objectname)']);
  return stdout.split('\n').filter(Boolean).sort();
}

async function mainHistory(f: Fixture): Promise<string> {
  const { stdout } = await run('git', ['--git-dir', join(f.server.config.dataDir, 'git', `${f.vaultId}.git`), 'log', '--format=%H', 'refs/heads/main']);
  return stdout;
}

describe('permanent device removal API', () => {
  it('enforces session, CSRF and exact owner scope before revealing anything about the device', async () => {
    const f = await fixture();
    await revoke(f, f.a);
    const payload = { confirmation: phrase(f.a) };
    const url = `/api/v1/vaults/${f.vaultId}/devices/${f.a.deviceId}`;

    expect((await f.server.app.inject({ method: 'DELETE', url, payload })).statusCode).toBe(401);
    const noCsrf = await f.server.app.inject({ method: 'DELETE', url, headers: { cookie: f.owner.cookie }, payload });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_required');
    const wrongCsrf = await remove(f, f.a, payload, { cookie: f.owner.cookie, 'x-obts-csrf': 'not-the-token' });
    expect(wrongCsrf.statusCode).toBe(403);
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(await journal(f, f.a)).toBeNull();

    const other = await secondOwner(f);
    const otherVault = await f.server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: other, payload: { display_name: 'Other owner vault' } });
    const otherVaultId = otherVault.json().vault_id as string;
    const strip = (body: { error: Record<string, unknown> }) => ({ ...body.error, request_id: undefined });
    const foreignOwner = await remove(f, f.a, payload, other);
    const unknownDevice = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${f.vaultId}/devices/dev_doesnotexist`, headers: f.owner, payload
    });
    const foreignVaultPath = await remove(f, f.a, payload, f.owner, otherVaultId);
    const wrongVaultForDevice = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${otherVaultId}/devices/${f.a.deviceId}`, headers: other, payload
    });
    for (const response of [foreignOwner, unknownDevice, foreignVaultPath, wrongVaultForDevice]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
      expect(strip(response.json())).toEqual(strip(foreignOwner.json()));
    }
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(await journal(f, f.a)).toBeNull();
  });

  it('refuses active devices and requires the exact confirmation phrase for the chosen mode', async () => {
    const f = await fixture();
    const active = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(active.statusCode).toBe(409);
    expect(active.json().error.code).toBe('device_not_revoked');
    expect((await deviceSelf(f, f.a)).statusCode).toBe(200);

    await revoke(f, f.a);
    const bodies: unknown[] = [
      {}, { confirmation: 5 }, { confirmation: '' }, { confirmation: phrase(f.a).toLowerCase() }, { confirmation: `${phrase(f.a)} ` },
      { confirmation: `DELETE ${f.a.deviceId}x` }, { confirmation: discardPhrase(f.a) },
      { confirmation: phrase(f.a), discard_unmerged: true }, { confirmation: discardPhrase(f.a), discard_unmerged: false }
    ];
    for (const body of bodies) {
      const response = await remove(f, f.a, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json().error.code).toBe('confirmation_mismatch');
    }
    const invalid = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: 'yes' });
    expect(invalid.statusCode).toBe(400);
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(await journal(f, f.a)).toBeNull();
  });

  it('removes a covered device without touching main, history, other devices or other vaults', async () => {
    const f = await fixture();
    const b = await enroll(f.server, f.owner, f.vaultId, DEVICE_B_NAME);
    const aHead = await pushMerged(f, f.a);
    const bHead = await pushMerged(f, b);
    const otherVault = await f.server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: f.owner, payload: { display_name: 'Untouched vault' } });
    const otherVaultId = otherVault.json().vault_id as string;
    const otherEnrolled = await enroll(f.server, f.owner, otherVaultId, 'Other vault device');
    const otherRefsBefore = await gitRefs(f, otherVaultId);
    const main = await currentMain(f.server, f.vaultId);
    await revoke(f, f.a);
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)).toMatchObject({ removal: null, revoked_at: expect.any(String) });
    expect((await deviceSelf(f, f.a)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await replayConnection(f, f.a)).statusCode).toBeGreaterThanOrEqual(400);
    const historyBefore = await mainHistory(f);
    const refsBefore = (await gitRefs(f)).filter((line) => !line.startsWith(refOf(f.a)));

    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'removed', device_id: f.a.deviceId });

    const db = await snapshot(f);
    expect(db.devices.some((row) => row.device_id === f.a.deviceId)).toBe(false);
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.tokens.some((token) => token.device_id === f.a.deviceId)).toBe(false);
    expect(db.connections.some((connection) => connection.created_device_id === f.a.deviceId)).toBe(false);
    expect(db.devices.find((row) => row.device_id === b.deviceId)).toMatchObject({ device_ref_head: bHead });
    expect(db.devices.find((row) => row.device_id === b.deviceId)!.status).not.toBe('revoked');
    expect(db.devices.some((row) => row.device_id === otherEnrolled.deviceId)).toBe(true);
    expect(db.vaults.find((vault) => vault.vault_id === f.vaultId)!.current_main).toBe(main);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await f.server.git.getRef(f.vaultId, refOf(b))).toBe(bHead);
    expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(main);
    expect(await f.server.git.ancestryVerdict(f.vaultId, aHead, main)).toBe('ancestor');
    expect(await mainHistory(f)).toBe(historyBefore);
    expect(await gitRefs(f)).toEqual(refsBefore);
    expect(await gitRefs(f, otherVaultId)).toEqual(otherRefsBefore);
    expect((await dashboardDevices(f)).map((row) => row.device_id)).toEqual([b.deviceId]);
    expect((await deviceSelf(f, b)).statusCode).toBe(200);

    const again = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('not_found');
  });

  it('keeps revoked tokens and connection replays denied after removal and after restart', async () => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
    const denied = async (g: Fixture) => {
      expect((await deviceSelf(g, f.a)).statusCode).toBeGreaterThanOrEqual(400);
      const replay = await replayConnection(g, f.a);
      expect(replay.statusCode).toBeGreaterThanOrEqual(400);
      expect(replay.json().device_token).toBeUndefined();
      const events = await g.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${g.vaultId}/sync/events`, headers: f.a.headers });
      expect(events.statusCode).toBeGreaterThanOrEqual(400);
    };
    await denied(f);
    const dataDir = f.server.config.dataDir;
    await f.server.app.close();
    const restarted = await boot({}, dataDir);
    await denied({ ...f, server: restarted });
    expect((await restarted.store.snapshot()).devices.some((row) => row.device_id === f.a.deviceId)).toBe(false);
  });

  it('records one minimal audit event with opaque ids only and keeps earlier provenance', async () => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const before = (await snapshot(f)).audit_log.length;
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
    const db = await snapshot(f);
    const removed = db.audit_log.filter((row) => row.action === 'device_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual({
      audit_id: expect.any(String), actor_user_id: f.userId, actor_device_id: null, vault_id: f.vaultId,
      action: 'device_removed', resource_class: 'device', resource_id: f.a.deviceId, created_at: expect.any(String)
    });
    expect(db.audit_log.length).toBe(before + 1);
    expect(JSON.stringify(removed)).not.toContain(DEVICE_A_NAME);
    expect(db.audit_log.some((row) => row.action === 'device_revoked' && row.resource_id === f.a.deviceId)).toBe(true);
  });
});

describe('device removal eligibility', () => {
  it('refuses unmerged work without the explicit opt-in and removes it with the discard phrase', async () => {
    const f = await fixture();
    const b = await enroll(f.server, f.owner, f.vaultId, DEVICE_B_NAME);
    const bHead = await pushMerged(f, b);
    const unmerged = await makeUnmerged(f, f.a);
    const main = await currentMain(f.server, f.vaultId);
    await revoke(f, f.a);

    const refused = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('device_has_unmerged_work');
    expect(await journal(f, f.a)).toBeNull();
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(unmerged);
    expect(await hasDevice(f, f.a)).toBe(true);

    const discarded = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(discarded.statusCode).toBe(200);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(main);
    expect(await f.server.git.getRef(f.vaultId, refOf(b))).toBe(bHead);
  });

  it('blocks removal while the device has an open conflict and never resolves it automatically', async () => {
    const f = await fixture();
    const base = await pushMerged(f, f.a);
    const remote = await commit(f, base, 'remote change', 'shared-note.md');
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', remote, base);
    await f.server.store.mutate((db) => { db.vaults.find((row) => row.vault_id === f.vaultId)!.current_main = remote; });
    const local = await commit(f, base, 'local change', 'shared-note.md');
    const conflicted = await push(f, f.a, local, base);
    expect(conflicted.json().status).toBe('conflicted');
    const conflictId = conflicted.json().conflict_id as string;
    await revoke(f, f.a);

    const blocked = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('device_has_open_work');
    expect(blocked.json().error.details).toEqual({ reason: 'open_conflict' });
    const db = await snapshot(f);
    expect(db.conflicts.find((conflict) => conflict.conflict_id === conflictId)!.status).toBe('open');
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.devices.some((row) => row.device_id === f.a.deviceId)).toBe(true);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();

    const resolved = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflictId}/resolve`, headers: f.owner,
      payload: { expected_main: remote, resolution_kind: 'keep_server' }
    });
    expect(resolved.statusCode).toBe(200);
    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    // Resolved conflicts stay as provenance even though the device row is gone.
    expect((await snapshot(f)).conflicts.find((conflict) => conflict.conflict_id === conflictId)).toMatchObject({ status: 'resolved' });
  });

  it.each(['started', 'prepared'] as const)('blocks removal while a %s operation of the device is unsettled', async (status) => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const operationId = await f.server.store.mutate((db) => {
      const operation = f.server.store.startOperation(db, {
        vault_id: f.vaultId, device_id: f.a.deviceId, operation_type: 'device_push',
        expected_refs: {}, target_refs: {}, target_commit: null
      });
      operation.status = status;
      return operation.operation_id;
    });
    const blocked = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('device_has_open_work');
    expect(blocked.json().error.details).toEqual({ reason: 'unsettled_operation' });
    expect(await journal(f, f.a)).toBeNull();
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();

    await f.server.store.mutate((db) => { db.sync_operations.find((row) => row.operation_id === operationId)!.status = 'aborted'; });
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
  });

  it('fails closed with a retryable 503 when ancestry cannot be verified and changes nothing', async () => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const original = f.server.git.ancestryVerdict.bind(f.server.git);
    let unknown = true;
    f.server.git.ancestryVerdict = async (...args) => (unknown ? 'unknown' : await original(...args));
    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('device_removal_unavailable');
    expect(response.headers['retry-after']).toBeDefined();
    expect(await journal(f, f.a)).toBeNull();
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();
    unknown = false;
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
  });
});

describe('device removal ref compare-and-swap', () => {
  it('starts a new generation with a new durable expected OID when the ref moves after intent', async () => {
    let race: (() => Promise<void>) | null = null;
    const seen: Array<{ generation: number; expected: string | null; phase: string }> = [];
    const holder: { server?: ObtsServer } = {};
    const f = await fixture({
      deviceRemoval: {
        checkpoint: async (point) => {
          if (point !== 'before_ref_delete') return;
          const job = (await holder.server!.store.snapshot()).device_removal_jobs[0]!;
          seen.push({ generation: job.generation, expected: job.expected_ref_oid, phase: job.phase });
          if (race) { const pending = race; race = null; await pending(); }
        }
      }
    });
    holder.server = f.server;
    const first = await pushMerged(f, f.a);
    await revoke(f, f.a);
    const advanced = await commit(f, first, 'device moved while removing');
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', advanced, first);
    await f.server.store.mutate((db) => { db.vaults.find((row) => row.vault_id === f.vaultId)!.current_main = advanced; });
    race = async () => { await f.server.git.updateRef(f.vaultId, refOf(f.a), advanced, first); };

    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([
      { generation: 1, expected: first, phase: 'ref_deleting' },
      { generation: 2, expected: advanced, phase: 'ref_deleting' }
    ]);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(advanced);
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  it('re-checks eligibility for the moved ref, refuses newly unmerged work, and never deletes it silently', async () => {
    let race: (() => Promise<void>) | null = null;
    const f = await fixture({
      deviceRemoval: { checkpoint: async (point) => { if (point === 'before_ref_delete' && race) { const pending = race; race = null; await pending(); } } }
    });
    const first = await pushMerged(f, f.a);
    await revoke(f, f.a);
    const unmerged = await commit(f, first, 'work that raced the removal');
    race = async () => { await f.server.git.updateRef(f.vaultId, refOf(f.a), unmerged, first); };

    const refused = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('device_has_unmerged_work');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(unmerged);
    expect(await journal(f, f.a)).toMatchObject({
      generation: 2, expected_ref_oid: unmerged, phase: 'intent', state: 'failed', retryable: false, error_code: 'device_has_unmerged_work'
    });
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)!.removal).toEqual({ state: 'failed', retryable: false, error_code: 'device_has_unmerged_work' });
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(true);

    const discarded = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(discarded.statusCode).toBe(200);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await journal(f, f.a)).toBeNull();
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
  });
});

describe('dashboard projection of the removal journal', () => {
  it('projects the stored safe error_code of a failed job and null while the removal is pending', async () => {
    const holder: { f?: Fixture } = {};
    const observed: Array<{ state: string; retryable: boolean; error_code: string | null } | null> = [];
    const f = await fixture({
      deviceRemoval: {
        checkpoint: async (point) => {
          if (point !== 'after_intent') return;
          observed.push((await dashboardDevices(holder.f!)).find((row) => row.device_id === holder.f!.a.deviceId)!.removal);
          throw new Error('injected failure after intent');
        }
      }
    });
    holder.f = f;
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)!.removal).toBeNull();

    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    expect(observed).toEqual([{ state: 'pending', retryable: true, error_code: null }]);
    const failed = (await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)!.removal;
    expect(failed).toEqual({ state: 'failed', retryable: true, error_code: 'device_removal_incomplete' });
    expect(failed?.error_code).toBe((await journal(f, f.a))!.error_code);
    expect(JSON.stringify(failed)).not.toContain('injected failure');
  });
});

describe('device removal barrier and drain', () => {
  it('commits the durable intent first, rejects new device work and waits for admitted work', async () => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const lease = f.server.lifecycle.tryAcquireDeviceLease(f.vaultId, f.a.deviceId);
    expect(lease).not.toBeNull();

    let settled = false;
    const removal = remove(f, f.a, { confirmation: phrase(f.a) }).then((response) => { settled = true; return response; });
    await expect.poll(async () => (await journal(f, f.a))?.phase, { timeout: 3_000 }).toBe('intent');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();
    expect((await snapshot(f)).tokens.some((token) => token.device_id === f.a.deviceId)).toBe(true);
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(true);
    expect(f.server.lifecycle.tryAcquireDeviceLease(f.vaultId, f.a.deviceId)).toBeNull();
    await expect(f.server.lifecycle.acquireDeviceLease(f.vaultId, f.a.deviceId)).rejects.toMatchObject({ statusCode: 404 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();

    lease!.release();
    const response = await removal;
    expect(response.statusCode).toBe(200);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
  });

  it('does not hold the vault admission while draining, so whole-vault deletion is never blocked', async () => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const lease = f.server.lifecycle.tryAcquireDeviceLease(f.vaultId, f.a.deviceId)!;
    const removal = remove(f, f.a, { confirmation: phrase(f.a) });
    await expect.poll(async () => (await journal(f, f.a)) !== null, { timeout: 3_000 }).toBe(true);

    const deletion = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${f.vaultId}`, headers: f.owner, payload: { confirmation: `DELETE ${f.vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    await expect.poll(async () => (await snapshot(f)).deletion_receipts.some((receipt) => receipt.vault_id === f.vaultId), { timeout: 5_000 }).toBe(true);
    const db = await snapshot(f);
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.devices.some((row) => row.vault_id === f.vaultId)).toBe(false);

    lease.release();
    const response = await removal;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('vault_deleting');
    expect((await snapshot(f)).device_removal_jobs).toEqual([]);
  });

  it('times out a stuck drain with a retryable 503, keeps the journal and resumes idempotently', async () => {
    const f = await fixture({ deviceRemoval: { drainTimeoutMs: 60 } });
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const lease = f.server.lifecycle.tryAcquireDeviceLease(f.vaultId, f.a.deviceId)!;
    const timedOut = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error.code).toBe('device_removal_incomplete');
    expect(timedOut.json().error.details).toEqual({ retryable: true });
    expect(timedOut.headers['retry-after']).toBeDefined();
    expect(await journal(f, f.a)).toMatchObject({ phase: 'intent', state: 'failed', retryable: true, error_code: 'device_removal_incomplete' });
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)!.removal).toEqual({ state: 'failed', retryable: true, error_code: 'device_removal_incomplete' });
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).not.toBeNull();

    lease.release();
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
    expect(await journal(f, f.a)).toBeNull();
  });

  it('drains a detached transfer processor that is still running and erases only the device transfer residue', async () => {
    const f = await fixture();
    const b = await enroll(f.server, f.owner, f.vaultId, DEVICE_B_NAME);
    const base = await currentMain(f.server, f.vaultId);
    const makeTransfer = async (device: Enrolled, attemptId: string) => {
      const target = await commit(f, base);
      const pack = await f.server.git.exportPack(f.vaultId, target, base);
      const created = await f.server.app.inject({
        method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers`, headers: device.headers,
        payload: {
          api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: device.deviceId,
          expected_device_ref: null, target_commit: target, client_known_main: base, attempt_id: attemptId,
          chunk_count: 1, plan_sha256: sha256Hex(Buffer.from(attemptId))
        }
      });
      expect(created.statusCode).toBe(201);
      const transferId = created.json().transfer_id as string;
      const uploaded = await f.server.app.inject({
        method: 'PUT', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/chunks/0`,
        headers: { ...device.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack) }, payload: pack
      });
      expect(uploaded.statusCode).toBe(200);
      return transferId;
    };
    const processing = await makeTransfer(f.a, 'attempt_removal_processing');
    const idle = await makeTransfer(f.a, 'attempt_removal_idle');
    const others = await makeTransfer(b, 'attempt_removal_other_device');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.server.sync.pushDeviceCommit.bind(f.server.sync);
    let entered = false;
    f.server.sync.pushDeviceCommit = async (...args) => {
      if (args[0].device.device_id === f.a.deviceId) { entered = true; await gate; }
      return await original(...args);
    };
    const finalized = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${processing}/finalize`,
      headers: { ...f.a.headers, prefer: 'respond-async' }
    });
    expect(finalized.statusCode).toBe(202);
    await expect.poll(() => entered, { timeout: 3_000 }).toBe(true);
    expect(await transferDirs(f)).toHaveLength(3);
    await revoke(f, f.a);

    // Both staged sessions of the device hold commits that are not in main, so removal needs the discard grant.
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).json().error.details).toEqual({ reason: 'staged_transfer' });
    expect(await journal(f, f.a)).toBeNull();
    let settled = false;
    const removal = remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true }).then((response) => { settled = true; return response; });
    await expect.poll(async () => (await journal(f, f.a)) !== null, { timeout: 3_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(f.server.lifecycle.tryAcquireDeviceLease(f.vaultId, f.a.deviceId)).toBeNull();
    expect(await hasDevice(f, f.a)).toBe(true);

    release();
    const response = await removal;
    expect(response.statusCode).toBe(200);
    const remaining = await transferDirs(f);
    expect(remaining).toEqual([others]);
    expect(remaining).not.toContain(processing);
    expect(remaining).not.toContain(idle);
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(await hasDevice(f, b)).toBe(true);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
  });
});

describe('device removal crash recovery', () => {
  const stages: DeviceRemovalCheckpoint[] = [
    'after_intent', 'after_drain', 'before_ref_delete', 'after_ref_delete',
    'after_credentials', 'after_replay', 'after_transfer_residue', 'after_bookkeeping'
  ];
  const refAlreadyGone = (stage: DeviceRemovalCheckpoint) => !['after_intent', 'after_drain', 'before_ref_delete'].includes(stage);

  it.each(stages)('keeps the journal after a failure at %s and a repeated request resumes without resurrection', async (stage) => {
    const injected = failOnce(stage);
    const f = await fixture(injected.options);
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const main = await currentMain(f.server, f.vaultId);

    const failed = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.code).toBe('device_removal_incomplete');
    expect(await journal(f, f.a)).toMatchObject({ state: 'failed', retryable: true, device_id: f.a.deviceId });
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(true);
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)!.removal).toEqual({ state: 'failed', retryable: true, error_code: 'device_removal_incomplete' });
    expect((await f.server.git.getRef(f.vaultId, refOf(f.a))) === null).toBe(refAlreadyGone(stage));
    expect((await deviceSelf(f, f.a)).statusCode).toBeGreaterThanOrEqual(400);

    const retried = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(retried.statusCode).toBe(200);
    const db = await snapshot(f);
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.devices.some((row) => row.device_id === f.a.deviceId)).toBe(false);
    expect(db.tokens.some((token) => token.device_id === f.a.deviceId)).toBe(false);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await currentMain(f.server, f.vaultId)).toBe(main);
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
    expect(db.audit_log.filter((row) => row.action === 'device_removed')).toHaveLength(1);
  });

  it.each(stages)('resumes a failure at %s on restart before serving, without resurrecting or flagging the device', async (stage) => {
    const injected = failOnce(stage);
    const f = await fixture(injected.options);
    await pushMerged(f, f.a);
    const b = await enroll(f.server, f.owner, f.vaultId, DEVICE_B_NAME);
    const bHead = await pushMerged(f, b);
    await revoke(f, f.a);
    const main = await currentMain(f.server, f.vaultId);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    expect((await f.server.git.getRef(f.vaultId, refOf(f.a))) === null).toBe(refAlreadyGone(stage));
    const dataDir = f.server.config.dataDir;
    await f.server.app.close();

    const restarted = await boot({}, dataDir);
    const g: Fixture = { ...f, server: restarted };
    const db = await snapshot(g);
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.devices.some((row) => row.device_id === f.a.deviceId)).toBe(false);
    expect(db.tokens.some((token) => token.device_id === f.a.deviceId)).toBe(false);
    expect(db.vaults.find((vault) => vault.vault_id === f.vaultId)).toMatchObject({ status: 'active', current_main: main });
    expect(await restarted.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await restarted.git.getRef(f.vaultId, refOf(b))).toBe(bHead);
    expect(db.devices.some((row) => row.device_id === b.deviceId)).toBe(true);
    expect(restarted.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
    expect((await deviceSelf(g, f.a)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await deviceSelf(g, b)).statusCode).toBe(200);
    expect((await restarted.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });

  it('restores the barrier before integrity scans so an intentionally missing ref is not flagged', async () => {
    const injected = failOnce('after_ref_delete');
    const f = await fixture(injected.options);
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    const dataDir = f.server.config.dataDir;
    await f.server.app.close();

    // The resumption fails again on restart: the journal must survive and the vault must stay healthy.
    const again = failOnce('after_credentials');
    const restarted = await boot(again.options, dataDir);
    const g: Fixture = { ...f, server: restarted, owner: await login(restarted, 'owner') };
    expect(await journal(g, f.a)).toMatchObject({ phase: 'cleanup', state: 'failed', retryable: true });
    expect(restarted.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(true);
    expect((await snapshot(g)).vaults.find((vault) => vault.vault_id === f.vaultId)!.status).toBe('active');
    expect(await restarted.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect((await deviceSelf(g, f.a)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await dashboardDevices(g)).find((row) => row.device_id === f.a.deviceId)!.removal).toEqual({ state: 'failed', retryable: true, error_code: 'device_removal_incomplete' });

    expect((await remove(g, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
    expect((await snapshot(g)).device_removal_jobs).toEqual([]);
    expect((await snapshot(g)).devices.some((row) => row.device_id === f.a.deviceId)).toBe(false);
  });

  it('lets whole-vault deletion supersede a pending removal journal, before and after a restart', async () => {
    const injected = failOnce('after_ref_delete');
    const f = await fixture(injected.options);
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    expect((await snapshot(f)).device_removal_jobs).toHaveLength(1);

    const deletion = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${f.vaultId}`, headers: f.owner, payload: { confirmation: `DELETE ${f.vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    await expect.poll(async () => (await snapshot(f)).deletion_receipts.some((receipt) => receipt.vault_id === f.vaultId), { timeout: 5_000 }).toBe(true);
    const db = await snapshot(f);
    expect(db.device_removal_jobs).toEqual([]);
    expect(db.vaults.some((vault) => vault.vault_id === f.vaultId)).toBe(false);
    const retry = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect([404, 409]).toContain(retry.statusCode);
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);

    const dataDir = f.server.config.dataDir;
    await f.server.app.close();
    const restarted = await boot({}, dataDir);
    expect((await restarted.store.snapshot()).device_removal_jobs).toEqual([]);
    expect(restarted.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
  });

  it('drops the removal journal when vault deletion was durably accepted but not yet erased at restart', async () => {
    const injected = failOnce('after_intent');
    const f = await fixture(injected.options);
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    const held = await f.server.lifecycle.acquireAdmission(f.vaultId);
    const deletion = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${f.vaultId}`, headers: f.owner, payload: { confirmation: `DELETE ${f.vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    expect((await snapshot(f)).deletion_jobs.some((job) => job.vault_id === f.vaultId)).toBe(true);
    expect((await snapshot(f)).device_removal_jobs).toEqual([]);
    const dataDir = f.server.config.dataDir;
    held.release();
    await f.server.app.close();
    const restarted = await boot({}, dataDir);
    await expect.poll(async () => (await restarted.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === f.vaultId), { timeout: 5_000 }).toBe(true);
    expect((await restarted.store.snapshot()).device_removal_jobs).toEqual([]);
  });

  it('whole-vault deletion revokes every device, keeps an earlier revoked_at and still erases the vault', async () => {
    const f = await fixture();
    const b = await enroll(f.server, f.owner, f.vaultId, 'Synthetic device B');
    await revoke(f, f.a);
    const earlier = (await snapshot(f)).devices.find((row) => row.device_id === f.a.deviceId)!.revoked_at;
    expect(earlier).toEqual(expect.any(String));
    const held = await f.server.lifecycle.acquireAdmission(f.vaultId);
    const deletion = await f.server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${f.vaultId}`, headers: f.owner, payload: { confirmation: `DELETE ${f.vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    const during = await snapshot(f);
    const rowA = during.devices.find((row) => row.device_id === f.a.deviceId)!;
    const rowB = during.devices.find((row) => row.device_id === b.deviceId)!;
    expect(rowA).toMatchObject({ status: 'revoked', revoked_at: earlier });
    expect(rowB).toMatchObject({ status: 'revoked', revoked_at: expect.any(String) });
    held.release();
    await expect.poll(async () => (await snapshot(f)).deletion_receipts.some((receipt) => receipt.vault_id === f.vaultId), { timeout: 5_000 }).toBe(true);
    const after = await snapshot(f);
    expect(after.devices.some((row) => row.vault_id === f.vaultId)).toBe(false);
    expect(after.vaults.some((vault) => vault.vault_id === f.vaultId)).toBe(false);
  });
});

describe('device removal dashboard notifications', () => {
  it('invalidates only the owner stream with opaque ids and omits the device from later summaries', async () => {
    const started = await harness.start({ readiness: { autoStart: false }, dashboardEvents: { coalesceMs: 10, heartbeatMs: 10_000 } });
    const f = await fixture({}, started.server);
    const intruder = await secondOwner(f);
    await pushMerged(f, f.a);
    await revoke(f, f.a);
    const owner = await harness.stream(started.baseUrl, f.owner.cookie);
    const stranger = await harness.stream(started.baseUrl, intruder.cookie);
    await owner.frameCount(1);
    await stranger.frameCount(1);
    const before = owner.frames().length;

    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(200);
    await owner.until(() => owner.frames().slice(before).some((frame) => frame.event === 'invalidate'));
    const invalidations = owner.frames().slice(before).filter((frame) => frame.event === 'invalidate');
    expect(invalidations.some((frame) => (frame.data as { vault_ids: string[] }).vault_ids.includes(f.vaultId))).toBe(true);
    for (const frame of invalidations) expect(Object.keys(frame.data as object).sort()).toEqual(['account', 'vault_ids']);
    expect(owner.body).not.toContain(f.a.deviceId);
    expect(owner.body).not.toContain(DEVICE_A_NAME);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stranger.frames()).toEqual([{ event: 'refresh', data: {} }]);
    expect((await dashboardDevices(f)).some((row) => row.device_id === f.a.deviceId)).toBe(false);
  });
});

type Live = { response: Promise<{ status: number; text: string }>; abort(): void; write(chunk: Buffer): void; end(): void };

/** A real HTTP request over a socket that the test can hold open, feed slowly or abort mid-flight. */
function liveRequest(baseUrl: string, method: string, path: string, headers: Record<string, string>, body?: Buffer, options: { held?: boolean } = {}): Live {
  const req = httpRequest(new URL(path, baseUrl), {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(body.length) }) }
  });
  const response = new Promise<{ status: number; text: string }>((resolve) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: 0, text: '' }));
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
  if (body !== undefined) {
    if (options.held) req.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
    else req.end(body);
  } else {
    req.end();
  }
  return {
    response,
    abort: () => req.destroy(),
    write: (chunk) => { req.write(chunk); },
    end: () => req.end()
  };
}

async function removeOverHttp(baseUrl: string, f: Fixture, device: Enrolled, payload: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/v1/vaults/${f.vaultId}/devices/${device.deviceId}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', cookie: f.owner.cookie, 'x-obts-csrf': f.owner['x-obts-csrf'] },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}

describe('device lease and vault admission fence over real HTTP', () => {
  async function started(options: CreateObtsServerOptions = {}) {
    const live = await harness.start({ readiness: { autoStart: false }, ...options });
    const f = await fixture({}, live.server);
    await pushMerged(f, f.a);
    return { f, baseUrl: live.baseUrl };
  }

  const counts = (f: Fixture) => ({
    leases: f.server.lifecycle.activeDeviceLeaseCount(f.vaultId, f.a.deviceId),
    admissions: f.server.lifecycle.activeAdmissionCount(f.vaultId)
  });

  type Kind = 'push' | 'chunk';
  // The push route takes its vault admission inside the service, the chunk route through the request hook.
  const held = (kind: Kind) => ({ leases: 1, admissions: kind === 'chunk' ? 1 : 0 });

  /** Holds a real request inside its route handler by gating the service call it makes. */
  async function startGated(f: Fixture, baseUrl: string, kind: Kind) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { entered: false };
    let request: Live;
    if (kind === 'push') {
      const base = await currentMain(f.server, f.vaultId);
      const target = await commit(f, base);
      const original = f.server.sync.pushDeviceCommit.bind(f.server.sync);
      f.server.sync.pushDeviceCommit = async (...args) => {
        if (args[0].device.device_id === f.a.deviceId) { state.entered = true; await gate; }
        return await original(...args);
      };
      const parts = await pushParts(f, f.a, target, base);
      request = liveRequest(baseUrl, 'POST', `/api/v1/vaults/${f.vaultId}/sync/push`,
        { ...f.a.headers, 'content-type': parts.contentType }, parts.payload);
    } else {
      const pack = Buffer.from('slow chunk');
      const original = f.server.chunkTransfers.putChunk.bind(f.server.chunkTransfers);
      f.server.chunkTransfers.putChunk = async (...args) => {
        state.entered = true;
        await gate;
        return await original(...args);
      };
      request = liveRequest(baseUrl, 'PUT', `/api/v1/vaults/${f.vaultId}/sync/push-transfers/trn_slowchunk/chunks/0`, {
        ...f.a.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack)
      }, pack);
    }
    await expect.poll(() => state.entered, { timeout: 5_000 }).toBe(true);
    return { request, release };
  }

  it.each(['push', 'chunk'] as const)('waits for a real in-flight %s request, then removes the device once it completes', async (kind) => {
    const { f, baseUrl } = await started();
    const inflight = await startGated(f, baseUrl, kind);
    expect(counts(f)).toEqual(held(kind));
    await revoke(f, f.a);
    const refBefore = await f.server.git.getRef(f.vaultId, refOf(f.a));
    expect(refBefore).not.toBeNull();

    let settled = false;
    const removal = removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) }).then((response) => { settled = true; return response; });
    await expect.poll(async () => (await journal(f, f.a)) !== null, { timeout: 3_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(refBefore);
    expect(counts(f).leases).toBe(1);

    inflight.release();
    expect((await inflight.request.response).status).toBeGreaterThan(0);
    const response = await removal;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'removed', device_id: f.a.deviceId });
    await expect.poll(() => counts(f)).toEqual({ leases: 0, admissions: 0 });
  });

  it.each(['push', 'chunk'] as const)('releases the fence after a client aborts a %s mid-flight once its handler settled, so the next removal succeeds', async (kind) => {
    const { f, baseUrl } = await started();
    const inflight = await startGated(f, baseUrl, kind);
    expect(counts(f)).toEqual(held(kind));
    inflight.request.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    inflight.release();
    await expect.poll(() => counts(f), { timeout: 5_000 }).toEqual({ leases: 0, admissions: 0 });
    await revoke(f, f.a);

    const response = await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) });
    expect(response.status).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(counts(f)).toEqual({ leases: 0, admissions: 0 });
  });

  it.each(['push', 'chunk'] as const)('keeps the fence while the handler of an aborted %s is still running and never deletes the ref early', async (kind) => {
    const { f, baseUrl } = await started({ deviceRemoval: { drainTimeoutMs: 400 } });
    const refBefore = await f.server.git.getRef(f.vaultId, refOf(f.a));
    expect(refBefore).not.toBeNull();
    const inflight = await startGated(f, baseUrl, kind);
    inflight.request.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counts(f)).toEqual(held(kind));
    await revoke(f, f.a);

    const early = await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) });
    expect(early.status).toBe(503);
    expect(early.body.error.code).toBe('device_removal_incomplete');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(refBefore);
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(counts(f).leases).toBe(1);

    inflight.release();
    await expect.poll(() => counts(f), { timeout: 5_000 }).toEqual({ leases: 0, admissions: 0 });
    // The push was authenticated before the revoke and finished after it; revocation stays sticky, so no re-revoke.
    const retried = await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) });
    expect(retried.status).toBe(200);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  it('keeps a revoke sticky when a real push authenticated before it finishes after it, and then removes without re-revoking', async () => {
    const { f, baseUrl } = await started();
    const inflight = await startGated(f, baseUrl, 'push');
    await revoke(f, f.a);
    const revokedRow = (await snapshot(f)).devices.find((row) => row.device_id === f.a.deviceId)!;
    expect(revokedRow).toMatchObject({ status: 'revoked', revoked_at: expect.any(String) });
    const revokedAt = revokedRow.revoked_at;
    const headBefore = revokedRow.device_ref_head;

    inflight.release();
    expect((await inflight.request.response).status).toBeGreaterThan(0);
    await expect.poll(() => counts(f), { timeout: 5_000 }).toEqual({ leases: 0, admissions: 0 });
    const after = (await snapshot(f)).devices.find((row) => row.device_id === f.a.deviceId)!;
    expect(after.status).toBe('revoked');
    expect(after.revoked_at).toBe(revokedAt);
    expect(after.device_ref_head).not.toBe(headBefore);
    expect((await dashboardDevices(f)).find((row) => row.device_id === f.a.deviceId)).toMatchObject({ revoked_at: revokedAt });

    const response = await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) });
    expect(response.status).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  it('returns the counts to zero after successful and error responses and after failures before the handler', async () => {
    const { f, baseUrl } = await started();
    const pack = Buffer.from('not a pack');
    const chunkUrl = `/api/v1/vaults/${f.vaultId}/sync/push-transfers/trn_unknown/chunks/0`;
    const ok = await liveRequest(baseUrl, 'GET', '/api/v1/device/self', f.a.headers).response;
    expect(ok.status).toBe(200);
    const handlerError = await liveRequest(baseUrl, 'PUT', chunkUrl, {
      ...f.a.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack)
    }, pack).response;
    expect(handlerError.status).toBeGreaterThanOrEqual(400);
    const beforeHandler = await liveRequest(baseUrl, 'PUT', chunkUrl, { ...f.a.headers, 'content-type': 'text/plain' }, pack).response;
    expect(beforeHandler.status).toBeGreaterThanOrEqual(400);
    const unauthenticated = await liveRequest(baseUrl, 'GET', `/api/v1/vaults/${f.vaultId}/sync/events`, {}).response;
    expect(unauthenticated.status).toBe(401);
    const owner = await liveRequest(baseUrl, 'GET', `/api/v1/vaults/${f.vaultId}/devices`, { cookie: f.owner.cookie }).response;
    expect(owner.status).toBeLessThan(500);
    await expect.poll(() => counts(f), { timeout: 3_000 }).toEqual({ leases: 0, admissions: 0 });
  });

  it('releases the fence when a client aborts while still uploading a body, before any handler ran', async () => {
    const { f, baseUrl } = await started();
    const pack = Buffer.alloc(4096, 1);
    const upload = liveRequest(baseUrl, 'PUT', `/api/v1/vaults/${f.vaultId}/sync/push-transfers/trn_unknown/chunks/0`, {
      ...f.a.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack)
    }, pack, { held: true });
    await expect.poll(() => counts(f).leases, { timeout: 3_000 }).toBe(1);
    upload.abort();
    await expect.poll(() => counts(f), { timeout: 5_000 }).toEqual({ leases: 0, admissions: 0 });
    await revoke(f, f.a);
    expect((await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) })).status).toBe(200);
  });
});

/** Stages one chunk-transfer session for the device whose target commit is `target` (default: a fresh commit outside main). */
async function stageTransfer(f: Fixture, device: Enrolled, attemptId: string, target?: string): Promise<{ transferId: string; target: string; base: string }> {
  const base = await currentMain(f.server, f.vaultId);
  const commitId = target ?? await commit(f, base);
  const pack = await f.server.git.exportPack(f.vaultId, commitId, base);
  const created = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers`, headers: device.headers,
    payload: {
      api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: device.deviceId,
      expected_device_ref: null, target_commit: commitId, client_known_main: base, attempt_id: attemptId,
      chunk_count: 1, plan_sha256: sha256Hex(Buffer.from(attemptId))
    }
  });
  expect(created.statusCode).toBe(201);
  const transferId = created.json().transfer_id as string;
  const uploaded = await f.server.app.inject({
    method: 'PUT', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/chunks/0`,
    headers: { ...device.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack) }, payload: pack
  });
  expect(uploaded.statusCode).toBe(200);
  return { transferId, target: commitId, base };
}

describe('device removal staged transfers count as unmerged work', () => {
  it('blocks a staged session whose commit is not in main unless the discard phrase is given, then erases it', async () => {
    const f = await fixture();
    const b = await enroll(f.server, f.owner, f.vaultId, DEVICE_B_NAME);
    const staged = await stageTransfer(f, f.a, 'attempt_staged_uncovered');
    const others = await stageTransfer(f, b, 'attempt_staged_other_device');
    await revoke(f, f.a);

    const refused = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('device_has_unmerged_work');
    expect(refused.json().error.details).toEqual({ reason: 'staged_transfer' });
    expect(await journal(f, f.a)).toBeNull();
    expect(await hasDevice(f, f.a)).toBe(true);
    expect((await transferDirs(f)).sort()).toEqual([staged.transferId, others.transferId].sort());

    const discarded = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(discarded.statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(await transferDirs(f)).toEqual([others.transferId]);
  });

  it('does not block a staged session whose commit is already an ancestor of main, nor a completed one', async () => {
    const f = await fixture();
    const covered = await stageTransfer(f, f.a, 'attempt_staged_covered');
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', covered.target, covered.base);
    await f.server.store.mutate((db) => { db.vaults.find((row) => row.vault_id === f.vaultId)!.current_main = covered.target; });
    const completed = await stageTransfer(f, f.a, 'attempt_staged_completed', await commit(f, covered.target));
    const finalized = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${completed.transferId}/finalize`, headers: f.a.headers
    });
    expect(finalized.statusCode).toBe(200);
    expect(await currentMain(f.server, f.vaultId)).toBe(completed.target);
    expect(await transferDirs(f)).toHaveLength(2);
    await revoke(f, f.a);

    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(200);
    expect(await transferDirs(f)).toEqual([]);
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  it('fails closed with a retryable 503 when staged ancestry is unknown or the session store is unreadable', async () => {
    const f = await fixture();
    const staged = await stageTransfer(f, f.a, 'attempt_staged_unknown');
    await revoke(f, f.a);
    const originalVerdict = f.server.git.ancestryVerdict.bind(f.server.git);
    f.server.git.ancestryVerdict = async () => 'unknown';
    const unknown = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error.code).toBe('device_removal_unavailable');
    f.server.git.ancestryVerdict = originalVerdict;

    const originalStaged = f.server.chunkTransfers.stagedTargetCommits.bind(f.server.chunkTransfers);
    f.server.chunkTransfers.stagedTargetCommits = async () => { throw new Error('synthetic unreadable session'); };
    const unreadable = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(unreadable.statusCode).toBe(503);
    expect(unreadable.json().error.code).toBe('device_removal_unavailable');
    f.server.chunkTransfers.stagedTargetCommits = originalStaged;

    expect(await journal(f, f.a)).toBeNull();
    expect(await transferDirs(f)).toEqual([staged.transferId]);
    expect(await hasDevice(f, f.a)).toBe(true);
  });

  it('re-applies the gate under the vault lock after the drain and keeps the staged data when it refuses', async () => {
    const f = await fixture();
    const staged = await stageTransfer(f, f.a, 'attempt_staged_revalidate');
    await revoke(f, f.a);
    const original = f.server.chunkTransfers.stagedTargetCommits.bind(f.server.chunkTransfers);
    let calls = 0;
    f.server.chunkTransfers.stagedTargetCommits = async (...args) => (++calls === 1 ? [] : await original(...args));

    const refused = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('device_has_unmerged_work');
    expect(refused.json().error.details).toEqual({ retryable: false, reason: 'staged_transfer' });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await journal(f, f.a)).toMatchObject({ state: 'failed', retryable: false, error_code: 'device_has_unmerged_work' });
    expect(await transferDirs(f)).toEqual([staged.transferId]);
    expect(await hasDevice(f, f.a)).toBe(true);

    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await transferDirs(f)).toEqual([]);
  });

  it('still treats a session aborted by an earlier drain as staged work for a later plain-phrase request', async () => {
    const injected = failOnce('after_drain');
    const f = await fixture(injected.options);
    const staged = await stageTransfer(f, f.a, 'attempt_staged_drained');
    await revoke(f, f.a);

    const first = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(first.statusCode).toBe(503);
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: true, state: 'failed', retryable: true });
    expect(await transferDirs(f)).toEqual([staged.transferId]);

    const plain = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.details).toMatchObject({ reason: 'staged_transfer' });
    // Refused before touching the journal's progress, but the stale grant is already withdrawn.
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: false, state: 'failed', retryable: true });
    expect(await transferDirs(f)).toEqual([staged.transferId]);
    expect(await hasDevice(f, f.a)).toBe(true);

    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await transferDirs(f)).toEqual([]);
  });
});

describe('device removal discard grant is per request', () => {
  it('never lets a plain-phrase retry reuse the discard grant of an earlier attempt', async () => {
    const injected = failOnce('after_ref_delete');
    const f = await fixture(injected.options);
    await makeUnmerged(f, f.a);
    await revoke(f, f.a);

    const first = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(first.statusCode).toBe(503);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    expect(await journal(f, f.a)).toMatchObject({ phase: 'cleanup', discard_unmerged: true });

    const main = await currentMain(f.server, f.vaultId);
    const reappeared = await commit(f, main, 'unmerged work that reappeared');
    await f.server.git.updateRef(f.vaultId, refOf(f.a), reappeared, null);

    const plain = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.code).toBe('device_has_unmerged_work');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(reappeared);
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: false, state: 'failed', retryable: false });
    expect(await hasDevice(f, f.a)).toBe(true);

    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
  });

  it('re-checks an unchanged unmerged ref against the current request when resuming a delete already entered', async () => {
    const injected = failOnce('before_ref_delete');
    const f = await fixture(injected.options);
    const unmerged = await makeUnmerged(f, f.a);
    await revoke(f, f.a);

    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(503);
    expect(await journal(f, f.a)).toMatchObject({ phase: 'ref_deleting', discard_unmerged: true });
    const plain = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.code).toBe('device_has_unmerged_work');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBe(unmerged);
  });
});

describe('device removal with a missing device ref', () => {
  async function journalWithMissingRef() {
    const injected = failOnce('after_intent');
    const f = await fixture(injected.options);
    const head = await pushMerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: phrase(f.a) })).statusCode).toBe(503);
    expect(await journal(f, f.a)).toMatchObject({ phase: 'intent', expected_ref_oid: head });
    expect(await f.server.git.deleteRefCas(f.vaultId, refOf(f.a), head)).not.toBe('moved');
    expect(await f.server.git.getRef(f.vaultId, refOf(f.a))).toBeNull();
    return f;
  }

  it('keeps a terminal 409 that names the discard phrase, then accepts nothing-to-delete with the phrase and a strict absent read', async () => {
    const f = await journalWithMissingRef();
    const plain = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.code).toBe('device_ref_inconsistent');
    expect(plain.json().error.details).toEqual({ retryable: false, reason: 'ref_missing', resolution: 'discard_phrase' });
    expect(await journal(f, f.a)).toMatchObject({ state: 'failed', retryable: false, error_code: 'device_ref_inconsistent' });
    expect(await hasDevice(f, f.a)).toBe(true);

    const accepted = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(accepted.statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(await journal(f, f.a)).toBeNull();
    expect(f.server.lifecycle.isDeviceRemoving(f.vaultId, f.a.deviceId)).toBe(false);
  });

  it('records the acceptance durably in the journal before cleanup', async () => {
    const failCleanup = failOnce('after_credentials');
    const f = await fixture(failCleanup.options);
    const head = await pushMerged(f, f.a);
    await revoke(f, f.a);
    // The ref is deleted right after the pre-intent strict read, so the journal records an OID whose ref
    // is already gone when the revalidation under the vault lock reads it.
    const original = f.server.git.readRefStrict.bind(f.server.git);
    let reads = 0;
    f.server.git.readRefStrict = async (vaultId, ref) => {
      const value = await original(vaultId, ref);
      if (ref === refOf(f.a) && ++reads === 1) await f.server.git.deleteRefCas(vaultId, ref, head);
      return value;
    };
    const response = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(response.statusCode).toBe(503);
    expect(await journal(f, f.a)).toMatchObject({ phase: 'cleanup', expected_ref_oid: null, discard_unmerged: true, state: 'failed', retryable: true });
    f.server.git.readRefStrict = original;
    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  it('never treats an unreadable ref as absent, even with the discard phrase', async () => {
    const f = await journalWithMissingRef();
    const original = f.server.git.readRefStrict.bind(f.server.git);
    f.server.git.readRefStrict = async () => { throw new Error('synthetic unreadable repository'); };
    const unreadable = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(unreadable.statusCode).toBe(503);
    expect(unreadable.json().error.code).toBe('device_removal_unavailable');
    expect(await hasDevice(f, f.a)).toBe(true);
    expect(await journal(f, f.a)).toMatchObject({ phase: 'intent', expected_ref_oid: expect.any(String), retryable: true });
    f.server.git.readRefStrict = original;
    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
  });

  it('applies the same rule when the device row recorded a ref head but no journal exists', async () => {
    const f = await fixture();
    const head = await pushMerged(f, f.a);
    await revoke(f, f.a);
    await f.server.git.deleteRefCas(f.vaultId, refOf(f.a), head);

    const plain = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error.code).toBe('device_ref_inconsistent');
    expect(plain.json().error.details).toEqual({ retryable: false, reason: 'ref_missing', resolution: 'discard_phrase' });
    expect(await journal(f, f.a)).toBeNull();

    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
  });
});

describe('phase 2d: fence, grant and ownership hardening', () => {
  type Kind = 'push' | 'chunk';

  /** Holds a request in a preHandler, i.e. after the lease was taken but before the handler starts. */
  function preHandlerGate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { armed: false, entered: false };
    const hook = async () => {
      if (!state.armed) return;
      state.entered = true;
      await gate;
    };
    const onRoute: NonNullable<CreateObtsServerOptions['onRoute']> = (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const gated = (methods.includes('PUT') && route.url.endsWith('/chunks/:chunkIndex')) ||
        (methods.includes('POST') && route.url.endsWith('/sync/push'));
      if (!gated) return;
      const mutable = route as { preHandler?: unknown };
      const existing = mutable.preHandler === undefined ? [] : Array.isArray(mutable.preHandler) ? mutable.preHandler : [mutable.preHandler];
      mutable.preHandler = [...existing, hook];
    };
    return { state, release, onRoute };
  }

  async function startedWith(options: CreateObtsServerOptions) {
    const live = await harness.start({ readiness: { autoStart: false }, ...options });
    const f = await fixture({}, live.server);
    await pushMerged(f, f.a);
    return { f, baseUrl: live.baseUrl };
  }

  const counts = (f: Fixture) => ({
    leases: f.server.lifecycle.activeDeviceLeaseCount(f.vaultId, f.a.deviceId),
    admissions: f.server.lifecycle.activeAdmissionCount(f.vaultId)
  });

  // F1: a non-native thenable handler is tracked like a promise.
  it('keeps the fence while a non-native thenable handler of an aborted request is still pending', async () => {
    const server = await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { entered: false, finished: false };
    server.app.get('/api/v1/vaults/:vaultId/test-thenable', (() => {
      state.entered = true;
      return { then: (resolve: (value: unknown) => void) => { void gate.then(() => { state.finished = true; resolve({ ok: true }); }); } };
    }) as never);
    const f = await fixture({}, server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const inflight = liveRequest(baseUrl, 'GET', `/api/v1/vaults/${f.vaultId}/test-thenable`, f.a.headers);
    await expect.poll(() => state.entered, { timeout: 5_000 }).toBe(true);
    expect(counts(f)).toEqual({ leases: 1, admissions: 1 });
    inflight.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(state.finished).toBe(false);
    expect(counts(f)).toEqual({ leases: 1, admissions: 1 });

    release();
    await expect.poll(() => counts(f), { timeout: 5_000 }).toEqual({ leases: 0, admissions: 0 });
    expect(state.finished).toBe(true);
  });

  // F2: abort before the handler starts releases at once and the handler never runs unfenced.
  it.each(['push', 'chunk'] as const)('releases at once when a %s is aborted before its handler starts and never runs that handler', async (kind: Kind) => {
    const gate = preHandlerGate();
    const { f, baseUrl } = await startedWith({ onRoute: gate.onRoute });
    const spy = { runs: 0 };
    let request: Live;
    if (kind === 'push') {
      const base = await currentMain(f.server, f.vaultId);
      const target = await commit(f, base);
      const original = f.server.sync.pushDeviceCommit.bind(f.server.sync);
      f.server.sync.pushDeviceCommit = async (...args) => { spy.runs += 1; return await original(...args); };
      const parts = await pushParts(f, f.a, target, base);
      gate.state.armed = true;
      request = liveRequest(baseUrl, 'POST', `/api/v1/vaults/${f.vaultId}/sync/push`,
        { ...f.a.headers, 'content-type': parts.contentType }, parts.payload);
    } else {
      const pack = Buffer.from('never stored chunk');
      const original = f.server.chunkTransfers.putChunk.bind(f.server.chunkTransfers);
      f.server.chunkTransfers.putChunk = async (...args) => { spy.runs += 1; return await original(...args); };
      gate.state.armed = true;
      request = liveRequest(baseUrl, 'PUT', `/api/v1/vaults/${f.vaultId}/sync/push-transfers/trn_neverran/chunks/0`, {
        ...f.a.headers, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack)
      }, pack);
    }
    await expect.poll(() => gate.state.entered, { timeout: 5_000 }).toBe(true);
    // The push route authenticates inside its handler (sync lifecycle route), the chunk route in a hook.
    expect(counts(f).leases).toBe(kind === 'chunk' ? 1 : 0);

    request.abort();
    // Released by the abort itself, while the request is still held before the handler.
    await expect.poll(() => counts(f), { timeout: 3_000 }).toEqual({ leases: 0, admissions: 0 });
    // Give the server time to observe the closed socket (the push route holds nothing to poll for).
    await new Promise((resolve) => setTimeout(resolve, 250));

    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy.runs).toBe(0);
    expect(counts(f)).toEqual({ leases: 0, admissions: 0 });
    await revoke(f, f.a);
    expect((await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) })).status).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
  });

  // F3: nothing that hijacks may hold a lease or admission.
  it('holds no device lease or vault admission while the dashboard events stream is open', async () => {
    const { f, baseUrl } = await startedWith({});
    const stream = await harness.stream(baseUrl, f.owner.cookie);
    expect(stream.status).toBe(200);
    await stream.frameCount(1);
    expect(counts(f)).toEqual({ leases: 0, admissions: 0 });
    expect(f.server.lifecycle.activeAdmissionCount(f.vaultId)).toBe(0);
    await revoke(f, f.a);
    expect((await removeOverHttp(baseUrl, f, f.a, { confirmation: phrase(f.a) })).status).toBe(200);
    expect(counts(f)).toEqual({ leases: 0, admissions: 0 });
  });

  it('refuses to hijack a reply while the request holds a device lease or vault admission', async () => {
    const server = await boot();
    server.app.get('/api/v1/vaults/:vaultId/test-hijack', (async (_request: unknown, reply: { hijack(): void; raw: { writeHead(code: number): void; end(body: string): void } }) => {
      reply.hijack();
      reply.raw.writeHead(200);
      reply.raw.end('hijacked');
    }) as never);
    const f = await fixture({}, server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const response = await liveRequest(baseUrl, 'GET', `/api/v1/vaults/${f.vaultId}/test-hijack`, f.a.headers).response;
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('hijacked');
    await expect.poll(() => counts(f), { timeout: 3_000 }).toEqual({ leases: 0, admissions: 0 });
  });

  // F4: a refused request withdraws an earlier durable discard grant, and never escalates one.
  it('withdraws an earlier durable discard grant when a later request has a mistyped phrase, so a restart erases nothing', async () => {
    const injected = failOnce('after_intent');
    const f = await fixture(injected.options);
    const unmerged = await makeUnmerged(f, f.a);
    const staged = await stageTransfer(f, f.a, 'attempt_grant_typo');
    await revoke(f, f.a);

    const first = await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true });
    expect(first.statusCode).toBe(503);
    expect(await journal(f, f.a)).toMatchObject({ phase: 'intent', discard_unmerged: true });

    const typo = await remove(f, f.a, { confirmation: `${discardPhrase(f.a)}S`, discard_unmerged: true });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error.code).toBe('confirmation_mismatch');
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: false });
    // A mistyped discard request must never ESCALATE the (now withdrawn) grant either.
    const plainTypoWithFlag = await remove(f, f.a, { confirmation: phrase(f.a), discard_unmerged: true });
    expect(plainTypoWithFlag.statusCode).toBe(400);
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: false });

    const dataDir = f.server.config.dataDir;
    await f.server.app.close();
    const restarted = await boot({}, dataDir);
    const g: Fixture = { ...f, server: restarted };
    expect(await restarted.git.getRef(f.vaultId, refOf(f.a))).toBe(unmerged);
    expect(await transferDirs(g)).toEqual([staged.transferId]);
    expect(await hasDevice(g, f.a)).toBe(true);
    expect(await journal(g, f.a)).toMatchObject({ discard_unmerged: false, state: 'failed', retryable: false });

    expect((await remove(g, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(200);
    expect(await transferDirs(g)).toEqual([]);
  });

  it('does not let a foreign owner withdraw or touch the grant of another owner\'s removal', async () => {
    const injected = failOnce('after_intent');
    const f = await fixture(injected.options);
    await makeUnmerged(f, f.a);
    await revoke(f, f.a);
    expect((await remove(f, f.a, { confirmation: discardPhrase(f.a), discard_unmerged: true })).statusCode).toBe(503);
    const second = await secondOwner(f);

    const foreign = await remove(f, f.a, { confirmation: 'wrong phrase' }, second);
    expect(foreign.statusCode).toBe(404);
    expect(await journal(f, f.a)).toMatchObject({ discard_unmerged: true });
  });

  // F5: the gate and the eraser share one ownership predicate.
  it.each(['missing', 'foreign'] as const)('neither counts nor erases a session of the device whose owner marker is %s', async (variant) => {
    const f = await fixture();
    const staged = await stageTransfer(f, f.a, `attempt_marker_${variant}`);
    const marker = join(f.server.config.transferDir, staged.transferId, 'owner.json');
    if (variant === 'missing') await rm(marker);
    else await writeFile(marker, JSON.stringify({ vault_id: 'vlt_someotherv' }));
    await revoke(f, f.a);

    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
    expect(await transferDirs(f)).toEqual([staged.transferId]);
  });

  // F6: repeated revoke keeps the original timestamps.
  it('keeps the original device and token revocation timestamps on a repeated revoke', async () => {
    const f = await fixture();
    await revoke(f, f.a);
    const before = await snapshot(f);
    const row = before.devices.find((device) => device.device_id === f.a.deviceId)!;
    const tokens = before.tokens.filter((token) => token.device_id === f.a.deviceId).map((token) => token.revoked_at);
    expect(row.revoked_at).not.toBeNull();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((value) => value !== null)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await revoke(f, f.a);
    const after = await snapshot(f);
    expect(after.devices.find((device) => device.device_id === f.a.deviceId)!.revoked_at).toBe(row.revoked_at);
    expect(after.tokens.filter((token) => token.device_id === f.a.deviceId).map((token) => token.revoked_at)).toEqual(tokens);
  });

  // F7: legacy status-only revoked rows are removable and look revoked.
  it.each([null, undefined])('removes a legacy row with status revoked and revoked_at %s and shows it as revoked with a null timestamp', async (legacy) => {
    const f = await fixture();
    await pushMerged(f, f.a);
    await f.server.store.mutate((db) => {
      const row = db.devices.find((device) => device.device_id === f.a.deviceId)!;
      row.status = 'revoked';
      row.revoked_at = legacy as null;
    });
    const stored = (await snapshot(f)).devices.find((device) => device.device_id === f.a.deviceId)!;
    expect(stored.status).toBe('revoked');
    expect(stored.revoked_at ?? null).toBeNull();

    const dashboard = await f.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${f.vaultId}/dashboard`, headers: { cookie: f.owner.cookie } });
    expect(dashboard.statusCode).toBe(200);
    const device = (dashboard.json().devices as Array<Record<string, unknown>>).find((row) => row.device_id === f.a.deviceId)!;
    expect(device).toMatchObject({ status: 'revoked', revoked_at: null });
    expect(Object.prototype.hasOwnProperty.call(device, 'revoked_at')).toBe(true);

    const response = await remove(f, f.a, { confirmation: phrase(f.a) });
    expect(response.statusCode).toBe(200);
    expect(await hasDevice(f, f.a)).toBe(false);
  });
});
