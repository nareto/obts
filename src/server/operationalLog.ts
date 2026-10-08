import type { FastifyReply, FastifyRequest } from 'fastify';

import packageJson from '../../package.json' with { type: 'json' };
import type { ConflictResolutionKind, PushResult } from '../shared/types.js';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'silent'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
type EmittedLevel = Exclude<LogLevel, 'silent'>;
export type LogSink = (line: string) => void;
export const MAX_LOG_LINE_BYTES = 4096;

export const STARTUP_PHASES = [
  'metadata_initialized', 'deletions_reconciled', 'receipts_expired', 'root_commits_populated',
  'operations_reconciled', 'conflict_refs_protected', 'integrity_scanned', 'diagnostics_initialized',
  'transfers_initialized', 'pending_jobs_started', 'pending_merges_resumed'
] as const;
export type StartupPhase = typeof STARTUP_PHASES[number];
export const BACKGROUND_TASKS = [
  'diagnostic_prune', 'receipt_expiry', 'pending_deletion', 'deletion_retry_record', 'transfer_processing'
] as const;
type BackgroundTask = typeof BACKGROUND_TASKS[number];
export const LOG_EVENTS = [
  'http_request', 'server_listening', 'startup_phase', 'vault_integrity_blocked',
  'push_integrated', 'conflict_created', 'conflict_resolved', 'background_task_failed'
] as const;
type LogEvent = typeof LOG_EVENTS[number];

export type OperationalFields = {
  request_id?: string;
  method?: string;
  route?: string | null;
  status?: number | null;
  duration_ms?: number;
  outcome?: 'ok' | 'client_error' | 'server_error' | 'aborted';
  vault_id?: string;
  device_id?: string;
  user_id?: string;
  connection_id?: string;
  transfer_id?: string;
  conflict_id?: string;
  plugin_version?: string;
  error_code?: string;
  error_class?: string;
  stack?: string;
  push_status?: PushResult['status'] | 'processing';
  event_seq?: number;
  directory_ack?: 'accepted' | 'conflicted' | 'duplicate';
  attempt_id?: string;
  chunk_count?: number;
  chunk_index?: number;
  complete?: boolean;
  target?: 'latest' | 'explicit';
  reported_status?: 'idle' | 'queued_local' | 'uploading' | 'merged' | 'conflicted' | 'blocked_recovery' | 'unknown' | null;
  resolution?: ConflictResolutionKind;
  failed_checks?: string;
  host?: string;
  port?: number;
  log_level?: LogLevel;
  phase?: StartupPhase;
  source?: 'startup' | 'request';
  task?: BackgroundTask;
};

