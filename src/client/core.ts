import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import {
  API_VERSION,
  type ConnectionStatusResponse,
  type CreateConnectionResponse
} from '../shared/types.js';
import { PLUGIN_VERSION } from '../../obsidian-plugin/src/version.js';
import { NodeDataAdapter } from './nodeDataAdapter.js';

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

export type OnboardingJournal = {
  version: 1;
  stage: OnboardingStage;
  connection: Record<string, unknown>;
  analysis: OnboardingAnalysis | null;
  selected_mode: 'initialize' | 'use_server' | 'merge' | null;
  registered_device_id?: string | null;
  proposal_commit?: string | null;
  last_error_code: string | null;
  updated_at: string;
};

export type QueueState = {
  pending_commit: string | null;
  expected_device_ref: string | null;
  status: 'idle' | 'queued_local' | 'uploading' | 'uploaded' | 'merged' | 'conflicted' | 'blocked_recovery';
  attempts: number;
  change_seq?: number;
  updated_at: string;
};

export type RebuildResult = {
  status: string;
  main: string;
  recoveryCommit?: string;
  preservedPendingCommit?: string;
};

export type SyncResult = { status: string; main?: string; conflictId?: string };

type SharedClientCore = {
  initialize(): Promise<void>;
  readState(): Promise<LocalPluginState>;
  readPrimaryState(): Promise<LocalPluginState | null>;
  readBackupState(): Promise<LocalPluginState | null>;
  readQueue(): Promise<QueueState>;
  readPendingOnboarding(): Promise<{ journal: OnboardingJournal; secret: string } | null>;
  readDeviceToken(): Promise<string>;
  startOnboarding(): Promise<CreateConnectionResponse>;
  pollOnboarding(connectionId: string, secret: string): Promise<ConnectionStatusResponse>;
  analyzeOnboarding(connectionId: string, secret: string): Promise<OnboardingAnalysis>;
  finishOnboarding(
    connectionId: string,
    secret: string,
    analysis: OnboardingAnalysis,
    mode: 'initialize' | 'use_server' | 'merge'
  ): Promise<SyncResult>;
  cancelOnboarding(): Promise<void>;
  recordLocalChangeHint(paths: string[]): Promise<void>;
  syncOnce(options?: { confirmInitialImport?: boolean }): Promise<SyncResult>;
  pullAndApply(allowDestructive: boolean): Promise<boolean>;
  pollRemoteEventsAndApply(): Promise<{ applied: boolean; status: string }>;
  replaceLocalWithServer(): Promise<{ status: string; main: string }>;
  rebuildFromServerMain(): Promise<RebuildResult>;
  renameCurrentDevice(deviceName: string): Promise<string>;
  unpairCurrentDevice(): Promise<{ status: 'Not paired' }>;
  resetLocalPairingState(): Promise<{ status: 'Not paired'; recoveryBundleId: string | null }>;
  reportDeviceStatus(): Promise<void>;
  markBlocked(code: string, details?: Record<string, unknown>): Promise<void>;
};

type SharedClientInternals = SharedClientCore & {
  createLocalCommit(...args: any[]): Promise<any>;
  importPack(...args: any[]): Promise<any>;
  readBlob(...args: any[]): Promise<any>;
  updateRef(...args: any[]): Promise<any>;
  createRecoveryBundle(...args: any[]): Promise<any>;
  writeTargetFilesFromJournal(...args: any[]): Promise<any>;
  writeState(state: unknown): Promise<void>;
  pull(...args: any[]): Promise<any>;
  pullChunk(input: Record<string, unknown>): Promise<any>;
  putPushChunk(input: Record<string, unknown>): Promise<any>;
  completeConnection(...args: any[]): Promise<any>;
};

type MutableMethod = (...args: any[]) => any;

type SharedModule = {
  ObtsClientCore: new (plugin: NodePluginHost) => SharedClientCore;
  PluginBlockedError: new (code: string, message: string) => Error & { code: string };
  TransportError: new (status: number, code: string, message: string, details?: unknown) => Error & {
    status: number;
    code: string;
    details?: unknown;
  };
};

type NodePluginHost = ReturnType<typeof createNodePluginHost>;

const shared = loadSharedModule();
export const PluginBlockedError = shared.PluginBlockedError;
export const TransportError = shared.TransportError;

export class ObtsPluginClient {
  readonly settings: ObtsPluginSettings;
  private readonly host: NodePluginHost;
  readonly client: SharedClientInternals;
  readonly git: Record<string, MutableMethod>;
  readonly recovery: Record<string, MutableMethod>;
  readonly transport: Record<string, MutableMethod>;

