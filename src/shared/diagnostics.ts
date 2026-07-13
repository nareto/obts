import { assertRecord, ValidationError } from './validators.js';

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_MAX_BODY_BYTES = 8 * 1024;
export const DIAGNOSTIC_MAX_BREADCRUMBS = 16;

export const diagnosticPlatforms = ['ios', 'android', 'desktop', 'unknown'] as const;
export const diagnosticFlows = ['onboarding', 'sync', 'apply', 'recovery', 'rebuild', 'plugin'] as const;
export const diagnosticStages = [
  'browser_handoff',
  'approval_poll',
  'bootstrap_request',
  'multipart_parse',
  'pack_persist',
  'pack_index',
  'tree_read',
  'sync_request',
  'apply',
  'recovery',
  'plugin_lifecycle',
  'unknown'
] as const;
export const diagnosticFailureCodes = [
  'null_pack_slice',
  'pack_index_failed',
  'adapter_read_failed',
  'adapter_write_failed',
  'adapter_stat_failed',
  'multipart_parse_failed',
  'request_failed',
  'onboarding_failed',
  'sync_failed',
  'recovery_failed',
  'unknown'
] as const;
export const diagnosticErrorClasses = ['type_error', 'transport_error', 'blocked_error', 'error', 'unknown'] as const;
export const diagnosticPoints = [
  'onboarding_approved',
  'bootstrap_response',
  'multipart_pack',
  'pack_persist_write',
  'pack_persist_read',
  'index_fs_stat',
  'index_fs_read_file',
  'index_fs_read',
  'index_fs_write',
  'index_pack',
  'sync_request',
  'apply',
  'recovery'
] as const;
export const diagnosticOutcomes = ['started', 'returned', 'succeeded', 'failed'] as const;
export const diagnosticValueKinds = ['buffer', 'uint8array', 'arraybuffer', 'string', 'null', 'other', 'unknown'] as const;
export const diagnosticSizeBuckets = ['empty', 'under_64k', 'under_1m', 'under_16m', 'under_64m', 'over_64m', 'unknown'] as const;
export const diagnosticIoCodes = [
  'none',
  'enoent',
  'eexist',
  'eisdir',
  'enotdir',
  'enotempty',
  'eacces',
  'eperm',
  'eio',
  'invalid_type',
  'unknown'
] as const;

export type DiagnosticPlatform = (typeof diagnosticPlatforms)[number];
export type DiagnosticFlow = (typeof diagnosticFlows)[number];
export type DiagnosticStage = (typeof diagnosticStages)[number];
export type DiagnosticFailureCode = (typeof diagnosticFailureCodes)[number];
export type DiagnosticErrorClass = (typeof diagnosticErrorClasses)[number];
export type DiagnosticPoint = (typeof diagnosticPoints)[number];
export type DiagnosticOutcome = (typeof diagnosticOutcomes)[number];
export type DiagnosticValueKind = (typeof diagnosticValueKinds)[number];
export type DiagnosticSizeBucket = (typeof diagnosticSizeBuckets)[number];
export type DiagnosticIoCode = (typeof diagnosticIoCodes)[number];

export type DiagnosticBreadcrumb = {
  point: DiagnosticPoint;
  outcome: DiagnosticOutcome;
  value_kind: DiagnosticValueKind;
  size_bucket: DiagnosticSizeBucket;
  error_code: DiagnosticIoCode;
};

export type DiagnosticEventV1 = {
  schema_version: typeof DIAGNOSTIC_SCHEMA_VERSION;
  event_id: string;
  plugin_version: string;
  obsidian_version: string;
  platform_family: DiagnosticPlatform;
  flow: DiagnosticFlow;
  stage: DiagnosticStage;
  failure_code: DiagnosticFailureCode;
  error_class: DiagnosticErrorClass;
  retryable: boolean;
  breadcrumbs: DiagnosticBreadcrumb[];
};

const EVENT_KEYS = [
  'schema_version',
  'event_id',
  'plugin_version',
  'obsidian_version',
  'platform_family',
  'flow',
  'stage',
  'failure_code',
  'error_class',
  'retryable',
  'breadcrumbs'
] as const;
const BREADCRUMB_KEYS = ['point', 'outcome', 'value_kind', 'size_bucket', 'error_code'] as const;
const EVENT_ID_PATTERN = /^dgr_[0-9a-f]{32}$/u;
const VERSION_PATTERN = /^(?:unknown|[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u;

export function parseDiagnosticEvent(value: unknown): DiagnosticEventV1 {
  assertRecord(value);
  assertExactKeys(value, EVENT_KEYS);
  if (value.schema_version !== DIAGNOSTIC_SCHEMA_VERSION) {
    throw new ValidationError('unsupported_diagnostic_schema', 'Unsupported diagnostic schema version.');
  }
  const eventId = readBoundedString(value, 'event_id', 40);
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new ValidationError('invalid_request', 'Invalid diagnostic event ID.');
  }
  const pluginVersion = readVersion(value, 'plugin_version');
  const obsidianVersion = readVersion(value, 'obsidian_version');
  if (typeof value.retryable !== 'boolean') {
    throw new ValidationError('invalid_request', 'retryable must be a boolean.');
  }
  if (!Array.isArray(value.breadcrumbs) || value.breadcrumbs.length > DIAGNOSTIC_MAX_BREADCRUMBS) {
    throw new ValidationError('invalid_request', 'breadcrumbs must be a bounded array.');
  }
  return {
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    event_id: eventId,
    plugin_version: pluginVersion,
    obsidian_version: obsidianVersion,
    platform_family: readEnum(value, 'platform_family', diagnosticPlatforms),
    flow: readEnum(value, 'flow', diagnosticFlows),
    stage: readEnum(value, 'stage', diagnosticStages),
    failure_code: readEnum(value, 'failure_code', diagnosticFailureCodes),
    error_class: readEnum(value, 'error_class', diagnosticErrorClasses),
    retryable: value.retryable,
    breadcrumbs: value.breadcrumbs.map((item) => parseBreadcrumb(item))
  };
}

export function diagnosticPayloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function parseBreadcrumb(value: unknown): DiagnosticBreadcrumb {
  assertRecord(value);
  assertExactKeys(value, BREADCRUMB_KEYS);
  return {
    point: readEnum(value, 'point', diagnosticPoints),
    outcome: readEnum(value, 'outcome', diagnosticOutcomes),
    value_kind: readEnum(value, 'value_kind', diagnosticValueKinds),
    size_bucket: readEnum(value, 'size_bucket', diagnosticSizeBuckets),
    error_code: readEnum(value, 'error_code', diagnosticIoCodes)
  };
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError('invalid_request', `Unknown field: ${key}.`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError('invalid_request', `Missing field: ${key}.`);
    }
  }
}

function readBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ValidationError('invalid_request', `Invalid field: ${key}.`);
  }
  return value;
}

function readVersion(record: Record<string, unknown>, key: string): string {
  const value = readBoundedString(record, key, 80);
  if (!VERSION_PATTERN.test(value)) {
    throw new ValidationError('invalid_request', `Invalid field: ${key}.`);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(record: Record<string, unknown>, key: string, values: T): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ValidationError('invalid_request', `Invalid field: ${key}.`);
  }
  return value as T[number];
}
