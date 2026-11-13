import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';
import { ObtsPluginClient } from '../src/client/core.js';
import {
  advancePastStaleHorizons,
  createSyncCostFixture,
  resumeClient,
  syncUntilSettled,
  writeNote
} from './helpers/syncCostHarness.js';

// OBTS-SYNC-DELTA-001 / OBTS-SYNC-TAIL-001: the committed tail of a full apply
// preserves what this attempt could have overwritten. It keeps whole-vault
// coverage and proves each path it does not read from the scan cache's recorded
// stat, so a device with no local edits reads and hashes the change, never the
// vault. The counted operations are the contract: they stay the same when the
// vault grows.
const COUNTED_METHODS = [
  'readBinary', 'readBinaryRange', 'writeBinary', 'writeBinaryExclusive', 'stat', 'list',
  'mkdir', 'remove', 'rmdir', 'rename', 'syncFile', 'syncDirectory', 'exists', 'read', 'write'
] as const;

const READING_METHODS = new Set(['readBinary', 'readBinaryRange']);

// Only vault-area calls are the vault-size cost: a mobile adapter charges one
// bridge round trip each. Local Git and `.obts` bookkeeping is the operation's
// own fixed overhead and never scales with the number of notes.
function isVaultPath(adapterPath: unknown): boolean {
  const value = typeof adapterPath === 'string' ? adapterPath.replace(/^\/+/u, '') : '';
  return !value.startsWith('.obts');
}

class ApplyCounter {
  private readonly originals = new Map<string, (...args: unknown[]) => unknown>();
  private inApply = false;
  readonly labels: string[] = [];
  vaultCalls = 0;
  vaultReads = 0;
  vaultReadBytes = 0;

  install(prototype: Record<string, any>): void {
    for (const method of COUNTED_METHODS) {
      const original = prototype[method];
      if (!original) throw new Error(`NodeDataAdapter.${method} is missing.`);
      this.originals.set(method, original);
      const counter = this;
      prototype[method] = async function counted(this: unknown, ...args: unknown[]) {
        const value = await original.apply(this, args);
        if (counter.inApply && isVaultPath(args[0])) {
          counter.vaultCalls += 1;
          if (READING_METHODS.has(method)) {
            counter.vaultReads += 1;
            counter.vaultReadBytes += value instanceof ArrayBuffer ? value.byteLength
              : typeof value === 'string' ? value.length : 0;
          }
        }
        return value;
      };
    }
  }

  uninstall(): void {
    for (const [method, original] of this.originals) (NodeDataAdapter.prototype as any)[method] = original;
    this.originals.clear();
  }

