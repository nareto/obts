import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { assertSyncableTreePaths, PathPolicyViolation } from '../shared/pathPolicy.js';
import type { ServerConfig } from './config.js';

const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitDiffEntry = {
  status: string;
  path: string;
  oldPath?: string;
};

type GitTreeEntry = {
  mode: string;
  type: string;
  path: string;
};

export class GitCommandError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export class GitService {
  constructor(private readonly config: ServerConfig) {}

  repoPath(vaultId: string): string {
    return join(this.config.gitStoreDir, `${vaultId}.git`);
  }

  async checkReady(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      const { stdout } = await this.execRaw(['--version']);
      return { ok: true, version: asText(stdout).trim() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'git unavailable' };
    }
  }

  async initializeVault(vaultId: string): Promise<string> {
    const repo = this.repoPath(vaultId);
    await mkdir(this.config.gitStoreDir, { recursive: true, mode: 0o700 });
    await this.execRaw(['init', '--bare', repo]);
    await this.exec(repo, ['config', 'core.logAllRefUpdates', 'true']);
    const tree = asText((await this.exec(repo, ['mktree'], Buffer.alloc(0))).stdout).trim();
    const rootOutput = (
      await this.exec(
        repo,
        ['commit-tree', tree, '-m', 'obts: initialize empty vault main'],
        undefined,
        serverGitEnv('obts-server')
      )
    ).stdout;
    const root = asText(rootOutput).trim();
    await this.updateRef(vaultId, 'refs/heads/main', root, null);
    return root;
  }

  async getRef(vaultId: string, ref: string): Promise<string | null> {
    const repo = this.repoPath(vaultId);
    try {
      const { stdout } = await this.exec(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
      return asText(stdout).trim();
    } catch {
      return null;
    }
  }

  async updateRef(vaultId: string, ref: string, target: string, expected: string | null): Promise<void> {
    const repo = this.repoPath(vaultId);
    const oldValue = expected ?? ZERO_OID;
    await this.exec(repo, ['update-ref', ref, target, oldValue]);
  }

  async commitExists(vaultId: string, commit: string): Promise<boolean> {
    const repo = this.repoPath(vaultId);
    try {
      await this.exec(repo, ['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async isAncestor(vaultId: string, ancestor: string, descendant: string): Promise<boolean> {
    const repo = this.repoPath(vaultId);
    try {
      await this.exec(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  async mergeBase(vaultId: string, left: string, right: string): Promise<string | null> {
    const repo = this.repoPath(vaultId);
    try {
      const { stdout } = await this.exec(repo, ['merge-base', left, right]);
      return asText(stdout).trim();
    } catch {
      return null;
    }
  }

  async importPack(vaultId: string, packfile: Buffer): Promise<void> {
    const repo = this.repoPath(vaultId);
    await this.exec(repo, ['unpack-objects', '-q'], packfile);
  }

  async exportPack(vaultId: string, target: string, have: string | null): Promise<Buffer> {
    const repo = this.repoPath(vaultId);
    const input = have ? `${target}\n^${have}\n` : `${target}\n`;
    const { stdout } = await this.exec(repo, ['pack-objects', '--stdout', '--revs'], Buffer.from(input), undefined, {
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async listTreePaths(vaultId: string, commit: string): Promise<string[]> {
    return (await this.listTreeEntries(vaultId, commit)).map((entry) => entry.path);
  }

  async listTreeEntries(vaultId: string, commit: string): Promise<GitTreeEntry[]> {
    const repo = this.repoPath(vaultId);
    const { stdout } = await this.exec(repo, ['ls-tree', '-r', '-z', commit], undefined, undefined, {
      encoding: 'buffer'
    });
    const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    return splitNul(data)
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const match = /^(\d{6}) (\S+) [0-9a-f]+\t(.+)$/u.exec(entry);
        if (!match?.[1] || !match[2] || !match[3]) {
          throw new GitCommandError('Malformed git tree output.', '');
        }
        return {
          mode: match[1],
          type: match[2],
          path: match[3]
        };
      });
  }

  async validateTreePathPolicy(vaultId: string, commit: string): Promise<void> {
    const entries = await this.listTreeEntries(vaultId, commit);
    assertSyncableTreePaths(entries.map((entry) => entry.path));
    for (const entry of entries) {
      if (entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') {
        throw new PathPolicyViolation(
          'unsupported_file_mode',
          'Git tree entries must be regular files; symlinks and submodules cannot be synced.'
        );
      }
    }
  }

  async changedPaths(vaultId: string, base: string, commit: string): Promise<GitDiffEntry[]> {
    const repo = this.repoPath(vaultId);
    const { stdout } = await this.exec(repo, ['diff', '--name-status', '-z', base, commit], undefined, undefined, {
      encoding: 'buffer'
    });
    const parts = splitNul(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)).filter((entry) => entry.length > 0);
    const entries: GitDiffEntry[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const status = parts[index] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = parts[index + 1];
        const path = parts[index + 2];
        if (oldPath === undefined || path === undefined) {
          throw new GitCommandError('Malformed git diff output.', '');
        }
        entries.push({ status, oldPath, path });
        index += 2;
      } else {
        const path = parts[index + 1];
        if (path === undefined) {
          throw new GitCommandError('Malformed git diff output.', '');
        }
        entries.push({ status, path });
        index += 1;
      }
    }
    return entries;
  }

  async createOverlayMergeCommit(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    mergeSequence: number
  ): Promise<string> {
    const repo = this.repoPath(vaultId);
    const tempRoot = join(this.config.tempDir, `merge-${vaultId}-${randomBytes(8).toString('hex')}`);
    const workTree = join(tempRoot, 'worktree');
    const indexFile = join(tempRoot, 'index');
    await mkdir(workTree, { recursive: true, mode: 0o700 });

    try {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      await this.exec(repo, ['read-tree', currentMain], undefined, env);
      await this.exec(repo, ['--work-tree', workTree, 'checkout-index', '-a', '-f', '--prefix', `${workTree}/`], undefined, env);

      for (const entry of deviceChanges) {
        if (entry.oldPath !== undefined && entry.oldPath !== entry.path) {
          await rm(join(workTree, entry.oldPath), { recursive: true, force: true });
        }
        if (entry.status.startsWith('D')) {
          await rm(join(workTree, entry.path), { recursive: true, force: true });
        } else {
          const content = await this.readBlobAtPath(vaultId, deviceCommit, entry.path);
          const absolutePath = join(workTree, entry.path);
          await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
          await writeFile(absolutePath, content);
        }
      }

      await this.exec(repo, ['--work-tree', workTree, 'add', '-A', '--', '.'], undefined, env);
      const tree = asText(
        await this.exec(repo, ['write-tree'], undefined, env).then((result) => result.stdout)
      ).trim();
      const commit = asText(
        await this.exec(
          repo,
          [
            'commit-tree',
            tree,
            '-p',
            currentMain,
            '-p',
            deviceCommit,
            '-m',
            `obts: merge device changes\n\nmerge_sequence=${mergeSequence}\nbase=${base}`
          ],
          undefined,
          serverGitEnv('obts-merge')
        ).then((result) => result.stdout)
      ).trim();
      await this.updateRef(vaultId, 'refs/heads/main', commit, currentMain);
      return commit;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async readBlobAtPath(vaultId: string, commit: string, path: string): Promise<Buffer> {
    const repo = this.repoPath(vaultId);
    const { stdout } = await this.exec(repo, ['show', `${commit}:${path}`], undefined, undefined, {
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async treeHash(vaultId: string, commit: string): Promise<string> {
    const repo = this.repoPath(vaultId);
    const { stdout } = await this.exec(repo, ['show', '-s', '--format=%T', commit]);
    return asText(stdout).trim();
  }

  async exec(
    repo: string,
    args: string[],
    input?: Buffer,
    extraEnv?: NodeJS.ProcessEnv,
    options: { encoding?: BufferEncoding | 'buffer'; maxBuffer?: number } = {}
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return this.execRaw(['--git-dir', repo, ...args], input, extraEnv, options);
  }

  private async execRaw(
    args: string[],
    input?: Buffer,
    extraEnv?: NodeJS.ProcessEnv,
    options: { encoding?: BufferEncoding | 'buffer'; maxBuffer?: number } = {}
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    return await new Promise((resolve, reject) => {
      const child = spawn(this.config.gitBinary, args, {
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(error);
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxBuffer) {
          fail(new GitCommandError(`git ${args.join(' ')} exceeded stdout buffer`, ''));
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= maxBuffer) {
          stderrChunks.push(chunk);
        }
      });
      child.on('error', fail);
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);
        if (code !== 0) {
          reject(new GitCommandError(`git ${args.join(' ')} failed`, stderr.toString('utf8')));
          return;
        }
        if (options.encoding === 'buffer') {
          resolve({ stdout, stderr });
        } else {
          const encoding = options.encoding ?? 'utf8';
          resolve({ stdout: stdout.toString(encoding), stderr: stderr.toString(encoding) });
        }
      });

      if (input !== undefined) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function splitNul(data: Buffer): string[] {
  return data.toString('utf8').split('\0');
}

function asText(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function serverGitEnv(actor: string): NodeJS.ProcessEnv {
  const date = new Date().toISOString();
  return {
    GIT_AUTHOR_NAME: actor,
    GIT_AUTHOR_EMAIL: `${actor}@obts.local`,
    GIT_COMMITTER_NAME: 'obts-server',
    GIT_COMMITTER_EMAIL: 'server@obts.local',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  };
}
