import { isSyncableVaultPath, normalizeVaultPath } from './pathPolicy.js';
import {
  API_VERSION,
  type ChunkBootstrapRequest,
  type ChunkPullRequest,
  type ChunkPushCreateRequest,
  type DevicePullRequest,
  type DevicePushManifest,
  type DirectoryIntent
} from './types.js';

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
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    throw new ValidationError('invalid_request', `Missing field: ${field}.`, { field });
  }
  const value = record[field];
  if (value === null || value === '') {
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
  const pluginVersion = readOptionalString(value, 'plugin_version');
  const baseCommit = Object.prototype.hasOwnProperty.call(value, 'base_commit')
    ? readNullableCommitId(value, 'base_commit')
    : undefined;
  const attemptId = readOptionalString(value, 'attempt_id');
  const directoryIntents = readOptionalDirectoryIntents(value, 'directory_intents');
  return {
    ...manifest,
    ...(pluginVersion === undefined ? {} : { plugin_version: pluginVersion }),
    ...(baseCommit === undefined ? {} : { base_commit: baseCommit }),
    ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
    ...(directoryIntents === undefined ? {} : { directory_intents: directoryIntents })
  };
}

function readOptionalDirectoryIntents(record: Record<string, unknown>, field: string): DirectoryIntent[] | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ValidationError('invalid_request', `Invalid field: ${field}.`, { field });
  }
  if (value.length > 5000) {
    throw new ValidationError('invalid_request', `Too many directory intents: ${field}.`, { field });
  }
  const intents: DirectoryIntent[] = [];
  for (const item of value) {
    assertRecord(item);
    const op = readString(item, 'op');
    if (op !== 'create' && op !== 'delete') {
      throw new ValidationError('invalid_request', 'Invalid directory intent operation.', { field: 'op' });
    }
    const normalized = normalizeVaultPath(readString(item, 'path'));
    if (!normalized.ok || !isSyncableVaultPath(normalized.path)) {
      throw new ValidationError('invalid_request', 'Invalid directory intent path.', { field: 'path' });
    }
    intents.push({ op, path: normalized.path });
  }
  return compactDirectoryIntents(intents);
}

function compactDirectoryIntents(intents: DirectoryIntent[]): DirectoryIntent[] {
  const byPath = new Map<string, DirectoryIntent>();
  for (const intent of intents) {
    if (intent.op === 'delete') {
      for (const path of [...byPath.keys()]) {
        if (path === intent.path || path.startsWith(`${intent.path}/`)) {
          byPath.delete(path);
        }
      }
    }
    byPath.set(intent.path, intent);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path) || left.op.localeCompare(right.op));
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
  const pluginVersion = readOptionalString(value, 'plugin_version');
  const currentEventSeq = Object.prototype.hasOwnProperty.call(value, 'current_event_seq')
    ? readNonNegativeInteger(value, 'current_event_seq')
    : undefined;
  return {
    api_version: API_VERSION,
    ...(pluginVersion === undefined ? {} : { plugin_version: pluginVersion }),
    vault_id: readString(value, 'vault_id'),
    device_id: readString(value, 'device_id'),
    current_local_main: readNullableCommitId(value, 'current_local_main'),
    requested_target: requested,
    ...(currentEventSeq === undefined ? {} : { current_event_seq: currentEventSeq })
  };
}

export function parseChunkPushCreateRequest(value: unknown): ChunkPushCreateRequest {
  assertRecord(value);
  const apiVersion = readString(value, 'api_version');
  if (apiVersion !== API_VERSION) throw new ValidationError('unsupported_client', 'Unsupported client API version.');
  const attemptId = readString(value, 'attempt_id');
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(attemptId)) {
    throw new ValidationError('invalid_request', 'Invalid attempt ID.', { field: 'attempt_id' });
  }
  const planSha256 = readSha256(value, 'plan_sha256');
  const chunkCount = readNonNegativeInteger(value, 'chunk_count');
  if (chunkCount < 1 || chunkCount > 4096) {
    throw new ValidationError('invalid_request', 'Invalid chunk count.', { field: 'chunk_count' });
  }
  const pluginVersion = readOptionalString(value, 'plugin_version');
  const baseCommit = Object.prototype.hasOwnProperty.call(value, 'base_commit')
    ? readNullableCommitId(value, 'base_commit')
    : undefined;
  const directoryIntents = readOptionalDirectoryIntents(value, 'directory_intents');
  return {
    api_version: API_VERSION,
    ...(pluginVersion === undefined ? {} : { plugin_version: pluginVersion }),
    vault_id: readString(value, 'vault_id'),
    device_id: readString(value, 'device_id'),
    expected_device_ref: readNullableCommitId(value, 'expected_device_ref'),
    target_commit: readCommitId(value, 'target_commit'),
    client_known_main: readNullableCommitId(value, 'client_known_main'),
    ...(baseCommit === undefined ? {} : { base_commit: baseCommit }),
    ...(directoryIntents === undefined ? {} : { directory_intents: directoryIntents }),
    attempt_id: attemptId,
    chunk_count: chunkCount,
    plan_sha256: planSha256
  };
}

export function parseChunkPullRequest(value: unknown): ChunkPullRequest {
  const base = parseDevicePullRequest(value);
  assertRecord(value);
  return { ...base, cursor: readNonNegativeInteger(value, 'cursor') };
}

export function parseChunkBootstrapRequest(value: unknown): ChunkBootstrapRequest {
  assertRecord(value);
  const apiVersion = readString(value, 'api_version');
  if (apiVersion !== API_VERSION) throw new ValidationError('unsupported_client', 'Unsupported client API version.');
  const requested = readString(value, 'requested_target');
  if (requested !== 'latest' && !COMMIT_ID_PATTERN.test(requested)) {
    throw new ValidationError('invalid_request', 'Invalid requested target.', { field: 'requested_target' });
  }
  const pluginVersion = readOptionalString(value, 'plugin_version');
  return {
    api_version: API_VERSION,
    ...(pluginVersion === undefined ? {} : { plugin_version: pluginVersion }),
    cursor: readNonNegativeInteger(value, 'cursor'),
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
