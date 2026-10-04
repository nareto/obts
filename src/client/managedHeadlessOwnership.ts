import { fstatSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, statfsSync } from 'node:fs';
import { open, link, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const trustedFilesystemTypes = new Set([0x0000ef53, 0x58465342, 0x9123683e, 0x794c7630, 0x01021994]);
const managedOwnerBrand = Symbol('managed-headless-owner');

export async function publishManagedApplyMarker(
  obtsDir: string,
  markerPath: string,
  contents: string,
  publicationOps = { open, link, lstat, unlink }
): Promise<void> {
  const expectedPath = resolve(join(obtsDir, 'apply.lock'));
  if (resolve(markerPath) !== expectedPath) throw new Error('Unexpected managed apply marker path.');
  const temporaryPath = join(obtsDir, `.apply.lock.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let identity: { dev: number; ino: number } | null = null;
  try {
    handle = await publicationOps.open(temporaryPath, 'wx', 0o600);
    identity = await handle.stat();
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await publicationOps.link(temporaryPath, markerPath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (identity) {
      try {
        const current = await publicationOps.lstat(temporaryPath);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
          await publicationOps.unlink(temporaryPath);
        }
      } catch {}
    }
  }
}

export type ManagedHeadlessOwnership = {
  readonly [managedOwnerBrand]: true;
  readonly generation: string;
  canReclaim(marker: unknown): boolean;
  publishApplyMarker(contents: string): Promise<void>;
};

export function createManagedHeadlessOwnership(
  vaultDir: string,
  publicationOps = { open, link, lstat, unlink }
): ManagedHeadlessOwnership | null {
  if (process.platform !== 'linux') return null;
  const canonicalVault = realpathSync(vaultDir);
  const obtsDir = join(canonicalVault, '.obts');
  const lockPath = join(obtsDir, 'headless-owner.lock');
  let directory: ReturnType<typeof lstatSync>;
  let lock: ReturnType<typeof lstatSync>;
  try {
    directory = lstatSync(obtsDir);
    lock = lstatSync(lockPath);
  } catch {
    return null;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      !lock.isFile() || lock.isSymbolicLink() || (lock.mode & 0o077) !== 0 ||
      !trustedFilesystemTypes.has(statfsSync(canonicalVault).type)) return null;
  const applyMarkerPath = join(obtsDir, 'apply.lock');
  const expectedPath = resolve(lockPath);
  let held = false;
  for (const entry of readdirSync('/proc/self/fd')) {
    const descriptor = Number(entry);
    if (!Number.isInteger(descriptor) || descriptor < 3) continue;
    try {
      const current = fstatSync(descriptor);
      if (current.dev !== lock.dev || current.ino !== lock.ino) continue;
      const fdPath = readlinkSync(`/proc/self/fd/${descriptor}`);
      if (resolve(fdPath) !== expectedPath) continue;
      const info = readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8');
      const currentOwnerLock = new RegExp(`^lock:\\s+\\d+: FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+`, 'mu');
      held = currentOwnerLock.test(info);
      if (held) break;
    } catch {}
  }
  if (!held) return null;
  const generation = randomUUID();
  return Object.freeze({
    [managedOwnerBrand]: true as const,
    generation,
    publishApplyMarker: async (contents: string): Promise<void> => {
      await publishManagedApplyMarker(obtsDir, applyMarkerPath, contents, publicationOps);
    },
    canReclaim: (marker: unknown): boolean => {
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
      const value = marker as Record<string, unknown>;
      const keys = Object.keys(value).sort();
      return keys.length === 4 && keys.join(',') === 'apply_id,domain,generation,version' &&
        value.version === 2 && value.domain === 'obts-managed-linux-headless' &&
        value.generation !== generation && typeof value.generation === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.generation) &&
        typeof value.apply_id === 'string' && /^apply_[0-9A-Za-z_-]{1,120}$/u.test(value.apply_id);
    }
  });
}
