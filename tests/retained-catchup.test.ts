import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { retainedCatchupHarness } from './helpers/retainedCatchupHarness.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function killAtBoundary(root: string, boundary: string) {
  const child = fork('tests/fixtures/retained-catchup-child.mjs', [root, boundary], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exit = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  const message: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Catch-up ${boundary} seam timeout`)); }, 15000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
  });
  child.kill('SIGKILL');
  expect(await exit).toBe('SIGKILL');
  expect(message).toEqual({ boundary });
}
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
it.each(['after-provenance', 'after-capture', 'before-remove', 'after-remove'])('survives a process kill at the %s edit handoff seam', async boundary => {
  const root = await interrupted(false, true);
  await writeFile(join(root, 'note.md'), `user edit at ${boundary}\n`);
  await killAtBoundary(root, boundary);
  const { core, fixture } = await retainedCatchupHarness(root);
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
  expect(await core.readBlob(submitted.pending_commit, 'note.md')).toEqual(Buffer.from(`user edit at ${boundary}\n`));
  expect(await core.readBlob(submitted.pending_commit, 'extra.md')).toEqual(Buffer.from('accepted extra\n'));
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe(`user edit at ${boundary}\n`);
  expect(await readFile(join(root, 'extra.md'), 'utf8')).toBe('accepted extra\n');
});
it.each([false, true])('preserves a catch-up edit and schedules it only after the canonical parent (accepted_ref null=%s)', async acceptedRefNull => {
  await mkdir('tmp/catchup-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/catchup-tests/run-')); roots.push(root);
  const { core: setup } = await retainedCatchupHarness(root, true, false);
  setup.clearApplyState = async () => { throw new Error('suspended-before-clear'); };
  await expect(setup.pullAndApply(true)).rejects.toThrow('suspended-before-clear');
  await writeFile(join(root, 'note.md'), 'a user edit during the outage\n');
  const { core, fixture, pulls } = await retainedCatchupHarness(root);
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  if (acceptedRefNull) { catchup.accepted_ref = null; await writeFile(join(root, '.obts/catchup.json'), JSON.stringify(catchup)); }
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(pulls()).toBe(1);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('a user edit during the outage\n');
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
  expect((await core.readQueue()).pending_commit).toBe(submitted.pending_commit);
  const bundles = (await readdir(join(root, '.obts/recovery'))).filter(name => name.startsWith('rec_'));
  const retained = await Promise.all(bundles.map(bundle => readFile(join(root, '.obts/recovery', bundle, 'files/note.md'), 'utf8').catch(() => '')));
  expect(retained).toContain('a user edit during the outage\n');
});
it.each([false, true])('automatically preserves an added file before final catch-up handoff (SIGKILL=%s)', async kill => {
  const root = await interrupted(kill, true);
  await writeFile(join(root, 'extra.md'), 'a fresh user edit\n');
  const { core, fixture, pulls } = await retainedCatchupHarness(root);
  await core.recordLocalChangeHint(['extra.md']);
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(await readFile(join(root, 'extra.md'), 'utf8')).toBe('a fresh user edit\n');
  expect(pulls()).toBe(1);
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
  expect((await core.readQueue()).pending_commit).toBe(submitted.pending_commit);
});
it('preserves a deleted path with its original stale base through catch-up', async () => {
  const root = await interrupted(false, false);
  const { core, fixture } = await retainedCatchupHarness(root);
  await rm(join(root, 'note.md'));
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  await expect(readFile(join(root, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
});
it('preserves a file-to-directory edit as a structural proposal after catch-up', async () => {
  const root = await interrupted(false, false);
  const { core, fixture } = await retainedCatchupHarness(root);
  await rm(join(root, 'note.md'));
  await mkdir(join(root, 'note.md'));
  await writeFile(join(root, 'note.md', 'child.md'), 'child edit\n');
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(await readFile(join(root, 'note.md', 'child.md'), 'utf8')).toBe('child edit\n');
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
});
it('keeps the catch-up scan obligation after recovery bundle publication fails', async () => {
  const root = await interrupted(false, false);
  const { core, fixture } = await retainedCatchupHarness(root);
  await writeFile(join(root, 'note.md'), 'retryable preserved edit\n');
  const createBundle = core.createRecoveryBundle.bind(core);
  core.createRecoveryBundle = async () => { throw new Error('bundle publication failed'); };
  await expect(core.resumeDurableCatchup()).rejects.toThrow('bundle publication failed');
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('retryable preserved edit\n');
  expect(await readFile(join(root, '.obts/catchup.json'))).toBeTruthy();
  core.createRecoveryBundle = createBundle;
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('retryable preserved edit\n');
});
it('rejects a v2 catch-up journal without its capture obligation array', async () => {
  const root = await interrupted(false, false);
  const { core } = await retainedCatchupHarness(root);
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  delete catchup.capture_pending_paths;
  await writeFile(join(root, '.obts/catchup.json'), JSON.stringify(catchup));
  await expect(core.resumeDurableCatchup()).rejects.toMatchObject({ code: 'catchup_recovery_required' });
  expect(await readFile(join(root, '.obts/catchup.json'))).toBeTruthy();
});
it('blocks catch-up when a referenced recovery bundle is corrupt', async () => {
  const root = await interrupted(false, false);
  const { core } = await retainedCatchupHarness(root);
  await writeFile(join(root, 'note.md'), 'captured edit\n');
  core.pullAndApply = async () => { throw new Error('stopped after durable edit capture'); };
  await expect(core.resumeDurableCatchup()).rejects.toThrow('stopped after durable edit capture');
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  expect(catchup.recovery_bundles.length).toBeGreaterThan(0);
  await writeFile(join(root, '.obts/recovery', catchup.recovery_bundles[0].bundle_id, 'files/note.md'), 'corrupt evidence\n');
  await expect(core.resumeDurableCatchup()).rejects.toMatchObject({ code: 'catchup_recovery_required' });
  expect(await readFile(join(root, '.obts/catchup.json'))).toBeTruthy();
  await rm(join(root, '.obts/recovery', catchup.recovery_bundles[0].bundle_id), { recursive: true, force: true });
  await expect(core.resumeDurableCatchup()).rejects.toMatchObject({ code: 'catchup_recovery_required' });
  expect(await readFile(join(root, '.obts/catchup.json'))).toBeTruthy();
});
it('retains original M0 and catch-up race bytes during apply recovery staging', async () => {
  const root = await interrupted(false, true);
  await writeFile(join(root, 'extra.md'), 'visible catch-up edit\n');
  const { core, fixture } = await retainedCatchupHarness(root);
  const stage = core.stageApplyRecoveryFiles.bind(core);
  let raced = false;
  core.stageApplyRecoveryFiles = async (...args: any[]) => {
    const readFile = core.fsp.readFile.bind(core.fsp);
    core.fsp.readFile = async (filePath: any, ...readArgs: any[]) => {
      const content = await readFile(filePath, ...readArgs);
      if (!raced && String(filePath).endsWith('extra.md')) {
        raced = true;
        await writeFile(join(root, 'extra.md'), 'latest staged catch-up bytes\n');
      }
      return content;
    };
    try { return await stage(...args); }
    finally { core.fsp.readFile = readFile; }
  };
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(raced).toBe(true);
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
  expect(await core.readBlob(submitted.pending_commit, 'extra.md')).toEqual(Buffer.from('latest staged catch-up bytes\n'));
  expect(await core.readBlob(submitted.pending_commit, 'note.md')).toEqual(Buffer.from('accepted second\n'));
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retries the catch-up recovery bundle after a real local fingerprint race', async () => {
  const root = await interrupted(false, true);
  await writeFile(join(root, 'extra.md'), 'visible catch-up edit\n');
  const { core, fixture } = await retainedCatchupHarness(root);
  const readSnapshot = core.readRecoveryFileSnapshot.bind(core);
  const createBundle = core.createRecoveryBundle.bind(core);
  let raced = false;
  let observedLocalSnapshotChanged = false;
  let bundleAttempts = 0;
  let bundleReads = 0;
  core.createRecoveryBundle = async (operationType: string, ...args: any[]) => {
    if (operationType !== 'catchup_preserved') return await createBundle(operationType, ...args);
    bundleAttempts++;
    const snapshot = core.readRecoveryFileSnapshot.bind(core);
    core.readRecoveryFileSnapshot = async (filePath: string, ...snapshotArgs: any[]) => {
      if (filePath !== 'extra.md' || raced) return await readSnapshot(filePath, ...snapshotArgs);
      const readFile = core.fsp.readFile.bind(core.fsp);
      core.fsp.readFile = async (path: any, ...readArgs: any[]) => {
        bundleReads++;
        const content = await readFile(path, ...readArgs);
        if (String(path).endsWith(filePath) && !raced) {
          raced = true;
          await writeFile(join(root, 'extra.md'), 'latest bytes after the fingerprint race\n');
        }
        return content;
      };
      try { return await snapshot(filePath, ...snapshotArgs); }
      catch (error: any) {
        if (error?.filePath === 'extra.md' && error?.message === 'Local vault contents changed during a consistency checkpoint.') observedLocalSnapshotChanged = true;
        throw error;
      }
      finally { core.fsp.readFile = readFile; }
    };
    try { return await createBundle(operationType, ...args); }
    finally { core.readRecoveryFileSnapshot = snapshot; }
  };
  let submitted: any = null;
  core.uploadQueuedCommit = async (queue: any) => { submitted = queue; throw new Error('observed final stale proposal'); };
  await expect(core.syncOnce()).rejects.toThrow('observed final stale proposal');
  expect(bundleAttempts).toBeGreaterThan(0);
  expect(bundleReads).toBeGreaterThan(0);
  expect(observedLocalSnapshotChanged).toBe(true);
  expect(await readFile(join(root, 'extra.md'), 'utf8')).toBe('latest bytes after the fingerprint race\n');
  expect(await core.readBlob(submitted.pending_commit, 'extra.md')).toEqual(Buffer.from('latest bytes after the fingerprint race\n'));
  expect(await core.readBlob(submitted.pending_commit, 'note.md')).toEqual(Buffer.from('accepted second\n'));
  expect(submitted.pending_proposal_base).toBe(fixture.base);
  expect(await core.isAncestor(fixture.accepted, submitted.pending_commit)).toBe(true);
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retires a pending capture scan only after a stable tree proves the path is clean', async () => {
  const root = await interrupted(false, false);
  const { core } = await retainedCatchupHarness(root);
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  catchup.capture_pending_paths = ['note.md'];
  await writeFile(join(root, '.obts/catchup.json'), JSON.stringify(catchup));
  await core.resumeDurableCatchup();
  await expect(readFile(join(root, '.obts/catchup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('resumes a clean legacy v1 catch-up', async () => {
  const root = await interrupted(false, false);
  const { core, fixture } = await retainedCatchupHarness(root);
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  await writeFile(join(root, '.obts/catchup.json'), JSON.stringify({
    version: 1, vault_id: catchup.vault_id, device_id: catchup.device_id,
    target_main: catchup.target_main, local_head: catchup.expected_head, accepted_ref: catchup.accepted_ref
  }));
  await core.syncOnce();
  expect((await core.readState()).local_main).toBe(fixture.accepted);
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('accepted second\n');
});
it('keeps edited legacy v1 catch-up blocked without inventing provenance', async () => {
  const root = await interrupted(false, false);
  const { core } = await retainedCatchupHarness(root);
  const catchup = JSON.parse(await readFile(join(root, '.obts/catchup.json'), 'utf8'));
  await writeFile(join(root, '.obts/catchup.json'), JSON.stringify({
    version: 1, vault_id: catchup.vault_id, device_id: catchup.device_id,
    target_main: catchup.target_main, local_head: catchup.expected_head, accepted_ref: catchup.accepted_ref
  }));
  await writeFile(join(root, 'note.md'), 'unproven legacy edit\n');
  await expect(core.resumeDurableCatchup()).rejects.toMatchObject({ code: 'catchup_local_changes' });
  expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('unproven legacy edit\n');
});
it('blocks when a pending proposal overlaps retained catch-up', async () => {
  const root = await interrupted(false, false);
  const { core } = await retainedCatchupHarness(root);
  await core.writeQueue({ pending_commit: (await core.resolveRef('refs/heads/local')), pending_proposal_base: null, status: 'queued_local' });
  await expect(core.resumeDurableCatchup()).rejects.toMatchObject({ code: 'catchup_recovery_required' });
  expect(await readFile(join(root, '.obts/catchup.json'))).toBeTruthy();
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
