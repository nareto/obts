# Obsidian True Sync (`obts`) - Product + Technical Spec

## 0. Executive Summary

`obts` is a self-hosted sync system for Obsidian vaults. It preserves local-first editing, central canonical state, recoverable history, conflict review, and clear device status without putting a normal `.git` directory in the visible vault.

v1 uses a trusted self-hosted server model with encrypted-at-rest storage. The server is authorized to decrypt vault content and protected metadata for sync, merge, conflict review, note history, compaction, and recovery. Each vault belongs to exactly one user; other users must not be able to see the vault. At-rest encryption protects file bytes and sensitive vault metadata from offline disclosure when the deployment key material is not also compromised.

This is not a true end-to-end encrypted or zero-knowledge design. The live server process and the server operator are trusted for v1.

## 1. Product Frame

### 1.1 Summary

The architectural center is a single canonical server state called `main`. Clients can edit immediately, including while offline. Their edits are captured as durable local proposals, uploaded to per-device lanes, merged by the server when possible, and surfaced as conflicts when human review is required.

The server owns conflict review and semantic merge because it can read vault content after authorizing the user and decrypting stored content at the persistence boundary.

### 1.2 Audience

- Individuals self-hosting a private Obsidian sync server.
- Small trusted groups or households where the server operator is trusted, but each vault remains owned by exactly one user and vault sharing is not supported in v1.
- Maintainers who want note history, recovery, diagnostics, and clear operational state without exposing Git workflows to note authors.

### 1.3 Goals

- Sync notes and selected Obsidian configuration between paired devices.
- Preserve local-first editing and offline proposals.
- Maintain a single server `main` per vault.
- Use server-side semantic merge for Markdown/text conflicts where safe.
- Provide a dashboard for devices, conflicts, note history, recovery, and maintenance.
- Encrypt persistent server-side vault content and sensitive vault metadata at rest.
- Enforce strict account and vault authorization for every API and event stream.
- Avoid `.git` directories inside visible Obsidian vaults.
- Keep plugin UX simple: server URL, login/pairing, device name, and sync profile.
- Document the app persistent-state backup contract without embedding deployment-specific backup automation.

### 1.4 Non-Goals

- True E2EE or zero-knowledge server operation in v1.
- Hiding plaintext paths or content from the live server process.
- Requiring a separate vault passphrase after dashboard login.
- Shared vault membership, collaborative vault access, or granting a user access to another user's vault.
- Shared real-time collaborative editing, cursors, CRDT/OT sessions, or presence.
- Syncing every `.obsidian/` file blindly.
- Storing a normal Git repository in the visible vault.
- App-managed backup scheduling, offsite backup storage, or deployment-specific restore orchestration.
- Building app images or environment-specific infrastructure deployment assumptions into this app repo.

## 2. Security Model

### 2.1 Trust Boundary

v1 trusts the server process. The server may decrypt vault content in memory and in temporary workspaces to perform:

- content upload validation;
- server-side text and Markdown merges;
- conflict package rendering;
- dashboard conflict review;
- search or inspection features added later;
- compaction, note history, restore-from-history, and recovery.

The server must still enforce user isolation. A user can access only vaults they own. Cross-user access to vaults, devices, proposals, conflicts, content objects, history entries, events, and diagnostics must return `403` or `404` without leaking useful information. v1 does not support shared vault membership.

### 2.2 Encrypted-At-Rest Storage

Persistent vault content uses per-vault data keys:

- each vault has a random data key;
- the raw data key is never stored directly;
- Postgres stores wrapped vault data keys and key metadata;
- a deployment-provided server master key unwraps vault data keys when the server needs them;
- file bytes, plugin/config files, conflict payloads, and history snapshots are encrypted before being written to persistent stores;
- sensitive metadata is encrypted or keyed before persistence, including vault-relative paths, display paths in conflict records, raw content fingerprints, and exact per-file metadata that would expose note contents or structure;
- manifests and indexes use keyed path IDs or encrypted path metadata instead of raw vault-relative paths;
- persistent-state backups must capture wrapped data keys and key metadata, but restoration also requires the deployment key material or a rotated replacement key.

The server master key is a generic deployment secret. The app repo must not prescribe a private environment-specific infrastructure-specific secret path.

### 2.3 What Encryption Protects

Encrypted-at-rest storage protects against:

- copied database dumps that do not include server key material from revealing note bodies, plugin settings, raw vault paths, raw content hashes, or raw data keys;
- copied content-store or history-store directories that do not include server key material;
- misplaced persistent-state backups when deployment key material is stored separately;
- casual offline inspection of server storage.

