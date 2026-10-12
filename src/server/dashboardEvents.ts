import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuthError } from './authService.js';
import type { DeepReadonly, MetadataCommit, MetadataDb, MetadataStore } from './metadataStore.js';

export type DashboardEventOptions = {
  heartbeatMs?: number;
  coalesceMs?: number;
  stallTimeoutMs?: number;
  maxStreams?: number;
  maxStreamsPerAccount?: number;
  maxStreamsPerSession?: number;
  maxVaultIdsPerMessage?: number;
  maxWritableBytes?: number;
  retryMs?: number;
};

const DEFAULTS = {
  heartbeatMs: 25_000,
  coalesceMs: 50,
  stallTimeoutMs: 15_000,
  maxStreams: 128,
  maxStreamsPerAccount: 8,
  maxStreamsPerSession: 4,
  maxVaultIdsPerMessage: 32,
  maxWritableBytes: 16 * 1024,
  retryMs: 5_000
} as const;

type ReadonlyDb = DeepReadonly<MetadataDb>;

export type OwnerImpact = { account: boolean; vaults: Set<string> };
export type DashboardImpact = {
  owners: Map<string, OwnerImpact>;
  /** Watched sessions whose authority changed (revoked, removed, expiry or owner changed). */
  sessions: Set<string>;
  /** Users that were disabled, removed or otherwise changed in an authority-relevant way. */
  users: Set<string>;
};

/** Minimal response surface used by a stream; `ServerResponse` satisfies it. */
export type StreamSink = {
  write(chunk: string): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  once(event: 'drain' | 'close', listener: () => void): unknown;
  removeListener(event: 'drain' | 'close', listener: () => void): unknown;
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
};

type Stream = {
  userId: string;
  sessionId: string;
  sink: StreamSink;
  onClosed: () => void;
  closed: boolean;
  blocked: boolean;
  flushing: boolean;
  heartbeatBusy: boolean;
  account: boolean;
  vaults: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  stallTimer: NodeJS.Timeout | null;
  onDrain: () => void;
  onSinkClose: () => void;
};

/** Re-reads current authority for a session WITHOUT touching its liveness. */
export type DashboardStreamAuthenticator = (sessionId: string) => Promise<{ user: { user_id: string } }>;

/**
 * One-way invalidation channel over authoritative metadata. It carries no content: only the fixed
 * `refresh` frame and `invalidate {account, vault_ids}` with IDs owned by the stream's own account.
 * Nothing here is a second state authority and nothing is replayed after a reconnect.
 */
export class DashboardEventHub {
  private readonly options: Required<DashboardEventOptions>;
  private readonly streams = new Set<Stream>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly store: Pick<MetadataStore, 'subscribeCommits'>,
    private readonly authenticate: DashboardStreamAuthenticator,
    options: DashboardEventOptions = {}
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  streamCount(): number {
    return this.streams.size;
  }

