import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { newId, nowIso } from '../shared/ids.js';
import { API_VERSION, type DevicePullManifest, type DevicePullRequest } from '../shared/types.js';
import {
  assertRecord,
  parseDevicePullRequest,
  parseDevicePushManifest,
  parseJsonObject,
  readOptionalBoolean,
  readString,
  readSyncProfile,
  ValidationError
} from '../shared/validators.js';
import { AuthError, AuthService, ownedVaultOrThrow } from './authService.js';
import { createServerConfig, ensureServerDirectories, type ServerConfig } from './config.js';
import { GitCommandError, GitService, sha256Hex } from './gitService.js';
import { MetadataStore, type MetadataDb } from './metadataStore.js';
import { SyncService } from './syncService.js';

const SESSION_COOKIE = '__Host-obts_session';

export type ObtsServer = {
  app: FastifyInstance;
  config: ServerConfig;
  store: MetadataStore;
  git: GitService;
  auth: AuthService;
  sync: SyncService;
};

export async function createObtsServer(overrides: Partial<ServerConfig> & { dataDir: string }): Promise<ObtsServer> {
  const config = createServerConfig(overrides);
  await ensureServerDirectories(config);
  const store = new MetadataStore(config.dataDir);
  await store.initialize();
  const git = new GitService(config);
  const auth = new AuthService(store);
  const sync = new SyncService(store, git, config.maxUploadBytes);
  const app = Fastify({
    logger: false,
    genReqId: () => newId('req')
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 2
    }
  });

  app.setErrorHandler((error, request, reply) => {
    void sendError(error instanceof Error ? error : new Error('Unknown error'), request, reply);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const gitReady = await git.checkReady();
    const db = await store.snapshot();
    const metadataStoreReady = await checkWritableDirectory(join(config.dataDir, 'metadata'));
    const gitStoreReady = await checkWritableDirectory(config.gitStoreDir);
    const tempWorkspaceReady = await checkWritableDirectory(config.tempDir);
    const persistentState = await checkPersistentState(db, git);
    const checks = {
      metadata: true,
      metadata_store: metadataStoreReady.ok,
      git: gitReady.ok,
      setup_complete: db.setup_complete,
      migrations: db.schema_version === 1,
      git_store: gitStoreReady.ok,
      temp_workspace: tempWorkspaceReady.ok,
      persistent_state: persistentState.ok
    };
    const ready =
      checks.metadata_store &&
      checks.git &&
      checks.migrations &&
      checks.git_store &&
      checks.temp_workspace &&
      checks.persistent_state;
    if (!ready) {
      return reply.status(503).send({
        status: 'not_ready',
        checks,
        detail: firstDetail([
          gitReady.ok ? null : gitReady.error,
          readinessError(metadataStoreReady),
          readinessError(gitStoreReady),
          readinessError(tempWorkspaceReady),
          readinessError(persistentState)
        ])
      });
    }
    return { status: 'ready', checks, git_version: gitReady.ok ? gitReady.version : 'unknown' };
  });

  app.get('/api/v1/setup/status', async () => {
    const db = await store.snapshot();
    return { setup_complete: db.setup_complete };
  });

  app.post('/api/v1/setup', async (request, reply) => {
    const body = requestBody(request);
    const setupInput = {
      username: readString(body, 'username'),
      password: readString(body, 'password')
    };
    const result = await auth.setupInitialAdmin(
      typeof body.display_name === 'string' ? { ...setupInput, displayName: body.display_name } : setupInput
    );
    setSessionCookie(reply, result.sessionId);
    return reply.status(201).send({
      user_id: result.user.user_id,
      csrf_token: result.csrfToken,
      recent_auth_expires_at: result.recentAuthExpiresAt
    });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = requestBody(request);
    const result = await auth.login({
      username: readString(body, 'username'),
      password: readString(body, 'password')
    });
    setSessionCookie(reply, result.sessionId);
    return {
      user_id: result.user.user_id,
      csrf_token: result.csrfToken,
      recent_auth_expires_at: result.recentAuthExpiresAt
    };
  });

  app.get('/api/v1/auth/session', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    return {
      user_id: session.user.user_id,
      csrf_token: session.session.csrf_token,
      recent_auth_expires_at: new Date(Date.parse(session.session.recent_auth_at) + 15 * 60 * 1000).toISOString()
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { status: 'ok' };
  });

  app.post('/api/v1/admin/users', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const body = requestBody(request);
    const baseInput = {
      actorUserId: session.user.user_id,
      username: readString(body, 'username'),
      password: readString(body, 'password'),
      isAdmin: body.is_admin === true
    };
    const user = await auth.createUser(
      typeof body.display_name === 'string' ? { ...baseInput, displayName: body.display_name } : baseInput
    );
    return reply.status(201).send({
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      is_admin: user.is_admin,
      disabled: user.disabled,
      created_at: user.created_at,
      last_login_at: user.last_login_at
    });
  });

  app.get('/api/v1/vaults', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    const db = await store.snapshot();
    return {
      vaults: db.vaults
        .filter((vault) => vault.owner_user_id === session.user.user_id)
        .map((vault) => ({
          vault_id: vault.vault_id,
          display_name: vault.display_name,
          owner_user_id: vault.owner_user_id,
          current_main: vault.current_main,
          status: vault.status,
          created_at: vault.created_at,
          updated_at: vault.updated_at
        }))
    };
  });

  app.post('/api/v1/vaults', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    const body = requestBody(request);
    const displayName = readString(body, 'display_name');
    const vaultId = newId('vlt');
    const rootCommit = await git.initializeVault(vaultId);
    const vault = await store.mutate((db) => {
      const timestamp = nowIso();
      const row = {
        vault_id: vaultId,
        owner_user_id: session.user.user_id,
        display_name: displayName,
        status: 'active' as const,
        current_main: rootCommit,
        created_at: timestamp,
        updated_at: timestamp
      };
      db.vaults.push(row);
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: session.user.user_id,
        actor_device_id: null,
        vault_id: vaultId,
        action: 'vault_created',
        resource_class: 'vault',
        resource_id: vaultId,
        created_at: timestamp
      });
      store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: vaultId,
        resource_ids: { vault_id: vaultId },
        commit_cursors: { main: rootCommit, previous_main: null },
        payload: { reason: 'empty_root' }
      });
      return row;
    });
    return reply.status(201).send(vault);
  });

  app.get('/api/v1/vaults/:vaultId/main', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return {
      vault_id: vault.vault_id,
      current_main: vault.current_main,
      status: vault.status
    };
  });

  app.get('/api/v1/vaults/:vaultId/dashboard', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    const devices = await Promise.all(
      db.devices
        .filter((device) => device.vault_id === vault.vault_id && device.user_id === session.user.user_id)
        .map(async (device) => {
          const aheadOfMain =
            device.device_ref_head !== null && !(await git.isAncestor(vault.vault_id, device.device_ref_head, vault.current_main));
          const behindMain =
            device.status === 'synced' &&
            device.last_successful_sync_at !== null &&
            Date.parse(device.last_successful_sync_at) < Date.parse(vault.updated_at);
          const offline = device.last_seen_at !== null && Date.now() - Date.parse(device.last_seen_at) > 24 * 60 * 60 * 1000;
          return {
            device_id: device.device_id,
            device_name: device.device_name,
            status: device.status,
            status_label: dashboardDeviceStatusLabel(device.status, { behindMain, offline }),
            last_seen_at: device.last_seen_at,
            sync_profile: device.sync_profile,
            sync_plugins: device.sync_plugins,
            device_ref_head: device.device_ref_head,
            last_successful_sync_at: device.last_successful_sync_at,
            ahead_of_main: aheadOfMain,
            behind_main: behindMain,
            blocked: device.status === 'review_needed' || device.status === 'blocked_recovery',
            offline
          };
        })
    );
    const conflicts = db.conflicts.filter((conflict) => conflict.vault_id === vault.vault_id && conflict.status === 'open');
    return {
      vault: {
        vault_id: vault.vault_id,
        display_name: vault.display_name,
        current_main: vault.current_main,
        status: vault.status
      },
      devices,
      unresolved_conflict_count: conflicts.length,
      health: {
        status: 'ready'
      }
    };
  });

  app.post('/api/v1/vaults/:vaultId/pairing-tokens', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId } = pathParams(request);
    const body = requestBody(request);
    const result = await auth.createPairingToken({
      userId: session.user.user_id,
      vaultId,
      deviceName: readString(body, 'device_name'),
      syncProfile: readSyncProfile(body, 'sync_profile'),
      syncPlugins: readOptionalBoolean(body, 'sync_plugins') ?? false,
      publicBaseUrl: config.publicBaseUrl
    });
    return reply.status(201).send({
      pairing_token: result.token,
      pairing_url: result.pairingUrl,
      expires_at: result.expiresAt
    });
  });

  app.post('/api/v1/pair/consume', async (request, reply) => {
    const body = requestBody(request);
    const result = await auth.consumePairingToken({
      pairingToken: readString(body, 'pairing_token'),
      deviceName: readString(body, 'device_name'),
      syncProfile: readSyncProfile(body, 'sync_profile'),
      syncPlugins: readOptionalBoolean(body, 'sync_plugins') ?? false
    });
    return reply.status(201).send({
      user_id: result.user.user_id,
      vault_id: result.vault.vault_id,
      device_id: result.device.device_id,
      device_token: result.deviceToken,
      device_ref: result.device.device_ref,
      current_main: result.vault.current_main,
      is_first_device: result.isFirstDevice
    });
  });

  app.post('/api/v1/vaults/:vaultId/sync/push', async (request, reply) => {
    const { vaultId } = pathParams(request);
    const deviceAuth = await auth.authenticateDevice(request.headers.authorization, vaultId);
    const { manifest, packfile } = await readPushMultipart(request);
    const result = await sync.pushDeviceCommit(deviceAuth, manifest, packfile);
    if (result.status === 'rejected') {
      const status = result.code === 'not_found' ? 404 : result.code === 'malformed_packfile' ? 400 : 409;
      return reply.status(status).send({
        error: {
          code: result.code,
          message: result.message,
          request_id: request.id,
          details: {}
        }
      });
    }
    return reply.send(result);
  });

  app.post('/api/v1/vaults/:vaultId/sync/pull', async (request, reply) => {
    const { vaultId } = pathParams(request);
    const deviceAuth = await auth.authenticateDevice(request.headers.authorization, vaultId);
    const pullRequest = await readPullMultipart(request);
    if (pullRequest.vault_id !== vaultId || pullRequest.device_id !== deviceAuth.device.device_id) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const targetMain =
      pullRequest.requested_target === 'latest' ? deviceAuth.vault.current_main : pullRequest.requested_target;
    if (targetMain !== deviceAuth.vault.current_main) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const have =
      pullRequest.current_local_main && (await git.commitExists(vaultId, pullRequest.current_local_main))
        ? pullRequest.current_local_main
        : null;
    const changedPaths =
      have === null
        ? await git.listTreePaths(vaultId, targetMain)
        : (await git.changedPaths(vaultId, have, targetMain)).map((entry) => entry.path);
    const db = await store.snapshot();
    const manifest: DevicePullManifest = {
      api_version: API_VERSION,
      vault_id: vaultId,
      device_id: deviceAuth.device.device_id,
      target_main: targetMain,
      changed_paths: [...new Set(changedPaths)].sort(),
      event_seq: db.event_seq_by_vault[vaultId] ?? 0
    };
    const packfile = await git.exportPack(vaultId, targetMain, have);
    if (pullRequest.current_local_main === targetMain) {
      await store.mutate((mutableDb) => {
        const device = mutableDb.devices.find((candidate) => candidate.device_id === deviceAuth.device.device_id);
        if (device && (device.status === 'paired' || device.status === 'synced')) {
          device.status = 'synced';
          device.last_successful_sync_at = nowIso();
        }
      });
    }
    return sendMultipart(reply, {
      manifest,
      packfile
    });
  });

  app.get('/api/v1/vaults/:vaultId/conflicts', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    const { vaultId } = pathParams(request);
    const query = request.query as { status?: string };
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return {
      conflicts: db.conflicts.filter(
        (conflict) =>
          conflict.vault_id === vault.vault_id &&
          (query.status === undefined || query.status === conflict.status || (query.status === 'open' && conflict.status === 'open'))
      )
    };
  });

  app.get('/api/v1/vaults/:vaultId/events', async (request) => {
    const session = await auth.authenticateSession(request.cookies[SESSION_COOKIE]);
    const { vaultId } = pathParams(request);
    const query = request.query as { after?: string };
    if (query.after !== undefined && !/^\d+$/u.test(query.after)) {
      throw new ValidationError('invalid_request', 'Invalid event cursor.');
    }
    const after = query.after ? Number.parseInt(query.after, 10) : 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ValidationError('invalid_request', 'Invalid event cursor.');
    }
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return {
      events: db.events.filter((event) => event.vault_id === vault.vault_id && event.event_seq > after),
      current_event_seq: db.event_seq_by_vault[vault.vault_id] ?? 0
    };
  });

  app.get('/', async (_request, reply) => {
    try {
      const html = await readFile(join(process.cwd(), 'dashboard', 'index.html'), 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.type('text/html; charset=utf-8').send('<!doctype html><title>obts</title><main>obts dashboard</main>');
    }
  });

  return { app, config, store, git, auth, sync };
}

