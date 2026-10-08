import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { Script } from 'node:vm';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { AuthError } from '../src/server/authService.js';
import { sha256Hex } from '../src/server/gitService.js';
import {
  createOperationalStdout, LOG_FIELD_ALLOWLIST, LOG_LEVELS, LOG_ROUTES, MAX_LOG_LINE_BYTES, MAX_STDOUT_BUFFER_BYTES,
  OperationalLog, parseLogLevel,
  safeErrorFields, STARTUP_PHASES, type LogLevel, type OperationalFields
} from '../src/server/operationalLog.js';
import { API_VERSION, type DevicePushManifest } from '../src/shared/types.js';

const roots: string[] = [];
const servers: ObtsServer[] = [];
const PASSWORD = 'password-redaction-canary-1827';
const USER_NAME = 'username-redaction-canary';
const USER_DISPLAY = 'User display redaction canary';
const VAULT_DISPLAY = 'Vault display redaction canary';
const DEVICE_DISPLAY = 'Device display redaction canary';
const LOCAL_VAULT_DISPLAY = 'Local vault redaction canary';
const PATH_MARKER = 'path-redaction-canary';
const CONTENT_MARKER = 'content-redaction-canary';
const QUERY_MARKER = 'query-secret-redaction-canary';
type LogRow = Record<string, string | number | boolean | null>;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function create(level: LogLevel = 'debug', sink?: (line: string) => void, onRoute?: NonNullable<Parameters<typeof createObtsServer>[1]>['onRoute']) {
  const root = await mkdtemp(join(tmpdir(), 'obts-request-log-'));
  roots.push(root);
  const lines: string[] = [];
  const log = new OperationalLog(level, sink ?? ((line) => lines.push(line)));
  const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'request-log-fixture-signing-key' }, { operationalLog: log, ...(onRoute ? { onRoute } : {}) });
  servers.push(server);
  const rows = () => lines.map((line) => JSON.parse(line) as LogRow);
  const requests = () => rows().filter((row) => row.event === 'http_request');
  return { server, log, lines, rows, requests, root };
}

async function fixture(level: LogLevel = 'debug', sink?: (line: string) => void) {
  const f = await create(level, sink);
  const setup = await f.server.app.inject({
    method: 'POST', url: '/api/v1/setup',
    payload: { username: USER_NAME, password: PASSWORD, display_name: USER_DISPLAY }
  });
  expect(setup.statusCode).toBe(201);
  const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const sessionHeaders = { cookie, 'x-obts-csrf': setup.json().csrf_token as string };
  const login = await f.server.app.inject({
    method: 'POST', url: '/api/v1/auth/login', payload: { username: USER_NAME, password: PASSWORD },
    headers: { 'user-agent': 'header-redaction-canary' }
  });
  expect(login.statusCode).toBe(200);
  const vault = await f.server.app.inject({
    method: 'POST', url: '/api/v1/vaults', headers: sessionHeaders, payload: { display_name: VAULT_DISPLAY }
  });
  expect(vault.statusCode).toBe(201);
  const vaultId = vault.json().vault_id as string;
  const m0 = vault.json().current_main as string;
  const connection = await f.server.app.inject({
    method: 'POST', url: '/api/v1/connections', payload: {
      plugin_version: '0.6.0', device_name: DEVICE_DISPLAY, local_vault_name: LOCAL_VAULT_DISPLAY,
      local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    }
  });
  expect(connection.statusCode).toBe(201);
  const connectionId = connection.json().connection_id as string;
  const connectionSecret = connection.json().connection_secret as string;
  const approved = await f.server.app.inject({
    method: 'POST', url: `/api/v1/connections/${connectionId}/approve`, headers: sessionHeaders,
    payload: { selection: 'existing_vault', vault_id: vaultId }
  });
  expect(approved.statusCode).toBe(200);
  const completed = await f.server.app.inject({
    method: 'POST', url: `/api/v1/connections/${connectionId}/complete`,
    headers: { authorization: `Bearer ${connectionSecret}` }, payload: { mode: 'use_server', expected_main: m0, proposal_base: null }
  });
  expect(completed.statusCode).toBe(201);
  const deviceId = completed.json().device_id as string;
  const token = completed.json().device_token as string;
  const deviceHeaders = { authorization: `Bearer ${token}` };
  const applied = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${vaultId}/sync/applied`, headers: deviceHeaders, payload: { applied_main: m0 }
  });
  expect(applied.statusCode).toBe(200);
  const activated = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${vaultId}/onboarding/complete`, headers: deviceHeaders, payload: { applied_main: m0 }
  });
  expect(activated.statusCode).toBe(200);
  return { ...f, vaultId, deviceId, userId: setup.json().user_id as string, token, deviceHeaders, sessionHeaders,
    connectionId, connectionSecret, cookie, loginCookie: String(login.headers['set-cookie']).split(';')[0]!, m0 };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

