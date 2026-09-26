import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ObtsPluginClient } from '../../src/client/core.js';
import { API_VERSION } from '../../src/shared/types.js';

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export async function retainedCatchupHarness(root: string, prepare = false, withExtra = false) {
  const wrapper = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'synthetic' });
  const core = (wrapper as any).client;
  if (prepare) {
    await wrapper.initialize();
    await writeFile(join(root, 'note.md'), 'base\n');
    const base = await core.createLocalCommit('base');
    await writeFile(join(root, 'note.md'), 'accepted first\n');
    const target = await core.createLocalCommit('first accepted');
    await writeFile(join(root, 'note.md'), 'accepted second\n');
    if (withExtra) await writeFile(join(root, 'extra.md'), 'accepted extra\n');
    const accepted = await core.createLocalCommit('second accepted');
    await core.updateRef('refs/heads/main', base, null, true);
    await core.writeState({ ...await core.readState(), vault_id: 'vault', device_id: 'device', user_id: 'owner', local_main: base, local_head: accepted, server_device_ref: accepted, initial_import_confirmed: true, status_label: 'Behind', last_error_code: null, last_event_seq: 2, last_applied_event_seq: 0 });
    await core.writeQueue({ pending_commit: null, expected_device_ref: accepted, status: 'merged', attempts: 0 });
    await core.fsp.writeFile(core.authPath, JSON.stringify({ device_token: 'synthetic-token' }));
    const manifest = manifestFor(target, 1, ['note.md'], { 'note.md': 15 });
    await core.fsp.writeFile(core.pullTransferPath, JSON.stringify({ vault_id: 'vault', device_id: 'device', current_local_main: base, current_event_seq: 0, target_main: target, next_cursor: 1, received_chunks: 1, transferred_bytes: 0, complete: true, manifest, manifest_sha256: sha(JSON.stringify(manifest)) }));
    await writeFile(join(root, '.obts/fixture.json'), JSON.stringify({ base, target, accepted, withExtra }));
  }
  const fixture = JSON.parse(await readFile(join(root, '.obts/fixture.json'), 'utf8'));
  let pulls = 0;
  core.syncCapabilities = async () => ({ max_transfer_chunks: 100, max_transfer_bytes: 100000 });
  core.reportDeviceStatus = async () => {};
  core.getDeviceSelf = async () => ({ vault_id: 'vault', device_id: 'device', server_device_ref: fixture.accepted, current_main: fixture.accepted, last_applied_main: fixture.target, last_applied_event_seq: 1, status: 'active', vault_status: 'active' });
  core.pollEvents = async () => ({ events: [], current_event_seq: 2 });
  core.pullChunk = async () => { pulls++; return { manifest: manifestFor(fixture.accepted, 2, fixture.withExtra ? ['note.md', 'extra.md'] : ['note.md'], fixture.withExtra ? { 'note.md': 16, 'extra.md': 15 } : { 'note.md': 16 }), packfile: Buffer.alloc(0) }; };
  core.completePendingAppliedAcknowledgement = async (pending: any, state: any) => {
    await core.fsp.rm(core.pendingAppliedAckPath, { force: true });
    await core.clearAppliedPullCheckpoint(pending.target_main, state || await core.readState());
  };
  core.uploadQueuedCommit = async () => { throw new Error('Unexpected upload of intermediate rollback content'); };
  return { core, fixture, pulls: () => pulls };
}
function manifestFor(target: string, seq: number, paths: string[], sizes: Record<string, number>) {
  return { api_version: API_VERSION, capability: 'git-object-pack-chunks-v1', complete: true, target_main: target, cursor: 0, next_cursor: 1, chunk_sha256: sha(''), chunk_bytes: 0, changed_paths: paths, target_file_sizes: sizes, explicit_directories: [], vault_id: 'vault', device_id: 'device', current_local_main_is_ancestor: true, event_seq: seq, directory_intents: [], directory_acknowledgements: [], root_ignore_oid: null };
}
