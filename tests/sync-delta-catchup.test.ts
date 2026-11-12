import { readFile, readdir } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import {
  advancePastStaleHorizons,
  createSyncCostFixture,
  resumeClient,
  syncUntilSettled,
  tickUntilSettled,
  writeNote,
  type AdapterCost,
  type SyncCostFixture
} from './helpers/syncCostHarness.js';

// A device that was closed or backgrounded for hours comes back behind by many
// remote commits that touch a few files, with no local edits. OBTS-SYNC-DELTA-001
// requires that catching up costs what the change costs, before the whole-vault
// inventory that startup and resume schedule runs.
const fileCount = Number(process.env.OBTS_CATCHUP_FILES ?? 120);

type Attempt = { outcome: string; scan_mode: string; apply_mode: string };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function coreOf(plugin: ObtsPluginClient): Record<string, any> {
  return (plugin as unknown as { client: Record<string, any> }).client;
}

function spy(core: Record<string, any>, name: string): { args: unknown[]; result?: any }[] {
  const original = core[name].bind(core);
  const calls: { args: unknown[]; result?: any }[] = [];
  core[name] = async (...args: unknown[]) => {
    const call: { args: unknown[]; result?: any } = { args };
    calls.push(call);
    call.result = await original(...args);
    return call.result;
  };
  return calls;
}

async function recordedAttempts(core: Record<string, any>): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  core.setSyncTimingSink((attempt: Attempt) => attempts.push(attempt));
  return attempts;
}

async function settle(plugin: ObtsPluginClient): Promise<void> {
  expect((await syncUntilSettled(plugin)).at(-1)).toBe('Synced');
}

async function noteBytes(vaultDir: string, index: number): Promise<string> {
  const listing: string[] = [];
  for (const folder of await readdir(vaultDir)) {
    if (!folder.startsWith('folder-')) continue;
    for (const name of await readdir(`${vaultDir}/${folder}`)) {
      if (name === `note-${String(index).padStart(5, '0')}.md`) listing.push(`${vaultDir}/${folder}/${name}`);
    }
  }
  expect(listing).toHaveLength(1);
  return await readFile(listing[0]!, 'utf8');
}

async function prepare(): Promise<SyncCostFixture> {
  vi.useFakeTimers({ toFake: ['Date'] });
  const fixture = await createSyncCostFixture(fileCount);
  cleanups.push(async () => await fixture.close());
  await advancePastStaleHorizons(fixture.reader);
  await settle(fixture.reader);
  return fixture;
}

// Five accepted remote commits that touch five files: a day of Bridge-written
// notes, not a bulk import.
async function remoteCommits(fixture: SyncCostFixture, first = 30): Promise<void> {
  for (let commit = 0; commit < 5; commit += 1) {
    await writeNote(fixture.writerDir, first + commit, `remote commit ${commit}\n`);
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
  }
}

async function measure(fixture: SyncCostFixture, operation: () => Promise<unknown>): Promise<AdapterCost> {
  const { cost } = await fixture.meter.measure(operation);
  return cost;
}

