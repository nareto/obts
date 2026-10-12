import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.js';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { GitService } from '../src/server/gitService.js';
import { MetadataStore } from '../src/server/metadataStore.js';

// OBTS-PER-READY-001: readiness must not report an in-flight vault creation as an orphan repository.

const roots: string[] = [];
const servers: ObtsServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function owner(): Promise<{ server: ObtsServer; dataDir: string; createVault: (name: string) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-readiness-creation-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const server = await createObtsServer({ dataDir, sessionSecret: 'readiness-creation-session-secret' }, { readiness: { autoStart: false } });
  servers.push(server);
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
  const cookie = setup.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('session cookie missing');
  const csrf = (setup.json() as { csrf_token: string }).csrf_token;
  const createVault = async (name: string): Promise<string> => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: name }
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { vault_id: string }).vault_id;
  };
  return { server, dataDir, createVault };
}

async function ready(server: ObtsServer): Promise<{ statusCode: number; body: { status: string; detail: string | null; checks: Record<string, boolean> } }> {
  const response = await server.app.inject({ method: 'GET', url: '/health/ready' });
  return { statusCode: response.statusCode, body: response.json() };
}

describe('readiness versus vault creation', () => {
  it('stays ready when a vault commits between the metadata snapshot and the repository enumeration', async () => {
    const { server, createVault } = await owner();
    await createVault('existing');
    const listingEntered = deferred();
    const releaseListing = deferred();
    const originalList = server.git.listVaultRepositoryIds.bind(server.git);
    vi.spyOn(server.git, 'listVaultRepositoryIds').mockImplementationOnce(async () => {
      listingEntered.resolve();
      await releaseListing.promise;
      return await originalList();
    });
    const sampling = server.readiness.sample();
    await listingEntered.promise;
    const created = await createVault('created during readiness');
    releaseListing.resolve();
    await sampling;
    expect(server.readiness.view().summary).toMatchObject({ status: 'ready' });
    expect((await server.store.snapshot()).vaults.map((vault) => vault.vault_id)).toContain(created);
  });

  it('skips a reserved repository whose creation has not committed metadata yet', async () => {
    const { server, createVault } = await owner();
    const initialized = deferred();
    const releaseCreation = deferred();
    const originalInitialize = server.git.initializeVault.bind(server.git);
    vi.spyOn(server.git, 'initializeVault').mockImplementationOnce(async (vaultId: string) => {
      const root = await originalInitialize(vaultId);
      initialized.resolve();
      await releaseCreation.promise;
      return root;
    });
    const creating = createVault('held before metadata commit');
    await initialized.promise;
    expect((await server.store.snapshot()).vaults).toHaveLength(0);
    const during = await ready(server);
    expect(during).toMatchObject({ statusCode: 200, body: { status: 'ready' } });
    releaseCreation.resolve();
    await creating;
    expect(await ready(server)).toMatchObject({ statusCode: 200, body: { status: 'ready' } });
  });

  it('skips a reserved, partially initialized repository and fails closed once the reservation is released without metadata', async () => {
    const { server, dataDir } = await owner();
    const reservation = server.git.reserveVaultCreation('vlt_partial_creation');
    await mkdir(join(dataDir, 'git', 'vlt_partial_creation.git'), { mode: 0o700 });
    expect(await ready(server)).toMatchObject({ statusCode: 200, body: { status: 'ready' } });
    reservation.release();
    expect(await ready(server)).toMatchObject({ statusCode: 503, body: { status: 'not_ready', checks: { persistent_state: false } } });
  });

  it('still fails closed on a complete repository that has neither metadata nor a reservation', async () => {
    const { server } = await owner();
    await server.git.initializeVault('vlt_orphan_repository');
    expect(await ready(server)).toMatchObject({
      statusCode: 503,
      body: { status: 'not_ready', detail: 'server Git store contains a vault repository missing from metadata', checks: { persistent_state: false } }
    });
  });

  it('fails closed after a creation whose metadata commit failed releases its reservation', async () => {
    const { server, createVault } = await owner();
    vi.spyOn(server.store, 'mutate').mockRejectedValueOnce(new Error('synthetic metadata failure'));
    await expect(createVault('failing')).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await ready(server)).toMatchObject({
      statusCode: 503,
      body: { status: 'not_ready', detail: 'server Git store contains a vault repository missing from metadata' }
    });
  });

  it('rejects a second reservation for the same vault ID', async () => {
    const { server } = await owner();
    const reservation = server.git.reserveVaultCreation('vlt_duplicate');
    expect(() => server.git.reserveVaultCreation('vlt_duplicate')).toThrow();
    reservation.release();
    reservation.release();
    server.git.reserveVaultCreation('vlt_duplicate').release();
  });
});

