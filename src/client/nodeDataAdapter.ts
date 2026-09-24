import { constants, mkdirSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type AdapterStat = {
  type: 'file' | 'folder';
  size: number;
  ctime: number;
  mtime: number;
};

export class NodeDataAdapter {
  private readonly root: string;

  constructor(vaultDir: string) {
    this.root = resolve(vaultDir);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async readBinary(adapterPath: string): Promise<ArrayBuffer> {
    const data = await readFile(this.resolvePath(adapterPath));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  async readRootIgnorePolicyNoFollow(maxBytes: number): Promise<ArrayBuffer | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !constants.O_NOFOLLOW) {
      throw new Error('Root .gitignore cannot be read safely on this platform.');
    }
    const path = this.resolvePath('.gitignore');
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    if (!before.isFile()) throw new Error('Root .gitignore must be a regular readable file.');
    if (before.size > maxBytes) throw new Error('Root .gitignore exceeds the byte limit.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        throw new Error('Root .gitignore changed while opening.');
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      const after = await lstat(path);
      const readState = await handle.stat();
      if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino ||
          readState.size !== opened.size || size !== opened.size || size > maxBytes ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          readState.mtimeMs !== before.mtimeMs || readState.ctimeMs !== before.ctimeMs) {
        throw new Error('Root .gitignore changed while reading.');
      }
      return buffer.subarray(0, size).buffer.slice(buffer.byteOffset, buffer.byteOffset + size) as ArrayBuffer;
    } finally {
      await handle.close();
    }
  }

  async writeBinary(adapterPath: string, data: ArrayBuffer): Promise<void> {
    const target = this.resolvePath(adapterPath);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, new Uint8Array(data), { mode: 0o600 });
  }

  async writeBinaryExclusive(adapterPath: string, data: ArrayBuffer): Promise<void> {
    const target = this.resolvePath(adapterPath);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, new Uint8Array(data), { flag: 'wx', mode: 0o600 });
  }

  async stat(adapterPath: string): Promise<AdapterStat | null> {
    try {
      const target = this.resolvePath(adapterPath);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) return null;
      if (!metadata.isFile() && !metadata.isDirectory()) return null;
      return {
        type: metadata.isDirectory() ? 'folder' : 'file',
        size: metadata.size,
        ctime: metadata.birthtimeMs,
        mtime: metadata.mtimeMs
      };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async list(adapterPath: string): Promise<{ files: string[]; folders: string[] }> {
    const directory = this.resolvePath(adapterPath);
    const entries = await readdir(directory, { withFileTypes: true });
    const prefix = normalizeAdapterPath(adapterPath);
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) folders.push(child);
      else if (entry.isFile()) files.push(child);
    }
    files.sort();
    folders.sort();
    return { files, folders };
  }

  async mkdir(adapterPath: string): Promise<void> {
    await mkdir(this.resolvePath(adapterPath), { mode: 0o700 });
  }

  async remove(adapterPath: string): Promise<void> {
    await unlink(this.resolvePath(adapterPath));
  }

  async rmdir(adapterPath: string, recursive = false): Promise<void> {
    const target = this.resolvePath(adapterPath);
    if (recursive) await rm(target, { recursive: true, force: false });
    else await rmdir(target);
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const destination = this.resolvePath(destinationPath);
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await rename(this.resolvePath(sourcePath), destination);
  }

  async syncFile(adapterPath: string): Promise<void> {
    const handle = await open(this.resolvePath(adapterPath), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async syncDirectory(adapterPath: string): Promise<void> {
    const handle = await open(this.resolvePath(adapterPath), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async exists(adapterPath: string): Promise<boolean> {
    return (await this.stat(adapterPath)) !== null;
  }

  async read(adapterPath: string): Promise<string> {
    return readFile(this.resolvePath(adapterPath), 'utf8');
  }

  async write(adapterPath: string, content: string): Promise<void> {
    const target = this.resolvePath(adapterPath);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  }

  private resolvePath(adapterPath: string): string {
    const normalized = normalizeAdapterPath(adapterPath);
    const target = resolve(this.root, normalized);
    const fromRoot = relative(this.root, target);
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw Object.assign(new Error(`EINVAL: ${adapterPath}`), { code: 'EINVAL', path: adapterPath });
    }
    return target;
  }
}

function normalizeAdapterPath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw Object.assign(new Error(`EINVAL: ${String(value)}`), { code: 'EINVAL', path: value });
  }
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
