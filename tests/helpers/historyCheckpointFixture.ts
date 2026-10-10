import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { createObtsServer, type ObtsServer } from '../../src/server/app.js';
import { hashToken, type AuthenticatedDevice } from '../../src/server/authService.js';
import { sha256Hex } from '../../src/server/gitService.js';
import { API_VERSION, type DevicePushManifest, type DirectoryProposal, type PushResult } from '../../src/shared/types.js';

type Fixture = { server: ObtsServer; auth: AuthenticatedDevice; token: string; m0: string };
type Writes = Record<string, string | Buffer | null>;
let commitSequence = 0;

export async function refInventory(f: Fixture): Promise<string> {
  const { stdout } = await promisify(execFile)('git', [
    '--git-dir', f.server.git.repoPath(f.auth.vault.vault_id), 'for-each-ref', '--format=%(refname) %(objectname)'
  ]);
  return stdout;
}

export async function directoryProposal(f: Fixture, target: string, op: 'create' | 'delete' = 'create', path = 'Empty'): Promise<DirectoryProposal> {
  const device = (await f.server.store.snapshot()).devices.find((row) => row.device_id === f.auth.device.device_id)!;
  const body = {
    schema_version: 2 as const, base_main: device.last_applied_main, base_event_seq: device.last_applied_event_seq,
    intents: [{ op, path, intent_id: 'dir_1_0_012345abcdef', generation: 0, provenance: 'local_v2' as const,
      base_main: device.last_applied_main, base_event_seq: device.last_applied_event_seq,
      replaces_intent_id: null, recreated_after_delete: false, created_at: null }]
  };
  return { ...body, proposal_id: `dirprop_${sha256Hex(JSON.stringify([device.device_id, target, body]))}` };
}

export async function commit(f: Fixture, parent: string, writes: Writes): Promise<string> {
  const tree = await f.server.git.createTreeFromCommitWithChanges({
    vaultId: f.auth.vault.vault_id, sourceCommit: parent,
    writes: new Map(Object.entries(writes).filter((entry): entry is [string, string | Buffer] => entry[1] !== null)
      .map(([path, bytes]) => [path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])),
    deletes: Object.entries(writes).filter(([, bytes]) => bytes === null).map(([path]) => path)
  });
  return await f.server.git.createMainCommitFromTree({
    vaultId: f.auth.vault.vault_id, tree, parentMain: parent, subject: `fixture edit ${++commitSequence}`, body: '', actor: 'fixture'
  });
}

async function setMain(f: Fixture, main: string): Promise<void> {
  await f.server.git.updateRef(f.auth.vault.vault_id, 'refs/heads/main', main, await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main'));
  await f.server.store.mutate((db) => { db.vaults.find((v) => v.vault_id === f.auth.vault.vault_id)!.current_main = main; });
}

export async function historyCheckpointFixture(dataDir: string): Promise<Fixture> {
  const server = await createObtsServer({ dataDir, sessionSecret: 'checkpoint-test-secret' });
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'test-password-with-entropy' } });
  expect(setup.statusCode).toBe(201);
  const created = await server.app.inject({
    method: 'POST', url: '/api/v1/vaults',
    headers: { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token },
    payload: { display_name: 'Checkpoint fixture' }
  });
  expect(created.statusCode).toBe(201);
  const vaultId = created.json().vault_id as string;
  const token = 'checkpoint-fixture-device-token';
  const tokenHash = hashToken(token);
  const timestamp = new Date().toISOString();
  await server.store.mutate((db) => {
    const user = db.users[0]!;
    const vault = db.vaults.find((v) => v.vault_id === vaultId)!;
    db.devices.push({
      device_id: 'dev_stale', vault_id: vaultId, user_id: user.user_id, device_name: 'Checkpoint fixture',
      device_ref: 'refs/obts/devices/dev_stale', device_ref_head: vault.current_main, status: 'synced',
      last_applied_main: vault.current_main, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    });
    db.tokens.push({
      token_id: 'tok_stale', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
      user_id: user.user_id, vault_id: vaultId, device_id: 'dev_stale', expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp
    });
  });
  const auth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  const f = { server, auth, token, m0: auth.vault.current_main };
  f.m0 = await commit(f, f.m0, { 'old.md': 'rename payload\n', 'shared.md': 'base\n' });
  await setMain(f, f.m0);
  await server.git.updateRef(vaultId, auth.device.device_ref, f.m0, null);
  await server.store.mutate((db) => {
    const device = db.devices.find((d) => d.device_id === auth.device.device_id)!;
    device.device_ref_head = f.m0;
    device.last_applied_main = f.m0;
  });
  f.auth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  return f;
}

export async function manifest(f: Fixture, target: string, base: string | undefined = f.m0, attempt?: string, renamePairs?: DevicePushManifest['rename_pairs']): Promise<{ manifest: DevicePushManifest; pack: Buffer }> {
  const pack = await f.server.git.exportPack(f.auth.vault.vault_id, target, f.m0);
  return { pack, manifest: {
    api_version: API_VERSION, plugin_version: '0.5.13', vault_id: f.auth.vault.vault_id, device_id: f.auth.device.device_id,
    expected_device_ref: f.m0, target_commit: target,
    client_known_main: await f.server.git.getRef(f.auth.vault.vault_id, 'refs/heads/main'),
    packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length,
    ...(base === undefined ? {} : { base_commit: base }), ...(attempt ? { attempt_id: attempt } : {}),
    ...(renamePairs === undefined ? {} : { rename_pairs: renamePairs })
  } };
}

export async function multipart(f: Fixture, request: Awaited<ReturnType<typeof manifest>>): Promise<{ status: number; result: PushResult }> {
  const boundary = 'obts-stale-proposal-boundary';
  const response = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.auth.vault.vault_id}/sync/push`,
    headers: { authorization: `Bearer ${f.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(request.manifest)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      request.pack, Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  });
  return { status: response.statusCode, result: response.json() as PushResult };
}