describe('every vault creation path holds its reservation across the metadata commit', () => {
  type Step = { kind: 'reserve' | 'initialize' | 'commit' | 'release'; vaultId: string };

  function traceCreations(): Step[] {
    const steps: Step[] = [];
    const reserve = GitService.prototype.reserveVaultCreation;
    vi.spyOn(GitService.prototype, 'reserveVaultCreation').mockImplementation(function (this: GitService, vaultId: string) {
      const reservation = reserve.call(this, vaultId);
      steps.push({ kind: 'reserve', vaultId });
      return {
        release: () => {
          steps.push({ kind: 'release', vaultId });
          reservation.release();
        }
      };
    });
    const initialize = GitService.prototype.initializeVault;
    vi.spyOn(GitService.prototype, 'initializeVault').mockImplementation(async function (this: GitService, vaultId: string) {
      steps.push({ kind: 'initialize', vaultId });
      return await initialize.call(this, vaultId);
    });
    const mutate = MetadataStore.prototype.mutate;
    vi.spyOn(MetadataStore.prototype, 'mutate').mockImplementation(async function (this: MetadataStore, ...args: Parameters<MetadataStore['mutate']>) {
      const result = await mutate.apply(this, args);
      const committed = await this.read((db) => db.vaults.map((vault) => vault.vault_id));
      for (const vaultId of committed) {
        if (!steps.some((step) => step.kind === 'commit' && step.vaultId === vaultId)) steps.push({ kind: 'commit', vaultId });
      }
      return result;
    } as MetadataStore['mutate']);
    return steps;
  }

  function expectReservedAcrossCommit(steps: Step[], vaultId: string): void {
    const order = steps.filter((step) => step.vaultId === vaultId).map((step) => step.kind);
    expect(order).toEqual(['reserve', 'initialize', 'commit', 'release']);
  }

  it('owner vault creation', async () => {
    const steps = traceCreations();
    const { createVault } = await owner();
    const vaultId = await createVault('owner path');
    expectReservedAcrossCommit(steps, vaultId);
  });

  it('new-vault onboarding', async () => {
    const steps = traceCreations();
    const root = await mkdtemp(join(tmpdir(), 'obts-readiness-onboarding-'));
    roots.push(root);
    const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'readiness-onboarding-session-secret' }, { readiness: { autoStart: false } });
    servers.push(server);
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {
        plugin_version: '0.4.0',
        device_name: 'onboarding device',
        local_vault_name: 'local',
        local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
      }
    });
    const connection = created.json() as { connection_id: string; connection_secret: string };
    const approved = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/approve`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { selection: 'new_vault', display_name: 'onboarded vault' }
    });
    expect(approved.statusCode).toBe(200);
    const completion = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/complete`,
      headers: { authorization: `Bearer ${connection.connection_secret}` },
      payload: { mode: 'initialize' }
    });
    expect(completion.statusCode).toBe(201);
    const vaultId = (await server.store.snapshot()).vaults[0]!.vault_id;
    expectReservedAcrossCommit(steps, vaultId);
    expect(await ready(server)).toMatchObject({ statusCode: 200, body: { status: 'ready' } });
  });

  it('CLI vault creation', async () => {
    const steps = traceCreations();
    const root = await mkdtemp(join(tmpdir(), 'obts-readiness-cli-'));
    roots.push(root);
    const env = {
      OBTS_DATA_DIR: join(root, 'data'),
      OBTS_PUBLIC_BASE_URL: 'http://sync.example.test',
      OBTS_SESSION_SECRET: 'cli-readiness-session-secret-with-enough-entropy',
      OBTS_ADMIN_PASSWORD: 'admin-password-1234'
    };
    const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      let stdout = '';
      let stderr = '';
      const code = await runCli(args, env, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
      return { code, stdout, stderr };
    };
    expect(await run(['setup', '--username', 'admin', '--password-env', 'OBTS_ADMIN_PASSWORD', '--json'])).toMatchObject({ code: 0, stderr: '' });
    const vault = await run(['vault', 'create', '--username', 'admin', '--password-env', 'OBTS_ADMIN_PASSWORD', '--display-name', 'CLI Vault', '--json']);
    expect(vault).toMatchObject({ code: 0, stderr: '' });
    expectReservedAcrossCommit(steps, (JSON.parse(vault.stdout) as { vault_id: string }).vault_id);
  });
});
