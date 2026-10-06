import * as nodeFs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as rawGit from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';

type CacheStats = { epoch: number; indexes: number; retainedPacks: number; cachedObjects: number; inFlight: number };
type ObjectCache = {
  run(command: unknown, args: unknown): Promise<unknown>;
  reset(): void;
  forget(filePath: string): void;
  beginPackChange(): () => void;
  stats(): CacheStats;
};

const require = createRequire(import.meta.url);
const { createGitObjectCache, withGitObjectCaches } = require('../obsidian-plugin/src/git-object-cache.cjs') as {
  createGitObjectCache(options: { maxRetainedPackBytes: number; maxBusyPackBytes?: number }): ObjectCache;
  withGitObjectCaches(git: typeof rawGit, lookup: (fs: unknown) => unknown): typeof rawGit;
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function countingFs() {
  const reads: string[] = [];
  const fs = {
    promises: {
      ...nodeFs.promises,
      async readFile(filePath: string, options?: unknown) {
        if (typeof filePath === 'string') reads.push(filePath);
        return nodeFs.promises.readFile(filePath, options as never);
      }
    }
  };
  return { fs, reads };
}

async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'obts-git-object-cache-'));
  roots.push(dir);
  await rawGit.init({ fs: nodeFs, dir });
  return dir;
}

