import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type DurableFilePersistence = {
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

const defaultPersistence: DurableFilePersistence = {
  writeFile: async (path, data) => await writeFile(path, data, { mode: 0o600, flag: 'wx' }),
  fsyncFile: async (path) => {
    const file = await open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  },
  rename,
  fsyncDirectory: async (path) => {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
  remove: async (path) => await rm(path, { force: true })
};

export async function fsyncDurableFile(
  path: string,
  overrides: Partial<DurableFilePersistence> = {}
): Promise<void> {
  const persistence = { ...defaultPersistence, ...overrides };
  await persistence.fsyncFile(path);
}

export async function fsyncDurableDirectory(
  path: string,
  overrides: Partial<DurableFilePersistence> = {}
): Promise<void> {
  const persistence = { ...defaultPersistence, ...overrides };
  await persistence.fsyncDirectory(path);
}

export async function fsyncDurableTree(
  path: string,
  overrides: Partial<DurableFilePersistence> = {}
): Promise<void> {
  const persistence = { ...defaultPersistence, ...overrides };
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Cannot durably sync a symbolic link.');
  if (info.isFile()) {
    await persistence.fsyncFile(path);
    return;
  }
  if (!info.isDirectory()) throw new Error('Cannot durably sync an unsupported filesystem entry.');
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await fsyncDurableTree(join(path, entry.name), persistence);
  }
  await persistence.fsyncDirectory(path);
}

export async function writeDurableFile(
  destination: string,
  data: string | Uint8Array,
  overrides: Partial<DurableFilePersistence> = {}
): Promise<void> {
  const persistence = { ...defaultPersistence, ...overrides };
  const temporary = `${destination}.tmp-${randomBytes(6).toString('hex')}`;
  let renameAttempted = false;
  let published = false;
  try {
    try {
      await persistence.writeFile(temporary, data);
      await persistence.fsyncFile(temporary);
    } catch (error) {
      await persistence.remove(temporary).catch(() => undefined);
      throw error;
    }
    renameAttempted = true;
    await persistence.rename(temporary, destination);
    published = true;
    await persistence.fsyncDirectory(dirname(destination));
  } finally {
    if (published) {
      await persistence.remove(temporary).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    } else if (!renameAttempted) {
      await persistence.remove(temporary).catch(() => undefined);
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
