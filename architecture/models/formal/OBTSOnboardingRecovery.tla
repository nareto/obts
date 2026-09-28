---------------- MODULE OBTSOnboardingRecovery ----------------
EXTENDS Naturals, TLC

(***************************************************************************
FM006 companion, revision 26: one enrollment, two immutable heads, one crash.
Context denotes validated identity, original approval baseline, mode and consent.
Server acceptance and local receipt publication are separate durable boundaries.
LegacyContext reproduces the missing-analysis implementation; the other mutants
isolate admission and ordering defects. Repeated edits during apply and snapshot
capture remain visible or queued, and never block setup/sync. Durability and byte
validation are assumed.
***************************************************************************)
CONSTANT Mutation
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "approved", durableContext |-> FALSE,
  volatileContext |-> TRUE, accepted |-> FALSE, credential |-> FALSE,
  running |-> TRUE, crashes |-> 0, resumed |-> FALSE,
  checkpoint |-> FALSE, cursor |-> 0, main |-> 0, target |-> 0,
  journal |-> FALSE, journalId |-> 0, recovered |-> FALSE,
  pendingAck |-> FALSE, applied |-> 2, acknowledged |-> 2,
  catchup |-> FALSE, interim |-> FALSE, unsafeUpload |-> FALSE,
  overwritten |-> FALSE, dropped |-> FALSE,
  diverged |-> FALSE, preserved |-> FALSE, blockedByEdit |-> FALSE,
  editCount |-> 0, localVisible |-> FALSE, captureActive |-> FALSE,
  captureVersion |-> 0, queuedVersion |-> 0,
  lastAction |-> "Init"]
PublishContext ==
  /\ s.running /\ s.phase = "approved"
  /\ s' = [s EXCEPT !.phase = "registering",
    !.durableContext = (Mutation # "legacy-context"), !.lastAction = "PublishContext"]
Accept ==
  /\ s.running /\ s.phase = "registering" /\ ~s.accepted
  /\ s' = [s EXCEPT !.accepted = TRUE, !.lastAction = "Accept"]
PublishReceipt ==
  /\ s.running /\ s.phase = "registering" /\ s.accepted
  /\ (s.durableContext \/ s.volatileContext)
  /\ s' = [s EXCEPT !.credential = TRUE, !.phase = "transfer", !.lastAction = "PublishReceipt"]
Crash ==
  /\ s.running /\ s.crashes = 0 /\ s.accepted /\ s.phase # "complete"
  /\ s' = [s EXCEPT !.running = FALSE, !.volatileContext = FALSE,
    !.crashes = 1, !.lastAction = "Crash"]
Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE, !.resumed = TRUE, !.lastAction = "Restart"]
Chunk ==
  /\ s.running /\ s.phase = "transfer" /\ s.cursor < 2
  /\ s' = [s EXCEPT !.cursor = @ + 1,
    !.checkpoint = (s.cursor = 1),
    !.phase = IF s.cursor = 1 THEN "objects" ELSE "transfer", !.lastAction = "Chunk"]
AdvanceMain ==
  /\ s.main = 0 /\ s.checkpoint
  /\ s' = [s EXCEPT !.main = 1, !.lastAction = "AdvanceMain"]
DropCheckpoint ==
  /\ Mutation = "drop-checkpoint" /\ s.running /\ s.checkpoint /\ s.main # s.target
  /\ s' = [s EXCEPT !.checkpoint = FALSE, !.cursor = 0,
    !.dropped = TRUE, !.lastAction = "DropCheckpoint"]
PlanApply ==
  /\ s.running /\ s.phase = "objects" /\ ~s.journal /\ ~s.pendingAck
  /\ s' = [s EXCEPT !.journal = TRUE, !.journalId = 1,
    !.phase = "applying", !.lastAction = "PlanApply"]
OverwriteJournal ==
  /\ Mutation = "overwrite-journal" /\ s.running /\ s.journal /\ s.resumed
  /\ s' = [s EXCEPT !.journalId = 2, !.overwritten = TRUE, !.lastAction = "OverwriteJournal"]
DivergeEdit ==
  /\ s.running /\ s.journal /\ s.phase = "applying" /\ s.editCount = 0
  /\ s' = [s EXCEPT !.diverged = TRUE, !.editCount = 1,
    !.localVisible = TRUE, !.lastAction = "DivergeEdit"]
BeginLocalCapture ==
  /\ s.running /\ s.journal /\ s.phase = "applying" /\ s.diverged
  /\ ~s.captureActive /\ s.editCount > s.queuedVersion
  /\ s' = [s EXCEPT !.captureActive = TRUE,
    !.captureVersion = s.editCount, !.lastAction = "BeginLocalCapture"]
SecondEditDuringCapture ==
  /\ s.running /\ s.journal /\ s.phase = "applying" /\ s.captureActive
  /\ s.editCount = 1
  /\ s' = [s EXCEPT !.editCount = 2, !.localVisible = TRUE,
    !.lastAction = "SecondEditDuringCapture"]
FinishLocalCapture ==
  /\ s.running /\ s.journal /\ s.phase = "applying" /\ s.captureActive
  /\ s' = [s EXCEPT !.captureActive = FALSE,
    !.queuedVersion = s.captureVersion, !.preserved = TRUE,
    !.lastAction = "FinishLocalCapture"]
BlockApplyForEdit ==
  /\ Mutation = "current-live-edit-block" /\ s.running /\ s.journal
  /\ s.phase = "applying" /\ s.editCount > 0
  /\ s' = [s EXCEPT !.blockedByEdit = TRUE, !.phase = "blocked",
    !.lastAction = "BlockApplyForEdit"]
