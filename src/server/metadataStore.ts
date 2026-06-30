import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { newId, nowIso } from '../shared/ids.js';
import type { ConflictRecord, EventEnvelope, SyncProfile } from '../shared/types.js';

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
  current_main: string;
  created_at: string;
  updated_at: string;
};

export type DeviceRow = {
  device_id: string;
  vault_id: string;
  user_id: string;
  device_name: string;
  sync_profile: SyncProfile;
  sync_plugins: boolean;
  device_ref: string;
  device_ref_head: string | null;
  status: 'paired' | 'synced' | 'ahead' | 'review_needed' | 'blocked_recovery' | 'revoked';
  last_seen_at: string | null;
  last_successful_sync_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

export type TokenRow = {
  token_id: string;
  kind: 'pairing' | 'device';
  lookup_prefix: string;
  token_hash: string;
  user_id: string;
  vault_id: string;
  device_id: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  failed_attempts: number;
  revoked_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SyncOperationRow = {
  operation_id: string;
  vault_id: string;
  device_id: string | null;
  operation_type: 'device_push' | 'server_merge' | 'conflict_create';
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

export type MetadataDb = {
  schema_version: 1;
  setup_complete: boolean;
  users: UserRow[];
  sessions: SessionRow[];
  vaults: VaultRow[];
  devices: DeviceRow[];
  tokens: TokenRow[];
  sync_operations: SyncOperationRow[];
  conflicts: ConflictRecord[];
  events: EventEnvelope[];
  audit_log: AuditRow[];
  event_seq_by_vault: Record<string, number>;
  merge_sequence_by_vault: Record<string, number>;
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
      this.normalizeLoadedDb(this.db);
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

  private normalizeLoadedDb(db: MetadataDb): void {
    for (const device of db.devices) {
      const legacyDevice = device as DeviceRow & { sync_plugins?: boolean };
      if (legacyDevice.sync_plugins === undefined) {
        legacyDevice.sync_plugins = false;
      }
    }
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

function createEmptyDb(): MetadataDb {
  return {
    schema_version: 1,
    setup_complete: false,
    users: [],
    sessions: [],
    vaults: [],
    devices: [],
    tokens: [],
    sync_operations: [],
    conflicts: [],
    events: [],
    audit_log: [],
    event_seq_by_vault: {},
    merge_sequence_by_vault: {}
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
