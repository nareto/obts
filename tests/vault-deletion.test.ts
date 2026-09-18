import { access, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObtsServer, type ObtsServer } from '../src/server/app.js';

type ResponseBody = Record<string, unknown>;

async function waitForUnattributedResidue(
  server: ObtsServer,
  vaultId: string,
  cookie: string | string[] | undefined,
  timeoutMs = 1_000
): Promise<ResponseBody> {
  const deadline = Date.now() + timeoutMs;
  let latest: ResponseBody = {};
  do {
    const response = await server.app.inject({ method: 'GET', url: `/api/v1/vault-deletions/${vaultId}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    latest = response.json() as ResponseBody;
    if (latest.error_code === 'unattributed_residue') return latest;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  } while (Date.now() < deadline);
  return latest;
}

describe('server-owned vault deletion lifecycle', () => {
  let root: string | undefined;
  let server: ObtsServer | undefined;
  let heldAdmission: { release(): void } | undefined;

  afterEach(async () => {
    heldAdmission?.release();
    await server?.app.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('requires the full target confirmation, does not require recent auth, and retains a redacted receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-'));
    server = await createObtsServer({
      dataDir: join(root, 'server-data'),
      publicBaseUrl: 'http://127.0.0.1:0',
      sessionSecret: 'test-session-secret-with-enough-entropy'
    });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Synthetic secret name' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const otherCreated = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Other synthetic vault' }
    });
    const otherVaultId = (otherCreated.json() as { vault_id: string }).vault_id;
    await server.store.mutate((db) => {
      const session = db.sessions[0];
      if (session) session.recent_auth_at = new Date(0).toISOString();
    });

    const invalid = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: 'DELETE wrong' }
    });
    expect(invalid.statusCode).toBe(400);

    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ vault_id: vaultId, status: 'deleting', completed_at: null });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await server.app.inject({ method: 'GET', url: '/api/v1/vault-deletions', headers: { cookie } });
      const body = status.json() as { deletions: Array<ResponseBody> };
      if (body.deletions[0]?.status === 'deleted') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const final = await server.app.inject({ method: 'GET', url: `/api/v1/vault-deletions/${vaultId}`, headers: { cookie } });
    expect(final.statusCode).toBe(200);
    const receipt = final.json() as ResponseBody;
    expect(receipt).toMatchObject({ vault_id: vaultId, status: 'deleted' });
    expect(JSON.stringify(receipt)).not.toContain('Synthetic secret name');
    expect(JSON.stringify(receipt)).not.toContain('server-data');
    const repeated = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: {}
    });
    expect(repeated.statusCode).toBe(200);
    expect((await server.store.snapshot()).vaults.some((vault) => vault.vault_id === vaultId)).toBe(false);
    expect((await server.store.snapshot()).vaults.some((vault) => vault.vault_id === otherVaultId)).toBe(true);
    await access(join(root!, 'server-data', 'git', `${otherVaultId}.git`));
  });

  it('accepts deletion before a held admission drains and defers erasure until release', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-ordering-'));
    server = await createObtsServer({ dataDir: join(root, 'server-data'), sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Held synthetic vault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    heldAdmission = await server.lifecycle.acquireAdmission(vaultId);

    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ vault_id: vaultId, status: 'deleting' });
    await access(join(root, 'server-data', 'git', `${vaultId}.git`));
    const beforeRelease = await server.store.snapshot();
    expect(beforeRelease.vaults.some((vault) => vault.vault_id === vaultId)).toBe(true);
    expect(beforeRelease.deletion_jobs.some((job) => job.vault_id === vaultId)).toBe(true);
    expect(beforeRelease.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);

    heldAdmission.release();
    heldAdmission = undefined;
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await server.app.inject({ method: 'GET', url: `/api/v1/vault-deletions/${vaultId}`, headers: { cookie } });
      if (status.statusCode === 200 && (status.json() as ResponseBody).status === 'deleted') {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).toBe(true);
    await expect(access(join(root, 'server-data', 'git', `${vaultId}.git`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes after Git erasure when later cleanup publication fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-resume-'));
    const dataDir = join(root, 'server-data');
    server = await createObtsServer({ dataDir, sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Resumable synthetic vault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const repository = join(dataDir, 'git', `${vaultId}.git`);
    const originalCleanup = server.store.cleanupPersistenceTemps.bind(server.store);
    let injected = true;
    server.store.cleanupPersistenceTemps = async () => {
      if (injected) {
        injected = false;
        throw new Error('synthetic cleanup failure after Git erasure');
      }
      await originalCleanup();
    };

    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    let sawErasingRetry = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await server.store.snapshot();
      const job = snapshot.deletion_jobs.find((candidate) => candidate.vault_id === vaultId);
      if (!job) break;
      if (!injected && job.phase === 'erasing') {
        sawErasingRetry = true;
        await expect(lstat(repository)).rejects.toMatchObject({ code: 'ENOENT' });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sawErasingRetry).toBe(true);
    let completed = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const snapshot = await server.store.snapshot();
      if (snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed).toBe(true);
  });

  it('keeps a deletion pending when its Git target was initially missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-missing-target-'));
    const dataDir = join(root, 'server-data');
    server = await createObtsServer({ dataDir, sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Missing target synthetic vault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    const repository = join(dataDir, 'git', `${vaultId}.git`);
    await rm(repository, { recursive: true, force: true });
    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const snapshot = await server.store.snapshot();
    expect(snapshot.deletion_jobs.find((job) => job.vault_id === vaultId)).toMatchObject({
      phase: 'draining',
      error_code: 'storage_unavailable'
    });
    expect(snapshot.deletion_receipts.some((receipt) => receipt.vault_id === vaultId)).toBe(false);
    await expect(lstat(repository)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an admission whose durable check races barrier closure', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-admission-race-'));
    server = await createObtsServer({ dataDir: join(root, 'server-data'), sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Admission race synthetic vault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;

    let releaseSnapshot!: () => void;
    let signalSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const originalSnapshot = server.store.snapshot.bind(server.store);
    let firstSnapshot = true;
    const snapshotSpy = vi.spyOn(server.store, 'snapshot').mockImplementation(async () => {
      if (firstSnapshot) {
        firstSnapshot = false;
        signalSnapshot();
        await snapshotGate;
      }
      return await originalSnapshot();
    });
    const acquiring = server.lifecycle.acquireAdmission(vaultId);
    await snapshotEntered;
    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    releaseSnapshot();
    snapshotSpy.mockRestore();
    await expect(acquiring).rejects.toMatchObject({ code: 'vault_deleting', statusCode: 409 });
  });

  it('retains an unattributed transfer residue as pending across restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-restart-'));
    const dataDir = join(root, 'server-data');
    server = await createObtsServer({ dataDir, sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { display_name: 'Pending synthetic vault' }
    });
    const vaultId = (created.json() as { vault_id: string }).vault_id;
    await mkdir(join(dataDir, 'transfers', 'trn_unattributed'), { recursive: true });
    const accepted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${vaultId}`,
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: `DELETE ${vaultId}` }
    });
    expect(accepted.statusCode).toBe(202);
    const pending = await waitForUnattributedResidue(server, vaultId, cookie);
    expect(pending).toMatchObject({ status: 'deleting', error_code: 'unattributed_residue' });
    await server.app.close();
    server = await createObtsServer({ dataDir, sessionSecret: 'test-session-secret-with-enough-entropy' });
    const restored = await server.app.inject({ method: 'GET', url: `/api/v1/vault-deletions/${vaultId}`, headers: { cookie } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ status: 'deleting' });
  });

  it('keeps unknown targets indistinguishable before confirmation validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'obts-vault-delete-scope-'));
    server = await createObtsServer({ dataDir: join(root, 'server-data'), sessionSecret: 'test-session-secret-with-enough-entropy' });
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { username: 'owner', password: 'correct horse battery staple' }
    });
    const cookie = setup.headers['set-cookie'];
    const csrf = (setup.json() as { csrf_token: string }).csrf_token;
    const unknown = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/vaults/vlt_unknown',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: 'wrong' }
    });
    const missing = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/vaults/vlt_unknown',
      headers: { cookie, 'x-obts-csrf': csrf },
      payload: { confirmation: 'wrong' }
    });
    expect(unknown.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });
});
