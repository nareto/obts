import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { assertSyncableTreePaths, PathPolicyViolation } from '../shared/pathPolicy.js';
import type { ServerConfig } from './config.js';

const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitDiffEntry = {
  status: string;
  path: string;
  oldPath?: string;
};

export type MergeTreeResult = {
  tree: string;
  validatorResults: Record<string, unknown>;
};

type GitTreeEntry = {
  mode: string;
  type: string;
  oid: string;
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
        const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t(.+)$/u.exec(entry);
        if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
          throw new GitCommandError('Malformed git tree output.', '');
        }
        return {
          mode: match[1],
          type: match[2],
          oid: match[3],
          path: match[4]
        };
      });
  }

  async validateTreePathPolicy(vaultId: string, commit: string, maxBlobBytes = Number.POSITIVE_INFINITY): Promise<void> {
    const entries = await this.listTreeEntries(vaultId, commit);
    assertSyncableTreePaths(entries.map((entry) => entry.path));
    for (const entry of entries) {
      if (entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') {
        throw new PathPolicyViolation(
          'unsupported_file_mode',
          'Git tree entries must be regular files; symlinks and submodules cannot be synced.'
        );
      }
      const blobSize = await this.objectSize(vaultId, `${commit}:${entry.path}`);
      if (blobSize > maxBlobBytes) {
        throw new PathPolicyViolation('file_too_large', 'A file exceeds the configured upload byte limit.', {
          max_upload_bytes: maxBlobBytes
        });
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
    const commit = await this.createOverlayMergeCommitObject(vaultId, base, currentMain, deviceCommit, deviceChanges, mergeSequence);
    await this.updateRef(vaultId, 'refs/heads/main', commit, currentMain);
    return commit;
  }

  async createOverlayMergeCommitObject(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    mergeSequence: number
  ): Promise<string> {
    const repo = this.repoPath(vaultId);
    const tree = await this.createOverlayTree(vaultId, currentMain, deviceCommit, deviceChanges, new Map());
    return asText(
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
  }

  private async createOverlayTree(
    vaultId: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    contentOverrides: Map<string, Buffer>
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
          const content = contentOverrides.get(entry.path) ?? (await this.readBlobAtPath(vaultId, deviceCommit, entry.path));
          const absolutePath = join(workTree, entry.path);
          await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
          await writeFile(absolutePath, content);
        }
      }
      for (const [path, content] of contentOverrides) {
        if (deviceChanges.some((entry) => entry.path === path && !entry.status.startsWith('D'))) {
          continue;
        }
        const absolutePath = join(workTree, path);
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, content);
      }

      await this.exec(repo, ['--work-tree', workTree, 'add', '-A', '--', '.'], undefined, env);
      return asText(await this.exec(repo, ['write-tree'], undefined, env).then((result) => result.stdout)).trim();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async tryPolicyMergeTree(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    mergedTextPaths: string[]
  ): Promise<MergeTreeResult | null> {
    const repo = this.repoPath(vaultId);
    let tree: string;
    try {
      const { stdout } = await this.exec(repo, [
        'merge-tree',
        '--write-tree',
        '--no-messages',
        '--merge-base',
        base,
        currentMain,
        deviceCommit
      ]);
      tree = asText(stdout).trim();
    } catch {
      return await this.trySemanticOverlayMergeTree(vaultId, base, currentMain, deviceCommit, deviceChanges, mergedTextPaths);
    }

    if (!/^[0-9a-f]{40}$/u.test(tree)) {
      return await this.trySemanticOverlayMergeTree(vaultId, base, currentMain, deviceCommit, deviceChanges, mergedTextPaths);
    }

    let validation: { contentOverrides: Map<string, Buffer>; semanticKinds: Set<string> };
    try {
      await this.validateTreePathPolicy(vaultId, tree);
      validation = await this.validateMergedTextPaths(vaultId, {
        tree,
        base,
        currentMain,
        deviceCommit,
        paths: mergedTextPaths
      });
      if (validation.contentOverrides.size > 0) {
        tree = await this.createTreeWithFileContents(vaultId, tree, validation.contentOverrides);
        await this.validateTreePathPolicy(vaultId, tree);
      }
    } catch {
      return await this.trySemanticOverlayMergeTree(vaultId, base, currentMain, deviceCommit, deviceChanges, mergedTextPaths);
    }

    return {
      tree,
      validatorResults: {
        native_git_merge: 'clean',
        conflict_markers: 'absent',
        overlapping_path_count: mergedTextPaths.length,
        ...(validation.semanticKinds.size > 0
          ? { semantic_merge_kinds: [...validation.semanticKinds].sort() }
          : {})
      }
    };
  }

  async createMergeCommitFromTree(input: {
    vaultId: string;
    tree: string;
    base: string;
    currentMain: string;
    deviceCommit: string;
    mergeSequence: number;
    strategy: 'disjoint_overlay' | 'native_clean' | 'semantic_clean';
  }): Promise<string> {
    const commit = await this.createMergeCommitObjectFromTree(input);
    await this.updateRef(input.vaultId, 'refs/heads/main', commit, input.currentMain);
    return commit;
  }

  async createMergeCommitObjectFromTree(input: {
    vaultId: string;
    tree: string;
    base: string;
    currentMain: string;
    deviceCommit: string;
    mergeSequence: number;
    strategy: 'disjoint_overlay' | 'native_clean' | 'semantic_clean';
  }): Promise<string> {
    const repo = this.repoPath(input.vaultId);
    return asText(
      await this.exec(
        repo,
        [
          'commit-tree',
          input.tree,
          '-p',
          input.currentMain,
          '-p',
          input.deviceCommit,
          '-m',
          `obts: merge device changes\n\nmerge_sequence=${input.mergeSequence}\nbase=${input.base}\nstrategy=${input.strategy}`
        ],
        undefined,
        serverGitEnv('obts-merge')
      ).then((result) => result.stdout)
    ).trim();
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

  async objectSize(vaultId: string, oid: string): Promise<number> {
    const repo = this.repoPath(vaultId);
    const { stdout } = await this.exec(repo, ['cat-file', '-s', oid]);
    return Number.parseInt(asText(stdout).trim(), 10);
  }

  private async createTreeWithFileContents(vaultId: string, sourceTree: string, files: Map<string, Buffer>): Promise<string> {
    const repo = this.repoPath(vaultId);
    const tempRoot = join(this.config.tempDir, `semantic-merge-${vaultId}-${randomBytes(8).toString('hex')}`);
    const workTree = join(tempRoot, 'worktree');
    const indexFile = join(tempRoot, 'index');
    await mkdir(workTree, { recursive: true, mode: 0o700 });

    try {
      const env = { ...process.env, GIT_INDEX_FILE: indexFile };
      await this.exec(repo, ['read-tree', sourceTree], undefined, env);
      await this.exec(repo, ['--work-tree', workTree, 'checkout-index', '-a', '-f', '--prefix', `${workTree}/`], undefined, env);
      for (const [path, content] of files) {
        const absolutePath = join(workTree, path);
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, content);
      }
      await this.exec(repo, ['--work-tree', workTree, 'add', '-A', '--', '.'], undefined, env);
      return asText((await this.exec(repo, ['write-tree'], undefined, env)).stdout).trim();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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

  private async validateMergedTextPaths(
    vaultId: string,
    input: { tree: string; base: string; currentMain: string; deviceCommit: string; paths: string[] }
  ): Promise<{ contentOverrides: Map<string, Buffer>; semanticKinds: Set<string> }> {
    const contentOverrides = new Map<string, Buffer>();
    const semanticKinds = new Set<string>();
    for (const path of input.paths) {
      const mergedText = await this.readTextAtPathIfPresent(vaultId, input.tree, path);
      if (mergedText === null) {
        continue;
      }
      const text = mergedText;
      if (text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>')) {
        throw new GitCommandError('Merged text contains conflict markers.', '');
      }
      const baseText = await this.readTextAtPathIfPresent(vaultId, input.base, path);
      const currentText = await this.readTextAtPathIfPresent(vaultId, input.currentMain, path);
      const deviceText = await this.readTextAtPathIfPresent(vaultId, input.deviceCommit, path);
      if (path.endsWith('.md') && baseText !== null && currentText !== null && deviceText !== null) {
        assertMarkdownMergeAllowed(baseText, currentText, deviceText);
      }
      if (path.endsWith('.canvas')) {
        assertValidJsonCanvas(text);
        if (baseText !== null && currentText !== null && deviceText !== null) {
          contentOverrides.set(path, Buffer.from(semanticMergeCanvasFile(baseText, currentText, deviceText), 'utf8'));
          semanticKinds.add('json_canvas');
        }
      }
      if (path.endsWith('.base') && baseText !== null && currentText !== null && deviceText !== null) {
        contentOverrides.set(path, Buffer.from(semanticMergeBasesFile(baseText, currentText, deviceText), 'utf8'));
        semanticKinds.add('obsidian_bases');
      }
    }
    return { contentOverrides, semanticKinds };
  }

  private async readTextAtPathIfPresent(vaultId: string, treeish: string, path: string): Promise<string | null> {
    try {
      return (await this.readBlobAtPath(vaultId, treeish, path)).toString('utf8');
    } catch {
      return null;
    }
  }

  private async trySemanticOverlayMergeTree(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    deviceChanges: GitDiffEntry[],
    overlappingPaths: string[]
  ): Promise<MergeTreeResult | null> {
    const contentOverrides = new Map<string, Buffer>();
    const semanticKinds = new Set<string>();
    try {
      for (const path of overlappingPaths) {
        const baseText = await this.readTextAtPathIfPresent(vaultId, base, path);
        const currentText = await this.readTextAtPathIfPresent(vaultId, currentMain, path);
        const deviceText = await this.readTextAtPathIfPresent(vaultId, deviceCommit, path);
        if (baseText === null || currentText === null || deviceText === null) {
          return null;
        }
        if (path.endsWith('.canvas')) {
          contentOverrides.set(path, Buffer.from(semanticMergeCanvasFile(baseText, currentText, deviceText), 'utf8'));
          semanticKinds.add('json_canvas');
        } else if (path.endsWith('.base')) {
          contentOverrides.set(path, Buffer.from(semanticMergeBasesFile(baseText, currentText, deviceText), 'utf8'));
          semanticKinds.add('obsidian_bases');
        } else {
          return null;
        }
      }
      const tree = await this.createOverlayTree(vaultId, currentMain, deviceCommit, deviceChanges, contentOverrides);
      await this.validateTreePathPolicy(vaultId, tree);
      return {
        tree,
        validatorResults: {
          native_git_merge: 'conflicted',
          semantic_merge: 'clean',
          semantic_merge_kinds: [...semanticKinds].sort(),
          conflict_markers: 'absent',
          overlapping_path_count: overlappingPaths.length
        }
      };
    } catch {
      return null;
    }
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

type JsonCanvasObject = {
  nodes: Map<string, Record<string, unknown>>;
  edges: Map<string, Record<string, unknown>>;
  nodeOrder: string[];
  edgeOrder: string[];
};

function assertValidJsonCanvas(text: string): JsonCanvasObject {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GitCommandError('Merged canvas must be a JSON object.', '');
  }
  const record = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new GitCommandError('Merged canvas must contain nodes and edges arrays.', '');
  }
  const nodeIds = new Set<string>();
  const nodes = new Map<string, Record<string, unknown>>();
  const nodeOrder: string[] = [];
  for (const node of record.nodes) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new GitCommandError('Merged canvas node must be an object.', '');
    }
    const nodeRecord = node as Record<string, unknown> & { id?: unknown };
    assertValidCanvasNode(nodeRecord);
    const id = nodeRecord.id;
    if (typeof id !== 'string' || nodeIds.has(id)) {
      throw new GitCommandError('Merged canvas node IDs must be unique strings.', '');
    }
    nodeIds.add(id);
    nodes.set(id, nodeRecord);
    nodeOrder.push(id);
  }
  const edgeIds = new Set<string>();
  const edges = new Map<string, Record<string, unknown>>();
  const edgeOrder: string[] = [];
  for (const edge of record.edges) {
    if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
      throw new GitCommandError('Merged canvas edge must be an object.', '');
    }
    const edgeRecord = edge as Record<string, unknown> & {
      id?: unknown;
      fromNode?: unknown;
      fromSide?: unknown;
      toNode?: unknown;
      toSide?: unknown;
    };
    if (typeof edgeRecord.id !== 'string' || edgeIds.has(edgeRecord.id)) {
      throw new GitCommandError('Merged canvas edge IDs must be unique strings.', '');
    }
    if (
      typeof edgeRecord.fromNode !== 'string' ||
      typeof edgeRecord.fromSide !== 'string' ||
      typeof edgeRecord.toNode !== 'string' ||
      typeof edgeRecord.toSide !== 'string'
    ) {
      throw new GitCommandError('Merged canvas edges must contain required endpoint fields.', '');
    }
    if (!nodeIds.has(edgeRecord.fromNode) || !nodeIds.has(edgeRecord.toNode)) {
      throw new GitCommandError('Merged canvas edges must reference existing nodes.', '');
    }
    edgeIds.add(edgeRecord.id);
    edges.set(edgeRecord.id, edgeRecord);
    edgeOrder.push(edgeRecord.id);
  }
  return { nodes, edges, nodeOrder, edgeOrder };
}

