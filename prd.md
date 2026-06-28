# Obsidian True Sync (`obts`) - Product + Technical Spec

## 0. Executive Summary

`obts` is a self-hosted, Git-backed sync system for Obsidian vaults. It preserves local-first editing, central canonical state, recoverable history, conflict review, and clear device status without exposing Git workflows to note authors and without putting a normal `.git` directory in the visible vault.

Git is the internal history engine for v1. Local edits become hidden Git commits, device uploads advance protected per-device Git refs that act as internal merge candidates, and the server advances canonical `main` through Git-backed merge or explicit conflict resolution. `obts` adds the Obsidian-specific product layer around Git: pairing, authorization, deployment-managed storage protection, safe local apply, recovery bundles, dashboard conflict review, note history, and maintenance.

v1 uses a trusted self-hosted server model. The server is authorized to read vault content, internal Git state, and sensitive metadata for sync, merge, conflict review, note history, maintenance, and recovery. v1 is multi-tenant: it supports multiple user accounts, but each vault belongs to exactly one owner and other users must not be able to see that vault through the application.

This is not a true end-to-end encrypted or zero-knowledge design. The live server process and the server operator are trusted for v1.

## 1. Product Frame

### 1.1 Summary

The architectural center is a single canonical server Git ref called `main`. Clients can edit immediately, including while offline. Their edits are captured as durable local Git commits under `.obts/`, uploaded to per-device refs on the server, merged into `main` when safe, and surfaced as conflicts when human review is required.

The server owns conflict review and semantic merge because it can read vault content after authorizing the user and materializing Git state in controlled server workspaces.

Git provides commit identity, ancestry, merge bases, diffs, rename detection support, object integrity, and history traversal. `obts` does not reinvent those primitives. It constrains and wraps them so the user experiences Obsidian sync, not Git.

### 1.2 Audience

- Individuals self-hosting a private Obsidian sync server.
- Small trusted multi-user instances where the server operator is trusted, but each vault remains owned by exactly one user and vault sharing is not supported in v1.
- Maintainers who want note history, recovery, diagnostics, and clear operational state without exposing Git workflows to note authors.

### 1.3 Goals

- Sync notes and selected Obsidian configuration between paired devices.
- Preserve local-first editing and offline commits.
- Use Git as the authoritative internal history, ancestry, diff, and merge backbone.
- Maintain a single server `main` Git ref per vault.
- Use server-side Git merge plus conservative Obsidian-aware semantic merge policy for Markdown/text conflicts where safe.
- Provide a dashboard for devices, conflicts, note history, recovery, and maintenance.
- Support deployment-managed at-rest protection through documented storage, permission, and backup requirements.
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
- Reinventing Git commit graph, tree, diff, merge-base, object identity, or ref semantics in custom database tables.
- Exposing raw Git commands, Git remotes, branches, or conflict markers as the normal user experience.
- Syncing every `.obsidian/` file blindly.
- Storing a normal Git repository in the visible vault.
- Implementing an application-level encrypted Git store, per-vault data keys, or app-managed content key rotation in v1.
- App-managed backup scheduling, offsite backup storage, or deployment-specific restore orchestration.
- Building app images or environment-specific infrastructure deployment assumptions into this app repo.

## 2. Security Model

### 2.1 Trust Boundary

v1 trusts the server process. The server is authorized to read vault content, internal Git objects, Git trees, Git refs, and sensitive metadata in memory and in temporary workspaces to perform:

- Git packfile validation and sync;
- content upload validation;
- server-side Git merge and text/Markdown semantic merge;
- conflict package rendering;
- dashboard conflict review;
- note history, restore-from-history, maintenance, and recovery.

The server must still enforce multi-tenant user isolation. v1 supports multiple user accounts, but a user can access only vaults they own. Admin or operator status in the application must not grant vault-content access unless that account owns the vault. Cross-user access to vaults, devices, Git refs, Git objects, conflicts, history entries, events, and diagnostics must return `404` without leaking useful information. v1 does not support shared vault membership.

### 2.2 Deployment-Managed At-Rest Protection

v1 does not implement an application-level encrypted Git store. Persistent server-side Git state and database metadata are normal sensitive application state. They must be protected by deployment controls rather than per-vault content keys inside `obts`.

Deployment requirements:

- run Postgres, `OBTS_DATA_DIR`, and any separate server Git store on storage with restrictive permissions;
- use deployment-managed disk, volume, database-backup, or snapshot encryption when offline disclosure protection is required;
- keep backup encryption keys and storage access credentials outside the app repo;
- make backups point-in-time consistent across Postgres and the server Git store;
- treat database dumps, server Git stores, recovery exports, diagnostics exports, and backups as sensitive unless deployment encryption already protects them.

`obts` must document the persistent state that deployments must protect and back up, but the app repo must not prescribe private environment-specific infrastructure paths, backup schedules, offsite targets, or secret-store locations.

The storage layer must keep a clear repository/store abstraction so application-level encrypted persistence can be added beyond v1 without replacing the sync model.

### 2.3 What At-Rest Protection Does Not Claim

v1 does not claim that a copied plaintext database dump or copied plaintext server Git store is unreadable without app key material. Offline disclosure protection depends on deployment-managed encryption and access controls.

Deployment-managed at-rest protection can protect against copied disks, copied encrypted snapshots, or misplaced encrypted backups only to the extent that the deployment stores encryption keys separately from the protected data.

It does not protect against:

- a compromised live server process;
- malicious code deployed to the server;
- a server operator with runtime access to the service or storage;
- a dashboard session authorized to read a vault;
- plaintext present in process memory, persistent app storage, temporary Git repositories, or merge workspaces;
- database dumps, Git-store copies, or backups captured before deployment encryption is applied.

### 2.4 Logging And Diagnostics

Even though the server can read content and internal Git state, default logs and diagnostics must avoid note content unless an explicit owner-initiated export requests it. Logs must redact tokens, passwords, request bodies containing vault content, Git pack contents, raw blob contents, and large content payloads.

Audit records must identify who accessed or changed a vault and which resource class was affected. They must not store full note bodies, raw Git blobs, raw paths, or secret values.

## 3. Experience And Workflows

### 3.1 Actors

- **Vault owner:** installs the server, creates vaults, pairs devices, reviews conflicts, and runs maintenance.
- **Device user:** edits notes in Obsidian and observes sync status on paired devices.
- **Maintainer/operator:** upgrades the server, configures deployment backups and storage protection, and restores persistent state when needed.
- **Server:** authenticates users/devices, persists server Git state, advances `main`, and performs merge/conflict workflows.
- **Obsidian plugin:** watches local vault changes, records hidden Git commits, uploads device ref updates, pulls server changes, and applies accepted state.
- **Dashboard SPA:** browser UI for setup, device state, conflict review, and maintenance.

### 3.2 Server Install

The operator deploys the server with Postgres, a server Git store, temporary workspace storage, and the native `git` CLI available to the server process.

Acceptance criteria:

- `GET /health/live` works without dependencies.
- `GET /health/ready` checks Postgres, server Git store, temp workspace, filesystem permissions, migrations, and native `git` CLI readiness.
- Missing or inconsistent restored persistent state fails closed.
- The first admin setup cannot be repeated after setup is complete.

