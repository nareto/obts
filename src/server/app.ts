import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { newId, nowIso } from '../shared/ids.js';
import { isSyncableVaultPath } from '../shared/pathPolicy.js';
import { API_VERSION, type DevicePullManifest, type DevicePullRequest } from '../shared/types.js';
import {
  assertRecord,
  readCommitId,
  parseDevicePullRequest,
  parseDevicePushManifest,
  parseJsonObject,
  readString,
  ValidationError
} from '../shared/validators.js';
import { AuthError, AuthService, ownedVaultOrThrow } from './authService.js';
import { createServerConfig, ensureServerDirectories, type ServerConfig } from './config.js';
import { GitCommandError, GitService, sha256Hex } from './gitService.js';
import { MetadataStore, type MetadataDb, type SyncOperationRow } from './metadataStore.js';
import { SyncService } from './syncService.js';

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
  await reconcileStartupOperations(store, git);
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
  await sync.resumePendingMerges();

  app.addHook('onRequest', async (request, reply) => {
    setApiCorsHeaders(request, reply);
  });

  app.setErrorHandler((error, request, reply) => {
    void sendError(error instanceof Error ? error : new Error('Unknown error'), request, reply);
  });

  app.options('/api/v1/*', async (_request, reply) => reply.status(204).send());

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const readiness = await buildReadinessSummary(config, store, git);
    if (readiness.status !== 'ready') {
      return reply.status(503).send({
        status: readiness.status,
        checks: readiness.checks,
        detail: readiness.detail
      });
    }
    return { status: readiness.status, checks: readiness.checks, git_version: readiness.git_version };
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
    setSessionCookie(reply, config, result.sessionId);
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
      password: readString(body, 'password'),
      sourceIp: request.ip
    });
    setSessionCookie(reply, config, result.sessionId);
    return {
      user_id: result.user.user_id,
      csrf_token: result.csrfToken,
      recent_auth_expires_at: result.recentAuthExpiresAt
    };
  });

  app.get('/api/v1/auth/session', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    return {
      user_id: session.user.user_id,
      csrf_token: session.session.csrf_token,
      recent_auth_expires_at: new Date(Date.parse(session.session.recent_auth_at) + 15 * 60 * 1000).toISOString()
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies[config.sessionCookieName]);
    reply.clearCookie(config.sessionCookieName, cookieOptions(config));
    return { status: 'ok' };
  });

  app.post('/api/v1/auth/password-reset', async (request) => {
    const body = requestBody(request);
    await auth.resetPassword({
      resetToken: readString(body, 'reset_token'),
      newPassword: readString(body, 'new_password')
    });
    return { status: 'ok' };
  });

  app.post('/api/v1/admin/users', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
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
      last_login_at: user.last_login_at,
      owned_vault_count: 0
    });
  });

  app.get('/api/v1/admin/users', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    return {
      users: await auth.listUsers(session.user.user_id)
    };
  });

  app.post('/api/v1/admin/users/:userId/disable', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { userId } = userPathParams(request);
    return await auth.setUserDisabled({
      actorUserId: session.user.user_id,
      targetUserId: userId,
      disabled: true
    });
  });

  app.post('/api/v1/admin/users/:userId/enable', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { userId } = userPathParams(request);
    return await auth.setUserDisabled({
      actorUserId: session.user.user_id,
      targetUserId: userId,
      disabled: false
    });
  });

  app.post('/api/v1/admin/users/:userId/grant-admin', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { userId } = userPathParams(request);
    return await auth.setUserAdmin({
      actorUserId: session.user.user_id,
      targetUserId: userId,
      isAdmin: true
    });
  });

  app.post('/api/v1/admin/users/:userId/revoke-admin', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { userId } = userPathParams(request);
    return await auth.setUserAdmin({
      actorUserId: session.user.user_id,
      targetUserId: userId,
      isAdmin: false
    });
  });

  app.post('/api/v1/admin/users/:userId/password-reset-tokens', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { userId } = userPathParams(request);
    const result = await auth.createPasswordResetToken({
      actorUserId: session.user.user_id,
      targetUserId: userId
    });
    return reply.status(201).send({
      reset_token: result.token,
      expires_at: result.expiresAt
    });
  });

  app.get('/api/v1/vaults', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
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
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
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
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
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
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    const devices = await Promise.all(
      db.devices
        .filter((device) => device.vault_id === vault.vault_id && device.user_id === session.user.user_id)
        .map(async (device) => {
          const aheadOfMain =
            device.device_ref_head !== null && !(await git.isAncestor(vault.vault_id, device.device_ref_head, vault.current_main));
          const behindMain = device.status === 'synced' && device.last_applied_main !== vault.current_main;
          const offline = device.last_seen_at !== null && Date.now() - Date.parse(device.last_seen_at) > 24 * 60 * 60 * 1000;
          return {
            device_id: device.device_id,
            device_name: device.device_name,
            status: device.status,
            status_label: dashboardDeviceStatusLabel(device.status, { behindMain, offline }),
            last_seen_at: device.last_seen_at,
            device_ref_head: device.device_ref_head,
            last_applied_main: device.last_applied_main,
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
      health: await buildReadinessSummary(config, store, git)
    };
  });

  app.post('/api/v1/vaults/:vaultId/pairing-tokens', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId } = pathParams(request);
    const body = requestBody(request);
    const result = await auth.createPairingToken({
      userId: session.user.user_id,
      vaultId,
      deviceName: readString(body, 'device_name'),
      publicBaseUrl: config.publicBaseUrl
    });
    return reply.status(201).send({
      pairing_token: result.token,
      pairing_url: result.pairingUrl,
      expires_at: result.expiresAt
    });
  });

  app.post('/api/v1/vaults/:vaultId/devices/:deviceId/revoke', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId, deviceId } = vaultDevicePathParams(request);
    await auth.revokeDevice({
      actorUserId: session.user.user_id,
      vaultId,
      deviceId
    });
    return { status: 'ok' };
  });

  app.post('/api/v1/pair/consume', async (request, reply) => {
    const body = requestBody(request);
    const result = await auth.consumePairingToken({
      pairingToken: readString(body, 'pairing_token'),
      deviceName: readString(body, 'device_name')
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

  app.get('/api/v1/device/self', async (request) => {
    const deviceAuth = await auth.authenticateDeviceAnyVault(request.headers.authorization);
    const db = await store.snapshot();
    return {
      user_id: deviceAuth.user.user_id,
      vault_id: deviceAuth.vault.vault_id,
      device_id: deviceAuth.device.device_id,
      device_name: deviceAuth.device.device_name,
      device_ref: deviceAuth.device.device_ref,
      server_device_ref: deviceAuth.device.device_ref_head,
      current_main: deviceAuth.vault.current_main,
      status: deviceAuth.device.status,
      last_applied_main: deviceAuth.device.last_applied_main,
      event_seq: db.event_seq_by_vault[deviceAuth.vault.vault_id] ?? 0
    };
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
    if (deviceAuth.vault.status === 'blocked_integrity') {
      throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
    if (deviceAuth.device.status === 'review_needed' || deviceAuth.device.status === 'blocked_recovery') {
      throw new AuthError(409, 'device_blocked', 'Device requires review or recovery before pulling server state.');
    }
    const pullRequest = await readPullMultipart(request);
    if (pullRequest.vault_id !== vaultId || pullRequest.device_id !== deviceAuth.device.device_id) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const targetMain =
      pullRequest.requested_target === 'latest' ? deviceAuth.vault.current_main : pullRequest.requested_target;
    if (targetMain !== deviceAuth.vault.current_main) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const currentLocalMainExists =
      pullRequest.current_local_main !== null && (await git.commitExists(vaultId, pullRequest.current_local_main));
    const currentLocalMainIsAncestor =
      pullRequest.current_local_main !== null && currentLocalMainExists
        ? await git.isAncestor(vaultId, pullRequest.current_local_main, targetMain)
        : null;
    const have = currentLocalMainExists ? pullRequest.current_local_main : null;
    const allChangedPaths =
      have === null
        ? await git.listTreePaths(vaultId, targetMain)
        : (await git.changedPaths(vaultId, have, targetMain)).map((entry) => entry.path);
    const changedPaths = allChangedPaths.filter((path) => isSyncableVaultPath(path));
    const db = await store.snapshot();
    const manifest: DevicePullManifest = {
      api_version: API_VERSION,
      vault_id: vaultId,
      device_id: deviceAuth.device.device_id,
      target_main: targetMain,
      changed_paths: [...new Set(changedPaths)].sort(),
      current_local_main_is_ancestor: currentLocalMainIsAncestor,
      event_seq: db.event_seq_by_vault[vaultId] ?? 0
    };
    const packfile = await git.exportPack(vaultId, targetMain, have);
    if (pullRequest.current_local_main === targetMain) {
      await store.mutate((mutableDb) => {
        const device = mutableDb.devices.find((candidate) => candidate.device_id === deviceAuth.device.device_id);
        if (device && device.status !== 'revoked' && device.status !== 'review_needed' && device.status !== 'blocked_recovery') {
          device.status = 'synced';
          device.last_applied_main = targetMain;
          device.last_successful_sync_at = nowIso();
        }
      });
    }
    return sendMultipart(reply, {
      manifest,
      packfile
    });
  });

  app.get('/api/v1/vaults/:vaultId/sync/events', async (request, reply) => {
    const { vaultId } = pathParams(request);
    const deviceAuth = await auth.authenticateDevice(request.headers.authorization, vaultId);
    return sendEventPage(reply, request.id, await store.snapshot(), deviceAuth.vault.vault_id, readEventCursor(request));
  });

  app.post('/api/v1/vaults/:vaultId/sync/unpair', async (request) => {
    const { vaultId } = pathParams(request);
    const deviceAuth = await auth.authenticateDevice(request.headers.authorization, vaultId);
    await auth.revokeDevice({
      actorUserId: deviceAuth.user.user_id,
      vaultId: deviceAuth.vault.vault_id,
      deviceId: deviceAuth.device.device_id
    });
    return { status: 'ok' };
  });

  app.get('/api/v1/vaults/:vaultId/conflicts', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
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

  app.get('/api/v1/vaults/:vaultId/conflicts/:conflictId', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId, conflictId } = vaultConflictPathParams(request);
    const db = await store.snapshot();
    ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return await sync.getConflictReviewPackage(vaultId, conflictId);
  });

  app.post('/api/v1/vaults/:vaultId/conflicts/:conflictId/resolve', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId, conflictId } = vaultConflictPathParams(request);
    const db = await store.snapshot();
    ownedVaultOrThrow(db, session.user.user_id, vaultId);
    const body = requestBody(request);
    const resolutionKind = readConflictResolutionKind(body);
    const manualFiles = readManualResolutionFiles(body);
    return await sync.resolveConflict({
      actorUserId: session.user.user_id,
      vaultId,
      conflictId,
      expectedMain: readCommitId(body, 'expected_main'),
      resolutionKind,
      ...(manualFiles === undefined ? {} : { manualFiles })
    });
  });

  app.get('/api/v1/vaults/:vaultId/events', async (request, reply) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return sendEventPage(reply, request.id, db, vault.vault_id, readEventCursor(request));
  });

  app.get('/', async (request, reply) => sendDashboardStatic(request, reply));
  app.get('/dashboard', async (request, reply) => sendDashboardStatic(request, reply));
  app.get('/dashboard/*', async (request, reply) => sendDashboardStatic(request, reply));
  app.get('/assets/*', async (request, reply) => sendDashboardStatic(request, reply));

  return { app, config, store, git, auth, sync };
}

