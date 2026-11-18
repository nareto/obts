import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'obts-ancestry-memo-'));
  roots.push(dir);
  const plugin = new ObtsPluginClient(dir, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ancestry' });
  await plugin.initialize();
  const core = (plugin as unknown as { client: any }).client;
  const tree = await core.writeTreeFromEntries(new Map());
  const root = await core.commitTree(tree, null, 'root');
  let tip = root;
  for (let i = 0; i < 12; i += 1) tip = await core.commitTree(tree, tip, `child ${i}`);
  const run = core.gitObjectCache.run.bind(core.gitObjectCache);
  let reads = 0;
  core.gitObjectCache.run = async (command: (...args: any[]) => Promise<unknown>, args: Record<string, any>) => {
    if (command.name === 'readCommit') reads += 1;
    return await run(command, args);
  };
  return { core, root, tip, reads: () => reads };
}

describe('exact ancestry memo', () => {
  // Each walk reads the commits it visits through the shared object cache; the
  // memo turns a repeated question into no reads at all.
  it('reuses exact positive and negative queries until the memo is cleared', async () => {
    const { core, root, tip, reads } = await fixture();
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(await core.isAncestor(tip, root)).toBe(false);
    const first = reads();
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) {
      expect(await core.isAncestor(root, tip)).toBe(true);
      expect(await core.isAncestor(tip, root)).toBe(false);
    }
    expect(reads()).toBe(first);
    core.gitObjectMemo.clear();
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(await core.isAncestor(tip, root)).toBe(false);
    expect(reads()).toBeGreaterThan(first);
  });

  it('does not memoize a failed walk as a negative result', async () => {
    const { core, root, tip, reads } = await fixture();
    const run = core.gitObjectCache.run.bind(core.gitObjectCache);
    let fail = true;
    core.gitObjectCache.run = async (command: (...args: any[]) => Promise<unknown>, args: Record<string, any>) => {
      if (fail && command.name === 'readCommit') { fail = false; throw new Error('object not available yet'); }
      return await run(command, args);
    };
    expect(await core.isAncestor(root, tip)).toBe(false);
    const afterFailure = reads();
    expect(await core.isAncestor(root, tip)).toBe(true);
    const afterRetry = reads();
    expect(afterRetry).toBeGreaterThan(afterFailure);
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(reads()).toBe(afterRetry);
  });
});
