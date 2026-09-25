---- MODULE OBTSDistributedSync ----
EXTENDS Naturals, FiniteSets, Sequences, TLC, OBTSDomain
INSTANCE OBTSApplyRefinement
INSTANCE OBTSSafety

(***************************************************************************
OBTS-FM-002, architecture revision 16. This is a bounded refinement of the
architecture contracts, not a definition of product behavior. Persist/commit
steps assume their named durable facts survive restart. Git ancestry, bytes,
flush semantics, process kill, and runtime trace conformance remain external.
***************************************************************************)

CONSTANTS Plugin1, Plugin2, BridgeNode, PathA, PathB,
          BaseVersion, Plugin1Version, Plugin2Version, BridgeVersion,
          Scenario, FaultMode, MaxClientCrashes, MaxServerCrashes,
          MaxRustCrashes, MaxMessages

Clients == {Plugin1, Plugin2, BridgeNode}
PluginClients == {Plugin1, Plugin2}
Paths == {PathA, PathB}
Versions == {BaseVersion, Plugin1Version, Plugin2Version, BridgeVersion}
NoVersion == "NoVersion"
NoClient == "NoClient"
NoPath == "NoPath"
NoId == "NoId"
NoProposal == "NoProposal"
NoIntent == "NoIntent"
NoPlan == "NoPlan"
NoResult == "NoResult"
NoReading == "NoReading"
Policies == {"empty", "exclude-a"}
PolicyScenario == Scenario \in {"root-ignore", "root-ignore-legacy", "root-ignore-bridge-race", "root-ignore-invalid", "root-ignore-stale-queued"}
ChangingPolicyScenario == Scenario \in {"root-ignore", "root-ignore-bridge-race", "root-ignore-invalid"}
PolicyOfTarget(v) == IF ChangingPolicyScenario /\ v = Plugin1Version THEN "exclude-a" ELSE "empty"
NoPolicy == "NoPolicy"
PolicyIds == Policies \cup {NoPolicy}
Copies == 1..MaxMessages
AttemptIds == {"attempt-plugin-1", "attempt-plugin-2", "attempt-bridge", "attempt-plugin-1-retry", "attempt-equal", "attempt-covered", "attempt-rebuild"}
TransferIds == {"transfer-plugin-1", "transfer-plugin-2", "transfer-bridge", "transfer-plugin-1-retry", "transfer-equal", "transfer-covered", "transfer-rebuild"}
ProposalIds == {"dir-plugin-1", "dir-plugin-2", "dir-bridge", NoProposal}
IntentIds == {"intent-plugin-1", "intent-plugin-2", "intent-bridge", NoIntent}
Plans == {"plan-plugin-1", "plan-plugin-2", "plan-bridge", NoPlan}
Classifications == {"None", "Equal", "Descendant", "Covered", "Divergent"}
ProposalPhases == {"Idle", "Observed", "Captured", "Queued", "Transferring", "Terminal", "Blocked"}
OperationTypes == {"none", "device_push", "conflict_resolve"}
OperationPhases == {"Idle", "Started", "Validated", "Classified", "CASPrepared", "CASSideEffect", "CASObserved", "DeviceCommitted", "IntegrationPrepared", "MainMoved", "ConflictMetadata", "Committed", "Aborted", "Blocked"}
CASKinds == {"none", "device", "main", "conflict-current"}
CASObservations == {"None", "Old", "Target", "Foreign", "Uncertain"}
RestartDispositions == {"None", "Resume", "RollForward", "Block"}
RustPhases == {"Idle", "Validated", "Written", "Notified"}
EffectNames == {"attribution", "audit", "main_event", "conflict_event", "last_success", "directory_result"}
IdentityType == {<<v, e, b, d, p, a, t>> :
  v \in Versions \cup {NoVersion}, e \in Versions \cup {NoVersion},
  b \in Versions \cup {NoVersion}, d \in ProposalIds, p \in Plans,
  a \in AttemptIds \cup {NoId}, t \in TransferIds \cup {NoId}} \X PolicyIds
AllResolutionEffects == EffectNames

ASSUME Plugin1 # Plugin2 /\ Plugin1 # BridgeNode /\ Plugin2 # BridgeNode
ASSUME PathA # PathB
ASSUME Cardinality(Versions) = 4
ASSUME MaxMessages = 2
ASSUME MaxClientCrashes \in Nat /\ MaxServerCrashes \in Nat /\ MaxRustCrashes \in Nat

VARIABLES client, network, server, bridge, directory, coverage, ghost, lastAction
vars == <<client, network, server, bridge, directory, coverage, ghost, lastAction>>

ClientVersion(c, n) ==
  CASE c = Plugin1 /\ n = 1 -> Plugin1Version
    [] c = Plugin1 /\ n = 2 -> Plugin2Version
    [] c = Plugin2 -> Plugin2Version
    [] OTHER -> BridgeVersion

ClientPath(c) ==
  CASE ChangingPolicyScenario /\ c = Plugin1 -> PathB
    [] Scenario = "disjoint-directory" /\ c = Plugin1 -> PathB
    [] OTHER -> PathA

AttemptId(c, n) ==
  CASE c = Plugin1 /\ n = 2 -> "attempt-plugin-1-retry"
    [] c = Plugin1 -> "attempt-plugin-1"
    [] c = Plugin2 -> "attempt-plugin-2"
    [] OTHER -> "attempt-bridge"

TransferId(c, n) ==
  CASE c = Plugin1 /\ n = 2 -> "transfer-plugin-1-retry"
    [] c = Plugin1 -> "transfer-plugin-1"
    [] c = Plugin2 -> "transfer-plugin-2"
    [] OTHER -> "transfer-bridge"

ProposalId(c) == CASE c = Plugin1 -> "dir-plugin-1" [] c = Plugin2 -> "dir-plugin-2" [] OTHER -> "dir-bridge"
IntentId(c) == CASE c = Plugin1 -> "intent-plugin-1" [] c = Plugin2 -> "intent-plugin-2" [] OTHER -> "intent-bridge"
PlanId(c) == CASE c = Plugin1 -> "plan-plugin-1" [] c = Plugin2 -> "plan-plugin-2" [] OTHER -> "plan-bridge"

ScenarioAllowsClient(c) ==
  CASE Scenario = "root-ignore" -> c \in PluginClients
    [] Scenario = "root-ignore-stale-queued" -> c = Plugin1
    [] Scenario = "root-ignore-bridge-race" -> c = Plugin1
    [] Scenario = "root-ignore-invalid" -> c = Plugin1
    [] Scenario = "root-ignore-legacy" -> FALSE
    [] Scenario = "same-path" -> c \in PluginClients
    [] Scenario = "disjoint-directory" -> c \in {Plugin1, BridgeNode}
    [] Scenario \in {"server-recovery", "server-recovery-implementation", "live-proposal", "live-recovery", "live-apply", "apply-refinement"} -> c = Plugin1
    [] Scenario \in {"bridge-handoff", "live-bridge"} -> c = BridgeNode
    [] Scenario = "all-actors" -> TRUE
    [] Scenario = "network" -> c = Plugin1
    [] OTHER -> FALSE

