import { AuthError } from './authService.js';
import type { GitService } from './gitService.js';
import { hasDurableDeletionRecord, type MetadataStore } from './metadataStore.js';
import type { OperationalLog } from './operationalLog.js';

/**
 * Automatic Git pack consolidation (OBTS-PER-MAINT-001).
 *
 * Every push can add one pack to a vault repository and nothing consolidates them unless an owner
 * presses the maintenance action, so object lookup cost would grow with push count forever: a
 * production vault had thousands of packs and every `rev-list`/`ls-tree`/`merge-base` paid for it.
 * This scheduler keeps the store bounded instead:
 *
 * - it is only ever triggered off the critical path (after a canonical write, or at startup), so a
 *   consolidation can never delay or fail the operation that noticed it;
 * - it checks a cheap directory-listing inventory first and only acts above a threshold;
 * - it runs under the ordinary per-vault canonical mutation serialization plus deletion admission, so
 *   no push, merge, restore, ref transition or vault deletion overlaps the pack replacement;
 * - it never prunes: `GitService.compactRepository` replaces packs with packs that already contain
 *   every object of the superseded ones.
 */

/** Pack count above which consolidation runs. Object lookup probes every pack, so this stays small. */
export const DEFAULT_PACK_THRESHOLD = 24;
/**
 * Loose objects above which consolidation runs. Direct push uploads and merge/restore bookkeeping write
 * loose objects; a few hundred of them are harmless, thousands of directory entries are not.
 */
export const DEFAULT_LOOSE_THRESHOLD = 500;

export type GitMaintenanceSource = 'startup' | 'request';

export type GitMaintenanceOptions = {
  packThreshold?: number;
  looseThreshold?: number;
};

export type GitMaintenanceDependencies = {
  git: GitService;
  store: MetadataStore;
  log: OperationalLog;
  /** Runs `action` under the vault's canonical mutation serialization and deletion admission. */
  runExclusive: <T>(vaultId: string, action: () => Promise<T>) => Promise<T>;
};

export class GitMaintenanceScheduler {
  private readonly packThreshold: number;
  private readonly looseThreshold: number;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private closed = false;

  constructor(
    private readonly dependencies: GitMaintenanceDependencies,
    options: GitMaintenanceOptions = {}
  ) {
    this.packThreshold = options.packThreshold ?? DEFAULT_PACK_THRESHOLD;
    this.looseThreshold = options.looseThreshold ?? DEFAULT_LOOSE_THRESHOLD;
  }

  /**
   * Requests a background threshold check for a vault. Repeated requests coalesce: at most one check
   * runs per vault at a time and a request that arrives during a run makes the loop look again once,
   * so a burst of pushes cannot queue unbounded consolidation work.
   */
  schedule(vaultId: string): void {
    if (this.closed) return;
    this.queued.add(vaultId);
    if (this.inFlight.has(vaultId)) return;
    let finished!: () => void;
    const running = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.inFlight.set(vaultId, running);
    void (async () => {
      try {
        // Defer past the triggering response so the write that asked for this is already answered.
        await new Promise<void>((resolve) => setImmediate(resolve));
        do {
          this.queued.delete(vaultId);
          await this.runIfNeeded(vaultId, 'request');
        } while (this.queued.has(vaultId) && !this.closed);
      } catch (error) {
        this.dependencies.log.backgroundFailure('git_maintenance', error);
      } finally {
        this.inFlight.delete(vaultId);
        finished();
      }
    })();
  }

  /**
   * Checks every active vault once at startup. Runs sequentially so a large backlog in one vault cannot
   * multiply Git processes across the process start, and never lets one vault's failure block another.
   */
  async startupSweep(): Promise<void> {
    if (this.closed) return;
    const db = await this.dependencies.store.snapshot();
    for (const vault of db.vaults) {
      if (this.closed) return;
      if (vault.status !== 'active') continue;
      try {
        await this.runIfNeeded(vault.vault_id, 'startup');
      } catch (error) {
        this.dependencies.log.backgroundFailure('git_maintenance', error);
      }
    }
  }

  /**
   * Runs one consolidation for `vaultId` when the repository is over a threshold. Returns whether a
   * consolidation actually ran. Durability uncertainty, a vault that is no longer active, and a vault
   * being deleted all skip instead of writing.
   */
  async runIfNeeded(vaultId: string, source: GitMaintenanceSource): Promise<boolean> {
    if (this.closed || this.dependencies.git.isDurabilityUnavailable()) return false;
    if (!(await this.needsConsolidation(vaultId))) return false;
    try {
      return await this.dependencies.runExclusive(vaultId, async () => await this.consolidate(vaultId, source));
    } catch (error) {
      if (error instanceof AuthError && error.code === 'vault_deleting') return false;
      throw error;
    }
  }

  /** Waits for every scheduled check to finish. Used by shutdown and by deterministic tests. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  close(): void {
    this.closed = true;
    this.queued.clear();
  }

  private async needsConsolidation(vaultId: string): Promise<boolean> {
    if ((await this.dependencies.git.countRepositoryPacks(vaultId)) > this.packThreshold) return true;
    return (await this.dependencies.git.countLooseObjects(vaultId)) > this.looseThreshold;
  }

  private async consolidate(vaultId: string, source: GitMaintenanceSource): Promise<boolean> {
    const db = await this.dependencies.store.snapshot();
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    if (!vault || vault.status !== 'active' || hasDurableDeletionRecord(db, vaultId)) return false;
    const packsBefore = await this.dependencies.git.countRepositoryPacks(vaultId);
    const looseBefore = await this.dependencies.git.countLooseObjects(vaultId);
    if (packsBefore <= this.packThreshold && looseBefore <= this.looseThreshold) return false;
    this.dependencies.log.emit('info', 'git_maintenance', {
      vault_id: vaultId, source, packs_before: packsBefore, loose_before: looseBefore
    });
    const startedAt = Date.now();
    await this.dependencies.git.compactRepository(vaultId);
    const packsAfter = await this.dependencies.git.countRepositoryPacks(vaultId);
    const looseAfter = await this.dependencies.git.countLooseObjects(vaultId);
    this.dependencies.log.emit('info', 'git_maintenance', {
      vault_id: vaultId, source, packs_before: packsBefore, packs_after: packsAfter,
      loose_before: looseBefore, loose_after: looseAfter, duration_ms: Date.now() - startedAt
    });
    return true;
  }
}
