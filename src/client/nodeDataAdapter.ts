import { mkdirSync } from 'node:fs';
import {
  lstat,
  mkdir,
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

  async writeBinary(adapterPath: string, data: ArrayBuffer): Promise<void> {
    const target = this.resolvePath(adapterPath);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, new Uint8Array(data), { mode: 0o600 });
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
