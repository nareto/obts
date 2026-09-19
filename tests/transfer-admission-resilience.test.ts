import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChunkTransferService } from '../src/server/chunkTransferService.js';
import { createServerConfig, ensureServerDirectories } from '../src/server/config.js';
import { API_VERSION, type ChunkPushCreateRequest } from '../src/shared/types.js';
import type { AuthenticatedDevice } from '../src/server/authService.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('transfer admission resilience against legacy and anomalous state', () => {
  it('adopts a session record written before ownership markers existed', async () => {
    const fixture = await createFixture();
    const transferId = await createTransfer(fixture, 'legacy-owner-marker', 1);
    // The previous release wrote session.json but no ownership marker.
    await rm(join(fixture.config.transferDir, transferId, 'owner.json'), { force: true });

    const restarted = restart(fixture);
    await restarted.initialize();

    expect(restarted.isReady()).toBe(true);
    expect(restarted.transferAnomalyReason()).toBe(`transfer_session_ownership_adopted:${transferId}`);
    const marker = JSON.parse(await readFile(join(fixture.config.transferDir, transferId, 'owner.json'), 'utf8')) as { vault_id: string };
    expect(marker.vault_id).toBe(fixture.auth.vault.vault_id);
    await expect(restarted.getPush(fixture.auth, transferId)).resolves.toMatchObject({ transfer_id: transferId });
  });

  it('reports an unusable quarantine repository without disabling transfers', async () => {
    const fixture = await createFixture();
    const broken = await createTransfer(fixture, 'readiness-probe-broken', 1);
    await rm(join(fixture.config.transferDir, broken, 'repo.git'), { recursive: true, force: true });

    // Readiness reports the inconsistency, but the probe must not change serving availability.
    await expect(fixture.service.checkReady()).resolves.toMatchObject({
      ok: false,
      error: `transfer storage anomaly: transfer_repository_unusable:${broken}`
    });
    expect(fixture.service.isReady()).toBe(true);

    // Other transfers keep working; only the unusable transfer is refused.
    await expect(createTransfer(fixture, 'readiness-probe-healthy', 1)).resolves.toBeTypeOf('string');
    await expect(fixture.service.getPush(fixture.auth, broken)).rejects.toMatchObject({
      statusCode: 503,
      code: 'transfer_unavailable'
    });
    expect(fixture.service.isReady()).toBe(true);
  });

  it('still allows a device to remove a transfer whose quarantine repository is unusable', async () => {
    const fixture = await createFixture();
    const broken = await createTransfer(fixture, 'removal-broken-repo', 1);
    await rm(join(fixture.config.transferDir, broken, 'repo.git'), { recursive: true, force: true });

    await expect(fixture.service.deletePush(fixture.auth, broken)).resolves.toBeUndefined();
    expect(await exists(join(fixture.config.transferDir, broken))).toBe(false);
  });

  it('repairs persisted accounting drift instead of refusing every transfer', async () => {
    const fixture = await createFixture();
    const transferId = await createTransfer(fixture, 'accounting-drift', 1);
    await fixture.service.putChunk(fixture.auth, transferId, 0, Buffer.from('chunk'), sha256('chunk'));
    const path = join(fixture.config.transferDir, transferId, 'session.json');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { stored_bytes: number };
    persisted.stored_bytes = persisted.stored_bytes + 4096;
    await writeFile(path, `${JSON.stringify(persisted)}\n`);

    const restarted = restart(fixture);
    await restarted.initialize();

    expect(restarted.isReady()).toBe(true);
    expect(restarted.transferAnomalyReason()).toBe(`transfer_session_accounting_mismatch:${transferId}`);
    await expect(restarted.checkReady()).resolves.toMatchObject({
      ok: false,
      error: `transfer storage anomaly: transfer_session_accounting_mismatch:${transferId}`
    });
    await expect(restarted.getPush(fixture.auth, transferId)).resolves.toMatchObject({ transfer_id: transferId });
  });

  it('never resumes an inconsistent processing session and keeps other transfers available', async () => {
    const fixture = await createFixture();
    const transferId = await createTransfer(fixture, 'processing-inconsistent', 2);
    const path = join(fixture.config.transferDir, transferId, 'session.json');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { status: string; retry_at: string | null };
    // A processing record without complete receipts is refused by the session parser, so it can
    // never be resumed. It must not disable transfers for the whole server either.
    persisted.status = 'processing';
    persisted.retry_at = new Date().toISOString();
    await writeFile(path, `${JSON.stringify(persisted)}\n`);

    const restarted = restart(fixture);
    await restarted.initialize();

    expect(restarted.isReady()).toBe(true);
    expect(restarted.transferAnomalyReason()).toBe(`transfer_session_unusable:${transferId}`);
    await expect(restarted.getPush(fixture.auth, transferId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(createTransfer(fixture, 'processing-inconsistent-follow-up', 1)).resolves.toBeTypeOf('string');
  });

  it('ignores foreign transfer-root residue without disabling ordinary transfers', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.config.transferDir, 'scratch-leftover'), { recursive: true });
    await mkdir(join(fixture.config.transferDir, 'trn_not-a-session'), { recursive: true });

    const restarted = restart(fixture);
    await restarted.initialize();

    // Residue this server cannot read as one of its own sessions is not an integrity problem for
    // its own state: it is ignored and does not even raise a readiness anomaly.
    expect(restarted.isReady()).toBe(true);
    expect(restarted.transferAnomalyReason()).toBeNull();
    await expect(restarted.checkReady()).resolves.toEqual({ ok: true });
    await expect(createTransfer(fixture, 'residue-follow-up', 1)).resolves.toBeTypeOf('string');
  });

  it('still suspends transfer storage when a durable write itself fails', async () => {
    const fixture = await createFixture();
    const failing = {
      readDirectory: async (path: string) => await (await import('node:fs/promises')).readdir(path),
      writeFile: async () => { throw new Error('synthetic durable write failure'); },
      fsyncFile: async () => undefined,
      rename: async () => { throw new Error('synthetic durable write failure'); },
      fsyncDirectory: async () => undefined,
      remove: async () => undefined
    };
    const service = new ChunkTransferService(
      fixture.config,
      fixture.git as never,
      {} as never,
      undefined,
      failing as never
    );

    await expect(service.createPush(fixture.auth, request(fixture.auth, 'durable-write-failure', 1))).rejects.toThrow(
      'synthetic durable write failure'
    );
    expect(service.isReady()).toBe(false);
  });
});

