# OBTS Architecture Authority

This directory is the source of truth for OBTS product boundaries, safety properties, system behavior, architectural allocation, and accepted design decisions. The former root `prd.md` was a proof-of-concept planning artifact and was retired after its current requirements were reconciled into this directory.

## Authority Map

| Artifact | Authority |
| --- | --- |
| `contracts/*.md` | Normative product behavior, safety, security, persistence, dashboard, and verification contracts |
| `models/*.md` | Normative state ownership, lifecycle, and interaction models |
| `workspace.dsl` | Authored C4 structure and relationships |
| `adrs/*.md` | Accepted and superseded architectural decisions and their rationale |
| `openapi/openapi.yaml` | Executable current OBTS server HTTP shape, schema, and error contract; semantic deviations from normative contracts must be annotated and tracked |
| `crates/obts-bridge/src/api_docs.rs` | Executable OBTS Bridge REST shape served at `/openapi.json`; semantic deviations from normative contracts must be annotated and tracked |
| `crates/obts-bridge/config/mcp_tools.yaml` | Executable OBTS Bridge MCP tool shape and descriptions |
| `manifest.yaml` | Monotonic architecture revision and complete authoritative-artifact inventory |
| `DIAGRAMS.md`, `export/*` | Generated views; never edit directly |
| `migrations/*.md` | Immutable reconciliation records for authority migrations; entries may be superseded by a new revision but not silently rewritten |
| `docs/*` outside this directory | Operational procedures and historical phase notes derived from the architecture, not competing specifications |
| Production code and tests | Implementation and evidence; they do not silently redefine the contracts |

Normative behavior is owned by `contracts/*.md`; OpenAPI is authoritative for the currently executable HTTP surface. When OpenAPI temporarily realizes behavior that conflicts with a normative contract, the affected operation must carry an explicit architecture-deviation annotation linked to its migration issue. Unannotated disagreements are defects: identify whether the discrepancy is an implementation defect, stale model, obsolete decision, or unapproved product change and reconcile it explicitly, normally with an ADR when ownership, protocol, trust, or lifecycle semantics change.

## Artifact Roles And Synchronization

The contracts are the semantic hub. Other artifacts are complementary projections of those contracts and change only when their represented surface changes; they are not duplicate specifications that must all be edited mechanically.

- Authored C4 in `workspace.dsl` describes static structure: people, software systems, containers, components, responsibilities, and relationships. Update it when allocation, ownership, trust boundaries, or deployment relationships change.
- TLA+ under `models/formal/` describes bounded dynamic behavior: transitions, ordering, concurrency, retries, crashes, and recovery. Each accepted model refines named contract IDs and records its implementation and test mapping.
- The server OpenAPI and Bridge runtime OpenAPI describe their respective executable HTTP operations, schemas, and errors. The Bridge MCP catalog describes the executable tool surface. They must remain semantically consistent with the contracts or carry a tracked deviation.
- Production code realizes these artifacts, while executable tests and formal checks provide evidence. The Bridge API schema source and MCP catalog are listed separately above only as executable contracts; they do not override normative behavior. Neither other code nor a green check silently changes product semantics or proves complete implementation conformance.

The mandatory coding workflow for keeping these artifacts synchronized is defined in root [`AGENTS.md`](../AGENTS.md). This file defines what the architecture artifacts mean; `AGENTS.md` defines what an agent must do when fixing bugs, implementing features, or refactoring production behavior.

## Contract Set

- [`contracts/product.md`](contracts/product.md): purpose, actors, supported boundary, and non-goals.
- [`contracts/safety.md`](contracts/safety.md): local-change preservation invariant, safety properties, and fault model.
- [`contracts/sync.md`](contracts/sync.md): Git/device proposal protocol, merge, conflict, directory, history, and path behavior.
- [`contracts/security.md`](contracts/security.md): trust boundary, account isolation, authentication, authorization, and redaction.
- [`contracts/persistence.md`](contracts/persistence.md): authoritative state, write atomicity, recovery, backup, and maintenance.
- [`contracts/dashboard.md`](contracts/dashboard.md): dashboard information architecture, status vocabulary, and consequential workflows.
- [`contracts/verification.md`](contracts/verification.md): required evidence, fault tests, real-device proof, and release assurance.
- [`models/system-overview.md`](models/system-overview.md): current runtime allocation and state ownership.
- [`models/formal/README.md`](models/formal/README.md): bounded formal-model policy and the accepted `OBTS-FM-001` local apply/recovery, `OBTS-FM-002` composed distributed, `OBTS-FM-003` focused Bridge bounded-body projection and embedding-worker companion, `OBTS-FM-004` deletion lifecycle, and `OBTS-FM-005` Bridge external-protocol models.
- [`../openapi/openapi.yaml`](../openapi/openapi.yaml): executable OBTS server HTTP shape, schema, and error contract.
- [`../crates/obts-bridge/src/api_docs.rs`](../crates/obts-bridge/src/api_docs.rs): executable OBTS Bridge REST shape served at `/openapi.json`.
- [`../crates/obts-bridge/config/mcp_tools.yaml`](../crates/obts-bridge/config/mcp_tools.yaml): executable OBTS Bridge MCP tool shape.

## Architecture Revision

`manifest.yaml` contains one monotonic `revision` for the complete authoritative architecture. Independent document versions would imply false precision and make cross-document changes harder to track.

A commit must increment the architecture revision by exactly one when it changes the authority map, any authoritative contract, model, ADR, authored C4 source, or the executable OpenAPI contract. Generated diagram updates do not count independently.

A code-bearing push must do one of two things:

1. update the affected architecture and increment the revision; or
2. include the exact commit trailer `Architecture-Impact: none` to acknowledge that the architecture was reviewed and remains valid.

The acknowledgement is commit-local: an unrelated architecture update elsewhere in the same push does not excuse a code commit. The trailer is an explicit review claim, not a bypass for behavior, ownership, trust, persistence, protocol, or failure-semantics changes.

The installed pre-push hook can reject a nonconforming local push before ref movement. Forgejo Actions runs the same check after every push as a visible audit; a post-push workflow cannot undo or reject a direct push. Mechanical server-side rejection would require a protected workflow or pre-receive policy, which is outside this repository. Neither mechanism proves semantic synchronization.

TLA+ files live under `models/formal/`, refine named contract IDs, and declare the latest architecture revision that changed or reviewed their modeled behavior. A model revision may trail the global architecture revision when later changes do not affect that model. Formal models are analysis artifacts inside this authority system, not a parallel source of product behavior.

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
