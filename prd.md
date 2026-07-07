# Obsidian True Sync (`obts`) - Product + Technical Spec

## 0. Executive Summary

`obts` is a self-hosted, Git-backed sync system for Obsidian vaults. It preserves local-first editing, central canonical state, recoverable history, conflict review, and clear device status without exposing Git workflows to note authors and without putting a normal `.git` directory in the visible vault.

Git is the internal history engine for v1. Local edits become hidden Git commits, device uploads advance protected per-device Git refs that act as internal merge candidates, and the server advances canonical `main` through Git-backed merge or explicit conflict resolution. Paired devices sync the full vault subject to hard safety exclusions for `obts` internal state, visible Git repositories, Obsidian cache/workspace files, and the running `obts` plugin directory. `obts` adds the Obsidian-specific product layer around Git: pairing, authorization, deployment-managed storage protection, safe local apply, recovery bundles, dashboard conflict review, note history, and maintenance.

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

- Sync full vault content between paired devices subject to hard safety exclusions.
- Preserve local-first editing and offline commits.
- Use Git as the authoritative internal history, ancestry, diff, and merge backbone.
- Maintain a single server `main` Git ref per vault.
- Use server-side Git merge plus conservative Obsidian-aware semantic merge policy for Markdown, JSON Canvas, and Obsidian Bases conflicts where safe.
- Provide a dashboard for devices, conflicts, note history, recovery, and maintenance.
- Support deployment-managed at-rest protection through documented storage, permission, and backup requirements.
- Enforce strict account and vault authorization for every API and event stream.
- Avoid `.git` directories inside visible Obsidian vaults.
- Keep plugin UX simple: server URL, login/pairing, and device name.
- Document the app persistent-state backup contract without embedding deployment-specific backup automation.

### 1.4 Non-Goals

- True E2EE or zero-knowledge server operation in v1.
- Hiding plaintext paths or content from the live server process.
- Requiring a separate vault passphrase after dashboard login.
- Shared vault membership, collaborative vault access, or granting a user access to another user's vault.
- Shared real-time collaborative editing, cursors, CRDT/OT sessions, or presence.
- Reinventing Git commit graph, tree, diff, merge-base, object identity, or ref semantics in custom database tables.
- Exposing raw Git commands, Git remotes, branches, or conflict markers as the normal user experience.
- Syncing `obts` internal state, visible Git repositories, Obsidian cache/workspace files, or the running `obts` plugin directory.
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
12. If this is an additional paired device and the local vault contains user content that differs from server `main`, the plugin first checks whether the local vault is a clean stale copy of a detached unpaired baseline for the same vault.
13. A clean stale copy may fast-forward during re-pair when all of the following are true: the detached baseline vault ID matches the newly paired vault; the local visible syncable files exactly match the baseline commit tree under the full-vault path policy; the baseline commit is available in local hidden Git state; and the baseline commit is an ancestor of current server `main` after the plugin imports the server pull pack.
14. When the clean stale-copy checks pass, the plugin applies current server `main` through the normal apply journal and recovery-bundle protections, records the new device as synced, and does not require replace-local-with-server.
15. When the clean stale-copy checks fail, additional-device pairing with local content that differs from server `main` does not adopt another device's identity or force replace-local. The plugin records the visible filesystem as this device's own proposal commit, using current server `main` as a trusted proposal base when no safer same-device baseline exists, then uploads it through this device's ref for normal server merge or conflict handling.
16. If local `.obts/` Git state belongs to another vault or is partially initialized beyond the detached-baseline case, pairing blocks until the owner runs a recovery or reset flow.

Acceptance criteria:

- Pairing token is one-time, short-lived, and scoped to one owning user, one vault, and the issued device display name.
- Device token is scoped to one user and one vault.
- No vault passphrase is required.
- No visible `.git` directory is created inside the vault.
- Server `main` exists immediately after vault creation and points to a real empty-tree root commit, not an empty or unborn ref.
- First sync never silently discards local content.
- First-device import of non-empty local content requires a recovery bundle and explicit owner confirmation before upload.
- Additional-device pairing of non-empty divergent local content commits and uploads the local filesystem as that device's proposal instead of requiring replace-local-with-server.
- Re-pairing a previously synced device whose local files still exactly match an old server `main` commit safely fast-forwards to current server `main` without replace-local-with-server.
- Re-pairing blocks instead of fast-forwarding when the detached baseline is missing, belongs to another vault, is not an ancestor of current server `main`, or no longer matches visible local files.

### 3.4 Local Edit Sync

When a user edits local vault files, the visible local filesystem is the device's source of truth. The plugin records filesystem differences as one or more hidden Git commits under `.obts/`, uploads Git packfiles over authenticated HTTPS, and keeps retry state durable. Local `state.json` is recoverable coordination metadata, not authoritative content state.

Acceptance criteria:

- Local edits are durably committed or recoverably snapshotted before upload.
- On startup and before sync decisions, the scanner commits visible filesystem differences to the local Git journal when path policy validation passes.
- If `state.json` is missing, corrupt, or incomplete but the device token and local Git journal are intact, the plugin rehydrates non-secret identity/ref metadata from the server and resumes normal commit/upload behavior without reset or re-pair.
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
- The plugin has one v1 apply behavior: automatically pull and apply server `main` after preflight, apply journal creation, recovery bundle creation, and watcher suppression setup succeed.
- If automatic apply cannot proceed safely, the plugin blocks sync, preserves local state, surfaces the blocked status, and directs the owner to the dashboard conflict or recovery workflow.

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
9. Same-path Markdown, `.canvas`, `.base`, and selected text file changes are checked out into an ephemeral server merge workspace.
10. The merge service uses Git merge machinery plus conservative Markdown, JSON Canvas, and Obsidian Bases semantic merge validation.
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
5. Dashboard displays rendered Markdown diff, source diff, affected paths, path/title variants for structural conflicts, and available merge choices.
6. User accepts current `main`, accepts device version, keeps both, inserts both blocks, or manually edits a final result. For path/title conflicts such as rename-vs-rename, manual resolution includes the final vault path plus final file content, not only body text at existing affected paths.
7. Dashboard submits the selected resolution with the conflict ID, CSRF token, and expected current `main`; a normal authenticated session is sufficient.
8. Server accepts the resolution only if current `main` still matches the expected commit.
9. If `main` advanced, the review package is marked stale and the dashboard must refresh or regenerate it before resolution.
10. Server writes the accepted resolution as a merge commit. Parent 1 is `expected_main`, parent 2 is the conflicted device commit, and the resulting tree is exactly the accepted final state.
11. Conflict choices apply only to the affected review paths. Non-conflicting additions, edits, and deletes from the conflicted device commit are preserved in the accepted final state unless they are explicitly included in the reviewed conflict paths.
12. Server persists updated Git state, advances `main` to the resolution merge commit, and marks the conflict resolved.

