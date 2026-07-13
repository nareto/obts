const { Buffer } = require("buffer");
const path = require("path-browserify");

const REPLACEMENT_BACKUP_SUFFIX = ".obts-replace-backup";

function createDataAdapterFs(adapter) {
  if (!adapter) {
    throw new Error("An Obsidian DataAdapter is required.");
  }

  const promises = {
    async readFile(filePath, options) {
      const normalized = adapterPath(filePath);
      try {
        const data = Buffer.from(await adapter.readBinary(normalized));
        const encoding = typeof options === "string" ? options : options && options.encoding;
        return encoding ? data.toString(encoding) : data;
      } catch (error) {
        throw await translateError(adapter, normalized, error, "ENOENT");
      }
    },

    async writeFile(filePath, data, options = {}) {
      const normalized = adapterPath(filePath);
      const flag = typeof options === "object" && options ? options.flag : undefined;
      if (flag === "wx" && await adapterStat(adapter, normalized)) {
        throw fsError("EEXIST", normalized);
      }
      await ensureParentDirectories(adapter, normalized);
      const bytes = typeof data === "string" ? Buffer.from(data, options.encoding || "utf8") : Buffer.from(data);
      try {
        await adapter.writeBinary(normalized, toArrayBuffer(bytes));
      } catch (error) {
        throw await translateError(adapter, normalized, error, "EIO");
      }
    },

    async mkdir(dirPath, options = {}) {
      const normalized = adapterPath(dirPath);
      if (!normalized) return;
      const existing = await adapterStat(adapter, normalized);
      if (existing) {
        if (existing.type !== "folder") throw fsError("ENOTDIR", normalized);
        if (options && options.recursive) return;
        throw fsError("EEXIST", normalized);
      }
      try {
        if (options && options.recursive) {
          await ensureDirectories(adapter, normalized);
        } else {
          await adapter.mkdir(normalized);
        }
      } catch (error) {
        throw await translateError(adapter, normalized, error, "EIO");
      }
    },

    async unlink(filePath) {
      const normalized = adapterPath(filePath);
      const stat = await adapterStat(adapter, normalized);
      if (!stat) throw fsError("ENOENT", normalized);
      if (stat.type === "folder") throw fsError("EISDIR", normalized);
      await adapter.remove(normalized);
    },

    async rm(filePath, options = {}) {
      const normalized = adapterPath(filePath);
      const stat = await adapterStat(adapter, normalized);
      if (!stat) {
        if (options && options.force) return;
        throw fsError("ENOENT", normalized);
      }
      if (stat.type === "folder") {
        if (!options || !options.recursive) {
          const listing = await adapter.list(normalized);
          if ((listing.files || []).length || (listing.folders || []).length) {
            throw fsError("ENOTEMPTY", normalized);
          }
        }
        await adapter.rmdir(normalized, Boolean(options && options.recursive));
      } else {
        await adapter.remove(normalized);
      }
    },

    async rmdir(dirPath, options = {}) {
      const normalized = adapterPath(dirPath);
      const stat = await adapterStat(adapter, normalized);
      if (!stat) throw fsError("ENOENT", normalized);
      if (stat.type !== "folder") throw fsError("ENOTDIR", normalized);
      const listing = await adapter.list(normalized);
      if (!(options && options.recursive) && ((listing.files || []).length || (listing.folders || []).length)) {
        throw fsError("ENOTEMPTY", normalized);
      }
      await adapter.rmdir(normalized, Boolean(options && options.recursive));
    },

    async readdir(dirPath, options = {}) {
      const normalized = adapterPath(dirPath);
      try {
        const listing = await adapter.list(normalized);
        const entries = [
          ...(listing.folders || []).map((entry) => dirent(path.posix.basename(entry), "folder")),
          ...(listing.files || []).map((entry) => dirent(path.posix.basename(entry), "file"))
        ].sort((left, right) => left.name.localeCompare(right.name));
        return options && options.withFileTypes ? entries : entries.map((entry) => entry.name);
      } catch (error) {
        throw await translateError(adapter, normalized, error, "ENOENT");
      }
    },

    async stat(filePath) {
      return await requiredStat(adapter, adapterPath(filePath));
    },

    async lstat(filePath) {
      return await requiredStat(adapter, adapterPath(filePath));
    },

    async readlink(filePath) {
      throw fsError("ENOSYS", adapterPath(filePath));
    },

    async symlink(_target, filePath) {
      throw fsError("ENOSYS", adapterPath(filePath));
    },

    async chmod() {
      // DataAdapter has no portable mode API; obts rejects symlinks and special files.
    },

    async rename(oldPath, newPath) {
      const source = adapterPath(oldPath);
      const destination = adapterPath(newPath);
      const sourceStat = await adapterStat(adapter, source);
      if (!sourceStat) throw fsError("ENOENT", source);
      await ensureParentDirectories(adapter, destination);
      const destinationStat = await adapterStat(adapter, destination);
      if (!destinationStat) {
        await adapter.rename(source, destination);
        return;
      }
      if (sourceStat.type === "folder" || destinationStat.type === "folder") {
        throw fsError(sourceStat.type === "folder" ? "EEXIST" : "EISDIR", destination);
      }

      const backup = `${destination}${REPLACEMENT_BACKUP_SUFFIX}`;
      const priorBackup = await adapterStat(adapter, backup);
      if (priorBackup) {
        if (priorBackup.type === "folder") throw fsError("EISDIR", backup);
        await adapter.remove(backup);
      }
      await adapter.rename(destination, backup);
      try {
        await adapter.rename(source, destination);
      } catch (error) {
        if (!await adapterStat(adapter, destination) && await adapterStat(adapter, backup)) {
          await adapter.rename(backup, destination);
        }
        throw error;
      }
      await adapter.remove(backup).catch(() => undefined);
    },

    async copyFile(sourcePath, destinationPath) {
      const data = await promises.readFile(sourcePath);
      await promises.writeFile(destinationPath, data);
    },

    async recoverReplacements(rootPath = "/.obts") {
      const root = adapterPath(rootPath);
      if (!await adapterStat(adapter, root)) return;
      await recoverReplacementTree(adapter, root);
    }
  };

  return { promises };
}

