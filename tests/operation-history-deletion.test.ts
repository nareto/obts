import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import * as deletionRoot from '../src/server/deletionRoot.js';
import { MetadataStore } from '../src/server/metadataStore.js';
import { OperationHistoryStore } from '../src/server/operationHistoryStore.js';

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-history-erase-'));
  roots.push(root);
  const store = new MetadataStore(root);
  try {
    await store.initialize();
    await store.mutate((db) => {
      db.vaults.push({
        vault_id: 'vlt_history', owner_user_id: 'usr_history', display_name: 'History', status: 'active',
        current_main: 'a'.repeat(40), created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
      });
      const operation = store.startOperation(db, {
        vault_id: 'vlt_history', device_id: null, operation_type: 'device_push',
        expected_refs: {}, target_refs: {}, target_commit: null
      });
      operation.status = 'aborted';
      operation.result = { evidence: 'retained synthetic payload' };
    });
    await store.archiveCompletedHistory('vlt_history');
  } finally {
    await store.close();
  }
  const directory = join(root, 'metadata', 'operation-history', 'vlt_history');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'history.sqlite'), 'external sentinel');
  await writeFile(join(directory, 'history.sqlite-journal'), 'attributable journal bytes');
  const metadata = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
  const ledgerId = metadata.operation_history_by_vault.vlt_history.ledger_id as string;
  return { root, directory, outside, ledgerId };
}

async function recoveryScratch(directory: string, vaultId: string, ledgerId: string, purpose = 'recovery'): Promise<string> {
  const name = `.${purpose}-${createHash('sha256').update(JSON.stringify([vaultId, ledgerId])).digest('hex')}`;
  const path = join(directory, name);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'history.sqlite'), await readFile(join(directory, 'history.sqlite')), { mode: 0o600 });
  await writeFile(join(path, 'history.sqlite-journal'), 'private interrupted copy journal', { mode: 0o600 });
  return path;
}