function assertValidCanvasNode(node: Record<string, unknown>): void {
  if (typeof node.id !== 'string' || typeof node.type !== 'string') {
    throw new GitCommandError('Canvas nodes must contain string id and type fields.', '');
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    if (typeof node[field] !== 'number' || !Number.isFinite(node[field])) {
      throw new GitCommandError(`Canvas nodes must contain numeric ${field} fields.`, '');
    }
  }
}

function assertMarkdownMergeAllowed(baseText: string, currentText: string, deviceText: string): void {
  const base = parseFrontmatter(baseText);
  const current = parseFrontmatter(currentText);
  const device = parseFrontmatter(deviceText);
  if (!base.ok || !current.ok || !device.ok) {
    throw new GitCommandError('Markdown frontmatter could not be validated for semantic merge.', '');
  }
  const currentChanged = changedFrontmatterKeys(base.keys, current.keys);
  const deviceChanged = changedFrontmatterKeys(base.keys, device.keys);
  for (const key of currentChanged) {
    if (deviceChanged.has(key) && current.keys.get(key) !== device.keys.get(key)) {
      throw new GitCommandError('Markdown frontmatter same-key edits require review.', '');
    }
  }
}

function parseFrontmatter(text: string): { ok: true; keys: Map<string, string> } | { ok: false } {
  const normalized = text.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    return { ok: true, keys: new Map() };
  }
  const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  if (end < 0) {
    return { ok: false };
  }
  const keys = new Map<string, string>();
  let currentKey: string | null = null;
  let currentValueLines: string[] = [];
  const finishKey = (): boolean => {
    if (currentKey === null) {
      return true;
    }
    if (keys.has(currentKey)) {
      return false;
    }
    keys.set(currentKey, currentValueLines.join('\n'));
    currentKey = null;
    currentValueLines = [];
    return true;
  };
  for (const line of lines.slice(1, end)) {
    const topLevel = /^([A-Za-z0-9_-]+):(.*)$/u.exec(line);
    if (topLevel?.[1] !== undefined && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (!finishKey()) {
        return { ok: false };
      }
      currentKey = topLevel[1];
      currentValueLines = [topLevel[2] ?? ''];
      continue;
    }
    if (currentKey === null) {
      if (line.trim() === '' || line.trimStart().startsWith('#')) {
        continue;
      }
      return { ok: false };
    }
    currentValueLines.push(line);
  }
  if (!finishKey()) {
    return { ok: false };
  }
  return { ok: true, keys };
}

