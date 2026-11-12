import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { OperationalLog } from '../src/server/operationalLog.js';
import { parseDiagnosticEvent } from '../src/shared/diagnostics.js';

const phaseEvent = {
  schema_version: 3,
  event_id: 'dgr_0123456789abcdef0123456789abcdef',
  plugin_version: '0.7.9',
  obsidian_version: '1.9.12',
  platform_family: 'android',
  flow: 'plugin',
  stage: 'plugin_lifecycle',
  failure_code: 'operation_stalled',
  error_class: 'unknown',
  retryable: false,
  breadcrumbs: [],
  phase: 'apply_finalize',
  phase_id: 'dph_0123456789abcdef0123456789abcdef',
  observation: 'completed',
  elapsed_bucket: '1m_to_5m'
} as const;

const attempt = {
  attempt_id: 'stm_0123456789abcdef0123456789abcdef',
  trigger: 'visibility',
  outcome: 'completed',
  runtime: 'foreground',
  error_code: 'none',
  elapsed_bucket: '30s_to_1m',
  hidden_bucket: 'under_5s',
  suspended_bucket: 'under_1s',
  scan_mode: 'incremental',
  apply_mode: 'delta',
  scan_files_bucket: 'twenty_one_to_hundred',
  target_changes_bucket: 'two_to_five',
  event_lag_bucket: 'none',
  phases: [
    { point: 'sync_request', elapsed_bucket: 'under_1s' },
    { point: 'file_inventory_check', elapsed_bucket: 'under_30s' },
    { point: 'apply_finalize', elapsed_bucket: 'under_5s' }
  ]
} as const;

const timingReport = {
  schema_version: 4,
  event_id: 'dgr_abcdef0123456789abcdef0123456789',
  plugin_version: '0.7.9',
  obsidian_version: '1.9.12',
  platform_family: 'android',
  flow: 'sync',
  stage: 'sync_request',
  failure_code: 'sync_timing',
  error_class: 'unknown',
  retryable: false,
  breadcrumbs: [],
  batch_id: 'stm_fedcba9876543210fedcba9876543210',
  attempts: [attempt]
} as Record<string, unknown>;

