# Obsidian True Sync (`obts`) - Product + Technical Spec

## 0. Executive Summary

`obts` is a self-hosted sync system for Obsidian vaults. It preserves local-first editing, central canonical state, recoverable history, conflict review, and clear device status without putting a normal `.git` directory in the visible vault.

v1 uses a trusted self-hosted server model with encrypted-at-rest storage. The server is authorized to decrypt vault content for sync, merge, conflict review, backup, and recovery. Other users must not be able to see a vault unless they are explicitly authorized for that vault. At-rest encryption protects database, object-store, and backup material from offline disclosure when the deployment key material is not also compromised.

This is not a true end-to-end encrypted or zero-knowledge design. The live server process and the server operator are trusted for v1.

## 1. Product Frame

### 1.1 Summary

The architectural center is a single canonical server state called `main`. Clients can edit immediately, including while offline. Their edits are captured as durable local proposals, uploaded to per-device lanes, merged by the server when possible, and surfaced as conflicts when human review is required.

The server owns conflict review and semantic merge because it can read vault content after authorizing the user and decrypting stored content at the persistence boundary.

### 1.2 Audience

- Individuals self-hosting a private Obsidian sync server.
- Small trusted groups or households where the server operator is trusted, but vault access between users must remain isolated.
- Maintainers who want backup, recovery, diagnostics, and clear operational state without exposing Git workflows to note authors.

### 1.3 Goals

- Sync notes and selected Obsidian configuration between paired devices.
- Preserve local-first editing and offline proposals.
- Maintain a single server `main` per vault.
- Use server-side semantic merge for Markdown/text conflicts where safe.
- Provide a dashboard for devices, conflicts, recovery, and maintenance.
- Encrypt persistent server-side vault content and backups at rest.
- Enforce strict account and vault authorization for every API and event stream.
- Avoid `.git` directories inside visible Obsidian vaults.
- Keep plugin UX simple: server URL, login/pairing, device name, and sync profile.

### 1.4 Non-Goals

- True E2EE or zero-knowledge server operation in v1.
- Hiding plaintext paths or content from the live server process.
- Requiring a separate vault passphrase after dashboard login.
- Shared real-time collaborative editing, cursors, CRDT/OT sessions, or presence.
- Syncing every `.obsidian/` file blindly.
- Storing a normal Git repository in the visible vault.
- Building app images or environment-specific infrastructure deployment assumptions into this app repo.

## 2. Security Model

### 2.1 Trust Boundary

v1 trusts the server process. The server may decrypt vault content in memory and in temporary workspaces to perform:

- content upload validation;
- server-side text and Markdown merges;
- conflict package rendering;
- dashboard conflict review;
- search or inspection features added later;
- backup, restore, compaction, and recovery.

The server must still enforce user isolation. A user can access only vaults where the authorization model grants access. Cross-user access to vaults, devices, proposals, conflicts, content objects, events, and diagnostics must return `403` or `404` without leaking useful information.

### 2.2 Encrypted-At-Rest Storage

Persistent vault content uses per-vault data keys:

- each vault has a random data key;
- the raw data key is never stored directly;
- Postgres stores wrapped vault data keys and key metadata;
- a deployment-provided server master key unwraps vault data keys when the server needs them;
- content is encrypted before being written to persistent content/history stores;
- backups must include wrapped data keys and metadata, but restoration also requires the deployment key material or a rotated replacement key.

The server master key is a generic deployment secret. The app repo must not prescribe a private environment-specific infrastructure-specific secret path.

### 2.3 What Encryption Protects

Encrypted-at-rest storage protects against:

- copied database dumps that do not include server key material;
- copied content-store directories that do not include server key material;
- misplaced backup archives when keys are stored separately;
- casual offline inspection of server storage.

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
- **Maintainer/operator:** upgrades the server, configures backup/restore, and rotates deployment key material.
- **Server:** authenticates users/devices, persists encrypted-at-rest content, advances `main`, and performs merge/conflict workflows.
- **Obsidian plugin:** watches local vault changes, snapshots edits, uploads proposals, pulls server changes, and applies accepted state.
- **Dashboard SPA:** browser UI for setup, device state, conflict review, and maintenance.

