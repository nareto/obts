import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { directorySnapshotAtEvent, MetadataStore, type MetadataDb } from '../src/server/metadataStore.js';

const VAULT = 'vlt_checkpoint';
const EXPIRED = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

type Intent = { op: 'create' | 'delete'; path: string };

async function freshStore(): Promise<MetadataStore> {
  const root = await mkdtemp(join(tmpdir(), 'obts-directory-checkpoint-'));
  roots.push(root);
  const store = new MetadataStore(root);
  await store.initialize();
  return store;
}

function append(store: MetadataStore, db: MetadataDb, intents: Intent[] = []): number {
  return store.appendEvent(db, {
    event_type: 'main_advanced',
    vault_id: VAULT,
    resource_ids: {},
    commit_cursors: { main: `main-${(db.event_seq_by_vault[VAULT] ?? 0) + 1}` },
    payload: { directory_intents: intents }
  }).event_seq;
}

async function appendAll(store: MetadataStore, events: Intent[][]): Promise<void> {
  await store.mutate((db) => {
    for (const intents of events) append(store, db, intents);
  });
}

async function expireThrough(store: MetadataStore, eventSeq: number): Promise<void> {
  await store.mutate((db) => {
    for (const event of db.events) {
      if (event.vault_id === VAULT && event.event_seq <= eventSeq) event.created_at = EXPIRED;
    }
  });
}

function vaultEventSeqs(db: MetadataDb): number[] {
  return db.events.filter((event) => event.vault_id === VAULT).map((event) => event.event_seq);
}

