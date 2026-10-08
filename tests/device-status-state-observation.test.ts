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
      expect(core.vaultStatusObservation).toBe(before + Number(changed));
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

  it('does not record an unpublished failed state transition', async () => {
    const core = await durableFixture();
    const state = await core.readState();
    const before = core.vaultStatusObservation;
    vi.spyOn(core.fsp, 'rename').mockRejectedValue(new Error('synthetic publication failure'));
    await expect(core.writeState({ ...state, last_error_code: 'blocked_integrity' })).rejects.toThrow('synthetic publication failure');
    expect(core.vaultStatusObservation).toBe(before);
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
