import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalGitEngine } from '../obsidian-plugin/src/core/localGit.js';
import { ObtsPluginClient } from '../src/client/core.js';
import { MAX_ROOT_IGNORE_BYTES } from '../src/shared/rootIgnore.cjs';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-root-ignore-scan-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ignore-scan-test' });
  await plugin.initialize();
  const headless = new LocalGitEngine(root);
  const core = (plugin as any).client;
  return { root, core, headless };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubUploadTransport(core: any, serverDeviceRef: string | null) {
  core.readDeviceToken = vi.fn(async () => 'synthetic-token');
  core.reportDeviceStatus = vi.fn(async () => undefined);
  core.getDeviceSelf = vi.fn(async () => ({ server_device_ref: serverDeviceRef, vault_status: 'active' }));
  core.reconcileServerVaultStatus = vi.fn(async () => undefined);
  core.syncCapabilities = vi.fn(async () => ({ capabilities: [] }));
  const push = vi.fn(async (_vaultId: string, _token: string, _manifest: Record<string, unknown>, _packfile: Buffer) => {
    throw new Error('network interrupted');
  });
  core.push = push;
  return push;
}

async function stageStaleQueuedCommit(root: string, core: any, options: { acceptedRef: boolean }) {
  await writeFile(join(root, 'slug.md'), 'note');
  await mkdir(join(root, 'cache'), { recursive: true });
  await writeFile(join(root, 'cache', 'vectors.bin'), 'derived bytes v1');
  const base = await core.createLocalCommit('obts: base');
  await writeFile(join(root, 'cache', 'vectors.bin'), 'derived bytes v2');
  const queued = await core.createLocalCommit('obts: local vault changes');
  await writeFile(join(root, '.gitignore'), 'cache/\n');
  await core.writeState({
    ...await core.readState(),
    vault_id: 'vlt_policy_rebuild',
    device_id: 'dev_policy_rebuild',
    local_main: options.acceptedRef ? base : null,
    server_device_ref: options.acceptedRef ? base : null,
    local_head: queued,
    last_error_code: null
  });
  await core.writeQueue({
    pending_commit: queued,
    expected_device_ref: options.acceptedRef ? base : null,
    status: 'queued_local',
    attempts: 0,
    updated_at: new Date().toISOString()
  });
  return { base, queued };
}

