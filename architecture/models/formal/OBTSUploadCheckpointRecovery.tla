---- MODULE OBTSUploadCheckpointRecovery ----
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS OldCommit, Successor, OriginalBase, ReboundBase, NoStatus,
          Open, Processing, Completed, Rejected, Missing, Expired,
          NoOutcome, Accepted, Conflict, Unknown, Mutation

VARIABLES phase, running, queue, checkpoint, journal, archived,
          oldProtected, successorProtected, successorSaved, originalBase,
          successorBase, laterHints, successorHints, transferStatus,
          serverRef, outcome, serverResult, replayTarget, replayBase
vars == <<phase, running, queue, checkpoint, journal, archived,
          oldProtected, successorProtected, successorSaved, originalBase,
          successorBase, laterHints, successorHints, transferStatus,
          serverRef, outcome, serverResult, replayTarget, replayBase>>

Init ==
  /\ phase = "active"
  /\ running = TRUE
  /\ queue \in {OldCommit, Successor}
  /\ checkpoint = TRUE
  /\ journal = FALSE
  /\ archived = FALSE
  /\ oldProtected = FALSE
  /\ successorProtected = FALSE
  /\ successorSaved = FALSE
  /\ originalBase = OriginalBase
  /\ successorBase = OriginalBase
  /\ laterHints = {}
  /\ successorHints = {}
  /\ transferStatus \in {NoStatus, Open, Processing, Completed, Rejected, Missing, Expired}
  /\ serverRef = "base"
  /\ outcome = NoOutcome
  /\ serverResult = NoOutcome
  /\ replayTarget = OldCommit
  /\ replayBase = OriginalBase

PublishHandoff ==
  /\ running /\ phase = "active"
  /\ oldProtected' = (Mutation # "no-protect-old")
  /\ successorProtected' = TRUE
  /\ successorSaved' = (Mutation # "drop-successor")
  /\ successorBase' = IF Mutation = "rebind-base" THEN ReboundBase ELSE originalBase
  /\ journal' = TRUE /\ phase' = "handoff"
  /\ checkpoint' = (Mutation # "retire-before-classification")
  /\ UNCHANGED <<running, queue, archived, originalBase, laterHints, successorHints,
                  transferStatus, serverRef, outcome, serverResult, replayTarget, replayBase>>

RecordLaterHint ==
  /\ running /\ phase \in {"handoff", "replay", "result"}
  /\ laterHints' = laterHints \cup {"watcher-change"}
  /\ UNCHANGED <<phase, running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, successorHints, transferStatus, serverRef, outcome,
                  serverResult, replayTarget, replayBase>>

\* Device ref movement precedes integration; even equality proves no result.
MoveDeviceRef ==
  /\ journal /\ phase \in {"handoff", "replay"}
  /\ serverRef' = "target"
  /\ UNCHANGED <<phase, running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, laterHints, successorHints, transferStatus,
                  outcome, serverResult, replayTarget, replayBase>>

ObserveCompleted ==
  /\ running /\ phase = "handoff" /\ transferStatus = Completed
  /\ serverResult' \in {Accepted, Conflict}
  /\ outcome' = serverResult' /\ phase' = "result"
  /\ UNCHANGED <<running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, laterHints, successorHints, transferStatus,
                  serverRef, replayTarget, replayBase>>

FinishProcessing ==
  /\ transferStatus = Processing
  /\ transferStatus' = Completed
  /\ UNCHANGED <<phase, running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, laterHints, successorHints, serverRef, outcome,
                  serverResult, replayTarget, replayBase>>

PrepareReplay ==
  /\ running /\ phase = "handoff"
  /\ transferStatus \in {NoStatus, Open, Missing, Expired, Rejected}
  /\ phase' = "replay"
  /\ replayBase' = IF Mutation = "replay-new-base" THEN ReboundBase ELSE originalBase
  /\ outcome' = IF Mutation = "infer-from-ref" /\ serverRef = "target" THEN Accepted ELSE outcome
  /\ UNCHANGED <<running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, laterHints, successorHints, transferStatus,
                  serverRef, serverResult, replayTarget>>

\* A fresh transport submits exactly the old proposal and obtains an actual
\* integration result, regardless of missing status or a late old acceptance.
ReplayServerResult ==
  /\ running /\ phase = "replay"
  /\ serverResult' \in {Accepted, Conflict}
  /\ outcome' = serverResult' /\ phase' = "result"
  /\ UNCHANGED <<running, queue, checkpoint, journal, archived,
                  oldProtected, successorProtected, successorSaved, originalBase,
                  successorBase, laterHints, successorHints, transferStatus,
                  serverRef, replayTarget, replayBase>>

InstallSuccessor ==
  /\ running /\ phase = "result"
  /\ queue' = Successor
  /\ successorHints' = IF Mutation = "drop-hints" THEN {} ELSE laterHints
  /\ phase' = "published"
  /\ UNCHANGED <<running, checkpoint, journal, archived, oldProtected,
                  successorProtected, successorSaved, originalBase, successorBase,
                  laterHints, transferStatus, serverRef, outcome, serverResult,
                  replayTarget, replayBase>>

PublishArchive ==
  /\ running /\ phase = "published"
  /\ archived' = TRUE /\ checkpoint' = FALSE /\ journal' = FALSE
  /\ phase' = "installed"
  /\ UNCHANGED <<running, queue, oldProtected, successorProtected,
                  successorSaved, originalBase, successorBase, laterHints,
                  successorHints, transferStatus, serverRef, outcome, serverResult,
                  replayTarget, replayBase>>

Crash ==
  /\ running /\ running' = FALSE
  /\ UNCHANGED <<phase, queue, checkpoint, journal, archived, oldProtected,
                  successorProtected, successorSaved, originalBase, successorBase,
                  laterHints, successorHints, transferStatus, serverRef, outcome,
                  serverResult, replayTarget, replayBase>>
Restart ==
  /\ ~running /\ running' = TRUE
  /\ phase' = IF Mutation = "forget-publication" /\ phase = "published" THEN "active" ELSE phase
  /\ UNCHANGED <<queue, checkpoint, journal, archived, oldProtected,
                  successorProtected, successorSaved, originalBase, successorBase,
                  laterHints, successorHints, transferStatus, serverRef, outcome,
                  serverResult, replayTarget, replayBase>>

Next == PublishHandoff \/ RecordLaterHint \/ MoveDeviceRef \/ ObserveCompleted \/
        FinishProcessing \/ PrepareReplay \/ ReplayServerResult \/ InstallSuccessor \/
        PublishArchive \/ Crash \/ Restart

JournalRequiresOldProtection == ~journal \/ oldProtected
SuccessorPublishedBeforeRetire == phase \notin {"result", "published", "installed"} \/ successorSaved
OriginalBasePreserved == successorBase = originalBase
ReplayPreservesProposal == replayTarget = OldCommit /\ replayBase = originalBase
LaterHintsPreserved == phase \notin {"published", "installed"} \/ laterHints \subseteq successorHints
NoUnprotectedRetirement == checkpoint \/ archived
RealResultRequired == outcome = NoOutcome \/ outcome = serverResult
RestartKeepsPublication == ~journal \/ phase # "active"
Spec == Init /\ [][Next]_vars
====
