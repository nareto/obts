import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../obsidian-plugin/src/core/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

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

type ClientInternals = { client: Record<string, ((...args: unknown[]) => unknown) | undefined> };

function internalsOf(plugin: ObtsPluginClient): Record<string, (...args: unknown[]) => unknown> {
  const client = (plugin as unknown as ClientInternals).client;
  if (!client) throw new Error('plugin client internals are unavailable');
  return client as Record<string, (...args: unknown[]) => unknown>;
}

async function waiterDeviceRow(server: ObtsServer): Promise<Record<string, unknown>> {
  const db = await server.store.snapshot();
  const device = db.devices.find((candidate) => candidate.device_name === 'waiter-device');
  if (!device) throw new Error('waiter device disappeared');
  return JSON.parse(JSON.stringify(device)) as Record<string, unknown>;
}

describe('pending applied acknowledgement barrier', () => {
  it('does not pull newer state while a pending acknowledgement cannot settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-ack-barrier-'));
    roots.push(root);
    const server = await createObtsServer({
      dataDir: join(root, 'data'),
      sessionSecret: 'ack-barrier-secret-with-entropy'
    });
    servers.push(server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const admin = await setupAdminAndVault(baseUrl);
    const writerDir = join(root, 'writer-device');
    const waiterDir = join(root, 'waiter-device');
    const writer = await pairPlugin(admin, baseUrl, writerDir, 'writer-device');
    const waiter = await pairPlugin(admin, baseUrl, waiterDir, 'waiter-device');
    expect((await waiter.syncOnce()).status).toBe('Synced');

    const waiterCore = (waiter as unknown as ClientInternals).client as Record<string, ((...args: unknown[]) => unknown) | undefined>;
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

    const appliedRow = await waiterDeviceRow(server);
    const appliedMain = appliedRow.pending_applied_main as string;
    expect(appliedMain).toBeTruthy();
    expect(await readFile(join(waiterDir, '.obts', 'pending-applied-ack.json'))).toBeTruthy();

    await writeFile(join(writerDir, 'remote-b.md'), 'writer change b\n');
    expect((await writer.syncOnce()).status).toBe('Synced');

    // The unsettled acknowledgement must stop the automatic poll before it
    // pulls the newer main: a newer pull would replace the delivered snapshot
    // evidence and permanently block the retry.
    await expect(waiter.pollRemoteEventsAndApply()).rejects.toThrow('simulated acknowledgement transport failure');
    const blockedRow = await waiterDeviceRow(server);
    expect(blockedRow.pending_applied_main).toBe(appliedMain);
    expect(await readFile(join(waiterDir, '.obts', 'pending-applied-ack.json'))).toBeTruthy();

    waiterCore.completePendingAppliedAcknowledgement = originalComplete;
    const result = await waiter.pollRemoteEventsAndApply();
    expect(result.status).toBe('Synced');
    const db = await server.store.snapshot();
    const settled = db.devices.find((candidate) => candidate.device_name === 'waiter-device');
    expect(settled).toMatchObject({
      status: 'synced',
      last_applied_main: db.vaults[0]?.current_main
    });
    expect(await stat(join(waiterDir, 'remote-b.md'))).toBeTruthy();
    await expect(stat(join(waiterDir, '.obts', 'pending-applied-ack.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
