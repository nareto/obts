# Phase 1 Implementation

This repository now contains the first vertical sync slice from `prd.md`:
Sync Without Conflict Resolution.

Implemented runtime pieces:

- TypeScript package with build, type-check, and Vitest commands.
- `obts` CLI entrypoint for first-run setup, vault creation, device listing,
  conflict listing, readiness checks, serving the API,
  and local admin password-reset recovery.
- OCI image definition with native `git`, persistent-state volume, process-local liveness healthcheck, and `obts serve` startup command. Readiness remains a separate deep consistency signal so one blocked vault cannot remove the dashboard and repair surface from routing.
- Manual operations and smoke-test guides in `docs/phase1-operations.md` and
  `docs/phase1-smoke-test.md`.
- Installable Obsidian plugin package in `obsidian-plugin/`; its source and
  tested sync engine live together under `obsidian-plugin/src/`.
- Shared API types, status labels, validation helpers, and vault path policy.
- Committed OpenAPI 3.1 contract at `openapi/openapi.yaml`.
- Fastify server with first-run setup, Argon2id password storage, login/logout sessions, CSRF-protected dashboard mutations, admin user creation, vault creation, browser connection requests, device tokens, multipart push, multipart pull, events, conflicts, and health checks.
- Phase 1 admin lifecycle APIs for redacted account listing, user disable/re-enable, admin grant/revoke with final-admin protection, one-time password reset tokens, failed-login backoff, and individual device revocation. User disable and device revocation immediately invalidate the affected dashboard sessions, approved connections, and device tokens.
- Dashboard sessions use a browser-compatible `obts_session` cookie for HTTP/dev deployments and the hardened `__Host-obts_session` Secure cookie when `publicBaseUrl` is HTTPS.
- Recent-auth enforcement covers sensitive dashboard mutations such as browser connection approval and admin account creation. Connection completion preserves the approved device name and vault selection when registering a device.
- Multipart sync manifests reject non-commit ref strings and malformed SHA-256 packfile digests before Git ref mutation logic runs.
- Uploaded packfiles are unpacked into a temporary quarantine repo for commit,
  path-policy, ancestry, and blob-size validation. Only accepted
  uploads are imported into the durable per-vault Git store before refs advance.
- Per-vault native Git stores under `OBTS_DATA_DIR/git`, with server-authored empty-tree root commits on `refs/heads/main`.
- Protected device refs at `refs/obts/devices/{device_id}` with no-op, fast-forward, stale-ref, malformed-pack, path-policy, and same-device non-fast-forward handling.
- Every paired device syncs the same full-vault content set after hard exclusions.
- Shared client/server path policy rejects internal state, visible Git directories, traversal, empty path segments, NUL/control characters, unsupported Git tree modes, and hard-excluded paths such as `.obsidian/cache/**`, workspace files, and `.obsidian/plugins/obts/**`. OS-specific filename limits are treated as device capability issues instead of global server rejections.
- Full-vault sync includes `.trash/**`, attachments, community plugin files, and other `.obsidian/**` state that passes the hard path policy.
- Server-side automatic merge for disjoint path changes, clean native Git merges of overlapping Markdown, and conservative semantic merges for safe overlapping JSON Canvas and Obsidian Bases files even when line-based Git merge cannot cleanly merge the compact source text. Merge decisions include deterministic Canvas JSON output, deterministic Bases YAML output, durable operation records, blocked-device rejection, and durable conflict records with validator results for unsafe overlapping or file/directory hierarchy-collision changes.
- Same-path binary and attachment edits merge automatically only when the accepted server version and uploaded device version have identical blob content; otherwise they remain review-needed conflicts.
- Merge operations persist the exact target commit and target ref in the prepared operation manifest before advancing `refs/heads/main`; live readiness recognizes that bounded prepared transition instead of falsely blocking between the ref and metadata writes. Startup reconciliation aborts unprepared writes, rolls forward prepared writes whose Git refs already moved, resumes merged-or-conflicted processing for recovered device ref updates, and marks stale or unreconcilable vault state as `blocked_integrity`.
- Vault event polling retains 30 days or 100,000 events per vault, returns `410 event_cursor_expired` when a client cursor predates retained history, and includes the current and oldest available event cursors in the redacted error details. Local state tracks seen and durably applied event cursors separately, and the server advances `last_applied_main` only through an explicit post-apply acknowledgement.
- Paired devices can poll the same redacted vault event stream through
  `GET /api/v1/vaults/{vault_id}/sync/events` with their device token, so the
  plugin can observe `main_advanced`, conflict, rejection, and recovery events
  without a dashboard session cookie.
