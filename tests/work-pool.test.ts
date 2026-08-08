import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createByteBudget, runBoundedWork } = require('../obsidian-plugin/src/work-pool.cjs') as {
  createByteBudget: (maxBytes: number) => { acquire: (bytes: number) => Promise<() => void> };
  runBoundedWork: <T, R>(
    items: T[],
    options: { concurrency: number; yieldEvery?: number; onProgress?: (completed: number, total: number) => void },
    worker: (item: T, index: number) => Promise<R>
  ) => Promise<R[]>;
};

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

describe('bounded client work pool', () => {
  it('limits concurrency while preserving result order', async () => {
    let active = 0;
    let maximum = 0;
    const progress: number[] = [];
    const result = await runBoundedWork(
      [30, 5, 20, 10, 15],
      { concurrency: 3, onProgress: (completed) => progress.push(completed) },
      async (milliseconds, index) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(milliseconds);
        active -= 1;
        return index;
      }
    );

    expect(maximum).toBe(3);
    expect(result).toEqual([0, 1, 2, 3, 4]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  it('drains active work and stops scheduling after the first failure', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;

    await expect(runBoundedWork([0, 1, 2, 3, 4], { concurrency: 2 }, async (item) => {
      started.push(item);
      active += 1;
      if (item === 0) {
        await delay(5);
        active -= 1;
        throw new Error('failed');
      }
      await delay(20);
      active -= 1;
      finished.push(item);
      return item;
    })).rejects.toThrow('failed');

    expect(active).toBe(0);
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });

  it('bounds retained bytes and rejects a single oversized item', async () => {
    const budget = createByteBudget(10);
    let retained = 0;
    let maximum = 0;

    await runBoundedWork([6, 4, 6, 4], { concurrency: 4 }, async (bytes) => {
      const release = await budget.acquire(bytes);
      retained += bytes;
      maximum = Math.max(maximum, retained);
      await delay(5);
      retained -= bytes;
      release();
      return bytes;
    });

    expect(maximum).toBeLessThanOrEqual(10);
    await expect(budget.acquire(20)).rejects.toMatchObject({
      code: 'file_buffer_budget_exceeded'
    });
    expect(retained).toBe(0);
  });
});
