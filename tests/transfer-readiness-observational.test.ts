import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuthenticatedDevice } from '../src/server/authService.js';
import { ChunkTransferService } from '../src/server/chunkTransferService.js';
import { createServerConfig, ensureServerDirectories } from '../src/server/config.js';
import { API_VERSION, type ChunkPushCreateRequest } from '../src/shared/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('transfer readiness observation', () => {
  it('does not repeat deep audit or acquire the storage lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-transfer-readiness-observation-'));
    roots.push(root);
    const config = createServerConfig({ dataDir: join(root, 'data'), transferChunkBytes: 1_048_576 });
    await ensureServerDirectories(config);
    let integrityChecks = 0;
    const git = {
      getRef: async () => null,
      initializeTransferRepo: async (_vaultId: string, path: string) => await mkdir(path, { recursive: true }),
      checkTransferRepositoryIntegrity: async () => {
        integrityChecks += 1;
        return false;
      }
    };
    const service = new ChunkTransferService(config, git as never, {} as never);
    const auth = syntheticAuth();
    const created = await service.createPush(auth, request(auth));

    await service.initialize();
    expect(integrityChecks).toBe(1);
    const availableBeforeProbe = service.isReady();
    (git as { checkTransferRepositoryIntegrity: () => Promise<boolean> }).checkTransferRepositoryIntegrity = async () => {
      throw new Error('readiness repeated the deep repository audit');
    };
    (service as unknown as { withStorageLock: () => Promise<never> }).withStorageLock = async () => {
      throw new Error('readiness acquired the transfer storage lock');
    };

    const started = Date.now();
    await expect(service.checkReady()).resolves.toEqual({
      ok: false,
      error: `transfer storage anomaly: transfer_repository_unusable:${created.descriptor.transfer_id}`
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(service.isReady()).toBe(availableBeforeProbe);
    expect(integrityChecks).toBe(1);
  });
});

function request(auth: AuthenticatedDevice): ChunkPushCreateRequest {
  return {
    api_version: API_VERSION,
    plugin_version: '0.4.36',
    vault_id: auth.vault.vault_id,
    device_id: auth.device.device_id,
    expected_device_ref: null,
    target_commit: 'a'.repeat(40),
    client_known_main: 'a'.repeat(40),
    attempt_id: 'readiness-observation',
    chunk_count: 1,
    plan_sha256: createHash('sha256').update('readiness-observation').digest('hex')
  };
}

function syntheticAuth(): AuthenticatedDevice {
  const timestamp = new Date().toISOString();
  return {
    user: {
      user_id: 'usr_readiness', username: 'readiness', display_name: 'Readiness', password_hash: {} as never,
      is_admin: true, disabled: false, created_at: timestamp, last_login_at: null
    },
    vault: {
      vault_id: 'vlt_readiness', owner_user_id: 'usr_readiness', display_name: 'Readiness', status: 'active',
      root_commit: 'a'.repeat(40), current_main: 'a'.repeat(40), created_at: timestamp, updated_at: timestamp
    },
    device: {
      device_id: 'dev_readiness', vault_id: 'vlt_readiness', user_id: 'usr_readiness', device_name: 'Readiness',
      device_ref: 'refs/obts/devices/dev_readiness', device_ref_head: null, status: 'synced',
      last_applied_main: 'a'.repeat(40), last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: timestamp, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: 'a'.repeat(40), local_head: 'a'.repeat(40), plugin_version: '0.4.36',
      path_capabilities: null, last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    },
    token: {} as never
  };
}
