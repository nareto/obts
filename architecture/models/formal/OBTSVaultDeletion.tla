-------------------- MODULE OBTSVaultDeletion --------------------
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
OBTS-FM-004 corrected candidate: server whole-vault deletion lifecycle.

Request/captured identity, runtime admission closure, durable intent and
revocation, observable response acceptance, durable job discovery, erasure,
completion, and relative receipt expiry are separate state boundaries.
***************************************************************************)

CONSTANTS RequestOwner, RequestTarget, ConfirmationTarget,
  LiveSelectionTarget, OwnerV1, OwnerV2, HasCSRF, HasTypedConfirmation,
  PasswordReentry, IntegrityBlocked, Mutation, ReceiptDays,
  FaultBudget, FinalFaultBudget, MaxCrashes

Vaults == {"v1", "v2"}
Resources == {"git-history", "metadata-history", "transfer-temp",
  "device-credentials", "diagnostics"}
MaxAdmissions == 1
VaultOwner == [v \in Vaults |-> IF v = "v1" THEN OwnerV1 ELSE OwnerV2]
InitialResources == Resources
TargetKnown == RequestTarget \in Vaults
InitialPhase == [v \in Vaults |->
  IF TargetKnown /\ v = RequestTarget /\ IntegrityBlocked
  THEN "blocked_integrity" ELSE "active"]

VARIABLE s
vars == <<s>>

InitialState == [
  phase |-> InitialPhase,
  residue |-> [v \in Vaults |-> InitialResources],
  requestCaptured |-> FALSE,
  requestSeen |-> FALSE,
  capturedTarget |-> "none",
  capturedOwner |-> "none",
  capturedConfirmation |-> "none",
  effectiveTarget |-> "none",
  admissionClosed |-> FALSE,
  durableIntent |-> FALSE,
  durableRevocation |-> FALSE,
  durableTarget |-> "none",
  durableJob |-> "none",
  durableReceipt |-> FALSE,
  completionPublished |-> FALSE,
  responseStatus |-> "none",
  responseAccepted |-> FALSE,
  publicationFailureUsed |-> FALSE,
  publicationRejected |-> FALSE,
  ambiguousPublication |-> FALSE,
  inMemoryIntent |-> FALSE,
  discoveredJob |-> FALSE,
  running |-> TRUE,
  barrierRestored |-> TRUE,
  crashCount |-> 0,
  faultsRemaining |-> FaultBudget,
  finalFaultsRemaining |-> FinalFaultBudget,
  admitted |-> 0,
  admissionAfterIntent |-> FALSE,
  detached |-> 0,
  leaseReleasedEarly |-> FALSE,
  lateLeaseReuse |-> FALSE,
  eraseStarted |-> FALSE,
  eraseFaultOccurred |-> FALSE,
  finalMetadataDurable |-> FALSE,
  finalFaultOccurred |-> FALSE,
  receiptAge |-> 0,
  receiptExpired |-> FALSE,
  unattributedResidue |-> FALSE,
  localPreserved |-> TRUE,
  bridgePreserved |-> TRUE,
  backupsPreserved |-> TRUE,
  otherVaultTouched |-> FALSE,
  invalidClose |-> FALSE,
  repairedDeleted |-> FALSE,
  lastAction |-> "Init"
]
Init == s = InitialState

TargetPhase == IF s.durableTarget \in Vaults THEN s.phase[s.durableTarget]
  ELSE IF TargetKnown THEN s.phase[RequestTarget] ELSE "missing"
TargetResidue == IF s.durableTarget \in Vaults THEN s.residue[s.durableTarget] ELSE {}
DrainComplete == s.admitted = 0 /\ s.detached = 0
CapturedTargetKnown == s.capturedTarget \in Vaults
CapturedOwnerValid == CapturedTargetKnown /\ s.capturedOwner = VaultOwner[s.capturedTarget]
ConfirmationMatches == s.capturedConfirmation = s.capturedTarget
ValidCapturedRequest == s.requestCaptured /\ CapturedOwnerValid
  /\ ConfirmationMatches /\ HasCSRF /\ HasTypedConfirmation /\ ~PasswordReentry

