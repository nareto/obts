import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient, PluginBlockedError } from '../src/client/core.js';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'obts-maintenance-report-'));
  roots.push(root);
  const client = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'maintenance-report' });
  const core = client.client as any;
  const state = {
    local_main: 'main-before', local_head: 'head-before', server_device_ref: 'device-before',
    status_label: 'Applying', last_error_code: 'apply_lock_active', last_error_details: null,
    last_event_seq: 7, last_applied_event_seq: 6, updated_at: '2026-01-01T00:00:00.000Z'
  };
  core.readQueue = vi.fn(async () => ({ pending_commit: null, status: 'idle' }));
  core.backgroundScanDecision = vi.fn(async () => ({ required: true, mode: 'incremental' }));
  core.readState = vi.fn(async () => state);
  return { client, core, state };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('maintenance catch-up failure reporting', () => {
  it('publishes only the fixed safe error and status without changing sync authority', async () => {
    const { client, core, state } = await setup();
    const error = new PluginBlockedError('catchup_local_changes', 'safe original error');
    core.syncOnce = vi.fn(async () => { throw error; });
    let published: Record<string, unknown> | null = null;
    core.writeState = vi.fn(async (next: Record<string, unknown>) => { published = next; });
    await expect(client.maintenanceTick()).rejects.toBe(error);
    expect(published).toMatchObject({
      local_main: state.local_main,
      local_head: state.local_head,
      server_device_ref: state.server_device_ref,
      status_label: 'Out of sync',
      last_error_code: 'catchup_local_changes',
      apply_validation_reason: null,
      last_error_details: null,
      last_event_seq: 7,
      last_applied_event_seq: 6
    });
    expect(core.writeState).toHaveBeenCalledTimes(1);
  });

  it('publishes unverified catch-up evidence as a fixed recovery-required status', async () => {
    const { client, core } = await setup();
    const error = new PluginBlockedError('catchup_recovery_required', 'unsafe details omitted');
    core.syncOnce = vi.fn(async () => { throw error; });
    let published: Record<string, unknown> | null = null;
    core.writeState = vi.fn(async (next: Record<string, unknown>) => { published = next; });
    await expect(client.maintenanceTick()).rejects.toBe(error);
    expect(published).toMatchObject({
      status_label: 'Out of sync — local recovery required',
      last_error_code: 'catchup_recovery_required',
      last_error_details: null
    });
    expect(JSON.stringify(published)).not.toContain('unsafe details');
  });

  it('keeps the original failure when safe status publication fails', async () => {
    const { client, core } = await setup();
    const error = new PluginBlockedError('catchup_local_changes', 'safe original error');
    core.syncOnce = vi.fn(async () => { throw error; });
    core.writeState = vi.fn(async () => { throw new Error('storage failure'); });
    await expect(client.maintenanceTick()).rejects.toBe(error);
  });

  it('does not map unrelated errors into catch-up status or overwrite their category', async () => {
    const { client, core } = await setup();
    const error = new PluginBlockedError('connection_not_approved', 'not approved');
    core.syncOnce = vi.fn(async () => { throw error; });
    core.writeState = vi.fn();
    await expect(client.maintenanceTick()).rejects.toBe(error);
    expect(core.writeState).not.toHaveBeenCalled();
  });
});