function changedFrontmatterKeys(base: Map<string, string>, side: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const key of new Set([...base.keys(), ...side.keys()])) {
    if ((base.get(key) ?? null) !== (side.get(key) ?? null)) {
      changed.add(key);
    }
  }
  return changed;
}

function assertCanvasMergeAllowed(
  base: JsonCanvasObject,
  current: JsonCanvasObject,
  device: JsonCanvasObject,
  merged: JsonCanvasObject
): void {
  assertCanvasCollectionMergeAllowed(base.nodes, current.nodes, device.nodes, 'node');
  assertCanvasCollectionMergeAllowed(base.edges, current.edges, device.edges, 'edge');
  assertCanvasOrderMergeAllowed(base.nodeOrder, current.nodeOrder, device.nodeOrder, merged.nodeOrder, 'node');
  assertCanvasOrderMergeAllowed(base.edgeOrder, current.edgeOrder, device.edgeOrder, merged.edgeOrder, 'edge');
}

function assertCanvasCollectionMergeAllowed(
  base: Map<string, Record<string, unknown>>,
  current: Map<string, Record<string, unknown>>,
  device: Map<string, Record<string, unknown>>,
  label: string
): void {
  for (const id of new Set([...base.keys(), ...current.keys(), ...device.keys()])) {
    const baseValue = base.get(id);
    const currentValue = current.get(id);
    const deviceValue = device.get(id);
    if (baseValue && currentValue === undefined && deviceValue && objectChanged(baseValue, deviceValue)) {
      throw new GitCommandError(`Canvas ${label} delete-vs-edit requires review.`, '');
    }
    if (baseValue && deviceValue === undefined && currentValue && objectChanged(baseValue, currentValue)) {
      throw new GitCommandError(`Canvas ${label} edit-vs-delete requires review.`, '');
    }
    if (!currentValue || !deviceValue) {
      continue;
    }
    const currentChanged = changedObjectKeys(baseValue, currentValue);
    const deviceChanged = changedObjectKeys(baseValue, deviceValue);
    for (const key of currentChanged) {
      if (deviceChanged.has(key) && stableJson(currentValue[key]) !== stableJson(deviceValue[key])) {
        throw new GitCommandError(`Canvas ${label} same-field edits require review.`, '');
      }
    }
  }
}

