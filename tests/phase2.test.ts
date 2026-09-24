import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient, TransportError } from '../obsidian-plugin/src/core/client.js';
import type { ApplyJournal } from '../obsidian-plugin/src/core/recovery.js';
import { createObtsServer, repairVaultIntegrity, type ObtsServer } from '../src/server/app.js';
import type { MetadataDb } from '../src/server/metadataStore.js';

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

  async function createStaleConflictFixture(prefix: string, existingAdmin?: BrowserSession): Promise<{
    admin: BrowserSession;
    conflictId: string;
    previousMain: string;
    refreshedMain: string;
    deviceCommit: string;
  }> {
    const admin = existingAdmin ?? await setupAdminAndVault(baseUrl);
    if (existingAdmin) {
      const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: `Vault ${prefix}` });
      expect(vault.status).toBe(201);
      admin.vaultId = vault.body.vault_id;
    }
    const desktopDir = join(root, `${prefix}-desktop`);
    const tabletDir = join(root, `${prefix}-tablet`);
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, `${prefix}-desktop`);
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const tablet = await pairPlugin(admin, tabletDir, `${prefix}-tablet`);
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const conflictResult = await tablet.syncOnce();
    expect(conflictResult.status).toBe('Conflict resolution needed');
    expect(conflictResult.conflictId).toMatch(/^conf_/u);
    const review = await admin.get<{ current_main: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflictResult.conflictId}`
    );
    expect(review.status).toBe(200);
    await writeFile(join(desktopDir, 'unrelated.md'), 'new server content\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const refreshedDb = await server.store.snapshot();
    const refreshedMain = refreshedDb.vaults.find((vault) => vault.vault_id === admin.vaultId)?.current_main;
    const deviceCommit = refreshedDb.conflicts.find((conflict) => conflict.conflict_id === conflictResult.conflictId)?.device_commit;
    expect(refreshedMain).toMatch(/^[0-9a-f]{40}$/u);
    expect(deviceCommit).toMatch(/^[0-9a-f]{40}$/u);
    return {
      admin,
      conflictId: conflictResult.conflictId!,
      previousMain: review.body.current_main,
      refreshedMain: refreshedMain!,
      deviceCommit: deviceCommit!
    };
  }

  async function createConsumedResolutionFixture(prefix: string): Promise<{
    admin: BrowserSession;
    tablet: ObtsPluginClient;
    tabletDir: string;
    preResolutionMain: string;
    deviceCommit: string;
    resolutionCommit: string;
    currentEventSeq: number;
  }> {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, `${prefix}-desktop`);
    const tabletDir = join(root, `${prefix}-tablet`);
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, `${prefix}-desktop`);
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, `${prefix}-tablet`);
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'selected device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const conflicted = await tablet.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');
    const conflictState = await tablet.readState();
    const conflictQueue = await tablet.readQueue();
    expect(conflictQueue).toMatchObject({
      status: 'conflicted',
      pending_commit: conflictState.local_head
    });
    if (!conflictState.local_main || !conflictState.local_head) {
      throw new Error('Conflict state did not preserve both local cursors.');
    }

    const review = await admin.get<{ conflict: { expected_main: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`
    );
    expect(review.status).toBe(200);
    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'use_device' }
    );
    expect(resolved.status).toBe(200);

    const db = await server.store.snapshot();
    const currentEventSeq = db.event_seq_by_vault[admin.vaultId] ?? 0;
    const device = db.devices.find((candidate) => candidate.device_id === conflictState.device_id);
    const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
    expect(device).toMatchObject({
      status: 'synced',
      device_ref_head: conflictState.local_head,
      last_applied_main: conflictState.local_main
    });
    expect(vault?.current_main).toBe(resolved.body.resolution_commit);
    expect(db.events.filter((event) => event.vault_id === admin.vaultId && event.event_seq > currentEventSeq)).toEqual([]);
    expect((await server.git.readBlobAtPath(admin.vaultId, conflictState.local_head, 'shared.md')).toString('utf8')).toBe(
      'selected device version\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
      'selected device version\n'
    );

    const internal = tablet.client as any;
    await internal.writeQueue({
      pending_commit: null,
      expected_device_ref: device?.device_ref_head ?? conflictState.local_head,
      status: 'idle',
      attempts: 0,
      change_seq: conflictQueue.change_seq,
      changed_paths: [],
      updated_at: new Date().toISOString()
    });
    await tablet.writeState({
      ...conflictState,
      server_device_ref: device?.device_ref_head ?? conflictState.local_head,
      status_label: 'Behind',
      last_error_code: null,
      last_event_seq: currentEventSeq,
      updated_at: new Date().toISOString()
    });
    expect(await tablet.readState()).toMatchObject({
      local_main: conflictState.local_main,
      local_head: conflictState.local_head,
      server_device_ref: conflictState.local_head,
      status_label: 'Behind',
      last_error_code: null,
      last_event_seq: currentEventSeq,
      last_applied_event_seq: conflictState.last_applied_event_seq
    });
    expect(await tablet.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'idle',
      changed_paths: []
    });

    return {
      admin,
      tablet,
      tabletDir,
      preResolutionMain: conflictState.local_main,
      deviceCommit: conflictState.local_head,
      resolutionCommit: resolved.body.resolution_commit,
      currentEventSeq
    };
  }

  function rewindConflictRefreshMetadata(
    db: MetadataDb,
    beforeRefresh: MetadataDb,
    conflictId: string,
    operationId: string
  ): void {
    const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === conflictId);
    const originalConflict = beforeRefresh.conflicts.find((candidate) => candidate.conflict_id === conflictId);
    expect(operation).toBeDefined();
    expect(conflict).toBeDefined();
    expect(originalConflict).toBeDefined();
    operation!.status = 'prepared';
    operation!.result = null;
    Object.assign(conflict!, structuredClone(originalConflict!));
    const originalEventIds = new Set(beforeRefresh.events.map((event) => event.event_id));
    const originalAuditIds = new Set(beforeRefresh.audit_log.map((audit) => audit.audit_id));
    db.events = db.events.filter((event) => originalEventIds.has(event.event_id));
    db.audit_log = db.audit_log.filter((audit) => originalAuditIds.has(audit.audit_id));
    db.event_seq_by_vault = structuredClone(beforeRefresh.event_seq_by_vault);
  }

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
    expect(result.status).toBe('Conflict resolution needed');

    const review = await admin.get<{
      conflict: { conflict_id: string; expected_main: string; device_commit: string };
      stale: boolean;
      path_conflicts: Array<{ group_id: string; kind: string; affected_paths: string[] }>;
      files: Array<{
        path: string;
        content_kind: 'text' | 'binary';
        server_content: string;
        device_content: string;
        server_bytes: number;
        device_bytes: number;
        server_sha256: string;
        device_sha256: string;
        source_diff: string;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.stale).toBe(false);
    expect(review.body.path_conflicts).toEqual([
      expect.objectContaining({ group_id: expect.stringMatching(/^[0-9a-f]{20}$/u), kind: 'same_path', affected_paths: ['shared.md'] })
    ]);
    expect(review.body.files[0]).toMatchObject({
      path: 'shared.md',
      content_kind: 'text',
      server_content: 'server version\n',
      device_content: 'device version\n',
      server_bytes: 15,
      device_bytes: 15,
      server_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      device_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
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

  it('routes concurrent directory recreation to the dashboard and applies the server decision', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'directory-conflict-source');
    const receiverDir = join(root, 'directory-conflict-receiver');
    await mkdir(join(sourceDir, 'Scratch'), { recursive: true });
    await mkdir(receiverDir, { recursive: true });
    await writeFile(join(sourceDir, 'base.md'), 'base\n');
    const source = await pairPlugin(admin, sourceDir, 'directory-conflict-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'directory-conflict-receiver');
    expect(await isDirectory(join(receiverDir, 'Scratch'))).toBe(true);

    await rm(join(receiverDir, 'Scratch'), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(join(receiverDir, 'Scratch'));
    await rm(join(sourceDir, 'Scratch'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');

    const conflicted = await receiver.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');
    expect(conflicted.conflictId).toMatch(/^conf_/u);
    const review = await admin.get<{
      conflict: { expected_main: string; conflict_kind: string };
      files: unknown[];
      directory_conflicts: Array<{ root: string; server_state: string; device_state: string }>;
      choices: string[];
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      conflict: { conflict_kind: 'directory' },
      files: [],
      directory_conflicts: [{ root: 'Scratch', server_state: 'deleted', device_state: 'present' }],
      choices: ['keep_server', 'use_device']
    });

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'keep_server' }
    );
    expect(resolved.status).toBe(200);
    expect(await receiver.pollRemoteEventsAndApply()).toMatchObject({ applied: true, status: 'Synced' });
    expect(await isDirectory(join(receiverDir, 'Scratch'))).toBe(false);
    expect((JSON.parse(await readFile(join(receiverDir, '.obts', 'directory-state.json'), 'utf8')) as { pending_intents: unknown[] }).pending_intents).toEqual([]);
    const finalMetadata = await server.store.snapshot();
    expect(finalMetadata.directory_state_by_vault[admin.vaultId]?.explicit_dirs).not.toContain('Scratch');
    expect(finalMetadata.directory_proposal_results.some((result) => result.conflict_id === conflicted.conflictId)).toBe(false);
  });

  it('can keep a concurrently recreated directory through dashboard resolution', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const sourceDir = join(root, 'directory-device-source');
    const receiverDir = join(root, 'directory-device-receiver');
    await mkdir(join(sourceDir, 'Scratch'), { recursive: true });
    await mkdir(receiverDir, { recursive: true });
    await writeFile(join(sourceDir, 'base.md'), 'base\n');
    const source = await pairPlugin(admin, sourceDir, 'directory-device-source');
    expect((await source.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    const receiver = await pairPlugin(admin, receiverDir, 'directory-device-receiver');

    await rm(join(receiverDir, 'Scratch'), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(join(receiverDir, 'Scratch'));
    await rm(join(sourceDir, 'Scratch'), { recursive: true, force: true });
    expect((await source.syncOnce()).status).toBe('Synced');

    const conflicted = await receiver.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');

    // Both server-only and device-only descendants must survive directory-only resolution.
    await forceConflictDeviceFile(server, admin.vaultId, conflicted.conflictId!, 'Scratch/local.md', 'device-only\n');
    await forceServerFileCommit(server, admin.vaultId, 'Scratch/server.md', 'server-only\n');
    const stale = await admin.get<{ stale: boolean }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`
    );
    expect(stale.body.stale).toBe(true);
    const review = await admin.post<{
      conflict: { expected_main: string; affected_paths: string[]; conflict_kind: string };
      directory_conflicts: unknown[];
      choices: string[];
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/refresh`, {});
    expect(review.body).toMatchObject({
      conflict: { affected_paths: ['Scratch'], conflict_kind: 'directory' },
      directory_conflicts: [{ root: 'Scratch', server_state: 'deleted', device_state: 'present' }],
      choices: ['keep_server', 'use_device']
    });
    expect(
      (await server.git.readBlobAtPathIfPresent(admin.vaultId, review.body.conflict.expected_main, 'Scratch/server.md'))?.toString('utf8')
    ).toBe('server-only\n');
    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'use_device' }
    );
    expect(resolved.status).toBe(200);
    expect(
      (await server.git.readBlobAtPathIfPresent(admin.vaultId, resolved.body.resolution_commit, 'Scratch/server.md'))?.toString('utf8')
    ).toBe('server-only\n');
    expect(
      (await server.git.readBlobAtPathIfPresent(admin.vaultId, resolved.body.resolution_commit, 'Scratch/local.md'))?.toString('utf8')
    ).toBe('device-only\n');
    expect(await receiver.pollRemoteEventsAndApply()).toMatchObject({ applied: true, status: 'Synced' });
    expect(await isDirectory(join(receiverDir, 'Scratch'))).toBe(true);
    expect(await readFile(join(receiverDir, 'Scratch', 'server.md'), 'utf8')).toBe('server-only\n');
    expect(await readFile(join(receiverDir, 'Scratch', 'local.md'), 'utf8')).toBe('device-only\n');
    expect((await server.store.snapshot()).directory_state_by_vault[admin.vaultId]?.explicit_dirs).toContain('Scratch');
    expect((await source.syncOnce()).status).toBe('Synced');
    expect(await isDirectory(join(sourceDir, 'Scratch'))).toBe(true);
  });

  it('resumes onboarding conflict review without resubmitting or losing a reconstructed same-tree proposal', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const serverDir = join(root, 'onboarding-server');
    const phoneDir = join(root, 'onboarding-phone');
    await mkdir(serverDir, { recursive: true });
    await mkdir(phoneDir, { recursive: true });
    const desktop = await pairPlugin(admin, serverDir, 'desktop');
    await writeFile(join(serverDir, 'shared.md'), 'server version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await writeFile(join(phoneDir, 'shared.md'), 'phone version\n');

    const phone = new ObtsPluginClient(phoneDir, { serverUrl: baseUrl, deviceName: 'phone' });
    const connection = await phone.startOnboarding('Phone Vault');
    expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    })).status).toBe(200);
    const analysis = await phone.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    const submit = {
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: 'merge' as const
    };
    const conflicted = await phone.finishOnboarding(submit);
    expect(conflicted.status).toBe('Conflict resolution needed');
    const firstState = await phone.readState();
    expect(firstState.server_device_ref).toMatch(/^[0-9a-f]{40}$/u);
    const proposalEventsBeforeRetry = (await server.store.snapshot()).events.filter(
      (event) => event.event_type === 'device_ref_updated' && event.resource_ids.device_id === firstState.device_id
    ).length;
    const identityJournal = (await phone.readPendingOnboarding())!;
    await expect(phone.finishOnboarding({ ...submit, mode: 'use_server' })).rejects.toMatchObject({
      code: 'onboarding_identity_mismatch'
    });
    expect((await phone.readPendingOnboarding())?.journal).toMatchObject({
      stage: 'awaiting_conflict',
      selected_mode: 'merge'
    });
    await writeFile(join(phoneDir, '.obts', 'onboarding.json'), `${JSON.stringify({
      ...identityJournal.journal,
      registered_device_id: 'dev_00000000000000000000000000000000'
    }, null, 2)}\n`);
    await expect(phone.finishOnboarding(submit)).rejects.toMatchObject({ code: 'onboarding_identity_mismatch' });
    await writeFile(join(phoneDir, '.obts', 'onboarding.json'), `${JSON.stringify(identityJournal.journal, null, 2)}\n`);

    await expect(phone.finishOnboarding(submit)).resolves.toMatchObject({ status: 'Conflict resolution needed' });
    expect((await phone.readPendingOnboarding())?.journal.stage).toBe('awaiting_conflict');
    expect((await server.store.snapshot()).events.filter(
      (event) => event.event_type === 'device_ref_updated' && event.resource_ids.device_id === firstState.device_id
    )).toHaveLength(proposalEventsBeforeRetry);

    const review = await admin.get<{ conflict: { conflict_id: string; expected_main: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`
    );
    expect(review.status).toBe(200);
    const resumableJournal = (await phone.readPendingOnboarding())!;
    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'keep_server' }
    );
    expect(resolved.status).toBe(200);

    expect(await phone.pollRemoteEventsAndApply()).toMatchObject({ applied: true, status: 'Synced' });
    await expect(phone.finishOnboarding(submit)).resolves.toMatchObject({
      status: 'Synced',
      main: resolved.body.resolution_commit
    });
    expect(await phone.readPendingOnboarding()).toBeNull();

    await writeFile(join(phoneDir, '.obts', 'auth', 'pending-connection.json'), `${JSON.stringify({
      connection_secret: resumableJournal.secret,
      created_at: new Date().toISOString()
    }, null, 2)}\n`);
    await writeFile(join(phoneDir, 'shared.md'), 'phone version\n');
    const git = (phone as unknown as { git: { setLocalHead(commit: string): Promise<void>; createLocalCommit(message: string): Promise<string | null> } }).git;
    await git.setLocalHead(analysis.proposalBase!);
    const duplicateCommit = await git.createLocalCommit('obts: reconstructed onboarding proposal');
    expect(duplicateCommit).toMatch(/^[0-9a-f]{40}$/u);
    const now = new Date().toISOString();
    await writeFile(join(phoneDir, '.obts', 'state.json'), `${JSON.stringify({
      ...firstState,
      server_device_ref: null,
      local_main: analysis.proposalBase,
      local_head: duplicateCommit,
      status_label: 'Uploading',
      last_error_code: null,
      updated_at: now
    }, null, 2)}\n`);
    await writeFile(join(phoneDir, '.obts', 'queue.json'), `${JSON.stringify({
      pending_commit: duplicateCommit,
      expected_device_ref: null,
      status: 'uploading',
      attempts: 2,
      updated_at: now
    }, null, 2)}\n`);
    await writeFile(join(phoneDir, '.obts', 'onboarding.json'), `${JSON.stringify({
      ...resumableJournal.journal,
      stage: 'blocked',
      last_error_code: 'stale_device_ref',
      updated_at: now
    }, null, 2)}\n`);

    const resumed = await phone.finishOnboarding(submit);
    expect(resumed).toMatchObject({ status: 'Synced', main: resolved.body.resolution_commit });
    expect(await readFile(join(phoneDir, 'shared.md'), 'utf8')).toBe('server version\n');
    expect(await phone.readPendingOnboarding()).toBeNull();
    expect(JSON.parse(await readFile(join(phoneDir, '.obts', 'queue.json'), 'utf8'))).toMatchObject({
      pending_commit: null,
      status: 'idle'
    });
    expect((await server.store.snapshot()).events.filter(
      (event) => event.event_type === 'device_ref_updated' && event.resource_ids.device_id === firstState.device_id
    )).toHaveLength(proposalEventsBeforeRetry);
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
    const { result } = await prepareRenameConflict(admin, root, 'rename-manual', {
      'Existing.md': 'do not overwrite\n',
      'folder/unrelated.md': 'keep descendant\n',
      plain: 'keep ancestor\n'
    });

    const review = await admin.get<{
      conflict: { expected_main: string };
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);

    for (const path of ['Existing.md', 'folder', 'plain/child.md']) {
      const collision = await admin.post<{ error: { code: string } }>(
        `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
        {
          expected_main: review.body.conflict.expected_main,
          resolution_kind: 'manual',
          manual_file_plan: [
            { path: 'Old.md', content: null },
            { path: 'Title A.md', content: null },
            { path: 'Title B.md', content: null },
            { path, content: 'overwrite attempt\n' }
          ]
        }
      );
      expect(collision.status).toBe(400);
      expect(collision.body.error.code).toBe('invalid_resolution');
    }

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
      'folder/unrelated.md',
      'plain',
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
    expect(result.status).toBe('Conflict resolution needed');

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
    expect(result.status).toBe('Conflict resolution needed');
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
    expect(result.status).toBe('Conflict resolution needed');

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
    expect(result.status).toBe('Conflict resolution needed');

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

  it('classifies binary conflicts without lossy text decoding and preserves selected bytes', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-binary-review');
    const tabletDir = join(root, 'tablet-binary-review');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop-binary-review');
    await writeFile(join(desktopDir, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet-binary-review');
    await writeFile(join(desktopDir, 'asset.bin'), Buffer.from([0, 4, 5, 6]));
    await writeFile(join(tabletDir, 'asset.bin'), Buffer.from([0, 7, 8, 9]));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const result = await tablet.syncOnce();
    expect(result.status).toBe('Conflict resolution needed');

    const review = await admin.get<{
      conflict: { expected_main: string };
      files: Array<{
        content_kind: string;
        base_content: string | null;
        server_content: string | null;
        device_content: string | null;
        base_bytes: number;
        server_bytes: number;
        device_bytes: number;
        source_diff: string;
      }>;
    }>(`/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}`);
    expect(review.status).toBe(200);
    expect(review.body.files[0]).toMatchObject({
      content_kind: 'binary',
      base_content: null,
      server_content: null,
      device_content: null,
      base_bytes: 4,
      server_bytes: 4,
      device_bytes: 4,
      source_diff: 'Binary preview unavailable.'
    });

    for (const body of [
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'insert_both_blocks' },
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'manual', manual_files: { 'asset.bin': 'unsafe text' } }
    ]) {
      const rejected = await admin.post<{ error: { code: string } }>(
        `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
        body
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('invalid_resolution');
    }

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'use_device' }
    );
    expect(resolved.status).toBe(200);
    expect(await server.git.readBlobAtPath(admin.vaultId, resolved.body.resolution_commit, 'asset.bin')).toEqual(
      Buffer.from([0, 7, 8, 9])
    );
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
    expect(result.status).toBe('Conflict resolution needed');

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
    expect(await server.git.getRef(admin.vaultId, `refs/obts/conflicts/${result.conflictId}/current`)).toBe(
      refreshed.body.current_main
    );
    expect((await server.store.snapshot()).sync_operations.findLast(
      (operation) => operation.operation_type === 'conflict_refresh'
    )).toMatchObject({
      status: 'committed',
      expected_refs: {
        [`refs/obts/conflicts/${result.conflictId}/current`]: review.body.current_main
      },
      target_refs: {
        [`refs/obts/conflicts/${result.conflictId}/current`]: refreshed.body.current_main
      },
      result: {
        decision: 'refreshed',
        conflict_id: result.conflictId,
        refreshed_main: refreshed.body.current_main
      }
    });
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect((await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)?.status).toBe('active');

    const refreshedResolved = await admin.post<{ status: string; resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${result.conflictId}/resolve`,
      {
        expected_main: refreshed.body.expected_main,
        resolution_kind: 'use_device'
      }
    );
    expect(refreshedResolved.status).toBe(200);
    expect(refreshedResolved.body.status).toBe('resolved');
    const resolvedConflictRecord = (await server.store.snapshot()).conflicts.find(
      (conflict) => conflict.conflict_id === result.conflictId
    );
    expect(resolvedConflictRecord).toBeDefined();
    expect((await server.git.readBlobAtPath(admin.vaultId, review.body.current_main, 'shared.md')).toString('utf8')).toBe('server version\n');
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshed.body.current_main, 'shared.md')).toString('utf8')).toBe('server version\n');
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshed.body.current_main, 'unrelated.md')).toString('utf8')).toBe(
      'accepted while review is open\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, resolvedConflictRecord!.device_commit, 'shared.md')).toString('utf8')).toBe(
      'device version\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshedResolved.body.resolution_commit, 'shared.md')).toString('utf8')).toBe(
      'device version\n'
    );
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshedResolved.body.resolution_commit, 'unrelated.md')).toString('utf8')).toBe(
      'accepted while review is open\n'
    );

    const protectedCurrentRef = `refs/obts/conflicts/${result.conflictId}/current`;
    await server.git.updateRef(admin.vaultId, protectedCurrentRef, review.body.current_main, refreshed.body.current_main);
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      expect(vault).toBeDefined();
      vault!.status = 'blocked_integrity';
    });
    await repairVaultIntegrity(server.store, server.git, admin.vaultId);
    expect((await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)).toMatchObject({
      status: 'active',
      current_main: refreshedResolved.body.resolution_commit
    });
    expect((await server.git.readBlobAtPath(admin.vaultId, review.body.current_main, 'shared.md')).toString('utf8')).toBe('server version\n');
    expect((await server.git.readBlobAtPath(admin.vaultId, refreshed.body.current_main, 'unrelated.md')).toString('utf8')).toBe(
      'accepted while review is open\n'
    );
  });

  it('rejects conflict refresh and resolution while the vault is integrity-blocked', async () => {
    const fixture = await createStaleConflictFixture('blocked-conflict-actions');
    const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
    const beforeRef = await server.git.getRef(fixture.admin.vaultId, protectedRef);
    const beforeDb = await server.store.snapshot();
    const beforeConflict = beforeDb.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId);
    const beforeOperationCount = beforeDb.sync_operations.length;
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === fixture.admin.vaultId);
      expect(vault).toBeDefined();
      vault!.status = 'blocked_integrity';
    });

    const refresh = await fixture.admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
      {}
    );
    expect(refresh.status).toBe(409);
    expect(refresh.body.error.code).toBe('blocked_integrity');
    const resolve = await fixture.admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/resolve`,
      { expected_main: fixture.refreshedMain, resolution_kind: 'use_device' }
    );
    expect(resolve.status).toBe(409);
    expect(resolve.body.error.code).toBe('blocked_integrity');

    const afterDb = await server.store.snapshot();
    expect(afterDb.sync_operations).toHaveLength(beforeOperationCount);
    expect(afterDb.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.current_main).toBe(fixture.refreshedMain);
    expect(afterDb.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
      status: beforeConflict?.status,
      current_main: beforeConflict?.current_main,
      expected_main: beforeConflict?.expected_main
    });
    expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(beforeRef);
  });

  it('rolls forward every prepared conflict-resolution effect after main moves', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'recover-conflict-resolution-desktop');
    const tabletDir = join(root, 'recover-conflict-resolution-tablet');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'recover-conflict-resolution-desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const tablet = await pairPlugin(admin, tabletDir, 'recover-conflict-resolution-tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const conflicted = await tablet.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');

    const review = await admin.get<{ conflict: { expected_main: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`
    );
    expect(review.status).toBe(200);
    const beforeResolution = await server.store.snapshot();
    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'keep_server' }
    );
    expect(resolved.status).toBe(200);

    const committedDb = await server.store.snapshot();
    const resolutionOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'conflict_resolve'
    );
    const committedConflict = committedDb.conflicts.find(
      (conflict) => conflict.conflict_id === conflicted.conflictId
    );
    expect(resolutionOperation).toMatchObject({
      status: 'committed',
      prepared_manifest: { actor_user_id: expect.any(String) }
    });
    expect(committedConflict).toMatchObject({
      status: 'resolved',
      resolved_by_user_id: expect.any(String)
    });
    const actorUserId = committedConflict!.resolved_by_user_id;
    const deviceId = committedConflict!.device_id;

    await server.store.mutate((db) => {
      const operation = db.sync_operations.find(
        (candidate) => candidate.operation_id === resolutionOperation!.operation_id
      );
      const vault = db.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      const conflict = db.conflicts.find((candidate) => candidate.conflict_id === conflicted.conflictId);
      const device = db.devices.find((candidate) => candidate.device_id === deviceId);
      const originalVault = beforeResolution.vaults.find((candidate) => candidate.vault_id === admin.vaultId);
      const originalConflict = beforeResolution.conflicts.find((candidate) => candidate.conflict_id === conflicted.conflictId);
      const originalDevice = beforeResolution.devices.find((candidate) => candidate.device_id === deviceId);
      expect(operation).toBeDefined();
      expect(vault).toBeDefined();
      expect(conflict).toBeDefined();
      expect(device).toBeDefined();
      expect(originalVault).toBeDefined();
      expect(originalConflict).toBeDefined();
      expect(originalDevice).toBeDefined();
      operation!.status = 'prepared';
      operation!.result = null;
      Object.assign(vault!, structuredClone(originalVault!));
      Object.assign(conflict!, structuredClone(originalConflict!));
      Object.assign(device!, structuredClone(originalDevice!));
      db.events = structuredClone(beforeResolution.events);
      db.audit_log = structuredClone(beforeResolution.audit_log);
      db.event_seq_by_vault = structuredClone(beforeResolution.event_seq_by_vault);
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    const recoveredDb = await server.store.snapshot();
    expect(recoveredDb.vaults.find((vault) => vault.vault_id === admin.vaultId)).toMatchObject({
      status: 'active',
      current_main: resolved.body.resolution_commit
    });
    expect(recoveredDb.conflicts.find((conflict) => conflict.conflict_id === conflicted.conflictId)).toMatchObject({
      status: 'resolved',
      resolved_by_user_id: actorUserId,
      resolution_kind: 'keep_server',
      resolution_commit: resolved.body.resolution_commit,
      resolution_request_hash: expect.any(String)
    });
    expect(recoveredDb.devices.find((device) => device.device_id === deviceId)).toMatchObject({
      status: 'synced',
      last_successful_sync_at: expect.any(String)
    });
    expect(recoveredDb.sync_operations.find(
      (operation) => operation.operation_id === resolutionOperation!.operation_id
    )).toMatchObject({
      status: 'committed',
      result: {
        decision: 'resolved',
        conflict_id: conflicted.conflictId,
        resolution_kind: 'keep_server',
        resolution_commit: resolved.body.resolution_commit,
        reconciled_after_startup: true
      }
    });
    const recoveredEvents = recoveredDb.events.filter(
      (event) => event.resource_ids.conflict_id === conflicted.conflictId && event.payload.reconciled_after_startup === true
    );
    expect(recoveredEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'main_advanced',
        payload: expect.objectContaining({
          conflict_id: conflicted.conflictId,
          resolution_kind: 'keep_server'
        })
      }),
      expect.objectContaining({
        event_type: 'conflict_resolved',
        payload: expect.objectContaining({ resolution_kind: 'keep_server' })
      })
    ]));
    expect(recoveredDb.audit_log).toContainEqual(expect.objectContaining({
      actor_user_id: actorUserId,
      actor_device_id: null,
      vault_id: admin.vaultId,
      action: 'conflict_resolved',
      resource_class: 'conflict',
      resource_id: conflicted.conflictId
    }));
  });

  it('rolls forward a prepared conflict refresh when startup finds its protected ref already moved', async () => {
    const fixture = await createStaleConflictFixture('recover-conflict-refresh');
    const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
    const beforeRefresh = await server.store.snapshot();
    const refreshed = await fixture.admin.post<{ current_main: string }>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
      {}
    );
    expect(refreshed.status).toBe(200);
    const committedDb = await server.store.snapshot();
    const refreshOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'conflict_refresh'
    );
    expect(refreshOperation).toBeDefined();
    await server.store.mutate((db) => {
      rewindConflictRefreshMetadata(db, beforeRefresh, fixture.conflictId, refreshOperation!.operation_id);
    });
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    const recoveredDb = await server.store.snapshot();
    expect(recoveredDb.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.status).toBe('active');
    expect(recoveredDb.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
      current_main: fixture.refreshedMain,
      expected_main: fixture.refreshedMain
    });
    expect(recoveredDb.sync_operations.find((operation) => operation.operation_id === refreshOperation!.operation_id)).toMatchObject({
      status: 'committed',
      result: {
        decision: 'refreshed',
        refreshed_main: fixture.refreshedMain,
        reconciled_after_startup: true
      }
    });
    expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.refreshedMain);
    expect(recoveredDb.events.some(
      (event) => event.event_type === 'conflict_review_refreshed' && event.payload.reconciled_after_startup === true
    )).toBe(true);
  });

  it('aborts a prepared conflict refresh when startup finds its protected ref did not move', async () => {
    const fixture = await createStaleConflictFixture('abort-conflict-refresh');
    const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
    const beforeRefresh = await server.store.snapshot();
    const refreshed = await fixture.admin.post<Json>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
      {}
    );
    expect(refreshed.status).toBe(200);
    const committedDb = await server.store.snapshot();
    const refreshOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'conflict_refresh'
    );
    expect(refreshOperation).toBeDefined();
    await server.git.updateRef(fixture.admin.vaultId, protectedRef, fixture.previousMain, fixture.refreshedMain);
    await server.store.mutate((db) => {
      rewindConflictRefreshMetadata(db, beforeRefresh, fixture.conflictId, refreshOperation!.operation_id);
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    const recoveredDb = await server.store.snapshot();
    expect(recoveredDb.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.status).toBe('active');
    expect(recoveredDb.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
      current_main: fixture.previousMain,
      expected_main: fixture.previousMain
    });
    expect(recoveredDb.sync_operations.find((operation) => operation.operation_id === refreshOperation!.operation_id)).toMatchObject({
      status: 'aborted',
      result: { reason: 'startup_prepared_ref_not_moved' }
    });
    expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.previousMain);
  });

  it('classifies conflict refresh ref-update failures without stranding moved refs', async () => {
    let admin: BrowserSession | undefined;
    for (const mode of ['before_move', 'after_move'] as const) {
      const fixture = await createStaleConflictFixture(`refresh-ref-failure-${mode}`, admin);
      admin = fixture.admin;
      const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
      const originalUpdateRef = server.git.updateRef.bind(server.git);
      server.git.updateRef = async (vaultId, ref, target, expected) => {
        if (ref !== protectedRef) {
          await originalUpdateRef(vaultId, ref, target, expected);
          return;
        }
        if (mode === 'after_move') await originalUpdateRef(vaultId, ref, target, expected);
        throw new Error(`injected ${mode} failure`);
      };
      const refresh = await fixture.admin.post<Json>(
        `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
        {}
      );
      server.git.updateRef = originalUpdateRef;

      const db = await server.store.snapshot();
      const operation = db.sync_operations.findLast((candidate) => candidate.operation_type === 'conflict_refresh');
      if (mode === 'before_move') {
        expect(refresh.status).toBe(500);
        expect(operation).toMatchObject({
          status: 'aborted',
          result: { reason: 'conflict_refresh_ref_not_moved' }
        });
        expect(db.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
          current_main: fixture.previousMain,
          expected_main: fixture.previousMain
        });
        expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.previousMain);
      } else {
        expect(refresh.status).toBe(200);
        expect(operation).toMatchObject({ status: 'committed', result: { decision: 'refreshed' } });
        expect(db.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
          current_main: fixture.refreshedMain,
          expected_main: fixture.refreshedMain
        });
        expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.refreshedMain);
      }
      expect(db.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.status).toBe('active');
    }
  });

  it('blocks an online conflict refresh when its protected ref moves to a foreign commit', async () => {
    const fixture = await createStaleConflictFixture('foreign-conflict-refresh');
    const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
    const originalUpdateRef = server.git.updateRef.bind(server.git);
    server.git.updateRef = async (vaultId, ref, target, expected) => {
      if (ref !== protectedRef) {
        await originalUpdateRef(vaultId, ref, target, expected);
        return;
      }
      await originalUpdateRef(vaultId, ref, fixture.deviceCommit, expected);
      throw new Error('injected foreign ref movement');
    };
    const refresh = await fixture.admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
      {}
    );
    server.git.updateRef = originalUpdateRef;

    expect(refresh.status).toBe(409);
    expect(refresh.body.error.code).toBe('blocked_integrity');
    const db = await server.store.snapshot();
    expect(db.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.status).toBe('blocked_integrity');
    expect(db.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
      current_main: fixture.previousMain,
      expected_main: fixture.previousMain
    });
    expect(db.sync_operations.findLast((operation) => operation.operation_type === 'conflict_refresh')).toMatchObject({
      status: 'prepared',
      result: { reason: 'conflict refresh ref cannot be reconciled' }
    });
    expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.deviceCommit);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);
  });

  it('blocks startup when a prepared conflict refresh protected ref is neither expected nor target', async () => {
    const fixture = await createStaleConflictFixture('foreign-conflict-refresh-startup');
    const protectedRef = `refs/obts/conflicts/${fixture.conflictId}/current`;
    const beforeRefresh = await server.store.snapshot();
    const refreshed = await fixture.admin.post<Json>(
      `/api/v1/vaults/${fixture.admin.vaultId}/conflicts/${fixture.conflictId}/refresh`,
      {}
    );
    expect(refreshed.status).toBe(200);
    const committedDb = await server.store.snapshot();
    const refreshOperation = committedDb.sync_operations.findLast(
      (operation) => operation.operation_type === 'conflict_refresh'
    );
    expect(refreshOperation).toBeDefined();
    await server.git.updateRef(fixture.admin.vaultId, protectedRef, fixture.deviceCommit, fixture.refreshedMain);
    await server.store.mutate((db) => {
      rewindConflictRefreshMetadata(db, beforeRefresh, fixture.conflictId, refreshOperation!.operation_id);
    });

    await server.app.close();
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });

    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);
    const recoveredDb = await server.store.snapshot();
    expect(recoveredDb.vaults.find((vault) => vault.vault_id === fixture.admin.vaultId)?.status).toBe('blocked_integrity');
    expect(recoveredDb.conflicts.find((conflict) => conflict.conflict_id === fixture.conflictId)).toMatchObject({
      current_main: fixture.previousMain,
      expected_main: fixture.previousMain
    });
    expect(recoveredDb.sync_operations.find((operation) => operation.operation_id === refreshOperation!.operation_id)).toMatchObject({
      status: 'prepared',
      result: { reason: 'prepared operation target refs cannot be reconciled' }
    });
    expect(await server.git.getRef(fixture.admin.vaultId, protectedRef)).toBe(fixture.deviceCommit);
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
    expect(result.status).toBe('Conflict resolution needed');

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
      expect(result.status).toBe('Conflict resolution needed');

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
    expect(result.status).toBe('Conflict resolution needed');

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
    expect(result.status).toBe('Conflict resolution needed');

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
    expect((await tablet.syncOnce()).status).toBe('Conflict resolution needed');
    expect((await tablet.readState()).last_error_code).toBe('conflict_review_required');

    await writeFile(join(phoneDir, 'other.md'), 'unrelated accepted edit\n');
    expect((await phone.syncOnce()).status).toBe('Synced');

    const polled = await tablet.pollRemoteEventsAndApply();
    expect(polled).toMatchObject({ applied: false, status: 'Conflict resolution needed' });
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
    expect(result.status).toBe('Conflict resolution needed');
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

  it('applies canonical main after its conflict-resolution event was seen but not applied', async () => {
    const fixture = await createConsumedResolutionFixture('consumed-resolution');
    const internal = fixture.tablet.client as any;
    const originalUploadQueuedCommit = internal.uploadQueuedCommit.bind(internal);
    const originalGetDeviceSelf = internal.getDeviceSelf.bind(internal);
    let uploadAttempts = 0;
    let authoritativeChecks = 0;
    internal.uploadQueuedCommit = async (...args: unknown[]) => {
      uploadAttempts += 1;
      return await originalUploadQueuedCommit(...args);
    };
    internal.getDeviceSelf = async (...args: unknown[]) => {
      authoritativeChecks += 1;
      return await originalGetDeviceSelf(...args);
    };

    expect((await fixture.tablet.syncOnce()).status).toBe('Synced');
    expect(uploadAttempts).toBe(0);
    expect(authoritativeChecks).toBe(1);
    const converged = await fixture.tablet.readState();
    expect(converged).toMatchObject({
      local_main: fixture.resolutionCommit,
      local_head: fixture.resolutionCommit,
      server_device_ref: fixture.deviceCommit,
      status_label: 'Synced',
      last_error_code: null,
      last_event_seq: fixture.currentEventSeq,
      last_applied_event_seq: fixture.currentEventSeq
    });
    expect(await fixture.tablet.readQueue()).toMatchObject({
      pending_commit: null,
      expected_device_ref: fixture.deviceCommit,
      status: 'idle',
      changed_paths: []
    });
    expect(await readFile(join(fixture.tabletDir, 'shared.md'), 'utf8')).toBe('selected device version\n');
    const appliedDevice = (await server.store.snapshot()).devices.find(
      (candidate) => candidate.device_id === converged.device_id
    );
    expect(appliedDevice).toMatchObject({
      device_ref_head: fixture.deviceCommit,
      last_applied_main: fixture.resolutionCommit,
      last_applied_event_seq: fixture.currentEventSeq
    });

    expect((await fixture.tablet.syncOnce()).status).toBe('Synced');
    expect(uploadAttempts).toBe(0);
    expect(authoritativeChecks).toBe(1);
    expect(await readFile(join(fixture.tabletDir, 'shared.md'), 'utf8')).toBe('selected device version\n');
  });

  it('defers authoritative-main reconciliation when a local watcher hint is queued', async () => {
    const fixture = await createConsumedResolutionFixture('consumed-resolution-local-hint');
    await fixture.tablet.recordLocalChangeHint(['shared.md']);

    expect(await fixture.tablet.pollRemoteEventsAndApply()).toMatchObject({ applied: false, status: 'Ahead' });
    expect(await fixture.tablet.readState()).toMatchObject({
      local_main: fixture.preResolutionMain,
      local_head: fixture.deviceCommit,
      status_label: 'Ahead',
      last_error_code: null
    });
    expect(await fixture.tablet.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local',
      changed_paths: ['shared.md']
    });
    expect(await readFile(join(fixture.tabletDir, 'shared.md'), 'utf8')).toBe('selected device version\n');
  });

  it('preserves an unreported visible edit while deferring authoritative-main reconciliation', async () => {
    const fixture = await createConsumedResolutionFixture('consumed-resolution-missed-watcher');
    await writeFile(join(fixture.tabletDir, 'shared.md'), 'unreported newer local edit\n');

    expect(await fixture.tablet.pollRemoteEventsAndApply()).toMatchObject({ applied: false, status: 'Checking' });
    expect(await fixture.tablet.readState()).toMatchObject({
      local_main: fixture.preResolutionMain,
      local_head: fixture.deviceCommit,
      status_label: 'Checking',
      last_error_code: null
    });
    expect(await fixture.tablet.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local'
    });
    expect(await readFile(join(fixture.tabletDir, 'shared.md'), 'utf8')).toBe('unreported newer local edit\n');
    expect((await server.git.readBlobAtPath(fixture.admin.vaultId, fixture.resolutionCommit, 'shared.md')).toString('utf8')).toBe(
      'selected device version\n'
    );
  });

  it('reconciles a delayed device block after keep-server resolution without resetting the device', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'desktop-delayed-device-block');
    const tabletDir = join(root, 'tablet-delayed-device-block');
    await mkdir(desktopDir, { recursive: true });
    await mkdir(tabletDir, { recursive: true });
    const desktop = await pairPlugin(admin, desktopDir, 'desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');

    const tablet = await pairPlugin(admin, tabletDir, 'tablet');
    await writeFile(join(tabletDir, 'tablet-history.md'), 'establish tablet device history\n');
    expect((await tablet.syncOnce()).status).toBe('Synced');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    await writeFile(join(desktopDir, 'shared.md'), 'server version\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device version\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const conflicted = await tablet.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');
    const conflictState = await tablet.readState();

    const review = await admin.get<{ conflict: { conflict_id: string; expected_main: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}`
    );
    await tablet.writeState({ ...conflictState, status_label: 'Behind', last_error_code: null });

    let responseCaptured!: () => void;
    const responseCapturedPromise = new Promise<void>((resolve) => {
      responseCaptured = resolve;
    });
    let releaseResponse!: () => void;
    const responseRelease = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const originalPull = tablet.transport.pull;
    if (!originalPull) throw new Error('Pull transport is unavailable.');
    tablet.transport.pull = async (input: Record<string, unknown>) => {
      try {
        return await originalPull(input);
      } catch (error) {
        responseCaptured();
        await responseRelease;
        throw error;
      }
    };
    const delayedPull = tablet.pullAndApply({ allowDestructive: true }).then(
      () => null,
      (error: unknown) => error
    );
    await responseCapturedPromise;

    await server.store.mutate((db) => {
      const row = db.devices.find((candidate) => candidate.device_id === conflictState.device_id);
      if (!row) return;
      row.local_status_label = 'Needs recovery';
      row.local_error_code = 'device_blocked';
      row.local_queue_status = 'conflicted';
      row.local_main = conflictState.local_main;
      row.local_head = conflictState.local_head;
      row.last_status_report_at = new Date().toISOString();
    });
    const openDashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; local_error_code: string | null; blocked: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(openDashboard.body.devices.find((device) => device.device_name === 'tablet')).toMatchObject({
      status_label: 'Conflict resolution needed',
      local_error_code: null,
      blocked: true
    });

    const resolved = await admin.post<{ resolution_commit: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: review.body.conflict.expected_main, resolution_kind: 'keep_server' }
    );
    expect(resolved.status).toBe(200);
    const resolvedDashboard = await admin.get<{
      devices: Array<{ device_name: string; status_label: string; local_error_code: string | null; blocked: boolean }>;
    }>(`/api/v1/vaults/${admin.vaultId}/dashboard`);
    expect(resolvedDashboard.body.devices.find((device) => device.device_name === 'tablet')).toMatchObject({
      status_label: 'Behind',
      local_error_code: null,
      blocked: false
    });

    releaseResponse();
    const delayedError = await delayedPull;
    tablet.transport.pull = originalPull;
    expect(delayedError).toMatchObject({ code: 'device_blocked' });
    expect((await tablet.readState()).last_error_code).toBeNull();

    const staleQueue = await tablet.readQueue();
    const currentState = await tablet.readState();
    expect(staleQueue).toMatchObject({
      status: 'conflicted',
      pending_commit: currentState.local_head,
      expected_device_ref: currentState.server_device_ref
    });
    const authoritativeDevice = (await server.store.snapshot()).devices.find(
      (candidate) => candidate.device_id === currentState.device_id
    );
    expect(authoritativeDevice?.device_ref_head).not.toBe(currentState.server_device_ref);

    const internal = tablet.client as unknown as { pullAndApply(allowDestructive: boolean): Promise<boolean> };
    const originalPullAndApply = internal.pullAndApply.bind(internal);
    let caughtErrorPullAttempts = 0;
    internal.pullAndApply = async () => {
      caughtErrorPullAttempts += 1;
      throw new Error('simulated interruption in caught-error reconciliation');
    };
    await expect(tablet.reconcileDeviceBlocked(true, 'device_blocked')).rejects.toThrow('caught-error reconciliation');
    expect(caughtErrorPullAttempts).toBe(1);
    internal.pullAndApply = originalPullAndApply;

    const caughtErrorRestart = new ObtsPluginClient(tabletDir, { serverUrl: baseUrl, deviceName: 'tablet' });
    await caughtErrorRestart.initialize();
    const caughtErrorState = await caughtErrorRestart.readState();
    expect(caughtErrorState).toMatchObject({
      last_error_code: null,
      server_device_ref: staleQueue.expected_device_ref
    });
    await writeFile(join(tabletDir, '.obts', 'state.json'), `${JSON.stringify({
      ...caughtErrorState,
      status_label: 'Review needed',
      last_error_code: 'device_blocked',
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    internal.pullAndApply = async () => {
      throw new Error('simulated interruption after authoritative state transition');
    };
    await expect(tablet.reconcileDeviceBlocked()).rejects.toThrow('simulated interruption');
    internal.pullAndApply = originalPullAndApply;

    const interrupted = new ObtsPluginClient(tabletDir, { serverUrl: baseUrl, deviceName: 'tablet' });
    await interrupted.initialize();
    expect(await interrupted.readState()).toMatchObject({
      status_label: 'Out of sync',
      last_error_code: 'device_blocked',
      server_device_ref: staleQueue.expected_device_ref
    });
    expect(await interrupted.reconcileDeviceBlocked()).toMatchObject({ applied: true, status: 'Synced' });
    const recoveredState = await interrupted.readState();
    expect(recoveredState).toMatchObject({
      local_main: resolved.body.resolution_commit,
      local_head: resolved.body.resolution_commit,
      status_label: 'Synced',
      last_error_code: null
    });
    expect(recoveredState.last_event_seq).toBeGreaterThanOrEqual(conflictState.last_event_seq);
    expect(recoveredState.last_applied_event_seq).toBeGreaterThanOrEqual(conflictState.last_applied_event_seq);
    expect(await interrupted.readQueue()).toMatchObject({
      pending_commit: null,
      expected_device_ref: recoveredState.server_device_ref,
      status: 'idle'
    });
    expect(await readFile(join(tabletDir, 'shared.md'), 'utf8')).toBe('server version\n');

    await tablet.markBlocked('device_blocked');
    const restarted = new ObtsPluginClient(tabletDir, { serverUrl: baseUrl, deviceName: 'tablet' });
    await restarted.initialize();
    expect((await restarted.readState()).last_error_code).toBe('device_blocked');
    expect(await restarted.reconcileDeviceBlocked()).toMatchObject({ status: 'Synced' });
    const restartedState = await restarted.readState();
    expect(restartedState.last_event_seq).toBeGreaterThanOrEqual(recoveredState.last_event_seq);
    expect(restartedState.last_applied_event_seq).toBeGreaterThanOrEqual(recoveredState.last_applied_event_seq);

    await writeFile(join(tabletDir, 'after-recovery.md'), 'fast-forward after recovery\n');
    expect((await restarted.syncOnce()).status).toBe('Synced');
  });

  it('preserves a genuine server recovery block during device-block reconciliation', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'server-recovery-block');
    await mkdir(deviceDir, { recursive: true });
    const device = await pairPlugin(admin, deviceDir, 'blocked-device');
    const pairedState = await device.readState();
    await server.store.mutate((db) => {
      const row = db.devices.find((candidate) => candidate.device_id === pairedState.device_id);
      if (row) row.status = 'blocked_recovery';
    });

    await device.markBlocked('device_blocked');
    expect(await device.reconcileDeviceBlocked()).toEqual({ applied: false, status: 'Needs recovery' });
    expect(await device.readState()).toMatchObject({
      local_main: pairedState.local_main,
      local_head: pairedState.local_head,
      status_label: 'Out of sync — local recovery required',
      last_error_code: 'server_recovery_required'
    });

    const restarted = new ObtsPluginClient(deviceDir, { serverUrl: baseUrl, deviceName: 'blocked-device' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({
      status_label: 'Out of sync — local recovery required',
      last_error_code: 'server_recovery_required'
    });
    await expect(restarted.syncOnce()).rejects.toMatchObject({ code: 'server_recovery_required' });
  });

  it('does not trust near-match backups outside the exact authoritative reconciliation capability', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'authoritative-reconciliation-safety-boundary');
    await mkdir(deviceDir, { recursive: true });
    const device = await pairPlugin(admin, deviceDir, 'safety-boundary-device');
    const state = await device.readState();
    if (!state.local_head) throw new Error('Paired state did not have a local head.');
    const backup = {
      ...state,
      server_device_ref: 'a'.repeat(40),
      status_label: 'Review needed',
      last_error_code: 'device_blocked',
      updated_at: '2026-08-01T00:00:00.000Z'
    };
    const primary = {
      ...backup,
      server_device_ref: 'b'.repeat(40),
      status_label: 'Behind',
      last_error_code: null,
      updated_at: '2026-08-01T00:00:01.000Z'
    };
    const expected = {
      vaultId: state.vault_id,
      deviceId: state.device_id,
      primaryUpdatedAt: primary.updated_at,
      primaryServerDeviceRef: primary.server_device_ref,
      primaryStatusLabel: primary.status_label,
      priorUpdatedAt: backup.updated_at,
      priorServerDeviceRef: backup.server_device_ref,
      priorErrorCode: backup.last_error_code,
      triggeringErrorCode: 'device_blocked'
    };
    const exactQueue = {
      pending_commit: state.local_head,
      expected_device_ref: backup.server_device_ref,
      status: 'conflicted'
    };
    const internal = device.client as any;
    const originalReadQueue = internal.readQueue.bind(internal);
    internal.activeReconciliation = { authoritativePrimary: expected };
    internal.readQueue = async () => exactQueue;
    expect(await internal.shouldUseAuthoritativeReconciliationPrimary(primary, backup)).toBe(true);
    const caughtErrorBackup = { ...backup, last_error_code: null };
    internal.activeReconciliation = {
      authoritativePrimary: { ...expected, priorErrorCode: null }
    };
    expect(await internal.shouldUseAuthoritativeReconciliationPrimary(primary, caughtErrorBackup)).toBe(true);
    internal.activeReconciliation = {
      authoritativePrimary: { ...expected, priorErrorCode: null, triggeringErrorCode: null }
    };
    expect(await internal.shouldUseAuthoritativeReconciliationPrimary(primary, caughtErrorBackup)).toBe(false);
    internal.activeReconciliation = { authoritativePrimary: expected };

    const stateMismatches = [
      [{ ...primary, updated_at: '2026-08-01T00:00:02.000Z' }, backup],
      [{ ...primary, server_device_ref: 'c'.repeat(40) }, backup],
      [{ ...primary, status_label: 'Checking' }, backup],
      [{ ...primary, device_id: 'dev_other' }, backup],
      [{ ...primary, local_head: 'd'.repeat(40) }, backup],
      [primary, { ...backup, last_error_code: 'conflict_review_required' }],
      [primary, { ...backup, updated_at: '2026-08-01T00:00:03.000Z' }],
      [primary, { ...backup, server_device_ref: 'e'.repeat(40) }]
    ];
    for (const [candidatePrimary, candidateBackup] of stateMismatches) {
      expect(await internal.shouldUseAuthoritativeReconciliationPrimary(candidatePrimary, candidateBackup)).toBe(false);
    }

    for (const queue of [
      { ...exactQueue, status: 'idle' },
      { ...exactQueue, pending_commit: 'f'.repeat(40) },
      { ...exactQueue, expected_device_ref: 'f'.repeat(40) }
    ]) {
      internal.readQueue = async () => queue;
      expect(await internal.shouldUseAuthoritativeReconciliationPrimary(primary, backup)).toBe(false);
    }
    internal.readQueue = async () => exactQueue;
    internal.activeReconciliation = null;
    expect(await internal.shouldUseAuthoritativeReconciliationPrimary(primary, backup)).toBe(false);
    internal.readQueue = originalReadQueue;
  });

  it('reports the exact reconciliation phase and safe code when the server check is blocked', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'instrumented-device-block-recovery');
    await mkdir(deviceDir, { recursive: true });
    const device = await pairPlugin(admin, deviceDir, 'instrumented-device');
    await device.markBlocked('device_blocked');
    const snapshots: Array<{ trigger: string; details: Record<string, unknown> }> = [];
    (device as any).host.sendTroubleshootingSnapshot = async (trigger: string, details: Record<string, unknown>) => {
      snapshots.push({ trigger, details });
      return true;
    };
    const internal = device.client as unknown as { getDeviceSelf(token: string): Promise<Record<string, unknown>> };
    const originalGetDeviceSelf = internal.getDeviceSelf.bind(internal);
    internal.getDeviceSelf = async () => {
      throw new TransportError(409, 'device_blocked', 'safe test message');
    };

    await expect(device.reconcileDeviceBlocked(true, 'device_blocked')).rejects.toMatchObject({ code: 'device_blocked' });
    expect(snapshots.map((snapshot) => snapshot.trigger)).toEqual(['reconcile_start', 'reconcile_failure']);
    expect(snapshots[1]?.details).toMatchObject({
      phase: 'requesting_server',
      outcome: 'blocked',
      safeErrorCode: 'device_blocked',
      reconcileGuard: 'not_observed',
      reconcileTimestamp: 'unknown',
      reconcileError: 'unknown',
      reconcileCursors: 'unknown',
      requestOutcome: 'blocked',
      httpStatus: 409
    });
    expect(snapshots[0]?.details.attemptId).toBe(snapshots[1]?.details.attemptId);
    internal.getDeviceSelf = originalGetDeviceSelf;
  });

  it('reports persisted state rather than intended state when reconciliation state write fails', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'instrumented-state-write-failure');
    await mkdir(deviceDir, { recursive: true });
    const device = await pairPlugin(admin, deviceDir, 'write-failure-device');
    await device.markBlocked('device_blocked');
    const snapshots: Array<{ trigger: string; details: Record<string, any> }> = [];
    (device as any).host.sendTroubleshootingSnapshot = async (trigger: string, details: Record<string, unknown>) => {
      snapshots.push({ trigger, details });
      return true;
    };
    const internal = device.client as unknown as { writeState(state: Record<string, unknown>): Promise<void> };
    const originalWriteState = internal.writeState.bind(internal);
    internal.writeState = async () => {
      throw new Error('simulated state write failure');
    };

    await expect(device.reconcileDeviceBlocked()).rejects.toThrow('simulated state write failure');
    expect(snapshots.map((snapshot) => snapshot.trigger)).toEqual([
      'reconcile_start',
      'reconcile_guard',
      'reconcile_failure'
    ]);
    expect(snapshots[2]?.details).toMatchObject({
      phase: 'checking_guard',
      requestOutcome: 'succeeded',
      httpStatus: 200,
      capturedState: {
        status_label: 'Out of sync',
        last_error_code: 'device_blocked'
      }
    });
    internal.writeState = originalWriteState;
  });

  it('does not overwrite newer local state while checking a stale device block', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'concurrent-device-block-recovery');
    await mkdir(deviceDir, { recursive: true });
    const device = await pairPlugin(admin, deviceDir, 'concurrent-device');
    await device.markBlocked('device_blocked');
    const snapshots: Array<{ trigger: string; details: Record<string, unknown> }> = [];
    (device as any).host.sendTroubleshootingSnapshot = async (trigger: string, details: Record<string, unknown>) => {
      snapshots.push({ trigger, details });
      return true;
    };

    const internal = device.client as unknown as {
      getDeviceSelf(token: string): Promise<Record<string, unknown>>;
      pullAndApply(allowDestructive: boolean): Promise<boolean>;
    };
    const originalGetDeviceSelf = internal.getDeviceSelf.bind(internal);
    const originalPullAndApply = internal.pullAndApply.bind(internal);
    let responseCaptured!: () => void;
    const responseCapturedPromise = new Promise<void>((resolve) => {
      responseCaptured = resolve;
    });
    let releaseResponse!: () => void;
    const responseRelease = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    internal.getDeviceSelf = async (token) => {
      const result = await originalGetDeviceSelf(token);
      responseCaptured();
      await responseRelease;
      return result;
    };
    let pullAttempts = 0;
    internal.pullAndApply = async () => {
      pullAttempts += 1;
      return false;
    };

    const reconciliation = device.reconcileDeviceBlocked();
    await responseCapturedPromise;
    const newerState = await device.readState();
    await device.writeState({
      ...newerState,
      status_label: 'Synced',
      last_error_code: null,
      updated_at: new Date(Date.now() + 1_000).toISOString()
    });
    releaseResponse();

    expect(await reconciliation).toEqual({ applied: false, status: 'Synced' });
    expect(pullAttempts).toBe(0);
    expect(await device.readState()).toMatchObject({ status_label: 'Synced', last_error_code: null });
    expect(snapshots.map((snapshot) => snapshot.trigger)).toEqual(['reconcile_start', 'reconcile_guard']);
    expect(snapshots[1]?.details).toMatchObject({
      phase: 'checking_guard',
      outcome: 'skipped',
      reconcileGuard: 'multiple',
      reconcileTimestamp: 'changed',
      reconcileError: 'changed',
      reconcileCursors: 'unchanged',
      requestOutcome: 'succeeded',
      httpStatus: 200
    });
    expect(snapshots[0]?.details.attemptId).toBe(snapshots[1]?.details.attemptId);
    expect(snapshots[0]?.details.attemptId).toMatch(/^rca_[0-9a-f]{32}$/u);
    internal.getDeviceSelf = originalGetDeviceSelf;
    internal.pullAndApply = originalPullAndApply;
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

  it('blocks conflict resolution that would restore a path excluded by the current policy', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const desktopDir = join(root, 'policy-resolution-desktop');
    const tabletDir = join(root, 'policy-resolution-tablet');
    const desktop = await pairPlugin(admin, desktopDir, 'policy-resolution-desktop');
    await writeFile(join(desktopDir, 'shared.md'), 'base\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const tablet = await pairPlugin(admin, tabletDir, 'policy-resolution-tablet');
    await writeFile(join(desktopDir, 'shared.md'), 'server edit\n');
    await writeFile(join(tabletDir, 'shared.md'), 'device edit\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const conflicted = await tablet.syncOnce();
    expect(conflicted.status).toBe('Conflict resolution needed');
    await writeFile(join(desktopDir, '.gitignore'), 'shared.md\n');
    expect((await desktop.syncOnce()).status).toBe('Synced');
    const policyMain = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main!;
    const refreshed = await admin.post<{ expected_main: string }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/refresh`, {}
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.expected_main).toBe(policyMain);
    const resolved = await admin.post<{ error: { code: string } }>(
      `/api/v1/vaults/${admin.vaultId}/conflicts/${conflicted.conflictId}/resolve`,
      { expected_main: policyMain, resolution_kind: 'use_device' }
    );
    expect(resolved.status).toBe(409);
    expect(resolved.body.error.code).toBe('excluded_root_ignore_path');
    expect(await server.git.getRef(admin.vaultId, 'refs/heads/main')).toBe(policyMain);
    expect((await server.store.snapshot()).conflicts.find((conflict) => conflict.conflict_id === conflicted.conflictId)?.status).toBe('open');
  });

  it('keeps a historical note excluded by the current root policy out of main', async () => {
    const admin = await setupAdminAndVault(baseUrl);
    const deviceDir = join(root, 'policy-history-restore');
    const device = await pairPlugin(admin, deviceDir, 'policy-history-restore');
    await writeFile(join(deviceDir, 'retained.md'), 'old local content\n');
    expect((await device.syncOnce()).status).toBe('Synced');
    const sourceCommit = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main!;
    expect((await server.git.readBlobAtPath(admin.vaultId, sourceCommit, 'retained.md')).toString('utf8')).toBe('old local content\n');
    await writeFile(join(deviceDir, '.gitignore'), 'retained.md\n');
    expect((await device.syncOnce()).status).toBe('Synced');
    const policyMain = (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main!;
    expect(await server.git.readBlobAtPathIfPresent(admin.vaultId, policyMain, 'retained.md')).toBeNull();
    expect((await server.git.readRootIgnoreBlob(admin.vaultId, policyMain)).bytes?.toString('utf8')).toBe('retained.md\n');
    const restored = await admin.post<{ error: { code: string; message: string } }>(
      `/api/v1/vaults/${admin.vaultId}/history/restore`,
      { path: 'retained.md', source_commit: sourceCommit, expected_main: policyMain }
    );
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe('excluded_root_ignore_path');
    expect(JSON.stringify(restored.body)).not.toContain('retained.md');
    expect(await server.git.getRef(admin.vaultId, 'refs/heads/main')).toBe(policyMain);
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
      expect(recoveredState.status_label).toBe('Out of sync — local recovery required');

      const savedJournal = JSON.parse(
        await readFile(join(vaultDir, '.obts', 'apply-journal.json'), 'utf8')
      ) as ApplyJournal;
      expect(savedJournal.phase).toBe('blocked_recovery');
      expect(savedJournal.redacted_error_category).toBe('local_files_diverge_from_journal');
    });
  });
});

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function forceConflictDeviceFile(
  server: ObtsServer,
  vaultId: string,
  conflictId: string,
  path: string,
  content: string
): Promise<string> {
  const snapshot = await server.store.snapshot();
  const conflict = snapshot.conflicts.find((candidate) => candidate.conflict_id === conflictId && candidate.vault_id === vaultId);
  if (!conflict) throw new Error(`Conflict not found: ${conflictId}`);
  const device = snapshot.devices.find((candidate) => candidate.device_id === conflict.device_id);
  if (!device) throw new Error(`Device not found: ${conflict.device_id}`);
  const sourceTree = await server.git.treeHash(vaultId, conflict.device_commit);
  const tree = await server.git.createTreeFromTreeWithChanges({
    vaultId,
    sourceTree,
    writes: new Map([[path, Buffer.from(content, 'utf8')]])
  });
  const commit = await server.git.createMainCommitFromTree({
    vaultId,
    tree,
    parentMain: conflict.device_commit,
    subject: 'test: device-only conflict file',
    body: `path=${path}`,
    actor: 'obts-test'
  });
  await server.git.updateRef(vaultId, device.device_ref, commit, conflict.device_commit);
  await server.git.updateRef(vaultId, `refs/obts/conflicts/${conflictId}/device`, commit, conflict.device_commit);
  await server.store.mutate((db) => {
    const mutableConflict = db.conflicts.find((candidate) => candidate.conflict_id === conflictId && candidate.vault_id === vaultId);
    const mutableDevice = db.devices.find((candidate) => candidate.device_id === conflict.device_id);
    if (!mutableConflict || !mutableDevice) throw new Error(`Conflict not found: ${conflictId}`);
    mutableConflict.device_commit = commit;
    mutableDevice.device_ref_head = commit;
    const proposalResult = db.directory_proposal_results.find((candidate) => candidate.conflict_id === conflictId);
    if (proposalResult) proposalResult.target_commit = commit;
  });
  return commit;
}

