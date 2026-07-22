import * as fs from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import git, { type TreeEntry } from 'isomorphic-git';

import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  PathPolicyViolation
} from '../../../src/shared/pathPolicy.js';

const require = createRequire(import.meta.url);
const { createByteBudget, runBoundedWork } = require('../work-pool.cjs') as {
  createByteBudget: (maxBytes: number) => { acquire: (bytes: number) => Promise<() => void> };
  runBoundedWork: <T, R>(
    items: T[],
    options: { concurrency: number; yieldEvery?: number },
    worker: (item: T, index: number) => Promise<R>
  ) => Promise<R[]>;
};

export type LocalGitState = {
  localMain: string | null;
  localHead: string | null;
  serverDeviceRef: string | null;
};

export class LocalGitEngine {
  readonly gitdir: string;

  constructor(readonly vaultDir: string) {
    this.gitdir = join(vaultDir, '.obts', 'git');
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.vaultDir, '.obts'), { recursive: true, mode: 0o700 });
    await git.init({ fs, dir: this.vaultDir, gitdir: this.gitdir, defaultBranch: 'local' });
    await writeFile(join(this.gitdir, 'info', 'exclude'), '.obts/\n.git/\n', { mode: 0o600 });
    await git.writeRef({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'HEAD',
      value: 'refs/heads/local',
      symbolic: true,
      force: true
    });
  }

  async importPack(packfile: Buffer): Promise<void> {
    if (packfile.byteLength === 0) return;
    const packPath = join(this.gitdir, 'objects', 'pack', `obts-pull-${Date.now()}-${Math.random().toString(16).slice(2)}.pack`);
    await mkdir(dirname(packPath), { recursive: true, mode: 0o700 });
    await writeFile(packPath, packfile, { mode: 0o600 });
    await git.indexPack({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      filepath: relative(this.vaultDir, packPath).replaceAll('\\', '/')
    });
  }

  async setLocalMain(commit: string): Promise<void> {
    await git.writeRef({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'refs/heads/main',
      value: commit,
      force: true
    });
  }

  async setLocalHead(commit: string): Promise<void> {
    await git.writeRef({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'refs/heads/local',
      value: commit,
      force: true
    });
  }

  async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir: this.vaultDir, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  async commitExists(commit: string): Promise<boolean> {
    try {
      await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: commit });
      return true;
    } catch {
      return false;
    }
  }

  async sameCommitTree(first: string, second: string): Promise<boolean> {
    if (first === second) {
      return true;
    }
    try {
      const [firstCommit, secondCommit] = await Promise.all([
        git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: first }),
        git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: second })
      ]);
      return firstCommit.commit.tree === secondCommit.commit.tree;
    } catch {
      return false;
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) {
      return true;
    }
    try {
      return await git.isDescendent({
        fs,
        dir: this.vaultDir,
        gitdir: this.gitdir,
        oid: descendant,
        ancestor,
        depth: -1
      });
    } catch {
      return false;
    }
  }

  async scanSyncableFiles(): Promise<string[]> {
    const files: string[] = [];
    await walk(this.vaultDir, this.vaultDir, async (absolutePath) => {
      const rel = relative(this.vaultDir, absolutePath).replaceAll('\\', '/');
      const normalized = normalizeVaultPath(rel);
      if (!normalized.ok) {
        throw new PathPolicyViolation(normalized.code, normalized.message, { ...(normalized.details ?? {}), path: rel });
      }
      if (isSyncableVaultPath(normalized.path)) {
        files.push(normalized.path);
      }
    });
    const sorted = files.sort();
    assertSyncableTreePaths(sorted);
    return sorted;
  }

  async createLocalCommit(message: string, knownFiles?: string[]): Promise<string | null> {
    const baseCommit = await this.resolveRef('refs/heads/local');
    const baseEntries = baseCommit ? await this.flattenTree(baseCommit) : new Map<string, TreeEntry>();
    const files = knownFiles ?? await this.scanSyncableFiles();
    const fileSet = new Set(files);
    const nextEntries = new Map(baseEntries);

    for (const path of baseEntries.keys()) {
      if (!isSyncableVaultPath(path) || !fileSet.has(path)) {
        nextEntries.delete(path);
      }
    }

    const byteBudget = createByteBudget(64 * 1024 * 1024);
    const entries = await runBoundedWork(files, { concurrency: 4, yieldEvery: 25 }, async (filepath) => {
      const before = await stat(join(this.vaultDir, filepath));
      const releaseBytes = await byteBudget.acquire(before.size);
      try {
        const blob = await readFile(join(this.vaultDir, filepath));
        const after = await stat(join(this.vaultDir, filepath));
        if (!after.isFile() || before.size !== after.size || blob.byteLength !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error('Local vault contents changed during a consistency checkpoint.');
        }
        const oid = (await git.hashBlob({ object: blob })).oid;
        if (baseEntries.get(filepath)?.oid !== oid) {
          const writtenOid = await git.writeBlob({ fs, dir: this.vaultDir, gitdir: this.gitdir, blob });
          if (writtenOid !== oid) throw new Error('Git blob identity changed while persisting a local snapshot.');
        }
        return { mode: '100644', path: filepath, oid, type: 'blob' } satisfies TreeEntry;
      } finally {
        releaseBytes();
      }
    });
    for (let index = 0; index < files.length; index += 1) nextEntries.set(files[index]!, entries[index]!);

    const tree = await this.writeTreeFromEntries(nextEntries);
    if (baseCommit) {
      const { commit } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: baseCommit });
      if (commit.tree === tree) {
        return null;
      }
    } else if (nextEntries.size === 0) {
      return null;
    }

    return await this.commitTree(message, tree, baseCommit);
  }

  async createMetadataCommit(message: string): Promise<string | null> {
    const baseCommit = await this.resolveRef('refs/heads/local');
    if (!baseCommit) {
      return null;
    }
    const { commit } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: baseCommit });
    return await this.commitTree(message, commit.tree, baseCommit);
  }

  private async commitTree(message: string, tree: string, baseCommit: string | null): Promise<string> {
    return await git.commit({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'refs/heads/local',
      parent: baseCommit ? [baseCommit] : [],
      tree,
      message,
      author: {
        name: 'obts device',
        email: 'device@obts.local'
      },
      committer: {
        name: 'obts device',
        email: 'device@obts.local'
      }
    });
  }

  async planPackChunks(
    commit: string,
    excludeCommits: string[],
    targetChunkBytes: number,
    maxChunkBytes: number
  ): Promise<string[][]> {
    const oids = await this.collectIncrementalPackObjects(commit, excludeCommits);
    const groups: string[][] = [];
    let group: string[] = [];
    let groupBytes = 0;
    for (const oid of oids) {
      const result = await git.readObject({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid, format: 'content' });
      const size = Buffer.from(result.object as Uint8Array).byteLength;
      const packHeadroom = Math.min(1_048_576, Math.max(64 * 1024, Math.floor(maxChunkBytes * 0.1)));
      if (size > maxChunkBytes - packHeadroom) {
        throw new Error('A Git object is too large for bounded mobile transfer.');
      }
      if (group.length > 0 && groupBytes + size > targetChunkBytes) {
        groups.push(group);
        group = [];
        groupBytes = 0;
      }
      group.push(oid);
      groupBytes += size;
    }
    if (group.length > 0) groups.push(group);
    return groups;
  }

  async packObjectChunk(oids: string[], maxChunkBytes: number): Promise<Buffer> {
    const packfile = await this.packObjects(oids);
    if (packfile.byteLength > maxChunkBytes) throw new Error('Generated Git pack chunk exceeds the negotiated transfer limit.');
    return packfile;
  }

  async createPackForCommit(commit: string, excludeCommits: string[] = []): Promise<Buffer> {
    return await this.packObjects(await this.collectIncrementalPackObjects(commit, excludeCommits));
  }

  async createRecoveryRefsPack(): Promise<Buffer> {
    const localCommit = await this.resolveRef('refs/heads/local');
    if (!localCommit) {
      return Buffer.alloc(0);
    }
    const mainCommit = await this.resolveRef('refs/heads/main');
    if (mainCommit === localCommit) {
      return Buffer.alloc(0);
    }
    const oids = await this.collectIncrementalPackObjects(localCommit, mainCommit ? [mainCommit] : []);
    if (oids.length === 0) {
      return Buffer.alloc(0);
    }
    return await this.packObjects(oids);
  }

  private async collectIncrementalPackObjects(commit: string, excludeCommits: string[]): Promise<string[]> {
    const stopCommits = new Set(excludeCommits);
    const objects = new Set<string>();
    const visitedCommits = new Set<string>();
    const visitCommit = async (oid: string): Promise<void> => {
      if (stopCommits.has(oid) || visitedCommits.has(oid)) {
        return;
      }
      visitedCommits.add(oid);
      const { commit: parsed } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid });
      objects.add(oid);
      let baseTree: string | null = null;
      const firstParent = parsed.parent[0];
      if (firstParent && await this.commitExists(firstParent)) {
        baseTree = (await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: firstParent })).commit.tree;
      }
      await this.collectChangedTreeObjects(parsed.tree, baseTree, objects);
      for (const parent of parsed.parent) {
        await visitCommit(parent);
      }
    };
    await visitCommit(commit);
    return [...objects].sort();
  }

  private async collectChangedTreeObjects(treeOid: string, baseTreeOid: string | null, objects: Set<string>): Promise<void> {
    if (treeOid === baseTreeOid) {
      return;
    }
    objects.add(treeOid);
    const { tree } = await git.readTree({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    const baseEntries = new Map<string, TreeEntry>();
    if (baseTreeOid) {
      const { tree: baseTree } = await git.readTree({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: baseTreeOid });
      for (const entry of baseTree) {
        baseEntries.set(entry.path, entry as TreeEntry);
      }
    }
    for (const rawEntry of tree) {
      const entry = rawEntry as TreeEntry;
      const baseEntry = baseEntries.get(entry.path);
      if (baseEntry && baseEntry.type === entry.type && baseEntry.oid === entry.oid) {
        continue;
      }
      if (entry.type === 'tree') {
        await this.collectChangedTreeObjects(
          entry.oid,
          baseEntry?.type === 'tree' ? baseEntry.oid : null,
          objects
        );
      } else {
        objects.add(entry.oid);
      }
    }
  }

  private async packObjects(oids: string[]): Promise<Buffer> {
    const { packfile } = await git.packObjects({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      oids
    });
    if (!packfile) {
      throw new Error('isomorphic-git did not return a packfile.');
    }
    return Buffer.from(packfile);
  }

  async listTreeFiles(commit: string): Promise<string[]> {
    const result: string[] = [];
    await this.walkTree(commit, '', async (entryPath, entry) => {
      if (entry.type === 'blob') {
        result.push(entryPath);
      }
    });
    return result.sort();
  }

  async listTreeBlobOids(commit: string): Promise<Map<string, string>> {
    const entries = await this.flattenTree(commit);
    return new Map([...entries].map(([path, entry]) => [path, entry.oid]));
  }

  async hashBlob(content: Buffer): Promise<string> {
    return (await git.hashBlob({ object: content })).oid;
  }

  async readBlobOidRequired(oid: string): Promise<Buffer> {
    const result = await git.readObject({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      oid,
      format: 'content'
    });
    if (result.type !== 'blob') throw new Error(`Git object ${oid} is not a blob.`);
    return Buffer.from(result.object);
  }

  async readBlobRequired(commit: string, filepath: string): Promise<Buffer> {
    const result = await git.readBlob({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      oid: commit,
      filepath
    });
    return Buffer.from(result.blob);
  }

  async readBlob(commit: string, filepath: string): Promise<Buffer | null> {
    try {
      const result = await git.readBlob({
        fs,
        dir: this.vaultDir,
        gitdir: this.gitdir,
        oid: commit,
        filepath
      });
      return Buffer.from(result.blob);
    } catch {
      return null;
    }
  }

  private async flattenTree(commit: string): Promise<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    await this.walkTree(commit, '', async (entryPath, entry) => {
      if (entry.type === 'blob') {
        entries.set(entryPath, {
          mode: entry.mode,
          path: entryPath,
          oid: entry.oid,
          type: 'blob'
        });
      }
    });
    return entries;
  }

  private async writeTreeFromEntries(entries: Map<string, TreeEntry>): Promise<string> {
    const root: TreeNode = { blobs: new Map(), trees: new Map() };
    for (const [path, entry] of entries) {
      const segments = path.split('/');
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.trees.get(segment);
        if (!child) {
          child = { blobs: new Map(), trees: new Map() };
          node.trees.set(segment, child);
        }
        node = child;
      }
      const basename = segments.at(-1);
      if (!basename) {
        continue;
      }
      node.blobs.set(basename, {
        mode: entry.mode,
        path: basename,
        oid: entry.oid,
        type: 'blob'
      });
    }
    return await this.writeTreeNode(root);
  }

  private async writeTreeNode(node: TreeNode): Promise<string> {
    const tree: TreeEntry[] = [];
    for (const [name, child] of [...node.trees.entries()].sort(compareByName)) {
      tree.push({
        mode: '040000',
        path: name,
        oid: await this.writeTreeNode(child),
        type: 'tree'
      });
    }
    for (const [name, entry] of [...node.blobs.entries()].sort(compareByName)) {
      tree.push(entry);
    }
    tree.sort((left, right) => left.path.localeCompare(right.path));
    return await git.writeTree({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      tree
    });
  }

  private async walkTree(
    treeish: string,
    prefix: string,
    visit: (path: string, entry: { oid: string; mode: string; type: string }) => Promise<void>
  ): Promise<void> {
    let treeOid = treeish;
    if (prefix === '') {
      try {
        const { commit } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeish });
        treeOid = commit.tree;
      } catch {
        treeOid = treeish;
      }
    }
    const { tree } = await git.readTree({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    for (const entry of tree) {
      const entryPath = prefix ? `${prefix}/${entry.path}` : entry.path;
      await visit(entryPath, entry);
      if (entry.type === 'tree') {
        await this.walkTree(entry.oid, entryPath, visit);
      }
    }
  }
}

type TreeNode = {
  blobs: Map<string, TreeEntry>;
  trees: Map<string, TreeNode>;
};

function compareByName(left: [string, unknown], right: [string, unknown]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

async function walk(root: string, current: string, visitFile: (path: string) => Promise<void>): Promise<void> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obts') {
      continue;
    }
    const absolutePath = join(current, entry.name);
    const rel = relative(root, absolutePath).replaceAll('\\', '/');
    const normalized = normalizeVaultPath(rel);
    if (!normalized.ok) {
      throw new PathPolicyViolation(normalized.code, normalized.message, { ...(normalized.details ?? {}), path: rel });
    }
    if (entry.isDirectory()) {
      if (isSyncableVaultPath(normalized.path)) {
        await walk(root, absolutePath, visitFile);
      }
    } else if (entry.isFile()) {
      await visitFile(absolutePath);
    } else {
      throw new PathPolicyViolation(
        'unsupported_file_mode',
        'Local vault entries must be regular files or directories; symlinks and special files cannot be synced.'
      );
    }
  }
}
