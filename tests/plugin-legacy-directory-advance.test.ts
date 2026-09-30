import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';
import { API_VERSION } from '../src/shared/types.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const save = async (root: string, name: string, value: unknown) =>
  writeFile(join(root, '.obts', name), `${JSON.stringify(value)}\n`);

async function restartFixture(root: string, serverRef: string, target: string) {
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'legacy-test' });
  await plugin.initialize();
  const core = (plugin as any).client;
  core.readDeviceToken = vi.fn(async () => 'test-token');
  core.cancelLegacyDirectoryTransfer = vi.fn(async () => undefined);
  core.getDeviceSelf = vi.fn(async () => ({ server_device_ref: serverRef, last_applied_main: target }));
  core.settlePreviouslyAppliedPullCheckpoint = vi.fn(async () => {
    await rm(join(root, '.obts', 'pull-transfer.json'), { force: true });
  });
  return core;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-legacy-advance-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'legacy-test' });
  await plugin.initialize();
  const core = (plugin as any).client;
  await writeFile(join(root, '.gitignore'), '/.local-cache/\n');
  await writeFile(join(root, 'unchanged.md'), 'base\n');
  const serverRef = await core.createLocalCommit('server baseline');
  await writeFile(join(root, 'baseline.md'), 'baseline\n');
  const base = await core.createLocalCommit('local baseline');
  const baseTree = (await git.readCommit({ fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir, oid: base })).commit.tree;
  const pending = await git.commit({
    fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir, ref: 'refs/heads/orphan',
    tree: baseTree, parent: [base], message: 'empty pending metadata',
    author: { name: 'Test', email: 'test@example.com' }
  });
  await writeFile(join(root, '.gitignore'), '/.local-cache/\n*.bak\n');
  await writeFile(join(root, 'target.md'), 'target bytes\n');
  const target = await core.createLocalCommit('applied target');
  const policy = await core.targetApplyPolicy(target);
  expect(policy.policy.ignores('.local-cache', true)).toBe(true);
  await mkdir(join(root, '.local-cache'));
  await writeFile(join(root, '.local-cache', 'untouched.md'), 'local-only bytes\n');
  await writeFile(join(root, 'unchanged.md'), 'unsynced bytes\n');
  const newCommit = await core.createLocalCommit('preserve unsynced bytes');
  await core.updateRef('refs/heads/main', target, null, true);
  const state = {
    ...await core.readState(), vault_id: 'vlt_test', device_id: 'dev_test',
    local_main: target, local_head: newCommit, server_device_ref: serverRef,
    last_event_seq: 6, last_applied_event_seq: 6, last_error_code: null
  };
  await core.writeState(state);
  await core.writeQueue({ pending_commit: newCommit, expected_device_ref: serverRef,
    status: 'queued_local', attempts: 0, change_seq: 3, changed_paths: ['unchanged.md'], updated_at: new Date().toISOString() });
  const intent = { op: 'delete', path: '.local-cache', intent_id: 'dir_123_1_abcdefabcdef',
    generation: 1, provenance: 'local_v2', base_main: base, base_event_seq: 3,
    replaces_intent_id: null, recreated_after_delete: false, created_at: new Date().toISOString() };
  const journal = {
    version: 1, phase: 'main_advanced', vault_id: 'vlt_test', device_id: 'dev_test',
    local_main: base, local_head: pending, server_device_ref: serverRef,
    last_event_seq: 3, last_applied_event_seq: 3, pending_commit: pending,
    rejected_transfer_id: 'trn_legacy', rejected_checkpoint_identity: 'a'.repeat(64),
    rejected_attempt_id: '', rejected_plan_sha256: hash('[]'),
    original_pending_intents: [intent], target_explicit_directories: [], advanced_directory_intents: [
      { op: 'delete', path: intent.path }, { op: 'create', path: 'created-one' }, { op: 'create', path: 'created-two' }
    ], target_main: target, recovered_event_seq: 6, recovered_server_device_ref: serverRef,
    checkpoint_removal_authorized: false
  };
  const basePolicy = await core.targetApplyPolicy(base);
  const request = { target_commit: pending, expected_device_ref: serverRef,
    root_ignore_capability: 'root-ignore-v1', root_ignore_oid: basePolicy.oid, directory_proposal: {
    base_main: base, base_event_seq: 3, intents: [intent]
  }, chunk_count: 0, plan_sha256: hash('[]') };
  const attemptId = `xfer_${hash(JSON.stringify(request)).slice(0, 32)}`;
  journal.rejected_attempt_id = attemptId;
  const upload = { version: 1, identity: journal.rejected_checkpoint_identity, target_commit: pending,
    transfer_id: journal.rejected_transfer_id, attempt_id: attemptId, groups: [],
    transfer_request: request, directory_proposal: request.directory_proposal };
  const manifest = { api_version: API_VERSION, capability: 'git-object-pack-chunks-v1', complete: true,
    target_main: target, cursor: 0, next_cursor: 1, event_seq: 6, vault_id: 'vlt_test', device_id: 'dev_test',
    chunk_sha256: 'a'.repeat(64), chunk_bytes: 0, changed_paths: ['.gitignore', 'target.md'],
    target_file_sizes: {}, explicit_directories: [], directory_intents: journal.advanced_directory_intents,
    directory_acknowledgements: [],
    root_ignore_oid: policy.oid, current_local_main_is_ancestor: true };
  for (const [filePath, oid] of policy.entries) {
    (manifest.target_file_sizes as Record<string, number>)[filePath] = (await core.readBlobOid(oid)).byteLength;
  }
  const pull = { vault_id: 'vlt_test', device_id: 'dev_test', current_local_main: base,
    current_event_seq: 4, complete: true, target_main: target, next_cursor: 1,
    received_chunks: 1, transferred_bytes: 0, manifest_sha256: hash(JSON.stringify(manifest)), manifest };
  await core.writeDirectoryState({ observed_dirs: [], observed_directory_ctimes: {},
    explicit_empty_dirs: [], pending_intents: [], next_generation: 2, updated_at: new Date().toISOString() });
  await save(root, 'directory-baseline-recovery.json', journal);
  await save(root, 'upload-transfer.json', upload);
  await save(root, 'pull-transfer.json', pull);
  core.readDeviceToken = vi.fn(async () => 'test-token');
  core.cancelLegacyDirectoryTransfer = vi.fn(async () => undefined);
  core.getDeviceSelf = vi.fn(async () => ({ server_device_ref: serverRef, last_applied_main: target }));
  core.settlePreviouslyAppliedPullCheckpoint = vi.fn(async () => {
    await rm(join(root, '.obts', 'pull-transfer.json'), { force: true });
  });
  return { root, core, journal, upload, pull, target, base, pending, newCommit, serverRef };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('completed legacy directory advance settlement', () => {
  it('archives the rejected attempt and preserves a newer target-descendant queue and ignored local bytes', async () => {
    const { root, core, newCommit, serverRef } = await fixture();
    await expect(core.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(await core.readQueue()).toMatchObject({ pending_commit: newCommit,
      expected_device_ref: serverRef, changed_paths: ['unchanged.md'] });
    expect(await readFile(join(root, 'unchanged.md'), 'utf8')).toBe('unsynced bytes\n');
    expect(await readFile(join(root, '.local-cache', 'untouched.md'), 'utf8')).toBe('local-only bytes\n');
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8').catch(() => null)).toBeNull();
    expect(await core.settleCompletedLegacyDirectoryAdvance()).toBe(false);
  });

  it('settles a journal written before the explicit-directory field was renamed', async () => {
    const { root, core, journal } = await fixture();
    const legacy = { ...journal } as Record<string, unknown>;
    legacy.advanced_explicit_directories = journal.target_explicit_directories;
    delete legacy.target_explicit_directories;
    await save(root, 'directory-baseline-recovery.json', legacy);
    await expect(core.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('rejects a renamed explicit-directory field that disagrees with the pull checkpoint', async () => {
    const { root, core, journal } = await fixture();
    const legacy = { ...journal } as Record<string, unknown>;
    legacy.advanced_explicit_directories = ['not-the-advanced-snapshot'];
    delete legacy.target_explicit_directories;
    await save(root, 'directory-baseline-recovery.json', legacy);
    await expect(core.settleCompletedLegacyDirectoryAdvance())
      .rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
  });

  it('cancels a matching open rejected transfer and rejects a completed late outcome', async () => {
    const { core, journal } = await fixture();
    const cancel = Object.getPrototypeOf(core).cancelLegacyDirectoryTransfer;
    let deletes = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ transfer_id: journal.rejected_transfer_id,
        target_commit: journal.pending_commit, status: 'open' }), { status: 200 });
    }));
    try {
      await expect(cancel.call(core, await core.readState(), journal, 'test-token')).resolves.toBeUndefined();
      expect(deletes).toBe(1);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        transfer_id: journal.rejected_transfer_id, target_commit: journal.pending_commit, status: 'completed'
      }), { status: 200 })));
      await expect(cancel.call(core, await core.readState(), journal, 'test-token'))
        .rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
      expect(deletes).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retires only the original empty queue while preserving changed-path scan hints', async () => {
    const { root, core, target, pending, serverRef } = await fixture();
    await core.updateRef('refs/heads/local', target, null, true);
    await save(root, 'state.json', { ...await core.readState(), local_head: target });
    await core.writeQueue({ pending_commit: pending, expected_device_ref: serverRef,
      status: 'queued_local', attempts: 0, change_seq: 3, changed_paths: ['unchanged.md'], updated_at: new Date().toISOString() });
    expect(await core.resolveRef('refs/heads/main')).toBe(target);
    expect(await core.resolveRef('refs/heads/local')).toBe(target);
    expect(await core.readState()).toMatchObject({ local_main: target, local_head: target });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(await core.readQueue()).toMatchObject({ pending_commit: null,
      status: 'queued_local', changed_paths: ['unchanged.md'] });
  });

  it('reuses a verified archive after a fresh-client restart before authorization despite volatile field churn', async () => {
    const { root, core, target, serverRef, newCommit } = await fixture();
    const original = core.fsp.rename.bind(core.fsp);
    core.fsp.rename = vi.fn(async (source: string, destination: string) => {
      if (destination === core.directoryBaselineRecoveryPath) throw new Error('crash before authorization');
      return original(source, destination);
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('crash before authorization');
    core.fsp.rename = original;
    const archives = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '.obts', 'recovery')));
    const archivePath = join(root, '.obts', 'recovery', archives.find((name) => name.startsWith('legacy-baseline-'))!);
    const archived = JSON.parse(await readFile(archivePath, 'utf8'));
    await save(root, 'queue.json', { ...await core.readQueue(), attempts: 4, updated_at: new Date().toISOString() });
    const fresh = await restartFixture(root, serverRef, target);
    expect((await fresh.readState()).updated_at).not.toBe(archived.evidence.state.updated_at);
    await expect(fresh.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(JSON.parse(await readFile(archivePath, 'utf8'))).toEqual(archived);
    expect(await fresh.readQueue()).toMatchObject({ pending_commit: newCommit, changed_paths: ['unchanged.md'] });
  });

  it.each(['obsolete', 'null', 'unrelated-target-descendant', 'descendant-of-archived'])(
    'binds authorized recovery to archived queued work after %s queue change', async (change) => {
      const { root, core, target, pending, newCommit, serverRef } = await fixture();
      const original = core.fsp.rm.bind(core.fsp);
      core.fsp.rm = vi.fn(async (name: string, ...args: unknown[]) => {
        if (name === core.uploadTransferPath) throw new Error('pause after authorization');
        return original(name, ...args);
      });
      await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('pause after authorization');
      core.fsp.rm = original;
      let next = change === 'obsolete' ? pending : change === 'null' ? null : newCommit;
      if (change === 'unrelated-target-descendant' || change === 'descendant-of-archived') {
        const tree = (await git.readCommit({ fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir, oid: newCommit })).commit.tree;
        next = await git.commit({ fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir,
          ref: 'refs/heads/alternate', tree,
          parent: [change === 'descendant-of-archived' ? newCommit : target],
          message: 'subsequent queued history', author: { name: 'Test', email: 'test@example.com' } });
      }
      await core.updateRef('refs/heads/local', next || target, null, true);
      await save(root, 'state.json', { ...await core.readState(), local_head: next || target });
      await core.writeQueue({ ...await core.readQueue(), pending_commit: next });
      const fresh = await restartFixture(root, serverRef, target);
      if (change === 'descendant-of-archived') {
        await expect(fresh.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
        expect(await fresh.readQueue()).toMatchObject({ pending_commit: next });
      } else {
        await expect(fresh.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
        expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toContain('legacy_retirement_authorized');
        expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
      }
    }
  );

  it.each(['before-archive', 'after-archive', 'after-authorization', 'before-upload-removal',
    'before-queue-write', 'before-pull-removal', 'before-journal-clear'])(
    'restarts idempotently across the %s settlement boundary with verified evidence', async (boundary) => {
      const { root, core, journal, target, pending, serverRef, newCommit } = await fixture();
      if (boundary === 'before-queue-write') {
        await core.updateRef('refs/heads/local', target, null, true);
        await save(root, 'state.json', { ...await core.readState(), local_head: target });
        await core.writeQueue({ ...await core.readQueue(), pending_commit: pending });
      }
      const originalRename = core.fsp.rename.bind(core.fsp);
      const originalRm = core.fsp.rm.bind(core.fsp);
      core.fsp.rename = vi.fn(async (source: string, destination: string) => {
        if (boundary === 'before-archive' && destination.includes('legacy-baseline-') ||
          boundary === 'after-archive' && destination === core.directoryBaselineRecoveryPath ||
          boundary === 'before-queue-write' && destination === core.queuePath) throw new Error('injected settlement crash');
        return originalRename(source, destination);
      });
      core.fsp.rm = vi.fn(async (name: string, ...args: unknown[]) => {
        if (boundary === 'before-upload-removal' && name === core.uploadTransferPath ||
          boundary === 'before-pull-removal' && name === core.pullTransferPath ||
          boundary === 'before-journal-clear' && name === core.directoryBaselineRecoveryPath) throw new Error('injected settlement crash');
        return originalRm(name, ...args);
      });
      if (boundary === 'after-authorization') core.cancelLegacyDirectoryTransfer = vi.fn(async () => {
        throw new Error('injected settlement crash');
      });
      if (boundary === 'before-pull-removal') core.settlePreviouslyAppliedPullCheckpoint = vi.fn(async () => {
        await core.fsp.rm(core.pullTransferPath, { force: true });
      });
      await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('injected settlement crash');
      core.fsp.rename = originalRename;
      core.fsp.rm = originalRm;
      const archiveDir = join(root, '.obts', 'recovery');
      const files = await import('node:fs/promises').then((fs) => fs.readdir(archiveDir));
      const archivedPath = files.find((name) => name.startsWith('legacy-baseline-'));
      const originalArchive = archivedPath ? JSON.parse(await readFile(join(archiveDir, archivedPath), 'utf8')) : null;
      if (originalArchive) expect(originalArchive.digest).toBe(hash(JSON.stringify(originalArchive.evidence)));
      const fresh = await restartFixture(root, serverRef, target);
      await expect(fresh.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
      const afterFiles = await import('node:fs/promises').then((fs) => fs.readdir(archiveDir));
      const published = JSON.parse(await readFile(join(archiveDir, afterFiles.find((name) => name.startsWith('legacy-baseline-'))!), 'utf8'));
      expect(published.digest).toBe(hash(JSON.stringify(published.evidence)));
      if (originalArchive) expect(published).toEqual(originalArchive);
      expect(published.evidence.journal.pending_commit).toBe(journal.pending_commit);
      expect(published.evidence.journal.original_pending_intents).toHaveLength(1);
      expect(await fresh.readQueue()).toMatchObject({ pending_commit: boundary === 'before-queue-write' ? null : newCommit,
        changed_paths: ['unchanged.md'] });
      expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8').catch(() => null)).toBeNull();
      expect((await fresh.readDirectoryState()).pending_intents).toEqual([]);
      expect(await readFile(join(root, '.local-cache', 'untouched.md'), 'utf8')).toBe('local-only bytes\n');
    }
  );

  it('refuses to settle while an unrelated local error is recorded', async () => {
    const { root, core } = await fixture();
    await save(root, 'state.json', { ...await core.readState(), last_error_code: 'conflict_review_required' });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    expect(core.cancelLegacyDirectoryTransfer).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('blocks desktop retirement if the adapter has no native durability barrier', async () => {
    const { root, core } = await fixture();
    core.adapter.syncFile = undefined;
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toContain('main_advanced');
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('blocks if archive evidence changes after authorization but before journal removal', async () => {
    const { root, core } = await fixture();
    const remove = core.fsp.rm.bind(core.fsp);
    let altered = false;
    core.fsp.rm = vi.fn(async (filePath: string, ...args: unknown[]) => {
      await remove(filePath, ...args);
      if (filePath === core.uploadTransferPath) {
        const archives = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '.obts', 'recovery')));
        const archivePath = join(root, '.obts', 'recovery', archives.find((name) => name.startsWith('legacy-baseline-'))!);
        const archived = JSON.parse(await readFile(archivePath, 'utf8'));
        archived.evidence.state.last_error_details = { changed_after_authorization: true };
        await writeFile(archivePath, `${JSON.stringify(archived)}\n`);
        altered = true;
      }
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    expect(altered).toBe(true);
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toContain('legacy_retirement_authorized');
    expect((await core.readQueue()).changed_paths).toEqual(['unchanged.md']);
  });

  it('blocks if the apply journal remains in charge of recovery', async () => {
    const { root, core } = await fixture();
    await save(root, 'apply-journal.json', { phase: 'writing_files' });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('blocks missing authorization archive after a journaled settlement', async () => {
    const { root, core } = await fixture();
    const original = core.fsp.rm.bind(core.fsp);
    core.fsp.rm = vi.fn(async (name: string, ...args: unknown[]) => {
      if (name === core.uploadTransferPath) throw new Error('simulated interruption');
      return original(name, ...args);
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('simulated interruption');
    core.fsp.rm = original;
    const archives = await import('node:fs/promises').then((fs) => fs.readdir(join(root, '.obts', 'recovery')));
    const archive = join(root, '.obts', 'recovery', archives.find((name) => name.startsWith('legacy-baseline-'))!);
    await rm(archive);
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('blocks a concurrent changed-path hint removal after archive publication', async () => {
    const { root, core, newCommit } = await fixture();
    const original = core.fsp.rename.bind(core.fsp);
    core.fsp.rename = vi.fn(async (source: string, destination: string) => {
      await original(source, destination);
      if (destination.includes('legacy-baseline-')) {
        await core.updateQueue(async (current: any) => ({ ...current, changed_paths: [] }));
      }
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
    core.fsp.rename = original;
    expect(await core.readQueue()).toMatchObject({ pending_commit: newCommit, changed_paths: [] });
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toContain('main_advanced');
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('blocks failed archive publication without authorizing checkpoint removal', async () => {
    const { root, core } = await fixture();
    const original = core.fsp.syncDirectory.bind(core.fsp);
    core.fsp.syncDirectory = vi.fn(async (name: string) => {
      if (name.endsWith('/recovery')) throw new Error('archive publication failed');
      return original(name);
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('archive publication failed');
    core.fsp.syncDirectory = original;
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toContain('main_advanced');
    expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
  });

  it('resumes after journal cleanup was interrupted after the pull checkpoint retired', async () => {
    const { root, core, newCommit } = await fixture();
    const original = core.fsp.rm.bind(core.fsp);
    core.fsp.rm = vi.fn(async (name: string, ...args: unknown[]) => {
      if (name === core.directoryBaselineRecoveryPath) throw new Error('simulated final cleanup interruption');
      return original(name, ...args);
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('simulated final cleanup interruption');
    core.fsp.rm = original;
    await expect(core.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(await core.readQueue()).toMatchObject({ pending_commit: newCommit, changed_paths: ['unchanged.md'] });
    expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8').catch(() => null)).toBeNull();
  });

  it('resumes after each retired checkpoint write without replacing the newer queue', async () => {
    const { root, core, newCommit } = await fixture();
    const original = core.fsp.rm.bind(core.fsp);
    core.fsp.rm = vi.fn(async (name: string, ...args: unknown[]) => {
      if (name === core.pullTransferPath) throw new Error('simulated interruption');
      return original(name, ...args);
    });
    core.settlePreviouslyAppliedPullCheckpoint = vi.fn(async () => {
      await core.fsp.rm(core.pullTransferPath, { force: true });
    });
    await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toThrow('simulated interruption');
    core.fsp.rm = original;
    await expect(core.settleCompletedLegacyDirectoryAdvance()).resolves.toBe(true);
    expect(await core.readQueue()).toMatchObject({ pending_commit: newCommit, changed_paths: ['unchanged.md'] });
  });

  it.each(['nonempty-original', 'wrong-parent', 'wrong-cursor', 'wrong-device-id', 'unignored-delete',
    'changed-checkpoint', 'unrelated-pull', 'incomplete-pull', 'missing-pull', 'server-advanced',
    'new-queue-unrelated', 'new-queue-not-descendant'])(
    'blocks %s with all coordination evidence intact', async (fault) => {
      const { root, core, journal, upload, pull, newCommit, pending, base, serverRef } = await fixture();
      if (fault === 'nonempty-original') await save(root, 'directory-baseline-recovery.json', { ...journal, pending_commit: newCommit, local_head: newCommit });
      if (fault === 'wrong-parent') await save(root, 'directory-baseline-recovery.json', { ...journal, local_main: newCommit });
      if (fault === 'wrong-cursor') await save(root, 'directory-baseline-recovery.json', { ...journal, recovered_event_seq: 7 });
      if (fault === 'wrong-device-id') await save(root, 'directory-baseline-recovery.json', { ...journal, device_id: 'dev_other' });
      if (fault === 'unignored-delete') {
        const intents = (journal.original_pending_intents as Array<Record<string, unknown>>).map((intent) => ({ ...intent, path: 'visible-folder' }));
        await save(root, 'directory-baseline-recovery.json', { ...journal, original_pending_intents: intents });
      }
      if (fault === 'changed-checkpoint') await save(root, 'upload-transfer.json', { ...upload, identity: 'b'.repeat(64) });
      if (fault === 'unrelated-pull') await save(root, 'pull-transfer.json', { ...pull, target_main: pending });
      if (fault === 'incomplete-pull') await save(root, 'pull-transfer.json', { ...pull, complete: false });
      if (fault === 'missing-pull') await rm(join(root, '.obts', 'pull-transfer.json'));
      if (fault === 'new-queue-not-descendant') {
        await core.updateRef('refs/heads/local', base, null, true);
        await save(root, 'state.json', { ...await core.readState(), local_head: base });
        await core.writeQueue({ ...await core.readQueue(), pending_commit: base, expected_device_ref: serverRef });
      }
      if (fault === 'server-advanced') core.getDeviceSelf = vi.fn(async () => ({ server_device_ref: newCommit, last_applied_main: newCommit }));
      if (fault === 'new-queue-unrelated') await core.updateRef('refs/heads/local', pending, null, true);
      await expect(core.settleCompletedLegacyDirectoryAdvance()).rejects.toMatchObject({ code: 'legacy_directory_advance_unsafe' });
      expect(await readFile(join(root, '.obts', 'directory-baseline-recovery.json'), 'utf8')).toBeTruthy();
      expect(await readFile(join(root, '.obts', 'upload-transfer.json'), 'utf8')).toBeTruthy();
      if (fault !== 'missing-pull') expect(await readFile(join(root, '.obts', 'pull-transfer.json'), 'utf8')).toBeTruthy();
    }
  );
});
