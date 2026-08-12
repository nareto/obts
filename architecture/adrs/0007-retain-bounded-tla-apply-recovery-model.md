# ADR 0007: Retain A Bounded TLA+ Apply/Recovery Model

- Status: accepted
- Date: 2026-08-12
- Architecture revision: 2

## Context

OBTS-SAF-001, OBTS-SAF-002, and OBTS-SAF-005 require captured local versions to remain recoverable, destructive mutation to follow complete recovery publication, and restart to roll forward safely or block. Existing tests covered many in-process recovery cases but did not systematically explore interleavings among concurrent edits, durable phases, crashes, restart, and cleanup.

A pilot had to demonstrate useful counterexamples, independent reviewability, bounded cost, and an explicit relationship to executable tests. It was not intended to prove filesystem durability or implementation conformance.

## Decision

Retain `OBTS-FM-001` as an accepted bounded architecture model for the one-client, one-path local apply/recovery protocol.

The pilot met its gate:

- TLC exhaustively checked 163 distinct states at depth 20 in about one second with one worker;
- four negative controls each produced a short counterexample;
- the stale-preflight counterexample exposed an implementation seam where bulk revalidation could become stale before mutation and was translated into an executable regression test;
- the model states rather than hides its durability, fairness, crash-bound, and abstraction assumptions;
- the model remains small enough for direct independent review against three named contracts.

A future change to local apply/recovery phases, recovery publication, mutation revalidation, restart classification, ref/coordination publication, or cleanup must update the model and architecture revision or explicitly supersede this ADR and retire the model.

## Consequences

- `npm test` runs the bounded safety/liveness checks and negative controls.
- CI may set `TLA2TOOLS_JAR` to a pinned TLC distribution; developer machines may use `tla-tools` from the local package manager.
- Model variables and actions must cite implementation boundaries in the model documentation, but code and tests remain necessary conformance evidence.
- The model is not expanded automatically to directories, server integration, multi-device sync, or Bridge behavior. New models require a separate value/cost decision.
- Power-loss durability, finalized-bundle verification, process-kill recovery, and mobile lifecycle remain open verification obligations rather than assumed conclusions.
