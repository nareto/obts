import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import { assertSyncableTreePaths, isSyncableVaultPath, normalizeVaultPath } from '../shared/pathPolicy.js';
import { API_VERSION, type DevicePushManifest } from '../shared/types.js';
import { LocalGitEngine } from './localGit.js';
import { ApplyLockActiveError, type ApplyJournal, RecoveryManager, sha256File } from './recovery.js';
import { TransportClient, TransportError } from './transport.js';

const PLUGIN_VERSION = '0.1.3-phase2';

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

export type QueueState = {
  pending_commit: string | null;
  expected_device_ref: string | null;
  status: 'idle' | 'queued_local' | 'uploading' | 'uploaded' | 'merged' | 'conflicted' | 'blocked_recovery';
  attempts: number;
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

  async pairWithToken(pairingToken: string): Promise<void> {
    await this.assertPairingCanStart();
    const pairingRepair = await this.discoverPairingRepairContext(await this.readExistingState());
    const result = await this.transport.consumePairingToken({
      pairingToken,
      deviceName: this.settings.deviceName
    });
    const rePairBaseline = this.baselineForPairing(pairingRepair.baseline, result.vault_id);
    await this.initialize();
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
      initial_import_confirmed: false,
      status_label: 'Checking',
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    const pulled = await this.transport.pull({
      vaultId: result.vault_id,
      deviceId: result.device_id,
      deviceToken: result.device_token,
      currentLocalMain: rePairBaseline?.main ?? null
    });
    await this.git.importPack(pulled.packfile);
    const localFiles = await this.git.scanSyncableFiles();
    const serverFiles = await this.materializedTreeFiles(pulled.manifest.target_main);
    const localAlreadyMatchesServer =
      localFiles.length > 0 && serverFiles.length > 0
        ? await this.localContentMatchesTree(localFiles, pulled.manifest.target_main)
        : false;
    const shouldProposeLocalContent =
      localFiles.length > 0 &&
      !localAlreadyMatchesServer &&
      (!result.is_first_device || serverFiles.length > 0 || pairingRepair.hasLocalGitHistory);
    if (shouldProposeLocalContent) {
      if (rePairBaseline && (await this.canFastForwardCleanRePair(rePairBaseline, localFiles, pulled.manifest))) {
        await this.writeState({
          ...(await this.readState()),
          local_main: rePairBaseline.main,
          local_head: rePairBaseline.main,
          initial_import_confirmed: true,
          updated_at: nowIso()
        });
        await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true);
        await this.writeState({
          ...(await this.readState()),
          initial_import_confirmed: true,
          status_label: 'Synced',
          last_error_code: null,
          updated_at: nowIso()
        });
        await this.acknowledgeAppliedMain(await this.readState(), result.device_token, pulled.manifest.target_main);
        return;
      }
      const proposalBase = rePairBaseline && (await this.git.commitExists(rePairBaseline.main)) ? rePairBaseline.main : pulled.manifest.target_main;
      await this.git.setLocalMain(proposalBase);
      await this.git.setLocalHead(proposalBase);
      await this.writeState({
        ...(await this.readState()),
        local_main: proposalBase,
        local_head: proposalBase,
        initial_import_confirmed: true,
        status_label: 'Ahead',
        last_error_code: null,
        updated_at: nowIso()
      });
      const proposalCommit = await this.git.createLocalCommit('obts: local vault changes');
      await this.writeQueue({
        pending_commit: proposalCommit,
        expected_device_ref: null,
        status: proposalCommit ? 'queued_local' : 'idle',
        attempts: 0,
        updated_at: nowIso()
      });
      if (proposalCommit) {
        await this.writeState({
          ...(await this.readState()),
          local_head: proposalCommit,
          status_label: 'Ahead',
          updated_at: nowIso()
        });
      }
      return;
    }
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true);
    if (localFiles.length === 0 || localAlreadyMatchesServer) {
      await this.writeState({
        ...(await this.readState()),
        initial_import_confirmed: true,
        updated_at: nowIso()
      });
      await this.acknowledgeAppliedMain(await this.readState(), result.device_token, pulled.manifest.target_main);
    }
  }

  async syncOnce(options: { confirmInitialImport?: boolean } = {}): Promise<{ status: string; main?: string; conflictId?: string }> {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    this.throwIfSyncBlocked(state);
    await this.flushEditorBuffersToDisk();
    const localFiles = await this.git.scanSyncableFiles();
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

    const commit = await this.git.createLocalCommit('obts: local vault changes');
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
      const existingQueue = await this.readQueue();
      if (
        existingQueue.status === 'queued_local' &&
        existingQueue.pending_commit === null &&
        (await this.visibleVaultMatchesLocalHead(await this.readState()))
      ) {
        await this.writeQueue({
          pending_commit: null,
          expected_device_ref: state.server_device_ref,
          status: 'idle',
          attempts: 0,
          updated_at: nowIso()
        });
      }
    }

    const queue = await this.readQueue();
    if (queue.pending_commit) {
      const token = await this.readDeviceToken();
      const currentState = await this.readState();
      if (!currentState.vault_id || !currentState.device_id) {
        throw new PluginBlockedError('not_paired', 'Device is not paired.');
      }
      await this.writeQueue({ ...queue, status: 'uploading', attempts: queue.attempts + 1, updated_at: nowIso() });
      await this.writeState({
        ...currentState,
        status_label: 'Uploading',
        last_error_code: null,
        updated_at: nowIso()
      });
      const packfile = await this.git.createPackForCommit(queue.pending_commit);
      const manifest: DevicePushManifest = {
        api_version: API_VERSION,
        vault_id: currentState.vault_id,
        device_id: currentState.device_id,
        expected_device_ref: queue.expected_device_ref,
        target_commit: queue.pending_commit,
        packfile_sha256: sha256(packfile),
        packfile_bytes: packfile.byteLength,
        client_known_main: currentState.local_main,
        ...(queue.expected_device_ref === null && currentState.local_main ? { base_commit: currentState.local_main } : {}),
        attempt_id: newId('sync')
      };
      const result = await this.pushOrBlock(currentState, queue, token, manifest, packfile);
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
          updated_at: nowIso()
        });
      }
    }

    await this.pullAndApply({ allowDestructive: true });
    const finalState = await this.readState();
    return finalState.local_main
      ? { status: finalState.status_label, main: finalState.local_main }
      : { status: finalState.status_label };
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
    const pulled = await this.transport.pull({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    await this.git.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
      extraAffectedPaths: localFiles
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
    const pulled = await this.transport.pull({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    await this.git.importPack(pulled.packfile);
    const priorLocalFiles = state.local_main ? await this.materializedTreeFiles(state.local_main) : [];

    const pendingClassification = await this.classifyPendingCommit(
      queue.pending_commit,
      state.server_device_ref,
      pulled.manifest.target_main
    );

    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, {
      extraAffectedPaths: localFiles
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
    const pulled = await this.transport.pull({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    await this.git.importPack(pulled.packfile);
    state = await this.readState();
    if (!(await this.ensureNoLocalChangesBeforeApply(state))) {
      return false;
    }
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, options.allowDestructive, {
      requireCleanVisibleState: true
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
        const applied = await this.pullAndApply({ allowDestructive: true });
        const refreshed = await this.readState();
        return { applied, status: refreshed.status_label };
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
      return (
        (event.event_type === 'main_advanced' || event.event_type === 'conflict_resolved') &&
        typeof main === 'string' &&
        main !== currentState.local_main
      );
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
    const finalState = await this.readState();
    return { applied, status: finalState.status_label };
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
        updated_at: nowIso()
      });
    }
    await this.writeState({
      ...state,
      status_label: 'Ahead',
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  async readState(): Promise<LocalPluginState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
      if (await this.hasActiveTokenWithoutIdentity(state)) {
        return (await this.readBackupState()) ?? this.localStateIncomplete(state);
      }
      return state;
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
      return JSON.parse(await readFile(this.queuePath, 'utf8')) as QueueState;
    } catch {
      return {
        pending_commit: null,
        expected_device_ref: null,
        status: 'idle',
        attempts: 0,
        updated_at: nowIso()
      };
    }
  }

  private async applyTargetMain(
    targetMain: string,
    changedPaths: string[],
    allowDestructive: boolean,
    options: { extraAffectedPaths?: string[]; requireCleanVisibleState?: boolean } = {}
  ): Promise<void> {
    const state = await this.readState();
    if (state.local_main === targetMain && (options.extraAffectedPaths?.length ?? 0) === 0) {
      await this.writeState({ ...state, status_label: 'Synced', updated_at: nowIso() });
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

      journal.phase = 'verifying';
      journal.last_completed_step = 'files_written';
      await this.recovery.writeApplyJournal(journal);
      if (options.requireCleanVisibleState) {
        await this.flushEditorBuffersToDisk();
        if (!(await this.localContentMatchesTree(await this.git.scanSyncableFiles(), targetMain))) {
          journal.phase = 'blocked_recovery';
          journal.redacted_error_category = 'local_changed_during_apply';
          await this.recovery.writeApplyJournal(journal);
          await this.block('unsafe_local_state', 'Local content changed during apply; server state was not acknowledged.');
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
        updated_at: nowIso()
      });
      await this.recovery.clearApplyJournal();
    } finally {
      if (releaseApplyLock) {
        await releaseApplyLock();
      }
    }
  }

  private async recoverIncompleteApplyJournal(journal: ApplyJournal, state: LocalPluginState): Promise<boolean> {
    if (journal.phase === 'blocked_recovery' || !(await this.git.commitExists(journal.target_main))) {
      return false;
    }

    const targetFiles = new Set(await this.materializedTreeFiles(journal.target_main));
    const canReplayFromCurrentState = await this.applyJournalMatchesCurrentFiles(journal, targetFiles);
    if (!canReplayFromCurrentState) {
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
    } catch {
      return false;
    } finally {
      if (releaseApplyLock) {
        await releaseApplyLock();
      }
    }
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
      if (
        error instanceof TransportError &&
        (error.code === 'same_device_non_fast_forward' ||
          error.code === 'stale_device_ref' ||
          error.code === 'device_blocked')
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

  private async acknowledgeAppliedMain(state: LocalPluginState, token: string, targetMain: string): Promise<void> {
    if (!state.vault_id || !state.device_id) {
      return;
    }
    try {
      await this.transport.pull({
        vaultId: state.vault_id,
        deviceId: state.device_id,
        deviceToken: token,
        currentLocalMain: targetMain,
        requestedTarget: targetMain
      });
    } catch (error) {
      if (error instanceof TransportError && error.status === 404 && error.code === 'not_found') {
        return;
      }
      throw error;
    }
  }

  private async block(code: string, message: string): Promise<never> {
    await this.writeState({
      ...(await this.readState()),
      status_label: blockStatusLabel(code),
      last_error_code: code,
      updated_at: nowIso()
    });
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
    await this.backupExistingState();
    await writeJson(this.statePath, state);
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
      const pulled = await this.transport.pull({
        vaultId,
        deviceId,
        deviceToken: token,
        currentLocalMain: localMain,
        requestedTarget: 'latest'
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

  private async writeQueue(queue: QueueState): Promise<void> {
    await writeJson(this.queuePath, queue);
  }

  private get statePath(): string {
    return join(this.vaultDir, '.obts', 'state.json');
  }

  private get queuePath(): string {
    return join(this.vaultDir, '.obts', 'queue.json');
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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
  await rename(temporaryPath, path);
}
