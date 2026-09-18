import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import {
  MetadataStore,
  type MetadataPersistenceAdapter
} from '../src/server/metadataStore.js';
import { hashToken } from '../src/server/authService.js';
import type { AuthenticatedDevice } from '../src/server/authService.js';
import { API_VERSION } from '../src/shared/types.js';
import {
  openDeletionRoot,
  removeDeletionRootDirectoryChild,
  syncDeletionRoot
} from '../src/server/deletionRoot.js';

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const diagnosticReport = {
  schema_version: 1,
  event_id: 'dgr_0123456789abcdef0123456789abcdef',
  plugin_version: '0.4.0',
  obsidian_version: '1.9.12',
  platform_family: 'ios',
  flow: 'sync',
  stage: 'pack_index',
  failure_code: 'missing_buffer_dependency',
  error_class: 'type_error',
  retryable: false,
  breadcrumbs: [{ point: 'index_fs_read', outcome: 'returned', value_kind: 'buffer', size_bucket: 'under_1m', error_code: 'none' }]
} as const;

async function adapterWithTrace(events: string[], overrides: Partial<MetadataPersistenceAdapter> = {}): Promise<MetadataPersistenceAdapter> {
  return {
    readDirectory: async (path) => await readdir(path),
    writeFile: async (path, data) => {
      events.push('write');
      await writeFile(path, data, { mode: 0o600 });
    },
    fsyncFile: async (path) => {
      events.push('file-fsync');
      const file = await open(path, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    },
    rename: async (source, destination) => {
      events.push('rename');
      await (overrides.rename ?? (async () => await import('node:fs/promises').then(({ rename }) => rename(source, destination))))(source, destination);
    },
    fsyncDirectory: async (path) => {
      events.push('dir-fsync');
      const directory = await open(path, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    remove: async (path) => {
      events.push('remove');
      await rm(path, { force: true });
    },
    ...overrides
  };
}

async function createSessionVault(server: ObtsServer, displayName: string): Promise<{ vaultId: string; cookie: string; csrf: string }> {
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
  const cookie = setup.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('session cookie missing');
  const csrf = (setup.json() as { csrf_token: string }).csrf_token;
  const created = await server.app.inject({
    method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: displayName }
  });
  return { vaultId: (created.json() as { vault_id: string }).vault_id, cookie, csrf };
}

async function addSyntheticDevice(server: ObtsServer, vaultId: string): Promise<AuthenticatedDevice> {
  await server.store.mutate((db) => {
    const user = db.users[0];
    if (!user) throw new Error('test user missing');
    db.devices.push({
      device_id: 'dev_hardening', vault_id: vaultId, user_id: user.user_id, device_name: 'hardening device',
      device_ref: 'refs/heads/device/dev_hardening', device_ref_head: null, status: 'synced',
      last_applied_main: null, last_applied_event_seq: 0, last_applied_explicit_dirs: null,
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'initialize', initial_proposal_kind: null,
      initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), revoked_at: null
    });
    db.tokens.push({
      token_id: 'tok_hardening', kind: 'device', lookup_prefix: 'hardening', token_hash: 'hardening',
      user_id: user.user_id, vault_id: vaultId, device_id: 'dev_hardening', expires_at: null,
      consumed_at: null, failed_attempts: 0, revoked_at: null, metadata: {}, created_at: new Date().toISOString()
    });
  });
  const db = await server.store.snapshot();
  const user = db.users[0];
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  const device = db.devices.find((candidate) => candidate.device_id === 'dev_hardening');
  const token = db.tokens.find((candidate) => candidate.token_id === 'tok_hardening');
  if (!user || !vault || !device || !token) throw new Error('synthetic device setup failed');
  return { user, vault, device, token };
}

describe('vault deletion hardening', () => {
  const roots: string[] = [];
  const servers: ObtsServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('publishes metadata in file-fsync-before-rename order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-metadata-order-'));
    roots.push(root);
    const events: string[] = [];
    const store = new MetadataStore(join(root, 'data'), await adapterWithTrace(events));
    await store.initialize();
    events.length = 0;
    await store.mutateDurably((db) => { db.setup_complete = true; });
    expect(events).toEqual(['write', 'file-fsync', 'rename', 'dir-fsync', 'remove']);
  });

  it('keeps the old metadata authoritative after a pre-rename file-fsync failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-metadata-file-fsync-'));
    roots.push(root);
    let failFileSync = false;
    const events: string[] = [];
    const store = new MetadataStore(join(root, 'data'), await adapterWithTrace(events, {
      fsyncFile: async (path) => {
        events.push('file-fsync');
        if (failFileSync) throw new Error('synthetic file fsync failure');
        const file = await open(path, 'r');
        try { await file.sync(); } finally { await file.close(); }
      }
    }));
    await store.initialize();
    failFileSync = true;
    await expect(store.mutateDurably((db) => { db.setup_complete = true; })).rejects.toThrow('synthetic file fsync failure');
    expect(store.isDurabilityUncertain()).toBe(false);
    expect((await store.snapshot()).setup_complete).toBe(false);
    expect((await readdir(join(root, 'data', 'metadata'))).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('fails all metadata operations after ambiguous directory publication and reloads the candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-metadata-uncertain-'));
    roots.push(root);
    let failDirectorySync = false;
    const events: string[] = [];
    const store = new MetadataStore(join(root, 'data'), await adapterWithTrace(events, {
      fsyncDirectory: async (path) => {
        events.push('dir-fsync');
        if (failDirectorySync) throw new Error('synthetic directory fsync failure');
        const directory = await open(path, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }));
    await store.initialize();
    failDirectorySync = true;
    await expect(store.mutateDurably((db) => { db.setup_complete = true; })).rejects.toThrow('Metadata publication durability is uncertain.');
    expect(store.isDurabilityUncertain()).toBe(true);
    let callbackRan = false;
    await expect(store.mutateDurably(() => { callbackRan = true; })).rejects.toThrow('Metadata publication durability is uncertain.');
    await expect(store.snapshot()).rejects.toThrow('Metadata publication durability is uncertain.');
    expect(callbackRan).toBe(false);

    const restarted = new MetadataStore(join(root, 'data'));
    await restarted.initialize();
    expect((await restarted.snapshot()).setup_complete).toBe(true);
  });

  it('does not clean an ambiguous rename candidate in the uncertain process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-metadata-rename-'));
    roots.push(root);
    const events: string[] = [];
    let failRename = false;
    const store = new MetadataStore(join(root, 'data'), await adapterWithTrace(events, {
      rename: async (source, destination) => {
        events.push('rename');
        if (failRename) throw new Error('synthetic ambiguous rename failure');
        await (await import('node:fs/promises')).rename(source, destination);
      }
    }));
    await store.initialize();
    events.length = 0;
    failRename = true;
    await expect(store.mutateDurably((db) => { db.setup_complete = true; })).rejects.toThrow('Metadata publication durability is uncertain.');
    expect(store.isDurabilityUncertain()).toBe(true);
    expect(events).toEqual(['write', 'file-fsync', 'rename']);
    const metadataEntries = await readdir(join(root, 'data', 'metadata'));
    expect(metadataEntries.some((entry) => entry.endsWith('.tmp'))).toBe(true);
    const restarted = new MetadataStore(join(root, 'data'));
    await restarted.initialize();
    expect((await readdir(join(root, 'data', 'metadata'))).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('reconciles a deleting row without a job before starting recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-delete-reconcile-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'reconcile me' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    await mkdir(join(dataDir, 'transfers', 'unknown-residue'), { recursive: true });
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
      if (!vault) throw new Error('test vault missing');
      vault.status = 'deleting';
      vault.updated_at = new Date().toISOString();
    });
    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(restarted);
    const snapshot = await restarted.store.snapshot();
    expect(snapshot.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(snapshot.vaults.find((vault) => vault.vault_id === vaultId)?.status).toBe('deleting');
  });

  it('skips startup root repair when a durable deletion job blocks an active row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-startup-delete-gate-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'startup gate' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    await mkdir(join(dataDir, 'transfers', 'unknown-startup-residue'), { recursive: true });
    await server.store.mutate((db) => {
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
      const user = db.users[0];
      if (!vault || !user) throw new Error('startup gate fixture missing');
      vault.root_commit = null;
      db.deletion_jobs.push({ vault_id: vaultId, owner_user_id: user.user_id, requested_at: new Date().toISOString(), phase: 'intent', retry_at: null, error_code: null });
    });
    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(restarted);
    const snapshot = await restarted.store.snapshot();
    expect(snapshot.vaults.find((vault) => vault.vault_id === vaultId)?.root_commit).toBeNull();
    expect(snapshot.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
  });

  it('retains a pending job when the transfer root is no longer a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-root-fault-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'transfer fault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const transferRoot = join(dataDir, 'transfers');
    await rm(transferRoot, { recursive: true, force: true });
    await writeFile(transferRoot, 'not a directory');
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
  });

  it('blocks completion on unknown transfer residue without erasing Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-unknown-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'unknown residue' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    await writeFile(join(dataDir, 'transfers', 'foreign-material'), 'sentinel');
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
  });

  it('rejects a configured deletion root symlink before startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-configured-root-symlink-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    const symlinkedGit = join(root, 'git-link');
    await symlink(outside, symlinkedGit);
    await expect(createObtsServer({ dataDir, gitStoreDir: symlinkedGit, sessionSecret: 'hardening-test-session-secret' })).rejects.toThrow();
  });

  it('rejects a target repository symlink and preserves the outside sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-delete-symlink-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const outside = join(root, 'outside-repository');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'sentinel'), 'preserve');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'symlink target' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const repository = join(dataDir, 'git', `${vaultId}.git`);
    await rm(repository, { recursive: true, force: true });
    await symlink(outside, repository);
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('preserve');
  });

  it('revalidates device diagnostics at the mutation seam and drains a held diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-diagnostic-admission-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, diagnosticIngestEnabled: true, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'diagnostic admission' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const auth = await addSyntheticDevice(server, vaultId);
    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === auth.device.device_id);
      if (device) device.status = 'revoked';
    });
    await expect(server.lifecycle.withDeviceAdmission(vaultId, auth.user.user_id, auth.device.device_id, async () =>
      await server.diagnostics.ingestDevice(auth, diagnosticReport, '127.0.0.1')
    )).rejects.toMatchObject({ code: 'not_found' });
    expect((await server.store.snapshot()).diagnostic_events).toHaveLength(0);

    await server.store.mutate((db) => {
      const device = db.devices.find((candidate) => candidate.device_id === auth.device.device_id);
      if (device) { device.status = 'synced'; device.revoked_at = null; }
    });
    let releaseMutation!: () => void;
    let signalMutation!: () => void;
    const mutationEntered = new Promise<void>((resolve) => { signalMutation = resolve; });
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const originalMutate = server.store.mutate.bind(server.store);
    let firstMutation = true;
    const mutateSpy = vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      return await originalMutate(async (db) => {
        if (firstMutation) {
          firstMutation = false;
          signalMutation();
          await mutationGate;
        }
        return await fn(db);
      });
    });
    const diagnostic = server.lifecycle.withDeviceAdmission(vaultId, auth.user.user_id, auth.device.device_id, async () =>
      await server.diagnostics.ingestDevice(auth, diagnosticReport, '127.0.0.1')
    );
    await mutationEntered;
    const deletionPromise = server.lifecycle.beginDeletion({ ownerUserId: auth.user.user_id, vaultId, confirmation: `DELETE ${vaultId}` });
    await sleep(40);
    const durableBeforeRelease = JSON.parse(await readFile(join(dataDir, 'metadata', 'phase1.json'), 'utf8')) as { deletion_receipts: unknown[] };
    expect(durableBeforeRelease.deletion_receipts).toHaveLength(0);
    releaseMutation();
    await diagnostic;
    const deletion = await deletionPromise;
    expect(deletion.status).toBe('deleting');
    mutateSpy.mockRestore();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)) break;
      await sleep(10);
    }
    expect((await server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(true);
  });

  it('rejects stale device admission after deletion closes the barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-diagnostic-late-admission-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: join(root, 'data'), diagnosticIngestEnabled: true, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'late diagnostic' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const auth = await addSyntheticDevice(server, vaultId);
    await server.lifecycle.beginDeletion({ ownerUserId: auth.user.user_id, vaultId, confirmation: `DELETE ${vaultId}` });
    await expect(server.lifecycle.withDeviceAdmission(vaultId, auth.user.user_id, auth.device.device_id, async () =>
      await server.diagnostics.ingestDevice(auth, { ...diagnosticReport, event_id: 'dgr_fedcba9876543210fedcba9876543210' }, '127.0.0.1')
    )).rejects.toMatchObject({ code: 'vault_deleting' });
    expect((await server.store.snapshot()).diagnostic_events).toHaveLength(0);
  });

  it('blocks a current-version malformed transfer session without deleting residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-malformed-session-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId, cookie, csrf } = await createSessionVault(server, 'malformed transfer');
    const sessionDir = join(dataDir, 'transfers', 'trn_malformed');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'owner.json'), JSON.stringify({ vault_id: vaultId }));
    await mkdir(join(dataDir, 'outside-transfer'), { recursive: true });
    await writeFile(join(dataDir, 'outside-transfer', 'sentinel'), 'preserve');
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ version: 1, transfer_id: '../outside-transfer' }));
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    expect(snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code).toBe('unattributed_residue');
    await expect(lstat(join(dataDir, 'transfers', 'trn_malformed', 'session.json'))).resolves.toBeTruthy();
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
    await expect(lstat(join(dataDir, 'outside-transfer', 'sentinel'))).resolves.toBeTruthy();
  });

  it('requires transfer owner evidence to agree before deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-owner-marker-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId, cookie, csrf } = await createSessionVault(server, 'transfer owner marker');
    const auth = await addSyntheticDevice(server, vaultId);
    const created = await server.chunkTransfers.createPush(auth, {
      api_version: API_VERSION,
      vault_id: vaultId,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: auth.vault.current_main,
      client_known_main: auth.vault.current_main,
      attempt_id: 'hardening-owner-marker-attempt',
      chunk_count: 0,
      plan_sha256: '0'.repeat(64)
    });
    await writeFile(join(dataDir, 'transfers', created.descriptor.transfer_id, 'owner.json'), JSON.stringify({ vault_id: 'vlt_foreign' }));
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    expect(snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code).toBe('unattributed_residue');
    await expect(lstat(join(dataDir, 'transfers', created.descriptor.transfer_id))).resolves.toBeTruthy();
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
  });

  it('requires target temp ownership markers and blocks markerless, foreign, and merge-index residue', async () => {
    const cases = [
      ['markerless', undefined],
      ['malformed', '{'],
      ['foreign', JSON.stringify({ vault_id: 'vlt_foreign' })],
      ['merge-index', JSON.stringify({ vault_id: 'vlt_target' })]
    ] as const;
    for (const [label, marker] of cases) {
      const root = await mkdtemp(join(tmpdir(), `obts-temp-${label}-`));
      roots.push(root);
      const dataDir = join(root, 'data');
      const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
      servers.push(server);
      const { vaultId, cookie, csrf } = await createSessionVault(server, `temp ${label}`);
      const name = label === 'merge-index' ? `merge-index-${vaultId}` : `quarantine-${vaultId}-${label}`;
      const tempDir = join(dataDir, 'tmp', name);
      await mkdir(tempDir, { recursive: true });
      if (marker !== undefined) await writeFile(join(tempDir, '.obts-owner.json'), marker.replace('vlt_target', vaultId));
      const accepted = await server.app.inject({
        method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
      });
      expect(accepted.statusCode).toBe(202);
      let snapshot = await server.store.snapshot();
      for (let attempt = 0; attempt < 100 && snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code !== 'unattributed_residue'; attempt += 1) {
        await sleep(10);
        snapshot = await server.store.snapshot();
      }
      expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
      expect(snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code).toBe('unattributed_residue');
      await expect(lstat(tempDir)).resolves.toBeTruthy();
      await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
      await server.app.close();
      servers.splice(servers.indexOf(server), 1);
    }
  });

  it('blocks unknown Git-root residue while preserving the target repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-git-unknown-residue-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId, cookie, csrf } = await createSessionVault(server, 'unknown Git residue');
    await writeFile(join(dataDir, 'git', 'unknown-material'), 'sentinel');
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    expect(snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code).toBe('unattributed_residue');
    await expect(lstat(join(dataDir, 'git', 'unknown-material'))).resolves.toBeTruthy();
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
  });

  it('blocks unknown matching Git directories while preserving known foreign repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-git-matching-residue-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId, cookie, csrf } = await createSessionVault(server, 'matching Git residue');
    const foreign = await server.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'known foreign vault' }
    });
    const foreignVaultId = (foreign.json() as { vault_id: string }).vault_id;
    const unknownRepository = join(dataDir, 'git', 'unknown.git');
    await mkdir(unknownRepository, { recursive: true });
    const accepted = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await sleep(80);
    expect((await server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    expect((await server.store.snapshot()).deletion_jobs.find((job) => job.vault_id === vaultId)?.error_code).toBe('unattributed_residue');
    await expect(lstat(unknownRepository)).resolves.toBeTruthy();
    await expect(lstat(join(dataDir, 'git', `${vaultId}.git`))).resolves.toBeTruthy();
    await rm(unknownRepository, { recursive: true, force: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)) break;
      await sleep(10);
    }
    expect((await server.store.snapshot()).deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(true);
    await expect(lstat(join(dataDir, 'git', `${foreignVaultId}.git`))).resolves.toBeTruthy();
  });

  it('fsyncs a trusted deletion root after child removal and propagates sync faults', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'obts-deletion-root-sync-'));
    roots.push(rootPath);
    const child = join(rootPath, 'child');
    await mkdir(child);
    const root = await openDeletionRoot(rootPath);
    const sync = vi.spyOn(root.handle, 'sync');
    await removeDeletionRootDirectoryChild(root, 'child');
    await syncDeletionRoot(root);
    expect(sync).toHaveBeenCalledTimes(1);
    await expect(lstat(child)).rejects.toMatchObject({ code: 'ENOENT' });
    sync.mockRejectedValueOnce(new Error('synthetic root sync failure'));
    await expect(syncDeletionRoot(root)).rejects.toThrow('synthetic root sync failure');
    await root.handle.close();
  });

  it('fails closed after metadata temp cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-metadata-cleanup-'));
    roots.push(root);
    let failRemoval = false;
    const events: string[] = [];
    const store = new MetadataStore(join(root, 'data'), await adapterWithTrace(events, {
      remove: async (path) => {
        events.push('remove');
        if (failRemoval) throw new Error('synthetic cleanup failure');
        await rm(path, { force: true });
      }
    }));
    await store.initialize();
    const metadataDir = join(root, 'data', 'metadata');
    await writeFile(join(metadataDir, 'phase1.json.1.1.abcdef.tmp'), 'stale');
    failRemoval = true;
    await expect(store.cleanupPersistenceTemps()).rejects.toThrow('Metadata temporary-file cleanup is unavailable.');
    expect(store.isReady()).toBe(false);
    let callbackRan = false;
    await expect(store.mutateDurably(() => { callbackRan = true; })).rejects.toThrow('Metadata temporary-file cleanup is unavailable.');
    await expect(store.snapshot()).rejects.toThrow('Metadata temporary-file cleanup is unavailable.');
    expect(callbackRan).toBe(false);
  });

  it('rejects device self requests after deletion closes a delayed admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-device-self-deletion-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const server = await createObtsServer({ dataDir, sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId, cookie, csrf } = await createSessionVault(server, 'self endpoint');
    const tokenSecret = 'hardening-device-self-token';
    const tokenHash = hashToken(tokenSecret);
    await server.store.mutate((db) => {
      const user = db.users[0];
      if (!user) throw new Error('self endpoint user missing');
      db.devices.push({
        device_id: 'dev_self_hardening', vault_id: vaultId, user_id: user.user_id, device_name: 'self device',
        device_ref: 'refs/heads/device/dev_self_hardening', device_ref_head: null, status: 'synced',
        last_applied_main: null, last_applied_event_seq: 0, last_applied_explicit_dirs: null,
        pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
        last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
        local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
        last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'initialize', initial_proposal_kind: null,
        initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: new Date().toISOString(),
        created_at: new Date().toISOString(), revoked_at: null
      });
      db.tokens.push({
        token_id: 'tok_self_hardening', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
        user_id: user.user_id, vault_id: vaultId, device_id: 'dev_self_hardening', expires_at: null,
        consumed_at: null, failed_attempts: 0, revoked_at: null, metadata: {}, created_at: new Date().toISOString()
      });
    });
    let releaseAuth!: () => void;
    let authReturned!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    const authDone = new Promise<void>((resolve) => { authReturned = resolve; });
    const originalMutate = server.store.mutate.bind(server.store);
    let holdNextAuth = true;
    const mutateSpy = vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      const result = await originalMutate(fn);
      if (holdNextAuth) {
        holdNextAuth = false;
        authReturned();
        await authGate;
      }
      return result;
    });
    const selfRequest = server.app.inject({ method: 'GET', url: '/api/v1/device/self', headers: { authorization: `Bearer ${tokenSecret}` } });
    await authDone;
    const deletion = await server.app.inject({
      method: 'DELETE', url: `/api/v1/vaults/${vaultId}`, headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    releaseAuth();
    const selfResponse = await selfRequest;
    mutateSpy.mockRestore();
    expect([404, 409]).toContain(selfResponse.statusCode);
    expect(JSON.stringify(selfResponse.json())).not.toContain('self device');
  });

  it('lets queued sync admission lose to deletion after the lock holder drains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-sync-lock-deletion-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    const { vaultId } = await createSessionVault(server, 'sync lock');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = server.sync.runWithVaultLock(vaultId, async () => await held);
    await sleep(10);
    const queued = server.sync.runWithVaultLock(vaultId, async () => undefined);
    const db = await server.store.snapshot();
    const user = db.users[0];
    if (!user) throw new Error('sync lock user missing');
    const deletion = server.lifecycle.beginDeletion({ ownerUserId: user.user_id, vaultId, confirmation: `DELETE ${vaultId}` });
    await sleep(20);
    release();
    await first;
    await expect(queued).rejects.toMatchObject({ code: 'vault_deleting' });
    await deletion;
  });

  it('keeps invalid receipts discoverable without throwing or reopening admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-receipt-invalid-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'hardening-test-session-secret' });
    servers.push(server);
    await server.store.mutate((db) => {
      db.deletion_receipts.push({
        vault_id: 'vlt_invalid_receipt', owner_user_id: 'usr_owner', requested_at: new Date().toISOString(),
        completed_at: 'not-a-timestamp', status: 'deleted'
      });
    });
    await server.lifecycle.expireReceipts();
    expect(server.lifecycle.isReady()).toBe(false);
    const receipt = await server.lifecycle.getDeletion('usr_owner', 'vlt_invalid_receipt');
    expect(receipt).toMatchObject({ status: 'deleted', receipt_expires_at: null, error_code: 'metadata_unavailable' });
    await expect(server.lifecycle.acquireAdmission('vlt_invalid_receipt')).rejects.toMatchObject({ code: 'vault_deleting' });
  });
});
