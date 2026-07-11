import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { newId, nowIso } from '../shared/ids.js';
import { isSyncableVaultPath } from '../shared/pathPolicy.js';
import {
  API_VERSION,
  type DevicePullManifest,
  type DevicePullRequest,
  type DirectoryIntent,
  type ManualFilePlanEntry,
  type NoteHistoryVersion
} from '../shared/types.js';
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

let dashboardRootPromise: Promise<string> | null = null;

export async function createObtsServer(overrides: Partial<ServerConfig> & { dataDir: string }): Promise<ObtsServer> {
  const config = createServerConfig(overrides);
  await ensureServerDirectories(config);
  const store = new MetadataStore(config.dataDir);
  await store.initialize();
  const git = new GitService(config);
  await reconcileStartupOperations(store, git);
  await ensureProtectedConflictRefs(store, git);
  await markInconsistentVaults(store, git);
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

  app.post('/api/v1/auth/reauthenticate', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    const body = requestBody(request);
    const result = await auth.reauthenticateSession({
      sessionId: request.cookies[config.sessionCookieName],
      username: readString(body, 'username'),
      password: readString(body, 'password'),
      sourceIp: request.ip
    });
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
          const localStatusFresh = isFreshDeviceStatus(device.last_status_report_at);
          const localStatusLabel = localStatusFresh ? device.local_status_label : null;
          const localErrorCode = localStatusFresh ? device.local_error_code : null;
          return {
            device_id: device.device_id,
            device_name: device.device_name,
            status: device.status,
            status_label: dashboardDeviceStatusLabel(device.status, { behindMain, offline, localStatusLabel, localErrorCode }),
            last_seen_at: device.last_seen_at,
            device_ref_head: device.device_ref_head,
            last_applied_main: device.last_applied_main,
            last_successful_sync_at: device.last_successful_sync_at,
            local_status_label: localStatusLabel,
            local_error_code: localErrorCode,
            local_error_details: localStatusFresh ? device.local_error_details : null,
            local_queue_status: localStatusFresh ? device.local_queue_status : null,
            local_main: localStatusFresh ? device.local_main : null,
            local_head: localStatusFresh ? device.local_head : null,
            plugin_version: localStatusFresh ? device.plugin_version : null,
            path_capabilities: localStatusFresh ? device.path_capabilities : null,
            last_status_report_at: device.last_status_report_at,
            ahead_of_main: aheadOfMain,
            behind_main: behindMain,
            blocked: device.status === 'review_needed' || device.status === 'blocked_recovery' || isBlockingLocalReport(localStatusLabel, localErrorCode),
            offline
          };
        })
    );
    const allConflicts = db.conflicts.filter((conflict) => conflict.vault_id === vault.vault_id);
    const conflicts = allConflicts.filter((conflict) => conflict.status === 'open');
    const health = await buildReadinessSummary(config, store, git);
    return {
      vault: {
        vault_id: vault.vault_id,
        display_name: vault.display_name,
        current_main: vault.current_main,
        status: vault.status
      },
      devices,
      unresolved_conflict_count: conflicts.length,
      conflicts: buildDashboardConflicts(db, vault.vault_id, vault.current_main, allConflicts),
      recent_activity: buildRecentActivity(db, vault.vault_id),
      maintenance: buildMaintenanceRows(health),
      health
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
    const currentEventSeq = Number.isSafeInteger(pullRequest.current_event_seq) ? pullRequest.current_event_seq ?? 0 : 0;
    const directoryEvents = db.events.filter((event) => event.vault_id === vaultId && event.event_seq > currentEventSeq);
    const directoryState = db.directory_state_by_vault[vaultId];
    const manifest: DevicePullManifest = {
      api_version: API_VERSION,
      vault_id: vaultId,
      device_id: deviceAuth.device.device_id,
      target_main: targetMain,
      changed_paths: [...new Set(changedPaths)].sort(),
      current_local_main_is_ancestor: currentLocalMainIsAncestor,
      event_seq: db.event_seq_by_vault[vaultId] ?? 0,
      directory_intents: directoryIntentsFromEvents(directoryEvents),
      explicit_directories: directoryState?.explicit_dirs ?? []
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

  app.post('/api/v1/vaults/:vaultId/sync/device-status', async (request) => {
    const { vaultId } = pathParams(request);
    const deviceAuth = await auth.authenticateDevice(request.headers.authorization, vaultId);
    const report = readDeviceStatusReport(requestBody(request));
    await store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === deviceAuth.device.device_id);
      if (!device || device.status === 'revoked') {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      device.local_status_label = report.localStatusLabel;
      device.local_error_code = report.localErrorCode;
      device.local_error_details = report.localErrorDetails;
      device.local_queue_status = report.localQueueStatus;
      device.local_main = report.localMain;
      device.local_head = report.localHead;
      device.plugin_version = report.pluginVersion;
      device.path_capabilities = report.pathCapabilities;
      device.last_status_report_at = nowIso();
    });
    return { status: 'ok' };
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
      conflicts: buildDashboardConflicts(
        db,
        vault.vault_id,
        vault.current_main,
        db.conflicts.filter(
          (conflict) =>
            conflict.vault_id === vault.vault_id &&
            (query.status === undefined || query.status === 'all' || query.status === conflict.status)
        )
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

  app.post('/api/v1/vaults/:vaultId/conflicts/:conflictId/refresh', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    const { vaultId, conflictId } = vaultConflictPathParams(request);
    const db = await store.snapshot();
    ownedVaultOrThrow(db, session.user.user_id, vaultId);
    return await sync.refreshConflictReviewPackage({
      actorUserId: session.user.user_id,
      vaultId,
      conflictId
    });
  });

  app.post('/api/v1/vaults/:vaultId/conflicts/:conflictId/resolve', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    const { vaultId, conflictId } = vaultConflictPathParams(request);
    const db = await store.snapshot();
    ownedVaultOrThrow(db, session.user.user_id, vaultId);
    const body = requestBody(request);
    const resolutionKind = readConflictResolutionKind(body);
    const manualFiles = readManualResolutionFiles(body);
    const manualFilePlan = readManualFilePlan(body);
    return await sync.resolveConflict({
      actorUserId: session.user.user_id,
      vaultId,
      conflictId,
      expectedMain: readCommitId(body, 'expected_main'),
      resolutionKind,
      ...(manualFiles === undefined ? {} : { manualFiles }),
      ...(manualFilePlan === undefined ? {} : { manualFilePlan })
    });
  });

  app.post('/api/v1/vaults/:vaultId/history/query', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    requireHistoryAvailable(vault.status);
    const body = requestBody(request);
    const path = readVaultContentPath(body, 'path');
    const limit = readHistoryLimit(body);
    const cached = db.derived_history_by_vault[vault.vault_id]?.find(
      (candidate) => candidate.path === path && candidate.current_main === vault.current_main
    );
    if (cached && cached.versions.length >= limit) {
      return {
        path,
        current_main: vault.current_main,
        versions: cached.versions.slice(0, limit)
      };
    }
    const versions = await buildNoteHistoryVersions(git, db, vault.vault_id, vault.current_main, path, limit);
    await store.mutate((mutableDb) => {
      const entries = mutableDb.derived_history_by_vault[vault.vault_id] ?? [];
      mutableDb.derived_history_by_vault[vault.vault_id] = [
        ...entries.filter((entry) => entry.path !== path),
        { path, current_main: vault.current_main, versions, indexed_at: nowIso() }
      ];
    });
    return {
      path,
      current_main: vault.current_main,
      versions
    };
  });

  app.post('/api/v1/vaults/:vaultId/history/version', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    requireHistoryAvailable(vault.status);
    const body = requestBody(request);
    const path = readVaultContentPath(body, 'path');
    const commit = readCommitId(body, 'commit');
    const includeContent = body.include_content === true;
    const pluginFile = isCommunityPluginFile(path);
    if (pluginFile && includeContent) {
      auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
      auth.requireRecentAuth(session.session);
    }
    if (!(await git.commitExists(vault.vault_id, commit)) || !(await git.isAncestor(vault.vault_id, commit, vault.current_main))) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const canonicalVersion = (
      await buildNoteHistoryVersions(git, db, vault.vault_id, vault.current_main, path, Number.MAX_SAFE_INTEGER)
    ).some((version) => version.commit === commit && version.path === path);
    if (!canonicalVersion) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const rawContent = (await git.readBlobAtPathIfPresent(vault.vault_id, commit, path))?.toString('utf8') ?? null;
    const parent = await git.firstParentOf(vault.vault_id, commit);
    const rawSourceDiff = parent === null ? '' : await git.sourceDiffForPath(vault.vault_id, parent, commit, path);
    const contentRedacted = pluginFile && !includeContent;
    if (pluginFile && includeContent) {
      await store.mutate((mutableDb) => {
        mutableDb.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: session.user.user_id,
          actor_device_id: null,
          vault_id: vault.vault_id,
          action: 'plugin_history_content_exported',
          resource_class: 'note_history',
          resource_id: null,
          created_at: nowIso()
        });
      });
    }
    return {
      path,
      commit,
      content: contentRedacted ? null : rawContent,
      source_diff: contentRedacted ? '' : rawSourceDiff,
      rendered_markdown_diff: contentRedacted || !path.endsWith('.md') ? null : renderMarkdownDiff(rawSourceDiff, rawContent),
      metadata_only: pluginFile,
      content_redacted: contentRedacted
    };
  });

  app.get('/api/v1/vaults/:vaultId/diagnostics/export', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    const { vaultId } = pathParams(request);
    const db = await store.snapshot();
    const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
    const health = await buildReadinessSummary(config, store, git);
    return buildRedactedDiagnostics(db, vault.vault_id, health);
  });

  app.post('/api/v1/vaults/:vaultId/history/restore', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId } = pathParams(request);
    const body = requestBody(request);
    const path = readVaultContentPath(body, 'path');
    const explicitSourcePath = Object.prototype.hasOwnProperty.call(body, 'source_path')
      ? readVaultContentPath(body, 'source_path')
      : null;
    const sourceCommit = readCommitId(body, 'source_commit');
    const expectedMain = readCommitId(body, 'expected_main');
    return await sync.runWithVaultLock(vaultId, async () => {
      const db = await store.snapshot();
      const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
      requireHistoryAvailable(vault.status);
      if (expectedMain !== vault.current_main) {
        throw new AuthError(409, 'stale_history_review', 'Current main changed; refresh history before restoring.');
      }
      if (!(await git.commitExists(vault.vault_id, sourceCommit)) || !(await git.isAncestor(vault.vault_id, sourceCommit, vault.current_main))) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const inferredSourcePath = await inferHistorySourcePath(
        git,
        db,
        vault.vault_id,
        vault.current_main,
        path,
        sourceCommit
      );
      if (inferredSourcePath === null || (explicitSourcePath !== null && explicitSourcePath !== inferredSourcePath)) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const sourcePath = explicitSourcePath ?? inferredSourcePath;
      const sourceContent = await git.readBlobAtPathIfPresent(vault.vault_id, sourceCommit, sourcePath);
      const tree = await git.createTreeFromCommitWithChanges({
        vaultId: vault.vault_id,
        sourceCommit: vault.current_main,
        writes: sourceContent === null ? new Map() : new Map([[path, sourceContent]]),
        deletes: sourceContent === null ? [path] : []
      });
      await git.validateTreePathPolicy(vault.vault_id, tree, config.maxUploadBytes);
      const operation = await store.mutate((mutableDb) => {
        const currentVault = ownedVaultOrThrow(mutableDb, session.user.user_id, vaultId);
        if (currentVault.current_main !== expectedMain) {
          throw new AuthError(409, 'stale_history_review', 'Current main changed; refresh history before restoring.');
        }
        const op = store.startOperation(mutableDb, {
          vault_id: vault.vault_id,
          device_id: null,
          operation_type: 'note_restore',
          expected_refs: { 'refs/heads/main': currentVault.current_main },
          target_refs: { 'refs/heads/main': null },
          target_commit: null
        });
        op.status = 'prepared';
        op.prepared_manifest = {
          operation_type: 'note_restore',
          path,
          source_path: sourcePath,
          source_commit: sourceCommit,
          actor_user_id: session.user.user_id,
          current_main: currentVault.current_main,
          accepted_tree: tree
        };
        op.updated_at = nowIso();
        return { operation_id: op.operation_id, current_main: currentVault.current_main };
      });
      let restoreCommit: string;
      try {
        restoreCommit = await git.createHistoryRestoreMergeCommitObject({
          vaultId: vault.vault_id,
          tree,
          expectedMain: operation.current_main,
          sourceCommit,
          path,
          sourcePath,
          userId: session.user.user_id
        });
        await prepareRouteRefUpdate(store, operation.operation_id, 'refs/heads/main', restoreCommit);
        await git.updateRef(vault.vault_id, 'refs/heads/main', restoreCommit, operation.current_main);
      } catch (error) {
        await abortOperationForRoute(store, operation.operation_id, 'history_restore_git_error');
        throw error;
      }
      const eventSeq = await store.mutate((mutableDb) => {
        const mutableVault = ownedVaultOrThrow(mutableDb, session.user.user_id, vaultId);
        const op = mutableDb.sync_operations.find((candidate) => candidate.operation_id === operation.operation_id);
        if (op) {
          op.status = 'committed';
          op.target_refs = { 'refs/heads/main': restoreCommit };
          op.target_commit = restoreCommit;
          op.result = {
            restore_commit: restoreCommit,
            source_commit: sourceCommit,
            path,
            source_path: sourcePath,
            decision: 'note_restored'
          };
          op.updated_at = nowIso();
        }
        mutableVault.current_main = restoreCommit;
        mutableVault.updated_at = nowIso();
        const mainEvent = store.appendEvent(mutableDb, {
          event_type: 'main_advanced',
          vault_id: vault.vault_id,
          resource_ids: { vault_id: vault.vault_id },
          commit_cursors: { previous_main: operation.current_main, main: restoreCommit, source_commit: sourceCommit },
          payload: { decision: 'note_restored', path_id: redactedPathId(path) }
        });
        store.appendEvent(mutableDb, {
          event_type: 'note_restored',
          vault_id: vault.vault_id,
          resource_ids: { vault_id: vault.vault_id },
          commit_cursors: { previous_main: operation.current_main, main: restoreCommit, source_commit: sourceCommit },
          payload: { path_id: redactedPathId(path), source_commit: sourceCommit }
        });
        mutableDb.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: session.user.user_id,
          actor_device_id: null,
          vault_id: vault.vault_id,
          action: 'note_restored',
          resource_class: 'note',
          resource_id: null,
          created_at: nowIso()
        });
        return mainEvent.event_seq;
      });
      return {
        status: 'restored',
        path,
        source_path: sourcePath,
        source_commit: sourceCommit,
        main: restoreCommit,
        restore_commit: restoreCommit,
        event_seq: eventSeq
      };
    });
  });

  app.post('/api/v1/vaults/:vaultId/maintenance/git-gc/start', async (request) => {
    const session = await auth.authenticateSession(request.cookies[config.sessionCookieName]);
    auth.requireCsrf(session.session, request.headers['x-obts-csrf']);
    auth.requireRecentAuth(session.session);
    const { vaultId } = pathParams(request);
    return await sync.runWithVaultLock(vaultId, async () => {
      const db = await store.snapshot();
      const vault = ownedVaultOrThrow(db, session.user.user_id, vaultId);
      if (vault.status === 'blocked_integrity') {
        throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      }
      await ensureProtectedConflictRefs(store, git, vault.vault_id);
      const protectedState = await store.snapshot();
      const protectedVault = ownedVaultOrThrow(protectedState, session.user.user_id, vaultId);
      if (protectedVault.status === 'blocked_integrity') {
        throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      }
      const started = await store.mutate((mutableDb) => {
      const op = store.startOperation(mutableDb, {
        vault_id: vault.vault_id,
        device_id: null,
        operation_type: 'git_maintenance',
        expected_refs: { 'refs/heads/main': vault.current_main },
        target_refs: {},
        target_commit: null
      });
      op.status = 'prepared';
      op.prepared_manifest = {
        operation_type: 'git_maintenance',
        current_main: vault.current_main,
        actor_user_id: session.user.user_id
      };
      op.updated_at = nowIso();
      const event = store.appendEvent(mutableDb, {
        event_type: 'vault_maintenance_started',
        vault_id: vault.vault_id,
        resource_ids: { vault_id: vault.vault_id },
        commit_cursors: { main: vault.current_main },
        payload: { task: 'git_gc' }
      });
      mutableDb.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: session.user.user_id,
        actor_device_id: null,
        vault_id: vault.vault_id,
        action: 'git_maintenance_started',
        resource_class: 'vault',
        resource_id: vault.vault_id,
        created_at: nowIso()
      });
      return { eventSeq: event.event_seq, operationId: op.operation_id };
      });
      let detail: string;
      try {
        detail = await git.runMaintenance(vault.vault_id);
      } catch (error) {
        await abortOperationForRoute(store, started.operationId, 'git_maintenance_failed');
        await store.mutate((mutableDb) => {
          store.appendEvent(mutableDb, {
            event_type: 'vault_maintenance_finished',
            vault_id: vault.vault_id,
            resource_ids: { vault_id: vault.vault_id },
            commit_cursors: { main: vault.current_main },
            payload: { task: 'git_gc', status: 'failed' }
          });
          mutableDb.audit_log.push({
            audit_id: newId('aud'),
            actor_user_id: session.user.user_id,
            actor_device_id: null,
            vault_id: vault.vault_id,
            action: 'git_maintenance_failed',
            resource_class: 'vault',
            resource_id: vault.vault_id,
            created_at: nowIso()
          });
        });
        throw error;
      }
      const postMaintenanceDb = await store.snapshot();
      const indexedPaths = [
        ...new Set((postMaintenanceDb.derived_history_by_vault[vault.vault_id] ?? []).map((entry) => entry.path))
      ];
      const refreshedHistory: MetadataDb['derived_history_by_vault'][string] = [];
      for (const indexedPath of indexedPaths) {
        refreshedHistory.push({
          path: indexedPath,
          current_main: vault.current_main,
          versions: await buildNoteHistoryVersions(
            git,
            postMaintenanceDb,
            vault.vault_id,
            vault.current_main,
            indexedPath,
            200
          ),
          indexed_at: nowIso()
        });
      }
      const eventSeq = await store.mutate((mutableDb) => {
        const operation = mutableDb.sync_operations.find((candidate) => candidate.operation_id === started.operationId);
        if (operation) {
          operation.status = 'committed';
          operation.result = { detail };
          operation.updated_at = nowIso();
        }
        const event = store.appendEvent(mutableDb, {
          event_type: 'vault_maintenance_finished',
          vault_id: vault.vault_id,
          resource_ids: { vault_id: vault.vault_id },
          commit_cursors: { main: vault.current_main },
          payload: { task: 'git_gc', status: 'completed' }
        });
        mutableDb.derived_history_by_vault[vault.vault_id] = refreshedHistory;
        mutableDb.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: session.user.user_id,
          actor_device_id: null,
          vault_id: vault.vault_id,
          action: 'git_maintenance_finished',
          resource_class: 'vault',
          resource_id: vault.vault_id,
          created_at: nowIso()
        });
        return event.event_seq;
      });
      return { status: 'completed', started_event_seq: started.eventSeq, event_seq: eventSeq, detail };
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

