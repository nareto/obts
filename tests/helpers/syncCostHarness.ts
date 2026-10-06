import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ObtsPluginClient } from '../../src/client/core.js';
import { NodeDataAdapter } from '../../src/client/nodeDataAdapter.js';
import { createObtsServer, type ObtsServer } from '../../src/server/app.js';

type Json = Record<string, unknown>;

const COUNTED_METHODS = [
  'readBinary', 'readBinaryRange', 'writeBinary', 'writeBinaryExclusive', 'stat', 'list',
  'mkdir', 'remove', 'rmdir', 'rename', 'syncFile', 'syncDirectory', 'exists', 'read', 'write'
] as const;

export type AdapterCost = {
  calls: number;
  readBytes: number;
  byMethod: Record<string, number>;
  ms: number;
};

class AdapterMeter {
  private active: { calls: number; readBytes: number; byMethod: Record<string, number> } | null = null;
  private readonly originals = new Map<string, (...args: unknown[]) => unknown>();

  install(): void {
    const proto = NodeDataAdapter.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of COUNTED_METHODS) {
      const original = proto[method];
      this.originals.set(method, original);
      const meter = this;
      proto[method] = async function counted(this: unknown, ...args: unknown[]) {
        const value = await original.apply(this, args);
        const active = meter.active;
        if (active) {
          active.calls += 1;
          active.byMethod[method] = (active.byMethod[method] ?? 0) + 1;
          if (value instanceof ArrayBuffer) active.readBytes += value.byteLength;
          else if (typeof value === 'string') active.readBytes += value.length;
        }
        return value;
      };
    }
  }

  uninstall(): void {
    const proto = NodeDataAdapter.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, original] of this.originals) proto[method] = original;
    this.originals.clear();
  }

  async measure<T>(operation: () => Promise<T>): Promise<{ value: T; cost: AdapterCost }> {
    this.active = { calls: 0, readBytes: 0, byMethod: {} };
    const started = performance.now();
    try {
      const value = await operation();
      return { value, cost: { ...this.active, ms: Math.round(performance.now() - started) } };
    } finally {
      this.active = null;
    }
  }
}

class Session {
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
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = (headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';')[0]).filter(Boolean);
    if (cookies.length > 0) this.cookie = cookies.join('; ');
    const parsed = (await response.json()) as T;
    if ('csrf_token' in parsed && typeof parsed.csrf_token === 'string') this.csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  }
}

export type SyncCostFixture = {
  root: string;
  writerDir: string;
  readerDir: string;
  writer: ObtsPluginClient;
  reader: ObtsPluginClient;
  meter: AdapterMeter;
  close(): Promise<void>;
};

function notePath(index: number): string {
  return `folder-${String(index % 24).padStart(2, '0')}/note-${String(index).padStart(5, '0')}.md`;
}

export async function createSyncCostFixture(fileCount: number): Promise<SyncCostFixture> {
  const meter = new AdapterMeter();
  meter.install();
  const root = await mkdtemp(join(tmpdir(), 'obts-sync-cost-'));
  const server: ObtsServer = await createObtsServer({
    dataDir: join(root, 'server-data'),
    publicBaseUrl: 'http://127.0.0.1:0',
    sessionSecret: 'sync-cost-session-secret-with-enough-entropy'
  });
  const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const admin = new Session(baseUrl);
  await admin.post('/api/v1/setup', { username: 'admin', password: 'admin-password-1234' }, false);
  const vault = await admin.post<{ vault_id: string }>('/api/v1/vaults', { display_name: 'Cost Vault' });
  admin.vaultId = vault.body.vault_id;

  const writerDir = join(root, 'writer');
  const readerDir = join(root, 'reader');
  await mkdir(readerDir, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const filePath = join(writerDir, notePath(index));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, `# Note ${index}\n\n${'body line\n'.repeat(20)}`);
  }
  const pair = async (vaultDir: string, deviceName: string) => {
    const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName });
    const connection = await plugin.startOnboarding('Cost Vault');
    await admin.post(`/api/v1/connections/${connection.connection_id}/approve`, {
      selection: 'existing_vault',
      vault_id: admin.vaultId
    });
    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await plugin.finishOnboarding({
      connectionId: connection.connection_id,
      secret: connection.connection_secret,
      analysis,
      mode: analysis.classification === 'independent_divergent' || analysis.classification === 'shared_baseline_divergent' ? 'merge' : 'use_server'
    });
    return plugin;
  };
  const writer = await pair(writerDir, 'cost-writer');
  await writer.syncOnce({ confirmInitialImport: true });
  const reader = await pair(readerDir, 'cost-reader');
  await reader.syncOnce();
  return {
    root,
    writerDir,
    readerDir,
    writer,
    reader,
    meter,
    async close() {
      meter.uninstall();
      await server.app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function writeNote(vaultDir: string, index: number, body: string): Promise<void> {
  await writeFile(join(vaultDir, notePath(index)), body);
}

export async function syncUntilSettled(plugin: ObtsPluginClient, maxCycles = 6): Promise<string[]> {
  const statuses: string[] = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const result = await plugin.syncOnce();
    statuses.push(result.status);
    if (result.status === 'Synced') break;
  }
  return statuses;
}

export async function addSyntheticPacks(plugin: ObtsPluginClient, count: number): Promise<void> {
  const core = (plugin as unknown as { client: any }).client;
  for (let index = 0; index < count; index += 1) {
    const content = Buffer.from(`synthetic pack filler ${index}\n`);
    await core.importPack(await packSingleBlob(core, content));
  }
}

async function packSingleBlob(core: any, content: Buffer): Promise<Buffer> {
  const git = await import('isomorphic-git');
  const fs = await import('node:fs');
  const scratch = await mkdtemp(join(tmpdir(), 'obts-synthetic-pack-'));
  try {
    await git.init({ fs, dir: scratch });
    const oid = await git.writeBlob({ fs, dir: scratch, blob: content });
    const { packfile } = await git.packObjects({ fs, dir: scratch, oids: [oid] });
    void core;
    return Buffer.from(packfile as Uint8Array);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
