# Phase 1 Implementation

This repository now contains the first vertical sync slice from `prd.md`:
Sync Without Conflict Resolution.

Implemented runtime pieces:

- TypeScript package with build, type-check, and Vitest commands.
- Shared API types, status labels, validation helpers, and vault path policy.
- Committed OpenAPI 3.1 contract at `openapi/openapi.yaml`.
- Fastify server with first-run setup, Argon2id password storage, login sessions, CSRF-protected dashboard mutations, admin user creation, vault creation, pairing tokens, device tokens, multipart push, multipart pull, events, conflicts, and health checks.
- Recent-auth enforcement covers sensitive Phase 1 dashboard mutations such as pairing token creation and admin account creation.
- Multipart sync manifests reject non-commit ref strings and malformed SHA-256 packfile digests before Git ref mutation logic runs.
- Uploaded packfiles and individual Git blobs are checked against the configured upload byte limit before refs advance.
- Per-vault native Git stores under `OBTS_DATA_DIR/git`, with server-authored empty-tree root commits on `refs/heads/main`.
- Protected device refs at `refs/obts/devices/{device_id}` with no-op, fast-forward, stale-ref, malformed-pack, path-policy, and same-device non-fast-forward handling.
- Pairing stores the device sync profile and plugin-sync setting, and server-side upload validation rejects changed paths outside that paired policy while preserving inherited server tree entries.
- Shared client/server path policy rejects internal state, visible Git directories, traversal, empty path segments, cross-platform-invalid names, case-fold collisions, unsupported Git tree modes, and `.obsidian` files outside the explicit sync profile.
- Server-side automatic merge for disjoint path changes and clean native Git merges of overlapping Markdown-style note files, durable merge decision operation records, blocked-device rejection, and durable conflict records for unsafe overlapping or file/directory hierarchy-collision changes.
- Plugin-side `.obts/` state with `isomorphic-git`, device token storage, queue state, recovery bundles, local apply lock, apply journal, local commit creation, multipart push, multipart pull, safe apply, incomplete-journal blocking, and explicit replace-local-with-server recovery.
- Minimal dashboard shell and dashboard summary API.
- Readiness checks that fail closed when metadata, Git refs, conflict commits, writable storage, or native Git readiness are inconsistent.

The Phase 1 server uses a durable JSON metadata adapter in `OBTS_DATA_DIR/metadata/phase1.json` so the product slice can run without requiring a local Postgres service in this repository. The service boundaries are deliberately named around metadata and sync operations so a Postgres adapter can replace the file adapter without changing the Git sync model.

Conflict package rendering, manual resolution, note history, restore, and rendered diff UI are intentionally not implemented; those are Phase 2 and later PRD slices.

## Acceptance Coverage

The Vitest suite in `tests/phase1.test.ts` proves:

- two paired devices sync non-conflicting vault changes through server `main`;
- dashboard passwords are stored as Argon2id hashes using the PRD v1 minimum parameters;
- sensitive admin account creation requires recent dashboard authentication;
- device push and pull both use multipart manifests with Git packfile parts;
- malformed commit IDs in multipart sync manifests are rejected before Git ref mutation;
- hidden Git state is under `.obts/`, with no visible vault `.git`;
- first-device import of existing local content creates a recovery bundle and requires confirmation;
- divergent additional-device local content creates a recovery bundle, blocks normal sync, and requires explicit replace-local-with-server before destructive apply, even when current server `main` is still the empty root;
- pairing tokens are scoped to their issued sync profile and cannot be consumed twice;
- replace-local-with-server recovers and safely materializes file/directory collisions, including local directories that must be replaced by server files;
- partial or already-paired local `.obts/` state blocks pairing before a one-time pairing token is consumed;
- clean overlapping Markdown edits merge through native Git before conflict creation;
- unsafe concurrent same-path edits and file/directory hierarchy collisions create a durable conflict record and do not overwrite current `main`;
- devices with open conflicts cannot upload newer commits until recovery or conflict review is completed;
- retried uploads whose device ref already advanced but whose commit is not yet in `main` resume merge evaluation instead of becoming a false no-op;
- uploaded commits that introduce paths outside the paired device's sync profile are rejected before refs advance;
- uploaded files larger than the configured byte limit are rejected before refs advance;
- a third device receives the safe current `main` while a conflict remains open;
- cross-user access to vault main, conflicts, and events returns `404`;
- restored metadata that points at missing Git state makes `/health/ready` return `503`;
- incomplete apply journals block sync on restart instead of attempting an unsafe apply;
- local apply lock contention blocks before a destructive pull apply starts;
- recovery bundle creation failures leave a blocked apply journal and do not write files;
- files changed after apply preflight block before overwrite;
- shared path policy rejects `.obts/`, visible `.git`, traversal, empty path segments, cross-platform-invalid names, case-fold collisions, unapproved `.obsidian` files, and non-regular Git tree entries.
