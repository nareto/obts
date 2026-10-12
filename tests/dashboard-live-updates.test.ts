import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_EVENTS_URL,
  LiveUpdates,
  parseInvalidation,
  type EventSourceLike,
  type LiveRefreshRequest,
  type LiveState
} from '../frontend/dashboard/src/liveUpdates.js';

const FALLBACK_MS = 15_000;
const AGING_MS = 60_000;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  /** Browser keeps retrying by itself (readyState CONNECTING). */
  transientError() {
    this.readyState = 0;
    this.emit('error');
  }
  /** Browser gave up (readyState CLOSED), e.g. after a 401 or a non event-stream response. */
  fatalError() {
    this.readyState = 2;
    this.emit('error');
  }
  static get open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((source) => !source.closed);
  }
}

type Timer = { id: number; at: number; callback: () => void };

function harness(overrides: { selected?: string; hidden?: boolean; supported?: boolean; session?: () => Promise<boolean> } = {}) {
  FakeEventSource.instances = [];
  let now = 1_000_000;
  let nextId = 1;
  let timers: Timer[] = [];
  const env = {
    hidden: overrides.hidden ?? false,
    selected: overrides.selected ?? 'vlt_a',
    visibilityListeners: new Set<() => void>()
  };
  const requests: LiveRefreshRequest[] = [];
  const states: LiveState[] = [];
  const sessionChecks: number[] = [];
  let sessionImpl = overrides.session ?? (() => Promise.resolve(true));
  const live = new LiveUpdates({
    createEventSource: overrides.supported === false ? null : (url) => new FakeEventSource(url),
    requestRefresh: (request) => requests.push(request),
    getSelectedVaultId: () => env.selected,
    checkSession: () => {
      sessionChecks.push(now);
      return sessionImpl();
    },
    onStateChange: (state) => states.push(state),
    fallbackIntervalMs: FALLBACK_MS,
    agingIntervalMs: AGING_MS,
    setTimeout: (callback, ms) => {
      const timer = { id: nextId++, at: now + ms, callback };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    now: () => now,
    random: () => 0,
    isHidden: () => env.hidden,
    onVisibilityChange: (listener) => {
      env.visibilityListeners.add(listener);
      return () => env.visibilityListeners.delete(listener);
    }
  });
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  const setHidden = (hidden: boolean) => {
    env.hidden = hidden;
    for (const listener of [...env.visibilityListeners]) listener();
  };
  const polls = () => requests.filter((request) => request.source === 'poll');
  return {
    live, env, requests, states, sessionChecks, advance, setHidden, polls,
    timerCount: () => timers.length,
    setSession: (impl: () => Promise<boolean>) => { sessionImpl = impl; },
    clearRequests: () => { requests.length = 0; }
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('parseInvalidation', () => {
  it('accepts the closed schema and rejects anything else', () => {
    expect(parseInvalidation('{"account":true,"vault_ids":[]}')).toEqual({ account: true, vaultIds: [] });
    expect(parseInvalidation('{"account":false,"vault_ids":["vlt_a","vlt_b"]}')).toEqual({ account: false, vaultIds: ['vlt_a', 'vlt_b'] });
    for (const bad of [undefined, null, 5, '', 'not json', '[]', '"x"', 'null', '{}', '{"account":"yes","vault_ids":[]}', '{"account":false}', '{"account":false,"vault_ids":"vlt_a"}', '{"account":false,"vault_ids":[1]}']) {
      expect(parseInvalidation(bad)).toBeNull();
    }
  });
});

describe('live connection state', () => {
  it('opens exactly one same-origin stream with no query string or credentials option', () => {
    const t = harness();
    t.live.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/v1/dashboard/events');
    expect(DASHBOARD_EVENTS_URL).not.toContain('?');
    expect(t.live.currentState).toBe('connecting');
  });

  it('is live only after the refresh frame, never merely on open, and requests a full refresh', () => {
    const t = harness();
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.open();
    expect(t.live.currentState).toBe('connecting');
    expect(t.requests).toEqual([]);
    source.emit('refresh', '{}');
    expect(t.live.currentState).toBe('live');
    expect(t.requests).toEqual([{ scope: 'full', source: 'connect' }]);
    expect(t.states).toEqual(['live']);
  });

  it('refreshes only for invalidations that name the selected vault, or the account', () => {
    const t = harness({ selected: 'vlt_a' });
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.emit('refresh', '{}');
    t.clearRequests();
    source.emit('invalidate', '{"account":false,"vault_ids":["vlt_b","vlt_c"]}');
    source.emit('invalidate', '{"account":false,"vault_ids":[]}');
    expect(t.requests).toEqual([]);
    source.emit('invalidate', '{"account":false,"vault_ids":["vlt_b","vlt_a"]}');
    expect(t.requests).toEqual([{ scope: 'vault', source: 'event' }]);
    t.clearRequests();
    source.emit('invalidate', '{"account":true,"vault_ids":[]}');
    expect(t.requests).toEqual([{ scope: 'full', source: 'event' }]);
    t.clearRequests();
    t.env.selected = '';
    source.emit('invalidate', '{"account":false,"vault_ids":["vlt_a"]}');
    expect(t.requests).toEqual([]);
  });

  it('follows the vault that is selected when the event arrives, not when the stream opened', () => {
    const t = harness({ selected: 'vlt_a' });
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.emit('refresh', '{}');
    t.clearRequests();
    t.env.selected = 'vlt_b';
    source.emit('invalidate', '{"account":false,"vault_ids":["vlt_a"]}');
    expect(t.requests).toEqual([]);
    source.emit('invalidate', '{"account":false,"vault_ids":["vlt_b"]}');
    expect(t.requests).toEqual([{ scope: 'vault', source: 'event' }]);
  });

  it('treats malformed invalidate data as a full refresh and never throws', () => {
    const t = harness();
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.emit('refresh', '{}');
    for (const bad of [undefined, null, 42, 'oops', '{"account":', '{"vault_ids":["vlt_a"]}', '{"account":false,"vault_ids":[null]}', '[]']) {
      t.clearRequests();
      expect(() => source.emit('invalidate', bad)).not.toThrow();
      expect(t.requests).toEqual([{ scope: 'full', source: 'event' }]);
    }
  });

  it('keeps working when the refresh consumer throws', () => {
    const t = harness();
    const throwing = new LiveUpdates({
      createEventSource: (url) => new FakeEventSource(url),
      requestRefresh: () => { throw new Error('boom'); },
      getSelectedVaultId: () => 'vlt_a',
      checkSession: () => Promise.resolve(true),
      fallbackIntervalMs: FALLBACK_MS,
      agingIntervalMs: AGING_MS,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      now: () => 0,
      isHidden: () => false,
      onVisibilityChange: () => () => undefined
    });
    throwing.start();
    const source = FakeEventSource.open.at(-1)!;
    expect(() => source.emit('refresh', '{}')).not.toThrow();
    expect(throwing.currentState).toBe('live');
    throwing.stop();
    expect(t.live.currentState).toBe('connecting');
  });

  it('ignores heartbeat comments and unknown frames', () => {
    const t = harness();
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.emit('refresh', '{}');
    t.clearRequests();
    source.emit('message', ': heartbeat');
    source.emit('heartbeat', '');
    source.emit('open');
    expect(t.requests).toEqual([]);
    expect(t.live.currentState).toBe('live');
  });

  it('goes to reconnecting on a transient error, lets the browser retry, and checks the session at once', async () => {
    const t = harness();
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.emit('refresh', '{}');
    source.transientError();
    expect(t.live.currentState).toBe('reconnecting');
    expect(t.sessionChecks).toHaveLength(1);
    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    source.emit('refresh', '{}');
    expect(t.live.currentState).toBe('live');
    expect(t.states).toEqual(['live', 'reconnecting', 'live']);
  });

  it('closes and reconnects itself with capped exponential backoff when the browser gives up, and resets after refresh', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.open[0]!.fatalError();
      expect(t.live.currentState).toBe('reconnecting');
      expect(FakeEventSource.open).toHaveLength(0);
      const expected = [5000, 10000, 20000, 40000, 60000, 60000, 60000][attempt]!;
      await t.advance(expected - 1);
      expect(FakeEventSource.instances).toHaveLength(before);
      await t.advance(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
      delays.push(expected);
    }
    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
    FakeEventSource.open[0]!.emit('refresh', '{}');
    expect(t.live.currentState).toBe('live');
    FakeEventSource.open[0]!.fatalError();
    const count = FakeEventSource.instances.length;
    await t.advance(4999);
    expect(FakeEventSource.instances).toHaveLength(count);
    await t.advance(1);
    expect(FakeEventSource.instances).toHaveLength(count + 1);
  });

  it('adds only positive jitter to the reconnect delay', () => {
    FakeEventSource.instances = [];
    const delaysSeen: number[] = [];
    const jittered = new LiveUpdates({
      createEventSource: (url) => new FakeEventSource(url),
      requestRefresh: () => undefined,
      getSelectedVaultId: () => '',
      checkSession: () => Promise.resolve(true),
      fallbackIntervalMs: FALLBACK_MS,
      agingIntervalMs: AGING_MS,
      random: () => 1,
      setTimeout: (_callback, ms) => { delaysSeen.push(ms); return 1; },
      clearTimeout: () => undefined,
      now: () => 0,
      isHidden: () => false,
      onVisibilityChange: () => () => undefined
    });
    jittered.start();
    FakeEventSource.open.at(-1)!.fatalError();
    expect(delaysSeen).toContain(6000);
    expect(delaysSeen.every((delay) => delay >= 5000)).toBe(true);
  });

  it('checks the session on every self-driven reconnect step but rate-limits browser-driven retries', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    FakeEventSource.open[0]!.fatalError();
    expect(t.sessionChecks).toHaveLength(1);
    await t.advance(5000);
    FakeEventSource.open[0]!.fatalError();
    expect(t.sessionChecks).toHaveLength(2);
    await t.advance(10000);
    FakeEventSource.open[0]!.fatalError();
    expect(t.sessionChecks).toHaveLength(3);

    const noisy = harness();
    noisy.live.start();
    const source = FakeEventSource.open[0]!;
    for (let i = 0; i < 6; i++) {
      source.transientError();
      await noisy.advance(5000);
    }
    expect(noisy.sessionChecks.length).toBeLessThanOrEqual(3);
    expect(noisy.sessionChecks.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < noisy.sessionChecks.length; i++) {
      expect(noisy.sessionChecks[i]! - noisy.sessionChecks[i - 1]!).toBeGreaterThanOrEqual(5000);
    }
  });

  it('does not stack session checks while one is in flight', async () => {
    let resolve: (value: boolean) => void = () => undefined;
    const t = harness({ session: () => new Promise<boolean>((done) => { resolve = done; }) });
    t.live.start();
    const source = FakeEventSource.open[0]!;
    source.transientError();
    source.transientError();
    source.transientError();
    expect(t.sessionChecks).toHaveLength(1);
    resolve(true);
    await flush();
    expect(t.live.isStarted).toBe(true);
  });

  it('stops everything when the session check reports the session is gone', async () => {
    const t = harness({ session: () => Promise.resolve(false) });
    t.live.start();
    FakeEventSource.open[0]!.fatalError();
    await flush();
    expect(t.live.isStarted).toBe(false);
    expect(FakeEventSource.open).toHaveLength(0);
    expect(t.timerCount()).toBe(0);
    await t.advance(5 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(t.polls()).toEqual([]);
  });

  it('keeps retrying when the session check itself fails or the session is still valid', async () => {
    const t = harness({ session: () => Promise.reject(new Error('network')) });
    t.live.start();
    FakeEventSource.open[0]!.fatalError();
    await flush();
    expect(t.live.isStarted).toBe(true);
    await t.advance(5000);
    expect(FakeEventSource.open).toHaveLength(1);
  });

  it('reports unsupported without an EventSource and polls on the fallback interval', async () => {
    const t = harness({ supported: false });
    t.live.start();
    expect(t.live.currentState).toBe('unsupported');
    expect(FakeEventSource.instances).toHaveLength(0);
    await t.advance(FALLBACK_MS);
    expect(t.polls()).toHaveLength(1);
    await t.advance(FALLBACK_MS * 2);
    expect(t.polls()).toHaveLength(3);
  });

  it('polls every 15s while not live and ages every 60s only while live', async () => {
    const t = harness();
    t.live.start();
    await t.advance(FALLBACK_MS - 1);
    expect(t.polls()).toHaveLength(0);
    await t.advance(1);
    expect(t.polls()).toHaveLength(1);
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.clearRequests();
    await t.advance(AGING_MS - 1);
    expect(t.polls()).toHaveLength(0);
    await t.advance(1);
    expect(t.polls()).toEqual([{ scope: 'vault', source: 'poll' }]);
    await t.advance(AGING_MS);
    expect(t.polls()).toHaveLength(2);
    FakeEventSource.open[0]!.transientError();
    t.clearRequests();
    await t.advance(FALLBACK_MS);
    expect(t.polls()).toHaveLength(1);
    await t.advance(FALLBACK_MS);
    expect(t.polls()).toHaveLength(2);
  });

  it('never polls while the tab is hidden but still has a single timer chain', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.clearRequests();
    t.setHidden(true);
    await t.advance(AGING_MS - 1);
    expect(t.polls()).toHaveLength(0);
    t.setHidden(false);
    await t.advance(AGING_MS);
    expect(t.polls().length).toBeGreaterThanOrEqual(1);
  });

  it('pauses and closes after the tab has been hidden for more than 60s, then reconnects and refreshes at once', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.clearRequests();
    t.setHidden(true);
    await t.advance(59_999);
    expect(t.live.currentState).toBe('live');
    expect(FakeEventSource.open).toHaveLength(1);
    await t.advance(1);
    expect(t.live.currentState).toBe('paused');
    expect(FakeEventSource.open).toHaveLength(0);
    expect(t.timerCount()).toBe(0);
    await t.advance(10 * 60_000);
    expect(t.requests).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(1);

    t.setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.open).toHaveLength(1);
    expect(t.live.currentState).toBe('connecting');
    expect(t.requests).toEqual([{ scope: 'vault', source: 'visibility' }]);
    FakeEventSource.open[0]!.emit('refresh', '{}');
    expect(t.requests.at(-1)).toEqual({ scope: 'full', source: 'connect' });
    expect(t.live.currentState).toBe('live');
  });

  it('keeps the stream after a short hide and cancels the pending pause', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.setHidden(true);
    await t.advance(30_000);
    t.setHidden(false);
    await t.advance(120_000);
    expect(t.live.currentState).toBe('live');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.open).toHaveLength(1);
    expect(t.requests.filter((request) => request.source === 'visibility')).toEqual([]);
  });

  it('does not reconnect while paused even if a reconnect timer was pending', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.fatalError();
    t.setHidden(true);
    await t.advance(61_000);
    expect(t.live.currentState).toBe('paused');
    expect(t.timerCount()).toBe(0);
    const count = FakeEventSource.instances.length;
    await t.advance(5 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(count);
    expect(FakeEventSource.open).toHaveLength(0);
  });

  it('starts paused-capable when the document is already hidden', async () => {
    const t = harness({ hidden: true });
    t.live.start();
    await t.advance(60_000);
    expect(t.live.currentState).toBe('paused');
    expect(FakeEventSource.open).toHaveLength(0);
  });

  it('stop() closes the stream and clears every timer and listener', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.setHidden(true);
    FakeEventSource.open[0]!.transientError();
    t.live.stop();
    expect(FakeEventSource.open).toHaveLength(0);
    expect(t.timerCount()).toBe(0);
    expect(t.env.visibilityListeners.size).toBe(0);
    t.clearRequests();
    await t.advance(10 * 60_000);
    expect(t.requests).toEqual([]);
    expect(t.live.isStarted).toBe(false);
    expect(t.live.hasOpenStream).toBe(false);
    t.live.stop();
  });

  it('ignores late events from a closed stream', () => {
    const t = harness();
    t.live.start();
    const old = FakeEventSource.open[0]!;
    t.live.stop();
    t.clearRequests();
    old.emit('refresh', '{}');
    old.emit('invalidate', '{"account":true,"vault_ids":[]}');
    old.fatalError();
    expect(t.requests).toEqual([]);
    expect(t.sessionChecks).toEqual([]);
    expect(t.live.currentState).toBe('connecting');
  });

  it('never has two open streams across start/stop cycles, repeated starts and reconnects', async () => {
    const t = harness();
    for (let cycle = 0; cycle < 4; cycle++) {
      t.live.start();
      t.live.start();
      expect(FakeEventSource.open).toHaveLength(1);
      FakeEventSource.open[0]!.emit('refresh', '{}');
      FakeEventSource.open[0]!.fatalError();
      await t.advance(5000);
      expect(FakeEventSource.open).toHaveLength(1);
      t.setHidden(true);
      await t.advance(61_000);
      expect(FakeEventSource.open).toHaveLength(0);
      t.setHidden(false);
      expect(FakeEventSource.open).toHaveLength(1);
      t.live.stop();
      expect(FakeEventSource.open).toHaveLength(0);
      expect(t.timerCount()).toBe(0);
    }
    expect(t.env.visibilityListeners.size).toBe(0);
  });

  it('reports the state transitions an indicator needs', async () => {
    const t = harness();
    t.live.start();
    FakeEventSource.open[0]!.emit('refresh', '{}');
    FakeEventSource.open[0]!.fatalError();
    await t.advance(5000);
    FakeEventSource.open[0]!.emit('refresh', '{}');
    t.setHidden(true);
    await t.advance(60_000);
    t.setHidden(false);
    t.live.stop();
    expect(t.states).toEqual(['live', 'reconnecting', 'live', 'paused', 'connecting']);
  });
});
