import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import { DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from '../shared/validators.js';
import type { DiagnosticEventV1 } from '../shared/diagnostics.js';
import type {
  ConflictRecord,
  DirectoryIntentAcknowledgement,
  EventEnvelope,
  NoteHistoryVersion
} from '../shared/types.js';

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_LIMIT = 100_000;

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
  status: 'active' | 'blocked_integrity';
  root_commit?: string | null;
  current_main: string;
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
  vault_id: string;
  device_id: string | null;
  operation_type: 'device_push' | 'server_merge' | 'conflict_create' | 'conflict_resolve' | 'note_restore' | 'git_maintenance';
  expected_refs: Record<string, string | null>;
  target_refs: Record<string, string | null>;
  target_commit: string | null;
  status: 'started' | 'prepared' | 'committed' | 'aborted';
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

export type DiagnosticEventRow = DiagnosticEventV1 & {
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

export type MetadataDb = {
  schema_version: 6;
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
};

export class MetadataStore {
  private db: MetadataDb | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.db = JSON.parse(raw) as MetadataDb;
      if (this.normalizeLoadedDb(this.db)) {
        await this.persist();
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        this.db = createEmptyDb();
        await this.persist();
        return;
      }
      throw error;
    }
  }

  async snapshot(): Promise<MetadataDb> {
    await this.pending;
    await this.ensureLoaded();
    return clone(this.requireDb());
  }

  async mutate<T>(fn: (db: MetadataDb) => T | Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.ensureLoaded();
      const result = await fn(this.requireDb());
      await this.persist();
      return result;
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
    const operation: SyncOperationRow = {
      operation_id: newId('op'),
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
      await this.initialize();
    }
  }

  private async persist(): Promise<void> {
    if (this.db === null) {
      throw new Error('Metadata store is not initialized.');
    }
    const serialized = `${JSON.stringify(this.db, null, 2)}\n`;
    const tempFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(tempFile, serialized, { mode: 0o600 });
    await rename(tempFile, this.filePath);
  }

  private normalizeLoadedDb(db: MetadataDb): boolean {
    const legacyDb = db as MetadataDb & {
      schema_version: 1 | 2 | 3 | 4 | 5 | 6;
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
    const schema = legacyDb as unknown as { schema_version: number };
    if (schema.schema_version < 6) {
      schema.schema_version = 6;
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
    schema_version: 6,
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
    derived_history_by_vault: {}
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
