import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>, rules: string, deletedInTarget: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'obts-ignore-apply-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ignore-apply' });
  await plugin.initialize();
  const core = (plugin as any).client;
  for (const [filePath, contents] of Object.entries(files)) {
    await mkdir(join(root, filePath, '..'), { recursive: true });
    await writeFile(join(root, filePath), contents);
  }
  const base = await core.createLocalCommit('baseline');
  await core.updateRef('refs/heads/main', base, null, true);
  await writeFile(join(root, '.gitignore'), rules);
  for (const filePath of deletedInTarget) await rm(join(root, filePath));
  const target = await core.createLocalCommit('server policy');
  const targetEntries: Map<string, string> = await core.listTreeBlobOids(target);
  const sizes = Object.fromEntries(await Promise.all([...targetEntries].map(async ([filePath, oid]) =>
    [filePath, (await core.readBlobOid(oid)).byteLength]
  )));
  await rm(join(root, '.gitignore'));
  for (const filePath of deletedInTarget) await writeFile(join(root, filePath), files[filePath]!);
  await core.updateRef('refs/heads/local', base, null, true);
  await core.writeState({ ...await core.readState(), local_main: base, local_head: base });
  return { root, core, base, target, targetEntries, sizes };
}

async function apply(f: Awaited<ReturnType<typeof fixture>>, changedPaths: string[], clean = true) {
  return f.core.applyTargetMain(f.target, changedPaths, true, [], clean, [], [], 1, false, null, f.sizes);
}

