import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function clientFixture(): Promise<ObtsPluginClient> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'obts-headless-maintenance-'));
  temporaryDirectories.push(vaultDir);
  return new ObtsPluginClient(vaultDir, {
    serverUrl: 'http://127.0.0.1:9',
    deviceName: 'headless-test'
  });
}

describe('headless maintenance scheduling', () => {
  it('polls remote events without synchronizing an idle client', async () => {
    const client = await clientFixture();
    const internal = client.client as any;
    internal.readQueue = vi.fn(async () => ({
      pending_commit: null,
      expected_device_ref: null,
      status: 'idle',
      attempts: 0,
      changed_paths: [],
      updated_at: new Date().toISOString()
    }));
    internal.backgroundScanDecision = vi.fn(async () => ({ required: false, mode: 'none' }));
    internal.pollRemoteEventsAndApply = vi.fn(async () => ({ applied: false, status: 'Synced' }));
    internal.syncOnce = vi.fn(async () => ({ status: 'Synced' }));
    internal.readState = vi.fn(async () => ({ status_label: 'Synced', local_head: 'a'.repeat(40) }));

    const result = await client.maintenanceTick();

    expect(result).toMatchObject({ applied: false, sync_performed: false, scan_mode: 'none' });
    expect(internal.pollRemoteEventsAndApply).toHaveBeenCalledOnce();
    expect(internal.syncOnce).not.toHaveBeenCalled();
  });

  it('runs one full audit when the shared scanner requires it', async () => {
    const client = await clientFixture();
    const internal = client.client as any;
    internal.readQueue = vi.fn(async () => ({ pending_commit: null, status: 'idle' }));
    internal.backgroundScanDecision = vi.fn(async () => ({ required: true, mode: 'full' }));
    internal.pollRemoteEventsAndApply = vi.fn();
    internal.syncOnce = vi.fn(async () => ({ status: 'Synced' }));
    internal.readState = vi.fn(async () => ({ status_label: 'Synced', local_head: 'b'.repeat(40) }));

    const result = await client.maintenanceTick();

    expect(result.sync_performed).toBe(true);
    expect(internal.syncOnce).toHaveBeenCalledWith({ fullAudit: true });
    expect(internal.pollRemoteEventsAndApply).not.toHaveBeenCalled();
  });

  it('builds index deltas from tree metadata without reading blobs', async () => {
    const client = await clientFixture();
    const internal = client.client as any;
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    internal.readState = vi.fn(async () => ({ local_head: head }));
    internal.commitExists = vi.fn(async () => true);
    internal.isAncestor = vi.fn(async () => true);
    internal.listTreeBlobOids = vi.fn(async (commit: string) => commit === head
      ? new Map([['Notes/test.md', 'c'.repeat(40)]])
      : new Map([['Notes/test.md', 'd'.repeat(40)]]));
    internal.readBlobOid = vi.fn(() => {
      throw new Error('blob content must not be read');
    });

    const delta = await client.readIndexDelta(base);

    expect(delta).toEqual({
      head,
      base,
      mode: 'incremental',
      files: [{ path: 'Notes/test.md', oid: 'c'.repeat(40) }],
      changes: [{ path: 'Notes/test.md', kind: 'modify', oid: 'c'.repeat(40) }]
    });
    expect(internal.readBlobOid).not.toHaveBeenCalled();
  });
});