export const LOG_ROUTES = [
  '/api/v1/*',
  '/api/v1/sync/capabilities',
  '/health/live',
  '/health/ready',
  '/api/v1/setup/status',
  '/api/v1/setup',
  '/api/v1/auth/login',
  '/api/v1/auth/reauthenticate',
  '/api/v1/auth/session',
  '/api/v1/auth/logout',
  '/api/v1/auth/password-reset',
  '/api/v1/admin/users',
  '/api/v1/admin/users/:userId/disable',
  '/api/v1/admin/users/:userId/enable',
  '/api/v1/admin/users/:userId/grant-admin',
  '/api/v1/admin/users/:userId/revoke-admin',
  '/api/v1/admin/users/:userId/password-reset-tokens',
  '/api/v1/vaults',
  '/api/v1/diagnostic-events',
  '/api/v1/vault-deletions',
  '/api/v1/vault-deletions/:vaultId',
  '/api/v1/vaults/:vaultId',
  '/api/v1/vaults/:vaultId/sync-settings',
  '/api/v1/vaults/:vaultId/sync-settings/preview',
  '/api/v1/vaults/:vaultId/main',
  '/api/v1/vaults/:vaultId/dashboard',
  '/api/v1/connections',
  '/api/v1/connections/:connectionId',
  '/api/v1/connections/:connectionId/review',
  '/api/v1/connections/:connectionId/approve',
  '/api/v1/connections/:connectionId/deny',
  '/api/v1/connections/:connectionId/bootstrap',
  '/api/v1/connections/:connectionId/bootstrap-chunk',
  '/api/v1/connections/:connectionId/diagnostic-events',
  '/api/v1/connections/:connectionId/complete',
  '/api/v1/vaults/:vaultId/devices/:deviceId',
  '/api/v1/vaults/:vaultId/devices/:deviceId/revoke',
  '/api/v1/device/self',
  '/api/v1/device/diagnostic-events',
  '/api/v1/vaults/:vaultId/sync/push-transfers',
  '/api/v1/vaults/:vaultId/sync/push-transfers/:transferId',
  '/api/v1/vaults/:vaultId/sync/push-transfers/:transferId/chunks/:chunkIndex',
  '/api/v1/vaults/:vaultId/sync/push-transfers/:transferId/finalize',
  '/api/v1/vaults/:vaultId/sync/push',
  '/api/v1/vaults/:vaultId/sync/pull-chunk',
  '/api/v1/vaults/:vaultId/sync/pull',
  '/api/v1/vaults/:vaultId/sync/events',
  '/api/v1/vaults/:vaultId/sync/device-status',
  '/api/v1/vaults/:vaultId/sync/applied',
  '/api/v1/vaults/:vaultId/onboarding/complete',
  '/api/v1/vaults/:vaultId/sync/unpair',
  '/api/v1/vaults/:vaultId/conflicts',
  '/api/v1/vaults/:vaultId/conflicts/:conflictId',
  '/api/v1/vaults/:vaultId/conflicts/:conflictId/refresh',
  '/api/v1/vaults/:vaultId/conflicts/:conflictId/preview',
  '/api/v1/vaults/:vaultId/conflicts/:conflictId/resolve',
  '/api/v1/vaults/:vaultId/history/query',
  '/api/v1/vaults/:vaultId/history/version',
  '/api/v1/vaults/:vaultId/diagnostics/export',
  '/api/v1/vaults/:vaultId/history/restore',
  '/api/v1/vaults/:vaultId/maintenance/git-gc/start',
  '/api/v1/vaults/:vaultId/events',
  '/', '/dashboard', '/dashboard/*', '/connect/:connectionId', '/assets/*'
] as const;

