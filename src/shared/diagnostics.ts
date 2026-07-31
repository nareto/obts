import { assertRecord, ValidationError } from './validators.js';

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const TROUBLESHOOTING_DIAGNOSTIC_SCHEMA_VERSION = 2 as const;
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
export const diagnosticFailureCodesV1 = [
  'invalid_json',
  'missing_buffer_dependency',
  'operation_interrupted_by_reload',
  'sync_lease_blocked',
  'null_pack_slice',
  'pack_index_failed',
  'adapter_read_failed',
  'adapter_write_failed',
  'adapter_stat_failed',
  'multipart_parse_failed',
  'request_failed',
  'onboarding_failed',
  'sync_failed',
  'directory_recovery_decision_required',
  'directory_recovery_changed',
  'directory_recovery_journal_invalid',
  'recovery_failed',
  'operation_stalled',
  'unknown'
] as const;
export const diagnosticFailureCodesV2 = ['troubleshooting_snapshot'] as const;
export const diagnosticFailureCodes = [...diagnosticFailureCodesV1, ...diagnosticFailureCodesV2] as const;
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
  'apply_recovery_prepare',
  'apply_preflight_revalidate',
  'apply_write',
  'apply_verify',
  'local_snapshot',
  'upload_prepare',
  'upload_finalize',
  'recovery',
  'startup_metadata',
  'startup_git',
  'startup_state',
  'recovery_journal',
  'recovery_target_commit',
  'recovery_target_tree',
  'recovery_file_validation',
  'recovery_bundle',
  'recovery_file_apply',
  'recovery_refs',
  'recovery_state'
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
export const troubleshootingTriggers = [
  'manual',
  'reconcile_start',
  'reconcile_guard',
  'reconcile_finish',
  'reconcile_failure'
] as const;
export const troubleshootingPhases = [
  'none',
  'requesting_server',
  'checking_guard',
  'applying',
  'finished',
  'failed'
] as const;
export const troubleshootingOutcomes = ['observed', 'succeeded', 'skipped', 'blocked', 'failed'] as const;
export const troubleshootingSafeErrorCodes = [
  'none',
  'device_blocked',
  'conflict_review_required',
  'server_recovery_required',
  'blocked_integrity',
  'device_revoked',
  'device_identity_mismatch',
  'not_paired',
  'sync_lease_blocked',
  'operation_interrupted_by_reload',
  'local_state_incomplete',
  'same_device_non_fast_forward',
  'apply_recovery_required',
  'directory_recovery_decision_required',
  'directory_recovery_changed',
  'directory_recovery_journal_invalid',
  'network_error',
  'http_error',
  'sync_error',
  'unknown'
] as const;
export const troubleshootingClientStates = ['uninitialized', 'initializing', 'ready', 'unloaded'] as const;
export const troubleshootingLeaseStates = ['available', 'owned_active', 'other_active', 'retiring', 'restart_required', 'unknown'] as const;
export const troubleshootingStateSources = ['primary', 'backup', 'default', 'unreadable'] as const;
export const troubleshootingStatusClasses = [
  'unpaired',
  'checking',
  'synced',
  'ahead',
  'behind',
  'review',
  'recovery',
  'unsafe',
  'retrying',
  'other'
] as const;
export const troubleshootingQueueStates = [
  'absent',
  'idle',
  'hint_only',
  'pending_upload',
  'conflicted',
  'invalid',
  'unreadable'
] as const;
export const troubleshootingJournalStates = [
  'absent',
  'planned',
  'recovery_bundle_written',
  'writing_files',
  'verifying',
  'committed',
  'blocked_recovery',
  'invalid',
  'unreadable'
] as const;
export const troubleshootingOnboardingStates = [
  'absent',
  'awaiting_browser',
  'approved',
  'analyzing',
  'awaiting_confirmation',
  'awaiting_conflict',
  'registered',
  'blocked',
  'complete',
  'other',
  'invalid',
  'unreadable'
] as const;
export const troubleshootingPresenceStates = ['absent', 'present', 'invalid', 'unreadable'] as const;
export const troubleshootingCursorGuardStates = [
  'not_observed',
  'no_preservation',
  'local_main',
  'local_head',
  'server_ref',
  'event_cursor',
  'multiple'
] as const;
export const troubleshootingGuardChecks = ['unchanged', 'changed', 'unknown'] as const;
export const troubleshootingReconcileGuards = [
  'not_observed',
  'unchanged',
  'timestamp_changed',
  'error_changed',
  'cursor_changed',
  'multiple'
] as const;
export const troubleshootingCursorRelations = [
  'both_null',
  'left_null',
  'right_null',
  'equal',
  'different',
  'unknown'
] as const;
export const troubleshootingSequenceRelations = ['equal', 'ahead', 'behind', 'invalid', 'unknown'] as const;
export const troubleshootingServerDeviceStatuses = [
  'not_observed',
  'paired',
  'synced',
  'ahead',
  'review_needed',
  'blocked_recovery',
  'revoked',
  'unknown'
] as const;
export const troubleshootingServerVaultStatuses = ['not_observed', 'active', 'blocked_integrity', 'unknown'] as const;
export const troubleshootingRequestOutcomes = ['not_attempted', 'succeeded', 'blocked', 'transport_failed', 'http_failed', 'failed'] as const;
export const troubleshootingHttpStatuses = [
  'none',
  'success',
  'http_400',
  'http_401',
  'http_403',
  'http_404',
  'http_409',
  'http_413',
  'http_429',
  'http_500',
  'http_502',
  'http_503',
  'http_504',
  'other_4xx',
  'other_5xx',
  'network',
  'unknown'
] as const;

