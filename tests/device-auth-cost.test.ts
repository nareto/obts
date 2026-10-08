import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthService, hashToken } from '../src/server/authService.js';
import { MetadataStore, type MetadataDb } from '../src/server/metadataStore.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-auth-cost-'));
  roots.push(root);
  const writes = vi.fn(async () => undefined);
  const store = new MetadataStore(root, { writeFile: writes, fsyncFile: async () => undefined,
    rename: async () => undefined, fsyncDirectory: async () => undefined });
  await store.initialize();
  const timestamp = new Date().toISOString();
  const token = 'synthetic-device-credential';
  const hashed = hashToken(token);
  await store.mutate((db) => {
    db.users.push({ user_id: 'usr_test', username: 'synthetic', display_name: 'Synthetic',
      password_hash: { algorithm: 'scrypt', salt: '', hash: '' }, is_admin: false, disabled: false,
      created_at: timestamp, last_login_at: null });
    db.vaults.push({ vault_id: 'vlt_test', owner_user_id: 'usr_test', display_name: 'Synthetic', status: 'active',
      current_main: 'a'.repeat(40), root_commit: 'a'.repeat(40), created_at: timestamp, updated_at: timestamp });
    db.devices.push({ device_id: 'dev_test', vault_id: 'vlt_test', user_id: 'usr_test', device_name: 'Synthetic',
      device_ref: 'refs/obts/devices/dev_test', device_ref_head: null, status: 'synced', last_applied_main: null,
      last_applied_event_seq: 0, last_applied_explicit_dirs: [], pending_applied_main: null,
      pending_applied_event_seq: 0, pending_applied_explicit_dirs: null, last_seen_at: timestamp,
      last_successful_sync_at: null, local_status_label: null, local_error_code: null, local_queue_status: null,
      local_main: null, local_head: null, plugin_version: null, path_capabilities: null, last_status_report_at: null,
      onboarding_status: 'complete', onboarding_mode: 'use_server', initial_proposal_kind: null,
      initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: timestamp,
      created_at: timestamp, revoked_at: null });
    db.tokens.push({ token_id: 'tok_test', kind: 'device', lookup_prefix: hashed.lookupPrefix, token_hash: hashed.hash,
      user_id: 'usr_test', vault_id: 'vlt_test', device_id: 'dev_test', expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp });
  });
  writes.mockClear();
  return { store, auth: new AuthService(store), writes, token, timestamp };
}

describe('coalesced device authentication', () => {
  it('clones only selected rows and isolates nested returned metadata', async () => {
    const f = await fixture();
    await f.store.mutate((db) => { db.tokens[0]!.metadata = { nested: { status: 'original' } }; });
    const selected = await f.store.read((db) => ({ token: db.tokens[0]! }));
    (selected.token.metadata.nested as { status: string }).status = 'caller';
    expect(await f.store.read((db) => db.tokens[0]!.metadata)).toEqual({ nested: { status: 'original' } });
  });

  it('does no persists in the window and exactly one for concurrent reads at expiry', async () => {
    const f = await fixture();
    const now = Date.parse(f.timestamp);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 59_999);
    for (let index = 0; index < 10; index++) await f.auth.authenticateDevice(`Bearer ${f.token}`, 'vlt_test');
    expect(f.writes).not.toHaveBeenCalled();
    vi.setSystemTime(now + 60_000);
    await Promise.all(Array.from({ length: 10 }, () => f.auth.authenticateDeviceAnyVault(`Bearer ${f.token}`)));
    expect(f.writes).toHaveBeenCalledTimes(1);
    const advanced = (await f.store.snapshot()).devices[0]!.last_seen_at;
    expect(advanced).not.toBe(f.timestamp);
    vi.setSystemTime(Date.parse(advanced!) + 59_999);
    await f.auth.authenticateDevice(`Bearer ${f.token}`, 'vlt_test');
    expect(f.writes).toHaveBeenCalledTimes(1);
  });

  it('orders read-only auth behind an in-flight revocation and returns detached rows', async () => {
    const f = await fixture();
    const first = await f.auth.authenticateDevice(`Bearer ${f.token}`, 'vlt_test');
    first.device.revoked_at = f.timestamp;
    expect((await f.store.snapshot()).devices[0]!.revoked_at).toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revoke = f.store.mutate(async (db) => { await gate; db.tokens[0]!.revoked_at = f.timestamp; });
    let settled = false;
    const auth = f.auth.authenticateDevice(`Bearer ${f.token}`, 'vlt_test').finally(() => { settled = true; });
    const assertion = expect(auth).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await revoke;
    await assertion;
    expect(f.writes).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown and foreign tokens without persists or useful existence disclosure', async () => {
    const f = await fixture();
    for (const [token, vault] of [['unknown-token', 'vlt_test'], [f.token, 'vlt_foreign']]) {
      await expect(f.auth.authenticateDevice(`Bearer ${token}`, vault!)).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    }
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([
    (db: MetadataDb) => { db.tokens[0]!.revoked_at = new Date().toISOString(); },
    (db: MetadataDb) => { db.users[0]!.disabled = true; },
    (db: MetadataDb) => { db.vaults[0]!.owner_user_id = 'usr_foreign'; },
    (db: MetadataDb) => { db.vaults[0]!.status = 'deleting'; },
    (db: MetadataDb) => { db.devices[0]!.revoked_at = new Date().toISOString(); },
    (db: MetadataDb) => { db.devices[0]!.vault_id = 'vlt_foreign'; },
    (db: MetadataDb) => { db.devices[0]!.user_id = 'usr_foreign'; },
    (db: MetadataDb) => { db.devices = []; },
    (db: MetadataDb) => { db.users = []; }
  ])('preserves all existing authorization checks: %#', async (invalidate) => {
    const f = await fixture();
    await f.store.mutate(invalidate);
    f.writes.mockClear();
    await expect(f.auth.authenticateDeviceAnyVault(`Bearer ${f.token}`)).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
    expect(f.writes).not.toHaveBeenCalled();
  });
});
