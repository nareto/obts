# Verification And Assurance Contract

## Evidence Chain

OBTS assurance follows one traceable chain rather than parallel specification systems:

```text
architecture contract ID
  -> state/interaction model and ADR
  -> implementation boundary
  -> executable unit/property/fault/integration test
  -> copied-vault and operational evidence
```

Code does not redefine a contract because tests pass. A failed test is classified as implementation defect, executable-test defect, stale architecture, or proposed contract change before expectations are edited.

## Required Automated Evidence

- Shared path-policy, validation, authorization, redaction, and status rules.
- Local commit/import, queue, immutable transfer, apply/recovery, and directory-causality transitions.
- Server ref/metadata operation interruption at every durable boundary.
- Equal, descendant, covered, divergent, stale, duplicate, and retry outcomes.
- Merge validators for Markdown, Canvas, Bases, binary, rename, delete/edit, and hierarchy collisions.
- Conflict package, stale review, resolution, history, restore, integrity, and maintenance behavior.
- Bridge ACL, revision checking, filesystem projection, restart containment, and derived-state replay.
- OpenAPI and packaged-plugin conformance.

Property/state-machine tests should explore generated command sequences against the safety contract. Deterministic fault points should cover filesystem, Git, metadata, network, clock, process lifecycle, and response loss. Failures retain a seed or exact transition trace.

Mutation testing may be used selectively for the safety kernel. Critical mutants that skip recovery publication, advance phases early, omit preservation paths, move refs backward, acknowledge before durability, or misclassify divergence must not survive.

## Crash And Durability Evidence

In-process exception tests are not sufficient evidence for restart semantics. Safety-critical transitions require subprocess termination and restart on the same persistent state, followed by exact-byte, ref-reachability, journal, checksum, and integrity inspection.

Supported platforms require representative filesystem and application-lifecycle exercises. Mobile force-close coverage is mandatory; sudden-power-loss claims require separate storage evidence and cannot be inferred from process kill alone.

## Formal Methods

TLA+/PlusCal is an optional bounded technique inside the architecture model set. Adopt a model only when it:

- refines stable named safety contracts;
- states durability, fairness, and fault assumptions;
- remains small enough for independent review;
- records TLC configuration and explored-state evidence;
- turns useful counterexamples into executable regression tests;
- is updated or explicitly retired when its refined protocol changes.

A green model checker does not prove implementation conformance, filesystem durability, byte/path correctness, performance, or operational recovery.

## Manual And Deployment Evidence

Before trusted primary-vault use:

- run disposable-vault server/plugin smoke tests from empty state;
- validate desktop and foreground iOS/Android onboarding, offline edits, reconnect, concurrent edits, deletes, renames, conflict review, restore, and interrupted apply;
- run large-vault and long-running-operation checks within memory/resource budgets;
- restore intentionally inconsistent server backup state in isolation and confirm fail-closed readiness;
- perform a point-in-time-consistent backup/restore drill and verify every protected ref and history surface;
- complete an agreed multi-device soak with recorded rollback criteria.

OBTS Bridge requires an end-to-end deployment test that launches the server, Rust Bridge, supervised Node headless client, and PostgreSQL; pairs through the normal browser flow; proves scoped read/write and conflict behavior; kills/restarts runtimes with pending work; rebuilds the derived projection without replacing client state; and restores the authoritative client volume. Component tests alone do not satisfy this obligation.

Dashboard UI changes with consequential visual meaning use disposable local Docker deployments and Playwright. Representative real states are rendered at relevant viewport sizes, screenshots are captured and inspected, and all containers, networks, volumes, and temporary data are torn down afterward.

## Independent Review And Release Record

Safety/protocol changes receive a fresh-context review from someone or an agent that did not author the transition. Review covers the contract, assumptions, state model, persistence boundaries, fault inventory, executable evidence, and residual risks.

A release assurance record identifies the source revision, architecture revision, changed contract IDs, validation commands/results, formal-model revision/results when applicable, copied-vault/manual evidence, reviewer findings/dispositions, and known gaps. This is evidence, not a certification claim.
