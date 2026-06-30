import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient, PluginBlockedError } from '../src/plugin/client.js';
import { LocalGitEngine } from '../src/plugin/localGit.js';
import { TransportClient } from '../src/plugin/transport.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  PathPolicyViolation
} from '../src/shared/pathPolicy.js';
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

  it('records a conflict for same-file Bases edits without a semantic Bases merge', async () => {
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

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function asText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
