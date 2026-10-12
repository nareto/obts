import { newId, nowIso } from '../shared/ids.js';
import { AuthError } from './authService.js';
import type { GitService } from './gitService.js';
import type { DeviceRemovalJob, MetadataDb, MetadataStore } from './metadataStore.js';
import { hasDurableDeletionRecord, isDeviceRevoked } from './metadataStore.js';
import { type OperationalLog, silentOperationalLog } from './operationalLog.js';
import type { SyncService } from './syncService.js';
import type { VaultLifecycleCoordinator } from './vaultLifecycleCoordinator.js';

const DEVICE_REF_PREFIX = 'refs/obts/devices/';
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
const MAX_GENERATIONS_PER_RUN = 3;

/** Named points where tests (and only tests) may inject a failure or a concurrent change. */
export type DeviceRemovalCheckpoint =
  | 'after_intent'
  | 'after_drain'
  | 'before_ref_delete'
  | 'after_ref_delete'
  | 'after_credentials'
  | 'after_replay'
  | 'after_transfer_residue'
  | 'after_bookkeeping';

export type DeviceRemovalOptions = {
  drainTimeoutMs?: number;
  checkpoint?: (point: DeviceRemovalCheckpoint, target: { vaultId: string; deviceId: string }) => void | Promise<void>;
};

type TransferDeviceLifecycle = {
  drainDevice(vaultId: string, deviceId: string): Promise<void>;
  eraseDeviceResidue(vaultId: string, deviceId: string): Promise<void>;
  stagedTargetCommits(vaultId: string, deviceId: string): Promise<string[]>;
};

export type DeviceRemovalRequest = {
  ownerUserId: string;
  vaultId: string;
  deviceId: string;
  confirmation: string | undefined;
  discardUnmerged: boolean;
};

type Target = { ownerUserId: string; vaultId: string; deviceId: string };

type Selected = {
  vaultStatus: string;
  currentMain: string;
  deviceRef: string;
  deviceRefHead: string | null;
  openConflict: boolean;
  unsettledOperation: boolean;
  job: DeviceRemovalJob | null;
};

class RemovalFailure extends AuthError {
  constructor(statusCode: number, code: string, message: string, readonly retryable: boolean, readonly extra: Record<string, string | number | boolean> = {}) {
    super(statusCode, code, message, { retryable, ...extra });
  }
}

const REF_MISSING_DETAILS = { reason: 'ref_missing', resolution: 'discard_phrase' } as const;
const staleRefMessage = 'The recorded device ref is missing. If nothing is left to delete, repeat the request with the discard phrase to confirm.';

/** The journal vanished underneath a run: whole-vault deletion superseded it or it was completed. */
class RemovalSuperseded extends Error {}

/**
 * Permanent removal of an already-revoked device (ADR 0020, OBTSDeviceRemoval.tla):
 * durable intent -> device barrier -> drain -> strict re-read and eligibility under the vault sync
 * lock -> expected-OID compare-and-swap ref delete -> staged cleanup -> one-commit completion.
 */