function assertCanvasOrderMergeAllowed(
  baseOrder: string[],
  currentOrder: string[],
  deviceOrder: string[],
  mergedOrder: string[],
  label: string
): void {
  const baseIds = new Set(baseOrder);
  const baseExistingOrder = orderOf(baseOrder, baseIds);
  const currentExistingOrder = orderOf(currentOrder, baseIds);
  const deviceExistingOrder = orderOf(deviceOrder, baseIds);
  const mergedExistingOrder = orderOf(mergedOrder, baseIds);
  if (
    currentExistingOrder !== baseExistingOrder &&
    deviceExistingOrder !== baseExistingOrder &&
    currentExistingOrder !== deviceExistingOrder
  ) {
    throw new GitCommandError(`Canvas ${label} concurrent order changes require review.`, '');
  }
  if (
    mergedExistingOrder !== currentExistingOrder &&
    mergedExistingOrder !== deviceExistingOrder &&
    mergedExistingOrder !== baseExistingOrder
  ) {
    throw new GitCommandError(`Canvas ${label} order merge could not be validated.`, '');
  }
}

function semanticMergeCanvasFile(baseText: string, currentText: string, deviceText: string): string {
  const base = assertValidJsonCanvas(baseText);
  const current = assertValidJsonCanvas(currentText);
  const device = assertValidJsonCanvas(deviceText);
  const mergedNodes = mergeCanvasCollection(base.nodes, current.nodes, device.nodes, 'node');
  const mergedEdges = mergeCanvasCollection(base.edges, current.edges, device.edges, 'edge');
  const nodeOrder = mergeCanvasOrder(base.nodeOrder, current.nodeOrder, device.nodeOrder, new Set(mergedNodes.keys()), 'node');
  const edgeOrder = mergeCanvasOrder(base.edgeOrder, current.edgeOrder, device.edgeOrder, new Set(mergedEdges.keys()), 'edge');
  const root = mergeCanvasRootFields(
    JSON.parse(baseText) as Record<string, unknown>,
    JSON.parse(currentText) as Record<string, unknown>,
    JSON.parse(deviceText) as Record<string, unknown>
  );
  const result: Record<string, unknown> = {
    nodes: nodeOrder.map((id) => canonicalizeCanvasEntry(requiredCanvasEntry(mergedNodes, id), 'node')),
    edges: edgeOrder.map((id) => canonicalizeCanvasEntry(requiredCanvasEntry(mergedEdges, id), 'edge'))
  };
  for (const key of Object.keys(root).sort()) {
    if (key !== 'nodes' && key !== 'edges') {
      result[key] = canonicalizeForJson(root[key]);
    }
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  assertCanvasMergeAllowed(base, current, device, assertValidJsonCanvas(text));
  return text;
}

function mergeCanvasRootFields(
  base: Record<string, unknown>,
  current: Record<string, unknown>,
  device: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(device)])]
    .filter((key) => key !== 'nodes' && key !== 'edges')
    .sort();
  for (const key of keys) {
    const merged = mergeAtomicField(
      `Canvas top-level field ${key}`,
      fieldState(base, key),
      fieldState(current, key),
      fieldState(device, key)
    );
    if (merged.present) {
      result[key] = merged.value;
    }
  }
  return result;
}