  // The measured window is the committed tail: it opens when the apply starts
  // proving what it could overwrite and closes when the applied snapshot is
  // acknowledged, whose bookkeeping is the next operation.
  noteLabel(label: string): void {
    if (label.startsWith('Applying (acknowledging)')) {
      this.inApply = false;
      return;
    }
    if (!label.startsWith('Applying')) return;
    this.labels.push(label);
    if (label.startsWith('Applying (checking local edits)')) this.inApply = true;
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

// A settled inventory of a vault whose notes were last written an hour ago: the
// cache record is 60 s newer than every mtime, which is what the tail's stat
// proof requires. Filesystem work, not adapter work, so it is not counted.
async function ageSettledInventory(vaultDir: string): Promise<void> {
  const cachePath = join(vaultDir, '.obts', 'scan-cache.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const aged = Math.round(Date.now()) - 3_600_000;
  for (const filePath of Object.keys(cache.entries)) {
    const target = join(vaultDir, filePath);
    const when = new Date(aged);
    await utimes(target, when, when);
    const current = await stat(target);
    Object.assign(cache.entries[filePath], {
      size: current.size,
      mtime: current.mtimeMs,
      ctime: current.birthtimeMs
    });
  }
  cache.recorded_at_ms = aged + 60_000;
  await writeFile(cachePath, JSON.stringify(cache));
}

type ApplyMeasurement = {
  vaultCalls: number;
  vaultReads: number;
  vaultReadKiB: number;
  labels: string[];
  status: string;
  vaultDir: string;
  core: Record<string, any>;
};

// A catch-up the device did not ask to scope: no hinted capture, so the whole
// apply runs and its tail decides the cost.
async function measureFullApplyCatchUp(fileCount: number, changedFiles: number): Promise<ApplyMeasurement> {
  vi.useFakeTimers({ toFake: ['Date'] });
  const fixture = await createSyncCostFixture(fileCount);
  cleanups.push(async () => await fixture.close());
  await advancePastStaleHorizons(fixture.reader);
  expect((await syncUntilSettled(fixture.reader)).at(-1)).toBe('Synced');
  await ageSettledInventory(fixture.readerDir);
  for (let index = 0; index < changedFiles; index += 1) {
    await writeNote(fixture.writerDir, 40 + index, `remote edit ${index}\n`);
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
  }
  const resumed: ObtsPluginClient = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
  const core = (resumed as unknown as { client: Record<string, any> }).client;
  const counter = new ApplyCounter();
  const report = core.reportOperationProgress.bind(core);
  core.reportOperationProgress = (label: string, point: string) => {
    counter.noteLabel(label);
    return report(label, point);
  };
  counter.install(NodeDataAdapter.prototype);
  try {
    await resumed.pollRemoteEventsAndApply();
  } finally {
    counter.uninstall();
  }
  const state = await core.readState();
  return {
    vaultCalls: counter.vaultCalls,
    vaultReads: counter.vaultReads,
    vaultReadKiB: Math.round(counter.vaultReadBytes / 1024),
    labels: counter.labels,
    status: state.status_label,
    vaultDir: fixture.readerDir,
    core
  };
}

async function noteBytes(vaultDir: string, index: number): Promise<string> {
  return await readFile(`${vaultDir}/folder-${String(index % 24).padStart(2, '0')}/note-${String(index).padStart(5, '0')}.md`, 'utf8');
}

describe('committed apply tail is proportional to the change', () => {
  it('reads and hashes only the change for a tiny catch-up, whatever the vault holds', async () => {
    const small = await measureFullApplyCatchUp(40, 1);
    const large = await measureFullApplyCatchUp(160, 1);

    expect(small.status).toBe('Synced');
    expect(large.status).toBe('Synced');
    // Every tail stage names itself: the user and the diagnostics can tell which
    // step is running instead of watching one silent multi-minute phase.
    expect(small.labels.some((label) => label.startsWith('Applying (checking local edits)'))).toBe(true);
    expect(small.labels.some((label) => label.startsWith('Applying (finishing)'))).toBe(true);
    // A one-file change on a settled device: that file is read, the rest of the
    // vault is proven from its recorded stat.
    expect(small.vaultReads).toBe(large.vaultReads);
    expect(small.vaultReads).toBeLessThanOrEqual(4);
    expect(small.vaultReadKiB).toBe(large.vaultReadKiB);
    // The whole vault is still covered, but one metadata call per file at most:
    // no whole-vault read, no second pass over the bytes.
    expect(large.vaultCalls - small.vaultCalls).toBeLessThanOrEqual(160 - 40 + 8);
    expect(await noteBytes(large.vaultDir, 40)).toBe('remote edit 0\n');
  }, 120_000);

  it('reads and hashes only the change for a larger catch-up', async () => {
    const small = await measureFullApplyCatchUp(40, 8);
    const large = await measureFullApplyCatchUp(160, 8);

    expect(small.status).toBe('Synced');
    expect(large.status).toBe('Synced');
    expect(small.vaultReads).toBe(large.vaultReads);
    expect(small.vaultReadKiB).toBe(large.vaultReadKiB);
    // Proportional to the changed files (each is re-read inside the gate), far
    // below the vault: 8 changed files cost dozens of reads, not one per vault
    // file, and the same on a vault four times the size.
    expect(small.vaultReads).toBeGreaterThanOrEqual(8);
    expect(small.vaultReads).toBeLessThanOrEqual(8 * 3 + 8);
    expect(small.vaultReadKiB).toBeLessThanOrEqual(16);
    expect(large.vaultCalls - small.vaultCalls).toBeLessThanOrEqual(160 - 40 + 8);
    expect(await noteBytes(large.vaultDir, 47)).toBe('remote edit 7\n');
  }, 120_000);

  it('preserves a footprint edit that no watcher hint named', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fixture = await createSyncCostFixture(40);
    cleanups.push(async () => await fixture.close());
    await advancePastStaleHorizons(fixture.reader);
    expect((await syncUntilSettled(fixture.reader)).at(-1)).toBe('Synced');
    await writeNote(fixture.writerDir, 41, 'remote edit\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    // The same path is edited locally with no watcher hint at all.
    await writeNote(fixture.readerDir, 41, 'local bytes that no watcher saw\n');
    const resumed: ObtsPluginClient = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const resumedCore = (resumed as unknown as { client: Record<string, any> }).client;

    await resumed.pollRemoteEventsAndApply();

    // The edit is preserved as local work from the applied base instead of
    // being overwritten, and the next sync publishes those bytes.
    expect(await noteBytes(fixture.readerDir, 41)).toBe('local bytes that no watcher saw\n');
    // It is kept as work the owner can review, not silently dropped: the
    // conflicting local bytes are the proposal the device holds.
    const queue = await resumedCore.readQueue();
    expect(queue.status).toBe('conflicted');
    expect(queue.pending_commit).toMatch(/^[0-9a-f]{40}$/u);
    const localOid = (await resumedCore.listTreeBlobOids(queue.pending_commit)).get('folder-17/note-00041.md');
    expect(localOid).toMatch(/^[0-9a-f]{40}$/u);
    expect(Buffer.from(await resumedCore.readBlobOid(localOid)).toString('utf8'))
      .toBe('local bytes that no watcher saw\n');
    expect((await resumedCore.readState()).last_error_code).toBe('conflict_review_required');
  }, 120_000);
});
