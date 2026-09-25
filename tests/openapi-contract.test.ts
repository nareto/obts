import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { API_VERSION } from '../src/shared/types.js';
import { parseChunkPushCreateRequest, parseDevicePushManifest } from '../src/shared/validators.js';

describe('OpenAPI Phase 3 contract', () => {
  it('matches optional operation-bound root-ignore attestation on direct and chunked pushes', async () => {
    const contract = parse(await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as {
      components: { schemas: Record<string, { properties: Record<string, unknown>; dependentRequired: Record<string, string[]> }> };
    };
    const direct = contract.components.schemas.DevicePushManifest!;
    const chunked = contract.components.schemas.ChunkPushCreateRequest!;
    for (const schema of [direct, chunked]) {
      expect(schema.properties.root_ignore_capability).toMatchObject({ const: 'root-ignore-v1' });
      expect(schema.properties.root_ignore_oid).toMatchObject({ oneOf: [
        { type: 'null' }, { type: 'string', pattern: '^[0-9a-f]{40}$' }
      ] });
      expect(schema.dependentRequired).toEqual({
        root_ignore_capability: ['root_ignore_oid'], root_ignore_oid: ['root_ignore_capability']
      });
    }
    const base = {
      api_version: API_VERSION, vault_id: 'vault', device_id: 'device',
      expected_device_ref: null, target_commit: 'a'.repeat(40), client_known_main: null
    };
    const manifest = { ...base, packfile_sha256: 'b'.repeat(64), packfile_bytes: 0 };
    const create = { ...base, attempt_id: 'attempt-policy-1', chunk_count: 0, plan_sha256: 'b'.repeat(64) };
    for (const [parser, value] of [[parseDevicePushManifest, manifest], [parseChunkPushCreateRequest, create]] as const) {
      expect(parser(value)).not.toHaveProperty('root_ignore_oid');
      expect(parser({ ...value, root_ignore_capability: 'root-ignore-v1', root_ignore_oid: null })).toMatchObject({ root_ignore_oid: null });
      expect(() => parser({ ...value, root_ignore_capability: 'root-ignore-v1' })).toThrow();
      expect(() => parser({ ...value, root_ignore_capability: 'root-ignore-v2', root_ignore_oid: null })).toThrow();
      expect(() => parser({ ...value, root_ignore_capability: 'root-ignore-v1', root_ignore_oid: 'not-an-oid' })).toThrow();
    }
  });
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
      '/vault-deletions',
      '/vault-deletions/{vault_id}',
      '/vaults/{vault_id}',
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
      '/vaults/{vault_id}/devices/{device_id}',
      '/vaults/{vault_id}/devices/{device_id}/revoke',
      '/device/self',
      '/device/diagnostic-events',
      '/vaults/{vault_id}/sync/push',
      '/vaults/{vault_id}/sync/pull',
      '/vaults/{vault_id}/sync/device-status',
      '/vaults/{vault_id}/sync/applied',
      '/vaults/{vault_id}/sync/events',
      '/vaults/{vault_id}/sync/unpair',
      '/vaults/{vault_id}/conflicts',
      '/vaults/{vault_id}/conflicts/{conflict_id}',
      '/vaults/{vault_id}/conflicts/{conflict_id}/preview',
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
    expect(document.paths['/connections/{connection_id}']?.get?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/review']?.get?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/bootstrap']?.post?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/bootstrap-chunk']?.post?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/diagnostic-events']?.post?.responses).toHaveProperty('409');
    expect(document.paths['/connections/{connection_id}/complete']?.post?.responses).toHaveProperty('409');
    expect(document.components.securitySchemes).toHaveProperty('connectionBearer');
    expect(document.components.schemas).toHaveProperty('ConnectionStatusResponse');
    expect(document.components.schemas).toHaveProperty('DisplayName');
    expect(document.components.schemas).toHaveProperty('VaultNameRequest');
    expect(document.components.schemas).toHaveProperty('DeviceNameRequest');
    expect(document.components.schemas).toHaveProperty('DeviceNameResponse');
    expect(document.paths['/vaults/{vault_id}']?.patch).toBeDefined();
    expect(document.paths['/vaults/{vault_id}']?.delete).toBeDefined();
    expect(document.paths['/vaults/{vault_id}']?.delete?.responses).toHaveProperty('202');
    expect(document.paths['/vault-deletions']?.get).toBeDefined();
    expect(document.paths['/vault-deletions']?.get?.responses).toHaveProperty('503');
    expect(document.paths['/vault-deletions/{vault_id}']?.get).toBeDefined();
    expect(document.paths['/vault-deletions/{vault_id}']?.get?.responses).toHaveProperty('401');
    expect(document.paths['/vault-deletions/{vault_id}']?.get?.responses).toHaveProperty('503');
    expect(document.paths['/vaults/{vault_id}']?.delete?.responses).toHaveProperty('401');
    expect(document.components.schemas).toHaveProperty('VaultDeletionStatus');
    expect(document.components.schemas).toHaveProperty('VaultDeletionListResponse');
    expect(document.components.schemas).toHaveProperty('VaultDeletionRequest');

    const legacyPush = document.paths['/vaults/{vault_id}/sync/push']?.post;
    const pull = document.paths['/vaults/{vault_id}/sync/pull']?.post;
    const pullChunk = document.paths['/vaults/{vault_id}/sync/pull-chunk']?.post;
    expect(legacyPush?.responses).toMatchObject({ '503': { $ref: '#/components/responses/TransferUnavailable' } });
    expect(pull?.responses).toMatchObject({ '503': { $ref: '#/components/responses/TransferUnavailable' } });
    expect(pullChunk?.responses).toMatchObject({ '503': { $ref: '#/components/responses/TransferUnavailable' } });
    expect(document.components).toHaveProperty('responses.TransferUnavailable');
    expect(contract).toContain('code `transfer_unavailable`');
    const transferCreate = document.paths['/vaults/{vault_id}/sync/push-transfers']?.post;
    const transferGet = document.paths['/vaults/{vault_id}/sync/push-transfers/{transfer_id}']?.get;
    const transferDelete = document.paths['/vaults/{vault_id}/sync/push-transfers/{transfer_id}']?.delete;
    const transferChunk = document.paths['/vaults/{vault_id}/sync/push-transfers/{transfer_id}/chunks/{chunk_index}']?.put;
    const transferFinalize = document.paths['/vaults/{vault_id}/sync/push-transfers/{transfer_id}/finalize']?.post;
    expect(Object.keys(transferCreate?.responses ?? {}).sort()).toEqual(['200', '201', '400', '404', '409', '413', '429', '503']);
    expect(Object.keys(transferGet?.responses ?? {}).sort()).toEqual(['200', '404', '409', '410', '503']);
    expect(Object.keys(transferChunk?.responses ?? {}).sort()).toEqual(['200', '400', '404', '409', '410', '413', '422', '503', '507']);
    expect(Object.keys(transferFinalize?.responses ?? {}).sort()).toEqual(['200', '202', '400', '404', '409', '503']);
    expect(Object.keys(transferDelete?.responses ?? {}).sort()).toEqual(['204', '404', '409', '410', '503']);
    const finalize200 = transferFinalize?.responses?.['200'] as { content?: { 'application/json'?: { schema?: unknown } } };
    expect(finalize200.content?.['application/json']?.schema).toMatchObject({
      oneOf: [
        { $ref: '#/components/schemas/PushOutcome' },
        { $ref: '#/components/schemas/ChunkPushDescriptor' }
      ]
    });
    expect(document.components.schemas).toEqual(expect.objectContaining({
      PushOutcome: expect.anything(),
      PushResult: expect.anything(),
      PushMergedResult: expect.anything(),
      PushConflictedResult: expect.anything(),
      DirectoryProposalAcknowledgement: expect.anything()
    }));
    expect(document.components.schemas.ChunkPushDescriptor).toMatchObject({
      properties: { result: { $ref: '#/components/schemas/PushResult' } }
    });
    expect(document.paths['/vaults/{vault_id}/devices/{device_id}']?.patch).toBeDefined();
    expect(document.paths['/device/self']?.patch?.security).toEqual([{ deviceBearer: [] }]);
    expect(document.components.schemas).toHaveProperty('ConnectionReviewResponse');
    expect(document.components.schemas).toHaveProperty('ConnectionBootstrapManifest');
    expect(document.components.schemas).toHaveProperty('DiagnosticEvent');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventFields');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventView');
    expect(document.components.schemas).toHaveProperty('DiagnosticEventsResponse');
    expect(document.components.schemas.DiagnosticEvent).toMatchObject({
      oneOf: [
        { $ref: '#/components/schemas/DiagnosticEventV1' },
        { $ref: '#/components/schemas/DiagnosticEventV2' }
      ]
    });
    expect(document.components.schemas.DiagnosticEventView).toMatchObject({
      oneOf: [
        { $ref: '#/components/schemas/DiagnosticEventV1View' },
        { $ref: '#/components/schemas/DiagnosticEventV2View' }
      ]
    });
    expect(document.components.schemas.DiagnosticEventV1).toMatchObject({ unevaluatedProperties: false });
    expect(document.components.schemas.DiagnosticEventV2).toMatchObject({ unevaluatedProperties: false });
    expect(document.components.schemas.TroubleshootingDiagnosticContext).toMatchObject({ additionalProperties: false });
    expect(document.components.schemas.TroubleshootingCursorRelations).toMatchObject({ additionalProperties: false });
    expect(document.paths['/connections/{connection_id}/diagnostic-events']?.post?.security).toEqual([{ connectionBearer: [] }]);
    expect(document.paths['/device/diagnostic-events']?.post?.security).toEqual([{ deviceBearer: [] }]);
    expect(contract).not.toContain('local_error_details');
    expect(contract).toContain('missing_buffer_dependency');
    expect(contract).toContain('invalid_json');
    expect(contract).toContain('operation_interrupted_by_reload');
    expect(contract).toContain('sync_lease_blocked');
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
    expect(contract).toContain('ConflictResolutionPreview');
    expect(contract).toContain('ConflictPreviewFile');
    expect(contract).toContain('ResolveConflictRequest');
    expect(contract).toContain('expected_tree');
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
      contract.indexOf('/vaults/{vault_id}/sync/pull-chunk')
    );
    expect(pullSection).toContain('multipart/form-data');
    expect(pullSection).toContain('DevicePullRequest');
    expect(pullSection).toContain('packfile');
    expect(pullSection).toContain('contentType: application/json');
    expect(pullSection).not.toContain('application/json:');
    expect(contract).toContain('current_local_main_is_ancestor');
    expect(contract).toContain('base_commit');
    expect(contract).toContain('/sync/capabilities');
    expect(contract).toContain('/vaults/{vault_id}/sync/push-transfers');
    expect(contract).toContain('/vaults/{vault_id}/sync/pull-chunk');
    expect(contract).toContain('git-object-pack-chunks-v1');
    expect(contract).toContain('directory-proposals-v2');
    expect(contract).toContain('DirectoryProposal');
    expect(contract).toContain('directory_acknowledgements');
    expect(contract).toContain('directory_conflicts');
    expect(contract).toContain('conflict_kind');

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
