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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const nextTurn = async () => await new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('transfer accounting serialization', () => {
  it('serializes deletion behind an accounting put and preserves the delete result', async () => {
    const fixture = await createFixture();
    const first = await createTransfer(fixture, 'accounting-delete-first', 1);
    const second = await createTransfer(fixture, 'accounting-delete-second', 1);

    const put = fixture.service.putChunk(fixture.auth, first, 0, Buffer.from('first chunk'), sha256('first chunk'));
    await fixture.firstImportStarted.promise;
    const deletion = fixture.service.deletePush(fixture.auth, second);
    await nextTurn();
    await nextTurn();
    expect(await exists(join(fixture.config.transferDir, second))).toBe(true);

    fixture.releaseFirstImport.resolve();
    await expect(put).resolves.toMatchObject({ transfer_id: first, idempotent: false });
    await expect(deletion).resolves.toBeUndefined();
    expect(await exists(join(fixture.config.transferDir, second))).toBe(false);
    expect((fixture.service as unknown as { storedBytes: number | null }).storedBytes).toBeNull();
  });

  it('serializes expiry cleanup behind an accounting put while preserving 410 admission rejection', async () => {
    const fixture = await createFixture();
    const first = await createTransfer(fixture, 'accounting-expiry-first', 1);
    const second = await createTransfer(fixture, 'accounting-expiry-second', 1);
    await expireSession(fixture.config.transferDir, second);

    const put = fixture.service.putChunk(fixture.auth, first, 0, Buffer.from('first chunk'), sha256('first chunk'));
    await fixture.firstImportStarted.promise;
    const expired = fixture.service.getPush(fixture.auth, second);
    await nextTurn();
    await nextTurn();
    expect(await exists(join(fixture.config.transferDir, second))).toBe(true);

    fixture.releaseFirstImport.resolve();
    await expect(put).resolves.toMatchObject({ transfer_id: first, idempotent: false });
    await expect(expired).rejects.toMatchObject({ statusCode: 410, code: 'transfer_expired' });
    expect(await exists(join(fixture.config.transferDir, second))).toBe(false);
    expect((fixture.service as unknown as { storedBytes: number | null }).storedBytes).toBeNull();
  });

  it('serializes create-time pruning behind an accounting put', async () => {
    const fixture = await createFixture();
    const first = await createTransfer(fixture, 'accounting-prune-first', 1);
    const second = await createTransfer(fixture, 'accounting-prune-second', 1);
    await expireSession(fixture.config.transferDir, second);

    const put = fixture.service.putChunk(fixture.auth, first, 0, Buffer.from('first chunk'), sha256('first chunk'));
    await fixture.firstImportStarted.promise;
    const internal = fixture.service as unknown as { pruneExpired: () => Promise<void> };
    const originalPrune = internal.pruneExpired.bind(fixture.service);
    const pruneEntered = deferred();
    internal.pruneExpired = async () => {
      pruneEntered.resolve();
      await originalPrune();
    };
    const create = fixture.service.createPush(fixture.auth, request(fixture.auth, 'accounting-prune-third', 0));
    await pruneEntered.promise;
    await nextTurn();
    await nextTurn();
    expect(await exists(join(fixture.config.transferDir, second))).toBe(true);

    fixture.releaseFirstImport.resolve();
    await expect(put).resolves.toMatchObject({ transfer_id: first, idempotent: false });
    await expect(create).resolves.toMatchObject({ created: true });
    expect(await exists(join(fixture.config.transferDir, second))).toBe(false);
  });
});

type Fixture = {
  config: ReturnType<typeof createServerConfig>;
  service: ChunkTransferService;
  auth: AuthenticatedDevice;
  firstImportStarted: ReturnType<typeof deferred>;
  releaseFirstImport: ReturnType<typeof deferred>;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-transfer-accounting-'));
  roots.push(root);
  const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
  await ensureServerDirectories(config);
  const firstImportStarted = deferred();
  const releaseFirstImport = deferred();
  let imports = 0;
  const git = {
    getRef: async () => null,
    commitExists: async () => false,
    isAncestor: async () => false,
    checkTransferRepositoryIntegrity: async () => true,
    initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true }),
    importPackIntoRepo: async (path: string, data: Buffer) => {
      imports += 1;
      await mkdir(join(path, 'objects', 'pack'), { recursive: true });
      await writeFile(join(path, 'objects', 'pack', `pack-${imports}.pack`), data);
      if (imports === 1) {
        firstImportStarted.resolve();
        await releaseFirstImport.promise;
      }
    }
  };
  const service = new ChunkTransferService(config, git as never, {} as never);
  return { config, service, auth: syntheticAuth(), firstImportStarted, releaseFirstImport };
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

async function expireSession(transferDir: string, transferId: string): Promise<void> {
  const path = join(transferDir, transferId, 'session.json');
  const session = JSON.parse(await readFile(path, 'utf8')) as { expires_at: string };
  session.expires_at = '1970-01-01T00:00:00.000Z';
  await writeFile(path, `${JSON.stringify(session)}\n`);
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