let commitSequence = 0;
async function commit(f: Fixture, parent: string, content = CONTENT_MARKER) {
  const tree = await f.server.git.createTreeFromCommitWithChanges({
    vaultId: f.vaultId, sourceCommit: parent, writes: new Map([[`${PATH_MARKER}.md`, Buffer.from(`${content}\n`)]]), deletes: []
  });
  return await f.server.git.createMainCommitFromTree({
    vaultId: f.vaultId, tree, parentMain: parent, subject: `logging fixture ${++commitSequence}`, body: '', actor: 'fixture'
  });
}

async function push(f: Fixture, target: string, overrides: Partial<DevicePushManifest> = {}) {
  const pack = await f.server.git.exportPack(f.vaultId, target, f.m0);
  const db = await f.server.store.snapshot();
  const device = db.devices.find((row) => row.device_id === f.deviceId)!;
  const manifest: DevicePushManifest = {
    api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: f.deviceId,
    expected_device_ref: device.device_ref_head, target_commit: target, client_known_main: f.m0,
    packfile_sha256: sha256Hex(pack), packfile_bytes: pack.length, ...overrides
  };
  const boundary = 'obts-logging-fixture';
  return await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push`,
    headers: { ...f.deviceHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="packfile"; filename="pack.pack"\r\nContent-Type: application/x-git-packed-objects\r\n\r\n`),
      pack, Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  });
}

async function transfer(f: Fixture, target: string, attemptId = 'xfer_logging_fixture') {
  const pack = await f.server.git.exportPack(f.vaultId, target, f.m0);
  const created = await f.server.app.inject({
    method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers`, headers: f.deviceHeaders,
    payload: {
      api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: f.deviceId,
      expected_device_ref: null, target_commit: target, client_known_main: f.m0, attempt_id: attemptId,
      chunk_count: 1, plan_sha256: sha256Hex(Buffer.from('logging fixture plan'))
    }
  });
  expect(created.statusCode).toBe(201);
  const transferId = created.json().transfer_id as string;
  const uploaded = await f.server.app.inject({
    method: 'PUT', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/chunks/0`,
    headers: { ...f.deviceHeaders, 'content-type': 'application/x-git-packed-objects', 'x-obts-chunk-sha256': sha256Hex(pack) }, payload: pack
  });
  expect(uploaded.statusCode).toBe(200);
  return transferId;
}

class FakeOutput extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writableNeedDrain = true;
  lines: string[] = [];

  write(line: string): boolean {
    this.lines.push(line);
    this.writableLength += Buffer.byteLength(line);
    return false;
  }
}

describe('stdout operational buffering', () => {
  it('accepts a burst below the byte cap even while the stream needs drain', () => {
    const stream = new FakeOutput();
    const log = new OperationalLog('info', createOperationalStdout(stream));
    for (let index = 0; index < 20_000; index++) log.emit('info', 'http_request');
    expect(stream.writableNeedDrain).toBe(true);
    expect(stream.writableLength).toBeLessThan(MAX_STDOUT_BUFFER_BYTES);
    expect(stream.lines).toHaveLength(20_000);
    stream.writableLength = 0;
    stream.emit('drain');
    expect(stream.lines).toHaveLength(20_000);
  });

  it.each(['drain', 'write'])('reports overflow exactly once on %s and resets the counter', (resume) => {
    const stream = new FakeOutput();
    const log = new OperationalLog('info', createOperationalStdout(stream));
    stream.writableLength = MAX_STDOUT_BUFFER_BYTES;
    for (let index = 0; index < 3; index++) log.emit('info', 'http_request');
    expect(stream.lines).toEqual([]);
    stream.writableLength = 0;
    if (resume === 'drain') stream.emit('drain');
    else log.emit('info', 'http_request');
    const reports = () => stream.lines.map((line) => JSON.parse(line)).filter((row) => row.event === 'log_lines_dropped');
    expect(reports()).toEqual([expect.objectContaining({ level: 'warn', dropped_lines: 3, service: 'obts-server' })]);
    stream.emit('drain');
    expect(reports()).toHaveLength(1);
    stream.writableLength = MAX_STDOUT_BUFFER_BYTES + 1;
    for (let index = 0; index < 2; index++) log.emit('info', 'http_request');
    stream.writableLength = 0;
    log.emit('info', 'http_request');
    stream.emit('drain');
    expect(reports().map((row) => row.dropped_lines)).toEqual([3, 2]);
    for (const line of stream.lines) {
      expect(Object.keys(JSON.parse(line)).every((key) => LOG_FIELD_ALLOWLIST.includes(key))).toBe(true);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    }
  });

  it('rechecks the byte cap after reporting drops before accepting another line', () => {
    const stream = new FakeOutput();
    const log = new OperationalLog('info', createOperationalStdout(stream));
    stream.writableLength = MAX_STDOUT_BUFFER_BYTES;
    log.emit('info', 'http_request');
    stream.writableLength--;
    log.emit('info', 'http_request');
    expect(stream.lines).toHaveLength(1);
    expect(JSON.parse(stream.lines[0]!)).toMatchObject({ event: 'log_lines_dropped', dropped_lines: 1 });
    expect(stream.writableLength).toBeLessThan(MAX_STDOUT_BUFFER_BYTES + MAX_LOG_LINE_BYTES);
    stream.writableLength = 0;
    stream.emit('drain');
    expect(stream.lines.map((line) => JSON.parse(line).dropped_lines)).toEqual([1, 1]);
  });

  it('swallows stream errors and retries a failed overflow report without losing its count', () => {
    const stream = new FakeOutput();
    const log = new OperationalLog('info', createOperationalStdout(stream));
    stream.writableLength = MAX_STDOUT_BUFFER_BYTES;
    log.emit('info', 'http_request');
    stream.writableLength = 0;
    const fault = vi.spyOn(stream, 'write').mockImplementation(() => { throw new Error('sink failure'); });
    expect(() => stream.emit('error', new Error('pipe failure'))).not.toThrow();
    expect(() => stream.emit('drain')).not.toThrow();
    fault.mockRestore();
    log.emit('info', 'http_request');
    expect(JSON.parse(stream.lines[0]!)).toMatchObject({ event: 'log_lines_dropped', dropped_lines: 1 });
    stream.destroyed = true;
    expect(() => log.emit('info', 'http_request')).not.toThrow();
    expect(stream.lines).toHaveLength(2);
  });
});

