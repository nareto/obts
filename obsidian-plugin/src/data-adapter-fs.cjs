const { Buffer } = require("buffer");
const path = require("path-browserify");

const REPLACEMENT_BACKUP_SUFFIX = ".obts-replace-backup";
const adapterPathQueues = new WeakMap();

async function withAdapterPathLocks(adapter, paths, operation) {
  let queues = adapterPathQueues.get(adapter);
  if (!queues) {
    queues = new Map();
    adapterPathQueues.set(adapter, queues);
  }
  const keys = [...new Set(paths.map(adapterPath))].sort();
  const priors = keys.map((key) => queues.get(key) || Promise.resolve());
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tails = keys.map((key, index) => priors[index].then(() => current));
  keys.forEach((key, index) => queues.set(key, tails[index]));
  await Promise.all(priors);
  try {
    return await operation();
  } finally {
    release();
    keys.forEach((key, index) => {
      if (queues.get(key) === tails[index]) queues.delete(key);
    });
  }
}

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
      const bytes = typeof data === "string" ? Buffer.from(data, options.encoding || "utf8") : Buffer.from(data);
      await withAdapterPathLocks(adapter, [normalized], async () => {
        if (flag === "wx" && await adapterStat(adapter, normalized)) {
          throw fsError("EEXIST", normalized);
        }
        await ensureParentDirectories(adapter, normalized);
        try {
          await adapter.writeBinary(normalized, toArrayBuffer(bytes));
        } catch (error) {
          throw await translateError(adapter, normalized, error, "EIO");
        }
      });
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
      await withAdapterPathLocks(adapter, [source, destination], async () => {
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

        const backup = `${destination}${REPLACEMENT_BACKUP_SUFFIX}-${randomSuffix()}`;
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
      });
    },

    async copyFile(sourcePath, destinationPath) {
      const data = await promises.readFile(sourcePath);
      await promises.writeFile(destinationPath, data);
    },

    async recoverReplacements(rootPath = "/.obts", options = {}) {
      const root = adapterPath(rootPath);
      if (!await adapterStat(adapter, root)) return;
      const maxDepth = Number.isInteger(options.maxDepth) ? Math.max(0, options.maxDepth) : Number.POSITIVE_INFINITY;
      await recoverReplacementTree(adapter, root, 0, maxDepth, options.signal);
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

async function recoverReplacementTree(adapter, dirPath, depth, maxDepth, signal) {
  throwIfAborted(signal);
  const listing = await adapter.list(dirPath);
  throwIfAborted(signal);
  if (depth < maxDepth) {
    for (const folder of listing.folders || []) {
      await recoverReplacementTree(adapter, folder, depth + 1, maxDepth, signal);
    }
  }
  for (const file of listing.files || []) {
    throwIfAborted(signal);
    const marker = file.lastIndexOf(REPLACEMENT_BACKUP_SUFFIX);
    if (marker >= 0) {
      const suffix = file.slice(marker + REPLACEMENT_BACKUP_SUFFIX.length);
      if (suffix === "" || /^-[a-z0-9-]+$/u.test(suffix)) {
        const destination = file.slice(0, marker);
        await withAdapterPathLocks(adapter, [destination], async () => {
          if (await adapterStat(adapter, destination)) await adapter.remove(file);
          else await adapter.rename(file, destination);
        });
      }
      continue;
    }
    if (!/\/[a-z0-9-]+\.json\.tmp-[a-z0-9-]+$/u.test(file)) continue;
    try {
      JSON.parse(Buffer.from(await adapter.readBinary(file)).toString("utf8"));
      await adapter.remove(file);
    } catch {
      // Keep unknown or malformed files for manual recovery.
    }
  }
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return;
  throw Object.assign(new Error("Filesystem recovery was interrupted by plugin unload."), { code: "ABORT_ERR" });
}

function randomSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  const pack = Buffer.isBuffer(packfile) ? packfile : Buffer.from(packfile);
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

function createReadOverlayFs(fs, files, options = {}) {
  const overrides = new Map();
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : Number.POSITIVE_INFINITY;
  const cacheRead = typeof options.cacheRead === "function" ? options.cacheRead : () => false;
  const readAttempts = Number.isInteger(options.readAttempts) ? Math.max(1, options.readAttempts) : 1;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : 0;
  let overrideBytes = 0;

  const deleteReadOverlay = (filePath) => {
    const key = adapterPath(filePath);
    const existing = overrides.get(key);
    if (!existing) return;
    overrideBytes -= existing.byteLength;
    overrides.delete(key);
  };

  const setReadOverlay = (filePath, data) => {
    const key = adapterPath(filePath);
    deleteReadOverlay(key);
    if (maxBytes === 0 || (data && typeof data.byteLength === "number" && data.byteLength > maxBytes)) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.byteLength > maxBytes) return;
    while (overrideBytes + bytes.byteLength > maxBytes && overrides.size > 0) {
      deleteReadOverlay(overrides.keys().next().value);
    }
    overrides.set(key, bytes);
    overrideBytes += bytes.byteLength;
  };

  for (const [filePath, data] of files) setReadOverlay(filePath, data);

  return {
    setReadOverlay,
    deleteReadOverlay,
    promises: {
      ...fs.promises,
      async readFile(filePath, readOptions) {
        const key = adapterPath(filePath);
        const override = overrides.get(key);
        if (override) {
          overrides.delete(key);
          overrides.set(key, override);
          const encoding = typeof readOptions === "string" ? readOptions : readOptions && readOptions.encoding;
          return encoding ? override.toString(encoding) : override;
        }

        let value;
        let lastError;
        const attempts = cacheRead(key) ? readAttempts : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            value = await fs.promises.readFile(filePath, readOptions);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt + 1 < attempts && retryDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
          }
        }
        if (lastError) throw lastError;

        const encoding = typeof readOptions === "string" ? readOptions : readOptions && readOptions.encoding;
        if (cacheRead(key) && !encoding) setReadOverlay(key, value);
        return value;
      }
    }
  };
}

module.exports = { createDataAdapterFs, createPackIndexFs, createReadOverlayFs, adapterPath };