Acceptance criteria:

- Unauthorized users cannot list, view, or resolve conflicts for another vault.
- Conflict review packages include path/title metadata for structural conflicts: base path, current server path, device path, per-side path operation, and affected paths.
- Resolution commits are merge commits that reference the conflict they resolved.
- Accepting current `main` keeps the server version only for affected review paths and preserves non-conflicting device-side changes from the same device commit.
- When there are no non-conflicting device-side changes to preserve, accepting current `main` creates a same-tree merge commit with parent 1 set to `expected_main` and parent 2 set to the conflicted device commit.
- Duplicate submission of the same accepted resolution is idempotent.
- All clients receive a `main_advanced` event after resolution.
- Conflict resolution submission requires a valid dashboard session and CSRF token, but does not require password re-authentication beyond the normal session.

### 3.8 Device Dashboard

The dashboard shows:

- paired devices;
- device names and last-seen status;
- current server `main` commit;
- each device ahead/behind/offline/blocked state;
- unresolved conflicts;
- maintenance state;
- persistent-state and health summaries.

### 3.9 Dashboard UI Contract

The dashboard must be implemented as a compact authenticated application shell,
not as a landing page, marketing site, or decorative analytics dashboard.

Dashboard frontend stack:

- use Svelte, Vite, and TypeScript;
- implement the dashboard as a client-rendered SPA built to static assets served
  by the Fastify server;
- do not add SvelteKit server routes, SSR, or a second application server;
- keep dashboard source under `frontend/dashboard/`;
- keep dashboard API client and generated OpenAPI types under
  `frontend/dashboard/src/api/`.

#### 3.9.1 App Shell

Desktop layout:

- left sidebar: fixed width `240px`, full viewport height;
- content header: `56px` high, pinned to the top of the content area;
- main content: scrollable area using a 12-column grid, `16px` column gap, and
  `24px` page padding;
- minimum supported desktop content width: `1024px`;
- wide tables may scroll horizontally instead of being converted into card
  grids.

Responsive layout:

- below `900px` viewport width, collapse the sidebar into a menu button in the
  content header;
- below `900px`, all page layouts become one column with `16px` page padding;
- table/list rows remain the primary representation on mobile, with secondary
  fields allowed to wrap into a row detail area.

Sidebar:

- the current vault selector appears at the top;
- primary navigation items appear in this order: Overview, Devices, Conflicts,
  History, Maintenance, Settings;
- unresolved conflict count appears as a badge beside Conflicts;
- account/session actions appear at the bottom.

Content header:

- left side: page title and optional vault/status subtitle;
- right side: last refreshed timestamp, refresh action, and the page's primary
  action;
- each page may have at most one primary button in the header.

#### 3.9.2 Visual System

Use these implementation constraints unless an explicit design-system file later
replaces them:

- font family: system sans-serif for UI text, system monospace for technical
  identifiers;
- base text: `14px` font size, `20px` line height;
- table text: `13px` or `14px`;
- page title: `24px` font size, `32px` line height, `600` weight;
- section heading: `16px` font size, `24px` line height, `600` weight;
- no viewport-scaled font sizes;
- spacing scale: `4px`, `8px`, `12px`, `16px`, `24px`, `32px`;
- border radius: `6px` for panels, tables, inputs, buttons, badges, menus, and
  dialogs; `8px` maximum anywhere in the dashboard;
- panel border: one-pixel solid border using the current theme border token;
- do not nest cards or panels inside other cards or panels;
- do not use hero sections, marketing copy blocks, decorative illustrations,
  gradient backgrounds, gradient text, or oversized decorative cards.

Theme tokens:

| Token | Light | Dark |
| --- | --- | --- |
| Background | `#F7F8FA` | `#0F1117` |
| Surface | `#FFFFFF` | `#171A21` |
| Raised surface | `#F1F3F7` | `#202633` |
| Border | `#D8DEE8` | `#313847` |
| Text | `#17202E` | `#E7EAF1` |
| Muted text | `#5C667A` | `#A6AEBE` |
| Primary | `#4F5BD5` | `#7A86FF` |
| Success | `#1F8F5A` | `#36B979` |
| Info | `#2474D6` | `#4A9DFF` |
| Warning | `#B7791F` | `#D89B2B` |
| Danger | `#C93C45` | `#EF5B63` |
| Neutral | `#6B7280` | `#8792A2` |

Status color roles:

- Success: synced, healthy, completed;
- Info: uploading, applying, checking, merging, maintenance running;
- Warning: ahead, behind, offline, review needed, stale review;
- Danger: blocked, needs recovery, unsafe local state, integrity failure,
  failed maintenance;
- Neutral: idle, unknown, metadata-only state.

Color alone is never sufficient. Every status must include an icon and a text
label.

#### 3.9.3 Controls And Buttons

Buttons:

- default button height: `32px`; mobile/touch button height: at least `40px`;
- primary button: filled with the Primary token, used only for the main next
  action on a page or dialog;
- secondary button: neutral outline or neutral surface;
- danger button: filled or outlined with the Danger token and used only for
  destructive or blocking actions;
- destructive actions require a confirmation dialog;
- sensitive actions that require recent authentication must open the recent-auth
  dialog before submission;
- disabled buttons must explain the blocking reason in nearby helper text or a
  tooltip.

