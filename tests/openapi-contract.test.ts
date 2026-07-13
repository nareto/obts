import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { API_VERSION } from '../src/shared/types.js';

describe('OpenAPI Phase 3 contract', () => {
  it('commits the endpoints and version used by the server and plugin', async () => {
    const contract = await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8');
    const document = parse(contract) as {
      openapi: string;
      paths: Record<string, Record<string, { security?: Array<Record<string, unknown>>; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(document.openapi).toBe('3.1.0');
    for (const path of [
      '/setup',
      '/auth/login',
      '/auth/reauthenticate',
      '/auth/session',
      '/auth/logout',
      '/auth/password-reset',
      '/admin/users',
      '/admin/users/{user_id}/disable',
      '/admin/users/{user_id}/enable',
      '/admin/users/{user_id}/grant-admin',
      '/admin/users/{user_id}/revoke-admin',
      '/admin/users/{user_id}/password-reset-tokens',
      '/vaults',
      '/vaults/{vault_id}/main',
      '/vaults/{vault_id}/dashboard',
      '/connections',
      '/connections/{connection_id}',
      '/connections/{connection_id}/review',
      '/connections/{connection_id}/approve',
      '/connections/{connection_id}/deny',
      '/connections/{connection_id}/bootstrap',
      '/connections/{connection_id}/diagnostic-events',
      '/connections/{connection_id}/complete',
      '/diagnostic-events',
      '/vaults/{vault_id}/devices/{device_id}/revoke',
      '/device/self',
      '/device/diagnostic-events',
      '/vaults/{vault_id}/sync/push',
      '/vaults/{vault_id}/sync/pull',
      '/vaults/{vault_id}/sync/device-status',
      '/vaults/{vault_id}/sync/events',
      '/vaults/{vault_id}/sync/unpair',
      '/vaults/{vault_id}/conflicts',
      '/vaults/{vault_id}/conflicts/{conflict_id}',
      '/vaults/{vault_id}/conflicts/{conflict_id}/resolve',
      '/vaults/{vault_id}/history/query',
      '/vaults/{vault_id}/history/version',
      '/vaults/{vault_id}/history/restore',
      '/vaults/{vault_id}/diagnostics/export',
      '/vaults/{vault_id}/maintenance/git-gc/start',
      '/vaults/{vault_id}/events'
    ]) {
      expect(contract).toContain(path);
    }
    for (const path of [
      '/connections',
      '/connections/{connection_id}',
      '/connections/{connection_id}/review',
      '/connections/{connection_id}/approve',
      '/connections/{connection_id}/deny',
      '/connections/{connection_id}/bootstrap',
      '/connections/{connection_id}/complete'
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
    expect(document.paths['/connections']?.post?.security).toEqual([]);
    expect(document.paths['/connections/{connection_id}']?.get?.security).toEqual([{ connectionBearer: [] }]);
    expect(document.paths['/connections/{connection_id}/bootstrap']?.post?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/complete']?.post?.responses).toHaveProperty('409');
    expect(document.components.securitySchemes).toHaveProperty('connectionBearer');
    expect(document.components.schemas).toHaveProperty('ConnectionStatusResponse');
    expect(document.components.schemas).toHaveProperty('ConnectionReviewResponse');
    expect(document.components.schemas).toHaveProperty('ConnectionBootstrapManifest');
    expect(document.components.schemas).toHaveProperty('DiagnosticEvent');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventFields');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventView');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventsResponse');
    expect(document.components.schemas.DiagnosticEvent).toMatchObject({ unevaluatedProperties: false });
    expect(document.components.schemas.DiagnosticEventView).toMatchObject({ unevaluatedProperties: false });
    expect(document.paths['/connections/{connection_id}/diagnostic-events']?.post?.security).toEqual([{ connectionBearer: [] }]);
    expect(document.paths['/device/diagnostic-events']?.post?.security).toEqual([{ deviceBearer: [] }]);
    expect(contract).not.toContain('local_error_details');
    expect(contract).toContain('missing_buffer_dependency');
    expect(contract).toContain(API_VERSION);
    expect(contract).toContain('ErrorEnvelope');
    expect(contract).toContain('__Host-obts_session');
    expect(contract).toContain('X-OBTS-CSRF');
    expect(contract).toContain('CreateConnectionResponse');
    expect(contract).toContain('CompleteConnectionResponse');
    expect(contract).toContain('connectionBearer');
    expect(contract).not.toContain('/pair/consume');
    expect(contract).not.toContain('PairingToken');
    expect(contract).toContain('DeviceSelfResponse');
    expect(contract).toContain('DeviceStatusReport');
    expect(contract).toContain('server_device_ref');
    expect(contract).toContain('ConflictRecord');
    expect(contract).toContain('ConflictReviewPackage');
    expect(contract).toContain('ResolveConflictRequest');
    expect(contract).toContain('ResolveConflictResponse');
    expect(contract).toContain('keep_server');
    expect(contract).toContain('insert_both_blocks');
    expect(contract).toContain('DashboardSummary');
    expect(contract).toContain('NoteHistoryQueryResponse');
    expect(contract).toContain('MaintenanceStartResponse');
    expect(contract).toContain('DiagnosticsExport');
    expect(contract).toContain('content_redacted');
    expect(contract).toContain('validator_results');
    expect(contract).toContain('AdminUserSummary');
    expect(contract).toContain('PasswordResetTokenResponse');
    expect(contract).toContain('final enabled admin');

    const conflictResolutionSection = contract.slice(
      contract.indexOf('/vaults/{vault_id}/conflicts/{conflict_id}/resolve'),
      contract.indexOf('/vaults/{vault_id}/history/query')
    );
    expect(conflictResolutionSection).toContain('current authenticated dashboard session');
    expect(conflictResolutionSection).not.toContain('recent dashboard authentication');

    const pullSection = contract.slice(
      contract.indexOf('/vaults/{vault_id}/sync/pull'),
      contract.indexOf('/vaults/{vault_id}/sync/device-status')
    );
    expect(pullSection).toContain('multipart/form-data');
    expect(pullSection).toContain('DevicePullRequest');
    expect(pullSection).toContain('packfile');
    expect(pullSection).not.toContain('application/json:');
    expect(contract).toContain('current_local_main_is_ancestor');
    expect(contract).toContain('base_commit');

    const deviceEventsSection = contract.slice(
      contract.indexOf('/vaults/{vault_id}/sync/events'),
      contract.indexOf('/vaults/{vault_id}/sync/unpair')
    );
    expect(deviceEventsSection).toContain('deviceBearer');
    expect(deviceEventsSection).toContain('EventPage');

    const deviceUnpairSection = contract.slice(
      contract.indexOf('/vaults/{vault_id}/sync/unpair'),
      contract.indexOf('/vaults/{vault_id}/conflicts')
    );
    expect(deviceUnpairSection).toContain('deviceBearer');
    expect(deviceUnpairSection).toContain('StatusResponse');
  });
});
