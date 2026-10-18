"use strict";

// OBTS-SYNC-NAME-001: one versioned rule shared by plugin and server.
const NAME_RESTRICTION_RULE_VERSION = 1;
const RESTRICTED_NAME_PLATFORMS = Object.freeze(["android"]);
const RESERVED_NAME_CHARACTERS = /["*:<>?\\|\u0000-\u001f\u007f]/u;

function isRestrictedNamePlatform(platform) {
  return typeof platform === "string" && RESTRICTED_NAME_PLATFORMS.includes(platform);
}

function segmentHasReservedCharacters(segment) {
  return RESERVED_NAME_CHARACTERS.test(segment);
}

function foldPathCase(path) {
  return path.normalize("NFC").toLowerCase();
}

function pathPrefixes(path) {
  const segments = path.split("/");
  const prefixes = [];
  for (let index = 1; index <= segments.length; index += 1) prefixes.push(segments.slice(0, index).join("/"));
  return prefixes;
}

/**
 * Returns every file or explicit directory path a restricted platform cannot
 * store, with its reasons, sorted by path. A path collides when it or any of
 * its prefixes differs only by letter case from another canonical node.
 */
function findUnportablePaths(files, directories = []) {
  const kinds = new Map();
  for (const path of directories) if (typeof path === "string" && path) kinds.set(path, "directory");
  for (const path of files) if (typeof path === "string" && path) kinds.set(path, "file");
  const spellings = new Map();
  for (const path of kinds.keys()) {
    for (const prefix of pathPrefixes(path)) {
      const key = foldPathCase(prefix);
      let set = spellings.get(key);
      if (!set) spellings.set(key, set = new Set());
      set.add(prefix);
    }
  }
  const result = [];
  for (const [path, kind] of kinds) {
    const reasons = [];
    if (path.split("/").some(segmentHasReservedCharacters)) reasons.push("reserved_characters");
    if (pathPrefixes(path).some((prefix) => spellings.get(foldPathCase(prefix)).size > 1)) reasons.push("case_collision");
    if (reasons.length > 0) result.push({ path, kind, reasons });
  }
  return result.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

module.exports = {
  NAME_RESTRICTION_RULE_VERSION,
  RESTRICTED_NAME_PLATFORMS,
  isRestrictedNamePlatform,
  segmentHasReservedCharacters,
  foldPathCase,
  findUnportablePaths
};
