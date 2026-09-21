import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateUpgradeFixture } from './generate-upgrade-fixture.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..');
const startupBudgetMs = 30_000;
const readyBudgetMs = 5_000;

const outputDir = await mkdtemp(join(tmpdir(), 'obts-server-upgrade-'));
let child = null;

try {
  const descriptor = await generateUpgradeFixture(outputDir);
  await assertFixtureChecksums(outputDir);
  const dataDir = join(outputDir, descriptor.data_dir);
  const port = await findFreePort();
  child = startServer(dataDir, port);
  await waitForLive(child, port, startupBudgetMs);
  process.stdout.write('upgrade compatibility: built CLI reached listening state\n');

  const readyStarted = Date.now();
  const ready = await request(`http://127.0.0.1:${port}/health/ready`);
  const readyElapsed = Date.now() - readyStarted;
  assertReadyResponse(ready, readyElapsed, readyBudgetMs);
  process.stdout.write(`upgrade compatibility: readiness passed in ${readyElapsed}ms\n`);

  await assertPersistedState(dataDir, descriptor);
  process.stdout.write('upgrade compatibility: metadata cleanup, ownership adoption, and accounting repair persisted\n');

  await assertHealthyUploadAndPull(port, descriptor, dataDir);
  process.stdout.write('upgrade compatibility: unrelated chunked upload and existing pull passed\n');

  await stopServer(child);
  child = null;
  await assertUnknownMetadataResidueFailsClosed(dataDir, port);
  process.stdout.write('upgrade compatibility: unknown metadata residue remained fail-closed\n');
  process.stdout.write('upgrade compatibility: PASS\n');
} catch (error) {
  if (child) await stopServer(child);
  child = null;
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`upgrade compatibility failed: ${message}`);
} finally {
  if (child) await stopServer(child);
  await rm(outputDir, { recursive: true, force: true });
}

function startServer(dataDir, port) {
  const processHandle = spawn(
    process.execPath,
    [join(repositoryRoot, 'dist', 'src', 'cli.js'), 'serve'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OBTS_DATA_DIR: dataDir,
        OBTS_HOST: '127.0.0.1',
        OBTS_PORT: String(port),
        OBTS_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        OBTS_SESSION_SECRET: 'synthetic-upgrade-fixture-session-secret'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let stdout = '';
  let stderr = '';
  processHandle.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk.toString()); });
  processHandle.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk.toString()); });
  processHandle.__output = () => ({ stdout, stderr });
  return processHandle;
}

async function waitForLive(processHandle, port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`server exited before listening: ${formatOutput(processHandle)}`);
    }
    try {
      const live = await request(`http://127.0.0.1:${port}/health/live`, 1_000);
      if (live.status === 200 && live.body?.status === 'ok') return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`server did not become live within ${budgetMs}ms: ${formatOutput(processHandle)}`);
}

async function assertFixtureChecksums(outputDir) {
  const manifest = await readFile(join(outputDir, 'checksums.sha256'), 'utf8');
  for (const line of manifest.trim().split('\n')) {
    const match = /^(?<digest>[0-9a-f]{64})  (?<path>.+)$/u.exec(line);
    if (!match?.groups) throw new Error(`invalid fixture checksum line: ${line}`);
    const path = match.groups.path;
    if (path.startsWith('/') || path.includes('..')) throw new Error(`unsafe fixture checksum path: ${path}`);
    const actual = createHash('sha256').update(await readFile(join(outputDir, path))).digest('hex');
    if (actual !== match.groups.digest) throw new Error(`fixture checksum mismatch: ${path}`);
  }
}

