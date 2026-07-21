class ByteBudget {
  constructor(maxBytes) {
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
    this.reservedBytes = 0;
    this.waiters = [];
  }

  async acquire(requestedBytes) {
    const bytes = Number.isFinite(requestedBytes) && requestedBytes > 0 ? Math.floor(requestedBytes) : 0;
    if (this.canAcquire(bytes)) return this.reserve(bytes);
    return await new Promise((resolve) => {
      this.waiters.push({ bytes, resolve });
      this.drain();
    });
  }

  canAcquire(bytes) {
    if (!Number.isFinite(this.maxBytes)) return true;
    if (bytes > this.maxBytes) return this.reservedBytes === 0;
    return this.reservedBytes + bytes <= this.maxBytes;
  }

  reserve(bytes) {
    this.reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedBytes -= bytes;
      this.drain();
    };
  }

  drain() {
    while (this.waiters.length > 0 && this.canAcquire(this.waiters[0].bytes)) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.reserve(waiter.bytes));
    }
  }
}

function createByteBudget(maxBytes) {
  return new ByteBudget(maxBytes);
}

async function runBoundedWork(items, options, worker) {
  const values = Array.from(items);
  if (values.length === 0) return [];
  const concurrency = Math.max(1, Math.min(values.length, Math.floor(options && options.concurrency || 1)));
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  let completed = 0;

  const runWorker = async () => {
    while (firstError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await worker(values[index], index);
        completed += 1;
        if (options && typeof options.onProgress === "function") {
          options.onProgress(completed, values.length);
        }
        const yieldEvery = Math.max(0, Math.floor(options && options.yieldEvery || 0));
        if (yieldEvery > 0 && completed % yieldEvery === 0) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        }
      } catch (error) {
        if (firstError === null) firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  if (firstError !== null) throw firstError;
  return results;
}

module.exports = { createByteBudget, runBoundedWork };
