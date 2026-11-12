import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { hashToken, type AuthenticatedDevice } from '../src/server/authService.js';
import { sha256Hex } from '../src/server/gitService.js';
import { OperationalLog } from '../src/server/operationalLog.js';
import { API_VERSION, type DevicePushManifest, type PushResult } from '../src/shared/types.js';

const NOTE = 'first\n\nunchanged middle\n\nlast\n';
let commitSequence = 0;
let transferSequence = 0;
const roots: string[] = [];
const servers: ObtsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

type Fixture = {
  server: ObtsServer;
  auth: AuthenticatedDevice;
  token: string;
  vaultId: string;
  repo: string;
  root: string;
  logLines: Array<Record<string, unknown>>;
};

type Writes = Record<string, string | Buffer | null>;

function nativeGit(gitDir: string, args: string[], input?: Buffer | string): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
}

/** Every object the repository holds, reachable or not. Sorted for set comparison. */
function objectIds(gitDir: string): string[] {
  return nativeGit(gitDir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
    .split('\n').filter(Boolean).sort();
}

async function packCount(gitDir: string): Promise<number> {
  const names = await readdir(join(gitDir, 'objects', 'pack')).catch(() => [] as string[]);
  return names.filter((name) => /^pack-[0-9a-f]{40}\.pack$/u.test(name)).length;
}

function maintenanceEvents(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.filter((line) => line.event === 'git_maintenance');
}

/**
 * A `git` wrapper that records the consolidation subcommands and can slow down or fail `repack`, so
 * tests can assert how many consolidations ran without measuring wall-clock time.
 */
async function wrapperGit(directory: string, behaviour: 'plain' | 'slow' | 'fail'): Promise<{ binary: string; log: string }> {
  const binary = join(directory, 'git');
  const log = join(directory, 'git-subcommands.log');
  const action = behaviour === 'fail' ? 'exit 1' : behaviour === 'slow' ? 'sleep 1' : ':';
  await writeFile(binary, [
    '#!/bin/sh',
    'sub=',
    'for a in "$@"; do',
    '  case "$a" in repack|commit-graph) sub=$a; break;; esac',
    'done',
    `[ -n "$sub" ] && echo "$sub" >> '${log}'`,
    `case "$sub" in repack) ${action};; esac`,
    'exec git "$@"',
    ''
  ].join('\n'));
  await chmod(binary, 0o755);
  return { binary, log };
}

async function loggedSubcommands(logPath: string): Promise<string[]> {
  const contents = await readFile(logPath, 'utf8').catch(() => '');
  return contents.split('\n').filter(Boolean);
}

async function fixture(options: {
  packThreshold?: number;
  looseThreshold?: number;
  gitBinary?: string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-git-maintenance-'));
  roots.push(root);
  const logLines: Array<Record<string, unknown>> = [];
  const log = new OperationalLog('info', (line) => {
    logLines.push(JSON.parse(line) as Record<string, unknown>);
  });
  const server = await createObtsServer(
    {
      dataDir: join(root, 'data'),
      sessionSecret: 'git-maintenance-test-secret-with-entropy',
      ...(options.gitBinary === undefined ? {} : { gitBinary: options.gitBinary })
    },
    {
      operationalLog: log,
      gitMaintenance: {
        ...(options.packThreshold === undefined ? {} : { packThreshold: options.packThreshold }),
        ...(options.looseThreshold === undefined ? {} : { looseThreshold: options.looseThreshold })
      }
    }
  );
  servers.push(server);
  const setup = await server.app.inject({
    method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'test-password-with-entropy' }
  });
  expect(setup.statusCode).toBe(201);
  const created = await server.app.inject({
    method: 'POST', url: '/api/v1/vaults',
    headers: { cookie: setup.headers['set-cookie'], 'x-obts-csrf': setup.json().csrf_token },
    payload: { display_name: 'Maintenance fixture' }
  });
  expect(created.statusCode).toBe(201);
  const vaultId = created.json().vault_id as string;
  const token = 'git-maintenance-fixture-device-token';
  const tokenHash = hashToken(token);
  const timestamp = new Date().toISOString();
  await server.store.mutate((db) => {
    const user = db.users[0]!;
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId)!;
    db.devices.push({
      device_id: 'dev_maint', vault_id: vaultId, user_id: user.user_id, device_name: 'Maintenance fixture',
      device_ref: 'refs/obts/devices/dev_maint', device_ref_head: vault.current_main, status: 'synced',
      last_applied_main: vault.current_main, last_applied_event_seq: 0, last_applied_explicit_dirs: [],
      pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null,
      last_seen_at: null, last_successful_sync_at: null, local_status_label: null, local_error_code: null,
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: 'complete', onboarding_mode: 'use_server',
      initial_proposal_kind: null, initial_proposal_base: null, onboarding_connection_id: null,
      onboarding_completed_at: timestamp, created_at: timestamp, revoked_at: null
    });
    db.tokens.push({
      token_id: 'tok_maint', kind: 'device', lookup_prefix: tokenHash.lookupPrefix, token_hash: tokenHash.hash,
      user_id: user.user_id, vault_id: vaultId, device_id: 'dev_maint', expires_at: null, consumed_at: null,
      failed_attempts: 0, revoked_at: null, metadata: {}, created_at: timestamp
    });
  });
  const initialAuth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  const f: Fixture = { server, auth: initialAuth, token, vaultId, repo: server.git.repoPath(vaultId), root, logLines };
  const initial = await commit(f, initialAuth.vault.current_main, { 'note.md': NOTE });
  await setMain(f, initial);
  await server.git.updateRef(vaultId, initialAuth.device.device_ref, initial, null);
  await server.store.mutate((db) => {
    const device = db.devices.find((candidate) => candidate.device_id === initialAuth.device.device_id)!;
    device.device_ref_head = initial;
    device.last_applied_main = initial;
  });
  f.auth = await server.auth.authenticateDevice(`Bearer ${token}`, vaultId);
  return f;
}

