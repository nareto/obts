import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { hashToken } from '../src/server/authService.js';
import { MetadataStore } from '../src/server/metadataStore.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'obts-shutdown-'));
  roots.push(path);
  return path;
}

async function seedDevice(store: MetadataStore) {
  const timestamp = new Date().toISOString();
  const token = 'synthetic-shutdown-device-token';
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
  return token;
}

describe('server metadata shutdown', () => {
  it('waits for an authenticated status publication after its socket is closed', async () => {
    const path = await root();
    const entered = deferred();
    const gate = deferred();
    const networkClosed = deferred();
    const events: string[] = [];
    let held = false;
    const server = await createObtsServer({ dataDir: path, sessionSecret: 'synthetic-shutdown-signing-key' }, {
      metadataPersistence: {
        writeFile: async (file, data) => {
          if (held) {
            entered.resolve();
            await gate.promise;
          }
          await writeFile(file, data, { mode: 0o600 });
        }
      }
    });
    servers.push(server);
    const token = await seedDevice(server.store);
    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    server.app.server.once('close', networkClosed.resolve);
    const mutate = server.store.mutate.bind(server.store);
    vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      const result = await mutate(fn);
      events.push('publication-settled');
      return result;
    });
    held = true;
    const request = fetch(`${address}/api/v1/vaults/vlt_test/sync/device-status`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ plugin_version: '0.6.1', local_status_label: 'Checking', local_error_code: null,
        local_queue_status: 'idle', local_main: null, local_head: null })
    }).catch(() => null);
    await entered.promise;
    events.length = 0;
    const closing = server.app.close().then(() => { events.push('closed'); });
    try {
      await networkClosed.promise;
      await nextTurn();
      expect([...events]).toEqual([]);
    } finally {
      gate.resolve();
      await request;
      await closing;
      await server.store.snapshot();
    }
    expect(events).toEqual(['publication-settled', 'closed']);
    const persisted = JSON.parse(await readFile(join(path, 'metadata', 'phase1.json'), 'utf8'));
    expect(persisted.devices[0].local_status_label).toBe('Checking');
  });

  it.each([false, true])('drains previously admitted mutations and is idempotent (failure=%s)', async (fail) => {
    const path = await root();
    const entered = deferred();
    const gate = deferred();
    const store = new MetadataStore(path);
    await store.initialize();
    const first = store.mutate(async (db) => {
      entered.resolve();
      await gate.promise;
      if (fail) throw new Error('synthetic mutation failure');
      db.setup_complete = true;
    }).catch((error: Error) => error);
    await entered.promise;
    const second = store.mutate((db) => { db.event_seq_by_vault.vlt_test = 7; });
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    const closingAgain = store.close();
    const late = vi.fn();
    try {
      await expect(store.mutate(late)).rejects.toThrow('closed');
      await expect(store.mutateDurably(late)).rejects.toThrow('closed');
      await expect(store.readOrMutate(() => true, () => true, late)).rejects.toThrow('closed');
      await expect(store.cleanupPersistenceTemps()).rejects.toThrow('closed');
      await expect(store.initialize()).rejects.toThrow('closed');
      expect(late).not.toHaveBeenCalled();
      expect(closed).toBe(false);
    } finally {
      gate.resolve();
      await Promise.all([first, second, closing, closingAgain]);
    }
    expect(closed).toBe(true);
    expect(store.isReady()).toBe(false);
    const persisted = JSON.parse(await readFile(join(path, 'metadata', 'phase1.json'), 'utf8'));
    expect(persisted.event_seq_by_vault.vlt_test).toBe(7);
    expect(persisted.setup_complete).toBe(!fail);
  });

  it('drains initialization and prevents a closed lazy read from initializing storage', async () => {
    const path = await root();
    const entered = deferred();
    const gate = deferred();
    const store = new MetadataStore(path, { writeFile: async (file, data) => {
      entered.resolve();
      await gate.promise;
      await writeFile(file, data);
    } });
    const initializing = store.initialize();
    await entered.promise;
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      gate.resolve();
      await Promise.all([initializing, closing]);
    }
    const write = vi.fn();
    const uninitialized = new MetadataStore(await root(), { writeFile: write });
    await uninitialized.close();
    await expect(uninitialized.snapshot()).rejects.toThrow('closed');
    await expect(uninitialized.read((db) => db.setup_complete)).rejects.toThrow('closed');
    expect(write).not.toHaveBeenCalled();
  });
});