async function forceServerFileCommit(
  server: ObtsServer,
  vaultId: string,
  path: string,
  content: string
): Promise<string> {
  const snapshot = await server.store.snapshot();
  const vault = snapshot.vaults.find((candidate) => candidate.vault_id === vaultId);
  if (!vault?.current_main) throw new Error(`Vault main not found: ${vaultId}`);
  const previousMain = vault.current_main;
  const sourceTree = await server.git.treeHash(vaultId, previousMain);
  const tree = await server.git.createTreeFromTreeWithChanges({
    vaultId,
    sourceTree,
    writes: new Map([[path, Buffer.from(content, 'utf8')]])
  });
  const commit = await server.git.createMainCommitFromTree({
    vaultId,
    tree,
    parentMain: previousMain,
    subject: 'test: server-only file',
    body: `path=${path}`,
    actor: 'obts-test'
  });
  await server.git.updateRef(vaultId, 'refs/heads/main', commit, previousMain);
  await server.store.mutate((db) => {
    const mutableVault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    if (!mutableVault) throw new Error(`Vault not found: ${vaultId}`);
    mutableVault.current_main = commit;
    mutableVault.updated_at = new Date().toISOString();
    server.store.appendEvent(db, {
      event_type: 'main_advanced',
      vault_id: vaultId,
      resource_ids: {},
      commit_cursors: { previous_main: previousMain, main: commit },
      payload: { decision: 'test_server_file' }
    });
  });
  return commit;
}

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
    const absolutePath = join(desktopDir, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
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
  expect(result.status).toBe('Conflict resolution needed');
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
