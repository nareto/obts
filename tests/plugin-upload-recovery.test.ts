import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { AuthError } from '../src/server/authService.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];
const stableJson = (value: any): string => JSON.stringify(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.app.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function fixture(withDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), 'obts-upload-recovery-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'server'), sessionSecret: 'upload-fixture-secret' });
  servers.push(server);
  const url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'upload-fixture-password' } });
  const headers = { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token };
  const vault = await server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers, payload: { display_name: 'Upload fixture' } });
  const vaultId = vault.json().vault_id as string;
  const dir = join(root, 'client');
  await mkdir(dir);
  const plugin = new ObtsPluginClient(dir, { serverUrl: url, deviceName: 'upload-client' });
  const connection = await plugin.startOnboarding('fixture');
  expect((await server.app.inject({ method: 'POST', url: `/api/v1/connections/${connection.connection_id}/approve`, headers,
    payload: { selection: 'existing_vault', vault_id: vaultId } })).statusCode).toBe(200);
  const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  await plugin.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
  const core = plugin.client as any;
  const base = (await plugin.readState()).local_main!;
  if (withDirectory) {
    await core.adapter.mkdir('old-folder');
    await core.reconcileDirectoryState([], ['old-folder']);
  }
  await core.adapter.write('note.md', 'old captured version\n');
  const old = await core.createLocalCommit('old proposal');
  await core.writeQueue({ ...(await core.readQueue()), pending_commit: old, expected_device_ref: null, status: 'queued_local' });
  await core.writeState({ ...(await core.readState()), local_head: old });
  const put = core.putPushChunk.bind(core);
  core.putPushChunk = async () => { throw new Error('offline fixture'); };
  await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toThrow('offline fixture');
  core.putPushChunk = put;
  const checkpointPath = join(dir, '.obts/upload-transfer.json');
  async function legacy(noId = true) {
    const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
    delete cp.transfer_request.root_ignore_capability;
    delete cp.transfer_request.root_ignore_oid;
    cp.attempt_id = `xfer_${hash(stableJson(cp.transfer_request)).slice(0, 32)}`;
    if (noId) cp.transfer_id = null;
    const raw = JSON.stringify(cp);
    await writeFile(checkpointPath, raw);
    return { cp, raw };
  }
  async function successor(rawQueue = true) {
    await core.adapter.write('note.md', 'successor captured version\n');
    const commit = await core.createLocalCommit('successor proposal');
    const queue = { ...(await core.readQueue()), pending_commit: commit, status: 'queued_local' };
    if (rawQueue) await writeFile(join(dir, '.obts/queue.json'), JSON.stringify(queue));
    else await core.writeQueue(queue);
    await core.writeState({ ...(await core.readState()), local_head: commit });
    return commit;
  }
  async function restart() {
    const next = new ObtsPluginClient(dir, { serverUrl: url, deviceName: 'upload-client' });
    await next.initialize();
    return next.client as any;
  }
  async function canonical() {
    return (await server.git.readBlobAtPath(vaultId, (await server.git.getRef(vaultId, 'refs/heads/main'))!, 'note.md')).toString();
  }
  return { root, dir, core, plugin, server, vaultId, headers, base, old, legacy, successor, restart, canonical, checkpointPath };
}