function buildDashboardConflicts(
  db: MetadataDb,
  vaultId: string,
  currentMain: string,
  conflicts: MetadataDb['conflicts']
): Array<MetadataDb['conflicts'][number] & { device_name: string; conflict_type: string; stale: boolean; status_label: string }> {
  return conflicts
    .filter((conflict) => conflict.vault_id === vaultId)
    .map((conflict) => {
      const device = db.devices.find((candidate) => candidate.device_id === conflict.device_id);
      const stale = conflict.status === 'open' && conflict.expected_main !== currentMain;
      return {
        ...conflict,
        device_name: device?.device_name ?? 'Unknown device',
        conflict_type: conflictType(conflict),
        stale,
        status_label: stale ? 'Stale review' : conflict.status === 'open' ? 'Review needed' : 'Synced'
      };
    })
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'open' ? -1 : 1;
      }
      return right.created_at.localeCompare(left.created_at);
    });
}

function conflictType(conflict: MetadataDb['conflicts'][number]): string {
  const reason = conflict.validator_results.reason ?? conflict.validator_summary.reason;
  if (typeof reason === 'string') {
    return reason.replaceAll('_', ' ');
  }
  if (conflict.affected_paths.some((path) => path.endsWith('.md'))) {
    return 'Markdown overlap';
  }
  if (conflict.affected_paths.some((path) => path.endsWith('.canvas'))) {
    return 'Canvas overlap';
  }
  if (conflict.affected_paths.some((path) => path.endsWith('.base'))) {
    return 'Bases overlap';
  }
  return 'Path overlap';
}

