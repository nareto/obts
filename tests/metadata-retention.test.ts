import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { directorySnapshotAtEvent, MetadataStore, type DeviceRow, type MetadataDb } from '../src/server/metadataStore.js';

const VAULT = 'vlt_retention';
const OTHER_VAULT = 'vlt_retention_other';
const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 1_500;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function freshStore(): Promise<{ root: string; store: MetadataStore }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-metadata-retention-'));
  roots.push(root);
  const store = new MetadataStore(root);
  await store.initialize();
  return { root, store };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function append(store: MetadataStore, db: MetadataDb, vaultId = VAULT, intents: Array<{ op: 'create' | 'delete'; path: string }> = []): number {
  return store.appendEvent(db, {
    event_type: 'main_advanced',
    vault_id: vaultId,
    resource_ids: {},
    commit_cursors: { main: `main-${(db.event_seq_by_vault[vaultId] ?? 0) + 1}` },
    payload: { directory_intents: intents }
  }).event_seq;
}

/** Appends one event per tick, each creating a distinct directory, so folding is observable. */
async function appendTicks(store: MetadataStore, count: number, vaultId = VAULT): Promise<void> {
  let remaining = count;
  while (remaining > 0) {
    const batch = Math.min(remaining, 100);
    remaining -= batch;
    await store.mutate((db) => {
      for (let index = 0; index < batch; index += 1) {
        const seq = (db.event_seq_by_vault[vaultId] ?? 0) + 1;
        append(store, db, vaultId, [{ op: 'create', path: `dir-${seq}` }]);
      }
    });
  }
}

function retainedSeqs(db: MetadataDb, vaultId = VAULT): number[] {
  return db.events.filter((event) => event.vault_id === vaultId).map((event) => event.event_seq).sort((left, right) => left - right);
}

function liveDirectories(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `dir-${index + 1}`).sort();
}

function deviceRow(vaultId: string, cursor: number, status: DeviceRow['status'] = 'synced'): DeviceRow {
  const timestamp = new Date().toISOString();
  return {
    device_id: `dev_${vaultId}_${cursor}`, vault_id: vaultId, user_id: 'usr_retention', device_name: 'Retention device',
    device_ref: `refs/obts/devices/dev_${vaultId}_${cursor}`, device_ref_head: null, status,
    last_applied_main: cursor > 0 ? `main-${cursor}` : null, last_applied_event_seq: cursor,
    last_applied_explicit_dirs: [], pending_applied_main: null, pending_applied_event_seq: 0,
    pending_applied_explicit_dirs: null, last_seen_at: timestamp, last_successful_sync_at: null,
    local_status_label: null, local_error_code: null, local_queue_status: null, local_main: null,
    local_head: null, plugin_version: null, path_capabilities: null, last_status_report_at: null,
    onboarding_status: 'complete', onboarding_mode: 'use_server', initial_proposal_kind: null,
    initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: timestamp,
    created_at: timestamp, revoked_at: status === 'revoked' ? timestamp : null
  };
}

function legacyMetadata(events: MetadataDb['events'], audit: MetadataDb['audit_log']): MetadataDb {
  const now = new Date().toISOString();
  const lastSeq = events.reduce((newest, event) => Math.max(newest, event.event_seq), 0);
  return {
    schema_version: 8,
    setup_complete: true,
    users: [],
    sessions: [],
    vaults: [{
      vault_id: VAULT, owner_user_id: 'usr_retention', display_name: 'Retention', status: 'active',
      root_commit: 'root', current_main: 'main-0', created_at: now, updated_at: now
    }],
    devices: [],
    connections: [],
    tokens: [],
    login_attempts: [],
    sync_operations: [],
    conflicts: [],
    events,
    audit_log: audit,
    diagnostic_events: [],
    event_seq_by_vault: { [VAULT]: lastSeq },
    merge_sequence_by_vault: {},
    directory_state_by_vault: { [VAULT]: { explicit_dirs: liveDirectories(lastSeq), updated_at: now, last_event_seq: lastSeq } },
    directory_proposal_results: [],
    derived_history_by_vault: {},
    deletion_jobs: [],
    deletion_receipts: [],
    device_removal_jobs: []
  };
}

function legacyEvent(seq: number, createdAt = new Date().toISOString()): MetadataDb['events'][number] {
  return {
    event_id: `evt_${String(seq).padStart(8, '0')}`, event_seq: seq, created_at: createdAt, event_type: 'main_advanced',
    vault_id: VAULT, resource_ids: {}, commit_cursors: { main: `main-${seq}` },
    payload: { directory_intents: [{ op: 'create', path: `dir-${seq}`, intent_id: `intent_${seq}` }] }
  };
}