describe('closed-schema operational logger', () => {
  it('drops unknown keys, unsafe strings, non-finite values, objects and OIDs at runtime', () => {
    const lines: string[] = [];
    const log = new OperationalLog('debug', (line) => lines.push(line));
    log.emit('info', 'http_request', {
      request_id: 'req_safe', route: '/api/v1/vaults/:vaultId/main', status: 200, duration_ms: 1,
      vault_id: 'vlt_safe', plugin_version: '0.6.0', raw_url: '/secret', authorization: 'Bearer secret',
      body: { password: PASSWORD }, error_code: 'has/secret', attempt_id: 'tok_client-selected-unit-canary',
      host: 'x'.repeat(300), event_seq: Infinity, chunk_index: NaN, complete: 'not-a-boolean',
      ts: PASSWORD, service: PASSWORD, version: PASSWORD
    } as unknown as OperationalFields);
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ request_id: 'req_safe', vault_id: 'vlt_safe', status: 200, service: 'obts-server' });
    expect(row).not.toHaveProperty('attempt_id');
    expect(row).not.toHaveProperty('error_code');
    expect(row).not.toHaveProperty('event_seq');
    expect(Object.keys(row).every((key) => LOG_FIELD_ALLOWLIST.includes(key))).toBe(true);
    expect(lines.join('')).not.toContain(PASSWORD);
    expect(lines.join('')).not.toContain('client-selected-unit-canary');
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    expect(() => log.emit('info', 'http_request', new Proxy({}, { get() { throw new Error('serialization failed'); } }))).not.toThrow();
  });

  it.each(LOG_LEVELS)('filters levels at %s', (level) => {
    const lines: string[] = [];
    const log = new OperationalLog(level, (line) => lines.push(line));
    for (const emitted of ['error', 'warn', 'info', 'debug'] as const) log.emit(emitted, 'http_request');
    const expected = level === 'silent' ? [] : ['error', 'warn', 'info', 'debug'].slice(0, LOG_LEVELS.indexOf(level) + 1);
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(expected);
  });

  it('rejects invalid levels and retains only validated module basenames and stack positions', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(() => parseLogLevel('verbose')).toThrow('OBTS_LOG_LEVEL');
    expect(() => parseLogLevel('')).toThrow('OBTS_LOG_LEVEL');
    const error = new TypeError(PASSWORD);
    error.stack = `TypeError: ${PASSWORD}\n    at handler (/private/${PATH_MARKER}.ts:12:7)\n    at ${CONTENT_MARKER} (file:///private/source.mjs:19:3)\n    at node:internal/process/task_queues:95:5\n    at loader (C:\\private\\module.cjs:2:4)\n    at invalid (/private/not+safe.js:3:6)\n    at handler (/private/(deep folder)/module.js:4:8)\n    at invalid (/private/module(unsafe).js:5:9)`;
    expect(safeErrorFields(error)).toEqual({ error_class: 'TypeError', stack: 'frame:?:12:7,frame:source.mjs:19:3,frame:node:95:5,frame:module.cjs:2:4,frame:?:3:6,frame:module.js:4:8,frame:?:5:9' });
  });

  it('accepts eight bounded basename frames but rejects directory, URL and oversized stack modules', () => {
    const lines: string[] = [];
    const log = new OperationalLog('debug', (line) => lines.push(line));
    const module = `${'x'.repeat(64)}.mjs`;
    const stack = Array.from({ length: 8 }, () => `frame:${module}:9999999:9999999`).join(',');
    log.emit('error', 'http_request', { stack });
    expect(JSON.parse(lines[0]!).stack).toBe(stack);
    for (const invalid of ['frame:/directory/source.js:1:2', 'frame:file:///source.js:1:2',
      'frame:https://example.invalid/source.js:1:2', `frame:${'x'.repeat(65)}.js:1:2`, 'frame:source.ts:1:2']) {
      log.emit('error', 'http_request', { stack: invalid });
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('stack');
    }
    expect(lines.every((line) => Buffer.byteLength(line) <= MAX_LOG_LINE_BYTES)).toBe(true);
  });

  it('logs an error thrown from a deep path without directory names, separators or message text', () => {
    const lines: string[] = [];
    const log = new OperationalLog('debug', (line) => lines.push(line));
    try {
      new Script(`(() => { throw new TypeError('${PASSWORD}'); })()`, {
        filename: '/directory-canary-53710/deep/nested/diagnostic.cjs'
      }).runInThisContext();
    } catch (error) {
      log.backgroundFailure('diagnostic_prune', error);
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).stack).toContain('frame:diagnostic.cjs:1:');
    for (const marker of ['/', '\\', 'directory-canary-53710', 'deep', 'nested', PASSWORD]) {
      expect(lines[0]).not.toContain(marker);
    }
  });
});

