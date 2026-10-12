--------------------------- MODULE OBTSDeviceRemoval ---------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS OwnerA, OwnerB, ExpectedOID, CanonicalOID, OtherOID, WorkMode, Mutation
ASSUME WorkMode \in {"covered", "unmerged"}

VARIABLES running, ready, barrier, intent, intentExpected, intentGeneration,
          actualRef, canonical, otherRef, active, detached, drained, conflict,
          prepared, discard, casObserved, credentials, replay, transferResidue,
          diagnosticsResidue, deviceRow, removed, crashCount, owner
vars == <<running, ready, barrier, intent, intentExpected, intentGeneration,
          actualRef, canonical, otherRef, active, detached, drained, conflict,
          prepared, discard, casObserved, credentials, replay, transferResidue,
          diagnosticsResidue, deviceRow, removed, crashCount, owner>>

Init ==
  /\ running = TRUE
  /\ ready = TRUE
  /\ barrier = FALSE
  /\ intent = FALSE
  /\ intentExpected = ExpectedOID
  /\ intentGeneration = 0
  /\ actualRef = IF WorkMode = "covered" THEN CanonicalOID ELSE ExpectedOID
  /\ canonical = CanonicalOID
  /\ otherRef = OtherOID
  /\ active = 0
  /\ detached = 0
  /\ drained = FALSE
  /\ conflict = FALSE
  /\ prepared = FALSE
  /\ discard = FALSE
  /\ casObserved = "none"
  /\ credentials = TRUE
  /\ replay = TRUE
  /\ transferResidue = TRUE
  /\ diagnosticsResidue = TRUE
  /\ deviceRow = TRUE
  /\ removed = FALSE
  /\ crashCount = 0
  /\ owner = OwnerA

AdmitWork == ready /\ ~barrier /\ ~intent /\ active = 0 /\ active' = 1 /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
DetachWork == active = 1 /\ active' = 0 /\ detached' = 1 /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
FinishCoveredWork == intent /\ detached = 1 /\ WorkMode = "covered" /\ detached' = 0 /\ actualRef' = "covered-work-result" /\ drained' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, canonical, otherRef, active, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
FinishUnmergedWork == intent /\ detached = 1 /\ WorkMode = "unmerged" /\ detached' = 0 /\ actualRef' = "unmerged-work-result" /\ drained' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, canonical, otherRef, active, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
FinishConflictingWork == intent /\ detached = 1 /\ detached' = 0 /\ actualRef' = ExpectedOID /\ conflict' = TRUE /\ drained' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, canonical, otherRef, active, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
PublishIntent == ready /\ ~intent /\ intent' = (Mutation # "intent-before-ref") /\ barrier' = TRUE /\ intentExpected' = actualRef /\ intentGeneration' = 1 /\ UNCHANGED <<running, ready, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
Drain == (intent \/ Mutation = "intent-before-ref") /\ barrier /\ active = 0 /\ detached = 0 /\ drained' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
RetryIntent == intent /\ barrier /\ drained /\ actualRef # "missing" /\ actualRef # intentExpected /\ intentGeneration < 2 /\ intentExpected' = actualRef /\ intentGeneration' = intentGeneration + 1 /\ drained' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, actualRef, canonical, otherRef, active, detached, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
PrepareOperation == ~intent /\ prepared' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
OpenConflict == ~intent /\ conflict' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
ConfirmDiscard == intent /\ WorkMode = "unmerged" /\ discard' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
ForeignAdvance == intent /\ actualRef = intentExpected /\ actualRef' = "foreign-race" /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
RemoveRef == (intent \/ Mutation = "intent-before-ref") /\ barrier /\ (drained \/ Mutation = "skip-drain") /\ active = 0 /\ detached = 0 /\ (~conflict \/ Mutation = "skip-conflict") /\ (~prepared \/ Mutation = "skip-prepared") /\ (WorkMode = "covered" \/ discard \/ Mutation = "skip-unmerged") /\ (actualRef = intentExpected \/ Mutation = "wrong-cas") /\ (owner = OwnerA \/ Mutation = "owner-bypass") /\ casObserved' = actualRef /\ actualRef' = "missing" /\ canonical' = (IF Mutation = "damage-preserved-state" THEN "damaged" ELSE canonical) /\ otherRef' = (IF Mutation = "damage-preserved-state" THEN "missing" ELSE otherRef) /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, active, detached, drained, conflict, prepared, discard, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
CleanupCredentials == actualRef = "missing" /\ intent /\ credentials' = FALSE /\ replay' = FALSE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
CleanupResidue == actualRef = "missing" /\ intent /\ transferResidue' = FALSE /\ diagnosticsResidue' = FALSE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, deviceRow, removed, crashCount, owner>>
PublishCompletion == intent /\ actualRef = "missing" /\ ((~credentials /\ ~replay /\ ~transferResidue /\ ~diagnosticsResidue) \/ Mutation = "premature-completion") /\ (Mutation = "premature-completion" \/ ~conflict) /\ deviceRow' = FALSE /\ removed' = TRUE /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, crashCount, owner>>
Crash == running /\ crashCount = 0 /\ intent /\ actualRef = "missing" /\ running' = FALSE /\ ready' = FALSE /\ barrier' = FALSE /\ active' = 0 /\ detached' = 0 /\ crashCount' = 1 /\ UNCHANGED <<intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, owner>>
Restart == ~running /\ running' = TRUE /\ ready' = FALSE /\ barrier' = FALSE /\ UNCHANGED <<intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
RestoreBarrier == running /\ ~ready /\ intent /\ barrier' = TRUE /\ UNCHANGED <<running, ready, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
StartupReady == running /\ ~ready /\ (intent => barrier) /\ ready' = TRUE /\ UNCHANGED <<running, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount, owner>>
SwitchOwner == owner = OwnerA /\ actualRef # "missing" /\ owner' = OwnerB /\ UNCHANGED <<running, ready, barrier, intent, intentExpected, intentGeneration, actualRef, canonical, otherRef, active, detached, drained, conflict, prepared, discard, casObserved, credentials, replay, transferResidue, diagnosticsResidue, deviceRow, removed, crashCount>>

