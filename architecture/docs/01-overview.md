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
through non-recursive empty-directory operations.

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
- Internal history exists only under the server Git store and `.obts/git`; no
  visible vault `.git` directory is created.
