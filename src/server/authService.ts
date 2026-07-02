import { createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Algorithm, hash as argonHash, verify as argonVerify, Version } from '@node-rs/argon2';

import { newId, newSecretToken, nowIso } from '../shared/ids.js';
import type {
  DeviceRow,
  LegacyPasswordHash,
  MetadataDb,
  MetadataStore,
  PasswordHash,
  SessionRow,
  TokenRow,
  UserRow,
  VaultRow
} from './metadataStore.js';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_AUTH_MS = 15 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BACKOFF_BASE_MS = 60 * 1000;
const LOGIN_BACKOFF_MAX_MS = 60 * 60 * 1000;
const ARGON2ID_MEMORY_COST = 19_456;
const ARGON2ID_TIME_COST = 2;
const ARGON2ID_PARALLELISM = 1;

export class AuthError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type AuthenticatedSession = {
  user: UserRow;
  session: SessionRow;
};

export type AuthenticatedDevice = {
  user: UserRow;
  vault: VaultRow;
  device: DeviceRow;
  token: TokenRow;
};

export type AdminUserSummary = {
  user_id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
  owned_vault_count: number;
};

export class AuthService {
  constructor(private readonly store: MetadataStore) {}

  async setupInitialAdmin(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: UserRow; csrfToken: string; sessionId: string; recentAuthExpiresAt: string }> {
    if (input.password.length < 12) {
      throw new AuthError(400, 'weak_password', 'Password must be at least 12 characters.');
    }
    return await this.store.mutate(async (db) => {
      if (db.setup_complete) {
        throw new AuthError(409, 'setup_complete', 'Initial setup is already complete.');
      }
      const user: UserRow = {
        user_id: newId('usr'),
        username: input.username,
        display_name: input.displayName ?? input.username,
        password_hash: await hashPassword(input.password),
        is_admin: true,
        disabled: false,
        created_at: nowIso(),
        last_login_at: nowIso()
      };
      db.users.push(user);
      db.setup_complete = true;
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: user.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'initial_admin_created',
        resource_class: 'user',
        resource_id: user.user_id,
        created_at: nowIso()
      });
      const session = createSession(user.user_id);
      db.sessions.push(session);
      return {
        user,
        csrfToken: session.csrf_token,
        sessionId: session.session_id,
        recentAuthExpiresAt: new Date(Date.parse(session.recent_auth_at) + RECENT_AUTH_MS).toISOString()
      };
    });
  }

  async login(input: {
    username: string;
    password: string;
    sourceIp?: string;
  }): Promise<{ user: UserRow; csrfToken: string; sessionId: string; recentAuthExpiresAt: string }> {
    return await this.store.mutate(async (db) => {
      const sourceIp = input.sourceIp ?? 'unknown';
      enforceLoginBackoff(db, input.username, sourceIp);
      const user = db.users.find((candidate) => candidate.username === input.username);
      if (!user || user.disabled || !(await verifyPassword(input.password, user.password_hash))) {
        recordFailedLogin(db, input.username, sourceIp, user?.user_id ?? null);
        throw new AuthError(401, 'invalid_credentials', 'Invalid username or password.');
      }
      const timestamp = nowIso();
      user.last_login_at = timestamp;
      clearLoginFailures(db, input.username, sourceIp);
      const session = createSession(user.user_id);
      db.sessions.push(session);
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: user.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'login',
        resource_class: 'session',
        resource_id: null,
        created_at: timestamp
      });
      return {
        user,
        csrfToken: session.csrf_token,
        sessionId: session.session_id,
        recentAuthExpiresAt: new Date(Date.parse(session.recent_auth_at) + RECENT_AUTH_MS).toISOString()
      };
    });
  }

  async createUser(input: {
    actorUserId: string;
    username: string;
    password: string;
    displayName?: string;
    isAdmin?: boolean;
  }): Promise<UserRow> {
    if (input.password.length < 12) {
      throw new AuthError(400, 'weak_password', 'Password must be at least 12 characters.');
    }
    return await this.store.mutate(async (db) => {
      const actor = db.users.find((candidate) => candidate.user_id === input.actorUserId);
      if (!actor || actor.disabled || !actor.is_admin) {
        throw new AuthError(403, 'admin_required', 'Admin privileges are required.');
      }
      if (db.users.some((candidate) => candidate.username === input.username)) {
        throw new AuthError(409, 'username_exists', 'Username already exists.');
      }
      const user: UserRow = {
        user_id: newId('usr'),
        username: input.username,
        display_name: input.displayName ?? input.username,
        password_hash: await hashPassword(input.password),
        is_admin: input.isAdmin ?? false,
        disabled: false,
        created_at: nowIso(),
        last_login_at: null
      };
      db.users.push(user);
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: actor.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'user_created',
        resource_class: 'user',
        resource_id: user.user_id,
        created_at: nowIso()
      });
      return user;
    });
  }

  async listUsers(actorUserId: string): Promise<AdminUserSummary[]> {
    const db = await this.store.snapshot();
    this.requireAdmin(db, actorUserId);
    return db.users
      .map((user) => userSummary(db, user))
      .sort((left, right) => left.username.localeCompare(right.username) || left.user_id.localeCompare(right.user_id));
  }

  async setUserDisabled(input: { actorUserId: string; targetUserId: string; disabled: boolean }): Promise<AdminUserSummary> {
    return await this.store.mutate((db) => {
      const actor = this.requireAdmin(db, input.actorUserId);
      const target = requireUser(db, input.targetUserId);
      if (input.disabled && target.is_admin && enabledAdminCount(db, target.user_id) === 0) {
        throw new AuthError(409, 'final_admin_required', 'At least one enabled admin account is required.');
      }
      target.disabled = input.disabled;
      if (input.disabled) {
        revokeUserAuth(db, target.user_id);
      }
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: actor.user_id,
        actor_device_id: null,
        vault_id: null,
        action: input.disabled ? 'user_disabled' : 'user_enabled',
        resource_class: 'user',
        resource_id: target.user_id,
        created_at: nowIso()
      });
      return userSummary(db, target);
    });
  }

  async setUserAdmin(input: { actorUserId: string; targetUserId: string; isAdmin: boolean }): Promise<AdminUserSummary> {
    return await this.store.mutate((db) => {
      const actor = this.requireAdmin(db, input.actorUserId);
      const target = requireUser(db, input.targetUserId);
      if (!input.isAdmin && target.is_admin && enabledAdminCount(db, target.user_id) === 0) {
        throw new AuthError(409, 'final_admin_required', 'At least one enabled admin account is required.');
      }
      target.is_admin = input.isAdmin;
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: actor.user_id,
        actor_device_id: null,
        vault_id: null,
        action: input.isAdmin ? 'admin_granted' : 'admin_revoked',
        resource_class: 'user',
        resource_id: target.user_id,
        created_at: nowIso()
      });
      return userSummary(db, target);
    });
  }

  async createPasswordResetToken(input: { actorUserId: string; targetUserId: string }): Promise<{ token: string; expiresAt: string }> {
    const resetToken = newSecretToken('obts_reset');
    const tokenHash = hashToken(resetToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    await this.store.mutate((db) => {
      const actor = this.requireAdmin(db, input.actorUserId);
      const target = requireUser(db, input.targetUserId);
      const timestamp = nowIso();
      for (const token of db.tokens) {
        if (token.kind === 'password_reset' && token.user_id === target.user_id && !token.consumed_at && !token.revoked_at) {
          token.revoked_at = timestamp;
        }
      }
      db.tokens.push({
        token_id: newId('tok'),
        kind: 'password_reset',
        lookup_prefix: tokenHash.lookupPrefix,
        token_hash: tokenHash.hash,
        user_id: target.user_id,
        vault_id: null,
        device_id: null,
        expires_at: expiresAt,
        consumed_at: null,
        failed_attempts: 0,
        revoked_at: null,
        metadata: {},
        created_at: timestamp
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: actor.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'password_reset_token_created',
        resource_class: 'user',
        resource_id: target.user_id,
        created_at: timestamp
      });
    });
    return { token: resetToken, expiresAt };
  }

  async resetPassword(input: { resetToken: string; newPassword: string }): Promise<void> {
    if (input.newPassword.length < 12) {
      throw new AuthError(400, 'weak_password', 'Password must be at least 12 characters.');
    }
    const tokenHash = hashToken(input.resetToken);
    await this.store.mutate(async (db) => {
      const token = db.tokens.find(
        (candidate) =>
          candidate.kind === 'password_reset' &&
          candidate.lookup_prefix === tokenHash.lookupPrefix &&
          candidate.token_hash === tokenHash.hash
      );
      if (
        !token ||
        token.revoked_at ||
        token.consumed_at ||
        !token.expires_at ||
        Date.parse(token.expires_at) <= Date.now()
      ) {
        throw new AuthError(401, 'invalid_password_reset_token', 'Password reset token is invalid or expired.');
      }
      const user = requireUser(db, token.user_id);
      user.password_hash = await hashPassword(input.newPassword);
      token.consumed_at = nowIso();
      for (const session of db.sessions) {
        if (session.user_id === user.user_id && !session.revoked_at) {
          session.revoked_at = nowIso();
        }
      }
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: user.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'password_reset_completed',
        resource_class: 'user',
        resource_id: user.user_id,
        created_at: nowIso()
      });
    });
  }

  async revokeDevice(input: { actorUserId: string; vaultId: string; deviceId: string }): Promise<void> {
    await this.store.mutate((db) => {
      const vault = ownedVaultOrThrow(db, input.actorUserId, input.vaultId);
      const device = db.devices.find(
        (candidate) =>
          candidate.device_id === input.deviceId &&
          candidate.vault_id === vault.vault_id &&
          candidate.user_id === input.actorUserId
      );
      if (!device) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const timestamp = nowIso();
      device.status = 'revoked';
      device.revoked_at = timestamp;
      for (const token of db.tokens) {
        if (token.kind === 'device' && token.device_id === device.device_id && !token.revoked_at) {
          token.revoked_at = timestamp;
        }
      }
      this.store.appendEvent(db, {
        event_type: 'device_state_changed',
        vault_id: vault.vault_id,
        resource_ids: { device_id: device.device_id },
        commit_cursors: {
          main: vault.current_main,
          device_ref: device.device_ref_head
        },
        payload: {
          status: 'revoked'
        }
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: input.actorUserId,
        actor_device_id: null,
        vault_id: vault.vault_id,
        action: 'device_revoked',
        resource_class: 'device',
        resource_id: device.device_id,
        created_at: timestamp
      });
    });
  }

  async authenticateSession(sessionId: string | undefined): Promise<AuthenticatedSession> {
    if (!sessionId) {
      throw new AuthError(401, 'unauthenticated', 'Authentication required.');
    }
    return await this.store.mutate((db) => {
      const session = db.sessions.find((candidate) => candidate.session_id === sessionId);
      const now = Date.now();
      if (
        !session ||
        session.revoked_at ||
        Date.parse(session.expires_at) <= now ||
        Date.parse(session.idle_expires_at) <= now
      ) {
        throw new AuthError(401, 'unauthenticated', 'Authentication required.');
      }
      const user = db.users.find((candidate) => candidate.user_id === session.user_id);
      if (!user || user.disabled) {
        throw new AuthError(401, 'unauthenticated', 'Authentication required.');
      }
      session.last_seen_at = nowIso();
      session.idle_expires_at = new Date(now + SESSION_IDLE_TTL_MS).toISOString();
      return { user, session };
    });
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      return;
    }
    await this.store.mutate((db) => {
      const session = db.sessions.find((candidate) => candidate.session_id === sessionId);
      if (session) {
        session.revoked_at = nowIso();
      }
    });
  }

  requireCsrf(session: SessionRow, header: string | string[] | undefined): void {
    const actual = Array.isArray(header) ? header[0] : header;
    if (!actual || actual !== session.csrf_token) {
      throw new AuthError(403, 'csrf_required', 'A valid CSRF token is required.');
    }
  }

  requireRecentAuth(session: SessionRow): void {
    if (Date.now() - Date.parse(session.recent_auth_at) > RECENT_AUTH_MS) {
      throw new AuthError(403, 'recent_auth_required', 'Recent authentication is required.');
    }
  }

  async createPairingToken(input: {
    userId: string;
    vaultId: string;
    deviceName: string;
    publicBaseUrl: string;
  }): Promise<{ token: string; expiresAt: string; pairingUrl: string }> {
    const token = newSecretToken('obts_pair');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const tokenHash = hashToken(token);
    await this.store.mutate((db) => {
      const vault = ownedVaultOrThrow(db, input.userId, input.vaultId);
      db.tokens.push({
        token_id: newId('tok'),
        kind: 'pairing',
        lookup_prefix: tokenHash.lookupPrefix,
        token_hash: tokenHash.hash,
        user_id: input.userId,
        vault_id: vault.vault_id,
        device_id: null,
        expires_at: expiresAt,
        consumed_at: null,
        failed_attempts: 0,
        revoked_at: null,
        metadata: {
          device_name: input.deviceName
        },
        created_at: nowIso()
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: input.userId,
        actor_device_id: null,
        vault_id: vault.vault_id,
        action: 'pairing_token_created',
        resource_class: 'pairing_token',
        resource_id: null,
        created_at: nowIso()
      });
    });
    return {
      token,
      expiresAt,
      pairingUrl: `${input.publicBaseUrl.replace(/\/+$/u, '')}/pair?token=${encodeURIComponent(token)}`
    };
  }

  async consumePairingToken(input: {
    pairingToken: string;
    deviceName: string;
  }): Promise<{ user: UserRow; vault: VaultRow; device: DeviceRow; deviceToken: string; isFirstDevice: boolean }> {
    const tokenHash = hashToken(input.pairingToken);
    const deviceToken = newSecretToken('obts_dev');
    const deviceTokenHash = hashToken(deviceToken);
    const result = await this.store.mutate<
      | { ok: true; user: UserRow; vault: VaultRow; device: DeviceRow; deviceToken: string; isFirstDevice: boolean }
      | { ok: false; error: AuthError }
    >((db) => {
      const token = db.tokens.find(
        (candidate) =>
          candidate.kind === 'pairing' &&
          candidate.lookup_prefix === tokenHash.lookupPrefix &&
          candidate.token_hash === tokenHash.hash
      );
      if (
        !token ||
        token.revoked_at ||
        token.consumed_at ||
        !token.expires_at ||
        Date.parse(token.expires_at) <= Date.now() ||
        token.failed_attempts >= 10
      ) {
        throw new AuthError(401, 'invalid_pairing_token', 'Pairing token is invalid or expired.');
      }
      const user = db.users.find((candidate) => candidate.user_id === token.user_id);
      const vault = db.vaults.find((candidate) => candidate.vault_id === token.vault_id);
      if (!user || user.disabled || !vault || vault.owner_user_id !== user.user_id) {
        throw new AuthError(401, 'invalid_pairing_token', 'Pairing token is invalid or expired.');
      }
      const tokenDeviceName = typeof token.metadata.device_name === 'string' ? token.metadata.device_name : null;
      if (tokenDeviceName !== null && input.deviceName !== tokenDeviceName) {
        token.failed_attempts += 1;
        return { ok: false, error: new AuthError(401, 'invalid_pairing_token', 'Pairing token is invalid or expired.') };
      }
      const isFirstDevice = db.devices.every(
        (candidate) => candidate.vault_id !== vault.vault_id || candidate.revoked_at !== null
      );
      const device: DeviceRow = {
        device_id: newId('dev'),
        vault_id: vault.vault_id,
        user_id: user.user_id,
        device_name: input.deviceName,
        device_ref: '',
        device_ref_head: null,
        status: 'paired',
        last_applied_main: null,
        last_seen_at: nowIso(),
        last_successful_sync_at: null,
        created_at: nowIso(),
        revoked_at: null
      };
      device.device_ref = `refs/obts/devices/${device.device_id}`;
      db.devices.push(device);
      token.consumed_at = nowIso();
      db.tokens.push({
        token_id: newId('tok'),
        kind: 'device',
        lookup_prefix: deviceTokenHash.lookupPrefix,
        token_hash: deviceTokenHash.hash,
        user_id: user.user_id,
        vault_id: vault.vault_id,
        device_id: device.device_id,
        expires_at: null,
        consumed_at: null,
        failed_attempts: 0,
        revoked_at: null,
        metadata: {
          device_name: input.deviceName
        },
        created_at: nowIso()
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: user.user_id,
        actor_device_id: device.device_id,
        vault_id: vault.vault_id,
        action: 'device_paired',
        resource_class: 'device',
        resource_id: device.device_id,
        created_at: nowIso()
      });
      return { ok: true, user, vault, device, deviceToken, isFirstDevice };
    });
    if (!result.ok) {
      throw result.error;
    }
    return {
      user: result.user,
      vault: result.vault,
      device: result.device,
      deviceToken: result.deviceToken,
      isFirstDevice: result.isFirstDevice
    };
  }

  async authenticateDevice(authorizationHeader: string | undefined, vaultId: string): Promise<AuthenticatedDevice> {
    return await this.authenticateDeviceToken(authorizationHeader, vaultId);
  }

  async authenticateDeviceAnyVault(authorizationHeader: string | undefined): Promise<AuthenticatedDevice> {
    return await this.authenticateDeviceToken(authorizationHeader, null);
  }

  private async authenticateDeviceToken(
    authorizationHeader: string | undefined,
    expectedVaultId: string | null
  ): Promise<AuthenticatedDevice> {
    const token = parseBearer(authorizationHeader);
    const tokenHash = hashToken(token);
    return await this.store.mutate((db) => {
      const row = db.tokens.find(
        (candidate) =>
          candidate.kind === 'device' &&
          candidate.lookup_prefix === tokenHash.lookupPrefix &&
          candidate.token_hash === tokenHash.hash
      );
      if (!row || row.revoked_at || !row.device_id || (expectedVaultId !== null && row.vault_id !== expectedVaultId)) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const user = db.users.find((candidate) => candidate.user_id === row.user_id);
      const vault = db.vaults.find((candidate) => candidate.vault_id === row.vault_id);
      const device = db.devices.find((candidate) => candidate.device_id === row.device_id);
      if (
        !user ||
        user.disabled ||
        !vault ||
        (expectedVaultId !== null && vault.vault_id !== expectedVaultId) ||
        vault.owner_user_id !== user.user_id ||
        !device ||
        device.revoked_at ||
        device.vault_id !== vault.vault_id ||
        device.user_id !== user.user_id
      ) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      device.last_seen_at = nowIso();
      return { user, vault, device, token: row };
    });
  }

  private requireAdmin(db: MetadataDb, actorUserId: string): UserRow {
    const actor = db.users.find((candidate) => candidate.user_id === actorUserId);
    if (!actor || actor.disabled || !actor.is_admin) {
      throw new AuthError(403, 'admin_required', 'Admin privileges are required.');
    }
    return actor;
  }
}

