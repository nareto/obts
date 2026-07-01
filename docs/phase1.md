# Phase 1 Implementation

This repository now contains the first vertical sync slice from `prd.md`:
Sync Without Conflict Resolution.

Implemented runtime pieces:

- TypeScript package with build, type-check, and Vitest commands.
- Shared API types, status labels, validation helpers, and vault path policy.
- Committed OpenAPI 3.1 contract at `openapi/openapi.yaml`.
- Fastify server with first-run setup, Argon2id password storage, login/logout sessions, CSRF-protected dashboard mutations, admin user creation, vault creation, pairing tokens, device tokens, multipart push, multipart pull, events, conflicts, and health checks.
- Phase 1 admin lifecycle APIs for redacted account listing, user disable/re-enable, admin grant/revoke with final-admin protection, one-time password reset tokens, and individual device revocation. User disable and device revocation immediately invalidate the affected dashboard sessions, pairing tokens, and device tokens.
- Dashboard sessions use a browser-compatible `obts_session` cookie for HTTP/dev deployments and the hardened `__Host-obts_session` Secure cookie when `publicBaseUrl` is HTTPS.
- Recent-auth enforcement covers sensitive Phase 1 dashboard mutations such as pairing token creation and admin account creation.
- Multipart sync manifests reject non-commit ref strings and malformed SHA-256 packfile digests before Git ref mutation logic runs.
- Uploaded packfiles and individual Git blobs are checked against the configured upload byte limit before refs advance.
- Per-vault native Git stores under `OBTS_DATA_DIR/git`, with server-authored empty-tree root commits on `refs/heads/main`.
- Protected device refs at `refs/obts/devices/{device_id}` with no-op, fast-forward, stale-ref, malformed-pack, path-policy, and same-device non-fast-forward handling.
- Pairing stores the device sync profile and plugin-sync setting, and server-side upload validation rejects changed paths outside that paired policy while preserving inherited server tree entries.
- Pull manifests and local apply materialize only paths allowed by the paired device's sync profile; the hidden local Git refs still track the full server `main` so out-of-profile server files are preserved on later uploads.
- Shared client/server path policy rejects internal state, visible Git directories, traversal, empty path segments, cross-platform-invalid names, case-fold collisions, unsupported Git tree modes, and `.obsidian` files outside the explicit sync profile.
- Server-side automatic merge for disjoint path changes, clean native Git merges of overlapping Markdown, and conservative semantic merges for safe overlapping JSON Canvas and Obsidian Bases files even when line-based Git merge cannot cleanly merge the compact source text. Merge decisions include deterministic Canvas JSON output, deterministic Bases YAML output, durable operation records, blocked-device rejection, and durable conflict records with validator results for unsafe overlapping or file/directory hierarchy-collision changes.
- Same-path binary and attachment edits merge automatically only when the accepted server version and uploaded device version have identical blob content; otherwise they remain review-needed conflicts.
- Merge operations persist the exact target commit and target ref in the prepared operation manifest before advancing `refs/heads/main`; startup reconciliation aborts unprepared writes, rolls forward prepared writes whose Git refs already moved, resumes merged-or-conflicted processing for recovered device ref updates, and marks unreconcilable vault state as `blocked_integrity`.
- Vault event polling retains 30 days or 100,000 events per vault, returns `410 event_cursor_expired` when a client cursor predates retained history, and includes the current and oldest available event cursors in the redacted error details.
- Plugin-side `.obts/` state with `isomorphic-git`, device token storage, durable watcher change hints, queue state, recovery bundles with file snapshots, text patches, local Git refs packs, and artifact checksums, local apply lock, apply journal, local commit creation, multipart push, multipart pull, safe apply, incomplete-journal blocking, and explicit replace-local-with-server recovery.
- Plugin sync records server-created conflicts as a local `Review needed` blocking state, so later automatic sync or pull/apply attempts stop before replacing local review content.
- The sync pull API also rejects devices marked `review_needed` or `blocked_recovery`, so a stale or reset plugin cannot bypass server-known conflict/recovery blocks and apply server state over review content.
- API-backed dashboard shell for setup, login, vault creation, overview, device status, events, readiness, and pairing-token creation; the dashboard health summary reuses the same fail-closed readiness checks as `/health/ready`.
- Dashboard device behind/synced state is derived from each device's acknowledged `last_applied_main` commit cursor rather than timestamps; timestamps remain display metadata only.
- Readiness checks that fail closed when metadata, Git refs, conflict commits, writable storage, or native Git readiness are inconsistent.