describe('directory retention checkpoint', () => {
  it('folds pruned directory intents so older retained mains stay reconstructable', async () => {
    const store = await freshStore();
    await appendAll(store, [
      [{ op: 'create', path: 'Projects/Archive/Empty' }],
      [{ op: 'create', path: 'Inbox' }],
      [{ op: 'delete', path: 'Projects/Archive' }],
      [],
      [{ op: 'create', path: 'Later' }]
    ]);
    await expireThrough(store, 3);
    await appendAll(store, [[]]);

    const db = await store.snapshot();
    expect(vaultEventSeqs(db)).toEqual([4, 5, 6]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['Inbox', 'Projects'], event_seq: 3 });
    expect(directorySnapshotAtEvent(db, VAULT, 3)).toEqual(['Inbox', 'Projects']);
    expect(directorySnapshotAtEvent(db, VAULT, 4)).toEqual(['Inbox', 'Projects']);
    expect(directorySnapshotAtEvent(db, VAULT, 5)).toEqual(['Inbox', 'Later', 'Projects']);
    expect(directorySnapshotAtEvent(db, VAULT, 2)).toBeNull();
  });

  it('keeps folding across later prunes and never moves the checkpoint backward', async () => {
    const store = await freshStore();
    await appendAll(store, [[{ op: 'create', path: 'A' }], [{ op: 'create', path: 'B' }], [{ op: 'delete', path: 'A' }], []]);
    await expireThrough(store, 1);
    await appendAll(store, [[]]);
    expect((await store.snapshot()).directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['A'], event_seq: 1 });

    await expireThrough(store, 3);
    await appendAll(store, [[]]);
    const db = await store.snapshot();
    expect(vaultEventSeqs(db)).toEqual([4, 5, 6]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['B'], event_seq: 3 });
    expect(directorySnapshotAtEvent(db, VAULT, 5)).toEqual(['B']);
  });

  it('prunes only a contiguous prefix when retention timestamps are out of order', async () => {
    const store = await freshStore();
    await appendAll(store, [[{ op: 'create', path: 'A' }], [{ op: 'create', path: 'B' }], [{ op: 'create', path: 'C' }]]);
    await store.mutate((db) => {
      for (const event of db.events) if (event.event_seq === 1 || event.event_seq === 3) event.created_at = EXPIRED;
    });
    await appendAll(store, [[]]);

    const db = await store.snapshot();
    expect(vaultEventSeqs(db)).toEqual([2, 3, 4]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['A'], event_seq: 1 });
    expect(directorySnapshotAtEvent(db, VAULT, 4)).toEqual(['A', 'B', 'C']);
  });

  it('withdraws the checkpoint and fails closed when pruned history is not contiguous with it', async () => {
    const store = await freshStore();
    await appendAll(store, [[{ op: 'create', path: 'A' }], [], [], []]);
    await store.mutate((db) => {
      db.events = db.events.filter((event) => event.vault_id !== VAULT || event.event_seq !== 1);
      db.directory_checkpoint_by_vault = { [VAULT]: { explicit_dirs: [], event_seq: 0 } };
    });
    await expireThrough(store, 3);
    await appendAll(store, [[]]);

    const db = await store.snapshot();
    expect(vaultEventSeqs(db)).toEqual([4, 5]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toBeUndefined();
    expect(directorySnapshotAtEvent(db, VAULT, 4)).toBeNull();
  });

  it('fails closed when a retained event after the checkpoint is missing', async () => {
    const store = await freshStore();
    await appendAll(store, [[{ op: 'create', path: 'A' }], [], [], []]);
    await expireThrough(store, 1);
    await appendAll(store, [[]]);
    await store.mutate((db) => {
      db.events = db.events.filter((event) => event.vault_id !== VAULT || event.event_seq !== 3);
    });

    const db = await store.snapshot();
    expect(directorySnapshotAtEvent(db, VAULT, 2)).toEqual(['A']);
    expect(directorySnapshotAtEvent(db, VAULT, 4)).toBeNull();
  });

  it('seeds a legacy pruned store from the live state after its last directory change', async () => {
    const now = new Date().toISOString();
    const event = (eventSeq: number, intents: Intent[]) => ({
      event_id: `evt_${eventSeq}`, event_seq: eventSeq, created_at: now, event_type: 'main_advanced', vault_id: VAULT,
      resource_ids: {}, commit_cursors: { main: `main-${eventSeq}` }, payload: { directory_intents: intents }
    });
    const legacy = (directoryEventSeq: number) => ({
      schema_version: 8,
      setup_complete: false,
      users: [], sessions: [], devices: [], connections: [], tokens: [], login_attempts: [], sync_operations: [],
      conflicts: [], audit_log: [], diagnostic_events: [], deletion_jobs: [], deletion_receipts: [],
      vaults: [{
        vault_id: VAULT, owner_user_id: 'usr_checkpoint', display_name: 'Checkpoint', status: 'active',
        root_commit: 'root', current_main: 'main-6', created_at: now, updated_at: now
      }],
      events: [4, 5, 6].map((eventSeq) => event(eventSeq, eventSeq === directoryEventSeq ? [{ op: 'create', path: 'Late' }] : [])),
      event_seq_by_vault: { [VAULT]: 6 },
      merge_sequence_by_vault: {},
      directory_state_by_vault: {
        [VAULT]: { explicit_dirs: directoryEventSeq ? ['Early', 'Late'] : ['Early'], updated_at: now, last_event_seq: directoryEventSeq || 2 }
      },
      derived_history_by_vault: {}
    });

    const legacyStore = async (directoryEventSeq: number) => {
      const root = await mkdtemp(join(tmpdir(), 'obts-directory-checkpoint-seed-'));
      roots.push(root);
      await mkdir(join(root, 'metadata'), { recursive: true });
      await writeFile(join(root, 'metadata', 'phase1.json'), `${JSON.stringify(legacy(directoryEventSeq), null, 2)}\n`, { mode: 0o600 });
      const store = new MetadataStore(root);
      await store.initialize();
      return { root, store };
    };

    const { store: neutral } = await legacyStore(0);
    const neutralDb = await neutral.snapshot();
    expect(neutralDb.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['Early'], event_seq: 3 });
    expect(directorySnapshotAtEvent(neutralDb, VAULT, 4)).toEqual(['Early']);

    const { root, store: changed } = await legacyStore(5);
    const changedDb = await changed.snapshot();
    expect(changedDb.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: ['Early', 'Late'], event_seq: 5 });
    expect(directorySnapshotAtEvent(changedDb, VAULT, 4)).toBeNull();
    expect(directorySnapshotAtEvent(changedDb, VAULT, 6)).toEqual(['Early', 'Late']);

    const reloaded = new MetadataStore(root);
    await reloaded.initialize();
    expect((await reloaded.snapshot()).directory_checkpoint_by_vault).toEqual(changedDb.directory_checkpoint_by_vault);
  });

  it('does not seed a checkpoint while the first event is still retained', async () => {
    const store = await freshStore();
    await appendAll(store, [[{ op: 'create', path: 'A' }], []]);
    expect((await store.snapshot()).directory_checkpoint_by_vault?.[VAULT]).toBeUndefined();
    expect(directorySnapshotAtEvent(await store.snapshot(), VAULT, 1)).toEqual(['A']);
  });
});
