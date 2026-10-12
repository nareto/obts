import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { AuthService } from '../../src/server/authService.js';
import { MetadataStore, type DeviceRow, type SessionRow } from '../../src/server/metadataStore.js';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export function sessionRow(id: string, userId: string, now: number): SessionRow {
  return {
    session_id: id,
    user_id: userId,
    csrf_token: `csrf_${id}`,
    created_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30 * DAY).toISOString(),
    idle_expires_at: new Date(now + 7 * DAY).toISOString(),
    recent_auth_at: new Date(now).toISOString(),
    revoked_at: null
  };
}

export function deviceRow(id: string, vaultId: string, userId: string, timestamp: string): DeviceRow {
  return {
    device_id: id, vault_id: vaultId, user_id: userId, device_name: id, device_ref: `refs/obts/devices/${id}`,
    device_ref_head: null, status: 'synced', last_applied_main: null, last_applied_event_seq: 0,
    last_applied_explicit_dirs: [], pending_applied_main: null, pending_applied_event_seq: 0,
    pending_applied_explicit_dirs: null, last_seen_at: timestamp, last_successful_sync_at: null,
    local_status_label: null, local_error_code: null, local_queue_status: null, local_main: null, local_head: null,
    plugin_version: null, path_capabilities: null, last_status_report_at: null, onboarding_status: 'complete',
    onboarding_mode: 'use_server', initial_proposal_kind: null, initial_proposal_base: null,
    onboarding_connection_id: null, onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
  };
}

export type StoreFixture = Awaited<ReturnType<typeof createStoreFixture>>;

/**
 * Two owners (usr_a with vlt_a/vlt_a2, usr_b with vlt_b), one device per owner's first vault and one live
 * session each. `writes` counts every persisted metadata file, so tests can assert persistence cost.
 */
export async function createStoreFixture(roots: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'obts-dashboard-fixture-'));
  roots.push(root);
  const writes = vi.fn(async (_path: string, _data: string) => undefined);
  const store = new MetadataStore(root, {
    writeFile: writes,
    fsyncFile: async () => undefined,
    rename: async () => undefined,
    fsyncDirectory: async () => undefined
  });
  await store.initialize();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  await store.mutate((db) => {
    for (const [userId, name] of [['usr_a', 'alice'], ['usr_b', 'bob']] as const) {
      db.users.push({
        user_id: userId, username: name, display_name: name, is_admin: false, disabled: false,
        password_hash: { algorithm: 'scrypt', salt: '', hash: '' } as never, created_at: timestamp, last_login_at: null
      });
    }
    for (const [vaultId, owner] of [['vlt_a', 'usr_a'], ['vlt_a2', 'usr_a'], ['vlt_b', 'usr_b']] as const) {
      db.vaults.push({
        vault_id: vaultId, owner_user_id: owner, display_name: vaultId, status: 'active',
        current_main: 'a'.repeat(40), root_commit: 'a'.repeat(40), created_at: timestamp, updated_at: timestamp
      });
    }
    db.devices.push(deviceRow('dev_a', 'vlt_a', 'usr_a', timestamp), deviceRow('dev_b', 'vlt_b', 'usr_b', timestamp));
    db.sessions.push(sessionRow('ses_a', 'usr_a', now), sessionRow('ses_b', 'usr_b', now));
  });
  writes.mockClear();
  return { root, store, writes, auth: new AuthService(store), now, timestamp };
}

export async function removeRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
}
