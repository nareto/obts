import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { assertNoSymlinkComponents } from './deletionRoot.js';
import { observeMetadataPersist } from './syncLatency.js';
import { OperationHistoryStore, type HistoryBatch } from './operationHistoryStore.js';

import { newId, nowIso } from '../shared/ids.js';
import { DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from '../shared/validators.js';
import type { DiagnosticEvent } from '../shared/diagnostics.js';
import type { MetadataConflictRule } from './frontmatterTimestampMerge.js';
import type {
  ConflictRecord,
  DirectoryIntentAcknowledgement,
  EventEnvelope,
  NoteHistoryVersion
} from '../shared/types.js';

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_LIMIT = 100_000;
const MAX_OPEN_OPERATION_HISTORY_LEDGERS = 16;

// Metadata temp residue is only removed when its name matches a naming scheme this
// project has actually written: `<pid>.<epoch-ms>.<random-hex>.tmp` for the current
// writer and `<pid>.<epoch-ms>.tmp` for the previous release. Anything else is
// unexpected residue and still fails closed.
const TEMP_RESIDUE_PATTERN = /^[0-9]+\.[0-9]+(?:\.[0-9a-f]+)?\.tmp$/u;

export type PasswordHash = {
  algorithm: 'argon2id';
  hash: string;
  memory_cost: 19456;
  time_cost: 2;
  parallelism: 1;
};

export type LegacyPasswordHash = {
  algorithm: 'scrypt';
  salt: string;
  hash: string;
};

export type UserRow = {
  user_id: string;
  username: string;
  display_name: string;
  password_hash: PasswordHash | LegacyPasswordHash;
  is_admin: boolean;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
};

export type SessionRow = {
  session_id: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  idle_expires_at: string;
  recent_auth_at: string;
  revoked_at: string | null;
};

export type VaultRow = {
  vault_id: string;
  owner_user_id: string;
  display_name: string;
  status: 'active' | 'blocked_integrity' | 'deleting';
  root_commit?: string | null;
  current_main: string;
  metadata_conflict_rules?: MetadataConflictRule[];
  created_at: string;
  updated_at: string;
};

export type DeviceRow = {
  device_id: string;
  vault_id: string;
  user_id: string;
  device_name: string;
  device_ref: string;
  device_ref_head: string | null;
  status: 'paired' | 'synced' | 'ahead' | 'review_needed' | 'blocked_recovery' | 'revoked';
  last_applied_main: string | null;
  last_applied_event_seq: number;
  last_applied_explicit_dirs: string[] | null;
  pending_applied_main: string | null;
  pending_applied_event_seq: number;
  pending_applied_explicit_dirs: string[] | null;
  last_seen_at: string | null;
  last_successful_sync_at: string | null;
  local_status_label: string | null;
  local_error_code: string | null;
  local_queue_status: string | null;
  local_main: string | null;
  local_head: string | null;
  plugin_version: string | null;
  path_capabilities: Record<string, unknown> | null;
  last_status_report_at: string | null;
  onboarding_status: 'pending' | 'complete' | null;
  onboarding_mode: 'initialize' | 'use_server' | 'merge' | null;
  initial_proposal_kind: 'new_vault_import' | 'independent_vault_merge' | 'shared_baseline_merge' | null;
  initial_proposal_base: string | null;
  onboarding_connection_id: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type ConnectionRequestRow = {
  connection_id: string;
  secret_lookup_prefix: string;
  secret_hash: string;
  credential_salt: string;
  verification_code: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied' | 'expired';
  plugin_version: string;
  proposed_device_name: string;
  local_vault_name: string;
  local_summary: {
    has_content: boolean;
    syncable_file_count: number;
    syncable_bytes: number;
    has_detached_baseline: boolean;
  };
  approved_user_id: string | null;
  selection: 'new_vault' | 'existing_vault' | null;
  selected_vault_id: string | null;
  new_vault_display_name: string | null;
  expected_main: string | null;
  created_device_id: string | null;
  created_at: string;
  approved_at: string | null;
  consumed_at: string | null;
  expires_at: string;
};

export type TokenRow = {
  token_id: string;
  kind: 'device' | 'password_reset';
  lookup_prefix: string;
  token_hash: string;
  user_id: string;
  vault_id: string | null;
  device_id: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  failed_attempts: number;
  revoked_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LoginAttemptRow = {
  username: string;
  source_ip: string;
  failed_count: number;
  window_started_at: string;
  last_failed_at: string;
  locked_until: string | null;
  updated_at: string;
};

export type SyncOperationRow = {
  operation_id: string;
  operation_sequence?: number;
  vault_id: string;
  device_id: string | null;
  operation_type: 'device_push' | 'server_merge' | 'conflict_create' | 'conflict_refresh' | 'conflict_resolve' | 'note_restore' | 'git_maintenance' | 'vault_settings' | 'name_repair';
  expected_refs: Record<string, string | null>;
  target_refs: Record<string, string | null>;
  target_commit: string | null;
  status: 'started' | 'prepared' | 'committed' | 'aborted';
  // Absent on legacy pushes; null binds the original natural-base (no explicit base) rule.
  proposal_base?: string | null;
  prepared_manifest: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type AuditRow = {
  audit_id: string;
  actor_user_id: string | null;
  actor_device_id: string | null;
  vault_id: string | null;
  action: string;
  resource_class: string;
  resource_id: string | null;
  created_at: string;
};

export type DiagnosticEventRow = DiagnosticEvent & {
  owner_user_id: string;
  connection_id: string | null;
  vault_id: string | null;
  device_id: string | null;
  received_at: string;
  expires_at: string;
};

export type DirectoryStateRow = {
  explicit_dirs: string[];
  updated_at: string;
  last_event_seq: number;
};

export type DirectoryProposalResultRow = {
  proposal_id: string;
  request_sha256: string;
  vault_id: string;
  device_id: string;
  target_commit: string;
  status: 'accepted' | 'conflicted' | 'resolved';
  conflict_id: string | null;
  event_seq: number;
  acknowledged_intents: DirectoryIntentAcknowledgement[];
  created_at: string;
  updated_at: string;
};

export type DerivedHistoryIndexRow = {
  path: string;
  current_main: string;
  versions: NoteHistoryVersion[];
  indexed_at: string;
};

export type DeletionErrorCode = 'storage_unavailable' | 'unattributed_residue' | 'metadata_unavailable';

export type DeletionJob = {
  vault_id: string;
  owner_user_id: string;
  requested_at: string;
  phase: 'intent' | 'draining' | 'erasing' | 'finalizing';
  retry_at: string | null;
  error_code: DeletionErrorCode | null;
};

export type DeletionReceipt = {
  vault_id: string;
  owner_user_id: string;
  requested_at: string;
  completed_at: string;
  status: 'deleted';
};

export type OperationHistoryMetadata = {
  ledger_id: string;
  generation: number;
  next_sequence: number;
  init_pending: boolean;
  pending_batch: HistoryBatch | null;
};

/**
 * Durable intent for permanent removal of one already-revoked device. The record is committed before
 * any ref or identity deletion and is the only authority that makes an intentionally missing device ref
 * legitimate. `expected_ref_oid` is immutable for one `generation`; if the ref moves, a new generation
 * is committed with the newly verified OID before another compare-and-swap is attempted.
 */
export type DeviceRemovalJob = {
  device_id: string;
  vault_id: string;
  owner_user_id: string;
  requested_at: string;
  updated_at: string;
  phase: 'intent' | 'ref_deleting' | 'cleanup';
  generation: number;
  expected_ref_oid: string | null;
  discard_unmerged: boolean;
  state: 'pending' | 'failed';
  error_code: string | null;
  retryable: boolean;
};

export type MetadataDb = {
  schema_version: 8;
  operation_history_by_vault?: Record<string, OperationHistoryMetadata>;
  setup_complete: boolean;
  users: UserRow[];
  sessions: SessionRow[];
  vaults: VaultRow[];
  devices: DeviceRow[];
  connections: ConnectionRequestRow[];
  tokens: TokenRow[];
  login_attempts: LoginAttemptRow[];
  sync_operations: SyncOperationRow[];
  conflicts: ConflictRecord[];
  events: EventEnvelope[];
  audit_log: AuditRow[];
  diagnostic_events: DiagnosticEventRow[];
  event_seq_by_vault: Record<string, number>;
  merge_sequence_by_vault: Record<string, number>;
  directory_state_by_vault: Record<string, DirectoryStateRow>;
  directory_proposal_results: DirectoryProposalResultRow[];
  derived_history_by_vault: Record<string, DerivedHistoryIndexRow[]>;
  deletion_jobs: DeletionJob[];
  deletion_receipts: DeletionReceipt[];
  device_removal_jobs: DeviceRemovalJob[];
};

export type MetadataCommit = { readonly previous: DeepReadonly<MetadataDb>; readonly current: DeepReadonly<MetadataDb> };
/**
 * A device is revoked when `revoked_at` is set OR its status is 'revoked'. The status-only form exists in
 * legacy rows (no timestamp was ever recorded; none is invented at load), which must stay removable and
 * look revoked everywhere. The store only enforces the other direction (see `enforceRevocationInvariant`).
 */
export function isDeviceRevoked(device: Pick<DeviceRow, 'revoked_at'> & Partial<Pick<DeviceRow, 'status'>>): boolean {
  return (device.revoked_at !== null && device.revoked_at !== undefined) || device.status === 'revoked';
}

/**
 * Revocation is sticky: a device with `revoked_at` set always has status 'revoked'. Enforced at the
 * commit boundary (before persistence and publication) so no sync completion that was authenticated
 * before a revoke can make the device look un-revoked. Returns whether anything was repaired.
 */
function enforceRevocationInvariant(db: MetadataDb): boolean {
  let repaired = false;
  for (const device of db.devices) {
    if (device.revoked_at !== null && device.revoked_at !== undefined && device.status !== 'revoked') {
      device.status = 'revoked';
      repaired = true;
    }
  }
  return repaired;
}

export type MetadataCommitListener = (commit: MetadataCommit) => void;

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type Detached<T> = T extends object ? { -readonly [K in keyof T]: Detached<T[K]> } : T;

export type MetadataPersistenceAdapter = {
  readDirectory(path: string): Promise<string[]>;
  writeFile(path: string, data: string): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

const defaultPersistenceAdapter: MetadataPersistenceAdapter = {
  readDirectory: async (path) => await readdir(path),
  writeFile: async (path, data) => await writeFile(path, data, { mode: 0o600, flag: 'wx' }),
  fsyncFile: async (path) => {
    const file = await open(path, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  },
  rename,
  fsyncDirectory: async (path) => {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
  remove: async (path) => await rm(path, { force: true })
};

export class MetadataStore {
  private db: MetadataDb | null = null;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private durabilityUncertain = false;
  private cleanupFailed = false;
  private cleanupDirectorySyncRequired = false;
  private readonly commitListeners = new Set<MetadataCommitListener>();
  private commits = 0;
  private pendingCommit: { previous: MetadataDb; current: MetadataDb } | null = null;
  private readonly persistence: MetadataPersistenceAdapter;
  private readonly histories = new Map<string, OperationHistoryStore>();

  constructor(private readonly dataDir: string, persistence?: Partial<MetadataPersistenceAdapter>) {
    this.persistence = { ...defaultPersistenceAdapter, ...persistence };
  }

  isReady(): boolean {
    if (this.closed || this.durabilityUncertain || this.cleanupFailed || !this.db) return false;
    try {
      for (const vault of this.db.vaults) {
        if (vault.status === 'deleting' || this.db.deletion_jobs.some((job) => job.vault_id === vault.vault_id)) continue;
        const state = this.db.operation_history_by_vault?.[vault.vault_id];
        const history = this.histories.get(vault.vault_id);
        if (!state || state.init_pending || state.pending_batch) return false;
        const directory = join(this.dataDir, 'metadata', 'operation-history', vault.vault_id);
        if (history) history.verifyAvailable(state.generation, state.next_sequence);
        else OperationHistoryStore.verifyOnDisk(directory, vault.vault_id, state.ledger_id, state.generation, state.next_sequence);
      }
      return true;
    } catch {
      this.durabilityUncertain = true;
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
    for (const history of this.histories.values()) history.close();
    this.histories.clear();
  }

  isDurabilityUncertain(): boolean {
    return this.durabilityUncertain;
  }

  /**
   * Observes committed metadata states. Listeners run detached (after the committing transaction has
   * resolved its own continuation), receive readonly previous/current states and can neither delay
   * nor fail a commit. They are only invoked after durable publication succeeded; a failed or
   * uncertain publication never reaches them.
   */
  subscribeCommits(listener: MetadataCommitListener): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  /**
   * Monotonic count of durably published commits in this process. Callers that verify state outside the
   * metadata queue use it to detect that a commit landed in between, instead of holding the queue.
   */
  commitVersion(): number {
    return this.commits;
  }

  async snapshotVersioned(): Promise<{ db: MetadataDb; version: number }> {
    await this.pending;
    if (this.db === null) await this.initialize();
    this.assertOperational();
    return { db: clone(this.requireDb()), version: this.commits };
  }

  /**
   * Commits that land before the detached drain runs are coalesced into one transition (earliest
   * previous -> latest current), so at most two retained states exist however large a burst is. Each
   * listener therefore sees one combined transition per drain.
   */
  private publishCommit(previous: MetadataDb | null, current: MetadataDb): void {
    this.commits += 1;
    if (previous === null) return;
    if (this.pendingCommit !== null) {
      this.pendingCommit.current = current;
      return;
    }
    if (this.commitListeners.size === 0) return;
    this.pendingCommit = { previous, current };
    setImmediate(() => this.drainCommits());
  }

  private drainCommits(): void {
    const pending = this.pendingCommit;
    this.pendingCommit = null;
    if (pending === null) return;
    for (const listener of [...this.commitListeners]) {
      if (!this.commitListeners.has(listener)) continue;
      try {
        listener({ previous: pending.previous, current: pending.current });
      } catch {
        // A subscriber failure must never affect the already committed transaction.
      }
    }
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => await this.initializeUnqueued());
  }

  private async initializeUnqueued(): Promise<void> {
    await assertNoSymlinkComponents(resolve(dirname(this.filePath)));
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const metadataDirectory = await lstat(dirname(this.filePath));
    if (!metadataDirectory.isDirectory() || metadataDirectory.isSymbolicLink()) {
      throw new MetadataCleanupError();
    }
    let loaded = false;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.db = JSON.parse(raw) as MetadataDb;
      loaded = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.db = createEmptyDb();
    }
    if (this.normalizeLoadedDb(this.requireDb())) {
      await this.persist();
    } else if (!loaded) {
      await this.persist();
    }
    await this.removeStalePersistenceTemps();
    try {
      await this.initializeOperationHistory();
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  private async initializeOperationHistory(): Promise<void> {
    const current = this.requireDb();
    let candidate = clone(current);
    let initialized = false;
    candidate.operation_history_by_vault ??= {};
    const vaultIds = new Set(candidate.vaults.map((vault) => vault.vault_id));
    if (candidate.sync_operations.some((operation) => !vaultIds.has(operation.vault_id)) ||
        Object.keys(candidate.operation_history_by_vault).some((vaultId) => !vaultIds.has(vaultId))) {
      throw new Error('Operation history references an unknown vault.');
    }
    for (const vault of candidate.vaults) {
      const rows = candidate.sync_operations.filter((operation) => operation.vault_id === vault.vault_id);
      const state = candidate.operation_history_by_vault[vault.vault_id];
      if (!state) {
        if (rows.some((operation) => operation.operation_sequence !== undefined)) throw new Error('Unacknowledged operation history sequence state is inconsistent.');
        rows.forEach((operation, index) => { operation.operation_sequence = index + 1; });
        candidate.operation_history_by_vault[vault.vault_id] = {
          ledger_id: newId('hist'), generation: 0,
          next_sequence: rows.length + 1, init_pending: true, pending_batch: null
        };
        initialized = true;
        continue;
      }
      let previousSequence = 0;
      for (const operation of rows) {
        if (!Number.isSafeInteger(operation.operation_sequence) || operation.operation_sequence! <= previousSequence) {
          throw new Error('Operation history hot-row ordering is inconsistent.');
        }
        previousSequence = operation.operation_sequence!;
      }
      if (!Number.isSafeInteger(state.next_sequence) || state.next_sequence <= previousSequence ||
          typeof state.ledger_id !== 'string' || state.ledger_id.length === 0 ||
          !Number.isSafeInteger(state.generation) || state.generation < 0 ||
          typeof state.init_pending !== 'boolean' || !Object.hasOwn(state, 'pending_batch')) {
        throw new Error('Operation history metadata is inconsistent.');
      }
    }
    if (initialized || candidate.sync_operations.some((operation, index) => operation.operation_sequence !== current.sync_operations[index]?.operation_sequence)) {
      await this.persist(candidate);
      this.db = candidate;
      candidate = clone(candidate);
    }
    for (const vault of candidate.vaults) {
      const state = candidate.operation_history_by_vault![vault.vault_id];
      if (!state) throw new Error('Operation history initialization state is missing.');
      if (vault.status === 'deleting' || candidate.deletion_jobs.some((job) => job.vault_id === vault.vault_id)) continue;
      if (state.init_pending && (state.generation !== 0 || state.pending_batch !== null)) throw new Error('Operation history initialization state is inconsistent.');
      if (state.pending_batch) this.validateHistoryBatch(candidate, vault.vault_id);
      const history = await OperationHistoryStore.open(join(this.dataDir, 'metadata', 'operation-history', vault.vault_id), vault.vault_id, state.ledger_id, state.init_pending, this.persistence, true,
        { generation: state.generation, nextSequence: state.next_sequence, pendingBatch: state.pending_batch });
      this.cacheHistory(vault.vault_id, history);
      if (state.pending_batch) await this.recoverHistoryBatch(candidate, vault.vault_id, history);
      else if (history.generation !== state.generation || history.maxSequence >= state.next_sequence) throw new Error('Operation history generation or sequence mismatch.');
      if (state.init_pending) {
        const initialized = clone(this.requireDb());
        initialized.operation_history_by_vault![vault.vault_id]!.init_pending = false;
        await this.persist(initialized);
        this.db = initialized;
        candidate = initialized;
      }
    }
  }

  private validateHistoryBatch(db: MetadataDb, vaultId: string): HistoryBatch {
    const state = db.operation_history_by_vault![vaultId];
    if (!state) throw new Error('Operation history metadata is missing.');
    const batch = state.pending_batch!;
    if (batch.vault_id !== vaultId || batch.ledger_id !== state.ledger_id || batch.parent_generation !== state.generation ||
        batch.target_generation !== state.generation + 1 || batch.rows.length === 0 || batch.rows.length > 256) {
      throw new Error('Operation history handoff descriptor is inconsistent.');
    }
    const selected = new Map(db.sync_operations.filter((row) => row.vault_id === vaultId).map((row) => [row.operation_id, row]));
    const identities = new Set<string>();
    let previousSequence = 0;
    for (const entry of batch.rows) {
      const row = selected.get(entry.operation_id);
      const canonical = row ? OperationHistoryStore.canonical(row) : null;
      if (!row || row.status !== 'committed' && row.status !== 'aborted' || row.operation_sequence !== entry.sequence ||
          entry.sequence <= previousSequence || identities.has(entry.operation_id) || canonical?.text !== entry.canonical || canonical.sha256 !== entry.sha256) {
        throw new Error('Operation history source row does not match its handoff descriptor.');
      }
      identities.add(entry.operation_id);
      previousSequence = entry.sequence;
    }
    return batch;
  }

  private async recoverHistoryBatch(db: MetadataDb, vaultId: string, history: OperationHistoryStore): Promise<void> {
    const batch = this.validateHistoryBatch(db, vaultId);
    if (history.generation === batch.parent_generation) history.commitBatch(batch);
    else if (history.generation === batch.target_generation) history.commitBatch(batch);
    else throw new Error('Operation history archive proof is missing.');
    await this.finishHistoryBatch(db, vaultId, batch);
  }

  private async archiveEligibleUnqueued(vaultId: string, isPendingMerge?: (row: SyncOperationRow, db: MetadataDb) => Promise<boolean>): Promise<number> {
    const db = this.requireDb();
    const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
    if (!vault || vault.status !== 'active' || db.deletion_jobs.some((job) => job.vault_id === vaultId)) return 0;
    const history = await this.ensureHistory(vaultId);
    const state = db.operation_history_by_vault![vaultId];
    if (!state) throw new Error('Operation history metadata is missing.');
    if (state.pending_batch) throw new Error('Operation history handoff requires recovery.');
    if (history.generation !== state.generation || history.maxSequence >= state.next_sequence) throw new Error('Operation history generation or sequence mismatch.');
    const vaultRows = db.sync_operations.filter((row) => row.vault_id === vaultId);
    const currentDeviceHeads = new Map(db.devices.filter((device) => device.vault_id === vaultId).map((device) => [device.device_id, device.device_ref_head]));
    const eligible: SyncOperationRow[] = [];
    for (const row of vaultRows) {
      if (row.status !== 'committed' && row.status !== 'aborted') continue;
      if (row.operation_type === 'device_push' && row.status === 'committed' && row.device_id &&
          row.target_commit === currentDeviceHeads.get(row.device_id) && (isPendingMerge ? await isPendingMerge(row, db) : true)) continue;
      eligible.push(row);
    }
    eligible.sort((left, right) => (left.operation_sequence ?? 0) - (right.operation_sequence ?? 0));
    eligible.splice(256);
    if (eligible.length === 0) return 0;
    await this.publishHistoryBatch(vaultId, eligible);
    return eligible.length;
  }

  private async publishHistoryBatch(vaultId: string, rows: SyncOperationRow[]): Promise<void> {
    const db = clone(this.requireDb());
    const state = db.operation_history_by_vault![vaultId];
    if (!state) throw new Error('Operation history metadata is missing.');
    const history = await this.ensureHistory(vaultId);
    if (state.pending_batch || state.generation !== history.generation) throw new Error('Operation history handoff is unavailable.');
    const batch: HistoryBatch = {
      vault_id: vaultId, ledger_id: state.ledger_id, batch_id: newId('batch'), parent_generation: state.generation,
      target_generation: state.generation + 1,
      rows: rows.map((row) => {
        const canonical = OperationHistoryStore.canonical(row);
        if (row.operation_sequence === undefined) throw new Error('Operation history sequence is missing.');
        return { operation_id: row.operation_id, sequence: row.operation_sequence, canonical: canonical.text, sha256: canonical.sha256 };
      })
    };
    state.pending_batch = batch;
    await this.persist(db);
    this.db = db;
    try {
      history.commitBatch(batch);
      await this.finishHistoryBatch(db, vaultId, batch);
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  private async finishHistoryBatch(db: MetadataDb, vaultId: string, batch: HistoryBatch): Promise<void> {
    const candidate = clone(db);
    candidate.sync_operations = candidate.sync_operations.filter((row) =>
      row.vault_id !== vaultId || !batch.rows.some((entry) => entry.operation_id === row.operation_id));
    const state = candidate.operation_history_by_vault![vaultId];
    if (!state) throw new Error('Operation history metadata is missing.');
    state.generation = batch.target_generation;
    state.pending_batch = null;
    await this.persist(candidate);
    this.db = candidate;
  }

  async findArchivedAttempt(vaultId: string, deviceId: string, attemptId: string): Promise<{ row: SyncOperationRow; sequence: number } | null> {
    return await this.readHistory(vaultId, (history) => history.findAttempt(deviceId, attemptId));
  }

  async findArchivedTargetCandidates(vaultId: string, deviceId: string, targetCommit: string): Promise<Array<{ row: SyncOperationRow; sequence: number }>> {
    return await this.readHistory(vaultId, (history) => history.findTargetCandidates(deviceId, targetCommit));
  }

  async exportOperationHistory(vaultId: string): Promise<SyncOperationRow[]> {
    return await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      const db = this.requireDb();
      return await this.readHistory(vaultId, (history) => {
        const rows = new Map<string, SyncOperationRow>();
        for (const row of [...history.exportRows(), ...db.sync_operations.filter((candidate) => candidate.vault_id === vaultId)]) {
          const previous = rows.get(row.operation_id);
          if (previous && OperationHistoryStore.canonical(previous).sha256 !== OperationHistoryStore.canonical(row).sha256) {
            throw new Error('Operation history contains conflicting copies.');
          }
          rows.set(row.operation_id, row);
        }
        return [...rows.values()].sort((left, right) => (left.operation_sequence ?? 0) - (right.operation_sequence ?? 0));
      });
    });
  }

  async operationHistoryCounts(vaultId: string): Promise<Record<string, number>> {
    return await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      const db = this.requireDb();
      const hot = db.sync_operations.filter((row) => row.vault_id === vaultId);
      const pendingIds = db.operation_history_by_vault?.[vaultId]?.pending_batch?.rows.map((row) => row.operation_id) ?? [];
      const counts: Record<string, number> = {};
      for (const row of hot) {
        const key = `${row.operation_type}:${row.status}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const historicalCounts = await this.readHistory(vaultId, (history) => history.countByTypeStatus(pendingIds));
      for (const item of historicalCounts) {
        const key = `${item.operation_type}:${item.status}`;
        counts[key] = (counts[key] ?? 0) + item.count;
      }
      return counts;
    });
  }

  async eraseOperationHistory(vaultId: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) throw new Error('Metadata store is closed.');
      this.histories.get(vaultId)?.close();
      this.histories.delete(vaultId);
      const state = this.requireDb().operation_history_by_vault?.[vaultId];
      await OperationHistoryStore.eraseDirectory(join(this.dataDir, 'metadata', 'operation-history', vaultId),
        state ? { vaultId, ledgerId: state.ledger_id } : undefined);
    });
  }

  async archiveCompletedHistory(vaultId: string, isPendingMerge?: (row: SyncOperationRow, db: MetadataDb) => Promise<boolean>): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      try {
        await this.archiveEligibleUnqueued(vaultId, isPendingMerge);
      } catch (error) {
        this.durabilityUncertain = true;
        throw error;
      }
    });
  }

  async archiveStartupHistory(vaultId: string, isPendingMerge?: (row: SyncOperationRow, db: MetadataDb) => Promise<boolean>): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      try {
        while (await this.archiveEligibleUnqueued(vaultId, isPendingMerge) > 0) {}
      } catch (error) {
        this.durabilityUncertain = true;
        throw error;
      }
    });
  }

  private prepareOperationHistoryMetadata(db: MetadataDb): void {
    db.operation_history_by_vault ??= {};
    for (const vault of db.vaults) {
      if (!db.operation_history_by_vault[vault.vault_id]) {
        db.operation_history_by_vault[vault.vault_id] = {
          ledger_id: newId('hist'), generation: 0,
          next_sequence: db.sync_operations.filter((row) => row.vault_id === vault.vault_id).length + 1,
          init_pending: true, pending_batch: null
        };
      }
    }
  }

  private cacheHistory(vaultId: string, history: OperationHistoryStore): void {
    const existing = this.histories.get(vaultId);
    if (existing && existing !== history) existing.close();
    this.histories.delete(vaultId);
    this.histories.set(vaultId, history);
    while (this.histories.size > MAX_OPEN_OPERATION_HISTORY_LEDGERS) {
      const oldest = this.histories.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.histories.get(oldest)?.close();
      this.histories.delete(oldest);
    }
  }

  private async readHistory<T>(vaultId: string, read: (history: OperationHistoryStore) => T): Promise<T> {
    const history = await this.ensureHistory(vaultId);
    try { return read(history); }
    catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  private async ensureHistory(vaultId: string): Promise<OperationHistoryStore> {
    if (this.durabilityUncertain) throw new MetadataPublicationError();
    try {
      const state = this.requireDb().operation_history_by_vault?.[vaultId];
      if (!state) throw new Error('Operation history metadata is missing.');
      const existing = this.histories.get(vaultId);
      if (existing) {
        existing.verifyAvailable(state.generation, state.next_sequence);
        this.histories.delete(vaultId);
        this.histories.set(vaultId, existing);
        return existing;
      }
      // Startup validates all rows; eviction must not turn indexed admission into a history scan.
      const history = await OperationHistoryStore.open(
        join(this.dataDir, 'metadata', 'operation-history', vaultId), vaultId, state.ledger_id, state.init_pending, this.persistence, false,
        { generation: state.generation, nextSequence: state.next_sequence, pendingBatch: state.pending_batch }
      );
      try {
        history.verifyAvailable(state.generation, state.next_sequence);
      } catch (error) {
        history.close();
        throw error;
      }
      this.cacheHistory(vaultId, history);
      return history;
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  private async initializePendingHistories(): Promise<void> {
    const db = this.requireDb();
    this.prepareOperationHistoryMetadata(db);
    for (const vault of db.vaults) {
      if (vault.status === 'deleting' || db.deletion_jobs.some((job) => job.vault_id === vault.vault_id)) continue;
      const state = db.operation_history_by_vault![vault.vault_id]!;
      if (!state.init_pending) continue;
      const history = await this.ensureHistory(vault.vault_id);
      if (history.generation !== state.generation || history.maxSequence >= state.next_sequence) throw new Error('Operation history generation or sequence mismatch.');
      const initialized = clone(this.requireDb());
      initialized.operation_history_by_vault![vault.vault_id]!.init_pending = false;
      await this.persist(initialized);
      this.db = initialized;
    }
  }

  async snapshot(): Promise<MetadataDb> {
    await this.pending;
    if (this.db === null) await this.initialize();
    this.assertOperational();
    return clone(this.requireDb());
  }

  async mutate<T>(fn: (db: MetadataDb) => T | Promise<T>): Promise<T> {
    return await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      const candidate = clone(this.requireDb());
      const result = await fn(candidate);
      enforceRevocationInvariant(candidate);
      this.prepareOperationHistoryMetadata(candidate);
      try {
        await this.persist(candidate);
      } catch (error) {
        if (error instanceof MetadataPublicationError) this.durabilityUncertain = true;
        throw error;
      }
      const previous = this.db;
      this.db = candidate;
      this.publishCommit(previous, candidate);
      await this.initializePendingHistories();
      return result;
    });
  }

  async mutateDurably<T>(fn: (db: MetadataDb) => T | Promise<T>): Promise<T> {
    return await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      const candidate = clone(this.requireDb());
      const result = await fn(candidate);
      enforceRevocationInvariant(candidate);
      this.prepareOperationHistoryMetadata(candidate);
      try {
        await this.persist(candidate);
      } catch (error) {
        if (error instanceof MetadataPublicationError) this.durabilityUncertain = true;
        throw error;
      }
      const previous = this.db;
      this.db = candidate;
      this.publishCommit(previous, candidate);
      await this.initializePendingHistories();
      return result;
    });
  }

  async read<T>(select: (db: DeepReadonly<MetadataDb>) => T): Promise<Detached<T>> {
    await this.pending;
    if (this.db === null) await this.initialize();
    this.assertOperational();
    return clone(select(this.requireDb())) as Detached<T>;
  }

  async readOrMutate<T>(
    select: (db: DeepReadonly<MetadataDb>) => T,
    shouldMutate: (selected: T) => boolean,
    update: (db: MetadataDb) => T
  ): Promise<Detached<T>> {
    return await this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertOperational();
      const selected = select(this.requireDb());
      if (!shouldMutate(selected)) return clone(selected) as Detached<T>;
      const candidate = clone(this.requireDb());
      const result = update(candidate);
      enforceRevocationInvariant(candidate);
      this.prepareOperationHistoryMetadata(candidate);
      try {
        await this.persist(candidate);
      } catch (error) {
        if (error instanceof MetadataPublicationError) this.durabilityUncertain = true;
        throw error;
      }
      const previous = this.db;
      this.db = candidate;
      this.publishCommit(previous, candidate);
      await this.initializePendingHistories();
      return clone(result) as Detached<T>;
    });
  }

  async cleanupPersistenceTemps(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      if (this.durabilityUncertain) throw new MetadataPublicationError();
      await this.removeStalePersistenceTemps();
    });
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Metadata store is closed.');
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private requireDb(): MetadataDb {
    if (this.db === null) {
      throw new Error('Metadata store is not initialized.');
    }
    return this.db;
  }

  private assertOperational(): void {
    if (this.durabilityUncertain) throw new MetadataPublicationError();
    if (this.cleanupFailed) throw new MetadataCleanupError();
    const db = this.db;
    if (!db) return;
    try {
      for (const vault of db.vaults) {
        if (vault.status === 'deleting' || db.deletion_jobs.some((job) => job.vault_id === vault.vault_id)) continue;
        const state = db.operation_history_by_vault?.[vault.vault_id];
        const history = this.histories.get(vault.vault_id);
        if (!state || state.init_pending || state.pending_batch) throw new MetadataPublicationError();
        if (history) {
          history.verifyAvailable(state.generation, state.next_sequence);
        } else {
          OperationHistoryStore.verifyOnDisk(join(this.dataDir, 'metadata', 'operation-history', vault.vault_id),
            vault.vault_id, state.ledger_id, state.generation, state.next_sequence);
        }
      }
    } catch (error) {
      this.durabilityUncertain = true;
      if (error instanceof MetadataPublicationError) throw error;
      throw new MetadataPublicationError(error);
    }
  }

  nextMergeSequence(db: MetadataDb, vaultId: string): number {
    const next = (db.merge_sequence_by_vault[vaultId] ?? 0) + 1;
    db.merge_sequence_by_vault[vaultId] = next;
    return next;
  }

  appendEvent(
    db: MetadataDb,
    event: Omit<EventEnvelope, 'event_id' | 'event_seq' | 'created_at'>
  ): EventEnvelope {
    const eventSeq = (db.event_seq_by_vault[event.vault_id] ?? 0) + 1;
    db.event_seq_by_vault[event.vault_id] = eventSeq;
    const envelope: EventEnvelope = {
      event_id: newId('evt'),
      event_seq: eventSeq,
      created_at: nowIso(),
      ...event
    };
    db.events.push(envelope);
    this.pruneVaultEvents(db, event.vault_id);
    return envelope;
  }

  startOperation(
    db: MetadataDb,
    input: Omit<SyncOperationRow, 'operation_id' | 'status' | 'prepared_manifest' | 'result' | 'created_at' | 'updated_at'>
  ): SyncOperationRow {
    const timestamp = nowIso();
    db.operation_history_by_vault ??= {};
    const state = db.operation_history_by_vault[input.vault_id] ??= {
      ledger_id: newId('hist'), generation: 0,
      next_sequence: db.sync_operations.filter((row) => row.vault_id === input.vault_id).length + 1,
      init_pending: true, pending_batch: null
    };
    const operation: SyncOperationRow = {
      operation_id: newId('op'),
      operation_sequence: state.next_sequence++,
      status: 'started',
      prepared_manifest: null,
      result: null,
      created_at: timestamp,
      updated_at: timestamp,
      ...input
    };
    db.sync_operations.push(operation);
    return operation;
  }

  private get filePath(): string {
    return join(this.dataDir, 'metadata', 'phase1.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.db === null) {
      await this.initializeUnqueued();
    }
  }

  private async persist(db = this.requireDb()): Promise<void> {
    await observeMetadataPersist(async () => await this.persistUnmeasured(db));
  }

  private async persistUnmeasured(db: MetadataDb): Promise<void> {
    const serialized = `${JSON.stringify(db)}\n`;
    const tempFile = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch (error) {
      this.cleanupFailed = true;
      throw new MetadataCleanupError(error);
    }
    let renamed = false;
    let publicationAmbiguous = false;
    let cleanupAttempted = false;
    try {
      try {
        await this.persistence.writeFile(tempFile, serialized);
        await this.persistence.fsyncFile(tempFile);
      } catch (error) {
        cleanupAttempted = true;
        await this.removeTemporaryFile(tempFile);
        throw error;
      }
      try {
        await this.persistence.rename(tempFile, this.filePath);
        renamed = true;
      } catch (error) {
        publicationAmbiguous = true;
        throw new MetadataPublicationError(error);
      }
      try {
        await this.persistence.fsyncDirectory(dirname(this.filePath));
      } catch (error) {
        throw new MetadataPublicationError(error);
      }
    } finally {
      if (!renamed && !publicationAmbiguous && !cleanupAttempted) {
        await this.removeTemporaryFile(tempFile);
      } else if (renamed) {
        await this.removeTemporaryFile(tempFile);
      }
    }
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.persistence.remove(path);
    } catch (error) {
      if (!isMissing(error)) {
        this.cleanupFailed = true;
        throw new MetadataCleanupError(error);
      }
    }
  }

  private async removeStalePersistenceTemps(): Promise<void> {
    let entries: string[];
    try {
      entries = await this.persistence.readDirectory(dirname(this.filePath));
    } catch (error) {
      this.cleanupFailed = true;
      throw new MetadataCleanupError(error);
    }
    const prefix = `${basename(this.filePath)}.`;
    let removed = false;
    try {
      for (const entry of entries.filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith('.tmp'))) {
        if (!TEMP_RESIDUE_PATTERN.test(entry.slice(prefix.length))) {
          throw new MetadataCleanupError(new Error(`unexpected metadata temp residue: ${entry}`));
        }
        await this.persistence.remove(join(dirname(this.filePath), entry));
        removed = true;
        this.cleanupDirectorySyncRequired = true;
      }
      if (removed || this.cleanupDirectorySyncRequired) await this.persistence.fsyncDirectory(dirname(this.filePath));
      this.cleanupDirectorySyncRequired = false;
      this.cleanupFailed = false;
    } catch (error) {
      this.cleanupFailed = true;
      if (error instanceof MetadataCleanupError) throw error;
      throw new MetadataCleanupError(error);
    }
  }

  private normalizeLoadedDb(db: MetadataDb): boolean {
    const legacyDb = db as Omit<MetadataDb, 'schema_version'> & {
      schema_version: number;
      deletion_jobs?: DeletionJob[];
      deletion_receipts?: DeletionReceipt[];
      device_removal_jobs?: DeviceRemovalJob[];
      connections?: ConnectionRequestRow[];
      login_attempts?: LoginAttemptRow[];
      diagnostic_events?: DiagnosticEventRow[];
      directory_state_by_vault?: Record<string, DirectoryStateRow>;
      directory_proposal_results?: DirectoryProposalResultRow[];
      derived_history_by_vault?: Record<string, DerivedHistoryIndexRow[]>;
    };
    let changed = false;
    if (!Array.isArray(legacyDb.connections)) {
      legacyDb.connections = [];
      changed = true;
    }
    for (const connection of legacyDb.connections) {
      const deviceName = migrateDisplayName(connection.proposed_device_name, 'Unnamed device');
      if (connection.proposed_device_name !== deviceName) {
        connection.proposed_device_name = deviceName;
        changed = true;
      }
      if (connection.new_vault_display_name !== null) {
        const vaultName = migrateDisplayName(connection.new_vault_display_name, 'Unnamed vault');
        if (connection.new_vault_display_name !== vaultName) {
          connection.new_vault_display_name = vaultName;
          changed = true;
        }
      }
    }
    const legacyTokens = legacyDb.tokens as unknown as Array<TokenRow & { kind: string }>;
    const retainedTokens = legacyTokens.filter((token: { kind: string }) => token.kind !== 'pairing') as TokenRow[];
    if (retainedTokens.length !== legacyTokens.length) {
      legacyDb.tokens = retainedTokens;
      changed = true;
    }
    if (!Array.isArray(legacyDb.login_attempts)) {
      legacyDb.login_attempts = [];
      changed = true;
    }
    if (!Array.isArray(legacyDb.diagnostic_events)) {
      legacyDb.diagnostic_events = [];
      changed = true;
    }
    if (legacyDb.directory_state_by_vault === undefined) {
      legacyDb.directory_state_by_vault = {};
      changed = true;
    }
    if (!Array.isArray(legacyDb.directory_proposal_results)) {
      legacyDb.directory_proposal_results = [];
      changed = true;
    }
    if (legacyDb.derived_history_by_vault === undefined) {
      legacyDb.derived_history_by_vault = {};
      changed = true;
    }
    if (!Array.isArray(legacyDb.deletion_jobs)) {
      legacyDb.deletion_jobs = [];
      changed = true;
    }
    if (!Array.isArray(legacyDb.deletion_receipts)) {
      legacyDb.deletion_receipts = [];
      changed = true;
    }
    if (!Array.isArray(legacyDb.device_removal_jobs)) {
      legacyDb.device_removal_jobs = [];
      changed = true;
    }
    const schema = legacyDb as unknown as { schema_version: number };
    if (schema.schema_version < 8) {
      schema.schema_version = 8;
      changed = true;
    }
    for (const vault of db.vaults) {
      const displayName = migrateDisplayName(vault.display_name, 'Unnamed vault');
      if (vault.display_name !== displayName) {
        vault.display_name = displayName;
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(vault, 'root_commit')) {
        vault.root_commit = null;
        changed = true;
      }
    }
    if (enforceRevocationInvariant(db)) changed = true;
    for (const device of db.devices) {
      const deviceName = migrateDisplayName(device.device_name, 'Unnamed device');
      if (device.device_name !== deviceName) {
        device.device_name = deviceName;
        changed = true;
      }
      const legacyDevice = device as DeviceRow & {
        last_applied_main?: string | null;
        last_applied_event_seq?: number;
        last_applied_explicit_dirs?: string[] | null;
        pending_applied_main?: string | null;
        pending_applied_event_seq?: number;
        pending_applied_explicit_dirs?: string[] | null;
        local_status_label?: string | null;
        local_error_code?: string | null;
        local_error_details?: Record<string, unknown> | null;
        local_queue_status?: string | null;
        local_main?: string | null;
        local_head?: string | null;
        plugin_version?: string | null;
        path_capabilities?: Record<string, unknown> | null;
        last_status_report_at?: string | null;
        onboarding_status?: 'pending' | 'complete' | null;
        onboarding_mode?: 'initialize' | 'use_server' | 'merge' | null;
        initial_proposal_kind?: 'new_vault_import' | 'independent_vault_merge' | 'shared_baseline_merge' | null;
        initial_proposal_base?: string | null;
        onboarding_connection_id?: string | null;
        onboarding_completed_at?: string | null;
      };
      if (!Object.prototype.hasOwnProperty.call(legacyDevice, 'last_applied_main')) {
        legacyDevice.last_applied_main = null;
        changed = true;
      }
      if (
        !Number.isSafeInteger(legacyDevice.last_applied_event_seq) ||
        !Object.prototype.hasOwnProperty.call(legacyDevice, 'last_applied_explicit_dirs') ||
        !(legacyDevice.last_applied_explicit_dirs === null || Array.isArray(legacyDevice.last_applied_explicit_dirs))
      ) {
        const snapshot = metadataDirectorySnapshotForMain(db, device.vault_id, legacyDevice.last_applied_main ?? null);
        legacyDevice.last_applied_event_seq = snapshot.eventSeq;
        legacyDevice.last_applied_explicit_dirs = snapshot.explicitDirectories;
        changed = true;
      }
      if (
        !Object.prototype.hasOwnProperty.call(legacyDevice, 'pending_applied_main') ||
        !Number.isSafeInteger(legacyDevice.pending_applied_event_seq) ||
        !(legacyDevice.pending_applied_explicit_dirs === null || Array.isArray(legacyDevice.pending_applied_explicit_dirs))
      ) {
        legacyDevice.pending_applied_main = null;
        legacyDevice.pending_applied_event_seq = 0;
        legacyDevice.pending_applied_explicit_dirs = null;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(legacyDevice, 'local_error_details')) {
        delete legacyDevice.local_error_details;
        changed = true;
      }
      for (const key of [
        'local_status_label',
        'local_error_code',
        'local_queue_status',
        'local_main',
        'local_head',
        'plugin_version',
        'path_capabilities',
        'last_status_report_at',
        'onboarding_status',
        'onboarding_mode',
        'initial_proposal_kind',
        'initial_proposal_base',
        'onboarding_connection_id',
        'onboarding_completed_at'
      ] as const) {
        if (legacyDevice[key] === undefined) {
          legacyDevice[key] = null;
          changed = true;
        }
      }
    }
    for (const conflict of db.conflicts) {
      const legacyConflict = conflict as ConflictRecord & {
        conflict_kind?: 'content' | 'directory' | 'mixed';
        validator_results?: Record<string, unknown>;
      };
      if (!Object.prototype.hasOwnProperty.call(legacyConflict, 'conflict_kind')) {
        legacyConflict.conflict_kind = 'content';
        changed = true;
      }
      if (!Object.prototype.hasOwnProperty.call(legacyConflict, 'validator_results')) {
        legacyConflict.validator_results = {
          reason:
            typeof legacyConflict.validator_summary.reason === 'string'
              ? legacyConflict.validator_summary.reason
              : 'unknown',
          affected_paths: legacyConflict.affected_paths,
          affected_path_count: legacyConflict.affected_path_count
        };
        changed = true;
      }
    }
    return changed;
  }

  pruneDirectoryProposalResults(db: MetadataDb, vaultId: string): void {
    const devices = new Map(
      db.devices.filter((device) => device.vault_id === vaultId).map((device) => [device.device_id, device])
    );
    db.directory_proposal_results = db.directory_proposal_results.filter((result) => {
      if (result.vault_id !== vaultId || result.status === 'conflicted') return true;
      const device = devices.get(result.device_id);
      if (!device) return true;
      return result.event_seq > device.last_applied_event_seq;
    });
  }

  private pruneVaultEvents(db: MetadataDb, vaultId: string): void {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    const retainedVaultEvents = db.events
      .filter((event) => event.vault_id === vaultId)
      .filter((event) => {
        const createdAt = Date.parse(event.created_at);
        return Number.isNaN(createdAt) || createdAt >= cutoff;
      })
      .slice(-EVENT_RETENTION_LIMIT);
    const retainedIds = new Set(retainedVaultEvents.map((event) => event.event_id));
    db.events = db.events.filter((event) => event.vault_id !== vaultId || retainedIds.has(event.event_id));
  }
}

function metadataDirectorySnapshotForMain(
  db: MetadataDb,
  vaultId: string,
  main: string | null
): { eventSeq: number; explicitDirectories: string[] | null } {
  if (!main) return { eventSeq: 0, explicitDirectories: [] };
  const vault = db.vaults.find((candidate) => candidate.vault_id === vaultId);
  if (vault?.current_main === main) {
    return {
      eventSeq: db.event_seq_by_vault[vaultId] ?? 0,
      explicitDirectories: [...(db.directory_state_by_vault[vaultId]?.explicit_dirs ?? [])].sort()
    };
  }
  const events = db.events
    .filter((event) => event.vault_id === vaultId)
    .sort((left, right) => left.event_seq - right.event_seq);
  const mainEvent = [...events].reverse().find((event) =>
    event.event_type === 'main_advanced' && event.commit_cursors.main === main
  );
  if (!mainEvent || (events[0]?.event_seq ?? 1) > 1) return { eventSeq: 0, explicitDirectories: null };
  const explicit = new Set<string>();
  for (const event of events) {
    if (event.event_seq > mainEvent.event_seq) break;
    const intents = Array.isArray(event.payload.directory_intents) ? event.payload.directory_intents : [];
    for (const rawIntent of intents) {
      if (!rawIntent || typeof rawIntent !== 'object' || Array.isArray(rawIntent)) continue;
      const intent = rawIntent as { op?: unknown; path?: unknown };
      if ((intent.op !== 'create' && intent.op !== 'delete') || typeof intent.path !== 'string') continue;
      if (intent.op === 'delete') {
        for (const candidate of [...explicit]) {
          if (candidate === intent.path || candidate.startsWith(`${intent.path}/`)) explicit.delete(candidate);
        }
      } else {
        explicit.add(intent.path);
      }
    }
  }
  return { eventSeq: mainEvent.event_seq, explicitDirectories: [...explicit].sort() };
}

function migrateDisplayName(value: unknown, fallback: string): string {
  const normalized = normalizeDisplayName(value);
  if (normalized !== null) {
    return normalized;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const sanitized = Array.from(value.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim())
    .slice(0, DISPLAY_NAME_MAX_LENGTH)
    .join('')
    .trim();
  return normalizeDisplayName(sanitized) ?? fallback;
}

function createEmptyDb(): MetadataDb {
  return {
    schema_version: 8,
    setup_complete: false,
    users: [],
    sessions: [],
    vaults: [],
    devices: [],
    connections: [],
    tokens: [],
    login_attempts: [],
    sync_operations: [],
    conflicts: [],
    events: [],
    audit_log: [],
    diagnostic_events: [],
    event_seq_by_vault: {},
    merge_sequence_by_vault: {},
    directory_state_by_vault: {},
    directory_proposal_results: [],
    derived_history_by_vault: {},
    deletion_jobs: [],
    deletion_receipts: [],
    device_removal_jobs: []
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MetadataPublicationError extends Error {
  constructor(cause?: unknown) {
    super('Metadata publication durability is uncertain.', { cause });
  }
}

export class MetadataCleanupError extends Error {
  constructor(cause?: unknown) {
    super('Metadata temporary-file cleanup is unavailable.', { cause });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function hasDurableDeletionRecord(db: DeepReadonly<MetadataDb>, vaultId: string): boolean {
  return db.vaults.some((vault) => vault.vault_id === vaultId && vault.status === 'deleting') ||
    db.deletion_jobs.some((job) => job.vault_id === vaultId) ||
    db.deletion_receipts.some((receipt) => receipt.vault_id === vaultId);
}
