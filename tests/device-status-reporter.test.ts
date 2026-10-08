import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { createSyncCostFixture, tickUntilSettled, writeNote } from './helpers/syncCostHarness.js';

const { createDeviceStatusReporter, DEVICE_STATUS_HEARTBEAT_MS } = createRequire(import.meta.url)('../obsidian-plugin/src/device-status-reporter.cjs') as any;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('single-flight latest-wins device status transport', () => {
  it('sends one in-flight request then only the latest pending status', async () => {
    const gate = deferred();
    const labels: string[] = [];
    const reporter = createDeviceStatusReporter({ send: async (snapshot: any) => {
      labels.push(snapshot.signature);
      if (labels.length === 1) await gate.promise;
    } });
    reporter.request({ signature: 'Checking' });
    await Promise.resolve();
    reporter.request({ signature: 'Uploading' });
    reporter.request({ signature: 'Synced' });
    expect(labels).toEqual(['Checking']);
    gate.resolve();
    await reporter.flush();
    expect(labels).toEqual(['Checking', 'Synced']);
  });

  it('deduplicates accepted idle status until the two-minute heartbeat', async () => {
    let now = 0;
    const send = vi.fn(async () => undefined);
    const reporter = createDeviceStatusReporter({ send, now: () => now });
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    for (now = 10_000; now < DEVICE_STATUS_HEARTBEAT_MS; now += 10_000) {
      reporter.request({ signature: 'Synced' });
      await reporter.flush();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(DEVICE_STATUS_HEARTBEAT_MS).toBe(120_000);
    expect(reporter.heartbeatDue()).toBe(true);
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('backs off failures across changing payloads without rejecting callers', async () => {
    let now = 0;
    const send = vi.fn(async () => { throw new Error('synthetic transport failure'); });
    const reporter = createDeviceStatusReporter({ send, now: () => now });
    reporter.request({ signature: 'Checking' });
    await reporter.flush();
    now = 10_000;
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    now = 30_000;
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(2);
    now = 89_999;
    reporter.request({ signature: 'Changed again' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(2);
    now = 90_000;
    reporter.request({ signature: 'Changed again' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(3);
  });
});

async function clientFixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-status-mailbox-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'Synthetic' });
  const core = plugin.client as any;
  let token = 'synthetic-credential';
  let state: any = { vault_id: 'vlt_synthetic', device_id: 'dev_synthetic', device_name: 'Synthetic',
    status_label: 'Synced', last_error_code: null, local_main: null, local_head: null, updated_at: new Date().toISOString() };
  core.readState = async () => ({ ...state });
  core.readQueue = async () => ({ status: 'idle' });
  core.readDeviceToken = async () => token;
  core.writeState = vi.fn(async (next: any) => { state = next; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: 'active', plugin: {} }), { status: 200 })));
  return { plugin, core, state: () => state, change: (patch: any) => { state = { ...state, ...patch }; },
    rotate: () => { token = 'new-synthetic-credential'; } };
}

describe('status feedback at local ownership boundaries', () => {
  it('does not await transport or write state in the background; consumes integrity feedback at the next boundary', async () => {
    const f = await clientFixture();
    const gate = deferred();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: 'blocked_integrity', plugin: {} }), { status: 200 });
    }));
    await f.core.reportDeviceStatus();
    expect(f.state().last_error_code).toBeNull();
    gate.resolve();
    await f.core.deviceStatusReporter.flush();
    expect(f.core.writeState).not.toHaveBeenCalled();
    expect(f.state().last_error_code).toBeNull();
    await f.core.reportDeviceStatus();
    expect(f.state().last_error_code).toBe('blocked_integrity');
    await f.core.flushDeviceStatusReports();
  });

  it('does not apply a response older than the last applied request', async () => {
    const f = await clientFixture();
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    const older = { ...f.core.pendingDeviceStatusResponse, result: { device_name: 'Old', vault_status: 'blocked_integrity' } };
    await f.core.consumeDeviceStatusResponse();
    f.change({ status_label: 'Checking' });
    await f.core.reportDeviceStatus();
    await f.core.flushDeviceStatusReports();
    f.core.pendingDeviceStatusResponse = older;
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBeNull();
    expect(f.state().device_name).toBe('Synthetic');
  });

  it.each(['vault', 'device', 'credential', 'generation', 'name', 'server'])('discards delayed feedback after %s identity changes', async (kind) => {
    const f = await clientFixture();
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    f.core.pendingDeviceStatusResponse.result.vault_status = 'blocked_integrity';
    if (kind === 'vault') f.change({ vault_id: 'vlt_other' });
    if (kind === 'device') f.change({ device_id: 'dev_other' });
    if (kind === 'credential') f.rotate();
    if (kind === 'generation') f.core.deviceStatusGeneration++;
    if (kind === 'name') f.core.plugin.deviceNameRevision++;
    if (kind === 'server') f.plugin.settings.serverUrl = 'http://127.0.0.1:2';
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBeNull();
    expect(f.core.writeState).not.toHaveBeenCalled();
  });

  it('does not let an older healthy response clear a newer integrity block', async () => {
    const f = await clientFixture();
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    f.change({ status_label: 'Out of sync', last_error_code: 'blocked_integrity' });
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBe('blocked_integrity');
    expect(f.core.writeState).not.toHaveBeenCalled();
  });

  it('drops pending telemetry on unload without applying delayed feedback', async () => {
    const f = await clientFixture();
    f.plugin.unloaded = true;
    await f.core.reportDeviceStatus();
    await f.core.flushDeviceStatusReports();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.core.writeState).not.toHaveBeenCalled();
  });

  it('supports an explicit exit/test flush that consumes feedback', async () => {
    const f = await clientFixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Renamed', vault_status: 'active', plugin: {} }), { status: 200 })));
    await f.core.reportDeviceStatus();
    expect(f.state().device_name).toBe('Synthetic');
    await f.core.flushDeviceStatusReports();
    expect(f.state().device_name).toBe('Renamed');
  });

  it('never sends an older capture that finishes after a newer status snapshot', async () => {
    const f = await clientFixture();
    const gate = deferred();
    const originalRead = f.core.readState;
    let first = true;
    f.core.readState = async () => {
      const state = await originalRead();
      if (first) { first = false; await gate.promise; }
      return state;
    };
    const older = f.core.reportDeviceStatus();
    await Promise.resolve();
    f.change({ status_label: 'Uploading' });
    await f.core.reportDeviceStatus();
    gate.resolve();
    await older;
    await f.core.flushDeviceStatusReports();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).local_status_label).toBe('Uploading');
  });
});

it('finishes a real shared-headless own-push tick while status transport remains held', async () => {
  const f = await createSyncCostFixture(40);
  const gate = deferred();
  const core = f.reader.client as any;
  await core.flushDeviceStatusReports();
  const send = vi.spyOn(core, 'sendDeviceStatus').mockImplementation(async () => await gate.promise);
  try {
    const path = await writeNote(f.readerDir, 7, 'synthetic slow-status edit\n');
    expect((await tickUntilSettled(f.reader, [path])).at(-1)).toMatch(/:Synced$/u);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await f.reader.readQueue()).pending_commit).toBeNull();
    gate.resolve();
    await core.flushDeviceStatusReports();
    const snapshots = send.mock.calls.map((call: any[]) => call[0]);
    expect(JSON.parse(snapshots.at(-1).body).local_status_label).toBe('Synced');
  } finally {
    gate.resolve();
    await core.flushDeviceStatusReports();
    send.mockRestore();
    await f.close();
  }
}, 120_000);
