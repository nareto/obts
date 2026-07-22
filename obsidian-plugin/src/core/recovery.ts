import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';

import { newId, nowIso } from '../../../src/shared/ids.js';
import { normalizeVaultPath } from '../../../src/shared/pathPolicy.js';

export type ApplyFingerprint = {
  kind: 'missing' | 'file' | 'directory' | 'other';
  sha256: string | null;
  oid: string | null;
};

export type ApplyJournal = {
  journal_version?: 1 | 2 | 3;
  apply_id: string;
  operation_type: 'pull_apply' | 'initial_import' | 'replace_local_with_server' | 'rebuild_from_server';
  target_main: string;
  expected_prior_local_main: string | null;
  expected_prior_local_device_ref: string | null;
  phase: 'planned' | 'recovery_bundle_written' | 'writing_files' | 'verifying' | 'committed' | 'blocked_recovery';
  affected_paths: string[];
  preflight_sha256: Record<string, string | null>;
  preflight_fingerprints?: Record<string, ApplyFingerprint>;
  directory_intents?: Array<{ op: 'create' | 'delete'; path: string }>;
  explicit_directories?: string[];
  pre_apply_directories?: string[];
  pre_apply_directory_ctimes?: Record<string, number | null>;
  preserve_local_changes?: boolean;
  event_seq?: number | null;
  recovery_bundle_id: string | null;
  last_completed_step: string | null;
  redacted_error_category: string | null;
};

export type RecoveryBundleInput = {
  vaultId: string;
  deviceId: string;
  operationType: ApplyJournal['operation_type'];
  targetMain: string;
  priorLocalMain: string | null;
  priorLocalDeviceRef: string | null;
  affectedPaths: string[];
  platform: string;
  pluginVersion: string;
  journal?: ApplyJournal;
  localRefsPack?: Buffer;
};

export class ApplyLockActiveError extends Error {
  readonly code = 'apply_lock_active';

  constructor() {
    super('Another apply operation already holds the local vault lock.');
  }
}

export class RecoveryManager {
  constructor(private readonly vaultDir: string) {}

