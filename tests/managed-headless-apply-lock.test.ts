import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
const currentGeneration = '22222222-2222-4222-8222-222222222222';
const priorGeneration = '11111111-1111-4111-8111-111111111111';
const replacementGeneration = '33333333-3333-4333-8333-333333333333';
const isManagedMarker = (marker: any) => marker && Object.keys(marker).sort().join(',') === 'apply_id,domain,generation,version' &&
  marker.version === 2 && marker.domain === 'obts-managed-linux-headless' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(marker.generation) &&
  typeof marker.apply_id === 'string' && /^apply_[0-9A-Za-z_-]{1,120}$/u.test(marker.apply_id);
const owner = (generation: string) => ({ generation, canReclaim: (marker: any) =>
  isManagedMarker(marker) && marker.generation !== generation,
  publishApplyMarker: async (markerPath: string, contents: string) => writeFile(markerPath, contents, { flag: 'wx', mode: 0o600 })
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-apply-owner-'));
  roots.push(root);
  const client = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'apply-owner' });
  const core = client.client as any;
  core.managedHeadlessOwner = {
    ...owner(currentGeneration),
    publishApplyMarker: (contents: string) => core.fsp.writeFile(core.applyLockPath, contents, { flag: 'wx', mode: 0o600 })
  };
  await mkdir(join(root, '.obts'), { mode: 0o700, recursive: true });
  return { root, client, core, lockPath: join(root, '.obts', 'apply.lock') };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('managed apply lock ownership', () => {
  it('reclaims only a validated older managed-v2 marker without journal dependence', async () => {
    const { core, lockPath } = await fixture();
    const staleMarker = { version: 2, domain: 'obts-managed-linux-headless', generation: priorGeneration, apply_id: 'apply_old' };
    await writeFile(lockPath, JSON.stringify(staleMarker), { mode: 0o600 });
    expect(core.managedHeadlessOwner.canReclaim(staleMarker)).toBe(true);
    await core.acquireApplyLock('apply_new');
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      version: 2, domain: 'obts-managed-linux-headless', generation: currentGeneration, apply_id: 'apply_new'
    });
    await core.releaseApplyLock('apply_new');
  });

  it.each([
    ['legacy', { apply_id: 'apply_old', created_at: 'old' }],
    ['legacy extra-field', { apply_id: 'apply_old', created_at: '2026-01-01T00:00:00.000Z', extra: true }],
    ['foreign', { version: 2, domain: 'foreign', generation: priorGeneration, apply_id: 'apply_old' }],
    ['extra-field', { version: 2, domain: 'obts-managed-linux-headless', generation: priorGeneration, apply_id: 'apply_old', extra: true }],
    ['loose-uuid', { version: 2, domain: 'obts-managed-linux-headless', generation: '11111111-1111-1111-1111-111111111111', apply_id: 'apply_old' }],
    ['invalid-apply-id', { version: 2, domain: 'obts-managed-linux-headless', generation: priorGeneration, apply_id: 'not-an-apply-id' }],
    ['malformed', '{']
  ])('preserves unknown %s markers and fails closed', async (_label, marker) => {
    const { core, lockPath } = await fixture();
    const bytes = typeof marker === 'string' ? marker : JSON.stringify(marker);
    await writeFile(lockPath, bytes, { mode: 0o600 });
    await expect(core.acquireApplyLock('apply_new')).rejects.toMatchObject({ code: 'apply_lock_active' });
    expect(await readFile(lockPath, 'utf8')).toBe(bytes);
  });

  it('does not steal a same-generation marker and never unlinks a replacement on release', async () => {
    const { core, lockPath } = await fixture();
    const active = { version: 2, domain: 'obts-managed-linux-headless', generation: currentGeneration, apply_id: 'apply_live' };
    await writeFile(lockPath, JSON.stringify(active), { mode: 0o600 });
    await expect(core.acquireApplyLock('apply_new')).rejects.toMatchObject({ code: 'apply_lock_active' });
    await rm(lockPath);
    await core.acquireApplyLock('apply_owned');
    const replacement = { version: 2, domain: 'obts-managed-linux-headless', generation: replacementGeneration, apply_id: 'apply_replacement' };
    await writeFile(lockPath, JSON.stringify(replacement));
    expect(await core.releaseApplyLock('apply_owned')).toBe(false);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('releases and reacquires the legacy unmanaged lock across repeated applies', async () => {
    const { client, core, root, lockPath } = await fixture();
    core.managedHeadlessOwner = null;
    await client.initialize();
    const initial = await core.createLocalCommit('unmanaged apply baseline');
    await core.updateRef('refs/heads/main', initial, null, true);
    await core.updateRef('refs/heads/local', initial, null, true);
    await core.writeState({ ...(await core.readState()), local_main: initial, local_head: initial });
    await core.adapter.write('repeat.md', 'first target');
    const first = await core.createLocalCommit('first unmanaged target');
    await core.applyTargetMain(first, ['repeat.md'], true);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await core.fsp.rm(core.pendingAppliedAckPath, { force: true });
    await core.adapter.write('repeat.md', 'second target');
    const second = await core.createLocalCommit('second unmanaged target');
    await core.applyTargetMain(second, ['repeat.md'], true);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(second).not.toBe(first);
  });

  it('releases the startup-recovery lock after a committed-journal error and retries cleanly', async () => {
    const { client, core, root, lockPath } = await fixture();
    await client.initialize();
    const initial = await core.createLocalCommit('committed recovery baseline');
    await core.updateRef('refs/heads/main', initial, null, true);
    await core.updateRef('refs/heads/local', initial, null, true);
    await core.writeState({ ...(await core.readState()), local_main: initial, local_head: initial });
    await core.adapter.write('target.md', 'committed target');
    const target = await core.createLocalCommit('committed recovery target');
    core.clearApplyState = async () => { throw new Error('injected post-commit failure'); };
    await expect(core.applyTargetMain(target, ['target.md'], true)).rejects.toThrow('injected post-commit failure');
    expect(JSON.parse(await readFile(join(root, '.obts', 'apply-journal.json'), 'utf8'))).toMatchObject({ phase: 'committed' });

    const restarted = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'apply-owner-retry' });
    const restartedCore = restarted.client as any;
    const originalUpdateRef = restartedCore.updateRef.bind(restartedCore);
    restartedCore.updateRef = async () => { throw new Error('injected startup recovery ref failure'); };
    await expect(restarted.initialize()).rejects.toThrow('injected startup recovery ref failure');
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    restartedCore.updateRef = originalUpdateRef;
    await restarted.initialize();
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['writeState', 'preApplyAuthoringBase'])('releases its owned lock when the early %s await fails', async (failurePoint) => {
    const { client, core, root, lockPath } = await fixture();
    await client.initialize();
    const initial = await core.createLocalCommit('early apply baseline');
    await core.updateRef('refs/heads/main', initial, null, true);
    await core.writeState({ ...(await core.readState()), local_main: initial, local_head: initial });
    await core.adapter.write('target.md', 'target bytes');
    const target = await core.createLocalCommit('early apply target');
    if (failurePoint === 'writeState') core.writeState = async () => { throw new Error('injected write failure'); };
    else core.preApplyAuthoringBase = async () => { throw new Error('injected authoring-base failure'); };
    await expect(core.applyTargetMain(target, ['target.md'], true)).rejects.toThrow(`injected ${failurePoint === 'writeState' ? 'write' : 'authoring-base'} failure`);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, '.obts', 'apply.lock')).catch(() => null)).toBeNull();
  });
});
