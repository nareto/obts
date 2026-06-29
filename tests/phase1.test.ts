import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient, PluginBlockedError } from '../src/plugin/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { assertSyncableTreePaths, PathPolicyViolation } from '../src/shared/pathPolicy.js';
import { API_VERSION } from '../src/shared/types.js';

type Json = Record<string, unknown>;

class BrowserSession {
  cookie = '';
  csrf = '';

  constructor(private readonly baseUrl: string) {}

  async post<T extends Json>(path: string, body: Json, csrf = true): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(csrf && this.csrf ? { 'x-obts-csrf': this.csrf } : {})
      },
      body: JSON.stringify(body)
    });
    this.captureCookie(response);
    const parsed = (await response.json()) as T;
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') {
      this.csrf = parsed.csrf_token;
    }
    return { status: response.status, body: parsed };
  }

  async get<T extends Json>(path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {})
      }
    });
    const parsed = (await response.json()) as T;
    return { status: response.status, body: parsed };
  }

  private captureCookie(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
    const cookiePairs = setCookies.map((cookie) => cookie.split(';')[0]).filter(Boolean);
    if (cookiePairs.length > 0) {
      this.cookie = cookiePairs.join('; ');
    }
  }
}

describe('Phase 1 sync without conflict resolution', () => {
  let root: string;
  let server: ObtsServer;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-phase1-'));
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('pairs two devices and syncs non-conflicting vault changes through server main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'welcome.md'), '# Welcome\n');

    const plugin1 = await pairPlugin(admin, device1Dir, 'laptop');
    await expect(plugin1.syncOnce()).rejects.toMatchObject({ code: 'initial_import_confirmation_required' });
    expect(await exists(join(device1Dir, '.git'))).toBe(false);
    expect(await exists(join(device1Dir, '.obts', 'git'))).toBe(true);
    expect((await readdir(join(device1Dir, '.obts', 'recovery'))).length).toBeGreaterThan(0);

    const firstSync = await plugin1.syncOnce({ confirmInitialImport: true });
    expect(firstSync.status).toBe('Synced');

    const device2Dir = join(root, 'device-2');
    await mkdirp(device2Dir);
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    expect(await readFile(join(device2Dir, 'welcome.md'), 'utf8')).toBe('# Welcome\n');
    expect(await exists(join(device2Dir, '.git'))).toBe(false);

    await writeFile(join(device2Dir, 'phone.md'), 'from phone\n');
    const secondSync = await plugin2.syncOnce();
    expect(secondSync.status).toBe('Synced');

    await plugin1.syncOnce();
    expect(await readFile(join(device1Dir, 'phone.md'), 'utf8')).toBe('from phone\n');

    const dashboard = await admin.get<{ unresolved_conflict_count: number; devices: Json[] }>(
      `/api/v1/vaults/${admin.vaultId}/dashboard`
    );
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.unresolved_conflict_count).toBe(0);
    expect(dashboard.body.devices).toHaveLength(2);

    const db = await server.store.snapshot();
    const mergeOperations = db.sync_operations.filter((operation) => operation.operation_type === 'server_merge');
    expect(mergeOperations.length).toBeGreaterThanOrEqual(2);
    expect(mergeOperations.at(-1)?.status).toBe('committed');
    expect(mergeOperations.at(-1)?.prepared_manifest).toMatchObject({
      merge_policy_version: 'phase1.disjoint-paths.v1',
      decision: 'merge',
      validator_results: {
        disjoint_paths: 'ok',
        overlapping_path_count: 0
      }
    });
  });

  it('records a durable conflict for unsafe concurrent same-path edits and does not overwrite main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'conflict-device-1');
    const device2Dir = join(root, 'conflict-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await writeFile(join(device1Dir, 'shared.md'), 'base\n');
    await plugin1.syncOnce();

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');

    await writeFile(join(device1Dir, 'shared.md'), 'device one\n');
    await writeFile(join(device2Dir, 'shared.md'), 'device two\n');
    await plugin1.syncOnce();
    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Review needed');
    expect(result.conflictId).toMatch(/^conf_/u);

    const conflicts = await admin.get<{ conflicts: Array<{ affected_paths: string[]; status: string }> }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts?status=open`
    );
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflicts).toHaveLength(1);
    expect(conflicts.body.conflicts[0]?.status).toBe('open');
    expect(conflicts.body.conflicts[0]?.affected_paths).toEqual(['shared.md']);

    const device3Dir = join(root, 'conflict-device-3');
    await mkdirp(device3Dir);
    const plugin3 = await pairPlugin(admin, device3Dir, 'reader');
    expect(await readFile(join(device3Dir, 'shared.md'), 'utf8')).toBe('device one\n');

    await writeFile(join(device2Dir, 'after-conflict.md'), 'still blocked\n');
    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'device_blocked' });
  });

  it('blocks divergent additional-device content until explicit replace-local-with-server', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'replace-device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'server.md'), 'server state\n');

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await expect(plugin1.syncOnce()).rejects.toMatchObject({ code: 'initial_import_confirmation_required' });
    await plugin1.syncOnce({ confirmInitialImport: true });

    const device2Dir = join(root, 'replace-device-2');
    await mkdirp(device2Dir);
    await writeFile(join(device2Dir, 'local-only.md'), 'do not discard silently\n');
    const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
      device_name: 'phone',
      sync_profile: 'notes_only'
    });
    expect(pairing.status).toBe(201);
    const plugin2 = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
      syncProfile: 'notes_only',
      syncPlugins: false
    });

    await expect(plugin2.pairWithToken(pairing.body.pairing_token)).rejects.toMatchObject({
      code: 'replace_local_with_server_required'
    });
    expect(await readFile(join(device2Dir, 'local-only.md'), 'utf8')).toBe('do not discard silently\n');
    expect((await readdir(join(device2Dir, '.obts', 'recovery'))).length).toBeGreaterThan(0);
    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'replace_local_with_server_required' });

    const replaced = await plugin2.replaceLocalWithServer();
    expect(replaced.status).toBe('Synced');
    expect(await readFile(join(device2Dir, 'server.md'), 'utf8')).toBe('server state\n');
    expect(await exists(join(device2Dir, 'local-only.md'))).toBe(false);
    expect((await awaitState(plugin2)).initial_import_confirmed).toBe(true);
    expect((await plugin2.syncOnce()).status).toBe('Synced');
  });

  it('blocks pairing on partial local .obts state without consuming the pairing token', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const partialDir = join(root, 'partial-device');
    await mkdirp(join(partialDir, '.obts', 'git'));
    const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
      device_name: 'phone',
      sync_profile: 'notes_only'
    });
    expect(pairing.status).toBe(201);
    const partialPlugin = new ObtsPluginClient(partialDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
      syncProfile: 'notes_only',
      syncPlugins: false
    });
    await expect(partialPlugin.pairWithToken(pairing.body.pairing_token)).rejects.toMatchObject({
      code: 'partial_local_state'
    });

    const cleanDir = join(root, 'clean-device');
    await mkdirp(cleanDir);
    const cleanPlugin = new ObtsPluginClient(cleanDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
      syncProfile: 'notes_only',
      syncPlugins: false
    });
    await cleanPlugin.pairWithToken(pairing.body.pairing_token);
    expect((await awaitState(cleanPlugin)).device_id).toMatch(/^dev_/u);
  });

  it('fails readiness closed when metadata points at missing Git state', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const before = await fetch(`${baseUrl}/health/ready`);
    expect(before.status).toBe(200);

    await rm(join(root, 'server-data', 'git', `${admin.vaultId}.git`), { recursive: true, force: true });
    const after = await fetch(`${baseUrl}/health/ready`);
    expect(after.status).toBe(503);
    const body = (await after.json()) as { checks: { persistent_state: boolean } };
    expect(body.checks.persistent_state).toBe(false);
  });

  it('blocks sync on restart when an incomplete apply journal is present', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'journal-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    await writeFile(
      join(deviceDir, '.obts', 'apply-journal.json'),
      `${JSON.stringify(
        {
          apply_id: 'apply_test',
          operation_type: 'pull_apply',
          target_main: state.local_main,
          expected_prior_local_main: state.local_main,
          expected_prior_local_device_ref: state.server_device_ref,
          phase: 'writing_files',
          affected_paths: [],
          preflight_sha256: {},
          recovery_bundle_id: null,
          last_completed_step: null,
          redacted_error_category: null
        },
        null,
        2
      )}\n`
    );

    await expect(plugin.syncOnce()).rejects.toMatchObject({ code: 'apply_journal_recovery_required' });
    expect((await plugin.readState()).status_label).toBe('Unsafe local state');
  });

  it('returns 404 for cross-user vault, conflict, sync, and event resources', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const created = await admin.post<{ user_id: string }>('/api/v1/admin/users', {
      username: 'other',
      password: 'other-password-1234',
      display_name: 'Other User'
    });
    expect(created.status).toBe(201);

    const other = new BrowserSession(baseUrl);
    const login = await other.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'other',
      password: 'other-password-1234'
    }, false);
    expect(login.status).toBe(200);
    const otherVault = await other.post<{ vault_id: string }>('/api/v1/vaults', {
      display_name: 'Other Vault'
    });
    expect(otherVault.status).toBe(201);
    const otherDir = join(root, 'other-device');
    await mkdirp(otherDir);
    const otherPairing = await other.post<{ pairing_token: string }>(
      `/api/v1/vaults/${otherVault.body.vault_id}/pairing-tokens`,
      {
        device_name: 'other-device',
        sync_profile: 'notes_only'
      }
    );
    expect(otherPairing.status).toBe(201);
    const otherPlugin = new ObtsPluginClient(otherDir, {
      serverUrl: baseUrl,
      deviceName: 'other-device',
      syncProfile: 'notes_only',
      syncPlugins: false
    });
    await otherPlugin.pairWithToken(otherPairing.body.pairing_token);
    const otherPluginState = await otherPlugin.readState();
    const otherTokenFile = JSON.parse(await readFile(join(otherDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as {
      device_token: string;
    };

    for (const path of [
      `/api/v1/vaults/${admin.vaultId}/main`,
      `/api/v1/vaults/${admin.vaultId}/conflicts?status=open`,
      `/api/v1/vaults/${admin.vaultId}/events`
    ]) {
      const response = await other.get<{ error: { code: string } }>(path);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    }

    const syncResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherTokenFile.device_token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: otherPluginState.device_id,
        current_local_main: null,
        requested_target: 'latest'
      })
    });
    expect(syncResponse.status).toBe(404);
    const syncBody = (await syncResponse.json()) as { error: { code: string } };
    expect(syncBody.error.code).toBe('not_found');
  });

  it('rejects internal and visible Git paths in the shared path policy', () => {
    expect(() => assertSyncableTreePaths(['notes/a.md', '.obts/state.json'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['notes/a.md', '.git/config'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['Notes/A.md', 'notes/a.md'])).toThrow(PathPolicyViolation);
  });
});

async function setupAdminAndVault(baseUrl: string): Promise<BrowserSession & { vaultId: string }> {
  const admin = new BrowserSession(baseUrl) as BrowserSession & { vaultId: string };
  const setup = await admin.post<{ user_id: string; csrf_token: string }>('/api/v1/setup', {
    username: 'admin',
    password: 'admin-password-1234',
    display_name: 'Admin'
  }, false);
  expect(setup.status).toBe(201);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', {
    display_name: 'Main Vault'
  });
  expect(vault.status).toBe(201);
  admin.vaultId = vault.body.vault_id;
  return admin;
}

async function pairPlugin(admin: BrowserSession & { vaultId: string }, vaultDir: string, deviceName: string): Promise<ObtsPluginClient> {
  const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
    device_name: deviceName,
    sync_profile: 'notes_only'
  });
  expect(pairing.status).toBe(201);
  const plugin = new ObtsPluginClient(vaultDir, {
    serverUrl: baseUrlFromAdmin(admin),
    deviceName,
    syncProfile: 'notes_only',
    syncPlugins: false
  });
  await plugin.pairWithToken(pairing.body.pairing_token);
  return plugin;
}

function baseUrlFromAdmin(admin: BrowserSession): string {
  return (admin as unknown as { baseUrl: string }).baseUrl;
}

async function mkdirp(path: string): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path, { recursive: true }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function awaitState(plugin: ObtsPluginClient) {
  return await plugin.readState();
}