The Phase 1 server uses a durable JSON metadata adapter in `OBTS_DATA_DIR/metadata/phase1.json` so the product slice can run without requiring a local Postgres service in this repository. The service boundaries are deliberately named around metadata and sync operations so a Postgres adapter can replace the file adapter without changing the Git sync model.

Conflict package rendering, manual resolution, note history, restore, and rendered diff UI are intentionally not implemented; those are Phase 2 and later PRD slices.

## Acceptance Coverage

The Vitest suite in `tests/phase1.test.ts` proves:

- first-run setup is one-time, liveness/readiness health endpoints work, and
  new vaults create a real empty-tree `refs/heads/main` commit immediately;
- two paired devices sync non-conflicting vault changes through server `main`;
- dashboard passwords are stored as Argon2id hashes using the PRD v1 minimum parameters;
- sensitive admin account creation requires recent dashboard authentication;
- admin lifecycle mutations require recent dashboard authentication, preserve one enabled admin, expose only account metadata plus owned-vault counts, and immediately revoke disabled users' auth state;
- individual device revocation immediately rejects subsequent device-token sync requests;
- device push and pull both use multipart manifests with Git packfile parts;
- malformed commit IDs in multipart sync manifests are rejected before Git ref mutation;
- hidden Git state is under `.obts/`, with no visible vault `.git`;
- first-device import of existing local content creates a recovery bundle and requires confirmation;
- watcher change hints for syncable vault paths survive plugin restart and are consumed by the next normal Git-backed sync scan, while internal `.obts` and visible `.git` paths are ignored;
- divergent additional-device local content creates a recovery bundle, blocks normal sync, and requires explicit replace-local-with-server before destructive apply, even when current server `main` is still the empty root;
- pairing tokens are scoped to their issued sync profile and cannot be consumed twice;
- replace-local-with-server recovers and safely materializes file/directory collisions, including local directories that must be replaced by server files;
- partial or already-paired local `.obts/` state blocks pairing before a one-time pairing token is consumed;
- clean overlapping Markdown edits merge through native Git before conflict creation;
- Markdown merges with concurrent same-key frontmatter edits are rejected as conflicts even when Git can produce a clean text merge;
- compact same-file JSON Canvas edits with disjoint semantic fields merge deterministically when native Git reports a text conflict, while same-field Canvas edits create a durable conflict;
- local path collisions are rejected before local hidden Git commits are created;
- safe same-file Obsidian Bases edits merge through the semantic Bases validator, including compact YAML that native Git cannot merge cleanly, while unsafe same-field Bases edits create a durable conflict;
- same-path binary attachment edits auto-merge only when object identity matches;
- unsafe concurrent same-path edits and file/directory hierarchy collisions create a durable conflict record and do not overwrite current `main`;
- a device with an open server conflict blocks subsequent local sync and pull/apply before local review content is replaced;
- devices with open conflicts cannot upload newer commits until recovery or conflict review is completed;
- retried uploads whose device ref already advanced but whose commit is not yet in `main` resume merge evaluation instead of becoming a false no-op;
- uploaded commits that introduce paths outside the paired device's sync profile are rejected before refs advance;
- authenticated sync rejections append redacted `device_sync_rejected` events for dashboard/event polling;
- dashboard device status uses acknowledged commit cursors, not `last_successful_sync_at`, to decide whether a device is Behind or Synced;
- uploaded files larger than the configured byte limit are rejected before refs advance;
- a third device receives the safe current `main` while a conflict remains open;
- cross-user access to vault main, dashboard, conflicts, device sync push/pull,
  and events returns `404`;
- restored metadata that points at missing Git state makes `/health/ready` return `503` and surfaces a not-ready dashboard health summary;
- prepared sync operations recover deterministically on restart when Git refs already moved, resume pending device ref merges, or abort safely before ref mutation;
- event polling returns `410` for expired cursors after retention pruning;
- incomplete apply journals block sync on restart instead of attempting an unsafe apply;
- committed apply journals replay idempotently on restart and clear stale local apply locks;
- local apply lock contention blocks before a destructive pull apply starts;
- recovery bundle creation failures leave a blocked apply journal and do not write files;
- recovery bundles written before destructive apply contain affected file snapshots, text patch artifacts, local Git refs packs, and checksums for generated artifacts;
- files changed after apply preflight block before overwrite;
- shared path policy rejects `.obts/`, visible `.git`, traversal, empty path segments, cross-platform-invalid names, case-fold collisions, unapproved `.obsidian` files, and non-regular Git tree entries.
