# Obsidian True Sync (`obts`) — Agent-Ready Product + Technical Spec

**Status:** Draft v1.0
**Date:** 2026-06-25  
**Author:** Product/technical owner  
**Audience:** Coding agents, future maintainers, engineers, technical product owner  
**Working product name:** Obsidian True Sync  
**Implementation/plugin identity:** `obts`, display name `True Sync`

---

## 0. Executive Summary

`obts` is a self-hosted, end-to-end encrypted sync system for Obsidian vaults. It is designed for users who want the simplicity of “one Docker Compose stack on the server, one plugin on each client, URL + auth + passphrase, and it works,” while preserving local-first editing, recoverable history, and clear conflict handling.

The architectural center is a single canonical server state called **server main**. Clients are local-first: they can edit immediately, including while offline. Their edits are snapshotted into durable local proposals and uploaded to per-device lanes. The server accepts clean changes into `main`, quarantines ambiguous changes as structured conflict objects, and exposes a central conflict review UI. Because vault encryption is required, conflict review and semantic merges must run in trusted client contexts: the Obsidian plugin provides the primary resolver, and the browser dashboard provides the owner-facing resolver after the user enters the vault passphrase. The server must never receive the vault encryption passphrase or plaintext note content.

The user-facing promise is:

> There is one canonical published vault on the server. Devices can be ahead, behind, offline, and blocked, and `obts` tells the user exactly which. Safe changes publish automatically. Ambiguous changes go to Review. Every local edit is preserved before anything can overwrite it.

---

# 1. Product Frame

## 1.1 Summary

`obts` consists of:

1. A self-hosted server deployed as one Docker Compose stack with Postgres.
2. An Obsidian community plugin installed on each client.
3. A browser-based dashboard/conflict UI served by the server but running crypto and merge logic client-side.
4. A protocol and storage layer that uses Git-like immutable history on the server, but does not expose Git to users and does not place `.git` in the visible Obsidian vault.

The server stores encrypted vault snapshots, encrypted file blobs, device metadata, conflict records, and one canonical branch equivalent: `main`. Clients watch local vault files, snapshot edits, upload proposals, apply accepted server state, and show clear sync status.

## 1.2 Problem & Audience

### Problem

Existing self-hosted Obsidian sync setups can feel brittle because they expose distributed-system internals to ordinary note-taking users: replication settings, database/chunk repair, ambiguous local-vs-remote authority, and sync states that are hard to interpret. Users can encounter notes that update on one client but not another, errors that say little about data safety, and too many advanced settings.

The target user wants:

- self-hosting;
- privacy and vault encryption;
- low setup friction;
- reliable sync across desktop and mobile;
- no silent data loss;
- no raw merge-conflict markers dumped into notes;
- a central place to resolve rare ambiguous cases;
- a dashboard showing whether devices are in sync.

### Audience

Primary users:

- individual Obsidian users with 2–5 devices;
- privacy-conscious self-hosters;
- technical users who can run Docker but do not want to debug database replication.

Secondary users:

- self-hosting operators who want one server for multiple isolated personal vault accounts;
- power users who want recoverable history without thinking about Git.

## 1.3 Business Context & Ecosystem

`obts` is not an official Obsidian product. It integrates with Obsidian through the community plugin ecosystem. Obsidian’s developer documentation describes plugins as TypeScript extensions, and the plugin API exposes vault/workspace/plugin lifecycle facilities that the client must use rather than directly treating the vault as an arbitrary filesystem on every platform.

Implementation must account for Obsidian plugin guidance, especially mobile constraints: avoid top-level Node/Electron modules when mobile support is intended, avoid hardcoded `.obsidian` assumptions where APIs provide a config directory, use Obsidian network APIs where required, disclose network use, avoid client-side telemetry, and minimize dependencies.

## 1.4 Goals & Success Metrics

### Product goals

1. **Boring setup**
   - Server install: one Docker Compose stack with server and Postgres.
   - Client setup: server URL, pairing token/login, vault passphrase, sync profile, device name.
   - No visible CouchDB/Git/chunk/adapter/internal replication settings.

2. **One canonical server truth**
   - Server `main` is the canonical published vault.
   - Clients never push directly to `main`; they submit proposals.
   - Only server merge/resolution code advances `main`.

3. **Local-first editing**
   - Users can edit offline.
   - Local disk reflects local edits immediately.
   - The plugin clearly shows when local edits are unpublished.

4. **No silent data loss**
   - Before applying server changes that could overwrite local files, the client must have snapshotted local edits into durable local state.
   - Every uploaded proposal reaches exactly one visible state: merged, pending, conflicted, or recoverable.
   - Conflict resolution creates new history; it never destroys the conflicting originals.

5. **Central conflict UX**
   - All unresolved conflicts appear in one dashboard.
   - Conflict UI offers rendered Markdown diff, source diff, accept-local, accept-server, keep-both, and manual merged edit.
   - Raw Git conflict markers must never be written into user notes.

6. **End-to-end encryption**
   - Server must not receive or persist plaintext note content, attachment content, plaintext file paths, or the vault encryption passphrase.
   - Client-side web UI decrypts conflicts locally after user enters passphrase.

7. **Clear state visibility**
   - Plugin status shows `Synced`, `Ahead`, `Behind`, `Uploading`, `Applying`, `Offline`, `Blocked: conflict`, `Unsafe local error`, and `Needs recovery`.
   - Dashboard shows each device’s last known state and last-seen time.

### Technical success metrics

v1 acceptance targets:

- Two online clients syncing a small Markdown change should converge to the same server `main` and local file content within 5 seconds on a normal LAN.
- For disjoint file edits from two offline clients, server must auto-merge both into `main` without user input.
- For same-line concurrent Markdown edits, both edits must be recoverable after sync; the system must create a conflict record rather than choosing a winner silently.
- For 1,000 Markdown files and 1 GB total attachments, initial pull should complete without unbounded memory growth; memory target under 512 MB server RSS and under 250 MB plugin working memory during normal sync.
- Server restart during upload must not corrupt `main`; client retry must be idempotent.
- Deleting/rebuilding a client from server must not require manual database repair.
- No `.git` directory may be created inside the visible Obsidian vault.
- Multi-account hosting must isolate each user's vaults, devices, objects, proposals, conflicts, and event streams from every other user.
- Managed Obsidian and plugin configuration sync must use typed encrypted sync entries with explicit materializers, not raw `.obsidian` file replication.
- Vault passphrase change must re-key the current canonical vault snapshot, require other devices to rebuild, and avoid exposing plaintext or keys to the server.
- Compact history must create a new encrypted baseline from current `main` and discard older server-side history only after explicit owner confirmation.
- Docker Compose deployment must include the server, Postgres, internal Git history on local filesystem storage, and encrypted local object storage.

## 1.5 Explicit Non-Goals

v1 excludes the following product shapes:

- SaaS hosting operated by this project.
- Shared vault membership or note sharing between different `obts` users.
- Real-time collaborative editing, live cursors, presence, CRDT/OT sessions, or Google-Docs-style multi-user editing.
- Raw Git interoperability with GitHub/GitLab remotes.
- Putting a normal `.git` repository in the visible Obsidian vault.
- Syncing `obts`’ own plugin state as vault content.
- Server-side plaintext semantic merge while E2EE is enabled.
- Recovery of encrypted vault content after the user loses both the vault passphrase and all user-held recovery material.
- General-purpose S3/object-storage deployment for v1.
- Mobile background execution beyond the guarantees provided by iOS, Android, and Obsidian.

## 1.6 Compliance / Policy Requirements

1. **Obsidian plugin review compatibility**
   - Plugin `id`: `obts`.
   - Submit display name `True Sync`.
   - README must disclose: account/server requirement, network access, external file access, encryption behavior, recovery limitations, and absence of telemetry.
   - No client-side telemetry or analytics in plugin or web UI.
   - Use a lockfile and keep dependency count small.

2. **Privacy**
   - Server stores the minimum metadata required for sync.
   - No note content, attachment content, or plaintext pathnames in server logs.
   - Default logs must redact tokens, passphrases, object contents, paths, and file names.

3. **Licensing**
   - Do not copy code from proprietary sync products.
   - All dependencies must be compatible with the project license.
   - License is AGPL-3.0-only.
   - Implementation must keep third-party notices accurate.

4. **Deployment**
   - Self-hosted first.
   - HTTPS required for production.
   - Development allows `localhost` HTTP only.
   - Server must run without requiring external cloud services.

---

# 2. Experience & Workflows

## 2.1 Actors

### Human actors

- **Vault owner:** installs server, pairs devices, resolves conflicts, restores backups.
- **Device user:** edits notes in Obsidian and observes sync status.
- **Maintainer/operator:** upgrades server/plugin, reads logs, runs backups and doctor commands.

### Software actors

- **Obsidian plugin client:** watches vault, snapshots edits, uploads proposals, applies `main`, shows status.
- **Server API:** authenticates devices, receives objects/proposals, exposes state and dashboard APIs.
- **Merge coordinator:** advances `main` for safe merges; creates conflicts for ambiguous cases.
- **Client-side web app:** dashboard and conflict resolver; decrypts locally in browser.
- **Local `.obts` store:** durable client-side queue/cache/recovery state under vault-root `.obts/`, never synced as vault content.
- **Server metadata DB:** Postgres for v1.
- **Server object store:** encrypted objects and blob payloads on local filesystem storage.
- **Server Git-like history store:** internal Git repository, not exposed to users.
- **Notification hub:** WebSocket channel for `main` changes, device state, and conflict events, with polling as the required compatibility fallback.

## 2.2 Core Workflow A — Server Install

### Trigger

User wants to create a self-hosted sync endpoint.

### Inputs

Required `docker-compose.yaml`:

```yaml
name: obts

services:
  postgres:
    image: postgres:16-alpine
    container_name: obts-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: obts
      POSTGRES_USER: obts
      POSTGRES_PASSWORD_FILE: /run/secrets/obts_postgres_password
    volumes:
      - ./obts-postgres:/var/lib/postgresql/data
    secrets:
      - obts_postgres_password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obts -d obts"]
      interval: 10s
      timeout: 5s
      retries: 5

  obts:
    image: ghcr.io/obts/obts-server:latest
    container_name: obts
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "8080:8080"
    volumes:
      - ./obts-data:/data
    environment:
      OBTS_BASE_URL: "https://sync.example.com"
      OBTS_DATA_DIR: "/data"
      OBTS_DATABASE_URL_FILE: "/run/secrets/obts_database_url"
      OBTS_LOG_LEVEL: "info"
      OBTS_REQUIRE_HTTPS: "true"
      OBTS_SERVER_SECRET_FILE: "/data/server-secret"
      OBTS_METRICS_AUTH_REQUIRED: "true"
    secrets:
      - obts_database_url
    healthcheck:
      test: ["CMD", "obts-server", "healthcheck", "--ready"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

secrets:
  obts_postgres_password:
    file: ./secrets/postgres-password
  obts_database_url:
    file: ./secrets/database-url
```

### Behavior

On first boot:

1. Create `/data` subdirectories.
2. Connect to Postgres and run migrations.
3. Initialize admin setup flow.
4. Generate server secret if missing.
5. Start HTTP API and web UI.
6. Expose readiness only after Postgres, object store, and Git store are available.

### Output

Admin visits `/setup`, creates admin user, creates first vault, receives a pairing URL/token.

### Acceptance criteria

- Compose stack starts with empty Postgres and `/data` volumes.
- `/health/live` returns `200` when process is alive.
- `/health/ready` returns `200` only after Postgres, object store, and Git store are writable.
- Setup token is one-time and expires.
- Server logs do not include secrets.

## 2.3 Core Workflow B — Create Vault and Pair First Device

### Trigger

Vault owner creates a new server vault and installs the plugin in Obsidian.

### Inputs

In web UI:

- vault display name;
- default file sync profile;
- default managed configuration profile.

In Obsidian plugin:

1. Server URL.
2. Invite URL containing the pairing token.
3. Vault encryption passphrase.
4. Sync profile.
5. Device name.

### Behavior

1. Plugin validates server URL and TLS.
2. Plugin exchanges pairing token for device auth token.
3. Plugin derives vault keys locally from passphrase.
4. Plugin creates a random `device_id` and device signing/auth identity.
5. Plugin performs initial scan of local vault.
6. If server vault is empty, first client can publish initial snapshot to `main`.
7. If server vault has `main`, plugin pulls and applies `main`, after preserving any local files as import/recovery data.

### Output

Plugin status: `Synced` or `Ahead: initial upload pending`.

### Expected errors

- `PAIR_TOKEN_EXPIRED`: show “Pairing link expired. Create a new invite from the dashboard.”
- `WRONG_PASSPHRASE`: show “Passphrase could not decrypt vault metadata.”
- `SERVER_REQUIRES_HTTPS`: show “This server requires HTTPS. Use an HTTPS URL. Local development must use `localhost`.”
- `VAULT_NOT_EMPTY`: show import/rebuild choice; never overwrite without snapshot.

### Acceptance criteria

- Server never receives vault passphrase.
- Pairing token cannot be reused.
- Device appears in dashboard.
- No more than five setup inputs are visible in the plugin.

## 2.4 Core Workflow C — Local Edit Sync

### Trigger

User creates, edits, deletes, renames, or attaches a file in Obsidian.

### Inputs

Filesystem/vault events plus periodic scan fallback.

### Behavior

1. Watcher receives vault event.
2. Debounce for configurable internal interval, default 1500 ms.
3. Normalize path and check sync profile/include/exclude rules.
4. Read file content via Obsidian API.
5. Encrypt file entry/blob locally.
6. Write a durable local proposal before network upload.
7. Upload missing objects and proposal.
8. Server attempts to merge proposal into `main`.
9. Client receives accepted/conflict/pending response.
10. Client updates status.

### Output

- Clean upload: status returns to `Synced`.
- Pending network upload: `Ahead: N changes pending upload`.
- Conflict response: `Blocked: N conflicts need review`.

### Acceptance criteria

- Killing Obsidian after step 6 and before step 7 preserves the local proposal for later upload.
- If server is unavailable, plugin shows `Offline / ahead`; local editing continues.
- Local proposal upload is idempotent.

## 2.5 Core Workflow D — Pull and Apply Server Main

### Trigger

Server `main` advances; plugin reconnects; user presses “Sync now”; periodic sync tick fires.

### Inputs

- Client’s `last_applied_main`.
- Server’s current `main`.

### Behavior

1. Client asks server for diff from `last_applied_main` to current `main`.
2. Client downloads missing encrypted objects.
3. Client decrypts and builds target vault tree.
4. Before applying destructive changes, client scans local filesystem for unsnapshotted changes.
5. If unsnapshotted changes exist, client snapshots them first.
6. Client applies file creates/updates/deletes/renames.
7. Client updates `last_applied_main` only after apply succeeds.

### Output

Status `Synced` on success. Explicit error on failure.

### Acceptance criteria

- `last_applied_main` must not advance if file apply fails halfway.
- Re-running apply after crash must converge safely.
- Local unsnapshotted changes are never overwritten.

## 2.6 Core Workflow E — Concurrent Edits and Merge

### Trigger

Two clients edit based on the same old `main` and upload later.

### Behavior

Server receives proposal with `base_main != current_main`.

Merge decision order:

1. If proposal changed path IDs disjoint from server changes since base: merge automatically server-side without decrypting content.
2. If same path ID changed but file type is Markdown and a merge-capable client is online: ask client to attempt local plaintext semantic merge.
3. If semantic merge succeeds: client uploads resolution proposal; server advances `main`.
4. If merge is ambiguous and no merge-capable client is online within the merge timeout, server creates a conflict record.

### Output

- Auto-merged changes advance `main`.
- Ambiguous cases appear in conflict center.

### Acceptance criteria

- Same-line contradictory edits create a conflict.
- Delete-vs-edit creates a conflict and preserves edited version.
- Same binary filename changed differently creates a conflict with keep-both as the default resolution; the system never uses last-writer-wins silently.

## 2.7 Core Workflow F — Conflict Review in Central Web UI

### Trigger

User clicks the plugin alert, which opens the dashboard conflict center.

### Inputs

- Server URL and authenticated session.
- Vault passphrase entered locally into browser.
- Conflict object references.

### Behavior

1. Browser downloads encrypted conflict package.
2. Browser derives vault keys locally.
3. Browser decrypts base/main/proposed versions.
4. UI displays:
   - conflict summary;
   - affected file path;
   - base, server, device versions;
   - rendered Markdown diff;
   - source diff;
   - available auto-merge preview.
5. User chooses resolution:
   - accept server version;
   - accept device version;
   - keep both;
   - insert both conflicting blocks;
   - manually edit final merged version.
6. Browser encrypts resolution and uploads it.
7. Server validates ancestry and advances `main` with a resolution commit.
8. Conflict status becomes `resolved`.

### Output

All clients receive `main_advanced` event.

### Acceptance criteria

- Server never sees plaintext conflict content.
- Conflict originals remain recoverable after resolution.
- Resolution commit references conflict ID in encrypted/auditable metadata.

## 2.8 Core Workflow G — Device Dashboard

### Trigger

User opens dashboard.

### Display

Dashboard table:

| Device | Last seen | Last applied main | Server-known state | Notes |
|---|---:|---|---|---|
| MacBook | now | `m-abc` | Synced | OK |
| iPhone | 3 min ago | `m-aaa` | Ahead: 2 uploaded, 1 blocked | Conflict #123 |
| iPad | 2 days ago | `m-090` | Stale/unknown | Server has not heard from device |

### Acceptance criteria

- Dashboard must distinguish “known out of sync” from “offline, state unknown.”
- Device names are stored as encrypted labels. The dashboard shows device IDs until the vault is unlocked locally.

## 2.9 Core Workflow H — Recovery/Rebuild Client

### Trigger

User clicks “Rebuild this device from server main.” The plugin also starts this workflow after detecting local state corruption.

### Behavior

1. Plugin scans for unsnapshotted local changes.
2. Plugin writes an encrypted local recovery bundle.
3. Plugin uploads pending proposals when the server is reachable.
4. Plugin verifies recovery bundle integrity.
5. Plugin applies server `main` to local vault.
6. Plugin marks previous local state as archived.

### Acceptance criteria

- Rebuild is impossible until local pending edits are snapshotted locally and included in the encrypted recovery bundle.
- Rebuild never requires user to inspect database internals.

## 2.10 UX / Operator Experience

### Plugin visible settings, max five

1. Server URL.
2. Pair/login token.
3. Vault passphrase / unlock state.
4. Sync profile: `Notes only`, `Notes + attachments`, `Full vault (advanced)`.
5. Device name.

Everything else goes under diagnostics/advanced and is hidden by default.

### Plugin status text

Use clear strings:

- `Synced`
- `Offline — 3 local changes saved on this device`
- `Uploading 2 changes`
- `Server has 5 changes to apply`
- `Blocked — 1 conflict needs review`
- `Wrong passphrase — cannot decrypt vault`
- `Unsafe local changes saved to recovery; review before rebuild`
- `Server full — edits saved locally, upload paused`

Never show raw internal messages such as `storage -> db` and raw Git output in normal UX. Diagnostic exports include only redacted internal identifiers.

### Server CLI

Required commands:

```bash
obts-server init
obts-server admin create
obts-server admin reset-password
obts-server vault create <name>
obts-server vault invite <vault-id> --ttl 10m
obts-server vault list
obts-server doctor
obts-server backup create
obts-server backup restore <backup-file>
obts-server gc --dry-run
obts-server version
```

### Plugin commands

Required Obsidian commands:

- `True Sync: Sync now`
- `True Sync: Open status`
- `True Sync: Open conflict center`
- `True Sync: Copy diagnostic bundle`
- `True Sync: Rebuild this device from server main`
- `True Sync: Export local recovery bundle`

## 2.11 Documentation Requirements

### User docs

