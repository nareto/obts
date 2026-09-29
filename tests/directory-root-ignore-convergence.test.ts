import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ObtsPluginClient } from '../obsidian-plugin/src/core/client.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';

type Json = Record<string, unknown>;

class AdminSession {
  cookie = '';
  csrf = '';
  vaultId = '';

  constructor(readonly baseUrl: string) {}

  async post<T extends Json>(path: string, body: Json, csrf = true): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(csrf && this.csrf ? { 'x-obts-csrf': this.csrf } : {})
      },
      body: JSON.stringify(body)
    });
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    if (cookies.length > 0) this.cookie = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
    const parsed = await response.json() as T;
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') this.csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  }
}

const roots: string[] = [];
let servers: ObtsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(root: string) {
  const server = await createObtsServer({
    dataDir: join(root, 'server-data'),
    publicBaseUrl: 'http://127.0.0.1:0',
    sessionSecret: 'test-session-secret-with-enough-entropy'
  });
  servers.push(server);
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = new AdminSession(baseUrl);
  const registered = await admin.post<{ csrf_token: string }>('/api/v1/setup', {
    username: 'admin', password: 'admin-password-1234'
  }, false);
  expect(registered.status).toBe(201);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Directory Ignore Loop' });
  expect(vault.status).toBe(201);
  admin.vaultId = vault.body.vault_id;
  return { server, admin, baseUrl };
}

async function pair(admin: AdminSession, baseUrl: string, directory: string, name: string) {
  const client = new ObtsPluginClient(directory, { serverUrl: baseUrl, deviceName: name });
  const connection = await client.startOnboarding('Test Vault');
  expect((await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
    selection: 'existing_vault', vault_id: admin.vaultId
  })).status).toBe(200);
  const analysis = await client.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  const mode = analysis.classification === 'independent_divergent' || analysis.classification === 'shared_baseline_divergent'
    ? 'merge' : 'use_server';
  await client.finishOnboarding({
    connectionId: connection.connection_id,
    secret: connection.connection_secret,
    analysis,
    mode
  });
  return client;
}

describe('root-ignore directory convergence', () => {
  it('converges with a legacy ignored explicit directory and still syncs an emptied folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-dir-ignore-loop-'));
    roots.push(root);
    const { server, admin, baseUrl } = await setup(root);
    const desktopDir = join(root, 'desktop');
    const secondDir = join(root, 'second-device');
    await mkdir(join(desktopDir, '.smart-env', 'sub'), { recursive: true });
    await mkdir(join(desktopDir, 'Notes'), { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await server.store.mutate((db) => {
      db.directory_state_by_vault[admin.vaultId] = { explicit_dirs: ['.smart-env'], last_event_seq: 0, updated_at: new Date().toISOString() };
    });
    await writeFile(join(desktopDir, '.gitignore'), '.smart-env/\n');
    await writeFile(join(desktopDir, '.smart-env', 'sub', 'file.json'), '{"cache":true}\n');
    await writeFile(join(desktopDir, 'Notes', 'note.md'), 'a note before emptying\n');
    const desktop = await pair(admin, baseUrl, desktopDir, 'desktop');
    expect((await desktop.syncOnce({ confirmInitialImport: true })).status).toBe('Synced');
    await rm(join(desktopDir, 'Notes', 'note.md'));
    expect((await desktop.syncOnce()).status).toBe('Synced');
    expect((await server.store.snapshot()).directory_state_by_vault[admin.vaultId]?.explicit_dirs).toContain('Notes');
    const second = await pair(admin, baseUrl, secondDir, 'second-device');
    expect((await second.syncOnce()).status).toBe('Synced');
    expect(await readFile(join(secondDir, 'Notes', 'note.md')).catch(() => null)).toBeNull();
    expect(await stat(join(secondDir, 'Notes'))).toBeDefined();
    expect(await readFile(join(desktopDir, '.smart-env', 'sub', 'file.json'), 'utf8')).toBe('{"cache":true}\n');
    const directoryState = JSON.parse(await readFile(join(desktopDir, '.obts', 'directory-state.json'), 'utf8')) as {
      observed_dirs: string[];
      pending_intents: Array<{ path: string }>;
    };
    expect(directoryState.observed_dirs.some((directory) => directory.startsWith('.smart-env'))).toBe(false);
    expect(directoryState.pending_intents.some((intent) => intent.path.startsWith('.smart-env'))).toBe(false);
    expect((await server.store.snapshot()).directory_state_by_vault[admin.vaultId]?.explicit_dirs).toContain('.smart-env');

    const initialDatabase = await server.store.snapshot();
    const initialMain = initialDatabase.vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main;
    const initialDesktopHead = await (desktop as any).client.resolveRef('refs/heads/local');
    const initialSecondHead = await (second as any).client.resolveRef('refs/heads/local');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect((await desktop.syncOnce()).status).toBe('Synced');
      expect((await second.syncOnce()).status).toBe('Synced');
    }
    const finalDatabase = await server.store.snapshot();
    const finalMain = finalDatabase.vaults.find((vault) => vault.vault_id === admin.vaultId)!.current_main;
    expect(await server.git.treeHash(admin.vaultId, finalMain)).toBe(await server.git.treeHash(admin.vaultId, initialMain));
    expect(finalMain).toBe(initialMain);
    expect(await (desktop as any).client.resolveRef('refs/heads/local')).toBe(initialDesktopHead);
    expect(await (second as any).client.resolveRef('refs/heads/local')).toBe(initialSecondHead);
  });
});
