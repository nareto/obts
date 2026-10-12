import { describe, expect, it } from 'vitest';
import {
  LIVE_POLLING_AFTER_MS,
  checkedLabel,
  checkedTitle,
  describeHealth,
  effectiveHealthState,
  exactTime,
  isDeviceRevoked,
  liveAnnouncement,
  liveIndicator,
  relativeTime,
  removalFailureText,
  shortId
} from '../frontend/dashboard/src/presentation.js';
import type { DashboardHealth } from '../frontend/dashboard/src/api/types.js';
import type { LiveState } from '../frontend/dashboard/src/liveUpdates.js';

describe('isDeviceRevoked', () => {
  it('treats either a revoked status or a revoked_at timestamp as revoked', () => {
    expect(isDeviceRevoked({ status: 'active', revoked_at: null })).toBe(false);
    expect(isDeviceRevoked({ status: 'active' })).toBe(false);
    expect(isDeviceRevoked({ status: 'revoked', revoked_at: null })).toBe(true);
    expect(isDeviceRevoked({ status: 'active', revoked_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isDeviceRevoked({ status: 'revoked' })).toBe(true);
  });
});

describe('dashboard presentation helpers', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');

  it('keeps identifiers concise without losing empty-state clarity', () => {
    expect(shortId('1234567890abcdef')).toBe('1234567890...');
    expect(shortId(null)).toBe('-');
  });

  it('formats server timestamps as compact relative labels', () => {
    expect(relativeTime('2026-09-10T11:59:30.000Z', now)).toBe('30s ago');
    expect(relativeTime('2026-09-10T11:00:00.000Z', now)).toBe('1h ago');
    expect(relativeTime(null, now)).toBe('Not reported');
  });

  it('provides an exact accessible fallback for timestamps', () => {
    expect(exactTime('2026-09-10T12:00:00.000Z')).not.toBe('Unknown');
    expect(exactTime(null)).toBe('Not reported');
  });
});

describe('removalFailureText', () => {
  it('maps the safe server error codes to short explanations and falls back for anything else', () => {
    expect(removalFailureText('device_has_unmerged_work')).toContain('unmerged work');
    expect(removalFailureText('device_has_open_work')).toContain('open conflicts or a sync in flight');
    expect(removalFailureText('device_ref_inconsistent')).toContain("server-side record of this device didn't match");
    expect(removalFailureText('device_removal_incomplete')).toBe('The last attempt stopped.');
    expect(removalFailureText('something_unexpected')).toBe('The last attempt stopped.');
    expect(removalFailureText(null)).toBe('The last attempt stopped.');
    expect(removalFailureText(undefined)).toBe('The last attempt stopped.');
  });
});

describe('health presentation', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  const verified: DashboardHealth = {
    status: 'ready',
    checks: { metadata: true },
    detail: null,
    git_version: 'git version 2.49.0',
    checked_at: '2026-09-10T11:58:00.000Z',
    checking: false,
    stale: false,
    state: 'verified'
  };

  it('shows only a fresh verified sample as healthy, with a relative age and an absolute title', () => {
    const view = describeHealth(verified, now);
    expect(view).toMatchObject({ state: 'verified', healthy: true, tone: 'success', summary: 'Ready', statusLabel: 'Synced', detail: null, checked: 'Checked 2m ago', checking: false });
    expect(view.checkedTitle).toBe(exactTime(verified.checked_at));
    expect(view.checkedTitle).not.toBe('Never checked');
  });

  it('never presents stale, pending or failed health as healthy', () => {
    const stale = describeHealth({ ...verified, status: 'not_ready', stale: true, state: 'stale', detail: 'the last readiness check is out of date' }, now);
    expect(stale).toMatchObject({ healthy: false, tone: 'warning', summary: 'Status out of date', statusLabel: 'Status out of date', detail: 'the last readiness check is out of date' });
    const pending = describeHealth({ ...verified, status: 'not_ready', checked_at: null, stale: true, state: 'pending', detail: 'readiness has not been checked yet' }, now);
    expect(pending).toMatchObject({ healthy: false, tone: 'neutral', summary: 'Not checked yet', statusLabel: 'Not checked yet', checked: 'Never checked', checkedTitle: 'Never checked' });
    const failed = describeHealth({ ...verified, status: 'not_ready', state: 'failed', detail: 'the last readiness check could not complete' }, now);
    expect(failed).toMatchObject({ healthy: false, tone: 'warning', summary: 'Check could not complete', statusLabel: 'Check could not complete' });
    for (const view of [stale, pending, failed]) {
      expect(view.summary).not.toBe('Ready');
      expect(view.statusLabel).not.toBe('Synced');
    }
  });

  it('keeps the existing not-ready display with the safe detail', () => {
    const view = describeHealth({ ...verified, status: 'not_ready', state: 'not_ready', detail: 'persistent state check failed' }, now);
    expect(view).toMatchObject({ healthy: false, tone: 'danger', summary: 'Integrity failure', statusLabel: 'Integrity failure', detail: 'persistent state check failed' });
  });

  it('flags a running check next to the last verdict without changing the verdict', () => {
    expect(describeHealth({ ...verified, checking: true }, now)).toMatchObject({ state: 'verified', healthy: true, checking: true });
    expect(describeHealth({ ...verified, checking: false }, now).checking).toBe(false);
  });

  it('downgrades contradictory or unknown input instead of showing a pass', () => {
    expect(effectiveHealthState({ status: 'not_ready', state: 'verified', stale: false })).toBe('not_ready');
    expect(effectiveHealthState({ status: 'ready', state: 'verified', stale: true })).toBe('stale');
    expect(effectiveHealthState({ status: 'ready', stale: true })).toBe('stale');
    expect(effectiveHealthState({ status: 'ready', state: 'something_new', stale: false, checked_at: '2026-09-10T11:58:00.000Z' })).toBe('verified');
    expect(effectiveHealthState({ status: 'not_ready', state: 'something_new' })).toBe('not_ready');
    expect(effectiveHealthState({ status: 'ready', state: 'verified', stale: false })).toBe('verified');
  });

  it('never treats a missing freshness field as verified when state is absent or unknown', () => {
    const checkedAt = '2026-09-10T11:58:00.000Z';
    // every new field absent (an older or partial response) with status ready
    expect(effectiveHealthState({ status: 'ready' })).toBe('not_ready');
    expect(effectiveHealthState({ status: 'ready', state: 'something_new' })).toBe('not_ready');
    // stale undefined
    expect(effectiveHealthState({ status: 'ready', checked_at: checkedAt })).toBe('not_ready');
    // checked_at undefined or empty
    expect(effectiveHealthState({ status: 'ready', stale: false })).toBe('not_ready');
    expect(effectiveHealthState({ status: 'ready', stale: false, checked_at: '' })).toBe('not_ready');
    // checked_at null: never checked
    expect(effectiveHealthState({ status: 'ready', stale: false, checked_at: null })).toBe('pending');
    expect(effectiveHealthState({ status: 'not_ready', checked_at: null })).toBe('pending');
    // not ready or stale never verify
    expect(effectiveHealthState({ status: 'not_ready', stale: false, checked_at: checkedAt })).toBe('not_ready');
    expect(effectiveHealthState({ status: 'ready', stale: true, checked_at: checkedAt })).toBe('stale');
    // positive evidence on every field verifies
    expect(effectiveHealthState({ status: 'ready', stale: false, checked_at: checkedAt })).toBe('verified');
  });

  it('describes a sample with absent freshness fields as not healthy', () => {
    const partial = { status: 'ready', detail: null, git_version: 'git version 2.49.0', checking: false } as unknown as DashboardHealth;
    const view = describeHealth(partial, now);
    expect(view).toMatchObject({ healthy: false, state: 'not_ready' });
    expect(view.summary).not.toBe('Ready');
    expect(view.statusLabel).not.toBe('Synced');
    expect(describeHealth({ ...partial, checked_at: null } as unknown as DashboardHealth, now)).toMatchObject({ healthy: false, state: 'pending', summary: 'Not checked yet' });
  });

  it('uses a short card label for a failed check and keeps the full wording elsewhere', () => {
    const failed = describeHealth({ ...verified, status: 'not_ready', state: 'failed', detail: 'the last readiness check could not complete' }, now);
    expect(failed.cardSummary).toBe('Check failed');
    expect(failed.summary).toBe('Check could not complete');
    expect(failed.statusLabel).toBe('Check could not complete');
    expect(failed.detail).toBe('the last readiness check could not complete');
    expect(describeHealth(verified, now).cardSummary).toBe('Ready');
    expect(describeHealth({ ...verified, status: 'not_ready', state: 'not_ready' }, now).cardSummary).toBe('Integrity failure');
  });

  it('renders a null or unparsable check time as Never checked or unknown, never as an invalid date', () => {
    expect(checkedLabel(null, now)).toBe('Never checked');
    expect(checkedLabel(undefined, now)).toBe('Never checked');
    expect(checkedLabel('', now)).toBe('Never checked');
    expect(checkedLabel('not a date', now)).toBe('Check time unknown');
    expect(checkedLabel('2026-09-10T11:59:30.000Z', now)).toBe('Checked 30s ago');
    expect(checkedLabel('2026-09-10T12:00:00.000Z', now)).toBe('Checked just now');
    expect(checkedTitle(null)).toBe('Never checked');
    for (const text of [checkedLabel(null, now), checkedTitle(null), checkedLabel('not a date', now)]) {
      expect(text).not.toMatch(/Invalid Date|1970|1\/1\/70/u);
    }
  });
});

