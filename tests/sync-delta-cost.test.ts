import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addSyntheticPacks,
  createSyncCostFixture,
  syncUntilSettled,
  writeNote,
  type AdapterCost,
  type SyncCostFixture
} from './helpers/syncCostHarness.js';

const fileCount = Number(process.env.OBTS_COST_FILES ?? 300);
const packCount = Number(process.env.OBTS_COST_PACKS ?? 100);
const report: Record<string, AdapterCost & { statuses: string }> = {};

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
      statuses: cost.statuses
    }])));
    await fixture?.close();
  });

  async function measureReader(name: string): Promise<AdapterCost> {
    const { value, cost } = await fixture.meter.measure(() => syncUntilSettled(fixture.reader));
    report[name] = { ...cost, statuses: value.join(' > ') };
    expect(value.at(-1)).toBe('Synced');
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
  }, 300_000);
});
