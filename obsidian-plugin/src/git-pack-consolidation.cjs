const { Buffer } = require("buffer");
const path = require("path-browserify");
const createSha = require("sha.js");

const PACK_SIGNATURE = Buffer.from("PACK");
const IDX_SIGNATURE = Buffer.from([0xff, 0x74, 0x4f, 0x63]);
const CONSOLIDATED_PREFIX = "obts-pack-";
const JOURNAL_VERSION = 1;

const DEFAULT_POLICY = Object.freeze({
  triggerPackCount: 24,
  maxPackBytes: 8 * 1024 * 1024,
  maxSources: 256,
  factor: 2
});

class PackVerificationError extends Error {
  constructor(code) {
    super(`Git pack verification failed: ${code}.`);
    this.name = "PackVerificationError";
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function sha1(bytes) {
  return createSha("sha1").update(bytes).digest();
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function parsePackIndex(value) {
  const idx = asBuffer(value);
  if (idx.length < 8 + 1024 + 40 || !idx.subarray(0, 4).equals(IDX_SIGNATURE) || idx.readUInt32BE(4) !== 2) {
    throw new PackVerificationError("idx_header");
  }
  const count = idx.readUInt32BE(8 + 255 * 4);
  const oidStart = 8 + 1024;
  const crcStart = oidStart + count * 20;
  const offsetStart = crcStart + count * 4;
  const trailerStart = offsetStart + count * 4;
  if (idx.length !== trailerStart + 40) throw new PackVerificationError("idx_length");
  if (!sha1(idx.subarray(0, idx.length - 20)).equals(idx.subarray(idx.length - 20))) {
    throw new PackVerificationError("idx_checksum");
  }
  const entries = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const oid = idx.subarray(oidStart + index * 20, oidStart + index * 20 + 20);
    if (index > 0 && Buffer.compare(entries[index - 1].oid, oid) > 0) throw new PackVerificationError("idx_order");
    const offset = idx.readUInt32BE(offsetStart + index * 4);
    if (offset & 0x80000000) throw new PackVerificationError("idx_large_offset");
    entries[index] = { oid, crc: idx.readUInt32BE(crcStart + index * 4), offset };
  }
  let cursor = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    while (cursor < count && entries[cursor].oid[0] <= byte) cursor += 1;
    if (idx.readUInt32BE(8 + byte * 4) !== cursor) throw new PackVerificationError("idx_fanout");
  }
  return { entries, packChecksum: idx.subarray(trailerStart, trailerStart + 20) };
}

function verifyPack(packValue, index) {
  const pack = asBuffer(packValue);
  if (pack.length < 32 || !pack.subarray(0, 4).equals(PACK_SIGNATURE)) throw new PackVerificationError("pack_header");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackVerificationError("pack_version");
  if (pack.readUInt32BE(8) !== index.entries.length) throw new PackVerificationError("pack_object_count");
  const trailer = pack.subarray(pack.length - 20);
  if (!trailer.equals(index.packChecksum) || !sha1(pack.subarray(0, pack.length - 20)).equals(trailer)) {
    throw new PackVerificationError("pack_checksum");
  }
  const byOffset = index.entries.slice().sort((left, right) => left.offset - right.offset);
  const oidAtOffset = new Map(byOffset.map((entry) => [entry.offset, entry.oid]));
  const contained = new Set(byOffset.map((entry) => entry.oid.toString("hex")));
  const objects = new Array(byOffset.length);
  for (let position = 0; position < byOffset.length; position += 1) {
    const start = byOffset[position].offset;
    const end = position + 1 < byOffset.length ? byOffset[position + 1].offset : pack.length - 20;
    if (start < 12 || end <= start || end > pack.length - 20 || (position === 0 && start !== 12)) {
      throw new PackVerificationError("pack_object_bounds");
    }
    if (crc32(pack.subarray(start, end)) !== byOffset[position].crc) throw new PackVerificationError("pack_object_crc");
    const header = readEntryHeader(pack, start, end);
    let baseOid = null;
    if (header.type === OFS_DELTA) {
      baseOid = oidAtOffset.get(header.baseOffset);
      if (!baseOid) throw new PackVerificationError("pack_delta_base");
    } else if (header.type === REF_DELTA) {
      baseOid = pack.subarray(header.payloadStart - 20, header.payloadStart);
      if (!contained.has(baseOid.toString("hex"))) throw new PackVerificationError("pack_thin");
    }
    objects[position] = { oid: byOffset[position].oid, crc: byOffset[position].crc, start, end, header, baseOid };
  }
  return { pack, objects };
}

const OFS_DELTA = 6;
const REF_DELTA = 7;

function readEntryHeader(pack, start, end) {
  let cursor = start;
  let byte = pack[cursor++];
  const type = (byte >> 4) & 7;
  if (type === 0 || type === 5) throw new PackVerificationError("pack_object_type");
  for (let continuation = 0; byte & 0x80; continuation += 1) {
    if (cursor >= end || continuation >= 9) throw new PackVerificationError("pack_object_header");
    byte = pack[cursor++];
  }
  const sizeEnd = cursor;
  let baseOffset = null;
  if (type === OFS_DELTA) {
    if (cursor >= end) throw new PackVerificationError("pack_object_header");
    byte = pack[cursor++];
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      if (cursor >= end || distance > 0xffffff) throw new PackVerificationError("pack_object_header");
      byte = pack[cursor++];
      distance = (distance + 1) * 128 + (byte & 0x7f);
    }
    if (distance <= 0 || distance > start - 12) throw new PackVerificationError("pack_delta_base");
    baseOffset = start - distance;
  } else if (type === REF_DELTA) {
    cursor += 20;
  }
  if (cursor >= end) throw new PackVerificationError("pack_object_header");
  return { type, sizeEnd, payloadStart: cursor, baseOffset };
}

