export class MemoryDataAdapter {
  renameCallCount = 0;
  failOnRenameCall: number | null = null;
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>(['']);

  async readBinary(filePath: string): Promise<ArrayBuffer> {
    const data = this.files.get(clean(filePath));
    if (!data) throw codedError('ENOENT');
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  async writeBinary(filePath: string, data: ArrayBuffer): Promise<void> {
    const normalized = clean(filePath);
    const parent = parentPath(normalized);
    if (!this.folders.has(parent)) throw codedError('ENOENT');
    this.files.set(normalized, new Uint8Array(data.slice(0)));
  }

  async mkdir(dirPath: string): Promise<void> {
    const normalized = clean(dirPath);
    if (this.files.has(normalized) || this.folders.has(normalized)) throw codedError('EEXIST');
    if (!this.folders.has(parentPath(normalized))) throw codedError('ENOENT');
    this.folders.add(normalized);
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = clean(filePath);
    return this.files.has(normalized) || this.folders.has(normalized);
  }

  async stat(filePath: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const normalized = clean(filePath);
    const data = this.files.get(normalized);
    if (data) return { type: 'file', ctime: 0, mtime: 0, size: data.byteLength };
    if (this.folders.has(normalized)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
    return null;
  }

  async list(dirPath: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = clean(dirPath);
    if (!this.folders.has(normalized)) throw codedError('ENOENT');
    return {
      files: [...this.files.keys()].filter((entry) => parentPath(entry) === normalized).sort(),
      folders: [...this.folders].filter((entry) => entry && parentPath(entry) === normalized).sort()
    };
  }

  async remove(filePath: string): Promise<void> {
    if (!this.files.delete(clean(filePath))) throw codedError('ENOENT');
  }

  async rmdir(dirPath: string, recursive = false): Promise<void> {
    const normalized = clean(dirPath);
    if (!this.folders.has(normalized)) throw codedError('ENOENT');
    const descendants = (entry: string) => entry.startsWith(`${normalized}/`);
    if (!recursive && ([...this.files.keys()].some(descendants) || [...this.folders].some(descendants))) throw codedError('ENOTEMPTY');
    for (const file of [...this.files.keys()]) if (descendants(file)) this.files.delete(file);
    for (const folder of [...this.folders]) if (folder === normalized || descendants(folder)) this.folders.delete(folder);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.renameCallCount += 1;
    if (this.failOnRenameCall === this.renameCallCount) throw codedError('EIO');
    const source = clean(oldPath);
    const destination = clean(newPath);
    if (this.files.has(source)) {
      const data = this.files.get(source)!;
      this.files.delete(source);
      this.files.set(destination, data);
      return;
    }
    if (!this.folders.has(source)) throw codedError('ENOENT');
    const remap = (entry: string) => `${destination}${entry.slice(source.length)}`;
    const files = [...this.files.entries()].filter(([entry]) => entry.startsWith(`${source}/`));
    const folders = [...this.folders].filter((entry) => entry === source || entry.startsWith(`${source}/`));
    for (const [entry] of files) this.files.delete(entry);
    for (const entry of folders) this.folders.delete(entry);
    for (const entry of folders) this.folders.add(remap(entry));
    for (const [entry, data] of files) this.files.set(remap(entry), data);
  }
}

function clean(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
}

function parentPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index < 0 ? '' : value.slice(0, index);
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