Icon buttons:

- size: `32px` square on desktop, at least `40px` square on touch layouts;
- icon-only buttons require a tooltip;
- copy actions use a copy icon button immediately beside the value being copied.

Technical identifiers:

- commit IDs, refs, event IDs, request IDs, operation IDs, vault IDs, device IDs,
  and conflict IDs use monospace text;
- identifiers are truncated by default, with full value available through copy
  action and an expandable details section;
- raw Git refs and commit IDs may appear as secondary metadata, but not as the
  primary explanation of user-visible state.

#### 3.9.4 Status Vocabulary

Dashboard and plugin status labels must use this shared vocabulary:

| Label | Role | Use |
| --- | --- | --- |
| Synced | Success | Device and server state are current. |
| Uploading | Info | Device changes are being sent to the server. |
| Applying | Info | Accepted server state is being written locally. |
| Checking | Info | The server or client is verifying state. |
| Merging | Info | The server is evaluating accepted device changes. |
| Ahead | Warning | The device has local committed changes not yet on server `main`. |
| Behind | Warning | The device has not yet applied current server `main`. |
| Offline | Warning | The device has not been seen within the configured offline window. |
| Review needed | Warning | A conflict requires owner review. |
| Stale review | Warning | A conflict package must be refreshed before resolution. |
| Blocked | Danger | Sync is stopped until user or operator action completes. |
| Needs recovery | Danger | A recovery bundle or reset/re-pair flow is required. |
| Unsafe local state | Danger | Local apply or upload is blocked to avoid data loss. |
| Integrity failure | Danger | Persistent state is inconsistent and mutations are blocked. |

#### 3.9.5 Overview Page Wireframe

Header:

- title: `Overview`;
- subtitle: selected vault name and top-level vault status;
- primary action: `Pair device`.

First row: four equal summary panels, each spanning three grid columns and using
a fixed minimum height of `104px`:

1. Sync status;
2. Unresolved conflicts;
3. Paired devices;
4. Health/readiness.

Second row:

- left eight columns: Devices table;
- right four columns: Attention panel.

Third row:

- left eight columns: Recent activity list;
- right four columns: Maintenance and backup health checklist.

The Attention panel lists, in order: integrity failures, blocked devices,
conflicts, stale reviews, unsafe local states, offline devices. Each item has a
single action link or button.

#### 3.9.6 Devices Page Wireframe

The Devices page uses a compact table. Row height should be `44px` on desktop.

Columns, in order:

1. Device;
2. Status;
3. Last seen;
4. Ahead/behind;
5. Applied version;
6. Last successful sync;
7. Actions.

The Actions column uses an overflow menu for secondary actions. Device
revocation is always a danger action and requires recent authentication.

#### 3.9.7 Conflicts Page Wireframe

Conflict list view:

- table columns: Path, Device, Conflict type, Created, Status, Action;
- unresolved conflicts appear before resolved conflicts;
- stale conflicts show the Stale review status and a Refresh action.

Conflict detail view uses a three-region workbench:

- left rail: `280px` wide, with affected paths, provenance summary, current
  server version, device name, conflict type, and stale status;
- center region: tabbed diff area with Rendered and Source tabs;
- right rail: `320px` wide, with resolution choices and submit controls;
- structural conflicts add a path/title review card showing Base, Server, and
  Device paths. Manual resolution for these conflicts exposes a custom final
  title/path field and final content editor.

Resolution choices are radio options:

1. Keep server version;
2. Use device version;
3. Keep both files;
4. Insert both blocks;
5. Manually edit final result.

Manual edit opens an editor below the diff area spanning the center region. If
the review package is stale, show a blocking warning banner above the workbench,
disable Submit resolution, and show Refresh review as the primary action.

Submit resolution uses the current dashboard session and CSRF token; it must not
interrupt review with a password re-authentication prompt.

#### 3.9.8 History Page Wireframe

Top row:

- path search/input on the left;
- selected file metadata and status on the right.

Main area:

- left timeline: `320px` wide list of versions;
- right preview: rendered/source diff tabs.

The version timeline shows operation type, timestamp, device/user provenance,
and conflict/merge/restore provenance when present. Restore is disabled until a
version is selected and requires recent authentication.

#### 3.9.9 Maintenance Page Wireframe

The Maintenance page uses checklist rows, not charts.

Rows, in order:

1. Postgres;
2. Server Git store;
3. Temp workspace;
4. Migrations;
5. Native `git`;
6. Filesystem permissions;
7. Event delivery;
8. Persistent-state backup contract.

Each row shows status, last checked, short detail, and one action when
available. Git maintenance start is a primary or secondary action depending on
whether maintenance is recommended; it requires recent authentication.

#### 3.9.10 Pair Device Dialog

`Pair device` opens a modal dialog, not a separate page.

Dialog requirements:

- width: `520px` on desktop;
- first step asks for device display name;
- second step shows the one-time pairing URL/token, expiration countdown, and
  copy button;
- the token/URL is shown only after recent authentication succeeds;
- token values are never shown in logs, event payloads, or diagnostics.

### 3.10 Note History And Restore

The owner can inspect and restore prior versions of individual notes without exposing raw Git workflows.

Behavior:

1. User opens note history for a vault path from the dashboard or plugin.
2. Server authorizes the owning user for the vault.
3. Server derives history from Git commits, path metadata, and rename/delete provenance.
4. Server returns version metadata, including commit, timestamp, author device/user, operation type, and conflict/merge provenance.
5. User views source and rendered diffs for Markdown versions, and source diffs for `.canvas` and `.base` versions.
6. User restores a prior version after recent-auth verification by creating a normal Git commit through the same merge/resolution path as other edits; history is never mutated in place.

Acceptance criteria:

- Note history can show creates, updates, deletes, and renames.
- Restoring a prior note version advances `main` through the same Git-backed merge/resolution path as other edits.
- Git timestamps are display metadata only and never determine sync ordering.
- v1 retains all commits reachable from `main`, device refs, unresolved conflict refs, and recovery refs indefinitely. Destructive history truncation is outside v1.

