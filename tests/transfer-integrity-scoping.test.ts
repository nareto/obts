import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChunkTransferService } from '../src/server/chunkTransferService.js';
import { createServerConfig, ensureServerDirectories, type ServerConfig } from '../src/server/config.js';
import { GitService } from '../src/server/gitService.js';
import type { AuthenticatedDevice } from '../src/server/authService.js';
import { API_VERSION, type ChunkPushCreateRequest } from '../src/shared/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

interface Fixture {
  config: ServerConfig;
  git: GitService;
  canonicalIntegrityChecks: () => number;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-transfer-integrity-scoping-'));
  roots.push(root);
  const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
  await ensureServerDirectories(config);
  const realGit = new GitService(config);
  let canonicalChecks = 0;
  const git = Object.create(realGit) as GitService;
  Object.defineProperty(git, 'checkIntegrity', {
    enumerable: true,
    value: async (vaultId: string) => {
      canonicalChecks += 1;
      return await GitService.prototype.checkIntegrity.call(realGit, vaultId);
    }
  });
  return { config, git, canonicalIntegrityChecks: () => canonicalChecks };
}

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

function request(auth: AuthenticatedDevice, attemptId: string, chunkCount = 0): ChunkPushCreateRequest {
  return {
    api_version: API_VERSION,
    vault_id: auth.vault.vault_id,
    device_id: auth.device.device_id,
    expected_device_ref: null,
    target_commit: 'a'.repeat(40),
    client_known_main: 'a'.repeat(40),
    attempt_id: `attempt-${attemptId}`,
    chunk_count: chunkCount,
    plan_sha256: createHash('sha256').update(attemptId).digest('hex')
  };
}

async function ownPackPath(repoDir: string): Promise<string> {
  const packDir = join(repoDir, 'objects', 'pack');
  const entries = await readdir(packDir);
  const packName = entries.find((name) => /^pack-[0-9a-f]{40}\.pack$/u.test(name));
  if (!packName) throw new Error('fixture produced no own pack');
  return join(packDir, packName);
}

async function corruptFirstCanonicalObject(config: ServerConfig, vaultId: string): Promise<void> {
  const vaultObjects = join(config.gitStoreDir, `${vaultId}.git`, 'objects');
  for (const objectDir of (await readdir(vaultObjects)).filter((name) => /^[0-9a-f]{2}$/u.test(name))) {
    for (const name of await readdir(join(vaultObjects, objectDir))) {
      if (!/^[0-9a-f]{38}$/u.test(name)) continue;
      const objectPath = join(vaultObjects, objectDir, name);
      const bytes = await readFile(objectPath);
      if (bytes.byteLength === 0) continue;
      await chmod(objectPath, 0o600);
      bytes[0] = bytes[0]! ^ 0xff;
      await writeFile(objectPath, bytes, { mode: 0o444 });
      return;
    }
  }
  throw new Error('fixture produced no canonical loose object');
}

