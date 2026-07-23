import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient, PluginBlockedError } from '../obsidian-plugin/src/core/client.js';
import { LocalGitEngine } from '../obsidian-plugin/src/core/localGit.js';
import { TransportClient } from '../obsidian-plugin/src/core/transport.js';
import { runCli } from '../src/cli.js';
import { createObtsServer, repairVaultIntegrity, type ObtsServer } from '../src/server/app.js';
import { MetadataStore } from '../src/server/metadataStore.js';
import { __syncServiceTestInternals } from '../src/server/syncService.js';
import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  PathPolicyViolation
} from '../src/shared/pathPolicy.js';
import { MINIMUM_PLUGIN_VERSION, RECOMMENDED_PLUGIN_VERSION } from '../src/shared/pluginCompatibility.js';
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

  async patch<T extends Json>(path: string, body: Json, csrf = true): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(csrf && this.csrf ? { 'x-obts-csrf': this.csrf } : {})
      },
      body: JSON.stringify(body)
    });
    this.captureCookie(response);
    const parsed = (await response.json()) as T;
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

function firstSetCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
  const first = setCookies[0];
  expect(first).toBeDefined();
  return first!;
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

  it('runs first setup once and initializes vault main to a real empty-tree commit', async () => {
    const admin = new BrowserSession(baseUrl);
    const setupBefore = await admin.get<{ setup_complete: boolean }>('/api/v1/setup/status');
    expect(setupBefore.status).toBe(200);
    expect(setupBefore.body.setup_complete).toBe(false);

    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);

    const pairPreflight = await fetch(`${baseUrl}/api/v1/pair/consume`, {
      method: 'OPTIONS',
      headers: {
        origin: 'app://obsidian.md',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type'
      }
    });
    expect(pairPreflight.status).toBe(204);
    expect(pairPreflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(pairPreflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pairPreflight.headers.get('access-control-allow-headers')).toContain('content-type');

    const invalidPair = await fetch(`${baseUrl}/api/v1/pair/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'app://obsidian.md' },
      body: JSON.stringify({
        pairing_token: 'obts_pair_invalid',
        device_name: 'browser-plugin',
      })
    });
    expect(invalidPair.status).toBe(404);
    expect(invalidPair.headers.get('access-control-allow-origin')).toBe('*');

    const setup = await admin.post<{ user_id: string; csrf_token: string }>('/api/v1/setup', {
      username: 'admin',
      password: 'admin-password-1234',
      display_name: 'Admin'
    }, false);
    expect(setup.status).toBe(201);

    const repeat = await admin.post<{ error: { code: string } }>('/api/v1/setup', {
      username: 'second-admin',
      password: 'admin-password-5678'
    }, false);
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('setup_complete');

    const setupAfter = await admin.get<{ setup_complete: boolean }>('/api/v1/setup/status');
    expect(setupAfter.status).toBe(200);
    expect(setupAfter.body.setup_complete).toBe(true);

    const vault = await admin.post<{ vault_id: string; current_main: string }>('/api/v1/vaults', {
      display_name: 'Main Vault'
    });
    expect(vault.status).toBe(201);
    expect(vault.body.current_main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await server.git.getRef(vault.body.vault_id, 'refs/heads/main')).toBe(vault.body.current_main);
    expect(await server.git.listTreePaths(vault.body.vault_id, vault.body.current_main)).toEqual([]);

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
  });

  it('supports CLI setup, vault, device/conflict inspection, health, and local admin recovery', async () => {
    await server.app.close();
    const cliDataDir = join(root, 'cli-server-data');
    const env = {
      OBTS_DATA_DIR: cliDataDir,
      OBTS_PUBLIC_BASE_URL: 'http://sync.example.test',
      OBTS_SESSION_SECRET: 'cli-test-session-secret-with-enough-entropy',
      OBTS_ADMIN_PASSWORD: 'admin-password-1234',
      OBTS_BREAKGLASS_PASSWORD: 'breakglass-password-1234'
    };
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli(args, env, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        }
      });
      return { code, stdout, stderr };
    };

    const setup = await run([
      'setup',
      '--username',
      'admin',
      '--password-env',
      'OBTS_ADMIN_PASSWORD',
      '--display-name',
      'Admin',
      '--json'
    ]);
    expect(setup).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(setup.stdout)).toMatchObject({ user_id: expect.stringMatching(/^usr_/u) });

    const vault = await run([
      'vault',
      'create',
      '--username',
      'admin',
      '--password-env',
      'OBTS_ADMIN_PASSWORD',
      '--display-name',
      'CLI Vault',
      '--json'
    ]);
    expect(vault).toMatchObject({ code: 0, stderr: '' });
    const vaultBody = JSON.parse(vault.stdout) as { vault_id: string; current_main: string };
    expect(vaultBody.current_main).toMatch(/^[0-9a-f]{40}$/u);

    const devices = await run([
      'devices',
      'list',
      '--username',
      'admin',
      '--password-env',
      'OBTS_ADMIN_PASSWORD',
      '--vault-id',
      vaultBody.vault_id,
      '--json'
    ]);
    expect(devices).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(devices.stdout)).toEqual({ devices: [] });

    const conflicts = await run([
      'conflicts',
      'list',
      '--username',
      'admin',
      '--password-env',
      'OBTS_ADMIN_PASSWORD',
      '--vault-id',
      vaultBody.vault_id,
      '--json'
    ]);
    expect(conflicts).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(conflicts.stdout)).toEqual({ conflicts: [] });

    const ready = await run(['health', 'ready', '--json']);
    expect(ready).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(ready.stdout)).toMatchObject({ status: 'ready' });

    const recovery = await run(['admin-recovery', 'create-reset-token', '--username', 'admin', '--json']);
    expect(recovery).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      username: 'admin',
      reset_token: expect.stringMatching(/^obts_reset_/u)
    });

    const disabledAdminServer = await createObtsServer({
      dataDir: cliDataDir,
      publicBaseUrl: 'http://sync.example.test',
      sessionSecret: 'cli-test-session-secret-with-enough-entropy'
    });
    try {
      await disabledAdminServer.store.mutate((db) => {
        for (const user of db.users) {
          if (user.is_admin) {
            user.disabled = true;
          }
        }
      });
    } finally {
      await disabledAdminServer.app.close();
    }

    const recoveredAdmin = await run([
      'admin-recovery',
      'create-admin',
      '--username',
      'breakglass',
      '--password-env',
      'OBTS_BREAKGLASS_PASSWORD',
      '--display-name',
      'Break Glass',
      '--json'
    ]);
    expect(recoveredAdmin).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(recoveredAdmin.stdout)).toMatchObject({
      username: 'breakglass',
      is_admin: true,
      disabled: false
    });

    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  it('connects two devices and syncs non-conflicting vault changes through server main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'welcome.md'), '# Welcome\n');

    const plugin1 = await pairPlugin(admin, device1Dir, 'laptop');
    expect(await exists(join(device1Dir, '.git'))).toBe(false);
    expect(await exists(join(device1Dir, '.obts', 'git'))).toBe(true);
    expect((await readdir(join(device1Dir, '.obts', 'recovery'))).length).toBeGreaterThan(0);

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
      merge_policy_version: 'phase2.semantic-merge.v1',
      decision: 'merge',
      validator_results: {
        disjoint_paths: 'ok',
        overlapping_path_count: 0
      }
    });
  });

  it('acknowledges a safe paired main before the first manual sync', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'paired-empty-device');
    await mkdirp(deviceDir);

    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    expect(state).toMatchObject({
      status_label: 'Synced',
      initial_import_confirmed: true
    });
    expect(state.local_main).toMatch(/^[0-9a-f]{40}$/u);

    const dashboard = await admin.get<{
      vault: { current_main: string };
      devices: Array<{
        device_name: string;
        status_label: string;
        behind_main: boolean;
        last_applied_main: string | null;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'laptop')).toMatchObject({
      status_label: 'Synced',
      behind_main: false,
      last_applied_main: dashboard.body.vault.current_main
    });
  });

  it('reports plugin updates and rejects clients below the minimum version', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'plugin-compatibility-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = JSON.parse(await readFile(join(deviceDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as {
      device_token: string;
    };

    const statusResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/device-status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.device_token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        plugin_version: '0.1.17',
        local_status_label: 'Synced',
        local_error_code: null,
        local_queue_status: 'idle',
        local_main: state.local_main,
        local_head: state.local_head
      })
    });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      status: 'ok',
      plugin: {
        current_version: '0.1.17',
        minimum_version: MINIMUM_PLUGIN_VERSION,
        recommended_version: RECOMMENDED_PLUGIN_VERSION,
        update_required: true,
        update_available: true
      }
    });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        plugin_version: '0.0.1',
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest',
        current_event_seq: state.last_event_seq
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)]), 'have.pack');
    const pullResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.device_token}` },
      body: form
    });
    expect(pullResponse.status).toBe(409);
    expect(await pullResponse.json()).toMatchObject({ error: { code: 'plugin_update_required' } });
  });

  it('records local watcher change hints durably and consumes them through normal sync', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'watcher-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');

    await writeFile(join(deviceDir, 'watched.md'), 'from watcher\n');
    await plugin.recordLocalChangeHint(['watched.md', '.obts/state.json', '.git/config', '../outside.md']);
    expect(await plugin.readState()).toMatchObject({
      status_label: 'Checking',
      last_error_code: null
    });
    expect(await plugin.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });

    const restartedPlugin = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrl,
      deviceName: 'laptop',
    });
    await restartedPlugin.initialize();
    expect(await restartedPlugin.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });

    const sync = await restartedPlugin.syncOnce();
    expect(sync.status).toBe('Synced');
    const finalQueue = await restartedPlugin.readQueue();
    expect(finalQueue.pending_commit).toBeNull();
    expect(finalQueue.status).not.toBe('queued_local');
    const main = (await restartedPlugin.readState()).local_main;
    expect(main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await server.git.listTreePaths(admin.vaultId, main!)).toContain('watched.md');
  });

  it('clears a watcher hint when the reconciled vault tree is unchanged', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'watcher-noop-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'noop-laptop');

    await plugin.recordLocalChangeHint(['already-gone.md']);
    expect(await plugin.readState()).toMatchObject({ status_label: 'Checking' });
    expect(await plugin.readQueue()).toMatchObject({ pending_commit: null, status: 'queued_local' });

    expect((await plugin.syncOnce()).status).toBe('Synced');
    expect(await plugin.readQueue()).toMatchObject({ pending_commit: null, status: 'idle' });
  });

  it('does not clear a newer watcher hint that arrives during reconciliation', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'watcher-race-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'race-laptop');

    await plugin.recordLocalChangeHint(['first-hint.md']);
    const beforeRaceChangeSeq = (await plugin.readQueue()).change_seq ?? 0;
    const internals = plugin as unknown as {
      git: { createLocalCommit: (message: string, knownFiles?: string[]) => Promise<string | null> };
    };
    const createLocalCommit = internals.git.createLocalCommit.bind(internals.git);
    internals.git.createLocalCommit = async (message, knownFiles) => {
      const result = await createLocalCommit(message, knownFiles);
      await plugin.recordLocalChangeHint(['newer-hint.md']);
      return result;
    };

    await plugin.syncOnce();
    expect(await plugin.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local',
      change_seq: beforeRaceChangeSeq + 1
    });

    internals.git.createLocalCommit = createLocalCommit;
    await plugin.syncOnce();
    expect(await plugin.readQueue()).toMatchObject({ pending_commit: null, status: 'idle' });
  });

  it('syncs Obsidian-valid punctuation paths and large markdown directories', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'fixtureA-punctuation-large');
    const fixtureBDir = join(root, 'fixtureB-punctuation-large');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA');
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB');

    const punctuationPaths = [
      'Notes/can local tooling connect to docker on a remote host?.md',
      'Projects/Launch Plan -> Checklist.md'
    ];
    for (const filePath of punctuationPaths) {
      await mkdirp(join(fixtureADir, filePath.split('/').slice(0, -1).join('/')));
      await writeFile(join(fixtureADir, filePath), `${filePath}\n`);
    }
    await mkdirp(join(fixtureADir, 'bulk'));
    for (let index = 0; index < 240; index += 1) {
      await writeFile(join(fixtureADir, 'bulk', `note-${String(index).padStart(3, '0')}.md`), `bulk ${index}\n`);
    }

    expect((await fixtureA.syncOnce()).status).toBe('Synced');
    expect((await fixtureB.syncOnce()).status).toBe('Synced');
    for (const filePath of punctuationPaths) {
      expect(await readFile(join(fixtureBDir, filePath), 'utf8')).toBe(`${filePath}\n`);
    }
    expect(await readFile(join(fixtureBDir, 'bulk', 'note-239.md'), 'utf8')).toBe('bulk 239\n');
    expect((await server.git.listTreePaths(admin.vaultId, (await fixtureA.readState()).local_main!)).length).toBeGreaterThanOrEqual(242);
  });

  it('reports local plugin block state to the dashboard', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'status-report-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const statePath = join(deviceDir, '.obts', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Json;
    await writeFile(statePath, `${JSON.stringify({
      ...state,
      status_label: 'Unsafe local state',
      last_error_code: 'invalid_path',
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    await plugin.reportDeviceStatus();
    const dashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; local_error_code: string | null; blocked: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'laptop')).toMatchObject({
      status_label: 'Unsafe local state',
      local_error_code: 'invalid_path',
      blocked: true
    });
  });

  it('requeues stranded local commits when queue metadata is lost', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'stranded-commit-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');

    await writeFile(join(deviceDir, 'stranded.md'), 'stranded\n');
    const localGit = new LocalGitEngine(deviceDir);
    await localGit.initialize();
    const strandedCommit = await localGit.createLocalCommit('obts: stranded local change');
    const statePath = join(deviceDir, '.obts', 'state.json');
    const queuePath = join(deviceDir, '.obts', 'queue.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Json;
    await writeFile(statePath, `${JSON.stringify({
      ...state,
      local_head: strandedCommit,
      status_label: 'Ahead',
      last_error_code: null,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    await writeFile(queuePath, `${JSON.stringify({
      pending_commit: null,
      expected_device_ref: state.server_device_ref,
      status: 'idle',
      attempts: 0,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    expect((await plugin.syncOnce()).status).toBe('Synced');
    const main = (await plugin.readState()).local_main!;
    expect(await server.git.listTreePaths(admin.vaultId, main)).toContain('stranded.md');
  });

  it('refreshes a stale local device ref after a previously accepted upload', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'stale-local-device-ref');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const staleDeviceRef = (await plugin.readState()).server_device_ref;
    expect(staleDeviceRef).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'accepted.md'), 'accepted\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const currentDeviceRef = (await plugin.readState()).server_device_ref;
    expect(currentDeviceRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(currentDeviceRef).not.toBe(staleDeviceRef);

    const statePath = join(deviceDir, '.obts', 'state.json');
    const staleState = JSON.parse(await readFile(statePath, 'utf8')) as Json;
    await writeFile(statePath, `${JSON.stringify({
      ...staleState,
      server_device_ref: staleDeviceRef,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    await writeFile(join(deviceDir, 'after-stale.md'), 'after stale\n');

    expect((await plugin.syncOnce()).status).toBe('Synced');
    const finalState = await plugin.readState();
    expect(finalState.server_device_ref).not.toBe(staleDeviceRef);
    expect(await server.git.listTreePaths(admin.vaultId, finalState.local_main!)).toContain('after-stale.md');
  });

  it('syncs explicit empty folder creation to another device', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'empty-folder-desktop');
    const phoneDir = join(root, 'empty-folder-phone');
    await mkdirp(desktopDir);
    await mkdirp(phoneDir);
    await writeFile(join(desktopDir, 'base.md'), 'base\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    expect((await desktop.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const phone = await pairPlugin(admin, phoneDir, 'phone');

    await mkdirp(join(desktopDir, 'Empty Folder'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await phone.syncOnce()).status).toBe('Synced');

    expect(await isDirectory(join(phoneDir, 'Empty Folder'))).toBe(true);
  });

  it('syncs folder delete tombstones without pruning individually emptied folders', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'folder-delete-desktop');
    const phoneDir = join(root, 'folder-delete-phone');
    await mkdirp(desktopDir);
    await mkdirp(phoneDir);
    await mkdirp(join(desktopDir, 'Delete Me', 'nested', 'deeper'));
    await mkdirp(join(desktopDir, 'Delete Me', 'empty-sibling', 'leaf'));
    await mkdirp(join(desktopDir, 'Keep Shell'));
    await writeFile(join(desktopDir, 'Delete Me', 'nested', 'deeper', 'note.md'), 'delete me\n');
    await writeFile(join(desktopDir, 'Keep Shell', 'note.md'), 'keep shell\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    expect((await desktop.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const phone = await pairPlugin(admin, phoneDir, 'phone');

    await rm(join(desktopDir, 'Delete Me'), { recursive: true, force: true });
    await rm(join(desktopDir, 'Keep Shell', 'note.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const phoneInternal = (phone as unknown as { client: { adapter: { rmdir: (path: string, recursive: boolean) => Promise<void> } } }).client;
    const originalRmdir = phoneInternal.adapter.rmdir.bind(phoneInternal.adapter);
    const recursiveDeleteFlags: boolean[] = [];
    let injectedRmdirFailure = false;
    phoneInternal.adapter.rmdir = async (path, recursive) => {
      if (path === 'Delete Me' || path.startsWith('Delete Me/')) {
        recursiveDeleteFlags.push(recursive);
        if (!injectedRmdirFailure) {
          injectedRmdirFailure = true;
          const error = new Error('simulated transient directory adapter failure') as Error & { code?: string };
          error.code = 'EIO';
          throw error;
        }
      }
      await originalRmdir(path, recursive);
    };
    expect((await phone.syncOnce()).status).toBe('Synced');

    expect(injectedRmdirFailure).toBe(true);
    expect(recursiveDeleteFlags.length).toBeGreaterThan(1);
    expect(recursiveDeleteFlags.every((recursive) => recursive === false)).toBe(true);
    expect(await exists(join(phoneDir, 'Delete Me'))).toBe(false);
    expect(await isDirectory(join(phoneDir, 'Keep Shell'))).toBe(true);
    expect(await exists(join(phoneDir, 'Keep Shell', 'note.md'))).toBe(false);
  });

  it('does not resurrect a deleted nested folder hierarchy from another device', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'nested-delete-source');
    const receiverDir = join(root, 'nested-delete-receiver');
    const observerDir = join(root, 'nested-delete-observer');
    await mkdirp(join(sourceDir, 'Main Vault', 'Projects', 'Archive', 'Empty Child'));
    await mkdirp(join(receiverDir));
    await mkdirp(join(observerDir));
    await writeFile(join(sourceDir, 'Main Vault', 'Projects', 'Archive', 'note.md'), 'delete the tree\n');
    const source = await pairPlugin(admin, sourceDir, 'nested-delete-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'nested-delete-receiver');
    const observer = await pairPlugin(admin, observerDir, 'nested-delete-observer');
    expect(await isDirectory(join(receiverDir, 'Main Vault', 'Projects', 'Archive', 'Empty Child'))).toBe(true);

    await rm(join(sourceDir, 'Main Vault'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');
    expect((await receiver.syncOnce()).status).toBe('Synced');
    expect(await exists(join(receiverDir, 'Main Vault'))).toBe(false);
    expect(await receiver.readQueue()).toMatchObject({ status: 'idle', pending_commit: null });

    expect((await receiver.syncOnce()).status).toBe('Synced');
    expect((await observer.syncOnce()).status).toBe('Synced');
    expect(await exists(join(observerDir, 'Main Vault'))).toBe(false);
    const directoryState = (await server.store.snapshot()).directory_state_by_vault[admin.vaultId];
    expect(directoryState?.explicit_dirs.some((path) => path === 'Main Vault' || path.startsWith('Main Vault/'))).toBe(false);
  });

  it('recovers a legacy folder-delete apply interrupted by a BRAT reload', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'reload-delete-source');
    const receiverDir = join(root, 'reload-delete-receiver');
    await mkdirp(sourceDir);
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'base.md'), 'base\n');
    const source = await pairPlugin(admin, sourceDir, 'reload-delete-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'reload-delete-receiver');
    await mkdirp(join(sourceDir, 'mainvault', 'Nested', 'Empty Leaf'));
    expect((await source.syncOnce()).status).toBe('Synced');
    expect((await receiver.syncOnce()).status).toBe('Synced');
    expect(await isDirectory(join(receiverDir, 'mainvault', 'Nested', 'Empty Leaf'))).toBe(true);

    await mkdirp(join(sourceDir, '.trash'));
    await rename(join(sourceDir, 'mainvault'), join(sourceDir, '.trash', 'mainvault'));
    expect((await source.syncOnce()).status).toBe('Synced');
    const targetMain = (await source.readState()).local_main!;
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    const currentApplyDirectoryChanges = receiverInternal.applyDirectoryChanges.bind(receiverInternal);
    receiverInternal.applyDirectoryChanges = async (_intents: unknown, explicitDirectories: string[]) =>
      await currentApplyDirectoryChanges([], explicitDirectories);
    const originalUpdateRef = receiverInternal.updateRef.bind(receiverInternal);
    receiverInternal.updateRef = async (ref: string, target: string, expected: string | null, force = false) => {
      if (ref === 'refs/heads/local' && expected && !force) {
        await writeFile(join(receiverDir, '.obts', 'git', 'refs', 'heads', 'local.lock'), `${target}\n`);
        throw new Error('simulated BRAT reload during preserved directory ref update');
      }
      return await originalUpdateRef(ref, target, expected, force);
    };
    await expect(receiver.syncOnce()).rejects.toThrow('simulated BRAT reload');
    expect(await exists(join(receiverDir, 'mainvault'))).toBe(true);
    expect((JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-state.json'), 'utf8')) as { pending_intents: unknown[] }).pending_intents).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'create', path: 'mainvault' }),
      expect.objectContaining({ op: 'create', path: 'mainvault/Nested' }),
      expect.objectContaining({ op: 'create', path: 'mainvault/Nested/Empty Leaf' })
    ]));
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'apply-journal.json'), 'utf8'))).toMatchObject({
      phase: 'committed',
      last_completed_step: 'refs_updated'
    });

    // Emulate the legacy client, which cleared its apply journal before queue finalization.
    await rm(join(receiverDir, '.obts', 'apply-journal.json'), { force: true });
    const statePath = join(receiverDir, '.obts', 'state.json');
    const interruptedState = JSON.parse(await readFile(statePath, 'utf8')) as Json;
    delete interruptedState.last_applied_event_seq;
    await writeFile(statePath, `${JSON.stringify({
      ...interruptedState,
      status_label: 'Unsafe local state',
      last_error_code: 'sync_error',
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    const refLockPath = join(receiverDir, '.obts', 'git', 'refs', 'heads', 'local.lock');
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(refLockPath, staleTime, staleTime);

    const restarted = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'reload-delete-receiver' });
    await restarted.initialize();
    expect(await exists(refLockPath)).toBe(false);
    await expect(restarted.syncOnce()).rejects.toMatchObject({ code: 'directory_recovery_decision_required' });
    const recovery = JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-recovery.json'), 'utf8')) as Json;
    expect(recovery).toMatchObject({
      version: 1,
      phase: 'awaiting_decision',
      target_main: targetMain,
      ambiguous_roots: ['mainvault'],
      ambiguous_intents: expect.arrayContaining([
        expect.objectContaining({ op: 'create', path: 'mainvault', provenance: 'local_v2' })
      ])
    });
    expect(await exists(join(receiverDir, 'mainvault'))).toBe(true);
    const restartedInternal = (restarted as unknown as { client: Record<string, any> }).client;
    const originalApplyTargetMain = restartedInternal.applyTargetMain.bind(restartedInternal);
    let interruptedDecision = false;
    restartedInternal.applyTargetMain = async (...args: unknown[]) => {
      const result = await originalApplyTargetMain(...args);
      if (!interruptedDecision) {
        interruptedDecision = true;
        throw new Error('simulated reload after directory apply completed');
      }
      return result;
    };
    await expect(restarted.resolveDirectoryRecovery({ mainvault: 'accept_server' })).rejects.toThrow('simulated reload');
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-recovery.json'), 'utf8'))).toMatchObject({
      phase: 'executing',
      decisions: { mainvault: 'accept_server' },
      archived: true,
      last_completed_step: 'intent_state_written'
    });
    expect(await exists(join(receiverDir, 'mainvault'))).toBe(false);
    const resumed = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'reload-delete-receiver' });
    const resumedInternal = (resumed as unknown as { client: Record<string, any> }).client;
    const originalAcknowledge = resumedInternal.acknowledgeAppliedMain.bind(resumedInternal);
    let interruptedAcknowledgement = false;
    resumedInternal.acknowledgeAppliedMain = async (...args: unknown[]) => {
      const result = await originalAcknowledge(...args);
      if (!interruptedAcknowledgement) {
        interruptedAcknowledgement = true;
        throw new Error('simulated lost acknowledgement response during directory recovery');
      }
      return result;
    };
    await expect(resumed.initialize()).rejects.toThrow('simulated lost acknowledgement');
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-recovery.json'), 'utf8'))).toMatchObject({
      phase: 'executing',
      last_completed_step: 'apply_completed'
    });
    const acknowledged = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'reload-delete-receiver' });
    await acknowledged.initialize();
    expect(await exists(join(receiverDir, '.obts', 'directory-recovery.json'))).toBe(false);
    expect(await exists(join(receiverDir, 'mainvault'))).toBe(false);
    expect(await acknowledged.readQueue()).toMatchObject({ status: 'idle', pending_commit: null });
    expect((JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-state.json'), 'utf8')) as { pending_intents: unknown[] }).pending_intents).toEqual([]);
    expect(await acknowledged.readState()).toMatchObject({
      local_main: targetMain,
      local_head: targetMain,
      status_label: 'Synced',
      last_error_code: null,
      last_applied_event_seq: expect.any(Number)
    });
    const finalState = await acknowledged.readState();
    const device = (await server.store.snapshot()).devices.find((entry) => entry.device_id === finalState.device_id);
    expect(device?.last_applied_main).toBe(targetMain);
    expect((await server.store.snapshot()).directory_state_by_vault[admin.vaultId]?.explicit_dirs).not.toEqual(
      expect.arrayContaining(['mainvault'])
    );
  });

  it('replays directory state from the acknowledged snapshot after event retention', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'retained-directory-source');
    const receiverDir = join(root, 'retained-directory-receiver');
    await mkdirp(sourceDir);
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'base.md'), 'base\n');
    const source = await pairPlugin(admin, sourceDir, 'retained-directory-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'retained-directory-receiver');
    await mkdirp(join(sourceDir, 'mainvault', 'Nested'));
    expect((await source.syncOnce()).status).toBe('Synced');
    expect((await receiver.syncOnce()).status).toBe('Synced');
    expect(await isDirectory(join(receiverDir, 'mainvault', 'Nested'))).toBe(true);

    await mkdirp(join(sourceDir, '.trash'));
    await rename(join(sourceDir, 'mainvault'), join(sourceDir, '.trash', 'mainvault'));
    expect((await source.syncOnce()).status).toBe('Synced');
    await server.store.mutate((db) => {
      db.events = db.events.filter((event) => event.vault_id !== admin.vaultId);
    });

    expect((await receiver.syncOnce()).status).toBe('Synced');
    expect(await exists(join(receiverDir, 'mainvault'))).toBe(false);
    expect(await isDirectory(join(receiverDir, '.trash', 'mainvault', 'Nested'))).toBe(true);
    const state = await receiver.readState();
    const device = (await server.store.snapshot()).devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.last_applied_main).toBe(state.local_main);
    expect(device?.last_applied_explicit_dirs).toEqual(expect.arrayContaining(['.trash/mainvault', '.trash/mainvault/Nested']));
  });

  it('classifies legacy directory creates without mutating evidence or trusting timestamps', async () => {
    const deviceDir = join(root, 'directory-recovery-provenance');
    await mkdirp(join(deviceDir, '.trash', 'remote-marker'));
    await mkdirp(join(deviceDir, 'stale-tree'));
    await mkdirp(join(deviceDir, 'new-tree'));
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'directory-recovery-provenance' });
    await plugin.initialize();
    const directoryStatePath = join(deviceDir, '.obts', 'directory-state.json');
    await writeFile(directoryStatePath, `${JSON.stringify({
      observed_dirs: ['.trash', '.trash/remote-marker', 'new-tree', 'stale-tree'],
      explicit_empty_dirs: ['.trash/remote-marker', 'new-tree', 'stale-tree'],
      pending_intents: [
        { op: 'create', path: 'stale-tree' },
        { op: 'create', path: 'new-tree' }
      ],
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    const before = await readFile(directoryStatePath, 'utf8');
    const internals = (plugin as unknown as { client: Record<string, any> }).client;
    const classification = await internals.classifyDirectoryIntentsForRecovery([
      { op: 'create', path: '.trash' },
      { op: 'create', path: '.trash/remote-marker' },
      { op: 'delete', path: 'stale-tree' },
      { op: 'delete', path: 'new-tree' }
    ]);
    expect(classification.superseded).toEqual([]);
    expect(classification.ambiguous).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'create', path: 'stale-tree', provenance: 'legacy' }),
      expect.objectContaining({ op: 'create', path: 'new-tree', provenance: 'legacy' })
    ]));
    expect(await readFile(directoryStatePath, 'utf8')).toBe(before);
  });

  it('fails closed on malformed or path-traversing directory recovery journals', async () => {
    const deviceDir = join(root, 'directory-recovery-invalid-journal');
    await mkdirp(deviceDir);
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'directory-recovery-invalid-journal' });
    await plugin.initialize();
    const recoveryPath = join(deviceDir, '.obts', 'directory-recovery.json');
    await writeFile(recoveryPath, '{malformed');
    await expect(plugin.readDirectoryRecoveryDecision()).rejects.toMatchObject({ code: 'directory_recovery_journal_invalid' });
    expect(await readFile(recoveryPath, 'utf8')).toBe('{malformed');

    await mkdirp(join(deviceDir, 'Ambiguous'));
    await writeFile(join(deviceDir, '.obts', 'directory-state.json'), `${JSON.stringify({
      observed_dirs: ['Ambiguous'],
      explicit_empty_dirs: ['Ambiguous'],
      pending_intents: [{ op: 'create', path: 'Ambiguous' }],
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    await rm(recoveryPath, { force: true });
    const internals = (plugin as unknown as { client: Record<string, any> }).client;
    const remoteIntents = [{ op: 'delete', path: 'Ambiguous' }];
    const classification = await internals.classifyDirectoryIntentsForRecovery(remoteIntents);
    const valid = await internals.stageDirectoryRecoveryDecision({
      state: { local_main: 'a'.repeat(40), local_head: 'a'.repeat(40) },
      serverState: { last_applied_main: '9'.repeat(40) },
      manifest: { target_main: 'a'.repeat(40), event_seq: 1, changed_paths: [], directory_intents: remoteIntents, explicit_directories: [] },
      classification
    });
    await writeFile(recoveryPath, `${JSON.stringify({ ...valid, recovery_id: '../escape' }, null, 2)}\n`);
    await expect(plugin.readDirectoryRecoveryDecision()).rejects.toMatchObject({ code: 'directory_recovery_journal_invalid' });
    expect(await exists(join(deviceDir, 'escape'))).toBe(false);

    const substituted = JSON.parse(JSON.stringify(valid)) as any;
    substituted.ambiguous_intents[0].path = 'Different Tree';
    substituted.ambiguous_roots = ['Different Tree'];
    substituted.directory_intents = [{ op: 'delete', path: 'Different Tree' }];
    await writeFile(recoveryPath, `${JSON.stringify(substituted, null, 2)}\n`);
    await expect(plugin.readDirectoryRecoveryDecision()).rejects.toMatchObject({ code: 'directory_recovery_journal_invalid' });

    const categorySwap = JSON.parse(JSON.stringify(valid)) as any;
    categorySwap.superseded_intents = categorySwap.ambiguous_intents;
    categorySwap.ambiguous_intents = [];
    categorySwap.ambiguous_roots = [];
    await writeFile(recoveryPath, `${JSON.stringify(categorySwap, null, 2)}\n`);
    await expect(plugin.readDirectoryRecoveryDecision()).rejects.toMatchObject({ code: 'directory_recovery_journal_invalid' });
  });

  it('clears only acknowledged directory intent generations and retains recreation provenance', async () => {
    const deviceDir = join(root, 'directory-intent-generations');
    await mkdirp(join(deviceDir, 'Recreated'));
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'directory-intent-generations' });
    await plugin.initialize();
    const internals = (plugin as unknown as { client: Record<string, any> }).client;
    const statePath = join(deviceDir, '.obts', 'directory-state.json');
    const originalCtime = (await stat(join(deviceDir, 'Recreated'))).birthtimeMs;
    await writeFile(statePath, `${JSON.stringify({
      version: 2,
      next_generation: 4,
      observed_dirs: ['Recreated'],
      observed_directory_ctimes: { Recreated: originalCtime },
      explicit_empty_dirs: ['Recreated'],
      pending_intents: [
        { op: 'create', path: 'Sent', intent_id: 'dir_sent', generation: 1, provenance: 'local_v2' },
        { op: 'delete', path: 'Recreated', intent_id: 'dir_delete', generation: 2, provenance: 'local_v2' },
        { op: 'create', path: 'Recreated', intent_id: 'dir_recreated', generation: 3, provenance: 'local_v2' }
      ],
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    const directoryState = await internals.readDirectoryState();
    expect(directoryState.pending_intents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'Recreated',
        intent_id: 'dir_recreated',
        replaces_intent_id: 'dir_delete',
        recreated_after_delete: true
      })
    ]));
    await rm(join(deviceDir, 'Recreated'), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdirp(join(deviceDir, 'Recreated'));
    await internals.clearAcknowledgedDirectoryIntents([
      { op: 'create', path: 'Sent', intent_id: 'dir_sent', generation: 1, provenance: 'local_v2' }
    ]);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { next_generation: number; pending_intents: Array<Record<string, unknown>> };
    expect(persisted.pending_intents).toHaveLength(1);
    expect(persisted.pending_intents[0]).toMatchObject({ path: 'Recreated', generation: 4, recreated_after_delete: true });
    expect(persisted.pending_intents[0]?.intent_id).not.toBe('dir_recreated');
    expect(persisted.next_generation).toBe(5);
  });

  it('preserves changed local directories through an explicit keep-local recovery decision', async () => {
    const deviceDir = join(root, 'directory-recovery-keep-local');
    await mkdirp(join(deviceDir, 'Keep Tree', 'Empty Child'));
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'directory-recovery-keep-local' });
    await plugin.initialize();
    const internals = (plugin as unknown as { client: Record<string, any> }).client;
    const targetMain = await internals.createLocalCommit('directory recovery base');
    await internals.updateRef('refs/heads/main', targetMain, null, true);
    await plugin.writeState({
      ...(await plugin.readState()),
      user_id: 'usr_recovery',
      vault_id: 'vlt_recovery',
      device_id: 'dev_recovery',
      device_ref: 'refs/obts/devices/dev_recovery',
      server_device_ref: targetMain,
      local_main: targetMain,
      local_head: targetMain,
      initial_import_confirmed: true,
      status_label: 'Synced',
      last_error_code: null,
      last_event_seq: 11,
      last_applied_event_seq: 11,
      updated_at: new Date().toISOString()
    });
    const directoryStatePath = join(deviceDir, '.obts', 'directory-state.json');
    await writeFile(directoryStatePath, `${JSON.stringify({
      observed_dirs: ['Keep Tree', 'Keep Tree/Empty Child'],
      explicit_empty_dirs: ['Keep Tree', 'Keep Tree/Empty Child'],
      pending_intents: [{ op: 'create', path: 'Keep Tree' }, { op: 'create', path: 'Keep Tree/Empty Child' }],
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);
    const remoteIntents = [{ op: 'delete', path: 'Keep Tree' }];
    const classification = await internals.classifyDirectoryIntentsForRecovery(remoteIntents);
    await internals.stageDirectoryRecoveryDecision({
      state: await plugin.readState(),
      serverState: { last_applied_main: '9'.repeat(40) },
      manifest: {
        target_main: targetMain,
        event_seq: 12,
        changed_paths: [],
        directory_intents: remoteIntents,
        explicit_directories: []
      },
      classification
    });

    await writeFile(join(deviceDir, 'Keep Tree', 'new.md'), 'created while the decision was open\n');
    await expect(plugin.resolveDirectoryRecovery({ 'Keep Tree': 'accept_server' })).rejects.toMatchObject({
      code: 'directory_recovery_changed'
    });
    expect(JSON.parse(await readFile(join(deviceDir, '.obts', 'directory-recovery.json'), 'utf8'))).toMatchObject({
      phase: 'awaiting_decision',
      archived: false,
      inventory: { files: [expect.objectContaining({ path: 'Keep Tree/new.md' })] }
    });
    expect((JSON.parse(await readFile(directoryStatePath, 'utf8')) as { pending_intents: unknown[] }).pending_intents).toHaveLength(2);

    let appliedDirectoryIntents: unknown[] | null = null;
    const applyTargetMain = internals.applyTargetMain.bind(internals);
    internals.applyTargetMain = async (...args: unknown[]) => {
      appliedDirectoryIntents = args[5] as unknown[];
      return await applyTargetMain(...args);
    };
    internals.acknowledgeAppliedMain = async () => undefined;
    expect((await plugin.resolveDirectoryRecovery({ 'Keep Tree': 'keep_local' })).status).toBe('Ahead');
    expect(appliedDirectoryIntents).toEqual([]);
    expect(await plugin.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: expect.any(String) });
    expect(await readFile(join(deviceDir, 'Keep Tree', 'new.md'), 'utf8')).toBe('created while the decision was open\n');
    expect((JSON.parse(await readFile(directoryStatePath, 'utf8')) as { pending_intents: unknown[] }).pending_intents).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'create', path: 'Keep Tree' }),
      expect.objectContaining({ op: 'create', path: 'Keep Tree/Empty Child' })
    ]));
    expect(await exists(join(deviceDir, '.obts', 'directory-recovery.json'))).toBe(false);
  });

  it('replays nested directory tombstones after a crash before pruning', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'tombstone-crash-source');
    const receiverDir = join(root, 'tombstone-crash-receiver');
    await mkdirp(join(sourceDir, 'Crash Tree', 'Nested', 'Empty Leaf'));
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'Crash Tree', 'Nested', 'note.md'), 'removed before crash\n');
    const source = await pairPlugin(admin, sourceDir, 'tombstone-crash-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'tombstone-crash-receiver');

    await rm(join(sourceDir, 'Crash Tree'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    const originalApplyDirectoryChanges = receiverInternal.applyDirectoryChanges.bind(receiverInternal);
    let interrupted = false;
    receiverInternal.applyDirectoryChanges = async (...args: unknown[]) => {
      if (!interrupted) {
        interrupted = true;
        throw new Error('simulated crash before directory pruning');
      }
      return await originalApplyDirectoryChanges(...args);
    };
    await expect(receiver.syncOnce()).rejects.toThrow('simulated crash before directory pruning');
    expect(interrupted).toBe(true);
    expect(await exists(join(receiverDir, 'Crash Tree'))).toBe(true);
    expect(await exists(join(receiverDir, 'Crash Tree', 'Nested', 'note.md'))).toBe(false);
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'apply-journal.json'), 'utf8'))).toMatchObject({
      journal_version: 3,
      phase: 'writing_files',
      directory_intents: [{ op: 'delete', path: 'Crash Tree' }],
      preserve_local_changes: true
    });
    await writeFile(join(receiverDir, 'local-after-crash.md'), 'must survive recovery\n');

    const restarted = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'tombstone-crash-receiver' });
    await restarted.initialize();
    expect(await exists(join(receiverDir, 'Crash Tree'))).toBe(false);
    expect(await exists(join(receiverDir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await restarted.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: expect.any(String) });
    expect(await restarted.readState()).toMatchObject({ status_label: 'Ahead', last_error_code: null });
    expect((await restarted.syncOnce()).status).toBe('Synced');
    expect(await exists(join(receiverDir, 'Crash Tree'))).toBe(false);
    expect(await server.git.listTreePaths(admin.vaultId, (await restarted.readState()).local_main!)).toContain('local-after-crash.md');
  });

  it('retries a durable applied-main acknowledgement after reload', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'pending-ack-source');
    const receiverDir = join(root, 'pending-ack-receiver');
    await mkdirp(sourceDir);
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'base.md'), 'base\n');
    const source = await pairPlugin(admin, sourceDir, 'pending-ack-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'pending-ack-receiver');
    await writeFile(join(sourceDir, 'after.md'), 'after\n');
    expect((await source.syncOnce()).status).toBe('Synced');
    const targetMain = (await source.readState()).local_main!;
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    receiverInternal.acknowledgeAppliedMain = async () => {
      throw new Error('simulated reload before server apply acknowledgement');
    };

    await expect(receiver.syncOnce()).rejects.toThrow('simulated reload before server apply acknowledgement');
    expect(await exists(join(receiverDir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'pending-applied-ack.json'), 'utf8'))).toMatchObject({
      target_main: targetMain,
      event_seq: expect.any(Number)
    });
    const interruptedState = await receiver.readState();
    const interruptedDevice = (await server.store.snapshot()).devices.find((device) => device.device_id === interruptedState.device_id);
    expect(interruptedDevice?.last_applied_main).not.toBe(targetMain);
    const committedAck = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/applied`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await readDeviceToken(receiverDir)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ applied_main: targetMain })
    });
    expect(committedAck.status).toBe(200);
    expect(await exists(join(receiverDir, '.obts', 'pending-applied-ack.json'))).toBe(true);

    await writeFile(join(sourceDir, 'newer.md'), 'newer while acknowledgement is pending\n');
    expect((await source.syncOnce()).status).toBe('Synced');
    const newestMain = (await source.readState()).local_main!;
    expect(newestMain).not.toBe(targetMain);
    await server.store.mutate((db) => {
      db.events = db.events.filter((event) => event.vault_id !== admin.vaultId);
    });

    const restarted = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'pending-ack-receiver' });
    expect((await restarted.syncOnce()).status).toBe('Synced');
    expect(await exists(join(receiverDir, '.obts', 'pending-applied-ack.json'))).toBe(false);
    const finalState = await restarted.readState();
    expect(finalState).toMatchObject({ local_main: newestMain, last_applied_event_seq: expect.any(Number) });
    const recoveredDevice = (await server.store.snapshot()).devices.find((device) => device.device_id === finalState.device_id);
    expect(recoveredDevice?.last_applied_main).toBe(newestMain);
  });

  it('finishes committed v3 directory recovery with the target event cursor', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'committed-tombstone-source');
    const receiverDir = join(root, 'committed-tombstone-receiver');
    await mkdirp(join(sourceDir, 'Committed Tree', 'Nested'));
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'Committed Tree', 'Nested', 'note.md'), 'committed crash\n');
    const source = await pairPlugin(admin, sourceDir, 'committed-tombstone-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'committed-tombstone-receiver');

    await rm(join(sourceDir, 'Committed Tree'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    const originalWriteState = receiverInternal.writeState.bind(receiverInternal);
    let interrupted = false;
    receiverInternal.writeState = async (...args: unknown[]) => {
      let journal: { phase?: string } | null = null;
      try {
        journal = JSON.parse(await readFile(join(receiverDir, '.obts', 'apply-journal.json'), 'utf8')) as { phase?: string };
      } catch {
        journal = null;
      }
      if (!interrupted && journal?.phase === 'committed') {
        interrupted = true;
        throw new Error('simulated crash after committed directory journal');
      }
      return await originalWriteState(...args);
    };
    await expect(receiver.syncOnce()).rejects.toThrow('simulated crash after committed directory journal');
    const committedJournal = JSON.parse(await readFile(join(receiverDir, '.obts', 'apply-journal.json'), 'utf8')) as {
      journal_version: number;
      phase: string;
      event_seq: number;
    };
    expect(committedJournal).toMatchObject({ journal_version: 3, phase: 'committed', event_seq: expect.any(Number) });
    expect(await exists(join(receiverDir, 'Committed Tree'))).toBe(false);

    const restarted = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'committed-tombstone-receiver' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({
      status_label: 'Synced',
      last_error_code: null,
      last_event_seq: committedJournal.event_seq
    });
    expect(await exists(join(receiverDir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await exists(join(receiverDir, 'Committed Tree'))).toBe(false);
    expect((await restarted.syncOnce()).status).toBe('Synced');
    expect(await exists(join(receiverDir, 'Committed Tree'))).toBe(false);
  });

  it('preserves a new empty descendant created while pruning a remote tombstone', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'tombstone-race-source');
    const receiverDir = join(root, 'tombstone-race-receiver');
    await mkdirp(join(sourceDir, 'Delete Tree', 'Old Branch', 'Empty Leaf'));
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'Delete Tree', 'Old Branch', 'note.md'), 'remote deletion\n');
    const source = await pairPlugin(admin, sourceDir, 'tombstone-race-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'tombstone-race-receiver');

    await rm(join(sourceDir, 'Delete Tree'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    const originalWriteTargetFiles = receiverInternal.writeTargetFilesFromJournal.bind(receiverInternal);
    receiverInternal.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await originalWriteTargetFiles(...args);
      await mkdirp(join(receiverDir, 'Delete Tree', 'New Local Empty'));
    };

    const preservedResult = await receiver.syncOnce();
    expect(await exists(join(receiverDir, 'Delete Tree', 'Old Branch'))).toBe(false);
    expect(await isDirectory(join(receiverDir, 'Delete Tree', 'New Local Empty'))).toBe(true);
    expect((JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-state.json'), 'utf8')) as { pending_intents: unknown[] }).pending_intents).toEqual([]);
    expect(await receiver.readQueue()).toMatchObject({ status: 'idle', pending_commit: null });
    expect(preservedResult.status).toBe('Synced');
    expect((await server.store.snapshot()).directory_state_by_vault[admin.vaultId]?.explicit_dirs).toContain('Delete Tree/New Local Empty');

    expect((await source.syncOnce()).status).toBe('Synced');
    expect(await exists(join(sourceDir, 'Delete Tree', 'Old Branch'))).toBe(false);
    expect(await isDirectory(join(sourceDir, 'Delete Tree', 'New Local Empty'))).toBe(true);
  });

  it('preserves an empty tombstone root recreated at the same path during apply', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'same-path-directory-source');
    const receiverDir = join(root, 'same-path-directory-receiver');
    await mkdirp(join(sourceDir, 'Recreated Tree', 'Old Nested'));
    await mkdirp(receiverDir);
    await writeFile(join(sourceDir, 'Recreated Tree', 'Old Nested', 'note.md'), 'old content\n');
    const source = await pairPlugin(admin, sourceDir, 'same-path-directory-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'same-path-directory-receiver');

    await rm(join(sourceDir, 'Recreated Tree'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');
    const receiverInternal = (receiver as unknown as { client: Record<string, any> }).client;
    const originalWriteTargetFiles = receiverInternal.writeTargetFilesFromJournal.bind(receiverInternal);
    receiverInternal.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await originalWriteTargetFiles(...args);
      await rm(join(receiverDir, 'Recreated Tree'), { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mkdirp(join(receiverDir, 'Recreated Tree'));
    };

    const receiverResult = await receiver.syncOnce();
    expect(['Ahead', 'Synced']).toContain(receiverResult.status);
    expect(await isDirectory(join(receiverDir, 'Recreated Tree'))).toBe(true);
    expect(await exists(join(receiverDir, 'Recreated Tree', 'Old Nested'))).toBe(false);
    if (receiverResult.status === 'Ahead') expect((await receiver.syncOnce()).status).toBe('Synced');
    expect((await source.syncOnce()).status).toBe('Synced');
    expect(await isDirectory(join(sourceDir, 'Recreated Tree'))).toBe(true);
    expect(await exists(join(sourceDir, 'Recreated Tree', 'Old Nested'))).toBe(false);
  });

  it('does not apply an empty-folder tombstone over non-empty local content', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'nonempty-tombstone-desktop');
    const phoneDir = join(root, 'nonempty-tombstone-phone');
    await mkdirp(desktopDir);
    await mkdirp(phoneDir);
    await writeFile(join(desktopDir, 'base.md'), 'base\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    expect((await desktop.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const phone = await pairPlugin(admin, phoneDir, 'phone');

    await mkdirp(join(desktopDir, 'Scratch'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await phone.syncOnce()).status).toBe('Synced');
    await writeFile(join(phoneDir, 'Scratch', 'local.md'), 'local content\n');
    await rm(join(desktopDir, 'Scratch'), { recursive: true, force: true });
    expect((await desktop.syncOnce()).status).toBe('Synced');

    expect((await phone.syncOnce()).status).toBe('Synced');
    expect(await readFile(join(phoneDir, 'Scratch', 'local.md'), 'utf8')).toBe('local content\n');
  });

  it('recovers a newer same-device state backup after a stale primary overwrite', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'newer-backup-state');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    expect((await plugin.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const staleState = await plugin.readState();

    await writeFile(join(deviceDir, 'next.md'), 'next\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const currentState = await plugin.readState();
    expect(currentState.local_main).not.toBe(staleState.local_main);

    await writeFile(join(deviceDir, '.obts', 'state.json'), `${JSON.stringify({
      ...staleState,
      status_label: 'Unsafe local state',
      last_error_code: 'unsafe_local_state',
      updated_at: new Date(Date.now() - 60_000).toISOString()
    }, null, 2)}\n`);
    await writeFile(join(deviceDir, '.obts', 'state.json.bak'), `${JSON.stringify({
      ...currentState,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    const restartedPlugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'laptop' });
    await restartedPlugin.initialize();
    expect(await restartedPlugin.readState()).toMatchObject({
      local_main: currentState.local_main,
      local_head: currentState.local_head,
      status_label: 'Synced',
      last_error_code: null
    });
  });

  it('does not let stale state writers regress accepted local cursors', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'stale-state-writer');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    expect((await plugin.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const staleState = await plugin.readState();

    await writeFile(join(deviceDir, 'next.md'), 'next\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const currentState = await plugin.readState();
    expect(currentState.local_main).not.toBe(staleState.local_main);

    const internals = plugin as unknown as { writeState(state: unknown): Promise<void> };
    await internals.writeState({
      ...staleState,
      status_label: 'Unsafe local state',
      last_error_code: 'unsafe_local_state',
      updated_at: new Date().toISOString()
    });

    expect(await plugin.readState()).toMatchObject({
      local_main: currentState.local_main,
      local_head: currentState.local_head,
      server_device_ref: currentState.server_device_ref,
      status_label: 'Synced',
      last_error_code: null
    });
  });

  it('does not apply remote main over local edits that appear during pull', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'race-fixtureA');
    const fixtureBDir = join(root, 'race-fixtureB');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    await writeFile(join(fixtureADir, 'shared.md'), 'base\n');
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA');
    await fixtureA.syncOnce({ confirmInitialImport: true });
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('base\n');

    await writeFile(join(fixtureADir, 'shared.md'), 'fixtureA accepted\n');
    expect((await fixtureA.syncOnce()).status).toBe('Synced');

    const internals = fixtureB as unknown as {
      transport: {
        pullChunk: (input: { requestedTarget?: string; cursor: number }) => Promise<unknown>;
      };
    };
    const originalPull = internals.transport.pullChunk.bind(internals.transport);
    let injectedLocalEdit = false;
    internals.transport.pullChunk = async (input) => {
      const result = await originalPull(input);
      if (!injectedLocalEdit && input.cursor === 0) {
        injectedLocalEdit = true;
        await writeFile(join(fixtureBDir, 'shared.md'), 'fixtureB must survive\n');
      }
      return result;
    };

    const firstFixtureBSync = await fixtureB.syncOnce();
    expect(firstFixtureBSync.status).toBe('Ahead');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB must survive\n');
    expect(await fixtureB.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });

    const secondFixtureBSync = await fixtureB.syncOnce();
    expect(secondFixtureBSync.status).toBe('Review needed');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB must survive\n');
    const conflicts = await admin.get<{ conflicts: Array<{ status: string; affected_paths: string[] }> }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts?status=open`
    );
    expect(conflicts.body.conflicts).toEqual([
      expect.objectContaining({
        status: 'open',
        affected_paths: ['shared.md']
      })
    ]);
  });

  it('flushes dirty open editor content before applying remote main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'open-note-fixtureA');
    const fixtureBDir = join(root, 'open-note-fixtureB');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    await writeFile(join(fixtureADir, 'shared.md'), 'base\n');
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA-open');
    await fixtureA.syncOnce({ confirmInitialImport: true });
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB-open');
    const internals = fixtureB as unknown as {
      flushEditorBuffersToDisk: () => Promise<void>;
    };
    let flushedDirtyEditor = false;
    internals.flushEditorBuffersToDisk = async () => {
      if (!flushedDirtyEditor) {
        flushedDirtyEditor = true;
        await writeFile(join(fixtureBDir, 'shared.md'), 'fixtureB open edit\n');
      }
    };

    await writeFile(join(fixtureADir, 'shared.md'), 'fixtureA accepted\n');
    expect((await fixtureA.syncOnce()).status).toBe('Synced');

    const conflicted = await fixtureB.syncOnce();
    expect(conflicted.status).toBe('Review needed');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB open edit\n');
    expect(await fixtureB.readQueue()).toMatchObject({
      status: 'conflicted'
    });

    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB open edit\n');
  });

  it('does not apply remote main over local edits that appear during apply preparation', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'prep-race-fixtureA');
    const fixtureBDir = join(root, 'prep-race-fixtureB');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    await writeFile(join(fixtureADir, 'shared.md'), 'base\n');
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA-prep');
    await fixtureA.syncOnce({ confirmInitialImport: true });
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB-prep');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('base\n');

    await writeFile(join(fixtureADir, 'shared.md'), 'fixtureA accepted\n');
    expect((await fixtureA.syncOnce()).status).toBe('Synced');

    const internals = (fixtureB as unknown as { client: Record<string, (...args: unknown[]) => Promise<unknown>> }).client;
    const originalStageRecoveryBundle = internals.stageRecoveryBundleFiles!.bind(internals);
    let injectedLocalEdit = false;
    internals.stageRecoveryBundleFiles = async (...args) => {
      if (!injectedLocalEdit) {
        injectedLocalEdit = true;
        await writeFile(join(fixtureBDir, 'shared.md'), 'fixtureB during apply prep\n');
      }
      return await originalStageRecoveryBundle(...args);
    };

    const firstFixtureBSync = await fixtureB.syncOnce();
    expect(firstFixtureBSync.status).toBe('Ahead');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB during apply prep\n');
    expect(await exists(join(fixtureBDir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await fixtureB.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });

    const secondFixtureBSync = await fixtureB.syncOnce();
    expect(secondFixtureBSync.status).toBe('Review needed');
    expect(await readFile(join(fixtureBDir, 'shared.md'), 'utf8')).toBe('fixtureB during apply prep\n');
  });

  it('preserves user folder deletions made while a remote apply is writing files', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'delete-during-apply-fixtureA');
    const fixtureBDir = join(root, 'delete-during-apply-fixtureB');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    await writeFile(join(fixtureADir, 'base.md'), 'base\n');
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA-delete-during-apply');
    await fixtureA.syncOnce({ confirmInitialImport: true });
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB-delete-during-apply');

    await mkdirp(join(fixtureADir, 'incoming', 'keep'));
    await mkdirp(join(fixtureADir, 'incoming', 'remove'));
    await writeFile(join(fixtureADir, 'incoming', 'keep', 'a.md'), 'keep a\n');
    await writeFile(join(fixtureADir, 'incoming', 'remove', 'b.md'), 'remove b\n');
    await writeFile(join(fixtureADir, 'incoming', 'remove', 'c.md'), 'remove c\n');
    expect((await fixtureA.syncOnce()).status).toBe('Synced');

    const internals = fixtureB as unknown as {
      writeTargetFilesFromJournal: (...args: unknown[]) => Promise<void>;
    };
    const originalWriteTargetFiles = internals.writeTargetFilesFromJournal.bind(internals);
    let deletedDuringApply = false;
    internals.writeTargetFilesFromJournal = async (...args) => {
      await originalWriteTargetFiles(...args);
      if (!deletedDuringApply) {
        deletedDuringApply = true;
        await rm(join(fixtureBDir, 'incoming', 'remove'), { recursive: true, force: true });
      }
    };

    const applyResult = await fixtureB.syncOnce();
    expect(applyResult.status).toBe('Synced');
    expect(await readFile(join(fixtureBDir, 'incoming', 'keep', 'a.md'), 'utf8')).toBe('keep a\n');
    expect(await exists(join(fixtureBDir, 'incoming', 'remove', 'b.md'))).toBe(false);
    expect(await fixtureB.readQueue()).toMatchObject({ status: 'idle' });
    expect(await exists(join(fixtureBDir, '.obts', 'apply-journal.json'))).toBe(false);

    expect((await fixtureB.syncOnce()).status).toBe('Synced');
    const main = (await fixtureB.readState()).local_main!;
    const serverPaths = await server.git.listTreePaths(admin.vaultId, main);
    expect(serverPaths).toContain('incoming/keep/a.md');
    expect(serverPaths).not.toContain('incoming/remove/b.md');
    expect(serverPaths).not.toContain('incoming/remove/c.md');
  });

  it('recovers blocked apply journals with user deletions after files were written', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fixtureADir = join(root, 'blocked-delete-recovery-fixtureA');
    const fixtureBDir = join(root, 'blocked-delete-recovery-fixtureB');
    await mkdirp(fixtureADir);
    await mkdirp(fixtureBDir);
    await writeFile(join(fixtureADir, 'base.md'), 'base\n');
    const fixtureA = await pairPlugin(admin, fixtureADir, 'fixtureA-blocked-delete');
    await fixtureA.syncOnce({ confirmInitialImport: true });
    const fixtureB = await pairPlugin(admin, fixtureBDir, 'fixtureB-blocked-delete');
    const priorFixtureBState = await fixtureB.readState();

    await mkdirp(join(fixtureADir, 'incoming', 'keep'));
    await mkdirp(join(fixtureADir, 'incoming', 'remove'));
    await writeFile(join(fixtureADir, 'incoming', 'keep', 'a.md'), 'keep a\n');
    await writeFile(join(fixtureADir, 'incoming', 'remove', 'b.md'), 'remove b\n');
    await writeFile(join(fixtureADir, 'incoming', 'remove', 'c.md'), 'remove c\n');
    expect((await fixtureA.syncOnce()).status).toBe('Synced');
    const targetMain = (await fixtureA.readState()).local_main!;

    const tokenFile = JSON.parse(await readFile(join(fixtureBDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as { device_token: string };
    const internals = fixtureB as unknown as {
      transport: {
        pull(input: { vaultId: string; deviceId: string; deviceToken: string; currentLocalMain: string | null }): Promise<{ packfile: Buffer }>;
      };
      git: { importPack(packfile: Buffer): Promise<void> };
    };
    const pulled = await internals.transport.pull({
      vaultId: admin.vaultId,
      deviceId: priorFixtureBState.device_id!,
      deviceToken: tokenFile.device_token,
      currentLocalMain: priorFixtureBState.local_main
    });
    await internals.git.importPack(pulled.packfile);

    await mkdirp(join(fixtureBDir, 'incoming', 'keep'));
    await writeFile(join(fixtureBDir, 'incoming', 'keep', 'a.md'), 'keep a\n');
    await writeFile(join(fixtureBDir, '.obts', 'apply-journal.json'), `${JSON.stringify({
      apply_id: 'apply_delete_after_files_written',
      operation_type: 'pull_apply',
      target_main: targetMain,
      expected_prior_local_main: priorFixtureBState.local_main,
      expected_prior_local_device_ref: priorFixtureBState.server_device_ref,
      phase: 'blocked_recovery',
      affected_paths: ['incoming/keep/a.md', 'incoming/remove/b.md', 'incoming/remove/c.md'],
      preflight_sha256: {
        'incoming/keep/a.md': null,
        'incoming/remove/b.md': null,
        'incoming/remove/c.md': null
      },
      recovery_bundle_id: 'rec_delete_after_files_written',
      last_completed_step: 'files_written',
      redacted_error_category: 'local_changed_during_apply'
    }, null, 2)}\n`);
    await writeFile(join(fixtureBDir, '.obts', 'state.json'), `${JSON.stringify({
      ...priorFixtureBState,
      status_label: 'Unsafe local state',
      last_error_code: 'unsafe_local_state',
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    const restartedFixtureB = new ObtsPluginClient(fixtureBDir, { serverUrl: baseUrl, deviceName: 'fixtureB-blocked-delete' });
    await restartedFixtureB.initialize();
    expect(await restartedFixtureB.readQueue()).toMatchObject({ status: 'queued_local' });
    expect((await restartedFixtureB.readState()).status_label).toBe('Ahead');

    expect((await restartedFixtureB.syncOnce()).status).toBe('Synced');
    const main = (await restartedFixtureB.readState()).local_main!;
    const serverPaths = await server.git.listTreePaths(admin.vaultId, main);
    expect(serverPaths).toContain('incoming/keep/a.md');
    expect(serverPaths).not.toContain('incoming/remove/b.md');
    expect(serverPaths).not.toContain('incoming/remove/c.md');
  });

  it('surfaces Uploading while a queued local commit is being pushed', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'upload-status-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    await writeFile(join(deviceDir, 'queued.md'), 'queued upload\n');

    let observedUploading = false;
    const internals = plugin as unknown as {
      transport: {
        putPushChunk: (...args: unknown[]) => Promise<unknown>;
      };
    };
    internals.transport.putPushChunk = async () => {
      observedUploading = true;
      expect(await plugin.readState()).toMatchObject({
        status_label: 'Uploading',
        last_error_code: null
      });
      throw new Error('stop upload after status observation');
    };

    await expect(plugin.syncOnce()).rejects.toThrow('stop upload after status observation');
    expect(observedUploading).toBe(true);
    expect(await plugin.readQueue()).toMatchObject({
      status: 'queued_local',
      attempts: 1
    });
    expect(await plugin.readState()).toMatchObject({
      status_label: 'Ahead',
      last_error_code: 'upload_interrupted'
    });
  });

  it('surfaces Applying while pulled server main is being materialized locally', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'apply-status-device-1');
    const device2Dir = join(root, 'apply-status-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    const plugin1 = await pairPlugin(admin, device1Dir, 'laptop');
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');

    await writeFile(join(device1Dir, 'server.md'), 'server change\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    let observedApplying = false;
    const internals = (plugin2 as unknown as { client: Record<string, (...args: unknown[]) => Promise<unknown>> }).client;
    const stageRecoveryBundleFiles = internals.stageRecoveryBundleFiles!.bind(internals);
    internals.stageRecoveryBundleFiles = async (...args: unknown[]) => {
      observedApplying = true;
      expect(await plugin2.readState()).toMatchObject({
        status_label: 'Applying',
        last_error_code: null
      });
      return await stageRecoveryBundleFiles(...args);
    };

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    expect(observedApplying).toBe(true);
    expect(await readFile(join(device2Dir, 'server.md'), 'utf8')).toBe('server change\n');
  });

  it('keeps the installable Obsidian artifact on Obsidian APIs for visible-vault apply', async () => {
    const artifact = await readFile(join(process.cwd(), 'obsidian-plugin', 'main.js'), 'utf8');
    const applyWriter = sourceSection(artifact, 'async writeTargetFilesFromJournal', 'async createLocalCommit');
    expect(applyWriter).toContain('this.adapterRemove');
    expect(applyWriter).toContain('this.adapterWriteBinary');
    expect(applyWriter).toContain('this.removeBlockingMaterializationPaths');
    expect(applyWriter).not.toContain('fsp.rm');
    expect(applyWriter).not.toContain('path.join(this.vaultDir');

    const scanner = sourceSection(artifact, 'async scanSyncableFiles', 'async localContentMatchesTree');
    expect(scanner).toContain('this.listLocalVaultFiles()');
    expect(scanner).not.toContain('walk(');
    expect(scanner).not.toContain('path.relative');

    const adapterWrite = sourceSection(artifact, 'async adapterWriteBinary', 'async adapterRemove');
    expect(adapterWrite).toContain('vault.modifyBinary');
    expect(adapterWrite).toContain('vault.createBinary');
    expect(adapterWrite).toContain('this.adapter.writeBinary');

    const adapterRemove = sourceSection(artifact, 'async adapterRemove', 'async adapterSha256');
    expect(adapterRemove).not.toContain('fsp.rm');
    expect(adapterRemove).toContain('vault.delete');
    expect(adapterRemove).toContain('this.adapter.rmdir');
    expect(adapterRemove).toContain('this.adapter.remove');
  });

  it('stores new dashboard passwords with the PRD Argon2id parameters', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const db = await server.store.snapshot();
    const user = db.users.find((candidate) => candidate.username === 'admin');
    expect(user?.password_hash).toMatchObject({
      algorithm: 'argon2id',
      memory_cost: 19456,
      time_cost: 2,
      parallelism: 1
    });
    expect(user?.password_hash.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(user?.password_hash.hash).not.toContain('admin-password-1234');

    const login = await admin.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'admin',
      password: 'admin-password-1234'
    }, false);
    expect(login.status).toBe(200);
    const session = await admin.get<{ user_id: string; csrf_token: string }>('/api/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.csrf_token).toBe(login.body.csrf_token);
  });

  it('rate-limits repeated failed dashboard logins by account and source IP', async () => {
    await setupAdminAndVault(baseUrl);

    for (let index = 0; index < 5; index += 1) {
      await expect(
        server.auth.login({
          username: 'admin',
          password: 'wrong-password-1234',
          sourceIp: '203.0.113.10'
        })
      ).rejects.toMatchObject({ statusCode: 401, code: 'invalid_credentials' });
    }

    await expect(
      server.auth.login({
        username: 'admin',
        password: 'wrong-password-1234',
        sourceIp: '203.0.113.10'
      })
    ).rejects.toMatchObject({ statusCode: 429, code: 'auth_rate_limited' });

    await expect(
      server.auth.login({
        username: 'admin',
        password: 'wrong-password-1234',
        sourceIp: '203.0.113.11'
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'invalid_credentials' });

    const db = await server.store.snapshot();
    expect(db.login_attempts.find((attempt) => attempt.source_ip === '203.0.113.10')).toMatchObject({
      username: 'admin',
      failed_count: 5,
      locked_until: expect.any(String)
    });
    expect(db.audit_log.filter((audit) => audit.action === 'login_failed')).toHaveLength(6);
  });

  it('sets a browser-usable dashboard session cookie for HTTP deployments', async () => {
    const response = await fetch(`${baseUrl}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'admin-password-1234'
      })
    });
    expect(response.status).toBe(201);
    const setCookie = firstSetCookie(response);
    expect(setCookie).toMatch(/^obts_session=/u);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toMatch(/^__Host-/u);

    const cookie = setCookie.split(';')[0]!;
    const session = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: { cookie }
    });
    expect(session.status).toBe(200);
  });

  it('uses a secure __Host dashboard session cookie for HTTPS deployments', async () => {
    const httpsServer = await createObtsServer({
      dataDir: join(root, 'https-server-data'),
      publicBaseUrl: 'https://obts.example.test',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    try {
      const httpsBaseUrl = await httpsServer.app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${httpsBaseUrl}/api/v1/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'admin-password-1234'
        })
      });
      expect(response.status).toBe(201);
      const setCookie = firstSetCookie(response);
      expect(setCookie).toMatch(/^__Host-obts_session=/u);
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
    } finally {
      await httpsServer.app.close();
    }
  });

  it('never derives Synced from an expired local convergence report', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'stale-status-device');
    await mkdirp(deviceDir);
    await pairPlugin(admin, deviceDir, 'stale-laptop');
    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_name === 'stale-laptop');
      expect(device).toBeDefined();
      device!.status = 'synced';
      device!.last_status_report_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    });

    const dashboard = await admin.get<{ devices: Array<{ device_name: string; status_label: string; status_report_fresh: boolean }> }>(
      `/api/v1/vaults/${admin.vaultId}/dashboard`
    );
    expect(dashboard.body.devices.find((device) => device.device_name === 'stale-laptop')).toMatchObject({
      status_label: 'Status unknown',
      status_report_fresh: false
    });
  });

  it('treats the terminal merged queue state as converged during rolling upgrades', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'merged-status-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'merged-laptop');
    const state = await plugin.readState();

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_name === 'merged-laptop');
      expect(device).toBeDefined();
      device!.status = 'synced';
      device!.last_applied_main = state.local_main;
      device!.local_status_label = 'Synced';
      device!.local_queue_status = 'merged';
      device!.local_main = state.local_main;
      device!.local_head = state.local_main;
      device!.last_status_report_at = new Date().toISOString();
    });

    const dashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; status_report_fresh: boolean; local_queue_status: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.body.devices.find((device) => device.device_name === 'merged-laptop')).toMatchObject({
      status_label: 'Synced',
      status_report_fresh: true,
      local_queue_status: 'merged'
    });
  });

  it('does not report an uncommitted watcher marker as Ahead', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'uncommitted-watcher-status-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'watcher-laptop');
    const state = await plugin.readState();

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_name === 'watcher-laptop');
      expect(device).toBeDefined();
      device!.status = 'synced';
      device!.last_applied_main = state.local_main;
      device!.local_status_label = 'Synced';
      device!.local_queue_status = 'queued_local';
      device!.local_main = state.local_main;
      device!.local_head = state.local_main;
      device!.last_status_report_at = new Date().toISOString();
    });

    const dashboard = await admin.get<{ devices: Array<{ device_name: string; status_label: string }> }>(
      `/api/v1/vaults/${admin.vaultId}/dashboard`
    );
    expect(dashboard.body.devices.find((device) => device.device_name === 'watcher-laptop')).toMatchObject({
      status_label: 'Status unknown'
    });
  });

  it('reports devices behind current main in the dashboard summary', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'dashboard-device-1');
    const device2Dir = join(root, 'dashboard-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'shared.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await sleep(5);

    await writeFile(join(device1Dir, 'shared.md'), 'server advanced\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const dashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; behind_main: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Behind',
      behind_main: true
    });

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    const afterApply = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; behind_main: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(afterApply.status).toBe(200);
    expect(afterApply.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Synced',
      behind_main: false
    });
  });

  it('uses acknowledged main commits, not timestamps, for dashboard behind state', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'cursor-device-1');
    const device2Dir = join(root, 'cursor-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'shared.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    const oldAppliedMain = (await plugin2.readState()).local_main;
    expect(oldAppliedMain).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(device1Dir, 'shared.md'), 'advanced\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    const newMain = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    expect(newMain).toMatch(/^[0-9a-f]{40}$/u);
    expect(newMain).not.toBe(oldAppliedMain);

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_name === 'phone');
      expect(device).toBeDefined();
      device!.last_successful_sync_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    });

    const dashboard = await admin.get<{
      devices: Array<{
        device_name: string;
        status_label: string;
        behind_main: boolean;
        last_applied_main: string | null;
        last_successful_sync_at: string | null;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Behind',
      behind_main: true,
      last_applied_main: oldAppliedMain,
      last_successful_sync_at: expect.any(String)
    });

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    const afterApply = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; behind_main: boolean; last_applied_main: string | null }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(afterApply.status).toBe(200);
    expect(afterApply.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Synced',
      behind_main: false,
      last_applied_main: newMain
    });
  });

  it('surfaces persistent-state readiness failures in the dashboard summary', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      if (!vault) {
        throw new Error('test vault not found');
      }
      vault.current_main = '0000000000000000000000000000000000000000';
    });

    const dashboard = await admin.get<{
      health: {
        status: string;
        checks: { persistent_state: boolean };
        detail: string | null;
      };
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.health).toMatchObject({
      status: 'not_ready',
      checks: {
        persistent_state: false
      },
      detail: 'vault main ref is inconsistent with metadata'
    });
  });

  it('keeps an uploading device behind until it acknowledges applying the merge commit', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'merge-ack-device-1');
    const device2Dir = join(root, 'merge-ack-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'base.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    const device2State = await plugin2.readState();
    const device2Token = await readDeviceToken(device2Dir);

    await sleep(5);
    await writeFile(join(device1Dir, 'desktop.md'), 'server-side change\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    await writeFile(join(device2Dir, 'phone.md'), 'uploading device change\n');
    const localGit = new LocalGitEngine(device2Dir);
    const phoneCommit = await localGit.createLocalCommit('obts: phone change before applying latest main');
    expect(phoneCommit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await localGit.createPackForCommit(phoneCommit!);
    const transport = new TransportClient(baseUrl);
    const push = await transport.push({
      vaultId: admin.vaultId,
      deviceId: device2State.device_id!,
      deviceToken: device2Token,
      manifest: {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: device2State.device_id!,
        expected_device_ref: device2State.server_device_ref,
        target_commit: phoneCommit!,
        packfile_sha256: sha256(packfile),
        packfile_bytes: packfile.byteLength,
        client_known_main: device2State.local_main
      },
      packfile
    });
    expect(push.status).toBe('merged');

    const dashboard = await admin.get<{
      devices: Array<{
        device_name: string;
        status_label: string;
        behind_main: boolean;
        last_successful_sync_at: string | null;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Behind',
      behind_main: true,
      last_successful_sync_at: expect.any(String)
    });
  });

  it('marks an active device synced only after an explicit durable-apply acknowledgement', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'pull-ack-ahead-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);
    expect(state.local_main).toMatch(/^[0-9a-f]{40}$/u);

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
      expect(device).toBeDefined();
      device!.status = 'ahead';
      device!.last_successful_sync_at = null;
    });

    const transport = new TransportClient(baseUrl);
    const pulled = await transport.pull({
      vaultId: admin.vaultId,
      deviceId: state.device_id!,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    expect(pulled.manifest.target_main).toBe(state.local_main);
    expect((await server.store.snapshot()).devices.find((device) => device.device_id === state.device_id)?.status).toBe('ahead');
    const acknowledgement = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/applied`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ applied_main: state.local_main })
    });
    expect(acknowledgement.status).toBe(200);

    const dashboard = await admin.get<{
      devices: Array<{
        device_name: string;
        status_label: string;
        behind_main: boolean;
        last_successful_sync_at: string | null;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'laptop')).toMatchObject({
      status_label: 'Synced',
      behind_main: false,
      last_successful_sync_at: expect.any(String)
    });

    await writeFile(join(deviceDir, 'newer.md'), 'newer\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const newerMain = (await plugin.readState()).local_main!;
    expect(newerMain).not.toBe(state.local_main);
    const staleAck = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/applied`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ applied_main: state.local_main })
    });
    expect(staleAck.status).toBe(409);
    expect((await staleAck.json() as { error: { code: string } }).error.code).toBe('stale_applied_main');

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
      if (device) device.status = 'blocked_recovery';
    });
    const blockedAck = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/applied`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ applied_main: newerMain })
    });
    expect(blockedAck.status).toBe(409);
    expect((await blockedAck.json() as { error: { code: string } }).error.code).toBe('device_blocked');
  });

  it('requires recent dashboard authentication for admin account creation', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    await server.store.mutate((db) => {
      for (const session of db.sessions) {
        session.recent_auth_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      }
    });

    const stale = await admin.post<{ error: { code: string } }>('/api/v1/admin/users', {
      username: 'stale-admin-action',
      password: 'other-password-1234'
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('recent_auth_required');

    const login = await admin.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'admin',
      password: 'admin-password-1234'
    }, false);
    expect(login.status).toBe(200);
    const fresh = await admin.post<{ user_id: string }>('/api/v1/admin/users', {
      username: 'fresh-admin-action',
      password: 'other-password-1234'
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.user_id).toMatch(/^usr_/u);
  });

  it('supports Phase 1 admin user lifecycle without leaking vault metadata', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const user = await admin.post<{
      user_id: string;
      username: string;
      owned_vault_count?: number;
      vaults?: unknown;
    }>('/api/v1/admin/users', {
      username: 'member',
      password: 'member-password-1234',
      display_name: 'Member'
    });
    expect(user.status).toBe(201);
    expect(user.body.username).toBe('member');
    expect(user.body.vaults).toBeUndefined();

    const list = await admin.get<{
      users: Array<{
        user_id: string;
        username: string;
        is_admin: boolean;
        disabled: boolean;
        owned_vault_count: number;
        vaults?: unknown;
      }>;
    }>('/api/v1/admin/users');
    expect(list.status).toBe(200);
    const member = list.body.users.find((candidate) => candidate.username === 'member');
    expect(member).toMatchObject({
      user_id: user.body.user_id,
      is_admin: false,
      disabled: false,
      owned_vault_count: 0
    });
    expect(member?.vaults).toBeUndefined();

    const granted = await admin.post<{ is_admin: boolean }>(`/api/v1/admin/users/${user.body.user_id}/grant-admin`, {});
    expect(granted.status).toBe(200);
    expect(granted.body.is_admin).toBe(true);

    const revoked = await admin.post<{ is_admin: boolean }>(`/api/v1/admin/users/${user.body.user_id}/revoke-admin`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.is_admin).toBe(false);

    const adminUserId = (await server.store.snapshot()).users.find((candidate) => candidate.username === 'admin')?.user_id;
    expect(adminUserId).toBeDefined();
    const finalAdminRevoke = await admin.post<{ error: { code: string } }>(
      `/api/v1/admin/users/${adminUserId}/revoke-admin`,
      {}
    );
    expect(finalAdminRevoke.status).toBe(409);
    expect(finalAdminRevoke.body.error.code).toBe('final_admin_required');
  });

  it('disabling a user immediately revokes dashboard sessions, pairing tokens, and device tokens', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const user = await admin.post<{ user_id: string }>('/api/v1/admin/users', {
      username: 'owner',
      password: 'owner-password-1234'
    });
    expect(user.status).toBe(201);

    const owner = new BrowserSession(baseUrl);
    const login = await owner.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'owner',
      password: 'owner-password-1234'
    }, false);
    expect(login.status).toBe(200);
    const ownerVault = await owner.post<{ vault_id: string }>('/api/v1/vaults', {
      display_name: 'Owner Vault'
    });
    expect(ownerVault.status).toBe(201);
    const deviceDir = join(root, 'disabled-user-device');
    await mkdirp(deviceDir);
    const plugin = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrl,
      deviceName: 'phone',
    });
    await onboardExistingVault(owner, plugin, ownerVault.body.vault_id);
    const state = await plugin.readState();
    const deviceToken = await readDeviceToken(deviceDir);

    const disable = await admin.post<{ disabled: boolean }>(`/api/v1/admin/users/${user.body.user_id}/disable`, {});
    expect(disable.status).toBe(200);
    expect(disable.body.disabled).toBe(true);

    const ownerSession = await owner.get<{ error: { code: string } }>('/api/v1/auth/session');
    expect(ownerSession.status).toBe(401);
    expect(ownerSession.body.error.code).toBe('unauthenticated');

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: ownerVault.body.vault_id,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const pull = await fetch(`${baseUrl}/api/v1/vaults/${ownerVault.body.vault_id}/sync/pull`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: form
    });
    expect(pull.status).toBe(404);

    const db = await server.store.snapshot();
    expect(db.tokens.filter((token) => token.user_id === user.body.user_id && token.revoked_at === null)).toEqual([]);
    expect(db.devices.find((device) => device.device_id === state.device_id)?.status).toBe('revoked');
  });

  it('renames vault and device display metadata with owner scoping, validation, audit, and plugin reconciliation', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const beforeVault = await admin.get<{ vaults: Array<{ vault_id: string; display_name: string; current_main: string }> }>('/api/v1/vaults');
    const originalMain = beforeVault.body.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;

    const missingCsrf = await admin.patch<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}`,
      { display_name: 'No CSRF' },
      false
    );
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe('csrf_required');

    const renamedVault = await admin.patch<{ vault_id: string; display_name: string; current_main: string }>(
      `/api/v1/vaults/${admin.vaultId}`,
      { display_name: '  Cafe\u0301 notes  ' }
    );
    expect(renamedVault.status).toBe(200);
    expect(renamedVault.body).toMatchObject({ vault_id: admin.vaultId, display_name: 'Café notes', current_main: originalMain });
    expect(await server.git.getRef(admin.vaultId, 'refs/heads/main')).toBe(originalMain);

    for (const displayName of ['', 'x'.repeat(81), 'bad\nname', 'zero\u200bwidth', 'spoof\u202ename']) {
      const invalid = await admin.patch<{ error: { code: string } }>(`/api/v1/vaults/${admin.vaultId}`, {
        display_name: displayName
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('invalid_display_name');
    }

    const deviceDir = join(root, 'rename-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'phone');
    const originalState = await plugin.readState();
    const ownerRename = await admin.patch<{ device_id: string; device_name: string }>(
      `/api/v1/vaults/${admin.vaultId}/devices/${originalState.device_id}`,
      { device_name: 'Desk phone' }
    );
    expect(ownerRename).toMatchObject({ status: 200, body: { device_id: originalState.device_id, device_name: 'Desk phone' } });

    await plugin.reportDeviceStatus();
    expect(await plugin.readState()).toMatchObject({ device_name: 'Desk phone' });
    expect(await plugin.renameCurrentDevice('  Travel phone  ')).toBe('Travel phone');
    expect(await plugin.readState()).toMatchObject({ device_name: 'Travel phone' });

    const token = await readDeviceToken(deviceDir);
    const self = await fetch(`${baseUrl}/api/v1/device/self`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(self.status).toBe(200);
    expect(await self.json()).toMatchObject({ device_id: originalState.device_id, device_name: 'Travel phone' });
    const invalidSelfRename = await fetch(`${baseUrl}/api/v1/device/self`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device_name: 'd'.repeat(81) })
    });
    expect(invalidSelfRename.status).toBe(400);
    expect(await invalidSelfRename.json()).toMatchObject({ error: { code: 'invalid_display_name' } });

    const db = await server.store.snapshot();
    expect(db.audit_log).toContainEqual(expect.objectContaining({
      action: 'vault_renamed',
      actor_user_id: expect.any(String),
      actor_device_id: null,
      vault_id: admin.vaultId,
      resource_id: admin.vaultId
    }));
    expect(db.audit_log.filter((row) => row.action === 'device_renamed')).toEqual([
      expect.objectContaining({ actor_device_id: null, resource_id: originalState.device_id }),
      expect.objectContaining({ actor_device_id: originalState.device_id, resource_id: originalState.device_id })
    ]);
    const reloaded = new MetadataStore(server.config.dataDir);
    await reloaded.initialize();
    const persisted = await reloaded.snapshot();
    expect(persisted.vaults.find((vault) => vault.vault_id === admin.vaultId)?.display_name).toBe('Café notes');
    expect(persisted.devices.find((device) => device.device_id === originalState.device_id)?.device_name).toBe('Travel phone');
  });

  it('normalizes legacy persisted vault and device names before serving the new contract', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'legacy-name-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'legacy-device');
    const state = await plugin.readState();
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId)!;
      const device = db.devices.find((candidate) => candidate.device_id === state.device_id)!;
      vault.display_name = `  ${'v'.repeat(90)}\u202e  `;
      device.device_name = '\u200b';
    });

    const reloaded = new MetadataStore(server.config.dataDir);
    await reloaded.initialize();
    const migrated = await reloaded.snapshot();
    expect(migrated.vaults.find((vault) => vault.vault_id === admin.vaultId)?.display_name).toBe('v'.repeat(80));
    expect(migrated.devices.find((device) => device.device_id === state.device_id)?.device_name).toBe('Unnamed device');
  });

  it('revokes individual devices and supports one-time password reset tokens', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'revoked-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'phone');
    const state = await plugin.readState();
    const deviceToken = await readDeviceToken(deviceDir);

    const revoke = await admin.post<{ status: string }>(
      `/api/v1/vaults/${admin.vaultId}/devices/${state.device_id}/revoke`,
      {}
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('ok');

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const pull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: form
    });
    expect(pull.status).toBe(404);

    const user = await admin.post<{ user_id: string }>('/api/v1/admin/users', {
      username: 'reset-user',
      password: 'reset-password-1234'
    });
    expect(user.status).toBe(201);
    const resetToken = await admin.post<{ reset_token: string; expires_at: string }>(
      `/api/v1/admin/users/${user.body.user_id}/password-reset-tokens`,
      {}
    );
    expect(resetToken.status).toBe(201);
    expect(resetToken.body.reset_token).toMatch(/^obts_reset_/u);

    const reset = await fetch(`${baseUrl}/api/v1/auth/password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reset_token: resetToken.body.reset_token,
        new_password: 'new-reset-password-1234'
      })
    });
    expect(reset.status).toBe(200);

    const secondReset = await fetch(`${baseUrl}/api/v1/auth/password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reset_token: resetToken.body.reset_token,
        new_password: 'second-reset-password-1234'
      })
    });
    expect(secondReset.status).toBe(401);

    const login = new BrowserSession(baseUrl);
    const oldPassword = await login.post<{ error: { code: string } }>('/api/v1/auth/login', {
      username: 'reset-user',
      password: 'reset-password-1234'
    }, false);
    expect(oldPassword.status).toBe(401);
    const newPassword = await login.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'reset-user',
      password: 'new-reset-password-1234'
    }, false);
    expect(newPassword.status).toBe(200);
  });

  it('lets a paired plugin unpair itself and revoke its device token', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'self-unpair-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'phone');
    const state = await plugin.readState();
    const deviceToken = await readDeviceToken(deviceDir);

    const unpaired = await plugin.unpairCurrentDevice();
    expect(unpaired.status).toBe('Not paired');
    await expect(readDeviceToken(deviceDir)).rejects.toThrow();
    await expect(plugin.syncOnce()).rejects.toMatchObject({ code: 'not_paired' });
    expect(await plugin.readState()).toMatchObject({
      vault_id: null,
      device_id: null,
      status_label: 'Not paired',
      last_error_code: null
    });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const pull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: form
    });
    expect(pull.status).toBe(404);

    const dashboard = await admin.get<{ devices: Array<{ device_name: string; status_label: string }> }>(
      `/api/v1/vaults/${admin.vaultId}/dashboard`
    );
    expect(dashboard.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Blocked'
    });

    await mkdirp(join(deviceDir, '.obts', 'recovery', 'rec_retained_after_unpair'));
    await writeFile(join(deviceDir, '.obts', 'recovery', 'rec_retained_after_unpair', 'manifest.json'), '{}\n');
    await writeFile(
      join(deviceDir, '.obts', 'state.json'),
      `${JSON.stringify(
        {
          ...(await plugin.readState()),
          status_label: 'Unsafe local state',
          last_error_code: 'partial_local_state'
        },
        null,
        2
      )}\n`
    );
    await onboardExistingVault(admin, plugin, admin.vaultId);
    const rePairedState = await plugin.readState();
    expect(rePairedState.vault_id).toBe(admin.vaultId);
    expect(rePairedState.device_id).toMatch(/^dev_/u);
    expect(rePairedState.device_id).not.toBe(state.device_id);
  });

  it('fast-forwards a clean re-pair from a detached unpaired baseline', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'clean-repair-desktop');
    await mkdirp(desktopDir);
    await writeFile(join(desktopDir, 'shared.md'), 'old server state\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    const oldDesktopState = await desktop.readState();
    expect(oldDesktopState.local_main).toMatch(/^[0-9a-f]{40}$/u);
    await writeFile(
      join(desktopDir, '.obts', 'state.json'),
      `${JSON.stringify({ ...oldDesktopState, local_main: null }, null, 2)}\n`
    );

    await desktop.unpairCurrentDevice();
    const unpairedState = await desktop.readState();
    expect(unpairedState.unpaired_baseline_vault_id).toBe(admin.vaultId);
    expect(unpairedState.unpaired_baseline_main).toBe(oldDesktopState.local_main);

    const laptopDir = join(root, 'clean-repair-laptop');
    await mkdirp(laptopDir);
    const laptop = await pairPlugin(admin, laptopDir, 'laptop');
    expect(await readFile(join(laptopDir, 'shared.md'), 'utf8')).toBe('old server state\n');
    await writeFile(join(laptopDir, 'shared.md'), 'new server state\n');
    expect((await laptop.syncOnce()).status).toBe('Synced');
    const newLaptopState = await laptop.readState();
    expect(newLaptopState.local_main).toMatch(/^[0-9a-f]{40}$/u);
    expect(newLaptopState.local_main).not.toBe(oldDesktopState.local_main);

    await onboardExistingVault(admin, desktop, admin.vaultId);

    expect(await readFile(join(desktopDir, 'shared.md'), 'utf8')).toBe('new server state\n');
    const repairedState = await desktop.readState();
    expect(repairedState.local_main).toBe(newLaptopState.local_main);
    expect(repairedState.initial_import_confirmed).toBe(true);
    expect(repairedState.last_error_code).toBeNull();
  });

  it('uploads changed re-pair content as a proposal from the detached baseline', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'dirty-repair-desktop');
    await mkdirp(desktopDir);
    await writeFile(join(desktopDir, 'shared.md'), 'old server state\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');

    await desktop.unpairCurrentDevice();
    await writeFile(join(desktopDir, 'shared.md'), 'local unpaired edit\n');

    const laptopDir = join(root, 'dirty-repair-laptop');
    await mkdirp(laptopDir);
    const laptop = await pairPlugin(admin, laptopDir, 'laptop');
    await writeFile(join(laptopDir, 'shared.md'), 'new server state\n');
    expect((await laptop.syncOnce()).status).toBe('Synced');

    const result = await onboardExistingVault(admin, desktop, admin.vaultId, 'merge');
    expect(await readFile(join(desktopDir, 'shared.md'), 'utf8')).toBe('local unpaired edit\n');
    expect(result.status).toBe('Review needed');
    expect(result.conflictId).toMatch(/^conf_/u);
    expect((await desktop.readState()).last_error_code).toBe('conflict_review_required');
  });

  it('uses multipart pull requests and rejects legacy JSON pull bodies', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'multipart-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);

    const jsonPull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      })
    });
    expect(jsonPull.status).toBe(400);
    expect(((await jsonPull.json()) as { error: { code: string } }).error.code).toBe('invalid_content_type');

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const multipartPull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`
      },
      body: form
    });
    expect(multipartPull.status).toBe(200);
    expect(multipartPull.headers.get('content-type')).toContain('multipart/form-data');

    const mobilePullBody = mobileMultipartBody(
      {
        api_version: API_VERSION,
        plugin_version: '0.4.1',
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: state.local_main,
        requested_target: 'latest'
      },
      Buffer.alloc(0),
      'have.pack'
    );
    const mobileMultipartPull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': mobilePullBody.contentType
      },
      body: Uint8Array.from(mobilePullBody.body)
    });
    expect(mobileMultipartPull.status).toBe(200);
    expect(mobileMultipartPull.headers.get('content-type')).toContain('multipart/form-data');

    const invalidMobilePullBody = mobileMultipartBody('{', Buffer.alloc(0), 'have.pack');
    const invalidMobilePull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': invalidMobilePullBody.contentType
      },
      body: Uint8Array.from(invalidMobilePullBody.body)
    });
    expect(invalidMobilePull.status).toBe(400);
    expect(((await invalidMobilePull.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
  });

  it('rejects malformed commit identifiers in multipart sync manifests', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'invalid-manifest-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);
    const emptyPack = Buffer.alloc(0);

    const pushBody = mobileMultipartBody(
      {
        api_version: API_VERSION,
        plugin_version: '0.4.1',
        vault_id: admin.vaultId,
        device_id: state.device_id,
        expected_device_ref: state.server_device_ref,
        target_commit: 'refs/heads/main',
        packfile_sha256: sha256(emptyPack),
        packfile_bytes: emptyPack.byteLength,
        client_known_main: state.local_main
      },
      emptyPack,
      'pack.pack'
    );
    const push = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': pushBody.contentType
      },
      body: Uint8Array.from(pushBody.body)
    });
    expect(push.status).toBe(400);
    expect(((await push.json()) as { error: { code: string } }).error.code).toBe('invalid_request');

    const pullForm = new FormData();
    pullForm.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        current_local_main: 'HEAD',
        requested_target: 'latest'
      })
    );
    pullForm.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const pull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`
      },
      body: pullForm
    });
    expect(pull.status).toBe(400);
    expect(((await pull.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('rejects multipart sync manifests missing required nullable commit cursors', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'missing-cursor-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);
    const emptyPack = Buffer.alloc(0);

    const pushForm = new FormData();
    pushForm.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        target_commit: state.local_main,
        packfile_sha256: sha256(emptyPack),
        packfile_bytes: emptyPack.byteLength,
        client_known_main: state.local_main
      })
    );
    pushForm.append('packfile', new Blob([emptyPack], { type: 'application/x-git-packed-objects' }), 'pack.pack');
    const push = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`
      },
      body: pushForm
    });
    expect(push.status).toBe(400);
    expect(((await push.json()) as { error: { code: string; details: { field?: string } } }).error).toMatchObject({
      code: 'invalid_request',
      details: { field: 'expected_device_ref' }
    });

    const pullForm = new FormData();
    pullForm.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id,
        requested_target: 'latest'
      })
    );
    pullForm.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const pull = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`
      },
      body: pullForm
    });
    expect(pull.status).toBe(400);
    expect(((await pull.json()) as { error: { code: string; details: { field?: string } } }).error).toMatchObject({
      code: 'invalid_request',
      details: { field: 'current_local_main' }
    });

    const db = await server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.device_ref_head).toBeNull();
    expect(db.sync_operations).toEqual([]);
  });

  it('scopes browser connection authorization and removes legacy pairing endpoints', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'connection-auth-device');
    await mkdirp(deviceDir);
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'phone' });
    const connection = await plugin.startOnboarding('Connection Auth Vault');

    const invalidStatus = await fetch(`${baseUrl}/api/v1/connections/${connection.connection_id}`, {
      headers: { authorization: 'Bearer obts_conn_invalid' }
    });
    expect(invalidStatus.status).toBe(401);

    const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    });
    expect(approval.status).toBe(200);
    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await plugin.finishOnboarding({
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'use_server'
    });
    expect((await plugin.pollOnboarding(connection.connection_id, connection.connection_secret)).status).toBe('consumed');

    expect((await fetch(`${baseUrl}/api/v1/pair/consume`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/pairing-tokens`, { method: 'POST' })).status).toBe(404);
    expect((await server.store.snapshot()).tokens.every((token) => token.kind !== ('pairing' as never))).toBe(true);
  });

  it('expires bootstrap access and revokes approved connections when their owner is disabled', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const user = await admin.post<{ user_id: string }>('/api/v1/admin/users', {
      username: 'connection-owner',
      password: 'connection-owner-password'
    });
    const owner = new BrowserSession(baseUrl);
    expect((await owner.post('/api/v1/auth/login', {
      username: 'connection-owner',
      password: 'connection-owner-password'
    }, false)).status).toBe(200);
    const vault = await owner.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Owner connection vault' });

    const firstDir = join(root, 'expiring-bootstrap');
    await mkdirp(firstDir);
    const first = new ObtsPluginClient(firstDir, { serverUrl: baseUrl, deviceName: 'expiring' });
    const expiring = await first.startOnboarding('Expiring');
    expect((await owner.post(`/api/v1/connections/${expiring.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: vault.body.vault_id
    })).status).toBe(200);
    await server.store.mutate((db) => {
      const row = db.connections.find((candidate) => candidate.connection_id === expiring.connection_id)!;
      row.expires_at = new Date(Date.now() - 1_000).toISOString();
    });
    const bootstrap = await fetch(`${baseUrl}/api/v1/connections/${expiring.connection_id}/bootstrap`, {
      method: 'POST',
      headers: { authorization: `Bearer ${expiring.connection_secret}` }
    });
    expect(bootstrap.status).toBe(409);
    expect((await server.store.snapshot()).connections.find((row) => row.connection_id === expiring.connection_id)?.status).toBe('expired');
    const expiredCompletion = await fetch(`${baseUrl}/api/v1/connections/${expiring.connection_id}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${expiring.connection_secret}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ mode: 'use_server', expected_main: null })
    });
    expect(expiredCompletion.status).toBe(409);

    const secondDir = join(root, 'disabled-approved-connection');
    await mkdirp(secondDir);
    const second = new ObtsPluginClient(secondDir, { serverUrl: baseUrl, deviceName: 'disabled' });
    const approved = await second.startOnboarding('Disabled owner');
    expect((await owner.post(`/api/v1/connections/${approved.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: vault.body.vault_id
    })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/users/${user.body.user_id}/disable`, {})).status).toBe(200);
    expect((await second.pollOnboarding(approved.connection_id, approved.connection_secret)).status).toBe('denied');
    expect((await server.store.snapshot()).audit_log.some((row) => row.action === 'connection_revoked_user_disabled')).toBe(true);
  });

  it('bounds unauthenticated connection creation and authenticated status polling', async () => {
    const payload = {
      plugin_version: '0.2.0',
      device_name: 'rate-limited',
      local_vault_name: 'Rate limited',
      local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    };
    const created: Array<{ connection_id: string; connection_secret: string }> = [];
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${baseUrl}/api/v1/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      expect(response.status).toBe(201);
      created.push((await response.json()) as { connection_id: string; connection_secret: string });
    }
    expect((await fetch(`${baseUrl}/api/v1/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })).status).toBe(429);

    const connection = created[0]!;
    for (let index = 0; index < 10; index += 1) {
      expect((await fetch(`${baseUrl}/api/v1/connections/${connection.connection_id}`, {
        headers: { authorization: `Bearer ${connection.connection_secret}` }
      })).status).toBe(200);
    }
    expect((await fetch(`${baseUrl}/api/v1/connections/${connection.connection_id}`, {
      headers: { authorization: `Bearer ${connection.connection_secret}` }
    })).status).toBe(429);
  });

  it('persists owner-only onboarding state across restart and fingerprints explicit directories', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'durable-onboarding');
    await mkdirp(deviceDir);
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'restart-safe' });
    const connection = await plugin.startOnboarding('Durable onboarding');
    const journalPath = join(deviceDir, '.obts', 'onboarding.json');
    const secretPath = join(deviceDir, '.obts', 'auth', 'pending-connection.json');
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(journalPath, 'utf8')).not.toContain(connection.connection_secret);

    const restarted = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'restart-safe' });
    const pending = await restarted.readPendingOnboarding();
    expect(pending).toMatchObject({
      secret: connection.connection_secret,
      journal: { stage: 'awaiting_browser', connection: { connection_id: connection.connection_id } }
    });
    await expect(restarted.syncOnce()).rejects.toMatchObject({ code: 'onboarding_incomplete' });

    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'new_vault',
      display_name: 'Durable vault'
    })).status).toBe(200);
    const analysis = await restarted.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    expect((await restarted.readPendingOnboarding())?.journal.stage).toBe('awaiting_confirmation');
    await mkdirp(join(deviceDir, 'explicit-empty-directory'));
    await expect(restarted.finishOnboarding({
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'initialize'
    })).rejects.toMatchObject({ code: 'onboarding_snapshot_changed' });
    expect((await restarted.readPendingOnboarding())?.journal).toMatchObject({
      stage: 'blocked',
      last_error_code: 'onboarding_snapshot_changed'
    });
    await restarted.cancelOnboarding();
    expect(await restarted.readPendingOnboarding()).toBeNull();
    await expect(stat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(secretPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a lost connection-completion response without creating another device', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const phoneDir = join(root, 'lost-completion-phone');
    await mkdirp(phoneDir);
    const phone = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    const connection = await phone.startOnboarding('Lost completion phone');
    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    })).status).toBe(200);
    const analysis = await phone.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    const transport = (phone as unknown as {
      transport: { completeConnection: (...args: any[]) => Promise<any> };
    }).transport;
    const completeConnection = transport.completeConnection.bind(transport);
    transport.completeConnection = async (...args: any[]) => {
      await completeConnection(...args);
      throw new Error('simulated lost completion response');
    };
    const submit = {
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'use_server' as const
    };
    await expect(phone.finishOnboarding(submit)).rejects.toThrow('simulated lost completion response');
    expect((await phone.readState()).device_id).toBeNull();
    const devicesAfterLostResponse = (await server.store.snapshot()).devices.length;
    expect(devicesAfterLostResponse).toBe(1);

    const restarted = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    await expect(restarted.finishOnboarding(submit)).resolves.toMatchObject({ status: 'Synced' });
    expect((await server.store.snapshot()).devices).toHaveLength(devicesAfterLostResponse);
    expect(await restarted.readPendingOnboarding()).toBeNull();
  });

  it('resumes use-server onboarding after device registration without creating another device', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'registered-resume-desktop');
    const phoneDir = join(root, 'registered-resume-phone');
    await mkdirp(desktopDir);
    await mkdirp(phoneDir);
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'server.md'), 'server state\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const phone = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    const connection = await phone.startOnboarding('Interrupted phone');
    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    })).status).toBe(200);
    const analysis = await phone.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    const transport = (phone as unknown as { transport: { pullChunk: (...args: unknown[]) => Promise<unknown> } }).transport;
    const originalPull = transport.pullChunk.bind(transport);
    transport.pullChunk = async () => {
      throw new Error('simulated interruption after registration');
    };
    const submit = {
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'use_server' as const
    };
    await expect(phone.finishOnboarding(submit)).rejects.toThrow('simulated interruption');
    const interruptedState = await phone.readState();
    expect(interruptedState).toMatchObject({ vault_id: admin.vaultId, status_label: 'Checking' });
    expect((await phone.readPendingOnboarding())?.journal.stage).toBe('blocked');
    transport.pullChunk = originalPull;

    const devicesBeforeResume = (await server.store.snapshot()).devices.length;
    const restarted = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    await expect(restarted.finishOnboarding(submit)).resolves.toMatchObject({ status: 'Synced' });
    expect(await readFile(join(phoneDir, 'server.md'), 'utf8')).toBe('server state\n');
    expect(await restarted.readPendingOnboarding()).toBeNull();
    expect((await server.store.snapshot()).devices).toHaveLength(devicesBeforeResume);
  });

  it('does not complete new-vault onboarding before the local proposal is accepted', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const phoneDir = join(root, 'proposal-crash-phone');
    await mkdirp(phoneDir);
    await writeFile(join(phoneDir, 'local.md'), 'local proposal\n');
    const phone = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    const connection = await phone.startOnboarding('Proposal crash phone');
    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'new_vault',
      display_name: 'Proposal crash vault'
    })).status).toBe(200);
    const analysis = await phone.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    const git = (phone as unknown as { git: { createLocalCommit(message: string): Promise<string | null> } }).git;
    const createLocalCommit = git.createLocalCommit.bind(git);
    git.createLocalCommit = async () => {
      throw new Error('simulated interruption before proposal commit');
    };
    const submit = {
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'initialize' as const
    };
    await expect(phone.finishOnboarding(submit)).rejects.toThrow('simulated interruption before proposal commit');
    const interruptedState = await phone.readState();
    const interruptedSelf = await fetch(`${baseUrl}/api/v1/device/self`, {
      headers: { authorization: `Bearer ${await readDeviceToken(phoneDir)}` }
    });
    expect(interruptedSelf.status).toBe(200);
    expect(((await interruptedSelf.json()) as { server_device_ref: string | null }).server_device_ref).toBeNull();
    expect(interruptedState.local_main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await phone.readPendingOnboarding()).not.toBeNull();
    git.createLocalCommit = createLocalCommit;

    const restarted = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    await expect(restarted.finishOnboarding(submit)).resolves.toMatchObject({ status: 'Synced' });
    const finalState = await restarted.readState();
    const vault = (await server.store.snapshot()).vaults.find((candidate) => candidate.vault_id === finalState.vault_id)!;
    expect(await server.git.listTreePaths(vault.vault_id, vault.current_main)).toContain('local.md');
    expect(await restarted.readPendingOnboarding()).toBeNull();
  });

  it('creates a new server vault from the browser-approved local onboarding snapshot', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'new-vault-onboarding-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'welcome.md'), '# Browser onboarding\n');
    const plugin = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'desktop' });
    const connection = await plugin.startOnboarding('Local Browser Vault');

    const review = await admin.get<{
      verification_code: string;
      local_vault_name: string;
      local_summary: { syncable_file_count: number };
    }>(`/api/v1/connections/${connection.connection_id}/review`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      verification_code: connection.verification_code,
      local_vault_name: 'Local Browser Vault',
      local_summary: { syncable_file_count: 1 }
    });
    const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'new_vault',
      display_name: 'Browser Created Vault'
    });
    expect(approval.status).toBe(200);

    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    expect(analysis.classification).toBe('new_with_content');
    const result = await plugin.finishOnboarding({
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'initialize'
    });
    expect(result.status).toBe('Synced');
    const state = await plugin.readState();
    const db = await server.store.snapshot();
    const created = db.vaults.find((vault) => vault.vault_id === state.vault_id);
    expect(created).toMatchObject({ display_name: 'Browser Created Vault', root_commit: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(await server.git.listTreePaths(created!.vault_id, created!.current_main)).toContain('welcome.md');
  });

  it('uses the empty root for independent-vault merge and conflicts on differing same-path additions', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const serverDir = join(root, 'independent-server-device');
    await mkdirp(serverDir);
    await writeFile(join(serverDir, 'server-only.md'), 'remote only\n');
    await writeFile(join(serverDir, 'same.md'), 'remote version\n');
    await pairPlugin(admin, serverDir, 'server-device');

    const localDir = join(root, 'independent-local-device');
    await mkdirp(localDir);
    await writeFile(join(localDir, 'local-only.md'), 'local only\n');
    await writeFile(join(localDir, 'same.md'), 'local version\n');
    const local = new ObtsPluginClient(localDir, { serverUrl: baseUrl, deviceName: 'local-device' });
    const connection = await local.startOnboarding('Independent Local Vault');
    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    })).status).toBe(200);
    const analysis = await local.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    expect(analysis).toMatchObject({
      classification: 'independent_divergent',
      proposalBase: (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)!.root_commit
    });
    const result = await local.finishOnboarding({
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'merge'
    });
    expect(result.status).toBe('Review needed');
    expect(await readFile(join(localDir, 'local-only.md'), 'utf8')).toBe('local only\n');
    const main = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main;
    expect(await server.git.listTreePaths(admin.vaultId, main)).toContain('server-only.md');
    const conflicts = (await server.store.snapshot()).conflicts.filter((conflict) => conflict.vault_id === admin.vaultId && conflict.status === 'open');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.affected_paths).toContain('same.md');
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
    await expect(awaitState(plugin2)).resolves.toMatchObject({
      status_label: 'Review needed',
      last_error_code: 'conflict_review_required'
    });

    const conflicts = await admin.get<{
      conflicts: Array<{
        affected_paths: string[];
        status: string;
        merge_sequence: number;
        merge_policy_version: string;
        base_commit: string;
        current_main: string;
        device_commit: string;
        validator_results: Record<string, unknown>;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts?status=open`);
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflicts).toHaveLength(1);
    const conflict = conflicts.body.conflicts[0]!;
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['shared.md'],
      merge_sequence: expect.any(Number),
      merge_policy_version: 'phase2.semantic-merge.v1',
      base_commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      current_main: expect.stringMatching(/^[0-9a-f]{40}$/u),
      device_commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      validator_results: {
        reason: 'overlapping_paths',
        affected_paths: ['shared.md'],
        affected_path_count: 1
      }
    });
    const db = await server.store.snapshot();
    const operation = db.sync_operations.find(
      (candidate) =>
        candidate.operation_type === 'conflict_create' &&
        candidate.result?.conflict_id === result.conflictId
    );
    expect(operation?.prepared_manifest).toMatchObject({
      merge_sequence: conflict.merge_sequence,
      merge_policy_version: 'phase2.semantic-merge.v1',
      base_commit: conflict.base_commit,
      current_main: conflict.current_main,
      device_commit: conflict.device_commit,
      decision: 'conflict',
      validator_results: {
        reason: 'overlapping_paths',
        affected_paths: ['shared.md'],
        affected_path_count: 1
      }
    });

    const device3Dir = join(root, 'conflict-device-3');
    await mkdirp(device3Dir);
    const plugin3 = await pairPlugin(admin, device3Dir, 'reader');
    expect(await readFile(join(device3Dir, 'shared.md'), 'utf8')).toBe('device one\n');

    await writeFile(join(device2Dir, 'after-conflict.md'), 'still blocked\n');
    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'conflict_review_required' });
  });

  it('detects delete+add rename candidates when Git does not emit rename records', async () => {
    const readBlob = async (): Promise<Buffer | null> => null;
    const baseBlobs = new Map([['Old.md', 'blob-old']]);
    const left = await __syncServiceTestInternals.summarizeStructuralChanges({
      baseCommit: 'base',
      targetCommit: 'left',
      changes: [
        { status: 'D', path: 'Old.md' },
        { status: 'A', path: 'Title A.md' }
      ],
      baseBlobs,
      targetBlobs: new Map([['Title A.md', 'blob-old']]),
      readBlob
    });
    const right = await __syncServiceTestInternals.summarizeStructuralChanges({
      baseCommit: 'base',
      targetCommit: 'right',
      changes: [
        { status: 'D', path: 'Old.md' },
        { status: 'A', path: 'Title B.md' }
      ],
      baseBlobs,
      targetBlobs: new Map([['Title B.md', 'blob-old']]),
      readBlob
    });

    expect(__syncServiceTestInternals.structuralMergeConflict(left, right)).toEqual({
      reason: 'rename_rename_conflict',
      affectedPaths: ['Old.md', 'Title A.md', 'Title B.md']
    });

    const similarBlobs = new Map([
      ['base:Old.md', Buffer.from('alpha beta gamma delta epsilon zeta eta theta iota kappa\n')],
      ['left:Title A.md', Buffer.from('alpha beta gamma delta epsilon zeta eta theta iota kappa left\n')],
      ['right:Title B.md', Buffer.from('alpha beta gamma delta epsilon zeta eta theta iota kappa right\n')]
    ]);
    const readSimilarBlob = async (commit: string, path: string): Promise<Buffer | null> =>
      similarBlobs.get(`${commit}:${path}`) ?? null;
    const similarLeft = await __syncServiceTestInternals.summarizeStructuralChanges({
      baseCommit: 'base',
      targetCommit: 'left',
      changes: [
        { status: 'D', path: 'Old.md' },
        { status: 'A', path: 'Title A.md' }
      ],
      baseBlobs,
      targetBlobs: new Map([['Title A.md', 'blob-left']]),
      readBlob: readSimilarBlob
    });
    const similarRight = await __syncServiceTestInternals.summarizeStructuralChanges({
      baseCommit: 'base',
      targetCommit: 'right',
      changes: [
        { status: 'D', path: 'Old.md' },
        { status: 'A', path: 'Title B.md' }
      ],
      baseBlobs,
      targetBlobs: new Map([['Title B.md', 'blob-right']]),
      readBlob: readSimilarBlob
    });
    expect(__syncServiceTestInternals.structuralMergeConflict(similarLeft, similarRight)).toEqual({
      reason: 'rename_rename_conflict',
      affectedPaths: ['Old.md', 'Title A.md', 'Title B.md']
    });
  });

  it('creates a conflict when concurrent renames move the same note to different paths', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { desktop, desktopDir, tablet, tabletDir } = await prepareStructuralMergeDevices(root, admin, 'rename-different');

    await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Title A.md'));
    await rename(join(tabletDir, 'Old.md'), join(tabletDir, 'Title B.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const mainBeforeConflict = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)
      ?.current_main;

    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(mainBeforeConflict);
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['Old.md', 'Title A.md', 'Title B.md'],
      validator_summary: {
        decision: 'conflict',
        reason: 'rename_rename_conflict',
        path_count: 3
      }
    });
    expect(await server.git.listTreePaths(admin.vaultId, mainBeforeConflict!)).toEqual([
      'Title A.md',
      'rename-different-tablet-ref.md'
    ]);
  });

  it('auto-merges concurrent renames to the same target path when content is otherwise safe', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { desktop, desktopDir, tablet, tabletDir } = await prepareStructuralMergeDevices(root, admin, 'rename-same');

    await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Unified.md'));
    await rename(join(tabletDir, 'Old.md'), join(tabletDir, 'Unified.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await tablet.syncOnce()).status).toBe('Synced');
    await desktop.syncOnce();

    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    const paths = await server.git.listTreePaths(admin.vaultId, db.vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main);
    expect(paths).toEqual(['Unified.md', 'rename-same-tablet-ref.md']);
    expect(await readFile(join(desktopDir, 'Unified.md'), 'utf8')).toBe('base\n');
    await expect(readFile(join(tabletDir, 'Old.md'), 'utf8')).rejects.toThrow();
  });

  it('auto-merges rename-vs-edit when the rename target does not collide with another path', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { desktop, desktopDir, tablet, tabletDir } = await prepareStructuralMergeDevices(root, admin, 'rename-edit');

    await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Renamed.md'));
    await writeFile(join(tabletDir, 'Old.md'), 'base\nedited on tablet\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await tablet.syncOnce()).status).toBe('Synced');
    await desktop.syncOnce();

    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    const main = db.vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main;
    expect(await server.git.listTreePaths(admin.vaultId, main)).toEqual(['Renamed.md', 'rename-edit-tablet-ref.md']);
    expect((await server.git.readBlobAtPath(admin.vaultId, main, 'Renamed.md')).toString('utf8')).toBe(
      'base\nedited on tablet\n'
    );
  });

  it('creates a conflict for rename-vs-delete of the same base path', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { desktop, desktopDir, tablet, tabletDir } = await prepareStructuralMergeDevices(root, admin, 'rename-delete');

    await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Renamed.md'));
    await rm(join(tabletDir, 'Old.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['Old.md', 'Renamed.md'],
      validator_summary: {
        decision: 'conflict',
        reason: 'rename_delete_conflict',
        path_count: 2
      }
    });
  });

  it('creates a conflict when rename-vs-edit also collides with the rename target path', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { desktop, desktopDir, tablet, tabletDir } = await prepareStructuralMergeDevices(root, admin, 'rename-collision');

    await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Renamed.md'));
    await writeFile(join(tabletDir, 'Old.md'), 'base\nedited on tablet\n');
    await writeFile(join(tabletDir, 'Renamed.md'), 'tablet-created collision\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['Old.md', 'Renamed.md'],
      validator_summary: {
        decision: 'conflict',
        reason: 'rename_path_collision',
        path_count: 2
      }
    });
  });

  it('blocks pull apply on a device with an open conflict instead of replacing local review content', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'conflict-pull-device-1');
    const device2Dir = join(root, 'conflict-pull-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await writeFile(join(device1Dir, 'shared.md'), 'base\n');
    await plugin1.syncOnce();

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    await writeFile(join(device1Dir, 'shared.md'), 'server version\n');
    await writeFile(join(device2Dir, 'shared.md'), 'device review version\n');
    await plugin1.syncOnce();
    expect((await plugin2.syncOnce()).status).toBe('Review needed');

    const conflictedState = await plugin2.readState();
    const conflictedToken = await readDeviceToken(device2Dir);
    const serverPull = new FormData();
    serverPull.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: conflictedState.device_id,
        current_local_main: conflictedState.local_main,
        requested_target: 'latest'
      })
    );
    serverPull.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const serverPullResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conflictedToken}`
      },
      body: serverPull
    });
    expect(serverPullResponse.status).toBe(409);
    expect(((await serverPullResponse.json()) as { error: { code: string } }).error.code).toBe('device_blocked');

    await expect(plugin2.pullAndApply({ allowDestructive: true })).rejects.toMatchObject({
      code: 'conflict_review_required'
    });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('device review version\n');
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
  });

  it('auto-merges clean overlapping Markdown edits through native Git before creating conflicts', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'markdown-merge-device-1');
    const device2Dir = join(root, 'markdown-merge-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseLines = [
      '# Shared',
      '',
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      ''
    ];
    await writeFile(join(device1Dir, 'shared.md'), baseLines.join('\n'));
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe(baseLines.join('\n'));

    const device1Lines = [...baseLines];
    device1Lines[3] = 'bravo from desktop';
    const device2Lines = [...baseLines];
    device2Lines[8] = 'golf from tablet';
    await writeFile(join(device1Dir, 'shared.md'), device1Lines.join('\n'));
    await writeFile(join(device2Dir, 'shared.md'), device2Lines.join('\n'));

    expect((await plugin1.syncOnce()).status).toBe('Synced');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await plugin1.syncOnce();

    const mergedLines = [...baseLines];
    mergedLines[3] = 'bravo from desktop';
    mergedLines[8] = 'golf from tablet';
    expect(await readFile(join(device1Dir, 'shared.md'), 'utf8')).toBe(mergedLines.join('\n'));
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe(mergedLines.join('\n'));

    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    expect(db.sync_operations.at(-1)?.prepared_manifest).toMatchObject({
      decision: 'merge',
      validator_results: {
        native_git_merge: 'clean',
        conflict_markers: 'absent',
        overlapping_path_count: 1
      }
    });
  });

  it('creates a conflict for concurrent same-key Markdown frontmatter edits even when Git merges cleanly', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'frontmatter-device-1');
    const device2Dir = join(root, 'frontmatter-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseLines = [
      '---',
      'tags:',
      '  - alpha',
      '  - bravo',
      '  - charlie',
      '  - delta',
      '  - echo',
      '  - foxtrot',
      'category: notes',
      '---',
      '# Shared',
      ''
    ];
    await writeFile(join(device1Dir, 'shared.md'), baseLines.join('\n'));
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe(baseLines.join('\n'));

    const device1Lines = [...baseLines];
    device1Lines[2] = '  - alpha-desktop';
    const device2Lines = [...baseLines];
    device2Lines[6] = '  - echo-tablet';
    await writeFile(join(device1Dir, 'shared.md'), device1Lines.join('\n'));
    await writeFile(join(device2Dir, 'shared.md'), device2Lines.join('\n'));

    expect((await plugin1.syncOnce()).status).toBe('Synced');
    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['shared.md'],
      validator_summary: {
        decision: 'conflict',
        reason: 'overlapping_paths',
        path_count: 1
      }
    });
  });

  it('auto-merges safe same-file Bases edits with the semantic Bases merge validator', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'base-merge-device-1');
    const device2Dir = join(root, 'base-merge-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseFile = [
      'views:',
      '  - type: table',
      '    name: Notes',
      'filters:',
      '  and: []',
      'formulas:',
      '  score: rating * 2',
      ''
    ].join('\n');
    await writeFile(join(device1Dir, 'library.base'), baseFile);
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'library.base'), 'utf8')).toBe(baseFile);

    await writeFile(
      join(device1Dir, 'library.base'),
      baseFile.replace('    name: Notes', '    name: Reading list')
    );
    await writeFile(
      join(device2Dir, 'library.base'),
      baseFile.replace('  score: rating * 2', '  score: rating * 3')
    );
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Synced');
    await plugin1.syncOnce();

    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    expect(db.sync_operations.at(-1)?.prepared_manifest).toMatchObject({
      decision: 'merge',
      validator_results: {
        native_git_merge: 'clean',
        conflict_markers: 'absent',
        overlapping_path_count: 1
      }
    });
    const merged = await readFile(join(device1Dir, 'library.base'), 'utf8');
    expect(merged).toContain('name: Reading list');
    expect(merged).toContain('score: rating * 3');
  });

  it('records a conflict for unsafe concurrent same-field Bases edits', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'base-conflict-device-1');
    const device2Dir = join(root, 'base-conflict-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseFile = [
      'filters:',
      '  and:',
      '    - status == "open"',
      'views:',
      '  - type: table',
      '    name: Notes',
      ''
    ].join('\n');
    await writeFile(join(device1Dir, 'library.base'), baseFile);
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'library.base'), 'utf8')).toBe(baseFile);

    await writeFile(join(device1Dir, 'library.base'), baseFile.replace('status == "open"', 'status == "done"'));
    await writeFile(join(device2Dir, 'library.base'), baseFile.replace('status == "open"', 'status == "archived"'));
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    const mainBeforeConflict = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)
      ?.current_main;

    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(mainBeforeConflict);
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['library.base'],
      validator_summary: {
        decision: 'conflict',
        reason: 'overlapping_paths',
        path_count: 1
      }
    });
  });

  it('auto-merges safe same-file Canvas edits when native Git reports a text conflict', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'canvas-merge-device-1');
    const device2Dir = join(root, 'canvas-merge-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseCanvas = JSON.stringify({
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 240, height: 120, text: 'base' }],
      edges: []
    }) + '\n';
    await writeFile(join(device1Dir, 'board.canvas'), baseCanvas);
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });

    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    expect(await readFile(join(device2Dir, 'board.canvas'), 'utf8')).toBe(baseCanvas);

    await writeFile(join(device1Dir, 'board.canvas'), baseCanvas.replace('"text":"base"', '"text":"desktop"'));
    await writeFile(join(device2Dir, 'board.canvas'), baseCanvas.replace('"text":"base"', '"text":"base","color":"2"'));
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await plugin1.syncOnce();

    const merged = JSON.parse(await readFile(join(device1Dir, 'board.canvas'), 'utf8')) as {
      nodes: Array<{ text?: string; color?: string }>;
    };
    expect(merged.nodes[0]).toMatchObject({ text: 'desktop', color: '2' });
    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    expect(db.sync_operations.at(-1)?.prepared_manifest).toMatchObject({
      decision: 'merge',
      validator_results: {
        native_git_merge: 'conflicted',
        semantic_merge: 'clean',
        semantic_merge_kinds: ['json_canvas'],
        overlapping_path_count: 1
      }
    });
  });

  it('creates a conflict for unsafe same-field Canvas semantic edits', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'canvas-conflict-device-1');
    const device2Dir = join(root, 'canvas-conflict-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseCanvas = JSON.stringify({
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 240, height: 120, text: 'base' }],
      edges: []
    }) + '\n';
    await writeFile(join(device1Dir, 'board.canvas'), baseCanvas);
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');

    await writeFile(join(device1Dir, 'board.canvas'), baseCanvas.replace('"text":"base"', '"text":"desktop"'));
    await writeFile(join(device2Dir, 'board.canvas'), baseCanvas.replace('"text":"base"', '"text":"tablet"'));
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    const mainBeforeConflict = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)
      ?.current_main;

    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Review needed');
    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(mainBeforeConflict);
    expect(db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId)).toMatchObject({
      status: 'open',
      affected_paths: ['board.canvas']
    });
  });

  it('auto-merges safe compact Bases edits when native Git reports a text conflict', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'compact-base-merge-device-1');
    const device2Dir = join(root, 'compact-base-merge-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const baseFile = '{views: [{type: table, name: Notes}], formulas: {score: rating * 2}}\n';
    await writeFile(join(device1Dir, 'library.base'), baseFile);
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');

    await writeFile(join(device1Dir, 'library.base'), baseFile.replace('name: Notes', 'name: Reading list'));
    await writeFile(join(device2Dir, 'library.base'), baseFile.replace('rating * 2', 'rating * 3'));
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await plugin1.syncOnce();

    const merged = await readFile(join(device1Dir, 'library.base'), 'utf8');
    expect(merged).toContain('name: Reading list');
    expect(merged).toContain('score: rating * 3');
    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    expect(db.sync_operations.at(-1)?.prepared_manifest).toMatchObject({
      decision: 'merge',
      validator_results: {
        native_git_merge: 'conflicted',
        semantic_merge: 'clean',
        semantic_merge_kinds: ['obsidian_bases'],
        overlapping_path_count: 1
      }
    });
  });

  it('records a conflict for file-directory hierarchy collisions instead of attempting an unsafe merge', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'hierarchy-device-1');
    const device2Dir = join(root, 'hierarchy-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');

    await writeFile(join(device1Dir, 'topic.md'), 'main file\n');
    await mkdirp(join(device2Dir, 'topic.md'));
    await writeFile(join(device2Dir, 'topic.md', 'child.md'), 'nested note\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    const mainBeforeConflict = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)
      ?.current_main;

    const result = await plugin2.syncOnce();
    expect(result.status).toBe('Review needed');

    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(mainBeforeConflict);
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === result.conflictId);
    expect(conflict).toMatchObject({
      status: 'open',
      affected_paths: ['topic.md', 'topic.md/child.md'],
      validator_summary: {
        decision: 'conflict',
        reason: 'overlapping_paths',
        path_count: 2
      }
    });
  });

  it('auto-merges same-path binary attachment edits when object identity matches', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'binary-identity-device-1');
    const device2Dir = join(root, 'binary-identity-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    const plugin2 = await pairPlugin(admin, device2Dir, 'tablet');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    await writeFile(join(device1Dir, 'diagram.png'), imageBytes);
    await writeFile(join(device2Dir, 'diagram.png'), imageBytes);
    await writeFile(join(device2Dir, 'tablet.md'), 'device-specific note\n');

    expect((await plugin1.syncOnce()).status).toBe('Synced');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await plugin1.syncOnce();

    expect(await readFile(join(device1Dir, 'diagram.png'))).toEqual(imageBytes);
    expect(await readFile(join(device2Dir, 'diagram.png'))).toEqual(imageBytes);
    expect(await readFile(join(device1Dir, 'tablet.md'), 'utf8')).toBe('device-specific note\n');
    const db = await server.store.snapshot();
    expect(db.conflicts).toHaveLength(0);
    const identityMerge = db.sync_operations.findLast(
      (operation) => operation.operation_type === 'server_merge' && operation.prepared_manifest?.validator_results !== undefined
    );
    expect(identityMerge?.prepared_manifest).toMatchObject({
      decision: 'merge',
      validator_results: {
        identity_only_merge: 'ok',
        overlapping_path_count: 1
      }
    });
  });

  it('uploads divergent additional-device content as a device proposal', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'proposal-device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'server.md'), 'server state\n');

    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');

    const device2Dir = join(root, 'proposal-device-2');
    await mkdirp(device2Dir);
    await writeFile(join(device2Dir, 'server.md'), 'server state\n');
    await writeFile(join(device2Dir, 'local-only.md'), 'do not discard silently\n');
    const plugin2 = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
    });

    await onboardExistingVault(admin, plugin2, admin.vaultId, 'merge');
    expect(await plugin2.readState()).toMatchObject({
      status_label: 'Synced',
      initial_import_confirmed: true
    });
    expect(await readFile(join(device2Dir, 'local-only.md'), 'utf8')).toBe('do not discard silently\n');

    expect(await readFile(join(device1Dir, 'local-only.md'), 'utf8').catch(() => '')).toBe('');
    await plugin1.syncOnce();
    expect(await readFile(join(device1Dir, 'local-only.md'), 'utf8')).toBe('do not discard silently\n');
  });

  it('recovers and replaces local file-directory collisions during replace-local-with-server', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'replace-collision-device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'topic.md'), 'server file wins\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');

    const device2Dir = join(root, 'replace-collision-device-2');
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    await rm(join(device2Dir, 'topic.md'), { force: true });
    await mkdirp(join(device2Dir, 'topic.md'));
    await writeFile(join(device2Dir, 'topic.md', 'child.md'), 'local directory content\n');
    const state = await plugin2.readState();
    await writeFile(join(device2Dir, '.obts', 'state.json'), JSON.stringify({
      ...state,
      local_main: null,
      last_error_code: 'replace_local_with_server_required',
      status_label: 'Needs recovery'
    }));

    const replaced = await plugin2.replaceLocalWithServer();
    expect(replaced.status).toBe('Synced');
    expect(await readFile(join(device2Dir, 'topic.md'), 'utf8')).toBe('server file wins\n');
    expect(await exists(join(device2Dir, 'topic.md', 'child.md'))).toBe(false);
    expect(await recoveryBundleContains(device2Dir, 'topic.md/child.md')).toBe(true);
  });

  it('uploads additional-device local content even when server main is still empty', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'empty-server-device-1');
    await mkdirp(device1Dir);
    const plugin1 = await pairPlugin(admin, device1Dir, 'empty-desktop');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const device2Dir = join(root, 'empty-server-device-2');
    await mkdirp(device2Dir);
    await writeFile(join(device2Dir, 'local-only.md'), 'should become device proposal\n');
    const plugin2 = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
    });

    await onboardExistingVault(admin, plugin2, admin.vaultId, 'merge');
    expect(await readFile(join(device2Dir, 'local-only.md'), 'utf8')).toBe('should become device proposal\n');

    await plugin1.syncOnce();
    expect(await readFile(join(device1Dir, 'local-only.md'), 'utf8')).toBe('should become device proposal\n');
  });

  it('blocks onboarding on partial local .obts state before server authorization', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const partialDir = join(root, 'partial-device');
    await mkdirp(join(partialDir, '.obts', 'git'));
    const partialPlugin = new ObtsPluginClient(partialDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
    });
    await expect(partialPlugin.startOnboarding('Partial Vault')).rejects.toMatchObject({
      code: 'partial_local_state'
    });

    const cleanDir = join(root, 'clean-device');
    await mkdirp(cleanDir);
    const cleanPlugin = new ObtsPluginClient(cleanDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
    });
    await onboardExistingVault(admin, cleanPlugin, admin.vaultId);
    expect((await awaitState(cleanPlugin)).device_id).toMatch(/^dev_/u);
    const initializedDir = join(root, 'initialized-device');
    await mkdirp(initializedDir);
    const initializedPlugin = new ObtsPluginClient(initializedDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'initialized-phone',
    });
    await initializedPlugin.initialize();
    await onboardExistingVault(admin, initializedPlugin, admin.vaultId);
    expect((await awaitState(initializedPlugin)).device_id).toMatch(/^dev_/u);
  });

  it('blocks token-only local state until explicit reset and reconnect', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'token-only-device');
    await mkdirp(join(deviceDir, '.obts', 'auth'));
    await writeFile(join(deviceDir, 'local.md'), 'preserve before reset\n');
    await writeFile(join(deviceDir, '.obts', 'auth', 'device-token.json'), JSON.stringify({ device_token: 'obts_dev_local_test' }));
    await writeFile(
      join(deviceDir, '.obts', 'state.json'),
      `${JSON.stringify({
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        updated_at: new Date().toISOString()
      })}\n`
    );

    const plugin = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'phone',
    });
    await plugin.initialize();
    expect(await plugin.readState()).toMatchObject({
      status_label: 'Needs recovery',
      last_error_code: 'local_state_incomplete'
    });

    await expect(plugin.startOnboarding('Recovered Vault')).rejects.toMatchObject({
      code: 'local_state_already_paired'
    });

    const reset = await plugin.resetLocalPairingState();
    expect(reset.status).toBe('Not paired');
    expect(await exists(join(deviceDir, '.obts', 'auth', 'device-token.json'))).toBe(false);
    expect(await recoveryBundleContains(deviceDir, 'local.md')).toBe(true);

    await onboardExistingVault(admin, plugin, admin.vaultId, 'merge');
    expect((await plugin.readState()).device_id).toMatch(/^dev_/u);
  });

  it('repairs lost local metadata and uploads filesystem edits through the device ref', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'repaired-laptop');
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const pairedState = await plugin.readState();
    await writeFile(join(deviceDir, 'laptop-only.md'), 'written while metadata was lost\n');
    await writeFile(
      join(deviceDir, '.obts', 'state.json'),
      `${JSON.stringify({
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        updated_at: new Date().toISOString()
      })}\n`
    );
    await rm(join(deviceDir, '.obts', 'state.json.bak'), { force: true });

    const repaired = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'laptop',
    });
    await repaired.initialize();
    expect(await repaired.readState()).toMatchObject({
      vault_id: pairedState.vault_id,
      device_id: pairedState.device_id,
      last_error_code: null
    });

    expect((await repaired.syncOnce()).status).toBe('Synced');
    const secondDir = join(root, 'repaired-phone');
    const second = await pairPlugin(admin, secondDir, 'phone');
    expect((await second.readState()).status_label).toBe('Synced');
    expect(await readFile(join(secondDir, 'laptop-only.md'), 'utf8')).toBe('written while metadata was lost\n');
  });

  it('repairs lost metadata without local refs by proposing visible files from server main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'missing-local-refs-desktop');
    const laptopDir = join(root, 'missing-local-refs-laptop');
    await mkdirp(desktopDir);
    await writeFile(join(desktopDir, 'server.md'), 'server state\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await desktop.syncOnce({ confirmInitialImport: true });

    const laptop = await pairPlugin(admin, laptopDir, 'laptop');
    expect(await readFile(join(laptopDir, 'server.md'), 'utf8')).toBe('server state\n');
    await rm(join(laptopDir, '.obts', 'git'), { recursive: true, force: true });
    await writeFile(join(laptopDir, 'laptop-only.md'), 'written after local refs vanished\n');
    await writeFile(
      join(laptopDir, '.obts', 'state.json'),
      `${JSON.stringify({
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        updated_at: new Date().toISOString()
      })}\n`
    );
    await rm(join(laptopDir, '.obts', 'state.json.bak'), { force: true });

    const repairedLaptop = new ObtsPluginClient(laptopDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'laptop',
    });
    expect((await repairedLaptop.syncOnce()).status).toBe('Synced');
    await desktop.syncOnce();
    expect(await readFile(join(desktopDir, 'laptop-only.md'), 'utf8')).toBe('written after local refs vanished\n');
  });

  it('re-pairs lost-state first devices as proposals when local Git history survives', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'repair-first-device-local-history');
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const pairedState = await plugin.readState();
    expect(pairedState.local_main).toMatch(/^[0-9a-f]{40}$/u);
    await writeFile(
      join(deviceDir, '.obts', 'state.json'),
      `${JSON.stringify({
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        updated_at: new Date().toISOString()
      })}\n`
    );
    await rm(join(deviceDir, '.obts', 'state.json.bak'), { force: true });
    expect((await plugin.resetLocalPairingState()).status).toBe('Not paired');
    await writeFile(join(deviceDir, 'laptop-only.md'), 'first-device re-pair data\n');

    await onboardExistingVault(admin, plugin, admin.vaultId, 'merge');
    expect(await readFile(join(deviceDir, 'laptop-only.md'), 'utf8')).toBe('first-device re-pair data\n');
    const repairedState = await plugin.readState();
    expect(repairedState.initial_import_confirmed).toBe(true);
    expect(repairedState.status_label).toBe('Synced');
  });

  it('uploads repaired local edits into server conflict state instead of requiring replace-local', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'repair-conflict-desktop');
    const laptopDir = join(root, 'repair-conflict-laptop');
    await mkdirp(desktopDir);
    await mkdirp(laptopDir);
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await desktop.syncOnce({ confirmInitialImport: true });
    await pairPlugin(admin, laptopDir, 'laptop');
    expect(await readFile(join(laptopDir, 'shared.md'), 'utf8')).toBe('base\n');

    await writeFile(join(laptopDir, 'shared.md'), 'laptop edit while metadata was lost\n');
    await writeFile(
      join(laptopDir, '.obts', 'state.json'),
      `${JSON.stringify({
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        updated_at: new Date().toISOString()
      })}\n`
    );
    await rm(join(laptopDir, '.obts', 'state.json.bak'), { force: true });

    await writeFile(join(desktopDir, 'shared.md'), 'desktop edit reaches main first\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const repairedLaptop = new ObtsPluginClient(laptopDir, {
      serverUrl: baseUrlFromAdmin(admin),
      deviceName: 'laptop',
    });
    const result = await repairedLaptop.syncOnce();
    expect(result.status).toBe('Review needed');
    expect(result.conflictId).toMatch(/^conf_/u);
    expect((await repairedLaptop.readState()).last_error_code).toBe('conflict_review_required');
    expect(await readFile(join(laptopDir, 'shared.md'), 'utf8')).toBe('laptop edit while metadata was lost\n');
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

  it('keeps readiness healthy while a prepared main ref update is committing metadata', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'live-ref-transition-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'base.md'), 'base\n');
    const plugin = await pairPlugin(admin, deviceDir, 'live-ref-transition-device');
    await plugin.syncOnce({ confirmInitialImport: true });

    const originalUpdateRef = server.git.updateRef.bind(server.git);
    let releaseRefUpdate!: () => void;
    let refMoved!: () => void;
    const refUpdateGate = new Promise<void>((resolve) => { releaseRefUpdate = resolve; });
    const refMovedPromise = new Promise<void>((resolve) => { refMoved = resolve; });
    let paused = false;
    server.git.updateRef = async (...args: Parameters<typeof server.git.updateRef>) => {
      await originalUpdateRef(...args);
      if (!paused && args[1] === 'refs/heads/main') {
        paused = true;
        refMoved();
        await refUpdateGate;
      }
    };

    const originalSnapshot = server.store.snapshot.bind(server.store);
    let injectReadinessRace = false;
    let raceInjected = false;
    let syncing: ReturnType<typeof plugin.syncOnce> | null = null;
    server.store.snapshot = async () => {
      const snapshot = await originalSnapshot();
      if (injectReadinessRace && !raceInjected) {
        raceInjected = true;
        syncing = plugin.syncOnce();
        await refMovedPromise;
      }
      return snapshot;
    };

    await writeFile(join(deviceDir, 'next.md'), 'next\n');
    injectReadinessRace = true;
    try {
      const ready = await fetch(`${baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect((await ready.json()) as Json).toMatchObject({ checks: { persistent_state: true } });
      expect((await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.status).toBe('active');
      await server.store.mutate((db) => {
        const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
        expect(vault).toBeDefined();
        vault!.status = 'blocked_integrity';
      });
      await expect(repairVaultIntegrity(server.store, server.git, admin.vaultId)).rejects.toThrow(
        'Vault integrity remains inconsistent: vault main ref is inconsistent with metadata'
      );
      await server.store.mutate((db) => {
        const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
        expect(vault).toBeDefined();
        vault!.status = 'active';
      });
    } finally {
      releaseRefUpdate();
      server.git.updateRef = originalUpdateRef;
      server.store.snapshot = originalSnapshot;
    }
    expect(raceInjected).toBe(true);
    await expect(syncing).resolves.toMatchObject({ status: 'Synced' });
  });

  it('refreshes a prepared device-ref transition after slow object promotion', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'slow-promotion-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'slow-promotion-device');
    await writeFile(join(deviceDir, 'after-promotion.md'), 'content\n');

    const originalPromote = server.git.promoteTransferObjects.bind(server.git);
    const originalUpdateRef = server.git.updateRef.bind(server.git);
    let staleTimestampInjected = false;
    let freshTimestampObserved = false;
    server.git.promoteTransferObjects = async (...args: Parameters<typeof server.git.promoteTransferObjects>) => {
      await originalPromote(...args);
      await server.store.mutate((db) => {
        const operation = db.sync_operations.find((candidate) =>
          candidate.vault_id === admin.vaultId &&
          candidate.status === 'prepared' &&
          candidate.operation_type === 'device_push'
        );
        expect(operation).toBeDefined();
        operation!.updated_at = '2000-01-01T00:00:00.000Z';
        staleTimestampInjected = true;
      });
    };
    server.git.updateRef = async (...args: Parameters<typeof server.git.updateRef>) => {
      if (args[1].startsWith('refs/obts/devices/')) {
        const operation = (await server.store.snapshot()).sync_operations.find((candidate) =>
          candidate.vault_id === admin.vaultId &&
          candidate.status === 'prepared' &&
          candidate.operation_type === 'device_push'
        );
        freshTimestampObserved = Boolean(operation && Date.now() - Date.parse(operation.updated_at) < 5_000);
      }
      await originalUpdateRef(...args);
    };

    try {
      await expect(plugin.syncOnce()).resolves.toMatchObject({ status: 'Synced' });
      expect(staleTimestampInjected).toBe(true);
      expect(freshTimestampObserved).toBe(true);
    } finally {
      server.git.promoteTransferObjects = originalPromote;
      server.git.updateRef = originalUpdateRef;
    }
  });

  it('stops before pack planning on an integrity block and resumes after validated repair', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'integrity-repair-resume-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'integrity-repair-resume-device');
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.status = 'blocked_integrity';
    });
    await writeFile(join(deviceDir, 'queued.md'), 'preserve while blocked\n');

    const internal = (plugin as unknown as { client: Record<string, any> }).client;
    const originalPlan = internal.planPackChunks.bind(internal);
    let planCalls = 0;
    internal.planPackChunks = async (...args: unknown[]) => {
      planCalls += 1;
      return await originalPlan(...args);
    };

    await expect(plugin.syncOnce()).rejects.toMatchObject({ code: 'blocked_integrity' });
    expect(planCalls).toBe(0);
    const blockedState = await plugin.readState();
    expect(blockedState).toMatchObject({ status_label: 'Unsafe local state', last_error_code: 'blocked_integrity' });
    expect(await plugin.readQueue()).toMatchObject({ status: 'queued_local', pending_commit: expect.stringMatching(/^[0-9a-f]{40}$/u) });

    const blockedTransfer = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/push-transfers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await readDeviceToken(deviceDir)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        api_version: API_VERSION,
        plugin_version: RECOMMENDED_PLUGIN_VERSION,
        vault_id: admin.vaultId,
        device_id: blockedState.device_id,
        expected_device_ref: blockedState.server_device_ref,
        target_commit: blockedState.local_head,
        client_known_main: blockedState.local_main,
        attempt_id: 'blocked-integrity-attempt',
        chunk_count: 1,
        plan_sha256: '0'.repeat(64)
      })
    });
    expect(blockedTransfer.status).toBe(409);
    await expect(blockedTransfer.json()).resolves.toMatchObject({ error: { code: 'blocked_integrity' } });

    await repairVaultIntegrity(server.store, server.git, admin.vaultId);
    await internal.reportDeviceStatus();
    expect(await plugin.readState()).toMatchObject({ status_label: 'Ahead', last_error_code: null });
    expect(internal.plugin.syncQueued).toBe(true);
    internal.plugin.syncQueued = false;
    await expect(plugin.syncOnce()).resolves.toMatchObject({ status: 'Synced' });
  });

  it('rolls forward a prepared merge operation when startup finds main already advanced', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'reconcile-merge-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'reconcile.md'), 'prepared merge target\n');
    const plugin = await pairPlugin(admin, deviceDir, 'desktop');
    await plugin.syncOnce({ confirmInitialImport: true });

    const committedDb = await server.store.snapshot();
    const mergeOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'server_merge' && operation.status === 'committed'
    );
    expect(mergeOperation?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(mergeOperation?.target_refs).toMatchObject({
      'refs/heads/main': mergeOperation?.target_commit
    });
    const targetMain = mergeOperation!.target_commit!;
    const previousMain = mergeOperation!.expected_refs['refs/heads/main'];
    expect(previousMain).toMatch(/^[0-9a-f]{40}$/u);

    await server.store.mutate((db) => {
      const operation = db.sync_operations.find((candidate) => candidate.operation_id === mergeOperation!.operation_id);
      expect(operation).toBeDefined();
      operation!.status = 'prepared';
      operation!.result = null;
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.current_main = previousMain!;
      const device = db.devices.find((candidate) => candidate.device_id === mergeOperation!.device_id);
      expect(device).toBeDefined();
      device!.status = 'ahead';
      device!.last_successful_sync_at = null;
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const reconciledDb = await server.store.snapshot();
    expect(reconciledDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(targetMain);
    const reconciledOperation = reconciledDb.sync_operations.find(
      (operation) => operation.operation_id === mergeOperation!.operation_id
    );
    expect(reconciledOperation).toMatchObject({
      status: 'committed',
      result: {
        decision: 'merged',
        merge_commit: targetMain,
        reconciled_after_startup: true
      }
    });
    expect(
      reconciledDb.events.find((event) => event.event_type === 'main_advanced' && event.payload.reconciled_after_startup === true)
    ).toBeDefined();
  });

  it('aborts a prepared merge operation on startup when no target ref was recorded and refs did not move', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'abort-prepared-merge-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'pre-target.md'), 'prepared before target ref\n');
    const plugin = await pairPlugin(admin, deviceDir, 'desktop');
    await plugin.syncOnce({ confirmInitialImport: true });

    const committedDb = await server.store.snapshot();
    const mergeOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'server_merge' && operation.status === 'committed'
    );
    const devicePush = committedDb.sync_operations.find(
      (operation) => operation.operation_type === 'device_push' && operation.status === 'committed'
    );
    expect(mergeOperation?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(devicePush?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    const previousMain = mergeOperation!.expected_refs['refs/heads/main'];
    expect(previousMain).toMatch(/^[0-9a-f]{40}$/u);

    await server.git.updateRef(admin.vaultId, 'refs/heads/main', previousMain!, mergeOperation!.target_commit);
    await server.store.mutate((db) => {
      const operation = db.sync_operations.find((candidate) => candidate.operation_id === mergeOperation!.operation_id);
      expect(operation).toBeDefined();
      operation!.status = 'prepared';
      operation!.target_refs = { 'refs/heads/main': null };
      operation!.target_commit = null;
      operation!.result = null;
      operation!.prepared_manifest = {
        merge_sequence: operation!.prepared_manifest?.merge_sequence,
        merge_policy_version: operation!.prepared_manifest?.merge_policy_version,
        base_commit: operation!.prepared_manifest?.base_commit,
        current_main: operation!.prepared_manifest?.current_main,
        device_commit: operation!.prepared_manifest?.device_commit,
        decision: 'merge',
        validator_results: operation!.prepared_manifest?.validator_results
      };
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.current_main = previousMain!;
      vault!.status = 'active';
      const device = db.devices.find((candidate) => candidate.device_id === mergeOperation!.device_id);
      expect(device).toBeDefined();
      device!.status = 'ahead';
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const reconciledDb = await server.store.snapshot();
    const originalOperation = reconciledDb.sync_operations.find(
      (operation) => operation.operation_id === mergeOperation!.operation_id
    );
    expect(originalOperation).toMatchObject({
      status: 'aborted',
      result: {
        reason: 'startup_prepared_ref_not_moved'
      }
    });
    expect(reconciledDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.status).toBe('active');
    expect(reconciledDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toMatch(
      /^[0-9a-f]{40}$/u
    );
  });

  it('fails readiness closed when a prepared operation has no target ref and refs already moved', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'unknown-prepared-merge-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'unknown-target.md'), 'prepared unknown target ref\n');
    const plugin = await pairPlugin(admin, deviceDir, 'desktop');
    await plugin.syncOnce({ confirmInitialImport: true });

    const committedDb = await server.store.snapshot();
    const mergeOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'server_merge' && operation.status === 'committed'
    );
    expect(mergeOperation?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    const previousMain = mergeOperation!.expected_refs['refs/heads/main'];
    expect(previousMain).toMatch(/^[0-9a-f]{40}$/u);

    await server.store.mutate((db) => {
      const operation = db.sync_operations.find((candidate) => candidate.operation_id === mergeOperation!.operation_id);
      expect(operation).toBeDefined();
      operation!.status = 'prepared';
      operation!.target_refs = { 'refs/heads/main': null };
      operation!.target_commit = null;
      operation!.result = null;
      operation!.prepared_manifest = {
        merge_sequence: operation!.prepared_manifest?.merge_sequence,
        merge_policy_version: operation!.prepared_manifest?.merge_policy_version,
        base_commit: operation!.prepared_manifest?.base_commit,
        current_main: operation!.prepared_manifest?.current_main,
        device_commit: operation!.prepared_manifest?.device_commit,
        decision: 'merge',
        validator_results: operation!.prepared_manifest?.validator_results
      };
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.current_main = previousMain!;
      vault!.status = 'active';
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { detail: string; checks: { persistent_state: boolean } };
    expect(body.detail).toBe('vault persistent state is blocked by an integrity failure');
    expect(body.checks.persistent_state).toBe(false);
    const reconciledDb = await server.store.snapshot();
    expect(reconciledDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.status).toBe('blocked_integrity');
    expect(
      reconciledDb.sync_operations.find((operation) => operation.operation_id === mergeOperation!.operation_id)?.result
    ).toMatchObject({
      reason: 'prepared operation does not contain a recoverable target ref'
    });
  });

  it('resumes a reconciled device ref update and merges it on startup', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'reconcile-device-push-device');
    await mkdirp(deviceDir);
    await writeFile(join(deviceDir, 'pending-device-ref.md'), 'pending merge after restart\n');
    const plugin = await pairPlugin(admin, deviceDir, 'desktop');
    await plugin.syncOnce({ confirmInitialImport: true });

    const committedDb = await server.store.snapshot();
    const devicePush = committedDb.sync_operations.find(
      (operation) => operation.operation_type === 'device_push' && operation.status === 'committed'
    );
    const originalMerge = committedDb.sync_operations.find(
      (operation) => operation.operation_type === 'server_merge' && operation.status === 'committed'
    );
    expect(devicePush?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(originalMerge?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    const previousMain = originalMerge!.expected_refs['refs/heads/main'];
    expect(previousMain).toMatch(/^[0-9a-f]{40}$/u);

    await server.git.updateRef(admin.vaultId, 'refs/heads/main', previousMain!, originalMerge!.target_commit);
    await server.store.mutate((db) => {
      const operation = db.sync_operations.find((candidate) => candidate.operation_id === devicePush!.operation_id);
      expect(operation).toBeDefined();
      operation!.status = 'prepared';
      operation!.result = null;
      const oldMerge = db.sync_operations.find((candidate) => candidate.operation_id === originalMerge!.operation_id);
      expect(oldMerge).toBeDefined();
      oldMerge!.status = 'aborted';
      oldMerge!.result = { reason: 'test_rewind_to_pre_merge_crash_window' };
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.current_main = previousMain!;
      vault!.updated_at = new Date().toISOString();
      const device = db.devices.find((candidate) => candidate.device_id === devicePush!.device_id);
      expect(device).toBeDefined();
      device!.device_ref_head = null;
      device!.status = 'paired';
      device!.last_successful_sync_at = null;
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    const reconciledDb = await server.store.snapshot();
    const reconciledPush = reconciledDb.sync_operations.find(
      (operation) => operation.operation_id === devicePush!.operation_id
    );
    expect(reconciledPush).toMatchObject({
      status: 'committed',
      result: {
        device_ref: devicePush!.target_commit,
        reconciled_after_startup: true
      }
    });
    const resumedMerge = reconciledDb.sync_operations.find(
      (operation) =>
        operation.operation_type === 'server_merge' &&
        operation.status === 'committed' &&
        operation.expected_refs['refs/heads/main'] === previousMain &&
        operation.target_commit !== originalMerge!.target_commit
    );
    expect(resumedMerge?.target_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(reconciledDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(
      resumedMerge!.target_commit
    );
    expect(await server.git.getRef(admin.vaultId, 'refs/heads/main')).toBe(resumedMerge!.target_commit);
  });

  it('returns 410 when an event cursor has fallen behind retained event history', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    await server.store.mutate((db) => {
      for (const event of db.events.filter((candidate) => candidate.vault_id === admin.vaultId)) {
        event.created_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      }
      server.store.appendEvent(db, {
        event_type: 'device_state_changed',
        vault_id: admin.vaultId,
        resource_ids: {},
        commit_cursors: {},
        payload: { status: 'checking' }
      });
    });

    const expired = await admin.get<{
      error: { code: string; details: { current_event_seq: number; oldest_available_event_seq: number } };
    }>(`/api/v1/vaults/${admin.vaultId}/events?after=0`);
    expect(expired.status).toBe(410);
    expect(expired.body.error).toMatchObject({
      code: 'event_cursor_expired',
      details: {
        current_event_seq: 2,
        oldest_available_event_seq: 2
      }
    });

    const replay = await admin.get<{ events: Array<{ event_seq: number }>; current_event_seq: number }>(
      `/api/v1/vaults/${admin.vaultId}/events?after=1`
    );
    expect(replay.status).toBe(200);
    expect(replay.body.events.map((event) => event.event_seq)).toEqual([2]);
    expect(replay.body.current_event_seq).toBe(2);
  });

  it('lets paired devices poll redacted vault events without dashboard session cookies', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'device-event-poller-1');
    const device2Dir = join(root, 'device-event-poller-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'base.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');
    const token2 = await readDeviceToken(device2Dir);
    const transport = new TransportClient(baseUrl);

    const initialEvents = await transport.pollEvents({
      vaultId: admin.vaultId,
      deviceToken: token2,
      after: 0
    });
    expect(initialEvents.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'main_advanced',
          commit_cursors: expect.objectContaining({
            main: expect.stringMatching(/^[0-9a-f]{40}$/u)
          })
        })
      ])
    );

    await writeFile(join(device1Dir, 'from-desktop.md'), 'server event\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const afterAdvance = await transport.pollEvents({
      vaultId: admin.vaultId,
      deviceToken: token2,
      after: initialEvents.current_event_seq
    });
    expect(afterAdvance.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'main_advanced',
          resource_ids: expect.objectContaining({
            device_id: (await plugin1.readState()).device_id
          }),
          payload: expect.objectContaining({
            decision: 'merged'
          })
        })
      ])
    );
    expect(await exists(join(device2Dir, 'from-desktop.md'))).toBe(false);
    const polledApply = await plugin2.pollRemoteEventsAndApply();
    expect(polledApply).toMatchObject({ applied: true, status: 'Synced' });
    expect(await readFile(join(device2Dir, 'from-desktop.md'), 'utf8')).toBe('server event\n');
    expect((await plugin2.readState()).last_event_seq).toEqual(expect.any(Number));

    await server.store.mutate((db) => {
      for (const event of db.events.filter((candidate) => candidate.vault_id === admin.vaultId)) {
        event.created_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      }
      server.store.appendEvent(db, {
        event_type: 'device_state_changed',
        vault_id: admin.vaultId,
        resource_ids: {},
        commit_cursors: {},
        payload: { status: 'checking' }
      });
    });
    await expect(
      transport.pollEvents({
        vaultId: admin.vaultId,
        deviceToken: token2,
        after: 0
      })
    ).rejects.toMatchObject({ status: 410, code: 'event_cursor_expired' });
  });

  it('blocks sync on restart when an incomplete apply journal cannot be replayed', async () => {
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
          target_main: '1111111111111111111111111111111111111111',
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

  it('fails closed and preserves a malformed apply journal during restart', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'malformed-journal-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'malformed-journal-device');
    const state = await plugin.readState();
    const unsafePathJournal = JSON.stringify({
      apply_id: 'apply_unsafe_path',
      operation_type: 'pull_apply',
      target_main: state.local_main,
      expected_prior_local_main: state.local_main,
      expected_prior_local_device_ref: state.server_device_ref,
      phase: 'writing_files',
      affected_paths: ['../outside.md'],
      preflight_sha256: { '../outside.md': null },
      recovery_bundle_id: null,
      last_completed_step: null,
      redacted_error_category: null
    });
    const journalPath = join(deviceDir, '.obts', 'apply-journal.json');
    for (const malformedJournal of ['{"phase":"writing_files"', 'null', 'false', unsafePathJournal]) {
      await writeFile(journalPath, malformedJournal);
      const restartedPlugin = new ObtsPluginClient(deviceDir, {
        serverUrl: baseUrl,
        deviceName: 'malformed-journal-device'
      });
      await expect(restartedPlugin.initialize()).rejects.toThrow();
      expect(await readFile(journalPath, 'utf8')).toBe(malformedJournal);
    }
  });

  it('clears a stale local apply lock after replaying a committed apply journal', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'committed-journal-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    expect(state.local_main).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(
      join(deviceDir, '.obts', 'apply-journal.json'),
      `${JSON.stringify(
        {
          apply_id: 'apply_committed',
          operation_type: 'pull_apply',
          target_main: state.local_main,
          expected_prior_local_main: state.local_main,
          expected_prior_local_device_ref: state.server_device_ref,
          phase: 'committed',
          affected_paths: [],
          preflight_sha256: {},
          recovery_bundle_id: null,
          last_completed_step: 'refs_updated',
          redacted_error_category: null
        },
        null,
        2
      )}\n`
    );
    await writeFile(join(deviceDir, '.obts', 'apply.lock'), '{"apply_id":"apply_committed"}\n');

    expect((await plugin.syncOnce()).status).toBe('Synced');
    expect(await exists(join(deviceDir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await exists(join(deviceDir, '.obts', 'apply.lock'))).toBe(false);
  });

  it('fails closed when a legacy ref lock has no trustworthy age', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'ambiguous-ref-lock-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'ambiguous-ref-lock-device');
    const state = await plugin.readState();
    const refPath = join(deviceDir, '.obts', 'git', 'refs', 'heads', 'local');
    const lockPath = `${refPath}.lock`;
    await writeFile(lockPath, `${state.local_main}\n`);
    await utimes(lockPath, new Date(0), new Date(0));

    const restarted = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'ambiguous-ref-lock-device' });
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'local_ref_recovery_required' });
    expect(await readFile(lockPath, 'utf8')).toBe(`${state.local_main}\n`);
    expect(await readFile(refPath, 'utf8')).toBe(`${state.local_main}\n`);
  });

  it('does not promote a ref stage after losing its ownership lease', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'ref-lease-owner-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'ref-lease-owner-device');
    const state = await plugin.readState();
    const internals = (plugin as unknown as { client: Record<string, any> }).client;
    const originalAssertOwner = internals.assertRefLeaseOwner.bind(internals);
    let ownershipChecks = 0;
    internals.assertRefLeaseOwner = async (leasePath: string, nonce: string) => {
      ownershipChecks += 1;
      if (ownershipChecks === 2) {
        await internals.fsp.writeFile(leasePath, `${JSON.stringify({ nonce: 'f'.repeat(16), target: state.local_main })}\n`);
      }
      return await originalAssertOwner(leasePath, nonce);
    };

    await expect(internals.updateRef('refs/heads/local', state.local_main, state.local_main)).rejects.toMatchObject({
      code: 'local_ref_lease_lost'
    });
    expect(await readFile(join(deviceDir, '.obts', 'git', 'refs', 'heads', 'local'), 'utf8')).toBe(`${state.local_main}\n`);
    expect(ownershipChecks).toBe(2);
  });

  it('uses a local apply lock before applying pulled server changes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'lock-device-1', 'lock-device-2');
    await writeFile(join(device2Dir, '.obts', 'apply.lock'), '{"apply_id":"apply_existing"}\n');

    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'apply_lock_active' });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');
    expect((await plugin2.readState()).status_label).toBe('Unsafe local state');
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
  });

  it('rolls forward an incomplete apply journal after restart when replay is safe', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'journal-device-1', 'journal-device-2');
    const state = await plugin2.readState();
    const token = await readDeviceToken(device2Dir);
    const transport = new TransportClient(baseUrl);
    const pulled = await transport.pull({
      vaultId: admin.vaultId,
      deviceId: state.device_id!,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    const localGit = new LocalGitEngine(device2Dir);
    await localGit.importPack(pulled.packfile);
    const beforeHash = sha256(Buffer.from(await readFile(join(device2Dir, 'shared.md'))));
    await writeFile(
      join(device2Dir, '.obts', 'apply-journal.json'),
      `${JSON.stringify(
        {
          apply_id: 'apply_test_replay',
          operation_type: 'pull_apply',
          target_main: pulled.manifest.target_main,
          expected_prior_local_main: state.local_main,
          expected_prior_local_device_ref: state.server_device_ref,
          phase: 'recovery_bundle_written',
          affected_paths: ['shared.md'],
          preflight_sha256: { 'shared.md': beforeHash },
          recovery_bundle_id: 'rec_test_replay',
          last_completed_step: 'recovery_bundle',
          redacted_error_category: null
        },
        null,
        2
      )}\n`
    );

    const restartedPlugin = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrl,
      deviceName: 'journal-device-2',
    });
    await restartedPlugin.initialize();

    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('server update\n');
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await exists(join(device2Dir, '.obts', 'apply.lock'))).toBe(false);
    expect(await restartedPlugin.readState()).toMatchObject({
      local_main: pulled.manifest.target_main,
      local_head: pulled.manifest.target_main,
      status_label: 'Synced',
      last_error_code: null
    });
  });

  it('does not reread packed target blobs for files already applied before journal recovery', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'journal-packed-device-1', 'journal-packed-device-2');
    const state = await plugin2.readState();
    const token = await readDeviceToken(device2Dir);
    const transport = new TransportClient(baseUrl);
    const pulled = await transport.pull({
      vaultId: admin.vaultId,
      deviceId: state.device_id!,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    const localGit = new LocalGitEngine(device2Dir);
    await localGit.importPack(pulled.packfile);
    const preflightHash = sha256(Buffer.from(await readFile(join(device2Dir, 'shared.md'))));
    await writeFile(join(device2Dir, 'shared.md'), 'server update\n');
    await writeFile(
      join(device2Dir, '.obts', 'apply-journal.json'),
      `${JSON.stringify(
        {
          apply_id: 'apply_test_packed_target',
          operation_type: 'pull_apply',
          target_main: pulled.manifest.target_main,
          expected_prior_local_main: state.local_main,
          expected_prior_local_device_ref: state.server_device_ref,
          phase: 'verifying',
          affected_paths: ['shared.md'],
          preflight_sha256: { 'shared.md': preflightHash },
          recovery_bundle_id: 'rec_test_packed_target',
          last_completed_step: 'files_written',
          redacted_error_category: null
        },
        null,
        2
      )}\n`
    );

    const restartedPlugin = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrl,
      deviceName: 'journal-packed-device-2'
    });
    const internals = restartedPlugin as unknown as {
      git: { readBlob: (commit: string, path: string) => Promise<Buffer | null> };
    };
    const readBlob = internals.git.readBlob.bind(internals.git);
    let readBlobCalls = 0;
    internals.git.readBlob = async (commit, path) => {
      readBlobCalls += 1;
      return await readBlob(commit, path);
    };

    await restartedPlugin.initialize();

    expect(readBlobCalls).toBe(0);
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('server update\n');
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await restartedPlugin.readState()).toMatchObject({
      local_main: pulled.manifest.target_main,
      local_head: pulled.manifest.target_main,
      status_label: 'Synced',
      last_error_code: null
    });
  });

  it('recovers an interrupted directory-to-file replacement without treating the directory as a changed file', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'journal-directory-device-1', 'journal-directory-device-2');
    const state = await plugin2.readState();
    const token = await readDeviceToken(device2Dir);
    const transport = new TransportClient(baseUrl);
    const pulled = await transport.pull({
      vaultId: admin.vaultId,
      deviceId: state.device_id!,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    await new LocalGitEngine(device2Dir).importPack(pulled.packfile);
    await rm(join(device2Dir, 'shared.md'), { force: true });
    await mkdirp(join(device2Dir, 'shared.md'));
    await writeFile(join(device2Dir, 'shared.md', 'child.md'), 'preserved before replacement\n');
    const childHash = sha256(Buffer.from(await readFile(join(device2Dir, 'shared.md', 'child.md'))));
    await writeFile(
      join(device2Dir, '.obts', 'apply-journal.json'),
      `${JSON.stringify({
        apply_id: 'apply_test_directory_replay',
        operation_type: 'pull_apply',
        target_main: pulled.manifest.target_main,
        expected_prior_local_main: state.local_main,
        expected_prior_local_device_ref: state.server_device_ref,
        phase: 'recovery_bundle_written',
        affected_paths: ['shared.md', 'shared.md/child.md'],
        preflight_sha256: { 'shared.md': null, 'shared.md/child.md': childHash },
        recovery_bundle_id: 'rec_test_directory_replay',
        last_completed_step: 'recovery_bundle',
        redacted_error_category: null
      }, null, 2)}\n`
    );

    const restartedPlugin = new ObtsPluginClient(device2Dir, {
      serverUrl: baseUrl,
      deviceName: 'journal-directory-device-2'
    });
    await restartedPlugin.initialize();

    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('server update\n');
    expect(await exists(join(device2Dir, 'shared.md', 'child.md'))).toBe(false);
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
  });

  it('blocks destructive apply if recovery bundle creation fails', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'bundle-device-1', 'bundle-device-2');
    const internal = (plugin2 as unknown as { client: Record<string, (...args: unknown[]) => Promise<unknown>> }).client;
    internal.finalizeRecoveryBundle = async () => {
      throw new Error('simulated recovery storage failure');
    };

    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'recovery_bundle_failed' });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');
    expect(await exists(join(device2Dir, '.obts', 'apply.lock'))).toBe(false);
    const journal = JSON.parse(await readFile(join(device2Dir, '.obts', 'apply-journal.json'), 'utf8')) as {
      phase: string;
      redacted_error_category: string;
      recovery_bundle_id: string | null;
    };
    expect(journal).toMatchObject({
      phase: 'blocked_recovery',
      redacted_error_category: 'recovery_bundle_failed',
      recovery_bundle_id: null
    });
  });

  it('does not resume an apply that was explicitly blocked from destructive writes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'non-destructive-device-1', 'non-destructive-device-2');

    await expect(plugin2.pullAndApply({ allowDestructive: false })).rejects.toMatchObject({ code: 'unsafe_local_state' });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');
    expect(JSON.parse(await readFile(join(device2Dir, '.obts', 'apply-journal.json'), 'utf8'))).toMatchObject({
      phase: 'blocked_recovery',
      redacted_error_category: 'destructive_apply_not_allowed'
    });

    const restarted = new ObtsPluginClient(device2Dir, { serverUrl: baseUrl, deviceName: 'non-destructive-device-2' });
    await restarted.initialize();
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');
    expect(await restarted.readState()).toMatchObject({
      status_label: 'Unsafe local state',
      last_error_code: 'apply_journal_recovery_required'
    });
    expect(JSON.parse(await readFile(join(device2Dir, '.obts', 'apply-journal.json'), 'utf8'))).toMatchObject({
      phase: 'blocked_recovery',
      redacted_error_category: 'destructive_apply_not_allowed'
    });
  });

  it('defers destructive apply if an affected file changes after preflight', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'preflight-device-1', 'preflight-device-2');
    const internal = (plugin2 as unknown as { client: Record<string, (...args: unknown[]) => Promise<unknown>> }).client;
    const originalFinalizeRecoveryBundle = internal.finalizeRecoveryBundle!.bind(internal);
    internal.finalizeRecoveryBundle = async (...args: unknown[]) => {
      const bundleId = await originalFinalizeRecoveryBundle(...args);
      await writeFile(join(device2Dir, 'shared.md'), 'changed after preflight\n');
      return bundleId;
    };

    expect((await plugin2.syncOnce()).status).toBe('Ahead');
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('changed after preflight\n');
    expect(await exists(join(device2Dir, '.obts', 'apply.lock'))).toBe(false);
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
    expect(await plugin2.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });
  });

  it('writes recovery bundle snapshots, patches, local refs pack, and artifact checksums before apply', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'bundle-shape-device-1', 'bundle-shape-device-2');

    expect((await plugin2.syncOnce()).status).toBe('Synced');

    const bundleDir = await latestRecoveryBundle(device2Dir);
    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8')) as {
      operation_type: string;
      affected_paths: string[];
      checksum_manifest: string[];
    };
    expect(manifest).toMatchObject({
      operation_type: 'pull_apply',
      affected_paths: ['shared.md']
    });
    expect(manifest.checksum_manifest.some((entry) => entry.endsWith('  files/shared.md'))).toBe(true);
    expect(await readFile(join(bundleDir, 'files', 'shared.md'), 'utf8')).toBe('base\n');
    expect(await readFile(join(bundleDir, 'patches', 'shared.md.patch'), 'utf8')).toContain('+base');
    expect((await stat(join(bundleDir, 'git', 'local-refs.pack'))).size).toBe(0);
    const checksums = await readFile(join(bundleDir, 'checksums.sha256'), 'utf8');
    expect(checksums).toContain('  manifest.json');
    expect(checksums).toContain('  files/shared.md');
    expect(checksums).toContain('  patches/shared.md.patch');
    expect(checksums).toContain('  git/local-refs.pack');
  });

  it('preserves an empty folder created while remote files are being applied', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'directory-during-apply-device-1');
    const device2Dir = join(root, 'directory-during-apply-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'shared.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'directory-during-apply-device-1');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'directory-during-apply-device-2');

    await writeFile(join(device1Dir, 'shared.md'), 'remote update\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const internal = (plugin2 as unknown as { client: Record<string, any> }).client;
    const originalWriteTargetFiles = internal.writeTargetFilesFromJournal.bind(internal);
    internal.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await originalWriteTargetFiles(...args);
      await mkdirp(join(device2Dir, 'local-empty'));
    };

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    expect(await plugin2.readQueue()).toMatchObject({ status: 'idle', pending_commit: null });
    expect((await plugin1.syncOnce()).status).toBe('Synced');
    expect(await isDirectory(join(device1Dir, 'local-empty'))).toBe(true);
  });

  it('uses one pre-sync snapshot and one labelled post-apply preservation snapshot', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2 } = await preparePullApplyScenario(root, admin, 'scan-count-device-1', 'scan-count-device-2');
    const internal = (plugin2 as unknown as { client: Record<string, any> }).client;
    const originalCapture = internal.captureLocalFileSnapshot.bind(internal);
    const diagnosticPoints: string[] = [];
    let snapshotCount = 0;
    internal.captureLocalFileSnapshot = async (...args: unknown[]) => {
      snapshotCount += 1;
      return await originalCapture(...args);
    };
    internal.plugin.setOperationProgress = (_label: string, diagnosticPoint: string) => {
      diagnosticPoints.push(diagnosticPoint);
    };

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    expect(snapshotCount).toBe(2);
    expect(diagnosticPoints).toContain('local_snapshot');
    expect(diagnosticPoints).toContain('apply_verify');
  });

  it('rebuilds from server main and turns snapshot-only local edits into a recovery commit', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'rebuild-snapshot-device-1');
    const device2Dir = join(root, 'rebuild-snapshot-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'base.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');

    await writeFile(join(device2Dir, 'local-only.md'), 'preserve after rebuild\n');
    await writeFile(join(device1Dir, 'server-next.md'), 'server current\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const rebuilt = await plugin2.rebuildFromServerMain();
    expect(rebuilt).toMatchObject({
      status: 'Ahead',
      recoveryCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(await readFile(join(device2Dir, 'server-next.md'), 'utf8')).toBe('server current\n');
    expect(await readFile(join(device2Dir, 'local-only.md'), 'utf8')).toBe('preserve after rebuild\n');
    expect(await recoveryBundleContains(device2Dir, 'local-only.md')).toBe(true);

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    await plugin1.syncOnce();
    expect(await readFile(join(device1Dir, 'local-only.md'), 'utf8')).toBe('preserve after rebuild\n');
  });

  it('rebuilds from server main while preserving queued fast-forward local commits', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'rebuild-pending-device-1');
    const device2Dir = join(root, 'rebuild-pending-device-2');
    await mkdirp(device1Dir);
    await mkdirp(device2Dir);
    await writeFile(join(device1Dir, 'base.md'), 'base\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await plugin1.syncOnce({ confirmInitialImport: true });
    const plugin2 = await pairPlugin(admin, device2Dir, 'phone');

    await writeFile(join(device2Dir, 'phone-base.md'), 'phone device ref\n');
    expect((await plugin2.syncOnce()).status).toBe('Synced');
    const syncedState = await plugin2.readState();
    expect(syncedState.server_device_ref).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(device2Dir, 'pending.md'), 'queued pending history\n');
    const localGit = new LocalGitEngine(device2Dir);
    const pendingCommit = await localGit.createLocalCommit('obts: queued before rebuild');
    expect(pendingCommit).toMatch(/^[0-9a-f]{40}$/u);
    await writeQueueFile(device2Dir, {
      pending_commit: pendingCommit,
      expected_device_ref: syncedState.server_device_ref,
      status: 'queued_local',
      attempts: 1,
      updated_at: new Date().toISOString()
    });

    await writeFile(join(device1Dir, 'server-next.md'), 'server current\n');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const rebuilt = await plugin2.rebuildFromServerMain();
    expect(rebuilt).toMatchObject({
      status: 'Ahead',
      preservedPendingCommit: pendingCommit
    });
    expect(await exists(join(device2Dir, 'pending.md'))).toBe(false);
    expect(await plugin2.readQueue()).toMatchObject({
      pending_commit: pendingCommit,
      expected_device_ref: syncedState.server_device_ref,
      status: 'queued_local'
    });

    expect((await plugin2.syncOnce()).status).toBe('Synced');
    expect(await readFile(join(device2Dir, 'pending.md'), 'utf8')).toBe('queued pending history\n');
    await plugin1.syncOnce();
    expect(await readFile(join(device1Dir, 'pending.md'), 'utf8')).toBe('queued pending history\n');
  });

  it('blocks rebuild when queued same-device history is divergent', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'rebuild-divergent-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const pairedState = await plugin.readState();
    expect(pairedState.local_main).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'accepted.md'), 'accepted device history\n');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const syncedState = await plugin.readState();
    expect(syncedState.server_device_ref).toMatch(/^[0-9a-f]{40}$/u);

    const localGit = new LocalGitEngine(deviceDir);
    await localGit.setLocalHead(pairedState.local_main!);
    await writeFile(join(deviceDir, 'divergent.md'), 'divergent local history\n');
    const divergentCommit = await localGit.createLocalCommit('obts: divergent queued before rebuild');
    expect(divergentCommit).toMatch(/^[0-9a-f]{40}$/u);
    await writeQueueFile(deviceDir, {
      pending_commit: divergentCommit,
      expected_device_ref: syncedState.server_device_ref,
      status: 'queued_local',
      attempts: 1,
      updated_at: new Date().toISOString()
    });

    await expect(plugin.rebuildFromServerMain()).rejects.toMatchObject({ code: 'same_device_non_fast_forward' });
    expect(await exists(join(deviceDir, 'divergent.md'))).toBe(false);
    expect(await recoveryBundleContains(deviceDir, 'divergent.md')).toBe(true);
    expect(await plugin.readQueue()).toMatchObject({
      pending_commit: divergentCommit,
      status: 'blocked_recovery'
    });
    expect(await plugin.readState()).toMatchObject({
      status_label: 'Needs recovery',
      last_error_code: 'same_device_non_fast_forward'
    });
  });

  it('resumes merge evaluation when a retry finds the device ref already advanced', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'retry-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    expect(state.local_main).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'retry.md'), 'commit survived server restart\n');
    const localGit = new LocalGitEngine(deviceDir);
    const commit = await localGit.createLocalCommit('obts: retry test commit');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await localGit.createPackForCommit(commit!);
    const token = await readDeviceToken(deviceDir);
    const auth = await server.auth.authenticateDevice(`Bearer ${token}`, admin.vaultId);

    await server.git.importPack(admin.vaultId, packfile);
    await server.git.updateRef(admin.vaultId, auth.device.device_ref, commit!, null);
    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === auth.device.device_id);
      expect(device).toBeDefined();
      device!.device_ref_head = commit!;
      device!.status = 'ahead';
    });

    const result = await server.sync.pushDeviceCommit(
      auth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: auth.device.device_id,
        expected_device_ref: null,
        target_commit: commit!,
        packfile_sha256: sha256(packfile),
        packfile_bytes: packfile.byteLength,
        client_known_main: state.local_main
      },
      packfile
    );

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') {
      throw new Error(`Expected merge result, got ${result.status}`);
    }
    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(result.main);
    expect(await server.git.isAncestor(admin.vaultId, commit!, result.main)).toBe(true);
  });

  it('rejects attempts to adopt another device ref as the actor device cursor', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'adopt-ref-desktop');
    await mkdirp(desktopDir);
    await writeFile(join(desktopDir, 'desktop.md'), 'desktop\n');
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await desktop.syncOnce({ confirmInitialImport: true });
    const desktopState = await desktop.readState();
    expect(desktopState.server_device_ref).toMatch(/^[0-9a-f]{40}$/u);

    const phoneDir = join(root, 'adopt-ref-phone');
    const phone = await pairPlugin(admin, phoneDir, 'phone');
    await writeFile(join(phoneDir, 'phone.md'), 'phone\n');
    const phoneGit = new LocalGitEngine(phoneDir);
    const phoneCommit = await phoneGit.createLocalCommit('obts: phone proposal');
    expect(phoneCommit).toMatch(/^[0-9a-f]{40}$/u);
    const phonePack = await phoneGit.createPackForCommit(phoneCommit!);
    const phoneState = await phone.readState();
    const phoneAuth = await server.auth.authenticateDevice(`Bearer ${await readDeviceToken(phoneDir)}`, admin.vaultId);

    const rejected = await server.sync.pushDeviceCommit(
      phoneAuth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: phoneState.device_id!,
        expected_device_ref: desktopState.server_device_ref,
        target_commit: phoneCommit!,
        packfile_sha256: sha256(phonePack),
        packfile_bytes: phonePack.byteLength,
        client_known_main: phoneState.local_main,
        base_commit: phoneState.local_main
      },
      phonePack
    );
    expect(rejected).toMatchObject({ status: 'rejected', code: 'stale_device_ref' });
    const db = await server.store.snapshot();
    const phoneRow = db.devices.find((device) => device.device_id === phoneState.device_id);
    expect(phoneRow?.device_ref_head).toBeNull();
  });

  it('rejects untrusted proposal base commits without advancing refs', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'untrusted-base-device');
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    await writeFile(join(deviceDir, 'local.md'), 'local\n');
    const localGit = new LocalGitEngine(deviceDir);
    const commit = await localGit.createLocalCommit('obts: untrusted base test');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await localGit.createPackForCommit(commit!);
    const state = await plugin.readState();
    const auth = await server.auth.authenticateDevice(`Bearer ${await readDeviceToken(deviceDir)}`, admin.vaultId);

    const rejected = await server.sync.pushDeviceCommit(
      auth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id!,
        expected_device_ref: null,
        target_commit: commit!,
        packfile_sha256: sha256(packfile),
        packfile_bytes: packfile.byteLength,
        client_known_main: state.local_main,
        base_commit: '0123456789012345678901234567890123456789'
      },
      packfile
    );
    expect(rejected).toMatchObject({ status: 'rejected', code: 'untrusted_base_commit' });
    const db = await server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.device_ref_head).toBeNull();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(state.local_main);
  });

  it('keeps same-device non-fast-forward blocks active until recovery', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'non-fast-forward-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const pairedState = await plugin.readState();
    expect(pairedState.local_main).toMatch(/^[0-9a-f]{40}$/u);

    const localGit = new LocalGitEngine(deviceDir);
    const token = await readDeviceToken(deviceDir);
    const auth = await server.auth.authenticateDevice(`Bearer ${token}`, admin.vaultId);

    await writeFile(join(deviceDir, 'same-device.md'), 'first history\n');
    const firstCommit = await localGit.createLocalCommit('obts: first same-device history');
    expect(firstCommit).toMatch(/^[0-9a-f]{40}$/u);
    const firstPack = await localGit.createPackForCommit(firstCommit!);
    const firstPush = await server.sync.pushDeviceCommit(
      auth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: pairedState.device_id!,
        expected_device_ref: null,
        target_commit: firstCommit!,
        packfile_sha256: sha256(firstPack),
        packfile_bytes: firstPack.byteLength,
        client_known_main: pairedState.local_main
      },
      firstPack
    );
    expect(firstPush.status).toBe('merged');
    if (firstPush.status !== 'merged') {
      throw new Error(`Expected first same-device push to merge, got ${firstPush.status}`);
    }

    await localGit.setLocalHead(pairedState.local_main!);
    await writeFile(join(deviceDir, 'same-device.md'), 'divergent history\n');
    const divergentCommit = await localGit.createLocalCommit('obts: divergent same-device history');
    expect(divergentCommit).toMatch(/^[0-9a-f]{40}$/u);
    const divergentPack = await localGit.createPackForCommit(divergentCommit!);
    const rejected = await server.sync.pushDeviceCommit(
      auth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: pairedState.device_id!,
        expected_device_ref: firstPush.device_ref,
        target_commit: divergentCommit!,
        packfile_sha256: sha256(divergentPack),
        packfile_bytes: divergentPack.byteLength,
        client_known_main: firstPush.main
      },
      divergentPack
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      code: 'same_device_non_fast_forward'
    });
    let db = await server.store.snapshot();
    let device = db.devices.find((candidate) => candidate.device_id === pairedState.device_id);
    expect(device).toMatchObject({
      device_ref_head: firstPush.device_ref,
      status: 'blocked_recovery'
    });

    const emptyPack = Buffer.alloc(0);
    const retryCurrentRef = await server.sync.pushDeviceCommit(
      auth,
      {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: pairedState.device_id!,
        expected_device_ref: firstPush.device_ref,
        target_commit: firstPush.device_ref,
        packfile_sha256: sha256(emptyPack),
        packfile_bytes: 0,
        client_known_main: firstPush.main
      },
      emptyPack
    );
    expect(retryCurrentRef).toMatchObject({
      status: 'rejected',
      code: 'device_blocked'
    });
    db = await server.store.snapshot();
    device = db.devices.find((candidate) => candidate.device_id === pairedState.device_id);
    expect(device).toMatchObject({
      device_ref_head: firstPush.device_ref,
      status: 'blocked_recovery'
    });
  });

  it('resumes a multi-pack upload whose aggregate exceeds the legacy request limit', async () => {
    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'chunk-server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy',
      maxUploadBytes: 1_048_576,
      transferChunkBytes: 1_048_576,
      maxTransferBytes: 8_388_608
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const preflight = await fetch(`${baseUrl}/api/v1/vaults/example/sync/push-transfers/example/chunks/0`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-obts-chunk-sha256');

    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'resumable-large-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'chunked-laptop');
    const receiverDir = join(root, 'resumable-large-receiver');
    await mkdirp(receiverDir);
    const receiver = await pairPlugin(admin, receiverDir, 'chunked-phone');
    await writeFile(join(deviceDir, 'first.bin'), randomBytes(700_000));
    await writeFile(join(deviceDir, 'second.bin'), randomBytes(700_000));

    const internals = plugin as unknown as {
      transport: { putPushChunk: (...args: unknown[]) => Promise<unknown> };
    };
    const originalPut = internals.transport.putPushChunk.bind(internals.transport);
    let uploadedChunks = 0;
    internals.transport.putPushChunk = async (...args) => {
      await originalPut(...args);
      uploadedChunks += 1;
      throw new Error('simulated interruption after durable chunk receipt');
    };
    await expect(plugin.syncOnce()).rejects.toThrow('simulated interruption');
    expect(uploadedChunks).toBe(1);
    expect(await plugin.readQueue()).toMatchObject({ status: 'queued_local', attempts: 1 });

    const restarted = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'chunked-laptop' });
    await restarted.initialize();
    await expect(restarted.syncOnce()).resolves.toMatchObject({ status: 'Synced' });
    const transferEntries = await readdir(server.config.transferDir);
    expect(transferEntries).toHaveLength(1);
    const session = JSON.parse(await readFile(join(server.config.transferDir, transferEntries[0]!, 'session.json'), 'utf8')) as {
      status: string;
      total_bytes: number;
      receipts: unknown[];
    };
    expect(session).toMatchObject({ status: 'completed' });
    expect(session.total_bytes).toBeGreaterThan(server.config.maxUploadBytes);
    expect(session.receipts.length).toBeGreaterThan(1);

    const receiverTransport = (receiver as unknown as {
      transport: { pullChunk: (input: { cursor: number }) => Promise<unknown> };
    }).transport;
    const receiverPull = receiverTransport.pullChunk.bind(receiverTransport);
    let receiverCalls = 0;
    receiverTransport.pullChunk = async (input) => {
      receiverCalls += 1;
      if (receiverCalls === 2) throw new Error('simulated interruption after pull checkpoint');
      return await receiverPull(input);
    };
    await expect(receiver.syncOnce()).rejects.toThrow('simulated interruption');
    expect(JSON.parse(await readFile(join(receiverDir, '.obts', 'pull-transfer.json'), 'utf8'))).toMatchObject({ next_cursor: 1 });

    const restartedReceiver = new ObtsPluginClient(receiverDir, { serverUrl: baseUrl, deviceName: 'chunked-phone' });
    const restartedTransport = (restartedReceiver as unknown as {
      transport: { pullChunk: (input: { cursor: number }) => Promise<unknown> };
    }).transport;
    const restartedPull = restartedTransport.pullChunk.bind(restartedTransport);
    const resumedCursors: number[] = [];
    restartedTransport.pullChunk = async (input) => {
      resumedCursors.push(input.cursor);
      return await restartedPull(input);
    };
    await restartedReceiver.initialize();
    await expect(restartedReceiver.syncOnce()).resolves.toMatchObject({ status: 'Synced' });
    expect(resumedCursors[0]).toBe(1);
    expect(await readFile(join(receiverDir, 'first.bin'))).toEqual(await readFile(join(deviceDir, 'first.bin')));
    await expect(stat(join(receiverDir, '.obts', 'pull-transfer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts full-vault attachment uploads through normal device refs', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'full-sync-attachment-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);

    await writeFile(join(deviceDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const localGit = new LocalGitEngine(deviceDir);
    const commit = await localGit.createLocalCommit('obts: full-vault attachment');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await localGit.createPackForCommit(commit!);

    const transport = new TransportClient(baseUrl);
    const result = await transport.push({
      vaultId: admin.vaultId,
      deviceId: state.device_id!,
      deviceToken: token,
      manifest: {
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: state.device_id!,
        expected_device_ref: state.server_device_ref,
        target_commit: commit!,
        packfile_sha256: sha256(packfile),
        packfile_bytes: packfile.byteLength,
        client_known_main: state.local_main
      },
      packfile
    });
    expect(result.status).toBe('merged');

    const db = await server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.device_ref_head).toBe(commit);
    const main = db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    expect(main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await server.git.listTreePaths(admin.vaultId, main!)).toEqual(expect.arrayContaining(['photo.png']));
    expect(await server.git.commitExists(admin.vaultId, commit!)).toBe(true);
  });

  it('rejects excluded full-vault paths in the shared path policy', () => {
    expect(() => assertSyncableTreePaths(['.obsidian/cache'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['.obsidian/cache/cache.json'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['.obsidian/workspace.json'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['.obsidian/workspace-mobile.json'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['.obsidian/plugins/obts'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['.obsidian/plugins/obts/main.js'])).toThrow(PathPolicyViolation);
    expect(isSyncableVaultPath('.trash/deleted.md')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/hotkeys.json')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/app.json')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/snippets/theme.css')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/example/main.js')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/example/data.json')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/cache')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/cache/cache.json')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/workspace.json')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/plugins/obts')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/plugins/obts/main.js')).toBe(false);
  });

  it('rejects uploaded files larger than the configured byte limit before refs advance', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'large-file-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);

    const content = Buffer.from(`# Big note\n\n${'a'.repeat(10_000)}\n`);
    await writeFile(join(deviceDir, 'big.md'), content);
    const localGit = new LocalGitEngine(deviceDir);
    const commit = await localGit.createLocalCommit('obts: oversized file');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await localGit.createPackForCommit(commit!);
    expect(packfile.byteLength).toBeLessThan(content.byteLength);
    (server.sync as unknown as { maxUploadBytes: number }).maxUploadBytes = packfile.byteLength + 1;

    const transport = new TransportClient(baseUrl);
    await expect(
      transport.push({
        vaultId: admin.vaultId,
        deviceId: state.device_id!,
        deviceToken: token,
        manifest: {
          api_version: API_VERSION,
          vault_id: admin.vaultId,
          device_id: state.device_id!,
          expected_device_ref: state.server_device_ref,
          target_commit: commit!,
          packfile_sha256: sha256(packfile),
          packfile_bytes: packfile.byteLength,
          client_known_main: state.local_main
        },
        packfile
      })
    ).rejects.toMatchObject({ status: 409, code: 'file_too_large' });

    const db = await server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.device_ref_head).toBeNull();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(state.local_main);
  });

  it('materializes full-vault content while excluding cache, workspace, and obts plugin files', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fullDeviceDir = join(root, 'full-sync-device');
    const secondDeviceDir = join(root, 'second-full-sync-device');
    await mkdirp(fullDeviceDir);
    await mkdirp(join(fullDeviceDir, '.obsidian', 'plugins', 'example'));
    await mkdirp(join(fullDeviceDir, '.obsidian', 'plugins', 'obts'));
    await mkdirp(join(fullDeviceDir, '.obsidian', 'cache'));
    await mkdirp(join(fullDeviceDir, '.trash'));
    await mkdirp(secondDeviceDir);
    await writeFile(join(fullDeviceDir, 'note.md'), '# Note\n');
    await writeFile(join(fullDeviceDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(fullDeviceDir, '.obsidian', 'plugins', 'example', 'main.js'), 'module.exports = {};\n');
    await writeFile(join(fullDeviceDir, '.obsidian', 'plugins', 'obts', 'main.js'), 'excluded self plugin\n');
    await writeFile(join(fullDeviceDir, '.obsidian', 'cache', 'cache.json'), '{}\n');
    await writeFile(join(fullDeviceDir, '.obsidian', 'workspace.json'), '{}\n');
    await writeFile(join(fullDeviceDir, '.trash', 'deleted.md'), 'trash syncs\n');

    const firstPlugin = await pairPlugin(admin, fullDeviceDir, 'desktop');
    expect((await firstPlugin.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');

    const secondPlugin = await pairPlugin(admin, secondDeviceDir, 'phone');
    expect(await readFile(join(secondDeviceDir, 'note.md'), 'utf8')).toBe('# Note\n');
    expect(await readFile(join(secondDeviceDir, 'photo.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await readFile(join(secondDeviceDir, '.obsidian', 'plugins', 'example', 'main.js'), 'utf8')).toBe('module.exports = {};\n');
    expect(await readFile(join(secondDeviceDir, '.trash', 'deleted.md'), 'utf8')).toBe('trash syncs\n');
    expect(await exists(join(secondDeviceDir, '.obsidian', 'plugins', 'obts', 'main.js'))).toBe(false);
    expect(await exists(join(secondDeviceDir, '.obsidian', 'cache', 'cache.json'))).toBe(false);
    expect(await exists(join(secondDeviceDir, '.obsidian', 'workspace.json'))).toBe(false);

    await writeFile(join(secondDeviceDir, 'phone.md'), 'full-sync change\n');
    expect((await secondPlugin.syncOnce()).status).toBe('Synced');

    const main = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    expect(main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await server.git.listTreePaths(admin.vaultId, main!)).toEqual(
      expect.arrayContaining(['note.md', 'phone.md', 'photo.png', '.obsidian/plugins/example/main.js', '.trash/deleted.md'])
    );
    expect(await server.git.listTreePaths(admin.vaultId, main!)).not.toEqual(
      expect.arrayContaining([
        '.obsidian/plugins/obts/main.js',
        '.obsidian/cache/cache.json',
        '.obsidian/workspace.json'
      ])
    );
  });

  it('rejects non-regular Git tree entries before they can be synced', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const repo = server.git.repoPath(admin.vaultId);
    const blob = asText((await server.git.exec(repo, ['hash-object', '-w', '--stdin'], Buffer.from('target.md'))).stdout);
    const tree = asText(
      (await server.git.exec(repo, ['mktree'], Buffer.from(`120000 blob ${blob.trim()}\tlink.md\n`))).stdout
    );
    const currentMain = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    expect(currentMain).toMatch(/^[0-9a-f]{40}$/u);
    const commit = asText(
      (
        await server.git.exec(
          repo,
          ['commit-tree', tree.trim(), '-p', currentMain!, '-m', 'malicious symlink tree'],
          undefined,
          {
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@obts.local',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@obts.local'
          }
        )
      ).stdout
    ).trim();

    await expect(server.git.validateTreePathPolicy(admin.vaultId, commit)).rejects.toMatchObject({
      code: 'unsupported_file_mode'
    });
  });

  it('allows case-distinct Obsidian paths on case-sensitive vault filesystems', async () => {
    const deviceDir = join(root, 'local-case-distinct-device');
    await mkdirp(join(deviceDir, 'Notes'));
    await mkdirp(join(deviceDir, 'notes'));
    await writeFile(join(deviceDir, 'Notes', 'A.md'), 'upper\n');
    await writeFile(join(deviceDir, 'notes', 'a.md'), 'lower\n');
    const localGit = new LocalGitEngine(deviceDir);
    await localGit.initialize();

    const commit = await localGit.createLocalCommit('obts: case-distinct paths');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await localGit.listTreeFiles(commit!)).toEqual(['Notes/A.md', 'notes/a.md']);
  });

  it('blocks local scans when visible Git directories are present', async () => {
    const deviceDir = join(root, 'visible-git-device');
    await mkdirp(join(deviceDir, '.git'));
    await writeFile(join(deviceDir, '.git', 'config'), '[core]\n');
    const localGit = new LocalGitEngine(deviceDir);
    await localGit.initialize();

    await expect(localGit.createLocalCommit('obts: visible git')).rejects.toMatchObject({
      code: 'excluded_git_path'
    });
  });

  it('creates incremental upload packs against known server/device bases', async () => {
    const deviceDir = join(root, 'incremental-pack-device');
    await mkdirp(join(deviceDir, 'base'));
    const localGit = new LocalGitEngine(deviceDir);
    await localGit.initialize();
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(deviceDir, 'base', `note-${index}.md`), `base ${index}\n`);
    }
    const baseCommit = await localGit.createLocalCommit('obts: base pack content');
    expect(baseCommit).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'delta.md'), 'delta\n');
    const deltaCommit = await localGit.createLocalCommit('obts: delta pack content');
    expect(deltaCommit).toMatch(/^[0-9a-f]{40}$/u);
    const fullPack = await localGit.createPackForCommit(deltaCommit!);
    const incrementalPack = await localGit.createPackForCommit(deltaCommit!, [baseCommit!]);
    expect(incrementalPack.byteLength).toBeLessThan(fullPack.byteLength);
  });

  it('detects rapid same-size local edits by staged content instead of timestamps', async () => {
    const deviceDir = join(root, 'rapid-edit-device');
    await mkdirp(deviceDir);
    const localGit = new LocalGitEngine(deviceDir);
    await localGit.initialize();

    await writeFile(join(deviceDir, 'library.base'), 'a: 1\n');
    const firstCommit = await localGit.createLocalCommit('obts: first same-size edit');
    expect(firstCommit).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'library.base'), 'a: 2\n');
    const secondCommit = await localGit.createLocalCommit('obts: second same-size edit');
    expect(secondCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(secondCommit).not.toBe(firstCommit);
  });

  it('serves the Phase 2 browser dashboard shell', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app"></div>');
  });

  it('ships an installable Obsidian plugin with Phase 1 sync behavior', async () => {
    const pluginMain = await readFile(join(process.cwd(), 'obsidian-plugin', 'src', 'main.cjs'), 'utf8');
    const pluginReadme = await readFile(join(process.cwd(), 'obsidian-plugin', 'README.md'), 'utf8');

    expect(pluginMain).toContain('class ObtsObsidianClient');
    expect(pluginMain).toContain('/api/v1/connections');
    expect(pluginMain).not.toContain('/api/v1/pair/consume');
    expect(pluginMain).toContain('/sync/push');
    expect(pluginMain).toContain('/sync/pull');
    expect(pluginMain).toContain('refs/heads/local');
    expect(pluginMain).toContain('refs/heads/main');
    expect(pluginMain).toContain('apply-journal.json');
    expect(pluginMain).toContain('directory-state.json');
    expect(pluginMain).toContain('createRecoveryBundle');
    expect(pluginMain).toContain('rebuildFromServerMain');
    expect(pluginMain).toContain('obts-rebuild-from-server-main');
    expect(pluginMain).toContain('classifyPendingCommit');
    expect(pluginMain).toContain('partial_local_state');
    expect(pluginMain).toContain('materializationConflictFiles');
    expect(pluginMain).toContain('removeBlockingMaterializationPaths');
    expect(pluginMain).toContain('checksums.sha256');
    expect(pluginMain).toContain('writeTextSnapshotPatch');
    expect(pluginMain).toContain('this.app.vault.on("modify"');
    expect(pluginMain).toContain('adapter.writeBinary');
    expect(pluginMain).toContain('BACKGROUND_SYNC_INTERVAL_MS = 10 * 1000');
    expect(pluginMain).toContain('PERIODIC_FULL_SCAN_INTERVAL_MS = 5 * 60 * 1000');
    expect(pluginMain).toContain('runBackgroundSync()');
    expect(pluginMain).toContain('runRemotePoll()');
    expect(pluginMain).toContain('runAutomaticSync()');
    expect(pluginMain).toContain('flushOpenMarkdownEditorsToDisk');
    expect(pluginMain).toContain('ensureNoLocalChangesBeforeApply');
    expect(pluginMain).toContain('visibleVaultMatchesLocalHead');
    const queuedSync = sourceSection(pluginMain, 'async runQueuedSync()', 'async flushOpenMarkdownEditorsToDisk()');
    expect(queuedSync).toContain('if (this.isSyncInProgress())');
    expect(queuedSync).toContain('this.scheduleQueuedSync(SYNC_DEBOUNCE_MS)');
    expect(pluginMain).toContain('syncOnceOrPollResolvedConflict');
    const backgroundSync = sourceSection(pluginMain, 'async runBackgroundSync()', 'async runAutomaticSync()');
    expect(backgroundSync).toContain('isRetryableLocalError(state.last_error_code)');
    expect(backgroundSync).toContain('await this.runAutomaticSync();');
    expect(backgroundSync).toContain('await this.runRemotePoll();');
    expect(backgroundSync).toContain('fullScanDue');
    const automaticSync = sourceSection(pluginMain, 'async runAutomaticSync()', 'async handleAutomaticSyncError');
    expect(automaticSync).toContain('readPendingOnboarding()');
    expect(automaticSync).toContain('syncOnceOrPollResolvedConflict');
    expect(pluginMain).toContain('OPERATION_STATUS_HEARTBEAT_MS');
    expect(pluginMain).not.toContain('SYNC_STALE_MS');
    expect(pluginMain).toContain('ensureNoQueuedLocalChangesBeforeApply');
    expect(pluginMain).toContain('fetchWithTimeout');
    const eventPoll = sourceSection(pluginMain, 'async pollRemoteEventsAndApply()', 'async unpairCurrentDevice()');
    expect(eventPoll).toContain('wasConflictBlocked');
    expect(eventPoll).toContain('if (!wasConflictBlocked)');
    expect(eventPoll).toContain('event.event_type === "conflict_resolved"');
    expect(eventPoll).toContain('last_error_code: null');
    expect(pluginMain).toContain('pollRemoteEventsAndApply()');
    expect(pluginMain).toContain('/sync/events?after=');
    expect(pluginMain).toContain('/sync/device-status');
    expect(pluginMain).toContain('this.setStatus("Offline")');
    expect(pluginMain).toContain('statusPresentation');
    expect(pluginMain).toContain('statusAttentionMessage');
    expect(pluginMain).toContain('shouldShowRoutineStatusNotice');
    expect(pluginMain).toContain('handleStatusClick');
    expect(pluginMain).toContain('addRibbonIcon');
    expect(pluginMain).toContain('scheduleDegradedStatusNotice');
    expect(pluginMain).toContain('Checking ${completed}/${total}');
    expect(pluginMain).toContain('Uploading ${uploadedChunks}/${groups.length}');
    expect(pluginMain).toContain('Applying ${completed}/${total}');
    expect(pluginMain).toContain('obts-settings-section-header');
    expect(pluginMain).toContain('obts-status-pill');
    expect(pluginMain).toContain('obts-feedback');
    expect(pluginMain).toContain('class ObtsOnboardingModal');
    expect(pluginMain).toContain('setButtonText("Set up sync")');
    expect(pluginMain).toContain('Continue in browser');
    expect(pluginMain).toContain('setButtonText("Resume setup")');
    expect(pluginMain).toContain('Resolve the conflict, then return here');
    expect(pluginMain).toContain('Do not submit the merge again.');
    expect(pluginMain).toContain('resumeAcceptedOnboarding');
    expect(pluginMain).toContain('onboarding_local_changes_after_submit');
    expect(pluginMain).toContain('operationAvailability()');
    expect(pluginMain).toContain('runExclusiveAction');
    expect(pluginMain).toContain('this.lifecycleAbortController.abort()');
    expect(pluginMain).toContain('this.cancelled || this.plugin.unloaded');
    expect(pluginMain).toContain('Fully restart Obsidian before continuing setup or sync.');
    expect(pluginMain).toContain('setButtonText("Sync now")');
    expect(pluginMain).toContain('setButtonText("Unpair...")');
    expect(pluginMain).toContain('setWarning');
    expect(pluginMain).toContain('/sync/unpair');
    expect(pluginMain).not.toContain('settings.pairingToken =');
    expect(pluginMain).toContain('device_name: this.plugin.settings.deviceName || "Obsidian device"');
    expect(pluginMain).toContain('async renameCurrentDevice(deviceName)');
    expect(pluginMain).toContain('method: "PATCH"');
    expect(pluginMain).toContain('await this.applyServerDeviceName(result.device_name, false)');
    expect(pluginMain).toContain('setButtonText("Save name")');
    expect(pluginMain).toContain('throwIfSyncBlocked(state)');
    expect(pluginMain).toContain('state.last_error_code === "replace_local_with_server_required"');
    expect(pluginMain).not.toContain('Automatic sync');
    expect(pluginMain).not.toContain('autoSync');
    expect(pluginMain).not.toContain('throwIfBlocked(state)');
    expect(pluginMain).not.toContain('Sync is blocked until recovery or review completes.');
    expect(pluginMain).not.toContain('packaged TypeScript client');
    expect(pluginMain).not.toContain('Run the packaged client sync flow');

    expect(pluginReadme).toContain('hidden local history under');
    expect(pluginReadme).toContain('`.obts/git`');
    expect(pluginReadme).toContain('Rebuild from server main');
    expect(pluginReadme).toContain('No visible vault `.git` directory is created.');
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
    const otherPlugin = new ObtsPluginClient(otherDir, {
      serverUrl: baseUrl,
      deviceName: 'other-device',
    });
    await onboardExistingVault(other, otherPlugin, otherVault.body.vault_id);
    const otherPluginState = await otherPlugin.readState();
    const otherTokenFile = JSON.parse(await readFile(join(otherDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as {
      device_token: string;
    };

    for (const path of [
      `/api/v1/vaults/${admin.vaultId}/main`,
      `/api/v1/vaults/${admin.vaultId}/dashboard`,
      `/api/v1/vaults/${admin.vaultId}/conflicts?status=open`,
      `/api/v1/vaults/${admin.vaultId}/events`
    ]) {
      const response = await other.get<{ error: { code: string } }>(path);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    }

    const crossUserVaultRename = await other.patch<{ error: { code: string } }>(`/api/v1/vaults/${admin.vaultId}`, {
      display_name: 'Not mine'
    });
    expect(crossUserVaultRename.status).toBe(404);
    expect(crossUserVaultRename.body.error.code).toBe('not_found');
    const crossUserDeviceRename = await other.patch<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/devices/${otherPluginState.device_id}`,
      { device_name: 'Not mine either' }
    );
    expect(crossUserDeviceRename.status).toBe(404);
    expect(crossUserDeviceRename.body.error.code).toBe('not_found');

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: otherPluginState.device_id,
        current_local_main: null,
        requested_target: 'latest'
      })
    );
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const syncResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/pull`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherTokenFile.device_token}`
      },
      body: form
    });
    expect(syncResponse.status).toBe(404);
    const syncBody = (await syncResponse.json()) as { error: { code: string } };
    expect(syncBody.error.code).toBe('not_found');

    const eventResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/events?after=0`, {
      headers: {
        authorization: `Bearer ${otherTokenFile.device_token}`
      }
    });
    expect(eventResponse.status).toBe(404);
    const eventBody = (await eventResponse.json()) as { error: { code: string } };
    expect(eventBody.error.code).toBe('not_found');

    const pushForm = new FormData();
    const emptyPackfile = Buffer.alloc(0);
    pushForm.append(
      'manifest',
      JSON.stringify({
        api_version: API_VERSION,
        vault_id: admin.vaultId,
        device_id: otherPluginState.device_id,
        expected_device_ref: null,
        target_commit: otherPluginState.local_main,
        packfile_sha256: sha256(emptyPackfile),
        packfile_bytes: emptyPackfile.byteLength,
        client_known_main: otherPluginState.local_main
      })
    );
    pushForm.append('packfile', new Blob([emptyPackfile], { type: 'application/x-git-packed-objects' }), 'push.pack');
    const pushResponse = await fetch(`${baseUrl}/api/v1/vaults/${admin.vaultId}/sync/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherTokenFile.device_token}`
      },
      body: pushForm
    });
    expect(pushResponse.status).toBe(404);
    const pushBody = (await pushResponse.json()) as { error: { code: string } };
    expect(pushBody.error.code).toBe('not_found');
  });

  it('rejects internal and visible Git paths in the shared path policy', () => {
    expect(() => assertSyncableTreePaths(['notes/a.md', '.obts/state.json'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['notes/a.md', '.git/config'])).toThrow(PathPolicyViolation);
    expect(() => assertSyncableTreePaths(['Notes/A.md', 'notes/a.md'])).not.toThrow();
    expect(normalizeVaultPath('notes//a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/../a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/./a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/bad:name.md').ok).toBe(true);
    expect(normalizeVaultPath('notes/trailing.').ok).toBe(true);
    expect(normalizeVaultPath('Projects/Launch Plan -> Checklist.md').ok).toBe(true);
    expect(normalizeVaultPath('Notes/can local tooling connect to docker on a remote host?.md').ok).toBe(true);
  });

  it('syncs the full vault except hard exclusions', () => {
    expect(isSyncableVaultPath('notes/readme.md')).toBe(true);
    expect(isSyncableVaultPath('attachments/photo.png')).toBe(true);
    expect(isSyncableVaultPath('.trash/deleted.md')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/readme.md')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/app.json')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/snippets/theme.css')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/example/main.js')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/example/data.json')).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/obts')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/plugins/obts/main.js')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/cache')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/cache/cache.json')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/workspace.json')).toBe(false);
    expect(isSyncableVaultPath('.obsidian/workspace-mobile.json')).toBe(false);
  });

  it('serializes metadata snapshots behind in-flight mutations', async () => {
    const store = new MetadataStore(join(root, 'snapshot-serialization'));
    await store.initialize();
    let releaseMutation!: () => void;
    const mutationCanFinish = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });

    const mutation = store.mutate(async (db) => {
      db.setup_complete = true;
      await mutationCanFinish;
    });
    let snapshotResolved = false;
    const snapshot = store.snapshot().then((db) => {
      snapshotResolved = true;
      return db;
    });

    await sleep(10);
    expect(snapshotResolved).toBe(false);
    releaseMutation();
    await mutation;
    expect((await snapshot).setup_complete).toBe(true);
  });
});

