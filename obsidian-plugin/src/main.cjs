const obtsRuntime = globalThis.__OBTS_CLIENT_RUNTIME__ || require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, requestUrl, apiVersion } = obtsRuntime;
const { Buffer } = require("buffer");
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
const git = require("isomorphic-git");
const path = require("path-browserify");
const createSha = require("sha.js");
const { createDataAdapterFs, createPackIndexFs, createReadOverlayFs } = require("./data-adapter-fs.cjs");
const { installPathMutationGate } = require("./path-mutation-gate.cjs");
const { createByteBudget, runBoundedWork } = require("./work-pool.cjs");
const { blobSizeFromGit } = require("./blob-size-reader.cjs");
const { createRootIgnorePolicy, MAX_ROOT_IGNORE_BYTES } = require("../../src/shared/rootIgnore.cjs");

const API_VERSION = obtsRuntime.obtsApiVersion || "__OBTS_API_VERSION__";
const PLUGIN_VERSION = obtsRuntime.obtsPluginVersion || "__OBTS_PLUGIN_VERSION__";
const SYNC_DEBOUNCE_MS = 1500;
const BACKGROUND_SYNC_INTERVAL_MS = 10 * 1000;
const STALE_SETTLE_MARGIN_MS = 250;
const PERIODIC_INVENTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PERIODIC_FULL_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MIGRATED_FULL_AUDIT_DELAY_MS = 24 * 60 * 60 * 1000;
const SCANNER_SCHEMA_VERSION = 1;
const AUTOMATIC_RETRY_MAX_MS = 5 * 60 * 1000;
const OPERATION_STATUS_HEARTBEAT_MS = 30 * 1000;
const STATUS_LAG_NOTICE_DELAY_MS = 30 * 1000;
const STATUS_NOTICE_DURATION_MS = 15 * 1000;
const INITIALIZATION_STALL_DIAGNOSTIC_MS = 30 * 1000;
const MOBILE_PACK_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DESKTOP_FILE_WORK_CONCURRENCY = 4;
const MOBILE_FILE_WORK_CONCURRENCY = 2;
const DESKTOP_FILE_BUFFER_BUDGET_BYTES = 64 * 1024 * 1024;
const MOBILE_FILE_BUFFER_BUDGET_BYTES = 16 * 1024 * 1024;
const FILE_WORK_YIELD_EVERY = 25;
const FILE_PROGRESS_INTERVAL_MS = 250;
const MOBILE_PACK_READ_ATTEMPTS = 5;
const MOBILE_PACK_READ_RETRY_MS = 100;
const RETIRED_OPERATION_GRACE_MS = 1500;
const REF_LOCK_STALE_MS = 30 * 1000;
const PLUGIN_UPDATE_URL = "obsidian://brat?plugin=nareto%2Fobts";
const DIAGNOSTIC_CONSENT_VERSION = 2;
const TROUBLESHOOTING_DEDUP_MS = 15 * 60 * 1000;
const DIAGNOSTIC_FAILURE_COOLDOWN_MS = 60 * 1000;
const DIAGNOSTIC_CONTEXT = Symbol("obtsDiagnosticContext");

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:3000",
  deviceName: "",
  shareErrorDiagnostics: false,
  diagnosticConsentServer: "",
  diagnosticConsentVersion: 0
};

module.exports = class ObtsPlugin extends Plugin {
  async onload() {
    this.syncQueued = false;
    this.syncRunning = false;
    this.transientSyncFailures = 0;
    this.automaticRetryNotBefore = 0;
    this.lastCheckingProgressAt = 0;
    this.isApplying = false;
    this.pluginCompatibilityNoticeKey = null;
    this.pluginUpdateUrl = PLUGIN_UPDATE_URL;
    this.unloaded = false;
    this.lifecycleAbortController = new AbortController();
    this.queuedSyncTimer = null;
    this.staleSettleTimer = null;
    this.staleSettleAt = null;
    this.pendingWatcherPaths = new Set();
    this.retiredOperationTimer = null;
    this.observedRetiredLease = null;
    this.retiredOperationNoticeShown = false;
    this.clientReady = false;
    this.clientInitialization = null;
    this.initializationStage = null;
    this.initializationStageStartedAt = null;
    this.initializationDiagnosticPoint = null;
    this.initializationDiagnosticToken = null;
    this.initializationWatchdogTimer = null;
    this.reportedInitializationStalls = new Set();
    this.activeOperationDiagnosticPoint = null;
    this.activeOperationProgressLabel = null;
    this.activeOperationSlow = false;
    this.operationWatchdogTimer = null;
    this.operationSlowTimer = null;
    this.operationStatusHeartbeatTimer = null;
    this.operationStatusHeartbeatInFlight = false;
    this.reportedOperationStalls = new Set();
    this.activeMeasuredPhase = null;
    this.layoutStarted = false;
    this.reportedDiagnosticErrors = new WeakSet();
    this.diagnosticRetryAfter = new Map();
    this.failedTroubleshootingTransitions = new Map();
    this.reportedTroubleshootingTransitions = new Map();
    this.pendingTroubleshootingTransitions = new Map();
    this.manualTroubleshootingInFlight = null;
    this.diagnosticNoticeShown = false;
    this.deviceNameRevision = 0;
    this.currentStatusLabel = null;
    this.statusNeedsRecoveryNotice = false;
    this.degradedStatusTimer = null;
    this.degradedStatusBase = null;
    this.degradedStatusNotifiedBase = null;
    try {
      this.pathMutationGate = installPathMutationGate(this.app.vault.adapter, this);
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
      if (this.unloaded) return;
      delete this.settings.syncProfile;
      delete this.settings.syncPlugins;
      delete this.settings.pairingToken;
      delete this.settings.gitBinary;
      if (this.settings.shareErrorDiagnostics && !this.diagnosticSharingEnabled()) {
        this.settings.shareErrorDiagnostics = false;
        this.settings.diagnosticConsentServer = "";
        this.settings.diagnosticConsentVersion = 0;
        await this.saveData(this.settings);
      }
      if (this.unloaded) return;
      this.status = this.addStatusBarItem();
      this.mobileStatus = null;
      if (this.status) {
        if (this.status.classList) this.status.classList.add("obts-status");
        if (typeof this.status.setAttribute === "function") {
          this.status.setAttribute("role", "button");
          this.status.setAttribute("tabindex", "0");
        }
        if (typeof this.registerDomEvent === "function") {
          this.registerDomEvent(this.status, "click", () => this.handleStatusClick());
          this.registerDomEvent(this.status, "keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            this.handleStatusClick();
          });
        }
      }
      if (Platform && Platform.isMobile && typeof this.addRibbonIcon === "function") {
        this.mobileStatus = this.addRibbonIcon("refresh-cw", "obts sync status", () => this.handleStatusClick());
        if (this.mobileStatus && this.mobileStatus.classList) this.mobileStatus.classList.add("obts-ribbon-status");
      }
      this.setStatus("Checking");
      await this.pathMutationGate.ready;
      if (this.unloaded) return;
      this.client = new ObtsObsidianClient(this);

      this.settingTab = new ObtsSettingTab(this.app, this);
      this.addSettingTab(this.settingTab);

      this.addCommand({
        id: "obts-setup-sync",
        name: "Set up sync",
        callback: async () => {
          if (!(await this.ensureClientReady())) {
            new Notice(`obts: ${this.syncBlockedMessage()}`, 15000);
            return;
          }
          new ObtsOnboardingModal(this.app, this).open();
        }
      });

      this.addCommand({
        id: "obts-sync-once",
        name: "Sync once",
        callback: async () => {
          const result = await this.runUserAction(() => this.syncOnceOrPollResolvedConflict({ confirmInitialImport: false }));
          if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
        }
      });

      this.addCommand({
        id: "obts-recover-upload-checkpoint",
        name: "Recover upload checkpoint",
        callback: async () => {
          const result = await this.runUserAction(() => this.client.recoverUploadCheckpoint(), true, "Recovering upload checkpoint");
          if (result) new Notice(`obts: ${result.status}`);
        }
      });

      this.addCommand({
        id: "obts-verify-local-vault",
        name: "Verify local vault contents",
        callback: async () => {
          const result = await this.runUserAction(
            () => this.syncOnceOrPollResolvedConflict({ confirmInitialImport: false, fullAudit: true }),
            true,
            "Verifying local vault"
          );
          if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
        }
      });

      this.addCommand({
        id: "obts-replace-local-with-server",
        name: "Replace local with server state",
        callback: async () => {
          const result = await this.runUserAction(() => this.client.replaceLocalWithServer(), true, "Replacing local vault");
          if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
        }
      });

      this.addCommand({
        id: "obts-rebuild-from-server-main",
        name: "Rebuild from server main",
        callback: async () => {
          const result = await this.runUserAction(() => this.client.rebuildFromServerMain(), true, "Rebuilding from server");
          if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
        }
      });

      this.addCommand({
        id: "obts-send-troubleshooting-snapshot",
        name: "Send troubleshooting snapshot now",
        callback: async () => {
          await this.sendTroubleshootingSnapshotNow();
        }
      });

      this.addCommand({
        id: "obts-update-plugin-via-brat",
        name: "Update plugin with BRAT",
        callback: () => {
          window.open(this.pluginUpdateUrl || PLUGIN_UPDATE_URL);
        }
      });

      this.addCommand({
        id: "obts-reset-local-pairing-state",
        name: "Reset local pairing state",
        callback: async () => {
          const result = await this.runUserAction(async () => {
            if (!window.confirm("Reset local obts pairing state? This removes local sync credentials after writing a recovery bundle when local files exist. Re-pair this device afterwards.")) {
              return;
            }
            return await this.client.resetLocalPairingState();
          }, true, "Resetting local pairing");
          if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
        }
      });

      const start = () => this.startAfterLayoutReady();
      if (this.app.workspace && typeof this.app.workspace.onLayoutReady === "function") {
        this.app.workspace.onLayoutReady(start);
      } else {
        window.setTimeout(start, 0);
      }

      this.registerInterval(
        window.setInterval(() => {
          void this.runBackgroundSync();
        }, BACKGROUND_SYNC_INTERVAL_MS)
      );
      if (typeof this.registerDomEvent === "function" && typeof document !== "undefined") {
        this.registerDomEvent(document, "visibilitychange", () => {
          if (!document.hidden) void this.runBackgroundSync();
        });
      }
    } catch (error) {
      this.unloaded = true;
      this.lifecycleAbortController.abort();
      this.retirePathMutationGate();
      throw error;
    }
  }

  startAfterLayoutReady() {
    if (this.unloaded || this.layoutStarted) return;
    this.layoutStarted = true;
    this.registerEvent(this.app.vault.on("create", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.queueSyncFromWatcher([file && file.path, oldPath])));
    if (this.operationAvailability() === "available") {
      void this.initializeClient().catch((error) => this.handleClientInitializationFailure(error));
    } else {
      this.observeRetiredOperation();
    }
  }

  retirePathMutationGate() {
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (operationLeaseOwner(lease) === this && lease && lease.owner) lease.retiring = true;
    // Retiring apply/recovery still needs exclusion through its final mutation.
    const gate = this.pathMutationGate;
    if (gate) {
      if (operationLeaseOwner(lease) === this && lease.completion) {
        void lease.completion.then(() => gate.release());
      } else gate.release();
    }
  }

  onunload() {
    this.unloaded = true;
    this.lifecycleAbortController?.abort();
    this.retirePathMutationGate();
    if (this.queuedSyncTimer !== null) {
      window.clearTimeout(this.queuedSyncTimer);
      this.queuedSyncTimer = null;
    }
    this.clearStaleSettleTimer();
    if (this.retiredOperationTimer !== null) {
      window.clearTimeout(this.retiredOperationTimer);
      this.retiredOperationTimer = null;
    }
    this.clearInitializationWatchdog();
    this.initializationDiagnosticToken = null;
    if (this.settingTab) this.settingTab.clearOperationRefreshTimer();
    this.clearOperationProgress();
    this.clearDegradedStatusTimer();
  }

  async initializeClient() {
    if (this.clientReady) return;
    if (!this.clientInitialization) {
      this.clientInitialization = (async () => {
        if (this.unloaded || !this.beginSync("Initializing obts")) {
          throw new ObtsBlockedError("sync_lease_blocked", this.syncBlockedMessage());
        }
        let completed = false;
        try {
          this.setInitializationStage("Starting local state checks", null);
          await this.prepareInitializationDiagnosticAuth();
          await this.client.initialize();
          this.setInitializationStage("Finalizing local sync status", "startup_state");
          const readyState = await this.client.readState();
          if (!this.unloaded) {
            this.clientReady = true;
            this.clearInitializationWatchdog();
            this.initializationStage = null;
            this.initializationStageStartedAt = null;
            this.initializationDiagnosticPoint = null;
            this.initializationDiagnosticToken = null;
            this.setStatus(readyState.status_label);
            completed = true;
          }
        } finally {
          this.endSync(completed);
        }
      })();
    }
    try {
      await this.clientInitialization;
    } finally {
      this.clientInitialization = null;
    }
  }

  handleClientInitializationFailure(error = null) {
    if (this.unloaded) return;
    this.clearInitializationWatchdog();
    this.initializationDiagnosticToken = null;
    this.clientReady = false;
    this.setStatus("Recovery required");
    if (error) void this.reportDeviceError(error);
    new Notice("obts could not finish local recovery after the plugin update. Fully restart Obsidian, then open obts settings.", 15000);
  }

  async ensureClientReady() {
    if (this.unloaded) return false;
    if (this.clientReady) return true;
    if (this.clientInitialization) {
      try {
        await this.clientInitialization;
        return this.clientReady;
      } catch (error) {
        this.handleClientInitializationFailure(error);
        return false;
      }
    }
    if (this.operationAvailability() !== "available") {
      this.observeRetiredOperation();
      return false;
    }
    try {
      await this.initializeClient();
      return this.clientReady;
    } catch (error) {
      this.handleClientInitializationFailure(error);
      return false;
    }
  }

  setInitializationStage(label, diagnosticPoint) {
    this.initializationStage = label;
    this.initializationStageStartedAt = Date.now();
    this.initializationDiagnosticPoint = diagnosticPoint;
    this.updateOwnedOperationDetails(label, diagnosticPoint, {}, true, true);
    this.clearInitializationWatchdog();
    if (!diagnosticPoint || this.reportedInitializationStalls.has(diagnosticPoint)) return;
    this.initializationWatchdogTimer = window.setTimeout(() => {
      this.initializationWatchdogTimer = null;
      if (
        this.unloaded ||
        this.clientReady ||
        !this.clientInitialization ||
        this.initializationDiagnosticPoint !== diagnosticPoint ||
        this.reportedInitializationStalls.has(diagnosticPoint) ||
        !this.diagnosticSharingEnabled() ||
        !this.initializationDiagnosticToken
      ) return;
      this.reportedInitializationStalls.add(diagnosticPoint);
      void this.reportInitializationStall(diagnosticPoint);
    }, INITIALIZATION_STALL_DIAGNOSTIC_MS);
  }

  updateInitializationProgress(label) {
    if (!this.clientInitialization) return;
    this.initializationStage = label;
    this.updateOwnedOperationDetails(label, this.initializationDiagnosticPoint);
  }

  updateOwnedOperationDetails(label, diagnosticPoint, changes = {}, markProgress = true, resetStage = false) {
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (!lease || operationLeaseOwner(lease) !== this || !lease.details) return;
    const now = Date.now();
    const nextPoint = diagnosticPoint || null;
    if (resetStage || lease.details.diagnosticPoint !== nextPoint) lease.details.stageStartedAt = now;
    if (typeof label === "string" && label.length > 0) lease.details.label = label;
    lease.details.diagnosticPoint = nextPoint;
    if (markProgress) lease.details.progressUpdatedAt = now;
    Object.assign(lease.details, changes);
  }

  resetOperationWatchdog(phase) {
    if (this.operationWatchdogTimer !== null) window.clearTimeout(this.operationWatchdogTimer);
    this.operationWatchdogTimer = null;
    if (!phase) return;
    phase.watchdogGeneration = (phase.watchdogGeneration || 0) + 1;
    const watchdogGeneration = phase.watchdogGeneration;
    this.operationWatchdogTimer = window.setTimeout(() => {
      if (this.unloaded || this.activeMeasuredPhase?.phaseId !== phase.phaseId || phase.watchdogGeneration !== watchdogGeneration || phase.stalled) return;
      this.operationWatchdogTimer = null;
      this.updateOwnedOperationDetails(this.activeOperationProgressLabel || phase.label, phase.point, { stalled: true }, false);
      phase.stalled = true;
      if (this.diagnosticSharingEnabled()) {
        void this.reportOperationStall({ ...phase, observation: "stalled", elapsedMs: Date.now() - phase.startedAt });
      }
    }, INITIALIZATION_STALL_DIAGNOSTIC_MS);
  }

  setOperationProgress(label, diagnosticPoint) {
    const phaseChanged = this.activeOperationDiagnosticPoint !== diagnosticPoint;
    const progressLabelChanged = this.activeOperationProgressLabel !== label;
    const previousPhase = phaseChanged ? this.activeMeasuredPhase : null;
    this.activeOperationDiagnosticPoint = diagnosticPoint || null;
    this.activeOperationProgressLabel = label;
    if (phaseChanged) {
      if (previousPhase?.stalled) {
        void this.reportOperationStall({ ...previousPhase, observation: "completed", elapsedMs: Date.now() - previousPhase.startedAt });
      }
      this.activeMeasuredPhase = diagnosticPoint ? { point: diagnosticPoint, label, phaseId: `dph_${randomHex(16)}`, startedAt: Date.now(), stalled: false, watchdogGeneration: 0 } : null;
      this.updateOwnedOperationDetails(label, diagnosticPoint, { stalled: false }, true, true);
      this.resetOperationWatchdog(this.activeMeasuredPhase);
    } else {
      if (this.activeMeasuredPhase) {
        this.activeMeasuredPhase.label = label;
        if (progressLabelChanged) this.resetOperationWatchdog(this.activeMeasuredPhase);
      }
      this.updateOwnedOperationDetails(label, diagnosticPoint, { stalled: false });
    }
    this.setStatus(this.activeOperationSlow ? `${label} (taking longer than expected)` : label);
  }

  scheduleOperationStatusHeartbeat() {
    if (this.operationStatusHeartbeatTimer !== null || !this.syncRunning) return;
    this.operationStatusHeartbeatTimer = window.setTimeout(() => {
      this.operationStatusHeartbeatTimer = null;
      if (this.unloaded || !this.syncRunning) return;
      if (!this.operationStatusHeartbeatInFlight) {
        this.operationStatusHeartbeatInFlight = true;
        void this.client.reportDeviceStatus()
          .catch(() => undefined)
          .finally(() => {
            this.operationStatusHeartbeatInFlight = false;
            this.scheduleOperationStatusHeartbeat();
          });
        return;
      }
      this.scheduleOperationStatusHeartbeat();
    }, OPERATION_STATUS_HEARTBEAT_MS);
  }

  clearOperationStage() {
    if (this.operationWatchdogTimer !== null) {
      window.clearTimeout(this.operationWatchdogTimer);
      this.operationWatchdogTimer = null;
    }
    this.activeOperationDiagnosticPoint = null;
    this.activeOperationProgressLabel = null;
    this.activeMeasuredPhase = null;
  }

  clearOperationProgress() {
    this.clearOperationStage();
    if (this.operationSlowTimer !== null) {
      window.clearTimeout(this.operationSlowTimer);
      this.operationSlowTimer = null;
    }
    if (this.operationStatusHeartbeatTimer !== null) {
      window.clearTimeout(this.operationStatusHeartbeatTimer);
      this.operationStatusHeartbeatTimer = null;
    }
    this.activeOperationSlow = false;
  }

  clearInitializationWatchdog() {
    if (this.initializationWatchdogTimer !== null) {
      window.clearTimeout(this.initializationWatchdogTimer);
      this.initializationWatchdogTimer = null;
    }
  }

  async prepareInitializationDiagnosticAuth() {
    this.initializationDiagnosticToken = null;
    if (!this.diagnosticSharingEnabled()) return;
    try {
      const state = await this.client.readPrimaryState() || await this.client.readBackupState();
      if (!state || !state.vault_id || !state.device_id) return;
      this.initializationDiagnosticToken = await this.client.readDeviceToken();
    } catch {
      // Startup diagnostics remain best effort and never change recovery.
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async updateServerUrl(value) {
    const previous = normalizedServerDestination(this.settings.serverUrl);
    const nextValue = value.trim();
    const next = normalizedServerDestination(nextValue);
    this.settings.serverUrl = nextValue;
    if (previous !== next || (this.settings.shareErrorDiagnostics && this.settings.diagnosticConsentServer !== next)) {
      this.settings.shareErrorDiagnostics = false;
      this.settings.diagnosticConsentServer = "";
      this.settings.diagnosticConsentVersion = 0;
    }
    await this.saveSettings();
  }

  async setDiagnosticSharing(enabled) {
    const destination = normalizedServerDestination(this.settings.serverUrl);
    if (enabled && !destination) {
      this.settings.shareErrorDiagnostics = false;
      await this.saveSettings();
      throw new Error("Enter a valid server URL before sharing error diagnostics.");
    }
    this.settings.shareErrorDiagnostics = Boolean(enabled);
    this.settings.diagnosticConsentServer = enabled ? destination : "";
    this.settings.diagnosticConsentVersion = enabled ? DIAGNOSTIC_CONSENT_VERSION : 0;
    await this.saveSettings();
  }

  diagnosticSharingEnabled() {
    const destination = normalizedServerDestination(this.settings.serverUrl);
    return Boolean(
      this.settings.shareErrorDiagnostics &&
      destination &&
      this.settings.diagnosticConsentServer === destination &&
      this.settings.diagnosticConsentVersion === DIAGNOSTIC_CONSENT_VERSION
    );
  }

  async reportOnboardingError(error, connection) {
    await this.reportErrorDiagnostic(error, connection ? {
      kind: "connection",
      connectionId: connection.connection_id,
      token: connection.connection_secret
    } : null);
  }

  async reportDeviceError(error) {
    await this.reportErrorDiagnostic(error, null);
  }

  async reportErrorDiagnostic(error, connectionAuth) {
    if (this.unloaded || !this.diagnosticSharingEnabled()) return;
    const consentDestination = this.settings.diagnosticConsentServer;
    if (error && typeof error === "object") {
      if (this.reportedDiagnosticErrors.has(error)) return;
      this.reportedDiagnosticErrors.add(error);
    }
    const report = buildDiagnosticReport(error);
    let route;
    let token;
    try {
      const state = await this.client.readState();
      if (state.vault_id && state.device_id) {
        token = await this.client.readDeviceToken();
        route = "/api/v1/device/diagnostic-events";
      } else if (connectionAuth && connectionAuth.kind === "connection" && connectionAuth.connectionId && connectionAuth.token) {
        token = connectionAuth.token;
        route = `/api/v1/connections/${connectionAuth.connectionId}/diagnostic-events`;
      } else {
        return;
      }
      if (
        this.unloaded ||
        !this.diagnosticSharingEnabled() ||
        this.settings.diagnosticConsentServer !== consentDestination
      ) return;
      const { event_id: _eventId, ...safeSignature } = report;
      const signature = `${consentDestination}:${state.device_id || route}:${JSON.stringify(safeSignature)}`;
      if (Date.now() < (this.diagnosticRetryAfter.get(signature) || 0)) return;
      rememberDiagnosticDeadline(this.diagnosticRetryAfter, signature, DIAGNOSTIC_FAILURE_COOLDOWN_MS);
      const response = await fetchWithTimeout(`${consentDestination}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report)
      });
      if (response.ok) rememberDiagnosticDeadline(this.diagnosticRetryAfter, signature, TROUBLESHOOTING_DEDUP_MS);
      if (
        response.ok &&
        !this.unloaded &&
        this.diagnosticSharingEnabled() &&
        this.settings.diagnosticConsentServer === consentDestination &&
        !this.diagnosticNoticeShown
      ) {
        this.diagnosticNoticeShown = true;
        new Notice(`obts sent a sanitized error diagnostic to ${consentDestination}.`);
      }
    } catch {
      // Diagnostic delivery is best effort and never changes sync behavior.
    }
  }

  async sendTroubleshootingSnapshot(trigger, details = {}, manual = false) {
    if (this.unloaded || !this.diagnosticSharingEnabled()) {
      if (manual) new Notice("obts: Enable sanitized troubleshooting diagnostics for this server first.", 15000);
      return false;
    }
    const consentDestination = this.settings.diagnosticConsentServer;
    try {
      const context = await this.client.collectTroubleshootingContext(Object.assign({}, details, { trigger }));
      if (!context.paired) {
        if (manual) new Notice("obts: Pair this device before sending a troubleshooting snapshot.", 15000);
        return false;
      }
      const diagnosticState = await this.client.readPrimaryState();
      const signature = `${consentDestination}:${diagnosticState?.device_id || "unpaired"}:${troubleshootingTransitionSignature(context)}`;
      if (!manual && Date.now() < (this.failedTroubleshootingTransitions.get(signature) || 0)) return false;
      const lastSentAt = this.reportedTroubleshootingTransitions.get(signature) || 0;
      if (!manual && Date.now() - lastSentAt < TROUBLESHOOTING_DEDUP_MS) return false;
      if (!manual && this.pendingTroubleshootingTransitions.has(signature)) {
        return await this.pendingTroubleshootingTransitions.get(signature);
      }
      const delivery = (async () => {
        const token = await this.client.readDeviceToken();
        if (
          this.unloaded ||
          !this.diagnosticSharingEnabled() ||
          this.settings.diagnosticConsentServer !== consentDestination
        ) return false;
        const report = buildTroubleshootingDiagnostic(context);
        if (!manual) rememberDiagnosticDeadline(this.failedTroubleshootingTransitions, signature, DIAGNOSTIC_FAILURE_COOLDOWN_MS);
        const response = await fetchWithTimeout(`${consentDestination}/api/v1/device/diagnostic-events`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(report)
        });
        if (!response.ok) {
          if (manual) new Notice(await diagnosticRejectionNotice(response), 15000);
          return false;
        }
        this.failedTroubleshootingTransitions.delete(signature);
        this.reportedTroubleshootingTransitions.set(signature, Date.now());
        while (this.reportedTroubleshootingTransitions.size > 64) {
          this.reportedTroubleshootingTransitions.delete(this.reportedTroubleshootingTransitions.keys().next().value);
        }
        if (manual) {
          new Notice("obts: Sent a sanitized troubleshooting snapshot.");
        } else if (!this.diagnosticNoticeShown) {
          this.diagnosticNoticeShown = true;
          new Notice(`obts sent a sanitized troubleshooting diagnostic to ${consentDestination}.`);
        }
        return true;
      })();
      if (!manual) this.pendingTroubleshootingTransitions.set(signature, delivery);
      try {
        return await delivery;
      } finally {
        if (this.pendingTroubleshootingTransitions.get(signature) === delivery) {
          this.pendingTroubleshootingTransitions.delete(signature);
        }
      }
    } catch {
      if (manual) new Notice("obts: Troubleshooting snapshot unavailable; no diagnostic was sent.", 15000);
      return false;
    }
  }

  async sendTroubleshootingSnapshotNow() {
    if (this.manualTroubleshootingInFlight) return await this.manualTroubleshootingInFlight;
    this.manualTroubleshootingInFlight = this.sendTroubleshootingSnapshot("manual", {
      attemptId: this.client.activeReconciliation && this.client.activeReconciliation.attemptId || "none",
      phase: this.client.activeReconciliation && this.client.activeReconciliation.phase || "none",
      outcome: "observed"
    }, true);
    try {
      return await this.manualTroubleshootingInFlight;
    } finally {
      this.manualTroubleshootingInFlight = null;
    }
  }

  async reportOperationStall(phase) {
    if (this.unloaded || !this.diagnosticSharingEnabled()) return;
    const consentDestination = this.settings.diagnosticConsentServer;
    try {
      const state = await this.client.readState();
      if (!state.vault_id || !state.device_id || this.unloaded || !this.diagnosticSharingEnabled() || this.settings.diagnosticConsentServer !== consentDestination) return;
      const token = await this.client.readDeviceToken();
      if (!token || this.unloaded || !this.diagnosticSharingEnabled() || this.settings.diagnosticConsentServer !== consentDestination) return;
      const report = buildMeasuredPhaseDiagnostic(phase);
      if (this.unloaded || !this.diagnosticSharingEnabled() || this.settings.diagnosticConsentServer !== consentDestination) return;
      await fetchWithTimeout(`${consentDestination}/api/v1/device/diagnostic-events`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report)
      });
    } catch {
      // Phase telemetry must not alter or interrupt sync.
    }
  }

  async reportInitializationStall(diagnosticPoint) {
    if (
      this.unloaded ||
      !this.diagnosticSharingEnabled() ||
      !this.initializationDiagnosticToken
    ) return;
    const consentDestination = this.settings.diagnosticConsentServer;
    const token = this.initializationDiagnosticToken;
    const report = buildStalledOperationDiagnostic(diagnosticPoint);
    try {
      if (
        this.unloaded ||
        !this.diagnosticSharingEnabled() ||
        this.settings.diagnosticConsentServer !== consentDestination
      ) return;
      const response = await fetchWithTimeout(`${consentDestination}/api/v1/device/diagnostic-events`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report)
      });
      if (
        response.ok &&
        !this.unloaded &&
        this.diagnosticSharingEnabled() &&
        this.settings.diagnosticConsentServer === consentDestination &&
        !this.diagnosticNoticeShown
      ) {
        this.diagnosticNoticeShown = true;
        new Notice(`obts sent a sanitized stalled-operation diagnostic to ${consentDestination}.`);
      }
    } catch {
      // Stall reporting must not alter or interrupt recovery.
    }
  }

  handlePluginCompatibility(compatibility) {
    if (!compatibility || !compatibility.update_available) {
      return;
    }
    this.pluginUpdateUrl = compatibility.update_url || PLUGIN_UPDATE_URL;
    const noticeKey = `${compatibility.update_required}:${compatibility.recommended_version}`;
    if (this.pluginCompatibilityNoticeKey === noticeKey) {
      return;
    }
    this.pluginCompatibilityNoticeKey = noticeKey;
    const prefix = compatibility.update_required ? "obts plugin update required" : "obts plugin update available";
    new Notice(`${prefix}: ${compatibility.recommended_version}. Run “Update plugin with BRAT” from the command palette.`, 15000);
  }

  setStatus(label, options = {}) {
    const presentation = statusPresentation(label);
    const previousBase = statusBaseLabel(this.currentStatusLabel);
    this.currentStatusLabel = presentation.label;
    if (this.status) this.status.setText(`obts: ${presentation.label}`);
    for (const element of [this.status, this.mobileStatus]) {
      if (!element) continue;
      if (element.classList) {
        for (const tone of ["success", "active", "warning", "danger", "neutral"]) {
          element.classList.remove(`obts-status--${tone}`);
        }
        element.classList.add(`obts-status--${presentation.tone}`);
      }
      if (typeof element.setAttribute === "function") {
        element.setAttribute("title", presentation.title);
        element.setAttribute("aria-label", `obts sync status: ${presentation.label}. ${presentation.action}`);
        element.setAttribute("data-obts-status", presentation.base.toLowerCase().replace(/ /gu, "-"));
      }
    }
    this.handleStatusTransition(previousBase, presentation.base, options.notify !== false);
  }

  handleStatusTransition(previousBase, nextBase, notify) {
    const attentionMessage = statusAttentionMessage(nextBase);
    if (attentionMessage && previousBase !== nextBase) {
      this.statusNeedsRecoveryNotice = true;
      if (notify) new Notice(attentionMessage, STATUS_NOTICE_DURATION_MS);
    }
    if (nextBase === "Offline" || nextBase === "Behind") {
      this.scheduleDegradedStatusNotice(nextBase);
    } else if (isActiveTransferStatus(nextBase)) {
      this.clearDegradedStatusTimer();
    } else if (nextBase === "Synced" || nextBase === "Not paired" || isPersistentAttentionStatus(nextBase)) {
      this.clearDegradedStatusTimer();
      this.degradedStatusNotifiedBase = null;
    }
    if (nextBase === "Synced" && this.statusNeedsRecoveryNotice) {
      this.statusNeedsRecoveryNotice = false;
      new Notice("obts: Sync is healthy again.");
    } else if (nextBase === "Not paired") {
      this.statusNeedsRecoveryNotice = false;
    }
  }

  scheduleDegradedStatusNotice(base) {
    if (this.degradedStatusNotifiedBase === base) return;
    if (this.degradedStatusTimer !== null && this.degradedStatusBase === base) return;
    this.clearDegradedStatusTimer();
    if (this.degradedStatusNotifiedBase !== base) this.degradedStatusNotifiedBase = null;
    this.degradedStatusBase = base;
    const timer = window.setTimeout(() => {
      if (this.degradedStatusTimer !== timer || this.degradedStatusBase !== base) return;
      this.degradedStatusTimer = null;
      this.degradedStatusBase = null;
      const currentBase = statusBaseLabel(this.currentStatusLabel);
      if (this.unloaded || currentBase === "Synced" || currentBase === "Not paired" || isPersistentAttentionStatus(currentBase)) return;
      this.statusNeedsRecoveryNotice = true;
      this.degradedStatusNotifiedBase = base;
      const message = base === "Offline"
        ? "obts is still offline. Click the sync indicator to inspect settings."
        : "obts is still behind the server. Click the sync indicator to inspect status.";
      new Notice(message, STATUS_NOTICE_DURATION_MS);
    }, STATUS_LAG_NOTICE_DELAY_MS);
    this.degradedStatusTimer = timer;
  }

  clearDegradedStatusTimer() {
    if (this.degradedStatusTimer !== null) {
      window.clearTimeout(this.degradedStatusTimer);
      this.degradedStatusTimer = null;
    }
    this.degradedStatusBase = null;
  }

  handleStatusClick() {
    if (statusBaseLabel(this.currentStatusLabel) === "Conflict resolution needed") {
      const destination = normalizedServerDestination(this.settings.serverUrl);
      if (destination) {
        window.open(`${destination}/dashboard`);
        return;
      }
    }
    const settings = this.app && this.app.setting;
    if (!settings) return;
    if (typeof settings.open === "function") settings.open();
    if (typeof settings.openTabById === "function") settings.openTabById(this.manifest && this.manifest.id ? this.manifest.id : "obts");
  }

  queueSyncFromWatcher(paths) {
    this.syncQueued = true;
    for (const candidate of Array.isArray(paths) ? paths : [paths]) {
      if (typeof candidate === "string" && candidate.length > 0) this.pendingWatcherPaths.add(candidate);
    }
    // Persist watcher evidence immediately; the debounce controls scanning, not durability.
    void this.flushWatcherHints().catch((error) => this.reportDeviceError(error));
    if (!this.clientReady) return;
    if (!this.syncRunning && !isPersistentAttentionStatus(statusBaseLabel(this.currentStatusLabel))) this.setStatus("Checking");
    this.scheduleQueuedSync(SYNC_DEBOUNCE_MS);
  }

  async flushWatcherHints() {
    if (this.pendingWatcherPaths.size === 0) return;
    const paths = [...this.pendingWatcherPaths];
    this.pendingWatcherPaths.clear();
    try {
      await this.client.recordLocalChangeHint(paths);
    } catch (error) {
      for (const filePath of paths) this.pendingWatcherPaths.add(filePath);
      throw error;
    }
  }

  async syncOnceOrPollResolvedConflict(options) {
    await this.flushWatcherHints();
    const state = await this.client.readState();
    if (!isPersistentAttentionStatus(statusBaseLabel(state.status_label))) this.setStatus("Checking");
    if (state.last_error_code === "device_blocked") {
      return await this.client.reconcileDeviceBlocked();
    }
    if (state.last_error_code === "conflict_review_required") {
      return await this.client.pollRemoteEventsAndApply();
    }
    return await this.client.syncOnce(options);
  }

  scheduleQueuedSync(delay) {
    if (this.unloaded) return;
    if (this.queuedSyncTimer !== null) window.clearTimeout(this.queuedSyncTimer);
    this.queuedSyncTimer = window.setTimeout(() => {
      this.queuedSyncTimer = null;
      void this.runQueuedSync();
    }, delay);
  }

  // An apply leaves a short authoring horizon behind. Wake the background check
  // just after it elapses so an idle device settles it before the next edit.
  scheduleStaleProvenanceSettle() {
    if (this.unloaded || !this.clientReady || typeof this.client?.staleProvenanceSettleAt !== "function") return;
    void this.client.staleProvenanceSettleAt().then((at) => {
      if (this.unloaded || at === null) return;
      if (this.staleSettleTimer != null) {
        // The earlier wake re-arms for later horizons when its sync ends.
        if (this.staleSettleAt <= at) return;
        window.clearTimeout(this.staleSettleTimer);
      }
      this.staleSettleAt = at;
      this.staleSettleTimer = window.setTimeout(() => {
        this.staleSettleTimer = null;
        this.staleSettleAt = null;
        void this.runBackgroundSync();
      }, Math.max(0, at - Date.now()) + STALE_SETTLE_MARGIN_MS);
    }, () => undefined);
  }

  clearStaleSettleTimer() {
    if (this.staleSettleTimer != null) window.clearTimeout(this.staleSettleTimer);
    this.staleSettleTimer = null;
    this.staleSettleAt = null;
  }

  async runQueuedSync() {
    if (this.unloaded || !this.syncQueued || !(await this.ensureClientReady())) return;
    const retryDelay = this.automaticRetryNotBefore - Date.now();
    if (retryDelay > 0) {
      this.scheduleQueuedSync(retryDelay);
      return;
    }
    if (this.isSyncInProgress()) {
      this.scheduleQueuedSync(SYNC_DEBOUNCE_MS);
      return;
    }
    this.syncQueued = false;
    await this.runAutomaticSync();
    if (this.syncQueued) this.scheduleQueuedSync(0);
  }

  async flushOpenMarkdownEditorsToDisk() {
    const workspace = this.app && this.app.workspace;
    const vault = this.app && this.app.vault;
    if (!workspace || !vault || typeof workspace.getLeavesOfType !== "function" || typeof vault.read !== "function" || typeof vault.modify !== "function") {
      return [];
    }
    const flushed = [];
    for (const leaf of workspace.getLeavesOfType("markdown") || []) {
      const view = leaf && leaf.view;
      const file = view && view.file;
      const editor = view && view.editor;
      if (!file || typeof file.path !== "string" || !editor || typeof editor.getValue !== "function") {
        continue;
      }
      if (!isSyncableVaultPath(file.path)) {
        continue;
      }
      const editorText = editor.getValue();
      let diskText;
      try {
        diskText = await vault.read(file);
      } catch {
        continue;
      }
      if (editorText !== diskText) {
        await vault.modify(file, editorText);
        flushed.push(file.path);
      }
    }
    return flushed;
  }

  async runBackgroundSync() {
    if (!this.layoutStarted || this.unloaded || (typeof document !== "undefined" && document.hidden) || !(await this.ensureClientReady())) {
      return;
    }
    if (Date.now() < this.automaticRetryNotBefore) return;
    if (this.syncQueued) {
      await this.runQueuedSync();
      return;
    }
    if (this.isSyncInProgress()) {
      return;
    }
    const state = await this.client.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    if (
      state.last_error_code &&
      state.last_error_code !== "conflict_review_required" &&
      state.last_error_code !== "device_blocked" &&
      !isRetryableLocalError(state.last_error_code)
    ) {
      await this.client.reportDeviceStatus().catch(() => undefined);
      return;
    }
    const queue = await this.client.readQueue();
    const scanDecision = await this.client.backgroundScanDecision();
    if (queue.pending_commit || queue.status === "queued_local" || scanDecision.required) {
      await this.runAutomaticSync({ fullAudit: scanDecision.mode === "full" });
      return;
    }
    await this.runRemotePoll();
  }

  async runRemotePoll() {
    if (!this.beginSync("Checking server")) return;
    let completed = false;
    try {
      await this.client.pollRemoteEventsAndApply();
      this.clearTransientSyncFailures();
      this.setStatus((await this.client.readState()).status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
      completed = true;
    } catch (error) {
      completed = await this.handleAutomaticSyncError(error) === true;
    } finally {
      this.endSync(completed);
      if (this.syncQueued) this.scheduleQueuedSync(0);
    }
  }

  async runAutomaticSync(options = {}) {
    if (this.unloaded || (typeof document !== "undefined" && document.hidden) || !(await this.ensureClientReady()) || this.isSyncInProgress()) {
      return;
    }
    try { if (await this.client.readPendingOnboarding()) return; }
    catch (error) { if (error?.code === "onboarding_context_required") return; throw error; }
    if (!this.beginSync("Background sync")) return;
    let completed = false;
    try {
      const state = await this.client.readState();
      if (!state.vault_id || !state.device_id) {
        return;
      }
      if (
        state.last_error_code &&
        state.last_error_code !== "conflict_review_required" &&
        state.last_error_code !== "device_blocked" &&
        !isRetryableLocalError(state.last_error_code)
      ) {
        await this.client.reportDeviceStatus().catch(() => undefined);
        return;
      }
      await this.syncOnceOrPollResolvedConflict({ confirmInitialImport: false, fullAudit: Boolean(options.fullAudit) });
      this.clearTransientSyncFailures();
      this.setStatus((await this.client.readState()).status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
      completed = true;
    } catch (error) {
      completed = await this.handleAutomaticSyncError(error) === true;
    } finally {
      this.endSync(completed);
      if (this.syncQueued) this.scheduleQueuedSync(0);
    }
  }

  async handleAutomaticSyncError(error) {
    this.finishMeasuredPhase("abandoned");
    void this.reportDeviceError(error);
    try {
      if (await this.tryReconcileDeviceBlocked(error)) return true;
    } catch (reconciliationError) {
      error = reconciliationError;
    }
    if (error instanceof ObtsBlockedError) {
      this.clearTransientSyncFailures();
      await this.client.markBlocked(error.code, error.details);
      this.setStatus((await this.client.readState()).status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
      return;
    }
    if (isOfflineTransportError(error)) {
      this.recordTransientSyncFailure();
      this.setStatus("Offline");
      return;
    }
    if (isRetryableServerError(error)) {
      this.recordTransientSyncFailure();
      this.setStatus("Checking (server unavailable; retrying)");
      return;
    }
    if (error instanceof ObtsTransportError) {
      this.clearTransientSyncFailures();
      await this.client.markBlocked(error.code, error.details);
      this.setStatus((await this.client.readState()).status_label, { notify: false });
      await this.client.reportDeviceStatus().catch(() => undefined);
      return;
    }
    const currentState = await this.client.readState();
    if (currentState.last_error_code && isRetryableLocalError(currentState.last_error_code)) {
      if (currentState.last_error_code === "upload_interrupted" || currentState.last_error_code === "pack_preparation_failed") {
        this.recordTransientSyncFailure();
      }
      this.setStatus(currentState.status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
      return;
    }
    this.clearTransientSyncFailures();
    await this.client.markBlocked("sync_error");
    this.setStatus((await this.client.readState()).status_label, { notify: false });
    await this.client.reportDeviceStatus().catch(() => undefined);
  }

  async tryReconcileDeviceBlocked(error) {
    if (!(error instanceof ObtsTransportError || error instanceof ObtsBlockedError) || error.code !== "device_blocked") {
      return false;
    }
    await this.client.reconcileDeviceBlocked(true, error.code);
    this.clearTransientSyncFailures();
    this.setStatus((await this.client.readState()).status_label);
    await this.client.reportDeviceStatus().catch(() => undefined);
    return true;
  }

  recordTransientSyncFailure() {
    this.transientSyncFailures += 1;
    const delay = Math.min(
      BACKGROUND_SYNC_INTERVAL_MS * (2 ** Math.min(10, Math.max(0, this.transientSyncFailures - 1))),
      AUTOMATIC_RETRY_MAX_MS
    );
    this.automaticRetryNotBefore = Date.now() + delay;
  }

  clearTransientSyncFailures() {
    this.transientSyncFailures = 0;
    this.automaticRetryNotBefore = 0;
  }

  async runUserAction(fn, showNotice = true, initialLabel = "Sync now") {
    if (!(await this.ensureClientReady()) || this.isSyncInProgress()) {
      return;
    }
    if (!this.beginSync(initialLabel)) return;
    let completed = false;
    try {
      const result = await fn();
      this.setStatus((await this.client.readState()).status_label);
      completed = true;
      return result;
    } catch (error) {
      this.finishMeasuredPhase("abandoned");
      let handledError = error;
      const message = error instanceof Error ? error.message : "obts sync failed.";
      const deviceBlocked = (error instanceof ObtsTransportError || error instanceof ObtsBlockedError) && error.code === "device_blocked";
      if (deviceBlocked) {
        void this.reportDeviceError(error);
        try {
          if (await this.tryReconcileDeviceBlocked(error)) {
            completed = true;
            return;
          }
        } catch (reconciliationError) {
          handledError = reconciliationError;
        }
      }
      if (handledError instanceof ObtsTransportError && !isPermanentTransportError(handledError)) {
        completed = await this.handleAutomaticSyncError(handledError) === true;
        if (showNotice) new Notice(message);
        return;
      }
      if (!deviceBlocked || handledError !== error) void this.reportDeviceError(handledError);
      const preserveError = handledError instanceof ObtsBlockedError || isPermanentTransportError(handledError);
      const code = preserveError ? handledError.code : "sync_error";
      await this.client.markBlocked(code, preserveError ? handledError.details : undefined);
      const blockedState = await this.client.readState();
      this.setStatus(blockedState.status_label, { notify: preserveError });
      await this.client.reportDeviceStatus().catch(() => undefined);
      if (showNotice && (!preserveError || shouldShowRoutineStatusNotice(blockedState.status_label))) {
        new Notice(message);
      }
    } finally {
      this.endSync(completed);
    }
  }

  async runExclusiveAction(fn, initialLabel = "Obts operation") {
    if (!(await this.ensureClientReady()) || !this.beginSync(initialLabel)) {
      const code = this.operationAvailability() === "restart_required" || this.unloaded
        ? "operation_interrupted_by_reload"
        : "sync_lease_blocked";
      throw new ObtsBlockedError(code, this.syncBlockedMessage());
    }
    let completed = false;
    try {
      const result = await fn();
      completed = true;
      return result;
    } finally {
      this.endSync(completed);
    }
  }

  async runOnboardingAction(fn) {
    return await this.runExclusiveAction(fn, "Completing sync setup");
  }

  operationAvailability() {
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (!lease) return "available";
    const owner = operationLeaseOwner(lease);
    if (owner === this) return "busy";
    if ((lease && lease.retiring) || (owner && owner.unloaded)) return "restart_required";
    return "busy";
  }

  operationDetails() {
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (!lease) return { availability: "available", label: null, elapsedMs: 0, stageElapsedMs: 0, progressUpdatedAt: 0, progressAgeMs: 0, slow: false, stalled: false };
    const owner = operationLeaseOwner(lease);
    const availability = (lease.retiring || owner && owner.unloaded) ? "restart_required" : "busy";
    const details = lease.details || {};
    const startedAt = Number.isFinite(details.startedAt) ? details.startedAt : Date.now();
    const progressUpdatedAt = Number.isFinite(details.progressUpdatedAt) ? details.progressUpdatedAt : startedAt;
    const stageStartedAt = Number.isFinite(details.stageStartedAt) ? details.stageStartedAt : startedAt;
    const fallbackLabel = owner && (owner.activeOperationProgressLabel || owner.initializationStage) || "Obts operation";
    return {
      availability,
      label: typeof details.label === "string" && details.label.length > 0 ? details.label : fallbackLabel,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      stageElapsedMs: Math.max(0, Date.now() - stageStartedAt),
      progressUpdatedAt,
      progressAgeMs: Math.max(0, Date.now() - progressUpdatedAt),
      slow: Boolean(details.slow),
      stalled: Boolean(details.stalled)
    };
  }

  operationDescription(details = this.operationDetails()) {
    if (details.availability === "available") return "No obts operation is running.";
    const elapsed = formatElapsed(details.elapsedMs);
    const stageElapsed = formatElapsed(details.stageElapsedMs);
    const timing = Math.abs(details.elapsedMs - details.stageElapsedMs) >= 1000
      ? `${stageElapsed} in this step · ${elapsed} total`
      : `${elapsed} elapsed`;
    if (details.availability === "restart_required") {
      return `${details.label} · interrupted after ${elapsed}. Fully restart Obsidian before continuing.`;
    }
    if (details.stalled) {
      return `${details.label} · ${timing} · no progress reported for ${formatElapsed(details.progressAgeMs)}. Keep Obsidian in the foreground; fully restart it if this does not change.`;
    }
    return `${details.label} · ${timing}${details.slow ? " · taking longer than expected" : ""}.`;
  }

  syncBlockedMessage() {
    const details = this.operationDetails();
    if (this.unloaded || details.availability === "restart_required") {
      return details.availability === "available"
        ? "A plugin update interrupted an active operation. Fully restart Obsidian before continuing setup or sync."
        : this.operationDescription(details);
    }
    return details.availability === "available"
      ? "Obts could not start this action; check the current status for details."
      : `${this.operationDescription(details)} Wait for it to finish before syncing again.`;
  }

  observeRetiredOperation() {
    const registry = operationRegistry();
    const lease = registry.get(this.app.vault.adapter);
    if (!lease || operationLeaseOwner(lease) === this) return;
    if (this.observedRetiredLease === lease) return;
    this.observedRetiredLease = lease;
    this.setStatus("Finishing update");
    if (lease.completion && typeof lease.completion.then === "function") {
      void lease.completion.then(async () => {
        if (this.unloaded) return;
        if (this.retiredOperationTimer !== null) {
          window.clearTimeout(this.retiredOperationTimer);
          this.retiredOperationTimer = null;
        }
        this.observedRetiredLease = null;
        try {
          await this.initializeClient();
          void this.runBackgroundSync();
        } catch (error) {
          this.handleClientInitializationFailure(error);
        }
      });
    }
    this.retiredOperationTimer = window.setTimeout(() => {
      this.retiredOperationTimer = null;
      if (this.unloaded) return;
      const availability = this.operationAvailability();
      if (availability === "available") {
        this.observedRetiredLease = null;
        void this.initializeClient()
          .then(() => this.runBackgroundSync())
          .catch((error) => this.handleClientInitializationFailure(error));
        return;
      }
      if (availability === "busy") {
        this.setStatus("Waiting for operation");
        this.observedRetiredLease = null;
        this.observeRetiredOperation();
        return;
      }
      this.setStatus("Restart required");
      if (!this.retiredOperationNoticeShown) {
        this.retiredOperationNoticeShown = true;
        if (this.clientReady) {
          void this.reportDeviceError(new ObtsBlockedError(
            "operation_interrupted_by_reload",
            "A plugin update interrupted an active operation."
          ));
        }
        new Notice("obts: Fully restart Obsidian to finish the plugin update safely.", 15000);
      }
    }, RETIRED_OPERATION_GRACE_MS);
  }

  isSyncInProgress() {
    const availability = this.operationAvailability();
    if (availability === "available") return false;
    if (availability === "restart_required") this.observeRetiredOperation();
    return true;
  }

  beginSync(initialLabel = "Obts operation") {
    const registry = operationRegistry();
    if (this.unloaded || registry.has(this.app.vault.adapter)) return false;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const startedAt = Date.now();
    registry.set(this.app.vault.adapter, {
      owner: this,
      retiring: false,
      completion,
      resolveCompletion,
      details: {
        label: initialLabel,
        startedAt,
        progressUpdatedAt: startedAt,
        stageStartedAt: startedAt,
        diagnosticPoint: null,
        slow: false,
        stalled: false
      }
    });
    this.syncRunning = true;
    this.activeOperationProgressLabel = initialLabel;
    this.activeOperationDiagnosticPoint = null;
    this.activeOperationSlow = false;
    this.reportedOperationStalls.clear();
    this.activeMeasuredPhase = null;
    this.operationSlowTimer = window.setTimeout(() => {
      this.operationSlowTimer = null;
      if (this.unloaded || !this.syncRunning) return;
      this.activeOperationSlow = true;
      const lease = registry.get(this.app.vault.adapter);
      if (lease && operationLeaseOwner(lease) === this && lease.details) lease.details.slow = true;
      if (this.activeOperationProgressLabel) {
        this.setStatus(`${this.activeOperationProgressLabel} (taking longer than expected)`, { notify: false });
      }
    }, INITIALIZATION_STALL_DIAGNOSTIC_MS);
    this.scheduleOperationStatusHeartbeat();
    return true;
  }

  finishMeasuredPhase(observation) {
    const phase = this.activeMeasuredPhase;
    this.clearOperationStage();
    if (phase?.stalled && !this.unloaded) {
      void this.reportOperationStall({ ...phase, observation, elapsedMs: Date.now() - phase.startedAt });
    }
  }

  endSync(completed = false) {
    this.finishMeasuredPhase(completed ? "completed" : "abandoned");
    this.clearOperationProgress();
    const registry = operationRegistry();
    const lease = registry.get(this.app.vault.adapter);
    if (operationLeaseOwner(lease) === this) {
      registry.delete(this.app.vault.adapter);
      if (lease && typeof lease.resolveCompletion === "function") lease.resolveCompletion();
    }
    this.syncRunning = false;
    this.scheduleStaleProvenanceSettle();
  }
};

class ObtsObsidianClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.adapter = plugin.app.vault.adapter;
    this.pathMutationGate = plugin.pathMutationGate || installPathMutationGate(this.adapter, plugin);
    this.adapterFs = createDataAdapterFs(this.adapter, this.pathMutationGate);
    const mobile = Boolean(Platform && Platform.isMobile);
    this.fs = createReadOverlayFs(this.adapterFs, [], {
      maxBytes: mobile ? MOBILE_PACK_CACHE_MAX_BYTES : 0,
      cacheRead: (filePath) => mobile && filePath.endsWith(".pack"),
      readAttempts: mobile ? MOBILE_PACK_READ_ATTEMPTS : 1,
      retryDelayMs: mobile ? MOBILE_PACK_READ_RETRY_MS : 0
    });
    this.fsp = this.adapterFs.promises;
    this.fileWorkConcurrency = mobile ? MOBILE_FILE_WORK_CONCURRENCY : DESKTOP_FILE_WORK_CONCURRENCY;
    this.fileBufferBudgetBytes = mobile ? MOBILE_FILE_BUFFER_BUDGET_BYTES : DESKTOP_FILE_BUFFER_BUDGET_BYTES;
    this.vaultDir = "/";
    this.obtsDir = path.join(this.vaultDir, ".obts");
    this.gitdir = path.join(this.obtsDir, "git");
    this.authPath = path.join(this.obtsDir, "auth", "device-token.json");
    this.statePath = path.join(this.obtsDir, "state.json");
    this.queuePath = path.join(this.obtsDir, "queue.json");
    this.directoryStatePath = path.join(this.obtsDir, "directory-state.json");
    this.applyJournalPath = path.join(this.obtsDir, "apply-journal.json");
    this.staleProvenancePath = path.join(this.obtsDir, "stale-provenance.json");
    this.staleMutation = Promise.resolve();
    this.applyLockPath = path.join(this.obtsDir, "apply.lock");
    this.managedHeadlessOwner = plugin.managedHeadlessOwner ?? null;
    this.applyLockOwner = null;
    this.onboardingJournalPath = path.join(this.obtsDir, "onboarding.json");
    this.pendingConnectionPath = path.join(this.obtsDir, "auth", "pending-connection.json");
    this.bootstrapTransferPath = path.join(this.obtsDir, "bootstrap-transfer.json");
    this.pullTransferPath = path.join(this.obtsDir, "pull-transfer.json");
    this.catchupPath = path.join(this.obtsDir, "catchup.json");
    this.uploadTransferPath = path.join(this.obtsDir, "upload-transfer.json");
    this.uploadRecoveryPath = path.join(this.obtsDir, "upload-recovery.json");
    this.pendingAppliedAckPath = path.join(this.obtsDir, "pending-applied-ack.json");
    this.directoryRecoveryPath = path.join(this.obtsDir, "directory-recovery.json");
    this.directoryBaselineRecoveryPath = path.join(this.obtsDir, "directory-baseline-recovery.json");
    this.scanStatePath = path.join(this.obtsDir, "scan-state.json");
    this.scanCachePath = path.join(this.obtsDir, "scan-cache.json");
    this.onboardingOperation = false;
    this.queueMutation = Promise.resolve();
    this.packPlanCache = new Map();
    this.lastSnapshotWasFullAudit = false;
    this.activeReconciliation = null;
    this.lastCursorGuardDiagnostic = "not_observed";
  }

  async collectTroubleshootingContext(details = {}) {
    const [primaryState, backupState, queue, applyJournal, onboardingJournal, pendingAck, ...transferJournals] = await Promise.all([
      readRawTroubleshootingJson(this.fsp, this.statePath, isTroubleshootingState),
      readRawTroubleshootingJson(this.fsp, `${this.statePath}.bak`, isTroubleshootingState),
      readRawTroubleshootingJson(this.fsp, this.queuePath, isTroubleshootingQueue),
      readRawTroubleshootingJson(this.fsp, this.applyJournalPath, isTroubleshootingApplyJournal),
      readRawTroubleshootingJson(this.fsp, this.onboardingJournalPath, isTroubleshootingOnboardingJournal),
      readRawTroubleshootingJson(this.fsp, this.pendingAppliedAckPath, isTroubleshootingPendingAck),
      readRawTroubleshootingJson(this.fsp, this.bootstrapTransferPath, isTroubleshootingBootstrapTransfer),
      readRawTroubleshootingJson(this.fsp, this.pullTransferPath, isTroubleshootingPullTransfer),
      readRawTroubleshootingJson(this.fsp, this.uploadTransferPath, isUploadTransferCheckpoint)
    ]);
    let state = null;
    let stateSource = "default";
    if (primaryState.kind === "valid") {
      state = primaryState.value;
      stateSource = "primary";
    } else if (backupState.kind === "valid") {
      state = backupState.value;
      stateSource = "backup";
    } else if (primaryState.kind !== "absent" || backupState.kind !== "absent") {
      stateSource = "unreadable";
    }
    const server = details.serverSelf && typeof details.serverSelf === "object" ? details.serverSelf : null;
    const capturedState = details.capturedState && typeof details.capturedState === "object" ? details.capturedState : state;
    const safeErrorCode = troubleshootingSafeErrorCode(details.safeErrorCode || capturedState && capturedState.last_error_code);
    return {
      attempt_id: isTroubleshootingAttemptId(details.attemptId) ? details.attemptId : "none",
      trigger: troubleshootingEnum(details.trigger, ["manual", "reconcile_start", "reconcile_guard", "reconcile_finish", "reconcile_failure"], "manual"),
      phase: troubleshootingEnum(details.phase, ["none", "requesting_server", "checking_guard", "applying", "finished", "failed"], "none"),
      outcome: troubleshootingEnum(details.outcome, ["observed", "succeeded", "skipped", "blocked", "failed"], "observed"),
      safe_error_code: safeErrorCode,
      client_state: this.plugin.unloaded ? "unloaded" : this.plugin.clientReady ? "ready" : this.plugin.clientInitialization ? "initializing" : "uninitialized",
      lease_state: troubleshootingLeaseState(this.plugin),
      state_source: stateSource,
      paired: Boolean(capturedState && capturedState.vault_id && capturedState.device_id),
      status_class: troubleshootingStatusClass(capturedState && capturedState.status_label),
      queue_state: troubleshootingQueueState(queue),
      apply_journal: troubleshootingApplyJournalState(applyJournal),
      onboarding_journal: troubleshootingOnboardingState(onboardingJournal),
      transfer_journal: troubleshootingCombinedPresence(transferJournals),
      pending_applied_ack: troubleshootingPresence(pendingAck),
      recovery_summary: {
        apply_read: applyJournal.kind,
        transfer_read: transferJournals.some(read => read.kind === "oversized") ? "oversized" : transferJournals.some(read => read.kind === "invalid") ? "invalid" : transferJournals.some(read => read.kind === "unreadable") ? "unreadable" : transferJournals.some(read => read.kind === "valid") ? "valid" : "absent",
        consent: onboardingJournal.value ? (isOnboardingConsentSummary(onboardingJournal.value.pending_summary) || onboardingJournal.value.consent === "saved" ? "saved" : "missing") : "unknown",
        checkpoint: transferJournals.some(read => read.value?.complete === true) ? "complete" : transferJournals.some(read => read.value?.complete === false) ? "partial" : "unknown",
        apply_error: troubleshootingSafeErrorCode(capturedState?.apply_validation_reason || applyJournal.value?.redacted_error_category)
      },
      cursor_guard: troubleshootingEnum(details.cursorGuard || this.lastCursorGuardDiagnostic, ["not_observed", "no_preservation", "local_main", "local_head", "server_ref", "event_cursor", "multiple"], "not_observed"),
      reconcile_guard: troubleshootingEnum(details.reconcileGuard, ["not_observed", "unchanged", "timestamp_changed", "error_changed", "cursor_changed", "multiple"], "not_observed"),
      reconcile_timestamp: troubleshootingEnum(details.reconcileTimestamp, ["unchanged", "changed", "unknown"], "unknown"),
      reconcile_error: troubleshootingEnum(details.reconcileError, ["unchanged", "changed", "unknown"], "unknown"),
      reconcile_cursors: troubleshootingEnum(details.reconcileCursors, ["unchanged", "changed", "unknown"], "unknown"),
      server_device_status: troubleshootingEnum(server && server.status, ["paired", "synced", "ahead", "review_needed", "blocked_recovery", "revoked"], server ? "unknown" : "not_observed"),
      server_vault_status: troubleshootingEnum(server && server.vault_status, ["active", "blocked_integrity"], server ? "unknown" : "not_observed"),
      request_outcome: troubleshootingEnum(details.requestOutcome, ["not_attempted", "succeeded", "blocked", "transport_failed", "http_failed", "failed"], "not_attempted"),
      http_status: troubleshootingHttpStatus(details.httpStatus),
      cursor_relations: details.cursorRelations || {
        local_head_to_local_main: troubleshootingCursorRelation(capturedState && capturedState.local_head, capturedState && capturedState.local_main),
        server_ref_to_local_head: troubleshootingCursorRelation(capturedState && capturedState.server_device_ref, capturedState && capturedState.local_head),
        local_main_to_server_main: troubleshootingCursorRelation(capturedState && capturedState.local_main, server && server.current_main),
        event_to_applied: troubleshootingSequenceRelation(capturedState && capturedState.last_event_seq, capturedState && capturedState.last_applied_event_seq),
        event_to_server: troubleshootingSequenceRelation(capturedState && capturedState.last_event_seq, server && server.event_seq)
      }
    };
  }

  async initialize() {
    await this.pathMutationGate.ready;
    this.plugin.setInitializationStage("Recovering metadata replacements", "startup_metadata");
    await this.recoverInterruptedReplacements();
    this.plugin.setInitializationStage("Opening local Git state", "startup_git");
    await this.fsp.mkdir(path.join(this.obtsDir, "auth"), { recursive: true, mode: 0o700 });
    await git.init({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, defaultBranch: "local" });
    await git.writeRef({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, ref: "HEAD", value: "refs/heads/local", symbolic: true, force: true });
    await this.recoverInterruptedRefLocks();
    try {
      if (await this.readUploadCheckpoint() || await this.readUploadRecovery()) {
        const queue = await readRecoveryJsonStrict(this.fsp, this.queuePath, "upload_checkpoint_recovery_required", "The saved upload queue is unreadable; preserve recovery evidence.");
        if (!isUploadRecoveryQueue(queue)) throw this.uploadRecoveryError("The saved upload queue is invalid.");
      }
    } catch (error) {
      if (error.code !== "upload_checkpoint_recovery_required") throw error;
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Out of sync — local recovery required", last_error_code: error.code, updated_at: nowIso()
      }));
      return;
    }
    try {
      await this.restartStaleProvenance();
    } catch (error) {
      if (error.code !== "stale_provenance_corrupt") throw error;
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Out of sync — local recovery required", last_error_code: error.code,
        apply_validation_reason: error.code, updated_at: nowIso()
      }));
      return;
    }
    await this.fsp.mkdir(path.join(this.gitdir, "info"), { recursive: true, mode: 0o700 });
    await this.fsp.writeFile(path.join(this.gitdir, "info", "exclude"), ".obts/\n.git/\n", { mode: 0o600 });
    this.plugin.setInitializationStage("Reading local sync state", "startup_state");
    let state = await this.readState();
    this.plugin.setInitializationStage("Checking interrupted apply journal", "recovery_journal");
    let journal;
    try {
      journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    } catch {
      await this.writeState(Object.assign({}, state, { status_label: "Out of sync — local recovery required", last_error_code: "apply_journal_recovery_required", apply_validation_reason: "recovery_state_corrupt", updated_at: nowIso() }));
      return;
    }
    if (journal) await this.retainApplyProvenance(journal);
    if (!journal) state = await this.repairLocalStateIfNeeded(state);
    if (!journal) await this.recoverStaleProposalIntent();
    if (journal) this.plugin.setInitializationStage("Recovering an interrupted apply", "recovery_journal");
    const validationReason = journal && (await this.applyRecoveryValidationReason(journal, state) ||
      (!(await this.validateApplyJournalPolicy(journal)) ? "recovery_target_policy_mismatch" : null));
    if (validationReason) {
      await this.writeState(Object.assign({}, state, {
        status_label: "Out of sync — local recovery required",
        last_error_code: "apply_journal_recovery_required",
        apply_validation_reason: validationReason,
        updated_at: nowIso()
      }));
      return;
    }
    let committedApplyLockId = null;
    if (journal && journal.phase === "committed") {
      await this.acquireApplyLock(journal.apply_id, true);
      committedApplyLockId = journal.apply_id;
    }
    try {
    if (state.apply_validation_reason) {
      state = Object.assign({}, state, { apply_validation_reason: null });
      await this.writeState(state);
    }
    if (journal && journal.phase === "committed") {
      let preservedLocalChangePaths = [];
      let preservedLocalSnapshot = null;
      let pendingDirectoryIntents = [];
      if (journal.preserve_local_changes || journal.expected_prior_local_main) {
        this.plugin.setInitializationStage("Validating recovered local changes", "recovery_file_validation");
        const targetEntries = await this.listTreeBlobOids(journal.target_main);
        const preserved = await this.localChangedPathsFromTree(targetEntries, true, { targetRootIgnoreOid: journal.target_root_ignore_oid });
        preservedLocalChangePaths = preserved.paths;
        preservedLocalSnapshot = preserved.snapshot;
        pendingDirectoryIntents = (await this.readDirectoryState()).pending_intents;
        if (preservedLocalChangePaths.length > 0) {
          this.plugin.setInitializationStage("Writing recovered local change bundle", "recovery_bundle");
          await this.createRecoveryBundle("rebuild_from_server", journal.target_main, preservedLocalChangePaths);
        }
      }
      this.plugin.setInitializationStage("Restoring recovered refs", "recovery_refs");
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      this.plugin.setInitializationStage("Persisting recovered sync state", "recovery_state");
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, journal.event_seq || 0),
        last_applied_event_seq: Math.max(state.last_applied_event_seq || 0, journal.event_seq || 0),
        updated_at: nowIso()
      }));
      if (!journal.preserve_local_changes) await this.refreshDirectoryStateFromDisk();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(journal.target_main, state.server_device_ref, preservedLocalSnapshot);
      } else if (pendingDirectoryIntents.length > 0) {
        await this.queuePreservedDirectoryChanges(journal.target_main, state.server_device_ref);
      }
      await this.writePendingAppliedAcknowledgement(journal.target_main, journal.event_seq || 0);
      await this.clearApplyState();
      return;
    }
    if (journal && await this.recoverBlockedApplyWithPreservedLocalChanges(journal, state)) {
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal && await this.recoverIncompleteApplyJournal(journal, state)) {
      await this.writeQueue(await this.readQueue());
      return;
    }
    if (journal) {
      this.plugin.setInitializationStage("Persisting blocked recovery state", "recovery_state");
      await this.writeState(Object.assign({}, state, {
        status_label: "Out of sync — local recovery required",
        last_error_code: "apply_journal_recovery_required",
        apply_validation_reason: applyRecoveryReason(state, journal),
        updated_at: nowIso()
      }));
      return;
    }
    let directoryRecovery;
    try {
      directoryRecovery = await this.readDirectoryRecoveryDecision();
    } catch (error) {
      await this.writeState(Object.assign({}, state, {
        status_label: "Out of sync — local recovery required",
        last_error_code: "directory_recovery_journal_invalid",
        updated_at: nowIso()
      }));
      await this.plugin.reportDeviceError(error).catch(() => undefined);
      return;
    }
    if (directoryRecovery) {
      this.plugin.setInitializationStage("Resuming directory recovery", "recovery_directory_decision");
      if (directoryRecovery.phase === "awaiting_decision") {
        directoryRecovery = Object.assign({}, directoryRecovery, {
          phase: "executing",
          decisions: Object.fromEntries(directoryRecovery.ambiguous_roots.map((root) => [root, "keep_local"])),
          updated_at: nowIso()
        });
        await writeJson(this.fsp, this.directoryRecoveryPath, directoryRecovery);
      }
      await this.executeDirectoryRecoveryDecision(directoryRecovery);
      return;
    }
    this.plugin.setInitializationStage("Persisting recovered metadata", "startup_state");
    await this.writeState(Object.assign({}, state, {
      status_label: state.status_label || "Checking",
      updated_at: nowIso()
    }));
    await this.writeQueue(await this.readQueue());
    } finally {
      if (committedApplyLockId) await this.releaseApplyLock(committedApplyLockId);
    }
  }

  async recoverInterruptedReplacements() {
    const signal = this.plugin.lifecycleAbortController.signal;
    const shallow = { maxDepth: 0, signal };
    await this.fsp.recoverReplacements(this.obtsDir, shallow);
    await this.fsp.recoverReplacements(path.join(this.obtsDir, "auth"), shallow);
    await this.fsp.recoverReplacements(this.gitdir, shallow);
    await this.fsp.recoverReplacements(path.join(this.gitdir, "refs"), { signal });

    const recoveryDir = path.join(this.obtsDir, "recovery");
    let bundles;
    try {
      bundles = await this.fsp.readdir(recoveryDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT" && !error.cause) return;
      throw error;
    }
    for (const bundle of bundles) {
      if (!bundle.isDirectory()) continue;
      const bundleDir = path.join(recoveryDir, bundle.name);
      if (bundle.name.startsWith(".partial-rec_")) {
        await this.fsp.rm(bundleDir, { recursive: true, force: true });
        continue;
      }
      await this.fsp.recoverReplacements(bundleDir, shallow);
      await this.fsp.recoverReplacements(path.join(bundleDir, "journal"), shallow);
    }
  }

  async readPendingOnboarding() {
    const journal = await readRecoveryJsonStrict(this.fsp, this.onboardingJournalPath, "onboarding_context_required", "The saved setup journal is unreadable. Preserve it for recovery.");
    if (journal && !isTroubleshootingOnboardingJournal(journal)) throw new ObtsBlockedError("onboarding_context_required", "The saved setup journal is invalid. Preserve it for recovery.");
    if (!journal || journal.stage === "complete") return null;
    const pending = await readRecoveryJsonStrict(this.fsp, this.pendingConnectionPath, "onboarding_context_required", "The saved connection credential is unreadable. Preserve the setup state for recovery.");
    if (!pending || typeof pending.connection_secret !== "string" || !pending.connection_secret.trim()) {
      throw new ObtsBlockedError("onboarding_context_required", "The unfinished setup is missing its connection credential. Preserve the original setup journal and restore its matching credential from a trusted backup before resuming; do not start another enrollment.");
    }
    return { journal, secret: pending.connection_secret };
  }

  async cancelOnboarding() {
    await this.fsp.rm(this.pendingConnectionPath, { force: true });
    await this.fsp.rm(this.onboardingJournalPath, { force: true });
    await this.fsp.rm(this.bootstrapTransferPath, { force: true });
  }

  async writeOnboardingJournal(journal) {
    await writeJson(this.fsp, this.onboardingJournalPath, Object.assign({}, journal, { updated_at: nowIso() }));
  }

  async updateOnboardingStage(connectionId, stage, selectedMode, errorCode = null) {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) return;
    await this.writeOnboardingJournal(Object.assign({}, pending.journal, {
      stage,
      selected_mode: selectedMode || pending.journal.selected_mode,
      last_error_code: errorCode
    }));
  }

  async completePendingOnboarding(connectionId) {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) return;
    await this.writeOnboardingJournal(Object.assign({}, pending.journal, { stage: "complete", last_error_code: null }));
    await this.fsp.rm(this.pendingConnectionPath, { force: true });
  }

  async startOnboarding(_vaultNameHint, earlyDisposition = null) {
    if (await this.readPendingOnboarding()) throw new ObtsBlockedError("onboarding_incomplete", "Resume the saved setup or explicitly cancel it before starting another enrollment.");
    await this.assertPairingCanStart();
    await this.flushEditorBuffersToDisk();
    const summary = await this.localSnapshotSummary();
    const existing = await readJson(this.fsp, this.statePath, null);
    const deviceName = normalizeDisplayName(this.plugin.settings.deviceName || "Obsidian device");
    this.plugin.settings.deviceName = deviceName;
    await this.plugin.saveSettings();
    const connection = await postJson(this.url("/api/v1/connections"), {
      plugin_version: PLUGIN_VERSION,
      device_name: deviceName,
      local_vault_name: this.plugin.app.vault.getName(),
      local_summary: {
        has_content: summary.fileCount > 0,
        syncable_file_count: summary.fileCount,
        syncable_bytes: summary.bytes,
        has_detached_baseline: Boolean(existing && existing.unpaired_baseline_vault_id && existing.unpaired_baseline_main)
      }
    });
    await writeJson(this.fsp, this.pendingConnectionPath, { connection_secret: connection.connection_secret, created_at: nowIso() });
    const redactedConnection = Object.assign({}, connection);
    delete redactedConnection.connection_secret;
    await this.writeOnboardingJournal({
      version: 1,
      stage: "awaiting_browser",
      connection: redactedConnection,
      early_disposition: earlyDisposition === "use_server" ? "use_server" : null,
      pending_summary: {
        fingerprint: summary.fingerprint,
        file_count: summary.fileCount,
        bytes: summary.bytes
      },
      analysis: null,
      selected_mode: null,
      last_error_code: null
    });
    return connection;
  }

  async pollOnboarding(connectionId, secret) {
    const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}`), {
      headers: { authorization: `Bearer ${secret}` }
    });
    if (!response.ok) await throwResponseError(response);
    const status = await response.json();
    if (status.status === "approved") await this.updateOnboardingStage(connectionId, "approved");
    if (status.status === "denied" || status.status === "expired") {
      await this.updateOnboardingStage(connectionId, "blocked", null, `connection_${status.status}`);
    }
    return status;
  }

  async syncCapabilities() {
    try {
      const response = await fetchWithTimeout(this.url("/api/v1/sync/capabilities"));
      if (response.status === 404) return null;
      if (!response.ok) await throwResponseError(response);
      const capabilities = await response.json();
      return Array.isArray(capabilities.capabilities) ? capabilities : null;
    } catch (error) {
      if (error instanceof ObtsTransportError && error.status === 404) return null;
      throw error;
    }
  }

  async bootstrapWithChunks(connectionId, secret) {
    const capabilities = await this.syncCapabilities();
    if (!capabilities) {
      const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}/bootstrap`), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ root_ignore_capability: await this.rootIgnoreProtocolCapability() })
      });
      if (!response.ok) await throwResponseError(response);
      return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
    }
    const checkpoint = await readRecoveryJsonStrict(this.fsp, this.bootstrapTransferPath, "invalid_transfer_checkpoint", "The saved bootstrap checkpoint is unreadable. Preserve it for recovery.");
    if (checkpoint && checkpoint.connection_id !== connectionId) await this.fsp.rm(this.bootstrapTransferPath, { force: true });
    if (checkpoint?.connection_id === connectionId && checkpoint.complete === true) {
      if (!isCompleteBootstrapCheckpoint(checkpoint) || !(await this.commitExists(checkpoint.target_main))) {
        throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed onboarding transfer checkpoint is invalid.");
      }
      await this.validateCompleteTransferCheckpoint(checkpoint, null);
      return { manifest: checkpoint.manifest, packfile: Buffer.alloc(0) };
    }
    let cursor = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.next_cursor : 0;
    let target = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.target_main : "latest";
    let finalManifest = null;
    let chunkCount = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.received_chunks || 0 : 0;
    let transferredBytes = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.transferred_bytes || 0 : 0;
    while (true) {
      const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}/bootstrap-chunk`), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ api_version: API_VERSION, plugin_version: PLUGIN_VERSION, cursor, requested_target: target,
          root_ignore_capability: await this.rootIgnoreProtocolCapability() })
      });
      if (!response.ok) await throwResponseError(response);
      const chunk = parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
      if (chunk.packfile.byteLength !== chunk.manifest.chunk_bytes || sha256(chunk.packfile) !== chunk.manifest.chunk_sha256) {
        throw new ObtsBlockedError("chunk_digest_mismatch", "Downloaded bootstrap chunk failed integrity validation.");
      }
      chunkCount += 1;
      transferredBytes += chunk.packfile.byteLength;
      if (chunkCount > capabilities.max_transfer_chunks || transferredBytes > capabilities.max_transfer_bytes) {
        throw new ObtsBlockedError("transfer_too_large", "Bootstrap transfer exceeded negotiated limits.");
      }
      await this.importPack(chunk.packfile, "onboarding", [makeDiagnosticBreadcrumb("bootstrap_chunk", "succeeded", chunk.packfile)]);
      finalManifest = chunk.manifest;
      target = finalManifest.target_main;
      if (finalManifest.complete) {
        if (!(await this.commitExists(finalManifest.target_main))) {
          throw new ObtsBlockedError("transfer_incomplete", "Downloaded onboarding chunks do not contain the target commit.");
        }
        await writeJson(this.fsp, this.bootstrapTransferPath, {
          connection_id: connectionId,
          target_main: target,
          next_cursor: finalManifest.next_cursor,
          received_chunks: chunkCount,
          transferred_bytes: transferredBytes,
          complete: true,
          manifest: finalManifest,
          manifest_sha256: transferManifestSha256(finalManifest),
          updated_at: nowIso()
        });
        this.reportOperationProgress(`Downloaded ${chunkCount} onboarding chunks · ${formatBytes(transferredBytes)}`, "onboarding_download");
        break;
      }
      if (finalManifest.next_cursor <= cursor) throw new ObtsBlockedError("invalid_transfer_cursor", "Bootstrap transfer did not advance.");
      cursor = finalManifest.next_cursor;
      await writeJson(this.fsp, this.bootstrapTransferPath, {
        connection_id: connectionId,
        target_main: target,
        next_cursor: cursor,
        received_chunks: chunkCount,
        transferred_bytes: transferredBytes,
        complete: false,
        updated_at: nowIso()
      });
      this.reportOperationProgress(`Downloaded ${chunkCount} onboarding chunks · ${formatBytes(transferredBytes)}`, "onboarding_download");
    }
    return { manifest: finalManifest, packfile: Buffer.alloc(0) };
  }

  async analyzeOnboarding(connectionId, secret) {
    await this.updateOnboardingStage(connectionId, "analyzing");
    const status = await this.pollOnboarding(connectionId, secret);
    if (status.status !== "approved") {
      throw new ObtsBlockedError("connection_not_approved", "Approve this connection in the browser first.");
    }
    await this.flushEditorBuffersToDisk();
    const local = await this.localSnapshotSummary();
    if (status.selection === "new_vault") {
      const analysis = {
        selection: status.selection,
        vaultId: null,
        vaultName: status.vault_name,
        expectedMain: null,
        rootCommit: null,
        classification: local.fileCount === 0 ? "new_empty" : "new_with_content",
        proposalBase: null,
        localFingerprint: local.fingerprint,
        localFileCount: local.fileCount,
        localBytes: local.bytes
      };
      const pending = await this.readPendingOnboarding();
      if (pending) await this.writeOnboardingJournal(Object.assign({}, pending.journal, { stage: "awaiting_confirmation", analysis }));
      return analysis;
    }
    if (local.fileCount === 0) {
      const analysis = {
        selection: status.selection,
        vaultId: status.vault_id,
        vaultName: status.vault_name,
        expectedMain: status.expected_main,
        rootCommit: null,
        classification: "server_to_empty",
        proposalBase: null,
        localFingerprint: local.fingerprint,
        localFileCount: local.fileCount,
        localBytes: local.bytes
      };
      const pending = await this.readPendingOnboarding();
      if (pending) await this.writeOnboardingJournal(Object.assign({}, pending.journal, { stage: "awaiting_confirmation", analysis }));
      await this.fsp.rm(this.bootstrapTransferPath, { force: true });
      return analysis;
    }
    const bootstrap = await this.bootstrapWithChunks(connectionId, secret);
    await this.importPack(bootstrap.packfile, "onboarding", [makeDiagnosticBreadcrumb("onboarding_approved", "succeeded")]);
    await this.verifyTransferredRootIgnore(bootstrap.manifest);
    const localFiles = await this.scanSyncableFiles((await this.readRootIgnorePolicy()).policy);
    const matchesServer = localFiles.length === bootstrap.manifest.changed_paths.length && await this.localContentMatchesTree(localFiles, bootstrap.manifest.target_main);
    const repair = await this.discoverPairingRepairContext(await readJson(this.fsp, this.statePath, null));
    const baseline = this.baselineForPairing(repair.baseline, bootstrap.manifest.vault_id);
    const validBaseline = baseline && await this.commitExists(baseline.main) && await this.isAncestor(baseline.main, bootstrap.manifest.target_main) ? baseline : null;
    const matchesBaseline = validBaseline ? await this.localContentMatchesTree(localFiles, validBaseline.main) : false;
    const classification = localFiles.length === 0
      ? "server_to_empty"
      : matchesServer
        ? "identical"
        : validBaseline && matchesBaseline
          ? "stale_baseline"
          : validBaseline
            ? "shared_baseline_divergent"
            : "independent_divergent";
    const analysis = {
      selection: status.selection,
      vaultId: bootstrap.manifest.vault_id,
      vaultName: bootstrap.manifest.vault_name,
      expectedMain: bootstrap.manifest.target_main,
      rootCommit: bootstrap.manifest.root_commit,
      classification,
      proposalBase: classification === "shared_baseline_divergent" ? validBaseline.main : bootstrap.manifest.root_commit,
      localFingerprint: local.fingerprint,
      localFileCount: local.fileCount,
      localBytes: local.bytes
    };
    const pending = await this.readPendingOnboarding();
    if (pending) await this.writeOnboardingJournal(Object.assign({}, pending.journal, { stage: "awaiting_confirmation", analysis }));
    await this.fsp.rm(this.bootstrapTransferPath, { force: true });
    return analysis;
  }

  async prepareReplacementOnboarding(connectionId, secret) {
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId || pending.secret !== secret ||
      pending.journal.early_disposition !== "use_server") {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Replacement consent does not match this setup.");
    }
    const status = await this.pollOnboarding(connectionId, secret);
    const summary = pending.journal.pending_summary;
    if ((status.status !== "approved" && status.status !== "consumed") ||
      status.selection !== "existing_vault" || !isGitObjectId(status.expected_main) ||
      typeof status.vault_id !== "string" || !isOnboardingConsentSummary(summary) ||
      (status.status === "consumed" && (status.mode !== "use_server" || pending.journal.selected_mode !== "use_server"))) {
      throw new ObtsBlockedError("onboarding_context_required", "This setup needs its original replacement consent and approved enrollment receipt. Preserve the setup journals and recovery bundles for recovery; do not reset this vault.");
    }
    const state = await this.readState();
    if (state.vault_id && (state.vault_id !== status.vault_id ||
      (status.status === "consumed" && state.device_id !== status.device_id)) ||
      pending.journal.registered_device_id && pending.journal.registered_device_id !== status.device_id) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "The enrollment receipt targets a different device or vault.");
    }
    const analysis = {
      selection: "existing_vault", vaultId: status.vault_id, vaultName: status.vault_name,
      expectedMain: status.expected_main, rootCommit: null, classification: "use_server_direct",
      proposalBase: null, localFingerprint: summary.fingerprint,
      localFileCount: summary.file_count, localBytes: summary.bytes
    };
    validateOnboardingAnalysis(analysis, "use_server");
    await this.writeOnboardingJournal(Object.assign({}, pending.journal, {
      analysis, stage: pending.journal.selected_mode ? pending.journal.stage : "awaiting_confirmation"
    }));
    return analysis;
  }

  async reviewOnboardingConsent(confirmation = null) {
    const pending = await this.readPendingOnboarding();
    if (!pending) throw new ObtsBlockedError("onboarding_context_required", "The original setup context is required.");
    if (!pending.journal.analysis && pending.journal.early_disposition === "use_server") {
      await this.prepareReplacementOnboarding(pending.journal.connection.connection_id, pending.secret);
      return await this.reviewOnboardingConsent(confirmation);
    }
    const journal = pending.journal;
    const analysis = journal.analysis;
    const mode = journal.selected_mode;
    validateOnboardingAnalysis(analysis, mode);
    const state = await this.readState();
    if (state.device_id || journal.registered_device_id || journal.proposal_commit ||
      await exists(this.fsp, this.authPath) || await exists(this.fsp, this.applyJournalPath) ||
      await exists(this.fsp, this.pendingAppliedAckPath) || await exists(this.fsp, this.pullTransferPath)) {
      throw new ObtsBlockedError("onboarding_context_required", "Local enrollment or apply has already started. Preserve the setup journal and recovery evidence; finish that recovery before reviewing consent.");
    }
    const status = await this.pollOnboarding(journal.connection.connection_id, pending.secret);
    if (!["approved", "consumed"].includes(status.status) || status.selection !== analysis.selection ||
      status.expected_main !== analysis.expectedMain || (analysis.vaultId && status.vault_id !== analysis.vaultId) ||
      (status.status === "consumed" && (status.mode !== mode || !status.device_id)) ||
      (journal.consent_device_id && journal.consent_device_id !== status.device_id)) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "The original enrollment identity, mode or baseline differs. Preserve its setup evidence for recovery.");
    }
    await this.flushEditorBuffersToDisk();
    let summary;
    let unstableSummary = false;
    try {
      summary = await this.localSnapshotSummary();
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
      unstableSummary = true;
      summary = {
        fingerprint: analysis.localFingerprint,
        fileCount: analysis.localFileCount,
        bytes: analysis.localBytes
      };
    }
    const review = { connection_id: journal.connection.connection_id, accepted_device_id: status.device_id || null,
      analysis, mode, fingerprint: summary.fingerprint, file_count: summary.fileCount, bytes: summary.bytes };
    if (confirmation) {
      const changedSinceReview = unstableSummary || stableJson(confirmation) !== stableJson(review);
      const updated = Object.assign({}, analysis, { localFingerprint: summary.fingerprint, localFileCount: summary.fileCount, localBytes: summary.bytes });
      await this.writeOnboardingJournal(Object.assign({}, journal, { analysis: updated,
        pending_summary: { fingerprint: summary.fingerprint, file_count: summary.fileCount, bytes: summary.bytes },
        consent_device_id: review.accepted_device_id,
        preserve_consent_local_paths: Boolean(journal.preserve_consent_local_paths || changedSinceReview),
        last_error_code: null }));
      return updated;
    }
    return review;
  }

  async finishOnboarding(connectionId, secret, analysis, mode) {
    let pending = await this.readPendingOnboarding();
    if (
      !pending ||
      pending.journal.connection.connection_id !== connectionId || pending.secret !== secret ||
      pending.journal.selected_mode && mode && pending.journal.selected_mode !== mode
    ) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Pending onboarding mode does not match this setup attempt.");
    }
    mode = pending.journal.selected_mode || mode;
    if (!pending.journal.analysis && pending.journal.early_disposition === "use_server") {
      await this.prepareReplacementOnboarding(connectionId, secret);
      pending = await this.readPendingOnboarding();
    }
    const durableAnalysis = pending.journal.analysis;
    if (analysis && durableAnalysis && !sameOnboardingAnalysis(analysis, durableAnalysis)) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "The submitted consent differs from the durable setup context.");
    }
    analysis = durableAnalysis || analysis;
    validateOnboardingAnalysis(analysis, mode);
    const approval = await this.pollOnboarding(connectionId, secret);
    if (approval.status === "expired" || approval.status === "denied") {
      throw new ObtsBlockedError(`connection_${approval.status}`, "The setup approval ended before enrollment. Restart this unused setup request explicitly.");
    }
    if ((pending.journal.consent_device_id && pending.journal.consent_device_id !== approval.device_id) ||
      !["approved", "consumed"].includes(approval.status) ||
      (approval.status === "approved" && (approval.selection !== analysis.selection || approval.expected_main !== analysis.expectedMain || approval.vault_id !== analysis.vaultId)) ||
      (approval.status === "consumed" && ((analysis.vaultId && approval.vault_id !== analysis.vaultId) ||
        (approval.mode !== undefined && (approval.mode !== mode || approval.expected_main !== analysis.expectedMain || approval.selection !== analysis.selection))))) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "The original enrollment receipt does not match this setup.");
    }
    await this.writeOnboardingJournal(Object.assign({}, pending.journal, { analysis, selected_mode: mode, stage: "registering" }));
    this.onboardingOperation = true;
    await this.updateOnboardingStage(connectionId, "registering", mode);
    try {
      const result = await this.finishOnboardingInternal(connectionId, secret, analysis, mode);
      await this.reportDeviceStatus().catch(() => undefined);
      return result;
    } catch (error) {
      await this.updateOnboardingStage(
        connectionId,
        "blocked",
        mode,
        error instanceof ObtsBlockedError || error instanceof ObtsTransportError ? error.code : "onboarding_failed"
      );
      throw error;
    } finally {
      this.onboardingOperation = false;
    }
  }

  async completeConnection(connectionId, secret, request) {
    return await postJsonWithBearer(this.url(`/api/v1/connections/${connectionId}/complete`), secret, {
      ...request, root_ignore_capability: await this.rootIgnoreProtocolCapability()
    });
  }

  async completeRegisteredOnboarding(connectionId, token) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await this.readState();
      if (!state.vault_id || !state.local_main) {
        throw new ObtsBlockedError("onboarding_incomplete", "Onboarding did not produce an applied server main.");
      }
      try {
        await postJsonWithBearer(this.url(`/api/v1/vaults/${state.vault_id}/onboarding/complete`), token, {
          applied_main: state.local_main,
          root_ignore_capability: await this.rootIgnoreProtocolCapability()
        });
        const completedState = await this.readState();
        const completedQueue = await this.readQueue();
        const completedStatus = completedQueue.pending_commit || completedState.local_head !== completedState.local_main
          ? "Ahead"
          : completedQueue.status === "queued_local" || completedQueue.changed_paths.length > 0
            ? "Checking"
            : "Synced";
        await this.writeState(Object.assign({}, completedState, {
          status_label: completedStatus,
          last_error_code: null,
          updated_at: nowIso()
        }));
        await this.completePendingOnboarding(connectionId);
        return { status: completedStatus, main: state.local_main };
      } catch (error) {
        if (!(error instanceof ObtsTransportError && error.code === "onboarding_target_stale")) throw error;
      }
      const caughtUp = await this.syncOnce({ confirmInitialImport: false });
      if (caughtUp.status === "Conflict resolution needed") {
        const pending = await this.readPendingOnboarding();
        await this.updateOnboardingStage(connectionId, "awaiting_conflict", pending?.journal.selected_mode || null);
        return caughtUp;
      }
    }
    throw new ObtsBlockedError("onboarding_catchup_busy", "The server vault kept changing during setup. Resume setup to continue catching up.");
  }

  async ensureOnboardingApplyBaseline(connectionId, mode, targetMain, localFiles) {
    if (mode !== "use_server") return { bundleId: null, preserveLocalPaths: false };
    const pending = await this.readPendingOnboarding();
    if (!pending || pending.journal.connection.connection_id !== connectionId) {
      return { bundleId: null, preserveLocalPaths: true };
    }
    let bundleId = pending.journal.consent_recovery_bundle_id || null;
    let preserveLocalPaths = Boolean(pending.journal.preserve_consent_local_paths);
    const savedContext = pending.journal.consent_recovery_context || null;
    const sourceState = await this.readState();
    const context = {
      connection_id: pending.journal.connection.connection_id,
      vault_id: pending.journal.analysis?.vaultId || null,
      source_vault_id: savedContext && Object.hasOwn(savedContext, "source_vault_id")
        ? savedContext.source_vault_id
        : sourceState.vault_id || null,
      source_device_id: savedContext && Object.hasOwn(savedContext, "source_device_id")
        ? savedContext.source_device_id
        : sourceState.device_id || null,
      target_main: pending.journal.analysis?.expectedMain || targetMain,
      affected_paths: savedContext?.affected_paths || null
    };
    if (bundleId && (!savedContext || savedContext.connection_id !== context.connection_id ||
      savedContext.vault_id !== context.vault_id || savedContext.source_vault_id !== context.source_vault_id ||
      savedContext.source_device_id !== context.source_device_id || savedContext.target_main !== context.target_main ||
      !Array.isArray(savedContext.affected_paths))) preserveLocalPaths = true;
    let before = null;
    try {
      before = await this.localSnapshotSummary();
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
      preserveLocalPaths = true;
    }
    const changedSinceConsent = Boolean(before && pending.journal.analysis?.localFingerprint &&
      before.fingerprint !== pending.journal.analysis.localFingerprint);
    if (changedSinceConsent && bundleId && savedContext && sourceState.local_main === context.target_main &&
      isGitObjectId(context.target_main) && await this.commitExists(context.target_main)) {
      try {
        await this.readRecoveryBundleFingerprints(bundleId, savedContext);
        const [matchesConsentedTarget, directoryState] = await Promise.all([
          this.localContentMatchesTree(localFiles, context.target_main),
          this.readDirectoryState()
        ]);
        if (matchesConsentedTarget && directoryState.pending_intents.length === 0) {
          return { bundleId: null, preserveLocalPaths: false, context: null };
        }
      } catch (error) {
        if (!(error instanceof LocalSnapshotChangedError) &&
            !(error instanceof ObtsBlockedError && error.code === "onboarding_context_required")) throw error;
      }
    }
    if (changedSinceConsent) preserveLocalPaths = true;
    if (!bundleId && !preserveLocalPaths) {
      const baselinePaths = [...new Set([...localFiles, ...await this.listLocalVaultDirectories()])].sort();
      context.affected_paths = baselinePaths;
      bundleId = await this.createStableRecoveryBundle("replace_local_with_server", context.target_main, baselinePaths, 3, context);
      preserveLocalPaths = !bundleId;
      if (bundleId) {
        try {
          const after = await this.localSnapshotSummary();
          if (before && after.fingerprint !== before.fingerprint) preserveLocalPaths = true;
        } catch (error) {
          if (!(error instanceof LocalSnapshotChangedError)) throw error;
          preserveLocalPaths = true;
        }
      }
    }
    await this.writeOnboardingJournal(Object.assign({}, pending.journal, {
      consent_recovery_bundle_id: bundleId,
      consent_recovery_context: bundleId && !preserveLocalPaths ? context : null,
      preserve_consent_local_paths: preserveLocalPaths
    }));
    return { bundleId: preserveLocalPaths ? null : bundleId, preserveLocalPaths, context };
  }

  async finishOnboardingInternal(connectionId, secret, analysis, mode) {
    validateOnboardingAnalysis(analysis, mode);
    await this.admitApplyRecovery();
    await this.retryPendingAppliedAcknowledgement();
    await this.flushEditorBuffersToDisk();
    const localFiles = await this.scanSyncableFiles((await this.readRootIgnorePolicy()).policy);
    const { bundleId: consentBaselineBundleId, preserveLocalPaths: preserveConsentLocalPaths, context: consentBaselineContext } =
      await this.ensureOnboardingApplyBaseline(connectionId, mode, analysis.expectedMain, localFiles);
    const resumed = await this.resumeAcceptedOnboarding(connectionId, analysis, mode, localFiles);
    if (resumed) return resumed;
    if (mode !== "use_server") {
      await this.createStableRecoveryBundle("initial_import", analysis.expectedMain, localFiles);
    }
    const completion = await this.completeConnection(connectionId, secret, {
      mode,
      expected_main: analysis.expectedMain,
      ...(mode === "initialize" ? { proposal_kind: "new_vault_import" } : {}),
      ...(mode === "merge" ? {
        proposal_kind: analysis.classification === "shared_baseline_divergent" ? "shared_baseline_merge" : "independent_vault_merge",
        proposal_base: analysis.proposalBase
      } : {})
    });
    if (completion.mode !== mode || (analysis.vaultId && completion.vault_id !== analysis.vaultId)) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Completion differs from the approved enrollment.");
    }
    const priorState = await this.readState();
    const pendingIdentity = await this.readPendingOnboarding();
    if ((priorState.vault_id && (priorState.vault_id !== completion.vault_id || priorState.device_id !== completion.device_id)) ||
      (pendingIdentity?.journal.registered_device_id && pendingIdentity.journal.registered_device_id !== completion.device_id)) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Completion differs from the local device identity.");
    }
    await writeJson(this.fsp, this.authPath, { device_token: completion.device_token, created_at: nowIso() });
    if (!priorState.vault_id) await this.writeState({
      user_id: completion.user_id,
      vault_id: completion.vault_id,
      device_id: completion.device_id,
      device_name: this.plugin.settings.deviceName || "Obsidian device",
      device_ref: completion.device_ref,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: true,
      status_label: "Checking",
      last_error_code: null,
      last_event_seq: 0,
      last_applied_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    await this.updateOnboardingStage(connectionId, "applying_uploading", mode);
    const registeredPending = await this.readPendingOnboarding();
    if (registeredPending && registeredPending.journal.connection.connection_id === connectionId) {
      await this.writeOnboardingJournal(Object.assign({}, registeredPending.journal, {
        registered_device_id: completion.device_id
      }));
    }
    const pulled = await this.pull(completion.vault_id, completion.device_id, completion.device_token, null, "latest", 0);
    await this.importPack(pulled.packfile);
    if (mode === "use_server") {
      await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
      await this.applyTargetMain(
        pulled.manifest.target_main,
        pulled.manifest.changed_paths,
        true,
        localFiles,
        false,
        pulled.manifest.directory_intents || [],
        pulled.manifest.explicit_directories || [],
        pulled.manifest.event_seq,
        false,
        null,
        pulled.manifest.target_file_sizes || {},
        consentBaselineBundleId,
        preserveConsentLocalPaths,
        consentBaselineContext
      );
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
      await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
      return await this.completeRegisteredOnboarding(connectionId, completion.device_token);
    }
    const proposalBase = mode === "initialize" ? completion.root_commit : analysis.proposalBase;
    if (!proposalBase) throw new ObtsBlockedError("invalid_onboarding_base", "Onboarding proposal base is unavailable.");
    const proposalState = await this.readState();
    const existingMainRef = await this.resolveRef("refs/heads/main");
    const existingLocalRef = await this.resolveRef("refs/heads/local");
    if (!proposalState.local_main && (!existingMainRef || existingMainRef === proposalBase)) {
      if (existingLocalRef && !(await this.isAncestor(proposalBase, existingLocalRef))) {
        throw new ObtsBlockedError("onboarding_context_required", "Existing local history does not descend from the approved proposal baseline.");
      }
      if (!existingMainRef) await this.updateRef("refs/heads/main", proposalBase, null, true);
      if (!existingLocalRef) await this.updateRef("refs/heads/local", proposalBase, null, true);
      await this.writeState(Object.assign({}, proposalState, { local_main: proposalBase, local_head: existingLocalRef || proposalBase, status_label: "Ahead", updated_at: nowIso() }));
    } else if (proposalState.local_main !== proposalBase) {
      throw new ObtsBlockedError("onboarding_context_required", "Existing local history requires recovery before the initial proposal can resume.");
    }
    const durableProposal = (await this.readPendingOnboarding())?.journal.proposal_commit;
    const localProposalRef = durableProposal || await this.resolveRef("refs/heads/local");
    let proposalCommit;
    if (localProposalRef && localProposalRef !== proposalBase) {
      if (!(await this.commitExists(localProposalRef)) || !(await this.isAncestor(proposalBase, localProposalRef))) {
        throw new ObtsBlockedError("onboarding_context_required", "The saved initial proposal needs preservation-safe recovery before setup can continue.");
      }
      const matchesProposal = await this.localContentMatchesTree(localFiles, localProposalRef);
      if (durableProposal && !matchesProposal) throw new ObtsBlockedError("onboarding_snapshot_changed", "The local vault no longer matches the saved initial proposal.");
      proposalCommit = matchesProposal ? localProposalRef : await this.createLocalCommit("obts: onboarding local vault");
    } else {
      proposalCommit = await this.createLocalCommit("obts: onboarding local vault");
    }
    const proposalPending = await this.readPendingOnboarding();
    if (proposalPending && proposalPending.journal.connection.connection_id === connectionId) {
      await this.writeOnboardingJournal(Object.assign({}, proposalPending.journal, {
        stage: "uploading_proposal",
        proposal_commit: proposalCommit
      }));
    }
    await this.writeQueue({ pending_commit: proposalCommit, expected_device_ref: null, status: proposalCommit ? "queued_local" : "idle", attempts: 0, updated_at: nowIso() });
    // The proposal and its base refs now durably consume the initial object download.
    const initialCheckpoint = await readJson(this.fsp, this.pullTransferPath, null);
    if (initialCheckpoint) {
      if (!isCompletePullCheckpoint(initialCheckpoint) || initialCheckpoint.vault_id !== completion.vault_id || initialCheckpoint.device_id !== completion.device_id) {
        throw new ObtsBlockedError("invalid_transfer_checkpoint", "The onboarding proposal has an inconsistent transfer checkpoint.");
      }
      await this.validateCompleteTransferCheckpoint(initialCheckpoint, initialCheckpoint.current_local_main);
      await this.fsp.rm(this.pullTransferPath, { force: true });
    }
    const synced = await this.syncOnce({ confirmInitialImport: false });
    if (synced.status === "Conflict resolution needed") {
      await this.updateOnboardingStage(connectionId, "awaiting_conflict", mode);
      return synced;
    }
    return await this.completeRegisteredOnboarding(connectionId, completion.device_token);
  }

  async resumeAcceptedOnboarding(connectionId, analysis, mode, localFiles) {
    const pending = await this.readPendingOnboarding();
    if (
      !pending ||
      pending.journal.connection.connection_id !== connectionId ||
      pending.journal.selected_mode && pending.journal.selected_mode !== mode ||
      pending.journal.analysis && (
        pending.journal.analysis.localFingerprint !== analysis.localFingerprint ||
        pending.journal.analysis.selection !== analysis.selection ||
        pending.journal.analysis.vaultId !== analysis.vaultId ||
        pending.journal.analysis.expectedMain !== analysis.expectedMain ||
        pending.journal.analysis.proposalBase !== analysis.proposalBase ||
        pending.journal.analysis.classification !== analysis.classification
      )
    ) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Pending onboarding state does not match this setup attempt.");
    }
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) return null;
    if (analysis.vaultId && analysis.vaultId !== state.vault_id) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Pending onboarding targets a different vault.");
    }
    const token = await this.readDeviceToken();
    const [self, connection] = await Promise.all([
      this.getDeviceSelf(token),
      this.pollOnboarding(connectionId, pending.secret)
    ]);
    if (
      self.vault_id !== state.vault_id ||
      self.device_id !== state.device_id ||
      connection.status !== "consumed" ||
      connection.vault_id !== state.vault_id ||
      connection.device_id !== state.device_id ||
      pending.journal.registered_device_id && pending.journal.registered_device_id !== state.device_id
    ) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Registered onboarding identity does not match local device state.");
    }
    if (!pending.journal.registered_device_id) {
      await this.writeOnboardingJournal(Object.assign({}, pending.journal, { registered_device_id: state.device_id }));
    }
    let localAlreadyApplied = false;
    try {
      localAlreadyApplied = state.local_main === self.current_main &&
        await this.commitExists(self.current_main) &&
        await this.localContentMatchesTree(localFiles, self.current_main);
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
    }
    if (localAlreadyApplied && (mode === "use_server" || self.server_device_ref)) {
      return await this.completeRegisteredOnboarding(connectionId, token);
    }
    if (mode === "use_server") {
      const { bundleId: consentBaselineBundleId, preserveLocalPaths: preserveConsentLocalPaths, context: consentBaselineContext } =
        await this.ensureOnboardingApplyBaseline(connectionId, mode, self.current_main, localFiles);
      const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_applied_event_seq || 0);
      await this.importPack(pulled.packfile);
      await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
      await this.applyTargetMain(
        pulled.manifest.target_main,
        pulled.manifest.changed_paths,
        true,
        localFiles,
        false,
        pulled.manifest.directory_intents || [],
        pulled.manifest.explicit_directories || [],
        pulled.manifest.event_seq,
        false,
        null,
        pulled.manifest.target_file_sizes || {},
        consentBaselineBundleId,
        preserveConsentLocalPaths,
        consentBaselineContext
      );
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
      await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
      return await this.completeRegisteredOnboarding(connectionId, token);
    }
    if (!self.server_device_ref) return null;

    await this.createRecoveryBundle("initial_import", self.current_main, localFiles);
    try {
      const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_applied_event_seq || 0);
      await this.importPack(pulled.packfile);
    } catch (error) {
      if (!(error instanceof ObtsTransportError && error.code === "device_blocked")) throw error;
      await this.normalizeAcceptedOnboardingProposal(self.server_device_ref, localFiles);
      await this.writeState(Object.assign({}, await this.readState(), {
        server_device_ref: self.server_device_ref,
        status_label: "Review needed",
        last_error_code: "conflict_review_required",
        updated_at: nowIso()
      }));
      await this.updateOnboardingStage(connectionId, "awaiting_conflict", mode);
      return { status: "Conflict resolution needed" };
    }

    await this.normalizeAcceptedOnboardingProposal(self.server_device_ref, localFiles);
    await this.writeState(Object.assign({}, await this.readState(), {
      server_device_ref: self.server_device_ref,
      status_label: "Behind",
      last_error_code: null,
      updated_at: nowIso()
    }));
    if (!(await this.pullAndApply(true))) {
      throw new ObtsBlockedError(
        "onboarding_local_changes_after_submit",
        "Local files changed after the onboarding proposal. Recovery is required before applying the resolved vault."
      );
    }
    return await this.completeRegisteredOnboarding(connectionId, token);
  }

  async normalizeAcceptedOnboardingProposal(serverDeviceRef, localFiles) {
    const state = await this.readState();
    const queue = await this.readQueue();
    const localCandidate = queue.pending_commit || state.local_head;
    const matchesAcceptedProposal = localCandidate
      ? await this.sameCommitTree(localCandidate, serverDeviceRef)
      : await this.localContentMatchesTree(localFiles, serverDeviceRef);
    if (!matchesAcceptedProposal) {
      throw new ObtsBlockedError(
        "onboarding_local_changes_after_submit",
        "Local files changed after the onboarding proposal. Recovery is required before continuing."
      );
    }
    await this.updateRef("refs/heads/local", serverDeviceRef, null, true);
    await this.writeState(Object.assign({}, state, {
      server_device_ref: serverDeviceRef,
      local_main: serverDeviceRef,
      local_head: serverDeviceRef,
      status_label: "Review needed",
      last_error_code: "conflict_review_required",
      updated_at: nowIso()
    }));
    await this.writeQueue({
      pending_commit: serverDeviceRef,
      expected_device_ref: serverDeviceRef,
      status: "conflicted",
      attempts: queue.attempts,
      updated_at: nowIso()
    });
  }

  async syncOnce(options = {}) {
    await this.initialize();
    if (!this.onboardingOperation && await this.readPendingOnboarding()) {
      throw new ObtsBlockedError("onboarding_incomplete", "Finish or cancel browser onboarding before normal sync.");
    }
    let state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    if (await this.settleCompletedLegacyDirectoryAdvance()) state = await this.readState();
    const uploadRecovery = await this.recoverUploadCheckpointIfNeeded();
    if (uploadRecovery) return { status: (await this.readState()).status_label, upload: uploadRecovery };
    if (state.last_error_code === "stale_directory_proposal_base" || await exists(this.fsp, this.directoryBaselineRecoveryPath)) {
      await this.recoverStaleDirectoryProposalBase();
      state = await this.readState();
    }
    this.throwIfSyncBlocked(state);
    await this.retryPendingAppliedAcknowledgement();
    await this.settlePreviouslyAppliedPullCheckpoint();
    await this.resumeDurableCatchup();
    if (await this.readDurableCatchup()) throw new ObtsBlockedError("catchup_local_changes", "Catch-up is still pending. Make a copy of local edits outside this vault and preserve recovery evidence before resuming.");
    await this.recoverUnacknowledgedServerApply();
    state = await this.readState();
    await this.flushEditorBuffersToDisk();
    const heldEvidence = await this.readStaleProvenance();
    const heldQueue = await this.readQueue();
    if (heldEvidence.held_proposals.some((h) => h.commit !== heldQueue.pending_commit && h.commit !== heldEvidence.accepted_proposal?.commit)) {
      await this.mutateStaleProvenance(async (saved) => {
        for (const held of [...saved.held_proposals]) if (held.commit !== heldQueue.pending_commit && held.commit !== saved.accepted_proposal?.commit)
          await this.settleHeldProposal(saved, held.commit, null, false);
      });
    }
    if (!heldQueue.pending_commit && heldEvidence.held_proposals.some((h) =>
      h.commit === heldEvidence.accepted_proposal?.commit && ["merged", "noop"].includes(h.outcome))) {
      // A kill after queue clear must apply the acknowledged P before the next
      // scan can capture its held continuation. The general F0 guard is unchanged.
      await this.pullAndApply(true);
      state = await this.readState();
    }
    await this.repairRewoundLocalRef(await this.readState());
    await this.reconcileQueueWithLocalHead(await this.readState());
    const queueBeforeScan = await this.readQueue();
    let uploaded = false;
    let uploadResult = null;
    let performedScan = false;

    // An in-flight target is immutable until the server returns its authoritative outcome.
    if (queueBeforeScan.pending_commit) {
      uploadResult = await this.uploadQueuedCommit(queueBeforeScan);
      uploaded = true;
    } else {
      const hasCommittedLocal = Boolean(state.local_head && state.local_head !== state.local_main);
      if (!hasCommittedLocal) {
        await this.writeState(Object.assign({}, await this.readState(), {
          status_label: "Checking",
          last_error_code: null,
          updated_at: nowIso()
        }));
        await this.reportDeviceStatus().catch(() => undefined);
      }

      const localInventory = await this.listLocalVaultInventory("", (await this.readRootIgnorePolicy()).policy);
      const localFiles = assertNoCaseCollisions(localInventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
      const pendingDirectoryIntents = await this.reconcileDirectoryState(localFiles, localInventory.directories);
      if (localFiles.length > 0 && !state.initial_import_confirmed && state.server_device_ref === null) {
        await this.createRecoveryBundle("initial_import", state.local_main, localFiles);
        if (!options.confirmInitialImport) {
          await this.block("initial_import_confirmation_required", "Initial import requires owner confirmation. Run the confirm initial import command after reviewing the recovery bundle.");
        }
        await this.writeState(Object.assign({}, state, { initial_import_confirmed: true, status_label: "Ahead", updated_at: nowIso() }));
      }

      const staleQueued = await this.queueStaleCohort(state.local_main, state.server_device_ref);
      let commit = staleQueued ? null : await this.createLocalCommit("obts: local vault changes", localFiles, {
        forcePaths: queueBeforeScan.changed_paths,
        fullAudit: Boolean(options.fullAudit)
      });
      if (!staleQueued && !commit && pendingDirectoryIntents.length > 0) {
        commit = await this.createMetadataCommit("obts: local directory changes");
      }
      if (commit) {
        const currentState = await this.readState();
        await this.updateQueue(async (latestHintQueue) => ({
          pending_commit: commit,
          expected_device_ref: currentState.server_device_ref,
          status: "queued_local",
          attempts: 0,
          change_seq: latestHintQueue.change_seq,
          changed_paths: latestHintQueue.change_seq === queueBeforeScan.change_seq ? [] : latestHintQueue.changed_paths,
          updated_at: nowIso()
        }));
        await this.writeState(Object.assign({}, currentState, { local_head: commit, status_label: "Ahead", last_error_code: null, updated_at: nowIso() }));
      } else if (!staleQueued && pendingDirectoryIntents.length === 0 && !this.plugin.syncQueued) {
        await this.clearQueuedHintIfUnchanged(queueBeforeScan.change_seq || 0);
        const [reconciledState, reconciledQueue] = await Promise.all([this.readState(), this.readQueue()]);
        if (
          reconciledState.local_head === reconciledState.local_main &&
          reconciledQueue.status !== "queued_local"
        ) {
          await this.writeState(Object.assign({}, reconciledState, {
            status_label: "Synced",
            last_error_code: null,
            updated_at: nowIso()
          }));
        }
      }

      performedScan = true;
      await this.recordScanCompleted(Boolean(options.fullAudit));
      const queue = await this.readQueue();
      if (queue.pending_commit) {
        uploadResult = await this.uploadQueuedCommit(queue);
        uploaded = true;
      }
    }

    const postUploadState = await this.readState();
    if (postUploadState.last_error_code !== "conflict_review_required") {
      try {
        if (uploaded) {
          await this.pullAndApply(true);
        } else {
          await this.pollRemoteEventsAndApply();
        }
      } catch (error) {
        if (!(uploaded && error instanceof ObtsTransportError && error.code === "device_blocked")) throw error;
        const blockedQueue = await this.readQueue();
        await this.writeQueue(Object.assign({}, blockedQueue, { status: "conflicted", updated_at: nowIso() }));
        await this.writeState(Object.assign({}, await this.readState(), {
          status_label: "Review needed",
          last_error_code: "conflict_review_required",
          updated_at: nowIso()
        }));
        const conflictId = error.details && typeof error.details.conflict_id === "string" ? error.details.conflict_id : null;
        if (conflictId) uploadResult = Object.assign({}, uploadResult, { conflict_id: conflictId });
      }
    }
    if (performedScan) await this.recordScanCompleted(Boolean(options.fullAudit));
    if (options.fullAudit && !performedScan && !options.auditContinuation) {
      const continuationState = await this.readState();
      const continuationQueue = await this.readQueue();
      if (continuationState.last_error_code !== "conflict_review_required" && !continuationQueue.pending_commit) {
        return await this.syncOnce(Object.assign({}, options, { auditContinuation: true }));
      }
    }
    const finalState = await this.readState();
    await this.reportDeviceStatus().catch(() => undefined);
    return {
      status: finalState.status_label,
      main: finalState.local_main || undefined,
      ...(uploadResult && uploadResult.conflict_id ? { conflictId: uploadResult.conflict_id } : {})
    };
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
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_applied_event_seq || 0);
    await this.importPack(pulled.packfile);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      true,
      localFiles,
      false,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq,
      false,
      null,
      pulled.manifest.target_file_sizes || {}
    );
    await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
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
    await this.recoverUploadCheckpointIfNeeded();
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
    let provenance;
    let repairedBase = null;
    let repairApplyId = null;
    let repairEvidence = null;
    const preservedDiskPaths = new Set();
    try { provenance = await this.readStaleProvenance(); }
    catch (error) {
      if (error.code !== "stale_provenance_corrupt") throw error;
      // Snapshot only original valid pins: repair/fallback publication must not
      // manufacture evidence that permits held work to advance its base.
      const refs = await git.listRefs({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, filepath: "refs/obts/stale-bases" });
      const originalBases = [];
      let base = null;
      for (const ref of refs) {
        if (!/^[0-9a-f]{40}$/u.test(ref) ||
            await this.resolveRef(`refs/obts/stale-bases/${ref}`) !== ref || !await this.commitExists(ref)) continue;
        originalBases.push(ref);
        if (!base || await this.isAncestor(ref, base)) base = ref;
        else if (!await this.isAncestor(base, ref))
          await this.block("stale_intent_mismatch", "Protected repair bases have ambiguous ancestry; preserved evidence needs recovery.");
      }
      repairEvidence = { originalBases, base: base || state.local_main, older: false };
      if (queue.pending_commit) for (const ref of originalBases) {
        if (ref !== queue.pending_commit && await this.isAncestor(ref, queue.pending_commit)) repairEvidence.older = true;
        else if (!await this.isAncestor(queue.pending_commit, ref))
          await this.block("stale_intent_mismatch", "Protected repair ancestry does not prove the held authoring base.");
      }
      const staged = await this.stageRecoveryBundleFiles(localFiles, "Checking (preserving corrupt evidence)");
      await this.fsp.writeFile(path.join(staged.partialDir, "journal", "stale-provenance.json"),
        await this.fsp.readFile(this.staleProvenancePath), { mode: 0o600 });
      await this.finalizeRecoveryBundle(staged, "rebuild_from_server", state.local_main, localFiles, null);
      provenance = { version: 3, horizons: [], obligations: {}, intent: null, accepted_proposal: null, held_proposals: [], queued_replacement: null };
      repairedBase = repairEvidence.base;
      if (repairedBase) provenance.horizons.push({
        apply_id: repairApplyId = `apply_repair_${randomHex(8)}`, base: base || state.local_main,
        touched: [...new Set([...localFiles, ...await this.listTreeFiles(state.local_main || base)])], expiry: Date.now() + 3000
      });
      if (queue.pending_commit && queue.pending_proposal_base) {
        if (!await this.commitExists(queue.pending_proposal_base))
          await this.block("stale_base_missing", "The queued authoring base is unavailable; preserved evidence needs recovery.");
        let parsed, proposal, parentTree;
        try {
          parsed = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: queue.pending_commit })).commit;
          if (parsed.parent.length !== 1 || parsed.parent[0] !== state.local_main ||
              !await this.isAncestor(queue.pending_proposal_base, parsed.parent[0]) ||
              queue.expected_device_ref && !await this.isAncestor(queue.expected_device_ref, queue.pending_commit))
            throw new Error("Queued ancestry does not match recorded state");
          proposal = await this.listTreeBlobOids(queue.pending_commit);
          parentTree = await this.listTreeBlobOids(parsed.parent[0]);
        } catch {
          await this.block("stale_intent_mismatch", "The queued proposal objects or ancestry need explicit recovery.");
        }
        let cohortBase = queue.pending_proposal_base;
        if (repairedBase && await this.isAncestor(repairedBase, cohortBase)) cohortBase = repairedBase;
        const captures = {};
        for (const p of new Set([...proposal.keys(), ...parentTree.keys()])) {
          if (proposal.get(p) === parentTree.get(p)) continue;
          provenance.obligations[p] = { base: cohortBase, generation: 0, signature: proposal.get(p) || "absent" };
          captures[p] = 0;
        }
        provenance.intent = { parent: parsed.parent[0], tree: parsed.tree, base: queue.pending_proposal_base,
          captures, commit: queue.pending_commit, outcome: null, main: null };
        for (const p of new Set([...proposal.keys(), ...localSnapshot.keys()])) {
          const signature = localSnapshot.has(p) ? (await git.hashBlob({ object: localSnapshot.get(p) })).oid : "absent";
          if (signature === (proposal.get(p) || "absent")) continue;
          preservedDiskPaths.add(p);
          const obligation = provenance.obligations[p];
          if (obligation) { obligation.generation++; obligation.signature = signature; }
          else provenance.obligations[p] = { base: repairedBase || queue.pending_proposal_base, generation: 1, signature };
        }
      }
      // The corrupt bytes have already been durably bundled. Pin every newly
      // reconstructed base before publishing usable replacement evidence.
      for (const base of new Set([...provenance.horizons.map((h) => h.base),
        ...Object.values(provenance.obligations).map((o) => o.base), provenance.intent?.base].filter(Boolean))) {
        if (!await this.commitExists(base)) await this.block("stale_base_missing", "A protected repair base is unavailable.");
        await git.writeRef({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir,
          ref: `refs/obts/stale-bases/${base}`, value: base, force: true });
      }
      await writeJson(this.fsp, this.staleProvenancePath, provenance);
      await this.restartStaleProvenance();
    }
    let preservedBase = repairedBase || queue.pending_proposal_base || state.local_main;
    for (const candidate of Object.values(provenance.obligations).map((o) => o.base))
      if (!preservedBase || await this.isAncestor(candidate, preservedBase)) preservedBase = candidate;
    // P owns its immutable bytes; only disk differences from P are later work.
    // With no P, compare against the recorded canonical tree instead. Restoring
    // P itself here would violate queued fast-forward materialization ordering.
    const preRebuildTree = await this.listTreeBlobOids(queue.pending_commit || state.local_main);
    const signatures = new Map();
    for (const p of new Set([...preRebuildTree.keys(), ...localSnapshot.keys()])) {
      const signature = localSnapshot.has(p) ? (await git.hashBlob({ object: localSnapshot.get(p) })).oid : "absent";
      if (signature === (preRebuildTree.get(p) || "absent")) continue;
      preservedDiskPaths.add(p);
      signatures.set(p, signature);
    }
    // Empty-directory intent origin cannot be proved from ordinary P's tree.
    // The existing directory proposal refreshes base_main, so record its older
    // fallback obligation before rebuild rather than upgrading it to new main.
    for (const intent of (await this.readDirectoryState()).pending_intents) if (!signatures.has(intent.path)) {
      signatures.set(intent.path, (await git.hashBlob({ object: Buffer.from(stableJson(directoryIntentGenerationKey(intent))) })).oid);
    }
    await this.holdRebuildDifferences(queue, state.local_main, signatures, repairApplyId, repairEvidence);
    if (preservedBase && signatures.size) await this.mutateStaleProvenance(async (saved) => {
      for (const [p, signature] of signatures) {
        let obligation = saved.obligations[p];
        if (!obligation) obligation = saved.obligations[p] = { base: preservedBase, generation: 0, signature: "uncaptured" };
        else if ((repairEvidence?.older || !saved.held_proposals.some((h) => Object.hasOwn(h.fallbacks, p))) && await this.isAncestor(preservedBase, obligation.base)) obligation.base = preservedBase;
        if (obligation.signature !== signature) { obligation.generation++; obligation.signature = signature; }
      }
    });
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_applied_event_seq || 0);
    await this.importPack(pulled.packfile);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    const priorLocalFiles = state.local_main ? await this.listTreeFiles(state.local_main) : [];
    const pendingClassification = await this.classifyPendingCommit(queue.pending_commit, state.server_device_ref, pulled.manifest.target_main);

    if (pendingClassification === "repeat") await this.mutateStaleProvenance(async (saved) => {
      await this.settleHeldProposal(saved, queue.pending_commit, pulled.manifest.target_main, true);
    });
    await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      true,
      localFiles,
      false,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq,
      false,
      null,
      pulled.manifest.target_file_sizes || {}, null, false, null, true
    );
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);

    if (pendingClassification === "divergent") {
      await this.createRecoveryBundle("rebuild_from_server", pulled.manifest.target_main, localFiles);
      await this.writeQueue(Object.assign({}, queue, {
        status: "blocked_recovery",
        updated_at: nowIso()
      }));
      await this.block("same_device_non_fast_forward", "Divergent same-device history requires export and reset or re-pair.");
    }

    if (pendingClassification === "fast_forward" && queue.pending_commit) {
      if (preservedDiskPaths.size) await this.restoreFileSnapshot(
        new Map([...localSnapshot].filter(([p]) => preservedDiskPaths.has(p))),
        [...preservedDiskPaths].filter((p) => !localSnapshot.has(p)),
        await this.listTreeBlobOids(pulled.manifest.target_main)
      );
      await this.updateRef("refs/heads/local", pulled.manifest.target_main, null, true);
      await this.writeQueue(Object.assign({}, queue, {
        status: "queued_local",
        changed_paths: [...new Set([...queue.changed_paths, ...preservedDiskPaths])].sort(),
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
      if (!(await this.localSnapshotMatchesTree(localSnapshot, pulled.manifest.target_main))) {
        await this.restoreFileSnapshot(localSnapshot, priorLocalFiles, await this.listTreeBlobOids(pulled.manifest.target_main));
        const captured = await this.localChangedPathsFromTree(await this.listTreeBlobOids(pulled.manifest.target_main), true);
        if (preservedBase) await this.mutateStaleProvenance(async (saved) => {
          for (const p of captured.paths) if (!saved.obligations[p])
            saved.obligations[p] = { base: preservedBase, generation: 0, signature: "uncaptured" };
        });
        await this.queuePreservedLocalChanges(pulled.manifest.target_main, state.server_device_ref, captured.snapshot);
        const recoveryCommit = (await this.readQueue()).pending_commit;
        if (recoveryCommit) return { status: "Ahead", main: pulled.manifest.target_main, recoveryCommit };
      }
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return { status: "Synced", main: pulled.manifest.target_main };
    }

    if (!(await this.localSnapshotMatchesTree(localSnapshot, pulled.manifest.target_main))) {
      await this.restoreFileSnapshot(localSnapshot, priorLocalFiles, await this.listTreeBlobOids(pulled.manifest.target_main));
      const captured = await this.localChangedPathsFromTree(await this.listTreeBlobOids(pulled.manifest.target_main), true);
      if (preservedBase) await this.mutateStaleProvenance(async (saved) => {
        for (const p of captured.paths) {
          const existing = saved.obligations[p];
          if (!existing) saved.obligations[p] = { base: preservedBase, generation: 0, signature: "uncaptured" };
          else if (await this.isAncestor(preservedBase, existing.base)) existing.base = preservedBase;
        }
      });
      await this.queuePreservedLocalChanges(pulled.manifest.target_main, state.server_device_ref, captured.snapshot);
      const recoveryCommit = (await this.readQueue()).pending_commit;
      if (recoveryCommit) return { status: "Ahead", main: pulled.manifest.target_main, recoveryCommit };
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
    if (!state.vault_id || !state.device_id) {
      return;
    }
    let changedPaths = [];
    if (paths !== undefined) {
      changedPaths = (Array.isArray(paths) ? paths : [paths])
        .filter((filePath) => typeof filePath === "string" && filePath.length > 0)
        .map((filePath) => normalizePath(filePath))
        .filter((filePath) => isSyncableVaultPath(filePath));
      if (changedPaths.length === 0) {
        return;
      }
      assertNoCaseCollisions(changedPaths);
    }
    const queue = await this.updateQueue(async (current) => Object.assign({}, current, {
      pending_commit: current.pending_commit,
      expected_device_ref: current.expected_device_ref ?? state.server_device_ref,
      status: current.pending_commit ? current.status : "queued_local",
      attempts: current.attempts || 0,
      change_seq: (current.change_seq || 0) + 1,
      changed_paths: Array.from(new Set([...(current.changed_paths || []), ...changedPaths])).sort(),
      updated_at: nowIso()
    }));
    if (state.last_error_code && !isRetryableLocalError(state.last_error_code)) return;
    const hasCommittedLocal = Boolean(
      queue.pending_commit || (state.local_head && state.local_head !== state.local_main)
    );
    await this.writeState(Object.assign({}, state, {
      status_label: hasCommittedLocal ? "Ahead" : "Checking",
      updated_at: nowIso()
    }));
  }

  async uploadQueuedCommit(queue) {
    const recovered = await this.recoverUploadCheckpointIfNeeded(queue);
    if (recovered) return recovered;
    let state = await this.readState();
    const token = await this.readDeviceToken();
    await this.writeState(Object.assign({}, state, {
      status_label: "Preparing upload",
      last_error_code: null,
      updated_at: nowIso()
    }));
    this.plugin.setStatus("Preparing upload");
    await this.reportDeviceStatus().catch(() => undefined);
    const allDirectoryIntents = (await this.readDirectoryState()).pending_intents;
    const staleIntent = queue.pending_proposal_base ? (await this.readStaleProvenance()).intent : null;
    const pendingDirectoryIntents = queue.pending_proposal_base
      ? allDirectoryIntents.filter((intent) => Object.keys(staleIntent?.captures || {}).some((p) => changedPathsConflict(p, intent.path)))
      : allDirectoryIntents;
    const uploadCheckpoint = await this.readUploadCheckpoint();
    let directoryProposal = isUploadTransferCheckpoint(uploadCheckpoint) && uploadCheckpoint.target_commit === queue.pending_commit
      ? uploadCheckpoint.directory_proposal || null
      : null;
    let result;
    try {
      if (!uploadCheckpoint && queue.pending_commit && await this.queuedCommitRootPolicyIsStale(queue.pending_commit)) {
        const rebuilt = await this.rebuildQueuedCommitForRootPolicy(queue.pending_commit, state, queue);
        if (rebuilt) {
          queue = rebuilt.queue;
          state = rebuilt.state;
        }
      }
      if (isUploadTransferCheckpoint(uploadCheckpoint) && uploadCheckpoint.transfer_id && uploadCheckpoint.target_commit === queue.pending_commit) {
        const existingResponse = await fetchWithTimeout(
          this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${uploadCheckpoint.transfer_id}`),
          { headers: { authorization: `Bearer ${token}` } }
        );
        if (existingResponse.ok) {
          const descriptor = await existingResponse.json();
          this.validateUploadDescriptor(descriptor, uploadCheckpoint);
          if (descriptor.status === "completed") result = this.completedTransferResult(descriptor);
          else if (descriptor.status === "rejected") this.throwRejectedTransfer(descriptor);
          else if (descriptor.status === "processing") result = await this.pollPushTransfer(state, token, descriptor, uploadCheckpoint);
        } else if (existingResponse.status !== 404 && existingResponse.status !== 410) {
          await throwResponseError(existingResponse);
        }
      }
      let capabilities = null;
      if (!result && uploadCheckpoint) {
        capabilities = await this.syncCapabilities();
        result = await this.pushInChunks(state, queue, token, directoryProposal, capabilities,
          uploadCheckpoint.transfer_request.root_ignore_oid);
      }
      if (!result) {
        const serverState = await this.getDeviceSelf(token);
        await this.reconcileServerVaultStatus(serverState.vault_status, true);
        if (
          serverState.server_device_ref &&
          serverState.server_device_ref !== queue.expected_device_ref &&
          await this.commitExists(serverState.server_device_ref) &&
          await this.isAncestor(serverState.server_device_ref, queue.pending_commit)
        ) {
          queue = await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
            expected_device_ref: serverState.server_device_ref,
            updated_at: nowIso()
          }));
          state = Object.assign({}, state, { server_device_ref: serverState.server_device_ref, updated_at: nowIso() });
          await this.writeState(state);
        }
        capabilities = await this.syncCapabilities();
        if (!directoryProposal) {
          directoryProposal = pendingDirectoryIntents.length > 0
            ? buildDirectoryProposal(state, queue.pending_commit, pendingDirectoryIntents)
            : null;
        }
      }
      if (!result && directoryProposal && !(capabilities && capabilities.capabilities.includes("directory-proposals-v2"))) {
        throw new ObtsBlockedError("server_update_required", "The server must be updated before directory changes can sync safely.");
      }
      const rootIgnoreOid = !result ? await this.validateUploadTargetRootIgnore(queue.pending_commit) : null;
      if (!result && capabilities && capabilities.capabilities.includes("git-object-pack-chunks-v1")) {
        result = await this.pushInChunks(state, queue, token, directoryProposal, capabilities, rootIgnoreOid);
      } else if (!result) {
        const packfile = await this.createPackForCommit(queue.pending_commit, [queue.expected_device_ref, state.local_main].filter(Boolean));
        const manifest = {
          api_version: API_VERSION,
          plugin_version: PLUGIN_VERSION,
          vault_id: state.vault_id,
          device_id: state.device_id,
          expected_device_ref: queue.expected_device_ref,
          target_commit: queue.pending_commit,
          root_ignore_capability: "root-ignore-v1",
          root_ignore_oid: rootIgnoreOid,
          packfile_sha256: sha256(packfile),
          packfile_bytes: packfile.byteLength,
          client_known_main: state.local_main,
          ...(this.proposalBase(queue, state) ? { base_commit: this.proposalBase(queue, state) } : {}),
          ...(directoryProposal ? { directory_proposal: directoryProposal } : {}),
          attempt_id: `sync_${Date.now()}_${randomHex(8)}`
        };
        await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
          status: "uploading",
          attempts: Math.max(current.attempts || 0, queue.attempts || 0) + 1,
          updated_at: nowIso()
        }));
        await this.writeState(Object.assign({}, state, { status_label: "Uploading", last_error_code: null, updated_at: nowIso() }));
        this.plugin.setStatus("Uploading");
        await this.reportDeviceStatus().catch(() => undefined);
        try {
          result = await this.push(state.vault_id, token, manifest, packfile);
        } catch (error) {
          if (!(error instanceof ObtsTransportError && error.code === "stale_device_ref")) throw error;
          result = await this.retryPushAfterStaleDeviceRef(state, queue, token, manifest, packfile);
          if (!result) throw error;
        }
      }
    } catch (error) {
      let errorCode = null;
      let statusLabel = null;
      await this.updateQueue(async (latestQueue) => {
        if (latestQueue.pending_commit !== queue.pending_commit || latestQueue.status === "blocked_recovery") return latestQueue;
        const permanentTransport = error instanceof ObtsTransportError &&
          !isOfflineTransportError(error) &&
          !isRetryableServerError(error);
        errorCode = error instanceof ObtsBlockedError || permanentTransport
          ? error.code
          : latestQueue.attempts > queue.attempts
            ? "upload_interrupted"
            : "pack_preparation_failed";
        statusLabel = error instanceof ObtsBlockedError || permanentTransport ? blockStatusLabel(errorCode, error.details) : "Out of sync";
        return Object.assign({}, latestQueue, { status: "queued_local", updated_at: nowIso() });
      });
      if (errorCode && statusLabel) {
        await this.writeState(Object.assign({}, await this.readState(), {
          status_label: statusLabel,
          last_error_code: errorCode,
          last_error_details: error instanceof ObtsBlockedError && error.code === "object_too_large_for_chunk" ? error.details : null,
          updated_at: nowIso()
        }));
        this.plugin.setStatus(statusLabel);
        await this.reportDeviceStatus().catch(() => undefined);
      }
      throw error;
    }
    this.reportOperationProgress("Finishing update (preserving local changes)", "provenance");
    await this.recordStaleProposalResult(queue, result);
    this.reportOperationProgress("Finishing update (finishing)", "upload_finalize");
    await this.fsp.rm(this.uploadTransferPath, { force: true });
    if (result.status === "conflicted") {
      await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
        status: "conflicted",
        updated_at: nowIso()
      }));
      await this.writeState(Object.assign({}, state, {
        server_device_ref: result.device_ref,
        status_label: "Review needed",
        last_error_code: "conflict_review_required",
        updated_at: nowIso()
      }));
      return result;
    }
    if (result.status === "merged" || result.status === "noop") {
      const acknowledgement = result.directory_ack;
      const expectedAcknowledgementKeys = new Set(
        (directoryProposal?.intents || []).map(directoryIntentGenerationKey)
      );
      const receivedAcknowledgementKeys = new Set(
        (Array.isArray(acknowledgement?.acknowledged_intents) ? acknowledgement.acknowledged_intents : [])
          .map(directoryIntentGenerationKey)
      );
      const exactAcknowledgement = Boolean(
        directoryProposal &&
        acknowledgement &&
        acknowledgement.proposal_id === directoryProposal.proposal_id &&
        (result.status === "merged"
          ? acknowledgement.status === "accepted"
          : acknowledgement.status === "accepted" || acknowledgement.status === "duplicate") &&
        receivedAcknowledgementKeys.size === expectedAcknowledgementKeys.size &&
        [...expectedAcknowledgementKeys].every((key) => receivedAcknowledgementKeys.has(key))
      );
      if ((uploadCheckpoint ? (directoryProposal?.intents || []).length : pendingDirectoryIntents.length) > 0 && !exactAcknowledgement) {
        await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
          status: "queued_local",
          updated_at: nowIso()
        }));
        await this.writeState(Object.assign({}, state, {
          status_label: "Ahead",
          last_error_code: "directory_acknowledgement_missing",
          updated_at: nowIso()
        }));
        throw new ObtsBlockedError(
          "directory_acknowledgement_missing",
          "The server accepted directory work without an exact acknowledgement. The proposal remains queued for retry."
        );
      }
      const settledQueue = await this.updateQueue(async (latestQueue) => {
        if (latestQueue.pending_commit !== queue.pending_commit) {
          throw new ObtsBlockedError("local_queue_changed", "The local upload queue changed before its terminal result was consumed.");
        }
        const hasFollowUpHints = (latestQueue.changed_paths || []).length > 0;
        return {
          pending_commit: null,
          expected_device_ref: result.device_ref,
          status: hasFollowUpHints ? "queued_local" : result.status === "merged" ? "merged" : "idle",
          attempts: 0,
          change_seq: latestQueue.change_seq,
          changed_paths: hasFollowUpHints ? latestQueue.changed_paths : [],
          updated_at: nowIso()
        };
      });
      const hasFollowUpHints = (settledQueue.changed_paths || []).length > 0;
      const serverMainIsAhead = typeof result.main === "string" && result.main !== state.local_main;
      await this.writeState(Object.assign({}, state, {
        server_device_ref: result.device_ref,
        local_head: queue.pending_commit,
        status_label: hasFollowUpHints ? "Checking" : serverMainIsAhead ? "Behind" : "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, result.event_seq || 0),
        updated_at: nowIso()
      }));
      await this.clearAcknowledgedDirectoryIntents(acknowledgement?.acknowledged_intents ?? []);
    }
    return result;
  }

  async recoverUploadCheckpointIfNeeded(queue = null) {
    queue ||= await this.readQueue();
    const state = await this.readState();
    let journal = await this.readUploadRecovery();
    // A pending legacy directory journal owns its own upload checkpoint
    // lifecycle; defer to that recovery flow rather than reading or
    // journaling the checkpoint here.
    if (!journal && await exists(this.fsp, this.directoryBaselineRecoveryPath)) return null;
    const checkpoint = await this.readUploadCheckpoint();
    if (!journal && !checkpoint) return null;
    const queueEvidence = await readRecoveryJsonStrict(this.fsp, this.queuePath,
      "upload_checkpoint_recovery_required", "The saved queue is unreadable. Preserve the vault and .obts files for assisted recovery.");
    if (!isUploadRecoveryQueue(queueEvidence) || queueEvidence.pending_commit !== queue.pending_commit) throw this.uploadRecoveryError("The saved queue identity is invalid.");
    if (journal && !checkpoint && !journal.result) throw this.uploadRecoveryError("The original checkpoint is missing before reconciliation.");
    if (!journal) {
      const request = checkpoint.transfer_request;
      if (request.vault_id !== state.vault_id || request.device_id !== state.device_id) {
        throw this.uploadRecoveryError("The checkpoint belongs to a different paired identity.");
      }
      if (checkpoint.target_commit === queue.pending_commit && isModernUploadCheckpoint(checkpoint) &&
          (request.base_commit || null) === (this.proposalBase(queue, state) || null)) return null;
      await this.mutateQueue(async () => {
        const current = await this.readQueue();
        if (current.pending_commit !== queue.pending_commit) throw this.uploadRecoveryError("The queue changed during recovery preparation.");
        journal = await this.publishUploadHandoff(checkpoint, current, current, state);
      });
    }
    if (checkpoint && sha256(Buffer.from(await this.fsp.readFile(this.uploadTransferPath, "utf8"))) !== journal.checkpoint_sha256 &&
        // A current attempt's transfer ID/timestamp may have been filled in by
        // immutable resume. Its request, plan and attempt must still be exact.
        !(isModernUploadCheckpoint(journal.checkpoint) && sameUploadAttempt(checkpoint, journal.checkpoint))) {
      throw this.uploadRecoveryError("The checkpoint changed after recovery was published.");
    }
    if (await readApplyJournalStrict(this.fsp, this.applyJournalPath)) throw this.uploadRecoveryError("Finish interrupted apply recovery before recovering the upload.");
    await this.protectUploadRecoveryCommits([journal.old_commit, journal.original_base,
      journal.checkpoint.transfer_request.expected_device_ref, journal.checkpoint.transfer_request.client_known_main,
      journal.successor_commit, journal.successor_queue.expected_device_ref,
      journal.successor_queue.pending_proposal_base, journal.successor_queue.pending_upload_base,
      journal.checkpoint.directory_proposal?.base_main,
      ...(journal.checkpoint.directory_proposal?.intents || []).map((intent) => intent.base_main)]);
    const oldObjects = new Set(await this.collectIncrementalPackObjects(journal.old_commit, []));
    if (journal.checkpoint.groups.some((group) => group.some((oid) => !oldObjects.has(oid)))) {
      throw this.uploadRecoveryError("The archived object plan contains objects outside the protected proposal.");
    }
    if (!journal.result) {
      const result = await this.reconcileUploadCheckpointHandoff(journal, state, await this.readDeviceToken());
      if (!isUploadRecoveryResult(result)) throw this.uploadRecoveryError("The server did not return a valid integration result.");
      const replayCheckpoint = await this.readUploadCheckpoint(path.join(this.obtsDir, "upload-recovery-transfer.json"));
      if (replayCheckpoint && !isUploadRecoveryReplay(replayCheckpoint, journal.checkpoint)) throw this.uploadRecoveryError("The replay checkpoint does not match the reconciled proposal.");
      journal = await this.writeUploadRecovery(Object.assign({}, journal, { phase: "result", result, replay_checkpoint: replayCheckpoint }));
    }
    return await this.settleUploadCheckpointHandoff(journal);
  }

  async reconcileUploadCheckpointHandoff(journal, state, token) {
    const checkpoint = journal.checkpoint;
    if (checkpoint.transfer_id) {
      const response = await fetchWithTimeout(
        this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${checkpoint.transfer_id}`),
        { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) {
        const descriptor = await response.json();
        this.validateUploadDescriptor(descriptor, checkpoint);
        if (descriptor.status === "completed") return this.completedTransferResult(descriptor);
        if (descriptor.status === "processing") return await this.pollPushTransfer(state, token, descriptor, checkpoint);
        if (!["open", "rejected"].includes(descriptor.status)) throw this.uploadRecoveryError("The old transfer has an unknown status.");
      } else if (response.status !== 404 && response.status !== 410) await throwResponseError(response);
    }
    const capabilities = await this.syncCapabilities();
    if (!capabilities.capabilities.includes("git-object-pack-chunks-v1")) throw this.uploadRecoveryError("Update the server before recovering this upload.");
    const modern = isModernUploadCheckpoint(checkpoint);
    const replayPath = modern ? this.uploadTransferPath : path.join(this.obtsDir, "upload-recovery-transfer.json");
    const replayCheckpoint = await this.readUploadCheckpoint(replayPath);
    if (!modern && replayCheckpoint && !isUploadRecoveryReplay(replayCheckpoint, checkpoint)) {
      throw this.uploadRecoveryError("The recovery attempt does not match the saved proposal.");
    }
    const rootIgnoreOid = await this.validateUploadTargetRootIgnore(journal.old_commit);
    // Keep the original main/base for planning even if rebuild advanced local_main.
    const replayState = Object.assign({}, state, { local_main: checkpoint.transfer_request.client_known_main });
    return await this.pushInChunks(replayState, journal.old_queue, token, checkpoint.directory_proposal,
      capabilities, rootIgnoreOid, false, journal.original_base, { checkpointPath: replayPath, recovery: true });
  }

  validateUploadDescriptor(descriptor, checkpoint) {
    if (!descriptor || descriptor.target_commit !== checkpoint.target_commit ||
        (checkpoint.transfer_id && descriptor.transfer_id !== checkpoint.transfer_id) ||
        descriptor.chunk_count !== checkpoint.groups.length) {
      throw this.uploadRecoveryError("The server transfer identity does not match the saved request.");
    }
  }

  async settleUploadCheckpointHandoff(journal) {
    const replayCheckpoint = await this.readUploadCheckpoint(path.join(this.obtsDir, "upload-recovery-transfer.json"));
    if (replayCheckpoint && (!journal.replay_checkpoint || !sameUploadAttempt(replayCheckpoint, journal.replay_checkpoint) ||
        replayCheckpoint.transfer_id !== journal.replay_checkpoint.transfer_id)) {
      throw this.uploadRecoveryError("The replay checkpoint changed before settlement.");
    }
    const checkpoint = await this.readUploadCheckpoint();
    if (checkpoint && sha256(Buffer.from(await this.fsp.readFile(this.uploadTransferPath, "utf8"))) !== journal.checkpoint_sha256 &&
        !(isModernUploadCheckpoint(journal.checkpoint) && sameUploadAttempt(checkpoint, journal.checkpoint))) {
      throw this.uploadRecoveryError("The checkpoint changed before its result could be settled.");
    }
    const result = journal.result;
    const proposal = journal.checkpoint.directory_proposal;
    const ack = result.directory_ack;
    if (result.status !== "conflicted" && proposal) {
      const expected = (proposal.intents || []).map(directoryIntentGenerationKey).sort();
      if (!Array.isArray(ack?.acknowledged_intents) || ack.acknowledged_intents.some((intent) =>
        !intent || typeof intent.intent_id !== "string" || !Number.isSafeInteger(intent.generation) || intent.generation < 0)) {
        throw this.uploadRecoveryError("The old directory acknowledgement is malformed.");
      }
      const received = ack.acknowledged_intents.map(directoryIntentGenerationKey).sort();
      if (!ack || ack.proposal_id !== proposal.proposal_id ||
          !["accepted", ...(result.status === "noop" ? ["duplicate"] : [])].includes(ack.status) ||
          stableJson(expected) !== stableJson(received)) {
        throw this.uploadRecoveryError("The old directory proposal lacks an exact server acknowledgement.");
      }
    }
    await this.recordStaleProposalResult(journal.old_queue, result, true);
    await this.mutateQueue(async () => {
      const current = await this.readQueue();
      const successor = journal.successor_queue;
      const nextCommit = successor.pending_commit === journal.old_commit ? null : successor.pending_commit;
      if (![journal.old_commit, successor.pending_commit, nextCommit].includes(current.pending_commit) ||
          (current.pending_commit === successor.pending_commit && current.pending_commit &&
            ((current.pending_proposal_base || null) !== (successor.pending_proposal_base || null) ||
             ![successor.expected_device_ref, result.device_ref].includes(current.expected_device_ref) ||
             (Object.hasOwn(current, "pending_upload_base") && current.pending_upload_base !== successor.pending_upload_base)))) {
        throw this.uploadRecoveryError("The active queue no longer belongs to this handoff.");
      }
      const hints = [...new Set([...(current.changed_paths || []), ...successor.changed_paths])].sort();
      await writeJson(this.fsp, this.queuePath, this.normalizedQueueForWrite(Object.assign({}, successor, {
        pending_commit: nextCommit, expected_device_ref: result.device_ref,
        // Only the old proposal was classified as conflicted. Marking a saved
        // successor conflicted would let resolution apply discard its bytes.
        status: nextCommit ? "queued_local" : result.status === "conflicted" ? "conflicted" : hints.length ? "queued_local" : "idle",
        change_seq: Math.max(current.change_seq || 0, successor.change_seq || 0), changed_paths: hints, updated_at: nowIso()
      }), current));
    });
    const currentState = await this.readState();
    const settledQueue = await this.readQueue();
    await this.writeState(Object.assign({}, currentState, {
      server_device_ref: result.device_ref,
      local_head: await this.resolveRef("refs/heads/local") || currentState.local_head,
      status_label: result.status === "conflicted" ? "Review needed" : settledQueue.pending_commit ? "Ahead" : result.main !== currentState.local_main ? "Behind" : "Checking",
      last_error_code: result.status === "conflicted" ? "conflict_review_required" : null,
      last_event_seq: Math.max(currentState.last_event_seq || 0, result.event_seq || 0), updated_at: nowIso()
    }));
    if (result.status !== "conflicted" && proposal) await this.clearAcknowledgedDirectoryIntents(ack.acknowledged_intents);
    const archivePath = path.join(this.obtsDir, "upload-recovery", `${journal.checkpoint_sha256}.json`);
    await writeJson(this.fsp, archivePath, journal);
    const archive = await readRecoveryJsonStrict(this.fsp, archivePath, "upload_checkpoint_recovery_required", "The recovery archive could not be verified.");
    if (!isUploadCheckpointHandoff(archive) || stableJson(archive) !== stableJson(journal)) throw this.uploadRecoveryError("The recovery archive changed.");
    await this.fsp.rm(this.uploadTransferPath, { force: true });
    await this.fsp.rm(path.join(this.obtsDir, "upload-recovery-transfer.json"), { force: true });
    await this.fsp.rm(this.uploadRecoveryPath, { force: true });
    return result;
  }

  async recoverUploadCheckpoint() {
    await this.initialize();
    const result = await this.recoverUploadCheckpointIfNeeded();
    if (!result && await this.readUploadCheckpoint()) await this.uploadQueuedCommit(await this.readQueue());
    return { status: (await this.readState()).status_label };
  }

  async putPushChunk({ vaultId, token, transferId, index, packfile }) {
    const response = await fetchWithTimeout(
      this.url(`/api/v1/vaults/${vaultId}/sync/push-transfers/${transferId}/chunks/${index}`),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-git-packed-objects",
          "x-obts-chunk-sha256": sha256(packfile)
        },
        body: packfile
      }
    );
    if (!response.ok) await throwResponseError(response);
  }

  async queuedCommitRootPolicyIsStale(commit) {
    const policy = await this.readRootIgnorePolicy();
    const entries = await this.flattenTree(commit);
    const pinnedOid = entries.get(".gitignore")?.oid ?? null;
    if (pinnedOid !== policy.oid) return true;
    for (const filePath of entries.keys()) {
      if (isSyncableVaultPath(filePath) && policy.policy.ignores(filePath)) return true;
    }
    return false;
  }

  async rebuildQueuedCommitForRootPolicy(commit, state, queue) {
    if (queue.status === "blocked_recovery" || !(await this.commitExists(commit))) return null;
    const { commit: parsed } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: commit });
    const parents = Array.isArray(parsed.parent) ? parsed.parent : [];
    if (parents.length > 1) return null;
    const parent = parents[0] ?? null;
    const parentIsAccepted = Boolean(parent) && (
      (state.server_device_ref && await this.isAncestor(parent, state.server_device_ref)) ||
      (state.local_main && await this.isAncestor(parent, state.local_main))
    );
    if (!parentIsAccepted) return null;
    const policy = await this.readRootIgnorePolicy();
    const entries = await this.flattenTree(commit);
    const nextEntries = new Map();
    for (const [filePath, entry] of entries) {
      if (!isSyncableVaultPath(filePath) || filePath === ".gitignore") continue;
      if (policy.policy.ignores(filePath)) continue;
      nextEntries.set(filePath, entry);
    }
    if (policy.bytes !== null) {
      const oid = await git.writeBlob({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, blob: policy.bytes });
      nextEntries.set(".gitignore", { mode: "100644", path: ".gitignore", oid, type: "blob" });
    }
    const tree = await this.writeTreeFromEntries(nextEntries);
    if (tree === parsed.tree) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const identity = { name: "obts device", email: "device@obts.local", timestamp, timezoneOffset: new Date().getTimezoneOffset() };
    const rebuilt = await git.writeCommit({
      fs: this.fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      commit: { tree, parent: parent ? [parent] : [], message: parsed.message, author: identity, committer: identity }
    });
    const localRef = await this.resolveRef("refs/heads/local");
    if (localRef !== commit && !(localRef === state.local_main && localRef === state.local_head &&
        (await this.readQueue()).pending_commit === commit && (await this.readQueue()).pending_proposal_base === queue.pending_proposal_base))
      throw new ObtsBlockedError("stale_intent_mismatch", "The replacement has no provable local ref owner.");
    await this.mutateStaleProvenance(async (saved) => {
      saved.queued_replacement = { old_commit: commit, old_tree: parsed.tree, new_commit: rebuilt, new_tree: tree,
        local_ref: localRef, base: queue.pending_proposal_base || null };
      for (const held of saved.held_proposals.filter((h) => h.commit === commit)) {
        held.commit = rebuilt;
        held.replacement = { old_commit: commit, old_tree: parsed.tree, new_commit: rebuilt, new_tree: tree, local_ref: localRef, base: queue.pending_proposal_base || null };
        for (const p of Object.keys(held.fallbacks)) {
          if (saved.obligations[p]?.base === commit) saved.obligations[p].base = rebuilt;
          for (const horizon of saved.horizons) if (horizon.held_bases?.[p] === commit) horizon.held_bases[p] = rebuilt;
        }
      }
      if (saved.intent?.commit === commit) saved.intent = Object.assign({}, saved.intent, { commit: rebuilt, tree, parent,
        replacement: { old_commit: commit, old_tree: parsed.tree, new_commit: rebuilt, new_tree: tree }
      });
    });
    await this.updateRef("refs/heads/local", rebuilt, localRef);
    const nextQueue = Object.assign({}, queue, {
      pending_commit: rebuilt,
      status: "queued_local",
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeQueue(nextQueue);
    const nextState = Object.assign({}, await this.readState(), {
      local_head: rebuilt,
      status_label: "Ahead",
      last_error_code: null,
      updated_at: nowIso()
    });
    await this.writeState(nextState);
    await this.mutateStaleProvenance(async (saved) => {
      saved.queued_replacement = null;
      for (const held of saved.held_proposals) delete held.replacement;
    });
    return { queue: nextQueue, state: nextState };
  }

  async validateUploadTargetRootIgnore(commit) {
    const entries = new Map();
    await this.walkTree(commit, "", async (filePath, entry) => {
      assertValidLocalVaultPath(filePath);
      if (entry.type === "tree") {
        if (filePath === ".gitignore") throw new ObtsBlockedError("invalid_root_ignore", "Root .gitignore must be a regular blob.");
        return;
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !isSyncableVaultPath(filePath)) {
        throw new ObtsBlockedError("excluded_path", "Target commit contains an unsupported or excluded vault path.");
      }
      entries.set(filePath, entry);
    });
    const root = entries.get(".gitignore");
    if (root && (root.type !== "blob" || !["100644", "100755"].includes(root.mode))) {
      throw new ObtsBlockedError("invalid_root_ignore", "Target root .gitignore must be a regular blob.");
    }
    const bytes = root ? await this.readBlobOid(root.oid) : null;
    if (bytes && (await git.hashBlob({ object: bytes })).oid !== root.oid) {
      throw new ObtsBlockedError("root_ignore_oid_mismatch", "Target root ignore blob identity changed.");
    }
    const policy = createRootIgnorePolicy(bytes);
    for (const filePath of entries.keys()) {
      if (policy.ignores(filePath)) {
        throw new ObtsBlockedError("excluded_root_ignore_path", "Target commit contains an excluded vault path.");
      }
    }
    return root ? root.oid : null;
  }

  async verifyTransferredRootIgnore(manifest) {
    if (!manifest || !Object.hasOwn(manifest, "root_ignore_oid")) {
      throw new ObtsBlockedError("root_ignore_manifest_missing", "The server did not attest the target root ignore policy.");
    }
    const target = await this.targetApplyPolicy(manifest.target_main);
    if (target.oid !== manifest.root_ignore_oid) {
      throw new ObtsBlockedError("root_ignore_oid_mismatch", "The transferred root ignore policy differs from the target tree.");
    }
  }

  async targetApplyPolicy(commit, entries = null) {
    const targetEntries = entries || await this.listTreeBlobOids(commit);
    const oid = await this.validateUploadTargetRootIgnore(commit);
    const bytes = oid ? await this.readBlobOid(oid) : null;
    if (oid && (await git.hashBlob({ object: bytes })).oid !== oid) {
      throw new ObtsBlockedError("root_ignore_oid_mismatch", "Target root ignore blob identity changed.");
    }
    return { oid, policy: createRootIgnorePolicy(bytes), entries: targetEntries };
  }

  async validateApplyJournalPolicy(journal) {
    let target;
    try {
      target = await this.targetApplyPolicy(journal.target_main);
      if (journal.journal_version < 5) return target.oid === null;
      if (journal.target_root_ignore_oid !== target.oid) return false;
      const previous = journal.expected_prior_local_main
        ? await this.listTreeFiles(journal.expected_prior_local_main) : [];
      const physical = await this.listLocalVaultInventory("");
      const expected = this.localOnlyApplyPaths(target, previous, physical);
      const deferredConflicts = new Set();
      for (const localPath of expected) {
        const conflicts = [...journal.affected_paths, ...target.entries.keys()]
          .filter((targetPath) => changedPathsConflict(localPath, targetPath));
        for (const targetPath of conflicts) {
          if (journal.affected_paths.includes(targetPath)) deferredConflicts.add(targetPath);
        }
      }
      this.assertLocalOnlyApplyCollisions(journal.local_only_paths, target.entries);
      if (deferredConflicts.size > 0) {
        await this.recordDeferredApplyPaths(journal, [...deferredConflicts]);
      }
      return true;
    } catch {
      return false;
    }
  }

  localOnlyApplyPaths(target, previousFiles, physical) {
    const targetFiles = new Set(target.entries.keys());
    const targetDirs = new Set([...targetFiles].flatMap(directoryPrefixes));
    return [...new Set([...previousFiles, ...physical.files, ...physical.directories])]
      .filter((filePath) => isRecoverableApplyPath(filePath) &&
        target.policy.ignores(filePath, physical.directories.includes(filePath)) &&
        !targetFiles.has(filePath) &&
        !(targetDirs.has(filePath) && !physical.files.includes(filePath))).sort();
  }

  assertLocalOnlyApplyCollisions(paths, targetEntries) {
    for (const retained of paths) {
      for (const targetPath of targetEntries.keys()) {
        if (retained === targetPath || retained.startsWith(`${targetPath}/`)) {
          throw new ObtsBlockedError("local_only_collision", "Target file collides with retained local-only content.");
        }
      }
    }
  }

  async pushInChunks(state, queue, token, directoryProposal, capabilities, rootIgnoreOid, allowStaleRetry = true, proposalBaseOverride = undefined, options = {}) {
    const checkpointPath = options.checkpointPath || this.uploadTransferPath;
    const proposalBase = proposalBaseOverride === undefined ? this.proposalBase(queue, state) : proposalBaseOverride;
    const transferIdentity = sha256(Buffer.from(stableJson({
      target_commit: queue.pending_commit,
      ...(queue.pending_proposal_base ? { base_commit: queue.pending_proposal_base } : {}),
      root_ignore_capability: "root-ignore-v1",
      root_ignore_oid: rootIgnoreOid,
      expected_device_ref: queue.expected_device_ref,
      client_known_main: state.local_main,
      directory_proposal: directoryProposal,
      target_chunk_bytes: capabilities.target_chunk_bytes,
      max_chunk_bytes: capabilities.max_chunk_bytes
    })));
    let checkpoint = await this.readUploadCheckpoint(checkpointPath);
    let groups;
    let transferRequest;
    let attemptId;
    if (
      isModernUploadCheckpoint(checkpoint) && checkpoint.target_commit === queue.pending_commit &&
      checkpoint.transfer_request.vault_id === state.vault_id && checkpoint.transfer_request.device_id === state.device_id &&
      checkpoint.transfer_request.root_ignore_oid === rootIgnoreOid
    ) {
      groups = checkpoint.groups;
      transferRequest = checkpoint.transfer_request;
      attemptId = checkpoint.attempt_id;
    } else {
      if (checkpoint) throw new ObtsBlockedError("upload_checkpoint_mismatch", "Existing immutable upload attempt differs; explicit recovery is required.");
      this.reportOperationProgress("Preparing upload (planning objects)", "upload_prepare");
      groups = await this.planPackChunks(
        queue.pending_commit,
        [queue.expected_device_ref, state.local_main].filter(Boolean),
        capabilities.target_chunk_bytes,
        capabilities.max_chunk_bytes
      );
      if (groups.length > capabilities.max_transfer_chunks) {
        throw new ObtsBlockedError("invalid_transfer_plan", "Git transfer plan exceeds the server chunk limit.");
      }
      transferRequest = {
        api_version: API_VERSION,
        plugin_version: PLUGIN_VERSION,
        vault_id: state.vault_id,
        device_id: state.device_id,
        expected_device_ref: queue.expected_device_ref,
        target_commit: queue.pending_commit,
        root_ignore_capability: "root-ignore-v1",
        root_ignore_oid: rootIgnoreOid,
        client_known_main: state.local_main,
        ...(proposalBase ? { base_commit: proposalBase } : {}),
        ...(directoryProposal ? { directory_proposal: directoryProposal } : {}),
        chunk_count: groups.length,
        plan_sha256: sha256(Buffer.from(JSON.stringify(groups)))
      };
      attemptId = `xfer_${sha256(Buffer.from(stableJson(transferRequest))).slice(0, 32)}`;
      checkpoint = {
        version: 1,
        identity: transferIdentity,
        target_commit: queue.pending_commit,
        directory_proposal: directoryProposal,
        groups,
        transfer_request: transferRequest,
        attempt_id: attemptId,
        transfer_id: null,
        updated_at: nowIso()
      };
      await writeJson(this.fsp, checkpointPath, checkpoint);
    }
    if (!options.recovery) await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
      status: "uploading",
      attempts: Math.max(current.attempts || 0, queue.attempts || 0) + 1,
      updated_at: nowIso()
    }));
    await this.writeState(Object.assign({}, await this.readState(), { status_label: "Uploading", last_error_code: null, updated_at: nowIso() }));
    this.plugin.setStatus("Uploading");
    await this.reportDeviceStatus().catch(() => undefined);
    try {
      const createResponse = await fetchWithTimeout(this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers`), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(Object.assign({}, transferRequest, { attempt_id: attemptId }))
      });
      if (!createResponse.ok) await throwResponseError(createResponse);
      let descriptor = await createResponse.json();
      this.validateUploadDescriptor(descriptor, Object.assign({}, checkpoint, { transfer_id: null }));
      checkpoint = Object.assign({}, checkpoint, { transfer_id: descriptor.transfer_id, updated_at: nowIso() });
      await writeJson(this.fsp, checkpointPath, checkpoint);
      if (descriptor.status === "completed") return this.completedTransferResult(descriptor);
      if (descriptor.status === "rejected") this.throwRejectedTransfer(descriptor);
      if (descriptor.status === "processing") {
        return await this.pollPushTransfer(state, token, descriptor, checkpoint);
      }
      if (descriptor.status !== "open") {
        throw new ObtsBlockedError("transfer_closed", "The resumable transfer is closed without an accepted result.");
      }
      const received = new Set(descriptor.received_chunks || []);
      let uploadedChunks = [...received].filter((index) => Number.isInteger(index) && index >= 0 && index < groups.length).length;
      this.plugin.setStatus(`Uploading ${uploadedChunks}/${groups.length}`);
      for (let index = 0; index < groups.length; index += 1) {
        if (received.has(index)) continue;
        this.reportOperationProgress(
          `Uploading ${uploadedChunks}/${groups.length} (packing chunk ${index + 1}/${groups.length})`,
          "upload_prepare"
        );
        const packfile = await this.packObjectChunk(groups[index], capabilities.max_chunk_bytes);
        await this.putPushChunk({
          vaultId: state.vault_id,
          token,
          transferId: descriptor.transfer_id,
          index,
          packfile
        });
        uploadedChunks += 1;
        this.plugin.setStatus(`Uploading ${uploadedChunks}/${groups.length}`);
        await this.reportDeviceStatus().catch(() => undefined);
      }
      const useAsyncFinalize = capabilities.capabilities.includes("async-push-finalize-v1");
      const finalizeResponse = await fetchWithTimeout(
        this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${descriptor.transfer_id}/finalize`),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            ...(useAsyncFinalize ? { prefer: "respond-async" } : {})
          }
        }
      );
      if (!finalizeResponse.ok) await throwResponseError(finalizeResponse);
      descriptor = await finalizeResponse.json();
      if (!useAsyncFinalize) return descriptor;
      return await this.pollPushTransfer(state, token, descriptor, checkpoint);
    } catch (error) {
      if (allowStaleRetry && error instanceof ObtsTransportError && error.code === "stale_device_ref") {
        const self = await this.getDeviceSelf(token);
        const recoveredRef = self.server_device_ref;
        if (
          recoveredRef && recoveredRef !== queue.expected_device_ref &&
          await this.commitExists(recoveredRef) && await this.isAncestor(recoveredRef, queue.pending_commit)
        ) {
          const recoveredQueue = Object.assign({}, queue, { expected_device_ref: recoveredRef, status: "uploading", updated_at: nowIso() });
          await this.writeQueue(recoveredQueue);
          await this.writeState(Object.assign({}, state, { server_device_ref: recoveredRef, status_label: "Preparing upload", updated_at: nowIso() }));
          await this.fsp.rm(this.uploadTransferPath, { force: true });
          return await this.pushInChunks(Object.assign({}, state, { server_device_ref: recoveredRef }), recoveredQueue, token, directoryProposal, capabilities, rootIgnoreOid, false, proposalBaseOverride, options);
        }
      }
      throw error;
    }
  }

  async pollPushTransfer(state, token, descriptor, checkpoint = null) {
    await this.updatePushProcessingStatus(descriptor);
    while (true) {
      if (checkpoint) this.validateUploadDescriptor(descriptor, checkpoint);
      if (descriptor.status === "completed") return this.completedTransferResult(descriptor);
      if (descriptor.status === "rejected") this.throwRejectedTransfer(descriptor);
      if (descriptor.status === "open") {
        const retry = await fetchWithTimeout(
          this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${descriptor.transfer_id}/finalize`),
          { method: "POST", headers: { authorization: `Bearer ${token}`, prefer: "respond-async" } }
        );
        if (!retry.ok) await throwResponseError(retry);
        descriptor = await retry.json();
        continue;
      }
      if (descriptor.status !== "processing") {
        throw new ObtsBlockedError("transfer_closed", "The resumable transfer closed without an authoritative result.");
      }
      await this.updatePushProcessingStatus(descriptor);
      await new Promise((resolve) => setTimeout(resolve, Math.max(100, descriptor.poll_after_ms || 1000)));
      const response = await fetchWithTimeout(
        this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${descriptor.transfer_id}`),
        { headers: { authorization: `Bearer ${token}` } }
      );
      if (!response.ok) await throwResponseError(response);
      descriptor = await response.json();
    }
  }

  async updatePushProcessingStatus(descriptor) {
    if (descriptor.status !== "processing") return;
    const statusLabel = descriptor.processing_error_code ? "Server retrying" : "Merging";
    this.reportOperationProgress(statusLabel === "Merging" ? "Merging on server" : statusLabel, "upload_finalize");
    const current = await this.readState();
    if (current.status_label === statusLabel && current.last_error_code === null) return;
    await this.writeState(Object.assign({}, current, { status_label: statusLabel, last_error_code: null, updated_at: nowIso() }));
    this.plugin.setStatus(statusLabel);
    await this.reportDeviceStatus().catch(() => undefined);
  }

  completedTransferResult(descriptor) {
    if (!descriptor.result || descriptor.result.status === "rejected") {
      throw new ObtsBlockedError("transfer_closed", "The completed transfer is missing its accepted result.");
    }
    return descriptor.result;
  }

  throwRejectedTransfer(descriptor) {
    const result = descriptor.result;
    if (result && result.status === "rejected") {
      throw new ObtsTransportError(409, result.code, result.message);
    }
    throw new ObtsBlockedError("transfer_closed", "The server rejected the transfer without a durable result.");
  }

  async retryPushAfterStaleDeviceRef(state, queue, token, manifest, packfile) {
    const self = await this.getDeviceSelf(token);
    const recoveredRef = self.server_device_ref;
    if (!recoveredRef || recoveredRef === queue.expected_device_ref || !(await this.isAncestor(recoveredRef, queue.pending_commit))) {
      return null;
    }
    await this.updateQueuedCommit(queue.pending_commit, async (current) => Object.assign({}, current, {
      expected_device_ref: recoveredRef,
      status: "uploading",
      updated_at: nowIso()
    }));
    await this.writeState(Object.assign({}, state, {
      server_device_ref: recoveredRef,
      status_label: "Uploading",
      last_error_code: null,
      updated_at: nowIso()
    }));
    return await this.push(state.vault_id, token, Object.assign({}, manifest, {
      expected_device_ref: recoveredRef
    }), packfile);
  }

  async reconcileDeviceBlocked(fromCaughtError = false, triggeringErrorCode = null) {
    const initialState = await this.readState();
    if (!initialState.vault_id || !initialState.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    if (!fromCaughtError && initialState.last_error_code !== "device_blocked") {
      return { applied: false, status: initialState.status_label };
    }

    const attemptId = `rca_${randomHex(16)}`;
    const attempt = { attemptId, phase: "requesting_server", cursorGuard: "not_observed" };
    this.activeReconciliation = attempt;
    let self = null;
    let capturedState = initialState;
    let reconcileGuard = "not_observed";
    let reconcileTimestamp = "unknown";
    let reconcileError = "unknown";
    let reconcileCursors = "unknown";
    const diagnosticDetails = (details = {}) => Object.assign({
      attemptId,
      phase: attempt.phase,
      cursorGuard: attempt.cursorGuard,
      reconcileGuard,
      reconcileTimestamp,
      reconcileError,
      reconcileCursors,
      serverSelf: self,
      ...(capturedState ? {
        capturedState,
        cursorRelations: troubleshootingCursorRelationsForState(capturedState, self)
      } : {})
    }, details);
    void this.plugin.sendTroubleshootingSnapshot("reconcile_start", diagnosticDetails({
      outcome: "observed",
      safeErrorCode: triggeringErrorCode || initialState.last_error_code,
      requestOutcome: "not_attempted"
    }));
    try {
      const token = await this.readDeviceToken();
      self = await this.getDeviceSelf(token);
      attempt.phase = "checking_guard";
      if (self.vault_id !== initialState.vault_id || self.device_id !== initialState.device_id) {
        throw new ObtsBlockedError("device_identity_mismatch", "Server device identity does not match local sync state.");
      }
      await this.reconcileServerVaultStatus(self.vault_status, true);

      const state = await this.readState();
      capturedState = state;
      const timestampChanged = state.updated_at !== initialState.updated_at;
      const errorChanged = state.last_error_code !== initialState.last_error_code;
      const cursorsChanged = !sameStateCursors(state, initialState);
      reconcileTimestamp = timestampChanged ? "changed" : "unchanged";
      reconcileError = errorChanged ? "changed" : "unchanged";
      reconcileCursors = cursorsChanged ? "changed" : "unchanged";
      const guardChanges = [timestampChanged, errorChanged, cursorsChanged].filter(Boolean).length;
      reconcileGuard = guardChanges > 1
        ? "multiple"
        : timestampChanged
          ? "timestamp_changed"
          : errorChanged
            ? "error_changed"
            : cursorsChanged
              ? "cursor_changed"
              : "unchanged";
      const stateChangedDuringRequest = timestampChanged || errorChanged || cursorsChanged;
      void this.plugin.sendTroubleshootingSnapshot("reconcile_guard", diagnosticDetails({
        outcome: stateChangedDuringRequest ? "skipped" : "observed",
        safeErrorCode: state.last_error_code,
        requestOutcome: "succeeded",
        httpStatus: 200
      }));
      if (stateChangedDuringRequest || (!fromCaughtError && state.last_error_code !== "device_blocked")) {
        return { applied: false, status: state.status_label };
      }
      if (self.status === "review_needed") {
        const nextState = Object.assign({}, state, {
          server_device_ref: self.server_device_ref,
          status_label: "Review needed",
          last_error_code: "conflict_review_required",
          updated_at: nowIso()
        });
        await this.writeState(nextState);
        capturedState = await this.readState();
        attempt.phase = "finished";
        void this.plugin.sendTroubleshootingSnapshot("reconcile_finish", diagnosticDetails({
          outcome: "blocked",
          safeErrorCode: "conflict_review_required",
          requestOutcome: "succeeded",
          httpStatus: 200
        }));
        return { applied: false, status: "Conflict resolution needed" };
      }
      if (self.status === "blocked_recovery") {
        const nextState = Object.assign({}, state, {
          server_device_ref: self.server_device_ref,
          status_label: "Needs recovery",
          last_error_code: "server_recovery_required",
          updated_at: nowIso()
        });
        await this.writeState(nextState);
        capturedState = await this.readState();
        attempt.phase = "finished";
        void this.plugin.sendTroubleshootingSnapshot("reconcile_finish", diagnosticDetails({
          outcome: "blocked",
          safeErrorCode: "server_recovery_required",
          requestOutcome: "succeeded",
          httpStatus: 200
        }));
        return { applied: false, status: "Needs recovery" };
      }
      if (self.status === "revoked") {
        throw new ObtsBlockedError("device_revoked", "This device has been revoked on the server.");
      }

      const nextState = Object.assign({}, state, {
        server_device_ref: self.server_device_ref,
        status_label: self.current_main === state.local_main ? "Checking" : "Behind",
        last_error_code: null,
        updated_at: nowIso()
      });
      await this.writeState(nextState);
      capturedState = await this.readState();
      attempt.phase = "applying";
      const applied = await this.pullAndApply(true);
      capturedState = await this.readState();
      attempt.phase = "finished";
      void this.plugin.sendTroubleshootingSnapshot("reconcile_finish", diagnosticDetails({
        outcome: "succeeded",
        safeErrorCode: capturedState.last_error_code,
        requestOutcome: "succeeded",
        httpStatus: 200
      }));
      return { applied, status: capturedState.status_label };
    } catch (error) {
      if (attempt.phase === "applying") capturedState = null;
      const requestOutcome = error instanceof ObtsTransportError
        ? error.status === 0
          ? "transport_failed"
          : isPermanentTransportError(error)
            ? "blocked"
            : "http_failed"
        : self
          ? "succeeded"
          : "failed";
      void this.plugin.sendTroubleshootingSnapshot("reconcile_failure", diagnosticDetails({
        outcome: error instanceof ObtsBlockedError || isPermanentTransportError(error) ? "blocked" : "failed",
        safeErrorCode: error && typeof error === "object" ? error.code : null,
        requestOutcome,
        httpStatus: error instanceof ObtsTransportError ? error.status : self ? 200 : null
      }));
      throw error;
    } finally {
      if (this.activeReconciliation === attempt) this.activeReconciliation = null;
    }
  }

  async recoverUnacknowledgedServerApply() {
    const state = await this.readState();
    const queue = await this.readQueue();
    if (
      !state.vault_id || !state.device_id || !state.local_main ||
      state.local_head !== state.local_main || queue.pending_commit || queue.status !== "idle"
    ) {
      return false;
    }
    const mayNeedRecovery = state.last_error_code === "sync_error" ||
      (state.last_applied_event_seq || 0) < (state.last_event_seq || 0);
    if (!mayNeedRecovery) return false;
    const token = await this.readDeviceToken();
    const self = await this.getDeviceSelf(token);
    await this.reconcileServerVaultStatus(self.vault_status, true);
    if (self.last_applied_main === state.local_main && (self.last_applied_event_seq || 0) > (state.last_applied_event_seq || 0)) {
      await this.writeState(Object.assign({}, state, {
        last_applied_event_seq: self.last_applied_event_seq,
        updated_at: nowIso()
      }));
    }
    if (self.current_main !== state.local_main || self.last_applied_main === self.current_main) {
      return false;
    }
    const pulled = await this.pull(
      state.vault_id,
      state.device_id,
      token,
      state.local_main,
      "latest",
      Number.isSafeInteger(self.last_applied_event_seq) ? self.last_applied_event_seq : 0
    );
    await this.importPack(pulled.packfile);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    const directoryClassification = await this.classifyDirectoryIntentsForRecovery(
      pulled.manifest.directory_intents || []
    );
    if (directoryClassification.ambiguous.length > 0 || directoryClassification.superseded.length > 0) {
      const recovery = await this.stageDirectoryRecoveryDecision({
        state,
        serverState: self,
        manifest: pulled.manifest,
        classification: directoryClassification,
        automatic: true
      });
      await this.executeDirectoryRecoveryDecision(recovery);
      return true;
    }
    const applied = await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      true,
      [],
      true,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq,
      false,
      null,
      pulled.manifest.target_file_sizes || {}
    );
    if (!applied) return false;
    await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    await this.clearResolvedConflictQueue();
    await this.settleAppliedQueue();
    return true;
  }

  async readDurableCatchup() {
    const saved = await readRecoveryJsonStrict(this.fsp, this.catchupPath, "catchup_recovery_required", "The saved catch-up state is unreadable. Preserve local files and recovery evidence.");
    if (!saved) return null;
    const state = await this.readState();
    if (saved.version !== 1 || saved.vault_id !== state.vault_id || saved.device_id !== state.device_id ||
      !isGitObjectId(saved.target_main) || !isGitObjectId(saved.local_head) ||
      (saved.accepted_ref !== null && !isGitObjectId(saved.accepted_ref))) {
      throw new ObtsBlockedError("catchup_recovery_required", "The saved catch-up identity is invalid. Preserve local files and recovery evidence.");
    }
    return saved;
  }

  async resumeDurableCatchup() {
    const saved = await this.readDurableCatchup();
    if (!saved) return false;
    await this.flushEditorBuffersToDisk();
    const files = await this.scanSyncableFiles((await this.readRootIgnorePolicy()).policy);
    if (await this.resolveRef("refs/heads/local") !== saved.local_head || !(await this.commitExists(saved.local_head)) ||
      !(await this.localContentMatchesTree(files, saved.local_head)) ||
      (await this.readDirectoryState()).pending_intents.length > 0) {
      throw new ObtsBlockedError("catchup_local_changes", "Catch-up paused to preserve local edits. Make a copy of the edited files outside this vault, restore those files to their contents immediately after the interrupted apply using local history or recovery copies, then resume sync and reapply your edits. Keep the catch-up journal and recovery evidence.");
    }
    const queue = await this.readQueue();
    if (queue.pending_commit) throw new ObtsBlockedError("catchup_recovery_required", "A proposal overlaps interrupted catch-up. Preserve the queue and recovery evidence before continuing.");
    // Byte verification above proves these watcher hints describe the saved tree.
    await this.clearQueuedHintIfUnchanged(queue.change_seq || 0);
    return await this.pullAndApply(true);
  }

  async pullAndApply(allowDestructive, catchupPass = 0) {
    let state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return false;
    }
    this.throwIfSyncBlocked(state);
    state = await this.readState();
    // A pending applied-main acknowledgement must settle before this device
    // pulls newer state. Both pull routes keep a single delivered-snapshot
    // slot per device, so pulling newer state here would replace the evidence
    // the retry needs and permanently block the acknowledgement.
    const pendingAck = await this.readPendingAppliedAcknowledgement();
    if (pendingAck) {
      state = await this.readState();
      if (state.local_main !== pendingAck.target_main) {
        throw new ObtsBlockedError("applied_main_acknowledgement_failed", "Local state does not match the pending applied main acknowledgement.");
      }
      await this.retryPendingAppliedAcknowledgement();
      state = await this.readState();
    }
    const token = await this.readDeviceToken();
    const retainedCheckpoint = await readRecoveryJsonStrict(this.fsp, this.pullTransferPath, "invalid_transfer_checkpoint", "The saved pull checkpoint is unreadable. Preserve it for recovery.");
    const pulled = await this.pull(
      state.vault_id,
      state.device_id,
      token,
      state.local_main,
      "latest",
      state.last_applied_event_seq || 0
    );
    await this.importPack(pulled.packfile);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    state = await this.readState();
    const targetPolicy = await this.targetApplyPolicy(pulled.manifest.target_main);
    if (!(await this.ensureNoQueuedLocalChangesBeforeApply(state, targetPolicy))) {
      return false;
    }
    let catchup = await this.readDurableCatchup();
    if (!catchup && retainedCheckpoint) {
      const acceptedRef = state.server_device_ref && state.local_head === state.server_device_ref &&
        await this.commitExists(state.server_device_ref) && await this.isAncestor(pulled.manifest.target_main, state.server_device_ref)
        ? state.server_device_ref : null;
      catchup = { version: 1, vault_id: state.vault_id, device_id: state.device_id,
        target_main: pulled.manifest.target_main, local_head: state.local_head || pulled.manifest.target_main, accepted_ref: acceptedRef };
      await writeJson(this.fsp, this.catchupPath, catchup);
    }
    if (catchup?.accepted_ref && pulled.manifest.target_main !== catchup.target_main &&
      !(await this.isAncestor(catchup.accepted_ref, pulled.manifest.target_main))) {
      throw new ObtsBlockedError("catchup_recovery_required", "The catch-up target does not include accepted device history. Preserve local files and recovery evidence.");
    }
    const applied = await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      allowDestructive,
      [],
      true,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq,
      false,
      null,
      pulled.manifest.target_file_sizes || {}
    );
    if (!applied) return false;
    await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    await this.clearAcknowledgedDirectoryIntents(pulled.manifest.directory_acknowledgements || []);
    await this.clearResolvedConflictQueue();
    await this.settleAppliedQueue();
    const appliedState = await this.readState();
    const appliedQueue = await this.readQueue();
    if (catchup && !appliedQueue.pending_commit && appliedQueue.status !== "queued_local" && !(appliedQueue.changed_paths || []).length) {
      const self = await this.getDeviceSelf(token);
      if (self.vault_id !== appliedState.vault_id || self.device_id !== appliedState.device_id) {
        throw new ObtsBlockedError("device_identity_mismatch", "Server device identity does not match local sync state.");
      }
      // The retained snapshot is acknowledged before observing and pulling a
      // newer canonical target, including our own already-accepted proposal.
      // Bound the recursion: a vault that advances on every pass keeps its
      // journal and status Behind for the next scheduled sync instead of
      // spinning network and battery here.
      if (self.current_main !== appliedState.local_main) {
        if (catchupPass >= 4) return false;
        return await this.pullAndApply(allowDestructive, catchupPass + 1);
      }
      if (catchup.accepted_ref && !(await this.isAncestor(catchup.accepted_ref, appliedState.local_head))) {
        throw new ObtsBlockedError("catchup_recovery_required", "Accepted device history is not restored. Preserve the catch-up journal and local recovery evidence.");
      }
      await this.fsp.rm(this.catchupPath, { force: true });
      const retiredState = await this.readState();
      if (retiredState.status_label === "Behind" && !retiredState.last_error_code) {
        // The retained snapshot is applied, acknowledged and canonical: this
        // device is fully caught up, not merely behind the snapshot it loaded.
        await this.writeState(Object.assign({}, retiredState, { status_label: "Synced", updated_at: nowIso() }));
      }
    }
    return true;
  }

  async pollRemoteEventsAndApply() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return { applied: false, status: "Not paired" };
    }
    const wasConflictBlocked = state.last_error_code === "conflict_review_required";
    if (!wasConflictBlocked) {
      this.throwIfSyncBlocked(state);
    }
    const after = Number.isSafeInteger(state.last_event_seq) && state.last_event_seq >= 0 ? state.last_event_seq : 0;
    const token = await this.readDeviceToken();
    let page;
    try {
      page = await this.pollEvents(state.vault_id, token, after);
    } catch (error) {
      if (error instanceof ObtsTransportError && error.code === "event_cursor_expired") {
        const currentEventSeq = error.details && Number.isSafeInteger(error.details.current_event_seq) ? error.details.current_event_seq : after;
        const nextState = await this.readState();
        if (nextState.last_error_code === "conflict_review_required") {
          await this.writeState(Object.assign({}, nextState, {
            last_error_code: null,
            status_label: "Behind",
            last_event_seq: currentEventSeq,
            updated_at: nowIso()
          }));
        } else {
          await this.writeState(Object.assign({}, nextState, { last_event_seq: currentEventSeq, updated_at: nowIso() }));
        }
        try {
          const applied = await this.pullAndApply(true);
          const refreshed = await this.uploadAutoPreservedChanges(applied);
          return { applied, status: refreshed.status_label };
        } catch (pullError) {
          if (wasConflictBlocked && pullError instanceof ObtsTransportError && pullError.code === "device_blocked") {
            await this.writeState(Object.assign({}, await this.readState(), {
              last_error_code: "conflict_review_required",
              status_label: "Review needed",
              last_event_seq: currentEventSeq,
              updated_at: nowIso()
            }));
            return { applied: false, status: "Conflict resolution needed" };
          }
          throw pullError;
        }
      }
      throw error;
    }
    const currentState = await this.readState();
    const shouldPull = page.events.some((event) => {
      const main = event && event.commit_cursors ? event.commit_cursors.main : null;
      const hasNewMain = typeof main === "string" && main !== currentState.local_main;
      const hasDirectoryChanges = Array.isArray(event && event.payload && event.payload.directory_intents) &&
        event.payload.directory_intents.length > 0 && event.event_seq > (currentState.last_applied_event_seq || 0);
      if (wasConflictBlocked) {
        return event.event_type === "conflict_resolved" && (hasNewMain || hasDirectoryChanges);
      }
      return (event.event_type === "main_advanced" || event.event_type === "conflict_resolved") &&
        (hasNewMain || hasDirectoryChanges);
    });
    if (!shouldPull) {
      await this.writeState(Object.assign({}, currentState, { last_event_seq: page.current_event_seq, updated_at: nowIso() }));
      if (currentState.status_label !== "Behind" && !wasConflictBlocked) {
        return { applied: false, status: currentState.status_label };
      }
      const self = await this.getDeviceSelf(token);
      if (self.vault_id !== currentState.vault_id || self.device_id !== currentState.device_id) {
        throw new ObtsBlockedError("device_identity_mismatch", "Server device identity does not match local sync state.");
      }
      await this.reconcileServerVaultStatus(self.vault_status, true);
      const authoritativeState = await this.readState();
      if (self.status === "review_needed") {
        await this.writeState(Object.assign({}, authoritativeState, {
          server_device_ref: self.server_device_ref,
          status_label: "Review needed",
          last_error_code: "conflict_review_required",
          updated_at: nowIso()
        }));
        return { applied: false, status: "Conflict resolution needed" };
      }
      if (self.status === "blocked_recovery") {
        await this.writeState(Object.assign({}, authoritativeState, {
          server_device_ref: self.server_device_ref,
          status_label: "Needs recovery",
          last_error_code: "server_recovery_required",
          updated_at: nowIso()
        }));
        return { applied: false, status: "Needs recovery" };
      }
      if (self.status === "revoked") {
        throw new ObtsBlockedError("device_revoked", "This device has been revoked on the server.");
      }
      if (self.current_main === authoritativeState.local_main) {
        return { applied: false, status: authoritativeState.status_label };
      }
      await this.writeState(Object.assign({}, authoritativeState, {
        server_device_ref: self.server_device_ref,
        status_label: "Behind",
        last_error_code: null,
        updated_at: nowIso()
      }));
      const applied = await this.pullAndApply(true);
      const finalState = await this.uploadAutoPreservedChanges(applied);
      return { applied, status: finalState.status_label };
    }
    if (wasConflictBlocked && currentState.last_error_code === "conflict_review_required") {
      await this.writeState(Object.assign({}, currentState, {
        last_error_code: null,
        status_label: "Behind",
        updated_at: nowIso()
      }));
    }
    const applied = await this.pullAndApply(true);
    const finalState = await this.uploadAutoPreservedChanges(applied);
    return { applied, status: finalState.status_label };
  }

  async uploadAutoPreservedChanges(applied) {
    let state = await this.readState();
    const queue = await this.readQueue();
    if (applied && queue.status === "queued_local" && queue.pending_commit && state.last_error_code === null) {
      await this.syncOnce({ confirmInitialImport: false });
      state = await this.readState();
    }
    return state;
  }

  async unpairCurrentDevice() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    const token = await this.readDeviceToken();
    await this.unpairDevice(state.vault_id, token);
    const baselineMain = state.local_main || await this.resolveRef("refs/heads/main");
    await this.fsp.rm(this.authPath, { force: true });
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
      last_applied_event_seq: 0,
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
    await this.fsp.rm(this.authPath, { force: true });
    await this.fsp.rm(this.pendingAppliedAckPath, { force: true });
    await this.fsp.rm(this.catchupPath, { force: true });
    await this.fsp.rm(this.pullTransferPath, { force: true });
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
      last_applied_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: nowIso()
    });
    return { status: "Not paired", recoveryBundleId };
  }

  async admitApplyRecovery() {
    let journal;
    try { journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath); }
    catch { throw new ObtsBlockedError("apply_journal_recovery_required", "The apply journal is unreadable or invalid. Preserve it and restore verified recovery evidence before resuming."); }
    if (!journal) return;
    await this.initialize();
    const remaining = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    if (remaining) {
      const reason = applyRecoveryReason(await this.readState(), remaining);
      throw new ObtsBlockedError("apply_journal_recovery_required", `The interrupted apply is still blocked (${reason}). Keep the setup journal, local files and recovery bundles. Resolve this recorded recovery issue before resuming; a new apply cannot replace the unfinished operation.`);
    }
  }

  async applyRecoveryValidationReason(journal, state) {
    try {
      if (!(await this.commitExists(journal.target_main))) return "recovery_evidence_missing";
      if (state.local_main && state.local_main !== journal.target_main && state.local_main !== journal.expected_prior_local_main) return "recovery_target_policy_mismatch";
      const ack = await this.readPendingAppliedAcknowledgement();
      if (ack && ack.target_main !== journal.target_main) return "recovery_target_policy_mismatch";
      const ref = await this.resolveRef("refs/heads/main");
      if (ref && ref !== journal.target_main && ref !== journal.expected_prior_local_main) return "recovery_target_policy_mismatch";
      if (journal.recovery_bundle_id !== null) {
        if (!/^rec_[A-Za-z0-9_-]+$/u.test(journal.recovery_bundle_id)) return "recovery_identity_mismatch";
        const bundle = path.join(this.obtsDir, "recovery", journal.recovery_bundle_id);
        const complete = await readRecoveryJsonStrict(this.fsp, path.join(bundle, "complete.json"), "recovery_state_corrupt", "Recovery completion evidence is unreadable.");
        const manifest = await readRecoveryJsonStrict(this.fsp, path.join(bundle, "manifest.json"), "recovery_state_corrupt", "Recovery manifest is unreadable.");
        if (!complete || !manifest) return "recovery_evidence_missing";
        if (complete.bundle_id !== journal.recovery_bundle_id || manifest.bundle_id !== journal.recovery_bundle_id) return "recovery_identity_mismatch";
        if (manifest.vault_id !== (state.vault_id || "unknown") || manifest.device_id !== (state.device_id || "unknown") ||
          manifest.operation_type !== journal.operation_type ||
          journal.journal_version >= 6 && manifest.apply_id !== journal.apply_id) return "recovery_identity_mismatch";
        if (manifest.target_main !== journal.target_main || stableJson(manifest.affected_paths) !== stableJson(journal.affected_paths)) return "recovery_target_policy_mismatch";
        const savedJournal = parseApplyJournal(await readJson(this.fsp, path.join(bundle, "journal", "apply-journal.json"), null));
        for (const key of ["apply_id", "target_main", "expected_prior_local_main", "expected_prior_local_device_ref", "affected_paths", "preflight_sha256", "preflight_fingerprints", "directory_intents", "explicit_directories", "pre_apply_directories", "pre_apply_directory_ctimes", "confirmed_directory_roots", "confirmed_directory_inventory", "preserve_local_changes", "event_seq", "target_file_sizes", "target_root_ignore_oid", "local_only_paths", "local_only_presence"]) {
          if (stableJson(savedJournal[key]) !== stableJson(journal[key])) return key === "apply_id" ? "recovery_identity_mismatch" : "recovery_target_policy_mismatch";
        }
        const checksums = await this.fsp.readFileBounded(path.join(bundle, "checksums.sha256"), this.fileBufferBudgetBytes, "utf8");
        if (checksums !== `${(await bundleChecksums(this.fsp, bundle, this.fileBufferBudgetBytes)).join("\n")}\n`) return "recovery_checksum_mismatch";
      } else if (journal.affected_paths.length > 0 && !["planned", "blocked_recovery"].includes(journal.phase)) {
        return "recovery_evidence_missing";
      }
      for (const filePath of journal.affected_paths) {
        if (await this.applyDisplacedEntryExists(journal, filePath) && !(await this.applyDisplacedEntryMatchesPreflight(journal, filePath))) return "recovery_checksum_mismatch";
      }
      return null;
    } catch (error) {
      return error?.code === "ENOENT" ? "recovery_evidence_missing" : "recovery_state_corrupt";
    }
  }

  async preApplyAuthoringBase(state, targetMain) {
    const queue = await this.readQueue();
    const saved = await this.readStaleProvenance();
    const accepted = queue.pending_commit
      ? { commit: queue.pending_commit, base: queue.pending_proposal_base }
      : saved.accepted_proposal;
    const p = accepted?.commit;
    const held = saved.held_proposals.find((h) => h.commit === p && ["merged", "noop"].includes(h.outcome));
    if (held) await this.mutateStaleProvenance(async (current) => {
      await this.settleHeldProposal(current, p, targetMain, true);
    });
    if (!p || state.local_head !== p || !await this.isAncestor(p, targetMain) ||
        state.local_main && await this.isAncestor(p, state.local_main)) return state.local_main;
    // Stale evidence must agree; never upgrade an uncertain stale identity to P.
    if (saved.intent?.commit === p && accepted.base !== saved.intent.base) return state.local_main;
    if (accepted.base) {
      const parsed = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: p })).commit;
      const parent = parsed.parent[0];
      if (!parent) return state.local_main;
      const prior = await this.listTreeBlobOids(parent);
      const tree = await this.listTreeBlobOids(p);
      const cohort = [...new Set([...prior.keys(), ...tree.keys()])].filter((q) => prior.get(q) !== tree.get(q));
      await this.mutateStaleProvenance(async (current) => {
        for (const q of cohort) {
          if (!current.obligations[q]) current.obligations[q] = { base: accepted.base, generation: 0, signature: "uncaptured" };
          else if (await this.isAncestor(accepted.base, current.obligations[q].base)) current.obligations[q].base = accepted.base;
        }
      });
    }
    return p;
  }

  async applyTargetMain(
    targetMain,
    changedPaths,
    allowDestructive,
    extraAffectedPaths = [],
    requireCleanVisibleState = false,
    directoryIntents = [],
    explicitDirectories = [],
    eventSeq = undefined,
    cleanVisibleStateVerified = false,
    confirmedDirectoryRecovery = null,
    targetFileSizes = {},
    consentBaselineBundleId = null,
    preserveConsentLocalPaths = false,
    consentBaselineContext = null,
    rebuild = false
  ) {
    await this.admitApplyRecovery();
    const pendingAck = await this.readPendingAppliedAcknowledgement();
    if (pendingAck) {
      await this.retryPendingAppliedAcknowledgement();
      if (pendingAck.target_main !== targetMain && await this.readPendingAppliedAcknowledgement()) throw new ObtsBlockedError("applied_main_acknowledgement_failed", "Settle the previous applied snapshot before another apply.");
    }
    const state = await this.readState();
    const targetPolicy = await this.targetApplyPolicy(targetMain);
    let compactedDirectoryIntents = compactDirectoryIntents(directoryIntents)
      .filter((intent) => isSyncableVaultPath(intent.path) && !targetPolicy.policy.ignores(intent.path, true));
    const explicitDirectorySet = Array.from(new Set(explicitDirectories))
      .filter((dirPath) => isSyncableVaultPath(dirPath) && !targetPolicy.policy.ignores(dirPath, true)).sort();
    const hasDirectoryWork = await this.hasActionableDirectoryWork(compactedDirectoryIntents, explicitDirectorySet, targetPolicy.policy);
    if (state.local_main === targetMain && extraAffectedPaths.length === 0 && !hasDirectoryWork) {
      await this.writePendingAppliedAcknowledgement(targetMain, eventSeq || 0);
      await this.writeState(Object.assign({}, state, {
        status_label: "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, eventSeq || 0),
        last_applied_event_seq: Math.max(state.last_applied_event_seq || 0, eventSeq || 0),
        updated_at: nowIso()
      }));
      return true;
    }
    if (requireCleanVisibleState && !cleanVisibleStateVerified && !(await this.ensureNoLocalChangesBeforeApply(state, targetPolicy))) {
      return false;
    }
    const applyId = `apply_${Date.now()}_${randomHex(8)}`;
    await this.acquireApplyLock(applyId);
    this.plugin.isApplying = true;
    try {
      await this.writeState(Object.assign({}, state, {
      status_label: "Applying",
      last_error_code: null,
      updated_at: nowIso()
    }));
      this.reportOperationProgress("Applying", "apply_recovery_prepare");
      const journal = {
      journal_version: 7,
        authoring_base: await this.preApplyAuthoringBase(state, targetMain),
      touched_paths: [],
      target_root_ignore_oid: targetPolicy.oid,
      local_only_paths: [],
      local_only_presence: {},
      deferred_local_paths: [],
      apply_id: applyId,
      operation_type: rebuild ? "rebuild_from_server" : "pull_apply",
      target_main: targetMain,
      target_file_sizes: isTargetFileSizeMap(targetFileSizes) ? Object.assign({}, targetFileSizes) : {},
      expected_prior_local_main: state.local_main,
      expected_prior_local_device_ref: state.server_device_ref,
      phase: "planned",
      affected_paths: [],
      preflight_sha256: {},
      preflight_fingerprints: {},
      directory_intents: compactedDirectoryIntents,
      explicit_directories: explicitDirectorySet,
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: confirmedDirectoryRecovery ? confirmedDirectoryRecovery.roots : [],
      confirmed_directory_inventory: confirmedDirectoryRecovery ? confirmedDirectoryRecovery.inventory : null,
      preserve_local_changes: requireCleanVisibleState,
      event_seq: Number.isSafeInteger(eventSeq) && eventSeq >= 0 ? eventSeq : null,
      recovery_bundle_id: null,
      last_completed_step: null,
      redacted_error_category: null
    };
      const targetEntries = targetPolicy.entries;
      let consentBaselineFingerprints = new Map();
      if (consentBaselineBundleId) {
        try {
          consentBaselineFingerprints = await this.readRecoveryBundleFingerprints(consentBaselineBundleId, consentBaselineContext);
        } catch {
          preserveConsentLocalPaths = true;
        }
      }
      const targetFiles = new Set(targetEntries.keys());
      const previousFiles = journal.authoring_base ? await this.listTreeFiles(journal.authoring_base) : [];
      const localVaultInventory = await this.listLocalVaultInventory("");
      journal.local_only_paths = this.localOnlyApplyPaths(targetPolicy, previousFiles, localVaultInventory);
      journal.local_only_presence = Object.fromEntries(journal.local_only_paths.map((filePath) => [
        filePath, localVaultInventory.files.includes(filePath) || localVaultInventory.directories.includes(filePath)
      ]));
      this.assertLocalOnlyApplyCollisions(journal.local_only_paths, targetEntries);
      const localOnly = new Set(journal.local_only_paths);
      const protectsPath = (filePath) => journal.local_only_paths.some((retained) =>
        retained === filePath || retained.startsWith(`${filePath}/`));
      const authoringEntries = journal.authoring_base ? await this.listTreeBlobOids(journal.authoring_base) : new Map();
      const affected = new Set((changedPaths || []).filter((filePath) => !protectsPath(filePath) &&
        authoringEntries.get(filePath) !== targetEntries.get(filePath)));
      for (const [filePath, fingerprint] of consentBaselineFingerprints) {
        if (fingerprint.kind === "file" && !protectsPath(filePath)) affected.add(filePath);
      }
      const previousMaterializedDirectories = new Set(previousFiles.flatMap((filePath) => directoryPrefixes(filePath)));
      const targetMaterializedDirectories = new Set(explicitDirectorySet);
      for (const filePath of targetFiles) {
        for (const dirPath of directoryPrefixes(filePath)) targetMaterializedDirectories.add(dirPath);
      }
      const protectsDirectory = (dirPath) => journal.local_only_paths.some((retained) =>
        retained === dirPath || retained.startsWith(`${dirPath}/`));
      const impliedDirectoryDeletes = topmostDirectories(
        [...previousMaterializedDirectories].filter((dirPath) => !targetMaterializedDirectories.has(dirPath) && !protectsDirectory(dirPath))
      ).map((dirPath) => ({ op: "delete", path: dirPath }));
      compactedDirectoryIntents = compactDirectoryIntents([
        ...compactedDirectoryIntents.filter((intent) => intent.op !== "delete" || !protectsDirectory(intent.path)),
        ...impliedDirectoryDeletes
      ]);
      journal.directory_intents = compactedDirectoryIntents;
      for (const previousPath of previousFiles) {
        if (!targetFiles.has(previousPath) && !localOnly.has(previousPath)) affected.add(previousPath);
      }
      for (const localPath of extraAffectedPaths) {
        if (!protectsPath(localPath)) affected.add(localPath);
      }
      const priorEntries = authoringEntries;
      for (const [filePath, oid] of targetEntries) {
        if (priorEntries.get(filePath) !== oid) affected.add(filePath);
      }
      if (preserveConsentLocalPaths) {
        journal.deferred_local_paths = this.expandDeferredApplyPaths(journal, new Set(), [...affected]);
      }
      const localVaultFiles = localVaultInventory.files;
      const preApplyDirectories = new Set(localVaultInventory.directories);
      journal.pre_apply_directories = [...preApplyDirectories].sort();
      journal.pre_apply_directory_ctimes = await this.captureDirectoryCreationTimes(journal.pre_apply_directories);
      for (const conflictPath of materializationConflictFiles(new Set([...targetFiles, ...affected]), localVaultFiles)) {
        if (localOnly.has(conflictPath)) {
          throw new ObtsBlockedError("local_only_collision", "Target file collides with retained local-only content.");
        }
        affected.add(conflictPath);
      }
      let affectedPaths = Array.from(affected).filter((filePath) => isRecoverableApplyPath(filePath)).sort();
      journal.affected_paths = affectedPaths;
      const directoryPreflightPaths = Array.from(new Set([
        ...compactedDirectoryIntents.filter((intent) => intent.op === "delete"
          ? preApplyDirectories.has(intent.path) : !preApplyDirectories.has(intent.path)).map((intent) => intent.path),
        ...explicitDirectorySet
      ])).filter((filePath) => isRecoverableApplyPath(filePath)).sort();
      const directoryPreflightBudget = createByteBudget(this.fileBufferBudgetBytes);
      const directoryPreflightValues = await runBoundedWork(directoryPreflightPaths, {
        concurrency: this.fileWorkConcurrency,
        yieldEvery: FILE_WORK_YIELD_EVERY
      }, async (filePath) => (await this.readRecoveryFileSnapshot(filePath, directoryPreflightBudget)).fingerprint);
      const directoryPreflight = new Map(directoryPreflightPaths.map((filePath, index) => [filePath, directoryPreflightValues[index]]));
      const expectedVisibleTrees = [];
      for (const commit of new Set([state.local_head, state.local_main, state.server_device_ref].filter(Boolean))) {
        if (await this.commitExists(commit)) expectedVisibleTrees.push(await this.listTreeBlobOids(commit));
      }
      let stagedRecovery = null;
      if (affectedPaths.length > 0) {
        try {
          stagedRecovery = await this.stageApplyRecoveryFiles(
            journal, affectedPaths, "Applying (preparing recovery)"
          );
          affectedPaths = journal.affected_paths;
        } catch {
          await this.block("recovery_bundle_failed", "Recovery bundle creation failed before apply.");
        }
        for (const result of stagedRecovery?.results || []) {
          journal.preflight_sha256[result.filePath] = result.fingerprint.kind === "file" ? result.fingerprint.sha256 : null;
          journal.preflight_fingerprints[result.filePath] = result.fingerprint;
        }
        if (consentBaselineFingerprints.size > 0 && stagedRecovery) {
          const locallyChangedPaths = stagedRecovery.results
            .filter((result) => {
              const expected = consentBaselineFingerprints.get(result.filePath) || { kind: "missing", sha256: null };
              return result.fingerprint.kind !== expected.kind ||
                (result.fingerprint.kind === "file" && result.fingerprint.sha256 !== expected.sha256);
            })
            .map((result) => result.filePath);
          journal.deferred_local_paths = this.expandDeferredApplyPaths(
            journal,
            new Set(),
            locallyChangedPaths
          );
        }
        if (requireCleanVisibleState && stagedRecovery && expectedVisibleTrees.length > 0) {
          const locallyChangedPaths = stagedRecovery.results
            .filter((result) => !this.fingerprintMatchesTarget(result.fingerprint, targetEntries.get(result.filePath)) &&
              !expectedVisibleTrees.some((entries) =>
                this.fingerprintMatchesTreePath(result.fingerprint, result.filePath, entries)
              ))
            .map((result) => result.filePath);
          journal.deferred_local_paths = this.expandDeferredApplyPaths(
            journal,
            new Set(),
            locallyChangedPaths
          );
        }
      }
      const alreadyMaterialized = new Set(journal.affected_paths.filter((p) =>
        this.fingerprintMatchesTarget(journal.preflight_fingerprints[p], targetEntries.get(p))));
      journal.touched_paths = [...new Set([
        ...journal.affected_paths.filter((p) => !alreadyMaterialized.has(p)),
        ...compactedDirectoryIntents.map((intent) => intent.path),
        ...[...targetMaterializedDirectories].filter((dir) => !preApplyDirectories.has(dir))
      ])].sort();
      await writeJson(this.fsp, this.applyJournalPath, journal);
      await this.retainApplyProvenance(journal);

      if (!(await this.validateApplyJournalPolicy(journal))) {
        await this.block("target_policy_changed", "The pinned target policy or retained local-only paths changed before apply.");
      }
      if (affectedPaths.length > 0) {
        if (!allowDestructive) {
          await this.fsp.rm(stagedRecovery.partialDir, { recursive: true, force: true }).catch(() => undefined);
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "destructive_apply_not_allowed";
          await writeJson(this.fsp, this.applyJournalPath, journal);
          await this.block("unsafe_local_state", "Destructive apply is not allowed in this mode.");
        }
        try {
          journal.recovery_bundle_id = await this.finalizeRecoveryBundle(
            stagedRecovery,
            "pull_apply",
            targetMain,
            affectedPaths,
            journal
          );
          journal.phase = "recovery_bundle_written";
          journal.last_completed_step = "recovery_bundle";
          await writeJson(this.fsp, this.applyJournalPath, journal);
        } catch {
          await this.fsp.rm(stagedRecovery.partialDir, { recursive: true, force: true }).catch(() => undefined);
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "recovery_bundle_failed";
          await writeJson(this.fsp, this.applyJournalPath, journal);
          await this.block("recovery_bundle_failed", "Recovery bundle creation failed before apply.");
        }
      }

      this.reportOperationProgress(
        affectedPaths.length > 0 ? `Applying (revalidating) 0/${affectedPaths.length}` : "Applying",
        "apply_preflight_revalidate"
      );
      const revalidationBudget = createByteBudget(this.fileBufferBudgetBytes);
      try {
        await runBoundedWork(affectedPaths.filter((filePath) => !journal.deferred_local_paths.includes(filePath)), {
          concurrency: this.fileWorkConcurrency,
          yieldEvery: FILE_WORK_YIELD_EVERY,
          onProgress: (completed, total) => this.reportOperationProgress(
            `Applying (revalidating) ${completed}/${total}`,
            "apply_preflight_revalidate"
          )
        }, async (filePath) => {
          const fingerprint = (await this.readRecoveryFileSnapshot(filePath, revalidationBudget)).fingerprint;
          if (!this.fingerprintMatchesPreflight(
            fingerprint,
            journal.preflight_sha256[filePath] || null,
            journal.preflight_fingerprints[filePath]
          )) {
            throw new LocalSnapshotChangedError(filePath);
          }
        });
        await runBoundedWork(directoryPreflightPaths.filter((filePath) => !journal.deferred_local_paths.some((deferred) => changedPathsConflict(filePath, deferred))), {
          concurrency: this.fileWorkConcurrency,
          yieldEvery: FILE_WORK_YIELD_EVERY
        }, async (filePath) => {
          const fingerprint = (await this.readRecoveryFileSnapshot(filePath, revalidationBudget)).fingerprint;
          if (!this.fingerprintMatchesPreflight(fingerprint, null, directoryPreflight.get(filePath))) {
            throw new LocalSnapshotChangedError(filePath);
          }
        });
      } catch (error) {
        if (error instanceof LocalSnapshotChangedError) {
          journal.deferred_local_paths = this.expandDeferredApplyPaths(
            journal,
            new Set(),
            [error.filePath]
          );
        } else {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "preflight_hash_changed";
          await writeJson(this.fsp, this.applyJournalPath, journal);
          await this.block("unsafe_local_state", "Apply preflight could not verify the local snapshot.");
        }
      }
      if (confirmedDirectoryRecovery) {
        const confirmedInventory = await this.captureDirectoryRecoveryInventory(confirmedDirectoryRecovery.roots);
        if (stableJson(confirmedInventory) !== stableJson(confirmedDirectoryRecovery.inventory)) {
          this.plugin.isApplying = false;
          await this.fsp.rm(this.applyJournalPath, { force: true });
          return false;
        }
      }
      if (!(await this.validateApplyJournalPolicy(journal))) {
        await this.block("target_policy_changed", "The pinned target policy or retained local-only paths changed before writing.");
      }
      journal.phase = "writing_files";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      await this.writeTargetFilesFromJournal(journal, targetEntries, alreadyMaterialized);
      const confirmedDirectoryCtimes = confirmedDirectoryRecovery
        ? Object.fromEntries(confirmedDirectoryRecovery.inventory.directories.map((entry) => [entry.path, entry.creation_time]))
        : journal.pre_apply_directory_ctimes;
      const removableDirectories = confirmedDirectoryRecovery
        ? new Set(confirmedDirectoryRecovery.inventory.directories.map((entry) => entry.path))
        : preApplyDirectories;
      const residualTombstoneDirectories = await this.applyDirectoryChanges(
        compactedDirectoryIntents,
        explicitDirectorySet,
        preApplyDirectories,
        confirmedDirectoryCtimes,
        removableDirectories,
        [...journal.local_only_paths, ...(journal.deferred_local_paths || [])],
        targetMain
      );

      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      const deferredAffectedPaths = new Set(journal.affected_paths.filter((filePath) =>
        (journal.deferred_local_paths || []).some((deferred) => changedPathsConflict(filePath, deferred))
      ));
      const mismatchedPaths = await this.affectedApplyPathsNotMatchingTarget(
        journal, targetEntries, false, deferredAffectedPaths
      );
      if (mismatchedPaths.length > 0) {
        await this.recordDeferredApplyPaths(journal, mismatchedPaths);
      }
      await this.retainApplyProvenance(journal, true);
      this.plugin.isApplying = false;
      await this.flushEditorBuffersToDisk();
      const capturedChangeSeq = (await this.readQueue()).change_seq || 0;
      let localScanPending = false;
      const shouldCapturePreservedChanges = requireCleanVisibleState || journal.deferred_local_paths.length > 0;
      const preserved = shouldCapturePreservedChanges
        ? await this.captureStableLocalChanges(targetEntries)
        : { paths: [], snapshot: null, stable: true, changedPath: null };
      this.reportOperationProgress("Applying (finishing)", "apply_finalize");
      let preservedLocalChangePaths = preserved.stable ? preserved.paths : [];
      let preservedLocalSnapshot = preserved.stable ? preserved.snapshot : null;
      let preservedDirectoryIntents = [];
      if (!preserved.stable) {
        if (preserved.changedPath) await this.recordDeferredApplyPaths(journal, [preserved.changedPath]);
        await this.markLocalApplyScanPending(journal, targetEntries, preserved.changedPath ? [preserved.changedPath] : []);
        localScanPending = true;
      } else if (preservedLocalChangePaths.length > 0) {
        await this.recordDeferredApplyPaths(journal, preservedLocalChangePaths);
        try {
          await this.createRecoveryBundle("rebuild_from_server", targetMain, preservedLocalChangePaths);
        } catch (error) {
          if (!(error instanceof LocalSnapshotChangedError)) throw error;
          preservedLocalChangePaths = [];
          preservedLocalSnapshot = null;
          await this.recordDeferredApplyPaths(journal, [error.filePath]);
          await this.markLocalApplyScanPending(journal, targetEntries, [error.filePath]);
          localScanPending = true;
        }
      }
      if (requireCleanVisibleState) {
        preservedDirectoryIntents = await this.preserveDirectoryChangesFromTarget(
          targetEntries,
          explicitDirectorySet,
          residualTombstoneDirectories
        );
      }
      this.reportOperationProgress("Applying (finishing)", "apply_finalize");
      const queueAfterCapture = await this.readQueue();
      localScanPending = localScanPending || queueAfterCapture.change_seq !== capturedChangeSeq ||
        queueAfterCapture.changed_paths.length > 0;
      if (!(await this.validateApplyJournalPolicy(journal))) {
        await this.block("target_policy_changed", "Retained local-only content changed during apply.");
      }
      await this.updateRef("refs/heads/main", targetMain, null, true);
      await this.updateRef("refs/heads/local", targetMain, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      await this.writeState(Object.assign({}, state, {
        local_main: targetMain,
        local_head: targetMain,
        status_label: preservedLocalChangePaths.length > 0 ? "Ahead" : localScanPending ? "Checking" : "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, eventSeq || 0),
        last_applied_event_seq: Math.max(state.last_applied_event_seq || 0, eventSeq || 0),
        updated_at: nowIso()
      }));
      if (!requireCleanVisibleState) await this.refreshDirectoryStateFromDisk();
      if (preservedLocalChangePaths.length > 0) {
        try {
          await this.queuePreservedLocalChanges(targetMain, state.server_device_ref, preservedLocalSnapshot);
        } catch (error) {
          if (!(error instanceof LocalSnapshotChangedError) &&
              !(error instanceof ObtsBlockedError && error.code === "local_snapshot_changed")) throw error;
          await this.recordDeferredApplyPaths(journal, [error.filePath || ".gitignore"]);
          await this.markLocalApplyScanPending(journal, targetEntries, [error.filePath || ".gitignore"]);
        }
      } else if (preservedDirectoryIntents.length > 0) {
        await this.queuePreservedDirectoryChanges(targetMain, state.server_device_ref);
      }
      await this.writePendingAppliedAcknowledgement(targetMain, eventSeq || 0);
      await this.clearApplyState();
      return true;
    } finally {
      this.plugin.isApplying = false;
      try { await this.releaseApplyLock(applyId); } catch {}
    }
  }

  async recoverBlockedApplyWithPreservedLocalChanges(journal, state) {
    if (journal.phase !== "blocked_recovery") return false;
    if (journal.redacted_error_category === "local_files_diverge_from_journal") {
      return await this.recoverDivergedApplyWithPreservedLocalChanges(journal, state);
    }
    if (journal.redacted_error_category !== "local_changed_during_apply") {
      return false;
    }
    this.plugin.setInitializationStage("Reading interrupted apply target commit", "recovery_target_commit");
    if (!(await this.commitExists(journal.target_main))) return false;
    const canRecoverFinalVisibleTree = journal.last_completed_step === "files_written" || journal.last_completed_step === "refs_updated";
    this.plugin.setInitializationStage("Reading interrupted apply target tree", "recovery_target_tree");
    const targetEntries = await this.listTreeBlobOids(journal.target_main);
    this.plugin.setInitializationStage("Validating interrupted apply files", "recovery_file_validation");
    let preservedLocalChangePaths = [];
    let preservedLocalSnapshot = null;
    if (canRecoverFinalVisibleTree) {
      const preserved = await this.localChangedPathsFromTree(targetEntries, true, { targetRootIgnoreOid: journal.target_root_ignore_oid });
      preservedLocalChangePaths = preserved.paths;
      preservedLocalSnapshot = preserved.snapshot;
    } else {
      if (!(await this.affectedApplyPathsMatchTarget(journal, targetEntries))) {
        return false;
      }
      preservedLocalChangePaths = await this.classifySafeResidualLocalChanges(state, journal, targetEntries);
      if (preservedLocalChangePaths.length === 0) {
        return false;
      }
    }
    try {
      await this.releaseApplyLock();
      await this.acquireApplyLock(journal.apply_id, true);
      this.plugin.isApplying = true;
      if (preservedLocalChangePaths.length > 0) {
        this.plugin.setInitializationStage("Writing interrupted apply recovery bundle", "recovery_bundle");
        await this.createRecoveryBundle("rebuild_from_server", journal.target_main, preservedLocalChangePaths);
      }
      this.plugin.setInitializationStage("Restoring interrupted directory changes", "recovery_file_apply");
      const residualTombstoneDirectories = await this.applyDirectoryChanges(
        journal.directory_intents || [],
        journal.explicit_directories || [],
        new Set(journal.pre_apply_directories || []),
        journal.confirmed_directory_inventory
          ? Object.fromEntries(journal.confirmed_directory_inventory.directories.map((entry) => [entry.path, entry.creation_time]))
          : journal.pre_apply_directory_ctimes || {},
        journal.confirmed_directory_inventory
          ? new Set(journal.confirmed_directory_inventory.directories.map((entry) => entry.path))
          : new Set(journal.pre_apply_directories || []),
        [...(journal.local_only_paths || []), ...(journal.deferred_local_paths || [])],
        journal.target_main
      );
      const preservedDirectoryIntents = journal.preserve_local_changes
        ? await this.preserveDirectoryChangesFromTarget(
          targetEntries,
          journal.explicit_directories || [],
          residualTombstoneDirectories,
          true
        )
        : [];
      this.plugin.setInitializationStage("Restoring interrupted apply refs", "recovery_refs");
      if (!(await this.validateApplyJournalPolicy(journal))) return false;
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      journal.redacted_error_category = null;
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Persisting interrupted apply state", "recovery_state");
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, journal.event_seq || 0),
        last_applied_event_seq: Math.max(state.last_applied_event_seq || 0, journal.event_seq || 0),
        updated_at: nowIso()
      }));
      if (!journal.preserve_local_changes) await this.refreshDirectoryStateFromDisk();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(journal.target_main, state.server_device_ref, preservedLocalSnapshot);
      } else if (preservedDirectoryIntents.length > 0) {
        await this.queuePreservedDirectoryChanges(journal.target_main, state.server_device_ref);
      }
      await this.writePendingAppliedAcknowledgement(journal.target_main, journal.event_seq || 0);
      await this.clearApplyState();
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step || "recovery_bundle";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return false;
    } finally {
      this.plugin.isApplying = false;
      try { await this.releaseApplyLock(journal.apply_id); } catch {}
    }
  }

  async recoverIncompleteApplyJournal(journal, state) {
    if (journal.phase === "blocked_recovery") return false;
    this.plugin.setInitializationStage("Reading interrupted apply target commit", "recovery_target_commit");
    if (!(await this.commitExists(journal.target_main))) {
      return false;
    }
    this.plugin.setInitializationStage("Reading interrupted apply target tree", "recovery_target_tree");
    const targetEntries = await this.listTreeBlobOids(journal.target_main);
    this.plugin.setInitializationStage("Validating interrupted apply files", "recovery_file_validation");
    const validation = await this.applyJournalMatchesCurrentFilesResilient(journal, targetEntries);
    const deferredPaths = validation.matches
      ? new Set(journal.deferred_local_paths || [])
      : this.expandDeferredDivergedPaths(journal, validation.targetMatchedPaths, validation.divergedPaths);
    const targetFileSizes = await this.recoverJournalTargetSizes(journal, targetEntries, validation.targetMatchedPaths, deferredPaths);
    if (!targetFileSizes) return false;
    return await this.completeInterruptedApply(journal, state, targetEntries, validation, deferredPaths, targetFileSizes);
  }

  async recoverDivergedApplyWithPreservedLocalChanges(journal, state) {
    this.plugin.setInitializationStage("Reading interrupted apply target commit", "recovery_target_commit");
    if (!(await this.commitExists(journal.target_main))) {
      return false;
    }
    this.plugin.setInitializationStage("Reading interrupted apply target tree", "recovery_target_tree");
    const targetEntries = await this.listTreeBlobOids(journal.target_main);
    this.plugin.setInitializationStage("Validating interrupted apply files", "recovery_file_validation");
    const validation = await this.applyJournalMatchesCurrentFilesResilient(journal, targetEntries);
    // A path that matches neither the recorded pre-apply state nor the target
    // holds content the user changed while the apply was interrupted. Preserve
    // those bytes and complete the operation around them; empty divergence is
    // an ordinary resume.
    const deferredPaths = this.expandDeferredDivergedPaths(journal, validation.targetMatchedPaths, validation.divergedPaths);
    const targetFileSizes = await this.recoverJournalTargetSizes(journal, targetEntries, validation.targetMatchedPaths, deferredPaths);
    if (!targetFileSizes) return false;
    return await this.completeInterruptedApply(journal, state, targetEntries, validation, deferredPaths, targetFileSizes);
  }

  async recoverJournalTargetSizes(journal, targetEntries, targetMatchedPaths, deferredPaths) {
    try {
      return await this.backfillApplyJournalTargetSizes(journal, targetEntries, targetMatchedPaths, deferredPaths);
    } catch {
      journal.redacted_error_category = "target_blob_size_unavailable";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return null;
    }
  }

  async backfillApplyJournalTargetSizes(journal, targetEntries, targetMatchedPaths, deferredPaths) {
    const excluded = [...targetMatchedPaths, ...(journal.deferred_local_paths || []), ...deferredPaths];
    const writes = journal.affected_paths.filter((filePath) =>
      targetEntries.has(filePath) && !excluded.some((deferred) => changedPathsConflict(deferred, filePath))
    );
    const sizes = Object.assign({}, journal.target_file_sizes || {});
    for (const filePath of writes) {
      if (Number.isSafeInteger(sizes[filePath]) && sizes[filePath] >= 0) continue;
      const size = await blobSizeFromGit(this.fsp, this.gitdir, targetEntries.get(filePath));
      if (!Number.isSafeInteger(size) || size < 0 || size > this.fileBufferBudgetBytes) {
        throw new ObtsBlockedError("target_blob_size_unavailable", "The server did not provide a bounded size for a target file.");
      }
      sizes[filePath] = size;
    }
    return sizes;
  }

  expandDeferredDivergedPaths(journal, targetMatchedPaths, divergedPaths) {
    return new Set(this.expandDeferredApplyPaths(journal, targetMatchedPaths, divergedPaths));
  }

  expandDeferredApplyPaths(journal, targetMatchedPaths, localPaths) {
    const deferred = new Set([...(journal.deferred_local_paths || []), ...localPaths]);
    const candidates = journal.affected_paths.filter((filePath) => !targetMatchedPaths.has(filePath));
    const queue = [...deferred];
    while (queue.length > 0) {
      const deferredPath = queue.pop();
      for (const candidate of candidates) {
        if (deferred.has(candidate) || !changedPathsConflict(candidate, deferredPath)) continue;
        deferred.add(candidate);
        queue.push(candidate);
      }
    }
    return [...deferred].sort();
  }

  async recordDeferredApplyPaths(journal, localPaths, targetMatchedPaths = new Set()) {
    const deferred = this.expandDeferredApplyPaths(journal, targetMatchedPaths, localPaths);
    if (sameStringArray(deferred, journal.deferred_local_paths || [])) {
      await this.retainApplyProvenance(journal);
      return new Set(deferred);
    }
    journal.deferred_local_paths = deferred;
    await writeJson(this.fsp, this.applyJournalPath, journal);
    await this.retainApplyProvenance(journal);
    return new Set(deferred);
  }

  async completeInterruptedApply(journal, state, targetEntries, validation, deferredDivergedPaths, targetFileSizes) {
    const preservedDeferredPaths = new Set([
      ...(journal.deferred_local_paths || []),
      ...(deferredDivergedPaths || [])
    ]);
    journal.deferred_local_paths = [...preservedDeferredPaths].sort();
    try {
      await this.releaseApplyLock();
      await this.acquireApplyLock(journal.apply_id, true);
      this.plugin.isApplying = true;
      if (journal.affected_paths.length > 0 && journal.recovery_bundle_id === null) {
        this.plugin.setInitializationStage("Writing interrupted apply recovery bundle", "recovery_bundle");
        const stagedRecovery = await this.stageApplyRecoveryFiles(
          journal,
          journal.affected_paths,
          "Checking (preparing recovery)",
          new Set([...validation.targetMatchedPaths, ...preservedDeferredPaths]),
          true
        );
        if (stagedRecovery && journal.affected_paths.length > 0) {
          journal.recovery_bundle_id = await this.finalizeRecoveryBundle(
            stagedRecovery, journal.operation_type, journal.target_main, journal.affected_paths, journal
          );
          journal.last_completed_step = "recovery_bundle";
          journal.phase = "recovery_bundle_written";
          await writeJson(this.fsp, this.applyJournalPath, journal);
        }
      }
      journal.phase = "writing_files";
      journal.redacted_error_category = null;
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Restoring interrupted apply files", "recovery_file_apply");
      await this.writeTargetFilesFromJournal(
        journal,
        targetEntries,
        new Set([...validation.targetMatchedPaths, ...preservedDeferredPaths]),
        targetFileSizes
      );
      const residualTombstoneDirectories = await this.applyDirectoryChanges(
        journal.directory_intents || [],
        journal.explicit_directories || [],
        new Set(journal.pre_apply_directories || []),
        journal.confirmed_directory_inventory
          ? Object.fromEntries(journal.confirmed_directory_inventory.directories.map((entry) => [entry.path, entry.creation_time]))
          : journal.pre_apply_directory_ctimes || {},
        journal.confirmed_directory_inventory
          ? new Set(journal.confirmed_directory_inventory.directories.map((entry) => entry.path))
          : new Set(journal.pre_apply_directories || []),
        [...(journal.local_only_paths || []), ...(journal.deferred_local_paths || [])],
        journal.target_main
      );
      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Revalidating interrupted apply files", "recovery_file_validation");
      const deferredAffectedPaths = new Set(journal.affected_paths.filter((filePath) =>
        [...preservedDeferredPaths, ...(journal.deferred_local_paths || [])]
          .some((deferred) => changedPathsConflict(filePath, deferred))
      ));
      const mismatchedPaths = await this.affectedApplyPathsNotMatchingTarget(
        journal, targetEntries, true, deferredAffectedPaths
      );
      if (mismatchedPaths.length > 0) {
        const updated = await this.recordDeferredApplyPaths(journal, mismatchedPaths, validation.targetMatchedPaths);
        preservedDeferredPaths.clear();
        for (const filePath of updated) preservedDeferredPaths.add(filePath);
      }
      const keepResidualLocalChanges = true;
      let preservedLocalChangePaths = [];
      let preservedLocalSnapshot = null;
      let preservedDirectoryIntents = [];
      let capturedChangeSeq = null;
      let localScanPending = false;
      await this.retainApplyProvenance(journal, true);
      this.plugin.isApplying = false;
      await this.flushEditorBuffersToDisk();
      if (keepResidualLocalChanges) {
        capturedChangeSeq = (await this.readQueue()).change_seq || 0;
        const preserved = await this.captureStableLocalChanges(targetEntries, 3, true);
        if (preserved.stable) {
          preservedLocalChangePaths = preserved.paths;
          preservedLocalSnapshot = preserved.snapshot;
        } else {
          if (preserved.changedPath) {
            const updated = await this.recordDeferredApplyPaths(journal, [preserved.changedPath], validation.targetMatchedPaths);
            preservedDeferredPaths.clear();
            for (const filePath of updated) preservedDeferredPaths.add(filePath);
          }
          await this.markLocalApplyScanPending(journal, targetEntries, preserved.changedPath ? [preserved.changedPath] : [], true);
          localScanPending = true;
        }
        if (preservedLocalChangePaths.length > 0) {
          this.plugin.setInitializationStage("Writing recovered local change bundle", "recovery_bundle");
          try {
            await this.createRecoveryBundle("rebuild_from_server", journal.target_main, preservedLocalChangePaths);
          } catch (error) {
            if (!(error instanceof LocalSnapshotChangedError)) throw error;
            preservedLocalChangePaths = [];
            preservedLocalSnapshot = null;
            await this.markLocalApplyScanPending(journal, targetEntries, [error.filePath], true);
            localScanPending = true;
            const updated = await this.recordDeferredApplyPaths(journal, [error.filePath], validation.targetMatchedPaths);
            preservedDeferredPaths.clear();
            for (const filePath of updated) preservedDeferredPaths.add(filePath);
          }
        }
      }
      if (journal.preserve_local_changes) {
        preservedDirectoryIntents = await this.preserveDirectoryChangesFromTarget(
          targetEntries,
          journal.explicit_directories || [],
          residualTombstoneDirectories,
          true
        );
      }
      this.plugin.setInitializationStage("Restoring interrupted apply refs", "recovery_refs");
      if (!(await this.validateApplyJournalPolicy(journal))) return false;
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Persisting interrupted apply state", "recovery_state");
      const queueAfterCapture = await this.readQueue();
      localScanPending = localScanPending || (capturedChangeSeq !== null && queueAfterCapture.change_seq !== capturedChangeSeq);
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: preservedLocalChangePaths.length > 0 ? "Ahead" : localScanPending ? "Checking" : "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, journal.event_seq || 0),
        last_applied_event_seq: Math.max(state.last_applied_event_seq || 0, journal.event_seq || 0),
        updated_at: nowIso()
      }));
      if (!journal.preserve_local_changes) await this.refreshDirectoryStateFromDisk();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(journal.target_main, state.server_device_ref, preservedLocalSnapshot);
      } else if (preservedDirectoryIntents.length > 0) {
        await this.queuePreservedDirectoryChanges(journal.target_main, state.server_device_ref);
      }
      await this.writePendingAppliedAcknowledgement(journal.target_main, journal.event_seq || 0);
      await this.clearApplyState();
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step || "recovery_bundle";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return false;
    } finally {
      this.plugin.isApplying = false;
      try { await this.releaseApplyLock(journal.apply_id); } catch {}
    }
  }

  async affectedApplyPathsNotMatchingTarget(journal, targetEntries, initialization = true, excludedPaths = null) {
    const paths = journal.affected_paths.filter((filePath) =>
      !excludedPaths?.has(filePath) && (
        targetEntries.has(filePath) ||
        ![...targetEntries.keys()].some((targetPath) => targetPath.startsWith(`${filePath}/`))
      )
    );
    const budget = createByteBudget(this.fileBufferBudgetBytes);
    const matches = await runBoundedWork(paths, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: (completed, total) => {
        if (initialization) {
          this.plugin.updateInitializationProgress(total > 0
            ? `Validating interrupted apply files ${completed}/${total}`
            : "Validating interrupted apply files");
        } else {
          this.reportOperationProgress(
            total > 0 ? `Applying (verifying) ${completed}/${total}` : "Applying (verifying)",
            "apply_verify"
          );
        }
      }
    }, async (filePath) => {
      const fingerprint = (await this.readRecoveryFileSnapshot(filePath, budget)).fingerprint;
      return this.fingerprintMatchesTarget(fingerprint, targetEntries.get(filePath));
    });
    return paths.filter((_, index) => !matches[index]);
  }

  async affectedApplyPathsMatchTarget(journal, targetEntries, initialization = true, excludedPaths = null) {
    return (await this.affectedApplyPathsNotMatchingTarget(
      journal, targetEntries, initialization, excludedPaths
    )).length === 0;
  }

  async localChangedPathsFromTree(targetEntries, includeSnapshot = false, options = {}) {
    const rootPolicy = await this.readRootIgnorePolicy();
    if (options.targetRootIgnoreOid !== undefined && rootPolicy.oid !== options.targetRootIgnoreOid) {
      throw new ObtsBlockedError("target_policy_changed", "The visible root ignore policy changed during apply.");
    }
    if (options.onListing) options.onListing();
    const localFiles = await this.scanSyncableFiles(rootPolicy.policy, options.reportOperationProgress
      ? this.createInventoryProgress()
      : undefined);
    const localSet = new Set(localFiles);
    if (options.onProgress) options.onProgress(0, localFiles.length);
    const snapshot = await this.captureLocalFileSnapshot(localFiles, new Map(
      [...targetEntries].map(([filePath, oid]) => [filePath, { oid }])
    ), {
      persistChangedBlobs: includeSnapshot,
      verifyInventory: includeSnapshot && options.verifyInventory !== false,
      rootPolicy,
      reportProgress: false,
      beforeInventoryVerification: options.onListing,
      onProgress: options.onProgress || (options.reportOperationProgress
        ? (completed, total) => this.reportOperationProgress(
          total > 0 ? `Applying (verifying vault) ${completed}/${total}` : "Applying (verifying vault)",
          "apply_verify"
        )
        : undefined)
    });
    const paths = Array.from(new Set([...localSet, ...targetEntries.keys()])).sort().filter((filePath) => {
      const localOid = snapshot.entries.get(filePath)?.entry.oid;
      return localOid === undefined ? targetEntries.has(filePath) : localOid !== targetEntries.get(filePath);
    });
    return includeSnapshot ? { paths, snapshot } : paths;
  }

  createInventoryProgress(initialization = false) {
    let lastReportedAt = null;
    return (fileCount, directoryCount) => {
      const now = Date.now();
      if (lastReportedAt !== null && now - lastReportedAt < FILE_PROGRESS_INTERVAL_MS) return;
      lastReportedAt = now;
      const label = `Applying (listing vault files) ${fileCount} files · ${directoryCount} directories`;
      if (initialization) this.plugin.updateInitializationProgress(label);
      else this.reportOperationProgress(label, "directory_inventory");
    };
  }

  createLocalApplyProgress(initialization = false, point = "local_preservation") {
    let lastLabel = null;
    let lastReportedAt = 0;
    return (label, completed = null, total = null, force = false) => {
      const now = Date.now();
      if (!force && label === lastLabel && completed !== 0 && completed !== total &&
          now - lastReportedAt < FILE_PROGRESS_INTERVAL_MS) return;
      lastLabel = label;
      lastReportedAt = now;
      const progress = total > 0 ? `${label} ${completed}/${total}` : label;
      if (initialization) this.plugin.updateInitializationProgress(progress);
      else this.reportOperationProgress(progress, point);
    };
  }

  async captureStableLocalChanges(targetEntries, attempts = 3, initialization = false) {
    const report = this.createLocalApplyProgress(initialization);
    const listing = () => report("Applying (listing vault files)");
    const checking = (completed, total, force = false) => report("Applying (checking local edits)", completed, total, force);
    let changedPath = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        checking();
        await this.flushEditorBuffersToDisk();
        const first = await this.localChangedPathsFromTree(targetEntries, true, {
          verifyInventory: false,
          reportOperationProgress: !initialization,
          onListing: listing,
          onProgress: (completed, total) => checking(completed, total * 2)
        });
        checking(first.snapshot.files.length, first.snapshot.files.length * 2, true);
        await this.flushEditorBuffersToDisk();
        const snapshot = await this.captureLocalFileSnapshot(first.snapshot.files, new Map(
          [...targetEntries].map(([filePath, oid]) => [filePath, { oid }])
        ), {
          persistChangedBlobs: true,
          verifyInventory: true,
          rootPolicy: first.snapshot.rootPolicy,
          forcePaths: first.paths,
          reportProgress: false,
          beforeInventoryVerification: listing,
          onProgress: (completed, total) => checking(total + completed, total * 2)
        });
        const stable = sameStringArray(first.snapshot.files, snapshot.files) &&
          first.snapshot.files.every((filePath) =>
            first.snapshot.entries.get(filePath)?.entry.oid === snapshot.entries.get(filePath)?.entry.oid
          );
        if (stable) return { ...first, snapshot, stable: true, changedPath: null };
      } catch (error) {
        if (!(error instanceof LocalSnapshotChangedError) &&
            !(error instanceof ObtsBlockedError && error.code === "target_policy_changed")) throw error;
        changedPath = error.filePath || changedPath;
      }
      if (!initialization) this.plugin.finishMeasuredPhase?.("abandoned");
    }
    return { paths: [], snapshot: null, stable: false, changedPath };
  }

  async markLocalApplyScanPending(journal, targetEntries, additionalPaths = [], initialization = false) {
    const report = this.createLocalApplyProgress(initialization);
    report("Applying (listing vault files)");
    const rootPolicy = await this.readRootIgnorePolicy();
    const localFiles = await this.scanSyncableFiles(rootPolicy.policy);
    const paths = [...new Set([
      ...additionalPaths,
      ...(journal.affected_paths || []),
      ...(journal.deferred_local_paths || []),
      ...targetEntries.keys(),
      ...localFiles
    ])].filter((filePath) => isSyncableVaultPath(filePath)).sort();
    await this.recordLocalChangeHint(paths);
    this.plugin.syncQueued = true;
  }

  async classifySafeResidualLocalChanges(state, journal, targetEntries) {
    const queue = await this.readQueue();
    const pendingCommit = queue.status === "conflicted" ? queue.pending_commit : null;
    if (!pendingCommit || !(await this.commitExists(pendingCommit))) {
      return [];
    }
    const pendingEntries = await this.listTreeBlobOids(pendingCommit);
    const priorEntries = state.local_main ? await this.listTreeBlobOids(state.local_main) : new Map();
    const localFiles = new Set(await this.scanSyncableFiles());
    const candidatePaths = Array.from(new Set([...localFiles, ...targetEntries.keys()])).sort();
    const budget = createByteBudget(this.fileBufferBudgetBytes);
    const fingerprints = await runBoundedWork(candidatePaths, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: (completed, total) => this.plugin.updateInitializationProgress(
        total > 0 ? `Validating interrupted apply files ${completed}/${total}` : "Validating interrupted apply files"
      )
    }, async (filePath) => (await this.readRecoveryFileSnapshot(filePath, budget)).fingerprint);
    const preservedPaths = [];
    for (let index = 0; index < candidatePaths.length; index += 1) {
      const filePath = candidatePaths[index];
      const fingerprint = fingerprints[index];
      if (this.fingerprintMatchesTarget(fingerprint, targetEntries.get(filePath))) continue;
      if (journal.affected_paths.some((affectedPath) => changedPathsConflict(filePath, affectedPath))) return [];
      if (!this.fingerprintMatchesTarget(fingerprint, pendingEntries.get(filePath))) return [];
      if (this.fingerprintMatchesTarget(fingerprint, priorEntries.get(filePath))) return [];
      preservedPaths.push(filePath);
    }
    return preservedPaths;
  }

  proposalBase(queue, state) {
    // Never infer an authoring base for already committed legacy queue items.
    return queue.pending_proposal_base || (Object.hasOwn(queue, "pending_upload_base")
      ? queue.pending_upload_base : queue.expected_device_ref === null ? state.local_main : null);
  }

  async readStaleProvenance() {
    const saved = await readRecoveryJsonStrict(this.fsp, this.staleProvenancePath,
      "stale_provenance_corrupt", "Stale authoring evidence needs explicit recovery.");
    if (!saved) return { version: 3, horizons: [], obligations: {}, intent: null, accepted_proposal: null, held_proposals: [], queued_replacement: null };
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const oid = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
    const paths = (value) => Array.isArray(value) && value.every((p) => typeof p === "string" && isSafeJournalPath(p));
    const nullableOid = (value) => value === null || oid(value);
    const intent = saved.intent;
    const replacement = (r) => object(r) && oid(r.old_commit) && oid(r.old_tree) && oid(r.new_commit) && oid(r.new_tree) &&
      oid(r.local_ref) && nullableOid(r.base);
    if (!object(saved) || ![1, 2, 3].includes(saved.version) || !Array.isArray(saved.horizons) || saved.horizons.some((h) =>
      !object(h) || !isApplyId(h.apply_id) || !oid(h.base) || !paths(h.touched) || !Number.isFinite(h.expiry) ||
      !(h.held_bases === undefined || object(h.held_bases) && Object.entries(h.held_bases).every(([p, b]) => isSafeJournalPath(p) && oid(b)))) ||
      !object(saved.obligations) || Object.entries(saved.obligations).some(([p, o]) =>
        !isSafeJournalPath(p) || !object(o) || !oid(o.base) || !Number.isSafeInteger(o.generation) || o.generation < 0 ||
        !(o.signature === "uncaptured" || o.signature === "absent" || oid(o.signature))) ||
      !(intent === null || object(intent) && oid(intent.base) && oid(intent.parent) && oid(intent.tree) &&
        nullableOid(intent.commit) && object(intent.captures) && Object.entries(intent.captures).every(([p, g]) =>
          isSafeJournalPath(p) && Number.isSafeInteger(g) && g >= 0) &&
        [null, "merged", "noop", "conflicted"].includes(intent.outcome) && nullableOid(intent.main) &&
        (intent.outcome === null ? intent.main === null : intent.outcome === "conflicted" || oid(intent.main)) &&
        (intent.replacement === undefined || object(intent.replacement) &&
          oid(intent.replacement.old_commit) && oid(intent.replacement.old_tree) &&
          oid(intent.replacement.new_commit) && oid(intent.replacement.new_tree) &&
          intent.replacement.new_commit === intent.commit && intent.replacement.new_tree === intent.tree)) ||
      !(saved.accepted_proposal === undefined && saved.version === 1 || saved.accepted_proposal === null ||
        object(saved.accepted_proposal) && oid(saved.accepted_proposal.commit) && nullableOid(saved.accepted_proposal.base)) ||
      !(saved.version < 3 && saved.held_proposals === undefined || Array.isArray(saved.held_proposals) && saved.held_proposals.every((h) =>
        object(h) && oid(h.commit) && oid(h.recorded_main) && paths(h.footprint) && paths(h.cohort) &&
        nullableOid(h.main) && [null, "merged", "noop", "conflicted"].includes(h.outcome) &&
        (h.outcome === null ? h.main === null : h.outcome === "conflicted" || oid(h.main)) &&
        object(h.fallbacks) && Object.keys(h.fallbacks).length > 0 && Object.entries(h.fallbacks).every(([p, b]) => isSafeJournalPath(p) && oid(b) &&
          h.footprint.some((q) => changedPathsConflict(p, q)) && !h.cohort.some((q) => changedPathsConflict(p, q))) &&
        (h.replacement === undefined || object(h.replacement) && oid(h.replacement.old_commit) && oid(h.replacement.old_tree) &&
          oid(h.replacement.new_commit) && oid(h.replacement.new_tree) && h.replacement.new_commit === h.commit &&
          nullableOid(h.replacement.base) && oid(h.replacement.local_ref)))) ||
      !(saved.version < 3 && saved.queued_replacement === undefined || saved.queued_replacement === null || replacement(saved.queued_replacement))) {
      throw new ObtsBlockedError("stale_provenance_corrupt", "Stale authoring evidence needs explicit recovery.");
    }
    saved.version = 3;
    saved.accepted_proposal ??= null;
    saved.held_proposals ??= [];
    saved.queued_replacement ??= null;
    return saved;
  }

  async mutateStaleProvenance(fn) {
    const run = this.staleMutation.then(async () => {
      const saved = await this.readStaleProvenance();
      const result = await fn(saved);
      // A protected ref, not just a JSON hash, retains every base's Git closure.
      const bases = new Set([...saved.horizons.map((h) => h.base),
        ...saved.horizons.flatMap((h) => Object.values(h.held_bases || {})),
        ...saved.held_proposals.flatMap((h) => [h.commit, ...Object.values(h.fallbacks)]),
        ...Object.values(saved.obligations).map((o) => o.base), saved.queued_replacement?.old_commit, saved.queued_replacement?.new_commit, saved.queued_replacement?.base, saved.intent?.base, saved.accepted_proposal?.base].filter(Boolean));
      for (const base of bases) {
        if (!(await this.commitExists(base))) throw new ObtsBlockedError("stale_base_missing", "The protected authoring base is unavailable.");
        await git.writeRef({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir,
          ref: `refs/obts/stale-bases/${base}`, value: base, force: true });
      }
      await writeJson(this.fsp, this.staleProvenancePath, saved);
      const refs = await git.listRefs({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, filepath: "refs/obts/stale-bases" });
      for (const base of refs) if (!bases.has(base)) await git.deleteRef({
        fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, ref: `refs/obts/stale-bases/${base}`
      });
      return result;
    });
    this.staleMutation = run.then(() => undefined, () => undefined);
    return await run;
  }

  async holdRebuildDifferences(queue, recordedMain, signatures, repairApplyId = null, repairEvidence = null) {
    if (!queue.pending_commit || !recordedMain || !signatures.size) return;
    const parsed = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: queue.pending_commit })).commit;
    if (parsed.parent.length !== 1) throw new ObtsBlockedError("stale_intent_mismatch", "The queued proposal has no provable authoring footprint.");
    const tree = await this.listTreeBlobOids(queue.pending_commit);
    const parent = await this.listTreeBlobOids(parsed.parent[0]);
    const footprint = [...new Set([...tree.keys(), ...parent.keys()])].filter((p) => tree.get(p) !== parent.get(p));
    // Tree hierarchy/absence proves structural closure. Standalone empty-directory
    // intents are not recorded on ordinary P; they keep the conservative fallback.
    await this.mutateStaleProvenance(async (saved) => {
      const cohort = saved.intent?.commit === queue.pending_commit ? Object.keys(saved.intent.captures)
        : queue.pending_proposal_base ? footprint : [];
      let held = saved.held_proposals.find((h) => h.commit === queue.pending_commit);
      for (const [p] of signatures) {
        if (!footprint.some((q) => changedPathsConflict(p, q)) || cohort.some((q) => changedPathsConflict(p, q))) continue;
        let fallback = repairEvidence ? repairEvidence.base : queue.pending_proposal_base || recordedMain;
        // A corrupt companion loses ALL path associations. Its original older
        // pins therefore cover every repair path, not just P's footprint.
        let base = repairEvidence?.older ? repairEvidence.base : queue.pending_commit;
        if (repairEvidence && !repairEvidence.older) {
          // Only the original-pin snapshot can admit P. A newly synthesized
          // local_main horizon must not count as an original older obligation.
          const repairHorizon = saved.horizons.find((h) => h.apply_id === repairApplyId);
          if (repairHorizon) {
            repairHorizon.held_bases ||= {};
            repairHorizon.held_bases[p] = queue.pending_commit;
          }
        }
        const independent = [...Object.entries(saved.obligations).filter(([q]) => changedPathsConflict(p, q)).map(([, o]) => o.base),
          ...saved.horizons.filter((h) => h.touched.some((q) => changedPathsConflict(p, q))).map((h) => this.staleHorizonBase(h, p))];
        for (const candidate of independent) {
          if (await this.isAncestor(candidate, fallback)) fallback = candidate;
          if (await this.isAncestor(candidate, base)) base = candidate;
        }
        if (!held) saved.held_proposals.push(held = { commit: queue.pending_commit, recorded_main: recordedMain,
          footprint: [...new Set(footprint)].sort(), cohort, fallbacks: {}, main: null, outcome: null });
        held.fallbacks[p] ||= fallback;
        if (repairApplyId && !repairEvidence?.older) for (const horizon of saved.horizons.filter((h) => h.apply_id === repairApplyId)) {
          horizon.held_bases ||= {};
          horizon.held_bases[p] = base;
        }
        const obligation = saved.obligations[p];
        if (!obligation) saved.obligations[p] = { base, generation: 0, signature: "uncaptured" };
        // An independent older obligation wins; only a previous hold may keep P.
      }
    });
  }

  staleHorizonBase(horizon, filePath) {
    return Object.entries(horizon.held_bases || {}).find(([p]) => changedPathsConflict(p, filePath))?.[1] || horizon.base;
  }

  async settleHeldProposal(saved, identity, targetMain, acknowledged) {
    const held = saved.held_proposals.find((h) => h.commit === identity);
    if (!held) return;
    // Held-only ownership is proved by the live queue or accepted record. Unlike
    // general F0, rebuild may reset local_head; use its durably recorded main.
    const ack = acknowledged && targetMain && await this.isAncestor(identity, targetMain) &&
      !await this.isAncestor(identity, held.recorded_main);
    for (const [p, fallback] of Object.entries(held.fallbacks)) {
      const obligation = saved.obligations[p];
      if (obligation?.base === identity) obligation.base = ack ? identity : fallback;
      for (const horizon of saved.horizons) if (horizon.held_bases?.[p] === identity)
        horizon.held_bases[p] = ack ? identity : fallback;
    }
    held.main = targetMain || null;
    held.outcome = ack ? "merged" : "conflicted";
    if (!ack) saved.held_proposals = saved.held_proposals.filter((h) => h !== held);
  }

  async restartStaleProvenance() {
    if (this.staleProvenanceRestarted) return;
    await this.mutateStaleProvenance(async (saved) => {
      // Wall-clock downtime is not evidence of editor reload or adapter drain.
      for (const horizon of saved.horizons) horizon.expiry = Math.max(horizon.expiry, Date.now() + 3000);
    });
    this.staleProvenanceRestarted = true;
  }

  applyTouchedPaths(journal) {
    if (!journal) return [];
    return journal.touched_paths || [...new Set([
      ...journal.affected_paths, ...(journal.directory_intents || []).map((i) => i.path)
    ])].sort();
  }

  async retainApplyProvenance(journal, afterMutation = false) {
    const base = journal?.authoring_base || journal?.expected_prior_local_main;
    if (!base || !(await this.commitExists(base))) return; // No manufactured legacy/onboarding base.
    const touched = this.applyTouchedPaths(journal);
    await this.mutateStaleProvenance(async (saved) => {
      let horizon = saved.horizons.find((h) => h.apply_id === journal.apply_id && h.base === base);
      if (!horizon) {
        horizon = { apply_id: journal.apply_id, base, touched, expiry: Date.now() + 3000 };
        saved.horizons.push(horizon);
      } else {
        horizon.touched = [...new Set([...horizon.touched, ...touched])].sort();
        if (afterMutation) horizon.expiry = Date.now() + 3000;
      }
      if (journal.operation_type === "rebuild_from_server" || saved.held_proposals.some((h) => h.outcome === "merged")) {
        horizon.held_bases ||= {};
        for (const held of saved.held_proposals) {
          if (journal.operation_type === "rebuild_from_server" && held.recorded_main !== journal.expected_prior_local_main)
            throw new ObtsBlockedError("stale_intent_mismatch", "The held rebuild base does not match its journal.");
          for (const p of Object.keys(held.fallbacks)) horizon.held_bases[p] = saved.obligations[p]?.base || held.commit;
        }
      }
      for (const p of journal.deferred_local_paths || []) {
        if (!touched.some((t) => changedPathsConflict(t, p))) continue;
        const pathBase = this.staleHorizonBase(horizon, p);
        if (!saved.obligations[p]) saved.obligations[p] = { base: pathBase, generation: 0, signature: "uncaptured" };
        else if (await this.isAncestor(pathBase, saved.obligations[p].base)) saved.obligations[p].base = pathBase;
      }
    });
  }

  async classifyStaleSnapshot(targetMain, snapshot) {
    const target = await this.listTreeBlobOids(targetMain);
    const journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    await this.retainApplyProvenance(journal);
    // End a horizon only after elapsed time AND a subsequent drain. A claim also
    // waits for writers admitted to the outer gate, not just the host's queue.
    const saved = await this.readStaleProvenance();
    const expiring = saved.horizons.filter((h) => h.expiry <= Date.now() && h.apply_id !== journal?.apply_id);
    if (expiring.length || Object.keys(saved.obligations).length) {
      await this.pathMutationGate.withExclusive([...expiring.flatMap((h) => h.touched), ...Object.keys(saved.obligations)], async () => {
        await Promise.resolve(this.adapter.promise).catch(() => undefined);
      });
      // Capture again AFTER drain, including saves that waited in either queue.
      const drained = (await this.localChangedPathsFromTree(target, true)).snapshot;
      Object.assign(snapshot, drained);
    }
    const directoryIntents = (await this.readDirectoryState()).pending_intents;
    const classify = (raw) => this.mutateStaleProvenance(async (current) => {
      const ancestry = new Map();
      const older = async (a, b) => {
        const key = `${a}:${b}`;
        if (!ancestry.has(key)) ancestry.set(key, a === b || await this.isAncestor(a, b));
        return ancestry.get(key);
      };
      const changedFiles = [...new Set([...target.keys(), ...snapshot.entries.keys()])]
        .filter((p) => target.get(p) !== snapshot.entries.get(p)?.entry.oid);
      const targetDirectories = new Set([...target.keys()].flatMap(directoryPrefixes));
      const differences = indexPaths(changedFiles.map((p) => [p, p]));
      const obligations = indexPaths(Object.entries(current.obligations));
      const horizons = indexPaths(current.horizons.flatMap((h) => h.touched.map((p) => [p, h])));
      const directories = indexPaths(directoryIntents.map((i) => [i.path, i]));
      const inventory = indexPaths([...snapshot.entries]);
      const changed = [...new Set([...changedFiles, ...directoryIntents.map((i) => i.path), ...Object.keys(current.obligations)
        .filter((p) => differences.overlap(p).length)])];
      for (const p of changed) {
        let obligation = current.obligations[p];
        const relevantHorizons = horizons.overlap(p);
        const sticky = obligations.overlap(p).map((o) => o.base);
        let base = obligation?.base || sticky[0] || (relevantHorizons[0] && this.staleHorizonBase(relevantHorizons[0], p));
        for (const candidate of [...sticky, ...relevantHorizons.map((h) => this.staleHorizonBase(h, p))])
          if (base && await older(candidate, base)) base = candidate;
        if (!base) continue;
        const descendants = inventory.descendants(p).map(([q, v]) => [q, v.entry.oid]);
        const directoryGenerations = directories.overlap(p).map(directoryIntentGenerationKey).sort();
        const signature = directoryGenerations.length
          ? (await git.hashBlob({ object: Buffer.from(stableJson({ descendants, directoryGenerations })) })).oid
          : snapshot.entries.get(p)?.entry.oid || (descendants.length
            ? (await git.hashBlob({ object: Buffer.from(stableJson(descendants)) })).oid : "absent");
        if (!obligation) obligation = current.obligations[p] = { base, generation: 0, signature: "uncaptured" };
        obligation.base = base;
        if (obligation.signature !== signature) {
          obligation.generation += 1;
          obligation.signature = signature;
        }
      }
      // The snapshot above was recaptured after draining both adapter/gate queues.
      // Keep uncertain/differing paths sticky; equal canonical bytes need no proposal.
      const remainingHorizons = indexPaths(current.horizons.filter((h) =>
        !expiring.some((e) => e.apply_id === h.apply_id && e.base === h.base && e.expiry === h.expiry))
        .flatMap((h) => h.touched.map((p) => [p, h])));
      for (const p of Object.keys(current.obligations)) {
        if (differences.overlap(p).length || directories.overlap(p).length || remainingHorizons.overlap(p).length) continue;
        const actual = await this.readRecoveryFileSnapshot(p, createByteBudget(this.fileBufferBudgetBytes), raw);
        if (this.fingerprintMatchesTreePath(actual.fingerprint, p, target, targetDirectories))
          this.retireStaleObligation(current, p);
      }
      current.horizons = current.horizons.filter((h) => !expiring.some((e) => e.apply_id === h.apply_id && e.base === h.base && e.expiry === h.expiry));
      return changed.filter((p) => current.obligations[p]);
    });
    const claims = Object.keys(saved.obligations);
    return claims.length ? await this.pathMutationGate.withExclusive(claims, classify) : await classify();
  }

  async queueStaleCohort(targetMain, expectedDeviceRef, snapshot = null) {
    if (!targetMain || await this.readDurableCatchup()) return false;
    const queue = await this.readQueue();
    if (queue.pending_commit) {
      if (!queue.pending_proposal_base) return false;
      // Committed-journal recovery may have just restored C. The already queued
      // immutable cohort still owns local_head, including its original base.
      // A conflicted proposal that C already contains was settled by C's
      // resolution and owns nothing: restoring it would rewind the ref behind
      // local_head. Its remaining obligations form a new cohort on C below.
      if (!(await this.isAncestor(queue.pending_commit, targetMain))) {
        await this.updateRef("refs/heads/local", queue.pending_commit, null, true);
        await this.writeState(Object.assign({}, await this.readState(), { local_head: queue.pending_commit, updated_at: nowIso() }));
        return true;
      }
    }
    const saved = await this.readStaleProvenance();
    if (!saved.horizons.length && !Object.keys(saved.obligations).length) return false;
    if (!snapshot) snapshot = (await this.localChangedPathsFromTree(await this.listTreeBlobOids(targetMain), true)).snapshot;
    const stale = await this.classifyStaleSnapshot(targetMain, snapshot);
    if (!stale.length) return false;
    const current = await this.readStaleProvenance();
    let base = current.obligations[stale[0]].base;
    for (const p of stale) if (await this.isAncestor(current.obligations[p].base, base)) base = current.obligations[p].base;
    const cohort = stale.filter((p) => current.obligations[p].base === base &&
      !current.held_proposals.some((h) => Object.keys(h.fallbacks).some((q) => changedPathsConflict(p, q))));
    if (!cohort.length) return false;
    const captures = Object.fromEntries(cohort.map((p) => [p, current.obligations[p].generation]));
    const target = await this.listTreeBlobOids(targetMain);
    const held = [...new Set([...target.keys(), ...snapshot.entries.keys()])]
      .filter((p) => !cohort.includes(p) && target.get(p) !== snapshot.entries.get(p)?.entry.oid);
    const commit = await this.createStaleCohortCommit(targetMain, snapshot, cohort, base, captures);
    if (!commit) return false;
    await this.plugin.flushWatcherHints?.();
    await this.updateQueue(async (q) => Object.assign({}, q, {
      pending_commit: commit, pending_proposal_base: base, expected_device_ref: expectedDeviceRef,
      changed_paths: [...new Set([...q.changed_paths, ...held])].sort(),
      status: "queued_local", attempts: 0, updated_at: nowIso()
    }));
    await this.writeState(Object.assign({}, await this.readState(), {
      local_head: commit, status_label: "Ahead", last_error_code: null, updated_at: nowIso()
    }));
    return true;
  }

  async createStaleCohortCommit(parent, snapshot, paths, base, captures) {
    await this.verifyLocalPolicySnapshot(snapshot);
    const entries = await this.flattenTree(parent);
    // Partial overlay with structural closure. Do not copy unrelated fresh bytes.
    for (const p of paths) {
      for (const q of entries.keys()) if (changedPathsConflict(p, q)) entries.delete(q);
      for (const [q, value] of snapshot.entries) if (changedPathsConflict(p, q)) entries.set(q, value.entry);
    }
    const tree = await this.writeTreeFromEntries(entries);
    const parsed = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: parent });
    if (tree === parsed.commit.tree && !(await this.readDirectoryState()).pending_intents
      .some((i) => paths.some((p) => changedPathsConflict(p, i.path)))) return null;
    await this.verifyLocalPolicySnapshot(snapshot);
    // Durable intent precedes advancing local ref. Tree+parent identifies a
    // stranded commit even if its identity was not published before the crash.
    await this.mutateStaleProvenance(async (saved) => {
      saved.intent = { parent, tree, base, captures, commit: null, outcome: null, main: null };
    });
    const commit = await this.commitTree(tree, parent, "obts: stale authoring cohort");
    await this.mutateStaleProvenance(async (saved) => { saved.intent.commit = commit; });
    return commit;
  }

  async recoverStaleProposalIntent() {
    const saved = await this.readStaleProvenance();
    if (saved.queued_replacement) {
      const r = saved.queued_replacement;
      const queue = await this.readQueue();
      const local = await this.resolveRef("refs/heads/local");
      const old = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: r.old_commit })).commit;
      const next = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: r.new_commit })).commit;
      if (![r.old_commit, r.new_commit].includes(queue.pending_commit) || ![r.local_ref, r.old_commit, r.new_commit].includes(local) ||
          old.tree !== r.old_tree || next.tree !== r.new_tree || stableJson(old.parent) !== stableJson(next.parent) || queue.pending_proposal_base !== r.base)
        throw new ObtsBlockedError("stale_intent_mismatch", "The replacement has ambiguous ownership.");
      await this.updateRef("refs/heads/local", r.new_commit, local);
      await this.writeQueue(Object.assign({}, queue, { pending_commit: r.new_commit }));
      await this.writeState(Object.assign({}, await this.readState(), { local_head: r.new_commit }));
      await this.mutateStaleProvenance(async (current) => {
        current.queued_replacement = null;
        for (const held of current.held_proposals) delete held.replacement;
      });
    } else if (saved.held_proposals.some((h) => h.replacement)) {
      throw new ObtsBlockedError("stale_intent_mismatch", "The held replacement is missing its ref handover.");
    }
    if (!saved.intent || saved.intent.outcome) return;
    let commit = saved.intent.commit || await this.resolveRef("refs/heads/local");
    if (!commit || !(await this.commitExists(commit))) return;
    const parsed = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: commit })).commit;
    if (parsed.tree !== saved.intent.tree || parsed.parent.length !== 1 || parsed.parent[0] !== saved.intent.parent) return;
    const queue = await this.readQueue();
    const replacement = saved.intent.replacement;
    if (queue.pending_commit && queue.pending_commit !== commit && queue.pending_commit !== replacement?.old_commit)
      throw new ObtsBlockedError("stale_intent_mismatch", "A different proposal owns the upload queue.");
    if (replacement) {
      const old = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: replacement.old_commit })).commit;
      const local = await this.resolveRef("refs/heads/local");
      if (old.tree !== replacement.old_tree || ![replacement.old_commit, replacement.new_commit].includes(local))
        throw new ObtsBlockedError("stale_intent_mismatch", "The replacement identities do not match local evidence.");
      await this.updateRef("refs/heads/local", commit, null, true);
    }
    await this.mutateStaleProvenance(async (current) => { current.intent.commit = commit; });
    const state = await this.readState();
    await this.updateQueue(async (q) => Object.assign({}, q, {
      pending_commit: commit, pending_proposal_base: saved.intent.base,
      expected_device_ref: q.pending_commit ? q.expected_device_ref : state.server_device_ref,
      status: q.pending_commit ? q.status : "queued_local", updated_at: nowIso()
    }));
    await this.writeState(Object.assign({}, state, { local_head: commit, updated_at: nowIso() }));
  }

  retireStaleObligation(saved, filePath, applyId = `apply_handover_${randomHex(8)}`) {
    const obligation = saved.obligations[filePath];
    if (!obligation) return;
    let horizon = saved.horizons.find((h) => h.apply_id === applyId && h.base === obligation.base);
    if (!horizon) saved.horizons.push(horizon = {
      apply_id: applyId, base: obligation.base, touched: [], expiry: Date.now() + 3000
    });
    horizon.touched = [...new Set([...horizon.touched, filePath])].sort();
    horizon.expiry = Date.now() + 3000;
    // The caller publishes both changes together, retaining the pin until a
    // subsequent expiry and adapter drain, including saves behind its claim.
    delete saved.obligations[filePath];
  }

  async recordStaleProposalResult(queue, result, detachedRecovery = false) {
    await this.mutateStaleProvenance(async (saved) => {
      if (["merged", "noop"].includes(result.status)) saved.accepted_proposal = {
        commit: queue.pending_commit, base: queue.pending_proposal_base || null
      };
      const held = saved.held_proposals.find((h) => h.commit === queue.pending_commit);
      if (held) { held.main = result.main || null; held.outcome = result.status; }
      // Accepted main objects arrive with pull. Do not interpret missing ancestry
      // here as rejection; durable held identity survives result/queue-clear kills.
      if (result.status === "conflicted") await this.settleHeldProposal(saved, queue.pending_commit, result.main, false);
      if (!queue.pending_proposal_base) return;
      // An archived predecessor can settle after the successor owns stale intent.
      // Keep that successor's obligations untouched.
      if (detachedRecovery && saved.intent?.commit !== queue.pending_commit) return;
      if (saved.intent?.commit !== queue.pending_commit) throw new ObtsBlockedError("stale_intent_mismatch", "The stale result has no matching durable intent.");
      saved.intent.outcome = result.status;
      saved.intent.main = result.main || null;
      if (result.status === "conflicted") {
        for (const p of Object.keys(saved.intent.captures)) this.retireStaleObligation(saved, p);
        // Keep the terminal identity through a crash before queue handover.
        // Existing pending-conflict protocol now owns the bytes/commit/base.
      }
    });
  }

  async finishApplyProvenance(journal) {
    if (!journal) return;
    await this.retainApplyProvenance(journal);
    const target = await this.listTreeBlobOids(journal.target_main);
    const targetDirectories = new Set([...target.keys()].flatMap(directoryPrefixes));
    await this.mutateStaleProvenance(async (saved) => {
      const intent = saved.intent;
      saved.held_proposals = saved.held_proposals.filter((h) => !h.outcome);
      if (saved.accepted_proposal && await this.isAncestor(saved.accepted_proposal.commit, journal.target_main))
        saved.accepted_proposal = null;
      if (intent?.outcome === "conflicted" && (await this.readQueue()).status !== "conflicted") {
        saved.intent = null;
        return;
      }
      if (!intent || !["merged", "noop"].includes(intent.outcome) ||
          !intent.main || !(await this.isAncestor(intent.main, journal.target_main))) return;
      for (const [p, generation] of Object.entries(intent.captures)) {
        const obligation = saved.obligations[p];
        if (!obligation || obligation.generation !== generation ||
            (journal.deferred_local_paths || []).some((q) => changedPathsConflict(p, q))) continue;
        if (this.fingerprintMatchesTreePath((await this.readRecoveryFileSnapshot(p)).fingerprint, p, target, targetDirectories)) {
          this.retireStaleObligation(saved, p, journal.apply_id);
        }
      }
      saved.intent = null;
    });
  }

  async queuePreservedLocalChanges(targetMain, expectedDeviceRef, snapshot = null) {
    if (snapshot && expectedDeviceRef && expectedDeviceRef !== targetMain &&
      !(await this.readStaleProvenance()).accepted_proposal?.base &&
      await this.commitExists(expectedDeviceRef) && (await this.readQueue()).status === "merged" &&
      !(await this.readQueue()).pending_commit && (await this.readDirectoryState()).pending_intents.length === 0) {
      const acceptedEntries = await this.listTreeBlobOids(expectedDeviceRef);
      const exactAcceptedTree = acceptedEntries.size === snapshot.entries.size && [...acceptedEntries].every(([filePath, oid]) => snapshot.entries.get(filePath)?.entry.oid === oid);
      const journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
      const targetEntries = await this.listTreeBlobOids(targetMain);
      const paths = [...new Set([...acceptedEntries.keys(), ...snapshot.entries.keys()])];
      const onlyAppliedDifferences = journal && journal.target_main === targetMain && journal.expected_prior_local_device_ref === expectedDeviceRef && paths.every(filePath => {
        const actual = snapshot.entries.get(filePath)?.entry.oid;
        const accepted = acceptedEntries.get(filePath);
        return actual === accepted || (journal.affected_paths.includes(filePath) && actual === targetEntries.get(filePath) &&
          journal.preflight_fingerprints[filePath] && this.fingerprintMatchesTarget(journal.preflight_fingerprints[filePath], accepted));
      });
      if (exactAcceptedTree || onlyAppliedDifferences) {
        // These bytes were already accepted; differences are solely this older
        // snapshot's verified writes. Retain a local tree for the next clean
        // apply without uploading a second, stale proposal.
        const localHead = exactAcceptedTree ? expectedDeviceRef : await this.createLocalCommitFromSnapshot("obts: retain intermediate applied snapshot", snapshot) || targetMain;
        await this.updateRef("refs/heads/local", localHead, null, true);
        await this.plugin.flushWatcherHints?.();
        const currentQueue = await this.readQueue();
        await this.writeQueue({
          pending_commit: null,
          expected_device_ref: expectedDeviceRef,
          status: "merged",
          attempts: 0,
          change_seq: currentQueue.change_seq,
          changed_paths: currentQueue.changed_paths,
          updated_at: nowIso()
        });
        await this.writeState(Object.assign({}, await this.readState(), {
          local_main: targetMain,
          local_head: localHead,
          status_label: currentQueue.changed_paths.length > 0 ? "Checking" : "Behind",
          last_error_code: null,
          updated_at: nowIso()
        }));
        return;
      }
    }
    if (await this.readDurableCatchup()) {
      // A retained catch-up obligation owns recovery ordering. Queueing a
      // proposal from this snapshot's ancestry would block the catch-up it
      // depends on; keep the preserved bytes visible and in the recovery
      // bundle so the catch-up path can require explicit local-change review.
      return;
    }
    const provenanceJournal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    await this.retainApplyProvenance(provenanceJournal);
    await this.finishApplyProvenance(provenanceJournal);
    if (await this.queueStaleCohort(targetMain, expectedDeviceRef, snapshot)) return;
    if (snapshot) {
      const [targetPolicy, targetEntries, directoryState] = await Promise.all([
        this.targetApplyPolicy(targetMain),
        this.listTreeBlobOids(targetMain),
        this.readDirectoryState()
      ]);
      const snapshotEntries = new Map([...snapshot.entries]
        .filter(([filePath]) => isSyncableVaultPath(filePath) && !targetPolicy.policy.ignores(filePath))
        .map(([filePath, value]) => [filePath, value.entry.oid]));
      const treeChanged = snapshotEntries.size !== targetEntries.size ||
        [...targetEntries].some(([filePath, oid]) => snapshotEntries.get(filePath) !== oid);
      const directoryWork = await this.hasActionableDirectoryWork(
        directoryState.pending_intents,
        [],
        targetPolicy.policy
      );
      if (!treeChanged && !directoryWork) return;
    }
    const preservedCommit = snapshot
      ? await this.createLocalCommitFromSnapshot("obts: preserve local changes after conflict resolution", snapshot)
      : await this.createLocalCommit("obts: preserve local changes after conflict resolution");
    if (!preservedCommit) {
      return;
    }
    await this.plugin.flushWatcherHints?.();
    const currentQueue = await this.readQueue();
    await this.writeQueue({
      pending_commit: preservedCommit,
      expected_device_ref: expectedDeviceRef,
      status: "queued_local",
      attempts: 0,
      change_seq: currentQueue.change_seq,
      changed_paths: currentQueue.changed_paths,
      updated_at: nowIso()
    });
    await this.writeState(Object.assign({}, await this.readState(), {
      local_main: targetMain,
      local_head: preservedCommit,
      status_label: "Ahead",
      last_error_code: null,
      updated_at: nowIso()
    }));
  }

  async queuePreservedDirectoryChanges(targetMain, expectedDeviceRef) {
    if (await this.readDurableCatchup()) {
      // See queuePreservedLocalChanges: the pending catch-up must settle before
      // this device queues any new proposal or metadata commit.
      return;
    }
    const preservedCommit = await this.createMetadataCommit("obts: preserve local directory changes after apply");
    if (!preservedCommit) return;
    await this.writeQueue({
      pending_commit: preservedCommit,
      expected_device_ref: expectedDeviceRef,
      status: "queued_local",
      attempts: 0,
      updated_at: nowIso()
    });
    await this.writeState(Object.assign({}, await this.readState(), {
      local_main: targetMain,
      local_head: preservedCommit,
      status_label: "Ahead",
      last_error_code: null,
      updated_at: nowIso()
    }));
  }

  async recoveryFileFingerprint(filePath) {
    return (await this.readRecoveryFileSnapshot(filePath)).fingerprint;
  }

  fingerprintMatchesTarget(fingerprint, targetOid) {
    return targetOid === undefined
      ? fingerprint.kind === "missing"
      : fingerprint.kind === "file" && fingerprint.oid === targetOid;
  }

  fingerprintMatchesTreePath(fingerprint, filePath, entries, directories = null) {
    const targetOid = entries.get(filePath);
    if (targetOid !== undefined) return fingerprint.kind === "file" && fingerprint.oid === targetOid;
    const directoryPrefix = `${filePath}/`;
    const expectedDirectory = directories ? directories.has(filePath)
      : [...entries.keys()].some((candidate) => candidate.startsWith(directoryPrefix));
    return expectedDirectory ? fingerprint.kind === "directory" : fingerprint.kind === "missing";
  }

  fingerprintMatchesPreflight(fingerprint, preflightHash, typedPreflight = undefined) {
    if (typedPreflight) {
      return fingerprint.kind === typedPreflight.kind && (
        fingerprint.kind !== "file" || fingerprint.sha256 === typedPreflight.sha256
      );
    }
    return preflightHash === null
      ? fingerprint.kind === "missing" || fingerprint.kind === "directory" || fingerprint.kind === "other"
      : fingerprint.kind === "file" && fingerprint.sha256 === preflightHash;
  }

  async reportRecoveryValidationProgress(completed, total) {
    this.plugin.updateInitializationProgress(total > 0
      ? `Validating interrupted apply files ${completed}/${total}`
      : "Validating interrupted apply files");
    if (completed === total || completed % 25 === 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }

  async applyJournalMatchesCurrentFilesResilient(journal, targetEntries) {
    try {
      return await this.applyJournalMatchesCurrentFiles(journal, targetEntries);
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
      return { matches: false, targetMatchedPaths: new Set(), divergedPaths: [error.filePath] };
    }
  }

  async applyJournalMatchesCurrentFiles(journal, targetEntries) {
    const paths = journal.affected_paths.slice();
    const budget = createByteBudget(this.fileBufferBudgetBytes);
    const fingerprints = await runBoundedWork(paths, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: (completed, total) => this.plugin.updateInitializationProgress(
        total > 0 ? `Validating interrupted apply files ${completed}/${total}` : "Validating interrupted apply files"
      )
    }, async (filePath) => (await this.readRecoveryFileSnapshot(filePath, budget)).fingerprint);
    const targetMatchedPaths = new Set();
    const divergedPaths = [];
    // A verified displaced entry preserves the preflight image; it does not
    // prove removal. An in-place write may leave old, target, or unknown bytes
    // beside the copy, including while recovery admission is already blocked.
    const displacedEvidencePhase = journal.phase === "writing_files" || journal.phase === "verifying" || journal.phase === "blocked_recovery";
    const activeWritePhase = journal.phase === "writing_files" || journal.phase === "verifying";
    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index];
      const fingerprint = fingerprints[index];
      if (
        fingerprint.kind === "directory" &&
        journal.preflight_fingerprints?.[filePath]?.kind === "file" &&
        await this.applyDisplacedEntryMatchesPreflight(journal, filePath) &&
        [...targetEntries.keys()].some((targetPath) => targetPath.startsWith(`${filePath}/`))
      ) continue;
      const hasDisplacedEntry = await this.applyDisplacedEntryExists(journal, filePath);
      const displacedPreflight = displacedEvidencePhase && hasDisplacedEntry &&
        await this.applyDisplacedEntryMatchesPreflight(journal, filePath);
      const matchesTarget = this.fingerprintMatchesTarget(fingerprint, targetEntries.get(filePath));
      // Only completed file writes become protected target matches. A copied,
      // removed child must not defer its parent's pending directory-to-file write.
      if (matchesTarget && (!hasDisplacedEntry || (displacedPreflight && fingerprint.kind === "file"))) {
        targetMatchedPaths.add(filePath);
      }
      const matchesPreflight = this.fingerprintMatchesPreflight(
        fingerprint,
        journal.preflight_sha256[filePath] || null,
        journal.preflight_fingerprints?.[filePath]
      );
      // Missing + copy remains valid for legacy interrupted removals. Other
      // unknown bytes are local work, never authorization to overwrite them.
      if (fingerprint.kind === "missing" && displacedPreflight) continue;
      if (!matchesPreflight && (!(activeWritePhase || displacedPreflight) || !matchesTarget)) {
        divergedPaths.push(filePath);
      }
    }
    return { matches: divergedPaths.length === 0, targetMatchedPaths, divergedPaths };
  }

  async writeTargetFilesFromJournal(journal, targetEntries, targetMatchedPaths, targetFileSizes = journal.target_file_sizes || {}) {
    if (journal.journal_version >= 5 && !(await this.validateApplyJournalPolicy(journal))) {
      throw new ObtsBlockedError("target_policy_changed", "The pinned target policy or retained local-only paths changed.");
    }
    const activePathMutations = [];
    const withPathMutationLock = async (filePath, operation) => {
      while (true) {
        const conflict = activePathMutations.find((entry) => changedPathsConflict(entry.filePath, filePath));
        if (!conflict) break;
        await conflict.promise;
      }
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      const entry = { filePath, promise };
      activePathMutations.push(entry);
      try {
        return await operation();
      } finally {
        activePathMutations.splice(activePathMutations.indexOf(entry), 1);
        release();
      }
    };
    let deferredPathWrite = Promise.resolve();
    const deferLocalPath = (filePath) => {
      const run = deferredPathWrite.then(() => this.recordDeferredApplyPaths(journal, [filePath], targetMatchedPaths));
      deferredPathWrite = run.then(() => undefined, () => undefined);
      return run;
    };
    const isDeferred = (filePath) => [...targetMatchedPaths, ...(journal.deferred_local_paths || [])]
      .some((deferred) => changedPathsConflict(deferred, filePath));
    const applyLocalRace = { withPathMutationLock, deferLocalPath, isDeferred };
    const assertCurrentPreflight = async (filePath, raw = undefined) => {
      const current = (await this.readRecoveryFileSnapshot(filePath, undefined, raw)).fingerprint;
      if (!this.fingerprintMatchesPreflight(
        current,
        journal.preflight_sha256[filePath] || null,
        journal.preflight_fingerprints?.[filePath]
      )) {
        throw new LocalSnapshotChangedError(filePath);
      }
      if (current.kind === "directory" && journal.preflight_fingerprints?.[filePath]?.kind === "directory") {
        const expectedCtime = journal.pre_apply_directory_ctimes?.[filePath];
        const currentCtime = await this.adapterDirectoryCreationTime(filePath, raw || this.adapter);
        if (!(typeof expectedCtime === "number" && expectedCtime > 0 && currentCtime === expectedCtime)) {
          throw new LocalSnapshotChangedError(filePath);
        }
      }
      return current;
    };
    const assertRecoveredDescendants = async (filePath, raw = undefined) => {
      const inventory = await this.listAdapterInventory(filePath, raw || this.adapter);
      const descendants = inventory.files.map((relative) => `${filePath}/${relative}`);
      if (inventory.directories.some((relative) => !(journal.pre_apply_directories || []).includes(`${filePath}/${relative}`))) {
        throw new LocalSnapshotChangedError(filePath);
      }
      if (descendants.some((descendant) => {
        const expected = journal.preflight_fingerprints?.[descendant];
        return expected ? expected.kind !== "file" : journal.preflight_sha256[descendant] === null || journal.preflight_sha256[descendant] === undefined;
      })) {
        throw new LocalSnapshotChangedError(filePath);
      }
      for (const descendant of descendants) await assertCurrentPreflight(descendant, raw);
    };
    const writes = journal.affected_paths
      .filter((candidate) => targetEntries.has(candidate) && !isDeferred(candidate))
      .sort();
    const removals = journal.affected_paths
      .filter((candidate) => !targetEntries.has(candidate) && !isDeferred(candidate) &&
        !writes.some((writePath) => candidate.startsWith(`${writePath}/`)))
      .sort(compareDeepestPathFirst);
    const total = removals.length + writes.length;
    let completed = 0;
    const reportProgress = () => this.reportOperationProgress(
      total > 0 ? `Applying ${completed}/${total}` : "Applying",
      "apply_write"
    );
    const reportOneComplete = () => {
      completed += 1;
      reportProgress();
    };
    reportProgress();

    for (const batch of dependencySafeRemovalBatches(removals)) {
      await runBoundedWork(batch, {
        concurrency: this.fileWorkConcurrency,
        yieldEvery: FILE_WORK_YIELD_EVERY
      }, async (filePath) => {
        await withPathMutationLock(filePath, async () => {
          if (isDeferred(filePath)) {
            reportOneComplete();
            return;
          }
          try {
            await this.displaceApplyPath(journal, filePath, assertCurrentPreflight, assertRecoveredDescendants);
            if (
              await this.adapterExists(filePath) &&
              !(await this.adapterIsDirectory(filePath) && await this.applyDisplacedEntryExists(journal, filePath))
            ) throw new LocalSnapshotChangedError(filePath);
          } catch (error) {
            if (!(error instanceof LocalSnapshotChangedError)) throw error;
            await deferLocalPath(error.filePath || filePath);
          }
          reportOneComplete();
        });
      });
    }

    await this.writeTargetFileBatch(
      writes,
      targetEntries,
      targetFileSizes,
      journal,
      assertRecoveredDescendants,
      assertCurrentPreflight,
      reportOneComplete,
      applyLocalRace
    );
  }

  async writeTargetFileBatch(writes, targetEntries, targetFileSizes, journal, assertRecoveredDescendants, assertCurrentPreflight, onProgress, applyLocalRace = null) {
    const byteBudget = createByteBudget(this.fileBufferBudgetBytes);
    const active = new Set();
    let firstError = null;
    const waitForCapacity = async () => {
      while (active.size >= this.fileWorkConcurrency) await Promise.race(active);
    };
    for (const filePath of writes) {
      if (firstError) break;
      await waitForCapacity();
      if (firstError) break;
      const expectedBytes = targetFileSizes[filePath];
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        firstError = new ObtsBlockedError(
          "target_blob_size_unavailable",
          "The server did not provide a bounded size for a target file."
        );
        break;
      }
      let content;
      let releaseBytes;
      try {
        releaseBytes = await byteBudget.acquire(expectedBytes);
        content = await this.readBlobOid(targetEntries.get(filePath));
        if (content.byteLength !== expectedBytes) {
          throw new ObtsBlockedError(
            "target_blob_size_mismatch",
            "A downloaded target file did not match its attested size."
          );
        }
      } catch (error) {
        if (releaseBytes) releaseBytes();
        firstError = error;
        break;
      }
      const task = (async () => {
        try {
          const write = async () => {
            if (applyLocalRace?.isDeferred(filePath)) {
              onProgress();
              return;
            }
            try {
              const parentPath = path.posix.dirname(filePath);
              if (parentPath !== "." && await this.adapterExists(parentPath) && !(await this.adapterIsDirectory(parentPath))) {
                throw new LocalSnapshotChangedError(parentPath);
              }
              if (await this.applyDisplacedEntryExists(journal, filePath)) {
                const current = (await this.readRecoveryFileSnapshot(filePath)).fingerprint;
                if (this.fingerprintMatchesTarget(current, targetEntries.get(filePath))) {
                  onProgress();
                  return;
                }
              }
              const retainedFile = await this.displaceApplyPath(
                journal, filePath, assertCurrentPreflight, assertRecoveredDescendants, true
              );
              if (retainedFile) {
                await this.adapterModifyBinaryRevalidated(filePath, content, journal);
              } else {
                await this.ensureAdapterDirectory(parentPath);
                try {
                  await this.adapterWriteBinaryExclusive(filePath, content);
                } catch (error) {
                  if (error?.code === "EEXIST" && await this.adapterExists(filePath)) {
                    throw new LocalSnapshotChangedError(filePath, error);
                  }
                  throw error;
                }
              }
              onProgress();
            } catch (error) {
              if (!(error instanceof LocalSnapshotChangedError) || !applyLocalRace) throw error;
              await applyLocalRace.deferLocalPath(error.filePath || filePath);
              onProgress();
            }
          };
          if (applyLocalRace) await applyLocalRace.withPathMutationLock(filePath, write);
          else await write();
        } catch (error) {
          if (!firstError) firstError = error;
        } finally {
          releaseBytes();
        }
      })();
      active.add(task);
      void task.finally(() => active.delete(task));
    }
    await Promise.all(active);
    if (firstError) throw firstError;
  }

  async backgroundScanDecision() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) return { required: false, mode: "none" };
    const directoryState = await this.readDirectoryState();
    const scanState = await readJson(this.fsp, this.scanStatePath, null);
    const valid = scanState && scanState.version === 1 &&
      scanState.scanner_schema === SCANNER_SCHEMA_VERSION &&
      scanState.vault_id === state.vault_id && scanState.device_id === state.device_id;
    if (!valid) {
      if (await this.bootstrapScanCacheFromConvergedState(state, directoryState)) return { required: false, mode: "none" };
      return { required: true, mode: "full" };
    }
    const lastInventoryAt = Date.parse(scanState.last_inventory_completed_at || "");
    const nextFullAuditAt = Date.parse(scanState.next_full_audit_at || "");
    const lastFullAuditAt = Date.parse(scanState.last_full_audit_completed_at || "");
    if (
      Number.isFinite(nextFullAuditAt)
        ? Date.now() >= nextFullAuditAt
        : !Number.isFinite(lastFullAuditAt) || Date.now() - lastFullAuditAt >= PERIODIC_FULL_AUDIT_INTERVAL_MS
    ) {
      return { required: true, mode: "full" };
    }
    if (
      scanState.local_head !== state.local_head ||
      scanState.directory_generation !== directoryState.next_generation ||
      !Number.isFinite(lastInventoryAt) || Date.now() - lastInventoryAt >= PERIODIC_INVENTORY_INTERVAL_MS ||
      !state.last_error_code && await this.hasElapsedStaleHorizon()
    ) {
      return { required: true, mode: "incremental" };
    }
    return { required: false, mode: "none" };
  }

  // Horizons end, and settled obligations retire, only inside a scan. An idle
  // device must run that scan once a horizon elapses; otherwise the next edit
  // still sees the old horizon and is proposed against its superseded base.
  async hasElapsedStaleHorizon() {
    let saved;
    try { saved = await this.readStaleProvenance(); } catch { return false; }
    const now = Date.now();
    return saved.horizons.some((h) => h.expiry <= now);
  }

  // Earliest future horizon expiry, so the host can wake its background check
  // then. Already elapsed horizons are left to the regular background interval.
  async staleProvenanceSettleAt() {
    let saved;
    try { saved = await this.readStaleProvenance(); } catch { return null; }
    const now = Date.now();
    const pending = saved.horizons.map((h) => h.expiry).filter((expiry) => expiry > now);
    return pending.length ? Math.min(...pending) : null;
  }

  async bootstrapScanCacheFromConvergedState(state, directoryState) {
    if (
      state.status_label !== "Synced" || state.last_error_code || !state.local_head ||
      state.local_head !== state.local_main
    ) return false;
    const queue = await this.readQueue();
    if (queue.pending_commit || queue.status !== "idle" || (queue.changed_paths || []).length > 0) return false;
    const existingCache = await readJson(this.fsp, this.scanCachePath, null);
    if (existingCache) return false;
    const [inventory, baseEntries] = await Promise.all([
      this.listLocalVaultInventory(""),
      this.flattenTree(state.local_head)
    ]);
    const files = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    if (!sameStringArray(files, [...baseEntries.keys()].sort())) return false;
    const values = await runBoundedWork(files, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY
    }, async (filePath) => {
      const stat = await this.adapter.stat(filePath);
      if (!stat || stat.type !== "file") throw new LocalSnapshotChangedError(filePath);
      return {
        entry: baseEntries.get(filePath),
        content_sha256: null,
        bytes: Number(stat.size || 0),
        scan_metadata: scanFileMetadata(stat)
      };
    });
    await this.writeScanCache(new Map(files.map((filePath, index) => [filePath, values[index]])), "legacy_converged_state");
    const completedAt = nowIso();
    await writeJson(this.fsp, this.scanStatePath, {
      version: 1,
      scanner_schema: SCANNER_SCHEMA_VERSION,
      vault_id: state.vault_id,
      device_id: state.device_id,
      local_head: state.local_head,
      directory_generation: directoryState.next_generation,
      last_inventory_completed_at: completedAt,
      last_full_audit_completed_at: null,
      next_full_audit_at: new Date(Date.now() + MIGRATED_FULL_AUDIT_DELAY_MS).toISOString(),
      bootstrap_basis: "legacy_converged_state"
    });
    return true;
  }

  async recordScanCompleted(fullAudit) {
    const [state, directoryState, previous] = await Promise.all([
      this.readState(),
      this.readDirectoryState(),
      readJson(this.fsp, this.scanStatePath, null)
    ]);
    if (!state.vault_id || !state.device_id) return;
    const completedAt = nowIso();
    const completedFullAudit = Boolean(fullAudit || this.lastSnapshotWasFullAudit);
    await writeJson(this.fsp, this.scanStatePath, {
      version: 1,
      scanner_schema: SCANNER_SCHEMA_VERSION,
      vault_id: state.vault_id,
      device_id: state.device_id,
      local_head: state.local_head,
      directory_generation: directoryState.next_generation,
      last_inventory_completed_at: completedAt,
      last_full_audit_completed_at: completedFullAudit
        ? completedAt
        : previous && typeof previous.last_full_audit_completed_at === "string"
          ? previous.last_full_audit_completed_at
          : null,
      next_full_audit_at: completedFullAudit
        ? new Date(Date.now() + PERIODIC_FULL_AUDIT_INTERVAL_MS).toISOString()
        : previous && typeof previous.next_full_audit_at === "string"
          ? previous.next_full_audit_at
          : new Date(Date.now() + PERIODIC_FULL_AUDIT_INTERVAL_MS).toISOString(),
      bootstrap_basis: completedFullAudit ? null : previous && previous.bootstrap_basis || null
    });
    this.lastSnapshotWasFullAudit = false;
  }

  async readScanCache() {
    const [state, cache] = await Promise.all([
      this.readState(),
      readJson(this.fsp, this.scanCachePath, null)
    ]);
    if (
      !cache || cache.version !== 1 || cache.scanner_schema !== SCANNER_SCHEMA_VERSION ||
      cache.vault_id !== state.vault_id || cache.device_id !== state.device_id ||
      !cache.entries || typeof cache.entries !== "object" || Array.isArray(cache.entries)
    ) return new Map();
    const entries = new Map();
    for (const [filePath, value] of Object.entries(cache.entries)) {
      if (
        !isSyncableVaultPath(filePath) || !value || typeof value !== "object" ||
        !/^[0-9a-f]{40}$/u.test(value.oid || "") ||
        !(value.content_sha256 === null || /^[0-9a-f]{64}$/u.test(value.content_sha256 || "")) ||
        !Number.isFinite(value.size) || value.size < 0
      ) continue;
      entries.set(filePath, value);
    }
    return entries;
  }

  async writeScanCache(entries, bootstrapBasis = null) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) return;
    const serialized = {};
    for (const [filePath, value] of entries) {
      serialized[filePath] = Object.assign({
        oid: value.entry.oid,
        content_sha256: value.content_sha256
      }, value.scan_metadata);
    }
    await writeJson(this.fsp, this.scanCachePath, {
      version: 1,
      scanner_schema: SCANNER_SCHEMA_VERSION,
      vault_id: state.vault_id,
      device_id: state.device_id,
      entries: serialized,
      bootstrap_basis: bootstrapBasis,
      updated_at: nowIso()
    });
  }

  async createLocalCommit(message, knownLocalFiles = undefined, options = {}) {
    const base = await this.resolveRef("refs/heads/local");
    const baseEntries = base ? await this.flattenTree(base) : new Map();
    const pinnedPolicy = await this.readRootIgnorePolicy();
    const localFiles = knownLocalFiles
      ? knownLocalFiles.filter((filePath) => !pinnedPolicy.policy.ignores(filePath)).slice().sort()
      : await this.scanSyncableFiles(pinnedPolicy.policy);
    const localSet = new Set(localFiles);
    const nextEntries = new Map(baseEntries);
    for (const filePath of baseEntries.keys()) {
      if (!isSyncableVaultPath(filePath) || !localSet.has(filePath)) nextEntries.delete(filePath);
    }
    let snapshot;
    try {
      snapshot = await this.captureLocalFileSnapshot(localFiles, baseEntries, {
        persistChangedBlobs: true,
        persistScanCache: true,
        reportProgress: true,
        verifyInventory: true,
        forcePaths: options.forcePaths,
        fullAudit: Boolean(options.fullAudit),
        rootPolicy: pinnedPolicy
      });
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
      this.plugin.syncQueued = true;
      throw new ObtsBlockedError(
        "local_snapshot_changed",
        "Local files changed while obts was checking them. Sync will retry."
      );
    }
    for (const [filePath, value] of snapshot.entries) nextEntries.set(filePath, value.entry);
    const tree = await this.writeTreeFromEntries(nextEntries);
    if (base) {
      const { commit } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: base });
      if (commit.tree === tree) return null;
    } else if (nextEntries.size === 0) {
      return null;
    }
    try {
      await this.verifyLocalPolicySnapshot(snapshot);
    } catch (error) {
      if (!(error instanceof LocalSnapshotChangedError)) throw error;
      this.plugin.syncQueued = true;
      throw new ObtsBlockedError("local_snapshot_changed", "Root .gitignore changed during capture. Sync will retry.");
    }
    return await this.commitTree(tree, base, message);
  }

  async captureLocalFileSnapshot(localFiles, baseEntries = new Map(), options = {}) {
    const files = localFiles.slice().sort();
    const byteBudget = createByteBudget(this.fileBufferBudgetBytes);
    const forcedPaths = Array.from(new Set([".gitignore", ...(Array.isArray(options.forcePaths) ? options.forcePaths : [])]
      .filter((filePath) => typeof filePath === "string" && isSyncableVaultPath(filePath))
      .map((filePath) => normalizePath(filePath))));
    const scanCache = options.fullAudit ? new Map() : await this.readScanCache();
    if (options.persistScanCache) this.lastSnapshotWasFullAudit = Boolean(options.fullAudit || scanCache.size === 0);
    if (options.reportProgress) this.reportCheckingProgress(0, files.length, Boolean(options.fullAudit));
    const values = await runBoundedWork(files, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: options.reportProgress
        ? (completed, total) => this.reportCheckingProgress(completed, total, Boolean(options.fullAudit))
        : options.onProgress
    }, async (filePath) => {
      let before;
      try {
        before = await this.adapter.stat(filePath);
      } catch (error) {
        throw new LocalSnapshotChangedError(filePath, error);
      }
      if (!before || before.type !== "file") throw new LocalSnapshotChangedError(filePath);
      const metadata = scanFileMetadata(before);
      const cached = scanCache.get(filePath);
      const forced = forcedPaths.some((hint) => filePath === hint || filePath.startsWith(`${hint}/`));
      if (
        !forced && cached && sameCachedScanFileMetadata(metadata, cached) &&
        baseEntries.get(filePath)?.oid === cached.oid
      ) {
        return {
          entry: { mode: "100644", path: filePath, oid: cached.oid, type: "blob" },
          content_sha256: cached.content_sha256,
          bytes: metadata.size,
          scan_metadata: metadata
        };
      }
      const releaseBytes = await byteBudget.acquire(before.size || 0);
      try {
        let content;
        try {
          if (filePath === ".gitignore") {
            const raw = typeof this.adapter.readRootIgnorePolicyNoFollow === "function"
              ? await this.adapter.readRootIgnorePolicyNoFollow(MAX_ROOT_IGNORE_BYTES)
              : await this.adapter.readBinary(filePath);
            if (raw === null || raw.byteLength > MAX_ROOT_IGNORE_BYTES) throw new LocalSnapshotChangedError(filePath);
            content = Buffer.from(raw);
            if (options.rootPolicy && (options.rootPolicy.bytes === null || !content.equals(options.rootPolicy.bytes))) {
              throw new LocalSnapshotChangedError(filePath);
            }
          } else {
            content = Buffer.from(await this.adapter.readBinary(filePath));
          }
        } catch (error) {
          throw new LocalSnapshotChangedError(filePath, error);
        }
        let after;
        try {
          after = await this.adapter.stat(filePath);
        } catch (error) {
          throw new LocalSnapshotChangedError(filePath, error);
        }
        const afterMetadata = scanFileMetadata(after);
        if (
          !after || after.type !== "file" ||
          afterMetadata.size !== content.byteLength ||
          !sameScanFileMetadata(metadata, afterMetadata)
        ) {
          throw new LocalSnapshotChangedError(filePath);
        }
        const oid = (await git.hashBlob({ object: content })).oid;
        if (options.persistChangedBlobs && baseEntries.get(filePath)?.oid !== oid) {
          const writtenOid = await git.writeBlob({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, blob: content });
          if (writtenOid !== oid) throw new Error("Git blob identity changed while persisting a local snapshot.");
        }
        return {
          entry: { mode: "100644", path: filePath, oid, type: "blob" },
          content_sha256: sha256(content),
          bytes: content.byteLength,
          scan_metadata: afterMetadata
        };
      } finally {
        releaseBytes();
      }
    });
    const rootPolicy = options.rootPolicy || await this.readRootIgnorePolicy();
    const snapshot = { files, entries: new Map(files.map((filePath, index) => [filePath, values[index]])), rootPolicy };
    if (options.verifyInventory) {
      if (options.beforeInventoryVerification) options.beforeInventoryVerification();
      await this.verifyLocalPolicySnapshot(snapshot);
    }
    if (options.persistScanCache) await this.writeScanCache(snapshot.entries);
    return snapshot;
  }

  async verifyLocalPolicySnapshot(snapshot) {
    if (!snapshot.rootPolicy || !Array.isArray(snapshot.files)) throw new LocalSnapshotChangedError(".gitignore");
    const current = await this.readRootIgnorePolicy();
    if (current.oid !== snapshot.rootPolicy.oid ||
        snapshot.entries.get(".gitignore")?.entry.oid !== (snapshot.rootPolicy.oid ?? undefined) ||
        (current.bytes === null) !== (snapshot.rootPolicy.bytes === null) ||
        (current.bytes !== null && !current.bytes.equals(snapshot.rootPolicy.bytes)) ||
        !sameStringArray(snapshot.files, await this.scanSyncableFiles(snapshot.rootPolicy.policy))) {
      throw new LocalSnapshotChangedError(".gitignore");
    }
  }

  async createLocalCommitFromSnapshot(message, snapshot) {
    await this.verifyLocalPolicySnapshot(snapshot);
    const base =  await this.resolveRef("refs/heads/local");
    const baseEntries = base ? await this.flattenTree(base) : new Map();
    const nextEntries = new Map(baseEntries);
    const localSet = new Set(snapshot.files);
    for (const filePath of baseEntries.keys()) {
      if (!localSet.has(filePath)) nextEntries.delete(filePath);
    }
    for (const [filePath, value] of snapshot.entries) nextEntries.set(filePath, value.entry);
    const tree = await this.writeTreeFromEntries(nextEntries);
    if (base) {
      const { commit } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: base });
      if (commit.tree === tree) return null;
    } else if (nextEntries.size === 0) {
      return null;
    }
    await this.verifyLocalPolicySnapshot(snapshot);
    return await this.commitTree(tree, base, message);
  }

  async createMetadataCommit(message) {
    const base = await this.resolveRef("refs/heads/local");
    if (!base) return null;
    const { commit } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: base });
    return await this.commitTree(commit.tree, base, message);
  }

  async commitTree(tree, base, message) {
    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();
    const identity = { name: "obts device", email: "device@obts.local", timestamp, timezoneOffset };
    const commit = await git.writeCommit({
      fs: this.fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      commit: { tree, parent: base ? [base] : [], message, author: identity, committer: identity }
    });
    await this.updateRef("refs/heads/local", commit, base);
    return commit;
  }

  async readRootIgnoreBytes() {
    const trusted = typeof this.adapter.readRootIgnorePolicyNoFollow === "function"
      ? await this.adapter.readRootIgnorePolicyNoFollow(MAX_ROOT_IGNORE_BYTES)
      : undefined;
    const listing = await this.adapter.list("");
    const metadata = await this.adapter.stat(".gitignore");
    const present = (listing.files || []).includes(".gitignore");
    if (!present && !metadata && !(listing.folders || []).includes(".gitignore") &&
        (trusted === null || trusted === undefined)) return null;
    if (!present || !metadata || metadata.type !== "file") {
      throw new ObtsBlockedError("root_ignore_changed", "Root .gitignore is not a regular readable file.");
    }
    if (metadata.size > MAX_ROOT_IGNORE_BYTES) {
      throw new ObtsBlockedError("root_ignore_too_large", "Root .gitignore exceeds the byte limit.");
    }
    const raw = trusted === undefined ? await this.adapter.readBinary(".gitignore") : trusted;
    if (raw === null) throw new ObtsBlockedError("root_ignore_changed", "Root .gitignore changed while reading.");
    if (raw.byteLength > MAX_ROOT_IGNORE_BYTES) {
      throw new ObtsBlockedError("root_ignore_too_large", "Root .gitignore exceeds the byte limit.");
    }
    return Buffer.from(raw);
  }

  async readRootIgnorePolicy() {
    const bytes = await this.readRootIgnoreBytes();
    const verified = await this.readRootIgnoreBytes();
    if ((verified === null) !== (bytes === null) ||
        (verified !== null && !verified.equals(bytes))) {
      throw new ObtsBlockedError("root_ignore_changed", "Root .gitignore changed while reading.");
    }
    return { bytes, oid: bytes === null ? null : (await git.hashBlob({ object: bytes })).oid,
      policy: createRootIgnorePolicy(bytes) };
  }

  async rootIgnoreProtocolCapability() {
    await this.readRootIgnorePolicy();
    return "root-ignore-v1";
  }

  async scanSyncableFiles(policy = null, onProgress = undefined) {
    const result = (await this.listLocalVaultInventory("", policy, false, onProgress)).files.filter((filePath) => isSyncableVaultPath(filePath));
    return assertNoCaseCollisions(result.sort());
  }

  reportCheckingProgress(completed, total, fullAudit = false) {
    const now = Date.now();
    if (completed !== 0 && completed !== total && now - this.plugin.lastCheckingProgressAt < 250) return;
    this.plugin.lastCheckingProgressAt = now;
    const action = fullAudit ? "Verifying contents (local files)" : "Checking (local files)";
    this.reportOperationProgress(total > 0 ? `${action} ${completed}/${total}` : action, "file_inventory_check");
  }

  reportOperationProgress(label, diagnosticPoint) {
    if (typeof this.plugin.setOperationProgress === "function") {
      this.plugin.setOperationProgress(label, diagnosticPoint);
    } else {
      this.plugin.setStatus(label);
    }
  }

  async localSnapshotSummary() {
    const rootPolicy = await this.readRootIgnorePolicy();
    const inventory = await this.listLocalVaultInventory("", rootPolicy.policy);
    const files = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    const directories = inventory.directories;
    const snapshot = await this.captureLocalFileSnapshot(files, new Map(), { reportProgress: true, rootPolicy, verifyInventory: true });
    const hash = createSha("sha256");
    for (const directoryPath of directories) {
      hash.update("dir\0");
      hash.update(directoryPath);
      hash.update("\0");
    }
    hash.update("root-policy\0");
    hash.update(rootPolicy.oid || "absent");
    hash.update("\0");
    let bytes = 0;
    for (const filePath of files) {
      const value = snapshot.entries.get(filePath);
      bytes += value.bytes;
      hash.update(filePath);
      hash.update("\0");
      hash.update(Buffer.from(value.content_sha256, "hex"));
      hash.update("\0");
    }
    return { fingerprint: hash.digest("hex"), fileCount: files.length, bytes };
  }

  async localContentMatchesTree(localFiles, targetMain) {
    const targetEntries = await this.listTreeBlobOids(targetMain);
    if (localFiles.length !== targetEntries.size) return false;
    const snapshot = await this.captureLocalFileSnapshot(localFiles, new Map(), { reportProgress: true });
    for (const [filePath, targetOid] of targetEntries) {
      if (snapshot.entries.get(filePath)?.entry.oid !== targetOid) return false;
    }
    return true;
  }

  async localSnapshotMatchesTree(snapshot, targetMain) {
    const serverFiles = await this.listTreeFiles(targetMain);
    if (snapshot.size !== serverFiles.length) return false;
    for (const filePath of serverFiles) {
      const localContent = snapshot.get(filePath);
      const serverContent = await this.readBlob(targetMain, filePath);
      if (!localContent || !serverContent || sha256(localContent) !== sha256(serverContent)) return false;
    }
    return true;
  }

  async classifyPendingCommit(pendingCommit, serverDeviceRef, targetMain) {
    if (!pendingCommit) return "none";
    if (!(await this.commitExists(pendingCommit))) return "divergent";
    if (await this.isAncestor(pendingCommit, targetMain)) return "repeat";
    if (serverDeviceRef) {
      if (await this.isAncestor(pendingCommit, serverDeviceRef)) return "repeat";
      if (await this.isAncestor(serverDeviceRef, pendingCommit)) return "fast_forward";
      return "divergent";
    }
    return await this.isAncestor(targetMain, pendingCommit) ? "fast_forward" : "divergent";
  }

  async readFileSnapshot(files) {
    const snapshot = new Map();
    for (const filePath of files) {
      const content = await this.adapterReadBinary(filePath);
      if (content !== null) snapshot.set(filePath, content);
    }
    return snapshot;
  }

  async restoreFileSnapshot(snapshot, priorLocalFiles, expectedEntries) {
    // The applied target, not a newly observed live image, authorizes restoration.
    // Deferred/divergent bytes fail this guard and stay visible for the later scan.
    expectedEntries = new Map(expectedEntries);
    const expectedDirectories = new Set([...expectedEntries.keys()].flatMap(directoryPrefixes));
    const clearExpected = (filePath) => {
      for (const key of expectedEntries.keys()) if (key === filePath || key.startsWith(`${filePath}/`)) expectedEntries.delete(key);
      for (const key of expectedDirectories) if (key === filePath || key.startsWith(`${filePath}/`)) expectedDirectories.delete(key);
    };
    const matchesExpected = async (filePath, raw) => {
      const current = (await this.readRecoveryFileSnapshot(filePath, undefined, raw)).fingerprint;
      if (expectedDirectories.has(filePath)) {
        if (current.kind !== "directory") return false;
      } else if (!this.fingerprintMatchesTreePath(current, filePath, expectedEntries)) return false;
      if (current.kind !== "directory") return true;
      const inventory = await this.listAdapterInventory(filePath, raw);
      const expectedFiles = [...expectedEntries.keys()].filter((key) => key.startsWith(`${filePath}/`)).sort();
      if (!sameStringArray(inventory.files.map((key) => `${filePath}/${key}`).sort(), expectedFiles)) return false;
      // Unknown empty subdirectories are local work too.
      if (inventory.directories.some((dir) => !expectedDirectories.has(`${filePath}/${dir}`))) return false;
      for (const child of expectedFiles) {
        const fingerprint = (await this.readRecoveryFileSnapshot(child, undefined, raw)).fingerprint;
        if (!this.fingerprintMatchesTarget(fingerprint, expectedEntries.get(child))) return false;
      }
      return true;
    };
    for (const filePath of priorLocalFiles.slice().sort(compareDeepestPathFirst)) {
      if (!snapshot.has(filePath)) await this.pathMutationGate.withExclusive([filePath], async (raw) => {
        if (await matchesExpected(filePath, raw)) {
          await this.adapterRemove(filePath, raw);
          clearExpected(filePath);
        }
      });
    }
    for (const [filePath, content] of Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      if (!(await this.removeBlockingMaterializationPaths(filePath, matchesExpected, clearExpected))) continue;
      try {
        await this.ensureAdapterDirectory(path.posix.dirname(filePath));
        for (const prefix of directoryPrefixes(filePath)) expectedDirectories.add(prefix);
      } catch (error) {
        // A writer may have replaced a prefix after its claim was released.
        if (error instanceof ObtsBlockedError && error.code === "directory_materialization_failed") continue;
        throw error;
      }
      await this.pathMutationGate.withExclusive([filePath], async (raw) => {
        if (!(await matchesExpected(filePath, raw))) return;
        if ((await raw.stat(filePath))?.type === "folder") await this.adapterRemove(filePath, raw);
        await raw.writeBinary(filePath, toArrayBuffer(content));
        clearExpected(filePath);
        expectedEntries.set(filePath, (await git.hashBlob({ object: content })).oid);
      });
    }
  }

  async createRecoveryBundle(operationType, targetMain, affectedPaths, journal = null, context = null) {
    const staged = await this.stageRecoveryBundleFiles(affectedPaths, "Checking (preparing recovery)");
    try {
      return await this.finalizeRecoveryBundle(staged, operationType, targetMain, affectedPaths, journal, context);
    } catch (error) {
      await this.fsp.rm(staged.partialDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async createStableRecoveryBundle(operationType, targetMain, affectedPaths, attempts = 3, context = null) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.createRecoveryBundle(operationType, targetMain, affectedPaths, null, context);
      } catch (error) {
        if (!(error instanceof LocalSnapshotChangedError)) throw error;
      }
    }
    return null;
  }

  async stageApplyRecoveryFiles(journal, affectedPaths, progressLabel, targetMatchedPaths = new Set(), journalPersisted = false) {
    let pendingPaths = affectedPaths.slice();
    while (pendingPaths.length > 0) {
      try {
        return await this.stageRecoveryBundleFiles(pendingPaths, progressLabel);
      } catch (error) {
        if (!(error instanceof LocalSnapshotChangedError)) throw error;
        journal.deferred_local_paths = this.expandDeferredApplyPaths(journal, targetMatchedPaths, [error.filePath]);
        const deferredAffectedPaths = new Set(pendingPaths.filter((filePath) =>
          journal.deferred_local_paths.some((deferred) => changedPathsConflict(filePath, deferred))
        ));
        if (deferredAffectedPaths.size === 0) throw error;
        journal.affected_paths = journal.affected_paths.filter((filePath) => !deferredAffectedPaths.has(filePath));
        pendingPaths = pendingPaths.filter((filePath) => !deferredAffectedPaths.has(filePath));
        for (const filePath of deferredAffectedPaths) {
          delete journal.preflight_sha256[filePath];
          delete journal.preflight_fingerprints[filePath];
        }
        if (journalPersisted) await writeJson(this.fsp, this.applyJournalPath, journal);
      }
    }
    return null;
  }

  async readRecoveryBundleFingerprints(bundleId, expectedOnboardingContext) {
    if (typeof bundleId !== "string" || !/^rec_[A-Za-z0-9_-]+$/u.test(bundleId)) {
      throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline is invalid.");
    }
    const bundleDir = path.join(this.obtsDir, "recovery", bundleId);
    const [complete, manifest, recordedChecksums, actualChecksums] = await Promise.all([
      readJson(this.fsp, path.join(bundleDir, "complete.json"), null),
      readJson(this.fsp, path.join(bundleDir, "manifest.json"), null),
      this.fsp.readFile(path.join(bundleDir, "checksums.sha256"), "utf8"),
      bundleChecksums(this.fsp, bundleDir, this.fileBufferBudgetBytes)
    ]);
    const expectedChecksums = `${actualChecksums.join("\n")}\n`;
    if (
      complete?.bundle_id !== bundleId || manifest?.bundle_id !== bundleId ||
      manifest?.operation_type !== "replace_local_with_server" ||
      !expectedOnboardingContext ||
      manifest.vault_id !== (expectedOnboardingContext.source_vault_id || "unknown") ||
      manifest.device_id !== (expectedOnboardingContext.source_device_id || "unknown") ||
      stableJson(manifest.onboarding_context) !== stableJson(expectedOnboardingContext) ||
      manifest.target_main !== expectedOnboardingContext.target_main ||
      stableJson(manifest.affected_paths) !== stableJson(expectedOnboardingContext.affected_paths) ||
      !Array.isArray(manifest.checksum_manifest) || recordedChecksums !== expectedChecksums
    ) {
      throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline failed validation.");
    }
    const fingerprints = new Map();
    for (const record of manifest.checksum_manifest) {
      if (typeof record !== "string") throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline is invalid.");
      const separator = record.indexOf("  ");
      if (separator < 0) throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline is invalid.");
      const kindOrHash = record.slice(0, separator);
      const relative = record.slice(separator + 2);
      if (!relative.startsWith("files/")) continue;
      const filePath = relative.slice("files/".length);
      if (!isSafeJournalPath(filePath) || !isRecoverableApplyPath(filePath) || fingerprints.has(filePath)) {
        throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline is invalid.");
      }
      if (/^[0-9a-f]{64}$/u.test(kindOrHash)) fingerprints.set(filePath, { kind: "file", sha256: kindOrHash });
      else if (["missing", "directory", "other"].includes(kindOrHash)) fingerprints.set(filePath, { kind: kindOrHash, sha256: null });
      else throw new ObtsBlockedError("onboarding_context_required", "The saved onboarding recovery baseline is invalid.");
    }
    return fingerprints;
  }

  async stageRecoveryBundleFiles(affectedPaths, progressLabel) {
    const bundleId = `rec_${Date.now()}_${randomHex(8)}`;
    const recoveryRoot = path.join(this.obtsDir, "recovery");
    const partialDir = path.join(recoveryRoot, `.partial-${bundleId}`);
    await this.fsp.rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      for (const dir of ["files", "git", "patches", "journal"]) {
      await this.fsp.mkdir(path.join(partialDir, dir), { recursive: true, mode: 0o700 });
    }
    const paths = affectedPaths.filter((filePath) => !filePath.startsWith(".obts/")).slice().sort();
    let createParents = Promise.resolve();
    const byteBudget = createByteBudget(this.fileBufferBudgetBytes);
    let completed = 0;
    const reportProgress = () => this.reportOperationProgress(
      paths.length > 0 ? `${progressLabel} ${completed}/${paths.length}` : "Applying",
      progressLabel.startsWith("Applying") ? "apply_recovery_prepare" : "local_snapshot"
    );
    reportProgress();
    const results = await runBoundedWork(paths, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: (nextCompleted) => {
        completed = nextCompleted;
        reportProgress();
      }
    }, async (filePath) => {
      const snapshot = await this.readRecoveryFileSnapshot(filePath, byteBudget);
      if (snapshot.fingerprint.kind === "file") {
        // Missing future descendants must not create a directory over the
        // captured ancestor file in a file-to-directory replacement.
        // Adapter mkdir is not atomic for concurrent shared parents.
        createParents = createParents.then(() => this.fsp.mkdir(path.dirname(path.join(partialDir, "files", filePath)), { recursive: true, mode: 0o700 }));
        await createParents;
        await this.fsp.writeFile(path.join(partialDir, "files", filePath), snapshot.content, { mode: 0o600 });
        if (isTextPatchPath(filePath)) await writeTextSnapshotPatch(this.fsp, partialDir, filePath, snapshot.content);
      }
      return {
        filePath,
        fingerprint: snapshot.fingerprint,
        checksum: snapshot.fingerprint.kind === "file"
          ? `${snapshot.fingerprint.sha256}  files/${filePath}`
          : `${snapshot.fingerprint.kind}  files/${filePath}`
      };
      });
      return { bundleId, partialDir, results };
    } catch (error) {
      await this.fsp.rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async finalizeRecoveryBundle(staged, operationType, targetMain, affectedPaths, journal, context = null) {
    const state = await this.readState();
    const bundleDir = path.join(this.obtsDir, "recovery", staged.bundleId);
    const manifest = {
      bundle_id: staged.bundleId,
      vault_id: state.vault_id || "unknown",
      device_id: state.device_id || "unknown",
      created_at: nowIso(),
      operation_type: operationType,
      apply_id: journal?.apply_id || null,
      onboarding_context: context,
      target_main: targetMain || "unknown",
      prior_local_main: state.local_main,
      prior_local_device_ref: state.server_device_ref,
      affected_paths: affectedPaths,
      platform: runtimePlatform(),
      plugin_version: PLUGIN_VERSION,
      checksum_manifest: staged.results.map((result) => result.checksum)
    };
    await writeJson(this.fsp, path.join(staged.partialDir, "manifest.json"), manifest);
    if (journal) await writeJson(this.fsp, path.join(staged.partialDir, "journal", "apply-journal.json"), journal);
    const pack = await this.createRecoveryRefsPack();
    await this.fsp.writeFile(path.join(staged.partialDir, "git", "local-refs.pack"), pack, { mode: 0o600 });
    await writeJson(this.fsp, path.join(staged.partialDir, "complete.json"), { bundle_id: staged.bundleId, completed_at: nowIso() });
    const expectedChecksums = await bundleChecksums(this.fsp, staged.partialDir, this.fileBufferBudgetBytes);
    const expectedChecksumManifest = `${expectedChecksums.join("\n")}\n`;
    const checksumPath = path.join(staged.partialDir, "checksums.sha256");
    await this.fsp.writeFile(checksumPath, expectedChecksumManifest, { mode: 0o600 });
    await syncRecoveryBundleTree(this.fsp, staged.partialDir);
    const observedChecksumManifest = await this.fsp.readFile(checksumPath, "utf8");
    const verifiedChecksums = await bundleChecksums(this.fsp, staged.partialDir, this.fileBufferBudgetBytes);
    if (
      observedChecksumManifest !== expectedChecksumManifest ||
      JSON.stringify(verifiedChecksums) !== JSON.stringify(expectedChecksums)
    ) {
      throw new ObtsBlockedError("recovery_bundle_verification_failed", "Recovery bundle verification failed before publication.");
    }
    await this.fsp.rename(staged.partialDir, bundleDir);
    if (typeof this.fsp.syncDirectory === "function") await this.fsp.syncDirectory(path.dirname(bundleDir));
    return staged.bundleId;
  }

  async readRecoveryFileSnapshot(filePath, byteBudget = createByteBudget(this.fileBufferBudgetBytes), raw = undefined) {
    const fsp = raw ? createDataAdapterFs(raw).promises : this.fsp;
    let before;
    try {
      before = await fsp.stat(filePath);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { fingerprint: { kind: "missing", sha256: null, oid: null }, content: null };
      }
      throw error;
    }
    if (before.isDirectory()) return { fingerprint: { kind: "directory", sha256: null, oid: null }, content: null };
    if (!before.isFile()) return { fingerprint: { kind: "other", sha256: null, oid: null }, content: null };
    const releaseBytes = await byteBudget.acquire(before.size || 0);
    try {
      const content = await fsp.readFile(filePath);
      let after;
      try {
        after = await fsp.stat(filePath);
      } catch (error) {
        throw new LocalSnapshotChangedError(filePath, error);
      }
      if (
        !after.isFile() || after.size !== content.byteLength || before.size !== after.size ||
        before.mtimeMs && after.mtimeMs && before.mtimeMs !== after.mtimeMs
      ) {
        throw new LocalSnapshotChangedError(filePath);
      }
      return {
        fingerprint: {
          kind: "file",
          sha256: sha256(content),
          oid: (await git.hashBlob({ object: content })).oid
        },
        content
      };
    } finally {
      releaseBytes();
    }
  }

  async createRecoveryRefsPack() {
    const localCommit = await this.resolveRef("refs/heads/local");
    if (!localCommit) return Buffer.alloc(0);
    const mainCommit = await this.resolveRef("refs/heads/main");
    if (mainCommit === localCommit) return Buffer.alloc(0);
    const oids = await this.collectIncrementalPackObjects(localCommit, mainCommit ? [mainCommit] : []);
    return oids.length ? await this.packObjects(oids) : Buffer.alloc(0);
  }

  async collectIncrementalPackObjects(commit, excludeCommits = []) {
    const stopCommits = new Set(excludeCommits.filter(Boolean));
    const objects = new Set();
    const visitedCommits = new Set();
    const visitCommit = async (oid) => {
      if (stopCommits.has(oid) || visitedCommits.has(oid)) return;
      visitedCommits.add(oid);
      const { commit: parsed } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid });
      objects.add(oid);
      let baseTree = null;
      const firstParent = parsed.parent[0];
      if (firstParent && await this.commitExists(firstParent)) {
        baseTree = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: firstParent })).commit.tree;
      }
      await this.collectChangedTreeObjects(parsed.tree, baseTree, objects);
      for (const parent of parsed.parent) await visitCommit(parent);
    };
    await visitCommit(commit);
    return [...objects].sort();
  }

  async collectChangedTreeObjects(treeOid, baseTreeOid, objects) {
    if (treeOid === baseTreeOid) return;
    objects.add(treeOid);
    const { tree } = await git.readTree({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    let baseEntries = new Map();
    if (baseTreeOid) {
      const { tree: baseTree } = await git.readTree({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: baseTreeOid });
      baseEntries = new Map(baseTree.map((entry) => [entry.path, entry]));
    }
    for (const entry of tree) {
      const baseEntry = baseEntries.get(entry.path);
      if (baseEntry && baseEntry.type === entry.type && baseEntry.oid === entry.oid) continue;
      if (entry.type === "tree") {
        await this.collectChangedTreeObjects(entry.oid, baseEntry && baseEntry.type === "tree" ? baseEntry.oid : null, objects);
      } else {
        objects.add(entry.oid);
      }
    }
  }

  async planPackChunks(commit, excludeCommits, targetChunkBytes, maxChunkBytes) {
    const cacheKey = JSON.stringify([commit, [...excludeCommits].sort(), targetChunkBytes, maxChunkBytes]);
    const cached = this.packPlanCache.get(cacheKey);
    if (cached) return cached.map((group) => group.slice());
    const oids = await this.collectIncrementalPackObjects(commit, excludeCommits);
    const sizes = [];
    const objectTypes = [];
    for (let index = 0; index < oids.length; index += 1) {
      // isomorphic-git exposes object size only after reading the whole object, so keep one unknown-size producer live at a time.
      const result = await git.readObject({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: oids[index], format: "content" });
      sizes.push(result.object.byteLength);
      objectTypes.push(result.type);
      this.reportOperationProgress(
        `Preparing upload (planning objects) ${index + 1}/${oids.length}`,
        "upload_prepare"
      );
      if ((index + 1) % FILE_WORK_YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const groups = [];
    let group = [];
    let groupBytes = 0;
    for (let index = 0; index < oids.length; index += 1) {
      const oid = oids[index];
      const size = sizes[index];
      const packHeadroom = Math.min(1024 * 1024, Math.max(64 * 1024, Math.floor(maxChunkBytes * 0.1)));
      if (size > maxChunkBytes - packHeadroom) {
        const currentPaths = objectTypes[index] === "blob"
          ? [...(await this.flattenTree(commit)).values()].filter((entry) => entry.oid === oid).map((entry) => entry.path).slice(0, 3)
          : [];
        throw new ObtsBlockedError("object_too_large_for_chunk", "A Git object exceeds the upload chunk limit; queued work remains local.", {
          object_type: objectTypes[index],
          object_oid: oid,
          object_bytes: size,
          object_limit_bytes: maxChunkBytes - packHeadroom,
          operation_phase: "upload_prepare",
          current_paths: currentPaths
        });
      }
      if (group.length > 0 && groupBytes + size > targetChunkBytes) {
        groups.push(group);
        group = [];
        groupBytes = 0;
      }
      group.push(oid);
      groupBytes += size;
    }
    if (group.length > 0) groups.push(group);
    if (this.packPlanCache.size >= 4) this.packPlanCache.delete(this.packPlanCache.keys().next().value);
    this.packPlanCache.set(cacheKey, groups.map((entry) => entry.slice()));
    return groups;
  }

  async packObjectChunk(oids, maxChunkBytes) {
    const packfile = await this.packObjects(oids);
    if (packfile.byteLength > maxChunkBytes) {
      throw new ObtsBlockedError("chunk_too_large", "Generated Git pack chunk exceeds the negotiated transfer limit.");
    }
    return packfile;
  }

  async createPackForCommit(commit, excludeCommits = []) {
    return await this.packObjects(await this.collectIncrementalPackObjects(commit, excludeCommits));
  }

  async packObjects(oids) {
    const { packfile } = await git.packObjects({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oids });
    if (!packfile) throw new Error("isomorphic-git did not return a packfile.");
    return Buffer.from(packfile);
  }

  async importPack(packfile, diagnosticFlow = "sync", initialBreadcrumbs = []) {
    if (!packfile || packfile.byteLength === 0 || isEmptyGitPack(packfile)) return;
    const breadcrumbs = initialBreadcrumbs.slice(0, 16);
    const packPath = path.join(this.gitdir, "objects", "pack", `obts-pull-${Date.now()}-${randomHex(4)}.pack`);
    try {
      await this.fsp.mkdir(path.dirname(packPath), { recursive: true, mode: 0o700 });
      breadcrumbs.push(makeDiagnosticBreadcrumb("pack_persist_write", "started", packfile));
      await this.fsp.writeFile(packPath, packfile, { mode: 0o600 });
      breadcrumbs.push(makeDiagnosticBreadcrumb("pack_persist_write", "succeeded", packfile));
    } catch (error) {
      breadcrumbs.push(makeDiagnosticBreadcrumb("pack_persist_write", "failed", packfile, diagnosticIoCode(error)));
      const wrapped = new Error("Obsidian's vault adapter could not write the downloaded Git pack.", { cause: error });
      annotateDiagnosticError(wrapped, {
        flow: diagnosticFlow,
        stage: "pack_persist",
        failureCode: "adapter_write_failed",
        breadcrumbs
      });
      throw wrapped;
    }
    let persistedPack;
    try {
      persistedPack = await this.waitForPersistedBinary(packPath, packfile);
      breadcrumbs.push(makeDiagnosticBreadcrumb("pack_persist_read", "returned", persistedPack));
    } catch (error) {
      breadcrumbs.push(makeDiagnosticBreadcrumb("pack_persist_read", "failed", undefined, diagnosticIoCode(error)));
      annotateDiagnosticError(error, {
        flow: diagnosticFlow,
        stage: "pack_persist",
        failureCode: "adapter_read_failed",
        breadcrumbs
      });
      throw error;
    }
    this.fs.setReadOverlay(packPath, persistedPack);
    const indexingFs = createPackIndexFs(this.fs, persistedPack, (event) => {
      if (breadcrumbs.length < 16) breadcrumbs.push(normalizeDiagnosticBreadcrumb(event));
    });
    breadcrumbs.push(makeDiagnosticBreadcrumb("index_pack", "started", persistedPack));
    try {
      await git.indexPack({ fs: indexingFs, dir: this.vaultDir, gitdir: this.gitdir, filepath: path.relative(this.vaultDir, packPath) });
    } catch (error) {
      if (breadcrumbs.length < 16) breadcrumbs.push(makeDiagnosticBreadcrumb("index_pack", "failed"));
      const caller = error && error.caller ? ` at ${error.caller}` : "";
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Downloaded Git pack indexing failed${caller}: ${message}`, { cause: error });
      annotateDiagnosticError(wrapped, {
        flow: diagnosticFlow,
        stage: "pack_index",
        failureCode: message.includes("Missing Buffer dependency")
          ? "missing_buffer_dependency"
          : message.includes("pack.slice")
            ? "null_pack_slice"
            : "pack_index_failed",
        breadcrumbs
      });
      throw wrapped;
    }
  }

  async waitForPersistedBinary(filePath, expected = null) {
    const expectedBytes = expected === null ? null : Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const value = await this.fsp.readFile(filePath);
        const persisted = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (expectedBytes === null || buffersEqual(persisted, expectedBytes)) return persisted;
        lastError = new Error("Persisted bytes did not match the downloaded Git pack.");
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
    throw new Error("Obsidian's vault adapter could not persist the downloaded Git pack.", { cause: lastError });
  }

  async listTreeFiles(commit) {
    if (!commit) return [];
    const result = [];
    await this.walkTree(commit, "", async (entryPath, entry) => {
      if (entry.type === "blob" && isSyncableVaultPath(entryPath)) result.push(entryPath);
    });
    return result.sort();
  }

  async readIndexDelta(fromCommit = null) {
    const state = await this.readState();
    const head = state.local_head;
    if (!head || !(await this.commitExists(head))) {
      return { head: null, base: null, mode: "unavailable", files: [], changes: [] };
    }
    const targetEntries = await this.listTreeBlobOids(head);
    let base = null;
    let mode = "rebuild";
    let priorEntries = new Map();
    if (typeof fromCommit === "string") {
      if (!(await this.commitExists(fromCommit)) || !(await this.isAncestor(fromCommit, head))) {
        return { head, base: fromCommit, mode: "diverged", files: [], changes: [] };
      }
      base = fromCommit;
      mode = "incremental";
      priorEntries = await this.listTreeBlobOids(fromCommit);
    }
    const targetDigests = new Map();
    const files = [];
    for (const [filePath, oid] of [...targetEntries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const contentSha256 = `sha256:${sha256(await this.readBlobOid(oid))}`;
      targetDigests.set(filePath, contentSha256);
      files.push({ path: filePath, oid, content_sha256: contentSha256 });
    }
    const paths = Array.from(new Set([...priorEntries.keys(), ...targetEntries.keys()])).sort();
    const changes = [];
    for (const filePath of paths) {
      const before = priorEntries.get(filePath);
      const after = targetEntries.get(filePath);
      if (before === after) continue;
      changes.push({
        path: filePath,
        kind: before === undefined ? "add" : after === undefined ? "delete" : "modify",
        oid: after || null,
        content_sha256: after ? targetDigests.get(filePath) : null
      });
    }
    return { head, base, mode, files, changes };
  }

  async listTreeBlobOids(commit) {
    const entries = await this.flattenTree(commit);
    return new Map([...entries]
      .filter(([filePath]) => isSyncableVaultPath(filePath))
      .map(([filePath, entry]) => [filePath, entry.oid]));
  }

  async readBlobOid(oid) {
    const result = await git.readObject({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid, format: "content" });
    if (result.type !== "blob") throw new Error(`Git object ${oid} is not a blob.`);
    return Buffer.from(result.object);
  }

  async readBlob(commit, filePath) {
    const result = await git.readBlob({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: commit, filepath: filePath });
    return Buffer.from(result.blob);
  }

  async readBlobIfPresent(commit, filePath) {
    try {
      return await this.readBlob(commit, filePath);
    } catch {
      return null;
    }
  }

  async collectReachableObjects(commit) {
    const seen = new Set();
    const visitCommit = async (oid) => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const { commit: parsed } = await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid });
      await this.collectTreeObjects(parsed.tree, seen);
      for (const parent of parsed.parent) await visitCommit(parent);
    };
    await visitCommit(commit);
    return [...seen].sort();
  }

  async collectTreeObjects(treeOid, seen) {
    if (seen.has(treeOid)) return;
    seen.add(treeOid);
    const { tree } = await git.readTree({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    for (const entry of tree) {
      if (entry.type === "tree") await this.collectTreeObjects(entry.oid, seen);
      else seen.add(entry.oid);
    }
  }

  async flattenTree(commit) {
    const entries = new Map();
    await this.walkTree(commit, "", async (entryPath, entry) => {
      if (entry.type === "blob") entries.set(entryPath, { mode: entry.mode, path: entryPath, oid: entry.oid, type: "blob" });
    });
    return entries;
  }

  async writeTreeFromEntries(entries) {
    const root = { blobs: new Map(), trees: new Map() };
    for (const [entryPath, entry] of entries) {
      const segments = entryPath.split("/");
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.trees.get(segment);
        if (!child) {
          child = { blobs: new Map(), trees: new Map() };
          node.trees.set(segment, child);
        }
        node = child;
      }
      const basename = segments.at(-1);
      if (basename) node.blobs.set(basename, { mode: entry.mode, path: basename, oid: entry.oid, type: "blob" });
    }
    return await this.writeTreeNode(root);
  }

  async writeTreeNode(node) {
    const tree = [];
    for (const [name, child] of [...node.trees.entries()].sort(compareByName)) {
      tree.push({ mode: "040000", path: name, oid: await this.writeTreeNode(child), type: "tree" });
    }
    for (const [, entry] of [...node.blobs.entries()].sort(compareByName)) tree.push(entry);
    tree.sort((left, right) => left.path.localeCompare(right.path));
    return await git.writeTree({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, tree });
  }

  async walkTree(treeish, prefix, visit) {
    let treeOid = treeish;
    if (prefix === "") {
      try {
        treeOid = (await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeish })).commit.tree;
      } catch {
        treeOid = treeish;
      }
    }
    const { tree } = await git.readTree({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    for (const entry of tree) {
      const entryPath = prefix ? `${prefix}/${entry.path}` : entry.path;
      await visit(entryPath, entry);
      if (entry.type === "tree") await this.walkTree(entry.oid, entryPath, visit);
    }
  }

  async getDeviceSelf(token) {
    const response = await fetchWithTimeout(this.url("/api/v1/device/self"), {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async reconcileServerVaultStatus(vaultStatus, throwIfBlocked = false) {
    if (vaultStatus !== "active" && vaultStatus !== "blocked_integrity") return true;
    const state = await this.readState();
    if (vaultStatus === "blocked_integrity") {
      if (state.last_error_code !== "blocked_integrity") {
        await this.markBlocked("blocked_integrity");
        this.plugin.setStatus((await this.readState()).status_label, { notify: false });
      }
      if (throwIfBlocked) {
        throw new ObtsTransportError(409, "blocked_integrity", "Vault persistent state failed integrity checks.");
      }
      return false;
    }
    if (state.last_error_code === "blocked_integrity") {
      await this.writeState(Object.assign({}, state, {
        status_label: "Checking",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.recordLocalChangeHint();
      this.plugin.syncQueued = true;
      if (typeof this.plugin.clearTransientSyncFailures === "function") this.plugin.clearTransientSyncFailures();
      const resumedState = await this.readState();
      this.plugin.setStatus(resumedState.status_label, { notify: false });
      if (typeof this.plugin.scheduleQueuedSync === "function") this.plugin.scheduleQueuedSync(0);
    }
    return true;
  }

  async renameCurrentDevice(deviceName) {
    await this.initialize();
    const normalized = normalizeDisplayName(deviceName);
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    const token = await this.readDeviceToken();
    this.plugin.deviceNameRevision += 1;
    const response = await fetchWithTimeout(this.url("/api/v1/device/self"), {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ device_name: normalized })
    });
    if (!response.ok) await throwResponseError(response);
    const renamed = await response.json();
    if (renamed.device_id !== state.device_id) {
      throw new ObtsBlockedError("device_identity_mismatch", "Server device identity does not match local state.");
    }
    await this.applyServerDeviceName(renamed.device_name);
    return renamed.device_name;
  }

  async applyServerDeviceName(deviceName, persistState = true) {
    const normalized = normalizeDisplayName(deviceName);
    if (persistState) {
      const state = await this.readState();
      if (state.device_name !== normalized) {
        await this.writeState(Object.assign({}, state, { device_name: normalized, updated_at: nowIso() }));
      }
    }
    if (this.plugin.settings.deviceName !== normalized) {
      this.plugin.settings.deviceName = normalized;
      await this.plugin.saveSettings();
    }
  }

  async pullChunk({ vaultId, deviceId, token, currentLocalMain, requestedTarget, currentEventSeq, cursor }) {
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${vaultId}/sync/pull-chunk`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        api_version: API_VERSION,
        plugin_version: PLUGIN_VERSION,
        vault_id: vaultId,
        device_id: deviceId,
        current_local_main: currentLocalMain,
        requested_target: requestedTarget,
        current_event_seq: currentEventSeq || 0,
        cursor,
        root_ignore_capability: await this.rootIgnoreProtocolCapability()
      })
    });
    if (!response.ok) await throwResponseError(response);
    return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
  }

  async validateCompleteTransferCheckpoint(checkpoint, currentLocalMain) {
    if (transferManifestSha256(checkpoint.manifest) !== checkpoint.manifest_sha256) {
      throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed transfer checkpoint manifest digest does not match.");
    }
    if (currentLocalMain !== null && !(await this.commitExists(currentLocalMain))) {
      throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed transfer checkpoint base commit is unavailable.");
    }
    await this.verifyTransferredRootIgnore(checkpoint.manifest);
    const targetEntries = await this.listTreeBlobOids(checkpoint.target_main);
    const priorEntries = currentLocalMain === null ? new Map() : await this.listTreeBlobOids(currentLocalMain);
    const expectedChangedPaths = [...new Set([...priorEntries.keys(), ...targetEntries.keys()])]
      .filter((filePath) => priorEntries.get(filePath) !== targetEntries.get(filePath))
      .sort();
    const recordedChangedPaths = [...checkpoint.manifest.changed_paths].sort();
    if (JSON.stringify(recordedChangedPaths) !== JSON.stringify(expectedChangedPaths)) {
      throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed transfer checkpoint path effects do not match the target tree.");
    }
    const targetPaths = [...targetEntries.keys()].sort();
    const recordedSizePaths = Object.keys(checkpoint.manifest.target_file_sizes).sort();
    if (JSON.stringify(recordedSizePaths) !== JSON.stringify(targetPaths)) {
      throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed transfer checkpoint file-size inventory does not match the target tree.");
    }
    for (let index = 0; index < targetPaths.length; index += 1) {
      const filePath = targetPaths[index];
      const content = await this.readBlobOid(targetEntries.get(filePath));
      if (checkpoint.manifest.target_file_sizes[filePath] !== content.byteLength) {
        throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed transfer checkpoint file-size evidence does not match the target tree.");
      }
      if ((index + 1) % 100 === 0) {
        this.reportOperationProgress(`Verified ${index + 1} transferred file records`, "transfer_checkpoint_verification");
      }
    }
  }

  async pull(vaultId, deviceId, token, currentLocalMain, requestedTarget = "latest", currentEventSeq = undefined) {
    this.reportOperationProgress("Checking (requesting changes)", "sync_request");
    await this.admitApplyRecovery();
    await this.retryPendingAppliedAcknowledgement();
    if (await this.readPendingAppliedAcknowledgement()) throw new ObtsBlockedError("applied_main_acknowledgement_failed", "Settle the previous applied snapshot before pulling another.");
    const capabilities = await this.syncCapabilities();
    if (capabilities) {
      const checkpoint = await readRecoveryJsonStrict(this.fsp, this.pullTransferPath, "invalid_transfer_checkpoint", "The saved pull checkpoint is unreadable. Preserve it for recovery.");
      let checkpointMatches = checkpoint &&
        checkpoint.vault_id === vaultId &&
        checkpoint.device_id === deviceId &&
        checkpoint.current_local_main === currentLocalMain &&
        checkpoint.current_event_seq === (currentEventSeq || 0) &&
        (requestedTarget === "latest" || requestedTarget === checkpoint.target_main);
      if (checkpoint?.complete === true) {
        if (!isCompletePullCheckpoint(checkpoint) || checkpoint.vault_id !== vaultId || checkpoint.device_id !== deviceId ||
          (requestedTarget !== "latest" && requestedTarget !== checkpoint.target_main) || !(await this.commitExists(checkpoint.target_main))) {
          throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed pull transfer checkpoint is invalid.");
        }
        await this.validateCompleteTransferCheckpoint(checkpoint, checkpoint.current_local_main);
        await publishJournalDiagnosticSummary(this.fsp, this.pullTransferPath, checkpoint);
        if (checkpointMatches) return { manifest: checkpoint.manifest, packfile: Buffer.alloc(0) };
        // Accepted proposal normalization can advance the local base after this
        // download. Keep the immutable checkpoint and derive only its local diff.
        if (!currentLocalMain || !(await this.isAncestor(currentLocalMain, checkpoint.target_main)) ||
          (currentEventSeq || 0) > checkpoint.manifest.event_seq) {
          throw new ObtsBlockedError("invalid_transfer_checkpoint", "The saved snapshot cannot safely advance the current local baseline.");
        }
        const prior = await this.listTreeBlobOids(currentLocalMain);
        const target = await this.listTreeBlobOids(checkpoint.target_main);
        const changedPaths = [...new Set([...prior.keys(), ...target.keys()])].filter(filePath => prior.get(filePath) !== target.get(filePath)).sort();
        return { manifest: Object.assign({}, checkpoint.manifest, { changed_paths: changedPaths }), packfile: Buffer.alloc(0) };
      }
      let cursor = checkpointMatches ? checkpoint.next_cursor : 0;
      let target = checkpointMatches ? checkpoint.target_main : requestedTarget;
      if (checkpoint && !checkpointMatches) {
        throw new ObtsBlockedError("invalid_transfer_checkpoint", "The saved immutable transfer does not match local state. Preserve it for recovery before starting another transfer.");
      }
      let finalManifest = null;
      let chunkCount = checkpointMatches ? checkpoint.received_chunks || 0 : 0;
      let transferredBytes = checkpointMatches ? checkpoint.transferred_bytes || 0 : 0;
      while (true) {
        const chunk = await this.pullChunk({
          vaultId,
          deviceId,
          token,
          currentLocalMain,
          requestedTarget: target,
          currentEventSeq,
          cursor
        });
        if (chunk.packfile.byteLength !== chunk.manifest.chunk_bytes || sha256(chunk.packfile) !== chunk.manifest.chunk_sha256) {
          throw new ObtsBlockedError("chunk_digest_mismatch", "Downloaded Git chunk failed integrity validation.");
        }
        chunkCount += 1;
        transferredBytes += chunk.packfile.byteLength;
        if (chunkCount > capabilities.max_transfer_chunks || transferredBytes > capabilities.max_transfer_bytes) {
          throw new ObtsBlockedError("transfer_too_large", "Pull transfer exceeded negotiated limits.");
        }
        await this.importPack(chunk.packfile, "sync", [makeDiagnosticBreadcrumb("pull_chunk", "succeeded", chunk.packfile)]);
        finalManifest = chunk.manifest;
        target = finalManifest.target_main;
        if (finalManifest.complete) {
          if (!(await this.commitExists(finalManifest.target_main))) {
            throw new ObtsBlockedError("transfer_incomplete", "Downloaded Git chunks do not contain the target commit.");
          }
          await writeJson(this.fsp, this.pullTransferPath, {
            vault_id: vaultId,
            device_id: deviceId,
            current_local_main: currentLocalMain,
            current_event_seq: currentEventSeq || 0,
            target_main: target,
            next_cursor: finalManifest.next_cursor,
            received_chunks: chunkCount,
            transferred_bytes: transferredBytes,
            complete: true,
            manifest: finalManifest,
            manifest_sha256: transferManifestSha256(finalManifest),
            updated_at: nowIso()
          });
          this.reportOperationProgress(`Downloaded ${chunkCount} sync chunks · ${formatBytes(transferredBytes)}`, "sync_download");
          break;
        }
        if (finalManifest.next_cursor <= cursor) throw new ObtsBlockedError("invalid_transfer_cursor", "Pull transfer did not advance.");
        cursor = finalManifest.next_cursor;
        await writeJson(this.fsp, this.pullTransferPath, {
          vault_id: vaultId,
          device_id: deviceId,
          current_local_main: currentLocalMain,
          current_event_seq: currentEventSeq || 0,
          target_main: target,
          next_cursor: cursor,
          received_chunks: chunkCount,
          transferred_bytes: transferredBytes,
          complete: false,
          updated_at: nowIso()
        });
        this.reportOperationProgress(`Downloaded ${chunkCount} sync chunks · ${formatBytes(transferredBytes)}`, "sync_download");
      }
      await this.verifyTransferredRootIgnore(finalManifest);
      return { manifest: finalManifest, packfile: Buffer.alloc(0) };
    }
    const multipart = createMultipartBody([
      {
        name: "manifest",
        contentType: "application/json",
        data: Buffer.from(JSON.stringify({
          api_version: API_VERSION,
          plugin_version: PLUGIN_VERSION,
          vault_id: vaultId,
          device_id: deviceId,
          current_local_main: currentLocalMain,
          requested_target: requestedTarget,
          root_ignore_capability: await this.rootIgnoreProtocolCapability(),
          ...(currentEventSeq === undefined ? {} : { current_event_seq: currentEventSeq })
        }))
      },
      { name: "packfile", filename: "have.pack", contentType: "application/x-git-packed-objects", data: Buffer.alloc(0) }
    ]);
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${vaultId}/sync/pull`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": multipart.contentType },
      body: multipart.body
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    const pulled = parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
    await this.importPack(pulled.packfile);
    await this.verifyTransferredRootIgnore(pulled.manifest);
    return { manifest: pulled.manifest, packfile: Buffer.alloc(0) };
  }

  async push(vaultId, token, manifest, packfile) {
    const multipart = createMultipartBody([
      { name: "manifest", contentType: "application/json", data: Buffer.from(JSON.stringify(manifest)) },
      { name: "packfile", filename: "pack.pack", contentType: "application/x-git-packed-objects", data: Buffer.from(packfile) }
    ]);
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${vaultId}/sync/push`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": multipart.contentType },
      body: multipart.body
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async reportDeviceStatus() {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    let token;
    try {
      token = await this.readDeviceToken();
    } catch {
      return;
    }
    const queue = await this.readQueue();
    const operation = typeof this.plugin.operationDetails === "function" ? this.plugin.operationDetails() : null;
    const stateUpdatedAt = Date.parse(state.updated_at || "");
    const operationIsNewer = operation && (
      !Number.isFinite(stateUpdatedAt) || operation.progressUpdatedAt > stateUpdatedAt
    );
    const activeStatusLabel = operation && operation.availability === "busy" && operation.label &&
      operationIsNewer && isReportableOperationStatus(operation.label)
      ? `${operation.label.replace(/^(Applying \(listing vault files\)) [0-9]+ files · [0-9]+ directories$/u, "$1")}${operation.slow ? " (taking longer than expected)" : ""}`.slice(0, 80)
      : normalizePersistedStatusLabel(state.status_label, state.last_error_code, state.last_error_details);
    const nameRevision = this.plugin.deviceNameRevision;
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${state.vault_id}/sync/device-status`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        plugin_version: PLUGIN_VERSION,
        local_status_label: activeStatusLabel,
        local_error_code: state.last_error_code,
        local_queue_status: queue.status,
        local_main: state.local_main,
        local_head: state.local_head,
        path_capabilities: {
          adapter: "obsidian-data-adapter",
          platform: runtimePlatform(),
          root_ignore: true
        }
      })
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    const result = await response.json();
    if (nameRevision === this.plugin.deviceNameRevision) {
      await this.applyServerDeviceName(result.device_name, false);
      const latestState = await this.readState();
      const normalizedName = normalizeDisplayName(result.device_name);
      if (latestState.device_name !== normalizedName) {
        await this.writeState(Object.assign({}, latestState, { device_name: normalizedName, updated_at: nowIso() }));
      }
    }
    await this.reconcileServerVaultStatus(result.vault_status);
    this.plugin.handlePluginCompatibility(result.plugin);
    return result;
  }

  async pollEvents(vaultId, token, after) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Event cursor must be a non-negative safe integer.");
    }
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${vaultId}/sync/events?after=${after}`), {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async unpairDevice(vaultId, token) {
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${vaultId}/sync/unpair`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return await response.json();
  }

  async writePendingAppliedAcknowledgement(targetMain, eventSeq) {
    const existing = await this.readPendingAppliedAcknowledgement();
    if (existing && existing.target_main !== targetMain) {
      throw new ObtsBlockedError("applied_main_acknowledgement_failed", "A different applied main acknowledgement is still pending.");
    }
    await writeJson(this.fsp, this.pendingAppliedAckPath, {
      target_main: targetMain,
      event_seq: Number.isSafeInteger(eventSeq) && eventSeq >= 0 ? eventSeq : 0,
      created_at: existing && typeof existing.created_at === "string" ? existing.created_at : nowIso()
    });
  }

  async readPendingAppliedAcknowledgement() {
    const pending = await readRecoveryJsonStrict(this.fsp, this.pendingAppliedAckPath, "applied_main_acknowledgement_failed", "The pending acknowledgement is unreadable. Preserve it for recovery.");
    if (pending === null) return null;
    if (
      !pending || typeof pending !== "object" || !/^[0-9a-f]{40}$/u.test(pending.target_main || "") ||
      !Number.isSafeInteger(pending.event_seq) || pending.event_seq < 0
    ) {
      throw new ObtsBlockedError("applied_main_acknowledgement_failed", "The pending applied main acknowledgement is invalid.");
    }
    return pending;
  }

  async retryPendingAppliedAcknowledgement() {
    const pending = await this.readPendingAppliedAcknowledgement();
    if (!pending) return false;
    const state = await this.readState();
    if (state.local_main !== pending.target_main) {
      throw new ObtsBlockedError("applied_main_acknowledgement_failed", "Local state does not match the pending applied main acknowledgement.");
    }
    if ((state.last_applied_event_seq || 0) < pending.event_seq) {
      await this.writeState(Object.assign({}, state, {
        last_event_seq: Math.max(state.last_event_seq || 0, pending.event_seq),
        last_applied_event_seq: pending.event_seq,
        updated_at: nowIso()
      }));
    }
    await this.completePendingAppliedAcknowledgement(pending, await this.readState());
    return true;
  }

  async completePendingAppliedAcknowledgement(pending, state = undefined) {
    const currentState = state || await this.readState();
    if (!currentState.vault_id || !currentState.device_id) return;
    const token = await this.readDeviceToken();
    let response;
    try {
      response = await postJsonWithBearer(
        this.url(`/api/v1/vaults/${currentState.vault_id}/sync/applied`),
        token,
        { applied_main: pending.target_main, root_ignore_capability: await this.rootIgnoreProtocolCapability() }
      );
    } catch (error) {
      if (!(error instanceof ObtsTransportError && error.status === 404)) throw error;
      let self = await this.getDeviceSelf(token);
      if (self.last_applied_main !== pending.target_main) {
        await postJsonWithBearer(
          this.url(`/api/v1/vaults/${currentState.vault_id}/onboarding/complete`),
          token,
          { applied_main: pending.target_main, root_ignore_capability: await this.rootIgnoreProtocolCapability() }
        );
        self = await this.getDeviceSelf(token);
      }
      if (self.last_applied_main !== pending.target_main) {
        throw new ObtsBlockedError("applied_main_acknowledgement_failed", "The legacy server did not acknowledge the applied main commit.");
      }
      await this.fsp.rm(this.pendingAppliedAckPath, { force: true });
      await this.clearAppliedPullCheckpoint(pending.target_main, currentState);
      return;
    }
    if (response.applied_main !== pending.target_main || response.applied_event_seq < pending.event_seq) {
      throw new ObtsBlockedError("applied_main_acknowledgement_failed", "The server did not durably acknowledge the applied main commit.");
    }
    await this.fsp.rm(this.pendingAppliedAckPath, { force: true });
    await this.clearAppliedPullCheckpoint(pending.target_main, currentState);
  }

  async settlePreviouslyAppliedPullCheckpoint() {
    const checkpoint = await readRecoveryJsonStrict(this.fsp, this.pullTransferPath, "invalid_transfer_checkpoint", "The saved pull checkpoint is unreadable. Preserve it for recovery.");
    if (!checkpoint || checkpoint.complete !== true) return;
    const state = await this.readState();
    if (!isCompletePullCheckpoint(checkpoint) || checkpoint.vault_id !== state.vault_id || checkpoint.device_id !== state.device_id) {
      throw new ObtsBlockedError("invalid_transfer_checkpoint", "Completed pull transfer checkpoint is invalid.");
    }
    if (checkpoint.target_main !== state.local_main || (state.last_applied_event_seq || 0) < checkpoint.manifest.event_seq) return;
    await this.validateCompleteTransferCheckpoint(checkpoint, checkpoint.current_local_main);
    // An already-applied snapshot can survive a lost cleanup write. Replay the
    // authenticated acknowledgement before retiring its validated checkpoint.
    await this.acknowledgeAppliedMain(checkpoint.target_main);
  }

  async clearAppliedPullCheckpoint(targetMain, state) {
    const checkpoint = await readJson(this.fsp, this.pullTransferPath, null);
    if (
      isCompletePullCheckpoint(checkpoint) &&
      checkpoint.vault_id === state.vault_id &&
      checkpoint.device_id === state.device_id &&
      checkpoint.target_main === targetMain
    ) {
      await this.fsp.rm(this.pullTransferPath, { force: true });
    }
  }

  async acknowledgeAppliedMain(targetMain) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) return;
    this.reportOperationProgress("Applying (acknowledging)", "apply_finalize");
    await this.writePendingAppliedAcknowledgement(targetMain, state.last_applied_event_seq || 0);
    await this.retryPendingAppliedAcknowledgement();
  }

  async ensureNoQueuedLocalChangesBeforeApply(state, target = null) {
    const flushedPaths = await this.flushEditorBuffersToDisk();
    if (Array.isArray(flushedPaths) && flushedPaths.some((filePath) =>
      !target || !target.policy.ignores(filePath))) this.plugin.syncQueued = true;
    const queue = await this.readQueue();
    if (
      (queue.pending_commit && queue.status !== "conflicted") ||
      (!target && this.plugin.syncQueued)
    ) {
      await this.deferApplyForLocalChanges(state);
      return false;
    }
    return true;
  }

  async ensureNoLocalChangesBeforeApply(state, target = null) {
    await this.flushEditorBuffersToDisk();
    const queue = await this.readQueue();
    if (queue.pending_commit && queue.status !== "conflicted") {
      await this.deferApplyForLocalChanges(state);
      return false;
    }
    return true;
  }

  async visibleVaultMatchesLocalHead(state, target = null) {
    const expectedLocalHead = state.local_head || state.local_main;
    const localFiles = await this.scanSyncableFiles(target?.policy || null);
    if (!expectedLocalHead) return localFiles.length === 0;
    if (!(await this.commitExists(expectedLocalHead))) return false;
    const matches = async (commit) => {
      if (!target) return this.localContentMatchesTree(localFiles, commit);
      const entries = new Map([...await this.listTreeBlobOids(commit)]
        .filter(([filePath]) => !target.policy.ignores(filePath) || target.entries.has(filePath)));
      if (localFiles.length !== entries.size) return false;
      const snapshot = await this.captureLocalFileSnapshot(localFiles, new Map(
        [...entries].map(([filePath, oid]) => [filePath, { oid }])
      ), { reportProgress: true });
      return [...entries].every(([filePath, oid]) => snapshot.entries.get(filePath)?.entry.oid === oid);
    };
    if (await matches(expectedLocalHead)) return true;
    return Boolean(state.local_main && state.local_main !== expectedLocalHead && await matches(state.local_main));
  }

  async clearResolvedConflictQueue() {
    const queue = await this.readQueue();
    if (queue.status !== "conflicted") {
      return;
    }
    await this.writeQueue({
      pending_commit: null,
      expected_device_ref: (await this.readState()).server_device_ref,
      status: "idle",
      attempts: 0,
      updated_at: nowIso()
    });
  }

  async settleAppliedQueue() {
    await this.mutateQueue(async () => {
      const [state, queue] = await Promise.all([this.readState(), this.readQueue()]);
      if (
        this.plugin.syncQueued ||
        queue.status !== "merged" ||
        queue.pending_commit ||
        !state.local_main ||
        state.local_head !== state.local_main
      ) return;
      await writeJson(this.fsp, this.queuePath, {
        pending_commit: null,
        expected_device_ref: state.server_device_ref,
        status: "idle",
        attempts: 0,
        change_seq: queue.change_seq,
        updated_at: nowIso()
      });
    });
  }

  async deferApplyForLocalChanges(state) {
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
    await this.writeState(Object.assign({}, await this.readState(), {
      status_label: queue.pending_commit ? "Ahead" : "Checking",
      last_error_code: null,
      updated_at: nowIso()
    }));
  }

  async flushEditorBuffersToDisk() {
    if (!this.plugin.flushOpenMarkdownEditorsToDisk) {
      return [];
    }
    return await this.plugin.flushOpenMarkdownEditorsToDisk();
  }

  async assertPairingCanStart() {
    if (!(await exists(this.fsp, this.obtsDir))) {
      return;
    }
    const existingState = await readJson(this.fsp, this.statePath, null);
    if (existingState && (existingState.vault_id || existingState.device_id)) {
      await this.block("local_state_already_paired", "Local .obts state already belongs to a paired device.");
    }
    if (await exists(this.fsp, this.authPath)) {
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
      (await exists(this.fsp, this.applyJournalPath)) ||
      (await exists(this.fsp, this.applyLockPath)) ||
      !(await exists(this.fsp, this.queuePath))
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

  // OBTS-PER-CLIENT-001: earlier clients could leave refs/heads/local on a
  // strict ancestor of an agreed local_head after applying a conflict
  // resolution. Fast-forward it only when no path changed between them still
  // shows the ref's bytes or absence; otherwise the commit CAS keeps sync
  // blocked with that evidence. local_head never follows the ref backwards.
  async repairRewoundLocalRef(state) {
    const head = state.local_head;
    if (!head || state.local_main !== head) return false;
    if ((await this.readQueue()).pending_commit) return false;
    if (await readApplyJournalStrict(this.fsp, this.applyJournalPath).catch(() => true)) return false;
    for (const owner of [this.catchupPath, this.uploadTransferPath, this.uploadRecoveryPath, this.pullTransferPath]) {
      if (await exists(this.fsp, owner)) return false;
    }
    if (await this.resolveRef("refs/heads/main") !== head) return false;
    const localRef = await this.resolveRef("refs/heads/local");
    if (!localRef || localRef === head || !(await this.isAncestor(localRef, head))) return false;
    const refEntries = await this.listTreeBlobOids(localRef);
    const headEntries = await this.listTreeBlobOids(head);
    const changedPaths = [...new Set([...refEntries.keys(), ...headEntries.keys()])]
      .filter((filePath) => refEntries.get(filePath) !== headEntries.get(filePath)).sort();
    for (const filePath of changedPaths) {
      let fingerprint;
      try {
        ({ fingerprint } = await this.readRecoveryFileSnapshot(filePath));
      } catch (error) {
        if (!(error instanceof LocalSnapshotChangedError)) throw error;
        this.plugin.syncQueued = true;
        throw new ObtsBlockedError("local_snapshot_changed", "Local files changed while obts was checking them. Sync will retry.");
      }
      if (this.fingerprintMatchesTarget(fingerprint, refEntries.get(filePath))) return false;
    }
    await this.updateRef("refs/heads/local", head, localRef);
    return true;
  }

  async reconcileQueueWithLocalHead(state) {
    const queue = await this.readQueue();
    if (queue.pending_commit || !state.local_head || !(await this.commitExists(state.local_head))) {
      return;
    }
    if (state.local_main && state.local_head === state.local_main) {
      return;
    }
    if (state.server_device_ref && state.local_head === state.server_device_ref) {
      return;
    }
    if (state.local_main && await this.isAncestor(state.local_head, state.local_main)) {
      await this.writeState(Object.assign({}, state, {
        local_head: state.local_main,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return;
    }
    if (queue.status !== "idle" || (queue.changed_paths || []).length > 0) {
      return;
    }
    const descendsFromDeviceRef = state.server_device_ref ? await this.isAncestor(state.server_device_ref, state.local_head) : false;
    const descendsFromLocalMain = state.local_main ? await this.isAncestor(state.local_main, state.local_head) : false;
    if (descendsFromDeviceRef || descendsFromLocalMain || (!state.server_device_ref && !state.local_main)) {
      const recoveredQueue = await this.updateQueue(async (current) => {
        if (current.pending_commit || current.status !== "idle" || (current.changed_paths || []).length > 0) {
          return current;
        }
        return Object.assign({}, current, {
          pending_commit: state.local_head,
          expected_device_ref: state.server_device_ref,
          status: "queued_local",
          attempts: 0,
          updated_at: nowIso()
        });
      });
      if (recoveredQueue.pending_commit !== state.local_head) {
        return;
      }
      await this.writeState(Object.assign({}, state, {
        status_label: "Ahead",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return;
    }
    await this.block("same_device_non_fast_forward", "Local Git history diverged from this device ref and requires recovery.");
  }

  async acquireApplyLock(applyId, validatedJournal = false) {
    await this.fsp.mkdir(path.dirname(this.applyLockPath), { recursive: true, mode: 0o700 });
    const owner = this.managedHeadlessOwner;
    const marker = owner
      ? { version: 2, domain: "obts-managed-linux-headless", generation: owner.generation, apply_id: applyId }
      : { apply_id: applyId, created_at: nowIso() };
    try {
      if (owner) {
        await owner.publishApplyMarker(JSON.stringify(marker, null, 2));
      } else {
        await this.fsp.writeFile(this.applyLockPath, JSON.stringify(marker, null, 2), { flag: "wx", mode: 0o600 });
      }
      this.applyLockOwner = { applyId, generation: owner?.generation ?? null };
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    if (owner || validatedJournal) {
      let existing;
      try {
        const details = await this.fsp.lstat(this.applyLockPath);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe apply lock");
        existing = JSON.parse(await this.fsp.readFile(this.applyLockPath, "utf8"));
      } catch {
        await this.block("apply_lock_active", "Another apply operation already holds the local vault lock.");
      }
      const matchingLegacyJournal = validatedJournal && isLegacyApplyLockMarker(existing, applyId);
      if (matchingLegacyJournal || (owner && owner.canReclaim(existing) && isApplyId(existing.apply_id))) {
        const details = await this.fsp.lstat(this.applyLockPath);
        const current = JSON.parse(await this.fsp.readFile(this.applyLockPath, "utf8"));
        const beforeRemoval = await this.fsp.lstat(this.applyLockPath);
        const stillOwned = Boolean(owner && owner.canReclaim(current) && current.generation === existing.generation &&
          current.apply_id === existing.apply_id);
        const stillMatchesJournal = validatedJournal && isLegacyApplyLockMarker(current, applyId);
        if (details.isFile() && !details.isSymbolicLink() && details.dev === beforeRemoval.dev &&
            details.ino === beforeRemoval.ino && (stillOwned || stillMatchesJournal)) {
          await this.fsp.rm(this.applyLockPath);
          return await this.acquireApplyLock(applyId);
        }
      }
    }
    await this.block("apply_lock_active", "Another apply operation already holds the local vault lock.");
  }

  async releaseApplyLock(applyId = null) {
    const owner = this.applyLockOwner;
    if (!owner || (applyId !== null && owner.applyId !== applyId)) return false;
    let details;
    let marker;
    try {
      details = await this.fsp.lstat(this.applyLockPath);
      marker = JSON.parse(await this.fsp.readFile(this.applyLockPath, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.applyLockOwner = null;
        return false;
      }
      throw error;
    }
    const matches = details.isFile() && !details.isSymbolicLink() &&
      (owner.generation === null
        ? isLegacyApplyLockMarker(marker, owner.applyId)
        : isManagedApplyLockMarker(marker, owner.applyId, owner.generation));
    if (!matches) return false;
    const beforeRemoval = await this.fsp.lstat(this.applyLockPath);
    const current = JSON.parse(await this.fsp.readFile(this.applyLockPath, "utf8"));
    const afterRead = await this.fsp.lstat(this.applyLockPath);
    const markerStillOwned = owner.generation === null
      ? isLegacyApplyLockMarker(current, owner.applyId)
      : isManagedApplyLockMarker(current, owner.applyId, owner.generation);
    if (details.dev !== beforeRemoval.dev || details.ino !== beforeRemoval.ino ||
        beforeRemoval.dev !== afterRead.dev || beforeRemoval.ino !== afterRead.ino ||
        JSON.stringify(current) !== JSON.stringify(marker) || !markerStillOwned) return false;
    await this.fsp.rm(this.applyLockPath);
    this.applyLockOwner = null;
    return true;
  }

  async clearApplyState() {
    const journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    await this.finishApplyProvenance(journal);
    let catchup = null;
    try { catchup = await this.readDurableCatchup(); } catch { catchup = null; }
    if (catchup) await writeJson(this.fsp, this.catchupPath, Object.assign({}, catchup, { local_head: await this.resolveRef("refs/heads/local") }));
    if (journal && isApplyId(journal.apply_id)) {
      const displacedRoot = path.join(this.obtsDir, "apply-displaced", journal.apply_id);
      if (await this.adapterExists(displacedRoot)) {
        const archiveRoot = path.join(this.obtsDir, "recovery-displaced", journal.apply_id);
        await this.fsp.mkdir(path.dirname(archiveRoot), { recursive: true, mode: 0o700 });
        if (await this.adapterExists(archiveRoot)) {
          throw new ObtsBlockedError("displaced_recovery_archive_exists", "Displaced recovery evidence already exists for this apply operation.");
        }
        // Copies from in-place writes and evidence from legacy removals share
        // the same archive lifecycle; neither may be discarded on completion.
        await this.fsp.rename(displacedRoot, archiveRoot);
      }
    }
    await this.fsp.rm(this.applyJournalPath, { force: true });
    await this.releaseApplyLock(journal?.apply_id ?? null);
    if (catchup) {
      // A surviving catch-up obligation means the applied snapshot is not yet
      // canonical; never leave a transient success/progress label in place while
      // it is pending. Cursor-regression guarding can preserve the pre-apply
      // label, so rewrite any of those transient labels to Behind.
      const state = await this.readState();
      if (["Synced", "Applying", "Checking", "Uploading", "Merging"].includes(state.status_label)) {
        await this.writeState(Object.assign({}, state, { status_label: "Behind", updated_at: nowIso() }));
      }
    }
  }

  async recoverInterruptedRefLocks() {
    for (const ref of ["refs/heads/main", "refs/heads/local"]) {
      await this.recoverLegacyRefLock(ref);
      await this.recoverOwnedRefLease(ref);
    }
  }

  async validateRecoverableRefTarget(ref, target) {
    if (!/^[0-9a-f]{40}$/u.test(target) || !(await this.commitExists(target))) {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lock does not reference a valid commit.");
    }
    const current = await this.resolveRefPointer(ref);
    if (!current) {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lock has no safe current ref baseline.");
    }
    if (current !== target && !(await this.isAncestor(current, target))) {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lock diverges from the current ref.");
    }
  }

  async recoverLegacyRefLock(ref) {
    const lockPath = `${path.join(this.gitdir, ref)}.lock`;
    let lockStat;
    try {
      lockStat = await this.fsp.stat(lockPath);
    } catch (error) {
      if (error && error.code === "ENOENT") return "absent";
      throw new ObtsBlockedError("local_ref_recovery_required", "A local Git ref lock could not be inspected safely.");
    }
    const modifiedAt = Number(lockStat.mtimeMs);
    if (!Number.isFinite(modifiedAt) || modifiedAt <= 0) {
      throw new ObtsBlockedError("local_ref_recovery_required", "A local Git ref lock has no trustworthy age.");
    }
    if (Date.now() - modifiedAt < REF_LOCK_STALE_MS) return "active";
    let target;
    try {
      target = String(await this.fsp.readFile(lockPath, "utf8")).trim();
    } catch {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lock could not be read safely.");
    }
    await this.validateRecoverableRefTarget(ref, target);
    await this.fsp.rm(lockPath, { force: true });
    return "recovered";
  }

  async recoverOwnedRefLease(ref) {
    const refPath = path.join(this.gitdir, ref);
    const leasePath = `${refPath}.obts-lock`;
    let leaseStat;
    try {
      leaseStat = await this.fsp.stat(leasePath);
    } catch (error) {
      if (error && error.code === "ENOENT") return "absent";
      throw new ObtsBlockedError("local_ref_recovery_required", "A local Git ref lease could not be inspected safely.");
    }
    const modifiedAt = Number(leaseStat.mtimeMs);
    if (!Number.isFinite(modifiedAt) || modifiedAt <= 0) {
      throw new ObtsBlockedError("local_ref_recovery_required", "A local Git ref lease has no trustworthy age.");
    }
    if (Date.now() - modifiedAt < REF_LOCK_STALE_MS) return "active";
    let lease;
    try {
      lease = JSON.parse(await this.fsp.readFile(leasePath, "utf8"));
    } catch {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lease is invalid.");
    }
    if (!lease || !/^[0-9a-f]{16}$/u.test(lease.nonce || "") || typeof lease.target !== "string") {
      throw new ObtsBlockedError("local_ref_recovery_required", "A stale local Git ref lease is invalid.");
    }
    await this.validateRecoverableRefTarget(ref, lease.target);
    await this.fsp.rm(leasePath, { force: true });
    await this.fsp.rm(`${refPath}.obts-stage-${lease.nonce}`, { force: true }).catch(() => undefined);
    return "recovered";
  }

  async assertRefLeaseOwner(leasePath, nonce) {
    let lease;
    try {
      lease = JSON.parse(await this.fsp.readFile(leasePath, "utf8"));
    } catch {
      throw new ObtsBlockedError("local_ref_lease_lost", "A local Git ref update lost its ownership lease.");
    }
    if (!lease || lease.nonce !== nonce) {
      throw new ObtsBlockedError("local_ref_lease_lost", "A local Git ref update lost its ownership lease.");
    }
  }

  async releaseRefLease(leasePath, nonce) {
    try {
      const lease = JSON.parse(await this.fsp.readFile(leasePath, "utf8"));
      if (lease && lease.nonce === nonce) await this.fsp.rm(leasePath, { force: true });
    } catch {
      // A replacement owner or recovery path is responsible for its own lease.
    }
  }

  async updateRef(ref, target, expected, force = false, recoveredLease = false) {
    const refPath = path.join(this.gitdir, ref);
    const legacy = await this.recoverLegacyRefLock(ref);
    if (legacy === "active") {
      throw new ObtsBlockedError("local_ref_lock_active", "A legacy local Git ref update is still active or was interrupted recently.");
    }
    const nonce = randomHex(8);
    const leasePath = `${refPath}.obts-lock`;
    const stagePath = `${refPath}.obts-stage-${nonce}`;
    await this.fsp.mkdir(path.dirname(refPath), { recursive: true });
    try {
      await this.fsp.writeFile(leasePath, `${JSON.stringify({ nonce, target, created_at: nowIso() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!recoveredLease && error && error.code === "EEXIST" && await this.recoverOwnedRefLease(ref) === "recovered") {
        return await this.updateRef(ref, target, expected, force, true);
      }
      if (error && error.code === "EEXIST") {
        throw new ObtsBlockedError("local_ref_lock_active", "A local Git ref update is still active or was interrupted recently.");
      }
      throw error;
    }
    try {
      await this.fsp.writeFile(stagePath, `${target}\n`, { flag: "wx", mode: 0o600 });
      await this.assertRefLeaseOwner(leasePath, nonce);
      if (!force && expected) {
        const current = await this.resolveRef(ref);
        if (current !== expected) {
          throw new ObtsBlockedError("local_ref_changed", `Local Git ref ${ref} changed while it was being updated.`,
            { ref, expected, actual: current });
        }
      }
      await this.assertRefLeaseOwner(leasePath, nonce);
      await this.fsp.rename(stagePath, refPath);
    } finally {
      await this.fsp.rm(stagePath, { force: true }).catch(() => undefined);
      await this.releaseRefLease(leasePath, nonce);
    }
  }

  async resolveRef(ref) {
    try {
      const oid = await this.resolveRefPointer(ref);
      if (!oid) return null;
      await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid });
      return oid;
    } catch {
      return null;
    }
  }

  async resolveRefPointer(ref) {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  async commitExists(commit) {
    try {
      await git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: commit });
      return true;
    } catch {
      return false;
    }
  }

  async sameCommitTree(first, second) {
    if (first === second) return true;
    try {
      const [firstCommit, secondCommit] = await Promise.all([
        git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: first }),
        git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: second })
      ]);
      return firstCommit.commit.tree === secondCommit.commit.tree;
    } catch {
      return false;
    }
  }

  async isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    try {
      return await git.isDescendent({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: descendant, ancestor, depth: -1 });
    } catch {
      return false;
    }
  }

  async readState() {
    let state;
    try {
      state = JSON.parse(await this.fsp.readFile(this.statePath, "utf8"));
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid client state");
    } catch {
      if (await exists(this.fsp, this.authPath)) {
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
        last_applied_event_seq: 0,
        unpaired_baseline_vault_id: null,
        unpaired_baseline_main: null,
        updated_at: nowIso()
      };
    }
    if (await this.hasActiveTokenWithoutIdentity(state)) {
      return this.normalizeStateEventCursors(await this.readBackupState() || this.localStateIncomplete(state));
    }
    return this.normalizeStateEventCursors(await this.preferRecoverableBackupState(state));
  }

  normalizeStateEventCursors(state) {
    return Object.assign({}, state, {
      status_label: normalizePersistedStatusLabel(state && state.status_label, state && state.last_error_code, state && state.last_error_details),
      last_event_seq: Number.isSafeInteger(state && state.last_event_seq) && state.last_event_seq >= 0 ? state.last_event_seq : 0,
      last_applied_event_seq: Number.isSafeInteger(state && state.last_applied_event_seq) && state.last_applied_event_seq >= 0
        ? state.last_applied_event_seq
        : 0
    });
  }

  async writeState(state) {
    const guardedState = await this.guardStateCursorRegression(this.normalizeStateEventCursors(state));
    await this.backupExistingState();
    await writeJson(this.fsp, this.statePath, guardedState);
  }

  async guardStateCursorRegression(nextState) {
    const currentState = await this.readPrimaryState();
    if (!currentState || !samePairedDeviceState(currentState, nextState)) {
      this.lastCursorGuardDiagnostic = "no_preservation";
      return nextState;
    }
    const guardedState = Object.assign({}, nextState);
    const preserved = new Set();
    let cursorRegressed = false;
    if (await this.shouldPreserveCurrentCursor(nextState.local_main, currentState.local_main)) {
      guardedState.local_main = currentState.local_main;
      preserved.add("local_main");
      cursorRegressed = true;
    }
    if (await this.shouldPreserveCurrentCursor(nextState.local_head, currentState.local_head)) {
      guardedState.local_head = currentState.local_head;
      preserved.add("local_head");
      cursorRegressed = true;
    }
    if (await this.shouldPreserveCurrentCursor(nextState.server_device_ref, currentState.server_device_ref)) {
      guardedState.server_device_ref = currentState.server_device_ref;
      preserved.add("server_ref");
      cursorRegressed = true;
    }
    if (currentState.initial_import_confirmed && !guardedState.initial_import_confirmed) {
      guardedState.initial_import_confirmed = true;
    }
    if (currentState.last_event_seq > guardedState.last_event_seq) {
      guardedState.last_event_seq = currentState.last_event_seq;
      preserved.add("event_cursor");
    }
    if (
      guardedState.local_main === currentState.local_main &&
      (currentState.last_applied_event_seq || 0) > guardedState.last_applied_event_seq
    ) {
      guardedState.last_applied_event_seq = currentState.last_applied_event_seq;
      preserved.add("event_cursor");
    }
    this.lastCursorGuardDiagnostic = preserved.size === 0
      ? "no_preservation"
      : preserved.size === 1
        ? [...preserved][0]
        : "multiple";
    if (this.activeReconciliation) {
      this.activeReconciliation.cursorGuard = combineTroubleshootingCursorGuards(
        this.activeReconciliation.cursorGuard,
        this.lastCursorGuardDiagnostic
      );
    }
    if (cursorRegressed) {
      guardedState.status_label = currentState.status_label;
      guardedState.last_error_code = currentState.last_error_code;
      guardedState.last_error_details = currentState.last_error_details || null;
    }
    return guardedState;
  }

  async preferRecoverableBackupState(primaryState) {
    const backupState = await this.readBackupState();
    if (!backupState || !samePairedDeviceState(primaryState, backupState)) {
      return primaryState;
    }
    if (sameStateCursors(primaryState, backupState)) return primaryState;
    const [localMain, localHead] = await Promise.all([
      this.resolveRefPointer("refs/heads/main"),
      this.resolveRefPointer("refs/heads/local")
    ]);
    const primaryMatchesRefs = primaryState.local_main === localMain && primaryState.local_head === localHead;
    const backupMatchesRefs = backupState.local_main === localMain && backupState.local_head === localHead;
    const comparableLocalCursors = Boolean(
      primaryState.local_main && primaryState.local_head && backupState.local_main && backupState.local_head
    );
    if (comparableLocalCursors && primaryMatchesRefs !== backupMatchesRefs) {
      if (backupMatchesRefs && await this.commitExists(localMain) && await this.commitExists(localHead)) {
        return await this.restoreRecoveredBackupState(primaryState, backupState);
      }
      return primaryState;
    }
    // A proposal's immutable CAS baseline can lag an authenticated server
    // observation. It cannot decide which state generation is current.
    this.plugin.setInitializationStage("Validating local state history", "startup_state");
    if (await this.backupStateCursorsDescend(primaryState, backupState)) {
      return await this.restoreRecoveredBackupState(primaryState, backupState);
    }
    return primaryState;
  }

  async restoreRecoveredBackupState(primaryState, backupState) {
    const backupServerIsNewer = await this.cursorDescends(primaryState.server_device_ref, backupState.server_device_ref);
    const recoverMissingServerRef = !primaryState.server_device_ref && backupState.server_device_ref &&
      await this.commitExists(backupState.server_device_ref);
    const recovered = Object.assign({}, primaryState, {
      local_main: backupState.local_main,
      local_head: backupState.local_head,
      device_name: primaryState.device_name || backupState.device_name || null,
      server_device_ref: backupServerIsNewer || recoverMissingServerRef
        ? backupState.server_device_ref
        : primaryState.server_device_ref,
      initial_import_confirmed: Boolean(primaryState.initial_import_confirmed || backupState.initial_import_confirmed),
      last_event_seq: Math.max(primaryState.last_event_seq || 0, backupState.last_event_seq || 0),
      last_applied_event_seq: primaryState.local_main === backupState.local_main
        ? Math.max(primaryState.last_applied_event_seq || 0, backupState.last_applied_event_seq || 0)
        : backupState.last_applied_event_seq || 0,
      updated_at: nowIso()
    });
    // Local-ref repair does not clear or resurrect an unrelated server block.
    // A fully newer backup may retire a stale local-only error without an apply journal.
    if (backupServerIsNewer && ["unsafe_local_state", "local_state_incomplete"].includes(primaryState.last_error_code) &&
      !backupState.last_error_code && !(await exists(this.fsp, this.applyJournalPath))) {
      recovered.status_label = backupState.status_label;
      recovered.last_error_code = null;
      recovered.last_error_details = null;
    }
    await writeJson(this.fsp, this.statePath, recovered);
    return recovered;
  }

  async backupStateCursorsDescend(primaryState, backupState) {
    let advanced = false;
    for (const field of ["local_main", "local_head"]) {
      if (primaryState[field] === backupState[field]) continue;
      if (!(await this.cursorDescends(primaryState[field], backupState[field]))) return false;
      advanced = true;
    }
    return advanced || await this.cursorDescends(primaryState.server_device_ref, backupState.server_device_ref);
  }

  async shouldPreserveCurrentCursor(nextCursor, currentCursor) {
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

  async cursorDescends(olderCursor, newerCursor) {
    if (!olderCursor || !newerCursor || olderCursor === newerCursor) {
      return false;
    }
    if (!(await this.commitExists(olderCursor)) || !(await this.commitExists(newerCursor))) {
      return false;
    }
    return await this.isAncestor(olderCursor, newerCursor);
  }

  async readPrimaryState() {
    try {
      return JSON.parse(await this.fsp.readFile(this.statePath, "utf8"));
    } catch {
      return null;
    }
  }

  async repairLocalStateIfNeeded(state) {
    // Enrollment owns partial credential publication; generic repair must not
    // download or manufacture refs before its completion receipt is recovered.
    try { if (await this.readPendingOnboarding()) return state; }
    catch (error) {
      if (error?.code !== "onboarding_context_required") throw error;
      return Object.assign({}, state, { status_label: "Needs recovery", last_error_code: "onboarding_context_required" });
    }
    if (state.last_error_code !== "local_state_incomplete") {
      return state;
    }
    this.plugin.setInitializationStage("Repairing incomplete local state", "startup_state");
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
        status_label: self.status === "review_needed" ? "Review needed" : self.status === "blocked_recovery" ? "Needs recovery" : "Checking",
        last_error_code: self.status === "review_needed" ? "conflict_review_required" : self.status === "blocked_recovery" ? "server_recovery_required" : null,
        last_event_seq: self.event_seq,
        last_applied_event_seq: self.last_applied_event_seq || 0,
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
      const pulled = await this.pull(vaultId, deviceId, token, localMain, "latest", 0);
      await this.importPack(pulled.packfile);
    } catch {
      // Metadata repair can continue without fresh main objects; sync will retry and block safely if needed.
    }
  }

  async backupExistingState() {
    try {
      const state = JSON.parse(await this.fsp.readFile(this.statePath, "utf8"));
      if (state.vault_id && state.device_id) {
        await this.fsp.copyFile(this.statePath, `${this.statePath}.bak`);
      }
    } catch {
      // Keep any existing backup when the primary state file is unreadable.
    }
  }

  async readBackupState() {
    try {
      const state = JSON.parse(await this.fsp.readFile(`${this.statePath}.bak`, "utf8"));
      if (state.vault_id && state.device_id) {
        return state;
      }
    } catch {
      return null;
    }
    return null;
  }

  async hasActiveTokenWithoutIdentity(state) {
    return Boolean((!state.vault_id || !state.device_id) && await exists(this.fsp, this.authPath));
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
      last_applied_event_seq: state && state.last_applied_event_seq || 0,
      unpaired_baseline_vault_id: state && state.unpaired_baseline_vault_id || null,
      unpaired_baseline_main: state && state.unpaired_baseline_main || null,
      updated_at: nowIso()
    };
  }

  async readQueue() {
    const queue = await readJson(this.fsp, this.queuePath, {
      pending_commit: null,
      expected_device_ref: null,
      status: "idle",
      attempts: 0,
      change_seq: 0,
      updated_at: nowIso()
    });
    return Object.assign({}, queue, {
      change_seq: Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0 ? queue.change_seq : 0,
      changed_paths: Array.from(new Set((Array.isArray(queue.changed_paths) ? queue.changed_paths : [])
        .filter((filePath) => typeof filePath === "string" && isSyncableVaultPath(filePath))
        .map((filePath) => normalizePath(filePath)))).sort()
    });
  }

  normalizedQueueForWrite(queue, existing = null) {
    const preserveChangedPaths = queue.pending_commit === null && queue.status === "queued_local";
    const changedPaths = Array.from(new Set((Array.isArray(queue.changed_paths)
      ? queue.changed_paths
      : preserveChangedPaths && Array.isArray(existing && existing.changed_paths)
        ? existing.changed_paths
        : [])
      .filter((filePath) => typeof filePath === "string" && isSyncableVaultPath(filePath))
      .map((filePath) => normalizePath(filePath)))).sort();
    const normalized = Object.assign({}, queue, {
      pending_proposal_base: queue.pending_commit
        ? (queue.pending_proposal_base || (existing?.pending_commit === queue.pending_commit ? existing.pending_proposal_base : null) || null)
        : null,
      ...(queue.pending_commit && !Object.hasOwn(queue, "pending_upload_base") && existing?.pending_commit === queue.pending_commit && Object.hasOwn(existing, "pending_upload_base")
        ? { pending_upload_base: existing.pending_upload_base } : {}),
      change_seq: Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0
        ? queue.change_seq
        : Number.isSafeInteger(existing && existing.change_seq) && existing.change_seq >= 0
          ? existing.change_seq
          : 0,
      changed_paths: changedPaths
    });
    if (!queue.pending_commit) delete normalized.pending_upload_base;
    return normalized;
  }

  async writeQueue(queue) {
    await this.mutateQueue(async () => {
      const existing = await this.readQueue();
      const normalized = this.normalizedQueueForWrite(queue, existing);
      if (normalized.pending_commit !== existing.pending_commit) await this.preserveUploadCheckpointHandoff(existing, normalized);
      await writeJson(this.fsp, this.queuePath, normalized);
    });
  }

  async updateQueue(mutator) {
    return await this.mutateQueue(async () => {
      const existing = await this.readQueue();
      const next = await mutator(existing);
      if (!next) return existing;
      const normalized = this.normalizedQueueForWrite(next, existing);
      if (normalized.pending_commit !== existing.pending_commit) await this.preserveUploadCheckpointHandoff(existing, normalized);
      await writeJson(this.fsp, this.queuePath, normalized);
      return normalized;
    });
  }

  async preserveUploadCheckpointHandoff(previousQueue, successorQueue) {
    const checkpoint = await this.readUploadCheckpoint();
    const existing = await this.readUploadRecovery();
    if (!checkpoint && !existing) return;
    // A pending legacy directory journal validates and retires its own
    // checkpoint; do not intercept its queue transitions.
    if (!existing && await exists(this.fsp, this.directoryBaselineRecoveryPath)) return;
    const queueEvidence = await readRecoveryJsonStrict(this.fsp, this.queuePath, "upload_checkpoint_recovery_required", "The queue is unreadable; preserve recovery evidence.");
    if (!isUploadRecoveryQueue(queueEvidence) || queueEvidence.pending_commit !== previousQueue.pending_commit) throw this.uploadRecoveryError("The saved queue identity is invalid.");
    const state = await this.readState();
    // A caller may already have moved its local ref. Pin that candidate before
    // either publishing the handoff or refusing a second, unresolved handoff.
    await this.protectUploadRecoveryCommits([successorQueue.pending_commit, successorQueue.pending_proposal_base]);
    if (existing) {
      if (existing.successor_commit === successorQueue.pending_commit) return;
      throw this.uploadRecoveryError("Finish the saved handoff before replacing another queued proposal.");
    }
    await this.publishUploadHandoff(checkpoint, previousQueue, successorQueue, state);
  }

  uploadRecoveryError(message) {
    return new ObtsBlockedError("upload_checkpoint_recovery_required",
      `${message} Run Recover upload checkpoint to retry. If it still fails, preserve the vault and .obts files and send a troubleshooting snapshot for assisted recovery; do not reset sync.`);
  }

  async readUploadCheckpoint(filePath = this.uploadTransferPath) {
    let bytes;
    try { bytes = Buffer.from(await this.fsp.readFile(filePath)); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw this.uploadRecoveryError("The upload checkpoint is unreadable.");
    }
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw).equals(bytes)) throw this.uploadRecoveryError("The upload checkpoint is not valid UTF-8.");
    let checkpoint;
    try { checkpoint = JSON.parse(raw); } catch { throw this.uploadRecoveryError("The upload checkpoint is not valid JSON."); }
    if (!isUploadTransferCheckpoint(checkpoint)) throw this.uploadRecoveryError("The saved upload identity is invalid.");
    return checkpoint;
  }

  async readUploadRecovery() {
    const journal = await readRecoveryJsonStrict(this.fsp, this.uploadRecoveryPath,
      "upload_checkpoint_recovery_required", "The upload recovery journal is unreadable. Preserve the vault and .obts files and send a troubleshooting snapshot; do not reset sync.");
    if (!journal) return null;
    const state = await this.readState();
    if (!isUploadCheckpointHandoff(journal) || journal.vault_id !== state.vault_id || journal.device_id !== state.device_id) {
      throw this.uploadRecoveryError("The upload recovery journal identity or checksum is invalid.");
    }
    return journal;
  }

  async writeUploadRecovery(journal) {
    const sealed = Object.assign({}, journal);
    delete sealed.journal_sha256;
    sealed.journal_sha256 = sha256(Buffer.from(stableJson(sealed)));
    if (!isUploadCheckpointHandoff(sealed)) throw this.uploadRecoveryError("The handoff cannot be bound to its original proposal.");
    await writeJson(this.fsp, this.uploadRecoveryPath, sealed);
    return sealed;
  }

  async protectUploadRecoveryCommits(commits) {
    for (const commit of new Set(commits.filter(Boolean))) {
      if (!isGitObjectId(commit)) throw this.uploadRecoveryError("A recovery commit identity is invalid.");
      // Verify the full commit/tree/blob closure, not just the commit header.
      const objects = await this.collectIncrementalPackObjects(commit, []).catch(() => null);
      if (!objects) throw this.uploadRecoveryError("A recovery commit's history is unavailable.");
      for (const oid of objects) {
        try { await git.readObject({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid, format: "content" }); }
        catch { throw this.uploadRecoveryError("A recovery Git object is unavailable."); }
      }
      const ref = `refs/obts/upload-recovery/${commit}`;
      await this.updateRef(ref, commit, await this.resolveRef(ref));
    }
  }

  async publishUploadHandoff(checkpoint, previousQueue, successorQueue, state) {
    const bytes = Buffer.from(await this.fsp.readFile(this.uploadTransferPath));
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw).equals(bytes)) throw this.uploadRecoveryError("The checkpoint became unreadable during publication.");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw this.uploadRecoveryError("The checkpoint became unreadable during publication."); }
    if (stableJson(parsed) !== stableJson(checkpoint) ||
        checkpoint.transfer_request.vault_id !== state.vault_id || checkpoint.transfer_request.device_id !== state.device_id ||
        !isUploadRecoveryQueue(previousQueue) || !isUploadRecoveryQueue(successorQueue)) {
      throw this.uploadRecoveryError("The checkpoint and local identity do not agree.");
    }
    const request = checkpoint.transfer_request;
    const originalBase = request.base_commit || null;
    const successor = Object.assign({}, successorQueue, {
      ...(successorQueue.pending_commit && successorQueue.pending_commit !== checkpoint.target_commit
        ? { pending_upload_base: this.proposalBase(successorQueue, state) } : {}),
      changed_paths: [...new Set([...(previousQueue.changed_paths || []), ...(successorQueue.changed_paths || [])])].sort(),
      change_seq: Math.max(previousQueue.change_seq || 0, successorQueue.change_seq || 0)
    });
    const oldQueue = Object.assign({}, previousQueue, {
      pending_commit: checkpoint.target_commit, expected_device_ref: request.expected_device_ref,
      pending_proposal_base: previousQueue.pending_commit === checkpoint.target_commit && previousQueue.pending_proposal_base === originalBase ? originalBase : null,
      pending_upload_base: originalBase, status: "queued_local"
    });
    await this.protectUploadRecoveryCommits([checkpoint.target_commit, originalBase, request.expected_device_ref,
      request.client_known_main, previousQueue.pending_commit, previousQueue.pending_proposal_base,
      successor.pending_commit, successor.expected_device_ref, successor.pending_proposal_base, successor.pending_upload_base,
      checkpoint.directory_proposal?.base_main, ...(checkpoint.directory_proposal?.intents || []).map((intent) => intent.base_main)]);
    return await this.writeUploadRecovery({
      version: 1, vault_id: state.vault_id, device_id: state.device_id,
      old_commit: checkpoint.target_commit, original_base: originalBase, old_queue: oldQueue,
      checkpoint, checkpoint_raw: raw, checkpoint_sha256: sha256(Buffer.from(raw)),
      successor_commit: successor.pending_commit, successor_queue: successor,
      phase: "prepared", result: null
    });
  }

  async updateQueuedCommit(expectedCommit, mutator) {
    return await this.updateQueue(async (current) => {
      if (current.pending_commit !== expectedCommit) {
        throw new ObtsBlockedError("local_queue_changed", "The local upload queue changed during an active proposal.");
      }
      return await mutator(current);
    });
  }

  async clearQueuedHintIfUnchanged(expectedChangeSeq) {
    return await this.mutateQueue(async () => {
      const queue = await this.readQueue();
      if (
        queue.pending_commit !== null ||
        queue.status !== "queued_local" ||
        queue.change_seq !== expectedChangeSeq
      ) {
        return false;
      }
      await writeJson(this.fsp, this.queuePath, {
        pending_commit: null,
        expected_device_ref: (await this.readState()).server_device_ref,
        status: "idle",
        attempts: 0,
        change_seq: queue.change_seq,
        changed_paths: [],
        updated_at: nowIso()
      });
      return true;
    });
  }

  async mutateQueue(fn) {
    const run = this.queueMutation.then(fn, fn);
    this.queueMutation = run.then(() => undefined, () => undefined);
    return await run;
  }

  async cancelLegacyDirectoryTransfer(state, original, token) {
    const response = await fetchWithTimeout(
      this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${original.rejected_transfer_id}`),
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (response.status !== 404 && response.status !== 410) {
      if (!response.ok) await throwResponseError(response);
      const descriptor = await response.json();
      if (descriptor.transfer_id !== original.rejected_transfer_id ||
        descriptor.target_commit !== original.pending_commit ||
        !["open", "rejected", "aborted"].includes(descriptor.status)) {
        throw new ObtsBlockedError("legacy_directory_advance_unsafe", "The rejected transfer is processing, accepted, or mismatched; preserve its evidence for assisted recovery.");
      }
      const cancelled = await fetchWithTimeout(
        this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${original.rejected_transfer_id}`),
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
      );
      if (cancelled.status !== 204 && cancelled.status !== 404 && cancelled.status !== 410) {
        if (!cancelled.ok) await throwResponseError(cancelled);
        throw new ObtsBlockedError("legacy_directory_advance_unsafe", "The obsolete transfer could not be cancelled safely.");
      }
    }
    const current = await this.getDeviceSelf(token);
    if (current.server_device_ref !== original.server_device_ref) {
      throw new ObtsBlockedError("legacy_directory_advance_unsafe", "The device ref changed during legacy transfer settlement; preserve the evidence for assisted recovery.");
    }
  }

  async settleCompletedLegacyDirectoryAdvance() {
    const journal = await readRecoveryJsonStrict(
      this.fsp, this.directoryBaselineRecoveryPath,
      "directory_baseline_recovery_journal_invalid", "The directory baseline recovery journal is malformed."
    );
    if (!journal || !["main_advanced", "legacy_retirement_authorized"].includes(journal.phase)) return false;
    const fail = () => { throw new ObtsBlockedError(
      "legacy_directory_advance_unsafe",
      "The completed legacy directory advance cannot be verified. Preserve the journal, checkpoints, queue, and recovery archive for assisted recovery."
    ); };
    if (await exists(this.fsp, this.applyJournalPath)) fail();
    if (!Platform?.isMobile && (typeof this.adapter.syncFile !== "function" ||
      typeof this.adapter.syncDirectory !== "function")) fail();
    const state = await this.readState();
    if (![null, "stale_directory_proposal_base"].includes(state.last_error_code) || state.apply_validation_reason) fail();
    const queue = await this.readQueue();
    const directoryState = await this.readDirectoryState();
    const upload = await readRecoveryJsonStrict(this.fsp, this.uploadTransferPath,
      "legacy_directory_advance_unsafe", "The legacy upload checkpoint is unreadable.");
    const pull = await readRecoveryJsonStrict(this.fsp, this.pullTransferPath,
      "legacy_directory_advance_unsafe", "The legacy pull checkpoint is unreadable.");
    const authorized = journal.phase === "legacy_retirement_authorized";
    const archiveId = sha256(Buffer.from(stableJson([
      journal.vault_id, journal.device_id, journal.pending_commit, journal.target_main, journal.rejected_checkpoint_identity
    ])));
    const archivePath = path.join(this.obtsDir, "recovery", `legacy-baseline-${archiveId}.json`);
    const archive = await readRecoveryJsonStrict(this.fsp, archivePath,
      "legacy_directory_advance_unsafe", "The legacy recovery archive is unreadable.");
    if (authorized && (!archive || archive.digest !== journal.legacy_archive_digest ||
      archive.digest !== sha256(Buffer.from(stableJson(archive.evidence))) ||
      archive.evidence?.journal?.phase !== "main_advanced" ||
      !Array.isArray(archive.evidence?.queue?.changed_paths))) fail();
    if (!authorized && archive && (archive.digest !== sha256(Buffer.from(stableJson(archive.evidence))) ||
      stableJson(archive.evidence?.journal) !== stableJson(journal) ||
      !archive.evidence?.state || !archive.evidence?.queue || !archive.evidence?.directoryState ||
      !legacySettlementStateAgrees(archive.evidence.state, state) ||
      !legacySettlementQueueAgrees(archive.evidence.queue, queue) ||
      !legacySettlementDirectoryAgrees(archive.evidence.directoryState, directoryState) ||
      stableJson(archive.evidence.upload) !== stableJson(upload) ||
      stableJson(archive.evidence.pull) !== stableJson(pull))) fail();
    const original = authorized ? archive.evidence.journal : journal;
    const oldUpload = authorized ? archive.evidence.upload : upload;
    const oldPull = authorized ? archive.evidence.pull : pull;
    const originalIntent = original.original_pending_intents;
    const originalExplicitDirectories = Array.isArray(original.target_explicit_directories)
      ? original.target_explicit_directories
      : original.advanced_explicit_directories;
    if (original.version !== 1 || original.phase !== "main_advanced" ||
      original.vault_id !== state.vault_id || original.device_id !== state.device_id ||
      !isGitObjectId(original.local_main) || !isGitObjectId(original.pending_commit) ||
      !isGitObjectId(original.target_main) || original.local_head !== original.pending_commit ||
      !Number.isSafeInteger(original.last_event_seq) ||
      original.last_event_seq !== original.last_applied_event_seq ||
      !Number.isSafeInteger(original.recovered_event_seq) ||
      original.recovered_event_seq <= original.last_event_seq ||
      original.server_device_ref !== original.recovered_server_device_ref ||
      original.server_device_ref !== state.server_device_ref ||
      !isGitObjectId(original.server_device_ref) ||
      !Array.isArray(originalIntent) || originalIntent.length !== 1 ||
      !isStoredDirectoryIntent(originalIntent[0]) || originalIntent[0].op !== "delete" ||
      originalIntent[0].base_main !== original.local_main ||
      originalIntent[0].base_event_seq !== original.last_applied_event_seq ||
      !Array.isArray(originalExplicitDirectories) ||
      originalExplicitDirectories.some((dirPath) => typeof dirPath !== "string") ||
      !Array.isArray(original.advanced_directory_intents) ||
      original.advanced_directory_intents.length !== 3 ||
      original.advanced_directory_intents.some((intent) => !intent ||
        !["create", "delete"].includes(intent.op) || !isSafeJournalPath(intent.path)) ||
      original.advanced_directory_intents.filter((intent) => intent.op === "delete" && intent.path === originalIntent[0].path).length !== 1 ||
      original.advanced_directory_intents.filter((intent) => intent.op === "create").length !== 2 ||
      original.checkpoint_removal_authorized !== false ||
      typeof original.rejected_transfer_id !== "string" ||
      !/^trn_[A-Za-z0-9]+$/u.test(original.rejected_transfer_id) ||
      state.local_main !== original.target_main ||
      state.last_event_seq < original.recovered_event_seq ||
      state.last_applied_event_seq < original.recovered_event_seq ||
      await this.resolveRef("refs/heads/main") !== original.target_main ||
      await this.resolveRef("refs/heads/local") !== state.local_head ||
      !await this.commitExists(original.local_main) ||
      !await this.commitExists(original.target_main) ||
      !await this.commitExists(original.pending_commit) ||
      !await this.isAncestor(original.local_main, original.target_main) ||
      !await this.isAncestor(original.server_device_ref, original.local_main) ||
      original.server_device_ref === original.local_main ||
      !await this.isAncestor(original.server_device_ref, original.pending_commit)) fail();
    const [baseCommit, emptyCommit] = await Promise.all([
      git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: original.local_main }),
      git.readCommit({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: original.pending_commit })
    ]);
    if (emptyCommit.commit.parent.length !== 1 || emptyCommit.commit.parent[0] !== original.local_main ||
      emptyCommit.commit.tree !== baseCommit.commit.tree) fail();
    const [targetPolicy, basePolicy] = await Promise.all([
      this.targetApplyPolicy(original.target_main), this.targetApplyPolicy(original.local_main)
    ]);
    const deletePrefix = `${originalIntent[0].path}/`;
    const baseEntries = await this.listTreeBlobOids(original.local_main);
    if (!targetPolicy.policy.ignores(originalIntent[0].path, true) ||
      [...targetPolicy.entries.keys(), ...baseEntries.keys()].some((filePath) =>
        filePath === originalIntent[0].path || filePath.startsWith(deletePrefix))) fail();
    const queuedNew = queue.pending_commit && queue.pending_commit !== original.pending_commit;
    if (queue.status !== "queued_local" || queue.expected_device_ref !== original.server_device_ref ||
      (queuedNew && (queue.pending_commit !== state.local_head ||
        queue.pending_commit === original.target_main ||
        !await this.commitExists(queue.pending_commit) ||
        !await this.isAncestor(original.target_main, queue.pending_commit))) ||
      (!queuedNew && state.local_head !== original.target_main) ||
      (queue.pending_commit !== original.pending_commit && !queuedNew &&
        !(authorized && queue.pending_commit === null)) ||
      (authorized && (!legacySettlementQueueAgrees(archive.evidence.queue, queue, true) ||
        (archive.evidence.queue.pending_commit !== original.pending_commit &&
          (!queuedNew || !await this.isAncestor(archive.evidence.queue.pending_commit, queue.pending_commit)))))) fail();
    if (directoryState.pending_intents.some((intent) => intent.intent_id === originalIntent[0].intent_id) ||
      directoryState.pending_intents.some((intent) => !targetPolicy.policy.ignores(intent.path, true))) fail();
    if (!oldUpload || !isUploadTransferCheckpoint(oldUpload) ||
      oldUpload.target_commit !== original.pending_commit ||
      oldUpload.identity !== original.rejected_checkpoint_identity ||
      oldUpload.attempt_id !== original.rejected_attempt_id ||
      oldUpload.transfer_id !== original.rejected_transfer_id ||
      oldUpload.transfer_request.plan_sha256 !== original.rejected_plan_sha256 ||
      oldUpload.transfer_request.expected_device_ref !== original.server_device_ref ||
      oldUpload.transfer_request.root_ignore_capability !== "root-ignore-v1" ||
      oldUpload.transfer_request.root_ignore_oid !== basePolicy.oid ||
      stableJson(oldUpload.transfer_request.directory_proposal) !== stableJson(oldUpload.directory_proposal) ||
      !oldUpload.directory_proposal ||
      oldUpload.directory_proposal.base_main !== original.local_main ||
      oldUpload.directory_proposal.base_event_seq !== original.last_applied_event_seq ||
      oldUpload.directory_proposal.intents?.length !== 1 ||
      stableJson(oldUpload.directory_proposal.intents[0]) !== stableJson(originalIntent[0]) ||
      (upload && stableJson(upload) !== stableJson(oldUpload)) ||
      (!upload && !authorized)) fail();
    if (!oldPull || !isCompletePullCheckpoint(oldPull) ||
      oldPull.target_main !== original.target_main ||
      oldPull.current_local_main !== original.local_main ||
      oldPull.manifest.event_seq !== original.recovered_event_seq ||
      stableJson(oldPull.manifest.explicit_directories) !== stableJson(originalExplicitDirectories) ||
      stableJson(oldPull.manifest.directory_intents.map((intent) => [intent.op, intent.path]).sort()) !==
        stableJson(original.advanced_directory_intents.map((intent) => [intent.op, intent.path]).sort()) ||
      oldPull.manifest.root_ignore_oid !== targetPolicy.oid ||
      state.last_applied_event_seq < oldPull.manifest.event_seq ||
      (pull && stableJson(pull) !== stableJson(oldPull)) ||
      (!pull && !authorized)) fail();
    await this.validateCompleteTransferCheckpoint(oldPull, original.local_main);
    const pendingAck = await this.readPendingAppliedAcknowledgement();
    if (pendingAck && (pendingAck.target_main !== original.target_main ||
      pendingAck.event_seq < original.recovered_event_seq)) fail();
    const token = await this.readDeviceToken();
    const serverDevice = await this.getDeviceSelf(token);
    if (serverDevice.server_device_ref !== original.server_device_ref ||
      !await this.isAncestor(serverDevice.server_device_ref, original.pending_commit) ||
      serverDevice.server_device_ref === original.pending_commit ||
      (serverDevice.last_applied_main !== original.target_main && !pendingAck)) fail();
    if (!authorized) {
      const evidence = { journal: original, state, queue, directoryState, upload, pull };
      const digest = sha256(Buffer.from(stableJson(evidence)));
      if (!legacySettlementQueueAgrees(queue, await this.readQueue()) ||
        !legacySettlementStateAgrees(state, await this.readState()) ||
        !legacySettlementDirectoryAgrees(directoryState, await this.readDirectoryState()) ||
        stableJson(await readRecoveryJsonStrict(this.fsp, this.uploadTransferPath, "legacy_directory_advance_unsafe", "The upload checkpoint changed.")) !== stableJson(upload)) fail();
      if (archive && (archive.digest !== digest && !legacySettlementEvidenceAgrees(archive.evidence, evidence))) fail();
      if (!archive) {
        await this.fsp.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
        if (typeof this.fsp.syncDirectory === "function") await this.fsp.syncDirectory(this.obtsDir);
        await writeJson(this.fsp, archivePath, { version: 1, digest, evidence });
      }
      const published = await readRecoveryJsonStrict(this.fsp, archivePath,
        "legacy_directory_advance_unsafe", "The recovery archive was not published.");
      if (!published || published.digest !== sha256(Buffer.from(stableJson(published.evidence))) ||
        !legacySettlementEvidenceAgrees(published.evidence, evidence) ||
        !legacySettlementQueueAgrees(queue, await this.readQueue()) ||
        !legacySettlementStateAgrees(state, await this.readState()) ||
        !legacySettlementDirectoryAgrees(directoryState, await this.readDirectoryState()) ||
        stableJson(await readRecoveryJsonStrict(this.fsp, this.uploadTransferPath,
          "legacy_directory_advance_unsafe", "The upload checkpoint changed.")) !== stableJson(upload) ||
        stableJson(await readRecoveryJsonStrict(this.fsp, this.pullTransferPath,
          "legacy_directory_advance_unsafe", "The pull checkpoint changed.")) !== stableJson(pull)) fail();
      await writeJson(this.fsp, this.directoryBaselineRecoveryPath, Object.assign({}, original, {
        phase: "legacy_retirement_authorized", legacy_archive_digest: published.digest, updated_at: nowIso()
      }));
    }
    if (upload) {
      await this.cancelLegacyDirectoryTransfer(state, original, token);
      if (stableJson(await readRecoveryJsonStrict(this.fsp, this.uploadTransferPath,
        "legacy_directory_advance_unsafe", "The upload checkpoint changed.")) !== stableJson(oldUpload)) fail();
      await this.fsp.rm(this.uploadTransferPath, { force: true });
      if (typeof this.fsp.syncDirectory === "function") await this.fsp.syncDirectory(this.obtsDir);
    }
    if (queue.pending_commit === original.pending_commit) {
      await this.updateQueue(async (current) => {
        if (!legacySettlementQueueAgrees(queue, current)) fail();
        return Object.assign({}, current, { pending_commit: null, status: "queued_local", attempts: 0, updated_at: nowIso() });
      });
    }
    if (pull) {
      if (stableJson(await readRecoveryJsonStrict(this.fsp, this.pullTransferPath,
        "legacy_directory_advance_unsafe", "The pull checkpoint changed.")) !== stableJson(oldPull)) fail();
      await this.retryPendingAppliedAcknowledgement();
      await this.settlePreviouslyAppliedPullCheckpoint();
      if (await exists(this.fsp, this.pullTransferPath)) fail();
      if (typeof this.fsp.syncDirectory === "function") await this.fsp.syncDirectory(this.obtsDir);
    }
    if (await exists(this.fsp, this.uploadTransferPath) || await exists(this.fsp, this.pullTransferPath)) fail();
    const currentState = await this.readState();
    const finalQueue = await this.readQueue();
    if (currentState.local_main !== original.target_main ||
      ![original.target_main, finalQueue.pending_commit].includes(currentState.local_head) ||
      currentState.server_device_ref !== original.server_device_ref ||
      finalQueue.expected_device_ref !== original.server_device_ref ||
      !legacySettlementQueueAgrees(archive?.evidence.queue || queue, finalQueue, true) ||
      (archive && archive.evidence.queue.pending_commit !== original.pending_commit &&
        !await this.isAncestor(archive.evidence.queue.pending_commit, finalQueue.pending_commit)) ||
      (finalQueue.pending_commit !== null && finalQueue.pending_commit !== queue.pending_commit) ||
      finalQueue.status !== "queued_local" ||
      currentState.last_event_seq < original.recovered_event_seq ||
      currentState.last_applied_event_seq < original.recovered_event_seq ||
      await this.resolveRef("refs/heads/main") !== original.target_main ||
      await this.resolveRef("refs/heads/local") !== currentState.local_head) fail();
    if (currentState.last_error_code === "stale_directory_proposal_base") {
      await this.writeState(Object.assign({}, currentState, {
        last_error_code: null, last_error_details: null, updated_at: nowIso()
      }));
    }
    const finalArchive = await readRecoveryJsonStrict(this.fsp, archivePath,
      "legacy_directory_advance_unsafe", "The recovery archive disappeared.");
    const finalJournal = await readRecoveryJsonStrict(this.fsp, this.directoryBaselineRecoveryPath,
      "legacy_directory_advance_unsafe", "The authorized journal disappeared.");
    if (!finalArchive || finalArchive.digest !== sha256(Buffer.from(stableJson(finalArchive.evidence))) ||
      finalJournal?.phase !== "legacy_retirement_authorized" ||
      finalJournal.legacy_archive_digest !== finalArchive.digest ||
      !legacySettlementEvidenceAgrees(finalArchive.evidence,
        archive?.evidence || { journal: original, state, queue, directoryState, upload, pull })) fail();
    await this.fsp.rm(this.directoryBaselineRecoveryPath, { force: true });
    if (typeof this.fsp.syncDirectory === "function") await this.fsp.syncDirectory(this.obtsDir);
    return true;
  }

  async recoverStaleDirectoryProposalBase() {
    const state = await this.readState();
    const queue = await this.readQueue();
    let journal = await readRecoveryJsonStrict(
      this.fsp,
      this.directoryBaselineRecoveryPath,
      "directory_baseline_recovery_journal_invalid",
      "The directory baseline recovery journal is malformed."
    );
    if (state.last_error_code !== "stale_directory_proposal_base" && !journal) return false;
    const [actualMain, actualHead] = await Promise.all([
      this.resolveRef("refs/heads/main"),
      this.resolveRef("refs/heads/local")
    ]);
    if (
      !state.vault_id || !state.device_id || !state.local_main || !state.local_head ||
      actualMain !== state.local_main || actualHead !== state.local_head ||
      !queue.pending_commit || !await this.commitExists(queue.pending_commit) ||
      !await this.isAncestor(state.local_main, queue.pending_commit) ||
      !await this.isAncestor(queue.pending_commit, state.local_head)
    ) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_unsafe",
        "The rejected directory baseline cannot be repaired without matching refs and preserved queued local history."
      );
    }

    const previousDirectoryState = await this.readDirectoryState();
    const uploadCheckpoint = await readRecoveryJsonStrict(
      this.fsp,
      this.uploadTransferPath,
      "directory_baseline_recovery_journal_invalid",
      "The rejected upload checkpoint is malformed."
    );
    if (!journal) {
      if (uploadCheckpoint && (!isUploadTransferCheckpoint(uploadCheckpoint) || uploadCheckpoint.target_commit !== queue.pending_commit)) {
        throw new ObtsBlockedError(
          "directory_baseline_recovery_journal_invalid",
          "The rejected upload checkpoint does not match the queued commit."
        );
      }
      journal = {
        version: 1,
        phase: "planned",
        vault_id: state.vault_id,
        device_id: state.device_id,
        local_main: state.local_main,
        local_head: state.local_head,
        server_device_ref: state.server_device_ref,
        last_event_seq: state.last_event_seq || 0,
        last_applied_event_seq: state.last_applied_event_seq || 0,
        pending_commit: queue.pending_commit,
        rejected_transfer_id: uploadCheckpoint?.transfer_id || null,
        rejected_checkpoint_identity: uploadCheckpoint?.identity || null,
        rejected_attempt_id: uploadCheckpoint?.attempt_id || null,
        rejected_plan_sha256: uploadCheckpoint?.transfer_request?.plan_sha256 || null,
        original_pending_intents: previousDirectoryState.pending_intents,
        recovered_event_seq: null,
        recovered_server_device_ref: null,
        checkpoint_removal_authorized: false,
        created_at: nowIso(),
        updated_at: nowIso()
      };
      await writeJson(this.fsp, this.directoryBaselineRecoveryPath, journal);
    }
    const allowedAppliedCursors = new Set([
      journal.last_applied_event_seq,
      Number.isSafeInteger(journal.recovered_event_seq) ? journal.recovered_event_seq : null
    ]);
    const allowedServerDeviceRefs = new Set([journal.server_device_ref, journal.recovered_server_device_ref]);
    const checkpointJournalFields = [
      journal.rejected_transfer_id,
      journal.rejected_checkpoint_identity,
      journal.rejected_attempt_id,
      journal.rejected_plan_sha256
    ];
    const checkpointJournalFieldsComplete = checkpointJournalFields.every((value) => value === null) ||
      checkpointJournalFields.every((value) => typeof value === "string");
    if (
      journal.version !== 1 || !["planned", "snapshot_proven", "baseline_acknowledged"].includes(journal.phase) ||
      journal.vault_id !== state.vault_id || journal.device_id !== state.device_id ||
      !Number.isSafeInteger(journal.last_event_seq) || journal.last_event_seq < 0 ||
      !Number.isSafeInteger(journal.last_applied_event_seq) || journal.last_applied_event_seq < 0 ||
      !(journal.server_device_ref === null || isGitObjectId(journal.server_device_ref)) ||
      !(journal.recovered_server_device_ref === null || isGitObjectId(journal.recovered_server_device_ref)) ||
      !(journal.recovered_event_seq === null || Number.isSafeInteger(journal.recovered_event_seq) && journal.recovered_event_seq >= 0) ||
      journal.local_main !== state.local_main || journal.local_head !== state.local_head ||
      journal.pending_commit !== queue.pending_commit || !allowedServerDeviceRefs.has(state.server_device_ref) ||
      journal.last_event_seq > (state.last_event_seq || 0) ||
      !allowedAppliedCursors.has(state.last_applied_event_seq || 0) ||
      !Array.isArray(journal.original_pending_intents) ||
      journal.original_pending_intents.some((intent) => !isStoredDirectoryIntent(intent)) ||
      typeof journal.checkpoint_removal_authorized !== "boolean" || !checkpointJournalFieldsComplete ||
      !(journal.rejected_transfer_id === null || typeof journal.rejected_transfer_id === "string" && /^trn_[A-Za-z0-9]+$/u.test(journal.rejected_transfer_id)) ||
      !(journal.rejected_checkpoint_identity === null || typeof journal.rejected_checkpoint_identity === "string" && /^[0-9a-f]{64}$/u.test(journal.rejected_checkpoint_identity)) ||
      !(journal.rejected_attempt_id === null || typeof journal.rejected_attempt_id === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(journal.rejected_attempt_id)) ||
      !(journal.rejected_plan_sha256 === null || typeof journal.rejected_plan_sha256 === "string" && /^[0-9a-f]{64}$/u.test(journal.rejected_plan_sha256)) ||
      journal.phase === "planned" && (journal.recovered_event_seq !== null || journal.recovered_server_device_ref !== null || journal.checkpoint_removal_authorized) ||
      journal.phase === "snapshot_proven" && (journal.recovered_event_seq === null || journal.checkpoint_removal_authorized) ||
      journal.phase === "baseline_acknowledged" && journal.recovered_event_seq === null
    ) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_journal_invalid",
        "The directory baseline recovery journal does not match the protected refs, cursors, queue, and intent evidence."
      );
    }
    if (uploadCheckpoint && (
      !isUploadTransferCheckpoint(uploadCheckpoint) ||
      uploadCheckpoint.target_commit !== journal.pending_commit ||
      uploadCheckpoint.transfer_id !== journal.rejected_transfer_id ||
      uploadCheckpoint.identity !== journal.rejected_checkpoint_identity ||
      uploadCheckpoint.attempt_id !== journal.rejected_attempt_id ||
      uploadCheckpoint.transfer_request.plan_sha256 !== journal.rejected_plan_sha256
    )) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_journal_invalid",
        "The upload checkpoint changed after directory baseline recovery began."
      );
    }
    if (!uploadCheckpoint && journal.rejected_transfer_id && !journal.checkpoint_removal_authorized) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_journal_invalid",
        "The rejected upload checkpoint disappeared before recovery authorized its removal."
      );
    }

    this.plugin.setStatus("Repairing baseline");
    await this.writeState(Object.assign({}, state, {
      status_label: "Repairing baseline",
      last_error_code: "stale_directory_proposal_base",
      updated_at: nowIso()
    }));

    const token = await this.readDeviceToken();
    const serverDevice = await this.getDeviceSelf(token);
    if (
      !serverDevice.last_applied_main || !Number.isSafeInteger(serverDevice.last_applied_event_seq) ||
      !await this.commitExists(serverDevice.last_applied_main) ||
      !await this.isAncestor(serverDevice.last_applied_main, state.local_main)
    ) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_unsafe",
        "The server-acknowledged device baseline is not a trusted ancestor of local main."
      );
    }

    const pulled = await this.pull(
      state.vault_id,
      state.device_id,
      token,
      state.local_main,
      state.local_main,
      serverDevice.last_applied_event_seq
    );
    if (
      pulled.manifest.target_main !== state.local_main ||
      !Number.isSafeInteger(pulled.manifest.event_seq) ||
      pulled.manifest.event_seq < serverDevice.last_applied_event_seq ||
      pulled.manifest.event_seq < journal.last_applied_event_seq ||
      !Array.isArray(pulled.manifest.explicit_directories)
    ) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_unsafe",
        "The server could not prove the authoritative directory baseline for local main."
      );
    }
    journal = Object.assign({}, journal, {
      phase: journal.phase === "baseline_acknowledged" ? "baseline_acknowledged" : "snapshot_proven",
      recovered_event_seq: pulled.manifest.event_seq,
      recovered_server_device_ref: serverDevice.server_device_ref,
      updated_at: nowIso()
    });
    await writeJson(this.fsp, this.directoryBaselineRecoveryPath, journal);

    const inventory = await this.listLocalVaultInventory("");
    const localFiles = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    const currentDirs = inventory.directories.filter((dirPath) => isSyncableVaultPath(dirPath)).sort();
    const currentExplicitDirs = explicitEmptyDirectories(currentDirs, localFiles);
    const baseExplicitDirs = Array.from(new Set(pulled.manifest.explicit_directories)).sort();
    const baseSet = new Set(baseExplicitDirs);
    const currentSet = new Set(currentExplicitDirs);
    const changes = [
      ...currentExplicitDirs.filter((dirPath) => !baseSet.has(dirPath)).map((dirPath) => ({ op: "create", path: dirPath })),
      ...topmostDirectories(baseExplicitDirs.filter((dirPath) => !currentSet.has(dirPath))).map((dirPath) => ({ op: "delete", path: dirPath }))
    ];
    const originalIntents = normalizeStoredDirectoryIntents(journal.original_pending_intents);
    const originalByOperation = new Map(originalIntents.map((intent) => [directoryIntentOperationKey(intent), intent]));
    let nextGeneration = Math.max(
      previousDirectoryState.next_generation,
      originalIntents.reduce((maximum, intent) => Math.max(maximum, (intent.generation || 0) + 1), 1)
    );
    const rebuiltIntents = changes.map((change) => {
      const existing = originalByOperation.get(`${change.op}\0${change.path}`);
      if (existing) {
        return Object.assign({}, existing, {
          base_main: state.local_main,
          base_event_seq: pulled.manifest.event_seq
        });
      }
      const intent = {
        op: change.op,
        path: change.path,
        intent_id: `dir_${Date.now()}_${nextGeneration}_${randomHex(6)}`,
        generation: nextGeneration,
        provenance: "local_v2",
        base_main: state.local_main,
        base_event_seq: pulled.manifest.event_seq,
        replaces_intent_id: null,
        recreated_after_delete: false,
        created_at: nowIso()
      };
      nextGeneration += 1;
      return intent;
    });
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      observed_directory_ctimes: await this.captureDirectoryCreationTimes(currentDirs),
      explicit_empty_dirs: currentExplicitDirs,
      pending_intents: rebuiltIntents,
      next_generation: nextGeneration,
      updated_at: nowIso()
    });

    await this.writePendingAppliedAcknowledgement(state.local_main, pulled.manifest.event_seq);
    await this.retryPendingAppliedAcknowledgement();
    journal = Object.assign({}, journal, { phase: "baseline_acknowledged", updated_at: nowIso() });
    await writeJson(this.fsp, this.directoryBaselineRecoveryPath, journal);
    const currentCheckpoint = await readRecoveryJsonStrict(
      this.fsp,
      this.uploadTransferPath,
      "directory_baseline_recovery_journal_invalid",
      "The rejected upload checkpoint is malformed."
    );
    if (currentCheckpoint && (
      !isUploadTransferCheckpoint(currentCheckpoint) ||
      currentCheckpoint.target_commit !== journal.pending_commit ||
      currentCheckpoint.transfer_id !== journal.rejected_transfer_id ||
      currentCheckpoint.identity !== journal.rejected_checkpoint_identity ||
      currentCheckpoint.attempt_id !== journal.rejected_attempt_id ||
      currentCheckpoint.transfer_request.plan_sha256 !== journal.rejected_plan_sha256
    )) {
      throw new ObtsBlockedError(
        "directory_baseline_recovery_journal_invalid",
        "The rejected upload checkpoint no longer matches the recovery journal."
      );
    }
    journal = Object.assign({}, journal, { checkpoint_removal_authorized: true, updated_at: nowIso() });
    await writeJson(this.fsp, this.directoryBaselineRecoveryPath, journal);
    await this.fsp.rm(this.uploadTransferPath, { force: true });
    await this.updateQueue(async (currentQueue) => {
      if (currentQueue.pending_commit !== journal.pending_commit) {
        throw new ObtsBlockedError(
          "directory_baseline_recovery_journal_invalid",
          "The queued commit changed while repairing its directory baseline."
        );
      }
      return Object.assign({}, currentQueue, {
        expected_device_ref: serverDevice.server_device_ref,
        status: "queued_local",
        attempts: 0,
        updated_at: nowIso()
      });
    });
    await this.writeState(Object.assign({}, await this.readState(), {
      server_device_ref: serverDevice.server_device_ref,
      status_label: "Ahead",
      last_error_code: null,
      last_error_details: null,
      updated_at: nowIso()
    }));
    await this.fsp.rm(this.directoryBaselineRecoveryPath, { force: true });
    return true;
  }

  async readDirectoryState() {
    const state = await readJson(this.fsp, this.directoryStatePath, null);
    if (!state) {
      return { version: 2, next_generation: 1, observed_dirs: [], observed_directory_ctimes: {}, explicit_empty_dirs: [], pending_intents: [], updated_at: nowIso() };
    }
    const pendingIntents = normalizeStoredDirectoryIntents(Array.isArray(state.pending_intents) ? state.pending_intents : []);
    const highestGeneration = pendingIntents.reduce((maximum, intent) => Math.max(maximum, intent.generation || 0), 0);
    return {
      version: 2,
      next_generation: Number.isSafeInteger(state.next_generation) && state.next_generation > highestGeneration
        ? state.next_generation
        : highestGeneration + 1,
      observed_dirs: Array.isArray(state.observed_dirs) ? state.observed_dirs : [],
      observed_directory_ctimes: state.observed_directory_ctimes && typeof state.observed_directory_ctimes === "object" && !Array.isArray(state.observed_directory_ctimes)
        ? state.observed_directory_ctimes
        : {},
      explicit_empty_dirs: Array.isArray(state.explicit_empty_dirs) ? state.explicit_empty_dirs : [],
      pending_intents: compactDirectoryIntents(pendingIntents),
      updated_at: typeof state.updated_at === "string" ? state.updated_at : nowIso()
    };
  }

  async writeDirectoryState(state) {
    const pendingIntents = compactDirectoryIntents(normalizeStoredDirectoryIntents(state.pending_intents));
    const highestGeneration = pendingIntents.reduce((maximum, intent) => Math.max(maximum, intent.generation || 0), 0);
    await writeJson(this.fsp, this.directoryStatePath, {
      version: 2,
      next_generation: Number.isSafeInteger(state.next_generation) && state.next_generation > highestGeneration
        ? state.next_generation
        : highestGeneration + 1,
      observed_dirs: Array.from(new Set(state.observed_dirs)).sort(),
      observed_directory_ctimes: Object.fromEntries(Array.from(new Set(state.observed_dirs)).sort().map((dirPath) => [
        dirPath,
        state.observed_directory_ctimes && Object.hasOwn(state.observed_directory_ctimes, dirPath)
          ? state.observed_directory_ctimes[dirPath]
          : null
      ])),
      explicit_empty_dirs: Array.from(new Set(state.explicit_empty_dirs)).sort(),
      pending_intents: pendingIntents,
      updated_at: state.updated_at
    });
  }

  async createDirectoryIntents(previous, changes) {
    if (changes.length === 0) return { intents: [], nextGeneration: previous.next_generation };
    const state = await this.readState();
    let generation = previous.next_generation;
    const byPath = new Map(previous.pending_intents.map((intent) => [intent.path, intent]));
    const intents = changes.map((change) => {
      const replaced = byPath.get(change.path) || null;
      const preserveLegacyProvenance = Boolean(
        replaced &&
        replaced.provenance === "legacy" &&
        replaced.op === change.op &&
        !change.recreated_after_delete
      );
      const intent = {
        op: change.op,
        path: change.path,
        intent_id: `dir_${Date.now()}_${generation}_${randomHex(6)}`,
        generation,
        provenance: preserveLegacyProvenance ? "legacy" : "local_v2",
        base_main: state.local_main || null,
        base_event_seq: state.last_applied_event_seq || 0,
        replaces_intent_id: replaced && replaced.intent_id || null,
        recreated_after_delete: Boolean(change.recreated_after_delete || change.op === "create" && replaced && replaced.op === "delete"),
        created_at: nowIso()
      };
      generation += 1;
      byPath.set(change.path, intent);
      return intent;
    });
    return { intents, nextGeneration: generation };
  }

  async reconcileDirectoryState(knownLocalFiles = undefined, knownLocalDirectories = undefined) {
    if (!(await exists(this.fsp, this.directoryStatePath))) {
      await this.refreshDirectoryStateFromDisk([], knownLocalFiles, knownLocalDirectories);
      return [];
    }
    const stored = await this.readDirectoryState();
    const policy = (await this.readRootIgnorePolicy()).policy;
    const allowedDirectory = (dirPath) => isSyncableVaultPath(dirPath) && !policy.ignores(dirPath, true);
    const previous = {
      ...stored,
      observed_dirs: stored.observed_dirs.filter(allowedDirectory),
      observed_directory_ctimes: Object.fromEntries(Object.entries(stored.observed_directory_ctimes).filter(([dirPath]) => allowedDirectory(dirPath))),
      explicit_empty_dirs: stored.explicit_empty_dirs.filter(allowedDirectory),
      pending_intents: stored.pending_intents.filter((intent) => allowedDirectory(intent.path))
    };
    const currentDirs = (knownLocalDirectories || await this.listLocalVaultDirectories()).filter(allowedDirectory);
    const currentFiles = (knownLocalFiles || await this.scanSyncableFiles(policy)).filter(isSyncableVaultPath);
    const explicitDirs = explicitEmptyDirectories(currentDirs, currentFiles);
    const previousDirs = new Set(previous.observed_dirs);
    const previousExplicitDirs = new Set(previous.explicit_empty_dirs);
    const currentDirSet = new Set(currentDirs);
    const currentDirectoryCtimes = await this.captureDirectoryCreationTimes(currentDirs);
    const changes = [
      ...explicitDirs
        .filter((dirPath) => {
          const identityChanged = Object.hasOwn(previous.observed_directory_ctimes, dirPath) &&
            previous.observed_directory_ctimes[dirPath] !== null &&
            currentDirectoryCtimes[dirPath] !== null &&
            previous.observed_directory_ctimes[dirPath] !== currentDirectoryCtimes[dirPath];
          return !previousDirs.has(dirPath) || !previousExplicitDirs.has(dirPath) || identityChanged;
        })
        .map((dirPath) => ({
          op: "create",
          path: dirPath,
          recreated_after_delete: previousDirs.has(dirPath) && previous.observed_directory_ctimes[dirPath] !== currentDirectoryCtimes[dirPath]
        })),
      ...topmostDirectories(previous.observed_dirs.filter((dirPath) => !currentDirSet.has(dirPath)))
        .map((dirPath) => ({ op: "delete", path: dirPath }))
    ];
    const created = await this.createDirectoryIntents(previous, changes);
    const pendingIntents = compactDirectoryIntents([...previous.pending_intents, ...created.intents]);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      observed_directory_ctimes: currentDirectoryCtimes,
      explicit_empty_dirs: explicitDirs,
      pending_intents: pendingIntents,
      next_generation: created.nextGeneration,
      updated_at: nowIso()
    });
    return pendingIntents;
  }

  async clearPendingDirectoryIntents() {
    await this.refreshDirectoryStateFromDisk([]);
  }

  async clearAcknowledgedDirectoryIntents(acknowledgedIntents) {
    await this.reconcileDirectoryState();
    const directoryState = await this.readDirectoryState();
    const acknowledgedKeys = new Set((Array.isArray(acknowledgedIntents) ? acknowledgedIntents : [])
      .filter((intent) => intent && typeof intent.intent_id === "string" && Number.isSafeInteger(intent.generation))
      .map(directoryIntentGenerationKey));
    const remaining = directoryState.pending_intents.filter((intent) => !acknowledgedKeys.has(directoryIntentGenerationKey(intent)));
    await this.writeDirectoryState(Object.assign({}, directoryState, {
      pending_intents: remaining,
      updated_at: nowIso()
    }));
  }

  async classifyDirectoryIntentsForRecovery(remoteIntents) {
    const directoryState = await this.readDirectoryState();
    const deletePaths = remoteIntents.filter((intent) => intent.op === "delete").map((intent) => intent.path);
    const classification = { directoryState, unrelated: [], superseded: [], ambiguous: [] };
    for (const intent of directoryState.pending_intents) {
      const coveredByRemoteDelete = intent.op === "create" && deletePaths.some((deletedPath) =>
        intent.path === deletedPath || intent.path.startsWith(`${deletedPath}/`)
      );
      if (!coveredByRemoteDelete) {
        classification.unrelated.push(intent);
        continue;
      }
      if (!(await this.adapterIsDirectoryStrict(intent.path))) {
        classification.superseded.push(intent);
        continue;
      }
      classification.ambiguous.push(intent);
    }
    return classification;
  }

  async readDirectoryRecoveryDecision() {
    try {
      return parseDirectoryRecoveryDecision(JSON.parse(await this.fsp.readFile(this.directoryRecoveryPath, "utf8")));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      if (error instanceof ObtsBlockedError) throw error;
      throw new ObtsBlockedError("directory_recovery_journal_invalid", "The directory recovery journal is invalid.");
    }
  }

  async captureDirectoryRecoveryInventory(roots) {
    const inventory = await this.listLocalVaultInventory("");
    const covered = (filePath) => roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
    const directories = [];
    for (const dirPath of inventory.directories.filter(covered).sort()) {
      directories.push({ path: dirPath, creation_time: await this.adapterDirectoryCreationTime(dirPath) });
    }
    const files = [];
    for (const filePath of inventory.files.filter((candidate) => covered(candidate) && isSyncableVaultPath(candidate)).sort()) {
      files.push({ path: filePath, fingerprint: await this.recoveryFileFingerprint(filePath) });
    }
    return { directories, files };
  }

  async stageDirectoryRecoveryDecision({ state, serverState, manifest, classification, automatic = false }) {
    const existing = await this.readDirectoryRecoveryDecision();
    if (existing) {
      if (existing.target_main !== manifest.target_main || existing.event_seq !== (manifest.event_seq || 0)) {
        throw new ObtsBlockedError("directory_recovery_journal_mismatch", "A different directory recovery decision is already pending.");
      }
      return existing;
    }
    const ambiguousRoots = topmostDirectories(classification.ambiguous.map((intent) => intent.path));
    const supersededRoots = topmostDirectories(classification.superseded.map((intent) => intent.path));
    const roots = topmostDirectories([...ambiguousRoots, ...supersededRoots]);
    const decisions = automatic ? Object.fromEntries(ambiguousRoots.map((root) => [root, "keep_local"])) : null;
    const recovery = {
      version: 1,
      recovery_id: `dirrec_${Date.now()}_${randomHex(8)}`,
      phase: automatic ? "executing" : "awaiting_decision",
      base_main: serverState.last_applied_main || state.local_main,
      target_main: manifest.target_main,
      local_main_at_decision: state.local_main,
      local_head_at_decision: state.local_head,
      event_seq: manifest.event_seq || 0,
      changed_paths: manifest.changed_paths || [],
      target_file_sizes: isTargetFileSizeMap(manifest.target_file_sizes) ? Object.assign({}, manifest.target_file_sizes) : {},
      directory_intents: (manifest.directory_intents || []).map((intent) => ({ op: intent.op, path: intent.path })),
      explicit_directories: manifest.explicit_directories || [],
      original_pending_intents: classification.directoryState.pending_intents,
      next_generation: classification.directoryState.next_generation,
      ambiguous_intents: classification.ambiguous,
      superseded_intents: classification.superseded,
      ambiguous_roots: ambiguousRoots,
      decisions,
      inventory: await this.captureDirectoryRecoveryInventory(roots),
      archived: false,
      last_completed_step: "decision_recorded",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
    return recovery;
  }

  async resolveDirectoryRecovery(decisions) {
    const recovery = await this.readDirectoryRecoveryDecision();
    if (!recovery || recovery.phase !== "awaiting_decision") {
      throw new ObtsBlockedError("directory_recovery_not_pending", "No directory recovery decision is pending.");
    }
    const normalized = {};
    for (const root of recovery.ambiguous_roots) {
      const choice = decisions && decisions[root];
      if (choice !== "keep_local" && choice !== "accept_server") {
        throw new ObtsBlockedError("directory_recovery_choice_invalid", "Every ambiguous directory subtree requires a recovery choice.");
      }
      normalized[root] = choice;
    }
    const executing = Object.assign({}, recovery, { phase: "executing", decisions: normalized, updated_at: nowIso() });
    await writeJson(this.fsp, this.directoryRecoveryPath, executing);
    return await this.executeDirectoryRecoveryDecision(executing);
  }

  async resetDirectoryRecoveryAfterChange(recovery) {
    const directoryState = await this.readDirectoryState();
    const pendingByPath = new Map(directoryState.pending_intents.map((intent) => [intent.path, intent]));
    for (const intent of recovery.original_pending_intents) {
      if (!pendingByPath.has(intent.path)) pendingByPath.set(intent.path, intent);
    }
    const restoredPending = compactDirectoryIntents([...pendingByPath.values()]);
    await this.writeDirectoryState(Object.assign({}, directoryState, {
      pending_intents: restoredPending,
      next_generation: Math.max(directoryState.next_generation, recovery.next_generation),
      updated_at: nowIso()
    }));
    const classification = await this.classifyDirectoryIntentsForRecovery(recovery.directory_intents);
    const ambiguousRoots = topmostDirectories(classification.ambiguous.map((intent) => intent.path));
    const roots = topmostDirectories([...ambiguousRoots, ...classification.superseded.map((intent) => intent.path)]);
    const awaiting = Object.assign({}, recovery, {
      recovery_id: `dirrec_${Date.now()}_${randomHex(8)}`,
      phase: "awaiting_decision",
      decisions: null,
      original_pending_intents: classification.directoryState.pending_intents,
      next_generation: classification.directoryState.next_generation,
      ambiguous_intents: classification.ambiguous,
      superseded_intents: classification.superseded,
      ambiguous_roots: ambiguousRoots,
      inventory: await this.captureDirectoryRecoveryInventory(roots),
      archived: false,
      last_completed_step: "decision_recorded",
      updated_at: nowIso()
    });
    await writeJson(this.fsp, this.directoryRecoveryPath, awaiting);
    await this.markBlocked("directory_recovery_changed", {
      ambiguous_roots: awaiting.ambiguous_roots.length,
      ambiguous_directories: awaiting.ambiguous_intents.length
    });
    throw new ObtsBlockedError("directory_recovery_changed", "Local directories changed after the recovery decision. Review them again.");
  }

  async preserveLegacyRecoveryIntents(recovery, keptRoots) {
    const directoryState = await this.readDirectoryState();
    const pendingByPath = new Map(directoryState.pending_intents.map((intent) => [intent.path, intent]));
    for (const legacyIntent of recovery.ambiguous_intents.filter((intent) =>
      keptRoots.some((root) => intent.path === root || intent.path.startsWith(`${root}/`))
    )) {
      const current = pendingByPath.get(legacyIntent.path);
      if (current && current.op !== legacyIntent.op) continue;
      pendingByPath.set(legacyIntent.path, Object.assign({}, current || legacyIntent, { provenance: "legacy" }));
    }
    await this.writeDirectoryState(Object.assign({}, directoryState, {
      pending_intents: [...pendingByPath.values()],
      updated_at: nowIso()
    }));
  }

  async queueConfirmedKeptChanges(recovery) {
    const queue = await this.readQueue();
    if (queue.pending_commit) return;
    const targetEntries = await this.listTreeBlobOids(recovery.target_main);
    const preserved = await this.localChangedPathsFromTree(targetEntries, true, { reportOperationProgress: true });
    const pendingDirectoryIntents = (await this.readDirectoryState()).pending_intents;
    const state = await this.readState();
    if (preserved.paths.length > 0) {
      await this.createRecoveryBundle("rebuild_from_server", recovery.target_main, preserved.paths);
      await this.queuePreservedLocalChanges(recovery.target_main, state.server_device_ref, preserved.snapshot);
    } else if (pendingDirectoryIntents.length > 0) {
      await this.queuePreservedDirectoryChanges(recovery.target_main, state.server_device_ref);
    }
  }

  async executeDirectoryRecoveryDecision(recovery) {
    const recoveryRoots = topmostDirectories([
      ...recovery.ambiguous_roots,
      ...recovery.superseded_intents.map((intent) => intent.path)
    ]);
    const state = await this.readState();
    if (state.local_main !== recovery.local_main_at_decision && state.local_main !== recovery.target_main) {
      throw new ObtsBlockedError("directory_recovery_journal_mismatch", "Local main changed outside the pending directory recovery.");
    }
    if (
      (recovery.last_completed_step === "apply_completed" || recovery.last_completed_step === "acknowledged") &&
      (state.local_main !== recovery.target_main || (state.last_applied_event_seq || 0) < recovery.event_seq)
    ) {
      throw new ObtsBlockedError("directory_recovery_journal_invalid", "The directory recovery journal claims an apply step that local state does not prove.");
    }
    if (recovery.last_completed_step === "decision_recorded") {
      const currentInventory = await this.captureDirectoryRecoveryInventory(recoveryRoots);
      if (stableJson(currentInventory) !== stableJson(recovery.inventory)) {
        return await this.resetDirectoryRecoveryAfterChange(recovery);
      }
      const acceptedDirectories = new Set(recovery.inventory.directories.map((entry) => entry.path));
      const acceptedRoots = recovery.ambiguous_roots.filter((root) => recovery.decisions && recovery.decisions[root] === "accept_server");
      if (acceptedRoots.some((root) => [...acceptedDirectories].some((dirPath) =>
        (dirPath === root || dirPath.startsWith(`${root}/`)) &&
        recovery.inventory.directories.find((entry) => entry.path === dirPath).creation_time === null
      ))) {
        await this.markBlocked("directory_identity_unavailable", {
          recovery_roots: acceptedRoots.length
        });
        throw new ObtsBlockedError(
          "directory_identity_unavailable",
          "Automatic directory recovery cannot verify a directory identity on this filesystem."
        );
      }
      if (!recovery.archived) {
        const archiveDir = path.join(this.obtsDir, "recovery", recovery.recovery_id);
        const archivePath = path.join(archiveDir, "directory-recovery.json");
        await this.fsp.mkdir(archiveDir, { recursive: true, mode: 0o700 });
        if (!(await exists(this.fsp, archivePath))) await writeJson(this.fsp, archivePath, recovery);
        recovery = Object.assign({}, recovery, { archived: true, updated_at: nowIso() });
        await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
      }
      const removedIntentIds = new Set([
        ...recovery.superseded_intents.map((intent) => intent.intent_id),
        ...recovery.ambiguous_intents
          .filter((intent) => acceptedRoots.some((root) => intent.path === root || intent.path.startsWith(`${root}/`)))
          .map((intent) => intent.intent_id)
      ]);
      const directoryState = await this.readDirectoryState();
      const originalIntentIds = new Set(recovery.original_pending_intents.map((intent) => intent.intent_id));
      if (directoryState.pending_intents.some((intent) =>
        !originalIntentIds.has(intent.intent_id) && recovery.ambiguous_roots.some((root) => intent.path === root || intent.path.startsWith(`${root}/`))
      )) return await this.resetDirectoryRecoveryAfterChange(recovery);
      await this.writeDirectoryState(Object.assign({}, directoryState, {
        pending_intents: directoryState.pending_intents.filter((intent) => !removedIntentIds.has(intent.intent_id)),
        next_generation: Math.max(directoryState.next_generation, recovery.next_generation),
        updated_at: nowIso()
      }));
      recovery = Object.assign({}, recovery, { last_completed_step: "intent_state_written", updated_at: nowIso() });
      await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
    }
    if (recovery.last_completed_step === "intent_state_written") {
      const appliedState = await this.readState();
      if (appliedState.local_main === recovery.target_main && (appliedState.last_applied_event_seq || 0) >= recovery.event_seq) {
        recovery = Object.assign({}, recovery, { last_completed_step: "apply_completed", updated_at: nowIso() });
        await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
      } else {
        const currentInventory = await this.captureDirectoryRecoveryInventory(recoveryRoots);
        if (stableJson(currentInventory) !== stableJson(recovery.inventory)) {
          return await this.resetDirectoryRecoveryAfterChange(recovery);
        }
        const keptRoots = recovery.ambiguous_roots.filter((root) => recovery.decisions[root] === "keep_local");
        const directoryIntents = recovery.directory_intents.filter((intent) => !(
          intent.op === "delete" && keptRoots.some((root) => root === intent.path || root.startsWith(`${intent.path}/`))
        ));
        const applied = await this.applyTargetMain(
          recovery.target_main,
          recovery.changed_paths,
          true,
          [],
          true,
          directoryIntents,
          recovery.explicit_directories,
          recovery.event_seq,
          true,
          { roots: recoveryRoots, inventory: recovery.inventory },
          recovery.target_file_sizes || {}
        );
        if (!applied) return await this.resetDirectoryRecoveryAfterChange(recovery);
        recovery = Object.assign({}, recovery, { last_completed_step: "apply_completed", updated_at: nowIso() });
        await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
      }
    }
    const keptRoots = recovery.ambiguous_roots.filter((root) => recovery.decisions[root] === "keep_local");
    if (recovery.last_completed_step === "apply_completed") {
      if (keptRoots.length > 0) {
        await this.preserveLegacyRecoveryIntents(recovery, keptRoots);
        await this.queueConfirmedKeptChanges(recovery);
      }
      await this.acknowledgeAppliedMain(recovery.target_main);
      recovery = Object.assign({}, recovery, { last_completed_step: "acknowledged", updated_at: nowIso() });
      await writeJson(this.fsp, this.directoryRecoveryPath, recovery);
    }
    await this.clearResolvedConflictQueue();
    await this.settleAppliedQueue();
    await this.fsp.rm(this.directoryRecoveryPath, { force: true });
    return { status: keptRoots.length > 0 ? "Ahead" : "Synced", main: recovery.target_main };
  }

  async preserveDirectoryChangesFromTarget(targetEntries, explicitDirectories, residualTombstoneDirectories = new Set(), initialization = false) {
    const report = this.createLocalApplyProgress(initialization, "directory_inventory");
    report("Applying (listing vault files)");
    const previous = await this.readDirectoryState();
    const rootOid = targetEntries.get(".gitignore");
    const policy = createRootIgnorePolicy(rootOid ? await this.readBlobOid(rootOid) : null);
    const inventory = await this.listLocalVaultInventory("", null, false, this.createInventoryProgress(initialization));
    const currentFiles = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    const currentDirs = inventory.directories.filter((dirPath) => !policy.ignores(dirPath, true));
    const expectedDirs = new Set(explicitDirectories);
    for (const filePath of targetEntries.keys()) {
      for (const dirPath of directoryPrefixes(filePath)) expectedDirs.add(dirPath);
    }
    const currentDirSet = new Set(currentDirs);
    const currentDirectoryCtimes = await this.captureDirectoryCreationTimes(currentDirs,
      (completed, total) => report("Applying (checking directories)", completed, total));
    const changes = [
      ...explicitEmptyDirectories(currentDirs, currentFiles)
        .filter((dirPath) => !expectedDirs.has(dirPath) && !residualTombstoneDirectories.has(dirPath))
        .map((dirPath) => ({ op: "create", path: dirPath })),
      ...topmostDirectories([...expectedDirs].filter((dirPath) => !currentDirSet.has(dirPath)))
        .map((dirPath) => ({ op: "delete", path: dirPath }))
    ];
    const created = await this.createDirectoryIntents(previous, changes);
    const pendingIntents = compactDirectoryIntents([
      ...previous.pending_intents.filter((intent) => !policy.ignores(intent.path, true)), ...created.intents
    ]);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      observed_directory_ctimes: currentDirectoryCtimes,
      explicit_empty_dirs: explicitEmptyDirectories(currentDirs, currentFiles),
      pending_intents: pendingIntents,
      next_generation: created.nextGeneration,
      updated_at: nowIso()
    });
    return pendingIntents;
  }

  async refreshDirectoryStateFromDisk(pendingIntents = undefined, knownLocalFiles = undefined, knownLocalDirectories = undefined) {
    const previous = await this.readDirectoryState();
    const policy = (await this.readRootIgnorePolicy()).policy;
    const allowedDirectory = (dirPath) => isSyncableVaultPath(dirPath) && !policy.ignores(dirPath, true);
    const currentDirs = (knownLocalDirectories || await this.listLocalVaultDirectories()).filter(allowedDirectory);
    const currentFiles = (knownLocalFiles || await this.scanSyncableFiles(policy)).filter(isSyncableVaultPath);
    const currentDirectoryCtimes = await this.captureDirectoryCreationTimes(currentDirs);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      observed_directory_ctimes: currentDirectoryCtimes,
      explicit_empty_dirs: explicitEmptyDirectories(currentDirs, currentFiles),
      pending_intents: (pendingIntents === undefined ? previous.pending_intents : pendingIntents)
        .filter((intent) => allowedDirectory(intent.path)),
      next_generation: previous.next_generation,
      updated_at: nowIso()
    });
  }

  async hasActionableDirectoryWork(directoryIntents, explicitDirectories, policy = null) {
    for (const intent of directoryIntents) {
      if (!isSyncableVaultPath(intent.path) || (policy && policy.ignores(intent.path, true))) continue;
      const isDirectory = await this.adapterIsDirectory(intent.path);
      if (intent.op === "create" && !isDirectory) return true;
      if (intent.op === "delete" && isDirectory) return true;
    }
    for (const dirPath of explicitDirectories) {
      if (!isSyncableVaultPath(dirPath) || (policy && policy.ignores(dirPath, true))) continue;
      if (!(await this.adapterIsDirectory(dirPath))) return true;
    }
    return false;
  }

  async applyDirectoryChanges(
    directoryIntents,
    explicitDirectories,
    preApplyDirectories = new Set(),
    preApplyDirectoryCtimes = {},
    removableDirectories = preApplyDirectories,
    localOnlyPaths = [],
    targetMain = null
  ) {
    const policy = targetMain ? (await this.targetApplyPolicy(targetMain)).policy : (await this.readRootIgnorePolicy()).policy;
    directoryIntents = compactDirectoryIntents(directoryIntents)
      .filter((intent) => isSyncableVaultPath(intent.path) && !policy.ignores(intent.path, true));
    explicitDirectories = explicitDirectories
      .filter((dirPath) => isSyncableVaultPath(dirPath) && !policy.ignores(dirPath, true));
    const residualTombstoneDirectories = new Set();
    for (const intent of directoryIntents.filter((entry) => entry.op === "delete").sort((left, right) => right.path.length - left.path.length)) {
      if (localOnlyPaths.some((retained) => retained === intent.path || retained.startsWith(`${intent.path}/`))) continue;
      const replacedDirectories = await this.pruneEmptyDirectoryTree(
        intent.path,
        preApplyDirectories,
        preApplyDirectoryCtimes,
        removableDirectories
      );
      if (await this.adapterIsDirectoryStrict(intent.path)) {
        let residual;
        try {
          residual = await this.listLocalVaultInventory(intent.path);
        } catch (error) {
          if (error instanceof ObtsBlockedError) throw error;
          throw new ObtsBlockedError("directory_inspection_failed", "A directory tree could not be inspected safely.");
        }
        for (const dirPath of [intent.path, ...residual.directories]) {
          if (preApplyDirectories.has(dirPath) && !replacedDirectories.has(dirPath)) {
            residualTombstoneDirectories.add(dirPath);
          }
        }
      }
    }
    for (const dirPath of Array.from(new Set(explicitDirectories)).sort((left, right) => left.length - right.length)) {
      await this.ensureAdapterDirectory(dirPath);
    }
    return residualTombstoneDirectories;
  }

  async pruneEmptyDirectoryTree(filePath, preApplyDirectories, preApplyDirectoryCtimes, removableDirectories = preApplyDirectories) {
    const replacedDirectories = new Set();
    if (!(await this.adapterIsDirectoryStrict(filePath))) return replacedDirectories;
    let inventory;
    try {
      inventory = await this.listLocalVaultInventory(filePath);
    } catch (error) {
      if (error instanceof ObtsBlockedError) throw error;
      throw new ObtsBlockedError("directory_inspection_failed", "A directory tree could not be inspected safely.");
    }
    const directories = [filePath, ...inventory.directories]
      .filter((dirPath) => preApplyDirectories.has(dirPath) && removableDirectories.has(dirPath))
      .sort(compareDeepestPathFirst);
    for (const dirPath of directories) {
      const outcome = await this.adapterRemovePreexistingEmptyDirectory(
        dirPath,
        preApplyDirectoryCtimes[dirPath]
      );
      if (outcome === "replaced") replacedDirectories.add(dirPath);
    }
    return replacedDirectories;
  }

  async readDeviceToken() {
    const tokenFile = await readJson(this.fsp, this.authPath, {});
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

  async ensureAdapterDirectory(dir) {
    await ensureAdapterDir(this.adapter, dir, this.pathMutationGate);
  }

  async adapterWriteBinary(filePath, content) {
    await this.ensureAdapterDirectory(path.posix.dirname(filePath));
    return this.pathMutationGate.withExclusive([filePath], (raw) => raw.writeBinary(filePath, toArrayBuffer(content)));
  }

  async adapterModifyBinaryRevalidated(filePath, content, journal) {
    const arrayBuffer = toArrayBuffer(content);
    return this.pathMutationGate.withExclusive([filePath], async (raw) => {
      const current = (await this.readRecoveryFileSnapshot(filePath, undefined, raw)).fingerprint;
      if (current.kind !== "file" || !this.fingerprintMatchesPreflight(
        current, journal.preflight_sha256[filePath] || null, journal.preflight_fingerprints?.[filePath]
      )) throw new LocalSnapshotChangedError(filePath);
      await raw.writeBinary(filePath, arrayBuffer);
    });
  }

  async adapterWriteBinaryExclusive(filePath, content) {
    await this.ensureAdapterDirectory(path.posix.dirname(filePath));
    const arrayBuffer = toArrayBuffer(content);
    return this.pathMutationGate.withExclusive([filePath], async (raw) => {
      const current = (await this.readRecoveryFileSnapshot(filePath, undefined, raw)).fingerprint;
      if (current.kind !== "missing") throw new LocalSnapshotChangedError(filePath);
      try {
        // Native wx additionally protects against external filesystem creators.
        // Hosts without it have same-adapter exclusion, not filesystem CAS.
        if (raw.writeBinaryExclusive) await raw.writeBinaryExclusive(filePath, arrayBuffer);
        else await raw.writeBinary(filePath, arrayBuffer);
      } catch (error) {
        if (error && (error.code === "EEXIST" || error.code === "EISDIR")) {
          throw new LocalSnapshotChangedError(filePath, error);
        }
        throw error;
      }
    });
  }

  async adapterRemove(filePath, raw) {
    const stat = await raw.stat(filePath);
    if (!stat) return;
    if (stat.type === "folder" && raw.rmdir) await raw.rmdir(filePath, true);
    else await raw.remove(filePath);
  }

  async captureDirectoryCreationTimes(directories, onProgress = undefined) {
    if (onProgress) onProgress(0, directories.length);
    const values = await runBoundedWork(directories, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress
    }, async (dirPath) => await this.adapterDirectoryCreationTime(dirPath));
    return Object.fromEntries(directories.map((dirPath, index) => [dirPath, values[index]]));
  }

  async adapterDirectoryCreationTime(filePath, adapter = this.adapter) {
    if (typeof adapter.stat !== "function") return null;
    try {
      const stat = await adapter.stat(filePath);
      const ctime = Number(stat && stat.type === "folder" ? stat.ctime : NaN);
      return Number.isFinite(ctime) && ctime > 0 ? ctime : null;
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      throw new ObtsBlockedError("directory_inspection_failed", "A directory could not be inspected safely.");
    }
  }

  async adapterIsDirectoryStrict(filePath, adapter = this.adapter) {
    if (!filePath || filePath === ".") return true;
    try {
      const stat = typeof adapter.stat === "function" ? await adapter.stat(filePath) : null;
      if (stat) return stat.type === "folder";
      if (typeof adapter.stat === "function") return false;
      await adapter.list(filePath);
      return true;
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
      throw new ObtsBlockedError("directory_inspection_failed", "A directory could not be inspected safely.");
    }
  }

  async adapterDirectoryIsEmptyStrict(filePath, adapter = this.adapter) {
    try {
      const listing = await adapter.list(filePath);
      return (listing.files || []).length === 0 && (listing.folders || []).length === 0;
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
      throw new ObtsBlockedError("directory_inspection_failed", "A directory could not be inspected safely.");
    }
  }

  async adapterRemovePreexistingEmptyDirectory(filePath, expectedCtime) {
    return this.pathMutationGate.withExclusive([filePath], async (raw) => {
      if (typeof raw.rmdir !== "function") {
        throw new ObtsBlockedError("directory_delete_failed", "The vault adapter cannot safely remove an empty directory.");
      }
      if (!(await this.adapterIsDirectoryStrict(filePath, raw))) return "missing";
      if (!(typeof expectedCtime === "number" && Number.isFinite(expectedCtime) && expectedCtime > 0)) {
        throw new ObtsBlockedError("directory_identity_unavailable", "A directory identity could not be verified before deletion.");
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentCtime = await this.adapterDirectoryCreationTime(filePath, raw);
        if (currentCtime === null) {
          if (!(await this.adapterIsDirectoryStrict(filePath, raw))) return "missing";
          throw new ObtsBlockedError("directory_identity_unavailable", "A directory identity could not be verified before deletion.");
        }
        if (currentCtime !== expectedCtime) return "replaced";
        if (!(await this.adapterDirectoryIsEmptyStrict(filePath, raw))) return "nonempty";
        const verifiedCtime = await this.adapterDirectoryCreationTime(filePath, raw);
        if (verifiedCtime === null) {
          if (!(await this.adapterIsDirectoryStrict(filePath, raw))) return "missing";
          throw new ObtsBlockedError("directory_identity_unavailable", "A directory identity could not be verified before deletion.");
        }
        if (verifiedCtime !== expectedCtime) return "replaced";
        try {
          // The non-recursive filesystem operation performs the final emptiness check atomically.
          await raw.rmdir(filePath, false);
          return "removed";
        } catch {
          if (!(await this.adapterIsDirectoryStrict(filePath, raw))) return "removed";
          if (!(await this.adapterDirectoryIsEmptyStrict(filePath, raw))) return "nonempty";
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      throw new ObtsBlockedError("directory_delete_failed", "An empty directory could not be removed safely.");
    });
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

  async adapterDirectoryIsEmpty(filePath) {
    try {
      const listing = await this.adapter.list(filePath);
      return (listing.files || []).length === 0 && (listing.folders || []).length === 0;
    } catch {
      return false;
    }
  }

  async listLocalVaultFiles() {
    return (await this.listLocalVaultInventory("")).files;
  }

  async listLocalVaultDirectories() {
    const policy = (await this.readRootIgnorePolicy()).policy;
    return (await this.listLocalVaultInventory("", policy, true)).directories;
  }

  async listLocalDescendantFiles(filePath) {
    if (!(await this.adapterIsDirectory(filePath))) return [];
    return (await this.listLocalVaultInventory(filePath)).files;
  }

  async listLocalVaultInventory(root, policy = null, skipIgnoredDirectories = false, onProgress = undefined) {
    const files = [];
    const directories = [];
    let frontier = [root];
    while (frontier.length > 0) {
      const listings = await runBoundedWork(frontier, {
        concurrency: this.fileWorkConcurrency,
        yieldEvery: FILE_WORK_YIELD_EVERY
      }, async (dir) => await this.adapter.list(dir));
      const next = [];
      for (const listing of listings) {
        for (const folder of (listing.folders || []).slice().sort()) {
          const normalizedFolder = normalizePath(folder);
          if (normalizedFolder === ".obts" || normalizedFolder.startsWith(".obts/")) continue;
          assertValidLocalVaultPath(normalizedFolder);
          if (!isSyncableVaultPath(normalizedFolder)) continue;
          const ignoredDirectory = Boolean(policy && policy.ignores(normalizedFolder, true));
          if (!ignoredDirectory) directories.push(normalizedFolder);
          if (ignoredDirectory && skipIgnoredDirectories) continue;
          next.push(normalizedFolder);
        }
        for (const filePath of (listing.files || []).slice().sort()) {
          const normalizedFile = normalizePath(filePath);
          if (normalizedFile === ".obts" || normalizedFile.startsWith(".obts/")) continue;
          assertValidLocalVaultPath(normalizedFile);
          if (!policy || !policy.ignores(normalizedFile)) files.push(normalizedFile);
        }
      }
      frontier = Array.from(new Set(next)).sort();
      if (onProgress) onProgress(files.length, directories.length);
    }
    return { files: Array.from(new Set(files)).sort(), directories: Array.from(new Set(directories)).sort() };
  }

  async displaceApplyPath(journal, filePath, assertCurrentPreflight, assertRecoveredDescendants, retainTargetFile = false) {
    if ((journal.local_only_paths || []).some((retained) =>
      retained === filePath || retained.startsWith(`${filePath}/`) || filePath.startsWith(`${retained}/`))) {
      throw new ObtsBlockedError("local_only_collision", "A write collides with retained local-only content.");
    }
    for (const candidate of [...directoryPrefixes(filePath), filePath]) {
      if (!(await this.adapterExists(candidate))) {
        if (await this.applyDisplacedEntryExists(journal, candidate)) continue;
        continue;
      }
      if (
        await this.adapterIsDirectory(candidate) &&
        await this.applyDisplacedEntryExists(journal, candidate) &&
        (
          candidate !== filePath ||
          journal.preflight_fingerprints?.[candidate]?.kind !== "directory"
        )
      ) continue;
      if (!Object.hasOwn(journal.preflight_sha256, candidate)) {
        if (await this.adapterIsDirectory(candidate)) continue;
        throw new LocalSnapshotChangedError(candidate);
      }
      const current = await assertCurrentPreflight(candidate);
      const displacedDirectory = current.kind === "directory";
      const retainLiveFile = retainTargetFile && candidate === filePath && current.kind === "file";
      if (displacedDirectory) await assertRecoveredDescendants(candidate);
      const displacedPath = this.applyDisplacedPath(journal, candidate);
      await this.ensureAdapterDirectory(path.posix.dirname(displacedPath));
      if (await this.adapterExists(displacedPath)) {
        // An earlier interrupted attempt already captured the evidence copy.
        // Only removals/type changes clear the live path; file updates retain
        // the same path and editor binding after validating the copy.
        if (!(await this.applyDisplacedEntryMatchesPreflight(journal, candidate))) {
          throw new LocalSnapshotChangedError(candidate);
        }
        await this.pathMutationGate.withExclusive([candidate], async (raw) => {
          await assertCurrentPreflight(candidate, raw);
          if (displacedDirectory) await assertRecoveredDescendants(candidate, raw);
          if (!retainLiveFile) await this.adapterRemove(candidate, raw);
        });
        if (retainLiveFile) return true;
        continue;
      }
      // Capture the evidence with a verified copy instead of a rename so that
      // vault-visible paths are never moved: renaming a live path makes Obsidian
      // re-bind already-open editor tabs to the hidden displaced path, which
      // redirects later editor saves into the hidden evidence file (or fails
      // with ENOENT once the evidence is archived).
      try {
        await this.captureDisplacedCandidate(candidate, displacedPath, displacedDirectory);
      } catch (error) {
        throw new LocalSnapshotChangedError(candidate, error);
      }
      if (!(await this.applyDisplacedEntryMatchesPreflight(journal, candidate))) {
        throw new LocalSnapshotChangedError(candidate);
      }
      await this.pathMutationGate.withExclusive([candidate], async (raw) => {
        await assertCurrentPreflight(candidate, raw);
        if (displacedDirectory) await assertRecoveredDescendants(candidate, raw);
        if (!retainLiveFile) await this.adapterRemove(candidate, raw);
      });
      if (retainLiveFile) return true;
    }
    return false;
  }

  async captureDisplacedCandidate(candidate, displacedPath, displacedDirectory) {
    if (displacedDirectory) {
      await this.copyDirectoryIntoDisplacedPath(candidate, displacedPath);
      return;
    }
    const snapshot = await this.readRecoveryFileSnapshot(candidate);
    if (snapshot.fingerprint.kind !== "file" || snapshot.content === null) {
      throw new LocalSnapshotChangedError(candidate);
    }
    await this.adapter.writeBinary(displacedPath, toArrayBuffer(snapshot.content));
  }

  async copyDirectoryIntoDisplacedPath(sourcePath, displacedPath) {
    await this.ensureAdapterDirectory(displacedPath);
    const frontier = [[sourcePath, displacedPath]];
    while (frontier.length > 0) {
      const [source, destination] = frontier.shift();
      const listing = await this.adapter.list(source);
      for (const folder of listing.folders || []) {
        const childDestination = `${destination}/${path.posix.basename(folder)}`;
        await this.ensureAdapterDirectory(childDestination);
        frontier.push([folder, childDestination]);
      }
      for (const file of listing.files || []) {
        const content = await this.adapterReadBinary(file);
        if (content === null) throw new LocalSnapshotChangedError(file);
        await this.adapter.writeBinary(`${destination}/${path.posix.basename(file)}`, toArrayBuffer(content));
      }
    }
  }

  applyDisplacedPath(journal, filePath) {
    return path.posix.join(".obts", "apply-displaced", journal.apply_id, `${encodeURIComponent(filePath)}.entry`);
  }

  applyDisplacedEntryExists(journal, filePath) {
    if (!journal || typeof journal.apply_id !== "string") return false;
    return this.adapterExists(this.applyDisplacedPath(journal, filePath));
  }

  async applyDisplacedEntryMatchesPreflight(journal, filePath) {
    if (!journal || typeof journal.apply_id !== "string") return false;
    const displacedPath = this.applyDisplacedPath(journal, filePath);
    const displaced = (await this.readRecoveryFileSnapshot(displacedPath)).fingerprint;
    const expected = journal.preflight_fingerprints?.[filePath];
    if (!this.fingerprintMatchesPreflight(displaced, journal.preflight_sha256[filePath] || null, expected)) {
      return false;
    }
    if (displaced.kind !== "directory") return true;

    const inventory = await this.listAdapterInventory(displacedPath);
    const prefix = `${filePath}/`;
    const expectedFiles = Object.keys(journal.preflight_sha256)
      .filter((candidate) => candidate.startsWith(prefix) && journal.preflight_sha256[candidate] !== null)
      .sort();
    const expectedDirectories = Array.isArray(journal.pre_apply_directories)
      ? journal.pre_apply_directories.filter((candidate) => candidate.startsWith(prefix)).sort()
      : [];
    const actualFiles = inventory.files.map((candidate) => `${filePath}/${candidate}`).sort();
    const actualDirectories = inventory.directories.map((candidate) => `${filePath}/${candidate}`).sort();
    if (!sameStringArray(actualFiles, expectedFiles)) return false;
    if (journal.journal_version >= 3 && !sameStringArray(actualDirectories, expectedDirectories)) return false;
    for (const candidate of actualFiles) {
      const relative = candidate.slice(prefix.length);
      const fingerprint = (await this.readRecoveryFileSnapshot(`${displacedPath}/${relative}`)).fingerprint;
      if (!this.fingerprintMatchesPreflight(
        fingerprint,
        journal.preflight_sha256[candidate] || null,
        journal.preflight_fingerprints?.[candidate]
      )) return false;
    }
    return true;
  }

  async listAdapterInventory(root, adapter = this.adapter) {
    const files = [];
    const directories = [];
    let frontier = [root];
    while (frontier.length > 0) {
      const current = frontier.shift();
      const listing = await adapter.list(current);
      for (const filePath of listing.files || []) files.push(filePath.slice(root.length + 1));
      for (const dirPath of listing.folders || []) {
        directories.push(dirPath.slice(root.length + 1));
        frontier.push(dirPath);
      }
    }
    return { files: files.sort(), directories: directories.sort() };
  }

  async removeBlockingMaterializationPaths(filePath, matchesExpected, onRemoved) {
    for (const prefix of directoryPrefixes(filePath)) {
      const safe = await this.pathMutationGate.withExclusive([prefix], async (raw) => {
        const current = (await this.readRecoveryFileSnapshot(prefix, undefined, raw)).fingerprint;
        if (current.kind === "missing" || current.kind === "directory") return true;
        if (!(await matchesExpected(prefix, raw))) return false;
        await this.adapterRemove(prefix, raw);
        onRemoved(prefix);
        return true;
      });
      if (!safe) return false;
    }
    return true;
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
    if (state.last_error_code === "directory_recovery_decision_required" || state.last_error_code === "directory_recovery_changed") {
      throw new ObtsBlockedError(state.last_error_code, "Automatic directory recovery will retry after the plugin reloads.");
    }
    if (state.last_error_code === "directory_recovery_journal_invalid") {
      throw new ObtsBlockedError(state.last_error_code, "The directory recovery journal is invalid and must be preserved for recovery support.");
    }
    if (state.last_error_code === "same_device_non_fast_forward" || state.last_error_code === "stale_device_ref" || state.last_error_code === "device_blocked" || state.last_error_code === "server_recovery_required" || state.last_error_code === "local_state_incomplete") {
      throw new ObtsBlockedError(state.last_error_code, "Device sync is blocked until recovery completes.");
    }
  }

  async block(code, message, details = undefined) {
    await this.markBlocked(code, details);
    throw new ObtsBlockedError(code, message, details);
  }

  async markBlocked(code, details = undefined) {
    await this.writeState(Object.assign({}, await this.readState(), {
      status_label: blockStatusLabel(code, details),
      last_error_code: code,
      last_error_details: details || null,
      updated_at: nowIso()
    }));
    await this.reportDeviceStatus().catch(() => undefined);
  }
}

class ObtsOnboardingModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.cancelled = false;
    this.connection = null;
    this.analysis = null;
    this.mode = null;
    this.earlyDisposition = null;
    this.browserReturnAbortController = null;
    this.replaceProgressTimer = null;
    this.replaceProgressEl = null;
    this.replaceLastLabel = null;
    this.onboardingRunning = false;
    this.onboardingPaused = false;
    this.resumeVisibilityHandler = null;
    this.resumeRetryTimer = null;
  }

  async onOpen() {
    this.contentEl.addClass("obts-onboarding");
    let pending;
    try { pending = await this.plugin.client.readPendingOnboarding(); }
    catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("h2", { text: "Setup recovery required" });
      this.contentEl.createEl("p", { text: error instanceof Error ? error.message : "Preserve the setup journal and restore its original credential before resuming." });
      new Setting(this.contentEl).addButton(button => button.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    if (!pending) {
      this.renderStart();
      return;
    }
    this.connection = Object.assign({}, pending.journal.connection, { connection_secret: pending.secret });
    this.analysis = pending.journal.analysis || null;
    this.mode = pending.journal.selected_mode || null;
    this.earlyDisposition = pending.journal.early_disposition || null;
    const state = await this.plugin.client.readState();
    if (pending.journal.last_error_code === "connection_expired" || pending.journal.last_error_code === "connection_denied") {
      this.renderTerminalConnection(pending.journal.last_error_code === "connection_expired" ? "expired" : "denied");
      return;
    }
    const registeredState = Boolean(state.vault_id && state.device_id);
    if (pending.journal.last_error_code === "onboarding_disposition_mismatch") {
      this.renderIntentMismatch(true);
      return;
    }
    const postRegistrationStage = ["registering", "applying_uploading", "uploading_proposal", "awaiting_conflict"].includes(pending.journal.stage) ||
      (pending.journal.stage === "blocked" && Boolean(this.mode));
    const resumableSubmission = Boolean(
      (this.analysis || postRegistrationStage) && this.mode &&
        (registeredState || postRegistrationStage)
    );
    if (resumableSubmission) {
      if (pending.journal.stage === "awaiting_conflict") this.renderConflictReview();
      else this.renderResume();
      return;
    }
    if (this.analysis && !["awaiting_browser", "approved", "analyzing", "registering", "applying_uploading", "uploading_proposal", "awaiting_conflict"].includes(pending.journal.stage)) {
      if (this.earlyDisposition === "use_server" && this.analysis.classification === "use_server_direct" && !this.mode) {
        this.renderReplaceConfirmation(this.analysis);
        return;
      }
      this.renderConfirmation();
      return;
    }
    this.renderWaiting();
    void this.pollUntilApproved().catch((error) => this.showWaitingError(error, "Unable to resume setup."));
  }

  onClose() {
    this.cancelled = true;
    if (this.browserReturnAbortController) this.browserReturnAbortController.abort();
    this.browserReturnAbortController = null;
    this.clearOnboardingResume();
    this.stopReplaceProgress();
    this.contentEl.empty();
  }

  async waitForBrowserReturn() {
    if (this.browserReturnAbortController) this.browserReturnAbortController.abort();
    const controller = new AbortController();
    this.browserReturnAbortController = controller;
    const returned = await waitForMobileBrowserReturn([
      controller.signal,
      this.plugin.lifecycleAbortController.signal
    ]);
    if (this.browserReturnAbortController === controller) this.browserReturnAbortController = null;
    return returned && !this.cancelled && !this.plugin.unloaded;
  }

  renderStart() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("obts-onboarding");
    contentEl.createEl("h2", { text: "Set up Obsidian True Sync" });
    contentEl.createEl("p", { text: "OBTS will open your server in a browser so you can authenticate and choose a vault." });
    const summary = contentEl.createDiv({ cls: "obts-onboarding-summary" });
    summary.createEl("strong", { text: this.plugin.app.vault.getName() });
    summary.createEl("span", { text: this.plugin.settings.serverUrl });
    new Setting(contentEl)
      .setName("Device name")
      .setDesc("This name appears in the server dashboard and conflict history.")
      .addText((text) => {
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          try {
            await this.plugin.runExclusiveAction(async () => {
              this.plugin.settings.deviceName = value.trim();
              await this.plugin.saveSettings();
            }, "Updating device name");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to update the device name.");
          }
        });
        if (text.inputEl) text.inputEl.maxLength = 80;
      });
    new Setting(contentEl)
      .setName("Vault contents")
      .setDesc("What should happen to this vault's local files when setup connects to an existing server vault? You can still confirm or change this after browser approval.")
      .addDropdown((dropdown) => dropdown
        .addOption("keep", "Keep local contents (classify and choose after approval)")
        .addOption("use_server", "Replace local contents from the selected server vault")
        .setValue(this.earlyDisposition === "use_server" ? "use_server" : "keep")
        .onChange((value) => {
          this.earlyDisposition = value === "use_server" ? "use_server" : null;
        }));
    new Setting(contentEl)
      .setName("Share sanitized troubleshooting diagnostics")
      .setDesc(diagnosticSharingDescription(this.plugin.settings.serverUrl))
      .addToggle((toggle) => toggle.setValue(this.plugin.diagnosticSharingEnabled()).onChange(async (value) => {
        try {
          await this.plugin.setDiagnosticSharing(value);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to update diagnostic sharing.");
          this.renderStart();
        }
      }));
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Continue in browser").setCta().onClick(async () => {
        if (!this.plugin.settings.deviceName.trim()) {
          setFeedback(feedback, "Enter a device name first.", "error");
          return;
        }
        button.setDisabled(true);
        setFeedback(feedback, "Scanning the local vault...", "muted");
        try {
          this.connection = await this.plugin.runExclusiveAction(
          () => this.plugin.client.startOnboarding(this.plugin.app.vault.getName(), this.earlyDisposition),
          "Starting sync setup"
        );
          if (this.cancelled || this.plugin.unloaded) return;
          window.open(this.connection.authorization_url);
          this.renderWaiting();
          if (!(await this.waitForBrowserReturn())) return;
          await this.pollUntilApproved();
        } catch (error) {
          if (this.cancelled || this.plugin.unloaded) return;
          button.setDisabled(false);
          this.showWaitingError(error, "Unable to start setup.");
        }
      }));
  }

  renderWaiting() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Approve in your browser" });
    contentEl.createEl("p", { text: "Sign in to the OBTS server, choose or create a vault, and approve this device." });
    const code = contentEl.createDiv({ cls: "obts-verification-code" });
    code.createEl("span", { text: "Verification code" });
    code.createEl("strong", { text: this.connection.verification_code });
    const feedback = contentEl.createDiv({ cls: "obts-feedback obts-feedback--muted", text: "Waiting for approval...", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(async () => {
        button.setDisabled(true);
        await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
        this.close();
      }))
      .addButton((button) => button.setButtonText("Reopen browser").onClick(() => window.open(this.connection.authorization_url)));
    this.waitingFeedback = feedback;
  }

  showWaitingError(error, fallback) {
    if (this.cancelled || this.plugin.unloaded) return;
    void this.plugin.reportOnboardingError(error, this.connection);
    const message = error instanceof Error ? error.message : fallback;
    if (this.waitingFeedback) setFeedback(this.waitingFeedback, message, "error");
    else new Notice(`obts: ${message}`, 15000);
  }

  renderTerminalConnection(status) {
    const { contentEl } = this;
    const expired = status === "expired";
    contentEl.empty();
    contentEl.createEl("h2", { text: expired ? "Setup approval expired" : "Setup was denied" });
    contentEl.createEl("p", {
      text: expired
        ? "This approval window ended before device registration. Restart setup to create one fresh request; no device or transfer was created."
        : "This connection was denied before device registration. Restart setup when you are ready to approve this device."
    });
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Restart setup").setCta().onClick(async () => {
        button.setDisabled(true);
        setFeedback(feedback, "Clearing the expired setup request...", "muted");
        try {
          await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
          this.connection = null;
          this.analysis = null;
          this.mode = null;
          this.renderStart();
        } catch (error) {
          button.setDisabled(false);
          setFeedback(feedback, error instanceof Error ? error.message : "Unable to restart setup.", "error");
        }
      }));
  }

  async pollUntilApproved() {
    while (!this.cancelled && this.connection) {
      const status = await this.plugin.runExclusiveAction(() => this.plugin.client.pollOnboarding(
        this.connection.connection_id,
        this.connection.connection_secret
      ), "Checking sync setup approval");
      if (this.cancelled || this.plugin.unloaded) return;
      if (status.status === "approved") {
        if (this.earlyDisposition === "use_server") {
          if (this.waitingFeedback) setFeedback(this.waitingFeedback, "Approved. Determining the replacement scope...", "success");
          await this.renderAfterApprovedReplacement(status);
          return;
        }
        if (this.waitingFeedback) setFeedback(this.waitingFeedback, "Approved. Checking the local vault...", "success");
        this.analysis = await this.plugin.runExclusiveAction(() => this.plugin.client.analyzeOnboarding(
          this.connection.connection_id,
          this.connection.connection_secret
        ), "Comparing local and server vaults");
        if (this.cancelled || this.plugin.unloaded) return;
        this.renderConfirmation();
        return;
      }
      if (status.status === "consumed") {
        const pending = await this.plugin.client.readPendingOnboarding();
        this.mode = pending?.journal.selected_mode || null;
        this.renderResume();
        return;
      }
      if (status.status === "denied" || status.status === "expired") {
        this.renderTerminalConnection(status.status);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, this.connection.poll_interval_ms || 2000));
    }
  }

  async renderAfterApprovedReplacement(status) {
    if (status.selection === "new_vault" || !(status.vault_id && status.vault_name && status.expected_main)) {
      await this.plugin.runExclusiveAction(() => this.plugin.client.updateOnboardingStage(this.connection.connection_id, "blocked", null, "onboarding_disposition_mismatch"));
      this.renderIntentMismatch(!status.selection || status.selection === "new_vault");
      return;
    }
    this.analysis = await this.plugin.runExclusiveAction(() => this.plugin.client.prepareReplacementOnboarding(
      this.connection.connection_id, this.connection.connection_secret
    ), "Saving approved replacement context");
    this.renderReplaceConfirmation(this.analysis);
  }

  renderIntentMismatch(browserSelectedNewVault) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Replacement needs an existing server vault" });
    contentEl.createEl("p", {
      text: browserSelectedNewVault
        ? "The browser created or selected a new vault, but this device was set up to replace its contents from an existing one. Nothing was uploaded, downloaded, or deleted. Restart setup to choose a different disposition."
        : "Setup was interrupted before the approved vault could be recorded. Nothing was uploaded, downloaded, or deleted. Restart setup to continue."
    });
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Restart setup").setCta().onClick(async () => {
        button.setDisabled(true);
        setFeedback(feedback, "Clearing the unused setup request...", "muted");
        try {
          await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
          this.connection = null;
          this.analysis = null;
          this.mode = null;
          this.earlyDisposition = null;
          this.renderStart();
        } catch (error) {
          button.setDisabled(false);
          setFeedback(feedback, error instanceof Error ? error.message : "Unable to restart setup.", "error");
        }
      }));
  }

  renderReplaceConfirmation(analysis) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Replace this vault's contents from ${analysis.vaultName}?` });
    contentEl.createEl("p", {
      text: "Syncable local files will be replaced by the server vault. Existing syncable files remain recoverable: obts creates a recovery bundle before replacing anything. Sync starts after the server contents are installed."
    });
    const summary = contentEl.createDiv({ cls: "obts-onboarding-summary" });
    summary.createEl("strong", { text: analysis.vaultName });
    summary.createEl("span", {
      text: `${analysis.localFileCount.toLocaleString()} syncable local files · ${formatBytes(analysis.localBytes)}`
    });
    const progress = contentEl.createEl("progress", { cls: "obts-onboarding-progress" });
    progress.setAttribute("hidden", "");
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(async () => {
        button.setDisabled(true);
        await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
        this.close();
      }))
      .addButton((button) => button.setButtonText("Replace local contents").setCta().onClick(() => {
        void this.runOnboardingCompletion(button, feedback, progress, {
          mode: "use_server",
          resumeLabel: "Resume replacing"
        });
      }));
  }

  async runOnboardingCompletion(button, feedback, progressEl, options = {}) {
    if (this.cancelled || this.plugin.unloaded || this.onboardingRunning) return;
    this.onboardingRunning = true;
    this.onboardingPaused = false;
    this.foregroundWhileRunning = false;
    this.armOnboardingResume(button, feedback, progressEl, options);
    button.setDisabled(true);
    this.startReplaceProgress(progressEl, feedback);
    let result = null;
    try {
      result = await this.plugin.runOnboardingAction(() => this.plugin.client.finishOnboarding(
        this.connection.connection_id,
        this.connection.connection_secret,
        this.analysis,
        options.mode || this.mode
      ));
    } catch (error) {
      this.stopReplaceProgress();
      this.onboardingRunning = false;
      if (this.cancelled || this.plugin.unloaded) return;
      void this.plugin.reportOnboardingError(error, this.connection);
      if (isOfflineTransportError(error) || isRetryableServerError(error)) {
        button.setDisabled(false);
        button.setButtonText(options.resumeLabel || "Resume setup");
        this.onboardingPaused = true;
        setFeedback(
          feedback,
          "Transfer paused — iOS suspends network transfers when Obsidian leaves the foreground or the screen locks. Downloaded progress is saved: it resumes automatically when you return, or tap the button below.",
          "warning"
        );
        if (this.foregroundWhileRunning) this.resumeVisibilityHandler();
        return;
      }
      this.clearOnboardingResume();
      button.setDisabled(false);
      setFeedback(feedback, error instanceof Error ? error.message : "Setup failed.", "error");
      if (error?.code === "onboarding_snapshot_changed") this.addConsentReview(feedback);
      return;
    }
    this.stopReplaceProgress();
    this.clearOnboardingResume();
    try {
      if (this.cancelled || this.plugin.unloaded) return;
      this.plugin.setStatus((await this.plugin.client.readState()).status_label);
      if (!this.cancelled && !this.plugin.unloaded) this.renderResult(result);
    } finally {
      this.onboardingRunning = false;
    }
  }

  startReplaceProgress(progressEl, feedback) {
    this.stopReplaceProgress();
    this.replaceProgressEl = progressEl;
    if (progressEl) progressEl.removeAttribute("hidden");
    const update = () => {
      if (this.cancelled || this.plugin.unloaded) return;
      const label = this.plugin.activeOperationProgressLabel || this.plugin.currentStatusLabel || "Connecting";
      if (progressEl) {
        const match = /(\d+)\s*\/\s*(\d+)/u.exec(label);
        if (match && Number(match[2]) > 0) {
          progressEl.value = Number(match[1]);
          progressEl.max = Number(match[2]);
        } else {
          progressEl.removeAttribute("value");
          progressEl.removeAttribute("max");
        }
      }
      if (this.replaceLastLabel !== label) {
        this.replaceLastLabel = label;
        if (feedback) setFeedback(feedback, `obts: ${label}`, "muted");
      }
    };
    update();
    this.replaceProgressTimer = window.setInterval(update, 500);
  }

  stopReplaceProgress() {
    if (this.replaceProgressTimer !== null) {
      window.clearInterval(this.replaceProgressTimer);
      this.replaceProgressTimer = null;
    }
    if (this.replaceProgressEl && typeof this.replaceProgressEl.setAttribute === "function") {
      this.replaceProgressEl.setAttribute("hidden", "");
    }
    this.replaceLastLabel = null;
  }

  armOnboardingResume(button, feedback, progressEl, options = {}) {
    this.clearOnboardingResume();
    this.resumeVisibilityHandler = () => {
      if (document.hidden || this.cancelled || this.plugin.unloaded || globalThis.navigator?.onLine === false) return;
      if (this.onboardingRunning) { this.foregroundWhileRunning = true; return; }
      if (!this.onboardingPaused || this.resumeRetryTimer !== null) return;
      this.resumeRetryTimer = window.setTimeout(() => {
        this.resumeRetryTimer = null;
        if (document.hidden || this.cancelled || this.plugin.unloaded || globalThis.navigator?.onLine === false || !this.onboardingPaused) return;
        if (button) button.setButtonText(options.resumeLabel || "Resume setup");
        void this.runOnboardingCompletion(button, feedback, progressEl, options);
      }, 1200);
    };
    document.addEventListener("visibilitychange", this.resumeVisibilityHandler);
    window.addEventListener("online", this.resumeVisibilityHandler);
  }

  clearOnboardingResume() {
    if (this.resumeVisibilityHandler) {
      document.removeEventListener("visibilitychange", this.resumeVisibilityHandler);
      window.removeEventListener("online", this.resumeVisibilityHandler);
      this.resumeVisibilityHandler = null;
    }
    if (this.resumeRetryTimer !== null) {
      window.clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = null;
    }
  }

  renderConfirmation() {
    const { contentEl } = this;
    const analysis = this.analysis;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Connect to ${analysis.vaultName}` });
    contentEl.createEl("p", { text: `${analysis.localFileCount.toLocaleString()} syncable files · ${formatBytes(analysis.localBytes)}` });
    const divergent = analysis.classification === "shared_baseline_divergent" || analysis.classification === "independent_divergent";
    if (divergent) {
      contentEl.createEl("p", {
        cls: "obts-onboarding-warning",
        text: "The local and server vaults differ. Choose whether to replace local syncable content or submit it for merge. A merge may require conflict review in the dashboard."
      });
      if (this.mode !== "merge") this.mode = "use_server";
      new Setting(contentEl)
        .setName("Use the server vault")
        .setDesc("Create a recovery bundle, then replace local syncable content with server main.")
        .addToggle((toggle) => toggle.setValue(this.mode === "use_server").onChange((value) => {
          if (value) {
            this.mode = "use_server";
            this.renderConfirmation();
          }
        }));
      new Setting(contentEl)
        .setName("Merge local content")
        .setDesc("Preserve disjoint local and remote paths; overlapping changes may need dashboard review.")
        .addToggle((toggle) => toggle.setValue(this.mode === "merge").onChange((value) => {
          if (value) {
            this.mode = "merge";
            this.renderConfirmation();
          }
        }));
    } else if (analysis.classification === "new_with_content") {
      this.mode = "initialize";
      contentEl.createEl("p", { text: "This local vault will become the initial server state. A recovery bundle will be created before upload." });
    } else {
      this.mode = "use_server";
      const message = analysis.classification === "identical"
        ? "Local content already matches the server. OBTS will connect without changing visible files."
        : analysis.classification === "stale_baseline"
          ? "This is a clean older copy. OBTS will safely apply the newer server state."
          : "OBTS will create a recovery bundle and apply the selected server vault locally.";
      contentEl.createEl("p", { text: message });
    }
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    const actionLabel = this.mode === "initialize" ? "Create vault and upload" : this.mode === "merge" ? "Submit for merge" : "Use server vault";
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(async () => {
        button.setDisabled(true);
        await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
        this.close();
      }))
      .addButton((button) => button.setButtonText(actionLabel).setCta().onClick(() =>
        this.runOnboardingCompletion(button, feedback, null, { resumeLabel: "Resume setup" })
      ));
  }

  addConsentReview(feedback) {
    new Setting(this.contentEl).addButton(button => button.setButtonText("Review changed local contents").onClick(async () => {
      button.setDisabled(true);
      try {
        const review = await this.plugin.runExclusiveAction(() => this.plugin.client.reviewOnboardingConsent());
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Review changed local contents" });
        this.contentEl.createEl("p", { text: `${review.file_count.toLocaleString()} syncable files · ${formatBytes(review.bytes)}` });
        this.contentEl.createEl("p", { text: `Keep the original ${review.mode} choice and approved vault. Local contents will be saved in a recovery bundle before continuing.` });
        const status = this.contentEl.createDiv({ cls: "obts-feedback" });
        new Setting(this.contentEl)
          .addButton(close => close.setButtonText("Close").onClick(() => this.close()))
          .addButton(confirm => confirm.setButtonText("Confirm updated consent").setCta().onClick(async () => {
            confirm.setDisabled(true);
            try {
              this.analysis = await this.plugin.runExclusiveAction(() => this.plugin.client.reviewOnboardingConsent(review));
              this.mode = review.mode;
              await this.runOnboardingCompletion(confirm, status, null);
            } catch (error) {
              confirm.setDisabled(false);
              setFeedback(status, error instanceof Error ? error.message : "Unable to confirm consent.", "error");
            }
          }));
      } catch (error) {
        button.setDisabled(false);
        setFeedback(feedback, error instanceof Error ? error.message : "Unable to review consent.", "error");
      }
    }));
  }

  renderResume() {
    const { contentEl } = this;
    this.onboardingPaused = false;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Finish sync setup" });
    contentEl.createEl("p", {
      text: "This setup submission started but did not finish. Resume from the durable journal and server state; obts will not submit the local vault a second time."
    });
    const progress = contentEl.createEl("progress", { cls: "obts-onboarding-progress" });
    progress.setAttribute("hidden", "");
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Resume setup").setCta().onClick(() => {
        void this.runOnboardingCompletion(button, feedback, progress, { resumeLabel: "Resume setup" });
      }));
  }

  renderConflictReview() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve the conflict, then return here" });
    contentEl.createEl("p", {
      text: "Your local vault was submitted once and is safe. Resolve the conflict in the dashboard, return to Obsidian, then check the resolution. Do not submit the merge again."
    });
    const steps = contentEl.createEl("ol", { cls: "obts-onboarding-steps" });
    steps.createEl("li", { text: "Open the dashboard and resolve every conflict for this vault." });
    steps.createEl("li", { text: "Return to this screen in Obsidian." });
    steps.createEl("li", { text: "Tap Check resolution to apply the resolved server vault and finish setup." });
    const feedback = contentEl.createDiv({
      cls: "obts-feedback obts-feedback--muted",
      text: "Waiting for dashboard conflict resolution...",
      attr: { "aria-live": "polite" }
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Open dashboard").onClick(async () => {
        window.open(`${this.plugin.settings.serverUrl.replace(/\/+$/u, "")}/dashboard`);
        setFeedback(feedback, "Resolve the conflict in the dashboard, then return here...", "muted");
        if (!(await this.waitForBrowserReturn())) return;
        await this.checkConflictResolution(feedback, button);
      }))
      .addButton((button) => button.setButtonText("Check resolution").setCta().onClick(async () => {
        await this.checkConflictResolution(feedback, button);
      }));
  }

  async checkConflictResolution(feedback, button) {
    if (this.cancelled || this.plugin.unloaded) return;
    button.setDisabled(true);
    setFeedback(feedback, "Checking the dashboard resolution...", "muted");
    try {
      const result = await this.resumeRegisteredSetup();
      if (isConflictResultStatus(result.status)) {
        setFeedback(feedback, "The conflict is still awaiting resolution in the dashboard.", "muted");
        button.setDisabled(false);
        return;
      }
      this.renderResult(result);
    } catch (error) {
      if (this.cancelled || this.plugin.unloaded) return;
      void this.plugin.reportOnboardingError(error, this.connection);
      button.setDisabled(false);
      setFeedback(feedback, error instanceof Error ? error.message : "Unable to check the conflict resolution.", "error");
    }
  }

  async resumeRegisteredSetup() {
    if (this.cancelled || this.plugin.unloaded) {
      throw new ObtsBlockedError("operation_interrupted_by_reload", "Setup was interrupted by a plugin reload.");
    }
    const result = await this.plugin.runOnboardingAction(() => this.plugin.client.finishOnboarding(
      this.connection.connection_id,
      this.connection.connection_secret,
      this.analysis,
      this.mode
    ));
    this.plugin.setStatus((await this.plugin.client.readState()).status_label);
    return result;
  }

  renderResult(result) {
    if (isConflictResultStatus(result.status)) {
      this.renderConflictReview();
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sync is ready" });
    contentEl.createEl("p", { text: "This vault is connected. Sync runs while Obsidian is active." });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()))
      .addButton((button) => button.setDisabled(true).setButtonText("Synced"));
  }
}

class ObtsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.operationRefreshTimer = null;
  }

  clearOperationRefreshTimer() {
    if (this.operationRefreshTimer !== null) {
      window.clearInterval(this.operationRefreshTimer);
      this.operationRefreshTimer = null;
    }
  }

  hide() {
    this.clearOperationRefreshTimer();
  }

  async display() {
    this.clearOperationRefreshTimer();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian True Sync" });
    let availability = this.plugin.operationAvailability();
    if (!this.plugin.clientReady && availability === "available") {
      void this.plugin.initializeClient().catch((error) => this.plugin.handleClientInitializationFailure(error));
      availability = this.plugin.operationAvailability();
    }
    const clientUnavailable = !this.plugin.clientReady;
    let state = null;
    let pendingOnboarding = null;
    if (clientUnavailable) {
      try {
        state = await this.plugin.client.readPrimaryState() || await this.plugin.client.readBackupState();
      } catch {
        // The loading surface remains available even when local state cannot yet be read.
      }
    } else {
      [state, pendingOnboarding] = await Promise.all([
        this.plugin.client.readState(),
        this.plugin.client.readPendingOnboarding()
      ]);
    }
    const paired = Boolean(state && state.vault_id && state.device_id);
    const terminalOnboarding = pendingOnboarding && (
      pendingOnboarding.journal.last_error_code === "connection_expired" ||
      pendingOnboarding.journal.last_error_code === "connection_denied"
    );
    const awaitingOnboardingApproval = pendingOnboarding && pendingOnboarding.journal.stage === "awaiting_browser";
    const recoveryBlocked = Boolean(state && state.last_error_code === "local_state_incomplete");
    const restartRequired = availability === "restart_required";
    const initializationInProgress = clientUnavailable && Boolean(this.plugin.clientInitialization);
    const deviceName = this.plugin.settings.deviceName || state && state.device_name || "Obsidian device";

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          try {
            if (pendingOnboarding) {
              throw new ObtsBlockedError("onboarding_incomplete", "Finish or cancel onboarding before changing the server URL.");
            }
            await this.plugin.runExclusiveAction(() => this.plugin.updateServerUrl(value), "Updating server settings");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to update the server URL.");
            await this.display();
          }
        })
      );

    new Setting(containerEl)
      .setName("Share sanitized troubleshooting diagnostics")
      .setDesc(diagnosticSharingDescription(this.plugin.settings.serverUrl))
      .addToggle((toggle) => toggle.setValue(this.plugin.diagnosticSharingEnabled()).onChange(async (value) => {
        try {
          await this.plugin.setDiagnosticSharing(value);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to update diagnostic sharing.");
        }
        await this.display();
      }));
    new Setting(containerEl)
      .setName("Troubleshooting snapshot")
      .setDesc("Send the current sanitized sync-state classifications without waiting for another failure.")
      .addButton((button) => button
        .setButtonText("Send snapshot now")
        .setDisabled(!this.plugin.diagnosticSharingEnabled())
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.sendTroubleshootingSnapshotNow();
          } finally {
            button.setDisabled(!this.plugin.diagnosticSharingEnabled());
          }
        }));

    const sectionHeader = containerEl.createDiv({ cls: "obts-settings-section-header" });
    sectionHeader.createEl("h3", {
      text: paired
        ? "Device"
        : clientUnavailable
          ? restartRequired
            ? "Restart required"
            : initializationInProgress
              ? "Loading obts"
              : "Finishing update"
          : pendingOnboarding
          ? "Setup incomplete"
          : recoveryBlocked
            ? "Recovery required"
            : paired
              ? "Device"
              : "Connect Vault"
    });
    sectionHeader.createEl("span", {
      cls: paired && !pendingOnboarding && !clientUnavailable ? "obts-status-pill obts-status-pill--ok" : "obts-status-pill",
      text: clientUnavailable
        ? restartRequired
          ? "Restart Obsidian"
          : paired
            ? "Recovering"
            : initializationInProgress
              ? "Loading"
              : "Please wait"
        : terminalOnboarding
          ? "Restart setup"
          : awaitingOnboardingApproval
            ? "Continue approval"
          : pendingOnboarding
          ? "Resume setup"
          : recoveryBlocked
            ? "Needs recovery"
            : paired
              ? "Paired"
              : "Not paired"
    });
    if (clientUnavailable) {
      const statusSetting = new Setting(containerEl).setName("Status");
      const operationSetting = new Setting(containerEl).setName("Current operation");
      const refreshLoadingStatus = () => {
        if (this.plugin.clientReady) {
          this.clearOperationRefreshTimer();
          void this.display();
          return;
        }
        const currentAvailability = this.plugin.operationAvailability();
        const operation = this.plugin.operationDetails();
        const status = restartRequired || currentAvailability === "restart_required"
          ? "Restart required"
          : this.plugin.clientInitialization
            ? "Recovering local sync state"
            : this.plugin.currentStatusLabel || state && state.status_label || "Loading";
        statusSetting.setDesc(status);
        operationSetting.setDesc(this.plugin.operationDescription(operation));
      };
      if (paired) {
        new Setting(containerEl)
          .setName("Device")
          .setDesc(deviceName);
        new Setting(containerEl)
          .setName("Actions")
          .addButton((button) => button.setButtonText("Sync now").setCta().setDisabled(true))
          .addButton((button) => {
            button.setButtonText("Unpair...").setDisabled(true);
            if (typeof button.setWarning === "function") button.setWarning();
          });
      }
      this.operationRefreshTimer = window.setInterval(refreshLoadingStatus, 1000);
      refreshLoadingStatus();
    } else if (pendingOnboarding) {
      const conflictPending = pendingOnboarding.journal.stage === "awaiting_conflict";
      const canCancelPending = !paired && (
        terminalOnboarding || ["awaiting_browser", "approved", "analyzing", "awaiting_confirmation"].includes(pendingOnboarding.journal.stage)
      );
      new Setting(containerEl)
        .setName(
          terminalOnboarding
            ? pendingOnboarding.journal.last_error_code === "connection_expired" ? "Setup approval expired" : "Setup was denied"
            : awaitingOnboardingApproval
              ? "Approve this connection"
              : conflictPending ? "Conflict review submitted" : "Finish connecting this vault"
        )
        .setDesc(
          restartRequired
            ? "A plugin update interrupted an operation. Fully restart Obsidian, then return here to resume setup safely."
            : terminalOnboarding
              ? "No device was registered. Restart setup to create one fresh approval request."
              : awaitingOnboardingApproval
                ? "Continue in the browser to approve this pending connection, then return here."
                : conflictPending
                  ? "Resolve the conflict in the dashboard, then resume here to apply the resolution. Do not submit the merge again."
                  : "Setup stopped after it started. Resume from the durable onboarding journal; obts will not create a second device."
        );
      new Setting(containerEl)
        .setName("Onboarding")
        .addButton((button) => {
          button
            .setButtonText(
              terminalOnboarding
                ? "Restart setup"
                : awaitingOnboardingApproval
                  ? "Continue approval"
                  : conflictPending ? "Resume conflict setup" : "Resume setup"
            )
            .setCta()
            .setDisabled(restartRequired)
            .onClick(() => new ObtsOnboardingModal(this.app, this.plugin).open());
        })
        .addButton((button) => {
          button
            .setButtonText("Cancel setup...")
            .setDisabled(!canCancelPending)
            .onClick(async () => {
              if (!window.confirm("Cancel this unfinished setup? No server device has been registered yet.")) return;
              await this.plugin.runExclusiveAction(() => this.plugin.client.cancelOnboarding());
              await this.display();
            });
          if (typeof button.setWarning === "function") button.setWarning();
        });
    } else if (paired) {
      let renameDraft = deviceName;
      new Setting(containerEl)
        .setName("Device name")
        .setDesc(`Server device ${state.device_id}`)
        .addText((text) => {
          text.setValue(deviceName).onChange((value) => {
            renameDraft = value;
          });
          if (text.inputEl) text.inputEl.maxLength = 80;
        })
        .addButton((button) => button.setButtonText("Save name").onClick(async () => {
          button.setDisabled(true);
          setFeedback(renameFeedback, "Saving device name...", "muted");
          try {
            const renamed = await this.plugin.runExclusiveAction(() => this.plugin.client.renameCurrentDevice(renameDraft), "Renaming device");
            renameDraft = renamed;
            setFeedback(renameFeedback, `Device renamed to ${renamed}.`, "success");
            new Notice(`obts device renamed to ${renamed}.`);
          } catch (error) {
            setFeedback(renameFeedback, error instanceof Error ? error.message : "Unable to rename this device.", "error");
          } finally {
            button.setDisabled(false);
          }
        }));
      const renameFeedback = containerEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
      new Setting(containerEl)
        .setName("Status")
        .setDesc(normalizePersistedStatusLabel(state.status_label, state.last_error_code, state.last_error_details));
      if (state.last_error_code) {
        new Setting(containerEl)
          .setName("Sync details")
          .setDesc(localSyncFailureExplanation(state.last_error_code, state.last_error_details));
      }
      const operationSetting = new Setting(containerEl).setName("Current operation");
      let syncButton = null;
      const refreshOperation = () => {
        const operation = this.plugin.operationDetails();
        operationSetting.setDesc(this.plugin.operationDescription(operation));
        if (syncButton) syncButton.setDisabled(operation.availability !== "available");
      };
      if (state.last_error_code === "directory_recovery_journal_invalid") {
        new Setting(containerEl)
          .setName("Directory recovery journal is invalid")
          .setDesc("Sync is blocked without modifying the journal or vault. Send diagnostics and preserve `.obts/directory-recovery.json` for recovery support.");
      }
      new Setting(containerEl)
        .setName("Actions")
        .addButton((button) => {
          syncButton = button;
          return button
            .setButtonText("Sync now")
            .setCta()
            .setDisabled(this.plugin.operationAvailability() !== "available")
            .onClick(async () => {
              button.setDisabled(true);
              setFeedback(actionFeedback, "Starting sync...", "muted");
              try {
                const result = await this.plugin.runUserAction(
                  () => this.plugin.syncOnceOrPollResolvedConflict({ confirmInitialImport: false }),
                  false
                );
                if (!result) {
                  const operation = this.plugin.operationDetails();
                  if (operation.availability !== "available") {
                    setFeedback(actionFeedback, this.plugin.syncBlockedMessage(), "muted");
                  } else {
                    const blockedState = await this.plugin.client.readState();
                    setFeedback(
                      actionFeedback,
                      blockedState.last_error_code
                        ? localSyncFailureExplanation(blockedState.last_error_code, blockedState.last_error_details)
                        : "Sync did not complete; check the current status for details.",
                      blockedState.last_error_code ? "error" : "muted"
                    );
                  }
                  return;
                }
                this.plugin.setStatus((await this.plugin.client.readState()).status_label);
                const resultLabel = result.status === "Review needed" ? "Conflict resolution needed" : result.status;
                setFeedback(actionFeedback, resultLabel === "Conflict resolution needed" ? "Server conflict recorded; review it in the dashboard." : `Sync result: ${resultLabel}`, resultLabel === "Conflict resolution needed" ? "error" : "success");
                if (shouldShowRoutineStatusNotice(resultLabel)) new Notice(`obts: ${resultLabel}`);
                await this.display();
              } catch (error) {
                setFeedback(actionFeedback, error instanceof Error ? error.message : "Sync failed.", "error");
              } finally {
                button.setDisabled(this.plugin.operationAvailability() !== "available");
              }
            });
        })
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
                await this.plugin.runExclusiveAction(async () => {
                  await this.plugin.client.unpairCurrentDevice();
                  await this.plugin.saveSettings();
                }, "Unpairing device");
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
      refreshOperation();
      this.operationRefreshTimer = window.setInterval(refreshOperation, 1000);
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
                await this.plugin.runExclusiveAction(async () => {
                  await this.plugin.client.resetLocalPairingState();
                  await this.plugin.saveSettings();
                }, "Resetting local pairing");
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
        .setDesc("Ready to connect this vault");
      new Setting(containerEl)
        .setName("Device name")
        .addText((text) => {
          text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
            try {
              await this.plugin.runExclusiveAction(async () => {
                this.plugin.settings.deviceName = value.trim();
                await this.plugin.saveSettings();
              }, "Updating device name");
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Unable to update the device name.");
              await this.display();
            }
          });
          if (text.inputEl) text.inputEl.maxLength = 80;
        });

      new Setting(containerEl)
        .setName("Sync setup")
        .setDesc("Authenticate in your browser, then choose how this local vault should connect.")
        .addButton((button) =>
          button
            .setButtonText("Set up sync")
            .setCta()
            .onClick(() => new ObtsOnboardingModal(this.app, this.plugin).open())
        );
    }

    await this.renderRootIgnoreStatus(containerEl);
  }

  async renderRootIgnoreStatus(containerEl) {
    containerEl.createEl("h3", { text: "Sync policy", cls: "obts-settings-section-header" });
    new Setting(containerEl)
      .setName("Vault-root .gitignore")
      .setDesc("This versioned file remains the shared exclusion policy. Edit its effective rules in the server dashboard.");
    const status = containerEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    try {
      const policy = await this.plugin.client.readRootIgnorePolicy();
      const rules = policy.bytes === null ? "No root .gitignore is currently applied on this device." : new TextDecoder("utf-8", { fatal: true }).decode(policy.bytes);
      setFeedback(status, `${rules}\n\nThis is the local applied copy (policy ${policy.oid || "absent"}); it may be stale while offline or before pairing.`, "muted");
    } catch {
      setFeedback(status, "The local applied exclusion policy is unavailable. This may happen offline or before pairing; no current server policy is implied.", "muted");
    }
    const state = await this.plugin.client.readState().catch(() => null);
    const dashboardBase = normalizedServerDestination(this.plugin.settings.serverUrl);
    if (state && state.vault_id && dashboardBase) {
      try {
        const dashboardUrl = new URL("/", dashboardBase);
        dashboardUrl.searchParams.set("vault", state.vault_id);
        containerEl.createEl("a", {
          text: "Manage sync rules on server",
          href: dashboardUrl.toString(),
          attr: { target: "_blank", rel: "noopener noreferrer" }
        });
      } catch {
        // Invalid or unset server URLs do not produce a misleading link.
      }
    }
  }
}

function normalizeDisplayName(value) {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!normalized || Array.from(normalized).length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)) {
    throw new Error("Name must contain 1 to 80 visible characters.");
  }
  return normalized;
}

function diagnosticSharingDescription(serverUrl) {
  const destination = normalizedServerDestination(serverUrl) || "the configured obts backend";
  return `When obts fails, stalls, or reconciles a stale block, send a small sanitized technical report to ${destination}. Reports include plugin and platform versions, fixed error codes, coarse queue/journal/lease states, and cursor relationships without cursor values. They never include note content, vault or file names, paths, credentials, commit IDs, Git objects, packfiles, or raw logs.`;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = "B";
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function setFeedback(element, message, tone) {
  element.className = `obts-feedback obts-feedback--${tone}`;
  element.textContent = message;
}

class ObtsBlockedError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class ObtsTransportError extends Error {
  constructor(status, code, message, details = undefined, cause = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

class LocalSnapshotChangedError extends Error {
  constructor(filePath, cause = undefined) {
    super("Local vault contents changed during a consistency checkpoint.");
    this.filePath = filePath;
    if (cause) this.cause = cause;
  }
}

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return await response.json();
}

async function postJsonWithBearer(url, token, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
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

async function ensureAdapterDir(adapter, dir, gate = null) {
  if (!dir || dir === ".") {
    return;
  }
  const segments = dir.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const create = async (raw) => {
      try {
        const before = typeof raw.stat === "function" ? await raw.stat(current) : null;
        if (before?.type === "folder") return;
        if (before) throw new Error("Directory prefix is occupied");
        await raw.mkdir(current);
      } catch {
        let existing = null;
        try {
          existing = typeof raw.stat === "function" ? await raw.stat(current) : null;
        } catch {
          existing = null;
        }
        if (existing && existing.type === "folder") return;
        throw new ObtsBlockedError("directory_materialization_failed", "An authoritative directory could not be created safely.");
      }
    };
    if (gate) await gate.withExclusive([current], create);
    else await create(adapter);
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

async function writeTextSnapshotPatch(fsp, bundleDir, filePath, content) {
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

async function bundleChecksums(fsp, bundleDir, maxBytes) {
  const entries = [];
  await walkBundleFiles(fsp, bundleDir, async (absolutePath) => {
    const relativePath = normalizePath(path.relative(bundleDir, absolutePath));
    if (relativePath === "checksums.sha256") return;
    const content = await fsp.readFileBounded(absolutePath, maxBytes);
    entries.push(`${sha256(content)}  ${relativePath}`);
  });
  return entries.sort();
}

async function walkBundleFiles(fsp, root, visitFile) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkBundleFiles(fsp, absolutePath, visitFile);
    } else if (entry.isFile()) {
      await visitFile(absolutePath);
    }
  }
}

async function syncRecoveryBundleTree(fsp, root) {
  if (typeof fsp.syncFile !== "function" || typeof fsp.syncDirectory !== "function") {
    throw new ObtsBlockedError("recovery_bundle_durability_unavailable", "Recovery bundle durability is unavailable on this device.");
  }
  const directories = [];
  const visit = async (directory) => {
    directories.push(directory);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) await fsp.syncFile(absolutePath);
    }
  };
  await visit(root);
  for (const directory of directories.sort((left, right) => right.length - left.length || right.localeCompare(left))) {
    await fsp.syncDirectory(directory);
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
    if (!segment || segment === "." || segment === "..") {
      return false;
    }
  }
  return segments[0] !== ".obts" && !segments.includes(".git");
}

function assertValidLocalVaultPath(filePath) {
  if (!isValidVaultPath(filePath)) {
    throw new ObtsBlockedError("invalid_path", "Vault path is invalid or cannot be synced.", { path: filePath });
  }
}

function isOsOrEditorMetadata(filePath) {
  const basename = filePath.split("/").at(-1) || filePath;
  return basename === ".DS_Store" || basename === "Thumbs.db" || basename.endsWith("~") || basename.endsWith(".swp") || basename.endsWith(".tmp");
}

function assertNoCaseCollisions(paths) {
  return paths;
}

function compareByName(left, right) {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function explicitEmptyDirectories(directories, files) {
  return directories.filter((directory) => !files.some((filePath) => filePath.startsWith(`${directory}/`))).sort();
}

function topmostDirectories(directories) {
  const sorted = Array.from(new Set(directories)).sort((left, right) => left.length - right.length || left.localeCompare(right));
  const result = [];
  for (const directory of sorted) {
    if (!result.some((parent) => directory === parent || directory.startsWith(`${parent}/`))) {
      result.push(directory);
    }
  }
  return result;
}

function normalizeStoredDirectoryIntents(intents) {
  return (Array.isArray(intents) ? intents : []).map((intent) => {
    if (!intent || (intent.op !== "create" && intent.op !== "delete") || !isSyncableVaultPath(intent.path)) return intent;
    if (
      typeof intent.intent_id === "string" && intent.intent_id.length > 0 &&
      Number.isSafeInteger(intent.generation) && intent.generation >= 0 &&
      (intent.provenance === "legacy" || intent.provenance === "local_v2")
    ) return intent;
    return Object.assign({}, intent, {
      intent_id: `legacy_${sha256(Buffer.from(`${intent.op}\0${intent.path}`, "utf8")).slice(0, 24)}`,
      generation: 0,
      provenance: "legacy",
      base_main: null,
      base_event_seq: 0,
      replaces_intent_id: null,
      recreated_after_delete: false,
      created_at: null
    });
  });
}

function directoryIntentOperationKey(intent) {
  return `${intent.op}\0${intent.path}`;
}

function directoryIntentIdentityKey(intent) {
  return `${intent.intent_id || "legacy"}\0${intent.generation || 0}\0${directoryIntentOperationKey(intent)}`;
}

function directoryIntentGenerationKey(intent) {
  return `${intent.intent_id || "legacy"}\0${intent.generation || 0}`;
}

function directoryIntentRecordKey(intent) {
  return stableJson([
    intent.intent_id,
    intent.generation,
    intent.op,
    intent.path,
    intent.provenance,
    intent.base_main,
    intent.base_event_seq,
    intent.replaces_intent_id,
    intent.recreated_after_delete,
    intent.created_at
  ]);
}

function buildDirectoryProposal(state, targetCommit, pendingIntents) {
  const baseMain = state.local_main || null;
  const baseEventSeq = Number.isSafeInteger(state.last_applied_event_seq) ? state.last_applied_event_seq : 0;
  const intents = normalizeStoredDirectoryIntents(pendingIntents).map((intent) => Object.assign({}, intent, {
    base_main: baseMain,
    base_event_seq: baseEventSeq
  }));
  const proposalBody = {
    schema_version: 2,
    base_main: baseMain,
    base_event_seq: baseEventSeq,
    intents
  };
  return Object.assign({}, proposalBody, {
    proposal_id: `dirprop_${sha256(Buffer.from(stableJson([state.device_id, targetCommit, proposalBody]), "utf8"))}`
  });
}

function legacySettlementStateAgrees(saved, current) {
  if (!saved || !current) return false;
  return ["vault_id", "device_id", "device_ref", "local_main", "local_head", "server_device_ref"]
    .every((key) => saved[key] === current[key]) &&
    Number.isSafeInteger(current.last_event_seq) && current.last_event_seq >= saved.last_event_seq &&
    Number.isSafeInteger(current.last_applied_event_seq) && current.last_applied_event_seq >= saved.last_applied_event_seq;
}

function legacySettlementQueueAgrees(saved, current, allowNewCommit = false) {
  return Boolean(saved && current && Array.isArray(saved.changed_paths) && Array.isArray(current.changed_paths) &&
    current.status === "queued_local" && saved.status === "queued_local" &&
    current.expected_device_ref === saved.expected_device_ref &&
    Number.isSafeInteger(current.change_seq) && current.change_seq >= saved.change_seq &&
    saved.changed_paths.every((filePath) => current.changed_paths.includes(filePath)) &&
    (allowNewCommit || current.pending_commit === saved.pending_commit));
}

function legacySettlementDirectoryAgrees(saved, current) {
  return Boolean(saved && current &&
    ["pending_intents", "observed_dirs", "observed_directory_ctimes", "explicit_empty_dirs", "next_generation"]
      .every((key) => stableJson(saved[key]) === stableJson(current[key])));
}

function legacySettlementEvidenceAgrees(saved, current) {
  return Boolean(saved && current &&
    stableJson(saved.journal) === stableJson(current.journal) &&
    legacySettlementStateAgrees(saved.state, current.state) &&
    legacySettlementQueueAgrees(saved.queue, current.queue) &&
    legacySettlementDirectoryAgrees(saved.directoryState, current.directoryState) &&
    stableJson(saved.upload) === stableJson(current.upload) &&
    stableJson(saved.pull) === stableJson(current.pull));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function transferManifestSha256(manifest) {
  return sha256(Buffer.from(stableJson(manifest), "utf8"));
}

function isGitObjectId(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isTransferPathArray(value) {
  return Array.isArray(value) &&
    value.every((filePath) => typeof filePath === "string" && isSafeJournalPath(filePath) && isSyncableVaultPath(filePath)) &&
    new Set(value).size === value.length;
}

function isCompleteTransferManifest(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    value.api_version === API_VERSION && value.capability === "git-object-pack-chunks-v1" &&
    value.complete === true && isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.cursor) && value.cursor >= 0 &&
    Number.isSafeInteger(value.next_cursor) && (value.next_cursor === value.cursor || value.next_cursor === value.cursor + 1) &&
    typeof value.chunk_sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.chunk_sha256) &&
    Number.isSafeInteger(value.chunk_bytes) && value.chunk_bytes >= 0 &&
    isTransferPathArray(value.changed_paths) && isTargetFileSizeMap(value.target_file_sizes) &&
    isTransferPathArray(value.explicit_directories)
  );
}

function isCompleteBootstrapCheckpoint(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.connection_id === "string" && value.complete === true &&
    isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.next_cursor) && value.next_cursor >= 0 &&
    Number.isSafeInteger(value.received_chunks) && value.received_chunks > 0 &&
    Number.isSafeInteger(value.transferred_bytes) && value.transferred_bytes >= 0 &&
    isCompleteTransferManifest(value.manifest) &&
    typeof value.manifest_sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.manifest_sha256) &&
    value.manifest.connection_id === value.connection_id &&
    typeof value.manifest.vault_id === "string" && typeof value.manifest.vault_name === "string" &&
    isGitObjectId(value.manifest.root_commit) &&
    value.manifest.target_main === value.target_main &&
    value.manifest.next_cursor === value.next_cursor
  );
}

function isCompletePullCheckpoint(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.vault_id === "string" && typeof value.device_id === "string" &&
    (value.current_local_main === null || isGitObjectId(value.current_local_main)) &&
    Number.isSafeInteger(value.current_event_seq) && value.current_event_seq >= 0 &&
    value.complete === true && isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.next_cursor) && value.next_cursor >= 0 &&
    Number.isSafeInteger(value.received_chunks) && value.received_chunks > 0 &&
    Number.isSafeInteger(value.transferred_bytes) && value.transferred_bytes >= 0 &&
    isCompleteTransferManifest(value.manifest) &&
    typeof value.manifest_sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.manifest_sha256) &&
    value.manifest.vault_id === value.vault_id && value.manifest.device_id === value.device_id &&
    value.manifest.target_main === value.target_main &&
    value.manifest.next_cursor === value.next_cursor &&
    (value.manifest.current_local_main_is_ancestor === null || typeof value.manifest.current_local_main_is_ancestor === "boolean") &&
    Number.isSafeInteger(value.manifest.event_seq) && value.manifest.event_seq >= 0 &&
    Array.isArray(value.manifest.directory_intents) && value.manifest.directory_intents.every((intent) =>
      intent && typeof intent === "object" && !Array.isArray(intent) &&
      (intent.op === "create" || intent.op === "delete") && typeof intent.path === "string" && isSafeJournalPath(intent.path)
    ) &&
    Array.isArray(value.manifest.directory_acknowledgements) && value.manifest.directory_acknowledgements.every((acknowledgement) =>
      acknowledgement && typeof acknowledgement === "object" && !Array.isArray(acknowledgement) &&
      typeof acknowledgement.intent_id === "string" && acknowledgement.intent_id.length > 0 &&
      Number.isSafeInteger(acknowledgement.generation) && acknowledgement.generation >= 0
    )
  );
}

function isUploadRecoveryQueue(value) {
  const nullableOid = (oid) => oid === null || isGitObjectId(oid);
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    nullableOid(value.pending_commit) && nullableOid(value.expected_device_ref) &&
    (value.pending_proposal_base === undefined || nullableOid(value.pending_proposal_base)) &&
    (value.pending_upload_base === undefined || nullableOid(value.pending_upload_base)) &&
    ["idle", "queued_local", "uploading", "uploaded", "merged", "conflicted", "blocked_recovery"].includes(value.status) &&
    Number.isSafeInteger(value.attempts) && value.attempts >= 0 &&
    Number.isSafeInteger(value.change_seq) && value.change_seq >= 0 &&
    Array.isArray(value.changed_paths) && value.changed_paths.every((p) => typeof p === "string" && isSafeJournalPath(p)));
}

function isUploadRecoveryResult(value) {
  return Boolean(value && ["merged", "noop", "conflicted"].includes(value.status) &&
    isGitObjectId(value.device_ref) && isGitObjectId(value.main) &&
    Number.isSafeInteger(value.event_seq) && value.event_seq >= 0 &&
    (value.status !== "merged" || isGitObjectId(value.merge_commit)) &&
    (value.status !== "conflicted" || typeof value.conflict_id === "string" && value.conflict_id.length > 0));
}

function isUploadCheckpointHandoff(value) {
  try {
    const unsigned = Object.assign({}, value);
    delete unsigned.journal_sha256;
    return Boolean(value && value.version === 1 &&
      value.journal_sha256 === sha256(Buffer.from(stableJson(unsigned))) &&
      isUploadTransferCheckpoint(value.checkpoint) && typeof value.checkpoint_raw === "string" &&
      value.checkpoint_sha256 === sha256(Buffer.from(value.checkpoint_raw)) &&
      stableJson(JSON.parse(value.checkpoint_raw)) === stableJson(value.checkpoint) &&
      value.vault_id === value.checkpoint.transfer_request.vault_id && value.device_id === value.checkpoint.transfer_request.device_id &&
      value.old_commit === value.checkpoint.target_commit &&
      value.original_base === (value.checkpoint.transfer_request.base_commit || null) &&
      isUploadRecoveryQueue(value.old_queue) && value.old_queue.pending_commit === value.old_commit &&
      value.old_queue.expected_device_ref === value.checkpoint.transfer_request.expected_device_ref &&
      value.old_queue.pending_upload_base === value.original_base &&
      (!value.old_queue.pending_proposal_base || value.old_queue.pending_proposal_base === value.original_base) &&
      isUploadRecoveryQueue(value.successor_queue) && value.successor_queue.pending_commit === value.successor_commit &&
      ((value.phase === "prepared" && value.result === null) || (value.phase === "result" && isUploadRecoveryResult(value.result) &&
        (value.replay_checkpoint === null || isUploadRecoveryReplay(value.replay_checkpoint, value.checkpoint)))));
  } catch { return false; }
}

function isModernUploadCheckpoint(value) {
  return isUploadTransferCheckpoint(value) && value.transfer_request.root_ignore_capability === "root-ignore-v1" &&
    Object.hasOwn(value.transfer_request, "root_ignore_oid");
}

function isUploadRecoveryReplay(value, original) {
  return isModernUploadCheckpoint(value) && value.target_commit === original.target_commit &&
    value.transfer_request.vault_id === original.transfer_request.vault_id &&
    value.transfer_request.device_id === original.transfer_request.device_id &&
    value.transfer_request.expected_device_ref === original.transfer_request.expected_device_ref &&
    value.transfer_request.client_known_main === original.transfer_request.client_known_main &&
    (value.transfer_request.base_commit || null) === (original.transfer_request.base_commit || null) &&
    stableJson(value.directory_proposal) === stableJson(original.directory_proposal);
}

function sameUploadAttempt(first, second) {
  return first.identity === second.identity && first.attempt_id === second.attempt_id &&
    stableJson(first.transfer_request) === stableJson(second.transfer_request) && stableJson(first.groups) === stableJson(second.groups) &&
    stableJson(first.directory_proposal) === stableJson(second.directory_proposal);
}

function isUploadTransferCheckpoint(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
    typeof value.identity !== "string" || !/^[0-9a-f]{64}$/u.test(value.identity) ||
    !isGitObjectId(value.target_commit) ||
    !Array.isArray(value.groups) || value.groups.some((group) =>
      !Array.isArray(group) || group.some((oid) => !isGitObjectId(oid))
    ) ||
    !value.transfer_request || typeof value.transfer_request !== "object" || Array.isArray(value.transfer_request) ||
    value.transfer_request.target_commit !== value.target_commit ||
    value.transfer_request.chunk_count !== value.groups.length ||
    value.transfer_request.plan_sha256 !== sha256(Buffer.from(JSON.stringify(value.groups))) ||
    typeof value.attempt_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.attempt_id) ||
    value.attempt_id !== `xfer_${sha256(Buffer.from(stableJson(value.transfer_request))).slice(0, 32)}` ||
    !(value.transfer_id === null || typeof value.transfer_id === "string" && /^trn_[A-Za-z0-9]+$/u.test(value.transfer_id))
  ) return false;
  return value.directory_proposal === null || typeof value.directory_proposal === "object" && !Array.isArray(value.directory_proposal);
}

function isStoredDirectoryIntent(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    (value.op === "create" || value.op === "delete") &&
    typeof value.path === "string" && isSafeJournalPath(value.path) &&
    typeof value.intent_id === "string" && /^(?:dir_[0-9]+_[0-9]+_[0-9a-f]{12}|legacy_[0-9a-f]{24})$/u.test(value.intent_id) &&
    Number.isSafeInteger(value.generation) && value.generation >= 0 &&
    (value.provenance === "legacy" || value.provenance === "local_v2") &&
    (value.base_main === null || isGitObjectId(value.base_main)) &&
    Number.isSafeInteger(value.base_event_seq) && value.base_event_seq >= 0 &&
    (value.replaces_intent_id === null || typeof value.replaces_intent_id === "string") &&
    typeof value.recreated_after_delete === "boolean" &&
    (value.created_at === null || typeof value.created_at === "string")
  );
}

function isValidDirectoryRecoveryInventory(inventory, roots) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory) || !Array.isArray(inventory.directories) || !Array.isArray(inventory.files)) return false;
  const covered = (filePath) => roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
  const directoryPaths = new Set();
  for (const entry of inventory.directories) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.path !== "string" || !isSafeJournalPath(entry.path) || !covered(entry.path) ||
      !(entry.creation_time === null || Number.isFinite(entry.creation_time) && entry.creation_time > 0) ||
      directoryPaths.has(entry.path)
    ) return false;
    directoryPaths.add(entry.path);
  }
  const filePaths = new Set();
  for (const entry of inventory.files) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.path !== "string" || !isSafeJournalPath(entry.path) || !covered(entry.path) ||
      !isPreflightFingerprint(entry.fingerprint) || filePaths.has(entry.path)
    ) return false;
    filePaths.add(entry.path);
  }
  return true;
}

function parseDirectoryRecoveryDecision(value) {
  const fail = () => {
    throw new ObtsBlockedError("directory_recovery_journal_invalid", "The directory recovery journal is invalid.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const phases = new Set(["awaiting_decision", "executing"]);
  const steps = new Set(["decision_recorded", "intent_state_written", "apply_completed", "acknowledged"]);
  const pathArray = (items) => Array.isArray(items) && items.every((item) => typeof item === "string" && isSafeJournalPath(item)) && new Set(items).size === items.length;
  if (
    value.version !== 1 || !phases.has(value.phase) ||
    typeof value.recovery_id !== "string" || !/^dirrec_[0-9]+_[0-9a-f]{16}$/u.test(value.recovery_id) ||
    !isGitObjectId(value.target_main) || !isGitObjectId(value.local_main_at_decision) || !isGitObjectId(value.local_head_at_decision) ||
    !(value.base_main === null || isGitObjectId(value.base_main)) ||
    !Number.isSafeInteger(value.event_seq) || value.event_seq < 0 ||
    !pathArray(value.changed_paths) || !isTargetFileSizeMap(value.target_file_sizes || {}) ||
    !pathArray(value.explicit_directories) || !pathArray(value.ambiguous_roots) ||
    !Array.isArray(value.directory_intents) || value.directory_intents.some((intent) =>
      !intent || typeof intent !== "object" || Array.isArray(intent) ||
      (intent.op !== "create" && intent.op !== "delete") || typeof intent.path !== "string" || !isSafeJournalPath(intent.path)
    ) ||
    !Array.isArray(value.original_pending_intents) || value.original_pending_intents.some((intent) => !isStoredDirectoryIntent(intent)) ||
    !Array.isArray(value.ambiguous_intents) || value.ambiguous_intents.some((intent) => !isStoredDirectoryIntent(intent)) ||
    !Array.isArray(value.superseded_intents) || value.superseded_intents.some((intent) => !isStoredDirectoryIntent(intent)) ||
    !Number.isSafeInteger(value.next_generation) || value.next_generation < 1 ||
    typeof value.archived !== "boolean" || !steps.has(value.last_completed_step) ||
    typeof value.created_at !== "string" || typeof value.updated_at !== "string" ||
    !value.inventory || typeof value.inventory !== "object" || Array.isArray(value.inventory) ||
    !Array.isArray(value.inventory.directories) || !Array.isArray(value.inventory.files)
  ) fail();
  const originalById = new Map(value.original_pending_intents.map((intent) => [intent.intent_id, intent]));
  if (originalById.size !== value.original_pending_intents.length) fail();
  const classified = [...value.ambiguous_intents, ...value.superseded_intents];
  if (classified.some((intent) => {
    const original = originalById.get(intent.intent_id);
    return !original || directoryIntentRecordKey(original) !== directoryIntentRecordKey(intent);
  })) fail();
  if (new Set(classified.map((intent) => intent.intent_id)).size !== classified.length) fail();
  const deletePaths = value.directory_intents.filter((intent) => intent.op === "delete").map((intent) => intent.path);
  const coveredByRemoteDelete = (intent) => intent.op === "create" && deletePaths.some((deletedPath) =>
    intent.path === deletedPath || intent.path.startsWith(`${deletedPath}/`)
  );
  if (classified.some((intent) => !coveredByRemoteDelete(intent))) fail();
  const coveredOriginalIds = value.original_pending_intents.filter(coveredByRemoteDelete).map((intent) => intent.intent_id).sort();
  if (stableJson(coveredOriginalIds) !== stableJson(classified.map((intent) => intent.intent_id).sort())) fail();
  const derivedAmbiguousRoots = topmostDirectories(value.ambiguous_intents.map((intent) => intent.path));
  if (stableJson(derivedAmbiguousRoots) !== stableJson(value.ambiguous_roots)) fail();
  const inventoryRoots = topmostDirectories([
    ...value.ambiguous_roots,
    ...value.superseded_intents.map((intent) => intent.path)
  ]);
  const covered = (filePath) => inventoryRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
  const directoryPaths = new Set();
  for (const entry of value.inventory.directories) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.path !== "string" || !isSafeJournalPath(entry.path) || !covered(entry.path) ||
      !(entry.creation_time === null || Number.isFinite(entry.creation_time) && entry.creation_time > 0) ||
      directoryPaths.has(entry.path)
    ) fail();
    directoryPaths.add(entry.path);
  }
  const filePaths = new Set();
  for (const entry of value.inventory.files) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.path !== "string" || !isSafeJournalPath(entry.path) || !covered(entry.path) ||
      !isPreflightFingerprint(entry.fingerprint) || filePaths.has(entry.path)
    ) fail();
    filePaths.add(entry.path);
  }
  if (value.ambiguous_intents.some((intent) => !directoryPaths.has(intent.path))) fail();
  if (value.superseded_intents.some((intent) => [...directoryPaths, ...filePaths].some((entryPath) =>
    entryPath === intent.path || entryPath.startsWith(`${intent.path}/`)
  ))) fail();
  if (value.phase === "executing") {
    if (!value.decisions || typeof value.decisions !== "object" || Array.isArray(value.decisions)) fail();
    if (value.last_completed_step !== "decision_recorded" && !value.archived) fail();
    if (stableJson(Object.keys(value.decisions).sort()) !== stableJson(value.ambiguous_roots.slice().sort())) fail();
    if (Object.values(value.decisions).some((choice) => choice !== "keep_local" && choice !== "accept_server")) fail();
  } else if (value.decisions !== null || value.last_completed_step !== "decision_recorded" || value.archived) fail();
  return value;
}

function compactDirectoryIntents(intents) {
  const byPath = new Map();
  for (const original of intents) {
    if (!original || (original.op !== "create" && original.op !== "delete") || !isSyncableVaultPath(original.path)) {
      continue;
    }
    let intent = original;
    const replaced = byPath.get(intent.path);
    if (intent.op === "create" && replaced && replaced.op === "delete" && !intent.recreated_after_delete) {
      intent = Object.assign({}, intent, {
        replaces_intent_id: intent.replaces_intent_id || replaced.intent_id || null,
        recreated_after_delete: true
      });
    }
    if (intent.op === "delete") {
      for (const dirPath of Array.from(byPath.keys())) {
        if (dirPath === intent.path || dirPath.startsWith(`${intent.path}/`)) {
          byPath.delete(dirPath);
        }
      }
    }
    byPath.set(intent.path, intent);
  }
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path) || left.op.localeCompare(right.op));
}

function buffersEqual(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return Buffer.compare(left, right) === 0;
}

function isEmptyGitPack(packfile) {
  const bytes = Buffer.isBuffer(packfile) ? packfile : Buffer.from(packfile);
  if (bytes.byteLength !== 32 || bytes.subarray(0, 4).toString("ascii") !== "PACK") return false;
  const version = bytes.readUInt32BE(4);
  if ((version !== 2 && version !== 3) || bytes.readUInt32BE(8) !== 0) return false;
  const expectedDigest = createSha("sha1").update(bytes.subarray(0, 12)).digest();
  return buffersEqual(bytes.subarray(12), expectedDigest);
}

// Sorted prefix inventory plus ancestor map: no full-vault scan per touched path.
function indexPaths(entries) {
  const byPath = new Map();
  for (const [p, value] of entries) {
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(value);
  }
  const keys = [...byPath.keys()].sort();
  const descendants = (p) => {
    const prefix = `${p}/`;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < prefix) lo = mid + 1; else hi = mid;
    }
    const found = [];
    for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++)
      for (const v of byPath.get(keys[i])) found.push([keys[i], v]);
    return found;
  };
  return { descendants, overlap(p) {
    const result = descendants(p).map(([, v]) => v);
    for (let ancestor = p; ancestor; ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "")
      result.push(...(byPath.get(ancestor) || []));
    return result;
  } };
}

function changedPathsConflict(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function compareDeepestPathFirst(left, right) {
  const depthDifference = right.split("/").length - left.split("/").length;
  return depthDifference || left.localeCompare(right);
}

function dependencySafeRemovalBatches(paths) {
  const remaining = new Set(paths);
  const batches = [];
  while (remaining.size > 0) {
    const batch = [...remaining]
      .filter((candidate) => ![...remaining].some((other) => other !== candidate && other.startsWith(`${candidate}/`)))
      .sort(compareDeepestPathFirst);
    if (batch.length === 0) throw new Error("Could not plan dependency-safe apply removals.");
    batches.push(batch);
    for (const filePath of batch) remaining.delete(filePath);
  }
  return batches;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scanFileMetadata(stat) {
  const size = Number(stat && stat.size);
  const mtime = Number(stat && stat.mtime);
  const ctime = Number(stat && stat.ctime);
  return {
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
    ctime: Number.isFinite(ctime) && ctime > 0 ? ctime : null
  };
}

function sameScanFileMetadata(left, right) {
  return left.size === right.size && left.mtime === right.mtime && left.ctime === right.ctime;
}

function sameCachedScanFileMetadata(current, cached) {
  return current.size === cached.size &&
    current.mtime !== null && cached.mtime !== null &&
    current.mtime === cached.mtime;
}

function isRetryableLocalError(code) {
  return code === "local_snapshot_changed" || code === "upload_interrupted" || code === "pack_preparation_failed" || code === "git_error" || code === "server_git_error" || code === "server_processing_error" || code === "stale_directory_proposal_base" || code === "directory_acknowledgement_missing" || code === "invalid_path" || code === "path_collision" || code === "excluded_git_path" || code === "excluded_internal_path" || code === "excluded_path" || code === "unsupported_file_mode";
}

function isOfflineTransportError(error) {
  return error instanceof ObtsTransportError && error.status === 0;
}

function isRetryableServerError(error) {
  return error instanceof ObtsTransportError && (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500);
}

function isPermanentTransportError(error) {
  return error instanceof ObtsTransportError && !isOfflineTransportError(error) && !isRetryableServerError(error);
}

function statusBaseLabel(label) {
  const normalized = typeof label === "string" && label.trim().length > 0 ? label.trim() : "Checking";
  for (const base of ["Checking", "Verifying contents", "Preparing upload", "Uploading", "Merging", "Server retrying", "Repairing baseline", "Applying", "Finishing update", "Waiting for operation"]) {
    if (normalized === base || normalized.startsWith(`${base} `)) return base;
  }
  return normalized;
}

function statusPresentation(label) {
  const normalized = normalizePersistedStatusLabel(label, null);
  const base = statusBaseLabel(normalized);
  const action = base === "Conflict resolution needed" ? "Click to open the conflict dashboard." : "Click to open obts settings for details.";
  let tone = "neutral";
  if (base === "Synced") tone = "success";
  else if (["Checking", "Verifying contents", "Preparing upload", "Uploading", "Applying", "Merging", "Server retrying", "Repairing baseline", "Finishing update", "Waiting for operation"].includes(base)) tone = "active";
  else if (["Ahead", "Behind", "Offline", "Out of sync"].includes(base)) tone = "warning";
  else if (["Conflict resolution needed", "Out of sync — file exceeds upload limit", "Out of sync — upload limit exceeded", "Out of sync — local recovery required", "Blocked", "Server repair required", "Integrity failure", "Recovery required", "Restart required"].includes(base)) tone = "danger";
  return {
    label: normalized,
    base,
    tone,
    action,
    title: `${normalized}. ${action}`
  };
}

function statusAttentionMessage(base) {
  if (base === "Conflict resolution needed") return "obts needs attention: Resolve the server conflict in the dashboard. Click the sync indicator to continue.";
  if (base === "Out of sync — file exceeds upload limit" || base === "Out of sync — upload limit exceeded") return "obts cannot upload an oversized Git object. Open obts settings for the size, version, and next step.";
  if (base === "Out of sync — local recovery required") return "obts cannot continue automatically. Open obts settings for the specific recovery reason.";
  if (base === "Blocked") return "obts sync is blocked. Click the sync indicator to inspect the required action.";
  if (base === "Server repair required") return "obts stopped because the server vault needs an integrity repair. Click the sync indicator for details.";
  return null;
}

function isPersistentAttentionStatus(base) {
  return ["Conflict resolution needed", "Out of sync", "Out of sync — file exceeds upload limit", "Out of sync — upload limit exceeded", "Out of sync — local recovery required", "Blocked", "Server repair required", "Integrity failure", "Recovery required", "Restart required"].includes(base);
}

function isActiveTransferStatus(base) {
  return ["Verifying contents", "Preparing upload", "Uploading", "Applying", "Merging", "Server retrying", "Repairing baseline", "Finishing update", "Waiting for operation"].includes(base);
}

function isReportableOperationStatus(label) {
  const base = statusBaseLabel(label);
  return base === "Checking" || isActiveTransferStatus(base);
}

function shouldShowRoutineStatusNotice(label) {
  return !isPersistentAttentionStatus(statusBaseLabel(label));
}

function samePairedDeviceState(left, right) {
  return Boolean(
    left &&
      right &&
      left.vault_id &&
      left.device_id &&
      right.vault_id &&
      right.device_id &&
      left.vault_id === right.vault_id &&
      left.device_id === right.device_id
  );
}

function sameStateCursors(left, right) {
  return left.local_main === right.local_main &&
    left.local_head === right.local_head &&
    left.server_device_ref === right.server_device_ref;
}

function isConflictResultStatus(status) {
  return status === "Review needed" || status === "Conflict resolution needed";
}

function blockStatusLabel(code, details = null) {
  if (code === "conflict_review_required") return "Conflict resolution needed";
  if (code === "object_too_large_for_chunk") return details?.object_type === "blob" ? "Out of sync — file exceeds upload limit" : "Out of sync — upload limit exceeded";
  if (["unsafe_local_state", "apply_journal_recovery_required", "apply_recovery_required", "recovery_bundle_failed", "recovery_bundle_verification_failed", "recovery_bundle_durability_unavailable", "directory_baseline_recovery_journal_invalid", "directory_baseline_recovery_unsafe", "legacy_directory_advance_unsafe", "directory_recovery_journal_invalid", "directory_recovery_journal_mismatch", "directory_recovery_decision_required", "directory_recovery_changed", "local_ref_recovery_required", "replace_local_with_server_required", "server_recovery_required", "stale_device_ref", "same_device_non_fast_forward", "local_state_incomplete", "upload_checkpoint_recovery_required"].includes(code)) {
    return "Out of sync — local recovery required";
  }
  if (code === "local_snapshot_changed") return "Checking";
  if (code === "git_error" || code === "server_git_error" || code === "server_processing_error") return "Server retrying";
  if (code === "stale_directory_proposal_base") return "Repairing baseline";
  if (code === "initial_import_confirmation_required") return "Blocked";
  if (code === "blocked_integrity") return "Server repair required";
  return "Out of sync";
}

function normalizePersistedStatusLabel(label, code, details = null) {
  if (typeof code === "string" && code) {
    const mapped = blockStatusLabel(code, details);
    if (mapped !== "Out of sync" || ["Unsafe local state", "Needs recovery", "Review needed", "Conflict resolution needed", "Synced"].includes(label) || ["upload_interrupted", "pack_preparation_failed"].includes(code)) return mapped;
  }
  if (label === "Unsafe local state" || label === "Needs recovery" || label === "Review needed") return "Out of sync";
  return typeof label === "string" && label.trim() ? label.trim() : "Checking";
}

function safeLocalErrorCode(code) {
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? code : "sync_error";
}

function localSyncFailureExplanation(code, details) {
  const safeCode = safeLocalErrorCode(code);
  if (safeCode === "object_too_large_for_chunk") {
    const valid = details && details.operation_phase === "upload_prepare" &&
      ["blob", "tree", "commit", "tag"].includes(details.object_type) &&
      /^[0-9a-f]{40}$/u.test(details.object_oid || "") &&
      Number.isSafeInteger(details.object_bytes) && details.object_bytes >= 0 &&
      Number.isSafeInteger(details.object_limit_bytes) && details.object_limit_bytes > 0;
    const summary = valid
      ? `Git ${details.object_type} ${details.object_oid}: ${formatBytes(details.object_bytes)} (${details.object_bytes} bytes), upload limit ${formatBytes(details.object_limit_bytes)} (${details.object_limit_bytes} bytes).`
      : "A Git object exceeds the upload chunk limit; this device has no reliable object details.";
    const paths = valid && details.object_type === "blob" && Array.isArray(details.current_paths)
      ? details.current_paths.filter((value) => typeof value === "string" && isValidVaultPath(value)).slice(0, 3)
      : [];
    const location = paths.length ? ` Current path${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}.` : " No current path is known; the object may exist only in pending history.";
    return `${summary}${location} The queued commit remains local; changing the current file or an ignore rule alone may not clear its ancestry. Preserve the journal and use a reviewed fresh baseline or supported large-file transport before retrying.`;
  }
  if (safeCode === "conflict_review_required") return "The server recorded a conflict. Review it in the dashboard; the client cannot choose a winner locally.";
  if (safeCode === "apply_journal_recovery_required" || safeCode === "apply_recovery_required") return `Local apply recovery needs review (${safeCode}). Preserve the vault and .obts state; restart Obsidian once, then inspect the recovery journal if this persists.`;
  if (safeCode === "directory_recovery_journal_invalid") return "The local directory recovery journal is invalid. Preserve .obts/directory-recovery.json and the vault; send sanitized diagnostics before assisted recovery.";
  if (safeCode === "apply_lock_active") return "A local apply lock is active. Another operation may still own it; do not remove the lock. If it persists after restarting Obsidian, preserve the vault and .obts state for recovery support.";
  if (safeCode === "recovery_bundle_failed") return "Recovery evidence could not be completed, so destructive apply stopped. Check local storage and permissions; preserve the vault and .obts state before retrying.";
  if (safeCode === "recovery_bundle_verification_failed" || safeCode === "recovery_bundle_durability_unavailable") return `Recovery evidence is not verified or durable (${safeCode}), so destructive apply stopped. Preserve the vault and .obts state; check storage and permissions, then seek assisted recovery if it persists.`;
  if (safeCode === "local_ref_changed") return "Sync stopped because this device's local sync history moved while it was being updated. Your notes were not changed. Run Sync now once more; if this keeps happening, keep the vault and its .obts folder as they are and run Send troubleshooting snapshot now from the command palette.";
  if (safeCode === "local_ref_recovery_required") return "A local Git ref lock or lease could not be recovered safely. Do not remove it manually; preserve the vault and .obts state for assisted recovery.";
  if (safeCode === "legacy_directory_advance_unsafe") return "Legacy directory advance settlement stopped. Preserve the vault, .obts journal, recovery archive, and transfer checkpoints for assisted recovery; do not reset sync.";
  if (safeCode === "upload_checkpoint_recovery_required" || safeCode === "legacy_upload_checkpoint" || safeCode === "upload_checkpoint_mismatch") return "Run Recover upload checkpoint from the command palette. It preserves both proposals and reconciles the saved transfer with the server. If recovery still fails, preserve the vault and .obts files and send a troubleshooting snapshot for assisted recovery; do not reset sync.";
  if (safeCode === "directory_baseline_recovery_unsafe" || safeCode === "directory_baseline_recovery_journal_invalid") return `Directory baseline recovery stopped (${safeCode}). Preserve the vault and .obts state, including the directory recovery journal; seek assisted recovery rather than resetting sync.`;
  if (safeCode === "unsafe_local_state") return "A previous apply safety check stopped. Preserve the vault and .obts state; inspect the local recovery journal before attempting further changes.";
  if (blockStatusLabel(safeCode) === "Out of sync — local recovery required") return `Sync needs local recovery (${safeCode}). Preserve the vault and .obts state; use the existing recovery flow or seek assisted recovery rather than resetting sync.`;
  if (safeCode === "initial_import_confirmation_required") return "Review the initial import recovery bundle and explicitly confirm the import before continuing.";
  if (safeCode === "upload_interrupted" || safeCode === "pack_preparation_failed") return `Uploading local changes did not finish (${safeCode}). The pending commit remains queued on this device; check connectivity or local storage before retrying.`;
  if (safeCode === "blocked_integrity") return "The server vault requires an integrity repair. Keep local state intact and contact the server operator.";
  return `Sync has not completed (${safeCode}). Check connectivity and sync diagnostics; keep local state intact and retry only after the cause is understood.`;
}

async function readJson(fsp, filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readRecoveryJsonStrict(fsp, filePath, errorCode, message) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ObtsBlockedError(errorCode, message);
    }
    return value;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    if (error instanceof ObtsBlockedError) throw error;
    throw new ObtsBlockedError(errorCode, message);
  }
}

async function readApplyJournalStrict(fsp, filePath) {
  try {
    const journal = parseApplyJournal(JSON.parse(await fsp.readFile(filePath, "utf8")));
    await publishJournalDiagnosticSummary(fsp, filePath, journal);
    return journal;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function parseApplyJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Apply journal is invalid.");
  const operations = new Set(["pull_apply", "initial_import", "replace_local_with_server", "rebuild_from_server"]);
  const phases = new Set(["planned", "recovery_bundle_written", "writing_files", "verifying", "committed", "blocked_recovery"]);
  const affectedPaths = value.affected_paths;
  const preflight = value.preflight_sha256;
  const journalVersion = value.journal_version === undefined ? 1 : value.journal_version;
  const typedPreflight = value.preflight_fingerprints;
  const directoryIntents = value.directory_intents;
  const explicitDirectories = value.explicit_directories;
  const preApplyDirectories = value.pre_apply_directories;
  const preApplyDirectoryCtimes = value.pre_apply_directory_ctimes;
  const confirmedDirectoryRoots = value.confirmed_directory_roots === undefined ? [] : value.confirmed_directory_roots;
  const confirmedDirectoryInventory = value.confirmed_directory_inventory === undefined ? null : value.confirmed_directory_inventory;
  const targetFileSizes = value.target_file_sizes === undefined ? {} : value.target_file_sizes;
  if (
    (journalVersion !== 1 && journalVersion !== 2 && journalVersion !== 3 && journalVersion !== 4 && journalVersion !== 5 && journalVersion !== 6 && journalVersion !== 7) ||
    !isApplyId(value.apply_id) ||
    typeof value.operation_type !== "string" || !operations.has(value.operation_type) ||
    typeof value.target_main !== "string" || !/^[0-9a-f]{40}$/u.test(value.target_main) ||
    !isNullableString(value.expected_prior_local_main) ||
    !isNullableString(value.expected_prior_local_device_ref) ||
    typeof value.phase !== "string" || !phases.has(value.phase) ||
    !Array.isArray(affectedPaths) || affectedPaths.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath)) ||
    new Set(affectedPaths).size !== affectedPaths.length ||
    !preflight || typeof preflight !== "object" || Array.isArray(preflight) ||
    affectedPaths.some((filePath) => !Object.hasOwn(preflight, filePath) || !isNullableSha256(preflight[filePath])) ||
    (journalVersion >= 2 && (
      !typedPreflight || typeof typedPreflight !== "object" || Array.isArray(typedPreflight) ||
      affectedPaths.some((filePath) => !Object.hasOwn(typedPreflight, filePath) || !isPreflightFingerprint(typedPreflight[filePath]))
    )) ||
    (journalVersion >= 3 && (
      !Array.isArray(directoryIntents) || directoryIntents.some((intent) =>
        !intent || typeof intent !== "object" || Array.isArray(intent) ||
        (intent.op !== "create" && intent.op !== "delete") || typeof intent.path !== "string" || !isSafeJournalPath(intent.path)
      ) ||
      !Array.isArray(explicitDirectories) || explicitDirectories.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath)) ||
      new Set(explicitDirectories).size !== explicitDirectories.length ||
      !Array.isArray(preApplyDirectories) || preApplyDirectories.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath)) ||
      new Set(preApplyDirectories).size !== preApplyDirectories.length ||
      !preApplyDirectoryCtimes || typeof preApplyDirectoryCtimes !== "object" || Array.isArray(preApplyDirectoryCtimes) ||
      Object.keys(preApplyDirectoryCtimes).length !== preApplyDirectories.length ||
      preApplyDirectories.some((filePath) => !Object.hasOwn(preApplyDirectoryCtimes, filePath) || !isNullableNonNegativeNumber(preApplyDirectoryCtimes[filePath])) ||
      !Array.isArray(confirmedDirectoryRoots) || confirmedDirectoryRoots.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath)) ||
      new Set(confirmedDirectoryRoots).size !== confirmedDirectoryRoots.length ||
      !(confirmedDirectoryInventory === null || isValidDirectoryRecoveryInventory(confirmedDirectoryInventory, confirmedDirectoryRoots)) ||
      (confirmedDirectoryInventory === null && confirmedDirectoryRoots.length > 0) ||
      typeof value.preserve_local_changes !== "boolean" ||
      !(value.event_seq === null || Number.isSafeInteger(value.event_seq) && value.event_seq >= 0)
    )) ||
    (journalVersion >= 4 && !isTargetFileSizeMap(targetFileSizes)) ||
    (journalVersion >= 5 && (
      !(value.target_root_ignore_oid === null || /^[0-9a-f]{40}$/u.test(value.target_root_ignore_oid)) ||
      !Array.isArray(value.local_only_paths) ||
      value.local_only_paths.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath) || !isRecoverableApplyPath(filePath)) ||
      !sameStringArray(value.local_only_paths, [...new Set(value.local_only_paths)].sort()) ||
      !value.local_only_presence || typeof value.local_only_presence !== "object" || Array.isArray(value.local_only_presence) ||
      !sameStringArray(Object.keys(value.local_only_presence).sort(), value.local_only_paths) ||
      Object.values(value.local_only_presence).some((present) => typeof present !== "boolean") ||
      value.local_only_paths.some((filePath) => affectedPaths.some((affected) =>
        affected === filePath || affected.startsWith(`${filePath}/`) || filePath.startsWith(`${affected}/`)))
    )) ||
    (journalVersion >= 6 && (
      !Array.isArray(value.deferred_local_paths) ||
      value.deferred_local_paths.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath) || !isRecoverableApplyPath(filePath)) ||
      !sameStringArray(value.deferred_local_paths, [...new Set(value.deferred_local_paths)].sort())
    )) ||
    (journalVersion >= 7 && (
      !(value.authoring_base === null || /^[0-9a-f]{40}$/u.test(value.authoring_base)) ||
      !Array.isArray(value.touched_paths) || value.touched_paths.some((p) => typeof p !== "string" || !isSafeJournalPath(p))
    )) ||
    !isNullableString(value.recovery_bundle_id) ||
    !isNullableString(value.last_completed_step) ||
    !isNullableString(value.redacted_error_category)
  ) {
    throw new Error("Apply journal is invalid.");
  }
  return Object.assign({
    directory_intents: [],
    explicit_directories: [],
    pre_apply_directories: [],
    pre_apply_directory_ctimes: {},
    confirmed_directory_roots: [],
    confirmed_directory_inventory: null,
    target_file_sizes: {},
    preserve_local_changes: false,
    event_seq: null,
    target_root_ignore_oid: null,
    local_only_paths: [],
    local_only_presence: {},
    deferred_local_paths: []
  }, value);
}

function isTargetFileSizeMap(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([filePath, bytes]) =>
      isSafeJournalPath(filePath) && isSyncableVaultPath(filePath) && Number.isSafeInteger(bytes) && bytes >= 0
    );
}

function isSafeJournalPath(filePath) {
  return normalizePath(filePath) === filePath && isValidVaultPath(filePath);
}

function isApplyId(value) {
  return typeof value === "string" && /^apply_[0-9A-Za-z_-]{1,120}$/u.test(value);
}

function isLegacyApplyLockMarker(value, applyId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.apply_id !== applyId || !isApplyId(value.apply_id)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys.join(",") !== "apply_id,created_at") return false;
  if (typeof value.created_at !== "string") return false;
  const parsed = Date.parse(value.created_at);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value.created_at;
}

function isManagedApplyLockMarker(value, applyId, generation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 4 && keys.join(",") === "apply_id,domain,generation,version" &&
    value.version === 2 && value.domain === "obts-managed-linux-headless" &&
    value.generation === generation && typeof generation === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(generation) &&
    value.apply_id === applyId && isApplyId(value.apply_id);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableSha256(value) {
  return value === null || typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isNullableNonNegativeNumber(value) {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPreflightFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["missing", "file", "directory", "other"].includes(value.kind)) return false;
  if (value.kind === "file") {
    return typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256) &&
      typeof value.oid === "string" && /^[0-9a-f]{40}$/u.test(value.oid);
  }
  return value.sha256 === null && value.oid === null;
}

function journalDiagnosticSummary(filePath, value) {
  if (path.basename(filePath) === "apply-journal.json" && isTroubleshootingApplyJournal(value)) {
    return { phase: value.phase, redacted_error_category: troubleshootingSafeErrorCode(value.redacted_error_category) };
  }
  if (path.basename(filePath) === "onboarding.json" && isTroubleshootingOnboardingJournal(value)) {
    return { stage: value.stage, consent: isOnboardingConsentSummary(value.pending_summary) ? "saved" : "missing" };
  }
  if ((path.basename(filePath) === "pull-transfer.json" && isTroubleshootingPullTransfer(value)) ||
    (path.basename(filePath) === "bootstrap-transfer.json" && isTroubleshootingBootstrapTransfer(value))) {
    return { complete: value.complete === true };
  }
  return null;
}

async function publishJournalDiagnosticSummary(fsp, filePath, value) {
  const summary = journalDiagnosticSummary(filePath, value);
  if (!summary) return;
  // This optional, sanitized observation is never recovery authority.
  try {
    const stat = await fsp.stat(filePath);
    await writeJson(fsp, `${filePath}.diagnostic-summary`, { version: 1, size: stat.size, mtime: stat.mtimeMs, summary });
  } catch { /* Diagnostics must not change the durable operation's outcome. */ }
}

async function readJournalDiagnosticSummary(fsp, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const saved = JSON.parse(await fsp.readFileBounded(`${filePath}.diagnostic-summary`, 4096, "utf8"));
    if (saved.version !== 1 || saved.size !== stat.size || saved.mtime !== stat.mtimeMs || !saved.summary) return null;
    const summary = saved.summary;
    return {
      phase: troubleshootingEnum(summary.phase, ["planned", "recovery_bundle_written", "writing_files", "verifying", "committed", "blocked_recovery"], "invalid"),
      stage: troubleshootingEnum(summary.stage, ["awaiting_browser", "approved", "analyzing", "awaiting_confirmation", "registering", "applying_uploading", "uploading_proposal", "awaiting_conflict", "complete", "blocked"], "other"),
      consent: summary.consent === "saved" ? "saved" : "missing",
      complete: typeof summary.complete === "boolean" ? summary.complete : undefined,
      redacted_error_category: troubleshootingSafeErrorCode(summary.redacted_error_category)
    };
  } catch { return null; }
}

async function writeJson(fsp, filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${randomHex(4)}-${Date.now()}`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (typeof fsp.syncFile === "function") await fsp.syncFile(temporaryPath);
  try {
    await fsp.rename(temporaryPath, filePath);
    if (typeof fsp.syncDirectory === "function") await fsp.syncDirectory(path.dirname(filePath));
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await publishJournalDiagnosticSummary(fsp, filePath, value);
}

async function exists(fsp, filePath) {
  try {
    await fsp.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function applyRecoveryReason(state, journal) {
  for (const value of [state.apply_validation_reason, journal.redacted_error_category]) {
    const reason = troubleshootingSafeErrorCode(value);
    if (reason !== "none" && reason !== "unknown") return reason;
  }
  return "apply_recovery_required";
}

function categorizeRecoveryError(error) {
  if (error instanceof ObtsBlockedError) {
    if (error.code === "unsafe_local_state") {
      return "preflight_hash_changed";
    }
    if (error.code === "apply_lock_active") {
      return "apply_lock_active";
    }
    return error.code;
  }
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("git ") && (message.includes("show") || message.includes("cat-file"))) {
      return "blob_read_failed";
    }
    if (message.includes("ENOENT") || message.includes("EACCES") || message.includes("EPERM")) {
      return "adapter_io_failed";
    }
    if (error.code === "EEXIST") {
      return "apply_lock_active";
    }
    const code = typeof error.code === "string" ? error.code : "";
    const name = error.constructor && error.constructor.name ? error.constructor.name : "";
    if (code) {
      return `unexpected_${code}`;
    }
    if (name && name !== "Error") {
      return `unexpected_${name}`;
    }
  }
  return "recovery_unexpected_error";
}

function sha256(data) {
  return createSha("sha256").update(Buffer.from(data)).digest("hex");
}

async function waitForMobileBrowserReturn(signals = []) {
  if (signals.some((signal) => signal.aborted)) return false;
  if (!Platform || !Platform.isMobile || typeof document === "undefined") return true;
  return await new Promise((resolve) => {
    let sawHidden = document.hidden;
    let timer;
    const finish = (returned) => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
      window.clearTimeout(timer);
      resolve(returned);
    };
    const onVisibilityChange = () => {
      if (document.hidden) sawHidden = true;
      else if (sawHidden) finish(true);
    };
    const onAbort = () => finish(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => finish(!signals.some((signal) => signal.aborted)), 1500);
  });
}

function operationRegistry() {
  const key = "__obtsOperationRegistry";
  if (!globalThis[key]) globalThis[key] = new Map();
  return globalThis[key];
}

function operationLeaseOwner(lease) {
  return lease && lease.owner ? lease.owner : lease;
}

function randomHex(bytes) {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return Buffer.from(value).toString("hex");
}

function runtimePlatform() {
  if (Platform && Platform.isIosApp) return "ios";
  if (Platform && Platform.isAndroidApp) return "android";
  if (Platform && Platform.isMacOS) return "darwin";
  if (Platform && Platform.isWin) return "win32";
  return "linux";
}

function normalizedServerDestination(value) {
  try {
    const parsed = new URL(String(value).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function annotateDiagnosticError(error, context) {
  if (!error || typeof error !== "object") return;
  try {
    Object.defineProperty(error, DIAGNOSTIC_CONTEXT, {
      value: {
        flow: context.flow,
        stage: context.stage,
        failureCode: context.failureCode,
        breadcrumbs: (context.breadcrumbs || []).slice(0, 16)
      },
      configurable: true
    });
  } catch {
    // Some host errors are not extensible; outer classification still works.
  }
}

function isOnboardingConsentSummary(summary) {
  return summary && typeof summary.fingerprint === "string" && /^[0-9a-f]{64}$/u.test(summary.fingerprint) &&
    Number.isSafeInteger(summary.file_count) && summary.file_count >= 0 &&
    Number.isSafeInteger(summary.bytes) && summary.bytes >= 0;
}

function sameOnboardingAnalysis(a, b) {
  return ["selection", "vaultId", "expectedMain", "rootCommit", "classification", "proposalBase", "localFingerprint", "localFileCount", "localBytes"]
    .every(key => a[key] === b[key]);
}

function validateOnboardingAnalysis(analysis, mode) {
  const existing = analysis?.selection === "existing_vault";
  const classification = analysis?.classification;
  const valid = analysis && ["initialize", "merge", "use_server"].includes(mode) &&
    typeof analysis.vaultName === "string" &&
    isOnboardingConsentSummary({ fingerprint: analysis.localFingerprint, file_count: analysis.localFileCount, bytes: analysis.localBytes }) &&
    (existing
      ? typeof analysis.vaultId === "string" && analysis.vaultId.length > 0 && isGitObjectId(analysis.expectedMain) &&
        ["server_to_empty", "use_server_direct", "identical", "stale_baseline", "shared_baseline_divergent", "independent_divergent"].includes(classification) && mode !== "initialize"
      : analysis.selection === "new_vault" && analysis.vaultId === null && analysis.expectedMain === null &&
        ["new_empty", "new_with_content"].includes(classification) && mode !== "merge" &&
        (mode === "initialize" || classification === "new_empty")) &&
    (mode !== "merge" || ["shared_baseline_divergent", "independent_divergent"].includes(classification) && isGitObjectId(analysis.proposalBase)) &&
    (classification !== "server_to_empty" && classification !== "new_empty" || analysis.localFileCount === 0);
  if (!valid) throw new ObtsBlockedError("onboarding_context_required", "Setup needs a valid saved enrollment context and consent before it can scan or continue. Preserve the existing setup state for recovery.");
}

async function readRawTroubleshootingJson(fsp, filePath, validate = () => true) {
  try {
    const raw = await fsp.readFileBounded(filePath, 512 * 1024, "utf8");
    if (typeof raw !== "string") return { kind: "invalid", value: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !validate(parsed)) {
      return { kind: "invalid", value: null };
    }
    return { kind: "valid", value: parsed };
  } catch (error) {
    if (error && typeof error === "object" && String(error.code || "").toLowerCase() === "enoent") {
      return { kind: "absent", value: null };
    }
    if (error && typeof error === "object" && error.code === "EFBIG") {
      return { kind: "oversized", value: await readJournalDiagnosticSummary(fsp, filePath) };
    }
    if (error instanceof SyntaxError) {
      return { kind: "invalid", value: null };
    }
    return { kind: "unreadable", value: null };
  }
}

function isTroubleshootingState(value) {
  const nullableString = (candidate) => candidate === null || typeof candidate === "string";
  const pairedIdentity =
    (typeof value.vault_id === "string" && typeof value.device_id === "string") ||
    (value.vault_id === null && value.device_id === null);
  return pairedIdentity &&
    typeof value.status_label === "string" &&
    nullableString(value.last_error_code) &&
    nullableString(value.local_main) &&
    nullableString(value.local_head) &&
    nullableString(value.server_device_ref) &&
    Number.isSafeInteger(value.last_event_seq) && value.last_event_seq >= 0 &&
    Number.isSafeInteger(value.last_applied_event_seq) && value.last_applied_event_seq >= 0;
}

function isTroubleshootingQueue(value) {
  return typeof value.status === "string" &&
    (value.pending_commit === null || typeof value.pending_commit === "string") &&
    Array.isArray(value.changed_paths);
}

function isTroubleshootingApplyJournal(value) {
  try {
    parseApplyJournal(value);
    return true;
  } catch {
    return false;
  }
}

function isTroubleshootingOnboardingJournal(value) {
  const stages = new Set([
    "awaiting_browser",
    "approved",
    "analyzing",
    "awaiting_confirmation",
    "registering",
    "applying_uploading",
    "uploading_proposal",
    "awaiting_conflict",
    "complete",
    "blocked"
  ]);
  return value.version === 1 &&
    typeof value.stage === "string" && stages.has(value.stage) &&
    value.connection && typeof value.connection === "object" && !Array.isArray(value.connection) &&
    Object.hasOwn(value, "selected_mode") &&
    (value.last_error_code === null || typeof value.last_error_code === "string");
}

function isTroubleshootingPendingAck(value) {
  return isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.event_seq) && value.event_seq >= 0 &&
    typeof value.created_at === "string";
}

function isTroubleshootingBootstrapTransfer(value) {
  return typeof value.connection_id === "string" &&
    isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.next_cursor) && value.next_cursor >= 0 &&
    Number.isSafeInteger(value.received_chunks) && value.received_chunks >= 0 &&
    Number.isSafeInteger(value.transferred_bytes) && value.transferred_bytes >= 0 &&
    typeof value.updated_at === "string";
}

function isTroubleshootingPullTransfer(value) {
  return typeof value.vault_id === "string" && typeof value.device_id === "string" &&
    (value.current_local_main === null || isGitObjectId(value.current_local_main)) &&
    Number.isSafeInteger(value.current_event_seq) && value.current_event_seq >= 0 &&
    isGitObjectId(value.target_main) &&
    Number.isSafeInteger(value.next_cursor) && value.next_cursor >= 0 &&
    Number.isSafeInteger(value.received_chunks) && value.received_chunks >= 0 &&
    Number.isSafeInteger(value.transferred_bytes) && value.transferred_bytes >= 0 &&
    typeof value.updated_at === "string";
}

function troubleshootingEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function isTroubleshootingAttemptId(value) {
  return typeof value === "string" && /^(?:none|rca_[0-9a-f]{32})$/u.test(value);
}

function troubleshootingSafeErrorCode(value) {
  const allowed = new Set([
    "none",
    "device_blocked",
    "conflict_review_required",
    "server_recovery_required",
    "blocked_integrity",
    "device_revoked",
    "device_identity_mismatch",
    "not_paired",
    "sync_lease_blocked",
    "operation_interrupted_by_reload",
    "local_state_incomplete",
    "same_device_non_fast_forward",
    "apply_recovery_required",
    "apply_journal_recovery_required",
    "onboarding_context_required",
    "onboarding_identity_mismatch",
    "onboarding_snapshot_changed",
    "invalid_transfer_checkpoint",
    "applied_main_acknowledgement_failed",
    "recovery_evidence_missing",
    "recovery_checksum_mismatch",
    "recovery_identity_mismatch",
    "recovery_target_policy_mismatch",
    "recovery_state_corrupt",
    "catchup_recovery_required",
    "catchup_local_changes",
    "local_files_diverge_from_journal",
    "local_changed_during_apply",
    "preflight_hash_changed",
    "recovery_bundle_failed",
    "directory_recovery_decision_required",
    "directory_recovery_changed",
    "directory_recovery_journal_invalid",
    "object_too_large_for_chunk",
    "pack_preparation_failed",
    "network_error",
    "http_error",
    "sync_error",
    "unknown"
  ]);
  if (value === null || value === undefined || value === "") return "none";
  return allowed.has(value) ? value : "unknown";
}

function troubleshootingLeaseState(plugin) {
  try {
    const lease = operationRegistry().get(plugin.app.vault.adapter);
    if (!lease) return "available";
    const owner = operationLeaseOwner(lease);
    if (lease.retiring) return "retiring";
    if (owner && owner.unloaded) return "restart_required";
    if (owner === plugin) return "owned_active";
    return "other_active";
  } catch {
    return "unknown";
  }
}

function troubleshootingStatusClass(label) {
  if (label === null || label === undefined) return "unpaired";
  if (label === "Checking" || label === "Applying" || label === "Uploading" || label === "Merging") return "checking";
  if (label === "Synced") return "synced";
  if (label === "Ahead") return "ahead";
  if (label === "Behind") return "behind";
  if (label === "Conflict resolution needed" || label === "Review needed" || label === "Stale review") return "review";
  if (label === "Out of sync — local recovery required" || label === "Needs recovery") return "recovery";
  if (label === "Out of sync" || label === "Out of sync — file exceeds upload limit" || label === "Out of sync — upload limit exceeded" || label === "Unsafe local state") return "out_of_sync";
  if (label === "Blocked" || label === "Integrity failure") return "unsafe";
  if (label === "Offline" || label === "Retrying" || label === "Server retrying") return "retrying";
  return "other";
}

function troubleshootingQueueState(read) {
  if (read.kind === "absent") return "absent";
  if (read.kind === "invalid") return "invalid";
  if (read.kind === "unreadable" || read.kind === "oversized") return "unreadable";
  const queue = read.value;
  if (queue.status === "conflicted") return "conflicted";
  if (typeof queue.pending_commit === "string" && queue.pending_commit) return "pending_upload";
  if (Array.isArray(queue.changed_paths) && queue.changed_paths.length > 0) return "hint_only";
  if (queue.status === "idle" || queue.status === "merged" || queue.status === "queued_local") return "idle";
  return "invalid";
}

function troubleshootingApplyJournalState(read) {
  if (read.kind === "oversized" && !read.value) return "present_unclassified";
  if (read.kind !== "valid" && read.kind !== "oversized") return read.kind;
  return troubleshootingEnum(read.value.phase, [
    "planned",
    "recovery_bundle_written",
    "writing_files",
    "verifying",
    "committed",
    "blocked_recovery"
  ], "invalid");
}

function troubleshootingOnboardingState(read) {
  if (read.kind === "oversized" && !read.value) return "unreadable";
  if (read.kind !== "valid" && read.kind !== "oversized") return read.kind;
  return troubleshootingEnum(read.value.stage, [
    "awaiting_browser",
    "approved",
    "analyzing",
    "awaiting_confirmation",
    "awaiting_conflict",
    "registered",
    "blocked",
    "complete"
  ], "other");
}

function troubleshootingPresence(read) {
  if (read.kind === "valid") return "present";
  return read.kind === "oversized" ? "unreadable" : read.kind;
}

function troubleshootingCombinedPresence(reads) {
  if (reads.some((read) => read.kind === "unreadable" || read.kind === "oversized" && !read.value)) return "unreadable";
  if (reads.some((read) => read.kind === "invalid")) return "invalid";
  if (reads.some((read) => read.kind === "valid" || read.kind === "oversized" && read.value)) return "present";
  return "absent";
}

function combineTroubleshootingCursorGuards(current, next) {
  if (!current || current === "not_observed") return next;
  if (!next || next === "not_observed" || next === "no_preservation") return current;
  if (current === "no_preservation") return next;
  return current === next ? current : "multiple";
}

function troubleshootingCursorRelation(left, right) {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) return "both_null";
  if (leftMissing) return "left_null";
  if (rightMissing) return "right_null";
  if (typeof left !== "string" || typeof right !== "string") return "unknown";
  return left === right ? "equal" : "different";
}

function troubleshootingSequenceRelation(left, right) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return "invalid";
  if (left === right) return "equal";
  return left < right ? "behind" : "ahead";
}

function troubleshootingCursorRelationsForState(state, server) {
  return {
    local_head_to_local_main: troubleshootingCursorRelation(state && state.local_head, state && state.local_main),
    server_ref_to_local_head: troubleshootingCursorRelation(state && state.server_device_ref, state && state.local_head),
    local_main_to_server_main: troubleshootingCursorRelation(state && state.local_main, server && server.current_main),
    event_to_applied: troubleshootingSequenceRelation(state && state.last_event_seq, state && state.last_applied_event_seq),
    event_to_server: troubleshootingSequenceRelation(state && state.last_event_seq, server && server.event_seq)
  };
}

function troubleshootingHttpStatus(status) {
  if (status === null || status === undefined) return "none";
  if (status === 0) return "network";
  if (Number.isInteger(status) && status >= 200 && status < 300) return "success";
  if ([400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504].includes(status)) return `http_${status}`;
  if (Number.isInteger(status) && status >= 400 && status < 500) return "other_4xx";
  if (Number.isInteger(status) && status >= 500 && status < 600) return "other_5xx";
  return "unknown";
}

function troubleshootingTransitionSignature(context) {
  return JSON.stringify(Object.assign({}, context, { attempt_id: "none" }));
}

function rememberDiagnosticDeadline(cache, signature, delay) {
  cache.set(signature, Date.now() + delay);
  while (cache.size > 128) cache.delete(cache.keys().next().value);
}

async function diagnosticRejectionNotice(response) {
  const guidance = {
    diagnostic_rate_limited: "The diagnostic rate limit was reached. Retry later.",
    diagnostic_quota_exceeded: "The diagnostic storage quota was reached. Ask the server operator to review retention.",
    diagnostic_reporting_disabled: "Diagnostic ingestion is disabled on this server.",
    invalid_request: "The server rejected the report format. Check plugin and server versions.",
    unsupported_diagnostic_schema: "The server does not support this report format. Check plugin and server versions."
  };
  let code;
  try { code = (await response.json())?.error?.code; } catch { code = null; }
  const known = typeof code === "string" && Object.hasOwn(guidance, code);
  const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? `HTTP ${response.status}` : "request rejected";
  return `obts: Snapshot rejected (${status}${known ? `, ${code}` : ""}). ${known ? guidance[code] : "Check the server connection and retry; local sync evidence is unchanged."}`;
}

function buildTroubleshootingDiagnostic(context) {
  const blocked = context.safe_error_code !== "none" && context.safe_error_code !== "unknown";
  return {
    schema_version: 2,
    event_id: `dgr_${randomHex(16)}`,
    plugin_version: PLUGIN_VERSION,
    obsidian_version: typeof apiVersion === "string" && apiVersion ? apiVersion : "unknown",
    platform_family: Platform && Platform.isIosApp ? "ios" : Platform && Platform.isAndroidApp ? "android" : "desktop",
    flow: "recovery",
    stage: "recovery",
    failure_code: "troubleshooting_snapshot",
    error_class: blocked ? "blocked_error" : "unknown",
    retryable: false,
    breadcrumbs: [],
    context
  };
}

function diagnosticContextForError(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current[DIAGNOSTIC_CONTEXT]) return current[DIAGNOSTIC_CONTEXT];
    current = current.cause;
  }
  return null;
}

function elapsedDiagnosticBucket(elapsedMs) {
  if (elapsedMs < 30_000) return "under_30s";
  if (elapsedMs < 60_000) return "30s_to_1m";
  if (elapsedMs < 5 * 60_000) return "1m_to_5m";
  if (elapsedMs < 15 * 60_000) return "5m_to_15m";
  return "over_15m";
}

function buildMeasuredPhaseDiagnostic(phase) {
  return {
    schema_version: 3,
    event_id: `dgr_${randomHex(16)}`,
    plugin_version: PLUGIN_VERSION,
    obsidian_version: typeof apiVersion === "string" && apiVersion ? apiVersion : "unknown",
    platform_family: Platform && Platform.isIosApp ? "ios" : Platform && Platform.isAndroidApp ? "android" : "desktop",
    flow: "plugin",
    stage: "plugin_lifecycle",
    failure_code: "operation_stalled",
    error_class: "unknown",
    retryable: false,
    breadcrumbs: [],
    phase: phase.point,
    phase_id: phase.phaseId,
    observation: phase.observation,
    elapsed_bucket: elapsedDiagnosticBucket(phase.elapsedMs)
  };
}

function buildStalledOperationDiagnostic(diagnosticPoint) {
  const recovery = diagnosticPoint.startsWith("recovery_");
  const apply = diagnosticPoint === "apply" || diagnosticPoint.startsWith("apply_");
  const onboarding = diagnosticPoint === "onboarding_download";
  const sync = ["sync_request", "sync_download", "transfer_checkpoint_verification", "local_snapshot", "upload_prepare", "upload_finalize"].includes(diagnosticPoint);
  return {
    schema_version: 1,
    event_id: `dgr_${randomHex(16)}`,
    plugin_version: PLUGIN_VERSION,
    obsidian_version: typeof apiVersion === "string" && apiVersion ? apiVersion : "unknown",
    platform_family: Platform && Platform.isIosApp ? "ios" : Platform && Platform.isAndroidApp ? "android" : "desktop",
    flow: recovery ? "recovery" : apply ? "apply" : onboarding ? "onboarding" : sync ? "sync" : "plugin",
    stage: recovery ? "recovery" : apply ? "apply" : onboarding ? "bootstrap_request" : sync ? "sync_request" : "plugin_lifecycle",
    failure_code: "operation_stalled",
    error_class: "unknown",
    retryable: true,
    breadcrumbs: [{
      point: diagnosticPoint,
      outcome: "started",
      value_kind: "unknown",
      size_bucket: "unknown",
      error_code: "none"
    }]
  };
}

function buildDiagnosticReport(error) {
  const context = diagnosticContextForError(error);
  const message = error instanceof Error ? error.message : "";
  const safeErrorCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  const transport = error instanceof ObtsTransportError;
  const blocked = error instanceof ObtsBlockedError;
  const lifecycleFailure = safeErrorCode === "operation_interrupted_by_reload" || safeErrorCode === "sync_lease_blocked";
  const directoryRecoveryFailure = safeErrorCode === "directory_recovery_decision_required" || safeErrorCode === "directory_recovery_changed" || safeErrorCode === "directory_recovery_journal_invalid";
  const failureCode = context && context.failureCode
    ? context.failureCode
    : safeErrorCode === "invalid_json"
      ? "invalid_json"
      : safeErrorCode === "operation_interrupted_by_reload" || safeErrorCode === "sync_lease_blocked"
        ? safeErrorCode
      : message.includes("Missing Buffer dependency")
      ? "missing_buffer_dependency"
      : message.includes("pack.slice")
        ? "null_pack_slice"
        : safeErrorCode === "object_too_large_for_chunk"
          ? "object_too_large_for_chunk"
        : directoryRecoveryFailure
          ? safeErrorCode
          : transport
        ? "request_failed"
        : blocked
          ? "sync_failed"
          : "unknown";
  return {
    schema_version: 1,
    event_id: `dgr_${randomHex(16)}`,
    plugin_version: PLUGIN_VERSION,
    obsidian_version: typeof apiVersion === "string" && apiVersion ? apiVersion : "unknown",
    platform_family: Platform && Platform.isIosApp ? "ios" : Platform && Platform.isAndroidApp ? "android" : "desktop",
    flow: context && context.flow ? context.flow : directoryRecoveryFailure ? "recovery" : lifecycleFailure ? "plugin" : blocked || transport ? "sync" : "plugin",
    stage: context && context.stage ? context.stage : directoryRecoveryFailure ? "recovery" : lifecycleFailure ? "plugin_lifecycle" : transport ? "sync_request" : "unknown",
    failure_code: failureCode,
    error_class: transport ? "transport_error" : blocked ? "blocked_error" : error instanceof TypeError ? "type_error" : error instanceof Error ? "error" : "unknown",
    retryable: transport ? isOfflineTransportError(error) || isRetryableServerError(error) : false,
    breadcrumbs: safeErrorCode === "object_too_large_for_chunk" && Number.isSafeInteger(error.details?.object_bytes)
      ? [makeDiagnosticBreadcrumb("upload_prepare", "failed", { byteLength: error.details.object_bytes })]
      : context && Array.isArray(context.breadcrumbs) ? context.breadcrumbs.slice(0, 16).map(normalizeDiagnosticBreadcrumb) : []
  };
}

function makeDiagnosticBreadcrumb(point, outcome, value = undefined, errorCode = "none") {
  return normalizeDiagnosticBreadcrumb({
    point,
    outcome,
    valueKind: diagnosticValueKind(value),
    sizeBucket: diagnosticSizeBucket(value),
    errorCode
  });
}

function normalizeDiagnosticBreadcrumb(event) {
  const points = new Set(["onboarding_approved", "bootstrap_response", "multipart_pack", "pack_persist_write", "pack_persist_read", "index_fs_stat", "index_fs_read_file", "index_fs_read", "index_fs_write", "index_pack", "sync_request", "sync_download", "onboarding_download", "transfer_checkpoint_verification", "apply", "apply_recovery_prepare", "apply_preflight_revalidate", "apply_write", "apply_verify", "apply_local_capture", "apply_finalize", "local_snapshot", "directory_inventory", "file_inventory_check", "local_preservation", "provenance", "upload_prepare", "upload_finalize", "recovery", "recovery_directory_decision", "startup_metadata", "startup_git", "startup_state", "recovery_journal", "recovery_target_commit", "recovery_target_tree", "recovery_file_validation", "recovery_bundle", "recovery_file_apply", "recovery_refs", "recovery_state"]);
  const outcomes = new Set(["started", "returned", "succeeded", "failed"]);
  const valueKinds = new Set(["buffer", "uint8array", "arraybuffer", "string", "null", "other", "unknown"]);
  const sizeBuckets = new Set(["empty", "under_64k", "under_1m", "under_16m", "under_64m", "over_64m", "unknown"]);
  const errorCodes = new Set(["none", "enoent", "eexist", "eisdir", "enotdir", "enotempty", "eacces", "eperm", "eio", "invalid_type", "unknown"]);
  return {
    point: points.has(event && event.point) ? event.point : "index_pack",
    outcome: outcomes.has(event && event.outcome) ? event.outcome : "failed",
    value_kind: valueKinds.has(event && (event.valueKind || event.value_kind)) ? event.valueKind || event.value_kind : "unknown",
    size_bucket: sizeBuckets.has(event && (event.sizeBucket || event.size_bucket)) ? event.sizeBucket || event.size_bucket : "unknown",
    error_code: errorCodes.has(event && (event.errorCode || event.error_code)) ? event.errorCode || event.error_code : "unknown"
  };
}

function diagnosticValueKind(value) {
  if (value === undefined || value === null) return "null";
  if (Buffer.isBuffer(value)) return "buffer";
  if (value instanceof Uint8Array) return "uint8array";
  if (value instanceof ArrayBuffer) return "arraybuffer";
  if (typeof value === "string") return "string";
  return "other";
}

function diagnosticSizeBucket(value) {
  const size = typeof value === "string" ? value.length : value && typeof value.byteLength === "number" ? value.byteLength : null;
  if (size === null) return "unknown";
  if (size === 0) return "empty";
  if (size < 64 * 1024) return "under_64k";
  if (size < 1024 * 1024) return "under_1m";
  if (size < 16 * 1024 * 1024) return "under_16m";
  if (size < 64 * 1024 * 1024) return "under_64m";
  return "over_64m";
}

function diagnosticIoCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = typeof current.code === "string" ? current.code.toLowerCase() : "";
    if (new Set(["enoent", "eexist", "eisdir", "enotdir", "enotempty", "eacces", "eperm", "eio"]).has(code)) return code;
    current = current.cause;
  }
  return "unknown";
}

async function fetchWithTimeout(url, options = {}) {
  let response;
  try {
    response = await requestUrl({
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      ...(options.body === undefined ? {} : { body: normalizeRequestBody(options.body) }),
      throw: false
    });
  } catch (error) {
    throw new ObtsTransportError(0, "network_error", "Unable to reach the obts server.", undefined, error);
  }
  const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    json: async () => response.json !== undefined ? response.json : JSON.parse(response.text),
    arrayBuffer: async () => response.arrayBuffer,
    text: async () => response.text
  };
}

function createMultipartBody(parts) {
  const boundary = `----obts-${randomHex(12)}`;
  const chunks = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n`));
    chunks.push(Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: toArrayBuffer(Buffer.concat(chunks)) };
}

function normalizeRequestBody(body) {
  if (typeof body === "string" || body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  throw new Error("Unsupported request body type.");
}

function toArrayBuffer(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function nowIso() {
  return new Date().toISOString();
}

module.exports.createRootIgnorePolicy = createRootIgnorePolicy;
module.exports.ObtsClientCore = ObtsObsidianClient;
module.exports.PluginBlockedError = ObtsBlockedError;
module.exports.TransportError = ObtsTransportError;
module.exports.buildTroubleshootingDiagnostic = buildTroubleshootingDiagnostic;

module.exports.installPathMutationGate = installPathMutationGate;