const CHECK_NAMES = [
  'metadata', 'metadata_store', 'git', 'setup_complete', 'migrations', 'git_store',
  'temp_workspace', 'filesystem_permissions', 'event_delivery', 'persistent_state'
];
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const OPAQUE_ID = /^[a-z]+_[A-Za-z0-9_-]{1,64}$/u;
const VERSION = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/u;
const OID = /[0-9a-f]{40}/iu;
type Validator = (value: unknown) => boolean;
const enumeration = (values: readonly string[]): Validator => (value) => typeof value === 'string' && values.includes(value);
const pattern = (regex: RegExp): Validator => (value) => typeof value === 'string' && regex.test(value);
const number: Validator = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullable = (validator: Validator): Validator => (value) => value === null || validator(value);
const id = (prefix: string): Validator => (value) => typeof value === 'string' && value.startsWith(`${prefix}_`) && OPAQUE_ID.test(value);
const FIELD_VALIDATORS: Record<keyof OperationalFields, Validator> = {
  request_id: id('req'), method: enumeration(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']),
  route: nullable(enumeration(LOG_ROUTES)), status: nullable(number), duration_ms: number,
  outcome: enumeration(['ok', 'client_error', 'server_error', 'aborted']),
  vault_id: id('vlt'), device_id: id('dev'), user_id: id('usr'), connection_id: id('con'),
  transfer_id: id('trn'), conflict_id: id('conf'), plugin_version: (value) => value === 'unknown' || pattern(VERSION)(value),
  error_code: pattern(CODE), error_class: pattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  stack: pattern(/^frame:\d{1,7}:\d{1,7}(?:,frame:\d{1,7}:\d{1,7}){0,7}$/u),
  push_status: enumeration(['noop', 'merged', 'conflicted', 'rejected', 'processing']), event_seq: number,
  directory_ack: enumeration(['accepted', 'conflicted', 'duplicate']), attempt_id: pattern(OPAQUE_ID),
  chunk_count: number, chunk_index: number, complete: (value) => typeof value === 'boolean',
  target: enumeration(['latest', 'explicit']),
  reported_status: nullable(enumeration(['idle', 'queued_local', 'uploading', 'merged', 'conflicted', 'blocked_recovery', 'unknown'])),
  resolution: enumeration(['keep_server', 'use_device', 'keep_both_files', 'insert_both_blocks', 'manual']),
  failed_checks: (value) => typeof value === 'string' && value.split(',').every((name) => CHECK_NAMES.includes(name)),
  host: pattern(/^[A-Za-z0-9.:_-]{1,253}$/u), port: number, log_level: enumeration(LOG_LEVELS),
  phase: enumeration(STARTUP_PHASES), source: enumeration(['startup', 'request']), task: enumeration(BACKGROUND_TASKS)
};
export const LOG_FIELD_ALLOWLIST = ['ts', 'level', 'event', 'service', 'version', ...Object.keys(FIELD_VALIDATORS)];

function sanitize(fields: OperationalFields): OperationalFields {
  const result: Record<string, unknown> = {};
  for (const [key, validator] of Object.entries(FIELD_VALIDATORS)) {
    const value = fields[key as keyof OperationalFields];
    if (typeof value === 'string' && (value.length > 256 || OID.test(value))) continue;
    if (validator(value)) result[key] = value;
  }
  return result as OperationalFields;
}

let stdoutObserved = false;
export function operationalStdout(line: string): void {
  try {
    if (!stdoutObserved) {
      process.stdout.on('error', () => undefined);
      stdoutObserved = true;
    }
    if (!process.stdout.destroyed && !process.stdout.writableNeedDrain) process.stdout.write(line);
  } catch {}
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error('OBTS_LOG_LEVEL must be error, warn, info, debug, or silent.');
}

export class OperationalLog {
  constructor(readonly level: LogLevel = 'silent', private readonly sink: LogSink = operationalStdout) {}

  emit(level: EmittedLevel, event: LogEvent, fields: OperationalFields = {}): void {
    try {
      if (this.level === 'silent' || LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(this.level) ||
          !LOG_EVENTS.includes(event) || !LOG_LEVELS.includes(level)) return;
      const line = `${JSON.stringify({
        ts: new Date().toISOString(), level, event, service: 'obts-server', version: packageJson.version,
        ...sanitize(fields)
      })}\n`;
      if (Buffer.byteLength(line, 'utf8') <= MAX_LOG_LINE_BYTES) {
        const result: unknown = this.sink(line);
        if (result instanceof Promise) void result.catch(() => undefined);
      }
    } catch {}
  }

  backgroundFailure(task: BackgroundTask, error: unknown): void {
    this.emit('warn', 'background_task_failed', { task, ...safeErrorFields(error) });
  }

  async startup<T>(phase: StartupPhase, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const result = await action();
    this.emit('info', 'startup_phase', { phase, duration_ms: Date.now() - started });
    return result;
  }
}

export const silentOperationalLog = new OperationalLog();

export function safeReportedPluginVersion(version: string): string {
  return VERSION.test(version) ? version : 'unknown';
}

export function safeErrorFields(error: unknown): Pick<OperationalFields, 'error_class' | 'stack'> {
  try {
    if (!(error instanceof Error)) return {};
    const errorClass = error.constructor.name;
    // Retain frame positions only: V8 frame text also carries filenames and can contain error messages.
    const frames = (error.stack ?? '').slice(0, 16_384).split('\n').slice(1, 33).filter((line) => /^\s+at /u.test(line))
      .map((line) => line.match(/:(\d{1,7}):(\d{1,7})\)?$/u))
      .filter((match) => match !== null).slice(0, 8).map((match) => `frame:${match[1]}:${match[2]}`);
    return {
      ...(FIELD_VALIDATORS.error_class(errorClass) && !OID.test(errorClass) ? { error_class: errorClass } : {}),
      ...(frames.length ? { stack: frames.join(',') } : {})
    };
  } catch { return {}; }
}

