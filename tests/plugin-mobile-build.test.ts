import { Buffer } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';

import { PLUGIN_VERSION } from '../obsidian-plugin/src/version.js';
import { MemoryDataAdapter } from './helpers/memoryDataAdapter.js';

const require = createRequire(import.meta.url);
const { createDataAdapterFs } = require('../obsidian-plugin/src/data-adapter-fs.cjs') as {
  createDataAdapterFs: (adapter: MemoryDataAdapter) => any;
};

describe('mobile plugin artifact', () => {
  it('is advertised for mobile and contains no unresolved desktop runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile('obsidian-plugin/manifest.json', 'utf8')) as { isDesktopOnly: boolean };
    const artifact = await readFile('obsidian-plugin/main.js', 'utf8');
    const source = await readFile('obsidian-plugin/src/main.js', 'utf8');
    const styles = await readFile('obsidian-plugin/styles.css', 'utf8');

    expect(manifest.isDesktopOnly).toBe(false);
    expect(artifact).not.toMatch(/require\(["'](?:node:|fs["']|path["']|crypto["']|child_process["']|os["'])/u);
    expect(artifact).not.toContain('requireDesktopVaultPath');
    expect(artifact).not.toContain('Git binary');
    expect(styles).toContain('.obts-status--success');
    expect(styles).toContain('.obts-status--active');
    expect(styles).toContain('.obts-status--warning');
    expect(styles).toContain('.obts-status--danger');
    expect(styles).toContain('.obts-ribbon-status');
    expect(styles).toContain('prefers-reduced-motion');

    const unresolvedRequires = [...artifact.matchAll(/require\(["']([^"']+)["']\)/gu)].map((match) => match[1]);
    expect([...new Set(unresolvedRequires)]).toEqual(['obsidian']);

    const browserHandoff = source.slice(source.indexOf('setButtonText("Continue in browser")'), source.indexOf('renderWaiting() {'));
    expect(browserHandoff).toContain('await this.waitForBrowserReturn()');
    expect(browserHandoff).toContain('this.showWaitingError(error, "Unable to start setup.")');
    expect(browserHandoff).not.toContain('setFeedback(feedback, error instanceof Error');
  });

  it('loads with only the Obsidian API external and browser globals', async () => {
    const artifact = await readFile('obsidian-plugin/main.js', 'utf8');
    const module = { exports: {} as unknown };
    const savedSettings: unknown[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const notices: string[] = [];
    const openedUrls: string[] = [];
    const openedSettingTabs: string[] = [];
    type MockStatusItem = {
      text: string;
      classes: Set<string>;
      attributes: Record<string, string>;
      listeners: Record<string, Array<(event: any) => void>>;
      setText: (value: string) => void;
      classList: { add: (value: string) => void; remove: (value: string) => void };
      setAttribute: (name: string, value: string) => void;
      addEventListener: (name: string, listener: (event: any) => void) => void;
    };
    const createStatusItem = (): MockStatusItem => {
      const classes = new Set<string>();
      const attributes: Record<string, string> = {};
      const listeners: Record<string, Array<(event: any) => void>> = {};
      const item: MockStatusItem = {
        text: '',
        classes,
        attributes,
        listeners,
        setText(value: string) { item.text = value; },
        classList: {
          add(value: string) { classes.add(value); },
          remove(value: string) { classes.delete(value); }
        },
        setAttribute(name: string, value: string) { attributes[name] = value; },
        addEventListener(name: string, listener: (event: any) => void) {
          (listeners[name] ||= []).push(listener);
        }
      };
      return item;
    };
    const statusItems: MockStatusItem[] = [];
    const ribbonItems: MockStatusItem[] = [];
    const ribbonActions: Array<() => void> = [];
    const layoutReadyCallbacks: Array<() => void> = [];
    const settingTabs: any[] = [];
    const renderedSettingNames: string[] = [];
    const renderedElementTexts: string[] = [];
    const createContainer = (): any => ({
      empty() {
        renderedSettingNames.length = 0;
        renderedElementTexts.length = 0;
      },
      createEl(_tag: string, options: { text?: string } = {}) {
        if (options.text) renderedElementTexts.push(options.text);
        return createContainer();
      },
      createDiv() { return createContainer(); }
    });
    const createControl = (): any => {
      const control: any = {
        inputEl: {},
        setValue() { return control; },
        onChange() { return control; },
        setButtonText() { return control; },
        setCta() { return control; },
        setDisabled() { return control; },
        onClick() { return control; },
        setWarning() { return control; }
      };
      return control;
    };
    class PluginSettingTab {
      app: any;
      plugin: any;
      containerEl = createContainer();
      constructor(app: any, plugin: any) {
        this.app = app;
        this.plugin = plugin;
      }
    }
    class Setting {
      constructor(_container: any) {}
      setName(value: string) { renderedSettingNames.push(value); return this; }
      setDesc(_value: string) { return this; }
      addText(callback: (control: any) => void) { callback(createControl()); return this; }
      addToggle(callback: (control: any) => void) { callback(createControl()); return this; }
      addButton(callback: (control: any) => void) { callback(createControl()); return this; }
    }
    class Plugin {
      app: any;
      manifest = { id: 'obts' };
      async loadData() { return {}; }
      async saveData(value: unknown) { savedSettings.push(value); }
      addStatusBarItem() {
        const item = createStatusItem();
        statusItems.push(item);
        return item;
      }
      addRibbonIcon(_icon: string, _title: string, action: () => void) {
        const item = createStatusItem();
        ribbonItems.push(item);
        ribbonActions.push(action);
        return item;
      }
      addSettingTab(tab: any) { settingTabs.push(tab); }
      addCommand() {}
      registerEvent() {}
      registerInterval(id: ReturnType<typeof setInterval>) { clearInterval(id); }
      registerDomEvent(target: any, name: string, listener: (event: any) => void) {
        target.addEventListener?.(name, listener);
      }
    }
    const obsidian = {
      Plugin,
      PluginSettingTab,
      Setting,
      Notice: class {
        constructor(message: string) { notices.push(message); }
      },
      Modal: class {},
      Platform: {
        isMobile: true,
        isIosApp: true,
        isAndroidApp: false,
        isMacOS: false,
        isWin: false
      },
      apiVersion: '1.9.12',
      requestUrl: async (options: Record<string, unknown>) => {
        requests.push(options);
        return { status: 202, headers: {}, json: { status: 'accepted' }, text: '{"status":"accepted"}', arrayBuffer: new ArrayBuffer(0) };
      }
    };
    const context = vm.createContext({
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name !== 'obsidian') throw new Error(`Unexpected runtime require: ${name}`);
        return obsidian;
      },
      globalThis: null,
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      Blob,
      Response,
      Request,
      Headers,
      URL,
      ArrayBuffer,
      Uint8Array,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      open: (url: string) => openedUrls.push(url),
      document: { hidden: false },
      console
    });
    Object.assign(context, { globalThis: context, window: context });

    new vm.Script(artifact, { filename: 'obsidian-plugin/main.js' }).runInContext(context);
    expect(typeof module.exports).toBe('function');
    expect(typeof (context as any).Buffer).toBe('function');

    const adapter = new MemoryDataAdapter();
    await adapter.mkdir('.obts');
    await adapter.mkdir('.obts/git');
    await adapter.mkdir('.obts/git/objects');
    await adapter.mkdir('.obts/git/objects/pack');
    await adapter.writeBinary('.obts/git/objects/pack/startup.pack', Uint8Array.from(Buffer.alloc(64 * 1024, 1)).buffer);
    await adapter.mkdir('.obts/recovery');
    await adapter.mkdir('.obts/recovery/rec_startup');
    await adapter.mkdir('.obts/recovery/rec_startup/files');
    await adapter.mkdir('.obts/recovery/rec_startup/files/deep');
    await adapter.mkdir('.obts/recovery/rec_startup/journal');
    await adapter.writeBinary('.obts/recovery/rec_startup/files/deep/note.md', new TextEncoder().encode('preserved recovery data').buffer);
    await adapter.writeBinary('.obts/recovery/rec_startup/manifest.json.tmp-dead-1', new TextEncoder().encode('{"valid":true}').buffer);
    await adapter.writeBinary(
      '.obts/recovery/rec_startup/journal/apply-journal.json.obts-replace-backup-crash-one',
      new TextEncoder().encode('{"phase":"planned"}').buffer
    );
    let startupPackReads = 0;
    let failRecoveryListing = false;
    const listedStartupPaths: string[] = [];
    const adapterList = adapter.list.bind(adapter);
    adapter.list = async (filePath: string) => {
      listedStartupPaths.push(filePath);
      if (failRecoveryListing && filePath === '.obts/recovery') throw new Error('transient recovery listing failure');
      return await adapterList(filePath);
    };
    const adapterReadBinary = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (filePath: string) => {
      if (filePath.endsWith('.pack')) startupPackReads += 1;
      return await adapterReadBinary(filePath);
    };

    const PluginClass = module.exports as new () => Plugin;
    const plugin = new PluginClass();
    plugin.app = {
      vault: {
        adapter,
        getName: () => 'Mobile Test Vault',
        on: () => ({})
      },
      workspace: {
        getLeavesOfType: () => [],
        onLayoutReady: (callback: () => void) => layoutReadyCallbacks.push(callback)
      },
      setting: {
        open: () => undefined,
        openTabById: (id: string) => openedSettingTabs.push(id)
      }
    };
    await (plugin as any).onload();
    expect(layoutReadyCallbacks).toHaveLength(1);
    expect(startupPackReads).toBe(0);
    expect(await adapter.exists('.obts/state.json')).toBe(false);
    await (plugin as any).runBackgroundSync();
    expect(startupPackReads).toBe(0);
    expect(await adapter.exists('.obts/state.json')).toBe(false);

    const statusItem = statusItems[0]!;
    const ribbonItem = ribbonItems[0]!;
    (plugin as any).setStatus('Offline');
    const degradedTimer = (plugin as any).degradedStatusTimer;
    (plugin as any).setStatus('Checking');
    expect((plugin as any).degradedStatusTimer).toBe(degradedTimer);
    (plugin as any).setStatus('Offline');
    expect((plugin as any).degradedStatusTimer).toBe(degradedTimer);
    (plugin as any).setStatus('Uploading 0/1');
    expect((plugin as any).degradedStatusTimer).toBeNull();
    (plugin as any).setStatus('Synced');
    expect((plugin as any).degradedStatusTimer).toBeNull();
    (plugin as any).degradedStatusNotifiedBase = 'Offline';
    (plugin as any).setStatus('Offline');
    expect((plugin as any).degradedStatusTimer).toBeNull();
    (plugin as any).setStatus('Synced');
    const silentNoticeCount = notices.length;
    (plugin as any).setStatus('Unsafe local state', { notify: false });
    expect(statusItem.classes).toContain('obts-status--danger');
    expect(notices).toHaveLength(silentNoticeCount);
    (plugin as any).setStatus('Not paired');

    const initialNoticeCount = notices.length;
    (plugin as any).setStatus('Checking 3/5');
    expect(statusItem.text).toBe('obts: Checking 3/5');
    expect(statusItem.attributes['data-obts-status']).toBe('checking');
    (plugin as any).setStatus('Uploading 2/4');
    expect(statusItem.text).toBe('obts: Uploading 2/4');
    expect(statusItem.classes).toContain('obts-status');
    expect(statusItem.classes).toContain('obts-status--active');
    expect(statusItem.attributes['data-obts-status']).toBe('uploading');
    expect(ribbonItem.classes).toContain('obts-ribbon-status');
    expect(ribbonItem.classes).toContain('obts-status--active');
    expect(ribbonItem.attributes['data-obts-status']).toBe('uploading');
    (plugin as any).setStatus('Review needed');
    expect(statusItem.classes).toContain('obts-status--warning');
    expect(statusItem.attributes.title).toContain('conflict dashboard');
    expect(notices).toHaveLength(initialNoticeCount + 1);
    (plugin as any).setStatus('Review needed');
    expect(notices).toHaveLength(initialNoticeCount + 1);
    ribbonActions[0]!();
    expect(openedUrls).toEqual(['http://127.0.0.1:3000/dashboard']);
    (plugin as any).setStatus('Synced');
    expect(statusItem.classes).toContain('obts-status--success');
    expect(ribbonItem.classes).toContain('obts-status--success');
    expect(notices.at(-1)).toBe('obts: Sync is healthy again.');
    let prevented = false;
    statusItem.listeners.keydown![0]!({ key: 'Enter', preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(openedSettingTabs).toEqual(['obts']);

    layoutReadyCallbacks.shift()!();
    await settingTabs[0]!.display();
    expect(renderedElementTexts).toContain('Loading obts');
    expect(renderedSettingNames).toContain('Checking local obts state');
    expect(renderedSettingNames).not.toContain('Waiting for the previous operation');
    expect(await (plugin as any).ensureClientReady()).toBe(true);
    expect(startupPackReads).toBe(0);
    expect(listedStartupPaths).not.toContain('.obts/git/objects');
    expect(listedStartupPaths).not.toContain('.obts/git/objects/pack');
    expect(listedStartupPaths).not.toContain('.obts/recovery/rec_startup/files');
    expect(await adapter.exists('.obts/recovery/rec_startup/manifest.json.tmp-dead-1')).toBe(false);
    expect(await adapter.exists('.obts/recovery/rec_startup/journal/apply-journal.json')).toBe(true);
    expect(await adapter.exists('.obts/recovery/rec_startup/files/deep/note.md')).toBe(true);
    failRecoveryListing = true;
    await expect((plugin as any).client.recoverInterruptedReplacements()).rejects.toThrow('ENOENT');
    failRecoveryListing = false;
    await adapter.remove('.obts/git/objects/pack/startup.pack');
    expect(await adapter.exists('.obts/git/HEAD')).toBe(true);
    expect(await adapter.exists('.obts/state.json')).toBe(true);
    expect(await adapter.exists('.obts/queue.json')).toBe(true);

    const sourceAdapter = new MemoryDataAdapter();
    const sourceFs = createDataAdapterFs(sourceAdapter);
    const sourceArgs = { fs: sourceFs, dir: '/', gitdir: '/.obts/git' };
    await git.init({ ...sourceArgs, defaultBranch: 'local' });
    const blob = await git.writeBlob({ ...sourceArgs, blob: Buffer.from('mobile bundle pack\n') });
    const tree = await git.writeTree({
      ...sourceArgs,
      tree: [{ mode: '100644', path: 'note.md', oid: blob, type: 'blob' }]
    });
    const commit = await git.commit({
      ...sourceArgs,
      ref: 'refs/heads/local',
      tree,
      message: 'mobile bundle pack',
      author: { name: 'obts test', email: 'test@obts.local' },
      committer: { name: 'obts test', email: 'test@obts.local' }
    });
    const packed = await git.packObjects({ ...sourceArgs, oids: [blob, tree, commit] });
    await expect((plugin as any).client.importPack(packed.packfile)).resolves.toBeUndefined();
    expect((await adapter.list('.obts/git/objects/pack')).files.some((file) => file.endsWith('.idx'))).toBe(true);
    const packFilesBeforeEmptyImport = (await adapter.list('.obts/git/objects/pack')).files;
    const emptyPackHeader = Buffer.alloc(12);
    emptyPackHeader.write('PACK', 0, 'ascii');
    emptyPackHeader.writeUInt32BE(2, 4);
    emptyPackHeader.writeUInt32BE(0, 8);
    const emptyPack = Buffer.concat([emptyPackHeader, createHash('sha1').update(emptyPackHeader).digest()]);
    await expect((plugin as any).client.importPack(emptyPack)).resolves.toBeUndefined();
    expect((await adapter.list('.obts/git/objects/pack')).files).toEqual(packFilesBeforeEmptyImport);

    const runtimeAdapter = new MemoryDataAdapter();
    const runtimeLayoutReadyCallbacks: Array<() => void> = [];
    const runtimePlugin = new PluginClass();
    runtimePlugin.app = {
      vault: {
        adapter: runtimeAdapter,
        getName: () => 'Runtime Test Vault',
        on: () => ({}),
        getAbstractFileByPath: () => null
      },
      workspace: {
        getLeavesOfType: () => [],
        onLayoutReady: (callback: () => void) => runtimeLayoutReadyCallbacks.push(callback)
      },
      setting: { open: () => undefined, openTabById: () => undefined }
    };
    await (runtimePlugin as any).onload();
    runtimeLayoutReadyCallbacks.shift()!();
    expect(await (runtimePlugin as any).ensureClientReady()).toBe(true);
    const runtimeClient = (runtimePlugin as any).client;
    const encode = (value: string) => new TextEncoder().encode(value).buffer;
    await runtimeAdapter.writeBinary('note.md', encode('runtime baseline\n'));
    const runtimeMain = await runtimeClient.createLocalCommit('runtime baseline');
    expect(runtimeMain).toMatch(/^[0-9a-f]{40}$/u);
    await runtimeClient.updateRef('refs/heads/main', runtimeMain, null, true);
    await runtimeAdapter.writeBinary('.obts/auth/device-token.json', encode('{"device_token":"test-token"}\n'));
    await runtimeAdapter.mkdir('mainvault');
    await runtimeClient.writeState({
      user_id: 'usr_test',
      vault_id: 'vlt_test',
      device_id: 'dev_test',
      device_name: 'runtime-device',
      device_ref: 'refs/obts/devices/dev_test',
      server_device_ref: runtimeMain,
      local_main: runtimeMain,
      local_head: runtimeMain,
      initial_import_confirmed: true,
      status_label: 'Synced',
      last_error_code: null,
      last_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      updated_at: new Date().toISOString()
    });
    await runtimeClient.writeQueue({
      pending_commit: null,
      expected_device_ref: runtimeMain,
      status: 'idle',
      attempts: 0,
      updated_at: new Date().toISOString()
    });
    await runtimeClient.refreshDirectoryStateFromDisk([]);

    let applyLockAttempts = 0;
    const acquireApplyLock = runtimeClient.acquireApplyLock.bind(runtimeClient);
    runtimeClient.acquireApplyLock = async (...args: unknown[]) => {
      applyLockAttempts += 1;
      return await acquireApplyLock(...args);
    };
    await runtimeClient.applyTargetMain(runtimeMain, [], true, [], true, [], ['mainvault'], 0);
    expect(applyLockAttempts).toBe(0);
    runtimeClient.acquireApplyLock = acquireApplyLock;
    await runtimeClient.applyTargetMain(runtimeMain, [], true, [], true, [], ['mainvault', 'missing-empty'], 0);
    expect(await runtimeAdapter.exists('missing-empty')).toBe(true);

    runtimeClient.pollEvents = async () => ({ current_event_seq: 0, events: [] });
    runtimeClient.reportDeviceStatus = async () => undefined;
    await runtimeClient.recordLocalChangeHint(['note.md']);
    expect(await runtimeClient.readState()).toMatchObject({ status_label: 'Checking' });
    expect(await runtimeClient.readQueue()).toMatchObject({ pending_commit: null, status: 'queued_local' });
    expect(await runtimeClient.syncOnce({ confirmInitialImport: false })).toMatchObject({ status: 'Synced', main: runtimeMain });
    expect(await runtimeClient.readQueue()).toMatchObject({ pending_commit: null, status: 'idle' });

    await runtimeClient.recordLocalChangeHint(['note.md']);
    const beforeRaceChangeSeq = (await runtimeClient.readQueue()).change_seq;
    const createLocalCommit = runtimeClient.createLocalCommit.bind(runtimeClient);
    runtimeClient.createLocalCommit = async (...args: unknown[]) => {
      const result = await createLocalCommit(...args);
      await runtimeClient.recordLocalChangeHint(['note.md']);
      return result;
    };
    await runtimeClient.syncOnce({ confirmInitialImport: false });
    expect(await runtimeClient.readQueue()).toMatchObject({
      pending_commit: null,
      status: 'queued_local',
      change_seq: beforeRaceChangeSeq + 1
    });
    runtimeClient.createLocalCommit = createLocalCommit;
    await runtimeClient.syncOnce({ confirmInitialImport: false });
    expect(await runtimeClient.readQueue()).toMatchObject({ pending_commit: null, status: 'idle' });

    let lightweightPolls = 0;
    let fullScans = 0;
    runtimeClient.pollRemoteEventsAndApply = async () => {
      lightweightPolls += 1;
      return { applied: false, status: 'Synced' };
    };
    runtimeClient.syncOnce = async () => {
      fullScans += 1;
      (runtimePlugin as any).markFullScanCompleted();
      throw new Error('network unavailable after scan');
    };
    (runtimePlugin as any).lastFullScanCompletedAt = Date.now();
    for (let index = 0; index < 10; index += 1) await (runtimePlugin as any).runBackgroundSync();
    expect(lightweightPolls).toBe(10);
    expect(fullScans).toBe(0);
    (runtimePlugin as any).lastFullScanCompletedAt = null;
    await (runtimePlugin as any).runBackgroundSync();
    expect(fullScans).toBe(1);
    expect((runtimePlugin as any).lastFullScanCompletedAt).toEqual(expect.any(Number));
    await (runtimePlugin as any).runBackgroundSync();
    expect(fullScans).toBe(1);
    expect(lightweightPolls).toBe(11);

    (plugin as any).client = new runtimeClient.constructor(plugin);
    await (plugin as any).client.initialize();

    const diagnosticError = vm.runInContext(
      "new TypeError(\"null is not an object (evaluating 'pack.slice') private-note.md obts_dev_secret\")",
      context
    ) as Error;
    await (plugin as any).reportOnboardingError(diagnosticError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    expect(requests).toHaveLength(0);
    await (plugin as any).setDiagnosticSharing(true);
    await (plugin as any).reportOnboardingError(diagnosticError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    await (plugin as any).reportOnboardingError(diagnosticError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:3000/api/v1/connections/con_safe/diagnostic-events');
    const diagnosticBody = JSON.parse(String(requests[0]?.body)) as Record<string, unknown>;
    expect(diagnosticBody).toMatchObject({
      schema_version: 1,
      plugin_version: PLUGIN_VERSION,
      obsidian_version: '1.9.12',
      platform_family: 'ios',
      failure_code: 'null_pack_slice',
      error_class: 'type_error'
    });
    expect(JSON.stringify(diagnosticBody)).not.toContain('private-note.md');
    expect(JSON.stringify(diagnosticBody)).not.toContain('obts_dev_secret');
    expect(JSON.stringify(diagnosticBody)).not.toContain('obts_conn_private');

    const missingBufferError = vm.runInContext("new Error('Missing Buffer dependency')", context) as Error;
    await (plugin as any).reportOnboardingError(missingBufferError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    expect(requests).toHaveLength(2);
    const missingBufferBody = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>;
    expect(missingBufferBody.failure_code).toBe('missing_buffer_dependency');
    expect(JSON.stringify(missingBufferBody)).not.toContain('Missing Buffer dependency');

    const invalidJsonError = vm.runInContext(
      "Object.assign(new Error('Expected valid JSON private-note.md'), { code: 'invalid_json' })",
      context
    ) as Error;
    await (plugin as any).reportOnboardingError(invalidJsonError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    expect(requests).toHaveLength(3);
    const invalidJsonBody = JSON.parse(String(requests[2]?.body)) as Record<string, unknown>;
    expect(invalidJsonBody.failure_code).toBe('invalid_json');
    expect(JSON.stringify(invalidJsonBody)).not.toContain('Expected valid JSON');
    expect(JSON.stringify(invalidJsonBody)).not.toContain('private-note.md');

    const lifecycleError = vm.runInContext(
      "Object.assign(new Error('private lifecycle detail'), { code: 'operation_interrupted_by_reload' })",
      context
    ) as Error;
    await (plugin as any).reportOnboardingError(lifecycleError, {
      connection_id: 'con_safe',
      connection_secret: 'obts_conn_private'
    });
    expect(requests).toHaveLength(4);
    const lifecycleBody = JSON.parse(String(requests[3]?.body)) as Record<string, unknown>;
    expect(lifecycleBody).toMatchObject({
      flow: 'plugin',
      stage: 'plugin_lifecycle',
      failure_code: 'operation_interrupted_by_reload'
    });
    expect(JSON.stringify(lifecycleBody)).not.toContain('private lifecycle detail');

    const originalReadState = (plugin as any).client.readState.bind((plugin as any).client);
    const currentState = await originalReadState();
    let resolveState!: (value: unknown) => void;
    (plugin as any).client.readState = () => new Promise((resolve) => { resolveState = resolve; });
    const racedReport = (plugin as any).reportOnboardingError(
      vm.runInContext("new Error('another private-note.md failure')", context),
      { connection_id: 'con_safe', connection_secret: 'obts_conn_private' }
    );
    await Promise.resolve();
    await (plugin as any).updateServerUrl('https://replacement.example');
    resolveState(currentState);
    await racedReport;
    (plugin as any).client.readState = originalReadState;
    expect(requests).toHaveLength(4);
    expect((plugin as any).diagnosticSharingEnabled()).toBe(false);
    expect(savedSettings.length).toBeGreaterThan(0);

    const replacement = new PluginClass();
    replacement.app = plugin.app;
    expect((plugin as any).beginSync()).toBe(true);
    (plugin as any).syncRunningSince = Date.now() - 60 * 60 * 1000;
    expect((plugin as any).isSyncInProgress()).toBe(true);
    await (replacement as any).onload();
    expect((replacement as any).clientReady).toBe(false);
    expect((replacement as any).beginSync()).toBe(false);
    await expect((replacement as any).runOnboardingAction(async () => undefined)).rejects.toMatchObject({
      code: 'sync_lease_blocked'
    });
    (plugin as any).onunload();
    expect((plugin as any).beginSync()).toBe(false);
    expect((replacement as any).beginSync()).toBe(false);
    expect((replacement as any).operationAvailability()).toBe('restart_required');
    expect((replacement as any).syncBlockedMessage()).toContain('Fully restart Obsidian');
    await expect((replacement as any).runOnboardingAction(async () => undefined)).rejects.toMatchObject({
      code: 'operation_interrupted_by_reload'
    });
    (plugin as any).endSync();
    await expect((replacement as any).ensureClientReady()).resolves.toBe(true);
    expect((replacement as any).clientReady).toBe(true);
    expect((replacement as any).beginSync()).toBe(true);
    (replacement as any).endSync();

    const reloadAdapter = new MemoryDataAdapter();
    const writeBinary = reloadAdapter.writeBinary.bind(reloadAdapter);
    let releaseInitialization!: () => void;
    let initializationWriteStarted!: () => void;
    let firstWriteWaiting = false;
    let released = false;
    let overlappingWrites = 0;
    const initializationStarted = new Promise<void>((resolve) => { initializationWriteStarted = resolve; });
    const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    reloadAdapter.writeBinary = async (filePath: string, data: ArrayBuffer) => {
      if (!firstWriteWaiting) {
        firstWriteWaiting = true;
        initializationWriteStarted();
        await initializationGate;
      } else if (!released) {
        overlappingWrites += 1;
      }
      await writeBinary(filePath, data);
    };
    const reloadApp = {
      vault: {
        adapter: reloadAdapter,
        getName: () => 'Reload Test Vault',
        on: () => ({})
      },
      workspace: { getLeavesOfType: () => [] }
    };
    const retiring = new PluginClass();
    retiring.app = reloadApp;
    const retiringLoad = (retiring as any).onload();
    await initializationStarted;
    const successor = new PluginClass();
    successor.app = reloadApp;
    await (successor as any).onload();
    expect((successor as any).clientReady).toBe(false);
    expect(overlappingWrites).toBe(0);
    const retiringInitialization = (retiring as any).clientInitialization;
    (retiring as any).onunload();
    released = true;
    releaseInitialization();
    await retiringLoad;
    await retiringInitialization;
    await expect((successor as any).ensureClientReady()).resolves.toBe(true);
    expect((successor as any).clientReady).toBe(true);
    expect(overlappingWrites).toBe(0);
    (successor as any).onunload();
  });
});