export class DeviceRemovalService {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly store: MetadataStore,
    private readonly git: GitService,
    private readonly lifecycle: VaultLifecycleCoordinator,
    private readonly sync: SyncService,
    private readonly transfers: TransferDeviceLifecycle,
    private readonly options: DeviceRemovalOptions = {},
    private readonly log: OperationalLog = silentOperationalLog
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  async remove(request: DeviceRemovalRequest): Promise<void> {
    await this.serialized(request.deviceId, async () => {
      const target: Target = { ownerUserId: request.ownerUserId, vaultId: request.vaultId, deviceId: request.deviceId };
      const selected = await this.select(target);
      const expectedPhrase = request.discardUnmerged
        ? `DELETE ${request.deviceId} AND DISCARD UNMERGED WORK`
        : `DELETE ${request.deviceId}`;
      const phraseMatches = request.confirmation === expectedPhrase;
      // A grant exists only when the full discard phrase matched. Persist this request's grant (or its
      // absence) BEFORE any refusal, including the phrase check, so a mistyped or otherwise refused request
      // withdraws an earlier durable grant and startup resumption can never use it. `select` already applied
      // the owner-scope 404 rules, so a foreign caller never reaches this write. Never escalates.
      const grant = phraseMatches && request.discardUnmerged;
      if (selected.job !== null && selected.job.discard_unmerged !== grant) {
        await this.persistGrant(target, grant);
      }
      if (!phraseMatches) {
        throw new AuthError(400, 'confirmation_mismatch', 'Type the exact device removal confirmation phrase.');
      }
      this.assertNoOpenWork(selected);
      const ref = selected.job === null || selected.job.phase === 'intent'
        ? await this.verifyRefForIntent(target, selected, request.discardUnmerged)
        : { oid: selected.job.expected_ref_oid };
      if (selected.job === null || selected.job.phase === 'intent') {
        await this.assertStagedCovered(target, selected.currentMain, request.discardUnmerged);
      }
      await this.commitIntent(target, ref.oid, request.discardUnmerged);
      this.lifecycle.closeDeviceBarrier(target.vaultId, target.deviceId);
      if (!(await this.drive(target))) {
        throw new AuthError(409, 'vault_deleting', 'Vault deletion superseded the device removal.');
      }
    });
  }

  /** Startup recovery: barriers are already restored; finish or re-fail every journal before serving. */
  async resumePending(): Promise<void> {
    const jobs = await this.store.read((db) => db.device_removal_jobs.map((job) => ({ ...job })));
    for (const job of jobs) {
      const target: Target = { ownerUserId: job.owner_user_id, vaultId: job.vault_id, deviceId: job.device_id };
      try {
        const orphan = await this.store.read((db) =>
          hasDurableDeletionRecord(db, job.vault_id) ? 'superseded'
            : db.devices.some((device) => device.device_id === job.device_id && device.vault_id === job.vault_id) ? null : 'orphan');
        if (orphan === 'superseded') continue;
        if (orphan === 'orphan') {
          await this.store.mutateDurably((db) => {
            db.device_removal_jobs = db.device_removal_jobs.filter((candidate) => candidate.device_id !== job.device_id);
          });
          this.lifecycle.releaseDeviceBarrier(job.vault_id, job.device_id);
          continue;
        }
        this.lifecycle.closeDeviceBarrier(target.vaultId, target.deviceId);
        // A journal that failed on an owner-decision refusal waits for the owner; the barrier stays closed.
        if (job.state === 'failed' && !job.retryable) continue;
        await this.serialized(job.device_id, async () => {
          await this.drive(target);
        });
      } catch (error) {
        this.log.backgroundFailure('device_removal', error);
      }
    }
  }

  private async serialized(deviceId: string, run: () => Promise<void>): Promise<void> {
    const prior = this.tails.get(deviceId) ?? Promise.resolve();
    const current = prior.then(run);
    const settled = current.then(() => undefined, () => undefined);
    this.tails.set(deviceId, settled);
    try {
      await current;
    } finally {
      if (this.tails.get(deviceId) === settled) this.tails.delete(deviceId);
    }
  }

