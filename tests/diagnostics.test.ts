import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticService } from '../src/server/diagnosticService.js';
import { parseDiagnosticEvent } from '../src/shared/diagnostics.js';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';

const report = {
  schema_version: 1,
  event_id: 'dgr_0123456789abcdef0123456789abcdef',
  plugin_version: '0.4.0',
  obsidian_version: '1.9.12',
  platform_family: 'ios',
  flow: 'onboarding',
  stage: 'pack_index',
  failure_code: 'missing_buffer_dependency',
  error_class: 'type_error',
  retryable: false,
  breadcrumbs: [
    {
      point: 'index_fs_read',
      outcome: 'returned',
      value_kind: 'buffer',
      size_bucket: 'under_1m',
      error_code: 'none'
    }
  ]
} as const;

const troubleshootingReport = {
  ...report,
  schema_version: 2,
  event_id: 'dgr_123456789abcdef0123456789abcdef0',
  flow: 'recovery',
  stage: 'recovery',
  failure_code: 'troubleshooting_snapshot',
  error_class: 'blocked_error',
  breadcrumbs: [],
  context: {
    attempt_id: 'rca_123456789abcdef0123456789abcdef0',
    trigger: 'reconcile_guard',
    phase: 'checking_guard',
    outcome: 'skipped',
    safe_error_code: 'device_blocked',
    client_state: 'ready',
    lease_state: 'owned_active',
    state_source: 'primary',
    paired: true,
    status_class: 'review',
    queue_state: 'conflicted',
    apply_journal: 'absent',
    onboarding_journal: 'complete',
    transfer_journal: 'absent',
    pending_applied_ack: 'absent',
    cursor_guard: 'no_preservation',
    reconcile_guard: 'cursor_changed',
    reconcile_timestamp: 'unchanged',
    reconcile_error: 'unchanged',
    reconcile_cursors: 'changed',
    server_device_status: 'synced',
    server_vault_status: 'active',
    request_outcome: 'succeeded',
    http_status: 'success',
    cursor_relations: {
      local_head_to_local_main: 'different',
      server_ref_to_local_head: 'equal',
      local_main_to_server_main: 'different',
      event_to_applied: 'equal',
      event_to_server: 'behind'
    }
  }
} as const;

