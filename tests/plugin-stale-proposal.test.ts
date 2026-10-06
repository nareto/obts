import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import { ObtsPluginClient } from '../src/client/core.js';
import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

const BASE = 'first\n\nunchanged middle\n\nlast\n';
const REMOTE = BASE.replace('first', 'remote');
const LOCAL = BASE.replace('last', 'local');
const MERGED = REMOTE.replace('last', 'local');
const roots: string[] = [];
const servers: ObtsServer[] = [];
const nativeWrite = NodeDataAdapter.prototype.writeBinary;
const pluginMain = createRequire(import.meta.url)('../obsidian-plugin/src/main.cjs') as any;
const stableJson = (value: any): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item
);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.app.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-client-stale-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'server'), sessionSecret: 'client-stale-fixture-secret' });
  servers.push(server);
  const url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'client-stale-test-password' } });
  const headers = { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token };
  const vault = await server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers, payload: { display_name: 'Stale client fixture' } });
  const vaultId = vault.json().vault_id as string;
  const dir = join(root, 'client');
  await mkdir(dir);
  const plugin = new ObtsPluginClient(dir, { serverUrl: url, deviceName: 'stale-client' });
  async function pair(client: ObtsPluginClient) {
    const connection = await client.startOnboarding('fixture');
    expect((await server.app.inject({ method: 'POST', url: `/api/v1/connections/${connection.connection_id}/approve`, headers,
      payload: { selection: 'existing_vault', vault_id: vaultId } })).statusCode).toBe(200);
    const analysis = await client.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await client.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
  }
  await pair(plugin);
  await writeFile(join(dir, 'note.md'), BASE);
  await writeFile(join(dir, 'untouched.md'), 'unchanged\n');
  expect((await plugin.syncOnce()).status).toBe('Synced');
  const core = plugin.client as any;
  const m0 = (await plugin.readState()).local_main!;
  async function remote(bytes = REMOTE, extra: Record<string, string> = {}) {
    const prior = await server.git.getRef(vaultId, 'refs/heads/main');
    const tree = await server.git.createTreeFromCommitWithChanges({ vaultId, sourceCommit: prior!, writes: new Map(Object.entries({ 'note.md': bytes, ...extra }).map(([path, text]) => [path, Buffer.from(text)])), deletes: [] });
    const c = await server.git.createMainCommitFromTree({ vaultId, tree, parentMain: prior!, subject: 'remote fixture', body: '', actor: 'fixture' });
    await server.git.updateRef(vaultId, 'refs/heads/main', c, prior);
    await server.store.mutate((db) => { db.vaults.find((v) => v.vault_id === vaultId)!.current_main = c; });
    return c;
  }
  async function canonical(path = 'note.md') {
    return (await server.git.readBlobAtPath(vaultId, (await server.git.getRef(vaultId, 'refs/heads/main'))!, path)).toString();
  }
  const provenance = () => core.readStaleProvenance();
  const restart = async () => {
    const next = new ObtsPluginClient(dir, { serverUrl: url, deviceName: 'stale-client' });
    await next.initialize();
    return { plugin: next, core: next.client as any };
  };
  return { root, server, url, vaultId, headers, dir, plugin, core, m0, remote, canonical, provenance, restart, pair };
}

