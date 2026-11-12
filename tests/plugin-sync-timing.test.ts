import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import { diagnosticPoints } from '../src/shared/diagnostics.js';
import { mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';
import { createSyncCostFixture, writeNote } from './helpers/syncCostHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Recorded = {
  attempt_id: string;
  trigger: string;
  outcome: string;
  runtime: string;
  error_code: string;
  elapsed_bucket: string;
  hidden_bucket: string;
  suspended_bucket: string;
  scan_mode: string;
  apply_mode: string;
  scan_files_bucket: string;
  target_changes_bucket: string;
  event_lag_bucket: string;
  phases: Array<{ point: string; elapsed_bucket: string }>;
};

async function recordAttempts(client: { client: unknown }, sink: Recorded[]): Promise<void> {
  (client.client as { setSyncTimingSink: (sink: (attempt: Recorded) => void) => void }).setSyncTimingSink((attempt) => sink.push(attempt));
}

describe('sync timing attempts in the shared client', () => {
  it('records an applied remote change with its phases and change buckets', async () => {
    const fixture = await createSyncCostFixture(3);
    cleanups.push(async () => await fixture.close());
    const recorded: Recorded[] = [];
    await recordAttempts(fixture.reader as unknown as { client: unknown }, recorded);
    await writeNote(fixture.writerDir, 1, '# Edited remotely\n');
    await fixture.writer.syncOnce();
    await fixture.reader.pollRemoteEventsAndApply();

    await waitUntil(() => recorded.length > 0);
    const attempt = recorded.at(-1)!;
    expect(attempt).toMatchObject({
      trigger: 'headless',
      runtime: 'headless',
      outcome: 'completed',
      error_code: 'none'
    });
    expect(['ref_only', 'delta', 'full']).toContain(attempt.apply_mode);
    expect(attempt.target_changes_bucket).not.toBe('none');
    expect(attempt.phases.map((phase) => phase.point)).toEqual(expect.arrayContaining(['sync_request']));
    for (const phase of attempt.phases) expect(diagnosticPoints).toContain(phase.point as typeof diagnosticPoints[number]);
    expect(JSON.stringify(attempt)).not.toContain('note-00001.md');
  });

  it('records an upload from a device that authored a change', async () => {
    const fixture = await createSyncCostFixture(3);
    cleanups.push(async () => await fixture.close());
    const recorded: Recorded[] = [];
    await recordAttempts(fixture.writer as unknown as { client: unknown }, recorded);
    await writeNote(fixture.writerDir, 2, '# Authored here\n');
    await fixture.writer.syncOnce({ hintedCapture: false, fullAudit: false });

    await waitUntil(() => recorded.length > 0);
    const attempt = recorded.at(-1)!;
    expect(attempt.outcome).toBe('completed');
    expect(attempt.scan_mode).not.toBe('none');
    expect(attempt.scan_files_bucket).not.toBe('none');
    expect(attempt.phases.map((phase) => phase.point)).toEqual(expect.arrayContaining(['upload_prepare', 'upload_finalize']));
  });

  it('records a failed attempt with a coarse safe error code', async () => {
    const fixture = await createSyncCostFixture(2);
    cleanups.push(async () => await fixture.close());
    const recorded: Recorded[] = [];
    await recordAttempts(fixture.reader as unknown as { client: unknown }, recorded);
    const core = (fixture.reader as unknown as { client: { readState: () => Promise<Record<string, unknown>>; writeState: (state: unknown) => Promise<void> } }).client;
    await core.writeState({ ...await core.readState(), last_error_code: 'device_blocked', status_label: 'Blocked' });
    await expect(fixture.reader.syncOnce()).rejects.toThrow();

    await waitUntil(() => recorded.length > 0);
    const attempt = recorded.at(-1)!;
    expect(attempt).toMatchObject({ outcome: 'failed', error_code: 'device_blocked', trigger: 'headless' });
  });
});

