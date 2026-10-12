import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('dashboard protocol formal checker', () => {
  it('explores positive designs, required witnesses, and exact negative controls', () => {
    const result = spawnSync('node', ['scripts/check-dashboard-protocols-model.mjs'], {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    for (const check of [
      'dashboard-positive: PASS',
      'dashboard-reach-sampler: REACHED',
      'dashboard-reach-trailing-refresh: REACHED',
      'dashboard-negative-overlap-sampler: REJECTED',
      'dashboard-negative-liveness-throttle: REJECTED',
      'dashboard-negative-magic-refresh: REJECTED',
      'dashboard-negative-stale-health: REJECTED',
      'dashboard-negative-precommit: REJECTED',
      'dashboard-negative-trailing-refresh: REJECTED',
      'dashboard-negative-owner-isolation: REJECTED',
      'device-removal-positive-covered: PASS',
      'device-removal-positive-unmerged: PASS',
      'device-removal-reach-intent: REACHED',
      'device-removal-reach-covered-success: REACHED',
      'device-removal-reach-discard-success: REACHED',
      'device-removal-reach-retry-intent: REACHED',
      'device-removal-reach-crash-restart: REACHED',
      'device-removal-negative-intent-order: REJECTED',
      'device-removal-negative-drain: REJECTED',
      'device-removal-negative-conflict: REJECTED',
      'device-removal-negative-prepared: REJECTED',
      'device-removal-negative-unmerged-confirmation: REJECTED',
      'device-removal-negative-wrong-cas: REJECTED',
      'device-removal-negative-premature-completion: REJECTED',
      'device-removal-negative-preservation: REJECTED',
      'device-removal-negative-owner-isolation: REJECTED',
      'vault-creation-positive: PASS',
      'vault-creation-reach-skipped: REACHED',
      'vault-creation-reach-recheck: REACHED',
      'vault-creation-reach-orphan: REACHED',
      'vault-creation-negative-no-reservation: REJECTED',
      'vault-creation-negative-no-skip: REJECTED',
      'vault-creation-negative-no-recheck: REJECTED',
      'vault-creation-negative-early-release: REJECTED',
      'vault-creation-negative-leaked-reservation: REJECTED',
      'vault-creation-negative-ignore-unknown: REJECTED'
    ]) expect(output).toContain(check);
  }, 180_000);
});
