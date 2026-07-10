import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_VERSION } from '../src/shared/types.js';

describe('OpenAPI Phase 2 contract', () => {
  it('commits the endpoints and version used by the server and plugin', async () => {
    const contract = await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8');
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
      '/vaults/{vault_id}/pairing-tokens',
      '/vaults/{vault_id}/devices/{device_id}/revoke',
      '/pair/consume',
      '/device/self',
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
      '/vaults/{vault_id}/maintenance/git-gc/start',
      '/vaults/{vault_id}/events'
    ]) {
      expect(contract).toContain(path);
    }
    expect(contract).toContain(API_VERSION);
    expect(contract).toContain('ErrorEnvelope');
    expect(contract).toContain('__Host-obts_session');
    expect(contract).toContain('X-OBTS-CSRF');
    expect(contract).toContain('ConsumePairingTokenResponse');
    expect(contract).toContain('DeviceSelfResponse');
    expect(contract).toContain('DeviceStatusReport');
    expect(contract).toContain('server_device_ref');
    expect(contract).toContain('is_first_device');
    expect(contract).toContain('ConflictRecord');
    expect(contract).toContain('ConflictReviewPackage');
    expect(contract).toContain('ResolveConflictRequest');
    expect(contract).toContain('ResolveConflictResponse');
    expect(contract).toContain('keep_server');
    expect(contract).toContain('insert_both_blocks');
    expect(contract).toContain('DashboardSummary');
    expect(contract).toContain('NoteHistoryQueryResponse');
    expect(contract).toContain('MaintenanceStartResponse');
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