function legacyAudit(index: number, action: string, createdAt: string): MetadataDb['audit_log'][number] {
  return {
    audit_id: `aud_${String(index).padStart(6, '0')}`, actor_user_id: 'usr_retention', actor_device_id: null,
    vault_id: VAULT, action, resource_class: 'vault', resource_id: VAULT, created_at: createdAt
  };
}

async function writeLegacyRoot(db: MetadataDb): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'obts-metadata-retention-legacy-'));
  roots.push(root);
  await mkdir(join(root, 'metadata'), { recursive: true });
  await writeFile(join(root, 'metadata', 'phase1.json'), `${JSON.stringify(db)}\n`, { mode: 0o600 });
  return root;
}

describe('metadata retention bounds', () => {
  it('caps retained events per vault and folds the pruned prefix into the directory checkpoint', async () => {
    const { store } = await freshStore();
    await appendTicks(store, EVENT_LIMIT + 40);

    const db = await store.snapshot();
    expect(retainedSeqs(db)).toHaveLength(EVENT_LIMIT);
    const oldest = retainedSeqs(db)[0]!;
    expect(oldest).toBe(EVENT_LIMIT + 40 - EVENT_LIMIT + 1);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toMatchObject({ event_seq: oldest - 1 });
    // The folded checkpoint plus the retained events still reconstruct the current directory state.
    expect(directorySnapshotAtEvent(db, VAULT, EVENT_LIMIT + 40)).toEqual(liveDirectories(EVENT_LIMIT + 40));

    await appendTicks(store, 1);
    const afterOneMore = await store.snapshot();
    expect(retainedSeqs(afterOneMore)).toHaveLength(EVENT_LIMIT);
    expect(retainedSeqs(afterOneMore)[0]).toBe(oldest + 1);
    expect(directorySnapshotAtEvent(afterOneMore, VAULT, EVENT_LIMIT + 41)).toEqual(liveDirectories(EVENT_LIMIT + 41));
  });

  it('prunes events older than the retention window on the next append', async () => {
    const { store } = await freshStore();
    await appendTicks(store, 3);
    await store.mutate((db) => {
      for (const event of db.events) event.created_at = daysAgo(8);
    });
    await appendTicks(store, 1);

    const db = await store.snapshot();
    expect(retainedSeqs(db)).toEqual([4]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: liveDirectories(3), event_seq: 3 });
    expect(directorySnapshotAtEvent(db, VAULT, 3)).toEqual(liveDirectories(3));
    expect(directorySnapshotAtEvent(db, VAULT, 2)).toBeNull();
  });

  it('keeps a two-day-old event window so a device that is two days behind catches up from events', async () => {
    const { store } = await freshStore();
    await appendTicks(store, 3);
    await store.mutate((db) => {
      // Every event is two days old, so all of them are still inside the retained window.
      for (const event of db.events) event.created_at = daysAgo(2);
      db.devices.push(deviceRow(VAULT, 1));
    });
    await appendTicks(store, 1);

    expect(retainedSeqs(await store.snapshot())).toEqual([1, 2, 3, 4]);
  });

  it('does not extend retention for a device cursor, and prunes across it', async () => {
    const { store } = await freshStore();
    await appendTicks(store, 3);
    await store.mutate((db) => {
      // A live, unrevoked device parked at the oldest cursor does not hold the window back: retention
      // is a function of the event log alone, so an expired cursor recovers through the refresh path.
      for (const event of db.events) event.created_at = daysAgo(10);
      db.devices.push(deviceRow(VAULT, 1));
    });
    await appendTicks(store, 1);

    const db = await store.snapshot();
    expect(retainedSeqs(db)).toEqual([4]);
    expect(db.directory_checkpoint_by_vault?.[VAULT]).toEqual({ explicit_dirs: liveDirectories(3), event_seq: 3 });
    expect(db.devices[0]?.last_applied_event_seq).toBe(1);
  });

  it('keeps event retention per vault', async () => {
    const { store } = await freshStore();
    await appendTicks(store, EVENT_LIMIT + 20);
    await appendTicks(store, 3, OTHER_VAULT);

    const db = await store.snapshot();
    expect(retainedSeqs(db)).toHaveLength(EVENT_LIMIT);
    expect(retainedSeqs(db, OTHER_VAULT)).toEqual([1, 2, 3]);
    expect(db.directory_checkpoint_by_vault?.[OTHER_VAULT]).toBeUndefined();
  });

  it('stays bounded by the count cap under a long synthetic run', async () => {
    const { root, store } = await freshStore();
    const ticks = EVENT_LIMIT * 2;
    let observed = 0;
    while (observed < ticks) {
      const batch = Math.min(ticks - observed, 250);
      await store.mutate((db) => {
        for (let index = 0; index < batch; index += 1) {
          const seq = (db.event_seq_by_vault[VAULT] ?? 0) + 1;
          append(store, db, VAULT, [{ op: 'create', path: `dir-${seq}` }]);
        }
      });
      observed += batch;
      const db = await store.snapshot();
      const seqs = retainedSeqs(db);
      expect(seqs.length).toBeLessThanOrEqual(EVENT_LIMIT);
      expect(seqs.at(-1)).toBe(observed);
      expect(seqs.every((seq, index) => index === 0 || seq === seqs[index - 1]! + 1)).toBe(true);
      if (seqs[0]! > 1) expect(db.directory_checkpoint_by_vault?.[VAULT]?.event_seq).toBe(seqs[0]! - 1);
      expect(directorySnapshotAtEvent(db, VAULT, observed)).toEqual(liveDirectories(observed));
    }
    const persisted = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8')) as { events: unknown[] };
    expect(persisted.events.length).toBeLessThanOrEqual(EVENT_LIMIT);
  });
});

