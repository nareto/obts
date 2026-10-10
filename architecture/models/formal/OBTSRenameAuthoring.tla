---- MODULE OBTSRenameAuthoring ----
EXTENDS Naturals, FiniteSets, TLC

\* OBTS-FM-014 companion, architecture revision 52. Symbolic guards, evidence, and three-path trees.
CONSTANT Mutation
Paths == {"source", "destination", "unrelated"}
Blockers == {"obligation-source", "obligation-destination", "horizon-source",
  "horizon-destination", "held-source", "held-destination", "stale-source",
  "stale-destination", "blocked-successor", "confirmed-successor"}
K == "K"
P == "P"
NoBase == "none"
KTree == [p \in Paths |-> IF p = "source" THEN "old" ELSE IF p = "unrelated" THEN "base" ELSE "absent"]
PTree == [KTree EXCEPT !["source"] = "P-source"]
ProposalTree == [PTree EXCEPT !["source"] = "absent", !["destination"] = "renamed"]
RemoteDisjointTree == [PTree EXCEPT !["unrelated"] = "remote"]
RemoteOverlapTree == [PTree EXCEPT !["source"] = "remote-source"]
VARIABLES phase, liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
  targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
  pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
  endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
  canonicalTree, proposalTree, conflictSnapshot, remoteAdvanced, remoteKind,
  integrationResult, acceptedAtEvent
vars == <<phase, liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
  targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
  pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
  endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
  canonicalTree, proposalTree, conflictSnapshot, remoteAdvanced, remoteKind,
  integrationResult, acceptedAtEvent>>

Init ==
  /\ phase = "pending"
  /\ liveQueueIdentity = FALSE /\ localHeadP = FALSE /\ pAncestor = FALSE
  /\ pNotCanonical = FALSE /\ targetIsP = FALSE /\ ordinaryBaseNull = FALSE
  /\ intentConsistent = FALSE /\ pairBase = K /\ frozen = FALSE
  /\ frozenBase = NoBase /\ pinnedBases = {K} /\ durableBase = K
  /\ sourceRegular = "unknown" /\ destinationFree = FALSE /\ hierarchyClear = FALSE
  /\ endpointBlockers = {} /\ touchedHorizon = {}
  /\ unrelatedEvidence = [p \in Paths |-> IF p = "unrelated" THEN K ELSE NoBase]
  /\ crashed = FALSE /\ restarted = FALSE
  /\ canonicalTree = KTree /\ proposalTree = ProposalTree
  /\ conflictSnapshot = KTree /\ remoteAdvanced = FALSE /\ remoteKind = "none"
  /\ integrationResult = "pending" /\ acceptedAtEvent = FALSE

AcceptProposal ==
  /\ phase = "pending" /\ Mutation # "reach-accepted-after-rename"
  /\ liveQueueIdentity' = TRUE /\ localHeadP' = TRUE /\ pAncestor' = TRUE
  /\ pNotCanonical' = TRUE /\ targetIsP' = TRUE /\ ordinaryBaseNull' = TRUE
  /\ intentConsistent' = TRUE /\ sourceRegular' = "regular"
  /\ destinationFree' = TRUE /\ hierarchyClear' = TRUE
  /\ canonicalTree' = PTree /\ conflictSnapshot' = PTree
  /\ acceptedAtEvent' = TRUE /\ phase' = "accepted"
  /\ UNCHANGED <<pairBase, frozen, frozenBase, pinnedBases, durableBase,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
    proposalTree, remoteAdvanced, remoteKind, integrationResult>>

RecordRenameBeforeAcceptance ==
  /\ phase = "pending" /\ sourceRegular' = "regular"
  /\ destinationFree' = TRUE /\ hierarchyClear' = TRUE
  /\ phase' = "rename-recorded"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, endpointBlockers, touchedHorizon, unrelatedEvidence,
    crashed, restarted, canonicalTree, proposalTree, conflictSnapshot,
    remoteAdvanced, remoteKind, integrationResult, acceptedAtEvent>>

AcceptAfterRename ==
  /\ phase = "rename-recorded"
  /\ liveQueueIdentity' = TRUE /\ localHeadP' = TRUE /\ pAncestor' = TRUE
  /\ pNotCanonical' = TRUE /\ targetIsP' = TRUE /\ ordinaryBaseNull' = TRUE
  /\ intentConsistent' = TRUE /\ canonicalTree' = PTree
  /\ conflictSnapshot' = PTree /\ acceptedAtEvent' = FALSE
  /\ phase' = "accepted-after-rename"
  /\ UNCHANGED <<sourceRegular, destinationFree, hierarchyClear, pairBase,
    frozen, frozenBase, pinnedBases, durableBase, endpointBlockers,
    touchedHorizon, unrelatedEvidence, crashed, restarted, proposalTree,
    remoteAdvanced, remoteKind, integrationResult>>

