import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperationalLog } from '../src/server/operationalLog.js';
import { Browser, DashboardHarness } from './helpers/dashboardHttpHarness.js';

const harness = new DashboardHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.cleanup();
});

const MINUTE = 60_000;

async function owner(options: Parameters<DashboardHarness['start']>[0] = {}) {
  const started = await harness.start(options);
  const browser = new Browser(started.baseUrl);
  await browser.setup('owner', 'owner-password-1234');
  const vaultId = (await browser.call('POST', '/api/v1/vaults', { display_name: 'Cost Vault' })).body.vault_id as string;
  const dashboard = async () => {
    const result = await browser.call('GET', `/api/v1/vaults/${vaultId}/dashboard`);
    expect(result.status).toBe(200);
    return result.body as { health: Record<string, any>; maintenance: Array<Record<string, any>> };
  };
  return { ...started, browser, vaultId, dashboard };
}

describe('dashboard readiness observation', () => {
  it('serves repeated dashboard loads from the last sample without running or awaiting a deep check', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    const runs = vi.spyOn(f.server.store, 'snapshotVersioned');
    const fsck = f.server.git.integrityMetricsSnapshot().full_fsck_checks;
    const pending = await f.dashboard();
    expect(pending.health).toMatchObject({ status: 'not_ready', state: 'pending', checked_at: null, checking: false, stale: true });
    expect(pending.health.detail).toMatch(/not been checked/u);
    for (let index = 0; index < 10; index += 1) await f.dashboard();
    expect(runs).not.toHaveBeenCalled();
    expect(f.server.git.integrityMetricsSnapshot().full_fsck_checks).toBe(fsck);
    expect(f.server.readiness.view().checking).toBe(false);
  });

  it('projects a completed sample truthfully, then marks it stale after twice the sampling interval', async () => {
    let clock = Date.parse('2026-02-01T00:00:00.000Z');
    const f = await owner({ readiness: { autoStart: false, now: () => clock } });
    await f.server.readiness.sample();
    const fsckAfterSample = f.server.git.integrityMetricsSnapshot().full_fsck_checks;
    const verified = await f.dashboard();
    expect(verified.health).toMatchObject({
      status: 'ready', state: 'verified', checking: false, stale: false, checked_at: '2026-02-01T00:00:00.000Z'
    });
    expect(Object.values(verified.health.checks).every(Boolean)).toBe(true);
    clock += 5 * MINUTE + 1;
    expect((await f.dashboard()).health).toMatchObject({ status: 'ready', state: 'verified', stale: false });
    clock += 5 * MINUTE;
    const stale = await f.dashboard();
    expect(stale.health).toMatchObject({ status: 'not_ready', state: 'stale', stale: true, checked_at: '2026-02-01T00:00:00.000Z' });
    expect(stale.maintenance.every((row) => row.last_checked_at === '2026-02-01T00:00:00.000Z')).toBe(true);
    expect(f.server.git.integrityMetricsSnapshot().full_fsck_checks).toBe(fsckAfterSample);
  });

  it('lets a current durability failure override a cached healthy sample at once', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    await f.server.readiness.sample();
    expect((await f.dashboard()).health.state).toBe('verified');
    vi.spyOn(f.server.git, 'isDurabilityUnavailable').mockReturnValue(true);
    const health = (await f.dashboard()).health;
    expect(health).toMatchObject({ status: 'not_ready', state: 'not_ready', detail: 'Git repository durability is uncertain' });
    expect(health.checks).toMatchObject({ git: false, persistent_state: false });
  });

  it('reflects a vault that is blocked by an integrity failure even when the sample was healthy', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    await f.server.readiness.sample();
    await f.server.store.mutate((db) => { db.vaults[0]!.status = 'blocked_integrity'; });
    const health = (await f.dashboard()).health;
    expect(health).toMatchObject({ status: 'not_ready', state: 'not_ready' });
    expect(health.checks.persistent_state).toBe(false);
  });

  it('reports a failed sample as such and keeps serving without throwing', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    vi.spyOn(f.server.store, 'snapshotVersioned').mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(f.server.readiness.sample()).rejects.toThrow();
    const health = (await f.dashboard()).health;
    expect(health).toMatchObject({ status: 'not_ready', state: 'failed', checking: false });
    expect(health.checked_at).not.toBeNull();
    await f.server.readiness.sample();
    expect((await f.dashboard()).health.state).toBe('verified');
  });

  it('samples once at startup outside any request and again on the timer', async () => {
    const f = await owner({ readiness: { intervalMs: 60_000 } });
    await vi.waitFor(() => expect(f.server.readiness.view().completedAtMs).not.toBeNull());
    expect((await f.dashboard()).health).toMatchObject({ state: 'verified' });
  });

  it('shares one in-flight sample among concurrent /health/ready probes', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    const runs = vi.spyOn(f.server.store, 'snapshotVersioned');
    const responses = await Promise.all(Array.from({ length: 4 }, async () => await f.server.app.inject({ method: 'GET', url: '/health/ready' })));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect(runs).toHaveBeenCalledTimes(1);
    const again = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
    expect(again.statusCode).toBe(200);
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('applies a current durability failure to a fresh /health/ready probe', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    vi.spyOn(f.server.git, 'isDurabilityUnavailable').mockReturnValue(true);
    const response = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('logs the integrity block with the source of the sample that found it', async () => {
    type Row = { event: string; vault_id?: string; source?: string };
    const results: Record<string, Row[]> = {};
    for (const source of ['startup', 'sampler', 'request'] as const) {
      const lines: string[] = [];
      const f = await owner({ readiness: { autoStart: false }, operationalLog: new OperationalLog('debug', (line) => lines.push(line)) });
      vi.spyOn(f.server.git, 'commitExists').mockResolvedValue(false);
      await f.server.readiness.sample(source);
      expect((await f.server.store.snapshot()).vaults.find((vault) => vault.vault_id === f.vaultId)?.status).toBe('blocked_integrity');
      results[source] = lines.map((line) => JSON.parse(line) as Row).filter((row) => row.event === 'vault_integrity_blocked');
      vi.restoreAllMocks();
      await harness.cleanup();
    }
    for (const source of ['startup', 'sampler', 'request']) {
      expect(results[source]).toEqual([expect.objectContaining({ source })]);
    }
  });

  it('blocks the vault even when unrelated commits race every confirmation attempt, and logs the contention', async () => {
    type Row = { event: string; vault_id?: string; source?: string };
    const lines: string[] = [];
    const f = await owner({ readiness: { autoStart: false }, operationalLog: new OperationalLog('debug', (line) => lines.push(line)) });
    vi.spyOn(f.server.git, 'commitExists').mockResolvedValue(false);
    const original = f.server.store.snapshotVersioned.bind(f.server.store);
    let snapshots = 0;
    vi.spyOn(f.server.store, 'snapshotVersioned').mockImplementation(async () => {
      const snapshot = await original();
      snapshots += 1;
      await f.server.store.mutate((db) => { db.event_seq_by_vault.unrelated = snapshots; });
      return snapshot;
    });
    await f.server.readiness.sample('sampler');
    expect(snapshots).toBeGreaterThan(3);
    expect((await f.server.store.snapshot()).vaults.find((vault) => vault.vault_id === f.vaultId)?.status).toBe('blocked_integrity');
    const rows = lines.map((line) => JSON.parse(line) as Row);
    expect(rows.filter((row) => row.event === 'vault_integrity_block_contended')).toEqual([
      expect.objectContaining({ vault_id: f.vaultId, source: 'sampler' })
    ]);
    expect(rows.filter((row) => row.event === 'vault_integrity_blocked')).toEqual([
      expect.objectContaining({ vault_id: f.vaultId, source: 'sampler' })
    ]);
    expect(f.server.readiness.view().summary).toMatchObject({ status: 'not_ready' });
  });

  it('does not block on exhaustion when the vault itself moved on since the failing check', async () => {
    const lines: string[] = [];
    const f = await owner({ readiness: { autoStart: false }, operationalLog: new OperationalLog('debug', (line) => lines.push(line)) });
    vi.spyOn(f.server.git, 'commitExists').mockResolvedValue(false);
    const original = f.server.store.snapshotVersioned.bind(f.server.store);
    let snapshots = 0;
    vi.spyOn(f.server.store, 'snapshotVersioned').mockImplementation(async () => {
      const snapshot = await original();
      snapshots += 1;
      await f.server.store.mutate((db) => { db.vaults.find((vault) => vault.vault_id === f.vaultId)!.current_main = `${snapshots}`.padStart(40, '0'); });
      return snapshot;
    });
    await f.server.readiness.sample('sampler');
    expect((await f.server.store.snapshot()).vaults.find((vault) => vault.vault_id === f.vaultId)?.status).toBe('active');
    expect(lines.filter((line) => line.includes('vault_integrity_block_contended'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"vault_integrity_blocked"'))).toHaveLength(0);
  });

  it('drains the sampler before closing the stores on shutdown', async () => {
    const f = await owner({ readiness: { autoStart: false } });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.server.store.snapshotVersioned.bind(f.server.store);
    vi.spyOn(f.server.store, 'snapshotVersioned').mockImplementation(async () => {
      await gate;
      order.push('sample-finished');
      return await original();
    });
    const sampling = f.server.readiness.sample().catch(() => undefined);
    const storeClose = f.server.store.close.bind(f.server.store);
    vi.spyOn(f.server.store, 'close').mockImplementation(async () => {
      order.push('store-close');
      await storeClose();
    });
    const closing = f.server.app.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    release();
    await closing;
    await sampling;
    expect(order).toEqual(['sample-finished', 'store-close']);
  });
});