  constructor(vaultDir: string, settings: ObtsPluginSettings) {
    this.settings = settings;
    this.host = createNodePluginHost(vaultDir, settings);
    this.host.flushOpenMarkdownEditorsToDisk = () => this.flushEditorBuffersToDisk();
    this.client = new shared.ObtsClientCore(this.host) as SharedClientInternals;
    this.git = exposeMutableMethods(this.client, ['createLocalCommit', 'importPack', 'readBlob']);
    this.git.setLocalHead = (commit: string) => this.client.updateRef('refs/heads/local', commit, null, true);
    this.git.setLocalMain = (commit: string) => this.client.updateRef('refs/heads/main', commit, null, true);
    this.recovery = {};
    exposeCompatibleRecovery(this.recovery, this.client);
    this.transport = exposeMutableMethods(this.client, ['pullChunk', 'putPushChunk', 'completeConnection']);
    exposeCompatiblePull(this.transport, this.client);
    exposeDirectMutableMethod(this, this.client, 'writeTargetFilesFromJournal');
  }

  get unloaded(): boolean {
    return this.host.unloaded;
  }

  set unloaded(value: boolean) {
    this.host.unloaded = value;
  }

  flushEditorBuffersToDisk(): Promise<void> {
    return Promise.resolve();
  }

  initialize(): Promise<void> {
    return this.client.initialize();
  }

  readState(): Promise<LocalPluginState> {
    return this.client.readState();
  }

  readPrimaryState(): Promise<LocalPluginState | null> {
    return this.client.readPrimaryState();
  }

  readBackupState(): Promise<LocalPluginState | null> {
    return this.client.readBackupState();
  }

  readQueue(): Promise<QueueState> {
    return this.client.readQueue();
  }

  readPendingOnboarding(): Promise<{ journal: OnboardingJournal; secret: string } | null> {
    return this.client.readPendingOnboarding();
  }

  readDeviceToken(): Promise<string> {
    return this.client.readDeviceToken();
  }

  startOnboarding(localVaultName?: string): Promise<CreateConnectionResponse> {
    if (localVaultName?.trim()) this.host.vaultName = localVaultName.trim();
    return this.client.startOnboarding();
  }

  pollOnboarding(connectionId: string, secret: string): Promise<ConnectionStatusResponse> {
    return this.client.pollOnboarding(connectionId, secret);
  }

  analyzeOnboarding(connectionId: string, secret: string): Promise<OnboardingAnalysis> {
    return this.client.analyzeOnboarding(connectionId, secret);
  }

  finishOnboarding(input: {
    connectionId: string;
    secret: string;
    analysis: OnboardingAnalysis;
    mode: 'initialize' | 'use_server' | 'merge';
  }): Promise<SyncResult> {
    return this.client.finishOnboarding(input.connectionId, input.secret, input.analysis, input.mode);
  }

  cancelOnboarding(): Promise<void> {
    return this.client.cancelOnboarding();
  }

  recordLocalChangeHint(paths: string[]): Promise<void> {
    return this.client.recordLocalChangeHint(paths);
  }

  syncOnce(options?: { confirmInitialImport?: boolean }): Promise<SyncResult> {
    return this.client.syncOnce(options);
  }

  pullAndApply(options: { allowDestructive: boolean }): Promise<boolean> {
    return this.client.pullAndApply(options.allowDestructive);
  }

  pollRemoteEventsAndApply(): Promise<{ applied: boolean; status: string }> {
    return this.client.pollRemoteEventsAndApply();
  }

  replaceLocalWithServer(): Promise<{ status: string; main: string }> {
    return this.client.replaceLocalWithServer();
  }

  rebuildFromServerMain(): Promise<RebuildResult> {
    return this.client.rebuildFromServerMain();
  }

  renameCurrentDevice(deviceName: string): Promise<string> {
    return this.client.renameCurrentDevice(deviceName);
  }

  unpairCurrentDevice(): Promise<{ status: 'Not paired' }> {
    return this.client.unpairCurrentDevice();
  }

  resetLocalPairingState(): Promise<{ status: 'Not paired'; recoveryBundleId: string | null }> {
    return this.client.resetLocalPairingState();
  }

  reportDeviceStatus(): Promise<void> {
    return this.client.reportDeviceStatus();
  }

  markBlocked(code: string, details?: Record<string, unknown>): Promise<void> {
    return this.client.markBlocked(code, details);
  }

  writeState(state: unknown): Promise<void> {
    return this.client.writeState(state);
  }
}

function exposeMutableMethods(target: SharedClientInternals, names: string[]): Record<string, MutableMethod> {
  const exposed: Record<string, MutableMethod> = {};
  for (const name of names) exposeDirectMutableMethod(exposed, target, name);
  return exposed;
}

