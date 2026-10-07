import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

type Json = Record<string, unknown>;
type Core = Record<string, any>;

class Session {
  cookie = '';
  csrf = '';
  vaultId = '';

  constructor(readonly baseUrl: string) {}

  async post<T extends Json>(path: string, body: Json, csrf = true): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(csrf && this.csrf ? { 'x-obts-csrf': this.csrf } : {})
      },
      body: JSON.stringify(body)
    });
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = (headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';')[0]).filter(Boolean);
    if (cookies.length > 0) this.cookie = cookies.join('; ');
    const parsed = (await response.json()) as T;
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') this.csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  }
}

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function coreOf(plugin: ObtsPluginClient): Core {
  return (plugin as unknown as { client: Core }).client;
}

async function settle(plugin: ObtsPluginClient, options: Json = {}, maxCycles = 6): Promise<string[]> {
  const statuses: string[] = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const result = await plugin.syncOnce(options);
    statuses.push(result.status);
    if (result.status === 'Synced') break;
  }
  return statuses;
}

// Ends every open authoring horizon and lets a full scan retire it, so the
// device starts from the idle state a background check would reach.
async function settleHorizons(plugin: ObtsPluginClient) {
  const core = coreOf(plugin);
  await core.mutateStaleProvenance(async (saved: any) => { for (const horizon of saved.horizons) horizon.expiry = Date.now() - 1; });
  expect((await settle(plugin)).at(-1)).toBe('Synced');
  expect((await core.readStaleProvenance()).horizons).toEqual([]);
  expect((await core.backgroundScanDecision()).required).toBe(false);
}

function spy(core: Core, name: string) {
  const original = core[name].bind(core);
  const calls: { args: unknown[]; result?: unknown }[] = [];
  core[name] = async (...args: unknown[]) => {
    const call: { args: unknown[]; result?: unknown } = { args };
    calls.push(call);
    call.result = await original(...args);
    return call.result;
  };
  return calls;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-hinted-capture-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'hinted-capture-secret-with-entropy' });
  servers.push(server);
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = new Session(baseUrl);
  await admin.post('/api/v1/setup', { username: 'admin', password: 'admin-password-1234' }, false);
  admin.vaultId = (await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Hinted' })).body.vault_id;
  const pair = async (vaultDir: string, deviceName: string) => {
    const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName });
    const connection = await plugin.startOnboarding('Hinted');
    await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: admin.vaultId });
    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await plugin.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
    return plugin;
  };
  const writerDir = join(root, 'writer');
  const vaultDir = join(root, 'device');
  const writer = await pair(writerDir, 'hinted-writer');
  await mkdir(join(writerDir, 'notes'), { recursive: true });
  await writeFile(join(writerDir, 'a.md'), 'a0\n');
  await writeFile(join(writerDir, 'b.md'), 'b0\n');
  await writeFile(join(writerDir, 'notes', 'c.md'), 'c0\n');
  await writer.syncOnce({ confirmInitialImport: true });
  expect((await settle(writer)).at(-1)).toBe('Synced');
  const plugin = await pair(vaultDir, 'hinted-device');
  expect((await settle(plugin)).at(-1)).toBe('Synced');
  await settleHorizons(plugin);
  return { root, server, baseUrl, vaultDir, writerDir, writer, plugin, core: coreOf(plugin) };
}

async function currentMain(server: ObtsServer): Promise<string> {
  return String((await server.store.snapshot()).vaults[0]!.current_main);
}

async function serverFile(core: Core, commit: string, filePath: string): Promise<string | undefined> {
  const entries = await core.listTreeBlobOids(commit);
  const oid = entries.get(filePath);
  return oid ? Buffer.from(await core.readBlobOid(oid)).toString('utf8') : undefined;
}

