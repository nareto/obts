# Phase 3 Operations

Phase 3 adds Git-backed note history, safe restore, redacted diagnostics, and
Git maintenance to the deployable Phase 2 server and dashboard.

## Upgrade From Phase 2

1. Stop the Phase 2 server and take a point-in-time-consistent backup of the
   metadata file and every per-vault Git repository.
2. Deploy the Phase 3 image or build output without replacing `OBTS_DATA_DIR`.
3. Start the server. The file-backed metadata adapter upgrades schema version 1
   to version 2 and initializes rebuildable derived-history indexes. Existing
   unresolved conflicts receive internal protection refs without changing
   `main` or any device ref.
4. Require `GET /health/ready` (or `obts health ready`) to return `ready` before
   allowing clients to resume sync.
5. Query and preview an existing note version, then run a non-destructive Git
   maintenance operation from the dashboard as an owner acceptance check.

No separate migration command is required for the repository's file adapter.
An inconsistent restore is not auto-healed by discarding history: the vault is
blocked and readiness fails closed.

## History And Restore

History queries are owner-scoped, follow renames, and cache derived path history
against the exact current `main`. Cache entries are rebuildable; Git remains
authoritative. Markdown versions expose source and rendered diff views;
`.canvas` and `.base` versions expose source diffs. Community-plugin files show
metadata only until the owner explicitly reveals one selected version after
recent authentication.

Restore requires the reviewed `expected_main`, CSRF protection, and recent
authentication. It writes a new two-parent Git commit and advances `main` with
a compare-and-swap ref update. It never rewrites existing history. Paired
clients receive the new `main` through their normal pull/apply path, including
the existing recovery-bundle and apply-journal protections.

## Diagnostics And Maintenance

`GET /api/v1/vaults/{vault_id}/diagnostics/export` returns an owner-scoped,
redacted JSON export. It excludes content, raw paths, sensitive plugin data,
tokens, Git object payloads, recovery content, device error details, and
operation manifests. The endpoint never provides cross-owner visibility.

Git maintenance requires recent owner authentication. It verifies Git objects,
ensures unresolved-conflict protection refs exist, repacks reachable objects,
prunes only unreachable objects, and verifies integrity again. It does not
truncate visible history. Maintenance start and completion are persisted as
redacted events.

## Backup Boundary

Follow [persistent-state.md](./persistent-state.md). Backup orchestration,
schedules, retention, offsite destinations, encryption-key custody, and restore
automation belong to the deployment. The application requires a quiesced or
point-in-time-consistent capture across metadata and the Git store.
