import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HEADLESS_REQUEST_DEADLINES_MS,
  ObtsPluginClient,
  TransportError,
  classifyHeadlessRequest
} from '../src/client/core.js';
import { HeadlessSession, type HeadlessMessage } from '../src/client/headlessProtocol.js';

const BRIDGE_REQUEST_INACTIVITY_DEFAULT_MS = 300_000;
const roots: string[] = [];
const servers: TestServer[] = [];

type TestServer = {
  url: string;
  seen: string[];
  sockets: Set<Socket>;
  closedSockets: Promise<void>[];
  close(): Promise<void>;
};

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const closedSockets: Promise<void>[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    closedSockets.push(new Promise<void>((resolve) => socket.once('close', () => {
      sockets.delete(socket);
      resolve();
    })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  const testServer: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    sockets,
    closedSockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  servers.push(testServer);
  return testServer;
}

async function makeClient(
  serverUrl: string,
  requestDeadlinesMs?: { control?: number; transfer?: number }
): Promise<{ client: ObtsPluginClient; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-transport-deadlines-'));
  roots.push(root);
  const client = new ObtsPluginClient(
    root,
    { serverUrl, deviceName: 'transport-deadlines' },
    null,
    requestDeadlinesMs === undefined ? undefined : { requestDeadlinesMs }
  );
  return { client, root };
}

async function pairedClient(serverUrl: string, requestDeadlinesMs?: { control?: number; transfer?: number }) {
  const { client, root } = await makeClient(serverUrl, requestDeadlinesMs);
  await client.initialize();
  await client.writeState({
    user_id: 'user_1',
    vault_id: 'vault_1',
    device_id: 'device_1',
    device_name: 'transport-deadlines',
    device_ref: null,
    server_device_ref: null,
    local_main: null,
    local_head: null,
    initial_import_confirmed: true,
    status_label: 'Synced',
    last_error_code: null,
    last_event_seq: 0,
    last_applied_event_seq: 0,
    updated_at: '2026-01-01T00:00:00.000Z'
  });
  await mkdir(join(root, '.obts', 'auth'), { recursive: true });
  await writeFile(join(root, '.obts', 'auth', 'device-token.json'), JSON.stringify({ device_token: 'synthetic-token' }));
  return client;
}

async function expectNetworkFailure(promise: Promise<unknown>, causeName: 'TimeoutError' | 'AbortError') {
  const error = await promise.then(() => null, (caught: unknown) => caught as Record<string, any>);
  expect(error).toBeInstanceOf(TransportError);
  expect(error).toMatchObject({ status: 0, code: 'network_error' });
  expect(error?.cause?.name).toBe(causeName);
  return error as Record<string, any>;
}

function hangForever(): void {}

function stallMidBody(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
  res.write('{"status":');
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('headless request classification', () => {
  const vault = '/api/v1/vaults/vault_1';
  const transfer = [
    '/api/v1/connections/conn_1/bootstrap',
    '/api/v1/connections/conn_1/bootstrap-chunk',
    `${vault}/sync/pull`,
    `${vault}/sync/pull-chunk`,
    `${vault}/sync/push`,
    `${vault}/sync/push-transfers`,
    `${vault}/sync/push-transfers/transfer_1`,
    `${vault}/sync/push-transfers/transfer_1/chunks/3`,
    `${vault}/sync/push-transfers/transfer_1/finalize`
  ];
  const control = [
    '/api/v1/sync/capabilities',
    '/api/v1/connections',
    '/api/v1/connections/conn_1',
    `${vault}/sync/device-status`,
    `${vault}/sync/events`,
    `${vault}/sync/applied`,
    `${vault}/sync/device`,
    `${vault}/diagnostics`,
    `${vault}/conflicts`,
    `${vault}/devices/device_1`,
    `${vault}/sync/pull-status`,
    '/api/v1/connections/conn_1/bootstrap-status',
    '/other/path'
  ];

  it('places transfer routes in the transfer class for every method and ignores query strings', () => {
    for (const path of transfer) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect(classifyHeadlessRequest(method, `http://127.0.0.1:8080${path}`), `${method} ${path}`).toBe('transfer');
      }
      expect(classifyHeadlessRequest('GET', `http://127.0.0.1:8080${path}?after=3&x=/sync/pull`)).toBe('transfer');
    }
  });

  it('places every other route in the control class', () => {
    for (const path of control) {
      expect(classifyHeadlessRequest('GET', `http://127.0.0.1:8080${path}`), path).toBe('control');
      expect(classifyHeadlessRequest('POST', `http://127.0.0.1:8080${path}?next=/sync/push`), path).toBe('control');
    }
  });

  it('classifies by pathname only, including under a deployment path prefix, and defaults unparsable URLs to control', () => {
    expect(classifyHeadlessRequest('POST', `https://example.test/obts${vault}/sync/push`)).toBe('transfer');
    expect(classifyHeadlessRequest('GET', `https://example.test${vault}/sync/events?x=${vault}/sync/push`)).toBe('control');
    expect(classifyHeadlessRequest('GET', 'not a url')).toBe('control');
  });
});

describe('headless request deadlines', () => {
  it('keeps default deadlines below the managed bridge request inactivity default', () => {
    expect(HEADLESS_REQUEST_DEADLINES_MS).toEqual({ control: 60_000, transfer: 180_000 });
    expect(HEADLESS_REQUEST_DEADLINES_MS.control).toBeLessThan(BRIDGE_REQUEST_INACTIVITY_DEFAULT_MS);
    expect(HEADLESS_REQUEST_DEADLINES_MS.transfer).toBeLessThan(BRIDGE_REQUEST_INACTIVITY_DEFAULT_MS);
  });

  it('times out a connect or header stall as a network failure, never a server rejection', async () => {
    const server = await startServer(hangForever);
    const { client } = await makeClient(server.url, { control: 200 });
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason));
    })));

    const started = Date.now();
    const error = await expectNetworkFailure(client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret')), 'TimeoutError');

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.cause).toMatchObject({ requestClass: 'control', deadlineMs: 200 });
    expect(signals).toHaveLength(1);
    expect(server.seen).toEqual([]);
  });

  it('times out a real server that never answers and tears the socket down', async () => {
    const server = await startServer(hangForever);
    const { client } = await makeClient(server.url, { control: 250 });

    const started = Date.now();
    await expectNetworkFailure(client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret')), 'TimeoutError');

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.seen).toEqual(['GET /api/v1/connections/conn_1']);
    await Promise.race([
      Promise.all(server.closedSockets),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('socket stayed open')), 5_000))
    ]);
    expect(server.sockets.size).toBe(0);
  });

  it('times out a stalled response body and tears the socket down', async () => {
    const server = await startServer(stallMidBody);
    const { client } = await makeClient(server.url, { control: 300 });

    const started = Date.now();
    const error = await expectNetworkFailure(client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret')), 'TimeoutError');

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.cause).toMatchObject({ requestClass: 'control', deadlineMs: 300 });
    await Promise.race([
      Promise.all(server.closedSockets),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('socket stayed open')), 5_000))
    ]);
    expect(server.sockets.size).toBe(0);
  });

  it('applies the longer transfer deadline to transfer routes only', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/api/v1/sync/capabilities') {
        res.writeHead(404).end();
        return;
      }
      setTimeout(() => {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'server_said_no', message: 'rejected' } }));
      }, 400);
    });
    const { client } = await makeClient(server.url, { control: 150, transfer: 2_000 });

    await expectNetworkFailure(client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret')), 'TimeoutError');

    const bootstrap = client.runInRequestScope(() => (client.client as any).bootstrapWithChunks('conn_1', 'secret')) as Promise<unknown>;
    const rejection = await bootstrap.then(() => null, (caught: unknown) => caught as Record<string, any>);
    expect(rejection).toBeInstanceOf(TransportError);
    expect(rejection).toMatchObject({ status: 409, code: 'server_said_no' });
    expect(server.seen).toContain('POST /api/v1/connections/conn_1/bootstrap');
  });

  it('fails a transfer request that exceeds the transfer deadline as a network failure', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/api/v1/sync/capabilities') {
        res.writeHead(404).end();
        return;
      }
      stallMidBody(req, res);
    });
    const { client } = await makeClient(server.url, { control: 5_000, transfer: 300 });

    const error = await expectNetworkFailure(client.runInRequestScope(() => (client.client as any).bootstrapWithChunks('conn_1', 'secret')), 'TimeoutError');

    expect(error.cause).toMatchObject({ requestClass: 'transfer', deadlineMs: 300 });
  });
});

