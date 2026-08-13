# ADR 0008: Accept The Composed Distributed Formal Model

- Status: accepted
- Date: 2026-08-13
- Architecture revision: 4

## Context

`OBTS-FM-001` cannot explore cross-system interleavings among two plugin clients, Bridge Node, the separate Rust writer/projection, server operation recovery, lossy request/reply exchange, directory causality, conflict protection, and seen-versus-applied acknowledgement. These interactions require one composed bounded model with non-vacuous trigger evidence.

The initial candidate model found that online conflict resolution persisted resolving-user attribution, audit, both resolution events, and device last-success time while startup recovery after exact `main` movement reconstructed only a subset. The implementation now includes those effects in the prepared operation and reconstructs them on startup. `tests/phase2.test.ts` reproduces the ref-moved/metadata-prepared restart boundary, and the implementation-faithful formal configuration now satisfies `ExactPreparedOperationRecovery`.

## Decision

Accept `OBTS-FM-002` as the authoritative composed bounded specification at architecture revision 4.

Acceptance requires all gates together:

1. the exact required positive safety, separately fair liveness, and trigger-reachability matrix passes within declared state/depth/time budgets and collapse floors;
2. every negative control violates exactly its declared invariant after its minimum meaningful setup prefix and includes its required witness;
3. independent `OBTS-FM-001` safety, liveness, and four controls remain intact;
4. accepted status has no candidate counterexamples and every required positive passes.

One `CoreNext`/`Next` composition is used by every positive scenario. Finite constants and guards bound edits, message multiplicity, actors, crashes, and meaningful fault seams; no state constraints or scenario-specific `Next` whitelists remove claimed interactions. Focused reachability checks establish every claimed actor/action/classification and every liveness trigger.

The model keeps observation separate from durable capture; preserves canonical content per path; carries immutable attempt and causal directory identities through server operation/event state; separates CAS prepare, side effect, observed result, and metadata commit; orders conflict metadata before three independent protection refs; and publishes Bridge projection readiness only after manifest/base/path-OID verification and complete derived rows. PostgreSQL is never a preservation root. Audit retention is omitted rather than claimed.

Runtime transition instrumentation and replay are not part of this decision. The validated static transition map and trace schema define a future boundary but make no runtime conformance or implementation-proof claim.

## Consequences

- `OBTS-FM-002` is accepted with all required positive, liveness, reachability, implementation-recovery, and negative-control checks producing their declared outcomes.
- `OBTS-FM-001` remains independently accepted; FM-002 adds a non-vacuous state projection check but does not claim complete temporal refinement.
- The accepted model remains bounded and does not prove filesystem durability, Git/checksum implementation, semantic merge parsers, mobile lifecycle, or operational backup/restore.
- Production protocol changes must update or explicitly retire the affected formal transition and preserve the exact check matrix.
