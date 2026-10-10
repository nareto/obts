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
  token hashes, hot/live sync operations, conflict workflow records, dashboard
  events, audit rows, opted-in sanitized error diagnostics, and rebuildable
  derived note-history indexes.
- `OBTS_DATA_DIR/metadata/operation-history/<vault-id>/history.sqlite` and any
  `history.sqlite-journal` recovery file: the lossless, ordered durable ledger
  of completed sync operations and its indexes/batch proofs. Do not copy,
  remove, or restore this independently of `phase1.json` and Git.
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

Schema version 8 adds per-vault ledger identity/generation/sequence metadata.
On first startup, legacy schema-7 sync-operation rows remain in `phase1.json`
while their stable array order and ledger identities are durably initialized;
terminal rows then move to SQLite through recoverable, bounded batches before
the server serves traffic. Started/prepared recovery work remains hot, as do
committed device pushes whose merge still needs processing.

Backups must be point-in-time consistent across `phase1.json`, every
per-vault operation-history SQLite database and any active rollback journal,
and Git. The supported simple procedure is to stop the server, wait for clean
shutdown, then snapshot/copy the complete `OBTS_DATA_DIR` and any external
`OBTS_GIT_STORE_DIR` together. A live backup must use a coordinated
application-aware snapshot that captures all three authorities at one point in
time; copying files independently is not supported. SQLite uses the built-in
Node `node:sqlite` binding with rollback journaling and `synchronous=EXTRA`;
Node currently emits its standard experimental-feature warning for `node:sqlite`,
and correctness assumes the filesystem honors file and directory fsync barriers.

Existing ledgers are preflighted read-only before writable SQLite access. A hot
rollback journal is recovered first on a private copy, never on an unverified
original. Only a copy matching the trusted vault/ledger/schema and metadata
handoff state permits original recovery, after the original database/journal
identities and bytes are rechecked; the actual opened ledger is validated again.
Clean opens do not copy history.

Recovery copies contain confidential manifests. They stay under the vault's
history directory in the reserved `.recovery-<sha256>` namespace, where the hash
binds the JSON-encoded pair of trusted vault and ledger IDs. Only that exact
namespace, owned by the server UID with mode `0700`, and its single-link regular
`0600` files `history.sqlite` and `history.sqlite-journal` are discardable scratch.
Empty directories and partial copies are safe to discard: the authoritative pair
is untouched until validation and scratch cleanup complete. Startup and vault
deletion repeat descriptor-relative file removal, nonrecursive directory removal
and directory fsync; unknown names, unsafe types/permissions or other ledger
namespaces block rather than being recursively removed. A cleanup failure blocks
original recovery and serving, retains any residue inside deletion coverage, and
does not replace an earlier validation error. No recovery payload is placed in
OS temporary directories. This relies on the existing stopped/drained single-owner
boundary, not concurrent writers or an arbitrary-writer authentication scheme.

Initial creation uses the same private ownership and deletion checks in a separate
`.initial-<sha256>` namespace bound to the trusted vault/ledger pair. Metadata must
still mark initialization pending at generation zero with no handoff. SQLite
commits schema and identity there, closes the connection, and flushes the staged
file and directory before renaming the database into the final namespace. A new
connection opens the final path only after staging cleanup; file and ancestor
directory barriers precede JSON acknowledgement. A stopped initial writer may
leave an empty or partial staged database/journal; startup discards only this
owned stage and retries while all operation evidence remains hot. Vault deletion
also covers staged residue. Unknown final databases, final journals without a
database, and missing acknowledged ledgers are never replaced by initialization.
Known ledger read/payload failures latch readiness and subsequent access closed
until a verified restart, even if the bytes are restored while the process lives.

To explicitly export sensitive operation records, stop the server, wait for
shutdown to drain, and run `obts history export --vault-id ID` with the same
`OBTS_DATA_DIR` and `OBTS_GIT_STORE_DIR` using the shipped Node runtime. Only one
process may own these directories; do not run export alongside a serving instance
or another CLI command. The command is **not read-only inspection**: it performs
full server initialization, including schema migration, operation/handoff
recovery, history compaction, pending merge processing, and pending vault deletion.
Shutdown drains any deletion work started by initialization. Even an unknown-vault
request can therefore change persistent state. Take a complete stopped-server
backup first if the original evidence must remain untouched; inspect a disposable
complete restore rather than the only copy.