  /**
   * Admits a stream for an already authenticated session or throws before anything is written.
   * Capacity checks and registration are synchronous, so concurrent opens cannot overshoot a cap, and
   * registration precedes the initial `refresh` frame so no commit can fall into a gap.
   */
  admit(
    request: FastifyRequest,
    reply: FastifyReply,
    identity: { userId: string; sessionId: string },
    onClosed: () => void
  ): void {
    assertSameOrigin(request);
    if (this.closed) throw new AuthError(503, 'stream_unavailable', 'Dashboard events are unavailable.');
    this.assertCapacity(identity);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive'
    });
    raw.socket?.setNoDelay(true);
    this.attach(raw, identity, onClosed);
  }

  /** Registers an already-open sink. Separate from `admit` so framing and limits are unit-testable. */
  attach(sink: StreamSink, identity: { userId: string; sessionId: string }, onClosed: () => void): void {
    this.assertCapacity(identity);
    const stream: Stream = {
      userId: identity.userId,
      sessionId: identity.sessionId,
      sink,
      onClosed,
      closed: false,
      blocked: false,
      flushing: false,
      heartbeatBusy: false,
      account: false,
      vaults: new Set(),
      flushTimer: null,
      heartbeatTimer: null,
      stallTimer: null,
      onDrain: () => this.drained(stream),
      onSinkClose: () => this.closeStream(stream)
    };
    this.streams.add(stream);
    if (this.unsubscribe === null) {
      this.unsubscribe = this.store.subscribeCommits((commit) => this.onCommit(commit));
    }
    sink.once('close', stream.onSinkClose);
    stream.heartbeatTimer = setInterval(() => void this.heartbeat(stream), this.options.heartbeatMs);
    stream.heartbeatTimer.unref();
    this.write(stream, `retry: ${this.options.retryMs}\n\nevent: refresh\ndata: {}\n\n`);
  }

  /**
   * Marks every open stream for an account-level invalidation. Used for server-wide observations such
   * as a readiness verdict change, which carries no per-owner data. It goes through the same per-stream
   * coalescing, authorization re-check and backpressure handling as commit-driven invalidations.
   */
  broadcastAccountInvalidation(): void {
    if (this.closed) return;
    for (const stream of [...this.streams]) this.mark(stream, true, []);
  }

  /** Terminates every open stream. Used on shutdown, before dependencies close. */
  closeAll(): void {
    for (const stream of [...this.streams]) this.closeStream(stream);
  }

  close(): void {
    this.closed = true;
    this.closeAll();
  }

  private assertCapacity(identity: { userId: string; sessionId: string }): void {
    let account = 0;
    let session = 0;
    for (const stream of this.streams) {
      if (stream.userId === identity.userId) account += 1;
      if (stream.sessionId === identity.sessionId) session += 1;
    }
    if (
      this.streams.size >= this.options.maxStreams ||
      account >= this.options.maxStreamsPerAccount ||
      session >= this.options.maxStreamsPerSession
    ) {
      throw new AuthError(429, 'stream_limit', 'Too many dashboard event streams are open.');
    }
  }

  private onCommit(commit: MetadataCommit): void {
    if (this.streams.size === 0) return;
    let impact: DashboardImpact;
    try {
      const watchedSessions = new Set<string>();
      for (const stream of this.streams) watchedSessions.add(stream.sessionId);
      impact = computeDashboardImpact(commit.previous, commit.current, watchedSessions);
    } catch {
      // A change must never be swallowed: when the comparison fails, refresh every account and
      // re-check every session.
      for (const stream of this.streams) {
        this.mark(stream, true, []);
        void this.authorize(stream);
      }
      return;
    }
    for (const stream of this.streams) {
      const owner = impact.owners.get(stream.userId);
      if (owner) this.mark(stream, owner.account, owner.vaults);
      if (impact.sessions.has(stream.sessionId) || impact.users.has(stream.userId)) void this.authorize(stream);
    }
  }

  private mark(stream: Stream, account: boolean, vaults: Iterable<string>): void {
    if (stream.closed) return;
    if (account) stream.account = true;
    if (!stream.account) {
      for (const vaultId of vaults) {
        stream.vaults.add(vaultId);
        if (stream.vaults.size > this.options.maxVaultIdsPerMessage) {
          // A bounded set that overflows degrades to a full scoped refresh.
          stream.account = true;
          break;
        }
      }
    }
    if (stream.account) stream.vaults.clear();
    if (stream.account || stream.vaults.size > 0) this.schedule(stream);
  }

  private schedule(stream: Stream): void {
    if (stream.closed || stream.blocked || stream.flushTimer !== null) return;
    stream.flushTimer = setTimeout(() => {
      stream.flushTimer = null;
      void this.flush(stream);
    }, this.options.coalesceMs);
    stream.flushTimer.unref();
  }

  private async flush(stream: Stream): Promise<void> {
    if (stream.closed || stream.blocked || stream.flushing) return;
    if (!stream.account && stream.vaults.size === 0) return;
    stream.flushing = true;
    try {
      // Authorization is re-read from current metadata before every publication.
      if (!(await this.authorize(stream))) return;
      if (stream.closed || stream.blocked) return;
      const account = stream.account;
      const vaultIds = account ? [] : [...stream.vaults].sort();
      stream.account = false;
      stream.vaults.clear();
      if (!account && vaultIds.length === 0) return;
      this.write(stream, `event: invalidate\ndata: ${JSON.stringify({ account, vault_ids: vaultIds })}\n\n`);
    } finally {
      stream.flushing = false;
    }
    if (!stream.closed && (stream.account || stream.vaults.size > 0)) this.schedule(stream);
  }

  private async heartbeat(stream: Stream): Promise<void> {
    if (stream.closed || stream.heartbeatBusy) return;
    stream.heartbeatBusy = true;
    try {
      if (!(await this.authorize(stream)) || stream.closed || stream.blocked) return;
      this.write(stream, ': keep-alive\n\n');
    } finally {
      stream.heartbeatBusy = false;
    }
  }

  private async authorize(stream: Stream): Promise<boolean> {
    try {
      const current = await this.authenticate(stream.sessionId);
      if (current.user.user_id !== stream.userId) throw new AuthError(401, 'unauthenticated', 'Authentication required.');
      return !stream.closed;
    } catch {
      // Both an authorization failure and an unavailable metadata store fail closed.
      this.closeStream(stream);
      return false;
    }
  }

  private write(stream: Stream, text: string): void {
    if (stream.closed) return;
    const { sink } = stream;
    if (sink.destroyed || sink.writableEnded) {
      this.closeStream(stream);
      return;
    }
    const accepted = sink.write(text);
    if (!accepted || sink.writableLength > this.options.maxWritableBytes) {
      stream.blocked = true;
      if (stream.flushTimer !== null) {
        clearTimeout(stream.flushTimer);
        stream.flushTimer = null;
      }
      if (stream.stallTimer === null) {
        // A reader that does not drain is closed instead of accumulating data; pending
        // invalidations are a bounded set (not a queue), so memory stays constant meanwhile.
        stream.stallTimer = setTimeout(() => this.closeStream(stream), this.options.stallTimeoutMs);
        stream.stallTimer.unref();
        sink.once('drain', stream.onDrain);
      }
    }
  }

  private drained(stream: Stream): void {
    if (stream.closed) return;
    if (stream.stallTimer !== null) {
      clearTimeout(stream.stallTimer);
      stream.stallTimer = null;
    }
    stream.blocked = false;
    if (stream.account || stream.vaults.size > 0) this.schedule(stream);
  }

  private closeStream(stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
    if (stream.heartbeatTimer !== null) clearInterval(stream.heartbeatTimer);
    if (stream.stallTimer !== null) clearTimeout(stream.stallTimer);
    stream.flushTimer = stream.heartbeatTimer = stream.stallTimer = null;
    stream.account = false;
    stream.vaults.clear();
    this.streams.delete(stream);
    stream.sink.removeListener('drain', stream.onDrain);
    stream.sink.removeListener('close', stream.onSinkClose);
    try {
      if (stream.blocked) stream.sink.destroy();
      else if (!stream.sink.destroyed && !stream.sink.writableEnded) stream.sink.end();
    } catch {
      // The peer is already gone.
    }
    try {
      stream.onClosed();
    } catch {
      // Logging cannot affect cleanup.
    }
    if (this.streams.size === 0 && this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

function assertSameOrigin(request: FastifyRequest): void {
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new AuthError(403, 'cross_origin_forbidden', 'Dashboard events are same-origin only.');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host === null || host !== request.headers.host) {
      throw new AuthError(403, 'cross_origin_forbidden', 'Dashboard events are same-origin only.');
    }
  }
}

