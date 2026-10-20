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

async function raw(method: string, path: string, headers: Record<string, string>, body?: string) {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, json: await response.json() as any };
}

function hasContentType(headers: Record<string, string>) {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
}

// The Android app's HTTP stack labels a POST that carries no content type as
// form data, the default of Java's HttpURLConnection, even when it has no body.
function androidFraming(request: any) {
  if (request.method === 'POST' && !hasContentType(request.headers)) {
    request.headers = { ...request.headers, 'content-type': 'application/x-www-form-urlencoded' };
  }
}

async function pairedAndroidPhone(rewrite: (request: any) => void = () => undefined) {
  const phoneRoot = join(root, 'phone');
  await mkdir(phoneRoot, { recursive: true });
  const implicitPosts: string[] = [];
  const h = await mobileHarness(phoneRoot, url, {
    platform: 'android',
    request: async (request, send) => {
      rewrite(request);
      if (request.method === 'POST' && !hasContentType(request.headers)) implicitPosts.push(new URL(request.url).pathname);
      androidFraming(request);
      return await send();
    }
  });
  harnesses.push(h);
  const connection = await h.plugin.runExclusiveAction(() => h.core.startOnboarding('Pixel', 'use_server'));
  await request('POST', `/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
  await h.plugin.runExclusiveAction(() => h.core.prepareReplacementOnboarding(connection.connection_id, connection.connection_secret));
  const modal = await h.open();
  await click(modal, 'Replace local contents');
  await waitUntil(() => !modal.onboardingRunning);
  expect(modal.contentEl.allText).toContain('Sync is ready');
  modal.close();
  return { h, phoneRoot, implicitPosts };
}

async function uploadNote(h: Harness, phoneRoot: string) {
  const before = (await request('GET', `/api/v1/vaults/${vaultId}/main`)).current_main;
  await writeFile(join(phoneRoot, 'phone note.md'), 'written on the phone\n');
  await h.plugin.runExclusiveAction(() => h.core.syncOnce());
  const state = await h.core.readState();
  expect(state.last_error_code).toBeNull();
  const after = (await request('GET', `/api/v1/vaults/${vaultId}/main`)).current_main;
  expect(after).not.toBe(before);
  expect(state.local_main).toBe(after);
}

beforeEach(async () => {
  await mkdir('tmp/android-request-framing', { recursive: true });
  root = await mkdtemp(join(process.cwd(), 'tmp/android-request-framing/run-'));
  server = await createObtsServer({ dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: 'synthetic-session-secret-for-request-framing' });
  url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  await request('POST', '/api/v1/setup', { username: 'owner', password: 'synthetic-test-password-1234', display_name: 'Owner' }, false);
  vaultId = (await request('POST', '/api/v1/vaults', { display_name: 'Android framing vault' })).vault_id;
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) h.dispose();
  await server?.app.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('Android request framing', () => {
  it('uploads from Android when an installed plugin finalizes without a request body', async () => {
    // Plugin 0.7.1 and earlier sent the finalize POST with neither a body nor a content type.
    const { h, phoneRoot } = await pairedAndroidPhone((request) => {
      if (!/\/push-transfers\/[^/]+\/finalize$/u.test(new URL(request.url).pathname)) return;
      const { 'content-type': _type, ...headers } = request.headers;
      request.headers = headers;
      delete request.body;
    });
    await uploadNote(h, phoneRoot);
  }, 60_000);

  it('labels every POST so the Android stack never picks a content type', async () => {
    const { h, phoneRoot, implicitPosts } = await pairedAndroidPhone();
    await uploadNote(h, phoneRoot);
    await h.plugin.runExclusiveAction(() => h.core.unpairCurrentDevice());
    expect(implicitPosts).toEqual([]);
  }, 60_000);

  it('answers request body framing errors with their client status', async () => {
    const finalize = `/api/v1/vaults/${vaultId}/sync/push-transfers/trn_unknown/finalize`;
    const emptyForm = await raw('POST', finalize, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(emptyForm.status).toBe(401);
    const form = await raw('POST', finalize, { 'content-type': 'application/x-www-form-urlencoded' }, 'a=b');
    expect(form).toMatchObject({ status: 415, json: { error: { code: 'unsupported_media_type', details: {} } } });
    const json = await raw('POST', finalize, { 'content-type': 'application/json' }, '{');
    expect(json).toMatchObject({ status: 400, json: { error: { code: 'invalid_json', details: {} } } });
    const emptyJson = await raw('POST', finalize, { 'content-type': 'application/json' }, '');
    expect(emptyJson).toMatchObject({ status: 400, json: { error: { code: 'invalid_json', details: {} } } });
    const large = await raw('POST', '/api/v1/device/diagnostic-events', { 'content-type': 'application/json' },
      JSON.stringify({ padding: 'x'.repeat(64 * 1024) }));
    expect(large).toMatchObject({ status: 413, json: { error: { code: 'request_too_large', details: {} } } });
  });
});
