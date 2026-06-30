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

  async tryNativeMergeTree(
    vaultId: string,
    base: string,
    currentMain: string,
    deviceCommit: string,
    mergedTextPaths: string[]
  ): Promise<string | null> {
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
      return null;
    }

    if (!/^[0-9a-f]{40}$/u.test(tree)) {
      return null;
    }

    try {
      await this.validateTreePathPolicy(vaultId, tree);
      await this.validateMergedTextPaths(vaultId, {
        tree,
        base,
        currentMain,
        deviceCommit,
        paths: mergedTextPaths
      });
    } catch {
      return null;
    }

    return tree;
  }

  async createMergeCommitFromTree(input: {
    vaultId: string;
    tree: string;
    base: string;
    currentMain: string;
    deviceCommit: string;
    mergeSequence: number;
    strategy: 'disjoint_overlay' | 'native_clean';
  }): Promise<string> {
    const repo = this.repoPath(input.vaultId);
    const commit = asText(
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
    await this.updateRef(input.vaultId, 'refs/heads/main', commit, input.currentMain);
    return commit;
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
  ): Promise<void> {
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
        const merged = assertValidJsonCanvas(text);
        if (baseText !== null && currentText !== null && deviceText !== null) {
          assertCanvasMergeAllowed(
            assertValidJsonCanvas(baseText),
            assertValidJsonCanvas(currentText),
            assertValidJsonCanvas(deviceText),
            merged
          );
        }
      }
    }
  }

  private async readTextAtPathIfPresent(vaultId: string, treeish: string, path: string): Promise<string | null> {
    try {
      return (await this.readBlobAtPath(vaultId, treeish, path)).toString('utf8');
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
    const edgeRecord = edge as Record<string, unknown> & { id?: unknown; fromNode?: unknown; toNode?: unknown };
    if (typeof edgeRecord.id !== 'string' || edgeIds.has(edgeRecord.id)) {
      throw new GitCommandError('Merged canvas edge IDs must be unique strings.', '');
    }
    if (typeof edgeRecord.fromNode !== 'string' || typeof edgeRecord.toNode !== 'string') {
      throw new GitCommandError('Merged canvas edges must reference node IDs.', '');
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
