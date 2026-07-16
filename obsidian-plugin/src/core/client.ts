import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../../../src/shared/ids.js';
import { assertSyncableTreePaths, isSyncableVaultPath, normalizeVaultPath, PathPolicyViolation } from '../../../src/shared/pathPolicy.js';
import {
  API_VERSION,
  CHUNK_TRANSFER_CAPABILITY,
  type ChunkBootstrapManifest,
  type ChunkPullManifest,
  type CompleteConnectionRequest,
  type ConnectionBootstrapManifest,
  type DevicePullManifest,
  type ConnectionStatusResponse,
  type CreateConnectionResponse,
  type DevicePushManifest,
  type DirectoryIntent,
  type PushResult,
  type SyncCapabilities
} from '../../../src/shared/types.js';
import { readDisplayName } from '../../../src/shared/validators.js';
import { PLUGIN_VERSION } from '../version.js';
import { LocalGitEngine } from './localGit.js';
import { ApplyLockActiveError, type ApplyJournal, RecoveryManager, sha256File } from './recovery.js';
import { TransportClient, TransportError } from './transport.js';

export type ObtsPluginSettings = {
  serverUrl: string;
  deviceId?: string;
  vaultId?: string;
  deviceName: string;
};

export type LocalPluginState = {
  user_id: string | null;
  vault_id: string | null;
  device_id: string | null;
  device_name?: string | null;
  device_ref: string | null;
  server_device_ref: string | null;
  local_main: string | null;
  local_head: string | null;
  initial_import_confirmed: boolean;
  status_label: string;
  last_error_code: string | null;
  last_error_details?: Record<string, unknown> | null;
  last_event_seq: number;
  unpaired_baseline_vault_id?: string | null;
  unpaired_baseline_main?: string | null;
  updated_at: string;
};

type DetachedBaseline = {
  vaultId: string;
  main: string;
};

type PairingRepairContext = {
  baseline: DetachedBaseline | null;
  hasLocalGitHistory: boolean;
};

export type OnboardingStage =
  | 'awaiting_browser'
  | 'approved'
  | 'analyzing'
  | 'awaiting_confirmation'
  | 'registering'
  | 'applying_uploading'
  | 'uploading_proposal'
  | 'awaiting_conflict'
  | 'complete'
  | 'blocked';

export type OnboardingJournal = {
  version: 1;
  stage: OnboardingStage;
  connection: Omit<CreateConnectionResponse, 'connection_secret'>;
  analysis: OnboardingAnalysis | null;
  selected_mode: 'initialize' | 'use_server' | 'merge' | null;
  registered_device_id?: string | null;
  proposal_commit?: string | null;
  last_error_code: string | null;
  updated_at: string;
};

export type OnboardingAnalysis = {
  selection: 'new_vault' | 'existing_vault';
  vaultId: string | null;
  vaultName: string;
  expectedMain: string | null;
  rootCommit: string | null;
  classification:
    | 'new_empty'
    | 'new_with_content'
    | 'server_to_empty'
    | 'identical'
    | 'stale_baseline'
    | 'shared_baseline_divergent'
    | 'independent_divergent';
  proposalBase: string | null;
  localFingerprint: string;
  localFileCount: number;
  localBytes: number;
};

export type QueueState = {
  pending_commit: string | null;
  expected_device_ref: string | null;
  status: 'idle' | 'queued_local' | 'uploading' | 'uploaded' | 'merged' | 'conflicted' | 'blocked_recovery';
  attempts: number;
  change_seq?: number;
  updated_at: string;
};

type DirectorySyncState = {
  observed_dirs: string[];
  explicit_empty_dirs: string[];
  pending_intents: DirectoryIntent[];
  updated_at: string;
};

export type RebuildResult = {
  status: string;
  main: string;
  recoveryCommit?: string;
  preservedPendingCommit?: string;
};