Recover ==
  /\ s.running /\ s.journal /\ ~s.recovered
  /\ LET discard == Mutation = "discard-divergence" /\ s.diverged
     IN s' = [s EXCEPT !.recovered = TRUE,
       !.phase = IF s.phase = "blocked" THEN "applying" ELSE @,
       !.preserved = IF s.diverged /\ ~discard THEN TRUE ELSE s.preserved,
       !.lastAction = "Recover"]
Apply ==
  /\ s.running /\ s.phase = "applying" /\ s.recovered /\ ~s.pendingAck
  /\ s' = [s EXCEPT !.applied = s.target, !.pendingAck = TRUE,
    !.catchup = TRUE, !.interim = (s.main # s.target),
    !.journal = FALSE, !.phase = "applied",
    !.preserved = IF Mutation = "discard-divergence" /\ s.diverged THEN FALSE ELSE @ \/ s.diverged,
    !.localVisible = IF Mutation = "discard-divergence" /\ s.diverged THEN FALSE ELSE @,
    !.lastAction = "Apply"]
CompleteLiveApply ==
  /\ s.running /\ s.phase = "applying" /\ ~s.pendingAck
  /\ (s.editCount = 0 \/ s.localVisible)
  /\ LET discard == Mutation = "discard-live-edit" /\ s.diverged
     IN s' = [s EXCEPT !.applied = s.target, !.pendingAck = TRUE,
       !.catchup = TRUE, !.interim = (s.main # s.target),
       !.journal = FALSE, !.phase = "applied",
       !.preserved = IF discard THEN FALSE ELSE @ \/ s.diverged,
       !.localVisible = IF discard THEN FALSE ELSE @,
       !.lastAction = "CompleteLiveApply"]
NewApplyBeforeAck ==
  /\ Mutation = "skip-ack" /\ s.running /\ s.pendingAck /\ s.main # s.target
  /\ s' = [s EXCEPT !.applied = s.main, !.lastAction = "NewApplyBeforeAck"]
Ack ==
  /\ s.running /\ s.phase = "applied" /\ s.pendingAck
  /\ s' = [s EXCEPT !.acknowledged = s.applied, !.pendingAck = FALSE,
    !.checkpoint = FALSE, !.phase = "acknowledged", !.lastAction = "Ack"]
LoseCatchUp ==
  /\ Mutation = "lost-catchup" /\ s.running /\ s.phase = "acknowledged"
  /\ s.applied # s.main /\ s.resumed
  /\ s' = [s EXCEPT !.catchup = FALSE, !.lastAction = "LoseCatchUp"]
CaptureInterim ==
  /\ Mutation = "interim-ancestry" /\ s.running /\ s.resumed /\ s.interim
  /\ s.phase = "acknowledged"
  /\ s' = [s EXCEPT !.unsafeUpload = TRUE, !.lastAction = "CaptureInterim"]
CatchUp ==
  /\ s.running /\ s.phase = "acknowledged" /\ s.catchup
  /\ s' = IF s.applied = s.main
    THEN [s EXCEPT !.phase = "complete", !.catchup = FALSE,
      !.interim = FALSE, !.lastAction = "CatchUp"]
    ELSE [s EXCEPT !.phase = "transfer", !.target = s.main,
      !.cursor = 0, !.recovered = FALSE, !.lastAction = "CatchUp"]
Terminal == s.phase = "complete" /\ UNCHANGED s
Next == PublishContext \/ Accept \/ PublishReceipt \/ Crash \/ Restart \/ Chunk \/
  AdvanceMain \/ DropCheckpoint \/ PlanApply \/ OverwriteJournal \/ DivergeEdit \/
  BeginLocalCapture \/ SecondEditDuringCapture \/ FinishLocalCapture \/ BlockApplyForEdit \/
  Recover \/ Apply \/ CompleteLiveApply \/ NewApplyBeforeAck \/ Ack \/ LoseCatchUp \/ CaptureInterim \/
  CatchUp \/ Terminal
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(PublishContext) /\ WF_vars(Accept) /\ WF_vars(PublishReceipt)
  /\ WF_vars(Restart) /\ WF_vars(Chunk) /\ WF_vars(PlanApply) /\ WF_vars(Recover)
  /\ WF_vars(Apply) /\ WF_vars(CompleteLiveApply) /\ WF_vars(Ack) /\ WF_vars(CatchUp)
ResumeHasContext == s.resumed => s.durableContext
JournalPreserved == ~s.overwritten
CheckpointPreserved == ~s.dropped
AckBeforeNewApply == s.pendingAck => s.applied = s.target
CompleteAfterAck == s.phase = "complete" => s.applied = s.acknowledged
CatchUpDurable == (s.phase = "acknowledged" /\ s.applied # s.main) => s.catchup
AcceptedAncestry == ~s.unsafeUpload
DivergencePreserved == (s.diverged /\ s.applied = s.target) => s.preserved
LocalEditNeverBlocks == ~s.blockedByEdit
LatestLocalEditRecoverable == s.editCount = 0 \/ s.localVisible \/ s.queuedVersion = s.editCount
NoSecondEdit == s.editCount < 2
DivergenceRecovered == ~(s.diverged /\ s.recovered)
Safety == ResumeHasContext /\ JournalPreserved /\ CheckpointPreserved /\ AckBeforeNewApply /\ CompleteAfterAck /\ CatchUpDurable /\ AcceptedAncestry /\ DivergencePreserved /\ LocalEditNeverBlocks /\ LatestLocalEditRecoverable
EventuallyComplete == <> (s.phase = "complete")
NeverLostResponseRestart == ~(s.resumed /\ s.accepted /\ ~s.credential)
=============================================================================