### 3.3 Create Vault And Pair First Device

The owner creates a vault in the dashboard and pairs the first Obsidian plugin device.

Behavior:

1. Server creates the vault record.
2. Server initializes per-vault Git state.
3. Server creates a server-authored empty-tree root commit on `refs/heads/main`.
4. Dashboard issues a one-time pairing token or URL after recent-auth verification.
5. Plugin consumes the pairing token, registers device metadata, and stores a device token locally.
6. Plugin initializes hidden Git state under `.obts/` without creating a visible vault `.git`.
7. Plugin performs an initial scan of the local vault and local `.obts/` state.
8. Plugin imports the current server `main` root as its base.
9. If the local vault is empty and server `main` contains only the server-authored empty-tree root commit, the client records itself as synced to current `main`.
10. If the local vault is empty and server `main` contains user content, the plugin applies server `main` through the normal apply journal and records itself as synced after apply succeeds.
11. If this is the first paired device for a newly created vault and the local vault contains user content, the plugin creates a recovery bundle, asks the owner to confirm initial import, commits the local content as the initial device commit, and uploads that commit through the device ref.
12. If this is an additional paired device and the local vault contains user content that differs from server `main`, the plugin creates a recovery bundle, shows a local-vs-server summary, blocks normal sync, and requires an explicit replace-local-with-server command before applying server state. The original local content remains recoverable only from the recovery bundle after replacement.
13. If local `.obts/` Git state belongs to another device/vault or is partially initialized, pairing blocks until the owner runs a recovery or reset flow.

Acceptance criteria:

- Pairing token is one-time, scoped, and short-lived.
- Device token is scoped to one user and one vault.
- No vault passphrase is required.
- No visible `.git` directory is created inside the vault.
- Server `main` exists immediately after vault creation and points to a real empty-tree root commit, not an empty or unborn ref.
- First sync never silently discards local content.
- First-device import of non-empty local content requires a recovery bundle and explicit owner confirmation before upload.
- Additional-device pairing of non-empty divergent local content blocks normal sync until the owner explicitly replaces local content with server state after recovery bundle creation.

### 3.4 Local Edit Sync

When a user edits local vault files, the plugin records the edit as one or more hidden Git commits under `.obts/`, uploads Git packfiles over authenticated HTTPS, and keeps retry state durable.

Acceptance criteria:

- Local edits are durably committed or recoverably snapshotted before upload.
- `.obts/` is excluded from vault sync, Git worktree content, and manifest/path scanning.
- Retrying an upload of the same Git commit is idempotent.
- A new local edit creates a new Git commit with normal Git ancestry.
- Git commit hashes and parent links, not timestamps, determine content identity and ancestry.
- Server stores uploaded Git state in the server Git store after authorization.

### 3.5 Pull And Apply Server Main

When server `main` advances, paired clients pull the Git objects needed to reach the new `main`, create local recovery snapshots, and apply accepted server changes through Obsidian APIs.

Acceptance criteria:

- Local uncommitted changes are never overwritten without a recovery snapshot.
- Local commits not yet present on the server are preserved or surfaced for recovery before destructive apply.
- Local changes are never silently discarded; if safe apply is impossible, sync blocks and surfaces recovery options.
- Apply operations use Obsidian `Vault` and `DataAdapter` APIs only.
- Apply operations use a local vault lock and an apply journal under `.obts/` with target `main`, expected prior local state, affected paths, per-file preflight hashes, and current phase.
- The plugin creates a recovery bundle before any destructive file operation.
- Watcher events caused by `obts` apply writes are suppressed or tagged so they are not recommitted as new local edits.
- On restart, the plugin inspects the apply journal and either finishes an idempotent apply, rolls forward to target `main`, or blocks with recovery options.
- If a file changed unexpectedly after preflight, apply stops and surfaces recovery instead of overwriting.
- The plugin can recover after crash during apply.

### 3.6 Concurrent Edits And Merge

The server receives Git updates from multiple devices and advances `main` only through a merge or resolution transaction.

Behavior:

1. A device upload carries a Git packfile and an expected current device ref.
2. If the uploaded commit is already present and the device ref already points to it, the server treats the upload as an idempotent no-op.
3. If the uploaded commit is a fast-forward of the device ref, the server advances `refs/obts/devices/{device_id}`.
4. If the uploaded commit is not a descendant of the current device ref, the server blocks that device and requires recovery.
5. The server classifies the device ref as merge-eligible only after authentication, object validation, path-policy validation, fast-forward ref update, device-not-blocked checks, not-already-merged checks, not-already-conflicted checks, and assignment of a server `merge_sequence`.
6. The server enqueues merge-eligible device refs in the per-vault merge queue ordered by `merge_sequence`.
7. The server processes one merge transaction at a time under the per-vault lock.
8. Disjoint path changes merge automatically when Git and `obts` policy agree they are safe.
9. Same-path text and Markdown changes are checked out into an ephemeral server merge workspace.
10. The merge service uses Git merge machinery plus conservative line/frontmatter/block-aware validation.
11. Clean merges advance `main` with a merge commit.
12. Ambiguous or unsafe merges create a conflict record.

Acceptance criteria:

- Server merge decisions are deterministic and auditable.
- Device ref updates use fast-forward or compare-and-swap semantics.
- Conflict originals remain recoverable from Git commits.
- Binary conflicts default to identity-only merge or keep-both review.
- Every merge decision records `merge_sequence`, `merge_policy_version`, base commit, current `main`, device commit, decision, and validator results.

### 3.7 Conflict Review In Dashboard

The dashboard is available after normal authenticated login. It does not ask for a separate vault passphrase.

Behavior:

1. User opens the conflict center.
2. Server authorizes the user for the vault.
3. Server materializes the relevant Git state in a temporary workspace.
4. Server returns conflict metadata and content needed for review over HTTPS.
5. Dashboard displays rendered Markdown diff, source diff, affected paths, and available merge choices.
6. User accepts current `main`, accepts device version, keeps both, inserts both blocks, or manually edits a final result.
7. Dashboard verifies recent authentication and submits the selected resolution with the conflict ID and expected current `main`.
8. Server accepts the resolution only if current `main` still matches the expected commit.
9. If `main` advanced, the review package is marked stale and the dashboard must refresh or regenerate it before resolution.
10. Server writes the accepted resolution as a normal Git commit or merge commit descending from current `main`, persists updated Git state, advances `main`, and marks the conflict resolved.

Acceptance criteria:

- Unauthorized users cannot list, view, or resolve conflicts for another vault.
- Resolution commits reference the conflict they resolved.
- Duplicate submission of the same accepted resolution is idempotent.
- All clients receive a `main_advanced` event after resolution.
- Conflict resolution submission requires dashboard re-authentication within the previous 15 minutes.

### 3.8 Device Dashboard

The dashboard shows:

- paired devices;
- device names and last-seen status;
- current server `main` commit;
- each device ahead/behind/offline/blocked state;
- unresolved conflicts;
- maintenance state;
- persistent-state and health summaries.

### 3.9 Note History And Restore

