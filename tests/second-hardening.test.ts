import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { MetadataPublicationError } from '../src/server/metadataStore.js';

const servers: ObtsServer[] = [];
const roots: string[] = [];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const sleep = async (milliseconds: number) => await new Promise((resolve) => setTimeout(resolve, milliseconds));

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.app.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('second hardening pass', () => {
  it('persists failed login attempts before enforcing the account and source-IP backoff', async () => {
    const { server } = await setupServerAndVault();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(server.auth.login({ username: 'owner', password: 'wrong-password-1234', sourceIp: '203.0.113.10' }))
        .rejects.toMatchObject({ statusCode: 401, code: 'invalid_credentials' });
    }
    await expect(server.auth.login({ username: 'owner', password: 'wrong-password-1234', sourceIp: '203.0.113.10' }))
      .rejects.toMatchObject({ statusCode: 429, code: 'auth_rate_limited' });
    const db = await server.store.snapshot();
    expect(db.login_attempts.find((attempt) => attempt.username === 'owner' && attempt.source_ip === '203.0.113.10')).toMatchObject({
      failed_count: 5,
      locked_until: expect.any(String)
    });
  });

  it('maps a metadata publication failure in deletion preflight to the documented redacted 503', async () => {
    const { server, cookie, csrf, vaultId } = await setupServerAndVault();
    server.lifecycle.expireReceipts = async () => { throw new MetadataPublicationError(); };
    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'deletion_unavailable' } });
  });

  it('maps an untyped metadata cleanup failure in deletion preflight to a redacted 503', async () => {
    const { server, cookie, csrf, vaultId } = await setupServerAndVault();
    const persistence = (server.store as unknown as {
      persistence: { remove(path: string): Promise<void> };
    }).persistence;
    const originalRemove = persistence.remove;
    persistence.remove = async () => { throw new Error('synthetic metadata cleanup failure'); };
    try {
      const response = await server.app.inject({
        method: 'DELETE',
        url: `/api/v1/vaults/${vaultId}`,
        headers: { cookie, 'x-obts-csrf': csrf },
        payload: { confirmation: `DELETE ${vaultId}` }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'deletion_unavailable' } });
      expect(JSON.stringify(response.json())).not.toContain('synthetic metadata cleanup failure');
    } finally {
      persistence.remove = originalRemove;
    }
  });

  it('maps a storage read failure in deletion preflight without converting validation errors to 503', async () => {
    const { server, cookie, csrf, vaultId } = await setupServerAndVault();
    const originalSnapshot = server.store.snapshot.bind(server.store);
    server.store.snapshot = async () => {
      const error = Object.assign(new Error('synthetic metadata read failure'), { code: 'EIO' });
      throw error;
    };
    try {
      const response = await server.app.inject({
        method: 'DELETE',
        url: `/api/v1/vaults/${vaultId}`,
        headers: { cookie, 'x-obts-csrf': csrf },
        payload: { confirmation: `DELETE ${vaultId}` }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'deletion_unavailable' } });
    } finally {
      server.store.snapshot = originalSnapshot;
    }
  });

  it('rejects a delayed target connection review after deletion closes the target lifecycle', async () => {
    const { server, cookie, csrf, vaultId } = await setupServerAndVault();
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {
        plugin_version: '0.4.0',
        device_name: 'delayed review device',
        local_vault_name: 'local',
        local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
      }
    });
    const connectionId = (created.json() as { connection_id: string }).connection_id;
    const approved = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connectionId}/approve`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { selection: 'existing_vault', vault_id: vaultId }
    });
    expect(approved.statusCode).toBe(200);
    const originalReview = server.connections.review.bind(server.connections);
    const entered = deferred();
    const releaseReview = deferred();
    server.connections.review = async (id: string) => {
      entered.resolve();
      await releaseReview.promise;
      return await originalReview(id);
    };
    const review = server.app.inject({ method: 'GET', url: `/api/v1/connections/${connectionId}/review`, headers: { cookie } });
    await entered.promise;
    const deletion = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    releaseReview.resolve();
    expect((await review).statusCode).toBe(409);
  });

  it('rejects initial new-vault credentials when deletion starts after target materialization', async () => {
    const { server, cookie, csrf } = await setupServerAndVault();
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {
        plugin_version: '0.4.0',
        device_name: 'delayed initial device',
        local_vault_name: 'local',
        local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
      }
    });
    const connection = created.json() as { connection_id: string; connection_secret: string };
    const approved = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/approve`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { selection: 'new_vault', display_name: 'delayed initial vault' }
    });
    expect(approved.statusCode).toBe(200);
    let releaseMutation!: () => void;
    let mutationEntered!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationStarted = new Promise<void>((resolve) => { mutationEntered = resolve; });
    const originalMutate = server.store.mutate.bind(server.store);
    let holdCompletion = true;
    const mutateSpy = vi.spyOn(server.store, 'mutate').mockImplementation(async (fn) => {
      const result = await originalMutate(fn);
      if (holdCompletion) {
        holdCompletion = false;
        mutationEntered();
        await mutationGate;
      }
      return result;
    });
    const completion = server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/complete`,
      headers: { authorization: `Bearer ${connection.connection_secret}` },
      payload: { mode: 'initialize' }
    });
    await mutationStarted;
    const snapshot = await server.store.snapshot();
    const materializedVault = snapshot.connections.find((candidate) => candidate.connection_id === connection.connection_id)?.selected_vault_id;
    if (!materializedVault) throw new Error('new vault was not materialized');
    const deletion = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${materializedVault}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${materializedVault}` }
    });
    expect(deletion.statusCode).toBe(202);
    releaseMutation();
    mutateSpy.mockRestore();
    expect((await completion).statusCode).toBe(409);
  });

  it('admits consumed new-vault completion replay before a delayed service operation', async () => {
    const { server, cookie, csrf } = await setupServerAndVault();
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {
        plugin_version: '0.4.0',
        device_name: 'replay device',
        local_vault_name: 'local',
        local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
      }
    });
    const connection = created.json() as { connection_id: string; connection_secret: string };
    const approved = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/approve`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { selection: 'new_vault', display_name: 'replayed vault' }
    });
    expect(approved.statusCode).toBe(200);
    const completed = await server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/complete`,
      headers: { authorization: `Bearer ${connection.connection_secret}` },
      payload: { mode: 'initialize' }
    });
    expect(completed.statusCode).toBe(201);
    const vaultId = (completed.json() as { vault_id: string }).vault_id;
    const originalComplete = server.connections.complete.bind(server.connections);
    const entered = deferred();
    const releaseComplete = deferred();
    server.connections.complete = async (...args) => {
      entered.resolve();
      await releaseComplete.promise;
      return await originalComplete(...args);
    };
    const replay = server.app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connection.connection_id}/complete`,
      headers: { authorization: `Bearer ${connection.connection_secret}` },
      payload: { mode: 'initialize' }
    });
    await entered.promise;
    const deletion = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(deletion.statusCode).toBe(202);
    releaseComplete.resolve();
    expect((await replay).statusCode).toBe(409);
    await sleep(5);
  });
});

async function setupServerAndVault(): Promise<{ server: ObtsServer; cookie: string; csrf: string; vaultId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-second-hardening-'));
  roots.push(root);
  const server = await createObtsServer({ dataDir: join(root, 'data'), sessionSecret: 'second-hardening-session-secret' });
  servers.push(server);
  const setup = await server.app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { username: 'owner', password: 'correct horse battery staple' }
  });
  const cookie = setup.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('session cookie missing');
  const csrf = (setup.json() as { csrf_token: string }).csrf_token;
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/v1/vaults',
    headers: { cookie, 'x-obts-csrf': csrf },
    payload: { display_name: 'target vault' }
  });
  return { server, cookie, csrf, vaultId: (created.json() as { vault_id: string }).vault_id };
}
