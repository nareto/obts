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
  last_applied_event_seq: 0,
  unpaired_baseline_vault_id: null,
  unpaired_baseline_main: null,
  updated_at: '2026-07-19T00:00:00.000Z'
};

function fakeClient(overrides: Partial<HeadlessClient> = {}): HeadlessClient {
  return {
    initialize: vi.fn(async () => undefined),
    setProgressListener: vi.fn(() => undefined),
    readState: vi.fn(async () => state),
    readQueue: vi.fn(async () => ({ pending_commit: null, expected_device_ref: null, status: 'idle', attempts: 0, updated_at: state.updated_at })),
    readPendingOnboarding: vi.fn(async () => null),
    readIndexDelta: vi.fn(async () => ({ head: null, base: null, mode: 'unavailable', files: [], changes: [] })),
    maintenanceTick: vi.fn(async () => ({ applied: false, sync_performed: false, scan_mode: 'none', status: 'Synced', local_head: null })),
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

  it('emits ordered progress while a long command is active', async () => {
    const messages: HeadlessMessage[] = [];
    let progress: ((status: string, diagnosticPoint: string) => void) | null = null;
    const client = fakeClient({
      setProgressListener: vi.fn((listener) => {
        progress = listener;
      }),
      syncOnce: vi.fn(async () => {
        progress?.('Downloaded 1 sync chunk', 'sync_download');
        progress?.('Downloaded 2 sync chunks', 'sync_download');
        return { status: 'Synced' };
      })
    });
    const session = new HeadlessSession(client, async (message) => void messages.push(message));

    await session.start();
    await session.submit({ id: 1, command: 'sync-once' });
    await session.stop('test');

    expect(messages.map((message) => 'event' in message ? message.event : message.type)).toEqual([
      'ready',
      'progress',
      'progress',
      'state',
      'response',
      'stopping'
    ]);
    expect(messages[1]).toEqual({
      type: 'event',
      event: 'progress',
      status: 'Downloaded 1 sync chunk',
      diagnosticPoint: 'sync_download'
    });
    expect(client.setProgressListener).toHaveBeenLastCalledWith(null);
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
      files: [{ path: 'Notes/test.md', oid: 'c'.repeat(40) }],
      changes: [{
        path: 'Notes/test.md',
        kind: 'modify' as const,
        oid: 'c'.repeat(40)
      }]
    }));
    const session = new HeadlessSession(fakeClient({ readIndexDelta }), async (message) => void messages.push(message));

    await session.submit({ id: 1, command: 'read-index-delta', fromCommit: 'a'.repeat(40) });

    expect(readIndexDelta).toHaveBeenCalledWith('a'.repeat(40));
    expect(messages).toEqual([{
      type: 'response',
      id: 1,
      ok: true,
      result: {
        ...await readIndexDelta.mock.results[0]!.value,
        next_cursor: null,
        total_files: 1,
        total_changes: 1
      }
    }]);
  });

  it('pages large commit inventories below the protocol frame limit', async () => {
    const messages: HeadlessMessage[] = [];
    const files = Array.from({ length: 1_200 }, (_, index) => ({
      path: `Notes/${index.toString().padStart(4, '0')}-${'x'.repeat(480)}.md`,
      oid: index.toString(16).padStart(40, '0')
    }));
    const readIndexDelta = vi.fn(async () => ({
      head: 'b'.repeat(40),
      base: null,
      mode: 'rebuild' as const,
      files,
      changes: []
    }));
    const session = new HeadlessSession(fakeClient({ readIndexDelta }), async (message) => void messages.push(message));

    let cursor: number | null = 0;
    let id = 1;
    while (cursor !== null) {
      await session.submit({ id, command: 'read-index-delta', cursor });
      const response = messages.at(-1) as Extract<HeadlessMessage, { type: 'response'; ok: true }>;
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(1024 * 1024);
      cursor = (response.result as { next_cursor: number | null }).next_cursor;
      id += 1;
    }

    expect(readIndexDelta).toHaveBeenCalledOnce();
    const returnedFiles = messages.flatMap((message) =>
      message.type === 'response' && message.ok
        ? ((message.result as { files?: typeof files }).files ?? [])
        : []
    );
    expect(returnedFiles).toEqual(files);
    expect(messages.length).toBeGreaterThan(1);
  });

  it('emits changed state before the correlated response', async () => {
    const messages: HeadlessMessage[] = [];
    const session = new HeadlessSession(fakeClient(), async (message) => void messages.push(message));

    await session.submit({ id: 1, command: 'sync-once' });

    expect(messages.map((message) => 'event' in message ? message.event : message.type)).toEqual(['state', 'response']);
  });

  it('runs one scheduler-controlled maintenance tick without an implicit sync command', async () => {
    const messages: HeadlessMessage[] = [];
    const maintenanceTick = vi.fn(async () => ({
      applied: false,
      sync_performed: false,
      scan_mode: 'none' as const,
      status: 'Synced',
      local_head: 'a'.repeat(40)
    }));
    const client = fakeClient({ maintenanceTick });
    const session = new HeadlessSession(client, async (message) => void messages.push(message));

    await session.submit({ id: 1, command: 'maintenance-tick' });

    expect(maintenanceTick).toHaveBeenCalledOnce();
    expect(client.syncOnce).not.toHaveBeenCalled();
    expect(messages).toEqual([{ type: 'response', id: 1, ok: true, result: await maintenanceTick.mock.results[0]!.value }]);
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