async function prepareStructuralMergeDevices(
  root: string,
  admin: BrowserSession & { vaultId: string },
  prefix: string
): Promise<{
  desktop: ObtsPluginClient;
  desktopDir: string;
  tablet: ObtsPluginClient;
  tabletDir: string;
}> {
  const desktopDir = join(root, `${prefix}-desktop`);
  const tabletDir = join(root, `${prefix}-tablet`);
  await mkdirp(desktopDir);
  await mkdirp(tabletDir);

  const desktop = await pairPlugin(admin, desktopDir, `${prefix}-desktop`);
  await writeFile(join(desktopDir, 'Old.md'), 'base\n');
  expect((await desktop.syncOnce()).status).toBe('Synced');

  const tablet = await pairPlugin(admin, tabletDir, `${prefix}-tablet`);
  expect(await readFile(join(tabletDir, 'Old.md'), 'utf8')).toBe('base\n');
  await writeFile(join(tabletDir, `${prefix}-tablet-ref.md`), 'tablet ref\n');
  expect((await tablet.syncOnce()).status).toBe('Synced');
  expect((await desktop.syncOnce()).status).toBe('Synced');
  expect(await readFile(join(desktopDir, `${prefix}-tablet-ref.md`), 'utf8')).toBe('tablet ref\n');

  return { desktop, desktopDir, tablet, tabletDir };
}

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
  const plugin = new ObtsPluginClient(vaultDir, {
    serverUrl: baseUrlFromAdmin(admin),
    deviceName
  });
  await onboardExistingVault(admin, plugin, admin.vaultId);
  return plugin;
}

