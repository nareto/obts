#!/usr/bin/env node

import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ObtsPluginClient } from '../dist/src/client/core.js';
import { createObtsServer } from '../dist/src/server/app.js';
import { OperationalLog } from '../dist/src/server/operationalLog.js';
import { addSyntheticHistory } from './sync-latency-fixture.mjs';

const sizes = (process.env.OBTS_LATENCY_HISTORY ?? '0,2000,8000').split(',').map(Number);
if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) throw new Error('Invalid history sizes.');
const samples = [];
for (const historySize of sizes) samples.push(await measure(historySize));
process.stdout.write(`${JSON.stringify({ samples }, null, 2)}\n`);

async function measure(historySize) {
  const root = await mkdtemp(join(tmpdir(), 'obts-sync-latency-'));
  const dataDir = join(root, 'server');
  const vaultDir = join(root, 'client');
  const rows = [];
  let persistence = { count: 0, bytes: 0, io_ms: 0 };
  let persistStarted = 0;
  const options = {
    operationalLog: new OperationalLog('debug', (line) => rows.push(JSON.parse(line))),
    metadataPersistence: {
      writeFile: async (path, data) => {
        persistStarted = performance.now();
        persistence.count++;
        persistence.bytes += Buffer.byteLength(data);
        await writeFile(path, data, { mode: 0o600, flag: 'wx' });
      },
      fsyncDirectory: async (path) => {
        const directory = await open(path, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        persistence.io_ms += performance.now() - persistStarted;
      }
    }
  };
  let server;
  try {
    server = await createObtsServer({ dataDir, publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: 'synthetic-benchmark-session-key' }, options);
    const baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const setup = await server.app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'benchmark', password: 'synthetic-benchmark-password' } });
    const headers = { cookie: String(setup.headers['set-cookie']).split(';')[0], 'x-obts-csrf': setup.json().csrf_token };
    const created = await server.app.inject({ method: 'POST', url: '/api/v1/vaults', headers, payload: { display_name: 'Synthetic latency vault' } });
    const vaultId = created.json().vault_id;
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, 'note.md'), 'synthetic baseline\n');
    const plugin = new ObtsPluginClient(vaultDir, { serverUrl: baseUrl, deviceName: 'synthetic-latency-device' });
    const connection = await plugin.startOnboarding('Synthetic latency vault');
    await server.app.inject({ method: 'POST', url: `/api/v1/connections/${connection.connection_id}/approve`, headers,
      payload: { selection: 'existing_vault', vault_id: vaultId } });
    const analysis = await plugin.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    await plugin.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'merge' });
    await plugin.syncOnce({ confirmInitialImport: true });
    await plugin.client.flushDeviceStatusReports?.();
    const db = addSyntheticHistory(await server.store.snapshot(), historySize);
    const localState = await plugin.readState();
    await plugin.writeState({ ...localState, last_event_seq: db.event_seq_by_vault[vaultId], last_applied_event_seq: db.event_seq_by_vault[vaultId] });
    await plugin.client.mutateStaleProvenance(async (saved) => { for (const horizon of saved.horizons) horizon.expiry = Date.now() - 1; });
    const metadataPath = join(dataDir, 'metadata', 'phase1.json');
    await server.app.close();
    await writeFile(metadataPath, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
    const fixtureBytes = Buffer.byteLength(await readFile(metadataPath));
    const cloneCosts = {};
    for (const [name, clone] of Object.entries({ json: (value) => JSON.parse(JSON.stringify(value)), structured: structuredClone })) {
      const start = performance.now();
      for (let index = 0; index < 10; index++) clone(db);
      cloneCosts[name] = Math.round((performance.now() - start) / 10);
    }
    server = await createObtsServer({ dataDir }, options);
    await server.app.listen({ port: Number(new URL(baseUrl).port), host: '127.0.0.1' });
    const token = await plugin.client.readDeviceToken();
    const deviceHeaders = { authorization: `Bearer ${token}` };
    const phases = {};
    const run = async (name, action) => {
      rows.length = 0;
      persistence = { count: 0, bytes: 0, io_ms: 0 };
      const checkpoints = [];
      const started = performance.now();
      plugin.setProgressListener((_status, point) => checkpoints.push({ point, ms: Math.round(performance.now() - started) }));
      const result = await action();
      const criticalMs = Math.round(performance.now() - started);
      await plugin.client.flushDeviceStatusReports?.();
      phases[name] = { ms: criticalMs, drained_ms: Math.round(performance.now() - started), status: result?.status,
        persistence: { ...persistence, io_ms: Math.round(persistence.io_ms) },
        routes: rows.filter((row) => row.event === 'http_request').map(({ method, route, duration_ms, status }) => ({ method, route, duration_ms, status })),
        integrations: rows.filter((row) => row.event === 'push_integrated').map(({ duration_ms, persist_count, persist_ms, git_ms }) => ({ duration_ms, persist_count, persist_ms, git_ms })),
        checkpoints };
    };
    await run('authenticated_reads', async () => {
      for (let index = 0; index < 10; index++) {
        const result = await server.app.inject({ method: 'GET', url: '/api/v1/device/self', headers: deviceHeaders });
        if (result.statusCode !== 200) throw new Error('Synthetic authenticated read failed.');
      }
    });
    await run('idle', async () => await plugin.maintenanceTick());
    await writeFile(join(vaultDir, 'note.md'), 'synthetic one-file update\n');
    await plugin.recordLocalChangeHint(['note.md']);
    await run('own_push', async () => await plugin.maintenanceTick());
    await plugin.client.mutateStaleProvenance(async (saved) => { for (const horizon of saved.horizons) horizon.expiry = Date.now() - 1; });
    await plugin.maintenanceTick();
    await plugin.client.flushDeviceStatusReports?.();
    await writeFile(join(vaultDir, 'note.md'), 'synthetic contended update\n');
    await plugin.recordLocalChangeHint(['note.md']);
    await run('contended_push', async () => {
      const report = { plugin_version: db.devices[0].plugin_version, local_status_label: 'Synced', local_error_code: null,
        local_queue_status: 'idle', local_main: null, local_head: null, path_capabilities: null };
      const noise = Promise.all(Array.from({ length: 4 }, () => server.app.inject({ method: 'POST', url: `/api/v1/vaults/${vaultId}/sync/device-status`, headers: deviceHeaders, payload: report })));
      const result = await plugin.maintenanceTick();
      await noise;
      return result;
    });
    return { history_size: historySize, fixture_bytes: fixtureBytes, clone_ms: cloneCosts, phases };
  } finally {
    await server?.app.close();
    await rm(root, { recursive: true, force: true });
  }
}
