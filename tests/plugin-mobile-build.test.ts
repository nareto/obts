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
    const source = await readFile('obsidian-plugin/src/main.cjs', 'utf8');
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
    expect(source).not.toContain('runExclusiveAction(() => this.plugin.setDiagnosticSharing');
    expect(source).toContain('await this.plugin.setDiagnosticSharing(value)');
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
    const renderedSettingDescriptions: string[] = [];
    const renderedElementTexts: string[] = [];
    const createContainer = (): any => ({
      empty() {
        renderedSettingNames.length = 0;
        renderedSettingDescriptions.length = 0;
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
      setDesc(value: string) { renderedSettingDescriptions.push(value); return this; }
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
        if (typeof options.url === 'string' && options.url.endsWith('/sync/applied')) {
          const body = JSON.parse(String(options.body || '{}')) as { applied_main?: string };
          const json = { status: 'ok', applied_main: body.applied_main, applied_event_seq: 1_000_000 };
          return { status: 200, headers: {}, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0) };
        }
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
    expect(renderedSettingNames.some((value) => ['Starting local state checks', 'Recovering metadata replacements'].includes(value))).toBe(true);
    expect(renderedSettingDescriptions.some((value) => value.includes('checkpoint has been running for'))).toBe(true);
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

    const stateClient = (plugin as any).client;
    const primaryState = {
      vault_id: 'vlt_state',
      device_id: 'dev_state',
      local_main: '1'.repeat(40),
      local_head: '2'.repeat(40),
      server_device_ref: '3'.repeat(40)
    };
    const backupState = {
      ...primaryState,
      local_main: '4'.repeat(40),
      local_head: '5'.repeat(40),
      server_device_ref: '6'.repeat(40)
    };
    const readBackupState = stateClient.readBackupState.bind(stateClient);
    const readQueue = stateClient.readQueue.bind(stateClient);
    const resolveRefPointer = stateClient.resolveRefPointer.bind(stateClient);
    const restoreRecoveredBackupState = stateClient.restoreRecoveredBackupState.bind(stateClient);
    const backupStateCursorsDescend = stateClient.backupStateCursorsDescend.bind(stateClient);
    let ancestryChecks = 0;
    let restoredBackups = 0;
    stateClient.readBackupState = async () => backupState;
    stateClient.resolveRefPointer = async (ref: string) => ref.endsWith('/main') ? primaryState.local_main : primaryState.local_head;
    stateClient.restoreRecoveredBackupState = async (_primary: unknown, backup: unknown) => { restoredBackups += 1; return backup; };
    stateClient.backupStateCursorsDescend = async () => { ancestryChecks += 1; return false; };
    expect(await stateClient.preferRecoverableBackupState(primaryState)).toBe(primaryState);
    stateClient.resolveRefPointer = async (ref: string) => ref.endsWith('/main') ? backupState.local_main : backupState.local_head;
    expect(await stateClient.preferRecoverableBackupState(primaryState)).toBe(backupState);

    const serverOnlyBackup = { ...primaryState, server_device_ref: '7'.repeat(40) };
    stateClient.readBackupState = async () => serverOnlyBackup;
    stateClient.resolveRefPointer = async (ref: string) => ref.endsWith('/main') ? primaryState.local_main : primaryState.local_head;
    stateClient.readQueue = async () => ({ expected_device_ref: primaryState.server_device_ref });
    expect(await stateClient.preferRecoverableBackupState(primaryState)).toBe(primaryState);
    stateClient.readQueue = async () => ({ expected_device_ref: serverOnlyBackup.server_device_ref });
    expect(await stateClient.preferRecoverableBackupState(primaryState)).toBe(serverOnlyBackup);
    expect(ancestryChecks).toBe(0);
    expect(restoredBackups).toBe(2);
    stateClient.readBackupState = readBackupState;
    stateClient.readQueue = readQueue;
    stateClient.resolveRefPointer = resolveRefPointer;
    stateClient.restoreRecoveredBackupState = restoreRecoveredBackupState;
    stateClient.backupStateCursorsDescend = backupStateCursorsDescend;

    const originalPrimaryState = await stateClient.readPrimaryState();
    const mixedPrimary = {
      ...primaryState,
      device_name: 'new name',
      initial_import_confirmed: true,
      last_event_seq: 9,
      status_label: 'Synced',
      last_error_code: null
    };
    const mixedBackup = {
      ...backupState,
      device_name: 'old name',
      server_device_ref: '8'.repeat(40),
      initial_import_confirmed: false,
      last_event_seq: 4,
      status_label: 'Ahead',
      last_error_code: 'upload_interrupted'
    };
    const mergedRecovery = await stateClient.restoreRecoveredBackupState(
      mixedPrimary,
      mixedBackup,
      mixedPrimary.server_device_ref
    );
    expect(mergedRecovery).toMatchObject({
      local_main: mixedBackup.local_main,
      local_head: mixedBackup.local_head,
      server_device_ref: mixedPrimary.server_device_ref,
      device_name: mixedPrimary.device_name,
      initial_import_confirmed: true,
      last_event_seq: 9,
      status_label: mixedPrimary.status_label,
      last_error_code: mixedPrimary.last_error_code
    });
    const nullServerPrimary = {
      ...mixedPrimary,
      server_device_ref: null,
      status_label: 'Needs recovery',
      last_error_code: 'replace_local_with_server_required'
    };
    const nullServerRecovery = await stateClient.restoreRecoveredBackupState(
      nullServerPrimary,
      mixedBackup,
      null
    );
    expect(nullServerRecovery).toMatchObject({
      server_device_ref: null,
      status_label: nullServerPrimary.status_label,
      last_error_code: nullServerPrimary.last_error_code
    });
    await stateClient.writeState(originalPrimaryState);

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
    await adapter.writeBinary('note.md', new TextEncoder().encode('mobile bundle pack\n').buffer);
    const packedTargetEntries = await (plugin as any).client.listTreeBlobOids(commit);
    const packedClientReadBlob = (plugin as any).client.readBlob.bind((plugin as any).client);
    let packedTargetBlobReads = 0;
    (plugin as any).client.readBlob = async (...args: unknown[]) => {
      packedTargetBlobReads += 1;
      return await packedClientReadBlob(...args);
    };
    const packedValidation = await (plugin as any).client.applyJournalMatchesCurrentFiles({
      phase: 'verifying',
      affected_paths: ['note.md'],
      preflight_sha256: { 'note.md': createHash('sha256').update('before apply\n').digest('hex') }
    }, packedTargetEntries);
    expect(packedValidation.matches).toBe(true);
    expect([...packedValidation.targetMatchedPaths]).toEqual(['note.md']);
    expect(await (plugin as any).client.localChangedPathsFromTree(packedTargetEntries)).toEqual([]);
    await (plugin as any).client.writeTargetFilesFromJournal({
      target_main: commit,
      affected_paths: ['note.md'],
      preflight_sha256: { 'note.md': createHash('sha256').update('before apply\n').digest('hex') }
    }, packedTargetEntries, packedValidation.targetMatchedPaths);
    expect(packedTargetBlobReads).toBe(0);
    (plugin as any).client.readBlob = packedClientReadBlob;
    const recoveryReadBinary = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (filePath: string) => {
      if (filePath === 'note.md') throw new Error('transient recovery read failure');
      return await recoveryReadBinary(filePath);
    };
    await expect((plugin as any).client.recoveryFileFingerprint('note.md')).rejects.toThrow();
    await expect((plugin as any).client.createRecoveryBundle('pull_apply', commit, ['note.md'])).rejects.toThrow();
    expect((await adapter.list('.obts/recovery')).folders.some((folder) => folder.includes('.partial-rec_'))).toBe(false);
    adapter.readBinary = recoveryReadBinary;
    const packFilesBeforeEmptyImport = (await adapter.list('.obts/git/objects/pack')).files;
    const emptyPackHeader = Buffer.alloc(12);
    emptyPackHeader.write('PACK', 0, 'ascii');
    emptyPackHeader.writeUInt32BE(2, 4);
    emptyPackHeader.writeUInt32BE(0, 8);
    const emptyPack = Buffer.concat([emptyPackHeader, createHash('sha1').update(emptyPackHeader).digest()]);
    await expect((plugin as any).client.importPack(emptyPack)).resolves.toBeUndefined();
    expect((await adapter.list('.obts/git/objects/pack')).files).toEqual(packFilesBeforeEmptyImport);

    const originalWindowSetTimeout = (context as any).setTimeout;
    const originalWindowClearTimeout = (context as any).clearTimeout;
    let stallWatchdog: (() => void) | null = null;
    (context as any).setTimeout = (callback: () => void, delay: number) => {
      if (delay === 30_000) {
        stallWatchdog = callback;
        return 99_001;
      }
      return originalWindowSetTimeout(callback, delay);
    };
    (context as any).clearTimeout = (timer: number) => {
      if (timer !== 99_001) originalWindowClearTimeout(timer);
    };
    const clientReadState = (plugin as any).client.readState;
    const clientReadPrimaryState = (plugin as any).client.readPrimaryState;
    const clientReadDeviceToken = (plugin as any).client.readDeviceToken;
    (plugin as any).client.readState = async () => { throw new Error('stalled diagnostics must not read state'); };
    (plugin as any).client.readPrimaryState = async () => ({ vault_id: 'vlt_stall', device_id: 'dev_stall' });
    (plugin as any).client.readDeviceToken = async () => 'test-device-token';
    (plugin as any).settings.shareErrorDiagnostics = true;
    (plugin as any).settings.diagnosticConsentServer = 'http://127.0.0.1:3000';
    (plugin as any).settings.diagnosticConsentVersion = 1;
    (plugin as any).setInitializationStage('Starting local state checks', null);
    expect(stallWatchdog).toBeNull();
    await (plugin as any).prepareInitializationDiagnosticAuth();
    expect((plugin as any).initializationDiagnosticToken).toBe('test-device-token');
    (plugin as any).clientReady = false;
    (plugin as any).clientInitialization = Promise.resolve();
    (plugin as any).setInitializationStage('Checking interrupted apply journal', 'recovery_journal');
    const staleWatchdog = stallWatchdog!;
    stallWatchdog = null;
    (plugin as any).setInitializationStage('Reading interrupted apply target commit', 'recovery_target_commit');
    const activeWatchdog = stallWatchdog!;
    staleWatchdog();
    await Promise.resolve();
    expect(requests).toHaveLength(0);
    activeWatchdog();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    stallWatchdog = null;
    (plugin as any).setInitializationStage('Reading interrupted apply target commit', 'recovery_target_commit');
    expect(stallWatchdog).toBeNull();
    const stallRequest = requests.at(-1)!;
    const stallReport = JSON.parse(stallRequest.body as string) as Record<string, any>;
    expect(stallRequest.url).toBe('http://127.0.0.1:3000/api/v1/device/diagnostic-events');
    expect((stallRequest.headers as Record<string, string>).authorization).toBe('Bearer test-device-token');
    expect(stallReport).toMatchObject({
      flow: 'recovery',
      stage: 'recovery',
      failure_code: 'operation_stalled',
      retryable: true,
      breadcrumbs: [{ point: 'recovery_target_commit', outcome: 'started' }]
    });
    expect(JSON.stringify(stallReport)).not.toContain('stalled diagnostics must not read state');
    await (plugin as any).setDiagnosticSharing(false);
    stallWatchdog = null;
    (plugin as any).setInitializationStage('Reading interrupted apply target tree', 'recovery_target_tree');
    expect(stallWatchdog).not.toBeNull();
    stallWatchdog!();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    (plugin as any).client.readState = clientReadState;
    (plugin as any).client.readPrimaryState = clientReadPrimaryState;
    (plugin as any).client.readDeviceToken = clientReadDeviceToken;
    (plugin as any).clientInitialization = null;
    (plugin as any).clientReady = true;
    (plugin as any).settings.shareErrorDiagnostics = false;
    (plugin as any).settings.diagnosticConsentServer = '';
    (plugin as any).settings.diagnosticConsentVersion = 0;
    requests.length = 0;
    (context as any).setTimeout = originalWindowSetTimeout;
    (context as any).clearTimeout = originalWindowClearTimeout;

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
    expect(await runtimeClient.readIndexDelta(null)).toMatchObject({
      head: runtimeMain,
      base: null,
      mode: 'rebuild',
      changes: [
        {
          path: 'note.md',
          kind: 'add',
          content_sha256: `sha256:${createHash('sha256').update('runtime baseline\n').digest('hex')}`
        }
      ]
    });
    expect(await runtimeClient.readIndexDelta(runtimeMain)).toMatchObject({
      head: runtimeMain,
      base: runtimeMain,
      mode: 'incremental',
      changes: []
    });

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

    await runtimeAdapter.mkdir('mobile-delete');
    await runtimeAdapter.mkdir('mobile-delete/nested');
    await runtimeAdapter.mkdir('mobile-delete/nested/leaf');
    const runtimeRmdir = runtimeAdapter.rmdir.bind(runtimeAdapter);
    const runtimeRecursiveFlags: boolean[] = [];
    runtimeAdapter.rmdir = async (path: string, recursive = false) => {
      if (path === 'mobile-delete' || path.startsWith('mobile-delete/')) runtimeRecursiveFlags.push(recursive);
      await runtimeRmdir(path, recursive);
    };
    const mobileDeleteDirectories = ['mobile-delete', 'mobile-delete/nested', 'mobile-delete/nested/leaf'];
    const residual = await runtimeClient.applyDirectoryChanges(
      [{ op: 'delete', path: 'mobile-delete' }],
      [],
      new Set(mobileDeleteDirectories),
      await runtimeClient.captureDirectoryCreationTimes(mobileDeleteDirectories)
    );
    expect(await runtimeAdapter.exists('mobile-delete')).toBe(false);
    expect([...residual]).toEqual([]);
    expect(runtimeRecursiveFlags).toEqual([false, false, false]);

    await runtimeAdapter.mkdir('persistent-rmdir-failure');
    const workingRmdir = runtimeAdapter.rmdir.bind(runtimeAdapter);
    let failedRmdirAttempts = 0;
    runtimeAdapter.rmdir = async (path: string, recursive = false) => {
      if (path === 'persistent-rmdir-failure') {
        failedRmdirAttempts += 1;
        throw Object.assign(new Error('simulated persistent mobile rmdir failure'), { code: 'EIO' });
      }
      await workingRmdir(path, recursive);
    };
    await expect(runtimeClient.applyDirectoryChanges(
      [{ op: 'delete', path: 'persistent-rmdir-failure' }],
      [],
      new Set(['persistent-rmdir-failure']),
      { 'persistent-rmdir-failure': (await runtimeAdapter.stat('persistent-rmdir-failure'))?.ctime ?? null }
    )).rejects.toMatchObject({ code: 'directory_delete_failed' });
    expect(failedRmdirAttempts).toBe(3);
    expect(await runtimeAdapter.exists('persistent-rmdir-failure')).toBe(true);
    runtimeAdapter.rmdir = workingRmdir;

    await runtimeAdapter.mkdir('missing-directory-identity');
    await expect(runtimeClient.applyDirectoryChanges(
      [{ op: 'delete', path: 'missing-directory-identity' }],
      [],
      new Set(['missing-directory-identity']),
      { 'missing-directory-identity': null }
    )).rejects.toMatchObject({ code: 'directory_identity_unavailable' });
    expect(await runtimeAdapter.exists('missing-directory-identity')).toBe(true);

    await runtimeAdapter.mkdir('directory-inspection-failure');
    const inspectionCtime = (await runtimeAdapter.stat('directory-inspection-failure'))?.ctime ?? null;
    const runtimeStat = runtimeAdapter.stat.bind(runtimeAdapter);
    runtimeAdapter.stat = async (path: string) => {
      if (path === 'directory-inspection-failure') throw Object.assign(new Error('simulated mobile stat failure'), { code: 'EIO' });
      return await runtimeStat(path);
    };
    await expect(runtimeClient.applyDirectoryChanges(
      [{ op: 'delete', path: 'directory-inspection-failure' }],
      [],
      new Set(['directory-inspection-failure']),
      { 'directory-inspection-failure': inspectionCtime }
    )).rejects.toMatchObject({ code: 'directory_inspection_failed' });
    runtimeAdapter.stat = runtimeStat;

    await runtimeAdapter.mkdir('directory-list-failure');
    const listFailureCtime = (await runtimeAdapter.stat('directory-list-failure'))?.ctime ?? null;
    const runtimeList = runtimeAdapter.list.bind(runtimeAdapter);
    runtimeAdapter.list = async (path: string) => {
      if (path === 'directory-list-failure') throw Object.assign(new Error('simulated mobile list failure'), { code: 'EIO' });
      return await runtimeList(path);
    };
    await expect(runtimeClient.applyDirectoryChanges(
      [{ op: 'delete', path: 'directory-list-failure' }],
      [],
      new Set(['directory-list-failure']),
      { 'directory-list-failure': listFailureCtime }
    )).rejects.toMatchObject({ code: 'directory_inspection_failed' });
    runtimeAdapter.list = runtimeList;

    const runtimeMkdir = runtimeAdapter.mkdir.bind(runtimeAdapter);
    runtimeAdapter.mkdir = async (path: string) => {
      if (path === 'failed-authoritative-directory') throw Object.assign(new Error('simulated mobile mkdir failure'), { code: 'EIO' });
      await runtimeMkdir(path);
    };
    await expect(runtimeClient.applyDirectoryChanges([], ['failed-authoritative-directory'], new Set(), {})).rejects.toMatchObject({
      code: 'directory_materialization_failed'
    });
    runtimeAdapter.mkdir = runtimeMkdir;
    await runtimeClient.refreshDirectoryStateFromDisk([]);

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
      const TransportError = (module.exports as any).TransportError;
      throw new TransportError(0, 'network_error', 'network unavailable after scan');
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
    expect(lightweightPolls).toBe(10);
    expect((runtimePlugin as any).automaticRetryNotBefore).toBeGreaterThan(Date.now());
    (runtimePlugin as any).clearTransientSyncFailures();

    runtimeClient.syncOnce = async () => {
      fullScans += 1;
      const TransportError = (module.exports as any).TransportError;
      throw new TransportError(409, 'blocked_integrity', 'vault integrity repair required');
    };
    (runtimePlugin as any).lastFullScanCompletedAt = null;
    await (runtimePlugin as any).runBackgroundSync();
    expect(await runtimeClient.readState()).toMatchObject({
      status_label: 'Unsafe local state',
      last_error_code: 'blocked_integrity'
    });
    expect((runtimePlugin as any).automaticRetryNotBefore).toBe(0);
    await (runtimePlugin as any).runUserAction(async () => {
      const TransportError = (module.exports as any).TransportError;
      throw new TransportError(409, 'blocked_integrity', 'vault integrity repair required');
    }, false);
    expect(await runtimeClient.readState()).toMatchObject({
      status_label: 'Unsafe local state',
      last_error_code: 'blocked_integrity'
    });
    await runtimeClient.writeState({
      ...(await runtimeClient.readState()),
      status_label: 'Synced',
      last_error_code: null,
      updated_at: new Date().toISOString()
    });
    (runtimePlugin as any).clearTransientSyncFailures();
    await (runtimePlugin as any).runUserAction(async () => {
      const TransportError = (module.exports as any).TransportError;
      throw new TransportError(503, 'server_unavailable', 'server temporarily unavailable');
    }, false);
    expect((runtimePlugin as any).currentStatusLabel).toBe('Checking (server unavailable; retrying)');
    expect((runtimePlugin as any).automaticRetryNotBefore).toBeGreaterThan(Date.now());

    (plugin as any).client = new runtimeClient.constructor(plugin);
    await (plugin as any).client.initialize();
    requests.length = 0;

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
    const originalOperationSetTimeout = (context as any).setTimeout;
    const operationTimerCallbacks: Array<() => void> = [];
    (context as any).setTimeout = (callback: () => void, milliseconds: number) => {
      if (milliseconds === 30 * 1000) {
        operationTimerCallbacks.push(callback);
        return 90_000 + operationTimerCallbacks.length;
      }
      return originalOperationSetTimeout(callback, milliseconds);
    };
    let operationStatusReports = 0;
    (plugin as any).client.reportDeviceStatus = async () => { operationStatusReports += 1; };
    expect((plugin as any).beginSync()).toBe(true);
    (plugin as any).setOperationProgress('Applying 1/2', 'apply_write');
    expect((plugin as any).operationStatusHeartbeatTimer).not.toBeNull();
    expect((plugin as any).isSyncInProgress()).toBe(true);
    expect(statusItem.text).toBe('obts: Applying 1/2');
    for (const callback of operationTimerCallbacks) callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(operationStatusReports).toBe(1);
    expect(statusItem.text).toContain('taking longer than expected');
    (context as any).setTimeout = originalOperationSetTimeout;
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