export function ownedVaultOrThrow(db: MetadataDb, userId: string, vaultId: string): VaultRow {
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId && candidate.owner_user_id === userId);
  if (!vault) {
    throw new AuthError(404, 'not_found', 'Resource not found.');
  }
  return vault;
}

export function hashToken(token: string): { lookupPrefix: string; hash: string } {
  const hash = createHash('sha256').update(token).digest('hex');
  return { lookupPrefix: hash.slice(0, 16), hash };
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const hash = await argonHash(password, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: ARGON2ID_MEMORY_COST,
    timeCost: ARGON2ID_TIME_COST,
    parallelism: ARGON2ID_PARALLELISM
  });
  return {
    algorithm: 'argon2id',
    hash,
    memory_cost: ARGON2ID_MEMORY_COST,
    time_cost: ARGON2ID_TIME_COST,
    parallelism: ARGON2ID_PARALLELISM
  };
}

function requireUser(db: MetadataDb, userId: string): UserRow {
  const user = db.users.find((candidate) => candidate.user_id === userId);
  if (!user) {
    throw new AuthError(404, 'not_found', 'Resource not found.');
  }
  return user;
}

function enabledAdminCount(db: MetadataDb, exceptUserId: string | null): number {
  return db.users.filter((user) => user.is_admin && !user.disabled && user.user_id !== exceptUserId).length;
}