async function addPack(dir: string, name: string, contents: string[]) {
  const oids: string[] = [];
  for (const content of contents) oids.push(await rawGit.writeBlob({ fs: nodeFs, dir, blob: Buffer.from(content) }));
  const { packfile } = await rawGit.packObjects({ fs: nodeFs, dir, oids });
  const packPath = join(dir, '.git', 'objects', 'pack', `${name}.pack`);
  await writeFile(packPath, packfile!);
  await rawGit.indexPack({ fs: nodeFs, dir, filepath: packPath.slice(dir.length + 1) });
  for (const oid of oids) await unlink(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  return { oids, packPath };
}

async function repositoryWithPacks(packCount: number) {
  const dir = await repository();
  const oids: string[] = [];
  for (let index = 0; index < packCount; index += 1) {
    const pack = await addPack(dir, `pack-test-${String(index).padStart(3, '0')}`, [`object ${index}\n${'x'.repeat(index * 10)}`]);
    oids.push(...pack.oids);
  }
  return { dir, oids };
}

function cachedGit(fs: unknown, options: { maxRetainedPackBytes: number; maxBusyPackBytes?: number }) {
  const objectCache = createGitObjectCache(options);
  const git = withGitObjectCaches(rawGit, (candidate) => (candidate === fs ? objectCache : null));
  return { git, objectCache };
}

const text = (blob: Uint8Array) => Buffer.from(blob).toString('utf8');

describe('shared git object cache', () => {
  it('loads every pack index once across commands', async () => {
    const { dir, oids } = await repositoryWithPacks(12);
    const { fs, reads } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });

    for (let round = 0; round < 3; round += 1) {
      for (const oid of oids) expect(text((await git.readBlob({ fs, dir, oid })).blob)).toMatch(/^object \d+/u);
    }
    const idxReads = reads.filter((filePath) => filePath.endsWith('.idx'));
    expect(idxReads).toHaveLength(oids.length);
    expect(new Set(idxReads).size).toBe(oids.length);
    expect(objectCache.stats()).toEqual({ epoch: 0, indexes: oids.length, retainedPacks: 0, cachedObjects: 0, inFlight: 0 });
  });

  it('retains pack buffers only within the byte budget', async () => {
    const { dir, oids } = await repositoryWithPacks(6);
    const { fs, reads } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 1024 * 1024 });
    for (const oid of oids) await git.readBlob({ fs, dir, oid });
    for (const oid of oids) await git.readBlob({ fs, dir, oid });
    expect(reads.filter((filePath) => filePath.endsWith('.pack'))).toHaveLength(oids.length);
    expect(objectCache.stats().retainedPacks).toBe(oids.length);
  });

  it('drops decompressed objects after each command', async () => {
    const dir = await repository();
    const contents = Array.from({ length: 20 }, (_, index) => `note ${index}\n`);
    const { oids } = await addPack(dir, 'pack-many', contents);
    const { fs } = countingFs();
    const { objectCache } = cachedGit(fs, { maxRetainedPackBytes: 1024 * 1024 });
    type PackIndex = { readDepth?: number; offsetCache: Record<number, unknown> };
    let index: PackIndex | null = null;
    let largestDuringCommand = 0;
    const readBlob = async (args: Parameters<typeof rawGit.readBlob>[0]) => {
      const result = await rawGit.readBlob(args);
      if (!index) {
        const cache = args.cache as Record<symbol, unknown>;
        const packMap = Object.getOwnPropertySymbols(cache).map((symbol) => cache[symbol]).find((value) => value instanceof Map) as Map<string, Promise<PackIndex>>;
        index = await packMap.values().next().value!;
        // isomorphic-git 1.38 leaves readDepth unset for idx-loaded packs, which disables this cache.
        index.readDepth = 0;
      }
      largestDuringCommand = Math.max(largestDuringCommand, Object.keys(index.offsetCache).length);
      return result;
    };
    for (let round = 0; round < 2; round += 1) {
      for (const [position, oid] of oids.entries()) {
        const { blob } = await objectCache.run(readBlob, { fs, dir, oid }) as { blob: Uint8Array };
        expect(text(blob)).toBe(contents[position]);
        expect(objectCache.stats().cachedObjects).toBe(0);
      }
    }
    expect(largestDuringCommand).toBeGreaterThan(0);
  });

  it('verifies a dropped pack again when it is read back', async () => {
    const dir = await repository();
    const { oids, packPath } = await addPack(dir, 'pack-verify', ['verified content\n']);
    const { fs } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });
    await git.readBlob({ fs, dir, oid: oids[0]! });
    const bytes = await readFile(packPath);
    bytes[12] = bytes[12]! ^ 0xff;
    await writeFile(packPath, bytes);
    await expect(git.readBlob({ fs, dir, oid: oids[0]! })).rejects.toThrow(/corrupted/u);
    expect(objectCache.stats().epoch).toBe(1);
  });

  it('never drops a pack buffer while another command is reading it', async () => {
    const { dir, oids } = await repositoryWithPacks(8);
    const { fs } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });
    const reads = Array.from({ length: 200 }, (_, index) => git.readBlob({ fs, dir, oid: oids[index % oids.length]! }));
    await expect(Promise.all(reads)).resolves.toHaveLength(200);
    expect(objectCache.stats()).toMatchObject({ retainedPacks: 0, cachedObjects: 0, inFlight: 0 });
  });

  it('starts a fresh cache when concurrent commands exceed the busy ceiling', async () => {
    const { dir, oids } = await repositoryWithPacks(8);
    const { fs } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0, maxBusyPackBytes: 1 });
    const reads = Array.from({ length: 64 }, (_, index) => git.readBlob({ fs, dir, oid: oids[index % oids.length]! }));
    const blobs = await Promise.all(reads);
    blobs.forEach(({ blob }, index) => expect(text(blob)).toMatch(new RegExp(`^object ${index % oids.length}\\n`, 'u')));
    expect(objectCache.stats().epoch).toBeGreaterThan(0);
  });

  it('keeps the cache when an object is merely missing', async () => {
    const { dir, oids } = await repositoryWithPacks(2);
    const { fs } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });
    await git.readBlob({ fs, dir, oid: oids[0]! });
    await expect(git.readBlob({ fs, dir, oid: '0'.repeat(40) })).rejects.toMatchObject({ code: 'NotFoundError' });
    expect(objectCache.stats()).toMatchObject({ epoch: 0, indexes: 2 });
  });

  it('reloads indexes after reset or forget and ignores packs that disappeared', async () => {
    const { dir, oids } = await repositoryWithPacks(3);
    const { fs, reads } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });
    const idxReads = () => reads.filter((filePath) => filePath.endsWith('.idx')).length;
    for (const oid of oids) await git.readBlob({ fs, dir, oid });
    expect(idxReads()).toBe(3);

    const packDir = join(dir, '.git', 'objects', 'pack');
    const names = (await readdir(packDir)).filter((name) => name.endsWith('.idx')).sort();
    objectCache.forget(join(packDir, names[2]!.replace(/\.idx$/u, '.pack')));
    expect(objectCache.stats().indexes).toBe(2);
    await git.readBlob({ fs, dir, oid: oids[2]! });
    expect(idxReads()).toBe(4);

    objectCache.reset();
    expect(objectCache.stats().indexes).toBe(0);
    await unlink(join(packDir, names[0]!));
    await expect(git.readBlob({ fs, dir, oid: oids[0]! })).rejects.toMatchObject({ code: 'NotFoundError' });
    for (const oid of oids.slice(1)) await git.readBlob({ fs, dir, oid });
    expect(idxReads()).toBe(6);
  });

  it('leaves calls with an explicit cache or an unregistered fs untouched', async () => {
    const { dir, oids } = await repositoryWithPacks(2);
    const { fs } = countingFs();
    const { git, objectCache } = cachedGit(fs, { maxRetainedPackBytes: 0 });
    await git.readBlob({ fs: nodeFs, dir, oid: oids[0]! });
    await git.readBlob({ fs, dir, oid: oids[0]!, cache: {} });
    expect(objectCache.stats().indexes).toBe(0);
    expect(git.hashBlob).toBe(rawGit.hashBlob);
  });
});

