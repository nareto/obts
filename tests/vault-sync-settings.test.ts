import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';

describe('owner-managed vault sync settings', () => {
  let root: string | undefined;
  let server: ObtsServer | undefined;
  let dataDir = '';
  let cookie: string | string[] | undefined;
  let csrf = '';
  let vaultId = '';

  afterEach(async () => {
    await server?.app.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-settings-'));
    dataDir = join(root, 'data');
    server = await createObtsServer({ dataDir, sessionSecret: 'settings-test-secret-with-sufficient-entropy' });
    const setupResponse = await server.app.inject({
      method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    cookie = setupResponse.headers['set-cookie'];
    csrf = (setupResponse.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'Settings fixture' }
    });
    expect(created.statusCode).toBe(201);
    vaultId = (created.json() as { vault_id: string }).vault_id;
    const db = await server.store.snapshot();
    const vault = db.vaults.find((item) => item.vault_id === vaultId)!;
    const tree = await server.git.createTreeFromCommitWithChanges({
      vaultId, sourceCommit: vault.current_main,
      writes: new Map([['private/record.md', Buffer.from('keep in the old history\n')], ['public.md', Buffer.from('public\n')]])
    });
    const commit = await server.git.createMainCommitFromTree({
      vaultId, tree, parentMain: vault.current_main, subject: 'fixture notes', body: '', actor: 'settings-test'
    });
    await server.git.updateRef(vaultId, 'refs/heads/main', commit, vault.current_main);
    await server.store.mutate((mutable) => {
      const current = mutable.vaults.find((item) => item.vault_id === vaultId)!;
      current.current_main = commit;
      mutable.directory_state_by_vault[vaultId] = {
        explicit_dirs: ['private'], updated_at: new Date().toISOString(),
        last_event_seq: mutable.event_seq_by_vault[vaultId] ?? 0
      };
    });
  }

  async function settings() {
    const response = await server!.app.inject({ method: 'GET', url: `/api/v1/vaults/${vaultId}/sync-settings`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      vault_id: string; current_main: string; root_ignore_oid: string | null; root_ignore: string | null;
      metadata_conflict_rules: Array<{ field: string; strategy: 'latest_timestamp' }>;
    };
  }

  async function preview(current: Awaited<ReturnType<typeof settings>>, rootIgnore: string | null, rules: Array<{ field: string; strategy: 'latest_timestamp' }>) {
    const response = await server!.app.inject({
      method: 'POST', url: `/api/v1/vaults/${vaultId}/sync-settings/preview`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: {
        expected_main: current.current_main, expected_root_ignore_oid: current.root_ignore_oid,
        root_ignore: rootIgnore, metadata_conflict_rules: rules
      }
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { preview_tree: string; review_fingerprint: string; affected_paths: string[]; affected_directories: string[]; root_ignore_oid: string | null; changes_main: boolean };
  }

  async function save(current: Awaited<ReturnType<typeof settings>>, previewed: Awaited<ReturnType<typeof preview>>, rootIgnore: string | null, rules: Array<{ field: string; strategy: 'latest_timestamp' }>) {
    return await server!.app.inject({
      method: 'PUT', url: `/api/v1/vaults/${vaultId}/sync-settings`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: {
        expected_main: current.current_main, expected_root_ignore_oid: current.root_ignore_oid,
        preview_tree: previewed.preview_tree, review_fingerprint: previewed.review_fingerprint, root_ignore: rootIgnore, metadata_conflict_rules: rules,
        expected_metadata_conflict_rules: current.metadata_conflict_rules
      }
    });
  }

  it('previews exact exclusions, advances main, retains old history, and saves per-vault timestamp rules', async () => {
    await setup();
    const before = await settings();
    const rules = [{ field: 'updated', strategy: 'latest_timestamp' as const }];
    const previewed = await preview(before, 'private/\n', rules);
    expect(previewed.affected_paths).toEqual(['private/record.md']);
    expect(previewed.affected_directories).toEqual(['private']);
    expect(previewed.changes_main).toBe(true);
    await server!.store.mutate((db) => { db.sessions[0]!.recent_auth_at = new Date(0).toISOString(); });
    const oldMain = before.current_main;
    const saved = await save(before, previewed, 'private/\n', rules);
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await settings();
    expect(after).toMatchObject({ root_ignore: 'private/\n', metadata_conflict_rules: rules });
    expect(after.current_main).not.toBe(oldMain);
    expect(await server!.git.listTreePaths(vaultId, after.current_main)).not.toContain('private/record.md');
    expect(await server!.git.listTreePaths(vaultId, oldMain)).toContain('private/record.md');
    expect((await server!.store.snapshot()).directory_state_by_vault[vaultId]?.explicit_dirs).toEqual([]);
    const rulesOnly = [{ field: 'modified', strategy: 'latest_timestamp' as const }];
    await server!.store.mutate((db) => { db.directory_state_by_vault[vaultId]!.explicit_dirs = ['private']; });
    const metadataPreview = await preview(after, 'private/\n', rulesOnly);
    expect(metadataPreview.changes_main).toBe(false);
    expect((await save(after, metadataPreview, 'private/\n', rulesOnly)).statusCode).toBe(200);
    expect((await settings()).metadata_conflict_rules).toEqual(rulesOnly);
    const unchanged = await settings();
    const noOpPreview = await preview(unchanged, unchanged.root_ignore, unchanged.metadata_conflict_rules);
    expect(noOpPreview.changes_main).toBe(false);
    expect((await save(unchanged, noOpPreview, unchanged.root_ignore, unchanged.metadata_conflict_rules)).statusCode).toBe(200);
    const staleRulesPreview = await preview(await settings(), 'private/\n', []);
    await server!.store.mutate((db) => { db.vaults.find((item) => item.vault_id === vaultId)!.metadata_conflict_rules = [{ field: 'other', strategy: 'latest_timestamp' }]; });
    expect((await save(await settings(), staleRulesPreview, 'private/\n', [])).statusCode).toBe(409);
  });

  it('binds saves to reviewed metadata rules and complete directory outcomes', async () => {
    await setup();
    const before = await settings();
    const previewed = await preview(before, 'private/\n', []);
    await server!.store.mutate((db) => {
      db.directory_state_by_vault[vaultId]!.explicit_dirs = ['private', 'private/new-empty'];
    });
    const result = await save(before, previewed, 'private/\n', []);
    expect(result.statusCode).toBe(409);
    const current = await settings();
    const rulesPreview = await preview(current, 'private/\n', [{ field: 'updated', strategy: 'latest_timestamp' }]);
    const altered = await save(current, rulesPreview, 'private/\n', []);
    expect(altered.statusCode).toBe(409);
  });

  it('recovers a prepared settings commit after main moved but metadata publication was interrupted', async () => {
    await setup();
    const before = await settings();
    const rules = [{ field: 'updated', strategy: 'latest_timestamp' as const }];
    const previewed = await preview(before, 'private/\n', rules);
    const sync = server!.sync as unknown as { commitVaultSettingsOperation: (id: string) => Promise<void> };
    sync.commitVaultSettingsOperation = async () => { throw new Error('simulated interruption after ref move'); };
    const interrupted = await save(before, previewed, 'private/\n', rules);
    expect(interrupted.statusCode, interrupted.body).toBe(500);
    const refAfterInterruption = await server!.git.getRef(vaultId, 'refs/heads/main');
    expect(refAfterInterruption).not.toBe(before.current_main);
    await server!.app.close();
    server = await createObtsServer({ dataDir, sessionSecret: 'settings-test-secret-with-sufficient-entropy' });
    const recovered = await settings();
    expect(recovered.current_main).toBe(refAfterInterruption);
    expect(recovered).toMatchObject({ root_ignore: 'private/\n', metadata_conflict_rules: rules });
    expect(await server.git.listTreePaths(vaultId, recovered.current_main)).not.toContain('private/record.md');
    expect((await server.store.snapshot()).directory_state_by_vault[vaultId]?.explicit_dirs).toEqual([]);
  });

  it('blocks policy changes until every paired device supports the root ignore contract', async () => {
    await setup();
    await server!.store.mutate((db) => {
      db.devices.push({
        device_id: 'device-legacy', vault_id: vaultId, user_id: db.users[0]!.user_id, device_name: 'Legacy',
        device_ref: 'refs/obts/devices/device-legacy', device_ref_head: null, status: 'paired', last_applied_main: null,
        last_applied_event_seq: 0, last_applied_explicit_dirs: null, pending_applied_main: null,
        pending_applied_event_seq: 0, pending_applied_explicit_dirs: null, last_seen_at: null, last_successful_sync_at: null,
        local_status_label: null, local_error_code: null, local_queue_status: null, local_main: null, local_head: null,
        plugin_version: null, path_capabilities: {}, last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'initialize',
        initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: null,
        created_at: new Date().toISOString(), revoked_at: null
      });
    });
    const before = await settings();
    const proposed = await preview(before, 'private/\n', []);
    expect((await save(before, proposed, 'private/\n', [])).statusCode).toBe(409);
  });

  it('requires CSRF protection for preview and save', async () => {
    await setup();
    const current = await settings();
    const missing = await server!.app.inject({
      method: 'POST', url: `/api/v1/vaults/${vaultId}/sync-settings/preview`, headers: { cookie },
      payload: { expected_main: current.current_main, expected_root_ignore_oid: current.root_ignore_oid, root_ignore: null, metadata_conflict_rules: [] }
    });
    const invalid = await server!.app.inject({
      method: 'PUT', url: `/api/v1/vaults/${vaultId}/sync-settings`, headers: { cookie, 'x-obts-csrf': 'wrong-token' },
      payload: { expected_main: current.current_main, expected_root_ignore_oid: current.root_ignore_oid, preview_tree: current.current_main,
        review_fingerprint: '0'.repeat(64), root_ignore: null, metadata_conflict_rules: [], expected_metadata_conflict_rules: [] }
    });
    expect(missing.statusCode).toBe(403);
    expect(invalid.statusCode).toBe(403);
  });

  it('uses captured timestamp rules for matching bytes and falls back on invalid UTF-8', async () => {
    await setup();
    const initial = await settings();
    const baseSource = '---\nupdated: 2026-01-01T00:00:00Z\n---\nbody\n';
    const serverSource = '---\nupdated: 2026-01-03T00:00:00Z\n---\nbody\n';
    const deviceSource = '---\nupdated: 2026-01-02T00:00:00Z\n---\nbody\n';
    const commitWith = async (parent: string, bytes: Buffer) => {
      const tree = await server!.git.createTreeFromCommitWithChanges({
        vaultId, sourceCommit: parent, writes: new Map([['merge.md', bytes]])
      });
      return await server!.git.createMainCommitFromTree({
        vaultId, tree, parentMain: parent, subject: 'timestamp fixture', body: '', actor: 'settings-test'
      });
    };
    const base = await commitWith(initial.current_main, Buffer.from(baseSource));
    const current = await commitWith(base, Buffer.from(serverSource));
    const device = await commitWith(base, Buffer.from(deviceSource));
    const changes = await server!.git.changedPaths(vaultId, base, device);
    const rules = [{ field: 'updated', strategy: 'latest_timestamp' as const }];
    const merged = await server!.git.tryPolicyMergeTree(vaultId, base, current, device, changes, ['merge.md'], rules);
    expect(merged).not.toBeNull();
    expect(await server!.git.readBlobAtPath(vaultId, merged!.tree, 'merge.md')).toEqual(Buffer.from(serverSource));
    expect(merged!.validatorResults.metadata_timestamp_fields).toEqual([{ path: 'merge.md', field: 'updated', winner: 'server' }]);

    const invalidServerBytes = Buffer.concat([Buffer.from(serverSource), Buffer.from([0xff])]);
    const invalidCurrent = await commitWith(base, invalidServerBytes);
    const invalidMerge = await server!.git.tryPolicyMergeTree(vaultId, base, invalidCurrent, device, changes, ['merge.md'], rules);
    expect(invalidMerge).toBeNull();

    const invalidBaseBytes = Buffer.concat([Buffer.from('line one\nline two\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]);
    const invalidBase = await commitWith(initial.current_main, invalidBaseBytes);
    const nativeCurrent = await commitWith(invalidBase, Buffer.concat([Buffer.from('server line\nline two\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    const nativeDevice = await commitWith(invalidBase, Buffer.concat([Buffer.from('line one\ndevice line\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    const nativeChanges = await server!.git.changedPaths(vaultId, invalidBase, nativeDevice);
    const invalidNative = await server!.git.tryPolicyMergeTree(vaultId, invalidBase, nativeCurrent, nativeDevice, nativeChanges, ['merge.md'], rules);
    expect(invalidNative).toBeNull();
  });

  it('rejects stale previews and non-owner access', async () => {
    await setup();
    const before = await settings();
    const previewed = await preview(before, 'private/\n', []);
    const advanced = await server!.git.createMainCommitFromTree({
      vaultId, tree: await server!.git.treeHash(vaultId, before.current_main), parentMain: before.current_main,
      subject: 'advance main', body: '', actor: 'settings-test'
    });
    await server!.git.updateRef(vaultId, 'refs/heads/main', advanced, before.current_main);
    await server!.store.mutate((db) => { db.vaults.find((item) => item.vault_id === vaultId)!.current_main = advanced; });
    expect((await save(before, previewed, 'private/\n', [])).statusCode).toBe(409);
    const other = await server!.store.mutate((db) => {
      const user = db.users[0]!;
      return user.user_id;
    });
    await server!.store.mutate((db) => { db.vaults.find((item) => item.vault_id === vaultId)!.owner_user_id = `${other}-other`; });
    const denied = await server!.app.inject({ method: 'GET', url: `/api/v1/vaults/${vaultId}/sync-settings`, headers: { cookie } });
    expect(denied.statusCode).toBe(404);
  });
});