The owner can inspect and restore prior versions of individual notes without exposing raw Git workflows.

Behavior:

1. User opens note history for a vault path from the dashboard or plugin.
2. Server authorizes the owning user for the vault.
3. Server derives history from Git commits, path metadata, and rename/delete provenance.
4. Server returns version metadata, including commit, timestamp, author device/user, operation type, and conflict/merge provenance.
5. User views source or rendered diffs for Markdown/text versions.
6. User restores a prior version after recent-auth verification by creating a normal Git commit through the same merge/resolution path as other edits; history is never mutated in place.

Acceptance criteria:

- Note history can show creates, updates, deletes, and renames.
- Restoring a prior note version advances `main` through the same Git-backed merge/resolution path as other edits.
- Git timestamps are display metadata only and never determine sync ordering.
- v1 retains all commits reachable from `main`, device refs, unresolved conflict refs, and recovery refs indefinitely. Destructive history truncation is outside v1.

### 3.10 Recovery And Rebuild

If a client loses local state or apply fails, it can rebuild from server `main`.

Behavior:

1. Plugin stops normal sync.
2. Plugin snapshots local pending edits and relevant hidden Git state into a recovery bundle.
3. Plugin pulls current server `main`.
4. Plugin applies server state to local vault.
5. Plugin commits preserved patch series as a new local recovery commit, uploads preserved local commits through the device ref, and keeps divergent same-device history blocked until the owner exports the recovery bundle and resets the device.

Acceptance criteria:

- Recovery never silently discards local edits.
- Recovery bundles are available before destructive apply or rebuild operations.
- Recovery can distinguish repeated commits, new commits, and divergent same-device history using Git ancestry.

## 4. Technical Design

### 4.1 System Principles

1. Git is the authoritative internal history engine for vault content.
2. `refs/heads/main` is the only published server state for a vault.
3. Each paired device uploads through a protected server-side device ref such as `refs/obts/devices/{device_id}`; device refs are internal merge candidates, not user-visible Git branches.
4. Clients commit locally; only server merge/resolution transactions advance `main`.
5. Git commit hashes identify immutable commits; parent links define ancestry; timestamps are display metadata only.
6. The server uses the native `git` CLI as the authoritative server-side Git implementation.
7. The Obsidian plugin uses `isomorphic-git` for client-side Git operations.
8. Persistent server-side Git state is protected by deployment-managed storage controls in v1.
9. Authorization is enforced at every vault-scoped boundary, and v1 vaults are single-owner in a multi-tenant instance.
10. No `.git` directory appears in the visible Obsidian vault.
11. Local commits, recovery snapshots, and recovery bundles are durable before destructive operations.
12. Obsidian configuration sync uses an explicit file policy; `.obts/` is always excluded.

### 4.2 Containers

- **Server API and CLI:** TypeScript/Node/Fastify service for auth, vaults, devices, Git sync, merge, conflicts, note history, persistent-state checks, and health.
- **Dashboard SPA:** browser UI served by the server for setup, device dashboard, conflict review, and maintenance.
- **Obsidian plugin:** TypeScript plugin that watches local vaults, records hidden Git commits with `isomorphic-git`, uploads device ref updates, pulls `main`, and applies accepted state.
- **Postgres:** control-plane metadata for users, single-owner vaults, devices, token hashes, durable sync operations, derived indexes, conflict workflow records, event log rows, sync attempts, and audit records. Postgres does not own the authoritative commit graph, tree manifests, blobs, or refs.
- **Server Git store:** per-vault internal Git repositories, object databases, packs, refs, trees, commits, blobs, and history state stored outside visible vaults.
- **Temporary Git workspace:** ephemeral plaintext bare repos and working trees for sync, merge, history, conflict review, restore, and maintenance transactions; cleaned after transaction.
- **Local `.obts` store:** client-local hidden Git state, queues, cache, recovery bundles, locks, diagnostics, and device token state.

### 4.3 Server Components

- **AuthService:** authenticates dashboard sessions, device tokens, and pairing tokens.
- **VaultService:** creates vaults, enforces owner isolation, and coordinates initial Git state creation.
- **DeviceService:** registers, tracks, and revokes paired devices.
- **ServerGitStoreService:** manages per-vault server Git repositories and verifies store integrity.
- **GitRepositoryService:** invokes the native `git` CLI to materialize authorized temporary Git repos, import/export packfiles, update refs, compute diffs, and read history.
- **PathPolicyService:** validates canonical vault-relative paths, collision rules, and platform-safe materialization rules.
- **SyncService:** accepts authenticated device Git uploads, enforces device ref fast-forward rules, records sync attempts, and submits eligible updates to merge.
- **HistoryService:** exposes Git-backed canonical `main`, refs, provenance, integrity checks, and maintenance operations.
- **NoteHistoryService:** resolves authorized note/path history from Git plus derived metadata, diffs versions, and creates restore commits.
- **MergeCoordinator:** performs server-side Git merge/resolution transactions.
- **SemanticMergeService:** performs conservative text/Markdown/frontmatter/block-aware validation and merge assistance.
- **ConflictService:** creates, lists, renders, and resolves structured conflicts backed by Git commits.
- **NotificationHub:** publishes main, conflict, device, and maintenance events with polling fallback.
- **PersistentStateService:** documents required persistent state and performs readiness/integrity checks after restore.
- **AuditLogService:** writes redacted operational audit events.
- **HealthService:** reports liveness, readiness, version, migration, storage, native `git` CLI, and filesystem health.

### 4.4 Plugin Components

- **SettingsView:** collects server URL, login/pairing token, device name, sync profile, apply mode, and plugin-sync setting.
- **StatusBar:** displays Synced, Ahead, Behind, Uploading, Applying, Offline, Blocked, Unsafe local error, and Needs recovery.
- **VaultWatcher:** observes local vault changes through Obsidian APIs.
- **PeriodicScanner:** detects missed watcher events and crash recovery work.
- **PathNormalizer:** creates canonical vault-relative paths using `/` and normalized Unicode.
- **LocalGitEngine:** uses `isomorphic-git` to maintain hidden Git state under `.obts/`, create commits from local vault changes, and import pulled server commits.
- **ObsidianGitFsAdapter:** adapts `isomorphic-git` filesystem calls to Obsidian's `DataAdapter`, including mobile `CapacitorAdapter`.
- **SnapshotEngine:** persists local edits and recovery snapshots before upload or destructive apply operations.
- **LocalQueue:** stores pending sync work, retry state, cache, recovery, lock, diagnostic, and config-sync state.
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
- **NoteHistoryView:** shows Git-backed note versions, diffs, provenance, and restore actions.

## 5. Storage And Data Model

### 5.1 Identifiers

- `user_id`: `usr_` plus ULID.
- `vault_id`: `vlt_` plus ULID.
- `device_id`: `dev_` plus ULID.
- `git_commit_id`: Git object ID for authorized runtime/API use.
- `git_ref`: internal Git ref name, such as `refs/heads/main` or `refs/obts/devices/{device_id}`.
- `sync_attempt_id`: `sync_` plus ULID.
- `sync_operation_id`: `op_` plus ULID.
- `path_id`: `pth_` plus opaque identifier for path-scoped workflow and indexes; not a security boundary.
- `conflict_id`: `conf_` plus ULID.
- `event_id`: `evt_` plus ULID.

