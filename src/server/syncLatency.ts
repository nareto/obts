import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type SyncLatency = { persist_count: number; persist_ms: number; git_ms: number };
const observations = new AsyncLocalStorage<SyncLatency>();

export async function observeSyncLatency<T>(action: () => Promise<T>): Promise<{ result: T; latency: SyncLatency }> {
  const latency: SyncLatency = { persist_count: 0, persist_ms: 0, git_ms: 0 };
  const result = await observations.run(latency, action);
  return { result, latency: {
    persist_count: latency.persist_count,
    persist_ms: Math.round(latency.persist_ms),
    git_ms: Math.round(latency.git_ms)
  } };
}

export async function observeMetadataPersist<T>(action: () => Promise<T>): Promise<T> {
  const latency = observations.getStore();
  if (!latency) return await action();
  const started = performance.now();
  latency.persist_count++;
  try { return await action(); }
  finally { latency.persist_ms += performance.now() - started; }
}

export async function observeGitCommand<T>(action: () => Promise<T>): Promise<T> {
  const latency = observations.getStore();
  if (!latency) return await action();
  const started = performance.now();
  try { return await action(); }
  finally { latency.git_ms += performance.now() - started; }
}
