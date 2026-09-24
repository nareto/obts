const createIgnore = require("ignore");

const MAX_ROOT_IGNORE_BYTES = 1024 * 1024;

class RootIgnorePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RootIgnorePolicyError";
    this.code = code;
  }
}

function createRootIgnorePolicy(bytes) {
  if (bytes !== null && bytes !== undefined && !(bytes instanceof Uint8Array)) {
    throw new RootIgnorePolicyError("invalid_policy", "Root .gitignore must be bytes or absent.");
  }
  if (bytes && bytes.byteLength > MAX_ROOT_IGNORE_BYTES) {
    throw new RootIgnorePolicyError("policy_too_large", "Root .gitignore exceeds the byte limit.");
  }
  let contents = "";
  if (bytes) {
    try {
      contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new RootIgnorePolicyError("invalid_policy_encoding", "Root .gitignore must be valid UTF-8.");
    }
    if (contents.includes("\0")) {
      throw new RootIgnorePolicyError("invalid_policy_nul", "Root .gitignore cannot contain NUL bytes.");
    }
  }
  const matcher = createIgnore({ ignorecase: false }).add(contents);
  return Object.freeze({
    ignores(path, isDirectory = false) {
      if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
          path.includes("\0") || path.endsWith("/") ||
          path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new RootIgnorePolicyError("invalid_path", "Expected a relative canonical vault path.");
      }
      const normalized = path.normalize("NFC");
      if (normalized === ".gitignore") return false;
      return matcher.ignores(normalized + (isDirectory ? "/" : ""));
    }
  });
}

module.exports = { createRootIgnorePolicy, RootIgnorePolicyError, MAX_ROOT_IGNORE_BYTES };