Encrypted-at-rest storage may still expose non-secret operational metadata needed by the server, such as account identifiers, vault identifiers, object counts, commit counts, timestamps, lifecycle states, and coarse size or health summaries. The implementation must document any retained metadata leakage and keep it out of note bodies, raw paths, raw content fingerprints, and secret material.

It does not protect against:

- a compromised live server process;
- malicious code deployed to the server;
- a server operator with access to runtime key material;
- a dashboard session authorized to read a vault;
- plaintext temporarily present in process memory or merge workspaces.

### 2.4 Logging And Diagnostics

Even though the server can decrypt content, default logs and diagnostics must avoid note content unless an explicit owner-initiated export requests it. Logs must redact tokens, passwords, server master key identifiers, raw data keys, request bodies containing vault content, and large content payloads.

Audit records should identify who accessed or changed a vault and which resource class was affected. They should not store full note bodies.

## 3. Experience And Workflows

### 3.1 Actors

- **Vault owner:** installs the server, creates vaults, pairs devices, reviews conflicts, and runs maintenance.
- **Device user:** edits notes in Obsidian and observes sync status on paired devices.
- **Maintainer/operator:** upgrades the server, configures deployment backups, restores persistent state when needed, and rotates deployment key material.
- **Server:** authenticates users/devices, persists encrypted-at-rest content, advances `main`, and performs merge/conflict workflows.
- **Obsidian plugin:** watches local vault changes, snapshots edits, uploads proposals, pulls server changes, and applies accepted state.
- **Dashboard SPA:** browser UI for setup, device state, conflict review, and maintenance.

### 3.2 Server Install

The operator deploys the server with Postgres, a persistent encrypted content store, an internal history store, and runtime server master key material.

Acceptance criteria:

- `GET /health/live` works without dependencies.
- `GET /health/ready` checks Postgres, content store, history store, and key-manager readiness.
- Missing or invalid server master key material fails closed.
- Missing or inconsistent restored persistent state fails closed.
- The first admin setup cannot be repeated after setup is complete.

### 3.3 Create Vault And Pair First Device

The owner creates a vault in the dashboard and pairs the first Obsidian plugin device.

Behavior:

1. Server creates the vault record.
2. Server creates a random per-vault data key and stores it wrapped by the current server master key version.
3. Dashboard issues a one-time pairing token or URL.
4. Plugin consumes the pairing token, registers device metadata, and stores a device token locally.
5. Plugin performs an initial scan of the local vault and local `.obts/` state.
6. If server `main` is empty, the first client may seed the server by publishing an initial proposal.
7. If server `main` exists and the local vault is empty, the client pulls and applies `main`.
8. If server `main` exists and the local vault contains user content, the plugin creates a recovery bundle, computes a local-vs-server summary, and requires the owner to choose a safe join path:
   - upload local differences as proposals;
   - keep local content aside and apply server state;
   - cancel pairing.
9. If local `.obts/` state belongs to another device/vault or is partially initialized, pairing blocks until the owner runs a recovery or reset flow.

Acceptance criteria:

- Pairing token is one-time, scoped, and short-lived.
- Device token is scoped to one user and one vault.
- No vault passphrase is required.
- First sync never silently discards local content.
- Non-empty local vault joins require a recovery bundle before server state is applied.

### 3.4 Local Edit Sync

When a user edits local vault files, the plugin snapshots the edit into `.obts/`, uploads proposal content over authenticated HTTPS, and keeps retry state durable.

Acceptance criteria:

- Local edits are durably recorded before upload.
- `.obts/` is excluded from vault sync and manifest creation.
- Upload retries are idempotent.
- Server stores uploaded content encrypted at rest after authorization.

### 3.5 Pull And Apply Server Main

When server `main` advances, paired clients pull diffs, create local recovery snapshots, and apply accepted server changes through Obsidian APIs.

Acceptance criteria:

- Local uncommitted changes are never overwritten without a recovery snapshot.
- Local changes are never silently discarded; if safe apply is impossible, sync blocks and surfaces recovery options.
- Apply operations use supported Obsidian vault APIs where possible.
- The plugin can recover after crash during apply.

### 3.6 Concurrent Edits And Merge

The server receives proposals from multiple devices and advances `main` only through a merge or resolution transaction.

Behavior:

