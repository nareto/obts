export const READINESS_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** A single slow or late sample must never flip health, so staleness tolerates a whole missed cycle. */
export const READINESS_STALE_AFTER_MS = 2 * READINESS_SAMPLE_INTERVAL_MS;
/**
 * While a sample is in flight the previous verdict stays projected for the interval plus this slack,
 * measured from the previous completion. Only a sample that is stuck for longer turns health stale.
 */
export const READINESS_IN_FLIGHT_SLACK_MS = 2 * READINESS_SAMPLE_INTERVAL_MS;

/** Who started a sample; only used for operational logging. */
export type ReadinessSource = 'sampler' | 'startup' | 'request';

export type ReadinessChecks = {
  metadata: boolean;
  metadata_store: boolean;
  git: boolean;
  setup_complete: boolean;
  migrations: boolean;
  git_store: boolean;
  temp_workspace: boolean;
  filesystem_permissions: boolean;
  event_delivery: boolean;
  persistent_state: boolean;
};

export type ReadinessSummary = {
  status: 'ready' | 'not_ready';
  checks: ReadinessChecks;
  detail: string | null;
  git_version: string;
};

/**
 * `verified`   - a completed sample no older than the stale threshold reported ready.
 * `not_ready`  - a completed sample (or a current in-memory authoritative state) reports a failure.
 * `stale`      - the newest completed sample is older than the stale threshold; nothing is verified.
 * `pending`    - no sample has completed since the server started.
 * `failed`     - the newest sample could not complete; the outcome is unknown.
 */
export type DashboardHealthState = 'verified' | 'not_ready' | 'stale' | 'pending' | 'failed';

export type DashboardHealth = ReadinessSummary & {
  checked_at: string | null;
  checking: boolean;
  stale: boolean;
  state: DashboardHealthState;
};

export type ReadinessSampleView = {
  summary: ReadinessSummary | null;
  completedAtMs: number | null;
  failed: boolean;
  checking: boolean;
};

/** A current in-memory authoritative failure; it always wins over an older healthy sample. */
export type CurrentReadinessOverride = {
  detail: string;
  failedChecks: 'all' | ReadonlyArray<keyof ReadinessChecks>;
};

function overriddenChecks(base: ReadinessChecks | null, override: CurrentReadinessOverride): ReadinessChecks {
  // Without a trustworthy sample nothing beyond the failure is asserted healthy.
  if (override.failedChecks === 'all' || base === null) return allChecks(false);
  const checks = { ...base };
  for (const name of override.failedChecks) checks[name] = false;
  return checks;
}

export function applyReadinessOverride(summary: ReadinessSummary, override: CurrentReadinessOverride | null): ReadinessSummary {
  if (override === null) return summary;
  return {
    status: 'not_ready',
    checks: overriddenChecks(summary.checks, override),
    detail: override.detail,
    git_version: override.failedChecks === 'all' ? 'unknown' : summary.git_version
  };
}

export type ReadinessSamplerOptions = {
  run: (source: ReadinessSource) => Promise<ReadinessSummary>;
  intervalMs?: number;
  now?: () => number;
  onFailure?: (error: unknown) => void;
  /** Called when a completed sample's projected verdict differs from the previously completed one. */
  onVerdictChange?: () => void;
};

export function allChecks(value: boolean): ReadinessChecks {
  return {
    metadata: true,
    metadata_store: value,
    git: value,
    setup_complete: value,
    migrations: value,
    git_store: value,
    temp_workspace: value,
    filesystem_permissions: value,
    event_delivery: value,
    persistent_state: value
  };
}

/**
 * Server-owned single-flight sampler for the deep readiness check. At most one run is ever in flight;
 * every caller that arrives meanwhile shares it. Dashboard reads only look at the last completed
 * sample, they never start or await a run.
 */