CaptureRequest ==
  /\ s.running /\ s.barrierRestored /\ ~s.requestCaptured
  /\ s.responseStatus = "none"
  /\ s' = [s EXCEPT !.requestCaptured = TRUE,
      !.requestSeen = TRUE,
      !.capturedTarget = RequestTarget,
      !.capturedOwner = RequestOwner,
      !.capturedConfirmation = ConfirmationTarget,
      !.effectiveTarget = "none",
      !.lastAction = "CaptureRequest"]

Respond404 ==
  /\ s.requestCaptured /\ s.responseStatus = "none"
  /\ (~CapturedTargetKnown \/ ~CapturedOwnerValid)
  /\ s' = [s EXCEPT !.responseStatus = "404",
      !.requestCaptured = FALSE, !.lastAction = "Respond404"]

Respond400 ==
  /\ s.requestCaptured /\ s.responseStatus = "none"
  /\ CapturedTargetKnown /\ CapturedOwnerValid
  /\ (~ConfirmationMatches \/ ~HasCSRF \/ ~HasTypedConfirmation)
  /\ s' = [s EXCEPT !.responseStatus = "400",
      !.requestCaptured = FALSE, !.lastAction = "Respond400"]

CloseAdmissions ==
  /\ s.running /\ s.barrierRestored /\ s.requestCaptured
  /\ ~s.admissionClosed /\ s.responseStatus = "none"
  /\ (ValidCapturedRequest
      \/ Mutation \in {"accept-wrong-confirmation", "accept-wrong-owner",
          "accept-unknown-target", "stale-live-selection"})
  /\ s' = [s EXCEPT !.admissionClosed = TRUE,
      !.effectiveTarget = IF Mutation = "stale-live-selection"
        THEN LiveSelectionTarget ELSE s.capturedTarget,
      !.invalidClose = @ \/ ~ValidCapturedRequest,
      !.lastAction = "CloseAdmissions"]

PublishIntent ==
  /\ s.running /\ s.barrierRestored /\ s.admissionClosed
  /\ s.requestCaptured /\ ValidCapturedRequest
  /\ s.effectiveTarget = s.capturedTarget /\ s.effectiveTarget \in Vaults
  /\ s.phase[s.effectiveTarget] \in {"active", "blocked_integrity"}
  /\ ~s.durableIntent
  /\ s' = [s EXCEPT !.durableIntent = TRUE,
      !.durableRevocation = TRUE,
      !.durableTarget = s.effectiveTarget,
      !.durableJob = "deleting",
      !.phase[s.effectiveTarget] = "deleting",
      !.publicationRejected = FALSE,
      !.inMemoryIntent = FALSE,
      !.lastAction = "PublishIntent"]

RejectIntentPublication ==
  /\ Mutation \in {"intent-publication-failure", "intent-failure-mistake"}
  /\ s.running /\ s.barrierRestored /\ s.admissionClosed
  /\ s.requestCaptured /\ ValidCapturedRequest
  /\ s.effectiveTarget = s.capturedTarget /\ ~s.durableIntent
  /\ ~s.publicationFailureUsed
  /\ s' = [s EXCEPT !.publicationFailureUsed = TRUE,
      !.publicationRejected = TRUE,
      !.inMemoryIntent = TRUE,
      !.admissionClosed = FALSE,
      !.lastAction = "RejectIntentPublication"]

AmbiguousIntentPublication ==
  /\ Mutation \in {"ambiguous-intent-outcome", "ambiguous-reopen"}
  /\ s.running /\ s.barrierRestored /\ s.admissionClosed
  /\ s.requestCaptured /\ ValidCapturedRequest /\ ~s.durableIntent
  /\ ~s.publicationFailureUsed
  /\ s' = [s EXCEPT !.publicationFailureUsed = TRUE,
      !.ambiguousPublication = TRUE,
      !.inMemoryIntent = TRUE,
      !.lastAction = "AmbiguousIntentPublication"]

