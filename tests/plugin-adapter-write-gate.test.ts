import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';
import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';

const roots: string[] = [];
const A = Buffer.from('PREFLIGHT-A\n');
const B = Buffer.from('RACED-LOCAL-EDIT-B\n');
const C = Buffer.from('TARGET-C\n');
const nativeWrite = NodeDataAdapter.prototype.writeBinary;
const nativeRemove = NodeDataAdapter.prototype.remove;
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-adapter-gate-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'gate-regression' });
  await plugin.initialize();
  const core = plugin.client as any;
  await writeFile(join(root, 'shared.md'), C);
  const target = await core.createLocalCommit('gate target');
  const entries = await core.listTreeBlobOids(target);
  await writeFile(join(root, 'shared.md'), A);
  const preflight = await core.readRecoveryFileSnapshot('shared.md');
  const journal = {
    journal_version: 4, apply_id: 'apply_gate_regression', operation_type: 'pull_apply', target_main: target,
    target_file_sizes: { 'shared.md': C.length }, expected_prior_local_main: null, expected_prior_local_device_ref: null,
    phase: 'writing_files', affected_paths: ['shared.md'], preflight_sha256: { 'shared.md': preflight.fingerprint.sha256 },
    preflight_fingerprints: { 'shared.md': preflight.fingerprint }, directory_intents: [], explicit_directories: [],
    pre_apply_directories: [], pre_apply_directory_ctimes: {}, confirmed_directory_roots: [], confirmed_directory_inventory: null,
    preserve_local_changes: false, event_seq: null, recovery_bundle_id: 'rec_gate_regression', last_completed_step: 'recovery_bundle',
    redacted_error_category: null
  };
  return { root, core, journal, entries, evidence: join(root, '.obts/apply-displaced/apply_gate_regression/shared.md.entry') };
}

async function filesContaining(root: string, needle: Buffer): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) hits.push(...await filesContaining(path, needle));
    else if ((await readFile(path)).includes(needle)) hits.push(entry.name);
  }
  return hits;
}