function buildRecentActivity(db: MetadataDb, vaultId: string): Array<{
  event_id: string;
  event_seq: number;
  event_type: string;
  label: string;
  created_at: string;
  device_id?: string;
  conflict_id?: string;
  main?: string | null;
}> {
  return db.events
    .filter((event) => event.vault_id === vaultId)
    .sort((left, right) => right.event_seq - left.event_seq)
    .slice(0, 12)
    .map((event) => ({
      event_id: event.event_id,
      event_seq: event.event_seq,
      event_type: event.event_type,
      label: activityLabel(event.event_type),
      created_at: event.created_at,
      ...(event.resource_ids.device_id ? { device_id: event.resource_ids.device_id } : {}),
      ...(event.resource_ids.conflict_id ? { conflict_id: event.resource_ids.conflict_id } : {}),
      main: event.commit_cursors.main ?? null
    }));
}

function activityLabel(eventType: string): string {
  switch (eventType) {
    case 'main_advanced':
      return 'Server main advanced';
    case 'device_ref_updated':
      return 'Device changes uploaded';
    case 'conflict_created':
      return 'Conflict created';
    case 'conflict_review_refreshed':
      return 'Conflict review refreshed';
    case 'conflict_resolved':
      return 'Conflict resolved';
    case 'note_restored':
      return 'Note restored';
    case 'vault_maintenance_started':
      return 'Maintenance started';
    case 'vault_maintenance_finished':
      return 'Maintenance completed';
    case 'device_sync_rejected':
      return 'Device sync rejected';
    case 'device_recovery_required':
      return 'Device recovery required';
    default:
      return 'Device state changed';
  }
}