describe('headless request cancellation', () => {
  it('rejects before dispatch once the client has been aborted', async () => {
    const server = await startServer((_req, res) => void res.writeHead(200).end('{}'));
    const { client } = await makeClient(server.url);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    client.abortRequests();
    client.abortRequests();
    const started = Date.now();
    await expectNetworkFailure(client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret')), 'AbortError');

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(server.seen).toEqual([]);
    expect(server.sockets.size).toBe(0);
  });

  it('keeps cancellation scoped to the owning client', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'pending' }));
    });
    const stopped = (await makeClient(server.url)).client;
    const running = (await makeClient(server.url)).client;

    stopped.abortRequests();

    await expectNetworkFailure(stopped.runInRequestScope(() => stopped.pollOnboarding('conn_1', 'secret')), 'AbortError');
    await expect(running.runInRequestScope(() => running.pollOnboarding('conn_1', 'secret'))).resolves.toMatchObject({ status: 'pending' });
    expect(server.seen).toEqual(['GET /api/v1/connections/conn_1']);
  });

  it('aborts an in-flight scoped request that is waiting for connect or headers', async () => {
    const server = await startServer(hangForever);
    const { client } = await makeClient(server.url);
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason));
    })));

    const pending = client.runInRequestScope(() => client.pollOnboarding('conn_1', 'secret'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    client.abortRequests();

    await expectNetworkFailure(pending, 'AbortError');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('headless session stop and in-flight sync', () => {
  function sessionFor(client: ObtsPluginClient) {
    const messages: HeadlessMessage[] = [];
    const session = new HeadlessSession(client, async (message) => void messages.push(message));
    return { session, messages };
  }

  function expectTransportFailureResponse(messages: HeadlessMessage[], id: string) {
    const response = messages.find((message) => message.type === 'response' && message.id === id);
    expect(response).toMatchObject({ type: 'response', id, ok: false });
    const error = (response as Extract<HeadlessMessage, { type: 'response'; ok: false }>).error;
    expect(error.message).toBe('Unable to reach the obts server.');
    expect(['network_error', 'internal_error']).toContain(error.code);
  }

  it('stops promptly by aborting a sync stalled before response headers, with no later requests', async () => {
    const server = await startServer(hangForever);
    const client = await pairedClient(server.url);
    const { session, messages } = sessionFor(client);

    const command = session.submit({ id: 'sync', command: 'sync-once' });
    await vi.waitFor(() => expect(server.seen.length).toBeGreaterThan(0), { timeout: 10_000 });
    const requestsBeforeStop = server.seen.length;
    const started = Date.now();
    await session.stop('test');
    await command;

    expect(Date.now() - started).toBeLessThan(5_000);
    expectTransportFailureResponse(messages, 'sync');
    expect(messages.at(-1)).toMatchObject({ type: 'event', event: 'stopping', reason: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.seen).toHaveLength(requestsBeforeStop);
    await Promise.all(server.closedSockets);
    expect(server.sockets.size).toBe(0);
  });

  it('stops promptly by aborting a sync stalled in the middle of a response body', async () => {
    const server = await startServer(stallMidBody);
    const client = await pairedClient(server.url);
    const { session, messages } = sessionFor(client);

    const command = session.submit({ id: 'sync', command: 'sync-once' });
    await vi.waitFor(() => expect(server.seen.length).toBeGreaterThan(0), { timeout: 10_000 });
    const requestsBeforeStop = server.seen.length;
    const started = Date.now();
    await session.stop('test');
    await command;

    expect(Date.now() - started).toBeLessThan(5_000);
    expectTransportFailureResponse(messages, 'sync');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.seen).toHaveLength(requestsBeforeStop);
    await Promise.all(server.closedSockets);
    expect(server.sockets.size).toBe(0);
  });

  it('stops promptly by aborting a command stalled in connect', async () => {
    const server = await startServer(hangForever);
    const { client } = await makeClient(server.url);
    const entered = vi.fn();
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      entered();
      signals.push(init.signal);
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason));
    })));
    const { session, messages } = sessionFor(client);

    const command = session.submit({ id: 'poll', command: 'poll-onboarding', connectionId: 'conn_1', secret: 'secret' });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    const started = Date.now();
    await session.stop('test');
    await command;

    expect(Date.now() - started).toBeLessThan(5_000);
    expectTransportFailureResponse(messages, 'poll');
    expect(entered).toHaveBeenCalledTimes(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
    expect((signals[0]?.reason as Error).name).toBe('AbortError');
  });

  it('dispatches no request for a command submitted after stop', async () => {
    const server = await startServer((_req, res) => void res.writeHead(200).end('{}'));
    const { client } = await makeClient(server.url);
    const { session, messages } = sessionFor(client);

    await session.stop('test');
    await session.submit({ id: 'late', command: 'poll-onboarding', connectionId: 'conn_1', secret: 'secret' });

    expect(messages).toContainEqual({
      type: 'response',
      id: 'late',
      ok: false,
      error: { code: 'shutting_down', message: 'The headless client is shutting down.' }
    });
    expect(server.seen).toEqual([]);
  });

  it('fails an in-flight sync at the request deadline without altering sync state or retrying the transport', async () => {
    const server = await startServer(hangForever);
    const client = await pairedClient(server.url, { control: 400 });
    const { session, messages } = sessionFor(client);
    const stateBefore = await client.readState();
    const queueBefore = await client.readQueue();

    const started = Date.now();
    await session.submit({ id: 'sync', command: 'sync-once' });

    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(10_000);
    expectTransportFailureResponse(messages, 'sync');
    expect(server.seen).toContain('GET /api/v1/vaults/vault_1/sync/events?after=0');
    expect(new Set(server.seen).size).toBe(server.seen.length);
    const stateAfter = await client.readState();
    expect(stateAfter).toMatchObject({
      local_main: stateBefore.local_main,
      local_head: stateBefore.local_head,
      server_device_ref: stateBefore.server_device_ref,
      last_error_code: null,
      last_event_seq: stateBefore.last_event_seq
    });
    expect(await client.readQueue()).toMatchObject({ pending_commit: queueBefore.pending_commit, status: queueBefore.status });
    await session.stop('test');
  });
});
