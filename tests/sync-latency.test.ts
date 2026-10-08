import { describe, expect, it } from 'vitest';

import { observeGitCommand, observeMetadataPersist, observeSyncLatency } from '../src/server/syncLatency.js';

describe('integration latency observations', () => {
  it('counts only persists in its async operation, excluding concurrent traffic', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observed = observeSyncLatency(async () => {
      await observeMetadataPersist(async () => await gate);
      await observeGitCommand(async () => undefined);
      await observeMetadataPersist(async () => undefined);
      return 'result';
    });
    await observeMetadataPersist(async () => undefined);
    const other = await observeSyncLatency(async () => await observeMetadataPersist(async () => undefined));
    release();
    const first = await observed;
    expect(first.result).toBe('result');
    expect(first.latency.persist_count).toBe(2);
    expect(other.latency.persist_count).toBe(1);
    expect(first.latency.persist_ms).toBeGreaterThanOrEqual(0);
    expect(first.latency.git_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not swallow or replace operation failures', async () => {
    const error = new Error('synthetic failure');
    await expect(observeSyncLatency(async () => await observeMetadataPersist(async () => { throw error; })))
      .rejects.toBe(error);
    await expect(observeGitCommand(async () => { throw error; })).rejects.toBe(error);
  });
});
