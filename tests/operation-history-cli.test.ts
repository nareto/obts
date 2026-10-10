import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import type { MetadataDb, SyncOperationRow } from '../src/server/metadataStore.js';
import { historyCheckpointFixture } from './helpers/historyCheckpointFixture.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];
const bodyCanary = 'HISTLEAK';
const pathCanary = 'synthetic-private-note.md';
const credentialCanary = 'synthetic-credential-not-for-output';

beforeAll(async () => {
  for (const file of await readdir('src', { recursive: true })) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const [source, built] = await Promise.all([stat(join('src', file)), stat(join('dist', 'src', file.replace(/\.ts$/u, '.js')))]);
    expect(built.mtimeMs, `Rebuild current dist before CLI tests: ${file}`).toBeGreaterThanOrEqual(source.mtimeMs);
  }
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-history-cli-'));
  roots.push(root);
  const f = await historyCheckpointFixture(root);
  servers.push(f.server);
  return { ...f, root, metadataPath: join(root, 'metadata', 'phase1.json') };
}

async function cli(root: string, args: string[]) {
  try {
    const output = await promisify(execFile)(process.execPath, [resolve('dist/src/cli.js'), ...args], {
      env: { ...process.env, OBTS_DATA_DIR: root, OBTS_SESSION_SECRET: 'checkpoint-test-secret',
        OBTS_GIT_STORE_DIR: join(root, 'git'), OBTS_TEMP_DIR: join(root, 'tmp'),
        OBTS_LOG_LEVEL: 'debug', OBTS_TEST_CREDENTIAL: credentialCanary }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024
    });
    return { code: 0, ...output };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    if (typeof failure.code !== 'number') throw error;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function addRow(f: Awaited<ReturnType<typeof fixture>>, status: SyncOperationRow['status'], explicitNull = false) {
  return await f.server.store.mutate((db) => {
    const row = f.server.store.startOperation(db, {
      vault_id: f.auth.vault.vault_id, device_id: f.auth.device.device_id, operation_type: 'device_push',
      expected_refs: {}, target_refs: {}, target_commit: f.m0, ...(explicitNull ? { proposal_base: null } : {})
    });
    row.status = status;
    row.prepared_manifest = { attempt_id: row.operation_id, attempt_hash: 'synthetic-hash',
      rename_pairs: [{ source_path: pathCanary, destination_path: 'renamed.md' }],
      directory_proposal: { proposal_id: 'synthetic-directory-proposal', explicit_dirs: ['Private folder'] }, payload: bodyCanary };
    row.result = status === 'aborted' ? { reason: 'fixture' } : null;
    return row;
  });
}

it('built offline CLI exports complete interleaved hot+cold evidence in original order, preserving absent and null fields', async () => {
  const f = await fixture();
  const first = await addRow(f, 'started');
  const second = await addRow(f, 'aborted', true);
  const third = await addRow(f, 'started', true);
  const fourth = await addRow(f, 'aborted');
  const vaultId = f.auth.vault.vault_id;
  await f.server.sync.archiveStartupHistory(vaultId);
  expect((await f.server.store.snapshot()).sync_operations.map((row) => row.operation_id)).toEqual([first.operation_id, third.operation_id]);
  await f.server.store.mutate((db) => {
    for (const row of db.sync_operations) { row.status = 'aborted'; row.result = { reason: 'fixture' }; }
    db.vaults[0]!.status = 'blocked_integrity';
  });
  const expected: SyncOperationRow[] = [
    { ...first, status: 'aborted', result: { reason: 'fixture' } }, second,
    { ...third, status: 'aborted', result: { reason: 'fixture' } }, fourth
  ];
  expect(await f.server.store.exportOperationHistory(vaultId)).toEqual(expected);
  const before = await readFile(f.metadataPath);
  await f.server.app.close();
  const exported = await cli(f.root, ['history', 'export', '--vault-id', vaultId]);
  expect(exported.code).toBe(0);
  expect(JSON.parse(exported.stdout)).toEqual({ vault_id: vaultId, operations: expected });
  const operations = JSON.parse(exported.stdout).operations as SyncOperationRow[];
  expect(operations.map((row) => Object.hasOwn(row, 'proposal_base'))).toEqual([false, true, true, false]);
  expect(operations[1]!.proposal_base).toBeNull();
  expect(operations[2]!.proposal_base).toBeNull();
  expect(exported.stdout).toContain(bodyCanary);
  expect(exported.stdout).toContain(pathCanary);
  expect(exported.stdout).not.toContain(credentialCanary);
  expect(exported.stderr).not.toContain(bodyCanary);
  expect(exported.stderr).not.toContain(pathCanary);
  expect(exported.stderr).not.toContain(credentialCanary);
  expect(await readFile(f.metadataPath)).toEqual(before);
});

it('built offline export runs schema migration and startup recovery rather than read-only inspection', async () => {
  const f = await fixture();
  const aborted = await addRow(f, 'aborted', true);
  const started = await addRow(f, 'started');
  await f.server.app.close();
  const legacy = JSON.parse(await readFile(f.metadataPath, 'utf8'));
  legacy.schema_version = 7;
  delete legacy.operation_history_by_vault;
  for (const row of legacy.sync_operations) delete row.operation_sequence;
  await writeFile(f.metadataPath, JSON.stringify(legacy));
  await rm(join(f.root, 'metadata', 'operation-history'), { recursive: true });
  const exported = await cli(f.root, ['history', 'export', '--vault-id', f.auth.vault.vault_id]);
  expect(exported.code).toBe(0);
  const operations = JSON.parse(exported.stdout).operations as SyncOperationRow[];
  expect(operations).toHaveLength(2);
  expect(operations[0]).toEqual(aborted);
  expect(operations[1]).toEqual({ ...started, status: 'aborted', result: { reason: 'startup_unprepared_operation' }, updated_at: expect.any(String) });
  expect(Date.parse(operations[1]!.updated_at)).toBeGreaterThanOrEqual(Date.parse(started.updated_at));
  const after = JSON.parse(await readFile(f.metadataPath, 'utf8')) as MetadataDb;
  expect(after.schema_version).toBe(8);
  expect(after.sync_operations).toEqual([]);
  expect(after.operation_history_by_vault![f.auth.vault.vault_id]!.generation).toBeGreaterThan(0);
  const again = await cli(f.root, ['history', 'export', '--vault-id', f.auth.vault.vault_id]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout)).toEqual(JSON.parse(exported.stdout));
});

it('built export resumes durable deletion jobs and drains erasure before exiting', async () => {
  const f = await fixture();
  await addRow(f, 'aborted');
  const vaultId = f.auth.vault.vault_id;
  await f.server.sync.archiveStartupHistory(vaultId);
  await f.server.store.mutate((db) => {
    db.vaults[0]!.status = 'deleting';
    db.deletion_jobs.push({ vault_id: vaultId, owner_user_id: f.auth.user.user_id,
      requested_at: new Date().toISOString(), phase: 'intent', retry_at: null, error_code: null });
  });
  await f.server.app.close();
  const exported = await cli(f.root, ['history', 'export', '--vault-id', 'vlt_unknown']);
  expect(exported.code).toBe(2);
  expect(exported.stdout).toBe('');
  expect(exported.stderr).toContain('vault does not exist');
  const after = JSON.parse(await readFile(f.metadataPath, 'utf8')) as MetadataDb;
  expect(after.deletion_jobs).toEqual([]);
  expect(after.deletion_receipts).toHaveLength(1);
  expect(after.deletion_receipts[0]!.vault_id).toBe(vaultId);
  expect(after.vaults).toEqual([]);
  expect(JSON.stringify(after)).not.toContain(bodyCanary);
  await expect(access(join(f.root, 'metadata', 'operation-history', vaultId))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(f.server.git.repoPath(vaultId))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { name: 'missing option', args: ['history', 'export'] },
  { name: 'missing value', args: ['history', 'export', '--vault-id'] },
  { name: 'empty value', args: ['history', 'export', '--vault-id='] },
  { name: 'unknown vault', args: ['history', 'export', '--vault-id', 'vlt_unknown'] },
  { name: 'extra positional', args: ['history', 'export', '--vault-id', 'vlt_unknown', bodyCanary] },
  { name: 'extra option', args: ['history', 'export', '--vault-id', 'vlt_unknown', `--${credentialCanary}=value`] }
])('built export rejects $name without echoing confidential input', async ({ args }) => {
  const f = await fixture();
  await f.server.app.close();
  const result = await cli(f.root, args);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/missing required option --vault-id|vault does not exist|history export accepts only --vault-id/u);
  expect(result.stderr).not.toContain(bodyCanary);
  expect(result.stderr).not.toContain(credentialCanary);
});

it('built export rejects extra options and positionals for an existing vault instead of silently exporting', async () => {
  const f = await fixture();
  await addRow(f, 'aborted');
  await f.server.app.close();
  for (const suffix of [[bodyCanary], [`--${credentialCanary}=value`]]) {
    const result = await cli(f.root, ['history', 'export', '--vault-id', f.auth.vault.vault_id, ...suffix]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('history export accepts only --vault-id');
    expect(result.stderr).not.toContain(bodyCanary);
    expect(result.stderr).not.toContain(credentialCanary);
  }
});

it.each(['malformed-json', 'missing-ledger'] as const)('built export fails safely on %s without raw storage payloads or credentials', async (failure) => {
  const f = await fixture();
  await addRow(f, 'aborted');
  const vaultId = f.auth.vault.vault_id;
  await f.server.sync.archiveStartupHistory(vaultId);
  await f.server.app.close();
  if (failure === 'malformed-json') await writeFile(f.metadataPath, `${bodyCanary} ${credentialCanary}`);
  else await rm(join(f.root, 'metadata', 'operation-history', vaultId, 'history.sqlite'));
  const result = await cli(f.root, ['history', 'export', '--vault-id', vaultId]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  for (const secret of [bodyCanary, pathCanary, credentialCanary, f.root]) expect(result.stderr).not.toContain(secret);
  expect(result.stderr).toContain('history export unavailable');
});

it('built export validates malformed arguments before creating or recovering storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obts-history-cli-args-'));
  roots.push(root);
  const absent = join(root, 'not-initialized');
  for (const args of [
    ['history', 'export'], ['history', 'export', '--vault-id'], ['history', 'export', '--vault-id='],
    ['history', 'export', '--vault-id=vlt_unknown', bodyCanary],
    ['history', 'export', '--vault-id=vlt_unknown', `--${credentialCanary}=value`]
  ]) {
    const result = await cli(absent, args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    for (const secret of [bodyCanary, credentialCanary]) expect(result.stderr).not.toContain(secret);
    await expect(access(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it.each([false, true])('built export suppresses a storage failure and its confidential cause (shutdown failure=%s)', async (failClose) => {
  const f = await fixture();
  await addRow(f, 'aborted');
  await f.server.app.close();
  const script = `
    import { runCli } from './dist/src/cli.js';
    import { MetadataStore } from './dist/src/server/metadataStore.js';
    MetadataStore.prototype.exportOperationHistory = async function () {
      throw new Error(${JSON.stringify(bodyCanary)}, { cause: new Error(${JSON.stringify(credentialCanary)}) });
    };
    if (${failClose}) {
      const close = MetadataStore.prototype.close;
      MetadataStore.prototype.close = async function () {
        await close.call(this);
        throw new Error(${JSON.stringify(credentialCanary)});
      };
    }
    process.exitCode = await runCli(['history', 'export', '--vault-id', ${JSON.stringify(f.auth.vault.vault_id)}]);
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, OBTS_DATA_DIR: f.root, OBTS_SESSION_SECRET: 'checkpoint-test-secret',
      OBTS_GIT_STORE_DIR: join(f.root, 'git'), OBTS_TEMP_DIR: join(f.root, 'tmp') }, timeout: 20_000
  }).then(() => { throw new Error('Expected export to fail.'); }, (error: Error & { code: number; stdout: string; stderr: string }) => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('history export unavailable');
  for (const secret of [bodyCanary, pathCanary, credentialCanary, f.root]) expect(result.stderr).not.toContain(secret);
});
