import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import { parseDevicePushManifest } from '../shared/validators.js';
import {
  ASYNC_PUSH_FINALIZE_CAPABILITY,
  CHUNK_TRANSFER_CAPABILITY,
  DIRECTORY_PROPOSAL_CAPABILITY,
  type ChunkPushCreateRequest,
  type ChunkPushDescriptor,
  type ChunkPushReceipt,
  type DevicePushManifest,
  type PushResult
} from '../shared/types.js';
import type { AuthenticatedDevice } from './authService.js';
import { AuthError } from './authService.js';
import type { ServerConfig } from './config.js';
import { GitCommandError, GitDurabilityError, GitService, sha256Hex } from './gitService.js';
import { SyncService } from './syncService.js';
import {
  assertDeletionRootUnchanged,
  closeDeletionRoot,
  openDeletionRoot,
  readDeletionRootEntries,
  removeDeletionRootDirectoryChild,
  syncDeletionRoot,
  type DeletionRoot
} from './deletionRoot.js';
import { fsyncDurableDirectory, fsyncDurableFile, writeDurableFile, type DurableFilePersistence } from './durableFile.js';
import type { VaultLifecycleCoordinator } from './vaultLifecycleCoordinator.js';

const SESSION_VERSION = 1;
const MAX_OPEN_TRANSFERS_PER_DEVICE = 2;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]{1,256}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PROCESSING_ATTEMPTS = 64;
const MAX_RESULT_CODE_LENGTH = 128;
const MAX_RESULT_MESSAGE_LENGTH = 2048;
const MAX_DEVICE_REF_LENGTH = 512;

// Persisted-transfer scan modes. Startup may adopt legacy ownership; request paths never write while
// scanning; the readiness verdict is strictly read-only.
const SCAN_STARTUP = 'startup';
const SCAN_OPERATIONAL = 'operational';
const SCAN_VERDICT = 'verdict';

export type PersistedDeviceResolver = (session: PushSession) => Promise<AuthenticatedDevice | null>;

type ChunkReceipt = { index: number; bytes: number; sha256: string };