const DEVICE_VISIBLE_FIELDS = [
  'device_name',
  'status',
  'revoked_at',
  'device_ref_head',
  'last_applied_main',
  'local_status_label',
  'local_error_code',
  'local_queue_status',
  'local_main',
  'local_head',
  'plugin_version',
  'onboarding_status'
] as const;

function deviceSignature(device: ReadonlyDb['devices'][number]): string {
  const record = device as unknown as Record<string, unknown>;
  return JSON.stringify(DEVICE_VISIBLE_FIELDS.map((field) => record[field] ?? null));
}

function vaultAccountSignature(vault: ReadonlyDb['vaults'][number]): string {
  return JSON.stringify([vault.owner_user_id, vault.display_name, vault.status]);
}

function vaultSignature(vault: ReadonlyDb['vaults'][number]): string {
  return JSON.stringify(vault, (key, value: unknown) => key === 'updated_at' ? undefined : value);
}

/**
 * Narrow comparison of two committed states. Only owner-visible dashboard state is compared. Session
 * liveness (last_seen_at / idle expiry), device heartbeats (last_seen_at / last_status_report_at /
 * last_successful_sync_at), sync operations, audit rows and derived caches never produce an impact,
 * which is what makes a fetch -> session touch -> invalidate loop impossible.
 */
