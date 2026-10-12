import { describe, expect, it } from 'vitest';
import { RefreshScheduler, mergeRefreshScope, type RefreshScope } from '../frontend/dashboard/src/refreshScheduler.js';

function gated() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function setup() {
  const runs: Array<{ scope: RefreshScope; gate: ReturnType<typeof gated> }> = [];
  const errors: unknown[] = [];
  const scheduler = new RefreshScheduler({
    run: (scope) => {
      const gate = gated();
      runs.push({ scope, gate });
      return gate.promise;
    },
    onRunError: (error) => errors.push(error)
  });
  return { scheduler, runs, errors };
}

describe('mergeRefreshScope', () => {
  it('lets a full refresh beat a vault-only refresh in either order', () => {
    expect(mergeRefreshScope(null, 'vault')).toBe('vault');
    expect(mergeRefreshScope(null, 'full')).toBe('full');
    expect(mergeRefreshScope('vault', 'vault')).toBe('vault');
    expect(mergeRefreshScope('vault', 'full')).toBe('full');
    expect(mergeRefreshScope('full', 'vault')).toBe('full');
    expect(mergeRefreshScope('full', 'full')).toBe('full');
  });
});

describe('RefreshScheduler', () => {
  it('runs a request immediately when idle and merges same-tick requests into one run', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('vault');
    scheduler.request('vault');
    scheduler.request('full');
    expect(runs).toHaveLength(0);
    await settle();
    expect(runs.map((run) => run.scope)).toEqual(['full']);
    expect(scheduler.busy).toBe(true);
    runs[0]!.gate.release();
    await settle();
    expect(scheduler.busy).toBe(false);
    expect(runs).toHaveLength(1);
  });

  it('turns a burst during one in-flight refresh into exactly one trailing refresh', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('vault');
    await settle();
    expect(runs).toHaveLength(1);
    for (let i = 0; i < 5; i++) scheduler.request('vault');
    await settle();
    expect(runs).toHaveLength(1);
    expect(scheduler.pendingScope).toBe('vault');
    runs[0]!.gate.release();
    await settle();
    expect(runs.map((run) => run.scope)).toEqual(['vault', 'vault']);
    expect(scheduler.pendingScope).toBeNull();
    runs[1]!.gate.release();
    await settle();
    expect(runs).toHaveLength(2);
    expect(scheduler.busy).toBe(false);
  });

  it('merges scopes into the trailing obligation: full beats vault regardless of order', async () => {
    const first = setup();
    first.scheduler.request('vault');
    await settle();
    first.scheduler.request('vault');
    first.scheduler.request('full');
    first.scheduler.request('vault');
    first.runs[0]!.gate.release();
    await settle();
    expect(first.runs.map((run) => run.scope)).toEqual(['vault', 'full']);

    const second = setup();
    second.scheduler.request('full');
    await settle();
    second.scheduler.request('vault');
    second.runs[0]!.gate.release();
    await settle();
    expect(second.runs.map((run) => run.scope)).toEqual(['full', 'vault']);
  });

  it('a request made while the trailing refresh runs becomes the next single obligation', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('vault');
    await settle();
    scheduler.request('vault');
    runs[0]!.gate.release();
    await settle();
    expect(runs).toHaveLength(2);
    scheduler.request('full');
    scheduler.request('full');
    runs[1]!.gate.release();
    await settle();
    expect(runs.map((run) => run.scope)).toEqual(['vault', 'vault', 'full']);
  });

  it('never starts a run while external work (a manual refresh) is in flight and runs the obligation afterwards', async () => {
    const { scheduler, runs } = setup();
    const end = scheduler.begin();
    expect(scheduler.busy).toBe(true);
    scheduler.request('vault');
    scheduler.request('vault');
    await settle();
    expect(runs).toHaveLength(0);
    expect(scheduler.pendingScope).toBe('vault');
    end();
    await settle();
    expect(runs.map((run) => run.scope)).toEqual(['vault']);
  });

  it('waits for every overlapping external refresh before the trailing run, and end() is idempotent', async () => {
    const { scheduler, runs } = setup();
    const endManual = scheduler.begin();
    const endOther = scheduler.begin();
    scheduler.request('full');
    endManual();
    endManual();
    await settle();
    expect(runs).toHaveLength(0);
    endOther();
    await settle();
    expect(runs.map((run) => run.scope)).toEqual(['full']);
  });

  it('does not run anything when nothing was requested during external work', async () => {
    const { scheduler, runs } = setup();
    scheduler.begin()();
    await settle();
    expect(runs).toHaveLength(0);
    expect(scheduler.busy).toBe(false);
  });

  it('reset() discards the obligation and ignores completions from the old generation', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('vault');
    await settle();
    const end = scheduler.begin();
    scheduler.request('full');
    scheduler.reset();
    expect(scheduler.pendingScope).toBeNull();
    expect(scheduler.busy).toBe(false);
    runs[0]!.gate.release();
    end();
    await settle();
    expect(runs).toHaveLength(1);
    expect(scheduler.busy).toBe(false);

    scheduler.request('vault');
    await settle();
    expect(runs).toHaveLength(2);
    expect(scheduler.busy).toBe(true);
    runs[1]!.gate.release();
    await settle();
    expect(scheduler.busy).toBe(false);
  });

  it('a stale generation cannot release the new generation\'s in-flight work', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('vault');
    await settle();
    scheduler.reset();
    scheduler.request('vault');
    await settle();
    expect(runs).toHaveLength(2);
    scheduler.request('vault');
    runs[0]!.gate.release();
    await settle();
    expect(runs).toHaveLength(2);
    expect(scheduler.busy).toBe(true);
    runs[1]!.gate.release();
    await settle();
    expect(runs).toHaveLength(3);
  });

  it('survives a rejecting or throwing run and still serves the trailing obligation', async () => {
    const calls: RefreshScope[] = [];
    const errors: unknown[] = [];
    let mode: 'reject' | 'throw' | 'ok' = 'reject';
    const scheduler = new RefreshScheduler({
      run: (scope) => {
        calls.push(scope);
        if (mode === 'throw') throw new Error('sync');
        if (mode === 'reject') return Promise.reject(new Error('async'));
        return Promise.resolve();
      },
      onRunError: (error) => errors.push(error)
    });
    scheduler.request('vault');
    await settle();
    mode = 'throw';
    scheduler.request('vault');
    await settle();
    mode = 'ok';
    scheduler.request('full');
    await settle();
    expect(calls).toEqual(['vault', 'vault', 'full']);
    expect(errors).toHaveLength(2);
    expect(scheduler.busy).toBe(false);
  });
});