### 3.11 Recovery And Rebuild

If a client loses authoritative local Git state or apply fails, it can rebuild from server `main`. Losing only local coordination metadata such as `state.json` is not a rebuild case when the device token and local Git journal remain intact; the plugin repairs metadata automatically and keeps the visible filesystem as the device source of truth.

Behavior:

1. If a device token exists but local coordination metadata is missing, corrupt, or incomplete, the plugin calls the device-authenticated self endpoint to recover vault ID, device ID, device ref, current server device ref, current server `main`, and event cursor metadata.
2. When recovered local Git refs are present, the plugin commits any visible filesystem differences, then uploads the resulting local head through the device ref if the server accepts the update as a repeat or fast-forward.
3. When a reset or re-paired device has no trusted same-device cursor but has valid local content, the plugin may create a new device proposal using current server `main` as `base_commit`; the server must keep actor device identity separate from proposal base identity.
4. Plugin stops normal sync only when token auth fails, local Git state is missing/corrupt, path-policy validation fails, destructive apply is unsafe, or same-device ancestry cannot be proven safe against the server device ref.
4. Plugin snapshots local pending edits and relevant hidden Git state into a recovery bundle before destructive rebuild/reset operations.
5. Plugin pulls current server `main`.
6. Plugin applies server state to local vault.
7. Plugin classifies preserved local state before resuming sync:
   - pending fast-forward local commits whose ancestry descends from the current server device ref remain queued and are uploaded normally after rebuild;
   - local visible differences that are provably outside the resolved conflict paths and match this device's pending conflicted commit are automatically snapshotted into a recovery bundle, recommitted on top of current server `main`, and uploaded through the normal device ref path;
   - uncommitted or snapshot-only local edits become one new local recovery commit based on the rebuilt local `main`, then enter the normal upload queue;
   - divergent same-device history that does not descend from the current server device ref remains only in the recovery bundle, the device enters `blocked_recovery`, and normal sync stays blocked until the owner exports the bundle and resets or re-pairs the device.

Acceptance criteria:

- Recovery never silently discards local edits.
- Valid device token plus intact local Git state repairs lost `state.json` automatically and does not force replace-local-with-server.
- Filesystem edits made while metadata was missing become local Git commits and are uploaded to the server device ref before any destructive pull/apply.
- Device identity, actor device ref, and proposal merge base remain separate; a device may use a trusted vault commit as `base_commit` but never adopts another device's ref as its own cursor.
- Recovery bundles are available before destructive apply or rebuild operations.
- Recovery can distinguish repeated commits, new commits, divergent same-device history, and tree/content differences caused by prior conflict resolutions; ancestry alone is not sufficient when deciding whether visible local content was preserved.
- Recovery automatically resumes after a resolved conflict when all remaining visible local differences are outside the reviewed conflict paths and match this device's pending conflicted commit.
- Recovery never uploads same-device divergent history through a non-fast-forward device ref update.

## 4. Technical Design

### 4.1 System Principles

1. Git is the authoritative internal history engine for vault content.
2. The visible local filesystem is the paired device's source of truth; local `.obts/git` is the durable journal/cache that must catch up to it automatically.
3. Local `state.json` is recoverable coordination metadata and must not be treated as authoritative content state.
4. `refs/heads/main` is the only published server state for a vault.
5. Each paired device uploads through a protected server-side device ref such as `refs/obts/devices/{device_id}`; device refs are internal merge candidates, not user-visible Git branches.
6. Device identity and proposal merge base are separate. A push may name a trusted vault commit as `base_commit`, but this never transfers ownership of another device ref or bypasses the actor device's ref checks.
7. Clients commit locally; only server merge/resolution transactions advance `main`.
8. Git commit hashes identify immutable commits; parent links define ancestry; timestamps are display metadata only.
9. The server uses the native `git` CLI as the authoritative server-side Git implementation.
10. The Obsidian plugin uses `isomorphic-git` for client-side Git operations.
11. Persistent server-side Git state is protected by deployment-managed storage controls in v1.
12. Authorization is enforced at every vault-scoped boundary, and v1 vaults are single-owner in a multi-tenant instance.
13. No `.git` directory appears in the visible Obsidian vault.
14. Local commits, recovery snapshots, and recovery bundles are durable before destructive operations.
15. Obsidian configuration sync uses an explicit file policy; `.obts/` is always excluded.
16. Every paired device syncs the same full-vault content set.
17. Hard path exclusions are global and deterministic: `.obts/**` is never synced, visible `.git/**` paths are rejected, `.obsidian/cache/**`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and `.obsidian/plugins/obts/**` are excluded, while `.trash/**` and other `.obsidian/**` paths are normal vault content.

### 4.2 Containers

- **Server API and CLI:** TypeScript/Node/Fastify service for auth, vaults, devices, Git sync, merge, conflicts, note history, persistent-state checks, and health.
- **Dashboard SPA:** Svelte + Vite + TypeScript browser UI served by the server for setup, device dashboard, conflict review, and maintenance.
- **Obsidian plugin:** TypeScript plugin that watches the visible local filesystem as the device source of truth, records hidden Git commits with `isomorphic-git`, rehydrates recoverable metadata from device-token auth, uploads device ref updates, pulls `main`, and applies accepted state.
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
- **PathPolicyService:** validates canonical vault-relative paths, collision rules, platform-safe materialization rules, and hard full-vault sync exclusions.
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

- **SettingsView:** collects server URL, login/pairing token, and device name.
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
- **ApplyEngine:** applies accepted server `main` changes inside the full-vault path policy to the vault after local recovery snapshots.
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

Plugin settings and `.obsidian` files that pass the hard full-vault path policy are treated as vault content inside Git for history, conflict, and logging rules.

Device refs are whole-tree Git refs that mirror the last accepted full-vault state reported by each device.

Reads materialize Git state only for authorized server workflows and return content only to authorized clients over HTTPS.

Server startup and readiness require the native `git` CLI. If it is missing, unusable, or below the supported version range, readiness fails closed.

### 5.4 Canonical Path And Filesystem Policy