describe('root ignore pull apply journal', () => {
  it('retains formerly tracked physical files without queuing their deletion', async () => {
    const f = await fixture({ 'tracked.md': 'retained\n', 'keep.md': 'unchanged\n' }, 'tracked.md\n');
    expect(await apply(f, ['tracked.md', '.gitignore'])).toBe(true);
    expect(await readFile(join(f.root, 'tracked.md'), 'utf8')).toBe('retained\n');
    expect((await f.core.listTreeBlobOids(f.target)).has('tracked.md')).toBe(false);
    expect((await f.core.readQueue()).pending_commit).toBeNull();
    expect(await f.core.resolveRef('refs/heads/main')).toBe(f.target);
  });

  it('keeps ignored directories and honors negation in the target policy', async () => {
    const f = await fixture({ 'folder/drop.md': 'local\n', 'folder/keep.md': 'synced\n' }, 'folder/*\n!folder/keep.md\n');
    expect(await apply(f, ['folder/drop.md', '.gitignore'])).toBe(true);
    expect(await readFile(join(f.root, 'folder/drop.md'), 'utf8')).toBe('local\n');
    expect(await readFile(join(f.root, 'folder/keep.md'), 'utf8')).toBe('synced\n');
    expect((await f.core.readQueue()).pending_commit).toBeNull();
  });

  it('does not honor an explicit tombstone over a retained ignored directory', async () => {
    const f = await fixture({ 'folder/one.md': 'one\n' }, 'folder/\n');
    expect(await f.core.applyTargetMain(f.target, ['folder/one.md', '.gitignore'], true, [], true,
      [{ op: 'delete', path: 'folder' }], [], 1, false, null, f.sizes)).toBe(true);
    expect(await readFile(join(f.root, 'folder/one.md'), 'utf8')).toBe('one\n');
    expect((await f.core.readQueue()).pending_commit).toBeNull();
  });

  it('keeps newly ignored untracked files while preserving normal clean-state checks', async () => {
    const f = await fixture({ 'keep.md': 'keep\n' }, 'scratch.md\n');
    await writeFile(join(f.root, 'scratch.md'), 'untracked local\n');
    expect(await apply(f, ['.gitignore'])).toBe(true);
    expect(await readFile(join(f.root, 'scratch.md'), 'utf8')).toBe('untracked local\n');
    expect((await f.core.readQueue()).pending_commit).toBeNull();
  });

  it('replays a crash after the target file write while retaining local-only bytes', async () => {
    const f = await fixture({ 'ignored.md': 'local\n', 'ordinary.md': 'old\n' }, 'ignored.md\n');
    const original = f.core.writeTargetFilesFromJournal.bind(f.core);
    f.core.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await original(...args);
      throw new Error('injected crash after write');
    };
    await expect(apply(f, ['ignored.md', '.gitignore'])).rejects.toThrow('injected crash');
    const journal = JSON.parse(await readFile(join(f.root, '.obts/apply-journal.json'), 'utf8'));
    expect(journal).toMatchObject({ journal_version: 5, target_root_ignore_oid: f.targetEntries.get('.gitignore'), local_only_paths: ['ignored.md'] });
    const restarted = new ObtsPluginClient(f.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ignore-replay' });
    await restarted.initialize();
    expect(await readFile(join(f.root, 'ignored.md'), 'utf8')).toBe('local\n');
    expect(await restarted.readState()).toMatchObject({ local_main: f.target });
    expect(await readFile(join(f.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });

  it('blocks policy OID drift on restart without consuming the journal', async () => {
    const f = await fixture({ 'ignored.md': 'local\n' }, 'ignored.md\n');
    const original = f.core.writeTargetFilesFromJournal.bind(f.core);
    f.core.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await original(...args);
      throw new Error('injected crash');
    };
    await expect(apply(f, ['ignored.md', '.gitignore'])).rejects.toThrow('injected crash');
    const journalPath = join(f.root, '.obts/apply-journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    await writeFile(journalPath, JSON.stringify({ ...journal, target_root_ignore_oid: 'a'.repeat(40) }));
    const restarted = new ObtsPluginClient(f.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ignore-drift' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await readFile(journalPath, 'utf8')).toContain('a'.repeat(40));
    expect(await readFile(join(f.root, 'ignored.md'), 'utf8')).toBe('local\n');
  });

  it('blocks a target file colliding with a retained ignored directory before any write', async () => {
    const f = await fixture({ 'nested/local.md': 'local\n', 'target.md': 'target\n' }, 'nested/**\n');
    const targetOid = f.targetEntries.get('target.md');
    const changed = new Map(await f.core.flattenTree(f.target));
    const source = changed.get('target.md');
    changed.delete('target.md');
    changed.set('nested', source);
    const tree = await f.core.writeTreeFromEntries(changed);
    const collisionTarget = await f.core.commitTree(tree, f.base, 'colliding file');
    await f.core.updateRef('refs/heads/local', f.base, null, true);
    await expect(f.core.applyTargetMain(collisionTarget, ['nested/local.md', 'nested'], true, [], true,
      [], [], 1, false, null, { nested: (await f.core.readBlobOid(targetOid)).byteLength,
        '.gitignore': f.sizes['.gitignore'] })).rejects.toMatchObject({ code: 'local_only_collision' });
    expect(await readFile(join(f.root, 'nested/local.md'), 'utf8')).toBe('local\n');
    expect(await readFile(join(f.root, '.gitignore')).catch(() => null)).toBeNull();
  });

  it('blocks an ignored physical file colliding with a target directory', async () => {
    const f = await fixture({ foo: 'local\n', 'fresh.md': 'remote\n' }, '/foo\n!/foo/\n');
    const changed = new Map(await f.core.flattenTree(f.target));
    const source = changed.get('fresh.md');
    changed.delete('fresh.md');
    changed.set('foo/bar.md', source);
    const tree = await f.core.writeTreeFromEntries(changed);
    const collisionTarget = await f.core.commitTree(tree, f.base, 'target directory');
    await expect(f.core.applyTargetMain(collisionTarget, ['foo', 'foo/bar.md', '.gitignore'], true, [], true,
      [], [], 1, false, null, { 'foo/bar.md': f.sizes['fresh.md'], '.gitignore': f.sizes['.gitignore'] }))
      .rejects.toMatchObject({ code: 'local_only_collision' });
    expect(await readFile(join(f.root, 'foo'), 'utf8')).toBe('local\n');
    expect(await readFile(join(f.root, '.gitignore')).catch(() => null)).toBeNull();
  });

  it('blocks legacy v4 replay under active target policy and retains its journal', async () => {
    const f = await fixture({ 'ignored.md': 'local\n' }, 'ignored.md\n');
    const original = f.core.writeTargetFilesFromJournal.bind(f.core);
    f.core.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await original(...args);
      throw new Error('injected crash');
    };
    await expect(apply(f, ['ignored.md', '.gitignore'])).rejects.toThrow('injected crash');
    const journalPath = join(f.root, '.obts/apply-journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    await writeFile(journalPath, JSON.stringify({ ...journal, journal_version: 4 }));
    const restarted = new ObtsPluginClient(f.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'legacy-replay' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(JSON.parse(await readFile(journalPath, 'utf8')).journal_version).toBe(4);
    expect(await readFile(join(f.root, 'ignored.md'), 'utf8')).toBe('local\n');
  });

  it('blocks replay if the retained local-only file disappears', async () => {
    const f = await fixture({ 'ignored.md': 'local\n' }, 'ignored.md\n');
    const original = f.core.writeTargetFilesFromJournal.bind(f.core);
    f.core.writeTargetFilesFromJournal = async (...args: unknown[]) => {
      await original(...args);
      throw new Error('injected crash');
    };
    await expect(apply(f, ['ignored.md', '.gitignore'])).rejects.toThrow('injected crash');
    await rm(join(f.root, 'ignored.md'));
    const restarted = new ObtsPluginClient(f.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'absence-replay' });
    await restarted.initialize();
    expect(await restarted.readState()).toMatchObject({ last_error_code: 'apply_journal_recovery_required' });
    expect(await readFile(join(f.root, '.obts/apply-journal.json'), 'utf8')).toContain('ignored.md');
  });

  it('defers an unrelated local edit rather than treating it as policy-only', async () => {
    const f = await fixture({ 'keep.md': 'old\n', 'ignored.md': 'local\n' }, 'ignored.md\n');
    await writeFile(join(f.root, 'keep.md'), 'changed\n');
    expect(await apply(f, ['ignored.md', '.gitignore'])).toBe(false);
    expect(await readFile(join(f.root, 'keep.md'), 'utf8')).toBe('changed\n');
    expect(await readFile(join(f.root, 'ignored.md'), 'utf8')).toBe('local\n');
    expect(await f.core.resolveRef('refs/heads/main')).toBe(f.base);
  });

  it('still deletes ordinary non-policy paths with a recovery bundle', async () => {
    const f = await fixture({ 'ordinary.md': 'local\n' }, 'unrelated.md\n', ['ordinary.md']);
    expect(await apply(f, ['ordinary.md', '.gitignore'])).toBe(true);
    expect(await readFile(join(f.root, 'ordinary.md')).catch(() => null)).toBeNull();
    expect(await f.core.resolveRef('refs/heads/main')).toBe(f.target);
  });
});