function buildPackIndex(entries, packChecksum) {
  const count = entries.length;
  const idx = Buffer.alloc(8 + 1024 + count * 28 + 40);
  IDX_SIGNATURE.copy(idx, 0);
  idx.writeUInt32BE(2, 4);
  const fanout = new Uint32Array(256);
  for (const entry of entries) fanout[entry.oid[0]] += 1;
  let running = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    running += fanout[byte];
    idx.writeUInt32BE(running, 8 + byte * 4);
  }
  const oidStart = 8 + 1024;
  const crcStart = oidStart + count * 20;
  const offsetStart = crcStart + count * 4;
  entries.forEach((entry, index) => {
    entry.oid.copy(idx, oidStart + index * 20);
    idx.writeUInt32BE(entry.crc, crcStart + index * 4);
    idx.writeUInt32BE(entry.offset, offsetStart + index * 4);
  });
  packChecksum.copy(idx, offsetStart + count * 4);
  sha1(idx.subarray(0, idx.length - 20)).copy(idx, idx.length - 20);
  return idx;
}

function buildConsolidatedPack(sources) {
  const header = Buffer.alloc(12);
  PACK_SIGNATURE.copy(header, 0);
  header.writeUInt32BE(2, 4);
  const parts = [header];
  const entries = [];
  const emitted = new Set();
  let position = 12;
  for (const source of sources) {
    for (const object of source.verified.objects) {
      const key = object.oid.toString("hex");
      if (emitted.has(key)) continue;
      emitted.add(key);
      let bytes = source.verified.pack.subarray(object.start, object.end);
      let crc = object.crc;
      if (object.header.type === OFS_DELTA) {
        const typeAndSize = Buffer.from(bytes.subarray(0, object.header.sizeEnd - object.start));
        typeAndSize[0] = (typeAndSize[0] & 0x8f) | (REF_DELTA << 4);
        bytes = Buffer.concat([typeAndSize, object.baseOid, bytes.subarray(object.header.payloadStart - object.start)]);
        crc = crc32(bytes);
      }
      entries.push({ oid: object.oid, crc, offset: position });
      parts.push(bytes);
      position += bytes.length;
      if (position > 0x7fffffff) throw new PackVerificationError("consolidated_too_large");
    }
  }
  header.writeUInt32BE(entries.length, 8);
  const withoutTrailer = Buffer.concat(parts);
  const checksum = sha1(withoutTrailer);
  const pack = Buffer.concat([withoutTrailer, checksum]);
  entries.sort((left, right) => Buffer.compare(left.oid, right.oid));
  const idx = buildPackIndex(entries, checksum);
  return { name: `${CONSOLIDATED_PREFIX}${checksum.toString("hex")}`, pack, idx };
}

function selectConsolidationSources(packs, policy) {
  const sorted = packs
    .filter((pack) => pack.size <= policy.maxPackBytes)
    .sort((left, right) => left.size - right.size || left.name.localeCompare(right.name));
  if (sorted.length < 2) return [];
  let split = sorted.length - 1;
  for (; split > 0; split -= 1) {
    if (sorted[split].size < policy.factor * sorted[split - 1].size) break;
  }
  if (split > 0) split += 1;
  let total = 0;
  for (let index = 0; index < split; index += 1) total += sorted[index].size;
  while (split < sorted.length && sorted[split].size < policy.factor * total) {
    total += sorted[split].size;
    split += 1;
  }
  const selected = [];
  let selectedBytes = 0;
  for (const pack of sorted.slice(0, split)) {
    if (selected.length >= policy.maxSources || selectedBytes + pack.size > policy.maxPackBytes) break;
    selected.push(pack);
    selectedBytes += pack.size;
  }
  return selected.length >= 2 ? selected : [];
}