describe('server request and lifecycle observations', () => {
  it('matches the complete registered route set with no missing or stale allowlist entries', async () => {
    const registered = new Set<string>();
    const f = await create('silent', undefined, (route) => { registered.add(route.url); });
    await f.server.app.ready();
    expect([...registered].sort()).toEqual([...LOG_ROUTES].sort());
    expect(new Set(LOG_ROUTES).size).toBe(LOG_ROUTES.length);
  });

  it('never logs client attempt IDs from direct push or transfer creation and finalize', async () => {
    const f = await fixture();
    const marker = 'client-attempt-secret-canary-724901';
    const attemptId = `tok_${marker}`;
    const target = await commit(f, f.m0);
    const transferId = await transfer(f, target, `${attemptId}_transfer`);
    const response = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/finalize`, headers: f.deviceHeaders
    });
    expect(response.statusCode).toBe(200);
    expect((await push(f, target, { attempt_id: `${attemptId}_direct` })).statusCode).toBe(200);
    expect(f.lines.join('')).not.toContain(marker);
    expect(f.rows().every((row) => !Object.hasOwn(row, 'attempt_id'))).toBe(true);
  });

  it('never logs unvalidated resource IDs from request paths', async () => {
    const f = await fixture();
    const marker = 'client-resource-secret-canary-861405';
    const conflict = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/conflicts/conf_${marker}/resolve`, headers: f.sessionHeaders,
      payload: { expected_main: f.m0, resolution_kind: 'keep_server' }
    });
    expect(conflict.statusCode).toBe(404);
    const finalize = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/trn_${marker}/finalize`, headers: f.deviceHeaders
    });
    expect(finalize.statusCode).toBe(404);
    for (const url of [`/api/v1/vaults/vlt_${marker}/main`, `/api/v1/vault-deletions/vlt_${marker}`,
      `/api/v1/connections/con_${marker}/review`]) {
      expect((await f.server.app.inject({ method: 'GET', url, headers: f.sessionHeaders })).statusCode).toBe(404);
    }
    expect((await f.server.app.inject({
      method: 'GET', url: '/api/v1/device/self',
      headers: { ...f.deviceHeaders, 'request-id': `req_${marker}`, 'x-request-id': `req_${marker}` }
    })).statusCode).toBe(200);
    expect(f.requests().at(-1)?.request_id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{20}$/u);
    expect(f.lines.join('')).not.toContain(marker);
  });

  it('emits every startup phase once, and exactly one JSON line per completed request with template routes', async () => {
    const f = await fixture();
    expect(f.rows().filter((row) => row.event === 'startup_phase').map((row) => row.phase)).toEqual(STARTUP_PHASES);
    const before = f.requests().length;
    for (let count = 0; count < 2; count++) {
      expect((await f.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${f.vaultId}/main`, headers: f.sessionHeaders })).statusCode).toBe(200);
    }
    expect(f.requests()).toHaveLength(before + 2);
    expect(f.requests().slice(-2).map((row) => row.route)).toEqual(['/api/v1/vaults/:vaultId/main', '/api/v1/vaults/:vaultId/main']);
    expect(f.requests().at(-1)).toMatchObject({ vault_id: f.vaultId, user_id: f.userId });
    expect(new Set(f.requests().map((row) => row.request_id)).size).toBe(f.requests().length);
    for (const line of f.lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trim().split('\n')).toHaveLength(1);
      const row = JSON.parse(line);
      expect(Object.keys(row).every((key) => LOG_FIELD_ALLOWLIST.includes(key))).toBe(true);
      expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
      expect(row).toMatchObject({ service: 'obts-server', version: '0.3.46' });
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    }
  });

  it('redacts credentials, content, paths, queries, display names, IPs and Git OIDs across onboarding and push', async () => {
    const f = await fixture();
    const response = await push(f, await commit(f, f.m0));
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('merged');
    const query = await f.server.app.inject({
      method: 'GET', url: `/api/v1/device/self?path=/${PATH_MARKER}/private&secret=${QUERY_MARKER}`, headers: f.deviceHeaders
    });
    expect(query.statusCode).toBe(200);
    const output = f.lines.join('');
    for (const marker of [PASSWORD, USER_NAME, USER_DISPLAY, VAULT_DISPLAY, DEVICE_DISPLAY, LOCAL_VAULT_DISPLAY,
      PATH_MARKER, CONTENT_MARKER, QUERY_MARKER, f.token, f.connectionSecret,
      f.cookie.split('=')[1]!, f.loginCookie.split('=')[1]!, 'header-redaction-canary', '127.0.0.1']) {
      expect(output).not.toContain(marker);
    }
    expect(output).not.toMatch(/[0-9a-f]{40}/iu);
    expect(f.requests().find((row) => row.route === '/api/v1/connections/:connectionId/complete')).toMatchObject({ connection_id: f.connectionId });
  });

  it('records push outcomes and inline errors, preferring compatible reported plugin version over the device row', async () => {
    const f = await fixture();
    const target = await commit(f, f.m0);
    const merged = await push(f, target, { attempt_id: 'xfer_direct_fixture' });
    expect(merged.statusCode).toBe(200);
    expect(f.requests().at(-1)).toMatchObject({ vault_id: f.vaultId, device_id: f.deviceId, user_id: f.userId,
      plugin_version: '0.5.14', push_status: 'merged', event_seq: merged.json().event_seq });
    const noop = await push(f, target);
    expect(noop.json().status).toBe('noop');
    expect(f.requests().at(-1)).toMatchObject({ push_status: 'noop', event_seq: noop.json().event_seq });
    const rejected = await push(f, target, { packfile_sha256: '0'.repeat(64), attempt_id: 'invalid/attempt' });
    expect(rejected.statusCode).toBe(409);
    expect(f.requests().at(-1)).toMatchObject({ push_status: 'rejected', error_code: 'invalid_packfile', outcome: 'client_error', level: 'info' });
    expect(f.rows().filter((row) => row.event === 'push_integrated').map((row) => row.push_status)).toEqual(['merged', 'noop', 'rejected']);
  });

  it('annotates pull, acknowledgement and sanitized status reports without hashes or arbitrary labels', async () => {
    const f = await fixture();
    const pulled = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/pull-chunk`, headers: f.deviceHeaders,
      payload: { api_version: API_VERSION, plugin_version: '0.5.14', vault_id: f.vaultId, device_id: f.deviceId,
        requested_target: 'latest', current_local_main: null, current_event_seq: 0, cursor: 0 }
    });
    expect(pulled.statusCode).toBe(200);
    expect(f.requests().at(-1)).toMatchObject({ plugin_version: '0.5.14', chunk_index: 0, complete: true, target: 'latest', event_seq: expect.any(Number) });
    const applied = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/applied`, headers: f.deviceHeaders, payload: { applied_main: f.m0 }
    });
    expect(applied.statusCode).toBe(200);
    expect(f.requests().at(-1)).toMatchObject({ event_seq: applied.json().applied_event_seq });
    const report = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/device-status`, headers: f.deviceHeaders,
      payload: { plugin_version: CONTENT_MARKER, local_status_label: PATH_MARKER, local_queue_status: QUERY_MARKER,
        local_error_code: null, local_main: null, local_head: null, path_capabilities: null }
    });
    expect(report.statusCode).toBe(200);
    expect(f.requests().at(-1)).toMatchObject({ plugin_version: 'unknown', reported_status: 'unknown', event_seq: applied.json().applied_event_seq });
    await f.server.app.inject({ method: 'GET', url: '/api/v1/device/self', headers: f.deviceHeaders });
    expect(f.requests().at(-1)).toMatchObject({ plugin_version: 'unknown' });
    expect(f.lines.join('')).not.toMatch(/[0-9a-f]{40}/iu);
    for (const marker of [CONTENT_MARKER, PATH_MARKER, QUERY_MARKER]) expect(f.lines.join('')).not.toContain(marker);
  });

  it('correlates AuthError and unknown errors without changing error responses or exposing messages', async () => {
    const f = await create();
    const authFailure = await f.server.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(authFailure.statusCode).toBe(401);
    expect(f.requests().at(-1)).toMatchObject({ error_code: authFailure.json().error.code, request_id: authFailure.json().error.request_id, level: 'info' });
    vi.spyOn(f.server.store, 'snapshot').mockRejectedValueOnce(new TypeError(CONTENT_MARKER));
    const unknown = await f.server.app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(unknown.statusCode).toBe(500);
    expect(unknown.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error.', request_id: unknown.json().error.request_id, details: {} } });
    expect(f.requests().at(-1)).toMatchObject({ error_code: 'internal_error', error_class: 'TypeError', level: 'error', outcome: 'server_error' });
    expect(f.lines.join('')).not.toContain(CONTENT_MARKER);
    expect(f.lines.join('')).not.toContain('server-request-logging.test.ts');
  });

  it('emits integration after async finalize completes, not when its processing response is sent', async () => {
    const f = await fixture();
    const transferId = await transfer(f, await commit(f, f.m0));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.server.sync.pushDeviceCommit.bind(f.server.sync);
    vi.spyOn(f.server.sync, 'pushDeviceCommit').mockImplementation(async (...args) => { await gate; return await original(...args); });
    try {
      const finalized = await f.server.app.inject({
        method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/finalize`,
        headers: { ...f.deviceHeaders, prefer: 'respond-async' }
      });
      expect(finalized.statusCode).toBe(202);
      expect(f.requests().at(-1)).toMatchObject({ push_status: 'processing', chunk_count: 1, transfer_id: transferId });
      expect(f.rows().filter((row) => row.event === 'push_integrated')).toEqual([]);
      release();
      await vi.waitFor(() => expect(f.rows().find((row) => row.event === 'push_integrated')).toMatchObject({
        vault_id: f.vaultId, device_id: f.deviceId, transfer_id: transferId, push_status: 'merged', event_seq: expect.any(Number)
      }), { timeout: 5000 });
      const auth = await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
      await vi.waitFor(async () => expect((await f.server.chunkTransfers.getPush(auth, transferId)).status).toBe('completed'));
    } finally { release(); }
  });

  it('annotates synchronous finalize with its existing chunk count and integration result', async () => {
    const f = await fixture();
    const transferId = await transfer(f, await commit(f, f.m0));
    const response = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/finalize`, headers: f.deviceHeaders
    });
    expect(response.statusCode).toBe(200);
    expect(f.requests().at(-1)).toMatchObject({ chunk_count: 1, transfer_id: transferId, push_status: 'merged', event_seq: response.json().event_seq });
  });

  it('observes conflict creation and resolution only once after durable mutations', async () => {
    const f = await fixture();
    const base = await commit(f, f.m0, 'base');
    expect((await push(f, base)).statusCode).toBe(200);
    const remote = await commit(f, base, 'remote');
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', remote, base);
    await f.server.store.mutate((db) => { db.vaults.find((row) => row.vault_id === f.vaultId)!.current_main = remote; });
    const conflicted = await push(f, await commit(f, base, 'local'));
    expect(conflicted.json().status).toBe('conflicted');
    const conflictId = conflicted.json().conflict_id as string;
    expect(f.rows().filter((row) => row.event === 'conflict_created')).toEqual([
      expect.objectContaining({ vault_id: f.vaultId, device_id: f.deviceId, conflict_id: conflictId, event_seq: conflicted.json().event_seq })
    ]);
    const resolve = () => f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/conflicts/${conflictId}/resolve`, headers: f.sessionHeaders,
      payload: { expected_main: remote, resolution_kind: 'keep_server' }
    });
    const resolved = await resolve();
    expect(resolved.statusCode).toBe(200);
    expect((await f.server.store.snapshot()).conflicts.find((row) => row.conflict_id === conflictId)?.status).toBe('resolved');
    expect(f.requests().at(-1)).toMatchObject({ resolution: 'keep_server', conflict_id: conflictId });
    expect(f.rows().filter((row) => row.event === 'conflict_resolved')).toEqual([
      expect.objectContaining({ vault_id: f.vaultId, conflict_id: conflictId, resolution: 'keep_server', user_id: f.userId })
    ]);
    expect((await resolve()).statusCode).toBe(200);
    expect(f.rows().filter((row) => row.event === 'conflict_resolved')).toHaveLength(1);
  });

  it('observes resumed merges on startup without repeating integration for an already integrated proposal', async () => {
    const f = await fixture();
    const target = await commit(f, f.m0);
    const ref = `refs/obts/devices/${f.deviceId}`;
    const original = f.server.git.updateRef.bind(f.server.git);
    const fault = vi.spyOn(f.server.git, 'updateRef').mockImplementation(async (...args) => {
      if (args[1] === 'refs/heads/main') throw new AuthError(503, 'fixture_interrupted', CONTENT_MARKER);
      return await original(...args);
    });
    expect((await push(f, target)).statusCode).toBe(503);
    expect(await f.server.git.getRef(f.vaultId, ref)).toBe(target);
    fault.mockRestore();
    await f.server.app.close();
    const lines: string[] = [];
    const restarted = await createObtsServer({ dataDir: f.server.config.dataDir }, { operationalLog: new OperationalLog('debug', (line) => lines.push(line)) });
    servers.push(restarted);
    const events = () => lines.map((line) => JSON.parse(line) as LogRow).filter((row) => row.event === 'push_integrated');
    expect(events()).toEqual([expect.objectContaining({ vault_id: f.vaultId, device_id: f.deviceId, push_status: 'merged', event_seq: expect.any(Number) })]);
    await restarted.sync.resumePendingMerges();
    expect(events()).toHaveLength(1);
  });

  it.each(['info', 'debug', 'silent'] as const)('classifies noisy routes at %s, including successful chunk PUTs', async (level) => {
    const f = await fixture(level);
    const before = f.requests().length;
    await f.server.app.inject({ method: 'GET', url: '/health/live' });
    await f.server.app.inject({ method: 'HEAD', url: '/health/live' });
    await f.server.app.inject({ method: 'GET', url: '/' });
    await f.server.app.inject({ method: 'GET', url: `/api/v1/vaults/${f.vaultId}/sync/events`, headers: f.deviceHeaders });
    await transfer(f, await commit(f, f.m0));
    const noisy = f.requests().slice(before).filter((row) => row.route === '/health/live' || row.route === '/' || row.method === 'PUT' || String(row.route).endsWith('/sync/events'));
    expect(noisy).toHaveLength(level === 'debug' ? 5 : 0);
    expect(noisy.every((row) => row.level === 'debug')).toBe(true);
    if (level === 'silent') expect(f.lines).toEqual([]);
  });

  it('logs readiness failures as warn with check names, never detail, and integrity transitions once', async () => {
    const f = await fixture();
    await f.server.git.updateRef(f.vaultId, 'refs/heads/main', await commit(f, f.m0), f.m0);
    const response = await f.server.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(f.requests().at(-1)).toMatchObject({ level: 'warn', status: 503, failed_checks: expect.stringContaining('persistent_state') });
    expect(f.lines.join('')).not.toContain(response.json().detail);
    await f.server.app.inject({ method: 'GET', url: '/health/ready' });
    expect(f.rows().filter((row) => row.event === 'vault_integrity_blocked')).toEqual([
      expect.objectContaining({ vault_id: f.vaultId, source: 'request' })
    ]);
  });

  it('reports background failures without messages and preserves swallowing behavior', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const f = await create();
    vi.spyOn(f.server.diagnostics, 'prune').mockRejectedValue(new TypeError(CONTENT_MARKER));
    vi.spyOn(f.server.lifecycle, 'expireReceipts').mockRejectedValue(new Error(PASSWORD));
    for (const [callback, delay] of intervals.mock.calls) {
      if (delay === 24 * 60 * 60 * 1000 || delay === 60 * 60 * 1000) (callback as () => void)();
    }
    await vi.waitFor(() => {
      expect(f.rows().some((row) => row.event === 'background_task_failed' && row.task === 'diagnostic_prune' && row.error_class === 'TypeError')).toBe(true);
      expect(f.rows().some((row) => row.event === 'background_task_failed' && row.task === 'receipt_expiry')).toBe(true);
    });
    expect(f.lines.join('')).not.toContain(CONTENT_MARKER);
    expect(f.lines.join('')).not.toContain(PASSWORD);
  });

  it('keeps responses and durable integration unchanged when the sink throws', async () => {
    const f = await fixture('debug', () => { throw new Error('sink failed'); });
    expect((await f.server.app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ status: 'ok' });
    const pushed = await push(f, await commit(f, f.m0));
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().status).toBe('merged');
    expect((await f.server.store.snapshot()).vaults.find((row) => row.vault_id === f.vaultId)?.current_main).toBe(pushed.json().main);
    const authError = await f.server.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(authError.statusCode).toBe(401);
    expect(authError.json()).toEqual({ error: { code: authError.json().error.code, message: 'Authentication required.', request_id: authError.json().error.request_id, details: {} } });
  });

  it.each([false, true])('preserves background retry completion with a throwing sink: %s', async (throwing) => {
    const f = await fixture('debug', throwing ? () => { throw new Error('sink failed'); } : undefined);
    const transferId = await transfer(f, await commit(f, f.m0));
    vi.spyOn(f.server.sync, 'pushDeviceCommit').mockRejectedValueOnce(new TypeError(CONTENT_MARKER));
    const response = await f.server.app.inject({
      method: 'POST', url: `/api/v1/vaults/${f.vaultId}/sync/push-transfers/${transferId}/finalize`,
      headers: { ...f.deviceHeaders, prefer: 'respond-async' }
    });
    expect(response.statusCode).toBe(202);
    const auth = await f.server.auth.authenticateDevice(`Bearer ${f.token}`, f.vaultId);
    await vi.waitFor(async () => expect((await f.server.chunkTransfers.getPush(auth, transferId)).status).toBe('completed'), { timeout: 5000 });
    if (!throwing) {
      expect(f.rows().filter((row) => row.event === 'background_task_failed')).toEqual([
        expect.objectContaining({ task: 'transfer_processing', error_class: 'TypeError', level: 'warn' })
      ]);
      expect(f.lines.join('')).not.toContain(CONTENT_MARKER);
    }
  });

  it('logs unmatched routes as null without raw path or query', async () => {
    const f = await create();
    const response = await f.server.app.inject({ method: 'GET', url: `/unknown/${PATH_MARKER}?token=${QUERY_MARKER}` });
    expect(response.statusCode).toBe(404);
    expect(f.requests()).toEqual([expect.objectContaining({ route: null, status: 404, error_code: 'not_found', level: 'debug' })]);
    expect(f.lines.join('')).not.toContain(PATH_MARKER);
    expect(f.lines.join('')).not.toContain(QUERY_MARKER);
  });

  it('logs a disconnected request once as aborted', async () => {
    const f = await create();
    let started!: () => void;
    const receiving = new Promise<void>((resolve) => { started = resolve; });
    f.server.app.addHook('onRequest', async (request) => {
      if (request.routeOptions.url === '/api/v1/setup') started();
    });
    await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listen address');
    const socket = connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('POST /api/v1/setup HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"username":');
    await receiving;
    socket.destroy();
    await vi.waitFor(() => expect(f.requests()).toHaveLength(1));
    expect(f.requests()[0]).toMatchObject({ outcome: 'aborted', route: '/api/v1/setup', status: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.requests()).toHaveLength(1);
  });
  it('logs disconnect during handler work even after the request body is complete', async () => {
    const f = await create();
    let started!: () => void;
    let release!: () => void;
    const receiving = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.server.store.snapshot.bind(f.server.store);
    vi.spyOn(f.server.store, 'snapshot').mockImplementationOnce(async () => { started(); await gate; return await original(); });
    await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listen address');
    const socket = connect(address.port, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write('GET /api/v1/setup/status HTTP/1.1\r\nHost: localhost\r\n\r\n');
      await receiving;
      socket.destroy();
      await vi.waitFor(() => expect(f.requests()).toHaveLength(1));
      expect(f.requests()[0]).toMatchObject({ outcome: 'aborted', route: '/api/v1/setup/status', status: null });
    } finally { release(); socket.destroy(); }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.requests()).toHaveLength(1);
  });
});

