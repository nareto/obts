import { newId, nowIso } from '../shared/ids.js';
import { assertChangedPathsAllowedByPolicy, PathPolicyViolation, type SyncPathPolicy } from '../shared/pathPolicy.js';
import type { ConflictRecord, DevicePushManifest, PushResult } from '../shared/types.js';
import type { AuthenticatedDevice } from './authService.js';
import { GitCommandError, GitService, sha256Hex, type GitDiffEntry } from './gitService.js';
import type { DeviceRow, MetadataDb, MetadataStore, SyncOperationRow } from './metadataStore.js';

const MERGE_POLICY_VERSION = 'phase1.disjoint-paths.v1';

export class SyncService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: MetadataStore,
    private readonly git: GitService,
    private readonly maxUploadBytes: number
  ) {}

  async pushDeviceCommit(
    auth: AuthenticatedDevice,
    manifest: DevicePushManifest,
    packfile: Buffer
  ): Promise<PushResult> {
    if (manifest.vault_id !== auth.vault.vault_id || manifest.device_id !== auth.device.device_id) {
      return { status: 'rejected', code: 'not_found', message: 'Resource not found.' };
    }
    if (manifest.packfile_bytes !== packfile.byteLength || packfile.byteLength > this.maxUploadBytes) {
      return { status: 'rejected', code: 'invalid_packfile', message: 'Packfile size does not match the manifest.' };
    }
    if (sha256Hex(packfile) !== manifest.packfile_sha256) {
      return { status: 'rejected', code: 'invalid_packfile', message: 'Packfile digest does not match the manifest.' };
    }

    return await this.withVaultLock(auth.vault.vault_id, async () => {
      let operationId: string | null = null;
      try {
        const operation = await this.store.mutate((db) => {
          const device = requireDevice(db, auth.device.device_id);
          return this.store.startOperation(db, {
            vault_id: auth.vault.vault_id,
            device_id: device.device_id,
            operation_type: 'device_push',
            expected_refs: {
              [device.device_ref]: manifest.expected_device_ref
            },
            target_refs: {
              [device.device_ref]: manifest.target_commit
            },
            target_commit: manifest.target_commit
          });
        });
        operationId = operation.operation_id;

        const currentDeviceRef = await this.git.getRef(auth.vault.vault_id, auth.device.device_ref);
        if (currentDeviceRef === manifest.target_commit) {
          return await this.finishExistingDeviceCommit(auth, operation, manifest.target_commit);
        }
        if ((manifest.expected_device_ref ?? null) !== currentDeviceRef) {
          await this.abortOperation(operation.operation_id, 'stale_device_ref');
          return { status: 'rejected', code: 'stale_device_ref', message: 'Device ref changed before this upload.' };
        }
        const deviceBlock = await this.deviceBlockRejection(auth.device.device_id);
        if (deviceBlock) {
          await this.abortOperation(operation.operation_id, deviceBlock.code);
          return { status: 'rejected', code: deviceBlock.code, message: deviceBlock.message };
        }

        try {
          await this.git.importPack(auth.vault.vault_id, packfile);
        } catch (error) {
          await this.abortOperation(operation.operation_id, 'malformed_packfile');
          return { status: 'rejected', code: 'malformed_packfile', message: 'Malformed Git packfile.' };
        }
        if (!(await this.git.commitExists(auth.vault.vault_id, manifest.target_commit))) {
          await this.abortOperation(operation.operation_id, 'missing_target_commit');
          return { status: 'rejected', code: 'missing_target_commit', message: 'Target commit is not present.' };
        }
        try {
          await this.git.validateTreePathPolicy(auth.vault.vault_id, manifest.target_commit);
        } catch (error) {
          const code = error instanceof PathPolicyViolation ? error.code : 'path_policy_rejected';
          await this.abortOperation(operation.operation_id, code);
          return { status: 'rejected', code, message: 'Uploaded commit violates the vault path policy.' };
        }
        if (currentDeviceRef && !(await this.git.isAncestor(auth.vault.vault_id, currentDeviceRef, manifest.target_commit))) {
          return await this.blockDeviceForRecovery(auth, operation, currentDeviceRef, manifest.target_commit);
        }
        try {
          const changedPaths = await this.changedPathsForUploadPolicy(
            auth.vault.vault_id,
            currentDeviceRef,
            manifest.target_commit,
            manifest.client_known_main
          );
          assertChangedPathsAllowedByPolicy(changedPaths, deviceSyncPathPolicy(auth.device));
        } catch (error) {
          const code = error instanceof PathPolicyViolation ? error.code : 'path_policy_rejected';
          await this.abortOperation(operation.operation_id, code);
          return { status: 'rejected', code, message: 'Uploaded commit changes paths outside the device sync profile.' };
        }

        await this.store.mutate((db) => {
          const op = requireOperation(db, operation.operation_id);
          op.status = 'prepared';
          op.prepared_manifest = {
            actor: { user_id: auth.user.user_id, device_id: auth.device.device_id },
            operation_type: 'device_push',
            expected_device_ref: currentDeviceRef,
            target_commit: manifest.target_commit,
            validation: {
              object_integrity: 'ok',
              path_policy: 'ok',
              changed_path_policy: 'ok',
              fast_forward: 'ok'
            }
          };
          op.updated_at = nowIso();
        });

        await this.git.updateRef(auth.vault.vault_id, auth.device.device_ref, manifest.target_commit, currentDeviceRef);

        const refEventSeq = await this.store.mutate((db) => {
          const op = requireOperation(db, operation.operation_id);
          op.status = 'committed';
          op.result = { device_ref: manifest.target_commit };
          op.updated_at = nowIso();
          const device = requireDevice(db, auth.device.device_id);
          device.device_ref_head = manifest.target_commit;
          device.status = 'ahead';
          device.last_seen_at = nowIso();
          const event = this.store.appendEvent(db, {
            event_type: 'device_ref_updated',
            vault_id: auth.vault.vault_id,
            resource_ids: { device_id: auth.device.device_id },
            commit_cursors: {
              device_ref: manifest.target_commit,
              main: requireVault(db, auth.vault.vault_id).current_main
            },
            payload: {
              device_id: auth.device.device_id
            }
          });
          return event.event_seq;
        });

        return await this.mergeDeviceCommit(auth.vault.vault_id, auth.device.device_id, manifest.target_commit, refEventSeq);
      } catch (error) {
        if (operationId) {
          await this.abortOperation(operationId, 'unexpected_error');
        }
        if (error instanceof GitCommandError) {
          return { status: 'rejected', code: 'git_error', message: 'Git operation failed.' };
        }
        throw error;
      }
    });
  }

  private async finishExistingDeviceCommit(
    auth: AuthenticatedDevice,
    operation: SyncOperationRow,
    targetCommit: string
  ): Promise<PushResult> {
    const main = await this.git.getRef(auth.vault.vault_id, 'refs/heads/main');
    if (!main) {
      await this.abortOperation(operation.operation_id, 'missing_main');
      return { status: 'rejected', code: 'missing_main', message: 'Server main is missing.' };
    }
    const existingConflict = await this.findOpenConflict(auth.vault.vault_id, auth.device.device_id, targetCommit);
    const fallbackEventSeq = this.latestEventSeq(auth.vault.vault_id, await this.store.snapshot());
    await this.store.mutate((db) => {
      const op = requireOperation(db, operation.operation_id);
      op.status = 'committed';
      op.result = { idempotent: true, target_commit: targetCommit };
      op.updated_at = nowIso();
    });
    if (existingConflict) {
      return {
        status: 'conflicted',
        conflict_id: existingConflict.conflict_id,
        device_ref: targetCommit,
        main,
        event_seq: fallbackEventSeq
      };
    }
    if (!(await this.git.isAncestor(auth.vault.vault_id, targetCommit, main))) {
      return await this.mergeDeviceCommit(auth.vault.vault_id, auth.device.device_id, targetCommit, fallbackEventSeq);
    }
    return {
      status: 'noop',
      device_ref: targetCommit,
      main,
      event_seq: fallbackEventSeq
    };
  }

  private async changedPathsForUploadPolicy(
    vaultId: string,
    currentDeviceRef: string | null,
    targetCommit: string,
    clientKnownMain: string | null
  ): Promise<string[]> {
    const currentMain = await this.git.getRef(vaultId, 'refs/heads/main');
    let base = currentDeviceRef;
    if (
      base === null &&
      clientKnownMain &&
      currentMain &&
      clientKnownMain !== targetCommit &&
      (await this.git.commitExists(vaultId, clientKnownMain)) &&
      (await this.git.isAncestor(vaultId, clientKnownMain, targetCommit)) &&
      (await this.git.isAncestor(vaultId, clientKnownMain, currentMain))
    ) {
      base = clientKnownMain;
    }
    if (!base) {
      return await this.git.listTreePaths(vaultId, targetCommit);
    }
    return [...changedPathSet(await this.git.changedPaths(vaultId, base, targetCommit))].sort();
  }

  private async mergeDeviceCommit(
    vaultId: string,
    deviceId: string,
    deviceCommit: string,
    fallbackEventSeq: number
  ): Promise<PushResult> {
    const main = await this.git.getRef(vaultId, 'refs/heads/main');
    if (!main) {
      return { status: 'rejected', code: 'missing_main', message: 'Server main is missing.' };
    }
    if (await this.git.isAncestor(vaultId, deviceCommit, main)) {
      const eventSeq = await this.store.mutate((db) => {
        const device = requireDevice(db, deviceId);
        device.status = 'synced';
        device.last_successful_sync_at = nowIso();
        return this.latestEventSeq(vaultId, db);
      });
      return { status: 'noop', device_ref: deviceCommit, main, event_seq: eventSeq || fallbackEventSeq };
    }

    const existingConflict = await this.findOpenConflict(vaultId, deviceId, deviceCommit);
    if (existingConflict) {
      return {
        status: 'conflicted',
        conflict_id: existingConflict.conflict_id,
        device_ref: deviceCommit,
        main,
        event_seq: this.latestEventSeq(vaultId, await this.store.snapshot()) || fallbackEventSeq
      };
    }

    const base = await this.git.mergeBase(vaultId, main, deviceCommit);
    if (!base) {
      return await this.createConflict(vaultId, deviceId, '', main, deviceCommit, [], 'no_merge_base');
    }

    const mainChanges = await this.git.changedPaths(vaultId, base, main);
    const deviceChanges = await this.git.changedPaths(vaultId, base, deviceCommit);
    const overlapping = intersectChangedPaths(mainChanges, deviceChanges);
    if (overlapping.length > 0) {
      return await this.createConflict(vaultId, deviceId, base, main, deviceCommit, overlapping, 'overlapping_paths');
    }

    const mergePreparation = await this.store.mutate((db) => {
      const device = requireDevice(db, deviceId);
      const mergeSequence = this.store.nextMergeSequence(db, vaultId);
      const operation = this.store.startOperation(db, {
        vault_id: vaultId,
        device_id: deviceId,
        operation_type: 'server_merge',
        expected_refs: {
          'refs/heads/main': main,
          [device.device_ref]: deviceCommit
        },
        target_refs: {
          'refs/heads/main': null
        },
        target_commit: null
      });
      operation.status = 'prepared';
      operation.prepared_manifest = {
        merge_sequence: mergeSequence,
        merge_policy_version: MERGE_POLICY_VERSION,
        base_commit: base,
        current_main: main,
        device_commit: deviceCommit,
        decision: 'merge',
        validator_results: {
          disjoint_paths: 'ok',
          overlapping_path_count: 0
        }
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });
    let mergeCommit: string;
    try {
      mergeCommit = await this.git.createOverlayMergeCommit(
        vaultId,
        base,
        main,
        deviceCommit,
        deviceChanges,
        mergePreparation.mergeSequence
      );
    } catch (error) {
      await this.abortOperation(mergePreparation.operationId, 'merge_git_error');
      throw error;
    }
    const eventSeq = await this.store.mutate((db) => {
      const operation = requireOperation(db, mergePreparation.operationId);
      operation.status = 'committed';
      operation.target_refs = {
        'refs/heads/main': mergeCommit
      };
      operation.target_commit = mergeCommit;
      operation.result = {
        decision: 'merged',
        merge_commit: mergeCommit
      };
      operation.updated_at = nowIso();
      const vault = requireVault(db, vaultId);
      const device = requireDevice(db, deviceId);
      vault.current_main = mergeCommit;
      vault.updated_at = nowIso();
      device.status = 'synced';
      device.last_successful_sync_at = nowIso();
      const event = this.store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: vaultId,
        resource_ids: {
          device_id: deviceId
        },
        commit_cursors: {
          previous_main: main,
          main: mergeCommit,
          device_commit: deviceCommit
        },
        payload: {
          decision: 'merged',
          merge_sequence: mergePreparation.mergeSequence,
          merge_policy_version: MERGE_POLICY_VERSION,
          base_commit: base,
          current_main: main,
          device_commit: deviceCommit,
          validator_results: {
            disjoint_paths: 'ok',
            overlapping_path_count: 0
          },
          changed_path_count: changedPathSet(deviceChanges).size
        }
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: device.user_id,
        actor_device_id: deviceId,
        vault_id: vaultId,
        action: 'main_advanced',
        resource_class: 'vault',
        resource_id: vaultId,
        created_at: nowIso()
      });
      return event.event_seq;
    });
    return {
      status: 'merged',
      device_ref: deviceCommit,
      main: mergeCommit,
      merge_commit: mergeCommit,
      event_seq: eventSeq
    };
  }

  private async createConflict(
    vaultId: string,
    deviceId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    affectedPaths: string[],
    reason: string
  ): Promise<PushResult> {
    const conflictId = newId('conf');
    const mergeSequence = await this.store.mutate((db) => this.store.nextMergeSequence(db, vaultId));
    const eventSeq = await this.store.mutate((db) => {
      const device = requireDevice(db, deviceId);
      const operation = this.store.startOperation(db, {
        vault_id: vaultId,
        device_id: deviceId,
        operation_type: 'conflict_create',
        expected_refs: {
          'refs/heads/main': currentMain,
          [device.device_ref]: deviceCommit
        },
        target_refs: {},
        target_commit: deviceCommit
      });
      operation.status = 'committed';
      operation.prepared_manifest = {
        merge_sequence: mergeSequence,
        merge_policy_version: MERGE_POLICY_VERSION,
        base_commit: base,
        current_main: currentMain,
        device_commit: deviceCommit,
        decision: 'conflict',
        validator_results: {
          reason,
          affected_paths: affectedPaths
        }
      };
      operation.result = {
        decision: 'conflict',
        conflict_id: conflictId
      };
      operation.updated_at = nowIso();
      const conflict: ConflictRecord = {
        conflict_id: conflictId,
        vault_id: vaultId,
        device_id: deviceId,
        status: 'open',
        base_commit: base,
        current_main: currentMain,
        device_commit: deviceCommit,
        expected_main: currentMain,
        affected_paths: affectedPaths,
        affected_path_count: affectedPaths.length,
        merge_sequence: mergeSequence,
        merge_policy_version: MERGE_POLICY_VERSION,
        validator_summary: {
          decision: 'conflict',
          reason,
          path_count: affectedPaths.length
        },
        created_at: nowIso()
      };
      db.conflicts.push(conflict);
      device.status = 'review_needed';
      const event = this.store.appendEvent(db, {
        event_type: 'conflict_created',
        vault_id: vaultId,
        resource_ids: {
          conflict_id: conflictId,
          device_id: deviceId
        },
        commit_cursors: {
          main: currentMain,
          device_commit: deviceCommit,
          base
        },
        payload: {
          reason,
          path_count: affectedPaths.length,
          merge_sequence: mergeSequence,
          merge_policy_version: MERGE_POLICY_VERSION
        }
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: device.user_id,
        actor_device_id: deviceId,
        vault_id: vaultId,
        action: 'conflict_created',
        resource_class: 'conflict',
        resource_id: conflictId,
        created_at: nowIso()
      });
      return event.event_seq;
    });
    return {
      status: 'conflicted',
      conflict_id: conflictId,
      device_ref: deviceCommit,
      main: currentMain,
      event_seq: eventSeq
    };
  }

  private async blockDeviceForRecovery(
    auth: AuthenticatedDevice,
    operation: SyncOperationRow,
    currentDeviceRef: string,
    targetCommit: string
  ): Promise<PushResult> {
    await this.store.mutate((db) => {
      const op = requireOperation(db, operation.operation_id);
      op.status = 'committed';
      op.result = {
        rejected: 'same_device_non_fast_forward',
        current_device_ref: currentDeviceRef,
        target_commit: targetCommit
      };
      op.updated_at = nowIso();
      const device = requireDevice(db, auth.device.device_id);
      device.status = 'blocked_recovery';
      this.store.appendEvent(db, {
        event_type: 'device_recovery_required',
        vault_id: auth.vault.vault_id,
        resource_ids: { device_id: auth.device.device_id },
        commit_cursors: {
          current_device_ref: currentDeviceRef,
          rejected_commit: targetCommit
        },
        payload: {
          reason: 'same_device_non_fast_forward'
        }
      });
      db.audit_log.push({
        audit_id: newId('aud'),
        actor_user_id: auth.user.user_id,
        actor_device_id: auth.device.device_id,
        vault_id: auth.vault.vault_id,
        action: 'device_recovery_required',
        resource_class: 'device',
        resource_id: auth.device.device_id,
        created_at: nowIso()
      });
    });
    return {
      status: 'rejected',
      code: 'same_device_non_fast_forward',
      message: 'Same-device non-fast-forward history requires recovery.'
    };
  }

  private async findOpenConflict(vaultId: string, deviceId: string, deviceCommit: string): Promise<ConflictRecord | null> {
    const db = await this.store.snapshot();
    return (
      db.conflicts.find(
        (conflict) =>
          conflict.vault_id === vaultId &&
          conflict.device_id === deviceId &&
          conflict.device_commit === deviceCommit &&
          conflict.status === 'open'
      ) ?? null
    );
  }

  private async deviceBlockRejection(deviceId: string): Promise<{ code: string; message: string } | null> {
    const db = await this.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === deviceId);
    if (device?.status === 'review_needed') {
      return { code: 'device_blocked', message: 'Device has an open conflict that requires review.' };
    }
    if (device?.status === 'blocked_recovery') {
      return { code: 'device_blocked', message: 'Device requires recovery before more uploads are accepted.' };
    }
    return null;
  }

  private latestEventSeq(vaultId: string, db: MetadataDb): number {
    return db.event_seq_by_vault[vaultId] ?? 0;
  }

  private async abortOperation(operationId: string, reason: string): Promise<void> {
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      if (operation.status !== 'committed') {
        operation.status = 'aborted';
        operation.result = { reason };
        operation.updated_at = nowIso();
      }
    });
  }

  private async withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(vaultId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => next);
    this.locks.set(vaultId, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(vaultId) === chained) {
        this.locks.delete(vaultId);
      }
    }
  }
}

function requireVault(db: MetadataDb, vaultId: string) {
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  if (!vault) {
    throw new Error(`Vault not found: ${vaultId}`);
  }
  return vault;
}

function requireDevice(db: MetadataDb, deviceId: string): DeviceRow {
  const device = db.devices.find((candidate) => candidate.device_id === deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }
  return device;
}

function requireOperation(db: MetadataDb, operationId: string): SyncOperationRow {
  const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
  if (!operation) {
    throw new Error(`Operation not found: ${operationId}`);
  }
  return operation;
}

function intersectChangedPaths(left: GitDiffEntry[], right: GitDiffEntry[]): string[] {
  const leftPaths = changedPathSet(left);
  const result = new Set<string>();
  for (const path of changedPathSet(right)) {
    if (leftPaths.has(path)) {
      result.add(path);
    }
  }
  return [...result].sort();
}

function changedPathSet(entries: GitDiffEntry[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.oldPath) {
      paths.add(entry.oldPath);
    }
  }
  return paths;
}

function deviceSyncPathPolicy(device: DeviceRow): SyncPathPolicy {
  return {
    profile: device.sync_profile,
    syncPlugins: device.sync_plugins,
    attachmentLocation: { mode: 'same_folder_as_note' }
  };
}
