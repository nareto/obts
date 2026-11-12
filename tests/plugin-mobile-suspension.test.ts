import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';
import {
  advancePastStaleHorizons,
  createSyncCostFixture,
  resumeClient,
  syncUntilSettled,
  tickUntilSettled,
  writeNote,
  type SyncCostFixture
} from './helpers/syncCostHarness.js';

type Json = Record<string, any>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  vi.useRealTimers();
});

async function settle(turns = 24) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected suspension behavior.');
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
 * Runs the built plugin artifact the way an Android device reaches it: the
 * platform reports mobile, the WebView is hidden and frozen by the harness, and
 * the client's network surface is stubbed, so a test observes exactly what the
 * leave and resume paths do and what the plugin reports as the device status.
 */
async function createHarness() {
  await mkdir('tmp/plugin-suspension-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/plugin-suspension-tests/vault-'));
  roots.push(root);
  const adapter = new NodeDataAdapter(root);
  const attempts: string[] = [];
  const triggers: string[] = [];
  const pushes: string[] = [];
  const inventorySchedules: string[] = [];
  const fullInventories: string[] = [];
  const requests: { url: string; body: string }[] = [];
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const registeredIntervals: number[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const layoutReady: Array<() => void> = [];
  const statusItems: StatusElement[] = [];
  let nextIntervalId = 1;
  let plan: Json = { pending: false, within_budget: false };

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
    async loadData() {
      return {
        serverUrl: 'http://127.0.0.1:1',
        deviceName: 'Suspension test device',
        shareErrorDiagnostics: true,
        diagnosticConsentServer: 'http://127.0.0.1:1',
        diagnosticConsentVersion: 2
      };
    }
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
    Notice: class { constructor(_message: string) {} },
    Modal: class {},
    Platform: { isMobile: true, isAndroidApp: true, isDesktopApp: false },
    apiVersion: '1.9.12',
    requestUrl: async (options: Json) => {
      requests.push({ url: String(options.url), body: typeof options.body === 'string' ? options.body : '' });
      // A device-status response carries the server's own feedback; the plugin
      // consumes it, so the stub answers the real shape instead of an empty body.
      const body = String(options.url).endsWith('/sync/device-status')
        ? { status: 'ok', device_name: 'Suspension test device', vault_status: 'active', plugin: { update_available: false }, restricted_name_platforms: [] }
        : {};
      return { status: 200, headers: {}, json: body, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) };
    }
  };

  const module = { exports: {} as any };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === 'obsidian') return obsidian;
      throw new Error(`Unexpected runtime require: ${name}`);
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
  const plugin: Json = new module.exports();
  plugin.app = {
    vault: {
      adapter,
      getName: () => 'Suspension test vault',
      on: () => ({ unsubscribe: () => undefined })
    },
    workspace: {
      onLayoutReady: (callback: () => void) => layoutReady.push(callback),
      getLeavesOfType: () => []
    },
    setting: { open: () => undefined, openTabById: () => undefined }
  };
  await plugin.onload();

  await mkdir(join(root, '.obts', 'auth'), { recursive: true });
  await writeFile(join(root, '.obts', 'auth', 'device-token.json'), JSON.stringify({ device_token: 'test-device-token' }));

  const client: Json = plugin.client;
  await client.writeState({
    ...(await client.readState()),
    vault_id: 'vlt_suspension_test',
    device_id: 'dev_suspension_test',
    status_label: 'Synced',
    last_error_code: null,
    updated_at: new Date().toISOString()
  });

  client.readPendingOnboarding = async () => null;
  client.readQueue = async () => ({ pending_commit: null, status: 'idle', changed_paths: [] });
  client.backgroundScanDecision = async () => ({ required: false, mode: 'none' });
  client.pollRemoteEventsAndApply = async () => { attempts.push('poll'); return { applied: false }; };
  client.syncOnce = async () => { attempts.push('sync'); return { status: 'Synced' }; };
  client.scheduleInventoryAfterCatchUp = () => { inventorySchedules.push('scheduled'); };
  client.requestFullInventory = () => { fullInventories.push('requested'); };
  client.beginSyncTimingAttempt = (trigger: string) => { triggers.push(trigger); return true; };
  client.backgroundSuspensionPlan = async () => plan;
  client.pushHintedChangesBeforeSuspend = async () => { pushes.push('pushed'); return { status: 'Synced' }; };

  const harness = {
    plugin,
    client,
    doc,
    intervals,
    registeredIntervals,
    notify: { attempts, triggers, pushes, inventorySchedules, fullInventories, requests },
    fire,
    setPlan(next: Json) { plan = next; },
    statusLabels() {
      return statusItems.map((item) => item.text.replace(/^obts: /u, ''));
    },
    reset() {
      attempts.length = 0;
      triggers.length = 0;
      pushes.length = 0;
      inventorySchedules.length = 0;
      fullInventories.length = 0;
      requests.length = 0;
    },
    async start() {
      for (const callback of layoutReady.splice(0)) callback();
      await plugin.ensureClientReady();
      if (plugin.queuedSyncTimer !== null) {
        clearTimeout(plugin.queuedSyncTimer);
        plugin.queuedSyncTimer = null;
      }
      await plugin.runQueuedSync();
      await settle();
      harness.reset();
      return harness;
    },
    hide() {
      doc.hidden = true;
      fire('document', 'visibilitychange');
    },
    show() {
      doc.hidden = false;
      fire('document', 'visibilitychange');
    },
    async dispose() {
      plugin.onunload();
      intervals.clear();
      await settle();
    }
  };
  return harness;
}

