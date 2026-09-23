-------------------- MODULE OBTSOnboarding --------------------
EXTENDS Naturals, TLC

(***************************************************************************
OBTS-FM-006: browser authorization, durable device enrollment, resumable
use-server transfer, recovery publication, apply, and catch-up.

Every field except running, crashCount, and lastAction denotes an already
published durable record. Actions model successful publication boundaries;
Crash discards execution only, while negative controls violate publication
ordering explicitly. Filesystem flush correctness remains an implementation
obligation rather than a property of this state-machine abstraction.
***************************************************************************)

CONSTANTS Mutation, LocalHasContent, EnableClock,
  PendingLimit, ApprovedLimit, ChunkCount, MaxCrashes

Heads == {0, 1}
Phases == {"pending", "approved", "registered", "transferring",
  "objects_complete", "applied", "acknowledged", "complete", "expired"}
TransferPhases == {"transferring", "objects_complete", "applied", "acknowledged", "complete"}
PostRegistrationPhases == {"registered", "transferring", "objects_complete", "applied", "acknowledged", "complete"}

VARIABLE s
vars == <<s>>

InitialState == [
  phase |-> "pending",
  pendingAge |-> 0,
  approvedAge |-> 0,
  serverMain |-> 0,
  pinnedMain |-> 2,
  transferMain |-> 2,
  approvalPin |-> 2,
  wasApproved |-> FALSE,
  expiredReason |-> "none",
  deviceCredential |-> FALSE,
  everRegistered |-> FALSE,
  recoveryPublished |-> FALSE,
  cursor |-> 0,
  checkpointComplete |-> FALSE,
  checkpointMain |-> 2,
  localApplied |-> FALSE,
  appliedMain |-> 2,
  acknowledged |-> FALSE,
  acknowledgedMain |-> 2,
  running |-> TRUE,
  crashCount |-> 0,
  lastAction |-> "Init"
]

Init == s = InitialState

TickPending ==
  /\ EnableClock /\ s.running /\ s.phase = "pending"
  /\ s.pendingAge < PendingLimit
  /\ s' = [s EXCEPT !.pendingAge = @ + 1, !.lastAction = "TickPending"]

TickApproved ==
  /\ EnableClock /\ s.running /\ s.phase = "approved"
  /\ s.approvedAge < ApprovedLimit
  /\ s' = [s EXCEPT !.pendingAge = @ + 1,
      !.approvedAge = @ + 1, !.lastAction = "TickApproved"]

ExpirePending ==
  /\ s.running /\ s.phase = "pending" /\ s.pendingAge >= PendingLimit
  /\ s' = [s EXCEPT !.phase = "expired",
      !.expiredReason = "pending", !.lastAction = "ExpirePending"]

Approve ==
  /\ s.running /\ s.phase = "pending" /\ s.pendingAge < PendingLimit
  /\ s' = [s EXCEPT !.phase = "approved", !.approvedAge = 0,
      !.pinnedMain = s.serverMain, !.approvalPin = s.serverMain,
      !.wasApproved = TRUE, !.lastAction = "Approve"]

ExpireApproved ==
  /\ s.running /\ s.phase = "approved" /\ s.approvedAge >= ApprovedLimit
  /\ s' = [s EXCEPT !.phase = "expired",
      !.expiredReason = "approved", !.lastAction = "ExpireApproved"]

ExpireApprovedAtPendingDeadline ==
  /\ Mutation = "reuse-pending-deadline"
  /\ s.running /\ s.phase = "approved"
  /\ s.pendingAge >= PendingLimit /\ s.approvedAge < ApprovedLimit
  /\ s' = [s EXCEPT !.phase = "expired",
      !.expiredReason = "pending-after-approval",
      !.lastAction = "ExpireApprovedAtPendingDeadline"]

AdvanceMain ==
  /\ s.running /\ s.serverMain = 0
  /\ s' = [s EXCEPT !.serverMain = 1, !.lastAction = "AdvanceMain"]

RetargetPinned ==
  /\ Mutation = "retarget-approved-snapshot"
  /\ s.running /\ s.wasApproved /\ s.serverMain # s.pinnedMain
  /\ s' = [s EXCEPT !.pinnedMain = s.serverMain,
      !.lastAction = "RetargetPinned"]