- What `server main` means.
- What `Ahead`, `Behind`, `Blocked`, and `Offline` mean.
- Setup with Docker.
- Pairing a device.
- Choosing sync profile.
- What `.obts/` stores locally and why it is never synced.
- Managed Obsidian/plugin configuration sync.
- Resolving conflicts.
- Recovering/rebuilding a device.
- Changing vault passphrase and rebuilding devices.
- Compacting history.
- What encryption protects and does not protect.
- Backup and restore.
- Why not to run another sync tool on the same vault.

### Operator docs

- Docker environment variables.
- Reverse proxy/TLS setup.
- Postgres setup and backup.
- Backup paths.
- Health endpoints.
- Log redaction guarantees.
- Upgrade procedure.
- Disaster recovery.
- Storage layout.

### Developer docs

- Protocol schemas.
- Object envelope format.
- Merge state machine.
- Local plugin adapter boundaries.
- Test fixture format.
- How to add a semantic merge driver.

## 2.12 Edge-Case UX

| Condition | User-facing behavior | System behavior |
|---|---|---|
| Server offline | “Offline — edits saved locally” | Continue snapshotting local edits |
| Wrong passphrase | “Cannot decrypt vault metadata” | Do not upload plaintext or apply changes |
| Auth expired | “Session expired — sign in again” | Pause sync; keep local queue |
| TLS invalid | “Secure connection failed” | Fail closed except explicit localhost dev mode |
| Conflict | “Review needed” | Preserve all versions |
| Disk full local | “Local disk full — sync paused” | Stop applying changes; do not advance local cursor |
| Server disk full | “Server storage full — uploads paused” | Return `507`; keep local proposals |
| Corrupt encrypted object | “Integrity check failed” | Quarantine object; do not apply |
| Missed file watcher event | No immediate UX; scan reports divergence after detection | Periodic scan detects divergence |
| Stale device | Dashboard shows stale/unknown | Do not assume no local edits |
| Large file exceeds limit | “File too large for current profile” | Exclude and report |
| Plugin disabled | No sync | Server dashboard eventually shows stale |

---

# 3. Technical Design

## 3.1 System Principles

1. **Server main is canonical**
   - `main` is the only published vault state.
   - Clients upload proposals; they do not directly overwrite `main`.

2. **Local-first, not local-authoritative**
   - Local vault may temporarily be ahead, behind, or blocked.
   - UI must make this visible.

3. **Snapshot before overwrite**
   - Before applying remote changes, local dirty state must be durably snapshotted.

4. **No silent loss**
   - Every local edit becomes a durable local proposal before network or destructive operations.
   - Ambiguous conflicts preserve all versions.

5. **E2EE by default**
   - Server can route, store, compare IDs, and merge non-overlapping path changes.
   - Server must not read plaintext content or passphrases.

6. **Small public API, boring UX**
   - Do not expose Git, chunks, DB adapters, merge strategies, CORS, heartbeats, or internals as normal settings.

7. **Idempotent sync**
   - Uploads, proposal submission, object writes, and apply operations must be retry-safe.

8. **Fail closed**
   - Crypto/auth/integrity failures pause sync and preserve local state.

9. **No `.git` in visible vault**
   - Git-like history lives server-side. Local client stores are under `.obts/`, never normal vault repos.

10. **Managed config, not raw `.obsidian` replication**
    - Obsidian and plugin configuration syncs as typed encrypted entries with explicit handlers. The plugin materializes those entries into Obsidian's local config locations.

11. **Diagnostics over knobs**
    - Advanced state is visible in diagnostics. User-facing configuration remains limited to the required setup controls and documented advanced recovery commands.

## 3.2 Architecture

### 3.2.1 System context

```text
+------------------+       HTTPS/WSS        +-------------------------+
| Obsidian Client  | <--------------------> | obts self-hosted server |
| plugin `obts`    |                        | API + dashboard + store |
+------------------+                        +-------------------------+
        |                                                |
        | Obsidian Vault API                             | local disk volume
        v                                                v
+------------------+                         +------------------------+
| Local vault      |                         | Postgres + object store |
| user-visible     |                         | internal Git history   |
+------------------+                         +------------------------+

+------------------+       HTTPS            +-------------------------+
| Browser dashboard| <--------------------> | static web UI/API       |
| client-side crypto                        | encrypted conflict data |
+------------------+                        +-------------------------+
```

### 3.2.2 Containers

Monorepo layout:

```text
/apps/server          Node/Fastify API, merge coordinator, CLI
/apps/web             Client-side dashboard/conflict UI
/apps/plugin          Obsidian plugin
/packages/protocol    Shared TypeScript schemas and API client
/packages/crypto      E2EE envelope, key derivation, test vectors
/packages/merge       Markdown/frontmatter/manifest merge logic
/packages/storage     Object store abstractions
/packages/fixtures    Test vaults and conflict cases
/docs                 User/operator/developer docs
```

### 3.2.3 Server components

```text
Server API
  AuthService
  VaultService
  DeviceService
  ObjectService
  ProposalService
  MergeCoordinator
  ConflictService
  NotificationHub
  BackupService
  AuditLogService
  HealthService

Storage
  Postgres metadata DB
  Local encrypted object store
  Internal Git repo per vault
```

### 3.2.4 Plugin components

```text
Obsidian plugin
  SettingsView
  StatusBar
  VaultWatcher
  PeriodicScanner
  PathNormalizer
  SnapshotEngine
  LocalQueue
  LocalObjectCache
  CryptoService
  TransportClient
  ApplyEngine
  ConflictAutoResolver
  DiagnosticsExporter
```

### 3.2.5 Web UI components

```text
Client-side dashboard
  AuthSession
  VaultUnlock / key derivation
  DeviceDashboard
  ConflictList
  MarkdownDiffViewer
  SourceDiffViewer
  ResolutionEditor
  EncryptedUploadClient
```

## 3.3 Storage Architecture

## 3.3.1 Server history model

The server stores one internal history per vault.

Required v1 implementation:

- Postgres for metadata, refs, device state, conflicts, audit log, and object catalog.
- Local filesystem object store for encrypted blobs and file entries.
- Internal Git repository for immutable commit history and branch-like refs.

Server refs:

```text
refs/obts/main
refs/obts/devices/<device_id>
refs/obts/conflicts/<conflict_id>/base
refs/obts/conflicts/<conflict_id>/main
refs/obts/conflicts/<conflict_id>/proposal
refs/obts/generations/<generation_id>
```

The server uses Git CLI internally, bundled in the Docker image. It must not expose arbitrary Git operations to clients. Git CLI calls must use fixed argv arrays with `shell: false`; never interpolate user input into shell commands.

### Why Git-like history?

Git gives immutable commits, parent links, merge commits, object integrity, history inspection, and recovery semantics. But `obts` must not expose Git UX to users, and the visible vault must remain normal files.

Internal Git history must use a real filesystem backend in v1. S3-compatible storage is not a v1 backend for Git history, refs, Postgres state, or control-plane data. The storage package should keep a narrow object-store interface so a future version can route large encrypted content blobs to an S3-compatible service such as Garage, but v1 stores encrypted objects on local filesystem storage.

## 3.3.2 Encrypted manifest model

Server `main` points to a manifest snapshot. The server does not store plaintext paths. It stores entries keyed by deterministic path IDs.

Definitions:

```text
normalized_path = canonical vault-relative path using `/`, NFC Unicode, no leading slash
path_id = base64url(HMAC-SHA256(path_key, normalized_path))
```

Server-visible manifest entry:

```json
{
  "path_id": "p_xf3...",
  "entry_object_id": "obj_9b2...",
  "content_object_id": "blob_a71...",
  "kind": "md|binary|folder_marker|tombstone",
  "size_bucket": "0-4KB|4-64KB|64KB-1MB|1MB+",
  "schema": 1
}
```

Encrypted file entry payload:

```json
{
  "schema": 1,
  "path": "Projects/Plan.md",
  "kind": "md",
  "mtime_ms_client": 1782400000000,
  "file_mode": "file",
  "plaintext_sha256": "...",
  "content_ref": "blob_a71...",
  "content_encoding": "utf8|binary",
  "frontmatter_digest": "client_computed",
  "created_by_device_id": "dev_..."
}
```

Notes:

- `path_id` leaks equality of pathnames across versions to the server, but not plaintext names.
- `kind` and size bucket leak limited metadata. This leakage must be documented.
- Exact plaintext sizes are not stored in server metadata. The server enforces upload limits through encrypted object byte counts and declared size buckets.
- Full path privacy with zero metadata leakage is outside v1 scope; v1 commits to HMAC path IDs, encrypted path payloads, kind leakage, and size-bucket leakage.

## 3.3.3 Object envelope

All encrypted objects use a versioned envelope.

Plaintext header:

```json
{
  "magic": "OBTS1",
  "object_id": "obj_...",
  "vault_id": "vlt_...",
  "generation_id": "gen_...",
  "type": "file_entry|content_blob|commit_payload|conflict_payload|recovery_bundle",
  "alg": "AES-256-GCM",
  "kdf": "argon2id",
  "nonce": "base64url-96-bit-random",
  "aad": {
    "schema": 1,
    "created_by_device_id": "dev_...",
    "created_at_server_ms": 1782400000000
  }
}
```

Ciphertext:

```json
{
  "header": { ... },
  "ciphertext": "base64url...",
  "tag": "base64url..."
}
```

Requirements:

- Nonce must be unique per encryption key and object.
- Header/AAD must be authenticated.
- Decryption failure is fatal for that object and must fail closed.
- Object ID is content-addressed over canonical envelope bytes, not plaintext.

## 3.3.4 Key hierarchy

Inputs:

- User passphrase, never sent to server.
- Vault salt, server-visible, random at vault creation.
- Vault generation.

Derive:

```text
root_key = Argon2id(passphrase, vault_salt, params)
encryption_key = derive_vault_key(root_key)
path_key = HKDF(root_key, "obts/v1/path-id")
mac_key = HKDF(root_key, "obts/v1/mac")
```

v1 KDF parameters are calibrated on device at setup with minimum floor:

```text
Argon2id memory: >= 64 MiB desktop, >= 32 MiB mobile fallback
Argon2id time cost: >= 3 iterations, with calibration increasing cost on capable devices
parallelism: 1-4 depending platform
```