function mergeCanvasCollection(
  base: Map<string, Record<string, unknown>>,
  current: Map<string, Record<string, unknown>>,
  device: Map<string, Record<string, unknown>>,
  label: string
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  const ids = [...new Set([...base.keys(), ...current.keys(), ...device.keys()])].sort();
  for (const id of ids) {
    const merged = mergeCanvasEntry(label, id, base.get(id), current.get(id), device.get(id));
    if (merged) {
      result.set(id, merged);
    }
  }
  return result;
}

function mergeCanvasEntry(
  label: string,
  id: string,
  base: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
  device: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!base) {
    if (current && device && stableJson(current) !== stableJson(device)) {
      throw new GitCommandError(`Canvas ${label} ${id} concurrent additions require review.`, '');
    }
    return current ?? device ?? null;
  }
  if (!current && !device) {
    return null;
  }
  if (!current) {
    if (device && objectChanged(base, device)) {
      throw new GitCommandError(`Canvas ${label} ${id} delete-vs-edit requires review.`, '');
    }
    return null;
  }
  if (!device) {
    if (objectChanged(base, current)) {
      throw new GitCommandError(`Canvas ${label} ${id} edit-vs-delete requires review.`, '');
    }
    return null;
  }
  if (stableJson(current) === stableJson(base)) {
    return device;
  }
  if (stableJson(device) === stableJson(base)) {
    return current;
  }
  if (stableJson(current) === stableJson(device)) {
    return current;
  }

  const merged: Record<string, unknown> = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(device)])].sort();
  for (const key of keys) {
    const currentChanged = stableJson(base[key]) !== stableJson(current[key]);
    const deviceChanged = stableJson(base[key]) !== stableJson(device[key]);
    if (currentChanged && deviceChanged && stableJson(current[key]) !== stableJson(device[key])) {
      throw new GitCommandError(`Canvas ${label} ${id} same-field edits require review.`, '');
    }
    if (deviceChanged) {
      merged[key] = device[key];
    } else if (currentChanged) {
      merged[key] = current[key];
    } else if (Object.prototype.hasOwnProperty.call(base, key)) {
      merged[key] = base[key];
    }
  }
  if (label === 'node') {
    assertValidCanvasNode(merged);
  }
  return merged;
}

function mergeCanvasOrder(
  baseOrder: string[],
  currentOrder: string[],
  deviceOrder: string[],
  mergedIds: Set<string>,
  label: string
): string[] {
  const survivingBaseIds = new Set(baseOrder.filter((id) => mergedIds.has(id)));
  const baseExistingOrder = orderOf(baseOrder, survivingBaseIds);
  const currentExistingOrder = orderOf(currentOrder, survivingBaseIds);
  const deviceExistingOrder = orderOf(deviceOrder, survivingBaseIds);
  if (
    currentExistingOrder !== baseExistingOrder &&
    deviceExistingOrder !== baseExistingOrder &&
    currentExistingOrder !== deviceExistingOrder
  ) {
    throw new GitCommandError(`Canvas ${label} concurrent order changes require review.`, '');
  }
  const orderedExisting =
    currentExistingOrder !== baseExistingOrder
      ? currentOrder.filter((id) => survivingBaseIds.has(id))
      : deviceExistingOrder !== baseExistingOrder
        ? deviceOrder.filter((id) => survivingBaseIds.has(id))
        : baseOrder.filter((id) => survivingBaseIds.has(id));
  const baseIds = new Set(baseOrder);
  const result = [...orderedExisting];
  integrateCanvasAdditions(result, currentOrder, baseIds, mergedIds);
  integrateCanvasAdditions(result, deviceOrder, baseIds, mergedIds);
  return result.filter((id, index) => mergedIds.has(id) && result.indexOf(id) === index);
}

