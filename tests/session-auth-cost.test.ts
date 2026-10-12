import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError } from '../src/server/authService.js';
import { createStoreFixture, removeRoots, DAY, MINUTE, type StoreFixture } from './helpers/dashboardStoreFixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await removeRoots(roots);
});

const fixture = async () => await createStoreFixture(roots);

describe('coalesced, authoritative session authentication', () => {
  it('persists nothing inside the minute and exactly once for concurrent calls at the boundary', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.now + MINUTE - 1);
    for (let index = 0; index < 25; index += 1) await f.auth.authenticateSession('ses_a');
    expect(f.writes).not.toHaveBeenCalled();
    vi.setSystemTime(f.now + MINUTE);
    await Promise.all(Array.from({ length: 25 }, () => f.auth.authenticateSession('ses_a')));
    expect(f.writes).toHaveBeenCalledTimes(1);
    const touched = (await f.store.snapshot()).sessions.find((session) => session.session_id === 'ses_a')!;
    expect(Date.parse(touched.last_seen_at)).toBe(f.now + MINUTE);
    vi.setSystemTime(f.now + 2 * MINUTE - 1);
    await f.auth.authenticateSession('ses_a');
    expect(f.writes).toHaveBeenCalledTimes(1);
  });

  it('never extends the absolute expiry when touching liveness', async () => {
    const f = await fixture();
    const before = (await f.store.snapshot()).sessions.find((session) => session.session_id === 'ses_a')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.now + 5 * MINUTE);
    await f.auth.authenticateSession('ses_a');
    const after = (await f.store.snapshot()).sessions.find((session) => session.session_id === 'ses_a')!;
    expect(after.expires_at).toBe(before.expires_at);
    expect(Date.parse(after.idle_expires_at)).toBe(f.now + 5 * MINUTE + 7 * DAY);
  });

  it('touches again when the stored timestamp is in the future instead of trusting it', async () => {
    const f = await fixture();
    await f.store.mutate((db) => {
      db.sessions.find((session) => session.session_id === 'ses_a')!.last_seen_at = new Date(f.now + 10 * MINUTE).toISOString();
    });
    f.writes.mockClear();
    await f.auth.authenticateSession('ses_a');
    expect(f.writes).toHaveBeenCalledTimes(1);
  });

  it('never persists for a non-touching check, even long after the interval', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.now + 10 * MINUTE);
    for (let index = 0; index < 5; index += 1) await f.auth.authenticateSession('ses_a', { touch: false });
    expect(f.writes).not.toHaveBeenCalled();
    expect((await f.store.snapshot()).sessions.find((session) => session.session_id === 'ses_a')!.last_seen_at)
      .toBe(new Date(f.now).toISOString());
  });

  const revocations: Array<[string, (f: StoreFixture) => Promise<unknown>]> = [
    ['logout', async (f) => await f.auth.logout('ses_a')],
    ['revocation', async (f) => await f.store.mutate((db) => {
      db.sessions.find((session) => session.session_id === 'ses_a')!.revoked_at = new Date().toISOString();
    })],
    ['account disable', async (f) => await f.store.mutate((db) => {
      db.users.find((user) => user.user_id === 'usr_a')!.disabled = true;
    })],
    ['session removal', async (f) => await f.store.mutate((db) => {
      db.sessions = db.sessions.filter((session) => session.session_id !== 'ses_a');
    })],
    ['user removal', async (f) => await f.store.mutate((db) => {
      db.users = db.users.filter((user) => user.user_id !== 'usr_a');
    })]
  ];
  it.each(revocations)('denies immediately after %s although a positive decision was just made', async (_name, act) => {
    const f = await fixture();
    await expect(f.auth.authenticateSession('ses_a')).resolves.toMatchObject({ user: { user_id: 'usr_a' } });
    await act(f);
    f.writes.mockClear();
    await expect(f.auth.authenticateSession('ses_a')).rejects.toMatchObject({ statusCode: 401, code: 'unauthenticated' });
    await expect(f.auth.authenticateSession('ses_a', { touch: false })).rejects.toMatchObject({ statusCode: 401 });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each(['expires_at', 'idle_expires_at'] as const)('denies at %s without any write, with and without touching', async (field) => {
    const f = await fixture();
    await f.store.mutate((db) => {
      db.sessions.find((session) => session.session_id === 'ses_a')![field] = new Date(f.now + MINUTE).toISOString();
    });
    await expect(f.auth.authenticateSession('ses_a')).resolves.toBeDefined();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.now + 2 * MINUTE);
    f.writes.mockClear();
    await expect(f.auth.authenticateSession('ses_a')).rejects.toMatchObject({ statusCode: 401 });
    await expect(f.auth.authenticateSession('ses_a', { touch: false })).rejects.toMatchObject({ statusCode: 401 });
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each(['not-a-date', '', 'NaN'])('rejects the non-finite timestamp %j', async (bad) => {
    for (const field of ['expires_at', 'idle_expires_at'] as const) {
      const f = await fixture();
      await f.store.mutate((db) => {
        db.sessions.find((session) => session.session_id === 'ses_a')![field] = bad;
      });
      await expect(f.auth.authenticateSession('ses_a')).rejects.toMatchObject({ statusCode: 401 });
      await expect(f.auth.authenticateSession('ses_a', { touch: false })).rejects.toMatchObject({ statusCode: 401 });
    }
  });

  it('rejects a missing session id and returns detached rows', async () => {
    const f = await fixture();
    await expect(f.auth.authenticateSession(undefined)).rejects.toBeInstanceOf(AuthError);
    const first = await f.auth.authenticateSession('ses_a');
    first.session.revoked_at = new Date().toISOString();
    await expect(f.auth.authenticateSession('ses_a')).resolves.toBeDefined();
  });
});
