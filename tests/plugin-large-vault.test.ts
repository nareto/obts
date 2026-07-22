import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
const delay = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

async function clientFixture(): Promise<{ root: string; plugin: ObtsPluginClient; core: any }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-large-vault-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'large-vault-test' });
  await plugin.initialize();
  return { root, plugin, core: (plugin as any).client };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('large-vault client checkpoints', () => {
  it('checks files concurrently within the configured bound', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'notes'));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(root, 'notes', `${index}.md`), `note ${index}\n`);
    }

    core.fileWorkConcurrency = 3;
    const adapter = core.adapter;
    const readBinary = adapter.readBinary.bind(adapter);
    let active = 0;
    let maximum = 0;
    adapter.readBinary = async (path: string) => {
      if (!path.startsWith('.obts/')) {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(10);
      }
      try {
        return await readBinary(path);
      } finally {
        if (!path.startsWith('.obts/')) active -= 1;
      }
    };

    await expect(core.createLocalCommit('bounded checkpoint')).resolves.toMatch(/^[0-9a-f]{40}$/u);
    expect(maximum).toBe(3);
  });

  it('packs only local history that is not already reachable from main', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    await writeFile(join(root, 'note.md'), 'base\n');
    const base = await core.createLocalCommit('base checkpoint');
    await core.updateRef('refs/heads/main', base, null, true);

    await expect(core.createRecoveryRefsPack()).resolves.toHaveLength(0);

    const basePack = await core.packObjects(await core.collectReachableObjects(base));
    await writeFile(join(root, 'note.md'), 'small local change\n');
    const localTip = await core.createLocalCommit('local-only checkpoint');
    const deltaPack = await core.createRecoveryRefsPack();
    expect(deltaPack.byteLength).toBeGreaterThan(0);
    expect(deltaPack.byteLength).toBeLessThan(256 * 1024);

    const restored = await clientFixture();
    await restored.core.importPack(basePack);
    await restored.core.importPack(deltaPack);
    await expect(restored.core.commitExists(localTip)).resolves.toBe(true);
    await expect(restored.core.listTreeBlobOids(localTip)).resolves.toEqual(await core.listTreeBlobOids(localTip));
  });

  it('plans a large deletion from changed tree objects and caches retries', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'notes'));
    for (let index = 0; index < 120; index += 1) {
      await writeFile(join(root, 'notes', `${index}.md`), `note ${index}\n`);
    }
    const base = await core.createLocalCommit('large deletion base');
    const basePack = await core.packObjects(await core.collectReachableObjects(base));
    await core.updateRef('refs/heads/main', base, null, true);
    for (let index = 0; index < 110; index += 1) {
      await rm(join(root, 'notes', `${index}.md`));
    }
    const deleted = await core.createLocalCommit('large deletion');
    const incrementalObjects = await core.collectIncrementalPackObjects(deleted, [base]);
    expect(incrementalObjects.length).toBeLessThan(10);

    const originalCollect = core.collectIncrementalPackObjects.bind(core);
    let collectCalls = 0;
    core.collectIncrementalPackObjects = async (...args: unknown[]) => {
      collectCalls += 1;
      return await originalCollect(...args);
    };
    const first = await core.planPackChunks(deleted, [base], 128, 2 * 1024 * 1024);
    const second = await core.planPackChunks(deleted, [base], 128, 2 * 1024 * 1024);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(collectCalls).toBe(1);

    const restored = await clientFixture();
    await restored.core.importPack(basePack);
    for (const group of first) await restored.core.importPack(await core.packObjectChunk(group, 2 * 1024 * 1024));
    await expect(restored.core.commitExists(deleted)).resolves.toBe(true);
    await expect(restored.core.listTreeBlobOids(deleted)).resolves.toEqual(await core.listTreeBlobOids(deleted));
  });

  it('reconstructs merge and file-tree replacement packs from the excluded base', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'shared.md'), 'base\n');
    await writeFile(join(root, 'nested', 'old.md'), 'old\n');
    const base = await core.createLocalCommit('merge base');
    const basePack = await core.packObjects(await core.collectReachableObjects(base));
    await core.updateRef('refs/heads/main', base, null, true);

    await rm(join(root, 'nested'), { recursive: true, force: true });
    await writeFile(join(root, 'nested'), 'replacement file\n');
    await writeFile(join(root, 'shared.md'), 'left\n');
    const left = await core.createLocalCommit('left branch');

    await core.updateRef('refs/heads/local', base, left, true);
    await rm(join(root, 'nested'), { force: true });
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'old.md'), 'old\n');
    await writeFile(join(root, 'shared.md'), 'base\n');
    await writeFile(join(root, 'right.md'), 'right\n');
    const right = await core.createLocalCommit('right branch');

    await core.updateRef('refs/heads/local', left, right, true);
    await rm(join(root, 'nested'), { recursive: true, force: true });
    await writeFile(join(root, 'nested'), 'replacement file\n');
    await writeFile(join(root, 'shared.md'), 'left\n');
    const combined = await core.createLocalCommit('combined tree');
    const combinedCommit = await git.readCommit({
      fs: core.fs,
      dir: core.vaultDir,
      gitdir: core.gitdir,
      oid: combined
    });
    const signature = {
      name: 'obts test',
      email: 'obts-test@example.invalid',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0
    };
    const merge = await git.writeCommit({
      fs: core.fs,
      dir: core.vaultDir,
      gitdir: core.gitdir,
      commit: {
        tree: combinedCommit.commit.tree,
        parent: [left, right],
        author: signature,
        committer: signature,
        message: 'merge closure\n'
      }
    });

    const groups = await core.planPackChunks(merge, [base], 128, 2 * 1024 * 1024);
    expect(groups.length).toBeGreaterThan(1);
    const restored = await clientFixture();
    await restored.core.importPack(basePack);
    for (const group of groups) await restored.core.importPack(await core.packObjectChunk(group, 2 * 1024 * 1024));
    await expect(restored.core.commitExists(left)).resolves.toBe(true);
    await expect(restored.core.commitExists(right)).resolves.toBe(true);
    await expect(restored.core.commitExists(merge)).resolves.toBe(true);
    await expect(restored.core.listTreeBlobOids(merge)).resolves.toEqual(await core.listTreeBlobOids(merge));
  });

  it('drains bounded apply writes before returning', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'incoming'));
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, 'incoming', `${index}.md`), `incoming ${index}\n`);
    }
    const target = await core.createLocalCommit('target');
    const targetEntries = await core.listTreeBlobOids(target);
    await rm(join(root, 'incoming'), { recursive: true, force: true });

    core.fileWorkConcurrency = 3;
    const adapterWriteBinary = core.adapterWriteBinary.bind(core);
    let active = 0;
    let maximum = 0;
    core.adapterWriteBinary = async (path: string, content: Buffer) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(10);
      try {
        await adapterWriteBinary(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    await core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_bounded_test',
      operation_type: 'pull_apply',
      target_main: target,
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: paths,
      preflight_sha256: Object.fromEntries(paths.map((path) => [path, null])),
      preflight_fingerprints: Object.fromEntries(paths.map((path) => [path, { kind: 'missing', sha256: null, oid: null }])),
      recovery_bundle_id: 'rec_bounded_test',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, targetEntries, new Set());

    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(await readFile(join(root, 'incoming', '7.md'), 'utf8')).toBe('incoming 7\n');
  });

  it('drains active apply writes and stops scheduling after a failure', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'incoming'));
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, 'incoming', `${index}.md`), `incoming ${index}\n`);
    }
    const target = await core.createLocalCommit('failure target');
    const targetEntries = await core.listTreeBlobOids(target);
    await rm(join(root, 'incoming'), { recursive: true, force: true });

    core.fileWorkConcurrency = 3;
    const adapterWriteBinary = core.adapterWriteBinary.bind(core);
    const started: string[] = [];
    let active = 0;
    core.adapterWriteBinary = async (path: string, content: Buffer) => {
      started.push(path);
      active += 1;
      try {
        if (path === 'incoming/0.md') {
          await delay(5);
          throw new Error('simulated apply write failure');
        }
        await delay(20);
        await adapterWriteBinary(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    await expect(core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_failure_test',
      operation_type: 'pull_apply',
      target_main: target,
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: paths,
      preflight_sha256: Object.fromEntries(paths.map((path) => [path, null])),
      preflight_fingerprints: Object.fromEntries(paths.map((path) => [path, { kind: 'missing', sha256: null, oid: null }])),
      recovery_bundle_id: 'rec_failure_test',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, targetEntries, new Set())).rejects.toThrow('simulated apply write failure');

    expect(active).toBe(0);
    expect(started).toEqual(['incoming/0.md', 'incoming/1.md', 'incoming/2.md']);
  });

  it('fails a changing inventory without advancing the local ref', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'race.md'), 'before\n');
    const adapter = core.adapter;
    const readBinary = adapter.readBinary.bind(adapter);
    let removed = false;
    adapter.readBinary = async (path: string) => {
      const value = await readBinary(path);
      if (path === 'race.md' && !removed) {
        removed = true;
        await rm(join(root, path));
      }
      return value;
    };

    await expect(core.createLocalCommit('racing checkpoint')).rejects.toMatchObject({ code: 'local_snapshot_changed' });
    expect(await core.resolveRef('refs/heads/local')).toBeNull();
  });
});
