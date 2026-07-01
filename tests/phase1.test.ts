import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient, PluginBlockedError } from '../src/plugin/client.js';
import { LocalGitEngine } from '../src/plugin/localGit.js';
import { TransportClient } from '../src/plugin/transport.js';
import { runCli } from '../src/cli.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { MetadataStore } from '../src/server/metadataStore.js';
import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  PathPolicyViolation
} from '../src/shared/pathPolicy.js';
import { API_VERSION, type SyncProfile } from '../src/shared/types.js';

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

  it('supports Phase 1 CLI setup, vault, pairing, devices, conflicts, health, and local admin recovery', async () => {
    await server.app.close();
    const cliDataDir = join(root, 'cli-server-data');
    const env = {
      OBTS_DATA_DIR: cliDataDir,
      OBTS_PUBLIC_BASE_URL: 'http://sync.example.test',
      OBTS_SESSION_SECRET: 'cli-test-session-secret-with-enough-entropy'
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
      '--password',
      'admin-password-1234',
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
      '--password',
      'admin-password-1234',
      '--display-name',
      'CLI Vault',
      '--json'
    ]);
    expect(vault).toMatchObject({ code: 0, stderr: '' });
    const vaultBody = JSON.parse(vault.stdout) as { vault_id: string; current_main: string };
    expect(vaultBody.current_main).toMatch(/^[0-9a-f]{40}$/u);

    const pairing = await run([
      'pairing-token',
      'create',
      '--username',
      'admin',
      '--password',
      'admin-password-1234',
      '--vault-id',
      vaultBody.vault_id,
      '--device-name',
      'cli-laptop',
      '--sync-profile',
      'notes_only',
      '--json'
    ]);
    expect(pairing).toMatchObject({ code: 0, stderr: '' });
    const pairingBody = JSON.parse(pairing.stdout) as { pairing_token: string; pairing_url: string };
    expect(pairingBody.pairing_token).toMatch(/^obts_pair_/u);
    expect(pairingBody.pairing_url).toContain(encodeURIComponent(pairingBody.pairing_token));

    const cliServer = await createObtsServer({
      dataDir: cliDataDir,
      publicBaseUrl: 'http://sync.example.test',
      sessionSecret: 'cli-test-session-secret-with-enough-entropy'
    });
    try {
      await cliServer.auth.consumePairingToken({
        pairingToken: pairingBody.pairing_token,
        deviceName: 'cli-laptop',
        syncProfile: 'notes_only',
        syncPlugins: false
      });
      const db = await cliServer.store.snapshot();
      const device = db.devices.find((candidate) => candidate.vault_id === vaultBody.vault_id);
      expect(device).toBeDefined();
      await cliServer.store.mutate((mutableDb) => {
        mutableDb.conflicts.push({
          conflict_id: 'conf_cli_test',
          vault_id: vaultBody.vault_id,
          device_id: device!.device_id,
          status: 'open',
          base_commit: vaultBody.current_main,
          current_main: vaultBody.current_main,
          device_commit: vaultBody.current_main,
          expected_main: vaultBody.current_main,
          affected_paths: ['note.md'],
          affected_path_count: 1,
          merge_sequence: 1,
          merge_policy_version: 'phase1.disjoint-paths.v1',
          validator_results: { reason: 'test' },
          validator_summary: { decision: 'conflict' },
          created_at: new Date().toISOString()
        });
      });
    } finally {
      await cliServer.app.close();
    }

    const devices = await run([
      'devices',
      'list',
      '--username',
      'admin',
      '--password',
      'admin-password-1234',
      '--vault-id',
      vaultBody.vault_id,
      '--json'
    ]);
    expect(devices).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(devices.stdout)).toMatchObject({
      devices: [expect.objectContaining({ device_name: 'cli-laptop', status: 'paired' })]
    });

    const conflicts = await run([
      'conflicts',
      'list',
      '--username',
      'admin',
      '--password',
      'admin-password-1234',
      '--vault-id',
      vaultBody.vault_id,
      '--json'
    ]);
    expect(conflicts).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(conflicts.stdout)).toMatchObject({
      conflicts: [expect.objectContaining({ conflict_id: 'conf_cli_test', status: 'open' })]
    });

    const ready = await run(['health', 'ready', '--json']);
    expect(ready).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(ready.stdout)).toMatchObject({ status: 'ready' });

    const recovery = await run(['admin-recovery', 'create-reset-token', '--username', 'admin', '--json']);
    expect(recovery).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      username: 'admin',
      reset_token: expect.stringMatching(/^obts_reset_/u)
    });

    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
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

  it('records local watcher change hints durably and consumes them through normal sync', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'watcher-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');

    await writeFile(join(deviceDir, 'watched.md'), 'from watcher\n');
    await plugin.recordLocalChangeHint(['watched.md', '.obts/state.json', '.git/config', '../outside.md']);
    expect(await plugin.readState()).toMatchObject({
      status_label: 'Ahead',
      last_error_code: null
    });
    expect(await plugin.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });

    const restartedPlugin = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrl,
      deviceName: 'laptop',
      syncProfile: 'notes_only',
      syncPlugins: false
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
    const localGit = new LocalGitEngine(device2Dir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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

  it('marks an active device synced when it acknowledges the current main after a recovered ahead state', async () => {
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
    const pairing = await owner.post<{ pairing_token: string }>(`/api/v1/vaults/${ownerVault.body.vault_id}/pairing-tokens`, {
      device_name: 'phone',
      sync_profile: 'notes_only'
    });
    expect(pairing.status).toBe(201);

    const deviceDir = join(root, 'disabled-user-device');
    await mkdirp(deviceDir);
    const plugin = new ObtsPluginClient(deviceDir, {
      serverUrl: baseUrl,
      deviceName: 'phone',
      syncProfile: 'notes_only',
      syncPlugins: false
    });
    await plugin.pairWithToken(pairing.body.pairing_token);
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
  });

  it('rejects malformed commit identifiers in multipart sync manifests', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'invalid-manifest-device');
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
        expected_device_ref: state.server_device_ref,
        target_commit: 'refs/heads/main',
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

  it('enforces pairing token scope and one-time consumption', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
      device_name: 'phone',
      sync_profile: 'notes_plus_attachments'
    });
    expect(pairing.status).toBe(201);

    const wrongProfile = await fetch(`${baseUrl}/api/v1/pair/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_token: pairing.body.pairing_token,
        device_name: 'phone',
        sync_profile: 'notes_only',
        sync_plugins: false
      })
    });
    expect(wrongProfile.status).toBe(401);
    const persistedAfterWrongProfile = JSON.parse(
      await readFile(join(root, 'server-data', 'metadata', 'phase1.json'), 'utf8')
    ) as { tokens: Array<{ kind: string; failed_attempts: number; consumed_at: string | null }> };
    const persistedPairing = persistedAfterWrongProfile.tokens.find((token) => token.kind === 'pairing');
    expect(persistedPairing).toMatchObject({
      failed_attempts: 1,
      consumed_at: null
    });

    const consumed = await fetch(`${baseUrl}/api/v1/pair/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_token: pairing.body.pairing_token,
        device_name: 'phone',
        sync_profile: 'notes_plus_attachments',
        sync_plugins: false
      })
    });
    expect(consumed.status).toBe(201);
    expect(((await consumed.json()) as { device_id: string }).device_id).toMatch(/^dev_/u);

    const replay = await fetch(`${baseUrl}/api/v1/pair/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_token: pairing.body.pairing_token,
        device_name: 'phone',
        sync_profile: 'notes_plus_attachments',
        sync_plugins: false
      })
    });
    expect(replay.status).toBe(401);

    const db = await server.store.snapshot();
    const pairingTokenRows = db.tokens.filter((token) => token.kind === 'pairing');
    expect(pairingTokenRows).toHaveLength(1);
    expect(pairingTokenRows[0]?.consumed_at).toEqual(expect.any(String));
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
      merge_policy_version: 'phase1.disjoint-paths.v1',
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
      merge_policy_version: 'phase1.disjoint-paths.v1',
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

    const plugin1 = await pairPluginWithProfile(admin, device1Dir, 'desktop', 'notes_plus_attachments');
    const plugin2 = await pairPluginWithProfile(admin, device2Dir, 'tablet', 'notes_plus_attachments');
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
    const dashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; behind_main: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.devices.find((device) => device.device_name === 'phone')).toMatchObject({
      status_label: 'Synced',
      behind_main: false
    });
    expect((await plugin2.syncOnce()).status).toBe('Synced');
  });

  it('recovers and replaces local file-directory collisions during replace-local-with-server', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'replace-collision-device-1');
    await mkdirp(device1Dir);
    await writeFile(join(device1Dir, 'topic.md'), 'server file wins\n');
    const plugin1 = await pairPlugin(admin, device1Dir, 'desktop');
    await expect(plugin1.syncOnce()).rejects.toMatchObject({ code: 'initial_import_confirmation_required' });
    await plugin1.syncOnce({ confirmInitialImport: true });

    const device2Dir = join(root, 'replace-collision-device-2');
    await mkdirp(join(device2Dir, 'topic.md'));
    await writeFile(join(device2Dir, 'topic.md', 'child.md'), 'local directory content\n');
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
    const replaced = await plugin2.replaceLocalWithServer();
    expect(replaced.status).toBe('Synced');
    expect(await readFile(join(device2Dir, 'topic.md'), 'utf8')).toBe('server file wins\n');
    expect(await exists(join(device2Dir, 'topic.md', 'child.md'))).toBe(false);
    expect(await recoveryBundleContains(device2Dir, 'topic.md/child.md')).toBe(true);
  });

  it('blocks additional-device local content even when server main is still empty', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const device1Dir = join(root, 'empty-server-device-1');
    await mkdirp(device1Dir);
    const plugin1 = await pairPlugin(admin, device1Dir, 'empty-desktop');
    expect((await plugin1.syncOnce()).status).toBe('Synced');

    const device2Dir = join(root, 'empty-server-device-2');
    await mkdirp(device2Dir);
    await writeFile(join(device2Dir, 'local-only.md'), 'should not become initial import\n');
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
    expect(await readFile(join(device2Dir, 'local-only.md'), 'utf8')).toBe('should not become initial import\n');
    expect((await readdir(join(device2Dir, '.obts', 'recovery'))).length).toBeGreaterThan(0);
    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'replace_local_with_server_required' });

    const replaced = await plugin2.replaceLocalWithServer();
    expect(replaced.status).toBe('Synced');
    expect(await exists(join(device2Dir, 'local-only.md'))).toBe(false);
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

  it('uses a local apply lock before applying pulled server changes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'lock-device-1', 'lock-device-2');
    await writeFile(join(device2Dir, '.obts', 'apply.lock'), '{"apply_id":"apply_existing"}\n');

    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'apply_lock_active' });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('base\n');
    expect((await plugin2.readState()).status_label).toBe('Unsafe local state');
    expect(await exists(join(device2Dir, '.obts', 'apply-journal.json'))).toBe(false);
  });

  it('blocks destructive apply if recovery bundle creation fails', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'bundle-device-1', 'bundle-device-2');
    const internal = plugin2 as unknown as { recovery: { createRecoveryBundle(input: unknown): Promise<string> } };
    internal.recovery.createRecoveryBundle = async () => {
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

  it('blocks destructive apply if an affected file changes after preflight', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { plugin2, device2Dir } = await preparePullApplyScenario(root, admin, 'preflight-device-1', 'preflight-device-2');
    const internal = plugin2 as unknown as { recovery: { createRecoveryBundle(input: unknown): Promise<string> } };
    const originalCreateRecoveryBundle = internal.recovery.createRecoveryBundle.bind(internal.recovery);
    internal.recovery.createRecoveryBundle = async (input: unknown) => {
      const bundleId = await originalCreateRecoveryBundle(input);
      await writeFile(join(device2Dir, 'shared.md'), 'changed after preflight\n');
      return bundleId;
    };

    await expect(plugin2.syncOnce()).rejects.toMatchObject({ code: 'unsafe_local_state' });
    expect(await readFile(join(device2Dir, 'shared.md'), 'utf8')).toBe('changed after preflight\n');
    expect(await exists(join(device2Dir, '.obts', 'apply.lock'))).toBe(false);
    const journal = JSON.parse(await readFile(join(device2Dir, '.obts', 'apply-journal.json'), 'utf8')) as {
      phase: string;
      redacted_error_category: string;
      recovery_bundle_id: string | null;
      affected_paths: string[];
    };
    expect(journal.phase).toBe('blocked_recovery');
    expect(journal.redacted_error_category).toBe('preflight_hash_changed');
    expect(journal.recovery_bundle_id).toMatch(/^rec_/u);
    expect(journal.affected_paths).toEqual(['shared.md']);
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
    expect((await stat(join(bundleDir, 'git', 'local-refs.pack'))).size).toBeGreaterThan(0);
    const checksums = await readFile(join(bundleDir, 'checksums.sha256'), 'utf8');
    expect(checksums).toContain('  manifest.json');
    expect(checksums).toContain('  files/shared.md');
    expect(checksums).toContain('  patches/shared.md.patch');
    expect(checksums).toContain('  git/local-refs.pack');
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
    const localGit = new LocalGitEngine(device2Dir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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

    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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
    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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

  it('keeps same-device non-fast-forward blocks active until recovery', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'non-fast-forward-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    expect((await plugin.syncOnce()).status).toBe('Synced');
    const pairedState = await plugin.readState();
    expect(pairedState.local_main).toMatch(/^[0-9a-f]{40}$/u);

    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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

  it('rejects uploaded changes outside the paired device sync profile before refs advance', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'profile-device');
    await mkdirp(deviceDir);
    const plugin = await pairPlugin(admin, deviceDir, 'laptop');
    const state = await plugin.readState();
    const token = await readDeviceToken(deviceDir);

    await writeFile(join(deviceDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const permissiveGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_plus_attachments',
      syncPlugins: false,
      attachmentLocation: { mode: 'vault_folder' }
    });
    const commit = await permissiveGit.createLocalCommit('obts: out-of-profile attachment');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    const packfile = await permissiveGit.createPackForCommit(commit!);

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
    ).rejects.toMatchObject({ status: 409, code: 'profile_path_rejected' });

    const db = await server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
    expect(device?.device_ref_head).toBeNull();
    expect(db.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(state.local_main);

    const events = await admin.get<{ events: Array<{ event_type: string; payload: { reason?: string } }> }>(
      `/api/v1/vaults/${admin.vaultId}/events?after=0`
    );
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'device_sync_rejected',
          payload: { reason: 'profile_path_rejected' }
        })
      ])
    );
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
    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
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

  it('materializes only paths allowed by the paired device sync profile while preserving server tree entries', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const fullDeviceDir = join(root, 'full-profile-device');
    const notesOnlyDeviceDir = join(root, 'notes-only-profile-device');
    await mkdirp(fullDeviceDir);
    await mkdirp(join(fullDeviceDir, '.obsidian', 'plugins', 'example'));
    await mkdirp(notesOnlyDeviceDir);
    await writeFile(join(fullDeviceDir, 'note.md'), '# Note\n');
    await writeFile(join(fullDeviceDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(fullDeviceDir, '.obsidian', 'plugins', 'example', 'main.js'), 'module.exports = {};\n');

    const fullPlugin = await pairPluginWithProfile(admin, fullDeviceDir, 'desktop', 'full_vault_config', true);
    expect((await fullPlugin.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');

    const notesOnlyPlugin = await pairPlugin(admin, notesOnlyDeviceDir, 'phone');
    expect(await readFile(join(notesOnlyDeviceDir, 'note.md'), 'utf8')).toBe('# Note\n');
    expect(await exists(join(notesOnlyDeviceDir, 'photo.png'))).toBe(false);
    expect(await exists(join(notesOnlyDeviceDir, '.obsidian', 'plugins', 'example', 'main.js'))).toBe(false);

    await writeFile(join(notesOnlyDeviceDir, 'phone.md'), 'notes-only change\n');
    expect((await notesOnlyPlugin.syncOnce()).status).toBe('Synced');

    const main = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    expect(main).toMatch(/^[0-9a-f]{40}$/u);
    expect(await server.git.listTreePaths(admin.vaultId, main!)).toEqual(
      expect.arrayContaining(['note.md', 'phone.md', 'photo.png', '.obsidian/plugins/example/main.js'])
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

  it('rejects local case-fold path collisions before creating a hidden Git commit', async () => {
    const deviceDir = join(root, 'local-collision-device');
    await mkdirp(join(deviceDir, 'Notes'));
    await mkdirp(join(deviceDir, 'notes'));
    await writeFile(join(deviceDir, 'Notes', 'A.md'), 'upper\n');
    await writeFile(join(deviceDir, 'notes', 'a.md'), 'lower\n');
    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
    await localGit.initialize();

    await expect(localGit.createLocalCommit('obts: collision')).rejects.toBeInstanceOf(PathPolicyViolation);
    expect(await localGit.resolveRef('refs/heads/local')).toBeNull();
  });

  it('detects rapid same-size local edits by staged content instead of timestamps', async () => {
    const deviceDir = join(root, 'rapid-edit-device');
    await mkdirp(deviceDir);
    const localGit = new LocalGitEngine(deviceDir, {
      profile: 'notes_only',
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' }
    });
    await localGit.initialize();

    await writeFile(join(deviceDir, 'library.base'), 'a: 1\n');
    const firstCommit = await localGit.createLocalCommit('obts: first same-size edit');
    expect(firstCommit).toMatch(/^[0-9a-f]{40}$/u);

    await writeFile(join(deviceDir, 'library.base'), 'a: 2\n');
    const secondCommit = await localGit.createLocalCommit('obts: second same-size edit');
    expect(secondCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(secondCommit).not.toBe(firstCommit);
  });

  it('serves an API-backed dashboard shell for Phase 1 workflows', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('/api/v1/setup/status');
    expect(html).toContain('/api/v1${path}');
    expect(html).toContain('Pair Device');
    expect(html).not.toContain('Use <code>/api/v1');
    expect(html).not.toContain('later UI work');
    expect(html).not.toContain('implemented server-side');
  });

  it('ships an installable Obsidian plugin with Phase 1 sync behavior', async () => {
    const pluginMain = await readFile(join(process.cwd(), 'obsidian-plugin', 'main.js'), 'utf8');
    const pluginReadme = await readFile(join(process.cwd(), 'obsidian-plugin', 'README.md'), 'utf8');

    expect(pluginMain).toContain('class ObtsObsidianClient');
    expect(pluginMain).toContain('/api/v1/pair/consume');
    expect(pluginMain).toContain('/sync/push');
    expect(pluginMain).toContain('/sync/pull');
    expect(pluginMain).toContain('refs/heads/local');
    expect(pluginMain).toContain('refs/heads/main');
    expect(pluginMain).toContain('apply-journal.json');
    expect(pluginMain).toContain('createRecoveryBundle');
    expect(pluginMain).toContain('this.app.vault.on("modify"');
    expect(pluginMain).toContain('adapter.writeBinary');
    expect(pluginMain).not.toContain('packaged TypeScript client');
    expect(pluginMain).not.toContain('Run the packaged client sync flow');

    expect(pluginReadme).toContain('hidden local history under `.obts/git`');
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
      `/api/v1/vaults/${admin.vaultId}/dashboard`,
      `/api/v1/vaults/${admin.vaultId}/conflicts?status=open`,
      `/api/v1/vaults/${admin.vaultId}/events`
    ]) {
      const response = await other.get<{ error: { code: string } }>(path);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    }

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
    expect(() => assertSyncableTreePaths(['Notes/A.md', 'notes/a.md'])).toThrow(PathPolicyViolation);
    expect(normalizeVaultPath('notes//a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/../a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/./a.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/bad:name.md').ok).toBe(false);
    expect(normalizeVaultPath('notes/trailing.').ok).toBe(false);
  });

  it('applies the explicit Obsidian config and plugin path policy before note-extension shortcuts', () => {
    const notesOnly = { profile: 'notes_only' as const, syncPlugins: false, attachmentLocation: { mode: 'same_folder_as_note' as const } };
    const fullNoPlugins = {
      profile: 'full_vault_config' as const,
      syncPlugins: false,
      attachmentLocation: { mode: 'same_folder_as_note' as const }
    };
    const fullWithPlugins = { ...fullNoPlugins, syncPlugins: true };

    expect(isSyncableVaultPath('.obsidian/readme.md', notesOnly)).toBe(false);
    expect(isSyncableVaultPath('.obsidian/readme.md', fullNoPlugins)).toBe(false);
    expect(isSyncableVaultPath('.obsidian/app.json', fullNoPlugins)).toBe(true);
    expect(isSyncableVaultPath('.obsidian/snippets/theme.css', fullNoPlugins)).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/example/main.js', fullNoPlugins)).toBe(false);
    expect(isSyncableVaultPath('.obsidian/plugins/example/main.js', fullWithPlugins)).toBe(true);
    expect(isSyncableVaultPath('.obsidian/plugins/obts/main.js', fullWithPlugins)).toBe(false);
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
  return await pairPluginWithProfile(admin, vaultDir, deviceName, 'notes_only');
}

async function pairPluginWithProfile(
  admin: BrowserSession & { vaultId: string },
  vaultDir: string,
  deviceName: string,
  syncProfile: SyncProfile,
  syncPlugins = false
): Promise<ObtsPluginClient> {
  const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
    device_name: deviceName,
    sync_profile: syncProfile,
    sync_plugins: syncPlugins
  });
  expect(pairing.status).toBe(201);
  const plugin = new ObtsPluginClient(vaultDir, {
    serverUrl: baseUrlFromAdmin(admin),
    deviceName,
    syncProfile,
    syncPlugins
  });
  await plugin.pairWithToken(pairing.body.pairing_token);
  return plugin;
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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function asText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
