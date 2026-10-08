import { posix } from 'node:path';
import { createHash } from 'node:crypto';

import { newId, nowIso } from '../shared/ids.js';
import { assertSyncableTreePaths, PathPolicyViolation } from '../shared/pathPolicy.js';
import { createRootIgnorePolicy, RootIgnorePolicyError } from '../shared/rootIgnore.cjs';
import { validateMetadataConflictRules, type MetadataConflictRule } from './frontmatterTimestampMerge.js';
import type {
  ConflictPreviewFile,
  ConflictRecord,
  ConflictResolutionKind,
  ConflictResolutionPreview,
  ConflictReviewFile,
  ConflictReviewPackage,
  ConflictReviewPath,
  DevicePushManifest,
  DirectoryConflictContext,
  DirectoryConflictReview,
  DirectoryIntent,
  DirectoryIntentAcknowledgement,
  DirectoryProposal,
  DirectoryProposalAcknowledgement,
  DirectoryProposalIntent,
  ManualFilePlanEntry,
  PushResult,
  ResolveConflictResponse
} from '../shared/types.js';
import { AuthError, type AuthenticatedDevice } from './authService.js';
import { GitCommandError, GitDurabilityError, GitMalformedPackError, GitMergeOwnershipError, GitService, sha256Hex, type GitDiffEntry, type GitMergeRename, type GitObjectReader, type MergeTreeResult } from './gitService.js';
import { parseRenamePairs } from '../shared/validators.js';
import { hasDurableDeletionRecord } from './metadataStore.js';
import type { VaultLifecycleCoordinator } from './vaultLifecycleCoordinator.js';
import { type OperationalLog, pushLogFields, silentOperationalLog } from './operationalLog.js';
import type {
  DeviceRow,
  DirectoryProposalResultRow,
  MetadataDb,
  MetadataStore,
  SyncOperationRow
} from './metadataStore.js';

const MERGE_POLICY_VERSION = 'phase2.semantic-merge.v1';

function policyConflictPaths(error: PathPolicyViolation | InstanceType<typeof RootIgnorePolicyError>): string[] {
  return error instanceof PathPolicyViolation && typeof error.details?.path === 'string'
    ? [error.details.path] : ['.gitignore'];
}
const SIMILAR_RENAME_THRESHOLD = 0.72;
const SIMILAR_RENAME_MAX_BYTES = 256 * 1024;
const MAX_INTERACTIVE_REVIEW_BYTES = 512 * 1024;
const REVIEW_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

type RenameConfidence = 'git' | 'exact_blob' | 'similar_content' | 'explicit';
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

type UploadValidation = {
  rejection: PushResult | null;
  deviceRelation: 'initial' | 'fast_forward' | 'superseded' | 'divergent';
};

type DirectoryMergePlan = {
  proposal: DirectoryProposal;
  requestSha256: string;
  baseExplicitDirs: string[];
  serverExplicitDirs: string[];
  cleanIntents: DirectoryProposalIntent[];
  conflictingIntents: DirectoryProposalIntent[];
  affectedRoots: string[];
  expectedEventSeq: number;
};

type ResolutionArtifacts = {
  tree: string;
  sourceTree: string;
  fileAffectedPaths: string[];
  writes: Map<string, Buffer>;
  deletes: string[];
};

