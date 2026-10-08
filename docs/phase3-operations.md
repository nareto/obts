# Phase 3 Operations

Phase 3 adds Git-backed note history, safe restore, redacted diagnostics, and
Git maintenance to the deployable Phase 2 server and dashboard.

## Upgrade From Phase 2

1. Stop the Phase 2 server and take a point-in-time-consistent backup of the
   metadata file and every per-vault Git repository.
2. Deploy the Phase 3 image or build output without replacing `OBTS_DATA_DIR`.
3. Start the server. The file-backed metadata adapter upgrades existing state
   to schema version 6, initializes durable per-device acknowledged and pending-delivery directory snapshots plus rebuildable derived-history indexes, creates
   the bounded diagnostic-event store, and deletes legacy unrestricted device
   error-detail objects. Existing
   unresolved conflicts receive internal protection refs without changing
   `main` or any device ref.
4. Require `GET /health/ready` (or `obts health ready`) to return `ready` before
   allowing clients to resume sync.
5. Query and preview an existing note version, then run a non-destructive Git
   maintenance operation from the dashboard as an owner acceptance check.

No separate migration command is required for the repository's file adapter.
An inconsistent restore is not auto-healed by discarding history: the vault is
blocked and readiness fails closed.

After an operator stops the server and repairs the underlying metadata, Git
refs/objects, ownership, or permissions, validate the repaired vault and clear
its integrity block with `obts integrity repair --vault-id ID`. The command is
deliberately local-only: it does not rewrite refs or invent missing state, and
it refuses to unblock the vault until the metadata-to-Git consistency checks
pass. Run the readiness check again before allowing clients to resume.

## History And Restore

History queries are owner-scoped, follow renames, and cache derived path history
against the exact current `main`. The timeline walks canonical `main` through
its first-parent lineage: proposal-only commits are not presented as published
note versions, while accepted concurrent merges, conflict resolutions, and
restores remain explicit provenance entries even when a resolution keeps the
first-parent file content unchanged. Cache entries are rebuildable; Git remains
authoritative. Markdown versions expose source and rendered diff views;
`.canvas` and `.base` versions expose source diffs. Community-plugin files show
metadata only until the owner explicitly reveals one selected version. The
current implementation requires recent password authentication; architecture
revision 1 replaces that UX with explicit target confirmation, tracked in
Forgejo issue 18.

Restore requires the reviewed `expected_main` and CSRF protection. The current
implementation also requires recent password authentication; migration to
explicit target confirmation is tracked in Forgejo issue 18. Restore writes a
new two-parent Git commit and advances `main` with
a compare-and-swap ref update. The source commit and historical path must belong
to the canonical history of the requested target path. Restore and maintenance
share the same per-vault mutation lock as device sync and conflict resolution.
They never rewrite existing history. Paired
clients receive the new `main` through their normal pull/apply path, including
the existing recovery-bundle and apply-journal protections.

## Diagnostics And Maintenance

`GET /api/v1/vaults/{vault_id}/diagnostics/export` returns an owner-scoped,
redacted JSON export. It excludes content, raw paths, sensitive plugin data,
tokens, Git object payloads, recovery content, device error details, and
operation manifests. The endpoint never provides cross-owner visibility.

The server accepts fixed-schema plugin failure reports only when
`OBTS_DIAGNOSTIC_INGEST_ENABLED=true`. Client sharing remains independently off
by default and is bound to the configured backend URL. Approved onboarding
connections and paired devices authenticate to separate ingestion routes. The
server rejects unknown payload fields, enforces byte/rate/quota limits, retains
reports for `OBTS_DIAGNOSTIC_RETENTION_DAYS` (14 by default, 90 maximum), and
never persists request credentials. Owners inspect and delete their reports on
the dashboard Settings page. Deletion currently requires CSRF protection and
recent password authentication; explicit confirmation migration is tracked in
Forgejo issue 18. Backup rotation governs residual copies.

Git maintenance currently requires recent owner password authentication;
architecture revision 1 replaces that UX with explicit confirmation, tracked in
Forgejo issue 18. It verifies Git objects,
ensures unresolved-conflict protection refs exist, repacks reachable objects,
prunes only unreachable objects, and verifies integrity again. It does not
truncate visible history. Maintenance start and completion are persisted as
redacted events.

## Server Operational Logs

`obts serve` writes closed-schema JSON lines to stdout by default. Set
`OBTS_LOG_LEVEL=error|warn|info|debug|silent` (default `info`); an invalid value
fails startup. Library use and other CLI commands remain silent, including
`health --json` and `setup --json`. The listening banner is a `server_listening`
event, not a plaintext URL.

Events are `http_request`, `server_listening`, `startup_phase`,
`vault_integrity_blocked`, `push_integrated`, `conflict_created`,
`conflict_resolved`, and `background_task_failed`. Each completed or aborted
request has one request event. Integration events also cover asynchronous
finalization and startup resumption, so a processing response is distinguishable
from an actual merge outcome. Lifecycle events follow successful durable
mutations; integrity-block events report only actual status transitions.

| Fields | Meaning |
| --- | --- |
| `ts`, `level`, `event`, `service`, `version` | UTC timestamp, severity, event category, fixed `obts-server` service and server version |
| `request_id`, `method`, `route`, `status`, `duration_ms`, `outcome` | Request correlation, HTTP method, allowlisted route template (null for unmatched), status (null for aborted), rounded duration and `ok|client_error|server_error|aborted` |
| `vault_id`, `device_id`, `user_id`, `connection_id`, `transfer_id`, `conflict_id`, `plugin_version` | Known opaque identities and sanitized plugin version; connection ID is never the connection secret |
| `error_code`, `error_class`, `stack`, `failed_checks` | Safe error code/class, bounded stack frame positions only, and comma-separated failed readiness check names (never detail text) |
| `push_status`, `event_seq`, `directory_ack`, `attempt_id`, `chunk_count`, `chunk_index`, `complete`, `target`, `reported_status`, `resolution` | Validated domain observations; attempt IDs must match a bounded opaque-ID pattern, target is `latest|explicit`, reported status uses the safe queue-status vocabulary |
| `host`, `port`, `log_level`, `phase`, `source`, `task` | Listener configuration and closed startup, integrity-source and background-task categories |

| Request class | Level |
| --- | --- |
| Readiness non-200 | `warn` (status and failed check names only) |
| Other 5xx | `error` |
| Successful GET/HEAD health and dashboard/static; GET event polling; push-chunk PUT | `debug` |
| Unmatched 404 | `debug` |
| All other requests, including 4xx and aborts | `info` |

Every line is capped at 4 KiB; unknown fields and invalid values are dropped.
Logs never include raw paths/URLs/queries, bodies, headers, client IPs,
credentials, content, display names, Git object IDs or error message text.
Logging failures are swallowed and logging never changes responses, mutation
ordering, durability or recovery. A failing or backpressured stdout sink may
lose observations; logs are not persistence or recovery authority.

For example, inspect integration outcomes and their progression without Git IDs:

```sh
jq -c 'select(.event == "push_integrated") | {ts, vault_id, device_id, transfer_id, push_status, event_seq, error_code}' server.jsonl
```

## Backup Boundary

Follow [persistent-state.md](./persistent-state.md). Backup orchestration,
schedules, retention, offsite destinations, encryption-key custody, and restore
automation belong to the deployment. The application requires a quiesced or
point-in-time-consistent capture across metadata and the Git store.
