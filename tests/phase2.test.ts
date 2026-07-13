import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../obsidian-plugin/src/core/client.js';
import type { ApplyJournal } from '../obsidian-plugin/src/core/recovery.js';
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

  it('serves the built dashboard shell and returns a normal 404 for missing static assets', async () => {
    const dashboard = await fetch(`${baseUrl}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get('content-type')).toContain('text/html');
    expect(await dashboard.text()).toContain('/assets/');

    const missing = await fetch(`${baseUrl}/assets/missing-dashboard-asset.js`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: {
        code: 'not_found'
      }
    });
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
    expect(await server.git.getRef(admin.vaultId, `refs/obts/conflicts/${result.conflictId}/base`)).toBeTruthy();
    expect(await server.git.getRef(admin.vaultId, `refs/obts/conflicts/${result.conflictId}/current`)).toBe(
      review.body.conflict.expected_main
    );
    expect(await server.git.getRef(admin.vaultId, `refs/obts/conflicts/${result.conflictId}/device`)).toBe(
      review.body.conflict.device_commit
    );
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

    const history = await admin.post<{
      versions: Array<{ commit: string; operation_type: string; conflict_id?: string; device_id?: string; user_id?: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, { path: 'shared.md', limit: 20 });
    expect(history.status).toBe(200);
    expect(history.body.versions).toContainEqual(
      expect.objectContaining({
        commit: resolved.body.resolution_commit,
        operation_type: 'conflict_resolution',
        conflict_id: result.conflictId,
        device_id: expect.any(String),
        user_id: expect.any(String)
      })
    );
    const proposalOnlyVersion = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/history/version`,
      { path: 'shared.md', commit: review.body.conflict.device_commit }
    );
    expect(proposalOnlyVersion.status).toBe(404);
    expect(proposalOnlyVersion.body.error.code).toBe('not_found');

    const db = await server.store.snapshot();
    expect(db.conflicts.find((conflict) => conflict.conflict_id === result.conflictId)).toMatchObject({
      status: 'resolved',
      resolution_kind: 'keep_server',
      resolution_commit: resolved.body.resolution_commit
    });
    const resolutionEvents = db.events.filter((event) => event.resource_ids.conflict_id === result.conflictId);
    expect(resolutionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'main_advanced' }),
        expect.objectContaining({ event_type: 'conflict_resolved' })
      ])
    );
    expect(JSON.stringify(resolutionEvents)).not.toContain('server version');
    expect(JSON.stringify(resolutionEvents)).not.toContain('device version');
    expect(JSON.stringify(resolutionEvents)).not.toContain('shared.md');
    expect(db.audit_log).toContainEqual(
      expect.objectContaining({
        actor_user_id: expect.any(String),
        actor_device_id: null,
        vault_id: admin.vaultId,
        action: 'conflict_resolved',
        resource_class: 'conflict',
        resource_id: result.conflictId
      })
    );
  });

  it('reviews and resolves a rename title conflict with path-aware choices', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { result } = await prepareRenameConflict(admin, root, 'rename-review');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string };
      path_conflicts: Array<{
        kind: string;
        base_path: string | null;
        server_path: string | null;
        device_path: string | null;
        affected_paths: string[];
      }>;
      files: Array<{ path: string; server_content: string | null; device_content: string | null }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.path_conflicts).toEqual([
      expect.objectContaining({
        kind: 'rename_rename',
        base_path: 'Old.md',
        server_path: 'Title A.md',
        device_path: 'Title B.md',
        affected_paths: ['Old.md', 'Title A.md', 'Title B.md']
      })
    ]);
    expect(review.body.files.map((file) => file.path)).toEqual(['Old.md', 'Title A.md', 'Title B.md']);

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'keep_both_files'
      }
    );
    expect(resolved.status).toBe(200);
    expect(await server.git.listTreePaths(admin.vaultId, resolved.body.resolution_commit)).toEqual([
      'Title A.md',
      'Title B.md',
      'rename-review-tablet-ref.md'
    ]);
  });

  it('supports custom final title resolution for rename conflicts and rejects unrelated path collisions', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const { result } = await prepareRenameConflict(admin, root, 'rename-manual', { 'Existing.md': 'do not overwrite\n' });

    const review = await admin.get<{
      conflict: { expected_main: string };
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);

    const collision = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'manual',
        manual_file_plan: [
          { path: 'Old.md', content: null },
          { path: 'Title A.md', content: null },
          { path: 'Title B.md', content: null },
          { path: 'Existing.md', content: 'overwrite attempt\n' }
        ]
      }
    );
    expect(collision.status).toBe(400);
    expect(collision.body.error.code).toBe('invalid_resolution');

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'manual',
        manual_file_plan: [
          { path: 'Old.md', content: null },
          { path: 'Title A.md', content: null },
          { path: 'Title B.md', content: null },
          { path: 'Final Title.md', content: 'custom title and body\n' }
        ]
      }
    );
    expect(resolved.status).toBe(200);
    expect(await server.git.listTreePaths(admin.vaultId, resolved.body.resolution_commit)).toEqual([
      'Existing.md',
      'Final Title.md',
      'rename-manual-tablet-ref.md'
    ]);
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'Final Title.md')).toString('utf8')).toBe(
      'custom title and body\n'
    );
  });

  it('keeps the server version without discarding unrelated device-side changes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-server-resolution');
    const tabletDir = join(root, 'tablet-server-resolution');
    const readerDir = join(root, 'reader-server-resolution');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    await mkdir(readerDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    await writeFile(join(tabletDir, 'device-only.md'), 'created while resolving another note\n');
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
        resolution_kind: 'keep_server'
      }
    );
    expect(resolved.status).toBe(200);
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
      'server version\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'device-only.md')).toString('utf8')).toBe(
      'created while resolving another note\n'
    );

    const reader = await pairPlugin(admin, readerDir, 'reader');
    expect((await reader.readState()).status_label).toBe('Synced');
    expect(await readFile(join(readerDir, 'device-only.md'), 'utf8')).toBe('created while resolving another note\n');
  });

  it('auto-preserves safe local-only changes from a legacy server-only conflict resolution', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-legacy-server-resolution');
    const tabletDir = join(root, 'tablet-legacy-server-resolution');
    const readerDir = join(root, 'reader-legacy-server-resolution');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    await mkdir(readerDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    await writeFile(join(tabletDir, 'device-only.md'), 'created while the conflict was open\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');
    const conflictedState = await tablet.readState();

    const resolutionCommit = await forceLegacyKeepServerResolution(server, admin.vaultId, result.conflictId!);
    await importServerMainIntoClient(tablet, tabletDir, admin.vaultId, conflictedState.device_id!, conflictedState.local_main);
    await writeFile(join(tabletDir, 'shared.md'), 'server version\n');
    await writeFile(
      join(tabletDir, '.obts', 'apply-journal.json'),
      `${JSON.stringify(
        {
          apply_id: 'apply_legacy_server_only_resolution',
          operation_type: 'pull_apply',
          target_main: resolutionCommit,
          expected_prior_local_main: conflictedState.local_main,
          expected_prior_local_device_ref: conflictedState.server_device_ref,
          phase: 'blocked_recovery',
          affected_paths: ['shared.md'],
          preflight_sha256: { 'shared.md': null },
          recovery_bundle_id: 'rec_legacy_server_only_resolution',
          last_completed_step: 'files_written',
          redacted_error_category: 'local_changed_during_apply'
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(tabletDir, '.obts', 'state.json'),
      `${JSON.stringify(
        {
          ...conflictedState,
          status_label: 'Unsafe local state',
          last_error_code: 'unsafe_local_state',
          updated_at: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );

    const restartedTablet = new ObtsPluginClient(tabletDir, {
      serverUrl: admin.baseUrl,
      deviceName: 'tablet'
    });
    await restartedTablet.initialize();
    expect(await readFile(join(tabletDir, 'device-only.md'), 'utf8')).toBe('created while the conflict was open\n');
    expect(await readFile(join(tabletDir, 'shared.md'), 'utf8')).toBe('server version\n');
    expect(await restartedTablet.readQueue()).toMatchObject({ status: 'queued_local' });
    expect((await restartedTablet.readState()).status_label).toBe('Ahead');

    expect((await restartedTablet.syncOnce()).status).toBe('Synced');
    const reader = await pairPlugin(admin, readerDir, 'reader');
    expect(await readFile(join(readerDir, 'device-only.md'), 'utf8')).toBe('created while the conflict was open\n');
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

  it('escapes rendered Markdown conflict review content before the dashboard renders it as HTML', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-rendered-safety');
    const tabletDir = join(root, 'tablet-rendered-safety');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'shared.md'), '<img src=x onerror=alert(1)>\n');
    await writeFile(join(tabletDir, 'shared.md'), '<script>alert(2)</script>\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      files: Array<{ rendered_markdown_diff: string | null; server_content: string; device_content: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files[0]?.server_content).toBe('<img src=x onerror=alert(1)>\n');
    expect(review.body.files[0]?.device_content).toBe('<script>alert(2)</script>\n');
    const rendered = review.body.files[0]?.rendered_markdown_diff ?? '';
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).not.toContain('<script>');
  });

  it('rejects stale and cross-user conflict resolution submissions without requiring recent auth', async () => {
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
    const hiddenRefresh = await intruder.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/refresh`,
      {}
    );
    expect(hiddenRefresh.status).toBe(404);
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

    const refreshed = await admin.post<{
      stale: boolean;
      expected_main: string;
      current_main: string;
      files: Array<{ path: string; server_content: string | null; device_content: string | null }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.stale).toBe(false);
    expect(refreshed.body.expected_main).toBe(refreshed.body.current_main);
    expect(refreshed.body.expected_main).not.toBe(review.body.expected_main);
    expect(refreshed.body.files[0]).toMatchObject({
      path: 'shared.md',
      server_content: 'server version\n',
      device_content: 'device version\n'
    });

    const refreshedResolved = await admin.post<{ status: string; resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: refreshed.body.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(refreshedResolved.status).toBe(200);
    expect(refreshedResolved.body.status).toBe('resolved');
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshedResolved.body.resolution_commit, 'unrelated.md')).toString('utf8')).toBe(
      'accepted while review is open\n'
    );
  });

  it('refreshes a stale conflict package to include newly overlapping paths', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-refresh-paths');
    const tabletDir = join(root, 'tablet-refresh-paths');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'one.md'), 'one base\n');
    await writeFile(join(desktopDir, 'two.md'), 'two base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'one.md'), 'one server\n');
    await writeFile(join(tabletDir, 'one.md'), 'one device\n');
    await writeFile(join(tabletDir, 'two.md'), 'two device\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string };
      files: Array<{ path: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files.map((file) => file.path)).toEqual(['one.md']);

    await writeFile(join(desktopDir, 'two.md'), 'two server later\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const refreshed = await admin.post<{
      conflict: { affected_paths: string[]; affected_path_count: number };
      files: Array<{ path: string; server_content: string | null; device_content: string | null }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/refresh`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.conflict.affected_paths).toEqual(['one.md', 'two.md']);
    expect(refreshed.body.conflict.affected_path_count).toBe(2);
    expect(refreshed.body.files.map((file) => file.path)).toEqual(['one.md', 'two.md']);
    expect(refreshed.body.files.find((file) => file.path === 'two.md')).toMatchObject({
      server_content: 'two server later\n',
      device_content: 'two device\n'
    });
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

  it('rejects manual conflict resolutions that edit paths outside the conflict package', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-manual-boundary');
    const tabletDir = join(root, 'tablet-manual-boundary');
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
      conflict: { conflict_id: string; expected_main: string };
      files: Array<{ path: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files.map((file) => file.path)).toEqual(['shared.md']);

    const rejected = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'manual',
        manual_files: {
          'shared.md': 'manual result\n',
          'unrelated.md': 'should not be accepted\n'
        }
      }
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('invalid_resolution');
    expect((await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main).toBe(
      review.body.conflict.expected_main
    );

    const accepted = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'manual',
        manual_files: {
          'shared.md': 'manual result\n'
        }
      }
    );
    expect(accepted.status).toBe(200);
    expect((await server.git.readBlobAtPath(admin.vaultId, accepted.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
      'manual result\n'
    );
    expect(await server.git.readBlobAtPathIfPresent(admin.vaultId, accepted.body.resolution_commit, 'unrelated.md')).toBeNull();
  });

  it('rejects manual conflict resolutions that omit affected paths', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-manual-complete');
    const tabletDir = join(root, 'tablet-manual-complete');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'one.md'), 'one base\n');
    await writeFile(join(desktopDir, 'two.md'), 'two base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(desktopDir, 'one.md'), 'one server\n');
    await writeFile(join(desktopDir, 'two.md'), 'two server\n');
    await writeFile(join(tabletDir, 'one.md'), 'one device\n');
    await writeFile(join(tabletDir, 'two.md'), 'two device\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Review needed');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string };
      files: Array<{ path: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files.map((file) => file.path).sort()).toEqual(['one.md', 'two.md']);

    const rejected = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'manual',
        manual_files: {
          'one.md': 'one manual\n'
        }
      }
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('invalid_resolution');
  });

  it('keeps a conflict-blocked device blocked when unrelated main advances', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-unrelated-main');
    const tabletDir = join(root, 'tablet-unrelated-main');
    const phoneDir = join(root, 'phone-unrelated-main');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    await mkdir(phoneDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    const phone = await pairPlugin(admin, phoneDir, 'phone');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await tablet.syncOnce()).status).toBe('Review needed');
    expect((await tablet.readState()).last_error_code).toBe('conflict_review_required');

    await writeFile(join(phoneDir, 'other.md'), 'unrelated accepted edit\n');
    expect((await phone.syncOnce()).status).toBe('Synced');

    const polled = await tablet.pollRemoteEventsAndApply();
    expect(polled).toMatchObject({ applied: false, status: 'Review needed' });
    expect((await tablet.readState()).last_error_code).toBe('conflict_review_required');
    expect(await readFile(join(tabletDir, 'shared.md'), 'utf8')).toBe('device version\n');
  });

  it('allows a blocked device to poll events, detect conflict resolution, and apply the resolved main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-event-resolution');
    const tabletDir = join(root, 'tablet-event-resolution');
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
    expect((await tablet.readState()).last_error_code).toBe('conflict_review_required');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string };
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);

    const resolved = await admin.post<{ main: string; resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: review.body.conflict.expected_main,
        resolution_kind: 'keep_server'
      }
    );
    expect(resolved.status).toBe(200);

    const polled = await tablet.pollRemoteEventsAndApply();
    expect(polled).toMatchObject({ applied: true });
    expect((await tablet.readState()).last_error_code).toBeNull();
    expect((await tablet.readState()).status_label).toBe('Synced');
    expect(await readFile(join(tabletDir, 'shared.md'), 'utf8')).toBe('server version\n');

    const tabletState = await tablet.readState();
    const db = await server.store.snapshot();
    expect(db.devices.find((candidate) => candidate.device_id === tabletState.device_id)?.status).toBe('synced');
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
    expect(history.body.versions.map((version) => version.operation_type)).toEqual(
      expect.arrayContaining(['create', 'update'])
    );

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

    const emptyRoot = (
      await server.git.exec(server.git.repoPath(admin.vaultId), ['rev-list', '--max-parents=0', history.body.current_main])
    ).stdout.toString().trim();
    const unrelatedRestore = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/history/restore`,
      {
        path: 'history.md',
        source_commit: emptyRoot,
        expected_main: history.body.current_main
      }
    );
    expect(unrelatedRestore.status).toBe(404);
    expect(unrelatedRestore.body.error.code).toBe('not_found');

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
    const restoreParents = (
      await server.git.exec(server.git.repoPath(admin.vaultId), ['show', '-s', '--format=%P', restored.body.restore_commit])
    ).stdout.toString().trim().split(/\s+/u);
    expect(restoreParents).toEqual([history.body.current_main, firstVersionCommit]);
    const restoreEvents = (await server.store.snapshot()).events.filter((event) => event.event_type === 'note_restored');
    expect(JSON.stringify(restoreEvents)).not.toContain('history.md');
    expect(restoreEvents[0]?.payload.path_id).toMatch(/^path_[0-9a-f]{16}$/u);

    const restoredHistory = await admin.post<{
      versions: Array<{ commit: string; operation_type: string; user_id?: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, { path: 'history.md', limit: 20 });
    expect(restoredHistory.body.versions).toContainEqual(
      expect.objectContaining({
        commit: restored.body.restore_commit,
        operation_type: 'restore',
        user_id: expect.any(String)
      })
    );

    const maintenance = await admin.post<{ status: string; detail: string }>(
      `/api/v1/vaults/${admin.vaultId}/maintenance/git-gc/start`,
      {}
    );
    expect(maintenance.status).toBe(200);
    expect(maintenance.body).toMatchObject({ status: 'completed' });
    expect(maintenance.body.detail).toContain('completed');
    expect(await server.git.commitExists(admin.vaultId, firstVersionCommit)).toBe(true);
    expect((await server.git.readBlobAtPath(admin.vaultId, firstVersionCommit, 'history.md')).toString('utf8')).toBe(
      'first version\n'
    );
    const maintenanceState = await server.store.snapshot();
    expect(maintenanceState.events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['vault_maintenance_started', 'vault_maintenance_finished'])
    );
    expect(maintenanceState.audit_log.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['git_maintenance_started', 'git_maintenance_finished'])
    );
  });

  it('shows rename provenance in note history and previews historical paths', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-rename-history');
    await mkdir(desktopDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'old-name.md'), 'rename me\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await rename(join(desktopDir, 'old-name.md'), join(desktopDir, 'new-name.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const history = await admin.post<{
      versions: Array<{ commit: string; path: string; previous_path?: string; operation_type: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, {
      path: 'new-name.md',
      limit: 20
    });
    expect(history.status).toBe(200);
    expect(history.body.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_type: 'rename',
          path: 'new-name.md',
          previous_path: 'old-name.md'
        }),
        expect.objectContaining({
          path: 'old-name.md'
        })
      ])
    );

    const oldVersion = history.body.versions.find((version) => version.path === 'old-name.md');
    expect(oldVersion).toBeDefined();
    const preview = await admin.post<{ content: string | null }>(`/api/v1/vaults/${admin.vaultId}/history/version`, {
      path: oldVersion!.path,
      commit: oldVersion!.commit
    });
    expect(preview.status).toBe(200);
    expect(preview.body.content).toBe('rename me\n');

    await writeFile(join(desktopDir, 'new-name.md'), 'renamed content changed\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const latestMain = (await admin.get<{ current_main: string }>(`/api/v1/vaults/${admin.vaultId}/main`)).body.current_main;
    const restored = await admin.post<{ status: string; restore_commit: string; source_path: string }>(
      `/api/v1/vaults/${admin.vaultId}/history/restore`,
      {
        path: 'new-name.md',
        source_commit: oldVersion!.commit,
        expected_main: latestMain
      }
    );
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ status: 'restored', source_path: 'old-name.md' });
    expect((await server.git.readBlobAtPath(admin.vaultId, restored.body.restore_commit, 'new-name.md')).toString('utf8')).toBe(
      'rename me\n'
    );
    expect(await server.git.readBlobAtPathIfPresent(admin.vaultId, restored.body.restore_commit, 'old-name.md')).toBeNull();
  });

  it('shows canonical create and delete operations without listing proposal-only commits', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-delete-history');
    await mkdir(desktopDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'deleted.md'), 'temporary note\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await rm(join(desktopDir, 'deleted.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const history = await admin.post<{
      versions: Array<{ commit: string; operation_type: string; path: string }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, { path: 'deleted.md', limit: 20 });
    expect(history.status).toBe(200);
    expect(history.body.versions.map((version) => version.operation_type)).toEqual(['delete', 'create']);
    expect(history.body.versions.every((version) => version.path === 'deleted.md')).toBe(true);
  });

  it('shows concurrent canonical merges with device and merge-sequence provenance', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-merge-history');
    const tabletDir = join(root, 'tablet-merge-history');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'target.md'), 'base target\n');
    await writeFile(join(desktopDir, 'other.md'), 'base other\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const tablet = await pairPlugin(admin, tabletDir, 'tablet');

    await writeFile(join(desktopDir, 'other.md'), 'server advanced elsewhere\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await writeFile(join(tabletDir, 'target.md'), 'tablet target edit\n');
    expect((await tablet.syncOnce()).status).toBe('Synced');

    const history = await admin.post<{
      versions: Array<{ operation_type: string; device_id?: string; user_id?: string; merge_sequence?: number }>;
    }>(`/api/v1/vaults/${admin.vaultId}/history/query`, { path: 'target.md', limit: 20 });
    expect(history.status).toBe(200);
    expect(history.body.versions).toContainEqual(
      expect.objectContaining({
        operation_type: 'merge',
        device_id: expect.any(String),
        user_id: expect.any(String),
        merge_sequence: expect.any(Number)
      })
    );
  });

  it('redacts community plugin history by default and requires an explicit content-bearing request', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-plugin-history');
    const pluginDir = join(desktopDir, '.obsidian', 'plugins', 'community-example');
    await mkdir(pluginDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    const pluginPath = '.obsidian/plugins/community-example/data.json';
    const secretBody = '{"apiKey":"plugin-secret-value"}\n';
    await writeFile(join(desktopDir, pluginPath), secretBody);
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const history = await admin.post<{ versions: Array<{ commit: string }> }>(
      `/api/v1/vaults/${admin.vaultId}/history/query`,
      { path: pluginPath }
    );
    expect(history.status).toBe(200);
    const version = history.body.versions[0];
    expect(version).toBeDefined();

    const redacted = await admin.post<{
      content: string | null;
      source_diff: string;
      metadata_only: boolean;
      content_redacted: boolean;
    }>(`/api/v1/vaults/${admin.vaultId}/history/version`, {
      path: pluginPath,
      commit: version!.commit
    });
    expect(redacted.body).toMatchObject({
      content: null,
      source_diff: '',
      metadata_only: true,
      content_redacted: true
    });
    expect(JSON.stringify(redacted.body)).not.toContain('plugin-secret-value');

    const revealed = await admin.post<{ content: string; content_redacted: boolean }>(
      `/api/v1/vaults/${admin.vaultId}/history/version`,
      { path: pluginPath, commit: version!.commit, include_content: true }
    );
    expect(revealed.status).toBe(200);
    expect(revealed.body).toMatchObject({ content: secretBody, content_redacted: false });

    const db = await server.store.snapshot();
    expect(db.audit_log).toContainEqual(
      expect.objectContaining({
        actor_user_id: expect.any(String),
        vault_id: admin.vaultId,
        action: 'plugin_history_content_exported',
        resource_class: 'note_history',
        resource_id: null
      })
    );
    expect(db.derived_history_by_vault[admin.vaultId]).toEqual([
      expect.objectContaining({ path: pluginPath, current_main: expect.any(String), versions: expect.any(Array) })
    ]);
  });

  it('exports redacted diagnostics without paths, content, manifests, or device error details', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-diagnostics');
    await mkdir(desktopDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'private-note.md'), 'diagnostic-secret-body\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const state = await desktop.readState();
    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === state.device_id);
      if (!device) throw new Error('missing test device');
      device.local_error_code = 'path_problem';
      (device as unknown as { local_error_details: Record<string, unknown> }).local_error_details = {
        path: 'private-note.md',
        secret: 'diagnostic-secret-body'
      };
    });

    const diagnostics = await admin.get<Record<string, unknown>>(
      `/api/v1/vaults/${admin.vaultId}/diagnostics/export`
    );
    expect(diagnostics.status).toBe(200);
    const serialized = JSON.stringify(diagnostics.body);
    expect(serialized).not.toContain('private-note.md');
    expect(serialized).not.toContain('diagnostic-secret-body');
    expect(serialized).not.toContain('prepared_manifest');
    expect(serialized).toContain('raw vault paths');
  });

  describe('apply journal recovery', () => {
    it('recovers an incomplete apply journal when current files match preflight or target', async () => {
      const admin = await setupAdminAndVault(baseUrl);
      const vaultDir = join(root, 'recovery-success');
      await mkdir(vaultDir, { recursive: true });
      await writeFile(join(vaultDir, 'note.md'), 'initial content\n');
      const plugin = await pairPlugin(admin, vaultDir, 'device-recovery');
      const pairState = await plugin.readState();
      await writeFile(
        join(vaultDir, '.obts', 'state.json'),
        JSON.stringify({ ...pairState, initial_import_confirmed: true }, null, 2)
      );
      const client1 = new ObtsPluginClient(vaultDir, {
        serverUrl: admin.baseUrl,
        deviceName: 'device-recovery'
      });
      expect((await client1.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');

      const state = await client1.readState();
      if (!state.vault_id || !state.device_id) throw new Error('missing identity');

      await writeFile(join(vaultDir, 'note.md'), 'updated content\n');
      const syncResult = await plugin.syncOnce();
      expect(syncResult.status).toBe('Synced');
      const afterState = await plugin.readState();

      const journal: ApplyJournal = {
        apply_id: 'apply_test_recovery',
        operation_type: 'pull_apply',
        target_main: afterState.local_main!,
        expected_prior_local_main: state.local_main,
        expected_prior_local_device_ref: state.server_device_ref,
        phase: 'writing_files',
        affected_paths: ['note.md'],
        preflight_sha256: { 'note.md': null },
        recovery_bundle_id: 'rec_test_recovery',
        last_completed_step: 'recovery_bundle',
        redacted_error_category: null
      };
      await writeFile(
        join(vaultDir, '.obts', 'apply-journal.json'),
        `${JSON.stringify(journal, null, 2)}\n`
      );

      const client = new ObtsPluginClient(vaultDir, {
        serverUrl: admin.baseUrl,
        deviceName: 'device-recovery'
      });
      await client.initialize();

      const recoveredState = await client.readState();
      expect(recoveredState.last_error_code).toBeNull();
      expect(recoveredState.status_label).toBe('Synced');
      expect(recoveredState.local_main).toBe(afterState.local_main);
      await expect(
        readFile(join(vaultDir, '.obts', 'apply-journal.json'), 'utf8')
      ).rejects.toThrow();
    });

    it('fails recovery and writes error category when an affected file was externally modified', async () => {
      const admin = await setupAdminAndVault(baseUrl);
      const vaultDir = join(root, 'recovery-modified');
      await mkdir(vaultDir, { recursive: true });
      await writeFile(join(vaultDir, 'note.md'), 'initial content\n');
      const plugin = await pairPlugin(admin, vaultDir, 'device-recovery-mod');
      const pairState = await plugin.readState();
      await writeFile(
        join(vaultDir, '.obts', 'state.json'),
        JSON.stringify({ ...pairState, initial_import_confirmed: true }, null, 2)
      );
      const client1 = new ObtsPluginClient(vaultDir, {
        serverUrl: admin.baseUrl,
        deviceName: 'device-recovery-mod'
      });
      expect((await client1.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');

      const state = await client1.readState();
      if (!state.vault_id || !state.device_id) throw new Error('missing identity');

      await writeFile(join(vaultDir, 'note.md'), 'updated content\n');
      await writeFile(join(vaultDir, 'other.md'), 'other content\n');
      const syncResult = await plugin.syncOnce();
      expect(syncResult.status).toBe('Synced');
      const afterState = await plugin.readState();

      const journal: ApplyJournal = {
        apply_id: 'apply_test_recovery_modified',
        operation_type: 'pull_apply',
        target_main: afterState.local_main!,
        expected_prior_local_main: state.local_main,
        expected_prior_local_device_ref: state.server_device_ref,
        phase: 'writing_files',
        affected_paths: ['note.md', 'other.md'],
        preflight_sha256: { 'note.md': null, 'other.md': null },
        recovery_bundle_id: 'rec_test_recovery_modified',
        last_completed_step: 'recovery_bundle',
        redacted_error_category: null
      };
      await writeFile(
        join(vaultDir, '.obts', 'apply-journal.json'),
        `${JSON.stringify(journal, null, 2)}\n`
      );

      await writeFile(join(vaultDir, 'other.md'), 'externally modified content\n');

      const client = new ObtsPluginClient(vaultDir, {
        serverUrl: admin.baseUrl,
        deviceName: 'device-recovery-mod'
      });
      await client.initialize();

      const recoveredState = await client.readState();
      expect(recoveredState.last_error_code).toBe('apply_journal_recovery_required');
      expect(recoveredState.status_label).toBe('Unsafe local state');

      const savedJournal = JSON.parse(
        await readFile(join(vaultDir, '.obts', 'apply-journal.json'), 'utf8')
      ) as ApplyJournal;
      expect(savedJournal.phase).toBe('blocked_recovery');
      expect(savedJournal.redacted_error_category).toBe('local_files_diverge_from_journal');
    });
  });
});

async function forceLegacyKeepServerResolution(server: ObtsServer, vaultId: string, conflictId: string): Promise<string> {
  const snapshot = await server.store.snapshot();
  const conflict = snapshot.conflicts.find((candidate) => candidate.vault_id === vaultId && candidate.conflict_id === conflictId);
  if (!conflict) {
    throw new Error(`Conflict not found: ${conflictId}`);
  }
  const tree = await server.git.treeHash(vaultId, conflict.expected_main);
  const resolutionCommit = await server.git.createResolutionMergeCommitObject({
    vaultId,
    tree,
    expectedMain: conflict.expected_main,
    deviceCommit: conflict.device_commit,
    conflictId,
    resolutionKind: 'keep_server'
  });
  await server.git.updateRef(vaultId, 'refs/heads/main', resolutionCommit, conflict.expected_main);
  await server.store.mutate((db) => {
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    const mutableConflict = db.conflicts.find((candidate) => candidate.vault_id === vaultId && candidate.conflict_id === conflictId);
    if (!vault || !mutableConflict) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }
    const device = db.devices.find((candidate) => candidate.device_id === mutableConflict.device_id);
    const timestamp = new Date().toISOString();
    vault.current_main = resolutionCommit;
    vault.updated_at = timestamp;
    mutableConflict.status = 'resolved';
    mutableConflict.resolved_at = timestamp;
    mutableConflict.resolution_kind = 'keep_server';
    mutableConflict.resolution_commit = resolutionCommit;
    if (device && device.status !== 'revoked') {
      device.status = 'synced';
      device.last_successful_sync_at = timestamp;
    }
    server.store.appendEvent(db, {
      event_type: 'main_advanced',
      vault_id: vaultId,
      resource_ids: {
        conflict_id: conflictId,
        device_id: mutableConflict.device_id
      },
      commit_cursors: {
        previous_main: conflict.expected_main,
        main: resolutionCommit,
        device_commit: mutableConflict.device_commit
      },
      payload: {
        decision: 'resolved',
        conflict_id: conflictId,
        resolution_kind: 'keep_server'
      }
    });
    server.store.appendEvent(db, {
      event_type: 'conflict_resolved',
      vault_id: vaultId,
      resource_ids: {
        conflict_id: conflictId,
        device_id: mutableConflict.device_id
      },
      commit_cursors: {
        main: resolutionCommit,
        previous_main: conflict.expected_main,
        device_commit: mutableConflict.device_commit
      },
      payload: {
        resolution_kind: 'keep_server'
      }
    });
  });
  return resolutionCommit;
}

async function importServerMainIntoClient(
  client: ObtsPluginClient,
  vaultDir: string,
  vaultId: string,
  deviceId: string,
  currentLocalMain: string | null
): Promise<void> {
  const token = JSON.parse(await readFile(join(vaultDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as { device_token: string };
  const internals = client as unknown as {
    transport: {
      pull(input: {
        vaultId: string;
        deviceId: string;
        deviceToken: string;
        currentLocalMain: string | null;
      }): Promise<{ packfile: Buffer }>;
    };
    git: { importPack(packfile: Buffer): Promise<void> };
  };
  const pulled = await internals.transport.pull({
    vaultId,
    deviceId,
    deviceToken: token.device_token,
    currentLocalMain
  });
  await internals.git.importPack(pulled.packfile);
}

async function prepareRenameConflict(
  admin: BrowserSession,
  root: string,
  prefix: string,
  extraBaseFiles: Record<string, string> = {}
): Promise<{ result: Awaited<ReturnType<ObtsPluginClient['syncOnce']>> }> {
  const desktopDir = join(root, `${prefix}-desktop`);
  const tabletDir = join(root, `${prefix}-tablet`);
  await mkdir(desktopDir, { recursive: true });
  await mkdir(tabletDir, { recursive: true });

  const desktop = await pairPlugin(admin, desktopDir, `${prefix}-desktop`);
  await writeFile(join(desktopDir, 'Old.md'), 'base\n');
  for (const [path, content] of Object.entries(extraBaseFiles)) {
    await writeFile(join(desktopDir, path), content);
  }
  expect((await desktop.syncOnce()).status).toBe('Synced');

  const tablet = await pairPlugin(admin, tabletDir, `${prefix}-tablet`);
  expect(await readFile(join(tabletDir, 'Old.md'), 'utf8')).toBe('base\n');
  await writeFile(join(tabletDir, `${prefix}-tablet-ref.md`), 'tablet ref\n');
  expect((await tablet.syncOnce()).status).toBe('Synced');
  expect((await desktop.syncOnce()).status).toBe('Synced');

  await rename(join(desktopDir, 'Old.md'), join(desktopDir, 'Title A.md'));
  await rename(join(tabletDir, 'Old.md'), join(tabletDir, 'Title B.md'));
  expect((await desktop.syncOnce()).status).toBe('Synced');
  const result = await tablet.syncOnce();
  expect(result.status).toBe('Review needed');
  return { result };
}

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
  const plugin = new ObtsPluginClient(vaultDir, {
    serverUrl: admin.baseUrl,
    deviceName
  });
  const connection = await plugin.startOnboarding('Test Vault');
  const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
    selection: 'existing_vault',
    vault_id: admin.vaultId
  });
  expect(approval.status).toBe(200);
  const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  const mode =
    analysis.classification === 'independent_divergent' || analysis.classification === 'shared_baseline_divergent'
      ? 'merge'
      : 'use_server';
  await plugin.finishOnboarding({
    connectionId: connection.connection_id,
    secret: connection.connection_secret,
    analysis,
    mode
  });
  return plugin;
}
