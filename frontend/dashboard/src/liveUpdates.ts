import type { RefreshScope } from './refreshScheduler.js';

/**
 * Live dashboard connection over `GET /api/v1/dashboard/events` (a one-way invalidation stream).
 *
 * The stream carries no content and replays nothing: every (re)connection starts with a `refresh` frame that
 * means "fetch the current account and selected-vault state". `invalidate {account, vault_ids}` frames mean the
 * same for what changed. This controller only decides WHEN to refresh; fetching, response ownership and
 * generation guards stay in the app. It is DOM-free so it can run in node with injected dependencies.
 *
 * State machine
 *   connecting   -- `refresh` frame -------------------> live
 *   live         -- error ---------------------------->  reconnecting
 *   connecting   -- error ---------------------------->  reconnecting
 *   reconnecting -- `refresh` frame ------------------>  live          (backoff reset)
 *   any started  -- hidden longer than hiddenPauseMs -->  paused        (stream closed, timers cleared)
 *   paused       -- visible ---------------------------> connecting     (+ one immediate vault refresh)
 *   (no EventSource available / constructor throws) -->  unsupported    (polling only)
 *   stop()       --------------------------------------> connecting     (idle; everything closed and cleared)
 *
 * While not `live` the vault is polled every `fallbackIntervalMs`; while `live` only every `agingIntervalMs`
 * so clock-dependent labels (last seen, freshness) keep aging. A hidden tab never polls.
 */
export const DASHBOARD_EVENTS_URL = '/api/v1/dashboard/events';
export const HIDDEN_PAUSE_MS = 60 * 1000;
export const RECONNECT_BASE_MS = 5 * 1000;
export const RECONNECT_MAX_MS = 60 * 1000;
export const RECONNECT_JITTER_RATIO = 0.2;
const EVENT_SOURCE_CLOSED = 2;

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'unsupported' | 'paused';

export type LiveRefreshSource = 'connect' | 'event' | 'poll' | 'visibility';
export type LiveRefreshRequest = { scope: RefreshScope; source: LiveRefreshSource };

export type EventSourceLike = {
  readonly readyState: number;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

export type LiveUpdatesOptions = {
  /** `null` when the environment has no EventSource. */
  createEventSource: ((url: string) => EventSourceLike) | null;
  requestRefresh: (request: LiveRefreshRequest) => void;
  getSelectedVaultId: () => string;
  /** Resolves false when the session is gone (the app's own logged-out handling has already run). */
  checkSession: () => Promise<boolean>;
  onStateChange?: (state: LiveState, previous: LiveState) => void;
  fallbackIntervalMs: number;
  agingIntervalMs: number;
  hiddenPauseMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  jitterRatio?: number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  random?: () => number;
  isHidden: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
};

export type ParsedInvalidation = { account: boolean; vaultIds: string[] };

/** Defensive parse of an `invalidate` frame. Anything unexpected returns null, which callers treat as a full refresh. */
export function parseInvalidation(data: unknown): ParsedInvalidation | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.account !== 'boolean') return null;
  const ids = record.vault_ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
  return { account: record.account, vaultIds: ids as string[] };
}

export class LiveUpdates {
  private state: LiveState = 'connecting';
  private started = false;
  private paused = false;
  private source: EventSourceLike | null = null;
  private connectionId = 0;
  private epoch = 0;
  private failures = 0;
  private reconnectTimer: unknown = null;
  private tickTimer: unknown = null;
  private hideTimer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private lastSessionCheckAt: number | null = null;
  private sessionCheckInFlight = false;

  constructor(private readonly options: LiveUpdatesOptions) {}

