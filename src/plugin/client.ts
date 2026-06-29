import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import { isSyncableVaultPath, type SyncPathPolicy } from '../shared/pathPolicy.js';
import { API_VERSION, type DevicePushManifest, type SyncProfile } from '../shared/types.js';
import { LocalGitEngine } from './localGit.js';
import { type ApplyJournal, RecoveryManager, sha256File } from './recovery.js';
import { TransportClient, TransportError } from './transport.js';

const PLUGIN_VERSION = '0.1.0-phase1';

export type ObtsPluginSettings = {
  serverUrl: string;
  deviceId?: string;
  vaultId?: string;
  deviceName: string;
  syncProfile: SyncProfile;
  syncPlugins: boolean;
};

export type LocalPluginState = {
  user_id: string | null;
  vault_id: string | null;
  device_id: string | null;
  device_ref: string | null;
  server_device_ref: string | null;
  local_main: string | null;
  local_head: string | null;
  initial_import_confirmed: boolean;
  status_label: string;
  last_error_code: string | null;
  updated_at: string;
};

export type QueueState = {
  pending_commit: string | null;
  expected_device_ref: string | null;
  status: 'idle' | 'queued_local' | 'uploading' | 'uploaded' | 'merged' | 'conflicted' | 'blocked_recovery';
  attempts: number;
  updated_at: string;
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
  private readonly policy: SyncPathPolicy;

  constructor(
    private readonly vaultDir: string,
    private readonly settings: ObtsPluginSettings
  ) {
    this.policy = {
      profile: settings.syncProfile,
      syncPlugins: settings.syncPlugins,
      attachmentLocation: { mode: 'same_folder_as_note' }
    };
    this.transport = new TransportClient(settings.serverUrl);
    this.git = new LocalGitEngine(vaultDir, this.policy);
    this.recovery = new RecoveryManager(vaultDir);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.vaultDir, '.obts', 'auth'), { recursive: true, mode: 0o700 });
    await this.git.initialize();
    const state = await this.readState();
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
      await this.recovery.clearApplyJournal();
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
    const result = await this.transport.consumePairingToken({
      pairingToken,
      deviceName: this.settings.deviceName,
      syncProfile: this.settings.syncProfile,
      syncPlugins: this.settings.syncPlugins
    });
    await this.initialize();
    await writeJson(join(this.vaultDir, '.obts', 'auth', 'device-token.json'), {
      device_token: result.device_token,
      created_at: nowIso()
    });
    await this.writeState({
      user_id: result.user_id,
      vault_id: result.vault_id,
      device_id: result.device_id,
      device_ref: result.device_ref,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: 'Checking',
      last_error_code: null,
      updated_at: nowIso()
    });
    const pulled = await this.transport.pull({
      vaultId: result.vault_id,
      deviceId: result.device_id,
      deviceToken: result.device_token,
      currentLocalMain: null
    });
    await this.git.importPack(pulled.packfile);
    const localFiles = await this.git.scanSyncableFiles();
    const serverFiles = await this.git.listTreeFiles(pulled.manifest.target_main);
    const localAlreadyMatchesServer =
      localFiles.length > 0 && serverFiles.length > 0
        ? await this.localContentMatchesTree(localFiles, pulled.manifest.target_main)
        : false;
    if (localFiles.length > 0 && serverFiles.length > 0) {
      if (!localAlreadyMatchesServer) {
        await this.createLocalRecoveryBundle('replace_local_with_server', pulled.manifest.target_main, localFiles);
        await this.writeQueue({
          pending_commit: null,
          expected_device_ref: null,
          status: 'blocked_recovery',
          attempts: 0,
          updated_at: nowIso()
        });
        await this.block(
          'replace_local_with_server_required',
          'Additional device has local content that differs from server main.'
        );
      }
    }
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true);
    if (localFiles.length === 0 || localAlreadyMatchesServer) {
      await this.writeState({
        ...(await this.readState()),
        initial_import_confirmed: true,
        updated_at: nowIso()
      });
    }
  }

  async syncOnce(options: { confirmInitialImport?: boolean } = {}): Promise<{ status: string; main?: string; conflictId?: string }> {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new PluginBlockedError('not_paired', 'Device is not paired.');
    }
    this.throwIfSyncBlocked(state);
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

    const queue = await this.readQueue();
    if (queue.pending_commit) {
      const token = await this.readDeviceToken();
      const currentState = await this.readState();
      if (!currentState.vault_id || !currentState.device_id) {
        throw new PluginBlockedError('not_paired', 'Device is not paired.');
      }
      await this.writeQueue({ ...queue, status: 'uploading', attempts: queue.attempts + 1, updated_at: nowIso() });
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

  async pullAndApply(options: { allowDestructive: boolean }): Promise<void> {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    const token = await this.readDeviceToken();
    const pulled = await this.transport.pull({
      vaultId: state.vault_id,
      deviceId: state.device_id,
      deviceToken: token,
      currentLocalMain: state.local_main
    });
    await this.git.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, options.allowDestructive);
  }

  async readState(): Promise<LocalPluginState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
    } catch {
      return {
        user_id: null,
        vault_id: this.settings.vaultId ?? null,
        device_id: this.settings.deviceId ?? null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: 'Checking',
        last_error_code: null,
        updated_at: nowIso()
      };
    }
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
    options: { extraAffectedPaths?: string[] } = {}
  ): Promise<void> {
    const state = await this.readState();
    if (state.local_main === targetMain && (options.extraAffectedPaths?.length ?? 0) === 0) {
      await this.writeState({ ...state, status_label: 'Synced', updated_at: nowIso() });
      return;
    }
    const targetFiles = new Set(await this.git.listTreeFiles(targetMain));
    const affected = new Set(changedPaths);
    if (state.local_main) {
      for (const path of await this.git.listTreeFiles(state.local_main)) {
        if (!targetFiles.has(path)) {
          affected.add(path);
        }
      }
    }
    for (const path of options.extraAffectedPaths ?? []) {
      affected.add(path);
    }
    const affectedPaths = [...affected].filter((path) => isSyncableVaultPath(path, this.policy)).sort();
    const preflight: Record<string, string | null> = {};
    for (const path of affectedPaths) {
      preflight[path] = await sha256File(join(this.vaultDir, path));
    }

    const journal: ApplyJournal = {
      apply_id: newId('apply'),
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
      const bundleId = await this.recovery.createRecoveryBundle({
        vaultId: state.vault_id ?? 'unknown',
        deviceId: state.device_id ?? 'unknown',
        operationType: 'pull_apply',
        targetMain,
        priorLocalMain: state.local_main,
        priorLocalDeviceRef: state.server_device_ref,
        affectedPaths,
        platform: process.platform,
        pluginVersion: PLUGIN_VERSION,
        journal
      });
      journal.recovery_bundle_id = bundleId;
      journal.phase = 'recovery_bundle_written';
      journal.last_completed_step = 'recovery_bundle';
      await this.recovery.writeApplyJournal(journal);
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
      const targetContent = targetFiles.has(path) ? await this.git.readBlob(targetMain, path) : null;
      const absolutePath = join(this.vaultDir, path);
      if (targetContent === null) {
        await rm(absolutePath, { force: true });
      } else {
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, targetContent);
      }
    }

    journal.phase = 'verifying';
    journal.last_completed_step = 'files_written';
    await this.recovery.writeApplyJournal(journal);
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
      pluginVersion: PLUGIN_VERSION
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
    await this.block('partial_local_state', 'Local .obts state is partially initialized and requires reset or recovery.');
  }

  private async readExistingState(): Promise<LocalPluginState | null> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as LocalPluginState;
    } catch {
      return null;
    }
  }

  private async localContentMatchesTree(localFiles: string[], targetMain: string): Promise<boolean> {
    const serverFiles = await this.git.listTreeFiles(targetMain);
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

  private throwIfSyncBlocked(state: LocalPluginState): void {
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
      state.last_error_code === 'device_blocked'
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
    await writeJson(this.statePath, state);
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
  if (code === 'same_device_non_fast_forward' || code === 'device_blocked') {
    return 'Needs recovery';
  }
  return 'Unsafe local state';
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
