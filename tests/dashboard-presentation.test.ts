import { describe, expect, it } from 'vitest';
import { exactTime, relativeTime, shortId } from '../frontend/dashboard/src/presentation.js';

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
