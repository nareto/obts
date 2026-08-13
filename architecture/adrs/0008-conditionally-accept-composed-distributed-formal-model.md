# ADR 0008: Retain The Composed Distributed Formal Model As Candidate

- Status: proposed; acceptance gate not met
- Date: 2026-08-13
- Architecture revision: 3

## Context

`OBTS-FM-001` cannot explore cross-system interleavings among two plugin clients, Bridge Node, the separate Rust writer/projection, server operation recovery, lossy request/reply exchange, directory causality, conflict protection, and seen-versus-applied acknowledgement. These interactions require one composed bounded model with non-vacuous trigger evidence.

Source inspection found a persistence discrepancy. Online conflict resolution commits resolving-user attribution, audit, both `main_advanced` and `conflict_resolved` events, and device last-success time at `src/server/syncService.ts:827-880`. Startup reconstruction at `src/server/app.ts:3492-3596` commits only a subset after observing exact `main` movement. `OBTS-PER-OP-001` requires the exact prepared operation effects.

## Decision

Adopt `OBTS-FM-002` as the authoritative **candidate** composed bounded specification at architecture revision 3. It is not accepted while any required candidate counterexample exists.

Acceptance requires all gates together:

1. the exact required positive safety, separately fair liveness, and trigger-reachability matrix passes within declared state/depth/time budgets and collapse floors;
2. every negative control violates exactly its declared invariant after its minimum meaningful setup prefix and includes its required witness;
3. independent `OBTS-FM-001` safety, liveness, and four controls remain intact;
4. candidate status has at least one required candidate discrepancy; accepted status has no candidates and every required positive passes; and independent review approves the abstractions and evidence.

One `CoreNext`/`Next` composition is used by every positive scenario. Finite constants and guards bound edits, message multiplicity, actors, crashes, and meaningful fault seams; no state constraints or scenario-specific `Next` whitelists remove claimed interactions. Focused reachability checks establish every claimed actor/action/classification and every liveness trigger.

The model keeps observation separate from durable capture; preserves canonical content per path; carries immutable attempt and causal directory identities through server operation/event state; separates CAS prepare, side effect, observed result, and metadata commit; orders conflict metadata before three independent protection refs; and publishes Bridge projection readiness only after manifest/base/path-OID verification and complete derived rows. PostgreSQL is never a preservation root. Audit retention is omitted rather than claimed.

The required candidate constructs a real divergent second proposal and conflict, prepares a `conflict_resolve`, moves `main`, crashes, and performs implementation-faithful startup reconstruction. It violates unchanged `ExactPreparedOperationRecovery` at `RecoverServerOperation` because attribution, audit, the secondary event, and last-success effects are missing. Generated `evidence/server-recovery-exact-effects.json` is hash-bound to the final model, config, check, TLC version, stats, and witness sequence.

Runtime transition instrumentation and replay are not part of this milestone. The validated static transition map and trace schema define a future boundary but make no runtime conformance or implementation-proof claim.

## Consequences

- `OBTS-FM-002` remains candidate despite all required positive/liveness/reachability gates passing and all controls rejecting their mutation.
- Revision remains 3 because this is one still-uncommitted coherent architecture migration; production semantics were not changed.
- `OBTS-FM-001` remains independently accepted; FM-002 adds a non-vacuous state projection check but does not claim complete temporal refinement.
- Resolving the production recovery discrepancy and adding executable crash/instrumentation evidence are later implementation milestones. No production code or plugin version changes are included here.
