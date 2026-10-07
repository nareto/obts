import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

async function settle(plugin: ObtsPluginClient, maxCycles = 6): Promise<string[]> {
  const statuses: string[] = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const result = await plugin.syncOnce();
    statuses.push(result.status);
    if (result.status === 'Synced') break;
  }
  return statuses;
}

function coreOf(plugin: ObtsPluginClient): Core {
  return (plugin as unknown as { client: Core }).client;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-ref-only-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'ref-only-apply-secret-with-entropy' });
  servers.push(server);
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = new Session(baseUrl);
  await admin.post('/api/v1/setup', { username: 'admin', password: 'admin-password-1234' }, false);
  admin.vaultId = (await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Ref Only' })).body.vault_id;
  const pair = async (vaultDir: string, deviceName: string) => {
    const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName });
    const connection = await plugin.startOnboarding('Ref Only');
    await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: admin.vaultId });
    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await plugin.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
    return plugin;
  };
  const vaultDir = join(root, 'device');
  const writerDir = join(root, 'writer');
  const writer = await pair(writerDir, 'ref-only-writer');
  await writeFile(join(writerDir, 'a.md'), 'a0\n');
  await writeFile(join(writerDir, 'b.md'), 'b0\n');
  await writer.syncOnce({ confirmInitialImport: true });
  expect((await settle(writer)).at(-1)).toBe('Synced');
  const plugin = await pair(vaultDir, 'ref-only-device');
  expect((await settle(plugin)).at(-1)).toBe('Synced');
  return { root, server, baseUrl, vaultDir, writerDir, writer, plugin, core: coreOf(plugin) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function spy(core: Core, name: string, before?: (...args: unknown[]) => Promise<void> | void) {
  const original = core[name].bind(core);
  const calls: unknown[][] = [];
  core[name] = async (...args: unknown[]) => {
    calls.push(args);
    if (before) await before(...args);
    return await original(...args);
  };
  return calls;
}

async function currentMain(server: ObtsServer): Promise<string> {
  return String((await server.store.snapshot()).vaults[0]!.current_main);
}

async function expectSettledAt(value: Fixture, core: Core, main: string) {
  const state = JSON.parse(await readFile(join(value.vaultDir, '.obts', 'state.json'), 'utf8'));
  expect(state).toMatchObject({ local_main: main, local_head: main, status_label: 'Synced' });
  expect(await core.resolveRef('refs/heads/main')).toBe(main);
  expect(await core.resolveRef('refs/heads/local')).toBe(main);
  await expect(stat(join(value.vaultDir, '.obts', 'apply-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(value.vaultDir, '.obts', 'pending-applied-ack.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const device = (await value.server.store.snapshot()).devices.find((candidate) => candidate.device_name === 'ref-only-device');
  expect(device).toMatchObject({ last_applied_main: main });
}

async function blobAt(core: Core, commit: string, filePath: string): Promise<string> {
  const entries = await core.listTreeBlobOids(commit);
  return Buffer.from(await core.readBlobOid(entries.get(filePath))).toString('utf8');
}

describe('ref-only apply (OBTS-SYNC-DELTA-001)', () => {
  it('accepts its own merged push without reading or writing vault files', async () => {
    const value = await fixture();
    const refOnly = spy(value.core, 'applyRefOnly');
    const staged = spy(value.core, 'stageApplyRecoveryFiles');
    const captured = spy(value.core, 'captureStableLocalChanges');
    let applying = false;
    let inventoriesDuringApply = 0;
    const applyTargetMain = value.core.applyTargetMain.bind(value.core);
    value.core.applyTargetMain = async (...args: unknown[]) => {
      applying = true;
      try {
        return await applyTargetMain(...args);
      } finally {
        applying = false;
      }
    };
    spy(value.core, 'listLocalVaultInventory', () => { if (applying) inventoriesDuringApply += 1; });
    const before = await currentMain(value.server);
    const recoveryBefore = await readdir(join(value.vaultDir, '.obts', 'recovery')).catch(() => []);

    await writeFile(join(value.vaultDir, 'a.md'), 'a1 local\n');
    expect((await settle(value.plugin)).at(-1)).toBe('Synced');

    const main = await currentMain(value.server);
    expect(main).not.toBe(before);
    expect(refOnly).toHaveLength(1);
    expect(staged).toHaveLength(0);
    expect(captured).toHaveLength(0);
    expect(inventoriesDuringApply).toBe(0);
    await expectSettledAt(value, value.core, main);
    expect(await blobAt(value.core, main, 'a.md')).toBe('a1 local\n');
    expect(await readFile(join(value.vaultDir, 'a.md'), 'utf8')).toBe('a1 local\n');
    expect(await readdir(join(value.vaultDir, '.obts', 'recovery')).catch(() => [])).toEqual(recoveryBefore);
  });

  it('requires settled provenance and a visible footprint that already matches the target', async () => {
    const value = await fixture();
    const m0 = await currentMain(value.server);
    await writeFile(join(value.vaultDir, 'a.md'), 'a1 local\n');
    expect((await settle(value.plugin)).at(-1)).toBe('Synced');
    const main = await currentMain(value.server);
    expect(await value.core.changedTreePaths(m0, main)).toEqual(['a.md']);
    expect(await value.core.changedTreePaths(main, main)).toEqual([]);

    const state = { local_head: main, local_main: m0 };
    const empty = await value.core.readStaleProvenance();
    expect(await value.core.refOnlyApplyEligible(state, main, main, empty)).toBe(true);
    const obligation = { base: m0, generation: 0, signature: 'uncaptured' };
    expect(await value.core.refOnlyApplyEligible(state, main, main, { ...empty, obligations: { 'b.md': obligation } })).toBe(false);
    expect(await value.core.refOnlyApplyEligible({ ...state, local_head: m0 }, main, main, empty)).toBe(false);
    expect(await value.core.refOnlyApplyEligible(state, main, null, empty)).toBe(false);
    expect(await value.core.refOnlyApplyEligible(state, main, m0, empty)).toBe(false);

    // A rebuild reset can leave local_head's content unmaterialized.
    await writeFile(join(value.vaultDir, 'a.md'), 'a0\n');
    expect(await value.core.refOnlyApplyEligible(state, main, main, empty)).toBe(false);
    const settled = { ...state, local_main: main };
    expect(await value.core.refOnlyApplyEligible(settled, main, main, empty)).toBe(true);

    // Local work a full apply would publish: an empty folder the target does
    // not list, even when directory state adopted it without an intent, and a
    // pending watcher hint.
    await mkdir(join(value.vaultDir, 'Empty'));
    await value.core.refreshDirectoryStateFromDisk([]);
    expect(await value.core.refOnlyApplyEligible(settled, main, main, empty, [])).toBe(false);
    expect(await value.core.refOnlyApplyEligible(settled, main, main, empty, ['Empty'])).toBe(true);
    await rm(join(value.vaultDir, 'Empty'), { recursive: true });
    await value.core.refreshDirectoryStateFromDisk([]);
    expect(await value.core.refOnlyApplyEligible(settled, main, main, empty)).toBe(true);
    await value.plugin.recordLocalChangeHint(['b.md']);
    expect(await value.core.refOnlyApplyEligible(settled, main, main, empty)).toBe(false);
  });

  it('leaves an unrelated edit made during the ref-only apply for ordinary capture', async () => {
    const value = await fixture();
    const refOnly = spy(value.core, 'applyRefOnly', async () => {
      await writeFile(join(value.vaultDir, 'b.md'), 'b1 concurrent\n');
    });

    await writeFile(join(value.vaultDir, 'a.md'), 'a1 local\n');
    await settle(value.plugin);
    expect(refOnly).toHaveLength(1);
    expect(await readFile(join(value.vaultDir, 'b.md'), 'utf8')).toBe('b1 concurrent\n');

    expect((await settle(value.plugin)).at(-1)).toBe('Synced');
    const main = await currentMain(value.server);
    await expectSettledAt(value, value.core, main);
    expect(await blobAt(value.core, main, 'a.md')).toBe('a1 local\n');
    expect(await blobAt(value.core, main, 'b.md')).toBe('b1 concurrent\n');
    expect(await readFile(join(value.vaultDir, 'b.md'), 'utf8')).toBe('b1 concurrent\n');
  });

  it('uses the full apply for a remote change', async () => {
    const value = await fixture();
    const refOnly = spy(value.core, 'applyRefOnly');
    const staged = spy(value.core, 'stageApplyRecoveryFiles');

    await writeFile(join(value.writerDir, 'b.md'), 'b1 remote\n');
    expect((await settle(value.writer)).at(-1)).toBe('Synced');
    expect((await settle(value.plugin)).at(-1)).toBe('Synced');

    expect(refOnly).toHaveLength(0);
    expect(staged.length).toBeGreaterThan(0);
    await expectSettledAt(value, value.core, await currentMain(value.server));
    expect(await readFile(join(value.vaultDir, 'b.md'), 'utf8')).toBe('b1 remote\n');
  });

  it('rolls a committed ref-only journal forward after a crash before the refs move', async () => {
    const value = await fixture();
    const originalUpdateRef = value.core.updateRef.bind(value.core);
    let crash = false;
    spy(value.core, 'applyRefOnly', () => { crash = true; });
    value.core.updateRef = async (...args: unknown[]) => {
      if (crash) throw new Error('simulated crash before ref update');
      return await originalUpdateRef(...args);
    };

    await writeFile(join(value.vaultDir, 'a.md'), 'a1 local\n');
    await expect(settle(value.plugin)).rejects.toThrow('simulated crash before ref update');
    const journal = JSON.parse(await readFile(join(value.vaultDir, '.obts', 'apply-journal.json'), 'utf8'));
    const main = await currentMain(value.server);
    expect(journal).toMatchObject({ phase: 'committed', target_main: main, affected_paths: [], touched_paths: [], recovery_bundle_id: null });

    const restarted = new ObtsPluginClient(value.vaultDir, { serverUrl: value.baseUrl, deviceName: 'ref-only-device' });
    await restarted.initialize();
    expect((await settle(restarted)).at(-1)).toBe('Synced');
    await expectSettledAt(value, coreOf(restarted), main);
    expect(await readFile(join(value.vaultDir, 'a.md'), 'utf8')).toBe('a1 local\n');
  });
});