Rules:

- canonical vault-relative paths use `/`, reject absolute paths, reject traversal, and reject empty path segments;
- `.obts/` is always excluded from vault sync, Git worktree content, and manifest/path scanning;
- `.git/` directories inside visible vault content are sync-blocking errors rather than synced content;
- client and server use the same global safety validation library and test corpus;
- hard exclusions are enforced consistently before commit, upload, merge, and apply;
- client scans silently omit only documented runtime hard exclusions and OS/editor metadata; visible `.git` directories, NUL/control characters, traversal, symlinks, unsupported file modes, and configured path length limits block sync with a clear error;
- Unicode NFC normalization is mandatory before commit, upload, merge, and apply;
- Git-safe names accepted by the active Obsidian adapter/filesystem are valid vault content by default, even when they are not portable to every supported operating system;
- Windows-reserved names, Windows-invalid punctuation, trailing spaces/dots, and case-fold collisions are device capability concerns, not global server rejections; a device that cannot materialize a server path blocks locally with a clear `unsupported_path_on_device`-style status and offending-path details;
- path materialization collisions on a specific device are sync-blocking conflicts requiring user rename, not automatic overwrites;
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
5. Write and commit a prepared operation manifest to the `sync_operations` row before any Git ref mutation. The manifest stores non-content application side effects required to finish the write exactly: actor, operation type, expected refs, target refs, target commit, merge or conflict inputs, validator summaries, affected path IDs, derived-index mutation summary, conflict row changes, audit row data, event rows, redacted result payload, and object-store promotion references.
6. Promote validated Git objects into the per-vault server Git store.
7. Update the target Git ref with compare-and-swap semantics against the expected old commit.
8. In one Postgres transaction, apply the prepared sync/conflict/history/index/audit metadata, append the prepared `event_log` rows, and mark the `sync_operations` row `committed`.
9. Release the per-vault lock.
10. Notify WebSocket and polling subscribers only from committed `event_log` rows.

Startup reconciliation and readiness rules:

- operations with status `started` and no prepared manifest are aborted, and their quarantine state is removed;
- operations with status `prepared` whose target Git ref has not moved are aborted, and their quarantine state is removed;
- operations whose target Git ref already points at the prepared target commit are rolled forward by applying the prepared Postgres metadata and prepared `event_log` rows exactly as recorded in the manifest;
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

- first-run setup creates exactly one initial admin account, marks setup complete permanently, and cannot be repeated after setup is complete;
- v1 supports multiple user accounts in one server instance;
- every vault has exactly one owner, and v1 has no shared vault membership;
- admin status does not grant vault-content access unless that admin account owns the vault;
- admin accounts can create users, disable users, re-enable users, create one-time password-reset tokens, grant admin status, revoke admin status, and view account metadata;
- account metadata visible to admins includes user ID, username or display name, admin flag, disabled flag, created timestamp, last login timestamp, and owned vault count;
- account metadata visible to admins excludes vault names, vault paths, note paths, Git refs, conflict contents, note history, diagnostics exports, device tokens, and recovery bundle contents for vaults the admin does not own;
- disabling a user immediately revokes that user's dashboard sessions, pairing tokens, device tokens, and event streams;
- revoking admin status is rejected when it would remove the final enabled admin account;
- every admin lifecycle action writes a redacted audit event;
- user passwords require at least 12 characters and are hashed with Argon2id using `m=19456`, `t=2`, and `p=1` as the v1 minimum parameters;
- login attempts are rate-limited by account and source IP: 5 failed attempts in 10 minutes triggers exponential backoff starting at 1 minute and capped at 1 hour;
- dashboard auth uses a server-side cookie session named `__Host-obts_session` with at least 128 bits of entropy, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no `Domain` attribute;
- dashboard sessions have a 30-day absolute TTL and a 7-day idle TTL, refreshed on authenticated dashboard use;
- sensitive dashboard operations require password re-authentication within the previous 15 minutes: pairing token creation, device revocation, note restore, content-bearing recovery export, Git maintenance start, password change, and admin account management. Conflict resolution is protected by session auth, CSRF, stale-review checks, and audit logging, but does not require re-authentication;
- logout and account/device revocation invalidate matching server-side sessions immediately;
- cookie-authenticated mutation APIs require a CSRF token bound to the session and submitted in the `X-OBTS-CSRF` header;
- dashboard bearer tokens are not supported in v1;
- device and pairing tokens are opaque, contain at least 256 bits of entropy, and are stored server-side only as hashes with a non-secret lookup prefix;
- pairing tokens are one-time, scoped to one owning user, one vault, and the issued device display name, expire after 10 minutes, allow at most 10 failed consume attempts, and are rate-limited by source IP;
- device tokens are scoped to one user, one vault, and one device;
- token rotation and device revocation take effect without waiting for client reconnect;
- login, pairing, failed auth, token rotation, and revocation write redacted audit records;
- unauthenticated requests return `401`;
- requests for vault-scoped resources not owned by the authenticated user return `404`;
- v1 does not ship email password reset;
- account recovery uses an audited local admin CLI command that creates a one-time password-reset token for a specified account or creates a new admin account only when no enabled admin account exists;
- plugin device tokens are stored locally at `.obts/auth/device-token.json`;
- desktop plugin implementations create `.obts/auth/device-token.json` with owner-only permissions through the runtime filesystem APIs;
- mobile plugin implementations rely on the Obsidian app sandbox for `.obts/auth/device-token.json`;
- `.obts/auth/**` is excluded from Git worktree content, manifest scanning, recovery bundle file snapshots, diagnostics exports, and content-bearing exports;
- device revocation and token rotation are enforced server-side immediately, and local token deletion is best-effort cleanup only;
- dashboard and diagnostics surfaces show token presence, age, and revocation state, never token values.

### 6.3 Git Sync And Commit Contract

Device push request:

- content type: `multipart/form-data`;
- `manifest` part: JSON metadata;
- `packfile` part: Git packfile bytes.

Device push manifest fields:

- `vault_id`;
- `device_id`;
- expected current actor device ref or empty-ref marker;
- target commit ID;
- optional trusted proposal `base_commit`, used only as merge base and never as device identity;
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
- `manifest` part: JSON metadata with target `main`, required apply summary, changed-path metadata, event cursor, and whether the request's current local `main` is an ancestor of the target when the server can determine that relationship;
- `packfile` part: Git packfile bytes required to reach the target `main`.

Supported committed operations:

- create file;
- update file;
- delete file;
- rename file;
- create/update/delete `.obsidian` files allowed by the hard full-vault path policy;
- create/update/delete community plugin files except `.obsidian/plugins/obts/**`.

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
- A re-pairing client may use an imported pull pack plus Git ancestry checks to treat a detached baseline as a safe stale server copy only when that baseline is reachable from current server `main`.
- Malformed Git transfers are rejected without advancing device refs or `main`.
- Uploaded commits containing invalid or hard-excluded paths are rejected without advancing device refs or `main`.
- Git timestamps are never used to order sync or determine whether a change is new.

### 6.4 Merge Policy Contract

Merge behavior must be deterministic, auditable, and conservative.

Policy:

- Git merge-base and ancestry determine the candidate merge relationship;
- disjoint path edits auto-merge when no delete/rename collision exists;
- same-file Markdown edits auto-merge only when Git merge produces clean output and line, frontmatter, heading/block, link/embed, and conflict-marker validators all accept the final text;
- same-file `.canvas` edits auto-merge only through the JSON Canvas semantic merge contract below;
- same-file `.base` edits auto-merge only through the Obsidian Bases semantic merge contract below;
- frontmatter auto-merges only for disjoint keys; same-key edits conflict;
- delete-vs-edit conflicts unless the edit is already contained in the deleted side's preserved history and the owner explicitly resolves it;
- rename-vs-edit auto-merges only when one side renames and the other side edits content without path collision;
- rename-vs-rename conflicts unless both sides produce the same target path;
- binary and attachment changes auto-merge only when Git/object identity is identical or paths are disjoint;
- `.obsidian` config and plugin files use file-level rules in v1; semantic config/plugin merge handlers are outside v1;
- unsafe, unsupported, or ambiguous cases create structured conflicts with base/current/device variants and provenance.

JSON Canvas semantic merge contract:

- `.canvas` files are parsed as JSON Canvas 1.0 objects before semantic merge;
- invalid JSON, non-object roots, missing `nodes` or `edges` arrays, duplicate node IDs, duplicate edge IDs, invalid required fields, and edges that reference missing nodes create structured conflicts;
- `nodes` are merged as a map keyed by node `id`, and `edges` are merged as a map keyed by edge `id`;
- one-sided node or edge additions, deletions, and edits auto-merge;
- same node or edge edits auto-merge only when the edited field sets are disjoint;
- same node or edge same-field edits with different values conflict;
- node `type` changes conflict unless both sides make the same `type` change;
- deletion of a node conflicts when the other side edits that node or adds/edits an edge that references that node;
- node order is preserved by keeping surviving base nodes in base order, inserting one-sided additions at that side's relative position, and conflicting concurrent order changes that move the same existing node to different relative positions;
- successful `.canvas` semantic merge output is deterministic pretty JSON.

Obsidian Bases semantic merge contract:

- `.base` files are parsed as valid YAML matching the documented Obsidian Bases syntax before semantic merge;
- `formulas`, `properties`, and `summaries` are merged as maps keyed by formula, property, or summary name;
- one-sided map-entry additions, deletions, and edits auto-merge;
- same map-entry edits auto-merge only when the edited nested keys are disjoint;
- same-key formula expression edits, same-key summary expression edits, and same nested property-key edits with different values conflict;
- top-level `filters` is treated as one semantic field, and concurrent edits to `filters` conflict unless both sides produce identical YAML values;
- each `views[]` entry is keyed by the stable pair `(type, name)`, and duplicate `(type, name)` pairs conflict;
- one-sided view additions, deletions, and edits auto-merge;
- same-view edits auto-merge only when the edited keys are disjoint;
- view reorder, same-view `type` edits, same-view `filters` edits, same-view `order` edits, and concurrent edits to plugin-specific or unknown view keys conflict;
- successful `.base` semantic merge output is deterministic YAML.

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
- accepted resolutions are written as merge commits with parent 1 set to `expected_main`, parent 2 set to the conflicted device commit, and the resulting tree set to the accepted final state.

### 6.5 Main APIs