function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/'
  });
}

function requestBody(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  assertRecord(body);
  return body;
}

function pathParams(request: FastifyRequest): { vaultId: string } {
  const params = request.params as { vaultId?: string };
  if (!params.vaultId) {
    throw new ValidationError('invalid_request', 'Missing vault ID.');
  }
  return { vaultId: params.vaultId };
}

async function readPushMultipart(request: FastifyRequest): Promise<{
  manifest: ReturnType<typeof parseDevicePushManifest>;
  packfile: Buffer;
}> {
  if (!request.isMultipart()) {
    throw new ValidationError('invalid_content_type', 'Expected multipart/form-data.');
  }
  let manifestText: string | null = null;
  let packfile: Buffer | null = null;
  for await (const part of request.parts()) {
    if (part.type === 'field' && part.fieldname === 'manifest') {
      manifestText = String(part.value);
    }
    if (part.type === 'file' && part.fieldname === 'packfile') {
      packfile = await part.toBuffer();
    }
  }
  if (!manifestText || packfile === null) {
    throw new ValidationError('invalid_request', 'Push requires manifest and packfile parts.');
  }
  return {
    manifest: parseDevicePushManifest(parseJsonObject(manifestText)),
    packfile
  };
}

async function readPullMultipart(request: FastifyRequest): Promise<DevicePullRequest> {
  if (!request.isMultipart()) {
    throw new ValidationError('invalid_content_type', 'Expected multipart/form-data.');
  }
  let manifestText: string | null = null;
  let sawPackfilePart = false;
  for await (const part of request.parts()) {
    if (part.type === 'field' && part.fieldname === 'manifest') {
      manifestText = String(part.value);
    }
    if (part.type === 'file' && part.fieldname === 'packfile') {
      await part.toBuffer();
      sawPackfilePart = true;
    }
  }
  if (!manifestText || !sawPackfilePart) {
    throw new ValidationError('invalid_request', 'Pull requires manifest and packfile parts.');
  }
  return parseDevicePullRequest(parseJsonObject(manifestText));
}