Successful export writes the complete hot/cold union in original operation order,
including full manifests and paths, to stdout as JSON. Protect the output as
confidential application data and do not attach it as ordinary diagnostics. There
is no public raw-history endpoint. Usage/unknown-vault errors exit 2; storage or
recovery failures exit 1 with a fixed safe message, not raw error payloads or
paths. Malformed export arguments are rejected before initialization. A blocked
vault can still export verified evidence; export success is not a readiness or
repair verdict. Startup migrates legacy hot rows before serving; retain a complete
pre-upgrade backup if rollback is needed. The old binary does
not reliably reject the newer metadata schema, so a version change alone is
not a rollback fence. A supported downgrade requires restoring the complete
pre-migration metadata, Git, and other persistent state together with the old
binary; do not discard or hand-edit the new history ledger.
`/health/ready` runs native Git object-integrity checks and verifies that every metadata `current_main` matches
`refs/heads/main`, every recorded device ref matches its Git ref, and every
open conflict still points at existing commits and protection refs. A recent
prepared sync operation may temporarily prove the expected old ref and target
new ref during the bounded interval between the compare-and-swap ref update and
its metadata commit; readiness validates against that target without treating
it as restored-state corruption. Stale or unrelated mismatches still fail
closed. Current derived-history rows must point at existing commits. If a
restore loses required Git state or metadata, migrations, filesystem access, or
native Git, readiness fails closed until operator repair; history and restore
endpoints also refuse a vault marked `blocked_integrity`.

At startup the server also rejects orphan per-vault Git repositories that have
no matching metadata record and marks a metadata-backed vault
`blocked_integrity` when its repository, owner access bits, refs, objects,
conflict protection, or current derived index are inconsistent. This prevents a
partially restored metadata/Git pair from serving a plausible but incomplete
history.

Once the operator has stopped the server and restored or repaired the
underlying state, run `obts integrity repair --vault-id ID`. This local command
only validates and clears the block; unlike live readiness, repair does not
accept a prepared-operation transition as proof of a durable repair. It never
chooses between mismatched refs, reconstructs missing objects, or discards
metadata. `/health/ready` must pass
after the command before sync traffic resumes. The routed service itself uses
process-local liveness rather than global readiness so the authenticated
operator can still reach diagnostics and repair controls while one vault is
blocked. Device-status responses advertise the repaired active state so queued
clients can perform a fresh scan and resume without reset or reconnect.

Event rows are retained for 30 days or 100,000 events per vault. Clients that
resume from an older pruned cursor receive `410 event_cursor_expired` and must
refresh vault state before polling from an available cursor.

Operation history is retained indefinitely for retry and admission replay;
its cold SQLite storage can continue to grow even though completed rows leave
the hot metadata file. Vault deletion removes the ledger and its rollback
journal before the deletion receipt is finalized.

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
application state. Community-plugin file history is metadata-only by default. The current
implementation protects revealing a selected body with recent password
authentication; architecture revision 1 replaces that UX with explicit target
confirmation, tracked in Forgejo issue 18.

The Obsidian client stores watcher rename relations and frozen rename capture identity in `.obts/stale-provenance.json` and `.obts/queue.json`. Stale provenance schema version 4 adds validated `rename_pairs`; existing versions migrate with an empty relation list and never infer renames from similarity. A queue capture binds its pair array and capture ID to the immutable multipart request or chunk checkpoint. Downgrading to a client without this support cannot safely upload an outstanding paired proposal; preserve the vault's `.obts` state and update the server/client before retrying.

Git maintenance verifies object integrity before and after repacking and prunes
only unreachable objects. Commits reachable from `main`, device refs,
unresolved-conflict refs, and recovery refs are retained. Phase 3 has no history
truncation, baseline compaction, or compact-history API.