function buildMaintenanceRows(health: Awaited<ReturnType<typeof buildReadinessSummary>>): Array<{
  key: string;
  label: string;
  status_label: string;
  last_checked_at: string;
  detail: string;
  action?: string;
}> {
  const checkedAt = nowIso();
  const rows = [
    ['metadata_store', 'Postgres', 'Metadata store is writable.'],
    ['git_store', 'Server Git store', 'Server Git store is writable.'],
    ['temp_workspace', 'Temp workspace', 'Temporary workspace is writable.'],
    ['migrations', 'Migrations', 'Metadata schema is current.'],
    ['git', 'Native git', health.git_version],
    ['filesystem_permissions', 'Filesystem permissions', 'Persistent and temporary directories are writable.'],
    ['event_delivery', 'Event delivery', 'Event log cursors are internally consistent.'],
    ['persistent_state', 'Persistent-state backup contract', 'Protect and back up metadata plus the Git store together.']
  ] as const;
  return rows.map(([key, label, okDetail]) => ({
    key,
    label,
    status_label: health.checks[key] ? 'Synced' : 'Integrity failure',
    last_checked_at: checkedAt,
    detail: health.checks[key] ? okDetail : health.detail ?? 'Check failed.',
    ...(label === 'Server Git store' ? { action: 'start_git_maintenance' } : {}),
    ...(label === 'Persistent-state backup contract' ? { action: 'view_backup_contract' } : {})
  }));
}

function readVaultContentPath(record: Record<string, unknown>, field: string): string {
  const path = readString(record, field);
  if (!isSyncableVaultPath(path)) {
    throw new ValidationError('invalid_path', 'Path is not syncable vault content.', { field });
  }
  return path;
}

function readHistoryLimit(record: Record<string, unknown>): number {
  if (record.limit === undefined) {
    return 50;
  }
  if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > 200) {
    throw new ValidationError('invalid_request', 'History limit must be an integer from 1 to 200.', { field: 'limit' });
  }
  return record.limit;
}

function requireHistoryAvailable(status: 'active' | 'blocked_integrity'): void {
  if (status === 'blocked_integrity') {
    throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
  }
}

function isCommunityPluginFile(path: string): boolean {
  return path.startsWith('.obsidian/plugins/');
}

function redactedPathId(path: string): string {
  return `path_${sha256Hex(Buffer.from(path, 'utf8')).slice(0, 16)}`;
}

