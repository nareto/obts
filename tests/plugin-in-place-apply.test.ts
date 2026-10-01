import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';
import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';
import { publishRecoveryFixture } from './helpers/publishRecoveryFixture.js';

const nativeWrite = NodeDataAdapter.prototype.writeBinary;

const roots: string[] = [];
const before = Buffer.from('captured local bytes\r\n');
const target = Buffer.from('\ufeffserver target bytes\r\n');

async function fixture(filePath = 'shared.md', targetBytes = target) {
  const root = await mkdtemp(join(tmpdir(), 'obts-in-place-'));
  roots.push(root);
  const rawWrite = vi.spyOn(NodeDataAdapter.prototype, 'writeBinary');
  const rawRemove = vi.spyOn(NodeDataAdapter.prototype, 'remove');
  const rawRmdir = vi.spyOn(NodeDataAdapter.prototype, 'rmdir');
  const rawRename = vi.spyOn(NodeDataAdapter.prototype, 'rename');
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'in-place' });
  await plugin.initialize();
  const core = plugin.client as any;
  await writeFile(join(root, filePath), targetBytes);
  const commit = await core.createLocalCommit('in-place target');
  const entries = await core.listTreeBlobOids(commit);
  await writeFile(join(root, filePath), before);
  const preflight = await core.readRecoveryFileSnapshot(filePath);
  const journal = {
    journal_version: 4, apply_id: 'apply_in_place', operation_type: 'pull_apply',
    target_main: commit, target_file_sizes: { [filePath]: targetBytes.length },
    expected_prior_local_main: null, expected_prior_local_device_ref: null,
    phase: 'writing_files', affected_paths: [filePath],
    preflight_sha256: { [filePath]: preflight.fingerprint.sha256 },
    preflight_fingerprints: { [filePath]: preflight.fingerprint },
    directory_intents: [], explicit_directories: [], pre_apply_directories: [],
    pre_apply_directory_ctimes: {}, confirmed_directory_roots: [], confirmed_directory_inventory: null,
    preserve_local_changes: false, event_seq: null, recovery_bundle_id: 'rec_in_place',
    last_completed_step: 'recovery_bundle', redacted_error_category: null as string | null
  };
  const evidence = join(root, '.obts', 'apply-displaced', journal.apply_id, `${encodeURIComponent(filePath)}.entry`);
  return { root, core, journal, entries, evidence, filePath, targetBytes, rawWrite, rawRemove, rawRmdir, rawRename };
}

function recordVault(core: any, filePath: string, indexed = true) {
  const files = new Map(indexed ? [[filePath, { path: filePath }]] : []);
  const deleteEvents: string[] = [];
  const vault = {
    ...core.plugin.app.vault,
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    delete: vi.fn(async (file: { path: string }) => {
      await core.adapter.remove(file.path);
      files.delete(file.path);
      deleteEvents.push(file.path);
    }),
    createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
      await core.adapter.writeBinaryExclusive(path, bytes);
      const file = { path };
      files.set(path, file);
      return file;
    }),
    modifyBinary: vi.fn(async (file: { path: string }, bytes: ArrayBuffer) => {
      await core.adapter.writeBinary(file.path, bytes);
    })
  };
  core.plugin.app.vault = vault;
  return { vault, deleteEvents, file: files.get(filePath) };
}

async function stageCopy(value: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(value.root, '.obts', 'apply-journal.json'), JSON.stringify(value.journal));
  await publishRecoveryFixture(value.root);
  await mkdir(join(value.root, '.obts', 'apply-displaced', value.journal.apply_id), { recursive: true });
  await writeFile(value.evidence, before);
}

function restart(value: Awaited<ReturnType<typeof fixture>>) {
  const plugin = new ObtsPluginClient(value.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'in-place-restart' });
  const core = plugin.client as any;
  return { plugin, core, ...recordVault(core, value.filePath) };
}

