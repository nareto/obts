# OBTS Architecture Authority

This directory is the source of truth for OBTS product boundaries, safety properties, system behavior, architectural allocation, and accepted design decisions. The former root `prd.md` was a proof-of-concept planning artifact and was retired after its current requirements were reconciled into this directory.

## Authority Map

| Artifact | Authority |
| --- | --- |
| `contracts/*.md` | Normative product behavior, safety, security, persistence, dashboard, and verification contracts |
| `models/*.md` | Normative state ownership, lifecycle, and interaction models |
| `workspace.dsl` | Authored C4 structure and relationships |
| `adrs/*.md` | Accepted and superseded architectural decisions and their rationale |
| `openapi/openapi.yaml` | Executable current HTTP shape, schema, and error contract; semantic deviations from normative contracts must be annotated and tracked |
| `manifest.yaml` | Monotonic architecture revision and complete authoritative-artifact inventory |
| `DIAGRAMS.md`, `export/*` | Generated views; never edit directly |
| `migrations/*.md` | Immutable reconciliation records for authority migrations; entries may be superseded by a new revision but not silently rewritten |
| `docs/*` outside this directory | Operational procedures and historical phase notes derived from the architecture, not competing specifications |
| Production code and tests | Implementation and evidence; they do not silently redefine the contracts |

Normative behavior is owned by `contracts/*.md`; OpenAPI is authoritative for the currently executable HTTP surface. When OpenAPI temporarily realizes behavior that conflicts with a normative contract, the affected operation must carry an explicit architecture-deviation annotation linked to its migration issue. Unannotated disagreements are defects: identify whether the discrepancy is an implementation defect, stale model, obsolete decision, or unapproved product change and reconcile it explicitly, normally with an ADR when ownership, protocol, trust, or lifecycle semantics change.

## Contract Set

- [`contracts/product.md`](contracts/product.md): purpose, actors, supported boundary, and non-goals.
- [`contracts/safety.md`](contracts/safety.md): local-change preservation invariant, safety properties, and fault model.
- [`contracts/sync.md`](contracts/sync.md): Git/device proposal protocol, merge, conflict, directory, history, and path behavior.
- [`contracts/security.md`](contracts/security.md): trust boundary, account isolation, authentication, authorization, and redaction.
- [`contracts/persistence.md`](contracts/persistence.md): authoritative state, write atomicity, recovery, backup, and maintenance.
- [`contracts/dashboard.md`](contracts/dashboard.md): dashboard information architecture, status vocabulary, and consequential workflows.
- [`contracts/verification.md`](contracts/verification.md): required evidence, fault tests, real-device proof, and release assurance.
- [`models/system-overview.md`](models/system-overview.md): current runtime allocation and state ownership.
- [`models/formal/README.md`](models/formal/README.md): bounded formal-model policy and the accepted `OBTS-FM-001` local apply/recovery and `OBTS-FM-002` composed distributed models.
- [`../openapi/openapi.yaml`](../openapi/openapi.yaml): executable HTTP shape, schema, and error contract.

## Architecture Revision

`manifest.yaml` contains one monotonic `revision` for the complete authoritative architecture. Independent document versions would imply false precision and make cross-document changes harder to track.

A commit must increment the architecture revision by exactly one when it changes the authority map, any authoritative contract, model, ADR, authored C4 source, or the executable OpenAPI contract. Generated diagram updates do not count independently.

A code-bearing push must do one of two things:

1. update the affected architecture and increment the revision; or
2. include the exact commit trailer `Architecture-Impact: none` to acknowledge that the architecture was reviewed and remains valid.

The acknowledgement is commit-local: an unrelated architecture update elsewhere in the same push does not excuse a code commit. The trailer is an explicit review claim, not a bypass for behavior, ownership, trust, persistence, protocol, or failure-semantics changes.

The installed pre-push hook can reject a nonconforming local push before ref movement. Forgejo Actions runs the same check after every push as a visible audit; a post-push workflow cannot undo or reject a direct push. Mechanical server-side rejection would require a protected workflow or pre-receive policy, which is outside this repository. Neither mechanism proves semantic synchronization.

Future TLA+ files live under `models/formal/`, refine named contract IDs, and declare the architecture revision they implement. They are analysis artifacts inside this authority system, not a parallel source of product behavior.

## Change Classification

- **Implementation defect:** code changes to satisfy an existing contract; update architecture only if the current model is incomplete or misleading.
- **Refactor:** behavior and architecture remain unchanged; use `Architecture-Impact: none` after review.
- **Contract change:** update contracts, affected models, ADRs when needed, verification obligations, and the revision.
- **Architecture change:** update ownership/allocation models, contracts affected by the change, ADRs, and the revision.
- **Executable-contract change:** update OpenAPI and any semantic contract it realizes in the same change.
- **Operational-only change:** procedures may change without a revision only when product, architecture, and failure semantics remain unchanged.

## Generated Views

Run:

```sh
architecture/tools/render_diagrams.sh
```

The command validates `workspace.dsl` and regenerates `DIAGRAMS.md` and `export/*`. Do not edit those outputs manually.