function integrateCanvasAdditions(
  result: string[],
  sideOrder: string[],
  baseIds: Set<string>,
  mergedIds: Set<string>
): void {
  for (let index = 0; index < sideOrder.length; index += 1) {
    const id = sideOrder[index];
    if (id === undefined || baseIds.has(id) || !mergedIds.has(id) || result.includes(id)) {
      continue;
    }
    const before = nearestPreviousPresent(sideOrder, index, result);
    if (before) {
      result.splice(result.indexOf(before) + 1, 0, id);
      continue;
    }
    const after = nearestNextPresent(sideOrder, index, result);
    if (after) {
      result.splice(result.indexOf(after), 0, id);
      continue;
    }
    result.push(id);
  }
}

function nearestPreviousPresent(order: string[], start: number, candidates: string[]): string | null {
  for (let index = start - 1; index >= 0; index -= 1) {
    const id = order[index];
    if (id !== undefined && candidates.includes(id)) {
      return id;
    }
  }
  return null;
}

function nearestNextPresent(order: string[], start: number, candidates: string[]): string | null {
  for (let index = start + 1; index < order.length; index += 1) {
    const id = order[index];
    if (id !== undefined && candidates.includes(id)) {
      return id;
    }
  }
  return null;
}

function requiredCanvasEntry(entries: Map<string, Record<string, unknown>>, id: string): Record<string, unknown> {
  const entry = entries.get(id);
  if (!entry) {
    throw new GitCommandError('Merged Canvas order references a missing entry.', '');
  }
  return entry;
}

function canonicalizeCanvasEntry(entry: Record<string, unknown>, kind: 'node' | 'edge'): Record<string, unknown> {
  const preferred =
    kind === 'node' ? ['id', 'type', 'x', 'y', 'width', 'height'] : ['id', 'fromNode', 'fromSide', 'toNode', 'toSide'];
  const result: Record<string, unknown> = {};
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      result[key] = canonicalizeForJson(entry[key]);
    }
  }
  for (const key of Object.keys(entry).filter((candidate) => !preferred.includes(candidate)).sort()) {
    result[key] = canonicalizeForJson(entry[key]);
  }
  return result;
}

type PlainRecord = Record<string, unknown>;
type FieldState = { present: false } | { present: true; value: unknown };
type ViewCollection = {
  present: boolean;
  byKey: Map<string, PlainRecord>;
  order: string[];
};

const BASE_MAP_FIELDS = ['formulas', 'properties', 'summaries'] as const;
const BASE_TOP_LEVEL_ORDER = ['filters', 'formulas', 'properties', 'summaries', 'views'] as const;
const VIEW_KEY_SEPARATOR = '\u0000';
const RESTRICTED_CONCURRENT_VIEW_KEYS = new Set(['type', 'name', 'filters', 'order']);
const KNOWN_VIEW_KEYS = new Set([
  'type',
  'name',
  'filters',
  'order',
  'sort',
  'limit',
  'columns',
  'properties',
  'formulas',
  'summaries',
  'group',
  'groupBy',
  'image',
  'display'
]);

function semanticMergeBasesFile(baseText: string, currentText: string, deviceText: string): string {
  const base = parseBasesDocument(baseText);
  const current = parseBasesDocument(currentText);
  const device = parseBasesDocument(deviceText);
  const merged = new Map<string, FieldState>();

  merged.set(
    'filters',
    mergeAtomicField(
      'Bases filters',
      fieldState(base.root, 'filters'),
      fieldState(current.root, 'filters'),
      fieldState(device.root, 'filters')
    )
  );

  for (const field of BASE_MAP_FIELDS) {
    merged.set(field, mergeNamedMapField(field, base.root, current.root, device.root));
  }
  merged.set('views', mergeViews(base.views, current.views, device.views));

  const knownTopLevel = new Set<string>(BASE_TOP_LEVEL_ORDER);
  const otherFields = [...new Set([...Object.keys(base.root), ...Object.keys(current.root), ...Object.keys(device.root)])]
    .filter((field) => !knownTopLevel.has(field))
    .sort();
  for (const field of otherFields) {
    merged.set(
      field,
      mergeAtomicField(
        `Bases top-level field ${field}`,
        fieldState(base.root, field),
        fieldState(current.root, field),
        fieldState(device.root, field)
      )
    );
  }

  const result: PlainRecord = {};
  for (const field of [...BASE_TOP_LEVEL_ORDER, ...otherFields]) {
    const value = merged.get(field);
    if (value?.present) {
      result[field] = field === 'views' ? canonicalizeViews(value.value) : canonicalizeForYaml(value.value);
    }
  }
  const output = stringifyYaml(result, { lineWidth: 0 });
  return output.endsWith('\n') ? output : `${output}\n`;
}

function parseBasesDocument(text: string): { root: PlainRecord; views: ViewCollection } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text) ?? {};
  } catch {
    throw new GitCommandError('Obsidian Bases YAML could not be parsed.', '');
  }
  if (!isPlainRecord(parsed)) {
    throw new GitCommandError('Obsidian Bases YAML must be a mapping.', '');
  }
  for (const field of BASE_MAP_FIELDS) {
    readOptionalPlainMap(parsed, field);
  }
  const views = parseViews(parsed);
  return { root: parsed, views };
}

