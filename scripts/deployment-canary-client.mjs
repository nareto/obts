import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const fixtureDir = '/var/lib/obts/canary';
const descriptor = JSON.parse(await readFile(`${fixtureDir}/descriptor.json`, 'utf8'));
const packfile = await readFile(`${fixtureDir}/${descriptor.healthy_packfile}`);
const baseUrl = 'http://127.0.0.1:3000';
const readyBudgetMs = 5_000;

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

async function waitForLive() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('candidate image did not become live within 30 seconds');
}

await waitForLive();
const readyStarted = Date.now();
const ready = await requestJson('/health/ready');
const readyElapsed = Date.now() - readyStarted;
if (ready.response.status !== 200) {
  if (!ready.body || typeof ready.body !== 'object' || typeof ready.body.detail !== 'string') {
    throw new Error('candidate readiness failure did not include bounded failure detail');
  }
  throw new Error(`candidate readiness failed: ${ready.body.detail}`);
}
if (readyElapsed > readyBudgetMs) {
  throw new Error(`candidate readiness exceeded ${readyBudgetMs}ms budget: ${readyElapsed}ms`);
}

const createRequest = {
  api_version: '2026-07-12.browser-onboarding',
  plugin_version: '0.4.36',
  vault_id: descriptor.healthy_vault_id,
  device_id: descriptor.healthy_device_id,
  expected_device_ref: null,
  target_commit: descriptor.healthy_target_commit,
  client_known_main: descriptor.healthy_root_commit,
  base_commit: descriptor.healthy_root_commit,
  attempt_id: 'healthy-canary-attempt',
  chunk_count: 1,
  plan_sha256: createHash('sha256').update('healthy-canary-plan').digest('hex')
};
const created = await requestJson(`/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers`, {
  method: 'POST',
  headers: { authorization: `Bearer ${descriptor.healthy_device_token}` },
  body: JSON.stringify(createRequest)
});
if (created.response.status !== 201 || !created.body || typeof created.body.transfer_id !== 'string') {
  throw new Error(`healthy canary transfer creation failed: HTTP ${created.response.status}`);
}

const transferId = created.body.transfer_id;
const uploaded = await fetch(
  `${baseUrl}/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers/${transferId}/chunks/0`,
  {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${descriptor.healthy_device_token}`,
      'content-type': 'application/x-git-packed-objects',
      'x-obts-chunk-sha256': createHash('sha256').update(packfile).digest('hex')
    },
    body: packfile
  }
);
if (uploaded.status !== 200) {
  throw new Error(`healthy canary chunk upload failed: HTTP ${uploaded.status}`);
}

const finalized = await requestJson(
  `/api/v1/vaults/${descriptor.healthy_vault_id}/sync/push-transfers/${transferId}/finalize`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${descriptor.healthy_device_token}` }
  }
);
if (finalized.response.status !== 200 || !finalized.body || !['merged', 'noop'].includes(finalized.body.status)) {
  throw new Error(`healthy canary finalize failed: HTTP ${finalized.response.status}`);
}

const pulled = await requestJson(`/api/v1/vaults/${descriptor.legacy_vault_id}/sync/pull-chunk`, {
  method: 'POST',
  headers: { authorization: `Bearer ${descriptor.legacy_device_token}` },
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
if (pulled.response.status !== 200) {
  throw new Error(`existing canary pull failed: HTTP ${pulled.response.status}`);
}

process.stdout.write(`canary passed: live, ready (${readyElapsed}ms), upload, finalize, pull\n`);