function buildRedactedDiagnostics(
  db: MetadataDb,
  vaultId: string,
  health: Awaited<ReturnType<typeof buildReadinessSummary>>
): {
  generated_at: string;
  vault: { vault_id: string; status: 'active' | 'blocked_integrity'; current_main: string };
  devices: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  event_cursor: number;
  operation_counts: Record<string, number>;
  health: { status: 'ready' | 'not_ready'; checks: Record<string, boolean>; detail: string | null };
  redactions: string[];
} {
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  if (!vault) {
    throw new AuthError(404, 'not_found', 'Resource not found.');
  }
  const operations = db.sync_operations.filter((operation) => operation.vault_id === vaultId);
  const operationCounts: Record<string, number> = {};
  for (const operation of operations) {
    const key = `${operation.operation_type}:${operation.status}`;
    operationCounts[key] = (operationCounts[key] ?? 0) + 1;
  }
  return {
    generated_at: nowIso(),
    vault: { vault_id: vault.vault_id, status: vault.status, current_main: vault.current_main },
    devices: db.devices
      .filter((device) => device.vault_id === vaultId)
      .map((device) => ({
        device_id: device.device_id,
        status: device.status,
        last_seen_at: device.last_seen_at,
        last_successful_sync_at: device.last_successful_sync_at,
        local_status_label: device.local_status_label === null ? null : 'reported',
        local_error_code: device.local_error_code === null ? null : 'reported_error'
      })),
    conflicts: db.conflicts
      .filter((conflict) => conflict.vault_id === vaultId)
      .map((conflict) => ({
        conflict_id: conflict.conflict_id,
        device_id: conflict.device_id,
        status: conflict.status,
        affected_path_count: conflict.affected_path_count,
        created_at: conflict.created_at,
        ...(conflict.resolved_at ? { resolved_at: conflict.resolved_at } : {})
      })),
    event_cursor: db.event_seq_by_vault[vaultId] ?? 0,
    operation_counts: operationCounts,
    health: { status: health.status, checks: health.checks, detail: health.detail },
    redactions: [
      'note bodies',
      'raw vault paths',
      'plugin settings and file bodies',
      'tokens and credentials',
      'Git packfiles and raw blobs',
      'recovery bundle content',
      'request bodies and operation manifests'
    ]
  };
}

async function buildNoteHistoryVersions(
  git: GitService,
  db: MetadataDb,
  vaultId: string,
  currentMain: string,
  path: string,
  limit: number
): Promise<NoteHistoryVersion[]> {
  const historyCommits = await git.firstParentHistory(vaultId, currentMain);
  const versions: NoteHistoryVersion[] = [];
  let pathAtCommit = path;
  for (const commit of historyCommits) {
    const classification = await classifyHistoryOperation(
      git,
      db,
      vaultId,
      commit.commit,
      commit.parentCommit,
      pathAtCommit,
      commit.subject,
      commit.body
    );
    if (classification === null) {
      continue;
    }
    const provenance = historyProvenance(commit.body);
    const provenanceDevice = provenance.device_id
      ? db.devices.find((candidate) => candidate.device_id === provenance.device_id)
      : undefined;
    const provenanceUserId = provenance.user_id ?? provenanceDevice?.user_id;
    versions.push({
      commit: commit.commit,
      parent_commit: commit.parentCommit,
      tree: commit.tree,
      path: classification.path,
      operation_type: classification.operationType,
      timestamp: commit.authorDate,
      author_name: commit.authorName,
      author_email: commit.authorEmail,
      subject: commit.subject,
      ...(classification.previousPath ? { previous_path: classification.previousPath } : {}),
      ...provenance,
      ...(provenanceUserId ? { user_id: provenanceUserId } : {})
    });
    if (classification.previousPath) {
      pathAtCommit = classification.previousPath;
    }
    if (versions.length >= limit) {
      break;
    }
  }
  return versions;
}

async function classifyHistoryOperation(
  git: GitService,
  db: MetadataDb,
  vaultId: string,
  commit: string,
  parentCommit: string | null,
  path: string,
  subject: string,
  body: string
): Promise<{
  operationType: 'create' | 'update' | 'delete' | 'rename' | 'restore' | 'merge' | 'conflict_resolution';
  path: string;
  previousPath: string | null;
} | null> {
  const resolvedConflict = db.conflicts.find(
    (candidate) =>
      candidate.vault_id === vaultId &&
      candidate.resolution_commit === commit &&
      candidate.affected_paths.includes(path)
  );
  if (resolvedConflict) {
    return { operationType: 'conflict_resolution', path, previousPath: null };
  }
  const restorePath = /^path=(.+)$/mu.exec(body)?.[1];
  if ((body.includes('source_commit=') || subject.startsWith('obts: restore ')) && restorePath === path) {
    return { operationType: 'restore', path, previousPath: null };
  }
  const current = await git.readBlobAtPathIfPresent(vaultId, commit, path);
  if (parentCommit === null) {
    return current === null ? null : { operationType: 'create', path, previousPath: null };
  }
  const changes = await git.changedPaths(vaultId, parentCommit, commit);
  const rename = changes.find((entry) => entry.status.startsWith('R') && entry.path === path);
  if (rename?.oldPath) {
    return { operationType: 'rename', path: rename.path, previousPath: rename.oldPath };
  }
  const pathChange = changes.find((entry) => entry.path === path);
  if (!pathChange) {
    return null;
  }
  if (body.includes('conflict_id=') || subject.includes('resolve conflict')) {
    return { operationType: 'conflict_resolution', path, previousPath: null };
  }
  const previous = await git.readBlobAtPathIfPresent(vaultId, parentCommit, path);
  if (previous === null && current !== null) {
    return { operationType: 'create', path, previousPath: null };
  }
  if (previous !== null && current === null) {
    return { operationType: 'delete', path, previousPath: null };
  }
  const mergeBase = /^base=([0-9a-f]{40})$/mu.exec(body)?.[1];
  if (subject.includes('merge device changes') && mergeBase !== parentCommit) {
    return { operationType: 'merge', path, previousPath: null };
  }
  return { operationType: 'update', path, previousPath: null };
}

async function inferHistorySourcePath(
  git: GitService,
  db: MetadataDb,
  vaultId: string,
  currentMain: string,
  targetPath: string,
  sourceCommit: string
): Promise<string | null> {
  const history = await buildNoteHistoryVersions(git, db, vaultId, currentMain, targetPath, Number.MAX_SAFE_INTEGER);
  return history.find((version) => version.commit === sourceCommit)?.path ?? null;
}