function mergeNamedMapField(field: string, base: PlainRecord, current: PlainRecord, device: PlainRecord): FieldState {
  const baseMap = readOptionalPlainMap(base, field);
  const currentMap = readOptionalPlainMap(current, field);
  const deviceMap = readOptionalPlainMap(device, field);
  if (!baseMap.present && !currentMap.present && !deviceMap.present) {
    return { present: false };
  }
  const result: PlainRecord = {};
  const keys = [
    ...new Set([
      ...Object.keys(fieldMapValue(baseMap)),
      ...Object.keys(fieldMapValue(currentMap)),
      ...Object.keys(fieldMapValue(deviceMap))
    ])
  ].sort();
  for (const key of keys) {
    const merged = mergeMapEntry(
      `Bases ${field}.${key}`,
      fieldState(fieldMapValue(baseMap), key),
      fieldState(fieldMapValue(currentMap), key),
      fieldState(fieldMapValue(deviceMap), key)
    );
    if (merged.present) {
      result[key] = canonicalizeForYaml(merged.value);
    }
  }
  return { present: true, value: result };
}

function mergeMapEntry(label: string, base: FieldState, current: FieldState, device: FieldState): FieldState {
  if (fieldStatesEqual(current, base)) {
    return device;
  }
  if (fieldStatesEqual(device, base)) {
    return current;
  }
  if (fieldStatesEqual(current, device)) {
    return current;
  }
  if (!base.present) {
    throw new GitCommandError(`${label} concurrent additions require review.`, '');
  }
  if (!current.present || !device.present) {
    throw new GitCommandError(`${label} delete-vs-edit requires review.`, '');
  }
  if (isPlainRecord(base.value) && isPlainRecord(current.value) && isPlainRecord(device.value)) {
    return mergeNestedObject(label, base.value, current.value, device.value);
  }
  throw new GitCommandError(`${label} concurrent edits require review.`, '');
}

function mergeNestedObject(label: string, base: PlainRecord, current: PlainRecord, device: PlainRecord): FieldState {
  const result: PlainRecord = {};
  const keys = [...new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(device)])].sort();
  for (const key of keys) {
    const merged = mergeAtomicField(
      `${label}.${key}`,
      fieldState(base, key),
      fieldState(current, key),
      fieldState(device, key)
    );
    if (merged.present) {
      result[key] = canonicalizeForYaml(merged.value);
    }
  }
  return { present: true, value: result };
}

function mergeAtomicField(label: string, base: FieldState, current: FieldState, device: FieldState): FieldState {
  if (fieldStatesEqual(current, base)) {
    return device;
  }
  if (fieldStatesEqual(device, base)) {
    return current;
  }
  if (fieldStatesEqual(current, device)) {
    return current;
  }
  throw new GitCommandError(`${label} concurrent edits require review.`, '');
}

function parseViews(root: PlainRecord): ViewCollection {
  const views = fieldState(root, 'views');
  if (!views.present) {
    return { present: false, byKey: new Map(), order: [] };
  }
  if (!Array.isArray(views.value)) {
    throw new GitCommandError('Obsidian Bases views must be a sequence.', '');
  }
  const byKey = new Map<string, PlainRecord>();
  const order: string[] = [];
  for (const value of views.value) {
    if (!isPlainRecord(value) || typeof value.type !== 'string' || typeof value.name !== 'string') {
      throw new GitCommandError('Obsidian Bases views must have string type and name fields.', '');
    }
    const key = viewKey(value);
    if (byKey.has(key)) {
      throw new GitCommandError('Obsidian Bases views must not duplicate a type/name pair.', '');
    }
    byKey.set(key, value);
    order.push(key);
  }
  return { present: true, byKey, order };
}

function mergeViews(base: ViewCollection, current: ViewCollection, device: ViewCollection): FieldState {
  if (!base.present && !current.present && !device.present) {
    return { present: false };
  }
  assertNoViewReorder(base, current, 'current main');
  assertNoViewReorder(base, device, 'device commit');
  const baseKeys = new Set(base.order);
  const additionKeys = [
    ...new Set([...current.order, ...device.order].filter((key) => !baseKeys.has(key)))
  ].sort();
  const result: PlainRecord[] = [];
  for (const key of [...base.order, ...additionKeys]) {
    const merged = mergeViewEntry(
      key,
      viewState(base, key),
      viewState(current, key),
      viewState(device, key)
    );
    if (merged.present) {
      if (!isPlainRecord(merged.value)) {
        throw new GitCommandError('Merged Obsidian Bases view must be a mapping.', '');
      }
      result.push(canonicalizeView(merged.value));
    }
  }
  return { present: true, value: result };
}

