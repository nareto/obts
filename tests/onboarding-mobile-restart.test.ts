import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createObtsServer, type ObtsServer } from '../src/server/app.js';
import { ObtsPluginClient } from '../src/client/core.js';
import { mobileHarness, click, waitUntil } from './helpers/mobileOnboardingHarness.js';

type Harness = Awaited<ReturnType<typeof mobileHarness>>;
let root: string, url: string, server: ObtsServer, vaultId: string, cookie: string, csrf: string;
const harnesses: Harness[] = [];
async function post(path: string, body: unknown, authenticated = true) {
  const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie, 'x-obts-csrf': csrf } : {}) }, body: JSON.stringify(body) });
  const json: any = await response.json();
  if (!response.ok) throw new Error(`Test request ${path}: ${response.status}`);
  if (!authenticated) { cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); csrf = json.csrf_token; }
  return json;
}
async function seed() {
  const desktopRoot = join(root, 'desktop');
  const desktop = new ObtsPluginClient(desktopRoot, { serverUrl: url, deviceName: 'desktop' });
  const connection = await desktop.startOnboarding('Desktop');
  await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
  const analysis = await desktop.analyzeOnboarding(connection.connection_id, connection.connection_secret);
  await desktop.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'use_server' });
  await writeFile(join(desktopRoot, 'note.md'), 'server bytes\n');
  await mkdir(join(desktopRoot, 'empty'));
  await desktop.syncOnce();
  return { desktop, desktopRoot };
}
async function prepared() {
  const phoneRoot = join(root, 'phone');
  await mkdir(phoneRoot);
  await writeFile(join(phoneRoot, 'note.md'), 'local recovery bytes\n');
  const h = await mobileHarness(phoneRoot, url); harnesses.push(h);
  const connection = await h.plugin.runExclusiveAction(() => h.core.startOnboarding('Phone', 'use_server'));
  await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
  await h.plugin.runExclusiveAction(() => h.core.prepareReplacementOnboarding(connection.connection_id, connection.connection_secret));
  return { h, phoneRoot, connection };
}
beforeEach(async () => {
  await mkdir('tmp/mobile-restart', { recursive: true });
  root = await mkdtemp(join(process.cwd(), 'tmp/mobile-restart/run-'));
  server = await createObtsServer({ dataDir: join(root, 'server'), publicBaseUrl: 'http://127.0.0.1:0', sessionSecret: 'synthetic-session-secret-for-restart-tests' });
  url = await server.app.listen({ port: 0, host: '127.0.0.1' });
  await post('/api/v1/setup', { username: 'owner', password: 'synthetic-test-password-1234', display_name: 'Owner' }, false);
  vaultId = (await post('/api/v1/vaults', { display_name: 'Recovery vault' })).vault_id;
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.dispose();
  await server.app.close();
  await rm(root, { recursive: true, force: true });
});

