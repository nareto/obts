import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';

// A finished attempt is delivered by a ten-minute batch timer. Two moments must
// not wait for it: an explicit owner action, and leaving the app, where the
// platform freezes the process and takes an undelivered record with it.

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  await mkdir('tmp/sync-timing-flush-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/sync-timing-flush-tests/client-'));
  const posted: Array<Record<string, any>> = [];
  const client = await mobileHarness(root, 'http://127.0.0.1:3000', {
    request: async (request: any) => {
      if (new URL(request.url).pathname === '/api/v1/device/diagnostic-events') posted.push(JSON.parse(String(request.body)));
      return {
        status: 202,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: JSON.stringify({ status: 'accepted', event_id: 'dgr_0123456789abcdef0123456789abcdef' }),
        json: { status: 'accepted' }
      };
    }
  });
  cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
  await client.core.writeState({ ...await client.core.readState(), vault_id: 'synthetic-vault', device_id: 'synthetic-device' });
  client.core.readDeviceToken = async () => 'synthetic';
  await client.plugin.setDiagnosticSharing(true);
  await waitUntil(() => client.plugin.operationAvailability() === 'available');
  client.plugin.syncQueued = false;
  return { ...client, posted };
}

describe('sync timing delivery points', () => {
  it('delivers an already batched attempt when the owner presses Sync now', async () => {
    const { plugin, core, posted } = await fixture();

    // A background attempt that is worth recording, still waiting for its batch
    // timer.
    expect(plugin.beginSync('Background sync', 'interval')).toBe(true);
    core.noteSyncTimingApplyMode('ref_only');
    plugin.endSync(true);
    await waitUntil(() => plugin.pendingSyncTiming.length === 1);
    expect(posted).toHaveLength(0);

    // The owner's own attempt changed nothing, so it is not itself a record —
    // but it is the flush point for what is waiting.
    expect(plugin.beginSync('Sync now', 'user')).toBe(true);
    plugin.endSync(true);

    await waitUntil(() => posted.length === 1);
    expect(posted[0]!.attempts).toHaveLength(1);
    expect(posted[0]!.attempts[0]).toMatchObject({ trigger: 'interval', outcome: 'completed', apply_mode: 'ref_only' });
    expect(plugin.pendingSyncTiming).toEqual([]);
  });

  it('delivers batched timing before the platform freezes the process', async () => {
    const { plugin, core, posted } = await fixture();

    expect(plugin.beginSync('Background sync', 'interval')).toBe(true);
    core.noteSyncTimingApplyMode('full');
    plugin.endSync(true);
    await waitUntil(() => plugin.pendingSyncTiming.length === 1);
    expect(posted).toHaveLength(0);

    await plugin.handleMobileSuspension();

    await waitUntil(() => posted.length === 1);
    expect(posted[0]!.attempts[0]).toMatchObject({ trigger: 'interval', apply_mode: 'full' });
  });

  it('records nothing for a user attempt that applied and uploaded nothing', async () => {
    const { plugin, posted } = await fixture();

    expect(plugin.beginSync('Sync now', 'user')).toBe(true);
    plugin.endSync(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toHaveLength(0);
    expect(plugin.pendingSyncTiming).toEqual([]);
  });
});
