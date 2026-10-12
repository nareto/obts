import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeDashboardImpact, DashboardEventHub, type DashboardEventOptions, type StreamSink } from '../src/server/dashboardEvents.js';
import type { MetadataDb } from '../src/server/metadataStore.js';
import { createStoreFixture, removeRoots, DAY, MINUTE, type StoreFixture } from './helpers/dashboardStoreFixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await removeRoots(roots);
});

const settle = async (ms = 40) => await new Promise((resolve) => setTimeout(resolve, ms));

describe('owner-visible change projection', () => {
  async function change(f: StoreFixture, mutate: (db: MetadataDb) => void, watched: string[] = []) {
    const previous = await f.store.snapshot();
    await f.store.mutate(mutate);
    return computeDashboardImpact(previous, await f.store.snapshot(), new Set(watched));
  }
  const owners = (impact: ReturnType<typeof computeDashboardImpact>) =>
    Object.fromEntries([...impact.owners].map(([user, value]) => [user, { account: value.account, vaults: [...value.vaults].sort() }]));

  it('ignores session liveness, device heartbeats and unrelated bookkeeping', async () => {
    const f = await createStoreFixture(roots);
    const later = new Date(f.now + MINUTE).toISOString();
    const impact = await change(f, (db) => {
      db.sessions[0]!.last_seen_at = later;
      db.sessions[0]!.idle_expires_at = new Date(f.now + 8 * DAY).toISOString();
      db.devices[0]!.last_seen_at = later;
      db.devices[0]!.last_status_report_at = later;
      db.devices[0]!.last_successful_sync_at = later;
      db.vaults[0]!.updated_at = later;
      db.users[0]!.last_login_at = later;
      db.audit_log.push({ audit_id: 'aud_1', actor_user_id: 'usr_a', actor_device_id: null, vault_id: 'vlt_a',
        action: 'x', resource_class: 'vault', resource_id: 'vlt_a', created_at: f.timestamp });
    }, ['ses_a']);
    expect(owners(impact)).toEqual({});
    expect(impact.sessions.size).toBe(0);
    expect(impact.users.size).toBe(0);
  });

  it('names only the owner and vault for device, event-activity and main changes', async () => {
    const f = await createStoreFixture(roots);
    expect(owners(await change(f, (db) => { db.devices[0]!.status = 'ahead'; }))).toEqual({ usr_a: { account: false, vaults: ['vlt_a'] } });
    expect(owners(await change(f, (db) => { db.devices[1]!.local_status_label = 'Offline'; }))).toEqual({ usr_b: { account: false, vaults: ['vlt_b'] } });
    expect(owners(await change(f, (db) => { db.event_seq_by_vault.vlt_a2 = 4; }))).toEqual({ usr_a: { account: false, vaults: ['vlt_a2'] } });
    expect(owners(await change(f, (db) => { db.vaults[0]!.current_main = 'b'.repeat(40); }))).toEqual({ usr_a: { account: false, vaults: ['vlt_a'] } });
  });

  it('marks the account for renames, status, users, deletion and removal', async () => {
    const f = await createStoreFixture(roots);
    expect(owners(await change(f, (db) => { db.vaults[0]!.display_name = 'renamed'; })))
      .toEqual({ usr_a: { account: true, vaults: ['vlt_a'] } });
    expect(owners(await change(f, (db) => { db.vaults[2]!.status = 'blocked_integrity'; })))
      .toEqual({ usr_b: { account: true, vaults: ['vlt_b'] } });
    expect(owners(await change(f, (db) => { db.users[0]!.display_name = 'Alice'; }))).toEqual({ usr_a: { account: true, vaults: [] } });
    expect(owners(await change(f, (db) => {
      db.deletion_jobs.push({ vault_id: 'vlt_a2', owner_user_id: 'usr_a', requested_at: f.timestamp, phase: 'intent', retry_at: null, error_code: null });
    }))).toEqual({ usr_a: { account: true, vaults: ['vlt_a2'] } });
    expect(owners(await change(f, (db) => { db.vaults = db.vaults.filter((vault) => vault.vault_id !== 'vlt_a2'); })))
      .toEqual({ usr_a: { account: true, vaults: ['vlt_a2'] } });
  });

  it('flags authority changes for the watched session or user only', async () => {
    const f = await createStoreFixture(roots);
    const revoked = await change(f, (db) => { db.sessions[0]!.revoked_at = f.timestamp; }, ['ses_a', 'ses_b']);
    expect([...revoked.sessions]).toEqual(['ses_a']);
    const disabled = await change(f, (db) => { db.users[1]!.disabled = true; });
    expect([...disabled.users]).toEqual(['usr_b']);
    const unwatched = await change(f, (db) => { db.sessions[1]!.revoked_at = f.timestamp; }, ['ses_a']);
    expect(unwatched.sessions.size).toBe(0);
  });
});