describe('CLI operational logging boundary', () => {
  it('keeps health/setup JSON stdout pure and rejects invalid serve levels before startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-cli-log-'));
    roots.push(root);
    let stdout = '';
    let stderr = '';
    const io = { stdout: (line: string) => { stdout += line; }, stderr: (line: string) => { stderr += line; } };
    const env = { OBTS_DATA_DIR: join(root, 'data'), OBTS_LOG_LEVEL: 'debug' };
    expect(await runCli(['health', 'live', '--json'], env, io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: 'ok' });
    stdout = '';
    expect(await runCli(['setup', '--username', USER_NAME, '--password', PASSWORD, '--json'], env, io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ user_id: expect.stringMatching(/^usr_/u) });
    stdout = '';
    expect(await runCli(['serve'], { ...env, OBTS_LOG_LEVEL: 'invalid' }, io)).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('OBTS_LOG_LEVEL');
  });

  it('replaces the plaintext serve banner with server_listening and configured startup events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-serve-log-'));
    roots.push(root);
    const lines: string[] = [];
    let stderr = '';
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing reserved test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const run = runCli(['serve', '--host', '127.0.0.1', '--port', String(port)], { OBTS_DATA_DIR: join(root, 'data') }, {
      stdout: (line) => lines.push(line), stderr: (line) => { stderr += line; }
    });
    try {
      await vi.waitFor(() => {
        expect(stderr).toBe('');
        expect(lines.some((line) => JSON.parse(line).event === 'server_listening')).toBe(true);
      });
      const listening = lines.map((line) => JSON.parse(line)).find((row) => row.event === 'server_listening');
      expect(listening).toMatchObject({ event: 'server_listening', host: '127.0.0.1', port, log_level: 'info' });
      expect(lines.join('')).not.toContain('obts server listening on');
    } finally { process.emit('SIGTERM'); }
    expect(await run).toBe(0);
    expect(stderr).toBe('');
  });
});