function historyProvenance(body: string): {
  device_id?: string;
  user_id?: string;
  conflict_id?: string;
  merge_sequence?: number;
} {
  const deviceId = /^device_id=(.+)$/mu.exec(body)?.[1];
  const userId = /^user_id=(.+)$/mu.exec(body)?.[1];
  const conflictId = /^conflict_id=(.+)$/mu.exec(body)?.[1];
  const mergeSequence = /^merge_sequence=(\d+)$/mu.exec(body)?.[1];
  return {
    ...(deviceId ? { device_id: deviceId } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(conflictId ? { conflict_id: conflictId } : {}),
    ...(mergeSequence ? { merge_sequence: Number.parseInt(mergeSequence, 10) } : {})
  };
}

function renderMarkdownDiff(sourceDiff: string, content: string | null): string | null {
  if (content === null) {
    return null;
  }
  const meaningfulDiff = sourceDiff
    .split(/\r?\n/u)
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => {
      const escaped = escapeHtml(line.slice(1));
      return line.startsWith('+') ? `<ins>${escaped}</ins>` : `<del>${escaped}</del>`;
    });
  return meaningfulDiff.length > 0 ? meaningfulDiff.join('<br>') : escapeHtml(content).replaceAll('\n', '<br>');
}

function escapeHtml(value: string): string {
  return value.replace(/[<&>]/gu, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] ?? char);
}

async function abortOperationForRoute(store: MetadataStore, operationId: string, reason: string): Promise<void> {
  await store.mutate((db) => {
    const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
    if (operation && operation.status !== 'committed') {
      operation.status = 'aborted';
      operation.result = { reason };
      operation.updated_at = nowIso();
    }
  });
}

async function prepareRouteRefUpdate(
  store: MetadataStore,
  operationId: string,
  ref: string,
  targetCommit: string
): Promise<void> {
  await store.mutate((db) => {
    const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
    if (!operation || operation.status === 'committed') {
      return;
    }
    operation.target_refs = {
      ...operation.target_refs,
      [ref]: targetCommit
    };
    operation.target_commit = targetCommit;
    operation.updated_at = nowIso();
  });
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

function directoryIntentsFromEvents(events: Array<{ payload: Record<string, unknown> }>): DirectoryIntent[] {
  const intents: DirectoryIntent[] = [];
  for (const event of events) {
    const rawIntents = event.payload.directory_intents;
    if (!Array.isArray(rawIntents)) {
      continue;
    }
    for (const rawIntent of rawIntents) {
      if (typeof rawIntent !== 'object' || rawIntent === null || Array.isArray(rawIntent)) {
        continue;
      }
      const op = (rawIntent as { op?: unknown }).op;
      const path = (rawIntent as { path?: unknown }).path;
      if ((op === 'create' || op === 'delete') && typeof path === 'string') {
        intents.push({ op, path });
      }
    }
  }
  return compactDirectoryIntents(intents);
}

function compactDirectoryIntents(intents: DirectoryIntent[]): DirectoryIntent[] {
  const byPath = new Map<string, DirectoryIntent>();
  for (const intent of intents) {
    if (intent.op === 'delete') {
      for (const path of [...byPath.keys()]) {
        if (path === intent.path || path.startsWith(`${intent.path}/`)) {
          byPath.delete(path);
        }
      }
    }
    byPath.set(intent.path, intent);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path) || left.op.localeCompare(right.op));
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

function readDeviceStatusReport(record: Record<string, unknown>): {
  pluginVersion: string;
  localStatusLabel: string;
  localErrorCode: string | null;
  localErrorDetails: Record<string, unknown> | null;
  localQueueStatus: string | null;
  localMain: string | null;
  localHead: string | null;
  pathCapabilities: Record<string, unknown> | null;
} {
  return {
    pluginVersion: readBoundedString(record, 'plugin_version', 80),
    localStatusLabel: readBoundedString(record, 'local_status_label', 80),
    localErrorCode: readNullableBoundedString(record, 'local_error_code', 120),
    localErrorDetails: readNullableSmallRecord(record, 'local_error_details'),
    localQueueStatus: readNullableBoundedString(record, 'local_queue_status', 80),
    localMain: readNullableCommitId(record, 'local_main'),
    localHead: readNullableCommitId(record, 'local_head'),
    pathCapabilities: readNullableSmallRecord(record, 'path_capabilities')
  };
}

function readBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = readString(record, key);
  if (value.length > maxLength) {
    throw new ValidationError('invalid_request', `${key} is too long.`);
  }
  return value;
}

function readNullableBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_request', `${key} must be a string or null.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError('invalid_request', `${key} is too long.`);
  }
  return value;
}

function readNullableCommitId(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_request', `${key} must be a commit ID or null.`);
  }
  return readCommitId(record, key);
}

function readNullableSmallRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  assertRecord(value);
  if (JSON.stringify(value).length > 4096) {
    throw new ValidationError('invalid_request', `${key} is too large.`);
  }
  return value;
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

function readManualFilePlan(record: Record<string, unknown>): ManualFilePlanEntry[] | undefined {
  const value = record.manual_file_plan;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ValidationError('invalid_request', 'Manual file plan must be an array.', { field: 'manual_file_plan' });
  }
  return value.map((entry, index) => {
    assertRecord(entry);
    const path = readVaultContentPath(entry, 'path');
    const content = entry.content;
    if (typeof content !== 'string' && content !== null) {
      throw new ValidationError('invalid_request', 'Manual file plan content values must be strings or null.', {
        field: `manual_file_plan.${index}.content`
      });
    }
    return { path, content };
  });
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
  const dashboardRoot = await dashboardStaticRoot();
  const url = new URL(request.url, 'http://obts.local');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendStaticNotFound(reply, request.id);
  }
  const relativePath =
    pathname === '/' || pathname === '/dashboard' || pathname.startsWith('/dashboard/')
      ? 'index.html'
      : pathname.replace(/^\/+/u, '');
  const absolutePath = resolve(dashboardRoot, relativePath);
  if (!absolutePath.startsWith(`${dashboardRoot}/`) && absolutePath !== dashboardRoot) {
    return sendStaticNotFound(reply, request.id);
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
    return sendStaticNotFound(reply, request.id);
  }
}

