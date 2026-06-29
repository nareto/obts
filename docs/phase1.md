# Phase 1 Implementation

This repository now contains the first vertical sync slice from `prd.md`:
Sync Without Conflict Resolution.

Implemented runtime pieces:

- TypeScript package with build, type-check, and Vitest commands.
- Shared API types, status labels, validation helpers, and vault path policy.
- Committed OpenAPI 3.1 contract at `openapi/openapi.yaml`.
- Fastify server with first-run setup, login sessions, CSRF-protected dashboard mutations, admin user creation, vault creation, pairing tokens, device tokens, push, pull, events, conflicts, and health checks.
- Per-vault native Git stores under `OBTS_DATA_DIR/git`, with server-authored empty-tree root commits on `refs/heads/main`.
- Protected device refs at `refs/obts/devices/{device_id}` with no-op, fast-forward, stale-ref, malformed-pack, path-policy, and same-device non-fast-forward handling.
- Server-side automatic merge for disjoint path changes and durable conflict records for unsafe overlapping changes.
- Plugin-side `.obts/` state with `isomorphic-git`, device token storage, queue state, recovery bundles, apply journal, local commit creation, multipart push, multipart pull, and safe apply.
- Minimal dashboard shell and dashboard summary API.

The Phase 1 server uses a durable JSON metadata adapter in `OBTS_DATA_DIR/metadata/phase1.json` so the product slice can run without requiring a local Postgres service in this repository. The service boundaries are deliberately named around metadata and sync operations so a Postgres adapter can replace the file adapter without changing the Git sync model.

Conflict package rendering, manual resolution, note history, restore, and rendered diff UI are intentionally not implemented; those are Phase 2 and later PRD slices.

## Acceptance Coverage

The Vitest suite in `tests/phase1.test.ts` proves:

- two paired devices sync non-conflicting vault changes through server `main`;
- hidden Git state is under `.obts/`, with no visible vault `.git`;
- first-device import of existing local content creates a recovery bundle and requires confirmation;
- concurrent same-path edits create a durable conflict record and do not overwrite current `main`;
- a third device receives the safe current `main` while a conflict remains open;
- cross-user access to vault main, conflicts, and events returns `404`;
- shared path policy rejects `.obts/`, visible `.git`, and case-fold collisions.
