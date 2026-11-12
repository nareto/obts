import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';

type Json = Record<string, any>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function settle(turns = 16) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected background sync behavior.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settle();
}

class StatusElement {
  text = '';
  attrs: Record<string, string> = {};
  children: StatusElement[] = [];
  classes = new Set<string>();
  classList = {
    add: (value: string) => { this.classes.add(value); },
    remove: (value: string) => { this.classes.delete(value); }
  };
  setText(value: string) { this.text = value; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener() {}
  createEl() { const child = new StatusElement(); this.children.push(child); return child; }
  createDiv() { return this.createEl(); }
  empty() { this.children = []; }
  addClass() {}
}

/**
 * Runs the built plugin artifact against a real local vault, with the vault's
 * background interval under manual control and the client's network surface
 * stubbed, so a test observes exactly which automatic attempts a wake-up
 * produces and how the retry policy reacts to a failure.
 */
async function createHarness(options: { mobile: boolean }) {
  await mkdir('tmp/plugin-background-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/plugin-background-tests/vault-'));
  roots.push(root);
  const adapter = new NodeDataAdapter(root);
  const attempts: string[] = [];
  const triggers: string[] = [];
  const statusReports: string[] = [];
  const inventorySchedules: string[] = [];
  const fullInventories: string[] = [];
  const notices: string[] = [];
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const registeredIntervals: number[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const layoutReady: Array<() => void> = [];
  const statusItems: StatusElement[] = [];
  let nextIntervalId = 1;

  const fakeSetInterval = (fn: () => void, ms: number) => {
    const id = nextIntervalId++;
    intervals.set(id, { fn, ms });
    return id;
  };
  const fakeClearInterval = (id: number) => { intervals.delete(id); };
  const register = (target: string, name: string, listener: () => void) => {
    const key = `${target}:${name}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key)!.push(listener);
  };
  const fire = (target: string, name: string) => {
    for (const listener of listeners.get(`${target}:${name}`) || []) listener();
  };

  const doc: Json = {
    hidden: false,
    addEventListener: (name: string, listener: () => void) => register('document', name, listener),
    removeEventListener: () => undefined
  };
  const win: Json = {
    open: () => undefined,
    setTimeout,
    clearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    addEventListener: (name: string, listener: () => void) => register('window', name, listener),
    removeEventListener: () => undefined
  };

  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addButton() { return this; }
    addToggle() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
  }
  class Plugin {
    app!: Json;
    manifest = { id: 'obts' };
    async loadData() { return { serverUrl: 'http://127.0.0.1:1', deviceName: 'Background test device' }; }
    async saveData() {}
    addStatusBarItem() { const item = new StatusElement(); statusItems.push(item); return item; }
    addRibbonIcon() { return new StatusElement(); }
    addSettingTab() {}
    addCommand() {}
    registerEvent() {}
    registerInterval(id: number) { registeredIntervals.push(id); }
    registerDomEvent(target: Json, name: string, listener: () => void) {
      if (target === doc) register('document', name, listener);
      else if (target === win) register('window', name, listener);
    }
  }
  const obsidian = {
    Plugin,
    PluginSettingTab: class { constructor(_app: Json, _plugin: Json) {} },
    Setting,
    Notice: class { constructor(message: string) { notices.push(message); } },
    Modal: class {},
    Platform: { isMobile: options.mobile, isDesktopApp: !options.mobile },
    apiVersion: '1.9.12',
    requestUrl: async () => ({ status: 503, headers: {}, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) })
  };

  const module = { exports: {} as any };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name !== 'obsidian') throw new Error(`Unexpected runtime require: ${name}`);
      return obsidian;
    },
    window: win,
    document: doc,
    navigator: { onLine: true },
    crypto: webcrypto,
    console,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    Blob,
    Response,
    Request,
    Headers,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval
  });
  Object.assign(context, { globalThis: context });

  new vm.Script(await readFile('obsidian-plugin/main.js', 'utf8'), { filename: 'obsidian-plugin/main.js' }).runInContext(context);
  const TransportError = module.exports.TransportError;
  const isTerminalSyncError = module.exports.isTerminalSyncError as (code: unknown) => boolean;
  const plugin: Json = new module.exports();
  plugin.app = {
    vault: {
      adapter,
      getName: () => 'Background test vault',
      on: () => ({ unsubscribe: () => undefined })
    },
    workspace: {
      onLayoutReady: (callback: () => void) => layoutReady.push(callback),
      getLeavesOfType: () => []
    },
    setting: { open: () => undefined, openTabById: () => undefined }
  };
  await plugin.onload();

  const client: Json = plugin.client;
  await client.writeState({
    ...(await client.readState()),
    vault_id: 'vlt_background_test',
    device_id: 'dev_background_test',
    status_label: 'Synced',
    last_error_code: null,
    updated_at: new Date().toISOString()
  });

  client.readPendingOnboarding = async () => null;
  client.readQueue = async () => ({ pending_commit: null, status: 'idle', changed_paths: [] });
  client.backgroundScanDecision = async () => ({ required: false, mode: 'none' });
  client.pollRemoteEventsAndApply = async () => { attempts.push('poll'); return { applied: false }; };
  client.syncOnce = async () => { attempts.push('sync'); return { status: 'Synced' }; };
  client.reconcileDeviceBlocked = async () => { attempts.push('reconcile'); return { status: 'Out of sync' }; };
  client.reportDeviceStatus = async () => { statusReports.push('reported'); };
  client.scheduleInventoryAfterCatchUp = () => { inventorySchedules.push('scheduled'); };
  client.requestFullInventory = () => { fullInventories.push('requested'); };
  client.beginSyncTimingAttempt = (trigger: string) => { triggers.push(trigger); return true; };

  const harness = {
    plugin,
    client,
    TransportError,
    isTerminalSyncError,
    doc,
    intervals,
    registeredIntervals,
    notify: { attempts, triggers, statusReports, inventorySchedules, fullInventories, notices },
    fire,
    reset() {
      attempts.length = 0;
      triggers.length = 0;
      statusReports.length = 0;
      inventorySchedules.length = 0;
      fullInventories.length = 0;
    },
    backgroundInterval() {
      const id = registeredIntervals[0];
      expect(id, 'the background sync interval is registered').toBeDefined();
      return intervals.get(id as number)!;
    },
    backgroundTick() {
      harness.backgroundInterval().fn();
    },
    // Drives the coalescing debounce deterministically instead of sleeping for
    // it: whatever the triggers queued runs as exactly one attempt.
    async runQueuedSyncNow() {
      if (plugin.queuedSyncTimer !== null) {
        clearTimeout(plugin.queuedSyncTimer);
        plugin.queuedSyncTimer = null;
      }
      await plugin.runQueuedSync();
    },
    get backgroundIntervalMs() {
      return harness.backgroundInterval().ms;
    },
    // Finishes client initialization the way the workspace does, then runs the
    // single catch-up attempt it queued.
    async start() {
      expect(layoutReady.length).toBeGreaterThan(0);
      for (const callback of layoutReady.splice(0)) callback();
      await plugin.ensureClientReady();
      expect(plugin.syncQueued, 'initialization queues one catch-up attempt').toBe(true);
      await harness.runQueuedSyncNow();
      await settle();
      return harness;
    },
    async dispose() {
      plugin.onunload();
      intervals.clear();
      await settle();
    }
  };
  return harness;
}

describe('desktop background sync', () => {
  it('keeps attempting while the window is hidden', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    harness.reset();
    harness.doc.hidden = true;
    harness.backgroundTick();
    await waitFor(() => harness.notify.attempts.length === 1);
    expect(harness.notify.attempts).toEqual(['poll']);
    // The desktop cadence is the unchanged background interval: a hidden,
    // minimized, or other-desktop window is not device unavailability.
    expect(harness.backgroundIntervalMs).toBe(10000);
    await harness.dispose();
  });

  it('still waits for the app to resume on mobile', async () => {
    const harness = await createHarness({ mobile: true });
    await harness.start();
    harness.reset();
    harness.doc.hidden = true;
    harness.backgroundTick();
    await settle();
    expect(harness.notify.attempts).toEqual([]);
    harness.doc.hidden = false;
    harness.fire('document', 'visibilitychange');
    await waitFor(() => harness.notify.attempts.length === 1);
    expect(harness.notify.attempts).toEqual(['poll']);
    await harness.dispose();
  });

  it('catches up once initialization finishes without forcing an inventory', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    expect(harness.notify.attempts).toEqual(['sync']);
    // Both the initialization lease and the catch-up attempt it queues report
    // the startup trigger, so the timing telemetry can tell them apart from
    // interval and watcher work.
    expect(harness.notify.triggers.filter((trigger) => trigger !== 'startup')).toEqual([]);
    expect(harness.notify.triggers.at(-1)).toBe('startup');
    expect(harness.notify.fullInventories).toEqual([]);
    expect(harness.notify.inventorySchedules).toEqual([]);
    await harness.dispose();
  });

  it('coalesces window focus and network reconnect into one attempt', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    harness.reset();
    harness.fire('window', 'focus');
    harness.fire('window', 'online');
    harness.fire('window', 'focus');
    await settle();
    expect(harness.notify.attempts).toEqual([]);
    expect(harness.plugin.syncQueued).toBe(true);
    await harness.runQueuedSyncNow();
    await settle();
    expect(harness.notify.attempts).toEqual(['sync']);
    expect(harness.notify.triggers).toEqual(['visibility']);
    expect(harness.notify.fullInventories).toEqual([]);
    expect(harness.notify.inventorySchedules).toEqual([]);
    await harness.dispose();
  });
});

describe('retry classification', () => {
  it('only treats outcomes a person must resolve as terminal', async () => {
    const harness = await createHarness({ mobile: false });
    const terminal = [
      'conflict_review_required',
      'replace_local_with_server_required',
      'initial_import_confirmation_required',
      'device_blocked',
      'device_revoked',
      'device_identity_mismatch',
      'not_paired',
      'blocked_integrity',
      'server_recovery_required',
      'object_too_large_for_chunk',
      'apply_journal_recovery_required',
      'upload_checkpoint_recovery_required',
      'directory_recovery_journal_invalid',
      'catchup_recovery_required',
      'onboarding_context_required'
    ];
    // Fixable local, policy, and transport outcomes must keep retrying: the
    // restricted-platform pull outcome in particular is retried by contract.
    const retryable = [
      'network_error',
      'http_error',
      'sync_error',
      'git_error',
      'server_git_error',
      'server_processing_error',
      'upload_interrupted',
      'pack_preparation_failed',
      'local_snapshot_changed',
      'stale_directory_proposal_base',
      'directory_acknowledgement_missing',
      'rename_endpoint_ignored',
      'unportable_target_paths',
      'invalid_path',
      'path_collision',
      'excluded_git_path',
      'unsupported_file_mode',
      'server_update_required',
      'onboarding_catchup_busy',
      'connection_not_approved',
      'local_ref_changed',
      'apply_lock_active'
    ];
    for (const code of terminal) expect(harness.isTerminalSyncError(code), code).toBe(true);
    for (const code of retryable) expect(harness.isTerminalSyncError(code), code).toBe(false);
    for (const value of [null, undefined, '', 42]) expect(harness.isTerminalSyncError(value)).toBe(false);
    await harness.dispose();
  });
});

describe('automatic retry policy', () => {
  it('retries a non-terminal failure with growing backoff instead of latching', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    harness.reset();
    harness.client.backgroundScanDecision = async () => ({ required: true, mode: 'full' });
    harness.client.syncOnce = async () => {
      harness.notify.attempts.push('sync');
      throw new harness.TransportError(409, 'unexpected_local_failure', 'local failure');
    };

    harness.backgroundTick();
    await waitFor(async () => harness.plugin.syncRunning === false &&
      (await harness.client.readState()).last_error_code === 'unexpected_local_failure');
    const firstDelay = harness.plugin.automaticRetryNotBefore - Date.now();
    expect(firstDelay).toBeGreaterThan(5000);
    expect(firstDelay).toBeLessThanOrEqual(10000);
    const failed = await harness.client.readState();
    expect(failed).toMatchObject({ last_error_code: 'unexpected_local_failure', status_label: 'Out of sync' });
    expect(Date.parse(failed.last_error_at)).toBeGreaterThan(0);
    expect(harness.plugin.currentStatusLabel).toBe('Out of sync');

    // Inside the backoff window the interval tick attempts nothing.
    harness.backgroundTick();
    await settle();
    expect(harness.notify.attempts).toHaveLength(1);

    // Once the backoff has elapsed the same failure is retried, not latched.
    harness.plugin.automaticRetryNotBefore = 0;
    harness.backgroundTick();
    await waitFor(() => harness.notify.attempts.length === 2);
    await waitFor(() => harness.plugin.syncRunning === false && harness.plugin.automaticRetryNotBefore > 0);
    const secondDelay = harness.plugin.automaticRetryNotBefore - Date.now();
    expect(secondDelay).toBeGreaterThan(firstDelay);

    for (let index = 0; index < 12; index += 1) harness.plugin.recordTransientSyncFailure();
    const cappedDelay = harness.plugin.automaticRetryNotBefore - Date.now();
    expect(cappedDelay).toBeGreaterThan(4 * 60 * 1000);
    expect(cappedDelay).toBeLessThanOrEqual(5 * 60 * 1000);
    await harness.dispose();
  });

  it('keeps a terminal outcome until the user resolves it', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    harness.reset();
    harness.client.backgroundScanDecision = async () => ({ required: true, mode: 'full' });
    harness.client.syncOnce = async () => {
      harness.notify.attempts.push('sync');
      throw new harness.TransportError(409, 'blocked_integrity', 'vault integrity repair required');
    };

    harness.backgroundTick();
    await waitFor(async () => harness.plugin.currentStatusLabel === 'Server repair required' &&
      (await harness.client.readState()).last_error_code === 'blocked_integrity');
    expect(await harness.client.readState()).toMatchObject({
      status_label: 'Server repair required',
      last_error_code: 'blocked_integrity'
    });
    expect(harness.plugin.currentStatusLabel).toBe('Server repair required');
    expect(harness.plugin.automaticRetryNotBefore).toBe(0);

    harness.reset();
    harness.backgroundTick();
    harness.backgroundTick();
    // The device status is still refreshed so the dashboard keeps seeing it.
    await waitFor(() => harness.notify.statusReports.length === 2);
    expect(harness.notify.attempts).toEqual([]);
    await harness.dispose();
  });

  it('keeps the dedicated conflict poll on the ordinary background cadence', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    harness.reset();
    harness.client.backgroundScanDecision = async () => ({ required: true, mode: 'full' });
    harness.client.syncOnce = async () => {
      harness.notify.attempts.push('sync');
      throw new harness.TransportError(409, 'conflict_review_required', 'review the conflict');
    };

    harness.backgroundTick();
    await waitFor(async () => harness.plugin.currentStatusLabel === 'Conflict resolution needed' &&
      (await harness.client.readState()).last_error_code === 'conflict_review_required');
    expect(await harness.client.readState()).toMatchObject({
      status_label: 'Conflict resolution needed',
      last_error_code: 'conflict_review_required'
    });
    expect(harness.plugin.automaticRetryNotBefore).toBe(0);

    harness.reset();
    harness.backgroundTick();
    await waitFor(() => harness.notify.attempts.length === 1);
    expect(harness.notify.attempts).toEqual(['poll']);
    await harness.dispose();
  });
});

describe('honest persisted status', () => {
  it('presents a failure from an earlier session as the last observed one', async () => {
    const harness = await createHarness({ mobile: false });
    const now = Date.now();
    const stale = {
      status_label: 'Out of sync',
      last_error_code: 'upload_interrupted',
      last_error_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(now).toISOString()
    };
    expect(harness.plugin.persistedStatusLabel(stale)).toBe('Out of sync (last error 2h ago)');
    expect(harness.plugin.persistedStatusLabel({ ...stale, last_error_at: new Date(now).toISOString() })).toBe('Out of sync');
    expect(harness.plugin.persistedStatusLabel({ status_label: 'Synced', last_error_code: null, updated_at: stale.updated_at })).toBe('Synced');
    // A failure this session observed is the current state, however old it is.
    harness.plugin.sessionAttemptBaselineAt = now - 3 * 60 * 60 * 1000;
    expect(harness.plugin.persistedStatusLabel(stale)).toBe('Out of sync');
    await harness.dispose();
  });

  it('shows checking for a pending retry but not for an outcome that needs the user', async () => {
    const harness = await createHarness({ mobile: false });
    await harness.start();
    const state = await harness.client.readState();
    await harness.client.writeState({
      ...state,
      status_label: 'Out of sync',
      last_error_code: 'upload_interrupted',
      last_error_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    });
    harness.plugin.queueAutomaticSync('visibility');
    await waitFor(() => harness.plugin.currentStatusLabel === 'Checking');

    await harness.client.writeState({
      ...(await harness.client.readState()),
      status_label: 'Server repair required',
      last_error_code: 'blocked_integrity'
    });
    harness.plugin.setStatus('Server repair required');
    harness.plugin.queueAutomaticSync('visibility');
    await settle();
    expect(harness.plugin.currentStatusLabel).toBe('Server repair required');
    await harness.dispose();
  });
});
