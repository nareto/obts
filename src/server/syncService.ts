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

  async resumePendingMerges(): Promise<void> {
    const db = await this.store.snapshot();
    const candidates = db.sync_operations
      .filter((operation) => {
        return (
          operation.operation_type === 'device_push' &&
          operation.status === 'committed' &&
          operation.device_id !== null &&
          typeof operation.target_commit === 'string'
        );
      })
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.operation_id.localeCompare(right.operation_id));

    for (const operation of candidates) {
      await this.withVaultLock(operation.vault_id, async () => {
        const currentDb = await this.store.snapshot();
        const vault = currentDb.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
        const device = currentDb.devices.find((candidate) => candidate.device_id === operation.device_id);
        if (
          !vault ||
          vault.status === 'blocked_integrity' ||
          !device ||
          device.status === 'revoked' ||
          device.status === 'review_needed' ||
          device.status === 'blocked_recovery' ||
          device.device_ref_head !== operation.target_commit
        ) {
          return;
        }
        if (await this.findOpenConflict(vault.vault_id, device.device_id, operation.target_commit!)) {
          return;
        }
        const main = await this.git.getRef(vault.vault_id, 'refs/heads/main');
        if (!main || (await this.git.isAncestor(vault.vault_id, operation.target_commit!, main))) {
          return;
        }
        await this.mergeDeviceCommit(
          vault.vault_id,
          device.device_id,
          operation.target_commit!,
          this.latestEventSeq(vault.vault_id, currentDb)
        );
      });
    }
  }

  async pushDeviceCommit(
    auth: AuthenticatedDevice,
    manifest: DevicePushManifest,
    packfile: Buffer
  ): Promise<PushResult> {
    if (auth.vault.status === 'blocked_integrity') {
      return {
        status: 'rejected',
        code: 'blocked_integrity',
        message: 'Vault persistent state failed integrity checks.'
      };
    }
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
        const deviceBlock = await this.deviceBlockRejection(auth.device.device_id);
        if (deviceBlock?.deviceStatus === 'blocked_recovery') {
          return await this.rejectDevicePush(auth, operation.operation_id, deviceBlock.code, deviceBlock.message);
        }
        if (currentDeviceRef === manifest.target_commit) {
          return await this.finishExistingDeviceCommit(auth, operation, manifest.target_commit);
        }
        if ((manifest.expected_device_ref ?? null) !== currentDeviceRef) {
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            'stale_device_ref',
            'Device ref changed before this upload.'
          );
        }
        if (deviceBlock) {
          return await this.rejectDevicePush(auth, operation.operation_id, deviceBlock.code, deviceBlock.message);
        }

        try {
          await this.git.importPack(auth.vault.vault_id, packfile);
        } catch (error) {
          return await this.rejectDevicePush(auth, operation.operation_id, 'malformed_packfile', 'Malformed Git packfile.');
        }
        if (!(await this.git.commitExists(auth.vault.vault_id, manifest.target_commit))) {
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            'missing_target_commit',
            'Target commit is not present.'
          );
        }
        try {
          await this.git.validateTreePathPolicy(auth.vault.vault_id, manifest.target_commit, this.maxUploadBytes);
        } catch (error) {
          const code = error instanceof PathPolicyViolation ? error.code : 'path_policy_rejected';
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            code,
            'Uploaded commit violates the vault path policy.'
          );
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
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            code,
            'Uploaded commit changes paths outside the device sync profile.'
          );
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
      const identityMerge = await this.tryIdentityOverlappingMerge(vaultId, deviceId, base, main, deviceCommit, deviceChanges, overlapping);
      if (identityMerge) {
        return identityMerge;
      }
      const cleanMerge = await this.tryCleanOverlappingMerge(vaultId, deviceId, base, main, deviceCommit, deviceChanges, overlapping);
      if (cleanMerge) {
        return cleanMerge;
      }
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
      mergeCommit = await this.git.createOverlayMergeCommitObject(
        vaultId,
        base,
        main,
        deviceCommit,
        deviceChanges,
        mergePreparation.mergeSequence
      );
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, main);
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

  private async tryIdentityOverlappingMerge(
    vaultId: string,
    deviceId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    overlapping: string[]
  ): Promise<PushResult | null> {
    for (const path of overlapping) {
      const currentContent = await this.readOptionalBlob(vaultId, currentMain, path);
      const deviceContent = await this.readOptionalBlob(vaultId, deviceCommit, path);
      if (currentContent === null && deviceContent === null) {
        continue;
      }
      if (currentContent === null || deviceContent === null || !currentContent.equals(deviceContent)) {
        return null;
      }
    }

    const mergePreparation = await this.store.mutate((db) => {
      const device = requireDevice(db, deviceId);
      const mergeSequence = this.store.nextMergeSequence(db, vaultId);
      const operation = this.store.startOperation(db, {
        vault_id: vaultId,
        device_id: deviceId,
        operation_type: 'server_merge',
        expected_refs: {
          'refs/heads/main': currentMain,
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
        current_main: currentMain,
        device_commit: deviceCommit,
        decision: 'merge',
        validator_results: {
          identity_only_merge: 'ok',
          overlapping_path_count: overlapping.length
        }
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });

    let mergeCommit: string;
    try {
      mergeCommit = await this.git.createOverlayMergeCommitObject(
        vaultId,
        base,
        currentMain,
        deviceCommit,
        deviceChanges,
        mergePreparation.mergeSequence
      );
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, currentMain);
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
      const event = this.store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: vaultId,
        resource_ids: {
          device_id: deviceId
        },
        commit_cursors: {
          previous_main: currentMain,
          main: mergeCommit,
          device_commit: deviceCommit
        },
        payload: {
          decision: 'merged',
          merge_sequence: mergePreparation.mergeSequence,
          merge_policy_version: MERGE_POLICY_VERSION,
          base_commit: base,
          current_main: currentMain,
          device_commit: deviceCommit,
          validator_results: {
            identity_only_merge: 'ok',
            overlapping_path_count: overlapping.length
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

  private async readOptionalBlob(vaultId: string, commit: string, path: string): Promise<Buffer | null> {
    try {
      return await this.git.readBlobAtPath(vaultId, commit, path);
    } catch {
      return null;
    }
  }

  private async tryCleanOverlappingMerge(
    vaultId: string,
    deviceId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    overlapping: string[]
  ): Promise<PushResult | null> {
    if (!overlapping.every(isNativeTextMergePath)) {
      return null;
    }

    const mergeTree = await this.git.tryPolicyMergeTree(vaultId, base, currentMain, deviceCommit, deviceChanges, overlapping);
    if (!mergeTree) {
      return null;
    }

    const mergePreparation = await this.store.mutate((db) => {
      const device = requireDevice(db, deviceId);
      const mergeSequence = this.store.nextMergeSequence(db, vaultId);
      const operation = this.store.startOperation(db, {
        vault_id: vaultId,
        device_id: deviceId,
        operation_type: 'server_merge',
        expected_refs: {
          'refs/heads/main': currentMain,
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
        current_main: currentMain,
        device_commit: deviceCommit,
        decision: 'merge',
        validator_results: mergeTree.validatorResults
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });

    let mergeCommit: string;
    try {
      mergeCommit = await this.git.createMergeCommitObjectFromTree({
        vaultId,
        tree: mergeTree.tree,
        base,
        currentMain,
        deviceCommit,
        mergeSequence: mergePreparation.mergeSequence,
        strategy: mergeTree.validatorResults.semantic_merge === 'clean' ? 'semantic_clean' : 'native_clean'
      });
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, currentMain);
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
      const event = this.store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: vaultId,
        resource_ids: {
          device_id: deviceId
        },
        commit_cursors: {
          previous_main: currentMain,
          main: mergeCommit,
          device_commit: deviceCommit
        },
        payload: {
          decision: 'merged',
          merge_sequence: mergePreparation.mergeSequence,
          merge_policy_version: MERGE_POLICY_VERSION,
          base_commit: base,
          current_main: currentMain,
          device_commit: deviceCommit,
          validator_results: mergeTree.validatorResults,
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

  private async deviceBlockRejection(
    deviceId: string
  ): Promise<{ code: string; message: string; deviceStatus: DeviceRow['status'] } | null> {
    const db = await this.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === deviceId);
    if (device?.status === 'review_needed') {
      return {
        code: 'device_blocked',
        message: 'Device has an open conflict that requires review.',
        deviceStatus: device.status
      };
    }
    if (device?.status === 'blocked_recovery') {
      return {
        code: 'device_blocked',
        message: 'Device requires recovery before more uploads are accepted.',
        deviceStatus: device.status
      };
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

  private async prepareMergeRefUpdate(operationId: string, mergeCommit: string): Promise<void> {
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      if (operation.status !== 'prepared') {
        throw new Error(`Operation cannot prepare merge ref update from status ${operation.status}.`);
      }
      operation.target_refs = {
        'refs/heads/main': mergeCommit
      };
      operation.target_commit = mergeCommit;
      operation.prepared_manifest = {
        ...(operation.prepared_manifest ?? {}),
        target_refs: {
          'refs/heads/main': mergeCommit
        },
        target_commit: mergeCommit
      };
      operation.updated_at = nowIso();
    });
  }

  private async rejectDevicePush(
    auth: AuthenticatedDevice,
    operationId: string,
    code: string,
    message: string
  ): Promise<PushResult> {
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      if (operation.status !== 'committed') {
        operation.status = 'aborted';
        operation.result = { reason: code };
        operation.updated_at = nowIso();
      }
      const device = requireDevice(db, auth.device.device_id);
      device.last_seen_at = nowIso();
      const vault = requireVault(db, auth.vault.vault_id);
      this.store.appendEvent(db, {
        event_type: 'device_sync_rejected',
        vault_id: auth.vault.vault_id,
        resource_ids: { device_id: auth.device.device_id },
        commit_cursors: {
          main: vault.current_main,
          device_ref: device.device_ref_head
        },
        payload: {
          reason: code
        }
      });
    });
    return { status: 'rejected', code, message };
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
  const leftPaths = [...changedPathSet(left)];
  const rightPaths = [...changedPathSet(right)];
  const result = new Set<string>();
  for (const leftPath of leftPaths) {
    for (const rightPath of rightPaths) {
      if (changedPathsConflict(leftPath, rightPath)) {
        result.add(leftPath);
        result.add(rightPath);
      }
    }
  }
  return [...result].sort();
}

function changedPathsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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

function isNativeTextMergePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.canvas') || path.endsWith('.base');
}

function deviceSyncPathPolicy(device: DeviceRow): SyncPathPolicy {
  return {
    profile: device.sync_profile,
    syncPlugins: device.sync_plugins,
    attachmentLocation: { mode: 'same_folder_as_note' }
  };
}
