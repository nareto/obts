const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_VERSION = "2026-06-29.phase1";
const PLUGIN_VERSION = "0.1.0-phase1";
const NOTE_EXTENSIONS = new Set([".md", ".canvas", ".base"]);
const ATTACHMENT_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm",
  ".3gp",
  ".mkv",
  ".mov",
  ".mp4",
  ".ogv",
  ".pdf"
]);
const OBSIDIAN_ALLOWLIST = new Set([
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/backlinks.json",
  ".obsidian/bookmarks.json",
  ".obsidian/command-palette.json",
  ".obsidian/core-plugins.json",
  ".obsidian/core-plugins-migration.json",
  ".obsidian/daily-notes.json",
  ".obsidian/editor.json",
  ".obsidian/graph.json",
  ".obsidian/hotkeys.json",
  ".obsidian/outgoing-link.json",
  ".obsidian/page-preview.json",
  ".obsidian/properties.json",
  ".obsidian/switcher.json",
  ".obsidian/templates.json",
  ".obsidian/types.json"
]);
const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:3000",
  pairingToken: "",
  deviceName: "",
  syncProfile: "notes_only",
  syncPlugins: false,
  autoSync: false,
  syncIntervalSeconds: 60,
  gitBinary: "git"
};

module.exports = class ObtsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

    this.registerEvent(this.app.vault.on("create", () => this.queueSyncFromWatcher()));
    this.registerEvent(this.app.vault.on("modify", () => this.queueSyncFromWatcher()));
    this.registerEvent(this.app.vault.on("delete", () => this.queueSyncFromWatcher()));
    this.registerEvent(this.app.vault.on("rename", () => this.queueSyncFromWatcher()));

    if (this.settings.autoSync) {
      this.registerInterval(
        window.setInterval(() => {
          void this.runQueuedSync();
        }, Math.max(15, this.settings.syncIntervalSeconds) * 1000)
      );
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  setStatus(label) {
    if (this.status) {
      this.status.setText(`obts: ${label || "Checking"}`);
    }
  }

  queueSyncFromWatcher() {
    if (this.isApplying) {
      return;
    }
    this.syncQueued = true;
    this.setStatus("Ahead");
    void this.client.recordLocalChangeHint().catch(() => undefined);
    if (this.settings.autoSync) {
      window.setTimeout(() => {
        void this.runQueuedSync();
      }, 1500);
    }
  }

  async runQueuedSync() {
    if (!this.syncQueued || this.syncRunning) {
      return;
    }
    this.syncQueued = false;
    await this.runUserAction(async () => {
      await this.client.syncOnce({ confirmInitialImport: false });
    }, false);
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
    await fsp.mkdir(path.join(this.gitdir, "info"), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(this.gitdir, "info", "exclude"), ".obts/\n.git/\n", { mode: 0o600 });
    const journal = await readJson(this.applyJournalPath, null);
    const state = await this.readState();
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
    const result = await postJson(this.url("/api/v1/pair/consume"), {
      pairing_token: pairingToken,
      device_name: this.plugin.settings.deviceName || "Obsidian device",
      sync_profile: this.plugin.settings.syncProfile,
      sync_plugins: this.plugin.settings.syncPlugins
    });
    await this.initialize();
    await writeJson(this.authPath, { device_token: result.device_token, created_at: nowIso() });
    await this.writeState({
      user_id: result.user_id,
      vault_id: result.vault_id,
      device_id: result.device_id,
      device_ref: result.device_ref,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: "Checking",
      last_error_code: null,
      updated_at: nowIso()
    });

    const pulled = await this.pull(result.vault_id, result.device_id, result.device_token, null);
    await this.importPack(pulled.packfile);
    const localFiles = await this.scanSyncableFiles();
    const serverFiles = await this.listTreeFiles(pulled.manifest.target_main);
    const localAlreadyMatchesServer =
      localFiles.length > 0 && serverFiles.length > 0
        ? await this.localContentMatchesTree(localFiles, pulled.manifest.target_main)
        : false;
    const divergentLocalContent =
      localFiles.length > 0 &&
      !localAlreadyMatchesServer &&
      (!result.is_first_device || serverFiles.length > 0);
    if (divergentLocalContent) {
      await this.createRecoveryBundle("replace_local_with_server", pulled.manifest.target_main, localFiles);
      await this.writeQueue({ pending_commit: null, expected_device_ref: null, status: "blocked_recovery", attempts: 0, updated_at: nowIso() });
      await this.block("replace_local_with_server_required", "Local content differs from server main. Use Replace local with server state after reviewing the recovery bundle.");
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
    this.throwIfBlocked(state);

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

  async recordLocalChangeHint() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id || state.last_error_code) {
      return;
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
    this.throwIfBlocked(state);
    const token = await this.readDeviceToken();
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main);
    await this.importPack(pulled.packfile);
    await this.applyTargetMain(pulled.manifest.target_main, pulled.manifest.changed_paths, allowDestructive);
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }
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
      const affectedPaths = Array.from(affected).filter((filePath) => isRecoverableApplyPath(filePath, this.plugin.settings)).sort();
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
      for (const filePath of affectedPaths.filter((candidate) => !targetFiles.has(candidate)).sort((left, right) => right.length - left.length)) {
        await this.adapterRemove(filePath);
      }
      for (const filePath of affectedPaths.filter((candidate) => targetFiles.has(candidate))) {
        const content = await this.readBlob(targetMain, filePath);
        await this.adapterWriteBinary(filePath, content);
      }

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
      if (isSyncableVaultPath(filePath, this.plugin.settings) && !localSet.has(filePath)) {
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
    const result = [];
    await walk(this.vaultDir, async (absolutePath) => {
      const rel = normalizePath(path.relative(this.vaultDir, absolutePath));
      if (isSyncableVaultPath(rel, this.plugin.settings)) {
        result.push(rel);
      }
    });
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

  async createRecoveryBundle(operationType, targetMain, affectedPaths, journal = null) {
    const state = await this.readState();
    const bundleId = `rec_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    const bundleDir = path.join(this.obtsDir, "recovery", bundleId);
    await fsp.mkdir(path.join(bundleDir, "files"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(bundleDir, "git"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(bundleDir, "journal"), { recursive: true, mode: 0o700 });
    for (const filePath of affectedPaths) {
      if (filePath.startsWith(".obts/")) {
        continue;
      }
      const content = await this.adapterReadBinary(filePath);
      if (content) {
        const target = path.join(bundleDir, "files", filePath);
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fsp.writeFile(target, content, { mode: 0o600 });
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
      plugin_version: PLUGIN_VERSION
    };
    await writeJson(path.join(bundleDir, "manifest.json"), manifest);
    if (journal) {
      await writeJson(path.join(bundleDir, "journal", "apply-journal.json"), journal);
    }
    const pack = await this.createRecoveryRefsPack();
    await fsp.writeFile(path.join(bundleDir, "git", "local-refs.pack"), pack, { mode: 0o600 });
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
    return output.split("\0").filter(Boolean).filter((filePath) => isSyncableVaultPath(filePath, this.plugin.settings)).sort();
  }

  async readBlob(commit, filePath) {
    return await this.gitBuffer(["show", `${commit}:${filePath}`], undefined, { maxBuffer: 512 * 1024 * 1024 });
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
    return await readJson(this.statePath, {
      user_id: null,
      vault_id: null,
      device_id: null,
      device_ref: null,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: "Checking",
      last_error_code: null,
      updated_at: nowIso()
    });
  }

  async writeState(state) {
    await writeJson(this.statePath, state);
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
      await this.adapter.remove(filePath);
    } catch {
      await fsp.rm(path.join(this.vaultDir, filePath), { recursive: true, force: true });
    }
  }

  async adapterSha256(filePath) {
    const data = await this.adapterReadBinary(filePath);
    return data ? sha256(data) : null;
  }

  url(route) {
    return `${this.plugin.settings.serverUrl.replace(/\/+$/u, "")}${route}`;
  }

  throwIfBlocked(state) {
    if (state.last_error_code) {
      throw new ObtsBlockedError(state.last_error_code, "Sync is blocked until recovery or review completes.");
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

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian True Sync" });

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Pairing token")
      .addText((text) =>
        text.setValue(this.plugin.settings.pairingToken).onChange(async (value) => {
          this.plugin.settings.pairingToken = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Device name")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync profile")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("notes_only", "Notes only")
          .addOption("notes_plus_attachments", "Notes plus attachments")
          .addOption("full_vault_config", "Full vault config")
          .setValue(this.plugin.settings.syncProfile)
          .onChange(async (value) => {
            this.plugin.settings.syncProfile = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync community plugin settings")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPlugins).onChange(async (value) => {
          this.plugin.settings.syncPlugins = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Automatic sync")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

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

class ObtsBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class ObtsTransportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
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
  try {
    const body = await response.json();
    code = body.error && body.error.code ? body.error.code : code;
    message = body.error && body.error.message ? body.error.message : message;
  } catch {
    // Keep status-only transport errors redacted.
  }
  throw new ObtsTransportError(response.status, code, message);
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

async function walk(root, visitFile) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".obts" || entry.name === ".git") {
      continue;
    }
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, visitFile);
    } else if (entry.isFile()) {
      await visitFile(absolutePath);
    }
  }
}

function isSyncableVaultPath(filePath, settings) {
  const normalized = normalizePath(filePath);
  if (!isValidVaultPath(normalized)) {
    return false;
  }
  const firstSegment = normalized.split("/")[0] || "";
  const extension = path.posix.extname(normalized).toLowerCase();
  if (firstSegment === ".trash" || isOsOrEditorMetadata(normalized)) {
    return false;
  }
  if (firstSegment === ".obsidian") {
    if (normalized.startsWith(".obsidian/plugins/")) {
      return settings.syncProfile === "full_vault_config" && Boolean(settings.syncPlugins) && !normalized.startsWith(".obsidian/plugins/obts/");
    }
    if (settings.syncProfile !== "full_vault_config") {
      return false;
    }
    if (normalized.startsWith(".obsidian/snippets/") && normalized.endsWith(".css")) {
      return true;
    }
    return OBSIDIAN_ALLOWLIST.has(normalized);
  }
  if (NOTE_EXTENSIONS.has(extension)) {
    return true;
  }
  if (settings.syncProfile === "notes_only") {
    return false;
  }
  return ATTACHMENT_EXTENSIONS.has(extension);
}

function isRecoverableApplyPath(filePath, settings) {
  return isSyncableVaultPath(filePath, settings) || (!filePath.startsWith(".obts/") && !filePath.startsWith(".git/"));
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
  if (code === "replace_local_with_server_required" || code === "device_blocked" || code === "stale_device_ref" || code === "same_device_non_fast_forward") {
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
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
