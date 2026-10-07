import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
  let walks = 0;
  core.gitObjectCache.run = async (command: unknown, args: any) => {
    if (args.ancestor) walks += 1;
    return run(command, args);
  };
  return { core, root, tip, walks: () => walks };
}

describe('exact ancestry memo', () => {
  it('reuses exact positive and negative queries until the memo is cleared', async () => {
    const { core, root, tip, walks } = await fixture();
    for (let i = 0; i < 5; i += 1) {
      expect(await core.isAncestor(root, tip)).toBe(true);
      expect(await core.isAncestor(tip, root)).toBe(false);
    }
    expect(walks()).toBe(2);
    core.gitObjectMemo.clear();
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(await core.isAncestor(tip, root)).toBe(false);
    expect(walks()).toBe(4);
  });

  it('does not memoize a failed walk as a negative result', async () => {
    const { core, root, tip, walks } = await fixture();
    const run = core.gitObjectCache.run.bind(core.gitObjectCache);
    let fail = true;
    core.gitObjectCache.run = async (command: unknown, args: any) => {
      if (fail && args.ancestor) { fail = false; throw new Error('object not available yet'); }
      return run(command, args);
    };
    expect(await core.isAncestor(root, tip)).toBe(false);
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(await core.isAncestor(root, tip)).toBe(true);
    expect(walks()).toBe(1);
  });
});
