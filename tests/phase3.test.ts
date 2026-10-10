import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.js';
import { createObtsServer, repairVaultIntegrity, type ObtsServer } from '../src/server/app.js';
import { historyCheckpointFixture, commit, directoryProposal, manifest, multipart, refInventory } from './helpers/historyCheckpointFixture.js';
import { hashToken } from '../src/server/authService.js';
import { OperationHistoryStore } from '../src/server/operationHistoryStore.js';
import { MetadataStore } from '../src/server/metadataStore.js';

describe('Phase 3 deployable history state', () => {
  const roots: string[] = [];
  const checkpointServers: ObtsServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(checkpointServers.splice(0).map(async (server) => await server.app.close()));
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
    expect(upgraded.schema_version).toBe(8);
    expect(upgraded.derived_history_by_vault).toEqual({});
    expect(upgraded.diagnostic_events).toEqual([]);
    expect(upgraded.deletion_jobs).toEqual([]);
    expect(upgraded.deletion_receipts).toEqual([]);

    expect(JSON.parse(await readFile(join(metadataDir, 'phase1.json'), 'utf8'))).toMatchObject({
      schema_version: 8,
      connections: [],
      diagnostic_events: [],
      derived_history_by_vault: {}
    });

    const reloaded = new MetadataStore(root);
    await reloaded.initialize();
    expect(await reloaded.snapshot()).toMatchObject({
      schema_version: 8,
      connections: [],
      diagnostic_events: [],
      derived_history_by_vault: {}
    });
  });

  it('migrates current directory snapshots and marks truncated behind snapshots ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-directory-snapshot-upgrade-'));
    roots.push(root);
    const metadataDir = join(root, 'metadata');
    await mkdir(metadataDir, { recursive: true });
    const device = (deviceId: string, lastAppliedMain: string) => ({
      device_id: deviceId,
      vault_id: 'vlt_snapshot',
      user_id: 'usr_snapshot',
      device_name: deviceId,
      device_ref: `refs/obts/devices/${deviceId}`,
      device_ref_head: null,
      status: 'synced',
      last_applied_main: lastAppliedMain,
      last_seen_at: null,
      last_successful_sync_at: null,
      local_status_label: null,
      local_error_code: null,
      local_queue_status: null,
      local_main: lastAppliedMain,
      local_head: lastAppliedMain,
      plugin_version: '0.4.20',
      path_capabilities: null,
      last_status_report_at: null,
      onboarding_status: 'complete',
      onboarding_mode: 'initialize',
      initial_proposal_kind: null,
      initial_proposal_base: null,
      onboarding_connection_id: null,
      onboarding_completed_at: null,
      created_at: new Date().toISOString(),
      revoked_at: null
    });
    const currentMain = 'c'.repeat(40);
    const behindMain = 'b'.repeat(40);
    await writeFile(join(metadataDir, 'phase1.json'), `${JSON.stringify({
      schema_version: 4,
      setup_complete: false,
      users: [],
      sessions: [],
      vaults: [{
        vault_id: 'vlt_snapshot', owner_user_id: 'usr_snapshot', display_name: 'Snapshot', status: 'active',
        root_commit: 'a'.repeat(40), current_main: currentMain, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }],
      devices: [device('dev_current', currentMain), device('dev_behind', behindMain)],
      connections: [], tokens: [], login_attempts: [], sync_operations: [], conflicts: [], audit_log: [], diagnostic_events: [],
      events: [{
        event_id: 'evt_current', event_seq: 10, created_at: new Date().toISOString(), event_type: 'main_advanced', vault_id: 'vlt_snapshot',
        resource_ids: {}, commit_cursors: { main: currentMain, previous_main: behindMain }, payload: { directory_intents: [{ op: 'create', path: '.trash/current' }] }
      }],
      event_seq_by_vault: { vlt_snapshot: 10 },
      merge_sequence_by_vault: {},
      directory_state_by_vault: { vlt_snapshot: { explicit_dirs: ['.trash/current'], updated_at: new Date().toISOString(), last_event_seq: 10 } },
      derived_history_by_vault: {}
    }, null, 2)}\n`);

    const store = new MetadataStore(root);
    await store.initialize();
    const migrated = await store.snapshot();
    expect(migrated.devices.find((entry) => entry.device_id === 'dev_current')).toMatchObject({
      last_applied_event_seq: 10,
      last_applied_explicit_dirs: ['.trash/current']
    });
    expect(migrated.devices.find((entry) => entry.device_id === 'dev_behind')).toMatchObject({
      last_applied_event_seq: 0,
      last_applied_explicit_dirs: null
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
    await chmod(join(root, 'git', `${vaultId}.git`), 0o770);

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

  it('keeps an integrity block until the local operator repair command validates repaired state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-operator-repair-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: root });
    const vaultId = 'vlt_operator_repair';
    const currentMain = await server.git.initializeVault(vaultId);
    await server.store.mutate((db) => {
      const timestamp = new Date().toISOString();
      db.vaults.push({
        vault_id: vaultId,
        owner_user_id: 'usr_owner',
        display_name: 'Operator repair',
        status: 'active',
        current_main: currentMain,
        created_at: timestamp,
        updated_at: timestamp
      });
    });
    await server.app.close();

    const repository = join(root, 'git', `${vaultId}.git`);
    await chmod(repository, 0o770);
    const blocked = await createObtsServer({ dataDir: root });
    expect((await blocked.store.snapshot()).vaults[0]?.status).toBe('blocked_integrity');
    await blocked.app.close();

    const invokeRepair = async () => {
      let stdout = '';
      let stderr = '';
      const code = await runCli(
        ['integrity', 'repair', '--vault-id', vaultId, '--json'],
        { OBTS_DATA_DIR: root },
        {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          }
        }
      );
      return { code, stdout, stderr };
    };

    const unsafeRepair = await invokeRepair();
    expect(unsafeRepair.code).toBe(1);
    expect(unsafeRepair.stderr).toContain('Vault integrity remains inconsistent');

    await chmod(repository, 0o700);
    const repaired = await invokeRepair();
    expect(repaired).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(repaired.stdout)).toEqual({ vault_id: vaultId, status: 'active' });

    const ready = await createObtsServer({ dataDir: root });
    try {
      expect((await ready.store.snapshot()).vaults[0]?.status).toBe('active');
      expect((await ready.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
      expect((await ready.store.snapshot()).audit_log).toContainEqual(
        expect.objectContaining({ action: 'operator_integrity_repaired', vault_id: vaultId })
      );
    } finally {
      await ready.app.close();
    }
  });

  it('fails readiness for restored persistent directories with non-owner access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-directory-permissions-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: root });
    const vaultId = 'vlt_restrictive_permissions';
    const repository = join(root, 'git', `${vaultId}.git`);
    const currentMain = await server.git.initializeVault(vaultId);
    expect((await stat(repository)).mode & 0o777).toBe(0o700);
    await server.store.mutate((db) => {
      const timestamp = new Date().toISOString();
      db.vaults.push({
        vault_id: vaultId,
        owner_user_id: 'usr_owner',
        display_name: 'Restrictive permissions',
        status: 'active',
        current_main: currentMain,
        created_at: timestamp,
        updated_at: timestamp
      });
    });
    await server.app.close();

    const metadataDir = join(root, 'metadata');
    await chmod(metadataDir, 0o770);
    const restored = await createObtsServer({ dataDir: root });
    try {
      const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        status: 'not_ready',
        checks: { metadata_store: false, filesystem_permissions: false }
      });
    } finally {
      await chmod(metadataDir, 0o700);
      await restored.app.close();
    }
  });

  it('fails readiness when the restored data root allows group or other access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-root-permissions-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir });
    await server.app.close();

    await chmod(dataDir, 0o750);
    const restored = await createObtsServer({ dataDir });
    try {
      const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        status: 'not_ready',
        checks: { filesystem_permissions: false }
      });
    } finally {
      await chmod(dataDir, 0o700);
      await restored.app.close();
    }
  });

  it('fails readiness when the restored metadata database allows group or other access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-metadata-permissions-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: root });
    await server.app.close();

    const metadataFile = join(root, 'metadata', 'phase1.json');
    await chmod(metadataFile, 0o640);
    const restored = await createObtsServer({ dataDir: root });
    try {
      const readiness = await restored.app.inject({ method: 'GET', url: '/health/ready' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({
        status: 'not_ready',
        checks: { metadata_store: false, filesystem_permissions: false }
      });
    } finally {
      await chmod(metadataFile, 0o600);
      await restored.app.close();
    }
  });

  it('preserves the primary sync error when post-COMMIT history cleanup also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-primary-history-error-'));
    roots.push(root);
    const f = await historyCheckpointFixture(root);
    checkpointServers.push(f.server);
    const vaultId = f.auth.vault.vault_id;
    const target = await commit(f, f.m0, { 'shared.md': 'new bytes\n' });
    const request = await manifest(f, target, f.m0, 'primary-sync-error');
    await f.server.store.mutate((db) => {
      const row = f.server.store.startOperation(db, {
        vault_id: vaultId, device_id: f.auth.device.device_id, operation_type: 'device_push',
        expected_refs: {}, target_refs: {}, target_commit: f.m0
      });
      row.status = 'aborted';
      row.result = { reason: 'prior_failed_attempt' };
    });
    const primary = new Error('injected primary sync failure');
    const history = (f.server.store as unknown as { histories: Map<string, OperationHistoryStore> }).histories.get(vaultId)!;
    const cleanup = vi.spyOn(history as unknown as { syncFile(): void }, 'syncFile').mockImplementationOnce(() => {
      throw new Error('injected post-COMMIT archive sync failure');
    });
    vi.spyOn(f.server.git, 'getRef').mockRejectedValueOnce(primary);
    try {
      await expect(f.server.sync.pushDeviceCommit(f.auth, request.manifest, request.pack)).rejects.toBe(primary);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(f.server.store.isReady()).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await f.server.app.close();
    }
    const persisted = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
    expect(persisted.sync_operations).toHaveLength(2);
    expect(persisted.sync_operations.every((row: { status: string }) => row.status === 'aborted')).toBe(true);
    expect(persisted.operation_history_by_vault[vaultId].pending_batch.rows).toHaveLength(2);
    for (let restart = 0; restart < 2; restart++) {
      f.server = await createObtsServer({ dataDir: root, sessionSecret: 'checkpoint-test-secret' });
      checkpointServers.push(f.server);
      try {
        expect((await f.server.app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
        expect(await f.server.store.exportOperationHistory(vaultId)).toEqual(persisted.sync_operations);
        expect(await f.server.store.operationHistoryCounts(vaultId)).toEqual({ 'device_push:aborted': 2 });
        expect((await f.server.store.snapshot()).sync_operations).toEqual([]);
        expect(await f.server.git.getRef(vaultId, 'refs/heads/main')).toBe(f.m0);
        expect(await f.server.git.getRef(vaultId, f.auth.device.device_ref)).toBe(f.m0);
      } finally { await f.server.app.close(); }
    }
  });

  it('populated complete checkpoints restore while ledger-only and Git-only mixtures fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-populated-checkpoints-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const f = await historyCheckpointFixture(dataDir);
    checkpointServers.push(f.server);
    const vaultId = f.auth.vault.vault_id;
    const rename = await commit(f, f.m0, { 'old.md': null, 'new.md': 'rename payload\n' });
    const renamed = await manifest(f, rename, f.m0, 'checkpoint-rename', [{ source_path: 'old.md', destination_path: 'new.md' }]);
    renamed.manifest.directory_proposal = await directoryProposal(f, rename);
    expect((await multipart(f, renamed)).result.status).toBe('merged');
    expect((await f.server.store.findArchivedAttempt(vaultId, f.auth.device.device_id, 'checkpoint-rename'))?.row.prepared_manifest).toMatchObject({
      rename_pairs: renamed.manifest.rename_pairs, directory_proposal: renamed.manifest.directory_proposal
    });
    const mainAfterRename = (await f.server.git.getRef(vaultId, 'refs/heads/main'))!;
    const token = 'checkpoint-second-device-token';
    const tokenHash = hashToken(token);
    await f.server.store.mutate((db) => {
      db.devices.push({ ...structuredClone(db.devices[0]!), device_id: 'dev_checkpoint_remote',
        device_ref: 'refs/obts/devices/dev_checkpoint_remote', device_ref_head: mainAfterRename,
        last_applied_main: mainAfterRename, last_applied_event_seq: db.event_seq_by_vault[vaultId]!, last_applied_explicit_dirs: ['Empty'] });
      db.tokens.push({ ...structuredClone(db.tokens.find((row) => row.kind === 'device')!), token_id: 'tok_checkpoint_remote',
        device_id: 'dev_checkpoint_remote', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash });
    });
    await f.server.git.updateRef(vaultId, 'refs/obts/devices/dev_checkpoint_remote', mainAfterRename, null);
    const remote = { ...f, token, m0: mainAfterRename, auth: await f.server.auth.authenticateDevice(`Bearer ${token}`, vaultId) };
    const remoteCommit = await commit(remote, remote.m0, { 'shared.md': 'server version\n' });
    const remoteRequest = await manifest(remote, remoteCommit, remote.m0, 'checkpoint-remote');
    expect((await multipart(remote, remoteRequest)).result.status).toBe('merged');
    const conflictCommit = await commit(f, rename, { 'shared.md': 'device version\n' });
    const conflictRequest = await manifest(f, conflictCommit, mainAfterRename, 'checkpoint-conflict');
    conflictRequest.manifest.expected_device_ref = rename;
    const conflictResult = await multipart(f, conflictRequest);
    expect(conflictResult.result.status).toBe('conflicted');
    const capture = async (name: string) => {
      const retry = await multipart(f, conflictRequest);
      expect(retry.status).toBe(200);
      expect(retry.result.status).toBe('conflicted');
      const db = await f.server.store.snapshot();
      const rows = await f.server.store.exportOperationHistory(vaultId);
      const counts = await f.server.store.operationHistoryCounts(vaultId);
      for (const attempt of ['checkpoint-rename', 'checkpoint-conflict']) {
        expect(db.sync_operations.some((row) => row.prepared_manifest?.attempt_id === attempt)).toBe(false);
        expect(await f.server.store.findArchivedAttempt(vaultId, f.auth.device.device_id, attempt)).not.toBeNull();
      }
      const refs = await Promise.all([
        'refs/heads/main', f.auth.device.device_ref, remote.auth.device.device_ref,
        ...db.conflicts.flatMap((conflict) => ['base', 'current', 'device'].map((suffix) => `refs/obts/conflicts/${conflict.conflict_id}/${suffix}`))
      ].map(async (ref) => [ref, await f.server.git.getRef(vaultId, ref)] as const));
      expect(db.conflicts.some((row) => row.status === 'open')).toBe(true);
      expect(db.directory_state_by_vault[vaultId]?.explicit_dirs).toEqual(['Empty']);
      expect(db.operation_history_by_vault![vaultId]!.generation).toBeGreaterThan(0);
      const allRefs = await refInventory(f);
      await f.server.app.close();
      const path = join(root, name);
      await cp(dataDir, path, { recursive: true });
      return { path, db, rows, counts, refs, allRefs, retry };
    };
    const a = await capture('A');
    f.server = await createObtsServer({ dataDir, sessionSecret: 'checkpoint-test-secret' });
    checkpointServers.push(f.server);
    remote.server = f.server;
    const bCommit = await commit(remote, remoteCommit, { 'later.md': 'checkpoint B\n' });
    const bRequest = await manifest(remote, bCommit, remote.m0, 'checkpoint-B');
    bRequest.manifest.expected_device_ref = remoteCommit;
    expect((await multipart(remote, bRequest)).result.status).toBe('merged');
    const b = await capture('B');
    expect(b.db.vaults[0]!.current_main).not.toBe(a.db.vaults[0]!.current_main);
    expect(b.db.operation_history_by_vault![vaultId]!.generation).toBeGreaterThan(a.db.operation_history_by_vault![vaultId]!.generation);
    for (const [checkpoint, other, mixed] of [
      [a, b, null], [b, a, null], [a, b, 'ledger'], [b, a, 'ledger'], [a, b, 'git'], [b, a, 'git']
    ] as const) {
      await rm(dataDir, { recursive: true });
      await cp(checkpoint.path, dataDir, { recursive: true });
      const historyDir = join(dataDir, 'metadata', 'operation-history', vaultId);
      if (mixed === 'ledger') {
        await rm(historyDir, { recursive: true });
        await cp(join(other.path, 'metadata', 'operation-history', vaultId), historyDir, { recursive: true });
        const otherState = other.db.operation_history_by_vault![vaultId]!;
        OperationHistoryStore.verifyOnDisk(historyDir, vaultId, otherState.ledger_id, otherState.generation, otherState.next_sequence);
      }
      if (mixed === 'git') {
        await rm(join(dataDir, 'git'), { recursive: true });
        await cp(join(other.path, 'git'), join(dataDir, 'git'), { recursive: true });
      }
      const ledgerBefore = createHash('sha256').update(await readFile(join(historyDir, 'history.sqlite'))).digest('hex');
      if (mixed === 'ledger') {
        await expect(createObtsServer({ dataDir, sessionSecret: 'checkpoint-test-secret' })).rejects.toThrow('Operation history generation or sequence mismatch.');
        const persisted = JSON.parse(await readFile(join(dataDir, 'metadata', 'phase1.json'), 'utf8'));
        expect(persisted).toEqual(checkpoint.db);
        expect(createHash('sha256').update(await readFile(join(historyDir, 'history.sqlite'))).digest('hex')).toBe(ledgerBefore);
        for (const [ref, target] of checkpoint.refs) expect(await f.server.git.getRef(vaultId, ref)).toBe(target);
        expect(await refInventory(f)).toBe(checkpoint.allRefs);
        continue;
      }
      f.server = await createObtsServer({ dataDir, sessionSecret: 'checkpoint-test-secret' });
      checkpointServers.push(f.server);
      try {
        const ready = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
        expect(ready.statusCode, `checkpoint ${checkpoint === a ? 'A' : 'B'} with ${mixed ?? 'complete'} restore`).toBe(mixed ? 503 : 200);
        const persisted = JSON.parse(await readFile(join(dataDir, 'metadata', 'phase1.json'), 'utf8'));
        expect(persisted.events).toEqual(checkpoint.db.events);
        expect(persisted.conflicts).toEqual(checkpoint.db.conflicts);
        expect(persisted.sync_operations).toEqual(checkpoint.db.sync_operations);
        const expectedRefs = mixed === 'git' ? other.refs : checkpoint.refs;
        for (const [ref, target] of expectedRefs) expect(await f.server.git.getRef(vaultId, ref)).toBe(target);
        expect(await refInventory(f)).toBe(mixed === 'git' ? other.allRefs : checkpoint.allRefs);
        expect(createHash('sha256').update(await readFile(join(historyDir, 'history.sqlite'))).digest('hex')).toBe(ledgerBefore);
        if (mixed === 'git') {
          expect(persisted.vaults.find((vault: { vault_id: string }) => vault.vault_id === vaultId)).toMatchObject({
            status: 'blocked_integrity', current_main: checkpoint.db.vaults[0]!.current_main
          });
          const readiness = ready.json() as { detail: string; checks: Record<string, boolean> };
          expect(readiness.detail).toBe('vault persistent state is blocked by an integrity failure');
          expect(readiness.checks.persistent_state).toBe(false);
          for (const [check, passed] of Object.entries(readiness.checks)) {
            if (check !== 'persistent_state') expect(passed, check).toBe(true);
          }
          const metadataBeforeRepair = await readFile(join(dataDir, 'metadata', 'phase1.json'));
          const snapshotBeforeRepair = await f.server.store.snapshot();
          await expect(repairVaultIntegrity(f.server.store, f.server.git, vaultId))
            .rejects.toThrow('Vault integrity remains inconsistent: vault main ref is inconsistent with metadata');
          expect(await readFile(join(dataDir, 'metadata', 'phase1.json'))).toEqual(metadataBeforeRepair);
          expect(await f.server.store.snapshot()).toEqual(snapshotBeforeRepair);
          expect(await refInventory(f)).toBe(other.allRefs);
          expect(createHash('sha256').update(await readFile(join(historyDir, 'history.sqlite'))).digest('hex')).toBe(ledgerBefore);
        }
        if (!mixed) {
          expect(await f.server.store.exportOperationHistory(vaultId)).toEqual(checkpoint.rows);
          expect(await f.server.store.operationHistoryCounts(vaultId)).toEqual(checkpoint.counts);
          const restored = await f.server.store.snapshot();
          expect(restored.directory_state_by_vault).toEqual(checkpoint.db.directory_state_by_vault);
          expect(restored.directory_proposal_results).toEqual(checkpoint.db.directory_proposal_results);
          const main = checkpoint.db.vaults[0]!.current_main;
          expect((await f.server.git.readBlobAtPath(vaultId, main, 'shared.md')).toString()).toBe('server version\n');
          if (checkpoint === b) expect((await f.server.git.readBlobAtPath(vaultId, main, 'later.md')).toString()).toBe('checkpoint B\n');
          expect((await f.server.git.readBlobAtPath(vaultId, main, 'new.md')).toString()).toBe('rename payload\n');
          expect((await f.server.git.readBlobAtPath(vaultId, conflictCommit, 'shared.md')).toString()).toBe('device version\n');
          expect(await multipart(f, conflictRequest)).toEqual(checkpoint.retry);
          expect((await f.server.store.snapshot()).events).toEqual(checkpoint.db.events);
          const mismatched = structuredClone(renamed);
          mismatched.manifest.base_commit = mainAfterRename;
          const rejected = await multipart(f, mismatched);
          expect(rejected.status).toBe(409);
          expect(rejected.result).toMatchObject({ error: { code: 'attempt_mismatch' } });
        }
      } finally { await f.server.app.close(); }
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
        conflict_kind: 'content',
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
    await source.git.exec(join(restoredDir, 'git', `${vaultId}.git`), [
      'update-ref',
      '-d',
      `refs/obts/conflicts/${conflictId}/current`
    ]);
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
      expect(await restored.git.getRef(vaultId, `refs/obts/conflicts/${conflictId}/current`)).toBe(main);
      expect(await restored.git.getRef(vaultId, `refs/obts/conflicts/${conflictId}/device`)).toBe(rootCommit);
    } finally {
      await restored.app.close();
    }
  });
});
