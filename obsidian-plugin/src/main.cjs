const obtsRuntime = globalThis.__OBTS_CLIENT_RUNTIME__ || require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, requestUrl, apiVersion } = obtsRuntime;
const { Buffer } = require("buffer");
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
const git = require("isomorphic-git");
const path = require("path-browserify");
const createSha = require("sha.js");
const { createDataAdapterFs, createPackIndexFs, createReadOverlayFs } = require("./data-adapter-fs.cjs");
const { createByteBudget, runBoundedWork } = require("./work-pool.cjs");

const API_VERSION = obtsRuntime.obtsApiVersion || "__OBTS_API_VERSION__";
const PLUGIN_VERSION = obtsRuntime.obtsPluginVersion || "__OBTS_PLUGIN_VERSION__";
const SYNC_DEBOUNCE_MS = 1500;
const BACKGROUND_SYNC_INTERVAL_MS = 10 * 1000;
const PERIODIC_FULL_SCAN_INTERVAL_MS = 5 * 60 * 1000;
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
const MOBILE_PACK_READ_ATTEMPTS = 5;
const MOBILE_PACK_READ_RETRY_MS = 100;
const RETIRED_OPERATION_GRACE_MS = 1500;
const PLUGIN_UPDATE_URL = "obsidian://brat?plugin=nareto%2Fobts";
const DIAGNOSTIC_CONSENT_VERSION = 1;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    this.currentStatusLabel = null;
    this.statusNeedsRecoveryNotice = false;
    this.degradedStatusTimer = null;
    this.degradedStatusBase = null;
    this.degradedStatusNotifiedBase = null;
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
    this.syncQueued = false;
    this.syncRunning = false;
    this.transientSyncFailures = 0;
    this.automaticRetryNotBefore = 0;
    this.lastFullScanCompletedAt = null;
    this.lastCheckingProgressAt = 0;
    this.isApplying = false;
    this.pluginCompatibilityNoticeKey = null;
    this.pluginUpdateUrl = PLUGIN_UPDATE_URL;
    this.unloaded = false;
    this.lifecycleAbortController = new AbortController();
    this.queuedSyncTimer = null;
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
    this.layoutStarted = false;
    this.reportedDiagnosticErrors = new WeakSet();
    this.diagnosticNoticeShown = false;
    this.deviceNameRevision = 0;
    this.setStatus("Checking");
    this.client = new ObtsObsidianClient(this);

    this.addSettingTab(new ObtsSettingTab(this.app, this));

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
      id: "obts-replace-local-with-server",
      name: "Replace local with server state",
      callback: async () => {
        const result = await this.runUserAction(() => this.client.replaceLocalWithServer());
        if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
      }
    });

    this.addCommand({
      id: "obts-rebuild-from-server-main",
      name: "Rebuild from server main",
      callback: async () => {
        const result = await this.runUserAction(() => this.client.rebuildFromServerMain());
        if (result && shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
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
        });
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
  }

  startAfterLayoutReady() {
    if (this.unloaded || this.layoutStarted) return;
    this.layoutStarted = true;
    this.registerEvent(this.app.vault.on("create", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.queueSyncFromWatcher(file && file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.queueSyncFromWatcher([file && file.path, oldPath])));
    if (this.operationAvailability() === "available") {
      void this.initializeClient().catch(() => this.handleClientInitializationFailure());
    } else {
      this.observeRetiredOperation();
    }
  }

  onunload() {
    this.unloaded = true;
    this.lifecycleAbortController.abort();
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (operationLeaseOwner(lease) === this && lease && lease.owner) lease.retiring = true;
    if (this.queuedSyncTimer !== null) {
      window.clearTimeout(this.queuedSyncTimer);
      this.queuedSyncTimer = null;
    }
    if (this.retiredOperationTimer !== null) {
      window.clearTimeout(this.retiredOperationTimer);
      this.retiredOperationTimer = null;
    }
    this.clearInitializationWatchdog();
    this.initializationDiagnosticToken = null;
    this.clearOperationProgress();
    this.clearDegradedStatusTimer();
  }

  async initializeClient() {
    if (this.clientReady) return;
    if (!this.clientInitialization) {
      this.clientInitialization = (async () => {
        if (this.unloaded || !this.beginSync()) {
          throw new ObtsBlockedError("sync_lease_blocked", this.syncBlockedMessage());
        }
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
          }
        } finally {
          this.endSync();
        }
      })();
    }
    try {
      await this.clientInitialization;
    } finally {
      this.clientInitialization = null;
    }
  }

  handleClientInitializationFailure() {
    if (this.unloaded) return;
    this.clearInitializationWatchdog();
    this.initializationDiagnosticToken = null;
    this.clientReady = false;
    this.setStatus("Recovery required");
    new Notice("obts could not finish local recovery after the plugin update. Fully restart Obsidian, then open obts settings.", 15000);
  }

  async ensureClientReady() {
    if (this.unloaded) return false;
    if (this.clientReady) return true;
    if (this.clientInitialization) {
      try {
        await this.clientInitialization;
        return this.clientReady;
      } catch {
        this.handleClientInitializationFailure();
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
    } catch {
      this.handleClientInitializationFailure();
      return false;
    }
  }

  setInitializationStage(label, diagnosticPoint) {
    this.initializationStage = label;
    this.initializationStageStartedAt = Date.now();
    this.initializationDiagnosticPoint = diagnosticPoint;
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
    if (this.clientInitialization) this.initializationStage = label;
  }

  setOperationProgress(label, diagnosticPoint) {
    if (this.activeOperationDiagnosticPoint !== diagnosticPoint) {
      this.clearOperationStage();
      this.activeOperationDiagnosticPoint = diagnosticPoint || null;
      if (diagnosticPoint) {
        this.operationWatchdogTimer = window.setTimeout(() => {
          this.operationWatchdogTimer = null;
          if (
            this.unloaded ||
            this.activeOperationDiagnosticPoint !== diagnosticPoint ||
            this.reportedOperationStalls.has(diagnosticPoint) ||
            !this.diagnosticSharingEnabled()
          ) return;
          this.reportedOperationStalls.add(diagnosticPoint);
          void this.reportOperationStall(diagnosticPoint);
        }, INITIALIZATION_STALL_DIAGNOSTIC_MS);
      }
    }
    this.activeOperationProgressLabel = label;
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
      const response = await fetchWithTimeout(`${consentDestination}${route}`, {
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
        new Notice(`obts sent a sanitized error diagnostic to ${consentDestination}.`);
      }
    } catch {
      // Diagnostic delivery is best effort and never changes sync behavior.
    }
  }

  async reportOperationStall(diagnosticPoint) {
    if (this.unloaded || !this.diagnosticSharingEnabled()) return;
    const consentDestination = this.settings.diagnosticConsentServer;
    let token;
    try {
      const state = await this.client.readState();
      if (!state.vault_id || !state.device_id) return;
      token = await this.client.readDeviceToken();
      if (
        this.unloaded ||
        !this.diagnosticSharingEnabled() ||
        this.settings.diagnosticConsentServer !== consentDestination
      ) return;
      const response = await fetchWithTimeout(`${consentDestination}/api/v1/device/diagnostic-events`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(buildStalledOperationDiagnostic(diagnosticPoint))
      });
      if (response.ok && !this.diagnosticNoticeShown) {
        this.diagnosticNoticeShown = true;
        new Notice(`obts sent a sanitized stalled-operation diagnostic to ${consentDestination}.`);
      }
    } catch {
      // Stall reporting must not alter or interrupt sync.
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
    if (statusBaseLabel(this.currentStatusLabel) === "Review needed") {
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
    if (this.isApplying) {
      return;
    }
    this.syncQueued = true;
    if (!this.clientReady) return;
    if (!this.syncRunning) this.setStatus("Checking");
    for (const candidate of Array.isArray(paths) ? paths : [paths]) {
      if (typeof candidate === "string" && candidate.length > 0) this.pendingWatcherPaths.add(candidate);
    }
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
    if (state.last_error_code && state.last_error_code !== "conflict_review_required" && !isRetryableLocalError(state.last_error_code)) {
      await this.client.reportDeviceStatus().catch(() => undefined);
      return;
    }
    const queue = await this.client.readQueue();
    const fullScanDue = this.lastFullScanCompletedAt === null ||
      Date.now() - this.lastFullScanCompletedAt >= PERIODIC_FULL_SCAN_INTERVAL_MS;
    if (queue.pending_commit || queue.status === "queued_local" || fullScanDue) {
      await this.runAutomaticSync();
      return;
    }
    await this.runRemotePoll();
  }

  async runRemotePoll() {
    if (!this.beginSync()) return;
    try {
      await this.client.pollRemoteEventsAndApply();
      this.clearTransientSyncFailures();
      this.setStatus((await this.client.readState()).status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
    } catch (error) {
      await this.handleAutomaticSyncError(error);
    } finally {
      this.endSync();
      if (this.syncQueued) this.scheduleQueuedSync(0);
    }
  }

  markFullScanCompleted() {
    this.lastFullScanCompletedAt = Date.now();
  }

  async runAutomaticSync() {
    if (this.unloaded || (typeof document !== "undefined" && document.hidden) || !(await this.ensureClientReady()) || this.isSyncInProgress()) {
      return;
    }
    if (await this.client.readPendingOnboarding()) return;
    if (!this.beginSync()) return;
    try {
      const state = await this.client.readState();
      if (!state.vault_id || !state.device_id) {
        return;
      }
      if (state.last_error_code && state.last_error_code !== "conflict_review_required" && !isRetryableLocalError(state.last_error_code)) {
        await this.client.reportDeviceStatus().catch(() => undefined);
        return;
      }
      await this.syncOnceOrPollResolvedConflict({ confirmInitialImport: false });
      this.clearTransientSyncFailures();
      this.setStatus((await this.client.readState()).status_label);
      await this.client.reportDeviceStatus().catch(() => undefined);
    } catch (error) {
      await this.handleAutomaticSyncError(error);
    } finally {
      this.endSync();
      if (this.syncQueued) this.scheduleQueuedSync(0);
    }
  }

  async handleAutomaticSyncError(error) {
    void this.reportDeviceError(error);
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

  async runUserAction(fn, showNotice = true) {
    if (!(await this.ensureClientReady()) || this.isSyncInProgress()) {
      return;
    }
    if (!this.beginSync()) return;
    try {
      const result = await fn();
      this.setStatus((await this.client.readState()).status_label);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "obts sync failed.";
      if (error instanceof ObtsTransportError && !isPermanentTransportError(error)) {
        await this.handleAutomaticSyncError(error);
        if (showNotice) new Notice(message);
        return;
      }
      void this.reportDeviceError(error);
      const preserveError = error instanceof ObtsBlockedError || isPermanentTransportError(error);
      const code = preserveError ? error.code : "sync_error";
      await this.client.markBlocked(code, preserveError ? error.details : undefined);
      const blockedState = await this.client.readState();
      this.setStatus(blockedState.status_label, { notify: preserveError });
      await this.client.reportDeviceStatus().catch(() => undefined);
      if (showNotice && (!preserveError || shouldShowRoutineStatusNotice(blockedState.status_label))) {
        new Notice(message);
      }
    } finally {
      this.endSync();
    }
  }

  async runExclusiveAction(fn) {
    if (!(await this.ensureClientReady()) || !this.beginSync()) {
      const code = this.operationAvailability() === "restart_required" || this.unloaded
        ? "operation_interrupted_by_reload"
        : "sync_lease_blocked";
      throw new ObtsBlockedError(code, this.syncBlockedMessage());
    }
    try {
      return await fn();
    } finally {
      this.endSync();
    }
  }

  async runOnboardingAction(fn) {
    return await this.runExclusiveAction(fn);
  }

  operationAvailability() {
    const lease = operationRegistry().get(this.app.vault.adapter);
    if (!lease) return "available";
    const owner = operationLeaseOwner(lease);
    if (owner === this) return "busy";
    if ((lease && lease.retiring) || (owner && owner.unloaded)) return "restart_required";
    return "busy";
  }

  syncBlockedMessage() {
    return this.unloaded || this.operationAvailability() === "restart_required"
      ? "A plugin update interrupted an active operation. Fully restart Obsidian before continuing setup or sync."
      : "Another obts operation is still running.";
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
        } catch {
          this.handleClientInitializationFailure();
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
          .catch(() => this.handleClientInitializationFailure());
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

  beginSync() {
    const registry = operationRegistry();
    if (this.unloaded || registry.has(this.app.vault.adapter)) return false;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    registry.set(this.app.vault.adapter, {
      owner: this,
      retiring: false,
      completion,
      resolveCompletion
    });
    this.syncRunning = true;
    this.operationSlowTimer = window.setTimeout(() => {
      this.operationSlowTimer = null;
      if (this.unloaded || !this.syncRunning) return;
      this.activeOperationSlow = true;
      if (this.activeOperationProgressLabel) {
        this.setStatus(`${this.activeOperationProgressLabel} (taking longer than expected)`, { notify: false });
      }
    }, INITIALIZATION_STALL_DIAGNOSTIC_MS);
    this.scheduleOperationStatusHeartbeat();
    return true;
  }

  endSync() {
    this.clearOperationProgress();
    const registry = operationRegistry();
    const lease = registry.get(this.app.vault.adapter);
    if (operationLeaseOwner(lease) === this) {
      registry.delete(this.app.vault.adapter);
      if (lease && typeof lease.resolveCompletion === "function") lease.resolveCompletion();
    }
    this.syncRunning = false;
  }
};

class ObtsObsidianClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.adapter = plugin.app.vault.adapter;
    this.adapterFs = createDataAdapterFs(this.adapter);
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
    this.applyLockPath = path.join(this.obtsDir, "apply.lock");
    this.onboardingJournalPath = path.join(this.obtsDir, "onboarding.json");
    this.pendingConnectionPath = path.join(this.obtsDir, "auth", "pending-connection.json");
    this.bootstrapTransferPath = path.join(this.obtsDir, "bootstrap-transfer.json");
    this.pullTransferPath = path.join(this.obtsDir, "pull-transfer.json");
    this.onboardingOperation = false;
    this.queueMutation = Promise.resolve();
    this.packPlanCache = new Map();
  }

  async initialize() {
    this.plugin.setInitializationStage("Recovering metadata replacements", "startup_metadata");
    await this.recoverInterruptedReplacements();
    this.plugin.setInitializationStage("Opening local Git state", "startup_git");
    await this.fsp.mkdir(path.join(this.obtsDir, "auth"), { recursive: true, mode: 0o700 });
    await git.init({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, defaultBranch: "local" });
    await git.writeRef({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, ref: "HEAD", value: "refs/heads/local", symbolic: true, force: true });
    await this.fsp.mkdir(path.join(this.gitdir, "info"), { recursive: true, mode: 0o700 });
    await this.fsp.writeFile(path.join(this.gitdir, "info", "exclude"), ".obts/\n.git/\n", { mode: 0o600 });
    this.plugin.setInitializationStage("Reading local sync state", "startup_state");
    const state = await this.repairLocalStateIfNeeded(await this.readState());
    this.plugin.setInitializationStage("Checking interrupted apply journal", "recovery_journal");
    const journal = await readApplyJournalStrict(this.fsp, this.applyJournalPath);
    if (journal) this.plugin.setInitializationStage("Recovering an interrupted apply", "recovery_journal");
    if (journal && journal.phase === "committed") {
      this.plugin.setInitializationStage("Restoring recovered refs", "recovery_refs");
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      this.plugin.setInitializationStage("Persisting recovered sync state", "recovery_state");
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
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
        status_label: "Unsafe local state",
        last_error_code: "apply_journal_recovery_required",
        updated_at: nowIso()
      }));
      return;
    }
    this.plugin.setInitializationStage("Persisting recovered metadata", "startup_state");
    await this.writeState(Object.assign({}, state, {
      status_label: state.status_label || "Checking",
      updated_at: nowIso()
    }));
    await this.writeQueue(await this.readQueue());
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
    const journal = await readJson(this.fsp, this.onboardingJournalPath, null);
    const pending = await readJson(this.fsp, this.pendingConnectionPath, null);
    if (!journal || journal.stage === "complete" || !pending || !pending.connection_secret) return null;
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

  async startOnboarding() {
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
      await this.fsp.rm(this.pendingConnectionPath, { force: true });
      await this.fsp.rm(this.onboardingJournalPath, { force: true });
    }
    return status;
  }

  async syncCapabilities() {
    try {
      const response = await fetchWithTimeout(this.url("/api/v1/sync/capabilities"));
      if (response.status === 404) return null;
      if (!response.ok) await throwResponseError(response);
      const capabilities = await response.json();
      return Array.isArray(capabilities.capabilities) && capabilities.capabilities.includes("git-object-pack-chunks-v1")
        ? capabilities
        : null;
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
        headers: { authorization: `Bearer ${secret}` }
      });
      if (!response.ok) await throwResponseError(response);
      return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
    }
    const checkpoint = await readJson(this.fsp, this.bootstrapTransferPath, null);
    let cursor = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.next_cursor : 0;
    let target = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.target_main : "latest";
    if (checkpoint && checkpoint.connection_id !== connectionId) await this.fsp.rm(this.bootstrapTransferPath, { force: true });
    let finalManifest = null;
    let chunkCount = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.received_chunks || 0 : 0;
    let transferredBytes = checkpoint && checkpoint.connection_id === connectionId ? checkpoint.transferred_bytes || 0 : 0;
    while (true) {
      const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}/bootstrap-chunk`), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ api_version: API_VERSION, plugin_version: PLUGIN_VERSION, cursor, requested_target: target })
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
        await this.fsp.rm(this.bootstrapTransferPath, { force: true });
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
        updated_at: nowIso()
      });
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
    const bootstrap = await this.bootstrapWithChunks(connectionId, secret);
    await this.importPack(bootstrap.packfile, "onboarding", [makeDiagnosticBreadcrumb("onboarding_approved", "succeeded")]);
    const localFiles = await this.scanSyncableFiles();
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
    return analysis;
  }

  async finishOnboarding(connectionId, secret, analysis, mode) {
    const pending = await this.readPendingOnboarding();
    if (
      !pending ||
      pending.journal.connection.connection_id !== connectionId ||
      pending.journal.selected_mode && pending.journal.selected_mode !== mode
    ) {
      throw new ObtsBlockedError("onboarding_identity_mismatch", "Pending onboarding mode does not match this setup attempt.");
    }
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
    return await postJsonWithBearer(this.url(`/api/v1/connections/${connectionId}/complete`), secret, request);
  }

  async finishOnboardingInternal(connectionId, secret, analysis, mode) {
    const current = await this.localSnapshotSummary();
    const localFiles = await this.scanSyncableFiles();
    const resumed = await this.resumeAcceptedOnboarding(connectionId, analysis, mode, localFiles);
    if (resumed) return resumed;
    if (current.fingerprint !== analysis.localFingerprint) {
      throw new ObtsBlockedError("onboarding_snapshot_changed", "The local vault changed. Review the updated onboarding summary before continuing.");
    }
    await this.createRecoveryBundle(mode === "use_server" ? "replace_local_with_server" : "initial_import", analysis.expectedMain, localFiles);
    const completion = await this.completeConnection(connectionId, secret, {
      mode,
      expected_main: analysis.expectedMain,
      ...(mode === "initialize" ? { proposal_kind: "new_vault_import" } : {}),
      ...(mode === "merge" ? {
        proposal_kind: analysis.classification === "shared_baseline_divergent" ? "shared_baseline_merge" : "independent_vault_merge",
        proposal_base: analysis.proposalBase
      } : {})
    });
    await writeJson(this.fsp, this.authPath, { device_token: completion.device_token, created_at: nowIso() });
    await this.writeState({
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
      await this.applyTargetMain(
        pulled.manifest.target_main,
        pulled.manifest.changed_paths,
        true,
        localFiles,
        false,
        pulled.manifest.directory_intents || [],
        pulled.manifest.explicit_directories || [],
        pulled.manifest.event_seq
      );
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
      await postJsonWithBearer(this.url(`/api/v1/vaults/${completion.vault_id}/onboarding/complete`), completion.device_token, {
        applied_main: pulled.manifest.target_main
      });
      await this.writeState(Object.assign({}, await this.readState(), { status_label: "Synced", updated_at: nowIso() }));
      await this.completePendingOnboarding(connectionId);
      return { status: "Synced", main: pulled.manifest.target_main };
    }
    const proposalBase = mode === "initialize" ? completion.root_commit : analysis.proposalBase;
    if (!proposalBase) throw new ObtsBlockedError("invalid_onboarding_base", "Onboarding proposal base is unavailable.");
    await this.updateRef("refs/heads/main", proposalBase, null, true);
    await this.updateRef("refs/heads/local", proposalBase, null, true);
    await this.writeState(Object.assign({}, await this.readState(), { local_main: proposalBase, local_head: proposalBase, status_label: "Ahead", updated_at: nowIso() }));
    const proposalCommit = await this.createLocalCommit("obts: onboarding local vault");
    const proposalPending = await this.readPendingOnboarding();
    if (proposalPending && proposalPending.journal.connection.connection_id === connectionId) {
      await this.writeOnboardingJournal(Object.assign({}, proposalPending.journal, {
        stage: "uploading_proposal",
        proposal_commit: proposalCommit
      }));
    }
    await this.writeQueue({ pending_commit: proposalCommit, expected_device_ref: null, status: proposalCommit ? "queued_local" : "idle", attempts: 0, updated_at: nowIso() });
    const synced = await this.syncOnce({ confirmInitialImport: false });
    if (synced.status === "Review needed") {
      await this.updateOnboardingStage(connectionId, "awaiting_conflict", mode);
      return synced;
    }
    const finalState = await this.readState();
    await postJsonWithBearer(this.url(`/api/v1/vaults/${completion.vault_id}/onboarding/complete`), completion.device_token, {
      applied_main: finalState.local_main
    });
    await this.completePendingOnboarding(connectionId);
    return synced;
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
    const localAlreadyApplied = state.local_main === self.current_main && (
      mode !== "use_server" || (
        await this.commitExists(self.current_main) && await this.localContentMatchesTree(localFiles, self.current_main)
      )
    );
    if (localAlreadyApplied && (mode === "use_server" || self.server_device_ref)) {
      await postJsonWithBearer(this.url(`/api/v1/vaults/${state.vault_id}/onboarding/complete`), token, {
        applied_main: state.local_main
      });
      await this.completePendingOnboarding(connectionId);
      return { status: state.status_label, main: state.local_main };
    }
    if (mode === "use_server") {
      await this.createRecoveryBundle("replace_local_with_server", self.current_main, localFiles);
      const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_event_seq || 0);
      await this.importPack(pulled.packfile);
      await this.applyTargetMain(
        pulled.manifest.target_main,
        pulled.manifest.changed_paths,
        true,
        localFiles,
        false,
        pulled.manifest.directory_intents || [],
        pulled.manifest.explicit_directories || [],
        pulled.manifest.event_seq
      );
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
      await postJsonWithBearer(this.url(`/api/v1/vaults/${state.vault_id}/onboarding/complete`), token, {
        applied_main: pulled.manifest.target_main
      });
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.completePendingOnboarding(connectionId);
      return { status: "Synced", main: pulled.manifest.target_main };
    }
    if (!self.server_device_ref) return null;

    await this.createRecoveryBundle("initial_import", self.current_main, localFiles);
    try {
      const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_event_seq || 0);
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
      return { status: "Review needed" };
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
    const finalState = await this.readState();
    if (!finalState.local_main) {
      throw new ObtsBlockedError("onboarding_incomplete", "Onboarding did not produce an applied server main.");
    }
    await postJsonWithBearer(this.url(`/api/v1/vaults/${state.vault_id}/onboarding/complete`), token, {
      applied_main: finalState.local_main
    });
    await this.completePendingOnboarding(connectionId);
    return { status: finalState.status_label, main: finalState.local_main };
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

  async syncOnce(options) {
    await this.initialize();
    if (!this.onboardingOperation && await this.readPendingOnboarding()) {
      throw new ObtsBlockedError("onboarding_incomplete", "Finish or cancel browser onboarding before normal sync.");
    }
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      throw new ObtsBlockedError("not_paired", "Device is not paired.");
    }
    this.throwIfSyncBlocked(state);
    await this.flushEditorBuffersToDisk();
    await this.reconcileQueueWithLocalHead(await this.readState());
    const queueBeforeScan = await this.readQueue();
    const hasCommittedLocal = Boolean(
      queueBeforeScan.pending_commit || (state.local_head && state.local_head !== state.local_main)
    );
    if (!hasCommittedLocal) {
      await this.writeState(Object.assign({}, await this.readState(), {
        status_label: "Checking",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.reportDeviceStatus().catch(() => undefined);
    }

    const localInventory = await this.listLocalVaultInventory("");
    const localFiles = assertNoCaseCollisions(localInventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    let pendingDirectoryIntents = await this.reconcileDirectoryState(localFiles, localInventory.directories);
    if (localFiles.length > 0 && !state.initial_import_confirmed && state.server_device_ref === null) {
      await this.createRecoveryBundle("initial_import", state.local_main, localFiles);
      if (!options.confirmInitialImport) {
        await this.block("initial_import_confirmation_required", "Initial import requires owner confirmation. Run the confirm initial import command after reviewing the recovery bundle.");
      }
      await this.writeState(Object.assign({}, state, { initial_import_confirmed: true, status_label: "Ahead", updated_at: nowIso() }));
    }

    let commit = await this.createLocalCommit("obts: local vault changes", localFiles);
    if (!commit && pendingDirectoryIntents.length > 0) {
      commit = await this.createMetadataCommit("obts: local directory changes");
    }
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
    } else if (pendingDirectoryIntents.length === 0 && !this.plugin.syncQueued) {
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

    this.plugin.markFullScanCompleted();
    const queue = await this.readQueue();
    let uploaded = false;
    let uploadResult = null;
    if (queue.pending_commit) {
      uploadResult = await this.uploadQueuedCommit(queue);
      uploaded = true;
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
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_event_seq || 0);
    await this.importPack(pulled.packfile);
    await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      true,
      localFiles,
      false,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq
    );
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
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_event_seq || 0);
    await this.importPack(pulled.packfile);
    const priorLocalFiles = state.local_main ? await this.listTreeFiles(state.local_main) : [];
    const pendingClassification = await this.classifyPendingCommit(queue.pending_commit, state.server_device_ref, pulled.manifest.target_main);

    await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      true,
      localFiles,
      false,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq
    );
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
    if (!state.vault_id || !state.device_id || (state.last_error_code && !isRetryableLocalError(state.last_error_code))) {
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
        change_seq: (queue.change_seq || 0) + 1,
        updated_at: nowIso()
      });
    }
    const hasCommittedLocal = Boolean(
      queue.pending_commit || (state.local_head && state.local_head !== state.local_main)
    );
    await this.writeState(Object.assign({}, state, {
      status_label: hasCommittedLocal ? "Ahead" : "Checking",
      updated_at: nowIso()
    }));
  }

  async uploadQueuedCommit(queue) {
    const state = await this.readState();
    const token = await this.readDeviceToken();
    await this.writeState(Object.assign({}, state, {
      status_label: "Preparing upload",
      last_error_code: null,
      updated_at: nowIso()
    }));
    this.plugin.setStatus("Preparing upload");
    await this.reportDeviceStatus().catch(() => undefined);
    const pendingDirectoryIntents = (await this.readDirectoryState()).pending_intents;
    let result;
    try {
      const serverState = await this.getDeviceSelf(token);
      await this.reconcileServerVaultStatus(serverState.vault_status, true);
      const capabilities = await this.syncCapabilities();
      if (capabilities) {
        result = await this.pushInChunks(state, queue, token, pendingDirectoryIntents, capabilities);
      } else {
        const packfile = await this.createPackForCommit(queue.pending_commit, [queue.expected_device_ref, state.local_main].filter(Boolean));
        const manifest = {
          api_version: API_VERSION,
          plugin_version: PLUGIN_VERSION,
          vault_id: state.vault_id,
          device_id: state.device_id,
          expected_device_ref: queue.expected_device_ref,
          target_commit: queue.pending_commit,
          packfile_sha256: sha256(packfile),
          packfile_bytes: packfile.byteLength,
          client_known_main: state.local_main,
          ...(queue.expected_device_ref === null && state.local_main ? { base_commit: state.local_main } : {}),
          ...(pendingDirectoryIntents.length > 0 ? { directory_intents: pendingDirectoryIntents } : {}),
          attempt_id: `sync_${Date.now()}_${randomHex(8)}`
        };
        await this.writeQueue(Object.assign({}, queue, { status: "uploading", attempts: queue.attempts + 1, updated_at: nowIso() }));
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
      const latestQueue = await this.readQueue();
      if (latestQueue.pending_commit === queue.pending_commit && latestQueue.status !== "blocked_recovery") {
        const permanentTransport = error instanceof ObtsTransportError &&
          !isOfflineTransportError(error) &&
          !isRetryableServerError(error);
        const errorCode = permanentTransport
          ? error.code
          : latestQueue.attempts > queue.attempts
            ? "upload_interrupted"
            : "pack_preparation_failed";
        const statusLabel = permanentTransport ? blockStatusLabel(errorCode) : "Ahead";
        await this.writeQueue(Object.assign({}, latestQueue, { status: "queued_local", updated_at: nowIso() }));
        await this.writeState(Object.assign({}, await this.readState(), {
          status_label: statusLabel,
          last_error_code: errorCode,
          updated_at: nowIso()
        }));
        this.plugin.setStatus(statusLabel);
        await this.reportDeviceStatus().catch(() => undefined);
      }
      throw error;
    }
    if (result.status === "conflicted") {
      await this.writeQueue(Object.assign({}, queue, { status: "conflicted", updated_at: nowIso() }));
      await this.writeState(Object.assign({}, state, {
        server_device_ref: result.device_ref,
        status_label: "Review needed",
        last_error_code: "conflict_review_required",
        updated_at: nowIso()
      }));
      return result;
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
        last_event_seq: Math.max(state.last_event_seq || 0, result.event_seq || 0),
        updated_at: nowIso()
      }));
      await this.clearPendingDirectoryIntents();
    }
    return result;
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

  async pushInChunks(state, queue, token, directoryIntents, capabilities, allowStaleRetry = true) {
    this.reportOperationProgress("Preparing upload (planning objects)", "upload_prepare");
    const groups = await this.planPackChunks(
      queue.pending_commit,
      [queue.expected_device_ref, state.local_main].filter(Boolean),
      capabilities.target_chunk_bytes,
      capabilities.max_chunk_bytes
    );
    if (groups.length === 0 || groups.length > capabilities.max_transfer_chunks) {
      throw new ObtsBlockedError("invalid_transfer_plan", "Git transfer plan is empty or exceeds the server chunk limit.");
    }
    const planSha256 = sha256(Buffer.from(JSON.stringify(groups)));
    const attemptId = `xfer_${sha256(Buffer.from(`${state.device_id}:${queue.pending_commit}:${queue.expected_device_ref || "none"}:${planSha256}`)).slice(0, 32)}`;
    await this.writeQueue(Object.assign({}, queue, { status: "uploading", attempts: queue.attempts + 1, updated_at: nowIso() }));
    await this.writeState(Object.assign({}, state, { status_label: "Uploading", last_error_code: null, updated_at: nowIso() }));
    this.plugin.setStatus("Uploading");
    await this.reportDeviceStatus().catch(() => undefined);
    try {
      const createResponse = await fetchWithTimeout(this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers`), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          api_version: API_VERSION,
          plugin_version: PLUGIN_VERSION,
          vault_id: state.vault_id,
          device_id: state.device_id,
          expected_device_ref: queue.expected_device_ref,
          target_commit: queue.pending_commit,
          client_known_main: state.local_main,
          ...(queue.expected_device_ref === null && state.local_main ? { base_commit: state.local_main } : {}),
          ...(directoryIntents.length > 0 ? { directory_intents: directoryIntents } : {}),
          attempt_id: attemptId,
          chunk_count: groups.length,
          plan_sha256: planSha256
        })
      });
      if (!createResponse.ok) await throwResponseError(createResponse);
      const descriptor = await createResponse.json();
      if (descriptor.status !== "open") {
        if (descriptor.result && descriptor.result.status !== "rejected") return descriptor.result;
        throw new ObtsBlockedError("transfer_closed", "The resumable transfer is closed without an accepted result.");
      }
      const received = new Set(descriptor.received_chunks || []);
      let uploadedChunks = [...received].filter((index) => Number.isInteger(index) && index >= 0 && index < groups.length).length;
      this.plugin.setStatus(`Uploading ${uploadedChunks}/${groups.length}`);
      for (let index = 0; index < groups.length; index += 1) {
        if (received.has(index)) continue;
        this.reportOperationProgress(
          `Preparing upload (packing chunk ${index + 1}/${groups.length})`,
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
      const finalizeResponse = await fetchWithTimeout(
        this.url(`/api/v1/vaults/${state.vault_id}/sync/push-transfers/${descriptor.transfer_id}/finalize`),
        { method: "POST", headers: { authorization: `Bearer ${token}` } }
      );
      if (!finalizeResponse.ok) await throwResponseError(finalizeResponse);
      return await finalizeResponse.json();
    } catch (error) {
      if (allowStaleRetry && error instanceof ObtsTransportError && error.code === "stale_device_ref") {
        const self = await this.getDeviceSelf(token);
        const recoveredRef = self.server_device_ref;
        if (recoveredRef && recoveredRef !== queue.expected_device_ref && await this.isAncestor(recoveredRef, queue.pending_commit)) {
          const recoveredQueue = Object.assign({}, queue, { expected_device_ref: recoveredRef, status: "uploading", updated_at: nowIso() });
          await this.writeQueue(recoveredQueue);
          await this.writeState(Object.assign({}, state, { server_device_ref: recoveredRef, status_label: "Preparing upload", updated_at: nowIso() }));
          return await this.pushInChunks(Object.assign({}, state, { server_device_ref: recoveredRef }), recoveredQueue, token, directoryIntents, capabilities, false);
        }
      }
      throw error;
    }
  }

  async retryPushAfterStaleDeviceRef(state, queue, token, manifest, packfile) {
    const self = await this.getDeviceSelf(token);
    const recoveredRef = self.server_device_ref;
    if (!recoveredRef || recoveredRef === queue.expected_device_ref || !(await this.isAncestor(recoveredRef, queue.pending_commit))) {
      return null;
    }
    await this.writeQueue(Object.assign({}, queue, {
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

  async pullAndApply(allowDestructive) {
    let state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return false;
    }
    this.throwIfSyncBlocked(state);
    if (!(await this.ensureNoQueuedLocalChangesBeforeApply(state))) {
      return false;
    }
    state = await this.readState();
    const token = await this.readDeviceToken();
    const pulled = await this.pull(state.vault_id, state.device_id, token, state.local_main, "latest", state.last_event_seq || 0);
    await this.importPack(pulled.packfile);
    state = await this.readState();
    if (!(await this.ensureNoQueuedLocalChangesBeforeApply(state))) {
      return false;
    }
    await this.applyTargetMain(
      pulled.manifest.target_main,
      pulled.manifest.changed_paths,
      allowDestructive,
      [],
      true,
      pulled.manifest.directory_intents || [],
      pulled.manifest.explicit_directories || [],
      pulled.manifest.event_seq,
      true
    );
    if (state.local_main !== pulled.manifest.target_main) {
      await this.acknowledgeAppliedMain(pulled.manifest.target_main);
    }
    await this.clearResolvedConflictQueue();
    await this.settleAppliedQueue();
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
            return { applied: false, status: "Review needed" };
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
      if (wasConflictBlocked) {
        return event.event_type === "conflict_resolved" && hasNewMain;
      }
      return (event.event_type === "main_advanced" || event.event_type === "conflict_resolved") && hasNewMain;
    });
    if (!shouldPull) {
      await this.writeState(Object.assign({}, currentState, { last_event_seq: page.current_event_seq, updated_at: nowIso() }));
      return { applied: false, status: currentState.status_label };
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

  async applyTargetMain(
    targetMain,
    changedPaths,
    allowDestructive,
    extraAffectedPaths = [],
    requireCleanVisibleState = false,
    directoryIntents = [],
    explicitDirectories = [],
    eventSeq = undefined,
    cleanVisibleStateVerified = false
  ) {
    const state = await this.readState();
    const compactedDirectoryIntents = compactDirectoryIntents(directoryIntents);
    const explicitDirectorySet = Array.from(new Set(explicitDirectories)).sort();
    const hasDirectoryWork = await this.hasActionableDirectoryWork(compactedDirectoryIntents, explicitDirectorySet);
    if (state.local_main === targetMain && extraAffectedPaths.length === 0 && !hasDirectoryWork) {
      await this.writeState(Object.assign({}, state, {
        status_label: "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, eventSeq || 0),
        updated_at: nowIso()
      }));
      return;
    }
    if (requireCleanVisibleState && !cleanVisibleStateVerified && !(await this.ensureNoLocalChangesBeforeApply(state))) {
      return;
    }
    const applyId = `apply_${Date.now()}_${randomHex(8)}`;
    await this.acquireApplyLock(applyId);
    this.plugin.isApplying = true;
    await this.writeState(Object.assign({}, state, {
      status_label: "Applying",
      last_error_code: null,
      updated_at: nowIso()
    }));
    this.reportOperationProgress("Applying", "apply_recovery_prepare");
    const journal = {
      journal_version: 2,
      apply_id: applyId,
      operation_type: "pull_apply",
      target_main: targetMain,
      expected_prior_local_main: state.local_main,
      expected_prior_local_device_ref: state.server_device_ref,
      phase: "planned",
      affected_paths: [],
      preflight_sha256: {},
      preflight_fingerprints: {},
      recovery_bundle_id: null,
      last_completed_step: null,
      redacted_error_category: null
    };
    try {
      const targetEntries = await this.listTreeBlobOids(targetMain);
      const targetFiles = new Set(targetEntries.keys());
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
      const directoryPreflightPaths = Array.from(new Set([
        ...compactedDirectoryIntents.map((intent) => intent.path),
        ...explicitDirectorySet
      ])).filter((filePath) => isRecoverableApplyPath(filePath)).sort();
      const directoryPreflightBudget = createByteBudget(this.fileBufferBudgetBytes);
      const directoryPreflightValues = await runBoundedWork(directoryPreflightPaths, {
        concurrency: this.fileWorkConcurrency,
        yieldEvery: FILE_WORK_YIELD_EVERY
      }, async (filePath) => (await this.readRecoveryFileSnapshot(filePath, directoryPreflightBudget)).fingerprint);
      const directoryPreflight = new Map(directoryPreflightPaths.map((filePath, index) => [filePath, directoryPreflightValues[index]]));
      const expectedVisibleTrees = [];
      if (requireCleanVisibleState) {
        for (const commit of new Set([state.local_head, state.local_main].filter(Boolean))) {
          if (await this.commitExists(commit)) expectedVisibleTrees.push(await this.listTreeBlobOids(commit));
        }
      }
      let stagedRecovery = null;
      if (affectedPaths.length > 0) {
        try {
          stagedRecovery = await this.stageRecoveryBundleFiles(affectedPaths, "Applying (preparing recovery)");
        } catch {
          await this.block("recovery_bundle_failed", "Recovery bundle creation failed before apply.");
        }
        for (const result of stagedRecovery.results) {
          journal.preflight_sha256[result.filePath] = result.fingerprint.kind === "file" ? result.fingerprint.sha256 : null;
          journal.preflight_fingerprints[result.filePath] = result.fingerprint;
        }
        if (
          requireCleanVisibleState &&
          !expectedVisibleTrees.some((entries) => stagedRecovery.results.every((result) =>
            this.fingerprintMatchesTreePath(result.fingerprint, result.filePath, entries)
          ))
        ) {
          await this.fsp.rm(stagedRecovery.partialDir, { recursive: true, force: true }).catch(() => undefined);
          this.plugin.isApplying = false;
          await this.deferApplyForLocalChanges(state);
          return;
        }
      }
      await writeJson(this.fsp, this.applyJournalPath, journal);

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
        await runBoundedWork(affectedPaths, {
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
        await runBoundedWork(directoryPreflightPaths, {
          concurrency: this.fileWorkConcurrency,
          yieldEvery: FILE_WORK_YIELD_EVERY
        }, async (filePath) => {
          const fingerprint = (await this.readRecoveryFileSnapshot(filePath, revalidationBudget)).fingerprint;
          if (!this.fingerprintMatchesPreflight(fingerprint, null, directoryPreflight.get(filePath))) {
            throw new LocalSnapshotChangedError(filePath);
          }
        });
      } catch {
        if (requireCleanVisibleState) {
          this.plugin.isApplying = false;
          await this.fsp.rm(this.applyJournalPath, { force: true });
          await this.deferApplyForLocalChanges(state);
          return;
        }
        journal.phase = "blocked_recovery";
        journal.redacted_error_category = "preflight_hash_changed";
        await writeJson(this.fsp, this.applyJournalPath, journal);
        await this.block("unsafe_local_state", "A local file changed during apply preflight.");
      }
      journal.phase = "writing_files";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      await this.writeTargetFilesFromJournal(journal, targetEntries, new Set());
      await this.applyDirectoryChanges(compactedDirectoryIntents, explicitDirectorySet);

      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      if (!requireCleanVisibleState) {
        this.reportOperationProgress(
          affectedPaths.length > 0 ? `Applying (verifying) 0/${affectedPaths.length}` : "Applying",
          "apply_verify"
        );
        if (!(await this.affectedApplyPathsMatchTarget(journal, targetEntries, false))) {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = "local_changed_during_apply";
          await writeJson(this.fsp, this.applyJournalPath, journal);
          await this.block("unsafe_local_state", "A local file changed while server state was being applied.");
        }
      }
      this.plugin.isApplying = false;
      let preservedLocalChangePaths = [];
      let preservedLocalSnapshot = null;
      let preservedDirectoryIntents = [];
      if (requireCleanVisibleState) {
        await this.flushEditorBuffersToDisk();
        try {
          const preserved = await this.localChangedPathsFromTree(targetEntries, true, { reportOperationProgress: true });
          preservedLocalChangePaths = preserved.paths;
          preservedLocalSnapshot = preserved.snapshot;
        } catch (error) {
          journal.phase = "blocked_recovery";
          journal.redacted_error_category = categorizeRecoveryError(error);
          await writeJson(this.fsp, this.applyJournalPath, journal);
          if (error instanceof ObtsBlockedError) {
            await this.block(error.code, error.message, error.details);
          }
          throw error;
        }
        if (preservedLocalChangePaths.length > 0) {
          await this.createRecoveryBundle("rebuild_from_server", targetMain, preservedLocalChangePaths);
        }
        preservedDirectoryIntents = await this.preserveDirectoryChangesFromTarget(targetEntries, explicitDirectorySet);
      }
      await this.updateRef("refs/heads/main", targetMain, null, true);
      await this.updateRef("refs/heads/local", targetMain, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      await this.writeState(Object.assign({}, state, {
        local_main: targetMain,
        local_head: targetMain,
        status_label: "Synced",
        last_error_code: null,
        last_event_seq: Math.max(state.last_event_seq || 0, eventSeq || 0),
        updated_at: nowIso()
      }));
      if (!requireCleanVisibleState) await this.refreshDirectoryStateFromDisk();
      await this.clearApplyState();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(targetMain, state.server_device_ref, preservedLocalSnapshot);
      } else if (preservedDirectoryIntents.length > 0) {
        await this.queuePreservedDirectoryChanges(targetMain, state.server_device_ref);
      }
    } finally {
      this.plugin.isApplying = false;
      await this.fsp.rm(this.applyLockPath, { force: true });
    }
  }

  async recoverBlockedApplyWithPreservedLocalChanges(journal, state) {
    if (journal.phase !== "blocked_recovery" || journal.redacted_error_category !== "local_changed_during_apply") {
      return false;
    }
    this.plugin.setInitializationStage("Reading interrupted apply target commit", "recovery_target_commit");
    if (!(await this.commitExists(journal.target_main))) return false;
    const canRecoverFinalVisibleTree = journal.last_completed_step === "files_written" || journal.last_completed_step === "refs_updated";
    this.plugin.setInitializationStage("Reading interrupted apply target tree", "recovery_target_tree");
    const targetEntries = await this.listTreeBlobOids(journal.target_main);
    this.plugin.setInitializationStage("Validating interrupted apply files", "recovery_file_validation");
    let preservedLocalChangePaths = [];
    if (canRecoverFinalVisibleTree) {
      preservedLocalChangePaths = await this.localChangedPathsFromTree(targetEntries);
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
      await this.fsp.rm(this.applyLockPath, { force: true });
      await this.acquireApplyLock(journal.apply_id);
      this.plugin.isApplying = true;
      if (preservedLocalChangePaths.length > 0) {
        this.plugin.setInitializationStage("Writing interrupted apply recovery bundle", "recovery_bundle");
        await this.createRecoveryBundle("rebuild_from_server", journal.target_main, preservedLocalChangePaths);
      }
      this.plugin.setInitializationStage("Restoring interrupted apply refs", "recovery_refs");
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
        updated_at: nowIso()
      }));
      await this.clearApplyState();
      if (preservedLocalChangePaths.length > 0) {
        await this.queuePreservedLocalChanges(journal.target_main, state.server_device_ref);
      }
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step || "recovery_bundle";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return false;
    } finally {
      this.plugin.isApplying = false;
      await this.fsp.rm(this.applyLockPath, { force: true });
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
    const validation = await this.applyJournalMatchesCurrentFiles(journal, targetEntries);
    if (!validation.matches) {
      journal.phase = "blocked_recovery";
      journal.redacted_error_category = "local_files_diverge_from_journal";
      journal.last_completed_step = journal.last_completed_step || "recovery_bundle";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return false;
    }
    try {
      await this.fsp.rm(this.applyLockPath, { force: true });
      await this.acquireApplyLock(journal.apply_id);
      this.plugin.isApplying = true;
      if (journal.affected_paths.length > 0 && journal.recovery_bundle_id === null) {
        this.plugin.setInitializationStage("Writing interrupted apply recovery bundle", "recovery_bundle");
        journal.recovery_bundle_id = await this.createRecoveryBundle(journal.operation_type, journal.target_main, journal.affected_paths, journal);
        journal.last_completed_step = "recovery_bundle";
        journal.phase = "recovery_bundle_written";
        await writeJson(this.fsp, this.applyJournalPath, journal);
      }
      journal.phase = "writing_files";
      journal.redacted_error_category = null;
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Restoring interrupted apply files", "recovery_file_apply");
      await this.writeTargetFilesFromJournal(journal, targetEntries, validation.targetMatchedPaths);
      journal.phase = "verifying";
      journal.last_completed_step = "files_written";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Revalidating interrupted apply files", "recovery_file_validation");
      if (!(await this.affectedApplyPathsMatchTarget(journal, targetEntries))) {
        journal.phase = "blocked_recovery";
        journal.redacted_error_category = "local_changed_during_apply";
        await writeJson(this.fsp, this.applyJournalPath, journal);
        return false;
      }
      this.plugin.setInitializationStage("Restoring interrupted apply refs", "recovery_refs");
      await this.updateRef("refs/heads/main", journal.target_main, null, true);
      await this.updateRef("refs/heads/local", journal.target_main, null, true);
      journal.phase = "committed";
      journal.last_completed_step = "refs_updated";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      this.plugin.setInitializationStage("Persisting interrupted apply state", "recovery_state");
      await this.writeState(Object.assign({}, state, {
        local_main: journal.target_main,
        local_head: journal.target_main,
        status_label: "Synced",
        last_error_code: null,
        updated_at: nowIso()
      }));
      await this.clearApplyState();
      return true;
    } catch (error) {
      journal.redacted_error_category = categorizeRecoveryError(error);
      journal.last_completed_step = journal.last_completed_step || "recovery_bundle";
      await writeJson(this.fsp, this.applyJournalPath, journal);
      return false;
    } finally {
      this.plugin.isApplying = false;
      await this.fsp.rm(this.applyLockPath, { force: true });
    }
  }

  async affectedApplyPathsMatchTarget(journal, targetEntries, initialization = true) {
    const paths = journal.affected_paths.slice();
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
            total > 0 ? `Applying (verifying) ${completed}/${total}` : "Applying",
            "apply_verify"
          );
        }
      }
    }, async (filePath) => {
      const fingerprint = (await this.readRecoveryFileSnapshot(filePath, budget)).fingerprint;
      return this.fingerprintMatchesTarget(fingerprint, targetEntries.get(filePath));
    });
    return matches.every(Boolean);
  }

  async localChangedPathsFromTree(targetEntries, includeSnapshot = false, options = {}) {
    const localFiles = await this.scanSyncableFiles();
    const localSet = new Set(localFiles);
    const snapshot = await this.captureLocalFileSnapshot(localFiles, new Map(
      [...targetEntries].map(([filePath, oid]) => [filePath, { oid }])
    ), {
      persistChangedBlobs: includeSnapshot,
      verifyInventory: includeSnapshot,
      reportProgress: false,
      onProgress: options.reportOperationProgress
        ? (completed, total) => this.reportOperationProgress(
          total > 0 ? `Applying (verifying vault) ${completed}/${total}` : "Applying (verifying vault)",
          "apply_verify"
        )
        : undefined
    });
    const paths = Array.from(new Set([...localSet, ...targetEntries.keys()])).sort().filter((filePath) => {
      const localOid = snapshot.entries.get(filePath)?.entry.oid;
      return localOid === undefined ? targetEntries.has(filePath) : localOid !== targetEntries.get(filePath);
    });
    return includeSnapshot ? { paths, snapshot } : paths;
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

  async queuePreservedLocalChanges(targetMain, expectedDeviceRef, snapshot = null) {
    const preservedCommit = snapshot
      ? await this.createLocalCommitFromSnapshot("obts: preserve local changes after conflict resolution", snapshot)
      : await this.createLocalCommit("obts: preserve local changes after conflict resolution");
    if (!preservedCommit) {
      return;
    }
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

  async queuePreservedDirectoryChanges(targetMain, expectedDeviceRef) {
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

  fingerprintMatchesTreePath(fingerprint, filePath, entries) {
    const targetOid = entries.get(filePath);
    if (targetOid !== undefined) return fingerprint.kind === "file" && fingerprint.oid === targetOid;
    const directoryPrefix = `${filePath}/`;
    const expectedDirectory = [...entries.keys()].some((candidate) => candidate.startsWith(directoryPrefix));
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
    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index];
      const fingerprint = fingerprints[index];
      const matchesTarget = this.fingerprintMatchesTarget(fingerprint, targetEntries.get(filePath));
      if (matchesTarget) targetMatchedPaths.add(filePath);
      if (!this.fingerprintMatchesPreflight(
        fingerprint,
        journal.preflight_sha256[filePath] || null,
        journal.preflight_fingerprints?.[filePath]
      )) {
        if ((journal.phase !== "writing_files" && journal.phase !== "verifying") || !matchesTarget) {
          return { matches: false, targetMatchedPaths };
        }
      }
    }
    return { matches: true, targetMatchedPaths };
  }

  async writeTargetFilesFromJournal(journal, targetEntries, targetMatchedPaths) {
    const assertRecoveredDescendants = async (filePath) => {
      const descendants = await this.listLocalDescendantFiles(filePath);
      if (descendants.some((descendant) => !(descendant in journal.preflight_sha256))) {
        journal.phase = "blocked_recovery";
        journal.redacted_error_category = "preflight_hash_changed";
        await writeJson(this.fsp, this.applyJournalPath, journal);
        await this.block("unsafe_local_state", "A local file changed during apply preflight.");
      }
    };
    const removals = journal.affected_paths
      .filter((candidate) => !targetEntries.has(candidate) && !targetMatchedPaths.has(candidate))
      .sort(compareDeepestPathFirst);
    const writes = journal.affected_paths
      .filter((candidate) => targetEntries.has(candidate) && !targetMatchedPaths.has(candidate))
      .sort();
    const total = removals.length + writes.length;
    let completed = 0;
    const reportProgress = () => this.reportOperationProgress(
      total > 0 ? `Applying ${completed}/${total}` : "Applying",
      "apply_write"
    );
    reportProgress();

    for (const batch of dependencySafeRemovalBatches(removals)) {
      const completedBeforeBatch = completed;
      await runBoundedWork(batch, {
        concurrency: this.fileWorkConcurrency,
        yieldEvery: FILE_WORK_YIELD_EVERY,
        onProgress: (batchCompleted) => {
          completed = completedBeforeBatch + batchCompleted;
          reportProgress();
        }
      }, async (filePath) => {
        if (await this.adapterIsDirectory(filePath)) await assertRecoveredDescendants(filePath);
        await this.adapterRemove(filePath);
        if (await this.adapterExists(filePath)) throw new Error("A local path remained after an apply removal.");
      });
    }

    for (const filePath of writes) await this.removeBlockingMaterializationPaths(filePath);
    await this.writeTargetFileBatch(writes, targetEntries, assertRecoveredDescendants, () => {
      completed += 1;
      reportProgress();
    });
  }

  async writeTargetFileBatch(writes, targetEntries, assertRecoveredDescendants, onProgress) {
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
      let content;
      try {
        content = await this.readBlobOid(targetEntries.get(filePath));
      } catch (error) {
        firstError = error;
        break;
      }
      const releaseBytes = await byteBudget.acquire(content.byteLength);
      if (firstError) {
        releaseBytes();
        break;
      }
      const task = (async () => {
        try {
          if (await this.adapterIsDirectory(filePath)) {
            await assertRecoveredDescendants(filePath);
            await this.adapterRemove(filePath);
          }
          await this.adapterWriteBinary(filePath, content);
          onProgress();
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

  async createLocalCommit(message, knownLocalFiles = undefined) {
    const base = await this.resolveRef("refs/heads/local");
    const baseEntries = base ? await this.flattenTree(base) : new Map();
    const localFiles = (knownLocalFiles || await this.scanSyncableFiles()).slice().sort();
    const localSet = new Set(localFiles);
    const nextEntries = new Map(baseEntries);
    for (const filePath of baseEntries.keys()) {
      if (!isSyncableVaultPath(filePath) || !localSet.has(filePath)) nextEntries.delete(filePath);
    }
    let snapshot;
    try {
      snapshot = await this.captureLocalFileSnapshot(localFiles, baseEntries, {
        persistChangedBlobs: true,
        reportProgress: true,
        verifyInventory: true
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
    return await this.commitTree(tree, base, message);
  }

  async captureLocalFileSnapshot(localFiles, baseEntries = new Map(), options = {}) {
    const files = localFiles.slice().sort();
    const byteBudget = createByteBudget(this.fileBufferBudgetBytes);
    if (options.reportProgress) this.reportCheckingProgress(0, files.length);
    const values = await runBoundedWork(files, {
      concurrency: this.fileWorkConcurrency,
      yieldEvery: FILE_WORK_YIELD_EVERY,
      onProgress: options.reportProgress
        ? (completed, total) => this.reportCheckingProgress(completed, total)
        : options.onProgress
    }, async (filePath) => {
      let before;
      try {
        before = await this.adapter.stat(filePath);
      } catch (error) {
        throw new LocalSnapshotChangedError(filePath, error);
      }
      if (!before || before.type !== "file") throw new LocalSnapshotChangedError(filePath);
      const releaseBytes = await byteBudget.acquire(before.size || 0);
      try {
        let content;
        try {
          content = Buffer.from(await this.adapter.readBinary(filePath));
        } catch (error) {
          throw new LocalSnapshotChangedError(filePath, error);
        }
        let after;
        try {
          after = await this.adapter.stat(filePath);
        } catch (error) {
          throw new LocalSnapshotChangedError(filePath, error);
        }
        if (
          !after || after.type !== "file" ||
          Number(after.size || 0) !== content.byteLength ||
          Number(before.size || 0) !== Number(after.size || 0) ||
          before.mtime && after.mtime && before.mtime !== after.mtime
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
          bytes: content.byteLength
        };
      } finally {
        releaseBytes();
      }
    });
    if (options.verifyInventory) {
      const verifiedFiles = await this.scanSyncableFiles();
      if (!sameStringArray(files, verifiedFiles)) throw new LocalSnapshotChangedError("<inventory>");
    }
    return { files, entries: new Map(files.map((filePath, index) => [filePath, values[index]])) };
  }

  async createLocalCommitFromSnapshot(message, snapshot) {
    const base = await this.resolveRef("refs/heads/local");
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

  async scanSyncableFiles() {
    const result = (await this.listLocalVaultFiles()).filter((filePath) => isSyncableVaultPath(filePath));
    return assertNoCaseCollisions(result.sort());
  }

  reportCheckingProgress(completed, total) {
    const now = Date.now();
    if (completed !== 0 && completed !== total && now - this.plugin.lastCheckingProgressAt < 250) return;
    this.plugin.lastCheckingProgressAt = now;
    this.reportOperationProgress(total > 0 ? `Checking ${completed}/${total}` : "Checking", "local_snapshot");
  }

  reportOperationProgress(label, diagnosticPoint) {
    if (typeof this.plugin.setOperationProgress === "function") {
      this.plugin.setOperationProgress(label, diagnosticPoint);
    } else {
      this.plugin.setStatus(label);
    }
  }

  async localSnapshotSummary() {
    const inventory = await this.listLocalVaultInventory("");
    const files = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    const directories = inventory.directories;
    const snapshot = await this.captureLocalFileSnapshot(files, new Map(), { reportProgress: true });
    const hash = createSha("sha256");
    for (const directoryPath of directories) {
      hash.update("dir\0");
      hash.update(directoryPath);
      hash.update("\0");
    }
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

  async restoreFileSnapshot(snapshot, priorLocalFiles) {
    for (const filePath of priorLocalFiles.sort((left, right) => right.length - left.length)) {
      if (!snapshot.has(filePath)) await this.adapterRemove(filePath);
    }
    for (const [filePath, content] of Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      await this.removeBlockingMaterializationPaths(filePath);
      if (await this.adapterIsDirectory(filePath)) await this.adapterRemove(filePath);
      await this.adapterWriteBinary(filePath, content);
    }
  }

  async createRecoveryBundle(operationType, targetMain, affectedPaths, journal = null) {
    const staged = await this.stageRecoveryBundleFiles(affectedPaths, "Checking (preparing recovery)");
    try {
      return await this.finalizeRecoveryBundle(staged, operationType, targetMain, affectedPaths, journal);
    } catch (error) {
      await this.fsp.rm(staged.partialDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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
    const parentDirs = new Set();
    for (const filePath of paths) {
      let parent = path.posix.dirname(filePath);
      while (parent && parent !== ".") {
        parentDirs.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    for (const parent of [...parentDirs].sort((left, right) => left.length - right.length || left.localeCompare(right))) {
      await this.fsp.mkdir(path.join(partialDir, "files", parent), { recursive: true, mode: 0o700 });
    }
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

  async finalizeRecoveryBundle(staged, operationType, targetMain, affectedPaths, journal) {
    const state = await this.readState();
    const bundleDir = path.join(this.obtsDir, "recovery", staged.bundleId);
    const manifest = {
      bundle_id: staged.bundleId,
      vault_id: state.vault_id || "unknown",
      device_id: state.device_id || "unknown",
      created_at: nowIso(),
      operation_type: operationType,
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
    await this.fsp.writeFile(
      path.join(staged.partialDir, "checksums.sha256"),
      `${(await bundleChecksums(this.fsp, staged.partialDir)).join("\n")}\n`,
      { mode: 0o600 }
    );
    await writeJson(this.fsp, path.join(staged.partialDir, "complete.json"), { bundle_id: staged.bundleId, completed_at: nowIso() });
    await this.fsp.rename(staged.partialDir, bundleDir);
    return staged.bundleId;
  }

  async readRecoveryFileSnapshot(filePath, byteBudget = createByteBudget(this.fileBufferBudgetBytes)) {
    let before;
    try {
      before = await this.fsp.stat(filePath);
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
      const content = await this.fsp.readFile(filePath);
      let after;
      try {
        after = await this.fsp.stat(filePath);
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
    for (let index = 0; index < oids.length; index += 1) {
      // isomorphic-git exposes object size only after reading the whole object, so keep one unknown-size producer live at a time.
      const result = await git.readObject({ fs: this.fs, dir: this.vaultDir, gitdir: this.gitdir, oid: oids[index], format: "content" });
      sizes.push(result.object.byteLength);
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
        throw new ObtsBlockedError("object_too_large_for_chunk", "A file is too large for bounded mobile transfer.");
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
        cursor
      })
    });
    if (!response.ok) await throwResponseError(response);
    return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
  }

  async pull(vaultId, deviceId, token, currentLocalMain, requestedTarget = "latest", currentEventSeq = undefined) {
    const capabilities = await this.syncCapabilities();
    if (capabilities) {
      const checkpoint = await readJson(this.fsp, this.pullTransferPath, null);
      const checkpointMatches = checkpoint &&
        checkpoint.vault_id === vaultId &&
        checkpoint.device_id === deviceId &&
        checkpoint.current_local_main === currentLocalMain &&
        (requestedTarget === "latest" || requestedTarget === checkpoint.target_main);
      let cursor = checkpointMatches ? checkpoint.next_cursor : 0;
      let target = checkpointMatches ? checkpoint.target_main : requestedTarget;
      if (checkpoint && !checkpointMatches) await this.fsp.rm(this.pullTransferPath, { force: true });
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
          await this.fsp.rm(this.pullTransferPath, { force: true });
          break;
        }
        if (finalManifest.next_cursor <= cursor) throw new ObtsBlockedError("invalid_transfer_cursor", "Pull transfer did not advance.");
        cursor = finalManifest.next_cursor;
        await writeJson(this.fsp, this.pullTransferPath, {
          vault_id: vaultId,
          device_id: deviceId,
          current_local_main: currentLocalMain,
          target_main: target,
          next_cursor: cursor,
          received_chunks: chunkCount,
          transferred_bytes: transferredBytes,
          updated_at: nowIso()
        });
      }
      if (!await this.commitExists(finalManifest.target_main)) {
        throw new ObtsBlockedError("transfer_incomplete", "Downloaded Git chunks do not contain the target commit.");
      }
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
    return parseMultipartPull(response.headers.get("content-type") || "", Buffer.from(await response.arrayBuffer()));
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
    const nameRevision = this.plugin.deviceNameRevision;
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${state.vault_id}/sync/device-status`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        plugin_version: PLUGIN_VERSION,
        local_status_label: state.status_label || "Checking",
        local_error_code: state.last_error_code,
        local_queue_status: queue.status,
        local_main: state.local_main,
        local_head: state.local_head,
        path_capabilities: {
          adapter: "obsidian-data-adapter",
          platform: runtimePlatform()
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

  async acknowledgeAppliedMain(targetMain) {
    const state = await this.readState();
    if (!state.vault_id || !state.device_id) {
      return;
    }
    try {
      await this.pull(state.vault_id, state.device_id, await this.readDeviceToken(), targetMain, targetMain, state.last_event_seq || 0);
    } catch (error) {
      if (!(error instanceof ObtsTransportError && error.status === 404)) {
        throw error;
      }
    }
  }

  async ensureNoQueuedLocalChangesBeforeApply(state) {
    const flushedPaths = await this.flushEditorBuffersToDisk();
    if (Array.isArray(flushedPaths) && flushedPaths.length > 0) this.plugin.syncQueued = true;
    const queue = await this.readQueue();
    if ((queue.pending_commit && queue.status !== "conflicted") || this.plugin.syncQueued) {
      await this.deferApplyForLocalChanges(state);
      return false;
    }
    return true;
  }

  async ensureNoLocalChangesBeforeApply(state) {
    await this.flushEditorBuffersToDisk();
    const queue = await this.readQueue();
    if (queue.pending_commit && queue.status !== "conflicted") {
      await this.deferApplyForLocalChanges(state);
      return false;
    }
    if (await this.visibleVaultMatchesLocalHead(state)) {
      return true;
    }
    await this.deferApplyForLocalChanges(state);
    return false;
  }

  async visibleVaultMatchesLocalHead(state) {
    const expectedLocalHead = state.local_head || state.local_main;
    const localFiles = await this.scanSyncableFiles();
    if (!expectedLocalHead) {
      return localFiles.length === 0;
    }
    if (!(await this.commitExists(expectedLocalHead))) {
      return false;
    }
    if (await this.localContentMatchesTree(localFiles, expectedLocalHead)) {
      return true;
    }
    return state.local_main && state.local_main !== expectedLocalHead
      ? await this.localContentMatchesTree(localFiles, state.local_main)
      : false;
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
      status_label: "Ahead",
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

  async reconcileQueueWithLocalHead(state) {
    const queue = await this.readQueue();
    if (queue.pending_commit || !state.local_head || !(await this.commitExists(state.local_head))) {
      return;
    }
    if (state.local_main && state.local_head === state.local_main) {
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
    const descendsFromDeviceRef = state.server_device_ref ? await this.isAncestor(state.server_device_ref, state.local_head) : false;
    const descendsFromLocalMain = state.local_main ? await this.isAncestor(state.local_main, state.local_head) : false;
    if (descendsFromDeviceRef || descendsFromLocalMain || (!state.server_device_ref && !state.local_main)) {
      await this.writeQueue({
        pending_commit: state.local_head,
        expected_device_ref: state.server_device_ref,
        status: "queued_local",
        attempts: 0,
        updated_at: nowIso()
      });
      await this.writeState(Object.assign({}, state, {
        status_label: "Ahead",
        last_error_code: null,
        updated_at: nowIso()
      }));
      return;
    }
    await this.block("same_device_non_fast_forward", "Local Git history diverged from this device ref and requires recovery.");
  }

  async acquireApplyLock(applyId) {
    await this.fsp.mkdir(path.dirname(this.applyLockPath), { recursive: true, mode: 0o700 });
    try {
      await this.fsp.writeFile(this.applyLockPath, JSON.stringify({ apply_id: applyId, created_at: nowIso() }, null, 2), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error && error.code === "EEXIST") {
        await this.block("apply_lock_active", "Another apply operation already holds the local vault lock.");
      }
      throw error;
    }
  }

  async clearApplyState() {
    await this.fsp.rm(this.applyJournalPath, { force: true });
    await this.fsp.rm(this.applyLockPath, { force: true });
  }

  async updateRef(ref, target, expected, force = false) {
    const refPath = path.join(this.gitdir, ref);
    const lockPath = `${refPath}.lock`;
    await this.fsp.mkdir(path.dirname(refPath), { recursive: true });
    try {
      await this.fsp.writeFile(lockPath, `${target}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new Error(`Local ref ${ref} is locked by another operation.`, { cause: error });
    }
    try {
      if (!force && expected) {
        const current = await this.resolveRef(ref);
        if (current !== expected) throw new Error(`Local ref ${ref} changed while updating it.`);
      }
      await this.fsp.rename(lockPath, refPath);
    } finally {
      await this.fsp.rm(lockPath, { force: true }).catch(() => undefined);
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
    try {
      const state = JSON.parse(await this.fsp.readFile(this.statePath, "utf8"));
      if (await this.hasActiveTokenWithoutIdentity(state)) {
        return await this.readBackupState() || this.localStateIncomplete(state);
      }
      return await this.preferRecoverableBackupState(state);
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
        unpaired_baseline_vault_id: null,
        unpaired_baseline_main: null,
        updated_at: nowIso()
      };
    }
  }

  async writeState(state) {
    const guardedState = await this.guardStateCursorRegression(state);
    await this.backupExistingState();
    await writeJson(this.fsp, this.statePath, guardedState);
  }

  async guardStateCursorRegression(nextState) {
    const currentState = await this.readPrimaryState();
    if (!currentState || !samePairedDeviceState(currentState, nextState)) {
      return nextState;
    }
    const guardedState = Object.assign({}, nextState);
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

    this.plugin.setInitializationStage("Validating local state history", "startup_state");
    if (await this.backupStateCursorsDescend(primaryState, backupState)) {
      return backupState;
    }
    return primaryState;
  }

  async restoreRecoveredBackupState(primaryState, backupState, knownExpectedDeviceRef = undefined) {
    const expectedDeviceRef = knownExpectedDeviceRef === undefined
      ? (await this.readQueue()).expected_device_ref
      : knownExpectedDeviceRef;
    const backupMatchesQueue = expectedDeviceRef && backupState.server_device_ref === expectedDeviceRef;
    const recovered = Object.assign({}, backupState, {
      device_name: primaryState.device_name || backupState.device_name || null,
      server_device_ref: backupMatchesQueue
        ? backupState.server_device_ref
        : primaryState.server_device_ref,
      initial_import_confirmed: Boolean(primaryState.initial_import_confirmed || backupState.initial_import_confirmed),
      last_event_seq: Math.max(primaryState.last_event_seq || 0, backupState.last_event_seq || 0),
      updated_at: nowIso()
    });
    if (recovered.server_device_ref === primaryState.server_device_ref && primaryState.server_device_ref !== backupState.server_device_ref) {
      recovered.status_label = primaryState.status_label;
      recovered.last_error_code = primaryState.last_error_code;
      recovered.last_error_details = primaryState.last_error_details || null;
    }
    await writeJson(this.fsp, this.statePath, recovered);
    return recovered;
  }

  async backupStateCursorsDescend(primaryState, backupState) {
    return await this.cursorDescends(primaryState.local_main, backupState.local_main) ||
      await this.cursorDescends(primaryState.local_head, backupState.local_head) ||
      await this.cursorDescends(primaryState.server_device_ref, backupState.server_device_ref);
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
      change_seq: Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0 ? queue.change_seq : 0
    });
  }

  async writeQueue(queue) {
    await this.mutateQueue(async () => {
      const existing = await readJson(this.fsp, this.queuePath, null);
      await writeJson(this.fsp, this.queuePath, Object.assign({}, queue, {
        change_seq: Number.isSafeInteger(queue.change_seq) && queue.change_seq >= 0
          ? queue.change_seq
          : Number.isSafeInteger(existing && existing.change_seq) && existing.change_seq >= 0
            ? existing.change_seq
            : 0
      }));
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

  async readDirectoryState() {
    const state = await readJson(this.fsp, this.directoryStatePath, null);
    if (!state) {
      return { observed_dirs: [], explicit_empty_dirs: [], pending_intents: [], updated_at: nowIso() };
    }
    return {
      observed_dirs: Array.isArray(state.observed_dirs) ? state.observed_dirs : [],
      explicit_empty_dirs: Array.isArray(state.explicit_empty_dirs) ? state.explicit_empty_dirs : [],
      pending_intents: compactDirectoryIntents(Array.isArray(state.pending_intents) ? state.pending_intents : []),
      updated_at: typeof state.updated_at === "string" ? state.updated_at : nowIso()
    };
  }

  async writeDirectoryState(state) {
    await writeJson(this.fsp, this.directoryStatePath, {
      observed_dirs: Array.from(new Set(state.observed_dirs)).sort(),
      explicit_empty_dirs: Array.from(new Set(state.explicit_empty_dirs)).sort(),
      pending_intents: compactDirectoryIntents(state.pending_intents),
      updated_at: state.updated_at
    });
  }

  async reconcileDirectoryState(knownLocalFiles = undefined, knownLocalDirectories = undefined) {
    if (!(await exists(this.fsp, this.directoryStatePath))) {
      await this.refreshDirectoryStateFromDisk([], knownLocalFiles, knownLocalDirectories);
      return [];
    }
    const previous = await this.readDirectoryState();
    const currentDirs = knownLocalDirectories || await this.listLocalVaultDirectories();
    const currentFiles = knownLocalFiles || await this.scanSyncableFiles();
    const explicitDirs = explicitEmptyDirectories(currentDirs, currentFiles);
    const previousDirs = new Set(previous.observed_dirs);
    const previousExplicitDirs = new Set(previous.explicit_empty_dirs);
    const currentDirSet = new Set(currentDirs);
    const createdIntents = explicitDirs
      .filter((dirPath) => !previousDirs.has(dirPath) || !previousExplicitDirs.has(dirPath))
      .map((dirPath) => ({ op: "create", path: dirPath }));
    const deletedIntents = topmostDirectories(previous.observed_dirs.filter((dirPath) => !currentDirSet.has(dirPath)))
      .map((dirPath) => ({ op: "delete", path: dirPath }));
    const pendingIntents = compactDirectoryIntents([...previous.pending_intents, ...createdIntents, ...deletedIntents]);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      explicit_empty_dirs: explicitDirs,
      pending_intents: pendingIntents,
      updated_at: nowIso()
    });
    return pendingIntents;
  }

  async clearPendingDirectoryIntents() {
    await this.refreshDirectoryStateFromDisk([]);
  }

  async preserveDirectoryChangesFromTarget(targetEntries, explicitDirectories) {
    const previous = await this.readDirectoryState();
    const inventory = await this.listLocalVaultInventory("");
    const currentFiles = assertNoCaseCollisions(inventory.files.filter((filePath) => isSyncableVaultPath(filePath)).sort());
    const currentDirs = inventory.directories;
    const expectedDirs = new Set(explicitDirectories);
    for (const filePath of targetEntries.keys()) {
      for (const dirPath of directoryPrefixes(filePath)) expectedDirs.add(dirPath);
    }
    const currentDirSet = new Set(currentDirs);
    const createdIntents = explicitEmptyDirectories(currentDirs, currentFiles)
      .filter((dirPath) => !expectedDirs.has(dirPath))
      .map((dirPath) => ({ op: "create", path: dirPath }));
    const deletedIntents = topmostDirectories([...expectedDirs].filter((dirPath) => !currentDirSet.has(dirPath)))
      .map((dirPath) => ({ op: "delete", path: dirPath }));
    const pendingIntents = compactDirectoryIntents([...previous.pending_intents, ...createdIntents, ...deletedIntents]);
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      explicit_empty_dirs: explicitEmptyDirectories(currentDirs, currentFiles),
      pending_intents: pendingIntents,
      updated_at: nowIso()
    });
    return pendingIntents;
  }

  async refreshDirectoryStateFromDisk(pendingIntents = undefined, knownLocalFiles = undefined, knownLocalDirectories = undefined) {
    const previous = await this.readDirectoryState();
    const currentDirs = knownLocalDirectories || await this.listLocalVaultDirectories();
    const currentFiles = knownLocalFiles || await this.scanSyncableFiles();
    await this.writeDirectoryState({
      observed_dirs: currentDirs,
      explicit_empty_dirs: explicitEmptyDirectories(currentDirs, currentFiles),
      pending_intents: pendingIntents === undefined ? previous.pending_intents : pendingIntents,
      updated_at: nowIso()
    });
  }

  async hasActionableDirectoryWork(directoryIntents, explicitDirectories) {
    for (const intent of directoryIntents) {
      const isDirectory = await this.adapterIsDirectory(intent.path);
      if (intent.op === "create" && !isDirectory) return true;
      if (intent.op === "delete" && isDirectory && await this.adapterDirectoryIsEmpty(intent.path)) return true;
    }
    for (const dirPath of explicitDirectories) {
      if (!(await this.adapterIsDirectory(dirPath))) return true;
    }
    return false;
  }

  async applyDirectoryChanges(directoryIntents, explicitDirectories) {
    for (const intent of directoryIntents.filter((entry) => entry.op === "delete").sort((left, right) => right.path.length - left.path.length)) {
      if ((await this.adapterIsDirectory(intent.path)) && (await this.adapterDirectoryIsEmpty(intent.path))) {
        await this.adapterRemove(intent.path);
      }
    }
    for (const dirPath of Array.from(new Set(explicitDirectories)).sort((left, right) => left.length - right.length)) {
      await ensureAdapterDir(this.adapter, dirPath);
    }
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

  async adapterWriteBinary(filePath, content) {
    await ensureAdapterDir(this.adapter, path.posix.dirname(filePath));
    const vault = this.plugin.app && this.plugin.app.vault;
    const existing = vault && typeof vault.getAbstractFileByPath === "function" ? vault.getAbstractFileByPath(filePath) : null;
    const arrayBuffer = toArrayBuffer(content);
    try {
      if (existing && typeof vault.modifyBinary === "function" && !existing.children) {
        await vault.modifyBinary(existing, arrayBuffer);
        return;
      }
      if (!existing && typeof vault.createBinary === "function") {
        await vault.createBinary(filePath, arrayBuffer);
        return;
      }
    } catch {
      // Vault API may reject writes to system paths such as .trash.
      // Fall through to the raw adapter below.
    }
    await this.adapter.writeBinary(filePath, arrayBuffer);
  }

  async adapterRemove(filePath) {
    try {
      const vault = this.plugin.app && this.plugin.app.vault;
      const existing = vault && typeof vault.getAbstractFileByPath === "function" ? vault.getAbstractFileByPath(filePath) : null;
      if (existing && typeof vault.delete === "function") {
        await vault.delete(existing, true);
        return;
      }
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
    return (await this.listLocalVaultInventory("")).directories;
  }

  async listLocalDescendantFiles(filePath) {
    if (!(await this.adapterIsDirectory(filePath))) return [];
    return (await this.listLocalVaultInventory(filePath)).files;
  }

  async listLocalVaultInventory(root) {
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
          directories.push(normalizedFolder);
          next.push(normalizedFolder);
        }
        for (const filePath of (listing.files || []).slice().sort()) {
          const normalizedFile = normalizePath(filePath);
          if (normalizedFile === ".obts" || normalizedFile.startsWith(".obts/")) continue;
          assertValidLocalVaultPath(normalizedFile);
          files.push(normalizedFile);
        }
      }
      frontier = Array.from(new Set(next)).sort();
    }
    return { files: Array.from(new Set(files)).sort(), directories: Array.from(new Set(directories)).sort() };
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

  async block(code, message, details = undefined) {
    await this.markBlocked(code, details);
    throw new ObtsBlockedError(code, message, details);
  }

  async markBlocked(code, details = undefined) {
    await this.writeState(Object.assign({}, await this.readState(), {
      status_label: blockStatusLabel(code),
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
    this.browserReturnAbortController = null;
  }

  async onOpen() {
    this.contentEl.addClass("obts-onboarding");
    const pending = await this.plugin.client.readPendingOnboarding();
    if (!pending) {
      this.renderStart();
      return;
    }
    this.connection = Object.assign({}, pending.journal.connection, { connection_secret: pending.secret });
    this.analysis = pending.journal.analysis || null;
    this.mode = pending.journal.selected_mode || null;
    const state = await this.plugin.client.readState();
    const postRegistrationStage = ["registering", "applying_uploading", "uploading_proposal", "awaiting_conflict"].includes(pending.journal.stage);
    const resumableSubmission = Boolean(this.analysis && this.mode && ((state.vault_id && state.device_id) || postRegistrationStage));
    if (resumableSubmission) {
      if (pending.journal.stage === "awaiting_conflict") this.renderConflictReview();
      else this.renderResume();
      return;
    }
    if (this.analysis && !["awaiting_browser", "approved", "analyzing"].includes(pending.journal.stage)) {
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
            });
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to update the device name.");
          }
        });
        if (text.inputEl) text.inputEl.maxLength = 80;
      });
    new Setting(contentEl)
      .setName("Share error diagnostics with this obts server")
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
          this.connection = await this.plugin.runExclusiveAction(() => this.plugin.client.startOnboarding());
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

  async pollUntilApproved() {
    while (!this.cancelled && this.connection) {
      const status = await this.plugin.runExclusiveAction(() => this.plugin.client.pollOnboarding(
        this.connection.connection_id,
        this.connection.connection_secret
      ));
      if (this.cancelled || this.plugin.unloaded) return;
      if (status.status === "approved") {
        if (this.waitingFeedback) setFeedback(this.waitingFeedback, "Approved. Comparing local and server vaults...", "success");
        this.analysis = await this.plugin.runExclusiveAction(() => this.plugin.client.analyzeOnboarding(
          this.connection.connection_id,
          this.connection.connection_secret
        ));
        if (this.cancelled || this.plugin.unloaded) return;
        this.renderConfirmation();
        return;
      }
      if (status.status === "denied" || status.status === "expired") {
        throw new ObtsBlockedError(`connection_${status.status}`, `Connection was ${status.status}.`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, this.connection.poll_interval_ms || 2000));
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
      .addButton((button) => button.setButtonText(actionLabel).setCta().onClick(async () => {
        button.setDisabled(true);
        setFeedback(feedback, "Creating recovery bundle and completing setup...", "muted");
        try {
          const result = await this.plugin.runOnboardingAction(() => this.plugin.client.finishOnboarding(
            this.connection.connection_id,
            this.connection.connection_secret,
            this.analysis,
            this.mode
          ));
          this.plugin.setStatus((await this.plugin.client.readState()).status_label);
          this.renderResult(result);
        } catch (error) {
          if (this.cancelled || this.plugin.unloaded) return;
          void this.plugin.reportOnboardingError(error, this.connection);
          button.setDisabled(false);
          setFeedback(feedback, error instanceof Error ? error.message : "Setup failed.", "error");
        }
      }));
  }

  renderResume() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Finish sync setup" });
    contentEl.createEl("p", {
      text: "This setup submission started but did not finish. Resume from the durable journal and server state; obts will not submit the local vault a second time."
    });
    const feedback = contentEl.createDiv({ cls: "obts-feedback", attr: { "aria-live": "polite" } });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Resume setup").setCta().onClick(async () => {
        button.setDisabled(true);
        setFeedback(feedback, "Checking the accepted onboarding proposal...", "muted");
        try {
          const result = await this.resumeRegisteredSetup();
          this.renderResult(result);
        } catch (error) {
          if (this.cancelled || this.plugin.unloaded) return;
          void this.plugin.reportOnboardingError(error, this.connection);
          button.setDisabled(false);
          setFeedback(feedback, error instanceof Error ? error.message : "Unable to resume setup.", "error");
        }
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
      if (result.status === "Review needed") {
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
    if (result.status === "Review needed") {
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
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian True Sync" });
    let availability = this.plugin.operationAvailability();
    if (!this.plugin.clientReady && availability === "available") {
      await this.plugin.initializeClient();
      availability = this.plugin.operationAvailability();
    }
    const clientUnavailable = !this.plugin.clientReady;
    const [state, pendingOnboarding] = clientUnavailable
      ? [null, null]
      : await Promise.all([
          this.plugin.client.readState(),
          this.plugin.client.readPendingOnboarding()
        ]);
    const paired = Boolean(state && state.vault_id && state.device_id);
    const recoveryBlocked = Boolean(state && state.last_error_code === "local_state_incomplete");
    const restartRequired = availability === "restart_required";
    const initializationInProgress = clientUnavailable && Boolean(this.plugin.clientInitialization);
    const initializationStage = this.plugin.initializationStage || "Checking local obts state";
    const initializationElapsed = formatElapsed(Date.now() - (this.plugin.initializationStageStartedAt || Date.now()));
    const deviceName = this.plugin.settings.deviceName || state && state.device_name || "Obsidian device";

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          try {
            if (pendingOnboarding) {
              throw new ObtsBlockedError("onboarding_incomplete", "Finish or cancel onboarding before changing the server URL.");
            }
            await this.plugin.runExclusiveAction(() => this.plugin.updateServerUrl(value));
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to update the server URL.");
            await this.display();
          }
        })
      );

    new Setting(containerEl)
      .setName("Share error diagnostics with this obts server")
      .setDesc(diagnosticSharingDescription(this.plugin.settings.serverUrl))
      .addToggle((toggle) => toggle.setValue(this.plugin.diagnosticSharingEnabled()).onChange(async (value) => {
        try {
          await this.plugin.setDiagnosticSharing(value);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to update diagnostic sharing.");
        }
        await this.display();
      }));

    const sectionHeader = containerEl.createDiv({ cls: "obts-settings-section-header" });
    sectionHeader.createEl("h3", {
      text: clientUnavailable
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
          : initializationInProgress
            ? "Loading"
            : "Please wait"
        : pendingOnboarding
          ? "Resume setup"
          : recoveryBlocked
            ? "Needs recovery"
            : paired
              ? "Paired"
              : "Not paired"
    });
    if (clientUnavailable) {
      new Setting(containerEl)
        .setName(
          restartRequired
            ? "Plugin update interrupted an operation"
            : initializationInProgress
              ? initializationStage
              : "Waiting for the previous operation"
        )
        .setDesc(
          restartRequired
            ? "Fully close Obsidian and reopen it. obts will not clear the old operation lock because doing so could overlap vault writes."
            : initializationInProgress
              ? `This checkpoint has been running for ${initializationElapsed}. The vault remains available while it finishes. Close and reopen settings to refresh.`
              : "obts will finish loading when the previous plugin instance releases its active vault operation."
        );
    } else if (pendingOnboarding) {
      const conflictPending = pendingOnboarding.journal.stage === "awaiting_conflict";
      const canCancelPending = !paired && ["awaiting_browser", "approved", "analyzing", "awaiting_confirmation"].includes(pendingOnboarding.journal.stage);
      new Setting(containerEl)
        .setName(conflictPending ? "Conflict review submitted" : "Finish connecting this vault")
        .setDesc(
          restartRequired
            ? "A plugin update interrupted an operation. Fully restart Obsidian, then return here to resume setup safely."
            : conflictPending
              ? "Resolve the conflict in the dashboard, then resume here to apply the resolution. Do not submit the merge again."
              : "Setup stopped after it started. Resume from the durable onboarding journal; obts will not create a second device."
        );
      new Setting(containerEl)
        .setName("Onboarding")
        .addButton((button) => {
          button
            .setButtonText(conflictPending ? "Resume conflict setup" : "Resume setup")
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
            const renamed = await this.plugin.runExclusiveAction(() => this.plugin.client.renameCurrentDevice(renameDraft));
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
                const result = await this.plugin.runUserAction(
                  () => this.plugin.syncOnceOrPollResolvedConflict({ confirmInitialImport: false }),
                  false
                );
                if (!result) {
                  setFeedback(actionFeedback, this.plugin.syncBlockedMessage(), "muted");
                  return;
                }
                this.plugin.setStatus((await this.plugin.client.readState()).status_label);
                setFeedback(actionFeedback, `Synced: ${result.status}`, "success");
                if (shouldShowRoutineStatusNotice(result.status)) new Notice(`obts: ${result.status}`);
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
                await this.plugin.runExclusiveAction(async () => {
                  await this.plugin.client.unpairCurrentDevice();
                  await this.plugin.saveSettings();
                });
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
                await this.plugin.runExclusiveAction(async () => {
                  await this.plugin.client.resetLocalPairingState();
                  await this.plugin.saveSettings();
                });
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
              });
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
  return `When obts fails or a startup checkpoint stalls, send a small sanitized technical report to ${destination}. Reports include plugin and platform versions, the failing operation, fixed error codes, and diagnostic checkpoints. They never include note content, vault or file names, paths, credentials, Git objects, packfiles, or raw logs.`;
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

async function bundleChecksums(fsp, bundleDir) {
  const entries = [];
  await walkBundleFiles(fsp, bundleDir, async (absolutePath) => {
    const relativePath = normalizePath(path.relative(bundleDir, absolutePath));
    if (relativePath === "checksums.sha256") {
      return;
    }
    entries.push(`${sha256(await fsp.readFile(absolutePath))}  ${relativePath}`);
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

function compactDirectoryIntents(intents) {
  const byPath = new Map();
  for (const intent of intents) {
    if (!intent || (intent.op !== "create" && intent.op !== "delete") || !isSyncableVaultPath(intent.path)) {
      continue;
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

function isRetryableLocalError(code) {
  return code === "local_snapshot_changed" || code === "upload_interrupted" || code === "pack_preparation_failed" || code === "invalid_path" || code === "path_collision" || code === "excluded_git_path" || code === "excluded_internal_path" || code === "excluded_path" || code === "unsupported_file_mode";
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
  for (const base of ["Checking", "Preparing upload", "Uploading", "Applying"]) {
    if (normalized === base || normalized.startsWith(`${base} `)) return base;
  }
  return normalized;
}

function statusPresentation(label) {
  const normalized = typeof label === "string" && label.trim().length > 0 ? label.trim() : "Checking";
  const base = statusBaseLabel(normalized);
  const action = base === "Review needed" ? "Click to open the conflict dashboard." : "Click to open obts settings.";
  let tone = "neutral";
  if (base === "Synced") tone = "success";
  else if (["Checking", "Preparing upload", "Uploading", "Applying", "Merging", "Finishing update", "Waiting for operation"].includes(base)) tone = "active";
  else if (["Ahead", "Behind", "Offline", "Review needed"].includes(base)) tone = "warning";
  else if (["Blocked", "Needs recovery", "Unsafe local state", "Integrity failure", "Recovery required", "Restart required"].includes(base)) tone = "danger";
  return {
    label: normalized,
    base,
    tone,
    action,
    title: `${normalized}. ${action}`
  };
}

function statusAttentionMessage(base) {
  if (base === "Review needed") return "obts needs attention: Resolve the conflict in the dashboard. Click the sync indicator to continue.";
  if (base === "Blocked") return "obts sync is blocked. Click the sync indicator to inspect the required action.";
  if (base === "Needs recovery") return "obts needs recovery before sync can continue. Click the sync indicator for recovery options.";
  if (base === "Unsafe local state") return "obts stopped to protect local changes. Click the sync indicator to inspect recovery options.";
  return null;
}

function isPersistentAttentionStatus(base) {
  return ["Review needed", "Blocked", "Needs recovery", "Unsafe local state", "Integrity failure", "Recovery required", "Restart required"].includes(base);
}

function isActiveTransferStatus(base) {
  return ["Preparing upload", "Uploading", "Applying", "Merging", "Finishing update", "Waiting for operation"].includes(base);
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

function blockStatusLabel(code) {
  if (code === "conflict_review_required") {
    return "Review needed";
  }
  if (code === "replace_local_with_server_required" || code === "device_blocked" || code === "stale_device_ref" || code === "same_device_non_fast_forward" || code === "local_state_incomplete") {
    return "Needs recovery";
  }
  if (code === "local_snapshot_changed") {
    return "Checking";
  }
  if (code === "initial_import_confirmation_required") {
    return "Blocked";
  }
  return "Unsafe local state";
}

async function readJson(fsp, filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readApplyJournalStrict(fsp, filePath) {
  try {
    return parseApplyJournal(JSON.parse(await fsp.readFile(filePath, "utf8")));
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
  if (
    (journalVersion !== 1 && journalVersion !== 2) ||
    typeof value.apply_id !== "string" || value.apply_id.length === 0 ||
    typeof value.operation_type !== "string" || !operations.has(value.operation_type) ||
    typeof value.target_main !== "string" || !/^[0-9a-f]{40}$/u.test(value.target_main) ||
    !isNullableString(value.expected_prior_local_main) ||
    !isNullableString(value.expected_prior_local_device_ref) ||
    typeof value.phase !== "string" || !phases.has(value.phase) ||
    !Array.isArray(affectedPaths) || affectedPaths.some((filePath) => typeof filePath !== "string" || !isSafeJournalPath(filePath)) ||
    new Set(affectedPaths).size !== affectedPaths.length ||
    !preflight || typeof preflight !== "object" || Array.isArray(preflight) ||
    affectedPaths.some((filePath) => !Object.hasOwn(preflight, filePath) || !isNullableSha256(preflight[filePath])) ||
    (journalVersion === 2 && (
      !typedPreflight || typeof typedPreflight !== "object" || Array.isArray(typedPreflight) ||
      affectedPaths.some((filePath) => !Object.hasOwn(typedPreflight, filePath) || !isPreflightFingerprint(typedPreflight[filePath]))
    )) ||
    !isNullableString(value.recovery_bundle_id) ||
    !isNullableString(value.last_completed_step) ||
    !isNullableString(value.redacted_error_category)
  ) {
    throw new Error("Apply journal is invalid.");
  }
  return value;
}

function isSafeJournalPath(filePath) {
  return normalizePath(filePath) === filePath && isValidVaultPath(filePath);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableSha256(value) {
  return value === null || typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
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

async function writeJson(fsp, filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${randomHex(4)}-${Date.now()}`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fsp.rename(temporaryPath, filePath);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exists(fsp, filePath) {
  try {
    await fsp.stat(filePath);
    return true;
  } catch {
    return false;
  }
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

function diagnosticContextForError(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current[DIAGNOSTIC_CONTEXT]) return current[DIAGNOSTIC_CONTEXT];
    current = current.cause;
  }
  return null;
}

function buildStalledOperationDiagnostic(diagnosticPoint) {
  const recovery = diagnosticPoint.startsWith("recovery_");
  const apply = diagnosticPoint.startsWith("apply_");
  const sync = diagnosticPoint === "local_snapshot" || diagnosticPoint === "upload_prepare";
  return {
    schema_version: 1,
    event_id: `dgr_${randomHex(16)}`,
    plugin_version: PLUGIN_VERSION,
    obsidian_version: typeof apiVersion === "string" && apiVersion ? apiVersion : "unknown",
    platform_family: Platform && Platform.isIosApp ? "ios" : Platform && Platform.isAndroidApp ? "android" : "desktop",
    flow: recovery ? "recovery" : apply ? "apply" : sync ? "sync" : "plugin",
    stage: recovery ? "recovery" : apply ? "apply" : sync ? "sync_request" : "plugin_lifecycle",
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
    flow: context && context.flow ? context.flow : lifecycleFailure ? "plugin" : blocked || transport ? "sync" : "plugin",
    stage: context && context.stage ? context.stage : lifecycleFailure ? "plugin_lifecycle" : transport ? "sync_request" : "unknown",
    failure_code: failureCode,
    error_class: transport ? "transport_error" : blocked ? "blocked_error" : error instanceof TypeError ? "type_error" : error instanceof Error ? "error" : "unknown",
    retryable: transport ? isOfflineTransportError(error) || isRetryableServerError(error) : false,
    breadcrumbs: context && Array.isArray(context.breadcrumbs) ? context.breadcrumbs.slice(0, 16).map(normalizeDiagnosticBreadcrumb) : []
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
  const points = new Set(["onboarding_approved", "bootstrap_response", "multipart_pack", "pack_persist_write", "pack_persist_read", "index_fs_stat", "index_fs_read_file", "index_fs_read", "index_fs_write", "index_pack", "sync_request", "apply", "apply_recovery_prepare", "apply_preflight_revalidate", "apply_write", "apply_verify", "local_snapshot", "upload_prepare", "recovery"]);
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

module.exports.ObtsClientCore = ObtsObsidianClient;
module.exports.PluginBlockedError = ObtsBlockedError;
module.exports.TransportError = ObtsTransportError;
