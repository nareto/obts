import {
  DIAGNOSTIC_MAX_BODY_BYTES,
  diagnosticPayloadBytes,
  parseDiagnosticEvent,
  type DiagnosticEvent
} from '../shared/diagnostics.js';
import { nowIso } from '../shared/ids.js';
import type { DiagnosticEventsResponse } from '../shared/types.js';
import type { AuthenticatedDevice } from './authService.js';
import { AuthError } from './authService.js';
import type { ServerConfig } from './config.js';
import type { ConnectionRequestRow, MetadataDb, MetadataStore, UserRow } from './metadataStore.js';

const MAX_EVENTS = 10_000;
const MAX_OWNER_EVENTS = 2_000;
const MAX_CONNECTION_EVENTS = 20;
const MAX_DEVICE_EVENTS_PER_DAY = 100;
const MAX_EVENTS_PER_IDENTITY_HOUR = 60;
const MAX_EVENTS_PER_INSTANCE_HOUR = 1_000;
const MANUAL_DEVICE_RESERVE = 10;
const MANUAL_OWNER_RESERVE = 200;
const MANUAL_STORAGE_RESERVE = 1_000;
const MANUAL_INSTANCE_HOUR_RESERVE = 100;
const TERMINAL_CONNECTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type AcceptedDiagnostic = { at: number; deviceId: string | null; connectionId: string | null; manual: boolean };

