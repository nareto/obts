import { describe, expect, it, vi } from 'vitest';

import { HeadlessSession, type HeadlessClient, type HeadlessMessage } from '../src/client/headlessProtocol.js';

const state = {
  user_id: null,
  vault_id: null,
  device_id: null,
  device_name: null,
  device_ref: null,
  server_device_ref: null,
  local_main: null,
  local_head: null,
  initial_import_confirmed: false,
  status_label: 'Checking',
  last_error_code: null,
  last_event_seq: 0,
  unpaired_baseline_vault_id: null,
  unpaired_baseline_main: null,
  updated_at: '2026-07-19T00:00:00.000Z'
};

function fakeClient(overrides: Partial<HeadlessClient> = {}): HeadlessClient {
  return {
    initialize: vi.fn(async () => undefined),
    readState: vi.fn(async () => state),
    readQueue: vi.fn(async () => ({ pending_commit: null, expected_device_ref: null, status: 'idle', attempts: 0, updated_at: state.updated_at })),
    readPendingOnboarding: vi.fn(async () => null),
    readIndexDelta: vi.fn(async () => ({ head: null, base: null, mode: 'unavailable', files: [], changes: [] })),
    startOnboarding: vi.fn(async () => ({ connection_id: 'connection', connection_secret: 'secret', expires_at: state.updated_at, browser_url: 'https://example.test' })),
    pollOnboarding: vi.fn(async () => ({ status: 'pending' } as never)),
    analyzeOnboarding: vi.fn(async () => ({ classification: 'new_empty' } as never)),
    finishOnboarding: vi.fn(async () => ({ status: 'Synced' })),
    cancelOnboarding: vi.fn(async () => undefined),
    recordLocalChangeHint: vi.fn(async () => undefined),
    syncOnce: vi.fn(async () => ({ status: 'Synced' })),
    pollRemoteEventsAndApply: vi.fn(async () => ({ applied: false, status: 'Synced' })),
    replaceLocalWithServer: vi.fn(async () => ({ status: 'Synced', main: 'abc' })),
    rebuildFromServerMain: vi.fn(async () => ({ status: 'Synced', main: 'abc' })),
    renameCurrentDevice: vi.fn(async (name) => name),
    unpairCurrentDevice: vi.fn(async () => ({ status: 'Not paired' })),
    resetLocalPairingState: vi.fn(async () => ({ status: 'Not paired', recoveryBundleId: null })),
    ...overrides
  } as HeadlessClient;
}

describe('headless client protocol', () => {
  it('emits ready and correlated responses without exposing implementation logs', async () => {
    const messages: HeadlessMessage[] = [];
    const client = fakeClient();
    const session = new HeadlessSession(client, async (message) => void messages.push(message));

    await session.start();
    await session.submit({ id: 1, command: 'read-state' });

    expect(messages).toEqual([
      { type: 'event', event: 'ready', state },
      { type: 'response', id: 1, ok: true, result: state }
    ]);
  });

  it('serializes overlapping commands', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const client = fakeClient({
      syncOnce: vi.fn(async () => {
        order.push('sync-start');
        await blocked;
        order.push('sync-end');
        return { status: 'Synced' };
      }),
      readState: vi.fn(async () => {
        order.push('read-state');
        return state;
      })
    });
    const session = new HeadlessSession(client, async () => undefined);

    const first = session.submit({ id: 1, command: 'sync-once' });
    const second = session.submit({ id: 2, command: 'read-state' });
    await vi.waitFor(() => expect(order).toContain('sync-start'));
    expect(order).not.toContain('read-state');
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['sync-start', 'sync-end', 'read-state', 'read-state']);
  });

  it('returns stable errors and continues after malformed requests', async () => {
    const messages: HeadlessMessage[] = [];
    const session = new HeadlessSession(fakeClient(), async (message) => void messages.push(message));

    await session.submit({ id: 'bad' });
    await session.submit({ id: 'unknown', command: 'does-not-exist' });
    await session.submit({ id: 'good', command: 'read-state' });

    expect(messages[0]).toMatchObject({ type: 'response', id: 'bad', ok: false, error: { code: 'invalid_request' } });
    expect(messages[1]).toMatchObject({ type: 'response', id: 'unknown', ok: false, error: { code: 'unknown_command' } });
    expect(messages[2]).toMatchObject({ type: 'response', id: 'good', ok: true });
  });

  it('returns commit-index deltas without changing client state', async () => {
    const messages: HeadlessMessage[] = [];
    const readIndexDelta = vi.fn(async () => ({
      head: 'b'.repeat(40),
      base: 'a'.repeat(40),
      mode: 'incremental' as const,
      files: [{ path: 'Notes/test.md', oid: 'c'.repeat(40), content_sha256: 'd'.repeat(64) }],
      changes: [{
        path: 'Notes/test.md',
        kind: 'modify' as const,
        oid: 'c'.repeat(40),
        content_sha256: 'd'.repeat(64)
      }]
    }));
    const session = new HeadlessSession(fakeClient({ readIndexDelta }), async (message) => void messages.push(message));

    await session.submit({ id: 1, command: 'read-index-delta', fromCommit: 'a'.repeat(40) });

    expect(readIndexDelta).toHaveBeenCalledWith('a'.repeat(40));
    expect(messages).toEqual([{ type: 'response', id: 1, ok: true, result: await readIndexDelta.mock.results[0]!.value }]);
  });

  it('passes filesystem change hints and requests immediate synchronization', async () => {
    const client = fakeClient();
    const session = new HeadlessSession(client, async () => undefined);

    await session.submit({ id: 1, command: 'record-local-change', paths: ['Notes/test.md'] });
    await session.submit({ id: 2, command: 'sync-once' });

    expect(client.recordLocalChangeHint).toHaveBeenCalledWith(['Notes/test.md']);
    expect(client.syncOnce).toHaveBeenCalledWith({});
  });
});