If mobile cannot handle selected parameters, show a specific error and offer lower-memory mobile-compatible parameters only during vault creation, not silently.

## 3.3.5 Local client state

Local state must not be a normal `.git` directory in the vault.

Required local storage rule:

- All `obts` runtime sync state that lives inside the vault root must live under `.obts/`.
- `.obts/` is always excluded from sync scanning, import, managed config extraction, conflict handling, and compact history.
- The plugin may use platform secure storage for auth tokens when available, but `.obts/` remains the local queue/cache/recovery/staging root.
- The plugin must not store `obts` runtime sync state under `.obsidian/`.

Required `.obts/` layout:

```text
.obts/
  state.json
  queue/
  objects/
  proposals/
  recovery/
  locks/
  diagnostics/
  managed-config/
```

Local state schema:

```json
{
  "schema": 1,
  "vault_id": "vlt_...",
  "device_id": "dev_...",
  "last_applied_main": "m_...",
  "last_uploaded_proposal": "prop_...",
  "sync_profile": "notes_plus_attachments",
  "local_index": {
    "p_xf3...": {
      "last_seen_plaintext_hash": "sha256...",
      "last_seen_mtime_ms": 1782400000000,
      "last_seen_size": 1234
    }
  },
  "pending_proposals": ["prop_local_..."],
  "recovery_bundles": ["rec_..."]
}
```

Local proposal state:

```text
LOCAL_DRAFT -> SNAPSHOTTED -> OBJECTS_UPLOADING -> PROPOSAL_UPLOADED ->
ACCEPTED | SERVER_PENDING | CONFLICTED | RETRY_WAIT | FAILED_PERMANENT
```

## 3.4 Data Model & State

## 3.4.1 Identifiers

| Identifier | Format | Generated by | Notes |
|---|---|---|---|
| `vault_id` | `vlt_` + ULID | server | Not secret |
| `device_id` | `dev_` + 128-bit random base64url | client | Authenticated to server |
| `main_id` / `commit_id` | `m_` + Git OID | server | Immutable |
| `proposal_id` | `prop_` + ULID/hash | client/server | Idempotency key |
| `conflict_id` | `con_` + ULID | server | Stable |
| `object_id` | `obj_` + SHA-256 | client/server | Content-addressed encrypted object |
| `path_id` | `p_` + HMAC-SHA256 | client | Server cannot decode path |
| `blob_id` | `blob_` + SHA-256 | client | Encrypted content blob |

## 3.4.2 Postgres tables

### `users`

```sql
id TEXT PRIMARY KEY,
email TEXT UNIQUE,
password_hash TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
last_login_at_ms INTEGER
```

### `vaults`

```sql
id TEXT PRIMARY KEY,
owner_user_id TEXT NOT NULL,
display_name TEXT NOT NULL,
active_generation_id TEXT,
main_commit_id TEXT,
created_at_ms INTEGER NOT NULL,
updated_at_ms INTEGER NOT NULL,
settings_json TEXT NOT NULL
```

Each vault has exactly one owning user in v1. Shared vault membership, cross-user note sharing, and owner/admin/member roles inside the same vault are not v1 concepts.

### `vault_generations`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
generation_number INTEGER NOT NULL,
vault_salt BYTEA NOT NULL,
root_commit_id TEXT,
state TEXT NOT NULL,
created_reason TEXT NOT NULL,
created_at_ms BIGINT NOT NULL,
activated_at_ms BIGINT,
purged_at_ms BIGINT
```

Generations support initial vault creation, full-vault passphrase change, and compact history. A vault has exactly one active generation.

### `devices`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
user_id TEXT NOT NULL,
display_name_ciphertext TEXT,
last_seen_at_ms INTEGER,
last_applied_main TEXT,
last_uploaded_proposal TEXT,
server_known_state TEXT NOT NULL,
capabilities_json TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
revoked_at_ms INTEGER
```

### `api_tokens`

```sql
id TEXT PRIMARY KEY,
subject_type TEXT NOT NULL,
subject_id TEXT NOT NULL,
token_hash TEXT NOT NULL,
scopes_json TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
expires_at_ms INTEGER,
revoked_at_ms INTEGER
```

### `objects`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
generation_id TEXT NOT NULL,
type TEXT NOT NULL,
size_bytes INTEGER NOT NULL,
storage_path TEXT NOT NULL,
sha256_ciphertext TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
created_by_device_id TEXT
```

### `commits`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
generation_id TEXT NOT NULL,
parent_ids_json TEXT NOT NULL,
manifest_object_id TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
created_by TEXT NOT NULL,
reason TEXT NOT NULL,
related_proposal_id TEXT,
related_conflict_id TEXT
```

### `manifest_entries`

```sql
vault_id TEXT NOT NULL,
commit_id TEXT NOT NULL,
path_id TEXT NOT NULL,
entry_type TEXT NOT NULL,
entry_object_id TEXT NOT NULL,
content_object_id TEXT,
kind TEXT NOT NULL,
materializer TEXT NOT NULL,
PRIMARY KEY (vault_id, commit_id, path_id)
```

This table is materialized for efficient diffing and is rebuildable from commit manifests.

### `proposals`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
device_id TEXT NOT NULL,
base_main_commit_id TEXT NOT NULL,
device_parent_proposal_id TEXT,
changed_path_ids_json TEXT NOT NULL,
proposal_object_id TEXT NOT NULL,
state TEXT NOT NULL,
server_result_json TEXT,
created_at_ms INTEGER NOT NULL,
updated_at_ms INTEGER NOT NULL
```

### `conflicts`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT NOT NULL,
proposal_id TEXT NOT NULL,
base_commit_id TEXT NOT NULL,
main_commit_id TEXT NOT NULL,
proposal_commit_id TEXT NOT NULL,
path_ids_json TEXT NOT NULL,
type TEXT NOT NULL,
status TEXT NOT NULL,
conflict_payload_object_id TEXT NOT NULL,
resolution_commit_id TEXT,
created_at_ms INTEGER NOT NULL,
resolved_at_ms INTEGER
```

### `audit_log`

```sql
id TEXT PRIMARY KEY,
vault_id TEXT,
actor_type TEXT NOT NULL,
actor_id TEXT,
event_type TEXT NOT NULL,
redacted_details_json TEXT NOT NULL,
created_at_ms INTEGER NOT NULL,
correlation_id TEXT
```

## 3.4.3 Account and vault isolation

v1 supports multi-account hosting with strict vault isolation, not shared vault collaboration.

Rules:

1. A logged-in user can create, list, open, configure, and delete only vaults where `vaults.owner_user_id` equals their user ID.
2. A device token is scoped to exactly one `user_id` and one `vault_id`.
3. Every request carrying a `vault_id`, `object_id`, `proposal_id`, `conflict_id`, `device_id`, or event subscription must authorize through both the authenticated subject and the subject's vault scope.
4. Pairing tokens can be created only by the owning user for that vault.
5. Cross-user access to vault metadata, encrypted objects, proposals, conflicts, device state, and events must return `403` or `404` without revealing whether the other user's object exists.
6. Server operators and application admins may reset account access and inspect operational health, but they cannot decrypt vault content without the user's vault passphrase.
7. Sharing one vault between multiple `obts` user accounts is explicitly unsupported.

## 3.4.4 Main state transitions

```text
main M1
  + proposal P1 based on M1, clean
  -> main M2(parent M1, proposal P1)

main M2
  + proposal P2 based on M1, disjoint from M1->M2
  -> main M3(parent M2, proposal P2)

main M3
  + proposal P3 based on M1, overlaps M1->M3
  -> conflict C1, main remains M3

conflict C1 resolved by client-side UI
  -> main M4(parent M3, resolution C1)
```

## 3.4.5 Client state transitions

```text
UNPAIRED
  -> PAIRED_LOCKED
  -> INITIAL_SCAN
  -> SYNCED
  -> AHEAD_LOCAL
  -> UPLOADING
  -> WAITING_SERVER
  -> SYNCED | BLOCKED_CONFLICT | OFFLINE_RETRY

SYNCED
  -> BEHIND_SERVER
  -> APPLYING_SERVER
  -> SYNCED | APPLY_FAILED_RECOVERABLE
```

## 3.4.6 Invariants

1. `main` is append-only: never rewrite existing `main` commits after publication.
2. Server only advances `main` from its current value using a merge/resolution transaction.
3. Every proposal has a `base_main_commit_id`.
4. Every proposal upload is idempotent by `proposal_id`.
5. Client `last_applied_main` advances only after all filesystem changes for that commit are applied and verified.
6. Destructive local apply requires local recovery snapshot first.
7. Conflict resolution must create a new commit; never mutate conflict originals.
8. Server logs must not include plaintext paths/content.
9. Plugin must ignore its own state files and cache paths.
10. A revoked device cannot upload new proposals.

## 3.5 Merge Design

## 3.5.1 Encrypted manifest three-way merge

Inputs:

```text
base_map: path_id -> entry_ref at proposal.base_main
main_map: path_id -> entry_ref at current server main
prop_map: path_id -> entry_ref in proposal
```

For each `path_id` changed by proposal:

```text
base_entry = base_map[path_id]
main_entry = main_map[path_id]
prop_entry = prop_map[path_id]

if main_entry == base_entry:
    merged[path_id] = prop_entry
elif main_entry == prop_entry:
    no-op
else:
    conflict(path_id)
```

If no conflicts, create merge commit with merged manifest.

This works without decrypting content because the server only compares encrypted entry refs and path IDs.

## 3.5.2 Client-side semantic Markdown merge

When same `path_id` changed concurrently and file kind is Markdown:

1. Trusted client downloads base/main/proposal versions.
2. Decrypts locally.
3. Runs merge pipeline:
   - normalize line endings to `\n`;
   - parse YAML frontmatter;
   - merge safe frontmatter sets: `tags`, `aliases`, `cssclasses`;
   - use three-way text merge for body;
   - run heading/block-aware merge by Markdown section;
   - detect conflict markers or ambiguous hunks.
4. If clean, encrypt merged result and upload resolution proposal.
5. If ambiguous, leave conflict for user.

v1 implements line-level, frontmatter-aware, heading-aware, and block-aware merge drivers. Merge drivers must remain conservative: ambiguous hunks create conflicts.