export class PluginBlockedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class ObtsPluginClient {
  private readonly transport: TransportClient;
  private readonly git: LocalGitEngine;
  private readonly recovery: RecoveryManager;
  private onboardingOperation = false;
  private queueMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly vaultDir: string,
    private readonly settings: ObtsPluginSettings
  ) {
    this.transport = new TransportClient(settings.serverUrl);
    this.git = new LocalGitEngine(vaultDir);
    this.recovery = new RecoveryManager(vaultDir);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.vaultDir, '.obts', 'auth'), { recursive: true, mode: 0o700 });
    await this.git.initialize();
    const state = await this.repairLocalStateIfNeeded(await this.readState());
    const journal = await this.recovery.readApplyJournal();
    if (journal && journal.phase === 'committed') {
      await this.git.setLocalMain(journal.target_main);
      await this.git.setLocalHead(journal.target_main);
      await this.writeState({
        ...state,
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: 'Synced',
        last_error_code: null,
        updated_at: nowIso()
      });
      await this.recovery.clearApplyLock();
      await this.recovery.clearApplyJournal();
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal && (await this.recoverBlockedApplyWithPreservedLocalChanges(journal, state))) {
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal && (await this.recoverIncompleteApplyJournal(journal, state))) {
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal) {
      await this.writeState({
        ...state,
        status_label: 'Unsafe local state',
        last_error_code: 'apply_journal_recovery_required',
        updated_at: nowIso()
      });
      await this.writeQueue(await this.readQueue());
      return;
    }
    await this.writeState({
      ...state,
      status_label: state.status_label ?? 'Checking',
      updated_at: nowIso()
    });
    await this.writeQueue(await this.readQueue());
  }

  async readPendingOnboarding(): Promise<{ journal: OnboardingJournal; secret: string } | null> {
    try {
      const journal = JSON.parse(await readFile(this.onboardingJournalPath, 'utf8')) as OnboardingJournal;
      if (journal.stage === 'complete') return null;
      const pending = JSON.parse(await readFile(this.pendingConnectionPath, 'utf8')) as { connection_secret?: string };
      if (!pending.connection_secret) return null;
      return { journal, secret: pending.connection_secret };
    } catch {
      return null;
    }
  }

  async cancelOnboarding(): Promise<void> {
    await this.clearPendingOnboarding();
  }

  async startOnboarding(localVaultName: string): Promise<CreateConnectionResponse> {
    await mkdir(this.vaultDir, { recursive: true, mode: 0o700 });
    await this.assertPairingCanStart();
    await this.initialize();
    await this.flushEditorBuffersToDisk();
    const summary = await this.localSnapshotSummary();
    const existing = await this.readExistingState();
    const deviceName = readDisplayName({ device_name: this.settings.deviceName }, 'device_name');
    this.settings.deviceName = deviceName;
    const connection = await this.transport.createConnection({
      plugin_version: PLUGIN_VERSION,
      device_name: deviceName,
      local_vault_name: localVaultName,
      local_summary: {
        has_content: summary.fileCount > 0,
        syncable_file_count: summary.fileCount,
        syncable_bytes: summary.bytes,
        has_detached_baseline: Boolean(existing?.unpaired_baseline_vault_id && existing.unpaired_baseline_main)
      }
    });
    await writeJson(this.pendingConnectionPath, { connection_secret: connection.connection_secret, created_at: nowIso() });
    const { connection_secret: _secret, ...redactedConnection } = connection;
    await this.writeOnboardingJournal({
      version: 1,
      stage: 'awaiting_browser',
      connection: redactedConnection,
      analysis: null,
      selected_mode: null,
      last_error_code: null,
      updated_at: nowIso()
    });
    return connection;
  }

  async pollOnboarding(connectionId: string, secret: string): Promise<ConnectionStatusResponse> {
    const status = await this.transport.connectionStatus(connectionId, secret);
    const pending = await this.readPendingOnboarding();
    if (pending?.journal.connection.connection_id === connectionId) {
      if (status.status === 'approved') {
        await this.writeOnboardingJournal({ ...pending.journal, stage: 'approved', updated_at: nowIso() });
      } else if (status.status === 'denied' || status.status === 'expired') {
        await this.clearPendingOnboarding();
      }
    }
    return status;
  }

  async analyzeOnboarding(connectionId: string, secret: string): Promise<OnboardingAnalysis> {
    await this.updateOnboardingStage(connectionId, 'analyzing');
    const status = await this.transport.connectionStatus(connectionId, secret);
    if (status.status !== 'approved') {
      throw new PluginBlockedError('connection_not_approved', 'Approve this connection in the browser first.');
    }
    await this.flushEditorBuffersToDisk();
    const local = await this.localSnapshotSummary();
    if (status.selection === 'new_vault') {
      const analysis: OnboardingAnalysis = {
        selection: status.selection,
        vaultId: null,
        vaultName: status.vault_name,
        expectedMain: null,
        rootCommit: null,
        classification: local.fileCount === 0 ? 'new_empty' : 'new_with_content',
        proposalBase: null,
        localFingerprint: local.fingerprint,
        localFileCount: local.fileCount,
        localBytes: local.bytes
      };
      await this.saveOnboardingAnalysis(connectionId, analysis);
      return analysis;
    }

    const bootstrap = await this.bootstrapWithChunks(connectionId, secret);
    await this.git.importPack(bootstrap.packfile);
    const localFiles = await this.git.scanSyncableFiles();
    const matchesServer =
      localFiles.length === bootstrap.manifest.changed_paths.length &&
      (await this.localContentMatchesTree(localFiles, bootstrap.manifest.target_main));
    const repair = await this.discoverPairingRepairContext(await this.readExistingState());
    const baseline = this.baselineForPairing(repair.baseline, bootstrap.manifest.vault_id);
    const validBaseline =
      baseline &&
      (await this.git.commitExists(baseline.main)) &&
      (await this.git.isAncestor(baseline.main, bootstrap.manifest.target_main))
        ? baseline
        : null;
    const matchesBaseline = validBaseline ? await this.localContentMatchesTree(localFiles, validBaseline.main) : false;
    const classification =
      localFiles.length === 0
        ? 'server_to_empty'
        : matchesServer
          ? 'identical'
          : validBaseline && matchesBaseline
            ? 'stale_baseline'
            : validBaseline
              ? 'shared_baseline_divergent'
              : 'independent_divergent';
    const analysis: OnboardingAnalysis = {
      selection: status.selection,
      vaultId: bootstrap.manifest.vault_id,
      vaultName: bootstrap.manifest.vault_name,
      expectedMain: bootstrap.manifest.target_main,
      rootCommit: bootstrap.manifest.root_commit,
      classification,
      proposalBase: classification === 'shared_baseline_divergent' ? validBaseline!.main : bootstrap.manifest.root_commit,
      localFingerprint: local.fingerprint,
      localFileCount: local.fileCount,
      localBytes: local.bytes
    };
    await this.saveOnboardingAnalysis(connectionId, analysis);
    return analysis;
  }

  private async supportsChunkTransfers(): Promise<boolean> {
    try {
      const capabilities = await this.transport.capabilities();
      return capabilities.capabilities.includes(CHUNK_TRANSFER_CAPABILITY);
    } catch (error) {
      if (error instanceof TransportError && error.status === 404) return false;
      throw error;
    }
  }

  private async bootstrapWithChunks(
    connectionId: string,
    secret: string
  ): Promise<{ manifest: ConnectionBootstrapManifest; packfile: Buffer }> {
    if (!(await this.supportsChunkTransfers())) return await this.transport.bootstrapConnection(connectionId, secret);
    const capabilities = await this.transport.capabilities();
    const checkpointPath = join(this.vaultDir, '.obts', 'bootstrap-transfer.json');
    const checkpoint = await readJsonOrNull<{
      connection_id: string;
      target_main: string;
      next_cursor: number;
      received_chunks?: number;
      transferred_bytes?: number;
    }>(checkpointPath);
    let cursor = checkpoint?.connection_id === connectionId ? checkpoint.next_cursor : 0;
    let target: 'latest' | string = checkpoint?.connection_id === connectionId ? checkpoint.target_main : 'latest';
    if (checkpoint && checkpoint.connection_id !== connectionId) await rm(checkpointPath, { force: true });
    let finalManifest: ChunkBootstrapManifest | null = null;
    let chunkCount = checkpoint?.connection_id === connectionId ? checkpoint.received_chunks ?? 0 : 0;
    let transferredBytes = checkpoint?.connection_id === connectionId ? checkpoint.transferred_bytes ?? 0 : 0;
    while (true) {
      const chunk = await this.transport.bootstrapConnectionChunk(connectionId, secret, cursor, target);
      if (chunk.packfile.byteLength !== chunk.manifest.chunk_bytes || createHash('sha256').update(chunk.packfile).digest('hex') !== chunk.manifest.chunk_sha256) {
        throw new PluginBlockedError('chunk_digest_mismatch', 'Downloaded bootstrap chunk failed integrity validation.');
      }
      chunkCount += 1;
      transferredBytes += chunk.packfile.byteLength;
      if (chunkCount > capabilities.max_transfer_chunks || transferredBytes > capabilities.max_transfer_bytes) {
        throw new PluginBlockedError('transfer_too_large', 'Bootstrap transfer exceeded negotiated limits.');
      }
      await this.git.importPack(chunk.packfile);
      finalManifest = chunk.manifest;
      target = chunk.manifest.target_main;
      if (chunk.manifest.complete) {
        await rm(checkpointPath, { force: true });
        break;
      }
      if (chunk.manifest.next_cursor <= cursor) throw new PluginBlockedError('invalid_transfer_cursor', 'Bootstrap transfer did not advance.');
      cursor = chunk.manifest.next_cursor;
      await writeJson(checkpointPath, {
        connection_id: connectionId,
        target_main: target,
        next_cursor: cursor,
        received_chunks: chunkCount,
        transferred_bytes: transferredBytes,
        updated_at: nowIso()
      });
    }
    return { manifest: finalManifest!, packfile: Buffer.alloc(0) };
  }

  private async pullWithChunks(input: {
    vaultId: string;
    deviceId: string;
    deviceToken: string;
    currentLocalMain: string | null;
    requestedTarget?: 'latest' | string;
    currentEventSeq?: number;
  }): Promise<{ manifest: DevicePullManifest; packfile: Buffer }> {
    if (!(await this.supportsChunkTransfers())) return await this.transport.pull(input);
    const capabilities = await this.transport.capabilities();
    const checkpointPath = join(this.vaultDir, '.obts', 'pull-transfer.json');
    const checkpoint = await readJsonOrNull<{
      vault_id: string;
      device_id: string;
      current_local_main: string | null;
      target_main: string;
      next_cursor: number;
      received_chunks?: number;
      transferred_bytes?: number;
    }>(checkpointPath);
    const checkpointMatches = checkpoint?.vault_id === input.vaultId &&
      checkpoint.device_id === input.deviceId &&
      checkpoint.current_local_main === input.currentLocalMain &&
      (input.requestedTarget === undefined || input.requestedTarget === 'latest' || input.requestedTarget === checkpoint.target_main);
    let cursor = checkpointMatches ? checkpoint.next_cursor : 0;
    let target: 'latest' | string = checkpointMatches ? checkpoint.target_main : input.requestedTarget ?? 'latest';
    if (checkpoint && !checkpointMatches) await rm(checkpointPath, { force: true });
    let finalManifest: ChunkPullManifest | null = null;
    let chunkCount = checkpointMatches ? checkpoint.received_chunks ?? 0 : 0;
    let transferredBytes = checkpointMatches ? checkpoint.transferred_bytes ?? 0 : 0;
    while (true) {
      const chunk = await this.transport.pullChunk({
        ...input,
        requestedTarget: target,
        currentEventSeq: input.currentEventSeq ?? 0,
        cursor
      });
      if (chunk.packfile.byteLength !== chunk.manifest.chunk_bytes || createHash('sha256').update(chunk.packfile).digest('hex') !== chunk.manifest.chunk_sha256) {
        throw new PluginBlockedError('chunk_digest_mismatch', 'Downloaded Git chunk failed integrity validation.');
      }
      chunkCount += 1;
      transferredBytes += chunk.packfile.byteLength;
      if (chunkCount > capabilities.max_transfer_chunks || transferredBytes > capabilities.max_transfer_bytes) {
        throw new PluginBlockedError('transfer_too_large', 'Pull transfer exceeded negotiated limits.');
      }
      await this.git.importPack(chunk.packfile);
      finalManifest = chunk.manifest;
      target = chunk.manifest.target_main;
      if (chunk.manifest.complete) {
        await rm(checkpointPath, { force: true });
        break;
      }
      if (chunk.manifest.next_cursor <= cursor) throw new PluginBlockedError('invalid_transfer_cursor', 'Pull transfer did not advance.');
      cursor = chunk.manifest.next_cursor;
      await writeJson(checkpointPath, {
        vault_id: input.vaultId,
        device_id: input.deviceId,
        current_local_main: input.currentLocalMain,
        target_main: target,
        next_cursor: cursor,
        received_chunks: chunkCount,
        transferred_bytes: transferredBytes,
        updated_at: nowIso()
      });
    }
    if (!(await this.git.commitExists(finalManifest!.target_main))) {
      throw new PluginBlockedError('transfer_incomplete', 'Downloaded Git chunks do not contain the target commit.');
    }
    return { manifest: finalManifest!, packfile: Buffer.alloc(0) };
  }

  async finishOnboarding(input: {
    connectionId: string;
    secret: string;
    analysis: OnboardingAnalysis;
    mode: 'initialize' | 'use_server' | 'merge';
  }): Promise<{ status: string; main?: string; conflictId?: string }> {
    const pending = await this.readPendingOnboarding();
    if (
      !pending ||
      pending.journal.connection.connection_id !== input.connectionId ||
      (pending.journal.selected_mode && pending.journal.selected_mode !== input.mode)
    ) {
      throw new PluginBlockedError('onboarding_identity_mismatch', 'Pending onboarding mode does not match this setup attempt.');
    }
    this.onboardingOperation = true;
    await this.updateOnboardingStage(input.connectionId, 'registering', input.mode);
    try {
      const result = await this.finishOnboardingInternal(input);
      await this.reportDeviceStatus().catch(() => undefined);
      return result;
    } catch (error) {
      await this.updateOnboardingStage(
        input.connectionId,
        'blocked',
        input.mode,
        error instanceof PluginBlockedError || error instanceof TransportError ? error.code : 'onboarding_failed'
      );
      throw error;
    } finally {
      this.onboardingOperation = false;
    }
  }

  private async finishOnboardingInternal(input: {
    connectionId: string;
    secret: string;
    analysis: OnboardingAnalysis;
    mode: 'initialize' | 'use_server' | 'merge';
  }): Promise<{ status: string; main?: string; conflictId?: string }> {
    const current = await this.localSnapshotSummary();
    const localFiles = await this.git.scanSyncableFiles();
    const resumed = await this.resumeAcceptedOnboarding(input, localFiles);
    if (resumed) {
      return resumed;
    }
    if (current.fingerprint !== input.analysis.localFingerprint) {
      throw new PluginBlockedError('onboarding_snapshot_changed', 'The local vault changed. Review the updated onboarding summary before continuing.');
    }
    const operationType = input.mode === 'use_server' ? 'replace_local_with_server' : 'initial_import';
    await this.createLocalRecoveryBundle(operationType, input.analysis.expectedMain, localFiles);
    const request: CompleteConnectionRequest = {
      mode: input.mode,
      expected_main: input.analysis.expectedMain,
      ...(input.mode === 'initialize'
        ? { proposal_kind: 'new_vault_import' as const }
        : input.mode === 'merge'
          ? {
              proposal_kind:
                input.analysis.classification === 'shared_baseline_divergent'
                  ? ('shared_baseline_merge' as const)
                  : ('independent_vault_merge' as const),
              proposal_base: input.analysis.proposalBase
            }
          : {})
    };
    const result = await this.transport.completeConnection(input.connectionId, input.secret, request);
    await writeJson(join(this.vaultDir, '.obts', 'auth', 'device-token.json'), {
      device_token: result.device_token,
      created_at: nowIso()
    });
    await this.writeState({
      user_id: result.user_id,
      vault_id: result.vault_id,
      device_id: result.device_id,
      device_name: this.settings.deviceName,
      device_ref: result.device_ref,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: true,
      status_label: 'Checking',
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    await this.updateOnboardingStage(input.connectionId, 'applying_uploading', input.mode);
    const registeredPending = await this.readPendingOnboarding();
    if (registeredPending?.journal.connection.connection_id === input.connectionId) {
      await this.writeOnboardingJournal({
        ...registeredPending.journal,
        registered_device_id: result.device_id,
        updated_at: nowIso()
      });
    }
    const pulled = await this.pullWithChunks({
      vaultId: result.vault_id,
      deviceId: result.device_id,
      deviceToken: result.device_token,
      currentLocalMain: null,
      currentEventSeq: 0
    });
    await this.git.importPack(pulled.packfile);

    if (input.mode === 'use_server') {
      await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
        extraAffectedPaths: localFiles,
        directoryIntents: pulled.manifest.directory_intents ?? [],
        explicitDirectories: pulled.manifest.explicit_directories ?? [],
        eventSeq: pulled.manifest.event_seq
      });
      await this.acknowledgeAppliedMain(await this.readState(), result.device_token, pulled.manifest.target_main);
      await this.transport.acknowledgeOnboarding({
        vaultId: result.vault_id,
        deviceToken: result.device_token,
        appliedMain: pulled.manifest.target_main
      });
      await this.writeState({ ...(await this.readState()), initial_import_confirmed: true, status_label: 'Synced', updated_at: nowIso() });
      await this.completePendingOnboarding(input.connectionId);
      return { status: 'Synced', main: pulled.manifest.target_main };
    }

    const proposalBase = input.mode === 'initialize' ? result.root_commit : requireOnboardingBase(input.analysis.proposalBase);
    await this.git.setLocalMain(proposalBase);
    await this.git.setLocalHead(proposalBase);
    await this.writeState({
      ...(await this.readState()),
      local_main: proposalBase,
      local_head: proposalBase,
      status_label: 'Ahead',
      updated_at: nowIso()
    });
    const proposalCommit = await this.git.createLocalCommit('obts: onboarding local vault');
    const proposalPending = await this.readPendingOnboarding();
    if (proposalPending?.journal.connection.connection_id === input.connectionId) {
      await this.writeOnboardingJournal({
        ...proposalPending.journal,
        stage: 'uploading_proposal',
        proposal_commit: proposalCommit,
        updated_at: nowIso()
      });
    }
    await this.writeQueue({
      pending_commit: proposalCommit,
      expected_device_ref: null,
      status: proposalCommit ? 'queued_local' : 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
    const synced = await this.syncOnce();
    if (synced.status === 'Review needed') {
      await this.updateOnboardingStage(input.connectionId, 'awaiting_conflict', input.mode);
      return synced;
    }
    const finalState = await this.readState();
    if (!finalState.local_main) {
      throw new PluginBlockedError('onboarding_incomplete', 'Onboarding did not produce an applied server main.');
    }
    await this.transport.acknowledgeOnboarding({
      vaultId: result.vault_id,
      deviceToken: result.device_token,
      appliedMain: finalState.local_main
    });
    await this.completePendingOnboarding(input.connectionId);
    return synced;
  }

  private async resumeAcceptedOnboarding(
    input: {
      connectionId: string;
      secret: string;
      analysis: OnboardingAnalysis;
      mode: 'initialize' | 'use_server' | 'merge';
    },
    localFiles: string[]
  ): Promise<{ status: string; main?: string; conflictId?: string } | null> {
    const pending = await this.readPendingOnboarding();
    if (
      !pending ||
      pending.journal.connection.connection_id !== input.connectionId ||
      (pending.journal.selected_mode && pending.journal.selected_mode !== input.mode) ||
      (pending.journal.analysis && (
        pending.journal.analysis.localFingerprint !== input.analysis.localFingerprint ||
        pending.journal.analysis.selection !== input.analysis.selection ||
        pending.journal.analysis.vaultId !== input.analysis.vaultId ||
        pending.journal.analysis.expectedMain !== input.analysis.expectedMain ||
        pending.journal.analysis.proposalBase !== input.analysis.proposalBase ||
        pending.journal.analysis.classification !== input.analysis.classification
      ))
    ) {
      throw new PluginBlockedError('onboarding_identity_mismatch', 'Pending onboarding state does not match this setup attempt.');
    }
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return null;
    }
    if (input.analysis.vaultId && input.analysis.vaultId !== state.vault_id) {
      throw new PluginBlockedError('onboarding_identity_mismatch', 'Pending onboarding targets a different vault.');
    }
    const token = await this.readDeviceToken();
    const [self, connection] = await Promise.all([
      this.transport.getDeviceSelf(token),
      this.transport.connectionStatus(input.connectionId, input.secret)
    ]);
    if (
      self.vault_id !== state.vault_id ||
      self.device_id !== state.device_id ||
      connection.status !== 'consumed' ||
      connection.vault_id !== state.vault_id ||
      connection.device_id !== state.device_id ||
      (pending.journal.registered_device_id && pending.journal.registered_device_id !== state.device_id)
    ) {
      throw new PluginBlockedError('onboarding_identity_mismatch', 'Registered onboarding identity does not match local device state.');
    }
    if (!pending.journal.registered_device_id) {
      await this.writeOnboardingJournal({ ...pending.journal, registered_device_id: state.device_id, updated_at: nowIso() });
    }
    const localAlreadyApplied = state.local_main === self.current_main && (
      input.mode !== 'use_server' || (
        await this.git.commitExists(self.current_main) && await this.localContentMatchesTree(localFiles, self.current_main)
      )
    );
    if (localAlreadyApplied && (input.mode === 'use_server' || self.server_device_ref)) {
      await this.transport.acknowledgeOnboarding({
        vaultId: state.vault_id,
        deviceToken: token,
        appliedMain: state.local_main!
      });
      await this.completePendingOnboarding(input.connectionId);
      return { status: state.status_label, main: state.local_main! };
    }
    if (input.mode === 'use_server') {
      await this.createLocalRecoveryBundle('replace_local_with_server', self.current_main, localFiles);
      const pulled = await this.pullWithChunks({
        vaultId: state.vault_id,
        deviceId: state.device_id,
        deviceToken: token,
        currentLocalMain: state.local_main,
        currentEventSeq: state.last_event_seq
      });
      await this.git.importPack(pulled.packfile);
      await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
        extraAffectedPaths: localFiles,
        directoryIntents: pulled.manifest.directory_intents ?? [],
        explicitDirectories: pulled.manifest.explicit_directories ?? [],
        eventSeq: pulled.manifest.event_seq
      });
      await this.acknowledgeAppliedMain(await this.readState(), token, pulled.manifest.target_main);
      await this.transport.acknowledgeOnboarding({
        vaultId: state.vault_id,
        deviceToken: token,
        appliedMain: pulled.manifest.target_main
      });
      await this.writeState({ ...(await this.readState()), status_label: 'Synced', last_error_code: null, updated_at: nowIso() });
      await this.completePendingOnboarding(input.connectionId);
      return { status: 'Synced', main: pulled.manifest.target_main };
    }
    if (!self.server_device_ref) {
      return null;
    }

    await this.createLocalRecoveryBundle('initial_import', self.current_main, localFiles);
    try {
      const pulled = await this.pullWithChunks({
        vaultId: state.vault_id,
        deviceId: state.device_id,
        deviceToken: token,
        currentLocalMain: state.local_main,
        currentEventSeq: state.last_event_seq
      });
      await this.git.importPack(pulled.packfile);
    } catch (error) {
      if (!(error instanceof TransportError && error.code === 'device_blocked')) {
        throw error;
      }
      await this.normalizeAcceptedOnboardingProposal(self.server_device_ref, localFiles);
      await this.writeState({
        ...(await this.readState()),
        server_device_ref: self.server_device_ref,
        status_label: 'Review needed',
        last_error_code: 'conflict_review_required',
        updated_at: nowIso()
      });
      await this.updateOnboardingStage(input.connectionId, 'awaiting_conflict', input.mode);
      return { status: 'Review needed' };
    }

    await this.normalizeAcceptedOnboardingProposal(self.server_device_ref, localFiles);
    await this.writeState({
      ...(await this.readState()),
      server_device_ref: self.server_device_ref,
      status_label: 'Behind',
      last_error_code: null,
      updated_at: nowIso()
    });
    if (!(await this.pullAndApply({ allowDestructive: true }))) {
      throw new PluginBlockedError(
        'onboarding_local_changes_after_submit',
        'Local files changed after the onboarding proposal. Recovery is required before applying the resolved vault.'
      );
    }
    const finalState = await this.readState();
    if (!finalState.local_main) {
      throw new PluginBlockedError('onboarding_incomplete', 'Onboarding did not produce an applied server main.');
    }
    await this.transport.acknowledgeOnboarding({
      vaultId: state.vault_id,
      deviceToken: token,
      appliedMain: finalState.local_main
    });
    await this.completePendingOnboarding(input.connectionId);
    return { status: finalState.status_label, main: finalState.local_main };
  }

  private async normalizeAcceptedOnboardingProposal(serverDeviceRef: string, localFiles: string[]): Promise<void> {
    const state = await this.readState();
    const queue = await this.readQueue();
    const localCandidate = queue.pending_commit ?? state.local_head;
    const matchesAcceptedProposal = localCandidate
      ? await this.git.sameCommitTree(localCandidate, serverDeviceRef)
      : await this.localContentMatchesTree(localFiles, serverDeviceRef);
    if (!matchesAcceptedProposal) {
      throw new PluginBlockedError(
        'onboarding_local_changes_after_submit',
        'Local files changed after the onboarding proposal. Recovery is required before continuing.'
      );
    }
    await this.git.setLocalHead(serverDeviceRef);
    await this.writeState({
      ...state,
      server_device_ref: serverDeviceRef,
      local_head: serverDeviceRef,
      status_label: 'Review needed',
      last_error_code: 'conflict_review_required',
      updated_at: nowIso()
    });
    await this.writeQueue({
      pending_commit: serverDeviceRef,
      expected_device_ref: serverDeviceRef,
      status: 'conflicted',
      attempts: queue.attempts,
      updated_at: nowIso()
    });
  }

  async syncOnce(options: { confirmInitialImport?: boolean } = {}): Promise<{ status: string; main?: string; conflictId?: string }> {
    await this.initialize();
    if (!this.onboardingOperation && (await this.readPendingOnboarding())) {
      throw new PluginBlockedError('onboarding_incomplete', 'Finish or cancel browser onboarding before normal sync.');
    }
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    this.throwIfSyncBlocked(state);
    await this.flushEditorBuffersToDisk();
    await this.reconcileQueueWithLocalHead(await this.readState());
    const queueBeforeScan = await this.readQueue();
    let localFiles: string[];
    try {
      localFiles = await this.git.scanSyncableFiles();
    } catch (error) {
      if (error instanceof PathPolicyViolation) {
        await this.block(error.code, error.message, error.details);
      }
      throw error;
    }
    let pendingDirectoryIntents = await this.reconcileDirectoryState(localFiles);
    if (localFiles.length > 0 && !state.initial_import_confirmed && state.server_device_ref === null) {
      await this.createLocalRecoveryBundle('initial_import', state.local_main, localFiles);
      if (!options.confirmInitialImport) {
        await this.block('initial_import_confirmation_required', 'Initial import requires owner confirmation.');
      }
      await this.writeState({
        ...state,
        initial_import_confirmed: true,
        status_label: 'Ahead',
        updated_at: nowIso()
      });
    }

    let commit: string | null;
    try {
      commit = await this.git.createLocalCommit('obts: local vault changes', localFiles);
    } catch (error) {
      if (error instanceof PathPolicyViolation) {
        await this.block(error.code, error.message, error.details);
      }
      throw error;
    }
    if (!commit && pendingDirectoryIntents.length > 0) {
      commit = await this.git.createMetadataCommit('obts: local directory changes');
    }
    if (commit) {
      await this.writeQueue({
        pending_commit: commit,
        expected_device_ref: (await this.readState()).server_device_ref,
        status: 'queued_local',
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState({
        ...(await this.readState()),
        local_head: commit,
        status_label: 'Ahead',
        updated_at: nowIso()
      });
    }

    if (!commit) {
      if (pendingDirectoryIntents.length === 0) {
        await this.clearQueuedHintIfUnchanged(queueBeforeScan.change_seq ?? 0);
      }
    }

    const queue = await this.readQueue();
    if (queue.pending_commit) {
      const token = await this.readDeviceToken();
      const currentState = await this.readState();
      if (!currentState.vault_id || !currentState.device_id) {
        throw new PluginBlockedError('not_paired', 'Device is not paired.');
      }
      await this.writeState({
        ...currentState,
        status_label: 'Preparing upload',
        last_error_code: null,
        updated_at: nowIso()
      });
      await this.reportDeviceStatus().catch(() => undefined);
      pendingDirectoryIntents = (await this.readDirectoryState()).pending_intents;
      let result;
      try {
        const capabilities = await this.transport.capabilities().catch((error) => {
          if (error instanceof TransportError && error.status === 404) return null;
          throw error;
        });
        if (capabilities?.capabilities.includes(CHUNK_TRANSFER_CAPABILITY)) {
          result = await this.pushCommitInChunks(currentState, queue, token, pendingDirectoryIntents, capabilities);
        } else {
          const packfile = await this.git.createPackForCommit(
            queue.pending_commit,
            [queue.expected_device_ref, currentState.local_main].filter((commit): commit is string => typeof commit === 'string')
          );
          const manifest: DevicePushManifest = {
            api_version: API_VERSION,
            plugin_version: PLUGIN_VERSION,
            vault_id: currentState.vault_id,
            device_id: currentState.device_id,
            expected_device_ref: queue.expected_device_ref,
            target_commit: queue.pending_commit,
            packfile_sha256: sha256(packfile),
            packfile_bytes: packfile.byteLength,
            client_known_main: currentState.local_main,
            ...(queue.expected_device_ref === null && currentState.local_main ? { base_commit: currentState.local_main } : {}),
            ...(pendingDirectoryIntents.length > 0 ? { directory_intents: pendingDirectoryIntents } : {}),
            attempt_id: newId('sync')
          };
          await this.writeQueue({ ...queue, status: 'uploading', attempts: queue.attempts + 1, updated_at: nowIso() });
          await this.writeState({ ...currentState, status_label: 'Uploading', last_error_code: null, updated_at: nowIso() });
          await this.reportDeviceStatus().catch(() => undefined);
          result = await this.pushOrBlock(currentState, queue, token, manifest, packfile);
        }
      } catch (error) {
        const latestQueue = await this.readQueue();
        if (latestQueue.pending_commit === queue.pending_commit && latestQueue.status !== 'blocked_recovery') {
          await this.writeQueue({ ...latestQueue, status: 'queued_local', updated_at: nowIso() });
          await this.writeState({
            ...(await this.readState()),
            status_label: 'Ahead',
            last_error_code: latestQueue.attempts > queue.attempts ? 'upload_interrupted' : 'pack_preparation_failed',
            updated_at: nowIso()
          });
          await this.reportDeviceStatus().catch(() => undefined);
        }
        throw error;
      }
      if (result.status === 'conflicted') {
        await this.writeQueue({
          ...queue,
          status: 'conflicted',
          pending_commit: queue.pending_commit,
          updated_at: nowIso()
        });
        await this.writeState({
          ...currentState,
          server_device_ref: result.device_ref,
          status_label: 'Review needed',
          last_error_code: 'conflict_review_required',
          updated_at: nowIso()
        });
        return { status: 'Review needed', conflictId: result.conflict_id, main: result.main };
      }
      if (result.status === 'merged' || result.status === 'noop') {
        await this.writeQueue({
          pending_commit: null,
          expected_device_ref: result.device_ref,
          status: result.status === 'merged' ? 'merged' : 'idle',
          attempts: 0,
          updated_at: nowIso()
        });
        await this.writeState({
          ...currentState,
          server_device_ref: result.device_ref,
          local_head: queue.pending_commit,
          status_label: result.status === 'merged' ? 'Behind' : 'Synced',
          last_event_seq: Math.max(currentState.last_event_seq, result.event_seq),
          updated_at: nowIso()
        });
        await this.clearPendingDirectoryIntents();
      }
    }

    await this.pullAndApply({ allowDestructive: true });
    const finalState = await this.readState();
    await this.reportDeviceStatus().catch(() => undefined);
    return finalState.local_main
      ? { status: finalState.status_label, main: finalState.local_main }
      : { status: finalState.status_label };
  }

  private async pushCommitInChunks(
    currentState: LocalPluginState,
    queue: QueueState,
    token: string,
    directoryIntents: DirectoryIntent[],
    capabilities: SyncCapabilities,
    allowStaleRetry = true
  ): Promise<PushResult> {
    if (!currentState.vault_id || !currentState.device_id || !queue.pending_commit) {
      throw new PluginBlockedError('not_paired', 'Chunk transfer requires a paired device and pending commit.');
    }
    const exclude = [queue.expected_device_ref, currentState.local_main].filter((commit): commit is string => typeof commit === 'string');
    const groups = await this.git.planPackChunks(
      queue.pending_commit,
      exclude,
      capabilities.target_chunk_bytes,
      capabilities.max_chunk_bytes
    );
    if (groups.length === 0 || groups.length > capabilities.max_transfer_chunks) {
      throw new PluginBlockedError('invalid_transfer_plan', 'Git transfer plan is empty or exceeds the server chunk limit.');
    }
    const planSha256 = sha256(Buffer.from(JSON.stringify(groups)));
    const attemptId = `xfer_${sha256(Buffer.from(`${currentState.device_id}:${queue.pending_commit}:${queue.expected_device_ref ?? 'none'}:${planSha256}`)).slice(0, 32)}`;
    await this.writeQueue({ ...queue, status: 'uploading', attempts: queue.attempts + 1, updated_at: nowIso() });
    await this.writeState({ ...currentState, status_label: 'Uploading', last_error_code: null, updated_at: nowIso() });
    await this.reportDeviceStatus().catch(() => undefined);
    try {
      const descriptor = await this.transport.createPushTransfer({
        vaultId: currentState.vault_id,
        deviceToken: token,
        request: {
          api_version: API_VERSION,
          plugin_version: PLUGIN_VERSION,
          vault_id: currentState.vault_id,
          device_id: currentState.device_id,
          expected_device_ref: queue.expected_device_ref,
          target_commit: queue.pending_commit,
          client_known_main: currentState.local_main,
          ...(queue.expected_device_ref === null && currentState.local_main ? { base_commit: currentState.local_main } : {}),
          ...(directoryIntents.length > 0 ? { directory_intents: directoryIntents } : {}),
          attempt_id: attemptId,
          chunk_count: groups.length,
          plan_sha256: planSha256
        }
      });
      if (descriptor.status !== 'open') {
        if (descriptor.result && descriptor.result.status !== 'rejected') return descriptor.result;
        throw new PluginBlockedError('transfer_closed', 'The resumable transfer is closed without an accepted result.');
      }
      const received = new Set(descriptor.received_chunks);
      for (let index = 0; index < groups.length; index += 1) {
        if (received.has(index)) continue;
        const packfile = await this.git.packObjectChunk(groups[index]!, capabilities.max_chunk_bytes);
        await this.transport.putPushChunk({
          vaultId: currentState.vault_id,
          deviceToken: token,
          transferId: descriptor.transfer_id,
          index,
          packfile,
          sha256: sha256(packfile)
        });
        await this.reportDeviceStatus().catch(() => undefined);
      }
      return await this.transport.finalizePushTransfer({
        vaultId: currentState.vault_id,
        deviceToken: token,
        transferId: descriptor.transfer_id
      });
    } catch (error) {
      if (allowStaleRetry && error instanceof TransportError && error.code === 'stale_device_ref') {
        const self = await this.transport.getDeviceSelf(token);
        const recoveredRef = self.server_device_ref;
        if (recoveredRef && recoveredRef !== queue.expected_device_ref && await this.git.isAncestor(recoveredRef, queue.pending_commit)) {
          const recoveredQueue = { ...queue, expected_device_ref: recoveredRef, status: 'uploading' as const, updated_at: nowIso() };
          await this.writeQueue(recoveredQueue);
          await this.writeState({ ...currentState, server_device_ref: recoveredRef, status_label: 'Preparing upload', updated_at: nowIso() });
          return await this.pushCommitInChunks(
            { ...currentState, server_device_ref: recoveredRef },
            recoveredQueue,
            token,
            directoryIntents,
            capabilities,
            false
          );
        }
      }
      if (error instanceof TransportError && ['same_device_non_fast_forward', 'stale_device_ref', 'device_blocked'].includes(error.code)) {
        await this.writeQueue({ ...queue, status: 'blocked_recovery', updated_at: nowIso() });
        await this.block(error.code, error.message);
      }
      throw error;
    }
  }

  async replaceLocalWithServer(): Promise<{ status: string; main: string }> {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    if (state.last_error_code !== 'replace_local_with_server_required') {
      throw new PluginBlockedError('replace_local_with_server_not_required', 'Local replacement is not currently required.');
    }
    const token = await this.readDeviceToken();
    const localFiles = await this.git.scanSyncableFiles();
    const pulled = await this.pullWithChunks({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main,
      currentEventSeq: state.last_event_seq
    });
    await this.git.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
      extraAffectedPaths: localFiles,
      directoryIntents: pulled.manifest.directory_intents ?? [],
      explicitDirectories: pulled.manifest.explicit_directories ?? [],
      eventSeq: pulled.manifest.event_seq
    });
    await this.acknowledgeAppliedMain(state, token, pulled.manifest.target_main);
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: state.server_device_ref,
      status: 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState({
      ...(await this.readState()),
      initial_import_confirmed: true,
      status_label: 'Synced',
      last_error_code: null,
      updated_at: nowIso()
    });
    return { status: 'Synced', main: pulled.manifest.target_main };
  }

  async rebuildFromServerMain(): Promise<RebuildResult> {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    if (state.last_error_code === 'conflict_review_required') {
      throw new PluginBlockedError(
        'conflict_review_required',
        'A server conflict requires dashboard review before local rebuild can continue.'
      );
    }
    if (state.last_error_code === 'replace_local_with_server_required') {
      throw new PluginBlockedError(
        'replace_local_with_server_required',
        'Use replace-local-with-server for first pairing divergence.'
      );
    }

    const token = await this.readDeviceToken();
    const queue = await this.readQueue();
    const localFiles = await this.git.scanSyncableFiles();
    const localSnapshot = await readFileSnapshot(this.vaultDir, localFiles);
    const pulled = await this.pullWithChunks({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main,
      currentEventSeq: state.last_event_seq
    });
    await this.git.importPack(pulled.packfile);
    const priorLocalFiles = state.local_main ? await this.materializedTreeFiles(state.local_main) : [];

    const pendingClassification = await this.classifyPendingCommit(
      queue.pending_commit,
      state.server_device_ref,
      pulled.manifest.target_main
    );

    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
      extraAffectedPaths: localFiles,
      directoryIntents: pulled.manifest.directory_intents ?? [],
      explicitDirectories: pulled.manifest.explicit_directories ?? [],
      eventSeq: pulled.manifest.event_seq
    });
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(state, token, pulled.manifest.target_main);
    }

    if (pendingClassification === 'divergent') {
      await this.createLocalRecoveryBundle('rebuild_from_server', pulled.manifest.target_main, localFiles);
      await this.writeQueue({
        pending_commit: queue.pending_commit,
        expected_device_ref: state.server_device_ref,
        status: 'blocked_recovery',
        attempts: queue.attempts,
        updated_at: nowIso()
      });
      await this.block('same_device_non_fast_forward', 'Divergent same-device history requires export and reset or re-pair.');
    }

    if (pendingClassification === 'fast_forward' && queue.pending_commit) {
      await this.git.setLocalHead(pulled.manifest.target_main);
      await this.writeQueue({
        pending_commit: queue.pending_commit,
        expected_device_ref: state.server_device_ref,
        status: 'queued_local',
        attempts: queue.attempts,
        updated_at: nowIso()
      });
      await this.writeState({
        ...(await this.readState()),
        local_head: pulled.manifest.target_main,
        status_label: 'Ahead',
        last_error_code: null,
        updated_at: nowIso()
      });
      return {
        status: 'Ahead',
        main: pulled.manifest.target_main,
        preservedPendingCommit: queue.pending_commit
      };
    }

    if (pendingClassification === 'repeat') {
      await this.writeQueue({
        pending_commit: null,
        expected_device_ref: state.server_device_ref,
        status: 'idle',
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState({
        ...(await this.readState()),
        status_label: 'Synced',
        last_error_code: null,
        updated_at: nowIso()
      });
      return { status: 'Synced', main: pulled.manifest.target_main };
    }

    if (!(await this.localSnapshotMatchesTree(localSnapshot, pulled.manifest.target_main))) {
      await restoreFileSnapshot(this.vaultDir, localSnapshot, priorLocalFiles);
      const recoveryCommit = await this.git.createLocalCommit('obts: rebuild preserved local edits');
      if (recoveryCommit) {
        await this.writeQueue({
          pending_commit: recoveryCommit,
          expected_device_ref: state.server_device_ref,
          status: 'queued_local',
          attempts: 0,
          updated_at: nowIso()
        });
        await this.writeState({
          ...(await this.readState()),
          local_head: recoveryCommit,
          status_label: 'Ahead',
          last_error_code: null,
          updated_at: nowIso()
        });
        return { status: 'Ahead', main: pulled.manifest.target_main, recoveryCommit };
      }
    }

    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: state.server_device_ref,
      status: 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState({
      ...(await this.readState()),
      status_label: 'Synced',
      last_error_code: null,
      updated_at: nowIso()
    });
    return { status: 'Synced', main: pulled.manifest.target_main };
  }

  async pullAndApply(options: { allowDestructive: boolean }): Promise<boolean> {
    let state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return false;
    }
    this.throwIfSyncBlocked(state);
    if (!(await this.ensureNoLocalChangesBeforeApply(state))) {
      return false;
    }
    state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return false;
    }
    const token = await this.readDeviceToken();
    const pulled = await this.pullWithChunks({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main,
      currentEventSeq: state.last_event_seq
    });
    await this.git.importPack(pulled.packfile);
    state = await this.readState();
    if (!(await this.ensureNoLocalChangesBeforeApply(state))) {
      return false;
    }
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, options.allowDestructive, {
      requireCleanVisibleState: true,
      directoryIntents: pulled.manifest.directory_intents ?? [],
      explicitDirectories: pulled.manifest.explicit_directories ?? [],
      eventSeq: pulled.manifest.event_seq
    });
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(state, token, pulled.manifest.target_main);
    }
    await this.clearResolvedConflictQueue();
    return true;
  }

  async pollRemoteEventsAndApply(): Promise<{ applied: boolean; status: string }> {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    const wasConflictBlocked = state.last_error_code === 'conflict_review_required';
    if (!wasConflictBlocked) {
      this.throwIfSyncBlocked(state);
    }
    const token = await this.readDeviceToken();
    const after = Number.isSafeInteger(state.last_event_seq) && state.last_event_seq >= 0 ? state.last_event_seq : 0;
    let page: Awaited<ReturnType<TransportClient['pollEvents']>>;
    try {
      page = await this.transport.pollEvents({
        vaultId: state.vault_id,
        deviceToken: token,
        after
      });
    } catch (error) {
      if (error instanceof TransportError && error.code === 'event_cursor_expired') {
        const currentEventSeq =
          typeof error.details?.current_event_seq === 'number' && Number.isSafeInteger(error.details.current_event_seq)
            ? error.details.current_event_seq
            : after;
        const nextState = await this.readState();
        if (nextState.last_error_code === 'conflict_review_required') {
          await this.writeState({
            ...nextState,
            last_error_code: null,
            status_label: 'Behind',
            last_event_seq: currentEventSeq,
            updated_at: nowIso()
          });
        } else {
          await this.writeState({
            ...nextState,
            last_event_seq: currentEventSeq,
            updated_at: nowIso()
          });
        }
        try {
          const applied = await this.pullAndApply({ allowDestructive: true });
          const refreshed = await this.uploadAutoPreservedChanges(applied);
          return { applied, status: refreshed.status_label };
        } catch (pullError) {
          if (wasConflictBlocked && pullError instanceof TransportError && pullError.code === 'device_blocked') {
            await this.writeState({
              ...(await this.readState()),
              last_error_code: 'conflict_review_required',
              status_label: 'Review needed',
              last_event_seq: currentEventSeq,
              updated_at: nowIso()
            });
            return { applied: false, status: 'Review needed' };
          }
          throw pullError;
        }
      }
      throw error;
    }

    await this.writeState({
      ...(await this.readState()),
      last_event_seq: page.current_event_seq,
      updated_at: nowIso()
    });
    const currentState = await this.readState();
    const shouldPull = page.events.some((event) => {
      const main = event.commit_cursors.main;
      const hasNewMain = typeof main === 'string' && main !== currentState.local_main;
      if (wasConflictBlocked) {
        return event.event_type === 'conflict_resolved' && hasNewMain;
      }
      return (event.event_type === 'main_advanced' || event.event_type === 'conflict_resolved') && hasNewMain;
    });
    if (!shouldPull) {
      return { applied: false, status: currentState.status_label };
    }
    if (wasConflictBlocked && currentState.last_error_code === 'conflict_review_required') {
      await this.writeState({
        ...currentState,
        last_error_code: null,
        status_label: 'Behind',
        updated_at: nowIso()
      });
    }
    const applied = await this.pullAndApply({ allowDestructive: true });
    const finalState = await this.uploadAutoPreservedChanges(applied);
    return { applied, status: finalState.status_label };
  }

  private async uploadAutoPreservedChanges(applied: boolean): Promise<LocalPluginState> {
    let state = await this.readState();
    const queue = await this.readQueue();
    if (applied && queue.status === 'queued_local' && queue.pending_commit && state.last_error_code === null) {
      await this.syncOnce();
      state = await this.readState();
    }
    return state;
  }

  async unpairCurrentDevice(): Promise<{ status: string }> {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    const token = await this.readDeviceToken();
    await this.transport.unpairDevice({
      vaultId: state.vault_id,
      deviceToken: token
    });
    const baselineMain = state.local_main ?? (await this.git.resolveRef('refs/heads/main'));
    await rm(join(this.vaultDir, '.obts', 'auth', 'device-token.json'), { force: true });
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: null,
      status: 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState({
      user_id: null,
      vault_id: null,
      device_id: null,
      device_name: null,
      device_ref: null,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: 'Not paired',
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: state.vault_id,
      unpaired_baseline_main: baselineMain,
      updated_at: nowIso()
    });
    return { status: 'Not paired' };
  }

  async recordLocalChangeHint(paths: string[]): Promise<void> {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    this.throwIfSyncBlocked(state);
    const changedPaths = paths
      .map((path) => normalizeVaultPath(path))
      .filter((result): result is { ok: true; path: string } => result.ok)
      .map((result) => result.path)
      .filter((path) => isSyncableVaultPath(path))
      .sort();
    const uniqueChangedPaths = [...new Set(changedPaths)];
    if (uniqueChangedPaths.length === 0) {
      return;
    }
    assertSyncableTreePaths(uniqueChangedPaths);
    const queue = await this.readQueue();
    if (!queue.pending_commit) {
      await this.writeQueue({
        pending_commit: null,
        expected_device_ref: state.server_device_ref,
        status: 'queued_local',
        attempts: 0,
        change_seq: (queue.change_seq ?? 0) + 1,
        updated_at: nowIso()
      });
    }
    const hasCommittedLocal = Boolean(
      queue.pending_commit || (state.local_head && state.local_head !== state.local_main)
    );
    await this.writeState({
      ...state,
      status_label: hasCommittedLocal ? 'Ahead' : 'Checking',
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  async renameCurrentDevice(deviceName: string): Promise<string> {
    await this.initialize();
    const normalized = readDisplayName({ device_name: deviceName }, 'device_name');
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    const token = await this.readDeviceToken();
    const renamed = await this.transport.renameCurrentDevice(token, normalized);
    if (renamed.device_id !== state.device_id) {
      throw new PluginBlockedError('device_identity_mismatch', 'Server device identity does not match local state.');
    }
    await this.applyServerDeviceName(renamed.device_name);
    return renamed.device_name;
  }

  async reportDeviceStatus(): Promise<void> {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    let token: string;
    try {
      token = await this.readDeviceToken();
    } catch {
      return;
    }
    const queue = await this.readQueue();
    const result = await this.transport.reportDeviceStatus({
      vaultId: state.vault_id,
      deviceToken: token,
      report: {
        plugin_version: PLUGIN_VERSION,
        local_status_label: state.status_label || 'Checking',
        local_error_code: state.last_error_code,
        local_queue_status: queue.status,
        local_main: state.local_main,
        local_head: state.local_head,
        path_capabilities: {
          adapter: 'node-fs',
          platform: process.platform
        }
      }
    });
    await this.applyServerDeviceName(result.device_name);
  }

  private async applyServerDeviceName(deviceName: string): Promise<void> {
    const state = await this.readState();
    if (state.device_name !== deviceName) {
      await this.writeState({ ...state, device_name: deviceName, updated_at: nowIso() });
    }
    this.settings.deviceName = deviceName;
  }

  async readState(): Promise<LocalPluginState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
      if (await this.hasActiveTokenWithoutIdentity(state)) {
        return (await this.readBackupState()) ?? this.localStateIncomplete(state);
      }
      return await this.preferRecoverableBackupState(state);
    } catch {
      if (await exists(join(this.vaultDir, '.obts', 'auth', 'device-token.json'))) {
        const backupState = await this.readBackupState();
        return backupState ?? this.localStateIncomplete(null);
      }
      return {
        user_id: null,
        vault_id: this.settings.vaultId ?? null,
        device_id: this.settings.deviceId ?? null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        last_event_seq: 0,
        unpaired_baseline_vault_id: null,
        unpaired_baseline_main: null,
        updated_at: nowIso()
      };
    }
  }

  async resetLocalPairingState(): Promise<{ status: 'Not paired'; recoveryBundleId: string | null }> {
    const state = await this.readState();
    const localFiles = await listLocalVaultFiles(this.vaultDir);
    const recoveryBundleId = localFiles.length > 0 ? await this.createLocalRecoveryBundle('rebuild_from_server', state.local_main, localFiles) : null;
    await rm(join(this.vaultDir, '.obts', 'auth', 'device-token.json'), { force: true });
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: null,
      status: 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState({
      user_id: null,
      vault_id: null,
      device_id: null,
      device_name: null,
      device_ref: null,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: 'Not paired',
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    return { status: 'Not paired', recoveryBundleId };
  }

  async readQueue(): Promise<QueueState> {
    try {
      const queue = JSON.parse(await readFile(this.queuePath, 'utf8')) as QueueState;
      return {
        ...queue,
        change_seq: typeof queue.change_seq === 'number' && Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0
          ? queue.change_seq
          : 0
      };
    } catch {
      return {
        pending_commit: null,
        expected_device_ref: null,
        status: 'idle',
        attempts: 0,
        change_seq: 0,
        updated_at: nowIso()
      };
    }
  }

  private async readDirectoryState(): Promise<DirectorySyncState> {
    try {
      const state = JSON.parse(await readFile(this.directoryStatePath, 'utf8')) as DirectorySyncState;
      return {
        observed_dirs: Array.isArray(state.observed_dirs) ? state.observed_dirs : [],
        explicit_empty_dirs: Array.isArray(state.explicit_empty_dirs) ? state.explicit_empty_dirs : [],
        pending_intents: compactDirectoryIntents(Array.isArray(state.pending_intents) ? state.pending_intents : []),
        updated_at: typeof state.updated_at === 'string' ? state.updated_at : nowIso()
      };
    } catch {
      return { observed_dirs: [], explicit_empty_dirs: [], pending_intents: [], updated_at: nowIso() };
    }
  }

  private async writeDirectoryState(state: DirectorySyncState): Promise<void> {
    await writeJson(this.directoryStatePath, {
      observed_dirs: [...new Set(state.observed_dirs)].sort(),
      explicit_empty_dirs: [...new Set(state.explicit_empty_dirs)].sort(),
      pending_intents: compactDirectoryIntents(state.pending_intents),
      updated_at: state.updated_at
    });
  }

  private async reconcileDirectoryState(knownLocalFiles?: string[]): Promise<DirectoryIntent[]> {
    if (!(await exists(this.directoryStatePath))) {
      await this.refreshDirectoryStateFromDisk([], knownLocalFiles);
      return [];
    }
    const previous = await this.readDirectoryState();
    const currentDirs = await listLocalVaultDirectories(this.vaultDir);
    const currentFiles = knownLocalFiles ?? await this.git.scanSyncableFiles();
    const explicitDirs = explicitEmptyDirectories(currentDirs, currentFiles);
    const previousDirs = new Set(previous.observed_dirs);
    const previousExplicitDirs = new Set(previous.explicit_empty_dirs);
    const currentDirSet = new Set(currentDirs);
    const createdIntents = explicitDirs
      .filter((path) => !previousDirs.has(path) || !previousExplicitDirs.has(path))
      .map((path): DirectoryIntent => ({ op: 'create', path }));
    const deletedIntents = topmostDirectories(previous.observed_dirs.filter((path) => !currentDirSet.has(path))).map(
      (path): DirectoryIntent => ({ op: 'delete', path })
    );
    const pendingIntents = compactDirectoryIntents([...previous.pending_intents, ...createdIntents, ...deletedIntents]);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      explicit_empty_dirs: explicitDirs,
      pending_intents: pendingIntents,
      updated_at: nowIso()
    });
    return pendingIntents;
  }

  private async clearPendingDirectoryIntents(): Promise<void> {
    await this.refreshDirectoryStateFromDisk([]);
  }

  private async refreshDirectoryStateFromDisk(pendingIntents?: DirectoryIntent[], knownLocalFiles?: string[]): Promise<void> {
    const previous = await this.readDirectoryState();
    const currentDirs = await listLocalVaultDirectories(this.vaultDir);
    const currentFiles = knownLocalFiles ?? await this.git.scanSyncableFiles();
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      explicit_empty_dirs: explicitEmptyDirectories(currentDirs, currentFiles),
      pending_intents: pendingIntents ?? previous.pending_intents,
      updated_at: nowIso()
    });
  }

  private async hasActionableDirectoryWork(directoryIntents: DirectoryIntent[], explicitDirectories: string[]): Promise<boolean> {
    for (const intent of directoryIntents) {
      const absolutePath = join(this.vaultDir, intent.path);
      const isDirectory = await pathIsDirectory(absolutePath);
      if (intent.op === 'create' && !isDirectory) return true;
      if (intent.op === 'delete' && isDirectory && await directoryIsEmpty(absolutePath)) return true;
    }
    for (const path of explicitDirectories) {
      if (!(await pathIsDirectory(join(this.vaultDir, path)))) return true;
    }
    return false;
  }

  private async applyDirectoryChanges(directoryIntents: DirectoryIntent[], explicitDirectories: string[]): Promise<void> {
    for (const intent of directoryIntents.filter((entry) => entry.op === 'delete').sort((left, right) => right.path.length - left.path.length)) {
      const absolutePath = join(this.vaultDir, intent.path);
      if ((await pathIsDirectory(absolutePath)) && (await directoryIsEmpty(absolutePath))) {
        await rm(absolutePath, { recursive: true, force: true });
      }
    }
    for (const path of explicitDirectories.sort((left, right) => left.length - right.length)) {
      await mkdir(join(this.vaultDir, path), { recursive: true, mode: 0o700 });
    }
  }

  private async applyTargetMain(
    targetMain: string,
    changedPaths: string[],
    allowDestructive: boolean,
    options: {
      extraAffectedPaths?: string[];
      requireCleanVisibleState?: boolean;
      directoryIntents?: DirectoryIntent[];
      explicitDirectories?: string[];
      eventSeq?: number;
    } = {}
  ): Promise<void> {
    const state = await this.readState();
    const directoryIntents = compactDirectoryIntents(options.directoryIntents ?? []);
    const explicitDirectories = [...new Set(options.explicitDirectories ?? [])].sort();
    const hasDirectoryWork = await this.hasActionableDirectoryWork(directoryIntents, explicitDirectories);
    if (state.local_main === targetMain && (options.extraAffectedPaths?.length ?? 0) === 0 && !hasDirectoryWork) {
      await this.writeState({
        ...state,
        status_label: 'Synced',
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq, options.eventSeq ?? state.last_event_seq),
        updated_at: nowIso()
      });
      return;
    }
    if (options.requireCleanVisibleState && !(await this.ensureNoLocalChangesBeforeApply(state))) {
      return;
    }
    const applyId = newId('apply');
    let releaseApplyLock: (() => Promise<void>) | null = null;
    try {
      releaseApplyLock = await this.recovery.acquireApplyLock(applyId);
    } catch (error) {
      if (error instanceof ApplyLockActiveError) {
        await this.block('apply_lock_active', 'Another apply operation already holds the local vault lock.');
      }
      throw error;
    }
    try {
      await this.writeState({
        ...state,
        status_label: 'Applying',
        last_error_code: null,
        updated_at: nowIso()
      });
      const targetFiles = new Set(await this.materializedTreeFiles(targetMain));
      const affected = new Set(changedPaths);
      if (state.local_main) {
        for (const path of await this.materializedTreeFiles(state.local_main)) {
          if (!targetFiles.has(path)) {
            affected.add(path);
          }
        }
      }
      for (const path of options.extraAffectedPaths ?? []) {
        affected.add(path);
      }
      const localVaultFiles = await listLocalVaultFiles(this.vaultDir);
      for (const path of materializationConflictFiles(new Set([...targetFiles, ...affected]), localVaultFiles)) {
        affected.add(path);
      }
      const affectedPaths = [...affected].filter((path) => isRecoverableApplyPath(path)).sort();
      const preflight: Record<string, string | null> = {};
      for (const path of affectedPaths) {
        preflight[path] = await sha256File(join(this.vaultDir, path));
      }

      const journal: ApplyJournal = {
        apply_id: applyId,
        operation_type: 'pull_apply',
        target_main: targetMain,
        expected_prior_local_main: state.local_main,
        expected_prior_local_device_ref: state.server_device_ref,
        phase: 'planned',
        affected_paths: affectedPaths,
        preflight_sha256: preflight,
        recovery_bundle_id: null,
        last_completed_step: null,
        redacted_error_category: null
      };
      await this.recovery.writeApplyJournal(journal);

      if (affectedPaths.length > 0) {
        if (!allowDestructive) {
          journal.phase = 'blocked_recovery';
          journal.redacted_error_category = 'destructive_apply_not_allowed';
          await this.recovery.writeApplyJournal(journal);
          await this.block('unsafe_local_state', 'Destructive apply is not allowed in this mode.');
        }
        let bundleId: string | null = null;
        try {
          bundleId = await this.recovery.createRecoveryBundle({
            vaultId: state.vault_id ?? 'unknown',
            deviceId: state.device_id ?? 'unknown',
            operationType: 'pull_apply',
            targetMain,
            priorLocalMain: state.local_main,
            priorLocalDeviceRef: state.server_device_ref,
            affectedPaths,
            platform: process.platform,
            pluginVersion: PLUGIN_VERSION,
            journal,
            localRefsPack: await this.git.createRecoveryRefsPack()
          });
        } catch {
          journal.phase = 'blocked_recovery';
          journal.redacted_error_category = 'recovery_bundle_failed';
          await this.recovery.writeApplyJournal(journal);
          await this.block('recovery_bundle_failed', 'Recovery bundle creation failed before apply.');
        }
        if (bundleId === null) {
          throw new Error('Recovery bundle creation did not produce a bundle ID.');
        }
        journal.recovery_bundle_id = bundleId;
        journal.phase = 'recovery_bundle_written';
        journal.last_completed_step = 'recovery_bundle';
        await this.recovery.writeApplyJournal(journal);
      }

      if (options.requireCleanVisibleState && !(await this.ensureNoLocalChangesBeforeApply(state))) {
        await this.recovery.clearApplyJournal();
        return;
      }
      journal.phase = 'writing_files';
      await this.recovery.writeApplyJournal(journal);
      for (const path of affectedPaths) {
        const currentHash = await sha256File(join(this.vaultDir, path));
        if (currentHash !== preflight[path]) {
          journal.phase = 'blocked_recovery';
          journal.redacted_error_category = 'preflight_hash_changed';
          await this.recovery.writeApplyJournal(journal);
          await this.block('unsafe_local_state', 'A local file changed during apply preflight.');
        }
      }
      await this.writeTargetFilesFromJournal(journal, targetFiles);
      await this.applyDirectoryChanges(directoryIntents, explicitDirectories);

      journal.phase = 'verifying';
      journal.last_completed_step = 'files_written';
      await this.recovery.writeApplyJournal(journal);
      let preservedLocalChangePaths: string[] = [];
      if (options.requireCleanVisibleState) {
        await this.flushEditorBuffersToDisk();
        try {
          preservedLocalChangePaths = await this.localChangedPathsFromTree(targetMain);
        } catch (error) {
          journal.phase = 'blocked_recovery';
          journal.redacted_error_category = categorizeRecoveryError(error);
          await this.recovery.writeApplyJournal(journal);
          if (error instanceof PathPolicyViolation) {
            await this.block(error.code, error.message, error.details);
          }
          throw error;
        }
        if (preservedLocalChangePaths.length > 0) {
          await this.createLocalRecoveryBundle('rebuild_from_server', targetMain, preservedLocalChangePaths);
        }
      }
      await this.git.setLocalMain(targetMain);
      await this.git.setLocalHead(targetMain);
      journal.phase = 'committed';
      journal.last_completed_step = 'refs_updated';
      await this.recovery.writeApplyJournal(journal);
      await this.writeState({
        ...state,
        local_main: targetMain,
        local_head: targetMain,
        status_label: 'Synced',
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq, options.eventSeq ?? state.last_event_seq),
        updated_at: nowIso()
      });
      await this.refreshDirectoryStateFromDisk();
      await this.recovery.clearApplyJournal();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(targetMain, state.server_device_ref);
      }
    } finally {
      if (releaseApplyLock) {
        await releaseApplyLock();
      }
    }
  }

  private async recoverBlockedApplyWithPreservedLocalChanges(journal: ApplyJournal, state: LocalPluginState): Promise<boolean> {
    if (
      journal.phase !== 'blocked_recovery' ||
      journal.redacted_error_category !== 'local_changed_during_apply' ||
      !(await this.git.commitExists(journal.target_main))
    ) {
      return false;
    }

    const canRecoverFinalVisibleTree = journal.last_completed_step === 'files_written' || journal.last_completed_step === 'refs_updated';
    const targetFiles = new Set(await this.materializedTreeFiles(journal.target_main));
    let preservedLocalChangePaths: string[] = [];
    if (canRecoverFinalVisibleTree) {
      preservedLocalChangePaths = await this.localChangedPathsFromTree(journal.target_main);
    } else {
      if (!(await this.affectedApplyPathsMatchTarget(journal, targetFiles))) {
        return false;
      }
      preservedLocalChangePaths = await this.classifySafeResidualLocalChanges(state, journal, journal.target_main);
      if (preservedLocalChangePaths.length === 0) {
        return false;
      }
    }

    let releaseApplyLock: (() => Promise<void>) | null = null;
    try {
      await this.recovery.clearApplyLock();
      releaseApplyLock = await this.recovery.acquireApplyLock(journal.apply_id);
      if (preservedLocalChangePaths.length > 0) {
        await this.createLocalRecoveryBundle('rebuild_from_server', journal.target_main, preservedLocalChangePaths);
      }
      await this.git.setLocalMain(journal.target_main);
      await this.git.setLocalHead(journal.target_main);
      journal.phase = 'committed';
      journal.last_completed_step = 'refs_updated';
      journal.redacted_error_category = null;
      await this.recovery.writeApplyJournal(journal);
      await this.writeState({
        ...state,
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: 'Synced',
        last_error_code: null,
        updated_at: nowIso()
      });
      await this.recovery.clearApplyJournal();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(journal.target_main, state.server_device_ref);
      }
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step ?? 'recovery_bundle';
      await this.recovery.writeApplyJournal(journal);
      return false;
    } finally {
      if (releaseApplyLock) {
        await releaseApplyLock();
      }
    }
  }

  private async recoverIncompleteApplyJournal(journal: ApplyJournal, state: LocalPluginState): Promise<boolean> {
    if (journal.phase === 'blocked_recovery' && journal.redacted_error_category === 'local_changed_during_apply') {
      return false;
    }
    if (!(await this.git.commitExists(journal.target_main))) {
      return false;
    }

    const targetFiles = new Set(await this.materializedTreeFiles(journal.target_main));
    if (!(await this.applyJournalMatchesCurrentFiles(journal, targetFiles))) {
      journal.phase = 'blocked_recovery';
      journal.redacted_error_category = 'local_files_diverge_from_journal';
      journal.last_completed_step = journal.last_completed_step ?? 'recovery_bundle';
      await this.recovery.writeApplyJournal(journal);
      return false;
    }

    let releaseApplyLock: (() => Promise<void>) | null = null;
    try {
      await this.recovery.clearApplyLock();
      releaseApplyLock = await this.recovery.acquireApplyLock(journal.apply_id);

      if (journal.affected_paths.length > 0 && journal.recovery_bundle_id === null) {
        journal.recovery_bundle_id = await this.recovery.createRecoveryBundle({
          vaultId: state.vault_id ?? 'unknown',
          deviceId: state.device_id ?? 'unknown',
          operationType: journal.operation_type,
          targetMain: journal.target_main,
          priorLocalMain: journal.expected_prior_local_main,
          priorLocalDeviceRef: journal.expected_prior_local_device_ref,
          affectedPaths: journal.affected_paths,
          platform: process.platform,
          pluginVersion: PLUGIN_VERSION,
          journal,
          localRefsPack: await this.git.createRecoveryRefsPack()
        });
        journal.last_completed_step = 'recovery_bundle';
        journal.phase = 'recovery_bundle_written';
        await this.recovery.writeApplyJournal(journal);
      }

      journal.phase = 'writing_files';
      journal.redacted_error_category = null;
      await this.recovery.writeApplyJournal(journal);
      await this.writeTargetFilesFromJournal(journal, targetFiles);

      journal.phase = 'verifying';
      journal.last_completed_step = 'files_written';
      await this.recovery.writeApplyJournal(journal);
      await this.git.setLocalMain(journal.target_main);
      await this.git.setLocalHead(journal.target_main);
      journal.phase = 'committed';
      journal.last_completed_step = 'refs_updated';
      await this.recovery.writeApplyJournal(journal);
      await this.writeState({
        ...state,
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: 'Synced',
        last_error_code: null,
        updated_at: nowIso()
      });
      await this.recovery.clearApplyJournal();
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step ?? 'recovery_bundle';
      await this.recovery.writeApplyJournal(journal);
      return false;
    } finally {
      if (releaseApplyLock) {
        await releaseApplyLock();
      }
    }
  }

  private async affectedApplyPathsMatchTarget(journal: ApplyJournal, targetFiles: Set<string>): Promise<boolean> {
    for (const path of journal.affected_paths) {
      const currentHash = await sha256File(join(this.vaultDir, path));
      const targetContent = targetFiles.has(path) ? await this.git.readBlob(journal.target_main, path) : null;
      const targetHash = targetContent === null ? null : sha256(targetContent);
      if (currentHash !== targetHash) {
        return false;
      }
    }
    return true;
  }

  private async localChangedPathsFromTree(targetMain: string): Promise<string[]> {
    const localFiles = new Set(await this.git.scanSyncableFiles());
    const targetFiles = new Set(await this.materializedTreeFiles(targetMain));
    const changedPaths: string[] = [];
    for (const path of [...new Set([...localFiles, ...targetFiles])].sort()) {
      const localContent = localFiles.has(path) ? await readFile(join(this.vaultDir, path)) : null;
      const targetContent = targetFiles.has(path) ? await this.git.readBlob(targetMain, path) : null;
      if (!buffersEqual(localContent, targetContent)) {
        changedPaths.push(path);
      }
    }
    return changedPaths;
  }

  private async classifySafeResidualLocalChanges(
    state: LocalPluginState,
    journal: ApplyJournal,
    targetMain: string
  ): Promise<string[]> {
    if (!(await this.localContentMatchesTree(await this.git.scanSyncableFiles(), targetMain))) {
      const queue = await this.readQueue();
      const pendingCommit = queue.status === 'conflicted' ? queue.pending_commit : null;
      if (!pendingCommit || !(await this.git.commitExists(pendingCommit))) {
        return [];
      }
      const localFiles = new Set(await this.git.scanSyncableFiles());
      const targetFiles = new Set(await this.materializedTreeFiles(targetMain));
      const candidatePaths = [...new Set([...localFiles, ...targetFiles])].sort();
      const preservedPaths: string[] = [];
      for (const path of candidatePaths) {
        const localContent = localFiles.has(path) ? await readFile(join(this.vaultDir, path)) : null;
        const targetContent = targetFiles.has(path) ? await this.git.readBlob(targetMain, path) : null;
        if (buffersEqual(localContent, targetContent)) {
          continue;
        }
        if (journal.affected_paths.some((affectedPath) => changedPathsConflict(path, affectedPath))) {
          return [];
        }
        const pendingContent = await this.git.readBlob(pendingCommit, path);
        if (!buffersEqual(localContent, pendingContent)) {
          return [];
        }
        const priorContent = state.local_main ? await this.git.readBlob(state.local_main, path) : null;
        if (buffersEqual(pendingContent, priorContent)) {
          return [];
        }
        preservedPaths.push(path);
      }
      return preservedPaths;
    }
    return [];
  }

  private async queuePreservedLocalChanges(targetMain: string, expectedDeviceRef: string | null): Promise<void> {
    const preservedCommit = await this.git.createLocalCommit('obts: preserve local changes after conflict resolution');
    if (!preservedCommit) {
      return;
    }
    await this.writeQueue({
      pending_commit: preservedCommit,
      expected_device_ref: expectedDeviceRef,
      status: 'queued_local',
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState({
      ...(await this.readState()),
      local_main: targetMain,
      local_head: preservedCommit,
      status_label: 'Ahead',
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  private async applyJournalMatchesCurrentFiles(journal: ApplyJournal, targetFiles: Set<string>): Promise<boolean> {
    for (const path of journal.affected_paths) {
      const currentHash = await sha256File(join(this.vaultDir, path));
      const preflightHash = journal.preflight_sha256[path] ?? null;
      if (currentHash === preflightHash) {
        continue;
      }
      if (journal.phase !== 'writing_files' && journal.phase !== 'verifying') {
        return false;
      }
      const targetContent = targetFiles.has(path) ? await this.git.readBlob(journal.target_main, path) : null;
      const targetHash = targetContent === null ? null : sha256(targetContent);
      if (currentHash !== targetHash) {
        return false;
      }
    }
    return true;
  }

  private async writeTargetFilesFromJournal(journal: ApplyJournal, targetFiles: Set<string>): Promise<void> {
    const assertRecoveredDescendants = async (path: string): Promise<void> => {
      const descendants = await listLocalDescendantFiles(this.vaultDir, path);
      if (descendants.some((descendant) => !(descendant in journal.preflight_sha256))) {
        journal.phase = 'blocked_recovery';
        journal.redacted_error_category = 'preflight_hash_changed';
        await this.recovery.writeApplyJournal(journal);
        await this.block('unsafe_local_state', 'A local file changed during apply preflight.');
      }
    };

    const obsoleteLocalPaths = journal.affected_paths
      .filter((path) => !targetFiles.has(path))
      .sort((left, right) => right.length - left.length);
    for (const path of obsoleteLocalPaths) {
      if (await pathIsDirectory(join(this.vaultDir, path))) {
        await assertRecoveredDescendants(path);
      }
      await rm(join(this.vaultDir, path), { recursive: true, force: true });
    }

    for (const path of journal.affected_paths.filter((candidate) => targetFiles.has(candidate))) {
      const targetContent = await this.git.readBlob(journal.target_main, path);
      const absolutePath = join(this.vaultDir, path);
      if (targetContent !== null) {
        await removeBlockingMaterializationPaths(this.vaultDir, path);
        if (await pathIsDirectory(absolutePath)) {
          await assertRecoveredDescendants(path);
          await rm(absolutePath, { recursive: true, force: true });
        }
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, targetContent);
      }
    }
  }

  private async localSnapshotSummary(): Promise<{ fingerprint: string; fileCount: number; bytes: number }> {
    const files = await this.git.scanSyncableFiles();
    const directories = await listLocalVaultDirectories(this.vaultDir);
    const hash = createHash('sha256');
    for (const path of directories) {
      hash.update('dir\0');
      hash.update(path);
      hash.update('\0');
    }
    let bytes = 0;
    for (const path of files) {
      const content = await readFile(join(this.vaultDir, path));
      bytes += content.byteLength;
      hash.update(path);
      hash.update('\0');
      hash.update(createHash('sha256').update(content).digest());
      hash.update('\0');
    }
    return { fingerprint: hash.digest('hex'), fileCount: files.length, bytes };
  }

  private async createLocalRecoveryBundle(
    operationType: ApplyJournal['operation_type'],
    targetMain: string | null,
    affectedPaths: string[]
  ): Promise<string> {
    const state = await this.readState();
    return await this.recovery.createRecoveryBundle({
      vaultId: state.vault_id ?? 'unknown',
      deviceId: state.device_id ?? 'unknown',
      operationType,
      targetMain: targetMain ?? 'unknown',
      priorLocalMain: state.local_main,
      priorLocalDeviceRef: state.server_device_ref,
      affectedPaths,
      platform: process.platform,
      pluginVersion: PLUGIN_VERSION,
      localRefsPack: await this.git.createRecoveryRefsPack()
    });
  }

  private async assertPairingCanStart(): Promise<void> {
    const obtsDir = join(this.vaultDir, '.obts');
    if (!(await exists(obtsDir))) {
      return;
    }
    const existingState = await this.readExistingState();
    const hasDeviceToken = await exists(join(this.vaultDir, '.obts', 'auth', 'device-token.json'));
    if (existingState?.vault_id || existingState?.device_id || hasDeviceToken) {
      await this.block('local_state_already_paired', 'Local .obts state already belongs to a paired device.');
    }
    if (await this.isCleanUnpairedScaffold(existingState)) {
      return;
    }
    await this.block('partial_local_state', 'Local .obts state is partially initialized and requires reset or recovery.');
  }

  private async isCleanUnpairedScaffold(existingState: LocalPluginState | null): Promise<boolean> {
    if (!existingState) {
      return false;
    }
    if (
      existingState.user_id ||
      existingState.vault_id ||
      existingState.device_id ||
      existingState.device_ref ||
      existingState.server_device_ref ||
      existingState.local_main ||
      existingState.local_head ||
      existingState.initial_import_confirmed ||
      (existingState.last_error_code && existingState.last_error_code !== 'partial_local_state')
    ) {
      return false;
    }
    if (
      (await exists(join(this.vaultDir, '.obts', 'apply-journal.json'))) ||
      (await exists(join(this.vaultDir, '.obts', 'apply.lock'))) ||
      !(await exists(this.queuePath))
    ) {
      return false;
    }
    const queue = await this.readQueue();
    return (
      queue.pending_commit === null &&
      queue.expected_device_ref === null &&
      queue.status === 'idle' &&
      queue.attempts === 0
    );
  }

  private async discoverPairingRepairContext(state: LocalPluginState | null): Promise<PairingRepairContext> {
    const localMain = await this.git.resolveRef('refs/heads/main');
    const localHead = await this.git.resolveRef('refs/heads/local');
    const detached = this.detachedBaselineFromState(state);
    const stateMain = state?.vault_id && state.local_main && (await this.git.commitExists(state.local_main))
      ? { vaultId: state.vault_id, main: state.local_main }
      : null;
    const localMainBaseline = state?.vault_id && localMain
      ? { vaultId: state.vault_id, main: localMain }
      : null;
    return {
      baseline: detached ?? stateMain ?? localMainBaseline,
      hasLocalGitHistory: Boolean(detached ?? stateMain ?? localMain ?? localHead)
    };
  }

  private detachedBaselineFromState(state: LocalPluginState | null): DetachedBaseline | null {
    if (
      !state?.unpaired_baseline_vault_id ||
      !state.unpaired_baseline_main
    ) {
      return null;
    }
    return {
      vaultId: state.unpaired_baseline_vault_id,
      main: state.unpaired_baseline_main
    };
  }

  private baselineForPairing(baseline: DetachedBaseline | null, vaultId: string): DetachedBaseline | null {
    if (!baseline) {
      return null;
    }
    if (baseline.vaultId !== vaultId) {
      return null;
    }
    return baseline;
  }

  private async canFastForwardCleanRePair(
    baseline: DetachedBaseline,
    localFiles: string[],
    manifest: { target_main: string; current_local_main_is_ancestor?: boolean | null }
  ): Promise<boolean> {
    if (manifest.current_local_main_is_ancestor === false) {
      return false;
    }
    if (!(await this.git.commitExists(baseline.main))) {
      return false;
    }
    if (!(await this.localContentMatchesTree(localFiles, baseline.main))) {
      return false;
    }
    return await this.git.isAncestor(baseline.main, manifest.target_main);
  }

  private async ensureNoLocalChangesBeforeApply(state: LocalPluginState): Promise<boolean> {
    await this.flushEditorBuffersToDisk();
    const queue = await this.readQueue();
    if (queue.pending_commit && queue.status !== 'conflicted') {
      await this.deferApplyForLocalChanges(state);
      return false;
    }
    if (await this.visibleVaultMatchesLocalHead(state)) {
      return true;
    }
    await this.deferApplyForLocalChanges(state);
    return false;
  }

  private async visibleVaultMatchesLocalHead(state: LocalPluginState): Promise<boolean> {
    const expectedLocalHead = state.local_head ?? state.local_main;
    const localFiles = await this.git.scanSyncableFiles();
    if (expectedLocalHead === null) {
      return localFiles.length === 0;
    }
    if (!(await this.git.commitExists(expectedLocalHead))) {
      return false;
    }
    if (await this.localContentMatchesTree(localFiles, expectedLocalHead)) {
      return true;
    }
    return state.local_main !== null && state.local_main !== expectedLocalHead
      ? await this.localContentMatchesTree(localFiles, state.local_main)
      : false;
  }

  private async clearResolvedConflictQueue(): Promise<void> {
    const queue = await this.readQueue();
    if (queue.status !== 'conflicted') {
      return;
    }
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: (await this.readState()).server_device_ref,
      status: 'idle',
      attempts: 0,
      updated_at: nowIso()
    });
  }

  private async deferApplyForLocalChanges(state: LocalPluginState): Promise<void> {
    const queue = await this.readQueue();
    if (!queue.pending_commit) {
      await this.writeQueue({
        pending_commit: null,
        expected_device_ref: state.server_device_ref,
        status: 'queued_local',
        attempts: 0,
        updated_at: nowIso()
      });
    }
    await this.writeState({
      ...(await this.readState()),
      status_label: 'Ahead',
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  private async flushEditorBuffersToDisk(): Promise<void> {
    // The Node test client has no active editor buffers to flush.
  }

  private async readExistingState(): Promise<LocalPluginState | null> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
    } catch {
      return null;
    }
  }

  private async localContentMatchesTree(localFiles: string[], targetMain: string): Promise<boolean> {
    const serverFiles = await this.materializedTreeFiles(targetMain);
    if (localFiles.length !== serverFiles.length) {
      return false;
    }
    const localSet = new Set(localFiles);
    for (const path of serverFiles) {
      if (!localSet.has(path)) {
        return false;
      }
      const localHash = await sha256File(join(this.vaultDir, path));
      const serverContent = await this.git.readBlob(targetMain, path);
      if (serverContent === null || localHash !== sha256(serverContent)) {
        return false;
      }
    }
    return true;
  }

  private async localSnapshotMatchesTree(snapshot: Map<string, Buffer>, targetMain: string): Promise<boolean> {
    const serverFiles = await this.materializedTreeFiles(targetMain);
    if (snapshot.size !== serverFiles.length) {
      return false;
    }
    for (const path of serverFiles) {
      const localContent = snapshot.get(path);
      const serverContent = await this.git.readBlob(targetMain, path);
      if (!localContent || !serverContent || !localContent.equals(serverContent)) {
        return false;
      }
    }
    return true;
  }

  private async classifyPendingCommit(
    pendingCommit: string | null,
    serverDeviceRef: string | null,
    targetMain: string
  ): Promise<'none' | 'repeat' | 'fast_forward' | 'divergent'> {
    if (!pendingCommit) {
      return 'none';
    }
    if (!(await this.git.commitExists(pendingCommit))) {
      return 'divergent';
    }
    if (await this.git.isAncestor(pendingCommit, targetMain)) {
      return 'repeat';
    }
    if (serverDeviceRef) {
      if (await this.git.isAncestor(pendingCommit, serverDeviceRef)) {
        return 'repeat';
      }
      if (await this.git.isAncestor(serverDeviceRef, pendingCommit)) {
        return 'fast_forward';
      }
      return 'divergent';
    }
    if (await this.git.isAncestor(targetMain, pendingCommit)) {
      return 'fast_forward';
    }
    return 'divergent';
  }

  private async materializedTreeFiles(commit: string): Promise<string[]> {
    return (await this.git.listTreeFiles(commit)).filter((path) => isSyncableVaultPath(path));
  }

  private async reconcileQueueWithLocalHead(state: LocalPluginState): Promise<void> {
    const queue = await this.readQueue();
    if (queue.pending_commit || !state.local_head || !(await this.git.commitExists(state.local_head))) {
      return;
    }
    if (state.local_main && state.local_head === state.local_main) {
      return;
    }
    if (state.local_main && (await this.git.isAncestor(state.local_head, state.local_main))) {
      await this.writeState({ ...state, local_head: state.local_main, status_label: 'Synced', last_error_code: null, updated_at: nowIso() });
      return;
    }
    const descendsFromDeviceRef = state.server_device_ref
      ? await this.git.isAncestor(state.server_device_ref, state.local_head)
      : false;
    const descendsFromLocalMain = state.local_main ? await this.git.isAncestor(state.local_main, state.local_head) : false;
    if (descendsFromDeviceRef || descendsFromLocalMain || (!state.server_device_ref && !state.local_main)) {
      await this.writeQueue({
        pending_commit: state.local_head,
        expected_device_ref: state.server_device_ref,
        status: 'queued_local',
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState({ ...state, status_label: 'Ahead', last_error_code: null, updated_at: nowIso() });
      return;
    }
    await this.block('same_device_non_fast_forward', 'Local Git history diverged from this device ref and requires recovery.');
  }

  private throwIfSyncBlocked(state: LocalPluginState): void {
    if (state.last_error_code === 'conflict_review_required') {
      throw new PluginBlockedError(
        'conflict_review_required',
        'A server conflict requires dashboard review before normal sync can continue.'
      );
    }
    if (state.last_error_code === 'replace_local_with_server_required') {
      throw new PluginBlockedError(
        'replace_local_with_server_required',
        'Replace local content with server state before normal sync can continue.'
      );
    }
    if (state.last_error_code === 'apply_journal_recovery_required') {
      throw new PluginBlockedError(
        'apply_journal_recovery_required',
        'An incomplete apply journal requires recovery before sync can continue.'
      );
    }
    if (
      state.last_error_code === 'same_device_non_fast_forward' ||
      state.last_error_code === 'stale_device_ref' ||
      state.last_error_code === 'device_blocked' ||
      state.last_error_code === 'local_state_incomplete'
    ) {
      throw new PluginBlockedError(state.last_error_code, 'Device sync is blocked until recovery completes.');
    }
  }

  private async pushOrBlock(
    currentState: LocalPluginState,
    queue: QueueState,
    token: string,
    manifest: DevicePushManifest,
    packfile: Buffer
  ) {
    if (!currentState.vault_id || !currentState.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    try {
      return await this.transport.push({
        vaultId: currentState.vault_id,
        deviceId: currentState.device_id,
        deviceToken: token,
        manifest,
        packfile
      });
    } catch (error) {
      if (error instanceof TransportError && error.code === 'stale_device_ref') {
        const recovered = await this.retryPushAfterStaleDeviceRef(currentState, queue, token, manifest, packfile);
        if (recovered) {
          return recovered;
        }
      }
      if (
        error instanceof TransportError &&
        (error.code === 'same_device_non_fast_forward' || error.code === 'stale_device_ref' || error.code === 'device_blocked')
      ) {
        await this.writeQueue({
          ...queue,
          status: 'blocked_recovery',
          updated_at: nowIso()
        });
        await this.block(error.code, error.message);
      }
      throw error;
    }
  }

  private async retryPushAfterStaleDeviceRef(
    currentState: LocalPluginState,
    queue: QueueState,
    token: string,
    manifest: DevicePushManifest,
    packfile: Buffer
  ) {
    if (!currentState.vault_id) {
      return null;
    }
    const self = await this.transport.getDeviceSelf(token);
    const recoveredRef = self.server_device_ref;
    if (!recoveredRef || recoveredRef === queue.expected_device_ref || !(await this.git.isAncestor(recoveredRef, queue.pending_commit!))) {
      return null;
    }
    const recoveredQueue = {
      ...queue,
      expected_device_ref: recoveredRef,
      status: 'uploading' as const,
      updated_at: nowIso()
    };
    await this.writeQueue(recoveredQueue);
    await this.writeState({
      ...currentState,
      server_device_ref: recoveredRef,
      status_label: 'Uploading',
      last_error_code: null,
      updated_at: nowIso()
    });
    return await this.transport.push({
      vaultId: currentState.vault_id,
      deviceId: currentState.device_id!,
      deviceToken: token,
      manifest: {
        ...manifest,
        expected_device_ref: recoveredRef
      },
      packfile
    });
  }

  private async acknowledgeAppliedMain(state: LocalPluginState, token: string, targetMain: string): Promise<void> {
    if (!state.vault_id || !state.device_id) {
      return;
    }
    try {
      await this.pullWithChunks({
        vaultId: state.vault_id,
        deviceId: state.device_id,
        deviceToken: token,
        currentLocalMain: targetMain,
        requestedTarget: targetMain,
        currentEventSeq: state.last_event_seq
      });
    } catch (error) {
      if (error instanceof TransportError && error.status === 404 && error.code === 'not_found') {
        return;
      }
      throw error;
    }
  }

  private async block(code: string, message: string, details: Record<string, unknown> | undefined = undefined): Promise<never> {
    await this.writeState({
      ...(await this.readState()),
      status_label: blockStatusLabel(code),
      last_error_code: code,
      last_error_details: details ?? null,
      updated_at: nowIso()
    });
    await this.reportDeviceStatus().catch(() => undefined);
    throw new PluginBlockedError(code, message);
  }

  private async readDeviceToken(): Promise<string> {
    const tokenFile = JSON.parse(await readFile(join(this.vaultDir, '.obts', 'auth', 'device-token.json'), 'utf8')) as {
      device_token?: string;
    };
    if (!tokenFile.device_token) {
      throw new PluginBlockedError('not_paired', 'Device token is missing.');
    }
    return tokenFile.device_token;
  }

  private async writeState(state: LocalPluginState): Promise<void> {
    const guardedState = await this.guardStateCursorRegression(state);
    await this.backupExistingState();
    await writeJson(this.statePath, guardedState);
  }

  private async guardStateCursorRegression(nextState: LocalPluginState): Promise<LocalPluginState> {
    const currentState = await this.readPrimaryState();
    if (!currentState || !samePairedDeviceState(currentState, nextState)) {
      return nextState;
    }

    const guardedState = { ...nextState };
    let cursorRegressed = false;
    if (await this.shouldPreserveCurrentCursor(nextState.local_main, currentState.local_main)) {
      guardedState.local_main = currentState.local_main;
      cursorRegressed = true;
    }
    if (await this.shouldPreserveCurrentCursor(nextState.local_head, currentState.local_head)) {
      guardedState.local_head = currentState.local_head;
      cursorRegressed = true;
    }
    if (await this.shouldPreserveCurrentCursor(nextState.server_device_ref, currentState.server_device_ref)) {
      guardedState.server_device_ref = currentState.server_device_ref;
      cursorRegressed = true;
    }
    if (currentState.initial_import_confirmed && !guardedState.initial_import_confirmed) {
      guardedState.initial_import_confirmed = true;
    }
    if (currentState.last_event_seq > guardedState.last_event_seq) {
      guardedState.last_event_seq = currentState.last_event_seq;
    }
    if (cursorRegressed) {
      guardedState.status_label = currentState.status_label;
      guardedState.last_error_code = currentState.last_error_code;
      guardedState.last_error_details = currentState.last_error_details ?? null;
    }
    return guardedState;
  }

  private async preferRecoverableBackupState(primaryState: LocalPluginState): Promise<LocalPluginState> {
    const backupState = await this.readBackupState();
    if (!backupState || !samePairedDeviceState(primaryState, backupState)) {
      return primaryState;
    }
    if (sameStateCursors(primaryState, backupState)) return primaryState;

    const [localMain, localHead] = await Promise.all([
      this.git.resolveRef('refs/heads/main'),
      this.git.resolveRef('refs/heads/local')
    ]);
    const primaryMatchesRefs = primaryState.local_main === localMain && primaryState.local_head === localHead;
    const backupMatchesRefs = backupState.local_main === localMain && backupState.local_head === localHead;
    const comparableLocalCursors = Boolean(
      primaryState.local_main && primaryState.local_head && backupState.local_main && backupState.local_head
    );
    if (comparableLocalCursors && primaryMatchesRefs !== backupMatchesRefs) {
      return backupMatchesRefs ? await this.restoreRecoveredBackupState(primaryState, backupState) : primaryState;
    }
    if (comparableLocalCursors && primaryMatchesRefs && backupMatchesRefs) {
      const expectedDeviceRef = (await this.readQueue()).expected_device_ref;
      const primaryMatchesQueue = primaryState.server_device_ref === expectedDeviceRef;
      const backupMatchesQueue = backupState.server_device_ref === expectedDeviceRef;
      if (primaryMatchesQueue !== backupMatchesQueue) {
        return backupMatchesQueue
          ? await this.restoreRecoveredBackupState(primaryState, backupState, expectedDeviceRef)
          : primaryState;
      }
    }

    if (await this.backupStateCursorsDescend(primaryState, backupState)) {
      return backupState;
    }
    return primaryState;
  }

  private async restoreRecoveredBackupState(
    primaryState: LocalPluginState,
    backupState: LocalPluginState,
    knownExpectedDeviceRef: string | null | undefined = undefined
  ): Promise<LocalPluginState> {
    const expectedDeviceRef = knownExpectedDeviceRef === undefined
      ? (await this.readQueue()).expected_device_ref
      : knownExpectedDeviceRef;
    const backupMatchesQueue = Boolean(expectedDeviceRef && backupState.server_device_ref === expectedDeviceRef);
    const recoveredServerDeviceRef = backupMatchesQueue
      ? backupState.server_device_ref
      : primaryState.server_device_ref;
    const preservePrimaryServerState = recoveredServerDeviceRef === primaryState.server_device_ref &&
      primaryState.server_device_ref !== backupState.server_device_ref;
    const recovered: LocalPluginState = {
      ...backupState,
      device_name: primaryState.device_name || backupState.device_name || null,
      server_device_ref: recoveredServerDeviceRef,
      initial_import_confirmed: primaryState.initial_import_confirmed || backupState.initial_import_confirmed,
      last_event_seq: Math.max(primaryState.last_event_seq || 0, backupState.last_event_seq || 0),
      updated_at: nowIso(),
      ...(preservePrimaryServerState
        ? {
            status_label: primaryState.status_label,
            last_error_code: primaryState.last_error_code,
            last_error_details: primaryState.last_error_details || null
          }
        : {})
    };
    await writeJson(this.statePath, recovered);
    return recovered;
  }

  private async backupStateCursorsDescend(primaryState: LocalPluginState, backupState: LocalPluginState): Promise<boolean> {
    return (
      (await this.cursorDescends(primaryState.local_main, backupState.local_main)) ||
      (await this.cursorDescends(primaryState.local_head, backupState.local_head)) ||
      (await this.cursorDescends(primaryState.server_device_ref, backupState.server_device_ref))
    );
  }

  private async shouldPreserveCurrentCursor(nextCursor: string | null, currentCursor: string | null): Promise<boolean> {
    if (!currentCursor) {
      return false;
    }
    if (!nextCursor) {
      return true;
    }
    if (nextCursor === currentCursor) {
      return false;
    }
    return await this.cursorDescends(nextCursor, currentCursor);
  }

  private async cursorDescends(olderCursor: string | null, newerCursor: string | null): Promise<boolean> {
    if (!olderCursor || !newerCursor || olderCursor === newerCursor) {
      return false;
    }
    if (!(await this.git.commitExists(olderCursor)) || !(await this.git.commitExists(newerCursor))) {
      return false;
    }
    return await this.git.isAncestor(olderCursor, newerCursor);
  }

  private async readPrimaryState(): Promise<LocalPluginState | null> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
    } catch {
      return null;
    }
  }

  private async repairLocalStateIfNeeded(state: LocalPluginState): Promise<LocalPluginState> {
    if (state.last_error_code !== 'local_state_incomplete') {
      return state;
    }
    let token: string;
    try {
      token = await this.readDeviceToken();
    } catch {
      return state;
    }
    try {
      const self = await this.transport.getDeviceSelf(token);
      const localMain = await this.git.resolveRef('refs/heads/main');
      const localHead = await this.git.resolveRef('refs/heads/local');
      await this.importCurrentServerMain(self.vault_id, self.device_id, token, localMain);
      let repairedLocalMain = localMain;
      let repairedLocalHead = localHead ?? localMain;
      if (!localMain && !localHead) {
        const localFiles = await this.git.scanSyncableFiles();
        if (localFiles.length > 0 && (await this.git.commitExists(self.current_main))) {
          repairedLocalMain = self.current_main;
          repairedLocalHead = self.current_main;
          await this.git.setLocalMain(self.current_main);
          await this.git.setLocalHead(self.current_main);
        }
      }
      const repaired: LocalPluginState = {
        user_id: self.user_id,
        vault_id: self.vault_id,
        device_id: self.device_id,
        device_name: self.device_name,
        device_ref: self.device_ref,
        server_device_ref: self.server_device_ref,
        local_main: repairedLocalMain,
        local_head: repairedLocalHead,
        initial_import_confirmed: true,
        status_label: self.status === 'review_needed' || self.status === 'blocked_recovery' ? 'Needs recovery' : 'Checking',
        last_error_code: self.status === 'review_needed' || self.status === 'blocked_recovery' ? 'device_blocked' : null,
        last_event_seq: self.event_seq,
        unpaired_baseline_vault_id: null,
        unpaired_baseline_main: null,
        updated_at: nowIso()
      };
      await this.writeState(repaired);
      return repaired;
    } catch {
      return state;
    }
  }

  private async importCurrentServerMain(
    vaultId: string,
    deviceId: string,
    token: string,
    localMain: string | null
  ): Promise<void> {
    try {
      const pulled = await this.pullWithChunks({
        vaultId,
        deviceId,
        deviceToken: token,
        currentLocalMain: localMain,
        requestedTarget: 'latest',
        currentEventSeq: 0
      });
      await this.git.importPack(pulled.packfile);
    } catch {
      // Metadata repair can continue without fresh main objects; sync will retry and block safely if needed.
    }
  }

  private async backupExistingState(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
      if (state.vault_id && state.device_id) {
        await copyFile(this.statePath, `${this.statePath}.bak`);
      }
    } catch {
      // Keep any existing backup when the primary state file is unreadable.
    }
  }

  private async readBackupState(): Promise<LocalPluginState | null> {
    try {
      const state = JSON.parse(await readFile(`${this.statePath}.bak`, 'utf8')) as LocalPluginState;
      if (state.vault_id && state.device_id) {
        return state;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async hasActiveTokenWithoutIdentity(state: LocalPluginState): Promise<boolean> {
    return Boolean((!state.vault_id || !state.device_id) && (await exists(join(this.vaultDir, '.obts', 'auth', 'device-token.json'))));
  }

  private localStateIncomplete(state: LocalPluginState | null): LocalPluginState {
    return {
      user_id: state?.user_id ?? null,
      vault_id: state?.vault_id ?? null,
      device_id: state?.device_id ?? null,
      device_name: state?.device_name ?? null,
      device_ref: state?.device_ref ?? null,
      server_device_ref: state?.server_device_ref ?? null,
      local_main: state?.local_main ?? null,
      local_head: state?.local_head ?? null,
      initial_import_confirmed: state?.initial_import_confirmed ?? false,
      status_label: 'Needs recovery',
      last_error_code: 'local_state_incomplete',
      last_event_seq: state?.last_event_seq ?? 0,
      unpaired_baseline_vault_id: state?.unpaired_baseline_vault_id ?? null,
      unpaired_baseline_main: state?.unpaired_baseline_main ?? null,
      updated_at: nowIso()
    };
  }

  private async saveOnboardingAnalysis(connectionId: string, analysis: OnboardingAnalysis): Promise<void> {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) return;
    await this.writeOnboardingJournal({
      ...pending.journal,
      stage: 'awaiting_confirmation',
      analysis,
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  private async updateOnboardingStage(
    connectionId: string,
    stage: OnboardingStage,
    selectedMode?: 'initialize' | 'use_server' | 'merge',
    errorCode: string | null = null
  ): Promise<void> {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) return;
    await this.writeOnboardingJournal({
      ...pending.journal,
      stage,
      selected_mode: selectedMode ?? pending.journal.selected_mode,
      last_error_code: errorCode,
      updated_at: nowIso()
    });
  }

  private async completePendingOnboarding(connectionId: string): Promise<void> {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) return;
    await this.writeOnboardingJournal({ ...pending.journal, stage: 'complete', last_error_code: null, updated_at: nowIso() });
    await rm(this.pendingConnectionPath, { force: true });
  }

  private async clearPendingOnboarding(): Promise<void> {
    await rm(this.pendingConnectionPath, { force: true });
    await rm(this.onboardingJournalPath, { force: true });
  }

  private async writeOnboardingJournal(journal: OnboardingJournal): Promise<void> {
    await writeJson(this.onboardingJournalPath, journal);
  }

  private async writeQueue(queue: QueueState): Promise<void> {
    await this.mutateQueue(async () => {
      const existing = await readJsonOrNull<QueueState>(this.queuePath);
      const existingSeq = existing?.change_seq;
      await writeJson(this.queuePath, {
        ...queue,
        change_seq: typeof queue.change_seq === 'number' && Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0
          ? queue.change_seq
          : typeof existingSeq === 'number' && Number.isSafeInteger(existingSeq) && existingSeq >= 0
            ? existingSeq
            : 0
      });
    });
  }

  private async clearQueuedHintIfUnchanged(expectedChangeSeq: number): Promise<boolean> {
    return await this.mutateQueue(async () => {
      const queue = await this.readQueue();
      if (
        queue.pending_commit !== null ||
        queue.status !== 'queued_local' ||
        queue.change_seq !== expectedChangeSeq
      ) {
        return false;
      }
      await writeJson(this.queuePath, {
        pending_commit: null,
        expected_device_ref: (await this.readState()).server_device_ref,
        status: 'idle',
        attempts: 0,
        change_seq: expectedChangeSeq,
        updated_at: nowIso()
      });
      return true;
    });
  }

  private async mutateQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueMutation.then(fn, fn);
    this.queueMutation = run.then(() => undefined, () => undefined);
    return await run;
  }

  private get onboardingJournalPath(): string {
    return join(this.vaultDir, '.obts', 'onboarding.json');
  }

  private get pendingConnectionPath(): string {
    return join(this.vaultDir, '.obts', 'auth', 'pending-connection.json');
  }

  private get statePath(): string {
    return join(this.vaultDir, '.obts', 'state.json');
  }

  private get queuePath(): string {
    return join(this.vaultDir, '.obts', 'queue.json');
  }

  private get directoryStatePath(): string {
    return join(this.vaultDir, '.obts', 'directory-state.json');
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.equals(right);
}

function requireOnboardingBase(value: string | null): string {
  if (!value) {
    throw new PluginBlockedError('invalid_onboarding_base', 'Onboarding proposal base is unavailable.');
  }
  return value;
}

function changedPathsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function blockStatusLabel(code: string): string {
  if (code === 'initial_import_confirmation_required') {
    return 'Blocked';
  }
  if (code === 'conflict_review_required') {
    return 'Review needed';
  }
  if (
    code === 'replace_local_with_server_required' ||
    code === 'same_device_non_fast_forward' ||
    code === 'stale_device_ref' ||
    code === 'device_blocked' ||
    code === 'local_state_incomplete'
  ) {
    return 'Needs recovery';
  }
  return 'Unsafe local state';
}

function isRecoverableApplyPath(path: string): boolean {
  return (
    isSyncableVaultPath(path) ||
    (path !== '.obts' && !path.startsWith('.obts/') && path !== '.git' && !path.startsWith('.git/') && !path.includes('/.git/'))
  );
}

function materializationConflictFiles(targetFiles: Set<string>, localVaultFiles: string[]): string[] {
  const conflicts = new Set<string>();
  for (const targetFile of targetFiles) {
    for (const localFile of localVaultFiles) {
      if (localFile.startsWith(`${targetFile}/`)) {
        conflicts.add(localFile);
      }
    }
    for (const prefix of directoryPrefixes(targetFile)) {
      if (localVaultFiles.includes(prefix)) {
        conflicts.add(prefix);
      }
    }
  }
  return [...conflicts].sort();
}

function directoryPrefixes(path: string): string[] {
  const segments = path.split('/');
  const prefixes: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    prefixes.push(segments.slice(0, index).join('/'));
  }
  return prefixes;
}

async function listLocalVaultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkVaultFiles(root, root, files);
  return files.sort();
}

async function listLocalVaultDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  await walkVaultDirectories(root, root, directories);
  return directories.sort();
}

function explicitEmptyDirectories(directories: string[], files: string[]): string[] {
  return directories.filter((directory) => !files.some((file) => file.startsWith(`${directory}/`))).sort();
}

function topmostDirectories(directories: string[]): string[] {
  const sorted = [...new Set(directories)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const result: string[] = [];
  for (const directory of sorted) {
    if (!result.some((parent) => directory === parent || directory.startsWith(`${parent}/`))) {
      result.push(directory);
    }
  }
  return result;
}

function compactDirectoryIntents(intents: DirectoryIntent[]): DirectoryIntent[] {
  const byPath = new Map<string, DirectoryIntent>();
  for (const intent of intents) {
    if ((intent.op !== 'create' && intent.op !== 'delete') || !isSyncableVaultPath(intent.path)) {
      continue;
    }
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

async function listLocalDescendantFiles(root: string, relativePath: string): Promise<string[]> {
  const absolutePath = join(root, relativePath);
  if (!(await pathIsDirectory(absolutePath))) {
    return [];
  }
  const files: string[] = [];
  await walkVaultFiles(root, absolutePath, files);
  return files.sort();
}

async function readFileSnapshot(root: string, files: string[]): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  for (const path of files) {
    snapshot.set(path, await readFile(join(root, path)));
  }
  return snapshot;
}

async function restoreFileSnapshot(root: string, snapshot: Map<string, Buffer>, priorLocalFiles: string[]): Promise<void> {
  for (const path of priorLocalFiles.sort((left, right) => right.length - left.length)) {
    if (!snapshot.has(path)) {
      await rm(join(root, path), { recursive: true, force: true });
    }
  }
  for (const [path, content] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await removeBlockingMaterializationPaths(root, path);
    const absolutePath = join(root, path);
    if (await pathIsDirectory(absolutePath)) {
      await rm(absolutePath, { recursive: true, force: true });
    }
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, content);
  }
}

async function removeBlockingMaterializationPaths(root: string, relativePath: string): Promise<void> {
  for (const prefix of directoryPrefixes(relativePath)) {
    const absolutePrefix = join(root, prefix);
    if ((await exists(absolutePrefix)) && !(await pathIsDirectory(absolutePrefix))) {
      await rm(absolutePrefix, { force: true });
    }
  }
}

async function walkVaultFiles(root: string, current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obts' || entry.name === '.git') {
      continue;
    }
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkVaultFiles(root, absolutePath, files);
    } else if (entry.isFile()) {
      files.push(relativeVaultPath(root, absolutePath));
    }
  }
}

