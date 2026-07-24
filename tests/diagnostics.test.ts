import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

describe('opt-in error diagnostics backend', () => {
  const roots: string[] = [];
  const servers: ObtsServer[] = [];

  afterEach(async () => {
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

    const listed = await fixture.adminGet('/api/v1/diagnostic-events');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ ingestion_enabled: true, retention_days: 14 });
    expect((listed.body.events as unknown[])).toHaveLength(4);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain(pending.connection_secret);
    expect(serialized).not.toContain(completion.device_token);

    const snapshot = await fixture.server.store.snapshot();
    expect(snapshot.diagnostic_events).toHaveLength(4);
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
    expect(deleted.body).toMatchObject({ deleted_count: 4 });
    expect((await fixture.server.store.snapshot()).diagnostic_events).toEqual([]);
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
    expect((await migrated.store.snapshot()).schema_version).toBe(6);
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