## 3.5.3 Binary merge policy

Binary same-path concurrent changes:

- If ciphertext/plaintext hash proves identical after client decrypt: no conflict.
- If different: create conflict.
- Default UI action: keep both, e.g. `Image.png` and `Image — conflict from iPhone 2026-06-25.png`.

Server must not choose last-writer-wins for binary conflicts.

## 3.5.4 Delete/edit policy

If one side deletes a path and another edits it:

- conflict by default;
- UI offers three actions: restore edited version, keep delete, keep both under conflict filename;
- edited content remains recoverable.

## 3.5.5 Rename policy

v1 uses stable encrypted file IDs for rename detection. If another device edits the previous path concurrently, create a rename/edit conflict that preserves the edited content and the rename target.

## 3.5.6 Merge and materializer registry

Every synced entry must bind to exactly one registry row. Unknown entry types are excluded or conflicted; they are never auto-merged and never resolved by last-writer-wins.

| Entry type | Content kind | Materializer | Merge handler | Auto-merge policy | Conflict default |
|---|---|---|---|---|---|
| `vault_file` | `markdown` | vault file writer | `markdown_three_way` | conservative clean merges only | manual review |
| `vault_file` | `binary` | vault file writer | `binary_identity_only` | identical content only | keep both |
| `vault_file` | `css_snippet` | vault file writer | `text_three_way` | conservative clean merges only | manual review |
| `managed_config` | `obsidian_core_json` | Obsidian config handler | `schema_json_merge` | allowlisted schemas only | manual review |
| `managed_config` | `third_party_plugin_json` | plugin config handler | registered plugin handler | handler-declared safe merges only | manual review |
| `managed_config` | `opaque` | plugin config handler | `identity_or_conflict` | one side changed or identical only | keep both or manual review |

Markdown handler rules:

- Normalize line endings to `\n`.
- Parse YAML frontmatter.
- Merge `tags`, `aliases`, and `cssclasses` as sets.
- Three-way merge body text.
- Use heading/block-aware merge only when block boundaries are stable.
- Create a conflict for parser ambiguity, malformed frontmatter, existing conflict markers, or contradictory same-block edits.

Managed JSON config handler rules:

- Use schema-aware merge only for allowlisted config objects.
- Set-like fields merge as sets.
- Scalar fields conflict if both sides changed differently.
- Device-local fields are stripped before sync.
- Unknown fields are preserved if only one side changed and conflicted if both sides changed.

Opaque config handler rules:

- Excluded by default.
- If explicitly opted in, merge only identical content or one-sided changes.
- Concurrent divergent changes create a conflict or keep-both result according to the registered handler.

## 3.6 Interfaces & Contracts

## 3.6.1 API conventions

Base path: `/api/v1`

Headers:

```http
Authorization: Bearer <device-or-user-token>
Content-Type: application/json
X-OBTS-Client-Version: 0.1.0
X-OBTS-Protocol-Version: 1
X-OBTS-Request-ID: <uuid>
```

Error response:

```json
{
  "error": {
    "code": "CONFLICT_REQUIRES_REVIEW",
    "message": "One uploaded change overlaps with server main and needs review.",
    "retryable": false,
    "user_action": "Open the conflict center.",
    "correlation_id": "req_01J..."
  }
}
```

Status codes:

| Code | Use |
|---:|---|
| 200 | success |
| 201 | object/proposal created |
| 202 | accepted for async processing |
| 204 | no content |
| 400 | malformed request |
| 401 | missing/invalid auth |
| 403 | authenticated but forbidden/revoked |
| 404 | not found |
| 409 | state conflict; proposal not accepted into main |
| 413 | object too large |
| 422 | schema valid but semantically invalid |
| 423 | vault locked/maintenance |
| 429 | rate limited |
| 500 | server bug |
| 507 | insufficient storage |

## 3.6.2 Pairing

### `POST /api/v1/pair/consume`

Request:

```json
{
  "pairing_token": "pair_...",
  "client_name_hint": "Genius MacBook",
  "client_capabilities": {
    "protocol": 1,
    "platform": "desktop|ios|android",
    "semantic_merge_markdown": true,
    "max_blob_size_bytes": 104857600
  }
}
```

Response:

```json
{
  "vault_id": "vlt_01J...",
  "vault_salt": "base64url...",
  "device_id": "dev_...",
  "device_token": "obts_dev_...",
  "server_time_ms": 1782400000000,
  "main_commit_id": "m_...",
  "websocket_url": "wss://sync.example.com/api/v1/events"
}
```

## 3.6.3 Get main

### `GET /api/v1/vaults/{vault_id}/main`

Response:

```json
{
  "vault_id": "vlt_...",
  "main_commit_id": "m_...",
  "manifest_object_id": "obj_...",
  "created_at_ms": 1782400000000,
  "object_count": 1234
}
```

## 3.6.4 Upload objects

### `POST /api/v1/vaults/{vault_id}/objects/batch`

Request:

```json
{
  "objects": [
    {
      "object_id": "obj_...",
      "type": "file_entry",
      "size_bytes": 1024,
      "sha256_ciphertext": "...",
      "envelope": { "header": {}, "ciphertext": "...", "tag": "..." }
    }
  ]
}
```

Response:

```json
{
  "stored": ["obj_..."],
  "already_present": [],
  "rejected": []
}
```

## 3.6.5 Submit proposal

### `POST /api/v1/vaults/{vault_id}/proposals`

Request:

```json
{
  "proposal_id": "prop_...",
  "device_id": "dev_...",
  "base_main_commit_id": "m_base",
  "device_parent_proposal_id": "prop_prev",
  "changed_path_ids": ["p_..."],
  "proposal_object_id": "obj_proposal_payload",
  "manifest_delta": [
    {
      "path_id": "p_...",
      "op": "upsert|delete",
      "entry_object_id": "obj_entry",
      "content_object_id": "blob_content",
      "kind": "md"
    }
  ]
}
```

Response, accepted and merged:

```json
{
  "state": "MERGED",
  "main_commit_id": "m_new",
  "conflict_ids": []
}
```

Response, conflict:

```json
{
  "state": "CONFLICTED",
  "main_commit_id": "m_current",
  "conflict_ids": ["con_..."]
}
```

## 3.6.6 Pull diff

### `POST /api/v1/vaults/{vault_id}/pull`

Request:

```json
{
  "from_commit_id": "m_old",
  "to_commit_id": "m_new",
  "known_object_ids": ["obj_..."]
}
```

Response:

```json
{
  "from_commit_id": "m_old",
  "to_commit_id": "m_new",
  "changed_entries": [
    {
      "path_id": "p_...",
      "op": "upsert|delete",
      "entry_object_id": "obj_...",
      "content_object_id": "blob_...",
      "kind": "md"
    }
  ],
  "required_object_ids": ["obj_...", "blob_..."]
}
```

## 3.6.7 Conflict list

### `GET /api/v1/vaults/{vault_id}/conflicts?status=open`

Response:

```json
{
  "conflicts": [
    {
      "conflict_id": "con_...",
      "status": "open",
      "type": "same_path_edit",
      "path_ids": ["p_..."],
      "base_commit_id": "m_base",
      "main_commit_id": "m_main",
      "proposal_commit_id": "m_prop",
      "created_at_ms": 1782400000000,
      "created_by_device_id": "dev_iphone",
      "conflict_payload_object_id": "obj_conflict"
    }
  ]
}
```

## 3.6.8 Resolve conflict

### `POST /api/v1/vaults/{vault_id}/conflicts/{conflict_id}/resolve`

Request:

```json
{
  "resolution_id": "res_...",
  "base_conflict_status_version": 3,
  "resolved_path_entries": [
    {
      "path_id": "p_...",
      "op": "upsert|delete",
      "entry_object_id": "obj_resolved_entry",
      "content_object_id": "blob_resolved_content",
      "kind": "md"
    }
  ],
  "resolution_payload_object_id": "obj_resolution_payload"
}
```

Response:

```json
{
  "state": "RESOLVED",
  "main_commit_id": "m_after_resolution",
  "conflict_id": "con_..."
}
```

## 3.6.9 Maintenance operations

### `POST /api/v1/vaults/{vault_id}/rekey/start`

Starts a full-vault passphrase-change job after server-side precondition checks.

Request:

```json
{
  "client_job_id": "job_...",
  "current_main_commit_id": "m_current"
}
```

Response:

```json
{
  "job_id": "job_...",
  "state": "READY_FOR_UPLOAD",
  "current_generation_id": "gen_old",
  "target_generation_id": "gen_new"
}
```

### `POST /api/v1/vaults/{vault_id}/rekey/{job_id}/complete`

Completes passphrase change by atomically activating the uploaded generation.

Request:

```json
{
  "target_generation_id": "gen_new",
  "manifest_object_id": "obj_manifest",
  "root_commit_id": "m_rekeyed",
  "revoke_other_devices": true,
  "purge_old_generation": true
}
```

### `POST /api/v1/vaults/{vault_id}/compact/start`

Starts compact history after server-side precondition checks.

Request:

```json
{
  "client_job_id": "job_...",
  "current_main_commit_id": "m_current"
}
```

Response:

```json
{
  "job_id": "job_...",
  "state": "READY",
  "current_generation_id": "gen_old",
  "target_generation_id": "gen_compacted",
  "estimated_discarded_objects": 1234,
  "estimated_discarded_bytes": 987654321
}
```

### `POST /api/v1/vaults/{vault_id}/compact/{job_id}/complete`

Activates the compacted baseline after verifying the new manifest references all current live entries.

## 3.6.10 Events

Use WebSocket for event delivery. Plugin must fall back to polling when WebSocket connection fails.

Event:

```json
{
  "type": "main_advanced",
  "vault_id": "vlt_...",
  "main_commit_id": "m_new",
  "created_at_ms": 1782400000000
}
```

Other event types:

- `conflict_created`
- `conflict_resolved`
- `device_state_changed`
- `vault_maintenance_started`
- `vault_maintenance_finished`

## 3.7 Config

## 3.7.1 Server env vars

