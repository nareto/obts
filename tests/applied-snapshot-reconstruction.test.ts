import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../obsidian-plugin/src/core/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import type { MetadataDb } from '../src/server/metadataStore.js';

type Json = Record<string, unknown>;

class BrowserSession {
  cookie = '';
  csrf = '';

  constructor(private readonly baseUrl: string) {}

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
    this.captureCookie(response);
    const parsed = (await response.json()) as T;
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') {
      this.csrf = parsed.csrf_token;
    }
    return { status: response.status, body: parsed };
  }

  private captureCookie(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
    const cookiePairs = setCookies.map((cookie) => cookie.split(';')[0]).filter(Boolean);
    if (cookiePairs.length > 0) {
      this.cookie = cookiePairs.join('; ');
    }
  }
}

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function setupAdminAndVault(baseUrl: string): Promise<BrowserSession & { vaultId: string }> {
  const admin = new BrowserSession(baseUrl) as BrowserSession & { vaultId: string };
  const setup = await admin.post<{ user_id: string; csrf_token: string }>('/api/v1/setup', {
    username: 'admin',
    password: 'admin-password-1234',
    display_name: 'Admin'
  }, false);
  expect(setup.status).toBe(201);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', {
    display_name: 'Main Vault'
  });
  expect(vault.status).toBe(201);
  admin.vaultId = vault.body.vault_id;
  return admin;
}

async function pairPlugin(
  admin: BrowserSession & { vaultId: string },
  baseUrl: string,
  vaultDir: string,
  deviceName: string
): Promise<ObtsPluginClient> {
  const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName });
  const connection = await plugin.startOnboarding('Test Vault');
  const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
    selection: 'existing_vault',
    vault_id: admin.vaultId
  });
  expect(approval.status).toBe(200);
  const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  await plugin.finishOnboarding({
    connectionId: connection.connection_id,
    secret: connection.connection_secret,
    analysis,
    mode: 'use_server'
  });
  return plugin;
}

type StuckState = {
  server: ObtsServer;
  writer: ObtsPluginClient;
  waiter: ObtsPluginClient;
  waiterDir: string;
  writerDir: string;
  deviceId: string;
  baselineMain: string;
  baselineEventSeq: number;
  baselineDirs: string[] | null;
  appliedMain: string;
  appliedEventSeq: number;
};

async function waiterDeviceRow(server: ObtsServer): Promise<MetadataDb['devices'][number]> {
  const db = await server.store.snapshot();
  const device = db.devices.find((candidate) => candidate.device_name === 'waiter-device');
  if (!device) throw new Error('waiter device disappeared');
  return device;
}