async function walkVaultDirectories(root: string, current: string, directories: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obts' || entry.name === '.git') {
      continue;
    }
    const absolutePath = join(current, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    const relativePath = relativeVaultPath(root, absolutePath);
    if (!isSyncableVaultPath(relativePath)) {
      continue;
    }
    directories.push(relativePath);
    await walkVaultDirectories(root, absolutePath, directories);
  }
}

function relativeVaultPath(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length + 1).replaceAll('\\', '/');
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function samePairedDeviceState(left: LocalPluginState, right: LocalPluginState): boolean {
  return Boolean(
    left.vault_id &&
      left.device_id &&
      right.vault_id &&
      right.device_id &&
      left.vault_id === right.vault_id &&
      left.device_id === right.device_id
  );
}

function sameStateCursors(left: LocalPluginState, right: LocalPluginState): boolean {
  return left.local_main === right.local_main &&
    left.local_head === right.local_head &&
    left.server_device_ref === right.server_device_ref;
}

function categorizeRecoveryError(error: unknown): string {
  if (error instanceof ApplyLockActiveError) {
    return 'apply_lock_active';
  }
  if (error instanceof PluginBlockedError) {
    return error.code === 'unsafe_local_state' ? 'preflight_hash_changed' : error.code;
  }
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes('git ') && (message.includes('show') || message.includes('cat-file'))) {
      return 'blob_read_failed';
    }
    if (message.includes('ENOENT') || message.includes('EACCES') || message.includes('EPERM')) {
      return 'adapter_io_failed';
    }
    if (message.includes('EEXIST')) {
      return 'apply_lock_active';
    }
  }
  return 'recovery_unexpected_error';
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
