import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { mobileHarness } from './helpers/mobileOnboardingHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  await mkdir('tmp/diagnostic-client-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/diagnostic-client-tests/client-'));
  let code = 'diagnostic_rate_limited';
  const client = await mobileHarness(root, 'http://127.0.0.1:1', { request: async () => ({
    status: 429, headers: {}, arrayBuffer: new ArrayBuffer(0), text: JSON.stringify({ error: { code, message: 'private response canary' } })
  }) });
  cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
  await client.core.writeState({ ...await client.core.readState(), vault_id: 'vault', device_id: 'device', last_error_code: 'device_blocked' });
  client.core.readDeviceToken = async () => 'synthetic';
  await client.plugin.setDiagnosticSharing(true);
  return { ...client, setCode(value: string) { code = value; } };
}

describe('packaged diagnostic admission behavior', () => {
  it('coalesces fresh automatic errors and failed snapshots while preserving manual requests', async () => {
    const client = await fixture();
    const freshError = () => vm.runInContext("Object.assign(new Error('private error canary'), { code: 'device_blocked' })", client.context);
    await Promise.all([client.plugin.reportErrorDiagnostic(freshError(), null), client.plugin.reportErrorDiagnostic(freshError(), null)]);
    expect(client.requests).toHaveLength(1);
    await client.plugin.reportErrorDiagnostic(freshError(), null);
    expect(client.requests).toHaveLength(1);
    await client.plugin.sendTroubleshootingSnapshot('reconcile_failure', { safeErrorCode: 'device_blocked' });
    await client.plugin.sendTroubleshootingSnapshot('reconcile_failure', { safeErrorCode: 'device_blocked' });
    expect(client.requests).toHaveLength(2);
    await client.plugin.sendTroubleshootingSnapshotNow();
    expect(client.requests).toHaveLength(3);
    expect(client.notices.at(-1)).toContain('HTTP 429, diagnostic_rate_limited');
    expect(client.notices.join(' ')).not.toContain('private');
    expect(client.notices.join(' ')).not.toContain('synthetic');
  });

  it('omits unknown rejection codes and raw server messages from notices', async () => {
    const client = await fixture();
    client.setCode('private-path-and-credential-canary');
    await client.plugin.sendTroubleshootingSnapshotNow();
    expect(client.notices.at(-1)).toContain('HTTP 429');
    expect(client.notices.at(-1)).not.toContain('private');
  });
});
