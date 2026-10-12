---- MODULE OBTSRenameFallback ----
EXTENDS Naturals, FiniteSets, TLC

\* OBTS-FM-014 fallback companion, architecture revision 56. A pending pair whose
\* evidence cannot be proven degrades to ordinary delete/add obligations at a base no
\* newer than the pair base; it never latches the client. Symbolic endpoint trees.
CONSTANT Mutation
Paths == {"source", "destination"}
K == "K"
P == "P"
R == "R"
NoBase == "none"
KTree == [p \in Paths |-> IF p = "source" THEN "v0" ELSE "absent"]
Merge3(b, o, t) == IF o = b THEN t ELSE IF t = b THEN o ELSE IF o = t THEN o ELSE "CONFLICT"
Phases == {"legacy-latched", "recorded", "retry-wait", "degraded", "captured",
  "admitted", "paired", "integrated", "conflict", "resolved", "rejected", "latched"}
Open == {"legacy-latched", "recorded", "retry-wait", "degraded", "captured", "admitted"}

VARIABLES phase, legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
  localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
  degraded, degradedBase, baseTree, mainAtIntegration, outcome, serverRejected, retried
vars == <<phase, legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
  localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
  degraded, degradedBase, baseTree, mainAtIntegration, outcome, serverRejected, retried>>

Init ==
  \E isLegacy \in BOOLEAN, isFrozen \in BOOLEAN, ev \in {"clean", "ambiguous"},
     base \in {K, P}, inMain \in BOOLEAN, source \in {"absent", "recreated"} :
    /\ isLegacy => ev = "ambiguous" /\ ~isFrozen
    /\ base = P => ~isFrozen
    /\ base = K => inMain
    /\ phase = IF isLegacy THEN "legacy-latched" ELSE "recorded"
    /\ legacy = isLegacy /\ upgraded = FALSE /\ latched = isLegacy
    /\ frozen = isFrozen /\ evidence = ev /\ pairBase = base /\ pInMain = inMain
    /\ localTree = [p \in Paths |-> IF p = "source" THEN source ELSE "v1"]
    /\ canonicalTree = KTree
    /\ remoteSourceEdited = FALSE /\ remoteDestinationOccupied = FALSE
    /\ degraded = FALSE /\ degradedBase = NoBase /\ baseTree = KTree
    /\ mainAtIntegration = KTree /\ outcome = "pending"
    /\ serverRejected = FALSE /\ retried = FALSE

Upgrade ==
  /\ phase = "legacy-latched"
  /\ upgraded' = TRUE
  /\ latched' = (Mutation = "mutant-no-migration")
  /\ phase' = IF Mutation = "mutant-no-migration" THEN "latched" ELSE "recorded"
  /\ UNCHANGED <<legacy, frozen, evidence, pairBase, pInMain, localTree, canonicalTree,
    remoteSourceEdited, remoteDestinationOccupied, degraded, degradedBase, baseTree,
    mainAtIntegration, outcome, serverRejected, retried>>

RemoteEditSource ==
  /\ phase \in Open /\ ~remoteSourceEdited
  /\ canonicalTree' = [canonicalTree EXCEPT !["source"] = "remote"]
  /\ remoteSourceEdited' = TRUE
  /\ UNCHANGED <<phase, legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, remoteDestinationOccupied, degraded, degradedBase, baseTree,
    mainAtIntegration, outcome, serverRejected, retried>>

RemoteOccupyDestination ==
  /\ phase \in Open /\ ~remoteDestinationOccupied
  /\ canonicalTree' = [canonicalTree EXCEPT !["destination"] = "remote"]
  /\ remoteDestinationOccupied' = TRUE
  /\ UNCHANGED <<phase, legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, remoteSourceEdited, degraded, degradedBase, baseTree,
    mainAtIntegration, outcome, serverRejected, retried>>

KeepProvenPair ==
  /\ phase = "recorded" /\ evidence = "clean"
  /\ phase' = "paired" /\ outcome' = "paired-handoff"
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
    degraded, degradedBase, baseTree, mainAtIntegration, serverRejected, retried>>

FrozenIgnoredRetry ==
  /\ phase = "recorded" /\ evidence = "ambiguous" /\ frozen
  /\ Mutation # "mutant-degrade-frozen"
  /\ phase' = "retry-wait" /\ retried' = TRUE
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
    degraded, degradedBase, baseTree, mainAtIntegration, outcome, serverRejected>>

RestoreRootPolicy ==
  /\ phase = "retry-wait"
  /\ evidence' = "clean" /\ phase' = "recorded"
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, pairBase, pInMain, localTree,
    canonicalTree, remoteSourceEdited, remoteDestinationOccupied, degraded,
    degradedBase, baseTree, mainAtIntegration, outcome, serverRejected, retried>>

FallbackBase ==
  CASE Mutation = "mutant-newer-base" -> R
    [] Mutation = "mutant-no-predecessor-fallback" -> pairBase
    [] pairBase = P /\ ~pInMain -> K
    [] OTHER -> pairBase