async function assertPersistedState(dataDir, descriptor) {
  const metadataPath = join(dataDir, 'metadata', 'phase1.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.schema_version !== descriptor.canonical_metadata.schema_version || !metadata.setup_complete) {
    throw new Error('canonical metadata was not preserved');
  }
  const vaultIds = metadata.vaults.map((vault) => vault.vault_id).sort();
  if (JSON.stringify(vaultIds) !== JSON.stringify(descriptor.canonical_metadata.vault_ids)) {
    throw new Error('canonical vault metadata changed unexpectedly');
  }
  const legacyVault = metadata.vaults.find((vault) => vault.vault_id === descriptor.legacy_vault_id);
  if (!legacyVault || legacyVault.root_commit !== descriptor.legacy_root_commit || legacyVault.current_main !== descriptor.legacy_root_commit) {
    throw new Error('legacy vault metadata was not preserved');
  }

  const legacyTemp = join(dataDir, descriptor.legacy_metadata_temp.replace(/^data\//u, ''));
  if (await exists(legacyTemp)) throw new Error('legacy metadata temporary residue was not removed');

  const ownerPath = join(dataDir, descriptor.legacy_owner_marker.replace(/^data\//u, ''));
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  if (owner.vault_id !== descriptor.legacy_vault_id) throw new Error('legacy transfer ownership was not adopted');

  const sessionPath = join(dataDir, descriptor.legacy_session.replace(/^data\//u, ''));
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  const actualStoredBytes = await materialBytes(dirname(sessionPath));
  if (session.stored_bytes !== descriptor.repaired_stored_bytes_after_upgrade || session.stored_bytes !== actualStoredBytes) {
    throw new Error('legacy transfer accounting was not repaired and persisted');
  }
}

async function assertHealthyUploadAndPull(port, descriptor, dataDir) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const packfile = await readFile(join(dataDir, '..', descriptor.healthy_packfile));
  const createRequest = {
    api_version: '2026-07-12.browser-onboarding',
    plugin_version: '0.4.36',
    vault_id: descriptor.healthy_vault_id,
    device_id: descriptor.healthy_device_id,
    expected_device_ref: null,
    target_commit: descriptor.healthy_target_commit,
    client_known_main: descriptor.healthy_root_commit,
    base_commit: descriptor.healthy_root_commit,
    attempt_id: 'healthy-upgrade-attempt',
    chunk_count: 1,
    plan_sha256: sha256('healthy-upgrade-plan')
  };
  const created = await request(`${baseUrl}/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${descriptor.healthy_device_token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(createRequest)
  });
  if (created.status !== 201 || typeof created.body?.transfer_id !== 'string') {
    throw new Error(`healthy transfer creation returned HTTP ${created.status}`);
  }
  const transferId = created.body.transfer_id;
  const uploaded = await fetch(`${baseUrl}/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers/${transferId}/chunks/0`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${descriptor.healthy_device_token}`,
      'content-type': 'application/x-git-packed-objects',
      'x-obts-chunk-sha256': sha256(packfile)
    },
    body: packfile
  });
  if (uploaded.status !== 200) throw new Error(`healthy chunk upload returned HTTP ${uploaded.status}`);
  const finalized = await request(`${baseUrl}/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers/${transferId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${descriptor.healthy_device_token}` }
  });
  if (finalized.status !== 200 || !['merged', 'noop'].includes(finalized.body?.status)) {
    throw new Error(`healthy transfer finalize returned HTTP ${finalized.status}`);
  }

  const pulled = await request(`${baseUrl}/api/v1/vaults/${descriptor.legacy_vault_id}/sync/pull-chunk`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${descriptor.legacy_device_token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      api_version: '2026-07-12.browser-onboarding',
      plugin_version: '0.4.36',
      vault_id: descriptor.legacy_vault_id,
      device_id: descriptor.legacy_device_id,
      current_local_main: descriptor.legacy_root_commit,
      requested_target: 'latest',
      current_event_seq: 0,
      cursor: 0
    })
  });
  if (pulled.status !== 200 || pulled.raw.length === 0) throw new Error(`existing pull returned HTTP ${pulled.status}`);

  const ready = await request(`${baseUrl}/health/ready`);
  if (ready.status !== 200) throw new Error(`readiness lost after unrelated upload: HTTP ${ready.status}`);
}

async function assertUnknownMetadataResidueFailsClosed(dataDir, port) {
  const unknown = join(dataDir, 'metadata', 'phase1.json.unknown.tmp');
  await writeFile(unknown, 'unattributed residue\n', { mode: 0o600 });
  const rejected = startServer(dataDir, port);
  try {
    const exited = await waitForExit(rejected, 5_000);
    if (exited.code === 0) throw new Error('server accepted unknown metadata residue');
    if (!(await exists(unknown))) throw new Error('unknown metadata residue was removed');
  } finally {
    await stopServer(rejected);
  }
}

async function request(url, optionsOrTimeout = {}, maybeTimeout) {
  const options = typeof optionsOrTimeout === 'number' ? {} : optionsOrTimeout;
  const timeout = typeof optionsOrTimeout === 'number' ? optionsOrTimeout : maybeTimeout ?? 5_000;
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: response.status, body, raw };
}

function assertReadyResponse(result, elapsed, budgetMs) {
  if (result.status !== 200) {
    if (!result.body || typeof result.body !== 'object' || typeof result.body.detail !== 'string' || !result.body.checks) {
      throw new Error('readiness failure did not include useful failure detail');
    }
    throw new Error(`readiness returned HTTP ${result.status}: ${result.body.detail}`);
  }
  if (elapsed > budgetMs) throw new Error(`readiness exceeded ${budgetMs}ms budget: ${elapsed}ms`);
  if (result.body?.status !== 'ready' || result.body?.checks?.persistent_state !== true) {
    throw new Error('readiness response did not report a ready persistent state');
  }
}

async function materialBytes(root) {
  let total = 0;
  for (const entry of await (await import('node:fs/promises')).readdir(root, { withFileTypes: true })) {
    if (entry.name === 'owner.json' || entry.name === 'session.json') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await materialBytes(path);
    else if (entry.isFile()) total += (await (await import('node:fs/promises')).stat(path)).size;
  }
  return total;
}

async function stopServer(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await waitForExit(processHandle, 5_000).catch(() => {
    processHandle.kill('SIGKILL');
  });
}

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return Promise.resolve({ code: processHandle.exitCode });
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit within timeout')), timeoutMs);
    processHandle.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
    server.on('error', reject);
  });
}

function appendBounded(current, next) {
  const value = `${current}${next}`;
  return value.length > 12_000 ? value.slice(-12_000) : value;
}

function formatOutput(processHandle) {
  const output = processHandle.__output?.() ?? {};
  return `stdout=${output.stdout ?? ''} stderr=${output.stderr ?? ''}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function exists(path) {
  try {
    await (await import('node:fs/promises')).lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