type PushSession = {
  version: 1;
  transfer_id: string;
  vault_id: string;
  device_id: string;
  attempt_id: string;
  request_sha256: string;
  manifest: DevicePushManifest;
  plan_sha256: string;
  chunk_count: number;
  receipts: ChunkReceipt[];
  total_bytes: number;
  stored_bytes?: number;
  status: 'open' | 'processing' | 'completed' | 'rejected' | 'aborted';
  result: PushResult | null;
  processing_attempts?: number;
  processing_error_code?: 'server_git_error' | 'server_processing_error' | null;
  retry_at?: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export class ChunkTransferService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly processors = new Map<string, Promise<void>>();
  private readonly retryWaiters = new Set<() => void>();
  private storedBytes: number | null = null;
  private closed = false;
  private transferUnavailable = false;
  private transferAnomaly: string | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly git: GitService,
    private readonly sync: SyncService,
    private readonly lifecycle?: VaultLifecycleCoordinator,
    private readonly persistence: Partial<DurableFilePersistence> = {}
  ) {}

  isReady(): boolean {
    return !this.closed && !this.transferUnavailable && !this.isGitDurabilityUnavailable();
  }

  /**
   * Reports whether transfer storage can serve requests.
   *
   * A readiness or dashboard probe never writes to transfer storage and never lets a session-scoped
   * inconsistency disable serving: those are reported here as an anomaly verdict while transfers keep
   * working. Only transfer storage itself being unusable (missing or unsafe root, or a failed durable
   * write) makes the service not ready.
   */
  async checkReady(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isReady()) return { ok: false, error: 'transfer storage is unavailable' };
    try {
      const { problem } = await this.withStorageLock(async () => await this.scanSessions(SCAN_VERDICT));
      return problem === null ? { ok: true } : { ok: false, error: `transfer storage anomaly: ${problem}` };
    } catch {
      return { ok: false, error: 'transfer storage is unavailable' };
    }
  }

  transferAnomalyReason(): string | null {
    return this.transferAnomaly;
  }

  private suspendTransferStorage(): void {
    this.transferUnavailable = true;
  }

  /**
   * Records a survivable inconsistency in pre-existing transfer state. Only genuine write-path
   * durability failures suspend transfer storage globally; an unusable or legacy session affects
   * that transfer, not every vault on the server.
   */
  private recordTransferAnomaly(reason: string, detail?: string): void {
    const message = detail === undefined ? reason : `${reason}:${detail}`;
    if (this.transferAnomaly === message) return;
    this.transferAnomaly = message;
    process.stderr.write(`obts: transfer storage anomaly: ${message}\n`);
  }

  async initialize(resolvePersistedDevice?: PersistedDeviceResolver): Promise<void> {
    if (this.isGitDurabilityUnavailable()) {
      this.suspendTransferStorage();
      return;
    }
    let sessions: PushSession[];
    try {
      sessions = (await this.scanSessions(SCAN_STARTUP)).sessions;
    } catch {
      this.suspendTransferStorage();
      return;
    }
    for (const session of sessions) {
      if (session.status === 'processing') {
        // A processing session always has complete receipts here: the session parser rejects an
        // incomplete processing record as malformed, so it never reaches resumption.
        const auth = resolvePersistedDevice ? await resolvePersistedDevice(session) : null;
        const deletionBlocked = this.lifecycle?.isBlocked(session.vault_id) ?? false;
        if (
          auth && auth.vault.vault_id === session.vault_id && auth.vault.status === 'active' &&
          auth.device.device_id === session.device_id && auth.device.revoked_at === null && auth.device.status !== 'revoked' &&
          !auth.user.disabled
        ) {
          this.startProcessing(auth, session.transfer_id);
        } else if (!deletionBlocked) {
          // A processing session whose device no longer resolves cannot be resumed. That leaves one
          // unfinished transfer behind; it must not disable transfers for every other device.
          this.recordTransferAnomaly('transfer_processing_session_unresolved', session.transfer_id);
        }
        continue;
      }
      if (
        this.expired(session) || session.status !== 'rejected' ||
        session.result?.status !== 'rejected' || session.result.code !== 'git_error' ||
        this.lifecycle?.isBlocked(session.vault_id)
      ) continue;
      session.status = 'open';
      session.result = null;
      session.processing_attempts = 0;
      session.processing_error_code = 'server_git_error';
      session.retry_at = nowIso();
      session.updated_at = nowIso();
      await this.withStorageLock(async () => await this.writeSession(session, session.transfer_id));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const wake of [...this.retryWaiters]) wake();
    await Promise.allSettled([...this.processors.values()]);
  }

  async drainVault(vaultId: string): Promise<void> {
    const sessions = await this.listSessionsIncludingMalformed();
    for (const session of sessions) {
      if (session.value?.vault_id !== vaultId) continue;
      await this.withLock(session.transferId, async () => {
        const current = await this.readSession(session.transferId);
        if (!current || current.vault_id !== vaultId) return;
        if (current.status === 'processing' || current.status === 'open') {
          current.status = 'aborted';
          current.result = null;
          current.processing_error_code = null;
          current.retry_at = null;
          current.updated_at = nowIso();
          await this.withStorageLock(async () => await this.writeSession(current, session.transferId));
        }
      });
    }
    for (const wake of [...this.retryWaiters]) wake();
    await Promise.allSettled([...this.processors.entries()]
      .filter(([transferId]) => sessions.some((session) => session.transferId === transferId && session.value?.vault_id === vaultId))
      .map(([, processor]) => processor));
  }

  async inventoryVaultResidue(vaultId: string): Promise<{ attributable: string[]; unattributed: boolean }> {
    let root: DeletionRoot;
    try {
      root = await openDeletionRoot(this.config.transferDir);
    } catch (error) {
      if (isMissing(error)) {
        if (this.transferUnavailable) throw new TransferStorageError('Transfer storage is unavailable.');
        return { attributable: [], unattributed: false };
      }
      throw error;
    }
    try {
      const entries = await readDeletionRootEntries(root);
      const attributable: string[] = [];
      let unattributed = false;
      for (const entry of entries) {
        if (!entry.name.startsWith('trn_') || !/^trn_[A-Za-z0-9]+$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          unattributed = true;
          continue;
        }
        const transferId = entry.name;
        const inspection = await this.inspectSessionAt(root, transferId);
        const marker = await this.inspectOwnerMarkerAt(root, transferId);
        if (inspection.kind === 'valid' && marker.kind === 'valid' && marker.vaultId === inspection.value.vault_id) {
          if (inspection.value.vault_id === vaultId) attributable.push(this.sessionDir(transferId));
        } else if (inspection.kind === 'missing' && marker.kind === 'valid' && marker.vaultId === vaultId) {
          attributable.push(this.sessionDir(transferId));
        } else {
          unattributed = true;
        }
      }
      await assertDeletionRootUnchanged(root);
      return { attributable, unattributed };
    } finally {
      await closeDeletionRoot(root);
    }
  }

  async eraseVaultResidue(vaultId: string): Promise<{ unattributed: boolean }> {
    return await this.withStorageLock(async () => await this.eraseVaultResidueUnderStorage(vaultId));
  }

  private async eraseVaultResidueUnderStorage(vaultId: string): Promise<{ unattributed: boolean }> {
    let root: DeletionRoot;
    try {
      root = await openDeletionRoot(this.config.transferDir);
    } catch (error) {
      if (isMissing(error)) {
        this.storedBytes = null;
        if (this.transferUnavailable) throw new TransferStorageError('Transfer storage is unavailable.');
        return { unattributed: false };
      }
      throw error;
    }
    try {
      const entries = await readDeletionRootEntries(root);
      const targetNames: string[] = [];
      for (const entry of entries) {
        if (!entry.name.startsWith('trn_') || !/^trn_[A-Za-z0-9]+$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          return { unattributed: true };
        }
        const inspection = await this.inspectSessionAt(root, entry.name);
        const marker = await this.inspectOwnerMarkerAt(root, entry.name);
        if (inspection.kind === 'valid' && marker.kind === 'valid' && marker.vaultId === inspection.value.vault_id) {
          if (inspection.value.vault_id === vaultId) targetNames.push(entry.name);
        } else if (inspection.kind === 'missing' && marker.kind === 'valid' && marker.vaultId === vaultId) {
          targetNames.push(entry.name);
        } else {
          return { unattributed: true };
        }
      }
      await assertDeletionRootUnchanged(root);
      for (const name of targetNames) await removeDeletionRootDirectoryChild(root, name);
      if (targetNames.length > 0) {
        await syncDeletionRoot(root);
        this.storedBytes = null;
      }
      for (const entry of await readDeletionRootEntries(root)) {
        if (!entry.name.startsWith('trn_') || !/^trn_[A-Za-z0-9]+$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          return { unattributed: true };
        }
        const inspection = await this.inspectSessionAt(root, entry.name);
        const marker = await this.inspectOwnerMarkerAt(root, entry.name);
        if (inspection.kind === 'valid' && marker.kind === 'valid' && marker.vaultId === inspection.value.vault_id) {
          if (inspection.value.vault_id === vaultId) return { unattributed: true };
        } else if (inspection.kind === 'missing' && marker.kind === 'valid' && marker.vaultId === vaultId) {
          return { unattributed: true };
        } else if (inspection.kind !== 'valid' || marker.kind !== 'valid') {
          return { unattributed: true };
        }
      }
      await assertDeletionRootUnchanged(root);
      return { unattributed: false };
    } finally {
      await closeDeletionRoot(root);
    }
  }

  private async listSessionsIncludingMalformed(): Promise<Array<{ transferId: string; value: PushSession | null }>> {
    let root: DeletionRoot;
    try {
      root = await openDeletionRoot(this.config.transferDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    try {
      const entries = await readDeletionRootEntries(root);
      const sessions: Array<{ transferId: string; value: PushSession | null }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('trn_')) {
          sessions.push({ transferId: entry.name, value: null });
          continue;
        }
        sessions.push({ transferId: entry.name, value: await this.inspectSessionAt(root, entry.name).then((inspection) =>
          inspection.kind === 'valid' ? inspection.value : null) });
      }
      return sessions;
    } finally {
      await closeDeletionRoot(root);
    }
  }

  capabilities() {
    return {
      capabilities: [CHUNK_TRANSFER_CAPABILITY, ASYNC_PUSH_FINALIZE_CAPABILITY, DIRECTORY_PROPOSAL_CAPABILITY],
      max_chunk_bytes: this.config.transferChunkBytes,
      target_chunk_bytes: Math.max(1_048_576, Math.floor(this.config.transferChunkBytes * 0.85)),
      max_transfer_bytes: this.config.maxTransferBytes,
      max_transfer_chunks: this.config.maxTransferChunks
    };
  }

  async createPush(auth: AuthenticatedDevice, request: ChunkPushCreateRequest): Promise<{ descriptor: ChunkPushDescriptor; created: boolean }> {
    const operation = async () => await this.withLock('__create__', async () => {
    this.assertTransferAllowed(auth);
    if (request.vault_id !== auth.vault.vault_id || request.device_id !== auth.device.device_id) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    if (request.chunk_count > this.config.maxTransferChunks) {
      throw new AuthError(413, 'too_many_chunks', 'Transfer has too many chunks.');
    }
    await this.pruneExpired();
    const requestSha256 = sha256Hex(Buffer.from(JSON.stringify(request)));
    const sessions = await this.listSessions();
    const existing = sessions.find((session) =>
      session.vault_id === auth.vault.vault_id && session.device_id === auth.device.device_id && session.attempt_id === request.attempt_id
    );
    if (existing) {
      if (existing.request_sha256 !== requestSha256) throw new AuthError(409, 'attempt_mismatch', 'Transfer attempt does not match its original request.');
      return { descriptor: this.descriptor(existing), created: false };
    }
    const currentDeviceRef = await this.git.getRef(auth.vault.vault_id, auth.device.device_ref);
    const open: PushSession[] = [];
    for (const session of sessions) {
      if (
        session.device_id !== auth.device.device_id ||
        (session.status !== 'open' && session.status !== 'processing') ||
        this.expired(session)
      ) continue;
      const alreadyCovered = currentDeviceRef !== null &&
        await this.git.commitExists(auth.vault.vault_id, session.manifest.target_commit) &&
        await this.git.isAncestor(auth.vault.vault_id, session.manifest.target_commit, currentDeviceRef);
      if (!alreadyCovered) open.push(session);
    }
    if (open.length >= MAX_OPEN_TRANSFERS_PER_DEVICE) {
      throw new AuthError(429, 'too_many_transfers', 'Too many open transfers for this device.');
    }
    const transferId = newId('trn');
    const createdAt = nowIso();
    const session: PushSession = {
      version: SESSION_VERSION,
      transfer_id: transferId,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      attempt_id: request.attempt_id,
      request_sha256: requestSha256,
      manifest: {
        api_version: request.api_version,
        ...(request.plugin_version ? { plugin_version: request.plugin_version } : {}),
        vault_id: request.vault_id,
        device_id: request.device_id,
        expected_device_ref: request.expected_device_ref,
        target_commit: request.target_commit,
        packfile_sha256: sha256Hex(Buffer.alloc(0)),
        packfile_bytes: 0,
        client_known_main: request.client_known_main,
        ...(request.base_commit === undefined ? {} : { base_commit: request.base_commit }),
        ...(request.directory_intents === undefined ? {} : { directory_intents: request.directory_intents }),
        ...(request.directory_proposal === undefined ? {} : { directory_proposal: request.directory_proposal }),
        attempt_id: request.attempt_id
      },
      plan_sha256: request.plan_sha256,
      chunk_count: request.chunk_count,
      receipts: [],
      total_bytes: 0,
      stored_bytes: 0,
      status: 'open',
      result: null,
      processing_attempts: 0,
      processing_error_code: null,
      retry_at: null,
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString()
    };
    await this.withStorageLock(async () => {
      await mkdir(this.sessionDir(transferId), { recursive: true, mode: 0o700 });
      try {
        await fsyncDurableDirectory(this.config.transferDir, this.persistence);
      } catch (error) {
        this.suspendTransferStorage();
        throw error;
      }
      await this.writeOwnerMarker(transferId, auth.vault.vault_id);
      try {
        await this.git.initializeTransferRepo(auth.vault.vault_id, this.repoDir(transferId));
      } catch (error) {
        if (error instanceof GitDurabilityError) {
          this.suspendTransferStorage();
          throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
        }
        throw error;
      }
      session.stored_bytes = await this.directoryBytes(this.sessionDir(transferId), false, true);
      this.storedBytes = null;
      await this.writeSession(session, transferId);
    });
    return { descriptor: this.descriptor(session), created: true };
    });
    return this.lifecycle
      ? await this.lifecycle.withAdmission(auth.vault.vault_id, operation)
      : await operation();
  }

  async getPush(auth: AuthenticatedDevice, transferId: string): Promise<ChunkPushDescriptor> {
    const read = async () => await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      const current = await this.requireSession(auth, transferId);
      if (
        current.status === 'open' && current.processing_error_code &&
        current.receipts.length === current.chunk_count
      ) {
        current.status = 'processing';
        current.updated_at = nowIso();
        current.expires_at = new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString();
        await this.withStorageLock(async () => await this.writeSession(current, transferId));
      }
      return current;
    });
    const session = this.lifecycle
      ? await this.lifecycle.withAdmission(auth.vault.vault_id, read)
      : await read();
    if (session.status === 'processing') this.startProcessing(auth, transferId);
    return this.descriptor(session);
  }

  async putChunk(
    auth: AuthenticatedDevice,
    transferId: string,
    index: number,
    data: Buffer,
    digest: string
  ): Promise<ChunkPushReceipt> {
    const operation = async () => await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      const session = await this.requireSession(auth, transferId);
      if (session.status !== 'open') throw new AuthError(409, 'transfer_closed', 'Transfer is no longer open.');
      if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunk_count) {
        throw new AuthError(400, 'invalid_chunk_index', 'Invalid chunk index.');
      }
      if (data.byteLength === 0 || data.byteLength > this.config.transferChunkBytes) {
        throw new AuthError(413, 'chunk_too_large', 'Chunk exceeds the configured transfer limit.');
      }
      const actualDigest = sha256Hex(data);
      if (actualDigest !== digest) throw new AuthError(422, 'chunk_digest_mismatch', 'Chunk digest does not match.');
      const existing = session.receipts.find((receipt) => receipt.index === index);
      if (existing) {
        if (existing.sha256 !== digest || existing.bytes !== data.byteLength) {
          throw new AuthError(409, 'chunk_conflict', 'Chunk index was already uploaded with different content.');
        }
        return { transfer_id: transferId, chunk_index: index, chunk_sha256: digest, received_bytes: data.byteLength, idempotent: true };
      }
      if (session.total_bytes + data.byteLength > this.config.maxTransferBytes) {
        throw new AuthError(413, 'transfer_too_large', 'Transfer exceeds the configured aggregate limit.');
      }
      return await this.withStorageLock(async () => {
        const verification = await this.verifySessionAccounting(
          session,
          true,
          (reason, detail) => this.recordTransferAnomaly(reason, detail)
        );
        if (!verification.ok) throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
        const actualSessionBytes = verification.actual;
        await this.listSessions();
        this.storedBytes = await this.directoryBytes(this.config.transferDir, true, true);
        const previousSessionBytes = actualSessionBytes;
        if (this.storedBytes + data.byteLength > this.config.maxTransferStorageBytes) {
          throw new AuthError(507, 'transfer_storage_full', 'Transfer quarantine storage is full.');
        }
        const chunkDir = join(this.sessionDir(transferId), 'chunks');
        await mkdir(chunkDir, { recursive: true, mode: 0o700 });
        const destination = join(chunkDir, `${String(index).padStart(6, '0')}.pack`);
        const temporary = `${destination}.tmp-${randomBytes(6).toString('hex')}`;
        await writeFile(temporary, data, { mode: 0o600 });
        try {
          try {
            await fsyncDurableFile(temporary, this.persistence);
          } catch (error) {
            this.suspendTransferStorage();
            throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
          }
          const canonicalRepoPath = (this.git as unknown as { repoPath?: (vaultId: string) => string }).repoPath?.call(this.git, session.vault_id);
          await this.git.importPackIntoRepo(
            this.repoDir(transferId),
            data,
            canonicalRepoPath === undefined ? undefined : join(canonicalRepoPath, 'objects')
          );
          await rm(temporary, { force: true });
          const transferStoredBytes = await this.directoryBytes(this.sessionDir(transferId), false, true);
          const aggregateBytes = this.storedBytes - previousSessionBytes + transferStoredBytes;
          if (transferStoredBytes > this.config.maxTransferBytes || aggregateBytes > this.config.maxTransferStorageBytes) {
            await this.removeSessionDirectoryUnderStorage(transferId);
            this.storedBytes = null;
            throw new AuthError(413, 'transfer_too_large', 'Transfer expanded beyond its configured quarantine limit.');
          }
          session.stored_bytes = transferStoredBytes;
          this.storedBytes = aggregateBytes;
        } catch (error) {
          await rm(temporary, { force: true });
          if (error instanceof AuthError) throw error;
          if (error instanceof GitDurabilityError) {
            this.suspendTransferStorage();
            throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
          }
          throw new AuthError(422, 'malformed_packfile', 'Chunk is not a valid Git pack.');
        }
        session.receipts.push({ index, bytes: data.byteLength, sha256: digest });
        session.receipts.sort((left, right) => left.index - right.index);
        session.total_bytes += data.byteLength;
        session.updated_at = nowIso();
        session.expires_at = new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString();
        await this.writeSession(session, transferId);
        return { transfer_id: transferId, chunk_index: index, chunk_sha256: digest, received_bytes: data.byteLength, idempotent: false };
      });
    });
    return this.lifecycle
      ? await this.lifecycle.withAdmission(auth.vault.vault_id, operation)
      : await operation();
  }

  async finalizePush(auth: AuthenticatedDevice, transferId: string): Promise<PushResult> {
    const operation = async () => await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      const session = await this.requireSession(auth, transferId);
      if (session.status === 'completed' || session.status === 'rejected' || session.status === 'aborted') {
        if (!session.result) throw new AuthError(409, 'transfer_closed', 'Transfer is no longer open.');
        return session.result;
      }
      if (session.status === 'processing') {
        throw new AuthError(409, 'transfer_processing', 'Transfer finalization is already processing.');
      }
      if (session.receipts.length !== session.chunk_count) {
        throw new AuthError(409, 'transfer_incomplete', 'Transfer is missing one or more chunks.');
      }
      const result = await this.processPush(auth, session, transferId);
      session.result = result.status === 'rejected' ? null : result;
      session.status = result.status === 'rejected' ? 'open' : 'completed';
      session.updated_at = nowIso();
      await this.withStorageLock(async () => await this.writeSessionWithAdmission(auth, session, transferId));
      return result;
    });
    return this.lifecycle
      ? await this.lifecycle.withAdmission(auth.vault.vault_id, operation)
      : await operation();
  }

  async beginFinalizePush(auth: AuthenticatedDevice, transferId: string): Promise<ChunkPushDescriptor> {
    const operation = async () => await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      const current = await this.requireSession(auth, transferId);
      if (current.status === 'completed' || current.status === 'rejected' || current.status === 'aborted') return current;
      if (current.receipts.length !== current.chunk_count) {
        throw new AuthError(409, 'transfer_incomplete', 'Transfer is missing one or more chunks.');
      }
      current.status = 'processing';
      current.updated_at = nowIso();
      current.expires_at = new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString();
      if (this.lifecycle) {
        await this.lifecycle.withAdmission(auth.vault.vault_id, async () =>
          await this.withStorageLock(async () => await this.writeSession(current, transferId)));
      } else {
        await this.withStorageLock(async () => await this.writeSession(current, transferId));
      }
      return current;
    });
    const session = this.lifecycle
      ? await this.lifecycle.withAdmission(auth.vault.vault_id, operation)
      : await operation();
    if (session.status === 'processing') this.startProcessing(auth, transferId);
    return this.descriptor(session);
  }

  async deletePush(auth: AuthenticatedDevice, transferId: string): Promise<void> {
    const operation = async () => await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      // Removal stays available even when the quarantine repository is unusable, so a device can
      // always clear a stuck transfer instead of being locked out of its open-transfer budget.
      const session = await this.requireSession(auth, transferId, { requireRepository: false });
      if (session.status === 'processing') throw new AuthError(409, 'transfer_processing', 'A processing transfer cannot be deleted.');
      await this.withStorageLock(async () => {
        let root: DeletionRoot;
        try {
          root = await openDeletionRoot(this.config.transferDir);
        } catch (error) {
          if (isMissing(error)) {
            this.storedBytes = null;
            return;
          }
          throw error;
        }
        try {
          await removeDeletionRootDirectoryChild(root, transferId);
          await syncDeletionRoot(root);
        } finally {
          await closeDeletionRoot(root);
        }
        this.storedBytes = null;
      });
    });
    if (this.lifecycle) await this.lifecycle.withAdmission(auth.vault.vault_id, operation);
    else await operation();
  }

  private startProcessing(auth: AuthenticatedDevice, transferId: string): void {
    if (this.closed || this.processors.has(transferId)) return;
    const processing = this.processPendingPush(auth, transferId)
      .catch(() => undefined)
      .finally(() => this.processors.delete(transferId));
    this.processors.set(transferId, processing);
  }

  private async processPendingPush(auth: AuthenticatedDevice, transferId: string): Promise<void> {
    while (!this.closed) {
      let session = await this.requireSession(auth, transferId);
      if (session.status !== 'processing') return;
      const retryDelay = Math.max(0, Date.parse(session.retry_at ?? '') - Date.now());
      if (retryDelay > 0) await this.waitForRetry(retryDelay);
      if (this.closed) return;
      session = await this.requireSession(auth, transferId);
      if (session.status !== 'processing') return;
      try {
        const result = this.lifecycle
          ? await this.lifecycle.withAdmission(auth.vault.vault_id, async () => await this.processPush(auth, session, transferId))
          : await this.processPush(auth, session, transferId);
        if (result.status === 'rejected' && result.code === 'git_error') {
          throw new GitCommandError('Server Git processing failed.', '');
        }
        await this.withLock(transferId, async () => {
          const latest = await this.requireSession(auth, transferId);
          if (latest.status !== 'processing') return;
          latest.result = result;
          latest.status = result.status === 'rejected' ? 'rejected' : 'completed';
          latest.processing_error_code = null;
          latest.retry_at = null;
          latest.updated_at = nowIso();
          await this.withStorageLock(async () => await this.writeSessionWithAdmission(auth, latest, transferId));
        });
        return;
      } catch (error) {
        if (error instanceof GitDurabilityError || error instanceof AuthError && error.code === 'transfer_unavailable') {
          this.suspendTransferStorage();
          return;
        }
        if (error instanceof AuthError) {
          await this.withLock(transferId, async () => {
            const latest = await this.requireSession(auth, transferId);
            if (latest.status !== 'processing') return;
            latest.result = { status: 'rejected', code: error.code, message: error.message };
            latest.status = 'rejected';
            latest.processing_error_code = null;
            latest.retry_at = null;
            latest.updated_at = nowIso();
            await this.withStorageLock(async () => await this.writeSessionWithAdmission(auth, latest, transferId));
          });
          return;
        }
        await this.withLock(transferId, async () => {
          const latest = await this.requireSession(auth, transferId);
          if (latest.status !== 'processing') return;
          const attempts = (latest.processing_attempts ?? 0) + 1;
          const retryMs = Math.min(60_000, 1_000 * (2 ** Math.min(attempts - 1, 6)));
          latest.result = null;
          latest.processing_attempts = attempts;
          latest.processing_error_code = error instanceof GitCommandError ? 'server_git_error' : 'server_processing_error';
          latest.retry_at = new Date(Date.now() + retryMs).toISOString();
          latest.updated_at = nowIso();
          latest.expires_at = new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString();
          await this.withStorageLock(async () => await this.writeSessionWithAdmission(auth, latest, transferId));
        });
      }
    }
  }

  private async waitForRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const wake = () => {
        clearTimeout(timer);
        this.retryWaiters.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, delayMs);
      timer.unref();
      this.retryWaiters.add(wake);
    });
  }

  private async processPush(auth: AuthenticatedDevice, session: PushSession, transferId: string): Promise<PushResult> {
    if (this.isGitDurabilityUnavailable()) {
      throw new GitDurabilityError('Git repository durability could not be confirmed.');
    }
    const canonicalRepoPath = (this.git as unknown as { repoPath?: (vaultId: string) => string }).repoPath?.call(this.git, session.vault_id);
    return await this.sync.pushDeviceCommit(auth, session.manifest, Buffer.alloc(0), {
      reader: this.git.readerForRepo(this.repoDir(transferId), canonicalRepoPath === undefined ? undefined : join(canonicalRepoPath, 'objects')),
      promote: async () => await this.git.promoteTransferObjects(auth.vault.vault_id, this.repoDir(transferId))
    });
  }

  private assertTransferAllowed(auth: AuthenticatedDevice): void {
    if (this.transferUnavailable || this.isGitDurabilityUnavailable()) {
      throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
    }
    if (this.lifecycle?.isBlocked(auth.vault.vault_id)) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    if (auth.vault.status === 'blocked_integrity') {
      throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
  }

  private descriptor(session: PushSession): ChunkPushDescriptor {
    return {
      transfer_id: session.transfer_id,
      capability: CHUNK_TRANSFER_CAPABILITY,
      status: session.status,
      target_commit: session.manifest.target_commit,
      chunk_count: session.chunk_count,
      received_chunks: session.receipts.map((receipt) => receipt.index),
      max_chunk_bytes: this.config.transferChunkBytes,
      max_transfer_bytes: this.config.maxTransferBytes,
      expires_at: session.expires_at,
      ...(session.status === 'processing'
        ? {
            poll_after_ms: Math.max(1_000, Math.min(5_000, Date.parse(session.retry_at ?? '') - Date.now() || 1_000)),
            ...(session.processing_error_code ? { processing_error_code: session.processing_error_code } : {}),
            processing_attempts: session.processing_attempts ?? 0
          }
        : {}),
      ...(session.result ? { result: session.result } : {})
    };
  }

  private async requireSession(
    auth: AuthenticatedDevice,
    transferId: string,
    options: { requireRepository?: boolean } = {}
  ): Promise<PushSession> {
    if (!/^trn_[A-Za-z0-9]+$/u.test(transferId)) throw new AuthError(404, 'not_found', 'Resource not found.');
    const session = await this.readSession(transferId);
    if (!session || session.vault_id !== auth.vault.vault_id || session.device_id !== auth.device.device_id) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    if (this.expired(session)) {
      try {
        await this.removeSessionDirectory(transferId);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      throw new AuthError(410, 'transfer_expired', 'Transfer expired.');
    }
    if (options.requireRepository !== false && !(await this.validTransferRepository(transferId, session.vault_id))) {
      // Refuse this transfer, not every transfer: an unusable quarantine repository for one session
      // is not a reason to stop serving other vaults.
      this.recordTransferAnomaly('transfer_repository_unusable', transferId);
      throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
    }
    return session;
  }

  private expired(session: PushSession): boolean {
    return session.status !== 'processing' && Date.parse(session.expires_at) <= Date.now();
  }

  private async pruneExpired(): Promise<void> {
    await this.withStorageLock(async () => {
      let removed = false;
      let root: DeletionRoot;
      try {
        root = await openDeletionRoot(this.config.transferDir);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      try {
        for (const session of await this.listSessions()) {
          if (!this.expired(session)) continue;
          await removeDeletionRootDirectoryChild(root, session.transfer_id);
          removed = true;
        }
        if (removed) await syncDeletionRoot(root);
      } finally {
        await closeDeletionRoot(root);
      }
      if (removed) this.storedBytes = null;
    });
  }

  private async listSessions(): Promise<PushSession[]> {
    return (await this.scanSessions(SCAN_OPERATIONAL)).sessions;
  }

  /**
   * Walks persisted transfer sessions.
   *
   * `SCAN_STARTUP` is used once at initialization: it adopts a session record written before
   * ownership markers existed by durably recording ownership, repairs harmless accounting drift in
   * memory, and skips a session it cannot serve.
   *
   * `SCAN_OPERATIONAL` serves requests: identical, except that it never writes. It runs on request
   * paths that may already hold the storage lock, and accounting repairs stay in memory.
   *
   * `SCAN_VERDICT` is read-only for readiness: it reports the first inconsistency it finds without
   * writing anything, so a readiness or dashboard probe cannot change availability.
   *
   * Only a genuine storage failure suspends transfer service; a session-scoped anomaly is skipped
   * for that transfer instead of disabling every vault on the server.
   */
  private async scanSessions(
    mode: typeof SCAN_STARTUP | typeof SCAN_OPERATIONAL | typeof SCAN_VERDICT
  ): Promise<{ sessions: PushSession[]; problem: string | null }> {
    if (this.transferUnavailable) throw new TransferStorageError('Transfer storage is unavailable.');
    let root: DeletionRoot;
    try {
      root = await openDeletionRoot(this.config.transferDir);
    } catch (error) {
      this.suspendTransferStorage();
      if (isMissing(error)) throw new TransferStorageError('Transfer storage is unavailable.');
      throw error;
    }
    const sessions: PushSession[] = [];
    let problem: string | null = null;
    const flag = (reason: string, detail?: string): void => {
      this.recordTransferAnomaly(reason, detail);
      if (problem === null) problem = detail === undefined ? reason : `${reason}:${detail}`;
    };
    try {
      for (const entry of await readDeletionRootEntries(root)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^trn_[A-Za-z0-9]+$/u.test(entry.name)) {
          // Residue this server cannot read as one of its own sessions. Deletion-scoped inventory
          // keeps failing closed on unattributable residue; ordinary serving ignores it.
          continue;
        }
        const inspection = await this.inspectSessionAt(root, entry.name);
        if (inspection.kind !== 'valid') {
          flag('transfer_session_unusable', entry.name);
          continue;
        }
        const marker = await this.inspectOwnerMarkerAt(root, entry.name);
        if (marker.kind === 'valid') {
          if (marker.vaultId !== inspection.value.vault_id) {
            flag('transfer_session_owner_mismatch', entry.name);
            continue;
          }
        } else if (marker.kind === 'missing') {
          if (mode !== SCAN_STARTUP) {
            flag('transfer_session_ownership_missing', entry.name);
            continue;
          }
          flag('transfer_session_ownership_adopted', entry.name);
          await this.withStorageLock(async () => await this.writeOwnerMarker(entry.name, inspection.value.vault_id));
        } else {
          flag('transfer_session_owner_unreadable', entry.name);
          continue;
        }
        if (await this.hasStatePublicationTemporary(root, entry.name)) {
          flag('transfer_state_publication_incomplete', entry.name);
          continue;
        }
        if (!(await this.validTransferRepository(entry.name, inspection.value.vault_id))) {
          flag('transfer_repository_unusable', entry.name);
          continue;
        }
        if (!(await this.verifySessionAccounting(inspection.value, mode !== SCAN_VERDICT, flag)).ok) continue;
        sessions.push(inspection.value);
      }
      await assertDeletionRootUnchanged(root);
      return { sessions, problem };
    } catch (error) {
      if (error instanceof TransferStorageError) throw error;
      this.suspendTransferStorage();
      throw error;
    } finally {
      await closeDeletionRoot(root);
    }
  }

  private async readSession(transferId: string): Promise<PushSession | null> {
    const inspection = await this.inspectSession(transferId);
    if (inspection.kind === 'valid') {
      const flag = (reason: string, detail?: string): void => this.recordTransferAnomaly(reason, detail);
      if (!(await this.verifySessionAccounting(inspection.value, false, flag)).ok) {
        this.recordTransferAnomaly('transfer_session_unusable', transferId);
        return null;
      }
      return inspection.value;
    }
    if (inspection.kind === 'missing') return null;
    this.recordTransferAnomaly('transfer_session_unusable', transferId);
    return null;
  }

  private async inspectSession(transferId: string): Promise<
    { kind: 'valid'; value: PushSession } |
    { kind: 'missing' } |
    { kind: 'malformed' } |
    { kind: 'unreadable' }
  > {
    return await this.inspectSessionPath(join(this.sessionDir(transferId), 'session.json'), transferId);
  }

  private async inspectSessionAt(root: DeletionRoot, transferId: string): Promise<
    { kind: 'valid'; value: PushSession } |
    { kind: 'missing' } |
    { kind: 'malformed' } |
    { kind: 'unreadable' }
  > {
    return await this.inspectSessionPath(join(root.fdPath, transferId, 'session.json'), transferId);
  }

  private async inspectSessionPath(path: string, transferId: string): Promise<
    { kind: 'valid'; value: PushSession } |
    { kind: 'missing' } |
    { kind: 'malformed' } |
    { kind: 'unreadable' }
  > {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' };
    }
    if (info.isSymbolicLink() || !info.isFile()) return { kind: 'unreadable' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      return isMissing(error) ? { kind: 'missing' } : { kind: 'malformed' };
    }
    const value = parsePersistedPushSession(parsed, transferId);
    return value === null ? { kind: 'malformed' } : { kind: 'valid', value };
  }

  private async inspectOwnerMarker(transferId: string): Promise<
    { kind: 'valid'; vaultId: string } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unreadable' }
  > {
    return await this.inspectOwnerMarkerPath(this.ownerMarker(transferId));
  }

  private async inspectOwnerMarkerAt(root: DeletionRoot, transferId: string): Promise<
    { kind: 'valid'; vaultId: string } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unreadable' }
  > {
    return await this.inspectOwnerMarkerPath(join(root.fdPath, transferId, 'owner.json'));
  }

  private async inspectOwnerMarkerPath(path: string): Promise<
    { kind: 'valid'; vaultId: string } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'unreadable' }
  > {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) return { kind: 'unreadable' };
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return isRecord(value) && hasOnlyFields(value, ['vault_id']) && isBoundedIdentifier(value.vault_id)
        ? { kind: 'valid', vaultId: value.vault_id }
        : { kind: 'malformed' };
    } catch (error) {
      return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' };
    }
  }

  private async writeSessionWithAdmission(auth: AuthenticatedDevice, session: PushSession, transferId: string): Promise<void> {
    if (this.lifecycle) {
      await this.lifecycle.withAdmission(auth.vault.vault_id, async () => await this.writeSession(session, transferId));
    } else {
      await this.writeSession(session, transferId);
    }
  }

  private async writeOwnerMarker(transferId: string, vaultId: string): Promise<void> {
    try {
      await writeDurableFile(
        this.ownerMarker(transferId),
        `${JSON.stringify({ vault_id: vaultId })}\n`,
        this.persistence
      );
    } catch (error) {
      this.suspendTransferStorage();
      throw error;
    }
  }

  private async writeSession(session: PushSession, transferId: string): Promise<void> {
    try {
      await writeDurableFile(
        join(this.sessionDir(transferId), 'session.json'),
        `${JSON.stringify(session, null, 2)}\n`,
        this.persistence
      );
    } catch (error) {
      this.suspendTransferStorage();
      throw error;
    }
  }

  private isGitDurabilityUnavailable(): boolean {
    const checker = (this.git as unknown as { isDurabilityUnavailable?: () => boolean }).isDurabilityUnavailable;
    return checker?.call(this.git) ?? false;
  }

  private async validTransferRepository(transferId: string, vaultId?: string): Promise<boolean> {
    try {
      const info = await lstat(this.repoDir(transferId));
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const transferIntegrityValidator = (this.git as unknown as {
        checkTransferRepositoryIntegrity?: (path: string, targetVaultId: string) => Promise<boolean>;
      }).checkTransferRepositoryIntegrity;
      if (transferIntegrityValidator && vaultId !== undefined) {
        return await transferIntegrityValidator.call(this.git, this.repoDir(transferId), vaultId);
      }
      const integrityValidator = (this.git as unknown as {
        checkBareRepositoryIntegrity?: (path: string) => Promise<boolean>;
      }).checkBareRepositoryIntegrity;
      if (integrityValidator) return await integrityValidator.call(this.git, this.repoDir(transferId));
      const shapeValidator = (this.git as unknown as { isBareRepositoryShape?: (path: string) => Promise<boolean> }).isBareRepositoryShape;
      return shapeValidator ? await shapeValidator.call(this.git, this.repoDir(transferId)) : true;
    } catch {
      return false;
    }
  }

  private async removeSessionDirectory(transferId: string): Promise<void> {
    await this.withStorageLock(async () => {
      try {
        await this.removeSessionDirectoryUnderStorage(transferId);
      } finally {
        this.storedBytes = null;
      }
    });
  }

  private async removeSessionDirectoryUnderStorage(transferId: string): Promise<void> {
    const root = await openDeletionRoot(this.config.transferDir);
    try {
      await removeDeletionRootDirectoryChild(root, transferId);
      await syncDeletionRoot(root);
    } finally {
      await closeDeletionRoot(root);
    }
  }

  private async hasStatePublicationTemporary(root: DeletionRoot, transferId: string): Promise<boolean> {
    const entries = await readdir(join(root.fdPath, transferId), { withFileTypes: true });
    return entries.some((entry) => entry.name.startsWith('owner.json.tmp-') || entry.name.startsWith('session.json.tmp-'));
  }

  private sessionDir(transferId: string): string {
    return join(this.config.transferDir, transferId);
  }

  private repoDir(transferId: string): string {
    return join(this.sessionDir(transferId), 'repo.git');
  }

  private ownerMarker(transferId: string): string {
    return join(this.sessionDir(transferId), 'owner.json');
  }

  private async directoryBytes(root: string, transferRoot = true, excludeState = false, sessionRoot = !transferRoot): Promise<number> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (transferRoot && isMissing(error)) return 0;
      throw error;
    }
    let total = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new TransferStorageError('Transfer storage contains an unreadable entry.');
      }
      if (transferRoot && (!entry.isDirectory() || !/^trn_[A-Za-z0-9]+$/u.test(entry.name))) {
        throw new TransferStorageError('Transfer storage contains unattributed residue.');
      }
      if (excludeState && sessionRoot && (entry.name === 'owner.json' || entry.name === 'session.json')) continue;
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) total += await this.directoryBytes(entryPath, false, excludeState, transferRoot);
      else total += (await stat(entryPath)).size;
    }
    return total;
  }

  // Returns whether the session is serveable. In operational mode harmless accounting drift is
  // repaired from on-disk material instead of reporting the session unusable.
  private async verifySessionAccounting(
    session: PushSession,
    repair: boolean,
    flag: (reason: string, detail?: string) => void
  ): Promise<{ ok: boolean; actual: number }> {
    if (
      session.chunk_count > this.config.maxTransferChunks ||
      session.total_bytes > this.config.maxTransferBytes ||
      (session.stored_bytes !== undefined && session.stored_bytes > this.config.maxTransferStorageBytes) ||
      session.receipts.some((receipt) => receipt.bytes > this.config.transferChunkBytes)
    ) {
      flag('transfer_session_exceeds_limits', session.transfer_id);
    }
    let actual: number;
    try {
      actual = await this.directoryBytes(this.sessionDir(session.transfer_id), false, true);
    } catch {
      flag('transfer_session_unreadable', session.transfer_id);
      return { ok: false, actual: session.stored_bytes ?? 0 };
    }
    if (actual > this.config.maxTransferBytes || actual > this.config.maxTransferStorageBytes) {
      flag('transfer_session_storage_exceeds_limits', session.transfer_id);
    }
    if (session.stored_bytes !== undefined && session.stored_bytes !== actual) {
      // Accounted bytes can drift across releases. On-disk material is the authority; the recomputed
      // value keeps later quota decisions truthful without suspending the service.
      flag('transfer_session_accounting_mismatch', session.transfer_id);
      if (repair) session.stored_bytes = actual;
    }
    if ((session.status === 'completed' || session.status === 'rejected') && session.receipts.length !== session.chunk_count) {
      flag('transfer_terminal_session_incomplete', session.transfer_id);
    }
    return { ok: true, actual };
  }

  private async withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    return await this.withLock('__storage__', fn);
  }

  private async withLock<T>(transferId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(transferId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.locks.set(transferId, tail);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(transferId) === tail) this.locks.delete(transferId);
    }
  }
}

