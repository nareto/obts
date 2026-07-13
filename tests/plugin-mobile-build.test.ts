import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { MemoryDataAdapter } from './helpers/memoryDataAdapter.js';

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
    expect(browserHandoff).toContain('await waitForMobileBrowserReturn();');
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
      plugin_version: '0.4.0',
      obsidian_version: '1.9.12',
      platform_family: 'ios',
      failure_code: 'null_pack_slice',
      error_class: 'type_error'
    });
    expect(JSON.stringify(diagnosticBody)).not.toContain('private-note.md');
    expect(JSON.stringify(diagnosticBody)).not.toContain('obts_dev_secret');
    expect(JSON.stringify(diagnosticBody)).not.toContain('obts_conn_private');

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
    expect(requests).toHaveLength(1);
    expect((plugin as any).diagnosticSharingEnabled()).toBe(false);
    expect(savedSettings.length).toBeGreaterThan(0);

    const replacement = new PluginClass();
    replacement.app = plugin.app;
    expect((plugin as any).beginSync()).toBe(true);
    (plugin as any).syncRunningSince = Date.now() - 60 * 60 * 1000;
    expect((plugin as any).isSyncInProgress()).toBe(true);
    expect((replacement as any).beginSync()).toBe(false);
    (plugin as any).onunload();
    expect((replacement as any).beginSync()).toBe(false);
    (plugin as any).endSync();
    expect((replacement as any).beginSync()).toBe(true);
    (replacement as any).endSync();
  });
});