MaxEdits(c) == IF c = Plugin1 /\ Scenario \in {"same-path", "server-recovery", "server-recovery-implementation", "live-recovery", "all-actors"} THEN 2 ELSE 1
BridgeWriteAllowed == Scenario \in {"disjoint-directory", "bridge-handoff", "all-actors", "live-bridge", "root-ignore-bridge-race"} /\ (Scenario # "disjoint-directory" \/ client.proposalPhase[Plugin1] = "Terminal")
EditOrderAllows(c) ==
  CASE Scenario = "disjoint-directory" /\ c = BridgeNode -> client.proposalPhase[Plugin1] = "Terminal"
    [] Scenario = "all-actors" /\ c = Plugin2 -> client.proposalPhase[Plugin1] = "Terminal"
    [] Scenario = "all-actors" /\ c = BridgeNode -> client.proposalPhase[Plugin2] = "Terminal"
    [] OTHER -> TRUE
NetworkFaultActor(c) == c = Plugin1 /\ Scenario \in {"all-actors", "network"}
NetworkFaultCopy(c, copy) == NetworkFaultActor(c) /\ (Scenario # "all-actors" \/ copy = 1)
ClientCrashAllowed(c) == c = BridgeNode /\ Scenario \in {"bridge-handoff", "all-actors"}
AllScenarioProposalsTerminal ==
  CASE Scenario = "disjoint-directory" -> client.proposalPhase[Plugin1] = "Terminal" /\ client.proposalPhase[BridgeNode] = "Terminal"
    [] Scenario = "all-actors" -> \A c \in Clients: client.proposalPhase[c] = "Terminal"
    [] OTHER -> FALSE
ApplyAllowed(c) == c = Plugin2 /\ Scenario \in {"root-ignore", "root-ignore-legacy", "disjoint-directory", "all-actors", "live-apply", "apply-refinement"} /\ (Scenario # "all-actors" \/ AllScenarioProposalsTerminal)
ServerCrashAllowed == Scenario \in {"server-recovery", "server-recovery-implementation", "all-actors", "live-recovery"}

EmptyTree == [p \in Paths |-> {BaseVersion}]
ServerRooted(v) == v = BaseVersion \/ v \in server.processingRoots \/ (\E c \in Clients: v = server.deviceRef[c]) \/ (\E p \in Paths: v \in server.mainTree[p]) \/ v \in server.conflictRoots
Rooted(v) ==
  \/ v = BaseVersion
  \/ \E c \in Clients:
       v \in client.localGit[c] \/ v \in client.recoveryRoots[c] \/
       \E p \in Paths: v = client.visible[c][p]
  \/ v \in server.processingRoots
  \/ \E c \in Clients: v = server.deviceRef[c]
  \/ \E p \in Paths: v \in server.mainTree[p]
  \/ v \in server.conflictRoots

Request(c, copy) == [actor |-> c, copy |-> copy, attempt |-> client.attemptId[c], transfer |-> client.transferId[c], target |-> client.queueTarget[c], expected |-> client.expectedDevice[c], base |-> client.proposalBase[c], directoryProposal |-> client.directoryProposal[c], objectPlan |-> client.objectPlan[c], policy |-> client.attemptPolicy[c], hasA |-> client.candidateHasA[c]]
Reply(c, copy) == [actor |-> c, copy |-> copy, attempt |-> client.attemptId[c], result |-> IF client.attemptId[c] \in AttemptIds THEN server.resultByAttempt[client.attemptId[c]] ELSE NoResult]
MessageKey(m) == <<m.actor, m.copy, m.attempt>>

Init ==
  /\ client = [
       capable |-> [c \in Clients |-> ~PolicyScenario \/ c # Plugin2],
       policy |-> SetMap(Clients, "empty"), attemptPolicy |-> SetMap(Clients, NoPolicy),
       candidateHasA |-> SetMap(Clients, TRUE),
       journalPolicy |-> SetMap(Clients, NoPolicy), localOnly |-> SetMap(Clients, FALSE),
       up |-> SetMap(Clients, TRUE), recovering |-> SetMap(Clients, FALSE),
       restartDisposition |-> SetMap(Clients, "None"), crashCount |-> SetMap(Clients, 0),
       visible |-> [c \in Clients |-> [p \in Paths |-> BaseVersion]],
       observed |-> SetMap(Clients, {}), localGit |-> SetMap(Clients, {BaseVersion}),
       capturePublished |-> SetMap(Clients, {}), hints |-> SetMap(Clients, {}),
       editCount |-> SetMap(Clients, 0), editPath |-> SetMap(Clients, NoPath),
       queueTarget |-> SetMap(Clients, NoVersion), expectedDevice |-> SetMap(Clients, NoVersion),
       proposalBase |-> SetMap(Clients, NoVersion), directoryProposal |-> SetMap(Clients, NoProposal),
       directoryIntent |-> SetMap(Clients, NoIntent), directoryGeneration |-> SetMap(Clients, 0),
       objectPlan |-> SetMap(Clients, NoPlan), attemptId |-> SetMap(Clients, NoId),
       transferId |-> SetMap(Clients, NoId), immutableIdentity |-> SetMap(Clients, <<<<NoVersion, NoVersion, NoVersion, NoProposal, NoPlan, NoId, NoId>>, NoPolicy>>),
       proposalPhase |-> SetMap(Clients, "Idle"), seenCursor |-> SetMap(Clients, 0),
       appliedCursor |-> SetMap(Clients, 0), localMainEpoch |-> SetMap(Clients, 0),
       durableApplied |-> SetMap(Clients, FALSE), ackIntent |-> SetMap(Clients, FALSE),
       applyPhase |-> SetMap(Clients, "Idle"), journalPresent |-> SetMap(Clients, FALSE),
       recoveryRoots |-> SetMap(Clients, {}), preflight |-> SetMap(Clients, NoVersion),
       displaced |-> SetMap(Clients, {}), blocked |-> SetMap(Clients, FALSE)]
  /\ network = [requestBag |-> {}, delayedRequests |-> {}, droppedRequests |-> {}, deliveredRequests |-> {}, replyBag |-> {}, delayedReplies |-> {}, droppedReplies |-> {}, deliveredReplies |-> {}]
  /\ server = [
       policy |-> IF Scenario = "root-ignore-legacy" THEN "exclude-a" ELSE "empty",
       policyActive |-> Scenario # "root-ignore-legacy", opCandidateHasA |-> TRUE,
       eventPolicy |-> "empty", opPolicy |-> NoPolicy,
       up |-> TRUE, recovering |-> FALSE, crashCount |-> 0, mainEpoch |-> 0,
       mainTree |-> EmptyTree, mainHistory |-> {BaseVersion}, deviceRef |-> SetMap(Clients, BaseVersion),
       deviceHistory |-> SetMap(Clients, {BaseVersion}), processingRoots |-> {}, accepted |-> {},
       processedAttempts |-> {}, resultByAttempt |-> [a \in AttemptIds |-> NoResult], processCount |-> [a \in AttemptIds |-> 0],
       opType |-> "none", opActor |-> NoClient, opTarget |-> NoVersion, opPath |-> NoPath,
       opExpected |-> NoVersion, opAttempt |-> NoId, opTransfer |-> NoId,
       opDirectoryProposal |-> NoProposal, opDirectoryIntent |-> NoIntent, opDirectoryGeneration |-> 0,
       opBaseEpoch |-> 0, opBaseEvent |-> 0, opObjectPlan |-> NoPlan,
       classification |-> "None", opPhase |-> "Idle", casKind |-> "none",
       casOld |-> NoVersion, casTarget |-> NoVersion, casActual |-> NoVersion,
       casSideEffect |-> FALSE, casObserved |-> "None", casMetadataCommitted |-> FALSE,
       conflictMetadata |-> FALSE, conflictEvent |-> FALSE, reviewNeeded |-> FALSE,
       protectBase |-> FALSE, protectCurrent |-> FALSE, protectDevice |-> FALSE,
       conflictBase |-> NoVersion, conflictCurrent |-> NoVersion, conflictDevice |-> NoVersion,
       conflictRoots |-> {}, expectedEffects |-> {}, committedEffects |-> {},
       eventSeq |-> 0, eventTree |-> EmptyTree, lastAppliedEpoch |-> SetMap(Clients, 0),
       deliveredAckEpoch |-> SetMap(Clients, 0), historyRetained |-> TRUE, blocked |-> FALSE]
  /\ bridge = [
       rustUp |-> TRUE, rustCrashCount |-> 0, rustPhase |-> "Idle", acknowledged |-> FALSE,
       nodeHintDurable |-> FALSE, projectionPolicy |-> NoPolicy, projectedPaths |-> Paths,
       preservedAtPolicy |-> BaseVersion,
       manifestVerified |-> FALSE, baseVerified |-> FALSE,
       pathOidsVerified |-> FALSE, rowsComplete |-> FALSE, projectionCursor |-> 0,
       projectionTarget |-> 0, projectionHealthy |-> FALSE, derivedReady |-> FALSE,
       projectionFailure |-> FALSE, cursorPublishedVerified |-> FALSE, auditRetained |-> PolicyScenario]
  /\ directory = [
       canonicalTombstone |-> FALSE, proposalId |-> NoProposal, intentId |-> NoIntent,
       generation |-> 0, baseMainEpoch |-> 0, baseEventSeq |-> 0, prepared |-> FALSE,
       committed |-> FALSE, resultProposal |-> NoProposal, resultEvent |-> 0,
       eventProposal |-> NoProposal, localDeletionTarget |-> SetMap(Clients, NoProposal), deletedUnderProposal |-> SetMap(Clients, NoProposal),
       deletedIdentity |-> SetMap(Clients, 0), localPresent |-> SetMap(Clients, TRUE), localIdentity |-> SetMap(Clients, 0),
       preflightIdentity |-> SetMap(Clients, 0), localEmpty |-> SetMap(Clients, TRUE),
       descendantPresent |-> SetMap(Clients, FALSE), descendantObserved |-> SetMap(Clients, FALSE), descendantLost |-> SetMap(Clients, FALSE)]
  /\ coverage = [actions |-> {}, classifications |-> {}, actorsProposed |-> {}, conflictPartial |-> FALSE, replyLostAfterOutcome |-> FALSE]
  /\ ghost = [captured |-> {}, overwritten |-> {}]
  /\ lastAction = "Init"

NormalClient(c) == client.up[c] /\ ~client.recovering[c] /\ ~client.blocked[c]
NormalServer == server.up /\ ~server.recovering /\ ~server.blocked
AllActorCoverageActions == {"RustAtomicVisibleWrite", "AdvanceProjectionCursor", "DropProposalRequest", "CrashClient", "CrashServer", "CrashRust", "RecoverServerOperation", "BeginConflictMetadata", "AcknowledgeDurableApply", "AcknowledgeHistorical", "EvictDeliveredAckSnapshot", "LoseAllAckEvidence", "DeleteEmptyDirectory"}
Mark(action) == IF Scenario \in {"all-actors", "disjoint-directory"} /\ action \notin AllActorCoverageActions THEN coverage ELSE [coverage EXCEPT !.actions = @ \cup {action}]

ObservePluginEdit(c, p) ==
  /\ c \in PluginClients /\ ScenarioAllowsClient(c) /\ EditOrderAllows(c) /\ NormalClient(c)
  /\ p = ClientPath(c) /\ client.editCount[c] < MaxEdits(c)
  /\ (Scenario # "root-ignore" \/ c = Plugin1 \/ (server.policy = "exclude-a" /\ bridge.projectionCursor > 0))
  /\ (Scenario # "root-ignore-bridge-race" \/ bridge.rustPhase = "Validated")
  /\ client.proposalPhase[c] \in {"Idle", "Terminal"}
  /\ LET n == client.editCount[c] + 1 v == ClientVersion(c, n) IN
       client' = [client EXCEPT !.visible[c][p] = v, !.observed[c] = @ \cup {v}, !.hints[c] = @ \cup {p}, !.editCount[c] = n, !.editPath[c] = p, !.proposalPhase[c] = "Observed",
         !.policy[c] = IF ChangingPolicyScenario /\ c = Plugin1 THEN "exclude-a" ELSE @]
  /\ coverage' = Mark("ObservePluginEdit") /\ lastAction' = "ObservePluginEdit"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

RustValidateWrite ==
  /\ bridge.rustUp /\ BridgeWriteAllowed /\ EditOrderAllows(BridgeNode) /\ bridge.rustPhase = "Idle"
  /\ bridge' = [bridge EXCEPT !.rustPhase = "Validated"]
  /\ coverage' = Mark("RustValidateWrite") /\ lastAction' = "RustValidateWrite"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

RustAtomicVisibleWrite ==
  /\ bridge.rustUp /\ bridge.rustPhase = "Validated" /\ client.visible[BridgeNode][PathA] = BaseVersion
  /\ bridge' = [bridge EXCEPT !.rustPhase = "Written", !.acknowledged = TRUE, !.projectionHealthy = FALSE, !.derivedReady = FALSE]
  /\ client' = [client EXCEPT !.visible[BridgeNode][PathA] = BridgeVersion, !.observed[BridgeNode] = @ \cup {BridgeVersion}, !.editCount[BridgeNode] = 1, !.editPath[BridgeNode] = PathA, !.proposalPhase[BridgeNode] = "Observed"]
  /\ coverage' = Mark("RustAtomicVisibleWrite") /\ lastAction' = "RustAtomicVisibleWrite"
  /\ UNCHANGED <<network, server, directory, ghost>>

NodePersistBridgeHint ==
  /\ bridge.rustUp /\ bridge.rustPhase = "Written" /\ NormalClient(BridgeNode)
  /\ bridge' = [bridge EXCEPT !.rustPhase = "Notified", !.nodeHintDurable = TRUE]
  /\ client' = [client EXCEPT !.hints[BridgeNode] = @ \cup {PathA}]
  /\ coverage' = Mark("NodePersistBridgeHint") /\ lastAction' = "NodePersistBridgeHint"
  /\ UNCHANGED <<network, server, directory, ghost>>

CaptureLocalCommit(c) ==
  /\ NormalClient(c) /\ client.proposalPhase[c] = "Observed" /\ client.hints[c] # {}
  /\ LET v == ClientVersion(c, client.editCount[c]) IN
       /\ v = client.visible[c][client.editPath[c]]
       /\ IF c = BridgeNode /\ PolicyScenario /\ server.policy = "exclude-a"
          THEN /\ client' = [client EXCEPT !.hints[c] = {}, !.proposalPhase[c] = "Terminal"]
               /\ UNCHANGED ghost
          ELSE /\ client' = [client EXCEPT !.localGit[c] = @ \cup {v}, !.capturePublished[c] = @ \cup {v}, !.hints[c] = {}, !.proposalPhase[c] = "Captured"]
               /\ ghost' = [ghost EXCEPT !.captured = @ \cup {v}]
  /\ bridge' = IF c = BridgeNode THEN [bridge EXCEPT !.nodeHintDurable = TRUE] ELSE bridge
  /\ coverage' = [Mark("CaptureLocalCommit") EXCEPT !.actions = @ \cup {IF c = BridgeNode THEN "BridgeNodeCaptured" ELSE "PluginCaptured"}]
  /\ lastAction' = "CaptureLocalCommit" /\ UNCHANGED <<network, server, directory>>

PersistImmutableProposal(c) ==
  /\ NormalClient(c) /\ ScenarioAllowsClient(c) /\ client.proposalPhase[c] = "Captured"
  /\ LET n == client.editCount[c] v == ClientVersion(c, n) a == AttemptId(c, n) t == TransferId(c, n)
         dp == ProposalId(c) di == IntentId(c) plan == PlanId(c) IN
       /\ v \in client.localGit[c] /\ a \in AttemptIds /\ t \in TransferIds
       /\ client' = [client EXCEPT !.queueTarget[c] = v, !.expectedDevice[c] = server.deviceRef[c], !.proposalBase[c] = BaseVersion, !.directoryProposal[c] = dp, !.directoryIntent[c] = di, !.directoryGeneration[c] = n, !.objectPlan[c] = plan, !.attemptId[c] = a, !.transferId[c] = t, !.attemptPolicy[c] = client.policy[c], !.candidateHasA[c] = Scenario = "root-ignore-invalid" \/ client.policy[c] # "exclude-a", !.immutableIdentity[c] = <<<<v, server.deviceRef[c], BaseVersion, dp, plan, a, t>>, client.policy[c]>>, !.proposalPhase[c] = "Queued"]
  /\ coverage' = [Mark("PersistImmutableProposal") EXCEPT !.actorsProposed = @ \cup {c}]
  /\ lastAction' = "PersistImmutableProposal" /\ UNCHANGED <<network, server, bridge, directory, ghost>>

RebuildStaleQueuedProposal(c) ==
  /\ NormalClient(c) /\ ScenarioAllowsClient(c) /\ PolicyScenario /\ c = Plugin1
  /\ client.proposalPhase[c] = "Queued"
  /\ client.attemptPolicy[c] # client.policy[c]
  /\ client.candidateHasA[c]
  /\ client.expectedDevice[c] = server.deviceRef[c]
  /\ LET a == "attempt-rebuild" t == "transfer-rebuild" IN
       /\ client' = [client EXCEPT !.candidateHasA[c] = FALSE, !.attemptId[c] = a, !.transferId[c] = t,
            !.attemptPolicy[c] = client.policy[c],
            !.immutableIdentity[c] = <<<<client.queueTarget[c], client.expectedDevice[c], client.proposalBase[c], client.directoryProposal[c], client.objectPlan[c], a, t>>, client.policy[c]>>]
  /\ coverage' = Mark("RebuildStaleQueuedProposal") /\ lastAction' = "RebuildStaleQueuedProposal"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

ObserveRootPolicyEdit(c) ==
  /\ NormalClient(c) /\ ScenarioAllowsClient(c) /\ Scenario = "root-ignore-stale-queued" /\ c = Plugin1
  /\ client.policy[c] # "exclude-a"
  /\ client.proposalPhase[c] = "Queued"
  /\ client' = [client EXCEPT !.policy[c] = "exclude-a"]
  /\ coverage' = Mark("ObserveRootPolicyEdit") /\ lastAction' = "ObserveRootPolicyEdit"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

PersistEqualRetry(c) ==
  /\ Scenario = "server-recovery" /\ c = Plugin1 /\ NormalClient(c)
  /\ client.proposalPhase[c] = "Terminal" /\ client.editCount[c] = 1 /\ "attempt-equal" \notin server.processedAttempts
  /\ LET v == server.deviceRef[c] IN
       client' = [client EXCEPT !.queueTarget[c] = v, !.expectedDevice[c] = v, !.proposalBase[c] = BaseVersion, !.directoryProposal[c] = ProposalId(c), !.directoryIntent[c] = IntentId(c), !.directoryGeneration[c] = 1, !.objectPlan[c] = PlanId(c), !.attemptId[c] = "attempt-equal", !.transferId[c] = "transfer-equal", !.attemptPolicy[c] = client.policy[c], !.immutableIdentity[c] = <<<<v, v, BaseVersion, ProposalId(c), PlanId(c), "attempt-equal", "transfer-equal">>, client.policy[c]>>, !.proposalPhase[c] = "Queued"]
  /\ coverage' = Mark("PersistEqualRetry") /\ lastAction' = "PersistEqualRetry"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

PersistCoveredQuery(c) ==
  /\ Scenario = "server-recovery" /\ c = Plugin1 /\ NormalClient(c)
  /\ client.proposalPhase[c] = "Terminal" /\ client.editCount[c] = 1 /\ server.deviceRef[c] # BaseVersion /\ "attempt-covered" \notin server.processedAttempts
  /\ client' = [client EXCEPT !.queueTarget[c] = BaseVersion, !.expectedDevice[c] = server.deviceRef[c], !.proposalBase[c] = BaseVersion, !.directoryProposal[c] = ProposalId(c), !.directoryIntent[c] = IntentId(c), !.directoryGeneration[c] = 1, !.objectPlan[c] = PlanId(c), !.attemptId[c] = "attempt-covered", !.transferId[c] = "transfer-covered", !.attemptPolicy[c] = client.policy[c], !.immutableIdentity[c] = <<<<BaseVersion, server.deviceRef[c], BaseVersion, ProposalId(c), PlanId(c), "attempt-covered", "transfer-covered">>, client.policy[c]>>, !.proposalPhase[c] = "Queued"]
  /\ coverage' = Mark("PersistCoveredQuery") /\ lastAction' = "PersistCoveredQuery"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

SendProposalRequest(c) ==
  /\ NormalClient(c) /\ client.proposalPhase[c] \in {"Queued", "Transferring"}
  /\ client.capable[c] /\ server.policyActive
  /\ (Scenario \notin {"all-actors", "disjoint-directory"} \/
       ((c = Plugin1 /\ client.editCount[Plugin1] = 1) \/
        (c = Plugin2 /\ client.proposalPhase[Plugin1] = "Terminal") \/
        (c = BridgeNode /\ client.proposalPhase[Plugin1] = "Terminal" /\
          (Scenario # "all-actors" \/ client.proposalPhase[Plugin2] = "Terminal"))))
  /\ Cardinality(network.requestBag) < MaxMessages * Cardinality(Clients)
  /\ Request(c, 1) \notin network.requestBag
  /\ network' = [network EXCEPT !.requestBag = @ \cup {Request(c, 1)}]
  /\ client' = [client EXCEPT !.proposalPhase[c] = "Transferring"]
  /\ coverage' = Mark("SendProposalRequest") /\ lastAction' = "SendProposalRequest"
  /\ UNCHANGED <<server, bridge, directory, ghost>>

DelayProposalRequest(c) ==
  /\ NetworkFaultActor(c) /\ Request(c, 1) \in network.requestBag
  /\ MessageKey(Request(c, 1)) \notin network.delayedRequests
  /\ network' = [network EXCEPT !.delayedRequests = @ \cup {MessageKey(Request(c, 1))}]
  /\ coverage' = Mark("DelayProposalRequest") /\ lastAction' = "DelayProposalRequest"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DuplicateProposalRequest(c) ==
  /\ NetworkFaultActor(c) /\ (Scenario # "all-actors" \/ MessageKey(Request(c, 1)) \in network.delayedRequests)
  /\ Request(c, 1) \in network.requestBag /\ Request(c, 2) \notin network.requestBag
  /\ network' = [network EXCEPT !.requestBag = @ \cup {Request(c, 2)}]
  /\ coverage' = Mark("DuplicateProposalRequest") /\ lastAction' = "DuplicateProposalRequest"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DropProposalRequest(c, copy) ==
  /\ NetworkFaultCopy(c, copy) /\ (Scenario # "all-actors" \/ copy = 2)
  /\ Request(c, copy) \in network.requestBag
  /\ MessageKey(Request(c, copy)) \notin network.droppedRequests
  /\ network' = [network EXCEPT !.droppedRequests = @ \cup {MessageKey(Request(c, copy))}]
  /\ coverage' = Mark("DropProposalRequest") /\ lastAction' = "DropProposalRequest"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DeliverProposalRequest(c, copy) ==
  /\ (Scenario # "all-actors" \/ copy = 2 \/ MessageKey(Request(c, 1)) \notin network.delayedRequests)
  /\ Request(c, copy) \in network.requestBag
  /\ MessageKey(Request(c, copy)) \notin network.droppedRequests
  /\ MessageKey(Request(c, copy)) \notin network.deliveredRequests
  /\ network' = [network EXCEPT !.deliveredRequests = @ \cup {MessageKey(Request(c, copy))}]
  /\ coverage' = Mark("DeliverProposalRequest") /\ lastAction' = "DeliverProposalRequest"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

ServerStartProposal(c, copy) ==
  /\ NormalServer /\ server.opPhase \in {"Idle", "Committed", "Aborted"}
  /\ MessageKey(Request(c, copy)) \in network.deliveredRequests
  /\ client.attemptId[c] \notin server.processedAttempts
  /\ server' = [server EXCEPT !.opType = "device_push", !.opActor = c, !.opTarget = client.queueTarget[c], !.opPath = client.editPath[c], !.opExpected = client.expectedDevice[c], !.opAttempt = client.attemptId[c], !.opTransfer = client.transferId[c], !.opDirectoryProposal = client.directoryProposal[c], !.opDirectoryIntent = client.directoryIntent[c], !.opDirectoryGeneration = client.directoryGeneration[c], !.opBaseEpoch = server.mainEpoch, !.opBaseEvent = server.eventSeq, !.opObjectPlan = client.objectPlan[c], !.opPolicy = client.attemptPolicy[c], !.opCandidateHasA = client.candidateHasA[c], !.classification = "None", !.opPhase = "Started", !.casKind = "none", !.casSideEffect = FALSE, !.casObserved = "None", !.casMetadataCommitted = FALSE, !.expectedEffects = {}, !.committedEffects = {}]
  /\ coverage' = Mark("ServerStartProposal") /\ lastAction' = "ServerStartProposal"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

RejectExcludedCandidate ==
  /\ NormalServer /\ server.opPhase = "Started" /\ server.opPolicy = "exclude-a"
  /\ server.opCandidateHasA
  /\ server' = [server EXCEPT !.opPhase = "Aborted",
       !.processedAttempts = @ \cup {server.opAttempt},
       !.processCount[server.opAttempt] = @ + 1,
       !.resultByAttempt[server.opAttempt] = "rejected"]
  /\ coverage' = Mark("RejectExcludedCandidate") /\ lastAction' = "RejectExcludedCandidate"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ServerValidateProposal ==
  /\ NormalServer /\ server.opPhase = "Started"
  /\ server.opTarget \in client.localGit[server.opActor]
  /\ (~ChangingPolicyScenario \/ (server.opPolicy = PolicyOfTarget(server.opTarget) /\
       (server.opPolicy # "exclude-a" \/ (server.opPath = PathB /\ ~server.opCandidateHasA))))
  /\ server' = [server EXCEPT !.opPhase = "Validated", !.accepted = @ \cup {server.opTarget}, !.processingRoots = @ \cup {server.opTarget}]
  /\ coverage' = Mark("ServerValidateProposal") /\ lastAction' = "ServerValidateProposal"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ClassifyProposal ==
  /\ NormalServer /\ server.opPhase = "Validated"
  /\ (~ChangingPolicyScenario \/ server.opPolicy = server.policy \/
       (server.opActor = Plugin1 /\ server.opPolicy = "exclude-a" /\ server.policy = "empty"))
  /\ LET relation == IF server.opTarget = server.deviceRef[server.opActor] THEN "Equal"
                     ELSE IF server.opTarget \in server.deviceHistory[server.opActor] THEN "Covered"
                     ELSE IF server.opActor = Plugin1 /\ client.editCount[Plugin1] = 2 THEN "Divergent"
                     ELSE "Descendant" IN
       /\ server' = [server EXCEPT !.classification = relation, !.opPhase = "Classified"]
       /\ coverage' = [Mark("ClassifyProposal") EXCEPT !.classifications = @ \cup {relation}]
  /\ lastAction' = "ClassifyProposal" /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ClassifyStalePolicyProposal ==
  /\ Scenario = "root-ignore" /\ NormalServer /\ server.opPhase = "Validated"
  /\ server.opPolicy # server.policy /\ server.policy = "exclude-a"
  /\ server' = [server EXCEPT !.classification = "Divergent", !.opPhase = "Classified"]
  /\ coverage' = [Mark("ClassifyStalePolicyProposal") EXCEPT !.classifications = @ \cup {"Divergent"}]
  /\ lastAction' = "ClassifyStalePolicyProposal"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ActivateLegacyPolicy ==
  /\ Scenario = "root-ignore-legacy" /\ NormalServer /\ ~server.policyActive
  /\ server.policy = "exclude-a" /\ client.capable[Plugin1]
  /\ server' = [server EXCEPT !.policyActive = TRUE, !.mainTree[PathA] = {},
       !.mainEpoch = @ + 1, !.eventTree[PathA] = {}, !.eventSeq = @ + 1,
       !.eventPolicy = "exclude-a"]
  /\ bridge' = [bridge EXCEPT !.preservedAtPolicy = client.visible[BridgeNode][PathA]]
  /\ coverage' = Mark("ActivateLegacyPolicy") /\ lastAction' = "ActivateLegacyPolicy"
  /\ UNCHANGED <<client, network, directory, ghost>>

UpgradeOldClient ==
  /\ Scenario \in {"root-ignore", "root-ignore-legacy"} /\ server.policyActive
  /\ server.policy = "exclude-a" /\ bridge.projectionCursor > 0 /\ ~client.capable[Plugin2]
  /\ client' = [client EXCEPT !.capable[Plugin2] = TRUE]
  /\ coverage' = Mark("UpgradeOldClient") /\ lastAction' = "UpgradeOldClient"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

PrepareDeviceCAS ==
  /\ NormalServer /\ server.opPhase = "Classified" /\ server.classification = "Descendant"
  /\ (~ChangingPolicyScenario \/ server.opPolicy = "empty" \/ server.opPath = PathB)
  /\ server' = [server EXCEPT !.casKind = "device", !.casOld = server.opExpected, !.casTarget = server.opTarget, !.casActual = server.deviceRef[server.opActor], !.casSideEffect = FALSE, !.casObserved = "None", !.casMetadataCommitted = FALSE, !.opPhase = "CASPrepared"]
  /\ coverage' = Mark("PrepareDeviceCAS") /\ lastAction' = "PrepareDeviceCAS"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ApplyCASSideEffect ==
  /\ NormalServer /\ server.opPhase = "CASPrepared" /\ server.casActual = server.casOld
  /\ server' = [server EXCEPT !.casActual = server.casTarget, !.casSideEffect = TRUE, !.opPhase = "CASSideEffect"]
  /\ coverage' = Mark("ApplyCASSideEffect") /\ lastAction' = "ApplyCASSideEffect"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ObserveCASResult(observation) ==
  /\ NormalServer /\ server.opPhase \in {"CASPrepared", "CASSideEffect"}
  /\ observation \in CASObservations \ {"None"}
  /\ (Scenario \in {"live-proposal", "live-bridge", "live-recovery", "live-apply"} => observation = "Target")
  /\ (observation = "Old" => server.casActual = server.casOld)
  /\ (observation = "Target" => server.casActual = server.casTarget)
  /\ (observation = "Foreign" => server.casActual \notin {server.casOld, server.casTarget})
  /\ server' = [server EXCEPT !.casObserved = observation, !.opPhase = "CASObserved"]
  /\ coverage' = [Mark("ObserveCASResult") EXCEPT !.actions = @ \cup {"CAS" \o observation}]
  /\ lastAction' = "ObserveCASResult" /\ UNCHANGED <<client, network, bridge, directory, ghost>>

CommitCASMetadata ==
  /\ NormalServer /\ server.opPhase = "CASObserved" /\ server.casObserved = "Target"
  /\ IF server.casKind = "device"
       THEN server' = [server EXCEPT !.deviceRef[server.opActor] = server.opTarget, !.deviceHistory[server.opActor] = @ \cup {server.opTarget}, !.casMetadataCommitted = TRUE, !.opPhase = "DeviceCommitted"]
       ELSE IF server.casKind = "main"
         THEN server' = [server EXCEPT !.mainEpoch = @ + 1, !.mainTree[server.opPath] = @ \cup {server.opTarget}, !.mainHistory = @ \cup {server.opTarget}, !.casMetadataCommitted = TRUE, !.opPhase = "MainMoved"]
         ELSE server' = [server EXCEPT !.conflictCurrent = server.casTarget, !.protectCurrent = TRUE, !.conflictRoots = @ \cup {server.casTarget}, !.casMetadataCommitted = TRUE, !.opPhase = "ConflictMetadata"]
  /\ coverage' = Mark("CommitCASMetadata") /\ lastAction' = "CommitCASMetadata"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

HandleEqualOrCovered ==
  /\ NormalServer /\ server.opPhase = "Classified" /\ server.classification \in {"Equal", "Covered"}
  /\ server' = [server EXCEPT !.opPhase = "Committed", !.processedAttempts = @ \cup {server.opAttempt}, !.processCount[server.opAttempt] = @ + 1, !.resultByAttempt[server.opAttempt] = "accepted", !.processingRoots = @ \ {server.opTarget}]
  /\ coverage' = Mark("HandleEqualOrCovered") /\ lastAction' = "HandleEqualOrCovered"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ServerPrepareIntegration ==
  /\ NormalServer /\ server.opPhase = "DeviceCommitted"
  /\ server' = [server EXCEPT !.opPhase = "IntegrationPrepared"]
  /\ coverage' = Mark("ServerPrepareIntegration") /\ lastAction' = "ServerPrepareIntegration"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

IntegrationDiverges == server.opType = "device_push" /\ server.mainTree[server.opPath] # {BaseVersion} /\ server.opTarget \notin server.mainTree[server.opPath]

PrepareMainCAS ==
  /\ NormalServer /\ server.opPhase = "IntegrationPrepared" /\ ~IntegrationDiverges
  /\ LET currentMain == CHOOSE x \in server.mainHistory: TRUE IN
       server' = [server EXCEPT !.casKind = "main", !.casOld = currentMain, !.casTarget = server.opTarget, !.casActual = currentMain, !.casSideEffect = FALSE, !.casObserved = "None", !.casMetadataCommitted = FALSE, !.opPhase = "CASPrepared"]
  /\ coverage' = Mark("PrepareMainCAS") /\ lastAction' = "PrepareMainCAS"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

BeginConflictMetadata ==
  /\ NormalServer
  /\ \/ server.opPhase = "Classified" /\ server.classification = "Divergent"
     \/ server.opPhase = "IntegrationPrepared" /\ IntegrationDiverges
  /\ server.opTarget # NoVersion /\ BaseVersion # NoVersion
  /\ server' = [server EXCEPT !.opPhase = "ConflictMetadata", !.conflictMetadata = TRUE, !.conflictEvent = TRUE, !.reviewNeeded = TRUE, !.protectBase = FALSE, !.protectCurrent = FALSE, !.protectDevice = FALSE, !.conflictBase = BaseVersion, !.conflictCurrent = IF server.mainTree[server.opPath] = {} THEN BaseVersion ELSE CHOOSE v \in server.mainTree[server.opPath]: TRUE, !.conflictDevice = server.opTarget]
  /\ coverage' = Mark("BeginConflictMetadata") /\ lastAction' = "BeginConflictMetadata"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ProtectConflictBase ==
  /\ NormalServer /\ server.opPhase = "ConflictMetadata" /\ server.conflictMetadata /\ ~server.protectBase
  /\ server' = [server EXCEPT !.protectBase = TRUE, !.conflictRoots = @ \cup {server.conflictBase}]
  /\ coverage' = [Mark("ProtectConflictBase") EXCEPT !.conflictPartial = TRUE]
  /\ lastAction' = "ProtectConflictBase" /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ProtectConflictCurrent ==
  /\ NormalServer /\ server.opPhase = "ConflictMetadata" /\ server.conflictMetadata /\ ~server.protectCurrent
  /\ server' = [server EXCEPT !.protectCurrent = TRUE, !.conflictRoots = @ \cup {server.conflictCurrent}]
  /\ coverage' = [Mark("ProtectConflictCurrent") EXCEPT !.conflictPartial = TRUE]
  /\ lastAction' = "ProtectConflictCurrent" /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ProtectConflictDevice ==
  /\ NormalServer /\ server.opPhase = "ConflictMetadata" /\ server.conflictMetadata /\ ~server.protectDevice
  /\ server' = [server EXCEPT !.protectDevice = TRUE, !.conflictRoots = @ \cup {server.conflictDevice}]
  /\ coverage' = [Mark("ProtectConflictDevice") EXCEPT !.conflictPartial = TRUE]
  /\ lastAction' = "ProtectConflictDevice" /\ UNCHANGED <<client, network, bridge, directory, ghost>>

CommitConflictResult ==
  /\ NormalServer /\ server.opPhase = "ConflictMetadata" /\ server.protectBase /\ server.protectCurrent /\ server.protectDevice
  /\ server' = [server EXCEPT !.opPhase = "Committed", !.processedAttempts = @ \cup {server.opAttempt}, !.processCount[server.opAttempt] = @ + 1, !.resultByAttempt[server.opAttempt] = "conflicted", !.processingRoots = @ \ {server.opTarget}]
  /\ coverage' = Mark("CommitConflictResult") /\ lastAction' = "CommitConflictResult"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

CommitIntegrationEffects ==
  /\ NormalServer /\ server.opPhase = "MainMoved" /\ server.opType = "device_push"
  /\ server' = [server EXCEPT !.opPhase = "Committed", !.eventSeq = @ + 1,
      !.policy = IF ChangingPolicyScenario THEN server.opPolicy ELSE @,
      !.mainTree = IF ChangingPolicyScenario /\ server.opPolicy = "exclude-a" THEN [@ EXCEPT ![PathA] = {}] ELSE @,
      !.eventTree = IF ChangingPolicyScenario /\ server.opPolicy = "exclude-a" THEN [server.mainTree EXCEPT ![PathA] = {}] ELSE server.mainTree,
      !.eventPolicy = IF ChangingPolicyScenario THEN server.opPolicy ELSE @, !.processedAttempts = @ \cup {server.opAttempt}, !.processCount[server.opAttempt] = @ + 1, !.resultByAttempt[server.opAttempt] = "accepted", !.processingRoots = @ \ {server.opTarget}]
  /\ directory' = [directory EXCEPT !.proposalId = server.opDirectoryProposal, !.intentId = server.opDirectoryIntent, !.generation = server.opDirectoryGeneration, !.baseMainEpoch = server.opBaseEpoch, !.baseEventSeq = server.opBaseEvent, !.prepared = TRUE, !.committed = TRUE, !.resultProposal = server.opDirectoryProposal, !.resultEvent = server.eventSeq + 1, !.eventProposal = server.opDirectoryProposal]
  /\ bridge' = IF ChangingPolicyScenario /\ server.opPolicy = "exclude-a"
       THEN [bridge EXCEPT !.preservedAtPolicy = client.visible[BridgeNode][PathA]] ELSE bridge
  /\ coverage' = Mark("CommitIntegrationEffects") /\ lastAction' = "CommitIntegrationEffects"
  /\ UNCHANGED <<client, network, ghost>>

CommitConflictResolutionEffects ==
  /\ NormalServer /\ server.opPhase = "MainMoved" /\ server.opType = "conflict_resolve"
  /\ server' = [server EXCEPT !.opPhase = "Committed", !.eventSeq = @ + 1, !.eventTree = server.mainTree, !.committedEffects = server.expectedEffects, !.reviewNeeded = FALSE]
  /\ coverage' = Mark("CommitConflictResolutionEffects") /\ lastAction' = "CommitConflictResolutionEffects"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

SendStoredReply(c) ==
  /\ NormalServer /\ client.attemptId[c] \in AttemptIds
  /\ client.attemptId[c] \in server.processedAttempts /\ server.resultByAttempt[client.attemptId[c]] # NoResult
  /\ Reply(c, 1) \notin network.replyBag
  /\ network' = [network EXCEPT !.replyBag = @ \cup {Reply(c, 1)}]
  /\ coverage' = Mark("SendStoredReply") /\ lastAction' = "SendStoredReply"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DuplicateProposalReply(c) ==
  /\ NetworkFaultActor(c) /\ (Scenario # "all-actors" \/ MessageKey(Reply(c, 1)) \in network.delayedReplies)
  /\ client.attemptId[c] \in AttemptIds /\ Reply(c, 1) \in network.replyBag /\ Reply(c, 2) \notin network.replyBag
  /\ network' = [network EXCEPT !.replyBag = @ \cup {Reply(c, 2)}]
  /\ coverage' = Mark("DuplicateProposalReply") /\ lastAction' = "DuplicateProposalReply"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DelayProposalReply(c, copy) ==
  /\ NetworkFaultCopy(c, copy) /\ (Scenario # "all-actors" \/ copy = 1)
  /\ client.attemptId[c] \in AttemptIds /\ Reply(c, copy) \in network.replyBag
  /\ MessageKey(Reply(c, copy)) \notin network.delayedReplies
  /\ network' = [network EXCEPT !.delayedReplies = @ \cup {MessageKey(Reply(c, copy))}]
  /\ coverage' = Mark("DelayProposalReply") /\ lastAction' = "DelayProposalReply"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DropProposalReply(c, copy) ==
  /\ (NetworkFaultCopy(c, copy) \/ (Scenario = "live-proposal" /\ copy = 1))
  /\ (Scenario # "all-actors" \/ copy = 2) /\ client.attemptId[c] \in AttemptIds /\ Reply(c, copy) \in network.replyBag
  /\ MessageKey(Reply(c, copy)) \notin network.droppedReplies
  /\ network' = [network EXCEPT !.droppedReplies = @ \cup {MessageKey(Reply(c, copy))}]
  /\ coverage' = [Mark("DropProposalReply") EXCEPT !.replyLostAfterOutcome = client.attemptId[c] \in server.processedAttempts]
  /\ lastAction' = "DropProposalReply" /\ UNCHANGED <<client, server, bridge, directory, ghost>>

DeliverProposalReply(c, copy) ==
  /\ (Scenario # "all-actors" \/ copy = 2 \/ MessageKey(Reply(c, 1)) \notin network.delayedReplies)
  /\ client.attemptId[c] \in AttemptIds /\ Reply(c, copy) \in network.replyBag /\ MessageKey(Reply(c, copy)) \notin network.droppedReplies /\ MessageKey(Reply(c, copy)) \notin network.deliveredReplies
  /\ network' = [network EXCEPT !.deliveredReplies = @ \cup {MessageKey(Reply(c, copy))}]
  /\ coverage' = Mark("DeliverProposalReply") /\ lastAction' = "DeliverProposalReply"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

RetryOrQueryStable(c) ==
  /\ NormalClient(c) /\ client.proposalPhase[c] = "Transferring"
  /\ \E copy \in Copies: MessageKey(Request(c, copy)) \in network.droppedRequests \/ MessageKey(Reply(c, copy)) \in network.droppedReplies
  /\ network' = IF client.attemptId[c] \in server.processedAttempts
                  THEN [network EXCEPT !.replyBag = @ \cup {Reply(c, 2)}]
                  ELSE [network EXCEPT !.requestBag = @ \cup {Request(c, 1)}]
  /\ coverage' = Mark("RetryOrQueryStable") /\ lastAction' = "RetryOrQueryStable"
  /\ UNCHANGED <<client, server, bridge, directory, ghost>>

ConsumeProposalResult(c) ==
  /\ NormalClient(c) /\ client.proposalPhase[c] = "Transferring"
  /\ \E copy \in Copies: MessageKey(Reply(c, copy)) \in network.deliveredReplies
  /\ LET attempt == client.attemptId[c] IN
       network' = [network EXCEPT
         !.requestBag = {m \in @: m.attempt # attempt},
         !.delayedRequests = {k \in @: k[3] # attempt},
         !.droppedRequests = {k \in @: k[3] # attempt},
         !.deliveredRequests = {k \in @: k[3] # attempt},
         !.replyBag = {m \in @: m.attempt # attempt},
         !.delayedReplies = {k \in @: k[3] # attempt},
         !.droppedReplies = {k \in @: k[3] # attempt},
         !.deliveredReplies = {k \in @: k[3] # attempt}]
  /\ client' = [client EXCEPT !.proposalPhase[c] = "Terminal"]
  /\ coverage' = Mark("ConsumeProposalResult") /\ lastAction' = "ConsumeProposalResult"
  /\ UNCHANGED <<server, bridge, directory, ghost>>

PollCommittedEvent(c) ==
  /\ ApplyAllowed(c) /\ NormalClient(c) /\ client.capable[c] /\ server.policyActive
  /\ (Scenario # "root-ignore" \/ client.proposalPhase[Plugin2] = "Terminal")
  /\ (Scenario # "all-actors" \/ "DropProposalRequest" \in coverage.actions) /\ server.eventSeq > client.seenCursor[c]
  /\ client' = [client EXCEPT !.seenCursor[c] = server.eventSeq]
  /\ coverage' = Mark("PollCommittedEvent") /\ lastAction' = "PollCommittedEvent"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

PlanLocalApply(c) ==
  /\ ApplyAllowed(c) /\ NormalClient(c) /\ client.capable[c] /\ server.policyActive /\ client.applyPhase[c] = "Idle" /\ client.seenCursor[c] > client.appliedCursor[c]
  /\ client' = [client EXCEPT !.applyPhase[c] = "Planned", !.journalPresent[c] = TRUE, !.preflight[c] = client.visible[c][PathA], !.durableApplied[c] = FALSE,
       !.journalPolicy[c] = server.eventPolicy, !.localOnly[c] = PolicyScenario /\ server.eventPolicy = "exclude-a"]
  \* The pull delivering this apply carried a directory snapshot through the
  \* then-current main; the server retains that evidence until acknowledgement.
  /\ server' = [server EXCEPT !.deliveredAckEpoch[c] = server.mainEpoch]
  /\ coverage' = Mark("PlanLocalApply") /\ lastAction' = "PlanLocalApply"
  /\ UNCHANGED <<network, bridge, directory, ghost>>

PublishApplyRecovery(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "Planned"
  /\ client' = [client EXCEPT !.applyPhase[c] = "RecoveryPublished", !.recoveryRoots[c] = @ \cup {client.preflight[c]}]
  /\ coverage' = Mark("PublishApplyRecovery") /\ lastAction' = "PublishApplyRecovery"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

BeginLocalMutation(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "RecoveryPublished"
  /\ client' = [client EXCEPT !.applyPhase[c] = "Writing"]
  /\ coverage' = Mark("BeginLocalMutation") /\ lastAction' = "BeginLocalMutation"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

MutateWithFreshIdentity(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "Writing" /\ client.visible[c][PathA] = client.preflight[c]
  /\ client' = IF client.localOnly[c] THEN [client EXCEPT !.applyPhase[c] = "Verifying"]
       ELSE [client EXCEPT !.visible[c][PathA] = CHOOSE v \in server.mainTree[PathA]: TRUE, !.displaced[c] = @ \cup {client.preflight[c]}, !.applyPhase[c] = "Verifying"]
  /\ ghost' = IF client.localOnly[c] THEN ghost ELSE [ghost EXCEPT !.overwritten = @ \cup {client.preflight[c]}]
  /\ coverage' = Mark("MutateWithFreshIdentity") /\ lastAction' = "MutateWithFreshIdentity"
  /\ UNCHANGED <<network, server, bridge, directory>>

VerifyLocalApply(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "Verifying"
  /\ client' = [client EXCEPT !.applyPhase[c] = "RefsCommitted", !.localMainEpoch[c] = server.mainEpoch]
  /\ coverage' = Mark("VerifyLocalApply") /\ lastAction' = "VerifyLocalApply"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

CommitLocalCoordination(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "RefsCommitted"
  /\ client' = [client EXCEPT !.applyPhase[c] = "CoordinationCommitted", !.durableApplied[c] = TRUE, !.appliedCursor[c] = client.seenCursor[c]]
  /\ coverage' = Mark("CommitLocalCoordination") /\ lastAction' = "CommitLocalCoordination"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

PersistApplyAckIntent(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "CoordinationCommitted"
  /\ client' = [client EXCEPT !.applyPhase[c] = "AckIntent", !.ackIntent[c] = TRUE]
  /\ coverage' = Mark("PersistApplyAckIntent") /\ lastAction' = "PersistApplyAckIntent"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

CleanupApplyJournal(c) ==
  /\ NormalClient(c) /\ client.applyPhase[c] = "AckIntent"
  /\ client' = [client EXCEPT !.applyPhase[c] = "Cleaned", !.journalPresent[c] = FALSE]
  /\ coverage' = Mark("CleanupApplyJournal") /\ lastAction' = "CleanupApplyJournal"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

\* Acknowledgement evidence mirrors the server ack contract: the applied epoch is
\* resolvable through the current main, the retained delivered snapshot, or
\* reconstruction from contiguous retained event history.
AcknowledgeEvidence(c) ==
  \/ client.localMainEpoch[c] = server.mainEpoch
  \/ client.localMainEpoch[c] = server.deliveredAckEpoch[c]
  \/ server.historyRetained

AcknowledgeLabel(c) ==
  IF client.localMainEpoch[c] = server.mainEpoch THEN "AcknowledgeDurableApply" ELSE "AcknowledgeHistorical"

AcknowledgeDurableApply(c) ==
  /\ NormalServer /\ NormalClient(c) /\ client.capable[c] /\ server.policyActive /\ client.ackIntent[c] /\ client.durableApplied[c] /\ AcknowledgeEvidence(c)
  /\ server' = [server EXCEPT !.lastAppliedEpoch[c] = client.localMainEpoch[c]]
  /\ coverage' = Mark(AcknowledgeLabel(c)) /\ lastAction' = AcknowledgeLabel(c)
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

EvictDeliveredAckSnapshot ==
  /\ FaultMode = "EvictDeliveredAckSnapshot" /\ NormalServer /\ client.ackIntent[Plugin2] /\ client.durableApplied[Plugin2]
  /\ client.localMainEpoch[Plugin2] < server.mainEpoch
  /\ server' = [server EXCEPT !.deliveredAckEpoch[Plugin2] = server.mainEpoch]
  /\ coverage' = Mark("EvictDeliveredAckSnapshot") /\ lastAction' = "EvictDeliveredAckSnapshot"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

LoseAllAckEvidence ==
  /\ FaultMode = "LoseAllAckEvidence" /\ NormalServer /\ client.ackIntent[Plugin2] /\ client.durableApplied[Plugin2]
  /\ client.localMainEpoch[Plugin2] < server.mainEpoch
  /\ server' = [server EXCEPT !.deliveredAckEpoch[Plugin2] = server.mainEpoch, !.historyRetained = FALSE]
  /\ coverage' = Mark("LoseAllAckEvidence") /\ lastAction' = "LoseAllAckEvidence"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

PrepareDirectoryTombstone ==
  /\ Scenario \in {"disjoint-directory", "all-actors"}
  /\ (Scenario # "disjoint-directory" \/ "AdvanceProjectionCursor" \in coverage.actions) /\ AllScenarioProposalsTerminal /\ NormalServer /\ server.eventSeq > 0 /\ ~directory.canonicalTombstone /\ directory.proposalId # NoProposal
  /\ directory' = [directory EXCEPT !.canonicalTombstone = TRUE, !.prepared = TRUE, !.committed = FALSE]
  /\ coverage' = Mark("PrepareDirectoryTombstone") /\ lastAction' = "PrepareDirectoryTombstone"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

CommitDirectoryTombstone ==
  /\ NormalServer /\ directory.canonicalTombstone /\ directory.prepared /\ ~directory.committed
  /\ directory' = [directory EXCEPT !.committed = TRUE, !.resultProposal = directory.proposalId, !.resultEvent = server.eventSeq, !.eventProposal = directory.proposalId, !.localDeletionTarget[Plugin1] = directory.proposalId]
  /\ coverage' = Mark("CommitDirectoryTombstone") /\ lastAction' = "CommitDirectoryTombstone"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

ObserveDirectoryDescendant(c) ==
  /\ c = Plugin1 /\ Scenario \in {"disjoint-directory", "all-actors"}
  /\ (Scenario \notin {"all-actors", "disjoint-directory"} \/ bridge.projectionCursor > 0) /\ NormalClient(c) /\ directory.committed /\ directory.localPresent[c] /\ ~directory.descendantObserved[c]
  /\ directory' = [directory EXCEPT !.descendantPresent[c] = TRUE, !.descendantObserved[c] = TRUE, !.localEmpty[c] = FALSE, !.localIdentity[c] = @ + 1]
  /\ coverage' = Mark("ObserveDirectoryDescendant") /\ lastAction' = "ObserveDirectoryDescendant"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

RemoveDirectoryDescendant(c) ==
  /\ c = Plugin1 /\ directory.localPresent[c] /\ directory.descendantPresent[c]
  /\ directory' = [directory EXCEPT !.descendantPresent[c] = FALSE, !.localEmpty[c] = TRUE, !.localIdentity[c] = @ + 1]
  /\ coverage' = Mark("RemoveDirectoryDescendant") /\ lastAction' = "RemoveDirectoryDescendant"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

PreflightEmptyDirectory(c) ==
  /\ c = Plugin1 /\ NormalClient(c) /\ directory.committed /\ directory.canonicalTombstone
  /\ directory.localDeletionTarget[c] = directory.resultProposal /\ directory.localPresent[c] /\ directory.localEmpty[c]
  /\ directory' = [directory EXCEPT !.preflightIdentity[c] = directory.localIdentity[c]]
  /\ coverage' = Mark("PreflightEmptyDirectory") /\ lastAction' = "PreflightEmptyDirectory"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

DeleteEmptyDirectory(c) ==
  /\ c = Plugin1 /\ NormalClient(c) /\ directory.committed /\ directory.canonicalTombstone
  /\ directory.localDeletionTarget[c] = directory.resultProposal /\ directory.localEmpty[c]
  /\ directory.preflightIdentity[c] = directory.localIdentity[c]
  /\ directory' = [directory EXCEPT !.localPresent[c] = FALSE, !.deletedUnderProposal[c] = directory.resultProposal, !.deletedIdentity[c] = directory.localIdentity[c]]
  /\ coverage' = Mark("DeleteEmptyDirectory") /\ lastAction' = "DeleteEmptyDirectory"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

BeginProjection ==
  /\ bridge.rustUp /\ NormalClient(BridgeNode) /\ server.policyActive
  /\ (Scenario # "all-actors" \/ (AllScenarioProposalsTerminal /\ "RecoverServerOperation" \in coverage.actions))
  /\ (Scenario # "disjoint-directory" \/ client.proposalPhase[BridgeNode] = "Terminal")
  /\ (PolicyScenario => server.policy = "exclude-a" /\ server.eventSeq > 0 /\ (Scenario # "root-ignore" \/ client.proposalPhase[Plugin1] = "Terminal"))
  /\ (PolicyScenario \/ BridgeVersion \in client.localGit[BridgeNode]) /\ bridge.projectionCursor < server.mainEpoch + 1
  /\ bridge' = [bridge EXCEPT !.projectionTarget = server.mainEpoch + 1, !.projectionPolicy = server.policy, !.manifestVerified = FALSE, !.baseVerified = FALSE, !.pathOidsVerified = FALSE, !.rowsComplete = FALSE, !.projectionHealthy = FALSE, !.derivedReady = FALSE]
  /\ coverage' = Mark("BeginProjection") /\ lastAction' = "BeginProjection"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

VerifyProjectionManifest ==
  /\ bridge.rustUp /\ bridge.projectionTarget > bridge.projectionCursor
  /\ bridge' = [bridge EXCEPT !.manifestVerified = TRUE]
  /\ coverage' = Mark("VerifyProjectionManifest") /\ lastAction' = "VerifyProjectionManifest"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

VerifyProjectionBase ==
  /\ bridge.rustUp /\ bridge.manifestVerified /\ ~bridge.baseVerified
  /\ bridge' = [bridge EXCEPT !.baseVerified = TRUE]
  /\ coverage' = Mark("VerifyProjectionBase") /\ lastAction' = "VerifyProjectionBase"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

VerifyProjectionPathOids ==
  /\ bridge.rustUp /\ bridge.baseVerified /\ ~bridge.pathOidsVerified
  /\ bridge' = [bridge EXCEPT !.pathOidsVerified = TRUE]
  /\ coverage' = Mark("VerifyProjectionPathOids") /\ lastAction' = "VerifyProjectionPathOids"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

WriteDerivedProjection ==
  /\ bridge.rustUp /\ bridge.manifestVerified /\ bridge.baseVerified /\ bridge.pathOidsVerified
  /\ bridge.projectionPolicy = server.policy
  /\ bridge' = [bridge EXCEPT !.rowsComplete = TRUE, !.projectedPaths = IF bridge.projectionPolicy = "exclude-a" THEN Paths \ {PathA} ELSE Paths]
  /\ coverage' = Mark("WriteDerivedProjection") /\ lastAction' = "WriteDerivedProjection"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

AdvanceProjectionCursor ==
  /\ bridge.rustUp /\ bridge.manifestVerified /\ bridge.baseVerified /\ bridge.pathOidsVerified /\ bridge.rowsComplete
  /\ bridge.projectionPolicy = server.policy
  /\ bridge' = [bridge EXCEPT !.projectionCursor = bridge.projectionTarget, !.projectionHealthy = TRUE, !.derivedReady = TRUE, !.projectionFailure = FALSE, !.cursorPublishedVerified = TRUE]
  /\ coverage' = Mark("AdvanceProjectionCursor") /\ lastAction' = "AdvanceProjectionCursor"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

FailProjection ==
  /\ bridge.rustUp /\ bridge.projectionTarget > bridge.projectionCursor /\ ~bridge.rowsComplete
  /\ bridge' = [bridge EXCEPT !.projectionFailure = TRUE, !.projectionHealthy = FALSE, !.derivedReady = FALSE]
  /\ coverage' = Mark("FailProjection") /\ lastAction' = "FailProjection"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

CrashClient(c) ==
  /\ ClientCrashAllowed(c) /\ NormalClient(c) /\ client.crashCount[c] < MaxClientCrashes
  /\ (Scenario # "all-actors" \/ (bridge.nodeHintDurable /\ client.proposalPhase[c] = "Observed"))
  /\ client' = [client EXCEPT !.up[c] = FALSE, !.crashCount[c] = @ + 1]
  /\ coverage' = Mark("CrashClient") /\ lastAction' = "CrashClient"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

RestartClient(c) ==
  /\ ~client.up[c]
  /\ (Scenario # "all-actors" \/ "CrashClient" \in coverage.actions)
  /\ client' = [client EXCEPT !.up[c] = TRUE, !.recovering[c] = TRUE]
  /\ coverage' = Mark("RestartClient") /\ lastAction' = "RestartClient"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

ClassifyClientRestart(c) ==
  /\ client.up[c] /\ client.recovering[c]
  /\ LET disposition == IF client.journalPresent[c] /\ client.recoveryRoots[c] # {} THEN "Resume"
                         ELSE IF client.ackIntent[c] /\ client.durableApplied[c] THEN "RollForward"
                         ELSE IF client.proposalPhase[c] \in {"Queued", "Transferring"} /\ client.queueTarget[c] \in client.localGit[c] THEN "Resume"
                         ELSE IF client.observed[c] \subseteq client.localGit[c] THEN "RollForward"
                         ELSE "Block" IN
       client' = [client EXCEPT !.recovering[c] = FALSE, !.restartDisposition[c] = disposition, !.blocked[c] = disposition = "Block"]
  /\ coverage' = Mark("ClassifyClientRestart") /\ lastAction' = "ClassifyClientRestart"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

CrashServer ==
  /\ ServerCrashAllowed /\ NormalServer /\ server.crashCount < MaxServerCrashes
  /\ (Scenario # "all-actors" \/ (server.opActor = BridgeNode /\ server.casKind = "device" /\ server.opPhase = "CASSideEffect"))
  /\ server' = [server EXCEPT !.up = FALSE, !.crashCount = @ + 1]
  /\ coverage' = Mark("CrashServer") /\ lastAction' = "CrashServer"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

RestartServer ==
  /\ ~server.up
  /\ (Scenario # "all-actors" \/ "CrashServer" \in coverage.actions)
  /\ server' = [server EXCEPT !.up = TRUE, !.recovering = TRUE]
  /\ coverage' = Mark("RestartServer") /\ lastAction' = "RestartServer"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

PrepareConflictResolutionOperation ==
  /\ NormalServer /\ server.opPhase = "Committed" /\ server.conflictMetadata /\ server.protectBase /\ server.protectCurrent /\ server.protectDevice /\ server.reviewNeeded
  /\ (Scenario # "root-ignore" \/ server.policy = "empty")
  /\ server' = [server EXCEPT !.opType = "conflict_resolve", !.opPhase = "IntegrationPrepared", !.opTarget = Plugin2Version, !.opPath = PathA, !.opExpected = server.conflictCurrent, !.classification = "None", !.expectedEffects = AllResolutionEffects, !.committedEffects = {}, !.casKind = "none", !.casSideEffect = FALSE, !.casObserved = "None", !.casMetadataCommitted = FALSE]
  /\ coverage' = Mark("PrepareConflictResolutionOperation") /\ lastAction' = "PrepareConflictResolutionOperation"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

RecoverServerOperation ==
  /\ server.up /\ server.recovering
  /\ IF server.casActual = server.casTarget /\ server.casKind = "main" /\ server.opType = "conflict_resolve"
       THEN server' = [server EXCEPT !.recovering = FALSE, !.opPhase = "Committed", !.mainEpoch = @ + 1, !.mainTree[server.opPath] = @ \cup {server.opTarget}, !.mainHistory = @ \cup {server.opTarget}, !.eventSeq = @ + 1, !.eventTree = [server.mainTree EXCEPT ![server.opPath] = @ \cup {server.opTarget}], !.committedEffects = server.expectedEffects, !.reviewNeeded = FALSE]
       ELSE IF server.casActual = server.casOld
         THEN server' = [server EXCEPT !.recovering = FALSE, !.opPhase = "Aborted"]
         ELSE server' = [server EXCEPT !.recovering = FALSE, !.opPhase = "Blocked", !.blocked = TRUE]
  /\ coverage' = Mark("RecoverServerOperation") /\ lastAction' = "RecoverServerOperation"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

CrashRust ==
  /\ bridge.rustUp /\ bridge.rustCrashCount < MaxRustCrashes /\ Scenario \in {"bridge-handoff", "all-actors"}
  /\ (Scenario # "all-actors" \/ bridge.rustPhase = "Written")
  /\ bridge' = [bridge EXCEPT !.rustUp = FALSE, !.rustCrashCount = @ + 1]
  /\ coverage' = Mark("CrashRust") /\ lastAction' = "CrashRust"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

RestartRust ==
  /\ ~bridge.rustUp
  /\ (Scenario # "all-actors" \/ "CrashRust" \in coverage.actions)
  /\ bridge' = [bridge EXCEPT !.rustUp = TRUE]
  /\ coverage' = Mark("RestartRust") /\ lastAction' = "RestartRust"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

(***************************************************************************
Negative controls are enabled only after the corresponding realistic setup.
Each changes one behavior and is excluded from positive configurations.
***************************************************************************)
ReplaceInflightTarget ==
  /\ FaultMode = "ReplaceInflightTarget" /\ client.proposalPhase[Plugin1] = "Transferring"
  /\ client' = [client EXCEPT !.queueTarget[Plugin1] = Plugin2Version]
  /\ coverage' = Mark("ReplaceInflightTarget") /\ lastAction' = "ReplaceInflightTarget"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

DropAcceptedProposal ==
  /\ FaultMode = "DropAcceptedProposal" /\ server.opPhase = "Validated" /\ server.opTarget \in server.processingRoots
  /\ server' = [server EXCEPT !.processingRoots = @ \ {server.opTarget}]
  /\ coverage' = Mark("DropAcceptedProposal") /\ lastAction' = "DropAcceptedProposal"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

MoveCoveredRefBackward ==
  /\ FaultMode = "MoveCoveredRefBackward" /\ server.classification = "Covered" /\ server.deviceRef[server.opActor] # BaseVersion
  /\ server' = [server EXCEPT !.deviceRef[server.opActor] = BaseVersion]
  /\ coverage' = Mark("MoveCoveredRefBackward") /\ lastAction' = "MoveCoveredRefBackward"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

DiscardDivergence ==
  /\ FaultMode = "DiscardDivergence" /\ server.opPhase = "Classified" /\ server.classification = "Divergent" /\ server.opTarget \in server.processingRoots
  /\ server' = [server EXCEPT !.processingRoots = @ \ {server.opTarget}, !.opPhase = "Aborted"]
  /\ coverage' = Mark("DiscardDivergence") /\ lastAction' = "DiscardDivergence"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

MoveMainBeforePreparedEffects ==
  /\ FaultMode = "MoveMainBeforePreparedEffects" /\ server.opPhase = "DeviceCommitted"
  /\ server' = [server EXCEPT !.mainTree[server.opPath] = @ \cup {server.opTarget}, !.mainHistory = @ \cup {server.opTarget}, !.opPhase = "MainMoved"]
  /\ coverage' = Mark("MoveMainBeforePreparedEffects") /\ lastAction' = "MoveMainBeforePreparedEffects"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

AckBeforeDurableApply ==
  /\ FaultMode = "AckBeforeDurableApply" /\ server.eventSeq > 0 /\ ~client.durableApplied[Plugin2]
  /\ server' = [server EXCEPT !.lastAppliedEpoch[Plugin2] = server.mainEpoch]
  /\ coverage' = Mark("AckBeforeDurableApply") /\ lastAction' = "AckBeforeDurableApply"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

OverwriteUncapturedBridgeWrite ==
  /\ FaultMode = "OverwriteUncapturedBridgeWrite" /\ bridge.acknowledged /\ BridgeVersion \notin ghost.captured
  /\ client' = [client EXCEPT !.visible[BridgeNode][PathA] = BaseVersion]
  /\ ghost' = [ghost EXCEPT !.overwritten = @ \cup {BridgeVersion}]
  /\ coverage' = Mark("OverwriteUncapturedBridgeWrite") /\ lastAction' = "OverwriteUncapturedBridgeWrite"
  /\ UNCHANGED <<network, server, bridge, directory>>

RecursiveDirectoryDelete ==
  /\ FaultMode = "RecursiveDirectoryDelete" /\ directory.committed /\ directory.canonicalTombstone /\ directory.descendantPresent[Plugin1]
  /\ directory' = [directory EXCEPT !.localPresent[Plugin1] = FALSE, !.descendantPresent[Plugin1] = FALSE, !.descendantLost[Plugin1] = TRUE]
  /\ coverage' = Mark("RecursiveDirectoryDelete") /\ lastAction' = "RecursiveDirectoryDelete"
  /\ UNCHANGED <<client, network, server, bridge, ghost>>

RestartAbortsMovedRef ==
  /\ FaultMode = "RestartAbortsMovedRef" /\ server.up /\ server.recovering /\ server.casActual = server.casTarget
  /\ server' = [server EXCEPT !.recovering = FALSE, !.opPhase = "Aborted"]
  /\ coverage' = Mark("RestartAbortsMovedRef") /\ lastAction' = "RestartAbortsMovedRef"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

DuplicateNonIdempotentProcessing ==
  /\ FaultMode = "DuplicateNonIdempotentProcessing" /\ server.opAttempt \in server.processedAttempts /\ server.processCount[server.opAttempt] = 1
  /\ server' = [server EXCEPT !.processCount[server.opAttempt] = @ + 1]
  /\ coverage' = Mark("DuplicateNonIdempotentProcessing") /\ lastAction' = "DuplicateNonIdempotentProcessing"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

MutateRetryIdentity ==
  /\ FaultMode = "MutateRetryIdentity" /\ client.proposalPhase[Plugin1] = "Transferring"
  /\ client' = [client EXCEPT !.attemptId[Plugin1] = "attempt-plugin-1-retry"]
  /\ coverage' = Mark("MutateRetryIdentity") /\ lastAction' = "MutateRetryIdentity"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

LoseConflictProtection ==
  /\ FaultMode = "LoseConflictProtection" /\ server.conflictMetadata /\ ~(server.protectBase /\ server.protectCurrent /\ server.protectDevice)
  /\ server' = [server EXCEPT !.processingRoots = @ \ {server.conflictDevice}]
  /\ coverage' = Mark("LoseConflictProtection") /\ lastAction' = "LoseConflictProtection"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

AbortUncertainCAS ==
  /\ FaultMode = "AbortUncertainCAS" /\ server.opPhase = "CASObserved" /\ server.casObserved = "Uncertain" /\ server.casActual = server.casTarget
  /\ server' = [server EXCEPT !.opPhase = "Aborted"]
  /\ coverage' = Mark("AbortUncertainCAS") /\ lastAction' = "AbortUncertainCAS"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ConflateSeenAndApplied ==
  /\ FaultMode = "ConflateSeenAndApplied" /\ client.seenCursor[Plugin2] > client.appliedCursor[Plugin2] /\ ~client.durableApplied[Plugin2]
  /\ client' = [client EXCEPT !.appliedCursor[Plugin2] = client.seenCursor[Plugin2]]
  /\ coverage' = Mark("ConflateSeenAndApplied") /\ lastAction' = "ConflateSeenAndApplied"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

AdvanceProjectionCursorEarly ==
  /\ FaultMode = "AdvanceProjectionCursorEarly" /\ bridge.projectionTarget > bridge.projectionCursor /\ ~(bridge.manifestVerified /\ bridge.baseVerified /\ bridge.pathOidsVerified /\ bridge.rowsComplete)
  /\ bridge' = [bridge EXCEPT !.projectionCursor = bridge.projectionTarget, !.derivedReady = TRUE, !.cursorPublishedVerified = FALSE]
  /\ coverage' = Mark("AdvanceProjectionCursorEarly") /\ lastAction' = "AdvanceProjectionCursorEarly"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

DiscardLocalOnly ==
  /\ FaultMode = "DiscardLocalOnly" /\ client.localOnly[Plugin2] /\ client.applyPhase[Plugin2] = "Writing"
  /\ client' = [client EXCEPT !.visible[Plugin2][PathA] = Plugin1Version, !.applyPhase[Plugin2] = "Verifying", !.displaced[Plugin2] = @ \cup {client.preflight[Plugin2]}]
  /\ coverage' = Mark("DiscardLocalOnly") /\ lastAction' = "DiscardLocalOnly"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

DiscardIgnoredBridgeWrite ==
  /\ FaultMode = "DiscardIgnoredBridgeWrite" /\ server.policy = "exclude-a" /\ bridge.rustPhase \in {"Idle", "Validated"}
  /\ bridge' = [bridge EXCEPT !.rustPhase = "Written", !.acknowledged = TRUE]
  /\ client' = [client EXCEPT !.visible[BridgeNode][PathA] = BaseVersion]
  /\ coverage' = Mark("DiscardIgnoredBridgeWrite") /\ lastAction' = "DiscardIgnoredBridgeWrite"
  /\ UNCHANGED <<network, server, directory, ghost>>

PublishExcludedRows ==
  /\ FaultMode = "PublishExcludedRows" /\ bridge.projectionPolicy = "exclude-a" /\ bridge.rowsComplete /\ bridge.projectionCursor = 0
  /\ bridge' = [bridge EXCEPT !.projectedPaths = Paths]
  /\ coverage' = Mark("PublishExcludedRows") /\ lastAction' = "PublishExcludedRows"
  /\ UNCHANGED <<client, network, server, directory, ghost>>

AdmitExcludedCandidate ==
  /\ FaultMode = "AdmitExcludedCandidate" /\ Scenario = "root-ignore"
  /\ server.opPhase = "Started" /\ server.opPolicy = "exclude-a"
  /\ server' = [server EXCEPT !.opCandidateHasA = TRUE, !.opPhase = "Validated",
       !.accepted = @ \cup {server.opTarget}, !.processingRoots = @ \cup {server.opTarget}]
  /\ coverage' = Mark("AdmitExcludedCandidate") /\ lastAction' = "AdmitExcludedCandidate"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

ActivateLegacyWithoutReconciliation ==
  /\ FaultMode = "ActivateLegacyWithoutReconciliation" /\ Scenario = "root-ignore-legacy"
  /\ ~server.policyActive
  /\ server' = [server EXCEPT !.policyActive = TRUE]
  /\ coverage' = Mark("ActivateLegacyWithoutReconciliation")
  /\ lastAction' = "ActivateLegacyWithoutReconciliation"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

UnsafeOldClientPoll ==
  /\ FaultMode = "UnsafeOldClientPoll" /\ PolicyScenario /\ server.policyActive
  /\ server.policy = "exclude-a" /\ ~client.capable[Plugin2] /\ server.eventSeq > 0
  /\ client' = [client EXCEPT !.applyPhase[Plugin2] = "Planned"]
  /\ coverage' = Mark("UnsafeOldClientPoll") /\ lastAction' = "UnsafeOldClientPoll"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

AcceptStalePolicyProposal ==
  /\ FaultMode = "AcceptStalePolicyProposal" /\ Scenario = "root-ignore"
  /\ server.opPhase = "Validated" /\ server.policy = "exclude-a" /\ server.opPolicy = "empty"
  /\ server' = [server EXCEPT !.mainTree[PathA] = @ \cup {server.opTarget},
       !.eventTree[PathA] = @ \cup {server.opTarget}, !.opPhase = "Committed"]
  /\ coverage' = Mark("AcceptStalePolicyProposal") /\ lastAction' = "AcceptStalePolicyProposal"
  /\ UNCHANGED <<client, network, bridge, directory, ghost>>

MutateAttemptPolicy ==
  /\ FaultMode = "MutateAttemptPolicy" /\ client.proposalPhase[Plugin1] = "Transferring"
  /\ client' = [client EXCEPT !.attemptPolicy[Plugin1] = "empty"]
  /\ coverage' = Mark("MutateAttemptPolicy") /\ lastAction' = "MutateAttemptPolicy"
  /\ UNCHANGED <<network, server, bridge, directory, ghost>>

RootActions == {
 "ObservePluginEdit", "RustValidateWrite", "RustAtomicVisibleWrite", "NodePersistBridgeHint", "CaptureLocalCommit", "PersistImmutableProposal", "ObserveRootPolicyEdit", "RebuildStaleQueuedProposal", "PersistEqualRetry", "PersistCoveredQuery",
 "SendProposalRequest", "DelayProposalRequest", "DuplicateProposalRequest", "DropProposalRequest", "DeliverProposalRequest", "ServerStartProposal", "RejectExcludedCandidate",
 "ServerValidateProposal", "ClassifyProposal", "PrepareDeviceCAS", "ApplyCASSideEffect", "ObserveCASResult", "CommitCASMetadata",
 "HandleEqualOrCovered", "ServerPrepareIntegration", "PrepareMainCAS", "BeginConflictMetadata", "ProtectConflictBase", "ProtectConflictCurrent",
 "ProtectConflictDevice", "CommitConflictResult", "CommitIntegrationEffects", "CommitConflictResolutionEffects", "SendStoredReply", "DuplicateProposalReply", "DelayProposalReply",
 "DropProposalReply", "DeliverProposalReply", "RetryOrQueryStable", "ConsumeProposalResult", "PollCommittedEvent", "PlanLocalApply",
 "PublishApplyRecovery", "BeginLocalMutation", "MutateWithFreshIdentity", "VerifyLocalApply", "CommitLocalCoordination", "PersistApplyAckIntent",
 "CleanupApplyJournal", "AcknowledgeDurableApply", "PrepareDirectoryTombstone", "CommitDirectoryTombstone", "ObserveDirectoryDescendant",
 "RemoveDirectoryDescendant", "PreflightEmptyDirectory", "DeleteEmptyDirectory", "BeginProjection", "VerifyProjectionManifest",
 "VerifyProjectionBase", "VerifyProjectionPathOids", "WriteDerivedProjection", "AdvanceProjectionCursor", "FailProjection", "CrashClient",
 "RestartClient", "ClassifyClientRestart", "CrashServer", "RestartServer", "PrepareConflictResolutionOperation", "RecoverServerOperation",
 "CrashRust", "RestartRust", "ReplaceInflightTarget", "DropAcceptedProposal", "MoveCoveredRefBackward", "DiscardDivergence",
 "MoveMainBeforePreparedEffects", "AckBeforeDurableApply", "OverwriteUncapturedBridgeWrite", "RecursiveDirectoryDelete",
 "RestartAbortsMovedRef", "DuplicateNonIdempotentProcessing", "MutateRetryIdentity", "LoseConflictProtection", "AbortUncertainCAS",
 "ConflateSeenAndApplied", "AdvanceProjectionCursorEarly", "ClassifyStalePolicyProposal", "UpgradeOldClient", "ActivateLegacyPolicy",
 "DiscardLocalOnly", "DiscardIgnoredBridgeWrite", "PublishExcludedRows", "MutateAttemptPolicy", "UnsafeOldClientPoll", "AcceptStalePolicyProposal", "ActivateLegacyWithoutReconciliation", "AdmitExcludedCandidate",
 "EvictDeliveredAckSnapshot", "LoseAllAckEvidence", "AcknowledgeHistorical"
}

ClientActions(c) ==
  (\E p \in Paths: ObservePluginEdit(c, p)) \/ UpgradeOldClient \/ CaptureLocalCommit(c) \/ PersistImmutableProposal(c) \/ ObserveRootPolicyEdit(c) \/ RebuildStaleQueuedProposal(c) \/ PersistEqualRetry(c) \/ PersistCoveredQuery(c) \/ SendProposalRequest(c) \/
  DelayProposalRequest(c) \/ DuplicateProposalRequest(c) \/ (\E copy \in Copies: DropProposalRequest(c, copy) \/ DeliverProposalRequest(c, copy) \/ DelayProposalReply(c, copy) \/ DropProposalReply(c, copy) \/ DeliverProposalReply(c, copy)) \/
  DuplicateProposalReply(c) \/ RetryOrQueryStable(c) \/ ConsumeProposalResult(c) \/ PollCommittedEvent(c) \/ PlanLocalApply(c) \/
  PublishApplyRecovery(c) \/ BeginLocalMutation(c) \/ MutateWithFreshIdentity(c) \/ VerifyLocalApply(c) \/ CommitLocalCoordination(c) \/
  PersistApplyAckIntent(c) \/ CleanupApplyJournal(c) \/ AcknowledgeDurableApply(c) \/ CrashClient(c) \/ RestartClient(c) \/ ClassifyClientRestart(c)

ServerActions ==
  (\E c \in Clients, copy \in Copies: ServerStartProposal(c, copy)) \/ RejectExcludedCandidate \/ ServerValidateProposal \/ ClassifyProposal \/ PrepareDeviceCAS \/
  ClassifyStalePolicyProposal \/ ActivateLegacyPolicy \/ ApplyCASSideEffect \/ (\E observation \in CASObservations: ObserveCASResult(observation)) \/ CommitCASMetadata \/ HandleEqualOrCovered \/
  ServerPrepareIntegration \/ PrepareMainCAS \/ BeginConflictMetadata \/ ProtectConflictBase \/ ProtectConflictCurrent \/ ProtectConflictDevice \/
  CommitConflictResult \/ CommitIntegrationEffects \/ CommitConflictResolutionEffects \/ (\E c \in Clients: SendStoredReply(c)) \/ PrepareDirectoryTombstone \/ CommitDirectoryTombstone \/
  CrashServer \/ RestartServer \/ PrepareConflictResolutionOperation \/ RecoverServerOperation

BridgeActions == RustValidateWrite \/ RustAtomicVisibleWrite \/ NodePersistBridgeHint \/ BeginProjection \/ VerifyProjectionManifest \/
  VerifyProjectionBase \/ VerifyProjectionPathOids \/ WriteDerivedProjection \/ AdvanceProjectionCursor \/ FailProjection \/ CrashRust \/ RestartRust

DirectoryActions == ObserveDirectoryDescendant(Plugin1) \/ RemoveDirectoryDescendant(Plugin1) \/ PreflightEmptyDirectory(Plugin1) \/ DeleteEmptyDirectory(Plugin1)

FaultActions == ReplaceInflightTarget \/ DropAcceptedProposal \/ MoveCoveredRefBackward \/ DiscardDivergence \/ MoveMainBeforePreparedEffects \/
  AckBeforeDurableApply \/ EvictDeliveredAckSnapshot \/ LoseAllAckEvidence \/ OverwriteUncapturedBridgeWrite \/ RecursiveDirectoryDelete \/ RestartAbortsMovedRef \/ DuplicateNonIdempotentProcessing \/
  MutateRetryIdentity \/ LoseConflictProtection \/ AbortUncertainCAS \/ ConflateSeenAndApplied \/ AdvanceProjectionCursorEarly \/
  DiscardLocalOnly \/ DiscardIgnoredBridgeWrite \/ PublishExcludedRows \/ MutateAttemptPolicy \/ UnsafeOldClientPoll \/ AcceptStalePolicyProposal \/ ActivateLegacyWithoutReconciliation \/ AdmitExcludedCandidate

CoreNext == (\E c \in Clients: ClientActions(c)) \/ ServerActions \/ BridgeActions \/ DirectoryActions \/ FaultActions
Next == CoreNext \/ UNCHANGED vars
SafetySpec == Init /\ [][Next]_vars

TypeOK ==
  /\ client.capable \in [Clients -> BOOLEAN] /\ client.policy \in [Clients -> Policies]
  /\ client.candidateHasA \in [Clients -> BOOLEAN]
  /\ client.attemptPolicy \in [Clients -> PolicyIds] /\ client.journalPolicy \in [Clients -> PolicyIds] /\ client.localOnly \in [Clients -> BOOLEAN]
  /\ client.up \in [Clients -> BOOLEAN] /\ client.recovering \in [Clients -> BOOLEAN] /\ client.restartDisposition \in [Clients -> RestartDispositions]
  /\ client.crashCount \in [Clients -> 0..MaxClientCrashes] /\ client.visible \in [Clients -> [Paths -> Versions]]
  /\ client.observed \in [Clients -> SUBSET Versions] /\ client.localGit \in [Clients -> SUBSET Versions] /\ client.capturePublished \in [Clients -> SUBSET Versions]
  /\ client.hints \in [Clients -> SUBSET Paths] /\ client.editCount \in [Clients -> 0..2] /\ client.editPath \in [Clients -> Paths \cup {NoPath}]
  /\ client.queueTarget \in [Clients -> Versions \cup {NoVersion}] /\ client.expectedDevice \in [Clients -> Versions \cup {NoVersion}]
  /\ client.proposalBase \in [Clients -> Versions \cup {NoVersion}] /\ client.directoryProposal \in [Clients -> ProposalIds]
  /\ client.directoryIntent \in [Clients -> IntentIds] /\ client.directoryGeneration \in [Clients -> 0..2] /\ client.objectPlan \in [Clients -> Plans]
  /\ client.attemptId \in [Clients -> AttemptIds \cup {NoId}] /\ client.transferId \in [Clients -> TransferIds \cup {NoId}]
  /\ client.immutableIdentity \in [Clients -> IdentityType]
  /\ client.proposalPhase \in [Clients -> ProposalPhases] /\ client.seenCursor \in [Clients -> Nat] /\ client.appliedCursor \in [Clients -> Nat]
  /\ client.localMainEpoch \in [Clients -> Nat] /\ client.durableApplied \in [Clients -> BOOLEAN] /\ client.ackIntent \in [Clients -> BOOLEAN]
  /\ client.applyPhase \in [Clients -> ApplyPhases] /\ client.journalPresent \in [Clients -> BOOLEAN] /\ client.recoveryRoots \in [Clients -> SUBSET Versions]
  /\ client.preflight \in [Clients -> Versions \cup {NoVersion}] /\ client.displaced \in [Clients -> SUBSET Versions] /\ client.blocked \in [Clients -> BOOLEAN]
  /\ network.requestBag \subseteq [actor: Clients, copy: Copies, attempt: AttemptIds, transfer: TransferIds, target: Versions, expected: Versions, base: Versions, directoryProposal: ProposalIds, objectPlan: Plans, policy: Policies, hasA: BOOLEAN]
  /\ network.delayedRequests \subseteq Clients \X Copies \X AttemptIds /\ network.droppedRequests \subseteq Clients \X Copies \X AttemptIds /\ network.deliveredRequests \subseteq Clients \X Copies \X AttemptIds
  /\ network.replyBag \subseteq [actor: Clients, copy: Copies, attempt: AttemptIds, result: {"accepted", "conflicted", "rejected"}]
  /\ network.delayedReplies \subseteq Clients \X Copies \X AttemptIds /\ network.droppedReplies \subseteq Clients \X Copies \X AttemptIds /\ network.deliveredReplies \subseteq Clients \X Copies \X AttemptIds
  /\ server.opCandidateHasA \in BOOLEAN
  /\ server.policy \in Policies /\ server.policyActive \in BOOLEAN /\ server.eventPolicy \in Policies /\ server.opPolicy \in PolicyIds
  /\ server.up \in BOOLEAN /\ server.recovering \in BOOLEAN /\ server.crashCount \in 0..MaxServerCrashes /\ server.mainEpoch \in Nat
  /\ server.mainTree \in [Paths -> SUBSET Versions] /\ server.mainHistory \subseteq Versions /\ server.deviceRef \in [Clients -> Versions]
  /\ server.deviceHistory \in [Clients -> SUBSET Versions] /\ server.processingRoots \subseteq Versions /\ server.accepted \subseteq Versions
  /\ server.processedAttempts \subseteq AttemptIds /\ server.resultByAttempt \in [AttemptIds -> {NoResult, "accepted", "conflicted", "rejected"}]
  /\ server.processCount \in [AttemptIds -> Nat] /\ server.opType \in OperationTypes /\ server.opActor \in Clients \cup {NoClient}
  /\ server.opTarget \in Versions \cup {NoVersion} /\ server.opPath \in Paths \cup {NoPath} /\ server.opExpected \in Versions \cup {NoVersion}
  /\ server.opAttempt \in AttemptIds \cup {NoId} /\ server.opTransfer \in TransferIds \cup {NoId} /\ server.opDirectoryProposal \in ProposalIds
  /\ server.opDirectoryIntent \in IntentIds /\ server.opDirectoryGeneration \in 0..2 /\ server.opBaseEpoch \in Nat /\ server.opBaseEvent \in Nat
  /\ server.opObjectPlan \in Plans /\ server.classification \in Classifications /\ server.opPhase \in OperationPhases /\ server.casKind \in CASKinds
  /\ server.casOld \in Versions \cup {NoVersion} /\ server.casTarget \in Versions \cup {NoVersion} /\ server.casActual \in Versions \cup {NoVersion}
  /\ server.casSideEffect \in BOOLEAN /\ server.casObserved \in CASObservations /\ server.casMetadataCommitted \in BOOLEAN
  /\ server.conflictMetadata \in BOOLEAN /\ server.conflictEvent \in BOOLEAN /\ server.reviewNeeded \in BOOLEAN
  /\ server.protectBase \in BOOLEAN /\ server.protectCurrent \in BOOLEAN /\ server.protectDevice \in BOOLEAN
  /\ server.conflictBase \in Versions \cup {NoVersion} /\ server.conflictCurrent \in Versions \cup {NoVersion} /\ server.conflictDevice \in Versions \cup {NoVersion}
  /\ server.conflictRoots \subseteq Versions /\ server.expectedEffects \subseteq EffectNames /\ server.committedEffects \subseteq EffectNames
  /\ server.eventSeq \in Nat /\ server.eventTree \in [Paths -> SUBSET Versions] /\ server.lastAppliedEpoch \in [Clients -> Nat] /\ server.blocked \in BOOLEAN
  /\ server.deliveredAckEpoch \in [Clients -> Nat] /\ server.historyRetained \in BOOLEAN
  /\ bridge.projectionPolicy \in PolicyIds /\ bridge.projectedPaths \subseteq Paths /\ bridge.preservedAtPolicy \in Versions
  /\ bridge.rustUp \in BOOLEAN /\ bridge.rustCrashCount \in 0..MaxRustCrashes /\ bridge.rustPhase \in RustPhases /\ bridge.acknowledged \in BOOLEAN
  /\ bridge.nodeHintDurable \in BOOLEAN /\ bridge.manifestVerified \in BOOLEAN /\ bridge.baseVerified \in BOOLEAN /\ bridge.pathOidsVerified \in BOOLEAN
  /\ bridge.rowsComplete \in BOOLEAN /\ bridge.projectionCursor \in Nat /\ bridge.projectionTarget \in Nat /\ bridge.projectionHealthy \in BOOLEAN
  /\ bridge.derivedReady \in BOOLEAN /\ bridge.projectionFailure \in BOOLEAN /\ bridge.cursorPublishedVerified \in BOOLEAN /\ bridge.auditRetained \in BOOLEAN
  /\ directory.canonicalTombstone \in BOOLEAN /\ directory.proposalId \in ProposalIds /\ directory.intentId \in IntentIds /\ directory.generation \in 0..2
  /\ directory.baseMainEpoch \in Nat /\ directory.baseEventSeq \in Nat /\ directory.prepared \in BOOLEAN /\ directory.committed \in BOOLEAN
  /\ directory.resultProposal \in ProposalIds /\ directory.resultEvent \in Nat /\ directory.eventProposal \in ProposalIds
  /\ directory.localDeletionTarget \in [Clients -> ProposalIds] /\ directory.deletedUnderProposal \in [Clients -> ProposalIds] /\ directory.deletedIdentity \in [Clients -> Nat] /\ directory.localPresent \in [Clients -> BOOLEAN]
  /\ directory.localIdentity \in [Clients -> Nat] /\ directory.preflightIdentity \in [Clients -> Nat] /\ directory.localEmpty \in [Clients -> BOOLEAN]
  /\ directory.descendantPresent \in [Clients -> BOOLEAN] /\ directory.descendantObserved \in [Clients -> BOOLEAN] /\ directory.descendantLost \in [Clients -> BOOLEAN]
  /\ coverage.actions \subseteq RootActions \cup {"BridgeNodeCaptured", "PluginCaptured", "CASOld", "CASTarget", "CASForeign", "CASUncertain", "AcknowledgeHistorical"}
  /\ coverage.classifications \subseteq Classifications /\ coverage.actorsProposed \subseteq Clients /\ coverage.conflictPartial \in BOOLEAN /\ coverage.replyLostAfterOutcome \in BOOLEAN
  /\ ghost.captured \subseteq Versions /\ ghost.overwritten \subseteq Versions /\ lastAction \in RootActions \cup {"Init"}

CapturedOnlyAfterDurablePublication == \A v \in ghost.captured: \E c \in Clients: v \in client.localGit[c] /\ v \in client.capturePublished[c]
OBTS_SAF_001_CapturedVersionsRemainRecoverable == \A v \in ghost.captured: Rooted(v)
OBTS_SAF_002_DestructiveApplyRequiresRecovery == \A c \in Clients: client.displaced[c] \subseteq client.recoveryRoots[c]
OBTS_SAF_003_UploadedProposalsRemainReachable == \A v \in server.accepted: ServerRooted(v)
OBTS_SAF_004_GitAndDirectoryOutcomesAtomic == server.opPhase # "Committed" \/ server.opType # "device_push" \/ server.eventTree = server.mainTree
OBTS_SAF_005_RestartRollsForwardOrBlocks ==
  /\ ~(server.opPhase = "Aborted" /\ server.casActual = server.casTarget /\ server.casKind # "none")
  /\ \A c \in Clients: client.restartDisposition[c] \in {"None", "Resume", "RollForward", "Block"}
OBTS_SAF_006_DirectoryDeletionNonRecursive == \A c \in Clients: ~directory.descendantLost[c]
NoDeviceRefRewind == \A c \in Clients: Cardinality(server.deviceHistory[c]) > 1 => server.deviceRef[c] # BaseVersion
AttemptIdentityImmutable == \A c \in Clients: client.attemptId[c] # NoId => client.immutableIdentity[c] = <<<<client.queueTarget[c], client.expectedDevice[c], client.proposalBase[c], client.directoryProposal[c], client.objectPlan[c], client.attemptId[c], client.transferId[c]>>, client.attemptPolicy[c]>>
ServerProcessesAttemptOnce == \A a \in AttemptIds: server.processCount[a] <= 1
DivergenceDoesNotMoveDeviceRef == server.classification = "Divergent" => server.deviceRef[server.opActor] = server.opExpected
DivergentProposalProtected == server.classification = "Divergent" => server.opTarget \in server.processingRoots \/ server.opTarget \in server.conflictRoots
ConflictProtectionCompleteOrRetained == server.conflictMetadata => (server.conflictDevice \in server.processingRoots \/ (server.protectBase /\ server.protectCurrent /\ server.protectDevice))
NoEmptyConflictRoot == server.conflictMetadata => server.conflictBase \in Versions /\ server.conflictCurrent \in Versions /\ server.conflictDevice \in Versions
MainMoveWasPrepared == server.opPhase = "MainMoved" => server.casKind = "main" /\ server.casObserved = "Target" /\ server.casMetadataCommitted
CASSideEffectRecoveryByReading == server.opPhase = "Aborted" /\ server.casKind # "none" => server.casActual # server.casTarget
ExactPreparedOperationRecovery == server.opType = "conflict_resolve" /\ server.opPhase = "Committed" => server.committedEffects = server.expectedEffects
SoundApplyAcknowledgement == \A c \in Clients: server.lastAppliedEpoch[c] > 0 => client.durableApplied[c] /\ client.localMainEpoch[c] = server.lastAppliedEpoch[c]
AckIntentResolvable == \A c \in Clients: client.ackIntent[c] => AcknowledgeEvidence(c)
SeenAppliedSeparation == \A c \in Clients: client.appliedCursor[c] <= client.seenCursor[c] /\ (client.appliedCursor[c] > 0 => client.durableApplied[c])
DirectoryDeletionCausal == \A c \in Clients: ~directory.localPresent[c] => directory.canonicalTombstone /\ directory.deletedUnderProposal[c] # NoProposal /\ directory.deletedIdentity[c] = directory.preflightIdentity[c] /\ directory.localEmpty[c]
GitDirectoryEventAgreement == directory.committed => directory.resultProposal = directory.eventProposal /\ directory.resultEvent <= server.eventSeq
DisjointEditsSurvive == Scenario = "disjoint-directory" /\ Plugin1 \in coverage.actorsProposed /\ BridgeNode \in coverage.actorsProposed /\ client.proposalPhase[Plugin1] = "Terminal" /\ client.proposalPhase[BridgeNode] = "Terminal" => Plugin1Version \in server.mainTree[PathB] /\ BridgeVersion \in server.mainTree[PathA]
BridgeAcknowledgedWritePreserved == bridge.acknowledged => Rooted(BridgeVersion)
ProjectionVerifiedBeforeCursor == bridge.projectionCursor > 0 => bridge.cursorPublishedVerified
ProjectionFailureRetainsCursor == bridge.projectionFailure => ~bridge.derivedReady /\ ~bridge.projectionHealthy
ProjectionIsDerivedOnly == bridge.derivedReady => bridge.projectionHealthy /\ (PolicyScenario \/ BridgeVersion \in client.localGit[BridgeNode])
ApplyRefinementBoundary == \A c \in Clients: ApplyBoundaryOK(client.applyPhase[c], client.journalPresent[c], client.recoveryRoots[c] # {}, client.durableApplied[c], client.ackIntent[c])
CandidateAdmittedOnlyWhenPolicyValid == server.opPhase \notin {"Validated", "Classified", "CASPrepared", "CASSideEffect", "CASObserved", "DeviceCommitted", "IntegrationPrepared", "MainMoved"} \/ server.opPolicy # "exclude-a" \/ ~server.opCandidateHasA
PolicyTransitionRemovesOnlyCanonicalCopy == ~PolicyScenario \/ ~server.policyActive \/ server.policy # "exclude-a" \/ server.mainTree[PathA] = {}
LocalOnlyApplyRetainsVisible == \A c \in Clients: client.localOnly[c] => client.journalPolicy[c] = "exclude-a" /\ client.preflight[c] \notin client.displaced[c] /\ client.visible[c][PathA] = client.preflight[c]
OldClientCannotApply == ~PolicyScenario \/ client.capable[Plugin2] \/ (client.applyPhase[Plugin2] = "Idle" /\ server.lastAppliedEpoch[Plugin2] = 0)
PolicyProjectionExcludesCurrentRows == bridge.projectionPolicy # "exclude-a" \/ ~bridge.rowsComplete \/ (PathA \notin bridge.projectedPaths /\ bridge.auditRetained)
BridgeExcludedLocalWriteRetained == ~PolicyScenario \/ server.policy # "exclude-a" \/ ~bridge.acknowledged \/ client.visible[BridgeNode][PathA] = BridgeVersion
StalePolicyRefProtected == ~PolicyScenario \/ server.opPolicy = server.policy \/ server.classification # "Divergent" \/ server.opTarget \in server.processingRoots \cup server.conflictRoots
ApplyProjectionConsistent == \A c \in Clients: FM001Phase(client.applyPhase[c]) \in {"Idle", "Planned", "RecoveryRecorded", "Writing", "Verifying", "RefsCommitted", "CoordinationCommitted", "AckIntentPersisted", "Done", "Blocked"}

AllSafety == /\ TypeOK /\ CapturedOnlyAfterDurablePublication /\ OBTS_SAF_001_CapturedVersionsRemainRecoverable /\ OBTS_SAF_002_DestructiveApplyRequiresRecovery
  /\ OBTS_SAF_003_UploadedProposalsRemainReachable /\ OBTS_SAF_004_GitAndDirectoryOutcomesAtomic /\ OBTS_SAF_005_RestartRollsForwardOrBlocks
  /\ OBTS_SAF_006_DirectoryDeletionNonRecursive /\ NoDeviceRefRewind /\ AttemptIdentityImmutable /\ ServerProcessesAttemptOnce /\ DivergenceDoesNotMoveDeviceRef
  /\ DivergentProposalProtected /\ ConflictProtectionCompleteOrRetained /\ NoEmptyConflictRoot /\ MainMoveWasPrepared /\ CASSideEffectRecoveryByReading /\ ExactPreparedOperationRecovery
  /\ SoundApplyAcknowledgement /\ AckIntentResolvable /\ SeenAppliedSeparation /\ DirectoryDeletionCausal /\ GitDirectoryEventAgreement /\ DisjointEditsSurvive
  /\ BridgeAcknowledgedWritePreserved /\ ProjectionVerifiedBeforeCursor /\ ProjectionFailureRetainsCursor /\ ProjectionIsDerivedOnly
  /\ ApplyRefinementBoundary /\ ApplyProjectionConsistent /\ CandidateAdmittedOnlyWhenPolicyValid /\ PolicyTransitionRemovesOnlyCanonicalCopy
  /\ LocalOnlyApplyRetainsVisible /\ OldClientCannotApply /\ PolicyProjectionExcludesCurrentRows
  /\ BridgeExcludedLocalWriteRetained /\ StalePolicyRefProtected

ProposalTrigger == "PersistImmutableProposal" \in coverage.actions
ProposalConsumed == \E c \in Clients: client.proposalPhase[c] = "Terminal"
BridgeWriteTrigger == bridge.acknowledged
BridgeCaptured == BridgeVersion \in ghost.captured
RecoveryTrigger == "RestartServer" \in coverage.actions
RecoveryTerminal == ~server.recovering /\ server.opPhase \in {"Committed", "Aborted", "Blocked"}
ApplyTrigger == "PollCommittedEvent" \in coverage.actions
ApplyAcked == server.lastAppliedEpoch[Plugin2] = server.mainEpoch /\ server.mainEpoch > 0

ProposalLiveness == ProposalTrigger ~> ProposalConsumed
BridgeLiveness == BridgeWriteTrigger ~> BridgeCaptured
RecoveryLiveness == RecoveryTrigger ~> RecoveryTerminal
ApplyAckLiveness == ApplyTrigger ~> ApplyAcked

ProposalLiveSpec == SafetySpec /\ WF_vars(CaptureLocalCommit(Plugin1)) /\ WF_vars(PersistImmutableProposal(Plugin1)) /\ WF_vars(SendProposalRequest(Plugin1)) /\ WF_vars(DeliverProposalRequest(Plugin1, 1)) /\ WF_vars(ServerStartProposal(Plugin1, 1)) /\ WF_vars(ServerValidateProposal) /\ WF_vars(ClassifyProposal) /\ WF_vars(PrepareDeviceCAS) /\ WF_vars(ApplyCASSideEffect) /\ WF_vars(ObserveCASResult("Target")) /\ WF_vars(CommitCASMetadata) /\ WF_vars(ServerPrepareIntegration) /\ WF_vars(PrepareMainCAS) /\ WF_vars(CommitIntegrationEffects) /\ WF_vars(SendStoredReply(Plugin1)) /\ WF_vars(DeliverProposalReply(Plugin1, 1)) /\ WF_vars(DeliverProposalReply(Plugin1, 2)) /\ WF_vars(RetryOrQueryStable(Plugin1)) /\ WF_vars(ConsumeProposalResult(Plugin1))
BridgeLiveSpec == SafetySpec /\ WF_vars(RustValidateWrite) /\ WF_vars(RustAtomicVisibleWrite) /\ WF_vars(NodePersistBridgeHint) /\ WF_vars(CaptureLocalCommit(BridgeNode))
RecoveryLiveSpec == SafetySpec /\ WF_vars(RestartServer) /\ WF_vars(RecoverServerOperation)
ApplyLiveSpec == SafetySpec /\ WF_vars(PollCommittedEvent(Plugin2)) /\ WF_vars(PlanLocalApply(Plugin2)) /\ WF_vars(PublishApplyRecovery(Plugin2)) /\ WF_vars(BeginLocalMutation(Plugin2)) /\ WF_vars(MutateWithFreshIdentity(Plugin2)) /\ WF_vars(VerifyLocalApply(Plugin2)) /\ WF_vars(CommitLocalCoordination(Plugin2)) /\ WF_vars(PersistApplyAckIntent(Plugin2)) /\ WF_vars(CleanupApplyJournal(Plugin2)) /\ WF_vars(AcknowledgeDurableApply(Plugin2))

NeverObservePluginEdit == "ObservePluginEdit" \notin coverage.actions
NeverBridgeNodeProposal == BridgeNode \notin coverage.actorsProposed
NeverPlugin2Proposal == Plugin2 \notin coverage.actorsProposed
NeverRustWrite == "RustAtomicVisibleWrite" \notin coverage.actions
NeverNetworkFault == "DropProposalRequest" \notin coverage.actions
NeverServerRecovery == "RecoverServerOperation" \notin coverage.actions
NeverConflict == "BeginConflictMetadata" \notin coverage.actions
NeverApplyAck == "AcknowledgeDurableApply" \notin coverage.actions
NeverAcknowledgeHistorical == "AcknowledgeHistorical" \notin coverage.actions
NeverEqualClassification == "Equal" \notin coverage.classifications
NeverCoveredClassification == "Covered" \notin coverage.classifications
NeverDivergentClassification == "Divergent" \notin coverage.classifications
NeverReplyLossAfterOutcome == ~coverage.replyLostAfterOutcome
NeverConflictPartial == ~coverage.conflictPartial
NeverDirectoryDelete == "DeleteEmptyDirectory" \notin coverage.actions
NeverProjectionReady == "AdvanceProjectionCursor" \notin coverage.actions
NeverProposalTrigger == ~ProposalTrigger
NeverBridgeTrigger == ~BridgeWriteTrigger
NeverRecoveryTrigger == ~RecoveryTrigger
NeverApplyTrigger == ~ApplyTrigger
NeverPolicyTransition == ~server.policyActive \/ server.policy # "exclude-a"
NeverLocalOnlyApply == ~client.localOnly[Plugin2] \/ client.applyPhase[Plugin2] = "Idle"
NeverStaleQueuedRebuild == Scenario # "root-ignore-stale-queued" \/ "RebuildStaleQueuedProposal" \notin coverage.actions
NeverStalePolicyReview == Scenario # "root-ignore" \/ ~(server.reviewNeeded /\ server.opPhase = "Committed" /\ server.conflictDevice \in server.conflictRoots)
NeverPolicyProjection == bridge.projectionCursor = 0
NeverUpgrade == ~client.capable[Plugin2]
NeverInvalidCandidateRejected == "RejectExcludedCandidate" \notin coverage.actions
NeverOldOfflineCapture == client.capable[Plugin2] \/ client.proposalPhase[Plugin2] # "Queued"
NeverLegacyActivation == ~server.policyActive
NeverBridgeRace == Scenario # "root-ignore-bridge-race" \/ server.policy # "exclude-a" \/ bridge.rustPhase # "Validated"
NeverApplyProjection == "CommitLocalCoordination" \notin coverage.actions

=============================================================================