async function ensureNote(vaultDir: string, index: number, body: string): Promise<string> {
  await mkdir(join(vaultDir, `folder-${String(index % 24).padStart(2, '0')}`), { recursive: true });
  return await writeNote(vaultDir, index, body);
}

function diagnosticEvents(requests: { url: string; body: string }[]) {
  return requests
    .filter((request) => request.url.endsWith('/api/v1/device/diagnostic-events'))
    .map((request) => JSON.parse(request.body));
}

function deviceStatusReports(requests: { url: string; body: string }[]) {
  return requests
    .filter((request) => request.url.endsWith('/sync/device-status'))
    .map((request) => JSON.parse(request.body));
}

describe('mobile suspension', () => {
  it('pushes a small hinted change set when the app is backgrounded', async () => {
    const harness = await createHarness();
    await harness.start();
    harness.setPlan({ pending: true, within_budget: true, paths: 2, bytes: 1200 });
    harness.hide();
    await waitFor(() => harness.notify.pushes.length === 1);
    await settle();
    expect(harness.notify.pushes).toEqual(['pushed']);
    // Leaving never starts a scan or a remote apply.
    expect(harness.notify.attempts).toEqual([]);
    expect(harness.notify.fullInventories).toEqual([]);
    expect(harness.notify.triggers).toEqual(['visibility']);
    await harness.dispose();
  });

  it('defers a pending set that does not fit the leave budget', async () => {
    const harness = await createHarness();
    await harness.start();
    harness.setPlan({ pending: true, within_budget: false, paths: 40, bytes: 4 * 1024 * 1024 });
    harness.hide();
    await waitFor(() => harness.plugin.suspendedWithPendingWork === true);
    await settle();
    expect(harness.notify.pushes).toEqual([]);
    expect(harness.notify.attempts).toEqual([]);
    expect(harness.statusLabels().at(-1)).toBe('Paused');
    await harness.dispose();
  });

  it('reports Paused to the server while work is pending', async () => {
    const harness = await createHarness();
    await harness.start();
    // The wire body is what the dashboard reads, so observe it instead of the
    // reporter's own retry/dedupe schedule.
    const bodies: Json[] = [];
    harness.client.deviceStatusReporter = {
      closed: false,
      request: (snapshot: Json) => { bodies.push(JSON.parse(snapshot.body)); },
      heartbeatDue: () => false,
      flush: async () => undefined,
      close: () => undefined
    };
    harness.setPlan({ pending: true, within_budget: false, paths: 3, bytes: 900 });
    harness.hide();
    await waitFor(() => bodies.length > 0);
    expect(bodies.at(-1)).toMatchObject({ local_status_label: 'Paused', local_error_code: null });

    // A device that reports nothing pending keeps its honest converged label.
    const beforeResume = bodies.length;
    harness.setPlan({ pending: false, within_budget: false, paths: 0, bytes: 0 });
    harness.show();
    await settle();
    harness.hide();
    await waitFor(() => bodies.length > beforeResume);
    expect(bodies.slice(beforeResume).some((body) => body.local_status_label === 'Paused')).toBe(false);
    await harness.dispose();
  });

  it('resumes with one immediate coalesced attempt and no forced inventory', async () => {
    const harness = await createHarness();
    await harness.start();
    harness.setPlan({ pending: true, within_budget: false, paths: 1, bytes: 10 });
    harness.hide();
    await waitFor(() => harness.plugin.suspendedWithPendingWork === true);
    await settle();
    harness.setPlan({ pending: false, within_budget: false, paths: 0, bytes: 0 });
    // The platform returns the process: visibility, focus and a reconnected
    // network all arrive together and must cost exactly one attempt.
    harness.show();
    harness.fire('window', 'focus');
    harness.fire('window', 'online');
    await waitFor(() => harness.notify.attempts.length >= 1);
    await settle();
    expect(harness.notify.attempts).toEqual(['poll']);
    expect(harness.notify.triggers).toEqual(['visibility']);
    expect(harness.notify.inventorySchedules).toEqual(['scheduled']);
    expect(harness.notify.fullInventories).toEqual([]);
    await harness.dispose();
  });

  it('reports the apply stage a suspension interrupted', async () => {
    const harness = await createHarness();
    await harness.start();
    let release!: () => void;
    const frozen = new Promise<void>((resolve) => { release = resolve; });
    harness.client.pollRemoteEventsAndApply = async () => {
      harness.notify.attempts.push('poll');
      harness.plugin.setOperationProgress('Applying (writing files)', 'apply_write');
      await frozen;
      return { applied: true };
    };
    harness.plugin.runBackgroundSync('interval');
    await waitFor(() => harness.plugin.activeMeasuredPhase !== null);
    harness.hide();
    // An apply already in progress is resumable: leaving neither cancels it nor
    // starts another attempt.
    await waitFor(() => harness.plugin.suspendedPhase !== null);
    await settle();
    expect(harness.notify.pushes).toEqual([]);
    expect(harness.notify.attempts).toEqual(['poll']);
    release();
    await waitFor(() => harness.plugin.syncRunning === false);

    harness.show();
    await waitFor(() => diagnosticEvents(harness.notify.requests).length > 0);
    const [event] = diagnosticEvents(harness.notify.requests);
    expect(event).toMatchObject({
      schema_version: 3,
      phase: 'apply_write',
      observation: 'interrupted',
      failure_code: 'operation_stalled',
      stage: 'plugin_lifecycle',
      platform_family: 'android'
    });
    expect(event.phase_id).toMatch(/^dph_[0-9a-f]{32}$/u);
    await harness.dispose();
  });
});

