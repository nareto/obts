import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type DeletionRoot = {
  configuredPath: string;
  realPath: string;
  device: bigint;
  inode: bigint;
  handle: FileHandle;
  fdPath: string;
};

export class DeletionRootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export async function openDeletionRoot(configuredPath: string): Promise<DeletionRoot> {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
    throw new DeletionRootError('Descriptor-relative deletion is unavailable on this platform.');
  }
  const absolutePath = resolve(configuredPath);
  await assertNoSymlinkComponents(absolutePath);
  const initial = await lstat(absolutePath);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new DeletionRootError('Configured deletion root is not a real directory.');
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat({ bigint: true });
    const resolvedPath = await realpath(absolutePath);
    const resolvedInfo = await lstat(resolvedPath, { bigint: true });
    if (!resolvedInfo.isDirectory() || resolvedInfo.dev !== identity.dev || resolvedInfo.ino !== identity.ino) {
      throw new DeletionRootError('Configured deletion root identity changed.');
    }
    return {
      configuredPath: absolutePath,
      realPath: resolvedPath,
      device: identity.dev,
      inode: identity.ino,
      handle,
      fdPath: `/proc/self/fd/${handle.fd}`
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertDeletionRootUnchanged(root: DeletionRoot): Promise<void> {
  await assertNoSymlinkComponents(root.configuredPath);
  const configured = await lstat(root.configuredPath, { bigint: true });
  if (!configured.isDirectory() || configured.isSymbolicLink() || configured.dev !== root.device || configured.ino !== root.inode) {
    throw new DeletionRootError('Configured deletion root identity changed.');
  }
  const currentRealPath = await realpath(root.configuredPath);
  if (currentRealPath !== root.realPath) {
    throw new DeletionRootError('Configured deletion root realpath changed.');
  }
  const currentHandle = await root.handle.stat({ bigint: true });
  if (currentHandle.dev !== root.device || currentHandle.ino !== root.inode) {
    throw new DeletionRootError('Opened deletion root identity changed.');
  }
}

export async function readDeletionRootEntries(root: DeletionRoot): Promise<Dirent[]> {
  await assertDeletionRootUnchanged(root);
  return await readdir(root.fdPath, { withFileTypes: true });
}

export async function removeDeletionRootChild(root: DeletionRoot, name: string): Promise<void> {
  if (!name || name.includes(sep) || name === '.' || name === '..') {
    throw new DeletionRootError('Deletion candidate is not a direct child.');
  }
  await assertDeletionRootUnchanged(root);
  const child = join(root.fdPath, name);
  let info;
  try {
    info = await lstat(child, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new DeletionRootError('Deletion candidate is a symbolic link.');
  }
  await rm(child, { recursive: info.isDirectory(), force: true });
  await assertDeletionRootUnchanged(root);
}

export async function removeDeletionRootDirectoryChild(root: DeletionRoot, name: string): Promise<void> {
  if (!name || name.includes(sep) || name === '.' || name === '..') {
    throw new DeletionRootError('Deletion candidate is not a direct child.');
  }
  await assertDeletionRootUnchanged(root);
  const child = join(root.fdPath, name);
  let info;
  try {
    info = await lstat(child, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DeletionRootError('Deletion candidate is not a real directory.');
  }
  await rm(child, { recursive: true, force: true });
  await assertDeletionRootUnchanged(root);
}

export async function syncDeletionRoot(root: DeletionRoot): Promise<void> {
  await assertDeletionRootUnchanged(root);
  await root.handle.sync();
}

export async function closeDeletionRoot(root: DeletionRoot): Promise<void> {
  await root.handle.close();
}

export async function assertNoSymlinkComponents(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new DeletionRootError('Configured deletion root contains a symbolic-link component.');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
