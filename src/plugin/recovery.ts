import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';

export type ApplyJournal = {
  apply_id: string;
  operation_type: 'pull_apply' | 'initial_import' | 'replace_local_with_server';
  target_main: string;
  expected_prior_local_main: string | null;
  expected_prior_local_device_ref: string | null;
  phase: 'planned' | 'recovery_bundle_written' | 'writing_files' | 'verifying' | 'committed' | 'blocked_recovery';
  affected_paths: string[];
  preflight_sha256: Record<string, string | null>;
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
      return JSON.parse(await readFile(join(this.vaultDir, '.obts', 'apply-journal.json'), 'utf8')) as ApplyJournal;
    } catch {
      return null;
    }
  }

  async clearApplyJournal(): Promise<void> {
    await rm(join(this.vaultDir, '.obts', 'apply-journal.json'), { force: true });
  }

  async createRecoveryBundle(input: RecoveryBundleInput): Promise<string> {
    const bundleId = newId('rec');
    const bundleDir = join(this.vaultDir, '.obts', 'recovery', bundleId);
    await mkdir(join(bundleDir, 'files'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'git'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'patches'), { recursive: true, mode: 0o700 });
    await mkdir(join(bundleDir, 'journal'), { recursive: true, mode: 0o700 });

    const checksums: string[] = [];
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
        checksums.push(`${sha256(content)}  files/${path}`);
      } catch {
        checksums.push(`missing  files/${path}`);
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
      checksum_manifest: checksums
    };
    await writeJson(join(bundleDir, 'manifest.json'), manifest);
    if (input.journal) {
      await writeJson(join(bundleDir, 'journal', 'apply-journal.json'), input.journal);
    }
    await writeFile(join(bundleDir, 'git', 'local-refs.pack'), Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(bundleDir, 'checksums.sha256'), `${checksums.join('\n')}\n`, { mode: 0o600 });
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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
