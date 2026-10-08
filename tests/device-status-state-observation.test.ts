import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';
import { createSyncCostFixture } from './helpers/syncCostHarness.js';

const roots: string[] = [];
const clients: any[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (core) => await core.deviceStatusReporter.flush()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function holdStatePublications(core: any, beforeRename = false) {
  const createHold = () => ({ entered: deferred(), release: deferred() });
  const holds = [createHold(), createHold()] as const;
  const rename = core.fsp.rename.bind(core.fsp);
  let ordinal = 0;
  vi.spyOn(core.fsp, 'rename').mockImplementation(async (...args: any[]) => {
    const hold = args[1] === core.statePath ? holds[ordinal++] : undefined;
    if (!beforeRename) await rename(...args);
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    if (beforeRename) await rename(...args);
  });
  return holds;
}

async function durableFixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-status-state-'));
  roots.push(root);
  await mkdir(join(root, '.obts'));
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'Synthetic' });
  const core = plugin.client as any;
  clients.push(core);
  await core.writeState({ ...await core.readState(), vault_id: 'vlt_synthetic', device_id: 'dev_synthetic',
    device_name: 'Synthetic', status_label: 'Synced' });
  core.readDeviceToken = async () => 'synthetic-credential';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: 'blocked_integrity', plugin: {} }), { status: 200 })));
  return core;
}