ReopenUnpublishedFailure ==
  /\ s.running /\ s.publicationRejected /\ ~s.ambiguousPublication
  /\ ~s.durableIntent /\ s' = [s EXCEPT
      !.requestCaptured = FALSE, !.effectiveTarget = "none",
      !.admissionClosed = FALSE, !.inMemoryIntent = FALSE,
      !.responseStatus = "503", !.lastAction = "ReopenUnpublishedFailure"]

MistakeFailedAcceptance ==
  /\ Mutation = "intent-failure-mistake"
  /\ s.publicationRejected /\ s.inMemoryIntent /\ ~s.durableIntent
  /\ s' = [s EXCEPT !.responseStatus = "202",
      !.responseAccepted = TRUE, !.lastAction = "MistakeFailedAcceptance"]

ReopenAmbiguous ==
  /\ Mutation = "ambiguous-reopen"
  /\ s.ambiguousPublication /\ ~s.durableIntent
  /\ s' = [s EXCEPT !.admissionClosed = FALSE,
      !.lastAction = "ReopenAmbiguous"]

PublishResponseBeforeIntent ==
  /\ Mutation = "response-before-intent"
  /\ s.running /\ s.barrierRestored /\ s.requestCaptured
  /\ s.admissionClosed /\ ~s.durableIntent
  /\ s' = [s EXCEPT !.responseStatus = "202",
      !.responseAccepted = TRUE, !.lastAction = "PublishResponseBeforeIntent"]

PublishResponse202 ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.durableRevocation /\ s.durableJob = "deleting"
  /\ s.responseStatus = "none"
  /\ s' = [s EXCEPT !.responseStatus = "202",
      !.responseAccepted = TRUE, !.lastAction = "PublishResponse202"]

Admit ==
  /\ s.running /\ s.barrierRestored
  /\ ((~s.durableIntent /\ ~s.admissionClosed /\ TargetKnown
       /\ s.phase[RequestTarget] = "active")
      \/ (Mutation = "admission-release-race" /\ s.durableIntent
          /\ s.admissionClosed /\ TargetPhase = "deleting"))
  /\ s.admitted < MaxAdmissions
  /\ s' = [s EXCEPT !.admitted = @ + 1,
      !.admissionAfterIntent = @ \/ s.durableIntent, !.lastAction = "Admit"]

DetachLateWork ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.admissionClosed /\ TargetPhase = "deleting" /\ s.admitted > 0
  /\ s' = [s EXCEPT !.admitted = @ - 1,
      !.detached = @ + 1, !.lastAction = "DetachLateWork"]

ReleaseAdmitted ==
  /\ s.running /\ s.barrierRestored /\ s.admitted > 0
  /\ s' = [s EXCEPT !.admitted = @ - 1, !.lastAction = "ReleaseAdmitted"]

ReleaseDetached ==
  /\ s.running /\ s.barrierRestored /\ s.detached > 0
  /\ s' = [s EXCEPT !.detached = @ - 1,
      !.leaseReleasedEarly = FALSE, !.lastAction = "ReleaseDetached"]

EarlyReleaseLease ==
  /\ Mutation = "early-release-late-work"
  /\ s.running /\ s.barrierRestored /\ s.detached > 0
  /\ ~s.leaseReleasedEarly
  /\ s' = [s EXCEPT !.leaseReleasedEarly = TRUE,
      !.lastAction = "EarlyReleaseLease"]

LateLeaseReuse ==
  /\ Mutation = "early-release-late-work"
  /\ s.running /\ s.barrierRestored /\ s.detached > 0
  /\ s.leaseReleasedEarly
  /\ s' = [s EXCEPT !.lateLeaseReuse = TRUE,
      !.lastAction = "LateLeaseReuse"]

