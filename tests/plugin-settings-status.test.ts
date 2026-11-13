import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';

// The settings tab shows the same truth as the status bar: while this session
// runs an attempt the row follows the live label, and a finished attempt never
// keeps a transient "Checking" that nothing running or queued owns.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  await mkdir('tmp/settings-status-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/settings-status-tests/client-'));
  const client = await mobileHarness(root, 'http://127.0.0.1:3000');
  cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
  await client.core.writeState({
    ...await client.core.readState(),
    vault_id: 'synthetic-vault',
    device_id: 'synthetic-device',
    local_main: 'a'.repeat(40),
    local_head: 'a'.repeat(40),
    status_label: 'Synced'
  });
  // The startup attempt of the harness must be over: these assertions are
  // about what the row reports while nothing is running.
  await waitUntil(() => client.plugin.operationAvailability() === 'available');
  client.plugin.syncQueued = false;
  return client;
}

describe('settings status row', () => {
  it('follows the live label while an attempt runs and the persisted label after it', async () => {
    const { plugin } = await fixture();
    const state = await plugin.client.readState();

    expect(plugin.settingsStatusLabel(state)).toBe('Synced');
    expect(plugin.beginSync('Sync now', 'user')).toBe(true);
    plugin.setOperationProgress('Applying (checking applied files)', 'apply_local_capture');
    // The persisted label still says Synced: the row must not.
    expect(plugin.settingsStatusLabel(state)).toBe('Applying (checking applied files)');
    plugin.endSync(true);
    const settled = { ...state, status_label: 'Synced' };
    // The attempt path ends by publishing the state it persisted.
    plugin.setPersistedStatus(settled);
    expect(plugin.settingsStatusLabel(settled)).toBe('Synced');
  });

  it('never reports a transient Checking that nothing running or queued owns', async () => {
    const { plugin } = await fixture();
    const running = await plugin.client.readState();
    expect(plugin.beginSync('Sync now', 'user')).toBe(true);
    plugin.setOperationProgress('Checking (requesting changes)', 'sync_request');
    // An attempt is running, so the row says so.
    expect(plugin.settingsStatusLabel({ ...running, status_label: 'Checking' })).toBe('Checking (requesting changes)');
    plugin.endSync(true);

    plugin.setStatus('Checking');
    // Settled device, no attempt, nothing queued: the stale Checking is not a
    // state the row may present as current.
    expect(plugin.settingsStatusLabel({ ...running, status_label: 'Checking' })).toBe('Synced');
    expect(plugin.settingsStatusLabel({ ...running, local_head: 'b'.repeat(40), status_label: 'Checking' })).toBe('Ahead');

    // A queued attempt still owns the label.
    plugin.setOperationProgress('Checking (requesting changes)', 'sync_request');
    plugin.syncQueued = true;
    expect(plugin.settingsStatusLabel({ ...running, status_label: 'Checking' })).toBe('Checking (requesting changes)');
    plugin.syncQueued = false;
  });

  it('reports the persisted failure instead of a settled label', async () => {
    const { plugin } = await fixture();
    const state = { ...await plugin.client.readState(), status_label: 'Review needed', last_error_code: 'conflict_review_required' };
    expect(plugin.settingsStatusLabel(state)).toBe('Conflict resolution needed');
  });
});
