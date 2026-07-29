# Obsidian True Sync Architecture

The architecture model started as a PRD-derived skeleton. The repository now
contains a Phase 1 TypeScript implementation for "Sync Without Conflict
Resolution": a Fastify server, shared contracts/path policy, a plugin-side
sync client, a minimal dashboard shell, OpenAPI contract, and Vitest coverage.

The Phase 1 server keeps the Git history model from the PRD: one canonical
`refs/heads/main` per vault and protected per-device refs under
`refs/obts/devices/{device_id}`. Metadata is persisted by the Phase 1 file
adapter under `OBTS_DATA_DIR/metadata/phase1.json`; the service boundary is
kept narrow so a Postgres adapter can replace it without changing the sync
model.

The product model syncs the full vault for every paired device. Server `main`
contains the canonical full-vault state, while each device ref remains a
whole-tree Git ref for that device's last accepted state. The shared global
safety policy excludes `.obts/**`, visible `.git/**`, `.obsidian/cache/**`,
`.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and
`.obsidian/plugins/obts/**`; `.trash/**`, attachments, community plugin files,
and other `.obsidian/**` files are normal synced vault content. OS-specific
filename limits are handled as device capability/apply problems instead of
server-wide vault rejections.

Empty directories are represented outside Git. The plugin records causal
Obsidian directory proposals under `.obts/directory-state.json`; uploads preserve
stable proposal/intent identity and the acknowledged main/event baseline. The
server classifies directory overlap before advancing canonical state, merges safe
operations automatically, and routes directory or mixed ambiguity to dashboard
conflicts. Pull/apply receives only accepted directory deltas and the current
explicit set, creates missing empty folders, and removes tombstoned folders only
through non-recursive empty-directory operations. A stale directory proposal
baseline is repaired causally rather than treated as local corruption: the
plugin journals and protects queued history, proves the server-acknowledged
baseline is an ancestor of already-materialized local main, retrieves the
historical authoritative directory snapshot, advances only that acknowledgement,
and rebuilds effective intents. Invalid ancestry or unavailable history fails
closed without writing visible files.

Local change detection is watcher-first. The durable queue stores invalidated
paths; `.obts/scan-cache.json` pairs reliable filesystem identity metadata with
Git blob OIDs so reconciliation rereads only invalidated or metadata-changed
files. `.obts/scan-state.json` persists the scanner schema, local cursor,
directory generation, inventory watermark, and next complete-audit deadline
across plugin reloads. Idle metadata inventory runs at a six-hour fallback
cadence, while complete byte-level verification runs weekly or through the
explicit verify command. A converged pre-watermark client may seed cache metadata
only when its visible path set exactly equals trusted local Git, with a complete
audit scheduled within 24 hours.

Large uploads are immutable durable proposals. The plugin stores the target,
directory proposal, object plan, attempt ID, and server transfer ID in
`.obts/upload-transfer.json` and retrieves an existing processing or terminal
outcome before scanning later edits. The server durably receives bounded chunks,
returns prompt asynchronous finalization, retries internal processing failures
with durable bounded backoff, and fairly serializes canonical integration per
vault. Movement of `main` changes the merge input rather than
invalidating accepted bytes; ancestry-safe device-ref movement is accepted, and
genuine same-device divergence becomes protected conflict history.

Server large-tree operations remain object-level. Tree paths and blob sizes are
validated in a batched Git listing; clean disjoint merges use an explicit-base
temporary Git index with `read-tree` and `write-tree`, compatible with the
production Git 2.39 baseline. Plaintext temporary worktrees are reserved for
overlapping content that requires semantic validation.

At-rest protection follows the current PRD: persistent server state is normal
sensitive application state protected by deployment-managed storage controls.
The implementation does not claim app-level encrypted persistence.

Key architectural constraints:

- The server maintains canonical Git and explicit-directory state and owns every semantic conflict decision.
- Clients upload device commits and never advance `main` directly.
- Every paired device syncs the same full-vault content set after hard
  exclusions.
- The server is trusted to read vault content for sync, merge, conflict
  signaling, backup, and recovery.
- Deployment-managed permissions, disk/volume encryption, snapshots, and backup
  controls protect server persistent state at rest.
- Account and vault authorization prevent users from reading each other's notes.
- Default errors and events avoid raw tokens, Git pack data, blobs, and note
  bodies.
- `.obts/` is client-local runtime state and is excluded from vault sync; recovery journals never become a client-side winner-selection UI.
- Watcher hints drive normal local sync; bounded inventory and complete hashing are fallback integrity mechanisms, not ten-second or per-reload work.
- Internal history exists only under the server Git store and `.obts/git`; no
  visible vault `.git` directory is created.