export class SyncService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: MetadataStore,
    private readonly git: GitService,
    private readonly maxUploadBytes: number,
    private readonly lifecycle?: VaultLifecycleCoordinator,
    private readonly log: OperationalLog = silentOperationalLog
  ) {}

  async runWithVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    return await this.withVaultLock(vaultId, fn);
  }

  async getVaultSyncSettings(vaultId: string, actorUserId: string): Promise<Record<string, unknown>> {
    return await this.withVaultLock(vaultId, async () => {
      const db = await this.store.snapshot();
      const vault = requireVault(db, vaultId);
      if (vault.owner_user_id !== actorUserId) throw new AuthError(404, 'not_found', 'Resource not found.');
      const policy = await this.git.readRootIgnoreBlob(vaultId, vault.current_main);
      let rootIgnore: string | null = null;
      if (policy.bytes !== null) rootIgnore = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(policy.bytes);
      return {
        vault_id: vault.vault_id,
        current_main: vault.current_main,
        root_ignore_oid: policy.oid,
        root_ignore: rootIgnore,
        metadata_conflict_rules: validateMetadataConflictRules(vault.metadata_conflict_rules ?? [])
      };
    });
  }

  async previewVaultSyncSettings(input: {
    vaultId: string; actorUserId: string; expectedMain: string; expectedRootIgnoreOid: string | null;
    rootIgnore: string | null; metadataConflictRules: unknown;
  }): Promise<Record<string, unknown>> {
    return await (async () => {
      const db = await this.store.snapshot();
      const vault = requireVault(db, input.vaultId);
      if (vault.owner_user_id !== input.actorUserId) throw new AuthError(404, 'not_found', 'Resource not found.');
      if (vault.status !== 'active') throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      if (vault.current_main !== input.expectedMain) throw new AuthError(409, 'stale_settings', 'Vault main changed; reload settings before saving.');
      const previousPolicy = await this.git.readRootIgnoreBlob(input.vaultId, vault.current_main);
      if (previousPolicy.oid !== input.expectedRootIgnoreOid) throw new AuthError(409, 'stale_settings', 'Root .gitignore changed; reload settings before saving.');
      const rules = validateMetadataConflictRules(input.metadataConflictRules);
      const currentRules = validateMetadataConflictRules(vault.metadata_conflict_rules ?? []);
      const bytes = input.rootIgnore === null ? null : Buffer.from(input.rootIgnore, 'utf8');
      const policy = createRootIgnorePolicy(bytes);
      const entries = await this.git.listTreeEntries(input.vaultId, vault.current_main);
      const excludedPaths = entries.filter((entry) => entry.type === 'blob' && policy.ignores(entry.path)).map((entry) => entry.path).sort();
      const currentDirs = db.directory_state_by_vault[input.vaultId]?.explicit_dirs ?? [];
      const excludedDirectories = currentDirs.filter((path) => policy.ignores(path, true)).sort();
      const previousDirectoryOutcomes = new Set(currentDirs.filter((path) => previousPolicy.bytes !== null &&
        createRootIgnorePolicy(previousPolicy.bytes).ignores(path, true)));
      const directoryOutcomesChanged = currentDirs.some((path) => previousDirectoryOutcomes.has(path) !== policy.ignores(path, true));
      const writes = new Map<string, Buffer>();
      const deletes = [...excludedPaths];
      if (bytes === null) deletes.push('.gitignore');
      else writes.set('.gitignore', bytes);
      const tree = await this.git.createTreeFromCommitWithChanges({
        vaultId: input.vaultId, sourceCommit: vault.current_main, writes, deletes
      });
      const rootIgnoreOid = await this.git.validateTreeRootIgnorePolicy(input.vaultId, tree);
      if (directoryOutcomesChanged && tree === await this.git.treeHash(input.vaultId, vault.current_main)) {
        throw new AuthError(409, 'directory_outcome_requires_main_advance', 'The directory policy outcome requires a main history change; no safe change can advance main.');
      }
      const reviewFingerprint = createHash('sha256').update(JSON.stringify({
        vault_id: vault.vault_id, expected_main: vault.current_main, expected_root_ignore_oid: previousPolicy.oid,
        expected_metadata_conflict_rules: currentRules, proposed_root_ignore_oid: rootIgnoreOid,
        proposed_root_ignore: input.rootIgnore, proposed_metadata_conflict_rules: rules,
        preview_tree: tree, affected_paths: excludedPaths, affected_directories: excludedDirectories
      })).digest('hex');
      return {
        vault_id: vault.vault_id,
        expected_main: vault.current_main,
        expected_root_ignore_oid: previousPolicy.oid,
        preview_tree: tree,
        root_ignore_oid: rootIgnoreOid,
        affected_paths: excludedPaths,
        affected_directories: excludedDirectories,
        review_fingerprint: reviewFingerprint,
        metadata_conflict_rules: rules,
        changes_main: tree !== await this.git.treeHash(input.vaultId, vault.current_main)
      };
    })();
  }

  async saveVaultSyncSettings(input: {
    vaultId: string; actorUserId: string; expectedMain: string; expectedRootIgnoreOid: string | null;
    expectedPreviewTree: string; expectedReviewFingerprint: string; rootIgnore: string | null; metadataConflictRules: unknown;
    expectedMetadataConflictRules: unknown;
  }): Promise<Record<string, unknown>> {
    return await this.withVaultLock(input.vaultId, async () => {
      const preview = await this.previewVaultSyncSettings({ ...input, metadataConflictRules: input.metadataConflictRules });
      if (preview.preview_tree !== input.expectedPreviewTree || preview.review_fingerprint !== input.expectedReviewFingerprint) throw new AuthError(409, 'stale_settings', 'Settings preview changed; review it again before saving.');
      const db = await this.store.snapshot();
      const vault = requireVault(db, input.vaultId);
      const rules = validateMetadataConflictRules(input.metadataConflictRules);
      const expectedRules = validateMetadataConflictRules(input.expectedMetadataConflictRules);
      if (JSON.stringify(vault.metadata_conflict_rules ?? []) !== JSON.stringify(expectedRules)) {
        throw new AuthError(409, 'stale_settings', 'Metadata conflict rules changed; reload settings before saving.');
      }
      const latestPolicy = await this.git.readRootIgnoreBlob(input.vaultId, vault.current_main);
      if (latestPolicy.oid !== input.expectedRootIgnoreOid) throw new AuthError(409, 'stale_settings', 'Root .gitignore changed; reload settings before saving.');
      const targetTree = String(preview.preview_tree);
      const currentTree = await this.git.treeHash(input.vaultId, vault.current_main);
      if (targetTree === currentTree) {
        await this.store.mutate((mutableDb) => {
          const current = requireVault(mutableDb, input.vaultId);
          if (current.current_main !== input.expectedMain) throw new AuthError(409, 'stale_settings', 'Vault main changed; reload settings before saving.');
          current.metadata_conflict_rules = rules;
          current.updated_at = nowIso();
          mutableDb.audit_log.push({
            audit_id: newId('aud'), actor_user_id: input.actorUserId, actor_device_id: null, vault_id: input.vaultId,
            action: 'vault_sync_settings_updated', resource_class: 'vault', resource_id: input.vaultId, created_at: nowIso()
          });
        });
        return { vault_id: vault.vault_id, current_main: vault.current_main, root_ignore: input.rootIgnore,
          metadata_conflict_rules: rules, root_ignore_oid: preview.root_ignore_oid };
      }

      const incompatible = db.devices.find((device) => device.vault_id === input.vaultId && device.status !== 'revoked' &&
        device.path_capabilities?.root_ignore !== true);
      if (incompatible) throw new AuthError(409, 'root_ignore_capability_required', 'Update every paired device before changing root .gitignore.');
      const targetMain = await this.git.createMainCommitFromTree({
        vaultId: input.vaultId, tree: targetTree, parentMain: vault.current_main,
        subject: 'obts: update vault sync settings',
        body: `actor_user_id=${input.actorUserId}\nroot_ignore_oid=${String(preview.root_ignore_oid)}\n`, actor: 'obts-settings'
      });
      const removedDirectories = preview.affected_directories as string[];
      const operationId = await this.store.mutate((mutableDb) => {
        const current = requireVault(mutableDb, input.vaultId);
        if (current.current_main !== input.expectedMain) throw new AuthError(409, 'stale_settings', 'Vault main changed; reload settings before saving.');
        const operation = this.store.startOperation(mutableDb, {
          vault_id: input.vaultId, device_id: null, operation_type: 'vault_settings',
          expected_refs: { 'refs/heads/main': input.expectedMain }, target_refs: { 'refs/heads/main': targetMain }, target_commit: targetMain
        });
        operation.status = 'prepared';
        operation.prepared_manifest = {
          actor_user_id: input.actorUserId, previous_main: input.expectedMain, target_main: targetMain,
          target_root_ignore_oid: preview.root_ignore_oid, metadata_conflict_rules: rules,
          removed_directories: removedDirectories, target_refs: { 'refs/heads/main': targetMain }
        };
        operation.updated_at = nowIso();
        return operation.operation_id;
      });
      try {
        await this.git.updateRef(input.vaultId, 'refs/heads/main', targetMain, input.expectedMain);
      } catch (error) {
        const actual = await this.git.getRef(input.vaultId, 'refs/heads/main');
        if (actual === input.expectedMain) {
          await this.abortOperation(operationId, 'vault_settings_ref_not_moved');
          throw error;
        }
        if (actual !== targetMain) {
          await this.blockPreparedOperationForIntegrity(operationId, 'vault settings ref cannot be reconciled');
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
      }
      await this.commitVaultSettingsOperation(operationId);
      return { vault_id: vault.vault_id, current_main: targetMain, root_ignore: input.rootIgnore,
        metadata_conflict_rules: rules, root_ignore_oid: preview.root_ignore_oid };
    });
  }

  private async commitVaultSettingsOperation(operationId: string): Promise<void> {
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      const vault = requireVault(db, operation.vault_id);
      const manifest = operation.prepared_manifest ?? {};
      const targetMain = typeof manifest.target_main === 'string' ? manifest.target_main : null;
      const actorUserId = typeof manifest.actor_user_id === 'string' ? manifest.actor_user_id : null;
      const rules = validateMetadataConflictRules(manifest.metadata_conflict_rules);
      const removedDirectories = Array.isArray(manifest.removed_directories) &&
        manifest.removed_directories.every((path): path is string => typeof path === 'string')
        ? manifest.removed_directories : null;
      if (operation.status !== 'prepared' || !targetMain || !actorUserId || !removedDirectories ||
          operation.target_refs['refs/heads/main'] !== targetMain || operation.target_commit !== targetMain) {
        throw new Error('Prepared vault settings operation is invalid.');
      }
      const previousMain = vault.current_main;
      vault.current_main = targetMain;
      vault.metadata_conflict_rules = rules;
      vault.updated_at = nowIso();
      const intents: DirectoryIntent[] = removedDirectories.map((path) => ({ op: 'delete', path }));
      const event = this.store.appendEvent(db, {
        event_type: 'main_advanced', vault_id: operation.vault_id, resource_ids: {},
        commit_cursors: { previous_main: previousMain, main: targetMain },
        payload: { settings_updated: true, root_ignore_oid: manifest.target_root_ignore_oid ?? null, directory_intents: intents }
      });
      applyDirectoryIntents(db, operation.vault_id, intents, event.event_seq);
      db.audit_log.push({
        audit_id: newId('aud'), actor_user_id: actorUserId, actor_device_id: null, vault_id: operation.vault_id,
        action: 'vault_sync_settings_updated', resource_class: 'vault', resource_id: operation.vault_id, created_at: nowIso()
      });
      operation.status = 'committed';
      operation.result = { target_main: targetMain, event_seq: event.event_seq };
      operation.updated_at = nowIso();
    });
  }

  async metadataConflictRules(vaultId: string): Promise<MetadataConflictRule[]> {
    const db = await this.store.snapshot();
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    if (!vault) throw new AuthError(404, 'not_found', 'Resource not found.');
    return validateMetadataConflictRules(vault.metadata_conflict_rules ?? []);
  }

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
      if (hasDurableDeletionRecord(db, operation.vault_id)) continue;
      await this.withVaultLock(operation.vault_id, async () => {
        const currentDb = await this.store.snapshot();
        const vault = currentDb.vaults.find((candidate) => candidate.vault_id === operation.vault_id);
        const device = currentDb.devices.find((candidate) => candidate.device_id === operation.device_id);
        if (
          !vault ||
          hasDurableDeletionRecord(currentDb, operation.vault_id) ||
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
        const storedPairs = operation.prepared_manifest?.rename_pairs;
        const renamePairs = storedPairs === undefined || storedPairs === null ? undefined : storedRenamePairs(storedPairs);
        const started = Date.now();
        const result = await this.mergeDeviceCommit(
          vault.vault_id,
          device.device_id,
          operation.target_commit!,
          this.latestEventSeq(vault.vault_id, currentDb),
          operation.proposal_base ?? null,
          false,
          storedDirectoryProposal(operation.prepared_manifest?.directory_proposal),
          operation.prepared_manifest?.root_ignore_capability === 'root-ignore-v1'
            ? {
                root_ignore_capability: 'root-ignore-v1',
                root_ignore_oid: operation.prepared_manifest.root_ignore_oid as string | null,
                ...(renamePairs ? { rename_pairs: renamePairs } : {})
              }
            : renamePairs
              ? { rename_pairs: renamePairs }
              : null
        );
        this.log.emit('info', 'push_integrated', {
          vault_id: vault.vault_id, device_id: device.device_id, ...pushLogFields(result), duration_ms: Date.now() - started
        });
      });
    }
  }

  async pushDeviceCommit(
    auth: AuthenticatedDevice,
    manifest: DevicePushManifest,
    packfile: Buffer,
    staged?: { reader: GitObjectReader; promote: () => Promise<void>; transferId?: string }
  ): Promise<PushResult> {
    const started = Date.now();
    const result = await this.integrateDeviceCommit(auth, manifest, packfile, staged);
    this.log.emit('info', 'push_integrated', {
      vault_id: auth.vault.vault_id, device_id: auth.device.device_id,
      ...(staged?.transferId ? { transfer_id: staged.transferId } : {}),
      ...pushLogFields(result), duration_ms: Date.now() - started
    });
    return result;
  }

  private async integrateDeviceCommit(
    auth: AuthenticatedDevice,
    manifest: DevicePushManifest,
    packfile: Buffer,
    staged?: { reader: GitObjectReader; promote: () => Promise<void> }
  ): Promise<PushResult> {
    if (this.isGitDurabilityUnavailable()) {
      throw new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.');
    }
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
    return await this.withVaultLock(auth.vault.vault_id, async () => {
      let operationId: string | null = null;
      try {
        const attemptHash = manifest.attempt_id
          ? sha256Hex(Buffer.from(stableJson({ manifest, transport: staged ? 'chunk' : 'direct' })))
          : null;
        const operation = await this.store.mutate((db) => {
          const device = requireDevice(db, auth.device.device_id);
          if (attemptHash) {
            const prior = db.sync_operations.find((candidate) =>
              candidate.vault_id === auth.vault.vault_id && candidate.device_id === device.device_id &&
              candidate.operation_type === 'device_push' && candidate.prepared_manifest?.attempt_id === manifest.attempt_id
            );
            if (prior && prior.prepared_manifest?.attempt_hash !== attemptHash) {
              throw new AuthError(409, 'attempt_mismatch', 'Upload attempt does not match its original request.');
            }
          }
          const priorAdmissions = db.sync_operations.filter((candidate) =>
            candidate.vault_id === auth.vault.vault_id && candidate.device_id === device.device_id &&
            candidate.operation_type === 'device_push' && candidate.target_commit === manifest.target_commit
          );
          // Once a legacy admission is retried, prefer its newly bound operation.
          const admitted = priorAdmissions.find((candidate) => candidate.proposal_base !== undefined) ??
            priorAdmissions.find((candidate) => candidate.status === 'prepared' || candidate.status === 'committed');
          if (admitted?.proposal_base !== undefined &&
              (admitted.prepared_manifest?.requested_base_commit ?? admitted.proposal_base) !== (manifest.base_commit ?? null)) {
            throw new AuthError(409, 'proposal_base_mismatch', 'Proposal base does not match its original admission.');
          }
          if (admitted && stableJson(admitted.prepared_manifest?.rename_pairs ?? null) !== stableJson(manifest.rename_pairs ?? null)) {
            throw new AuthError(409, 'rename_pairs_mismatch', 'Rename pairs do not match their original admission.');
          }
          const started = this.store.startOperation(db, {
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
          if (attemptHash) started.prepared_manifest = { attempt_id: manifest.attempt_id, attempt_hash: attemptHash };
          if (admitted) {
            // Legacy admissions deliberately retain the old retry rule (natural merge base).
            started.proposal_base = admitted.proposal_base ?? null;
            started.prepared_manifest = {
              ...(started.prepared_manifest ?? {}),
              proposal_base: started.proposal_base,
              requested_base_commit: manifest.base_commit ?? null,
              rename_pairs: admitted.prepared_manifest?.rename_pairs ?? null
            };
          }
          return started;
        });
        operationId = operation.operation_id;
        const admittedPairs = operation.prepared_manifest?.rename_pairs;
        const hasAdmittedPairs = Array.isArray(admittedPairs);
        if (hasAdmittedPairs) manifest = { ...manifest, rename_pairs: storedRenamePairs(admittedPairs) };
        if (!staged) {
          if (manifest.packfile_bytes !== packfile.byteLength || packfile.byteLength > this.maxUploadBytes ||
              sha256Hex(packfile) !== manifest.packfile_sha256) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'invalid_packfile', 'Packfile does not match the manifest.');
          }
        }

        const directoryProposal = await this.normalizeDirectoryProposal(
          auth.device.device_id,
          manifest.target_commit,
          manifest.directory_proposal,
          manifest.directory_intents ?? []
        );
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
          if (manifest.rename_pairs?.length && !hasAdmittedPairs) {
            const rejection = await this.validateRenamePairEvidence(
              auth.vault.vault_id, manifest.target_commit, manifest.base_commit ?? null, manifest.rename_pairs,
              this.git.readerForRepo(this.git.repoPath(auth.vault.vault_id))
            );
            if (rejection) return await this.rejectDevicePush(auth, operation.operation_id, rejection, 'Rename pair evidence does not match the proposal trees.');
          }
          return await this.finishExistingDeviceCommit(auth, operation, manifest.target_commit, directoryProposal, manifest);
        }
        if (deviceBlock) {
          return await this.rejectDevicePush(auth, operation.operation_id, deviceBlock.code, deviceBlock.message);
        }

        if (auth.device.onboarding_status === 'pending') {
          if (auth.device.onboarding_mode === 'use_server') {
            return await this.rejectDevicePush(auth, operation.operation_id, 'onboarding_apply_required', 'Apply server state before uploading local changes.');
          }
          if (currentDeviceRef !== null) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'onboarding_completion_required', 'Complete onboarding before publishing another proposal.');
          }
          if (
            !auth.device.initial_proposal_base ||
            !auth.device.initial_proposal_kind ||
            manifest.base_commit !== auth.device.initial_proposal_base
          ) {
            return await this.rejectDevicePush(auth, operation.operation_id, 'invalid_onboarding_proposal', 'Initial onboarding proposal does not match the approved base.');
          }
        }

        const validation = staged
          ? await this.validateUploadReader(auth, operation, manifest, staged.reader, currentDeviceRef, currentMain)
          : await this.validateQuarantinedUpload(auth, operation, manifest, packfile, currentDeviceRef, currentMain);
        if (validation.rejection !== null) return validation.rejection;
        if (validation.deviceRelation === 'superseded' && currentDeviceRef) {
          const result = await this.finishExistingDeviceCommit(auth, operation, manifest.target_commit, directoryProposal, manifest);
          return result.status === 'rejected' ? result : { ...result, device_ref: currentDeviceRef };
        }

        await this.store.mutate((db) => {
          const op = requireOperation(db, operation.operation_id);
          op.status = 'prepared';
          op.proposal_base = operation.proposal_base !== undefined ? operation.proposal_base : manifest.base_commit ?? null;
          op.expected_refs = {
            [auth.device.device_ref]: currentDeviceRef
          };
          op.prepared_manifest = {
            ...(op.prepared_manifest ?? {}),
            actor: { user_id: auth.user.user_id, device_id: auth.device.device_id },
            operation_type: 'device_push',
            proposal_base: op.proposal_base,
            requested_base_commit: manifest.base_commit ?? null,
            rename_pairs: manifest.rename_pairs ?? null,
            expected_device_ref: currentDeviceRef,
            target_commit: manifest.target_commit,
            validation: {
              object_integrity: 'ok',
              path_policy: 'ok',
              changed_path_policy: 'ok',
              fast_forward: validation.deviceRelation,
              base_commit: manifest.base_commit ?? null
            },
            directory_proposal: directoryProposal,
            root_ignore_capability: manifest.root_ignore_capability ?? null,
            root_ignore_oid: manifest.root_ignore_oid ?? null
          };
          op.updated_at = nowIso();
        });

        if (staged) await staged.promote();
        else await this.git.importPack(auth.vault.vault_id, packfile);
        if (validation.deviceRelation === 'divergent' && currentDeviceRef) {
          return await this.acceptDivergentDeviceCommit(
            auth,
            operation.operation_id,
            currentDeviceRef,
            currentMain,
            manifest.target_commit,
            directoryProposal,
            manifest.rename_pairs ?? []
          );
        }
        await this.store.mutate((db) => {
          const op = requireOperation(db, operation.operation_id);
          if (op.status !== 'prepared') throw new Error('Sync operation is not prepared.');
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

        const proposalBaseWasAcknowledged =
          manifest.base_commit !== undefined &&
          manifest.base_commit !== null &&
          (auth.device.last_applied_main === manifest.base_commit ||
            (auth.device.last_applied_main !== null && manifest.client_known_main === manifest.base_commit));
        const detachedProposal =
          auth.device.onboarding_status !== 'pending' &&
          currentDeviceRef === null &&
          manifest.base_commit !== undefined &&
          manifest.base_commit !== null &&
          !proposalBaseWasAcknowledged;
        return await this.mergeDeviceCommit(
          auth.vault.vault_id,
          auth.device.device_id,
          manifest.target_commit,
          refEventSeq,
          operation.proposal_base !== undefined ? operation.proposal_base : manifest.base_commit ?? null,
          detachedProposal,
          directoryProposal,
          manifest
        );
      } catch (error) {
        const mappedError = error instanceof GitDurabilityError
          ? new AuthError(503, 'transfer_unavailable', 'Transfer storage is unavailable.')
          : error;
        if (operationId) {
          const reason = mappedError instanceof AuthError ? mappedError.code : mappedError instanceof GitCommandError ? 'server_git_error' : 'unexpected_error';
          await this.abortOperation(operationId, reason);
        }
        throw mappedError;
      }
    });
  }

  private async normalizeDirectoryProposal(
    deviceId: string,
    targetCommit: string,
    proposal: DirectoryProposal | undefined,
    legacyIntents: DirectoryIntent[]
  ): Promise<DirectoryProposal | null> {
    const db = await this.store.snapshot();
    const device = requireDevice(db, deviceId);
    if (proposal) {
      this.findDirectoryProposalResult(db, device.vault_id, deviceId, proposal);
      if (!(await this.hasUsableDirectoryProposalBaseline(db, device, proposal))) {
        throw new AuthError(409, 'stale_directory_proposal_base', 'Directory proposal does not match the device acknowledged baseline.');
      }
      return proposal;
    }
    if (legacyIntents.length === 0) return null;
    if (!Array.isArray(device.last_applied_explicit_dirs)) {
      throw new AuthError(409, 'directory_snapshot_unavailable', 'The device directory baseline is unavailable.');
    }
    const intents = legacyIntents.map((intent, index): DirectoryProposalIntent => ({
      ...intent,
      intent_id: `legacy_${sha256Hex(Buffer.from(`${intent.op}\0${intent.path}\0${index}`, 'utf8')).slice(0, 24)}`,
      generation: index,
      provenance: 'legacy',
      base_main: device.last_applied_main,
      base_event_seq: device.last_applied_event_seq,
      replaces_intent_id: null,
      recreated_after_delete: false,
      created_at: null
    }));
    const proposalBody = {
      schema_version: 2 as const,
      base_main: device.last_applied_main,
      base_event_seq: device.last_applied_event_seq,
      intents
    };
    return {
      ...proposalBody,
      proposal_id: `dirprop_${sha256Hex(Buffer.from(stableJson([deviceId, targetCommit, proposalBody]), 'utf8'))}`
    };
  }

  private async hasUsableDirectoryProposalBaseline(
    db: MetadataDb,
    device: DeviceRow,
    proposal: DirectoryProposal
  ): Promise<boolean> {
    if (!Array.isArray(device.last_applied_explicit_dirs)) return false;
    if (
      proposal.base_main === device.last_applied_main &&
      proposal.base_event_seq === device.last_applied_event_seq
    ) return true;
    if (
      !Number.isSafeInteger(proposal.base_event_seq) || proposal.base_event_seq < 0 ||
      proposal.base_event_seq >= device.last_applied_event_seq ||
      !hasContiguousDirectoryNeutralEventGap(db, device.vault_id, proposal.base_event_seq, device.last_applied_event_seq)
    ) return false;
    if (proposal.base_main === device.last_applied_main) return true;
    if (!proposal.base_main || !device.last_applied_main) return false;
    return await this.git.commitExists(device.vault_id, proposal.base_main) &&
      await this.git.isAncestor(device.vault_id, proposal.base_main, device.last_applied_main);
  }

  private async classifyDirectoryProposal(
    vaultId: string,
    deviceId: string,
    proposal: DirectoryProposal
  ): Promise<DirectoryMergePlan> {
    const db = await this.store.snapshot();
    const device = requireDevice(db, deviceId);
    if (!Array.isArray(device.last_applied_explicit_dirs) || !(await this.hasUsableDirectoryProposalBaseline(db, device, proposal))) {
      throw new AuthError(409, 'stale_directory_proposal_base', 'Directory proposal does not match the device acknowledged baseline.');
    }
    const requestSha256 = directoryProposalRequestSha256(proposal);
    this.findDirectoryProposalResult(db, vaultId, deviceId, proposal);
    const baseExplicitDirs = [...device.last_applied_explicit_dirs].sort();
    const serverState = db.directory_state_by_vault[vaultId];
    const serverExplicitDirs = [...(serverState?.explicit_dirs ?? [])].sort();
    const serverIntents = directoryIntentsBetweenSnapshots(baseExplicitDirs, serverExplicitDirs);
    const conflictingIntents = proposal.intents.filter((intent) => {
      const serverHasPath = serverExplicitDirs.some((path) => path === intent.path || path.startsWith(`${intent.path}/`));
      const unknownLegacyOutcome = intent.provenance === 'legacy' && (
        (intent.op === 'create' && !serverHasPath) ||
        (intent.op === 'delete' && serverHasPath)
      );
      return unknownLegacyOutcome || serverIntents.some((serverIntent) =>
        serverIntent.op !== intent.op && pathsOverlap(serverIntent.path, intent.path)
      );
    });
    const conflictingIds = new Set(conflictingIntents.map((intent) => intent.intent_id));
    const affectedRoots = topmostDirectoryPaths(conflictingIntents.flatMap((intent) => [
      intent.path,
      ...serverIntents.filter((serverIntent) => serverIntent.op !== intent.op && pathsOverlap(serverIntent.path, intent.path))
        .map((serverIntent) => serverIntent.path)
    ]));
    return {
      proposal,
      requestSha256,
      baseExplicitDirs,
      serverExplicitDirs,
      cleanIntents: proposal.intents.filter((intent) => !conflictingIds.has(intent.intent_id)),
      conflictingIntents,
      affectedRoots,
      expectedEventSeq: serverState?.last_event_seq ?? 0
    };
  }

  private findDirectoryProposalResult(
    db: MetadataDb,
    vaultId: string,
    deviceId: string,
    proposal: DirectoryProposal
  ): DirectoryProposalResultRow | null {
    const result = db.directory_proposal_results.find((candidate) => candidate.proposal_id === proposal.proposal_id) ?? null;
    if (!result) return null;
    if (
      result.vault_id !== vaultId ||
      result.device_id !== deviceId ||
      result.request_sha256 !== directoryProposalRequestSha256(proposal)
    ) {
      throw new AuthError(409, 'directory_proposal_mismatch', 'Directory proposal ID was reused with different content.');
    }
    return result;
  }

  async getConflictReviewPackage(vaultId: string, conflictId: string): Promise<ConflictReviewPackage> {
    const db = await this.store.snapshot();
    const vault = requireVault(db, vaultId);
    const conflict = db.conflicts.find((candidate) => candidate.vault_id === vaultId && candidate.conflict_id === conflictId);
    if (!conflict) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    const device = requireDevice(db, conflict.device_id);
    const pathConflicts = await this.conflictReviewPaths(conflict);
    const files: ConflictReviewFile[] = [];
    for (const path of conflict.affected_paths) {
      const [baseBlob, serverBlob, deviceBlob] = await Promise.all([
        this.readOptionalBlob(vaultId, conflict.base_commit, path),
        this.readOptionalBlob(vaultId, conflict.current_main, path),
        this.readOptionalBlob(vaultId, conflict.device_commit, path)
      ]);
      if (baseBlob === null && serverBlob === null && deviceBlob === null) continue;
      const baseContent = decodeReviewText(baseBlob);
      const serverContent = decodeReviewText(serverBlob);
      const deviceContent = decodeReviewText(deviceBlob);
      const blobs = [baseBlob, serverBlob, deviceBlob];
      const contentKind: ConflictReviewFile['content_kind'] = !blobs.every(
        (blob, index) => blob === null || [baseContent, serverContent, deviceContent][index] !== null
      )
        ? 'binary'
        : blobs.some((blob) => blob !== null && blob.byteLength > MAX_INTERACTIVE_REVIEW_BYTES)
          ? 'large_text'
          : 'text';
      files.push({
        path,
        content_kind: contentKind,
        base_content: contentKind === 'text' ? baseContent : null,
        server_content: contentKind === 'text' ? serverContent : null,
        device_content: contentKind === 'text' ? deviceContent : null,
        base_bytes: baseBlob?.byteLength ?? null,
        server_bytes: serverBlob?.byteLength ?? null,
        device_bytes: deviceBlob?.byteLength ?? null,
        base_sha256: baseBlob === null ? null : sha256Hex(baseBlob),
        server_sha256: serverBlob === null ? null : sha256Hex(serverBlob),
        device_sha256: deviceBlob === null ? null : sha256Hex(deviceBlob),
        source_diff: contentKind === 'text'
          ? buildSourceDiff(serverContent, deviceContent)
          : contentKind === 'large_text'
            ? 'Text preview unavailable because this conflict exceeds the interactive review limit.'
            : 'Binary preview unavailable.',
        rendered_markdown_diff: contentKind === 'text' && path.endsWith('.md') ? buildMarkdownReview(serverContent, deviceContent) : null
      });
    }
    const directoryContext = conflict.directory_context;
    const directoryConflicts = buildDirectoryConflictViews(directoryContext);
    const directoryStale = directoryContext !== undefined &&
      (db.directory_state_by_vault[vaultId]?.last_event_seq ?? 0) !== directoryContext.expected_event_seq;
    return {
      conflict,
      stale: conflict.status === 'open' && (vault.current_main !== conflict.expected_main || directoryStale),
      expected_main: conflict.expected_main,
      current_main: vault.current_main,
      device_name: device.device_name,
      path_conflicts: pathConflicts,
      files,
      directory_conflicts: directoryConflicts,
      choices: conflict.conflict_kind === 'directory' || conflict.conflict_kind === 'mixed'
        ? ['keep_server', 'use_device']
        : ['keep_server', 'use_device', 'keep_both_files', 'insert_both_blocks', 'manual']
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
      if (snapshotVault.status === 'blocked_integrity') {
        throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      }
      const snapshotConflict = snapshot.conflicts.find(
        (candidate) => candidate.vault_id === input.vaultId && candidate.conflict_id === input.conflictId
      );
      if (!snapshotConflict) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      const currentDirectoryState = snapshot.directory_state_by_vault[input.vaultId];
      const needsDirectoryRefresh = snapshotConflict.directory_context !== undefined &&
        snapshotConflict.directory_context.expected_event_seq !== (currentDirectoryState?.last_event_seq ?? 0);
      const needsRefresh =
        snapshotConflict.status === 'open' &&
        (snapshotConflict.expected_main !== snapshotVault.current_main ||
          snapshotConflict.current_main !== snapshotVault.current_main ||
          needsDirectoryRefresh);
      const refreshedDirectoryContext = needsDirectoryRefresh && snapshotConflict.directory_context
        ? reclassifyDirectoryContext(
            snapshotConflict.directory_context,
            currentDirectoryState?.explicit_dirs ?? [],
            currentDirectoryState?.last_event_seq ?? 0
          )
        : snapshotConflict.directory_context;
      const priorDirectoryRoots = new Set(snapshotConflict.directory_context?.affected_roots ?? []);
      const refreshedFilePaths = (needsRefresh
        ? await this.refreshedAffectedPaths(snapshotConflict, snapshotVault.current_main)
        : snapshotConflict.affected_paths)
        .filter((path) => !priorDirectoryRoots.has(path));
      const refreshedAffectedPaths = [...new Set([
        ...refreshedFilePaths,
        ...(refreshedDirectoryContext?.affected_roots ?? [])
      ])].sort();
      if (!needsRefresh) return;

      const previousExpectedMain = snapshotConflict.expected_main;
      const refreshedMain = snapshotVault.current_main;
      const protectedCurrentRef = conflictProtectionRef(input.conflictId, 'current');
      if ((await this.git.getRef(input.vaultId, protectedCurrentRef)) !== previousExpectedMain) {
        await this.store.mutate((db) => {
          const vault = requireVault(db, input.vaultId);
          vault.status = 'blocked_integrity';
          vault.updated_at = nowIso();
        });
        throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
      }

      const operationId = await this.store.mutate((db) => {
        const vault = requireVault(db, input.vaultId);
        if (vault.status === 'blocked_integrity') {
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        const conflict = requireConflict(db, input.vaultId, input.conflictId);
        if (
          conflict.status !== 'open' ||
          conflict.current_main !== previousExpectedMain ||
          conflict.expected_main !== previousExpectedMain ||
          vault.current_main !== refreshedMain
        ) {
          throw new AuthError(409, 'stale_conflict_review', 'Conflict review changed while it was being refreshed.');
        }
        const operation = this.store.startOperation(db, {
          vault_id: input.vaultId,
          device_id: conflict.device_id,
          operation_type: 'conflict_refresh',
          expected_refs: { [protectedCurrentRef]: previousExpectedMain },
          target_refs: { [protectedCurrentRef]: refreshedMain },
          target_commit: refreshedMain
        });
        operation.status = 'prepared';
        operation.prepared_manifest = {
          conflict_id: input.conflictId,
          actor_user_id: input.actorUserId,
          previous_main: previousExpectedMain,
          refreshed_main: refreshedMain,
          affected_paths: refreshedAffectedPaths,
          refreshed_directory_context: refreshedDirectoryContext ?? null,
          target_refs: { [protectedCurrentRef]: refreshedMain }
        };
        operation.updated_at = nowIso();
        return operation.operation_id;
      });

      try {
        await this.git.updateRef(input.vaultId, protectedCurrentRef, refreshedMain, previousExpectedMain);
      } catch (error) {
        const actualRef = await this.git.getRef(input.vaultId, protectedCurrentRef);
        if (actualRef === previousExpectedMain) {
          await this.abortOperation(operationId, 'conflict_refresh_ref_not_moved');
          throw error;
        }
        if (actualRef !== refreshedMain) {
          await this.blockPreparedOperationForIntegrity(operationId, 'conflict refresh ref cannot be reconciled');
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
      }

      await this.store.mutate((db) => {
        const operation = requireOperation(db, operationId);
        const vault = requireVault(db, input.vaultId);
        const conflict = requireConflict(db, input.vaultId, input.conflictId);
        if (vault.status === 'blocked_integrity') {
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        if (
          operation.status !== 'prepared' ||
          conflict.status !== 'open' ||
          conflict.current_main !== previousExpectedMain ||
          conflict.expected_main !== previousExpectedMain
        ) {
          throw new Error('Prepared conflict refresh metadata is no longer compatible.');
        }
        conflict.current_main = refreshedMain;
        conflict.expected_main = refreshedMain;
        conflict.affected_paths = refreshedAffectedPaths;
        conflict.affected_path_count = refreshedAffectedPaths.length;
        if (refreshedDirectoryContext) conflict.directory_context = refreshedDirectoryContext;
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
            main: refreshedMain,
            device_commit: conflict.device_commit
          },
          payload: { conflict_id: input.conflictId }
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
        operation.status = 'committed';
        operation.result = {
          decision: 'refreshed',
          conflict_id: input.conflictId,
          previous_main: previousExpectedMain,
          refreshed_main: refreshedMain
        };
        operation.updated_at = nowIso();
      });
    });
    return await this.getConflictReviewPackage(input.vaultId, input.conflictId);
  }

  private loadResolutionConflict(
    snapshot: MetadataDb,
    input: { vaultId: string; conflictId: string; expectedMain: string; resolutionKind: ConflictResolutionKind },
    options: { allowResolved?: boolean } = {}
  ): ConflictRecord {
    const vault = requireVault(snapshot, input.vaultId);
    if (vault.status === 'blocked_integrity') {
      throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
    }
    const conflict = snapshot.conflicts.find(
      (candidate) => candidate.vault_id === input.vaultId && candidate.conflict_id === input.conflictId
    );
    if (!conflict) {
      throw new AuthError(404, 'not_found', 'Resource not found.');
    }
    if (conflict.status === 'resolved') {
      if (options.allowResolved) return conflict;
      throw new AuthError(409, 'conflict_already_resolved', 'Conflict has already been resolved.');
    }
    const currentDirectoryEventSeq = snapshot.directory_state_by_vault[input.vaultId]?.last_event_seq ?? 0;
    if (
      conflict.expected_main !== input.expectedMain ||
      vault.current_main !== input.expectedMain ||
      (conflict.directory_context !== undefined && conflict.directory_context.expected_event_seq !== currentDirectoryEventSeq)
    ) {
      throw new AuthError(409, 'stale_conflict_review', 'Conflict review is stale; refresh before resolving.');
    }
    if (
      (conflict.conflict_kind === 'directory' || conflict.conflict_kind === 'mixed') &&
      input.resolutionKind !== 'keep_server' && input.resolutionKind !== 'use_device'
    ) {
      throw new AuthError(400, 'invalid_resolution', 'Directory conflicts require a server or device resolution.');
    }
    return conflict;
  }

  async previewConflictResolution(input: {
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
    manualFilePlan?: ManualFilePlanEntry[];
  }): Promise<ConflictResolutionPreview> {
    return await this.withVaultLock(input.vaultId, async () => {
      const snapshot = await this.store.snapshot();
      const conflict = this.loadResolutionConflict(snapshot, input);
      const artifacts = await this.buildResolutionArtifacts(conflict, input.resolutionKind, input.manualFiles, input.manualFilePlan);
      await this.git.validateTreeRootIgnorePolicy(input.vaultId, artifacts.tree, this.maxUploadBytes);
      return {
        conflict_id: conflict.conflict_id,
        resolution_kind: input.resolutionKind,
        expected_main: conflict.expected_main,
        current_main: conflict.expected_main,
        tree: artifacts.tree,
        files: await this.describeResolutionPreview(conflict, input.resolutionKind, artifacts),
        directory_conflicts: buildDirectoryConflictViews(conflict.directory_context).map((view) => ({
          ...view,
          outcome: input.resolutionKind === 'use_device' ? 'device' as const : 'server' as const
        }))
      };
    });
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
    const authoredBase = await this.git.mergeBase(conflict.vault_id, currentMain, conflict.device_commit) ?? conflict.base_commit;
    const deviceChanges = await this.git.changedPaths(conflict.vault_id, authoredBase, conflict.device_commit);
    return [...new Set([...conflict.affected_paths, ...intersectChangedPaths(mainChanges, deviceChanges)])].sort();
  }

  async resolveConflict(input: {
    actorUserId: string;
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    expectedTree?: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
    manualFilePlan?: ManualFilePlanEntry[];
  }): Promise<ResolveConflictResponse> {
    const requestHash = resolutionRequestHash(input);
    return await this.withVaultLock(input.vaultId, async () => {
      const snapshot = await this.store.snapshot();
      const conflict = this.loadResolutionConflict(snapshot, input, { allowResolved: true });
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
      const resolvedDirectoryIntents = resolvedConflictDirectoryIntents(conflict, input.resolutionKind);

      const tree = await this.buildResolutionTree(conflict, input.resolutionKind, input.manualFiles, input.manualFilePlan);
      if (input.expectedTree !== undefined && tree !== input.expectedTree) {
        throw new AuthError(409, 'stale_conflict_preview', 'The reviewed resolution result changed; review the result again.');
      }
      await this.git.validateTreeRootIgnorePolicy(input.vaultId, tree, this.maxUploadBytes);

      const preparation = await this.store.mutate((db) => {
        const mutableVault = requireVault(db, input.vaultId);
        if (mutableVault.status === 'blocked_integrity') {
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
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
          actor_user_id: input.actorUserId,
          decision: 'resolved',
          resolution_kind: input.resolutionKind,
          resolution_request_hash: requestHash,
          validator_results: {
            accepted_tree: tree,
            expected_main_matches: true
          },
          resolved_directory_intents: resolvedDirectoryIntents,
          directory_proposal: conflict.directory_context?.proposal ?? null
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
          resolutionKind: input.resolutionKind,
          deviceId: conflict.device_id,
          userId: input.actorUserId
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
            merge_policy_version: mutableConflict.merge_policy_version,
            ...directoryResolutionEventPayload(mutableConflict, resolvedDirectoryIntents)
          }
        });
        applyDirectoryIntents(db, input.vaultId, resolvedDirectoryIntents, mainEvent.event_seq);
        resolveDirectoryProposalResult(db, mutableConflict, mainEvent.event_seq);
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
            resolution_kind: input.resolutionKind,
            ...(mutableConflict.directory_context
              ? { directory_proposal_id: mutableConflict.directory_context.proposal.proposal_id }
              : {})
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

      this.log.emit('info', 'conflict_resolved', {
        vault_id: input.vaultId, conflict_id: input.conflictId, resolution: input.resolutionKind, user_id: input.actorUserId
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
    targetCommit: string,
    directoryProposal: DirectoryProposal | null,
    manifest: DevicePushManifest
  ): Promise<PushResult> {
    const main = await this.git.getRef(auth.vault.vault_id, 'refs/heads/main');
    if (!main) {
      await this.abortOperation(operation.operation_id, 'missing_main');
      return { status: 'rejected', code: 'missing_main', message: 'Server main is missing.' };
    }
    const snapshot = await this.store.snapshot();
    const existingResult = directoryProposal
      ? this.findDirectoryProposalResult(snapshot, auth.vault.vault_id, auth.device.device_id, directoryProposal)
      : null;
    const existingConflict = await this.findOpenConflict(auth.vault.vault_id, auth.device.device_id, targetCommit);
    const fallbackEventSeq = this.latestEventSeq(auth.vault.vault_id, snapshot);
    if (!existingConflict && !existingResult &&
      (!(await this.git.isAncestor(auth.vault.vault_id, targetCommit, main)) || directoryProposal)) {
      const rejection = await this.checkRootIgnoreAdmission(auth, operation.operation_id, manifest, main);
      if (rejection) return rejection;
    }
    await this.store.mutate((db) => {
      const op = requireOperation(db, operation.operation_id);
      op.status = 'committed';
      op.result = { idempotent: true, target_commit: targetCommit };
      op.proposal_base = operation.proposal_base ?? null;
      op.prepared_manifest = {
        ...(op.prepared_manifest ?? {}),
        proposal_base: op.proposal_base,
        requested_base_commit: manifest.base_commit ?? null,
        rename_pairs: op.prepared_manifest?.rename_pairs ?? manifest.rename_pairs ?? null,
        root_ignore_capability: manifest.root_ignore_capability ?? null,
        root_ignore_oid: manifest.root_ignore_oid ?? null,
        directory_proposal: directoryProposal
      };
      op.updated_at = nowIso();
    });
    if (existingConflict || existingResult?.status === 'conflicted') {
      const conflictId = existingConflict?.conflict_id ?? existingResult?.conflict_id;
      if (!conflictId) throw new Error('Conflicted directory proposal is missing its conflict ID.');
      return {
        status: 'conflicted',
        conflict_id: conflictId,
        device_ref: targetCommit,
        main,
        event_seq: existingResult?.event_seq ?? fallbackEventSeq,
        ...(directoryProposal ? { directory_ack: proposalAcknowledgement(directoryProposal, 'conflicted') } : {})
      };
    }
    if (!(await this.git.isAncestor(auth.vault.vault_id, targetCommit, main))) {
      return await this.mergeDeviceCommit(
        auth.vault.vault_id,
        auth.device.device_id,
        targetCommit,
        fallbackEventSeq,
        operation.proposal_base ?? null,
        false,
        directoryProposal,
        manifest
      );
    }
    if (directoryProposal && !existingResult) {
      return await this.mergeDeviceCommit(
        auth.vault.vault_id,
        auth.device.device_id,
        targetCommit,
        fallbackEventSeq,
        operation.proposal_base ?? null,
        false,
        directoryProposal,
        manifest
      );
    }
    return {
      status: 'noop',
      device_ref: targetCommit,
      main,
      event_seq: existingResult?.event_seq ?? fallbackEventSeq,
      ...(directoryProposal ? { directory_ack: proposalAcknowledgement(directoryProposal, 'duplicate') } : {})
    };
  }

  private async hasRootIgnoreAdmission(
    vaultId: string,
    commit: string,
    main: string,
    attestation: Pick<DevicePushManifest, 'root_ignore_capability' | 'root_ignore_oid'> | null
  ): Promise<boolean> {
    const proposed = await this.git.readRootIgnoreBlob(vaultId, commit);
    const canonical = await this.git.readRootIgnoreBlob(vaultId, main);
    if (attestation?.root_ignore_capability !== 'root-ignore-v1' || attestation.root_ignore_oid === undefined) {
      return proposed.oid === null && canonical.oid === null;
    }
    if (attestation.root_ignore_oid !== proposed.oid) return false;
    await this.git.validateTreeRootIgnorePolicy(vaultId, commit, this.maxUploadBytes);
    return true;
  }

  private async checkRootIgnoreAdmission(
    auth: AuthenticatedDevice,
    operationId: string,
    manifest: DevicePushManifest,
    main: string
  ): Promise<PushResult | null> {
    try {
      if (await this.hasRootIgnoreAdmission(auth.vault.vault_id, manifest.target_commit, main, manifest)) return null;
      const code = manifest.root_ignore_capability === 'root-ignore-v1' && manifest.root_ignore_oid !== undefined
        ? 'root_ignore_oid_mismatch' : 'root_ignore_capability_required';
      return await this.rejectDevicePush(auth, operationId, code,
        code === 'root_ignore_oid_mismatch' ? 'Root ignore identity does not match the proposed tree.' : 'Root ignore capability is required.');
    } catch (error) {
      if (!(error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError)) throw error;
      return await this.rejectDevicePush(auth, operationId, error.code, 'Uploaded commit violates the root ignore policy.');
    }
  }

  private async validateQuarantinedUpload(
    auth: AuthenticatedDevice,
    operation: SyncOperationRow,
    manifest: DevicePushManifest,
    packfile: Buffer,
    currentDeviceRef: string | null,
    currentMain: string
  ): Promise<UploadValidation> {
    try {
      return await this.git.withQuarantinedPack(auth.vault.vault_id, packfile, async (reader) =>
        await this.validateUploadReader(auth, operation, manifest, reader, currentDeviceRef, currentMain)
      );
    } catch (error) {
      if (!(error instanceof GitMalformedPackError)) throw error;
      return {
        rejection: await this.rejectDevicePush(auth, operation.operation_id, 'malformed_packfile', 'Malformed Git packfile.'),
        deviceRelation: 'divergent'
      };
    }
  }

  private async validateRenamePairEvidence(
    vaultId: string,
    targetCommit: string,
    baseCommit: string | null,
    pairs: NonNullable<DevicePushManifest['rename_pairs']>,
    reader: GitObjectReader
  ): Promise<string | null> {
    if (!baseCommit) return 'rename_base_required';
    if (!(await reader.commitExists(vaultId, baseCommit)) || !(await reader.commitExists(vaultId, targetCommit))) return 'invalid_rename_pair';
    if (!(await reader.isAncestor(vaultId, baseCommit, targetCommit))) return 'invalid_rename_pair';
    const main = await this.git.getRef(vaultId, 'refs/heads/main');
    if (!main || !(await reader.isAncestor(vaultId, baseCommit, main))) return 'untrusted_base_commit';
    const [basePaths, targetPaths, naturalBase] = await Promise.all([
      reader.listTreePaths(vaultId, baseCommit), reader.listTreePaths(vaultId, targetCommit),
      reader.mergeBase(vaultId, main, targetCommit)
    ]);
    if (!naturalBase) return 'no_merge_base';
    const [naturalBasePaths, naturalChanges] = await Promise.all([
      reader.listTreePaths(vaultId, naturalBase), reader.changedPaths(vaultId, naturalBase, targetCommit)
    ]);
    const naturalStart = new Set(naturalBasePaths);
    const naturalPaths = new Set(changedPathSet(naturalChanges));
    const base = new Set(basePaths);
    const target = new Set(targetPaths);
    for (const pair of pairs) {
      if (!base.has(pair.source_path) || base.has(pair.destination_path) ||
          target.has(pair.source_path) || !target.has(pair.destination_path) ||
          !naturalStart.has(pair.source_path) || naturalStart.has(pair.destination_path) ||
          !naturalPaths.has(pair.source_path) || !naturalPaths.has(pair.destination_path)) return 'invalid_rename_pair';
    }
    return null;
  }

  private async validateUploadReader(
    auth: AuthenticatedDevice,
    operation: SyncOperationRow,
    manifest: DevicePushManifest,
    reader: GitObjectReader,
    currentDeviceRef: string | null,
    currentMain: string
  ): Promise<UploadValidation> {
    try {
      if (!(await reader.commitExists(auth.vault.vault_id, manifest.target_commit))) {
        return {
          rejection: await this.rejectDevicePush(
            auth,
            operation.operation_id,
            'missing_target_commit',
            'Target commit is not present.'
          ),
          deviceRelation: 'divergent'
        };
      }
      try {
        await reader.validateTreePathPolicy(auth.vault.vault_id, manifest.target_commit, this.maxUploadBytes);
      } catch (error) {
        if (!(error instanceof PathPolicyViolation)) throw error;
        const code = error.code;
        return {
          rejection: await this.rejectDevicePush(
            auth,
            operation.operation_id,
            code,
            'Uploaded commit violates the vault path policy.'
          ),
          deviceRelation: 'divergent'
        };
      }
      const alreadyPinnedLegacy = manifest.root_ignore_capability === undefined && currentDeviceRef !== null &&
        await this.git.commitExists(auth.vault.vault_id, manifest.target_commit) &&
        await this.git.isAncestor(auth.vault.vault_id, manifest.target_commit, currentMain) &&
        (!manifest.directory_proposal || !!this.findDirectoryProposalResult(
          await this.store.snapshot(), auth.vault.vault_id, auth.device.device_id, manifest.directory_proposal
        ));
      if (!alreadyPinnedLegacy) {
        try {
          const proposedPolicy = await reader.readRootIgnoreBlob(auth.vault.vault_id, manifest.target_commit);
          const canonicalPolicy = await this.git.readRootIgnoreBlob(auth.vault.vault_id, currentMain);
          if (manifest.root_ignore_capability !== 'root-ignore-v1' || manifest.root_ignore_oid === undefined) {
            if (proposedPolicy.oid !== null || canonicalPolicy.oid !== null) {
              return {
                rejection: await this.rejectDevicePush(auth, operation.operation_id, 'root_ignore_capability_required', 'Root ignore capability is required.'),
                deviceRelation: 'divergent'
              };
            }
          } else {
            if (manifest.root_ignore_oid !== proposedPolicy.oid) {
              return {
                rejection: await this.rejectDevicePush(auth, operation.operation_id, 'root_ignore_oid_mismatch', 'Root ignore identity does not match the proposed tree.'),
                deviceRelation: 'divergent'
              };
            }
            await reader.validateTreeRootIgnorePolicy(auth.vault.vault_id, manifest.target_commit, this.maxUploadBytes);
          }
        } catch (error) {
          if (!(error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError)) throw error;
          const code = error.code;
          return {
            rejection: await this.rejectDevicePush(auth, operation.operation_id, code, 'Uploaded commit violates the root ignore policy.'),
            deviceRelation: 'divergent'
          };
        }
      }
      if (manifest.rename_pairs?.length) {
        const reason = await this.validateRenamePairEvidence(
          auth.vault.vault_id, manifest.target_commit, manifest.base_commit ?? null, manifest.rename_pairs, reader
        );
        if (reason) {
          return {
            rejection: await this.rejectDevicePush(auth, operation.operation_id, reason, 'Rename pair evidence does not match the proposal trees.'),
            deviceRelation: 'divergent'
          };
        }
      }
      if (manifest.base_commit) {
        if (!(await reader.commitExists(auth.vault.vault_id, manifest.base_commit))) {
          return {
            rejection: await this.rejectDevicePush(auth, operation.operation_id, 'untrusted_base_commit', 'Proposal base is not trusted vault history.'),
            deviceRelation: 'divergent'
          };
        }
        if (!(await reader.isAncestor(auth.vault.vault_id, manifest.base_commit, currentMain))) {
          return {
            rejection: await this.rejectDevicePush(auth, operation.operation_id, 'untrusted_base_commit', 'Proposal base is not trusted vault history.'),
            deviceRelation: 'divergent'
          };
        }
        if (!(await reader.isAncestor(auth.vault.vault_id, manifest.base_commit, manifest.target_commit))) {
          return {
            rejection: await this.rejectDevicePush(auth, operation.operation_id, 'invalid_base_commit', 'Proposal base is not an ancestor of the uploaded commit.'),
            deviceRelation: 'divergent'
          };
        }
      }
      const deviceRelation = currentDeviceRef === null
        ? 'initial'
        : await reader.isAncestor(auth.vault.vault_id, currentDeviceRef, manifest.target_commit)
          ? 'fast_forward'
          : await reader.isAncestor(auth.vault.vault_id, manifest.target_commit, currentDeviceRef)
            ? 'superseded'
            : 'divergent';
      return { rejection: null, deviceRelation };
    } catch (error) {
      if (!(error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError)) throw error;
      return {
        rejection: await this.rejectDevicePush(auth, operation.operation_id, error.code, 'Uploaded commit violates the vault policy.'),
        deviceRelation: 'divergent'
      };
    }
  }

  private async mergeDeviceCommit(
    vaultId: string,
    deviceId: string,
    deviceCommit: string,
    fallbackEventSeq: number,
    proposalBase: string | null = null,
    detachedProposal = false,
    directoryProposal: DirectoryProposal | null = null,
    attestation: Pick<DevicePushManifest, 'root_ignore_capability' | 'root_ignore_oid' | 'rename_pairs'> | null = null
  ): Promise<PushResult> {
    const renamePairs = attestation?.rename_pairs ?? [];
    const main = await this.git.getRef(vaultId, 'refs/heads/main');
    if (!main) {
      return { status: 'rejected', code: 'missing_main', message: 'Server main is missing.' };
    }
    if (await this.git.isAncestor(vaultId, deviceCommit, main)) {
      const snapshot = await this.store.snapshot();
      const proposalResult = directoryProposal
        ? this.findDirectoryProposalResult(snapshot, vaultId, deviceId, directoryProposal)
        : null;
      if (directoryProposal && !proposalResult) {
        if (!(await this.hasRootIgnoreAdmission(vaultId, deviceCommit, main, attestation))) {
          return await this.createConflict(vaultId, deviceId, main, main, deviceCommit,
            ['.gitignore'], 'root_ignore_capability_required', null, deviceCommit, renamePairs);
        }
        const directoryPlan = await this.classifyDirectoryProposal(vaultId, deviceId, directoryProposal);
        if (directoryPlan.affectedRoots.length > 0) {
          return await this.createConflict(
            vaultId,
            deviceId,
            directoryProposal.base_main ?? main,
            main,
            deviceCommit,
            directoryPlan.affectedRoots,
            'directory_overlap',
            directoryPlan,
            undefined,
            renamePairs
          );
        }
        const acceptedEventSeq = await this.store.mutate((db) => {
          const device = requireDevice(db, deviceId);
          device.status = 'synced';
          const event = this.store.appendEvent(db, {
            event_type: 'main_advanced',
            vault_id: vaultId,
            resource_ids: { device_id: deviceId },
            commit_cursors: { previous_main: main, main, device_commit: deviceCommit },
            payload: {
              decision: 'directory_metadata_merged',
              ...directoryEventPayload(directoryPlan, deviceId)
            }
          });
          commitDirectoryPlan(db, vaultId, deviceId, deviceCommit, directoryPlan, event.event_seq);
          return event.event_seq;
        });
        return {
          status: 'noop',
          device_ref: deviceCommit,
          main,
          event_seq: acceptedEventSeq,
          directory_ack: proposalAcknowledgement(directoryProposal, 'accepted')
        };
      }
      const eventSeq = await this.store.mutate((db) => {
        const device = requireDevice(db, deviceId);
        device.status = 'synced';
        return this.latestEventSeq(vaultId, db);
      });
      return {
        status: 'noop',
        device_ref: deviceCommit,
        main,
        event_seq: (proposalResult?.event_seq ?? eventSeq) || fallbackEventSeq,
        ...(directoryProposal ? { directory_ack: proposalAcknowledgement(directoryProposal, 'duplicate') } : {})
      };
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

    if (!(await this.hasRootIgnoreAdmission(vaultId, deviceCommit, main, attestation))) {
      return await this.createConflict(vaultId, deviceId, main, main, deviceCommit,
        ['.gitignore'], 'root_ignore_capability_required', null, deviceCommit, renamePairs);
    }

    const naturalBase = await this.git.mergeBase(vaultId, main, deviceCommit);
    let base = proposalBase;
    if (base) {
      const baseIsValid =
        (await this.git.commitExists(vaultId, base)) &&
        (await this.git.isAncestor(vaultId, base, main)) &&
        (await this.git.isAncestor(vaultId, base, deviceCommit));
      if (!baseIsValid) {
        return await this.createConflict(vaultId, deviceId, '', main, deviceCommit, [], 'invalid_proposal_base', null, deviceCommit, renamePairs);
      }
    } else {
      base = naturalBase;
    }
    if (!base || !naturalBase) {
      return await this.createConflict(vaultId, deviceId, '', main, deviceCommit, [], 'no_merge_base', null, deviceCommit, renamePairs);
    }

    const directoryPlan = directoryProposal
      ? await this.classifyDirectoryProposal(vaultId, deviceId, directoryProposal)
      : null;
    const metadataRules = await this.metadataConflictRules(vaultId);
    const mainChanges = await this.git.changedPaths(vaultId, base, main);
    const deviceChanges = await this.git.changedPaths(vaultId, naturalBase, deviceCommit);
    const [mainEntries, deviceEntries] = await Promise.all([
      this.git.listTreeEntries(vaultId, main, true), this.git.listTreeEntries(vaultId, deviceCommit, true)
    ]);
    const mainValues = new Map(mainEntries.map((entry) => [entry.path, entry]));
    const deviceValues = new Map(deviceEntries.map((entry) => [entry.path, entry]));
    for (const pair of renamePairs) {
      const source = mainValues.has(pair.source_path);
      const destination = mainValues.has(pair.destination_path);
      if (source === destination) {
        const competingPath = mainChanges.find((entry) => entry.oldPath === pair.source_path)?.path;
        return await this.createConflict(vaultId, deviceId, base, main, deviceCommit,
          [...new Set([pair.source_path, pair.destination_path, ...(competingPath ? [competingPath] : [])])].sort(),
          source ? 'rename_destination_occupied' : 'competing_rename', directoryPlan, undefined, renamePairs);
      }
      if (!source && destination) {
        const [baseBlobs, currentBlobs] = await Promise.all([
          this.blobOidMap(vaultId, base), this.blobOidMap(vaultId, main)
        ]);
        const currentSummary = await summarizeStructuralChanges({
          baseCommit: base, targetCommit: main, changes: mainChanges, baseBlobs, targetBlobs: currentBlobs,
          readBlob: async (commit, path) => await this.readOptionalBlob(vaultId, commit, path)
        });
        const lineage = currentSummary.renameCandidatesByBasePath.get(pair.source_path) ?? new Set<string>();
        const samePairLineage = lineage.size === 1 && lineage.has(pair.destination_path) &&
          mainValues.get(pair.destination_path)?.type === 'blob';
        if (!samePairLineage) {
          return await this.createConflict(vaultId, deviceId, base, main, deviceCommit,
            [...new Set([pair.source_path, pair.destination_path, ...lineage])].sort(), 'competing_rename', directoryPlan, undefined, renamePairs);
        }
      }
    }
    const identicalPaths = new Set([...changedPathSet(deviceChanges)].filter((path) => {
      const left = mainValues.get(path);
      const right = deviceValues.get(path);
      return left?.type === right?.type && left?.oid === right?.oid;
    }));
    const divergentDeviceChanges = changesWithoutIdentities(deviceChanges, identicalPaths);
    const divergentMainChanges = changesWithoutIdentities(mainChanges, identicalPaths);
    if (detachedProposal && hasDestructiveChanges(deviceChanges)) {
      return await this.createConflict(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        destructiveChangedPaths(deviceChanges),
        'detached_proposal_deletes',
        directoryPlan,
        undefined,
        renamePairs
      );
    }
    const explicitRenameEndpoints = new Set(renamePairs.flatMap((pair) => [pair.source_path, pair.destination_path]));
    const structuralMainChanges = explicitRenameEndpoints.size === 0 ? mainChanges : mainChanges.filter((entry) =>
      !explicitRenameEndpoints.has(entry.path) && !(entry.oldPath && explicitRenameEndpoints.has(entry.oldPath)));
    const structuralDeviceChanges = explicitRenameEndpoints.size === 0 ? deviceChanges : deviceChanges.filter((entry) =>
      !explicitRenameEndpoints.has(entry.path) && !(entry.oldPath && explicitRenameEndpoints.has(entry.oldPath)));
    const { conflict: structuralConflict, mainRenames } = await this.classifyStructuralMergeConflict(
      vaultId,
      base,
      main,
      deviceCommit,
      structuralMainChanges,
      structuralDeviceChanges,
      naturalBase,
      identicalPaths
    );
    if (structuralConflict) {
      const affectedPaths = directoryPlan && directoryPlan.affectedRoots.length > 0
        ? [...new Set([...structuralConflict.affectedPaths, ...directoryPlan.affectedRoots])].sort()
        : structuralConflict.affectedPaths;
      return await this.createConflict(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        affectedPaths,
        directoryPlan && directoryPlan.affectedRoots.length > 0 ? 'mixed_directory_overlap' : structuralConflict.reason,
        directoryPlan,
        undefined,
        renamePairs
      );
    }
    const overlapping = intersectChangedPaths(divergentMainChanges, divergentDeviceChanges);
    if (directoryPlan && directoryPlan.affectedRoots.length > 0) {
      const fileAffected = overlapping;
      return await this.createConflict(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        [...new Set([...fileAffected, ...directoryPlan.affectedRoots])].sort(),
        fileAffected.length > 0 ? 'mixed_directory_overlap' : 'directory_overlap',
        directoryPlan,
        undefined,
        renamePairs
      );
    }
    const identicalOverlaps = intersectChangedPaths(mainChanges, deviceChanges).filter((path) => identicalPaths.has(path));
    if (overlapping.length === 0 && identicalOverlaps.length > 0) {
      const identityMerge = renamePairs.length === 0 ? await this.tryIdentityOverlappingMerge(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        deviceChanges,
        identicalOverlaps,
        directoryPlan
      ) : null;
      if (identityMerge) {
        return identityMerge;
      }
    }
    if (overlapping.length > 0) {
      const cleanMerge = await this.tryCleanOverlappingMerge(
        vaultId,
        deviceId,
        base,
        main,
        deviceCommit,
        deviceChanges,
        overlapping,
        directoryPlan,
        naturalBase,
        mainRenames,
        metadataRules,
        attestation?.rename_pairs ?? []
      );
      if (cleanMerge) {
        return cleanMerge;
      }
      const conflictPaths = [...new Set([...overlapping, ...explicitRenameEndpoints])].sort();
      return await this.createConflict(vaultId, deviceId, base, main, deviceCommit, conflictPaths, 'overlapping_paths', directoryPlan, undefined, renamePairs);
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
        },
        directory_plan: storedDirectoryPlan(directoryPlan)
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });
    let mergeCommit: string | null = null;
    try {
      const mergeTree = await this.git.createDisjointMergeTree(vaultId, naturalBase, main, deviceCommit);
      mergeCommit = await this.git.createMergeCommitObjectFromTree({
        vaultId,
        tree: mergeTree,
        base,
        currentMain: main,
        deviceCommit,
        mergeSequence: mergePreparation.mergeSequence,
        deviceId,
        strategy: 'disjoint_overlay'
      });
      await this.git.validateTreeRootIgnorePolicy(vaultId, mergeCommit, this.maxUploadBytes);
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, main);
    } catch (error) {
      if (error instanceof GitDurabilityError) throw error;
      const actualMain = await this.git.getRef(vaultId, 'refs/heads/main');
      if (!mergeCommit || actualMain !== mergeCommit) {
        if (actualMain !== main) {
          await this.blockPreparedOperationForIntegrity(mergePreparation.operationId, 'merge main ref cannot be reconciled');
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        await this.abortOperation(mergePreparation.operationId, 'merge_git_error');
        if (error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError) {
          return await this.createConflict(vaultId, deviceId, base, main, deviceCommit,
            policyConflictPaths(error), 'root_ignore_merge_policy', directoryPlan, undefined, renamePairs);
        }
        throw error;
      }
    }
    if (!mergeCommit) throw new Error('Prepared merge did not produce a commit.');
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
          changed_path_count: changedPathSet(deviceChanges).size,
          ...directoryEventPayload(directoryPlan, deviceId)
        }
      });
      commitDirectoryPlan(db, vaultId, deviceId, deviceCommit, directoryPlan, event.event_seq);
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
      event_seq: eventSeq,
      ...(directoryPlan ? { directory_ack: proposalAcknowledgement(directoryPlan.proposal, 'accepted') } : {})
    };
  }

  private async conflictReviewPaths(conflict: ConflictRecord): Promise<ConflictReviewPath[]> {
    if (
      !(await this.git.commitExists(conflict.vault_id, conflict.base_commit)) ||
      !(await this.git.commitExists(conflict.vault_id, conflict.current_main)) ||
      !(await this.git.commitExists(conflict.vault_id, conflict.device_commit))
    ) {
      return fallbackConflictReviewPaths(conflict.affected_paths, new Map(), new Map(), new Map());
    }
    const [baseBlobs, currentBlobs, deviceBlobs] = await Promise.all([
      this.blobOidMap(conflict.vault_id, conflict.base_commit),
      this.blobOidMap(conflict.vault_id, conflict.current_main),
      this.blobOidMap(conflict.vault_id, conflict.device_commit)
    ]);
    const [mainChanges, deviceChanges] = await Promise.all([
      this.git.changedPaths(conflict.vault_id, conflict.base_commit, conflict.current_main),
      this.git.changedPaths(conflict.vault_id, conflict.base_commit, conflict.device_commit)
    ]);
    const readBlob = async (commit: string, path: string): Promise<Buffer | null> =>
      await this.readOptionalBlob(conflict.vault_id, commit, path);
    const mainSummary = await summarizeStructuralChanges({
      baseCommit: conflict.base_commit,
      targetCommit: conflict.current_main,
      changes: mainChanges,
      baseBlobs,
      targetBlobs: currentBlobs,
      readBlob
    });
    const deviceSummary = await summarizeStructuralChanges({
      baseCommit: conflict.base_commit,
      targetCommit: conflict.device_commit,
      changes: deviceChanges,
      baseBlobs,
      targetBlobs: deviceBlobs,
      readBlob
    });
    applyExplicitRenamePairsToSummary(deviceSummary, conflict.rename_pairs ?? [], baseBlobs, deviceBlobs);
    return buildConflictReviewPaths({
      reason: typeof conflict.validator_results.reason === 'string' ? conflict.validator_results.reason : 'overlapping_paths',
      affectedPaths: conflict.affected_paths,
      baseBlobs,
      currentBlobs,
      deviceBlobs,
      mainSummary,
      deviceSummary
    });
  }

  private async classifyStructuralMergeConflict(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    mainChanges: GitDiffEntry[],
    deviceChanges: GitDiffEntry[],
    deviceBase = base,
    identicalPaths = new Set<string>()
  ): Promise<{ conflict: StructuralConflict | null; mainRenames: GitMergeRename[] }> {
    const [baseBlobs, currentBlobs, deviceBlobs, deviceBaseBlobs] = await Promise.all([
      this.blobOidMap(vaultId, base),
      this.blobOidMap(vaultId, currentMain),
      this.blobOidMap(vaultId, deviceCommit),
      this.blobOidMap(vaultId, deviceBase)
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
      baseCommit: deviceBase,
      targetCommit: deviceCommit,
      changes: deviceChanges,
      baseBlobs: deviceBaseBlobs,
      targetBlobs: deviceBlobs,
      readBlob
    });
    // Pair renames (including inferred delete+add pairs) before stripping identity
    // bytes. Their identical sources remain only as divergent-destination lineage.
    const structuralIdentities = new Set(identicalPaths);
    for (const summary of [mainSummary, deviceSummary]) {
      for (const [source, targets] of summary.renameCandidatesByBasePath) {
        if ([...targets].some((target) => !identicalPaths.has(target))) structuralIdentities.delete(source);
      }
    }
    // Ownership follows only renames AFTER K. The older explicit ancestor still
    // governs conservative classification above, but cannot redirect a resurrected
    // K->D addition through an already inherited rename.
    const authorizationSummary = deviceBase === base ? mainSummary : await summarizeStructuralChanges({
      baseCommit: deviceBase,
      targetCommit: currentMain,
      changes: await this.git.changedPaths(vaultId, deviceBase, currentMain),
      baseBlobs: deviceBaseBlobs,
      targetBlobs: currentBlobs,
      readBlob
    });
    const changedExistingSources = new Set(deviceSummary.actions
      .filter((action) => action.kind === 'edit' || action.kind === 'delete' || action.kind === 'rename')
      .map((action) => action.basePath));
    return {
      conflict: structuralMergeConflict(
        structuralSummaryWithoutIdentities(mainSummary, structuralIdentities),
        structuralSummaryWithoutIdentities(deviceSummary, structuralIdentities)
      ),
      mainRenames: authorizationSummary.actions
        .filter((action) => action.kind === 'rename' && action.basePath !== null && action.targetPath !== null &&
          deviceBaseBlobs.has(action.basePath) && changedExistingSources.has(action.basePath))
        .map((action) => ({ sourcePath: action.basePath!, targetPath: action.targetPath! }))
    };
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
    overlapping: string[],
    directoryPlan: DirectoryMergePlan | null = null
  ): Promise<PushResult | null> {
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
        },
        directory_plan: storedDirectoryPlan(directoryPlan)
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });

    let mergeCommit: string | null = null;
    try {
      mergeCommit = await this.git.createOverlayMergeCommitObject(
        vaultId,
        base,
        currentMain,
        deviceCommit,
        deviceChanges,
        mergePreparation.mergeSequence,
        deviceId
      );
      await this.git.validateTreeRootIgnorePolicy(vaultId, mergeCommit, this.maxUploadBytes);
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, currentMain);
    } catch (error) {
      if (error instanceof GitDurabilityError) throw error;
      const actualMain = await this.git.getRef(vaultId, 'refs/heads/main');
      if (!mergeCommit || actualMain !== mergeCommit) {
        if (actualMain !== currentMain) {
          await this.blockPreparedOperationForIntegrity(mergePreparation.operationId, 'merge main ref cannot be reconciled');
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        await this.abortOperation(mergePreparation.operationId, 'merge_git_error');
        if (error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError) {
          return await this.createConflict(vaultId, deviceId, base, currentMain, deviceCommit,
            policyConflictPaths(error), 'root_ignore_merge_policy', directoryPlan);
        }
        throw error;
      }
    }
    if (!mergeCommit) throw new Error('Prepared merge did not produce a commit.');

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
          changed_path_count: changedPathSet(deviceChanges).size,
          ...directoryEventPayload(directoryPlan, deviceId)
        }
      });
      commitDirectoryPlan(db, vaultId, deviceId, deviceCommit, directoryPlan, event.event_seq);
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
      event_seq: eventSeq,
      ...(directoryPlan ? { directory_ack: proposalAcknowledgement(directoryPlan.proposal, 'accepted') } : {})
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
    manualFiles: Record<string, string | null> | undefined,
    manualFilePlan: ManualFilePlanEntry[] | undefined
  ): Promise<string> {
    return (await this.buildResolutionArtifacts(conflict, resolutionKind, manualFiles, manualFilePlan)).tree;
  }

  private async buildResolutionArtifacts(
    conflict: ConflictRecord,
    resolutionKind: ConflictResolutionKind,
    manualFiles: Record<string, string | null> | undefined,
    manualFilePlan: ManualFilePlanEntry[] | undefined
  ): Promise<ResolutionArtifacts> {
    const sourceTree = await this.resolutionSourceTree(conflict);
    const fileAffectedPaths = await this.conflictFileAffectedPaths(conflict);
    if (resolutionKind === 'keep_server') {
      return { tree: sourceTree, sourceTree, fileAffectedPaths, writes: new Map(), deletes: [] };
    }

    const writes = new Map<string, Buffer>();
    const deletes: string[] = [];
    const artifacts = async (): Promise<ResolutionArtifacts> => ({
      tree: await this.git.createTreeFromTreeWithChanges({ vaultId: conflict.vault_id, sourceTree, writes, deletes }),
      sourceTree,
      fileAffectedPaths,
      writes,
      deletes
    });

    if (resolutionKind === 'use_device') {
      if (fileAffectedPaths.length === 0) {
        return {
          tree: conflict.directory_context ? sourceTree : await this.git.treeHash(conflict.vault_id, conflict.device_commit),
          sourceTree,
          fileAffectedPaths,
          writes,
          deletes
        };
      }
      for (const path of fileAffectedPaths) {
        const deviceBlob = await this.readOptionalBlob(conflict.vault_id, conflict.device_commit, path);
        if (deviceBlob === null) {
          deletes.push(path);
        } else {
          writes.set(path, deviceBlob);
        }
      }
      return await artifacts();
    }

    if (resolutionKind === 'keep_both_files') {
      for (const path of conflict.affected_paths) {
        const deviceBlob = await this.readOptionalBlob(conflict.vault_id, conflict.device_commit, path);
        if (deviceBlob !== null) {
          const sourceBlob = await this.readOptionalBlob(conflict.vault_id, sourceTree, path);
          writes.set(sourceBlob === null ? path : conflictCopyPath(path, conflict.conflict_id, conflict.device_id), deviceBlob);
        }
      }
      assertSyncableTreePaths([...writes.keys()]);
      return await artifacts();
    }

    if ((resolutionKind === 'insert_both_blocks' || resolutionKind === 'manual') && await this.conflictContainsBinary(conflict)) {
      throw new AuthError(400, 'invalid_resolution', 'Binary conflicts require a whole-file server, device, or keep-both resolution.');
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
      return await artifacts();
    }

    if (resolutionKind === 'manual') {
      if (manualFiles !== undefined && manualFilePlan !== undefined) {
        throw new AuthError(400, 'invalid_resolution', 'Manual resolution must use either manual_files or manual_file_plan.');
      }
      if (manualFilePlan !== undefined) {
        const plan = await this.buildManualFilePlanChanges(conflict, sourceTree, manualFilePlan);
        for (const [path, content] of plan.writes) writes.set(path, content);
        deletes.push(...plan.deletes);
        return await artifacts();
      }
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
      return await artifacts();
    }

    throw new AuthError(400, 'invalid_resolution', 'Unsupported conflict resolution kind.');
  }

  private async describeResolutionPreview(
    conflict: ConflictRecord,
    resolutionKind: ConflictResolutionKind,
    artifacts: ResolutionArtifacts
  ): Promise<ConflictPreviewFile[]> {
    const deleted = new Set(artifacts.deletes);
    const copySources = new Map<string, string>();
    if (resolutionKind === 'keep_both_files') {
      for (const path of conflict.affected_paths) {
        const copyPath = conflictCopyPath(path, conflict.conflict_id, conflict.device_id);
        if (artifacts.writes.has(copyPath)) copySources.set(copyPath, path);
      }
    }
    const paths = [...new Set([...artifacts.fileAffectedPaths, ...artifacts.writes.keys(), ...artifacts.deletes])].sort();
    const files: ConflictPreviewFile[] = [];
    for (const path of paths) {
      const blob = deleted.has(path) ? null : await this.readOptionalBlob(conflict.vault_id, artifacts.tree, path);
      const sourceBlob = await this.readOptionalBlob(conflict.vault_id, artifacts.sourceTree, path);
      const text = blob === null ? null : decodeReviewText(blob);
      const contentKind: ConflictPreviewFile['content_kind'] =
        blob !== null && text === null ? 'binary' : blob !== null && blob.byteLength > MAX_INTERACTIVE_REVIEW_BYTES ? 'large_text' : 'text';
      files.push({
        path,
        operation: previewOperation(path, blob, sourceBlob, deleted, copySources),
        provenance: previewProvenance(resolutionKind, artifacts.writes.has(path), copySources.has(path)),
        source_path: copySources.get(path) ?? null,
        content_kind: contentKind,
        content: contentKind === 'text' ? text : null,
        bytes: blob?.byteLength ?? null,
        sha256: blob === null ? null : sha256Hex(blob)
      });
    }
    return files;
  }

  private async conflictContainsBinary(conflict: ConflictRecord): Promise<boolean> {
    for (const path of conflict.affected_paths) {
      const blobs = await Promise.all([
        this.readOptionalBlob(conflict.vault_id, conflict.base_commit, path),
        this.readOptionalBlob(conflict.vault_id, conflict.expected_main, path),
        this.readOptionalBlob(conflict.vault_id, conflict.device_commit, path)
      ]);
      if (blobs.some((blob) => blob !== null && decodeReviewText(blob) === null)) return true;
    }
    return false;
  }

  private async buildManualFilePlanChanges(
    conflict: ConflictRecord,
    sourceTree: string,
    manualFilePlan: ManualFilePlanEntry[]
  ): Promise<{ writes: Map<string, Buffer>; deletes: string[] }> {
    if (manualFilePlan.length === 0) {
      throw new AuthError(400, 'invalid_resolution', 'Manual file plan requires at least one path.');
    }
    const affected = new Set(conflict.affected_paths);
    const unaffectedSourcePaths = (await this.git.listTreePaths(conflict.vault_id, sourceTree)).filter((path) => !affected.has(path));
    const seen = new Set<string>();
    const writes = new Map<string, Buffer>();
    const deletes: string[] = [];
    for (const entry of manualFilePlan) {
      if (seen.has(entry.path)) {
        throw new AuthError(400, 'invalid_resolution', 'Manual file plan contains duplicate paths.');
      }
      seen.add(entry.path);
      if (entry.content === null) {
        if (!affected.has(entry.path)) {
          throw new AuthError(400, 'invalid_resolution', 'Manual file plan can only delete affected conflict paths.');
        }
        deletes.push(entry.path);
        continue;
      }
      if (unaffectedSourcePaths.some((path) => changedPathsConflict(path, entry.path))) {
        throw new AuthError(400, 'invalid_resolution', 'Manual file plan target collides with an unrelated path.');
      }
      writes.set(entry.path, Buffer.from(entry.content, 'utf8'));
    }
    const missingPaths = conflict.affected_paths.filter((path) => !seen.has(path));
    if (missingPaths.length > 0) {
      throw new AuthError(400, 'invalid_resolution', 'Manual file plan must include every affected conflict path.');
    }
    assertSyncableTreePaths([...seen]);
    return { writes, deletes };
  }

  private async conflictFileAffectedPaths(conflict: ConflictRecord): Promise<string[]> {
    const filePathSets = await Promise.all([
      this.git.listTreePaths(conflict.vault_id, conflict.base_commit),
      this.git.listTreePaths(conflict.vault_id, conflict.expected_main),
      this.git.listTreePaths(conflict.vault_id, conflict.device_commit)
    ]).then((pathLists) => pathLists.map((paths) => new Set(paths)));
    return conflict.affected_paths.filter((path) => filePathSets.some((paths) => paths.has(path)));
  }

  private async resolutionSourceTree(conflict: ConflictRecord): Promise<string> {
    if (!(await this.git.commitExists(conflict.vault_id, conflict.base_commit))) {
      return await this.git.treeHash(conflict.vault_id, conflict.expected_main);
    }
    const fileAffectedPaths = await this.conflictFileAffectedPaths(conflict);
    if (!conflict.directory_context && fileAffectedPaths.length === 0) {
      return await this.git.treeHash(conflict.vault_id, conflict.expected_main);
    }
    const authoredBase = await this.git.mergeBase(conflict.vault_id, conflict.current_main, conflict.device_commit) ?? conflict.base_commit;
    const deviceChanges = await this.git.changedPaths(conflict.vault_id, authoredBase, conflict.device_commit);
    const nonConflictingDeviceChanges = changesOutsideAffectedPaths(deviceChanges, fileAffectedPaths);
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
    overlapping: string[],
    directoryPlan: DirectoryMergePlan | null = null,
    authoredBase = base,
    mainRenames: GitMergeRename[] = [],
    metadataRules: MetadataConflictRule[] = [],
    renamePairs: NonNullable<DevicePushManifest['rename_pairs']> = []
  ): Promise<PushResult | null> {
    if (!overlapping.every(isNativeTextMergePath)) {
      return null;
    }

    let mergeTree: MergeTreeResult | null;
    try {
      mergeTree = await this.git.tryPolicyMergeTree(vaultId, base, currentMain, deviceCommit, deviceChanges, overlapping, authoredBase, mainRenames, metadataRules, renamePairs);
    } catch (error) {
      if (!(error instanceof GitMergeOwnershipError)) throw error;
      return await this.createConflict(vaultId, deviceId, base, currentMain, deviceCommit,
        error.affectedPaths, 'unexplained_native_merge_paths', directoryPlan, undefined, renamePairs);
    }
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
        validator_results: mergeTree.validatorResults,
        metadata_conflict_rules: metadataRules,
        metadata_conflict_rules_sha256: sha256Hex(JSON.stringify(metadataRules)),
        directory_plan: storedDirectoryPlan(directoryPlan)
      };
      operation.updated_at = nowIso();
      return { mergeSequence, operationId: operation.operation_id };
    });

    let mergeCommit: string | null = null;
    try {
      mergeCommit = await this.git.createMergeCommitObjectFromTree({
        vaultId,
        tree: mergeTree.tree,
        base,
        currentMain,
        deviceCommit,
        mergeSequence: mergePreparation.mergeSequence,
        deviceId,
        strategy: mergeTree.validatorResults.semantic_merge === 'clean' ? 'semantic_clean' : 'native_clean'
      });
      await this.git.validateTreeRootIgnorePolicy(vaultId, mergeCommit, this.maxUploadBytes);
      await this.prepareMergeRefUpdate(mergePreparation.operationId, mergeCommit);
      await this.git.updateRef(vaultId, 'refs/heads/main', mergeCommit, currentMain);
    } catch (error) {
      if (error instanceof GitDurabilityError) throw error;
      const actualMain = await this.git.getRef(vaultId, 'refs/heads/main');
      if (!mergeCommit || actualMain !== mergeCommit) {
        if (actualMain !== currentMain) {
          await this.blockPreparedOperationForIntegrity(mergePreparation.operationId, 'merge main ref cannot be reconciled');
          throw new AuthError(409, 'blocked_integrity', 'Vault persistent state failed integrity checks.');
        }
        await this.abortOperation(mergePreparation.operationId, 'merge_git_error');
        if (error instanceof PathPolicyViolation || error instanceof RootIgnorePolicyError) {
          return await this.createConflict(vaultId, deviceId, base, currentMain, deviceCommit,
            policyConflictPaths(error), 'root_ignore_merge_policy', directoryPlan);
        }
        throw error;
      }
    }
    if (!mergeCommit) throw new Error('Prepared merge did not produce a commit.');

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
          changed_path_count: changedPathSet(deviceChanges).size,
          ...directoryEventPayload(directoryPlan, deviceId)
        }
      });
      commitDirectoryPlan(db, vaultId, deviceId, deviceCommit, directoryPlan, event.event_seq);
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
      event_seq: eventSeq,
      ...(directoryPlan ? { directory_ack: proposalAcknowledgement(directoryPlan.proposal, 'accepted') } : {})
    };
  }

  private async acceptDivergentDeviceCommit(
    auth: AuthenticatedDevice,
    operationId: string,
    currentDeviceRef: string,
    currentMain: string,
    deviceCommit: string,
    directoryProposal: DirectoryProposal | null,
    renamePairs: NonNullable<DevicePushManifest['rename_pairs']> = []
  ): Promise<PushResult> {
    const sharedBase = await this.git.mergeBase(auth.vault.vault_id, currentDeviceRef, deviceCommit) ??
      await this.git.mergeBase(auth.vault.vault_id, currentMain, deviceCommit);
    const base = sharedBase ?? currentMain;
    const changedPaths = sharedBase
      ? changedPathSet(await this.git.changedPaths(auth.vault.vault_id, sharedBase, deviceCommit))
      : new Set(await this.git.listTreePaths(auth.vault.vault_id, deviceCommit));
    for (const pair of renamePairs) {
      changedPaths.add(pair.source_path);
      changedPaths.add(pair.destination_path);
    }
    const directoryPlan = directoryProposal
      ? await this.classifyDirectoryProposal(auth.vault.vault_id, auth.device.device_id, directoryProposal)
      : null;
    for (const path of directoryPlan?.affectedRoots ?? []) changedPaths.add(path);
    const result = await this.createConflict(
      auth.vault.vault_id,
      auth.device.device_id,
      base,
      currentMain,
      deviceCommit,
      [...changedPaths].sort(),
      'same_device_history_divergence',
      directoryPlan,
      currentDeviceRef,
      renamePairs
    );
    await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      operation.status = 'committed';
      operation.result = { decision: 'conflict', conflict_id: result.status === 'conflicted' ? result.conflict_id : null };
      operation.updated_at = nowIso();
    });
    return result;
  }

  private async createConflict(
    vaultId: string,
    deviceId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    affectedPaths: string[],
    reason: string,
    directoryPlan: DirectoryMergePlan | null = null,
    resultDeviceRef: string = deviceCommit,
    renamePairs: NonNullable<DevicePushManifest['rename_pairs']> = []
  ): Promise<PushResult> {
    affectedPaths = [...new Set([...affectedPaths, ...renamePairs.flatMap((pair) => [pair.source_path, pair.destination_path])])].sort();
    const conflictId = newId('conf');
    const mergeSequence = await this.store.mutate((db) => this.store.nextMergeSequence(db, vaultId));
    const directoryContext = directoryPlan ? directoryConflictContext(directoryPlan) : undefined;
    const conflictKind: ConflictRecord['conflict_kind'] = reason === 'directory_overlap'
      ? 'directory'
      : reason === 'mixed_directory_overlap' || reason === 'same_device_history_divergence' && directoryPlan !== null
        ? 'mixed'
        : 'content';
    const eventSeq = await this.store.mutate((db) => {
      const device = requireDevice(db, deviceId);
      const operation = this.store.startOperation(db, {
        vault_id: vaultId,
        device_id: deviceId,
        operation_type: 'conflict_create',
        expected_refs: {
          'refs/heads/main': currentMain,
          [device.device_ref]: resultDeviceRef
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
        ...(renamePairs.length > 0 ? { rename_pairs: renamePairs } : {}),
        validator_results: {
          reason,
          affected_paths: affectedPaths,
          affected_path_count: affectedPaths.length
        },
        directory_plan: storedDirectoryPlan(directoryPlan)
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
        conflict_kind: conflictKind,
        ...(renamePairs.length > 0 ? { rename_pairs: renamePairs } : {}),
        ...(directoryContext ? { directory_context: directoryContext } : {}),
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
      if (directoryPlan) {
        upsertDirectoryProposalResult(db, {
          proposal_id: directoryPlan.proposal.proposal_id,
          request_sha256: directoryPlan.requestSha256,
          vault_id: vaultId,
          device_id: deviceId,
          target_commit: deviceCommit,
          status: 'conflicted',
          conflict_id: conflictId,
          event_seq: 0,
          acknowledged_intents: proposalIntentAcknowledgements(directoryPlan.proposal),
          created_at: nowIso(),
          updated_at: nowIso()
        });
      }
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
          merge_policy_version: MERGE_POLICY_VERSION,
          conflict_kind: conflictKind,
          ...(directoryPlan ? { directory_proposal_id: directoryPlan.proposal.proposal_id } : {})
        }
      });
      if (directoryPlan) {
        const result = db.directory_proposal_results.find((candidate) => candidate.proposal_id === directoryPlan.proposal.proposal_id);
        if (result) result.event_seq = event.event_seq;
      }
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
    this.log.emit('info', 'conflict_created', { vault_id: vaultId, device_id: deviceId, conflict_id: conflictId, event_seq: eventSeq });
    try {
      await this.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/base`, base);
      await this.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/current`, currentMain);
      await this.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/device`, deviceCommit);
    } catch (error) {
      const blocked = await this.store.mutate((db) => {
        const vault = requireVault(db, vaultId);
        const changed = vault.status !== 'blocked_integrity';
        vault.status = 'blocked_integrity';
        vault.updated_at = nowIso();
        return changed;
      });
      if (blocked) this.log.emit('warn', 'vault_integrity_blocked', { vault_id: vaultId, source: 'request' });
      throw error;
    }
    return {
      status: 'conflicted',
      conflict_id: conflictId,
      device_ref: resultDeviceRef,
      main: currentMain,
      event_seq: eventSeq,
      ...(directoryPlan ? { directory_ack: proposalAcknowledgement(directoryPlan.proposal, 'conflicted') } : {})
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

  private async blockPreparedOperationForIntegrity(operationId: string, reason: string): Promise<void> {
    const blockedVaultId = await this.store.mutate((db) => {
      const operation = requireOperation(db, operationId);
      operation.result = { reason };
      operation.updated_at = nowIso();
      const vault = requireVault(db, operation.vault_id);
      const changed = vault.status !== 'blocked_integrity';
      vault.status = 'blocked_integrity';
      vault.updated_at = nowIso();
      return changed ? vault.vault_id : null;
    });
    if (blockedVaultId) this.log.emit('warn', 'vault_integrity_blocked', { vault_id: blockedVaultId, source: 'request' });
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

  private isGitDurabilityUnavailable(): boolean {
    const checker = (this.git as unknown as { isDurabilityUnavailable?: () => boolean }).isDurabilityUnavailable;
    return checker?.call(this.git) ?? false;
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
      return await (this.lifecycle ? this.lifecycle.withAdmission(vaultId, fn) : fn());
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

function applyExplicitRenamePairsToSummary(
  summary: StructuralSummary,
  pairs: NonNullable<ConflictRecord['rename_pairs']>,
  baseBlobs: Map<string, string>,
  targetBlobs: Map<string, string>
): void {
  for (const pair of pairs) {
    if (!baseBlobs.has(pair.source_path) || !targetBlobs.has(pair.destination_path)) continue;
    summary.actions = summary.actions.filter((action) =>
      action.basePath !== pair.source_path && action.targetPath !== pair.destination_path);
    summary.actions.push({
      kind: 'rename', basePath: pair.source_path, targetPath: pair.destination_path,
      baseOid: baseBlobs.get(pair.source_path)!, targetOid: targetBlobs.get(pair.destination_path)!,
      renameConfidence: 'explicit'
    });
    summary.renameCandidatesByBasePath.set(pair.source_path, new Set([pair.destination_path]));
  }
  summary.actions.sort((left, right) => (left.basePath ?? left.targetPath ?? '').localeCompare(right.basePath ?? right.targetPath ?? ''));
  summary.byBasePath = new Map(summary.actions.filter((action) => action.basePath !== null).map((action) => [action.basePath!, action]));
  summary.addsByPath = new Map(summary.actions.filter((action) => action.kind === 'add' && action.targetPath !== null)
    .map((action) => [action.targetPath!, action]));
}

function buildConflictReviewPaths(input: {
  reason: string;
  affectedPaths: string[];
  baseBlobs: Map<string, string>;
  currentBlobs: Map<string, string>;
  deviceBlobs: Map<string, string>;
  mainSummary: StructuralSummary;
  deviceSummary: StructuralSummary;
}): ConflictReviewPath[] {
  const groups: ConflictReviewPath[] = [];
  const groupedPaths = new Set<string>();
  const basePaths = new Set([...input.mainSummary.byBasePath.keys(), ...input.deviceSummary.byBasePath.keys()]);
  for (const basePath of [...basePaths].sort()) {
    const mainAction = input.mainSummary.byBasePath.get(basePath);
    const deviceAction = input.deviceSummary.byBasePath.get(basePath);
    const server = reviewSide(basePath, mainAction);
    const device = reviewSide(basePath, deviceAction);
    const affectedPaths = affectedPathsForReviewGroup(input.affectedPaths, [basePath, server.path, device.path]);
    if (affectedPaths.length === 0) {
      continue;
    }
    for (const path of affectedPaths) {
      groupedPaths.add(path);
    }
    groups.push({
      group_id: reviewGroupId(basePath, server.path, device.path, affectedPaths),
      kind: reviewPathKind(input.reason, mainAction, deviceAction, basePath, server.path, device.path),
      base_path: basePath,
      server_path: server.path,
      device_path: device.path,
      server_operation: server.operation,
      device_operation: device.operation,
      affected_paths: affectedPaths
    });
  }
  const fallbackPaths = input.affectedPaths.filter((path) => !groupedPaths.has(path));
  groups.push(...fallbackConflictReviewPaths(fallbackPaths, input.baseBlobs, input.currentBlobs, input.deviceBlobs));
  return groups;
}

function reviewSide(
  basePath: string,
  action: StructuralAction | undefined
): { path: string | null; operation: ConflictReviewPath['server_operation'] } {
  if (!action) {
    return { path: basePath, operation: 'unchanged' };
  }
  switch (action.kind) {
    case 'rename':
      return { path: action.targetPath, operation: 'renamed' };
    case 'delete':
      return { path: null, operation: 'deleted' };
    case 'edit':
      return { path: action.targetPath ?? action.basePath, operation: 'modified' };
    case 'add':
      return { path: action.targetPath, operation: 'added' };
  }
}

function fallbackConflictReviewPaths(
  affectedPaths: string[],
  baseBlobs: Map<string, string>,
  currentBlobs: Map<string, string>,
  deviceBlobs: Map<string, string>
): ConflictReviewPath[] {
  return affectedPaths.map((path) => {
    const baseOid = baseBlobs.get(path) ?? null;
    const serverOid = currentBlobs.get(path) ?? null;
    const deviceOid = deviceBlobs.get(path) ?? null;
    const basePath = baseOid === null ? null : path;
    const serverPath = serverOid === null ? null : path;
    const devicePath = deviceOid === null ? null : path;
    return {
      group_id: reviewGroupId(basePath, serverPath, devicePath, [path]),
      kind: basePath === serverPath && basePath === devicePath ? 'same_path' : 'path_overlap',
      base_path: basePath,
      server_path: serverPath,
      device_path: devicePath,
      server_operation: reviewOperation(baseOid, serverOid),
      device_operation: reviewOperation(baseOid, deviceOid),
      affected_paths: [path]
    };
  });
}

function reviewGroupId(basePath: string | null, serverPath: string | null, devicePath: string | null, affectedPaths: string[]): string {
  return sha256Hex(JSON.stringify([basePath, serverPath, devicePath, [...affectedPaths].sort()])).slice(0, 20);
}

function reviewOperation(baseOid: string | null, targetOid: string | null): ConflictReviewPath['server_operation'] {
  if (baseOid === null && targetOid === null) {
    return 'absent';
  }
  if (baseOid === null) {
    return 'added';
  }
  if (targetOid === null) {
    return 'deleted';
  }
  return baseOid === targetOid ? 'unchanged' : 'modified';
}

function reviewPathKind(
  reason: string,
  mainAction: StructuralAction | undefined,
  deviceAction: StructuralAction | undefined,
  basePath: string,
  serverPath: string | null,
  devicePath: string | null
): ConflictReviewPath['kind'] {
  if (reason === 'rename_rename_conflict') {
    return 'rename_rename';
  }
  if (reason === 'rename_delete_conflict') {
    return 'rename_delete';
  }
  if (reason === 'delete_edit_conflict') {
    return 'delete_edit';
  }
  if (reason === 'rename_path_collision' || reason === 'ambiguous_rename_conflict') {
    return 'path_collision';
  }
  if (mainAction?.kind === 'rename' || deviceAction?.kind === 'rename') {
    return 'rename_edit';
  }
  return basePath === serverPath && basePath === devicePath ? 'same_path' : 'path_overlap';
}

function affectedPathsForReviewGroup(affectedPaths: string[], anchors: Array<string | null>): string[] {
  const concreteAnchors = anchors.filter((path): path is string => path !== null);
  return affectedPaths
    .filter((path) => concreteAnchors.some((anchor) => changedPathsConflict(path, anchor)))
    .sort();
}

function structuralSummaryWithoutIdentities(summary: StructuralSummary, identities: Set<string>): StructuralSummary {
  const actions = summary.actions.flatMap((action): StructuralAction[] => {
    if (action.kind === 'rename' && action.basePath && action.targetPath) {
      if (!identities.has(action.targetPath)) return [action];
      return identities.has(action.basePath) ? [] : [{ ...action, kind: 'delete', targetPath: null, targetOid: null, renameConfidence: null }];
    }
    const path = action.targetPath ?? action.basePath;
    return path && identities.has(path) ? [] : [action];
  });
  return {
    actions,
    byBasePath: new Map(actions.filter((action) => action.basePath !== null).map((action) => [action.basePath!, action])),
    addsByPath: new Map(actions.filter((action) => action.kind === 'add' && action.targetPath !== null).map((action) => [action.targetPath!, action])),
    renameCandidatesByBasePath: new Map([...summary.renameCandidatesByBasePath]
      .filter(([path]) => !identities.has(path))
      .map(([path, targets]) => [path, new Set([...targets].filter((target) => !identities.has(target)))]))
  };
}

// Retain a rename when both endpoints diverge; split it when only one endpoint does.
function changesWithoutIdentities(changes: GitDiffEntry[], identities: Set<string>): GitDiffEntry[] {
  return changes.flatMap((entry) => {
    if (entry.oldPath !== undefined) {
      if (!identities.has(entry.path) && !identities.has(entry.oldPath)) return [entry];
      return [
        ...(!identities.has(entry.oldPath) ? [{ status: 'D', path: entry.oldPath }] : []),
        ...(!identities.has(entry.path) ? [{ status: 'A', path: entry.path }] : [])
      ];
    }
    return identities.has(entry.path) ? [] : [entry];
  });
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

export function recoveredDirectoryEventPayload(operation: SyncOperationRow): Record<string, unknown> {
  const plan = recoveredDirectoryPlan(operation.prepared_manifest?.directory_plan);
  if (plan && operation.device_id) return directoryEventPayload(plan, operation.device_id);
  const proposal = storedDirectoryProposal(operation.prepared_manifest?.directory_proposal);
  const intents = storedDirectoryIntents(operation.prepared_manifest?.resolved_directory_intents);
  if (!proposal || !operation.device_id) return {};
  return {
    directory_intents: intents,
    directory_proposal_id: proposal.proposal_id,
    directory_acknowledgements: proposalIntentAcknowledgements(proposal).map((ack) => ({
      ...ack,
      device_id: operation.device_id
    }))
  };
}

export function commitRecoveredDirectoryState(db: MetadataDb, operation: SyncOperationRow, eventSeq: number): void {
  const plan = recoveredDirectoryPlan(operation.prepared_manifest?.directory_plan);
  if (plan && operation.device_id && operation.target_commit) {
    commitDirectoryPlan(db, operation.vault_id, operation.device_id, operation.target_commit, plan, eventSeq);
    return;
  }
  const proposal = storedDirectoryProposal(operation.prepared_manifest?.directory_proposal);
  const intents = storedDirectoryIntents(operation.prepared_manifest?.resolved_directory_intents);
  if (!proposal) return;
  applyDirectoryIntents(db, operation.vault_id, intents, eventSeq);
  const conflictId = typeof operation.prepared_manifest?.conflict_id === 'string'
    ? operation.prepared_manifest.conflict_id
    : null;
  if (conflictId) {
    const conflict = db.conflicts.find((candidate) => candidate.conflict_id === conflictId);
    if (conflict) resolveDirectoryProposalResult(db, conflict, eventSeq);
  }
}

function recoveredDirectoryPlan(value: unknown): DirectoryMergePlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const proposal = storedDirectoryProposal(record.proposal);
  if (
    !proposal ||
    typeof record.request_sha256 !== 'string' ||
    !Array.isArray(record.base_explicit_dirs) ||
    !Array.isArray(record.server_explicit_dirs) ||
    !Array.isArray(record.clean_intent_ids) ||
    !Array.isArray(record.conflicting_intent_ids) ||
    !Array.isArray(record.affected_roots) ||
    !Number.isSafeInteger(record.expected_event_seq)
  ) return null;
  const cleanIds = new Set(record.clean_intent_ids.filter((item): item is string => typeof item === 'string'));
  const conflictingIds = new Set(record.conflicting_intent_ids.filter((item): item is string => typeof item === 'string'));
  return {
    proposal,
    requestSha256: record.request_sha256,
    baseExplicitDirs: record.base_explicit_dirs.filter((item): item is string => typeof item === 'string'),
    serverExplicitDirs: record.server_explicit_dirs.filter((item): item is string => typeof item === 'string'),
    cleanIntents: proposal.intents.filter((intent) => cleanIds.has(intent.intent_id)),
    conflictingIntents: proposal.intents.filter((intent) => conflictingIds.has(intent.intent_id)),
    affectedRoots: record.affected_roots.filter((item): item is string => typeof item === 'string'),
    expectedEventSeq: record.expected_event_seq as number
  };
}

function storedDirectoryIntents(value: unknown): DirectoryIntent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as { op?: unknown; path?: unknown };
    return (record.op === 'create' || record.op === 'delete') && typeof record.path === 'string'
      ? [{ op: record.op, path: record.path }]
      : [];
  });
}

function directoryProposalRequestSha256(proposal: DirectoryProposal): string {
  return sha256Hex(Buffer.from(stableJson(proposal), 'utf8'));
}

function proposalIntentAcknowledgements(proposal: DirectoryProposal): DirectoryIntentAcknowledgement[] {
  return proposal.intents.map((intent) => ({ intent_id: intent.intent_id, generation: intent.generation }));
}

function proposalAcknowledgement(
  proposal: DirectoryProposal,
  status: DirectoryProposalAcknowledgement['status']
): DirectoryProposalAcknowledgement {
  return {
    proposal_id: proposal.proposal_id,
    status,
    acknowledged_intents: proposalIntentAcknowledgements(proposal)
  };
}

function storedRenamePairs(value: unknown): NonNullable<DevicePushManifest['rename_pairs']> {
  try {
    return parseRenamePairs(value);
  } catch {
    throw new Error('Prepared rename pair identity is invalid.');
  }
}

function storedDirectoryProposal(value: unknown): DirectoryProposal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DirectoryProposal>;
  return candidate.schema_version === 2 && typeof candidate.proposal_id === 'string' && Array.isArray(candidate.intents)
    ? candidate as DirectoryProposal
    : null;
}

function storedDirectoryPlan(plan: DirectoryMergePlan | null): Record<string, unknown> | null {
  if (!plan) return null;
  return {
    proposal: plan.proposal,
    request_sha256: plan.requestSha256,
    base_explicit_dirs: plan.baseExplicitDirs,
    server_explicit_dirs: plan.serverExplicitDirs,
    clean_intent_ids: plan.cleanIntents.map((intent) => intent.intent_id),
    conflicting_intent_ids: plan.conflictingIntents.map((intent) => intent.intent_id),
    affected_roots: plan.affectedRoots,
    expected_event_seq: plan.expectedEventSeq
  };
}

function directoryConflictContext(plan: DirectoryMergePlan): DirectoryConflictContext {
  return {
    proposal: plan.proposal,
    base_explicit_dirs: plan.baseExplicitDirs,
    server_explicit_dirs: plan.serverExplicitDirs,
    clean_intent_ids: plan.cleanIntents.map((intent) => intent.intent_id),
    conflicting_intent_ids: plan.conflictingIntents.map((intent) => intent.intent_id),
    affected_roots: plan.affectedRoots,
    expected_event_seq: plan.expectedEventSeq
  };
}

function directoryEventPayload(plan: DirectoryMergePlan | null, deviceId: string): Record<string, unknown> {
  if (!plan) return {};
  return {
    directory_intents: plan.proposal.intents.map(({ op, path }) => ({ op, path })),
    directory_proposal_id: plan.proposal.proposal_id,
    directory_acknowledgements: proposalIntentAcknowledgements(plan.proposal).map((ack) => ({ ...ack, device_id: deviceId }))
  };
}

function directoryResolutionEventPayload(
  conflict: ConflictRecord,
  resolvedIntents: DirectoryIntent[]
): Record<string, unknown> {
  const context = conflict.directory_context;
  if (!context) return {};
  return {
    directory_intents: resolvedIntents,
    directory_proposal_id: context.proposal.proposal_id,
    directory_acknowledgements: proposalIntentAcknowledgements(context.proposal).map((ack) => ({
      ...ack,
      device_id: conflict.device_id
    }))
  };
}

function commitDirectoryPlan(
  db: MetadataDb,
  vaultId: string,
  deviceId: string,
  deviceCommit: string,
  plan: DirectoryMergePlan | null,
  eventSeq: number
): void {
  if (!plan) return;
  applyDirectoryIntents(db, vaultId, plan.proposal.intents, eventSeq);
  upsertDirectoryProposalResult(db, {
    proposal_id: plan.proposal.proposal_id,
    request_sha256: plan.requestSha256,
    vault_id: vaultId,
    device_id: deviceId,
    target_commit: deviceCommit,
    status: 'accepted',
    conflict_id: null,
    event_seq: eventSeq,
    acknowledged_intents: proposalIntentAcknowledgements(plan.proposal),
    created_at: nowIso(),
    updated_at: nowIso()
  });
}

function upsertDirectoryProposalResult(db: MetadataDb, result: DirectoryProposalResultRow): void {
  const existing = db.directory_proposal_results.find((candidate) => candidate.proposal_id === result.proposal_id);
  if (existing) Object.assign(existing, result, { created_at: existing.created_at });
  else db.directory_proposal_results.push(result);
}

function resolveDirectoryProposalResult(db: MetadataDb, conflict: ConflictRecord, eventSeq: number): void {
  const context = conflict.directory_context;
  if (!context) return;
  const result = db.directory_proposal_results.find((candidate) => candidate.proposal_id === context.proposal.proposal_id);
  if (result) {
    result.status = 'resolved';
    result.event_seq = eventSeq;
    result.updated_at = nowIso();
  }
}

function resolvedConflictDirectoryIntents(
  conflict: ConflictRecord,
  resolutionKind: ConflictResolutionKind
): DirectoryIntent[] {
  const context = conflict.directory_context;
  if (!context) return [];
  const cleanIds = new Set(context.clean_intent_ids);
  if (resolutionKind === 'use_device') {
    return context.proposal.intents.map(({ op, path }) => ({ op, path }));
  }
  const cleanIntents = context.proposal.intents
    .filter((intent) => cleanIds.has(intent.intent_id))
    .map(({ op, path }) => ({ op, path }));
  const deviceExplicitDirs = applyDirectoryIntentsToSnapshot(context.base_explicit_dirs, context.proposal.intents);
  const serverReassertions = directoryIntentsBetweenSnapshots(deviceExplicitDirs, context.server_explicit_dirs)
    .filter((intent) => context.affected_roots.some((root) => pathsOverlap(root, intent.path)));
  return compactDirectoryIntents([...cleanIntents, ...serverReassertions]);
}

function reclassifyDirectoryContext(
  context: DirectoryConflictContext,
  serverExplicitDirs: string[],
  expectedEventSeq: number
): DirectoryConflictContext {
  const serverIntents = directoryIntentsBetweenSnapshots(context.base_explicit_dirs, serverExplicitDirs);
  const conflicting = context.proposal.intents.filter((intent) => {
    const serverHasPath = serverExplicitDirs.some((path) => path === intent.path || path.startsWith(`${intent.path}/`));
    const unknownLegacyOutcome = intent.provenance === 'legacy' && (
      (intent.op === 'create' && !serverHasPath) ||
      (intent.op === 'delete' && serverHasPath)
    );
    return unknownLegacyOutcome || serverIntents.some((serverIntent) =>
      serverIntent.op !== intent.op && pathsOverlap(serverIntent.path, intent.path)
    );
  });
  const conflictingIds = new Set(conflicting.map((intent) => intent.intent_id));
  return {
    ...context,
    server_explicit_dirs: [...serverExplicitDirs].sort(),
    clean_intent_ids: context.proposal.intents.filter((intent) => !conflictingIds.has(intent.intent_id)).map((intent) => intent.intent_id),
    conflicting_intent_ids: conflicting.map((intent) => intent.intent_id),
    affected_roots: topmostDirectoryPaths(conflicting.flatMap((intent) => [
      intent.path,
      ...serverIntents.filter((serverIntent) => serverIntent.op !== intent.op && pathsOverlap(serverIntent.path, intent.path))
        .map((serverIntent) => serverIntent.path)
    ])),
    expected_event_seq: expectedEventSeq
  };
}

const DIRECTORY_NEUTRAL_EVENT_TYPES = new Set([
  'device_ref_updated',
  'device_sync_rejected',
  'device_recovery_required',
  'conflict_created',
  'conflict_review_refreshed',
  'conflict_resolved',
  'note_restored',
  'device_state_changed',
  'vault_maintenance_started',
  'vault_maintenance_finished'
]);

function hasContiguousDirectoryNeutralEventGap(
  db: MetadataDb,
  vaultId: string,
  afterEventSeq: number,
  throughEventSeq: number
): boolean {
  if (
    !Number.isSafeInteger(afterEventSeq) || !Number.isSafeInteger(throughEventSeq) ||
    afterEventSeq < 0 || throughEventSeq <= afterEventSeq
  ) return false;
  const expectedCount = throughEventSeq - afterEventSeq;
  const events = db.events
    .filter((event) => event.vault_id === vaultId && event.event_seq > afterEventSeq && event.event_seq <= throughEventSeq)
    .sort((left, right) => left.event_seq - right.event_seq);
  if (events.length !== expectedCount) return false;
  return events.every((event, index) => {
    if (event.event_seq !== afterEventSeq + index + 1) return false;
    const directoryIntents = event.payload.directory_intents;
    if (directoryIntents !== undefined && (!Array.isArray(directoryIntents) || directoryIntents.length > 0)) return false;
    return event.event_type === 'main_advanced' || DIRECTORY_NEUTRAL_EVENT_TYPES.has(event.event_type);
  });
}

function directoryIntentsBetweenSnapshots(previous: string[], current: string[]): DirectoryIntent[] {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const deleted = previous
    .filter((path) => !currentSet.has(path))
    .filter((path) => !previous.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`) && !currentSet.has(candidate)))
    .map((path) => ({ op: 'delete' as const, path }));
  const created = current
    .filter((path) => !previousSet.has(path))
    .map((path) => ({ op: 'create' as const, path }));
  return compactDirectoryIntents([...deleted, ...created]);
}

