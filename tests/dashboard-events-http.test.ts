import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { Browser, DashboardHarness } from './helpers/dashboardHttpHarness.js';

const harness = new DashboardHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.cleanup();
});

const settle = async (ms = 150) => await new Promise((resolve) => setTimeout(resolve, ms));
const FAST = { coalesceMs: 10, heartbeatMs: 10_000 } as const;

async function twoOwners(options: Parameters<DashboardHarness['start']>[0] = {}, config: Parameters<DashboardHarness['start']>[1] = {}) {
  const started = await harness.start({ readiness: { autoStart: false }, dashboardEvents: FAST, ...options }, config);
  const alice = new Browser(started.baseUrl);
  await alice.setup('alice', 'alice-password-1234');
  const user = await alice.call('POST', '/api/v1/admin/users', { username: 'bob', password: 'bob-password-12345', display_name: 'Bob' });
  expect(user.status).toBe(201);
  const bob = new Browser(started.baseUrl);
  await bob.login('bob', 'bob-password-12345');
  const aliceVault = (await alice.call('POST', '/api/v1/vaults', { display_name: 'Alice Vault' })).body.vault_id as string;
  const bobVault = (await bob.call('POST', '/api/v1/vaults', { display_name: 'Bob Vault' })).body.vault_id as string;
  return { ...started, alice, bob, aliceVault, bobVault };
}

