# Obsidian True Sync Architecture

This architecture model is derived from `prd.md` because the repository currently contains no implementation, executable configuration, package manifests, or tests.

The model captures the v1 trusted-server architecture described by the PRD: a self-hosted server, an Obsidian plugin, a browser dashboard, Postgres metadata, encrypted-at-rest content storage, internal history, and a temporary plaintext merge workspace. It should be re-inventoried against source code as soon as implementation files are added.

Key architectural constraints:

- The server maintains the canonical `main` vault state.
- Clients upload proposals and never advance `main` directly.
- The server is trusted to decrypt vault content for sync, merge, conflict review, backup, and recovery.
- Persistent server-side vault content is encrypted at rest with per-vault data keys wrapped by server master key material.
- Account and vault authorization prevent users from reading each other's notes.
- Default logs and diagnostics avoid raw tokens, passwords, key material, and full note bodies.
- `.obts/` is client-local runtime state and is excluded from vault sync.
- Internal history exists only on the server and is never exposed as a visible vault `.git` directory.
