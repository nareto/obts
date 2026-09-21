import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StackFailure, RunControl, OwnedProcessGroup, postgresEnvironment, sandboxEnvironment, proxyRuntimeEnabled, parseMemory, summarizeMemory, safeFailure } from './bridge-stack-runtime.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const binary = join(resolve(repo, process.env.CARGO_TARGET_DIR ?? 'target'), 'debug', 'obts_bridge');
const baseDatabase = process.env.OBTS_SYNTHETIC_POSTGRES_URL;
const embeddingMode = process.env.OBTS_BRIDGE_STACK_EMBEDDINGS ?? 'disabled';
const configuredReport = Boolean(process.env.OBTS_BRIDGE_STACK_REPORT);
const resultPath = resolve(process.env.OBTS_BRIDGE_STACK_REPORT ?? join(tmpdir(), `obts-bridge-stack-result-${process.pid}-${Date.now()}.json`));
let root;
let databaseUrl;
const database = `stack_${process.pid}_${Date.now()}_${randomBytes(6).toString('hex')}`;
const run = new RunControl();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options = {}) => {
  run.checkpoint('http-request');
  return originalFetch(input, { ...options, signal: AbortSignal.any([run.controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(120_000)]) });
};
const serverSecret = randomBytes(48).toString('hex');
const apiToken = randomBytes(32).toString('hex');
const readerToken = randomBytes(32).toString('hex');
const mcpToken = randomBytes(32).toString('hex');
let server;
let bridge;
let runtime;
let databaseCreated = false;
let creationUnconfirmed = false;
let cleaning = false;
let cleanupPromise;
let memoryTimer;
let stage = 'setup';
let phase = 'small';
let sampling = false;
let nodePids = [];
let bridgeUrl;
const samples = [];
const checks = [];
const report = { passed: false, checks, corpus: {}, memory: {}, embeddingMode, stack: 'Rust Bridge + supervised Node + TypeScript server + synthetic PostgreSQL; HTTP cookie/CSRF approval, not visual browser UI' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash('sha256').update(text).digest('hex');
const shellWord = value => "'" + value.replaceAll("'", "'\\''") + "'";
const check = (condition, label) => { run.checkpoint('assertion'); if (!condition) throw new StackFailure('assertion', label); checks.push(label); };
function sql(query, url = databaseUrl.href) {
  const operation = query.startsWith('CREATE DATABASE') ? 'database-create' : query.startsWith('DROP DATABASE') ? 'database-drop' : 'database-check';
  if (!cleaning) run.checkpoint(operation);
  const result = spawnSync('psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', url, '-c', query], { env: postgresEnvironment(root, process.env.PATH), timeout: 30_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error?.code === 'ENOENT') throw new StackFailure('missing-psql', operation);
  if (result.error?.code === 'ETIMEDOUT') throw new StackFailure('sql-timeout', operation);
  if (result.status !== 0) throw new StackFailure('sql-command-failed', operation);
  return result.stdout.trim();
}
async function launchServer(create, options, port) {
  run.checkpoint('server-create');
  server = await create(options);
  run.checkpoint('server-listen');
  const address = await server.app.listen({ host: '127.0.0.1', port });
  run.checkpoint('server-started');
  return address;
}
async function request(base, path, { method = 'GET', body, token, cookie, csrf, bearer, headers = {}, raw = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-api-key': token } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-obts-csrf': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000)
  });
  if (raw) return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed, headers: response.headers };
}
class BrowserSession {
  cookie = '';
  csrf = '';
  constructor(base) { this.base = base; }
  async post(path, body, useCsrf = true) {
    const result = await request(this.base, path, { method: 'POST', body, cookie: this.cookie, csrf: useCsrf ? this.csrf : undefined });
    const cookies = result.headers.getSetCookie().map(cookie => cookie.split(';')[0]);
    if (cookies.length) this.cookie = cookies.join('; ');
    if (typeof result.body?.csrf_token === 'string') this.csrf = result.body.csrf_token;
    return result;
  }
}
async function availablePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function until(predicate, label, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    run.checkpoint('wait-for-readiness');
    if (bridge && (bridge.exitCode !== null || bridge.signalCode !== null)) throw new Error('synthetic Bridge exited');
    if (await predicate()) return;
    await sleep(250);
  }
  throw new StackFailure('timeout', label);
}
async function command(command, arguments_ = {}) {
  const result = await request(bridgeUrl, '/api/v1/admin/headless/command', { method: 'POST', token: apiToken, body: { command, arguments: arguments_ } });
  assert.equal(result.status, 200, 'headless command HTTP status');
  return result.body;
}
async function ready() {
  await until(async () => (await request(bridgeUrl, '/health/ready')).status === 200, 'projection readiness');
}
async function embeddingsSettled(label) {
  if (embeddingMode === 'disabled') return;
  await until(async () => Number(sql('SELECT (SELECT count(*) FROM notes WHERE embedding IS NULL)+(SELECT count(*) FROM blocks WHERE embedding IS NULL)')) === 0, 'embedding completion', 360_000);
  check(true, label);
}
async function rss(pid) {
  try { return parseMemory(await readFile(`/proc/${pid}/status`, 'utf8')); } catch { return null; }
}
async function sample() {
  if (!bridge || sampling) return;
  sampling = true;
  const process = bridge;
  const group = runtime;
  try {
    nodePids = await group.observeChildren();
    const rust = await rss(process.pid);
    const nodes = await Promise.all(nodePids.map(rss));
    const validNodes = nodes.length > 0 && nodes.every(node => node !== null);
    samples.push({ phase, rustRss: rust?.rss ?? null, rustAnon: rust?.anon ?? null, nodeRss: validNodes ? nodes.reduce((sum, node) => sum + node.rss, 0) : null, nodeAnon: validNodes ? nodes.reduce((sum, node) => sum + node.anon, 0) : null });
  } finally { sampling = false; }
}
async function steady() {
  const start = samples.length;
  for (let i = 0; i < 6; i++) { run.checkpoint('rss-observation'); await sleep(250); await sample(); }
  const selected = samples.slice(start).filter(value => value.phase === phase && value.rustRss > 0 && value.nodeRss > 0);
  if (selected.length < 3) throw new StackFailure('insufficient-rss-observations', 'rss-observation');
  return Object.fromEntries(['rustRss', 'rustAnon', 'nodeRss', 'nodeAnon'].map(key => [key, selected.map(value => value[key]).sort((a, b) => a - b)[Math.floor(selected.length / 2)]]));
}
async function corpus(directory, start, end) {
  const size = 1024 * 1024;
  const filler = 'boundedmemory alphabet quartz projection synthetic ordinary text ';
  for (let i = start; i < end; i++) {
    run.checkpoint('write-synthetic-corpus');
    const prefix = `# Fixture ${i}\n\nuniquequartz${i} [[Public.md]]\n\n`;
    const text = prefix + filler.repeat(Math.ceil((size - prefix.length) / filler.length)).slice(0, size - prefix.length);
    assert.equal(Buffer.byteLength(text), size);
    await writeFile(join(directory, `Fixture${String(i).padStart(3, '0')}.md`), text);
  }
}
async function startBridge(configPath, tokenDir, mcpDir) {
  run.checkpoint('bridge-spawn');
  nodePids = [];
  bridge = spawn(binary, [], { cwd: root, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', CONFIG_PATH: configPath, API_TOKEN_DIR: tokenDir, MCP_BEARER_TOKEN_DIR: mcpDir, CONFIG_RELOAD_INTERVAL_SECONDS: '0', RUST_LOG: 'error' } });
  bridge.on('error', () => {});
  runtime = new OwnedProcessGroup(bridge);
  await runtime.observeChildren();
  run.checkpoint('bridge-started');
}
async function stopBridge(force = false) {
  if (!runtime) return;
  await runtime.stop(force);
  runtime = undefined;
  bridge = undefined;
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    cleaning = true;
    clearInterval(memoryTimer);
    const failures = [];
    try { await stopBridge(); } catch (error) { failures.push(safeFailure(error, 'bridge-stop')); }
    try {
      if (server) {
        await Promise.race([server.app.close(), sleep(8000).then(() => { throw new StackFailure('server-stop-unconfirmed', 'server-stop'); })]);
        server = undefined;
      }
    } catch (error) { failures.push(safeFailure(error, 'server-stop')); }
    if (!failures.length && databaseCreated) {
      try { sql(`DROP DATABASE ${database} WITH (FORCE)`, baseDatabase); databaseCreated = false; } catch (error) { failures.push(safeFailure(error, 'database-drop')); }
    }
    if (creationUnconfirmed) failures.push({ category: 'database-creation-unconfirmed', operation: 'database-create' });
    if (!failures.length && root) {
      try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(safeFailure(error, 'temporary-directory-remove')); }
    }
    return failures;
  })();
}

