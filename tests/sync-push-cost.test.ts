import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { hashToken } from '../src/server/authService.js';
import { sha256Hex } from '../src/server/gitService.js';
import { OperationalLog } from '../src/server/operationalLog.js';
import type { MetadataPersistenceAdapter } from '../src/server/metadataStore.js';
import { API_VERSION, type DevicePushManifest, type PushResult } from '../src/shared/types.js';

// A vault with a real history, a real tree and production-shaped metadata volume. The budgets below
// are operation counts, not wall-clock times, so they hold at any metadata size.
const FILE_COUNT = 400;
const COMMIT_COUNT = 300;
const EVENT_PAIRS = 600;
const AUDIT_ROWS = 400;
const NOTE = '# Note\n\nbody line\n';

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function oid(seed: number): string {
  return sha256Hex(Buffer.from(`obts-synthetic-${seed}`, 'utf8'));
}

function notePath(index: number): string {
  return `folder-${String(index % 20).padStart(2, '0')}/note-${String(index).padStart(5, '0')}.md`;
}

function nativeGit(gitDir: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function buildRepository(gitDir: string): string {
  execFileSync('git', ['init', '--bare', '--quiet', gitDir]);
  for (const ref of nativeGit(gitDir, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean)) {
    nativeGit(gitDir, ['update-ref', '-d', ref]);
  }
  const chunks: string[] = [];
  let mark = 0;
  const blobMarks: number[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const body = `${NOTE}\n${index}\n`;
    mark += 1;
    blobMarks.push(mark);
    chunks.push(`blob\nmark :${mark}\ndata ${Buffer.byteLength(body)}\n${body}\n`);
  }
  const stamp = 1_700_000_000;
  mark += 1;
  let parentMark = mark;
  chunks.push(`commit refs/heads/main\nmark :${parentMark}\n` +
    `author Synthetic <synthetic@example.invalid> ${stamp} +0000\n` +
    `committer Synthetic <synthetic@example.invalid> ${stamp} +0000\n` +
    `data 8\nbaseline\n` +
    Array.from({ length: FILE_COUNT }, (_, index) => `M 100644 :${blobMarks[index]} ${notePath(index)}\n`).join('') +
    '\n');
  for (let index = 0; index < COMMIT_COUNT; index += 1) {
    const body = `${NOTE}\nedit ${index}\n`;
    mark += 1;
    const blobMark = mark;
    mark += 1;
    const commitMark = mark;
    chunks.push(`blob\nmark :${blobMark}\ndata ${Buffer.byteLength(body)}\n${body}\n`);
    chunks.push(`commit refs/heads/main\nmark :${commitMark}\n` +
      `author Synthetic <synthetic@example.invalid> ${stamp + index + 1} +0000\n` +
      `committer Synthetic <synthetic@example.invalid> ${stamp + index + 1} +0000\n` +
      `data 6\ne${String(index).padStart(5, '0')}\n` +
      `from :${parentMark}\nM 100644 :${blobMark} ${notePath(index % FILE_COUNT)}\n\n`);
    parentMark = commitMark;
  }
  chunks.push('done\n');
  execFileSync('git', ['--git-dir', gitDir, 'fast-import', '--quiet'], {
    input: chunks.join(''), maxBuffer: 1024 * 1024 * 1024
  });
  for (const args of [['repack', '-d', '-q', '--geometric=2'], ['commit-graph', 'write', '--reachable']]) {
    nativeGit(gitDir, args);
  }
  return nativeGit(gitDir, ['rev-parse', 'refs/heads/main']).trim();
}

type Fixture = {
  server: ObtsServer;
  vaultId: string;
  deviceId: string;
  token: string;
  repo: string;
  root: string;
  logLines: Array<Record<string, unknown>>;
  publications: () => number;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-sync-cost-'));
  roots.push(root);
  const logLines: Array<Record<string, unknown>> = [];
  const log = new OperationalLog('info', (line) => { logLines.push(JSON.parse(line) as Record<string, unknown>); });
  const server = await createObtsServer(
    { dataDir: join(root, 'data'), sessionSecret: 'sync-cost-secret-with-enough-entropy' },
    // Consolidation is exercised elsewhere; a deterministic Git command count needs it quiet.
    { operationalLog: log, gitMaintenance: { packThreshold: 1_000_000, looseThreshold: 1_000_000 } }
  );
  servers.push(server);
  const persistence = (server.store as unknown as { persistence: MetadataPersistenceAdapter }).persistence;
  let publications = 0;
  const writeFile = persistence.writeFile.bind(persistence);
  persistence.writeFile = async (path, data) => { publications += 1; await writeFile(path, data); };
  const setup = await server.app.inject({
    method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'test-password-with-entropy' }
  });
  const created = await server.app.inject({
    method: 'POST', url: '/api/v1/vaults',
    headers: { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token },
    payload: { display_name: 'Cost fixture' }
  });
  const vaultId = created.json().vault_id as string;
  const repo = server.git.repoPath(vaultId);
  const main = buildRepository(repo);
  const deviceId = 'dev_cost';
  const token = 'cost-fixture-device-token';
  const tokenHash = hashToken(token);
  const timestamp = new Date().toISOString();
  await server.store.mutate((db) => {
    const user = db.users[0]!;
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId)!;
    vault.current_main = main;
    vault.root_commit = main;
    db.devices.push({
      device_id: deviceId, vault_id: vaultId, user_id: user.user_id, device_name: 'Cost fixture',
      device_ref: `refs/obts/devices/${deviceId}`, device_ref_head: main, status: 'synced',
      last_applied_main: main, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: timestamp, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    });
    db.tokens.push({
      token_id: 'tok_cost', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
      user_id: user.user_id, vault_id: vaultId, device_id: deviceId, expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp
    });
    let sequence = 0;
    for (let index = 0; index < EVENT_PAIRS; index += 1) {
      const previousMain = oid(index * 2);
      const nextMain = oid(index * 2 + 1);
      for (const event of [
        { event_type: 'main_advanced' as const, commit_cursors: { previous_main: previousMain, main: nextMain, device_commit: nextMain },
          payload: { decision: 'merged', merge_sequence: index + 1, base_commit: previousMain, current_main: previousMain,
            device_commit: nextMain, changed_path_count: 1,
            directory_intents: [{ op: 'create', path: notePath(index % FILE_COUNT), intent_id: `intent_${index}` }] } },
        { event_type: 'device_ref_updated' as const, commit_cursors: { device_ref: nextMain, main: previousMain },
          payload: { device_id: deviceId } }
      ]) {
        sequence += 1;
        db.events.push({
          event_id: `evt_${String(sequence).padStart(8, '0')}`,
          event_seq: sequence,
          created_at: timestamp,
          vault_id: vaultId,
          resource_ids: { device_id: deviceId },
          ...event
        });
      }
    }
    db.event_seq_by_vault[vaultId] = sequence;
    for (let index = 0; index < AUDIT_ROWS; index += 1) {
      db.audit_log.push({
        audit_id: `aud_${String(index).padStart(8, '0')}`, actor_user_id: db.users[0]!.user_id, actor_device_id: deviceId,
        vault_id: vaultId, action: 'main_advanced', resource_class: 'vault', resource_id: vaultId, created_at: timestamp
      });
    }
    db.directory_state_by_vault[vaultId] = {
      explicit_dirs: Array.from({ length: 20 }, (_, index) => `folder-${String(index).padStart(2, '0')}`),
      updated_at: timestamp,
      last_event_seq: sequence
    };
  });
  await server.git.updateRef(vaultId, `refs/obts/devices/${deviceId}`, main, null);
  return { server, vaultId, deviceId, token, repo, root, logLines, publications: () => publications };
}

