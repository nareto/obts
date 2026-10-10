import { AssertionError } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, mobileHarness, waitUntil } from './helpers/mobileOnboardingHarness.js';
import { MobileRestartLifecycle, within } from './helpers/mobileRestartLifecycle.js';

const script = 'tests/fixtures/mobile-lifecycle-child.mjs';
const scopes: MobileRestartLifecycle[] = [];
const disposers: (() => void)[] = [];
const roots: string[] = [];
const expectedDetachedErrors = new Map<MobileRestartLifecycle, unknown[]>();
async function expectPreservedFailure(result: Promise<unknown>, errors: unknown[]) {
  let failure: unknown;
  try { await result; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(aggregate.errors).toHaveLength(errors.length);
  errors.forEach((error, index) => expect(aggregate.errors[index]).toBe(error));
  expect(aggregate.cause).toBe(errors[0]);
}
function scope() { const value = new MobileRestartLifecycle(); scopes.push(value); return value; }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function close(owner: MobileRestartLifecycle, remove = async () => {}, drainMs = 1000) {
  return owner.close({ stop() {}, finish: async () => {}, remove, drainMs });
}
async function launch(owner: MobileRestartLifecycle, mode: string, timeoutMs = 2000) {
  const result = owner.child(script, [mode], { timeoutMs });
  void result.catch(() => {});
  const child = [...owner.children.keys()][0]!;
  await within(new Promise<void>(resolve => child.stdout!.once('data', () => resolve())), 1500, 'Synthetic child ready');
  return { child, result };
}
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const owner of scopes.splice(0)) {
    const expected = expectedDetachedErrors.get(owner);
    if (expected) await expectPreservedFailure(close(owner), expected);
    else await close(owner);
    expectedDetachedErrors.delete(owner);
    expect(owner.children.size).toBe(0);
    expect(owner.work.size).toBe(0);
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('mobile restart test lifecycle', () => {
  it('detached settled failure remains a teardown failure after leaving the work map', async () => {
    const owner = scope();
    const failure = new AssertionError({ message: 'Unexpected detached assertion', actual: false, expected: true });
    const cause = failure.cause = new Error('Synthetic root cause');
    expectedDetachedErrors.set(owner, [failure]);
    const target = { async complete() { throw failure; } };
    owner.ownMethods(target, ['complete'], 'modal', { detached: true });
    void target.complete();
    await waitUntil(() => owner.work.size === 0);
    const remove = vi.fn(async () => {});
    await expectPreservedFailure(close(owner, remove), [failure]);
    expect(failure.cause).toBe(cause);
    expect(remove).not.toHaveBeenCalled();
  });

  it('detached draining failure cannot turn teardown green while closing', async () => {
    const owner = scope();
    const entered = gate();
    const release = gate();
    const failure = new AssertionError({ message: 'Unexpected assertion during drain' });
    expectedDetachedErrors.set(owner, [failure]);
    const target = { async complete() { entered.release(); await release.promise; throw failure; } };
    owner.ownMethods(target, ['complete'], 'modal', { detached: true });
    void target.complete();
    await entered.promise;
    const remove = vi.fn(async () => {});
    const closing = close(owner, remove);
    expect(owner.closing).toBe(true);
    release.release();
    await expectPreservedFailure(closing, [failure]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('detached finish-time admission failure is checked before removal', async () => {
    const owner = scope();
    const target = { complete: vi.fn(async () => {}) };
    const original = target.complete;
    owner.ownMethods(target, ['complete'], 'modal', { detached: true });
    let failure: unknown;
    const finished = gate();
    const remove = vi.fn(async () => {});
    const closing = owner.close({ stop() {}, remove, finish: async () => {
      await target.complete().catch(error => { failure = error; });
      expectedDetachedErrors.set(owner, [failure]);
      finished.release();
    } });
    await finished.promise;
    await expectPreservedFailure(closing, [failure]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('closing');
    expect(original).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('detached awaited-call control does not promote ordinary handled rejections', async () => {
    const owner = scope();
    const failure = new Error('Intentionally handled filesystem error');
    const target = { async readFile() { throw failure; } };
    owner.ownMethods(target, ['readFile'], 'filesystem');
    await expect(target.readFile()).rejects.toBe(failure);
    const remove = vi.fn(async () => {});
    await close(owner, remove);
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(['escaping', 'handled'])('detached packaged modal %s error preserves its observation policy', async mode => {
    const owner = scope();
    const root = await mkdtemp(join(process.cwd(), 'tmp/mobile-detached-modal-')); roots.push(root);
    const h = await mobileHarness(root, 'http://127.0.0.1:1'); disposers.push(() => h.dispose());
    owner.ownMethods(h.plugin, ['runExclusiveAction'], 'plugin');
    owner.ownMethods(h.core.fsp, Object.keys(h.core.fsp).filter(name => typeof h.core.fsp[name] === 'function'), 'filesystem');
    const modal = await h.open();
    owner.ownMethods(modal, ['runOnboardingCompletion'], 'modal', { detached: true });
    modal.connection = { connection_id: 'synthetic-connection', connection_secret: 'synthetic-credential' };
    modal.renderResume();
    const failure = new AssertionError({ message: 'Synthetic modal boundary assertion' });
    const entered = gate();
    const release = gate();
    h.core.finishOnboarding = vi.fn(async () => {
      entered.release();
      await release.promise;
      if (mode === 'handled') throw failure;
      return { status: 'Synced' };
    });
    if (mode === 'escaping') {
      expectedDetachedErrors.set(owner, [failure]);
      h.core.readState = vi.fn(async () => { throw failure; });
    }
    const report = h.plugin.reportOnboardingError.bind(h.plugin);
    h.plugin.reportOnboardingError = vi.fn((...args: any[]) => owner.run('handled error report', () => report(...args)));
    await click(modal, 'Resume setup');
    await entered.promise;
    release.release();
    await waitUntil(() => owner.work.size === 0);
    expect(modal.onboardingRunning).toBe(false);
    expect(h.core.finishOnboarding).toHaveBeenCalledOnce();
    if (mode === 'handled') expect(modal.contentEl.allText).toContain('Setup failed.');
    const remove = vi.fn(async () => {});
    const closing = owner.close({ stop: () => h.dispose(), finish: async () => {}, remove });
    if (mode === 'escaping') {
      await expectPreservedFailure(closing, [failure]);
      expect(h.core.readState).toHaveBeenCalled();
      expect(h.plugin.reportOnboardingError).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } else {
      await closing;
      expect(h.plugin.reportOnboardingError).toHaveBeenCalledWith(failure, modal.connection);
      expect(remove).toHaveBeenCalledOnce();
    }
  });

  it('does not reject an active-child deadline until process close', async () => {
    const owner = scope();
    const { child, result } = await launch(owner, 'hold', 500);
    let closed = false;
    child.once('close', () => { closed = true; });
    await expect(result).rejects.toThrow('boundary/exit timeout');
    expect(closed).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    expect(owner.children.size).toBe(0);
  });

  it('cancels only registered children and awaits close before removal', async () => {
    const owner = scope();
    const { child, result } = await launch(owner, 'hold');
    let closed = false;
    child.once('close', () => { closed = true; });
    const remove = vi.fn(async () => { expect(closed).toBe(true); });
    await close(owner, remove);
    await expect(result).rejects.toThrow('cancelled');
    expect(remove).toHaveBeenCalledOnce();
    expect(child.signalCode).toBe('SIGKILL');
  });

  it.each(['clean', 'signal'])('settles a pre-IPC %s exit', async mode => {
    const owner = scope();
    const { child, result } = await launch(owner, mode);
    child.send('go');
    await expect(within(result, 1000, 'Premature exit')).rejects.toThrow('closed before IPC');
    expect(owner.children.size).toBe(0);
  });

  it('settles spawn errors after close', async () => {
    const owner = scope();
    await expect(owner.child(script, [], { forkOptions: { execPath: join(process.cwd(), 'synthetic-missing-node-executable') } })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(owner.children.size).toBe(0);
  });

  it('keeps the exit deadline after IPC', async () => {
    const owner = scope();
    const { child, result } = await launch(owner, 'message-hang', 500);
    const message = new Promise(resolve => child.once('message', resolve));
    child.send('go');
    expect(await message).toEqual({ complete: true });
    expect(owner.children.size).toBe(1);
    await expect(result).rejects.toThrow('boundary/exit timeout');
    expect(child.signalCode).toBe('SIGKILL');
    expect(owner.children.size).toBe(0);
  });

  it.each(['boundary', 'success'])('retains the %s close oracle', async mode => {
    const owner = scope();
    const { child, result } = await launch(owner, mode);
    child.send('go');
    expect(await result).toMatchObject(mode === 'boundary' ? { message: { boundary: 'synthetic' }, signal: 'SIGKILL' } : { message: { complete: true }, code: 0 });
    expect(owner.children.size).toBe(0);
  });

  it('drains a parent test continuation before removing its own fixture', async () => {
    const owner = scope();
    const entered = gate();
    const release = gate();
    const root = await mkdtemp(join(process.cwd(), 'tmp/mobile-continuation-')); roots.push(root);
    const body = owner.run('test continuation', async () => {
      entered.release();
      await release.promise;
      await writeFile(join(root, 'finished'), 'owned continuation');
      await expect(owner.child(script, ['hold'])).rejects.toThrow('closing');
    });
    await entered.promise;
    const remove = vi.fn(async () => { expect(await readFile(join(root, 'finished'), 'utf8')).toBe('owned continuation'); });
    const closing = close(owner, remove);
    expect(remove).not.toHaveBeenCalled();
    release.release();
    await closing;
    await body;
    expect(remove).toHaveBeenCalledOnce();
  });

  it('drains actual active packaged-harness work, not synchronous dispose', async () => {
    const owner = scope();
    const root = await mkdtemp(join(process.cwd(), 'tmp/mobile-harness-drain-')); roots.push(root);
    const h = await mobileHarness(root, 'http://127.0.0.1:1'); disposers.push(() => h.dispose());
    owner.ownMethods(h.plugin, ['runExclusiveAction'], 'plugin');
    const entered = gate();
    const release = gate();
    const work = h.plugin.runExclusiveAction(async () => {
      entered.release();
      await release.promise;
      await h.core.fsp.writeFile('finished.md', 'owned harness');
    });
    await entered.promise;
    const remove = vi.fn(async () => { expect(await readFile(join(root, 'finished.md'), 'utf8')).toBe('owned harness'); });
    const closing = owner.close({ stop: () => h.dispose(), finish: async () => {}, remove, drainMs: 1000 });
    expect(h.plugin.operationAvailability()).toBe('busy');
    expect(remove).not.toHaveBeenCalled();
    release.release();
    await work;
    await closing;
    expect(h.plugin.operationAvailability()).toBe('available');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('rejects late parent and child admission without invoking their bodies', async () => {
    const owner = scope();
    await close(owner);
    const action = vi.fn(async () => {});
    await expect(owner.run('late work', action)).rejects.toThrow('closing');
    await expect(owner.child(script, ['hold'])).rejects.toThrow('closing');
    expect(action).not.toHaveBeenCalled();
    expect(owner.children.size).toBe(0);
  });

  it('fails and preserves the fixture on failed drain, then can prove eventual quiescence', async () => {
    const owner = scope();
    const release = gate();
    const root = await mkdtemp(join(process.cwd(), 'tmp/mobile-preserved-')); roots.push(root);
    await writeFile(join(root, 'evidence'), 'preserve me');
    const entered = gate();
    const work = owner.run('held writer', () => { entered.release(); return release.promise; });
    await entered.promise;
    const remove = vi.fn(async () => { await rm(root, { recursive: true }); });
    try {
      await expect(close(owner, remove, 20)).rejects.toThrow('Fixture preserved');
      expect(remove).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'evidence'), 'utf8')).toBe('preserve me');
      expect(owner.work.size).toBe(1);
    } finally { release.release(); await work; }
    expect(owner.work.size).toBe(0);
  });

  it('discriminates the former missing settlement/deadline and premature-cleanup controls without deleting live fixtures', async () => {
    function formerObserver() {
      const child = new EventEmitter();
      let deadline = true;
      let settled = false;
      let expire!: () => void;
      const kill = vi.fn();
      const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
      const message = new Promise<void>((resolve, reject) => {
        expire = () => { kill(); reject(new Error('Child boundary timeout')); };
        child.once('message', () => { deadline = false; resolve(); });
        child.once('exit', code => { deadline = false; if (code !== null && code !== 0) reject(new Error('Child failed')); });
      });
      const result = message.then(() => exit);
      void result.then(() => { settled = true; }, () => { settled = true; });
      return { child, result, expire, kill, get deadline() { return deadline; }, get settled() { return settled; } };
    }
    for (const mode of ['clean', 'signal', 'spawn-error', 'ipc']) {
      const old = formerObserver();
      if (mode === 'clean') old.child.emit('exit', 0, null);
      if (mode === 'signal') old.child.emit('exit', null, 'SIGTERM');
      if (mode === 'spawn-error') expect(() => old.child.emit('error', new Error('ENOENT'))).toThrow('ENOENT');
      if (mode === 'ipc') old.child.emit('message', { complete: true });
      await Promise.resolve(); await Promise.resolve();
      expect(old.settled).toBe(false);
      if (mode !== 'spawn-error') expect(old.deadline).toBe(false);
    }
    const old = formerObserver();
    let closed = false;
    old.child.once('close', () => { closed = true; });
    old.expire();
    await expect(old.result).rejects.toThrow('Child boundary timeout');
    expect(old.kill).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    const liveWork = gate();
    let finished = false;
    const body = liveWork.promise.then(() => { finished = true; });
    const oldRemove = vi.fn(() => { expect(finished).toBe(false); });
    const oldDispose = vi.fn();
    oldDispose();
    await Promise.resolve();
    oldRemove();
    expect(oldRemove).toHaveBeenCalledOnce();
    liveWork.release();
    await body;
  });
});