describe('upload checkpoint recovery with the real server', () => {
  it('recovers an already stale no-id legacy checkpoint after onboarding, preserving both proposals and later edits', async () => {
    const f = await fixture();
    const { raw } = await f.legacy();
    const successor = await f.successor();
    expect((await f.core.readState()).server_device_ref).toBeNull();
    await f.core.adapter.write('note.md', 'later visible edit\n');
    await f.core.recordLocalChangeHint(['note.md']);
    const next = await f.restart();
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe('old captured version\n');
    expect(await next.readQueue()).toMatchObject({ pending_commit: successor, pending_upload_base: f.base, changed_paths: ['note.md'] });
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('later visible edit\n');
    expect(await next.resolveRef(`refs/obts/upload-recovery/${f.old}`)).toBe(f.old);
    expect(await next.resolveRef(`refs/obts/upload-recovery/${successor}`)).toBe(successor);
    const archives = await readdir(join(f.dir, '.obts/upload-recovery'));
    const archive = JSON.parse(await readFile(join(f.dir, '.obts/upload-recovery', archives[0]!), 'utf8'));
    expect(archive.checkpoint_raw).toBe(raw);
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('conflicted');
    expect(await f.canonical()).toBe('old captured version\n');
    expect((await f.server.store.snapshot()).conflicts.some((c) => c.device_commit === successor)).toBe(true);
  });

  it('recovers a same-target legacy checkpoint without root-ignore metadata', async () => {
    const f = await fixture();
    await f.legacy();
    expect((await f.core.recoverUploadCheckpoint()).status).toBe('Behind');
    expect(await f.canonical()).toBe('old captured version\n');
    expect((await f.core.readQueue()).pending_commit).toBeNull();
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
  });

  it('rebuild reconciles an existing stale checkpoint before classifying the successor', async () => {
    const f = await fixture();
    await f.legacy();
    const successor = await f.successor();
    await f.core.adapter.write('note.md', 'later visible edit\n');
    await f.core.rebuildFromServerMain();
    expect(await readFile(f.checkpointPath, 'utf8').catch(() => null)).toBeNull();
    expect(await f.core.resolveRef(`refs/obts/upload-recovery/${successor}`)).toBe(successor);
    expect(await f.core.readQueue()).toMatchObject({ pending_commit: successor, pending_upload_base: f.base });
    expect((await f.core.readState()).local_main).not.toBe(f.base);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('later visible edit\n');
    expect((await f.core.readState()).last_error_code).not.toBe('legacy_upload_checkpoint');
  });

  it('reconciles a modern checkpoint whose queued proposal base disagrees instead of dead-ending', async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.checkpointPath, 'utf8'));
    await f.core.writeQueue({ ...(await f.core.readQueue()), pending_proposal_base: f.old });
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect(['merged', 'noop']).toContain((await f.core.uploadQueuedCommit(await f.core.readQueue())).status);
    // The immutable attempt is resumed under its own recorded authoring base.
    expect(create.mock.calls.at(-1)![1].attempt_id).toBe(before.attempt_id);
    expect(await f.canonical()).toBe('old captured version\n');
    expect(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('resumes a current modern request, identity and object plan unchanged after restart and capability changes', async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.checkpointPath, 'utf8'));
    const next = await f.restart();
    const caps = await next.syncCapabilities();
    next.syncCapabilities = async () => ({ ...caps, target_chunk_bytes: caps.target_chunk_bytes / 2 });
    next.putPushChunk = async () => { throw new Error('second interruption'); };
    await expect(next.uploadQueuedCommit(await next.readQueue())).rejects.toThrow('second interruption');
    const after = JSON.parse(await readFile(f.checkpointPath, 'utf8'));
    for (const key of ['identity', 'attempt_id', 'transfer_id', 'transfer_request', 'groups']) expect(after[key]).toEqual(before[key]);
    expect(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('publishes a handoff before a future queue replacement and resumes across restart', async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.checkpointPath, 'utf8'));
    const successor = await f.successor(false);
    const journal = JSON.parse(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8'));
    expect(journal).toMatchObject({ old_commit: f.old, successor_commit: successor });
    expect((await f.core.readQueue()).pending_commit).toBe(successor);
    const next = await f.restart();
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect(create.mock.calls.at(-1)![1].attempt_id).toBe(before.attempt_id);
    expect((await next.readQueue()).pending_commit).toBe(successor);
  });

  it.each(['completed', 'expired'] as const)('uses real server evidence for a previously accepted %s legacy transfer', async (kind) => {
    const f = await fixture();
    const remove = f.core.fsp.rm.bind(f.core.fsp);
    let interrupted = false;
    f.core.fsp.rm = async (p: string, ...args: any[]) => {
      if (p === f.core.uploadTransferPath && !interrupted) { interrupted = true; throw new Error('lost terminal publication'); }
      return remove(p, ...args);
    };
    await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('lost terminal publication');
    f.core.fsp.rm = remove;
    const { cp } = await f.legacy(false);
    if (kind === 'expired') {
      const sessionPath = join(f.server.config.transferDir, cp.transfer_id, 'session.json');
      const session = JSON.parse(await readFile(sessionPath, 'utf8'));
      session.expires_at = new Date(Date.now() - 1000).toISOString();
      await writeFile(sessionPath, JSON.stringify(session));
    }
    const successor = await f.successor();
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    const next = await f.restart();
    expect(['merged', 'noop']).toContain((await next.uploadQueuedCommit(await next.readQueue())).status);
    expect(await f.canonical()).toBe('old captured version\n');
    expect((await next.readQueue()).pending_commit).toBe(successor);
    if (kind === 'completed') expect(create).not.toHaveBeenCalled();
    else expect(create).toHaveBeenCalled();
  });

  it('polls an already processing transfer instead of replaying or inferring acceptance from the device ref', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const push = f.server.sync.pushDeviceCommit.bind(f.server.sync);
    vi.spyOn(f.server.sync, 'pushDeviceCommit').mockImplementation(async (...args) => { await gate; return push(...args); });
    f.core.pollPushTransfer = async () => { throw new Error('client stopped during processing'); };
    await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('client stopped during processing');
    await f.legacy(false);
    const successor = await f.successor();
    const next = await f.restart();
    const poll = next.pollPushTransfer.bind(next);
    next.pollPushTransfer = async (...args: any[]) => { release(); return poll(...args); };
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect(create).not.toHaveBeenCalled();
    expect((await next.readQueue()).pending_commit).toBe(successor);
  });

  it('reconciles acceptance racing a missing status through a real replay without DELETE', async () => {
    const f = await fixture();
    const cp = JSON.parse(await readFile(f.checkpointPath, 'utf8'));
    const token = await f.core.readDeviceToken();
    const caps = await f.core.syncCapabilities();
    for (let index = 0; index < cp.groups.length; index++) {
      await f.core.putPushChunk({ vaultId: f.vaultId, token, transferId: cp.transfer_id, index,
        packfile: await f.core.packObjectChunk(cp.groups[index], caps.max_chunk_bytes) });
    }
    await f.legacy(false);
    const successor = await f.successor();
    const get = f.server.chunkTransfers.getPush.bind(f.server.chunkTransfers);
    let raced = false;
    vi.spyOn(f.server.chunkTransfers, 'getPush').mockImplementation(async (auth, id) => {
      if (!raced && id === cp.transfer_id) {
        raced = true;
        await f.server.chunkTransfers.finalizePush(auth, id);
        throw new AuthError(404, 'not_found', 'Fixture lost status');
      }
      return get(auth, id);
    });
    const remove = vi.spyOn(f.server.chunkTransfers, 'deletePush');
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect(['merged', 'noop']).toContain((await f.core.uploadQueuedCommit(await f.core.readQueue())).status);
    expect(raced).toBe(true);
    expect(create).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((await f.core.readQueue()).pending_commit).toBe(successor);
    expect(await f.canonical()).toBe('old captured version\n');
  });

  it.each(['successor', 'cleared'] as const)('resumes terminal settlement after %s queue publication without replay or lost watcher hints', async (kind) => {
    const f = await fixture();
    await f.legacy();
    const successor = kind === 'successor' ? await f.successor() : null;
    const write = f.core.writeState.bind(f.core);
    f.core.writeState = async (state: any) => {
      if (['Ahead', 'Behind'].includes(state.status_label)) throw new Error('crash after queue publication');
      return write(state);
    };
    await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('crash after queue publication');
    await f.core.recordLocalChangeHint(['later.md']).catch(() => undefined);
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    const next = await f.restart();
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect(create).not.toHaveBeenCalled();
    expect(await next.readQueue()).toMatchObject({ pending_commit: successor, changed_paths: ['later.md'] });
    expect(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('recovers a handoff published after the local ref moved but before the queue moved', async () => {
    const f = await fixture();
    const rename = f.core.fsp.rename.bind(f.core.fsp);
    f.core.fsp.rename = async (from: string, to: string) => {
      if (to === f.core.queuePath) throw new Error('queue publication failed');
      return rename(from, to);
    };
    await expect(f.successor(false)).rejects.toThrow('queue publication failed');
    const journal = JSON.parse(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8'));
    expect((await f.core.readQueue()).pending_commit).toBe(f.old);
    expect(await f.core.resolveRef('refs/heads/local')).toBe(journal.successor_commit);
    const next = await f.restart();
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect((await next.readQueue()).pending_commit).toBe(journal.successor_commit);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('successor captured version\n');
  });

  it('resumes after checkpoint retirement using the durable terminal result', async () => {
    const f = await fixture();
    await f.legacy();
    const successor = await f.successor();
    const remove = f.core.fsp.rm.bind(f.core.fsp);
    f.core.fsp.rm = async (p: string, ...args: any[]) => {
      if (p === f.core.uploadRecoveryPath) throw new Error('journal retirement failed');
      return remove(p, ...args);
    };
    await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('journal retirement failed');
    expect(await readFile(f.checkpointPath, 'utf8').catch(() => null)).toBeNull();
    const next = await f.restart();
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect((await next.uploadQueuedCommit(await next.readQueue())).status).toBe('merged');
    expect(create).not.toHaveBeenCalled();
    expect((await next.readQueue()).pending_commit).toBe(successor);
  });

  it('retains a corrupt replay checkpoint even after the terminal result was saved', async () => {
    const f = await fixture();
    await f.legacy();
    const successor = await f.successor();
    const write = f.core.writeState.bind(f.core);
    f.core.writeState = async (state: any) => {
      if (state.status_label === 'Ahead') throw new Error('terminal publication stopped');
      return write(state);
    };
    await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('terminal publication stopped');
    const replayPath = join(f.dir, '.obts/upload-recovery-transfer.json');
    await writeFile(replayPath, '{corrupt replay');
    const next = await f.restart();
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    await expect(next.uploadQueuedCommit(await next.readQueue())).rejects.toMatchObject({ code: 'upload_checkpoint_recovery_required' });
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(replayPath, 'utf8')).toBe('{corrupt replay');
    expect((await next.readQueue()).pending_commit).toBe(successor);
  });

  it('replays only the original directory proposal and leaves successor generations pending', async () => {
    const f = await fixture(true);
    const { cp } = await f.legacy();
    expect(cp.directory_proposal.intents.map((i: any) => i.path)).toContain('old-folder');
    await f.successor();
    await f.core.adapter.mkdir('later-folder');
    await f.core.reconcileDirectoryState(['note.md'], ['old-folder', 'later-folder']);
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    expect((await f.core.uploadQueuedCommit(await f.core.readQueue())).status).toBe('merged');
    expect(create.mock.calls.at(-1)![1].directory_proposal).toEqual(cp.directory_proposal);
    const pending = (await f.core.readDirectoryState()).pending_intents;
    expect(pending.map((i: any) => i.path)).toEqual(['later-folder']);
  });

  it('archives a conflict result, preserves the successor, and releases recovery for normal conflict resolution', async () => {
    const f = await fixture();
    await f.legacy();
    const successor = await f.successor();
    const tree = await f.server.git.createTreeFromCommitWithChanges({ vaultId: f.vaultId, sourceCommit: f.base,
      writes: new Map([['note.md', Buffer.from('remote competing addition\n')]]), deletes: [] });
    const remote = await f.server.git.createMainCommitFromTree({ vaultId: f.vaultId, tree, parentMain: f.base,
      subject: 'competing fixture', body: '', actor: 'fixture' });
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', remote, f.base);
    await f.server.store.mutate((db) => { db.vaults.find((v) => v.vault_id === f.vaultId)!.current_main = remote; });
    const result = await f.core.uploadQueuedCommit(await f.core.readQueue());
    expect(result.status).toBe('conflicted');
    expect(await f.core.readQueue()).toMatchObject({ pending_commit: successor, status: 'queued_local' });
    expect(await readFile(join(f.dir, '.obts/upload-recovery.json'), 'utf8').catch(() => null)).toBeNull();
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${result.conflict_id}` });
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${result.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'manual',
        manual_files: { 'note.md': 'old captured version\n' } } })).statusCode).toBe(200);
    const next = await f.restart();
    await next.pollRemoteEventsAndApply();
    expect((await next.readState()).last_error_code).not.toBe('upload_checkpoint_recovery_required');
    expect(await next.resolveRef(`refs/obts/upload-recovery/${successor}`)).toBe(successor);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('successor captured version\n');
    expect((await next.readQueue()).pending_commit).toBe(successor);
    expect(['merged', 'noop', 'conflicted']).toContain((await next.uploadQueuedCommit(await next.readQueue())).status);
  });

  it.each(['checkpoint-json', 'checkpoint-utf8', 'queue-json', 'journal-json', 'journal-identity', 'missing-object'] as const)('retains corrupt or ambiguous %s evidence without sending a new upload', async (kind) => {
    const f = await fixture();
    await f.legacy();
    await f.successor();
    let evidencePath = f.checkpointPath;
    if (kind.startsWith('journal')) {
      f.core.reconcileUploadCheckpointHandoff = async () => { throw new Error('offline recovery'); };
      await expect(f.core.uploadQueuedCommit(await f.core.readQueue())).rejects.toThrow('offline recovery');
      evidencePath = join(f.dir, '.obts/upload-recovery.json');
    } else if (kind === 'queue-json') evidencePath = join(f.dir, '.obts/queue.json');
    if (kind === 'journal-identity') {
      const journal = JSON.parse(await readFile(evidencePath, 'utf8'));
      journal.checkpoint.target_commit = f.base;
      delete journal.journal_sha256;
      journal.journal_sha256 = hash(JSON.stringify(journal));
      await writeFile(evidencePath, JSON.stringify(journal));
    } else if (kind === 'checkpoint-utf8') {
      const cp = JSON.parse(await readFile(evidencePath, 'utf8'));
      cp.updated_at = 'bad-UTF8';
      const raw = Buffer.from(JSON.stringify(cp));
      raw[raw.indexOf('bad-UTF8')] = 255;
      await writeFile(evidencePath, raw);
    } else if (kind === 'missing-object') {
      const blob = (await f.core.listTreeBlobOids(f.old)).get('note.md');
      await f.core.fsp.rm(`${f.core.gitdir}/objects/${blob.slice(0, 2)}/${blob.slice(2)}`);
    } else await writeFile(evidencePath, '{broken');
    const bytes = await readFile(evidencePath);
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    const next = await f.restart();
    await expect(next.uploadQueuedCommit(await next.readQueue())).rejects.toMatchObject({ code: 'upload_checkpoint_recovery_required' });
    expect(await readFile(evidencePath)).toEqual(bytes);
    expect(create).not.toHaveBeenCalled();
  });
});