1. Disjoint path changes merge automatically.
2. Same-path text and Markdown changes are checked out into an ephemeral server merge workspace.
3. The merge service attempts conservative line/frontmatter/block-aware merge.
4. Clean merges advance `main` with a merge commit.
5. Ambiguous or unsafe merges create a conflict record.

Acceptance criteria:

- Server merge decisions are deterministic and auditable.
- Conflict originals remain recoverable.
- Binary conflicts default to identity-only merge or keep-both review.

### 3.7 Conflict Review In Dashboard

The dashboard is available after normal authenticated login. It does not ask for a separate vault passphrase.

Behavior:

1. User opens the conflict center.
2. Server authorizes the user for the vault.
3. Server returns conflict metadata and content needed for review over HTTPS.
4. Dashboard displays rendered Markdown diff, source diff, affected paths, and available merge choices.
5. User accepts server version, accepts device version, keeps both, inserts both blocks, or manually edits a final result.
6. Dashboard submits the selected resolution.
7. Server writes the resolution encrypted at rest, advances `main`, and marks the conflict resolved.

Acceptance criteria:

- Unauthorized users cannot list, view, or resolve conflicts for another vault.
- Resolution commits reference the conflict they resolved.
- All clients receive a `main_advanced` event after resolution.

### 3.8 Device Dashboard

The dashboard shows:

- paired devices;
- device names and last-seen status;
- current server `main`;
- each device ahead/behind/offline/blocked state;
- unresolved conflicts;
- maintenance state;
- persistent-state and health summaries.

### 3.9 Note History And Restore

The owner can inspect and restore prior versions of individual notes without exposing raw Git workflows.

Behavior:

1. User opens note history for a vault path from the dashboard or plugin.
2. Server authorizes the owning user for the vault.
3. Server returns version metadata, including commit, timestamp, author device/user, operation type, and proposal/conflict provenance.
4. User views source or rendered diffs for Markdown/text versions.
5. User restores a prior version by creating a normal proposal or resolution commit; history is never mutated in place.

Acceptance criteria:

- Note history can show creates, updates, deletes, and renames.
- Restoring a prior note version advances `main` through the same proposal/resolution path as other edits.
- Compaction preserves the current baseline and any history retained by policy, or clearly marks older pruned history as unavailable.

### 3.10 Recovery And Rebuild

If a client loses local state or apply fails, it can rebuild from server `main`.

Behavior:

1. Plugin stops normal sync.
2. Plugin snapshots local pending edits into a recovery bundle.
3. Plugin pulls current server `main`.
4. Plugin applies server state to local vault.
5. Plugin uploads any preserved local edits as proposals or exposes them for manual review.

Acceptance criteria:

- Recovery never silently discards local edits.
- Recovery bundles are available before destructive apply or rebuild operations.

## 4. Technical Design

### 4.1 System Principles

1. `main` is the only published server state for a vault.
2. Clients propose; only server merge/resolution transactions advance `main`.
3. The server is trusted to decrypt content for v1 workflows.
4. Persistent vault content is encrypted at rest with per-vault data keys.
5. Sensitive vault metadata is encrypted or keyed before persistence.
6. Authorization is enforced at every vault-scoped boundary, and v1 vaults are owner-only.
7. No `.git` directory appears in the visible Obsidian vault.
8. Local proposals and recovery snapshots are durable before destructive operations.
9. Obsidian configuration sync uses an explicit file policy; `.obts/` is always excluded.

### 4.2 Containers

- **Server API and CLI:** TypeScript/Node/Fastify service for auth, vaults, devices, proposals, merge, conflicts, note history, key management, persistent-state checks, and health.
- **Dashboard SPA:** browser UI served by the server for setup, device dashboard, conflict review, and maintenance.
- **Obsidian plugin:** TypeScript plugin that watches local vaults, snapshots edits, uploads proposals, pulls changes, and applies `main`.
- **Postgres:** users, owner-only vaults, wrapped data keys, devices, token hashes, protected content catalog, commits, manifest entries, proposals, conflicts, and audit records.
- **Encrypted-at-rest content store:** local filesystem storage for encrypted vault file bytes, attachments, plugin/config files, conflict payloads, and compacted snapshots.
- **Internal history store:** commit graph, branch-like refs, protected manifests, note history indexes, and merge provenance; content bytes are persisted through the encrypted content store.
- **Temporary merge workspace:** ephemeral plaintext server working directory for merge operations; cleaned after transaction.
- **Local `.obts` store:** client-local queue, cache, proposals, recovery bundles, locks, diagnostics, and device token state.

### 4.3 Server Components

