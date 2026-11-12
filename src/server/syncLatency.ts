import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type SyncLatency = {
  persist_count: number;
  persist_ms: number;
  git_ms: number;
  git_count: number;
  git_slowest: string | null;
  git_slowest_ms: number;
  clone_count: number;
  clone_ms: number;
  lock_wait_ms: number;
};
export type SyncLatencyReport = Omit<SyncLatency, 'git_slowest'> & { git_slowest?: string };
const observations = new AsyncLocalStorage<SyncLatency>();

export async function observeSyncLatency<T>(action: () => Promise<T>): Promise<{ result: T; latency: SyncLatencyReport }> {
  const latency: SyncLatency = {
    persist_count: 0, persist_ms: 0, git_ms: 0, git_count: 0, git_slowest: null, git_slowest_ms: 0,
    clone_count: 0, clone_ms: 0, lock_wait_ms: 0
  };
  const result = await observations.run(latency, action);
  const report: SyncLatencyReport = {
    persist_count: latency.persist_count,
    persist_ms: Math.round(latency.persist_ms),
    git_ms: Math.round(latency.git_ms),
    git_count: latency.git_count,
    ...(latency.git_slowest === null ? {} : { git_slowest: latency.git_slowest }),
    git_slowest_ms: Math.round(latency.git_slowest_ms),
    clone_count: latency.clone_count,
    clone_ms: Math.round(latency.clone_ms),
    lock_wait_ms: Math.round(latency.lock_wait_ms)
  };
  return { result, latency: report };
}

export async function observeMetadataPersist<T>(action: () => Promise<T>): Promise<T> {
  const latency = observations.getStore();
  if (!latency) return await action();
  const started = performance.now();
  latency.persist_count++;
  try { return await action(); }
  finally { latency.persist_ms += performance.now() - started; }
}

/**
 * A whole-metadata-state copy. Reported separately from `persist` because it is pure event-loop
 * blocking rather than durability latency, so the two need distinct budgets.
 */
export function observeMetadataClone<T>(action: () => T): T {
  const latency = observations.getStore();
  if (!latency) return action();
  const started = performance.now();
  latency.clone_count++;
  try { return action(); }
  finally { latency.clone_ms += performance.now() - started; }
}

/**
 * Time spent waiting for the per-vault mutation lock before an observed integration could start.
 * It is measured outside every other observation because an integration blocked on the lock is not
 * doing work of its own.
 */
export function recordSyncLockWait(ms: number): void {
  const latency = observations.getStore();
  if (!latency) return;
  latency.lock_wait_ms += ms;
}

export async function observeGitCommand<T>(action: () => Promise<T>, subcommand?: string): Promise<T> {
  const latency = observations.getStore();
  if (!latency) return await action();
  const started = performance.now();
  try { return await action(); }
  finally {
    const elapsed = performance.now() - started;
    latency.git_ms += elapsed;
    latency.git_count++;
    if (subcommand !== undefined && elapsed >= latency.git_slowest_ms) {
      latency.git_slowest = subcommand;
      latency.git_slowest_ms = elapsed;
    }
  }
}
