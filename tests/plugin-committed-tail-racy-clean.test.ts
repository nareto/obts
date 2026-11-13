import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { createSyncCostFixture, resumeClient, syncUntilSettled, writeNote } from './helpers/syncCostHarness.js';

// OBTS-SYNC-TAIL-001 / OBTS-SYNC-DELTA-001: the committed tail proves a path
// unchanged from the stat the scan cache recorded. A recorded stat is a proof
// about bytes only while nothing could have been written behind it: same size,
// mtime and ctime, and an mtime strictly older than the cache record by the
// filesystem's mtime granularity. This device is a phone whose filesystem
// reports a coarse mtime tick, so the edit below rewrites a note with the same
// length and leaves the stat fields the cache knows unchanged. The path must be
// re-read and preserved as local work, never trusted.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOTE_PATH = 'folder-12/note-00012.md';

describe('committed tail scan-cache proof', () => {
  it('re-reads a same-size edit whose recorded stat is inside the mtime tick', async () => {
    const fixture = await createSyncCostFixture(40);
    cleanups.push(async () => await fixture.close());
    expect((await syncUntilSettled(fixture.reader)).at(-1)).toBe('Synced');
    // A remote change elsewhere: the tail of this apply runs over the vault.
    await writeNote(fixture.writerDir, 7, 'remote change\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');

    const target = join(fixture.readerDir, NOTE_PATH);
    const published = await readFile(target, 'utf8');
    const localEdit = published.replace('# Note 12', '# Note 99');
    expect(localEdit).toHaveLength(published.length);
    await writeFile(target, localEdit);

    // The filesystem kept the recorded stat: same size, same reported mtime and
    // ctime. The cache record is 500 ms after it, inside the tick a coarse
    // filesystem would leave unchanged, so the stat cannot prove the bytes.
    const cachePath = join(fixture.readerDir, '.obts', 'scan-cache.json');
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    const current = await stat(target);
    Object.assign(cache.entries[NOTE_PATH], {
      size: current.size,
      mtime: current.mtimeMs,
      ctime: current.birthtimeMs
    });
    cache.recorded_at_ms = Math.round(current.mtimeMs) + 500;
    await writeFile(cachePath, JSON.stringify(cache));

    const resumed: ObtsPluginClient = await resumeClient(fixture, fixture.readerDir, 'racy-reader');
    const core = (resumed as unknown as { client: Record<string, any> }).client;
    const reads: string[] = [];
    const readBinary = core.adapter.readBinary.bind(core.adapter);
    core.adapter.readBinary = async (filePath: string) => {
      reads.push(String(filePath).replace(/^\/+/u, ''));
      return await readBinary(filePath);
    };

    await resumed.pollRemoteEventsAndApply();

    // The path was classified unproven and read, not trusted.
    expect(reads).toContain(NOTE_PATH);
    expect(await readFile(target, 'utf8')).toBe(localEdit);
    // And it is not invisible work the next inventory has to rediscover: the
    // next sync publishes the local bytes as the device's own change.
    expect((await syncUntilSettled(resumed)).at(-1)).toBe('Synced');
    const localMain = (await core.readState()).local_main;
    const localOid = (await core.listTreeBlobOids(localMain)).get(NOTE_PATH);
    expect(localOid).toMatch(/^[0-9a-f]{40}$/u);
    expect(Buffer.from(await core.readBlobOid(localOid)).toString('utf8')).toBe(localEdit);
  }, 120_000);
});
