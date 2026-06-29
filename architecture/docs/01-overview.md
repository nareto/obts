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

At-rest protection follows the current PRD: persistent server state is normal
sensitive application state protected by deployment-managed storage controls.
The implementation does not claim app-level encrypted persistence.

Key architectural constraints:

- The server maintains the canonical `main` vault state.
- Clients upload device commits and never advance `main` directly.
- The server is trusted to read vault content for sync, merge, conflict
  signaling, backup, and recovery.
- Deployment-managed permissions, disk/volume encryption, snapshots, and backup
  controls protect server persistent state at rest.
- Account and vault authorization prevent users from reading each other's notes.
- Default errors and events avoid raw tokens, Git pack data, blobs, and note
  bodies.
- `.obts/` is client-local runtime state and is excluded from vault sync.
- Internal history exists only under the server Git store and `.obts/git`; no
  visible vault `.git` directory is created.
