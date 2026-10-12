import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MetadataStore, isDeviceRevoked, type MetadataCommit, type MetadataDb } from '../src/server/metadataStore.js';
import { deviceRow } from './helpers/dashboardStoreFixture.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const REVOKED_AT = '2026-01-01T00:00:00.000Z';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-revocation-invariant-'));
  roots.push(root);
  const store = new MetadataStore(root);
  await store.initialize();
  const timestamp = new Date().toISOString();
  await store.mutate((db) => {
    db.devices.push(
      { ...deviceRow('dev_revoked', 'vlt_a', 'usr_a', timestamp), revoked_at: REVOKED_AT, status: 'revoked' },
      deviceRow('dev_live', 'vlt_a', 'usr_a', timestamp)
    );
  });
  return { root, store, path: join(root, 'metadata', 'phase1.json') };
}

const status = (db: Pick<MetadataDb, 'devices'>, id: string) => db.devices.find((row) => row.device_id === id)!;

async function persisted(path: string): Promise<MetadataDb> {
  return JSON.parse(await readFile(path, 'utf8')) as MetadataDb;
}

describe('revocation is sticky at the metadata commit boundary', () => {
  it('classifies a device as revoked exactly when revoked_at is set', () => {
    expect(isDeviceRevoked({ revoked_at: REVOKED_AT })).toBe(true);
    expect(isDeviceRevoked({ revoked_at: null })).toBe(false);
  });

  it.each(['ahead', 'synced', 'paired', 'review_needed'] as const)('mutate restores status revoked after a stale sync wrote %s, in memory, on disk and for listeners', async (written) => {
    const f = await fixture();
    const commits: MetadataCommit[] = [];
    f.store.subscribeCommits((commit) => commits.push(commit));
    await f.store.mutate((db) => {
      status(db, 'dev_revoked').status = written;
      status(db, 'dev_live').status = 'ahead';
    });
    for (const db of [await f.store.snapshot(), await persisted(f.path)]) {
      expect(status(db, 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
      expect(status(db, 'dev_live')).toMatchObject({ status: 'ahead', revoked_at: null });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(commits).toHaveLength(1);
    expect(status(commits[0]!.current as MetadataDb, 'dev_revoked').status).toBe('revoked');
  });

  it('mutateDurably normalizes before persistence and publication', async () => {
    const f = await fixture();
    const commits: MetadataCommit[] = [];
    f.store.subscribeCommits((commit) => commits.push(commit));
    await f.store.mutateDurably((db) => { status(db, 'dev_revoked').status = 'synced'; });
    expect(status(await f.store.snapshot(), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    expect(status(await persisted(f.path), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    await new Promise((resolve) => setImmediate(resolve));
    expect(status(commits[0]!.current as MetadataDb, 'dev_revoked').status).toBe('revoked');
  });

  it('readOrMutate normalizes the candidate and the returned selection', async () => {
    const f = await fixture();
    const selected = await f.store.readOrMutate(
      (db) => db.devices.find((row) => row.device_id === 'dev_revoked')!,
      () => true,
      (db) => {
        const device = status(db, 'dev_revoked');
        device.status = 'paired';
        return device;
      }
    );
    expect(selected).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    expect(status(await f.store.snapshot(), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    expect(status(await persisted(f.path), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
  });

  it('does not touch devices without revoked_at and does not write when readOrMutate declines', async () => {
    const f = await fixture();
    await f.store.mutate((db) => { status(db, 'dev_live').status = 'review_needed'; });
    expect(status(await f.store.snapshot(), 'dev_live').status).toBe('review_needed');
    const before = await readFile(f.path, 'utf8');
    await f.store.readOrMutate((db) => db.devices.length, () => false, () => 0);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('repairs rows that are already inconsistent when the database is loaded, and persists the repair', async () => {
    const f = await fixture();
    const bad = await persisted(f.path);
    status(bad, 'dev_revoked').status = 'ahead';
    await writeFile(f.path, `${JSON.stringify(bad)}\n`);

    const reloaded = new MetadataStore(f.root);
    await reloaded.initialize();
    expect(status(await reloaded.snapshot(), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    expect(status(await persisted(f.path), 'dev_revoked')).toMatchObject({ status: 'revoked', revoked_at: REVOKED_AT });
    expect(status(await reloaded.snapshot(), 'dev_live').status).toBe('synced');
  });
});

describe('legacy status-only revocation', () => {
  it('classifies status revoked as revoked even without a timestamp', () => {
    expect(isDeviceRevoked({ revoked_at: null, status: 'revoked' })).toBe(true);
    expect(isDeviceRevoked({ revoked_at: undefined as unknown as null, status: 'revoked' })).toBe(true);
    expect(isDeviceRevoked({ revoked_at: null, status: 'synced' })).toBe(false);
    expect(isDeviceRevoked({ revoked_at: REVOKED_AT, status: 'synced' })).toBe(true);
  });

  it('never invents a revoked_at for such a row at commit time', async () => {
    const f = await fixture();
    await f.store.mutate((db) => { status(db, 'dev_live').status = 'revoked'; });
    expect(status(await f.store.snapshot(), 'dev_live')).toMatchObject({ status: 'revoked', revoked_at: null });
    expect(status(await persisted(f.path), 'dev_live')).toMatchObject({ status: 'revoked', revoked_at: null });
  });
});