describe('opt-in root .gitignore local scan', () => {
  it('pins the same bytes, blob OID and policy in plugin and headless; leaves default scans physical', async () => {
    const { root, core, headless } = await fixture();
    const rules = 'cache/\n!cache/keep.md\nopen/*\n!open/keep.md\n*.txt\n.gitignore\n';
    await writeFile(join(root, '.gitignore'), rules);
    await mkdir(join(root, 'cache'));
    await mkdir(join(root, 'open'));
    await writeFile(join(root, 'cache', 'lost.md'), 'retained physical copy');
    await writeFile(join(root, 'open', 'keep.md'), 'kept');
    await writeFile(join(root, 'open', 'drop.md'), 'ignored');
    await writeFile(join(root, 'draft.txt'), 'ignored');
    await writeFile(join(root, 'hard.tmp'), 'hard excluded');
    const read = vi.spyOn(core.adapter, 'readRootIgnorePolicyNoFollow');
    const pluginPin = await core.readRootIgnorePolicy();
    expect(read).toHaveBeenCalledTimes(2);
    const headlessPin = await headless.readRootIgnorePolicy();
    const bytes = await readFile(join(root, '.gitignore'));
    const oid = (await git.hashBlob({ object: bytes })).oid;
    expect(pluginPin.bytes).toEqual(bytes);
    expect(headlessPin.bytes).toEqual(bytes);
    expect(pluginPin.oid).toBe(oid);
    expect(headlessPin.oid).toBe(oid);

    const physical = ['.gitignore', 'cache/lost.md', 'draft.txt', 'open/drop.md', 'open/keep.md'];
    const inventoryFiles = ['.gitignore', 'cache/lost.md', 'draft.txt', 'hard.tmp', 'open/drop.md', 'open/keep.md'];
    expect(await core.scanSyncableFiles()).toEqual(physical);
    expect(await headless.scanSyncableFiles()).toEqual(physical);
    expect((await core.listLocalVaultInventory('')).files).toEqual(inventoryFiles);
    const filtered = ['.gitignore', 'open/keep.md'];
    expect(await core.scanSyncableFiles(pluginPin.policy)).toEqual(filtered);
    expect(await headless.scanSyncableFiles(headlessPin.policy)).toEqual(filtered);
    expect(await core.listLocalVaultInventory('', pluginPin.policy)).toEqual({ files: ['.gitignore', 'hard.tmp', 'open/keep.md'], directories: ['open'] });
    await writeFile(join(root, '.gitignore'), 'open/keep.md\n');
    expect(await core.scanSyncableFiles(pluginPin.policy)).toEqual(filtered);
    expect(await headless.scanSyncableFiles(headlessPin.policy)).toEqual(filtered);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await core.listLocalVaultInventory('')).files).toEqual(inventoryFiles);
  });

  it('drops newly ignored tracked entries without deleting physical bytes and honors negations', async () => {
    const { root, core, headless } = await fixture();
    await writeFile(join(root, 'tracked.md'), 'existing tracked bytes');
    const initial = await headless.createLocalCommit('initial');
    expect(await headless.listTreeFiles(initial!)).toEqual(['tracked.md']);
    await writeFile(join(root, '.gitignore'), 'tracked.md\n');
    const pin = await headless.readRootIgnorePolicy();
    expect(await headless.scanSyncableFiles(pin.policy)).toEqual(['.gitignore']);
    expect(await core.scanSyncableFiles((await core.readRootIgnorePolicy()).policy)).toEqual(['.gitignore']);
    expect(await readFile(join(root, 'tracked.md'), 'utf8')).toBe('existing tracked bytes');
    expect((await core.listLocalVaultInventory('')).files).toContain('tracked.md');
    expect(await headless.scanSyncableFiles()).toContain('tracked.md');
    const headlessCommit = await headless.createLocalCommit('ignore tracked');
    expect(await headless.listTreeFiles(headlessCommit!)).toEqual(['.gitignore']);
    expect(await readFile(join(root, 'tracked.md'), 'utf8')).toBe('existing tracked bytes');
    await mkdir(join(root, 'open'));
    await writeFile(join(root, 'open', 'keep.md'), 'visible');
    await writeFile(join(root, 'open', 'drop.md'), 'retained');
    await writeFile(join(root, '.gitignore'), 'open/*\n!open/keep.md\ntracked.md\n');
    const pluginCommit = await core.createLocalCommit('negation');
    expect([...((await core.listTreeBlobOids(pluginCommit)).keys())]).toEqual(['.gitignore', 'open/keep.md']);
    expect(await readFile(join(root, 'open', 'drop.md'), 'utf8')).toBe('retained');
  });

  it('rejects policy changes during capture and preserved snapshot replay without moving the ref', async () => {
    const { root, core, headless } = await fixture();
    await writeFile(join(root, '.gitignore'), 'alpha.md\n');
    await writeFile(join(root, 'alpha.md'), 'physical');
    await writeFile(join(root, 'beta.md'), 'included');
    const before = await core.resolveRef('refs/heads/local');
    const capture = core.captureLocalFileSnapshot.bind(core);
    core.captureLocalFileSnapshot = async (...args: unknown[]) => {
      const result = await capture(...args);
      await writeFile(join(root, '.gitignore'), 'beta.md\n');
      return result;
    };
    await expect(core.createLocalCommit('racy')).rejects.toMatchObject({ code: 'local_snapshot_changed' });
    expect(await core.resolveRef('refs/heads/local')).toBe(before);
    core.captureLocalFileSnapshot = capture;
    const pin = await core.readRootIgnorePolicy();
    const files = await core.scanSyncableFiles(pin.policy);
    const snapshot = await core.captureLocalFileSnapshot(files, new Map(), { rootPolicy: pin, verifyInventory: true, persistChangedBlobs: true });
    await writeFile(join(root, '.gitignore'), 'alpha.md\n');
    await expect(core.createLocalCommitFromSnapshot('stale', snapshot)).rejects.toMatchObject({ filePath: '.gitignore' });
    expect(await core.resolveRef('refs/heads/local')).toBe(before);
    const headlessPin = await headless.readRootIgnorePolicy();
    const originalScan = headless.scanSyncableFiles.bind(headless);
    let scans = 0;
    headless.scanSyncableFiles = async (...args: Parameters<typeof originalScan>) => {
      const result = await originalScan(...args);
      if (++scans === 1) await writeFile(join(root, '.gitignore'), 'beta.md\n');
      return result;
    };
    await expect(headless.createLocalCommit('racy')).rejects.toThrow(/consistency checkpoint/u);
    expect(await headless.resolveRef('refs/heads/local')).toBe(before);
  });

  it('attests the immutable target in direct and chunked uploads across mutable policy edits and restart', async () => {
    const { root, core } = await fixture();
    await writeFile(join(root, '.gitignore'), 'private.md\n');
    await writeFile(join(root, 'public.md'), 'public');
    const target = await core.createLocalCommit('target');
    const oid = (await core.listTreeBlobOids(target)).get('.gitignore');
    await writeFile(join(root, '.gitignore'), 'public.md\n');
    expect(await core.validateUploadTargetRootIgnore(target)).toBe(oid);
    await core.writeState({ ...await core.readState(), vault_id: 'vlt_test', device_id: 'dev_test', local_head: target });
    await core.writeQueue({ ...await core.readQueue(), pending_commit: target, expected_device_ref: null, status: 'queued_local' });
    core.readDeviceToken = vi.fn(async () => 'synthetic-token');
    core.reportDeviceStatus = vi.fn(async () => undefined);
    core.getDeviceSelf = vi.fn(async () => ({ server_device_ref: null, vault_status: 'active' }));
    core.reconcileServerVaultStatus = vi.fn(async () => undefined);
    core.syncCapabilities = vi.fn(async () => ({ capabilities: [] }));
    const direct = vi.fn(async (_vaultId: string, _token: string, _manifest: Record<string, unknown>, _packfile: Buffer) => { throw new Error('network interrupted'); });
    core.push = direct;
    await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toThrow('network interrupted');
    expect(direct.mock.calls[0]?.[2]).toMatchObject({ root_ignore_capability: 'root-ignore-v1', root_ignore_oid: oid, target_commit: target });

    const capabilities = { target_chunk_bytes: 1024, max_chunk_bytes: 1024 * 1024, max_transfer_chunks: 100 };
    const fetch = vi.fn(async () => { throw new Error('chunk network interrupted'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const state = await core.readState();
      const queue = await core.readQueue();
      await expect(core.pushInChunks(state, queue, 'synthetic-token', null, capabilities, oid)).rejects.toMatchObject({ code: 'network_error' });
      const checkpointPath = join(root, '.obts', 'upload-transfer.json');
      const first = JSON.parse(await readFile(checkpointPath, 'utf8'));
      expect(first.transfer_request).toMatchObject({ root_ignore_capability: 'root-ignore-v1', root_ignore_oid: oid, target_commit: target });
      await writeFile(join(root, '.gitignore'), '*.md\n');
      const resumedClient = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ignore-restart-test' });
      await resumedClient.initialize();
      const resumed = (resumedClient as any).client;
      resumed.reportDeviceStatus = vi.fn(async () => undefined);
      await expect(resumed.pushInChunks(state, queue, 'synthetic-token', null, capabilities, await resumed.validateUploadTargetRootIgnore(target))).rejects.toMatchObject({ code: 'network_error' });
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({ identity: first.identity, attempt_id: first.attempt_id, transfer_request: first.transfer_request });
      const old = { ...first, transfer_request: { ...first.transfer_request } };
      delete old.transfer_request.root_ignore_capability;
      delete old.transfer_request.root_ignore_oid;
      await writeFile(checkpointPath, JSON.stringify(old));
      await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toMatchObject({ code: 'legacy_upload_checkpoint' });
      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toEqual(old);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rebuilds an unaccepted queued commit under the current policy without dropping local content', async () => {
    const { root, core } = await fixture();
    const { base, queued } = await stageStaleQueuedCommit(root, core, { acceptedRef: true });
    const push = stubUploadTransport(core, base);

    await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toThrow('network interrupted');

    const manifest = push.mock.calls[0]?.[2] as Record<string, unknown>;
    const rebuilt = manifest.target_commit as string;
    expect(rebuilt).not.toBe(queued);
    expect(manifest.expected_device_ref).toBe(base);
    expect(manifest.root_ignore_capability).toBe('root-ignore-v1');
    expect(await core.validateUploadTargetRootIgnore(rebuilt)).toBe((await core.readRootIgnorePolicy()).oid);
    expect([...(await core.listTreeBlobOids(rebuilt)).keys()]).toEqual(['.gitignore', 'slug.md']);
    expect(await core.readQueue()).toMatchObject({ pending_commit: rebuilt, expected_device_ref: base, status: 'queued_local' });
    expect((await core.readState()).local_head).toBe(rebuilt);
    expect(await readFile(join(root, 'cache', 'vectors.bin'), 'utf8')).toBe('derived bytes v2');
    expect(await core.resolveRef('refs/heads/local')).toBe(rebuilt);
  });

  it('keeps a queued commit whose pinned policy still matches the working file', async () => {
    const { root, core } = await fixture();
    await writeFile(join(root, 'rules.md'), 'note');
    await writeFile(join(root, '.gitignore'), 'other/\n');
    const base = await core.createLocalCommit('obts: base');
    await writeFile(join(root, 'rules.md'), 'note changed');
    const queued = await core.createLocalCommit('obts: local vault changes');
    await core.writeState({
      ...await core.readState(),
      vault_id: 'vlt_policy_current',
      device_id: 'dev_policy_current',
      local_main: base,
      server_device_ref: base,
      local_head: queued
    });
    await core.writeQueue({ pending_commit: queued, expected_device_ref: base, status: 'queued_local', attempts: 0, updated_at: new Date().toISOString() });
    const push = stubUploadTransport(core, base);

    await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toThrow('network interrupted');

    expect(push.mock.calls[0]?.[2].target_commit).toBe(queued);
    expect((await core.readQueue()).pending_commit).toBe(queued);
  });

  it('never rewrites queued ancestry the server has not accepted', async () => {
    const { root, core } = await fixture();
    const { queued } = await stageStaleQueuedCommit(root, core, { acceptedRef: false });
    const push = stubUploadTransport(core, null);

    await expect(core.uploadQueuedCommit(await core.readQueue())).rejects.toThrow('network interrupted');

    expect(push.mock.calls[0]?.[2].target_commit).toBe(queued);
    expect((await core.readQueue()).pending_commit).toBe(queued);
    expect(await core.resolveRef('refs/heads/local')).toBe(queued);
  });

  it('rejects excluded paths in an immutable target even when the mutable root has changed', async () => {
    const { root, core } = await fixture();
    await writeFile(join(root, 'hidden.md'), 'tracked');
    const target = await core.createLocalCommit('old commit');
    const bytes = Buffer.from('hidden.md\n');
    const oid = await git.writeBlob({ fs: await import('node:fs'), dir: root, gitdir: join(root, '.obts', 'git'), blob: bytes });
    const entries = await core.flattenTree(target);
    entries.set('.gitignore', { mode: '100644', path: '.gitignore', oid, type: 'blob' });
    const tree = await core.writeTreeFromEntries(entries);
    const invalid = await core.commitTree(tree, target, 'invalid immutable tree');
    await expect(core.validateUploadTargetRootIgnore(invalid)).rejects.toMatchObject({ code: 'excluded_root_ignore_path' });
  });

  it('fails closed for invalid, oversized, and unreadable policy and does not hide visible .git in ignored directories', async () => {
    const { root, core, headless } = await fixture();
    expect((await core.readRootIgnorePolicy()).oid).toBeNull();
    expect((await headless.readRootIgnorePolicy()).oid).toBeNull();
    await symlink('missing.txt', join(root, '.gitignore'));
    await expect(core.readRootIgnorePolicy()).rejects.toThrow(/regular readable file/u);
    await rm(join(root, '.gitignore'));
    await mkdir(join(root, '.gitignore'));
    await expect(core.readRootIgnorePolicy()).rejects.toThrow(/regular readable file/u);
    await expect(headless.readRootIgnorePolicy()).rejects.toThrow(/regular readable file/u);
    await rm(join(root, '.gitignore'), { recursive: true });
    await writeFile(join(root, '.gitignore'), Buffer.from([0xff]));
    await expect(core.readRootIgnorePolicy()).rejects.toThrow();
    await expect(headless.readRootIgnorePolicy()).rejects.toThrow();
    await writeFile(join(root, '.gitignore'), Buffer.alloc(MAX_ROOT_IGNORE_BYTES + 1));
    const read = vi.spyOn(core.adapter, 'readBinary');
    await expect(core.readRootIgnorePolicy()).rejects.toThrow(/byte limit/u);
    expect(read.mock.calls.some(([path]) => path === '.gitignore')).toBe(false);
    await expect(headless.readRootIgnorePolicy()).rejects.toThrow(/byte limit/u);
    await writeFile(join(root, '.gitignore'), 'hidden/\n');
    read.mockRestore();
    const failRead = vi.spyOn(core.adapter, 'readRootIgnorePolicyNoFollow').mockRejectedValue(new Error('unreadable'));
    await expect(core.readRootIgnorePolicy()).rejects.toThrow('unreadable');
    failRead.mockRestore();
    await mkdir(join(root, 'hidden', '.git'), { recursive: true });
    const pin = await core.readRootIgnorePolicy();
    await expect(core.scanSyncableFiles(pin.policy)).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(headless.scanSyncableFiles((await headless.readRootIgnorePolicy()).policy)).rejects.toMatchObject({ code: 'excluded_git_path' });
  });

  it('never follows a policy symlink swapped in during local capture', async () => {
    const { root, core } = await fixture();
    await writeFile(join(root, '.gitignore'), '*.tmp\n');
    await writeFile(join(root, 'visible.md'), 'visible');
    await writeFile(join(root, 'other.txt'), 'synthetic outside policy');
    const before = await core.resolveRef('refs/heads/local');
    const original = core.adapter.readRootIgnorePolicyNoFollow.bind(core.adapter);
    const ordinaryRead = vi.spyOn(core.adapter, 'readBinary');
    let reads = 0;
    vi.spyOn(core.adapter, 'readRootIgnorePolicyNoFollow').mockImplementation(async (...args: unknown[]) => {
      if (++reads === 3) {
        await rm(join(root, '.gitignore'));
        await symlink('other.txt', join(root, '.gitignore'));
      }
      return await original(...args);
    });
    await expect(core.createLocalCommit('swapped policy')).rejects.toThrow();
    expect(ordinaryRead.mock.calls.some(([path]) => path === '.gitignore')).toBe(false);
    expect(await core.resolveRef('refs/heads/local')).toBe(before);
  });

  it('rejects a hidden symlink policy and detects same-size replacement during the adapter read', async () => {
    const { root, core, headless } = await fixture();
    await writeFile(join(root, 'other.txt'), '*.md\n');
    await symlink('other.txt', join(root, '.gitignore'));
    await expect(core.readRootIgnorePolicy()).rejects.toThrow(/regular readable file/u);
    await expect(headless.readRootIgnorePolicy()).rejects.toThrow(/regular readable file/u);
    await rm(join(root, '.gitignore'));
    await writeFile(join(root, '.gitignore'), 'one.md\n');
    const originalRead = core.adapter.readRootIgnorePolicyNoFollow.bind(core.adapter);
    let first = true;
    const read = vi.spyOn(core.adapter, 'readRootIgnorePolicyNoFollow').mockImplementation(async (...args: unknown[]) => {
      const result = await originalRead(...args);
      if (first) {
        first = false;
        await writeFile(join(root, '.gitignore'), 'two.md\n');
      }
      return result;
    });
    await expect(core.readRootIgnorePolicy()).rejects.toThrow(/changed while reading/u);
    read.mockRestore();
  });
});