class FakeSink implements StreamSink {
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  accept = true;
  writableLength = 0;
  private readonly handlers = new Map<string, Set<() => void>>();
  get writableEnded(): boolean { return this.ended; }
  write(chunk: string): boolean { this.chunks.push(chunk); return this.accept; }
  end(): void { this.ended = true; this.emit('close'); }
  destroy(): void { this.destroyed = true; this.emit('close'); }
  once(event: 'drain' | 'close', listener: () => void): void {
    this.set(event).add(listener);
  }
  removeListener(event: 'drain' | 'close', listener: () => void): void {
    this.set(event).delete(listener);
  }
  emit(event: 'drain' | 'close'): void {
    for (const handler of [...this.set(event)]) {
      this.set(event).delete(handler);
      handler();
    }
  }
  listenerCount(event: 'drain' | 'close'): number { return this.set(event).size; }
  text(): string { return this.chunks.join(''); }
  events(): Array<{ event: string; data: unknown }> {
    return this.text().split('\n\n').filter((block) => block.includes('event:')).map((block) => ({
      event: /^event: (.+)$/mu.exec(block)![1]!,
      data: JSON.parse(/^data: (.+)$/mu.exec(block)![1]!) as unknown
    }));
  }
  private set(event: string): Set<() => void> {
    let found = this.handlers.get(event);
    if (!found) this.handlers.set(event, (found = new Set()));
    return found;
  }
}

