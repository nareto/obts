import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { installPathMutationGate } = require('../obsidian-plugin/src/path-mutation-gate.cjs');
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const calls: unknown[][] = [];
  const adapter: any = {};
  for (const method of ['write', 'writeBinary', 'append', 'appendBinary', 'process', 'mkdir', 'remove', 'rmdir', 'rename', 'copy', 'trashLocal', 'trashSystem', 'writeBinaryExclusive']) {
    adapter[method] = vi.fn(function (this: unknown, ...args: unknown[]) { calls.push([method, this, ...args]); return Promise.resolve(method); });
  }
  const gate = installPathMutationGate(adapter);
  return { adapter, gate, calls };
}

describe('same-adapter path mutation gate', () => {
  it('is FIFO for conflicting claims while independent siblings run concurrently', async () => {
    const { adapter, gate, calls } = fixture();
    const hold = barrier();
    const first = gate.withExclusive(['notes/a.md'], () => hold.promise);
    await tick();
    const second = adapter.write('notes/a.md', 'B');
    const third = adapter.append('notes/a.md', 'D');
    const sibling = adapter.write('notes/b.md', 'sibling');
    await sibling;
    expect(calls.map((call) => call[0])).toEqual(['write']);
    hold.resolve();
    await Promise.all([first, second, third]);
    expect(calls.map((call) => call.slice(2))).toEqual([['notes/b.md', 'sibling'], ['notes/a.md', 'B'], ['notes/a.md', 'D']]);
    gate.release();
  });

  it.each(['remove', 'rmdir', 'trashLocal', 'trashSystem', 'mkdir'])('%s claims descendants and normalized ancestor aliases', async (method) => {
    const { adapter, gate, calls } = fixture();
    const hold = barrier();
    const first = gate.withExclusive(['Caf\u00e9/Folder'], () => hold.promise);
    await tick();
    const next = adapter[method]('cafe\u0301\\folder\\child');
    await tick();
    expect(calls).toEqual([]);
    hold.resolve();
    await Promise.all([first, next]);
    expect(calls).toHaveLength(1);
    gate.release();
  });

  it.each(['rename', 'copy'])('%s atomically claims both endpoints, with no partial-lock deadlock', async (method) => {
    const { adapter, gate, calls } = fixture();
    const hold = barrier();
    const first = gate.withExclusive(['a'], () => hold.promise);
    await tick();
    const transfer = adapter[method]('a/child', 'b/child');
    const reverse = gate.withExclusive(['b', 'a'], () => { calls.push(['reverse']); });
    const blocked = adapter.write('b/child', 'B');
    await tick();
    expect(calls).toEqual([]);
    hold.resolve();
    await Promise.all([first, transfer, reverse, blocked]);
    expect(calls.map((call) => call[0])).toEqual([method, 'reverse', 'write']);
    gate.release();
  });

  it('releases rejected operations and preserves the rejection object', async () => {
    const error = new Error('storage failed');
    const adapter = { write: vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok') };
    const gate = installPathMutationGate(adapter);
    await expect(adapter.write('a')).rejects.toBe(error);
    await expect(adapter.write('a')).resolves.toBe('ok');
    await expect(gate.withExclusive(['a'], () => { throw error; })).rejects.toBe(error);
    await expect(adapter.write('a')).resolves.toBe('ok');
    gate.release();
  });

  it('bypasses only normalized .obts paths and gates the visible endpoint of mixed transfers', async () => {
    const { adapter, gate, calls } = fixture();
    const hold = barrier();
    const root = gate.withExclusive([''], () => hold.promise);
    await tick();
    await adapter.write('\\.obts\\journal', 'internal');
    await adapter.rename('.obts/a', './.obts/b');
    const visible = ['.gitignore', '.obsidian/config', '.obts-like/file', '.OBTS/file'].map((path) => adapter.write(path, 'visible'));
    const mixed = adapter.copy('.obts/evidence', 'note.md');
    await tick();
    expect(calls.map((call) => call[0])).toEqual(['write', 'rename']);
    hold.resolve();
    await Promise.all([root, mixed, ...visible]);
    expect(calls).toHaveLength(7);
    gate.release();
  });

  it('shares raw captures and claims across module reloads and refcounted owners', async () => {
    const adapter = { write: vi.fn().mockResolvedValue('raw') };
    const original = adapter.write;
    const owner = {};
    const first = installPathMutationGate(adapter, owner);
    const wrapper = adapter.write;
    delete require.cache[require.resolve('../obsidian-plugin/src/path-mutation-gate.cjs')];
    const second = require('../obsidian-plugin/src/path-mutation-gate.cjs').installPathMutationGate(adapter, owner);
    expect(adapter.write).toBe(wrapper);
    expect(first.raw).toBe(second.raw);
    const hold = barrier();
    const apply = first.withExclusive(['a'], () => hold.promise);
    await tick();
    first.release();
    const writer = adapter.write('a');
    await tick();
    expect(original).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([apply, writer]);
    expect(adapter.write).toBe(wrapper);
    second.release();
    expect(adapter.write).toBe(original);
  });

  it('restores original descriptors/prototype lookup only after admitted work drains', async () => {
    const inherited = vi.fn().mockResolvedValue('done');
    const adapter = Object.create({ write: inherited });
    const descriptor = { value: vi.fn().mockResolvedValue('removed'), configurable: true, writable: true, enumerable: false };
    Object.defineProperty(adapter, 'remove', descriptor);
    const gate = installPathMutationGate(adapter);
    const hold = barrier();
    const operation = gate.withExclusive(['a'], () => hold.promise);
    await tick();
    const queued = adapter.write('a');
    gate.release();
    expect(Object.hasOwn(adapter, 'write')).toBe(true);
    hold.resolve();
    await Promise.all([operation, queued]);
    expect(Object.hasOwn(adapter, 'write')).toBe(false);
    expect(Object.getOwnPropertyDescriptor(adapter, 'remove')).toEqual(descriptor);
  });

  it('does not overwrite someone else on top, and orphaned wrappers become pass-through', async () => {
    const { adapter, gate } = fixture();
    const orphan = adapter.write;
    const top = vi.fn((...args) => orphan.apply(adapter, args));
    adapter.write = top;
    gate.release();
    expect(adapter.write).toBe(top);
    const next = installPathMutationGate(adapter);
    const hold = barrier();
    const operation = next.withExclusive(['a'], () => hold.promise);
    await tick();
    // The orphan is not a live gate; the new installation never captures it as raw.
    await expect(orphan.call(adapter, 'a', 'B')).resolves.toBe('write');
    hold.resolve();
    await operation;
    await expect(next.withExclusive(['a'], (raw: any) => raw.write('a', 'C'))).resolves.toBe('write');
    next.release();
    expect(adapter.write).toBe(top);
  });

  it('drains pre-install adapter work, including a rejected queue tail', async () => {
    const admitted = barrier();
    const adapter = { promise: admitted.promise, write: vi.fn().mockResolvedValue('done') };
    const original = adapter.write;
    const gate = installPathMutationGate(adapter);
    const writer = adapter.write('a');
    await tick();
    expect(original).not.toHaveBeenCalled();
    admitted.resolve();
    await writer;
    gate.release();
    const rejected = { promise: Promise.reject(new Error('prior queue failure')), write: vi.fn().mockResolvedValue('done') };
    const other = installPathMutationGate(rejected);
    await expect(rejected.write('a')).resolves.toBe('done');
    other.release();
  });

  it.each(['write', 'writeBinary', 'append', 'appendBinary', 'process', 'mkdir', 'remove', 'rmdir', 'rename', 'copy', 'trashLocal', 'trashSystem', 'writeBinaryExclusive'])('%s forwards argument identity, receiver, results and rejection unchanged', async (method) => {
    const receiver = {};
    const data = {};
    const options = { immediate: vi.fn() };
    const result = {};
    const error = new Error('same rejection');
    const args = method === 'rename' || method === 'copy' ? ['source', 'destination', options] : ['path', data, options];
    let fail = false;
    const original = vi.fn(function (this: unknown, ...received: unknown[]) {
      expect(this).toBe(receiver);
      received.forEach((argument, index) => expect(argument).toBe(args[index]));
      options.immediate();
      if (fail) return Promise.reject(error);
      return Promise.resolve(result);
    });
    const adapter: any = { [method]: original };
    const gate = installPathMutationGate(adapter);
    await expect(adapter[method].apply(receiver, args)).resolves.toBe(result);
    expect(options.immediate).toHaveBeenCalledOnce();
    fail = true;
    await expect(adapter[method].apply(receiver, args)).rejects.toBe(error);
    gate.release();
  });

  it('preserves receiver, every argument, return values, process callback, and immediate options', async () => {
    const receiver = {};
    const callback = vi.fn();
    const options = { immediate: callback, ctime: 1, mtime: 2 };
    const result = {};
    const fn = vi.fn((text: string) => text.toUpperCase());
    const original = vi.fn(function (this: unknown, ...args: any[]) {
      expect(this).toBe(receiver);
      expect(args).toEqual(['a', fn, options]);
      expect(args[1]).toBe(fn);
      expect(args[2]).toBe(options);
      options.immediate();
      return Promise.resolve(result);
    });
    const adapter = { process: original };
    const gate = installPathMutationGate(adapter);
    const promise = adapter.process.call(receiver, 'a', fn, options);
    expect(original).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe(result);
    expect(callback).toHaveBeenCalledOnce();
    gate.release();
  });

  it('holds process until the whole transaction settles and raw apply cannot deadlock itself', async () => {
    const hold = barrier();
    const adapter = { process: vi.fn((_path: string, _fn: () => string) => hold.promise), write: vi.fn().mockResolvedValue('raw') };
    const gate = installPathMutationGate(adapter);
    const process = adapter.process('a', () => 'new');
    await tick();
    const writer = adapter.write('a');
    await tick();
    expect(adapter.write).not.toBe(gate.raw.write);
    expect((adapter.write as any)[Symbol.for('obts.pathMutationGate.wrapper')].original).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([process, writer]);
    await expect(gate.withExclusive(['a'], (raw: any) => raw.write('a', 'target'))).resolves.toBe('raw');
    gate.release();
  });
});