describe('transfer quarantine integrity scoping', () => {
  it('rejects a corrupted own pack at serving time without walking the canonical store', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    const rootCommit = await fixture.git.initializeVault(auth.vault.vault_id);

    const created = await service.createPush(auth, request(auth, 'corrupt-own'));
    const transferId = created.descriptor.transfer_id;
    const repoDir = join(fixture.config.transferDir, transferId, 'repo.git');
    const packfile = await fixture.git.exportPack(auth.vault.vault_id, rootCommit, null);
    await fixture.git.importPackIntoRepo(
      repoDir,
      packfile,
      join(fixture.config.gitStoreDir, `${auth.vault.vault_id}.git`, 'objects')
    );

    // Healthy own material serves, and the serving read leaves no anomaly behind.
    await expect(service.getPush(auth, transferId)).resolves.toBeDefined();
    expect(service.transferAnomalyReason()).toBeNull();

    // Corrupt the session's own packfile after ingest.
    const packPath = await ownPackPath(repoDir);
    const bytes = await readFile(packPath);
    await chmod(packPath, 0o600);
    bytes[Math.floor(bytes.byteLength / 2)] = (bytes[Math.floor(bytes.byteLength / 2)] ?? 0) ^ 0xff;
    await writeFile(packPath, bytes, { mode: 0o444 });

    await expect(service.getPush(auth, transferId)).rejects.toMatchObject({
      statusCode: 503,
      code: 'transfer_unavailable'
    });
    expect(service.transferAnomalyReason()).toBe(`transfer_repository_unusable:${transferId}`);
    await service.close();
  });

  it('rejects unexpected loose-object material that the ingestion path never writes', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    await fixture.git.initializeVault(auth.vault.vault_id);

    const created = await service.createPush(auth, request(auth, 'loose'));
    const transferId = created.descriptor.transfer_id;
    const looseDir = join(fixture.config.transferDir, transferId, 'repo.git', 'objects', 'ab');
    await mkdir(looseDir, { recursive: true });
    await writeFile(join(looseDir, 'c'.repeat(38)), 'unexpected loose material');

    await expect(service.getPush(auth, transferId)).rejects.toMatchObject({ code: 'transfer_unavailable' });
    expect(service.transferAnomalyReason()).toBe(`transfer_repository_unusable:${transferId}`);
    await service.close();
  });

  it('rejects a packfile without an index and an index without its packfile', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    await fixture.git.initializeVault(auth.vault.vault_id);

    const created = await service.createPush(auth, request(auth, 'pairing'));
    const transferId = created.descriptor.transfer_id;
    const packDir = join(fixture.config.transferDir, transferId, 'repo.git', 'objects', 'pack');
    await writeFile(join(packDir, `pack-${'b'.repeat(40)}.pack`), 'unindexed residue');
    await expect(service.getPush(auth, transferId)).rejects.toMatchObject({ code: 'transfer_unavailable' });

    await rm(join(packDir, `pack-${'b'.repeat(40)}.pack`), { force: true });
    await writeFile(join(packDir, `pack-${'c'.repeat(40)}.idx`), 'orphaned index');
    await expect(service.getPush(auth, transferId)).rejects.toMatchObject({ code: 'transfer_unavailable' });
    expect(service.transferAnomalyReason()).toBe(`transfer_repository_unusable:${transferId}`);
    await service.close();
  });

  it('does not refuse an open transfer when the canonical store is corrupt, and flags it once at startup', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    await fixture.git.initializeVault(auth.vault.vault_id);

    const created = await service.createPush(auth, request(auth, 'canonical-scoping'));
    const transferId = created.descriptor.transfer_id;
    await corruptFirstCanonicalObject(fixture.config, auth.vault.vault_id);

    // A serving read must not walk the canonical object store.
    await expect(service.getPush(auth, transferId)).resolves.toBeDefined();
    expect(service.transferAnomalyReason()).toBeNull();
    expect(fixture.canonicalIntegrityChecks()).toBe(0);

    // The startup deep audit verifies the owning vault's canonical store once and records the
    // anomaly without disabling transfer serving.
    const restarted = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    await restarted.initialize();
    expect(fixture.canonicalIntegrityChecks()).toBe(1);
    expect(await restarted.checkReady()).toMatchObject({
      ok: false,
      error: `transfer storage anomaly: canonical_repository_unusable:${auth.vault.vault_id}`
    });
    expect(restarted.isReady()).toBe(true);
    await service.close();
    await restarted.close();
  });

  it('verifies each owning vault canonical store once for many sessions at startup', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    await fixture.git.initializeVault(auth.vault.vault_id);
    for (const index of [1, 2]) {
      await service.createPush(auth, request(auth, `hoist-${index}`));
    }

    const restarted = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    await restarted.initialize();
    expect(fixture.canonicalIntegrityChecks()).toBe(1);
    expect(await restarted.checkReady()).toEqual({ ok: true });
    await service.close();
    await restarted.close();
  });

  it('skips the canonical verification when the startup audit finds no sessions', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    await service.initialize();
    expect(fixture.canonicalIntegrityChecks()).toBe(0);
    expect(await service.checkReady()).toEqual({ ok: true });
    await service.close();
  });

  it('exposes bounded integrity and lifecycle counters for diagnostics', async () => {
    const fixture = await createFixture();
    const service = new ChunkTransferService(fixture.config, fixture.git, {} as never);
    const auth = syntheticAuth();
    const rootCommit = await fixture.git.initializeVault(auth.vault.vault_id);

    const created = await service.createPush(auth, request(auth, 'metrics', 1));
    const transferId = created.descriptor.transfer_id;
    await service.getPush(auth, transferId);
    const packfile = await fixture.git.exportPack(auth.vault.vault_id, rootCommit, null);
    await service.putChunk(auth, transferId, 0, packfile, createHash('sha256').update(packfile).digest('hex'));

    const transferMetrics = service.transferMetricsSnapshot();
    expect(transferMetrics.phases.create.count).toBe(1);
    expect(transferMetrics.phases.create.total_ms).toBeGreaterThanOrEqual(0);
    expect(transferMetrics.phases.chunk.count).toBe(1);
    expect(transferMetrics.phases.chunk.total_ms).toBeGreaterThanOrEqual(0);
    expect(transferMetrics.phases.finalize.count).toBe(0);
    expect(transferMetrics.phases.process.count).toBe(0);

    const before = fixture.git.integrityMetricsSnapshot();
    await fixture.git.checkIntegrity(auth.vault.vault_id);
    const after = fixture.git.integrityMetricsSnapshot();
    expect(after.full_fsck_checks).toBe(before.full_fsck_checks + 1);
    expect(after.full_fsck_total_ms).toBeGreaterThanOrEqual(before.full_fsck_total_ms);
    expect(after.quarantine_checks).toBeGreaterThanOrEqual(1);
    expect(after.quarantine_total_ms).toBeGreaterThanOrEqual(0);
    await service.close();
  });
});
