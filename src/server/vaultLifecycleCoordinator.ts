import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { AuthError } from './authService.js';
import type { ServerConfig } from './config.js';
import type { GitService } from './gitService.js';
import {
  hasDurableDeletionRecord,
  MetadataCleanupError,
  MetadataPublicationError,
  type DeletionErrorCode,
  type DeletionJob,
  type DeletionReceipt,
  type MetadataDb,
  type MetadataStore
} from './metadataStore.js';
import type { VaultDeletionListResponse, VaultDeletionStatus } from '../shared/types.js';
import {
  assertDeletionRootUnchanged,
  closeDeletionRoot,
  DeletionRootError,
  openDeletionRoot,
  readDeletionRootEntries,
  removeDeletionRootDirectoryChild,
  syncDeletionRoot,
  type DeletionRoot
} from './deletionRoot.js';

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 1_000;
const VAULT_ID_PATTERN = /^[A-Za-z0-9_]+$/u;
const STORAGE_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOSPC', 'ENOTDIR', 'EROFS']);

export type TransferResidue = {
  attributable: string[];
  unattributed: boolean;
};

type TransferLifecycle = {
  drainVault(vaultId: string): Promise<void>;
  inventoryVaultResidue(vaultId: string): Promise<TransferResidue>;
  eraseVaultResidue?(vaultId: string): Promise<{ unattributed: boolean }>;
};

type Barrier = {
  active: number;
  closing: boolean;
  closed: boolean;
  drain: Promise<void>;
  releaseDrain: (() => void) | null;
  worker: Promise<void> | null;
  transition: Promise<void>;
};

export type Admission = { release(): void };

export class VaultLifecycleCoordinator {
  private readonly barriers = new Map<string, Barrier>();
  private transferLifecycle: TransferLifecycle | null = null;
  private stopping = false;
  private receiptExpiryTimer: NodeJS.Timeout | null = null;
  private invalidReceiptTimestamp = false;

  constructor(
    private readonly store: MetadataStore,
    private readonly git: GitService,
    private readonly config: ServerConfig
  ) {}

  attachTransferLifecycle(transfer: TransferLifecycle): void {
    this.transferLifecycle = transfer;
  }

  restoreDurableBarriers(db: MetadataDb): void {
    for (const vault of db.vaults) {
      if (!hasDurableDeletionRecord(db, vault.vault_id)) continue;
      const barrier = this.barrier(vault.vault_id);
      barrier.closing = true;
      barrier.closed = db.deletion_receipts.some((receipt) => receipt.vault_id === vault.vault_id);
    }
    for (const job of db.deletion_jobs) {
      const barrier = this.barrier(job.vault_id);
      barrier.closing = true;
      barrier.closed = false;
    }
    for (const receipt of db.deletion_receipts) {
      const barrier = this.barrier(receipt.vault_id);
      barrier.closing = true;
      barrier.closed = true;
    }
  }

  async reconcileDeletingVaultRows(vaultId?: string): Promise<void> {
    const initial = await this.store.snapshot();
    for (const vault of initial.vaults.filter((candidate) => candidate.status === 'deleting' && (vaultId === undefined || candidate.vault_id === vaultId))) {
      const barrier = this.barrier(vault.vault_id);
      barrier.closing = true;
      barrier.closed = false;
      if (hasDeletionJobOrReceipt(initial, vault.vault_id)) continue;
      const requestedAt = vault.updated_at;
      try {
        await this.store.mutateDurably((db) => {
          const current = db.vaults.find((candidate) => candidate.vault_id === vault.vault_id);
          if (!current || current.status !== 'deleting') return;
          if (hasDeletionJobOrReceipt(db, current.vault_id)) return;
          const deviceIds = new Set(db.devices.filter((device) => device.vault_id === current.vault_id).map((device) => device.device_id));
          db.deletion_jobs.push({
            vault_id: current.vault_id,
            owner_user_id: current.owner_user_id,
            requested_at: requestedAt,
            phase: 'intent',
            retry_at: null,
            error_code: null
          });
          for (const device of db.devices) {
            if (deviceIds.has(device.device_id)) {
              device.status = 'revoked';
              device.revoked_at = device.revoked_at ?? requestedAt;
            }
          }
          for (const token of db.tokens) {
            if (token.vault_id === current.vault_id || (token.device_id !== null && deviceIds.has(token.device_id))) {
              token.revoked_at = token.revoked_at ?? requestedAt;
            }
          }
          for (const connection of db.connections) {
            if (connection.selected_vault_id === current.vault_id && (connection.status === 'pending' || connection.status === 'approved')) {
              connection.status = 'denied';
            }
          }
        });
      } catch (error) {
        barrier.closing = true;
        barrier.closed = false;
        throw new AuthError(503, 'deletion_unavailable', 'Vault deletion could not be reconciled durably.');
      }
    }
  }