PublishRecovery ==
  /\ s.running /\ LocalHasContent /\ s.phase = "approved"
  /\ ~s.recoveryPublished
  /\ s' = [s EXCEPT !.recoveryPublished = TRUE,
      !.lastAction = "PublishRecovery"]

Register ==
  /\ s.running /\ s.phase = "approved" /\ s.approvedAge < ApprovedLimit
  /\ (~LocalHasContent \/ s.recoveryPublished)
  /\ s' = [s EXCEPT !.phase = "registered",
      !.deviceCredential = TRUE, !.everRegistered = TRUE,
      !.lastAction = "Register"]

RegisterWithoutRecovery ==
  /\ Mutation = "apply-before-recovery"
  /\ s.running /\ s.phase = "approved" /\ s.approvedAge < ApprovedLimit
  /\ LocalHasContent /\ ~s.recoveryPublished
  /\ s' = [s EXCEPT !.phase = "registered",
      !.deviceCredential = TRUE, !.everRegistered = TRUE,
      !.lastAction = "RegisterWithoutRecovery"]

TransferBeforeRegistration ==
  /\ Mutation = "transfer-before-registration"
  /\ s.running /\ s.phase = "approved"
  /\ s' = [s EXCEPT !.phase = "transferring",
      !.lastAction = "TransferBeforeRegistration"]

StartTransfer ==
  /\ s.running /\ s.phase = "registered" /\ s.deviceCredential
  /\ s' = [s EXCEPT !.phase = "transferring",
      !.transferMain = s.pinnedMain, !.cursor = 0,
      !.checkpointComplete = FALSE, !.lastAction = "StartTransfer"]

ReceiveChunk ==
  /\ s.running /\ s.phase = "transferring"
  /\ s.deviceCredential /\ s.cursor < ChunkCount
  /\ s.cursor + 1 < ChunkCount
  /\ s' = [s EXCEPT !.cursor = @ + 1, !.lastAction = "ReceiveChunk"]

ReceiveFinalChunk ==
  /\ s.running /\ s.phase = "transferring"
  /\ s.deviceCredential /\ s.cursor < ChunkCount
  /\ s.cursor + 1 = ChunkCount
  /\ Mutation # "drop-final-checkpoint"
  /\ s' = [s EXCEPT !.cursor = @ + 1,
      !.checkpointComplete = TRUE, !.checkpointMain = s.transferMain,
      !.phase = "objects_complete", !.lastAction = "ReceiveFinalChunk"]

ReceiveFinalWithoutCheckpoint ==
  /\ Mutation = "drop-final-checkpoint"
  /\ s.running /\ s.phase = "transferring"
  /\ s.deviceCredential /\ s.cursor < ChunkCount
  /\ s.cursor + 1 = ChunkCount
  /\ s' = [s EXCEPT !.cursor = @ + 1,
      !.checkpointComplete = FALSE, !.phase = "objects_complete",
      !.lastAction = "ReceiveFinalWithoutCheckpoint"]

Apply ==
  /\ s.running /\ s.phase = "objects_complete" /\ s.checkpointComplete
  /\ s.checkpointMain = s.transferMain
  /\ (~LocalHasContent \/ s.recoveryPublished)
  /\ s' = [s EXCEPT !.phase = "applied", !.localApplied = TRUE,
      !.appliedMain = s.transferMain, !.acknowledged = FALSE,
      !.lastAction = "Apply"]

ApplyWithoutRecovery ==
  /\ Mutation = "apply-before-recovery"
  /\ s.running /\ s.phase = "objects_complete" /\ s.checkpointComplete
  /\ s.checkpointMain = s.transferMain
  /\ LocalHasContent /\ ~s.recoveryPublished
  /\ s' = [s EXCEPT !.phase = "applied", !.localApplied = TRUE,
      !.appliedMain = s.transferMain, !.acknowledged = FALSE,
      !.lastAction = "ApplyWithoutRecovery"]

Acknowledge ==
  /\ s.running /\ s.phase = "applied" /\ s.localApplied
  /\ s' = [s EXCEPT !.phase = "acknowledged",
      !.acknowledged = TRUE, !.acknowledgedMain = s.appliedMain,
      !.checkpointComplete = FALSE, !.lastAction = "Acknowledge"]