function sendMultipart(reply: FastifyReply, input: { manifest: DevicePullManifest; packfile: Buffer }): FastifyReply {
  const boundary = `obts-${sha256Hex(Buffer.from(`${input.manifest.target_main}:${input.packfile.byteLength}`)).slice(0, 24)}`;
  const manifest = Buffer.from(JSON.stringify(input.manifest), 'utf8');
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n`),
    manifest,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`
    ),
    input.packfile,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return reply.header('content-type', `multipart/form-data; boundary=${boundary}`).send(Buffer.concat(chunks));
}

async function sendError(error: Error, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent) {
    return;
  }
  if (isMultipartLimitError(error)) {
    await reply.status(413).send({
      error: {
        code: 'upload_too_large',
        message: 'Uploaded multipart content exceeds the configured byte limit.',
        request_id: request.id,
        details: {}
      }
    });
    return;
  }
  if (error instanceof AuthError) {
    await reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        request_id: request.id,
        details: {}
      }
    });
    return;
  }
  if (error instanceof ValidationError) {
    await reply.status(400).send({
      error: {
        code: error.code,
        message: error.message,
        request_id: request.id,
        details: error.details
      }
    });
    return;
  }
  if (error instanceof GitCommandError) {
    await reply.status(500).send({
      error: {
        code: 'git_error',
        message: 'Git operation failed.',
        request_id: request.id,
        details: {}
      }
    });
    return;
  }
  await reply.status(500).send({
    error: {
      code: 'internal_error',
      message: 'Internal server error.',
      request_id: request.id,
      details: {}
    }
  });
}

