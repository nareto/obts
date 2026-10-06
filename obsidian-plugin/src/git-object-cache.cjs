// Shares isomorphic-git's object cache across calls made with one client fs.
//
// Without a caller-supplied cache, isomorphic-git starts every command with an
// empty cache: each packed object read re-parses pack indexes until it finds
// the object, then reads and SHA-1 verifies the whole pack. Sharing one cache
// keeps parsed indexes across commands. Memory stays bounded:
// - decompressed delta bases (offsetCache) are dropped after every command;
// - pack buffers are trimmed to a byte budget whenever no command is running,
//   and a dropped pack is verified again when it is next read;
// - if concurrent commands keep the cache busy past a ceiling, or a command
//   fails for a reason other than a missing object, later commands start a
//   fresh cache and the old one is released once its commands finish.

const CACHED_COMMANDS = [
  "readCommit",
  "readTree",
  "readBlob",
  "readObject",
  "readTag",
  "isDescendent",
  "findMergeBase",
  "packObjects",
  "walk",
  "log"
];

const PENDING = Symbol("pending");

function settledValue(promise) {
  return Promise.race([promise, Promise.resolve(PENDING)]);
}

function packfileCacheOf(cache) {
  for (const symbol of Object.getOwnPropertySymbols(cache)) {
    if (symbol.description === "PackfileCache" && cache[symbol] instanceof Map) return cache[symbol];
  }
  return null;
}

function clearOffsetCache(index) {
  for (const _ in index.offsetCache) {
    index.offsetCache = {};
    return;
  }
}

function baseName(filePath) {
  const value = String(filePath);
  return value.slice(value.lastIndexOf("/") + 1);
}

function createGitObjectCache(options = {}) {
  const retainBytes = Number.isFinite(options.maxRetainedPackBytes) ? Math.max(0, options.maxRetainedPackBytes) : 0;
  const busyBytes = Number.isFinite(options.maxBusyPackBytes)
    ? Math.max(retainBytes, options.maxBusyPackBytes)
    : Math.max(2 * retainBytes, 16 * 1024 * 1024);
  const packSizes = new WeakMap();
  let current = newEpoch();
  let epochs = 0;
  let maintenance = null;
  let maintenanceRequested = false;

  function newEpoch() {
    return { cache: {}, inFlight: 0, known: new Map(), retained: [] };
  }

  function rotate() {
    current = newEpoch();
    epochs += 1;
  }

  async function refreshKnown(epoch, packMap) {
    for (const [key, entry] of [...packMap]) {
      const known = epoch.known.get(key);
      if (known && known.entry === entry) continue;
      let index;
      try {
        index = await settledValue(entry);
      } catch {
        index = null;
      }
      if (index === PENDING || packMap.get(key) !== entry) continue;
      if (!index || typeof index !== "object" || !(index.offsets instanceof Map)) {
        packMap.delete(key);
        epoch.known.delete(key);
        continue;
      }
      epoch.known.set(key, { entry, index });
    }
    for (const key of [...epoch.known.keys()]) if (!packMap.has(key)) epoch.known.delete(key);
  }

  async function loadedPacks(epoch) {
    const loaded = [];
    for (const { index } of epoch.known.values()) {
      const pack = index.pack;
      if (!pack) continue;
      if (typeof pack !== "object" && typeof pack !== "function") {
        loaded.push({ index, pack, bytes: Number.POSITIVE_INFINITY });
        continue;
      }
      if (!packSizes.has(pack)) {
        let value;
        try {
          value = await settledValue(pack);
        } catch {
          value = null;
        }
        if (value === PENDING) continue;
        packSizes.set(pack, value && typeof value.byteLength === "number" ? value.byteLength : Number.POSITIVE_INFINITY);
      }
      loaded.push({ index, pack, bytes: packSizes.get(pack) });
    }
    return loaded;
  }

  async function maintain() {
    const epoch = current;
    const packMap = packfileCacheOf(epoch.cache);
    if (!packMap) {
      if (Object.getOwnPropertySymbols(epoch.cache).length > 0 && epoch.inFlight === 0) rotate();
      return;
    }
    await refreshKnown(epoch, packMap);
    const loaded = await loadedPacks(epoch);
    if (epoch !== current) return;
    for (const { index } of epoch.known.values()) clearOffsetCache(index);
    const live = loaded.filter((entry) => entry.index.pack === entry.pack);
    if (epoch.inFlight > 0) {
      if (live.reduce((total, entry) => total + entry.bytes, 0) > busyBytes) rotate();
      return;
    }
    const byIndex = new Map(live.map((entry) => [entry.index, entry]));
    const previous = new Set(epoch.retained);
    const ordered = [
      ...live.filter((entry) => !previous.has(entry.index)),
      ...epoch.retained.map((index) => byIndex.get(index)).filter(Boolean)
    ];
    let total = 0;
    const keep = [];
    for (const entry of ordered) {
      if (total + entry.bytes <= retainBytes) {
        total += entry.bytes;
        keep.push(entry.index);
      } else {
        entry.index.pack = null;
        entry.index._checksumVerified = false;
      }
    }
    epoch.retained = keep;
  }

  function requestMaintenance() {
    maintenanceRequested = true;
    if (maintenance) return maintenance;
    maintenance = (async () => {
      while (maintenanceRequested) {
        maintenanceRequested = false;
        try {
          await maintain();
        } catch {
          rotate();
        }
      }
    })().finally(() => {
      maintenance = null;
      if (maintenanceRequested) requestMaintenance();
    });
    return maintenance;
  }

  return {
    async run(command, args) {
      const epoch = current;
      epoch.inFlight += 1;
      let failure = null;
      try {
        return await command({ ...args, cache: epoch.cache });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        epoch.inFlight -= 1;
        if (failure && failure.code !== "NotFoundError" && epoch === current) rotate();
        await requestMaintenance();
      }
    },
    reset() {
      rotate();
    },
    forget(filePath) {
      const packMap = packfileCacheOf(current.cache);
      if (!packMap) return;
      const name = baseName(filePath).replace(/\.pack$/u, ".idx");
      for (const key of [...packMap.keys()]) {
        if (baseName(key) === name) {
          packMap.delete(key);
          current.known.delete(key);
        }
      }
    },
    stats() {
      const packMap = packfileCacheOf(current.cache);
      let retainedPacks = 0;
      let cachedObjects = 0;
      for (const { index } of current.known.values()) {
        if (index.pack) retainedPacks += 1;
        cachedObjects += Object.keys(index.offsetCache || {}).length;
      }
      return { epoch: epochs, indexes: packMap ? packMap.size : 0, retainedPacks, cachedObjects, inFlight: current.inFlight };
    }
  };
}

function withGitObjectCaches(git, cacheForFs) {
  const wrapped = {};
  for (const key of Object.keys(git)) wrapped[key] = git[key];
  for (const command of CACHED_COMMANDS) {
    if (typeof git[command] !== "function") continue;
    wrapped[command] = (args) => {
      const objectCache = args && !args.cache && args.fs ? cacheForFs(args.fs) : null;
      return objectCache ? objectCache.run(git[command], args) : git[command](args);
    };
  }
  return wrapped;
}

module.exports = { createGitObjectCache, withGitObjectCaches, CACHED_COMMANDS };