  async acquireApplyLock(applyId: string): Promise<() => Promise<void>> {
    const lockPath = join(this.vaultDir, '.obts', 'apply.lock');
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        throw new ApplyLockActiveError();
      }
      throw error;
    }

    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            apply_id: applyId,
            created_at: nowIso(),
            pid: process.pid
          },
          null,
          2
        )}\n`
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
      throw error;
    }
    await handle.close();

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await rm(lockPath, { force: true });
    };
  }

  async writeApplyJournal(journal: ApplyJournal): Promise<void> {
    await writeJson(join(this.vaultDir, '.obts', 'apply-journal.json'), journal);
  }

  async readApplyJournal(): Promise<ApplyJournal | null> {
    try {
      return parseApplyJournal(JSON.parse(await readFile(join(this.vaultDir, '.obts', 'apply-journal.json'), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async clearApplyJournal(): Promise<void> {
    await rm(join(this.vaultDir, '.obts', 'apply-journal.json'), { force: true });
  }

  async clearApplyLock(): Promise<void> {
    await rm(join(this.vaultDir, '.obts', 'apply.lock'), { force: true });
  }

  async createRecoveryBundle(input: RecoveryBundleInput): Promise<string> {
    const bundleId = newId('rec');
    const bundleDir = join(this.vaultDir, '.obts', 'recovery', bundleId);
    await mkdir(join(bundleDir, 'files'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'git'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'patches'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'journal'), { recursive: true, mode: 0o700 });

    const snapshotChecksums: string[] = [];
    for (const path of input.affectedPaths) {
      if (path.startsWith('.obts/auth/')) {
        continue;
      }
      const absolutePath = join(this.vaultDir, path);
      try {
        const content = await readFile(absolutePath);
        const target = join(bundleDir, 'files', path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
        snapshotChecksums.push(`${sha256(content)}  files/${path}`);
        if (isTextPatchPath(path)) {
          await writeTextSnapshotPatch(bundleDir, path, content);
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'EISDIR')) throw error;
        snapshotChecksums.push(`missing  files/${path}`);
      }
    }

    const manifest = {
      bundle_id: bundleId,
      vault_id: input.vaultId,
      device_id: input.deviceId,
      created_at: nowIso(),
      operation_type: input.operationType,
      target_main: input.targetMain,
      prior_local_main: input.priorLocalMain,
      prior_local_device_ref: input.priorLocalDeviceRef,
      affected_paths: input.affectedPaths,
      platform: input.platform,
      plugin_version: input.pluginVersion,
      checksum_manifest: snapshotChecksums
    };
    await writeJson(join(bundleDir, 'manifest.json'), manifest);
    if (input.journal) {
      await writeJson(join(bundleDir, 'journal', 'apply-journal.json'), input.journal);
    }
    await writeFile(join(bundleDir, 'git', 'local-refs.pack'), input.localRefsPack ?? Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(bundleDir, 'checksums.sha256'), `${(await bundleChecksums(bundleDir)).join('\n')}\n`, {
      mode: 0o600
    });
    return bundleId;
  }
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function parseApplyJournal(value: unknown): ApplyJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Apply journal is invalid.');
  const journal = value as Record<string, unknown>;
  const operations = new Set(['pull_apply', 'initial_import', 'replace_local_with_server', 'rebuild_from_server']);
  const phases = new Set(['planned', 'recovery_bundle_written', 'writing_files', 'verifying', 'committed', 'blocked_recovery']);
  const affectedPaths = journal.affected_paths;
  const preflight = journal.preflight_sha256;
  const journalVersion = journal.journal_version === undefined ? 1 : journal.journal_version;
  const typedPreflight = journal.preflight_fingerprints;
  const directoryIntents = journal.directory_intents;
  const explicitDirectories = journal.explicit_directories;
  const preApplyDirectories = journal.pre_apply_directories;
  const preApplyDirectoryCtimes = journal.pre_apply_directory_ctimes;
  if (
    journalVersion !== 1 && journalVersion !== 2 && journalVersion !== 3 ||
    typeof journal.apply_id !== 'string' || journal.apply_id.length === 0 ||
    typeof journal.operation_type !== 'string' || !operations.has(journal.operation_type) ||
    typeof journal.target_main !== 'string' || !/^[0-9a-f]{40}$/u.test(journal.target_main) ||
    !isNullableString(journal.expected_prior_local_main) ||
    !isNullableString(journal.expected_prior_local_device_ref) ||
    typeof journal.phase !== 'string' || !phases.has(journal.phase) ||
    !Array.isArray(affectedPaths) || affectedPaths.some((path) => typeof path !== 'string' || !isSafeJournalPath(path)) ||
    new Set(affectedPaths).size !== affectedPaths.length ||
    !preflight || typeof preflight !== 'object' || Array.isArray(preflight) ||
    affectedPaths.some((path) => !Object.hasOwn(preflight, path) || !isNullableSha256((preflight as Record<string, unknown>)[path])) ||
    journalVersion >= 2 && (
      !typedPreflight || typeof typedPreflight !== 'object' || Array.isArray(typedPreflight) ||
      affectedPaths.some((path) => !Object.hasOwn(typedPreflight, path) ||
        !isApplyFingerprint((typedPreflight as Record<string, unknown>)[path]))
    ) ||
    journalVersion === 3 && (
      !Array.isArray(directoryIntents) || directoryIntents.some((intent) => {
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return true;
        const candidate = intent as Record<string, unknown>;
        return (candidate.op !== 'create' && candidate.op !== 'delete') ||
          typeof candidate.path !== 'string' || !isSafeJournalPath(candidate.path);
      }) ||
      !Array.isArray(explicitDirectories) || explicitDirectories.some((path) => typeof path !== 'string' || !isSafeJournalPath(path)) ||
      new Set(explicitDirectories).size !== explicitDirectories.length ||
      !Array.isArray(preApplyDirectories) || preApplyDirectories.some((path) => typeof path !== 'string' || !isSafeJournalPath(path)) ||
      new Set(preApplyDirectories).size !== preApplyDirectories.length ||
      !preApplyDirectoryCtimes || typeof preApplyDirectoryCtimes !== 'object' || Array.isArray(preApplyDirectoryCtimes) ||
      Object.keys(preApplyDirectoryCtimes).length !== preApplyDirectories.length ||
      preApplyDirectories.some((path) => !Object.hasOwn(preApplyDirectoryCtimes, path) ||
        !isNullableNonNegativeNumber((preApplyDirectoryCtimes as Record<string, unknown>)[path])) ||
      typeof journal.preserve_local_changes !== 'boolean' ||
      !(journal.event_seq === null || Number.isSafeInteger(journal.event_seq) && Number(journal.event_seq) >= 0)
    ) ||
    !isNullableString(journal.recovery_bundle_id) ||
    !isNullableString(journal.last_completed_step) ||
    !isNullableString(journal.redacted_error_category)
  ) {
    throw new Error('Apply journal is invalid.');
  }
  return value as ApplyJournal;
}

function isSafeJournalPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized.ok && normalized.path === path;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isNullableSha256(value: unknown): boolean {
  return value === null || typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isNullableNonNegativeNumber(value: unknown): boolean {
  return value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isApplyFingerprint(value: unknown): value is ApplyFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fingerprint = value as Record<string, unknown>;
  if (!['missing', 'file', 'directory', 'other'].includes(String(fingerprint.kind))) return false;
  if (fingerprint.kind === 'file') {
    return typeof fingerprint.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(fingerprint.sha256) &&
      typeof fingerprint.oid === 'string' && /^[0-9a-f]{40}$/u.test(fingerprint.oid);
  }
  return fingerprint.sha256 === null && fingerprint.oid === null;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeTextSnapshotPatch(bundleDir: string, path: string, content: Buffer): Promise<void> {
  const patchPath = join(bundleDir, 'patches', `${path.replaceAll('/', '__')}.patch`);
  await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 });
  const text = content.toString('utf8');
  const body = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    ...text.split('\n').map((line) => `+${line}`)
  ].join('\n');
  await writeFile(patchPath, `${body}\n`, { mode: 0o600 });
}

async function bundleChecksums(bundleDir: string): Promise<string[]> {
  const entries: string[] = [];
  await walkBundleFiles(bundleDir, async (absolutePath) => {
    const path = relative(bundleDir, absolutePath).replaceAll('\\', '/');
    if (path === 'checksums.sha256') {
      return;
    }
    entries.push(`${sha256(await readFile(absolutePath))}  ${path}`);
  });
  return entries.sort();
}

async function walkBundleFiles(root: string, visitFile: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkBundleFiles(absolutePath, visitFile);
      continue;
    }
    if (entry.isFile()) {
      await visitFile(absolutePath);
      continue;
    }
    try {
      if ((await stat(absolutePath)).isFile()) {
        await visitFile(absolutePath);
      }
    } catch {
      // Recovery bundles are best-effort for non-regular generated artifacts.
    }
  }
}

function isTextPatchPath(path: string): boolean {
  return new Set(['.md', '.canvas', '.base', '.json', '.css', '.txt', '.yaml', '.yml']).has(extname(path).toLowerCase());
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