export class DiagnosticService {
  private acceptedWindow: AcceptedDiagnostic[] = [];
  private acceptanceInitialized = false;
  private pendingAdmission: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: MetadataStore,
    private readonly config: ServerConfig
  ) {}

  async initialize(): Promise<void> {
    await this.prune();
    this.seedAcceptanceWindow(await this.store.snapshot(), Date.now());
  }

  async ingestConnection(
    auth: { connection: ConnectionRequestRow; user: UserRow },
    value: unknown,
    _sourceIp: string
  ): Promise<{ status: 'accepted' | 'duplicate'; event_id: string }> {
    this.requireEnabled();
    const event = this.parse(value);
    return await this.withAdmission(event, null, auth.connection.connection_id, async () => this.store.mutate((db) => {
      const now = Date.now();
      const connection = db.connections.find(row => row.connection_id === auth.connection.connection_id);
      const user = db.users.find(row => row.user_id === auth.user.user_id);
      if (!connection || connection.status !== 'approved' || connection.approved_user_id !== auth.user.user_id ||
        connection.selected_vault_id !== auth.connection.selected_vault_id || Date.parse(connection.expires_at) <= now || !user || user.disabled) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      pruneRows(db, now);
      const duplicate = db.diagnostic_events.find(
        (candidate) =>
          candidate.event_id === event.event_id &&
          candidate.owner_user_id === auth.user.user_id &&
          candidate.connection_id === auth.connection.connection_id
      );
      if (duplicate) return { status: 'duplicate' as const, event_id: duplicate.event_id };
      const connectionCount = db.diagnostic_events.filter(
        (candidate) => candidate.connection_id === auth.connection.connection_id
      ).length;
      if (connectionCount >= MAX_CONNECTION_EVENTS) {
        throw new AuthError(429, 'diagnostic_quota_exceeded', 'Diagnostic reporting quota exceeded.');
      }
      this.enforceAcceptanceLimits(db, event, auth.user.user_id, null, auth.connection.connection_id, Date.now());
      appendRow(db, event, this.config.diagnosticRetentionDays, {
        ownerUserId: auth.user.user_id,
        connectionId: auth.connection.connection_id,
        vaultId: auth.connection.selected_vault_id,
        deviceId: null
      });
      return { status: 'accepted' as const, event_id: event.event_id };
    }));
  }

  async ingestDevice(
    auth: AuthenticatedDevice,
    value: unknown,
    _sourceIp: string
  ): Promise<{ status: 'accepted' | 'duplicate'; event_id: string }> {
    this.requireEnabled();
    const event = this.parse(value);
    return await this.withAdmission(event, auth.device.device_id, null, async () => this.store.mutate((db) => {
      const now = Date.now();
      const vault = db.vaults.find((candidate) => candidate.vault_id === auth.vault.vault_id);
      const device = db.devices.find((candidate) => candidate.device_id === auth.device.device_id);
      const token = db.tokens.find((candidate) => candidate.token_id === auth.token.token_id);
      const user = db.users.find((candidate) => candidate.user_id === auth.user.user_id);
      if (!vault || !device || !user || user.disabled || !token || token.kind !== 'device' || token.user_id !== auth.user.user_id ||
        token.consumed_at !== null || (token.expires_at !== null && Date.parse(token.expires_at) <= now) ||
        vault.owner_user_id !== auth.user.user_id || device.vault_id !== vault.vault_id ||
        device.user_id !== auth.user.user_id || device.status === 'revoked' || device.revoked_at !== null || token.revoked_at !== null ||
        token.vault_id !== vault.vault_id || token.device_id !== device.device_id) {
        throw new AuthError(404, 'not_found', 'Resource not found.');
      }
      if (vault.status === 'deleting') {
        throw new AuthError(409, 'vault_deleting', 'Vault deletion is in progress.');
      }
      pruneRows(db, now);
      const duplicate = db.diagnostic_events.find(
        (candidate) =>
          candidate.event_id === event.event_id &&
          candidate.owner_user_id === auth.user.user_id &&
          candidate.device_id === auth.device.device_id
      );
      if (duplicate) return { status: 'duplicate' as const, event_id: duplicate.event_id };
      this.enforceAcceptanceLimits(db, event, auth.user.user_id, auth.device.device_id, null, now);
      appendRow(db, event, this.config.diagnosticRetentionDays, {
        ownerUserId: auth.user.user_id,
        connectionId: null,
        vaultId: auth.vault.vault_id,
        deviceId: auth.device.device_id
      });
      return { status: 'accepted' as const, event_id: event.event_id };
    }));
  }

  async list(ownerUserId: string, cursor: string | null, limit: number): Promise<DiagnosticEventsResponse> {
    await this.prune();
    const db = await this.store.snapshot();
    const sorted = db.diagnostic_events
      .filter((event) => event.owner_user_id === ownerUserId)
      .sort((left, right) => right.received_at.localeCompare(left.received_at) || right.event_id.localeCompare(left.event_id));
    const start = cursor === null ? 0 : Math.max(0, sorted.findIndex((event) => event.event_id === cursor) + 1);
    const page = sorted.slice(start, start + limit);
    const nextCursor = start + page.length < sorted.length ? page.at(-1)?.event_id ?? null : null;
    return {
      ingestion_enabled: this.config.diagnosticIngestEnabled,
      retention_days: this.config.diagnosticRetentionDays,
      events: page.map(({
        owner_user_id: _owner,
        connection_id: _connection,
        vault_id: _vault,
        device_id: _device,
        expires_at: _expires,
        ...event
      }) => event),
      next_cursor: nextCursor
    };
  }

  async deleteOwnerEvents(ownerUserId: string): Promise<number> {
    return await this.store.mutate((db) => {
      const before = db.diagnostic_events.length;
      db.diagnostic_events = db.diagnostic_events.filter((event) => event.owner_user_id !== ownerUserId);
      return before - db.diagnostic_events.length;
    });
  }

  async prune(): Promise<void> {
    const now = Date.now();
    const snapshot = await this.store.snapshot();
    const before = snapshot.diagnostic_events.length;
    pruneRows(snapshot, now);
    if (snapshot.diagnostic_events.length === before) return;
    await this.store.mutate((db) => pruneRows(db, now));
  }

  private parse(value: unknown): DiagnosticEvent {
    if (diagnosticPayloadBytes(value) > DIAGNOSTIC_MAX_BODY_BYTES) {
      throw new AuthError(413, 'diagnostic_payload_too_large', 'Diagnostic report is too large.');
    }
    return parseDiagnosticEvent(value);
  }

  private requireEnabled(): void {
    if (!this.config.diagnosticIngestEnabled) {
      throw new AuthError(503, 'diagnostic_reporting_disabled', 'Diagnostic reporting is disabled on this server.');
    }
  }

  private async withAdmission(
    event: DiagnosticEvent, deviceId: string | null, connectionId: string | null,
    accept: () => Promise<{ status: 'accepted' | 'duplicate'; event_id: string }>
  ): Promise<{ status: 'accepted' | 'duplicate'; event_id: string }> {
    const previous = this.pendingAdmission;
    let release!: () => void;
    this.pendingAdmission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const result = await accept();
      if (result.status === 'accepted') {
        this.acceptedWindow.push({ at: Date.now(), deviceId, connectionId, manual: deviceId !== null && isManualSnapshot(event) });
      }
      return result;
    } finally { release(); }
  }

  private seedAcceptanceWindow(db: MetadataDb, now: number): void {
    if (this.acceptanceInitialized) return;
    this.acceptedWindow = db.diagnostic_events.filter(row => Date.parse(row.received_at) > now - DAY_MS)
      .map(row => ({ at: Date.parse(row.received_at), deviceId: row.connection_id === null ? row.device_id : null,
        connectionId: row.connection_id, manual: isStoredManualSnapshot(row) }));
    this.acceptanceInitialized = true;
  }

  private enforceAcceptanceLimits(
    db: MetadataDb, event: DiagnosticEvent, ownerId: string, deviceId: string | null, connectionId: string | null, now: number
  ): void {
    this.seedAcceptanceWindow(db, now);
    this.acceptedWindow = this.acceptedWindow.filter(entry => entry.at > now - DAY_MS);
    const manual = deviceId !== null && isManualSnapshot(event);
    const lane = db.diagnostic_events.filter(row => isStoredManualSnapshot(row) === manual);
    const dailyIdentity = this.acceptedWindow.filter(entry => deviceId !== null ? entry.deviceId === deviceId : entry.connectionId === connectionId);
    const hourly = this.acceptedWindow.filter(entry => entry.at > now - HOUR_MS);
    const hourlyLane = hourly.filter(entry => entry.manual === manual);
    const hourlyIdentity = hourlyLane.filter(entry => deviceId !== null ? entry.deviceId === deviceId : entry.connectionId === connectionId);
    const perHour = manual ? MANUAL_DEVICE_RESERVE : MAX_EVENTS_PER_IDENTITY_HOUR;
    const instanceHour = manual ? MANUAL_INSTANCE_HOUR_RESERVE : MAX_EVENTS_PER_INSTANCE_HOUR - MANUAL_INSTANCE_HOUR_RESERVE;
    if (hourlyIdentity.length >= perHour || hourlyLane.length >= instanceHour || hourly.length >= MAX_EVENTS_PER_INSTANCE_HOUR) {
      throw new AuthError(429, 'diagnostic_rate_limited', 'Diagnostic reporting rate limit exceeded.');
    }
    const deviceDay = manual ? MANUAL_DEVICE_RESERVE : MAX_DEVICE_EVENTS_PER_DAY - MANUAL_DEVICE_RESERVE;
    const ownerLimit = manual ? MANUAL_OWNER_RESERVE : MAX_OWNER_EVENTS - MANUAL_OWNER_RESERVE;
    const storageLimit = manual ? MANUAL_STORAGE_RESERVE : MAX_EVENTS - MANUAL_STORAGE_RESERVE;
    if (db.diagnostic_events.length >= MAX_EVENTS || lane.length >= storageLimit ||
      db.diagnostic_events.filter(row => row.owner_user_id === ownerId).length >= MAX_OWNER_EVENTS ||
      lane.filter(row => row.owner_user_id === ownerId).length >= ownerLimit ||
      deviceId !== null && (dailyIdentity.filter(entry => entry.manual === manual).length >= deviceDay ||
        dailyIdentity.length >= MAX_DEVICE_EVENTS_PER_DAY)) {
      throw new AuthError(429, 'diagnostic_quota_exceeded', 'Diagnostic reporting quota exceeded.');
    }
  }
}