async function requiredStat(adapter, normalized) {
  if (!normalized) return nodeStat({ type: "folder", size: 0, ctime: 0, mtime: 0 });
  const stat = await adapterStat(adapter, normalized);
  if (!stat) throw fsError("ENOENT", normalized);
  return nodeStat(stat);
}

function nodeStat(stat) {
  const directory = stat.type === "folder";
  return {
    size: stat.size || 0,
    mode: directory ? 0o040755 : 0o100644,
    ctimeMs: stat.ctime || 0,
    mtimeMs: stat.mtime || 0,
    uid: 0,
    gid: 0,
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false
  };
}

function dirent(name, type) {
  return {
    name,
    isFile: () => type === "file",
    isDirectory: () => type === "folder",
    isSymbolicLink: () => false
  };
}

async function adapterStat(adapter, normalized) {
  if (!normalized) return { type: "folder", size: 0, ctime: 0, mtime: 0 };
  return await adapter.stat(normalized);
}

async function ensureParentDirectories(adapter, filePath) {
  const parent = path.posix.dirname(filePath);
  if (parent && parent !== ".") await ensureDirectories(adapter, parent);
}

async function ensureDirectories(adapter, dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const stat = await adapterStat(adapter, current);
    if (!stat) await adapter.mkdir(current);
    else if (stat.type !== "folder") throw fsError("ENOTDIR", current);
  }
}

async function recoverReplacementTree(adapter, dirPath) {
  const listing = await adapter.list(dirPath);
  for (const folder of listing.folders || []) await recoverReplacementTree(adapter, folder);
  for (const file of listing.files || []) {
    if (!file.endsWith(REPLACEMENT_BACKUP_SUFFIX)) continue;
    const destination = file.slice(0, -REPLACEMENT_BACKUP_SUFFIX.length);
    if (await adapterStat(adapter, destination)) await adapter.remove(file);
    else await adapter.rename(file, destination);
  }
}

function adapterPath(filePath) {
  if (typeof filePath !== "string") throw fsError("EINVAL", String(filePath));
  const unix = filePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(unix).replace(/^\/+/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../") || unix.includes("\0")) {
    throw fsError("EINVAL", filePath);
  }
  return normalized;
}

async function translateError(adapter, normalized, error, fallbackCode) {
  if (error && typeof error.code === "string") return error;
  try {
    if (!await adapterStat(adapter, normalized)) return fsError("ENOENT", normalized);
  } catch (statError) {
    return fsError(fallbackCode, normalized, statError);
  }
  return fsError(fallbackCode, normalized, error);
}

function fsError(code, filePath, cause) {
  const error = new Error(`${code}: ${filePath}`);
  error.code = code;
  error.path = filePath;
  if (cause) error.cause = cause;
  return error;
}

