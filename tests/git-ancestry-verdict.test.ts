import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerConfig, ensureServerDirectories } from '../src/server/config.js';
import { GitDurabilityError, GitService } from '../src/server/gitService.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const vaultId = 'vlt_ancestry';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-ancestry-verdict-'));
  roots.push(root);
  const config = createServerConfig({ dataDir: join(root, 'data') });
  await ensureServerDirectories(config);
  const git = new GitService(config);
  const rootCommit = await git.initializeVault(vaultId);
  const tree = await git.treeHash(vaultId, rootCommit);
  const child = await git.createMainCommitFromTree({ vaultId, tree, parentMain: rootCommit, subject: 'child', body: 'x', actor: 'test' });
  const sibling = await git.createMainCommitFromTree({ vaultId, tree, parentMain: rootCommit, subject: 'sibling', body: 'y', actor: 'test' });
  return { git, rootCommit, child, sibling };
}

describe('ancestry verdict', () => {
  it('reports a definite verdict and serves repeats from memory', async () => {
    const f = await fixture();
    const exec = vi.spyOn(f.git, 'exec');
    expect(await f.git.ancestryVerdict(vaultId, f.rootCommit, f.child)).toBe('ancestor');
    expect(await f.git.ancestryVerdict(vaultId, f.child, f.sibling)).toBe('not_ancestor');
    const calls = exec.mock.calls.length;
    expect(await f.git.ancestryVerdict(vaultId, f.rootCommit, f.child)).toBe('ancestor');
    expect(await f.git.ancestryVerdict(vaultId, f.child, f.sibling)).toBe('not_ancestor');
    expect(await f.git.ancestryVerdict(vaultId, f.child, f.child)).toBe('ancestor');
    expect(exec.mock.calls.length).toBe(calls);
  });

  it('treats an unreadable repository or unknown object as unknown and never caches that', async () => {
    const f = await fixture();
    const missing = 'f'.repeat(40);
    expect(await f.git.ancestryVerdict(vaultId, missing, f.child)).toBe('unknown');
    expect(await f.git.ancestryVerdict('vlt_missing_repo', f.rootCommit, f.child)).toBe('unknown');
    const real = f.git.exec.bind(f.git);
    const exec = vi.spyOn(f.git, 'exec').mockRejectedValueOnce(new Error('transient failure'));
    expect(await f.git.ancestryVerdict(vaultId, f.rootCommit, f.child)).toBe('unknown');
    exec.mockImplementation(real);
    expect(await f.git.ancestryVerdict(vaultId, f.rootCommit, f.child)).toBe('ancestor');
    expect(exec).toHaveBeenCalled();
  });

  it('propagates durability failures instead of reporting a verdict', async () => {
    const f = await fixture();
    vi.spyOn(f.git, 'exec').mockRejectedValueOnce(new GitDurabilityError('synthetic durability failure'));
    await expect(f.git.ancestryVerdict(vaultId, f.child, f.sibling)).rejects.toBeInstanceOf(GitDurabilityError);
  });
});
