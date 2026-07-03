const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_VERSION = "2026-07-02.full-sync";
const PLUGIN_VERSION = "0.1.0-phase1";
const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
const SYNC_DEBOUNCE_MS = 1500;
const BACKGROUND_SYNC_INTERVAL_MS = 10 * 1000;

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:3000",
  pairingToken: "",
  deviceName: "",
  gitBinary: "git"
};

module.exports = class ObtsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.syncProfile;
    delete this.settings.syncPlugins;
    this.status = this.addStatusBarItem();
    this.syncQueued = false;
    this.syncRunning = false;
    this.isApplying = false;
    this.setStatus("Checking");
    this.client = new ObtsObsidianClient(this);
    await this.client.initialize();
    this.setStatus((await this.client.readState()).status_label);

    this.addSettingTab(new ObtsSettingTab(this.app, this));

    this.addCommand({
      id: "obts-pair-device",
      name: "Pair device",
      callback: async () => {
        await this.runUserAction(async () => {
          if (!this.settings.pairingToken) {
            throw new ObtsBlockedError("missing_pairing_token", "Enter a pairing token in obts settings first.");
          }
          await this.client.pairWithToken(this.settings.pairingToken);
          this.settings.pairingToken = "";
          await this.saveSettings();
          new Notice("obts paired this device.");
        });
      }
    });

    this.addCommand({
      id: "obts-sync-once",
      name: "Sync once",
      callback: async () => {
        await this.runUserAction(async () => {
          const result = await this.client.syncOnce({ confirmInitialImport: false });
          new Notice(`obts: ${result.status}`);
        });
      }
    });

    this.addCommand({
      id: "obts-confirm-initial-import",
      name: "Confirm initial import and sync",
      callback: async () => {
        await this.runUserAction(async () => {
          const result = await this.client.syncOnce({ confirmInitialImport: true });
          new Notice(`obts: ${result.status}`);
        });
      }
    });

    this.addCommand({
      id: "obts-replace-local-with-server",
      name: "Replace local with server state",
      callback: async () => {
        await this.runUserAction(async () => {
          const result = await this.client.replaceLocalWithServer();
          new Notice(`obts: ${result.status}`);
        });
      }
    });

    this.addCommand({
      id: "obts-rebuild-from-server-main",
      name: "Rebuild from server main",
      callback: async () => {
        await this.runUserAction(async () => {
          const result = await this.client.rebuildFromServerMain();
          new Notice(`obts: ${result.status}`);
        });
      }
    });

    this.addCommand({
      id: "obts-reset-local-pairing-state",
      name: "Reset local pairing state",
      callback: async () => {
        await this.runUserAction(async () => {
          if (!window.confirm("Reset local obts pairing state? This removes local sync credentials after writing a recovery bundle when local files exist. Re-pair this device afterwards.")) {
            return;
          }
          const result = await this.client.resetLocalPairingState();
          new Notice(`obts: ${result.status}`);
        });
      }
    });

    this.registerEvent(this.app.vault.on("create", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.queueSyncFromWatcher([file && file.path, oldPath])));

    this.registerInterval(
      window.setInterval(() => {
        void this.runBackgroundSync();
      }, BACKGROUND_SYNC_INTERVAL_MS)
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  setStatus(label) {
    if (this.status) {
      this.status.setText(`obts: ${label || "Checking"}`);
    }
  }

  queueSyncFromWatcher(paths) {
    if (this.isApplying) {
      return;
    }
    this.syncQueued = true;
    this.setStatus("Ahead");
    void this.client.recordLocalChangeHint(paths).catch(() => undefined);
    window.setTimeout(() => {
      void this.runQueuedSync();
    }, SYNC_DEBOUNCE_MS);
  }

  async runQueuedSync() {
    if (!this.syncQueued) {
      return;
    }
    this.syncQueued = false;
    await this.runAutomaticSync();
  }

  async runBackgroundSync() {
    if (this.syncQueued) {
      await this.runQueuedSync();
      return;
    }
    if (this.syncRunning) {
      return;
    }
    const state = await this.client.readState();
    if (!state.vault_id || !state.device_id || state.last_error_code) {
      return;
    }
    const queue = await this.client.readQueue();
    if (queue.pending_commit || queue.status === "queued_local") {
      await this.runAutomaticSync();
      return;
    }
    this.syncRunning = true;
    try {
      await this.client.pollRemoteEventsAndApply();
      this.setStatus((await this.client.readState()).status_label);
    } catch (error) {
      await this.handleAutomaticSyncError(error);
    } finally {
      this.syncRunning = false;
    }
  }

  async runAutomaticSync() {
    if (this.syncRunning) {
      return;
    }
    const state = await this.client.readState();
    if (!state.vault_id || !state.device_id || state.last_error_code) {
      return;
    }
    this.syncRunning = true;
    try {
      await this.client.syncOnce({ confirmInitialImport: false });
      this.setStatus((await this.client.readState()).status_label);
    } catch (error) {
      await this.handleAutomaticSyncError(error);
    } finally {
      this.syncRunning = false;
    }
  }

  async handleAutomaticSyncError(error) {
    if (error instanceof ObtsBlockedError) {
      await this.client.markBlocked(error.code);
      this.setStatus((await this.client.readState()).status_label);
      return;
    }
    this.setStatus("Offline");
  }

  async runUserAction(fn, showNotice = true) {
    if (this.syncRunning) {
      return;
    }
    this.syncRunning = true;
    try {
      const result = await fn();
      this.setStatus((await this.client.readState()).status_label);
      return result;
    } catch (error) {
      const code = error instanceof ObtsBlockedError ? error.code : "sync_error";
      const message = error instanceof Error ? error.message : "obts sync failed.";
      await this.client.markBlocked(code);
      this.setStatus((await this.client.readState()).status_label);
      if (showNotice) {
        new Notice(message);
      }
    } finally {
      this.syncRunning = false;
    }
  }
};

class ObtsObsidianClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.adapter = plugin.app.vault.adapter;
    this.vaultDir = requireDesktopVaultPath(this.adapter);
    this.obtsDir = path.join(this.vaultDir, ".obts");
    this.gitdir = path.join(this.obtsDir, "git");
    this.authPath = path.join(this.obtsDir, "auth", "device-token.json");
    this.statePath = path.join(this.obtsDir, "state.json");
    this.queuePath = path.join(this.obtsDir, "queue.json");
    this.applyJournalPath = path.join(this.obtsDir, "apply-journal.json");
    this.applyLockPath = path.join(this.obtsDir, "apply.lock");
  }

  async initialize() {
    await fsp.mkdir(path.join(this.obtsDir, "auth"), { recursive: true, mode: 0o700 });
    await this.git(["init"]);
    await this.git(["symbolic-ref", "HEAD", "refs/heads/local"], { allowFailure: true });
    await fsp.mkdir(path.join(this.gitdir, "info"), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(this.gitdir, "info", "exclude"), ".obts/\n.git/\n", { mode: 0o600 });
    const state = await this.repairLocalStateIfNeeded(await this.readState());
    const journal = await readJson(this.applyJournalPath, null);
    if (journal && journal.phase === "committed") {
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      await this.clearApplyState();
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return;
    }
    if (journal && await this.recoverIncompleteApplyJournal(journal, state)) {
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal) {
      await this.writeState(Object.assign({}, state, {
        status_label: "Unsafe local state",
        last_error_code: "apply_journal_recovery_required",
        updated_at: nowIso()
      }));
      return;
    }
    await this.writeState(Object.assign({}, state, {
      status_label: state.status_label || "Checking",
      updated_at: nowIso()
    }));
    await this.writeQueue(await this.readQueue());
  }

  async pairWithToken(pairingToken) {
    await this.assertPairingCanStart();
    const pairingRepair = await this.discoverPairingRepairContext(await readJson(this.statePath, null));
    const result = await postJson(this.url("/api/v1/pair/consume"), {
      pairing_token: pairingToken,
      device_name: this.plugin.settings.deviceName || "Obsidian device"
    });
    const rePairBaseline = this.baselineForPairing(pairingRepair.baseline, result.vault_id);
    await this.initialize();
    await writeJson(this.authPath, { device_token: result.device_token, created_at: nowIso() });
    await this.writeState({
      user_id: result.user_id,
      vault_id: result.vault_id,
      device_id: result.device_id,
      device_name: this.plugin.settings.deviceName || "Obsidian device",
      device_ref: result.device_ref,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: "Checking",
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });

    const pulled = await this.pull(result.vault_id, result.device_id, result.device_token, rePairBaseline ? rePairBaseline.main : null);
    await this.importPack(pulled.packfile);
    const localFiles = await this.scanSyncableFiles();
    const serverFiles = await this.listTreeFiles(pulled.manifest.target_main);
    const localAlreadyMatchesServer =
      localFiles.length > 0 && serverFiles.length > 0
        ? await this.localContentMatchesTree(localFiles, pulled.manifest.target_main)
        : false;
    const shouldProposeLocalContent =
      localFiles.length > 0 &&
      !localAlreadyMatchesServer &&
      (!result.is_first_device || serverFiles.length > 0 || pairingRepair.hasLocalGitHistory);
    if (shouldProposeLocalContent) {
      if (rePairBaseline && await this.canFastForwardCleanRePair(rePairBaseline, localFiles, pulled.manifest)) {
        await this.writeState(Object.assign({}, await this.readState(), {
          local_main: rePairBaseline.main,
          local_head: rePairBaseline.main,
          initial_import_confirmed: true,
          updated_at: nowIso()
        }));
        await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true);
        await this.writeState(Object.assign({}, await this.readState(), {
          initial_import_confirmed: true,
          status_label: "Synced",
          last_error_code: null,
          updated_at: nowIso()
        }));
        await this.acknowledgeAppliedMain(pulled.manifest.target_main);
        return;
      }
      const proposalBase = rePairBaseline && await this.commitExists(rePairBaseline.main) ? rePairBaseline.main : pulled.manifest.target_main;
      await this.updateRef("refs/heads/main", proposalBase, null, true);
      await this.updateRef("refs/heads/local", proposalBase, null, true);
      await this.writeState(Object.assign({}, await this.readState(), {
        local_main: proposalBase,
        local_head: proposalBase,
        initial_import_confirmed: true,
        status_label: "Ahead",
        last_error_code: null,
        updated_at: nowIso()
      }));
      const proposalCommit = await this.createLocalCommit("obts: local vault changes");
      await this.writeQueue({ pending_commit: proposalCommit, expected_device_ref: null, status: proposalCommit ? "queued_local" : "idle", attempts: 0, updated_at: nowIso() });
      if (proposalCommit) {
        await this.writeState(Object.assign({}, await this.readState(), {
          local_head: proposalCommit,
          status_label: "Ahead",
          updated_at: nowIso()
        }));
      }
      return;
    }
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true);
    if (localFiles.length === 0 || localAlreadyMatchesServer) {
      await this.writeState(Object.assign({}, await this.readState(), { initial_import_confirmed: true, updated_at: nowIso() }));
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }
  }

  async syncOnce(options) {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    this.throwIfSyncBlocked(state);

    const localFiles = await this.scanSyncableFiles();
    if (localFiles.length > 0 && !state.initial_import_confirmed && state.server_device_ref === null) {
      await this.createRecoveryBundle("initial_import", state.local_main, localFiles);
      if (!options.confirmInitialImport) {
        await this.block("initial_import_confirmation_required", "Initial import requires owner confirmation. Run the confirm initial import command after reviewing the recovery bundle.");
      }
      await this.writeState(Object.assign({}, state, { initial_import_confirmed: true, status_label: "Ahead", updated_at: nowIso() }));
    }

    const commit = await this.createLocalCommit("obts: local vault changes");
    if (commit) {
      const currentState = await this.readState();
      await this.writeQueue({
        pending_commit: commit,
        expected_device_ref: currentState.server_device_ref,
        status: "queued_local",
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState(Object.assign({}, currentState, { local_head: commit, status_label: "Ahead", last_error_code: null, updated_at: nowIso() }));
    }

    const queue = await this.readQueue();
    if (queue.pending_commit) {
      await this.uploadQueuedCommit(queue);
    }

    await this.pullAndApply(true);
    const finalState = await this.readState();
    return { status: finalState.status_label, main: finalState.local_main || undefined };
  }

  async replaceLocalWithServer() {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    if (state.last_error_code !== "replace_local_with_server_required") {
      throw new ObtsBlockedError("replace_local_with_server_not_required", "Local replacement is not currently required.");
    }
    const token = await this.readDeviceToken();
    const localFiles = await this.scanSyncableFiles();
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main);
    await this.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, localFiles);
    await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    await this.writeQueue({ pending_commit: null, expected_device_ref: state.server_device_ref, status: "idle", attempts: 0, updated_at: nowIso() });
    await this.writeState(Object.assign({}, await this.readState(), {
      initial_import_confirmed: true,
      status_label: "Synced",
      last_error_code: null,
      updated_at: nowIso()
    }));
    return { status: "Synced", main: pulled.manifest.target_main };
  }

  async rebuildFromServerMain() {
    await this.initialize();
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    if (state.last_error_code === "conflict_review_required") {
      throw new ObtsBlockedError("conflict_review_required", "A server conflict requires review before local rebuild can continue.");
    }
    if (state.last_error_code === "replace_local_with_server_required") {
      throw new ObtsBlockedError("replace_local_with_server_required", "Use Replace local with server state for first-pairing divergence.");
    }

    const token = await this.readDeviceToken();
    const queue = await this.readQueue();
    const localFiles = await this.scanSyncableFiles();
    const localSnapshot = await this.readFileSnapshot(localFiles);
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main);
    await this.importPack(pulled.packfile);
    const priorLocalFiles = state.local_main ? await this.listTreeFiles(state.local_main) : [];
    const pendingClassification = await this.classifyPendingCommit(queue.pending_commit, state.server_device_ref, pulled.manifest.target_main);

    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, true, localFiles);
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }

    if (pendingClassification === "divergent") {
      await this.createRecoveryBundle("rebuild_from_server", pulled.manifest.target_main, localFiles);
      await this.writeQueue(Object.assign({}, queue, {
        status: "blocked_recovery",
        updated_at: nowIso()
      }));
      await this.block("same_device_non_fast_forward", "Divergent same-device history requires export and reset or re-pair.");
    }

    if (pendingClassification === "fast_forward" && queue.pending_commit) {
      await this.updateRef("refs/heads/local", pulled.manifest.target_main, null, true);
      await this.writeQueue(Object.assign({}, queue, {
        status: "queued_local",
        updated_at: nowIso()
      }));
      await this.writeState(Object.assign({}, await this.readState(), {
        local_head: pulled.manifest.target_main,
        status_label: "Ahead",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return { status: "Ahead", main: pulled.manifest.target_main, preservedPendingCommit: queue.pending_commit };
    }

    if (pendingClassification === "repeat") {
      await this.writeQueue({ pending_commit: null, expected_device_ref: state.server_device_ref, status: "idle", attempts: 0, updated_at: nowIso() });
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return { status: "Synced", main: pulled.manifest.target_main };
    }

    if (!(await this.localSnapshotMatchesTree(localSnapshot, pulled.manifest.target_main))) {
      await this.restoreFileSnapshot(localSnapshot, priorLocalFiles);
      const recoveryCommit = await this.createLocalCommit("obts: rebuild preserved local edits");
      if (recoveryCommit) {
        await this.writeQueue({
          pending_commit: recoveryCommit,
          expected_device_ref: state.server_device_ref,
          status: "queued_local",
          attempts: 0,
          updated_at: nowIso()
        });
        await this.writeState(Object.assign({}, await this.readState(), {
          local_head: recoveryCommit,
          status_label: "Ahead",
          last_error_code: null,
          updated_at: nowIso()
        }));
        return { status: "Ahead", main: pulled.manifest.target_main, recoveryCommit };
      }
    }

    await this.writeQueue({ pending_commit: null, expected_device_ref: state.server_device_ref, status: "idle", attempts: 0, updated_at: nowIso() });
    await this.writeState(Object.assign({}, await this.readState(), {
      status_label: "Synced",
      last_error_code: null,
      updated_at: nowIso()
    }));
    return { status: "Synced", main: pulled.manifest.target_main };
  }

  async recordLocalChangeHint(paths) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id || state.last_error_code) {
      return;
    }
    if (paths !== undefined) {
      const changedPaths = (Array.isArray(paths) ? paths : [paths])
        .filter((filePath) => typeof filePath === "string" && filePath.length > 0)
        .map((filePath) => normalizePath(filePath))
        .filter((filePath) => isSyncableVaultPath(filePath));
      if (changedPaths.length === 0) {
        return;
      }
      assertNoCaseCollisions(changedPaths);
    }
    const queue = await this.readQueue();
    if (!queue.pending_commit) {
      await this.writeQueue({
        pending_commit: null,
        expected_device_ref: state.server_device_ref,
        status: "queued_local",
        attempts: 0,
        updated_at: nowIso()
      });
    }
    await this.writeState(Object.assign({}, state, { status_label: "Ahead", updated_at: nowIso() }));
  }

  async uploadQueuedCommit(queue) {
    const state = await this.readState();
    const token = await this.readDeviceToken();
    await this.writeQueue(Object.assign({}, queue, { status: "uploading", attempts: queue.attempts + 1, updated_at: nowIso() }));
    await this.writeState(Object.assign({}, state, {
      status_label: "Uploading",
      last_error_code: null,
      updated_at: nowIso()
    }));
    this.plugin.setStatus("Uploading");
    const packfile = await this.createPackForCommit(queue.pending_commit);
    const manifest = {
      api_version: API_VERSION,
      vault_id: state.vault_id,
      device_id: state.device_id,
      expected_device_ref: queue.expected_device_ref,
      target_commit: queue.pending_commit,
      packfile_sha256: sha256(packfile),
      packfile_bytes: packfile.byteLength,
      client_known_main: state.local_main,
      ...(queue.expected_device_ref === null && state.local_main ? { base_commit: state.local_main } : {}),
      attempt_id: `sync_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`
    };
    const result = await this.push(state.vault_id, token, manifest, packfile);
    if (result.status === "conflicted") {
      await this.writeQueue(Object.assign({}, queue, { status: "conflicted", updated_at: nowIso() }));
      await this.writeState(Object.assign({}, state, {
        server_device_ref: result.device_ref,
        status_label: "Review needed",
        last_error_code: "conflict_review_required",
        updated_at: nowIso()
      }));
      return;
    }
    if (result.status === "merged" || result.status === "noop") {
      await this.writeQueue({
        pending_commit: null,
        expected_device_ref: result.device_ref,
        status: result.status === "merged" ? "merged" : "idle",
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState(Object.assign({}, state, {
        server_device_ref: result.device_ref,
        local_head: queue.pending_commit,
        status_label: result.status === "merged" ? "Behind" : "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
    }
  }

  async pullAndApply(allowDestructive) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    this.throwIfSyncBlocked(state);
    const token = await this.readDeviceToken();
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main);
    await this.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, allowDestructive);
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }
  }

  async pollRemoteEventsAndApply() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return false;
    }
    this.throwIfSyncBlocked(state);
    const after = Number.isSafeInteger(state.last_event_seq) && state.last_event_seq >= 0 ? state.last_event_seq : 0;
    const token = await this.readDeviceToken();
    let page;
    try {
      page = await this.pollEvents(state.vault_id, token, after);
    } catch (error) {
      if (error instanceof ObtsTransportError && error.code === "event_cursor_expired") {
        const currentEventSeq = error.details && Number.isSafeInteger(error.details.current_event_seq) ? error.details.current_event_seq : after;
        await this.writeState(Object.assign({}, await this.readState(), { last_event_seq: currentEventSeq, updated_at: nowIso() }));
        await this.pullAndApply(true);
        return true;
      }
      throw error;
    }
    await this.writeState(Object.assign({}, await this.readState(), { last_event_seq: page.current_event_seq, updated_at: nowIso() }));
    const currentState = await this.readState();
    const shouldPull = page.events.some((event) => {
      const main = event && event.commit_cursors ? event.commit_cursors.main : null;
      return (event.event_type === "main_advanced" || event.event_type === "conflict_resolved") && typeof main === "string" && main !== currentState.local_main;
    });
    if (!shouldPull) {
      return false;
    }
    await this.pullAndApply(true);
    return true;
  }

  async unpairCurrentDevice() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    const token = await this.readDeviceToken();
    await this.unpairDevice(state.vault_id, token);
    const baselineMain = state.local_main || await this.resolveRef("refs/heads/main");
    await fsp.rm(this.authPath, { force: true });
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: null,
      status: "idle",
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
      status_label: "Not paired",
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: state.vault_id,
      unpaired_baseline_main: baselineMain,
      updated_at: nowIso()
    });
    return { status: "Not paired" };
  }

  async resetLocalPairingState() {
    const state = await this.readState();
    const localFiles = await this.scanSyncableFiles();
    const recoveryBundleId = localFiles.length > 0 ? await this.createRecoveryBundle("rebuild_from_server", state.local_main, localFiles) : null;
    await fsp.rm(this.authPath, { force: true });
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: null,
      status: "idle",
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
      status_label: "Not paired",
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    return { status: "Not paired", recoveryBundleId };
  }

  async applyTargetMain(targetMain, changedPaths, allowDestructive, extraAffectedPaths = []) {
    const state = await this.readState();
    if (state.local_main === targetMain && extraAffectedPaths.length === 0) {
      await this.writeState(Object.assign({}, state, { status_label: "Synced", updated_at: nowIso() }));
      return;
    }
    const applyId = `apply_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    await this.acquireApplyLock(applyId);
    this.plugin.isApplying = true;
    await this.writeState(Object.assign({}, state, {
      status_label: "Applying",
      last_error_code: null,
      updated_at: nowIso()
    }));
    this.plugin.setStatus("Applying");
    const journal = {
      apply_id: applyId,
      operation_type: "pull_apply",
      target_main: targetMain,
      expected_prior_local_main: state.local_main,
      expected_prior_local_device_ref: state.server_device_ref,
      phase: "planned",
      affected_paths: [],
      preflight_sha256: {},
      recovery_bundle_id: null,
      last_completed_step: null,
      redacted_error_category: null
    };
    try {
      const targetFiles = new Set(await this.listTreeFiles(targetMain));
      const affected = new Set(changedPaths || []);
      if (state.local_main) {
        for (const previousPath of await this.listTreeFiles(state.local_main)) {
          if (!targetFiles.has(previousPath)) {
            affected.add(previousPath);
          }
        }
      }
      for (const localPath of extraAffectedPaths) {
        affected.add(localPath);
      }
      const localVaultFiles = await this.listLocalVaultFiles();
      for (const conflictPath of materializationConflictFiles(new Set([...targetFiles, ...affected]), localVaultFiles)) {
        affected.add(conflictPath);
      }
      const affectedPaths = Array.from(affected).filter((filePath) => isRecoverableApplyPath(filePath)).sort();
      journal.affected_paths = affectedPaths;
      for (const filePath of affectedPaths) {
        journal.preflight_sha256[filePath] = await this.adapterSha256(filePath);
      }
      await writeJson(this.applyJournalPath, journal);

      if (affectedPaths.length > 0) {
        if (!allowDestructive) {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "destructive_apply_not_allowed";
          await writeJson(this.applyJournalPath, journal);
          await this.block("unsafe_local_state", "Destructive apply is not allowed in this mode.");
        }
        try {
          journal.recovery_bundle_id = await this.createRecoveryBundle("pull_apply", targetMain, affectedPaths, journal);
          journal.phase = "recovery_bundle_written";
          journal.last_completed_step = "recovery_bundle";
          await writeJson(this.applyJournalPath, journal);
        } catch {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "recovery_bundle_failed";
          await writeJson(this.applyJournalPath, journal);
          await this.block("recovery_bundle_failed", "Recovery bundle creation failed before apply.");
        }
      }

      journal.phase = "writing_files";
      await writeJson(this.applyJournalPath, journal);
      for (const filePath of affectedPaths) {
        if ((await this.adapterSha256(filePath)) !== journal.preflight_sha256[filePath]) {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "preflight_hash_changed";
          await writeJson(this.applyJournalPath, journal);
          await this.block("unsafe_local_state", "A local file changed during apply preflight.");
        }
      }
      await this.writeTargetFilesFromJournal(journal, targetFiles);

      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.applyJournalPath, journal);
      await this.updateRef("refs/heads/main", targetMain, null, true);
      await this.updateRef("refs/heads/local", targetMain, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.applyJournalPath, journal);
      await this.writeState(Object.assign({}, state, {
        local_main: targetMain,
        local_head: targetMain,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.clearApplyState();
    } finally {
      this.plugin.isApplying = false;
      await fsp.rm(this.applyLockPath, { force: true });
    }
  }

  async recoverIncompleteApplyJournal(journal, state) {
    if (journal.phase === "blocked_recovery" || !(await this.commitExists(journal.target_main))) {
      return false;
    }
    const targetFiles = new Set(await this.listTreeFiles(journal.target_main));
    if (!(await this.applyJournalMatchesCurrentFiles(journal, targetFiles))) {
      return false;
    }
    try {
      await fsp.rm(this.applyLockPath, { force: true });
      await this.acquireApplyLock(journal.apply_id);
      this.plugin.isApplying = true;
      if (journal.affected_paths.length > 0 && journal.recovery_bundle_id === null) {
        journal.recovery_bundle_id = await this.createRecoveryBundle(journal.operation_type, journal.target_main, journal.affected_paths, journal);
        journal.last_completed_step = "recovery_bundle";
        journal.phase = "recovery_bundle_written";
        await writeJson(this.applyJournalPath, journal);
      }
      journal.phase = "writing_files";
      journal.redacted_error_category = null;
      await writeJson(this.applyJournalPath, journal);
      await this.writeTargetFilesFromJournal(journal, targetFiles);
      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.applyJournalPath, journal);
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.applyJournalPath, journal);
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.clearApplyState();
      return true;
    } catch {
      return false;
    } finally {
      this.plugin.isApplying = false;
      await fsp.rm(this.applyLockPath, { force: true });
    }
  }

  async applyJournalMatchesCurrentFiles(journal, targetFiles) {
    for (const filePath of journal.affected_paths) {
      const currentHash = await this.adapterSha256(filePath);
      const preflightHash = journal.preflight_sha256[filePath] || null;
      if (currentHash === preflightHash) {
        continue;
      }
      if (journal.phase !== "writing_files" && journal.phase !== "verifying") {
        return false;
      }
      const targetContent = targetFiles.has(filePath) ? await this.readBlob(journal.target_main, filePath) : null;
      const targetHash = targetContent === null ? null : sha256(targetContent);
      if (currentHash !== targetHash) {
        return false;
      }
    }
    return true;
  }

  async writeTargetFilesFromJournal(journal, targetFiles) {
    const assertRecoveredDescendants = async (filePath) => {
      const descendants = await this.listLocalDescendantFiles(filePath);
      if (descendants.some((descendant) => !(descendant in journal.preflight_sha256))) {
        journal.phase = "blocked_recovery";
        journal.redacted_error_category = "preflight_hash_changed";
        await writeJson(this.applyJournalPath, journal);
        await this.block("unsafe_local_state", "A local file changed during apply preflight.");
      }
    };
    for (const filePath of journal.affected_paths.filter((candidate) => !targetFiles.has(candidate)).sort((left, right) => right.length - left.length)) {
      if (await this.adapterIsDirectory(filePath)) {
        await assertRecoveredDescendants(filePath);
      }
      await this.adapterRemove(filePath);
    }
    for (const filePath of journal.affected_paths.filter((candidate) => targetFiles.has(candidate))) {
      const content = await this.readBlob(journal.target_main, filePath);
      await this.removeBlockingMaterializationPaths(filePath);
      if (await this.adapterIsDirectory(filePath)) {
        await assertRecoveredDescendants(filePath);
        await this.adapterRemove(filePath);
      }
      await this.adapterWriteBinary(filePath, content);
    }
  }

  async createLocalCommit(message) {
    const base = await this.resolveRef("refs/heads/local");
    if (base) {
      await this.git(["read-tree", base]);
    } else {
      await this.git(["read-tree", "--empty"]);
    }
    const tracked = base ? await this.listTreeFiles(base) : [];
    const localFiles = await this.scanSyncableFiles();
    const localSet = new Set(localFiles);
    for (const filePath of tracked) {
      if (!isSyncableVaultPath(filePath) || !localSet.has(filePath)) {
        await this.git(["update-index", "--remove", "--", filePath], { allowFailure: true });
      }
    }
    for (const batch of chunks(localFiles, 100)) {
      await this.git(["update-index", "--add", "--", ...batch]);
    }
    const tree = (await this.git(["write-tree"])).trim();
    if (base) {
      const baseTree = (await this.git(["show", "-s", "--format=%T", base])).trim();
      if (baseTree === tree) {
        return null;
      }
    } else if (localFiles.length === 0) {
      return null;
    }
    const args = ["commit-tree", tree, "-m", message];
    if (base) {
      args.splice(2, 0, "-p", base);
    }
    const commit = (await this.git(args, {
      env: {
        GIT_AUTHOR_NAME: "obts device",
        GIT_AUTHOR_EMAIL: "device@obts.local",
        GIT_COMMITTER_NAME: "obts device",
        GIT_COMMITTER_EMAIL: "device@obts.local"
      }
    })).trim();
    await this.updateRef("refs/heads/local", commit, base);
    return commit;
  }

  async scanSyncableFiles() {
    const result = (await this.listLocalVaultFiles()).filter((filePath) => isSyncableVaultPath(filePath));
    return assertNoCaseCollisions(result.sort());
  }

  async localContentMatchesTree(localFiles, targetMain) {
    const serverFiles = await this.listTreeFiles(targetMain);
    if (localFiles.length !== serverFiles.length) {
      return false;
    }
    const localSet = new Set(localFiles);
    for (const filePath of serverFiles) {
      if (!localSet.has(filePath)) {
        return false;
      }
      const content = await this.adapterReadBinary(filePath);
      const server = await this.readBlob(targetMain, filePath);
      if (!content || sha256(content) !== sha256(server)) {
        return false;
      }
    }
    return true;
  }

  async localSnapshotMatchesTree(snapshot, targetMain) {
    const serverFiles = await this.listTreeFiles(targetMain);
    if (snapshot.size !== serverFiles.length) {
      return false;
    }
    for (const filePath of serverFiles) {
      const localContent = snapshot.get(filePath);
      const serverContent = await this.readBlob(targetMain, filePath);
      if (!localContent || !serverContent || sha256(localContent) !== sha256(serverContent)) {
        return false;
      }
    }
    return true;
  }

  async classifyPendingCommit(pendingCommit, serverDeviceRef, targetMain) {
    if (!pendingCommit) {
      return "none";
    }
    if (!(await this.commitExists(pendingCommit))) {
      return "divergent";
    }
    if (await this.isAncestor(pendingCommit, targetMain)) {
      return "repeat";
    }
    if (serverDeviceRef) {
      if (await this.isAncestor(pendingCommit, serverDeviceRef)) {
        return "repeat";
      }
      if (await this.isAncestor(serverDeviceRef, pendingCommit)) {
        return "fast_forward";
      }
      return "divergent";
    }
    if (await this.isAncestor(targetMain, pendingCommit)) {
      return "fast_forward";
    }
    return "divergent";
  }

  async readFileSnapshot(files) {
    const snapshot = new Map();
    for (const filePath of files) {
      const content = await this.adapterReadBinary(filePath);
      if (content !== null) {
        snapshot.set(filePath, content);
      }
    }
    return snapshot;
  }

  async restoreFileSnapshot(snapshot, priorLocalFiles) {
    for (const filePath of priorLocalFiles.sort((left, right) => right.length - left.length)) {
      if (!snapshot.has(filePath)) {
        await this.adapterRemove(filePath);
      }
    }
    for (const [filePath, content] of Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      await this.removeBlockingMaterializationPaths(filePath);
      if (await this.adapterIsDirectory(filePath)) {
        await this.adapterRemove(filePath);
      }
      await this.adapterWriteBinary(filePath, content);
    }
  }

  async createRecoveryBundle(operationType, targetMain, affectedPaths, journal = null) {
    const state = await this.readState();
    const bundleId = `rec_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    const bundleDir = path.join(this.obtsDir, "recovery", bundleId);
    await fsp.mkdir(path.join(bundleDir, "files"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(bundleDir, "git"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(bundleDir, "patches"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(bundleDir, "journal"), { recursive: true, mode: 0o700 });
    const snapshotChecksums = [];
    for (const filePath of affectedPaths) {
      if (filePath.startsWith(".obts/")) {
        continue;
      }
      const content = await this.adapterReadBinary(filePath);
      if (content !== null) {
        const target = path.join(bundleDir, "files", filePath);
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fsp.writeFile(target, content, { mode: 0o600 });
        snapshotChecksums.push(`${sha256(content)}  files/${filePath}`);
        if (isTextPatchPath(filePath)) {
          await writeTextSnapshotPatch(bundleDir, filePath, content);
        }
      } else {
        snapshotChecksums.push(`missing  files/${filePath}`);
      }
    }
    const manifest = {
      bundle_id: bundleId,
      vault_id: state.vault_id || "unknown",
      device_id: state.device_id || "unknown",
      created_at: nowIso(),
      operation_type: operationType,
      target_main: targetMain || "unknown",
      prior_local_main: state.local_main,
      prior_local_device_ref: state.server_device_ref,
      affected_paths: affectedPaths,
      platform: os.platform(),
      plugin_version: PLUGIN_VERSION,
      checksum_manifest: snapshotChecksums
    };
    await writeJson(path.join(bundleDir, "manifest.json"), manifest);
    if (journal) {
      await writeJson(path.join(bundleDir, "journal", "apply-journal.json"), journal);
    }
    const pack = await this.createRecoveryRefsPack();
    await fsp.writeFile(path.join(bundleDir, "git", "local-refs.pack"), pack, { mode: 0o600 });
    await fsp.writeFile(path.join(bundleDir, "checksums.sha256"), `${(await bundleChecksums(bundleDir)).join("\n")}\n`, { mode: 0o600 });
    return bundleId;
  }

  async createRecoveryRefsPack() {
    const refs = [];
    for (const ref of ["refs/heads/local", "refs/heads/main"]) {
      const oid = await this.resolveRef(ref);
      if (oid) {
        refs.push(oid);
      }
    }
    if (refs.length === 0) {
      return Buffer.alloc(0);
    }
    return await this.packObjects(refs);
  }

  async createPackForCommit(commit) {
    return await this.packObjects([commit]);
  }

  async packObjects(revs) {
    const input = Buffer.from(`${revs.join("\n")}\n`, "utf8");
    return await this.gitBuffer(["pack-objects", "--stdout", "--revs"], input, { maxBuffer: 512 * 1024 * 1024 });
  }

  async importPack(packfile) {
    if (!packfile || packfile.byteLength === 0) {
      return;
    }
    const packPath = path.join(this.gitdir, "objects", "pack", `obts-pull-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.pack`);
    await fsp.mkdir(path.dirname(packPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(packPath, packfile, { mode: 0o600 });
    await this.git(["index-pack", packPath]);
  }

  async listTreeFiles(commit) {
    if (!commit) {
      return [];
    }
    const output = await this.git(["ls-tree", "-r", "-z", "--name-only", commit]);
    return output.split("\0").filter(Boolean).filter((filePath) => isSyncableVaultPath(filePath)).sort();
  }

  async readBlob(commit, filePath) {
    return await this.gitBuffer(["show", `${commit}:${filePath}`], undefined, { maxBuffer: 512 * 1024 * 1024 });
  }

  async getDeviceSelf(token) {
    const response = await fetch(this.url("/api/v1/device/self"), {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async pull(vaultId, deviceId, token, currentLocalMain, requestedTarget = "latest") {
    const form = new FormData();
    form.append("manifest", JSON.stringify({
      api_version: API_VERSION,
      vault_id: vaultId,
      device_id: deviceId,
      current_local_main: currentLocalMain,
      requested_target: requestedTarget
    }));
    form.append("packfile", new Blob([new ArrayBuffer(0)], { type: "application/x-git-packed-objects" }), "have.pack");
    const response = await fetch(this.url(`/api/v1/vaults/${vaultId}/sync/pull`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
  }

  async push(vaultId, token, manifest, packfile) {
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("packfile", new Blob([packfile], { type: "application/x-git-packed-objects" }), "pack.pack");
    const response = await fetch(this.url(`/api/v1/vaults/${vaultId}/sync/push`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async pollEvents(vaultId, token, after) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Event cursor must be a non-negative safe integer.");
    }
    const response = await fetch(this.url(`/api/v1/vaults/${vaultId}/sync/events?after=${after}`), {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async unpairDevice(vaultId, token) {
    const response = await fetch(this.url(`/api/v1/vaults/${vaultId}/sync/unpair`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async acknowledgeAppliedMain(targetMain) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    try {
      await this.pull(state.vault_id, state.device_id, await this.readDeviceToken(), targetMain, targetMain);
    } catch (error) {
      if (!(error instanceof ObtsTransportError && error.status === 404)) {
        throw error;
      }
    }
  }

  async assertPairingCanStart() {
    if (!(await exists(this.obtsDir))) {
      return;
    }
    const existingState = await readJson(this.statePath, null);
    if (existingState && (existingState.vault_id || existingState.device_id)) {
      await this.block("local_state_already_paired", "Local .obts state already belongs to a paired device.");
    }
    if (await exists(this.authPath)) {
      await this.block("local_state_already_paired", "A device token already exists for this vault.");
    }
    if (await this.isCleanUnpairedScaffold(existingState)) {
      return;
    }
    await this.block("partial_local_state", "Local .obts state is partially initialized and requires reset or recovery.");
  }

  async isCleanUnpairedScaffold(existingState) {
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
      existingState.last_error_code && existingState.last_error_code !== "partial_local_state"
    ) {
      return false;
    }
    if (
      (await exists(this.applyJournalPath)) ||
      (await exists(this.applyLockPath)) ||
      !(await exists(this.queuePath))
    ) {
      return false;
    }
    const queue = await this.readQueue();
    return (
      queue.pending_commit === null &&
      queue.expected_device_ref === null &&
      queue.status === "idle" &&
      queue.attempts === 0
    );
  }

  async discoverPairingRepairContext(state) {
    const localMain = await this.resolveRef("refs/heads/main");
    const localHead = await this.resolveRef("refs/heads/local");
    const detached = this.detachedBaselineFromState(state);
    const stateMain = state && state.vault_id && state.local_main && await this.commitExists(state.local_main)
      ? { vaultId: state.vault_id, main: state.local_main }
      : null;
    const localMainBaseline = state && state.vault_id && localMain
      ? { vaultId: state.vault_id, main: localMain }
      : null;
    return {
      baseline: detached || stateMain || localMainBaseline,
      hasLocalGitHistory: Boolean(detached || stateMain || localMain || localHead)
    };
  }

  detachedBaselineFromState(state) {
    if (
      !state ||
      !state.unpaired_baseline_vault_id ||
      !state.unpaired_baseline_main
    ) {
      return null;
    }
    return {
      vaultId: state.unpaired_baseline_vault_id,
      main: state.unpaired_baseline_main
    };
  }

  baselineForPairing(baseline, vaultId) {
    if (!baseline) {
      return null;
    }
    if (baseline.vaultId !== vaultId) {
      return null;
    }
    return baseline;
  }

  async canFastForwardCleanRePair(baseline, localFiles, manifest) {
    if (manifest.current_local_main_is_ancestor === false) {
      return false;
    }
    if (!(await this.commitExists(baseline.main))) {
      return false;
    }
    if (!(await this.localContentMatchesTree(localFiles, baseline.main))) {
      return false;
    }
    return await this.isAncestor(baseline.main, manifest.target_main);
  }

  async acquireApplyLock(applyId) {
    await fsp.mkdir(path.dirname(this.applyLockPath), { recursive: true, mode: 0o700 });
    try {
      await fsp.writeFile(this.applyLockPath, JSON.stringify({ apply_id: applyId, created_at: nowIso() }, null, 2), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error && error.code === "EEXIST") {
        await this.block("apply_lock_active", "Another apply operation already holds the local vault lock.");
      }
      throw error;
    }
  }

  async clearApplyState() {
    await fsp.rm(this.applyJournalPath, { force: true });
    await fsp.rm(this.applyLockPath, { force: true });
  }

  async updateRef(ref, target, expected, force = false) {
    const args = force || !expected ? ["update-ref", ref, target] : ["update-ref", ref, target, expected];
    await this.git(args);
  }

  async resolveRef(ref) {
    try {
      return (await this.git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    } catch {
      return null;
    }
  }

  async commitExists(commit) {
    try {
      await this.git(["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async isAncestor(ancestor, descendant) {
    if (ancestor === descendant) {
      return true;
    }
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  async git(args, options = {}) {
    return (await this.gitRaw(args, undefined, options)).toString("utf8");
  }

  async gitBuffer(args, input, options = {}) {
    return await this.gitRaw(args, input, options);
  }

  async gitRaw(args, input, options = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.plugin.settings.gitBinary || "git", ["--git-dir", this.gitdir, "--work-tree", this.vaultDir, ...args], {
        env: Object.assign({}, process.env, options.env || {}),
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      const maxBuffer = options.maxBuffer || 64 * 1024 * 1024;
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxBuffer) {
          child.kill("SIGKILL");
          reject(new Error("git output exceeded buffer"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr).toString("utf8");
        if (code !== 0 && !options.allowFailure) {
          reject(new Error(`git ${args.join(" ")} failed: ${err}`));
          return;
        }
        resolve(out);
      });
      if (input) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  async readState() {
    try {
      const state = JSON.parse(await fsp.readFile(this.statePath, "utf8"));
      if (await this.hasActiveTokenWithoutIdentity(state)) {
        return await this.readBackupState() || this.localStateIncomplete(state);
      }
      return state;
    } catch {
      if (await exists(this.authPath)) {
        const backupState = await this.readBackupState();
        return backupState || this.localStateIncomplete(null);
      }
      return {
        user_id: null,
        vault_id: null,
        device_id: null,
        device_name: null,
        device_ref: null,
        server_device_ref: null,
        local_main: null,
        local_head: null,
        initial_import_confirmed: false,
        status_label: "Checking",
        last_error_code: null,
        last_event_seq: 0,
        unpaired_baseline_vault_id: null,
        unpaired_baseline_main: null,
        updated_at: nowIso()
      };
    }
  }

  async writeState(state) {
    await this.backupExistingState();
    await writeJson(this.statePath, state);
  }

  async repairLocalStateIfNeeded(state) {
    if (state.last_error_code !== "local_state_incomplete") {
      return state;
    }
    let token;
    try {
      token = await this.readDeviceToken();
    } catch {
      return state;
    }
    try {
      const self = await this.getDeviceSelf(token);
      const localMain = await this.resolveRef("refs/heads/main");
      const localHead = await this.resolveRef("refs/heads/local");
      await this.importCurrentServerMain(self.vault_id, self.device_id, token, localMain);
      let repairedLocalMain = localMain;
      let repairedLocalHead = localHead || localMain;
      if (!localMain && !localHead) {
        const localFiles = await this.scanSyncableFiles();
        if (localFiles.length > 0 && await this.commitExists(self.current_main)) {
          repairedLocalMain = self.current_main;
          repairedLocalHead = self.current_main;
          await this.updateRef("refs/heads/main", self.current_main, null, true);
          await this.updateRef("refs/heads/local", self.current_main, null, true);
        }
      }
      const repaired = {
        user_id: self.user_id,
        vault_id: self.vault_id,
        device_id: self.device_id,
        device_name: self.device_name,
        device_ref: self.device_ref,
        server_device_ref: self.server_device_ref,
        local_main: repairedLocalMain,
        local_head: repairedLocalHead,
        initial_import_confirmed: true,
        status_label: self.status === "review_needed" || self.status === "blocked_recovery" ? "Needs recovery" : "Checking",
        last_error_code: self.status === "review_needed" || self.status === "blocked_recovery" ? "device_blocked" : null,
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

  async importCurrentServerMain(vaultId, deviceId, token, localMain) {
    try {
      const pulled = await this.pull(vaultId, deviceId, token, localMain, "latest");
      await this.importPack(pulled.packfile);
    } catch {
      // Metadata repair can continue without fresh main objects; sync will retry and block safely if needed.
    }
  }

  async backupExistingState() {
    try {
      const state = JSON.parse(await fsp.readFile(this.statePath, "utf8"));
      if (state.vault_id && state.device_id) {
        await fsp.copyFile(this.statePath, `${this.statePath}.bak`);
      }
    } catch {
      // Keep any existing backup when the primary state file is unreadable.
    }
  }

  async readBackupState() {
    try {
      const state = JSON.parse(await fsp.readFile(`${this.statePath}.bak`, "utf8"));
      if (state.vault_id && state.device_id) {
        return state;
      }
    } catch {
      return null;
    }
    return null;
  }

  async hasActiveTokenWithoutIdentity(state) {
    return Boolean((!state.vault_id || !state.device_id) && await exists(this.authPath));
  }

  localStateIncomplete(state) {
    return {
      user_id: state && state.user_id || null,
      vault_id: state && state.vault_id || null,
      device_id: state && state.device_id || null,
      device_name: state && state.device_name || null,
      device_ref: state && state.device_ref || null,
      server_device_ref: state && state.server_device_ref || null,
      local_main: state && state.local_main || null,
      local_head: state && state.local_head || null,
      initial_import_confirmed: state && state.initial_import_confirmed || false,
      status_label: "Needs recovery",
      last_error_code: "local_state_incomplete",
      last_event_seq: state && state.last_event_seq || 0,
      unpaired_baseline_vault_id: state && state.unpaired_baseline_vault_id || null,
      unpaired_baseline_main: state && state.unpaired_baseline_main || null,
      updated_at: nowIso()
    };
  }

  async readQueue() {
    return await readJson(this.queuePath, {
      pending_commit: null,
      expected_device_ref: null,
      status: "idle",
      attempts: 0,
      updated_at: nowIso()
    });
  }

  async writeQueue(queue) {
    await writeJson(this.queuePath, queue);
  }

  async readDeviceToken() {
    const tokenFile = await readJson(this.authPath, {});
    if (!tokenFile.device_token) {
      throw new ObtsBlockedError("not_paired", "Device token is missing.");
    }
    return tokenFile.device_token;
  }

  async adapterReadBinary(filePath) {
    try {
      const data = await this.adapter.readBinary(filePath);
      return Buffer.from(data);
    } catch {
      return null;
    }
  }

  async adapterWriteBinary(filePath, content) {
    await ensureAdapterDir(this.adapter, path.posix.dirname(filePath));
    await this.adapter.writeBinary(filePath, content);
  }

  async adapterRemove(filePath) {
    try {
      if (await this.adapterIsDirectory(filePath)) {
        if (typeof this.adapter.rmdir === "function") {
          await this.adapter.rmdir(filePath, true);
        } else {
          await this.adapter.remove(filePath);
        }
      } else {
        await this.adapter.remove(filePath);
      }
    } catch {
      // The target may already be absent after an interrupted or repeated apply.
    }
  }

  async adapterSha256(filePath) {
    const data = await this.adapterReadBinary(filePath);
    return data ? sha256(data) : null;
  }

  async adapterExists(filePath) {
    if (!filePath || filePath === ".") {
      return true;
    }
    try {
      if (typeof this.adapter.exists === "function") {
        return await this.adapter.exists(filePath);
      }
      await this.adapter.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async adapterIsDirectory(filePath) {
    if (!filePath || filePath === ".") {
      return true;
    }
    try {
      if (typeof this.adapter.stat === "function") {
        const stat = await this.adapter.stat(filePath);
        if (stat && stat.type === "folder") {
          return true;
        }
        if (stat && stat.type === "file") {
          return false;
        }
      }
      await this.adapter.list(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listLocalVaultFiles() {
    const result = [];
    await this.walkAdapterFiles("", result);
    return result.sort();
  }

  async listLocalDescendantFiles(filePath) {
    if (!(await this.adapterIsDirectory(filePath))) {
      return [];
    }
    const result = [];
    await this.walkAdapterFiles(filePath, result);
    return result.sort();
  }

  async walkAdapterFiles(dir, result) {
    const listing = await this.adapter.list(dir);
    for (const folder of listing.folders || []) {
      const normalizedFolder = normalizePath(folder);
      if (normalizedFolder === ".obts" || normalizedFolder.startsWith(".obts/")) {
        continue;
      }
      assertValidLocalVaultPath(normalizedFolder);
      if (!isSyncableVaultPath(normalizedFolder)) {
        continue;
      }
      await this.walkAdapterFiles(normalizedFolder, result);
    }
    for (const filePath of listing.files || []) {
      const normalizedFile = normalizePath(filePath);
      if (normalizedFile === ".obts" || normalizedFile.startsWith(".obts/")) {
        continue;
      }
      assertValidLocalVaultPath(normalizedFile);
      result.push(normalizedFile);
    }
  }

  async removeBlockingMaterializationPaths(filePath) {
    for (const prefix of directoryPrefixes(filePath)) {
      if ((await this.adapterExists(prefix)) && !(await this.adapterIsDirectory(prefix))) {
        await this.adapterRemove(prefix);
      }
    }
  }

  url(route) {
    return `${this.plugin.settings.serverUrl.replace(/\/+$/u, "")}${route}`;
  }

  throwIfSyncBlocked(state) {
    if (state.last_error_code === "conflict_review_required") {
      throw new ObtsBlockedError("conflict_review_required", "A server conflict requires review before normal sync can continue.");
    }
    if (state.last_error_code === "replace_local_with_server_required") {
      throw new ObtsBlockedError("replace_local_with_server_required", "Replace local content with server state before normal sync can continue.");
    }
    if (state.last_error_code === "apply_journal_recovery_required") {
      throw new ObtsBlockedError("apply_journal_recovery_required", "An incomplete apply journal requires recovery before sync can continue.");
    }
    if (state.last_error_code === "same_device_non_fast_forward" || state.last_error_code === "stale_device_ref" || state.last_error_code === "device_blocked" || state.last_error_code === "local_state_incomplete") {
      throw new ObtsBlockedError(state.last_error_code, "Device sync is blocked until recovery completes.");
    }
  }

  async block(code, message) {
    await this.markBlocked(code);
    throw new ObtsBlockedError(code, message);
  }

  async markBlocked(code) {
    await this.writeState(Object.assign({}, await this.readState(), {
      status_label: blockStatusLabel(code),
      last_error_code: code,
      updated_at: nowIso()
    }));
  }
}

class ObtsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian True Sync" });
    const state = await this.plugin.client.readState();
    const paired = Boolean(state.vault_id && state.device_id);
    const recoveryBlocked = state.last_error_code === "local_state_incomplete";
    const deviceName = state.device_name || this.plugin.settings.deviceName || "Obsidian device";

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    const sectionHeader = containerEl.createDiv({ cls: "obts-settings-section-header" });
    sectionHeader.createEl("h3", { text: recoveryBlocked ? "Recovery required" : paired ? "Device" : "Pair Device" });
    sectionHeader.createEl("span", {
      cls: paired ? "obts-status-pill obts-status-pill--ok" : "obts-status-pill",
      text: recoveryBlocked ? "Needs recovery" : paired ? "Paired" : "Not paired"
    });
    if (paired) {
      new Setting(containerEl)
        .setName("Device")
        .setDesc(`${deviceName} · ${state.device_id}`);
      new Setting(containerEl)
        .setName("Status")
        .setDesc(state.last_error_code ? blockStatusLabel(state.last_error_code) : state.status_label || "Checking");
      new Setting(containerEl)
        .setName("Actions")
        .addButton((button) =>
          button
            .setButtonText("Sync now")
            .setCta()
            .onClick(async () => {
              button.setDisabled(true);
              setFeedback(actionFeedback, "Syncing...", "muted");
              try {
                const result = await this.plugin.client.syncOnce({ confirmInitialImport: false });
                this.plugin.setStatus((await this.plugin.client.readState()).status_label);
                setFeedback(actionFeedback, `Synced: ${result.status}`, "success");
                new Notice(`obts: ${result.status}`);
                await this.display();
              } catch (error) {
                setFeedback(actionFeedback, error instanceof Error ? error.message : "Sync failed.", "error");
              } finally {
                button.setDisabled(false);
              }
            })
        )
        .addButton((button) => {
          button
            .setButtonText("Unpair...")
            .onClick(async () => {
              if (!window.confirm("Unpair this device? The server device will be revoked and local sync credentials will be removed.")) {
                return;
              }
              button.setDisabled(true);
              setFeedback(actionFeedback, "Unpairing...", "muted");
              try {
                await this.plugin.client.unpairCurrentDevice();
                this.plugin.settings.pairingToken = "";
                await this.plugin.saveSettings();
                this.plugin.setStatus("Not paired");
                new Notice("obts unpaired this device.");
                await this.display();
              } catch (error) {
                setFeedback(actionFeedback, error instanceof Error ? error.message : "Unpair failed.", "error");
              } finally {
                button.setDisabled(false);
              }
            });
          if (typeof button.setWarning === "function") {
            button.setWarning();
          }
        });
      const actionFeedback = containerEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    } else if (recoveryBlocked) {
      new Setting(containerEl)
        .setName("Status")
        .setDesc("Local sync metadata is incomplete. The device token is still present, so normal sync and pairing are blocked until you reset and re-pair.");
      new Setting(containerEl)
        .setName("Recovery")
        .addButton((button) => {
          button
            .setButtonText("Reset local pairing state")
            .onClick(async () => {
              if (!window.confirm("Reset local obts pairing state? This removes local sync credentials after writing a recovery bundle when local files exist. Re-pair this device afterwards.")) {
                return;
              }
              button.setDisabled(true);
              setFeedback(recoveryFeedback, "Resetting...", "muted");
              try {
                await this.plugin.client.resetLocalPairingState();
                this.plugin.settings.pairingToken = "";
                await this.plugin.saveSettings();
                this.plugin.setStatus("Not paired");
                new Notice("obts reset local pairing state. Re-pair this device to resume sync.");
                await this.display();
              } catch (error) {
                setFeedback(recoveryFeedback, error instanceof Error ? error.message : "Reset failed.", "error");
              } finally {
                button.setDisabled(false);
              }
            });
          if (typeof button.setWarning === "function") {
            button.setWarning();
          }
        });
      const recoveryFeedback = containerEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    } else {
      new Setting(containerEl)
        .setName("Status")
        .setDesc("Ready to pair this vault");
      new Setting(containerEl)
        .setName("Device name")
        .addText((text) =>
          text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Pairing token")
        .addText((text) => {
          text.setPlaceholder("obts_pair_...");
          text.inputEl.type = "password";
          text.setValue(this.plugin.settings.pairingToken).onChange(async (value) => {
            this.plugin.settings.pairingToken = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Pairing")
        .addButton((button) =>
          button
            .setButtonText("Pair")
            .setCta()
            .onClick(async () => {
              button.setDisabled(true);
              setFeedback(pairingFeedback, "Pairing...", "muted");
              try {
                if (!this.plugin.settings.pairingToken) {
                  throw new ObtsBlockedError("missing_pairing_token", "Enter a pairing token.");
                }
                await this.plugin.client.pairWithToken(this.plugin.settings.pairingToken);
                this.plugin.settings.pairingToken = "";
                await this.plugin.saveSettings();
                this.plugin.setStatus((await this.plugin.client.readState()).status_label);
                new Notice("obts paired this device.");
                await this.display();
              } catch (error) {
                setFeedback(pairingFeedback, error instanceof Error ? error.message : "Pairing failed.", "error");
              } finally {
                button.setDisabled(false);
              }
            })
        );
      const pairingFeedback = containerEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    }

    new Setting(containerEl)
      .setName("Git binary")
      .addText((text) =>
        text.setValue(this.plugin.settings.gitBinary).onChange(async (value) => {
          this.plugin.settings.gitBinary = value.trim() || "git";
          await this.plugin.saveSettings();
        })
      );
  }
}

function setFeedback(element, message, tone) {
  element.className = `obts-feedback obts-feedback--${tone}`;
  element.textContent = message;
}

class ObtsBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class ObtsTransportError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return await response.json();
}

async function throwResponseError(response) {
  let code = "http_error";
  let message = `HTTP ${response.status}`;
  let details = undefined;
  try {
    const body = await response.json();
    code = body.error && body.error.code ? body.error.code : code;
    message = body.error && body.error.message ? body.error.message : message;
    details = body.error ? body.error.details : undefined;
  } catch {
    // Keep status-only transport errors redacted.
  }
  throw new ObtsTransportError(response.status, code, message, details);
}

function parseMultipartPull(contentType, data) {
  const boundaryMatch = /boundary=([^;]+)/iu.exec(contentType);
  if (!boundaryMatch || !boundaryMatch[1]) {
    throw new Error("Pull response did not include a multipart boundary.");
  }
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts = [];
  let offset = 0;
  while (offset < data.byteLength) {
    const start = data.indexOf(boundary, offset);
    if (start < 0) {
      break;
    }
    const afterBoundary = start + boundary.byteLength;
    if (data.subarray(afterBoundary, afterBoundary + 2).toString("utf8") === "--") {
      break;
    }
    const headerStart = afterBoundary + 2;
    const headerEnd = data.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) {
      break;
    }
    const nextBoundary = data.indexOf(Buffer.from(`\r\n--${boundaryMatch[1]}`), headerEnd + 4);
    if (nextBoundary < 0) {
      break;
    }
    parts.push({
      headers: data.subarray(headerStart, headerEnd).toString("utf8"),
      body: data.subarray(headerEnd + 4, nextBoundary)
    });
    offset = nextBoundary + 2;
  }
  const manifestPart = parts.find((part) => /name="manifest"/iu.test(part.headers));
  const packPart = parts.find((part) => /name="packfile"/iu.test(part.headers));
  if (!manifestPart || !packPart) {
    throw new Error("Pull response did not include manifest and packfile parts.");
  }
  return {
    manifest: JSON.parse(manifestPart.body.toString("utf8")),
    packfile: packPart.body
  };
}

function requireDesktopVaultPath(adapter) {
  if (adapter && typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }
  throw new Error("obts Phase 1 requires the desktop FileSystemAdapter.");
}

async function ensureAdapterDir(adapter, dir) {
  if (!dir || dir === ".") {
    return;
  }
  const segments = dir.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await adapter.mkdir(current);
    } catch {
      // Directory may already exist.
    }
  }
}

function materializationConflictFiles(targetFiles, localVaultFiles) {
  const conflicts = new Set();
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
  return Array.from(conflicts).sort();
}

function directoryPrefixes(filePath) {
  const segments = filePath.split("/");
  const prefixes = [];
  for (let index = 1; index < segments.length; index += 1) {
    prefixes.push(segments.slice(0, index).join("/"));
  }
  return prefixes;
}

async function writeTextSnapshotPatch(bundleDir, filePath, content) {
  const patchPath = path.join(bundleDir, "patches", `${filePath.replaceAll("/", "__")}.patch`);
  await fsp.mkdir(path.dirname(patchPath), { recursive: true, mode: 0o700 });
  const body = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    "@@ -0,0 +1 @@",
    ...content.toString("utf8").split("\n").map((line) => `+${line}`)
  ].join("\n");
  await fsp.writeFile(patchPath, `${body}\n`, { mode: 0o600 });
}

async function bundleChecksums(bundleDir) {
  const entries = [];
  await walkBundleFiles(bundleDir, async (absolutePath) => {
    const relativePath = normalizePath(path.relative(bundleDir, absolutePath));
    if (relativePath === "checksums.sha256") {
      return;
    }
    entries.push(`${sha256(await fsp.readFile(absolutePath))}  ${relativePath}`);
  });
  return entries.sort();
}

async function walkBundleFiles(root, visitFile) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkBundleFiles(absolutePath, visitFile);
    } else if (entry.isFile()) {
      await visitFile(absolutePath);
    }
  }
}

function isTextPatchPath(filePath) {
  return new Set([".md", ".canvas", ".base", ".json", ".css", ".txt", ".yaml", ".yml"]).has(path.posix.extname(filePath).toLowerCase());
}

function isSyncableVaultPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!isValidVaultPath(normalized)) {
    return false;
  }
  if (isOsOrEditorMetadata(normalized)) {
    return false;
  }
  if (normalized === ".obsidian/workspace.json" || normalized === ".obsidian/workspace-mobile.json") {
    return false;
  }
  if (normalized === ".obsidian/cache" || normalized.startsWith(".obsidian/cache/")) {
    return false;
  }
  if (normalized === ".obsidian/plugins/obts" || normalized.startsWith(".obsidian/plugins/obts/")) {
    return false;
  }
  return true;
}

function isRecoverableApplyPath(filePath) {
  return isSyncableVaultPath(filePath) || (filePath !== ".obts" && !filePath.startsWith(".obts/") && filePath !== ".git" && !filePath.startsWith(".git/") && !filePath.includes("/.git/"));
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\/+/u, "").normalize("NFC");
}

function isValidVaultPath(filePath) {
  if (!filePath || filePath.startsWith("../") || path.posix.isAbsolute(filePath) || /^[A-Za-z]:\//u.test(filePath)) {
    return false;
  }
  if (filePath.includes("\0") || /[\u0000-\u001f\u007f]/u.test(filePath) || filePath.length > 4096) {
    return false;
  }
  const segments = filePath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || /[<>:"|?*]/u.test(segment) || segment.endsWith(" ") || segment.endsWith(".")) {
      return false;
    }
    const withoutExtension = (segment.split(".")[0] || "").toLowerCase();
    if (WINDOWS_RESERVED.has(withoutExtension)) {
      return false;
    }
  }
  return segments[0] !== ".obts" && !segments.includes(".git");
}

function assertValidLocalVaultPath(filePath) {
  if (!isValidVaultPath(filePath)) {
    throw new ObtsBlockedError("invalid_path", "Vault path is invalid or cannot be synced.");
  }
}

function isOsOrEditorMetadata(filePath) {
  const basename = filePath.split("/").at(-1) || filePath;
  return basename === ".DS_Store" || basename === "Thumbs.db" || basename.endsWith("~") || basename.endsWith(".swp") || basename.endsWith(".tmp");
}

function assertNoCaseCollisions(paths) {
  const seen = new Map();
  for (const filePath of paths) {
    const key = filePath.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = seen.get(key);
    if (existing !== undefined && existing !== filePath) {
      throw new ObtsBlockedError("path_collision", "Vault paths collide on case-insensitive filesystems.");
    }
    seen.set(key, filePath);
  }
  return paths;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function blockStatusLabel(code) {
  if (code === "conflict_review_required") {
    return "Review needed";
  }
  if (code === "replace_local_with_server_required" || code === "device_blocked" || code === "stale_device_ref" || code === "same_device_non_fast_forward" || code === "local_state_incomplete") {
    return "Needs recovery";
  }
  if (code === "initial_import_confirmation_required") {
    return "Blocked";
  }
  return "Unsafe local state";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, filePath);
}

async function exists(filePath) {
  try {
    await fsp.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}