async function archivedPreimage(value: Awaited<ReturnType<typeof fixture>>) {
  return readFile(join(value.root, '.obts', 'recovery-displaced', value.journal.apply_id,
    `${encodeURIComponent(value.filePath)}.entry`));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('in-place remote apply', () => {
  it('modifies the existing TFile without deletion, delete events, recreation, or rename', async () => {
    const value = await fixture();
    const { core, journal, entries, root, evidence, filePath, rawWrite, rawRemove, rawRmdir, rawRename } = value;
    const { vault, deleteEvents, file } = recordVault(core, filePath);
    await core.writeTargetFilesFromJournal(journal, entries, new Set());
    expect(vault.delete).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(rawWrite.mock.calls.filter(([path]) => path === filePath)).toHaveLength(1);
    expect(vault.getAbstractFileByPath(filePath)).toBe(file);
    expect(rawRename.mock.calls.filter(([source]) => source === filePath)).toHaveLength(0);
    expect(rawRemove.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);
    expect(rawRmdir.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);
    expect(await readFile(join(root, filePath))).toEqual(target);
    expect(await readFile(evidence)).toEqual(before);
  });

  it('overwrites an unindexed dot-path in place with exact binary bytes', async () => {
    const bytes = Buffer.from([0, 255, 254, 13, 10, 128]);
    const { core, journal, entries, root, evidence, filePath, rawRemove, rawRmdir } = await fixture('.hidden-note', bytes);
    const { vault, deleteEvents } = recordVault(core, filePath, false);
    await core.writeTargetFilesFromJournal(journal, entries, new Set());
    expect(vault.delete).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(rawRemove.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);
    expect(rawRmdir.mock.calls.filter(([path]) => path === filePath)).toHaveLength(0);
    expect(await readFile(join(root, filePath))).toEqual(bytes);
    expect(await readFile(evidence)).toEqual(before);
  });

  it('defers a persisted change after the copy and before the final write comparison', async () => {
    const { core, journal, entries, root, evidence, filePath } = await fixture();
    const { vault } = recordVault(core, filePath);
    const displace = core.displaceApplyPath.bind(core);
    core.displaceApplyPath = async (...args: any[]) => {
      const retained = await displace(...args);
      await writeFile(join(root, filePath), 'last-moment local edit\n');
      return retained;
    };
    await core.writeTargetFilesFromJournal(journal, entries, new Set());
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(await readFile(join(root, filePath), 'utf8')).toBe('last-moment local edit\n');
    expect(journal).toMatchObject({ deferred_local_paths: [filePath] });
    expect(await readFile(evidence)).toEqual(before);
  });

  it('uses an exact raw adapter overwrite even when Vault methods would reject', async () => {
    const { core, journal, entries, root, evidence, filePath, rawWrite } = await fixture();
    const { vault, deleteEvents } = recordVault(core, filePath);
    vault.modifyBinary.mockRejectedValue(new Error('Vault API rejected path'));
    await core.writeTargetFilesFromJournal(journal, entries, new Set());
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(rawWrite.mock.calls.filter(([path]) => path === filePath)).toHaveLength(1);
    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    expect(await readFile(join(root, filePath))).toEqual(target);
    expect(await readFile(evidence)).toEqual(before);
  });

  it('revalidates local bytes before the raw write after evidence publication', async () => {
    const { core, journal, entries, root, filePath } = await fixture();
    const { vault } = recordVault(core, filePath);
    const capture = core.captureDisplacedCandidate.bind(core);
    core.captureDisplacedCandidate = async (...args: any[]) => {
      await capture(...args);
      await core.adapter.writeBinary(filePath, Buffer.from('edit after evidence publication\n'));
    };
    await core.writeTargetFilesFromJournal(journal, entries, new Set());
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(await readFile(join(root, filePath), 'utf8')).toBe('edit after evidence publication\n');
    expect(journal).toMatchObject({ deferred_local_paths: [filePath] });
  });

  it('resumes directory-to-file replacement after a child removal left a copy and an empty parent', async () => {
    const value = await fixture('folder');
    await rm(join(value.root, 'folder'));
    await mkdir(join(value.root, 'folder'));
    await writeFile(join(value.root, 'folder/note.md'), before);
    const directory = await value.core.readRecoveryFileSnapshot('folder');
    const child = await value.core.readRecoveryFileSnapshot('folder/note.md');
    const journal = {
      ...value.journal,
      affected_paths: ['folder', 'folder/note.md'],
      preflight_sha256: { folder: null, 'folder/note.md': child.fingerprint.sha256 },
      preflight_fingerprints: { folder: directory.fingerprint, 'folder/note.md': child.fingerprint },
      pre_apply_directories: ['folder'],
      pre_apply_directory_ctimes: { folder: await value.core.adapterDirectoryCreationTime('folder') }
    };
    await writeFile(join(value.root, '.obts/apply-journal.json'), JSON.stringify(journal));
    await publishRecoveryFixture(value.root);
    await mkdir(join(value.root, '.obts/apply-displaced', journal.apply_id), { recursive: true });
    await value.core.captureDisplacedCandidate('folder', value.core.applyDisplacedPath(journal, 'folder'), true);
    const childCopy = `${encodeURIComponent('folder/note.md')}.entry`;
    await writeFile(join(value.root, '.obts/apply-displaced', journal.apply_id, childCopy), before);
    await rm(join(value.root, 'folder/note.md'));
    const restarted = new ObtsPluginClient(value.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'type-change-restart' });
    await restarted.initialize();
    expect(await readFile(join(value.root, 'folder'))).toEqual(target);
    expect(await readFile(join(value.root, '.obts/recovery-displaced', journal.apply_id, childCopy))).toEqual(before);
    expect(await readFile(join(value.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });

  it('still deletes genuinely remotely removed notes', async () => {
    const { core, journal, root, evidence, filePath, rawRemove } = await fixture();
    const { vault, deleteEvents } = recordVault(core, filePath);
    await core.writeTargetFilesFromJournal(journal, new Map(), new Set());
    expect(vault.delete).not.toHaveBeenCalled();
    expect(rawRemove).toHaveBeenCalledWith(filePath);
    expect(deleteEvents).toEqual([]);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(await readFile(join(root, filePath)).catch(() => null)).toBeNull();
    expect(await readFile(evidence)).toEqual(before);
  });

  it('resumes after the verified copy without deleting the still-live preflight image', async () => {
    const value = await fixture();
    await stageCopy(value);
    const { plugin, vault, deleteEvents } = restart(value);
    await plugin.initialize();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(value.rawWrite.mock.calls.filter(([path]) => path === value.filePath)).toHaveLength(1);
    expect(await readFile(join(value.root, value.filePath))).toEqual(target);
    expect(await archivedPreimage(value)).toEqual(before);
    expect(await readFile(join(value.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });

  it.each(['before', 'partial', 'after'])('recovers a storage interruption %s the in-place write', async (point) => {
    const value = await fixture();
    await stageCopy(value);
    value.rawWrite.mockImplementation(async function (this: NodeDataAdapter, path: string, bytes: ArrayBuffer) {
      if (path !== value.filePath) return nativeWrite.call(this, path, bytes);
      if (point !== 'before') {
        const content = Buffer.from(bytes);
        const written = point === 'partial' ? content.subarray(0, 9) : content;
        await nativeWrite.call(this, path, written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength) as ArrayBuffer);
      }
      throw new Error('synthetic interrupted storage write');
    });
    await expect(value.core.writeTargetFilesFromJournal(value.journal, value.entries, new Set()))
      .rejects.toThrow('synthetic interrupted storage write');
    expect(await readFile(value.evidence)).toEqual(before);
    value.rawWrite.mockImplementation(nativeWrite);
    value.rawWrite.mockClear();
    const { plugin, vault, deleteEvents } = restart(value);
    await plugin.initialize();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    const expected = point === 'partial' ? target.subarray(0, 9) : target;
    expect(await readFile(join(value.root, value.filePath))).toEqual(expected);
    expect(await archivedPreimage(value)).toEqual(before);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(value.rawWrite.mock.calls.filter(([path]) => path === value.filePath)).toHaveLength(point === 'before' ? 1 : 0);
    if (point === 'partial') {
      const queue = await plugin.readQueue();
      expect(queue.pending_commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(await plugin.client.readBlob(queue.pending_commit, value.filePath)).toEqual(expected);
    }
    expect(await readFile(join(value.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });

  it.each(['writing_files', 'verifying', 'blocked_recovery'])('recognizes target bytes beside a pre-image copy in %s', async (phase) => {
    const value = await fixture();
    value.journal.phase = phase;
    if (phase === 'blocked_recovery') value.journal.redacted_error_category = 'local_files_diverge_from_journal';
    await stageCopy(value);
    await writeFile(join(value.root, value.filePath), target);
    const { plugin, vault, deleteEvents } = restart(value);
    await plugin.initialize();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(deleteEvents).toEqual([]);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(await readFile(join(value.root, value.filePath))).toEqual(target);
    expect(await archivedPreimage(value)).toEqual(before);
    expect(await readFile(join(value.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });

  it.each([Buffer.from('server tar'), Buffer.from('local edit after copy\n')])('preserves unknown bytes after an interrupted write', async (bytes) => {
    const value = await fixture();
    await stageCopy(value);
    await writeFile(join(value.root, value.filePath), bytes);
    const { plugin, vault } = restart(value);
    await plugin.initialize();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(await readFile(join(value.root, value.filePath))).toEqual(bytes);
    expect(await archivedPreimage(value)).toEqual(before);
    const queue = await plugin.readQueue();
    expect(queue.pending_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await plugin.client.readBlob(queue.pending_commit, value.filePath)).toEqual(bytes);
    expect(await readFile(join(value.root, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
  });
});
