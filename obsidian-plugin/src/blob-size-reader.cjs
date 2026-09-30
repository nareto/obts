const { Buffer } = require("buffer");
const path = require("path-browserify");
const { Inflate } = require("pako");

const READ_LIMIT = 256;
const COMPRESSED_LIMIT = 1024;
const OUTPUT_LIMIT = 256;
const MAX_DELTA_DEPTH = 32;

async function blobSizeFromGit(fsp, gitdir, oid) {
  if (typeof fsp.readFileRange !== "function" || !/^[0-9a-f]{40}$/u.test(oid)) return null;
  const read = async (file, position, length) => {
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || length > READ_LIMIT) throw new Error("Invalid object range");
    return Buffer.from(await fsp.readFileRange(file, position, length));
  };
  const parseVarint = (bytes, start) => {
    let value = 0;
    let shift = 0;
    for (let index = start; index < bytes.length && index < start + 10; index += 1) {
      const part = bytes[index] & 127;
      value += part * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw new Error("Object size overflow");
      if (!(bytes[index] & 128)) return [value, index + 1];
      shift += 7;
    }
    throw new Error("Truncated object size");
  };
  const inflatePrefix = async (file, position, parse) => {
    const inflater = new Inflate({ chunkSize: OUTPUT_LIMIT });
    const chunks = [];
    const stop = {};
    inflater.onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      throw stop;
    };
    for (let total = 0; total < COMPRESSED_LIMIT; total += 64) {
      const chunk = await read(file, position + total, 64);
      if (!chunk.length) throw new Error("Truncated compressed object");
      let stopped = false;
      try {
        if (!inflater.push(chunk, false) || inflater.err) throw new Error("Corrupt compressed object");
      } catch (error) {
        if (error !== stop) throw error;
        stopped = true;
      }
      const partial = stopped || inflater.ended || inflater.strm.avail_out === 0
        ? Buffer.alloc(0) : Buffer.from(inflater.strm.output || []).subarray(0, inflater.strm.next_out || 0);
      const output = Buffer.concat([...chunks, partial]);
      const result = parse(output);
      if (result !== null) return result;
      if (inflater.ended) throw new Error("Truncated object header");
      if (stopped || output.length >= OUTPUT_LIMIT || chunk.length < 64) throw new Error("Object header too long");
    }
    throw new Error("Compressed object header too long");
  };
  const loose = async (objectOid) => {
    const file = path.join(gitdir, "objects", objectOid.slice(0, 2), objectOid.slice(2));
    try {
      return await inflatePrefix(file, 0, (bytes) => {
        const end = bytes.indexOf(0);
        if (end < 0) return null;
        const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/u.exec(bytes.subarray(0, end).toString("ascii"));
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid loose object header");
        return { type: match[1], size: Number(match[2]) };
      });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const indexes = await fsp.readdir(path.join(gitdir, "objects", "pack")).catch(() => []);
  const locate = async (objectOid) => {
    const needle = Buffer.from(objectOid, "hex");
    for (const name of indexes.filter((value) => value.endsWith(".idx"))) {
      const indexFile = path.join(gitdir, "objects", "pack", name);
      const header = await read(indexFile, 0, 8);
      if (header.length !== 8 || header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2) throw new Error("Invalid pack index");
      const firstBytes = needle[0] === 0 ? null : await read(indexFile, 8 + (needle[0] - 1) * 4, 4);
      const lastBytes = await read(indexFile, 8 + needle[0] * 4, 4);
      if (lastBytes.length !== 4 || (firstBytes && firstBytes.length !== 4)) throw new Error("Truncated pack fanout");
      const first = firstBytes ? firstBytes.readUInt32BE(0) : 0;
      const last = lastBytes.readUInt32BE(0);
      const countBytes = await read(indexFile, 8 + 255 * 4, 4);
      if (countBytes.length !== 4 || last < first) throw new Error("Invalid pack fanout");
      const count = countBytes.readUInt32BE(0);
      let low = first;
      let high = last;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = await read(indexFile, 8 + 1024 + middle * 20, 20);
        if (candidate.length !== 20) throw new Error("Truncated pack index");
        if (Buffer.compare(candidate, needle) < 0) low = middle + 1;
        else high = middle;
      }
      if (low >= last) continue;
      const candidate = await read(indexFile, 8 + 1024 + low * 20, 20);
      if (!candidate.equals(needle)) continue;
      const offsets = 8 + 1024 + count * 24;
      const offsetBytes = await read(indexFile, offsets + low * 4, 4);
      if (offsetBytes.length !== 4) throw new Error("Truncated pack offset");
      const offsetValue = offsetBytes.readUInt32BE(0);
      let offset = offsetValue;
      if (offsetValue & 0x80000000) {
        const large = await read(indexFile, offsets + count * 4 + (offsetValue & 0x7fffffff) * 8, 8);
        if (large.length !== 8) throw new Error("Truncated large pack offset");
        offset = Number(large.readBigUInt64BE(0));
      }
      if (!Number.isSafeInteger(offset) || offset < 12) throw new Error("Invalid pack offset");
      return { file: path.join(gitdir, "objects", "pack", name.slice(0, -4) + ".pack"), offset };
    }
    return null;
  };
  const resolve = async (objectOid, depth = 0, packed = null) => {
    if (depth > MAX_DELTA_DEPTH) throw new Error("Pack delta chain too deep");
    if (!packed) {
      const value = await loose(objectOid);
      if (value) return value;
      packed = await locate(objectOid);
      if (!packed) throw new Error("Missing object");
    }
    const packHeader = await read(packed.file, 0, 12);
    if (packHeader.length !== 12 || packHeader.toString("ascii", 0, 4) !== "PACK" ||
        ![2, 3].includes(packHeader.readUInt32BE(4))) throw new Error("Invalid pack header");
    const header = await read(packed.file, packed.offset, 128);
    if (!header.length) throw new Error("Truncated pack entry");
    const type = (header[0] >> 4) & 7;
    let size = header[0] & 15;
    let shift = 4;
    let cursor = 1;
    let byte = header[0];
    while (byte & 128) {
      if (cursor >= header.length || shift > 52) throw new Error("Invalid pack entry header");
      byte = header[cursor++];
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    if (!Number.isSafeInteger(size)) throw new Error("Invalid pack entry size");
    if (type >= 1 && type <= 4) return { type: [null, "commit", "tree", "blob", "tag"][type], size };
    let base;
    if (type === 6) {
      if (cursor >= header.length) throw new Error("Truncated delta base");
      byte = header[cursor++];
      let distance = byte & 127;
      while (byte & 128) {
        if (cursor >= header.length || !Number.isSafeInteger(distance)) throw new Error("Invalid delta base");
        byte = header[cursor++];
        distance = ((distance + 1) * 128) + (byte & 127);
      }
      if (!Number.isSafeInteger(distance) || distance <= 0 || distance >= packed.offset) throw new Error("Invalid delta offset");
      base = await resolve(null, depth + 1, { file: packed.file, offset: packed.offset - distance });
    } else if (type === 7) {
      if (cursor + 20 > header.length) throw new Error("Truncated delta reference");
      base = await resolve(header.subarray(cursor, cursor + 20).toString("hex"), depth + 1);
      cursor += 20;
    } else throw new Error("Invalid pack object type");
    if (base.type !== "blob") throw new Error("Delta base is not a blob");
    const resultSize = await inflatePrefix(packed.file, packed.offset + cursor, (bytes) => {
      try {
        const [baseSize, firstEnd] = parseVarint(bytes, 0);
        const [result, secondEnd] = parseVarint(bytes, firstEnd);
        if (secondEnd > bytes.length) return null;
        if (baseSize !== base.size) throw new Error("Invalid delta base size");
        return result;
      } catch (error) {
        if (error.message === "Truncated object size") return null;
        throw error;
      }
    });
    return { type: base.type, size: resultSize };
  };
  try {
    const result = await resolve(oid);
    return result.type === "blob" && Number.isSafeInteger(result.size) && result.size >= 0 ? result.size : null;
  } catch {
    return null;
  }
}

module.exports = { blobSizeFromGit };
