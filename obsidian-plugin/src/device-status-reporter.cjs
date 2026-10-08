const DEVICE_STATUS_HEARTBEAT_MS = 2 * 60 * 1000;
const DEVICE_STATUS_RETRY_MS = 30 * 1000;

function createDeviceStatusReporter({ send, now = () => Date.now() }) {
  let pending = null;
  let running = null;
  let acceptedSignature = null;
  let acceptedAt = 0;
  let retryAt = 0;
  let failures = 0;
  let requiresServerFeedback = false;

  async function run() {
    while (pending) {
      const snapshot = pending;
      pending = null;
      if (!snapshot.force && !snapshot.requiresServerFeedback && snapshot.signature === acceptedSignature && now() - acceptedAt < DEVICE_STATUS_HEARTBEAT_MS) continue;
      if (now() < retryAt) continue;
      try {
        await send(snapshot);
        acceptedSignature = snapshot.signature;
        acceptedAt = now();
        retryAt = 0;
        failures = 0;
      } catch {
        failures = Math.min(failures + 1, 3);
        retryAt = now() + Math.min(DEVICE_STATUS_HEARTBEAT_MS, DEVICE_STATUS_RETRY_MS * 2 ** (failures - 1));
      }
    }
  }

  function start() {
    if (running) return;
    running = Promise.resolve().then(run).finally(() => {
      running = null;
      if (pending) start();
    });
  }

  return {
    request(snapshot) {
      requiresServerFeedback = Boolean(snapshot.requiresServerFeedback);
      pending = pending?.force ? Object.assign({}, snapshot, { force: true }) : snapshot;
      start();
    },
    heartbeatDue() {
      return requiresServerFeedback || acceptedSignature === null || now() - acceptedAt >= DEVICE_STATUS_HEARTBEAT_MS;
    },
    async flush() {
      while (running) await running;
    }
  };
}

module.exports = { createDeviceStatusReporter, DEVICE_STATUS_HEARTBEAT_MS };