async function commit(f: Fixture, parent: string, writes: Writes): Promise<string> {
  const tree = await f.server.git.createTreeFromCommitWithChanges({
    vaultId: f.vaultId,
    sourceCommit: parent,
    writes: new Map(Object.entries(writes).filter((entry): entry is [string, string | Buffer] => entry[1] !== null)
      .map(([path, bytes]) => [path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])),
    deletes: Object.entries(writes).filter(([, bytes]) => bytes === null).map(([path]) => path)
  });
  const device = (await f.server.store.snapshot()).devices.find((candidate) => candidate.device_id === 'dev_maint')!;
  return await f.server.git.createMainCommitFromTree({
    vaultId: f.vaultId, tree, parentMain: parent, subject: `fixture edit ${++commitSequence}`,
    body: `device_ref=${device.device_ref}`, actor: 'fixture'
  });
}

async function setMain(f: Fixture, main: string): Promise<void> {
  const current = await f.server.git.getRef(f.vaultId, 'refs/heads/main');
  await f.server.git.updateRef(f.vaultId, 'refs/heads/main', main, current);
  await f.server.store.mutate((db) => {
    db.vaults.find((candidate) => candidate.vault_id === f.vaultId)!.current_main = main;
  });
}

async function currentMain(f: Fixture): Promise<string> {
  return (await f.server.git.getRef(f.vaultId, 'refs/heads/main'))!;
}

async function pushManifest(f: Fixture, target: string, base: string, pack: Buffer): Promise<DevicePushManifest> {
  const auth = await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
  return {
    api_version: API_VERSION, plugin_version: '0.7.8', vault_id: f.vaultId, device_id: auth.device.device_id,
    expected_device_ref: (await f.server.git.getRef(f.vaultId, auth.device.device_ref))!,
    target_commit: target, client_known_main: (await f.server.git.getRef(f.vaultId, 'refs/heads/main'))!,
    base_commit: base, packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length
  };
}