- `POST /api/v1/pair/consume`: consume a pairing token and register a device.
- `GET /api/v1/device/self`: authenticate a device token without a vault ID in the URL and return non-secret identity/ref metadata for local metadata repair.
- `GET /api/v1/vaults/{vault_id}/main`: return current `main` metadata and authorized summary.
- `POST /api/v1/vaults/{vault_id}/sync/push`: upload a push manifest and Git packfile, optionally naming a trusted `base_commit`, then request an actor device ref update.
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
}
```

There is no v1 device-level scope setting. A paired device syncs the full vault according to the hard path policy.

The plugin stores the device token at `.obts/auth/device-token.json`. The token file is never synced as vault content, never committed to hidden Git state, never included in recovery bundle file snapshots, and never included in diagnostics or content-bearing exports. Server-side token revocation and rotation are authoritative even when the local token file remains present.

When a device unpairs or is locally disconnected from a vault, the plugin must remove local authentication material and clear active device identity, but it must not discard safe non-secret history needed to distinguish a stale clean copy from unreviewed local edits. The plugin preserves a detached unpaired baseline containing the previous vault ID, last applied server `main`, and enough hidden Git state to verify the visible vault tree against that baseline. This detached baseline is not authorization, cannot sync without a new pairing token, and is ignored if the owner explicitly resets local OBTS state.

## 8. Required v1 Feature Designs

### 8.1 Obsidian Configuration Sync

`obts` syncs the full vault through an explicit hard-exclusion policy. It does not require typed materializers for v1.

Rules:

- `.obts/` is always excluded from vault sync, Git worktree content, and manifest/path scanning.
- Visible `.git/` directories are sync-blocking errors rather than synced content.
- `.obsidian/cache`, `.obsidian/cache/**`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/plugins/obts`, and `.obsidian/plugins/obts/**` are excluded.
- `.trash/**`, attachments, community plugin files outside `.obsidian/plugins/obts` and `.obsidian/plugins/obts/**`, and all other `.obsidian/**` files are normal vault content.
- The server enforces a documented maximum upload byte limit through `OBTS_MAX_UPLOAD_BYTES`; files larger than that limit block upload/apply for the affected file with a clear error.
- Plugin files are executable/sensitive content. When synced, they are Git-backed vault state and participate in file-level history, recovery, and conflict handling. Diagnostics exports and note-history UI redact plugin file content by default.
- Already-loaded plugin code may continue to run until Obsidian or the plugin reloads; `obts` does not force that reload as part of sync.
- `obts` must not update its own running plugin code through normal vault sync.

### 8.2 Note History And Restore

v1 exposes Git-backed note-level history without exposing raw Git workflows.

Required behavior:

- list versions for an authorized vault path;
- show create, update, delete, rename, conflict, merge, and restore provenance;
- show source and rendered diffs for Markdown note files;
- show source diffs for `.canvas` and `.base` note files;
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
- `patches/` with text patch series for changed Markdown, `.canvas`, `.base`, and text configuration files;
- `journal/apply-journal.json` with the apply journal state at bundle creation;
- `checksums.sha256` covering every file in the bundle.

Local apply/recovery rules:

- destructive apply and rebuild operations require a recovery bundle first;
- recovery bundles are created before file deletes, overwrites, renames, replace-local, rebuild, reset, or any operation that removes or overwrites local content;
- recovery bundle creation failure blocks the destructive operation;
- recovery bundles are retained until the user explicitly deletes them;
- diagnostics exports must redact or omit recovery bundle content unless the owner explicitly requests a content-bearing export.

### 8.6 Platform Support Matrix

v1 platform support:

- **Desktop Linux/macOS/Windows:** supported target platforms for file watching, periodic scanning, hidden local Git state, local recovery bundles, `.obts/auth/device-token.json` token storage, plugin settings, full-vault sync, community plugin-file sync, and running-plugin self-exclusion.
- **Android/iOS:** supported v1 target platforms for foreground sync, periodic scanning, hidden local Git state, local recovery bundles, `.obts/auth/device-token.json` token storage protected by the Obsidian app sandbox, plugin settings, safe apply, full-vault sync, community plugin-file sync, and running-plugin self-exclusion.
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
- full-vault file-policy sync;
- running-plugin self-update safeguards.

Dashboard:

- setup and login;
- device dashboard;
- conflict list, diff viewers, and resolution editor;
- note history and restore view;
- maintenance status and persistent-state/health summaries.

### 10.2 Deployable Development Phases

Development is organized into three deployable vertical phases. A phase is
complete only when it can be installed on a real self-hosted server, paired
with an installable Obsidian plugin, and exercised against copied test vaults
without using test harness code.

Every phase must include:

- a runnable server process with documented configuration, health checks,
  persistent-state paths, backup/restore notes, and upgrade notes for state
  introduced in that phase;
- an OCI image built from this app repo, with environment-specific infrastructure-specific deployment kept
  outside this app repo;
- an installable Obsidian plugin artifact for all client behavior required by
  that phase;
- a manual smoke-test guide that starts from empty persistent state and verifies
  the phase's primary user workflow against copied test vaults;
- automated acceptance tests for the same workflow.

#### Phase 1: Deployable Sync Without Conflict Resolution

Build the smallest deployable sync product. It pairs real Obsidian clients with
a self-hosted server, moves vault changes through Git-backed server state,
applies safe server `main` changes locally, and blocks safely when human
judgment is required.

Phase 1 intentionally has no browser dashboard or frontend. Setup, vault
creation, pairing-token creation, device listing, conflict listing, and health
inspection are exposed through server CLI commands. The HTTP API still exists
for the plugin and for contract testing, but users do not need a dashboard to
complete the Phase 1 workflow.

Included:

- project/package skeleton, shared TypeScript schemas, committed OpenAPI
  contract, Git test harness, and contract tests for the APIs introduced in
  this phase;
- runnable server entrypoint, OCI image, documented environment configuration,
  persistent-state documentation, and health/readiness checks;
- server CLI commands for first-run setup, vault creation, pairing-token
  creation, device listing, conflict listing, health/readiness inspection, and
  local admin recovery;
- first-run setup, vault creation, device pairing, token storage, device-token
  auth, pairing-token auth, and single-owner vault authorization;
- server Git store, native `git` CLI readiness, server-authored empty-tree root
  commit on `main`, device refs, Postgres-backed metadata, migrations, and the
  durable Git/Postgres write workflow for sync operations;
- installable Obsidian plugin with settings UI for server URL, pairing token,
  and device name;
- plugin status surface showing Synced, Ahead, Behind, Uploading, Applying,
  Review needed, Needs recovery, Unsafe local state, and Blocked;
- plugin hidden `.obts/` state using `isomorphic-git`, Obsidian filesystem
  adapter, scanner/watcher, local commit creation for vault change sets, upload
  queue, retry state, first-sync safety, recovery bundles, apply journal, and
  safe apply;
- authenticated multipart push/pull using manifest JSON plus Git packfile
  bytes;
- server validation of uploaded Git objects, path policy enforcement,
  device-ref fast-forward/no-op handling, upload limits, and rejection of
  malformed or same-device non-fast-forward updates;
- automatic server merge for safe cases, advancement of `main`, event emission,
  plugin pull/apply of accepted `main`, and durable conflict records for unsafe
  or ambiguous merges.

Excluded:

- browser dashboard/frontend;
- conflict package rendering;
- source/rendered diff viewers;
- manual resolution submission;
- note history and restore.

Acceptance proof:

- the server is deployed from its OCI image and reaches ready state;
- the Obsidian plugin is installed into two copied test vaults and paired with
  the deployed server;
- two paired devices sync non-conflicting vault change sets through server
  `main`;
- hidden Git state lives under `.obts/`, and no visible vault `.git` is
  created;
- unsafe concurrent edits create a durable conflict record and block further
  unsafe advancement instead of overwriting content;
- the plugin surfaces the blocked or review-needed state without requiring a
  dashboard;
- recovery bundles and apply journals exist before destructive local
  operations;
- cross-user access to vault, device, conflict, sync, and event resources
  returns `404`.

#### Phase 2: Deployable Dashboard And Conflict Resolution

Add the browser dashboard and the human review path for conflicts created by
Phase 1. From this phase onward, dashboard UI is required.

Included:

- authenticated dashboard shell for setup, login, vault overview, device
  status, pairing-token creation, readiness/health summary, and conflict list;
- conflict package materialization from authorized Git state;
- dashboard conflict list, rendered Markdown diff, source diff,
  affected-path metadata, path/title metadata for structural conflicts, and
  resolution editor;
- resolution choices for accepting current `main`, accepting the device
  version, keeping both, inserting both blocks, or manually editing the final
  result, including custom final title/path resolution for path conflicts;
- session-authenticated resolution submission without a password re-authentication prompt;
- `expected_main` stale-review protection, idempotent duplicate submission
  handling, and resolution commits that descend from current `main`;
- `conflict_resolved` and `main_advanced` events, client refresh after
  resolution, and safe local apply of resolved `main`;
- conflict audit records and redaction checks for logs, errors, diagnostics,
  and event payloads.

Acceptance proof:

- the Phase 2 server is deployed as an upgrade over Phase 1 state;
- the owner can create a vault and pair devices through the dashboard;
- concurrent same-file Markdown edits create a reviewable conflict;
- the owner resolves the conflict in the dashboard and advances `main`;
- stale review submissions are rejected without changing `main`;
- duplicate accepted submissions are idempotent;
- paired clients apply the resolved state without silently discarding local
  edits;
- unauthorized users cannot list, view, or resolve another user's conflicts.

#### Phase 3: Deployable Note History, Restore, And Maintenance

Add the Git-backed history, restore, diagnostics, and maintenance product on
top of the deployable sync and conflict foundations.

Included:

- derived path/history indexes backed by Git commits, path metadata,
  rename/delete provenance, and conflict/merge provenance;
- note history query APIs and dashboard history view for creates, updates,
  deletes, renames, conflicts, merges, and restores;
- source and rendered diffs for Markdown versions, plus source diffs for
  `.canvas` and `.base` versions;
- metadata-only history for plugin files by default, with explicit owner action
  required for content-bearing export;
- note restore through a new Git-backed commit or merge/resolution path, never
  by rewriting history;
- persistent-state integrity checks, Git maintenance needed to preserve
  reachable history, diagnostics export rules, and backup documentation for
  history-bearing state.

Acceptance proof:

- the Phase 3 server is deployed as an upgrade over Phase 2 state;
- the owner can inspect prior versions of a note without using raw Git
  commands;
- history shows meaningful provenance for normal edits, merges, conflicts,
  deletes, renames, and restores;
- restoring a prior version advances `main` through the same safe
  sync/resolution machinery as other edits;
- paired clients apply restored state safely;
- diagnostics and logs remain redacted by default;
- backup/restore testing preserves metadata, Git refs, conflicts, events, and
  note history consistently;
- reachable history remains available after Git maintenance;
- restored or inconsistent persistent state fails readiness closed instead of
  serving incomplete history.

## 11. Testing And Proof

### 11.1 Unit Tests

- canonical path normalization;
- global path-safety validation and device-specific path capability handling;
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
- JSON Canvas semantic merge decisions;
- Obsidian Bases semantic merge decisions;
- merge queue ordering, merge policy versioning, and validator result persistence;
- event-log cursor, replay, retention, and expired-cursor behavior;
- note history indexing and restore commit creation;
- conflict creation and resolution;
- stale conflict review and idempotent duplicate resolution submission;
- local queue, fixed apply journal schema, fixed recovery bundle schema, metadata rehydration, and Git state crash recovery.

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
- lost `state.json` with a valid device token and intact local Git refs rehydrates automatically, then uploads filesystem edits through the device ref;
- reset/re-paired additional-device content uploads as the actor device's proposal and either merges safely or becomes a server conflict without adopting another device's ref;
- concurrent disjoint edits auto-merge;
- concurrent same-file Markdown edits merge when safe;
- concurrent same-file `.canvas` edits merge when the JSON Canvas semantic merge contract accepts them;
- concurrent same-file `.base` edits merge when the Obsidian Bases semantic merge contract accepts them;
- ambiguous same-file edits create a conflict;
- dashboard resolves a conflict and advances `main`;
- note history shows prior versions and restores one note through a new Git commit;
- non-empty local vault join creates a recovery bundle and never silently discards local content;
- first-device non-empty local vault import creates a recovery bundle, requires owner confirmation, uploads an initial device commit, and merges through server `main`;
- additional-device non-empty divergent vault pairing uploads the visible filesystem as that actor device's proposal and preserves local content if the server records a conflict;
- full-vault sync includes `.trash/**`, attachments, `.obsidian/**`, and community plugin files except hard exclusions;
- full-vault sync excludes `.obsidian/cache/**`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and `.obsidian/plugins/obts/**`;
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
- full-vault hard exclusions behave as documented;
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

Rejected for v1. Typed handlers for every Obsidian and plugin setting would turn configuration sync into a separate configuration-management product. v1 instead uses one explicit full-vault hard-exclusion policy that syncs community plugin files as normal vault content while always excluding the running `obts` plugin path.

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
- Keep community plugin files synced as normal vault content, except `.obsidian/plugins/obts` and `.obsidian/plugins/obts/**` are always excluded.
- Do not log or print secret values, passwords, tokens, Git pack contents, raw blobs, plugin settings, or full note bodies.
- Treat `architecture/workspace.dsl` as the authored architecture source. Treat `architecture/DIAGRAMS.md` and `architecture/export/*` as generated.
- If implementation later contradicts this PRD, refresh the architecture from code and executable config first.