function revokeUserAuth(db: MetadataDb, userId: string): void {
  const timestamp = nowIso();
  for (const session of db.sessions) {
    if (session.user_id === userId && !session.revoked_at) {
      session.revoked_at = timestamp;
    }
  }
  for (const token of db.tokens) {
    if (token.user_id === userId && !token.revoked_at) {
      token.revoked_at = timestamp;
    }
  }
  for (const device of db.devices) {
    if (device.user_id === userId && device.status !== 'revoked') {
      device.status = 'revoked';
      device.revoked_at = timestamp;
    }
  }
}

function enforceLoginBackoff(db: MetadataDb, username: string, sourceIp: string): void {
  const attempt = db.login_attempts.find(
    (candidate) => candidate.username === username && candidate.source_ip === sourceIp
  );
  if (!attempt?.locked_until) {
    return;
  }
  if (Date.parse(attempt.locked_until) > Date.now()) {
    throw new AuthError(429, 'auth_rate_limited', 'Too many failed login attempts; try again later.');
  }
}

function recordFailedLogin(db: MetadataDb, username: string, sourceIp: string, userId: string | null): void {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  let attempt = db.login_attempts.find(
    (candidate) => candidate.username === username && candidate.source_ip === sourceIp
  );
  if (!attempt || now - Date.parse(attempt.window_started_at) > LOGIN_FAILURE_WINDOW_MS) {
    attempt = {
      username,
      source_ip: sourceIp,
      failed_count: 0,
      window_started_at: timestamp,
      last_failed_at: timestamp,
      locked_until: null,
      updated_at: timestamp
    };
    db.login_attempts = db.login_attempts.filter(
      (candidate) => candidate.username !== username || candidate.source_ip !== sourceIp
    );
    db.login_attempts.push(attempt);
  }
  attempt.failed_count += 1;
  attempt.last_failed_at = timestamp;
  attempt.updated_at = timestamp;
  if (attempt.failed_count >= LOGIN_FAILURE_LIMIT) {
    const backoffPower = Math.max(0, attempt.failed_count - LOGIN_FAILURE_LIMIT);
    const backoffMs = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** backoffPower, LOGIN_BACKOFF_MAX_MS);
    attempt.locked_until = new Date(now + backoffMs).toISOString();
  }
  db.audit_log.push({
    audit_id: newId('aud'),
    actor_user_id: userId,
    actor_device_id: null,
    vault_id: null,
    action: 'login_failed',
    resource_class: 'session',
    resource_id: null,
    created_at: timestamp
  });
}