### 3.2 Server Install

The operator deploys the server with Postgres, a persistent encrypted content store, an internal history store, and runtime server master key material.

Acceptance criteria:

- `GET /health/live` works without dependencies.
- `GET /health/ready` checks Postgres, content store, history store, and key-manager readiness.
- Missing or invalid server master key material fails closed.
- The first admin setup cannot be repeated after setup is complete.

### 3.3 Create Vault And Pair First Device

The owner creates a vault in the dashboard and pairs the first Obsidian plugin device.

Behavior:

1. Server creates the vault record.
2. Server creates a random per-vault data key and stores it wrapped by the current server master key version.
3. Dashboard issues a one-time pairing token or URL.
4. Plugin consumes the pairing token, registers device metadata, and stores a device token locally.
5. Plugin performs an initial scan of the local vault.
6. If server `main` is empty, the first client publishes an initial proposal.
7. If server `main` exists, the client pulls and applies it after local recovery snapshotting.

Acceptance criteria:

- Pairing token is one-time, scoped, and short-lived.
- Device token is scoped to one user and one vault.
- No vault passphrase is required.

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
- backup and health summaries.

### 3.9 Recovery And Rebuild

If a client loses local state or applies fail, it can rebuild from server `main`.

Behavior:

1. Plugin stops normal sync.
2. Plugin snapshots local pending edits into a recovery bundle.
3. Plugin pulls current server `main`.
4. Plugin applies server state to local vault.
5. Plugin uploads any preserved local edits as proposals or exposes them for manual review.

Acceptance criteria:

- Recovery never silently discards local edits.
- Server backups can restore metadata, wrapped keys, content store, and history store consistently.

## 4. Technical Design

### 4.1 System Principles

1. `main` is the only published server state for a vault.
2. Clients propose; only server merge/resolution transactions advance `main`.
3. The server is trusted to decrypt content for v1 workflows.
4. Persistent vault content is encrypted at rest with per-vault data keys.
5. Authorization is enforced at every vault-scoped boundary.
6. No `.git` directory appears in the visible Obsidian vault.
7. Local proposals and recovery snapshots are durable before destructive operations.
8. Obsidian configuration sync uses typed managed entries, not blind `.obsidian/` replication.

### 4.2 Containers

- **Server API and CLI:** TypeScript/Node/Fastify service for auth, vaults, devices, proposals, merge, conflicts, key management, backup, and health.
- **Dashboard SPA:** browser UI served by the server for setup, device dashboard, conflict review, and maintenance.
- **Obsidian plugin:** TypeScript plugin that watches local vaults, snapshots edits, uploads proposals, pulls changes, and applies `main`.
- **Postgres:** users, vaults, wrapped data keys, devices, token hashes, content catalog, commits, manifest entries, proposals, conflicts, audit records.
- **Encrypted-at-rest content store:** local filesystem storage for encrypted vault file bytes, attachments, conflict payloads, recovery bundles, and compacted snapshots.
- **Internal history store:** commit graph, branch-like refs, manifests, and merge provenance; content bytes are persisted through the encrypted content store.
- **Temporary merge workspace:** ephemeral plaintext server working directory for merge operations; cleaned after transaction.
- **Local `.obts` store:** client-local queue, cache, proposals, recovery bundles, locks, diagnostics, and device token state.

### 4.3 Server Components

- **AuthService:** authenticates dashboard sessions, device tokens, and pairing tokens.
- **VaultService:** creates vaults, enforces owner isolation, and coordinates initial key creation.
- **DeviceService:** registers, tracks, and revokes paired devices.
- **AtRestKeyManager:** loads server master key material, creates/wraps/unwraps per-vault data keys, and rewraps keys during rotation.
- **ContentStoreService:** encrypts/decrypts vault content at persistence boundaries and maintains object/catalog metadata.
- **ProposalService:** accepts idempotent per-device proposals and submits them to merge.
- **HistoryService:** maintains canonical `main`, commit graph, manifests, refs, and provenance.
- **MergeCoordinator:** performs server-side merge/resolution transactions.
- **SemanticMergeService:** performs conservative text/Markdown/frontmatter/block-aware merge.
- **ConflictService:** creates, lists, and resolves structured conflicts.
- **NotificationHub:** publishes main, conflict, device, and maintenance events with polling fallback.
- **BackupService:** creates and restores consistent snapshots of metadata, wrapped keys, encrypted content, and history.
- **AuditLogService:** writes redacted operational audit events.
- **HealthService:** reports liveness, readiness, version, migration, storage, and key-manager health.

