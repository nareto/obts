import {
  DIAGNOSTIC_MAX_BODY_BYTES,
  diagnosticPayloadBytes,
  parseDiagnosticEvent,
  type DiagnosticEventV1
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
const MAX_EVENTS_PER_SOURCE_HOUR = 60;
const MAX_EVENTS_PER_INSTANCE_HOUR = 1_000;
const TERMINAL_CONNECTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class DiagnosticService {
  private readonly sourceWindows = new Map<string, number[]>();
  private instanceWindow: number[] = [];

  constructor(
    private readonly store: MetadataStore,
    private readonly config: ServerConfig
  ) {}

  async initialize(): Promise<void> {
    await this.prune();
  }

  async ingestConnection(
    auth: { connection: ConnectionRequestRow; user: UserRow },
    value: unknown,
    sourceIp: string
  ): Promise<{ status: 'accepted' | 'duplicate'; event_id: string }> {
    this.requireEnabled();
    const event = this.parse(value);
    this.enforceBurstLimits(sourceIp);
    return await this.store.mutate((db) => {
      pruneRows(db, Date.now());
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
      const ownerCount = db.diagnostic_events.filter((candidate) => candidate.owner_user_id === auth.user.user_id).length;
      if (connectionCount >= MAX_CONNECTION_EVENTS || ownerCount >= MAX_OWNER_EVENTS || db.diagnostic_events.length >= MAX_EVENTS) {
        throw new AuthError(429, 'diagnostic_quota_exceeded', 'Diagnostic reporting quota exceeded.');
      }
      appendRow(db, event, this.config.diagnosticRetentionDays, {
        ownerUserId: auth.user.user_id,
        connectionId: auth.connection.connection_id,
        vaultId: auth.connection.selected_vault_id,
        deviceId: null
      });
      return { status: 'accepted' as const, event_id: event.event_id };
    });
  }

  async ingestDevice(
    auth: AuthenticatedDevice,
    value: unknown,
    sourceIp: string
  ): Promise<{ status: 'accepted' | 'duplicate'; event_id: string }> {
    this.requireEnabled();
    const event = this.parse(value);
    this.enforceBurstLimits(sourceIp);
    return await this.store.mutate((db) => {
      const now = Date.now();
      pruneRows(db, now);
      const duplicate = db.diagnostic_events.find(
        (candidate) =>
          candidate.event_id === event.event_id &&
          candidate.owner_user_id === auth.user.user_id &&
          candidate.device_id === auth.device.device_id
      );
      if (duplicate) return { status: 'duplicate' as const, event_id: duplicate.event_id };
      const deviceCount = db.diagnostic_events.filter(
        (candidate) => candidate.device_id === auth.device.device_id && Date.parse(candidate.received_at) >= now - DAY_MS
      ).length;
      const ownerCount = db.diagnostic_events.filter((candidate) => candidate.owner_user_id === auth.user.user_id).length;
      if (deviceCount >= MAX_DEVICE_EVENTS_PER_DAY || ownerCount >= MAX_OWNER_EVENTS || db.diagnostic_events.length >= MAX_EVENTS) {
        throw new AuthError(429, 'diagnostic_quota_exceeded', 'Diagnostic reporting quota exceeded.');
      }
      appendRow(db, event, this.config.diagnosticRetentionDays, {
        ownerUserId: auth.user.user_id,
        connectionId: null,
        vaultId: auth.vault.vault_id,
        deviceId: auth.device.device_id
      });
      return { status: 'accepted' as const, event_id: event.event_id };
    });
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

  private parse(value: unknown): DiagnosticEventV1 {
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

  private enforceBurstLimits(sourceIp: string): void {
    const now = Date.now();
    this.instanceWindow = this.instanceWindow.filter((timestamp) => timestamp >= now - HOUR_MS);
    const sourceWindow = (this.sourceWindows.get(sourceIp) ?? []).filter((timestamp) => timestamp >= now - HOUR_MS);
    if (sourceWindow.length >= MAX_EVENTS_PER_SOURCE_HOUR || this.instanceWindow.length >= MAX_EVENTS_PER_INSTANCE_HOUR) {
      throw new AuthError(429, 'diagnostic_rate_limited', 'Diagnostic reporting rate limit exceeded.');
    }
    sourceWindow.push(now);
    this.instanceWindow.push(now);
    this.sourceWindows.set(sourceIp, sourceWindow);
    if (this.sourceWindows.size > 10_000) {
      for (const [key, timestamps] of this.sourceWindows) {
        if (timestamps.every((timestamp) => timestamp < now - HOUR_MS)) this.sourceWindows.delete(key);
        if (this.sourceWindows.size <= 10_000) break;
      }
    }
  }
}

function appendRow(
  db: MetadataDb,
  event: DiagnosticEventV1,
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
