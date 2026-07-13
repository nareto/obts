# Persistent State And Backup Contract

Phase 3 persistent state lives under `OBTS_DATA_DIR` unless a deployment sets
separate directories in server configuration. Phase 3 upgrades Phase 2 state in
place and continues to use the same file-backed metadata adapter in this
repository.

Back up these paths atomically:

- the Postgres database when the production Postgres metadata adapter is
  configured; the executable repository slice currently uses the file adapter
  below instead;
- all of `OBTS_DATA_DIR`, including metadata and any durable recovery residue;
- `OBTS_DATA_DIR/metadata/phase1.json`: users, sessions, vaults, devices,
  token hashes, sync operations, conflict workflow records, dashboard events,
  audit rows, opted-in sanitized error diagnostics, and rebuildable derived
  note-history indexes.
- `OBTS_DATA_DIR/git/*.git`: per-vault native Git repositories containing
  canonical `refs/heads/main`, protected device refs, commits, trees, blobs,
  packs, and refs protecting unresolved conflict history.
- `OBTS_DATA_DIR/tmp` only when an operator intentionally preserves recovery
  residue for investigation. Normal merge workspaces are transaction-scoped.
- `OBTS_GIT_STORE_DIR` when configured outside `OBTS_DATA_DIR`.

Back up deployment-managed backup-encryption keys or storage credentials
separately from application state when the deployment uses them. This contract
does not prescribe schedules, retention, offsite locations, or private restore
automation.

Backups must be point-in-time consistent across metadata and Git stores.
`/health/ready` runs native Git object-integrity checks and verifies that every metadata `current_main` matches
`refs/heads/main`, every recorded device ref matches its Git ref, and every
open conflict still points at existing commits and protection refs. Current
derived-history rows must point at existing commits. If a restore loses required
Git state or metadata, migrations, filesystem access, or native Git, readiness
fails closed until operator repair; history and restore endpoints also refuse a
vault marked `blocked_integrity`.

At startup the server also rejects orphan per-vault Git repositories that have
no matching metadata record and marks a metadata-backed vault
`blocked_integrity` when its repository, owner access bits, refs, objects,
conflict protection, or current derived index are inconsistent. This prevents a
partially restored metadata/Git pair from serving a plausible but incomplete
history.

Once the operator has stopped the server and restored or repaired the
underlying state, run `obts integrity repair --vault-id ID`. This local command
only validates and clears the block; it never chooses between mismatched refs,
reconstructs missing objects, or discards metadata. `/health/ready` must pass
after the command before traffic resumes.

Event rows are retained for 30 days or 100,000 events per vault. Clients that
resume from an older pruned cursor receive `410 event_cursor_expired` and must
refresh vault state before polling from an available cursor.

Phase 3 does not implement application-level encrypted persistence. Offline
disclosure protection depends on deployment-managed filesystem, volume,
snapshot, or database-backup encryption and restrictive permissions. Keep those
encryption keys and storage credentials outside this repository and outside the
application state being protected.

Default diagnostics exports omit note bodies, raw paths, plugin settings and
file bodies, tokens, credentials, Git packs/blobs, recovery bundle content, and
operation manifests. Opted-in plugin error diagnostics use a closed schema,
expire after 14 days by default, and can be deleted by their owner from the
Settings page. Expired or deleted records can remain in historical backups until
backup rotation removes them. Treat even redacted diagnostics as sensitive
application state. Community-plugin file history is metadata-only by default; revealing a
selected body is an explicit owner action protected by recent authentication.

Git maintenance verifies object integrity before and after repacking and prunes
only unreachable objects. Commits reachable from `main`, device refs,
unresolved-conflict refs, and recovery refs are retained. Phase 3 has no history
truncation, baseline compaction, or compact-history API.
