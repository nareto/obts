import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MetadataCommit, MetadataDb } from '../src/server/metadataStore.js';
import {
  READINESS_IN_FLIGHT_SLACK_MS, READINESS_SAMPLE_INTERVAL_MS, READINESS_STALE_AFTER_MS, ReadinessSampler, projectDashboardHealth,
  type ReadinessSource, type ReadinessSummary
} from '../src/server/readinessSampler.js';
import { createStoreFixture, removeRoots, MINUTE } from './helpers/dashboardStoreFixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await removeRoots(roots);
});

const ready = (): ReadinessSummary => ({
  status: 'ready',
  detail: null,
  git_version: 'git version 2',
  checks: {
    metadata: true, metadata_store: true, git: true, setup_complete: true, migrations: true, git_store: true,
    temp_workspace: true, filesystem_permissions: true, event_delivery: true, persistent_state: true
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const healthyChecks = (health: ReturnType<typeof projectDashboardHealth>) => Object.values(health.checks).filter(Boolean).length;

describe('server-owned readiness sampler', () => {
  it('shares one in-flight run among the initial sample, probes and the timer', async () => {
    const gate = deferred<ReadinessSummary>();
    const run = vi.fn(async () => await gate.promise);
    const sampler = new ReadinessSampler({ run });
    sampler.start();
    const probes = [sampler.sample(), sampler.sample(), sampler.sample()];
    await Promise.resolve();
    expect(sampler.view()).toMatchObject({ checking: true, summary: null, completedAtMs: null });
    gate.resolve(ready());
    expect((await Promise.all(probes)).every((summary) => summary.status === 'ready')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sampler.view()).toMatchObject({ checking: false, failed: false });
    await sampler.sample();
    expect(run).toHaveBeenCalledTimes(2);
    await sampler.close();
  });

  it('samples periodically outside requests and stops after close', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ready());
    const sampler = new ReadinessSampler({ run, intervalMs: 5 * MINUTE });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(3);
    await sampler.close();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(run).toHaveBeenCalledTimes(3);
    await expect(sampler.sample()).rejects.toThrow();
  });

  it('close drains the in-flight run before resolving', async () => {
    const gate = deferred<ReadinessSummary>();
    const sampler = new ReadinessSampler({ run: async () => await gate.promise });
    const pending = sampler.sample();
    let closed = false;
    const closing = sampler.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    gate.resolve(ready());
    await closing;
    await pending;
    expect(closed).toBe(true);
  });

  it('records a failed run without leaking the error, rejects probes and recovers on the next run', async () => {
    let fail = true;
    const onFailure = vi.fn();
    let clock = 1_000;
    const sampler = new ReadinessSampler({
      run: async () => { if (fail) throw new Error('/private/path exploded'); return ready(); },
      now: () => clock,
      onFailure
    });
    await expect(sampler.sample()).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledTimes(1);
    const health = projectDashboardHealth({ view: sampler.view(), nowMs: clock });
    expect(health).toMatchObject({ status: 'not_ready', state: 'failed', checking: false, checked_at: new Date(1_000).toISOString() });
    expect(JSON.stringify(health)).not.toContain('private');
    expect(healthyChecks(health)).toBe(1);
    fail = false;
    clock = 2_000;
    await sampler.sample();
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock })).toMatchObject({ status: 'ready', state: 'verified' });
    await sampler.close();
  });

  it('survives a throwing failure reporter', async () => {
    const sampler = new ReadinessSampler({
      run: async () => { throw new Error('boom'); },
      onFailure: () => { throw new Error('reporter'); }
    });
    await expect(sampler.sample()).rejects.toThrow('boom');
    await sampler.close();
  });
});