- Plugin-side `.obts/` state with `isomorphic-git`, device token storage, durable watcher change hints, queue state, explicit directory-intent state for empty folder creation/deletion, recovery bundles with file snapshots, text patches, local-only Git refs packs, and artifact checksums, local apply lock, apply journal, local commit creation, device-token metadata rehydration when `state.json` is lost, multipart push, multipart pull, safe apply, safe incomplete-journal replay with recovery blocking when replay is unsafe, explicit replace-local-with-server recovery, and explicit rebuild from current server `main`.
- One sync decision performs one coherent pre-sync content snapshot, revalidates only queued/affected state around pull, and labels its single post-apply preservation snapshot as verification instead of repeating full-vault `Checking` passes. Folder tombstones prune pre-existing empty descendants deepest-first with non-recursive removals, so stale shells are not re-uploaded as local creations while concurrent new folders and files remain protected. Directory intents use stable IDs and generations, record delete-then-create provenance, and clear only the exact generation covered by a successful upload. If a legacy or reloaded client advanced local refs without server acknowledgement, timestamp ordering is diagnostic only: absent stale intents can clear automatically, while indistinguishable existing directories require an explicit keep-local or accept-server decision.
- Long local operations retain `Checking`, `Preparing upload`, or `Applying`, report device status every 30 seconds, and surface a taking-longer detail; only transport unavailability produces `Offline`.
- Uploads preflight server vault status before object planning, preserve permanent rejection codes, back off transient retries, cache repeated plans, and pack only commits plus changed tree/blob objects relative to acknowledged bases. Large deletion packs therefore scale with retained/changed structure rather than deleted content history.
- Validated operator integrity repair is advertised through device-status responses; clients blocked specifically on `blocked_integrity` automatically clear that local block, record a fresh scan hint, and resume without reset or reconnect.
- Large-vault file checks, recovery staging, validation, directory traversal, and dependency-safe apply batches use bounded concurrency. Active source buffers are budgeted at 64 MiB on desktop and 16 MiB on mobile. The Git/DataAdapter APIs return whole blobs and expose target size only after reading, so apply peak memory may additionally include one producer-held target blob; the concurrency cap prevents multiple unbudgeted producer blobs, and oversized writes become exclusive once their size is known.
- Rebuild classifies repeated, same-device fast-forward, snapshot-only, and divergent local history: fast-forward commits stay queued, snapshot-only edits become a new recovery commit based on rebuilt `main`, and divergent same-device history blocks for export plus reset or reconnect.
- Plugin sync records server-created conflicts as a local `Review needed` blocking state, so later automatic sync or pull/apply attempts stop before replacing local review content.
- The sync pull API also rejects devices marked `review_needed` or `blocked_recovery`, so a stale or reset plugin cannot bypass server-known conflict/recovery blocks and apply server state over review content.
- Authenticated API status summary for vault/device/conflict health; Phase 1
  exposes browser-assisted onboarding through the dashboard while retaining CLI workflows for setup, vault, device, conflict, and health inspection.
- Dashboard device behind/synced state is derived from fresh client convergence reports and each device's acknowledged `last_applied_main` commit cursor; both `idle` and the legacy terminal `merged` queue state are settled. The SPA refreshes this server-derived state every 15 seconds while visible and on focus instead of ageing cached rows locally.
- Safe browser onboarding applies and acknowledges the current server `main` immediately, so an empty or already-matching paired device appears Synced before the next manual sync command.
- Readiness checks that fail closed when metadata, Git refs, conflict commits, writable storage, or native Git readiness are inconsistent.

The Phase 1 server uses a durable JSON metadata adapter in `OBTS_DATA_DIR/metadata/phase1.json` so the product slice can run without requiring a local Postgres service in this repository. The service boundaries are deliberately named around metadata and sync operations so a Postgres adapter can replace the file adapter without changing the Git sync model.

Conflict package rendering, manual resolution, note history, restore, and rendered diff UI are intentionally not implemented; those are Phase 2 and later PRD slices.

## Acceptance Coverage

The Vitest suite in `tests/phase1.test.ts` proves:

- first-run setup is one-time, liveness/readiness health endpoints work, and
  new vaults create a real empty-tree `refs/heads/main` commit immediately;
- Phase 1 CLI commands can set up an admin, create a vault, list devices, list conflicts, inspect readiness, create a local
  admin recovery token from persistent state, and create a recovery admin only
  when no enabled admin account remains;
- two paired devices sync non-conflicting vault changes through server `main`;
- dashboard passwords are stored as Argon2id hashes using the PRD v1 minimum parameters;
- repeated failed dashboard logins are audited and rate-limited by account plus source IP;
- sensitive admin account creation requires recent dashboard authentication;
- admin lifecycle mutations require recent dashboard authentication, preserve one enabled admin, expose only account metadata plus owned-vault counts, and immediately revoke disabled users' auth state;
- individual device revocation immediately rejects subsequent device-token sync requests;
- device push and pull both use multipart manifests with Git packfile parts;
- malformed commit IDs in multipart sync manifests are rejected before Git ref mutation;
- hidden Git state is under `.obts/`, with no visible vault `.git`;
- first-device import of existing local content creates a recovery bundle and requires confirmation;
- empty or already-matching paired devices acknowledge the current server `main`
  immediately and appear Synced without needing a later manual sync;
- watcher change hints and directory-intent scans for syncable vault paths survive plugin restart and are consumed by the next normal Git-backed sync scan, while internal `.obts` and visible `.git` paths are ignored;
- unchanged watcher hints converge back to an idle queue, frequent event polling avoids full-vault rescans, and repeated already-materialized directory state remains a no-op;
- plugin state surfaces `Uploading` during queued push attempts and `Applying`
  while pulled server `main` is being materialized locally;