- **AuthService:** authenticates dashboard sessions, device tokens, and pairing tokens.
- **VaultService:** creates vaults, enforces owner isolation, and coordinates initial key creation.
- **DeviceService:** registers, tracks, and revokes paired devices.
- **AtRestKeyManager:** loads server master key material, creates/wraps/unwraps per-vault data keys, and rewraps keys during rotation.
- **ContentStoreService:** encrypts/decrypts vault content at persistence boundaries and maintains protected object/catalog metadata.
- **MetadataProtectionService:** derives keyed path IDs and encrypts sensitive path, fingerprint, and manifest metadata before persistence.
- **ProposalService:** accepts idempotent per-device proposals and submits them to merge.
- **HistoryService:** maintains canonical `main`, commit graph, manifests, refs, and provenance.
- **NoteHistoryService:** resolves authorized note/path history, diffs versions, and creates restore proposals.
- **MergeCoordinator:** performs server-side merge/resolution transactions.
- **SemanticMergeService:** performs conservative text/Markdown/frontmatter/block-aware merge.
- **ConflictService:** creates, lists, and resolves structured conflicts.
- **NotificationHub:** publishes main, conflict, device, and maintenance events with polling fallback.
- **PersistentStateService:** documents required persistent state and performs readiness/integrity checks after restore.
- **AuditLogService:** writes redacted operational audit events.
- **HealthService:** reports liveness, readiness, version, migration, storage, and key-manager health.

### 4.4 Plugin Components

- **SettingsView:** collects server URL, login/pairing token, device name, sync profile, apply mode, and plugin-sync setting.
- **StatusBar:** displays Synced, Ahead, Behind, Uploading, Applying, Offline, Blocked, Unsafe local error, and Needs recovery.
- **VaultWatcher:** observes local vault changes through Obsidian APIs.
- **PeriodicScanner:** detects missed watcher events and crash recovery work.
- **PathNormalizer:** creates canonical vault-relative paths using `/` and normalized Unicode.
- **SnapshotEngine:** persists local edits as durable proposals before upload or destructive apply operations.
- **LocalQueue:** stores pending proposal, retry, cache, recovery, lock, diagnostic, and config-sync state.
- **LocalContentCache:** caches pulled/uploaded content needed for retry, apply, and recovery.
- **TransportClient:** calls server APIs and subscribes to events with polling fallback.
- **ApplyEngine:** applies accepted server `main` changes, including selected `.obsidian` state, to the vault after local recovery snapshots.
- **DiagnosticsExporter:** exports redacted diagnostics for support and recovery.

### 4.5 Web UI Components

- **AuthSession:** manages dashboard session state.
- **DeviceDashboard:** shows device and server state.
- **ConflictList:** lists unresolved conflicts and opens review workflows.
- **MarkdownDiffViewer:** renders Markdown conflict variants and merge previews returned by server APIs.
- **SourceDiffViewer:** shows source-level conflict diffs.
- **ResolutionEditor:** lets the owner choose or author the final resolution and submits it to the server.
- **NoteHistoryView:** shows note versions, diffs, provenance, and restore actions.

## 5. Storage And Data Model

### 5.1 Identifiers

- `user_id`: `usr_` plus ULID.
- `vault_id`: `vlt_` plus ULID.
- `device_id`: `dev_` plus ULID.
- `commit_id`: `m_` plus content/provenance hash or ULID.
- `proposal_id`: `prop_` plus ULID or idempotency hash.
- `content_id`: `cnt_` plus keyed hash or ULID.
- `path_id`: `pth_` plus keyed path identifier.
- `conflict_id`: `conf_` plus ULID.

### 5.2 Core Tables

- `users`: account identity and password hash.
- `vaults`: owner user ID, display name, active main, status, created/updated timestamps.
- `vault_keys`: vault ID, key version, wrapped data key, wrapping algorithm, master key version, timestamps.
- `devices`: vault-scoped paired devices, owning user ID, and server-known state.
- `api_tokens`: hashed dashboard, device, and pairing tokens.
- `content_objects`: encrypted-at-rest content catalog, keyed content fingerprints, protected size metadata, and storage refs.
- `commits`: commit graph, parents, author device/user, timestamps, and operation type.
- `manifest_entries`: commit tree entries keyed by `path_id`, encrypted display path metadata, content refs, and file mode/type metadata.
- `proposals`: idempotent per-device proposal metadata and lifecycle.
- `conflicts`: conflict state, affected `path_id`s, encrypted affected path metadata, base/current/proposed refs, and resolution refs.
- `audit_log`: redacted operational events.

