import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createServerConfig, ensureServerDirectories } from '../src/server/config.js';
import { GitService } from '../src/server/gitService.js';
import { MAX_ROOT_IGNORE_BYTES } from '../src/shared/rootIgnore.cjs';

const roots: string[] = [];
const vaultId = 'vlt_root_ignore_test';
const identity = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid'
};

async function fixture(): Promise<{ git: GitService; repo: string; base: string; transfer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-git-root-ignore-'));
  roots.push(root);
  const config = createServerConfig({ dataDir: join(root, 'data') });
  await ensureServerDirectories(config);
  const git = new GitService(config);
  const base = await git.initializeVault(vaultId);
  const transfer = join(config.transferDir, 'proposal', 'repo.git');
  await git.initializeTransferRepo(vaultId, transfer);
  return { git, repo: git.repoPath(vaultId), base, transfer };
}

async function commitFiles(git: GitService, repo: string, base: string, files: Record<string, Buffer | string>, alternateObjectStore?: string): Promise<{
  commit: string;
  oids: Record<string, string>;
}> {
  const oids: Record<string, string> = {};
  const tree: { [name: string]: string | object } = {};
  for (const [path, contents] of Object.entries(files)) {
    const oid = (await git.exec(repo, ['hash-object', '-w', '--stdin'], Buffer.from(contents), undefined, { allowedAlternateObjectStore: alternateObjectStore })).stdout.toString().trim();
    oids[path] = oid;
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as typeof tree;
    }
    node[parts.at(-1)!] = oid;
  }
  const writeTree = async (node: typeof tree): Promise<string> => {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(node)) {
      const directory = typeof value !== 'string';
      const oid = directory ? await writeTree(value as typeof tree) : value;
      lines.push(`${directory ? '040000 tree' : '100644 blob'} ${oid}\t${name}\n`);
    }
    return (await git.exec(repo, ['mktree'], Buffer.from(lines.join('')), undefined, { allowedAlternateObjectStore: alternateObjectStore })).stdout.toString().trim();
  };
  const treeOid = await writeTree(tree);
  const commit = (await git.exec(repo, ['commit-tree', treeOid, '-p', base, '-m', 'proposed tree'], undefined, identity, { allowedAlternateObjectStore: alternateObjectStore })).stdout.toString().trim();
  return { commit, oids };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('opt-in server root ignore tree validation', () => {
  it('attests absent and empty root policy, and leaves legacy path validation unchanged', async () => {
    const { git, repo, base } = await fixture();
    const noPolicy = await commitFiles(git, repo, base, { 'notes/a.md': 'tracked' });
    expect(await git.readRootIgnoreBlob(vaultId, noPolicy.commit)).toEqual({ oid: null, bytes: null });
    expect(await git.validateTreeRootIgnorePolicy(vaultId, noPolicy.commit)).toBeNull();
    const empty = await commitFiles(git, repo, base, { '.gitignore': '', 'notes/a.md': 'tracked' });
    expect(await git.readRootIgnoreBlob(vaultId, empty.commit)).toEqual({ oid: empty.oids['.gitignore'], bytes: Buffer.alloc(0) });
    expect(await git.validateTreeRootIgnorePolicy(vaultId, empty.commit)).toBe(empty.oids['.gitignore']);
    const ignored = await commitFiles(git, repo, base, { '.gitignore': '*.md\n.gitignore\n', 'notes/a.md': 'tracked' });
    await git.validateTreePathPolicy(vaultId, ignored.commit);
    await expect(git.validateTreeRootIgnorePolicy(vaultId, ignored.commit)).rejects.toMatchObject({
      code: 'excluded_root_ignore_path',
      details: { path: 'notes/a.md', root_ignore_oid: ignored.oids['.gitignore'] }
    });
    expect(await git.readRootIgnoreBlob(vaultId, ignored.commit)).toEqual({
      oid: ignored.oids['.gitignore'], bytes: Buffer.from('*.md\n.gitignore\n')
    });
    const durableReader = git.readerForRepo(repo);
    expect(await durableReader.readRootIgnoreBlob(vaultId, ignored.commit)).toMatchObject({ oid: ignored.oids['.gitignore'] });
    await expect(durableReader.validateTreeRootIgnorePolicy(vaultId, ignored.commit)).rejects.toMatchObject({
      code: 'excluded_root_ignore_path', details: { path: 'notes/a.md' }
    });
    expect(await git.commitExists(vaultId, ignored.commit)).toBe(true);
    expect(await git.listTreePaths(vaultId, ignored.commit)).toContain('notes/a.md');
    const nestedOnly = await commitFiles(git, repo, base, { 'nested/.gitignore': '*.md\n', 'nested/note.md': 'tracked' });
    expect(await git.validateTreeRootIgnorePolicy(vaultId, nestedOnly.commit)).toBeNull();
  });

  it('checks the complete candidate tree, including unchanged tracked paths, with hard exclusions first', async () => {
    const { git, repo, base } = await fixture();
    const existing = await commitFiles(git, repo, base, { 'nested/note.md': 'old' });
    const proposed = await commitFiles(git, repo, existing.commit, { '.gitignore': '*.md\n', 'nested/note.md': 'old' });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, proposed.commit)).rejects.toMatchObject({
      code: 'excluded_root_ignore_path', details: { path: 'nested/note.md' }
    });
    const hard = await commitFiles(git, repo, base, { '.gitignore': Buffer.from([0xff]), '.obts/state': 'secret' });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, hard.commit)).rejects.toMatchObject({ code: 'excluded_internal_path' });
    const visibleGit = await commitFiles(git, repo, base, { '.git/config': 'content', '.gitignore': '*.md\n' });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, visibleGit.commit)).rejects.toMatchObject({ code: 'excluded_git_path' });
  });

  it('fails closed for invalid UTF-8 and oversized root policy without deleting proposal objects', async () => {
    const { git, repo, base } = await fixture();
    const invalid = await commitFiles(git, repo, base, { '.gitignore': Buffer.from([0xff]), 'notes.md': 'tracked' });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, invalid.commit)).rejects.toMatchObject({ code: 'invalid_policy_encoding' });
    const atLimit = await commitFiles(git, repo, base, { '.gitignore': Buffer.alloc(MAX_ROOT_IGNORE_BYTES, 35) });
    expect((await git.readRootIgnoreBlob(vaultId, atLimit.commit)).bytes).toHaveLength(MAX_ROOT_IGNORE_BYTES);
    expect(await git.validateTreeRootIgnorePolicy(vaultId, atLimit.commit)).toBe(atLimit.oids['.gitignore']);
    const withNul = await commitFiles(git, repo, base, { '.gitignore': Buffer.from('notes.md\0') });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, withNul.commit)).rejects.toMatchObject({ code: 'invalid_policy_nul' });
    const oversized = await commitFiles(git, repo, base, { '.gitignore': Buffer.alloc(MAX_ROOT_IGNORE_BYTES + 1, 97) });
    await expect(git.readRootIgnoreBlob(vaultId, oversized.commit)).rejects.toMatchObject({ code: 'policy_too_large' });
    await expect(git.validateTreeRootIgnorePolicy(vaultId, oversized.commit)).rejects.toMatchObject({ code: 'policy_too_large' });
    for (const proposal of [invalid, oversized, withNul]) {
      expect(await git.commitExists(vaultId, proposal.commit)).toBe(true);
      expect((await git.exec(repo, ['cat-file', '-e', `${proposal.oids['.gitignore']}^{blob}`])).stdout).toBe('');
    }
  });

  it('reads and validates a quarantine-only root blob without promoting or deleting it on rejection', async () => {
    const { git, repo, base, transfer } = await fixture();
    const proposal = await commitFiles(git, transfer, base, { '.gitignore': 'notes/\n', 'notes/a.md': 'tracked' }, join(repo, 'objects'));
    const pack = await git.exec(transfer, ['pack-objects', '--stdout', '--revs'], Buffer.from(`${proposal.commit}\n^${base}\n`), undefined, {
      encoding: 'buffer', allowedAlternateObjectStore: join(repo, 'objects')
    });
    expect(await git.commitExists(vaultId, proposal.commit)).toBe(false);
    await git.withQuarantinedPack(vaultId, pack.stdout as Buffer, async (reader) => {
      expect(await reader.commitExists(vaultId, proposal.commit)).toBe(true);
      expect(await reader.readRootIgnoreBlob(vaultId, proposal.commit)).toEqual({
        oid: proposal.oids['.gitignore'], bytes: Buffer.from('notes/\n')
      });
      await reader.validateTreePathPolicy(vaultId, proposal.commit);
      await expect(reader.validateTreeRootIgnorePolicy(vaultId, proposal.commit)).rejects.toMatchObject({
        code: 'excluded_root_ignore_path', details: { path: 'notes/a.md', root_ignore_oid: proposal.oids['.gitignore'] }
      });
      expect(await reader.commitExists(vaultId, proposal.commit)).toBe(true);
      expect(await reader.readRootIgnoreBlob(vaultId, proposal.commit)).toMatchObject({ oid: proposal.oids['.gitignore'] });
    });
    expect(await git.commitExists(vaultId, proposal.commit)).toBe(false);
    expect((await git.exec(transfer, ['cat-file', 'blob', proposal.oids['.gitignore']!], undefined, undefined, { allowedAlternateObjectStore: join(repo, 'objects') })).stdout).toBe('notes/\n');
    expect((await git.exec(repo, ['cat-file', '-e', proposal.commit]).catch(() => null))).toBeNull();
  });
});