export type DiagnosticPlatform = (typeof diagnosticPlatforms)[number];
export type DiagnosticFlow = (typeof diagnosticFlows)[number];
export type DiagnosticStage = (typeof diagnosticStages)[number];
export type DiagnosticFailureCodeV1 = (typeof diagnosticFailureCodesV1)[number];
export type DiagnosticFailureCodeV2 = (typeof diagnosticFailureCodesV2)[number];
export type DiagnosticFailureCode = DiagnosticFailureCodeV1 | DiagnosticFailureCodeV2;
export type DiagnosticErrorClass = (typeof diagnosticErrorClasses)[number];
export type DiagnosticPoint = (typeof diagnosticPoints)[number];
export type DiagnosticOutcome = (typeof diagnosticOutcomes)[number];
export type DiagnosticValueKind = (typeof diagnosticValueKinds)[number];
export type DiagnosticSizeBucket = (typeof diagnosticSizeBuckets)[number];
export type DiagnosticIoCode = (typeof diagnosticIoCodes)[number];
export type TroubleshootingTrigger = (typeof troubleshootingTriggers)[number];
export type TroubleshootingPhase = (typeof troubleshootingPhases)[number];
export type TroubleshootingOutcome = (typeof troubleshootingOutcomes)[number];
export type TroubleshootingSafeErrorCode = (typeof troubleshootingSafeErrorCodes)[number];
export type TroubleshootingCursorRelation = (typeof troubleshootingCursorRelations)[number];
export type TroubleshootingSequenceRelation = (typeof troubleshootingSequenceRelations)[number];

export type DiagnosticBreadcrumb = {
  point: DiagnosticPoint;
  outcome: DiagnosticOutcome;
  value_kind: DiagnosticValueKind;
  size_bucket: DiagnosticSizeBucket;
  error_code: DiagnosticIoCode;
};

type DiagnosticEventFields<TFailureCode extends DiagnosticFailureCode> = {
  event_id: string;
  plugin_version: string;
  obsidian_version: string;
  platform_family: DiagnosticPlatform;
  flow: DiagnosticFlow;
  stage: DiagnosticStage;
  failure_code: TFailureCode;
  error_class: DiagnosticErrorClass;
  retryable: boolean;
  breadcrumbs: DiagnosticBreadcrumb[];
};