describe('dashboard health projection', () => {
  it('projects pending, verified, stale and overridden observations honestly', async () => {
    const gate = deferred<ReadinessSummary>();
    const clock = Date.parse('2026-01-01T00:00:00.000Z');
    const sampler = new ReadinessSampler({ run: async () => await gate.promise, now: () => clock });
    const pending = projectDashboardHealth({ view: sampler.view(), nowMs: clock });
    expect(pending).toMatchObject({ status: 'not_ready', state: 'pending', checked_at: null, checking: false, stale: true, git_version: 'unknown' });
    expect(healthyChecks(pending)).toBe(1);
    const running = sampler.sample();
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock })).toMatchObject({ state: 'pending', checking: true });
    gate.resolve(ready());
    await running;
    const verified = projectDashboardHealth({ view: sampler.view(), nowMs: clock });
    expect(verified).toMatchObject({ status: 'ready', state: 'verified', stale: false, checking: false, detail: null });
    expect(verified.checked_at).toBe('2026-01-01T00:00:00.000Z');
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock + READINESS_STALE_AFTER_MS })).toMatchObject({ state: 'verified', stale: false });
    const stale = projectDashboardHealth({ view: sampler.view(), nowMs: clock + READINESS_STALE_AFTER_MS + 1 });
    expect(stale).toMatchObject({ status: 'not_ready', state: 'stale', stale: true, checked_at: '2026-01-01T00:00:00.000Z' });
    expect(healthyChecks(stale)).toBe(1);
    const overridden = projectDashboardHealth({
      view: sampler.view(), nowMs: clock, override: { detail: 'vault persistent state is blocked', failedChecks: ['persistent_state'] }
    });
    expect(overridden).toMatchObject({ status: 'not_ready', state: 'not_ready', detail: 'vault persistent state is blocked' });
    expect(overridden.checks).toMatchObject({ persistent_state: false, git: true });
    const unavailable = projectDashboardHealth({
      view: sampler.view(), nowMs: clock, override: { detail: 'metadata durability is unavailable', failedChecks: 'all' }
    });
    expect(unavailable.checks.metadata_store).toBe(false);
    expect(unavailable.checks.git).toBe(false);
    await sampler.close();
  });

  it('keeps projecting the previous verdict while a slower re-sample is in flight, and only a stuck one turns stale', async () => {
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    let clock = t0;
    const second = deferred<ReadinessSummary>();
    let calls = 0;
    const sampler = new ReadinessSampler({ run: async () => (++calls === 1 ? ready() : await second.promise), now: () => clock });
    await sampler.sample();
    clock = t0 + READINESS_SAMPLE_INTERVAL_MS + 1;
    const running = sampler.sample('sampler');
    expect(sampler.view().checking).toBe(true);
    const slow = projectDashboardHealth({ view: sampler.view(), nowMs: clock });
    expect(slow).toMatchObject({ status: 'ready', state: 'verified', checking: true, stale: false, detail: null, checked_at: new Date(t0).toISOString() });
    expect(Object.values(slow.checks).every(Boolean)).toBe(true);
    const edge = t0 + READINESS_SAMPLE_INTERVAL_MS + READINESS_IN_FLIGHT_SLACK_MS;
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: edge })).toMatchObject({ state: 'verified', checking: true, stale: false });
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: edge + 1 })).toMatchObject({ status: 'not_ready', state: 'stale', checking: true, stale: true });
    const idleAtEdge = new ReadinessSampler({ run: async () => ready(), now: () => t0 });
    await idleAtEdge.sample();
    expect(projectDashboardHealth({ view: idleAtEdge.view(), nowMs: edge })).toMatchObject({ state: 'stale', checking: false });
    second.resolve(ready());
    await running;
    clock = edge;
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock })).toMatchObject({ state: 'verified', checking: false, stale: false });
    await sampler.close();
    await idleAtEdge.close();
  });

  it('tolerates a full missed cycle: stale only after twice the sampling interval', () => {
    expect(READINESS_STALE_AFTER_MS).toBe(2 * READINESS_SAMPLE_INTERVAL_MS);
  });

  it('treats a clock rollback as stale and a non-ready sample as not_ready', async () => {
    let clock = 10 * MINUTE * 10;
    const notReady: ReadinessSummary = { ...ready(), status: 'not_ready', detail: 'git store unreadable', checks: { ...ready().checks, git_store: false } };
    const sampler = new ReadinessSampler({ run: async () => notReady, now: () => clock });
    await sampler.sample();
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock })).toMatchObject({ state: 'not_ready', detail: 'git store unreadable', stale: false });
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: clock - READINESS_STALE_AFTER_MS - 1 })).toMatchObject({ state: 'stale', stale: true });
    clock += 1;
    await sampler.close();
  });
});

describe('sampler sources and verdict change notification', () => {
  it('tags the initial sample startup, timer samples sampler and explicit calls request', async () => {
    vi.useFakeTimers();
    const sources: ReadinessSource[] = [];
    const sampler = new ReadinessSampler({ run: async (source) => { sources.push(source); return ready(); }, intervalMs: 5 * MINUTE });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await sampler.sample();
    expect(sources).toEqual(['startup', 'sampler', 'request']);
    await sampler.close();
  });

  it('notifies only when the projected verdict changes, ignoring checked_at and checking', async () => {
    let clock = 1_000;
    let next: ReadinessSummary | Error = ready();
    const onVerdictChange = vi.fn();
    const sampler = new ReadinessSampler({
      run: async () => { if (next instanceof Error) throw next; return next; },
      now: () => clock,
      onFailure: () => undefined,
      onVerdictChange
    });
    await sampler.sample();
    expect(onVerdictChange).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await sampler.sample();
    expect(onVerdictChange).toHaveBeenCalledTimes(1);
    next = { ...ready(), status: 'not_ready', detail: 'git store unreadable', checks: { ...ready().checks, git_store: false } };
    await sampler.sample();
    expect(onVerdictChange).toHaveBeenCalledTimes(2);
    await sampler.sample();
    expect(onVerdictChange).toHaveBeenCalledTimes(2);
    next = new Error('boom');
    await expect(sampler.sample()).rejects.toThrow('boom');
    expect(onVerdictChange).toHaveBeenCalledTimes(3);
    await expect(sampler.sample()).rejects.toThrow('boom');
    expect(onVerdictChange).toHaveBeenCalledTimes(3);
    next = ready();
    await sampler.sample();
    expect(onVerdictChange).toHaveBeenCalledTimes(4);
    await sampler.close();
  });

  it('survives a throwing change listener', async () => {
    const sampler = new ReadinessSampler({ run: async () => ready(), onVerdictChange: () => { throw new Error('listener'); } });
    await expect(sampler.sample()).resolves.toMatchObject({ status: 'ready' });
    expect(projectDashboardHealth({ view: sampler.view(), nowMs: Date.now() }).state).toBe('verified');
    await sampler.close();
  });
});

