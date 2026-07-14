import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
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

    expect(manifest.isDesktopOnly).toBe(false);
    expect(artifact).not.toMatch(/require\(["'](?:node:|fs["']|path["']|crypto["']|child_process["']|os["'])/u);
    expect(artifact).not.toContain('requireDesktopVaultPath');
    expect(artifact).not.toContain('Git binary');

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
    class Plugin {
      app: any;
      async loadData() { return {}; }
      async saveData(value: unknown) { savedSettings.push(value); }
      addStatusBarItem() { return { setText() {} }; }
      addSettingTab() {}
      addCommand() {}
      registerEvent() {}
      registerInterval(id: ReturnType<typeof setInterval>) { clearInterval(id); }
      registerDomEvent() {}
    }
    const obsidian = {
      Plugin,
      PluginSettingTab: class {},
      Setting: class {},
      Notice: class {},
      Modal: class {},
      Platform: {
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
      document: { hidden: false },
      console
    });
    Object.assign(context, { globalThis: context, window: context });

    new vm.Script(artifact, { filename: 'obsidian-plugin/main.js' }).runInContext(context);
    expect(typeof module.exports).toBe('function');
    expect(typeof (context as any).Buffer).toBe('function');

    const adapter = new MemoryDataAdapter();
    const PluginClass = module.exports as new () => Plugin;
    const plugin = new PluginClass();
    plugin.app = {
      vault: {
        adapter,
        getName: () => 'Mobile Test Vault',
        on: () => ({})
      },
      workspace: { getLeavesOfType: () => [] }
    };
    await (plugin as any).onload();

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
    (retiring as any).onunload();
    released = true;
    releaseInitialization();
    await retiringLoad;
    await expect((successor as any).ensureClientReady()).resolves.toBe(true);
    expect((successor as any).clientReady).toBe(true);
    expect(overlappingWrites).toBe(0);
    (successor as any).onunload();
  });
});
