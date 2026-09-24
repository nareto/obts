import { createHmac, randomBytes } from 'node:crypto';

import { newId, newSecretToken, nowIso } from '../shared/ids.js';
import type {
  CompleteConnectionRequest,
  CompleteConnectionResponse,
  ConnectionStatusResponse,
  CreateConnectionRequest,
  CreateConnectionResponse
} from '../shared/types.js';
import { AuthError, hashToken, ownedVaultOrThrow } from './authService.js';
import type { GitService } from './gitService.js';
import { hasDurableDeletionRecord, type ConnectionRequestRow, type MetadataStore, type UserRow } from './metadataStore.js';
import type { VaultLifecycleCoordinator } from './vaultLifecycleCoordinator.js';

const PENDING_CONNECTION_TTL_MS = 10 * 60 * 1000;
const APPROVED_CONNECTION_TTL_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const CREATION_WINDOW_MS = 60_000;
const MAX_CREATIONS_PER_WINDOW = 100;
const POLL_WINDOW_MS = 1_000;
const MAX_POLLS_PER_WINDOW = 10;
const MAX_RATE_LIMIT_KEYS = 10_000;

export class ConnectionService {
  private readonly creationLimits = new Map<string, number[]>();
  private readonly pollLimits = new Map<string, number[]>();

  constructor(
    private readonly store: MetadataStore,
    private readonly git: GitService,
    private readonly publicBaseUrl: string,
    private readonly lifecycle?: VaultLifecycleCoordinator
  ) {}

  async create(input: CreateConnectionRequest, origin = 'unknown'): Promise<CreateConnectionResponse> {
    this.enforceCreationLimit(origin);
    const secret = newSecretToken('obts_conn');
    const secretHash = hashToken(secret);
    const connectionId = newId('con');
    const credentialSalt = randomBytes(32).toString('base64url');
    const verificationCode = verificationCodeFromId(connectionId);
    const expiresAt = new Date(Date.now() + PENDING_CONNECTION_TTL_MS).toISOString();
    await this.store.mutate((db) => {
      expireConnections(db.connections);
      db.connections.push({
        connection_id: connectionId,
        secret_lookup_prefix: secretHash.lookupPrefix,
        secret_hash: secretHash.hash,
        credential_salt: credentialSalt,
        verification_code: verificationCode,
        status: 'pending',
        plugin_version: input.plugin_version,
        proposed_device_name: input.device_name,
        local_vault_name: input.local_vault_name,
        local_summary: input.local_summary,
        approved_user_id: null,
        selection: null,
        selected_vault_id: null,
        new_vault_display_name: null,
        expected_main: null,
        created_device_id: null,
        created_at: nowIso(),
        approved_at: null,
        consumed_at: null,
        expires_at: expiresAt
      });
    });
    return {
      connection_id: connectionId,
      connection_secret: secret,
      authorization_url: `${this.publicBaseUrl.replace(/\/+$/u, '')}/connect/${connectionId}`,
      verification_code: verificationCode,
      credential_salt: credentialSalt,
      expires_at: expiresAt,
      poll_interval_ms: POLL_INTERVAL_MS
    };
  }

  async status(connectionId: string, secret: string, origin = 'unknown'): Promise<ConnectionStatusResponse> {
    if (this.lifecycle) {
      const db = await this.store.snapshot();
      const connection = authenticatedConnection(db.connections, connectionId, secret);
      const targetVaultId = connection.selected_vault_id ??
        (connection.created_device_id
          ? db.devices.find((device) => device.device_id === connection.created_device_id)?.vault_id ?? null
          : null);
      const ownerUserId = connection.approved_user_id ??
        (connection.created_device_id
          ? db.devices.find((device) => device.device_id === connection.created_device_id)?.user_id ?? null
          : null);
      if (targetVaultId && ownerUserId) {
        return await this.lifecycle.withOwnerVault(ownerUserId, targetVaultId, async () => {
          const before = await this.store.snapshot();
          const beforeConnection = authenticatedConnection(before.connections, connectionId, secret);
          if (connectionTargetVaultId(before, beforeConnection) !== targetVaultId) {
            throw new AuthError(409, 'connection_changed', 'Connection state changed while it was being read.');
          }
          const result = await this.statusInternal(connectionId, secret, origin);
          const after = await this.store.snapshot();
          const afterConnection = after.connections.find((candidate) => candidate.connection_id === connectionId);
          if (
            !afterConnection || connectionTargetVaultId(after, afterConnection) !== targetVaultId ||
            hasDurableDeletionRecord(after, targetVaultId)
          ) {
            throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
          }
          return result;
        });
      }
    }
    return await this.statusInternal(connectionId, secret, origin);
  }

