import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../obsidian-plugin/src/core/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
type Json = Record<string, unknown>;
type Fixture = {
  root: string;
  server: ObtsServer;
  baseUrl: string;
  vaultId: string;
  phone: ObtsPluginClient;
  phoneDir: string;
  writer: ObtsPluginClient;
  writerDir: string;
};

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
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') this.csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  }

  private captureCookie(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
    const cookiePairs = setCookies.map((cookie) => cookie.split(';')[0]).filter(Boolean);
    if (cookiePairs.length > 0) this.cookie = cookiePairs.join('; ');
  }
}

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function pairPlugin(
  admin: BrowserSession,
  vaultId: string,
  baseUrl: string,
  vaultDir: string,
  deviceName: string
): Promise<ObtsPluginClient> {
  const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName });
  const connection = await plugin.startOnboarding('Test Vault');
  const approval = await admin.post<{ status: string }>(`/api/v1/connections/${connection.connection_id}/approve`, {
    selection: 'existing_vault',
    vault_id: vaultId
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

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-directory-baseline-'));
  roots.push(root);
  const server = await createObtsServer({
    dataDir: join(root, 'data'),
    sessionSecret: 'directory-baseline-test-secret-with-entropy'
  });
  servers.push(server);
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = new BrowserSession(baseUrl);
  const setup = await admin.post<{ user_id: string; csrf_token: string }>('/api/v1/setup', {
    username: 'admin',
    password: 'admin-password-1234',
    display_name: 'Admin'
  }, false);
  expect(setup.status).toBe(201);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Main Vault' });
  expect(vault.status).toBe(201);
  const phoneDir = join(root, 'phone');
  const writerDir = join(root, 'writer');
  const phone = await pairPlugin(admin, vault.body.vault_id, baseUrl, phoneDir, 'phone');
  const writer = await pairPlugin(admin, vault.body.vault_id, baseUrl, writerDir, 'writer');
  expect((await phone.syncOnce()).status).toBe('Synced');
  expect((await writer.syncOnce()).status).toBe('Synced');
  return { root, server, baseUrl, vaultId: vault.body.vault_id, phone, phoneDir, writer, writerDir };
}

async function advancePhoneAcknowledgement(server: ObtsServer, vaultId: string, phone: ObtsPluginClient): Promise<void> {
  const phoneState = await phone.readState();
  const before = await server.store.snapshot();
  const currentMain = before.vaults.find((vault) => vault.vault_id === vaultId)?.current_main;
  const currentEventSeq = before.event_seq_by_vault[vaultId] ?? 0;
  if (!currentMain || !phoneState.device_id) throw new Error('test baseline is unavailable');
  await server.store.mutate((db) => {
    const device = db.devices.find((candidate) => candidate.device_id === phoneState.device_id);
    if (!device) throw new Error('phone device disappeared');
    device.last_applied_main = currentMain;
    device.last_applied_event_seq = currentEventSeq;
    device.last_applied_explicit_dirs = [...(db.directory_state_by_vault[vaultId]?.explicit_dirs ?? [])];
    device.pending_applied_main = null;
    device.pending_applied_event_seq = 0;
    device.pending_applied_explicit_dirs = null;
  });
}

async function queueLocalDirectoryWork(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.phoneDir, 'queued-local.md'), 'keep this queued change\n');
  await mkdir(join(fixture.phoneDir, 'Queued Empty Directory'));
}

async function expectQueuedWorkRejected(fixture: Fixture): Promise<void> {
  await queueLocalDirectoryWork(fixture);
  await expect(fixture.phone.syncOnce()).rejects.toMatchObject({ code: 'stale_directory_proposal_base' });
  const queue = await fixture.phone.readQueue();
  expect(queue.pending_commit).toMatch(/^[0-9a-f]{40}$/u);
  expect(await readFile(join(fixture.phoneDir, 'queued-local.md'), 'utf8')).toBe('keep this queued change\n');
}