  async startPendingJobs(): Promise<void> {
    await this.reconcileDeletingVaultRows();
    const db = await this.store.snapshot();
    for (const job of db.deletion_jobs) this.startWorker(job.vault_id);
  }

  startReceiptExpiryMaintenance(): void {
    if (this.receiptExpiryTimer !== null) return;
    this.receiptExpiryTimer = setInterval(() => {
      void this.expireReceipts().catch(() => undefined);
    }, 60 * 60 * 1000);
    this.receiptExpiryTimer.unref();
  }

  isReady(): boolean {
    return !this.invalidReceiptTimestamp && this.store.isReady();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.receiptExpiryTimer !== null) {
      clearInterval(this.receiptExpiryTimer);
      this.receiptExpiryTimer = null;
    }
    await Promise.allSettled(
      [...this.barriers.values()]
        .map((barrier) => barrier.worker)
        .filter((worker): worker is Promise<void> => worker !== null)
    );
  }

  isDeleting(vaultId: string): boolean {
    const barrier = this.barriers.get(vaultId);
    return barrier?.closing === true && barrier.closed === false;
  }

  isBlocked(vaultId: string): boolean {
    return this.barriers.get(vaultId)?.closing === true;
  }

  async acquireAdmission(vaultId: string): Promise<Admission> {
    const barrier = this.barrier(vaultId);
    if (barrier.closing || barrier.closed) {
      throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
    }
    const durablyClosed = await this.isDurablyClosed(vaultId);
    if (durablyClosed || barrier.closing || barrier.closed) {
      throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
    }
    barrier.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        barrier.active -= 1;
        if (barrier.active === 0 && barrier.releaseDrain !== null) {
          barrier.releaseDrain();
          barrier.releaseDrain = null;
        }
      }
    };
  }

  async withAdmission<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    const admission = await this.acquireAdmission(vaultId);
    try {
      return await fn();
    } finally {
      admission.release();
    }
  }

  async withDeviceAdmission<T>(vaultId: string, userId: string, deviceId: string, fn: () => Promise<T>, tokenId?: string): Promise<T> {
    return await this.withAdmission(vaultId, async () => {
      const db = await this.store.snapshot();
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
      const device = db.devices.find((candidate) => candidate.device_id === deviceId);
      const user = db.users.find((candidate) => candidate.user_id === userId);
      const token = tokenId === undefined ? null : db.tokens.find((candidate) => candidate.token_id === tokenId);
      if (
        (tokenId !== undefined && (!token || token.kind !== 'device' || token.user_id !== userId || token.vault_id !== vaultId || token.device_id !== deviceId || token.revoked_at !== null || token.consumed_at !== null ||
          (token.expires_at !== null && (!Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= Date.now())))) ||
        !vault || !device || !user || user.disabled || vault.owner_user_id !== userId ||
        (vault.status !== 'active' && vault.status !== 'blocked_integrity') || device.vault_id !== vaultId ||
        device.user_id !== userId || device.status === 'revoked' || device.revoked_at !== null ||
        hasDurableDeletionRecord(db, vaultId)
      ) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      return await fn();
    });
  }

  async withOwnerVault<T>(userId: string, vaultId: string, fn: () => Promise<T>): Promise<T> {
    return await this.withAdmission(vaultId, async () => {
      const db = await this.store.snapshot();
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId && candidate.owner_user_id === userId);
      if (!vault) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (hasDurableDeletionRecord(db, vaultId)) throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
      return await fn();
    });
  }

  async beginDeletion(input: {
    ownerUserId: string;
    vaultId: string;
    confirmation?: string;
  }): Promise<VaultDeletionStatus> {
    const barrier = this.barrier(input.vaultId);
    const prior = barrier.transition;
    let release!: () => void;
    const transition = new Promise<void>((resolveTransition) => { release = resolveTransition; });
    barrier.transition = prior.then(() => transition);
    await prior;
    try {
      await this.expireReceipts();
      await this.reconcileDeletingVaultRows(input.vaultId);
      const initial = await this.store.snapshot();
      const existingJob = initial.deletion_jobs.find((job) => job.vault_id === input.vaultId);
      const existingReceipt = initial.deletion_receipts.find((receipt) => receipt.vault_id === input.vaultId);
      if (existingJob || existingReceipt) {
        const existingOwner = existingJob?.owner_user_id ?? existingReceipt?.owner_user_id;
        if (existingOwner !== input.ownerUserId) throw new AuthError(404, 'not_found', 'Resource not found.');
        if (existingJob) {
          barrier.closing = true;
          barrier.closed = false;
          this.startWorker(input.vaultId);
        } else {
          barrier.closing = true;
          barrier.closed = true;
        }
        return existingJob ? this.publicJob(existingJob) : this.publicReceipt(existingReceipt!);
      }
      const vault = initial.vaults.find((candidate) => candidate.vault_id === input.vaultId);
      if (!vault || vault.owner_user_id !== input.ownerUserId) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      if (barrier.closed) {
        throw new AuthError(503, 'deletion_unavailable', 'Vault deletion lifecycle is unavailable.');
      }
      if (input.confirmation !== `DELETE ${input.vaultId}`) {
        throw new AuthError(400, 'invalid_deletion_confirmation', 'Type the full vault deletion confirmation phrase.');
      }
      barrier.closing = true;
      barrier.closed = false;
      const requestedAt = new Date().toISOString();
      try {
        await this.store.mutateDurably((db) => {
          const current = db.vaults.find((candidate) => candidate.vault_id === input.vaultId);
          if (!current || current.owner_user_id !== input.ownerUserId) {
            throw new AuthError(404, 'not_found', 'Resource not found.');
          }
          if (current.status === 'deleting') {
            throw new AuthError(503, 'deletion_unavailable', 'Vault deletion has no durable lifecycle record.');
          }
          current.status = 'deleting';
          current.updated_at = requestedAt;
          db.deletion_jobs.push({
            vault_id: input.vaultId,
            owner_user_id: input.ownerUserId,
            requested_at: requestedAt,
            phase: 'intent',
            retry_at: null,
            error_code: null
          });
          const revokedAt = requestedAt;
          const deviceIds = new Set(db.devices.filter((device) => device.vault_id === input.vaultId).map((device) => device.device_id));
          for (const device of db.devices) {
            if (!deviceIds.has(device.device_id)) continue;
            device.status = 'revoked';
            device.revoked_at = revokedAt;
          }
          for (const token of db.tokens) {
            if (token.vault_id === input.vaultId || (token.device_id !== null && deviceIds.has(token.device_id))) {
              token.revoked_at = token.revoked_at ?? revokedAt;
            }
          }
          for (const connection of db.connections) {
            if (connection.selected_vault_id === input.vaultId && (connection.status === 'pending' || connection.status === 'approved')) {
              connection.status = 'denied';
            }
          }
        });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError(503, 'deletion_unavailable', 'Vault deletion could not be durably accepted.');
      }
      this.startWorker(input.vaultId);
      return {
        vault_id: input.vaultId,
        status: 'deleting',
        requested_at: requestedAt,
        completed_at: null,
        receipt_expires_at: null,
        retry_at: null,
        error_code: null
      };
    } catch (error) {
      throw mapDeletionMetadataError(error);
    } finally {
      release();
    }
  }

  async listDeletions(ownerUserId: string): Promise<VaultDeletionListResponse> {
    try {
      await this.expireReceipts();
      await this.reconcileDeletingVaultRows();
      const db = await this.store.snapshot();
      const deletions = [
        ...db.deletion_jobs.filter((job) => job.owner_user_id === ownerUserId).map((job) => this.publicJob(job)),
        ...db.deletion_receipts.filter((receipt) => receipt.owner_user_id === ownerUserId).map((receipt) => this.publicReceipt(receipt))
      ];
      deletions.sort((left, right) => right.requested_at.localeCompare(left.requested_at) || left.vault_id.localeCompare(right.vault_id));
      return { deletions };
    } catch (error) {
      throw mapDeletionMetadataError(error);
    }
  }

  async getDeletion(ownerUserId: string, vaultId: string): Promise<VaultDeletionStatus> {
    try {
      await this.expireReceipts();
      await this.reconcileDeletingVaultRows(vaultId);
      const db = await this.store.snapshot();
      const job = db.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      const receipt = db.deletion_receipts.find((candidate) => candidate.vault_id === vaultId);
      const owner = job?.owner_user_id ?? receipt?.owner_user_id;
      if (!owner || owner !== ownerUserId) throw new AuthError(404, 'not_found', 'Resource not found.');
      return job ? this.publicJob(job) : this.publicReceipt(receipt!);
    } catch (error) {
      throw mapDeletionMetadataError(error);
    }
  }

  async runPendingDeletion(vaultId: string): Promise<void> {
    this.startWorker(vaultId);
    await this.barrier(vaultId).worker;
  }

  private startWorker(vaultId: string): void {
    const barrier = this.barrier(vaultId);
    if (barrier.worker !== null || this.stopping) return;
    barrier.worker = this.runWorker(vaultId).finally(() => {
      barrier.worker = null;
    });
  }

  private async runWorker(vaultId: string): Promise<void> {
    const barrier = this.barrier(vaultId);
    while (!this.stopping) {
      let db: MetadataDb;
      try {
        db = await this.store.snapshot();
      } catch {
        barrier.closing = true;
        barrier.closed = false;
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }
      const job = db.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      if (!job) {
        const deletingRow = db.vaults.find((vault) => vault.vault_id === vaultId && vault.status === 'deleting');
        if (deletingRow) {
          try {
            await this.reconcileDeletingVaultRows(vaultId);
            continue;
          } catch {
            barrier.closing = true;
            barrier.closed = false;
            await this.sleep(RETRY_DELAY_MS);
            continue;
          }
        }
        barrier.closed = true;
        barrier.closing = true;
        return;
      }
      try {
        if (job.phase === 'intent') await this.setPhase(vaultId, 'draining', null);
        if (this.transferLifecycle) await this.transferLifecycle.drainVault(vaultId);
        await this.waitForDrain(barrier);
        const currentPhase = (await this.store.snapshot()).deletion_jobs.find((candidate) => candidate.vault_id === vaultId)?.phase;
        if (currentPhase === undefined) continue;
        if (this.transferLifecycle) {
          if (this.transferLifecycle.eraseVaultResidue) {
            const residue = await this.transferLifecycle.eraseVaultResidue(vaultId);
            if (residue.unattributed) throw new DeletionFailure('unattributed_residue');
          } else {
            const residue = await this.transferLifecycle.inventoryVaultResidue(vaultId);
            if (residue.unattributed) throw new DeletionFailure('unattributed_residue');
            await this.removeTransferResidue(residue.attributable);
          }
        }
        await this.eraseGitAndTemp(vaultId);
        await this.store.cleanupPersistenceTemps();
        await this.setPhase(vaultId, 'finalizing', null);
        await this.store.mutateDurably((mutableDb) => this.finalizeDb(mutableDb, vaultId));
        barrier.closed = true;
        barrier.closing = true;
        return;
      } catch (error) {
        const code: DeletionErrorCode = error instanceof DeletionFailure ? error.code : 'storage_unavailable';
        await this.recordRetry(vaultId, code).catch(() => undefined);
        await this.sleep(RETRY_DELAY_MS);
      }
    }
  }

  private async removeTransferResidue(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    let root: DeletionRoot;
    try {
      root = await openDeletionRoot(this.config.transferDir);
    } catch (error) {
      throw new DeletionFailure('storage_unavailable');
    }
    try {
      const names = new Set<string>();
      for (const path of paths) {
        const name = basename(path);
        if (path !== join(this.config.transferDir, name) || !/^trn_[A-Za-z0-9]+$/u.test(name) || names.has(name)) {
          throw new DeletionFailure('unattributed_residue');
        }
        names.add(name);
      }
      await assertDeletionRootUnchanged(root);
      for (const name of names) {
        try {
          await removeDeletionRootDirectoryChild(root, name);
        } catch (error) {
          if (error instanceof DeletionRootError) throw new DeletionFailure('unattributed_residue');
          throw error;
        }
      }
      if (names.size > 0) await syncDeletionRoot(root);
    } finally {
      await closeDeletionRoot(root);
    }
  }

  private async eraseGitAndTemp(vaultId: string): Promise<void> {
    if (!VAULT_ID_PATTERN.test(vaultId)) throw new DeletionFailure('storage_unavailable');
    let gitRoot: DeletionRoot | null = null;
    let tempRoot: DeletionRoot | null = null;
    try {
      try {
        gitRoot = await openDeletionRoot(this.config.gitStoreDir);
      } catch {
        throw new DeletionFailure('storage_unavailable');
      }
      const targetName = `${vaultId}.git`;
      const gitEntries = await readDeletionRootEntries(gitRoot);
      const metadata = await this.store.snapshot();
      const job = metadata.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      const erasureWasDurablyEntered = job?.phase === 'erasing' || job?.phase === 'finalizing';
      const knownVaultIds = new Set([
        ...metadata.vaults.map((vault) => vault.vault_id),
        ...metadata.deletion_jobs.map((candidate) => candidate.vault_id),
        ...metadata.deletion_receipts.map((receipt) => receipt.vault_id)
      ]);
      let targetGitPresent = false;
      for (const entry of gitEntries) {
        if (entry.name === targetName) {
          const validTarget = !entry.isSymbolicLink() && entry.isDirectory() &&
            await this.git.isBareRepositoryShape(join(gitRoot.fdPath, entry.name));
          if (entry.isSymbolicLink() || !entry.isDirectory() || (!validTarget && !erasureWasDurablyEntered)) {
            throw new DeletionFailure('unattributed_residue');
          }
          targetGitPresent = true;
          continue;
        }
        if (/^[A-Za-z0-9_]+\.git$/u.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
          const foreignVaultId = entry.name.slice(0, -'.git'.length);
          if (!knownVaultIds.has(foreignVaultId) || !(await this.git.isBareRepositoryShape(join(gitRoot.fdPath, entry.name)))) {
            throw new DeletionFailure('unattributed_residue');
          }
          continue;
        }
        throw new DeletionFailure('unattributed_residue');
      }
      if (!targetGitPresent && !erasureWasDurablyEntered) throw new DeletionFailure('storage_unavailable');

      try {
        tempRoot = await openDeletionRoot(this.config.tempDir);
      } catch (error) {
        if (!isMissing(error)) throw new DeletionFailure('storage_unavailable');
      }
      const targetEntries: string[] = [];
      if (tempRoot !== null) {
        const entries = await readDeletionRootEntries(tempRoot);
        const prefixes = ['quarantine-', 'merge-', 'semantic-merge-'];
        for (const entry of entries) {
          if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('merge-index-')) {
            throw new DeletionFailure('unattributed_residue');
          }
          if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) {
            throw new DeletionFailure('unattributed_residue');
          }
          const marker = await inspectTempOwnerMarker(tempRoot, entry.name);
          if (marker !== vaultId) throw new DeletionFailure('unattributed_residue');
          targetEntries.push(entry.name);
        }
      }

      await assertDeletionRootUnchanged(gitRoot);
      if (tempRoot !== null) await assertDeletionRootUnchanged(tempRoot);
      if (!erasureWasDurablyEntered) await this.setPhase(vaultId, 'erasing', null);
      if (targetGitPresent) {
        try {
          await removeDeletionRootDirectoryChild(gitRoot, targetName);
          await syncDeletionRoot(gitRoot);
        } catch (error) {
          if (error instanceof DeletionRootError) throw new DeletionFailure('unattributed_residue');
          throw error;
        }
      }
      if (tempRoot !== null) {
        for (const name of targetEntries) {
          try {
            await removeDeletionRootDirectoryChild(tempRoot, name);
          } catch (error) {
            if (error instanceof DeletionRootError) throw new DeletionFailure('unattributed_residue');
            throw error;
          }
        }
        if (targetEntries.length > 0) await syncDeletionRoot(tempRoot);
      }
    } finally {
      if (tempRoot !== null) await closeDeletionRoot(tempRoot);
      if (gitRoot !== null) await closeDeletionRoot(gitRoot);
    }
  }

  private finalizeDb(db: MetadataDb, vaultId: string): DeletionReceipt {
    const job = db.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
    if (!job) {
      const existing = db.deletion_receipts.find((candidate) => candidate.vault_id === vaultId);
      if (existing) return existing;
      throw new DeletionFailure('metadata_unavailable');
    }
    const completedAt = new Date().toISOString();
    const deviceIds = new Set(db.devices.filter((device) => device.vault_id === vaultId).map((device) => device.device_id));
    const connectionIds = new Set(db.connections
      .filter((connection) => connection.selected_vault_id === vaultId || (connection.created_device_id !== null && deviceIds.has(connection.created_device_id)))
      .map((connection) => connection.connection_id));
    db.vaults = db.vaults.filter((vault) => vault.vault_id !== vaultId);
    db.devices = db.devices.filter((device) => !deviceIds.has(device.device_id));
    db.tokens = db.tokens.filter((token) => token.vault_id !== vaultId && (token.device_id === null || !deviceIds.has(token.device_id)));
    db.connections = db.connections.filter((connection) => !connectionIds.has(connection.connection_id));
    db.sync_operations = db.sync_operations.filter((operation) => operation.vault_id !== vaultId);
    db.conflicts = db.conflicts.filter((conflict) => conflict.vault_id !== vaultId);
    db.events = db.events.filter((event) => event.vault_id !== vaultId);
    db.audit_log = db.audit_log.filter((audit) => audit.vault_id !== vaultId && !deviceIds.has(audit.actor_device_id ?? ''));
    db.diagnostic_events = db.diagnostic_events.filter((event) => event.vault_id !== vaultId && !deviceIds.has(event.device_id ?? '') && !connectionIds.has(event.connection_id ?? ''));
    delete db.event_seq_by_vault[vaultId];
    delete db.merge_sequence_by_vault[vaultId];
    delete db.directory_state_by_vault[vaultId];
    delete db.derived_history_by_vault[vaultId];
    db.directory_proposal_results = db.directory_proposal_results.filter((result) => result.vault_id !== vaultId);
    db.deletion_jobs = db.deletion_jobs.filter((candidate) => candidate.vault_id !== vaultId);
    const receipt: DeletionReceipt = {
      vault_id: vaultId,
      owner_user_id: job.owner_user_id,
      requested_at: job.requested_at,
      completed_at: completedAt,
      status: 'deleted'
    };
    db.deletion_receipts = db.deletion_receipts.filter((candidate) => candidate.vault_id !== vaultId);
    db.deletion_receipts.push(receipt);
    return receipt;
  }

  private async recordRetry(vaultId: string, code: DeletionErrorCode): Promise<void> {
    await this.store.mutateDurably((db) => {
      const job = db.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      if (!job) return;
      job.retry_at = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
      job.error_code = code;
    });
  }

  private async setPhase(vaultId: string, phase: DeletionJob['phase'], errorCode: DeletionErrorCode | null): Promise<void> {
    await this.store.mutateDurably((db) => {
      const job = db.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      if (job) {
        job.phase = phase;
        job.retry_at = null;
        job.error_code = errorCode;
      }
    });
  }

  async expireReceipts(now = Date.now()): Promise<void> {
    const db = await this.store.snapshot();
    const expired: string[] = [];
    let invalid = false;
    for (const receipt of db.deletion_receipts) {
      const expiry = receiptExpiryTimestamp(receipt.completed_at);
      if (expiry === null) {
        invalid = true;
      } else if (expiry <= now) {
        expired.push(receipt.vault_id);
      }
    }
    this.invalidReceiptTimestamp = invalid;
    if (expired.length === 0) return;
    await this.store.mutateDurably((mutableDb) => {
      mutableDb.deletion_receipts = mutableDb.deletion_receipts.filter((receipt) => {
        const expiry = receiptExpiryTimestamp(receipt.completed_at);
        return expiry === null || expiry > now;
      });
    });
  }

  private async isDurablyClosed(vaultId: string): Promise<boolean> {
    const db = await this.store.snapshot();
    return hasDurableDeletionRecord(db, vaultId);
  }

  private async waitForDrain(barrier: Barrier): Promise<void> {
    if (barrier.active === 0) return;
    barrier.drain = new Promise<void>((resolveDrain) => { barrier.releaseDrain = resolveDrain; });
    await barrier.drain;
  }

  private barrier(vaultId: string): Barrier {
    let barrier = this.barriers.get(vaultId);
    if (!barrier) {
      barrier = {
        active: 0,
        closing: false,
        closed: false,
        drain: Promise.resolve(),
        releaseDrain: null,
        worker: null,
        transition: Promise.resolve()
      };
      this.barriers.set(vaultId, barrier);
    }
    return barrier;
  }

  private publicJob(job: DeletionJob): VaultDeletionStatus {
    return {
      vault_id: job.vault_id,
      status: 'deleting',
      requested_at: job.requested_at,
      completed_at: null,
      receipt_expires_at: null,
      retry_at: job.retry_at,
      error_code: job.error_code
    };
  }

  private publicReceipt(receipt: DeletionReceipt): VaultDeletionStatus {
    const expiry = receiptExpiryTimestamp(receipt.completed_at);
    return {
      vault_id: receipt.vault_id,
      status: 'deleted',
      requested_at: receipt.requested_at,
      completed_at: receipt.completed_at,
      receipt_expires_at: expiry === null ? null : new Date(expiry).toISOString(),
      retry_at: null,
      error_code: expiry === null ? 'metadata_unavailable' : null
    };
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, delayMs);
      timer.unref();
    });
  }
}

