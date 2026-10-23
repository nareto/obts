import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { mobileHarness } from './helpers/mobileOnboardingHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(request: (request: any, send: () => Promise<any>) => Promise<any>) {
  const root = await mkdtemp(join(process.cwd(), 'tmp/plugin-request-deadline-'));
  const client = await mobileHarness(root, 'http://127.0.0.1:1', { request, platform: 'android' });
  cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
  return { ...client, root };
}

describe('plugin network deadlines', () => {
  it('fails a request the platform never answers instead of pinning the operation', async () => {
    const client = await fixture(async () => await new Promise(() => {}));
    // The plugin schedules its deadline through the runtime timer the harness
    // exposes, so a fast timer makes the bounded wait observable in-process.
    client.context.setTimeout = (callback: () => void) => setImmediate(callback);

    await expect(client.core.getDeviceSelf('synthetic-token')).rejects.toMatchObject({
      status: 0,
      code: 'request_timeout'
    });
  });

  it('keeps an answered request on the ordinary path', async () => {
    const client = await fixture(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '{"device_id":"dev_synthetic"}',
      json: { device_id: 'dev_synthetic' }
    }));
    client.context.setTimeout = (callback: () => void) => setImmediate(callback);

    expect(await client.core.getDeviceSelf('synthetic-token')).toMatchObject({ device_id: 'dev_synthetic' });
  });
});