### 4.4 Plugin Components

- **SettingsView:** collects server URL, login/pairing token, device name, and sync profile.
- **StatusBar:** displays Synced, Ahead, Behind, Uploading, Applying, Offline, Blocked, Unsafe local error, and Needs recovery.
- **VaultWatcher:** observes local vault changes through Obsidian APIs.
- **PeriodicScanner:** detects missed watcher events and crash recovery work.
- **PathNormalizer:** creates canonical vault-relative paths using `/` and normalized Unicode.
- **SnapshotEngine:** persists local edits as durable proposals before upload or destructive apply operations.
- **LocalQueue:** stores pending proposal, retry, cache, recovery, lock, diagnostic, and managed-config state.
- **LocalContentCache:** caches pulled/uploaded content needed for retry, apply, and recovery.
- **TransportClient:** calls server APIs and subscribes to events with polling fallback.
- **ApplyEngine:** applies accepted server `main` changes to the vault after local recovery snapshots.
- **DiagnosticsExporter:** exports redacted diagnostics for support and recovery.

### 4.5 Web UI Components

- **AuthSession:** manages dashboard session state.
- **DeviceDashboard:** shows device and server state.
- **ConflictList:** lists unresolved conflicts and opens review workflows.
- **MarkdownDiffViewer:** renders Markdown conflict variants and merge previews returned by server APIs.
- **SourceDiffViewer:** shows source-level conflict diffs.
- **ResolutionEditor:** lets the owner choose or author the final resolution and submits it to the server.

## 5. Storage And Data Model

### 5.1 Identifiers

- `user_id`: `usr_` plus ULID.
- `vault_id`: `vlt_` plus ULID.
- `device_id`: `dev_` plus ULID.
- `commit_id`: `m_` plus content/provenance hash or ULID.
- `proposal_id`: `prop_` plus ULID or idempotency hash.
- `content_id`: `cnt_` plus hash or ULID.
- `conflict_id`: `conf_` plus ULID.

### 5.2 Core Tables

- `users`: account identity and password hash.
- `vaults`: owner, display name, active main, status, created/updated timestamps.
- `vault_keys`: vault ID, key version, wrapped data key, wrapping algorithm, master key version, timestamps.
- `devices`: vault-scoped paired devices and server-known state.
- `api_tokens`: hashed dashboard, device, and pairing tokens.
- `content_objects`: encrypted-at-rest content catalog, content hashes, sizes, and storage refs.
- `commits`: commit graph, parents, author device/user, timestamps, and operation type.
- `manifest_entries`: commit tree entries keyed by canonical vault-relative path.
- `proposals`: idempotent per-device proposal metadata and lifecycle.
- `conflicts`: conflict state, affected paths, base/current/proposed refs, and resolution refs.
- `audit_log`: redacted operational events.

### 5.3 Content Persistence

The server may receive plaintext vault content over authenticated HTTPS. After authorization and validation, `ContentStoreService` encrypts content with the vault data key before writing persistent content bytes. Reads decrypt content only for authorized server workflows and return plaintext only to authorized clients over HTTPS.

### 5.4 History Model

Server `main` points to a manifest snapshot. Each commit records parents, changed paths, content refs, conflict/resolution provenance, and author metadata. The history store is internal server state and must not be exposed as a user-visible Git repository.

Temporary merge workspaces may contain plaintext checked-out file trees. They must be scoped to one merge transaction, permission-restricted, and cleaned after success or failure.

### 5.5 Key Rotation