DegradeToObligations ==
  /\ phase = "recorded" /\ evidence = "ambiguous"
  /\ ~frozen \/ Mutation = "mutant-degrade-frozen"
  /\ IF Mutation = "mutant-latch"
       THEN /\ latched' = TRUE /\ phase' = "latched"
            /\ UNCHANGED <<degraded, degradedBase>>
       ELSE /\ degraded' = TRUE /\ degradedBase' = FallbackBase
            /\ phase' = "degraded" /\ UNCHANGED latched
  /\ UNCHANGED <<legacy, upgraded, frozen, evidence, pairBase, pInMain, localTree,
    canonicalTree, remoteSourceEdited, remoteDestinationOccupied, baseTree,
    mainAtIntegration, outcome, serverRejected, retried>>

CaptureUnpaired ==
  /\ phase = "degraded"
  /\ baseTree' = IF degradedBase = R THEN canonicalTree ELSE KTree
  /\ phase' = "captured"
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
    degraded, degradedBase, mainAtIntegration, outcome, serverRejected, retried>>

BaseInMain == degradedBase \in {K, R} \/ (degradedBase = P /\ pInMain)

AdmitUnpaired ==
  /\ phase = "captured"
  /\ IF BaseInMain
       THEN /\ phase' = "admitted" /\ UNCHANGED serverRejected
       ELSE /\ phase' = "rejected" /\ serverRejected' = TRUE
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, canonicalTree, remoteSourceEdited, remoteDestinationOccupied,
    degraded, degradedBase, baseTree, mainAtIntegration, outcome, retried>>

Merged == [p \in Paths |-> Merge3(baseTree[p], localTree[p], canonicalTree[p])]
HasConflict == \E p \in Paths : Merged[p] = "CONFLICT"

IntegrateUnpaired ==
  /\ phase = "admitted"
  /\ mainAtIntegration' = canonicalTree
  /\ IF HasConflict
       THEN /\ phase' = "conflict" /\ outcome' = "conflict"
            /\ UNCHANGED canonicalTree
       ELSE /\ phase' = "integrated" /\ outcome' = "merged"
            /\ canonicalTree' = Merged
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, remoteSourceEdited, remoteDestinationOccupied, degraded,
    degradedBase, baseTree, serverRejected, retried>>

ResolveInDashboard ==
  /\ phase = "conflict"
  /\ \E useDevice \in BOOLEAN :
       canonicalTree' = IF useDevice
         THEN [p \in Paths |-> IF localTree[p] # baseTree[p] THEN localTree[p] ELSE canonicalTree[p]]
         ELSE canonicalTree
  /\ phase' = "resolved" /\ outcome' = "resolved"
  /\ UNCHANGED <<legacy, upgraded, latched, frozen, evidence, pairBase, pInMain,
    localTree, remoteSourceEdited, remoteDestinationOccupied, degraded,
    degradedBase, baseTree, mainAtIntegration, serverRejected, retried>>

Settled ==
  /\ phase \in {"paired", "integrated", "resolved"}
  /\ UNCHANGED vars

\* No general stutter: TLC deadlock checking proves every unsettled state can progress.
Next == Upgrade \/ RemoteEditSource \/ RemoteOccupyDestination \/ KeepProvenPair
  \/ FrozenIgnoredRetry \/ RestoreRootPolicy \/ DegradeToObligations
  \/ CaptureUnpaired \/ AdmitUnpaired \/ IntegrateUnpaired \/ ResolveInDashboard
  \/ Settled

TypeOK == phase \in Phases /\ degradedBase \in {K, P, R, NoBase}
NeverLatchedAfterUpgrade == latched => legacy /\ ~upgraded
OnlyAmbiguousDegrades == degraded => evidence = "ambiguous"
FrozenNeverDegraded == frozen => ~degraded
DegradedBaseNotNewer == degraded => degradedBase \in {K, pairBase}
ServerAdmitsFallback == ~serverRejected
NoSilentLoss == outcome = "merged" => \A p \in Paths :
  /\ (localTree[p] # KTree[p] => canonicalTree[p] = localTree[p])
  /\ (mainAtIntegration[p] # KTree[p] => canonicalTree[p] = mainAtIntegration[p])
CanonicalUnchangedOnConflict == outcome = "conflict" => canonicalTree = mainAtIntegration
AllSafety == TypeOK /\ NeverLatchedAfterUpgrade /\ OnlyAmbiguousDegrades
  /\ FrozenNeverDegraded /\ DegradedBaseNotNewer /\ ServerAdmitsFallback
  /\ NoSilentLoss /\ CanonicalUnchangedOnConflict

WitnessNotReached ==
  CASE Mutation = "reach-degrade-merge" -> ~(degraded /\ outcome = "merged")
    [] Mutation = "reach-degrade-conflict" ->
      ~(degraded /\ remoteSourceEdited /\ outcome = "conflict")
    [] Mutation = "reach-degrade-resolved" -> ~(degraded /\ outcome = "resolved")
    [] Mutation = "reach-recreated-source-merge" ->
      ~(outcome = "merged" /\ canonicalTree["source"] = "recreated")
    [] Mutation = "reach-predecessor-fallback" ->
      ~(pairBase = P /\ ~pInMain /\ degradedBase = K /\ outcome \in {"merged", "conflict"})
    [] Mutation = "reach-legacy-upgrade" ->
      ~(legacy /\ upgraded /\ outcome \in {"merged", "conflict"})
    [] Mutation = "reach-frozen-retry" -> ~(frozen /\ retried /\ outcome = "paired-handoff")
    [] OTHER -> TRUE
Spec == Init /\ [][Next]_vars
=============================================================================