### 5.2 Core Tables

- `users`: account identity and password hash.
- `vaults`: owner user ID, display name, status, current main cursor, created timestamp, and updated timestamp.
- `devices`: vault-scoped paired devices, owning user ID, device ref name, and server-known state.
- `api_tokens`: hashed dashboard, device, and pairing tokens.
- `sync_operations`: durable per-vault write workflow rows with operation type, expected refs, target refs, target commit, lifecycle status, validation summary, and reconciliation state.
- `sync_attempts`: authenticated device push/pull attempts, lifecycle, expected ref metadata, result state, and redacted error category.
- `derived_indexes`: path, history, and summary indexes derived from Git for authorized lookup and dashboard performance.
- `conflicts`: thin workflow state, affected `path_id`s, affected path metadata, base/current/device commit cursors, expected `main`, stale/resolved status, resolution commit cursor, `merge_sequence`, `merge_policy_version`, and validator summary.
- `event_log`: persistent per-vault event rows with monotonic `event_seq`, event ID, event type, vault scope, resource IDs, commit cursors, redacted payload, and timestamp.
- `audit_log`: redacted operational events.

Postgres must not become the authoritative store for Git commits, trees, blobs, refs, or manifests. Those belong to the server Git store.

### 5.3 Git Persistence

The server receives Git packfiles over authenticated HTTPS. After authorization and validation, `GitRepositoryService` imports packfiles with the native `git` CLI into quarantine, `SyncService` validates ref update rules, and `ServerGitStoreService` persists updated per-vault Git state through the durable Git/Postgres write workflow. Git bundles and alternate object-transfer formats are outside v1.

Plugin settings and selected `.obsidian` files are treated as vault content inside Git for history, conflict, and logging rules.

Reads materialize Git state only for authorized server workflows and return content only to authorized clients over HTTPS.

Server startup and readiness require the native `git` CLI. If it is missing, unusable, or below the supported version range, readiness fails closed.

### 5.4 Canonical Path And Filesystem Policy

Rules:

- canonical vault-relative paths use `/`, reject absolute paths, reject traversal, and reject empty path segments;
- `.obts/` is always excluded from vault sync, Git worktree content, and manifest/path scanning;
- `.git/` directories inside visible vault content are rejected rather than synced;
- client and server use the same path validation library and test corpus;
- Unicode normalization and case-fold collision detection are mandatory before commit, upload, merge, and apply;
- cross-platform-invalid names, Windows reserved device names, trailing spaces/dots, NUL/control characters, and configured path length limits block sync with a clear error;
- path collisions are sync-blocking conflicts requiring user rename, not automatic overwrites;
- symlinks are not followed or synced in v1;
- file mode bits, executable bits, mtimes, and extended attributes are ignored except where the Obsidian vault API exposes required data for safe write checks;
- audit logs include resource classes and opaque IDs, but not note bodies, Git pack contents, raw blobs, plugin settings, or full content payloads.

### 5.5 Git History Model

Server `main` is `refs/heads/main` in the per-vault internal Git repository. Each paired device has a protected server-side device ref such as `refs/obts/devices/{device_id}`. Device refs are internal change proposals analogous to protected-branch merge candidates in Git hosting systems. The server may use additional internal refs for conflicts, recovery, maintenance, and temporary operations, but these are not exposed as user-facing Git workflow.

Each Git commit records normal Git parents, tree state, author/committer metadata, timestamps, and message metadata. `obts` associates commits with device/user/provenance through derived metadata and audit records. Git commit parent links, not timestamps, define ancestry and merge relationships.

Note history is derived from Git commits, path metadata, rename/delete provenance, and derived indexes. Note restore creates a new Git commit; it never rewrites existing commits. Destructive history truncation is outside v1.

Temporary Git repositories and merge workspaces may contain plaintext checked-out file trees and raw Git objects. They must be scoped to one transaction, permission-restricted, and cleaned after success or failure.

### 5.6 Deployment Storage Boundary

The application persistent-state boundary includes Postgres, `OBTS_DATA_DIR`, any configured server Git store directory, and any configured temporary-workspace recovery residue that must survive restart. `obts` must clearly document which state is required for backup and restore.

Failure rules:

- missing required Git state fails readiness;
- missing required database rows or migrations fail readiness;
- server Git store and Postgres generation/cursor inconsistencies fail readiness;
- missing native `git` CLI fails readiness;
- deployment-managed storage encryption and backup-key handling remain outside the app repo.

### 5.7 Durable Git/Postgres Write Workflow

Every vault-scoped write that can change Git refs, Git objects, Postgres metadata, derived indexes, conflict records, audit rows, or event rows follows one server workflow:

1. Acquire the per-vault lock.
2. Create and commit a `sync_operations` row with operation type, actor, expected refs, target refs, target commit, and status `started`.
3. Import uploaded or generated Git objects into a quarantine repository.
4. Validate object integrity, ancestry, upload size, canonical paths, authorization scope, and operation-specific invariants.
5. Promote validated Git objects into the per-vault server Git store.
6. Update the target Git ref with compare-and-swap semantics against the expected old commit.
7. In one Postgres transaction, write sync/conflict/history/index/audit metadata, append `event_log` rows, and mark the `sync_operations` row `committed`.
8. Release the per-vault lock.
9. Notify WebSocket and polling subscribers only from committed `event_log` rows.

Startup reconciliation and readiness rules:

- operations with status `started` and no matching Git ref change are aborted, and their quarantine state is removed;
- operations whose target Git ref already points at the recorded target commit are rolled forward by writing the missing Postgres metadata and `event_log` rows from the operation record and Git state;
- operations whose Git refs, Git objects, and Postgres rows cannot be reconciled deterministically set the vault status to `blocked_integrity`;
- a vault in `blocked_integrity` rejects sync, merge, conflict-resolution, note-restore, and maintenance mutations and causes readiness to fail closed until an operator repair command resolves the mismatch.

## 6. Interfaces And Contracts

### 6.1 API Conventions

- HTTPS APIs are served under `/api/v1`.
- Non-sync APIs use JSON request and response bodies.
- Device sync push and pull APIs use `multipart/form-data` with one `manifest` JSON part and one `packfile` part using Git packfile bytes.
- Device APIs authenticate with device tokens.
- Dashboard APIs authenticate with server-side session cookies only.
- Every vault-scoped endpoint checks account ownership, vault ownership, and device scope where applicable.
- Git sync APIs use commit identity, ref expectations, and idempotent retry behavior rather than custom proposal ordering.
- Events are available through WebSocket with polling fallback.
- v1 must ship a committed OpenAPI 3.1 contract as the canonical API contract artifact plus shared TypeScript schemas generated or validated against that contract.
- JSON errors use one redacted envelope: `{"error":{"code":"...","message":"...","request_id":"...","details":{...}}}`. `details` contains typed validation metadata only and never contains note bodies, raw paths, Git object bytes, token values, or secret values.
- Server, plugin, and dashboard contract tests must validate auth scopes, typed errors, redaction rules, idempotency/retry semantics, upload limits, pagination for list endpoints, event cursors/replay, and version compatibility.
- Incompatible or too-old clients must fail closed before mutating sync state.

