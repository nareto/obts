import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { createObtsServer } from '../dist/src/server/app.js';
import { hashToken } from '../dist/src/server/authService.js';
import { API_VERSION } from '../dist/src/shared/types.js';

export const PRODUCER_COMMIT = 'aaad5ad25945ba68c51a9286e2113b59b7ff33d9';
export const PRODUCER_DESCRIPTION = 'server producer deployed immediately before ec774a7';

const LEGACY_VAULT_ID = 'vlt_n1_legacy';
const HEALTHY_VAULT_ID = 'vlt_n1_healthy';
const LEGACY_DEVICE_ID = 'dev_n1_legacy';
const HEALTHY_DEVICE_ID = 'dev_n1_healthy';
const LEGACY_DEVICE_TOKEN = 'fixture-legacy-device-token-v1';
const HEALTHY_DEVICE_TOKEN = 'fixture-healthy-device-token-v1';
const LEGACY_TEMP_NAME = 'phase1.json.4242.1700000000000.tmp';

export async function generateUpgradeFixture(outputDir) {
  const output = resolve(outputDir);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const dataDir = join(output, 'data');
  const server = await createObtsServer({
    dataDir,
    publicBaseUrl: 'http://127.0.0.1:3000',
    sessionSecret: 'synthetic-upgrade-fixture-session-secret',
    transferChunkBytes: 1_048_576,
    maxTransferBytes: 16_777_216,
    maxTransferStorageBytes: 33_554_432
  });

  try {
    const setup = await server.auth.setupInitialAdmin({
      username: 'fixture-admin',
      password: 'fixture-only-password-1234',
      displayName: 'Upgrade fixture admin'
    });
    const legacyRoot = await server.git.initializeVault(LEGACY_VAULT_ID);
    const healthyRoot = await server.git.initializeVault(HEALTHY_VAULT_ID);
    const timestamp = new Date().toISOString();

    await server.store.mutate((db) => {
      db.vaults.push(
        vaultRow(LEGACY_VAULT_ID, setup.user.user_id, 'N-1 legacy vault', legacyRoot, timestamp),
        vaultRow(HEALTHY_VAULT_ID, setup.user.user_id, 'Healthy isolation vault', healthyRoot, timestamp)
      );
      db.devices.push(
        deviceRow(LEGACY_DEVICE_ID, LEGACY_VAULT_ID, setup.user.user_id, legacyRoot, timestamp),
        deviceRow(HEALTHY_DEVICE_ID, HEALTHY_VAULT_ID, setup.user.user_id, healthyRoot, timestamp)
      );
      db.tokens.push(
        tokenRow('tok_n1_legacy', LEGACY_DEVICE_TOKEN, setup.user.user_id, LEGACY_VAULT_ID, LEGACY_DEVICE_ID, timestamp),
        tokenRow('tok_n1_healthy', HEALTHY_DEVICE_TOKEN, setup.user.user_id, HEALTHY_VAULT_ID, HEALTHY_DEVICE_ID, timestamp)
      );
      server.store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: LEGACY_VAULT_ID,
        resource_ids: { vault_id: LEGACY_VAULT_ID },
        commit_cursors: { main: legacyRoot, previous_main: null },
        payload: { reason: 'empty_root' }
      });
      server.store.appendEvent(db, {
        event_type: 'main_advanced',
        vault_id: HEALTHY_VAULT_ID,
        resource_ids: { vault_id: HEALTHY_VAULT_ID },
        commit_cursors: { main: healthyRoot, previous_main: null },
        payload: { reason: 'empty_root' }
      });
    });

    const beforeMetadata = JSON.parse(await readFile(join(dataDir, 'metadata', 'phase1.json'), 'utf8'));
    const snapshot = await server.store.snapshot();
    const legacyAuth = authenticatedDevice(snapshot, LEGACY_VAULT_ID, LEGACY_DEVICE_ID, LEGACY_DEVICE_TOKEN);
    const legacyPack = await server.git.exportPack(LEGACY_VAULT_ID, legacyRoot, null);
    const legacyRequest = pushRequest({
      vaultId: LEGACY_VAULT_ID,
      deviceId: LEGACY_DEVICE_ID,
      targetCommit: legacyRoot,
      clientKnownMain: legacyRoot,
      attemptId: 'legacy-upgrade-attempt',
      planSeed: 'legacy-upgrade-plan'
    });
    const legacyTransfer = await server.chunkTransfers.createPush(legacyAuth, legacyRequest);
    const legacyTransferId = legacyTransfer.descriptor.transfer_id;
    const legacySessionPath = join(dataDir, 'transfers', legacyTransferId, 'session.json');
    const oldSessionBytes = (await readFile(legacySessionPath)).byteLength;
    await server.chunkTransfers.putChunk(
      legacyAuth,
      legacyTransferId,
      0,
      legacyPack,
      sha256(legacyPack)
    );
    const session = JSON.parse(await readFile(legacySessionPath));
    const repairedStoredBytes = session.stored_bytes;
    session.stored_bytes = repairedStoredBytes + oldSessionBytes;
    await rm(join(dataDir, 'transfers', legacyTransferId, 'owner.json'), { force: true });
    await writeFile(legacySessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });

    const legacyTempPath = join(dataDir, 'metadata', LEGACY_TEMP_NAME);
    await writeFile(legacyTempPath, 'interrupted previous-release metadata write\n', { mode: 0o600 });

    const { targetCommit, packfile } = await createHealthyUploadPack(
      dataDir,
      HEALTHY_VAULT_ID,
      healthyRoot,
      output
    );
    await writeFile(join(output, 'upload.pack'), packfile, { mode: 0o600 });

    const descriptor = {
      schema_version: 1,
      producer_commit: PRODUCER_COMMIT,
      producer_description: PRODUCER_DESCRIPTION,
      generated_by: 'scripts/generate-upgrade-fixture.mjs',
      data_dir: 'data',
      legacy_metadata_temp: `data/metadata/${LEGACY_TEMP_NAME}`,
      legacy_vault_id: LEGACY_VAULT_ID,
      legacy_device_id: LEGACY_DEVICE_ID,
      legacy_device_token: LEGACY_DEVICE_TOKEN,
      legacy_root_commit: legacyRoot,
      legacy_transfer_id: legacyTransferId,
      legacy_session: `data/transfers/${legacyTransferId}/session.json`,
      legacy_owner_marker: `data/transfers/${legacyTransferId}/owner.json`,
      legacy_stored_bytes_before_upgrade: session.stored_bytes,
      repaired_stored_bytes_after_upgrade: repairedStoredBytes,
      healthy_vault_id: HEALTHY_VAULT_ID,
      healthy_device_id: HEALTHY_DEVICE_ID,
      healthy_device_token: HEALTHY_DEVICE_TOKEN,
      healthy_root_commit: healthyRoot,
      healthy_target_commit: targetCommit,
      healthy_packfile: 'upload.pack',
      canonical_metadata: {
        schema_version: beforeMetadata.schema_version,
        setup_complete: beforeMetadata.setup_complete,
        vault_ids: beforeMetadata.vaults.map((vault) => vault.vault_id).sort(),
        device_ids: beforeMetadata.devices.map((device) => device.device_id).sort()
      }
    };
    await writeFile(join(output, 'descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    await writeChecksums(output);
    return descriptor;
  } finally {
    await server.app.close();
  }
}