async function child(root: string, boundary: string) {
  const processChild = fork('tests/fixtures/onboarding-crash-child.mjs', [root, url, boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  processChild.stderr?.on('data', data => { stderr += String(data).slice(0, 4096); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal })));
  const message = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error('Child boundary timeout')); }, 25000);
    processChild.once('message', message => { clearTimeout(timer); resolve(message); });
    processChild.once('exit', code => { clearTimeout(timer); if (code !== null && code !== 0) reject(new Error(`Child failed: ${stderr}`)); });
  });
  if (message.boundary) processChild.kill('SIGKILL');
  const result = await exit;
  if (message.failed) throw new Error(`Child failed: ${message.failed}`);
  return { message, ...result };
}
async function verifyRecovery(phoneRoot: string) {
  const recoveryRoot = join(phoneRoot, '.obts/recovery');
  const bundles = (await readdir(recoveryRoot)).filter(name => name.startsWith('rec_'));
  expect(bundles.length).toBeGreaterThan(0);
  let retained = false;
  for (const bundle of bundles) {
    const directory = join(recoveryRoot, bundle);
    for (const line of (await readFile(join(directory, 'checksums.sha256'), 'utf8')).trim().split('\n')) {
      const [digest, path] = line.split('  ');
      const bytes = await readFile(join(directory, path!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
      retained ||= bytes.toString() === 'local recovery bytes\n';
    }
  }
  expect(retained).toBe(true);
}

describe('packaged mobile onboarding recovery', () => {
  it('keeps a missing credential blocked in the cold modal without starting another enrollment', async () => {
    const { h, phoneRoot } = await prepared();
    h.dispose();
    const journal = await readFile(join(phoneRoot, '.obts/onboarding.json'), 'utf8');
    await h.core.fsp.rm(h.core.pendingConnectionPath);
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const modal = await restarted.open();
    expect(modal.contentEl.allText).toContain('credential');
    expect(modal.contentEl.allText).toContain('Preserve');
    expect(modal.contentEl.buttons.map((button: any) => button.text)).toEqual(['Close']);
    expect(restarted.requests.filter(path => path === '/api/v1/connections' || path.endsWith('/complete'))).toHaveLength(0);
    expect(await readFile(join(phoneRoot, '.obts/onboarding.json'), 'utf8')).toBe(journal);
  });

  it.each(['approved', 'consumed'])('reviews changed local consent on the same enrollment: %s', async status => {
    await seed();
    const { h, phoneRoot, connection } = await prepared();
    const saved = await h.core.readPendingOnboarding();
    if (status === 'consumed') await h.core.completeConnection(connection.connection_id, connection.connection_secret, { mode: 'use_server', expected_main: saved.journal.analysis.expectedMain });
    await h.core.writeOnboardingJournal({ ...saved.journal, stage: 'blocked', selected_mode: 'use_server' });
    await writeFile(join(phoneRoot, 'note.md'), 'later local edit\n');
    h.dispose();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const modal = await restarted.open();
    await click(modal, 'Resume setup');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('local vault changed');
    await click(modal, 'Review changed local contents');
    expect(modal.contentEl.allText).toContain('1 syncable files');
    const before = await restarted.core.readPendingOnboarding();
    expect(before.journal.analysis.localFingerprint).toBe(saved.journal.analysis.localFingerprint);
    await click(modal, 'Confirm updated consent');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('Sync is ready');
    const journal = JSON.parse(await readFile(join(phoneRoot, '.obts/onboarding.json'), 'utf8'));
    expect(journal.connection.connection_id).toBe(connection.connection_id);
    expect(journal.analysis.expectedMain).toBe(saved.journal.analysis.expectedMain);
    expect(journal.analysis.localFingerprint).not.toBe(saved.journal.analysis.localFingerprint);
    expect((await server.store.snapshot()).devices).toHaveLength(2);
    expect(restarted.requests.filter(path => path === '/api/v1/connections')).toHaveLength(0);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('server bytes\n');
    const bundles = await readdir(join(phoneRoot, '.obts/recovery'));
    expect((await Promise.all(bundles.map(bundle => readFile(join(phoneRoot, '.obts/recovery', bundle, 'files/note.md'), 'utf8').catch(() => '')))).some(bytes => bytes === 'later local edit\n')).toBe(true);
  });

  it.each(['apply', 'credential', 'proposal', 'identity'])('does not refresh initial consent after local publication: %s', async boundary => {
    const { h } = await prepared();
    const pending = await h.core.readPendingOnboarding();
    await h.core.writeOnboardingJournal({ ...pending.journal, selected_mode: 'use_server', ...(boundary === 'proposal' ? { proposal_commit: 'a'.repeat(40) } : {}) });
    if (boundary === 'apply') await h.core.fsp.writeFile(h.core.applyJournalPath, '{preserve-unresolved-evidence');
    if (boundary === 'credential') await h.core.fsp.writeFile(h.core.authPath, JSON.stringify({ device_token: 'synthetic' }));
    if (boundary === 'identity') await h.core.writeState({ ...await h.core.readState(), device_id: 'accepted-device' });
    const original = await h.core.fsp.readFile(h.core.onboardingJournalPath, 'utf8');
    await expect(h.core.reviewOnboardingConsent()).rejects.toMatchObject({ code: 'onboarding_context_required' });
    expect(await h.core.fsp.readFile(h.core.onboardingJournalPath, 'utf8')).toBe(original);
  });

  it('replays a completed merge receipt after activation expires proposal authorization', async () => {
    await seed();
    const phoneRoot = join(root, 'phone'); await mkdir(phoneRoot);
    await writeFile(join(phoneRoot, 'extra.md'), 'merge local bytes\n');
    const phone = new ObtsPluginClient(phoneRoot, { serverUrl: url, deviceName: 'merge-device' });
    const connection = await phone.startOnboarding('Phone');
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    const analysis = await phone.analyzeOnboarding(connection.connection_id, connection.connection_secret);
    const request = { mode: 'merge', expected_main: analysis.expectedMain, proposal_kind: 'independent_vault_merge', proposal_base: analysis.proposalBase };
    const complete = (body: unknown) => fetch(`${url}/api/v1/connections/${connection.connection_id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${connection.connection_secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await complete(request); expect(first.status).toBe(201);
    const receipt: any = await first.json();
    expect((await complete(request)).status).toBe(201);
    await phone.finishOnboarding({ connectionId: connection.connection_id, secret: connection.connection_secret, analysis, mode: 'merge' });
    const db = await server.store.snapshot();
    expect(db.devices.find(device => device.device_id === receipt.device_id)).toMatchObject({ onboarding_status: 'complete', initial_proposal_kind: null, initial_proposal_base: null });
    const replay = await complete(request); expect(replay.status).toBe(201);
    expect((await replay.json() as any).device_id).toBe(receipt.device_id);
    expect((await complete({ ...request, proposal_kind: 'shared_baseline_merge', proposal_base: 'f'.repeat(40) })).status).toBe(201);
    expect((await complete({ ...request, mode: 'use_server' })).status).toBe(409);
    expect((await complete({ ...request, expected_main: 'f'.repeat(40) })).status).toBe(409);
    expect((await server.store.snapshot()).events.length).toBe(db.events.length);
    expect((await server.store.snapshot()).devices).toHaveLength(2);
  });
  it('accepts N-1 enrollment payloads and binds consumed receipts and replay to the original mode and credential', async () => {
    const created = await fetch(`${url}/api/v1/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      plugin_version: '0.5.1', device_name: 'N-1 device', local_vault_name: 'N-1 vault', local_summary: { has_content: false, syncable_file_count: 0, syncable_bytes: 0, has_detached_baseline: false }
    }) });
    expect(created.status).toBe(201);
    const connection: any = await created.json();
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    const baseline = (await server.store.snapshot()).vaults.find(vault => vault.vault_id === vaultId)!.current_main;
    const complete = async (body: unknown) => fetch(`${url}/api/v1/connections/${connection.connection_id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${connection.connection_secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const request = { mode: 'use_server', expected_main: baseline };
    const first = await complete(request);
    expect(first.status).toBe(201);
    const receipt: any = await first.json();
    const status = await fetch(`${url}/api/v1/connections/${connection.connection_id}`, { headers: { authorization: `Bearer ${connection.connection_secret}` } });
    expect(await status.json()).toMatchObject({ status: 'consumed', selection: 'existing_vault', expected_main: baseline, mode: 'use_server', device_id: receipt.device_id });
    const replay: any = await (await complete(request)).json();
    expect(replay.device_token === receipt.device_token).toBe(true);
    expect((await complete({ ...request, mode: 'initialize' })).status).toBe(409);
    expect((await complete({ ...request, expected_main: 'f'.repeat(40) })).status).toBe(409);
    await server.store.mutate(db => { db.tokens.find(token => token.device_id === receipt.device_id)!.revoked_at = new Date().toISOString(); });
    expect((await fetch(`${url}/api/v1/connections/${connection.connection_id}`, { headers: { authorization: `Bearer ${connection.connection_secret}` } })).status).toBe(409);
    expect((await complete(request)).status).toBe(409);
    expect((await server.store.snapshot()).devices).toHaveLength(1);
  });

  it('reopens the real modal after response loss with no retained analysis', async () => {
    await seed();
    const phoneRoot = join(root, 'phone');
    await mkdir(phoneRoot);
    await writeFile(join(phoneRoot, 'note.md'), 'local recovery bytes\n');
    const h = await mobileHarness(phoneRoot, url); harnesses.push(h);
    const complete = h.core.completeConnection.bind(h.core);
    h.core.completeConnection = async (...args: any[]) => { await complete(...args); throw new h.plugin.constructor.TransportError(0, 'network_error', 'Synthetic lost response'); };
    const modal = await h.open();
    const disposition = modal.contentEl.controls.find((control: any) => control.value === 'keep');
    expect(disposition).toBeDefined();
    disposition.change('use_server');
    const browserAction = click(modal, 'Continue in browser');
    await waitUntil(async () => Boolean(await h.core.readPendingOnboarding()));
    const connection = (await h.core.readPendingOnboarding()).journal.connection;
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'existing_vault', vault_id: vaultId });
    h.hide(); h.foreground();
    await browserAction;
    expect(modal.contentEl.allText).toContain('Replace this vault');
    await click(modal, 'Replace local contents');
    await waitUntil(() => modal.onboardingPaused);
    h.dispose();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const reopened = await restarted.open();
    expect(reopened.contentEl.buttons.some((button: any) => button.text === 'Resume setup')).toBe(true);
    await click(reopened, 'Resume setup');
    await waitUntil(() => !reopened.onboardingRunning);
    expect(reopened.contentEl.allText).toContain('Sync is ready');
    expect((await server.store.snapshot()).devices).toHaveLength(2);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('server bytes\n');
    await verifyRecovery(phoneRoot);
  });

  it.each(['approved', 'consumed'])('migrates a historical null-analysis early-replacement journal: %s', async status => {
    await seed();
    const { h, phoneRoot, connection } = await prepared();
    const saved = await h.core.readPendingOnboarding();
    if (status === 'consumed') await h.core.completeConnection(connection.connection_id, connection.connection_secret, { mode: 'use_server', expected_main: saved.journal.analysis.expectedMain });
    await h.core.writeOnboardingJournal({ ...saved.journal, analysis: null, selected_mode: 'use_server', stage: 'blocked', last_error_code: 'onboarding_failed' });
    h.dispose();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const modal = await restarted.open();
    await click(modal, 'Resume setup');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).toContain('Sync is ready');
    expect((await server.store.snapshot()).devices).toHaveLength(2);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('server bytes\n');
    await verifyRecovery(phoneRoot);
  });

  it.each(['missing-consent', 'stale-consent', 'mode', 'vault', 'revoked'])('preserves historical state when migration is unsafe: %s', async fault => {
    await seed();
    const { h, phoneRoot, connection } = await prepared();
    const saved = await h.core.readPendingOnboarding();
    if (['mode', 'revoked'].includes(fault)) {
      const completion = await h.core.completeConnection(connection.connection_id, connection.connection_secret, { mode: 'use_server', expected_main: saved.journal.analysis.expectedMain });
      await server.store.mutate(db => {
        const device = db.devices.find(device => device.device_id === completion.device_id)!;
        if (fault === 'revoked') { device.revoked_at = new Date().toISOString(); device.status = 'revoked'; }
        else device.onboarding_mode = 'merge';
      });
    }
    if (fault === 'stale-consent') await writeFile(join(phoneRoot, 'note.md'), 'later local edit\n');
    if (fault === 'vault') await h.core.writeState({ ...await h.core.readState(), vault_id: 'other-vault', device_id: 'other-device' });
    await h.core.writeOnboardingJournal({ ...saved.journal, analysis: null, selected_mode: 'use_server', stage: 'blocked', ...(fault === 'missing-consent' ? { pending_summary: null } : {}) });
    h.dispose();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const modal = await restarted.open();
    await click(modal, 'Resume setup');
    await waitUntil(() => !modal.onboardingRunning);
    expect(modal.contentEl.allText).not.toContain('Sync is ready');
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe(fault === 'stale-consent' ? 'later local edit\n' : 'local recovery bytes\n');
    expect(await restarted.core.readPendingOnboarding()).not.toBeNull();
    expect(restarted.requests.filter(path => path.endsWith('/sync/pull-chunk'))).toHaveLength(0);
  });

  it.each(['checkpoint', 'pending-ack'])('settles %s before catching up to an advanced main', async boundary => {
    const { desktop, desktopRoot } = await seed();
    const { h, phoneRoot } = await prepared();
    if (boundary === 'checkpoint') {
      const pull = h.core.pull.bind(h.core);
      h.core.pull = async (...args: any[]) => { await pull(...args); throw new Error('Synthetic checkpoint interruption'); };
    } else {
      h.core.completePendingAppliedAcknowledgement = async () => { throw new Error('Synthetic acknowledgement interruption'); };
    }
    const modal = await h.open();
    await click(modal, 'Replace local contents');
    await waitUntil(() => !modal.onboardingRunning);
    const checkpoint = JSON.parse(await readFile(join(phoneRoot, '.obts/pull-transfer.json'), 'utf8'));
    expect(checkpoint.complete).toBe(true);
    if (boundary === 'checkpoint') await writeFile(join(phoneRoot, '.obts/pull-transfer.json'), JSON.stringify({ ...checkpoint, padding: 'SYNTHETIC_PRIVATE_MARKER'.repeat(30000) }));
    h.dispose();
    await writeFile(join(desktopRoot, 'note.md'), 'advanced server bytes\n');
    await desktop.syncOnce();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    const targets: string[] = [];
    const summaries: any[] = [];
    const apply = restarted.core.applyTargetMain.bind(restarted.core);
    restarted.core.applyTargetMain = async (...args: any[]) => { targets.push(args[0]); summaries.push(await restarted.core.collectTroubleshootingContext()); return apply(...args); };
    const reopened = await restarted.open();
    await click(reopened, 'Resume setup');
    await waitUntil(() => !reopened.onboardingRunning);
    expect(reopened.contentEl.allText).toContain('Sync is ready');
    if (boundary === 'checkpoint') {
      expect(targets[0]).toBe(checkpoint.target_main);
      expect(summaries[0]).toMatchObject({ transfer_journal: 'present', recovery_summary: { transfer_read: 'oversized', checkpoint: 'complete' } });
      expect(JSON.stringify(summaries)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    }
    const ackIndex = restarted.requests.findIndex(path => path.endsWith('/sync/applied'));
    const pullIndex = restarted.requests.findIndex(path => path.endsWith('/sync/pull-chunk'));
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(pullIndex);
    expect(restarted.requests.filter(path => path.endsWith('/sync/pull-chunk'))).toHaveLength(1);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('advanced server bytes\n');
  });

  it('keeps lease ownership while unloading an active modal operation', async () => {
    await seed();
    const { h, phoneRoot } = await prepared();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const complete = h.core.completeConnection.bind(h.core);
    h.core.completeConnection = async (...args: any[]) => { entered = true; await gate; return complete(...args); };
    const modal = await h.open();
    await click(modal, 'Replace local contents');
    await waitUntil(() => entered);
    expect(h.plugin.operationAvailability()).toBe('busy');
    h.plugin.onunload();
    expect(h.plugin.operationAvailability()).toBe('busy');
    await expect(h.plugin.runExclusiveAction(async () => {})).rejects.toMatchObject({ code: 'operation_interrupted_by_reload' });
    release();
    await waitUntil(() => !modal.onboardingRunning);
    expect(h.plugin.operationAvailability()).toBe('available');
    expect(modal.contentEl.allText).not.toContain('Sync is ready');
    h.dispose();
    const restarted = await mobileHarness(phoneRoot, url); harnesses.push(restarted);
    expect(await restarted.core.readPendingOnboarding()).toBeNull();
    await restarted.plugin.runExclusiveAction(() => restarted.core.syncOnce());
    expect((await restarted.core.readState()).status_label).toBe('Synced');
    expect((await server.store.snapshot()).devices).toHaveLength(2);
  });

  it.each(['foreground-first', 'rejection-first'])('serializes manual and automatic retry: %s', async order => {
    const { h } = await prepared();
    let reject!: (error: Error) => void;
    let calls = 0;
    h.core.finishOnboarding = () => {
      calls += 1;
      if (calls === 1) return new Promise((_resolve, fail) => { reject = fail; });
      return Promise.reject(new h.plugin.constructor.TransportError(0, 'network_error', 'Synthetic offline'));
    };
    const modal = await h.open();
    await click(modal, 'Replace local contents');
    await waitUntil(() => calls === 1);
    await modal.contentEl.buttons.find((button: any) => button.text === 'Replace local contents').click();
    expect(calls).toBe(1);
    h.hide();
    if (order === 'foreground-first') h.foreground();
    reject(new h.plugin.constructor.TransportError(0, 'network_error', 'Synthetic offline'));
    await waitUntil(() => modal.onboardingPaused);
    if (order === 'rejection-first') h.foreground();
    await waitUntil(() => calls === 2);
    await new Promise(resolve => setTimeout(resolve, 1400));
    expect(calls).toBe(2);
    modal.close(); h.foreground();
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(calls).toBe(2);
  });

  it.each(['proposal-ref', 'proposal'])('publishes only one initialization proposal after cold restart at %s', async boundary => {
    const phoneRoot = join(root, 'new-vault-phone');
    await mkdir(phoneRoot);
    await writeFile(join(phoneRoot, 'note.md'), 'local recovery bytes\n');
    const h = await mobileHarness(phoneRoot, url); harnesses.push(h);
    const connection = await h.plugin.runExclusiveAction(() => h.core.startOnboarding('New vault'));
    await post(`/api/v1/connections/${connection.connection_id}/approve`, { selection: 'new_vault', display_name: 'New recovery vault' });
    await h.plugin.runExclusiveAction(() => h.core.analyzeOnboarding(connection.connection_id, connection.connection_secret));
    h.dispose();
    expect(await child(phoneRoot, boundary)).toMatchObject({ message: { boundary }, signal: 'SIGKILL' });
    expect(await child(phoneRoot, 'resume')).toMatchObject({ message: { complete: true }, code: 0 });
    const db = await server.store.snapshot();
    expect(db.devices).toHaveLength(1);
    expect(db.events.filter(event => event.event_type === 'device_ref_updated')).toHaveLength(1);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('local recovery bytes\n');
  });

  it.each(['enrollment', 'accepted', 'credential', 'identity', 'registered', 'chunk', 'checkpoint', 'recovery', 'apply-recovery', 'displaced', 'files', 'committed', 'pending-ack', 'acknowledged', 'activated'])('SIGKILL and cold restart at %s', async boundary => {
    const { desktop, desktopRoot } = await seed();
    if (boundary === 'chunk') {
      server.config.transferChunkBytes = 1_048_576;
      await writeFile(join(desktopRoot, 'first.bin'), randomBytes(700_000));
      await writeFile(join(desktopRoot, 'second.bin'), randomBytes(700_000));
      await desktop.syncOnce();
    }
    const { h, phoneRoot } = await prepared();
    h.dispose();
    const killed = await child(phoneRoot, boundary);
    expect(killed).toMatchObject({ message: { boundary }, signal: 'SIGKILL' });
    if (boundary === 'checkpoint') {
      const checkpoint = JSON.parse(await readFile(join(phoneRoot, '.obts/pull-transfer.json'), 'utf8'));
      expect(checkpoint.complete).toBe(true);
    }
    if (boundary === 'displaced') {
      const journal = JSON.parse(await readFile(join(phoneRoot, '.obts/apply-journal.json'), 'utf8'));
      expect(journal.phase).toBe('writing_files');
      expect(await readFile(join(phoneRoot, '.obts/apply-displaced', journal.apply_id, 'note.md.entry'), 'utf8')).toBe('local recovery bytes\n');
      await expect(readFile(join(phoneRoot, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      await verifyRecovery(phoneRoot);
    }
    const savedCursor = boundary === 'chunk' ? JSON.parse(await readFile(join(phoneRoot, '.obts/pull-transfer.json'), 'utf8')).next_cursor : null;
    const completed = await child(phoneRoot, 'resume');
    expect(completed).toMatchObject({ message: { complete: true }, code: 0 });
    if (boundary === 'chunk') {
      expect(savedCursor).toBeGreaterThan(0);
      expect(completed.message.cursors[0]).toBe(savedCursor);
      expect(await readFile(join(phoneRoot, 'first.bin'))).toEqual(await readFile(join(desktopRoot, 'first.bin')));
      expect(await readFile(join(phoneRoot, 'second.bin'))).toEqual(await readFile(join(desktopRoot, 'second.bin')));
    }
    if (boundary === 'checkpoint') expect(completed.message.cursors).toHaveLength(0);
    expect(await readFile(join(phoneRoot, 'note.md'), 'utf8')).toBe('server bytes\n');
    expect(await readdir(phoneRoot)).toContain('empty');
    expect((await server.store.snapshot()).devices).toHaveLength(2);
    const device = (await server.store.snapshot()).devices.find(device => device.device_name === 'Recovery device')!;
    expect(device.onboarding_status).toBe('complete');
    expect(device.last_applied_main).toBe((await server.store.snapshot()).vaults.find(vault => vault.vault_id === vaultId)!.current_main);
    expect(await readFile(join(phoneRoot, '.obts/apply-journal.json')).catch(() => null)).toBeNull();
    await verifyRecovery(phoneRoot);
  });
});