describe('durable client state integrity observations', () => {
  it('counts every writer transition across integrity blocking, but not unrelated or repeated writes', async () => {
    const core = await durableFixture();
    for (const [code, changed] of [
      [null, false], ['invalid_path', false], ['blocked_integrity', true],
      ['blocked_integrity', false], ['invalid_path', true], [null, false]
    ] as const) {
      const state = await core.readState();
      const before = core.vaultStatusObservation;
      await core.writeState({ ...state, last_error_code: code });
      expect(core.vaultStatusObservation).toBe(before + 2 * Number(changed));
      expect((await core.readState()).last_error_code).toBe(code);
    }
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    await core.writeState({ ...state, device_name: 'Renamed' });
    expect(core.vaultStatusObservation).toBe(before);
  });

  it('keeps exact adapter costs for a mixed read and state-write sequence', async () => {
    const methods = ['readBinary', 'readBinaryRange', 'writeBinary', 'writeBinaryExclusive', 'stat', 'list',
      'mkdir', 'remove', 'rmdir', 'rename', 'syncFile', 'syncDirectory', 'exists', 'read', 'write'] as const;
    const spies = methods.map((method) => [method, vi.spyOn(NodeDataAdapter.prototype, method)] as const);
    const core = await durableFixture();
    for (const [, spy] of spies) spy.mockClear();
    for (const code of [null, 'blocked_integrity', 'blocked_integrity', 'invalid_path', null, 'blocked_integrity', null]) {
      await core.writeState({ ...await core.readState(), last_error_code: code, status_label: 'Checking' });
    }
    await core.readState();
    await core.writeState({ ...await core.readState(), device_name: 'Renamed' });
    const counts = Object.fromEntries(spies.map(([method, spy]) => [method, spy.mock.calls.length]));
    console.log('state-writer adapter counts', counts);
    expect(counts).toEqual({ readBinary: 42, readBinaryRange: 0, writeBinary: 16, writeBinaryExclusive: 0,
      stat: 48, list: 0, mkdir: 0, remove: 8, rmdir: 0, rename: 16, syncFile: 8, syncDirectory: 8,
      exists: 0, read: 0, write: 0 });
  });

  it('invalidates feedback and preserves uncertainty after a rename failure and subsequent reads', async () => {
    const core = await durableFixture();
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    const rename = vi.spyOn(core.fsp, 'rename').mockRejectedValue(new Error('synthetic publication failure'));
    await expect(core.writeState({ ...state, last_error_code: 'blocked_integrity' })).rejects.toThrow('synthetic publication failure');
    expect(core.vaultStatusObservation).toBe(before + 2);
    expect(core.stateIntegrityBlocked).toBeNull();
    expect(core.stateIntegrityUncertain).toBe(true);
    expect(core.statePublicationsInFlight).toBe(0);
    expect((await core.readState()).last_error_code).toBeNull();
    expect((await core.readPrimaryState()).last_error_code).toBeNull();
    expect(core.stateIntegrityBlocked).toBeNull();
    expect(core.stateIntegrityUncertain).toBe(true);
    expect(core.vaultStatusObservation).toBe(before + 2);
    rename.mockRestore();
    await core.writeState(state);
    expect(core.vaultStatusObservation).toBe(before + 4);
    expect(core.stateIntegrityBlocked).toBe(false);
    expect(core.stateIntegrityUncertain).toBe(false);
  });

  it('invalidates feedback even when a failed write intended no integrity transition', async () => {
    const core = await durableFixture();
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    vi.spyOn(core.fsp, 'writeFile').mockRejectedValue(new Error('synthetic staging failure'));
    await expect(core.writeState({ ...state, device_name: 'Renamed' })).rejects.toThrow('synthetic staging failure');
    expect(core.vaultStatusObservation).toBe(before + 1);
    expect(core.stateIntegrityBlocked).toBeNull();
    expect(core.stateIntegrityUncertain).toBe(true);
    expect(core.statePublicationsInFlight).toBe(0);
  });

  it('rejects pending blocked feedback after rename succeeds but directory sync fails', async () => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    await core.reportDeviceStatus();
    await core.deviceStatusReporter.flush();
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    const rename = vi.spyOn(core.fsp, 'rename');
    const entered = deferred();
    const gate = deferred();
    const sync = vi.spyOn(core.fsp, 'syncDirectory').mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('synthetic directory sync failure');
    });
    const write = core.writeState({ ...state, last_error_code: null });
    const rejected = expect(write).rejects.toThrow('synthetic directory sync failure');
    await entered.promise;
    try {
      await core.reportDeviceStatus();
      await core.deviceStatusReporter.flush();
      expect(core.pendingDeviceStatusResponse.result.vault_status).toBe('blocked_integrity');
      expect(core.pendingDeviceStatusResponse.snapshot.vaultStatusObservation).toBe(before + 1);
    } finally { gate.resolve(); await rejected; }
    expect(rename).toHaveBeenCalledWith(expect.any(String), core.statePath);
    expect(core.vaultStatusObservation).toBe(before + 2);
    expect(core.stateIntegrityBlocked).toBeNull();
    expect(core.stateIntegrityUncertain).toBe(true);
    const reconcile = vi.spyOn(core, 'reconcileServerVaultStatus');
    await core.consumeDeviceStatusResponse();
    expect(reconcile).not.toHaveBeenCalled();
    expect((await core.readState()).last_error_code).toBeNull();
    expect(core.stateIntegrityBlocked).toBeNull();
    expect(core.stateIntegrityUncertain).toBe(true);
    sync.mockRestore();
    await core.writeState({ ...await core.readState(), status_label: 'Checking' });
    expect(core.vaultStatusObservation).toBe(before + 4);
    expect(core.stateIntegrityUncertain).toBe(false);
  });

  it.each([false, true])('rejects feedback consumed during a crossing, captured during publication: %s', async (captureDuring) => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const state = await core.readState();
    if (!captureDuring) {
      await core.reportDeviceStatus();
      await core.deviceStatusReporter.flush();
    }
    const before = core.vaultStatusObservation;
    const [hold] = holdStatePublications(core, true);
    const write = core.writeState({ ...state, last_error_code: null });
    await hold.entered.promise;
    try {
      if (captureDuring) {
        await core.reportDeviceStatus();
        await core.deviceStatusReporter.flush();
        expect(core.pendingDeviceStatusResponse.snapshot.vaultStatusObservation).toBe(core.vaultStatusObservation);
      }
      const reconcile = vi.spyOn(core, 'reconcileServerVaultStatus');
      await core.consumeDeviceStatusResponse();
      expect(reconcile).not.toHaveBeenCalled();
      expect(core.vaultStatusObservation).toBe(before + 1);
      expect(core.stateIntegrityBlocked).toBeNull();
      expect(core.stateIntegrityUncertain).toBe(true);
    } finally { hold.release.resolve(); await write; }
    expect((await core.readState()).last_error_code).toBeNull();
    expect(core.vaultStatusObservation).toBe(before + 2);
  });

  it('rejects a snapshot captured during a crossing after successful settlement', async () => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const state = await core.readState();
    const [hold] = holdStatePublications(core);
    const write = core.writeState({ ...state, last_error_code: null });
    await hold.entered.promise;
    let during;
    try {
      await core.reportDeviceStatus();
      await core.deviceStatusReporter.flush();
      during = core.pendingDeviceStatusResponse.snapshot.vaultStatusObservation;
      expect(core.stateIntegrityBlocked).toBeNull();
      expect(core.stateIntegrityUncertain).toBe(true);
    } finally { hold.release.resolve(); await write; }
    expect(core.vaultStatusObservation).toBe(during + 1);
    expect(core.stateIntegrityUncertain).toBe(false);
    const reconcile = vi.spyOn(core, 'reconcileServerVaultStatus');
    await core.consumeDeviceStatusResponse();
    expect(reconcile).not.toHaveBeenCalled();
    expect((await core.readState()).last_error_code).toBeNull();
  });

  it.each([false, true])('retains uncertainty until opposite-order overlapping publications settle, initially blocked: %s', async (initiallyBlocked) => {
    const core = await durableFixture();
    if (initiallyBlocked) await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const state = await core.readState();
    const [first, second] = holdStatePublications(core);
    const firstWrite = core.writeState({ ...state, last_error_code: null });
    await first.entered.promise;
    const secondWrite = core.writeState({ ...state, last_error_code: 'blocked_integrity' });
    await second.entered.promise;
    try {
      expect(core.statePublicationsInFlight).toBe(2);
      expect(core.stateIntegrityBlocked).toBeNull();
      expect(core.stateIntegrityUncertain).toBe(true);
      second.release.resolve();
      await secondWrite;
      expect(core.statePublicationsInFlight).toBe(1);
      expect((await core.readState()).last_error_code).toBe('blocked_integrity');
      expect(core.stateIntegrityBlocked).toBeNull();
      expect(core.stateIntegrityUncertain).toBe(true);
    } finally { first.release.resolve(); second.release.resolve(); await Promise.all([firstWrite, secondWrite]); }
    expect(core.statePublicationsInFlight).toBe(0);
    expect(core.stateIntegrityUncertain).toBe(false);
    expect(core.stateIntegrityBlocked).toBe(false);
    const before = core.vaultStatusObservation;
    await core.writeState({ ...state, last_error_code: null });
    expect(core.vaultStatusObservation).toBeGreaterThan(before);
    expect((await core.readState()).last_error_code).toBeNull();
  });

  it('keeps overlapping known healthy publications from advancing the epoch', async () => {
    const core = await durableFixture();
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    const [first, second] = holdStatePublications(core);
    const firstWrite = core.writeState({ ...state, device_name: 'First' });
    await first.entered.promise;
    const secondWrite = core.writeState({ ...state, device_name: 'Second' });
    await second.entered.promise;
    try {
      second.release.resolve();
      await secondWrite;
      expect(core.stateIntegrityBlocked).toBe(false);
      expect(core.stateIntegrityUncertain).toBe(false);
      expect(core.vaultStatusObservation).toBe(before);
    } finally { first.release.resolve(); second.release.resolve(); await Promise.all([firstWrite, secondWrite]); }
    expect(core.vaultStatusObservation).toBe(before);
    expect(core.statePublicationsInFlight).toBe(0);
  });

  it.each([false, true])('refreshes deferred feedback after a known non-crossing write, fails: %s', async (fails) => {
    const core = await durableFixture();
    await core.reportDeviceStatus();
    await core.deviceStatusReporter.flush();
    const originalBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    const sequence = core.pendingDeviceStatusResponse.snapshot.sequence;
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    const entered = deferred();
    const gate = deferred();
    const syncDirectory = core.fsp.syncDirectory.bind(core.fsp);
    let hold = true;
    const sync = vi.spyOn(core.fsp, 'syncDirectory').mockImplementation(async (...args: any[]) => {
      if (hold) {
        hold = false;
        entered.resolve();
        await gate.promise;
        if (fails) throw new Error('synthetic non-crossing sync failure');
      }
      await syncDirectory(...args);
    });
    const write = core.writeState(state);
    const settlement = fails ? expect(write).rejects.toThrow('synthetic non-crossing sync failure') : write;
    await entered.promise;
    const reconcile = vi.spyOn(core, 'reconcileServerVaultStatus');
    const compatibility = vi.spyOn(core.plugin, 'handlePluginCompatibility');
    try {
      expect(core.statePublicationsInFlight).toBe(1);
      expect(core.stateIntegrityBlocked).toBe(false);
      expect(core.stateIntegrityUncertain).toBe(false);
      expect(core.vaultStatusObservation).toBe(before);
      await core.consumeDeviceStatusResponse();
      expect(reconcile).not.toHaveBeenCalled();
      expect(compatibility).toHaveBeenCalledWith({});
      expect((await core.readState()).last_error_code).toBeNull();
      expect(core.pendingDeviceStatusResponse).toBeNull();
      expect(core.lastAppliedDeviceStatusSequence).toBe(sequence);
      expect(core.forceDeviceStatusReport).toBe(true);
    } finally { gate.resolve(); await settlement; }
    expect(core.statePublicationsInFlight).toBe(0);
    sync.mockRestore();
    if (fails) {
      expect(core.stateIntegrityUncertain).toBe(true);
      await core.writeState({ ...await core.readState(), status_label: 'Synced' });
    }
    expect(core.stateIntegrityUncertain).toBe(false);
    await core.reportDeviceStatusIfDue();
    await core.deviceStatusReporter.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(originalBody);
    expect(core.forceDeviceStatusReport).toBe(false);
    expect(core.pendingDeviceStatusResponse.snapshot.sequence).toBeGreaterThan(sequence);
    expect((await core.readState()).last_error_code).toBeNull();
    await core.reportDeviceStatusIfDue();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await core.readState()).last_error_code).toBe('blocked_integrity');
  });

  it('still deduplicates healthy steady state without an in-flight publication', async () => {
    const core = await durableFixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_name: 'Synthetic', vault_status: 'active', plugin: {} }), { status: 200 })));
    for (let boundary = 0; boundary < 4; boundary += 1) {
      await core.reportDeviceStatus();
      await core.deviceStatusReporter.flush();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(core.statePublicationsInFlight).toBe(0);
    expect(core.forceDeviceStatusReport).toBe(false);
    expect((await core.readState()).last_error_code).toBeNull();
  });

  it('does not lose a clear when a read sees it before publication finishes', async () => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    const entered = deferred();
    const gate = deferred();
    const rename = core.fsp.rename.bind(core.fsp);
    vi.spyOn(core.fsp, 'rename').mockImplementation(async (...args: any[]) => {
      await rename(...args);
      if (args[1] === core.statePath) { entered.resolve(); await gate.promise; }
    });
    const write = core.writeState({ ...state, last_error_code: null });
    await entered.promise;
    try {
      expect((await core.readState()).last_error_code).toBeNull();
    } finally { gate.resolve(); }
    await write;
    expect(core.vaultStatusObservation).toBeGreaterThan(before);
  });

  it('does not let a delayed old read overwrite the published integrity mirror', async () => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const state = await core.readState();
    const entered = deferred();
    const gate = deferred();
    const readFile = core.fsp.readFile.bind(core.fsp);
    let hold = true;
    vi.spyOn(core.fsp, 'readFile').mockImplementation(async (...args: any[]) => {
      const result = await readFile(...args);
      if (hold && args[0] === core.statePath) { hold = false; entered.resolve(); await gate.promise; }
      return result;
    });
    const oldRead = core.readState();
    await entered.promise;
    await core.writeState({ ...state, last_error_code: null });
    const afterClear = core.vaultStatusObservation;
    gate.resolve();
    expect((await oldRead).last_error_code).toBe('blocked_integrity');
    expect(core.stateIntegrityBlocked).toBe(false);
    expect(core.vaultStatusObservation).toBe(afterClear);
    await core.writeState({ ...state, last_error_code: null, device_name: 'Renamed' });
    expect(core.vaultStatusObservation).toBe(afterClear);
  });

  it('keeps healthy metadata writes from starving fresh blocked feedback', async () => {
    const core = await durableFixture();
    await core.reportDeviceStatus();
    await core.deviceStatusReporter.flush();
    const before = core.vaultStatusObservation;
    for (let index = 0; index < 4; index += 1) {
      await core.writeState({ ...await core.readState(), status_label: `Uploading ${index + 1}/4` });
    }
    expect(core.vaultStatusObservation).toBe(before);
    await core.consumeDeviceStatusResponse();
    expect((await core.readState()).last_error_code).toBe('blocked_integrity');
  });

  it('preserves the primary integrity error during backup cursor recovery', async () => {
    const core = await durableFixture();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity' });
    const primary = await core.readState();
    const before = core.vaultStatusObservation;
    await core.restoreRecoveredBackupState(primary, { ...primary, last_error_code: null });
    expect((await core.readState()).last_error_code).toBe('blocked_integrity');
    expect(core.vaultStatusObservation).toBe(before);
  });
});