describe('GET /api/v1/dashboard/events over real HTTP', () => {
  it('requires an owner session before anything is streamed and is same-origin only', async () => {
    const f = await twoOwners();
    const anonymous = await harness.stream(f.baseUrl, null);
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(await anonymous.text())).toMatchObject({ error: expect.anything() });
    expect(anonymous.headers['content-type']).not.toContain('text/event-stream');
    const crossSite = await harness.stream(f.baseUrl, f.alice.cookie, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await harness.stream(f.baseUrl, f.alice.cookie, { origin: 'https://evil.example' });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.headers['content-type']).not.toContain('text/event-stream');
    expect(f.server.dashboardEvents.streamCount()).toBe(0);
    const sameOrigin = await harness.stream(f.baseUrl, f.alice.cookie, {
      'sec-fetch-site': 'same-origin',
      origin: new URL(f.baseUrl).origin
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(sameOrigin.headers['cache-control']).toBe('no-store, no-transform');
    expect(sameOrigin.headers['x-accel-buffering']).toBe('no');
    expect(sameOrigin.headers['x-content-type-options']).toBe('nosniff');
    expect(sameOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(await sameOrigin.frameCount(1)).toEqual([{ event: 'refresh', data: {} }]);
    expect(sameOrigin.body.startsWith('retry: 5000\n\nevent: refresh\n')).toBe(true);
  });

  it('sends refresh first, then owner-scoped invalidations, and nothing to other accounts', async () => {
    const f = await twoOwners();
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    const bob = await harness.stream(f.baseUrl, f.bob.cookie);
    await alice.frameCount(1);
    await bob.frameCount(1);
    const renamed = await f.alice.call('PATCH', `/api/v1/vaults/${f.aliceVault}`, { display_name: 'Renamed' });
    expect(renamed.status).toBe(200);
    const frames = await alice.frameCount(2);
    expect(frames[1]).toEqual({ event: 'invalidate', data: { account: true, vault_ids: [] } });
    await settle();
    expect(bob.frames()).toEqual([{ event: 'refresh', data: {} }]);
    expect(bob.body).not.toContain(f.aliceVault);
    expect(alice.body).not.toContain(f.bobVault);
    expect(alice.body).not.toContain('Renamed');
  });

  it('notifies about vault-scoped changes with only the owner’s vault id and no content', async () => {
    const f = await twoOwners();
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    await alice.frameCount(1);
    await f.server.store.mutate((db) => {
      db.event_seq_by_vault[f.aliceVault] = 7;
      db.event_seq_by_vault[f.bobVault] = 7;
    });
    const frames = await alice.frameCount(2);
    expect(frames[1]).toEqual({ event: 'invalidate', data: { account: false, vault_ids: [f.aliceVault] } });
    expect(Object.keys((frames[1]!.data as Record<string, unknown>)).sort()).toEqual(['account', 'vault_ids']);
  });

  it('gives a reconnecting stream a fresh refresh and never replays missed invalidations', async () => {
    const f = await twoOwners();
    const first = await harness.stream(f.baseUrl, f.alice.cookie);
    await first.frameCount(1);
    first.abort();
    await vi.waitFor(() => expect(f.server.dashboardEvents.streamCount()).toBe(0));
    await f.alice.call('PATCH', `/api/v1/vaults/${f.aliceVault}`, { display_name: 'While offline' });
    const second = await harness.stream(f.baseUrl, f.alice.cookie, { 'last-event-id': '1' });
    await second.frameCount(1);
    await settle();
    expect(second.frames()).toEqual([{ event: 'refresh', data: {} }]);
  });

  it('never publishes a commit whose durable publication failed, and publishes the retry', async () => {
    const gate = { fail: false };
    const f = await twoOwners({}, { writeGate: gate });
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    await alice.frameCount(1);
    gate.fail = true;
    const failed = await f.alice.call('PATCH', `/api/v1/vaults/${f.aliceVault}`, { display_name: 'Never durable' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await settle();
    expect(alice.frames()).toHaveLength(1);
    gate.fail = false;
    const retried = await f.alice.call('PATCH', `/api/v1/vaults/${f.aliceVault}`, { display_name: 'Durable' });
    expect(retried.status).toBe(200);
    expect((await alice.frameCount(2))[1]).toEqual({ event: 'invalidate', data: { account: true, vault_ids: [] } });
  });

  it('closes the stream on logout even though dashboard state did not change, and refuses a reconnect', async () => {
    const f = await twoOwners();
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    const other = await harness.stream(f.baseUrl, f.bob.cookie);
    await alice.frameCount(1);
    await other.frameCount(1);
    const cookie = f.alice.cookie;
    expect((await f.alice.call('POST', '/api/v1/auth/logout')).status).toBe(200);
    await alice.until(() => alice.ended);
    expect(alice.frames()).toEqual([{ event: 'refresh', data: {} }]);
    expect(other.ended).toBe(false);
    expect((await harness.stream(f.baseUrl, cookie)).status).toBe(401);
    expect(f.server.dashboardEvents.streamCount()).toBe(1);
  });

  it('closes on session expiry and on account disable', async () => {
    const f = await twoOwners();
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    const bob = await harness.stream(f.baseUrl, f.bob.cookie);
    await alice.frameCount(1);
    await bob.frameCount(1);
    await f.server.store.mutate((db) => {
      const session = db.sessions.find((candidate) => candidate.user_id === db.users.find((user) => user.username === 'alice')!.user_id)!;
      session.expires_at = new Date(Date.now() - 1_000).toISOString();
    });
    await alice.until(() => alice.ended);
    expect(alice.frames()).toHaveLength(1);
    await f.server.store.mutate((db) => { db.users.find((user) => user.username === 'bob')!.disabled = true; });
    await bob.until(() => bob.ended);
    expect(f.server.dashboardEvents.streamCount()).toBe(0);
  });

  it('closes on idle expiry detected by the no-touch heartbeat without persisting anything', async () => {
    const f = await twoOwners({ dashboardEvents: { ...FAST, heartbeatMs: 30 } });
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    await alice.frameCount(1);
    await alice.until(() => alice.body.includes(': keep-alive'));
    const before = f.writes.count;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await alice.until(() => alice.ended);
    vi.useRealTimers();
    expect(f.writes.count).toBe(before);
  });

  it('releases the registration when the client disconnects', async () => {
    const f = await twoOwners();
    const streams = await Promise.all([1, 2, 3].map(async () => await harness.stream(f.baseUrl, f.alice.cookie)));
    await Promise.all(streams.map(async (stream) => await stream.frameCount(1)));
    expect(f.server.dashboardEvents.streamCount()).toBe(3);
    for (const stream of streams) stream.abort();
    await vi.waitFor(() => expect(f.server.dashboardEvents.streamCount()).toBe(0));
  });

  it('caps streams per session and per account with a bounded JSON error', async () => {
    const f = await twoOwners({ dashboardEvents: { ...FAST, maxStreamsPerSession: 2, maxStreamsPerAccount: 3, maxStreams: 4 } });
    const open = [await harness.stream(f.baseUrl, f.alice.cookie), await harness.stream(f.baseUrl, f.alice.cookie)];
    await Promise.all(open.map(async (stream) => await stream.frameCount(1)));
    const refused = await harness.stream(f.baseUrl, f.alice.cookie);
    expect(refused.status).toBe(429);
    expect(JSON.parse(await refused.text())).toMatchObject({ error: expect.anything() });
    expect(f.server.dashboardEvents.streamCount()).toBe(2);
    expect(open.every((stream) => !stream.ended)).toBe(true);
    const admitted = await harness.stream(f.baseUrl, f.bob.cookie);
    expect(admitted.status).toBe(200);
  });

  it('causes no persistence writes and no invalidation from heartbeats or from dashboard fetches', async () => {
    const f = await twoOwners({ dashboardEvents: { ...FAST, heartbeatMs: 20 } });
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    await alice.frameCount(1);
    const before = f.writes.count;
    for (let index = 0; index < 5; index += 1) {
      expect((await f.alice.call('GET', `/api/v1/vaults/${f.aliceVault}/dashboard`)).status).toBe(200);
    }
    await alice.until(() => (alice.body.match(/: keep-alive/gu) ?? []).length >= 2);
    expect(f.writes.count).toBe(before);
    expect(alice.frames()).toHaveLength(1);
  });

  it('matches the OpenAPI operation for headers, status codes and event payload shapes', async () => {
    const document = parse(await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')) as {
      paths: Record<string, { get: { responses: Record<string, { headers?: Record<string, { schema: { const: string } }> }> } }>;
      components: { schemas: Record<string, { required: string[]; properties: Record<string, { maxItems?: number; items?: { pattern: string } }> }> };
    };
    const operation = document.paths['/dashboard/events']!.get;
    const f = await twoOwners({ dashboardEvents: { ...FAST, maxStreamsPerSession: 1 } });
    const stream = await harness.stream(f.baseUrl, f.alice.cookie);
    const declared = operation.responses['200']!.headers!;
    expect(stream.status).toBe(200);
    expect(stream.headers['cache-control']).toBe(declared['Cache-Control']!.schema.const);
    expect(stream.headers['x-accel-buffering']).toBe(declared['X-Accel-Buffering']!.schema.const);
    const refused = await harness.stream(f.baseUrl, f.alice.cookie);
    const anonymous = await harness.stream(f.baseUrl, null);
    const crossSite = await harness.stream(f.baseUrl, f.alice.cookie, { 'sec-fetch-site': 'cross-site' });
    for (const [response, status] of [[refused, 429], [anonymous, 401], [crossSite, 403]] as const) {
      expect(response.status).toBe(status);
      expect(Object.keys(operation.responses)).toContain(String(status));
    }
    await f.server.store.mutate((db) => { db.event_seq_by_vault[f.aliceVault] = 3; });
    const frames = await stream.frameCount(2);
    const schema = document.components.schemas.DashboardInvalidation!;
    const payload = frames[1]!.data as { account: boolean; vault_ids: string[] };
    expect(Object.keys(payload).sort()).toEqual([...schema.required].sort());
    expect(typeof payload.account).toBe('boolean');
    expect(payload.vault_ids.length).toBeLessThanOrEqual(schema.properties.vault_ids!.maxItems!);
    for (const id of payload.vault_ids) expect(id).toMatch(new RegExp(schema.properties.vault_ids!.items!.pattern, 'u'));
    expect(frames[0]).toEqual({ event: 'refresh', data: {} });
  });

  it('pushes a background readiness verdict change to every open stream and stays quiet when it is unchanged', async () => {
    const f = await twoOwners({ readiness: { autoStart: false, intervalMs: 40 } });
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    const bob = await harness.stream(f.baseUrl, f.bob.cookie);
    await alice.frameCount(1);
    await bob.frameCount(1);
    const invalidations = (stream: typeof alice) => stream.frames().filter((frame) => frame.event === 'invalidate');
    const everything = { event: 'invalidate', data: { account: true, vault_ids: [] } };

    f.server.readiness.start();
    await vi.waitFor(() => expect(invalidations(alice)).toEqual([everything]));
    await vi.waitFor(() => expect(invalidations(bob)).toEqual([everything]));
    await settle(200);
    expect(invalidations(alice)).toHaveLength(1);
    expect(invalidations(bob)).toHaveLength(1);

    vi.spyOn(f.server.git, 'checkReady').mockResolvedValue({ ok: false, error: 'git unavailable' });
    await vi.waitFor(() => expect(invalidations(alice)).toHaveLength(2));
    await vi.waitFor(() => expect(invalidations(bob)).toHaveLength(2));
    await settle(200);
    expect(invalidations(alice)).toHaveLength(2);
    expect(f.server.readiness.view().summary).toMatchObject({ status: 'not_ready' });

    vi.restoreAllMocks();
    await vi.waitFor(() => expect(invalidations(alice)).toHaveLength(3));
    expect(invalidations(bob)).toEqual([everything, everything, everything]);
    expect(alice.body).not.toContain(f.aliceVault);
    expect(bob.body).not.toContain(f.bobVault);
    expect(alice.body).not.toContain('git unavailable');
  });

  it('terminates open streams promptly on shutdown', async () => {
    const f = await twoOwners();
    const alice = await harness.stream(f.baseUrl, f.alice.cookie);
    await alice.frameCount(1);
    const started = Date.now();
    await f.server.app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    await alice.until(() => alice.ended);
    expect(f.server.dashboardEvents.streamCount()).toBe(0);
  });
});