InvalidateSelectedGuard ==
  /\ phase = "accepted"
  /\ Mutation \in {"case-live-identity", "case-local-head", "case-not-ancestor",
    "case-already-canonical", "case-target-not-P", "case-nonnull-base",
    "case-intent-mismatch", "case-source-missing", "case-source-nonfile",
    "case-destination-occupied", "case-hierarchy-invalid", "mutant-omit-live-identity"}
  /\ liveQueueIdentity' = IF Mutation \in {"case-live-identity", "mutant-omit-live-identity"}
       THEN FALSE ELSE liveQueueIdentity
  /\ localHeadP' = IF Mutation = "case-local-head" THEN FALSE ELSE localHeadP
  /\ pAncestor' = IF Mutation = "case-not-ancestor" THEN FALSE ELSE pAncestor
  /\ pNotCanonical' = IF Mutation = "case-already-canonical" THEN FALSE ELSE pNotCanonical
  /\ targetIsP' = IF Mutation = "case-target-not-P" THEN FALSE ELSE targetIsP
  /\ ordinaryBaseNull' = IF Mutation = "case-nonnull-base" THEN FALSE ELSE ordinaryBaseNull
  /\ intentConsistent' = IF Mutation = "case-intent-mismatch" THEN FALSE ELSE intentConsistent
  /\ sourceRegular' = CASE Mutation = "case-source-missing" -> "missing"
      [] Mutation = "case-source-nonfile" -> "nonregular"
      [] OTHER -> sourceRegular
  /\ destinationFree' = IF Mutation = "case-destination-occupied" THEN FALSE ELSE destinationFree
  /\ hierarchyClear' = IF Mutation = "case-hierarchy-invalid" THEN FALSE ELSE hierarchyClear
  /\ phase' = IF Mutation = "mutant-omit-live-identity"
       THEN "accepted" ELSE "guard-invalid"
  /\ UNCHANGED <<pairBase, frozen, frozenBase, pinnedBases, durableBase,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
    canonicalTree, proposalTree, conflictSnapshot, remoteAdvanced, remoteKind,
    integrationResult, acceptedAtEvent>>

AddEndpointEvidence ==
  /\ phase = "accepted"
  /\ (Mutation \in Blockers \/ Mutation = "mutant-omit-endpoint-evidence")
  /\ endpointBlockers' = IF Mutation \in Blockers THEN {Mutation} ELSE {"obligation-source"}
  /\ phase' = "evidence-blocked"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    touchedHorizon, unrelatedEvidence, crashed, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

AddTouchedHorizon ==
  /\ phase = "accepted" /\ Mutation = "case-touched-horizon"
  /\ touchedHorizon' = {"source", "destination"}
  /\ phase' = "horizon-blocked"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, unrelatedEvidence, crashed, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

AuthoringGuard == liveQueueIdentity /\ localHeadP /\ pAncestor /\ pNotCanonical
  /\ targetIsP /\ ordinaryBaseNull /\ intentConsistent
EndpointTreeValid == sourceRegular = "regular" /\ destinationFree /\ hierarchyClear
NoEndpointEvidence == endpointBlockers = {} /\ touchedHorizon = {}
MayRebase == AuthoringGuard /\ EndpointTreeValid /\ NoEndpointEvidence
  /\ pairBase = K /\ ~frozen

PinNewBase ==
  /\ phase \in {"accepted", "accepted-after-rename", "evidence-blocked",
    "horizon-blocked", "guard-invalid", "restarted", "frozen"}
  /\ pairBase = K /\ ~frozen
  /\ IF Mutation = "mutant-omit-live-identity"
       THEN localHeadP /\ pAncestor /\ pNotCanonical /\ targetIsP
         /\ ordinaryBaseNull /\ intentConsistent
       ELSE AuthoringGuard
  /\ EndpointTreeValid
  /\ IF Mutation = "mutant-omit-endpoint-evidence" THEN TRUE ELSE NoEndpointEvidence
  /\ pinnedBases' = pinnedBases \cup {P}
  /\ phase' = "base-pinned"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    durableBase, sourceRegular, destinationFree, hierarchyClear, endpointBlockers,
    touchedHorizon, unrelatedEvidence, crashed, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