function isNotFound(error) {
  return Boolean(error && (error.code === "ENOENT" || error.code === "NotFoundError"));
}

function createPackConsolidator(options) {
  const { fsp, gitdir, journalPath } = options;
  const policy = Object.assign({}, DEFAULT_POLICY, options.policy || {});
  const beginPackChange = typeof options.beginPackChange === "function" ? options.beginPackChange : () => () => undefined;
  const onPackRemoved = typeof options.onPackRemoved === "function" ? options.onPackRemoved : () => undefined;
  const packDir = path.join(gitdir, "objects", "pack");
  const packPath = (name) => path.join(packDir, `${name}.pack`);
  const idxPath = (name) => path.join(packDir, `${name}.idx`);
  let settledPackSet = null;
  let scannedForOrphans = false;

  async function readOptional(filePath) {
    try {
      return asBuffer(await fsp.readFile(filePath));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function removeIfPresent(filePath) {
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async function writeVerified(filePath, bytes) {
    await fsp.writeFile(filePath, bytes, { mode: 0o600 });
    if (typeof fsp.syncFile === "function") await fsp.syncFile(filePath);
    const persisted = await readOptional(filePath);
    if (!persisted || !persisted.equals(bytes)) throw new PackVerificationError("persisted_bytes_mismatch");
  }

  async function writeAtomicVerified(filePath, bytes) {
    const temporaryPath = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await writeVerified(temporaryPath, bytes);
      await fsp.rename(temporaryPath, filePath);
    } catch (error) {
      await removeIfPresent(temporaryPath).catch(() => undefined);
      throw error;
    }
    if (typeof fsp.syncDirectory === "function") await fsp.syncDirectory(path.dirname(filePath));
    const persisted = await readOptional(filePath);
    if (!persisted || !persisted.equals(bytes)) throw new PackVerificationError("persisted_bytes_mismatch");
  }

  async function readJournal() {
    const bytes = await readOptional(journalPath);
    if (!bytes) return null;
    try {
      const journal = JSON.parse(bytes.toString("utf8"));
      const validName = (name) => typeof name === "string" && /^[A-Za-z0-9._-]+$/u.test(name) && !name.includes("..");
      if (journal && journal.version === JOURNAL_VERSION && validName(journal.pack) && journal.pack.startsWith(CONSOLIDATED_PREFIX) &&
          Array.isArray(journal.sources) && journal.sources.every(validName) && !journal.sources.includes(journal.pack)) {
        return journal;
      }
    } catch {
      // A journal is only ever published by atomic rename; unreadable content means it never authorized deletion.
    }
    return { invalid: true };
  }

  async function removeSources(sources, published = null) {
    const end = beginPackChange();
    const removed = [];
    try {
      for (const source of sources) {
        const sourceIdx = published ? await readOptional(idxPath(source)) : null;
        if (sourceIdx) {
          let contained = false;
          try {
            const sourceOids = parsePackIndex(sourceIdx).entries;
            contained = sourceOids.every((entry) => published.has(entry.oid.toString("hex")));
          } catch (error) {
            if (!(error instanceof PackVerificationError)) throw error;
          }
          if (!contained) continue;
        }
        await removeIfPresent(idxPath(source));
        await removeIfPresent(packPath(source));
        removed.push(source);
        onPackRemoved(packPath(source));
      }
    } finally {
      end();
    }
    if (removed.length && typeof fsp.syncDirectory === "function") await fsp.syncDirectory(packDir);
    return removed;
  }

  async function publishedOids(name) {
    const idx = await readOptional(idxPath(name));
    if (!idx) return null;
    const pack = await readOptional(packPath(name));
    if (!pack) return null;
    const index = parsePackIndex(idx);
    verifyPack(pack, index);
    return new Set(index.entries.map((entry) => entry.oid.toString("hex")));
  }

  async function allSourcesPresent(sources) {
    for (const source of sources) {
      if (!await readOptional(idxPath(source)) || !await readOptional(packPath(source))) return false;
    }
    return true;
  }

  async function recover() {
    const journal = await readJournal();
    if (journal && !journal.invalid) {
      let published = null;
      try {
        published = await publishedOids(journal.pack);
      } catch (error) {
        if (!(error instanceof PackVerificationError)) throw error;
      }
      if (published) {
        await removeSources(journal.sources, published);
      } else if (await allSourcesPresent(journal.sources)) {
        await removeIfPresent(idxPath(journal.pack));
        await removeIfPresent(packPath(journal.pack));
      } else {
        throw new PackVerificationError("recovery_blocked");
      }
    }
    if (journal) await removeIfPresent(journalPath);
    if (!journal && scannedForOrphans) return;
    scannedForOrphans = true;
    const journalTemporaryPrefix = `${path.basename(journalPath)}.tmp-`;
    let journalSiblings = [];
    try {
      journalSiblings = await fsp.readdir(path.dirname(journalPath));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    for (const name of journalSiblings) {
      if (name.startsWith(journalTemporaryPrefix)) await removeIfPresent(path.join(path.dirname(journalPath), name));
    }
    let names;
    try {
      names = await fsp.readdir(packDir);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const indexed = new Set(names.filter((name) => name.endsWith(".idx")).map((name) => name.slice(0, -4)));
    for (const name of names) {
      if (!name.startsWith(CONSOLIDATED_PREFIX)) continue;
      const orphanPack = name.endsWith(".pack") && !indexed.has(name.slice(0, -5));
      if (orphanPack || name.includes(".tmp-")) await removeIfPresent(path.join(packDir, name));
    }
  }

  let inFlight = null;
  function serialized(operation) {
    const current = (inFlight || Promise.resolve()).catch(() => undefined).then(operation);
    inFlight = current;
    return current.finally(() => {
      if (inFlight === current) inFlight = null;
    });
  }

  async function consolidate() {
    await recover();
    let names;
    try {
      names = (await fsp.readdir(packDir)).filter((name) => name.endsWith(".idx")).map((name) => name.slice(0, -4)).sort();
    } catch (error) {
      if (isNotFound(error)) return { status: "skipped", reason: "no_packs" };
      throw error;
    }
    if (names.length <= policy.triggerPackCount) return { status: "skipped", reason: "below_trigger" };
    const packSetKey = names.join("\n");
    if (settledPackSet === packSetKey) return { status: "skipped", reason: "settled" };

    const packs = [];
    for (const name of names) {
      try {
        packs.push({ name, size: (await fsp.stat(packPath(name))).size });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const sources = [];
    const rejected = [];
    for (const candidate of selectConsolidationSources(packs, policy)) {
      const [idx, pack] = [await readOptional(idxPath(candidate.name)), await readOptional(packPath(candidate.name))];
      try {
        if (!idx || !pack) throw new PackVerificationError("missing_pack_file");
        sources.push({ name: candidate.name, verified: verifyPack(pack, parsePackIndex(idx)) });
      } catch (error) {
        if (!(error instanceof PackVerificationError)) throw error;
        rejected.push(error.code);
      }
    }
    if (sources.length < 2) {
      settledPackSet = packSetKey;
      return { status: "skipped", reason: "no_candidates", rejected };
    }

    const consolidated = buildConsolidatedPack(sources);
    const consolidatedIndex = parsePackIndex(consolidated.idx);
    verifyPack(consolidated.pack, consolidatedIndex);
    const contained = new Set(consolidatedIndex.entries.map((entry) => entry.oid.toString("hex")));
    if (contained.size !== consolidatedIndex.entries.length) throw new PackVerificationError("consolidated_duplicate_object");
    for (const source of sources) {
      for (const object of source.verified.objects) {
        if (!contained.has(object.oid.toString("hex"))) throw new PackVerificationError("consolidated_missing_object");
      }
    }
    const sourceNames = sources.map((source) => source.name);
    sources.length = 0;
    if (sourceNames.includes(consolidated.name)) {
      settledPackSet = packSetKey;
      return { status: "skipped", reason: "no_candidates", rejected };
    }

    await writeAtomicVerified(journalPath, Buffer.from(`${JSON.stringify({ version: JOURNAL_VERSION, pack: consolidated.name, sources: sourceNames }, null, 2)}\n`));
    await writeVerified(packPath(consolidated.name), consolidated.pack);
    await writeAtomicVerified(idxPath(consolidated.name), consolidated.idx);
    const removed = await removeSources(sourceNames);
    await removeIfPresent(journalPath);
    settledPackSet = null;
    return {
      status: "consolidated",
      sources: sourceNames.length,
      removed: removed.length,
      objects: consolidatedIndex.entries.length,
      bytes: consolidated.pack.length,
      rejected
    };
  }

  return {
    run: () => serialized(consolidate),
    recover: () => serialized(recover)
  };
}

module.exports = {
  DEFAULT_PACK_CONSOLIDATION_POLICY: DEFAULT_POLICY,
  PackVerificationError,
  buildConsolidatedPack,
  createPackConsolidator,
  crc32,
  parsePackIndex,
  selectConsolidationSources,
  verifyPack
};