/**
 * Uploads one device commit the way the chunked transfer path does: the pack lands in a quarantine
 * repository that uses the canonical store as its alternate, then promotion copies the pack into the
 * canonical store. Every such push adds exactly one canonical pack, which is the growth this
 * maintenance exists to bound.
 */
async function stagedPush(f: Fixture, target: string, base: string): Promise<PushResult> {
  const transferRoot = join(f.root, `transfer-${++transferSequence}`);
  await mkdir(transferRoot, { recursive: true, mode: 0o700 });
  const transferRepo = join(transferRoot, 'repo.git');
  const canonicalObjects = join(f.repo, 'objects');
  await f.server.git.initializeTransferRepo(f.vaultId, transferRepo);
  const pack = await f.server.git.exportPack(f.vaultId, target, base);
  await f.server.git.importPackIntoRepo(transferRepo, pack, canonicalObjects);
  const manifest = await pushManifest(f, target, base, pack);
  const auth = await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
  const result = await f.server.sync.pushDeviceCommit(auth, manifest, Buffer.alloc(0), {
    reader: f.server.git.readerForRepo(transferRepo, canonicalObjects),
    promote: async () => await f.server.git.promoteTransferObjects(f.vaultId, transferRepo)
  });
  await rm(transferRoot, { recursive: true, force: true });
  return result;
}

async function directPush(f: Fixture, target: string, base: string): Promise<{ status: number; result: PushResult }> {
  const pack = await f.server.git.exportPack(f.vaultId, target, base);
  const manifest = await pushManifest(f, target, base, pack);
  const boundary = 'obts-git-maintenance-boundary';
  const response = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push`,
    headers: { authorization: `Bearer ${f.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      pack, Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  });
  return { status: response.statusCode, result: response.json() as PushResult };
}

