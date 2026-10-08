import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addSyntheticPacks,
  countLocalPacks,
  createSyncCostFixture,
  expireStaleHorizons,
  syncUntilSettled,
  tickUntilSettled,
  writeNote,
  type AdapterCost,
  type SyncCostFixture
} from './helpers/syncCostHarness.js';

const fileCount = Number(process.env.OBTS_COST_FILES ?? 300);
const packCount = Number(process.env.OBTS_COST_PACKS ?? 100);
const report: Record<string, AdapterCost & { statuses: string; localPacks: number }> = {};

describe('sync cost is proportional to the change', () => {
  let fixture: SyncCostFixture;

  beforeAll(async () => {
    fixture = await createSyncCostFixture(fileCount);
  }, 300_000);

  afterAll(async () => {
    console.log(`sync cost (files=${fileCount}, synthetic packs=${packCount})`);
    console.table(Object.fromEntries(Object.entries(report).map(([name, cost]) => [name, {
      calls: cost.calls,
      readKiB: Math.round(cost.readBytes / 1024),
      ms: cost.ms,
      list: cost.byMethod.list ?? 0,
      stat: cost.byMethod.stat ?? 0,
      read: (cost.byMethod.readBinary ?? 0) + (cost.byMethod.read ?? 0),
      write: (cost.byMethod.writeBinary ?? 0) + (cost.byMethod.write ?? 0) + (cost.byMethod.writeBinaryExclusive ?? 0),
      vault: cost.byArea.vault ?? 0,
      packs: (cost.byArea.idx ?? 0) + (cost.byArea.pack ?? 0) + (cost.byArea.packdir ?? 0),
      loose: cost.byArea.loose ?? 0,
      meta: (cost.byArea.gitmeta ?? 0) + (cost.byArea.obts ?? 0),
      localPacks: cost.localPacks,
      statuses: cost.statuses
    }])));
    if (process.env.OBTS_COST_TRACE) {
      console.log([...fixture.meter.traces].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([key, count]) => `${count}\t${key}`).join('\n'));
    }
    await fixture?.close();
  });

  async function measureReader(name: string): Promise<AdapterCost> {
    const { value, cost } = await fixture.meter.measure(() => syncUntilSettled(fixture.reader));
    report[name] = { ...cost, statuses: value.join(' > '), localPacks: await countLocalPacks(fixture.readerDir) };
    expect(value.at(-1)).toBe('Synced');
    return cost;
  }

  async function measureBackground(name: string, hints: string[] = []): Promise<AdapterCost> {
    const { value, cost } = await fixture.meter.measure(() => tickUntilSettled(fixture.reader, hints));
    report[name] = { ...cost, statuses: value.join(' > '), localPacks: await countLocalPacks(fixture.readerDir) };
    expect(value.at(-1)).toMatch(/:Synced$/u);
    return cost;
  }

  it('measures an idle cycle', async () => {
    await measureReader('idle');
  }, 300_000);

  it('measures a one-file remote change', async () => {
    await writeNote(fixture.writerDir, 7, 'remote edit\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    await measureReader('remote 1 file');
  }, 300_000);

  it('measures a one-file local change and its own accepted push', async () => {
    await writeNote(fixture.readerDir, 9, 'local edit\n');
    await measureReader('own push 1 file');
  }, 300_000);

  it('measures catch-up over several small remote commits', async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeNote(fixture.writerDir, 20 + index, `remote catch-up ${index}\n`);
      expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    }
    await measureReader('catch-up 5 commits');
  }, 300_000);

  it('measures a one-file remote change with many local packs', async () => {
    await addSyntheticPacks(fixture.reader, packCount);
    await writeNote(fixture.writerDir, 11, 'remote edit with many packs\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    await measureReader(`remote 1 file, +${packCount} packs`);
    expect(report[`remote 1 file, +${packCount} packs`]!.localPacks).toBeLessThanOrEqual(24);
  }, 300_000);

  it('measures a one-file remote change after local packs were consolidated', async () => {
    await writeNote(fixture.writerDir, 13, 'remote edit after consolidation\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    await measureReader('remote 1 file, consolidated');
  }, 300_000);

  // Background ticks after this session's inventory: ordinary edits are
  // captured from their watcher hints, so cost does not grow with the vault.
  it('measures background maintenance from watcher hints', async () => {
    // Settle what the foreground rows above left behind.
    await expireStaleHorizons(fixture.reader);
    expect((await tickUntilSettled(fixture.reader)).at(-1)).toMatch(/:Synced$/u);
    const idle = await measureBackground('bg idle');
    const ownPush = await measureBackground('bg own push 1 file', [await writeNote(fixture.readerDir, 31, 'hinted local edit\n')]);
    const again = await measureBackground('bg own push again', [await writeNote(fixture.readerDir, 32, 'second hinted edit\n')]);
    for (const cost of [idle, ownPush, again]) expect(cost.byArea.vault ?? 0).toBeLessThanOrEqual(40);
    expect(idle.calls).toBeLessThanOrEqual(45);
    for (const cost of [ownPush, again]) expect(cost.calls).toBeLessThanOrEqual(1200);
    await writeNote(fixture.writerDir, 33, 'remote edit seen by ticks\n');
    expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
    const remote = await measureBackground('bg remote 1 file');
    expect(remote.byArea.vault ?? 0).toBeLessThanOrEqual(75);
    expect(remote.calls).toBeLessThanOrEqual(950);
    await expireStaleHorizons(fixture.reader);
    const settled = await measureBackground('bg remote horizon settle');
    expect(settled.byArea.vault ?? 0).toBeLessThanOrEqual(10);
    expect(settled.calls).toBeLessThanOrEqual(125);
  }, 300_000);

  it('keeps syncing when local pack maintenance fails', async () => {
    const core = (fixture.reader as unknown as { client: any }).client;
    const consolidator = core.packConsolidator;
    core.packConsolidator = { run: async () => { throw Object.assign(new Error('simulated maintenance failure'), { code: 'EIO' }); } };
    try {
      await writeNote(fixture.writerDir, 14, 'remote edit while maintenance fails\n');
      expect((await syncUntilSettled(fixture.writer)).at(-1)).toBe('Synced');
      expect((await syncUntilSettled(fixture.reader)).at(-1)).toBe('Synced');
      expect(core.lastPackMaintenance).toEqual({ status: 'failed', reason: 'EIO' });
    } finally {
      core.packConsolidator = consolidator;
    }
  }, 300_000);
});