PersistNewBase ==
  /\ phase = "base-pinned" /\ P \in pinnedBases
  /\ (MayRebase \/ Mutation \in {"mutant-omit-live-identity",
      "mutant-omit-endpoint-evidence", "mutant-drop-unrelated-evidence"})
  /\ pairBase' = P /\ durableBase' = P /\ phase' = "rebased"
  /\ IF Mutation = "mutant-drop-unrelated-evidence"
       THEN unrelatedEvidence' = [unrelatedEvidence EXCEPT !["unrelated"] = NoBase]
       ELSE unrelatedEvidence' = unrelatedEvidence
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, frozen, frozenBase, pinnedBases,
    sourceRegular, destinationFree, hierarchyClear, endpointBlockers,
    touchedHorizon, crashed, restarted, canonicalTree, proposalTree,
    conflictSnapshot, remoteAdvanced, remoteKind, integrationResult, acceptedAtEvent>>

FreezePair ==
  /\ phase \in {"accepted", "accepted-after-rename"}
  /\ ~frozen /\ frozen' = TRUE /\ frozenBase' = pairBase /\ phase' = "frozen"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, pinnedBases,
    durableBase, sourceRegular, destinationFree, hierarchyClear, endpointBlockers,
    touchedHorizon, unrelatedEvidence, crashed, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

RebindFrozenMutant ==
  /\ Mutation = "mutant-rebind-frozen" /\ phase = "frozen"
  /\ pinnedBases' = pinnedBases \cup {P}
  /\ pairBase' = P /\ durableBase' = P /\ phase' = "rebased"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, frozen, frozenBase,
    sourceRegular, destinationFree, hierarchyClear, endpointBlockers,
    touchedHorizon, unrelatedEvidence, crashed, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

Crash ==
  /\ phase \in {"base-pinned", "rebased", "frozen"} /\ ~crashed
  /\ crashed' = TRUE /\ phase' = "crashed"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, touchedHorizon, unrelatedEvidence, restarted, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

Restart ==
  /\ crashed /\ ~restarted
  /\ restarted' = TRUE /\ pairBase' = durableBase /\ phase' = "restarted"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, canonicalTree,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, integrationResult,
    acceptedAtEvent>>

BaseForProposal == IF pairBase = P THEN PTree ELSE KTree
PairConflict == \E p \in {"source", "destination"}:
  canonicalTree[p] # BaseForProposal[p]
    /\ proposalTree[p] # BaseForProposal[p]
    /\ canonicalTree[p] # proposalTree[p]

RemoteAdvanceDisjoint ==
  /\ phase \in {"rebased", "restarted"} /\ ~remoteAdvanced
  /\ canonicalTree' = RemoteDisjointTree /\ conflictSnapshot' = RemoteDisjointTree
  /\ remoteAdvanced' = TRUE /\ remoteKind' = "disjoint" /\ phase' = "remote-advanced"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
    proposalTree, integrationResult, acceptedAtEvent>>

RemoteAdvanceOverlap ==
  /\ phase \in {"rebased", "restarted"} /\ ~remoteAdvanced
  /\ canonicalTree' = RemoteOverlapTree /\ conflictSnapshot' = RemoteOverlapTree
  /\ remoteAdvanced' = TRUE /\ remoteKind' = "overlap" /\ phase' = "remote-advanced"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
    proposalTree, integrationResult, acceptedAtEvent>>

IntegrateProposal ==
  /\ phase \in {"rebased", "restarted", "remote-advanced"}
  /\ integrationResult = "pending"
  /\ IF PairConflict
       THEN /\ integrationResult' = "conflict"
            /\ canonicalTree' = IF Mutation = "mutant-conflict-mutates-canonical"
                 THEN proposalTree ELSE canonicalTree
            /\ phase' = "conflict"
       ELSE /\ integrationResult' = "merged"
            /\ canonicalTree' = IF Mutation = "mutant-drop-remote-unrelated"
                 /\ remoteKind = "disjoint"
                 THEN proposalTree
                 ELSE [proposalTree EXCEPT !["unrelated"] = canonicalTree["unrelated"]]
            /\ phase' = "integrated"
  /\ UNCHANGED <<liveQueueIdentity, localHeadP, pAncestor, pNotCanonical,
    targetIsP, ordinaryBaseNull, intentConsistent, pairBase, frozen, frozenBase,
    pinnedBases, durableBase, sourceRegular, destinationFree, hierarchyClear,
    endpointBlockers, touchedHorizon, unrelatedEvidence, crashed, restarted,
    proposalTree, conflictSnapshot, remoteAdvanced, remoteKind, acceptedAtEvent>>

Next == AcceptProposal \/ RecordRenameBeforeAcceptance \/ AcceptAfterRename
  \/ InvalidateSelectedGuard \/ AddEndpointEvidence \/ AddTouchedHorizon
  \/ PinNewBase \/ PersistNewBase \/ FreezePair
  \/ RebindFrozenMutant \/ Crash \/ Restart \/ RemoteAdvanceDisjoint
  \/ RemoteAdvanceOverlap \/ IntegrateProposal \/ UNCHANGED vars