function readEventCursor(request: FastifyRequest): number {
  const query = request.query as { after?: string };
  if (query.after !== undefined && !/^\d+$/u.test(query.after)) {
    throw new ValidationError('invalid_request', 'Invalid event cursor.');
  }
  const after = query.after ? Number.parseInt(query.after, 10) : 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ValidationError('invalid_request', 'Invalid event cursor.');
  }
  return after;
}

function sendEventPage(
  reply: FastifyReply,
  requestId: string,
  db: MetadataDb,
  vaultId: string,
  after: number
): FastifyReply | { events: MetadataDb['events']; current_event_seq: number } {
  const vaultEvents = db.events
    .filter((event) => event.vault_id === vaultId)
    .sort((left, right) => left.event_seq - right.event_seq);
  const oldestAvailableEventSeq = vaultEvents[0]?.event_seq;
  const currentEventSeq = db.event_seq_by_vault[vaultId] ?? 0;
  if (oldestAvailableEventSeq === undefined && currentEventSeq > 0 && after < currentEventSeq) {
    return reply.status(410).send({
      error: {
        code: 'event_cursor_expired',
        message: 'Event cursor is no longer available; refresh vault state before polling again.',
        request_id: requestId,
        details: {
          current_event_seq: currentEventSeq,
          oldest_available_event_seq: currentEventSeq + 1
        }
      }
    });
  }
  if (oldestAvailableEventSeq !== undefined && after < oldestAvailableEventSeq - 1) {
    return reply.status(410).send({
      error: {
        code: 'event_cursor_expired',
        message: 'Event cursor is no longer available; refresh vault state before polling again.',
        request_id: requestId,
        details: {
          current_event_seq: currentEventSeq,
          oldest_available_event_seq: oldestAvailableEventSeq
        }
      }
    });
  }
  return {
    events: vaultEvents.filter((event) => event.event_seq > after),
    current_event_seq: currentEventSeq
  };
}