function isStoredManualSnapshot(row: MetadataDb['diagnostic_events'][number]): boolean {
  // Enrollment may backfill device_id, but must not change admission provenance.
  return row.connection_id === null && row.device_id !== null && isManualSnapshot(row);
}

function isManualSnapshot(event: DiagnosticEvent): boolean {
  return event.schema_version === 2 && event.context.trigger === 'manual';
}

function appendRow(
  db: MetadataDb,
  event: DiagnosticEvent,
  retentionDays: number,
  association: { ownerUserId: string; connectionId: string | null; vaultId: string | null; deviceId: string | null }
): void {
  const receivedAt = nowIso();
  db.diagnostic_events.push({
    ...event,
    owner_user_id: association.ownerUserId,
    connection_id: association.connectionId,
    vault_id: association.vaultId,
    device_id: association.deviceId,
    received_at: receivedAt,
    expires_at: new Date(Date.parse(receivedAt) + retentionDays * DAY_MS).toISOString()
  });
}

function pruneRows(db: MetadataDb, now: number): void {
  const connectionById = new Map(db.connections.map((connection) => [connection.connection_id, connection]));
  db.diagnostic_events = db.diagnostic_events.filter((event) => {
    if (Date.parse(event.expires_at) <= now) return false;
    if (!event.connection_id) return true;
    const connection = connectionById.get(event.connection_id);
    if (!connection || connection.status === 'denied' || connection.status === 'expired') {
      return Date.parse(event.received_at) > now - TERMINAL_CONNECTION_RETENTION_MS;
    }
    return true;
  });
}