describe('audit retention', () => {
  it('retires per-push main_advanced rows and keeps security rows for a year', async () => {
    const events = Array.from({ length: 5 }, (_, index) => legacyEvent(index + 1));
    const loginAt = daysAgo(300);
    const root = await writeLegacyRoot(legacyMetadata(events, [
      legacyAudit(1, 'main_advanced', new Date().toISOString()),
      legacyAudit(2, 'main_advanced', daysAgo(20)),
      legacyAudit(3, 'login', loginAt),
      legacyAudit(4, 'device_revoked', daysAgo(400)),
      legacyAudit(5, 'user_created', new Date().toISOString())
    ]));

    const store = new MetadataStore(root);
    await store.initialize();
    const db = await store.snapshot();
    expect(db.audit_log.map((row) => row.action)).toEqual(['login', 'user_created']);
    expect(db.audit_log[0]?.created_at).toBe(loginAt);

    // A push no longer appends a per-push audit duplicate, and an append does not disturb audit rows
    // that are inside the retention bounds.
    await store.mutate((candidate) => {
      candidate.audit_log.push(legacyAudit(6, 'login', daysAgo(1)));
      append(store, candidate);
    });
    expect((await store.snapshot()).audit_log.map((row) => row.action)).toEqual(['login', 'user_created', 'login']);
  });

  it('prunes expired audit rows during an ordinary append', async () => {
    const { store } = await freshStore();
    await store.mutate((db) => {
      db.audit_log.push(legacyAudit(1, 'login', daysAgo(400)), legacyAudit(2, 'login_failed', daysAgo(30)));
    });
    await store.mutate((db) => {
      append(store, db);
    });

    expect((await store.snapshot()).audit_log.map((row) => row.action)).toEqual(['login_failed']);
  });
});

describe('startup retention', () => {
  it('shrinks an oversized metadata file on load and does not rewrite a retained file again', async () => {
    const events = Array.from({ length: 2_000 }, (_, index) => legacyEvent(index + 1));
    const root = await writeLegacyRoot(legacyMetadata(events, [
      ...Array.from({ length: 40 }, (_, index) => legacyAudit(index, 'main_advanced', new Date().toISOString())),
      legacyAudit(41, 'device_removed', daysAgo(30)),
      legacyAudit(42, 'login', daysAgo(360))
    ]));
    const path = join(root, 'metadata', 'phase1.json');
    const before = (await stat(path)).size;

    const store = new MetadataStore(root);
    await store.initialize();
    const db = await store.snapshot();
    const after = (await stat(path)).size;

    expect(after).toBeLessThan(before);
    expect(retainedSeqs(db)).toHaveLength(EVENT_LIMIT);
    expect(retainedSeqs(db)[0]).toBe(501);
    expect(db.audit_log.map((row) => row.action)).toEqual(['device_removed', 'login']);
    expect(directorySnapshotAtEvent(db, VAULT, 2_000)).toEqual(liveDirectories(2_000));
    expect(directorySnapshotAtEvent(db, VAULT, 500)).toEqual(liveDirectories(500));
    expect(directorySnapshotAtEvent(db, VAULT, 499)).toBeNull();

    const writes: string[] = [];
    const reloaded = new MetadataStore(root, { writeFile: async (target, data) => { writes.push(target); await writeFile(target, data, { mode: 0o600 }); } });
    await reloaded.initialize();
    expect(writes).toEqual([]);
    expect(await reloaded.snapshot()).toEqual(db);
  });

  it('leaves a metadata file that is already inside the retention bounds untouched', async () => {
    const { root, store } = await freshStore();
    await store.mutate((db) => {
      db.audit_log.push(legacyAudit(1, 'login', new Date().toISOString()));
      append(store, db);
    });
    const snapshot = await store.snapshot();
    const writes: string[] = [];
    const reloaded = new MetadataStore(root, { writeFile: async (target, data) => { writes.push(target); await writeFile(target, data, { mode: 0o600 }); } });
    await reloaded.initialize();
    expect(writes).toEqual([]);
    expect(await reloaded.snapshot()).toEqual(snapshot);
  });
});