Crash ==
  /\ s.running /\ s.crashCount < MaxCrashes
  /\ (Mutation # "post-final-fault-crash"
      \/ (s.finalFaultOccurred /\ ~s.completionPublished))
  /\ s' = [s EXCEPT !.running = FALSE,
      !.barrierRestored = FALSE, !.requestCaptured = FALSE,
      !.capturedTarget = "none", !.capturedOwner = "none",
      !.capturedConfirmation = "none", !.effectiveTarget = "none",
      !.admissionClosed = s.durableIntent \/ s.ambiguousPublication,
      !.inMemoryIntent = FALSE,
      !.discoveredJob = FALSE, !.responseStatus = "none",
      !.responseAccepted = FALSE, !.crashCount = @ + 1,
      !.lastAction = "Crash"]

Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE,
      !.barrierRestored = FALSE,
      !.discoveredJob = IF Mutation = "preintent-resume" /\ ~s.durableIntent
        /\ s.requestSeen THEN TRUE ELSE @,
      !.lastAction = "Restart"]

RestoreDeletionBarrier ==
  /\ s.running /\ ~s.barrierRestored
  /\ s' = [s EXCEPT !.barrierRestored = TRUE,
      !.admissionClosed = IF s.durableIntent \/ s.ambiguousPublication
        THEN TRUE ELSE FALSE,
      !.effectiveTarget = IF s.durableIntent THEN s.durableTarget ELSE "none",
      !.lastAction = "RestoreDeletionBarrier"]

DiscoverDurableJob ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.durableJob = "deleting"
  /\ s' = [s EXCEPT !.discoveredJob = TRUE,
      !.lastAction = "DiscoverDurableJob"]

EraseTarget == IF s.durableIntent THEN s.durableTarget ELSE s.effectiveTarget
EraseResidue == IF EraseTarget \in Vaults THEN s.residue[EraseTarget] ELSE {}

EraseResource ==
  /\ s.running /\ s.barrierRestored
  /\ ((s.durableIntent /\ s.durableRevocation /\ s.admissionClosed
       /\ TargetPhase = "deleting" /\ DrainComplete
       /\ ~s.unattributedResidue /\ TargetResidue # {}
       /\ (s.faultsRemaining = 0 \/ Mutation # "force-erase-fault"))
      \/ (Mutation = "erase-before-intent" /\ ~s.durableIntent
          /\ EraseTarget \in Vaults /\ s.phase[EraseTarget] = "active"
          /\ s.admitted = 0 /\ s.detached = 0))
  /\ \E r \in Resources :
      /\ r \in EraseResidue
      /\ s' = [s EXCEPT !.residue[EraseTarget] = @ \ {r},
          !.eraseStarted = TRUE, !.lastAction = "EraseResource"]

EraseFault ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.durableRevocation /\ s.admissionClosed /\ TargetPhase = "deleting"
  /\ DrainComplete /\ ~s.unattributedResidue /\ TargetResidue # {}
  /\ s.faultsRemaining > 0
  /\ s' = [s EXCEPT !.faultsRemaining = @ - 1,
      !.eraseFaultOccurred = TRUE, !.lastAction = "EraseFault"]

IntroduceUnattributedResidue ==
  /\ Mutation \in {"unattributed-residue", "complete-unattributed"}
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.admissionClosed /\ TargetPhase = "deleting" /\ DrainComplete
  /\ ~s.unattributedResidue
  /\ s' = [s EXCEPT !.unattributedResidue = TRUE,
      !.lastAction = "IntroduceUnattributedResidue"]

FinalPersistFault ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.durableRevocation /\ s.admissionClosed /\ TargetPhase = "deleting"
  /\ DrainComplete /\ TargetResidue = {} /\ ~s.unattributedResidue
  /\ s.finalFaultsRemaining > 0
  /\ s' = [s EXCEPT !.finalFaultsRemaining = @ - 1,
      !.finalFaultOccurred = TRUE, !.lastAction = "FinalPersistFault"]