describe('liveIndicator', () => {
  const base = { statusCurrent: true, reconnectingSince: null as number | null, now: 1_000_000 };
  const label = (state: LiveState, extra: Partial<typeof base & { snapshotPending: boolean }> = {}) => liveIndicator({ ...base, state, ...extra });

  it('maps each connection state to a truthful label', () => {
    expect(label('live')).toMatchObject({ kind: 'live', label: 'Live' });
    expect(label('connecting')).toMatchObject({ kind: 'connecting', label: 'Connecting\u2026' });
    expect(label('reconnecting', { reconnectingSince: base.now - 1000 })).toMatchObject({ kind: 'reconnecting', label: 'Reconnecting\u2026' });
    expect(label('unsupported')).toMatchObject({ kind: 'polling', label: 'Polling every 15s' });
    expect(label('paused')).toMatchObject({ kind: 'paused', label: 'Paused' });
  });

  it('switches a long reconnect to polling only after more than 30 seconds', () => {
    expect(label('reconnecting', { reconnectingSince: base.now - LIVE_POLLING_AFTER_MS }).kind).toBe('reconnecting');
    expect(label('reconnecting', { reconnectingSince: base.now - LIVE_POLLING_AFTER_MS - 1 })).toMatchObject({ kind: 'polling', label: 'Polling every 15s' });
    expect(label('reconnecting', { reconnectingSince: null }).kind).toBe('reconnecting');
  });

  it('keeps "Status needs refresh" ahead of every connection state', () => {
    for (const state of ['live', 'connecting', 'reconnecting', 'unsupported', 'paused'] as const) {
      expect(label(state, { statusCurrent: false })).toMatchObject({ kind: 'stale', label: 'Status needs refresh' });
    }
  });

  it('does not show Live until the connect snapshot has landed', () => {
    expect(label('live', { snapshotPending: true })).toMatchObject({ kind: 'connecting', label: 'Connecting\u2026' });
    expect(label('live', { snapshotPending: false })).toMatchObject({ kind: 'live', label: 'Live' });
    expect(label('live')).toMatchObject({ kind: 'live', label: 'Live' });
    expect(label('live', { snapshotPending: true, statusCurrent: false })).toMatchObject({ kind: 'stale', label: 'Status needs refresh' });
    expect(label('reconnecting', { snapshotPending: true, reconnectingSince: base.now - 1000 }).kind).toBe('reconnecting');
    expect(label('paused', { snapshotPending: true }).kind).toBe('paused');
  });

  it('only the polling state claims a 15 second refresh; each other state has its own hint', () => {
    const fifteen = /15 seconds/u;
    const hints = {
      polling: label('unsupported').hint,
      pollingAfterReconnect: label('reconnecting', { reconnectingSince: base.now - LIVE_POLLING_AFTER_MS - 1 }).hint,
      live: label('live').hint,
      stale: label('live', { statusCurrent: false }).hint,
      connecting: label('connecting').hint,
      snapshotPending: label('live', { snapshotPending: true }).hint,
      reconnecting: label('reconnecting', { reconnectingSince: base.now - 1000 }).hint,
      paused: label('paused').hint
    };
    expect(hints.polling).toMatch(fifteen);
    expect(hints.pollingAfterReconnect).toMatch(fifteen);
    for (const key of ['live', 'stale', 'connecting', 'snapshotPending', 'reconnecting', 'paused'] as const) {
      expect(hints[key], key).not.toMatch(fifteen);
    }
    expect(hints.live).toMatch(/instantly/u);
    expect(hints.live).toMatch(/every minute/u);
    expect(hints.stale).toMatch(/did not complete/u);
    expect(hints.connecting).toMatch(/Opening the live connection/u);
    expect(hints.snapshotPending).toMatch(/Loading the latest status/u);
    expect(hints.reconnecting).toMatch(/reconnecting automatically/u);
    expect(hints.paused).toMatch(/paused/u);
    expect(new Set(Object.values(hints)).size).toBeGreaterThanOrEqual(7);
    for (const hint of Object.values(hints)) expect(hint.length).toBeLessThan(130);
  });

  it('announces only transitions into Live and into Reconnecting', () => {
    expect(liveAnnouncement('live', 'connecting')).toMatch(/connected/u);
    expect(liveAnnouncement('live', 'reconnecting')).toMatch(/connected/u);
    expect(liveAnnouncement('reconnecting', 'live')).toMatch(/Reconnecting/u);
    expect(liveAnnouncement('reconnecting', 'connecting')).toMatch(/Reconnecting/u);
    expect(liveAnnouncement('live', 'live')).toBeNull();
    expect(liveAnnouncement('reconnecting', 'reconnecting')).toBeNull();
    for (const next of ['connecting', 'unsupported', 'paused'] as const) expect(liveAnnouncement(next, 'live')).toBeNull();
  });
});