export function computeDashboardImpact(
  previous: ReadonlyDb,
  current: ReadonlyDb,
  watchedSessions: ReadonlySet<string> = new Set()
): DashboardImpact {
  const impact: DashboardImpact = { owners: new Map(), sessions: new Set(), users: new Set() };
  const owner = (userId: string): OwnerImpact => {
    let entry = impact.owners.get(userId);
    if (!entry) {
      entry = { account: false, vaults: new Set() };
      impact.owners.set(userId, entry);
    }
    return entry;
  };
  const markVault = (userId: string, vaultId: string, account = false): void => {
    const entry = owner(userId);
    entry.vaults.add(vaultId);
    if (account) entry.account = true;
  };

  const previousVaults = new Map(previous.vaults.map((vault) => [vault.vault_id, vault]));
  const currentVaults = new Map(current.vaults.map((vault) => [vault.vault_id, vault]));
  const ownerOf = (vaultId: string): string | null =>
    currentVaults.get(vaultId)?.owner_user_id ?? previousVaults.get(vaultId)?.owner_user_id ?? null;
  const markOwned = (vaultId: string): void => {
    const ownerId = ownerOf(vaultId);
    if (ownerId !== null) markVault(ownerId, vaultId);
  };

  for (const [vaultId, vault] of currentVaults) {
    const before = previousVaults.get(vaultId);
    if (before === undefined) {
      markVault(vault.owner_user_id, vaultId, true);
      continue;
    }
    if (vaultSignature(before) === vaultSignature(vault)) continue;
    const accountLevel = vaultAccountSignature(before) !== vaultAccountSignature(vault);
    markVault(vault.owner_user_id, vaultId, accountLevel);
    if (before.owner_user_id !== vault.owner_user_id) markVault(before.owner_user_id, vaultId, true);
  }
  for (const [vaultId, vault] of previousVaults) {
    if (!currentVaults.has(vaultId)) markVault(vault.owner_user_id, vaultId, true);
  }

  const previousDevices = new Map(previous.devices.map((device) => [device.device_id, device]));
  const currentDevices = new Map(current.devices.map((device) => [device.device_id, device]));
  for (const [deviceId, device] of currentDevices) {
    const before = previousDevices.get(deviceId);
    if (before === undefined || deviceSignature(before) !== deviceSignature(device)) markOwned(device.vault_id);
  }
  for (const [deviceId, device] of previousDevices) {
    if (!currentDevices.has(deviceId)) markOwned(device.vault_id);
  }

  const removalSignature = (job: ReadonlyDb['device_removal_jobs'][number]): string =>
    JSON.stringify([job.vault_id, job.state, job.retryable]);
  const previousRemovals = new Map(previous.device_removal_jobs.map((job) => [job.device_id, job]));
  const currentRemovals = new Map(current.device_removal_jobs.map((job) => [job.device_id, job]));
  for (const [deviceId, job] of currentRemovals) {
    const before = previousRemovals.get(deviceId);
    if (before === undefined || removalSignature(before) !== removalSignature(job)) markOwned(job.vault_id);
  }
  for (const [deviceId, job] of previousRemovals) {
    if (!currentRemovals.has(deviceId)) markOwned(job.vault_id);
  }

  const previousConflicts = new Map(previous.conflicts.map((conflict) => [conflict.conflict_id, conflict]));
  const currentConflicts = new Map(current.conflicts.map((conflict) => [conflict.conflict_id, conflict]));
  for (const [conflictId, conflict] of currentConflicts) {
    const before = previousConflicts.get(conflictId);
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(conflict)) markOwned(conflict.vault_id);
  }
  for (const [conflictId, conflict] of previousConflicts) {
    if (!currentConflicts.has(conflictId)) markOwned(conflict.vault_id);
  }

  for (const vaultId of new Set([...Object.keys(previous.event_seq_by_vault), ...Object.keys(current.event_seq_by_vault)])) {
    if (previous.event_seq_by_vault[vaultId] !== current.event_seq_by_vault[vaultId]) markOwned(vaultId);
  }
  for (const vaultId of new Set([
    ...Object.keys(previous.directory_state_by_vault),
    ...Object.keys(current.directory_state_by_vault)
  ])) {
    if (JSON.stringify(previous.directory_state_by_vault[vaultId]) !== JSON.stringify(current.directory_state_by_vault[vaultId])) {
      markOwned(vaultId);
    }
  }

  compareDeletions(previous, current, markVault);
  compareDiagnostics(previous, current, markVault, owner);

  const userSignature = (user: ReadonlyDb['users'][number]): string =>
    JSON.stringify([user.username, user.display_name, user.is_admin, user.disabled]);
  const previousUsers = new Map(previous.users.map((user) => [user.user_id, user]));
  const currentUsers = new Map(current.users.map((user) => [user.user_id, user]));
  for (const [userId, user] of currentUsers) {
    const before = previousUsers.get(userId);
    if (before !== undefined && userSignature(before) !== userSignature(user)) {
      owner(userId).account = true;
      if (before.disabled !== user.disabled) impact.users.add(userId);
    }
  }
  for (const userId of previousUsers.keys()) {
    if (!currentUsers.has(userId)) impact.users.add(userId);
  }

  if (watchedSessions.size > 0) {
    const sessionState = (db: ReadonlyDb): Map<string, string> => {
      const states = new Map<string, string>();
      for (const session of db.sessions) {
        if (watchedSessions.has(session.session_id)) {
          states.set(session.session_id, `${session.user_id}|${session.revoked_at ?? ''}|${session.expires_at}`);
        }
      }
      return states;
    };
    const before = sessionState(previous);
    const after = sessionState(current);
    for (const sessionId of watchedSessions) {
      if (before.get(sessionId) !== after.get(sessionId)) impact.sessions.add(sessionId);
    }
  }
  return impact;
}