describe('suspended client', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function coreOf(plugin: unknown): Json {
    return (plugin as unknown as { client: Json }).client;
  }

  async function prepare(fileCount = 6): Promise<SyncCostFixture> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fixture = await createSyncCostFixture(fileCount);
    cleanups.push(async () => await fixture.close());
    await advancePastStaleHorizons(fixture.reader);
    expect((await syncUntilSettled(fixture.reader)).at(-1)).toBe('Synced');
    return fixture;
  }

  async function remoteAdvance(fixture: SyncCostFixture): Promise<string> {
    const note = await writeNote(fixture.writerDir, 3, 'remote advance while the app was in the background\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    return note;
  }

  it('pushes hinted local changes and leaves the remote apply for resume', async () => {
    const fixture = await prepare();
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    // A resumed device owes an inventory. Once it has run, hinted capture is the
    // cheap path the leave budget is measured against.
    await tickUntilSettled(resumed);
    const before = await coreOf(resumed).readState();
    const remote = await remoteAdvance(fixture);
    const core = coreOf(resumed);
    const inventories: unknown[] = [];
    const originalInventory = core.listLocalVaultInventory.bind(core);
    core.listLocalVaultInventory = async (...args: unknown[]) => {
      inventories.push(args);
      return await originalInventory(...args);
    };
    const localNote = await writeNote(fixture.readerDir, 2, 'typed just before the app was backgrounded\n');
    await resumed.recordLocalChangeHint([localNote]);
    core.beginSuspension();

    const plan = await core.backgroundSuspensionPlan();
    expect(plan).toMatchObject({ pending: true, within_budget: true, paths: 1 });
    expect(await core.pushHintedChangesBeforeSuspend()).toMatchObject({ deferred: true });

    // The push reached the server: the writer now has the note the phone typed.
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    expect(await readFile(join(fixture.writerDir, localNote), 'utf8')).toBe('typed just before the app was backgrounded\n');
    // Nothing scanned the vault and the writer's advance is still owed.
    expect(inventories).toEqual([]);
    expect((await core.readQueue()).pending_commit).toBe(null);
    expect((await core.readState()).local_main).toBe(before.local_main);

    core.endSuspension();
    expect((await syncUntilSettled(resumed)).at(-1)).toBe('Synced');
    expect(await readFile(join(fixture.readerDir, remote), 'utf8')).toBe('remote advance while the app was in the background\n');
    expect(await readFile(join(fixture.readerDir, localNote), 'utf8')).toBe('typed just before the app was backgrounded\n');
  });

  it('never starts a remote apply while suspended', async () => {
    const fixture = await prepare();
    const note = await remoteAdvance(fixture);
    await advancePastStaleHorizons(fixture.writer);
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);
    const before = await core.readState();
    core.beginSuspension();

    const result = await core.pushHintedChangesBeforeSuspend();

    // No pack was integrated and no apply journal was left behind: the deferral
    // is a clean stop before the stage a freeze would cut through.
    expect(result.deferred).toBe(true);
    const suspendedState = await core.readState();
    expect(suspendedState.local_main).toBe(before.local_main);
    expect(suspendedState.status_label).not.toBe('Synced');
    await expect(readFile(join(fixture.readerDir, '.obts', 'apply-journal.json'), 'utf8')).rejects.toThrow();
    core.endSuspension();
    expect((await syncUntilSettled(resumed)).at(-1)).toBe('Synced');
    expect(await readFile(join(fixture.readerDir, note), 'utf8')).toBe('remote advance while the app was in the background\n');
  });

  it('keeps the ordinary hinted capture when the leave budget is exceeded', async () => {
    const fixture = await prepare();
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);
    const hints: string[] = [];
    for (let index = 0; index < 9; index += 1) hints.push(await ensureNote(fixture.readerDir, 100 + index, `queued edit ${index}\n`));
    await resumed.recordLocalChangeHint(hints);
    core.beginSuspension();

    const plan = await core.backgroundSuspensionPlan();
    expect(plan.pending).toBe(true);
    expect(plan.within_budget).toBe(false);
    core.endSuspension();
    // The resume path still captures and uploads every hinted path.
    const statuses = await tickUntilSettled(resumed);
    expect(statuses.at(-1)).toBe('incremental:Synced');
    expect((await core.readState()).status_label).toBe('Synced');
    expect((await core.readQueue()).pending_commit).toBe(null);
  });
});