export type DiagnosticEventV1 = DiagnosticEventFields<DiagnosticFailureCodeV1> & {
  schema_version: typeof DIAGNOSTIC_SCHEMA_VERSION;
};

export type TroubleshootingDiagnosticContext = {
  attempt_id: string;
  trigger: TroubleshootingTrigger;
  phase: TroubleshootingPhase;
  outcome: TroubleshootingOutcome;
  safe_error_code: TroubleshootingSafeErrorCode;
  client_state: (typeof troubleshootingClientStates)[number];
  lease_state: (typeof troubleshootingLeaseStates)[number];
  state_source: (typeof troubleshootingStateSources)[number];
  paired: boolean;
  status_class: (typeof troubleshootingStatusClasses)[number];
  queue_state: (typeof troubleshootingQueueStates)[number];
  apply_journal: (typeof troubleshootingJournalStates)[number];
  onboarding_journal: (typeof troubleshootingOnboardingStates)[number];
  transfer_journal: (typeof troubleshootingPresenceStates)[number];
  pending_applied_ack: (typeof troubleshootingPresenceStates)[number];
  cursor_guard: (typeof troubleshootingCursorGuardStates)[number];
  reconcile_guard: (typeof troubleshootingReconcileGuards)[number];
  reconcile_timestamp: (typeof troubleshootingGuardChecks)[number];
  reconcile_error: (typeof troubleshootingGuardChecks)[number];
  reconcile_cursors: (typeof troubleshootingGuardChecks)[number];
  server_device_status: (typeof troubleshootingServerDeviceStatuses)[number];
  server_vault_status: (typeof troubleshootingServerVaultStatuses)[number];
  request_outcome: (typeof troubleshootingRequestOutcomes)[number];
  http_status: (typeof troubleshootingHttpStatuses)[number];
  cursor_relations: {
    local_head_to_local_main: TroubleshootingCursorRelation;
    server_ref_to_local_head: TroubleshootingCursorRelation;
    local_main_to_server_main: TroubleshootingCursorRelation;
    event_to_applied: TroubleshootingSequenceRelation;
    event_to_server: TroubleshootingSequenceRelation;
  };
};

export type DiagnosticEventV2 = Omit<
  DiagnosticEventFields<DiagnosticFailureCodeV2>,
  'flow' | 'stage' | 'failure_code' | 'error_class' | 'retryable' | 'breadcrumbs'
> & {
  schema_version: typeof TROUBLESHOOTING_DIAGNOSTIC_SCHEMA_VERSION;
  flow: 'recovery';
  stage: 'recovery';
  failure_code: 'troubleshooting_snapshot';
  error_class: 'blocked_error' | 'unknown';
  retryable: false;
  breadcrumbs: [];
  context: TroubleshootingDiagnosticContext;
};

