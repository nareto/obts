---- MODULE OBTSSafety ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
Architecture-derived predicate helpers for OBTS-FM-002. The authoritative
root supplies durable state to these pure predicates. This module defines no
Init, Next, or Spec.
***************************************************************************)

AllRooted(versions, rooted) == \A version \in versions: rooted[version]

NoRewind(clients, advanced, refs, base) ==
  \A client \in clients: advanced[client] => refs[client] # base

CursorOrder(clients, seen, applied) ==
  \A client \in clients: applied[client] <= seen[client]

AckTruth(clients, lastApplied, localMain, durableApplied, base) ==
  \A client \in clients:
    lastApplied[client] # base =>
      durableApplied[client] /\ localMain[client] = lastApplied[client]

ProjectionTruth(cursor, none, verified, complete, gitVersions) ==
  cursor = none \/ (verified /\ complete /\ cursor \in gitVersions)

PreparedTruth(phase, effectsPrepared, movedTarget, main) ==
  phase \in {"MainMoved", "Committed"} =>
    effectsPrepared /\ movedTarget = main

CanonicalAgreement(phase, target, eventMain, directoryMain) ==
  phase = "Committed" => eventMain = target /\ directoryMain = target

=============================================================================