describe('issue #33 same-adapter compare/mutate exclusion', () => {
  it.each(['modify', 'delete'] as const)('preserves wrapped writer B injected at the real %s seam', async (seam) => {
    let core: any;
    let armed = false;
    let writer: Promise<unknown> | undefined;
    const landed: string[] = [];
    let bEnteredRaw = false;
    // Instrument BEFORE capture. The captured methods still execute the real Node
    // storage operations; the competing writer uses the installed public wrapper.
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinary').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (path === 'shared.md' && Buffer.from(bytes).equals(B)) bEnteredRaw = true;
      if (armed && seam === 'modify' && path === 'shared.md' && Buffer.from(bytes).equals(C)) {
        armed = false;
        writer = core.adapter.writeBinary(path, B);
        await tick();
        expect(bEnteredRaw, 'B must wait outside the raw adapter').toBe(false);
        expect(landed).not.toContain('B');
      }
      await nativeWrite.call(this, path, bytes);
      if (path === 'shared.md') landed.push(Buffer.from(bytes).equals(B) ? 'B' : 'C');
    });
    vi.spyOn(NodeDataAdapter.prototype, 'remove').mockImplementation(async function (this: NodeDataAdapter, path) {
      if (armed && seam === 'delete' && path === 'shared.md') {
        armed = false;
        writer = core.adapter.writeBinary(path, B);
        await tick();
        expect(bEnteredRaw, 'B must wait outside the raw adapter').toBe(false);
        expect(landed).not.toContain('B');
      }
      await nativeRemove.call(this, path);
      if (path === 'shared.md') landed.push('delete');
    });
    const value = await fixture();
    core = value.core;
    landed.length = 0;
    armed = true;
    try {
      await core.writeTargetFilesFromJournal(value.journal, seam === 'modify' ? value.entries : new Map(), new Set());
    } finally {
      await writer;
    }
    expect(writer).toBeDefined();
    await writer;
    expect(bEnteredRaw).toBe(true);
    expect(landed).toEqual([seam === 'modify' ? 'C' : 'delete', 'B']);
    expect(await readFile(join(value.root, 'shared.md'))).toEqual(B);
    expect(await readFile(value.evidence)).toEqual(A);
    expect(value.journal).not.toHaveProperty('deferred_local_paths');
  });

  it.each(['modify', 'delete'] as const)('ExternalWriter residual: raw fs B at the %s seam remains only best-effort', async (seam) => {
    let root: string;
    let armed = false;
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinary').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (armed && seam === 'modify' && path === 'shared.md' && Buffer.from(bytes).equals(C)) {
        armed = false;
        await writeFile(join(root, path), B);
      }
      await nativeWrite.call(this, path, bytes);
    });
    vi.spyOn(NodeDataAdapter.prototype, 'remove').mockImplementation(async function (this: NodeDataAdapter, path) {
      if (armed && seam === 'delete' && path === 'shared.md') {
        armed = false;
        await writeFile(join(root, path), B);
      }
      await nativeRemove.call(this, path);
    });
    const value = await fixture();
    root = value.root;
    armed = true;
    await value.core.writeTargetFilesFromJournal(value.journal, seam === 'modify' ? value.entries : new Map(), new Set());
    expect(armed).toBe(false);
    expect(await readFile(join(root, 'shared.md')).catch(() => null)).toEqual(seam === 'modify' ? C : null);
    expect(await readFile(value.evidence)).toEqual(A);
    expect(await filesContaining(root, B)).toEqual([]);
    expect(value.journal).not.toHaveProperty('deferred_local_paths');
  });

  it.each(['modify', 'delete'])('defers B admitted before the in-gate %s comparison', async (seam) => {
    const value = await fixture();
    const capture = value.core.captureDisplacedCandidate.bind(value.core);
    value.core.captureDisplacedCandidate = async (...args: any[]) => {
      await capture(...args);
      await value.core.adapter.writeBinary('shared.md', B);
    };
    await value.core.writeTargetFilesFromJournal(value.journal, seam === 'modify' ? value.entries : new Map(), new Set());
    expect(await readFile(join(value.root, 'shared.md'))).toEqual(B);
    expect(await readFile(value.evidence)).toEqual(A);
    expect(value.journal).toHaveProperty('deferred_local_paths', ['shared.md']);
  });

  it('serializes exclusive creation with wrapped writers at its absence/create seam', async () => {
    let core: any;
    let armed = false;
    let writer: Promise<unknown> | undefined;
    let bEnteredRaw = false;
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinary').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (path === 'shared.md' && Buffer.from(bytes).equals(B)) bEnteredRaw = true;
      await nativeWrite.call(this, path, bytes);
    });
    const exclusive = NodeDataAdapter.prototype.writeBinaryExclusive;
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinaryExclusive').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (armed && path === 'shared.md') {
        armed = false;
        writer = core.adapter.writeBinary(path, B);
        await tick();
        expect(bEnteredRaw, 'B must wait outside the raw adapter').toBe(false);
      }
      await exclusive.call(this, path, bytes);
    });
    const value = await fixture();
    core = value.core;
    await rm(join(value.root, 'shared.md'));
    value.journal.preflight_sha256['shared.md'] = null;
    value.journal.preflight_fingerprints['shared.md'] = { kind: 'missing', sha256: null, oid: null };
    armed = true;
    try {
      await core.writeTargetFilesFromJournal(value.journal, value.entries, new Set());
    } finally {
      await writer;
    }
    expect(writer).toBeDefined();
    await writer;
    expect(bEnteredRaw).toBe(true);
    expect(await readFile(join(value.root, 'shared.md'))).toEqual(B);
  });

  it('guards restore against edited target bytes and deletes only expected target bytes', async () => {
    const { root, core, entries } = await fixture();
    await core.adapter.writeBinary('shared.md', B);
    await core.restoreFileSnapshot(new Map([['shared.md', A]]), ['shared.md'], entries);
    expect(await readFile(join(root, 'shared.md'))).toEqual(B);
    await core.restoreFileSnapshot(new Map(), ['shared.md'], entries);
    expect(await readFile(join(root, 'shared.md'))).toEqual(B);
    await core.adapter.writeBinary('shared.md', C);
    await core.restoreFileSnapshot(new Map(), ['shared.md'], entries);
    expect(await readFile(join(root, 'shared.md')).catch(() => null)).toBeNull();
  });

  it('guards blocking-prefix restoration rather than deleting newly edited ancestors', async () => {
    const { root, core, entries } = await fixture();
    await core.adapter.writeBinary('shared.md', B);
    await core.restoreFileSnapshot(new Map([['shared.md/child.md', A]]), [], entries);
    expect(await readFile(join(root, 'shared.md'))).toEqual(B);
    await core.adapter.writeBinary('shared.md', C);
    await core.restoreFileSnapshot(new Map([['shared.md/child.md', A]]), [], entries);
    expect(await readFile(join(root, 'shared.md/child.md'))).toEqual(A);
  });

  it('tracks its own guarded deletions while restoring a directory to a file', async () => {
    const { root, core } = await fixture();
    await rm(join(root, 'shared.md'));
    await mkdir(join(root, 'shared.md'));
    await writeFile(join(root, 'shared.md/known.md'), C);
    const target = await core.createLocalCommit('directory target');
    const expected = await core.listTreeBlobOids(target);
    await core.restoreFileSnapshot(new Map([['shared.md', A]]), ['shared.md/known.md'], expected);
    expect(await readFile(join(root, 'shared.md'))).toEqual(A);
  });

  it('queues child writers behind directory tombstone identity/emptiness checks', async () => {
    let core: any;
    let armed = false;
    let writer: Promise<unknown> | undefined;
    let bEnteredRaw = false;
    let bEnteredAtRemoval = false;
    vi.spyOn(NodeDataAdapter.prototype, 'writeBinary').mockImplementation(async function (this: NodeDataAdapter, path, bytes) {
      if (path === 'empty/child.md' && Buffer.from(bytes).equals(B)) bEnteredRaw = true;
      await nativeWrite.call(this, path, bytes);
    });
    const nativeRmdir = NodeDataAdapter.prototype.rmdir;
    vi.spyOn(NodeDataAdapter.prototype, 'rmdir').mockImplementation(async function (this: NodeDataAdapter, path, recursive) {
      if (armed && path === 'empty') {
        armed = false;
        writer = core.adapter.writeBinary('empty/child.md', B);
        await tick();
        bEnteredAtRemoval = bEnteredRaw;
        expect(bEnteredRaw, 'B must wait outside the raw adapter').toBe(false);
      }
      await nativeRmdir.call(this, path, recursive);
    });
    const value = await fixture();
    core = value.core;
    await core.adapter.mkdir('empty');
    const ctime = await core.adapterDirectoryCreationTime('empty');
    armed = true;
    let outcome;
    try {
      outcome = await core.adapterRemovePreexistingEmptyDirectory('empty', ctime);
    } finally {
      await writer;
    }
    expect(bEnteredAtRemoval, 'B must wait outside the raw adapter').toBe(false);
    expect(outcome).toBe('removed');
    expect(writer).toBeDefined();
    await writer;
    expect(bEnteredRaw).toBe(true);
    expect(await readFile(join(value.root, 'empty/child.md'))).toEqual(B);
  });

  it('preserves an unexpected descendant when restoring a target directory to a file', async () => {
    const { root, core } = await fixture();
    await rm(join(root, 'shared.md'));
    await mkdir(join(root, 'shared.md'));
    await writeFile(join(root, 'shared.md/known.md'), C);
    const target = await core.createLocalCommit('directory target');
    const expected = await core.listTreeBlobOids(target);
    await core.adapter.writeBinary('shared.md/new.md', B);
    await core.restoreFileSnapshot(new Map([['shared.md', A]]), [], expected);
    expect(await readFile(join(root, 'shared.md/new.md'))).toEqual(B);
    expect(await readFile(join(root, 'shared.md/known.md'))).toEqual(C);
  });
});
