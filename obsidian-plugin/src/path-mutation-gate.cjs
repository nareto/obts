// Same-instance adapter exclusion. Raw filesystem writers remain outside this boundary.
const MARKER = Symbol.for("obts.pathMutationGate.wrapper");
const REGISTRY = Symbol.for("obts.pathMutationGate.registry");
const METHODS = ["write", "writeBinary", "append", "appendBinary", "process", "mkdir", "remove", "rmdir", "rename", "copy", "trashLocal", "trashSystem", "writeBinaryExclusive"];

function normalize(value) {
  const segments = [];
  for (const segment of String(value).replace(/\\/g, "/").normalize("NFC").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function footprint(paths) {
  return [...new Set(paths.map(normalize)
    .filter((key) => key !== ".obts" && !key.startsWith(".obts/"))
    .map((key) => key.toLowerCase()))];
}

function conflicts(left, right) {
  return left.some((a) => right.some((b) => !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function createGate(adapter, registry) {
  const active = new Set();
  const pending = [];
  const owners = new Set();
  const captures = new Map();
  const raw = Object.create(null);
  // Reads keep the adapter receiver too, but never acquire a mutation claim.
  for (const method of ["read", "readBinary", "stat", "exists", "list"]) {
    if (typeof adapter[method] === "function") raw[method] = adapter[method].bind(adapter);
  }
  const ready = Promise.resolve(adapter.promise).catch(() => undefined);
  let retiring = false;
  let admitted = 0;

  function finishRetirement() {
    if (!retiring || owners.size || admitted || active.size || pending.length) return;
    for (const [method, capture] of captures) {
      capture.enabled = false;
      if (adapter[method] !== capture.wrapper) continue;
      if (capture.descriptor) Object.defineProperty(adapter, method, capture.descriptor);
      else delete adapter[method];
    }
    if (registry.get(adapter) === gate) registry.delete(adapter);
  }

  function pump() {
    for (let index = 0; index < pending.length;) {
      const claim = pending[index];
      // An earlier conflicting waiter reserves its entire footprint. Independent
      // siblings can pass it; no claim ever holds only half its endpoints.
      if ([...active].some((other) => conflicts(claim.keys, other.keys)) ||
          pending.slice(0, index).some((other) => conflicts(claim.keys, other.keys))) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      active.add(claim);
      claim.resolve(() => {
        active.delete(claim);
        pump();
        finishRetirement();
      });
    }
  }

  async function withExclusive(paths, operation) {
    admitted += 1;
    let release = () => {};
    try {
      await ready;
      const keys = footprint(paths);
      if (keys.length) release = await new Promise((resolve) => {
        pending.push({ keys, resolve });
        pump();
      });
      return await operation(raw);
    } finally {
      release();
      admitted -= 1;
      finishRetirement();
    }
  }

  const gate = {
    raw, ready, withExclusive,
    acquire(owner) {
      const token = { owner };
      owners.add(token);
      retiring = false;
      let released = false;
      return {
        raw, ready, withExclusive,
        release() {
          if (released) return;
          released = true;
          owners.delete(token);
          retiring = owners.size === 0;
          finishRetirement();
        }
      };
    }
  };
  for (const method of METHODS) {
    let original = adapter[method];
    if (typeof original !== "function") continue;
    // An orphan under another plugin's wrapper may survive a reload. Unwrap
    // only our directly marked functions; never call one as the raw capability.
    while (original[MARKER]) original = original[MARKER].original;
    raw[method] = original.bind(adapter);
    const capture = { original, descriptor: Object.getOwnPropertyDescriptor(adapter, method), enabled: true, wrapper: null };
    capture.wrapper = function (...args) {
      const receiver = this;
      if (!capture.enabled) return original.apply(receiver, args);
      const paths = method === "rename" || method === "copy" ? args.slice(0, 2) : args.slice(0, 1);
      return withExclusive(paths, () => original.apply(receiver, args));
    };
    Object.defineProperty(capture.wrapper, MARKER, { value: capture });
    Object.defineProperty(adapter, method, { configurable: true, writable: true, enumerable: capture.descriptor?.enumerable ?? true, value: capture.wrapper });
    captures.set(method, capture);
  }
  return gate;
}

function installPathMutationGate(adapter, owner = {}) {
  const registry = globalThis[REGISTRY] || (globalThis[REGISTRY] = new WeakMap());
  let gate = registry.get(adapter);
  if (!gate) {
    gate = createGate(adapter, registry);
    registry.set(adapter, gate);
  }
  return gate.acquire(owner);
}

module.exports = { installPathMutationGate };
