import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChunkTransferService } from '../src/server/chunkTransferService.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { createServerConfig, ensureServerDirectories } from '../src/server/config.js';
import { GitService } from '../src/server/gitService.js';
import { SyncService } from '../src/server/syncService.js';
import { API_VERSION, type ChunkPushCreateRequest, type DevicePushManifest, type PushResult } from '../src/shared/types.js';
import { hashToken } from '../src/server/authService.js';
import type { AuthenticatedDevice } from '../src/server/authService.js';
import { writeDurableFile, type DurableFilePersistence } from '../src/server/durableFile.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('transfer durable state publication', () => {
  it('returns typed transfer_unavailable for legacy push durability failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-legacy-push-unavailable-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'legacy-push-unavailable-secret' });
    servers.push(server);
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'legacy push unavailable' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const timestamp = new Date().toISOString();
    const deviceToken = 'legacy-push-device-token';
    const tokenHash = hashToken(deviceToken);
    await server.store.mutate((db) => {
      const user = db.users[0];
      const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
      if (!user || !vault) throw new Error('legacy push fixture missing');
      db.devices.push({
        device_id: 'dev_legacy_push', vault_id: vaultId, user_id: user.user_id, device_name: 'legacy push device',
        device_ref: 'refs/obts/devices/dev_legacy_push', device_ref_head: null, status: 'synced',
        last_applied_main: vault.current_main, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
        pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
        last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
        local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
        last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'initialize', initial_proposal_kind: null,
        initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: timestamp,
        created_at: timestamp, revoked_at: null
      });
      db.tokens.push({
        token_id: 'tok_legacy_push', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
        user_id: user.user_id, vault_id: vaultId, device_id: 'dev_legacy_push', expires_at: null,
        consumed_at: null, failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp
      });
    });
    (server.git as unknown as { durabilityUncertain: boolean }).durabilityUncertain = true;
    const boundary = '----obts-legacy-push-unavailable';
    const manifest = JSON.stringify({
      api_version: API_VERSION,
      plugin_version: '0.4.36',
      vault_id: vaultId,
      device_id: 'dev_legacy_push',
      expected_device_ref: null,
      target_commit: (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === vaultId)!.current_main,
      packfile_sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      packfile_bytes: 0,
      client_known_main: (await server.store.snapshot()).vaults.find((vault) => vault.vault_id === vaultId)!.current_main
    });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vaultId}/sync/push`,
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'transfer_unavailable', message: 'Transfer storage is unavailable.' } });
    const pullChunk = await server.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${vaultId}/sync/pull-chunk`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        api_version: API_VERSION,
        plugin_version: '0.4.36',
        vault_id: vaultId,
        device_id: 'dev_legacy_push',
        current_local_main: null,
        requested_target: 'latest',
        current_event_seq: 0,
        cursor: 0
      }
    });
    expect(pullChunk.statusCode).toBe(503);
    expect(pullChunk.json()).toMatchObject({ error: { code: 'transfer_unavailable', message: 'Transfer storage is unavailable.' } });
  });

  it('keeps ordinary transfer admission available for review-state devices while rejecting a deleting lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-admission-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    let blocked = false;
    const lifecycle = {
      isBlocked: () => blocked,
      withAdmission: async (_vaultId: string, operation: () => Promise<unknown>) => await operation()
    };
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never, lifecycle as never);
    const auth = syntheticAuth();
    auth.device.status = 'review_needed';
    const request = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-admission-review',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    } satisfies ChunkPushCreateRequest;
    await expect(service.createPush(auth, request)).resolves.toMatchObject({ created: true });
    blocked = true;
    await expect(service.createPush(auth, { ...request, attempt_id: 'attempt-admission-deleting' })).rejects.toMatchObject({
      code: 'not_found'
    });
    await service.close();
  });

  it('orders owner/session publication around file and directory fsyncs through creation, receipt, and async finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-durable-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const events: string[] = [];
    const persistence = tracedPersistence(events);
    const finalize = deferred<PushResult>();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true }),
      importPackIntoRepo: async () => undefined,
      readerForRepo: () => ({}) as never,
      promoteTransferObjects: async () => undefined
    };
    const sync = { pushDeviceCommit: async () => await finalize.promise };
    const service = new ChunkTransferService(config, git as never, sync as never, undefined, persistence);
    const auth = syntheticAuth();
    const request: ChunkPushCreateRequest = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-durable-state',
      chunk_count: 1,
      plan_sha256: 'b'.repeat(64)
    };

    const created = await service.createPush(auth, request);
    const transferId = created.descriptor.transfer_id;
    const data = Buffer.from('synthetic transfer chunk');
    const digest = 'c'.repeat(64);
    await service.putChunk(auth, transferId, 0, data, digest).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('digest')) throw error;
    });
    const actualDigest = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
    await service.putChunk(auth, transferId, 0, data, actualDigest);
    const processing = await service.beginFinalizePush(auth, transferId);
    expect(processing).toBeDefined();
    expect(processing.status).toBe('processing');
    await new Promise<void>((resolve) => setImmediate(resolve));
    finalize.resolve({ status: 'noop', device_ref: 'refs/obts/devices/dev_test', main: 'd'.repeat(40), event_seq: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.close();

    const state = JSON.parse(await readFile(join(config.transferDir, transferId, 'session.json'), 'utf8')) as { status: string };
    expect(state.status).toBe('completed');
    expect(publicationSequences(events).every((sequence) => sequence.join(',') === 'write,file-fsync,rename,dir-fsync')).toBe(true);
    expect(events.filter((event) => event.startsWith('write:'))).toHaveLength(5);
  });

  it('flushes repository initialization and rejects promotion before source durability is confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-git-durable-boundary-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const events: string[] = [];
    const git = new GitService(config, tracedPersistence(events));
    const vaultId = 'vlt_durable_git';
    const rootCommit = await git.initializeVault(vaultId);
    expect(rootCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(events.some((event) => event.startsWith('file-fsync:'))).toBe(true);
    expect(events.some((event) => event.startsWith('dir-fsync:'))).toBe(true);
    const importedRepo = join(config.transferDir, 'trn_import', 'repo.git');
    await git.initializeTransferRepo(vaultId, importedRepo);
    await git.importPackIntoRepo(importedRepo, await git.exportPack(vaultId, rootCommit, null), join(config.gitStoreDir, `${vaultId}.git`, 'objects'));

    const transferRepo = join(config.transferDir, 'trn_durable', 'repo.git');
    await mkdir(join(transferRepo, 'objects', 'pack'), { recursive: true });
    const packName = `pack-${'a'.repeat(40)}.pack`;
    await writeFile(join(transferRepo, 'objects', 'pack', packName), 'synthetic pack');
    const failingGit = new GitService(config, { fsyncFile: async () => { throw new Error('synthetic repo fsync failure'); } });
    await expect(failingGit.promoteTransferObjects(vaultId, transferRepo)).rejects.toThrow('Git repository durability could not be confirmed.');
    await expect(lstat(join(config.gitStoreDir, `${vaultId}.git`, 'objects', 'pack', packName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(failingGit.isDurabilityUnavailable()).toBe(true);
    expect(await failingGit.checkReady()).toMatchObject({ ok: false, error: 'Git repository durability is uncertain' });
    await expect(failingGit.exec(join(config.gitStoreDir, `${vaultId}.git`), ['fsck']))
      .rejects.toThrow('Git repository durability could not be confirmed.');

    const auth = syntheticAuth();
    const request: ChunkPushCreateRequest = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-git-durability-barrier',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    };
    const transfers = new ChunkTransferService(config, failingGit, {} as never);
    await expect(transfers.createPush(auth, request)).rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    await expect(transfers.getPush(auth, 'trn_missing')).rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    await expect(transfers.putChunk(auth, 'trn_missing', 0, Buffer.from('chunk'), 'c'.repeat(64)))
      .rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    await expect(transfers.beginFinalizePush(auth, 'trn_missing')).rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    await expect(transfers.finalizePush(auth, 'trn_missing')).rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    await expect(transfers.deletePush(auth, 'trn_missing')).rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    const sync = new SyncService({} as never, failingGit, config.maxUploadBytes);
    const manifest: DevicePushManifest = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      packfile_sha256: 'd'.repeat(64),
      packfile_bytes: 0,
      client_known_main: null,
      attempt_id: 'attempt-git-durability-integration'
    };
    await expect(sync.pushDeviceCommit(auth, manifest, Buffer.alloc(0)))
      .rejects.toMatchObject({ statusCode: 503, code: 'transfer_unavailable' });
    expect(transfers.isReady()).toBe(false);
    await transfers.close();
  });

  it('rejects extra and nested canonical Git symlinks before command use while preserving regular layout entries', async () => {
    const cases = [
      ['hooks', ['hooks', 'custom']],
      ['objects-prefix', ['objects', 'aa']],
      ['objects-info-alternates', ['objects', 'info', 'alternates']],
      ['nested-refs', ['refs', 'heads', 'extra']]
    ] as const;
    for (const [label, pathParts] of cases) {
      const root = await mkdtemp(join(tmpdir(), `obts-git-nested-symlink-${label}-`));
      roots.push(root);
      const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
      await ensureServerDirectories(config);
      const git = new GitService(config);
      const vaultId = `vlt_${label.replaceAll('-', '_')}`;
      await git.initializeVault(vaultId);
      const repo = git.repoPath(vaultId);
      await mkdir(join(repo, 'regular-extra'), { recursive: true });
      await writeFile(join(repo, 'regular-extra', 'entry'), 'regular');
      expect(await git.isBareRepositoryShape(repo)).toBe(true);
      const outside = join(root, 'outside');
      await mkdir(outside, { recursive: true });
      let symlinkParts: string[] = [...pathParts];
      if (label === 'objects-prefix') {
        for (const prefix of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff']) {
          try {
            await lstat(join(repo, 'objects', prefix));
          } catch {
            symlinkParts = ['objects', prefix];
            break;
          }
        }
      }
      await symlink(outside, join(repo, ...symlinkParts));
      expect(await git.isBareRepositoryShape(repo)).toBe(false);
      await expect(git.exec(repo, ['fsck'])).rejects.toThrow('Git repository is not a safe bare repository.');
    }
  });

  it('fails readiness closed when the transfer root disappears after startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-root-missing-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const service = new ChunkTransferService(config, {} as never, {} as never);
    await service.initialize();
    await rm(config.transferDir, { recursive: true, force: true });
    expect(await service.checkReady()).toMatchObject({ ok: false });
    expect(service.isReady()).toBe(false);
  });

  it('fails full-server readiness closed without recreating an established transfer root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-root-startup-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const first = await createObtsServer({ dataDir, sessionSecret: 'startup-transfer-root-secret' });
    servers.push(first);
    await first.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);
    await rm(join(dataDir, 'transfers'), { recursive: true, force: true });
    const restarted = await createObtsServer({ dataDir, sessionSecret: 'startup-transfer-root-secret' });
    servers.push(restarted);
    expect(await lstat(join(dataDir, 'transfers')).catch((error: unknown) => error)).toMatchObject({ code: 'ENOENT' });
    const readiness = await restarted.app.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ checks: { persistent_state: false } });
  });

  it('rejects symlink, non-directory, and malformed canonical Git children before readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-git-child-validation-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const git = new GitService(config);
    await symlink(join(root, 'outside'), join(config.gitStoreDir, 'vlt_symlink.git'));
    await expect(git.listVaultRepositoryIds()).rejects.toThrow();
    await rm(join(config.gitStoreDir, 'vlt_symlink.git'), { force: true });
    await writeFile(join(config.gitStoreDir, 'vlt_file.git'), 'not a repository');
    await expect(git.listVaultRepositoryIds()).rejects.toThrow();
    await rm(join(config.gitStoreDir, 'vlt_file.git'), { force: true });
    await mkdir(join(config.gitStoreDir, 'vlt_malformed.git'));
    await expect(git.listVaultRepositoryIds()).rejects.toThrow();
  });

  it('rejects external canonical alternates while allowing validated transfer alternates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-git-alternates-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const git = new GitService(config);
    const vaultId = 'vlt_alternates';
    await git.initializeVault(vaultId);
    const repository = git.repoPath(vaultId);
    const outside = join(root, 'outside-objects');
    await mkdir(outside, { recursive: true });
    const alternates = join(repository, 'objects', 'info', 'alternates');
    await writeFile(alternates, `${outside}\n`);
    expect(await git.isBareRepositoryShape(repository)).toBe(false);
    await expect(git.exec(repository, ['fsck'])).rejects.toThrow('Git repository is not a safe bare repository.');

    await writeFile(alternates, `${join(repository, 'objects')}\n`);
    expect(await git.isBareRepositoryShape(repository)).toBe(true);

    const transferRepository = join(config.transferDir, 'trn_alternates', 'repo.git');
    await git.initializeTransferRepo(vaultId, transferRepository);
    expect(await git.isBareRepositoryShape(transferRepository)).toBe(false);
    expect(await git.checkTransferRepositoryIntegrity(transferRepository, vaultId)).toBe(true);
  });

  it('fails transfer startup closed on repository integrity failure and legacy terminal residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-integrity-validation-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true }),
      checkBareRepositoryIntegrity: async () => false
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const created = await service.createPush(auth, {
      api_version: API_VERSION, vault_id: auth.vault.vault_id, device_id: auth.device.device_id,
      expected_device_ref: null, target_commit: 'a'.repeat(40), client_known_main: null,
      attempt_id: 'attempt-integrity-startup', chunk_count: 0, plan_sha256: 'b'.repeat(64)
    });
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
    delete session.stored_bytes;
    session.status = 'completed';
    session.result = { status: 'noop', device_ref: auth.device.device_ref, main: 'a'.repeat(40), event_seq: 1 };
    session.chunk_count = 1;
    await writeFile(sessionPath, JSON.stringify(session));
    const restarted = new ChunkTransferService(config, git as never, {} as never);
    await restarted.initialize();
    // Readiness reports the unusable quarantine repository, but a legacy session must not disable
    // transfers for every other device on the server.
    expect(restarted.isReady()).toBe(true);
    expect(await restarted.checkReady()).toMatchObject({ ok: false });
    await service.close();
    await restarted.close();
  });

  it('fails readiness closed when legacy transfer bytes exceed bounds without stored-byte accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-legacy-bytes-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576, maxTransferBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const created = await service.createPush(auth, {
      api_version: API_VERSION, vault_id: auth.vault.vault_id, device_id: auth.device.device_id,
      expected_device_ref: null, target_commit: 'a'.repeat(40), client_known_main: null,
      attempt_id: 'attempt-legacy-bytes', chunk_count: 0, plan_sha256: 'b'.repeat(64)
    });
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
    delete session.stored_bytes;
    await writeFile(sessionPath, JSON.stringify(session));
    await writeFile(join(config.transferDir, created.descriptor.transfer_id, 'repo.git', 'oversized'), Buffer.alloc(1_048_577));
    // The deep quarantine audit runs at startup and reports the anomaly without disabling serving.
    const restarted = new ChunkTransferService(config, git as never, {} as never);
    await restarted.initialize();
    expect(await restarted.checkReady()).toMatchObject({ ok: false });
    expect(restarted.isReady()).toBe(true);
    await restarted.close();
    await service.close();
  });

  it('rejects legacy terminal sessions that do not contain complete receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-legacy-receipts-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const created = await service.createPush(auth, {
      api_version: API_VERSION, vault_id: auth.vault.vault_id, device_id: auth.device.device_id,
      expected_device_ref: null, target_commit: 'a'.repeat(40), client_known_main: null,
      attempt_id: 'attempt-legacy-receipts', chunk_count: 1, plan_sha256: 'b'.repeat(64)
    });
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
    delete session.stored_bytes;
    session.status = 'completed';
    session.result = { status: 'noop', device_ref: auth.device.device_ref, main: 'a'.repeat(40), event_seq: 1 };
    await writeFile(sessionPath, JSON.stringify(session));
    expect(await service.checkReady()).toMatchObject({ ok: false });
    expect(service.isReady()).toBe(true);
    await service.close();
  });

  it('counts nested owner and session state names as transfer material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-nested-state-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const created = await service.createPush(auth, {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-nested-state-names',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    });
    const nestedDirectory = join(config.transferDir, created.descriptor.transfer_id, 'repo.git', 'nested');
    await mkdir(nestedDirectory, { recursive: true });
    const nestedFiles = [
      ['owner.json', 'nested owner'],
      ['session.json', 'nested session']
    ] as const;
    let nestedBytes = 0;
    for (const [name, contents] of nestedFiles) {
      await writeFile(join(nestedDirectory, name), contents);
      nestedBytes += Buffer.byteLength(contents);
    }
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as { stored_bytes: number };
    session.stored_bytes += nestedBytes;
    await writeFile(sessionPath, JSON.stringify(session));
    await expect(service.getPush(auth, created.descriptor.transfer_id)).resolves.toMatchObject({
      transfer_id: created.descriptor.transfer_id,
      status: 'open'
    });
    await service.close();
  });

  it('fails readiness closed when persisted stored-byte accounting disagrees with transfer material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-accounting-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const request: ChunkPushCreateRequest = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-accounting',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    };
    const created = await service.createPush(auth, request);
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as { stored_bytes: number };
    session.stored_bytes += 1;
    await writeFile(sessionPath, JSON.stringify(session));
    const restarted = new ChunkTransferService(config, git as never, {} as never);
    await restarted.initialize();
    // Drift is repaired from on-disk material and persisted, so readiness is healthy afterwards.
    expect(await restarted.checkReady()).toMatchObject({ ok: true });
    expect(restarted.isReady()).toBe(true);
    const repaired = JSON.parse(await readFile(sessionPath, 'utf8')) as { stored_bytes: number };
    expect(repaired.stored_bytes).toBe(session.stored_bytes - 1);
    await restarted.close();
    await service.close();
  });

  it('rejects semantically inconsistent terminal transfer results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-semantic-session-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const created = await service.createPush(auth, {
      api_version: API_VERSION, vault_id: auth.vault.vault_id, device_id: auth.device.device_id,
      expected_device_ref: null, target_commit: 'a'.repeat(40), client_known_main: null,
      attempt_id: 'attempt-semantic', chunk_count: 0, plan_sha256: 'b'.repeat(64)
    });
    const sessionPath = join(config.transferDir, created.descriptor.transfer_id, 'session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
    session.status = 'completed';
    session.result = { status: 'merged', device_ref: auth.device.device_ref, main: 'a'.repeat(40), event_seq: 1 };
    await writeFile(sessionPath, JSON.stringify(session));
    expect(await service.checkReady()).toMatchObject({ ok: false });
    expect(service.isReady()).toBe(true);
    await service.close();
  });

  it('resumes a validated persisted processing session during initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-resume-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    const auth = syntheticAuth();
    const transferId = 'trn_resume';
    const timestamp = new Date().toISOString();
    const request: ChunkPushCreateRequest = {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-resume',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    };
    const transferDir = join(config.transferDir, transferId);
    await mkdir(join(transferDir, 'repo.git'), { recursive: true });
    await writeFile(join(transferDir, 'owner.json'), JSON.stringify({ vault_id: auth.vault.vault_id }));
    await writeFile(join(transferDir, 'session.json'), JSON.stringify({
      version: 1,
      transfer_id: transferId,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      attempt_id: request.attempt_id,
      request_sha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      manifest: {
        api_version: API_VERSION,
        vault_id: auth.vault.vault_id,
        device_id: auth.device.device_id,
        expected_device_ref: null,
        target_commit: request.target_commit,
        packfile_sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        packfile_bytes: 0,
        client_known_main: null,
        attempt_id: request.attempt_id
      },
      plan_sha256: request.plan_sha256,
      chunk_count: 0,
      receipts: [],
      total_bytes: 0,
      stored_bytes: 0,
      status: 'processing',
      result: null,
      processing_attempts: 0,
      processing_error_code: null,
      retry_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }));
    const git = {
      readerForRepo: () => ({}) as never,
      promoteTransferObjects: async () => undefined
    };
    const sync = {
      pushDeviceCommit: async () => ({ status: 'noop' as const, device_ref: auth.device.device_ref, main: 'd'.repeat(40), event_seq: 1 })
    };
    const service = new ChunkTransferService(config, git as never, sync as never);
    await service.initialize(async () => auth);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = JSON.parse(await readFile(join(transferDir, 'session.json'), 'utf8')) as { status: string };
      if (state.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(JSON.parse(await readFile(join(transferDir, 'session.json'), 'utf8'))).toMatchObject({ status: 'completed' });
    await service.close();
  });

  it('retains an ambiguous rename candidate instead of guessing the published state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-rename-fault-'));
    roots.push(root);
    const destination = join(root, 'session.json');
    await writeFile(destination, 'old\n');
    let temporary = '';
    await expect(writeDurableFile(destination, 'new\n', {
      writeFile: async (path, data) => {
        temporary = path;
        await writeFile(path, data, { mode: 0o600, flag: 'wx' });
      },
      rename: async () => { throw new Error('synthetic ambiguous transfer rename'); }
    })).rejects.toThrow('synthetic ambiguous transfer rename');
    expect(await readFile(destination, 'utf8')).toBe('old\n');
    expect(temporary).not.toBe('');
    expect(await readdir(root)).toContain(basename(temporary));
  });

  it('fails closed when owner publication cannot be file-synced and leaves no published owner marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-owner-fault-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    let failFileSync = true;
    const persistence: Partial<DurableFilePersistence> = {
      fsyncFile: async (path) => {
        if (failFileSync) throw new Error('synthetic transfer file fsync failure');
        const file = await open(path, 'r');
        try { await file.sync(); } finally { await file.close(); }
      }
    };
    const git = {
      getRef: async () => null,
      commitExists: async () => false,
      isAncestor: async () => false,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true })
    };
    const service = new ChunkTransferService(config, git as never, {} as never, undefined, persistence);
    const auth = syntheticAuth();
    await expect(service.createPush(auth, {
      api_version: API_VERSION,
      vault_id: auth.vault.vault_id,
      device_id: auth.device.device_id,
      expected_device_ref: null,
      target_commit: 'a'.repeat(40),
      client_known_main: null,
      attempt_id: 'attempt-owner-fault',
      chunk_count: 0,
      plan_sha256: 'b'.repeat(64)
    })).rejects.toThrow('synthetic transfer file fsync failure');
    expect(service.isReady()).toBe(false);
    const transferEntries = await readdir(config.transferDir);
    expect(transferEntries).toHaveLength(1);
    const transferDir = join(config.transferDir, transferEntries[0]!);
    expect(await readdir(transferDir)).not.toContain('owner.json');
    expect((await readdir(transferDir)).some((entry) => entry.includes('.tmp-'))).toBe(false);
    failFileSync = false;
  });
});