describe('dashboard event hub', () => {
  async function hubFixture(options: DashboardEventOptions = {}) {
    const f = await createStoreFixture(roots);
    const unsubscribe = vi.fn();
    const store = {
      subscribeCommits: vi.fn((listener: Parameters<typeof f.store.subscribeCommits>[0]) => {
        const off = f.store.subscribeCommits(listener);
        return () => { unsubscribe(); off(); };
      })
    };
    const hub = new DashboardEventHub(
      store,
      async (sessionId) => await f.auth.authenticateSession(sessionId, { touch: false }),
      { coalesceMs: 5, heartbeatMs: 10_000, retryMs: 1234, ...options }
    );
    const open = (sessionId = 'ses_a', userId = 'usr_a') => {
      const sink = new FakeSink();
      const closed = vi.fn();
      hub.attach(sink, { userId, sessionId }, closed);
      return { sink, closed };
    };
    return { ...f, hub, unsubscribe, open };
  }

  it('opens with a retry hint and the fixed refresh frame, never replaying history', async () => {
    const f = await hubFixture();
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    const { sink } = f.open();
    expect(sink.text()).toBe('retry: 1234\n\nevent: refresh\ndata: {}\n\n');
    await settle();
    expect(sink.events()).toEqual([{ event: 'refresh', data: {} }]);
    f.hub.close();
  });

  it('publishes coalesced owner-scoped invalidations for visible changes only', async () => {
    const f = await hubFixture();
    const a = f.open('ses_a', 'usr_a');
    const b = f.open('ses_b', 'usr_b');
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await f.store.mutate((db) => { db.devices[0]!.local_status_label = 'Synced'; });
    await f.store.mutate((db) => { db.vaults[1]!.display_name = 'renamed'; });
    await settle();
    expect(a.sink.events()).toEqual([
      { event: 'refresh', data: {} },
      { event: 'invalidate', data: { account: true, vault_ids: [] } }
    ]);
    expect(b.sink.events()).toEqual([{ event: 'refresh', data: {} }]);
    await f.store.mutate((db) => { db.devices[1]!.status = 'ahead'; });
    await settle();
    expect(b.sink.events().at(-1)).toEqual({ event: 'invalidate', data: { account: false, vault_ids: ['vlt_b'] } });
    expect(JSON.stringify(a.sink.events())).not.toContain('vlt_b');
    f.hub.close();
  });

  it('lists only changed vault ids of the stream owner when nothing is account-level', async () => {
    const f = await hubFixture();
    const a = f.open();
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; db.event_seq_by_vault.vlt_a2 = 9; db.event_seq_by_vault.vlt_b = 9; });
    await settle();
    expect(a.sink.events().at(-1)).toEqual({ event: 'invalidate', data: { account: false, vault_ids: ['vlt_a', 'vlt_a2'] } });
    f.hub.close();
  });

  it('stays silent for session touches, device heartbeats and other accounts (no fetch/touch/invalidate loop)', async () => {
    const f = await hubFixture();
    const a = f.open();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let index = 1; index <= 3; index += 1) {
      vi.setSystemTime(f.now + index * 2 * MINUTE);
      await f.auth.authenticateSession('ses_a');
    }
    const later = new Date().toISOString();
    await f.store.mutate((db) => { db.devices[0]!.last_seen_at = later; db.devices[0]!.last_status_report_at = later; });
    await f.store.mutate((db) => { db.devices[1]!.status = 'ahead'; });
    expect(f.writes.mock.calls.length).toBeGreaterThan(0);
    vi.useRealTimers();
    await settle(30);
    expect(a.sink.events()).toEqual([{ event: 'refresh', data: {} }]);
    f.hub.close();
  });

  it('never publishes a state whose durable publication failed', async () => {
    const f = await hubFixture();
    const a = f.open();
    f.writes.mockRejectedValueOnce(new Error('disk refused'));
    await expect(f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; })).rejects.toThrow();
    await settle();
    expect(a.sink.events()).toHaveLength(1);
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await settle();
    expect(a.sink.events()).toHaveLength(2);
    f.hub.close();
  });

  it('degrades an overflowing id set to a full account refresh', async () => {
    const f = await hubFixture({ maxVaultIdsPerMessage: 2 });
    const a = f.open();
    await f.store.mutate((db) => {
      for (const id of ['x1', 'x2', 'x3']) db.event_seq_by_vault[id] = 1;
      db.vaults.push(...['x1', 'x2', 'x3'].map((id) => ({ ...db.vaults[0]!, vault_id: id })));
    });
    await settle();
    expect(a.sink.events().at(-1)).toEqual({ event: 'invalidate', data: { account: true, vault_ids: [] } });
    f.hub.close();
  });

  it('closes on logout and disable even though dashboard state is otherwise unchanged', async () => {
    const f = await hubFixture();
    const byLogout = f.open('ses_a', 'usr_a');
    const byDisable = f.open('ses_b', 'usr_b');
    await f.auth.logout('ses_a');
    await settle();
    expect(byLogout.sink.ended).toBe(true);
    expect(byLogout.closed).toHaveBeenCalledTimes(1);
    expect(byLogout.sink.events()).toEqual([{ event: 'refresh', data: {} }]);
    expect(f.hub.streamCount()).toBe(1);
    await f.store.mutate((db) => { db.users[1]!.disabled = true; });
    await settle();
    expect(byDisable.sink.ended).toBe(true);
    expect(f.hub.streamCount()).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('checks expiry on heartbeat without touching liveness, and writes keep-alive comments otherwise', async () => {
    const f = await hubFixture({ heartbeatMs: 20 });
    const a = f.open();
    await settle(70);
    expect(a.sink.text()).toContain(': keep-alive\n\n');
    expect(a.sink.events()).toEqual([{ event: 'refresh', data: {} }]);
    expect(f.writes).not.toHaveBeenCalled();
    expect((await f.store.snapshot()).sessions[0]!.last_seen_at).toBe(f.timestamp);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.now + 31 * DAY);
    await vi.waitFor(() => expect(a.sink.ended).toBe(true));
    expect(f.hub.streamCount()).toBe(0);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('fails closed when current authority cannot be read', async () => {
    const f = await createStoreFixture(roots);
    let available = true;
    const hub = new DashboardEventHub(f.store, async (sessionId) => {
      if (!available) throw new Error('metadata unavailable');
      return await f.auth.authenticateSession(sessionId, { touch: false });
    }, { coalesceMs: 5, heartbeatMs: 20 });
    const sink = new FakeSink();
    hub.attach(sink, { userId: 'usr_a', sessionId: 'ses_a' }, () => undefined);
    await settle(50);
    expect(sink.ended).toBe(false);
    available = false;
    await vi.waitFor(() => expect(sink.ended).toBe(true));
    expect(hub.streamCount()).toBe(0);
    expect(sink.text()).not.toContain('invalidate');
    hub.close();
  });

  it('releases listeners, timers and the subscription on disconnect', async () => {
    const f = await hubFixture({ heartbeatMs: 10 });
    const a = f.open();
    const b = f.open();
    expect(f.hub.streamCount()).toBe(2);
    a.sink.emit('close');
    expect(f.hub.streamCount()).toBe(1);
    expect(a.closed).toHaveBeenCalledTimes(1);
    expect(a.sink.listenerCount('close')).toBe(0);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    b.sink.emit('close');
    expect(f.hub.streamCount()).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    const before = b.sink.chunks.length;
    await settle(40);
    expect(b.sink.chunks.length).toBe(before);
  });

  it('closes every stream and refuses new ones after close', async () => {
    const f = await hubFixture();
    const a = f.open();
    const b = f.open('ses_b', 'usr_b');
    f.hub.close();
    expect(a.sink.ended && b.sink.ended).toBe(true);
    expect(a.closed).toHaveBeenCalledTimes(1);
    expect(f.hub.streamCount()).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('enforces global, per-account and per-session caps without leaking registrations', async () => {
    const f = await hubFixture({ maxStreams: 3, maxStreamsPerAccount: 2, maxStreamsPerSession: 1 });
    f.open('ses_a', 'usr_a');
    expect(() => f.open('ses_a', 'usr_a')).toThrow(expect.objectContaining({ statusCode: 429, code: 'stream_limit' }));
    await f.store.mutate((db) => { db.sessions.push({ ...db.sessions[0]!, session_id: 'ses_a2' }); });
    f.open('ses_a2', 'usr_a');
    await f.store.mutate((db) => { db.sessions.push({ ...db.sessions[0]!, session_id: 'ses_a3' }); });
    expect(() => f.open('ses_a3', 'usr_a')).toThrow(expect.objectContaining({ statusCode: 429 }));
    f.open('ses_b', 'usr_b');
    expect(() => f.open('ses_x', 'usr_x')).toThrow(expect.objectContaining({ statusCode: 429 }));
    expect(f.hub.streamCount()).toBe(3);
    f.hub.close();
  });

  it('bounds memory for a reader that stops draining: one pending set, then a close after the stall timeout', async () => {
    const f = await hubFixture({ stallTimeoutMs: 40 });
    const a = f.open();
    a.sink.accept = false;
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await settle(20);
    expect(a.sink.events()).toHaveLength(2);
    const written = a.sink.chunks.length;
    for (let index = 0; index < 20; index += 1) {
      await f.store.mutate((db) => { db.event_seq_by_vault.vlt_a = (db.event_seq_by_vault.vlt_a ?? 0) + 1; });
    }
    await settle(20);
    expect(a.sink.chunks.length).toBe(written);
    await vi.waitFor(() => expect(a.sink.destroyed).toBe(true));
    expect(f.hub.streamCount()).toBe(0);
    expect(a.closed).toHaveBeenCalledTimes(1);
  });

  it('resumes with one coalesced message when a slow reader drains in time', async () => {
    const f = await hubFixture({ stallTimeoutMs: 1_000 });
    const a = f.open();
    a.sink.accept = false;
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await settle(20);
    await f.store.mutate((db) => { db.event_seq_by_vault.vlt_a2 = 3; });
    await f.store.mutate((db) => { db.event_seq_by_vault.vlt_a2 = 4; });
    await settle(20);
    a.sink.accept = true;
    a.sink.emit('drain');
    await settle(30);
    expect(a.sink.events().slice(2)).toEqual([{ event: 'invalidate', data: { account: false, vault_ids: ['vlt_a2'] } }]);
    expect(a.sink.destroyed).toBe(false);
    f.hub.close();
  });

  it('treats a writable buffer above the byte cap as backpressure even when write() accepted', async () => {
    const f = await hubFixture({ stallTimeoutMs: 30, maxWritableBytes: 10 });
    const a = f.open();
    a.sink.writableLength = 100;
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await vi.waitFor(() => expect(a.sink.destroyed).toBe(true));
  });

  it('broadcasts one coalesced account invalidation to every open stream without per-owner data', async () => {
    const f = await hubFixture();
    const a = f.open('ses_a', 'usr_a');
    const b = f.open('ses_b', 'usr_b');
    f.hub.broadcastAccountInvalidation();
    f.hub.broadcastAccountInvalidation();
    await settle();
    for (const stream of [a, b]) {
      expect(stream.sink.events()).toEqual([
        { event: 'refresh', data: {} },
        { event: 'invalidate', data: { account: true, vault_ids: [] } }
      ]);
    }
    f.hub.broadcastAccountInvalidation();
    await settle();
    expect(a.sink.events()).toHaveLength(3);
    f.hub.close();
    f.hub.broadcastAccountInvalidation();
    expect(a.sink.events()).toHaveLength(3);
  });

  it('keeps a broadcast bounded under backpressure and delivers it once after the reader drains', async () => {
    const f = await hubFixture({ stallTimeoutMs: 1_000 });
    const slow = f.open('ses_a', 'usr_a');
    const fast = f.open('ses_b', 'usr_b');
    slow.sink.accept = false;
    await f.store.mutate((db) => { db.devices[0]!.status = 'ahead'; });
    await settle(20);
    const written = slow.sink.chunks.length;
    for (let index = 0; index < 10; index += 1) f.hub.broadcastAccountInvalidation();
    await settle(20);
    expect(slow.sink.chunks.length).toBe(written);
    expect(fast.sink.events().filter((event) => event.event === 'invalidate')).toEqual([
      { event: 'invalidate', data: { account: true, vault_ids: [] } }
    ]);
    slow.sink.accept = true;
    slow.sink.emit('drain');
    await settle(30);
    expect(slow.sink.chunks.length).toBe(written + 1);
    expect(slow.sink.events().at(-1)).toEqual({ event: 'invalidate', data: { account: true, vault_ids: [] } });
    f.hub.close();
  });

  it('still re-authorizes a stream before a broadcast frame is written', async () => {
    const f = await hubFixture();
    const a = f.open('ses_a', 'usr_a');
    await f.store.mutate((db) => { db.sessions.find((session) => session.session_id === 'ses_a')!.revoked_at = new Date().toISOString(); });
    f.hub.broadcastAccountInvalidation();
    await settle();
    expect(a.sink.events().filter((event) => event.event === 'invalidate')).toEqual([]);
    expect(f.hub.streamCount()).toBe(0);
  });
});
