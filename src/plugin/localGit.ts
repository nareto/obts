import * as fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import git, { type TreeEntry } from 'isomorphic-git';

import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  PathPolicyViolation
} from '../shared/pathPolicy.js';

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

  async createLocalCommit(message: string): Promise<string | null> {
    const baseCommit = await this.resolveRef('refs/heads/local');
    const baseEntries = baseCommit ? await this.flattenTree(baseCommit) : new Map<string, TreeEntry>();
    const files = await this.scanSyncableFiles();
    const fileSet = new Set(files);
    const nextEntries = new Map(baseEntries);

    for (const path of baseEntries.keys()) {
      if (!isSyncableVaultPath(path) || !fileSet.has(path)) {
        nextEntries.delete(path);
      }
    }

    for (const filepath of files) {
      const blob = await readFile(join(this.vaultDir, filepath));
      const oid = await git.writeBlob({
        fs,
        dir: this.vaultDir,
        gitdir: this.gitdir,
        blob
      });
      nextEntries.set(filepath, {
        mode: '100644',
        path: filepath,
        oid,
        type: 'blob'
      });
    }

    const tree = await this.writeTreeFromEntries(nextEntries);
    if (baseCommit) {
      const { commit } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: baseCommit });
      if (commit.tree === tree) {
        return null;
      }
    } else if (nextEntries.size === 0) {
      return null;
    }

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

  async createPackForCommit(commit: string, excludeCommits: string[] = []): Promise<Buffer> {
    const oids = new Set(await this.collectReachableObjects(commit));
    for (const exclude of excludeCommits) {
      if (!(await this.commitExists(exclude))) {
        continue;
      }
      for (const oid of await this.collectReachableObjects(exclude)) {
        oids.delete(oid);
      }
    }
    return await this.packObjects([...oids].sort());
  }

  async createRecoveryRefsPack(): Promise<Buffer> {
    const refs = await this.recoveryRefs();
    const oids = new Set<string>();
    for (const ref of refs) {
      const commit = await this.resolveRef(ref);
      if (!commit) {
        continue;
      }
      for (const oid of await this.collectReachableObjects(commit)) {
        oids.add(oid);
      }
    }
    if (oids.size === 0) {
      return Buffer.alloc(0);
    }
    return await this.packObjects([...oids].sort());
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

  private async recoveryRefs(): Promise<string[]> {
    const refs = new Set<string>();
    for (const ref of ['refs/heads/local', 'refs/heads/main']) {
      if (await this.resolveRef(ref)) {
        refs.add(ref);
      }
    }
    return [...refs].sort();
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

  private async collectReachableObjects(commit: string): Promise<string[]> {
    const seen = new Set<string>();
    const visitCommit = async (oid: string): Promise<void> => {
      if (seen.has(oid)) {
        return;
      }
      seen.add(oid);
      const { commit: parsed } = await git.readCommit({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid });
      await this.collectTreeObjects(parsed.tree, seen);
      for (const parent of parsed.parent) {
        await visitCommit(parent);
      }
    };
    await visitCommit(commit);
    return [...seen].sort();
  }

  private async collectTreeObjects(treeOid: string, seen: Set<string>): Promise<void> {
    if (seen.has(treeOid)) {
      return;
    }
    seen.add(treeOid);
    const { tree } = await git.readTree({ fs, dir: this.vaultDir, gitdir: this.gitdir, oid: treeOid });
    for (const entry of tree) {
      if (entry.type === 'tree') {
        await this.collectTreeObjects(entry.oid, seen);
      } else {
        seen.add(entry.oid);
      }
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