describe('metadata commit-boundary subscription', () => {
  const tick = async () => await new Promise((resolve) => setImmediate(resolve));

  it('notifies detached listeners only after durable publication, never for a failed one', async () => {
    const f = await createStoreFixture(roots);
    const seen: Array<{ before: number; after: number }> = [];
    const listener = vi.fn((commit: MetadataCommit) => {
      seen.push({ before: commit.previous.users.length, after: commit.current.users.length });
    });
    const off = f.store.subscribeCommits(listener);
    f.writes.mockRejectedValueOnce(new Error('disk refused'));
    await expect(f.store.mutate((db) => { db.users.pop(); })).rejects.toThrow();
    await tick();
    expect(listener).not.toHaveBeenCalled();
    expect((await f.store.snapshot()).users).toHaveLength(2);
    await f.store.mutate((db) => { db.users.pop(); });
    expect(listener).not.toHaveBeenCalled();
    await tick();
    expect(seen).toEqual([{ before: 2, after: 1 }]);
    off();
    await f.store.mutate((db) => { db.users.pop(); });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('covers mutateDurably and readOrMutate, and a failing listener cannot affect commits or other listeners', async () => {
    const f = await createStoreFixture(roots);
    const order: string[] = [];
    f.store.subscribeCommits(() => { order.push('throws'); throw new Error('listener failure'); });
    f.store.subscribeCommits(() => { order.push('second'); });
    await f.store.mutateDurably((db) => { db.setup_complete = true; });
    await f.store.readOrMutate((db) => db.setup_complete, () => true, (db) => { db.setup_complete = false; return false; });
    await f.store.readOrMutate((db) => db.setup_complete, () => false, () => true);
    await tick();
    expect(order).toEqual(['throws', 'second', 'throws', 'second']);
    expect((await f.store.snapshot()).setup_complete).toBe(false);
  });

  it('does not notify when a transaction throws and versions only durable commits', async () => {
    const f = await createStoreFixture(roots);
    const listener = vi.fn();
    f.store.subscribeCommits(listener);
    const before = f.store.commitVersion();
    await expect(f.store.mutate(() => { throw new Error('aborted'); })).rejects.toThrow('aborted');
    await tick();
    expect(listener).not.toHaveBeenCalled();
    expect(f.store.commitVersion()).toBe(before);
    await f.store.mutate((db) => { db.setup_complete = true; });
    const versioned = await f.store.snapshotVersioned();
    expect(versioned.version).toBe(before + 1);
    expect(versioned.db.setup_complete).toBe(true);
  });
  it('coalesces a synchronous burst into one transition spanning it', async () => {
    const f = await createStoreFixture(roots);
    const calls: Array<{ previous: MetadataCommit['previous']; current: MetadataCommit['current'] }> = [];
    f.store.subscribeCommits((commit) => { calls.push({ previous: commit.previous, current: commit.current }); });
    const base = await f.store.snapshot();
    const states = Array.from({ length: 8 }, (_unused, index) => {
      const state = structuredClone(base);
      state.event_seq_by_vault.burst = index;
      return state;
    });
    // Persisting always yields to real I/O, so a true same-tick burst is only reachable at the seam itself.
    const publish = (previous: MetadataDb, current: MetadataDb) =>
      (f.store as unknown as { publishCommit(a: MetadataDb, b: MetadataDb): void }).publishCommit(previous, current);
    const version = f.store.commitVersion();
    for (let index = 1; index < states.length; index += 1) publish(states[index - 1]!, states[index]!);
    expect(f.store.commitVersion()).toBe(version + 7);
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.previous.event_seq_by_vault.burst).toBe(0);
    expect(calls[0]!.current.event_seq_by_vault.burst).toBe(7);
    publish(states[7]!, states[6]!);
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.previous.event_seq_by_vault.burst).toBe(7);
  });

  it('never skips or reorders a transition when real commits are coalesced', async () => {
    const f = await createStoreFixture(roots);
    const calls: Array<{ before: number | undefined; after: number | undefined }> = [];
    f.store.subscribeCommits((commit) => {
      calls.push({ before: commit.previous.event_seq_by_vault.burst, after: commit.current.event_seq_by_vault.burst });
    });
    await Promise.all(Array.from({ length: 6 }, async (_unused, index) =>
      await f.store.mutate((db) => { db.event_seq_by_vault.burst = index + 1; })));
    await tick();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls[0]!.before).toBeUndefined();
    expect(calls.at(-1)!.after).toBe(6);
    calls.slice(1).forEach((call, index) => expect(call.before).toBe(calls[index]!.after));
  });
});