describe('automatic Git pack consolidation', () => {
  it('bounds a pack backlog accumulated by real pushes and keeps every object reachable', async () => {
    const f = await fixture({ packThreshold: 1, looseThreshold: 10_000 });
    const objectsBefore = objectIds(f.repo);

    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    await f.server.gitMaintenance.whenIdle();
    expect(await packCount(f.repo)).toBe(1);
    expect(maintenanceEvents(f.logLines)).toEqual([]);

    // A reviewable conflict adds the second pack and keeps conflict refs (and the history behind them)
    // in the same repository; that push is the trigger the consolidation answers.
    const deviceHead = (await f.server.git.getRef(f.vaultId, 'refs/obts/devices/dev_maint'))!;
    const serverAdvance = await commit(f, await currentMain(f), { 'note.md': NOTE.replace('first', 'server') });
    await setMain(f, serverAdvance);
    const overlapping = await commit(f, deviceHead, { 'note.md': NOTE.replace('first', 'device') });
    expect((await stagedPush(f, overlapping, deviceHead)).status).toBe('conflicted');
    const conflict = (await f.server.store.snapshot()).conflicts[0]!;
    expect(conflict).toBeDefined();
    expect(await packCount(f.repo)).toBe(2);

    await f.server.gitMaintenance.whenIdle();
    expect(await packCount(f.repo)).toBeLessThanOrEqual(1);

    const runs = maintenanceEvents(f.logLines).filter((line) => line.packs_after !== undefined);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: 'request', vault_id: f.vaultId });
    expect(Number(runs[0]!.packs_before)).toBe(2);
    expect(Number(runs[0]!.packs_after)).toBeLessThanOrEqual(1);
    expect(typeof runs[0]!.duration_ms).toBe('number');
    // The run also folds the loose objects those pushes and merges wrote into a pack.
    expect(Number(runs[0]!.loose_before)).toBeGreaterThan(0);
    expect(Number(runs[0]!.loose_after)).toBe(0);

    // Nothing was pruned: every object the store held before the consolidation is still there.
    const objectsAfter = new Set(objectIds(f.repo));
    for (const oid of objectsBefore) expect(objectsAfter.has(oid)).toBe(true);
    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);

    const db = await f.server.store.snapshot();
    const vault = db.vaults.find((candidate) => candidate.vault_id === f.vaultId)!;
    for (const ref of [
      'refs/heads/main', 'refs/obts/devices/dev_maint',
      `refs/obts/conflicts/${conflict.conflict_id}/base`,
      `refs/obts/conflicts/${conflict.conflict_id}/current`,
      `refs/obts/conflicts/${conflict.conflict_id}/device`
    ]) expect(await f.server.git.getRef(f.vaultId, ref)).not.toBeNull();
    expect(await f.server.git.getRef(f.vaultId, 'refs/heads/main')).toBe(vault.current_main);
    nativeGit(f.repo, ['cat-file', '-e', `${vault.current_main}^{commit}`]);
    nativeGit(f.repo, ['cat-file', '-e', `${conflict.device_commit}^{commit}`]);
  });

  it('does not touch a repository that is below both thresholds', async () => {
    const f = await fixture({ packThreshold: 8, looseThreshold: 10_000 });
    f.server.sync.attachGitMaintenance(null);
    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    const packsBefore = await packCount(f.repo);
    expect(packsBefore).toBe(1);

    expect(await f.server.gitMaintenance.runIfNeeded(f.vaultId, 'request')).toBe(false);
    expect(await packCount(f.repo)).toBe(packsBefore);
    expect(maintenanceEvents(f.logLines)).toEqual([]);
    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);
  });

  it('keeps objects no ref reaches instead of pruning them', async () => {
    const f = await fixture({ packThreshold: 1, looseThreshold: 10_000 });
    f.server.sync.attachGitMaintenance(null);
    const dangling = nativeGit(f.repo, ['hash-object', '-w', '--stdin'], 'unreachable bytes\n').trim();
    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    const second = await currentMain(f);
    expect((await stagedPush(f, await commit(f, second, { 'two.md': 'two\n' }), second)).status).toBe('merged');
    expect(await packCount(f.repo)).toBe(2);

    expect(await f.server.gitMaintenance.runIfNeeded(f.vaultId, 'request')).toBe(true);
    expect(await packCount(f.repo)).toBeLessThanOrEqual(1);
    expect(nativeGit(f.repo, ['cat-file', '-t', dangling]).trim()).toBe('blob');
    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);
  });

  it('lets a push that arrives during a consolidation succeed', async () => {
    const wrapperRoot = await mkdtemp(join(tmpdir(), 'obts-git-wrapper-'));
    roots.push(wrapperRoot);
    const wrapper = await wrapperGit(wrapperRoot, 'slow');
    const f = await fixture({ packThreshold: 1, looseThreshold: 10_000, gitBinary: wrapper.binary });
    f.server.sync.attachGitMaintenance(null);
    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    const second = await currentMain(f);
    expect((await stagedPush(f, await commit(f, second, { 'two.md': 'two\n' }), second)).status).toBe('merged');
    expect(await packCount(f.repo)).toBe(2);

    const maintenance = f.server.gitMaintenance.runIfNeeded(f.vaultId, 'request');
    const mainBefore = await currentMain(f);
    const pushed = await directPush(f, await commit(f, mainBefore, { 'three.md': 'three\n' }), mainBefore);
    expect(pushed.status).toBe(200);
    expect(pushed.result.status).toBe('merged');
    expect(await maintenance).toBe(true);
    await f.server.gitMaintenance.whenIdle();

    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);
    const result = pushed.result;
    if (result.status !== 'merged') throw new Error('merge missing');
    expect(await currentMain(f)).toBe(result.main);
    expect((await f.server.git.readBlobAtPath(f.vaultId, result.main, 'three.md')).toString()).toBe('three\n');
  });

  it('never fails a push when the consolidation itself fails', async () => {
    const wrapperRoot = await mkdtemp(join(tmpdir(), 'obts-git-wrapper-'));
    roots.push(wrapperRoot);
    const wrapper = await wrapperGit(wrapperRoot, 'fail');
    const f = await fixture({ packThreshold: 1, looseThreshold: 10_000, gitBinary: wrapper.binary });
    f.server.sync.attachGitMaintenance(null);
    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    const second = await currentMain(f);
    const pushed = await stagedPush(f, await commit(f, second, { 'two.md': 'two\n' }), second);
    expect(pushed.status).toBe('merged');
    expect(await packCount(f.repo)).toBe(2);

    f.server.sync.attachGitMaintenance(f.server.gitMaintenance);
    f.server.gitMaintenance.schedule(f.vaultId);
    await f.server.gitMaintenance.whenIdle();

    const failed = f.logLines.filter((line) => line.event === 'background_task_failed' && line.task === 'git_maintenance');
    expect(failed).toHaveLength(1);
    expect(await loggedSubcommands(wrapper.log)).toEqual(['repack']);
    expect(f.server.git.isDurabilityUnavailable()).toBe(false);
    expect(await packCount(f.repo)).toBe(2);
    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);
    // The failed consolidation did not damage the store: an ordinary push still integrates.
    const third = await currentMain(f);
    const after = await stagedPush(f, await commit(f, third, { 'three.md': 'three\n' }), third);
    expect(after.status).toBe('merged');
    await f.server.gitMaintenance.whenIdle();
  });

  it('coalesces a burst of pushes into a single consolidation and skips inactive vaults', async () => {
    const wrapperRoot = await mkdtemp(join(tmpdir(), 'obts-git-wrapper-'));
    roots.push(wrapperRoot);
    const wrapper = await wrapperGit(wrapperRoot, 'plain');
    const f = await fixture({ packThreshold: 2, looseThreshold: 10_000, gitBinary: wrapper.binary });
    for (const name of ['one', 'two', 'three']) {
      const base = await currentMain(f);
      expect((await stagedPush(f, await commit(f, base, { [`${name}.md`]: `${name}\n` }), base)).status).toBe('merged');
    }
    await f.server.gitMaintenance.whenIdle();
    await f.server.gitMaintenance.whenIdle();

    expect(await loggedSubcommands(wrapper.log)).toEqual(['repack', 'commit-graph']);
    expect(await packCount(f.repo)).toBeLessThanOrEqual(2);

    await f.server.store.mutate((db) => {
      db.vaults.find((candidate) => candidate.vault_id === f.vaultId)!.status = 'blocked_integrity';
    });
    const before = await packCount(f.repo);
    expect(await f.server.gitMaintenance.runIfNeeded(f.vaultId, 'request')).toBe(false);
    expect(await packCount(f.repo)).toBe(before);
  });

  it('consolidates a backlog at startup and reports it as a startup run', async () => {
    const f = await fixture({ packThreshold: 1, looseThreshold: 10_000 });
    f.server.sync.attachGitMaintenance(null);
    const base = await currentMain(f);
    expect((await stagedPush(f, await commit(f, base, { 'one.md': 'one\n' }), base)).status).toBe('merged');
    const second = await currentMain(f);
    expect((await stagedPush(f, await commit(f, second, { 'two.md': 'two\n' }), second)).status).toBe('merged');
    expect(await packCount(f.repo)).toBe(2);

    await f.server.gitMaintenance.startupSweep();
    expect(await packCount(f.repo)).toBeLessThanOrEqual(1);
    const runs = maintenanceEvents(f.logLines).filter((line) => line.packs_after !== undefined);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: 'startup', vault_id: f.vaultId });
    nativeGit(f.repo, ['fsck', '--strict', '--no-dangling']);
  });
});