describe('foreground catch-up before the scheduled inventory', () => {
  it('applies the remote advance proportionally and defers the resume inventory', async () => {
    const fixture = await prepare();
    await remoteCommits(fixture);
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);
    const attempts = await recordedAttempts(core);
    const inventories = spy(core, 'listLocalVaultInventory');
    const directories = spy(core, 'reconcileDirectoryState');
    const scope = spy(core, 'deltaApplyScope');

    const cost = await measure(fixture, () => resumed.syncOnce({ hintedCapture: true }));

    expect((await core.readState()).status_label).toBe('Synced');
    // The whole-vault paths never run: no inventory, no directory walk, and a
    // scoped apply.
    expect(inventories).toHaveLength(0);
    expect(directories).toHaveLength(0);
    expect(scope[0]?.result).toMatchObject({ paths: expect.arrayContaining([expect.stringContaining('note-00030.md')]) });
    // The inventory stays scheduled: it runs as soon as this attempt ends.
    expect(await core.backgroundScanDecision()).toMatchObject({ required: true, mode: 'incremental' });
    await vi.waitFor(() => expect(attempts).not.toHaveLength(0));
    expect(attempts.at(-1)).toMatchObject({ outcome: 'completed', scan_mode: 'none', apply_mode: 'delta' });
    // Measured here: 218 vault-area calls and 1373 total for five changed
    // files. The numbers are identical on a vault four times this size, so they
    // describe the change, not the vault; running the inventory first cost 428
    // and 1720 on the same fixture. Every vault-area call is one adapter round
    // trip, which is what a mobile bridge charges for.
    expect(cost.byArea.vault ?? 0).toBeLessThanOrEqual(260);
    expect(cost.calls).toBeLessThanOrEqual(1500);
    expect(await noteBytes(fixture.readerDir, 30)).toBe('remote commit 0\n');

    // The next attempt runs the scheduled inventory and settles.
    const rest = await tickUntilSettled(resumed);
    expect(rest.at(-1)).toMatch(/:(Synced|Behind)$/u);
    expect(inventories.length).toBeGreaterThan(0);
    expect(await core.backgroundScanDecision()).toMatchObject({ required: false, mode: 'none' });
  }, 300_000);

  it('keeps an unhinted edit on a footprint path and preserves it as local work', async () => {
    const fixture = await prepare();
    await remoteCommits(fixture);
    await writeNote(fixture.readerDir, 32, 'local bytes that no watcher saw\n');
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);

    await resumed.syncOnce({ hintedCapture: true });

    // The gate re-read the footprint path: its bytes stay, and the edit becomes
    // an ordinary proposal from the applied base instead of being overwritten.
    expect(await noteBytes(fixture.readerDir, 32)).toBe('local bytes that no watcher saw\n');
    const queue = await core.readQueue();
    expect(queue.pending_commit).toMatch(/^[0-9a-f]{40}$/u);
    // Both sides changed the same bytes, so the server surfaces the reviewed
    // conflict instead of choosing a winner here.
    expect(queue.status).toBe('conflicted');
    // The other remote commits in the same footprint were applied.
    expect(await noteBytes(fixture.readerDir, 33)).toBe('remote commit 3\n');
    expect(await core.readState()).toMatchObject({ status_label: 'Conflict resolution needed', last_error_code: 'conflict_review_required' });
  }, 300_000);

  it('leaves an unhinted edit outside the footprint for the following inventory', async () => {
    const fixture = await prepare();
    await remoteCommits(fixture);
    await writeNote(fixture.readerDir, 90, 'background app edit\n');
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);

    await resumed.syncOnce({ hintedCapture: true });

    // Nothing reads or writes outside the footprint, so the edit is still
    // visible and still unsynced.
    expect(await noteBytes(fixture.readerDir, 90)).toBe('background app edit\n');
    expect((await core.readQueue()).pending_commit).toBeNull();
    expect((await core.readState()).status_label).toBe('Synced');
    expect(await noteBytes(fixture.readerDir, 34)).toBe('remote commit 4\n');

    // The scheduled inventory is what captures it, in the same session.
    await settle(resumed);
    expect((await core.readQueue()).pending_commit).toBeNull();
    const main = (await core.readState()).local_main;
    const entries = await core.listTreeBlobOids(main);
    const captured = [...entries.keys()].find((filePath: string) => filePath.endsWith('note-00090.md'));
    expect(captured).toBeTruthy();
    expect(Buffer.from(await core.readBlobOid(entries.get(captured))).toString('utf8')).toBe('background app edit\n');
  }, 300_000);

  it('postpones the scheduled inventory at most once per session', async () => {
    const fixture = await prepare();
    await remoteCommits(fixture);
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);
    expect((await resumed.syncOnce({ hintedCapture: true })).status).toBe('Synced');
    expect(await core.backgroundScanDecision()).toMatchObject({ required: true, mode: 'incremental' });

    // A second remote advance in the same session cannot postpone it again: the
    // inventory runs, and the catch-up it precedes is still scoped.
    await writeNote(fixture.writerDir, 70, 'later remote commit\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    const inventories = spy(core, 'listLocalVaultInventory');
    expect((await syncUntilSettled(resumed)).at(-1)).toBe('Synced');
    expect(inventories.length).toBeGreaterThan(0);
    expect(await noteBytes(fixture.readerDir, 70)).toBe('later remote commit\n');
    expect(await core.backgroundScanDecision()).toMatchObject({ required: false, mode: 'none' });
  }, 300_000);

  it('keeps the capture-then-upload order when a local edit is already hinted', async () => {
    const fixture = await prepare();
    await remoteCommits(fixture);
    const resumed = await resumeClient(fixture, fixture.readerDir, 'cost-reader');
    const core = coreOf(resumed);
    const local = await writeNote(fixture.readerDir, 60, 'hinted local edit\n');
    await resumed.recordLocalChangeHint([local]);
    expect((await core.backgroundScanDecision()).required).toBe(true);

    await settle(resumed);

    // Local work exists, so the attempt captures and uploads before applying;
    // both sides converge and nothing is lost.
    expect((await core.readQueue()).pending_commit).toBeNull();
    expect((await core.readState()).status_label).toBe('Synced');
    expect(await noteBytes(fixture.readerDir, 60)).toBe('hinted local edit\n');
    expect(await noteBytes(fixture.readerDir, 31)).toBe('remote commit 1\n');
    const main = (await core.readState()).local_main;
    const entries = await core.listTreeBlobOids(main);
    const uploaded = [...entries.keys()].find((filePath: string) => filePath.endsWith('note-00060.md'));
    expect(Buffer.from(await core.readBlobOid(entries.get(uploaded))).toString('utf8')).toBe('hinted local edit\n');
  }, 300_000);
});
