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

  it('does not dedupe states awaiting server feedback, but still dedupes healthy status', async () => {
    const send = vi.fn(async () => undefined);
    const reporter = createDeviceStatusReporter({ send, now: () => 0 });
    for (let boundary = 0; boundary < 3; boundary += 1) {
      reporter.request({ signature: 'blocked', requiresServerFeedback: true });
      await reporter.flush();
      expect(reporter.heartbeatDue()).toBe(true);
    }
    expect(send).toHaveBeenCalledTimes(3);
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    reporter.request({ signature: 'Synced' });
    await reporter.flush();
    expect(send).toHaveBeenCalledTimes(4);
    expect(reporter.heartbeatDue()).toBe(false);
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

  it('keeps integrity feedback polling at idle boundaries and resumes at the next local boundary', async () => {
    const f = await clientFixture();
    f.change({ status_label: 'Server repair required', last_error_code: 'blocked_integrity' });
    let vaultStatus = 'blocked_integrity';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: vaultStatus, plugin: {} }), { status: 200 })));
    await f.core.reportDeviceStatus();
    await f.core.flushDeviceStatusReports();
    await f.core.reportDeviceStatusIfDue();
    await f.core.flushDeviceStatusReports();
    expect(fetch).toHaveBeenCalledTimes(2);
    vaultStatus = 'active';
    await f.core.reportDeviceStatusIfDue();
    await f.core.deviceStatusReporter.flush();
    expect(f.state().last_error_code).toBe('blocked_integrity');
    f.core.recordLocalChangeHint = vi.fn(async () => undefined);
    await f.core.reportDeviceStatusIfDue();
    await f.core.flushDeviceStatusReports();
    expect(f.state().last_error_code).toBeNull();
    expect(f.core.plugin.syncQueued).toBe(true);
    const accepted = vi.mocked(fetch).mock.calls.length;
    await f.core.reportDeviceStatus();
    await f.core.flushDeviceStatusReports();
    expect(fetch).toHaveBeenCalledTimes(accepted);
  });

  it('ignores delayed blocked feedback after a fresh repair without dropping name or compatibility feedback', async () => {
    const f = await clientFixture();
    f.change({ status_label: 'Server repair required', last_error_code: 'blocked_integrity' });
    f.core.recordLocalChangeHint = vi.fn(async () => undefined);
    const gate = deferred();
    const compatibility = { update_available: false };
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify({ device_name: 'Renamed', vault_status: 'blocked_integrity', plugin: compatibility }), { status: 200 });
    }));
    const compatibilityFeedback = vi.spyOn(f.core.plugin, 'handlePluginCompatibility');
    const markBlocked = vi.spyOn(f.core, 'markBlocked');
    await f.core.reportDeviceStatus();
    await f.core.reconcileServerVaultStatus('active', true);
    expect(f.state().last_error_code).toBeNull();
    gate.resolve();
    await f.core.deviceStatusReporter.flush();
    await f.core.consumeDeviceStatusResponse();
    expect(f.state()).toMatchObject({ last_error_code: null, device_name: 'Renamed' });
    expect(markBlocked).not.toHaveBeenCalled();
    expect(compatibilityFeedback).toHaveBeenCalledWith(compatibility);
    expect(f.core.plugin.syncQueued).toBe(true);
  });

  it.each([
    { initialError: null, response: 'blocked_integrity', facts: ['blocked_integrity', 'active'] },
    { initialError: 'blocked_integrity', response: 'active', facts: ['active', 'blocked_integrity'] }
  ])('rejects ABA vault feedback ending at $initialError', async ({ initialError, response, facts }) => {
    const f = await clientFixture();
    f.change({ last_error_code: initialError });
    f.core.recordLocalChangeHint = vi.fn(async () => undefined);
    const gate = deferred();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: response, plugin: {} }), { status: 200 });
    }));
    await f.core.reportDeviceStatus();
    const report = vi.spyOn(f.core, 'reportDeviceStatus').mockResolvedValue(undefined);
    for (const fact of facts) await f.core.reconcileServerVaultStatus(fact);
    report.mockRestore();
    expect(f.state().last_error_code).toBe(initialError);
    gate.resolve();
    await f.core.deviceStatusReporter.flush();
    expect(f.core.pendingDeviceStatusResponse.snapshot.reportedErrorCode).toBe(initialError);
    const writes = f.core.writeState.mock.calls.length;
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBe(initialError);
    expect(f.core.writeState).toHaveBeenCalledTimes(writes);
  });

  it.each([
    { initialError: null, response: 'blocked_integrity', fact: 'active' },
    { initialError: 'blocked_integrity', response: 'active', fact: 'blocked_integrity' }
  ])('records a fresh $fact observation even without a local error transition', async ({ initialError, response, fact }) => {
    const f = await clientFixture();
    f.change({ last_error_code: initialError });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: response, plugin: {} }), { status: 200 })));
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    await f.core.reconcileServerVaultStatus(fact);
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBe(initialError);
    expect(f.core.writeState).not.toHaveBeenCalled();
  });

  it('records repeated direct integrity blocks as newer facts', async () => {
    const f = await clientFixture();
    f.change({ last_error_code: 'blocked_integrity' });
    f.core.recordLocalChangeHint = vi.fn(async () => undefined);
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    const report = vi.spyOn(f.core, 'reportDeviceStatus').mockResolvedValue(undefined);
    await f.core.markBlocked('blocked_integrity');
    report.mockRestore();
    const writes = f.core.writeState.mock.calls.length;
    await f.core.consumeDeviceStatusResponse();
    expect(f.state().last_error_code).toBe('blocked_integrity');
    expect(f.core.writeState).toHaveBeenCalledTimes(writes);
  });

  it('checks vault freshness after awaiting name feedback', async () => {
    const f = await clientFixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: 'blocked_integrity', plugin: {} }), { status: 200 })));
    await f.core.reportDeviceStatus();
    await f.core.deviceStatusReporter.flush();
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(f.core, 'applyServerDeviceName').mockImplementation(async () => { entered.resolve(); await gate.promise; });
    const consume = f.core.consumeDeviceStatusResponse();
    await entered.promise;
    await f.core.reconcileServerVaultStatus('active', true);
    gate.resolve();
    await consume;
    expect(f.state().last_error_code).toBeNull();
    expect(f.core.writeState).not.toHaveBeenCalled();
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
