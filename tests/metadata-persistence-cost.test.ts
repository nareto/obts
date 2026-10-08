import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MetadataStore } from '../src/server/metadataStore.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-metadata-cost-'));
  roots.push(root);
  const store = new MetadataStore(root);
  await store.initialize();
  return { root, store, path: join(root, 'metadata', 'phase1.json') };
}

describe('compact metadata persistence', () => {
  it('writes compact JSON and loads both compact and existing pretty metadata unchanged', async () => {
    const f = await fixture();
    await f.store.mutate((db) => { db.setup_complete = true; });
    const db = await f.store.snapshot();
    const compact = await readFile(f.path, 'utf8');
    expect(compact).toBe(`${JSON.stringify(db)}\n`);
    expect(compact.length).toBeLessThan(JSON.stringify(db, null, 2).length);
    for (const data of [compact, `${JSON.stringify(db, null, 2)}\n`]) {
      await writeFile(f.path, data);
      const writes = vi.fn();
      const loaded = new MetadataStore(f.root, { writeFile: writes });
      await loaded.initialize();
      expect(await loaded.snapshot()).toEqual(db);
      expect(writes).not.toHaveBeenCalled();
    }
  });

  it.each(['mutate', 'mutateDurably'] as const)('keeps candidate nested state private and rolls back failed %s publication', async (method) => {
    const f = await fixture();
    const original = await f.store.snapshot();
    const failed = new MetadataStore(f.root, { fsyncFile: async () => { throw new Error('synthetic fsync failure'); } });
    await failed.initialize();
    await expect(failed[method]((db) => {
      db.setup_complete = true;
      db.event_seq_by_vault.vlt_synthetic = 7;
      db.directory_state_by_vault.vlt_synthetic = { explicit_dirs: ['synthetic'], updated_at: new Date().toISOString(), last_event_seq: 7 };
    })).rejects.toThrow('synthetic fsync failure');
    expect(await failed.snapshot()).toEqual(original);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(original);
    expect(failed.isReady()).toBe(true);
  });
});
