import type { DashboardHealth, DashboardHealthState } from './api/types.js';
import type { LiveState } from './liveUpdates.js';

export function isDeviceRevoked(device: { status: string; revoked_at?: string | null }) {
  return (device.revoked_at !== undefined && device.revoked_at !== null) || device.status === 'revoked';
}

export function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 10)}...` : '-';
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'Not reported';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function exactTime(value: string | null | undefined) {
  if (!value) return 'Not reported';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Unknown';
}

type HealthInput = Pick<DashboardHealth, 'status' | 'detail' | 'git_version' | 'checked_at' | 'checking'> & {
  state?: DashboardHealthState | string;
  stale?: boolean;
};

const HEALTH_STATES: readonly string[] = ['verified', 'not_ready', 'stale', 'pending', 'failed'];

/**
 * The state the dashboard may show. Only a non-stale, ready `verified` sample counts as healthy; contradictory or
 * unknown input is downgraded instead of being displayed as a pass.
 */
export function effectiveHealthState(health: Pick<HealthInput, 'status' | 'state' | 'stale'> & { checked_at?: string | null }): DashboardHealthState {
  const state = typeof health.state === 'string' && HEALTH_STATES.includes(health.state) ? (health.state as DashboardHealthState) : null;
  if (state === null) {
    // Without a usable `state`, a sample only counts as verified when every freshness field positively says so: a
    // missing `stale` or `checked_at` is "unknown", never "fresh".
    if (health.checked_at === null) return 'pending';
    if (health.stale === true) return 'stale';
    const checked = typeof health.checked_at === 'string' && health.checked_at !== '';
    return health.status === 'ready' && health.stale === false && checked ? 'verified' : 'not_ready';
  }
  if (state === 'verified' && (health.status !== 'ready' || health.stale === true)) return health.stale === true ? 'stale' : 'not_ready';
  return state;
}

/** "Never checked" for a missing timestamp, otherwise "Checked <relative>". */
export function checkedLabel(value: string | null | undefined, now = Date.now()) {
  if (value === null || value === undefined || value === '') return 'Never checked';
  if (!Number.isFinite(Date.parse(value))) return 'Check time unknown';
  const age = relativeTime(value, now);
  return `Checked ${age === 'Just now' ? 'just now' : age}`;
}

/** Absolute time for a `title`, or "Never checked". */
export function checkedTitle(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return 'Never checked';
  return exactTime(value);
}

export type HealthView = {
  state: DashboardHealthState;
  healthy: boolean;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  /** Value for the Overview readiness summary and the attention list. */
  summary: string;
  /** Compact variant for the narrow Overview card, where the longest wording wraps; the detail line keeps the full text. */
  cardSummary: string;
  /** Status label for the Maintenance header (a label `Status.svelte` knows). */
  statusLabel: string;
  /** Safe server detail, shown for every state except a plain verified one. */
  detail: string | null;
  checked: string;
  checkedTitle: string;
  checking: boolean;
};

export function describeHealth(health: HealthInput, now = Date.now()): HealthView {
  const state = effectiveHealthState(health);
  const base = {
    state,
    detail: state === 'verified' ? null : health.detail,
    checked: checkedLabel(health.checked_at, now),
    checkedTitle: checkedTitle(health.checked_at),
    checking: health.checking === true
  };
  switch (state) {
    case 'verified':
      return { ...base, healthy: true, tone: 'success', summary: 'Ready', cardSummary: 'Ready', statusLabel: 'Synced' };
    case 'stale':
      return { ...base, healthy: false, tone: 'warning', summary: 'Status out of date', cardSummary: 'Status out of date', statusLabel: 'Status out of date' };
    case 'pending':
      return { ...base, healthy: false, tone: 'neutral', summary: 'Not checked yet', cardSummary: 'Not checked yet', statusLabel: 'Not checked yet' };
    case 'failed':
      return { ...base, healthy: false, tone: 'warning', summary: 'Check could not complete', cardSummary: 'Check failed', statusLabel: 'Check could not complete' };
    default:
      return { ...base, healthy: false, tone: 'danger', summary: 'Integrity failure', cardSummary: 'Integrity failure', statusLabel: 'Integrity failure' };
  }
}

export const LIVE_POLLING_AFTER_MS = 30 * 1000;

export type LiveIndicator = {
  kind: 'stale' | 'live' | 'connecting' | 'reconnecting' | 'polling' | 'paused';
  label: string;
  /** Longer explanation for a tooltip. */
  hint: string;
};

/** The 15-second cadence only exists in the polling state, so only that state may claim it. */
const POLLING_HINT = 'Live updates are unavailable, so server status refreshes every 15 seconds while this tab is visible.';

/**
 * What the sidebar says about freshness. "Status needs refresh" keeps priority over the connection state.
 * `snapshotPending` is true from a stream (re)connect until the full refresh it triggers has settled: the stream is
 * open but the panels still show pre-connect data, so a `live` connection is reported as "Connecting…" until then.
 */
export function liveIndicator(input: { state: LiveState; statusCurrent: boolean; snapshotPending?: boolean; reconnectingSince: number | null; now: number }): LiveIndicator {
  if (!input.statusCurrent) return { kind: 'stale', label: 'Status needs refresh', hint: 'The last status refresh did not complete. The dashboard retries automatically, or use Refresh.' };
  switch (input.state) {
    case 'live':
      if (input.snapshotPending === true) return { kind: 'connecting', label: 'Connecting…', hint: 'Connected. Loading the latest status before showing Live.' };
      return { kind: 'live', label: 'Live', hint: 'Updates arrive instantly. Status ages refresh every minute.' };
    case 'unsupported':
      return { kind: 'polling', label: 'Polling every 15s', hint: POLLING_HINT };
    case 'reconnecting':
      if (input.reconnectingSince !== null && input.now - input.reconnectingSince > LIVE_POLLING_AFTER_MS) {
        return { kind: 'polling', label: 'Polling every 15s', hint: POLLING_HINT };
      }
      return { kind: 'reconnecting', label: 'Reconnecting…', hint: 'The live connection dropped and is reconnecting automatically.' };
    case 'paused':
      return { kind: 'paused', label: 'Paused', hint: 'Live updates are paused while this tab is hidden and resume when you return.' };
    default:
      return { kind: 'connecting', label: 'Connecting…', hint: 'Opening the live connection. Status loads as soon as it connects.' };
  }
}

/** Text for the polite live region: only transitions into Live and into Reconnecting are announced. */
export function liveAnnouncement(next: LiveState, previous: LiveState): string | null {
  if (next === previous) return null;
  if (next === 'live') return 'Live updates connected.';
  if (next === 'reconnecting') return 'Live updates disconnected. Reconnecting.';
  return null;
}

/** Short explanation of the last failed removal attempt, mapped from the server's public-safe error code. */
export function removalFailureText(code: string | null | undefined) {
  switch (code) {
    case 'device_has_unmerged_work':
      return 'The last attempt found unmerged work from this device.';
    case 'device_has_open_work':
      return 'The last attempt stopped because of open conflicts or a sync in flight.';
    case 'device_ref_inconsistent':
      return "The last attempt stopped because the server-side record of this device didn't match.";
    default:
      return 'The last attempt stopped.';
  }
}