describe('pack change window', () => {
  const vanished = () => Object.assign(new Error('pack vanished'), { code: 'InternalError' });

  it('retries a read that failed during a pack change once the change ends, with a fresh cache', async () => {
    const objectCache = createGitObjectCache({ maxRetainedPackBytes: 0 });
    const caches: unknown[] = [];
    let end = () => undefined as void;
    const result = objectCache.run(async ({ cache }: { cache: unknown }) => {
      caches.push(cache);
      if (caches.length === 1) {
        end = objectCache.beginPackChange();
        throw vanished();
      }
      return 'read';
    }, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(caches).toHaveLength(1);
    end();
    await expect(result).resolves.toBe('read');
    expect(caches).toHaveLength(2);
    expect(caches[1]).not.toBe(caches[0]);
  });

  it('retries a read that started during a change and failed after it ended', async () => {
    const objectCache = createGitObjectCache({ maxRetainedPackBytes: 0 });
    const end = objectCache.beginPackChange();
    let attempts = 0;
    const result = objectCache.run(async () => {
      attempts += 1;
      if (attempts === 1) {
        end();
        throw vanished();
      }
      return 'read';
    }, {});
    await expect(result).resolves.toBe('read');
    expect(attempts).toBe(2);
  });

  it('does not retry failures without an overlapping change, writes, or beyond the retry bound', async () => {
    const objectCache = createGitObjectCache({ maxRetainedPackBytes: 0 });
    let attempts = 0;
    await expect(objectCache.run(async () => {
      attempts += 1;
      throw vanished();
    }, {})).rejects.toThrow('pack vanished');
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(objectCache.run(async () => {
      attempts += 1;
      objectCache.beginPackChange()();
      throw vanished();
    }, { write: true })).rejects.toThrow('pack vanished');
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(objectCache.run(async () => {
      attempts += 1;
      objectCache.beginPackChange()();
      throw vanished();
    }, {})).rejects.toThrow('pack vanished');
    expect(attempts).toBe(3);
  });

  it('waits for nested changes and ignores repeated end calls', async () => {
    const objectCache = createGitObjectCache({ maxRetainedPackBytes: 0 });
    const outer = objectCache.beginPackChange();
    const inner = objectCache.beginPackChange();
    let attempts = 0;
    const result = objectCache.run(async () => {
      attempts += 1;
      if (attempts === 1) throw vanished();
      return 'read';
    }, {});
    inner();
    inner();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(attempts).toBe(1);
    outer();
    await expect(result).resolves.toBe('read');
  });
});
