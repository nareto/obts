import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('rejects an oversized target blob before materializing it', async () => {
    const { core } = await clientFixture();
    core.fileBufferBudgetBytes = 4;
    core.readBlobOid = vi.fn(async () => Buffer.from('oversized'));

    await expect(core.writeTargetFileBatch(
      ['large.md'],
      new Map([['large.md', 'a'.repeat(40)]]),
      { 'large.md': 5 },
      {},
      async () => undefined,
      async () => undefined,
      () => undefined
    )).rejects.toMatchObject({ code: 'file_buffer_budget_exceeded' });
    expect(core.readBlobOid).not.toHaveBeenCalled();
  });

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
    const adapterWriteBinaryExclusive = core.adapterWriteBinaryExclusive.bind(core);
    let active = 0;
    let maximum = 0;
    core.adapterWriteBinaryExclusive = async (path: string, content: Buffer) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(10);
      try {
        await adapterWriteBinaryExclusive(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    const targetFileSizes = Object.fromEntries(await Promise.all(
      [...targetEntries].map(async ([path, oid]) => [path, (await core.readBlobOid(oid)).byteLength])
    ));
    await core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_bounded_test',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: targetFileSizes,
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

  it('revalidates each path at the mutation seam', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');

    await writeFile(join(root, 'target-source.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('mutation revalidation target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('target-source.md');
    expect(targetOid).toMatch(/^[0-9a-f]{40}$/u);
    const sharedTargetEntries = new Map([['shared.md', targetOid]]);
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;

    const originalReadBlobOid = core.readBlobOid.bind(core);
    core.readBlobOid = async (oid: string) => {
      const content = await originalReadBlobOid(oid);
      await writeFile(join(root, 'shared.md'), 'concurrent local edit\n');
      return content;
    };

    await expect(core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_mutation_revalidation',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      recovery_bundle_id: 'rec_mutation_revalidation',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, sharedTargetEntries, new Set())).rejects.toMatchObject({ filePath: 'shared.md' });

    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('concurrent local edit\n');
  });

  it('preserves a path created at the exclusive-write boundary', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');
    await writeFile(join(root, 'target-source.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('exclusive write race target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('target-source.md');
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;
    const originalExclusiveWrite = core.adapterWriteBinaryExclusive.bind(core);
    core.adapterWriteBinaryExclusive = async (path: string, content: Buffer) => {
      await writeFile(join(root, path), 'last-moment local edit\n');
      return await originalExclusiveWrite(path, content);
    };

    await expect(core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_exclusive_write_race',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      recovery_bundle_id: 'rec_exclusive_write_race',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, new Map([['shared.md', targetOid]]), new Set())).rejects.toMatchObject({ filePath: 'shared.md' });

    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('last-moment local edit\n');
    expect(await readFile(join(
      root,
      '.obts',
      'apply-displaced',
      'apply_exclusive_write_race',
      `${encodeURIComponent('shared.md')}.entry`
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('captures displaced file evidence by copy without renaming the live path', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('copy displacement target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('shared.md');
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');
    const renames: string[] = [];
    const originalRename = core.adapter.rename.bind(core.adapter);
    core.adapter.rename = async (from: string, to: string) => {
      renames.push(`${from}->${to}`);
      return await originalRename(from, to);
    };

    await core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_copy_displacement',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_copy_displacement',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, new Map([['shared.md', targetOid]]), new Set());

    expect(renames).toEqual([]);
    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('server target bytes\n');
    expect(await readFile(join(
      root,
      '.obts',
      'apply-displaced',
      'apply_copy_displacement',
      `${encodeURIComponent('shared.md')}.entry`
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('completes an interrupted displacement whose evidence copy already exists while the live file remains', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('interrupted copy displacement target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('shared.md');
    const targetSize = Buffer.byteLength('server target bytes\n');
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');
    const journal = {
      journal_version: 4,
      apply_id: 'apply_interrupted_copy_displacement',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_interrupted_copy_displacement',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    };
    await writeFile(join(root, '.obts', 'apply-journal.json'), `${JSON.stringify(journal)}\n`);
    await mkdir(join(root, '.obts', 'apply-displaced', journal.apply_id), { recursive: true });
    await writeFile(join(
      root,
      '.obts',
      'apply-displaced',
      journal.apply_id,
      `${encodeURIComponent('shared.md')}.entry`
    ), 'captured local bytes\n');

    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'interrupted-copy-displacement' });
    await restarted.initialize();

    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('server target bytes\n');
    expect(await readFile(join(root, '.obts', 'apply-journal.json'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(
      root,
      '.obts',
      'recovery-displaced',
      journal.apply_id,
      `${encodeURIComponent('shared.md')}.entry`
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('captures deleted directory evidence by copy without renaming the live directory', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'note.md'), 'captured local bytes\n');
    await writeFile(join(root, 'target-source.md'), 'server target bytes\n');
    await rm(join(root, 'folder'), { recursive: true, force: true });
    const target = await core.createLocalCommit('directory copy displacement target');
    const targetEntries = await core.listTreeBlobOids(target);
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'note.md'), 'captured local bytes\n');
    const preflightDir = await core.readRecoveryFileSnapshot('folder');
    const preflightFile = await core.readRecoveryFileSnapshot('folder/note.md');
    const preflightCtime = await core.adapterDirectoryCreationTime('folder');
    const renames: string[] = [];
    const originalRename = core.adapter.rename.bind(core.adapter);
    core.adapter.rename = async (from: string, to: string) => {
      renames.push(`${from}->${to}`);
      return await originalRename(from, to);
    };

    await core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_directory_copy_displacement',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: {},
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['folder', 'folder/note.md'],
      preflight_sha256: { folder: null, 'folder/note.md': preflightFile.fingerprint.sha256 },
      preflight_fingerprints: {
        folder: preflightDir.fingerprint,
        'folder/note.md': preflightFile.fingerprint
      },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: ['folder'],
      pre_apply_directory_ctimes: { folder: preflightCtime },
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_directory_copy_displacement',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, targetEntries, new Set());

    expect(renames).toEqual([]);
    expect(await core.adapterExists('folder')).toBe(false);
    expect(await readFile(join(
      root,
      '.obts',
      'apply-displaced',
      'apply_directory_copy_displacement',
      `${encodeURIComponent('folder')}.entry`,
      'note.md'
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('replays a crash after displacement without losing the captured path', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');
    await writeFile(join(root, 'shared.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('displacement replay target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('shared.md');
    const targetSize = Buffer.byteLength('server target bytes\n');
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const journal = {
      journal_version: 4,
      apply_id: 'apply_displacement_replay',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_displacement_replay',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    };
    await writeFile(join(root, '.obts', 'apply-journal.json'), `${JSON.stringify(journal)}\n`);
    await core.adapter.rename(
      'shared.md',
      `.obts/apply-displaced/${journal.apply_id}/${encodeURIComponent('shared.md')}.entry`
    );

    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'displacement-replay' });
    await restarted.initialize();

    expect(await restarted.readState()).not.toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('server target bytes\n');
    expect(await readFile(join(
      root,
      '.obts',
      'recovery-displaced',
      journal.apply_id,
      `${encodeURIComponent('shared.md')}.entry`
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('rolls forward a crash after target creation and before phase advancement', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const preflight = await core.readRecoveryFileSnapshot('shared.md');
    await writeFile(join(root, 'shared.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('post-create crash target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('shared.md');
    await writeFile(join(root, 'shared.md'), 'captured local bytes\n');
    const journal = {
      journal_version: 4,
      apply_id: 'apply_post_create_replay',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'shared.md': Buffer.byteLength('server target bytes\n') },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['shared.md'],
      preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
      preflight_fingerprints: { 'shared.md': preflight.fingerprint },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_post_create_replay',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    };
    await writeFile(join(root, '.obts', 'apply-journal.json'), `${JSON.stringify(journal)}\n`);
    await core.adapter.rename(
      'shared.md',
      `.obts/apply-displaced/${journal.apply_id}/${encodeURIComponent('shared.md')}.entry`
    );
    await core.adapterWriteBinaryExclusive('shared.md', await core.readBlobOid(targetOid));

    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'post-create-replay' });
    await restarted.initialize();

    expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('server target bytes\n');
    expect(await restarted.readState()).not.toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await readFile(join(root, '.obts', 'apply-journal.json'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(
      root,
      '.obts',
      'recovery-displaced',
      journal.apply_id,
      `${encodeURIComponent('shared.md')}.entry`
    ), 'utf8')).toBe('captured local bytes\n');
  });

  it('does not delete a concurrent blocking ancestor before mutation', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'note.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('blocking ancestor target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('folder/note.md');
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;
    await rm(join(root, 'folder'), { recursive: true, force: true });

    const originalReadBlobOid = core.readBlobOid.bind(core);
    core.readBlobOid = async (oid: string) => {
      const content = await originalReadBlobOid(oid);
      await writeFile(join(root, 'folder'), 'concurrent ancestor edit\n');
      return content;
    };

    await expect(core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_blocking_ancestor',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'folder/note.md': targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['folder/note.md'],
      preflight_sha256: { 'folder/note.md': null },
      preflight_fingerprints: { 'folder/note.md': { kind: 'missing', sha256: null, oid: null } },
      recovery_bundle_id: 'rec_blocking_ancestor',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, new Map([['folder/note.md', targetOid]]), new Set())).rejects.toMatchObject({ filePath: 'folder' });

    expect(await readFile(join(root, 'folder'), 'utf8')).toBe('concurrent ancestor edit\n');
  });

  it('materializes a target descendant after displacing a blocking file ancestor', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'folder'), 'captured blocking file\n');
    const preflight = await core.readRecoveryFileSnapshot('folder');
    await rm(join(root, 'folder'));
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'note.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('file to directory target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('folder/note.md');
    await rm(join(root, 'folder'), { recursive: true, force: true });
    await writeFile(join(root, 'folder'), 'captured blocking file\n');
    const journal = {
      journal_version: 4,
      apply_id: 'apply_file_to_directory',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'folder/note.md': Buffer.byteLength('server target bytes\n') },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['folder', 'folder/note.md'],
      preflight_sha256: { folder: preflight.fingerprint.sha256, 'folder/note.md': null },
      preflight_fingerprints: {
        folder: preflight.fingerprint,
        'folder/note.md': { kind: 'missing', sha256: null, oid: null }
      },
      recovery_bundle_id: 'rec_file_to_directory',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    };

    await core.writeTargetFilesFromJournal(journal, new Map([['folder/note.md', targetOid]]), new Set());

    expect(await readFile(join(root, 'folder', 'note.md'), 'utf8')).toBe('server target bytes\n');
    expect(await readFile(join(
      root,
      '.obts',
      'apply-displaced',
      journal.apply_id,
      `${encodeURIComponent('folder')}.entry`
    ), 'utf8')).toBe('captured blocking file\n');
  });

  it('replays file-to-directory materialization after displacing the ancestor', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'folder'), 'captured blocking file\n');
    const preflight = await core.readRecoveryFileSnapshot('folder');
    await rm(join(root, 'folder'));
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'note.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('file to directory replay target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('folder/note.md');
    await rm(join(root, 'folder'), { recursive: true, force: true });
    await writeFile(join(root, 'folder'), 'captured blocking file\n');
    const journal = {
      journal_version: 4,
      apply_id: 'apply_file_to_directory_replay',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { 'folder/note.md': Buffer.byteLength('server target bytes\n') },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['folder', 'folder/note.md'],
      preflight_sha256: { folder: preflight.fingerprint.sha256, 'folder/note.md': null },
      preflight_fingerprints: {
        folder: preflight.fingerprint,
        'folder/note.md': { kind: 'missing', sha256: null, oid: null }
      },
      directory_intents: [],
      explicit_directories: [],
      pre_apply_directories: [],
      pre_apply_directory_ctimes: {},
      confirmed_directory_roots: [],
      confirmed_directory_inventory: null,
      preserve_local_changes: false,
      event_seq: null,
      recovery_bundle_id: 'rec_file_to_directory_replay',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    };
    await writeFile(join(root, '.obts', 'apply-journal.json'), `${JSON.stringify(journal)}\n`);
    await core.adapter.rename(
      'folder',
      `.obts/apply-displaced/${journal.apply_id}/${encodeURIComponent('folder')}.entry`
    );
    await core.adapter.mkdir('folder');

    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'file-directory-replay' });
    await restarted.initialize();
    expect(await readFile(join(root, 'folder', 'note.md'), 'utf8')).toBe('server target bytes\n');
    expect(await readFile(join(root, '.obts', 'apply-journal.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('does not recursively delete recreated directory descendants', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'replacement-source.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('directory replacement target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('replacement-source.md');
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;
    await mkdir(join(root, 'replacement'));
    const preflight = await core.readRecoveryFileSnapshot('replacement');
    const preflightCtime = await core.adapterDirectoryCreationTime('replacement');

    const originalReadBlobOid = core.readBlobOid.bind(core);
    core.readBlobOid = async (oid: string) => {
      const content = await originalReadBlobOid(oid);
      await writeFile(join(root, 'replacement', 'new-local.md'), 'concurrent descendant edit\n');
      return content;
    };

    await expect(core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_recreated_descendant',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { replacement: targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['replacement'],
      preflight_sha256: { replacement: null },
      preflight_fingerprints: { replacement: preflight.fingerprint },
      pre_apply_directory_ctimes: { replacement: preflightCtime },
      recovery_bundle_id: 'rec_recreated_descendant',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, new Map([['replacement', targetOid]]), new Set())).rejects.toMatchObject({ filePath: 'replacement' });

    expect(await readFile(join(root, 'replacement', 'new-local.md'), 'utf8')).toBe('concurrent descendant edit\n');
  });

  it('does not replace a recreated empty directory', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'empty-source.md'), 'server target bytes\n');
    const target = await core.createLocalCommit('empty directory replacement target');
    const targetEntries = await core.listTreeBlobOids(target);
    const targetOid = targetEntries.get('empty-source.md');
    const targetSize = (await core.readBlobOid(targetOid)).byteLength;
    await mkdir(join(root, 'replacement'));
    const preflight = await core.readRecoveryFileSnapshot('replacement');
    const preflightCtime = await core.adapterDirectoryCreationTime('replacement');

    const originalReadBlobOid = core.readBlobOid.bind(core);
    core.readBlobOid = async (oid: string) => {
      const content = await originalReadBlobOid(oid);
      await rm(join(root, 'replacement'), { recursive: true, force: true });
      await mkdir(join(root, 'replacement'));
      return content;
    };

    await expect(core.writeTargetFilesFromJournal({
      journal_version: 4,
      apply_id: 'apply_recreated_empty_directory',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: { replacement: targetSize },
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: ['replacement'],
      preflight_sha256: { replacement: null },
      preflight_fingerprints: { replacement: preflight.fingerprint },
      pre_apply_directory_ctimes: { replacement: preflightCtime },
      recovery_bundle_id: 'rec_recreated_empty_directory',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, new Map([['replacement', targetOid]]), new Set())).rejects.toMatchObject({ filePath: 'replacement' });

    expect((await core.adapter.stat('replacement')).type).toBe('folder');
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
    const adapterWriteBinaryExclusive = core.adapterWriteBinaryExclusive.bind(core);
    const started: string[] = [];
    let releaseInitialBatch!: () => void;
    const initialBatchStarted = new Promise<void>((resolve) => { releaseInitialBatch = resolve; });
    let active = 0;
    core.adapterWriteBinaryExclusive = async (path: string, content: Buffer) => {
      started.push(path);
      if (started.length === 3) releaseInitialBatch();
      active += 1;
      try {
        await initialBatchStarted;
        if (path === 'incoming/0.md') {
          throw new Error('simulated apply write failure');
        }
        await delay(20);
        await adapterWriteBinaryExclusive(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    const targetFileSizes = Object.fromEntries(await Promise.all(
      [...targetEntries].map(async ([path, oid]) => [path, (await core.readBlobOid(oid)).byteLength])
    ));
    await expect(core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_failure_test',
      operation_type: 'pull_apply',
      target_main: target,
      target_file_sizes: targetFileSizes,
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