function vaultRow(vaultId, userId, displayName, rootCommit, timestamp) {
  return {
    vault_id: vaultId,
    owner_user_id: userId,
    display_name: displayName,
    status: 'active',
    root_commit: rootCommit,
    current_main: rootCommit,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function deviceRow(deviceId, vaultId, userId, rootCommit, timestamp) {
  return {
    device_id: deviceId,
    vault_id: vaultId,
    user_id: userId,
    device_name: deviceId,
    device_ref: `refs/obts/devices/${deviceId}`,
    device_ref_head: null,
    status: 'synced',
    last_applied_main: rootCommit,
    last_applied_event_seq: 1,
    last_applied_explicit_dirs: [],
    pending_applied_main: null,
    pending_applied_event_seq: 0,
    pending_applied_explicit_dirs: null,
    last_seen_at: timestamp,
    last_successful_sync_at: null,
    local_status_label: null,
    local_error_code: null,
    local_queue_status: null,
    local_main: rootCommit,
    local_head: rootCommit,
    plugin_version: '0.4.36',
    path_capabilities: null,
    last_status_report_at: null,
    onboarding_status: 'complete',
    onboarding_mode: 'use_server',
    initial_proposal_kind: null,
    initial_proposal_base: null,
    onboarding_connection_id: null,
    onboarding_completed_at: timestamp,
    created_at: timestamp,
    revoked_at: null
  };
}

function tokenRow(tokenId, token, userId, vaultId, deviceId, timestamp) {
  const hashed = hashToken(token);
  return {
    token_id: tokenId,
    kind: 'device',
    lookup_prefix: hashed.lookupPrefix,
    token_hash: hashed.hash,
    user_id: userId,
    vault_id: vaultId,
    device_id: deviceId,
    expires_at: null,
    consumed_at: null,
    failed_attempts: 0,
    revoked_at: null,
    metadata: {},
    created_at: timestamp
  };
}

function authenticatedDevice(db, vaultId, deviceId, tokenValue) {
  const device = db.devices.find((candidate) => candidate.device_id === deviceId);
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  const user = db.users.find((candidate) => candidate.user_id === device?.user_id);
  const token = db.tokens.find((candidate) => candidate.device_id === deviceId);
  if (!device || !vault || !user || !token) throw new Error(`fixture device ${deviceId} was not persisted`);
  if (!tokenValue) throw new Error('fixture token is empty');
  return { user, vault, device, token };
}

function pushRequest({ vaultId, deviceId, targetCommit, clientKnownMain, attemptId, planSeed }) {
  return {
    api_version: API_VERSION,
    plugin_version: '0.4.36',
    vault_id: vaultId,
    device_id: deviceId,
    expected_device_ref: null,
    target_commit: targetCommit,
    client_known_main: clientKnownMain,
    base_commit: clientKnownMain,
    attempt_id: attemptId,
    chunk_count: 1,
    plan_sha256: sha256(Buffer.from(planSeed))
  };
}

async function createHealthyUploadPack(dataDir, vaultId, rootCommit, outputDir) {
  const workDir = join(outputDir, '.pack-work');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(join(workDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
  await runGit(workDir, ['init', '--bare', '--quiet']);
  await writeFile(
    join(workDir, 'objects', 'info', 'alternates'),
    `${join(dataDir, 'git', `${vaultId}.git`, 'objects')}\n`,
    { mode: 0o600 }
  );
  const blob = await gitText(workDir, ['hash-object', '-w', '--stdin'], Buffer.from('upgrade canary content\n'));
  const tree = await gitText(workDir, ['mktree'], Buffer.from(`100644 blob ${blob}\tcanary.md\n`));
  const targetCommit = await gitText(
    workDir,
    ['commit-tree', tree, '-p', rootCommit, '-m', 'obts: upgrade canary commit'],
    undefined,
    {
      GIT_AUTHOR_NAME: 'OBTS upgrade fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'OBTS upgrade fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
    }
  );
  const packfile = await gitBuffer(
    workDir,
    ['pack-objects', '--stdout', '--revs', '--thin'],
    Buffer.from(`${targetCommit}\n^${rootCommit}\n`)
  );
  await rm(workDir, { recursive: true, force: true });
  return { targetCommit, packfile };
}

async function writeChecksums(output) {
  const files = [];
  await collectFiles(output, output, files);
  files.sort();
  const lines = [];
  for (const file of files) {
    if (file === 'checksums.sha256' || file === 'descriptor.json') continue;
    lines.push(`${sha256(await readFile(join(output, file)))}  ${file}`);
  }
  await writeFile(join(output, 'checksums.sha256'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function collectFiles(root, current, result) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, result);
    else if (entry.isFile()) result.push(relative(root, path));
  }
}

async function runGit(cwd, args, input, env = {}) {
  await runGitProcess(cwd, args, input, env);
}

async function gitText(cwd, args, input, env = {}) {
  const result = await runGitProcess(cwd, args, input, env);
  return result.stdout.toString('utf8').trim();
}

async function gitBuffer(cwd, args, input, env = {}) {
  const result = await runGitProcess(cwd, args, input, env);
  return result.stdout;
}

async function runGitProcess(cwd, args, input, env) {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectProcess);
    child.once('close', (code, signal) => {
      const output = Buffer.concat(stdout);
      const error = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolveProcess({ stdout: output });
      } else {
        rejectProcess(new Error(`git ${args.join(' ')} failed (${code ?? signal}): ${error}`));
      }
    });
    child.stdin.end(input === undefined ? undefined : input);
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const output = process.argv[2];
  if (!output) {
    throw new Error('usage: node scripts/generate-upgrade-fixture.mjs <output-directory>');
  }
  const descriptor = await generateUpgradeFixture(output);
  process.stdout.write(`${JSON.stringify({ output: resolve(output), producer_commit: descriptor.producer_commit }, null, 2)}\n`);
}
