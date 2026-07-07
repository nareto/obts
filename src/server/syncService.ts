import { posix } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import { assertSyncableTreePaths, PathPolicyViolation } from '../shared/pathPolicy.js';
import type {
  ConflictRecord,
  ConflictResolutionKind,
  ConflictReviewFile,
  ConflictReviewPackage,
  DevicePushManifest,
  PushResult,
  ResolveConflictResponse
} from '../shared/types.js';
import { AuthError, type AuthenticatedDevice } from './authService.js';
import { GitCommandError, GitService, sha256Hex, type GitDiffEntry } from './gitService.js';
import type { DeviceRow, MetadataDb, MetadataStore, SyncOperationRow } from './metadataStore.js';

const MERGE_POLICY_VERSION = 'phase2.semantic-merge.v1';
const SIMILAR_RENAME_THRESHOLD = 0.72;
const SIMILAR_RENAME_MAX_BYTES = 256 * 1024;

type RenameConfidence = 'git' | 'exact_blob' | 'similar_content';

type StructuralActionKind = 'add' | 'edit' | 'delete' | 'rename';

type StructuralAction = {
  kind: StructuralActionKind;
  basePath: string | null;
  targetPath: string | null;
  baseOid: string | null;
  targetOid: string | null;
  renameConfidence: RenameConfidence | null;
};

type StructuralSummary = {
  actions: StructuralAction[];
  byBasePath: Map<string, StructuralAction>;
  addsByPath: Map<string, StructuralAction>;
  renameCandidatesByBasePath: Map<string, Set<string>>;
};

type StructuralConflict = {
  reason: string;
  affectedPaths: string[];
};

