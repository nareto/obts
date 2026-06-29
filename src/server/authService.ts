import { timingSafeEqual, randomBytes, scrypt as scryptCallback, createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { newId, newSecretToken, nowIso } from '../shared/ids.js';
import type { SyncProfile } from '../shared/types.js';
import type { DeviceRow, MetadataDb, MetadataStore, SessionRow, TokenRow, UserRow, VaultRow } from './metadataStore.js';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_AUTH_MS = 15 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

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
  }): Promise<{ user: UserRow; csrfToken: string; sessionId: string; recentAuthExpiresAt: string }> {
    return await this.store.mutate(async (db) => {
      const user = db.users.find((candidate) => candidate.username === input.username);
      if (!user || user.disabled || !(await verifyPassword(input.password, user.password_hash))) {
        throw new AuthError(401, 'invalid_credentials', 'Invalid username or password.');
      }
      const timestamp = nowIso();
      user.last_login_at = timestamp;
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
    syncProfile: SyncProfile;
    syncPlugins: boolean;
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
          device_name: input.deviceName,
          sync_profile: input.syncProfile,
          sync_plugins: input.syncPlugins
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
    syncProfile: SyncProfile;
    syncPlugins: boolean;
  }): Promise<{ user: UserRow; vault: VaultRow; device: DeviceRow; deviceToken: string }> {
    const tokenHash = hashToken(input.pairingToken);
    const deviceToken = newSecretToken('obts_dev');
    const deviceTokenHash = hashToken(deviceToken);
    return await this.store.mutate((db) => {
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
      const tokenSyncProfile = readTokenSyncProfile(token);
      const tokenSyncPlugins = token.metadata.sync_plugins === true;
      if (input.syncProfile !== tokenSyncProfile || input.syncPlugins !== tokenSyncPlugins) {
        token.failed_attempts += 1;
        throw new AuthError(401, 'invalid_pairing_token', 'Pairing token is invalid or expired.');
      }
      const device: DeviceRow = {
        device_id: newId('dev'),
        vault_id: vault.vault_id,
        user_id: user.user_id,
        device_name: input.deviceName,
        sync_profile: tokenSyncProfile,
        sync_plugins: tokenSyncPlugins,
        device_ref: '',
        device_ref_head: null,
        status: 'paired',
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
          device_name: input.deviceName,
          sync_profile: tokenSyncProfile,
          sync_plugins: tokenSyncPlugins
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
      return { user, vault, device, deviceToken };
    });
  }

  async authenticateDevice(authorizationHeader: string | undefined, vaultId: string): Promise<AuthenticatedDevice> {
    const token = parseBearer(authorizationHeader);
    const tokenHash = hashToken(token);
    return await this.store.mutate((db) => {
      const row = db.tokens.find(
        (candidate) =>
          candidate.kind === 'device' &&
          candidate.lookup_prefix === tokenHash.lookupPrefix &&
          candidate.token_hash === tokenHash.hash
      );
      if (!row || row.revoked_at || !row.device_id || row.vault_id !== vaultId) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const user = db.users.find((candidate) => candidate.user_id === row.user_id);
      const vault = db.vaults.find((candidate) => candidate.vault_id === row.vault_id);
      const device = db.devices.find((candidate) => candidate.device_id === row.device_id);
      if (
        !user ||
        user.disabled ||
        !vault ||
        vault.vault_id !== vaultId ||
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

async function hashPassword(password: string): Promise<{ algorithm: 'scrypt'; salt: string; hash: string }> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return {
    algorithm: 'scrypt',
    salt,
    hash: derived.toString('base64url')
  };
}

async function verifyPassword(password: string, stored: { algorithm: 'scrypt'; salt: string; hash: string }): Promise<boolean> {
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

function readTokenSyncProfile(token: TokenRow): SyncProfile {
  const value = token.metadata.sync_profile;
  if (value === 'notes_only' || value === 'notes_plus_attachments' || value === 'full_vault_config') {
    return value;
  }
  throw new AuthError(401, 'invalid_pairing_token', 'Pairing token is invalid or expired.');
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