export class ReadinessSampler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private inFlight: Promise<ReadinessSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private summary: ReadinessSummary | null = null;
  private completedAtMs: number | null = null;
  private failed = false;
  private verdict: string;

  constructor(private readonly options: ReadinessSamplerOptions) {
    this.intervalMs = options.intervalMs ?? READINESS_SAMPLE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.verdict = readinessVerdictKey(projectDashboardHealth({ view: this.view(), nowMs: this.now() }));
  }

  /** Starts the initial sample and the periodic maintenance, both outside any request. */
  start(): void {
    if (this.closed || this.timer !== null) return;
    void this.sample('startup').catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sample('sampler').catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Runs a fresh sample, or joins the one already running. Rejects when the run itself fails. */
  sample(source: ReadinessSource = 'request'): Promise<ReadinessSummary> {
    if (this.closed) return Promise.reject(new Error('Readiness sampler is closed.'));
    if (this.inFlight !== null) return this.inFlight;
    const run = (async () => {
      await Promise.resolve();
      try {
        const summary = await this.options.run(source);
        this.record(summary, false);
        return summary;
      } catch (error) {
        this.record(null, true);
        try {
          this.options.onFailure?.(error);
        } catch {
          // Failure reporting must never replace the original failure.
        }
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }

  view(): ReadinessSampleView {
    return {
      summary: this.summary,
      completedAtMs: this.completedAtMs,
      failed: this.failed,
      checking: this.inFlight !== null
    };
  }

  /** Cancels the timer and waits for the owned in-flight run, so dependencies can close afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const running = this.inFlight;
    if (running !== null) {
      await running.catch(() => undefined);
    }
  }

  private record(summary: ReadinessSummary | null, failed: boolean): void {
    this.summary = summary;
    this.failed = failed;
    this.completedAtMs = this.now();
    const verdict = readinessVerdictKey(projectDashboardHealth({ view: this.view(), nowMs: this.completedAtMs }));
    if (verdict === this.verdict) return;
    this.verdict = verdict;
    try {
      this.options.onVerdictChange?.();
    } catch {
      // Change notification must never fail or replace a sample.
    }
  }
}

/** Stable identity of a projected verdict; `checked_at` and `checking` are deliberately excluded. */
export function readinessVerdictKey(health: DashboardHealth): string {
  return JSON.stringify([health.status, health.state, health.checks, health.detail]);
}

/**
 * Projects the newest completed sample for an observation-only reader. A sample is never presented as
 * currently verified unless it completed within `staleAfterMs`, and a current authoritative failure
 * (`override`) always wins over an older healthy sample.
 */
export function projectDashboardHealth(input: {
  view: ReadinessSampleView;
  nowMs: number;
  staleAfterMs?: number;
  override?: CurrentReadinessOverride | null;
}): DashboardHealth {
  const { view, nowMs } = input;
  const baseStaleAfterMs = input.staleAfterMs ?? READINESS_STALE_AFTER_MS;
  // A running sample is expected to replace the previous one; keep its verdict while that is plausible.
  const staleAfterMs = view.checking
    ? Math.max(baseStaleAfterMs, READINESS_SAMPLE_INTERVAL_MS + READINESS_IN_FLIGHT_SLACK_MS)
    : baseStaleAfterMs;
  const checkedAt = view.completedAtMs === null ? null : new Date(view.completedAtMs).toISOString();
  const stale = view.completedAtMs === null || nowMs - view.completedAtMs > staleAfterMs || nowMs < view.completedAtMs - staleAfterMs;
  const common = { checked_at: checkedAt, checking: view.checking, stale };
  if (input.override) {
    return {
      status: 'not_ready',
      checks: overriddenChecks(view.summary !== null && !stale ? view.summary.checks : null, input.override),
      detail: input.override.detail,
      git_version: view.summary?.git_version ?? 'unknown',
      ...common,
      state: 'not_ready'
    };
  }
  if (view.completedAtMs === null) {
    return {
      status: 'not_ready',
      checks: allChecks(false),
      detail: 'readiness has not been checked yet',
      git_version: 'unknown',
      ...common,
      state: 'pending'
    };
  }
  if (view.failed || view.summary === null) {
    return {
      status: 'not_ready',
      checks: allChecks(false),
      detail: 'the last readiness check could not complete',
      git_version: 'unknown',
      ...common,
      state: 'failed'
    };
  }
  if (stale) {
    return {
      status: 'not_ready',
      checks: allChecks(false),
      detail: 'the last readiness check is out of date',
      git_version: view.summary.git_version,
      ...common,
      state: 'stale'
    };
  }
  return {
    status: view.summary.status,
    checks: { ...view.summary.checks },
    detail: view.summary.detail,
    git_version: view.summary.git_version,
    ...common,
    state: view.summary.status === 'ready' ? 'verified' : 'not_ready'
  };
}