function mergeViewEntry(key: string, base: FieldState, current: FieldState, device: FieldState): FieldState {
  if (fieldStatesEqual(current, base)) {
    return device;
  }
  if (fieldStatesEqual(device, base)) {
    return current;
  }
  if (fieldStatesEqual(current, device)) {
    return current;
  }
  if (!base.present) {
    throw new GitCommandError('Obsidian Bases concurrent view additions require review.', '');
  }
  if (!current.present || !device.present) {
    throw new GitCommandError('Obsidian Bases view delete-vs-edit requires review.', '');
  }
  if (isPlainRecord(base.value) && isPlainRecord(current.value) && isPlainRecord(device.value)) {
    return mergeViewObject(key, base.value, current.value, device.value);
  }
  throw new GitCommandError('Obsidian Bases concurrent view edits require review.', '');
}

function mergeViewObject(key: string, base: PlainRecord, current: PlainRecord, device: PlainRecord): FieldState {
  const currentChanged = changedFieldKeys(base, current);
  const deviceChanged = changedFieldKeys(base, device);
  if (currentChanged.size > 0 && deviceChanged.size > 0) {
    const changed = new Set([...currentChanged, ...deviceChanged]);
    for (const field of changed) {
      if (!KNOWN_VIEW_KEYS.has(field)) {
        throw new GitCommandError('Obsidian Bases concurrent unknown view-key edits require review.', '');
      }
    }
    for (const field of RESTRICTED_CONCURRENT_VIEW_KEYS) {
      if (changed.has(field)) {
        throw new GitCommandError(`Obsidian Bases same-view ${field} edits require review.`, '');
      }
    }
  }
  return mergeNestedObject(`Obsidian Bases view ${key.replace(VIEW_KEY_SEPARATOR, '/')}`, base, current, device);
}

function assertNoViewReorder(base: ViewCollection, side: ViewCollection, label: string): void {
  const baseKeys = new Set(base.order);
  const expected = base.order.filter((key) => side.byKey.has(key));
  const actual = side.order.filter((key) => baseKeys.has(key));
  if (!arraysEqual(expected, actual)) {
    throw new GitCommandError(`Obsidian Bases ${label} view reorder requires review.`, '');
  }
}

function readOptionalPlainMap(root: PlainRecord, field: string): FieldState {
  const value = fieldState(root, field);
  if (!value.present) {
    return value;
  }
  if (!isPlainRecord(value.value)) {
    throw new GitCommandError(`Obsidian Bases ${field} must be a mapping.`, '');
  }
  return value;
}

function fieldMapValue(field: FieldState): PlainRecord {
  return field.present && isPlainRecord(field.value) ? field.value : {};
}

function viewState(views: ViewCollection, key: string): FieldState {
  const value = views.byKey.get(key);
  return value === undefined ? { present: false } : { present: true, value };
}

function viewKey(view: PlainRecord): string {
  return `${String(view.type)}${VIEW_KEY_SEPARATOR}${String(view.name)}`;
}

function fieldState(record: PlainRecord, field: string): FieldState {
  return Object.prototype.hasOwnProperty.call(record, field) ? { present: true, value: record[field] } : { present: false };
}

function fieldStatesEqual(left: FieldState, right: FieldState): boolean {
  if (!left.present || !right.present) {
    return left.present === right.present;
  }
  return stableJson(left.value) === stableJson(right.value);
}

function changedFieldKeys(base: PlainRecord, side: PlainRecord): Set<string> {
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(base), ...Object.keys(side)])) {
    if (!fieldStatesEqual(fieldState(base, key), fieldState(side, key))) {
      changed.add(key);
    }
  }
  return changed;
}

function canonicalizeViews(value: unknown): unknown {
  return Array.isArray(value) ? value.map((entry) => (isPlainRecord(entry) ? canonicalizeView(entry) : canonicalizeForYaml(entry))) : value;
}

function canonicalizeView(view: PlainRecord): PlainRecord {
  const ordered: PlainRecord = {};
  for (const key of ['type', 'name']) {
    if (Object.prototype.hasOwnProperty.call(view, key)) {
      ordered[key] = canonicalizeForYaml(view[key]);
    }
  }
  for (const key of Object.keys(view).filter((field) => field !== 'type' && field !== 'name').sort()) {
    ordered[key] = canonicalizeForYaml(view[key]);
  }
  return ordered;
}

function canonicalizeForYaml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForYaml);
  }
  if (isPlainRecord(value)) {
    const ordered: PlainRecord = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = canonicalizeForYaml(value[key]);
    }
    return ordered;
  }
  return value;
}

function canonicalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForJson);
  }
  if (isPlainRecord(value)) {
    const ordered: PlainRecord = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = canonicalizeForJson(value[key]);
    }
    return ordered;
  }
  return value;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedObjectKeys(base: Record<string, unknown> | undefined, side: Record<string, unknown>): Set<string> {
  const changed = new Set<string>();
  for (const key of new Set([...(base ? Object.keys(base) : []), ...Object.keys(side)])) {
    if (stableJson(base?.[key]) !== stableJson(side[key])) {
      changed.add(key);
    }
  }
  return changed;
}

function objectChanged(base: Record<string, unknown>, side: Record<string, unknown>): boolean {
  return changedObjectKeys(base, side).size > 0;
}

function orderOf(order: string[], ids: Set<string>): string {
  return order.filter((id) => ids.has(id)).join('\0');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
