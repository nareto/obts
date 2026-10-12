/**
 * Coalesces every dashboard refresh trigger (stream events, polling timers, visibility/focus) into at most one
 * run at a time plus ONE trailing obligation.
 *
 * - A request that arrives while any refresh is in flight is never dropped: it is merged into a single pending
 *   scope (`full` beats `vault`) and runs once the in-flight work has settled.
 * - Work the scheduler did not start (manual refresh, post-mutation refresh, the initial account load) registers
 *   itself with `begin()` so triggers wait for it instead of superseding it.
 * - `reset()` is called whenever the app clears its scoped state; completions from before the reset are ignored
 *   and the pending obligation (which belonged to the old scope) is discarded.
 *
 * It owns no response handling: callers keep their own epoch/generation guards so an older response can never be
 * painted over a newer one.
 */
export type RefreshScope = 'vault' | 'full';

export function mergeRefreshScope(current: RefreshScope | null, next: RefreshScope): RefreshScope {
  return current === 'full' || next === 'full' ? 'full' : 'vault';
}

export type RefreshSchedulerOptions = {
  /** Performs one refresh. It must settle; rejections are swallowed (the caller reports its own errors). */
  run: (scope: RefreshScope) => Promise<unknown> | unknown;
  /** Optional hook for errors thrown by `run`. */
  onRunError?: (error: unknown) => void;
};

export class RefreshScheduler {
  private active = 0;
  private pending: RefreshScope | null = null;
  private generation = 0;
  private flushQueued = false;
  private runs = 0;

  constructor(private readonly options: RefreshSchedulerOptions) {}

  /** True while a scheduler run or any registered external refresh is in flight. */
  get busy(): boolean {
    return this.active > 0;
  }

  get pendingScope(): RefreshScope | null {
    return this.pending;
  }

  /** Number of runs the scheduler has started (observability for tests). */
  get startedRuns(): number {
    return this.runs;
  }

  /**
   * Records an obligation. Requests made in the same tick merge into one run; requests made while a refresh is in
   * flight merge into the single trailing obligation.
   */
  request(scope: RefreshScope): void {
    this.pending = mergeRefreshScope(this.pending, scope);
    if (this.active === 0) this.queueFlush();
  }

  /** Registers external in-flight work. The returned function ends it (idempotent, ignored after `reset`). */
  begin(): () => void {
    this.active += 1;
    const generation = this.generation;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (generation !== this.generation) return;
      this.active = Math.max(0, this.active - 1);
      this.flush();
    };
  }

  /** Drops the pending obligation and forgets all in-flight work (their completions become no-ops). */
  reset(): void {
    this.generation += 1;
    this.active = 0;
    this.pending = null;
  }

  private queueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush() {
    if (this.active > 0 || this.pending === null) return;
    const scope = this.pending;
    this.pending = null;
    this.active += 1;
    this.runs += 1;
    const generation = this.generation;
    const settle = () => {
      if (generation !== this.generation) return;
      this.active = Math.max(0, this.active - 1);
      this.flush();
    };
    let result: Promise<unknown> | unknown;
    try {
      result = this.options.run(scope);
    } catch (error) {
      this.options.onRunError?.(error);
      settle();
      return;
    }
    Promise.resolve(result).then(settle, (error) => {
      this.options.onRunError?.(error);
      settle();
    });
  }
}
