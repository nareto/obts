import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/plugin/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

type Json = Record<string, unknown>;

class BrowserSession {
  cookie = '';
  csrf = '';
  vaultId = '';

  constructor(readonly baseUrl: string) {}

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
    return { status: response.status, body: (await response.json()) as T };
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

describe('Phase 2 dashboard conflict resolution', () => {
  let root: string;
  let server: ObtsServer;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-phase2-'));
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reviews and resolves a conflict with a same-tree server-version merge commit idempotently', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop');
    const tabletDir = join(root, 'tablet');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string; device_commit: string };
      stale: boolean;
      files: Array<{ path: string; server_content: string; device_content: string; source_diff: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.stale).toBe(false);
    expect(review.body.files[0]).toMatchObject({
      path: 'shared.md',
      server_content: 'server version\n',
      device_content: 'device version\n'
    });
    expect(review.body.files[0]?.source_diff).toContain('-server version');
    const expectedMainTree = await server.git.treeHash(admin.vaultId, review.body.conflict.expected_main);

    const resolved = await admin.post<{
      status: string;
      resolution_commit: string;
      main: string;
      idempotent: boolean;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`, {
      expected_main: review.body.conflict.expected_main,
      resolution_kind: 'keep_server'
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      status: 'resolved',
      main: resolved.body.resolution_commit,
      idempotent: false
    });
    expect(await server.git.treeHash(admin.vaultId, resolved.body.resolution_commit)).toBe(expectedMainTree);
    const parents = (
      await server.git.exec(server.git.repoPath(admin.vaultId), ['show', '-s', '--format=%P', resolved.body.resolution_commit])
    ).stdout.toString().trim().split(/\s+/u);
    expect(parents).toEqual([review.body.conflict.expected_main, review.body.conflict.device_commit]);

    const duplicate = await admin.post<{ idempotent: boolean; resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      idempotent: true,
      resolution_commit: resolved.body.resolution_commit
    });

    const db = await server.store.snapshot();
    expect(db.conflicts.find((conflict) => conflict.conflict_id === result.conflictId)).toMatchObject({
      status: 'resolved',
      resolution_kind: 'keep_server',
      resolution_commit: resolved.body.resolution_commit
    });
    expect(db.events.find((event) => event.event_type === 'main_advanced' && event.resource_ids.conflict_id === result.conflictId)).toBeDefined();
  });

  it('resolves with the device version without discarding unrelated server-side changes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-device-resolution');
    const tabletDir = join(root, 'tablet-device-resolution');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    await writeFile(join(desktopDir, 'server-only.md'), 'base server-only\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(desktopDir, 'server-only.md'), 'server-side accepted change\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string };
      files: Array<{ path: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files.map((file) => file.path)).toEqual(['shared.md']);

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'use_device'
      }
    );
    expect(resolved.status).toBe(200);
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
      'device version\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'server-only.md')).toString('utf8')).toBe(
      'server-side accepted change\n'
    );
  });

  it('rejects stale, cross-user, and non-recent conflict resolution submissions', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-stale');
    const tabletDir = join(root, 'tablet-stale');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      conflict: { conflict_id: string };
      expected_main: string;
      current_main: string;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);

    const intruder = new BrowserSession(baseUrl);
    const user = await admin.post<{ reset_token: string }>('/api/v1/admin/users', {
      username: 'intruder',
      password: 'intruder-password-1234'
    });
    expect(user.status).toBe(201);
    const login = await intruder.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'intruder',
      password: 'intruder-password-1234'
    }, false);
    expect(login.status).toBe(200);

    const hiddenList = await intruder.get<{ error: { code: string } }>(`/api/v1/vaults/${admin.vaultId}/conflicts`);
    expect(hiddenList.status).toBe(404);
    const hiddenReview = await intruder.get<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`
    );
    expect(hiddenReview.status).toBe(404);
    const hiddenResolve = await intruder.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(hiddenResolve.status).toBe(404);

    await server.store.mutate((db) => {
      const sessionId = admin.cookie.match(/(?:^|;\s*)[^=]+=([^;]+)/u)?.[1];
      const session = db.sessions.find((candidate) => candidate.session_id === sessionId);
      expect(session).toBeDefined();
      session!.recent_auth_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    });
    const oldMain = review.body.current_main;
    const notRecent = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(notRecent.status).toBe(403);
    expect(notRecent.body.error.code).toBe('recent_auth_required');
    expect((await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(oldMain);

    await admin.post<{ csrf_token: string }>('/api/v1/auth/login', {
      username: 'admin',
      password: 'admin-password-1234'
    }, false);
    await writeFile(join(desktopDir, 'unrelated.md'), 'accepted while review is open\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const stale = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_conflict_review');
    expect((await server.store.snapshot()).conflicts.find((conflict) => conflict.conflict_id === result.conflictId)?.status).toBe('open');
  });