function setSessionCookie(reply: FastifyReply, config: ServerConfig, sessionId: string): void {
  reply.setCookie(config.sessionCookieName, sessionId, {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'strict',
    path: '/'
  });
}

function setApiCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  if (!request.url.startsWith('/api/v1/')) {
    return;
  }
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  reply.header('access-control-allow-headers', 'authorization, content-type, x-obts-csrf');
  reply.header('access-control-max-age', '600');
}

function cookieOptions(config: ServerConfig): { path: string; secure: boolean; sameSite: 'strict' } {
  return {
    path: '/',
    secure: config.sessionCookieSecure,
    sameSite: 'strict'
  };
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

function userPathParams(request: FastifyRequest): { userId: string } {
  const params = request.params as { userId?: string };
  if (!params.userId) {
    throw new ValidationError('invalid_request', 'Missing user ID.');
  }
  return { userId: params.userId };
}

function vaultDevicePathParams(request: FastifyRequest): { vaultId: string; deviceId: string } {
  const params = request.params as { vaultId?: string; deviceId?: string };
  if (!params.vaultId || !params.deviceId) {
    throw new ValidationError('invalid_request', 'Missing vault or device ID.');
  }
  return { vaultId: params.vaultId, deviceId: params.deviceId };
}

function vaultConflictPathParams(request: FastifyRequest): { vaultId: string; conflictId: string } {
  const params = request.params as { vaultId?: string; conflictId?: string };
  if (!params.vaultId || !params.conflictId) {
    throw new ValidationError('invalid_request', 'Missing vault or conflict ID.');
  }
  return { vaultId: params.vaultId, conflictId: params.conflictId };
}

function readConflictResolutionKind(
  record: Record<string, unknown>
): 'keep_server' | 'use_device' | 'keep_both_files' | 'insert_both_blocks' | 'manual' {
  const value = readString(record, 'resolution_kind');
  if (
    value !== 'keep_server' &&
    value !== 'use_device' &&
    value !== 'keep_both_files' &&
    value !== 'insert_both_blocks' &&
    value !== 'manual'
  ) {
    throw new ValidationError('invalid_request', 'Invalid conflict resolution kind.', { field: 'resolution_kind' });
  }
  return value;
}

function readManualResolutionFiles(record: Record<string, unknown>): Record<string, string | null> | undefined {
  const value = record.manual_files;
  if (value === undefined) {
    return undefined;
  }
  assertRecord(value);
  const files: Record<string, string | null> = {};
  for (const [path, content] of Object.entries(value)) {
    if (typeof content !== 'string' && content !== null) {
      throw new ValidationError('invalid_request', 'Manual resolution file values must be strings or null.', {
        field: 'manual_files'
      });
    }
    files[path] = content;
  }
  return files;
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

async function sendDashboardStatic(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const dashboardRoot = resolve(process.cwd(), 'dist', 'frontend', 'dashboard');
  const url = new URL(request.url, 'http://obts.local');
  const pathname = decodeURIComponent(url.pathname);
  const relativePath =
    pathname === '/' || pathname === '/dashboard' || pathname.startsWith('/dashboard/')
      ? 'index.html'
      : pathname.replace(/^\/+/u, '');
  const absolutePath = resolve(dashboardRoot, relativePath);
  if (!absolutePath.startsWith(`${dashboardRoot}/`) && absolutePath !== dashboardRoot) {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Resource not found.',
        request_id: request.id,
        details: {}
      }
    });
  }
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error('not a file');
    }
    return reply.header('content-type', contentTypeForPath(absolutePath)).send(await readFile(absolutePath));
  } catch {
    if (relativePath === 'index.html') {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .status(503)
        .send('<!doctype html><title>obts dashboard unavailable</title><p>Dashboard assets have not been built.</p>');
    }
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Resource not found.',
        request_id: request.id,
        details: {}
      }
    });
  }
}

