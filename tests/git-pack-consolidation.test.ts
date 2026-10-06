import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import type { PathLike } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';

type Policy = { triggerPackCount: number; maxPackBytes: number; maxSources: number; factor: number };
type RunResult = { status: string; reason?: string; sources?: number; removed?: number; objects?: number; rejected?: string[] };
type Consolidator = { run(): Promise<RunResult>; recover(): Promise<void> };
type Fsp = typeof nodeFs.promises;

const require = createRequire(import.meta.url);
const consolidation = require('../obsidian-plugin/src/git-pack-consolidation.cjs') as {
  createPackConsolidator(options: {
    fsp: unknown;
    gitdir: string;
    journalPath: string;
    policy?: Partial<Policy>;
    beginPackChange?: () => () => void;
    onPackRemoved?: (packPath: string) => void;
  }): Consolidator;
  selectConsolidationSources(packs: Array<{ name: string; size: number }>, policy: Policy): Array<{ name: string; size: number }>;
  parsePackIndex(idx: Uint8Array): { entries: Array<{ oid: Buffer; crc: number; offset: number }> };
  crc32(bytes: Uint8Array): number;
};

const { createGitObjectCache, withGitObjectCaches } = require('../obsidian-plugin/src/git-object-cache.cjs') as {
  createGitObjectCache(options: { maxRetainedPackBytes: number }): { beginPackChange(): () => void };
  withGitObjectCaches(git: typeof import('isomorphic-git'), lookup: (fs: unknown) => unknown): typeof import('isomorphic-git');
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativeGit(cwd: string, args: string[], input?: string | Buffer) {
  return execFileSync('git', args, {
    cwd,
    input,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    maxBuffer: 64 * 1024 * 1024
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'obts-pack-consolidation-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  nativeGit(root, ['init', '-q', '-b', 'main', source]);
  nativeGit(root, ['init', '-q', '--bare', target]);
  return { root, source, gitdir: target, packDir: join(target, 'objects', 'pack'), journalPath: join(target, 'obts-pack-consolidation.json') };
}

function largeNote(seed: number, revision: number) {
  return Array.from({ length: 200 }, (_, line) => `note ${seed} line ${line} ${line % 17 === revision % 17 ? `edited ${revision}` : 'stable text'}`).join('\n');
}

async function commitRevision(source: string, revision: number) {
  for (let file = 0; file < 4; file += 1) await writeFile(join(source, `note-${file}.md`), `${largeNote(file, revision)}\n`);
  nativeGit(source, ['add', '-A']);
  nativeGit(source, ['commit', '-q', '-m', `revision ${revision}`]);
  return nativeGit(source, ['rev-parse', 'HEAD']).toString().trim();
}

async function importPack(gitdir: string, pack: Buffer) {
  const name = `obts-pull-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.pack`;
  await writeFile(join(gitdir, 'objects', 'pack', name), pack);
  await git.indexPack({ fs: nodeFs, dir: gitdir, gitdir, filepath: join('objects', 'pack', name) });
}

async function pullHistory(packs: number, options: { offsetDeltas: boolean }) {
  const paths = await workspace();
  const commits: string[] = [];
  const args = ['pack-objects', '--stdout', '--revs', ...(options.offsetDeltas ? ['--delta-base-offset'] : [])];
  for (let revision = 0; revision < 3; revision += 1) commits.push(await commitRevision(paths.source, revision));
  await importPack(paths.gitdir, nativeGit(paths.source, args, `${commits[2]}\n`));
  for (let pack = 1; pack < packs; pack += 1) {
    commits.push(await commitRevision(paths.source, pack + 2));
    await importPack(paths.gitdir, nativeGit(paths.source, args, `${commits[commits.length - 1]}\n^${commits[commits.length - 2]}\n`));
  }
  const objects = nativeGit(paths.source, ['rev-list', '--objects', '--all']).toString().trim().split('\n').map((line) => line.split(' ')[0]!);
  return { ...paths, commits, objects };
}

async function expectAllObjectsReadable(gitdir: string, source: string, objects: string[]) {
  const cache = {};
  for (const oid of objects) {
    const { object, type } = await git.readObject({ fs: nodeFs, dir: gitdir, gitdir, oid, format: 'content', cache });
    const expected = nativeGit(source, ['cat-file', type, oid]);
    expect(Buffer.from(object as Uint8Array).equals(expected)).toBe(true);
  }
}

async function packNames(packDir: string) {
  return (await readdir(packDir)).sort();
}

function consolidator(paths: { gitdir: string; journalPath: string }, extra: Partial<Parameters<typeof consolidation.createPackConsolidator>[0]> = {}) {
  return consolidation.createPackConsolidator({
    fsp: nodeFs.promises,
    gitdir: paths.gitdir,
    journalPath: paths.journalPath,
    policy: { triggerPackCount: 2 },
    ...extra
  });
}

describe('local pack consolidation', () => {
  for (const offsetDeltas of [true, false]) {
    it(`merges incremental pull packs with ${offsetDeltas ? 'offset' : 'reference'} deltas into one pack git can verify`, async () => {
      const history = await pullHistory(8, { offsetDeltas });
      const changes: number[] = [];
      const removed: string[] = [];
      const result = await consolidator(history, {
        beginPackChange: () => {
          changes.push(1);
          return () => changes.push(-1);
        },
        onPackRemoved: (packPath) => removed.push(packPath)
      }).run();

      expect(result).toMatchObject({ status: 'consolidated', sources: 8, removed: 8, rejected: [] });
      expect(changes).toEqual([1, -1]);
      expect(removed).toHaveLength(8);
      const names = await packNames(history.packDir);
      expect(names).toHaveLength(2);
      expect(names[0]).toMatch(/^obts-pack-[0-9a-f]{40}\.idx$/u);
      const verified = nativeGit(history.gitdir, ['verify-pack', '-v', join(history.packDir, names[0]!)]).toString();
      expect(verified).toMatch(/: ok\s*$/u);
      expect(verified).toMatch(/chain length = [1-9]/u);
      await expectAllObjectsReadable(history.gitdir, history.source, history.objects);
      await expect(stat(history.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('keeps duplicate objects from overlapping pulls readable', async () => {
    const history = await pullHistory(3, { offsetDeltas: false });
    await importPack(history.gitdir, nativeGit(history.source, ['pack-objects', '--stdout', '--revs'], `${history.commits[3]}\n`));
    const result = await consolidator(history).run();
    expect(result).toMatchObject({ status: 'consolidated', sources: 4, removed: 4 });
    const [idxName] = await packNames(history.packDir);
    const index = consolidation.parsePackIndex(await readFile(join(history.packDir, idxName!)));
    expect(new Set(index.entries.map((entry) => entry.oid.toString('hex'))).size).toBe(index.entries.length);
    expect(index.entries).toHaveLength(history.objects.length);
    expect(nativeGit(history.gitdir, ['verify-pack', '-v', join(history.packDir, idxName!)]).toString()).toMatch(/: ok\s*$/u);
    await expectAllObjectsReadable(history.gitdir, history.source, history.objects);
  });

  it('leaves a corrupted pack untouched and consolidates the rest', async () => {
    const history = await pullHistory(4, { offsetDeltas: true });
    const packs = (await packNames(history.packDir)).filter((name) => name.endsWith('.pack'));
    const corrupted = join(history.packDir, packs[1]!);
    const bytes = await readFile(corrupted);
    bytes[20] = bytes[20]! ^ 0xff;
    await writeFile(corrupted, bytes);

    const resealed = join(history.packDir, packs[2]!.replace(/\.pack$/u, '.idx'));
    const idx = await readFile(resealed);
    const count = idx.readUInt32BE(8 + 255 * 4);
    const crcOffset = 8 + 1024 + count * 20;
    idx.writeUInt32BE((idx.readUInt32BE(crcOffset) ^ 1) >>> 0, crcOffset);
    createHash('sha1').update(idx.subarray(0, idx.length - 20)).digest().copy(idx, idx.length - 20);
    await writeFile(resealed, idx);

    const result = await consolidator(history).run();
    expect(result).toMatchObject({ status: 'consolidated', sources: 2, removed: 2 });
    expect(result.rejected!.slice().sort()).toEqual(['pack_checksum', 'pack_object_crc']);
    const names = await packNames(history.packDir);
    expect(names).toEqual(expect.arrayContaining([packs[1], packs[2]]));
    expect(names.filter((name) => name.endsWith('.idx'))).toHaveLength(3);
  });

  it('never consolidates a thin pack that depends on objects outside itself', async () => {
    const history = await pullHistory(3, { offsetDeltas: false });
    const extra = await commitRevision(history.source, 50);
    const before = new Set(await packNames(history.packDir));
    await importPack(history.gitdir, nativeGit(history.source, ['pack-objects', '--stdout', '--revs', '--thin'], `${extra}\n^${history.commits[history.commits.length - 1]}\n`));
    const thin = (await packNames(history.packDir)).filter((name) => !before.has(name));

    const result = await consolidator(history).run();
    expect(result).toMatchObject({ status: 'consolidated', sources: 3, rejected: ['pack_thin'] });
    expect(await packNames(history.packDir)).toEqual(expect.arrayContaining(thin));
  });

  it('does nothing at or below the pack-count trigger and remembers settled pack sets', async () => {
    const history = await pullHistory(3, { offsetDeltas: true });
    const before = await packNames(history.packDir);
    expect(await consolidator(history, { policy: { triggerPackCount: 3 } }).run()).toMatchObject({ status: 'skipped', reason: 'below_trigger' });
    const tiny = consolidator(history, { policy: { triggerPackCount: 2, maxPackBytes: 64 } });
    expect(await tiny.run()).toMatchObject({ status: 'skipped', reason: 'no_candidates' });
    expect(await tiny.run()).toMatchObject({ status: 'skipped', reason: 'settled' });
    expect(await packNames(history.packDir)).toEqual(before);
  });

  it('rolls back an unpublished consolidation after a crash', async () => {
    const history = await pullHistory(3, { offsetDeltas: true });
    const before = await packNames(history.packDir);
    const crashing = {
      ...nodeFs.promises,
      async rename(from: PathLike, to: PathLike) {
        if (String(to).endsWith('.idx')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
        return nodeFs.promises.rename(from, to);
      },
      async unlink(filePath: PathLike) {
        if (String(filePath).includes('.idx.tmp-')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
        return nodeFs.promises.unlink(filePath);
      }
    } satisfies Partial<Fsp>;
    await expect(consolidator(history, { fsp: crashing }).run()).rejects.toThrow('simulated crash');
    expect((await packNames(history.packDir)).some((name) => name.startsWith('obts-pack-'))).toBe(true);
    await stat(history.journalPath);

    await consolidator(history, { policy: { triggerPackCount: 100 } }).recover();
    expect(await packNames(history.packDir)).toEqual(before);
    await expect(stat(history.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectAllObjectsReadable(history.gitdir, history.source, history.objects);
  });

  it('finishes removing superseded packs after a crash during cleanup', async () => {
    const history = await pullHistory(4, { offsetDeltas: true });
    let unlinks = 0;
    const crashing = {
      ...nodeFs.promises,
      async unlink(filePath: PathLike) {
        if (basename(String(filePath)).startsWith('obts-pull-') && String(filePath).endsWith('.pack') && ++unlinks === 2) {
          throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
        }
        return nodeFs.promises.unlink(filePath);
      }
    } satisfies Partial<Fsp>;
    await expect(consolidator(history, { fsp: crashing }).run()).rejects.toThrow('simulated crash');
    expect((await packNames(history.packDir)).length).toBeGreaterThan(2);

    await consolidator(history, { policy: { triggerPackCount: 100 } }).recover();
    const names = await packNames(history.packDir);
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.startsWith('obts-pack-'))).toBe(true);
    await expectAllObjectsReadable(history.gitdir, history.source, history.objects);
  });

  it('keeps a journaled source whose objects are missing from the published pack', async () => {
    const history = await pullHistory(3, { offsetDeltas: true });
    const packs = (await packNames(history.packDir)).filter((name) => name.endsWith('.pack')).map((name) => name.slice(0, -5));
    const result = await consolidator(history).run();
    expect(result.status).toBe('consolidated');
    const [published] = (await packNames(history.packDir)).filter((name) => name.endsWith('.idx'));
    const extra = await commitRevision(history.source, 99);
    await importPack(history.gitdir, nativeGit(history.source, ['pack-objects', '--stdout', '--revs'], `${extra}\n^${history.commits[history.commits.length - 1]}\n`));
    const [unrelated] = (await packNames(history.packDir)).filter((name) => name.startsWith('obts-pull-') && name.endsWith('.idx'));
    await writeFile(history.journalPath, JSON.stringify({ version: 1, pack: published!.slice(0, -4), sources: [unrelated!.slice(0, -4), packs[0]] }));

    await consolidator(history).recover();
    expect(await packNames(history.packDir)).toContain(unrelated);
  });

  it('removes orphaned consolidation outputs', async () => {
    const history = await pullHistory(2, { offsetDeltas: true });
    const before = await packNames(history.packDir);
    await writeFile(join(history.packDir, `obts-pack-${'a'.repeat(40)}.pack`), 'partial');
    await writeFile(join(history.packDir, `obts-pack-${'a'.repeat(40)}.idx.tmp-1-2`), 'partial');
    await writeFile(history.journalPath, '{"version":');
    await writeFile(`${history.journalPath}.tmp-1-2`, '{"version":');
    await writeFile(join(history.gitdir, 'unrelated.tmp-1-2'), 'kept');
    await consolidator(history).recover();
    expect(await packNames(history.packDir)).toEqual(before);
    await expect(stat(history.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${history.journalPath}.tmp-1-2`)).rejects.toMatchObject({ code: 'ENOENT' });
    await stat(join(history.gitdir, 'unrelated.tmp-1-2'));
  });

  it('refuses to roll back an unverifiable published pack once sources are gone', async () => {
    const history = await pullHistory(3, { offsetDeltas: true });
    const sources = (await packNames(history.packDir)).filter((name) => name.endsWith('.idx')).map((name) => name.slice(0, -4));
    expect((await consolidator(history).run()).status).toBe('consolidated');
    const [published] = (await packNames(history.packDir)).filter((name) => name.endsWith('.pack'));
    const bytes = await readFile(join(history.packDir, published!));
    bytes[bytes.length - 30] = bytes[bytes.length - 30]! ^ 0xff;
    await writeFile(join(history.packDir, published!), bytes);
    await writeFile(history.journalPath, JSON.stringify({ version: 1, pack: published!.slice(0, -5), sources }));

    await expect(consolidator(history).recover()).rejects.toMatchObject({ code: 'recovery_blocked' });
    expect(await packNames(history.packDir)).toContain(published);
    await stat(history.journalPath);
  });

  it('retries a cached reader that listed source packs before they were removed', async () => {
    const history = await pullHistory(4, { offsetDeltas: false });
    const oid = history.objects[0]!;
    const type = nativeGit(history.source, ['cat-file', '-t', oid]).toString().trim();
    const expected = nativeGit(history.source, ['cat-file', type, oid]);
    let pause: { listed: () => void; release: Promise<void> } | null = null;
    const readerFs = {
      promises: {
        ...nodeFs.promises,
        async readdir(dirPath: string) {
          const names = await nodeFs.promises.readdir(dirPath);
          const paused = dirPath.endsWith(join('objects', 'pack')) ? pause : null;
          pause = null;
          if (paused) {
            paused.listed();
            await paused.release;
          }
          return names;
        }
      }
    };
    const objectCache = createGitObjectCache({ maxRetainedPackBytes: 0 });
    const cachedGit = withGitObjectCaches(git, (candidate) => (candidate === readerFs ? objectCache : null));
    let release = () => undefined as void;
    const listed = new Promise<void>((resolve) => {
      pause = { listed: resolve, release: new Promise<void>((done) => { release = done; }) };
    });

    const read = cachedGit.readObject({ fs: readerFs, dir: history.gitdir, gitdir: history.gitdir, oid, format: 'content' });
    await listed;
    const result = await consolidator(history, { beginPackChange: () => objectCache.beginPackChange() }).run();
    expect(result).toMatchObject({ status: 'consolidated', sources: 4, removed: 4 });
    release();
    const { object } = await read;
    expect(Buffer.from(object as Uint8Array).equals(expected)).toBe(true);
  });

  it('serializes overlapping runs', async () => {
    const history = await pullHistory(4, { offsetDeltas: false });
    const shared = consolidator(history);
    const [first, second] = await Promise.all([shared.run(), shared.run()]);
    expect(first).toMatchObject({ status: 'consolidated', sources: 4 });
    expect(second).toMatchObject({ status: 'skipped', reason: 'below_trigger' });
    await expectAllObjectsReadable(history.gitdir, history.source, history.objects);
  });

  it('rewrites offset deltas as reference deltas when deduplicating overlapping packs', async () => {
    const paths = await workspace();
    const commits: string[] = [];
    for (let revision = 0; revision < 3; revision += 1) commits.push(await commitRevision(paths.source, revision));
    const offset = ['pack-objects', '--stdout', '--revs', '--delta-base-offset'];
    await importPack(paths.gitdir, nativeGit(paths.source, offset, `${commits[0]}\n`));
    await importPack(paths.gitdir, nativeGit(paths.source, offset, `${commits[2]}\n`));
    const objects = nativeGit(paths.source, ['rev-list', '--objects', '--all']).toString().trim().split('\n').map((line) => line.split(' ')[0]!);
    expect(await consolidator(paths, { policy: { triggerPackCount: 1 } }).run()).toMatchObject({ status: 'consolidated', sources: 2 });
    const [idxName] = await packNames(paths.packDir);
    const verified = nativeGit(paths.gitdir, ['verify-pack', '-v', join(paths.packDir, idxName!)]).toString();
    expect(verified).toMatch(/: ok\s*$/u);
    expect(verified).toMatch(/chain length = [1-9]/u);
    await expectAllObjectsReadable(paths.gitdir, paths.source, objects);
  });
});

describe('geometric source selection', () => {
  const policy = { triggerPackCount: 0, maxPackBytes: 1000, maxSources: 100, factor: 2 };
  const packs = (...sizes: number[]) => sizes.map((size, index) => ({ name: `p${index}`, size }));
  const select = (...sizes: number[]) => consolidation.selectConsolidationSources(packs(...sizes), policy).map((pack) => pack.size);

  it('rolls up small packs that break the geometric progression', () => {
    expect(select(1, 3, 3, 4, 10, 50)).toEqual([1, 3, 3, 4, 10]);
    expect(select(1, 3, 3, 4, 10, 40)).toEqual([1, 3, 3, 4, 10, 40]);
    expect(select(5, 6, 7, 400)).toEqual([5, 6, 7]);
  });

  it('leaves an existing geometric progression alone', () => {
    expect(select(1, 2, 4, 8, 16)).toEqual([]);
    expect(select(10, 400)).toEqual([]);
  });

  it('respects the byte and source caps and skips oversized packs', () => {
    expect(select(300, 300, 300, 300)).toEqual([300, 300, 300]);
    expect(select(2000, 3000)).toEqual([]);
    expect(consolidation.selectConsolidationSources(packs(1, 1, 1, 1), { ...policy, maxSources: 2 }).map((pack) => pack.size)).toEqual([1, 1]);
  });
});

describe('crc32', () => {
  it('matches the reference check value', () => {
    expect(consolidation.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