describe('opt-in error diagnostics backend', () => {
  it('accepts closed correlated phase observations and rejects unsafe schema-3 additions', () => {
    const phaseEvent = {
      schema_version: 3,
      event_id: 'dgr_0123456789abcdef0123456789abcdef',
      plugin_version: '0.5.21',
      obsidian_version: '1.9.12',
      platform_family: 'desktop',
      flow: 'plugin',
      stage: 'plugin_lifecycle',
      failure_code: 'operation_stalled',
      error_class: 'unknown',
      retryable: false,
      breadcrumbs: [],
      phase: 'local_snapshot',
      phase_id: 'dph_0123456789abcdef0123456789abcdef',
      observation: 'completed',
      elapsed_bucket: '5m_to_15m'
    };
    expect(parseDiagnosticEvent(phaseEvent)).toMatchObject({ observation: 'completed', elapsed_bucket: '5m_to_15m' });
    expect(() => parseDiagnosticEvent({ ...phaseEvent, raw_duration_ms: 300_000 })).toThrow();
    expect(() => parseDiagnosticEvent({ ...phaseEvent, phase: 'Checking /secret/path' })).toThrow();
    expect(() => parseDiagnosticEvent({ ...phaseEvent, observation: 'succeeded' })).toThrow();
  });
  const roots: string[] = [];
  const servers: ObtsServer[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('accepts approved connection and paired-device reports, deduplicates, lists, and deletes them', async () => {
    const fixture = await setupFixture(true);
    const pending = await createConnection(fixture.baseUrl);

    const pendingReport = await postDiagnostic(
      `${fixture.baseUrl}/api/v1/connections/${pending.connection_id}/diagnostic-events`,
      pending.connection_secret,
      report
    );
    expect(pendingReport.status).toBe(404);

    await approveNewVault(fixture, pending.connection_id);
    const accepted = await postDiagnostic(
      `${fixture.baseUrl}/api/v1/connections/${pending.connection_id}/diagnostic-events`,
      pending.connection_secret,
      report
    );
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).status).toBe('accepted');

    const duplicate = await postDiagnostic(
      `${fixture.baseUrl}/api/v1/connections/${pending.connection_id}/diagnostic-events`,
      pending.connection_secret,
      report
    );
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).status).toBe('duplicate');

    const completion = await completeConnection(fixture.baseUrl, pending.connection_id, pending.connection_secret);
    const deviceReport = {
      ...report,
      event_id: 'dgr_fedcba9876543210fedcba9876543210',
      flow: 'sync',
      failure_code: 'invalid_json'
    };
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/device/diagnostic-events`, completion.device_token, deviceReport)).status).toBe(202);
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/device/diagnostic-events`, completion.device_token, {
      ...report,
      event_id: 'dgr_00112233445566778899aabbccddeeff',
      flow: 'plugin',
      stage: 'unknown',
      failure_code: 'operation_interrupted_by_reload',
      error_class: 'blocked_error'
    })).status).toBe(202);
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/device/diagnostic-events`, completion.device_token, {
      ...report,
      event_id: 'dgr_ffeeddccbbaa99887766554433221100',
      flow: 'recovery',
      stage: 'recovery',
      failure_code: 'operation_stalled',
      error_class: 'unknown',
      retryable: true,
      breadcrumbs: [{
        point: 'recovery_target_commit',
        outcome: 'started',
        value_kind: 'unknown',
        size_bucket: 'unknown',
        error_code: 'none'
      }]
    })).status).toBe(202);
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/device/diagnostic-events`, completion.device_token, {
      schema_version: 3,
      event_id: 'dgr_abcdef0123456789abcdef0123456789',
      plugin_version: '0.5.21',
      obsidian_version: '1.9.12',
      platform_family: 'desktop',
      flow: 'plugin',
      stage: 'plugin_lifecycle',
      failure_code: 'operation_stalled',
      error_class: 'unknown',
      retryable: false,
      breadcrumbs: [],
      phase: 'directory_inventory',
      phase_id: 'dph_abcdef0123456789abcdef0123456789',
      observation: 'stalled',
      elapsed_bucket: '1m_to_5m'
    })).status).toBe(202);

    const listed = await fixture.adminGet('/api/v1/diagnostic-events');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ ingestion_enabled: true, retention_days: 14 });
    expect((listed.body.events as unknown[])).toHaveLength(5);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain(pending.connection_secret);
    expect(serialized).not.toContain(completion.device_token);

    const snapshot = await fixture.server.store.snapshot();
    expect(snapshot.diagnostic_events).toHaveLength(5);
    expect(snapshot.diagnostic_events.every((event) => event.owner_user_id === fixture.userId)).toBe(true);
    expect(snapshot.diagnostic_events.every((event) => event.device_id === completion.device_id)).toBe(true);

    const createOther = await fetch(`${fixture.baseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: { cookie: fixture.cookie, 'x-obts-csrf': fixture.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'other', password: 'another correct horse battery staple', is_admin: false })
    });
    expect(createOther.status).toBe(201);
    const otherLogin = await fetch(`${fixture.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'other', password: 'another correct horse battery staple' })
    });
    const otherCookie = otherLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    const otherList = await fetch(`${fixture.baseUrl}/api/v1/diagnostic-events`, { headers: { cookie: otherCookie } });
    expect(otherList.status).toBe(200);
    expect((await otherList.json()).events).toEqual([]);

    const deleted = await fixture.adminDelete('/api/v1/diagnostic-events');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted_count: 5 });
    expect((await fixture.server.store.snapshot()).diagnostic_events).toEqual([]);
  });

  it('accepts existing transfer and new post-apply progress points in stalled reports', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const points = ['sync_download', 'onboarding_download', 'transfer_checkpoint_verification', 'recovery_directory_decision', 'apply_local_capture', 'apply_finalize'];
    for (const [index, point] of points.entries()) {
      const progressReport = {
        ...report,
        event_id: `dgr_${index.toString(16).padStart(32, '0')}`,
        failure_code: 'operation_stalled',
        breadcrumbs: [{ point, outcome: 'started', value_kind: 'unknown', size_bucket: 'unknown', error_code: 'none' }]
      };
      expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`, connection.connection_secret, progressReport)).status).toBe(202);
    }
  });

  it('accepts troubleshooting schema v2 without changing schema v1 rows', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const completion = await completeConnection(fixture.baseUrl, connection.connection_id, connection.connection_secret);

    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/device/diagnostic-events`, completion.device_token, {
      ...report,
      plugin_version: '0.4.0-beta.1'
    })).status).toBe(202);
    expect((await postDiagnostic(
      `${fixture.baseUrl}/api/v1/device/diagnostic-events`,
      completion.device_token,
      troubleshootingReport
    )).status).toBe(202);
    const largeJournalReport = {
      ...troubleshootingReport,
      event_id: 'dgr_abcdef0123456789abcdef0123456789',
      context: { ...troubleshootingReport.context, apply_journal: 'present_unclassified' }
    };
    expect((await postDiagnostic(
      `${fixture.baseUrl}/api/v1/device/diagnostic-events`,
      completion.device_token,
      largeJournalReport
    )).status).toBe(202);

    const listed = await fixture.adminGet('/api/v1/diagnostic-events');
    expect((listed.body.events as Array<Record<string, unknown>>).map((event) => event.schema_version)).toEqual([2, 2, 1]);
    expect((listed.body.events as Array<Record<string, unknown>>)[0]).toMatchObject(largeJournalReport);
    const snapshot = await fixture.server.store.snapshot();
    expect(snapshot.diagnostic_events.map((event) => event.schema_version).sort()).toEqual([1, 2, 2]);
  });

  it('reserves manual capacity across devices sharing a source and returns duplicates after saturation', async () => {
    const fixture = await setupFixture(true);
    const devices: Awaited<ReturnType<typeof completeConnection>>[] = [];
    for (let index = 0; index < 2; index++) {
      const connection = await createConnection(fixture.baseUrl);
      await approveNewVault(fixture, connection.connection_id);
      devices.push(await completeConnection(fixture.baseUrl, connection.connection_id, connection.connection_secret));
    }
    const endpoint = `${fixture.baseUrl}/api/v1/device/diagnostic-events`;
    for (let index = 0; index < 60; index++) {
      expect((await postDiagnostic(endpoint, devices[0]!.device_token, { ...report, event_id: `dgr_${index.toString(16).padStart(32, '0')}` })).status).toBe(202);
    }
    expect((await postDiagnostic(endpoint, devices[0]!.device_token, { ...report, event_id: `dgr_${'0'.repeat(32)}` })).status).toBe(200);
    expect((await postDiagnostic(endpoint, devices[0]!.device_token, { ...report, event_id: `dgr_${'a'.repeat(32)}` })).status).toBe(429);
    expect((await postDiagnostic(endpoint, devices[1]!.device_token, { ...report, event_id: `dgr_${'b'.repeat(32)}` })).status).toBe(202);
    const manual = { ...troubleshootingReport, context: { ...troubleshootingReport.context, trigger: 'manual' } };
    expect((await postDiagnostic(endpoint, devices[1]!.device_token, manual)).status).toBe(202);
    expect((await postDiagnostic(endpoint, devices[0]!.device_token, manual)).status).toBe(202);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => postDiagnostic(endpoint, devices[0]!.device_token,
      { ...manual, event_id: `dgr_${(index + 100).toString(16).padStart(32, '0')}` })));
    expect(attempts.filter(response => response.status === 202)).toHaveLength(9);
    expect(attempts.filter(response => response.status === 429)).toHaveLength(3);
    expect((await postDiagnostic(endpoint, devices[0]!.device_token, manual)).status).toBe(200);
  });

  it('keeps connection-origin manual claims automatic after enrollment and restart', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const manual = { ...troubleshootingReport, context: { ...troubleshootingReport.context, trigger: 'manual' } };
    for (let index = 0; index < 20; index++) {
      expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`, connection.connection_secret,
        { ...manual, event_id: `dgr_${index.toString(16).padStart(32, '0')}` })).status).toBe(202);
    }
    const device = await completeConnection(fixture.baseUrl, connection.connection_id, connection.connection_secret);
    const auth = await fixture.server.auth.authenticateDeviceAnyVault(`Bearer ${device.device_token}`);
    const restarted = new DiagnosticService(fixture.server.store, fixture.server.config);
    await restarted.initialize();
    await expect(restarted.ingestDevice(auth, manual, 'shared-proxy')).resolves.toMatchObject({ status: 'accepted' });
  });

  it('retains daily admission accounting through startup deletion and hourly expiry', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const device = await completeConnection(fixture.baseUrl, connection.connection_id, connection.connection_secret);
    const auth = await fixture.server.auth.authenticateDeviceAnyVault(`Bearer ${device.device_token}`);
    const manual = { ...troubleshootingReport, context: { ...troubleshootingReport.context, trigger: 'manual' } };
    for (let index = 0; index < 10; index++) {
      await fixture.server.diagnostics.ingestDevice(auth, { ...manual, event_id: `dgr_${index.toString(16).padStart(32, '0')}` }, 'proxy');
    }
    const restarted = new DiagnosticService(fixture.server.store, fixture.server.config);
    await restarted.initialize();
    await restarted.deleteOwnerEvents(fixture.userId);
    await expect(restarted.ingestDevice(auth, manual, 'proxy')).rejects.toMatchObject({ code: 'diagnostic_rate_limited' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now + 60 * 60 * 1000 + 1);
    await expect(restarted.ingestDevice(auth, manual, 'proxy')).rejects.toMatchObject({ code: 'diagnostic_quota_exceeded' });
    vi.setSystemTime(now + 24 * 60 * 60 * 1000 + 1);
    await expect(restarted.ingestDevice(auth, manual, 'proxy')).resolves.toMatchObject({ status: 'accepted' });
  });

  it('does not charge rejected quotas or failed persistence against manual acceptance', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const device = await completeConnection(fixture.baseUrl, connection.connection_id, connection.connection_secret);
    const auth = await fixture.server.auth.authenticateDeviceAnyVault(`Bearer ${device.device_token}`);
    const manual = { ...troubleshootingReport, context: { ...troubleshootingReport.context, trigger: 'manual' } };
    const mutate = vi.spyOn(fixture.server.store, 'mutate');
    mutate.mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(fixture.server.diagnostics.ingestDevice(auth, manual, 'proxy')).rejects.toThrow('synthetic persistence failure');
    mutate.mockRestore();
    await fixture.server.store.mutate(db => {
      db.diagnostic_events = Array.from({ length: 2000 }, (_, index) => ({ ...report, breadcrumbs: [...report.breadcrumbs],
        event_id: `dgr_${index.toString(16).padStart(32, '0')}`, owner_user_id: fixture.userId,
        device_id: null, connection_id: null, vault_id: auth.vault.vault_id,
        received_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() }));
    });
    for (let index = 0; index < 12; index++) {
      await expect(fixture.server.diagnostics.ingestDevice(auth, manual, 'proxy')).rejects.toMatchObject({ code: 'diagnostic_quota_exceeded' });
    }
    await fixture.server.diagnostics.deleteOwnerEvents(fixture.userId);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
      fixture.server.diagnostics.ingestDevice(auth, { ...manual, event_id: `dgr_${index.toString(16).padStart(32, '0')}` }, 'proxy')));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  });

  it('rechecks connection authorization after it waits for admission', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const auth = await fixture.server.connections.authenticateDiagnostics(connection.connection_id, connection.connection_secret);
    await fixture.server.store.mutate(db => { db.connections.find(row => row.connection_id === connection.connection_id)!.status = 'denied'; });
    await expect(fixture.server.diagnostics.ingestConnection(auth, report, 'proxy')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accepts only bounded upload-size categories without paths, OIDs, or exact bytes', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    const sizeReport = {
      ...report,
      event_id: 'dgr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      flow: 'sync', stage: 'sync_request', failure_code: 'object_too_large_for_chunk', error_class: 'blocked_error',
      breadcrumbs: [{ point: 'upload_prepare', outcome: 'failed', value_kind: 'other', size_bucket: 'under_64m', error_code: 'none' }]
    };
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`, connection.connection_secret, sizeReport)).status).toBe(202);
    const sizeSnapshot = {
      ...troubleshootingReport,
      event_id: 'dgr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      context: { ...troubleshootingReport.context, safe_error_code: 'object_too_large_for_chunk', status_class: 'out_of_sync' }
    };
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`, connection.connection_secret, sizeSnapshot)).status).toBe(202);
    expect((await postDiagnostic(`${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`, connection.connection_secret, {
      ...sizeReport, event_id: 'dgr_cccccccccccccccccccccccccccccccc', current_paths: ['private-index.bin']
    })).status).toBe(400);
    expect(JSON.stringify(await fixture.server.store.snapshot())).not.toContain('private-index.bin');
  });

  it('rejects disabled ingestion, wrong credentials, extra fields, and privacy canaries', async () => {
    const disabled = await setupFixture(false);
    const disabledConnection = await createConnection(disabled.baseUrl);
    await approveNewVault(disabled, disabledConnection.connection_id);
    expect((await postDiagnostic(
      `${disabled.baseUrl}/api/v1/connections/${disabledConnection.connection_id}/diagnostic-events`,
      disabledConnection.connection_secret,
      report
    )).status).toBe(503);

    const enabled = await setupFixture(true);
    const connection = await createConnection(enabled.baseUrl);
    await approveNewVault(enabled, connection.connection_id);
    expect((await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      'obts_conn_wrong',
      report
    )).status).toBe(401);

    const canary = {
      ...report,
      event_id: 'dgr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'private-note.md diagnostic-secret-body obts_dev_secret'
    };
    const rejected = await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      canary
    );
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await enabled.server.store.snapshot())).not.toContain('diagnostic-secret-body');

    const troubleshootingCanary = {
      ...troubleshootingReport,
      event_id: 'dgr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      context: {
        ...troubleshootingReport.context,
        note_path: 'private-note.md'
      }
    };
    const rejectedTroubleshooting = await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      troubleshootingCanary
    );
    expect(rejectedTroubleshooting.status).toBe(400);
    const rejectedTroubleshootingValue = await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      {
        ...troubleshootingReport,
        event_id: 'dgr_cccccccccccccccccccccccccccccccc',
        context: { ...troubleshootingReport.context, safe_error_code: 'private-note.md' }
      }
    );
    expect(rejectedTroubleshootingValue.status).toBe(400);
    expect((await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      { ...report, event_id: 'dgr_dddddddddddddddddddddddddddddddd', failure_code: 'troubleshooting_snapshot' }
    )).status).toBe(400);
    expect((await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      { ...troubleshootingReport, event_id: 'dgr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', flow: 'sync' }
    )).status).toBe(400);
    expect((await postDiagnostic(
      `${enabled.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      { ...troubleshootingReport, event_id: 'dgr_ffffffffffffffffffffffffffffffff', plugin_version: '0.4.28-private-note.md' }
    )).status).toBe(400);
    expect(JSON.stringify(await enabled.server.store.snapshot())).not.toContain('private-note.md');
  });

  it('prunes reports by server retention time and rejects out-of-range retention configuration', async () => {
    const fixture = await setupFixture(true);
    const connection = await createConnection(fixture.baseUrl);
    await approveNewVault(fixture, connection.connection_id);
    expect((await postDiagnostic(
      `${fixture.baseUrl}/api/v1/connections/${connection.connection_id}/diagnostic-events`,
      connection.connection_secret,
      report
    )).status).toBe(202);
    await fixture.server.store.mutate((db) => {
      db.diagnostic_events[0]!.expires_at = new Date(0).toISOString();
    });
    await fixture.server.diagnostics.prune();
    expect((await fixture.server.store.snapshot()).diagnostic_events).toEqual([]);

    const invalidRoot = await mkdtemp(join(tmpdir(), 'obts-diagnostics-invalid-retention-'));
    roots.push(invalidRoot);
    await expect(createObtsServer({ dataDir: invalidRoot, diagnosticRetentionDays: 91 })).rejects.toThrow(
      'Diagnostic retention must be an integer from 1 to 90 days.'
    );
  });

  it('migrates schema 3 metadata while deleting legacy arbitrary error details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-diagnostics-migration-'));
    roots.push(root);
    const initial = await createObtsServer({ dataDir: root });
    servers.push(initial);
    await initial.app.close();
    servers.splice(servers.indexOf(initial), 1);
    const metadataPath = join(root, 'metadata', 'phase1.json');
    const legacy = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    legacy.schema_version = 3;
    legacy.devices = [{
      device_id: 'dev_legacy', vault_id: 'vlt_legacy', user_id: 'usr_legacy', device_name: 'legacy', device_ref: 'refs/legacy',
      device_ref_head: null, status: 'paired', last_applied_main: null, last_applied_event_seq: 0, last_applied_explicit_dirs: [], pending_applied_main: null, pending_applied_event_seq: 0, pending_applied_explicit_dirs: null, last_seen_at: null, last_successful_sync_at: null,
      local_status_label: 'Blocked', local_error_code: 'legacy', local_error_details: { path: 'private-note.md', secret: 'diagnostic-secret-body' },
      local_queue_status: null, local_main: null, local_head: null, plugin_version: null, path_capabilities: null,
      last_status_report_at: null, onboarding_status: null, onboarding_mode: null, initial_proposal_kind: null,
      initial_proposal_base: null, onboarding_connection_id: null, onboarding_completed_at: null, created_at: new Date().toISOString(), revoked_at: null
    }];
    delete legacy.diagnostic_events;
    await writeFile(metadataPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const migrated = await createObtsServer({ dataDir: root });
    servers.push(migrated);
    const serialized = JSON.stringify(await migrated.store.snapshot());
    expect((await migrated.store.snapshot()).schema_version).toBe(7);
    expect(serialized).not.toContain('private-note.md');
    expect(serialized).not.toContain('diagnostic-secret-body');
  });

  async function setupFixture(enabled: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'obts-diagnostics-'));
    roots.push(root);
    const server = await createObtsServer({
      dataDir: root,
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'diagnostic-test-session-secret',
      diagnosticIngestEnabled: enabled
    });
    servers.push(server);
    const baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const setup = await fetch(`${baseUrl}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple', display_name: 'Owner' })
    });
    const setupBody = await setup.json() as { user_id: string; csrf_token: string };
    const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
    const adminGet = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const adminDelete = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'DELETE',
        headers: { cookie, 'x-obts-csrf': setupBody.csrf_token }
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { server, baseUrl, cookie, csrf: setupBody.csrf_token, userId: setupBody.user_id, adminGet, adminDelete };
  }
});

async function createConnection(baseUrl: string): Promise<{ connection_id: string; connection_secret: string }> {
  const response = await fetch(`${baseUrl}/api/v1/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      plugin_version: '0.4.0',
      device_name: 'iPhone',
      local_vault_name: 'Mobile',
      local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    })
  });
  expect(response.status).toBe(201);
  return await response.json() as { connection_id: string; connection_secret: string };
}

async function approveNewVault(
  fixture: { baseUrl: string; cookie: string; csrf: string },
  connectionId: string
): Promise<void> {
  const response = await fetch(`${fixture.baseUrl}/api/v1/connections/${connectionId}/approve`, {
    method: 'POST',
    headers: { cookie: fixture.cookie, 'x-obts-csrf': fixture.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ selection: 'new_vault', display_name: 'Diagnostics vault' })
  });
  expect(response.status).toBe(200);
}

async function completeConnection(baseUrl: string, connectionId: string, secret: string): Promise<{ device_token: string; device_id: string }> {
  const response = await fetch(`${baseUrl}/api/v1/connections/${connectionId}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'initialize', expected_main: null, proposal_kind: 'new_vault_import' })
  });
  expect(response.status).toBe(201);
  return await response.json() as { device_token: string; device_id: string };
}

async function postDiagnostic(url: string, token: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