  it('supports keep-both, insert-both, and manual conflict resolutions as merge commits', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    for (const [index, resolutionKind] of (['keep_both_files', 'insert_both_blocks', 'manual'] as const).entries()) {
      if (index > 0) {
        const vault = await admin.post<{ vault_id: string }>(
          '/api/v1/vaults',
          {
            display_name: `Vault ${resolutionKind}`
          }
        );
        expect(vault.status).toBe(201);
        admin.vaultId = vault.body.vault_id;
      }
      const desktopDir = join(root, `desktop-${resolutionKind}`);
      const tabletDir = join(root, `tablet-${resolutionKind}`);
      await mkdir(desktopDir, { recursive: true });
      await mkdir(tabletDir, { recursive: true });
      const desktop = await pairPlugin(admin, desktopDir, `desktop-${resolutionKind}`);
      await writeFile(join(desktopDir, 'shared.md'), 'base\n');
      expect((await desktop.syncOnce()).status).toBe('Synced');

      const tablet = await pairPlugin(admin, tabletDir, `tablet-${resolutionKind}`);
      await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
      await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
      expect((await desktop.syncOnce()).status).toBe('Synced');
      const result = await tablet.syncOnce();
      expect(result.status).toBe('Review needed');

      const review = await admin.get<{
        conflict: { conflict_id: string; expected_main: string; device_commit: string; device_id: string };
        files: Array<{ path: string }>;
      }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
      expect(review.status).toBe(200);

      const body =
        resolutionKind === 'manual'
          ? {
              expected_main: review.body.conflict.expected_main,
              resolution_kind: resolutionKind,
              manual_files: { 'shared.md': 'manual result\n' }
            }
          : {
              expected_main: review.body.conflict.expected_main,
              resolution_kind: resolutionKind
            };
      const resolved = await admin.post<{ resolution_commit: string }>(
        `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
        body
      );
      expect(resolved.status).toBe(200);

      const parents = (
        await server.git.exec(server.git.repoPath(admin.vaultId), ['show', '-s', '--format=%P', resolved.body.resolution_commit])
      ).stdout.toString().trim().split(/\s+/u);
      expect(parents).toEqual([review.body.conflict.expected_main, review.body.conflict.device_commit]);

      if (resolutionKind === 'keep_both_files') {
        expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
          'server version\n'
        );
        const paths = await server.git.listTreePaths(admin.vaultId, resolved.body.resolution_commit);
        const copyPath = paths.find((path) => path.startsWith('shared.device-') && path.endsWith('.md'));
        expect(copyPath).toBeDefined();
        expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, copyPath!)).toString('utf8')).toBe(
          'device version\n'
        );
      } else if (resolutionKind === 'insert_both_blocks') {
        const content = (await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8');
        expect(content).toContain('## Server version');
        expect(content).toContain('server version\n');
        expect(content).toContain('## Device version');
        expect(content).toContain('device version\n');
      } else {
        expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
          'manual result\n'
        );
      }
    }
  });

  it('serves note history, restores a version, and runs owner-scoped maintenance', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-history');
    await mkdir(desktopDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'history.md'), 'first version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await writeFile(join(desktopDir, 'history.md'), 'second version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const history = await admin.post<{
      current_main: string;
      versions: Array<{ commit: string; operation_type: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, {
      path: 'history.md',
      limit: 20
    });
    expect(history.status).toBe(200);
    expect(history.body.versions.length).toBeGreaterThanOrEqual(2);

    let firstVersionCommit = '';
    for (const version of history.body.versions) {
      const content = await admin.post<{ content: string | null }>(`/api/v1/vaults/${admin.vaultId}/history/version`, {
        path: 'history.md',
        commit: version.commit
      });
      if (content.body.content === 'first version\n') {
        firstVersionCommit = version.commit;
        break;
      }
    }
    expect(firstVersionCommit).toMatch(/^[0-9a-f]{40}$/u);

    const restored = await admin.post<{ status: string; restore_commit: string }>(`/api/v1/vaults/${admin.vaultId}/history/restore`, {
      path: 'history.md',
      source_commit: firstVersionCommit,
      expected_main: history.body.current_main
    });
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe('restored');
    expect((await server.git.readBlobAtPath(admin.vaultId, restored.body.restore_commit, 'history.md')).toString('utf8')).toBe(
      'first version\n'
    );

    const maintenance = await admin.post<{ status: string; detail: string }>(
      `/api/v1/vaults/${admin.vaultId}/maintenance/git-gc/start`,
      {}
    );
    expect(maintenance.status).toBe(200);
    expect(maintenance.body).toMatchObject({ status: 'completed' });
    expect(maintenance.body.detail).toContain('completed');
  });
});

async function setupAdminAndVault(baseUrl: string, username = 'admin', vaultName = 'Main Vault'): Promise<BrowserSession> {
  const admin = new BrowserSession(baseUrl);
  const setup = await admin.post<{ csrf_token: string }>('/api/v1/setup', {
    username,
    password: 'admin-password-1234'
  }, false);
  expect(setup.status).toBe(201);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', {
    display_name: vaultName
  });
  expect(vault.status).toBe(201);
  admin.vaultId = vault.body.vault_id;
  return admin;
}

async function pairPlugin(admin: BrowserSession, vaultDir: string, deviceName: string): Promise<ObtsPluginClient> {
  const pairing = await admin.post<{ pairing_token: string }>(`/api/v1/vaults/${admin.vaultId}/pairing-tokens`, {
    device_name: deviceName
  });
  expect(pairing.status).toBe(201);
  const plugin = new ObtsPluginClient(vaultDir, {
    serverUrl: admin.baseUrl,
    deviceName
  });
  await plugin.pairWithToken(pairing.body.pairing_token);
  return plugin;
}