| Env var | Required | Default | Description |
|---|---:|---|---|
| `OBTS_BASE_URL` | yes | none | Public URL |
| `OBTS_DATA_DIR` | no | `/data` | Persistent data root |
| `OBTS_HTTP_HOST` | no | `0.0.0.0` | Bind host |
| `OBTS_HTTP_PORT` | no | `8080` | Bind port |
| `OBTS_REQUIRE_HTTPS` | no | `true` | Enforce HTTPS except localhost |
| `OBTS_SERVER_SECRET_FILE` | yes | none | Secret for server token signing |
| `OBTS_DATABASE_URL_FILE` | yes | none | File containing Postgres connection URL |
| `OBTS_LOG_LEVEL` | no | `info` | Log level |
| `OBTS_MAX_BLOB_BYTES` | no | `104857600` | Max object/blob size |
| `OBTS_BACKUP_DIR` | no | `/data/backups` | Backup directory |

## 3.7.2 Plugin settings schema

```ts
interface ObtsPluginSettings {
  serverUrl: string;
  vaultId?: string;
  deviceId?: string;
  deviceName: string;
  syncProfile: 'notes_only' | 'notes_plus_attachments' | 'full_vault_managed_config';
  managedConfigProfile?: 'disabled' | 'core_obsidian' | 'core_plus_allowlisted_plugins';
  authTokenRef?: string;
  keyStorageMode: 'memory_only' | 'platform_secure_storage' | 'prompt_on_start';
  advanced?: {
    pollingIntervalMs?: number;
    diagnosticLogging?: boolean;
  };
}
```

Visible settings must remain limited. `advanced` appears only inside Diagnostics/Advanced.

## 3.8 Required v1 Feature Designs

## 3.8.1 Managed Obsidian and plugin configuration

`obts` must not blindly sync `.obsidian/` as ordinary vault files. Configuration sync uses the same encrypted proposal/history/conflict pipeline as notes, but with `managed_config` entries and explicit materializers.

Rules:

1. `.obts/` is local runtime state and is never synced.
2. `.obsidian/` is an apply/read target, not a raw synced directory.
3. The plugin reads local Obsidian configuration through Obsidian APIs or platform-specific config paths.
4. The plugin normalizes config by removing device-local and volatile fields before creating proposals.
5. Managed config proposals use encrypted objects in server `main` with stable logical IDs such as `cfg_obsidian_core_hotkeys` and `cfg_plugin_<plugin_id>_data`.
6. Applying managed config first writes a local recovery copy under `.obts/recovery/`.
7. Unknown third-party plugin config is excluded by default.
8. Advanced opaque plugin config sync is allowed only path-by-path and uses identity-or-conflict merge behavior.

v1 managed config support:

| Config class | v1 behavior |
|---|---|
| Core Obsidian app settings | supported through schema handlers |
| Hotkeys | supported through schema handlers |
| Appearance settings | supported through schema handlers |
| CSS snippets | synced as text files with conservative merge |
| Themes | synced as ordinary vault assets only when selected |
| Workspace/layout | excluded by default; device-local unless explicitly enabled later |
| `obts` plugin state | always excluded |
| Unknown plugin config | excluded by default; advanced opaque opt-in only |

## 3.8.2 Vault passphrase change by full re-key

Vault passphrase change is a rare owner-triggered maintenance operation. v1 does not perform incremental mixed-generation re-encryption. Instead, a trusted synced device creates a new encrypted generation from the current canonical vault snapshot.

Preconditions:

- initiating device is paired, unlocked, and `Synced`;
- no unresolved conflicts;
- no pending local proposals from the initiating device;
- server has no in-progress vault maintenance job;
- user confirms that other devices must rebuild and old server-side history will be purged.

Behavior:

1. Client downloads any missing encrypted objects for current `main`.
2. Client decrypts current canonical vault state locally with the old passphrase.
3. Client derives new vault keys from the new passphrase and new generation salt.
4. Client re-encrypts the current canonical state into a new generation.
5. Client uploads the complete new manifest and required encrypted objects.
6. Server verifies object presence, object IDs, ciphertext hashes, and manifest completeness without decrypting.
7. Server atomically switches the vault active generation to the new generation.
8. Server revokes existing device tokens except the initiating device token, if the user chooses to keep it active.
9. Other devices show `Needs rebuild — vault passphrase changed`.
10. Old encrypted server generation is purged after successful switch and explicit confirmation.

Guarantees:

- server never receives old passphrase, new passphrase, plaintext content, plaintext paths, or encryption keys;
- failed re-key leaves the old generation active;
- successful re-key preserves current vault content but does not preserve old server-side history;
- re-key does not erase data already present on other devices.

## 3.8.3 Compact history

`Compact history` is an explicit owner-triggered maintenance operation that creates a new encrypted baseline from current `main` and discards older server-side history after verification.

Preconditions:

- no unresolved conflicts;
- no pending proposals;
- no passphrase change in progress;
- user confirms older server-side history will be deleted;
- devices with cursors before the compacted baseline may need to rebuild.

Behavior:

1. Server acquires a vault maintenance lock.
2. Server reads the current encrypted `main` manifest.
3. Server creates a new generation/root commit whose manifest references only current live entries.
4. Server switches active `main` to the compacted baseline after verifying all referenced encrypted objects exist.
5. Devices whose `last_applied_main` is outside the compacted generation rebuild from the new baseline.
6. Server discards older server-side commits, proposals, conflict payloads, manifests, and encrypted objects that are not referenced by the compacted current state.
7. Server records an audit event with object counts and byte totals only.

Compaction does not require the vault passphrase because it rewrites encrypted object references, not plaintext content.

## 3.9 Dependencies & Integrations

### Server

v1 stack:

- TypeScript.
- Node.js runtime.
- Fastify HTTP framework.
- Postgres for server metadata/control-plane state.
- Local filesystem object store for encrypted blobs and file entries.
- Git CLI bundled in Docker image.
- Zod runtime schema validation.
- Structured logger with redaction.

### Plugin

- TypeScript.
- Obsidian plugin API.
- Shared protocol package.
- Browser-compatible crypto/KDF dependencies.
- No top-level Node/Electron imports for mobile-compatible build.
- Use Obsidian APIs for vault access and request transport where required.

### Web UI

- TypeScript.
- Static SPA served by server.
- Client-side crypto package shared with plugin.
- No telemetry.

### Crypto dependencies

Required capabilities:

- AEAD encryption: AES-256-GCM via WebCrypto.
- KDF: Argon2id.
- HKDF-SHA-256.
- HMAC-SHA-256.
- SHA-256 for object IDs.
- CSPRNG.

All crypto must have deterministic test vectors in `/packages/crypto/test-vectors`.

---

# 4. Constraints & Failure Modes

## 4.1 Permissions, Security & Privacy

## 4.1.1 Trust boundaries

```text
Trusted:
  - User's local Obsidian process, after plugin install
  - User's browser runtime after the displayed build hash is verified
  - User-entered vault passphrase

Semi-trusted:
  - Self-hosted server operator

Untrusted for content confidentiality:
  - Server storage
  - Server logs
  - Network
  - Reverse proxy logs
```

E2EE protects against passive server/storage compromise and honest-but-curious server operation. It does not fully protect against a malicious server that serves modified web UI JavaScript to steal the passphrase. Mitigations:

- publish reproducible web UI builds;
- show build hash in plugin and dashboard;
- allow conflict resolver to open from packaged plugin UI instead of server-served JS;
- document the browser E2EE trust caveat clearly.

## 4.1.2 Auth

- Pairing tokens are one-time, high-entropy, scoped to vault, short TTL.
- Device tokens are high-entropy bearer tokens stored in platform storage where available.
- Server stores token hashes, not raw tokens.
- Device revocation prevents new uploads and event subscriptions.
- Admin sessions use secure cookies with CSRF protection.

## 4.1.3 Secrets

Never log:

- passphrases;
- raw auth tokens;
- encryption keys;
- plaintext file paths;
- plaintext note content;
- raw decrypted conflict payloads.

## 4.1.4 Dangerous capabilities

- Server-side Git operations must use fixed commands and fixed repo paths.
- No arbitrary path access from API parameters.
- Object store paths must derive from validated object IDs only.
- Upload size limits enforced before buffering whole body.
- Zip/tar backup restore must prevent path traversal.

## 4.1.5 Fail-closed behavior

Pause sync on:

- AEAD auth failure;
- object hash mismatch;
- wrong passphrase;
- unsupported protocol version;
- revoked device;
- local snapshot write failure;
- local apply verification failure.

## 4.2 Performance & Scalability

v1 target scale:

- 20 user accounts per server in the tested default deployment.
- 1 owner per vault.
- 10 paired devices per vault.
- 50,000 files maximum tested.
- 10 GB vault size maximum tested.
- Individual blob default max 100 MB.
- Server single-node only.
- Postgres is the supported v1 database.

Latency targets:

- Online Markdown edit under 32 KB: visible on second online client within 5 seconds on LAN.
- Status update after server main advances: under 2 seconds with WebSocket, under polling interval otherwise.
- Conflict list load under 2 seconds for 100 open conflicts.

Resource targets:

- Server memory under 512 MB for normal sync.
- Plugin avoids loading entire vault into memory.
- Blob upload/download streams where platform permits.
- Initial scan is incremental and cancellable.

Degradation:

- If events fail, fall back to polling.
- If semantic merge unavailable, create conflict rather than blocking all sync.
- If compact history is unavailable, keep existing encrypted history and report storage growth.

## 4.3 Reliability & Failure Modes

| Failure | Expected behavior | Test |
|---|---|---|
| Server crash during object upload | Partial object is ignored; retry resumes upload safely | Kill server mid-upload |
| Server crash during `main` advance | Restart observes an atomic state with no partial `main` | Fault injection around DB/ref update |
| Client crash before snapshot | Periodic scan catches dirty file on restart | Kill plugin during debounce |
| Client crash after snapshot before upload | Proposal uploads on restart | Kill plugin after local queue write |
| Client crash during apply | Cursor not advanced; retry safe | Kill after first file write |
| Wrong passphrase | No decrypt/apply/upload plaintext | Wrong key test |
| Proposal replay | Idempotent same result | Submit same proposal twice |
| Object corruption | AEAD/hash fail; no apply | Flip bytes in object store |
| Delete/edit race | Conflict; preserve edit | E2E test |
| Rename/edit race | Rename/edit conflict preserves both intents | E2E test |
| Auth revoked mid-sync | Stop uploads; local queue retained | Revoke device during upload |
| Server disk full | Return 507; no main corruption | Fill disk/fake store |
| Clock skew | No correctness dependency on client wall clock | Simulated wrong client time |

