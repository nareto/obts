import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { NodeDataAdapter } from '../../src/client/nodeDataAdapter.js';

export class UiElement {
  text = '';
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; }
  children: UiElement[] = [];
  buttons: any[] = [];
  controls: any[] = [];
  attrs: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  empty() { this.children = []; this.buttons = []; this.controls = []; this.text = ''; }
  addClass() {}
  removeClass() {}
  setText(text: string) { this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  createEl(_tag: string, options: any = {}) {
    const child = new UiElement(); child.text = options.text || ''; this.children.push(child); return child;
  }
  createDiv(options: any = {}) { return this.createEl('div', options); }
  get allText(): string { return [this.text, ...this.children.map(child => child.allText)].join(' '); }
}

export async function mobileHarness(root: string, serverUrl: string, options: { request?: (request: any, send: () => Promise<any>) => Promise<any> } = {}) {
  const commands = new Map<string, () => Promise<void>>();
  const modals: any[] = [];
  const timers = new Set<any>();
  const listeners = new Map<string, Set<() => void>>();
  const doc: any = {
    hidden: false,
    addEventListener(name: string, listener: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); }
  };
  const win: any = {
    ...doc,
    open() {},
    setTimeout(fn: () => void, ms: number) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout(timer: any) { clearTimeout(timer); timers.delete(timer); },
    setInterval(fn: () => void, ms: number) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    clearInterval(timer: any) { clearInterval(timer); timers.delete(timer); }
  };
  class Setting {
    constructor(private element: UiElement) {}
    setName() { return this; }
    setDesc() { return this; }
    control(callback: (control: any) => void, button = false) {
      const control: any = { text: '', disabled: false, value: '', inputEl: {},
        setValue(value: unknown) { control.value = value; return control; },
        addOption() { return control; }, setCta() { return control; }, setWarning() { return control; },
        setButtonText(text: string) { control.text = text; return control; },
        setDisabled(disabled: boolean) { control.disabled = disabled; return control; },
        onChange(fn: any) { control.change = fn; return control; }, onClick(fn: any) { control.click = fn; return control; }
      };
      callback(control); (button ? this.element.buttons : this.element.controls).push(control); return this;
    }
    addButton(callback: any) { return this.control(callback, true); }
    addDropdown(callback: any) { return this.control(callback); }
    addToggle(callback: any) { return this.control(callback); }
    addText(callback: any) { return this.control(callback); }
  }
  class Modal {
    contentEl = new UiElement();
    constructor(public app: any) { modals.push(this); }
    async open() { await (this as any).onOpen(); }
    close() { (this as any).onClose(); }
  }
  class Plugin {
    app: any;
    manifest = { id: 'obts' };
    async loadData() { return { serverUrl, deviceName: 'Recovery device', autoSync: false }; }
    async saveData() {}
    addStatusBarItem() { return new UiElement(); }
    addRibbonIcon() { return new UiElement(); }
    addSettingTab() {}
    addCommand(command: any) { commands.set(command.id, command.callback); }
    registerInterval(timer: any) { win.clearInterval(timer); }
    registerDomEvent() {}
    registerEvent() {}
  }
  const native = new NodeDataAdapter(root);
  // Exercise the mobile metadata-visibility barrier, with a persistent backing store.
  const adapter: any = new Proxy(native, { get(target: any, key) {
    if (key === 'syncFile' || key === 'syncDirectory') return undefined;
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const requests: string[] = [];
  const obsidian = {
    Plugin, Modal, Setting,
    PluginSettingTab: class { constructor(public app: any, public plugin: any) {} },
    Notice: class { constructor(_message: string) {} },
    Platform: { isMobile: true, isIosApp: true }, apiVersion: '1.9.12',
    requestUrl: async (request: any) => {
      requests.push(new URL(request.url).pathname);
      const send = async () => {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
        const arrayBuffer = await response.arrayBuffer();
        const text = Buffer.from(arrayBuffer).toString('utf8');
        return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer, text };
      };
      return options.request ? options.request(request, send) : send();
    }
  };
  const module = { exports: {} as any };
  const context = vm.createContext({ module, exports: module.exports, require: (name: string) => {
    if (name !== 'obsidian') throw new Error(`Unexpected runtime dependency: ${name}`); return obsidian;
  }, window: win, document: doc, navigator: { onLine: true }, crypto: webcrypto, console,
  TextEncoder, TextDecoder, AbortController, URL, ArrayBuffer, Uint8Array, setTimeout: win.setTimeout,
  clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval });
  vm.runInContext(await readFile('obsidian-plugin/main.js', 'utf8'), context);
  const plugin = new module.exports();
  plugin.app = {
    vault: { adapter, getName: () => 'Recovery vault', on() {}, createBinary: (path: string, bytes: ArrayBuffer) => native.writeBinaryExclusive(path, bytes) },
    workspace: { onLayoutReady() {}, getLeavesOfType: () => [] }
  };
  await plugin.onload();
  await plugin.initializeClient();
  return {
    plugin, core: plugin.client, adapter, requests, modals, context,
    async open() {
      await commands.get('obts-setup-sync')!();
      const modal = modals.at(-1);
      await waitUntil(() => modal.contentEl.buttons.length > 0);
      return modal;
    },
    foreground() { doc.hidden = false; for (const listener of listeners.get('visibilitychange') || []) listener(); },
    hide() { doc.hidden = true; for (const listener of listeners.get('visibilitychange') || []) listener(); },
    dispose() { for (const modal of modals) modal.close(); plugin.onunload(); for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers.clear(); }
  };
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('Timed out waiting for test boundary.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function click(modal: any, text: string) {
  const button = modal.contentEl.buttons.find((candidate: any) => candidate.text === text);
  if (!button || button.disabled) throw new Error(`UI action unavailable: ${text}`);
  await button.click();
}