async function checkWritableDirectory(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const probe = join(path, `.obts-ready-${process.pid}-${Date.now()}`);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(probe, 'ok', { mode: 0o600 });
    await rm(probe, { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: 'persistent directory is not writable' };
  }
}

async function checkPersistentState(db: MetadataDb, git: GitService): Promise<{ ok: true } | { ok: false; error: string }> {
  if (db.schema_version !== 1) {
    return { ok: false, error: 'metadata schema version is unsupported' };
  }
  for (const vault of db.vaults) {
    const mainRef = await git.getRef(vault.vault_id, 'refs/heads/main');
    if (mainRef !== vault.current_main) {
      return { ok: false, error: 'vault main ref is inconsistent with metadata' };
    }
    if (!(await git.commitExists(vault.vault_id, vault.current_main))) {
      return { ok: false, error: 'vault main commit is missing from the Git store' };
    }
    for (const device of db.devices.filter((candidate) => candidate.vault_id === vault.vault_id)) {
      const deviceRef = await git.getRef(vault.vault_id, device.device_ref);
      if ((device.device_ref_head ?? null) !== deviceRef) {
        return { ok: false, error: 'device ref is inconsistent with metadata' };
      }
    }
    for (const conflict of db.conflicts.filter((candidate) => candidate.vault_id === vault.vault_id)) {
      for (const commit of [conflict.current_main, conflict.device_commit, conflict.base_commit]) {
        if (commit && !(await git.commitExists(vault.vault_id, commit))) {
          return { ok: false, error: 'conflict commit is missing from the Git store' };
        }
      }
    }
  }
  return { ok: true };
}

function firstDetail(details: Array<string | null | undefined>): string {
  return details.find((detail): detail is string => typeof detail === 'string' && detail.length > 0) ?? 'readiness failed';
}

function readinessError(result: { ok: true } | { ok: false; error: string }): string | null {
  return result.ok ? null : result.error;
}

function deviceStatusLabel(status: string): string {
  if (status === 'synced') {
    return 'Synced';
  }
  if (status === 'review_needed') {
    return 'Review needed';
  }
  if (status === 'blocked_recovery') {
    return 'Needs recovery';
  }
  if (status === 'paired') {
    return 'Checking';
  }
  return 'Ahead';
}

function dashboardDeviceStatusLabel(
  status: string,
  state: { behindMain: boolean; offline: boolean }
): string {
  if (status === 'synced' && state.offline) {
    return 'Offline';
  }
  if (status === 'synced' && state.behindMain) {
    return 'Behind';
  }
  return deviceStatusLabel(status);
}

function isMultipartLimitError(error: Error): boolean {
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_PARTS_LIMIT' || error.code === 'FST_FILES_LIMIT')
  );
}