Server key rotation rewraps per-vault data keys under a new master key version. It does not rewrite all vault content unless the content encryption format itself changes.

Failure rules:

- missing master key fails server readiness;
- failed rewrap leaves the previous key version active;
- backup restore requires matching or migrated master key material;
- key operations write audit records without printing key values.

## 6. Interfaces And Contracts

### 6.1 API Conventions

- HTTPS JSON APIs under `/api/v1`.
- Device APIs authenticate with device tokens.
- Dashboard APIs authenticate with session cookies or bearer tokens.
- Every vault-scoped endpoint checks account, vault, and device scope.
- Idempotent write APIs accept idempotency keys.
- Events are available through WebSocket with polling fallback.

### 6.2 Main APIs

- `POST /api/v1/pair/consume`: consume a pairing token and register a device.
- `GET /api/v1/vaults/{vault_id}/main`: return current main metadata and manifest summary.
- `POST /api/v1/vaults/{vault_id}/content/batch`: upload changed file content or content refs.
- `POST /api/v1/vaults/{vault_id}/proposals`: submit a device proposal.
- `POST /api/v1/vaults/{vault_id}/pull`: request changes since a known commit.
- `GET /api/v1/vaults/{vault_id}/conflicts?status=open`: list conflicts visible to the authorized user/device.
- `GET /api/v1/vaults/{vault_id}/conflicts/{conflict_id}`: fetch conflict review content.
- `POST /api/v1/vaults/{vault_id}/conflicts/{conflict_id}/resolve`: submit a resolution.
- `POST /api/v1/vaults/{vault_id}/maintenance/compact/start`: create a compacted baseline after confirmation.
- `POST /api/v1/admin/keys/rewrap/start`: rewrap vault data keys under a new server master key version.

### 6.3 Events

Events include:

- `main_advanced`;
- `proposal_accepted`;
- `proposal_rejected`;
- `conflict_created`;
- `conflict_resolved`;
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
- `OBTS_BACKUP_DIR`
- `OBTS_MAX_UPLOAD_BYTES`
- `OBTS_EVENT_POLL_INTERVAL_MS`

### 7.2 Plugin Settings

```ts
interface ObtsPluginSettings {
  serverUrl: string;
  deviceId?: string;
  vaultId?: string;
  deviceName: string;
  syncProfile: 'notes_only' | 'notes_plus_attachments' | 'full_vault_managed_config';
  applyMode: 'auto_safe' | 'ask_before_apply';
}
```

Auth tokens are stored using platform secure storage when available; otherwise they are stored under `.obts/` with restrictive local permissions.

## 8. Required v1 Feature Designs

### 8.1 Managed Obsidian Configuration

`obts` must not blindly sync `.obsidian/`. Configuration sync uses typed managed entries with explicit materializers.

v1 supports:

- hotkeys through schema handlers;
- selected core settings;
- selected plugin configuration where handlers exist;
- CSS snippets as vault assets when selected.

### 8.2 Backup And Restore

Backups include:

- Postgres metadata;
- wrapped vault data keys and key metadata;
- encrypted content store;
- internal history store;
- server version and schema version.

Backups do not include raw server master key values. Operators must back up deployment key material separately.

### 8.3 Compact History

Compaction creates a new baseline from current `main`, verifies referenced content, and removes unreferenced old commits/content only after explicit owner confirmation.

### 8.4 Recovery Bundles

Before destructive local apply or rebuild, the plugin writes a local recovery bundle under `.obts/`. Recovery bundles are local sensitive state and are not synced as vault content.

## 9. Constraints And Failure Modes

### 9.1 Fail-Closed Behavior

- Missing database: readiness fails.
- Missing content store: readiness fails.
- Missing history store: readiness fails.
- Missing or invalid master key: readiness fails.
- Unauthorized vault access: `403` or `404`.
- Merge ambiguity: create conflict instead of overwriting.
- Local apply risk: snapshot first or block.
- Backup incomplete: restore refuses to proceed.

### 9.2 Observability

Logs include request IDs, user/device IDs, vault IDs, operation classes, durations, and error categories. Logs avoid full content payloads by default.