async function dashboardStaticRoot(): Promise<string> {
  dashboardRootPromise ??= findDashboardStaticRoot();
  return await dashboardRootPromise;
}

async function findDashboardStaticRoot(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const moduleRoot = resolve(moduleDir, '..', '..', 'frontend', 'dashboard');
  const cwdBuildRoot = resolve(process.cwd(), 'dist', 'frontend', 'dashboard');
  const roots = [...new Set([moduleRoot, cwdBuildRoot])];
  const builtRoot = await firstRootMatching(roots, async (root) => (await isFile(join(root, 'index.html'))) && (await isDirectory(join(root, 'assets'))));
  if (builtRoot) {
    return builtRoot;
  }
  const runningFromSource = moduleDir.endsWith('/src/server') || moduleDir.endsWith('\\src\\server');
  return runningFromSource ? cwdBuildRoot : moduleRoot;
}

function sendStaticNotFound(reply: FastifyReply, requestId: string): FastifyReply {
  return reply.status(404).send({
    error: {
      code: 'not_found',
      message: 'Resource not found.',
      request_id: requestId,
      details: {}
    }
  });
}

async function firstRootMatching(roots: string[], predicate: (root: string) => Promise<boolean>): Promise<string | null> {
  for (const root of roots) {
    if (await predicate(root)) {
      return root;
    }
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
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
    const directory = await stat(path);
    if (!directory.isDirectory() || (directory.mode & 0o700) !== 0o700) {
      return { ok: false, error: 'persistent directory permissions do not allow owner read, write, and search access' };
    }
    if ((directory.mode & 0o077) !== 0) {
      return { ok: false, error: 'persistent directory permissions allow group or other access' };
    }
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
    filesystem_permissions: boolean;
    event_delivery: boolean;
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
  if (!persistentState.ok && persistentState.vaultId) {
    await blockVaultForIntegrity(store, persistentState.vaultId);
  }
  const eventDelivery = checkEventDelivery(db);
  const filesystemPermissions = metadataStoreReady.ok && gitStoreReady.ok && tempWorkspaceReady.ok;
  const checks = {
    metadata: true,
    metadata_store: metadataStoreReady.ok,
    git: gitReady.ok,
    setup_complete: db.setup_complete,
    migrations: db.schema_version === 2,
    git_store: gitStoreReady.ok,
    temp_workspace: tempWorkspaceReady.ok,
    filesystem_permissions: filesystemPermissions,
    event_delivery: eventDelivery.ok,
    persistent_state: persistentState.ok
  };
  const ready =
    checks.metadata_store &&
    checks.git &&
    checks.migrations &&
    checks.git_store &&
    checks.temp_workspace &&
    checks.filesystem_permissions &&
    checks.event_delivery &&
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
          readinessError(eventDelivery),
          readinessError(persistentState)
        ]),
    git_version: gitReady.ok ? gitReady.version : 'unknown'
  };
}

function checkEventDelivery(db: MetadataDb): { ok: true } | { ok: false; error: string } {
  for (const [vaultId, currentSeq] of Object.entries(db.event_seq_by_vault)) {
    const vaultEvents = db.events
      .filter((event) => event.vault_id === vaultId)
      .sort((left, right) => left.event_seq - right.event_seq);
    if (vaultEvents.some((event) => event.event_seq > currentSeq)) {
      return { ok: false, error: 'event log contains a cursor beyond the recorded vault cursor' };
    }
    for (let index = 1; index < vaultEvents.length; index += 1) {
      const previous = vaultEvents[index - 1];
      const current = vaultEvents[index];
      if (previous && current && current.event_seq <= previous.event_seq) {
        return { ok: false, error: 'event log cursors are not strictly increasing' };
      }
    }
  }
  return { ok: true };
}

type PersistentStateCheck = { ok: true } | { ok: false; error: string; vaultId?: string };