class TransferStorageError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function parsePersistedPushSession(value: unknown, transferId: string): PushSession | null {
  if (!isRecord(value) || value.version !== SESSION_VERSION) return null;
  if (!hasOnlyFields(value, [
    'version', 'transfer_id', 'vault_id', 'device_id', 'attempt_id', 'request_sha256', 'manifest', 'plan_sha256',
    'chunk_count', 'receipts', 'total_bytes', 'stored_bytes', 'status', 'result', 'processing_attempts',
    'processing_error_code', 'retry_at', 'created_at', 'updated_at', 'expires_at'
  ]) ||
    typeof value.transfer_id !== 'string' || value.transfer_id !== transferId || !/^trn_[A-Za-z0-9_]+$/u.test(value.transfer_id) ||
    !isBoundedIdentifier(value.vault_id) || !isBoundedIdentifier(value.device_id) ||
    typeof value.attempt_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.attempt_id) ||
    typeof value.request_sha256 !== 'string' || !SHA256_PATTERN.test(value.request_sha256) ||
    typeof value.plan_sha256 !== 'string' || !SHA256_PATTERN.test(value.plan_sha256) ||
    !isBoundedCounter(value.chunk_count) ||
    !isBoundedByteCount(value.total_bytes) ||
    (value.stored_bytes !== undefined && !isBoundedByteCount(value.stored_bytes, 17_179_869_184)) ||
    !isSessionStatus(value.status) ||
    !isIsoTimestamp(value.created_at) || !isIsoTimestamp(value.updated_at) || !isIsoTimestamp(value.expires_at) ||
    Date.parse(value.updated_at as string) < Date.parse(value.created_at as string) ||
    !Array.isArray(value.receipts) || value.receipts.length > value.chunk_count ||
    !isSessionResultCombination(value.status, value.result) ||
    (value.processing_attempts !== undefined && !isBoundedCounter(value.processing_attempts, MAX_PROCESSING_ATTEMPTS)) ||
    (value.processing_error_code !== undefined && value.processing_error_code !== null &&
      value.processing_error_code !== 'server_git_error' && value.processing_error_code !== 'server_processing_error') ||
    (value.retry_at !== undefined && value.retry_at !== null && !isIsoTimestamp(value.retry_at)) ||
    !isRetryCombination(value.status, value.processing_error_code, value.retry_at)
  ) return null;
  let manifest: DevicePushManifest;
  try {
    manifest = parseDevicePushManifest(value.manifest);
  } catch {
    return null;
  }
  if (manifest.vault_id !== value.vault_id || manifest.device_id !== value.device_id || manifest.attempt_id !== value.attempt_id) return null;
  const receipts: ChunkReceipt[] = [];
  const indexes = new Set<number>();
  let receiptBytes = 0;
  for (const receipt of value.receipts) {
    if (!isRecord(receipt) || !hasOnlyFields(receipt, ['index', 'bytes', 'sha256']) || !isBoundedCounter(receipt.index) || receipt.index >= value.chunk_count ||
      indexes.has(receipt.index) || !isBoundedByteCount(receipt.bytes, 8_589_934_592) ||
      typeof receipt.sha256 !== 'string' || !SHA256_PATTERN.test(receipt.sha256) ||
      receiptBytes > Number.MAX_SAFE_INTEGER - receipt.bytes) return null;
    indexes.add(receipt.index);
    receiptBytes += receipt.bytes;
    receipts.push({ index: receipt.index, bytes: receipt.bytes, sha256: receipt.sha256 });
  }
  if (receiptBytes !== value.total_bytes || (value.status === 'processing' && receipts.length !== value.chunk_count)) return null;
  return {
    version: SESSION_VERSION,
    transfer_id: transferId,
    vault_id: value.vault_id,
    device_id: value.device_id,
    attempt_id: value.attempt_id,
    request_sha256: value.request_sha256,
    manifest,
    plan_sha256: value.plan_sha256,
    chunk_count: value.chunk_count,
    receipts,
    total_bytes: value.total_bytes,
    ...(value.stored_bytes === undefined ? {} : { stored_bytes: value.stored_bytes }),
    status: value.status,
    result: value.result,
    ...(value.processing_attempts === undefined ? {} : { processing_attempts: value.processing_attempts }),
    ...(value.processing_error_code === undefined ? {} : { processing_error_code: value.processing_error_code }),
    ...(value.retry_at === undefined ? {} : { retry_at: value.retry_at }),
    created_at: value.created_at,
    updated_at: value.updated_at,
    expires_at: value.expires_at
  };
}

