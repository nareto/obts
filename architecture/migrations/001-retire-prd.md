# Retire The Proof-Of-Concept PRD

- Date: 2026-08-12
- Architecture revision: 1
- Removed artifact: `prd.md`

## Decision

The root PRD is retired rather than maintained beside the implemented system. It was valuable for proof-of-concept framing and phased construction, but it mixed product intent, architecture, API details, UI styling, implementation plans, and verification in one file. That mixture had become stale and created ambiguous authority.

Current normative claims were reconciled into the architecture authority described by `architecture/README.md`. Git history preserves the original document; no archived copy remains in the active tree.

## Reconciliation Ledger

| Former PRD area | Disposition | Current authority |
| --- | --- | --- |
| Executive summary, audience, goals, non-goals | Current, condensed | `contracts/product.md` |
| Trusted-server security model and multi-user single-owner isolation | Current | `contracts/security.md`, ADR 0002 |
| Application-managed per-vault encryption | Contradicted and removed | ADR 0002; `contracts/security.md` |
| Logging, diagnostics, redaction | Current | `contracts/security.md` |
| Server installation and operational commands | Operational, not duplicated | `README.md`, `docs/*-operations.md`, CLI help |
| Browser-assisted onboarding | Current | `contracts/sync.md`, OpenAPI |
| Local edit, watcher, scan, upload, pull, apply, and recovery behavior | Current | `contracts/safety.md`, `contracts/sync.md`, ADRs 0005–0006 |
| Directory intent and conflict behavior | Current | `contracts/safety.md`, `contracts/sync.md`, ADR 0004 |
| Conflict review, history, restore, maintenance | Current | `contracts/sync.md`, `contracts/dashboard.md`, OpenAPI |
| Dashboard layout, status vocabulary, and interaction constraints | Current where behaviorally significant; exact styling is implementation-level | `contracts/dashboard.md`, dashboard source |
| Runtime containers and components | Current allocation refreshed from implementation, including Bridge | `models/system-overview.md`, `workspace.dsl` |
| Identifiers, route shapes, request/response schemas | Executable contract | `openapi/openapi.yaml`, shared types |
| Metadata table sketches | Obsolete as normative schema; file adapter and Bridge PostgreSQL have distinct implemented state | `contracts/persistence.md`, metadata/migration source |
| Git persistence and durable write workflow | Current | `contracts/persistence.md`, `contracts/sync.md`, ADR 0005 |
| Path and filesystem policy | Current | `contracts/sync.md`, shared path policy |
| Auth/session/token policy | Current except password re-entry UX | `contracts/security.md`, OpenAPI; implementation migration tracked in Forgejo issue 18 |
| Environment variable list and defaults | Operational/executable | CLI help, `src/server/config.ts`, operations docs |
| Plugin settings and local credential placement | Current | `contracts/security.md`, `contracts/sync.md` |
| Phase 1/2/3 delivery plan | Completed historical plan; not a current specification | historical `docs/phase*.md`, Git history |
| Test inventory and manual acceptance | Current intent, reorganized around assurance | `contracts/verification.md`, tests, smoke-test docs |
| Alternatives | Preserved where decision-relevant | ADRs and `contracts/product.md` non-goals |
| Agent guardrails | Current policy moved to project instructions and authority map | `AGENTS.md`, `architecture/README.md` |

## Known Reconciliation Gaps

Architecture revision 1 intentionally establishes desired authenticated-session confirmation behavior before the implementation migration. Forgejo issue 18 tracks removal of recent password re-entry; issue 14 tracks typed-confirmed vault deletion; issue 17 tracks persisted vault selection; issue 13 tracks complete server/device conflict provenance; issue 20 explores conflict-resolution reversal. Until implemented, these are explicit implementation defects/gaps rather than reasons to preserve the stale PRD.

The formal-model directory contains policy only. No TLA+/PlusCal model is accepted at revision 1.