export type DiagnosticEvent = DiagnosticEventV1 | DiagnosticEventV2;

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
const EVENT_V2_KEYS = [...EVENT_KEYS, 'context'] as const;
const BREADCRUMB_KEYS = ['point', 'outcome', 'value_kind', 'size_bucket', 'error_code'] as const;
const TROUBLESHOOTING_CONTEXT_KEYS = [
  'attempt_id',
  'trigger',
  'phase',
  'outcome',
  'safe_error_code',
  'client_state',
  'lease_state',
  'state_source',
  'paired',
  'status_class',
  'queue_state',
  'apply_journal',
  'onboarding_journal',
  'transfer_journal',
  'pending_applied_ack',
  'cursor_guard',
  'reconcile_guard',
  'reconcile_timestamp',
  'reconcile_error',
  'reconcile_cursors',
  'server_device_status',
  'server_vault_status',
  'request_outcome',
  'http_status',
  'cursor_relations'
] as const;
const CURSOR_RELATION_KEYS = [
  'local_head_to_local_main',
  'server_ref_to_local_head',
  'local_main_to_server_main',
  'event_to_applied',
  'event_to_server'
] as const;
const EVENT_ID_PATTERN = /^dgr_[0-9a-f]{32}$/u;
const ATTEMPT_ID_PATTERN = /^(?:none|rca_[0-9a-f]{32})$/u;
const LEGACY_VERSION_PATTERN = /^(?:unknown|[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/u;
const TROUBLESHOOTING_VERSION_PATTERN = /^(?:unknown|[0-9]+(?:\.[0-9]+){1,3})$/u;

export function parseDiagnosticEvent(value: unknown): DiagnosticEvent {
  assertRecord(value);
  if (value.schema_version === DIAGNOSTIC_SCHEMA_VERSION) {
    assertExactKeys(value, EVENT_KEYS);
    return { schema_version: DIAGNOSTIC_SCHEMA_VERSION, ...parseEventFields(value, diagnosticFailureCodesV1) };
  }
  if (value.schema_version === TROUBLESHOOTING_DIAGNOSTIC_SCHEMA_VERSION) {
    assertExactKeys(value, EVENT_V2_KEYS);
    const fields = parseEventFields(value, diagnosticFailureCodesV2);
    return {
      ...fields,
      schema_version: TROUBLESHOOTING_DIAGNOSTIC_SCHEMA_VERSION,
      flow: 'recovery',
      stage: 'recovery',
      failure_code: 'troubleshooting_snapshot',
      error_class: fields.error_class as 'blocked_error' | 'unknown',
      retryable: false,
      breadcrumbs: [],
      context: parseTroubleshootingContext(value.context)
    };
  }
  throw new ValidationError('unsupported_diagnostic_schema', 'Unsupported diagnostic schema version.');
}

function parseEventFields<const T extends readonly DiagnosticFailureCode[]>(
  value: Record<string, unknown>,
  allowedFailureCodes: T
): DiagnosticEventFields<T[number]> {
  const eventId = readBoundedString(value, 'event_id', 40);
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new ValidationError('invalid_request', 'Invalid diagnostic event ID.');
  }
  if (typeof value.retryable !== 'boolean') {
    throw new ValidationError('invalid_request', 'retryable must be a boolean.');
  }
  if (!Array.isArray(value.breadcrumbs) || value.breadcrumbs.length > DIAGNOSTIC_MAX_BREADCRUMBS) {
    throw new ValidationError('invalid_request', 'breadcrumbs must be a bounded array.');
  }
  const flow = readEnum(value, 'flow', diagnosticFlows);
  const stage = readEnum(value, 'stage', diagnosticStages);
  const failureCode = readEnum(value, 'failure_code', allowedFailureCodes);
  const errorClass = readEnum(value, 'error_class', diagnosticErrorClasses);
  const breadcrumbs = value.breadcrumbs.map((item) => parseBreadcrumb(item));
  if (
    value.schema_version === TROUBLESHOOTING_DIAGNOSTIC_SCHEMA_VERSION &&
    (
      flow !== 'recovery' ||
      stage !== 'recovery' ||
      failureCode !== 'troubleshooting_snapshot' ||
      (errorClass !== 'blocked_error' && errorClass !== 'unknown') ||
      value.retryable ||
      breadcrumbs.length > 0
    )
  ) {
    throw new ValidationError('invalid_request', 'Invalid troubleshooting diagnostic envelope.');
  }
  return {
    event_id: eventId,
    plugin_version: readVersion(value, 'plugin_version', value.schema_version === DIAGNOSTIC_SCHEMA_VERSION),
    obsidian_version: readVersion(value, 'obsidian_version', value.schema_version === DIAGNOSTIC_SCHEMA_VERSION),
    platform_family: readEnum(value, 'platform_family', diagnosticPlatforms),
    flow,
    stage,
    failure_code: failureCode,
    error_class: errorClass,
    retryable: value.retryable,
    breadcrumbs
  };
}

function parseTroubleshootingContext(value: unknown): TroubleshootingDiagnosticContext {
  assertRecord(value);
  assertExactKeys(value, TROUBLESHOOTING_CONTEXT_KEYS);
  const attemptId = readBoundedString(value, 'attempt_id', 36);
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new ValidationError('invalid_request', 'Invalid troubleshooting attempt ID.');
  }
  if (typeof value.paired !== 'boolean') {
    throw new ValidationError('invalid_request', 'paired must be a boolean.');
  }
  assertRecord(value.cursor_relations);
  assertExactKeys(value.cursor_relations, CURSOR_RELATION_KEYS);
  return {
    attempt_id: attemptId,
    trigger: readEnum(value, 'trigger', troubleshootingTriggers),
    phase: readEnum(value, 'phase', troubleshootingPhases),
    outcome: readEnum(value, 'outcome', troubleshootingOutcomes),
    safe_error_code: readEnum(value, 'safe_error_code', troubleshootingSafeErrorCodes),
    client_state: readEnum(value, 'client_state', troubleshootingClientStates),
    lease_state: readEnum(value, 'lease_state', troubleshootingLeaseStates),
    state_source: readEnum(value, 'state_source', troubleshootingStateSources),
    paired: value.paired,
    status_class: readEnum(value, 'status_class', troubleshootingStatusClasses),
    queue_state: readEnum(value, 'queue_state', troubleshootingQueueStates),
    apply_journal: readEnum(value, 'apply_journal', troubleshootingJournalStates),
    onboarding_journal: readEnum(value, 'onboarding_journal', troubleshootingOnboardingStates),
    transfer_journal: readEnum(value, 'transfer_journal', troubleshootingPresenceStates),
    pending_applied_ack: readEnum(value, 'pending_applied_ack', troubleshootingPresenceStates),
    cursor_guard: readEnum(value, 'cursor_guard', troubleshootingCursorGuardStates),
    reconcile_guard: readEnum(value, 'reconcile_guard', troubleshootingReconcileGuards),
    reconcile_timestamp: readEnum(value, 'reconcile_timestamp', troubleshootingGuardChecks),
    reconcile_error: readEnum(value, 'reconcile_error', troubleshootingGuardChecks),
    reconcile_cursors: readEnum(value, 'reconcile_cursors', troubleshootingGuardChecks),
    server_device_status: readEnum(value, 'server_device_status', troubleshootingServerDeviceStatuses),
    server_vault_status: readEnum(value, 'server_vault_status', troubleshootingServerVaultStatuses),
    request_outcome: readEnum(value, 'request_outcome', troubleshootingRequestOutcomes),
    http_status: readEnum(value, 'http_status', troubleshootingHttpStatuses),
    cursor_relations: {
      local_head_to_local_main: readEnum(value.cursor_relations, 'local_head_to_local_main', troubleshootingCursorRelations),
      server_ref_to_local_head: readEnum(value.cursor_relations, 'server_ref_to_local_head', troubleshootingCursorRelations),
      local_main_to_server_main: readEnum(value.cursor_relations, 'local_main_to_server_main', troubleshootingCursorRelations),
      event_to_applied: readEnum(value.cursor_relations, 'event_to_applied', troubleshootingSequenceRelations),
      event_to_server: readEnum(value.cursor_relations, 'event_to_server', troubleshootingSequenceRelations)
    }
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

function readVersion(record: Record<string, unknown>, key: string, allowLegacySuffix: boolean): string {
  const value = readBoundedString(record, key, 80);
  const pattern = allowLegacySuffix ? LEGACY_VERSION_PATTERN : TROUBLESHOOTING_VERSION_PATTERN;
  if (!pattern.test(value)) {
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