CatchUp ==
  /\ s.running /\ s.phase = "acknowledged" /\ s.acknowledged
  /\ IF s.appliedMain = s.serverMain
      THEN s' = [s EXCEPT !.phase = "complete", !.lastAction = "CatchUp"]
      ELSE s' = [s EXCEPT !.phase = "transferring",
          !.transferMain = s.serverMain, !.cursor = 0,
          !.checkpointComplete = FALSE, !.acknowledged = FALSE,
          !.lastAction = "CatchUp"]

CompleteWithoutAcknowledgement ==
  /\ Mutation = "complete-before-ack"
  /\ s.running /\ s.phase = "applied"
  /\ s' = [s EXCEPT !.phase = "complete",
      !.lastAction = "CompleteWithoutAcknowledgement"]

Crash ==
  /\ s.running /\ s.crashCount < MaxCrashes
  /\ s.phase \in {"registered", "transferring", "objects_complete", "applied", "acknowledged"}
  /\ s' = [s EXCEPT !.running = FALSE,
      !.crashCount = @ + 1, !.lastAction = "Crash"]

Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE, !.lastAction = "Restart"]

Terminal ==
  /\ s.phase \in {"complete", "expired"}
  /\ UNCHANGED s

Next == TickPending \/ TickApproved \/ ExpirePending \/ Approve \/
  ExpireApproved \/ ExpireApprovedAtPendingDeadline \/ AdvanceMain \/
  RetargetPinned \/ PublishRecovery \/ Register \/ RegisterWithoutRecovery \/
  TransferBeforeRegistration \/ StartTransfer \/ ReceiveChunk \/
  ReceiveFinalChunk \/ ReceiveFinalWithoutCheckpoint \/ Apply \/
  ApplyWithoutRecovery \/ Acknowledge \/ CatchUp \/
  CompleteWithoutAcknowledgement \/ Crash \/ Restart \/ Terminal

Spec == Init /\ [][Next]_vars

FairSpec == Init /\ [][Next]_vars
  /\ WF_vars(Approve)
  /\ WF_vars(PublishRecovery)
  /\ WF_vars(Register)
  /\ WF_vars(StartTransfer)
  /\ WF_vars(ReceiveChunk)
  /\ WF_vars(ReceiveFinalChunk)
  /\ WF_vars(Apply)
  /\ WF_vars(Acknowledge)
  /\ WF_vars(CatchUp)
  /\ WF_vars(Restart)

TypeOK ==
  /\ s.phase \in Phases
  /\ s.pendingAge \in 0..(PendingLimit + ApprovedLimit)
  /\ s.approvedAge \in 0..ApprovedLimit
  /\ s.serverMain \in Heads
  /\ s.pinnedMain \in {0, 1, 2}
  /\ s.transferMain \in {0, 1, 2}
  /\ s.checkpointMain \in {0, 1, 2}
  /\ s.approvalPin \in {0, 1, 2}
  /\ s.appliedMain \in {0, 1, 2}
  /\ s.acknowledgedMain \in {0, 1, 2}
  /\ s.acknowledged \in BOOLEAN
  /\ s.cursor \in 0..ChunkCount
  /\ s.crashCount \in 0..MaxCrashes

ApprovedLeaseSeparated ==
  ~(s.wasApproved /\ s.phase = "expired" /\ s.expiredReason = "pending-after-approval")

PinnedBaselineStable == ~s.wasApproved \/ s.pinnedMain = s.approvalPin

TransferRequiresCredential == s.phase \in TransferPhases => s.deviceCredential

RegisteredDoesNotReauthorize ==
  ~s.everRegistered \/ s.phase \in PostRegistrationPhases

RecoveryBeforeApply ==
  ~s.localApplied \/ ~LocalHasContent \/ s.recoveryPublished

FinalCheckpointBeforeApply ==
  s.phase \in {"objects_complete", "applied"} =>
    s.checkpointComplete /\ s.checkpointMain = s.transferMain /\
    (s.phase = "applied" => s.appliedMain = s.checkpointMain)

CompleteRequiresAcknowledgement ==
  s.phase = "complete" =>
    s.localApplied /\ s.acknowledged /\ s.acknowledgedMain = s.appliedMain

EventuallyComplete == <> (s.phase = "complete")

NeverRestartedTransfer == ~(s.lastAction = "Restart" /\ s.cursor > 0)

=============================================================================
