import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createObtsServer } from '../src/server/app.js';
import { MetadataStore } from '../src/server/metadataStore.js';

describe('Phase 3 deployable history state', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('upgrades Phase 2 metadata in place and initializes rebuildable history indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-upgrade-'));
    roots.push(root);
    const metadataDir = join(root, 'metadata');
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      join(metadataDir, 'phase1.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          setup_complete: false,
          users: [],
          sessions: [],
          vaults: [],
          devices: [],
          tokens: [],
          login_attempts: [],
          sync_operations: [],
          conflicts: [],
          events: [],
          audit_log: [],
          event_seq_by_vault: {},
          merge_sequence_by_vault: {},
          directory_state_by_vault: {}
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    const store = new MetadataStore(root);
    await store.initialize();
    const upgraded = await store.snapshot();
    expect(upgraded.schema_version).toBe(2);
    expect(upgraded.derived_history_by_vault).toEqual({});

    expect(JSON.parse(await readFile(join(metadataDir, 'phase1.json'), 'utf8'))).toMatchObject({
      schema_version: 2,
      derived_history_by_vault: {}
    });

    const reloaded = new MetadataStore(root);
    await reloaded.initialize();
    expect(await reloaded.snapshot()).toMatchObject({
      schema_version: 2,
      derived_history_by_vault: {}
    });
  });

  it('fails readiness when restored Git state has no matching metadata database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-orphan-git-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: root });
    await server.git.initializeVault('vlt_orphan_restore');
    await server.app.close();
    await rm(join(root, 'metadata', 'phase1.json'));

    const restored = await createObtsServer({ dataDir: root });
    const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: 'not_ready',
      checks: { persistent_state: false }
    });
    await restored.app.close();
  });

  it('blocks a restored vault whose Git repository permissions are unsafe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-permissions-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: root });
    const vaultId = 'vlt_permission_restore';
    const currentMain = await server.git.initializeVault(vaultId);
    await server.store.mutate((db) => {
      const timestamp = new Date().toISOString();
      db.vaults.push({
        vault_id: vaultId,
        owner_user_id: 'usr_owner',
        display_name: 'Restored vault',
        status: 'active',
        current_main: currentMain,
        created_at: timestamp,
        updated_at: timestamp
      });
    });
    await server.app.close();
    await chmod(join(root, 'git', `${vaultId}.git`), 0o500);

    const restored = await createObtsServer({ dataDir: root });
    try {
      expect((await restored.store.snapshot()).vaults[0]?.status).toBe('blocked_integrity');
      const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        status: 'not_ready',
        checks: { persistent_state: false }
      });
    } finally {
      await chmod(join(root, 'git', `${vaultId}.git`), 0o700);
      await restored.app.close();
    }
  });

  it('restores metadata, refs, conflicts, events, and derived note history as one consistent state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-consistent-restore-'));
    roots.push(root);
    const sourceDir = join(root, 'source');
    const restoredDir = join(root, 'restored');
    const source = await createObtsServer({ dataDir: sourceDir });
    const vaultId = 'vlt_consistent_restore';
    const conflictId = 'conf_consistent_restore';
    const rootCommit = await source.git.initializeVault(vaultId);
    const tree = await source.git.createTreeFromCommitWithChanges({
      vaultId,
      sourceCommit: rootCommit,
      writes: new Map([['note.md', Buffer.from('backup version\n', 'utf8')]])
    });
    const main = await source.git.createMainCommitFromTree({
      vaultId,
      tree,
      parentMain: rootCommit,
      subject: 'obts: restored backup fixture',
      body: '',
      actor: 'obts-test'
    });
    await source.git.updateRef(vaultId, 'refs/heads/main', main, rootCommit);
    await source.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/base`, rootCommit);
    await source.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/current`, main);
    await source.git.ensureRef(vaultId, `refs/obts/conflicts/${conflictId}/device`, rootCommit);
    const timestamp = new Date().toISOString();
    await source.store.mutate((db) => {
      db.vaults.push({
        vault_id: vaultId,
        owner_user_id: 'usr_owner',
        display_name: 'Backed up vault',
        status: 'active',
        current_main: main,
        created_at: timestamp,
        updated_at: timestamp
      });
      db.conflicts.push({
        conflict_id: conflictId,
        vault_id: vaultId,
        device_id: 'dev_backup',
        status: 'open',
        base_commit: rootCommit,
        current_main: main,
        device_commit: rootCommit,
        expected_main: main,
        affected_paths: ['note.md'],
        affected_path_count: 1,
        merge_sequence: 1,
        merge_policy_version: 'phase2.semantic-merge.v1',
        validator_results: { reason: 'backup_fixture' },
        validator_summary: { reason: 'backup_fixture' },
        created_at: timestamp
      });
      const event = source.store.appendEvent(db, {
        event_type: 'conflict_created',
        vault_id: vaultId,
        resource_ids: { conflict_id: conflictId },
        commit_cursors: { main, base: rootCommit, device_commit: rootCommit },
        payload: { reason: 'backup_fixture' }
      });
      db.derived_history_by_vault[vaultId] = [
        {
          path: 'note.md',
          current_main: main,
          indexed_at: timestamp,
          versions: [
            {
              commit: main,
              parent_commit: rootCommit,
              tree,
              path: 'note.md',
              operation_type: 'create',
              timestamp,
              author_name: 'obts-test',
              author_email: 'obts@localhost',
              subject: 'obts: restored backup fixture'
            }
          ]
        }
      ];
      expect(event.event_seq).toBe(1);
    });
    await source.app.close();

    await cp(sourceDir, restoredDir, { recursive: true, preserveTimestamps: true });
    const restored = await createObtsServer({ dataDir: restoredDir });
    try {
      const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
      expect(readiness.statusCode).toBe(200);
      const db = await restored.store.snapshot();
      expect(db.vaults[0]).toMatchObject({ vault_id: vaultId, current_main: main, status: 'active' });
      expect(db.conflicts[0]).toMatchObject({ conflict_id: conflictId, status: 'open', device_commit: rootCommit });
      expect(db.events[0]).toMatchObject({ event_seq: 1, event_type: 'conflict_created' });
      expect(db.derived_history_by_vault[vaultId]?.[0]?.versions[0]).toMatchObject({ commit: main, path: 'note.md' });
      expect(await restored.git.getRef(vaultId, 'refs/heads/main')).toBe(main);
      expect(await restored.git.getRef(vaultId, `refs/obts/conflicts/${conflictId}/device`)).toBe(rootCommit);
    } finally {
      await restored.app.close();
    }
  });
});