async function onboardExistingVault(
  admin: BrowserSession,
  plugin: ObtsPluginClient,
  vaultId: string,
  selectedMode?: 'use_server' | 'merge'
): Promise<{ status: string; main?: string; conflictId?: string }> {
  const connection = await plugin.startOnboarding('Test Vault');
  const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
    selection: 'existing_vault',
    vault_id: vaultId
  });
  expect(approval.status).toBe(200);
  const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  const mode = selectedMode ?? (
    analysis.classification === 'independent_divergent' || analysis.classification === 'shared_baseline_divergent'
      ? 'merge'
      : 'use_server'
  );
  return await plugin.finishOnboarding({
    connectionId: connection.connection_id,
    secret: connection.connection_secret,
    analysis,
    mode
  });
}

async function preparePullApplyScenario(
  root: string,
  admin: BrowserSession & { vaultId: string },
  device1Name: string,
  device2Name: string
): Promise<{ plugin2: ObtsPluginClient; device2Dir: string }> {
  const device1Dir = join(root, device1Name);
  const device2Dir = join(root, device2Name);
  await mkdirp(device1Dir);
  await mkdirp(device2Dir);
  await writeFile(join(device1Dir, 'shared.md'), 'base\n');
  const plugin1 = await pairPlugin(admin, device1Dir, device1Name);
  await plugin1.syncOnce({ confirmInitialImport: true });

  const plugin2 = await pairPlugin(admin, device2Dir, device2Name);
  expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');

  await writeFile(join(device1Dir, 'shared.md'), 'server update\n');
  expect((await plugin1.syncOnce()).status).toBe('Synced');
  return { plugin2, device2Dir };
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function awaitState(plugin: ObtsPluginClient) {
  return await plugin.readState();
}

async function readDeviceToken(vaultDir: string): Promise<string> {
  const tokenFile = JSON.parse(await readFile(join(vaultDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as {
    device_token: string;
  };
  return tokenFile.device_token;
}

async function recoveryBundleContains(vaultDir: string, relativePath: string): Promise<boolean> {
  const recoveryDir = join(vaultDir, '.obts', 'recovery');
  for (const bundleId of await readdir(recoveryDir)) {
    if (await exists(join(recoveryDir, bundleId, 'files', relativePath))) {
      return true;
    }
  }
  return false;
}

async function latestRecoveryBundle(vaultDir: string): Promise<string> {
  const recoveryDir = join(vaultDir, '.obts', 'recovery');
  const bundleIds = await readdir(recoveryDir);
  if (bundleIds.length === 0) {
    throw new Error('Expected at least one recovery bundle.');
  }
  const bundles = await Promise.all(
    bundleIds.map(async (bundleId) => ({
      bundleId,
      mtimeMs: (await stat(join(recoveryDir, bundleId))).mtimeMs
    }))
  );
  bundles.sort((left, right) => right.mtimeMs - left.mtimeMs || right.bundleId.localeCompare(left.bundleId));
  return join(recoveryDir, bundles[0]!.bundleId);
}

async function writeQueueFile(vaultDir: string, queue: Json): Promise<void> {
  await writeFile(join(vaultDir, '.obts', 'queue.json'), `${JSON.stringify(queue, null, 2)}\n`);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mobileMultipartBody(
  manifest: Record<string, unknown> | string,
  packfile: Buffer,
  packFilename: string
): { contentType: string; body: Buffer } {
  const boundary = '----obts-mobile-contract-test';
  const manifestText = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(manifestText),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="${packFilename}"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      packfile,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function asText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