## 4.4 Observability & Ops

## 4.4.1 Logs

Use structured JSON logs:

```json
{
  "level": "info",
  "time": "2026-06-25T12:00:00Z",
  "event": "proposal_merged",
  "vault_id": "vlt_...",
  "proposal_id": "prop_...",
  "device_id": "dev_...",
  "old_main": "m_...",
  "new_main": "m_...",
  "changed_path_count": 3,
  "correlation_id": "req_..."
}
```

No plaintext paths or content.

## 4.4.2 Metrics

Expose `/metrics` with admin bearer authentication:

- `obts_proposals_total{state}`
- `obts_conflicts_open`
- `obts_main_advances_total`
- `obts_object_store_bytes`
- `obts_devices_online`
- `obts_api_errors_total{code}`
- `obts_merge_duration_ms`
- `obts_pull_duration_ms`
- `obts_apply_failures_total`

Metrics must not include plaintext paths.

## 4.4.3 Audit records

Audit:

- admin login;
- vault creation/deletion;
- device pairing/revocation;
- proposal accepted/conflicted;
- conflict resolved;
- backup created/restored;
- failed auth attempts.

## 4.4.4 Health checks

- `/health/live`: process alive.
- `/health/ready`: Postgres writable, object store writable, Git store accessible.
- `/health/version`: build version, protocol version, migration version.

## 4.4.5 Backup/restore

v1 backup:

- Postgres dump or storage-consistent Postgres snapshot.
- Local encrypted object store directory.
- Internal Git repo directory.
- Server config excluding secrets.

Backup command must create a consistent snapshot by pausing `main` advancement briefly, taking a Postgres transaction snapshot or dump, and syncing filesystem object/Git data before the archive is finalized.

Restore requires:

```bash
obts-server backup restore <backup-file> --data-dir /data
```

Acceptance:

- Restored server has same `main`, conflicts, device records, and object IDs.
- Clients reconnect without repairing local databases.

---

# 5. Delivery Plan

## 5.1 v1 Scope

## 5.1.1 Included in v1

### Server

- Docker image.
- Admin setup.
- Multi-account user auth.
- Strict vault isolation by owning user.
- Create vault.
- Create pairing token.
- Register devices.
- Revoke devices.
- Change vault passphrase through full-vault re-key and device rebuild.
- Store encrypted objects.
- Store proposals.
- Maintain canonical `main`.
- Auto-merge disjoint path changes.
- Create conflicts for overlapping changes.
- Dashboard: devices, main state, conflicts.
- Client-side web conflict resolver.
- Backup/restore command.
- Compact history operation.
- Local filesystem object store.
- Postgres-backed metadata/control-plane state.
- Health checks and logs.

### Plugin

- Pair with server.
- Derive vault keys locally.
- Initial scan/import.
- Watch Markdown and attachments.
- Sync managed Obsidian configuration through explicit handlers.
- Sync allowlisted third-party plugin configuration through registered handlers.
- Local durable proposal queue under `.obts/`.
- Upload proposals.
- Pull/apply server main.
- Status bar and commands.
- Conflict alert and link to resolver.
- Recovery bundle export.
- Rebuild from server main with local snapshot first.

### Merge

- Encrypted manifest path-level merge.
- Markdown line-level three-way merge in trusted client.
- Markdown heading/block-aware merge in trusted client.
- Basic frontmatter set merge for `tags`, `aliases`, `cssclasses`.
- Binary conflict preservation.
- Rename detection through stable encrypted file IDs.
- Managed config merge/materializer registry.

### Encryption

- Vault passphrase-derived keys.
- Encrypted content and file entries.
- HMAC path IDs.
- Authenticated object envelopes.
- Crypto test vectors.

## 5.1.2 Must be production-grade in v1

- Data loss invariants.
- Object integrity.
- Auth token handling.
- Encryption envelope.
- Idempotent proposal submission.
- Crash-safe `main` advancement.
- Crash-safe local apply cursor.
- Logs redaction.
- Backup/restore.
- Cross-account isolation.
- Passphrase re-key safety.
- Compact history correctness.
- `.obts/` exclusion.

## 5.2 Implementation Plan

## Phase 0 — Validation spikes first

1. Obsidian mobile storage spike:
   - Verify `.obts/` vault-local storage availability and platform secure-token fallback.
   - Verify large object handling.
   - Verify file read/write/delete APIs on desktop/iOS/Android.
   - Verify status bar, commands, settings UI.

2. Crypto spike:
   - Validate AES-256-GCM via WebCrypto and Argon2id WASM.
   - Confirm bundle size and mobile performance.
   - Create test vectors.

3. Server Git/history spike:
   - Validate bundled Git CLI with fixed argv invocation.
   - Prove manifest commit creation and rollback safety.

4. Client-side web UI E2EE spike:
   - Derive keys in browser.
   - Decrypt conflict payload.
   - Upload encrypted resolution.

Exit criteria: small proof-of-concept syncs one encrypted Markdown file between two clients and exercises one conflict resolution through the client-side resolver.

## Phase 1 — Monorepo and protocol

- Create monorepo layout.
- Add strict TypeScript config.
- Add schema validation package.
- Define IDs, envelopes, API contracts.
- Add crypto test vectors.
- Add CI for lint/typecheck/unit tests.

## Phase 2 — Server core

- Build Fastify API.
- Add Postgres migrations.
- Add auth, setup, vault, device, token services.
- Add object store with hash verification.
- Add proposal ingestion.
- Add manifest diff and path-level merge.
- Add `main` transaction logic.
- Add events/polling.
- Add health/logging.

## Phase 3 — Plugin core

- Build settings/pairing flow.
- Implement vault scan and path normalization.
- Implement crypto/key unlock.
- Implement `.obts/` local queue/cache/recovery layout.
- Implement upload proposals.
- Implement pull/apply.
- Implement status bar.
- Add diagnostic bundle.

## Phase 4 — Conflict and managed config system

- Server conflict records.
- Web conflict list.
- Browser vault unlock.
- Markdown/source diff views.
- Resolution upload.
- Conflict resolution commit.
- Plugin alert/link.
- Managed config extraction, merge, recovery, and apply handlers.
- Cross-account isolation tests for conflict and config APIs.

## Phase 5 — Recovery and ops

- Rebuild client from server main.
- Export local recovery bundle.
- Server backup/restore.
- Doctor command.
- Compact history operation.
- Full-vault passphrase re-key operation.
- Device revocation flow.

## Phase 6 — Hardening

- Fault injection tests.
- Mobile tests.
- Large vault tests.
- Security review.
- Documentation.
- v1 release candidate.

## 5.3 Rollout & Migration Strategy

## 5.3.1 v1 rollout

- Target technical self-hosters.
- Require full vault backup before first pairing.
- Warn not to run with other sync tools on same vault.
- Start with one existing vault import to empty server.
- Add second device only after first device reaches `Synced`.

## 5.3.2 Versioning

- Protocol version in every request.
- Object envelope schema version.
- DB migration version.
- Plugin min server version and server min plugin version.

## 5.3.3 Upgrades

- Server upgrade runs migrations at startup.
- Migrations must be backward compatible within one minor version.
- Plugin refuses to sync with unsupported server protocol but keeps local queue.
- Before destructive migration, server creates a backup automatically. Migration stops if backup creation fails.

## 5.3.4 Migration from existing tools

v1 migration from existing tools:

1. Disable other sync tools.
2. Back up vault.
3. Install `obts` server.
4. Pair first device as source of truth/import source.
5. Wait for initial `main` publication.
6. Pair additional devices; choose rebuild from server main.

v1 imports the current vault tree as authoritative content and stores the previous tool state in an encrypted recovery bundle. It does not import third-party replication history into `main`.

## 5.4 Testing / Evals

## 5.4.1 Unit tests

- Path normalization.
- HMAC path ID stability.
- Envelope encrypt/decrypt.
- Wrong key fails.
- Object ID determinism.
- Manifest diff.
- Merge decision matrix.
- Markdown merge driver.
- Frontmatter merge.
- Managed config handler registry.
- `.obts/` exclusion rules.
- Error serialization.

## 5.4.2 Integration tests

Use test harness with fake clients:

1. First device imports vault; server main created.
2. Second device pulls same vault.
3. Single file edit syncs.
4. Disjoint edits merge.
5. Same-line edit conflicts.
6. Delete/edit conflicts.
7. Binary same-name changes conflict.
8. Proposal replay idempotent.
9. Server restart during upload.
10. DB transaction rollback during main advance.
11. Pull/apply retry after crash.
12. Wrong passphrase cannot decrypt.
13. Revoked device cannot upload.
14. Server disk full returns 507 and preserves main.
15. Cross-account vault/object/proposal/conflict/event access is denied.
16. Managed Obsidian config syncs through handlers and applies with local recovery.
17. Passphrase re-key succeeds and forces other devices to rebuild.
18. Failed passphrase re-key leaves old generation active.
19. Compact history preserves current state and requires stale devices to rebuild.

## 5.4.3 End-to-end tests

- Docker server + two plugin clients in automated Obsidian test harness.
- Browser conflict UI resolves conflict and both clients converge.
- Rebuild second device from server main.
- Change vault passphrase from a synced trusted device and rebuild another device.
- Compact history and rebuild a stale device from the compacted baseline.
- Export diagnostic bundle and verify redaction.

## 5.4.4 Security tests

- Token hash only in DB.
- Logs redacted.
- Path traversal attempts rejected.
- Malformed object envelope rejected.
- AEAD tampering rejected.
- Replay proposal safe.
- Revoked device denied.
- Cross-account isolation for every vault-scoped API.
- CSRF/session tests for admin web UI.
- Dependency audit.

