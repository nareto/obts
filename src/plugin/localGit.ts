import * as fs from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import git from 'isomorphic-git';

import {
  assertSyncableTreePaths,
  isSyncableVaultPath,
  normalizeVaultPath,
  type SyncPathPolicy
} from '../shared/pathPolicy.js';

export type LocalGitState = {
  localMain: string | null;
  localHead: string | null;
  serverDeviceRef: string | null;
};

export class LocalGitEngine {
  readonly gitdir: string;

  constructor(
    readonly vaultDir: string,
    readonly policy: SyncPathPolicy
  ) {
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

  async scanSyncableFiles(): Promise<string[]> {
    const files: string[] = [];
    await walk(this.vaultDir, async (absolutePath) => {
      const rel = relative(this.vaultDir, absolutePath).replaceAll('\\', '/');
      const normalized = normalizeVaultPath(rel);
      if (normalized.ok && isSyncableVaultPath(normalized.path, this.policy)) {
        files.push(normalized.path);
      }
    });
    const sorted = files.sort();
    assertSyncableTreePaths(sorted);
    return sorted;
  }

  async createLocalCommit(message: string): Promise<string | null> {
    const files = await this.scanSyncableFiles();
    const matrix = await git.statusMatrix({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'refs/heads/local',
      filter: (filepath) => isSyncableVaultPath(filepath, this.policy),
      ignored: false
    });
    let changed = false;
    const seen = new Set(files);
    for (const [filepath, headStatus, workdirStatus, stageStatus] of matrix) {
      if (!isSyncableVaultPath(filepath, this.policy)) {
        continue;
      }
      if (headStatus !== workdirStatus || workdirStatus !== stageStatus) {
        changed = true;
      }
      if (workdirStatus === 0) {
        await git.remove({ fs, dir: this.vaultDir, gitdir: this.gitdir, filepath });
      } else {
        await git.add({ fs, dir: this.vaultDir, gitdir: this.gitdir, filepath });
      }
      seen.delete(filepath);
    }
    for (const filepath of seen) {
      changed = true;
      await git.add({ fs, dir: this.vaultDir, gitdir: this.gitdir, filepath });
    }
    if (!changed) {
      return null;
    }
    return await git.commit({
      fs,
      dir: this.vaultDir,
      gitdir: this.gitdir,
      ref: 'refs/heads/local',
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

  async createPackForCommit(commit: string): Promise<Buffer> {
    const oids = await this.collectReachableObjects(commit);
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

  private async walkTree(
    treeish: string,
    prefix: string,
    visit: (path: string, entry: { oid: string; type: string }) => Promise<void>
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

async function walk(root: string, visitFile: (path: string) => Promise<void>): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.obts' || entry.name === '.git') {
      continue;
    }
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, visitFile);
    } else if (entry.isFile()) {
      await visitFile(absolutePath);
    }
  }
}