async function deviceCommit(f: Fixture, path: string, body: string): Promise<string> {
  const blob = execFileSync('git', ['--git-dir', f.repo, 'hash-object', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();
  const indexFile = join(f.root, 'synthetic-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  execFileSync('git', ['--git-dir', f.repo, 'read-tree', 'refs/heads/main'], { env });
  execFileSync('git', ['--git-dir', f.repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
  const tree = execFileSync('git', ['--git-dir', f.repo, 'write-tree'], { env, encoding: 'utf8' }).trim();
  return execFileSync('git', ['--git-dir', f.repo, 'commit-tree', tree, '-p', 'refs/heads/main', '-m', 'cost push'],
    { encoding: 'utf8' }).trim();
}

async function pushOneFile(f: Fixture): Promise<PushResult> {
  const main = nativeGit(f.repo, ['rev-parse', 'refs/heads/main']).trim();
  const target = await deviceCommit(f, notePath(3), `${NOTE}\nedited\n`);
  const pack = await f.server.git.exportPack(f.vaultId, target, 'refs/heads/main');
  const transferRoot = join(f.root, 'transfer');
  await mkdir(transferRoot, { recursive: true, mode: 0o700 });
  const transferRepo = join(transferRoot, 'repo.git');
  await f.server.git.initializeTransferRepo(f.vaultId, transferRepo);
  await f.server.git.importPackIntoRepo(transferRepo, pack, join(f.repo, 'objects'));
  const auth = await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
  const manifest: DevicePushManifest = {
    api_version: API_VERSION, plugin_version: '0.7.8', vault_id: f.vaultId, device_id: f.deviceId,
    expected_device_ref: main, target_commit: target, client_known_main: main, base_commit: main,
    packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length
  };
  try {
    return await f.server.sync.pushDeviceCommit(auth, manifest, Buffer.alloc(0), {
      reader: f.server.git.readerForRepo(transferRepo, join(f.repo, 'objects')),
      promote: async () => await f.server.git.promoteTransferObjects(f.vaultId, transferRepo)
    });
  } finally {
    await rm(transferRoot, { recursive: true, force: true });
  }
}

describe('change-proportional server work', () => {
  it('hands out the committed metadata state instead of copying it, and rejects writes through it', async () => {
    const f = await fixture();
    const first = await f.server.store.snapshot();
    const second = await f.server.store.snapshot();
    expect(second).toBe(first);
    const versioned = await f.server.store.snapshotVersioned();
    expect(versioned.db).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.devices)).toBe(true);
    expect(Object.isFrozen(first.devices[0])).toBe(true);
    expect(() => { (first as unknown as { setup_complete: boolean }).setup_complete = false; }).toThrow(TypeError);
    expect(() => { (first.events as unknown as unknown[]).push({}); }).toThrow(TypeError);
    // A mutation still commits a private candidate; publishing replaced the object instead of editing it.
    await f.server.store.mutate((db) => { db.setup_complete = true; });
    expect(await f.server.store.snapshot()).not.toBe(first);
    expect(first.setup_complete).toBe(true);
  });

  it('serves a device status poll without copying or republishing the state', async () => {
    const f = await fixture();
    const before = await f.server.store.snapshot();
    const publications = f.publications();
    for (let index = 0; index < 5; index += 1) await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
    expect(f.publications()).toBe(publications);
    expect(await f.server.store.snapshot()).toBe(before);
  });

  it('integrates a one-file push inside clone, persist and Git command budgets', async () => {
    const f = await fixture();
    const auditBefore = await f.server.store.read((db) => db.audit_log.length);
    const mainAdvancedAuditBefore = await f.server.store.read(
      (db) => db.audit_log.filter((row) => row.action === 'main_advanced').length
    );
    const result = await pushOneFile(f);
    expect(result.status).toBe('merged');
    // The per-push audit duplicate of the `main_advanced` event is not written: the event and the
    // immutable merge commit already record the same transition and actor, so the push adds no
    // audit row at all.
    const auditAfter = await f.server.store.read((db) => db.audit_log);
    expect(auditAfter.length).toBe(auditBefore);
    expect(auditAfter.filter((row) => row.action === 'main_advanced')).toHaveLength(mainAdvancedAuditBefore);
    const line = f.logLines.filter((entry) => entry.event === 'push_integrated').at(-1)!;
    // Eight durable boundaries: push admission and prepared state, the live transition refresh, the
    // device ref commit, merge preparation and target, the merge commit, and the history handoff pair.
    expect(line.persist_count).toBe(8);
    // One candidate copy per metadata transaction (six) plus the two copies the operation-history
    // handoff writes. Reads contribute none: a poll or snapshot must never copy the whole state.
    expect(Number(line.clone_count)).toBeLessThanOrEqual(8);
    expect(Number(line.clone_count)).toBeGreaterThan(0);
    // Repeating ls-tree/merge-base for the same commit is what made a push scale with metadata size.
    expect(Number(line.git_count)).toBeLessThanOrEqual(34);
    expect(typeof line.git_slowest).toBe('string');
    expect(Number(line.lock_wait_ms)).toBeGreaterThanOrEqual(0);
    expect(Number(line.clone_ms)).toBeGreaterThanOrEqual(0);
    // The pushed file is really there and the previous main is the merge's parent.
    const merged = nativeGit(f.repo, ['ls-tree', '-r', 'refs/heads/main', '--name-only']).split('\n');
    expect(merged).toContain(notePath(3));
    expect((await f.server.store.snapshot()).vaults[0]!.current_main).toBe(result.status === 'merged' ? result.main : null);
  });
});