function compareDeletions(
  previous: ReadonlyDb,
  current: ReadonlyDb,
  markVault: (userId: string, vaultId: string, account?: boolean) => void
): void {
  const records = (db: ReadonlyDb): Map<string, { owner: string; vaultId: string; signature: string }> => {
    const result = new Map<string, { owner: string; vaultId: string; signature: string }>();
    for (const job of db.deletion_jobs) {
      result.set(`job:${job.vault_id}`, { owner: job.owner_user_id, vaultId: job.vault_id, signature: JSON.stringify(job) });
    }
    for (const receipt of db.deletion_receipts) {
      result.set(`receipt:${receipt.vault_id}`, {
        owner: receipt.owner_user_id,
        vaultId: receipt.vault_id,
        signature: JSON.stringify(receipt)
      });
    }
    return result;
  };
  const before = records(previous);
  const after = records(current);
  for (const [key, value] of after) {
    if (before.get(key)?.signature !== value.signature) markVault(value.owner, value.vaultId, true);
  }
  for (const [key, value] of before) {
    if (!after.has(key)) markVault(value.owner, value.vaultId, true);
  }
}

function compareDiagnostics(
  previous: ReadonlyDb,
  current: ReadonlyDb,
  markVault: (userId: string, vaultId: string, account?: boolean) => void,
  owner: (userId: string) => OwnerImpact
): void {
  const summarize = (db: ReadonlyDb): Map<string, string> => {
    const groups = new Map<string, { count: number; last: string }>();
    for (const event of db.diagnostic_events) {
      const key = `${event.owner_user_id}\u0000${event.vault_id ?? ''}`;
      const entry = groups.get(key) ?? { count: 0, last: '' };
      entry.count += 1;
      entry.last = event.event_id;
      groups.set(key, entry);
    }
    return new Map([...groups].map(([key, entry]) => [key, `${entry.count}:${entry.last}`]));
  };
  const before = summarize(previous);
  const after = summarize(current);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const [userId = '', vaultId = ''] = key.split('\u0000');
    owner(userId).account = true;
    if (vaultId !== '') markVault(userId, vaultId, true);
  }
}