Next == AdmitWork \/ DetachWork \/ FinishCoveredWork \/ FinishUnmergedWork \/ FinishConflictingWork \/ PublishIntent \/ Drain \/ RetryIntent \/ PrepareOperation \/ OpenConflict \/ ConfirmDiscard \/ ForeignAdvance \/ RemoveRef \/ CleanupCredentials \/ CleanupResidue \/ PublishCompletion \/ Crash \/ Restart \/ RestoreBarrier \/ StartupReady \/ SwitchOwner
Spec == Init /\ [][Next]_vars
IntentBeforeRef == actualRef = "missing" => intent
DrainBeforeRef == actualRef = "missing" => active = 0 /\ detached = 0 /\ drained
ConflictAndPreparedGate == actualRef = "missing" => ~conflict /\ ~prepared
UnmergedRequiresDiscard == actualRef = "missing" => WorkMode = "covered" \/ discard
CASUsesExpectedOID == actualRef = "missing" => casObserved = intentExpected
CanonicalAndOtherDevicePreserved == canonical = CanonicalOID /\ otherRef = OtherOID
CompletionAfterCleanup == removed => actualRef = "missing" /\ ~credentials /\ ~replay /\ ~transferResidue /\ ~diagnosticsResidue /\ ~deviceRow
OwnerIsolation == actualRef = "missing" => owner = OwnerA
StartupBarrierBeforeReady == intent /\ running /\ ready => barrier

ReachDurableIntent == intent => FALSE
ReachCoveredRemoval == (removed /\ WorkMode = "covered") => FALSE
ReachDiscardRemoval == (removed /\ discard) => FALSE
ReachRestartAfterRefRemoval == (crashCount = 1 /\ running /\ actualRef = "missing" /\ ready) => FALSE
ReachConflictFromAdmittedWork == conflict => FALSE
ReachRebasedIntent == (intentGeneration = 2 /\ actualRef = "covered-work-result") => FALSE

=============================================================================