function isSessionStatus(value: unknown): value is PushSession['status'] {
  return value === 'open' || value === 'processing' || value === 'completed' || value === 'rejected' || value === 'aborted';
}

function isSessionResultCombination(status: PushSession['status'], result: unknown): result is PushResult | null {
  if (status === 'completed') return isPushResult(result) && result.status !== 'rejected';
  if (status === 'rejected') return isPushResult(result) && result.status === 'rejected';
  return result === null;
}

function isRetryCombination(
  status: PushSession['status'],
  processingErrorCode: unknown,
  retryAt: unknown
): boolean {
  if (status === 'completed' || status === 'rejected' || status === 'aborted') {
    return (processingErrorCode === undefined || processingErrorCode === null) && (retryAt === undefined || retryAt === null);
  }
  const hasError = processingErrorCode !== undefined && processingErrorCode !== null;
  const hasRetry = retryAt !== undefined && retryAt !== null;
  return hasError === hasRetry;
}

function isPushResult(value: unknown): value is PushResult {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'rejected') {
    return hasOnlyFields(value, ['status', 'code', 'message']) &&
      typeof value.code === 'string' && value.code.length > 0 && value.code.length <= MAX_RESULT_CODE_LENGTH &&
      typeof value.message === 'string' && value.message.length > 0 && value.message.length <= MAX_RESULT_MESSAGE_LENGTH;
  }
  if (value.status !== 'noop' && value.status !== 'merged' && value.status !== 'conflicted') return false;
  if (
    !hasOnlyFields(value, value.status === 'noop'
      ? ['status', 'device_ref', 'main', 'event_seq', 'directory_ack']
      : value.status === 'merged'
        ? ['status', 'device_ref', 'main', 'merge_commit', 'event_seq', 'directory_ack']
        : ['status', 'device_ref', 'main', 'conflict_id', 'event_seq', 'directory_ack']) ||
    typeof value.device_ref !== 'string' || value.device_ref.length === 0 || value.device_ref.length > MAX_DEVICE_REF_LENGTH ||
    !COMMIT_PATTERN.test(value.main) || !isBoundedCounter(value.event_seq) ||
    (value.directory_ack !== undefined && !isDirectoryAcknowledgement(value.directory_ack))
  ) return false;
  if (value.status === 'merged') return typeof value.merge_commit === 'string' && COMMIT_PATTERN.test(value.merge_commit);
  if (value.status === 'conflicted') return typeof value.conflict_id === 'string' && IDENTIFIER_PATTERN.test(value.conflict_id);
  return true;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) return false;
  return new Date(timestamp).toISOString() === value;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isBoundedCounter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isBoundedByteCount(value: unknown, maximum = 8_589_934_592): value is number {
  return isBoundedCounter(value, maximum);
}

function isDirectoryAcknowledgement(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyFields(value, ['proposal_id', 'status', 'acknowledged_intents']) ||
    typeof value.proposal_id !== 'string' || !/^dirprop_[0-9a-f]{64}$/u.test(value.proposal_id) ||
    (value.status !== 'accepted' && value.status !== 'conflicted' && value.status !== 'duplicate') ||
    !Array.isArray(value.acknowledged_intents) || value.acknowledged_intents.length > 5000) return false;
  return value.acknowledged_intents.every((acknowledgement) =>
    isRecord(acknowledgement) && hasOnlyFields(acknowledgement, ['intent_id', 'generation']) &&
    isBoundedIdentifier(acknowledgement.intent_id) && isBoundedCounter(acknowledgement.generation)
  );
}

function hasOnlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
