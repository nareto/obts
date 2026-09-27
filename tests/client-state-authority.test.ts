import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(status: string) {
  await mkdir('tmp/state-authority-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/state-authority-tests/client-'));
  roots.push(root);
  const wrapper = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'device' });
  await wrapper.initialize();
  const core = (wrapper as any).client;
  await writeFile(join(root, 'note.md'), 'base\n');
  const base = await core.createLocalCommit('base');
  await core.updateRef('refs/heads/main', base, null, true);
  await writeFile(join(root, 'note.md'), 'server\n');
  const server = await core.createLocalCommit('server');
  await core.updateRef('refs/heads/local', base, null, true);
  await writeFile(join(root, 'note.md'), 'local pending edit\n');
  const pending = await core.createLocalCommit('pending');
  const state = { ...await core.readState(), vault_id: 'vault', device_id: 'device', local_main: base,
    local_head: pending, server_device_ref: base, status_label: 'Out of sync', last_error_code: 'device_blocked',
    updated_at: '2026-01-01T00:00:00.000Z' };
  await writeFile(join(root, '.obts/state.json'), JSON.stringify(state));
  await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify(state));
  await core.writeQueue({ pending_commit: pending, expected_device_ref: base, status, attempts: 1, updated_at: state.updated_at });
  return { root, core, state, base, server, pending };
}