function contentTypeForPath(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
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

type ReadinessSummary = {
  status: 'ready' | 'not_ready';
  checks: {
    metadata: boolean;
    metadata_store: boolean;
    git: boolean;
    setup_complete: boolean;
    migrations: boolean;
    git_store: boolean;
    temp_workspace: boolean;
    persistent_state: boolean;
  };
  detail: string | null;
  git_version: string;
};

async function buildReadinessSummary(
  config: ServerConfig,
  store: MetadataStore,
  git: GitService
): Promise<ReadinessSummary> {
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
  return {
    status: ready ? 'ready' : 'not_ready',
    checks,
    detail: ready
      ? null
      : firstDetail([
          gitReady.ok ? null : gitReady.error,
          readinessError(metadataStoreReady),
          readinessError(gitStoreReady),
          readinessError(tempWorkspaceReady),
          readinessError(persistentState)
        ]),
    git_version: gitReady.ok ? gitReady.version : 'unknown'
  };
}

async function checkPersistentState(db: MetadataDb, git: GitService): Promise<{ ok: true } | { ok: false; error: string }> {
  if (db.schema_version !== 1) {
    return { ok: false, error: 'metadata schema version is unsupported' };
  }
  for (const vault of db.vaults) {
    if (vault.status === 'blocked_integrity') {
      return { ok: false, error: 'vault persistent state is blocked by an integrity failure' };
    }
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
      if (device.last_applied_main !== null && !(await git.commitExists(vault.vault_id, device.last_applied_main))) {
        return { ok: false, error: 'device applied main cursor is missing from the Git store' };
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

async function reconcileStartupOperations(store: MetadataStore, git: GitService): Promise<void> {
  const db = await store.snapshot();
  for (const operation of db.sync_operations) {
    if (operation.status === 'started' && operation.prepared_manifest === null) {
      await abortStartupOperation(store, operation.operation_id, 'startup_unprepared_operation');
    }
  }

  const latest = await store.snapshot();
  for (const operation of latest.sync_operations.filter((candidate) => candidate.status === 'prepared')) {
    const targetRefs = recoverableTargetRefs(operation);
    if (targetRefs.length === 0) {
      if (await expectedRefsStillCurrent(git, operation)) {
        await abortStartupOperation(store, operation.operation_id, 'startup_prepared_ref_not_moved');
      } else {
        await blockVaultIntegrity(store, operation, 'prepared operation does not contain a recoverable target ref');
      }
      continue;
    }

    const actualRefs = new Map<string, string | null>();
    for (const [ref] of targetRefs) {
      actualRefs.set(ref, await git.getRef(operation.vault_id, ref));
    }

    const allTargetsAlreadyMoved = targetRefs.every(([ref, target]) => actualRefs.get(ref) === target);
    if (allTargetsAlreadyMoved) {
      await rollForwardPreparedOperation(store, operation.operation_id);
      continue;
    }

    const allTargetsStillExpected = targetRefs.every(([ref]) => {
      const expected = operation.expected_refs[ref] ?? null;
      return actualRefs.get(ref) === expected;
    });
    if (allTargetsStillExpected) {
      await abortStartupOperation(store, operation.operation_id, 'startup_prepared_ref_not_moved');
      continue;
    }

    await blockVaultIntegrity(store, operation, 'prepared operation target refs cannot be reconciled');
  }
}

function recoverableTargetRefs(operation: SyncOperationRow): Array<[string, string]> {
  const refs = new Map<string, string>();
  addTargetRefs(refs, operation.target_refs);

  const manifestTargetRefs =
    operation.prepared_manifest && typeof operation.prepared_manifest.target_refs === 'object'
      ? operation.prepared_manifest.target_refs
      : null;
  if (manifestTargetRefs !== null) {
    addTargetRefs(refs, manifestTargetRefs as Record<string, unknown>);
  }

  if (
    (operation.operation_type === 'server_merge' || operation.operation_type === 'conflict_resolve') &&
    typeof operation.target_commit === 'string' &&
    /^[0-9a-f]{40}$/u.test(operation.target_commit) &&
    !refs.has('refs/heads/main')
  ) {
    refs.set('refs/heads/main', operation.target_commit);
  }

  return [...refs.entries()];
}

function addTargetRefs(refs: Map<string, string>, targetRefs: Record<string, unknown>): void {
  for (const [ref, target] of Object.entries(targetRefs)) {
    if (typeof target === 'string' && /^[0-9a-f]{40}$/u.test(target)) {
      refs.set(ref, target);
    }
  }
}

async function expectedRefsStillCurrent(git: GitService, operation: SyncOperationRow): Promise<boolean> {
  const expectedRefs = Object.entries(operation.expected_refs);
  if (expectedRefs.length === 0) {
    return true;
  }
  for (const [ref, expected] of expectedRefs) {
    if ((await git.getRef(operation.vault_id, ref)) !== expected) {
      return false;
    }
  }
  return true;
}

async function abortStartupOperation(store: MetadataStore, operationId: string, reason: string): Promise<void> {
  await store.mutate((db) => {
    const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
    if (!operation || operation.status === 'committed') {
      return;
    }
    operation.status = 'aborted';
    operation.result = { reason };
    operation.updated_at = nowIso();
  });
}

async function blockVaultIntegrity(store: MetadataStore, operation: SyncOperationRow, reason: string): Promise<void> {
  await store.mutate((db) => {
    const latestOperation = db.sync_operations.find((candidate) => candidate.operation_id === operation.operation_id);
    if (latestOperation && latestOperation.status !== 'committed') {
      latestOperation.result = { reason };
      latestOperation.updated_at = nowIso();
    }
    const vault = db.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
    if (vault) {
      vault.status = 'blocked_integrity';
      vault.updated_at = nowIso();
    }
  });
}

async function rollForwardPreparedOperation(store: MetadataStore, operationId: string): Promise<void> {
  await store.mutate((db) => {
    const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
    if (!operation || operation.status !== 'prepared') {
      return;
    }
    if (operation.operation_type === 'device_push') {
      const deviceRefEntry = Object.entries(operation.target_refs).find(([ref, target]) => {
        return ref.startsWith('refs/obts/devices/') && typeof target === 'string';
      });
      const device = operation.device_id
        ? db.devices.find((candidate) => candidate.device_id === operation.device_id)
        : undefined;
      if (!deviceRefEntry || !device || typeof deviceRefEntry[1] !== 'string') {
        operation.result = { reason: 'device_push_reconciliation_failed' };
        operation.updated_at = nowIso();
        const vault = db.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
        if (vault) {
          vault.status = 'blocked_integrity';
          vault.updated_at = nowIso();
        }
        return;
      }
      const targetCommit = deviceRefEntry[1];
      device.device_ref_head = targetCommit;
      device.status = 'ahead';
      device.last_seen_at = nowIso();
      operation.status = 'committed';
      operation.result = { device_ref: targetCommit, reconciled_after_startup: true };
      operation.updated_at = nowIso();
      const vault = db.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
      store.appendEvent(db, {
        event_type: 'device_ref_updated',
        vault_id: operation.vault_id,
        resource_ids: { device_id: device.device_id },
        commit_cursors: {
          device_ref: targetCommit,
          main: vault?.current_main ?? null
        },
        payload: {
          device_id: device.device_id,
          reconciled_after_startup: true
        }
      });
      return;
    }

    if (operation.operation_type === 'server_merge' || operation.operation_type === 'conflict_resolve') {
      const targetMain = operation.target_refs['refs/heads/main'];
      const previousMain = operation.expected_refs['refs/heads/main'] ?? null;
      const vault = db.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
      if (!vault || typeof targetMain !== 'string') {
        operation.result = { reason: 'server_merge_reconciliation_failed' };
        operation.updated_at = nowIso();
        if (vault) {
          vault.status = 'blocked_integrity';
          vault.updated_at = nowIso();
        }
        return;
      }
      const device = operation.device_id
        ? db.devices.find((candidate) => candidate.device_id === operation.device_id)
        : undefined;
      vault.current_main = targetMain;
      vault.updated_at = nowIso();
      if (device) {
        device.status = 'synced';
      }
      const manifest = operation.prepared_manifest ?? {};
      const conflictId = stringValue(manifest.conflict_id);
      if (operation.operation_type === 'conflict_resolve' && conflictId) {
        const conflict = db.conflicts.find(
          (candidate) => candidate.vault_id === operation.vault_id && candidate.conflict_id === conflictId
        );
        if (conflict) {
          conflict.status = 'resolved';
          conflict.resolved_at = nowIso();
          const resolutionKind =
            manifest.resolution_kind === 'keep_server' ||
            manifest.resolution_kind === 'use_device' ||
            manifest.resolution_kind === 'keep_both_files' ||
            manifest.resolution_kind === 'insert_both_blocks' ||
            manifest.resolution_kind === 'manual'
              ? manifest.resolution_kind
              : undefined;
          if (resolutionKind !== undefined) {
            conflict.resolution_kind = resolutionKind;
          }
          conflict.resolution_commit = targetMain;
          const requestHash = stringValue(manifest.resolution_request_hash);
          if (requestHash !== null) {
            conflict.resolution_request_hash = requestHash;
          }
        }
      }
      operation.status = 'committed';
      operation.target_commit = targetMain;
      operation.result = {
        decision: operation.operation_type === 'conflict_resolve' ? 'resolved' : 'merged',
        ...(operation.operation_type === 'conflict_resolve'
          ? { conflict_id: conflictId, resolution_commit: targetMain }
          : { merge_commit: targetMain }),
        reconciled_after_startup: true
      };
      operation.updated_at = nowIso();
      store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: operation.vault_id,
        resource_ids: {
          ...(device ? { device_id: device.device_id } : {}),
          ...(conflictId ? { conflict_id: conflictId } : {})
        },
        commit_cursors: {
          previous_main: previousMain,
          main: targetMain,
          device_commit: stringValue(manifest.device_commit)
        },
        payload: {
          decision: operation.operation_type === 'conflict_resolve' ? 'resolved' : 'merged',
          merge_sequence: manifest.merge_sequence ?? null,
          merge_policy_version: manifest.merge_policy_version ?? null,
          reconciled_after_startup: true
        }
      });
      return;
    }

    operation.status = 'aborted';
    operation.result = { reason: 'startup_prepared_operation_without_ref_mutation' };
    operation.updated_at = nowIso();
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
  if (status === 'revoked') {
    return 'Revoked';
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