  get currentState(): LiveState {
    return this.state;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get hasOpenStream(): boolean {
    return this.source !== null;
  }

  /** Delay before the (failures+1)th own reconnect, without jitter: base, 2x, 4x ... capped. */
  backoffMs(step: number): number {
    const base = this.options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    const max = this.options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    return Math.min(max, base * 2 ** Math.max(0, step));
  }

  /** Idempotent: a second start() while running never opens a second stream. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.epoch += 1;
    this.paused = false;
    this.failures = 0;
    this.lastSessionCheckAt = null;
    this.setState('connecting');
    this.unsubscribeVisibility = this.options.onVisibilityChange(() => this.onVisibility());
    if (this.options.isHidden()) this.armHideTimer();
    this.connect();
  }

  /** Closes the stream and clears every timer and listener. Safe to call repeatedly. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.paused = false;
    this.epoch += 1;
    this.closeSource();
    this.clearTimer('reconnectTimer');
    this.clearTimer('tickTimer');
    this.clearTimer('hideTimer');
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.sessionCheckInFlight = false;
    this.setState('connecting');
  }

  private setState(next: LiveState) {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.rescheduleTick();
    this.options.onStateChange?.(next, previous);
  }

  private connect() {
    if (!this.started || this.paused || this.source) return;
    const factory = this.options.createEventSource;
    if (!factory) {
      this.setState('unsupported');
      this.rescheduleTick();
      return;
    }
    let source: EventSourceLike;
    try {
      source = factory(DASHBOARD_EVENTS_URL);
    } catch {
      this.setState('unsupported');
      this.rescheduleTick();
      return;
    }
    this.source = source;
    const id = ++this.connectionId;
    source.addEventListener('refresh', () => this.onRefreshEvent(id));
    source.addEventListener('invalidate', (event) => this.onInvalidateEvent(id, event));
    source.addEventListener('error', () => this.onError(id));
    if (this.state !== 'reconnecting') this.setState('connecting');
    this.rescheduleTick();
  }

  private closeSource() {
    const source = this.source;
    this.source = null;
    this.connectionId += 1;
    if (!source) return;
    try {
      source.close();
    } catch {
      // closing is best effort
    }
  }

  private isCurrent(id: number) {
    return this.started && !this.paused && this.source !== null && id === this.connectionId;
  }

  private onRefreshEvent(id: number) {
    if (!this.isCurrent(id)) return;
    this.failures = 0;
    this.clearTimer('reconnectTimer');
    this.setState('live');
    this.emit({ scope: 'full', source: 'connect' });
  }

  private onInvalidateEvent(id: number, event: { data?: unknown }) {
    if (!this.isCurrent(id)) return;
    let scope: RefreshScope | null;
    try {
      const parsed = parseInvalidation(event.data);
      if (!parsed || parsed.account) scope = 'full';
      else {
        const selected = this.options.getSelectedVaultId();
        scope = selected !== '' && parsed.vaultIds.includes(selected) ? 'vault' : null;
      }
    } catch {
      scope = 'full';
    }
    if (scope) this.emit({ scope, source: 'event' });
  }

  private onError(id: number) {
    if (!this.isCurrent(id)) return;
    const source = this.source;
    this.failures += 1;
    this.setState('reconnecting');
    this.maybeCheckSession();
    if (source && source.readyState === EVENT_SOURCE_CLOSED) {
      this.closeSource();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    this.clearTimer('reconnectTimer');
    if (!this.started || this.paused) return;
    const delay = this.backoffMs(this.failures - 1);
    const jitter = (this.options.random ?? Math.random)() * (this.options.jitterRatio ?? RECONNECT_JITTER_RATIO) * delay;
    this.reconnectTimer = this.options.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + jitter);
  }

  /** At most one session check per backoff step; the app's own auth-expiry path does the logging out. */
  private maybeCheckSession() {
    if (this.sessionCheckInFlight) return;
    const now = this.options.now();
    const threshold = this.failures >= 2 ? this.backoffMs(this.failures - 2) : 0;
    if (this.lastSessionCheckAt !== null && now - this.lastSessionCheckAt < threshold) return;
    this.lastSessionCheckAt = now;
    this.sessionCheckInFlight = true;
    const epoch = this.epoch;
    const done = (valid: boolean) => {
      if (epoch !== this.epoch) return;
      this.sessionCheckInFlight = false;
      if (!valid) this.stop();
    };
    let check: Promise<boolean>;
    try {
      check = this.options.checkSession();
    } catch {
      done(true);
      return;
    }
    check.then((valid) => done(valid !== false), () => done(true));
  }

  private onVisibility() {
    if (!this.started) return;
    if (this.options.isHidden()) {
      this.armHideTimer();
      return;
    }
    this.clearTimer('hideTimer');
    if (this.paused) this.resume();
  }

  private armHideTimer() {
    if (this.hideTimer !== null || this.paused) return;
    this.hideTimer = this.options.setTimeout(() => {
      this.hideTimer = null;
      if (this.started && this.options.isHidden()) this.pause();
    }, this.options.hiddenPauseMs ?? HIDDEN_PAUSE_MS);
  }

  private pause() {
    if (this.paused) return;
    this.paused = true;
    this.closeSource();
    this.clearTimer('reconnectTimer');
    this.clearTimer('tickTimer');
    this.setState('paused');
  }

  private resume() {
    this.paused = false;
    this.failures = 0;
    this.lastSessionCheckAt = null;
    this.connect();
    this.emit({ scope: 'vault', source: 'visibility' });
  }

  private rescheduleTick() {
    this.clearTimer('tickTimer');
    if (!this.started || this.paused) return;
    const delay = this.state === 'live' ? this.options.agingIntervalMs : this.options.fallbackIntervalMs;
    this.tickTimer = this.options.setTimeout(() => {
      this.tickTimer = null;
      if (!this.options.isHidden()) this.emit({ scope: 'vault', source: 'poll' });
      this.rescheduleTick();
    }, delay);
  }

  private clearTimer(name: 'reconnectTimer' | 'tickTimer' | 'hideTimer') {
    const handle = this[name];
    if (handle === null) return;
    this[name] = null;
    this.options.clearTimeout(handle);
  }

  private emit(request: LiveRefreshRequest) {
    try {
      this.options.requestRefresh(request);
    } catch {
      // a failing consumer must never break the connection
    }
  }
}
