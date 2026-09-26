import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { retainedCatchupHarness } from './helpers/retainedCatchupHarness.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function interrupted(kill: boolean, withExtra = false) {
  await mkdir('tmp/catchup-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/catchup-tests/run-')); roots.push(root);
  if (kill) {
    const child = fork('tests/fixtures/retained-catchup-child.mjs', [root, withExtra ? 'extra' : 'single'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exit = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    const message: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Catch-up seam timeout')); }, 15000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
    });
    child.kill('SIGKILL');
    expect(await exit).toBe('SIGKILL');
    expect(message).toEqual({ boundary: 'ack-retired' });
  } else {
    const { core } = await retainedCatchupHarness(root, true, withExtra);
    const settle = core.settleAppliedQueue.bind(core);
    core.settleAppliedQueue = async () => { await settle(); throw new Error('ack-retired'); };
    await expect(core.pullAndApply(true)).rejects.toThrow('ack-retired');
  }
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('accepted first\n');
  await expect(readFile(join(root, '.obts/pull-transfer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  return root;
}
it.each([[false, false], [true, false], [false, true], [true, true]])('resumes retired checkpoint catch-up with empty events (SIGKILL=%s, intermediate tree=%s)', async (kill, withExtra) => {
  const root = await interrupted(kill!, withExtra);
  const { core, fixture, pulls } = await retainedCatchupHarness(root);
  await core.syncOnce();
  expect((await core.readState()).local_main).toBe(fixture.accepted);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('accepted second\n');
  expect(pulls()).toBe(1);
  expect(await core.isAncestor(fixture.accepted, await core.resolveRef('refs/heads/local'))).toBe(true);
  await core.syncOnce();
  expect(pulls()).toBe(1);
});
it('keeps a preserved edit out of the upload queue so retained catch-up stays reachable', async () => {
  await mkdir('tmp/catchup-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/catchup-tests/run-')); roots.push(root);
  const { core: setup } = await retainedCatchupHarness(root, true, false);
  setup.clearApplyState = async () => { throw new Error('suspended-before-clear'); };
  await expect(setup.pullAndApply(true)).rejects.toThrow('suspended-before-clear');
  expect(JSON.parse(await readFile(join(root, '.obts/apply-journal.json'), 'utf8')).phase).toBe('committed');
  // The user edits a note while the app is suspended after the committed apply.
  await writeFile(join(root, 'note.md'), 'a user edit during the outage\n');
  const { core, fixture, pulls } = await retainedCatchupHarness(root);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(core.syncOnce()).rejects.toMatchObject({ code: 'catchup_local_changes' });
  }
  expect((await core.readQueue()).pending_commit).toBeNull();
  expect(pulls()).toBe(0);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('a user edit during the outage\n');
  expect(JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8')).accepted_ref).toBe(fixture.accepted);
  expect((await core.readState()).status_label).toBe('Behind');
  const bundles = (await readdir(join(root, '.obts/recovery'))).filter(name => name.startsWith('rec_'));
  const retained = await Promise.all(bundles.map(bundle => readFile(join(root, '.obts/recovery', bundle, 'files/note.md'), 'utf8').catch(() => '')));
  expect(retained).toContain('a user edit during the outage\n');
  // Follow the documented guidance: copy the edit out, restore the post-apply bytes, resume, reapply.
  await writeFile(join(root, 'note.md'), 'accepted first\n');
  await core.syncOnce();
  expect((await core.readState()).local_main).toBe(fixture.accepted);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('accepted second\n');
  expect(pulls()).toBe(1);
  expect(await core.isAncestor(fixture.accepted, await core.resolveRef('refs/heads/local'))).toBe(true);
});
it('clears device-scoped catch-up and transfer journals when resetting pairing', async () => {
  await mkdir('tmp/catchup-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/catchup-tests/run-')); roots.push(root);
  const { core: setup } = await retainedCatchupHarness(root, true, false);
  setup.clearApplyState = async () => { throw new Error('suspended-before-clear'); };
  await expect(setup.pullAndApply(true)).rejects.toThrow('suspended-before-clear');
  await expect(readFile(join(root, '.obts/catchup.json'))).resolves.toBeTruthy();
  await expect(readFile(join(root, '.obts/pull-transfer.json'))).resolves.toBeTruthy();
  const { core } = await retainedCatchupHarness(root);
  await core.resetLocalPairingState();
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(root, '.obts/pull-transfer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await core.clearApplyState();
  const state = await core.readState();
  expect(state.vault_id).toBeNull();
  expect(state.device_id).toBeNull();
});
it.each([false, true])('blocks post-restart edits before upload on intermediate ancestry, retaining edits and actionable evidence (SIGKILL=%s)', async kill => {
  const root = await interrupted(kill, true);
  await writeFile(join(root, 'extra.md'), 'a fresh user edit\n');
  const { core, fixture, pulls } = await retainedCatchupHarness(root);
  await core.recordLocalChangeHint(['extra.md']);
  await expect(core.syncOnce()).rejects.toMatchObject({ code: 'catchup_local_changes', message: expect.stringContaining('copy') });
  expect(await readFile(join(root, 'extra.md'), 'utf8')).toBe('a fresh user edit\n');
  expect((await core.readQueue()).pending_commit).toBeNull();
  expect(pulls()).toBe(0);
  expect(JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8')).accepted_ref).toBe(fixture.accepted);
  // Follow the recovery guidance, then reapply the copied edit after catch-up.
  await writeFile(join(root, 'extra.md'), 'accepted extra\n');
  await core.syncOnce();
  expect((await core.readState()).local_main).toBe(fixture.accepted);
  await writeFile(join(root, 'extra.md'), 'a fresh user edit\n');
  core.uploadQueuedCommit = async (queue: any) => {
    expect(await core.isAncestor(fixture.accepted, queue.pending_commit)).toBe(true);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('accepted second\n');
    throw new Error('verified accepted ancestry');
  };
  await expect(core.syncOnce()).rejects.toThrow('verified accepted ancestry');
});