type Fixture = {
  config: ReturnType<typeof createServerConfig>;
  service: ChunkTransferService;
  git: Record<string, unknown>;
  auth: AuthenticatedDevice;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-transfer-resilience-'));
  roots.push(root);
  const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
  await ensureServerDirectories(config);
  const git = {
    getRef: async () => null,
    commitExists: async () => false,
    isAncestor: async () => false,
    checkTransferRepositoryIntegrity: async () => true,
    initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true }),
    importPackIntoRepo: async (path: string, data: Buffer) => {
      await mkdir(join(path, 'objects', 'pack'), { recursive: true });
      await writeFile(join(path, 'objects', 'pack', 'pack-fixture.pack'), data);
    }
  };
  const service = new ChunkTransferService(config, git as never, {} as never);
  return { config, service, git, auth: syntheticAuth() };
}

function restart(fixture: Fixture): ChunkTransferService {
  return new ChunkTransferService(fixture.config, fixture.git as never, {} as never);
}

async function createTransfer(fixture: Fixture, attemptId: string, chunkCount: number): Promise<string> {
  const created = await fixture.service.createPush(fixture.auth, request(fixture.auth, attemptId, chunkCount));
  return created.descriptor.transfer_id;
}

function request(auth: AuthenticatedDevice, attemptId: string, chunkCount: number): ChunkPushCreateRequest {
  return {
    api_version: API_VERSION,
    vault_id: auth.vault.vault_id,
    device_id: auth.device.device_id,
    expected_device_ref: null,
    target_commit: 'a'.repeat(40),
    client_known_main: null,
    attempt_id: attemptId,
    chunk_count: chunkCount,
    plan_sha256: 'b'.repeat(64)
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