PublishReceipt ==
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ s.durableRevocation /\ s.admissionClosed /\ TargetPhase = "deleting"
  /\ ((DrainComplete /\ TargetResidue = {} /\ ~s.unattributedResidue
      /\ s.finalFaultsRemaining = 0)
      \/ Mutation = "premature-completion"
      \/ (Mutation = "complete-unattributed" /\ DrainComplete
          /\ TargetResidue = {} /\ s.finalFaultsRemaining = 0))
  /\ s' = [s EXCEPT !.phase[s.durableTarget] = "receipt",
      !.durableReceipt = TRUE, !.durableJob = "receipt",
      !.completionPublished = TRUE, !.finalMetadataDurable = TRUE,
      !.discoveredJob = FALSE, !.receiptAge = 0,
      !.lastAction = "PublishReceipt"]

AdvanceReceiptAge ==
  /\ s.running /\ s.barrierRestored /\ s.durableReceipt
  /\ TargetPhase = "receipt" /\ s.receiptAge < ReceiptDays
  /\ s' = [s EXCEPT !.receiptAge = @ + 1,
      !.lastAction = "AdvanceReceiptAge"]

ExpireReceipt ==
  /\ s.running /\ s.barrierRestored /\ s.durableReceipt
  /\ TargetPhase = "receipt" /\ s.receiptAge >= ReceiptDays
  /\ s' = [s EXCEPT !.phase[s.durableTarget] = "expired",
      !.receiptExpired = TRUE, !.lastAction = "ExpireReceipt"]

AdvancePendingAge ==
  /\ Mutation = "expire-unfinished"
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ TargetPhase = "deleting" /\ s.receiptAge < ReceiptDays
  /\ s' = [s EXCEPT !.receiptAge = @ + 1,
      !.lastAction = "AdvancePendingAge"]

PrematureExpire ==
  /\ Mutation = "expire-unfinished"
  /\ s.running /\ s.barrierRestored /\ s.durableIntent
  /\ TargetPhase = "deleting" /\ ~s.durableReceipt
  /\ s.receiptAge >= ReceiptDays
  /\ s' = [s EXCEPT !.phase[s.durableTarget] = "expired",
      !.receiptExpired = TRUE, !.lastAction = "PrematureExpire"]

StartupRepairRecreate ==
  /\ Mutation = "startup-repair-recreate"
  /\ s.running /\ s.barrierRestored /\ s.durableReceipt
  /\ TargetPhase \in {"receipt", "expired"}
  /\ s' = [s EXCEPT !.phase[s.durableTarget] = "active",
      !.residue[s.durableTarget] = InitialResources,
      !.repairedDeleted = TRUE, !.lastAction = "StartupRepairRecreate"]

MutateBoundary ==
  /\ Mutation = "mutate-boundary"
  /\ s.running /\ s.durableIntent
  /\ s' = [s EXCEPT !.localPreserved = FALSE,
      !.lastAction = "MutateBoundary"]

MutateOtherVault ==
  /\ Mutation = "mutate-other-vault"
  /\ s.running /\ s.durableIntent
  /\ \E v \in Vaults \ {s.durableTarget} :
      \E r \in Resources :
      /\ r \in s.residue[v]
      /\ s' = [s EXCEPT !.residue[v] = @ \ {r},
          !.otherVaultTouched = TRUE, !.lastAction = "MutateOtherVault"]

Stutter == UNCHANGED vars
Next == CaptureRequest \/ Respond404 \/ Respond400 \/ CloseAdmissions \/
  PublishIntent \/ RejectIntentPublication \/ AmbiguousIntentPublication \/
  ReopenUnpublishedFailure \/ MistakeFailedAcceptance \/ ReopenAmbiguous \/
  PublishResponseBeforeIntent \/ PublishResponse202 \/ Admit \/ DetachLateWork \/ ReleaseAdmitted \/
  ReleaseDetached \/ EarlyReleaseLease \/ LateLeaseReuse \/ Crash \/ Restart \/
  RestoreDeletionBarrier \/ DiscoverDurableJob \/ EraseResource \/ EraseFault \/
  IntroduceUnattributedResidue \/ FinalPersistFault \/ PublishReceipt \/
  AdvanceReceiptAge \/ AdvancePendingAge \/ ExpireReceipt \/ PrematureExpire \/ StartupRepairRecreate \/
  MutateBoundary \/ MutateOtherVault \/ Stutter

