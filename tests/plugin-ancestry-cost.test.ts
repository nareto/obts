import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const signature = {
  name: 'obts test',
  email: 'obts-test@example.invalid',
  timestamp: 1_700_000_000,
  timezoneOffset: 0
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'obts-ancestry-cost-'));
  roots.push(dir);
  const plugin = new ObtsPluginClient(dir, { serverUrl: 'http://127.0.0.1:1', deviceName: 'ancestry' });
  await plugin.initialize();
  const core = (plugin as unknown as { client: Record<string, any> }).client;
  const tree = await core.writeTreeFromEntries(new Map());
  const writeCommit = async (parents: string[], message: string) =>
    await git.writeCommit({ fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir,
      commit: { tree, parent: parents, author: signature, committer: signature, message } });
  return { dir, core, writeCommit };
}

// Counts the commits isomorphic-git actually reads through the shared object
// cache. Only successful walks are memoized, so the counter is the cost of the
// query itself.
function countCommitReads(core: Record<string, any>): { reads: number } {
  const counter = { reads: 0 };
  const run = core.gitObjectCache.run.bind(core.gitObjectCache);
  core.gitObjectCache.run = async (command: (...args: any[]) => Promise<unknown>, args: Record<string, any>) => {
    if (command.name === 'readCommit') counter.reads += 1;
    return await run(command, args);
  };
  return counter;
}

async function longHistory(length: number) {
  const { dir, core, writeCommit } = await fixture();
  let tip = await writeCommit([], 'root\n');
  let parent = tip;
  for (let index = 1; index < length; index += 1) {
    parent = tip;
    tip = await writeCommit([tip], `commit ${index}\n`);
  }
  return { dir, core, tip, parent };
}

describe('ancestry cost on a real repository', () => {
  it('agrees with isomorphic-git on every pair of a history with a merge and a divergent branch', async () => {
    const { core, writeCommit } = await fixture();
    const root = await writeCommit([], 'root\n');
    const main = await writeCommit([root], 'main\n');
    const mainTip = await writeCommit([main], 'main tip\n');
    const branch = await writeCommit([root], 'branch\n');
    const branchTip = await writeCommit([branch], 'branch tip\n');
    const merge = await writeCommit([mainTip, branchTip], 'merge\n');
    const afterMerge = await writeCommit([merge], 'after merge\n');
    const divergent = await writeCommit([root], 'divergent\n');
    const commits = [root, main, mainTip, branch, branchTip, merge, afterMerge, divergent];

    for (const ancestor of commits) {
      for (const descendant of commits) {
        const expected = ancestor === descendant || await git.isDescendent({
          fs: core.fs, dir: core.vaultDir, gitdir: core.gitdir, oid: descendant, ancestor, depth: -1
        });
        expect(await core.isAncestor(ancestor, descendant)).toBe(expected);
      }
    }
    expect(await core.isAncestor(divergent, afterMerge)).toBe(false);
    expect(await core.isAncestor(main, merge)).toBe(true);
    expect(await core.isAncestor(branchTip, branchTip)).toBe(true);
  });

  it('decides both directions of a long history in a bounded number of commit reads', async () => {
    const length = 1500;
    const { core, tip, parent } = await longHistory(length);
    const reads = countCommitReads(core);

    expect(await core.isAncestor(tip, parent)).toBe(false);
    const forward = reads.reads;
    reads.reads = 0;
    expect(await core.isAncestor(parent, tip)).toBe(true);
    const backward = reads.reads;

    // The old walk started at the descendant only, so the forward answer cost
    // every commit below the tip: length - 2 == 1498.
    expect(forward).toBeLessThanOrEqual(8);
    expect(backward).toBeLessThanOrEqual(8);
    expect(forward + backward).toBeLessThan(length / 10);
  }, 120_000);

  it('keeps the cursor guard bounded when the write advances the cursors by one commit', async () => {
    const { dir, core, tip, parent } = await longHistory(1500);
    const state = Object.assign({}, await core.readState(), {
      vault_id: 'vault-ancestry',
      device_id: 'device-ancestry',
      local_main: parent,
      local_head: parent,
      server_device_ref: parent,
      initial_import_confirmed: true,
      status_label: 'Synced',
      last_error_code: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    });
    await writeFile(join(dir, '.obts', 'state.json'), JSON.stringify(state));
    const reads = countCommitReads(core);

    await core.writeState(Object.assign({}, state, {
      local_main: tip,
      local_head: tip,
      server_device_ref: tip,
      updated_at: '2026-01-01T00:01:00.000Z'
    }));

    const written = await core.readState();
    expect(written).toMatchObject({ local_main: tip, local_head: tip, server_device_ref: tip });
    expect(reads.reads).toBeLessThanOrEqual(16);
  }, 120_000);
});