describe.each(['recovery', 'initial'])('operation history descriptor-relative %s scratch erasure', (purpose) => {
  it.each(['unknown-file', 'unknown-directory', 'symlink', 'permissions', 'foreign-namespace'] as const)(
    'refuses unowned recovery residue (%s) without recursively deleting it', async (kind) => {
      const { directory, outside, ledgerId } = await fixture();
      const scratch = await recoveryScratch(directory, 'vlt_history', kind === 'foreign-namespace' ? 'hist_untrusted' : ledgerId, purpose);
      if (kind === 'unknown-file') await writeFile(join(scratch, 'unknown'), 'unrelated');
      if (kind === 'unknown-directory') await mkdir(join(scratch, 'unknown'));
      if (kind === 'symlink') {
        await rm(join(scratch, 'history.sqlite-journal'));
        await symlink(join(outside, 'history.sqlite'), join(scratch, 'history.sqlite-journal'));
      }
      if (kind === 'permissions') await fs.chmod(scratch, 0o755);
      const original = await readFile(join(directory, 'history.sqlite'));
      await expect(OperationHistoryStore.eraseDirectory(directory, { vaultId: 'vlt_history', ledgerId })).rejects.toThrow();
      expect(await readFile(join(directory, 'history.sqlite'))).toEqual(original);
      await access(join(scratch, 'history.sqlite'));
      expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    }
  );

  it('refuses a scratch root swap during descriptor-relative cleanup', async () => {
    const { directory, outside, ledgerId } = await fixture();
    const scratch = await recoveryScratch(directory, 'vlt_history', ledgerId, purpose);
    const original = deletionRoot.removeDeletionRootFileChild;
    vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockImplementationOnce(async (...args) => {
      await rename(scratch, `${scratch}.saved`);
      await symlink(outside, scratch);
      await original(...args);
    });
    await expect(OperationHistoryStore.eraseDirectory(directory, { vaultId: 'vlt_history', ledgerId })).rejects.toThrow();
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    await access(join(directory, 'history.sqlite'));
    await access(join(`${scratch}.saved`, 'history.sqlite'));
  });

  it.each(['scratch', 'parent'] as const)('withholds the receipt after %s cleanup failure and resumes deletion on restart without recreating history', async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), 'obts-history-delete-restart-'));
    roots.push(root);
    const options = { dataDir: root, sessionSecret: 'test-session-secret-with-enough-entropy' };
    const server = await createObtsServer(options);
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: {
      username: 'owner', password: 'correct horse battery staple'
    } });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({ method: 'POST', url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf }, payload: { display_name: 'History deletion' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    await server.store.mutate((db) => {
      const operation = server.store.startOperation(db, {
        vault_id: vaultId, device_id: null, operation_type: 'device_push',
        expected_refs: {}, target_refs: {}, target_commit: null
      });
      operation.status = 'aborted';
      operation.result = { evidence: 'archived payload for physical deletion' };
    });
    await server.store.archiveCompletedHistory(vaultId);
    expect(await server.store.exportOperationHistory(vaultId)).toHaveLength(1);
    const parent = join(root, 'metadata', 'operation-history');
    const directory = join(parent, vaultId);
    const state = (await server.store.snapshot()).operation_history_by_vault![vaultId]!;
    const scratch = await recoveryScratch(directory, vaultId, state.ledger_id, purpose);
    const originalRemove = deletionRoot.removeDeletionRootFileChild;
    vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockImplementation(async (...args) => {
      if (boundary === 'scratch' && args[0].configuredPath === scratch) {
        failed = true;
        throw new Error('injected scratch cleanup failure');
      }
      await originalRemove(...args);
    });
    const originalSync = deletionRoot.syncDeletionRoot;
    let failed = false;
    vi.spyOn(deletionRoot, 'syncDeletionRoot').mockImplementation(async (opened) => {
      if (boundary === 'parent' && opened.configuredPath === parent) {
        failed = true;
        throw new Error('injected parent fsync failure');
      }
      await originalSync(opened);
    });
    const accepted = await server.app.inject({ method: 'DELETE', url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf }, payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(failed).toBe(true));
    const pending = await server.store.snapshot();
    expect(pending.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(pending.deletion_receipts).toEqual([]);
    if (boundary === 'parent') await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    else await access(join(scratch, 'history.sqlite'));
    await server.app.close();
    vi.restoreAllMocks();
    let parentSynced = false;
    vi.spyOn(deletionRoot, 'syncDeletionRoot').mockImplementation(async (opened) => {
      if (opened.configuredPath === parent) {
        const disk = JSON.parse(await readFile(join(root, 'metadata', 'phase1.json'), 'utf8'));
        expect(disk.deletion_receipts).toEqual([]);
        await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
        await originalSync(opened);
        parentSynced = true;
      } else await originalSync(opened);
    });
    const restarted = await createObtsServer(options);
    servers.push(restarted);
    await vi.waitFor(async () => {
      const snapshot = await restarted.store.snapshot();
      expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(true);
    });
    expect(parentSynced).toBe(true);
    expect((await restarted.store.snapshot()).operation_history_by_vault?.[vaultId]).toBeUndefined();
    await expect(restarted.store.findArchivedAttempt(vaultId, 'dev_deleted', 'attempt_deleted')).rejects.toThrow();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});

describe('operation history descriptor-relative erasure', () => {
  it('preserves the external sentinel when the directory is replaced immediately after file lstat', async () => {
    const { directory, outside } = await fixture();
    const original = fs.lstat;
    let swapped = false;
    vi.spyOn(fs, 'lstat').mockImplementation((async (path, options) => {
      const result = await original(path, options);
      if (!swapped && String(path).endsWith('/history.sqlite')) {
        swapped = true;
        await rename(directory, `${directory}.saved`);
        await symlink(outside, directory);
      }
      return result;
    }) as typeof fs.lstat);
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    expect((await readFile(join(`${directory}.saved`, 'history.sqlite'))).includes(Buffer.from('retained synthetic payload'))).toBe(true);
  });

  it.each(['symlink', 'directory'] as const)('refuses a root replacement with a %s after inventory without deleting external bytes', async (replacement) => {
    const { directory, outside } = await fixture();
    const moved = `${directory}.saved`;
    const original = deletionRoot.removeDeletionRootFileChild;
    const barrier = vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockImplementationOnce(async (...args) => {
      await rename(directory, moved);
      if (replacement === 'symlink') await symlink(outside, directory);
      else await rename(outside, directory);
      await original(...args);
    });
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toThrow();
    expect(barrier).toHaveBeenCalled();
    expect(await readFile(join(replacement === 'symlink' ? outside : directory, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    expect((await readFile(join(moved, 'history.sqlite'))).includes(Buffer.from('retained synthetic payload'))).toBe(true);
    if (replacement === 'symlink') await rm(directory);
    else await rename(directory, outside);
    await rename(moved, directory);
    await OperationHistoryStore.eraseDirectory(directory);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
  });

  it.each(['symlink', 'directory', 'file'] as const)('refuses a child replacement with a %s after inventory and remains resumable', async (replacement) => {
    const { directory, outside } = await fixture();
    const original = deletionRoot.removeDeletionRootFileChild;
    let replacedName = '';
    const barrier = vi.spyOn(deletionRoot, 'removeDeletionRootFileChild').mockImplementationOnce(async (root, name, identity) => {
      replacedName = name;
      await rename(join(directory, name), join(outside, 'saved-payload'));
      if (replacement === 'symlink') await symlink(join(outside, 'history.sqlite'), join(directory, name));
      else if (replacement === 'directory') {
        await mkdir(join(directory, name));
        await writeFile(join(directory, name, 'unknown'), 'unknown bytes');
      } else await writeFile(join(directory, name), 'replacement bytes');
      await original(root, name, identity);
    });
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toThrow();
    expect(barrier).toHaveBeenCalled();
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    if (replacement === 'directory') expect(await readFile(join(directory, replacedName, 'unknown'), 'utf8')).toBe('unknown bytes');
    if (replacement === 'file') expect(await readFile(join(directory, replacedName), 'utf8')).toBe('replacement bytes');
    await rm(join(directory, replacedName), { recursive: true });
    await rename(join(outside, 'saved-payload'), join(directory, replacedName));
    await OperationHistoryStore.eraseDirectory(directory);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not recursively erase unknown residue arriving after inventory', async () => {
    const { directory, outside } = await fixture();
    const original = deletionRoot.removeEmptyDeletionRootDirectoryChild;
    vi.spyOn(deletionRoot, 'removeEmptyDeletionRootDirectoryChild').mockImplementationOnce(async (...args) => {
      await mkdir(join(directory, 'unknown'));
      await writeFile(join(directory, 'unknown', 'sentinel'), 'new residue');
      await original(...args);
    });
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(await readFile(join(directory, 'unknown', 'sentinel'), 'utf8')).toBe('new residue');
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toThrow('Unexpected operation history residue.');
    await rename(join(directory, 'unknown'), join(outside, 'unknown'));
    await OperationHistoryStore.eraseDirectory(directory);
  });

  it.each(['vault', 'parent'] as const)('propagates a %s fsync failure and repeats the barrier on retry', async (boundary) => {
    const { root, directory, outside } = await fixture();
    const parent = join(root, 'metadata', 'operation-history');
    const target = boundary === 'vault' ? directory : parent;
    const original = deletionRoot.syncDeletionRoot;
    const calls: string[] = [];
    let fail = true;
    vi.spyOn(deletionRoot, 'syncDeletionRoot').mockImplementation(async (opened) => {
      calls.push(opened.configuredPath);
      if (opened.configuredPath === target && fail) throw new Error('injected history erase fsync failure');
      await original(opened);
    });
    await expect(OperationHistoryStore.eraseDirectory(directory)).rejects.toThrow('injected history erase fsync failure');
    expect(calls.at(-1)).toBe(target);
    fail = false;
    await OperationHistoryStore.eraseDirectory(directory);
    expect(calls.at(-1)).toBe(parent);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(outside, 'history.sqlite'), 'utf8')).toBe('external sentinel');
  });
});