### 5.3 Content Persistence

The server may receive plaintext vault content over authenticated HTTPS. After authorization and validation, `ContentStoreService` encrypts content with the vault data key before writing persistent content bytes. Plugin settings and selected `.obsidian` files are treated as vault content for encryption, history, conflict, and logging rules.

Reads decrypt content only for authorized server workflows and return plaintext only to authorized clients over HTTPS.

### 5.4 Protected Metadata

`MetadataProtectionService` protects metadata that would reveal note contents or vault structure in an offline database copy.

Rules:

- canonical vault-relative paths are normalized client/server-side, then stored as keyed `path_id`s plus encrypted display path metadata;
- raw content hashes are not persisted where an offline attacker could use known-content matching; content fingerprints are keyed per vault;
- exact file sizes, MIME hints, and path display strings are encrypted or reduced to coarse operational metadata where exact values are not required;
- conflict packages store encrypted path labels and decrypted variants only for authorized review;
- audit logs may include resource classes and opaque IDs, but not raw paths, raw hashes, note bodies, or plugin settings.

### 5.5 History Model

Server `main` points to a manifest snapshot. Each commit records parents, changed `path_id`s, content refs, conflict/resolution provenance, and author metadata. The history store is internal server state and must not be exposed as a user-visible Git repository.

Note history is derived from commits, protected path metadata, rename/delete provenance, and manifest entries. Note restore creates a new proposal or resolution commit; it never rewrites existing commits.

Temporary merge workspaces may contain plaintext checked-out file trees. They must be scoped to one merge transaction, permission-restricted, and cleaned after success or failure.

### 5.6 Key Rotation

Server key rotation rewraps per-vault data keys under a new master key version. It does not rewrite all vault content unless the content encryption format itself changes.

Failure rules:

- missing master key fails server readiness;
- failed rewrap leaves the previous key version active;
- restoring persistent app state requires matching or migrated master key material;
- key operations write audit records without printing key values.

## 6. Interfaces And Contracts

### 6.1 API Conventions

- HTTPS JSON APIs under `/api/v1`.
- Device APIs authenticate with device tokens.
- Dashboard APIs authenticate with session cookies or bearer tokens.
- Every vault-scoped endpoint checks account ownership, vault ownership, and device scope where applicable.
- Idempotent write APIs accept idempotency keys.
- Events are available through WebSocket with polling fallback.

### 6.2 Auth, Sessions, And Tokens

Auth requirements:

- user passwords are hashed with a memory-hard KDF such as Argon2id;
- dashboard cookie sessions use `HttpOnly`, `Secure`, and `SameSite` protections;
- cookie-authenticated mutation APIs require CSRF protection;
- bearer, dashboard, device, and pairing tokens are opaque and stored server-side only as hashes;
- pairing tokens are one-time, scoped to one owning user and vault, short-lived, and rate-limited;
- device tokens are scoped to one user, one vault, and one device;
- token rotation and device revocation take effect without waiting for client reconnect;
- login, pairing, failed auth, token rotation, and revocation write redacted audit records;
- plugin device tokens use platform secure storage when available, otherwise `.obts/` with restrictive local permissions.

### 6.3 Proposal And Commit Contract

Proposal fields:

- `proposal_id`;
- `vault_id`;
- `device_id`;
- `base_commit_id`;
- `device_sequence`;
- `idempotency_key`;
- proposal timestamps;
- operation list;
- content refs for uploaded content.

Supported proposal operations:

- create file;
- update file;
- delete file;
- rename file;
- create/update/delete selected `.obsidian` config file;
- create/update/delete selected plugin file when plugin sync is enabled.

Proposal lifecycle:

1. `queued_local`
2. `uploaded`
3. `validating`
4. `merging`
5. `accepted`, `conflicted`, or `rejected`

Rules:

- Clients never advance `main` directly.
- Server commits are created only from accepted proposals, clean merges, explicit conflict resolutions, or note-history restores.
- A stale `base_commit_id` triggers merge evaluation; it must not overwrite current `main` directly.
- Retries with the same idempotency key return the same result.
- Duplicate submissions with the same idempotency key but different payload are rejected.
- Malformed proposals are rejected without advancing `main`.

### 6.4 Merge Policy Contract

Merge behavior must be deterministic, auditable, and conservative.

Policy:

- disjoint path edits auto-merge when no delete/rename collision exists;
- same-file Markdown/text edits may auto-merge only when line, frontmatter, heading/block, and link/embed changes are non-overlapping and the final text is deterministic;
- frontmatter auto-merges only for disjoint keys; same-key edits conflict;
- delete-vs-edit conflicts unless the edit is already contained in the deleted side's preserved history and the owner explicitly resolves it;
- rename-vs-edit may auto-merge only when one side renames and the other side edits content without path collision;
- rename-vs-rename conflicts unless both sides produce the same target path;
- binary and attachment changes auto-merge only when fingerprints are identical or paths are disjoint;
- selected `.obsidian` config and plugin files use file-level rules unless a later handler defines a stricter semantic merge;
- unsafe, unsupported, or ambiguous cases create structured conflicts with base/current/proposed variants and provenance.

### 6.5 Main APIs

- `POST /api/v1/pair/consume`: consume a pairing token and register a device.
- `GET /api/v1/vaults/{vault_id}/main`: return current main metadata and manifest summary.
- `POST /api/v1/vaults/{vault_id}/content/batch`: upload changed file content or content refs.
- `POST /api/v1/vaults/{vault_id}/proposals`: submit a device proposal.
- `POST /api/v1/vaults/{vault_id}/pull`: request changes since a known commit.
- `POST /api/v1/vaults/{vault_id}/history/query`: list note history for an authorized path supplied in a redacted request body.
- `POST /api/v1/vaults/{vault_id}/history/version`: fetch a historical note version or diff source for a commit/path supplied in a redacted request body.
- `POST /api/v1/vaults/{vault_id}/history/restore`: restore a historical note version through a new proposal/resolution commit.
- `GET /api/v1/vaults/{vault_id}/conflicts?status=open`: list conflicts visible to the authorized user/device.
- `GET /api/v1/vaults/{vault_id}/conflicts/{conflict_id}`: fetch conflict review content.
- `POST /api/v1/vaults/{vault_id}/conflicts/{conflict_id}/resolve`: submit a resolution.
- `POST /api/v1/vaults/{vault_id}/maintenance/compact/start`: create a compacted baseline after confirmation.
- `POST /api/v1/admin/keys/rewrap/start`: rewrap vault data keys under a new server master key version.

### 6.6 Events

Events include:

- `main_advanced`;
- `proposal_accepted`;
- `proposal_rejected`;
- `conflict_created`;
- `conflict_resolved`;
- `note_restored`;
- `device_state_changed`;
- `vault_maintenance_started`;
- `vault_maintenance_finished`;
- `key_rotation_required`;
- `key_rotation_finished`.

Event payloads must be authorized by vault scope and should avoid full note bodies.

## 7. Config

### 7.1 Server Environment

Required:

- `DATABASE_URL`
- `OBTS_DATA_DIR`
- `OBTS_MASTER_KEY`
- `OBTS_PUBLIC_BASE_URL`
- `OBTS_SESSION_SECRET`

Optional:

- `OBTS_CONTENT_STORE_DIR`
- `OBTS_HISTORY_STORE_DIR`
- `OBTS_TEMP_DIR`
- `OBTS_LOG_LEVEL`
- `OBTS_MAX_UPLOAD_BYTES`
- `OBTS_EVENT_POLL_INTERVAL_MS`

### 7.2 Plugin Settings

```ts
interface ObtsPluginSettings {
  serverUrl: string;
  deviceId?: string;
  vaultId?: string;
  deviceName: string;
  syncProfile: 'notes_only' | 'notes_plus_attachments' | 'full_vault_config';
  syncPlugins: boolean;
  applyMode: 'auto_safe' | 'ask_before_apply';
}
```

`syncPlugins` defaults to `false`. When `false`, `.obsidian/plugins/**` is ignored completely. When `true`, `.obsidian/plugins/**` is included in sync like other selected vault state, including plugin code and settings.

Auth tokens are stored using platform secure storage when available; otherwise they are stored under `.obts/` with restrictive local permissions.

## 8. Required v1 Feature Designs

### 8.1 Obsidian Configuration Sync

`obts` syncs selected `.obsidian` state through an explicit file policy. It does not require typed materializers for v1.

Rules:

- `.obts/` is always excluded from vault sync and manifest creation.
- The `notes_only` profile excludes `.obsidian/**`.
- The `notes_plus_attachments` profile syncs notes and included attachment paths, but excludes `.obsidian/**`.
- The `full_vault_config` profile syncs selected `.obsidian` config files by file policy.
- The default policy includes useful core Obsidian config and CSS snippets, and excludes known local/runtime/cache paths.
- `.obsidian/plugins/**` is controlled only by the `syncPlugins` setting.
- When `syncPlugins` is `false`, `.obsidian/plugins/**` is completely ignored.
- When `syncPlugins` is `true`, the full `.obsidian/plugins/**` directory is synced as normal vault state, including `manifest.json`, `main.js`, `styles.css`, `data.json`, and any plugin-owned files.
- Plugin files are executable/sensitive content; they are encrypted at rest, never logged, included in history/recovery/conflict handling, and may require Obsidian restart after apply.
- `obts` must not update its own running plugin code through normal plugin sync.

### 8.2 Note History And Restore

v1 exposes note-level history without exposing raw Git workflows.

Required behavior:

- list versions for an authorized vault path;
- show create, update, delete, rename, conflict, and restore provenance;
- show source and rendered diffs for Markdown/text where possible;
- restore a historical note version by creating a normal proposal or resolution commit;
- preserve local recovery semantics before applying a restored server `main`.

### 8.3 Persistent-State Backup Contract

Backup orchestration is a deployment concern. The app repo must not prescribe backup schedules, offsite locations, environment-specific infrastructure paths, or private restore automation.

`obts` must document the persistent state that deployment backups must capture:

- Postgres database;
- `OBTS_DATA_DIR`;
- content store directory if configured separately;
- history store directory if configured separately;
- wrapped vault data keys and key metadata in Postgres;
- deployment server master key material, backed up separately from app state.

State capture must be quiesced or point-in-time consistent across Postgres, the content store, and the history store. After restore, `GET /health/ready` must fail closed when required content, history, key metadata, or master key material is missing or inconsistent.

### 8.4 Compact History

Compaction creates a new baseline from current `main`, verifies referenced content, and removes unreferenced old commits/content only after explicit owner confirmation.

### 8.5 Recovery Bundles

Before destructive local apply or rebuild, the plugin writes a local recovery bundle under `.obts/`. Recovery bundles are local sensitive state and are not synced as vault content.

### 8.6 Platform Support Matrix

v1 platform support:

- **Desktop Linux/macOS/Windows:** supported target platforms for file watching, periodic scanning, local recovery bundles, secure token storage where available, plugin settings, and plugin sync when enabled.
- **Android/iOS:** supported only where Obsidian plugin APIs and platform storage/networking allow the behavior. Mobile sync may be foreground-only, may rely more heavily on periodic scanning, and must block rather than risk data loss when local recovery or apply guarantees cannot be met.
- **Unsupported behavior:** background real-time sync guarantees, OS-level file access outside the vault, and platform-specific plugin installation management.

Each supported platform tier must have explicit manual acceptance coverage before being advertised as supported.

## 9. Constraints And Failure Modes

### 9.1 Fail-Closed Behavior

- Missing database: readiness fails.
- Missing content store: readiness fails.
- Missing history store: readiness fails.
- Missing or invalid master key: readiness fails.
- Unauthorized vault access: `403` or `404`.
- Merge ambiguity: create conflict instead of overwriting.
- Local apply risk: snapshot first or block.
- Restored persistent state incomplete: readiness fails closed.

### 9.2 Observability

Logs include request IDs, user/device IDs, vault IDs, operation classes, durations, and error categories. Logs avoid full content payloads by default.

Metrics include sync latency, proposal counts, merge outcomes, conflict counts, storage bytes, persistent-state integrity status, key-manager readiness, and event delivery health.

Health checks cover database, content store, history store, temp workspace, and key-manager readiness.

## 10. Delivery Plan

### 10.1 v1 Scope

Server:

- auth, setup, vault, device, and token services;
- per-vault data keys wrapped by server master key;
- content storage encrypted at rest;
- protected metadata, proposals, manifests, commits, note history, conflicts, and server-side merge;
- dashboard APIs and static dashboard serving;
- persistent-state integrity checks, compaction, health, and key rewrap operations.

Plugin:

- vault watcher and periodic scanner;
- local durable queue and recovery snapshots;
- upload proposals and pull/apply changes;
- status bar and commands;
- `.obsidian` file-policy sync;
- plugin sync setting and safeguards.

Dashboard:

- setup and login;
- device dashboard;
- conflict list, diff viewers, and resolution editor;
- note history and restore view;
- maintenance status and persistent-state/health summaries.

### 10.2 Implementation Phases