function applyDirectoryIntentsToSnapshot(previous: string[], intents: DirectoryIntent[]): string[] {
  const explicit = new Set(previous);
  for (const intent of intents) {
    if (intent.op === 'delete') {
      for (const path of [...explicit]) {
        if (pathsOverlapWithinRoot(path, intent.path)) explicit.delete(path);
      }
    } else {
      for (const prefix of directoryPrefixes(intent.path)) explicit.add(prefix);
      explicit.add(intent.path);
    }
  }
  return [...explicit].sort();
}

function snapshotContainsDirectory(snapshot: string[], root: string): boolean {
  return snapshot.some((path) => pathsOverlapWithinRoot(path, root));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathsOverlapWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function topmostDirectoryPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return sorted.filter((path, index) => !sorted.some((candidate, candidateIndex) =>
    candidateIndex < index && path.startsWith(`${candidate}/`)
  ));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function applyDirectoryIntents(db: MetadataDb, vaultId: string, intents: DirectoryIntent[], eventSeq: number): void {
  if (intents.length === 0) {
    return;
  }
  const existing = db.directory_state_by_vault[vaultId] ?? { explicit_dirs: [], updated_at: nowIso(), last_event_seq: 0 };
  const explicitDirs = new Set(existing.explicit_dirs);
  for (const intent of intents) {
    if (intent.op === 'delete') {
      for (const path of [...explicitDirs]) {
        if (path === intent.path || path.startsWith(`${intent.path}/`)) {
          explicitDirs.delete(path);
        }
      }
      continue;
    }
    for (const prefix of directoryPrefixes(intent.path)) {
      explicitDirs.add(prefix);
    }
    explicitDirs.add(intent.path);
  }
  db.directory_state_by_vault[vaultId] = {
    explicit_dirs: [...explicitDirs].sort(),
    updated_at: nowIso(),
    last_event_seq: eventSeq
  };
}

function directoryPrefixes(path: string): string[] {
  const segments = path.split('/');
  const prefixes: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    prefixes.push(segments.slice(0, index).join('/'));
  }
  return prefixes;
}