try {
  run.checkpoint('postgres-url');
  try { databaseUrl = new URL(baseDatabase); } catch { throw new StackFailure('invalid-synthetic-postgres-url', 'postgres-url'); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) || !databaseUrl.username || databaseUrl.password || databaseUrl.search || databaseUrl.hash) throw new StackFailure('unsafe-synthetic-postgres-url', 'postgres-url');
  databaseUrl.pathname = `/${database}`;
  if (proxyRuntimeEnabled(process.env, process.execArgv)) throw new StackFailure('proxy-enabled-node-runtime', 'preflight');
  if (!['disabled', 'local'].includes(embeddingMode)) throw new StackFailure('invalid-embedding-mode', 'preflight');
  if (process.platform !== 'linux') throw new StackFailure('linux-required', 'preflight');
  run.checkpoint('temporary-directory-create');
  root = await mkdtemp(join(tmpdir(), 'obts-bridge-stack-'));
  await chmod(root, 0o700);
  process.env = sandboxEnvironment(root, process.env.PATH);
  process.chdir(root);
  await writeFile(join(root, 'empty.pgpass'), '', { mode: 0o600, flag: 'wx' });
  run.checkpoint('bridge-binary-read');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(binary)) digest.update(chunk);
  report.bridgeBinarySha256 = digest.digest('hex');
  report.nodeVersion = process.version;
  const { createObtsServer } = await import(pathToFileURL(join(repo, 'dist/src/server/app.js')));
  const { ObtsPluginClient } = await import(pathToFileURL(join(repo, 'dist/src/client/core.js')));
  creationUnconfirmed = true;
  try { sql(`CREATE DATABASE ${database}`, baseDatabase); }
  catch (error) { if (error.category === 'missing-psql') creationUnconfirmed = false; throw error; }
  databaseCreated = true;
  creationUnconfirmed = false;
  const serverUrl = await launchServer(createObtsServer, { dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: serverSecret }, 0);
  const admin = new BrowserSession(serverUrl);
  const setup = await admin.post('/api/v1/setup', { username: 'admin', password: randomBytes(24).toString('hex'), display_name: 'Synthetic admin' }, false);
  assert.equal(setup.status, 201);
  const vault = await admin.post('/api/v1/vaults', { display_name: 'Bounded synthetic stack' });
  assert.equal(vault.status, 201);
  const vaultId = vault.body.vault_id;
  const sourceDir = join(root, 'source');
  const bridgeDir = join(root, 'bridge');
  await mkdir(sourceDir);
  await mkdir(bridgeDir);
  const peer = new ObtsPluginClient(sourceDir, { serverUrl, deviceName: 'synthetic-peer' });
  const pairing = await peer.startOnboarding('Synthetic peer');
  assert.equal((await admin.post(`/api/v1/connections/${pairing.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId })).status, 200);
  const analysis = await peer.analyzeOnboarding(pairing.connection_id, pairing.connection_secret);
  const linked = await peer.finishOnboarding({ connectionId: pairing.connection_id, secret: pairing.connection_secret, analysis, mode: 'use_server' });
  check(linked.status === 'Synced', 'peer paired to the disposable server');
  await corpus(sourceDir, 0, 8);
  await writeFile(join(sourceDir, 'Public.md'), '# Public\n\npublic-marker [[Private.md]]\n');
  await writeFile(join(sourceDir, 'Private.md'), '---\ntags: [private]\n---\n# Private\n\nprivate-marker ' + 'synthetic private fixture content '.repeat(16) + '\n');
  check((await peer.syncOnce({ confirmInitialImport: true })).status === 'Synced', 'small corpus published by a real client');
  const tokenDir = join(root, 'tokens');
  const mcpDir = join(root, 'mcp-tokens');
  await mkdir(tokenDir, { mode: 0o700 });
  await mkdir(mcpDir, { mode: 0o700 });
  await writeFile(join(tokenDir, 'admin.token'), apiToken, { mode: 0o600 });
  await writeFile(join(tokenDir, 'reader.token'), readerToken, { mode: 0o600 });
  await writeFile(join(mcpDir, 'admin.token'), mcpToken, { mode: 0o600 });
  const port = await availablePort();
  bridgeUrl = `http://127.0.0.1:${port}`;
  const configPath = join(root, 'config.yaml');
  await writeFile(configPath, JSON.stringify({
    server: { host: '127.0.0.1', port, log_level: 'error' },
    client: { vault_dir: bridgeDir, headless_command: [process.execPath, join(repo, 'dist/src/headless.js')].map(shellWord).join(' '), server_url: serverUrl, device_name: 'synthetic-bridge', auto_start: true, scan_interval_seconds: 1, projection_max_file_text_bytes: 67108864, projection_max_inflight_bodies: 2, projection_batch_rows: 128, projection_batch_bytes: 8388608 },
    database: { url: databaseUrl.href, max_connections: 6 },
    embedding: { mode: embeddingMode, dimensions: 64, poll_interval_seconds: 1, block_chunk_bytes: 4096 },
    api_tokens: { admin: { context: 'admin' }, reader: { context: 'reader' } },
    mcp_tokens: { admin: { context: 'admin' } },
    contexts: { admin: { read: [{ allow: { default: true } }], create: [{ allow: { default: true } }], edit: [{ allow: { default: true } }] }, reader: { read: [{ deny: { tags_any: ['private'] } }, { allow: { default: true } }] } },
    audit: { enabled: true, retention_days: 90 }
  }), { mode: 0o600 });
  stage = 'spawn-and-pair';
  await startBridge(configPath, tokenDir, mcpDir);
  memoryTimer = setInterval(() => { sample().catch(() => {}); }, 250);
  await until(async () => { try { return (await request(bridgeUrl, '/health/live')).status === 200; } catch { return false; } }, 'Bridge liveness');
  check((await request(bridgeUrl, '/api/v1/status')).status === 401, 'unauthenticated REST request denied');
  const pending = await command('start-onboarding', { localVaultName: 'Synthetic bridge' });
  assert.equal((await admin.post(`/api/v1/connections/${pending.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId })).status, 200);
  const bridgeAnalysis = await command('analyze-onboarding', { connectionId: pending.connection_id, secret: pending.connection_secret });
  await command('finish-onboarding', { connectionId: pending.connection_id, secret: pending.connection_secret, analysis: bridgeAnalysis, mode: 'use_server' });
  await ready();
  check(true, 'Rust-supervised Node paired with cookie/CSRF owner approval and became ready');
  stage = 'small-corpus';
  for (let i = 0; i < 2; i++) { await command('reset-index-projection'); await ready(); }
  await embeddingsSettled('small-profile note and block embeddings complete');
  if (embeddingMode === 'local') check(Number(sql("SELECT count(*) FROM blocks b JOIN notes n ON n.id=b.note_id WHERE n.id='Private.md' AND b.embedding IS NOT NULL AND n.embedding IS NOT NULL")) > 0, 'trusted worker embeds the private note and its blocks');
  report.memory.smallSteady = await steady();
  report.corpus.smallFixtureBytes = 8 * 1024 * 1024;
  const smallRead = await request(bridgeUrl, '/api/v1/vault-files/Fixture000.md', { token: apiToken });
  check(smallRead.status === 200 && hash(smallRead.body.content) === hash(await readFile(join(sourceDir, 'Fixture000.md'), 'utf8')), 'raw REST file matches peer source SHA-256');
  check(smallRead.body.content_sha256.replace(/^sha256:/, '') === hash(smallRead.body.content), 'reported raw SHA-256 matches response bytes');
  check((await request(bridgeUrl, '/api/v1/vault-files/Private.md', { token: readerToken })).status === 404, 'private exact body denied to scoped reader');
  const exported = await request(bridgeUrl, '/api/v1/vault-files/export?include=markdown', { token: readerToken, raw: true });
  const exportEtag = exported.headers.get('etag');
  check(exported.status === 200 && exported.headers.get('content-type') === 'application/zip' && exported.body.subarray(0, 2).toString() === 'PK' && /^"v1:sha256:[0-9a-f]{64}"$/.test(exportEtag ?? ''), 'policy-aware Markdown ZIP export streams with a strong deterministic ETag');
  const cachedExport = await request(bridgeUrl, '/api/v1/vault-files/export?include=markdown', { token: readerToken, headers: { 'if-none-match': `W/${exportEtag}` }, raw: true });
  check(cachedExport.status === 304 && cachedExport.body.length === 0 && cachedExport.headers.get('etag') === exportEtag, 'weak If-None-Match returns 304 for the deterministic export');
  const deniedSearch = await request(bridgeUrl, '/api/v1/notes/query', { method: 'POST', token: readerToken, body: { text_query: 'private-marker', search_mode: 'fulltext' } });
  check(deniedSearch.status === 200 && deniedSearch.body.total === 0, 'private lexical result excluded');
  const lexical = await request(bridgeUrl, '/api/v1/notes/query', { method: 'POST', token: readerToken, body: { text_query: 'quartz0', search_mode: 'fulltext' } });
  check(lexical.status === 200 && lexical.body.notes.some(note => note.id === 'Fixture000.md'), 'legacy substring query works through the live SQL backend');
  const base = await request(bridgeUrl, '/api/v1/base/query', { method: 'POST', token: readerToken, body: { base_query: 'views:\n  - type: table\n    order: [file.name, file.links]\n' } });
  check(base.status === 200 && !JSON.stringify(base.body).includes('Private.md'), 'Base link projection excludes denied target IDs');
  stage = 'large-corpus';
  phase = 'large';
  await corpus(sourceDir, 8, 72);
  check((await peer.syncOnce()).status === 'Synced', 'large corpus published by a real client');
  await command('sync-once');
  await ready();
  await until(async () => (await request(bridgeUrl, '/api/v1/vault-files/Fixture071.md', { token: apiToken })).status === 200, 'last large fixture');
  report.corpus.largeFixtureBytes = 72 * 1024 * 1024;
  await embeddingsSettled('large-profile note and block embeddings complete');
  report.memory.largeSteady = await steady();
  check(true, 'more than 64 MiB synchronized and served by the real stack');
  stage = 'writes-mcp-recovery';
  const created = await request(bridgeUrl, '/api/v1/vault-files', { method: 'POST', token: apiToken, body: { title: 'Stack disposable', content: '# Stack disposable\n\ninitial-marker\n' } });
  check([200, 201, 202].includes(created.status) && typeof created.body.id === 'string', 'REST create accepted');
  const id = created.body.id;
  await ready();
  const readCreated = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { token: apiToken });
  assert.equal(readCreated.status, 200);
  check(/^v1:sha256:[0-9a-f]{64}$/.test(readCreated.body.revision), 'exact REST read returns an opaque whole-file revision');
  const missingRevision = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { method: 'PUT', token: apiToken, body: { content: 'missing-precondition-must-not-land' } });
  check(missingRevision.status === 428, 'REST edit without expected_revision is rejected with 428');
  const unknownField = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { method: 'PUT', token: apiToken, body: { expected_revision: readCreated.body.revision, expected_sha256: readCreated.body.content_sha256, content: 'unknown-field-must-not-land' } });
  check(unknownField.status === 400, 'REST edit rejects unknown legacy mutation fields');
  const edited = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { method: 'PUT', token: apiToken, body: { expected_revision: readCreated.body.revision, content: '# Stack disposable\n\nedited-marker\n' } });
  check([200, 201, 202].includes(edited.status) && edited.body.revision !== readCreated.body.revision, 'revision-safe REST edit advances the whole-file revision');
  await ready();
  const stale = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { method: 'PUT', token: apiToken, body: { expected_revision: readCreated.body.revision, content: 'stale-overwrite-must-not-land' } });
  check(stale.status === 412, 'stale REST revision rejected with 412');
  await command('sync-once');
  check((await peer.syncOnce()).status === 'Synced', 'REST edit synchronized back to peer');
  const after = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { token: apiToken });
  check(after.status === 200 && hash(after.body.content) === hash(await readFile(join(sourceDir, id), 'utf8')) && after.body.content.includes('edited-marker'), 'peer and REST edit bytes agree');
  const initialized = await request(bridgeUrl, '/mcp', { method: 'POST', bearer: mcpToken, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-stack', version: '1' } } } });
  check(initialized.status === 200 && Boolean(initialized.body?.result?.protocolVersion), 'MCP initialization succeeds');
  const mcp = await request(bridgeUrl, '/mcp', { method: 'POST', bearer: mcpToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_vault_file', arguments: { id, raw: true } } } });
  const structured = mcp.body?.result?.structuredContent;
  check(mcp.status === 200 && mcp.body?.result?.isError === false && hash(structured.content) === hash(after.body.content), 'MCP raw file matches REST exactly');
  const auditBefore = Number(sql('SELECT count(*) FROM access_log'));
  await command('reset-index-projection');
  await ready();
  check(Number(sql('SELECT count(*) FROM access_log')) >= auditBefore, 'derived projection reset preserves access audit');
  const recovered = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { token: apiToken });
  check(recovered.status === 200 && hash(recovered.body.content) === hash(after.body.content), 'same-commit rebuild recovers exact bytes');
  check(Number(sql("SELECT (SELECT count(*) FROM notes WHERE content<>'' OR search_text<>'')+(SELECT count(*) FROM vault_files WHERE content<>'')+(SELECT count(*) FROM blocks WHERE content<>'')")) === 0, 'legacy raw SQL body fields stay empty (derived lexical plaintext is separate)');
  stage = 'pending-write-volume-restore';
  await server.app.close();
  server = undefined;
  const offlineEdit = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { method: 'PUT', token: apiToken, body: { expected_revision: recovered.body.revision, content: '# Stack disposable\n\npending-restore-marker\n' } });
  check([200, 202].includes(offlineEdit.status), 'REST edit remains accepted while the sync server is unavailable');
  check((await readFile(join(bridgeDir, id), 'utf8')).includes('pending-restore-marker'), 'pending edit exists in authoritative client files before termination');
  await stopBridge(true);
  run.checkpoint('stopped-client-volume-copy');
  const backup = join(root, 'stopped-client-backup');
  await cp(bridgeDir, backup, { recursive: true, preserveTimestamps: true });
  await rm(bridgeDir, { recursive: true, force: true });
  await cp(backup, bridgeDir, { recursive: true, preserveTimestamps: true });
  check((await readFile(join(bridgeDir, id), 'utf8')).includes('pending-restore-marker'), 'client volume copied and restored only after forced runtime termination');
  await launchServer(createObtsServer, { dataDir: join(root, 'server'), publicBaseUrl: serverUrl, sessionSecret: serverSecret }, Number(new URL(serverUrl).port));
  await startBridge(configPath, tokenDir, mcpDir);
  await until(async () => { try { return (await request(bridgeUrl, '/health/live')).status === 200; } catch { return false; } }, 'restarted Bridge liveness');
  await command('sync-once');
  await ready();
  check((await peer.syncOnce()).status === 'Synced', 'restored client publishes pending work to the peer');
  const restored = await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { token: apiToken });
  check(restored.status === 200 && restored.body.content.includes('pending-restore-marker') && hash(restored.body.content) === hash(await readFile(join(sourceDir, id), 'utf8')), 'pending edit survives SIGKILL, client-volume restore and resynchronization');
  check(Number(sql('SELECT count(*) FROM access_log')) >= auditBefore, 'runtime restart and client restore preserve retained SQL audit');
  await rm(join(sourceDir, id));
  check((await peer.syncOnce()).status === 'Synced', 'disposable file deleted through the peer');
  await command('sync-once');
  await ready();
  check((await request(bridgeUrl, `/api/v1/vault-files/${encodeURI(id)}`, { token: apiToken })).status === 404, 'peer deletion projects to REST 404');
  await embeddingsSettled('embeddings complete after reset, pending-write restore and deletion');
  report.embeddingConfiguration = { mode: embeddingMode, dimensions: 64, pollIntervalSeconds: 1, blockChunkBytes: 4096 };
  report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.failure = safeFailure(error, run.operation);
  process.exitCode = run.signalName === 'SIGINT' ? 130 : run.signalName === 'SIGTERM' ? 143 : 1;
} finally {
  clearInterval(memoryTimer);
  for (const name of ['small', 'large']) report.memory[`${name}Peak`] = summarizeMemory(samples, name);
  report.memory.sampleCount = samples.length;
  report.memory.note = 'Rust and supervised Node process bytes only; sampled maxima are lower bounds on actual peaks. Missing observations are null, not zero. No numerical parser, allocator, singleton or RSS ceiling is established.';
  report.cleanupFailures = await cleanup();
  report.syntheticResourcesRemoved = report.cleanupFailures.length === 0;
  if (!report.syntheticResourcesRemoved) {
    report.passed = false;
    process.exitCode ||= 1;
    report.possiblyRemaining = { temporaryDirectory: root, database, processGroup: runtime?.id };
  }
  globalThis.fetch = originalFetch;
  if (run.signalName) {
    report.passed = false;
    report.failure = { category: 'interrupted', operation: 'run-cancelled' };
    process.exitCode = run.signalName === 'SIGINT' ? 130 : 143;
  }
  let reportWritten = false;
  try { await writeFile(resultPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }); reportWritten = true; }
  catch (error) { report.passed = false; report.failure = safeFailure(error, 'report-write'); process.exitCode ||= 1; }
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failedStage: report.failedStage, failure: report.failure, resultPath: reportWritten && !configuredReport ? resultPath : undefined, configuredReportWritten: configuredReport ? reportWritten : undefined, syntheticResourcesRemoved: report.syntheticResourcesRemoved }));
  run.dispose();
}
