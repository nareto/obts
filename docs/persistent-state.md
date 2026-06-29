# Persistent State And Backup Contract

Phase 1 persistent state lives under `OBTS_DATA_DIR` unless a deployment sets
separate directories in server configuration.

Back up these paths atomically:

- `OBTS_DATA_DIR/metadata/phase1.json`: users, sessions, vaults, devices,
  token hashes, sync operations, conflicts, events, and audit rows.
- `OBTS_DATA_DIR/git/*.git`: per-vault native Git repositories containing
  canonical `refs/heads/main`, protected device refs, commits, trees, blobs,
  and packs.
- `OBTS_DATA_DIR/tmp` only when an operator intentionally preserves recovery
  residue for investigation. Normal merge workspaces are transaction-scoped.

Backups must be point-in-time consistent across metadata and Git stores. If a
restore loses required Git state or metadata, `/health/ready` must fail closed
or the affected vault must remain blocked until operator repair.

Phase 1 does not implement application-level encrypted persistence. Offline
disclosure protection depends on deployment-managed filesystem, volume,
snapshot, or database-backup encryption and restrictive permissions. Keep those
encryption keys and storage credentials outside this repository and outside the
application state being protected.