function directoryIntentsFromEvents(events: Array<{ payload: Record<string, unknown> }>): DirectoryIntent[] {
  const intents: DirectoryIntent[] = [];
  for (const event of events) {
    const rawIntents = event.payload.directory_intents;
    if (!Array.isArray(rawIntents)) {
      continue;
    }
    for (const rawIntent of rawIntents) {
      if (typeof rawIntent !== 'object' || rawIntent === null || Array.isArray(rawIntent)) {
        continue;
      }
      const op = (rawIntent as { op?: unknown }).op;
      const path = (rawIntent as { path?: unknown }).path;
      if ((op === 'create' || op === 'delete') && typeof path === 'string') {
        intents.push({ op, path });
      }
    }
  }
  return compactDirectoryIntents(intents);
}

function compactDirectoryIntents(intents: DirectoryIntent[]): DirectoryIntent[] {
  const byPath = new Map<string, DirectoryIntent>();
  for (const intent of intents) {
    if (intent.op === 'delete') {
      for (const path of [...byPath.keys()]) {
        if (path === intent.path || path.startsWith(`${intent.path}/`)) {
          byPath.delete(path);
        }
      }
    }
    byPath.set(intent.path, intent);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path) || left.op.localeCompare(right.op));
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

function decodeReviewText(blob: Buffer | null): string | null {
  if (blob === null || blob.includes(0)) return null;
  try {
    return REVIEW_TEXT_DECODER.decode(blob);
  } catch {
    return null;
  }
}