class DeletionFailure extends Error {
  constructor(readonly code: DeletionErrorCode) {
    super(code);
  }
}

function mapDeletionMetadataError(error: unknown): unknown {
  if (error instanceof AuthError) return error;
  if (error instanceof MetadataPublicationError || error instanceof MetadataCleanupError || isStorageUncertainty(error)) {
    return new AuthError(503, 'deletion_unavailable', 'Deletion lifecycle metadata is unavailable.');
  }
  return error;
}

function isStorageUncertainty(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return typeof code === 'string' && STORAGE_ERROR_CODES.has(code);
}

function receiptExpiryTimestamp(completedAtValue: string): number | null {
  const completedAt = Date.parse(completedAtValue);
  const maxDate = 8_640_000_000_000_000;
  if (!Number.isFinite(completedAt) || completedAt > maxDate - RECEIPT_RETENTION_MS) return null;
  const expiry = completedAt + RECEIPT_RETENTION_MS;
  return expiry < -maxDate ? null : expiry;
}

function hasDeletionJobOrReceipt(db: MetadataDb, vaultId: string): boolean {
  return db.deletion_jobs.some((job) => job.vault_id === vaultId) ||
    db.deletion_receipts.some((receipt) => receipt.vault_id === vaultId);
}

async function inspectTempOwnerMarker(root: DeletionRoot, name: string): Promise<string | null> {
  const markerPath = join(root.fdPath, name, '.obts-owner.json');
  try {
    const info = await lstat(markerPath);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as { vault_id?: unknown };
    return typeof parsed.vault_id === 'string' && VAULT_ID_PATTERN.test(parsed.vault_id) ? parsed.vault_id : null;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