function syntheticAuth(): AuthenticatedDevice {
  const timestamp = new Date().toISOString();
  return {
    user: {
      user_id: 'usr_test', username: 'test', display_name: 'Test', password_hash: {} as never,
      is_admin: true, disabled: false, created_at: timestamp, last_login_at: null
    },
    vault: {
      vault_id: 'vlt_test', owner_user_id: 'usr_test', display_name: 'Test', status: 'active',
      root_commit: 'a'.repeat(40), current_main: 'a'.repeat(40), created_at: timestamp, updated_at: timestamp
    },
    device: {
      device_id: 'dev_test', vault_id: 'vlt_test', user_id: 'usr_test', device_name: 'Test',
      device_ref: 'refs/obts/devices/dev_test', device_ref_head: null, status: 'synced',
      last_applied_main: null, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: timestamp, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'initialize',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    },
    token: {} as never
  };
}

function tracedPersistence(events: string[]): Partial<DurableFilePersistence> {
  return {
    writeFile: async (path, data) => {
      events.push(`write:${basename(path)}`);
      await writeFile(path, data, { mode: 0o600, flag: 'wx' });
    },
    fsyncFile: async (path) => {
      events.push(`file-fsync:${basename(path)}`);
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
    },
    rename: async (source, destination) => {
      events.push(`rename:${basename(destination)}`);
      await rename(source, destination);
    },
    fsyncDirectory: async (path) => {
      events.push(`dir-fsync:${basename(path)}`);
      const directory = await open(path, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    },
    remove: async (path) => await rm(path, { force: true })
  };
}

function publicationSequences(events: string[]): string[][] {
  const sequences: string[][] = [];
  let current: string[] = [];
  for (const event of events) {
    const action = event.slice(0, event.indexOf(':'));
    if (action === 'write') {
      if (current.length > 0) sequences.push(current);
      current = ['write'];
      continue;
    }
    if (action === 'file-fsync' && current.length >= 4) {
      sequences.push(current);
      current = [];
      continue;
    }
    if (current.length > 0 && (action === 'file-fsync' || action === 'rename' || action === 'dir-fsync')) current.push(action);
  }
  if (current.length > 0) sequences.push(current);
  return sequences;
}