function clearLoginFailures(db: MetadataDb, username: string, sourceIp: string): void {
  db.login_attempts = db.login_attempts.filter(
    (candidate) => candidate.username !== username || candidate.source_ip !== sourceIp
  );
}

function userSummary(db: MetadataDb, user: UserRow): AdminUserSummary {
  return {
    user_id: user.user_id,
    username: user.username,
    display_name: user.display_name,
    is_admin: user.is_admin,
    disabled: user.disabled,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    owned_vault_count: db.vaults.filter((vault) => vault.owner_user_id === user.user_id).length
  };
}

async function verifyPassword(password: string, stored: PasswordHash | LegacyPasswordHash): Promise<boolean> {
  if (stored.algorithm === 'argon2id') {
    return await argonVerify(stored.hash, password);
  }
  const derived = (await scrypt(password, stored.salt, 64)) as Buffer;
  const expected = Buffer.from(stored.hash, 'base64url');
  return expected.byteLength === derived.byteLength && timingSafeEqual(expected, derived);
}

function createSession(userId: string): SessionRow {
  const now = Date.now();
  return {
    session_id: newSecretToken('sess'),
    user_id: userId,
    csrf_token: newSecretToken('csrf'),
    created_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    idle_expires_at: new Date(now + SESSION_IDLE_TTL_MS).toISOString(),
    recent_auth_at: new Date(now).toISOString(),
    revoked_at: null
  };
}

function parseBearer(header: string | undefined): string {
  if (!header) {
    throw new AuthError(401, 'unauthenticated', 'Device token is required.');
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AuthError(401, 'unauthenticated', 'Device token is required.');
  }
  return token;
}