function toArrayBuffer(data) {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function createPackIndexFs(fs, packfile, observer = undefined) {
  const pack = Buffer.from(packfile);
  let packReadPending = true;
  const observe = (event) => {
    try {
      if (typeof observer === "function") observer(event);
    } catch {
      // Diagnostics must not alter filesystem behavior.
    }
  };
  const observedCall = async (point, fn) => {
    try {
      const value = await fn();
      observe({ point, outcome: "returned", valueKind: diagnosticValueKind(value), sizeBucket: diagnosticSizeBucket(value), errorCode: "none" });
      return value;
    } catch (error) {
      observe({ point, outcome: "failed", valueKind: "unknown", sizeBucket: "unknown", errorCode: diagnosticIoCode(error) });
      throw error;
    }
  };
  return {
    // Skip isomorphic-git's generic fs wrapper, which converts every read error to null.
    _original_unwrapped_fs: fs,
    async _stat(filePath, options) {
      return await observedCall("index_fs_stat", () => fs.promises.stat(filePath, options));
    },
    async _readFile(filePath, options) {
      return await observedCall("index_fs_read_file", () => fs.promises.readFile(filePath, options));
    },
    async read(filePath, options) {
      if (packReadPending) {
        packReadPending = false;
        observe({ point: "index_fs_read", outcome: "returned", valueKind: "buffer", sizeBucket: diagnosticSizeBucket(pack), errorCode: "none" });
        return pack;
      }
      try {
        const value = await fs.promises.readFile(filePath, options);
        observe({ point: "index_fs_read", outcome: "returned", valueKind: diagnosticValueKind(value), sizeBucket: diagnosticSizeBucket(value), errorCode: "none" });
        return value;
      } catch (error) {
        observe({ point: "index_fs_read", outcome: "failed", valueKind: "null", sizeBucket: "unknown", errorCode: diagnosticIoCode(error) });
        return null;
      }
    },
    async write(filePath, data, options) {
      observe({ point: "index_fs_write", outcome: "started", valueKind: diagnosticValueKind(data), sizeBucket: diagnosticSizeBucket(data), errorCode: "none" });
      try {
        await fs.promises.writeFile(filePath, data, options);
        observe({ point: "index_fs_write", outcome: "succeeded", valueKind: diagnosticValueKind(data), sizeBucket: diagnosticSizeBucket(data), errorCode: "none" });
      } catch (error) {
        observe({ point: "index_fs_write", outcome: "failed", valueKind: diagnosticValueKind(data), sizeBucket: diagnosticSizeBucket(data), errorCode: diagnosticIoCode(error) });
        throw error;
      }
    }
  };
}

function diagnosticValueKind(value) {
  if (value === null || value === undefined) return "null";
  if (Buffer.isBuffer(value)) return "buffer";
  if (value instanceof Uint8Array) return "uint8array";
  if (value instanceof ArrayBuffer) return "arraybuffer";
  if (typeof value === "string") return "string";
  return "other";
}

function diagnosticSizeBucket(value) {
  const size = typeof value === "string" ? value.length : value && typeof value.byteLength === "number" ? value.byteLength : null;
  if (size === null) return "unknown";
  if (size === 0) return "empty";
  if (size < 64 * 1024) return "under_64k";
  if (size < 1024 * 1024) return "under_1m";
  if (size < 16 * 1024 * 1024) return "under_16m";
  if (size < 64 * 1024 * 1024) return "under_64m";
  return "over_64m";
}

function diagnosticIoCode(error) {
  const code = error && typeof error.code === "string" ? error.code.toLowerCase() : "unknown";
  return new Set(["enoent", "eexist", "eisdir", "enotdir", "enotempty", "eacces", "eperm", "eio"]).has(code)
    ? code
    : "unknown";
}

function createReadOverlayFs(fs, files) {
  const overrides = new Map([...files].map(([filePath, data]) => [adapterPath(filePath), Buffer.from(data)]));
  return {
    setReadOverlay(filePath, data) {
      overrides.set(adapterPath(filePath), Buffer.from(data));
    },
    deleteReadOverlay(filePath) {
      overrides.delete(adapterPath(filePath));
    },
    promises: {
      ...fs.promises,
      async readFile(filePath, options) {
        const override = overrides.get(adapterPath(filePath));
        if (override) {
          const encoding = typeof options === "string" ? options : options && options.encoding;
          return encoding ? override.toString(encoding) : Buffer.from(override);
        }
        return await fs.promises.readFile(filePath, options);
      }
    }
  };
}

module.exports = { createDataAdapterFs, createPackIndexFs, createReadOverlayFs, adapterPath };