describe('directory proposal cursor recovery', () => {
  it('syncs queued local work across a retained directory-neutral event gap', async () => {
    const fixture = await createFixture();
    const original = await fixture.phone.readState();
    const oldMain = original.local_main;
    const oldCursor = original.last_applied_event_seq;

    await writeFile(join(fixture.writerDir, 'remote.md'), 'remote canonical change\n');
    expect((await fixture.writer.syncOnce()).status).toBe('Synced');
    const after = await fixture.server.store.snapshot();
    const main = after.vaults.find((vault) => vault.vault_id === fixture.vaultId)?.current_main;
    const cursor = after.event_seq_by_vault[fixture.vaultId] ?? 0;
    expect(main).not.toBe(oldMain);
    expect(after.events.filter((event) => event.vault_id === fixture.vaultId && event.event_seq > oldCursor && event.event_seq <= cursor)
      .every((event) => !Array.isArray(event.payload.directory_intents) || event.payload.directory_intents.length === 0)).toBe(true);
    await advancePhoneAcknowledgement(fixture.server, fixture.vaultId, fixture.phone);
    await queueLocalDirectoryWork(fixture);

    expect((await fixture.phone.syncOnce()).status).toBe('Synced');
    expect(await readFile(join(fixture.phoneDir, 'queued-local.md'), 'utf8')).toBe('keep this queued change\n');
    expect(await readFile(join(fixture.phoneDir, 'remote.md'), 'utf8')).toBe('remote canonical change\n');
    const committed = await fixture.server.store.snapshot();
    const directoryState = committed.directory_state_by_vault[fixture.vaultId];
    expect(directoryState?.explicit_dirs).toContain('Queued Empty Directory');
    const proposalCount = committed.directory_proposal_results.filter((result) => result.device_id === original.device_id).length;
    const committedMain = committed.vaults.find((vault) => vault.vault_id === fixture.vaultId)?.current_main;

    expect((await fixture.phone.syncOnce()).status).toBe('Synced');
    const retried = await fixture.server.store.snapshot();
    expect(retried.directory_proposal_results.filter((result) => result.device_id === original.device_id)).toHaveLength(proposalCount);
    expect(retried.vaults.find((vault) => vault.vault_id === fixture.vaultId)?.current_main).toBe(committedMain);
  });

  it('keeps local queued work when a directory-changing event makes rebasing unsafe', async () => {
    const fixture = await createFixture();
    const phoneState = await fixture.phone.readState();
    const oldCursor = phoneState.last_applied_event_seq;
    await writeFile(join(fixture.writerDir, 'remote.md'), 'remote canonical change\n');
    await mkdir(join(fixture.writerDir, 'Remote Empty Directory'));
    expect((await fixture.writer.syncOnce()).status).toBe('Synced');
    const after = await fixture.server.store.snapshot();
    expect(after.events.some((event) => event.vault_id === fixture.vaultId && event.event_seq > oldCursor &&
      Array.isArray(event.payload.directory_intents) && event.payload.directory_intents.length > 0)).toBe(true);
    await advancePhoneAcknowledgement(fixture.server, fixture.vaultId, fixture.phone);

    await expectQueuedWorkRejected(fixture);
  });

  it('keeps local queued work when retained event history cannot prove neutrality', async () => {
    const fixture = await createFixture();
    const phoneState = await fixture.phone.readState();
    const oldCursor = phoneState.last_applied_event_seq;
    await writeFile(join(fixture.writerDir, 'remote.md'), 'remote canonical change\n');
    expect((await fixture.writer.syncOnce()).status).toBe('Synced');
    await advancePhoneAcknowledgement(fixture.server, fixture.vaultId, fixture.phone);
    const before = await fixture.server.store.snapshot();
    const through = before.event_seq_by_vault[fixture.vaultId] ?? 0;
    await fixture.server.store.mutate((db) => {
      db.events = db.events.filter((event) => event.vault_id !== fixture.vaultId ||
        event.event_seq <= oldCursor || event.event_seq > through);
    });

    await expectQueuedWorkRejected(fixture);
  });

  it('acknowledges the delivered snapshot instead of advancing it over a later neutral event', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.writerDir, 'remote.md'), 'remote canonical change\n');
    expect((await fixture.writer.syncOnce()).status).toBe('Synced');

    const phoneCore = (fixture.phone as unknown as {
      client: {
        completePendingAppliedAcknowledgement?: (
          pending: { target_main: string; event_seq: number },
          state?: unknown
        ) => Promise<void>;
      };
    }).client;
    const completeMethod = phoneCore.completePendingAppliedAcknowledgement;
    if (!completeMethod) throw new Error('client is missing completePendingAppliedAcknowledgement');
    const complete = completeMethod.bind(phoneCore);
    phoneCore.completePendingAppliedAcknowledgement = async () => {
      throw new Error('simulated acknowledgement transport failure');
    };
    try {
      await expect(fixture.phone.syncOnce()).rejects.toThrow('simulated acknowledgement transport failure');
    } finally {
      phoneCore.completePendingAppliedAcknowledgement = complete;
    }

    const pending = JSON.parse(await readFile(join(fixture.phoneDir, '.obts', 'pending-applied-ack.json'), 'utf8')) as {
      target_main: string;
      event_seq: number;
    };
    await fixture.server.store.mutate((db) => {
      fixture.server.store.appendEvent(db, {
        event_type: 'device_state_changed',
        vault_id: fixture.vaultId,
        resource_ids: { device_id: 'unrelated-device' },
        commit_cursors: { main: pending.target_main },
        payload: { status: 'paired' }
      });
    });
    const advancedCursor = (await fixture.server.store.snapshot()).event_seq_by_vault[fixture.vaultId] ?? 0;
    expect(advancedCursor).toBeGreaterThan(pending.event_seq);

    await complete(pending, await fixture.phone.readState());
    const acknowledged = (await fixture.server.store.snapshot()).devices.find((device) => device.device_name === 'phone');
    expect(acknowledged?.last_applied_main).toBe(pending.target_main);
    expect(acknowledged?.last_applied_event_seq).toBe(pending.event_seq);
  });
});