type RenamePair = {
  basePath: string;
  targetPath: string;
  confidence: RenameConfidence;
};

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
        const currentMain = await this.git.getRef(auth.vault.vault_id, 'refs/heads/main');
        if (!currentMain) {
          return await this.rejectDevicePush(auth, operation.operation_id, 'missing_main', 'Server main is missing.');
        }
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

        const quarantineResult = await this.validateQuarantinedUpload(
          auth,
          operation,
          manifest,
          packfile,
          currentDeviceRef,
          currentMain
        );
        if (quarantineResult !== null) {
          return quarantineResult;
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
              fast_forward: 'ok',
              base_commit: manifest.base_commit ?? null
            }
          };
          op.updated_at = nowIso();
        });

        await this.git.importPack(auth.vault.vault_id, packfile);
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

        return await this.mergeDeviceCommit(
          auth.vault.vault_id,
          auth.device.device_id,
          manifest.target_commit,
          refEventSeq,
          manifest.base_commit ?? null,
          currentDeviceRef === null && manifest.base_commit !== undefined && manifest.base_commit !== null
        );
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

  async getConflictReviewPackage(vaultId: string, conflictId: string): Promise<ConflictReviewPackage> {
    const db = await this.store.snapshot();
    const vault = requireVault(db, vaultId);
    const conflict = db.conflicts.find((candidate) => candidate.vault_id === vaultId && candidate.conflict_id === conflictId);
    if (!conflict) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const device = requireDevice(db, conflict.device_id);
    const files: ConflictReviewFile[] = [];
    for (const path of conflict.affected_paths) {
      const baseContent = await this.readOptionalTextBlob(vaultId, conflict.base_commit, path);
      const serverContent = await this.readOptionalTextBlob(vaultId, conflict.current_main, path);
      const deviceContent = await this.readOptionalTextBlob(vaultId, conflict.device_commit, path);
      files.push({
        path,
        base_content: baseContent,
        server_content: serverContent,
        device_content: deviceContent,
        source_diff: buildSourceDiff(serverContent, deviceContent),
        rendered_markdown_diff: path.endsWith('.md') ? buildMarkdownReview(serverContent, deviceContent) : null
      });
    }
    return {
      conflict,
      stale: conflict.status === 'open' && vault.current_main !== conflict.expected_main,
      expected_main: conflict.expected_main,
      current_main: vault.current_main,
      device_name: device.device_name,
      files,
      choices: ['keep_server', 'use_device', 'keep_both_files', 'insert_both_blocks', 'manual']
    };
  }

  async refreshConflictReviewPackage(input: {
    actorUserId: string;
    vaultId: string;
    conflictId: string;
  }): Promise<ConflictReviewPackage> {
    await this.withVaultLock(input.vaultId, async () => {
      const snapshot = await this.store.snapshot();
      const snapshotVault = requireVault(snapshot, input.vaultId);
      const snapshotConflict = snapshot.conflicts.find(
        (candidate) => candidate.vault_id === input.vaultId && candidate.conflict_id === input.conflictId
      );
      if (!snapshotConflict) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const needsRefresh =
        snapshotConflict.status === 'open' &&
        (snapshotConflict.expected_main !== snapshotVault.current_main || snapshotConflict.current_main !== snapshotVault.current_main);
      const refreshedAffectedPaths = needsRefresh
        ? await this.refreshedAffectedPaths(snapshotConflict, snapshotVault.current_main)
        : snapshotConflict.affected_paths;
      await this.store.mutate((db) => {
        const vault = requireVault(db, input.vaultId);
        const conflict = db.conflicts.find(
          (candidate) => candidate.vault_id === input.vaultId && candidate.conflict_id === input.conflictId
        );
        if (!conflict) {
          throw new AuthError(404, 'not_found', 'Resource not found.');
        }
        if (conflict.status !== 'open') {
          return;
        }
        if (conflict.expected_main === vault.current_main && conflict.current_main === vault.current_main) {
          return;
        }
        const previousExpectedMain = conflict.expected_main;
        conflict.current_main = vault.current_main;
        conflict.expected_main = vault.current_main;
        conflict.affected_paths = refreshedAffectedPaths;
        conflict.affected_path_count = refreshedAffectedPaths.length;
        conflict.validator_results = {
          ...conflict.validator_results,
          review_refreshed_from: previousExpectedMain,
          review_refreshed_at: nowIso(),
          affected_paths: refreshedAffectedPaths,
          affected_path_count: refreshedAffectedPaths.length
        };
        conflict.validator_summary = {
          ...conflict.validator_summary,
          stale: false,
          refreshed_from: previousExpectedMain,
          path_count: refreshedAffectedPaths.length
        };
        this.store.appendEvent(db, {
          event_type: 'conflict_review_refreshed',
          vault_id: input.vaultId,
          resource_ids: {
            conflict_id: input.conflictId,
            device_id: conflict.device_id
          },
          commit_cursors: {
            previous_main: previousExpectedMain,
            main: vault.current_main,
            device_commit: conflict.device_commit
          },
          payload: {
            conflict_id: input.conflictId
          }
        });
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: input.actorUserId,
          actor_device_id: null,
          vault_id: input.vaultId,
          action: 'conflict_review_refreshed',
          resource_class: 'conflict',
          resource_id: input.conflictId,
          created_at: nowIso()
        });
      });
    });
    return await this.getConflictReviewPackage(input.vaultId, input.conflictId);
  }

  private async refreshedAffectedPaths(conflict: ConflictRecord, currentMain: string): Promise<string[]> {
    if (
      !(await this.git.commitExists(conflict.vault_id, conflict.base_commit)) ||
      !(await this.git.commitExists(conflict.vault_id, currentMain)) ||
      !(await this.git.commitExists(conflict.vault_id, conflict.device_commit))
    ) {
      return conflict.affected_paths;
    }
    const mainChanges = await this.git.changedPaths(conflict.vault_id, conflict.base_commit, currentMain);
    const deviceChanges = await this.git.changedPaths(conflict.vault_id, conflict.base_commit, conflict.device_commit);
    return [...new Set([...conflict.affected_paths, ...intersectChangedPaths(mainChanges, deviceChanges)])].sort();
  }

  async resolveConflict(input: {
    actorUserId: string;
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
  }): Promise<ResolveConflictResponse> {
    const requestHash = resolutionRequestHash(input);
    return await this.withVaultLock(input.vaultId, async () => {
      const snapshot = await this.store.snapshot();
      const vault = requireVault(snapshot, input.vaultId);
      const conflict = snapshot.conflicts.find(
        (candidate) => candidate.vault_id === input.vaultId && candidate.conflict_id === input.conflictId
      );
      if (!conflict) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      if (conflict.status === 'resolved') {
        if (conflict.resolution_request_hash === requestHash && conflict.resolution_commit) {
          return {
            status: 'resolved',
            conflict_id: conflict.conflict_id,
            main: conflict.resolution_commit,
            resolution_commit: conflict.resolution_commit,
            event_seq: this.latestEventSeq(input.vaultId, snapshot),
            idempotent: true
          };
        }
        throw new AuthError(409, 'conflict_already_resolved', 'Conflict has already been resolved.');
      }
      if (conflict.expected_main !== input.expectedMain || vault.current_main !== input.expectedMain) {
        throw new AuthError(409, 'stale_conflict_review', 'Conflict review is stale; refresh before resolving.');
      }

      const tree = await this.buildResolutionTree(conflict, input.resolutionKind, input.manualFiles);
      await this.git.validateTreePathPolicy(input.vaultId, tree, this.maxUploadBytes);

      const preparation = await this.store.mutate((db) => {
        const device = requireDevice(db, conflict.device_id);
        const operation = this.store.startOperation(db, {
          vault_id: input.vaultId,
          device_id: conflict.device_id,
          operation_type: 'conflict_resolve',
          expected_refs: {
            'refs/heads/main': input.expectedMain,
            [device.device_ref]: conflict.device_commit
          },
          target_refs: {
            'refs/heads/main': null
          },
          target_commit: null
        });
        operation.status = 'prepared';
        operation.prepared_manifest = {
          merge_sequence: conflict.merge_sequence,
          merge_policy_version: conflict.merge_policy_version,
          base_commit: conflict.base_commit,
          current_main: input.expectedMain,
          device_commit: conflict.device_commit,
          conflict_id: conflict.conflict_id,
          decision: 'resolved',
          resolution_kind: input.resolutionKind,
          resolution_request_hash: requestHash,
          validator_results: {
            accepted_tree: tree,
            expected_main_matches: true
          }
        };
        operation.updated_at = nowIso();
        return { operationId: operation.operation_id };
      });

      let resolutionCommit: string;
      try {
        resolutionCommit = await this.git.createResolutionMergeCommitObject({
          vaultId: input.vaultId,
          tree,
          expectedMain: input.expectedMain,
          deviceCommit: conflict.device_commit,
          conflictId: conflict.conflict_id,
          resolutionKind: input.resolutionKind
        });
        await this.prepareConflictResolutionRefUpdate(preparation.operationId, resolutionCommit);
        await this.git.updateRef(input.vaultId, 'refs/heads/main', resolutionCommit, input.expectedMain);
      } catch (error) {
        await this.abortOperation(preparation.operationId, 'resolution_git_error');
        throw error;
      }

      const eventSeq = await this.store.mutate((db) => {
        const operation = requireOperation(db, preparation.operationId);
        operation.status = 'committed';
        operation.target_refs = {
          'refs/heads/main': resolutionCommit
        };
        operation.target_commit = resolutionCommit;
        operation.result = {
          decision: 'resolved',
          conflict_id: conflict.conflict_id,
          resolution_kind: input.resolutionKind,
          resolution_commit: resolutionCommit
        };
        operation.updated_at = nowIso();

        const mutableVault = requireVault(db, input.vaultId);
        const mutableConflict = requireConflict(db, input.vaultId, input.conflictId);
        const device = requireDevice(db, mutableConflict.device_id);
        mutableVault.current_main = resolutionCommit;
        mutableVault.updated_at = nowIso();
        mutableConflict.status = 'resolved';
        mutableConflict.resolved_at = nowIso();
        mutableConflict.resolved_by_user_id = input.actorUserId;
        mutableConflict.resolution_kind = input.resolutionKind;
        mutableConflict.resolution_commit = resolutionCommit;
        mutableConflict.resolution_request_hash = requestHash;
        if (device.status !== 'revoked') {
          device.status = 'synced';
          device.last_successful_sync_at = nowIso();
        }
        const mainEvent = this.store.appendEvent(db, {
          event_type: 'main_advanced',
          vault_id: input.vaultId,
          resource_ids: {
            conflict_id: input.conflictId,
            device_id: mutableConflict.device_id
          },
          commit_cursors: {
            previous_main: input.expectedMain,
            main: resolutionCommit,
            device_commit: mutableConflict.device_commit
          },
          payload: {
            decision: 'resolved',
            conflict_id: input.conflictId,
            resolution_kind: input.resolutionKind,
            merge_sequence: mutableConflict.merge_sequence,
            merge_policy_version: mutableConflict.merge_policy_version
          }
        });
        this.store.appendEvent(db, {
          event_type: 'conflict_resolved',
          vault_id: input.vaultId,
          resource_ids: {
            conflict_id: input.conflictId,
            device_id: mutableConflict.device_id
          },
          commit_cursors: {
            main: resolutionCommit,
            previous_main: input.expectedMain,
            device_commit: mutableConflict.device_commit
          },
          payload: {
            resolution_kind: input.resolutionKind
          }
        });
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: input.actorUserId,
          actor_device_id: null,
          vault_id: input.vaultId,
          action: 'conflict_resolved',
          resource_class: 'conflict',
          resource_id: input.conflictId,
          created_at: nowIso()
        });
        return mainEvent.event_seq;
      });

      return {
        status: 'resolved',
        conflict_id: input.conflictId,
        main: resolutionCommit,
        resolution_commit: resolutionCommit,
        event_seq: eventSeq,
        idempotent: false
      };
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

  private async validateQuarantinedUpload(
    auth: AuthenticatedDevice,
    operation: SyncOperationRow,
    manifest: DevicePushManifest,
    packfile: Buffer,
    currentDeviceRef: string | null,
    currentMain: string
  ): Promise<PushResult | null> {
    try {
      return await this.git.withQuarantinedPack(auth.vault.vault_id, packfile, async (reader) => {
        if (!(await reader.commitExists(auth.vault.vault_id, manifest.target_commit))) {
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            'missing_target_commit',
            'Target commit is not present.'
          );
        }
        try {
          await reader.validateTreePathPolicy(auth.vault.vault_id, manifest.target_commit, this.maxUploadBytes);
        } catch (error) {
          const code = error instanceof PathPolicyViolation ? error.code : 'path_policy_rejected';
          return await this.rejectDevicePush(
            auth,
            operation.operation_id,
            code,
            'Uploaded commit violates the vault path policy.'
          );
        }
        if (currentDeviceRef && !(await reader.isAncestor(auth.vault.vault_id, currentDeviceRef, manifest.target_commit))) {
          return await this.blockDeviceForRecovery(auth, operation, currentDeviceRef, manifest.target_commit);
        }
        if (manifest.base_commit) {
          if (!(await reader.commitExists(auth.vault.vault_id, manifest.base_commit))) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'untrusted_base_commit', 'Proposal base is not trusted vault history.');
          }
          if (!(await reader.isAncestor(auth.vault.vault_id, manifest.base_commit, currentMain))) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'untrusted_base_commit', 'Proposal base is not trusted vault history.');
          }
          if (!(await reader.isAncestor(auth.vault.vault_id, manifest.base_commit, manifest.target_commit))) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'invalid_base_commit', 'Proposal base is not an ancestor of the uploaded commit.');
          }
        }
        return null;
      });
    } catch {
      return await this.rejectDevicePush(auth, operation.operation_id, 'malformed_packfile', 'Malformed Git packfile.');
    }
  }

  private async mergeDeviceCommit(
    vaultId: string,
    deviceId: string,
    deviceCommit: string,
    fallbackEventSeq: number,
    proposalBase: string | null = null,
    detachedProposal = false
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

    let base = proposalBase;
    if (base) {
      const baseIsValid =
        (await this.git.commitExists(vaultId, base)) &&
        (await this.git.isAncestor(vaultId, base, main)) &&
        (await this.git.isAncestor(vaultId, base, deviceCommit));
      if (!baseIsValid) {
        return await this.createConflict(vaultId, deviceId, '', main, deviceCommit, [], 'invalid_proposal_base');
      }
    } else {
      base = await this.git.mergeBase(vaultId, main, deviceCommit);
    }
    if (!base) {
      return await this.createConflict(vaultId, deviceId, '', main, deviceCommit, [], 'no_merge_base');
    }

    const mainChanges = await this.git.changedPaths(vaultId, base, main);
    const deviceChanges = await this.git.changedPaths(vaultId, base, deviceCommit);
    if (detachedProposal && hasDestructiveChanges(deviceChanges)) {
      return await this.createConflict(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        destructiveChangedPaths(deviceChanges),
        'detached_proposal_deletes'
      );
    }
    const structuralConflict = await this.classifyStructuralMergeConflict(
      vaultId,
      base,
      main,
      deviceCommit,
      mainChanges,
      deviceChanges
    );
    if (structuralConflict) {
      return await this.createConflict(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        structuralConflict.affectedPaths,
        structuralConflict.reason
      );
    }
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

  private async classifyStructuralMergeConflict(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    mainChanges: GitDiffEntry[],
    deviceChanges: GitDiffEntry[]
  ): Promise<StructuralConflict | null> {
    const [baseBlobs, currentBlobs, deviceBlobs] = await Promise.all([
      this.blobOidMap(vaultId, base),
      this.blobOidMap(vaultId, currentMain),
      this.blobOidMap(vaultId, deviceCommit)
    ]);
    const readBlob = async (commit: string, path: string): Promise<Buffer | null> =>
      await this.readOptionalBlob(vaultId, commit, path);
    const mainSummary = await summarizeStructuralChanges({
      baseCommit: base,
      targetCommit: currentMain,
      changes: mainChanges,
      baseBlobs,
      targetBlobs: currentBlobs,
      readBlob
    });
    const deviceSummary = await summarizeStructuralChanges({
      baseCommit: base,
      targetCommit: deviceCommit,
      changes: deviceChanges,
      baseBlobs,
      targetBlobs: deviceBlobs,
      readBlob
    });
    return structuralMergeConflict(mainSummary, deviceSummary);
  }

  private async blobOidMap(vaultId: string, commit: string): Promise<Map<string, string>> {
    const entries = await this.git.listTreeEntries(vaultId, commit);
    return new Map(entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.oid]));
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

  private async readOptionalTextBlob(vaultId: string, commit: string, path: string): Promise<string | null> {
    const blob = await this.readOptionalBlob(vaultId, commit, path);
    return blob === null ? null : blob.toString('utf8');
  }

  private async buildResolutionTree(
    conflict: ConflictRecord,
    resolutionKind: ConflictResolutionKind,
    manualFiles: Record<string, string | null> | undefined
  ): Promise<string> {
    const sourceTree = await this.resolutionSourceTree(conflict);
    if (resolutionKind === 'keep_server') {
      return sourceTree;
    }

    const writes = new Map<string, Buffer>();
    const deletes: string[] = [];

    if (resolutionKind === 'use_device') {
      if (conflict.affected_paths.length === 0) {
        return await this.git.treeHash(conflict.vault_id, conflict.device_commit);
      }
      for (const path of conflict.affected_paths) {
        const deviceBlob = await this.readOptionalBlob(conflict.vault_id, conflict.device_commit, path);
        if (deviceBlob === null) {
          deletes.push(path);
        } else {
          writes.set(path, deviceBlob);
        }
      }
      return await this.git.createTreeFromTreeWithChanges({
        vaultId: conflict.vault_id,
        sourceTree,
        writes,
        deletes
      });
    }

    if (resolutionKind === 'keep_both_files') {
      for (const path of conflict.affected_paths) {
        const deviceBlob = await this.readOptionalBlob(conflict.vault_id, conflict.device_commit, path);
        if (deviceBlob !== null) {
          writes.set(conflictCopyPath(path, conflict.conflict_id, conflict.device_id), deviceBlob);
        }
      }
      assertSyncableTreePaths([...writes.keys()]);
      return await this.git.createTreeFromTreeWithChanges({
        vaultId: conflict.vault_id,
        sourceTree,
        writes
      });
    }

    if (resolutionKind === 'insert_both_blocks') {
      for (const path of conflict.affected_paths) {
        const serverText = await this.readOptionalTextBlob(conflict.vault_id, conflict.expected_main, path);
        const deviceText = await this.readOptionalTextBlob(conflict.vault_id, conflict.device_commit, path);
        if (serverText === null && deviceText === null) {
          deletes.push(path);
          continue;
        }
        writes.set(
          path,
          Buffer.from(
            [
              `## Server version (${conflict.expected_main.slice(0, 12)})`,
              '',
              serverText ?? '',
              '',
              `## Device version (${conflict.device_commit.slice(0, 12)})`,
              '',
              deviceText ?? ''
            ].join('\n'),
            'utf8'
          )
        );
      }
      return await this.git.createTreeFromTreeWithChanges({
        vaultId: conflict.vault_id,
        sourceTree,
        writes,
        deletes
      });
    }

    if (resolutionKind === 'manual') {
      if (manualFiles === undefined || Object.keys(manualFiles).length === 0) {
        throw new AuthError(400, 'invalid_resolution', 'Manual resolution requires final file content.');
      }
      const allowedPaths = new Set(conflict.affected_paths);
      const unexpectedPaths = Object.keys(manualFiles).filter((path) => !allowedPaths.has(path));
      if (unexpectedPaths.length > 0) {
        throw new AuthError(400, 'invalid_resolution', 'Manual resolution can only edit affected conflict paths.');
      }
      const missingPaths = conflict.affected_paths.filter((path) => !Object.prototype.hasOwnProperty.call(manualFiles, path));
      if (missingPaths.length > 0) {
        throw new AuthError(400, 'invalid_resolution', 'Manual resolution must include every affected conflict path.');
      }
      assertSyncableTreePaths(Object.keys(manualFiles));
      for (const [path, content] of Object.entries(manualFiles)) {
        if (content === null) {
          deletes.push(path);
        } else {
          writes.set(path, Buffer.from(content, 'utf8'));
        }
      }
      return await this.git.createTreeFromTreeWithChanges({
        vaultId: conflict.vault_id,
        sourceTree,
        writes,
        deletes
      });
    }

    throw new AuthError(400, 'invalid_resolution', 'Unsupported conflict resolution kind.');
  }

  private async resolutionSourceTree(conflict: ConflictRecord): Promise<string> {
    if (conflict.affected_paths.length === 0 || !(await this.git.commitExists(conflict.vault_id, conflict.base_commit))) {
      return await this.git.treeHash(conflict.vault_id, conflict.expected_main);
    }
    const deviceChanges = await this.git.changedPaths(conflict.vault_id, conflict.base_commit, conflict.device_commit);
    const nonConflictingDeviceChanges = changesOutsideAffectedPaths(deviceChanges, conflict.affected_paths);
    if (nonConflictingDeviceChanges.length === 0) {
      return await this.git.treeHash(conflict.vault_id, conflict.expected_main);
    }
    return await this.git.createTreeFromCommitWithOverlayChanges({
      vaultId: conflict.vault_id,
      sourceCommit: conflict.expected_main,
      deviceCommit: conflict.device_commit,
      deviceChanges: nonConflictingDeviceChanges
    });
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
          affected_paths: affectedPaths,
          affected_path_count: affectedPaths.length
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
        validator_results: {
          reason,
          affected_paths: affectedPaths,
          affected_path_count: affectedPaths.length
        },
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

  private async prepareConflictResolutionRefUpdate(operationId: string, resolutionCommit: string): Promise<void> {
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      if (operation.status !== 'prepared') {
        throw new Error(`Operation cannot prepare resolution ref update from status ${operation.status}.`);
      }
      operation.target_refs = {
        'refs/heads/main': resolutionCommit
      };
      operation.target_commit = resolutionCommit;
      operation.prepared_manifest = {
        ...(operation.prepared_manifest ?? {}),
        target_refs: {
          'refs/heads/main': resolutionCommit
        },
        target_commit: resolutionCommit
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

function requireConflict(db: MetadataDb, vaultId: string, conflictId: string): ConflictRecord {
  const conflict = db.conflicts.find(
    (candidate) => candidate.vault_id === vaultId && candidate.conflict_id === conflictId
  );
  if (!conflict) {
    throw new Error(`Conflict not found: ${conflictId}`);
  }
  return conflict;
}

function requireOperation(db: MetadataDb, operationId: string): SyncOperationRow {
  const operation = db.sync_operations.find((candidate) => candidate.operation_id === operationId);
  if (!operation) {
    throw new Error(`Operation not found: ${operationId}`);
  }
  return operation;
}

async function summarizeStructuralChanges(input: {
  baseCommit: string;
  targetCommit: string;
  changes: GitDiffEntry[];
  baseBlobs: Map<string, string>;
  targetBlobs: Map<string, string>;
  readBlob: (commit: string, path: string) => Promise<Buffer | null>;
}): Promise<StructuralSummary> {
  const explicitRenames: RenamePair[] = [];
  const deletePaths = new Set<string>();
  const addPaths = new Set<string>();
  const editPaths = new Set<string>();
  const renameCandidatesByBasePath = new Map<string, Set<string>>();

  for (const entry of input.changes) {
    const status = entry.status[0] ?? '';
    if (entry.status.startsWith('R') && entry.oldPath && entry.oldPath !== entry.path) {
      explicitRenames.push({ basePath: entry.oldPath, targetPath: entry.path, confidence: 'git' });
      recordRenameCandidate(renameCandidatesByBasePath, entry.oldPath, entry.path);
      continue;
    }
    if (status === 'D') {
      deletePaths.add(entry.path);
      continue;
    }
    if (status === 'A' || status === 'C') {
      addPaths.add(entry.path);
      continue;
    }
    if (input.baseBlobs.has(entry.path) && input.targetBlobs.has(entry.path)) {
      editPaths.add(entry.path);
    } else if (input.baseBlobs.has(entry.path)) {
      deletePaths.add(entry.path);
    } else if (input.targetBlobs.has(entry.path)) {
      addPaths.add(entry.path);
    }
  }

  const exactRenames = inferExactRenamePairs(deletePaths, addPaths, input.baseBlobs, input.targetBlobs, renameCandidatesByBasePath);
  for (const pair of exactRenames) {
    deletePaths.delete(pair.basePath);
    addPaths.delete(pair.targetPath);
  }
  const similarRenames = await inferSimilarRenamePairs({
    baseCommit: input.baseCommit,
    targetCommit: input.targetCommit,
    deletePaths,
    addPaths,
    readBlob: input.readBlob,
    renameCandidatesByBasePath
  });
  for (const pair of similarRenames) {
    deletePaths.delete(pair.basePath);
    addPaths.delete(pair.targetPath);
  }

  const actions: StructuralAction[] = [];
  const byBasePath = new Map<string, StructuralAction>();
  const addsByPath = new Map<string, StructuralAction>();
  const addAction = (action: StructuralAction): void => {
    actions.push(action);
    if (action.basePath !== null) {
      byBasePath.set(action.basePath, action);
    }
    if (action.kind === 'add' && action.targetPath !== null) {
      addsByPath.set(action.targetPath, action);
    }
  };

  for (const pair of [...explicitRenames, ...exactRenames, ...similarRenames]) {
    addAction({
      kind: 'rename',
      basePath: pair.basePath,
      targetPath: pair.targetPath,
      baseOid: input.baseBlobs.get(pair.basePath) ?? null,
      targetOid: input.targetBlobs.get(pair.targetPath) ?? null,
      renameConfidence: pair.confidence
    });
  }
  for (const path of [...editPaths].sort()) {
    addAction({
      kind: 'edit',
      basePath: path,
      targetPath: path,
      baseOid: input.baseBlobs.get(path) ?? null,
      targetOid: input.targetBlobs.get(path) ?? null,
      renameConfidence: null
    });
  }
  for (const path of [...deletePaths].sort()) {
    addAction({
      kind: 'delete',
      basePath: path,
      targetPath: null,
      baseOid: input.baseBlobs.get(path) ?? null,
      targetOid: null,
      renameConfidence: null
    });
  }
  for (const path of [...addPaths].sort()) {
    addAction({
      kind: 'add',
      basePath: null,
      targetPath: path,
      baseOid: null,
      targetOid: input.targetBlobs.get(path) ?? null,
      renameConfidence: null
    });
  }

  return { actions, byBasePath, addsByPath, renameCandidatesByBasePath };
}

function inferExactRenamePairs(
  deletePaths: Set<string>,
  addPaths: Set<string>,
  baseBlobs: Map<string, string>,
  targetBlobs: Map<string, string>,
  renameCandidatesByBasePath: Map<string, Set<string>>
): RenamePair[] {
  const deletesByOid = groupPathsByOid(deletePaths, baseBlobs);
  const addsByOid = groupPathsByOid(addPaths, targetBlobs);
  const pairs: RenamePair[] = [];
  for (const [oid, deleted] of deletesByOid) {
    const added = addsByOid.get(oid) ?? [];
    for (const basePath of deleted) {
      for (const targetPath of added) {
        recordRenameCandidate(renameCandidatesByBasePath, basePath, targetPath);
      }
    }
    if (deleted.length === 1 && added.length === 1) {
      pairs.push({ basePath: deleted[0]!, targetPath: added[0]!, confidence: 'exact_blob' });
    }
  }
  return pairs;
}

async function inferSimilarRenamePairs(input: {
  baseCommit: string;
  targetCommit: string;
  deletePaths: Set<string>;
  addPaths: Set<string>;
  readBlob: (commit: string, path: string) => Promise<Buffer | null>;
  renameCandidatesByBasePath: Map<string, Set<string>>;
}): Promise<RenamePair[]> {
  const candidatesByBase = new Map<string, Array<{ targetPath: string; score: number }>>();
  const candidatesByTarget = new Map<string, string[]>();
  const baseBlobCache = new Map<string, Buffer | null>();
  const targetBlobCache = new Map<string, Buffer | null>();
  const readBase = async (path: string): Promise<Buffer | null> => {
    if (!baseBlobCache.has(path)) {
      baseBlobCache.set(path, await input.readBlob(input.baseCommit, path));
    }
    return baseBlobCache.get(path) ?? null;
  };
  const readTarget = async (path: string): Promise<Buffer | null> => {
    if (!targetBlobCache.has(path)) {
      targetBlobCache.set(path, await input.readBlob(input.targetCommit, path));
    }
    return targetBlobCache.get(path) ?? null;
  };

  for (const basePath of input.deletePaths) {
    for (const targetPath of input.addPaths) {
      if (!sameRenameExtension(basePath, targetPath)) {
        continue;
      }
      const baseBlob = await readBase(basePath);
      const targetBlob = await readTarget(targetPath);
      const score = baseBlob && targetBlob ? contentSimilarity(baseBlob, targetBlob) : 0;
      if (score < SIMILAR_RENAME_THRESHOLD) {
        continue;
      }
      recordRenameCandidate(input.renameCandidatesByBasePath, basePath, targetPath);
      const baseCandidates = candidatesByBase.get(basePath) ?? [];
      baseCandidates.push({ targetPath, score });
      candidatesByBase.set(basePath, baseCandidates);
      const targetCandidates = candidatesByTarget.get(targetPath) ?? [];
      targetCandidates.push(basePath);
      candidatesByTarget.set(targetPath, targetCandidates);
    }
  }

  const pairs: RenamePair[] = [];
  for (const [basePath, candidates] of candidatesByBase) {
    if (candidates.length !== 1) {
      continue;
    }
    const targetPath = candidates[0]!.targetPath;
    if ((candidatesByTarget.get(targetPath) ?? []).length === 1) {
      pairs.push({ basePath, targetPath, confidence: 'similar_content' });
    }
  }
  return pairs;
}

function structuralMergeConflict(left: StructuralSummary, right: StructuralSummary): StructuralConflict | null {
  for (const [basePath, leftAction] of left.byBasePath) {
    const rightAction = right.byBasePath.get(basePath);
    if (!rightAction) {
      continue;
    }
    const conflict = structuralBasePathConflict(basePath, leftAction, rightAction, left, right);
    if (conflict) {
      return conflict;
    }
  }
  return renameTargetCollision(left, right) ?? renameTargetCollision(right, left);
}

function structuralBasePathConflict(
  basePath: string,
  leftAction: StructuralAction,
  rightAction: StructuralAction,
  left: StructuralSummary,
  right: StructuralSummary
): StructuralConflict | null {
  if (leftAction.kind === 'rename' && rightAction.kind === 'rename') {
    return leftAction.targetPath === rightAction.targetPath
      ? null
      : structuralConflict('rename_rename_conflict', structuralActionPaths(leftAction, rightAction));
  }
  if (leftAction.kind === 'rename' && rightAction.kind === 'delete') {
    return structuralConflict('rename_delete_conflict', structuralActionPaths(leftAction, rightAction));
  }
  if (leftAction.kind === 'delete' && rightAction.kind === 'rename') {
    return structuralConflict('rename_delete_conflict', structuralActionPaths(leftAction, rightAction));
  }
  if (leftAction.kind === 'delete' && rightAction.kind === 'edit') {
    return structuralConflict('delete_edit_conflict', structuralActionPaths(leftAction, rightAction));
  }
  if (leftAction.kind === 'edit' && rightAction.kind === 'delete') {
    return structuralConflict('delete_edit_conflict', structuralActionPaths(leftAction, rightAction));
  }
  if (leftAction.kind === 'rename' && rightAction.kind === 'edit') {
    return renameEditPathCollision(basePath, leftAction, right) ?? null;
  }
  if (leftAction.kind === 'edit' && rightAction.kind === 'rename') {
    return renameEditPathCollision(basePath, rightAction, left) ?? null;
  }
  if (leftAction.kind === 'delete' && rightAction.kind === 'delete') {
    const leftTargets = left.renameCandidatesByBasePath.get(basePath) ?? new Set<string>();
    const rightTargets = right.renameCandidatesByBasePath.get(basePath) ?? new Set<string>();
    if (leftTargets.size === 0 && rightTargets.size === 0) {
      return null;
    }
    if (singleSamePath(leftTargets, rightTargets)) {
      return null;
    }
    return structuralConflict('ambiguous_rename_conflict', [basePath, ...leftTargets, ...rightTargets]);
  }
  return null;
}

function renameEditPathCollision(
  basePath: string,
  renameAction: StructuralAction,
  editingSide: StructuralSummary
): StructuralConflict | null {
  if (!renameAction.targetPath) {
    return null;
  }
  for (const action of editingSide.actions) {
    if (action.basePath === basePath) {
      continue;
    }
    if (actionTouchesPath(action, renameAction.targetPath)) {
      return structuralConflict('rename_path_collision', structuralActionPaths(renameAction, action));
    }
  }
  return null;
}

function renameTargetCollision(left: StructuralSummary, right: StructuralSummary): StructuralConflict | null {
  for (const renameAction of left.actions.filter((action) => action.kind === 'rename')) {
    if (!renameAction.targetPath) {
      continue;
    }
    for (const otherAction of right.actions) {
      if (
        otherAction.kind === 'rename' &&
        otherAction.basePath === renameAction.basePath &&
        otherAction.targetPath === renameAction.targetPath
      ) {
        continue;
      }
      if (actionTouchesPath(otherAction, renameAction.targetPath)) {
        return structuralConflict('rename_path_collision', structuralActionPaths(renameAction, otherAction));
      }
    }
  }
  return null;
}

function actionTouchesPath(action: StructuralAction, path: string): boolean {
  if (action.targetPath && changedPathsConflict(action.targetPath, path)) {
    return true;
  }
  return action.kind === 'delete' && action.basePath !== null && changedPathsConflict(action.basePath, path);
}

function structuralActionPaths(...actions: StructuralAction[]): string[] {
  const paths = new Set<string>();
  for (const action of actions) {
    if (action.basePath) {
      paths.add(action.basePath);
    }
    if (action.targetPath) {
      paths.add(action.targetPath);
    }
  }
  return [...paths].sort();
}

function structuralConflict(reason: string, paths: Iterable<string>): StructuralConflict {
  return { reason, affectedPaths: [...new Set(paths)].sort() };
}

function recordRenameCandidate(candidates: Map<string, Set<string>>, basePath: string, targetPath: string): void {
  const paths = candidates.get(basePath) ?? new Set<string>();
  paths.add(targetPath);
  candidates.set(basePath, paths);
}

function groupPathsByOid(paths: Set<string>, oidByPath: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const oid = oidByPath.get(path);
    if (!oid) {
      continue;
    }
    const group = groups.get(oid) ?? [];
    group.push(path);
    groups.set(oid, group);
  }
  return groups;
}

function sameRenameExtension(left: string, right: string): boolean {
  return posix.extname(left).toLocaleLowerCase() === posix.extname(right).toLocaleLowerCase();
}

function contentSimilarity(left: Buffer, right: Buffer): number {
  const leftText = similarityText(left);
  const rightText = similarityText(right);
  if (leftText === null || rightText === null) {
    return 0;
  }
  if (leftText === rightText) {
    return 1;
  }
  const leftTokens = similarityTokens(leftText);
  const rightTokens = similarityTokens(rightText);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const token of leftTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let intersection = 0;
  for (const token of rightTokens) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

function similarityText(blob: Buffer): string | null {
  if (blob.length > SIMILAR_RENAME_MAX_BYTES || blob.includes(0)) {
    return null;
  }
  const text = blob.toString('utf8');
  return text.includes('\uFFFD') ? null : text;
}

function similarityTokens(text: string): string[] {
  const normalized = text.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return [];
  }
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length >= 8) {
    return words;
  }
  const chars = [...normalized];
  if (chars.length <= 3) {
    return [normalized];
  }
  const grams: string[] = [];
  for (let index = 0; index <= chars.length - 3; index += 1) {
    grams.push(chars.slice(index, index + 3).join(''));
  }
  return grams;
}

function singleSamePath(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== 1 || right.size !== 1) {
    return false;
  }
  return left.values().next().value === right.values().next().value;
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

function changesOutsideAffectedPaths(entries: GitDiffEntry[], affectedPaths: string[]): GitDiffEntry[] {
  return entries.filter((entry) => {
    const entryPaths = entry.oldPath ? [entry.path, entry.oldPath] : [entry.path];
    return !entryPaths.some((entryPath) => affectedPaths.some((affectedPath) => changedPathsConflict(entryPath, affectedPath)));
  });
}

function hasDestructiveChanges(entries: GitDiffEntry[]): boolean {
  return entries.some((entry) => entry.status.startsWith('D') || entry.status.startsWith('R'));
}

function destructiveChangedPaths(entries: GitDiffEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.status.startsWith('D')) {
      paths.add(entry.path);
    }
    if (entry.status.startsWith('R')) {
      paths.add(entry.oldPath ?? entry.path);
      paths.add(entry.path);
    }
  }
  return [...paths].sort();
}

function isNativeTextMergePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.canvas') || path.endsWith('.base');
}

function conflictCopyPath(path: string, conflictId: string, deviceId: string): string {
  const parsed = posix.parse(path);
  const suffix = `device-${deviceId.slice(-8)}-${conflictId.slice(-8)}`;
  const fileName = parsed.ext ? `${parsed.name}.${suffix}${parsed.ext}` : `${parsed.base}.${suffix}`;
  return parsed.dir ? posix.join(parsed.dir, fileName) : fileName;
}

function buildSourceDiff(serverContent: string | null, deviceContent: string | null): string {
  const serverLines = (serverContent ?? '').split('\n');
  const deviceLines = (deviceContent ?? '').split('\n');
  const rows = ['--- server', '+++ device'];
  const max = Math.max(serverLines.length, deviceLines.length);
  for (let index = 0; index < max; index += 1) {
    const left = serverLines[index];
    const right = deviceLines[index];
    if (left === right) {
      if (left !== undefined) {
        rows.push(` ${left}`);
      }
      continue;
    }
    if (left !== undefined) {
      rows.push(`-${left}`);
    }
    if (right !== undefined) {
      rows.push(`+${right}`);
    }
  }
  return rows.join('\n');
}

function buildMarkdownReview(serverContent: string | null, deviceContent: string | null): string {
  return [
    '<section class="markdown-review-version">',
    '<h3>Server version</h3>',
    markdownReviewBody(serverContent),
    '</section>',
    '<section class="markdown-review-version">',
    '<h3>Device version</h3>',
    markdownReviewBody(deviceContent),
    '</section>'
  ].join('');
}

function markdownReviewBody(content: string | null): string {
  if (content === null) {
    return '<p><em>File absent</em></p>';
  }
  return `<pre>${escapeHtml(content)}</pre>`;
}

function escapeHtml(content: string): string {
  return content.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

export const __syncServiceTestInternals = {
  summarizeStructuralChanges,
  structuralMergeConflict
};

function resolutionRequestHash(input: {
  expectedMain: string;
  resolutionKind: ConflictResolutionKind;
  manualFiles?: Record<string, string | null>;
}): string {
  return sha256Hex(
    JSON.stringify({
      expected_main: input.expectedMain,
      resolution_kind: input.resolutionKind,
      manual_files:
        input.manualFiles === undefined
          ? null
          : Object.fromEntries(Object.entries(input.manualFiles).sort(([left], [right]) => left.localeCompare(right)))
    })
  );
}
