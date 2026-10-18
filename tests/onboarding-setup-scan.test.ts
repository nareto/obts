import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { click, mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';

type Harness = Awaited<ReturnType<typeof mobileHarness>>;

let root: string;
let server: ObtsServer;
let url: string;
let cookie = '';
let csrf = '';
let vaultId: string;
const harnesses: Harness[] = [];

async function request(method: string, path: string, body?: unknown, authenticated = true) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated ? { cookie, 'x-obts-csrf': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json: any = await response.json();
  if (!authenticated) {
    cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    csrf = json.csrf_token;
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

beforeEach(async () => {
  await mkdir('tmp/setup-scan', { recursive: true });
  root = await mkdtemp(join(process.cwd(), 'tmp/setup-scan/run-'));
  server = await createObtsServer({ dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: 'synthetic-session-secret-for-setup-scan' });
  url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  await request('POST', '/api/v1/setup', { username: 'owner', password: 'synthetic-test-password-1234', display_name: 'Owner' }, false);
  vaultId = (await request('POST', '/api/v1/vaults', { display_name: 'Setup scan vault' })).vault_id;
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) h.dispose();
  await server?.app.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// Capacitor's Android stat reports ctime as min(creation, last access), so a
// file written since it was last read reports a different ctime after the
// snapshot reads it, even though nothing changed.
function emulateAndroidAccessTimeCtime(h: Harness) {
  const unread = new Set<string>();
  const stat = h.adapter.stat;
  const readBinary = h.adapter.readBinary;
  h.adapter.stat = async (filePath: string) => {
    const value = await stat(filePath);
    return value && unread.has(filePath) ? { ...value, ctime: value.ctime - 1000 } : value;
  };
  h.adapter.readBinary = async (filePath: string) => {
    const bytes = await readBinary(filePath);
    unread.delete(filePath);
    return bytes;
  };
  return unread;
}

describe('setup snapshot stability', () => {
  it('replaces local contents after a settings write whose metadata changes on first read', async () => {
    const phoneRoot = join(root, 'phone');
    await mkdir(join(phoneRoot, '.obsidian'), { recursive: true });
    await writeFile(join(phoneRoot, '.obsidian', 'app.json'), '{}\n');
    const h = await mobileHarness(phoneRoot, url, { platform: 'android' });
    harnesses.push(h);
    const unread = emulateAndroidAccessTimeCtime(h);

    unread.add('.obsidian/app.json');
    await expect(h.core.localSnapshotSummary()).rejects.toThrow(/consistency checkpoint/u);

    await writeFile(join(phoneRoot, '.obsidian', 'app.json'), '{"vimMode":false}\n');
    unread.add('.obsidian/app.json');
    const modal = await h.open();
    modal.contentEl.controls.find((control: any) => control.value === 'keep').change('use_server');
    const browserAction = click(modal, 'Continue in browser');
    await waitUntil(async () => Boolean(await h.core.readPendingOnboarding()));
    const pending = await h.core.readPendingOnboarding();
    expect(pending.journal).toMatchObject({ stage: 'awaiting_browser', early_disposition: 'use_server' });
    expect(pending.journal.pending_summary.file_count).toBe(1);
    await request('POST', `/api/v1/connections/${pending.journal.connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    h.hide(); h.foreground();
    await browserAction;
    expect(modal.contentEl.allText).toContain('Replace this vault');
    await click(modal, 'Replace local contents');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('Sync is ready');
  });

  it('reports a clear retryable block when files keep changing during every attempt', async () => {
    const phoneRoot = join(root, 'phone');
    await mkdir(join(phoneRoot, '.obsidian'), { recursive: true });
    await writeFile(join(phoneRoot, '.obsidian', 'app.json'), '{}\n');
    const h = await mobileHarness(phoneRoot, url, { platform: 'android' });
    harnesses.push(h);
    const stat = h.adapter.stat;
    let calls = 0;
    h.adapter.stat = async (filePath: string) => {
      const value = await stat(filePath);
      return value && filePath === '.obsidian/app.json' ? { ...value, mtime: value.mtime + (calls += 1) } : value;
    };
    let attempts = 0;
    const summary = h.core.localSnapshotSummary.bind(h.core);
    h.core.localSnapshotSummary = async () => { attempts += 1; return summary(); };

    await expect(h.core.stableSetupSnapshotSummary()).rejects.toMatchObject({
      code: 'local_snapshot_changed',
      message: expect.stringMatching(/kept changing/u)
    });
    expect(attempts).toBe(4);
    expect(await h.core.readPendingOnboarding()).toBeNull();
  });
});
