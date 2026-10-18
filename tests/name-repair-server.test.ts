import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

const SECRET = 'synthetic-session-secret-for-name-repair-server';

let root: string;
let server: ObtsServer;
let url: string;
let cookie = '';
let csrf = '';
let vaultId: string;
const servers: ObtsServer[] = [];

async function listen(instance: ObtsServer) {
  servers.push(instance);
  url = await instance.app.listen({ port: 0, host: '127.0.0.1' });
}

async function request(method: string, path: string, body?: unknown, options: { authenticated?: boolean; csrf?: boolean } = {}) {
  const authenticated = options.authenticated ?? true;
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authenticated ? { cookie } : {}),
      ...(authenticated && options.csrf !== false ? { 'x-obts-csrf': csrf } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json: any = await response.json();
  if (!authenticated) {
    cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    csrf = json.csrf_token;
  }
  return { status: response.status, json };
}

async function post(path: string, body: unknown) {
  const result = await request('POST', path, body);
  if (result.status < 200 || result.status >= 300) throw new Error(`${path}: ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}

async function seedUnportableVault() {
  const desktopRoot = join(root, 'desktop');
  const desktop = new ObtsPluginClient(desktopRoot, { serverUrl: url, deviceName: 'desktop' });
  const connection = await desktop.startOnboarding('Desktop');
  await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
  const analysis = await desktop.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  await desktop.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
  await mkdir(join(desktopRoot, 'Clips'), { recursive: true });
  await writeFile(join(desktopRoot, 'Clips', 'A | B.md'), 'clip\n');
  await writeFile(join(desktopRoot, 'Index.md'), 'Read [[A | B]].\n');
  await desktop.syncOnce();
}

beforeEach(async () => {
  await mkdir('tmp/name-repair-server', { recursive: true });
  root = await mkdtemp(join(process.cwd(), 'tmp/name-repair-server/run-'));
  server = await createObtsServer({ dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: SECRET });
  await listen(server);
  await request('POST', '/api/v1/setup', { username: 'owner', password: 'synthetic-test-password-1234', display_name: 'Owner' }, { authenticated: false });
  vaultId = (await post('/api/v1/vaults', { display_name: 'Portable vault' })).vault_id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of servers.splice(0)) await instance.app.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('OBTS-DASH-NAME-001 name repair API', () => {
  it('requires a session and CSRF and refuses a repair that is not needed', async () => {
    const anonymous = await fetch(`${url}/api/v1/vaults/${vaultId}/name-repair/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await request('POST', `/api/v1/vaults/${vaultId}/name-repair/preview`, {}, { csrf: false });
    expect(noCsrf.status).toBe(403);

    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    expect(preview).toMatchObject({ renames: [], link_updates: [], changes_main: false });
    const notNeeded = await request('POST', `/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });
    expect(notNeeded.status).toBe(409);
    expect(notNeeded.json.error.code).toBe('name_repair_not_needed');
  });

  it('rejects an apply whose reviewed main has moved', async () => {
    await seedUnportableVault();
    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    expect(preview.renames).toEqual([{ from: 'Clips/A | B.md', to: 'Clips/A - B.md', kind: 'file', reasons: ['reserved_characters'] }]);
    const otherRoot = join(root, 'other');
    const other = new ObtsPluginClient(otherRoot, { serverUrl: url, deviceName: 'other' });
    const connection = await other.startOnboarding('Other');
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    const analysis = await other.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await other.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
    await writeFile(join(otherRoot, 'New.md'), 'moved main\n');
    await other.syncOnce();

    const stale = await request('POST', `/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('stale_name_repair');
    const db = await server.store.snapshot();
    expect(db.sync_operations.filter((operation) => operation.operation_type === 'name_repair')).toEqual([]);
  }, 60_000);

  it('rolls a prepared repair forward after main moved but metadata was not committed', async () => {
    await seedUnportableVault();
    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    const updateRef = server.git.updateRef.bind(server.git);
    const mutate = server.store.mutate.bind(server.store);
    let mainMoved = false;
    vi.spyOn(server.git, 'updateRef').mockImplementation(async (...args) => {
      await updateRef(...args);
      if (args[1] === 'refs/heads/main') mainMoved = true;
    });
    vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      if (mainMoved) throw new Error('simulated crash before metadata commit');
      return await mutate(fn);
    });
    const failed = await request('POST', `/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    vi.restoreAllMocks();
    const target = await server.git.getRef(vaultId, 'refs/heads/main');
    expect(target).not.toBe(preview.expected_main);
    const prepared = (await server.store.snapshot()).sync_operations.find((operation) => operation.operation_type === 'name_repair');
    expect(prepared).toMatchObject({ status: 'prepared', target_commit: target });
    await server.app.close();
    servers.splice(servers.indexOf(server), 1);

    server = await createObtsServer({ dataDir: join(root, 'server'), sessionSecret: SECRET });
    await listen(server);
    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === vaultId)).toMatchObject({ current_main: target, status: 'active' });
    expect((await server.store.exportOperationHistory(vaultId)).find((operation) => operation.operation_id === prepared!.operation_id)).toMatchObject({
      status: 'committed', result: { target_main: target, reconciled_after_startup: true }
    });
    expect(db.events.filter((event) => event.event_type === 'main_advanced' && event.payload.name_repair === true)).toHaveLength(1);
    expect(db.audit_log.filter((entry) => entry.action === 'vault_name_repair_applied')).toHaveLength(1);
    const after = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    expect(after.renames).toEqual([]);
  }, 60_000);

  it('blocks the vault when a prepared repair no longer matches its recorded decision', async () => {
    await seedUnportableVault();
    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    const mutate = server.store.mutate.bind(server.store);
    let mainMoved = false;
    const updateRef = server.git.updateRef.bind(server.git);
    vi.spyOn(server.git, 'updateRef').mockImplementation(async (...args) => {
      await updateRef(...args);
      if (args[1] === 'refs/heads/main') mainMoved = true;
    });
    vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      if (mainMoved) throw new Error('simulated crash before metadata commit');
      return await mutate(fn);
    });
    await request('POST', `/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });
    vi.restoreAllMocks();
    await server.store.mutate((db) => {
      const operation = db.sync_operations.find((candidate) => candidate.operation_type === 'name_repair');
      operation!.prepared_manifest = { ...operation!.prepared_manifest, target_tree: '0'.repeat(40) };
    });
    await server.app.close();
    servers.splice(servers.indexOf(server), 1);

    server = await createObtsServer({ dataDir: join(root, 'server'), sessionSecret: SECRET });
    await listen(server);
    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === vaultId)?.status).toBe('blocked_integrity');
    expect(db.vaults.find((vault) => vault.vault_id === vaultId)?.current_main).toBe(preview.expected_main);
  }, 60_000);
});