describe('schema 4 sync timing diagnostics', () => {
  const roots: string[] = [];
  const servers: ObtsServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('accepts one closed batch of attempt summaries and rejects unbounded or unknown fields', () => {
    const parsed = parseDiagnosticEvent(timingReport);
    expect(parsed).toMatchObject({ schema_version: 4, failure_code: 'sync_timing', batch_id: 'stm_fedcba9876543210fedcba9876543210' });
    expect(parsed.schema_version === 4 && parsed.attempts[0]).toMatchObject({ trigger: 'visibility', apply_mode: 'delta', elapsed_bucket: '30s_to_1m' });
    expect(() => parseDiagnosticEvent({ ...timingReport, raw_duration_ms: 42_000 })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: Array.from({ length: 7 }, (_unused, index) => ({
      ...attempt, attempt_id: `stm_${String(index).padStart(32, '0')}`
    })) })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [attempt, attempt] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [{
      ...attempt, phases: [{ point: 'sync_request', elapsed_bucket: 'under_1s' }, { point: 'sync_request', elapsed_bucket: 'under_5s' }]
    }] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [{
      ...attempt, phases: Array.from({ length: 7 }, (_unused, index) => ({ point: `phase_${index}`, elapsed_bucket: 'under_1s' }))
    }] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [{ ...attempt, elapsed_bucket: '42000ms' }] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [{ ...attempt, note_path: 'private-note.md' }] })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, attempts: [{ ...attempt, trigger: 'manual-import' }] })).toThrow();
    expect(parseDiagnosticEvent({ ...timingReport, attempts: [{ ...attempt, error_code: 'unportable_target_paths' }] })).toMatchObject({
      attempts: [expect.objectContaining({ error_code: 'unportable_target_paths' })]
    });
    expect(() => parseDiagnosticEvent({ ...timingReport, batch_id: 'batch-1' })).toThrow();
    expect(() => parseDiagnosticEvent({ ...timingReport, flow: 'plugin' })).toThrow();
  });

  it('admits, lists and logs a timing batch while still accepting older schemas', async () => {
    const lines: string[] = [];
    const server = await createObtsServer(
      {
        dataDir: await dataRoot(roots),
        publicBaseUrl: 'http://127.0.0.1:0',
        sessionSecret: 'sync-timing-fixture-secret-value',
        diagnosticIngestEnabled: true
      },
      { operationalLog: new OperationalLog('info', (line) => lines.push(line)) }
    );
    servers.push(server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const fixture = await setupAdmin(baseUrl);
    const device = await pairDevice(baseUrl, fixture);

    const accepted = await postDiagnostic(`${baseUrl}/api/v1/device/diagnostic-events`, device.device_token, timingReport);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).status).toBe('accepted');
    const older = await postDiagnostic(`${baseUrl}/api/v1/device/diagnostic-events`, device.device_token, {
      ...phaseEvent, event_id: 'dgr_0123456789abcdef0123456789abcdee'
    });
    expect(older.status).toBe(202);

    const listed = await fixture.adminGet('/api/v1/diagnostic-events');
    expect(listed.status).toBe(200);
    const events = (listed.body as { events: Array<Record<string, unknown>> }).events;
    const timing = events.find((event) => event.schema_version === 4)!;
    expect(timing).toMatchObject({ batch_id: 'stm_fedcba9876543210fedcba9876543210', failure_code: 'sync_timing' });
    expect((timing.attempts as unknown[]).length).toBe(1);
    expect(typeof timing.received_at).toBe('string');
    expect(Object.keys(timing)).not.toContain('device_id');
    expect(Object.keys(timing)).not.toContain('vault_id');
    expect(JSON.stringify(listed.body)).not.toContain('private-note.md');

    const admitted = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === 'diagnostic_admitted');
    expect(admitted).toHaveLength(2);
    expect(admitted.find((line) => line.diagnostic_schema === 4)).toMatchObject({
      level: 'info',
      diagnostic_schema: 4,
      diagnostic_flow: 'sync',
      diagnostic_attempts: 1,
      diagnostic_completed: 1,
      diagnostic_abandoned: 0,
      diagnostic_failed: 0,
      diagnostic_longest_bucket: '30s_to_1m',
      diagnostic_triggers: 'visibility',
      diagnostic_scan_modes: 'incremental',
      diagnostic_apply_modes: 'delta'
    });
    expect(admitted.every((line) => typeof line.device_id === 'string')).toBe(true);
    expect(lines.join('\n')).not.toContain('stm_0123456789');
    expect(lines.join('\n')).not.toContain('private-note.md');

    const malformed = await postDiagnostic(`${baseUrl}/api/v1/device/diagnostic-events`, device.device_token, {
      ...timingReport,
      event_id: 'dgr_11111111111111111111111111111111',
      attempts: [{ ...attempt, phases: [{ point: 'apply_finalize', elapsed_bucket: 'under_5s', path: 'private-note.md' }] }]
    });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await server.store.snapshot())).not.toContain('private-note.md');
  });

  it('keeps diagnostic storage bounded by retention and the automatic per-device budget', async () => {
    const server = await createObtsServer({
      dataDir: await dataRoot(roots),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'sync-timing-retention-secret-value',
      diagnosticIngestEnabled: true
    });
    servers.push(server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const fixture = await setupAdmin(baseUrl);
    const device = await pairDevice(baseUrl, fixture);

    let index = 0;
    const nextReport = () => ({
      ...timingReport,
      event_id: `dgr_${index.toString(16).padStart(32, '0')}`,
      batch_id: `stm_${index.toString(16).padStart(32, '0')}`,
      attempts: [{ ...attempt, attempt_id: `stm_${(index + 1_000_000).toString(16).padStart(32, '0')}` }]
    });
    expect((await postDiagnostic(`${baseUrl}/api/v1/device/diagnostic-events`, device.device_token, nextReport())).status).toBe(202);
    index += 1;
    await server.store.mutate((db) => {
      db.diagnostic_events[0]!.expires_at = new Date(0).toISOString();
    });
    await server.diagnostics.prune();
    expect((await server.store.snapshot()).diagnostic_events).toEqual([]);

    // The hourly per-identity budget binds before the daily device budget; the
    // acceptance window keeps accounting for the report retention deleted.
    let accepted = 1;
    let saturated: Response | null = null;
    for (let attemptIndex = 0; attemptIndex < 70 && !saturated; attemptIndex += 1) {
      const response = await postDiagnostic(`${baseUrl}/api/v1/device/diagnostic-events`, device.device_token, nextReport());
      index += 1;
      if (response.status === 202) accepted += 1;
      else saturated = response;
    }
    expect(saturated?.status).toBe(429);
    expect((await saturated!.json()).error.code).toBe('diagnostic_rate_limited');
    expect(accepted).toBe(60);
    expect((await server.store.snapshot()).diagnostic_events.length).toBe(59);
  });
});

async function dataRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'obts-sync-timing-'));
  roots.push(root);
  return join(root, 'data');
}

async function setupAdmin(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-password-1234' })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { csrf_token: string };
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const adminGet = async (path: string) => {
    const result = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    return { status: result.status, body: await result.json() as Record<string, unknown> };
  };
  return { baseUrl, cookie, csrf: body.csrf_token, adminGet };
}

async function pairDevice(baseUrl: string, fixture: { baseUrl: string; cookie: string; csrf: string }) {
  const created = await fetch(`${baseUrl}/api/v1/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      plugin_version: '0.7.9',
      device_name: 'Pixel',
      local_vault_name: 'Timing',
      local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    })
  });
  expect(created.status).toBe(201);
  const connection = await created.json() as { connection_id: string; connection_secret: string };
  const approved = await fetch(`${baseUrl}/api/v1/connections/${connection.connection_id}/approve`, {
    method: 'POST',
    headers: { cookie: fixture.cookie, 'x-obts-csrf': fixture.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ selection: 'new_vault', display_name: 'Timing vault' })
  });
  expect(approved.status).toBe(200);
  const completed = await fetch(`${baseUrl}/api/v1/connections/${connection.connection_id}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.connection_secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'initialize', expected_main: null, proposal_kind: 'new_vault_import' })
  });
  expect(completed.status).toBe(201);
  return await completed.json() as { device_token: string; device_id: string };
}

async function postDiagnostic(url: string, token: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