async function createStuckAckState(): Promise<StuckState> {
  const root = await mkdtemp(join(tmpdir(), 'obts-ack-reconstruction-'));
  roots.push(root);
  const server = await createObtsServer({
    dataDir: join(root, 'data'),
    sessionSecret: 'ack-reconstruction-secret-with-entropy'
  });
  servers.push(server);
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = await setupAdminAndVault(baseUrl);
  const writerDir = join(root, 'writer-device');
  const waiterDir = join(root, 'waiter-device');
  const writer = await pairPlugin(admin, baseUrl, writerDir, 'writer-device');
  const waiter = await pairPlugin(admin, baseUrl, waiterDir, 'waiter-device');
  expect((await waiter.syncOnce()).status).toBe('Synced');

  const baseline = await waiterDeviceRow(server);
  const baselineMain = baseline.last_applied_main;
  const baselineEventSeq = baseline.last_applied_event_seq;
  const baselineDirs = baseline.last_applied_explicit_dirs === null ? null : [...baseline.last_applied_explicit_dirs];
  expect(baselineMain).toBeTruthy();

  // The waiter's acknowledgement transport fails after a successful local apply:
  // the pending acknowledgement file survives, but the server never advances.
  const waiterCore = (waiter as unknown as { client: Record<string, ((...args: unknown[]) => unknown) | undefined> }).client;
  const completeFn = waiterCore.completePendingAppliedAcknowledgement;
  if (!completeFn) throw new Error('client is missing completePendingAppliedAcknowledgement');
  const originalComplete = completeFn.bind(waiterCore);
  let failAcknowledgement = true;
  waiterCore.completePendingAppliedAcknowledgement = async (...args: unknown[]) => {
    if (failAcknowledgement) throw new Error('simulated acknowledgement transport failure');
    return await originalComplete(...args);
  };

  await writeFile(join(writerDir, 'remote-a.md'), 'writer change a\n');
  expect((await writer.syncOnce()).status).toBe('Synced');
  await expect(waiter.syncOnce()).rejects.toThrow('simulated acknowledgement transport failure');
  waiterCore.completePendingAppliedAcknowledgement = originalComplete;

  const stuck = await waiterDeviceRow(server);
  expect(stuck.last_applied_main).toBe(baseline.last_applied_main);
  expect(stuck.last_applied_event_seq).toBe(baselineEventSeq);
  const pendingAck = JSON.parse(await readFile(join(waiterDir, '.obts', 'pending-applied-ack.json'), 'utf8')) as Json;
  expect(pendingAck.target_main).toBeTruthy();
  expect(pendingAck.target_main).not.toBe(baselineMain);

  // Writer advances canonical main again.
  await writeFile(join(writerDir, 'remote-b.md'), 'writer change b\n');
  expect((await writer.syncOnce()).status).toBe('Synced');
  const vault = (await server.store.snapshot()).vaults[0];
  if (!vault) throw new Error('vault disappeared');
  const advancedMain = vault.current_main;
  expect(advancedMain).not.toBe(baseline.last_applied_main);

  // Simulate the production overwrite: a newer pull replaced the single delivered
  // snapshot slot before the waiter could acknowledge the applied main.
  const eventSeqNow = (await server.store.snapshot()).event_seq_by_vault[vault.vault_id] ?? 0;
  await server.store.mutate((db) => {
    const device = db.devices.find((candidate) => candidate.device_id === baseline.device_id);
    if (!device) throw new Error('waiter device disappeared');
    device.pending_applied_main = advancedMain;
    device.pending_applied_event_seq = eventSeqNow;
    device.pending_applied_explicit_dirs = ['Overwritten Dir'];
  });

  return {
    server,
    writer,
    waiter,
    waiterDir,
    writerDir,
    deviceId: baseline.device_id,
    baselineMain: baseline.last_applied_main as string,
    baselineEventSeq,
    baselineDirs,
    appliedMain: pendingAck.target_main as string,
    appliedEventSeq: pendingAck.event_seq as number
  };
}

describe('applied snapshot reconstruction', () => {
  it('acknowledges an interrupted apply after a newer pull replaced the delivered snapshot', async () => {
    const stuck = await createStuckAckState();
    expect(stuck.appliedMain).not.toBe(stuck.baselineMain);

    const result = await stuck.waiter.syncOnce();
    expect(result.status).toBe('Synced');

    const db = await stuck.server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === stuck.deviceId);
    const settledMain = db.vaults[0]?.current_main;
    expect(settledMain).toBeDefined();
    expect(device).toMatchObject({
      status: 'synced',
      last_applied_main: settledMain
    });
    expect(await stat(join(stuck.waiterDir, 'remote-a.md'))).toBeTruthy();
    expect(await stat(join(stuck.waiterDir, 'remote-b.md'))).toBeTruthy();
    await expect(stat(join(stuck.waiterDir, '.obts', 'pending-applied-ack.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed without partial acknowledgement when event evidence is unavailable', async () => {
    const stuck = await createStuckAckState();

    await stuck.server.store.mutate((db) => {
      const vaultId = db.vaults[0]?.vault_id;
      if (!vaultId) throw new Error('vault disappeared');
      const from = stuck.baselineEventSeq;
      const through = db.events.find((event) =>
        event.vault_id === vaultId && event.event_type === 'main_advanced' && event.commit_cursors?.main === stuck.appliedMain
      )?.event_seq ?? stuck.appliedEventSeq;
      db.events = db.events.filter((event) =>
        !(event.vault_id === vaultId && event.event_seq > from && event.event_seq <= through));
    });

    await expect(stuck.waiter.syncOnce()).rejects.toMatchObject({ code: 'applied_snapshot_unavailable' });

    const db = await stuck.server.store.snapshot();
    const device = db.devices.find((candidate) => candidate.device_id === stuck.deviceId);
    expect(device?.last_applied_main).toBe(stuck.baselineMain);
    expect(device?.last_applied_event_seq).toBe(stuck.baselineEventSeq);
    expect(device?.pending_applied_main).not.toBe(stuck.baselineMain);
    expect(device?.pending_applied_explicit_dirs).toEqual(['Overwritten Dir']);
    expect(await readFile(join(stuck.waiterDir, '.obts', 'pending-applied-ack.json'))).toBeTruthy();
    expect(await readFile(join(stuck.waiterDir, 'remote-a.md'), 'utf8')).toBe('writer change a\n');
  });
});