describe('client observation and immutable proposal ownership', () => {
  it.each(['queued_local', 'uploading', 'uploaded'])('reconciles a stale block with a %s proposal and retains the observation on restart', async status => {
    const { root, core, state, base, server, pending } = await fixture(status);
    const queue = await core.readQueue();
    core.readDeviceToken = async () => 'synthetic';
    core.getDeviceSelf = async () => ({ vault_id: 'vault', device_id: 'device', server_device_ref: server,
      current_main: server, status: 'synced', vault_status: 'active', event_seq: 1 });
    core.pull = vi.fn(async () => ({ packfile: Buffer.alloc(0), manifest: { target_main: server,
      changed_paths: ['note.md'], directory_intents: [], explicit_directories: [], event_seq: 1 } }));
    await expect(core.reconcileDeviceBlocked()).resolves.toMatchObject({ applied: false });
    expect(core.pull).toHaveBeenCalledOnce();
    expect(await core.readState()).toMatchObject({ local_main: base, local_head: pending, server_device_ref: server, last_error_code: null });
    expect(await core.readQueue()).toMatchObject({ pending_commit: queue.pending_commit, expected_device_ref: queue.expected_device_ref });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('local pending edit\n');

    // Restart after durable publication, with no in-memory reconciliation capability.
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'device' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ local_main: state.local_main, local_head: pending, server_device_ref: server, last_error_code: null });
    expect(await restarted.readQueue()).toMatchObject({ pending_commit: pending, expected_device_ref: base });
  });

  it('retains an actual upload checkpoint and a later visible edit through reconciliation and restart', async () => {
    const { root, core, state, base, server } = await fixture('uploading');
    const setStatus = core.plugin.setStatus;
    core.plugin.setStatus = () => { throw new Error('stop after immutable checkpoint'); };
    await expect(core.pushInChunks(state, await core.readQueue(), 'synthetic', null,
      { target_chunk_bytes: 65536, max_chunk_bytes: 131072, max_transfer_chunks: 100 }, null))
      .rejects.toThrow('stop after immutable checkpoint');
    core.plugin.setStatus = setStatus;
    const checkpoint = await core.fsp.readFile(core.uploadTransferPath, 'utf8');
    const parsed = JSON.parse(checkpoint);
    expect(parsed).toMatchObject({ attempt_id: expect.stringMatching(/^xfer_/), transfer_id: null,
      transfer_request: { expected_device_ref: base, client_known_main: base, plan_sha256: expect.any(String) } });
    expect(parsed.groups.length).toBeGreaterThan(0);
    const queue = await core.fsp.readFile(core.queuePath, 'utf8');
    await writeFile(join(root, 'note.md'), 'visible edit after capture\n');
    await writeFile(join(root, '.obts/state.json'), JSON.stringify(state));
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify(state));
    core.readDeviceToken = async () => 'synthetic';
    core.getDeviceSelf = async () => ({ vault_id: 'vault', device_id: 'device', server_device_ref: server,
      current_main: server, status: 'synced', vault_status: 'active', event_seq: 1 });
    core.pull = async () => ({ packfile: Buffer.alloc(0), manifest: { target_main: server,
      changed_paths: ['note.md'], directory_intents: [], explicit_directories: [], event_seq: 1 } });
    await expect(core.reconcileDeviceBlocked()).resolves.toMatchObject({ applied: false });
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'device' });
    await restarted.initialize();
    expect(await core.fsp.readFile(core.uploadTransferPath, 'utf8')).toBe(checkpoint);
    expect(await core.fsp.readFile(core.queuePath, 'utf8')).toBe(queue);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('visible edit after capture\n');
  });

  it('rejects a backup whose matching ref points to a missing commit', async () => {
    const { root, core, state, server } = await fixture('queued_local');
    const missing = 'f'.repeat(40);
    await core.updateRef('refs/heads/main', server, null, true);
    await core.updateRef('refs/heads/local', missing, null, true);
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify({ ...state, local_main: server, local_head: missing }));
    expect(await core.readState()).toMatchObject(state);
  });

  it('recovers a backup server cursor only with real ancestry proof', async () => {
    const { root, core, state, server } = await fixture('queued_local');
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify({ ...state, server_device_ref: server }));
    expect(await core.readState()).toMatchObject({ local_main: state.local_main, local_head: state.local_head, server_device_ref: server });
    expect(JSON.parse(await readFile(join(root, '.obts/state.json'), 'utf8')).server_device_ref).toBe(server);
  });

  it.each([null, 'server_recovery_required'])('keeps primary error %s when local-ref repair shares the server ref', async error => {
    const { root, core, state, server, pending } = await fixture('queued_local');
    await core.updateRef('refs/heads/main', server, null, true);
    const primary = { ...state, server_device_ref: server, last_error_code: error,
      last_error_details: error ? { recovery: 'required' } : null };
    const backup = { ...state, local_main: server, server_device_ref: server,
      last_error_code: error ? null : 'device_blocked', last_error_details: null };
    await writeFile(join(root, '.obts/state.json'), JSON.stringify(primary));
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify(backup));
    expect(await core.readState()).toMatchObject({ local_main: server, local_head: pending,
      server_device_ref: server, last_error_code: error, last_error_details: primary.last_error_details });
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'device' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ last_error_code: error, server_device_ref: server });
  });

  it('does not persist an incomparable head when only the main cursor descends', async () => {
    const { root, core, state, server, pending } = await fixture('queued_local');
    await core.updateRef('refs/heads/main', server, null, true);
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify({ ...state, local_main: server, local_head: server }));
    expect(await core.readState()).toMatchObject({ local_main: state.local_main, local_head: pending });
    expect(JSON.parse(await readFile(join(root, '.obts/state.json'), 'utf8'))).toMatchObject({ local_main: state.local_main, local_head: pending });
    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'device' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ local_main: state.local_main, local_head: pending });
  });

  it('propagates recovery publication failure instead of falling back to stale backup observations', async () => {
    const { root, core, state, server } = await fixture('queued_local');
    await core.updateRef('refs/heads/main', server, null, true);
    const primary = { ...state, server_device_ref: server, last_error_code: null };
    await writeFile(join(root, '.obts/state.json'), JSON.stringify(primary));
    await writeFile(join(root, '.obts/state.json.bak'), JSON.stringify({ ...state, local_main: server }));
    const rename = core.fsp.rename.bind(core.fsp);
    core.fsp.rename = async (from: string, to: string) => {
      if (to === core.statePath) throw new Error('synthetic publication failure');
      return rename(from, to);
    };
    await expect(core.readState()).rejects.toThrow('synthetic publication failure');
    expect(JSON.parse(await readFile(join(root, '.obts/state.json'), 'utf8'))).toMatchObject(primary);
  });

  it.each(['queued_local', 'uploading', 'uploaded', 'conflicted'])('does not let a %s CAS baseline choose a server-only backup', async status => {
    const { root, core, state, server } = await fixture(status);
    const primary = { ...state, server_device_ref: server, last_error_code: null, status_label: 'Behind', updated_at: '2026-01-01T00:00:01.000Z' };
    await writeFile(join(root, '.obts/state.json'), JSON.stringify(primary));
    expect(await core.readState()).toMatchObject({ server_device_ref: server, last_error_code: null });
    expect(JSON.parse(await readFile(join(root, '.obts/state.json'), 'utf8'))).toMatchObject(primary);
  });
});
