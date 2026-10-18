import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { click, mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';

const require = createRequire(import.meta.url);

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
  return { status: response.status, json };
}

async function post(path: string, body: unknown) {
  const result = await request('POST', path, body);
  if (result.status < 200 || result.status >= 300) throw new Error(`${path}: ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === '.obts') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

beforeEach(async () => {
  await mkdir('tmp/name-repair', { recursive: true });
  root = await mkdtemp(join(process.cwd(), 'tmp/name-repair/run-'));
  server = await createObtsServer({ dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: 'synthetic-session-secret-for-name-repair' });
  url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  await request('POST', '/api/v1/setup', { username: 'owner', password: 'synthetic-test-password-1234', display_name: 'Owner' }, false);
  vaultId = (await post('/api/v1/vaults', { display_name: 'Portable vault' })).vault_id;
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) h.dispose();
  await server?.app.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('OBTS-SYNC-NAME-001 / OBTS-DASH-NAME-001 name repair flow', () => {
  it('blocks the Android apply before writing, repairs names on the server, and resumes setup', async () => {
    const desktopRoot = join(root, 'desktop');
    const desktop = new ObtsPluginClient(desktopRoot, { serverUrl: url, deviceName: 'desktop' });
    const desktopConnection = await desktop.startOnboarding('Desktop');
    await post(`/api/v1/connections/${desktopConnection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    const desktopAnalysis = await desktop.analyzeOnboarding(desktopConnection.connection_id, desktopConnection.connection_secret);
    await desktop.finishOnboarding({ connectionId: desktopConnection.connection_id, secret: desktopConnection.connection_secret, analysis: desktopAnalysis, mode: 'use_server' });
    await mkdir(join(desktopRoot, 'Inbox'), { recursive: true });
    await writeFile(join(desktopRoot, 'Inbox', 'What? now.md'), 'question\n');
    await writeFile(join(desktopRoot, 'Plan.md'), 'See [[What? now]] and [doc](Inbox/What%3F%20now.md).\n`[[What? now]]` stays.\n');
    await writeFile(join(desktopRoot, 'Readme.md'), 'one\n');
    await writeFile(join(desktopRoot, 'README.md'), 'two\n');
    await desktop.syncOnce();

    const phoneRoot = join(root, 'phone');
    await mkdir(phoneRoot);
    await writeFile(join(phoneRoot, 'local.md'), 'phone bytes\n');
    const h = await mobileHarness(phoneRoot, url, { platform: 'android' });
    harnesses.push(h);
    const connection = await h.plugin.runExclusiveAction(() => h.core.startOnboarding('Pixel', 'use_server'));
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    await h.plugin.runExclusiveAction(() => h.core.prepareReplacementOnboarding(connection.connection_id, connection.connection_secret));

    const modal = await h.open();
    await click(modal, 'Replace local contents');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('cannot be stored on Android');
    expect(modal.contentEl.allText).toContain('Repair file names');
    expect(await listFiles(phoneRoot)).toEqual(['local.md']);
    const blocked = await h.core.readState();
    expect(blocked.last_error_code).toBe('unportable_target_paths');
    expect(blocked.last_error_details.unportable_path_count).toBe(3);
    await h.core.reportDeviceStatus();
    await waitUntil(async () => {
      const summary = (await request('GET', `/api/v1/vaults/${vaultId}/dashboard`)).json;
      return summary.name_portability?.restricted_devices?.some((device: any) => device.blocked);
    });
    const summary = (await request('GET', `/api/v1/vaults/${vaultId}/dashboard`)).json;
    expect(summary.name_portability).toMatchObject({ rule_version: 1, restricted_platforms: ['android'], unportable_path_count: 3 });
    expect(summary.name_portability.restricted_devices).toEqual([
      expect.objectContaining({ platform: 'android', blocked: true })
    ]);

    const desktopSelf = await desktop.client.getDeviceSelf(await desktop.client.readDeviceToken());
    expect(desktopSelf.restricted_name_platforms).toEqual(['android']);

    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    expect(preview.renames).toEqual([
      { from: 'Inbox/What? now.md', to: 'Inbox/What now.md', kind: 'file', reasons: ['reserved_characters'] },
      { from: 'Readme.md', to: 'Readme (2).md', kind: 'file', reasons: ['case_collision'] }
    ]);
    expect(preview.link_updates).toEqual([{ path: 'Plan.md', link_count: 2 }]);
    expect(preview.changes_main).toBe(true);

    const stale = await request('POST', `/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: 'f'.repeat(64)
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('stale_name_repair');

    const applied = await post(`/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });
    expect(applied).toMatchObject({ previous_main: preview.expected_main, renamed_count: 2, link_updated_count: 1 });
    expect((await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {})).renames).toEqual([]);

    await click(modal, 'Replace local contents');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('Sync is ready');
    expect(await listFiles(phoneRoot)).toEqual(['Inbox/What now.md', 'Plan.md', 'README.md', 'Readme (2).md']);
    expect(await readFile(join(phoneRoot, 'Plan.md'), 'utf8')).toBe('See [[What now]] and [doc](Inbox/What%20now.md).\n`[[What? now]]` stays.\n');
    expect((await h.core.readState()).last_error_code).toBeNull();

    await desktop.syncOnce();
    expect(await listFiles(desktopRoot)).toEqual(['Inbox/What now.md', 'Plan.md', 'README.md', 'Readme (2).md']);
  }, 60_000);

  it('keeps a paired Android device untouched until the server repair lands', async () => {
    const desktopRoot = join(root, 'desktop');
    const desktop = new ObtsPluginClient(desktopRoot, { serverUrl: url, deviceName: 'desktop' });
    const desktopConnection = await desktop.startOnboarding('Desktop');
    await post(`/api/v1/connections/${desktopConnection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    const desktopAnalysis = await desktop.analyzeOnboarding(desktopConnection.connection_id, desktopConnection.connection_secret);
    await desktop.finishOnboarding({ connectionId: desktopConnection.connection_id, secret: desktopConnection.connection_secret, analysis: desktopAnalysis, mode: 'use_server' });
    await writeFile(join(desktopRoot, 'base.md'), 'base\n');
    await desktop.syncOnce();

    const phoneRoot = join(root, 'phone');
    await mkdir(phoneRoot);
    const h = await mobileHarness(phoneRoot, url, { platform: 'android' });
    harnesses.push(h);
    const connection = await h.plugin.runExclusiveAction(() => h.core.startOnboarding('Pixel', 'use_server'));
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    await h.plugin.runExclusiveAction(() => h.core.prepareReplacementOnboarding(connection.connection_id, connection.connection_secret));
    const modal = await h.open();
    await click(modal, 'Replace local contents');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('Sync is ready');
    modal.close();

    await writeFile(join(desktopRoot, 'Pipe | name.md'), 'pipe\n');
    await writeFile(join(desktopRoot, 'base.md'), 'base [p](Pipe%20%7C%20name.md) [[Pipe | alias]]\n');
    await desktop.syncOnce();
    const syncedMain = (await h.core.readState()).local_main;

    await expect(h.plugin.runExclusiveAction(() => h.core.syncOnce())).rejects.toMatchObject({ code: 'unportable_target_paths' });
    const blocked = await h.core.readState();
    expect(blocked).toMatchObject({ local_main: syncedMain, last_error_code: 'unportable_target_paths', status_label: 'Out of sync — file names need repair' });
    expect(await listFiles(phoneRoot)).toEqual(['base.md']);
    expect(await readFile(join(phoneRoot, 'base.md'), 'utf8')).toBe('base\n');
    await expect(readFile(join(phoneRoot, '.obts', 'apply-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const pull = h.core.pull.bind(h.core);
    let pulls = 0;
    h.core.pull = async (...args: any[]) => { pulls += 1; return await pull(...args); };
    await h.plugin.runExclusiveAction(() => h.core.pollRemoteEventsAndApply());
    expect(pulls).toBe(0);
    expect((await h.core.readState()).last_error_code).toBe('unportable_target_paths');

    const preview = await post(`/api/v1/vaults/${vaultId}/name-repair/preview`, {});
    expect(preview.renames).toEqual([{ from: 'Pipe | name.md', to: 'Pipe - name.md', kind: 'file', reasons: ['reserved_characters'] }]);
    await post(`/api/v1/vaults/${vaultId}/name-repair`, {
      expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint
    });

    await h.plugin.runExclusiveAction(() => h.core.pollRemoteEventsAndApply());
    expect(pulls).toBe(1);
    expect((await h.core.readState()).last_error_code).toBeNull();
    expect(await listFiles(phoneRoot)).toEqual(['Pipe - name.md', 'base.md']);
    expect(await readFile(join(phoneRoot, 'base.md'), 'utf8')).toBe('base [p](Pipe%20-%20name.md) [[Pipe | alias]]\n');
  }, 60_000);

  it('reverts only renames that introduce an unportable leaf name', () => {
    const shared = require('../obsidian-plugin/src/main.cjs');
    const { portableNameDecision, unportableTargetPathsMessage } = shared;
    expect(portableNameDecision('Notes/a?.md', 'Notes/a.md', ['Notes'])).toEqual({
      action: 'revert', path: 'Notes/a?.md', restorePath: 'Notes/a.md', reasons: ['reserved_characters']
    });
    expect(portableNameDecision('Notes/b.md', 'Notes/a.md', ['Notes', 'Notes/B.md'])).toMatchObject({ action: 'revert', reasons: ['case_collision'] });
    expect(portableNameDecision('Bad?/a.md', 'Good/a.md', ['Bad?'])).toBeNull();
    expect(portableNameDecision('Notes/new?.md', null, ['Notes'])).toMatchObject({ action: 'warn' });
    expect(portableNameDecision('Other/a?.md', 'Notes/a?.md', ['Notes', 'Other'])).toMatchObject({ action: 'warn' });
    expect(portableNameDecision('Notes/ok.md', 'Notes/a.md', ['Notes'])).toBeNull();
    expect(unportableTargetPathsMessage({ unportable_path_count: 7, sample_paths: ['a?.md'], platform: 'android' }))
      .toContain('7 file names in this vault cannot be stored on Android');
  });
});