  private async statusInternal(connectionId: string, secret: string, origin: string): Promise<ConnectionStatusResponse> {
    return await this.store.mutate((db) => {
      expireConnections(db.connections);
      const connection = authenticatedConnection(db.connections, connectionId, secret);
      this.enforcePollLimit(`${origin}:${connectionId}`);
      if (connection.status === 'pending') {
        return { status: 'pending', expires_at: connection.expires_at };
      }
      if (connection.status === 'denied' || connection.status === 'expired') {
        return { status: connection.status };
      }
      if (connection.status === 'consumed') {
        const device = db.devices.find((candidate) => candidate.device_id === connection.created_device_id);
        const vault = device ? db.vaults.find((candidate) => candidate.vault_id === device.vault_id) : null;
        if (!device || !vault) {
          throw new AuthError(409, 'connection_inconsistent', 'Connection state is incomplete.');
        }
        return {
          status: 'consumed',
          vault_id: vault.vault_id,
          vault_name: vault.display_name,
          device_id: device.device_id
        };
      }
      return {
        status: 'approved',
        selection: requireValue(connection.selection),
        vault_id: connection.selected_vault_id,
        vault_name: connection.new_vault_display_name ?? selectedVaultName(db.vaults, connection),
        expected_main: connection.expected_main,
        expires_at: connection.expires_at
      };
    });
  }

  async review(connectionId: string): Promise<ConnectionRequestRow> {
    return await this.store.mutate((db) => {
      expireConnections(db.connections);
      const connection = db.connections.find((candidate) => candidate.connection_id === connectionId);
      if (!connection || connection.status === 'expired') {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      return structuredClone(connection);
    });
  }

  async approve(input: {
    connectionId: string;
    user: UserRow;
    selection: 'new_vault' | 'existing_vault';
    vaultId?: string;
    displayName?: string;
  }): Promise<void> {
    const mutate = async (): Promise<void> => await this.store.mutate((db) => {
      expireConnections(db.connections);
      const connection = db.connections.find((candidate) => candidate.connection_id === input.connectionId);
      if (!connection || connection.status !== 'pending') {
        throw new AuthError(409, 'connection_not_pending', 'Connection is no longer awaiting approval.');
      }
      if (input.selection === 'existing_vault') {
        const vault = ownedVaultOrThrow(db, input.user.user_id, input.vaultId ?? '');
        if (vault.status !== 'active') {
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        connection.selected_vault_id = vault.vault_id;
        connection.expected_main = vault.current_main;
        connection.new_vault_display_name = null;
      } else {
        const displayName = input.displayName?.trim();
        if (!displayName) {
          throw new AuthError(400, 'invalid_display_name', 'Vault name is required.');
        }
        connection.selected_vault_id = null;
        connection.expected_main = null;
        connection.new_vault_display_name = displayName;
      }
      const approvedAt = nowIso();
      connection.status = 'approved';
      connection.approved_user_id = input.user.user_id;
      connection.selection = input.selection;
      connection.approved_at = approvedAt;
      connection.expires_at = new Date(Date.parse(approvedAt) + APPROVED_CONNECTION_TTL_MS).toISOString();
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: input.user.user_id,
        actor_device_id: null,
        vault_id: connection.selected_vault_id,
        action: 'connection_approved',
        resource_class: 'connection',
        resource_id: connection.connection_id,
        created_at: nowIso()
      });
    });
    if (input.selection === 'existing_vault' && input.vaultId && this.lifecycle) {
      await this.lifecycle.withOwnerVault(input.user.user_id, input.vaultId, async () => {
        await mutate();
        const after = await this.store.snapshot();
        if (hasDurableDeletionRecord(after, input.vaultId!)) {
          throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
        }
      });
    } else {
      await mutate();
    }
  }