async function markHorizonsExpired(core: any) {
  await core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
}
async function expire(core: any) {
  await core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
  await core.queueStaleCohort((await core.readState()).local_main, (await core.readState()).server_device_ref);
}
async function assertProposal(f: Awaited<ReturnType<typeof fixture>>, parent: string, base = f.m0) {
  const q = await f.core.readQueue();
  expect(q.pending_proposal_base).toBe(base);
  const parsed = await git.readCommit({ fs: f.core.fs, dir: f.core.vaultDir, gitdir: f.core.gitdir, oid: q.pending_commit });
  expect(parsed.commit.parent).toEqual([parent]);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${base}`)).toBe(base);
  return q;
}

describe('client stale authoring cohorts with the real server', () => {
  it.each(['disjoint', 'overlap', 'delete'] as const)('settles a during-apply %s edit from M0, never fast-forwards over C', async (kind) => {
    const f = await fixture();
    const c = await f.remote();
    const original = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        if (kind === 'delete') await f.core.adapter.remove('note.md');
        else await f.core.adapter.write('note.md', kind === 'disjoint' ? LOCAL : 'overlapping local replacement\n');
      }
      return original(...args);
    };
    await f.core.pullAndApply(true);
    const q = await assertProposal(f, c);
    const result = await f.core.uploadQueuedCommit(q);
    if (kind === 'disjoint') {
      expect(result.status).toBe('merged');
      await f.core.pullAndApply(true);
      expect(await f.canonical()).toBe(MERGED);
      expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(MERGED);
      expect((await f.provenance()).obligations).toEqual({});
    } else {
      expect(result.status).toBe('conflicted');
      expect(await f.canonical()).toBe(REMOTE);
      const conflict = (await f.server.store.snapshot()).conflicts.find((r) => r.device_commit === q.pending_commit)!;
      expect(conflict).toMatchObject({ status: 'open', base_commit: f.m0, current_main: c });
      if (kind === 'delete') await expect(readFile(join(f.dir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('overlapping local replacement\n');
    }
  });

  it('classifies a wrapped writer queued behind the actual raw apply write', async () => {
    let core: any;
    let queued: Promise<void> | undefined;
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinary').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (core && this === core.adapter && path === 'note.md' && Buffer.from(bytes).toString() === REMOTE && !queued) {
        queued = core.adapter.write('note.md', LOCAL);
      }
      return nativeWrite.call(this, path, bytes);
    });
    const f = await fixture();
    core = f.core;
    const c = await f.remote();
    await core.pullAndApply(true);
    await queued;
    const q = await assertProposal(f, c);
    expect((await core.uploadQueuedCommit(q)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it('keeps post-apply editor flushes and horizon saves stale without per-write hooks', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    expect((await f.provenance()).horizons.some((h: any) => h.base === f.m0 && h.touched.includes('note.md'))).toBe(true);
    const ArtifactPlugin = createRequire(import.meta.url)('../obsidian-plugin/src/main.cjs') as any;
    f.core.plugin.app.workspace = { getLeavesOfType: () => [{ view: { file: { path: 'note.md' }, editor: { getValue: () => LOCAL } } }] };
    f.core.plugin.app.vault.read = async () => readFile(join(f.dir, 'note.md'), 'utf8');
    f.core.plugin.app.vault.modify = async (file: { path: string }, text: string) => f.core.adapter.write(file.path, text);
    f.core.plugin.flushOpenMarkdownEditorsToDisk = () => ArtifactPlugin.prototype.flushOpenMarkdownEditorsToDisk.call(f.core.plugin);
    expect(await f.core.flushEditorBuffersToDisk()).toEqual(['note.md']);
    await f.core.queueStaleCohort(c, (await f.plugin.readState()).server_device_ref);
    const q = await assertProposal(f, c);
    expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it('drains the adapter after expiry before releasing the durable horizon', async () => {
    const f = await fixture();
    await f.remote();
    await f.core.pullAndApply(true);
    await f.core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
    let release!: () => void;
    f.core.adapter.promise = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    const expirePromise = f.core.queueStaleCohort((await f.plugin.readState()).local_main, f.m0).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    expect((await f.provenance()).horizons.length).toBeGreaterThan(0);
    const bytes = Buffer.from(LOCAL);
    await nativeWrite.call(f.core.adapter, 'note.md', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    release();
    await expirePromise;
    expect((await f.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    expect((await f.provenance()).horizons).toEqual([]);
  });

  it('treats an edit after expiry/drain as ordinary and releases unused base pins', async () => {
    const f = await fixture();
    await f.remote();
    await f.core.pullAndApply(true);
    await expire(f.core);
    expect((await f.provenance()).horizons).toEqual([]);
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBeNull();
    await f.core.adapter.write('note.md', 'fresh observed-C edit\n');
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical()).toBe('fresh observed-C edit\n');
  });

  it('leaves untouched in-apply bytes out of the stale cohort and settles them sequentially', async () => {
    const f = await fixture();
    const c = await f.remote();
    const original = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await f.core.adapter.write('note.md', LOCAL);
        await f.core.adapter.write('untouched.md', 'fresh untouched edit\n');
      }
      return original(...args);
    };
    await f.core.pullAndApply(true);
    const q = await assertProposal(f, c);
    expect((await f.core.listTreeBlobOids(q.pending_commit)).get('untouched.md')).toBe((await f.core.listTreeBlobOids(c)).get('untouched.md'));
    expect(q.changed_paths).toContain('untouched.md');
    expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    expect(await f.canonical('untouched.md')).toBe('unchanged\n');
    await f.core.pullAndApply(true);
    await f.plugin.syncOnce();
    expect(await f.canonical()).toBe(MERGED);
    expect(await f.canonical('untouched.md')).toBe('fresh untouched edit\n');
  });

  it('does not classify an untouched-only edit during apply as stale', async () => {
    const f = await fixture();
    await f.remote();
    const original = f.core.stageRecoveryBundleFiles.bind(f.core);
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      await f.core.adapter.write('untouched.md', 'ordinary\n');
      return original(...args);
    };
    await f.core.pullAndApply(true);
    expect((await f.provenance()).obligations['untouched.md']).toBeUndefined();
    expect((await f.plugin.readQueue()).pending_proposal_base).toBeNull();
    await f.plugin.syncOnce();
    expect(await f.canonical('untouched.md')).toBe('ordinary\n');
  });

  it('retains the oldest unsettled base across a later apply and newer generation', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const first = await f.plugin.readQueue();
    expect((await f.core.uploadQueuedCommit(first)).status).toBe('merged');
    await f.core.adapter.write('note.md', LOCAL.replace('middle', 'second local middle'));
    await f.core.pullAndApply(true);
    const saved = await f.provenance();
    expect(saved.obligations['note.md']).toMatchObject({ base: f.m0, generation: 2 });
    expect((await f.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
  });

  it('restarts with an active horizon even when wall-clock expiry passed during downtime', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
    const next = await f.restart();
    expect((await next.core.readStaleProvenance()).horizons.some((h: any) => h.expiry > Date.now())).toBe(true);
    await next.core.adapter.write('note.md', LOCAL);
    await next.core.queueStaleCohort(c, f.m0);
    expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it('recovers an obligation and stranded commit from durable pre-publication intent', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    const update = f.core.updateQueue.bind(f.core);
    f.core.updateQueue = async () => { throw new Error('crash before queue publication'); };
    await expect(f.core.queueStaleCohort(c, f.m0)).rejects.toThrow('crash before queue');
    f.core.updateQueue = update;
    const intent = (await f.provenance()).intent;
    // Also exercise the earlier seam: ref advanced but intent.commit not saved.
    await f.core.mutateStaleProvenance(async (saved: any) => { saved.intent.commit = null; });
    const next = await f.restart();
    expect(await next.plugin.readQueue()).toMatchObject({ pending_commit: intent.commit, pending_proposal_base: f.m0 });
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it.each(['multipart', 'chunked'] as const)('restarts mid-upload with immutable M0 (%s)', async (transport) => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    if (transport === 'multipart') f.core.syncCapabilities = async () => ({ capabilities: [] });
    let refMoved!: () => void;
    const moved = new Promise<void>((resolve) => { refMoved = resolve; });
    const fail = vi.spyOn(f.server.sync as any, 'mergeDeviceCommit').mockImplementationOnce(async () => { refMoved(); throw new Error('ref moved before integration'); });
    if (transport === 'chunked') f.core.pollPushTransfer = async () => { await moved; throw new Error('client stopped polling'); };
    await expect(f.core.uploadQueuedCommit(await f.plugin.readQueue())).rejects.toThrow();
    fail.mockRestore();
    if (transport === 'chunked') f.core.pollPushTransfer = Object.getPrototypeOf(f.core).pollPushTransfer;
    const queue = await f.plugin.readQueue();
    expect(await f.server.git.getRef(f.vaultId, (await f.plugin.readState()).device_ref!)).toBe(queue.pending_commit);
    if (transport === 'chunked') {
      const checkpoint = JSON.parse(await readFile(join(f.dir, '.obts', 'upload-transfer.json'), 'utf8'));
      expect(checkpoint.transfer_request.base_commit).toBe(f.m0);
      expect(checkpoint.identity).toMatch(/^[a-f0-9]{64}$/);
      // A corrupted queue base no longer dead-ends the attempt: recovery
      // reconciles the immutable checkpoint under its original authoring base.
      await f.core.writeQueue({ ...queue, pending_proposal_base: c });
      expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
      await f.core.writeQueue(queue);
    }
    const next = await f.restart();
    if (transport === 'multipart') next.core.syncCapabilities = async () => ({ capabilities: [] });
    expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    // Chunked recovery already reconciled the immutable attempt, so the
    // repeated upload of the same target can be idempotent.
    expect(transport === 'chunked' ? ['merged', 'noop'] : ['merged'])
      .toContain((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status);
    expect(await f.canonical()).toBe(MERGED);
    const operation = (await f.server.store.snapshot()).sync_operations.find((o) => o.operation_type === 'device_push' && o.target_commit === queue.pending_commit)!;
    expect(operation.proposal_base).toBe(f.m0);
  });

  it.each(['journal', 'horizon', 'obligation', 'queued', 'upload'] as const)('survives an actual SIGKILL at the %s durable seam', async (seam) => {
    const f = await fixture();
    const c = await f.remote();
    if (seam !== 'journal' && seam !== 'horizon') {
      await f.core.pullAndApply(true);
      await f.core.adapter.write('note.md', LOCAL);
    }
    if (seam === 'upload') await f.core.queueStaleCohort(c, f.m0);
    const child = fork('tests/fixtures/stale-proposal-child.mjs', [f.dir, f.url, seam], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Stale seam timeout')), 15000);
        child.once('message', (message: any) => { clearTimeout(timer); expect(message.seam).toBe(seam); resolve(); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before the durable seam')); });
      });
      const killed = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
      child.kill('SIGKILL');
      expect(await killed).toBe('SIGKILL');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    if (seam === 'journal' || seam === 'horizon') await writeFile(join(f.dir, 'note.md'), LOCAL);
    const next = await f.restart();
    if (!(await next.plugin.readQueue()).pending_commit) await next.core.queueStaleCohort(c, f.m0);
    expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it('retains provenance when bounded post-apply capture fails and the scan is delayed until restart', async () => {
    const f = await fixture();
    await f.remote();
    f.core.plugin.flushOpenMarkdownEditorsToDisk = async () => f.core.adapter.write('note.md', LOCAL);
    f.core.captureStableLocalChanges = async () => ({ stable: false, paths: [], snapshot: null, changedPath: 'note.md' });
    await f.core.pullAndApply(true);
    expect((await f.plugin.readQueue()).pending_commit).toBeNull();
    expect((await f.provenance()).obligations['note.md'].base).toBe(f.m0);
    const next = await f.restart();
    await next.plugin.syncOnce();
    expect(await f.canonical()).toBe(MERGED);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(MERGED);
  });

  it('recovers queue-before-journal-cleanup without replacing the immutable proposal', async () => {
    const f = await fixture();
    const c = await f.remote();
    const stage = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) { injected = true; await f.core.adapter.write('note.md', LOCAL); }
      return stage(...args);
    };
    f.core.clearApplyState = async () => { throw new Error('crash before journal cleanup'); };
    await expect(f.core.pullAndApply(true)).rejects.toThrow('crash before journal cleanup');
    const queued = await f.plugin.readQueue();
    expect(queued.pending_proposal_base).toBe(f.m0);
    const next = await f.restart();
    expect(await next.plugin.readQueue()).toMatchObject({ pending_commit: queued.pending_commit, pending_proposal_base: f.m0 });
    expect((await next.plugin.readState()).local_head).toBe(queued.pending_commit);
    expect(await next.core.resolveRef('refs/heads/local')).toBe(queued.pending_commit);
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
    expect((await next.plugin.readState()).local_main).toBe(c);
  });

  it('preserves M0 through a root-policy candidate rebuild and restart', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const queue = await f.plugin.readQueue();
    await f.core.adapter.write('.gitignore', 'excluded.md\n');
    const rebuilt = await f.core.rebuildQueuedCommitForRootPolicy(queue.pending_commit, await f.plugin.readState(), queue);
    expect(rebuilt.queue.pending_proposal_base).toBe(f.m0);
    expect(rebuilt.queue.pending_commit).not.toBe(queue.pending_commit);
    const next = await f.restart();
    expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });

  it('journals a legacy checkpoint before replacing its queued successor', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const putChunk = f.core.putPushChunk.bind(f.core);
    f.core.putPushChunk = async () => { throw new Error('offline mid-upload'); };
    await expect(f.core.uploadQueuedCommit(await f.plugin.readQueue())).rejects.toThrow('offline mid-upload');
    const checkpointPath = join(f.dir, '.obts', 'upload-transfer.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    delete checkpoint.transfer_request.root_ignore_capability;
    delete checkpoint.transfer_request.root_ignore_oid;
    const { createHash } = await import('node:crypto');
    checkpoint.attempt_id = `xfer_${createHash('sha256').update(JSON.stringify(checkpoint.transfer_request)).digest('hex').slice(0, 32)}`;
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    const oldQueue = await f.plugin.readQueue();
    await f.core.adapter.write('note.md', 'successor local edit\n');
    const successor = await f.core.createLocalCommit('replacement successor');
    await f.core.writeQueue({ ...oldQueue, pending_commit: successor, status: 'queued_local' });
    const recovery = JSON.parse(await readFile(join(f.dir, '.obts', 'upload-recovery.json'), 'utf8'));
    expect(recovery).toMatchObject({ old_commit: oldQueue.pending_commit, successor_commit: successor });
    expect(recovery.checkpoint).toMatchObject({ target_commit: oldQueue.pending_commit });
    expect((await f.plugin.readQueue()).pending_commit).toBe(successor);
    expect(await f.core.resolveRef(`refs/obts/upload-recovery/${oldQueue.pending_commit}`)).toBe(oldQueue.pending_commit);
    f.core.putPushChunk = putChunk;
    const reconciled = await f.core.uploadQueuedCommit(await f.plugin.readQueue());
    expect(reconciled.status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
    expect(await f.plugin.readQueue()).toMatchObject({ pending_commit: successor });
    expect(await readFile(join(f.dir, '.obts', 'upload-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('preserves M0 through an expired chunk-transfer replacement', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    f.core.putPushChunk = async () => { throw new Error('offline mid-upload'); };
    await expect(f.core.uploadQueuedCommit(await f.plugin.readQueue())).rejects.toThrow('offline mid-upload');
    const checkpoint = JSON.parse(await readFile(join(f.dir, '.obts', 'upload-transfer.json'), 'utf8'));
    const sessionPath = join(f.server.config.transferDir, checkpoint.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    session.expires_at = new Date(Date.now() - 1000).toISOString();
    await writeFile(sessionPath, JSON.stringify(session));
    const create = vi.spyOn(f.server.chunkTransfers, 'createPush');
    const next = await f.restart();
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(create.mock.calls.at(-1)![1].base_commit).toBe(f.m0);
    expect(await f.canonical()).toBe(MERGED);
  });

  it('keeps a known-fresh C-based revert out of an older-base sticky cohort', async () => {
    const f = await fixture();
    const c = await f.remote(REMOTE, { 'untouched.md': 'observed new canonical value\n' });
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    // Capture p as stale before closing the horizon; q is still exactly C.
    await f.core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
    const captured = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
    await f.core.classifyStaleSnapshot(c, captured.snapshot);
    expect((await f.provenance()).horizons).toEqual([]);
    await f.core.adapter.write('untouched.md', 'unchanged\n'); // Deliberate revert authored from observed C.
    await f.core.queueStaleCohort(c, f.m0);
    const queue = await f.plugin.readQueue();
    expect(queue.pending_proposal_base).toBe(f.m0);
    expect((await f.core.listTreeBlobOids(queue.pending_commit)).get('untouched.md')).toBe((await f.core.listTreeBlobOids(c)).get('untouched.md'));
    await f.core.uploadQueuedCommit(queue);
    expect(await f.canonical('untouched.md')).toBe('observed new canonical value\n');
    await f.core.pullAndApply(true);
    await f.plugin.syncOnce();
    expect(await f.canonical()).toBe(MERGED);
    expect(await f.canonical('untouched.md')).toBe('unchanged\n');
  });

  it('holds a late untouched edit outside an already captured immutable stale proposal', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const queue = await f.plugin.readQueue();
    await f.core.adapter.write('untouched.md', 'late unreported fresh edit\n');
    expect((await f.core.listTreeBlobOids(queue.pending_commit)).get('untouched.md')).toBe((await f.core.listTreeBlobOids(c)).get('untouched.md'));
    await f.core.uploadQueuedCommit(queue);
    await f.core.pullAndApply(true);
    await f.plugin.syncOnce();
    expect(await f.canonical()).toBe(MERGED);
    expect(await f.canonical('untouched.md')).toBe('late unreported fresh edit\n');
  });

  it('fails closed on corrupt durable provenance instead of manufacturing a new base', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
    const next = await f.restart();
    expect((await next.plugin.readState()).last_error_code).toBe('stale_provenance_corrupt');
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(BASE);
  });

  it('leaves a legacy unbased queue item with its legacy natural-base behavior', async () => {
    const f = await fixture();
    await f.remote();
    await f.core.pullAndApply(true);
    await expire(f.core);
    await f.core.adapter.write('note.md', LOCAL);
    const commit = await f.core.createLocalCommit('legacy C-child proposal');
    await f.core.writeQueue({ pending_commit: commit, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
    const next = await f.restart();
    expect((await next.plugin.readQueue()).pending_proposal_base).toBeNull();
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
    expect(await f.canonical()).toBe(LOCAL); // Named upgrade residual; never invent M0.
  });
});

it('protects an already captured stale cohort when new vault settings exclude its path', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  await f.core.queueStaleCohort(c, f.m0);
  const queue = await assertProposal(f, c);
  await f.core.reportDeviceStatus();
  expect((await f.server.store.snapshot()).devices.find((device) => device.vault_id === f.vaultId)!.path_capabilities)
    .toMatchObject({ root_ignore: true });
  const actorUserId = (await f.server.store.snapshot()).users[0]!.user_id;
  const before = await f.server.sync.getVaultSyncSettings(f.vaultId, actorUserId);
  const input = { vaultId: f.vaultId, actorUserId, expectedMain: String(before.current_main),
    expectedRootIgnoreOid: before.root_ignore_oid as string | null, rootIgnore: 'note.md\n', metadataConflictRules: [] };
  const preview = await f.server.sync.previewVaultSyncSettings(input);
  const saved = await f.server.sync.saveVaultSyncSettings({ ...input, expectedPreviewTree: String(preview.preview_tree),
    expectedReviewFingerprint: String(preview.review_fingerprint), expectedMetadataConflictRules: before.metadata_conflict_rules });
  const main = String(saved.current_main);
  const result = await f.core.uploadQueuedCommit(queue);
  expect(result.status).toBe('conflicted');
  expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(main);
  expect(await f.server.git.readBlobAtPathIfPresent(f.vaultId, main, 'note.md')).toBeNull();
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(LOCAL);
  const conflict = (await f.server.store.snapshot()).conflicts.find((entry) => entry.device_commit === queue.pending_commit)!;
  expect(conflict).toMatchObject({ status: 'open', base_commit: f.m0 });
  expect(conflict.affected_paths).toContain('note.md');
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
  expect((await f.provenance()).intent).toMatchObject({ base: f.m0, commit: queue.pending_commit, outcome: 'conflicted' });
});

it('rebuilds preserved local bytes through the stale cohort base', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.adapter.write('note.md', LOCAL);
  const result = await f.core.rebuildFromServerMain();
  const q = await f.plugin.readQueue();
  expect(result.status).toBe('Ahead');
  expect(q.pending_proposal_base).toBe(f.m0);
  const commit = await git.readCommit({ fs: f.core.fs, dir: f.core.vaultDir, gitdir: f.core.gitdir, oid: q.pending_commit! });
  expect(commit.commit.parent).toEqual([c]);
  expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
  expect(await f.canonical()).toBe(MERGED);
});

it('roll-forward retains the original touched footprint when C is already written', async () => {
  const f = await fixture();
  const c = await f.remote();
  f.core.clearApplyState = async () => { throw new Error('crash after C written'); };
  await expect(f.core.pullAndApply(true)).rejects.toThrow('crash after C');
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(REMOTE);
  const next = await f.restart();
  await next.core.adapter.write('note.md', LOCAL);
  await next.core.queueStaleCohort(c, f.m0);
  expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
  expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
  expect(await f.canonical()).toBe(MERGED);
});

it('hands retirement over to an old-base horizon at the physical JSON publication seam', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  await f.core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
  await f.core.queueStaleCohort(c, f.m0);
  expect((await f.provenance()).horizons).toEqual([]);
  expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
  const write = f.core.fsp.writeFile.bind(f.core.fsp);
  let injected = false;
  f.core.fsp.writeFile = async (path: string, bytes: any, ...args: any[]) => {
    if (path.includes('stale-provenance.json.tmp-') && !injected) {
      const saved = JSON.parse(bytes.toString());
      if (!saved.obligations['note.md'] && !saved.intent && saved.horizons.some((h: any) => h.base === f.m0)) {
        // An old-buffer autosave admitted during the durable retirement write.
        injected = true;
        await f.core.adapter.write('note.md', LOCAL);
      }
    }
    return write(path, bytes, ...args);
  };
  await f.core.pullAndApply(true);
  expect(injected).toBe(true);
  const state = await f.plugin.readState();
  await f.core.queueStaleCohort(state.local_main, state.server_device_ref);
  const q = await f.plugin.readQueue();
  expect(q.pending_proposal_base).toBe(f.m0);
  expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
  expect(await f.canonical()).toBe(MERGED);
});

it('settles an equal-C obligation locally and sends later observed-C edits ordinarily', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  const captured = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
  await f.core.classifyStaleSnapshot(c, captured.snapshot);
  expect((await f.provenance()).obligations['note.md'].base).toBe(f.m0);
  await f.core.adapter.write('note.md', REMOTE);
  await f.core.mutateStaleProvenance(async (saved: any) => { for (const h of saved.horizons) h.expiry = Date.now() - 1; });
  expect(await f.core.queueStaleCohort(c, f.m0)).toBe(false);
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  expect((await f.provenance()).horizons).toEqual([expect.objectContaining({ base: f.m0, touched: ['note.md'] })]);
  expect((await f.provenance()).obligations).toEqual({});
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
  await expire(f.core);
  expect((await f.provenance()).horizons).toEqual([]);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBeNull();
  await f.core.adapter.write('note.md', REMOTE.replace('remote', 'fresh-observed-remote'));
  expect(await f.core.queueStaleCohort(c, f.m0)).toBe(false);
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  expect(await f.canonical()).toBe(REMOTE.replace('remote', 'fresh-observed-remote'));
});

it.each(['fast-forward', 'disjoint-merge', 'overlap-merge'] as const)('keeps existing-note same-line continued typing on acknowledged P (%s)', async (kind) => {
  const f = await fixture();
  await f.core.adapter.write('note.md', LOCAL);
  const p = await f.core.createLocalCommit('ordinary typing proposal');
  await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
  if (kind !== 'fast-forward') await f.remote();
  const put = f.core.putPushChunk.bind(f.core);
  let injected = false;
  const continued = kind === 'overlap-merge' ? LOCAL.replace('first', 'overlapping continued first') : LOCAL.replace('local', 'newer local');
  f.core.putPushChunk = async (...args: any[]) => {
    if (!injected) { injected = true; await f.core.adapter.write('note.md', continued); }
    return put(...args);
  };
  expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
  await f.core.pullAndApply(true);
  const result = await f.plugin.syncOnce();
  if (kind === 'overlap-merge') {
    expect(result.status).toBe('Conflict resolution needed');
    expect(await f.canonical()).toBe(MERGED);
  } else {
    if (result.status !== 'Synced') expect((await f.plugin.syncOnce()).status).toBe('Synced');
    const expected = kind === 'fast-forward' ? continued : REMOTE.replace('last', 'newer local');
    expect(await f.canonical()).toBe(expected);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(expected);
  }
});

it('falls back to canonical main for an already-contained P or missing accepted evidence', async () => {
  const f = await fixture();
  const state = await f.plugin.readState();
  await f.core.mutateStaleProvenance(async (saved: any) => { saved.accepted_proposal = { commit: f.m0, base: null }; });
  expect(await f.core.preApplyAuthoringBase(state, f.m0)).toBe(f.m0);
  await f.core.adapter.write('note.md', LOCAL);
  const p = await f.core.createLocalCommit('proposal with missing evidence');
  const actual = await f.plugin.readState();
  await f.core.mutateStaleProvenance(async (saved: any) => { saved.accepted_proposal = null; saved.intent = null; });
  expect(await f.core.preApplyAuthoringBase({ ...actual, server_device_ref: p, local_main: f.m0 }, p)).toBe(f.m0);
});

it('reconstructs missing stale cohort obligations from the accepted record, without rebasing to P', async () => {
  const f = await fixture(); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL); await f.core.queueStaleCohort(c, f.m0);
  const q = await f.plugin.readQueue(); await f.core.uploadQueuedCommit(q);
  await f.core.mutateStaleProvenance(async (saved: any) => { saved.obligations = {}; saved.intent = null; });
  const pulled = await f.core.pull((await f.plugin.readState()).vault_id, (await f.plugin.readState()).device_id, await f.core.readDeviceToken(), c, 'latest', 0);
  await f.core.importPack(pulled.packfile);
  const target = pulled.manifest.target_main;
  expect(await f.core.preApplyAuthoringBase(await f.plugin.readState(), target)).toBe(q.pending_commit);
  expect((await f.provenance()).obligations['note.md'].base).toBe(f.m0);
});

it('does not silently erase a held observed-C revert when main re-changes that non-cohort path', async () => {
  const f = await fixture();
  const c = await f.remote(REMOTE, { 'untouched.md': 'observed C value\n' }); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  await expire(f.core);
  await f.core.adapter.write('untouched.md', 'unchanged\n');
  await f.core.queueStaleCohort(c, f.m0);
  await f.remote(REMOTE, { 'untouched.md': 'second remote value\n' });
  await f.core.uploadQueuedCommit(await f.plugin.readQueue()); await f.core.pullAndApply(true);
  const result = await f.plugin.syncOnce();
  expect(result.status).toBe('Conflict resolution needed');
  expect(await f.canonical('untouched.md')).toBe('second remote value\n');
  expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe('unchanged\n');
});

it('keeps continued typing on an inherited path P-based after a stale cohort acknowledgment', async () => {
  const f = await fixture(); const c = await f.remote(REMOTE, { 'untouched.md': 'accepted inherited value\n' });
  await f.core.pullAndApply(true); await f.core.adapter.write('note.md', LOCAL); await expire(f.core);
  await f.core.queueStaleCohort(c, f.m0);
  await f.core.adapter.write('untouched.md', 'continued inherited typing\n');
  await f.core.uploadQueuedCommit(await f.plugin.readQueue()); await f.core.pullAndApply(true);
  for (let i = 0; i < 3; i++) { if ((await f.plugin.syncOnce()).status === 'Synced') break; }
  expect(await f.canonical('untouched.md')).toBe('continued inherited typing\n');
  expect(await f.canonical()).toBe(MERGED);
});

it.each([
  { horizons: [null] }, { horizons: ['wrong'] }, { obligations: { 'note.md': null } },
  { obligations: { 'note.md': [] } }, { intent: { base: 'a'.repeat(40) } },
  { accepted_proposal: { commit: 'a'.repeat(40), base: 2 } }
])('surfaces nested corrupt evidence through recovery status: %j', async (invalid) => {
  const f = await fixture();
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), JSON.stringify({ version: 2, horizons: [], obligations: {}, intent: null, accepted_proposal: null, ...invalid }));
  const next = await f.restart();
  expect((await next.plugin.readState()).last_error_code).toBe('stale_provenance_corrupt');
  await expect(next.core.readStaleProvenance()).rejects.toMatchObject({ code: 'stale_provenance_corrupt' });
});

it('preserves corrupt provenance evidence in a verified recovery bundle and repairs through the oldest protected base', async () => {
  const f = await fixture(); await expire(f.core); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  const corrupt = JSON.stringify({ version: 2, horizons: [], obligations: { 'note.md': null }, intent: null });
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), corrupt);
  const next = await f.restart();
  expect((await next.core.rebuildFromServerMain()).status).toBe('Ahead');
  expect((await next.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
  const { readdir } = await import('node:fs/promises');
  let found = false;
  for (const bundle of await readdir(join(f.dir, '.obts', 'recovery'))) {
    try {
      if (await readFile(join(f.dir, '.obts', 'recovery', bundle, 'journal', 'stale-provenance.json'), 'utf8') === corrupt) {
        const { createHash } = await import('node:crypto');
        const checksums = await readFile(join(f.dir, '.obts', 'recovery', bundle, 'checksums.sha256'), 'utf8');
        expect(checksums).toContain(`${createHash('sha256').update(corrupt).digest('hex')}  journal/stale-provenance.json`);
        found = true;
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  expect(found).toBe(true);
  expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('merged');
  expect(await f.canonical()).toBe(MERGED);
});


it.each(['replacement-intent', 'replacement-ref', 'accepted-record', 'accepted-clear'] as const)('recovers an actual SIGKILL at %s without changing the cohort base', async (seam) => {
  const f = await fixture(); await expire(f.core); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL); await f.core.queueStaleCohort(c, f.m0);
  const before = await f.plugin.readQueue();
  if (seam.startsWith('replacement')) await f.core.adapter.write('.gitignore', 'excluded.md\n');
  const child = fork('tests/fixtures/stale-proposal-child.mjs', [f.dir, f.url, seam], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Publication seam timeout')), 15000);
      child.once('message', (message: any) => { clearTimeout(timer); expect(message.seam).toBe(seam); resolve(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before publication seam')); });
    });
    const killed = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL'); expect(await killed).toBe('SIGKILL');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  const next = await f.restart();
  if (seam.startsWith('replacement')) {
    const queue = await next.plugin.readQueue();
    expect(queue.pending_commit).not.toBe(before.pending_commit);
    expect(queue.pending_proposal_base).toBe(f.m0);
    expect(await next.core.resolveRef('refs/heads/local')).toBe(queue.pending_commit);
    expect((await next.core.readStaleProvenance()).intent.commit).toBe(queue.pending_commit);
    expect((await next.core.uploadQueuedCommit(queue)).status).toBe('merged');
  } else {
    if ((await next.plugin.readQueue()).pending_commit) await next.core.uploadQueuedCommit(await next.plugin.readQueue());
    const accepted = (await next.core.readStaleProvenance()).accepted_proposal;
    expect(accepted).toEqual({ commit: before.pending_commit, base: f.m0 });
    next.core.plugin.flushOpenMarkdownEditorsToDisk = async () => next.core.adapter.write('note.md', LOCAL); // Old buffer after result writes.
    await next.core.pullAndApply(true);
    await next.core.adapter.write('note.md', LOCAL);
    const state = await next.plugin.readState();
    await next.core.queueStaleCohort(state.local_main, state.server_device_ref);
    const queue = await next.plugin.readQueue();
    expect(queue.pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(queue)).status).toBe('merged');
  }
  expect(await f.canonical()).toBe(MERGED);
});

it.each(['folder-delete', 'file-split'] as const)('settles an in-horizon %s tombstone and its held fresh work without waiting', async (kind) => {
  const f = await fixture(); await expire(f.core);
  await f.core.adapter.mkdir('folder');
  await f.core.adapter.write('folder/note.md', 'folder bytes\n');
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  const otherDir = join(f.root, 'other'); await mkdir(otherDir);
  const other = new ObtsPluginClient(otherDir, { serverUrl: f.url, deviceName: 'directory-author' });
  const connection = await other.startOnboarding('fixture');
  expect((await f.server.app.inject({ method: 'POST', url: `/api/v1/connections/${connection.connection_id}/approve`, headers: f.headers,
    payload: { selection: 'existing_vault', vault_id: f.vaultId } })).statusCode).toBe(200);
  const analysis = await other.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  await other.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
  await mkdir(join(otherDir, 'folder', 'empty'));
  expect((await other.syncOnce()).status).toBe('Synced');
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  expect((await f.provenance()).horizons.some((h: any) => h.touched.some((p: string) => p === 'folder' || p.startsWith('folder/')))).toBe(true);
  await f.core.adapter.rmdir('folder', true);
  if (kind === 'file-split') await f.core.adapter.remove('untouched.md');
  else await f.core.adapter.write('untouched.md', 'fresh retained edit\n');
  expect((await f.plugin.syncOnce()).status).toBe('Ahead');
  expect((await f.plugin.syncOnce()).status).toBe('Checking');
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  const main = (await f.server.git.getRef(f.vaultId, 'refs/heads/main'))!;
  const files = await f.server.git.listTreePaths(f.vaultId, main);
  expect(files).not.toContain('folder/note.md');
  await expect(readFile(join(f.dir, 'folder', 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (kind === 'file-split') {
    expect(files).not.toContain('untouched.md');
    await expect(readFile(join(f.dir, 'untouched.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(await f.canonical('untouched.md')).toBe('fresh retained edit\n');
    expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe('fresh retained edit\n');
  }
  expect((await f.plugin.readQueue()).pending_commit).toBeNull();
  expect((await f.server.store.snapshot()).conflicts).toEqual([]);
});

it.each([false, true])('repairs corrupt evidence around immutable queued P/base and retains later disk work (later edit=%s)', async (laterEdit) => {
  const f = await fixture(); await expire(f.core); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL); await f.core.queueStaleCohort(c, f.m0);
  const original = await f.plugin.readQueue();
  const latest = LOCAL.replace('unchanged middle', 'later local middle');
  if (laterEdit) await f.core.adapter.write('note.md', latest);
  const corrupt = JSON.stringify({ version: 2, horizons: [null], obligations: {}, intent: null });
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), corrupt);
  const next = await f.restart();
  expect((await next.core.rebuildFromServerMain()).status).toBe('Ahead');
  const repaired = await next.plugin.readQueue();
  expect(repaired.pending_commit).toBe(original.pending_commit);
  expect(repaired.pending_proposal_base).toBe(original.pending_proposal_base);
  const evidence = await next.core.readStaleProvenance();
  expect(evidence.intent.commit).toBe(original.pending_commit);
  expect(evidence.intent.captures['note.md']).toBe(0);
  expect(evidence.obligations['note.md'].generation).toBeGreaterThanOrEqual(laterEdit ? 1 : 0);
  expect((await next.core.uploadQueuedCommit(repaired)).status).toBe('merged');
  expect(await f.canonical()).toBe(MERGED);
  await next.core.pullAndApply(true);
  if (laterEdit) {
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
    const followup = await next.plugin.readQueue();
    expect(followup.pending_commit).not.toBe(original.pending_commit);
    expect(followup.pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(followup)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED.replace('unchanged middle', 'later local middle'));
  }
});

it('blocks corrupt-evidence repair when the queued base object is missing, without discarding evidence', async () => {
  const f = await fixture(); await expire(f.core); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL); await f.core.queueStaleCohort(c, f.m0);
  const queue = await f.plugin.readQueue();
  await f.core.writeQueue({ ...queue, pending_proposal_base: 'f'.repeat(40) });
  const corrupt = JSON.stringify({ version: 2, horizons: [], obligations: { 'note.md': null }, intent: null });
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), corrupt);
  const next = await f.restart();
  await expect(next.core.rebuildFromServerMain()).rejects.toMatchObject({ code: 'stale_base_missing' });
  expect(await readFile(join(f.dir, '.obts', 'stale-provenance.json'), 'utf8')).toBe(corrupt);
  expect((await next.plugin.readQueue()).pending_commit).toBe(queue.pending_commit);
  const { readdir } = await import('node:fs/promises');
  const copies = await Promise.all((await readdir(join(f.dir, '.obts', 'recovery'))).map(async (bundle) => {
    try { return await readFile(join(f.dir, '.obts', 'recovery', bundle, 'journal', 'stale-provenance.json'), 'utf8'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; return null; }
  }));
  expect(copies).toContain(corrupt);
  expect(await f.canonical()).toBe(REMOTE);
});

it('uses canonical main when the accepted record is ambiguous or no longer owns local head', async () => {
  const f = await fixture(); await f.core.adapter.write('note.md', LOCAL);
  const p = await f.core.createLocalCommit('ambiguous accepted identity');
  const parsed = (await git.readCommit({ fs: f.core.fs, dir: f.dir, gitdir: f.core.gitdir, oid: p })).commit;
  await f.core.mutateStaleProvenance(async (saved: any) => {
    saved.accepted_proposal = { commit: p, base: null };
    saved.intent = { commit: p, tree: parsed.tree, parent: parsed.parent[0], base: f.m0, captures: {}, outcome: null, main: null };
  });
  const state = await f.plugin.readState();
  expect(await f.core.preApplyAuthoringBase(state, p)).toBe(f.m0);
  await f.core.mutateStaleProvenance(async (saved: any) => { saved.intent = null; });
  expect(await f.core.preApplyAuthoringBase({ ...state, local_head: f.m0 }, p)).toBe(f.m0);
});

it.each(['outcome', 'main', 'captures', 'replacement'] as const)('rejects a wrong-shaped terminal intent %s without a raw parser exception', async (field) => {
  const f = await fixture(); const c = await f.remote(); await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL); await f.core.queueStaleCohort(c, f.m0);
  const saved = await f.provenance(); saved.intent[field] = field === 'outcome' ? {} : null;
  if (field === 'main') { saved.intent.outcome = 'merged'; saved.intent.main = 123; }
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), JSON.stringify(saved));
  const next = await f.restart();
  expect((await next.plugin.readState()).last_error_code).toBe('stale_provenance_corrupt');
});

describe('provenance publication and rebuild seams', () => {
  it('R2 rebuild now preserves remote content', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.adapter.write('note.md', LOCAL);
    expect((await f.core.rebuildFromServerMain()).status).toBe('Ahead');
    const q = await f.plugin.readQueue();
    expect(q.pending_proposal_base).toBe(f.m0);
    expect((await git.readCommit({ fs: f.core.fs, dir: f.core.vaultDir, gitdir: f.core.gitdir, oid: q.pending_commit! })).commit.parent).toEqual([c]);
    expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });
  it.each(['intent', 'ref'])('R3 replacement recovers at %s seam', async (seam) => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const q = await f.plugin.readQueue();
    await f.core.adapter.write('.gitignore', 'excluded.md\n');
    const update = f.core.updateRef.bind(f.core);
    f.core.updateRef = async (ref: string, ...args: any[]) => {
      if (ref === 'refs/heads/local' && seam === 'intent')
        throw new Error('crash');
      const r = await update(ref, ...args);
      if (ref === 'refs/heads/local')
        throw new Error('crash');
      return r;
    };
    await expect(f.core.rebuildQueuedCommitForRootPolicy(q.pending_commit, await f.plugin.readState(), q)).rejects.toThrow('crash');
    f.core.updateRef = update;
    const n = await f.restart();
    const repaired = await n.plugin.readQueue();
    expect(repaired.pending_commit).not.toBe(q.pending_commit);
    expect(repaired.pending_proposal_base).toBe(f.m0);
    expect(await n.core.resolveRef('refs/heads/local')).toBe(repaired.pending_commit);
    expect((await n.core.uploadQueuedCommit(repaired)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });
  it('R4 settles and unpins, next edit is fresh', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    const capture = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
    await f.core.classifyStaleSnapshot(c, capture.snapshot);
    await f.core.adapter.write('note.md', REMOTE);
    await markHorizonsExpired(f.core);
    expect(await f.core.queueStaleCohort(c, f.m0)).toBe(false);
    expect((await f.core.readStaleProvenance()).obligations).toEqual({});
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
    await markHorizonsExpired(f.core);
    await f.core.queueStaleCohort(c, f.m0);
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBeNull();
    await f.core.adapter.write('note.md', REMOTE.replace('remote', 'observed edit'));
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical()).toBe(REMOTE.replace('remote', 'observed edit'));
  });
  it('R5 parser fails closed with recovery status', async () => {
    const f = await fixture();
    const corrupt = JSON.stringify({ version: 1, horizons: [], obligations: { 'note.md': null }, intent: null });
    await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), corrupt);
    const n = await f.restart();
    expect((await n.plugin.readState()).last_error_code).toBe('stale_provenance_corrupt');
    await expect(n.core.readStaleProvenance()).rejects.toMatchObject({ code: 'stale_provenance_corrupt' });
    expect(await readFile(join(f.dir, '.obts', 'stale-provenance.json'), 'utf8')).toBe(corrupt);
  });
  it.each(['read-complete', 'temp-write', 'rename'])('R1 retirement preserves oldest base at %s', async (seam) => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await markHorizonsExpired(f.core);
    await f.core.queueStaleCohort(c, f.m0);
    expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
    let queued: Promise<void> | undefined;
    let injected = false;
    const inject = () => {
      injected = true;
      queued = f.core.adapter.write('note.md', LOCAL);
    };
    if (seam === 'read-complete') {
      let retiring = false;
      const finish = f.core.finishApplyProvenance.bind(f.core);
      f.core.finishApplyProvenance = async (...args: any[]) => {
        retiring = true;
        try {
          return await finish(...args);
        }
        finally {
          retiring = false;
        }
      };
      const read = f.core.readRecoveryFileSnapshot.bind(f.core);
      f.core.readRecoveryFileSnapshot = async (p: string, ...args: any[]) => {
        const result = await read(p, ...args);
        if (retiring && !injected && p === 'note.md' && result.fingerprint.sha256)
          inject();
        return result;
      };
    }
    else {
      const write = f.core.fsp.writeFile.bind(f.core.fsp);
      let retired = false;
      f.core.fsp.writeFile = async (p: string, b: any, ...args: any[]) => {
        if (p.includes('stale-provenance.json.tmp-')) {
          const s = JSON.parse(b.toString());
          if (!s.obligations['note.md'] && !s.intent && s.horizons.some((h: any) => h.base === f.m0)) {
            retired = true;
            if (seam === 'temp-write' && !injected)
              inject();
          }
        }
        return write(p, b, ...args);
      };
      if (seam === 'rename') {
        const rename = f.core.fsp.rename.bind(f.core.fsp);
        f.core.fsp.rename = async (a: string, b: string, ...args: any[]) => {
          if (retired && !injected && a.includes('stale-provenance.json.tmp-'))
            inject();
          return rename(a, b, ...args);
        };
      }
    }
    await f.core.pullAndApply(true);
    await queued;
    expect(injected).toBe(true);
    const state = await f.plugin.readState();
    await f.core.queueStaleCohort(state.local_main, state.server_device_ref);
    const q = await f.plugin.readQueue();
    expect(q.pending_proposal_base).toBe(f.m0);
    expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    expect(await f.canonical()).toBe(MERGED);
  });
  it('F1 second apply before horizon expiry keeps the older obligation base', async () => {
    const f = await fixture();
    await f.remote();
    await f.core.pullAndApply(true);
    const second = await f.remote(REMOTE.replace('unchanged middle', 'second remote middle'));
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(second, f.m0);
    expect((await f.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
    const r = await f.core.uploadQueuedCommit(await f.plugin.readQueue());
    expect(['merged', 'conflicted']).toContain(r.status);
    expect(await f.canonical()).toContain('remote');
    expect(await f.canonical()).toContain('second remote middle');
  });
  it('F4 save admitted during no-op publication is not lost', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    const capture = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
    await f.core.classifyStaleSnapshot(c, capture.snapshot);
    await f.core.adapter.write('note.md', REMOTE);
    await markHorizonsExpired(f.core);
    const write = f.core.fsp.writeFile.bind(f.core.fsp);
    let queued: Promise<void> | undefined;
    f.core.fsp.writeFile = async (p: string, b: any, ...args: any[]) => {
      if (p.includes('stale-provenance.json.tmp-') && !queued) {
        const s = JSON.parse(b.toString());
        if (!s.obligations['note.md'] && s.horizons.some((h: any) => h.base === f.m0 && h.touched.includes('note.md')))
          queued = f.core.adapter.write('note.md', LOCAL);
      }
      return write(p, b, ...args);
    };
    await f.core.queueStaleCohort(c, f.m0);
    await queued;
    expect(queued).toBeDefined();
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical()).toBe(MERGED);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(MERGED);
  });
  it('F0 two quick ordinary uploads continue same-line typing without conflict', async () => {
    const f = await fixture();
    for (const text of [LOCAL, LOCAL.replace('local', 'newer local')]) {
      await f.core.adapter.write('note.md', text);
      const p = await f.core.createLocalCommit('quick typing');
      const state = await f.plugin.readState();
      await f.core.writeQueue({ pending_commit: p, expected_device_ref: state.server_device_ref, status: 'queued_local', attempts: 0 });
      expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
    }
    await f.core.adapter.write('note.md', LOCAL.replace('local', 'newest local'));
    await f.core.pullAndApply(true);
    for (let i = 0; i < 3; i++) {
      const r = await f.plugin.syncOnce();
      expect(r.status).not.toBe('Conflict resolution needed');
      if (r.status === 'Synced')
        break;
    }
    expect(await f.canonical()).toBe(LOCAL.replace('local', 'newest local'));
  });
  it('F0 accepted record does not poison same-vault re-pair', async () => {
    const f = await fixture();
    await f.core.adapter.write('note.md', LOCAL);
    const p = await f.core.createLocalCommit('before re-pair');
    await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
    await f.core.uploadQueuedCommit(await f.plugin.readQueue());
    await f.core.unpairCurrentDevice();
    await f.pair(f.plugin);
    await f.core.adapter.write('note.md', LOCAL.replace('local', 'repaired typing'));
    for (let i = 0; i < 3; i++) {
      const r = await f.plugin.syncOnce();
      expect(r.status).not.toBe('Conflict resolution needed');
      if (r.status === 'Synced')
        break;
    }
    expect(await f.canonical()).toBe(LOCAL.replace('local', 'repaired typing'));
  });
  it.each(['a/b', 'a/bc', 'Case', 'Caf\u00E9'])('F6 exact path/prefix lookup on %s', async (prefix) => {
    const f = await fixture();
    await markHorizonsExpired(f.core);
    await f.core.adapter.mkdir('a');
    await f.core.adapter.mkdir('a/b');
    await f.core.adapter.mkdir('a/bc');
    await f.core.adapter.mkdir('Case');
    await f.core.adapter.mkdir('Caf\u00E9');
    for (const p of ['a/b/x.md', 'a/bc/x.md', 'Case/x.md', 'Caf\u00E9/x.md'])
      await f.core.adapter.write(p, 'base\n');
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    await markHorizonsExpired(f.core);
    const state = await f.plugin.readState();
    await f.core.mutateStaleProvenance(async (s: any) => {
      s.horizons.push({ apply_id: 'apply_index_12345678', base: state.local_main, touched: [prefix], expiry: Date.now() + 60000 });
    });
    for (const p of ['a/b/x.md', 'a/bc/x.md', 'Case/x.md', 'Caf\u00E9/x.md'])
      await f.core.adapter.write(p, 'local\n');
    const snap = (await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(state.local_main), true)).snapshot;
    const stale = await f.core.classifyStaleSnapshot(state.local_main, snap);
    expect(stale).toEqual([prefix + '/x.md']);
  });
  it('F4 no-horizon live obligation: queued save at actual publication must retain M0', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    const capture = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
    await f.core.classifyStaleSnapshot(c, capture.snapshot);
    await f.core.mutateStaleProvenance(async (s: any) => {
      s.horizons = [];
    });
    await f.core.adapter.write('note.md', REMOTE);
    let queued: Promise<void> | undefined;
    let admittedBase: string | undefined;
    const write = f.core.fsp.writeFile.bind(f.core.fsp);
    f.core.fsp.writeFile = async (p: string, b: any, ...args: any[]) => {
      if (p.includes('stale-provenance.json.tmp-') && !queued) {
        const s = JSON.parse(b.toString());
        if (!s.obligations['note.md']) {
          admittedBase = (await f.core.readStaleProvenance()).obligations['note.md'].base;
          queued = f.core.adapter.write('note.md', LOCAL);
        }
      }
      return write(p, b, ...args);
    };
    await f.core.queueStaleCohort(c, f.m0);
    await queued;
    expect(admittedBase).toBe(f.m0);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(LOCAL);
    const r = await f.plugin.syncOnce();
    expect(r.status).toBe('Synced');
    expect(await f.canonical()).toBe(MERGED);
  });
  it('horizon expiry publication: old save after drain is the named boundary', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await markHorizonsExpired(f.core);
    let queued: Promise<void> | undefined;
    const write = f.core.fsp.writeFile.bind(f.core.fsp);
    f.core.fsp.writeFile = async (p: string, b: any, ...args: any[]) => {
      if (p.includes('stale-provenance.json.tmp-') && !queued) {
        const s = JSON.parse(b.toString());
        if (!s.horizons.length && !Object.keys(s.obligations).length)
          queued = f.core.adapter.write('note.md', LOCAL);
      }
      return write(p, b, ...args);
    };
    await f.core.queueStaleCohort(c, f.m0);
    await queued;
    expect(queued).toBeDefined();
    const r = await f.plugin.syncOnce();
    expect(await f.canonical()).toBe(LOCAL);
  });
  it('F2 rebuild with valid queued stale P retains later disk generation', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const q = await f.plugin.readQueue();
    const latest = LOCAL.replace('unchanged middle', 'later local middle');
    await f.core.adapter.write('note.md', latest);
    await f.core.recordLocalChangeHint(['note.md']);
    const rebuilt = await f.core.rebuildFromServerMain();
    expect(rebuilt.status).toBe('Ahead');
    expect(await f.plugin.readQueue()).toMatchObject({ pending_commit: q.pending_commit, pending_proposal_base: f.m0 });
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
    const saved = await f.core.readStaleProvenance();
    expect(saved.obligations['note.md'].base).toBe(f.m0);
    expect(saved.obligations['note.md'].generation).toBeGreaterThan(saved.intent.captures['note.md']);
    const bundles = await readdir(join(f.dir, '.obts', 'recovery'));
    const recovered = await Promise.all(bundles.map(async (b: string) => {
      try {
        return await readFile(join(f.dir, '.obts', 'recovery', b, 'files', 'note.md'), 'utf8');
      }
      catch {
        return null;
      }
    }));
    expect(recovered).toContain(latest);
    await f.core.uploadQueuedCommit(await f.plugin.readQueue());
    await f.core.pullAndApply(true);
    let status = '';
    for (let i = 0; i < 3; i++) {
      const r = await f.plugin.syncOnce();
      status = r.status;
      if (r.status === 'Synced')
        break;
    }
    expect(status).toBe('Synced');
    expect((await f.plugin.readQueue()).pending_commit).toBeNull();
    expect((await f.plugin.readState()).last_error_code).toBeNull();
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(MERGED.replace('unchanged middle', 'later local middle'));
    expect(await f.canonical()).toBe(MERGED.replace('unchanged middle', 'later local middle'));
  });
  it('F5 repair keeps deleted later disk generation with queued stale P', async () => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    await f.core.adapter.remove('note.md');
    await f.core.fsp.writeFile(f.core.staleProvenancePath, JSON.stringify({ version: 2, horizons: [null], obligations: {}, intent: null }));
    const n = await f.restart();
    expect((await n.core.rebuildFromServerMain()).status).toBe('Ahead');
    await expect(readFile(join(f.dir, 'note.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const s = await n.core.readStaleProvenance();
    expect(s.obligations['note.md'].signature).toBe('absent');
    expect(s.obligations['note.md'].generation).toBeGreaterThan(s.intent.captures['note.md']);
  });
  it.each(['writeTargetFilesFromJournal', 'retainApplyProvenance', 'clearApplyState'])('F1 old save at result %s completion await remains M0', async (method) => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await markHorizonsExpired(f.core);
    await f.core.queueStaleCohort(c, f.m0);
    await f.core.uploadQueuedCommit(await f.plugin.readQueue());
    let injected = false;
    let queued: Promise<void> | undefined;
    const original = f.core[method].bind(f.core);
    f.core[method] = async (...args: any[]) => {
      const result = await original(...args);
      if (!injected) {
        injected = true;
        queued = f.core.adapter.write('note.md', LOCAL);
      }
      return result;
    };
    await f.core.pullAndApply(true);
    await queued;
    expect(injected).toBe(true);
    const state = await f.plugin.readState();
    await f.core.queueStaleCohort(state.local_main, state.server_device_ref);
    const q = await f.plugin.readQueue();
    if (q.pending_commit) {
      expect(q.pending_proposal_base).toBe(f.m0);
      expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    }
    expect(await f.canonical()).toBe(MERGED);
  });
  it('F6 unchanged production index agrees with brute exact-prefix oracle', async () => {
    const source = await readFile('obsidian-plugin/src/main.cjs', 'utf8');
    const begin = source.indexOf('function indexPaths(entries) {');
    const end = source.indexOf('\nfunction changedPathsConflict', begin);
    expect(begin).toBeGreaterThan(0);
    const indexPaths = Function(source.slice(begin, end) + '\nreturn indexPaths;')();
    const paths = ['a', 'a/b', 'a/b/x', 'a/bc', 'a/bc/y', 'a/b2', 'A/B', 'A/b', 'Caf\u00E9', 'Caf\u00E9/x', 'Cafe\u0301/x', 'caf\u00E9/x', '\uD83D\uDE00/\u00E9', '\uD83D\uDE00/\u00E9/x', '\uD83D\uDE00/\u00E92/x'];
    const entries: [string, number][] = paths.flatMap((p, i): [string, number][] => [[p, 2 * i], [p, 2 * i + 1]]);
    const index = indexPaths(entries);
    for (const p of [...paths, 'a/b/z', 'a/bc/x', 'A', '\uD83D\uDE00', 'Caf', 'no/match']) {
      const brute = entries.filter(([q]) => q === p || q.startsWith(p + '/') || p.startsWith(q + '/')).map(([, v]) => v).sort((a, b) => Number(a) - Number(b));
      expect(index.overlap(p).sort((a: number, b: number) => a - b)).toEqual(brute);
      const descendants = entries.filter(([q]) => q.startsWith(p + '/')).map(([, v]) => v).sort((a, b) => Number(a) - Number(b));
      expect(index.descendants(p).map(([, v]: any) => v).sort((a: number, b: number) => a - b)).toEqual(descendants);
    }
  });
});


it('keeps the no-op handover pin through its own expiry and subsequent adapter drain', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  const capture = await f.core.localChangedPathsFromTree(await f.core.listTreeBlobOids(c), true);
  await f.core.classifyStaleSnapshot(c, capture.snapshot);
  await f.core.adapter.write('note.md', REMOTE);
  await markHorizonsExpired(f.core);
  const before = Date.now();
  expect(await f.core.queueStaleCohort(c, f.m0)).toBe(false);
  const saved = await f.provenance();
  expect(saved.obligations).toEqual({});
  expect(saved.horizons).toEqual([expect.objectContaining({ base: f.m0, touched: ['note.md'] })]);
  expect(saved.horizons[0].expiry).toBeGreaterThanOrEqual(before + 3000);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
  await markHorizonsExpired(f.core);
  let release!: () => void;
  f.core.adapter.promise = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const settlement = f.core.queueStaleCohort(c, f.m0).then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(completed).toBe(false);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
  release();
  await settlement;
  expect((await f.provenance()).horizons).toEqual([]);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBeNull();
});

it('publishes a covering old-base horizon when conflict ownership removes obligations', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', BASE.replace('first', 'overlapping local'));
  await f.core.queueStaleCohort(c, f.m0);
  const q = await f.plugin.readQueue();
  const write = f.core.fsp.writeFile.bind(f.core.fsp);
  let queued: Promise<void> | undefined;
  f.core.fsp.writeFile = async (path: string, bytes: any, ...args: any[]) => {
    if (path.includes('stale-provenance.json.tmp-') && !queued) {
      const saved = JSON.parse(bytes.toString());
      if (saved.intent?.outcome === 'conflicted' && !saved.obligations['note.md']) {
        expect(saved.horizons.some((h: any) => h.base === f.m0 && h.touched.includes('note.md'))).toBe(true);
        queued = f.core.adapter.write('note.md', LOCAL);
      }
    }
    return write(path, bytes, ...args);
  };
  expect((await f.core.uploadQueuedCommit(q)).status).toBe('conflicted');
  await queued;
  expect(queued).toBeDefined();
  expect(await f.canonical()).toBe(REMOTE);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(LOCAL);
  expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
});

describe('idle settlement of elapsed stale provenance', () => {
  const APPLIED = BASE.replace('last', 'remote last');
  const APPENDED = `${APPLIED}appended one\nappended two\n`;

  // An idle device must end elapsed horizons and retire settled obligations in
  // the background, not lazily inside the next edit's scan.
  async function idleTicks(f: Awaited<ReturnType<typeof fixture>>) {
    for (let round = 0; round < 3; round += 1) {
      await markHorizonsExpired(f.core);
      await f.plugin.maintenanceTick();
    }
  }

  it('proposes a later append on the applied main after an idle apply horizon elapses', async () => {
    const f = await fixture();
    await f.remote(APPLIED);
    await f.core.pullAndApply(true);
    // The first background check lands inside the horizon and records the scan.
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect((await f.provenance()).horizons).not.toEqual([]);
    await idleTicks(f);
    expect(await f.provenance()).toMatchObject({ horizons: [], obligations: {} });
    expect(await f.plugin.maintenanceTick()).toMatchObject({ sync_performed: false, scan_mode: 'none' });
    await f.core.adapter.write('note.md', APPENDED);
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical()).toBe(APPENDED);
    expect((await f.server.store.snapshot()).conflicts).toEqual([]);
  });

  it('proposes an append after an applied conflict resolution on the resolved main', async () => {
    const f = await fixture();
    await f.remote(APPLIED);
    const original = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await f.core.adapter.write('note.md', BASE.replace('last', 'device last'));
      }
      return original(...args);
    };
    await f.core.pullAndApply(true);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    const conflict = (await f.server.store.snapshot()).conflicts.find((r) => r.status === 'open')!;
    expect(conflict.base_commit).toBe(f.m0);
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}` });
    const resolved = BASE.replace('last', 'remote last\ndevice last');
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'manual', manual_files: { 'note.md': resolved } }
    })).statusCode).toBe(200);
    // Conflict review only polls; the poll applies the resolution.
    await f.plugin.pollRemoteEventsAndApply();
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(resolved);
    expect((await f.plugin.readState()).last_error_code).toBeNull();
    expect((await f.plugin.maintenanceTick()).sync_performed).toBe(true);
    expect((await f.provenance()).horizons).not.toEqual([]);
    await idleTicks(f);
    const appended = `${resolved}appended one\nappended two\n`;
    await f.core.adapter.write('note.md', appended);
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical()).toBe(appended);
    expect((await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open')).toEqual([]);
  });

  it('still proposes an edit made inside the horizon against the authoring base', async () => {
    const f = await fixture();
    await f.remote(APPLIED);
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', BASE.replace('first', 'old buffer first'));
    await markHorizonsExpired(f.core);
    expect(await f.plugin.maintenanceTick()).toMatchObject({ sync_performed: true });
    expect(await f.canonical()).toBe(APPLIED.replace('first', 'old buffer first'));
    expect((await f.server.store.snapshot()).conflicts).toEqual([]);
  });

  it('does not wake for elapsed horizons while conflict review blocks sync', async () => {
    const f = await fixture();
    await f.remote();
    await f.core.pullAndApply(true);
    await f.core.recordScanCompleted(false);
    expect(await f.core.backgroundScanDecision()).toEqual({ required: false, mode: 'none' });
    await markHorizonsExpired(f.core);
    expect(await f.core.backgroundScanDecision()).toEqual({ required: true, mode: 'incremental' });
    await f.core.writeState({ ...(await f.plugin.readState()), last_error_code: 'conflict_review_required' });
    expect(await f.core.backgroundScanDecision()).toEqual({ required: false, mode: 'none' });
  });

  it('wakes the host background check just after the earliest pending horizon, once', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    vi.stubGlobal('window', globalThis);
    try {
      const ArtifactPlugin = createRequire(import.meta.url)('../obsidian-plugin/src/main.cjs') as any;
      let settleAt: number | null = Date.now() + 3000;
      const host: any = Object.assign(Object.create(ArtifactPlugin.prototype), {
        unloaded: false, clientReady: true, staleSettleTimer: null, staleSettleAt: null,
        client: { staleProvenanceSettleAt: async () => settleAt },
        runBackgroundSync: vi.fn(async () => undefined)
      });
      host.scheduleStaleProvenanceSettle();
      await vi.advanceTimersByTimeAsync(0);
      settleAt = Date.now() + 5000;
      host.scheduleStaleProvenanceSettle();
      await vi.advanceTimersByTimeAsync(3000);
      expect(host.runBackgroundSync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(host.runBackgroundSync).toHaveBeenCalledTimes(1);
      settleAt = null;
      host.scheduleStaleProvenanceSettle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(host.runBackgroundSync).toHaveBeenCalledTimes(1);
      settleAt = Date.now() + 1000;
      host.scheduleStaleProvenanceSettle();
      await vi.advanceTimersByTimeAsync(0);
      host.clearStaleSettleTimer();
      await vi.advanceTimersByTimeAsync(5000);
      expect(host.runBackgroundSync).toHaveBeenCalledTimes(1);
      const ended: any = Object.assign(Object.create(ArtifactPlugin.prototype), {
        app: { vault: { adapter: {} } }, clearOperationProgress: () => undefined, scheduleStaleProvenanceSettle: vi.fn()
      });
      ended.endSync();
      expect(ended.scheduleStaleProvenanceSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('reports the earliest future horizon expiry for the host wake-up only', async () => {
    const f = await fixture();
    await expire(f.core);
    expect(await f.core.staleProvenanceSettleAt()).toBeNull();
    await f.remote();
    await f.core.pullAndApply(true);
    const [horizon] = (await f.provenance()).horizons;
    expect(await f.core.staleProvenanceSettleAt()).toBe(horizon.expiry);
    await markHorizonsExpired(f.core);
    expect(await f.core.staleProvenanceSettleAt()).toBeNull();
  });
});

it('does not interpret a locally excluded queued path as a later deletion during rebuild', async () => {
  const f = await fixture();
  const c = await f.remote();
  await f.core.pullAndApply(true);
  await f.core.adapter.write('note.md', LOCAL);
  await f.core.queueStaleCohort(c, f.m0);
  await f.core.adapter.write('.gitignore', 'untouched.md\n');
  expect((await f.core.rebuildFromServerMain()).status).toBe('Ahead');
  expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe('unchanged\n');
});


describe('queued proposal-derived rebuild work', () => {
  it.each([true, false])('ordinary single-device queued typing remains conflict-free; rebuild=%s', async (rebuild) => {
    const f = await fixture();
    await expire(f.core);
    await f.core.queueStaleCohort(f.m0, f.m0);
    await f.core.adapter.write('note.md', LOCAL);
    const p = await f.core.createLocalCommit('first typed line');
    await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
    const latest = LOCAL.replace('local', 'continued local');
    await f.core.adapter.write('note.md', latest);
    if (rebuild)
      await f.core.rebuildFromServerMain();
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
    let status = '';
    for (let i = 0; i < 4; i++) {
      status = (await f.plugin.syncOnce()).status;
      if (status === 'Synced' || (await f.plugin.readState()).last_error_code === 'conflict_review_required')
        break;
    }
    expect(status).toBe('Synced');
    expect(await f.canonical()).toBe(latest);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
  });
  it.each([true, false])('STALE P continued same-line typing; rebuild=%s conservatively keeps M0', async (rebuild) => {
    const f = await fixture();
    const c = await f.remote();
    await f.core.pullAndApply(true);
    await f.core.adapter.write('note.md', LOCAL);
    await f.core.queueStaleCohort(c, f.m0);
    const p = (await f.plugin.readQueue()).pending_commit;
    const latest = LOCAL.replace('local', 'continued local');
    await f.core.adapter.write('note.md', latest);
    if (rebuild)
      await f.core.rebuildFromServerMain();
    let status = '';
    for (let i = 0; i < 4; i++) {
      status = (await f.plugin.syncOnce()).status;
      if ((await f.plugin.readState()).last_error_code === 'conflict_review_required' || status === 'Synced')
        break;
    }
    expect((await f.plugin.readState()).last_error_code).toBe('conflict_review_required');
    expect(await f.canonical()).toBe(MERGED);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
    expect((await f.core.readStaleProvenance()).horizons.some((h: any) => h.base === f.m0 && h.touched.includes('note.md'))).toBe(true);
  });
  it.each(['ordinary', 'stale'])('non-P path later typing remains conflict-free with %s P', async (kind) => {
    const f = await fixture();
    let parent = f.m0;
    if (kind === 'stale') {
      parent = await f.remote();
      await f.core.pullAndApply(true);
    }
    else {
      await expire(f.core);
      await f.core.queueStaleCohort(f.m0, f.m0);
    }
    await f.core.adapter.write('note.md', LOCAL);
    if (kind === 'stale')
      await f.core.queueStaleCohort(parent, f.m0);
    else {
      const p = await f.core.createLocalCommit('ordinary P');
      await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
    }
    const q = await f.plugin.readQueue();
    const latest = 'continued untouched\n';
    await f.core.adapter.write('untouched.md', latest);
    await f.core.rebuildFromServerMain();
    expect((await f.plugin.readQueue()).pending_commit).toBe(q.pending_commit);
    expect((await f.core.readStaleProvenance()).obligations['untouched.md'].base).toBe(kind === 'stale' ? f.m0 : parent);
    expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe(latest);
    let status = '';
    for (let i = 0; i < 4; i++) {
      status = (await f.plugin.syncOnce()).status;
      if (status === 'Synced')
        break;
    }
    expect(status).toBe('Synced');
    expect(await f.canonical('untouched.md')).toBe(latest);
    expect(await f.canonical()).toBe(kind === 'stale' ? MERGED : LOCAL);
    expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe(latest);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(kind === 'stale' ? MERGED : LOCAL);
  });
  it.each([false, true])('proposed P-base obligation can be pinned before server knows P and uploaded after acceptance; rebuild=%s', async (rebuild) => {
    const f = await fixture();
    await expire(f.core);
    await f.core.queueStaleCohort(f.m0, f.m0);
    await f.core.adapter.write('note.md', LOCAL);
    const p = await f.core.createLocalCommit('ordinary P');
    await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
    const latest = LOCAL.replace('local', 'continued local');
    await f.core.adapter.write('note.md', latest);
    expect(await f.server.git.commitExists(f.vaultId, p)).toBe(false);
    if (rebuild)
      await f.core.rebuildFromServerMain();
    await f.core.mutateStaleProvenance(async (s: any) => {
      s.obligations['note.md'] = { base: p, generation: 1, signature: 'uncaptured' };
    });
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${p}`)).toBe(p);
    expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('merged');
    await f.core.pullAndApply(true);
    let q = await f.plugin.readQueue();
    if (!q.pending_commit) {
      const s = await f.plugin.readState();
      await f.core.queueStaleCohort(s.local_main, s.server_device_ref);
      q = await f.plugin.readQueue();
    }
    expect(q.pending_proposal_base).toBe(p);
    const c = (await f.plugin.readState()).local_main;
    expect(await f.core.isAncestor(p, c)).toBe(true);
    expect((await f.core.uploadQueuedCommit(q)).status).toBe('merged');
    await f.core.pullAndApply(true);
    expect(await f.canonical()).toBe(latest);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(latest);
  });
});
async function ordinaryHeldFixture() {
  const f = await fixture();
  await expire(f.core);
  await f.core.adapter.write('note.md', LOCAL);
  const p = await f.core.createLocalCommit('ordinary typed proposal');
  await f.core.writeQueue({ pending_commit: p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
  const latest = LOCAL.replace('local', 'continued local');
  await f.core.adapter.write('note.md', latest);
  return { ...f, p, latest };
}
async function syncHeldExactly(f: Awaited<ReturnType<typeof ordinaryHeldFixture>>, plugin = f.plugin) {
  let status = '';
  for (let i = 0; i < 4 && status !== 'Synced'; i++)
    status = (await plugin.syncOnce()).status;
  expect(status).toBe('Synced');
  expect(await f.canonical()).toBe(f.latest);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
}
it.each(['held-rebuild', 'accepted-record', 'accepted-clear'] as const)('keeps held-P identity across SIGKILL at %s', async (seam) => {
  const f = await ordinaryHeldFixture();
  if (seam !== 'held-rebuild')
    await f.core.rebuildFromServerMain();
  const child = fork('tests/fixtures/stale-proposal-child.mjs', [f.dir, f.url, seam], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Held publication seam timeout')), 20000);
      child.once('message', (message: any) => {
        clearTimeout(timer);
        expect(message.seam).toBe(seam);
        resolve();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Child exited before held seam'));
      });
    });
    const killed = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL');
    expect(await killed).toBe('SIGKILL');
  }
  finally {
    if (child.exitCode === null)
      child.kill('SIGKILL');
  }
  const next = await f.restart();
  expect((await next.core.readStaleProvenance()).held_proposals[0]).toMatchObject({ commit: f.p, recorded_main: f.m0, fallbacks: { 'note.md': f.m0 } });
  expect(await next.core.resolveRef(`refs/obts/stale-bases/${f.p}`)).toBe(f.p);
  await syncHeldExactly(f, next.plugin);
});
it('falls back held work to the recorded pre-rebuild base when P conflicts', async () => {
  const f = await ordinaryHeldFixture();
  const remote = LOCAL.replace('local', 'remote same line');
  await f.remote(remote);
  await f.core.rebuildFromServerMain();
  expect((await f.core.readStaleProvenance()).held_proposals[0].fallbacks['note.md']).toBe(f.m0);
  expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('conflicted');
  expect((await f.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.m0);
  expect(await f.canonical()).toBe(remote);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
});
it.each(['replacement-intent', 'replacement-ref'] as const)('carries held P through root-policy %s and restart', async (seam) => {
  const f = await ordinaryHeldFixture();
  await f.core.rebuildFromServerMain();
  await f.core.adapter.write('.gitignore', 'excluded.md\n');
  const child = fork('tests/fixtures/stale-proposal-child.mjs', [f.dir, f.url, seam], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Held replacement seam timeout')), 20000);
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Child exited before held replacement seam'));
      });
    });
    const killed = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL');
    expect(await killed).toBe('SIGKILL');
  }
  finally {
    if (child.exitCode === null)
      child.kill('SIGKILL');
  }
  const next = await f.restart();
  const q = await next.plugin.readQueue();
  expect(q.pending_commit).not.toBe(f.p);
  expect(q.pending_proposal_base).toBeNull();
  expect((await next.core.readStaleProvenance()).held_proposals[0]).toMatchObject({ commit: q.pending_commit, fallbacks: { 'note.md': f.m0 } });
  await syncHeldExactly(f, next.plugin);
});
it.each(['obligation', 'horizon'] as const)('keeps an earlier independent %s older than held P', async (kind) => {
  const f = await ordinaryHeldFixture();
  await f.core.mutateStaleProvenance(async (saved: any) => {
    if (kind === 'obligation')
      saved.obligations['note.md'] = { base: f.m0, generation: 1, signature: 'uncaptured' };
    else
      saved.horizons.push({ apply_id: 'apply_earlier_independent', base: f.m0, touched: ['note.md'], expiry: Date.now() + 60000 });
  });
  await f.core.rebuildFromServerMain();
  expect((await f.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.m0);
  await f.core.uploadQueuedCommit(await f.plugin.readQueue());
  await f.core.pullAndApply(true);
  expect((await f.plugin.readQueue()).pending_proposal_base).toBe(f.m0);
  expect((await f.core.uploadQueuedCommit(await f.plugin.readQueue())).status).toBe('conflicted');
  expect(await f.canonical()).toBe(LOCAL);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
});
it('keeps held deletion and a directory replacement visible through acceptance', async () => {
  const f = await ordinaryHeldFixture();
  await f.core.adapter.remove('note.md');
  await f.core.adapter.mkdir('note.md');
  await f.core.adapter.write('note.md/child.md', 'continued child\n');
  await f.core.rebuildFromServerMain();
  const held = (await f.core.readStaleProvenance()).held_proposals[0];
  expect(held.fallbacks).toEqual({ 'note.md': f.m0, 'note.md/child.md': f.m0 });
  expect(await readFile(join(f.dir, 'note.md/child.md'), 'utf8')).toBe('continued child\n');
  let status = '';
  for (let i = 0; i < 4 && status !== 'Synced'; i++)
    status = (await f.plugin.syncOnce()).status;
  expect(status).toBe('Synced');
  expect(await f.canonical('note.md/child.md')).toBe('continued child\n');
  expect((await f.core.listTreeBlobOids((await f.plugin.readState()).local_main)).has('note.md')).toBe(false);
  expect(await readFile(join(f.dir, 'note.md/child.md'), 'utf8')).toBe('continued child\n');
});
it('holds continued work when rebuild discovers P already accepted', async () => {
  const f = await ordinaryHeldFixture();
  await f.core.uploadQueuedCommit(await f.plugin.readQueue());
  await f.core.writeQueue({ pending_commit: f.p, expected_device_ref: f.m0, status: 'queued_local', attempts: 0 });
  await f.core.rebuildFromServerMain();
  await syncHeldExactly(f);
});
it.each([null, {}, { commit: 'bad' }])('fails closed on malformed held evidence %j', async (held) => {
  const f = await ordinaryHeldFixture();
  await f.core.rebuildFromServerMain();
  const saved = await f.core.readStaleProvenance();
  saved.held_proposals = [held];
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), JSON.stringify(saved));
  await expect(f.core.readStaleProvenance()).rejects.toMatchObject({ code: 'stale_provenance_corrupt' });
});
it.each(['replacement-intent', 'replacement-ref'] as const)('recovers root-policy replacement after a canonical rebuild reset with no held work at %s', async (seam) => {
  const f = await ordinaryHeldFixture();
  await f.core.adapter.write('note.md', LOCAL);
  await f.core.rebuildFromServerMain();
  expect((await f.core.readStaleProvenance()).held_proposals).toEqual([]);
  await f.core.adapter.write('.gitignore', 'excluded.md\n');
  const child = fork('tests/fixtures/stale-proposal-child.mjs', [f.dir, f.url, seam], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reset replacement seam timeout')), 20000);
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Child exited before reset seam'));
      });
    });
    const killed = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL');
    expect(await killed).toBe('SIGKILL');
  }
  finally {
    if (child.exitCode === null)
      child.kill('SIGKILL');
  }
  const next = await f.restart();
  expect((await next.plugin.readQueue()).pending_commit).not.toBe(f.p);
  await syncHeldExactly({ ...f, latest: LOCAL }, next.plugin);
});
it('reconstructs ordinary held P from immutable queue evidence during corrupt-evidence repair', async () => {
  const f = await ordinaryHeldFixture();
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
  const next = await f.restart();
  await next.core.rebuildFromServerMain();
  expect((await next.core.readStaleProvenance()).held_proposals[0].commit).toBe(f.p);
  expect((await next.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.p);
  await syncHeldExactly(f, next.plugin);
});
it('preserves unproven empty-directory intents at a conservative fallback base', async () => {
  const f = await ordinaryHeldFixture();
  await f.core.adapter.mkdir('empty');
  await f.core.reconcileDirectoryState(await f.core.scanSyncableFiles(), (await f.core.listLocalVaultInventory('')).directories);
  const before = (await f.core.readDirectoryState()).pending_intents.filter((i: any) => i.path === 'empty');
  expect(before).toHaveLength(1);
  await f.core.rebuildFromServerMain();
  expect((await f.core.readStaleProvenance()).held_proposals[0].footprint).not.toContain('empty');
  expect((await f.core.readDirectoryState()).pending_intents.filter((i: any) => i.path === 'empty')).toEqual(before);
  await syncHeldExactly(f);
  expect((await f.core.listLocalVaultInventory('')).directories).toContain('empty');
  expect((await f.core.readDirectoryState()).pending_intents.filter((i: any) => i.path === 'empty')).toEqual([]);
});
it('retains the directory fallback when remote adds a descendant before rebuild', async () => {
  const f = await fixture();
  await f.core.adapter.mkdir('empty');
  expect((await f.plugin.syncOnce()).status).toBe('Synced');
  await expire(f.core);
  const recordedMain = (await f.plugin.readState()).local_main;
  await f.core.adapter.write('note.md', LOCAL);
  const p = await f.core.createLocalCommit('ordinary P before directory removal');
  await f.core.writeQueue({ pending_commit: p, expected_device_ref: (await f.plugin.readState()).server_device_ref, status: 'queued_local', attempts: 0 });
  await f.core.adapter.rmdir('empty', true);
  await f.core.reconcileDirectoryState(await f.core.scanSyncableFiles(), (await f.core.listLocalVaultInventory('')).directories);
  const intent = (await f.core.readDirectoryState()).pending_intents.find((i: any) => i.path === 'empty');
  expect(intent.op).toBe('delete');
  expect(intent.base_main).toBe(recordedMain);
  await f.remote(BASE, { 'empty/remote.md': 'remote descendant\n' });
  await f.core.rebuildFromServerMain();
  expect((await f.core.readStaleProvenance()).obligations.empty.base).toBe(recordedMain);
  expect((await f.core.readStaleProvenance()).held_proposals.some((h: any) => Object.hasOwn(h.fallbacks, 'empty'))).toBe(false);
  const result = await f.core.uploadQueuedCommit(await f.plugin.readQueue());
  expect(result.status).toBe('merged');
  // Existing stale-descendant tombstone policy retains independently authored bytes.
  expect(await f.canonical('empty/remote.md')).toBe('remote descendant\n');
  expect(await f.canonical()).toBe(LOCAL);
});

it('falls back when held P has no matching durable queue or accepted owner', async () => {
  const f = await ordinaryHeldFixture();
  await f.core.rebuildFromServerMain();
  await f.core.writeQueue({ pending_commit: null, expected_device_ref: f.m0, status: 'queued_local', attempts: 0, changed_paths: ['note.md'] });
  const remote = LOCAL.replace('local', 'independent remote');
  await f.remote(remote);
  let status = '';
  for (let i = 0; i < 4; i++) {
    status = (await f.plugin.syncOnce()).status;
    if ((await f.plugin.readState()).last_error_code === 'conflict_review_required') break;
  }
  expect((await f.plugin.readState()).last_error_code).toBe('conflict_review_required');
  expect(status).not.toBe('Synced');
  expect(await f.canonical()).toBe(remote);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
});

it.each(['recorded_main', 'terminal_main', 'queued_replacement'] as const)('rejects missing or inconsistent held %s evidence', async (kind) => {
  const f = await ordinaryHeldFixture(); await f.core.rebuildFromServerMain();
  const saved = await f.core.readStaleProvenance();
  if (kind === 'recorded_main') delete saved.held_proposals[0].recorded_main;
  else if (kind === 'terminal_main') saved.held_proposals[0].outcome = 'merged';
  else delete saved.queued_replacement;
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), JSON.stringify(saved));
  await expect(f.core.readStaleProvenance()).rejects.toMatchObject({ code: 'stale_provenance_corrupt' });
});

// F5 must classify from the original protected refs, before publishing repair pins.
describe('corrupt held-P provenance repair', () => {
  it.each([false, true])('keeps an independent older obligation conservative; corrupt=%s', async (corrupt) => {
    const f = await ordinaryHeldFixture();
    await f.core.queueStaleCohort(f.m0, f.m0);
    await f.core.mutateStaleProvenance(async (saved: any) => {
      saved.obligations['note.md'] = { base: f.m0, generation: 1, signature: 'uncaptured' };
    });
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
    if (corrupt) await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
    const next = await f.restart();
    await next.core.rebuildFromServerMain();
    const saved = await next.core.readStaleProvenance();
    expect(saved.obligations['note.md'].base).toBe(f.m0);
    expect(saved.held_proposals[0].fallbacks['note.md']).toBe(f.m0);
    await next.core.uploadQueuedCommit(await next.plugin.readQueue());
    await next.core.pullAndApply(true);
    const queue = await next.plugin.readQueue();
    expect(queue.pending_proposal_base).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(queue)).status).toBe('conflicted');
    expect(await f.canonical()).toBe(LOCAL);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
  });

  it('never advances the recorded fallback after remote rebuild then corruption', async () => {
    const f = await ordinaryHeldFixture();
    const remote = LOCAL.replace('local', 'independent remote');
    const c = await f.remote(remote);
    await f.core.rebuildFromServerMain();
    expect((await f.core.readStaleProvenance()).held_proposals[0].fallbacks['note.md']).toBe(f.m0);
    expect((await f.plugin.readState()).local_main).toBe(c);
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
    await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
    const next = await f.restart();
    await next.core.rebuildFromServerMain();
    expect((await next.core.readStaleProvenance()).held_proposals[0].fallbacks['note.md']).toBe(f.m0);
    expect((await next.core.uploadQueuedCommit(await next.plugin.readQueue())).status).toBe('conflicted');
    expect((await next.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.m0);
    expect(await f.canonical()).toBe(remote);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
  });

  it('applies an original older pin from another path to every repair path', async () => {
    const f = await ordinaryHeldFixture();
    await f.core.queueStaleCohort(f.m0, f.m0);
    await f.core.mutateStaleProvenance(async (saved: any) => {
      saved.obligations['untouched.md'] = { base: f.m0, generation: 1, signature: 'uncaptured' };
    });
    expect(await f.core.resolveRef(`refs/obts/stale-bases/${f.m0}`)).toBe(f.m0);
    await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
    const next = await f.restart();
    await next.core.rebuildFromServerMain();
    expect((await next.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.m0);
    for (let i = 0; i < 4; i++) {
      await next.plugin.syncOnce();
      if ((await next.plugin.readState()).last_error_code === 'conflict_review_required') break;
    }
    expect((await next.plugin.readState()).last_error_code).toBe('conflict_review_required');
    expect(await f.canonical()).toBe(LOCAL);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
    expect(await f.canonical('untouched.md')).toBe('unchanged\n');
    expect(await readFile(join(f.dir, 'untouched.md'), 'utf8')).toBe('unchanged\n');
  });

  it('keeps M0 after root-policy succession then corruption and fails closed on replacement', async () => {
    const f = await ordinaryHeldFixture();
    await f.core.queueStaleCohort(f.m0, f.m0);
    await f.core.mutateStaleProvenance(async (saved: any) => {
      saved.obligations['note.md'] = { base: f.m0, generation: 1, signature: 'uncaptured' };
    });
    await f.core.rebuildFromServerMain();
    await f.core.adapter.write('.gitignore', 'excluded.md\n');
    const replacement = await f.core.rebuildQueuedCommitForRootPolicy(f.p, await f.plugin.readState(), await f.plugin.readQueue());
    expect(replacement.queue.pending_commit).not.toBe(f.p);
    const successor = replacement.queue.pending_commit;
    expect((await f.core.readBlob(successor, '.gitignore')).toString()).toBe('excluded.md\n');
    expect(await readFile(join(f.dir, '.gitignore'), 'utf8')).toBe((await f.core.readBlob(successor, '.gitignore')).toString());
    await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
    const next = await f.restart();
    await next.core.rebuildFromServerMain();
    expect((await next.core.readStaleProvenance()).obligations['note.md'].base).toBe(f.m0);
    const assertHiddenSuccessor = async () => {
      // Bytes identical to queued P' stay hidden until acceptance, not lost.
      await expect(readFile(join(f.dir, '.gitignore'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await next.core.readBlob(successor, '.gitignore')).toString()).toBe('excluded.md\n');
      expect((await next.plugin.readQueue()).pending_commit).toBe(successor);
      expect(await next.core.resolveRef(`refs/obts/stale-bases/${successor}`)).toBe(successor);
    };
    await assertHiddenSuccessor();
    const beforeRef = await next.core.resolveRef('refs/heads/local');
    const beforeState = await next.plugin.readState();
    const beforeQueue = await next.plugin.readQueue();
    const beforeEvidence = await next.core.readStaleProvenance();
    // Unknown replacement ownership must not be guessed from repaired bytes.
    await expect(next.core.rebuildQueuedCommitForRootPolicy(beforeQueue.pending_commit, beforeState, beforeQueue))
      .rejects.toMatchObject({ code: 'stale_intent_mismatch' });
    expect(await next.core.resolveRef('refs/heads/local')).toBe(beforeRef);
    expect(await next.plugin.readQueue()).toEqual(beforeQueue);
    expect((await next.plugin.readState()).local_head).toBe(beforeState.local_head);
    expect(await next.core.readStaleProvenance()).toEqual(beforeEvidence);
    expect(await f.canonical()).toBe(BASE);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
    await assertHiddenSuccessor();
    await expect(next.plugin.syncOnce()).rejects.toMatchObject({ code: 'stale_intent_mismatch' });
    const { updated_at: _beforeUpdatedAt, ...beforeQueueFields } = beforeQueue;
    const { updated_at: _afterUpdatedAt, ...afterQueueFields } = await next.plugin.readQueue();
    // The existing upload-error handler refreshes only the queue timestamp.
    expect(afterQueueFields).toEqual(beforeQueueFields);
    expect(await next.core.resolveRef('refs/heads/local')).toBe(beforeRef);
    const afterState = await next.plugin.readState();
    expect(afterState.local_head).toBe(beforeState.local_head);
    expect(afterState.last_error_code).toBe('stale_intent_mismatch');
    expect(afterState.status_label).toBe('Out of sync');
    expect(await next.core.readStaleProvenance()).toEqual(beforeEvidence);
    expect(await f.canonical()).toBe(BASE);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
    await assertHiddenSuccessor();
  });
});

it('fails closed rather than selecting a newer held base from incomparable original pins', async () => {
  const f = await ordinaryHeldFixture();
  const parsed = (await git.readCommit({ fs: f.core.fs, dir: f.dir, gitdir: f.core.gitdir, oid: f.p })).commit;
  const sibling = await git.writeCommit({ fs: f.core.fs, dir: f.dir, gitdir: f.core.gitdir,
    commit: { ...parsed, message: 'independent protected branch\n' } });
  expect(await f.core.isAncestor(sibling, f.p)).toBe(false);
  expect(await f.core.isAncestor(f.p, sibling)).toBe(false);
  await git.writeRef({ fs: f.core.fs, dir: f.dir, gitdir: f.core.gitdir,
    ref: `refs/obts/stale-bases/${sibling}`, value: sibling, force: true });
  await writeFile(join(f.dir, '.obts', 'stale-provenance.json'), '{broken');
  const next = await f.restart();
  const beforeQueue = await next.plugin.readQueue();
  const beforeRef = await next.core.resolveRef('refs/heads/local');
  await expect(next.core.rebuildFromServerMain()).rejects.toMatchObject({ code: 'stale_intent_mismatch' });
  expect(await next.plugin.readQueue()).toEqual(beforeQueue);
  expect(await next.core.resolveRef('refs/heads/local')).toBe(beforeRef);
  expect(await next.core.resolveRef(`refs/obts/stale-bases/${sibling}`)).toBe(sibling);
  expect(await readFile(join(f.dir, '.obts', 'stale-provenance.json'), 'utf8')).toBe('{broken');
  expect(await f.canonical()).toBe(BASE);
  expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(f.latest);
});

describe('local ref after an applied stale-cohort conflict resolution', () => {
  const APPLIED = BASE.replace('last', 'remote last');
  const DEVICE = BASE.replace('last', 'device last');
  const RESOLVED = BASE.replace('last', 'remote last\ndevice last');

  async function openStaleConflict() {
    const f = await fixture();
    await f.remote(APPLIED);
    const original = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await f.core.adapter.write('note.md', DEVICE);
      }
      return original(...args);
    };
    await f.core.pullAndApply(true);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    return f;
  }

  async function resolveOpenConflict(f: Awaited<ReturnType<typeof fixture>>, manual: string) {
    const conflict = (await f.server.store.snapshot()).conflicts.find((r) => r.status === 'open')!;
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}` });
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'manual', manual_files: { 'note.md': manual } }
    })).statusCode).toBe(200);
    return conflict;
  }

  async function localRefAndHead(f: Awaited<ReturnType<typeof fixture>>) {
    return { ref: await f.core.resolveRef('refs/heads/local'), head: (await f.plugin.readState()).local_head };
  }

  it('keeps the ref on the resolution when the conflicted note changed again during review', async () => {
    const f = await openStaleConflict();
    await resolveOpenConflict(f, RESOLVED);
    await f.plugin.pollRemoteEventsAndApply();
    // An append inside the horizon is a stale cohort, which conflicts again.
    await f.core.adapter.write('note.md', `${RESOLVED}appended\n`);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    const edited = `${RESOLVED}appended\nedited during review\n`;
    await f.core.adapter.write('note.md', edited);
    const reviewed = await resolveOpenConflict(f, `${RESOLVED}appended resolved\n`);
    await f.plugin.pollRemoteEventsAndApply();

    const { ref, head } = await localRefAndHead(f);
    expect(ref).not.toBe(reviewed.device_commit);
    expect(ref).toBe(head);
    // The edit made during review is proposed on the resolution and conflicts with it.
    await expect(f.plugin.syncOnce()).rejects.toMatchObject({ code: 'conflict_review_required' });
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(edited);
    expect(await f.canonical()).toBe(`${RESOLVED}appended resolved\n`);
    const open = (await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open');
    expect(open).toHaveLength(1);
    const proposal = open[0]!.device_commit;
    expect(proposal).not.toBe(reviewed.device_commit);
    expect(await f.core.isAncestor(head, proposal)).toBe(true);
    expect((await f.server.git.readBlobAtPath(f.vaultId, proposal, 'note.md')).toString()).toBe(edited);
  });

  // Earlier clients restored the settled conflicted proposal onto the local ref
  // while local_head stayed on the applied resolution.
  function emulateLegacyProposalRestore(core: any) {
    const original = core.queueStaleCohort.bind(core);
    core.queueStaleCohort = async (...args: any[]) => {
      const queue = await core.readQueue();
      if (queue.status !== 'conflicted' || !queue.pending_commit || !queue.pending_proposal_base) return original(...args);
      core.queueStaleCohort = original;
      await core.updateRef('refs/heads/local', queue.pending_commit, null, true);
      await core.writeState({ ...await core.readState(), local_head: queue.pending_commit });
      return true;
    };
  }

  async function legacySplitDevice() {
    const f = await openStaleConflict();
    await resolveOpenConflict(f, RESOLVED);
    await f.plugin.pollRemoteEventsAndApply();
    const proposed = `${RESOLVED}appended\n`;
    await f.core.adapter.write('note.md', proposed);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    const edited = `${proposed}edited during review\n`;
    await f.core.adapter.write('note.md', edited);
    const resolution = `${RESOLVED}appended resolved\n`;
    const reviewed = await resolveOpenConflict(f, resolution);
    emulateLegacyProposalRestore(f.core);
    await f.plugin.pollRemoteEventsAndApply();
    const { ref, head } = await localRefAndHead(f);
    expect(ref).toBe(reviewed.device_commit);
    expect(head).not.toBe(ref);
    expect(await f.core.isAncestor(ref, head)).toBe(true);
    expect((await f.provenance()).obligations['note.md']).toBeDefined();
    return { f, proposed, edited, resolution, reviewed, head: head! };
  }

  it('fast-forwards a rewound local ref when no changed path shows its bytes', async () => {
    const { f, edited, resolution, head } = await legacySplitDevice();
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(edited);
    expect(await f.canonical()).toBe(resolution);
    const after = await localRefAndHead(f);
    expect(after.ref).toBe(after.head);
    expect(await f.core.isAncestor(head, after.head)).toBe(true);
    const open = (await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open');
    expect(open).toHaveLength(1);
    const proposal = open[0]!.device_commit;
    expect(await f.core.isAncestor(head, proposal)).toBe(true);
    expect((await f.server.git.readBlobAtPath(f.vaultId, proposal, 'note.md')).toString()).toBe(edited);
  });

  it('keeps a rewound local ref blocked while a changed path still shows its bytes', async () => {
    const { f, proposed, resolution, reviewed, head } = await legacySplitDevice();
    await f.core.adapter.write('note.md', proposed);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(f.plugin.syncOnce()).rejects.toMatchObject({
        code: 'local_ref_changed',
        details: { ref: 'refs/heads/local', expected: head, actual: reviewed.device_commit }
      });
    }
    expect(await localRefAndHead(f)).toEqual({ ref: reviewed.device_commit, head });
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(proposed);
    expect(await f.canonical()).toBe(resolution);
    expect((await f.provenance()).obligations['note.md']).toBeDefined();
    expect((await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open')).toEqual([]);
  });
});

describe('split rename after stale conflict resolution', () => {
  const REMOTE_EDIT = BASE.replace('last', 'remote last');
  const DEVICE_EDIT = BASE.replace('last', 'device last');

  it.each([
    { choice: 'keep_server' as const, restart: false },
    { choice: 'keep_server' as const, restart: true },
    { choice: 'use_device' as const, restart: false },
    { choice: 'use_device' as const, restart: true }
  ])('characterizes $choice after the split rename (restart=$restart)', async ({ choice, restart }) => {
    const f = await fixture();
    await f.remote(REMOTE_EDIT);
    const stage = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await f.core.adapter.write('note.md', DEVICE_EDIT);
      }
      return stage(...args);
    };
    await f.core.pullAndApply(true);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    const first = (await f.server.store.snapshot()).conflicts.find((r) => r.status === 'open')!;
    expect(first.base_commit).toBe(f.m0);
    const firstReview = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${first.conflict_id}` });
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${first.conflict_id}/resolve`,
      payload: { expected_main: firstReview.json().conflict.expected_main, resolution_kind: 'use_device' }
    })).statusCode).toBe(200);
    await f.plugin.pollRemoteEventsAndApply();
    const resolved = await f.canonical();
    expect(resolved).toBe(DEVICE_EDIT);
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe(DEVICE_EDIT);

    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.core.recordLocalChangeHint(['note.md', 'renamed.md']);
    expect(await readdir(f.dir)).toContain('renamed.md');
    expect(await readdir(f.dir)).not.toContain('note.md');
    expect(await readFile(join(f.dir, 'renamed.md'), 'utf8')).toBe(resolved);
    expect((await f.provenance()).obligations['note.md']).toMatchObject({ base: f.m0 });

    const secondResult = await f.plugin.syncOnce();
    expect(secondResult.status).toBe('Conflict resolution needed');
    const q = await f.plugin.readQueue();
    expect(q.changed_paths).toContain('note.md');
    expect(q.changed_paths).toContain('renamed.md');
    const d = await git.readCommit({ fs: f.core.fs, dir: f.core.vaultDir, gitdir: f.core.gitdir, oid: q.pending_commit! });
    expect(d.commit.parent).toEqual([await f.server.git.getRef(f.vaultId, 'refs/heads/main')]);
    expect(q.pending_proposal_base).toBe(f.m0);
    expect((await f.core.listTreeBlobOids(q.pending_commit!)).has('note.md')).toBe(false);
    expect((await f.core.listTreeBlobOids(q.pending_commit!)).has('renamed.md')).toBe(false);
    const second = (await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open');
    expect(second).toHaveLength(1);
    expect(second[0]!.base_commit).toBe(f.m0);
    expect(second[0]!.conflict_kind).toBe('content');
    expect(await readdir(f.dir)).not.toContain('note.md');
    expect(await readdir(f.dir)).toContain('renamed.md');
    expect(await f.canonical()).toBe(DEVICE_EDIT);
    const beforeResolutionMain = await f.server.git.getRef(f.vaultId, 'refs/heads/main');
    expect(beforeResolutionMain).not.toBeNull();
    const beforeResolutionPaths = await f.server.git.listTreePaths(f.vaultId, beforeResolutionMain!);
    expect(beforeResolutionPaths).toContain('note.md');
    expect(beforeResolutionPaths).not.toContain('renamed.md');

    let active = f.plugin;
    if (restart) active = (await f.restart()).plugin;
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${second[0]!.conflict_id}` });
    expect(review.json().path_conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'delete_edit', base_path: 'note.md', server_path: 'note.md', device_path: null })
    ]));
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${second[0]!.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: choice }
    })).statusCode).toBe(200);
    const resolvedServerMain = await f.server.git.getRef(f.vaultId, 'refs/heads/main');
    expect(resolvedServerMain).not.toBeNull();
    const immediatelyResolvedPaths = await f.server.git.listTreePaths(f.vaultId, resolvedServerMain!);
    expect(immediatelyResolvedPaths.includes('note.md')).toBe(choice === 'keep_server');
    expect(immediatelyResolvedPaths).not.toContain('renamed.md');
    await active.pollRemoteEventsAndApply();
    const afterApply = {
      old: await readFile(join(f.dir, 'note.md'), 'utf8').catch(() => null),
      renamed: await readFile(join(f.dir, 'renamed.md'), 'utf8').catch(() => null),
      entries: (await readdir(f.dir)).filter((name) => name === 'note.md' || name === 'renamed.md').sort()
    };
    const afterDrain = await active.syncOnce();
    expect(afterDrain.status).toBe('Synced');
    const finalFiles = {
      old: await readFile(join(f.dir, 'note.md'), 'utf8').catch(() => null),
      renamed: await readFile(join(f.dir, 'renamed.md'), 'utf8').catch(() => null),
      entries: (await readdir(f.dir)).filter((name) => name === 'note.md' || name === 'renamed.md').sort()
    };
    const expectedOld = choice === 'keep_server' ? resolved : null;
    expect(afterApply).toEqual({
      old: expectedOld,
      renamed: resolved,
      entries: choice === 'keep_server' ? ['note.md', 'renamed.md'] : ['renamed.md']
    });
    expect(finalFiles).toEqual(afterApply);
    const finalMain = await f.server.git.getRef(f.vaultId, 'refs/heads/main');
    expect(finalMain).not.toBeNull();
    const finalPaths = await f.server.git.listTreePaths(f.vaultId, finalMain!);
    expect(finalPaths.includes('note.md')).toBe(choice === 'keep_server');
    expect(finalPaths).toContain('renamed.md');
    if (choice === 'keep_server') expect(await f.canonical()).toBe(resolved);
    expect(await f.canonical('renamed.md')).toBe(resolved);
    expect((await f.server.store.snapshot()).conflicts.filter((r) => r.status === 'open')).toEqual([]);
    expect((await active.readState()).last_error_code).toBeNull();
  });
});

describe('durable atomic rename proposals after stale conflict resolution', () => {
  it.each(['base', 'generation', 'events'] as const)('fails closed when durable v4 rename evidence omits %s', async (field) => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const path = join(f.dir, '.obts', 'stale-provenance.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.rename_pairs[0][field];
    await writeFile(path, JSON.stringify(saved));
    await expect(f.core.readStaleProvenance()).rejects.toMatchObject({ code: 'stale_provenance_corrupt' });
  });

  it.each(['omitted pairs', 'empty pairs', 'different base'] as const)('blocks a paired frozen intent with %s in its queue', async (corruption) => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const state = await f.plugin.readState();
    expect(await f.core.queueStaleCohort(state.local_main, state.server_device_ref)).toBe(true);
    const queue = await f.plugin.readQueue();
    const push = vi.spyOn(f.server.sync, 'pushDeviceCommit');
    const invalidQueue = corruption === 'different base'
      ? { ...queue, pending_proposal_base: queue.pending_commit }
      : { ...queue, pending_rename_pairs: corruption === 'empty pairs' ? [] : undefined };
    await expect(f.core.uploadQueuedCommit(invalidQueue)).rejects.toMatchObject({ code: 'stale_intent_mismatch' });
    expect(push).not.toHaveBeenCalled();
  });

  it('flushes the registered rename watcher serially and retries after durable provenance failure', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    const callbacks = new Map<string, (file: any, oldPath?: string) => void>();
    const watcher = Object.create(pluginMain.prototype);
    Object.assign(watcher, {
      app: { vault: { on: (name: string, callback: (file: any, oldPath?: string) => void) => {
        callbacks.set(name, callback); return { name };
      } } },
      client: f.core, clientReady: false, unloaded: false, layoutStarted: false,
      pendingWatcherPaths: new Set(), pendingWatcherRenames: [], watcherFlush: Promise.resolve(),
      registerEvent: () => undefined, operationAvailability: () => 'unavailable', observeRetiredOperation: () => undefined,
      reportDeviceError: () => undefined
    });
    watcher.startAfterLayoutReady();
    const mutate = f.core.mutateStaleProvenance.bind(f.core);
    let attempts = 0;
    f.core.mutateStaleProvenance = async (...args: any[]) => {
      attempts += 1;
      if (attempts === 1) throw new Error('durable write interrupted');
      return await mutate(args[0]);
    };
    callbacks.get('rename')!({ path: 'renamed.md' }, 'note.md');
    await watcher.flushWatcherHints();
    expect(attempts).toBe(2);
    expect((await f.provenance()).rename_pairs).toMatchObject([
      { source_path: 'note.md', destination_path: 'renamed.md', base: f.m0 }
    ]);
    expect(watcher.pendingWatcherRenames).toEqual([]);
  });

  it('durably blocks a tracked directory rename across restart', async () => {
    const f = await fixture();
    await f.core.adapter.mkdir('folder');
    await f.core.adapter.write('folder/note.md', 'tracked child\n');
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    await f.core.adapter.rename('folder', 'renamed');
    await expect(f.plugin.client.recordLocalRenameHint('folder', 'renamed'))
      .rejects.toMatchObject({ code: 'rename_preservation_required' });
    expect((await f.plugin.readState()).last_error_code).toBe('rename_preservation_required');
    const restarted = await f.restart();
    await expect(restarted.plugin.syncOnce()).rejects.toMatchObject({ code: 'rename_preservation_required' });
    expect(await f.canonical('folder/note.md')).toBe('tracked child\n');
    await expect(f.canonical('renamed/note.md')).rejects.toThrow();
  });

  it('persists overlapping rename rejection before reporting it', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    await f.core.adapter.rename('renamed.md', 'final.md');
    await expect(f.plugin.client.recordLocalRenameHint('note.md', 'final.md'))
      .rejects.toMatchObject({ code: 'rename_preservation_required' });
    expect((await f.plugin.readState()).last_error_code).toBe('rename_preservation_required');
    const restarted = await f.restart();
    await expect(restarted.plugin.syncOnce()).rejects.toMatchObject({ code: 'rename_preservation_required' });
  });

  it('normalizes an untracked note rename into an ordinary add', async () => {
    const f = await fixture();
    await f.core.adapter.write('Untitled.md', 'new note\n');
    await f.core.adapter.rename('Untitled.md', 'Title.md');
    await f.plugin.client.recordLocalRenameHint('Untitled.md', 'Title.md');
    expect((await f.provenance()).rename_pairs).toEqual([]);
    expect((await f.plugin.readQueue()).pending_commit).toBeNull();
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    expect(await f.canonical('Title.md')).toBe('new note\n');
    await expect(f.canonical('Untitled.md')).rejects.toThrow();
  });

  it('collapses a pre-freeze chain and replays the final watcher event idempotently', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'middle.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'middle.md');
    await f.core.adapter.rename('middle.md', 'final.md');
    await f.plugin.client.recordLocalRenameHint('middle.md', 'final.md');
    await f.plugin.client.recordLocalRenameHint('middle.md', 'final.md');
    expect((await f.provenance()).rename_pairs).toEqual([
      { source_path: 'note.md', destination_path: 'final.md', generation: 1, base: f.m0,
        events: [{ source_path: 'note.md', destination_path: 'middle.md' }, { source_path: 'middle.md', destination_path: 'final.md' }] }
    ]);
  });

  const REMOTE_EDIT = BASE.replace('last', 'remote last');
  const DEVICE_EDIT = BASE.replace('last', 'device last');

  it.each(['edit', 'rename'] as const)('retains a destination %s after pair freeze and syncs from the accepted proposal base', async (successorKind) => {
    const f = await fixture();
    await f.remote(REMOTE_EDIT);
    const stage = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) { injected = true; await f.core.adapter.write('note.md', DEVICE_EDIT); }
      return stage(...args);
    };
    await f.core.pullAndApply(true);
    await f.plugin.syncOnce();
    const conflict = (await f.server.store.snapshot()).conflicts.find((r) => r.status === 'open')!;
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}` });
    await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'use_device' } });
    await f.plugin.pollRemoteEventsAndApply();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const originalPush = f.server.sync.pushDeviceCommit.bind(f.server.sync);
    let changedAfterFreeze = false;
    let pairedTarget: string | null = null;
    f.server.sync.pushDeviceCommit = async (...args: any[]) => {
      if (!changedAfterFreeze) {
        changedAfterFreeze = true;
        pairedTarget = args[1].target_commit;
        if (successorKind === 'edit') {
          await f.core.adapter.write('renamed.md', 'successor edit\n');
          await f.plugin.client.recordLocalChangeHint(['renamed.md']);
        } else {
          await f.core.adapter.rename('renamed.md', 'final.md');
          await f.plugin.client.recordLocalRenameHint('renamed.md', 'final.md');
        }
      }
      return await (originalPush as (...values: any[]) => Promise<any>)(...args);
    };
    let result = await f.plugin.syncOnce();
    for (let attempt = 0; result.status !== 'Synced' && attempt < 3; attempt += 1) result = await f.plugin.syncOnce();
    expect(result.status).toBe('Synced');
    const finalPath = successorKind === 'edit' ? 'renamed.md' : 'final.md';
    expect(await f.canonical(finalPath)).toBe(successorKind === 'edit' ? 'successor edit\n' : DEVICE_EDIT);
    expect(await readFile(join(f.dir, finalPath), 'utf8')).toBe(successorKind === 'edit' ? 'successor edit\n' : DEVICE_EDIT);
    if (successorKind === 'rename') {
      await expect(f.canonical('renamed.md')).rejects.toThrow();
      await expect(readFile(join(f.dir, 'renamed.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const state = await f.plugin.readState();
    const deviceCommit = await f.server.git.getRef(f.vaultId, state.device_ref!);
    const operations = (await f.server.store.snapshot()).sync_operations.filter((row) =>
      row.operation_type === 'device_push' && row.target_commit === deviceCommit);
    expect(operations.at(-1)?.proposal_base).toBe(pairedTarget);
  });

  it('retains and unblocks a successor rename only after use_device installs its predecessor', async () => {
    const f = await fixture();
    await f.core.adapter.write('note.md', DEVICE_EDIT);
    await f.plugin.client.recordLocalChangeHint(['note.md']);
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const beforeCapture = await f.plugin.readState();
    expect(await f.core.queueStaleCohort(beforeCapture.local_main, beforeCapture.server_device_ref)).toBe(true);
    const pairedQueue = await f.plugin.readQueue();
    const pairedCommit = pairedQueue.pending_commit!;
    await f.remote(REMOTE_EDIT, { 'renamed.md': 'competing destination\n' });
    expect((await f.core.uploadQueuedCommit(pairedQueue)).status).toBe('conflicted');
    const predecessor = (await f.server.store.snapshot()).conflicts.find((row) => row.status === 'open')!;
    expect(predecessor).toBeDefined();
    await f.core.adapter.rename('renamed.md', 'final.md');
    await f.plugin.client.recordLocalRenameHint('renamed.md', 'final.md');
    expect((await f.provenance()).rename_pairs[0]).toMatchObject({ blocked_commit: expect.any(String) });
    await expect(f.plugin.syncOnce()).rejects.toMatchObject({ code: 'conflict_review_required' });
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${predecessor.conflict_id}` });
    await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${predecessor.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'use_device' } });
    await f.plugin.pollRemoteEventsAndApply();
    let result = await f.plugin.syncOnce();
    for (let attempt = 0; result.status !== 'Synced' && attempt < 3; attempt += 1) result = await f.plugin.syncOnce();
    expect(result.status).toBe('Synced');
    expect(await f.canonical('final.md')).toBe(DEVICE_EDIT);
    await expect(f.canonical('note.md')).rejects.toThrow();
    await expect(f.canonical('renamed.md')).rejects.toThrow();
    expect((await f.server.store.snapshot()).conflicts.filter((row) => row.status === 'open')).toEqual([]);
    expect(predecessor.device_commit).toBe(pairedCommit);
  });

  it('blocks a successor created during a conflicted push until predecessor installation is proven', async () => {
    const f = await fixture();
    await f.core.adapter.write('note.md', DEVICE_EDIT);
    await f.plugin.client.recordLocalChangeHint(['note.md']);
    expect((await f.plugin.syncOnce()).status).toBe('Synced');
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const beforeCapture = await f.plugin.readState();
    expect(await f.core.queueStaleCohort(beforeCapture.local_main, beforeCapture.server_device_ref)).toBe(true);
    const queue = await f.plugin.readQueue();
    await f.remote(REMOTE_EDIT, { 'renamed.md': 'competing destination\n' });
    const originalPush = f.server.sync.pushDeviceCommit.bind(f.server.sync);
    let createdSuccessor = false;
    f.server.sync.pushDeviceCommit = async (...args: any[]) => {
      const result = await (originalPush as (...values: any[]) => Promise<any>)(...args);
      if (!createdSuccessor) {
        createdSuccessor = true;
        await f.core.adapter.rename('renamed.md', 'final.md');
        await f.plugin.client.recordLocalRenameHint('renamed.md', 'final.md');
      }
      return result;
    };
    expect((await f.core.uploadQueuedCommit(queue)).status).toBe('conflicted');
    expect((await f.provenance()).rename_pairs[0]).toMatchObject({
      source_path: 'renamed.md', destination_path: 'final.md', blocked_commit: queue.pending_commit
    });
    const predecessor = (await f.server.store.snapshot()).conflicts.find((row) => row.status === 'open')!;
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${predecessor.conflict_id}` });
    await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${predecessor.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'keep_server' } });
    await f.plugin.pollRemoteEventsAndApply();
    const canonicalMain = await f.server.git.getRef(f.vaultId, 'refs/heads/main');
    const canonicalDestination = await f.canonical('renamed.md');
    const pushesBeforeRetry = (await f.server.store.snapshot()).sync_operations.filter((row) => row.operation_type === 'device_push').length;
    await expect(f.plugin.syncOnce()).rejects.toMatchObject({ code: 'rename_lineage_ambiguous' });
    expect(await readFile(join(f.dir, 'final.md'), 'utf8')).toBe(DEVICE_EDIT);
    expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(canonicalMain);
    expect(await f.canonical('renamed.md')).toBe(canonicalDestination);
    expect((await f.server.store.snapshot()).sync_operations.filter((row) => row.operation_type === 'device_push')).toHaveLength(pushesBeforeRetry);
  });

  it('blocks a recreated source before producing a deletion-only proposal', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    await f.core.adapter.write('note.md', 'recreated source\n');
    await f.plugin.client.recordLocalChangeHint(['note.md']);
    const pushesBefore = (await f.server.store.snapshot()).sync_operations.filter((row) => row.operation_type === 'device_push').length;
    await expect(f.plugin.syncOnce()).rejects.toMatchObject({ code: 'rename_preservation_required' });
    expect(await readFile(join(f.dir, 'note.md'), 'utf8')).toBe('recreated source\n');
    expect(await readFile(join(f.dir, 'renamed.md'), 'utf8')).toBe(BASE);
    expect((await f.server.store.snapshot()).sync_operations.filter((row) => row.operation_type === 'device_push')).toHaveLength(pushesBefore);
  });

  it('blocks a root-policy replacement that would exclude a frozen rename endpoint', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const state = await f.plugin.readState();
    expect(await f.core.queueStaleCohort(state.local_main, state.server_device_ref)).toBe(true);
    const queue = await f.plugin.readQueue();
    await f.core.adapter.write('.gitignore', 'renamed.md\n');
    expect((await f.core.readRootIgnorePolicy()).policy.ignores('renamed.md')).toBe(true);
    expect(await f.core.queuedCommitRootPolicyIsStale(queue.pending_commit)).toBe(true);
    await expect(f.core.rebuildQueuedCommitForRootPolicy(queue.pending_commit, await f.plugin.readState(), queue))
      .rejects.toMatchObject({ code: 'rename_preservation_required' });
    expect(await f.plugin.readQueue()).toMatchObject({
      pending_commit: queue.pending_commit,
      pending_rename_pairs: [{ source_path: 'note.md', destination_path: 'renamed.md' }],
      pending_capture_id: queue.pending_capture_id
    });
  });

  it('recovers a stranded paired commit before queue publication and strips internal metadata from the wire pair', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const state = await f.plugin.readState();
    const updateQueue = f.core.updateQueue.bind(f.core);
    f.core.updateQueue = async (...args: any[]) => {
      if ((await f.core.readStaleProvenance()).intent?.rename_pairs?.length) throw new Error('queue publication interrupted');
      return await updateQueue(...args);
    };
    await expect(f.core.queueStaleCohort(state.local_main, state.server_device_ref)).rejects.toThrow('queue publication interrupted');
    const stranded = await f.provenance();
    expect(stranded.intent.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(stranded.rename_pairs).toEqual([]);
    const restarted = await f.restart();
    const queue = await restarted.plugin.readQueue();
    expect(queue.pending_rename_pairs).toEqual([{ source_path: 'note.md', destination_path: 'renamed.md' }]);
    expect(Object.keys(queue.pending_rename_pairs![0]!).sort()).toEqual(['destination_path', 'source_path']);
    expect(queue.pending_capture_id).toBe(stranded.intent.capture_id);
    let result = await restarted.plugin.syncOnce();
    for (let attempt = 0; result.status !== 'Synced' && attempt < 3; attempt += 1) result = await restarted.plugin.syncOnce();
    expect(result.status).toBe('Synced');
    expect(await f.canonical('renamed.md')).toBe(BASE);
    await expect(f.canonical('note.md')).rejects.toThrow();
  });

  it('recovers a paired terminal chunk result after checkpoint-retirement failure and restart', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const state = await f.plugin.readState();
    expect(await f.core.queueStaleCohort(state.local_main, state.server_device_ref)).toBe(true);
    const queue = await f.plugin.readQueue();
    const remove = f.core.fsp.rm.bind(f.core.fsp);
    let failed = false;
    f.core.fsp.rm = async (path: string, ...args: any[]) => {
      if (path === f.core.uploadTransferPath && !failed) { failed = true; throw new Error('paired terminal retirement failure'); }
      return remove(path, ...args);
    };
    await expect(f.core.uploadQueuedCommit(queue)).rejects.toThrow('paired terminal retirement failure');
    f.core.fsp.rm = remove;
    const checkpoint = await f.core.readUploadCheckpoint();
    expect(checkpoint.rename_pairs).toEqual([{ source_path: 'note.md', destination_path: 'renamed.md' }]);
    expect(checkpoint.capture_id).toBe(queue.pending_capture_id);
    const checkpointPath = f.core.uploadTransferPath;
    const originalCheckpoint = await f.core.fsp.readFile(checkpointPath);
    const altered = JSON.parse(originalCheckpoint.toString('utf8'));
    altered.rename_pairs = [{ source_path: 'note.md', destination_path: 'other.md' }];
    altered.transfer_request.rename_pairs = altered.rename_pairs;
    altered.attempt_id = `xfer_${createHash('sha256').update(Buffer.from(stableJson(altered.transfer_request))).digest('hex').slice(0, 32)}`;
    await f.core.fsp.writeFile(checkpointPath, JSON.stringify(altered));
    await expect(f.core.uploadQueuedCommit(queue)).rejects.toMatchObject({ code: 'upload_checkpoint_recovery_required' });
    await f.core.fsp.writeFile(checkpointPath, originalCheckpoint);
    const restarted = await f.restart();
    let result = await restarted.plugin.syncOnce();
    for (let attempt = 0; result.status !== 'Synced' && attempt < 3; attempt += 1) result = await restarted.plugin.syncOnce();
    expect(result.status).toBe('Synced');
    expect(await f.canonical('renamed.md')).toBe(BASE);
    await expect(f.canonical('note.md')).rejects.toThrow();
    expect((await f.server.store.snapshot()).conflicts.filter((row) => row.status === 'open')).toEqual([]);
  });

  it('blocks an explicit rename before upload when the server lacks the capability', async () => {
    const f = await fixture();
    await f.core.adapter.rename('note.md', 'renamed.md');
    await f.plugin.client.recordLocalRenameHint('note.md', 'renamed.md');
    const capabilities = f.core.syncCapabilities.bind(f.core);
    f.core.syncCapabilities = async () => {
      const current = await capabilities();
      return { ...current, capabilities: current.capabilities.filter((item: string) => item !== 'rename-pairs-v1') };
    };
    const push = vi.spyOn(f.server.sync, 'pushDeviceCommit');
    await expect(f.plugin.syncOnce()).rejects.toMatchObject({ code: 'server_update_required' });
    expect(push).not.toHaveBeenCalled();
    expect(await readFile(join(f.dir, 'renamed.md'), 'utf8')).toBe(BASE);
    await expect(readFile(join(f.dir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.plugin.readQueue()).pending_rename_pairs).toEqual([
      { source_path: 'note.md', destination_path: 'renamed.md' }
    ]);
    expect((await f.provenance()).intent.rename_pairs).toHaveLength(1);
  });

  it.each([
    { transport: 'multipart' as const, restart: false },
    { transport: 'chunks' as const, restart: true }
  ])('uploads one explicit paired proposal over $transport (restart=$restart)', async ({ transport, restart }) => {
    const f = await fixture();
    await f.remote(REMOTE_EDIT);
    const stage = f.core.stageRecoveryBundleFiles.bind(f.core);
    let injected = false;
    f.core.stageRecoveryBundleFiles = async (...args: any[]) => {
      if (!injected) {
        injected = true;
        await f.core.adapter.write('note.md', DEVICE_EDIT);
      }
      return stage(...args);
    };
    await f.core.pullAndApply(true);
    expect((await f.plugin.syncOnce()).status).toBe('Conflict resolution needed');
    const conflict = (await f.server.store.snapshot()).conflicts.find((r) => r.status === 'open')!;
    const review = await f.server.app.inject({ method: 'GET', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}` });
    expect((await f.server.app.inject({ method: 'POST', headers: f.headers,
      url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflict.conflict_id}/resolve`,
      payload: { expected_main: review.json().conflict.expected_main, resolution_kind: 'use_device' }
    })).statusCode).toBe(200);
    await f.plugin.pollRemoteEventsAndApply();
    const resolved = await f.canonical();
    expect(resolved).toBe(DEVICE_EDIT);

    await f.core.adapter.rename('note.md', 'renamed.md');
    let watcherPair: any;
    pluginMain.queueRenameWatcherEvent({ queueSyncFromWatcher: (_paths: string[], pair: unknown) => { watcherPair = pair; } },
      { path: 'renamed.md' }, 'note.md');
    expect(watcherPair).toEqual({ source_path: 'note.md', destination_path: 'renamed.md' });
    await f.plugin.client.recordLocalRenameHint(watcherPair.source_path, watcherPair.destination_path);
    const saved = await f.provenance();
    expect(saved.rename_pairs).toEqual([{
      source_path: 'note.md', destination_path: 'renamed.md', generation: 0, base: f.m0,
      events: [{ source_path: 'note.md', destination_path: 'renamed.md' }]
    }]);
    let active = f.plugin;
    if (restart) active = (await f.restart()).plugin;
    const activeCore = active.client as any;
    if (transport === 'multipart') {
      const capabilities = activeCore.syncCapabilities.bind(activeCore);
      activeCore.syncCapabilities = async () => {
        const current = await capabilities();
        return { ...current, capabilities: current.capabilities.filter((item: string) => item !== 'git-object-pack-chunks-v1') };
      };
    }
    let syncResult = await active.syncOnce();
    for (let attempt = 0; syncResult.status !== 'Synced' && attempt < 3; attempt += 1) {
      syncResult = await active.syncOnce();
    }
    expect(syncResult.status).toBe('Synced');
    const queue = await active.readQueue();
    expect(queue.pending_rename_pairs || []).toEqual([]);
    await expect(f.canonical('note.md')).rejects.toThrow();
    expect(await f.canonical('renamed.md')).toBe(DEVICE_EDIT);
    const state = await active.readState();
    const deviceCommit = await f.server.git.getRef(f.vaultId, state.device_ref!);
    const operation = (await f.server.store.snapshot()).sync_operations.find((row) =>
      row.operation_type === 'device_push' && row.target_commit === deviceCommit)!;
    expect(operation.prepared_manifest?.proposal_base).toBe(f.m0);
    expect(operation.prepared_manifest?.rename_pairs).toEqual([{ source_path: 'note.md', destination_path: 'renamed.md' }]);
    const proposedPaths = await f.server.git.listTreePaths(f.vaultId, deviceCommit!);
    expect(proposedPaths).not.toContain('note.md');
    expect(proposedPaths).toContain('renamed.md');
    expect((await f.server.store.snapshot()).conflicts.filter((row) => row.status === 'open')).toEqual([]);
    expect((await f.plugin.readState()).last_error_code).toBeNull();
  });
});