export function pushLogFields(result: PushResult): OperationalFields {
  return result.status === 'rejected'
    ? { push_status: result.status, error_code: result.code }
    : {
        push_status: result.status, event_seq: result.event_seq,
        ...(result.status === 'conflicted' ? { conflict_id: result.conflict_id } : {}),
        ...(result.directory_ack ? { directory_ack: result.directory_ack.status } : {})
      };
}

const DEBUG_READ_ROUTES = new Set<string>([
  '/health/live', '/health/ready', '/', '/dashboard', '/dashboard/*', '/assets/*', '/connect/:connectionId'
]);
const DEBUG_EVENT_ROUTES = new Set<string>([
  '/api/v1/vaults/:vaultId/sync/events', '/api/v1/vaults/:vaultId/events'
]);
type RequestClassification = { method: string; route: string | null; status: number | null };
export const REQUEST_LEVEL_TABLE: ReadonlyArray<{
  match: string;
  level: EmittedLevel;
  matches: (request: RequestClassification) => boolean;
}> = [
  { match: 'readiness non-200', level: 'warn', matches: ({ route, status }) => route === '/health/ready' && status !== null && status !== 200 },
  { match: 'other 5xx', level: 'error', matches: ({ status }) => status !== null && status >= 500 },
  { match: 'successful GET/HEAD health, dashboard/static; GET event polling; PUT push chunk', level: 'debug',
    matches: ({ method, route, status }) => status !== null && status < 400 && route !== null &&
      ((method === 'GET' || method === 'HEAD') && DEBUG_READ_ROUTES.has(route) ||
       method === 'GET' && DEBUG_EVENT_ROUTES.has(route) || method === 'PUT' &&
       route === '/api/v1/vaults/:vaultId/sync/push-transfers/:transferId/chunks/:chunkIndex') },
  { match: 'unmatched 404', level: 'debug', matches: ({ route, status }) => route === null && status === 404 },
  { match: 'all other requests (including aborts and 4xx)', level: 'info', matches: () => true }
];
function requestLevel(method: string, route: string | null, status: number | null): EmittedLevel {
  return REQUEST_LEVEL_TABLE.find((rule) => rule.matches({ method, route, status }))!.level;
}

export class RequestLogContext {
  private readonly contexts = new WeakMap<FastifyRequest, { fields: OperationalFields; emitted: boolean; started: number }>();
  constructor(private readonly log: OperationalLog) {}

  annotate(request: FastifyRequest, fields: OperationalFields): void {
    try {
      let context = this.contexts.get(request);
      if (!context) {
        context = { fields: {}, emitted: false, started: Date.now() };
        this.contexts.set(request, context);
      }
      Object.assign(context.fields, sanitize(fields));
    } catch {}
  }

  observeErrorPayload(request: FastifyRequest, reply: FastifyReply, payload: unknown): void {
    try {
      if (reply.statusCode < 400 || typeof payload !== 'string' || payload.length > 8192 || Buffer.byteLength(payload) > 8192) return;
      const code: unknown = JSON.parse(payload)?.error?.code;
      if (typeof code === 'string' && CODE.test(code)) this.annotate(request, { error_code: code });
    } catch {}
  }

  completed(request: FastifyRequest, reply?: FastifyReply): void {
    try {
      this.annotate(request, {});
      const context = this.contexts.get(request)!;
      if (context.emitted) return;
      context.emitted = true;
      const route = (LOG_ROUTES as readonly string[]).includes(request.routeOptions.url ?? '') ? request.routeOptions.url! : null;
      const aborted = reply === undefined;
      const status = reply?.statusCode ?? null;
      this.log.emit(requestLevel(request.method, route, status), 'http_request', {
        ...context.fields,
        ...(status === 404 && route === null && !context.fields.error_code ? { error_code: 'not_found' } : {}),
        request_id: request.id, method: request.method, route, status,
        duration_ms: Math.round(reply?.elapsedTime ?? Date.now() - context.started),
        outcome: aborted ? 'aborted' : status! >= 500 ? 'server_error' : status! >= 400 ? 'client_error' : 'ok'
      });
    } catch {}
  }
}