1. Monorepo/package skeleton, shared types, API contract tests.
2. Server auth, vault/device setup, key manager, content store, protected metadata, and schema.
3. Plugin scan/snapshot/upload/pull/apply loop with first-sync safety.
4. Server-side merge, conflicts, dashboard review, and resolution commits.
5. Note history/restore, compaction, persistent-state checks, key rewrap, diagnostics, and recovery.
6. Hardening, performance, mobile constraints, and release packaging.

## 11. Testing And Proof

### 11.1 Unit Tests

- canonical path normalization;
- content encryption/decryption at persistence boundary;
- protected path IDs, encrypted path metadata, and keyed content fingerprints;
- wrapped vault data key creation and rewrap;
- authz checks for every vault-scoped resource;
- auth/session/token hashing, rotation, revocation, and CSRF rules;
- proposal contract validation and idempotency;
- merge policy decisions;
- note history indexing and restore proposal creation;
- conflict creation and resolution;
- local queue crash recovery.

### 11.2 Integration Tests

- two devices sync one vault through server `main`;
- concurrent disjoint edits auto-merge;
- concurrent same-file Markdown edits merge when safe;
- ambiguous same-file edits create a conflict;
- dashboard resolves a conflict and advances `main`;
- note history shows prior versions and restores one note through a new commit;
- non-empty local vault join creates a recovery bundle and never silently discards local content;
- plugin sync disabled ignores `.obsidian/plugins/**`;
- plugin sync enabled includes `.obsidian/plugins/**` and blocks self-update of `obts`;
- unauthorized user cannot access another user's vault resources;
- restored persistent state with missing content, history, key metadata, or key material fails readiness.

### 11.3 Security Tests

- copied content store does not reveal note strings, plugin settings, or config content without key material;
- copied DB does not contain raw vault data keys, raw vault-relative paths, raw content hashes, or note bodies;
- missing or wrong master key fails readiness;
- cross-account object/proposal/conflict/event access denied;
- logs do not include raw tokens, passwords, master keys, data keys, or full content payloads by default.

### 11.4 Manual Acceptance

- no `.git` appears in the visible vault;
- dashboard login is enough to review conflicts;
- no vault passphrase prompt exists in v1;
- server-side merge works for simple Markdown conflicts;
- note history can compare and restore an earlier note version;
- recovery after failed local apply preserves edits;
- plugin sync setting behaves as documented;
- key rewrap succeeds without content rewrite;
- advertised desktop/mobile platform support matches observed behavior.

## 12. Alternatives Considered

### 12.1 True E2EE

Rejected for v1. It complicates dashboard UX, server-side merge, conflict review, path handling, key recovery, and passphrase changes. It is also weaker in a server-served browser dashboard because a compromised server can serve modified JavaScript.

### 12.2 Plain Persistent Storage

Rejected for v1 as the default. It is simpler, but encrypted-at-rest storage gives useful protection for copied stores and backups without preventing server-side merge.

### 12.3 Raw Git In The Vault

Rejected because it exposes Git UX, stores `.git` in the visible vault, creates cross-platform/mobile problems, and does not provide Obsidian-specific recovery UX.

### 12.4 CRDT-First Sync

Rejected for v1. Obsidian vaults are file-oriented and include binary attachments and plugin configuration. A canonical-main model with explicit conflict review is simpler.

### 12.5 Typed Managed Config Materializers

Rejected for v1. Typed handlers for every Obsidian and plugin setting would turn configuration sync into a separate configuration-management product. v1 instead uses an explicit `.obsidian` file policy with plugin sync controlled by one user setting.

### 12.6 App-Managed Backup Product

Rejected for v1. Backup scheduling, retention, offsite storage, and restore orchestration are deployment concerns. The app defines required persistent state and fail-closed readiness checks, while external infrastructure performs backups.

## 13. Agent Guardrails

- Do not reintroduce true E2EE as a v1 requirement unless the product decision changes.
- Do not add shared vault membership or cross-user vault sharing to v1 unless the product decision changes.
- Do not add environment-specific infrastructure-specific deployment files, organization-specific image repository names, deployment secret store paths, or private hostnames to this app repo.
- Do not create `.git` directories inside visible vault content.
- Keep `.obts/` excluded from vault sync and manifest creation.
- Keep `.obsidian/plugins/**` ignored by default; include it only when the user enables plugin sync.
- Do not log or print secret values, raw data keys, server master keys, passwords, tokens, or full note bodies.
- Treat `architecture/workspace.dsl` as the authored architecture source. Treat `architecture/DIAGRAMS.md` and `architecture/export/*` as generated.
- If implementation later contradicts this PRD, refresh the architecture from code and executable config first.