### 6.2 Auth, Sessions, And Tokens

Auth requirements:

- first-run setup creates the initial admin account and cannot be repeated after setup is complete;
- v1 supports multiple user accounts in one server instance;
- every vault has exactly one owner, and v1 has no shared vault membership;
- admin status does not grant vault-content access unless that admin account owns the vault;
- user passwords require at least 12 characters and are hashed with Argon2id using `m=19456`, `t=2`, and `p=1` as the v1 minimum parameters;
- login attempts are rate-limited by account and source IP: 5 failed attempts in 10 minutes triggers exponential backoff starting at 1 minute and capped at 1 hour;
- dashboard auth uses a server-side cookie session named `__Host-obts_session` with at least 128 bits of entropy, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain` attribute;
- dashboard sessions have a 30-day absolute TTL and a 7-day idle TTL, refreshed on authenticated dashboard use;
- sensitive dashboard operations require password re-authentication within the previous 15 minutes: pairing token creation, device revocation, conflict resolution submission, note restore, content-bearing recovery export, Git maintenance start, password change, and admin account management;
- logout and account/device revocation invalidate matching server-side sessions immediately;
- cookie-authenticated mutation APIs require a CSRF token bound to the session and submitted in the `X-OBTS-CSRF` header;
- dashboard bearer tokens are not supported in v1;
- device and pairing tokens are opaque, contain at least 256 bits of entropy, and are stored server-side only as hashes with a non-secret lookup prefix;
- pairing tokens are one-time, scoped to one owning user and vault, expire after 10 minutes, allow at most 10 failed consume attempts, and are rate-limited by source IP;
- device tokens are scoped to one user, one vault, and one device;
- token rotation and device revocation take effect without waiting for client reconnect;
- login, pairing, failed auth, token rotation, and revocation write redacted audit records;
- unauthenticated requests return `401`;
- requests for vault-scoped resources not owned by the authenticated user return `404`;
- v1 does not ship email password reset;
- account recovery uses an audited local admin CLI command that creates a one-time recovery token without exposing vault content;
- plugin device tokens use platform secure storage when available, otherwise `.obts/` with restrictive local permissions.

### 6.3 Git Sync And Commit Contract

Device push request:

- content type: `multipart/form-data`;
- `manifest` part: JSON metadata;
- `packfile` part: Git packfile bytes.

Device push manifest fields:

- `vault_id`;
- `device_id`;
- expected current device ref or empty-ref marker;
- target commit ID;
- packfile SHA-256 and byte length;
- client-known `main` commit for merge context;
- sync attempt metadata and timestamps for diagnostics only.

Device pull request fields:

- `vault_id`;
- `device_id`;
- current local `main` commit;
- requested target `main` commit or `latest`;
- client API version.

Device pull response:

- content type: `multipart/form-data`;
- `manifest` part: JSON metadata with target `main`, required apply summary, changed-path metadata, and event cursor;
- `packfile` part: Git packfile bytes required to reach the target `main`.

Supported committed operations:

- create file;
- update file;
- delete file;
- rename file;
- create/update/delete selected `.obsidian` config file;
- create/update/delete selected plugin file when plugin sync is enabled.

Sync lifecycle:

1. `queued_local`
2. `committed_local`
3. `uploading`
4. `uploaded`
5. `validating_git`
6. `device_ref_updated`, `merge_pending`, `merged`, `conflicted`, `blocked_recovery`, or `rejected`

Rules:

- Clients never advance `main` directly.
- Server commits are created only from accepted device commits, clean merges, explicit conflict resolutions, or note-history restores.
- A repeated upload of commits already present on the server returns the same effective result or a no-op success.
- A device ref update is accepted only if it is a fast-forward from the current device ref or exactly repeats the current head.
- A same-device non-fast-forward update blocks sync and requires recovery; it must not silently overwrite the device ref.
- A stale client-known `main` triggers merge evaluation; it must not overwrite current `main` directly.
- Malformed Git transfers are rejected without advancing device refs or `main`.
- Git timestamps are never used to order sync or determine whether a change is new.

### 6.4 Merge Policy Contract

Merge behavior must be deterministic, auditable, and conservative.

Policy:

- Git merge-base and ancestry determine the candidate merge relationship;
- disjoint path edits auto-merge when no delete/rename collision exists;
- same-file Markdown/text edits auto-merge only when Git merge produces clean output and line, frontmatter, heading/block, link/embed, and conflict-marker validators all accept the final text;
- frontmatter auto-merges only for disjoint keys; same-key edits conflict;
- delete-vs-edit conflicts unless the edit is already contained in the deleted side's preserved history and the owner explicitly resolves it;
- rename-vs-edit auto-merges only when one side renames and the other side edits content without path collision;
- rename-vs-rename conflicts unless both sides produce the same target path;
- binary and attachment changes auto-merge only when Git/object identity is identical or paths are disjoint;
- selected `.obsidian` config and plugin files use file-level rules in v1; semantic config/plugin merge handlers are outside v1;
- unsafe, unsupported, or ambiguous cases create structured conflicts with base/current/device variants and provenance.

Merge queue rules:

- each accepted device ref update receives a server-assigned `merge_sequence`;
- one merge transaction runs at a time for each vault under the per-vault lock;
- merge candidates are processed in ascending `merge_sequence`;
- every merge decision stores `merge_policy_version`, base commit, current `main`, device commit, decision, and validator results;
- retries of the same merge candidate return the stored decision.

Conflict review lifecycle:

- Git remains authoritative for merge bases, variants, ancestry, object identity, and resolution commits;
- conflict workflow metadata is thin Postgres state over Git-backed commits, not an independent conflict-resolution engine;
- conflict records store conflict ID, vault/device/user scope, affected path IDs, lifecycle status, audit fields, base commit, current `main` at conflict creation, device commit, expected `main`, and optional resolution commit;
- resolution submissions include `expected_main`;
- the server accepts a resolution only when current `main` still matches `expected_main`;
- if `main` advanced, the review package becomes stale and must be refreshed or regenerated;
- duplicate submission of the same accepted resolution returns an idempotent success;
- accepted resolutions are written as normal Git commits or merge commits descending from current `main`.

### 6.5 Main APIs

- `POST /api/v1/pair/consume`: consume a pairing token and register a device.
- `GET /api/v1/vaults/{vault_id}/main`: return current `main` metadata and authorized summary.
- `POST /api/v1/vaults/{vault_id}/sync/push`: upload a push manifest and Git packfile, then request a device ref update.
- `POST /api/v1/vaults/{vault_id}/sync/pull`: request a target `main` and receive a pull manifest plus Git packfile needed to reach it.
- `POST /api/v1/vaults/{vault_id}/history/query`: list note history for an authorized path supplied in a redacted request body.
- `POST /api/v1/vaults/{vault_id}/history/version`: fetch a historical note version or diff source for a commit/path supplied in a redacted request body.
- `POST /api/v1/vaults/{vault_id}/history/restore`: restore a historical note version through a new Git-backed merge/resolution commit.
- `GET /api/v1/vaults/{vault_id}/conflicts?status=open`: list conflicts visible to the authorized user/device.
- `GET /api/v1/vaults/{vault_id}/conflicts/{conflict_id}`: fetch conflict review content.
- `POST /api/v1/vaults/{vault_id}/conflicts/{conflict_id}/resolve`: submit a resolution.
- `GET /api/v1/vaults/{vault_id}/events?after={event_seq}`: poll authorized events after a cursor.
- `GET /api/v1/vaults/{vault_id}/events/stream`: subscribe to authorized event delivery over WebSocket.
- `POST /api/v1/vaults/{vault_id}/maintenance/git-gc/start`: run owner-confirmed Git verification and repack over server Git state.

### 6.6 Events

Events include:

- `main_advanced`;
- `device_ref_updated`;
- `device_sync_rejected`;
- `device_recovery_required`;
- `conflict_created`;
- `conflict_resolved`;
- `note_restored`;
- `device_state_changed`;
- `vault_maintenance_started`;
- `vault_maintenance_finished`.

Event payloads must be authorized by vault scope and must not include full note bodies, raw blobs, Git pack data, or raw paths.

Event log contract:

- each vault has a persistent event log with monotonically increasing `event_seq`;
- each event contains `event_id`, `event_seq`, event type, vault ID, redacted resource IDs, commit cursors, redacted payload, and timestamp;
- WebSocket and polling return the same event envelope;
- event retention is 30 days and 100,000 events per vault;
- a request for an expired or pruned cursor returns `410 Gone`, and the client performs a full state refresh before resuming from the returned current cursor;
- event payloads must not contain full note bodies, raw blobs, Git pack data, token values, secret values, plugin settings, or raw paths.

## 7. Config

### 7.1 Server Environment

Required:

- `DATABASE_URL`
- `OBTS_DATA_DIR`
- `OBTS_PUBLIC_BASE_URL`
- `OBTS_SESSION_SECRET`

Optional:

- `OBTS_GIT_STORE_DIR`
- `OBTS_TEMP_DIR`
- `OBTS_LOG_LEVEL`
- `OBTS_MAX_UPLOAD_BYTES`
- `OBTS_EVENT_POLL_INTERVAL_MS`
- `OBTS_GIT_BINARY`

Defaults:

- `OBTS_GIT_STORE_DIR`: `${OBTS_DATA_DIR}/git`
- `OBTS_TEMP_DIR`: `${OBTS_DATA_DIR}/tmp`
- `OBTS_LOG_LEVEL`: `info`
- `OBTS_MAX_UPLOAD_BYTES`: `104857600`
- `OBTS_EVENT_POLL_INTERVAL_MS`: `15000`
- `OBTS_GIT_BINARY`: `git`

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

`syncPlugins` defaults to `false`. When `false`, `.obsidian/plugins/**` is ignored completely. When `true`, `.obsidian/plugins/**` is included in sync like other selected vault state, including plugin code and settings, except `.obsidian/plugins/obts/**`.

Auth tokens are stored using Obsidian/platform secret storage when available; otherwise they are stored under `.obts/` with restrictive local permissions.

## 8. Required v1 Feature Designs

### 8.1 Obsidian Configuration Sync

`obts` syncs selected `.obsidian` state through an explicit file policy. It does not require typed materializers for v1.

Rules:

- `.obts/` is always excluded from vault sync, Git worktree content, and manifest/path scanning.
- v1 note file types are `.md`, `.canvas`, and `.base`.
- The `notes_only` profile syncs Obsidian note files and excludes attachment files, `.obsidian/**`, `.obts/**`, `.git/**`, `.trash/**`, editor temp files, Obsidian runtime/cache files, and OS metadata files.
- The `notes_plus_attachments` profile syncs notes plus Obsidian-supported attachment files located according to the active Obsidian **Default location for new attachments** setting, and excludes `.obsidian/**`.
- v1 supports the documented Obsidian attachment-location modes:
  - **Vault folder:** supported attachment files at the vault root;
  - **In the folder specified below:** supported attachment files under the configured folder;
  - **Same folder as current file:** supported attachment files in folders that contain synced note files;
  - **In subfolder under current folder:** supported attachment files under the configured subfolder name beside synced note files.
- v1 attachment file types are Obsidian-supported non-note files: images (`.avif`, `.bmp`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp`), audio (`.flac`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.3gp`), video (`.mkv`, `.mov`, `.mp4`, `.ogv`, `.webm`), and PDFs (`.pdf`).
- Unknown, unreadable, or invalid attachment-location settings block sync with a clear error instead of guessing.
- The server enforces a documented maximum upload byte limit through `OBTS_MAX_UPLOAD_BYTES`; files larger than that limit block upload/apply for the affected file with a clear error.
- The `full_vault_config` profile syncs notes, attachments, and only these `.obsidian` files by default:
  - `.obsidian/app.json`;
  - `.obsidian/appearance.json`;
  - `.obsidian/backlinks.json`;
  - `.obsidian/bookmarks.json`;
  - `.obsidian/command-palette.json`;
  - `.obsidian/core-plugins.json`;
  - `.obsidian/core-plugins-migration.json`;
  - `.obsidian/daily-notes.json`;
  - `.obsidian/editor.json`;
  - `.obsidian/graph.json`;
  - `.obsidian/hotkeys.json`;
  - `.obsidian/outgoing-link.json`;
  - `.obsidian/page-preview.json`;
  - `.obsidian/properties.json`;
  - `.obsidian/switcher.json`;
  - `.obsidian/templates.json`;
  - `.obsidian/types.json`;
  - `.obsidian/snippets/*.css`.
- `full_vault_config` always excludes `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/cache/**`, `.obsidian/trash/**`, `.obsidian/plugins/**` unless `syncPlugins` is `true`, and every `.obsidian` path not listed in the allowlist above.
- `.obsidian/plugins/**` is controlled only by the `syncPlugins` setting.
- When `syncPlugins` is `false`, `.obsidian/plugins/**` is completely ignored.
- When `syncPlugins` is `true`, the full `.obsidian/plugins/**` directory is synced as normal vault state, including `manifest.json`, `main.js`, `styles.css`, `data.json`, and any plugin-owned files, except `.obsidian/plugins/obts/**`.
- Changing `syncPlugins` takes effect on future scans without requiring Obsidian restart.
- Plugin files are executable/sensitive content. When synced, they are Git-backed vault state and participate in file-level history, recovery, and conflict handling. Diagnostics exports and note-history UI redact plugin file content by default.
- Already-loaded plugin code may continue to run until Obsidian or the plugin reloads; `obts` does not force that reload as part of sync.
- `obts` must not update its own running plugin code through normal plugin sync.

### 8.2 Note History And Restore

v1 exposes Git-backed note-level history without exposing raw Git workflows.

Required behavior:

- list versions for an authorized vault path;
- show create, update, delete, rename, conflict, merge, and restore provenance;
- show source and rendered diffs for Markdown/text note files;
- show metadata-only history for plugin files by default and require an explicit owner content export to display plugin file bodies;
- restore a historical note version by creating a normal Git-backed merge/resolution commit;
- preserve local recovery semantics before applying a restored server `main`.

### 8.3 Persistent-State Backup Contract

Backup orchestration is a deployment concern. The app repo must not prescribe backup schedules, offsite locations, environment-specific infrastructure paths, or private restore automation.

`obts` must document the persistent state that deployment backups must capture:

- Postgres database;
- `OBTS_DATA_DIR`;
- server Git store directory if configured separately;
- deployment-managed backup encryption keys or storage credentials, backed up separately from app state when the deployment uses them.

State capture must be quiesced or point-in-time consistent across Postgres and the server Git store. After restore, `GET /health/ready` must fail closed when required Git state, database state, migrations, filesystem permissions, or native `git` CLI availability is missing or inconsistent.

### 8.4 Git Maintenance

Routine maintenance verifies Git object integrity, repacks server Git state, prunes objects unreachable from `main`, device refs, unresolved conflict refs, and recovery refs, and refreshes derived indexes without changing visible history.

v1 retains all commits reachable from `main`, device refs, unresolved conflict refs, and recovery refs indefinitely. v1 does not provide destructive history truncation, baseline compaction, or a compact-history API.

### 8.5 Recovery Bundles

Before destructive local apply or rebuild, the plugin writes a local recovery bundle under `.obts/recovery/{bundle_id}/`. Recovery bundles are local sensitive state and are not synced as vault content.

The apply journal is stored at `.obts/apply-journal.json` and contains apply ID, operation type, target `main`, expected prior local `main`, expected prior local device ref, phase, affected paths, per-file preflight SHA-256 values, recovery bundle ID, last completed step, and redacted error category. The phase value is one of `planned`, `recovery_bundle_written`, `writing_files`, `verifying`, `committed`, or `blocked_recovery`.

Every recovery bundle contains:

- `manifest.json` with bundle ID, vault ID, device ID, created timestamp, operation type, target `main`, prior local `main`, prior local device ref, affected paths, platform, plugin version, and checksum manifest;
- `files/` with pre-apply snapshots of every file that will be deleted, overwritten, or renamed;
- `git/local-refs.pack` with local commits and refs needed to recover pending local history;
- `patches/` with text patch series for changed Markdown/text files;
- `journal/apply-journal.json` with the apply journal state at bundle creation;
- `checksums.sha256` covering every file in the bundle.

Local apply/recovery rules:

- destructive apply and rebuild operations require a recovery bundle first;
- recovery bundles are created before file deletes, overwrites, renames, or profile changes that remove local content;
- recovery bundle creation failure blocks the destructive operation;
- recovery bundles are retained until the user explicitly deletes them;
- diagnostics exports must redact or omit recovery bundle content unless the owner explicitly requests a content-bearing export.

### 8.6 Platform Support Matrix

v1 platform support:

- **Desktop Linux/macOS/Windows:** supported target platforms for file watching, periodic scanning, hidden local Git state, local recovery bundles, secure token storage where available, plugin settings, and plugin sync when enabled.
- **Android/iOS:** supported v1 target platforms for foreground sync, periodic scanning, hidden local Git state, local recovery bundles, secure token storage where available, plugin settings, safe apply, and plugin sync when enabled.
- **Client Git implementation:** the Obsidian plugin uses `isomorphic-git` for client-side Git operations on every supported platform.
- **Client storage:** the plugin stores hidden Git state under `.obts/` through an `isomorphic-git` filesystem adapter backed by Obsidian's `DataAdapter`, including mobile `CapacitorAdapter`.
- **Server Git implementation:** the server uses the native `git` CLI for repository validation, packfile import/export, ref updates, merge-base, merge, diff, history, maintenance, and conflict workflows.
- **Unsupported behavior:** background real-time sync guarantees, OS-level file access outside the vault, and platform-specific plugin installation management.
- **Plugin API rule:** the sync path must not require Node.js or Electron APIs in the Obsidian plugin; desktop-only optional behavior must be gated away from mobile sync.

Linux, macOS, Windows, Android, and iOS must each have explicit manual acceptance coverage before v1 is advertised as supported.

## 9. Constraints And Failure Modes

### 9.1 Fail-Closed Behavior

- Missing database: readiness fails.
- Missing server Git store: readiness fails.
- Missing temp workspace: readiness fails.
- Missing or unusable native `git` CLI: readiness fails.
- Unauthenticated access: `401`.
- Cross-user vault access: `404`.
- Malformed Git transfer: reject without advancing refs.
- Same-device non-fast-forward update: block and require recovery.
- Merge ambiguity: create conflict instead of overwriting.
- Local apply risk: recovery bundle and apply journal first or block.
- Restored persistent state incomplete: readiness fails closed.
- Unreconciled Git/Postgres mismatch: vault enters `blocked_integrity` and readiness fails closed.
- Expired event cursor: event endpoint returns `410 Gone` and client performs a full state refresh.

### 9.2 Observability

Logs include request IDs, user/device IDs, vault IDs, operation classes, durations, and error categories. Logs avoid full content payloads, Git pack contents, raw blobs, and raw paths by default.

Metrics include sync latency, Git push/pull counts, device ref update outcomes, merge outcomes, conflict counts, server Git store bytes, persistent-state integrity status, native `git` readiness, and event delivery health.

Health checks cover database, server Git store, temp workspace, Git materialization, native `git` CLI readiness, migrations, and filesystem permissions.

## 10. Delivery Plan

### 10.1 v1 Scope

Server:

- auth, setup, vault, device, and token services;
- multi-tenant account lifecycle with single-owner vault authorization;
- native `git` CLI integration and server Git store;
- Git sync, device refs, derived indexes, note history, conflicts, and server-side merge;
- dashboard APIs and static dashboard serving;
- persistent-state integrity checks, Git maintenance, health, and deployment backup documentation.

Plugin:

- vault watcher and periodic scanner;
- `isomorphic-git` hidden local Git state under `.obts/` through the Obsidian adapter;
- local durable commits and recovery snapshots;
- local apply journal and recovery bundle workflow;
- upload device ref updates and pull/apply `main`;
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

1. Monorepo/package skeleton, shared types, Git harness, API contract artifact, and contract tests.
2. Server auth, multi-user account lifecycle, vault/device setup, native `git` CLI repository service, server Git store, and schema.
3. Plugin `isomorphic-git` hidden Git state, Obsidian filesystem adapter, scan/commit/upload/pull/apply loop, and first-sync safety.
4. Server device ref updates, server-side merge, conflicts, dashboard review, and resolution commits.
5. Git-backed note history/restore, Git maintenance, persistent-state checks, diagnostics, and recovery.
6. Hardening, performance, mobile constraints, and release packaging.

## 11. Testing And Proof

### 11.1 Unit Tests

- canonical path normalization;
- canonical path collision and platform-invalid-name handling;
- `isomorphic-git` local Git engine commit/import behavior;
- Obsidian `DataAdapter` filesystem adapter behavior;
- server Git store persistence and materialization boundaries;
- durable Git/Postgres write workflow and startup reconciliation;
- server native `git` CLI invocation and error handling;
- authz checks for every vault-scoped resource;
- auth/session/token hashing, rotation, revocation, and CSRF rules;
- multi-user account lifecycle, setup, session TTL, recent-auth checks, rate limits, and local admin recovery;
- device ref fast-forward, no-op retry, and non-fast-forward rejection rules;
- merge policy decisions;
- merge queue ordering, merge policy versioning, and validator result persistence;
- event-log cursor, replay, retention, and expired-cursor behavior;
- note history indexing and restore commit creation;
- conflict creation and resolution;
- stale conflict review and idempotent duplicate resolution submission;
- local queue, fixed apply journal schema, fixed recovery bundle schema, and Git state crash recovery.

### 11.2 Integration Tests

- two devices sync one vault through server `main`;
- vault creation initializes `main` with a server-authored empty-tree root commit;
- no visible `.git` appears in the vault while `.obts/` contains hidden Git state;
- `isomorphic-git` commits and trees produced by the plugin are accepted by server native `git`;
- Git packfile transfer from plugin to server validates with native `git`;
- device push and pull use multipart manifests plus Git packfiles exactly as described in OpenAPI;
- ancestry, fast-forward, and merge-base behavior are compatible between client expectations and server authority;
- repeated push of the same commit is idempotent;
- new commit advances the device ref;
- same-device non-fast-forward update blocks and requires recovery;
- concurrent disjoint edits auto-merge;
- concurrent same-file Markdown edits merge when safe;
- ambiguous same-file edits create a conflict;
- dashboard resolves a conflict and advances `main`;
- note history shows prior versions and restores one note through a new Git commit;
- non-empty local vault join creates a recovery bundle and never silently discards local content;
- first-device non-empty local vault import creates a recovery bundle, requires owner confirmation, uploads an initial device commit, and merges through server `main`;
- additional-device non-empty divergent vault pairing creates a recovery bundle and blocks normal sync until explicit replace-local-with-server;
- plugin sync disabled ignores `.obsidian/plugins/**`;
- plugin sync enabled includes `.obsidian/plugins/**` and blocks self-update of `obts`;
- destructive history compaction API is absent in v1;
- unauthorized user cannot access another user's vault resources;
- restored persistent state with missing Git state, missing database state, missing migrations, bad filesystem permissions, or missing native `git` CLI fails readiness.

### 11.3 Security Tests

- database dumps, server Git stores, recovery bundles, diagnostics exports, and backups are documented as sensitive app state;
- deployment-managed backup encryption can be configured without app-specific environment-specific infrastructure assumptions;
- plaintext Git material exists only in scoped temp workspaces;
- cross-account Git ref/object/conflict/event access denied;
- admin accounts cannot access another user's vault content unless they own that vault;
- logs do not include raw tokens, passwords, Git pack contents, raw blobs, plugin settings, note bodies, or full content payloads by default.

### 11.4 Manual Acceptance

- no `.git` appears in the visible vault;
- dashboard login is enough to review conflicts;
- no vault passphrase prompt exists in v1;
- offline edits survive restart and sync as Git commits;
- server-side merge works for simple Markdown conflicts;
- note history can compare and restore an earlier note version;
- recovery after failed local apply preserves edits;
- plugin sync setting behaves as documented;
- Android and iOS foreground sync pass the same data-safety acceptance cases as desktop within documented mobile limits;
- advertised desktop/mobile platform support matches observed behavior.

## 12. Alternatives Considered

### 12.1 True E2EE

Rejected for v1. It complicates dashboard UX, server-side merge, conflict review, path handling, key recovery, and passphrase changes. It is also weaker in a server-served browser dashboard because a compromised server can serve modified JavaScript.

### 12.2 Application-Level Encrypted Git Store

Deferred beyond v1. Application-level encrypted Git storage, per-vault data keys, and app-managed content key rotation would improve offline disclosure resistance for copied stores and backups, but they add substantial storage, transaction, backup, and restore complexity. v1 instead treats server state as sensitive app data and relies on deployment-managed at-rest protection.

### 12.3 Custom History Engine

Rejected for v1. Git already provides commit identity, ancestry, trees, diffs, merge bases, object integrity, and ref semantics. `obts` builds an Obsidian-safe product layer on top of Git instead of recreating those primitives in Postgres.

### 12.4 Raw Git In The Vault

Rejected because it exposes Git UX, stores `.git` in the visible vault, creates cross-platform/mobile problems, and does not provide Obsidian-specific recovery UX.

### 12.5 Native Git In The Obsidian Plugin

Rejected for v1 because iOS and Android Obsidian plugins cannot rely on Node.js, Electron, native `git`, or desktop filesystem APIs. v1 uses `isomorphic-git` inside the plugin and native `git` CLI only on the server.

### 12.6 CRDT-First Sync

Rejected for v1. Obsidian vaults are file-oriented and include binary attachments and plugin configuration. A canonical-main Git model with explicit conflict review is simpler.

### 12.7 Typed Managed Config Materializers

Rejected for v1. Typed handlers for every Obsidian and plugin setting would turn configuration sync into a separate configuration-management product. v1 instead uses an explicit `.obsidian` file policy with plugin sync controlled by one user setting.

### 12.8 App-Managed Backup Product

Rejected for v1. Backup scheduling, retention, offsite storage, and restore orchestration are deployment concerns. The app defines required persistent state and fail-closed readiness checks, while external infrastructure performs backups.

### 12.9 Destructive History Compaction

Rejected for v1. v1 promises Git-backed note history and recovery, so reachable history remains available indefinitely. v1 Git maintenance verifies, repacks, and prunes only unreachable objects.

## 13. Agent Guardrails

- Do not reintroduce true E2EE as a v1 requirement unless the product decision changes.
- Do not reintroduce an application-level encrypted Git store, per-vault data keys, `OBTS_MASTER_KEY`, or app-managed content key rotation as a v1 requirement unless the product decision changes.
- Do not replace Git with a custom commit graph, manifest, diff, or merge-base engine unless the product decision changes.
- Do not add shared vault membership or cross-user vault sharing to v1 unless the product decision changes.
- Keep v1 multi-tenant: multiple users are supported, but each vault has exactly one owner.
- Keep client-side Git on `isomorphic-git` and server-side Git on the native `git` CLI unless the product decision changes.
- Keep v1 Git transfer on multipart manifests plus Git packfiles; do not add bundles or alternate object transports unless the product decision changes.
- Do not add destructive history compaction, baseline truncation, or a compact-history API to v1 unless the product decision changes.
- Do not add environment-specific infrastructure-specific deployment files, organization-specific image repository names, deployment secret store paths, or private hostnames to this app repo.
- Do not create `.git` directories inside visible vault content.
- Keep `.obts/` excluded from vault sync, Git worktree content, and manifest/path scanning.
- Keep `.obsidian/plugins/**` ignored by default; include it only when the user enables plugin sync.
- Do not log or print secret values, passwords, tokens, Git pack contents, raw blobs, plugin settings, or full note bodies.
- Treat `architecture/workspace.dsl` as the authored architecture source. Treat `architecture/DIAGRAMS.md` and `architecture/export/*` as generated.
- If implementation later contradicts this PRD, refresh the architecture from code and executable config first.