  private async select(target: Target): Promise<Selected> {
    return await this.store.read((db): Selected => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === target.vaultId && candidate.owner_user_id === target.ownerUserId);
      if (!vault) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (hasDurableDeletionRecord(db, target.vaultId)) throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
      const device = db.devices.find((candidate) =>
        candidate.device_id === target.deviceId && candidate.vault_id === target.vaultId && candidate.user_id === target.ownerUserId);
      if (!device) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (!isDeviceRevoked(device)) {
        throw new AuthError(409, 'device_not_revoked', 'Revoke the device before removing it.');
      }
      return {
        vaultStatus: vault.status,
        currentMain: vault.current_main,
        deviceRef: device.device_ref,
        deviceRefHead: device.device_ref_head,
        openConflict: db.conflicts.some((conflict) =>
          conflict.vault_id === target.vaultId && conflict.device_id === target.deviceId && conflict.status === 'open'),
        unsettledOperation: db.sync_operations.some((operation) =>
          operation.vault_id === target.vaultId && operation.device_id === target.deviceId &&
          (operation.status === 'started' || operation.status === 'prepared')),
        job: db.device_removal_jobs.find((job) => job.device_id === target.deviceId) ?? null
      };
    }) as Selected;
  }

  private assertNoOpenWork(selected: Selected): void {
    if (selected.openConflict) {
      throw new AuthError(409, 'device_has_open_work', 'Resolve the device conflicts before removing it.', { reason: 'open_conflict' });
    }
    if (selected.unsettledOperation) {
      throw new AuthError(409, 'device_has_open_work', 'Wait for the device operations to settle before removing it.', { reason: 'unsettled_operation' });
    }
  }

  private async readRef(target: Target, selected: Pick<Selected, 'deviceRef'>): Promise<string | null> {
    if (selected.deviceRef !== `${DEVICE_REF_PREFIX}${target.deviceId}`) {
      throw new RemovalFailure(409, 'device_ref_inconsistent', 'The device ref does not match its identity.', false);
    }
    try {
      return await this.git.readRefStrict(target.vaultId, selected.deviceRef);
    } catch {
      throw new RemovalFailure(503, 'device_removal_unavailable', 'The device ref could not be verified. Retry later.', true);
    }
  }

  private async assertCovered(target: Target, currentMain: string, oid: string, discard: boolean): Promise<void> {
    const verdict = await this.git.ancestryVerdict(target.vaultId, oid, currentMain).catch(() => 'unknown' as const);
    if (verdict === 'unknown') {
      throw new RemovalFailure(503, 'device_removal_unavailable', 'Device history could not be verified. Retry later.', true);
    }
    if (verdict === 'not_ancestor' && !discard) {
      throw new AuthError(409, 'device_has_unmerged_work', 'The device has work that is not in the vault main history.', { reason: 'device_ref' });
    }
  }

  /**
   * Staged, unfinalized transfers of the device are erased by cleanup and may hold the only server copy of
   * a commit. Without the discard grant of THIS request every such session's target commit must be a
   * verified ancestor of canonical main (a commit object that is not in the repository is, by definition,
   * not in main). Unknown ancestry or an unreadable session fails closed.
   */
  private async assertStagedCovered(target: Target, currentMain: string, discard: boolean): Promise<void> {
    if (discard) return;
    const unavailable = () => new RemovalFailure(503, 'device_removal_unavailable', 'Staged transfers could not be verified. Retry later.', true);
    let commits: string[];
    try {
      commits = await this.transfers.stagedTargetCommits(target.vaultId, target.deviceId);
    } catch {
      throw unavailable();
    }
    for (const commit of commits) {
      let verdict: 'ancestor' | 'not_ancestor' | 'unknown';
      try {
        verdict = await this.git.commitExists(target.vaultId, commit)
          ? await this.git.ancestryVerdict(target.vaultId, commit, currentMain)
          : 'not_ancestor';
      } catch {
        verdict = 'unknown';
      }
      if (verdict === 'unknown') throw unavailable();
      if (verdict === 'not_ancestor') {
        throw new AuthError(409, 'device_has_unmerged_work', 'The device has staged transfers that are not in the vault main history.', { reason: 'staged_transfer' });
      }
    }
  }

  private async verifyRefForIntent(target: Target, selected: Selected, discard: boolean): Promise<{ oid: string | null }> {
    const oid = await this.readRef(target, selected);
    if (oid === null) {
      // readRef is a strict read, so null is a definitive "no such ref", never an unreadable ref. The
      // discard phrase is the owner's explicit confirmation that nothing remains to delete.
      if (selected.deviceRefHead !== null && selected.job === null && !discard) {
        throw new RemovalFailure(409, 'device_ref_inconsistent', staleRefMessage, false, REF_MISSING_DETAILS);
      }
      return { oid };
    }
    await this.assertCovered(target, selected.currentMain, oid, discard);
    return { oid };
  }

  private async persistGrant(target: Target, discard: boolean): Promise<void> {
    await this.store.mutateDurably((db) => {
      const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
      if (job === undefined || job.discard_unmerged === discard) return;
      job.discard_unmerged = discard;
      job.updated_at = nowIso();
    });
  }

  private async commitIntent(target: Target, oid: string | null, discard: boolean): Promise<void> {
    await this.store.mutateDurably((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === target.vaultId && candidate.owner_user_id === target.ownerUserId);
      if (!vault) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (hasDurableDeletionRecord(db, target.vaultId)) throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
      const device = db.devices.find((candidate) =>
        candidate.device_id === target.deviceId && candidate.vault_id === target.vaultId && candidate.user_id === target.ownerUserId);
      if (!device) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (!isDeviceRevoked(device)) throw new AuthError(409, 'device_not_revoked', 'Revoke the device before removing it.');
      const timestamp = nowIso();
      const existing = db.device_removal_jobs.find((job) => job.device_id === target.deviceId);
      if (existing === undefined) {
        db.device_removal_jobs.push({
          device_id: target.deviceId,
          vault_id: target.vaultId,
          owner_user_id: target.ownerUserId,
          requested_at: timestamp,
          updated_at: timestamp,
          phase: 'intent',
          generation: 1,
          expected_ref_oid: oid,
          discard_unmerged: discard,
          state: 'pending',
          error_code: null,
          retryable: true
        });
        return;
      }
      // The grant belongs to this request only: a later plain-phrase request must never inherit it.
      existing.discard_unmerged = discard;
      existing.state = 'pending';
      existing.error_code = null;
      existing.retryable = true;
      existing.updated_at = timestamp;
    });
  }

  private async checkpoint(point: DeviceRemovalCheckpoint, target: Target): Promise<void> {
    await this.options.checkpoint?.(point, { vaultId: target.vaultId, deviceId: target.deviceId });
  }

  /** Runs a committed (or resumed) journal to completion; any failure leaves the journal in place. */
  private async drive(target: Target): Promise<boolean> {
    try {
      await this.markPending(target);
      await this.checkpoint('after_intent', target);
      await this.drain(target);
      await this.checkpoint('after_drain', target);
      await this.sync.runWithVaultLock(target.vaultId, async () => await this.deleteRefStep(target));
      await this.lifecycle.withAdmission(target.vaultId, async () => await this.cleanupAndComplete(target));
      return true;
    } catch (error) {
      if (error instanceof RemovalSuperseded) return false;
      const failure = this.classify(error);
      await this.recordFailure(target, failure);
      throw new AuthError(failure.statusCode, failure.code, failure.message, { retryable: failure.retryable, ...failure.extra });
    }
  }

  private classify(error: unknown): RemovalFailure {
    if (error instanceof RemovalFailure) return error;
    if (error instanceof AuthError) {
      // Eligibility refusals (4xx) need an owner decision; only server-side trouble is blindly retryable.
      const extra = { ...error.details };
      delete extra.retryable;
      return new RemovalFailure(error.statusCode, error.code, error.message, error.statusCode >= 500, extra);
    }
    this.log.backgroundFailure('device_removal', error);
    return new RemovalFailure(503, 'device_removal_incomplete', 'Device removal is incomplete and can be retried.', true);
  }

  private async recordFailure(target: Target, failure: RemovalFailure): Promise<void> {
    try {
      await this.store.mutateDurably((db) => {
        const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
        if (job === undefined) return;
        job.state = 'failed';
        job.error_code = failure.code;
        job.retryable = failure.retryable;
        job.updated_at = nowIso();
      });
    } catch (error) {
      this.log.backgroundFailure('device_removal', error);
    }
  }

  private async markPending(target: Target): Promise<void> {
    await this.updateJob(target, (job) => {
      if (job.state === 'pending' && job.error_code === null) return false;
      job.state = 'pending';
      job.error_code = null;
      job.retryable = true;
      return true;
    });
  }

  /** Applies a mutation to the journal; throws RemovalSuperseded when the journal no longer exists. */
  private async updateJob(target: Target, apply: (job: DeviceRemovalJob) => boolean): Promise<DeviceRemovalJob> {
    const committed = await this.store.mutateDurably((db) => {
      const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
      if (job === undefined) return null;
      if (apply(job)) job.updated_at = nowIso();
      return { ...job };
    });
    if (committed === null) throw new RemovalSuperseded();
    return committed;
  }

  /**
   * Waits for admitted and detached device work. It holds no metadata queue, vault lock or transfer
   * lock, so drained work can always make progress; a timeout leaves the journal for a later retry.
   */
  private async drain(target: Target): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    const timedOut = new RemovalFailure(503, 'device_removal_incomplete', 'Device work is still draining. Retry later.', true);
    let timer: NodeJS.Timeout | undefined;
    try {
      const transfers = this.transfers.drainDevice(target.vaultId, target.deviceId).then(() => true);
      transfers.catch(() => undefined);
      const settled = await Promise.race([
        transfers,
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), Math.max(0, deadline - Date.now()));
          timer.unref();
        })
      ]);
      if (!settled) throw timedOut;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!(await this.lifecycle.drainDeviceLeases(target.vaultId, target.deviceId, Math.max(0, deadline - Date.now())))) throw timedOut;
  }

  private async selectForStep(target: Target): Promise<Selected & { job: DeviceRemovalJob }> {
    const selected = await this.store.read((db): Selected | null => {
      const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
      const vault = db.vaults.find((candidate) => candidate.vault_id === target.vaultId);
      const device = db.devices.find((candidate) => candidate.device_id === target.deviceId && candidate.vault_id === target.vaultId);
      if (!job || !vault || !device || hasDurableDeletionRecord(db, target.vaultId)) return null;
      return {
        vaultStatus: vault.status,
        currentMain: vault.current_main,
        deviceRef: device.device_ref,
        deviceRefHead: device.device_ref_head,
        openConflict: db.conflicts.some((conflict) =>
          conflict.vault_id === target.vaultId && conflict.device_id === target.deviceId && conflict.status === 'open'),
        unsettledOperation: db.sync_operations.some((operation) =>
          operation.vault_id === target.vaultId && operation.device_id === target.deviceId &&
          (operation.status === 'started' || operation.status === 'prepared')),
        job
      };
    }) as Selected | null;
    if (selected === null) throw new RemovalSuperseded();
    return selected as Selected & { job: DeviceRemovalJob };
  }

  /**
   * Runs under the vault sync lock. Every attempt strictly re-reads the ref and either deletes it with
   * a compare-and-swap on the OID this generation durably expects, or starts a new generation with the
   * newly observed OID (never rebinding silently) and re-checks eligibility against it.
   */
  private async deleteRefStep(target: Target): Promise<void> {
    let moves = 0;
    for (;;) {
      const selected = await this.selectForStep(target);
      let job = selected.job;
      const current = await this.readRef(target, selected);
      // Cleanup erases the device's staged transfers, so every path that proceeds to it re-applies the
      // staged-transfer gate with the grant of the current request (persisted on the journal).
      if (job.phase === 'cleanup' && current === null) {
        await this.assertStagedCovered(target, selected.currentMain, job.discard_unmerged);
        return;
      }
      if (job.phase === 'ref_deleting' && current === null) {
        // This attempt durably entered the delete and a strict read proves the ref is gone.
        await this.assertStagedCovered(target, selected.currentMain, job.discard_unmerged);
        await this.updateJob(target, (candidate) => { candidate.phase = 'cleanup'; return true; });
        return;
      }
      if (job.phase === 'cleanup' || current !== job.expected_ref_oid) {
        if (job.phase === 'intent' && current === null) {
          // A recorded OID whose ref is now (strictly verified) absent. Only the owner's discard phrase on
          // this request accepts "nothing to delete"; that decision is recorded durably before cleanup.
          this.assertNoOpenWork(selected);
          if (!job.discard_unmerged) {
            throw new RemovalFailure(409, 'device_ref_inconsistent', staleRefMessage, false, REF_MISSING_DETAILS);
          }
          await this.updateJob(target, (candidate) => {
            candidate.generation += 1;
            candidate.expected_ref_oid = null;
            candidate.phase = 'cleanup';
            return true;
          });
          return;
        }
        if (++moves > MAX_GENERATIONS_PER_RUN) {
          throw new RemovalFailure(503, 'device_removal_incomplete', 'The device ref keeps changing. Retry later.', true);
        }
        job = await this.updateJob(target, (candidate) => {
          candidate.generation += 1;
          candidate.expected_ref_oid = current;
          candidate.phase = 'intent';
          return true;
        });
      }
      if (job.phase === 'intent') {
        this.assertNoOpenWork(selected);
        if (current !== null) await this.assertCovered(target, selected.currentMain, current, job.discard_unmerged);
        await this.assertStagedCovered(target, selected.currentMain, job.discard_unmerged);
        if (current === null) {
          await this.updateJob(target, (candidate) => { candidate.phase = 'cleanup'; return true; });
          return;
        }
        job = await this.updateJob(target, (candidate) => { candidate.phase = 'ref_deleting'; return true; });
      } else if (current !== null) {
        // Resuming a delete that was already durably entered: the grant of this request still decides.
        await this.assertCovered(target, selected.currentMain, current, job.discard_unmerged);
        await this.assertStagedCovered(target, selected.currentMain, job.discard_unmerged);
      }
      await this.checkpoint('before_ref_delete', target);
      const outcome = await this.git.deleteRefCas(target.vaultId, selected.deviceRef, job.expected_ref_oid!);
      if (outcome === 'moved') continue;
      await this.updateJob(target, (candidate) => { candidate.phase = 'cleanup'; return true; });
      await this.checkpoint('after_ref_delete', target);
      return;
    }
  }

  private async sweep(target: Target, apply: (db: MetadataDb, removedConnections: Set<string>) => void, ownsConnections = false): Promise<void> {
    await this.store.mutateDurably((db) => {
      const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
      if (job === undefined || job.phase !== 'cleanup') throw new RemovalSuperseded();
      const removed = new Set<string>();
      if (ownsConnections) {
        for (const connection of db.connections) {
          if (connection.created_device_id === target.deviceId) removed.add(connection.connection_id);
        }
      }
      apply(db, removed);
    });
  }

  private async cleanupAndComplete(target: Target): Promise<void> {
    await this.sweep(target, (db) => {
      db.tokens = db.tokens.filter((token) => token.device_id !== target.deviceId);
    });
    await this.checkpoint('after_credentials', target);
    await this.sweep(target, (db, removed) => {
      db.connections = db.connections.filter((connection) => !removed.has(connection.connection_id));
      db.diagnostic_events = db.diagnostic_events.filter((event) => event.connection_id === null || !removed.has(event.connection_id));
    }, true);
    await this.checkpoint('after_replay', target);
    await this.transfers.eraseDeviceResidue(target.vaultId, target.deviceId);
    await this.checkpoint('after_transfer_residue', target);
    await this.sweep(target, (db) => {
      db.diagnostic_events = db.diagnostic_events.filter((event) => event.device_id !== target.deviceId);
      db.directory_proposal_results = db.directory_proposal_results.filter((result) => result.device_id !== target.deviceId);
    });
    await this.checkpoint('after_bookkeeping', target);
    await this.store.mutateDurably((db) => {
      const job = db.device_removal_jobs.find((candidate) => candidate.device_id === target.deviceId);
      if (job === undefined || job.phase !== 'cleanup') throw new RemovalSuperseded();
      const connectionIds = new Set(db.connections
        .filter((connection) => connection.created_device_id === target.deviceId)
        .map((connection) => connection.connection_id));
      db.tokens = db.tokens.filter((token) => token.device_id !== target.deviceId);
      db.connections = db.connections.filter((connection) => !connectionIds.has(connection.connection_id));
      db.diagnostic_events = db.diagnostic_events.filter((event) =>
        event.device_id !== target.deviceId && (event.connection_id === null || !connectionIds.has(event.connection_id)));
      db.directory_proposal_results = db.directory_proposal_results.filter((result) => result.device_id !== target.deviceId);
      db.devices = db.devices.filter((device) => device.device_id !== target.deviceId);
      db.device_removal_jobs = db.device_removal_jobs.filter((candidate) => candidate.device_id !== target.deviceId);
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: target.ownerUserId,
        actor_device_id: null,
        vault_id: target.vaultId,
        action: 'device_removed',
        resource_class: 'device',
        resource_id: target.deviceId,
        created_at: nowIso()
      });
    });
    this.lifecycle.releaseDeviceBarrier(target.vaultId, target.deviceId);
  }
}
