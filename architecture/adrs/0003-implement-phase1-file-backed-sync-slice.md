# 3. Implement Phase 1 file-backed sync slice

Date: 2026-06-29

## Status

Accepted

## Context

`prd.md` defines Phase 1 as "Sync Without Conflict Resolution": pair devices,
move vault changes through Git-backed server state, auto-merge safe changes, and
create durable conflict records when human judgment is required.

The repository did not previously contain an executable implementation or a
local Postgres test fixture.

## Decision

Implement Phase 1 as a TypeScript package:

- Fastify server APIs and a committed OpenAPI 3.1 contract;
- native Git CLI per-vault server stores;
- a durable JSON metadata adapter under `OBTS_DATA_DIR/metadata/phase1.json`;
- plugin-side hidden Git state under `.obts/git` using `isomorphic-git`;
- recovery bundles and apply journals under `.obts/`;
- Vitest end-to-end acceptance coverage for pairing, sync, conflicts, and
  cross-user authorization.

The metadata adapter is an implementation adapter, not the sync model. It keeps
the same vault, device, token, sync operation, conflict, event, and audit
records expected by a future Postgres adapter.

## Consequences

The repository can run and test the full Phase 1 user-facing workflow without a
database service. A production Postgres adapter remains future work before the
full v1 storage contract is complete.

At-rest protection remains deployment-managed, matching the current PRD.