it('ignores a mailboxed block after the direct syncOnce clear before local capture', async () => {
  const fixture = await createSyncCostFixture(40);
  const core = fixture.reader.client as any;
  const actualFetch = fetch;
  try {
    await core.flushDeviceStatusReports();
    await core.writeState({ ...await core.readState(), last_error_code: 'blocked_integrity', status_label: 'Server repair required' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/sync/device-status')) {
        return new Response(JSON.stringify({ device_name: 'cost-reader', vault_status: 'blocked_integrity', plugin: {} }), { status: 200 });
      }
      return await actualFetch(input, init);
    });
    await core.reportDeviceStatus();
    await core.deviceStatusReporter.flush();
    expect(core.pendingDeviceStatusResponse.result.vault_status).toBe('blocked_integrity');
    vi.spyOn(core, 'captureHintedLocalChanges').mockImplementation(async () => {
      expect((await core.readState()).last_error_code).toBeNull();
      throw new Error('stop-after-direct-clear');
    });
    await expect(fixture.reader.syncOnce({ hintedCapture: true })).rejects.toThrow('stop-after-direct-clear');
    expect((await core.readState()).last_error_code).toBeNull();
  } finally {
    await core.deviceStatusReporter.flush();
    await fixture.close();
  }
}, 120_000);
