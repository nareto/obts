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
    class Plugin {
      app: any;
      async loadData() { return {}; }
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
      requestUrl: async () => ({ status: 200, headers: {}, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) })
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