async function checkPersistentState(db: MetadataDb, git: GitService): Promise<PersistentStateCheck> {
  if (db.schema_version !== 2) {
    return { ok: false, error: 'metadata schema version is unsupported' };
  }
  try {
    const metadataVaultIds = new Set(db.vaults.map((vault) => vault.vault_id));
    const orphanRepository = (await git.listVaultRepositoryIds()).find((vaultId) => !metadataVaultIds.has(vaultId));
    if (orphanRepository) {
      return { ok: false, error: 'server Git store contains a vault repository missing from metadata' };
    }
  } catch {
    return { ok: false, error: 'server Git store cannot be enumerated' };
  }
  for (const vault of db.vaults) {
    const result = await checkVaultPersistentState(db, vault.vault_id, git);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

async function checkVaultPersistentState(db: MetadataDb, vaultId: string, git: GitService): Promise<PersistentStateCheck> {
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  if (!vault) {
    return { ok: false, error: 'vault metadata is missing' };
  }
  if (vault.status === 'blocked_integrity') {
    return { ok: false, error: 'vault persistent state is blocked by an integrity failure' };
  }
  const permissions = await git.checkRepositoryPermissions(vaultId);
  if (!permissions.ok) {
    return { ...permissions, vaultId };
  }
  const mainRef = await git.getRef(vaultId, 'refs/heads/main');
  if (mainRef !== vault.current_main) {
    return { ok: false, error: 'vault main ref is inconsistent with metadata', vaultId };
  }
  if (!(await git.commitExists(vaultId, vault.current_main))) {
    return { ok: false, error: 'vault main commit is missing from the Git store', vaultId };
  }
  const integrity = await git.checkIntegrity(vaultId);
  if (!integrity.ok) {
    return { ...integrity, vaultId };
  }
  for (const device of db.devices.filter((candidate) => candidate.vault_id === vaultId)) {
    const deviceRef = await git.getRef(vaultId, device.device_ref);
    if ((device.device_ref_head ?? null) !== deviceRef) {
      return { ok: false, error: 'device ref is inconsistent with metadata', vaultId };
    }
    if (device.last_applied_main !== null && !(await git.commitExists(vaultId, device.last_applied_main))) {
      return { ok: false, error: 'device applied main cursor is missing from the Git store', vaultId };
    }
  }
  for (const conflict of db.conflicts.filter((candidate) => candidate.vault_id === vaultId)) {
    for (const commit of [conflict.current_main, conflict.device_commit, conflict.base_commit]) {
      if (commit && !(await git.commitExists(vaultId, commit))) {
        return { ok: false, error: 'conflict commit is missing from the Git store', vaultId };
      }
    }
    if (conflict.status === 'open') {
      for (const [kind, commit] of conflictProtectedRefs(conflict)) {
        if ((await git.getRef(vaultId, conflictRef(conflict.conflict_id, kind))) !== commit) {
          return { ok: false, error: 'unresolved conflict protection ref is inconsistent with metadata', vaultId };
        }
      }
    }
  }
  for (const index of db.derived_history_by_vault[vaultId] ?? []) {
    if (index.current_main !== vault.current_main) {
      continue;
    }
    for (const version of index.versions) {
      if (!(await git.commitExists(vaultId, version.commit))) {
        return { ok: false, error: 'derived note history points at a missing Git commit', vaultId };
      }
    }
  }
  return { ok: true };
}

async function markInconsistentVaults(store: MetadataStore, git: GitService): Promise<void> {
  if (!(await git.checkReady()).ok) {
    return;
  }
  const db = await store.snapshot();
  for (const vault of db.vaults.filter((candidate) => candidate.status === 'active')) {
    const result = await checkVaultPersistentState(db, vault.vault_id, git);
    if (!result.ok) {
      await blockVaultForIntegrity(store, vault.vault_id);
    }
  }
}

async function blockVaultForIntegrity(store: MetadataStore, vaultId: string): Promise<void> {
  await store.mutate((db) => {
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    if (vault && vault.status !== 'blocked_integrity') {
      vault.status = 'blocked_integrity';
      vault.updated_at = nowIso();
    }
  });
}

function conflictRef(conflictId: string, kind: string): string {
  return `refs/obts/conflicts/${conflictId}/${kind}`;
}

function conflictProtectedRefs(conflict: MetadataDb['conflicts'][number]): Array<[string, string]> {
  return [
    ['base', conflict.base_commit],
    ['device', conflict.device_commit]
  ];
}

async function ensureProtectedConflictRefs(store: MetadataStore, git: GitService, onlyVaultId?: string): Promise<void> {
  const db = await store.snapshot();
  for (const conflict of db.conflicts.filter(
    (candidate) => candidate.status === 'open' && (onlyVaultId === undefined || candidate.vault_id === onlyVaultId)
  )) {
    try {
      for (const [kind, commit] of conflictProtectedRefs(conflict)) {
        if (!(await git.commitExists(conflict.vault_id, commit))) {
          throw new GitCommandError('Conflict protection target is missing.', '');
        }
        await git.ensureRef(conflict.vault_id, conflictRef(conflict.conflict_id, kind), commit);
      }
    } catch {
      await store.mutate((mutableDb) => {
        const vault = mutableDb.vaults.find((candidate) => candidate.vault_id === conflict.vault_id);
        if (vault) {
          vault.status = 'blocked_integrity';
          vault.updated_at = nowIso();
        }
      });
    }
  }
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
    (operation.operation_type === 'server_merge' ||
      operation.operation_type === 'conflict_resolve' ||
      operation.operation_type === 'note_restore') &&
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

    if (
      operation.operation_type === 'server_merge' ||
      operation.operation_type === 'conflict_resolve' ||
      operation.operation_type === 'note_restore'
    ) {
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
        decision:
          operation.operation_type === 'conflict_resolve'
            ? 'resolved'
            : operation.operation_type === 'note_restore'
              ? 'note_restored'
              : 'merged',
        ...(operation.operation_type === 'conflict_resolve'
          ? { conflict_id: conflictId, resolution_commit: targetMain }
          : operation.operation_type === 'note_restore'
            ? {
                restore_commit: targetMain,
                source_commit: stringValue(manifest.source_commit),
                path_id: typeof manifest.path === 'string' ? redactedPathId(manifest.path) : null
              }
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
          decision:
            operation.operation_type === 'conflict_resolve'
              ? 'resolved'
              : operation.operation_type === 'note_restore'
                ? 'note_restored'
                : 'merged',
          merge_sequence: manifest.merge_sequence ?? null,
          merge_policy_version: manifest.merge_policy_version ?? null,
          reconciled_after_startup: true
        }
      });
      if (operation.operation_type === 'note_restore') {
        store.appendEvent(db, {
          event_type: 'note_restored',
          vault_id: operation.vault_id,
          resource_ids: { vault_id: operation.vault_id },
          commit_cursors: {
            previous_main: previousMain,
            main: targetMain,
            source_commit: stringValue(manifest.source_commit)
          },
          payload: {
            path_id: typeof manifest.path === 'string' ? redactedPathId(manifest.path) : null,
            reconciled_after_startup: true
          }
        });
        const actorUserId = stringValue(manifest.actor_user_id);
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: actorUserId,
          actor_device_id: null,
          vault_id: operation.vault_id,
          action: 'note_restored',
          resource_class: 'note',
          resource_id: null,
          created_at: nowIso()
        });
      }
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
    return 'Blocked';
  }
  return 'Ahead';
}

function dashboardDeviceStatusLabel(
  status: string,
  state: { behindMain: boolean; offline: boolean; localStatusLabel?: string | null; localErrorCode?: string | null }
): string {
  if (isLocalStatusOverride(state.localStatusLabel ?? null, state.localErrorCode ?? null)) {
    return state.localStatusLabel || 'Unsafe local state';
  }
  if (status === 'synced' && state.offline) {
    return 'Offline';
  }
  if (status === 'synced' && state.behindMain) {
    return 'Behind';
  }
  return deviceStatusLabel(status);
}

function isFreshDeviceStatus(reportedAt: string | null): boolean {
  return reportedAt !== null && Date.now() - Date.parse(reportedAt) <= 5 * 60 * 1000;
}

function isLocalStatusOverride(label: string | null, errorCode: string | null): boolean {
  return Boolean(
    errorCode ||
      label === 'Unsafe local state' ||
      label === 'Needs recovery' ||
      label === 'Blocked' ||
      label === 'Uploading' ||
      label === 'Applying' ||
      label === 'Ahead' ||
      label === 'Review needed'
  );
}

function isBlockingLocalReport(label: string | null, errorCode: string | null): boolean {
  return Boolean(errorCode || label === 'Unsafe local state' || label === 'Needs recovery' || label === 'Blocked' || label === 'Review needed');
}

function isMultipartLimitError(error: Error): boolean {
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_PARTS_LIMIT' || error.code === 'FST_FILES_LIMIT')
  );
}