describe('hinted capture (OBTS-SYNC-DELTA-001)', () => {
  it('rewrites only the changed tree path and matches a full tree rebuild', async () => {
    const { core } = await fixture();
    const oid = (seed: number) => seed.toString(16).padStart(40, '0');
    const blob = (seed: number) => ({ mode: '100644', oid: oid(seed) });
    const base = new Map([
      ['a.md', blob(1)], ['a/b.md', blob(2)], ['a-b.md', blob(3)], ['a/deep/x.md', blob(4)], ['z.md', blob(5)]
    ]);
    const changes = new Map([
      ['a/b.md', blob(12)], ['a/c.md', blob(13)], ['a.b', blob(14)], ['new/deep/e.md', blob(15)], ['a/deep/y.md', { mode: '100755', oid: oid(16) }]
    ]);
    const baseTree = await core.writeTreeFromEntries(base);
    const expected = await core.writeTreeFromEntries(new Map([...base, ...changes]));
    expect(await core.writeTreeWithChanges(baseTree, changes)).toBe(expected);
    expect(await core.writeTreeWithChanges(baseTree, new Map())).toBe(baseTree);
    await expect(core.writeTreeWithChanges(baseTree, new Map([['a.md/x.md', blob(20)]]))).rejects.toThrow('crosses a file');
    await expect(core.writeTreeWithChanges(baseTree, new Map([['a', blob(21)]]))).rejects.toThrow('replaces a directory');
  });

  it('captures hinted edits and new files in known folders without a vault inventory', async () => {
    const value = await fixture();
    const inventories = spy(value.core, 'listLocalVaultInventory');
    const hinted = spy(value.core, 'captureHintedLocalChanges');
    await writeFile(join(value.vaultDir, 'a.md'), 'a1 hinted\n');
    await writeFile(join(value.vaultDir, 'notes', 'd.md'), 'd0 new\n');
    await value.plugin.recordLocalChangeHint(['a.md', 'notes/d.md']);

    expect((await settle(value.plugin, { hintedCapture: true })).at(-1)).toBe('Synced');

    expect(hinted[0]!.result).toMatchObject({ commit: expect.any(String) });
    expect(inventories).toHaveLength(0);
    const main = await currentMain(value.server);
    expect(await serverFile(value.core, main, 'a.md')).toBe('a1 hinted\n');
    expect(await serverFile(value.core, main, 'notes/d.md')).toBe('d0 new\n');
    expect(await serverFile(value.core, main, 'b.md')).toBe('b0\n');
    const state = await value.core.readState();
    expect(state).toMatchObject({ local_main: main, local_head: main });
    // The inventory taken before the hinted commit still describes the vault.
    const scanState = JSON.parse(await readFile(join(value.vaultDir, '.obts', 'scan-state.json'), 'utf8'));
    expect(scanState.local_head).toBe(main);
    expect((await value.core.readQueue())).toMatchObject({ pending_commit: null, changed_paths: [] });
  });

  it('records a no-op when the hinted file already matches the base', async () => {
    const value = await fixture();
    const inventories = spy(value.core, 'listLocalVaultInventory');
    const before = await currentMain(value.server);
    await value.plugin.recordLocalChangeHint(['b.md']);

    expect((await settle(value.plugin, { hintedCapture: true })).at(-1)).toBe('Synced');

    expect(inventories).toHaveLength(0);
    expect(await currentMain(value.server)).toBe(before);
    expect((await value.core.readQueue())).toMatchObject({ pending_commit: null, changed_paths: [] });
  });

  const fallbacks: [string, (dir: string, core: Core) => Promise<string[]>, (core: Core, main: string) => Promise<void>][] = [
    ['a deletion', async (dir) => {
      await rm(join(dir, 'b.md'));
      return ['b.md'];
    }, async (core, main) => expect(await serverFile(core, main, 'b.md')).toBeUndefined()],
    ['a file in a new folder', async (dir) => {
      await mkdir(join(dir, 'fresh'));
      await writeFile(join(dir, 'fresh', 'e.md'), 'e0\n');
      return ['fresh/e.md'];
    }, async (core, main) => expect(await serverFile(core, main, 'fresh/e.md')).toBe('e0\n')],
    ['a folder hint', async (dir) => {
      await writeFile(join(dir, 'notes', 'f.md'), 'f0\n');
      return ['notes'];
    }, async (core, main) => expect(await serverFile(core, main, 'notes/f.md')).toBe('f0\n')],
    ['a root policy edit', async (dir) => {
      await writeFile(join(dir, '.gitignore'), 'ignored/\n');
      return ['.gitignore'];
    }, async (core, main) => expect(await serverFile(core, main, '.gitignore')).toBe('ignored/\n')],
    ['an explicit inventory request', async (dir, core) => {
      await writeFile(join(dir, 'a.md'), 'a1 requested\n');
      await writeFile(join(dir, 'unhinted.md'), 'u0\n');
      core.requestFullInventory();
      return ['a.md'];
    }, async (core, main) => expect(await serverFile(core, main, 'unhinted.md')).toBe('u0\n')]
  ];

  it.each(fallbacks)('takes the whole-vault inventory for %s', async (_name, change, verify) => {
    const value = await fixture();
    const inventories = spy(value.core, 'listLocalVaultInventory');
    const hinted = spy(value.core, 'captureHintedLocalChanges');
    await value.plugin.recordLocalChangeHint(await change(value.vaultDir, value.core));

    expect((await settle(value.plugin, { hintedCapture: true })).at(-1)).toBe('Synced');

    expect(hinted[0]!.result).toBeNull();
    expect(inventories.length).toBeGreaterThan(0);
    await verify(value.core, await currentMain(value.server));
    expect(value.core.fullInventoryCurrent()).toBe(true);
  });

  it('inventories once per session before trusting watcher hints', async () => {
    const value = await fixture();
    const restarted = new ObtsPluginClient(value.vaultDir, { serverUrl: value.baseUrl, deviceName: 'hinted-device' });
    await restarted.initialize();
    const core = coreOf(restarted);
    expect(core.fullInventoryCurrent()).toBe(false);
    // An edit the previous session never hinted is still captured.
    await writeFile(join(value.vaultDir, 'b.md'), 'b1 offline\n');
    await writeFile(join(value.vaultDir, 'a.md'), 'a1 hinted\n');
    await restarted.recordLocalChangeHint(['a.md']);

    expect((await settle(restarted, { hintedCapture: true })).at(-1)).toBe('Synced');

    const main = await currentMain(value.server);
    expect(await serverFile(core, main, 'b.md')).toBe('b1 offline\n');
    expect(await serverFile(core, main, 'a.md')).toBe('a1 hinted\n');
    expect(core.fullInventoryCurrent()).toBe(true);
  });

  it('retires elapsed horizons that touched no path without requiring a scan', async () => {
    const value = await fixture();
    await writeFile(join(value.vaultDir, 'a.md'), 'a1 own push\n');
    await value.plugin.recordLocalChangeHint(['a.md']);
    expect((await settle(value.plugin, { hintedCapture: true })).at(-1)).toBe('Synced');
    const own = (await value.core.readStaleProvenance()).horizons;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((horizon: { touched: string[] }) => horizon.touched.length === 0)).toBe(true);

    await value.core.mutateStaleProvenance(async (saved: any) => { for (const horizon of saved.horizons) horizon.expiry = Date.now() - 1; });
    expect((await value.core.backgroundScanDecision()).required).toBe(false);
    expect((await value.core.readStaleProvenance()).horizons).toEqual([]);

    // A horizon over applied paths still ends only inside a scan.
    await writeFile(join(value.writerDir, 'b.md'), 'b1 remote\n');
    expect((await settle(value.writer)).at(-1)).toBe('Synced');
    expect((await settle(value.plugin, { hintedCapture: true })).at(-1)).toBe('Synced');
    expect(await readFile(join(value.vaultDir, 'b.md'), 'utf8')).toBe('b1 remote\n');
    await value.core.mutateStaleProvenance(async (saved: any) => { for (const horizon of saved.horizons) horizon.expiry = Date.now() - 1; });
    const remote = (await value.core.readStaleProvenance()).horizons;
    expect(remote.some((horizon: { touched: string[] }) => horizon.touched.includes('b.md'))).toBe(true);
    expect((await value.core.backgroundScanDecision())).toMatchObject({ required: true, mode: 'incremental' });
    expect((await value.core.readStaleProvenance()).horizons).toEqual(remote);
  });

  it('skips the directory reconcile only when nothing could have changed a folder', async () => {
    const value = await fixture();
    const reconciles = spy(value.core, 'reconcileDirectoryState');
    await value.core.clearAcknowledgedDirectoryIntents([]);
    expect(reconciles).toHaveLength(0);

    await value.plugin.recordLocalChangeHint(['notes']);
    await value.core.clearAcknowledgedDirectoryIntents([]);
    expect(reconciles).toHaveLength(1);

    await value.core.updateQueue(async (queue: any) => ({ ...queue, changed_paths: [] }));
    value.core.requestFullInventory();
    await value.core.clearAcknowledgedDirectoryIntents([]);
    expect(reconciles).toHaveLength(2);
  });
});