- divergent additional-device local content is committed as that actor device's proposal, optionally using current server `main` as `base_commit`, and the server either merges it or records a conflict without adopting another device ref;
- connection secrets are short-lived, scoped to one request, and cannot register multiple devices;
- replace-local-with-server recovers and safely materializes file/directory collisions, including local directories that must be replaced by server files;
- partial or already-connected local `.obts/` state blocks onboarding before a browser connection is started;
- clean overlapping Markdown edits merge through native Git before conflict creation;
- Markdown merges with concurrent same-key frontmatter edits are rejected as conflicts even when Git can produce a clean text merge;
- compact same-file JSON Canvas edits with disjoint semantic fields merge deterministically when native Git reports a text conflict, while same-field Canvas edits create a durable conflict;
- lost `state.json` with a valid device token and intact local Git refs is repaired automatically, preserving filesystem-as-source-of-truth semantics and uploading edits through the device ref;
- Git-safe Obsidian paths with punctuation or case distinctions are synced when the local adapter can represent them;
- explicit empty folder creation and folder delete tombstones sync as Obsidian directory metadata outside the Git file tree; tombstones remove deeply nested empty hierarchies without resurrection, use only non-recursive empty-directory removals, and never recursively delete non-empty local content;
- safe same-file Obsidian Bases edits merge through the semantic Bases validator, including compact YAML that native Git cannot merge cleanly, while unsafe same-field Bases edits create a durable conflict;
- same-path binary attachment edits auto-merge only when object identity matches;
- unsafe concurrent same-path edits and file/directory hierarchy collisions create a durable conflict record and do not overwrite current `main`;
- a device with an open server conflict blocks subsequent local sync and pull/apply before local review content is replaced;
- devices with open conflicts cannot upload newer commits until recovery or conflict review is completed;
- retried uploads whose device ref already advanced but whose commit is not yet in `main` resume merge evaluation instead of becoming a false no-op;
- uploaded commits that introduce invalid or hard-excluded paths are rejected before refs advance;
- authenticated sync rejections append redacted `device_sync_rejected` events for dashboard/event polling;
- paired devices can poll redacted vault events through device-token auth, receive
  `main_advanced` after another device advances server `main`, and receive the
  same `410 event_cursor_expired` retained-history signal as dashboard polling;
- dashboard device status uses acknowledged commit cursors, not `last_successful_sync_at`, to decide whether a device is Behind or Synced;
- uploaded files larger than the configured byte limit are rejected before refs advance;
- a third device receives the safe current `main` while a conflict remains open;
- cross-user access to vault main, dashboard, conflicts, device sync push/pull,
  and events returns `404`;
- restored metadata that points at missing Git state makes `/health/ready` return `503` and surfaces a not-ready dashboard health summary;
- prepared sync operations remain readiness-safe during the live ref-to-metadata commit window and recover deterministically on restart when Git refs already moved, resume pending device ref merges, or abort safely before ref mutation;
- integrity-blocked uploads stop before pack planning, preserve their queued commits and permanent error, then resume from a fresh scan after validated repair;
- event polling returns `410` for expired cursors after retention pruning;
- incomplete apply journals replay idempotently on restart when the target commit is present and affected files still match preflight or target content; version 3 journals also replay nested directory tombstones, explicit directory materialization, event acknowledgement, and concurrent empty-folder preservation before advancing refs, and remain durable through post-apply preservation queueing before cleanup;
- legacy local Git ref lock files are removed only after an age threshold and validation that their target is valid history descending from the current ref; new ref updates use nonce-owned lease and staging paths that are never reused as legacy lock paths, while ambiguous ages, ownership, or ancestry fail closed with a specific recovery error;
- legacy directory ambiguity creates `.obts/directory-recovery.json` without changing pending intents, exposes per-subtree keep-local and accept-server choices in settings, archives the confirmed empty-directory manifest before mutation, revalidates identities and file fingerprints, and resumes an approved decision after restart;
- metadata schema v5 persists each device's acknowledged event cursor and explicit-directory snapshot independently of the bounded event-polling log; migrations reconstruct snapshots only from complete retained history or current authoritative state and otherwise mark recovery ambiguous;
- unreplayable apply journals block sync on restart instead of attempting an unsafe apply;
- committed apply journals replay idempotently on restart and clear stale local apply locks;
- local apply lock contention blocks before a destructive pull apply starts;
- recovery bundle creation failures leave a blocked apply journal and do not write files;
- recovery bundles written before destructive apply contain affected file snapshots, text patch artifacts, checksums, and only Git objects not already reachable from the recorded prior local `main`; clean devices produce an empty refs pack;
- rebuild from server `main` preserves queued fast-forward commits, turns snapshot-only local edits into a recovery commit, and refuses to upload divergent same-device history;
- files changed after apply preflight block before overwrite;
- shared path policy rejects `.obts/`, visible `.git`, traversal, empty path segments, NUL/control characters, unapproved `.obsidian` files, and non-regular Git tree entries while leaving OS-specific filename limits to device capability handling.
