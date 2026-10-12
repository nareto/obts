import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createObtsServer, type CreateObtsServerOptions, type ObtsServer } from '../../src/server/app.js';

export type SseFrame = { event: string; data: unknown };

export class SseStream {
  status = 0;
  headers: IncomingHttpHeaders = {};
  body = '';
  ended = false;
  private response: IncomingMessage | null = null;
  private readonly waiters: Array<() => void> = [];

  private constructor(private readonly abortRequest: () => void) {}

  static async open(baseUrl: string, path: string, headers: Record<string, string>): Promise<SseStream> {
    const url = new URL(path, baseUrl);
    let stream!: SseStream;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(url, { method: 'GET', headers }, (response) => {
        stream.status = response.statusCode ?? 0;
        stream.headers = response.headers;
        stream.response = response;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { stream.body += chunk; stream.wake(); });
        const finish = () => { stream.ended = true; stream.wake(); };
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', finish);
        resolve();
      });
      stream = new SseStream(() => req.destroy());
      req.on('error', (error) => { if (stream.status === 0) reject(error); else { stream.ended = true; stream.wake(); } });
      req.end();
    });
    return stream;
  }

  frames(): SseFrame[] {
    return this.body.split('\n\n').filter((block) => /^event: /mu.test(block)).map((block) => ({
      event: /^event: (.+)$/mu.exec(block)![1]!,
      data: JSON.parse(/^data: (.+)$/mu.exec(block)![1]!) as unknown
    }));
  }

  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for stream state; body so far: ${JSON.stringify(this.body)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async frameCount(count: number): Promise<SseFrame[]> {
    await this.until(() => this.frames().length >= count);
    return this.frames();
  }

  async text(): Promise<string> {
    await this.until(() => this.ended);
    return this.body;
  }

  abort(): void {
    this.abortRequest();
    this.response?.destroy();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

export class DashboardHarness {
  readonly roots: string[] = [];
  readonly servers: ObtsServer[] = [];
  readonly streams: SseStream[] = [];

  async start(options: CreateObtsServerOptions = {}, config: { writeGate?: { fail: boolean } } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'obts-dashboard-http-'));
    this.roots.push(dataDir);
    const gate = config.writeGate;
    const writes = { count: 0 };
    const server = await createObtsServer({ dataDir, sessionSecret: 'synthetic-dashboard-signing-key' }, {
      ...options,
      metadataPersistence: {
        ...options.metadataPersistence,
        writeFile: async (file, data) => {
          if (gate?.fail) throw new Error('synthetic write failure');
          writes.count += 1;
          await writeFile(file, data, { mode: 0o600 });
        }
      }
    });
    this.servers.push(server);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    return { server, baseUrl, writes };
  }

  async stream(baseUrl: string, cookie: string | null, extra: Record<string, string> = {}): Promise<SseStream> {
    const stream = await SseStream.open(baseUrl, '/api/v1/dashboard/events', {
      accept: 'text/event-stream',
      ...(cookie ? { cookie } : {}),
      ...extra
    });
    this.streams.push(stream);
    return stream;
  }

  async cleanup(): Promise<void> {
    for (const stream of this.streams.splice(0)) stream.abort();
    await Promise.all(this.servers.splice(0).map(async (server) => await server.app.close()));
    await Promise.all(this.roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  }
}

export class Browser {
  cookie = '';
  csrf = '';

  constructor(readonly baseUrl: string) {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-obts-csrf': this.csrf } : {})
      },
      body: body === undefined ? null : JSON.stringify(body)
    });
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const pairs = cookies.map((cookie) => cookie.split(';')[0]).filter((pair): pair is string => Boolean(pair) && !pair!.endsWith('='));
    if (pairs.length > 0) this.cookie = pairs.join('; ');
    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) : null;
    if (parsed && typeof parsed.csrf_token === 'string') this.csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  }

  async setup(username: string, password: string): Promise<void> {
    const result = await this.call('POST', '/api/v1/setup', { username, password, display_name: username });
    if (result.status !== 201) throw new Error(`setup failed: ${result.status}`);
  }

  async login(username: string, password: string): Promise<void> {
    const result = await this.call('POST', '/api/v1/auth/login', { username, password });
    if (result.status !== 200) throw new Error(`login failed: ${result.status}`);
  }
}