function exposeDirectMutableMethod(owner: object, target: SharedClientInternals, name: string): void {
  Object.defineProperty(owner, name, {
    configurable: true,
    enumerable: true,
    get: () => (target[name as keyof SharedClientInternals] as MutableMethod).bind(target),
    set: (method: MutableMethod) => {
      (target as unknown as Record<string, MutableMethod>)[name] = method;
    }
  });
}

function exposeCompatibleRecovery(owner: Record<string, MutableMethod>, target: SharedClientInternals): void {
  Object.defineProperty(owner, 'createRecoveryBundle', {
    configurable: true,
    enumerable: true,
    get: () => {
      const createRecoveryBundle = target.createRecoveryBundle.bind(target);
      return (input: Record<string, any>) => createRecoveryBundle(
        input.operationType,
        input.targetMain,
        input.affectedPaths,
        input.journal ?? null
      );
    },
    set: (method: MutableMethod) => {
      target.createRecoveryBundle = async (operationType, targetMain, affectedPaths, journal = null) => {
        const state = await target.readState();
        return await method({
          vaultId: state.vault_id ?? 'unknown',
          deviceId: state.device_id ?? 'unknown',
          operationType,
          targetMain: targetMain ?? 'unknown',
          priorLocalMain: state.local_main,
          priorLocalDeviceRef: state.server_device_ref,
          affectedPaths,
          platform: process.platform,
          pluginVersion: PLUGIN_VERSION,
          journal
        });
      };
    }
  });
}

function exposeCompatiblePull(owner: Record<string, MutableMethod>, target: SharedClientInternals): void {
  Object.defineProperty(owner, 'pull', {
    configurable: true,
    enumerable: true,
    get: () => {
      const pull = target.pull.bind(target);
      return (input: Record<string, any>) => pull(
        input.vaultId,
        input.deviceId,
        input.deviceToken,
        input.currentLocalMain,
        input.requestedTarget ?? 'latest',
        input.currentEventSeq
      );
    },
    set: (method: MutableMethod) => {
      target.pull = (vaultId, deviceId, deviceToken, currentLocalMain, requestedTarget, currentEventSeq) => method({
        vaultId,
        deviceId,
        deviceToken,
        currentLocalMain,
        requestedTarget,
        currentEventSeq
      });
    }
  });
}

function loadSharedModule(): SharedModule {
  const runtime = {
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    Notice: class {},
    Modal: class {},
    Platform: { isMobile: false },
    requestUrl: nodeRequestUrl,
    apiVersion: 'node-headless',
    obtsApiVersion: API_VERSION,
    obtsPluginVersion: PLUGIN_VERSION
  };
  (globalThis as typeof globalThis & { __OBTS_CLIENT_RUNTIME__?: unknown }).__OBTS_CLIENT_RUNTIME__ = runtime;
  try {
    const require = createRequire(import.meta.url);
    for (const candidate of ['../../obsidian-plugin/src/main.cjs', '../../../obsidian-plugin/src/main.cjs']) {
      try {
        return require(candidate) as SharedModule;
      } catch (error) {
        if (!isMissingSharedModule(error, candidate)) throw error;
      }
    }
    throw new Error('Could not locate the shared OBTS client module.');
  } finally {
    delete (globalThis as typeof globalThis & { __OBTS_CLIENT_RUNTIME__?: unknown }).__OBTS_CLIENT_RUNTIME__;
  }
}

function createNodePluginHost(vaultDir: string, settings: ObtsPluginSettings) {
  const adapter = new NodeDataAdapter(vaultDir);
  const host = {
    app: {
      vault: {
        adapter,
        getName: () => host.vaultName
      }
    },
    settings,
    vaultName: settings.vaultId ?? 'OBTS Headless Vault',
    lifecycleAbortController: new AbortController(),
    unloaded: false,
    syncQueued: false,
    isApplying: false,
    lastCheckingProgressAt: 0,
    deviceNameRevision: 0,
    setInitializationStage: (_label: string, _diagnosticPoint?: string) => undefined,
    updateInitializationProgress: (_message: string) => undefined,
    setStatus: (_status: string) => undefined,
    markFullScanCompleted: () => undefined,
    handlePluginCompatibility: (_compatibility: unknown) => undefined,
    flushOpenMarkdownEditorsToDisk: async (): Promise<void> => {},
    saveSettings: async () => undefined
  };
  return host;
}

function isMissingSharedModule(error: unknown, candidate: string): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'MODULE_NOT_FOUND'
    && error.message.includes(candidate);
}

async function nodeRequestUrl(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
  arrayBuffer: ArrayBuffer;
}> {
  const request: RequestInit = {
    method: options.method ?? 'GET',
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.body === undefined ? {} : { body: options.body })
  };
  const response = await fetch(options.url, request);
  const arrayBuffer = await response.arrayBuffer();
  const text = Buffer.from(arrayBuffer).toString('utf8');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json,
    arrayBuffer
  };
}