Metrics include sync latency, proposal counts, merge outcomes, conflict counts, storage bytes, backup status, key-manager readiness, and event delivery health.

Health checks cover database, content store, history store, temp workspace, and key-manager readiness.

## 10. Delivery Plan

### 10.1 v1 Scope

Server:

- auth, setup, vault, device, and token services;
- per-vault data keys wrapped by server master key;
- content storage encrypted at rest;
- proposals, manifests, commits, conflicts, and server-side merge;
- dashboard APIs and static dashboard serving;
- backup, restore, compaction, health, and key rewrap operations.

Plugin:

- vault watcher and periodic scanner;
- local durable queue and recovery snapshots;
- upload proposals and pull/apply changes;
- status bar and commands;
- managed configuration materializers.

Dashboard:

- setup and login;
- device dashboard;
- conflict list, diff viewers, and resolution editor;
- maintenance status and backup/health summaries.

### 10.2 Implementation Phases

1. Monorepo/package skeleton, shared types, API contract tests.
2. Server auth, vault/device setup, key manager, content store, and metadata schema.
3. Plugin scan/snapshot/upload/pull/apply loop.
4. Server-side merge, conflicts, dashboard review, and resolution commits.
5. Backup/restore, compaction, key rewrap, diagnostics, and recovery.
6. Hardening, performance, mobile constraints, and release packaging.

## 11. Testing And Proof

### 11.1 Unit Tests

- canonical path normalization;
- content encryption/decryption at persistence boundary;
- wrapped vault data key creation and rewrap;
- authz checks for every vault-scoped resource;
- merge policy decisions;
- conflict creation and resolution;
- local queue crash recovery.

### 11.2 Integration Tests

- two devices sync one vault through server `main`;
- concurrent disjoint edits auto-merge;
- concurrent same-file Markdown edits merge when safe;
- ambiguous same-file edits create a conflict;
- dashboard resolves a conflict and advances `main`;
- unauthorized user cannot access another user's vault resources;
- backup/restore preserves content and wrapped key metadata.

### 11.3 Security Tests

- copied content store does not reveal note strings without key material;
- copied DB does not contain raw vault data keys;
- missing or wrong master key fails readiness;
- cross-account object/proposal/conflict/event access denied;
- logs do not include raw tokens, passwords, master keys, data keys, or full content payloads by default.

### 11.4 Manual Acceptance

- no `.git` appears in the visible vault;
- dashboard login is enough to review conflicts;
- no vault passphrase prompt exists in v1;
- server-side merge works for simple Markdown conflicts;
- recovery after failed local apply preserves edits;
- key rewrap succeeds without content rewrite.

## 12. Alternatives Considered

### 12.1 True E2EE

Rejected for v1. It complicates dashboard UX, server-side merge, conflict review, path handling, key recovery, and passphrase changes. It is also weaker in a server-served browser dashboard because a compromised server can serve modified JavaScript.

### 12.2 Plain Persistent Storage

Rejected for v1 as the default. It is simpler, but encrypted-at-rest storage gives useful protection for copied stores and backups without preventing server-side merge.

### 12.3 Raw Git In The Vault

Rejected because it exposes Git UX, stores `.git` in the visible vault, creates cross-platform/mobile problems, and does not provide Obsidian-specific recovery UX.

### 12.4 CRDT-First Sync

Rejected for v1. Obsidian vaults are file-oriented and include binary attachments and plugin configuration. A canonical-main model with explicit conflict review is simpler.

## 13. Agent Guardrails

- Do not reintroduce true E2EE as a v1 requirement unless the product decision changes.
- Do not add environment-specific infrastructure-specific deployment files, organization-specific image repository names, deployment secret store paths, or private hostnames to this app repo.
- Do not create `.git` directories inside visible vault content.
- Do not log or print secret values, raw data keys, server master keys, passwords, tokens, or full note bodies.
- Treat `architecture/workspace.dsl` as the authored architecture source. Treat `architecture/DIAGRAMS.md` and `architecture/export/*` as generated.
- If implementation later contradicts this PRD, refresh the architecture from code and executable config first.