describe('sync timing delivery from the Obsidian plugin', () => {
  async function fixture(options: { status?: number } = {}) {
    await mkdir('tmp/sync-timing-tests', { recursive: true });
    const root = await mkdtemp(join(process.cwd(), 'tmp/sync-timing-tests/client-'));
    const posted: Array<Record<string, any>> = [];
    const status = options.status ?? 202;
    const client = await mobileHarness(root, 'http://127.0.0.1:3000', {
      request: async (request: any) => {
        const url = new URL(request.url);
        if (url.pathname === '/api/v1/device/diagnostic-events') posted.push(JSON.parse(String(request.body)));
        return {
          status,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          text: JSON.stringify(status === 202 ? { status: 'accepted', event_id: 'dgr_0123456789abcdef0123456789abcdef' } : { error: { code: 'invalid_request' } }),
          json: status === 202 ? { status: 'accepted' } : { error: { code: 'invalid_request' } }
        };
      }
    });
    cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
    await client.core.writeState({ ...await client.core.readState(), vault_id: 'vault', device_id: 'device' });
    client.core.readDeviceToken = async () => 'synthetic';
    await client.plugin.setDiagnosticSharing(true);
    client.context.__clock = { now: 1_000_000 };
    // Manual clock and ticks keep the suspension accounting deterministic.
    vm.runInContext('Date.now = () => __clock.now; setInterval = () => 0; clearInterval = () => undefined', client.context);
    return { ...client, posted, clock: client.context.__clock as { now: number } };
  }

  it('sends one batch for a foreground sync with phase, hidden and suspension accounting', async () => {
    const client = await fixture();
    expect(client.plugin.beginSync('Sync now', 'user')).toBe(true);
    client.plugin.setOperationProgress('Checking (requesting changes)', 'sync_request');
    client.clock.now += 2000;
    client.core.observeSyncTimingTick();
    // The harness stubs registerDomEvent, so the visibilitychange listener is
    // driven directly; on a device both paths end in the same client call.
    client.core.noteSyncTimingVisibility(true);
    client.clock.now += 3000;
    client.core.observeSyncTimingTick();
    client.core.noteSyncTimingVisibility(false);
    client.plugin.setOperationProgress('Applying (writing files)', 'apply_write');
    client.clock.now += 40_000;
    client.core.observeSyncTimingTick();
    client.clock.now += 1000;
    client.core.noteSyncTimingApplyMode('delta');
    client.core.noteSyncTimingTargetChanges(3);
    client.plugin.endSync(true);

    await waitUntil(() => client.posted.length === 1);
    const report = client.posted[0]!;
    expect(report).toMatchObject({
      schema_version: 4,
      flow: 'sync',
      stage: 'sync_request',
      failure_code: 'sync_timing',
      platform_family: 'ios'
    });
    expect(report.batch_id).toMatch(/^stm_[0-9a-f]{32}$/u);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({
      trigger: 'user',
      runtime: 'foreground',
      outcome: 'completed',
      error_code: 'none',
      elapsed_bucket: '30s_to_1m',
      hidden_bucket: 'under_5s',
      suspended_bucket: '30s_to_1m',
      apply_mode: 'delta',
      target_changes_bucket: 'two_to_five',
      scan_mode: 'none'
    });
    expect(report.attempts[0].phases).toEqual([
      { point: 'apply_write', elapsed_bucket: '30s_to_1m' },
      { point: 'sync_request', elapsed_bucket: 'under_30s' }
    ]);
    expect(JSON.stringify(report)).not.toContain('vault');
  });

  it('batches background attempts and reports an abandoned one immediately', async () => {
    const client = await fixture();
    for (let index = 0; index < 5; index += 1) {
      expect(client.plugin.beginSync('Background sync', 'interval')).toBe(true);
      client.plugin.setOperationProgress('Checking (requesting changes)', 'sync_request');
      client.core.noteSyncTimingApplyMode('ref_only');
      client.clock.now += 500;
      client.plugin.endSync(true);
      await Promise.resolve();
    }
    expect(client.posted).toHaveLength(0);
    expect(client.plugin.beginSync('Background sync', 'interval')).toBe(true);
    client.core.noteSyncTimingApplyMode('full');
    client.plugin.endSync(true);
    await waitUntil(() => client.posted.length === 1);
    expect(client.posted[0]!.attempts).toHaveLength(6);
    expect(client.posted[0]!.attempts.map((attempt: Recorded) => attempt.trigger)).toEqual(Array(6).fill('interval'));

    expect(client.plugin.beginSync('Background sync', 'watcher')).toBe(true);
    client.clock.now += 1000;
    client.plugin.endSync(false);
    await waitUntil(() => client.posted.length === 2);
    expect(client.posted[1]!.attempts).toHaveLength(1);
    expect(client.posted[1]!.attempts[0]).toMatchObject({ trigger: 'watcher', outcome: 'abandoned', error_code: 'none' });
  });

  it('stops sending when a server rejects the schema and never blocks sync', async () => {
    const client = await fixture({ status: 400 });
    expect(client.plugin.beginSync('Sync now', 'user')).toBe(true);
    client.core.noteSyncTimingApplyMode('full');
    client.plugin.endSync(true);
    await waitUntil(() => client.posted.length === 1);
    await waitUntil(() => client.plugin.syncTimingUnsupported === true);

    expect(client.plugin.beginSync('Sync now', 'user')).toBe(true);
    client.core.noteSyncTimingApplyMode('full');
    client.plugin.endSync(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.posted).toHaveLength(1);
    expect(client.plugin.pendingSyncTiming).toEqual([]);
    expect(client.notices.join(' ')).not.toContain('invalid_request');
  });

  it('clamps an unknown error code instead of shipping a rejected record', async () => {
    const client = await fixture();
    expect(client.plugin.beginSync('Sync now', 'user')).toBe(true);
    client.core.syncTimingAttempt.errorCode = 'future_code_not_in_the_server_vocabulary';
    client.plugin.endSync(false);
    await waitUntil(() => client.posted.length === 1);
    expect(client.posted[0]!.attempts[0]).toMatchObject({ outcome: 'failed', error_code: 'unknown' });
  });

  it('sends nothing while diagnostic sharing is not opted in', async () => {
    const client = await fixture();
    await client.plugin.setDiagnosticSharing(false);
    expect(client.plugin.beginSync('Sync now', 'user')).toBe(true);
    client.core.noteSyncTimingApplyMode('full');
    client.plugin.endSync(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.posted).toHaveLength(0);
    expect(client.plugin.pendingSyncTiming).toEqual([]);
  });
});

// Keep an unused-import guard: writeFile is only needed by fixtures that
// pre-create notes through the shared harness helpers.
void writeFile;