function buildDirectoryConflictViews(directoryContext: DirectoryConflictContext | undefined): DirectoryConflictReview[] {
  const deviceExplicitDirs = directoryContext
    ? applyDirectoryIntentsToSnapshot(directoryContext.base_explicit_dirs, directoryContext.proposal.intents)
    : [];
  return (directoryContext?.affected_roots ?? []).map((root) => ({
    root,
    server_state: snapshotContainsDirectory(directoryContext?.server_explicit_dirs ?? [], root) ? 'present' as const : 'deleted' as const,
    device_state: snapshotContainsDirectory(deviceExplicitDirs, root) ? 'present' as const : 'deleted' as const,
    affected_paths: [...new Set([
      root,
      ...(directoryContext?.proposal.intents ?? []).filter((intent) => pathsOverlap(intent.path, root)).map((intent) => intent.path)
    ])].sort()
  }));
}

function previewOperation(
  path: string,
  blob: Buffer | null,
  sourceBlob: Buffer | null,
  deleted: Set<string>,
  copySources: Map<string, string>
): ConflictPreviewFile['operation'] {
  if (deleted.has(path) || blob === null) return 'deleted';
  if (copySources.has(path)) return 'copied';
  if (sourceBlob === null) return 'added';
  return blob.equals(sourceBlob) ? 'retained' : 'updated';
}