  async deny(connectionId: string, user: UserRow): Promise<void> {
    await this.store.mutate((db) => {
      const connection = db.connections.find((candidate) => candidate.connection_id === connectionId);
      if (!connection || connection.status !== 'pending') {
        throw new AuthError(409, 'connection_not_pending', 'Connection is no longer awaiting approval.');
      }
      connection.status = 'denied';
      connection.approved_user_id = user.user_id;
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: user.user_id,
        actor_device_id: null,
        vault_id: null,
        action: 'connection_denied',
        resource_class: 'connection',
        resource_id: connection.connection_id,
        created_at: nowIso()
      });
    });
  }

  async bootstrapMetadata(connectionId: string, secret: string): Promise<{
    connection: ConnectionRequestRow;
    vaultId: string;
    vaultName: string;
    rootCommit: string;
    targetMain: string;
    changedPaths: string[];
    explicitDirectories: string[];
  }> {
    const { db, connection } = await this.store.mutate((mutableDb) => {
      expireConnections(mutableDb.connections);
      const authenticated = authenticatedConnection(mutableDb.connections, connectionId, secret);
      return { db: structuredClone(mutableDb), connection: structuredClone(authenticated) };
    });
    if (connection.status !== 'approved' || connection.selection !== 'existing_vault' || !connection.selected_vault_id) {
      throw new AuthError(409, 'connection_not_bootstrappable', 'Connection does not target an existing vault.');
    }
    const vault = ownedVaultOrThrow(db, requireValue(connection.approved_user_id), connection.selected_vault_id);
    if (vault.status !== 'active' || !vault.root_commit) {
      throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
    const targetMain = requireValue(connection.expected_main);
    const buildMetadata = async () => {
      if (
        !(await this.git.commitExists(vault.vault_id, targetMain)) ||
        !(await this.git.isAncestor(vault.vault_id, targetMain, vault.current_main))
      ) {
        throw new AuthError(409, 'blocked_integrity', 'Approved onboarding baseline is unavailable.');
      }
      return {
        connection,
        vaultId: vault.vault_id,
        vaultName: vault.display_name,
        rootCommit: vault.root_commit!,
        targetMain,
        changedPaths: await this.git.listTreePaths(vault.vault_id, targetMain),
        explicitDirectories: db.directory_state_by_vault[vault.vault_id]?.explicit_dirs ?? []
      };
    };
    return this.lifecycle
      ? await this.lifecycle.withOwnerVault(requireValue(connection.approved_user_id), vault.vault_id, buildMetadata)
      : await buildMetadata();
  }

  async bootstrap(connectionId: string, secret: string): Promise<{
    connection: ConnectionRequestRow;
    vaultId: string;
    vaultName: string;
    rootCommit: string;
    targetMain: string;
    changedPaths: string[];
    explicitDirectories: string[];
    packfile: Buffer;
  }> {
    const metadata = await this.bootstrapMetadata(connectionId, secret);
    const packfile = this.lifecycle
      ? await this.lifecycle.withOwnerVault(
          requireValue(metadata.connection.approved_user_id),
          metadata.vaultId,
          async () => await this.git.exportPack(metadata.vaultId, metadata.targetMain, null)
        )
      : await this.git.exportPack(metadata.vaultId, metadata.targetMain, null);
    return { ...metadata, packfile };
  }

  async complete(
    connectionId: string,
    secret: string,
    request: CompleteConnectionRequest
  ): Promise<CompleteConnectionResponse> {
    if (this.lifecycle) {
      const db = await this.store.snapshot();
      const connection = authenticatedConnection(db.connections, connectionId, secret);
      const targetVaultId = connectionTargetVaultId(db, connection);
      if (targetVaultId && connection.approved_user_id) {
        return await this.lifecycle.withOwnerVault(connection.approved_user_id, targetVaultId, async () => {
          const before = await this.store.snapshot();
          const beforeConnection = authenticatedConnection(before.connections, connectionId, secret);
          if (
            connectionTargetVaultId(before, beforeConnection) !== targetVaultId ||
            beforeConnection.approved_user_id !== connection.approved_user_id
          ) {
            throw new AuthError(409, 'connection_changed', 'Connection state changed while it was being completed.');
          }
          const result = await this.completeInternal(connectionId, secret, request);
          const after = await this.store.snapshot();
          const afterConnection = after.connections.find((candidate) => candidate.connection_id === connectionId);
          if (
            !afterConnection || connectionTargetVaultId(after, afterConnection) !== targetVaultId ||
            hasDurableDeletionRecord(after, targetVaultId)
          ) {
            throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
          }
          return result;
        });
      }
    }
    return await this.completeInternal(connectionId, secret, request);
  }

  private async completeInternal(
    connectionId: string,
    secret: string,
    request: CompleteConnectionRequest
  ): Promise<CompleteConnectionResponse> {
    const deviceToken = deriveDeviceToken(secret, await this.connectionSalt(connectionId, secret));
    const existing = await this.existingCompletion(connectionId, secret, deviceToken);
    if (existing) {
      const current = await this.store.snapshot();
      const vault = current.vaults.find((candidate) => candidate.vault_id === existing.vault_id);
      if (!vault) throw new AuthError(404, 'not_found', 'Resource not found.');
      const policy = await this.git.readRootIgnoreBlob(existing.vault_id, vault.current_main);
      if (policy.oid !== null && request.root_ignore_capability !== 'root-ignore-v1') {
        throw new AuthError(409, 'root_ignore_capability_required', 'Update to a capable device before joining this vault.');
      }
      return existing;
    }

    const snapshot = await this.store.snapshot();
    const connection = authenticatedConnection(snapshot.connections, connectionId, secret);
    if (connection.status === 'expired') {
      await this.store.mutate((db) => {
        authenticatedConnection(db.connections, connectionId, secret);
      });
    }
    if (connection.status !== 'approved' || !connection.approved_user_id || !connection.selection) {
      throw connectionStatusError(connection);
    }

    let vaultId = connection.selected_vault_id;
    let rootCommit: string;
    let targetAdmission: { release(): void } | null = null;
    try {
      if (connection.selection === 'new_vault') {
        if (request.mode !== 'initialize' && request.mode !== 'use_server') {
          throw new AuthError(400, 'invalid_onboarding_mode', 'New vault onboarding mode is invalid.');
        }
        const materializedVaultId = newId('vlt');
        vaultId = materializedVaultId;
        if (this.lifecycle) targetAdmission = await this.lifecycle.acquireAdmission(materializedVaultId);
        rootCommit = await this.git.initializeVault(materializedVaultId);
      } else {
        const vault = ownedVaultOrThrow(snapshot, connection.approved_user_id, vaultId ?? '');
        if (vault.status !== 'active') {
          throw new AuthError(409, vault.status === 'deleting' ? 'vault_deleting' : 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        if (!vault.root_commit) {
          throw new AuthError(409, 'blocked_integrity', 'Vault root commit is unavailable.');
        }
        if (request.expected_main !== connection.expected_main) {
          throw new AuthError(409, 'onboarding_target_stale', 'Approved onboarding baseline no longer matches this setup attempt.');
        }
        rootCommit = vault.root_commit;
        const rootIgnore = await this.git.readRootIgnoreBlob(vault.vault_id, vault.current_main);
        if (rootIgnore.oid !== null && request.root_ignore_capability !== 'root-ignore-v1') {
          throw new AuthError(409, 'root_ignore_capability_required', 'Update to a capable device before joining this vault.');
        }
      }

      if (!vaultId) {
        throw new AuthError(409, 'connection_inconsistent', 'Connection target is incomplete.');
      }
      const targetVaultId = vaultId;
      const proposal = await this.validateProposal(snapshot, connection, targetVaultId, rootCommit, request);
    const tokenHash = hashToken(deviceToken);
    const timestamp = nowIso();
    const deviceId = newId('dev');
    const result = await this.store.mutate((db) => {
      const mutableConnection = authenticatedConnection(db.connections, connectionId, secret);
      if (mutableConnection.status !== 'approved') {
        throw connectionStatusError(mutableConnection);
      }
      if (hasDurableDeletionRecord(db, targetVaultId)) {
        throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
      }
      let vault = db.vaults.find((candidate) => candidate.vault_id === targetVaultId);
      if (vault && (vault.owner_user_id !== mutableConnection.approved_user_id || vault.status !== 'active')) {
        throw new AuthError(409, vault.status === 'deleting' ? 'vault_deleting' : 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      }
      if (!vault) {
        vault = {
          vault_id: targetVaultId,
          owner_user_id: requireValue(mutableConnection.approved_user_id),
          display_name: requireValue(mutableConnection.new_vault_display_name),
          status: 'active',
          root_commit: rootCommit,
          current_main: rootCommit,
          created_at: timestamp,
          updated_at: timestamp
        };
        db.vaults.push(vault);
        this.store.appendEvent(db, {
          event_type: 'main_advanced',
          vault_id: vault.vault_id,
          resource_ids: { vault_id: vault.vault_id },
          commit_cursors: { main: rootCommit, previous_main: null },
          payload: { reason: 'empty_root' }
        });
      }
      const device = {
        device_id: deviceId,
        vault_id: vault.vault_id,
        user_id: vault.owner_user_id,
        device_name: mutableConnection.proposed_device_name,
        device_ref: `refs/obts/devices/${deviceId}`,
        device_ref_head: null,
        status: 'paired' as const,
        last_applied_main: null,
        last_applied_event_seq: 0,
        last_applied_explicit_dirs: [],
        pending_applied_main: null,
        pending_applied_event_seq: 0,
        pending_applied_explicit_dirs: null,
        last_seen_at: timestamp,
        last_successful_sync_at: null,
        local_status_label: null,
        local_error_code: null,
        local_queue_status: null,
        local_main: null,
        local_head: null,
        plugin_version: mutableConnection.plugin_version,
        path_capabilities: null,
        last_status_report_at: null,
        onboarding_status: 'pending' as const,
        onboarding_mode: request.mode,
        initial_proposal_kind: proposal.kind,
        initial_proposal_base: proposal.base,
        onboarding_connection_id: mutableConnection.connection_id,
        onboarding_completed_at: null,
        created_at: timestamp,
        revoked_at: null
      };
      db.devices.push(device);
      const tokenId = newId('tok');
      db.tokens.push({
        token_id: tokenId,
        kind: 'device',
        lookup_prefix: tokenHash.lookupPrefix,
        token_hash: tokenHash.hash,
        user_id: vault.owner_user_id,
        vault_id: vault.vault_id,
        device_id: device.device_id,
        expires_at: null,
        consumed_at: null,
        failed_attempts: 0,
        revoked_at: null,
        metadata: { device_name: device.device_name },
        created_at: timestamp
      });
      mutableConnection.status = 'consumed';
      mutableConnection.selected_vault_id = vault.vault_id;
      mutableConnection.created_device_id = device.device_id;
      mutableConnection.consumed_at = timestamp;
      for (const diagnostic of db.diagnostic_events) {
        if (diagnostic.connection_id === mutableConnection.connection_id) {
          diagnostic.vault_id = vault.vault_id;
          diagnostic.device_id = device.device_id;
        }
      }
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: vault.owner_user_id,
        actor_device_id: device.device_id,
        vault_id: vault.vault_id,
        action: 'connection_completed',
        resource_class: 'device',
        resource_id: device.device_id,
        created_at: timestamp
      });
      if (!vault) throw new AuthError(409, 'connection_inconsistent', 'Connection target is incomplete.');
      return { vault, device, tokenId };
    });
    const authoritative = await this.store.snapshot();
    const authoritativeVault = authoritative.vaults.find((candidate) => candidate.vault_id === targetVaultId);
    const authoritativeDevice = authoritative.devices.find((candidate) => candidate.device_id === result.device.device_id);
    const authoritativeToken = authoritative.tokens.find((candidate) => candidate.token_id === result.tokenId);
    if (
      hasDurableDeletionRecord(authoritative, targetVaultId) ||
      !authoritativeVault || authoritativeVault.status !== 'active' || authoritativeVault.owner_user_id !== connection.approved_user_id ||
      !authoritativeDevice || authoritativeDevice.vault_id !== targetVaultId || authoritativeDevice.user_id !== connection.approved_user_id ||
      authoritativeDevice.revoked_at !== null || authoritativeDevice.status === 'revoked' ||
      !authoritativeToken || authoritativeToken.kind !== 'device' || authoritativeToken.vault_id !== targetVaultId ||
      authoritativeToken.device_id !== authoritativeDevice.device_id || authoritativeToken.user_id !== connection.approved_user_id ||
      authoritativeToken.revoked_at !== null || authoritativeToken.consumed_at !== null
    ) {
      throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
    }
    return responseFor(authoritativeVault, authoritativeDevice, deviceToken, request.mode);
    } finally {
      targetAdmission?.release();
    }
  }

  async authenticateDiagnostics(connectionId: string, secret: string): Promise<{
    connection: ConnectionRequestRow;
    user: UserRow;
  }> {
    return await this.store.mutate((db) => {
      const connection = authenticatedConnection(db.connections, connectionId, secret);
      if (connection.status !== 'approved' || !connection.approved_user_id) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const user = db.users.find((candidate) => candidate.user_id === connection.approved_user_id);
      if (!user || user.disabled) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      return { connection: structuredClone(connection), user: structuredClone(user) };
    });
  }

  private async connectionSalt(connectionId: string, secret: string): Promise<string> {
    const db = await this.store.snapshot();
    return authenticatedConnection(db.connections, connectionId, secret).credential_salt;
  }

  private async existingCompletion(
    connectionId: string,
    secret: string,
    deviceToken: string
  ): Promise<CompleteConnectionResponse | null> {
    const db = await this.store.snapshot();
    const connection = authenticatedConnection(db.connections, connectionId, secret);
    if (connection.status !== 'consumed') {
      return null;
    }
    const device = db.devices.find((candidate) => candidate.device_id === connection.created_device_id);
    const vault = device ? db.vaults.find((candidate) => candidate.vault_id === device.vault_id) : null;
    if (!device || !vault || !device.onboarding_mode || !vault.root_commit) {
      throw new AuthError(409, 'connection_inconsistent', 'Connection state is incomplete.');
    }
    if (vault.status !== 'active' || hasDurableDeletionRecord(db, vault.vault_id)) {
      throw new AuthError(409, vault.status === 'deleting' ? 'vault_deleting' : 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
    const token = db.tokens.find((candidate) =>
      candidate.kind === 'device' && candidate.device_id === device.device_id && candidate.vault_id === vault.vault_id &&
      candidate.user_id === device.user_id && candidate.revoked_at === null && candidate.consumed_at === null
    );
    if (!token || device.status === 'revoked' || device.revoked_at !== null || device.user_id !== vault.owner_user_id) {
      throw new AuthError(409, 'connection_inconsistent', 'Connection state is incomplete.');
    }
    return responseFor(vault, device, deviceToken, device.onboarding_mode);
  }

  private enforceCreationLimit(origin: string): void {
    const now = Date.now();
    const recent = (this.creationLimits.get(origin) ?? []).filter((timestamp) => now - timestamp < CREATION_WINDOW_MS);
    if (recent.length >= MAX_CREATIONS_PER_WINDOW) {
      throw new AuthError(429, 'connection_rate_limited', 'Too many connection requests. Try again later.');
    }
    recent.push(now);
    this.creationLimits.set(origin, recent);
    pruneOldestMapEntries(this.creationLimits, MAX_RATE_LIMIT_KEYS);
  }

  private enforcePollLimit(key: string): void {
    const now = Date.now();
    const recent = (this.pollLimits.get(key) ?? []).filter((timestamp) => now - timestamp < POLL_WINDOW_MS);
    if (recent.length >= MAX_POLLS_PER_WINDOW) {
      throw new AuthError(429, 'connection_rate_limited', 'Connection status is being polled too quickly.');
    }
    recent.push(now);
    this.pollLimits.set(key, recent);
    pruneOldestMapEntries(this.pollLimits, MAX_RATE_LIMIT_KEYS);
  }

  private async validateProposal(
    db: Awaited<ReturnType<MetadataStore['snapshot']>>,
    connection: ConnectionRequestRow,
    vaultId: string,
    rootCommit: string,
    request: CompleteConnectionRequest
  ): Promise<{
    kind: 'new_vault_import' | 'independent_vault_merge' | 'shared_baseline_merge' | null;
    base: string | null;
  }> {
    if (request.mode !== 'merge' && request.mode !== 'initialize') {
      return { kind: null, base: null };
    }
    const expectedKind = connection.selection === 'new_vault' ? 'new_vault_import' : request.proposal_kind;
    if (!expectedKind) {
      throw new AuthError(400, 'invalid_proposal_base', 'Onboarding proposal kind is required.');
    }
    if (expectedKind === 'new_vault_import') {
      return { kind: expectedKind, base: rootCommit };
    }
    if (!request.proposal_base) {
      throw new AuthError(400, 'invalid_proposal_base', 'Onboarding proposal base is required.');
    }
    if (expectedKind === 'independent_vault_merge') {
      if (request.proposal_base !== rootCommit) {
        throw new AuthError(400, 'invalid_proposal_base', 'Independent onboarding must use the vault root commit.');
      }
    } else {
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
      if (!vault || !(await this.git.commitExists(vaultId, request.proposal_base)) || !(await this.git.isAncestor(vaultId, request.proposal_base, vault.current_main))) {
        throw new AuthError(400, 'invalid_proposal_base', 'Shared onboarding baseline is not trusted vault history.');
      }
    }
    return { kind: expectedKind, base: request.proposal_base };
  }
}

function connectionTargetVaultId(
  db: Awaited<ReturnType<MetadataStore['snapshot']>>,
  connection: ConnectionRequestRow
): string | null {
  if (connection.selected_vault_id) return connection.selected_vault_id;
  if (!connection.created_device_id) return null;
  return db.devices.find((device) => device.device_id === connection.created_device_id)?.vault_id ?? null;
}

function authenticatedConnection(connections: ConnectionRequestRow[], connectionId: string, secret: string): ConnectionRequestRow {
  const tokenHash = hashToken(secret);
  const connection = connections.find(
    (candidate) =>
      candidate.connection_id === connectionId &&
      candidate.secret_lookup_prefix === tokenHash.lookupPrefix &&
      candidate.secret_hash === tokenHash.hash
  );
  if (!connection) {
    throw new AuthError(401, 'invalid_connection', 'Connection authorization is invalid or expired.');
  }
  if (connection.status !== 'consumed' && Date.parse(connection.expires_at) <= Date.now()) {
    connection.status = 'expired';
  }
  return connection;
}

function connectionStatusError(connection: ConnectionRequestRow): AuthError {
  if (connection.status === 'expired') {
    return new AuthError(409, 'connection_expired', 'Connection approval has expired.');
  }
  if (connection.status === 'denied') {
    return new AuthError(409, 'connection_denied', 'Connection was denied.');
  }
  return new AuthError(409, 'connection_not_approved', 'Connection has not been approved.');
}

function pruneOldestMapEntries<T>(entries: Map<string, T>, maximum: number): void {
  while (entries.size > maximum) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function expireConnections(connections: ConnectionRequestRow[]): void {
  for (const connection of connections) {
    if ((connection.status === 'pending' || connection.status === 'approved') && Date.parse(connection.expires_at) <= Date.now()) {
      connection.status = 'expired';
    }
  }
}

function deriveDeviceToken(secret: string, salt: string): string {
  const digest = createHmac('sha256', Buffer.from(salt, 'base64url'))
    .update('obts-device-token-v1\0')
    .update(secret)
    .digest('base64url');
  return `obts_dev_${digest}`;
}

function verificationCodeFromId(connectionId: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = createHmac('sha256', 'obts-verification-code').update(connectionId).digest();
  let value = '';
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[bytes[index]! % alphabet.length];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function selectedVaultName(vaults: Array<{ vault_id: string; display_name: string }>, connection: ConnectionRequestRow): string {
  const vault = vaults.find((candidate) => candidate.vault_id === connection.selected_vault_id);
  if (!vault) {
    throw new AuthError(409, 'connection_inconsistent', 'Selected vault is unavailable.');
  }
  return vault.display_name;
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new AuthError(409, 'connection_inconsistent', 'Connection state is incomplete.');
  }
  return value;
}

function responseFor(
  vault: { vault_id: string; display_name: string; root_commit?: string | null; current_main: string },
  device: { device_id: string; device_ref: string; user_id: string },
  deviceToken: string,
  mode: CompleteConnectionRequest['mode']
): CompleteConnectionResponse {
  if (!vault.root_commit) {
    throw new AuthError(409, 'connection_inconsistent', 'Vault root commit is unavailable.');
  }
  return {
    user_id: device.user_id,
    vault_id: vault.vault_id,
    vault_name: vault.display_name,
    root_commit: vault.root_commit,
    current_main: vault.current_main,
    device_id: device.device_id,
    device_token: deviceToken,
    device_ref: device.device_ref,
    mode
  };
}
