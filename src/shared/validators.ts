import { API_VERSION, type DevicePullRequest, type DevicePushManifest, type SyncProfile } from './types.js';

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class ValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function assertRecord(value: unknown, code = 'invalid_request'): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(code, 'Expected a JSON object.');
  }
}

export function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('invalid_request', `Missing or invalid field: ${field}.`, { field });
  }
  return value;
}

export function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('invalid_request', `Invalid field: ${field}.`, { field });
  }
  return value;
}

export function readNullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_request', `Invalid field: ${field}.`, { field });
  }
  return value;
}

export function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('invalid_request', `Missing or invalid field: ${field}.`, { field });
  }
  return value;
}

export function readNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = readNumber(record, field);
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError('invalid_request', `Invalid field: ${field}.`, { field });
  }
  return value;
}

export function readOptionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ValidationError('invalid_request', `Invalid field: ${field}.`, { field });
  }
  return value;
}

export function readSyncProfile(record: Record<string, unknown>, field: string): SyncProfile {
  const value = readString(record, field);
  if (value !== 'notes_only' && value !== 'notes_plus_attachments' && value !== 'full_vault_config') {
    throw new ValidationError('invalid_request', `Invalid sync profile: ${field}.`, { field });
  }
  return value;
}

export function readCommitId(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (!COMMIT_ID_PATTERN.test(value)) {
    throw new ValidationError('invalid_request', `Invalid commit ID: ${field}.`, { field });
  }
  return value;
}

export function readNullableCommitId(record: Record<string, unknown>, field: string): string | null {
  const value = readNullableString(record, field);
  if (value !== null && !COMMIT_ID_PATTERN.test(value)) {
    throw new ValidationError('invalid_request', `Invalid commit ID: ${field}.`, { field });
  }
  return value;
}

export function readSha256(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (!SHA256_PATTERN.test(value)) {
    throw new ValidationError('invalid_request', `Invalid SHA-256 digest: ${field}.`, { field });
  }
  return value;
}

export function parseDevicePushManifest(value: unknown): DevicePushManifest {
  assertRecord(value);
  const apiVersion = readString(value, 'api_version');
  if (apiVersion !== API_VERSION) {
    throw new ValidationError('unsupported_client', 'Unsupported client API version.');
  }
  const manifest: DevicePushManifest = {
    api_version: API_VERSION,
    vault_id: readString(value, 'vault_id'),
    device_id: readString(value, 'device_id'),
    expected_device_ref: readNullableCommitId(value, 'expected_device_ref'),
    target_commit: readCommitId(value, 'target_commit'),
    packfile_sha256: readSha256(value, 'packfile_sha256'),
    packfile_bytes: readNonNegativeInteger(value, 'packfile_bytes'),
    client_known_main: readNullableCommitId(value, 'client_known_main')
  };
  const attemptId = readOptionalString(value, 'attempt_id');
  return attemptId === undefined ? manifest : { ...manifest, attempt_id: attemptId };
}

export function parseDevicePullRequest(value: unknown): DevicePullRequest {
  assertRecord(value);
  const apiVersion = readString(value, 'api_version');
  if (apiVersion !== API_VERSION) {
    throw new ValidationError('unsupported_client', 'Unsupported client API version.');
  }
  const requested = readString(value, 'requested_target');
  if (requested !== 'latest' && !COMMIT_ID_PATTERN.test(requested)) {
    throw new ValidationError('invalid_request', 'Invalid requested target.', { field: 'requested_target' });
  }
  return {
    api_version: API_VERSION,
    vault_id: readString(value, 'vault_id'),
    device_id: readString(value, 'device_id'),
    current_local_main: readNullableCommitId(value, 'current_local_main'),
    requested_target: requested
  };
}

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    assertRecord(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError('invalid_json', 'Expected valid JSON.');
  }
}