Spec == Init /\ [][Next]_vars
FairSpec == Spec
  /\ WF_vars(CaptureRequest) /\ WF_vars(CloseAdmissions)
  /\ WF_vars(PublishIntent) /\ WF_vars(PublishResponse202)
  /\ WF_vars(ReleaseAdmitted) /\ WF_vars(ReleaseDetached)
  /\ WF_vars(Restart) /\ WF_vars(RestoreDeletionBarrier)
  /\ WF_vars(DiscoverDurableJob) /\ WF_vars(EraseResource)
  /\ WF_vars(EraseFault) /\ WF_vars(FinalPersistFault)
  /\ WF_vars(PublishReceipt) /\ WF_vars(AdvanceReceiptAge)
  /\ WF_vars(ExpireReceipt)

TypeOK ==
  /\ s.phase \in [Vaults -> {"active", "blocked_integrity", "deleting", "receipt", "expired"}]
  /\ s.residue \in [Vaults -> SUBSET Resources]
  /\ s.requestCaptured \in BOOLEAN
  /\ s.requestSeen \in BOOLEAN
  /\ s.capturedTarget \in Vaults \cup {"none", RequestTarget}
  /\ s.capturedOwner \in {OwnerV1, OwnerV2, "none", RequestOwner}
  /\ s.capturedConfirmation \in Vaults \cup {"none", ConfirmationTarget}
  /\ s.effectiveTarget \in Vaults \cup {"none", LiveSelectionTarget}
  /\ s.durableTarget \in Vaults \cup {"none"}
  /\ s.admissionClosed \in BOOLEAN
  /\ s.durableIntent \in BOOLEAN
  /\ s.durableRevocation \in BOOLEAN
  /\ s.durableJob \in {"none", "deleting", "receipt"}
  /\ s.durableReceipt \in BOOLEAN
  /\ s.responseStatus \in {"none", "400", "404", "202", "503"}
  /\ s.responseAccepted \in BOOLEAN
  /\ s.publicationFailureUsed \in BOOLEAN
  /\ s.publicationRejected \in BOOLEAN
  /\ s.ambiguousPublication \in BOOLEAN
  /\ s.inMemoryIntent \in BOOLEAN
  /\ s.discoveredJob \in BOOLEAN
  /\ s.running \in BOOLEAN
  /\ s.barrierRestored \in BOOLEAN
  /\ s.crashCount \in 0..MaxCrashes
  /\ s.faultsRemaining \in 0..FaultBudget
  /\ s.finalFaultsRemaining \in 0..FinalFaultBudget
  /\ s.admitted \in 0..MaxAdmissions
  /\ s.admissionAfterIntent \in BOOLEAN
  /\ s.detached \in 0..MaxAdmissions
  /\ s.leaseReleasedEarly \in BOOLEAN
  /\ s.lateLeaseReuse \in BOOLEAN
  /\ s.eraseStarted \in BOOLEAN
  /\ s.eraseFaultOccurred \in BOOLEAN
  /\ s.finalMetadataDurable \in BOOLEAN
  /\ s.finalFaultOccurred \in BOOLEAN
  /\ s.receiptAge \in 0..ReceiptDays
  /\ s.receiptExpired \in BOOLEAN
  /\ s.unattributedResidue \in BOOLEAN
  /\ s.localPreserved \in BOOLEAN
  /\ s.bridgePreserved \in BOOLEAN
  /\ s.backupsPreserved \in BOOLEAN
  /\ s.otherVaultTouched \in BOOLEAN
  /\ s.invalidClose \in BOOLEAN
  /\ s.repairedDeleted \in BOOLEAN
  /\ s.lastAction \in STRING