NoUnauthorizedBaseAdvance == pairBase = P => AuthoringGuard
  /\ EndpointTreeValid /\ NoEndpointEvidence
BasePinPrecedesDurableIntent == durableBase = P => P \in pinnedBases
FrozenAttemptNeverRebound == frozen => pairBase = frozenBase
RestartRestoresDurableBase == restarted => pairBase = durableBase
UnrelatedEvidenceBaseRetained == unrelatedEvidence["unrelated"] = K
NoFalseOwnOnlyConflict == ~remoteAdvanced /\ pairBase = P
  /\ phase \in {"integrated", "conflict"} => integrationResult = "merged"
RemoteUnrelatedSurvivesMerge == integrationResult = "merged" /\ remoteKind = "disjoint"
  => canonicalTree["unrelated"] = "remote"
CanonicalUnchangedOnConflict == integrationResult = "conflict"
  => canonicalTree = conflictSnapshot
AllSafety == NoUnauthorizedBaseAdvance /\ BasePinPrecedesDurableIntent
  /\ FrozenAttemptNeverRebound /\ RestartRestoresDurableBase
  /\ UnrelatedEvidenceBaseRetained /\ NoFalseOwnOnlyConflict
  /\ RemoteUnrelatedSurvivesMerge /\ CanonicalUnchangedOnConflict

WitnessNotReached ==
  CASE Mutation = "reach-rebase-merge" -> integrationResult # "merged"
    [] Mutation = "reach-accepted-after-rename" ->
      ~(phase = "integrated" /\ acceptedAtEvent = FALSE)
    [] Mutation = "reach-crash-restart" -> ~(restarted /\ pairBase = P)
    [] Mutation = "reach-own-only-merge" -> integrationResult # "merged"
    [] Mutation = "reach-remote-disjoint-merge" ->
      ~(integrationResult = "merged" /\ remoteKind = "disjoint")
    [] Mutation = "reach-remote-overlap-conflict" ->
      ~(integrationResult = "conflict" /\ remoteKind = "overlap")
    [] Mutation = "reach-unrelated-evidence-retained" ->
      ~(integrationResult = "merged" /\ unrelatedEvidence["unrelated"] = K)
    [] Mutation = "case-live-identity" ->
      ~(phase = "guard-invalid" /\ ~liveQueueIdentity /\ pairBase = K)
    [] Mutation = "mutant-omit-live-identity" ->
      ~(phase = "rebased" /\ ~liveQueueIdentity /\ pairBase = P)
    [] Mutation = "case-local-head" ->
      ~(phase = "guard-invalid" /\ ~localHeadP /\ pairBase = K)
    [] Mutation = "case-not-ancestor" ->
      ~(phase = "guard-invalid" /\ ~pAncestor /\ pairBase = K)
    [] Mutation = "case-already-canonical" ->
      ~(phase = "guard-invalid" /\ ~pNotCanonical /\ pairBase = K)
    [] Mutation = "case-target-not-P" ->
      ~(phase = "guard-invalid" /\ ~targetIsP /\ pairBase = K)
    [] Mutation = "case-nonnull-base" ->
      ~(phase = "guard-invalid" /\ ~ordinaryBaseNull /\ pairBase = K)
    [] Mutation = "case-intent-mismatch" ->
      ~(phase = "guard-invalid" /\ ~intentConsistent /\ pairBase = K)
    [] Mutation = "case-source-missing" ->
      ~(phase = "guard-invalid" /\ sourceRegular = "missing" /\ pairBase = K)
    [] Mutation = "case-source-nonfile" ->
      ~(phase = "guard-invalid" /\ sourceRegular = "nonregular" /\ pairBase = K)
    [] Mutation = "case-destination-occupied" ->
      ~(phase = "guard-invalid" /\ ~destinationFree /\ pairBase = K)
    [] Mutation = "case-hierarchy-invalid" ->
      ~(phase = "guard-invalid" /\ ~hierarchyClear /\ pairBase = K)
    [] Mutation \in Blockers ->
      ~(phase = "evidence-blocked" /\ endpointBlockers = {Mutation} /\ pairBase = K)
    [] Mutation = "case-touched-horizon" ->
      ~(phase = "horizon-blocked" /\ touchedHorizon # {} /\ pairBase = K)
    [] Mutation = "case-frozen-capture" -> ~(frozen /\ pairBase = K)
    [] OTHER -> TRUE
Spec == Init /\ [][Next]_vars
=============================================================================
