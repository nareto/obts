import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import {
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
import { GitService, sha256Hex } from './gitService.js';
import { SyncService } from './syncService.js';

const SESSION_VERSION = 1;
const MAX_OPEN_TRANSFERS_PER_DEVICE = 2;

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
  status: 'open' | 'completed' | 'aborted';
  result: PushResult | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export class ChunkTransferService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly git: GitService,
    private readonly sync: SyncService
  ) {}

  capabilities() {
    return {
      capabilities: [CHUNK_TRANSFER_CAPABILITY, DIRECTORY_PROPOSAL_CAPABILITY],
      max_chunk_bytes: this.config.transferChunkBytes,
      target_chunk_bytes: Math.max(1_048_576, Math.floor(this.config.transferChunkBytes * 0.85)),
      max_transfer_bytes: this.config.maxTransferBytes,
      max_transfer_chunks: this.config.maxTransferChunks
    };
  }

  async createPush(auth: AuthenticatedDevice, request: ChunkPushCreateRequest): Promise<{ descriptor: ChunkPushDescriptor; created: boolean }> {
    return await this.withLock('__create__', async () => {
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
    const open = sessions.filter((session) =>
      session.device_id === auth.device.device_id && session.status === 'open' && !this.expired(session)
    );
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
      status: 'open',
      result: null,
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString()
    };
    await mkdir(this.sessionDir(transferId), { recursive: true, mode: 0o700 });
    await this.git.initializeTransferRepo(auth.vault.vault_id, this.repoDir(transferId));
    await this.writeSession(session);
    return { descriptor: this.descriptor(session), created: true };
    });
  }

  async getPush(auth: AuthenticatedDevice, transferId: string): Promise<ChunkPushDescriptor> {
    return this.descriptor(await this.requireSession(auth, transferId));
  }

  async putChunk(
    auth: AuthenticatedDevice,
    transferId: string,
    index: number,
    data: Buffer,
    digest: string
  ): Promise<ChunkPushReceipt> {
    return await this.withLock(transferId, async () => {
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
      await this.withLock('__storage__', async () => {
        const storedBytes = await this.directoryBytes(this.config.transferDir);
        if (storedBytes + data.byteLength > this.config.maxTransferStorageBytes) {
          throw new AuthError(507, 'transfer_storage_full', 'Transfer quarantine storage is full.');
        }
        const chunkDir = join(this.sessionDir(transferId), 'chunks');
        await mkdir(chunkDir, { recursive: true, mode: 0o700 });
        const destination = join(chunkDir, `${String(index).padStart(6, '0')}.pack`);
        const temporary = `${destination}.tmp-${randomBytes(6).toString('hex')}`;
        await writeFile(temporary, data, { mode: 0o600 });
        try {
          await this.git.importPackIntoRepo(this.repoDir(transferId), data);
          const transferStoredBytes = await this.directoryBytes(this.sessionDir(transferId));
          const aggregateBytes = await this.directoryBytes(this.config.transferDir);
          if (transferStoredBytes > this.config.maxTransferBytes || aggregateBytes > this.config.maxTransferStorageBytes) {
            await rm(this.sessionDir(transferId), { recursive: true, force: true });
            throw new AuthError(413, 'transfer_too_large', 'Transfer expanded beyond its configured quarantine limit.');
          }
          await rm(temporary, { force: true });
        } catch (error) {
          await rm(temporary, { force: true });
          if (error instanceof AuthError) throw error;
          throw new AuthError(422, 'malformed_packfile', 'Chunk is not a valid Git pack.');
        }
      });
      session.receipts.push({ index, bytes: data.byteLength, sha256: digest });
      session.receipts.sort((left, right) => left.index - right.index);
      session.total_bytes += data.byteLength;
      session.updated_at = nowIso();
      session.expires_at = new Date(Date.now() + this.config.transferTtlSeconds * 1000).toISOString();
      await this.writeSession(session);
      return { transfer_id: transferId, chunk_index: index, chunk_sha256: digest, received_bytes: data.byteLength, idempotent: false };
    });
  }

  async finalizePush(auth: AuthenticatedDevice, transferId: string): Promise<PushResult> {
    return await this.withLock(transferId, async () => {
      this.assertTransferAllowed(auth);
      const session = await this.requireSession(auth, transferId);
      if (session.status === 'completed' || session.status === 'aborted') {
        if (!session.result) throw new AuthError(409, 'transfer_closed', 'Transfer is no longer open.');
        return session.result;
      }
      if (session.receipts.length !== session.chunk_count) {
        throw new AuthError(409, 'transfer_incomplete', 'Transfer is missing one or more chunks.');
      }
      const result = await this.sync.pushDeviceCommit(auth, session.manifest, Buffer.alloc(0), {
        reader: this.git.readerForRepo(this.repoDir(transferId)),
        promote: async () => await this.git.promoteTransferObjects(auth.vault.vault_id, this.repoDir(transferId))
      });
      session.result = result.status === 'rejected' ? null : result;
      session.status = result.status === 'rejected' ? 'open' : 'completed';
      session.updated_at = nowIso();
      await this.writeSession(session);
      return result;
    });
  }

  async deletePush(auth: AuthenticatedDevice, transferId: string): Promise<void> {
    await this.withLock(transferId, async () => {
      await this.requireSession(auth, transferId);
      await rm(this.sessionDir(transferId), { recursive: true, force: true });
    });
  }

  private assertTransferAllowed(auth: AuthenticatedDevice): void {
    if (auth.vault.status === 'blocked_integrity') {
      throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
    if (auth.device.status === 'review_needed' || auth.device.status === 'blocked_recovery') {
      throw new AuthError(409, 'device_blocked', 'Device requires review or recovery before transferring Git objects.');
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
      ...(session.result ? { result: session.result } : {})
    };
  }

  private async requireSession(auth: AuthenticatedDevice, transferId: string): Promise<PushSession> {
    if (!/^trn_[A-Za-z0-9]+$/u.test(transferId)) throw new AuthError(404, 'not_found', 'Resource not found.');
    const session = await this.readSession(transferId);
    if (!session || session.vault_id !== auth.vault.vault_id || session.device_id !== auth.device.device_id) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    if (this.expired(session)) {
      await rm(this.sessionDir(transferId), { recursive: true, force: true });
      throw new AuthError(410, 'transfer_expired', 'Transfer expired.');
    }
    return session;
  }

  private expired(session: PushSession): boolean {
    return Date.parse(session.expires_at) <= Date.now();
  }

  private async pruneExpired(): Promise<void> {
    for (const session of await this.listSessions()) {
      if (this.expired(session)) await rm(this.sessionDir(session.transfer_id), { recursive: true, force: true });
    }
  }

  private async listSessions(): Promise<PushSession[]> {
    let entries;
    try {
      entries = await readdir(this.config.transferDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions: PushSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('trn_')) continue;
      const session = await this.readSession(entry.name);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private async readSession(transferId: string): Promise<PushSession | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.sessionDir(transferId), 'session.json'), 'utf8')) as PushSession;
      return parsed.version === SESSION_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeSession(session: PushSession): Promise<void> {
    const destination = join(this.sessionDir(session.transfer_id), 'session.json');
    const temporary = `${destination}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  private sessionDir(transferId: string): string {
    return join(this.config.transferDir, transferId);
  }

  private repoDir(transferId: string): string {
    return join(this.sessionDir(transferId), 'repo.git');
  }

  private async directoryBytes(root: string): Promise<number> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) total += await this.directoryBytes(entryPath);
      else if (entry.isFile()) total += (await stat(entryPath)).size;
    }
    return total;
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