## 5.4.5 Performance tests

- 1,000 files / 1 GB vault initial sync.
- 50,000 small Markdown files scan/diff.
- 100 MB attachment upload/download.
- 100 open conflicts dashboard load.
- Memory profiles plugin/server.

## 5.4.6 Manual acceptance checklist

- Setup requires no more than five visible plugin inputs.
- No `.git` appears in vault.
- `.obts/` exists for local state and never appears in server manifest.
- Offline edits show “saved locally.”
- Conflict UI never shows raw Git markers unless source text itself had them.
- Dashboard clearly shows stale/offline devices.
- Rebuild device preserves local recovery snapshot.

## 5.5 Alternatives Considered

## 5.5.1 CouchDB/PouchDB-style replication

Rejected for this product because equal-peer database replication exposes too much complexity to users and makes authority harder to explain. `obts` wants one canonical server main plus per-device proposals.

## 5.5.2 Raw Git in the vault

Rejected for v1:

- leaks `.git` into user vault;
- mobile support is harder;
- users can accidentally run Git commands;
- conflicts appear as developer artifacts;
- other sync tools/backups can mishandle `.git`.

Git-like history remains useful internally.

## 5.5.3 Plaintext server-side merge

Rejected because vault encryption is a core requirement. Server-side semantic merge is forbidden while E2EE is enabled. Trusted client resolvers perform semantic merge.

## 5.5.4 CRDT-first design

Rejected. `obts` aims for seamless, reliable sync across one user's devices, not live shared editing. v1 has no CRDT/OT state, live cursors, presence, or multi-user same-note collaboration. Same-note concurrent edits use the normal proposal, merge, conflict, and review pipeline.

## 5.5.5 Git LFS

Rejected for v1. Large-file handling uses the encrypted object store because it gives control over E2EE, object identity, and self-hosted simplicity.

## 5.5.6 Syncthing-style file sync

Not sufficient by itself because `obts` needs central conflict dashboard, E2EE object model, server canonical main, and Obsidian-specific merge/recovery UX.

## 5.6 Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Mobile platform limitations | Sync feels unreliable on iOS/Android | Design for foreground sync, polling fallback, explicit state |
| E2EE blocks server semantic merge | More conflicts | Client-side auto-merge workers and conflict UI |
| Browser UI served by malicious server | Passphrase theft | Document caveat; packaged resolver; build hash pinning |
| Merge bug loses data | Catastrophic | Preserve originals; property tests; conflict over risky merge |
| File watcher misses changes | Stale local state | Periodic full/incremental scan |
| Huge vaults strain memory | Crashes | Streaming, paging, size limits |
| Server disk fills | Upload failures | 507, dashboard alert, no main advancement |
| Server history grows | Disk usage increases | Explicit compact history operation |
| User loses passphrase and recovery material | Data unrecoverable | Clear setup warning; user-held recovery kit |
| Plugin review rejects name | Distribution issue | Use `True Sync` display name, `obts` ID |
| Dependency supply chain | Security risk | Minimal dependencies, lockfile, audits |
| Other sync tool races | Corruption/confusion | Detect common sync folders and warn strongly |
| Path metadata leakage | Privacy concern | HMAC path IDs; encrypted path payloads; documented kind and size-bucket leakage |

## 5.7 v1 Decisions

1. **Project license**
   - Use AGPL-3.0-only for the repository.
   - Include third-party notices in release artifacts and documentation.

2. **Final plugin display name**
   - Use `True Sync` for the Obsidian plugin display name.
   - Use `Obsidian True Sync` only as the product name in long-form documentation.

3. **Crypto library**
   - Use WebCrypto AES-256-GCM.
   - Use audited Argon2id WASM with deterministic test vectors.
   - Use WebCrypto HKDF, HMAC-SHA-256, SHA-256, and CSPRNG primitives.

4. **Local storage on mobile**
   - Use vault-root `.obts/` as the local sync state root for queue, cache, proposals, recovery, locks, diagnostics, and managed-config staging.
   - Never store `obts` runtime sync state under `.obsidian/`.
   - Use platform secure storage for auth tokens when the platform exposes it; otherwise store encrypted token references under `.obts/`.

5. **Server Git implementation**
   - Use Git CLI bundled in the server Docker image.
   - Invoke Git through fixed argv arrays with `shell: false`.

6. **Metadata leakage budget**
   - Server-visible metadata includes vault ID, device IDs, HMAC path IDs, file kind, size bucket, object byte sizes, commit/proposal/conflict IDs, and timestamps.
   - Server-visible metadata excludes plaintext paths, plaintext content, exact plaintext size, passphrases, and encryption keys.
   - Documentation must include the metadata leakage table before the first public release.

7. **Conflict resolver trust model**
   - Packaged plugin resolver is the primary trusted resolver.
   - Server-served browser dashboard is supported for operator convenience and displays a build hash before passphrase entry.
   - Security documentation must explain that a malicious server can serve hostile dashboard JavaScript.

8. **Default attachment limit**
   - Default individual blob limit is 100 MB.
   - Mobile tests must cover upload, download, pause, retry, and apply for a 100 MB attachment.

9. **Managed Obsidian/plugin configuration sync**
   - v1 syncs Obsidian and plugin configuration as typed managed config entries, not by raw `.obsidian/` file replication.
   - The plugin reads, normalizes, merges, and applies managed config through explicit handlers.
   - Unknown third-party plugin config is excluded by default; advanced opaque opt-in uses identity-or-conflict behavior.

10. **Automatic semantic merge aggressiveness**
   - Automatic semantic merge remains conservative.
   - Clean line, frontmatter-set, heading, and block merges are accepted automatically.
   - Ambiguous content, delete/edit races, binary divergence, and unknown structured formats create conflicts.

---

# 6. Proof That It Works

The implementation is acceptable only when the following proofs pass:

## 6.1 Data-loss proof scenarios

1. Client A edits note offline.
2. Client B edits same note and syncs.
3. Client A reconnects.
4. System must produce exactly one safe outcome: a merged state for non-ambiguous changes and a conflict record for ambiguous changes.
5. Both A and B edits must be recoverable by object ID and UI.

Repeat for:

- same line;
- different lines;
- frontmatter;
- delete/edit;
- binary same path;
- rename/edit.

## 6.2 Canonical-main proof

At all times:

- there is one `main` per vault;
- proposals mutate `main` only through a successful merge transaction;
- conflict creation does not advance `main`;
- resolution advances `main` with parent/reference to previous `main`.

Automated invariant test should randomly generate proposal sequences and verify these properties.

## 6.3 E2EE proof

Tests must show:

- server object store contains no plaintext note strings from fixtures;
- server DB contains no plaintext paths from fixtures;
- wrong passphrase cannot decrypt file entries;
- tampering with ciphertext or AAD fails;
- logs contain no fixture note text or paths.

## 6.4 Recovery proof

Crash/fault injection:

- kill client during upload;
- kill client during apply;
- kill server during main update;
- corrupt local cache;
- revoke device mid-sync.

Expected: no `main` corruption, no local cursor lying, local edits recoverable.

## 6.5 UX proof

Manual tester with no Git/database knowledge must be able to:

1. install server;
2. pair two devices;
3. sync notes;
4. understand offline/ahead status;
5. resolve one conflict;
6. rebuild a device;
7. export diagnostics.

Tester must not encounter raw Git terms, raw database terms, or raw conflict markers during normal workflows.

## 6.6 v1 Definition of Done

v1 is complete only when the following checks pass:

| Requirement | Where specified | How verified |
|---|---|---|
| Core sync across two devices | Workflows 2.3-2.6 | end-to-end sync tests |
| No silent data loss | System principles and invariants | crash/fault injection tests |
| E2EE privacy | Key hierarchy and object envelope | plaintext fixture scans and wrong-key tests |
| Cross-account isolation | Account and vault isolation | unauthorized API/event tests |
| `.obts/` local state | Local client state | manifest and scanner exclusion tests |
| Managed config sync | Managed configuration design | handler fixtures and apply/recovery tests |
| Passphrase change | Full-vault re-key design | success, failure, and rebuild tests |
| Compact history | Compact history design | baseline verification and stale-device rebuild tests |
| Postgres deployment | Server install and config | Docker Compose smoke test |
| Backup/restore | Ops section | restore convergence test |
| Diagnostics redaction | Observability and secrets | diagnostic bundle redaction test |

---

# 7. Agent Guardrails

Implementation agents must not:

- put `.git` in the visible vault;
- add more visible setup settings without explicit product approval;
- send vault passphrase or plaintext content to server;
- choose last-writer-wins for ambiguous conflicts;
- write raw Git conflict markers into notes;
- advance local `last_applied_main` before apply verification;
- advance server `main` outside merge/resolution transaction;
- log plaintext paths/content/secrets;
- introduce telemetry;
- require external cloud services for the default local-filesystem deployment;
- sync `.obts/` or any other `obts` runtime state as vault content;
- implement shared vault membership, cross-user note sharing, live cursors, presence, CRDT/OT sessions, or real-time collaborative editing;
- blindly file-sync `.obsidian/` instead of using managed config handlers;
- use top-level Node/Electron imports in plugin builds that target mobile;
- silently lower KDF parameters without explicit user action.

Implementation agents should prefer:

- conservative conflict creation over risky auto-merge;
- recovery snapshots over destructive cleanup;
- diagnostics over user-facing knobs;
- idempotent APIs;
- schema-versioned objects;
- small dependency surface;
- readable state machines and explicit invariants.

---

# 8. References for Implementers

- Obsidian Developer Documentation: https://docs.obsidian.md/
- Obsidian plugin guidelines/checklist: https://docs.obsidian.md/oo/plugin
- Obsidian manifest reference: https://docs.obsidian.md/Reference/Manifest
- Git `init --separate-git-dir`: https://git-scm.com/docs/git-init
- Git merge behavior: https://git-scm.com/docs/git-merge
- Git worktree docs: https://git-scm.com/docs/git-worktree
- Git LFS: https://git-lfs.com/
- isomorphic-git: https://isomorphic-git.org/
- PostgreSQL documentation: https://www.postgresql.org/docs/
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- MDN Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