function previewProvenance(
  resolutionKind: ConflictResolutionKind,
  written: boolean,
  copied: boolean
): ConflictPreviewFile['provenance'] {
  switch (resolutionKind) {
    case 'keep_server':
      return 'server';
    case 'use_device':
      return 'device';
    case 'keep_both_files':
      return written || copied ? 'device' : 'server';
    case 'insert_both_blocks':
      return 'both';
    case 'manual':
      return 'manual';
  }
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

function conflictProtectionRef(conflictId: string, kind: 'base' | 'current' | 'device'): string {
  return `refs/obts/conflicts/${conflictId}/${kind}`;
}

function resolutionRequestHash(input: {
  expectedMain: string;
  resolutionKind: ConflictResolutionKind;
  manualFiles?: Record<string, string | null>;
  manualFilePlan?: ManualFilePlanEntry[];
}): string {
  return sha256Hex(
    JSON.stringify({
      expected_main: input.expectedMain,
      resolution_kind: input.resolutionKind,
      manual_files:
        input.manualFiles === undefined
          ? null
          : Object.fromEntries(Object.entries(input.manualFiles).sort(([left], [right]) => left.localeCompare(right))),
      manual_file_plan:
        input.manualFilePlan === undefined
          ? null
          : [...input.manualFilePlan].sort((left, right) => left.path.localeCompare(right.path))
    })
  );
}