AuthorizationSafe == ~s.invalidClose
ResponseRequiresDurableIntent ==
  s.responseAccepted => s.durableIntent /\ s.durableRevocation
    /\ s.durableJob \in {"deleting", "receipt"}
IntentFailureNoAcceptance ==
  s.publicationRejected => ~s.durableIntent /\ ~s.durableRevocation
    /\ s.durableJob = "none" /\ ~s.responseAccepted
NoPreIntentRecovery == s.discoveredJob => s.durableIntent /\ s.durableJob = "deleting"
NoTargetDrift == s.effectiveTarget = "none" \/ ~s.requestCaptured
  \/ s.effectiveTarget = s.capturedTarget
AmbiguousPublicationClosed == s.ambiguousPublication => s.admissionClosed
NoAdmissionAfterIntent == ~s.admissionAfterIntent
NoAdmissionBeforeBarrier ==
  s.lastAction = "Admit" => s.barrierRestored
NoErasureBeforeIntent == s.eraseStarted => s.durableIntent /\ s.durableRevocation
CompletionRequiresDurableErasure ==
  s.durableReceipt => s.finalMetadataDurable /\ DrainComplete
    /\ TargetResidue = {} /\ ~s.unattributedResidue
NoCompletionWithUnattributed == s.durableReceipt => ~s.unattributedResidue
NoResurrection ==
  s.durableReceipt => TargetPhase \in {"receipt", "expired"}
    /\ TargetResidue = {}
    /\ s.durableJob = "receipt"
OtherVaultsPreserved ==
  \A v \in Vaults \ {s.durableTarget} : s.residue[v] = InitialResources
BoundariesPreserved == s.localPreserved /\ s.bridgePreserved /\ s.backupsPreserved
NoOtherVaultMutation == ~s.otherVaultTouched
DetachedWorkSafe == s.detached > 0
  => s.durableIntent /\ s.admissionClosed /\ ~s.leaseReleasedEarly
NoLateLeaseReuse == ~s.lateLeaseReuse
ReceiptExpiryRelative == s.receiptExpired => s.durableReceipt
NoReopenAfterCompletion == ~s.repairedDeleted
No202BeforeIntent == ResponseRequiresDurableIntent

UnfinishedNeverExpires == ~s.receiptExpired \/ s.durableReceipt
DeletionEventuallyCompletes == s.durableIntent ~> s.durableReceipt
ReceiptEventuallyExpires ==
  (s.durableReceipt /\ TargetPhase = "receipt") ~> (TargetPhase = "expired")

NeverPreIntentRecovery == ~s.discoveredJob
NeverPublicationRejected == ~s.publicationRejected
NeverResponseBeforeIntent == ~s.responseAccepted
NeverResponseAccepted == ~s.responseAccepted
NeverRestartAfterFinalFault ==
  ~(s.lastAction = "Restart" /\ s.finalFaultOccurred /\ ~s.durableReceipt)
NeverUnattributedResidue == ~s.unattributedResidue
NeverReceiptExpired == ~s.receiptExpired
NeverBlockedDeleting == ~(IntegrityBlocked /\ TargetPhase = "deleting")

NeverRestartAfterDurableDelete ==
  ~(s.lastAction = "Restart" /\ s.durableIntent /\ TargetPhase = "deleting")
NeverEraseRetry == ~(s.eraseFaultOccurred /\ s.lastAction = "EraseResource")
NeverFinalRetryCompletion ==
  ~(s.finalFaultOccurred /\ s.lastAction = "PublishReceipt")
NeverUnattributedCompletion ==
  ~(s.unattributedResidue /\ s.lastAction = "PublishReceipt")
NeverStartupRecreate == ~s.repairedDeleted
NeverBoundaryMutation == s.localPreserved /\ s.bridgePreserved /\ s.backupsPreserved
NeverOtherVaultMutation == ~s.otherVaultTouched
NeverIntentFailureAcceptance ==
  ~(s.publicationRejected /\ s.responseAccepted)
NeverAmbiguousReopen ==
  ~(s.ambiguousPublication /\ ~s.admissionClosed)

=============================================================================
