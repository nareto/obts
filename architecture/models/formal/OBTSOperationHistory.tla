---- MODULE OBTSOperationHistory ----
EXTENDS Naturals, FiniteSets

CONSTANTS Ops, DropBeforeDurable, NewestWins, LoseRename, CollapseAbsentNull,
  AllowStaleWriter, SkipRestoreBlock, SkipSourceBlock, UnsafeReads, UnsafeArchiveAdmission
ASSUME Ops = {"old", "new"}

VARIABLES hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
  ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
  blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath
vars == <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
  ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
  blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

None == <<"NO_ROW", "NO_ROW", "NO_ROW", "NO_ROW", "NO_ROW", "NO_ROW", 0>>
Absent == "BASE_ABSENT"
NullBase == "BASE_NULL"
Canonical == [op \in Ops |->
  IF op = "old"
  THEN <<"attempt-7", "hash-old", Absent, "rename-pair-3", "directory-result-2", "aborted", 1>>
  ELSE <<"attempt-7", "hash-new", NullBase, "rename-pair-3", "directory-result-2", "committed", 2>>
]

HotIds(m) == {op \in Ops : m[op] # None}
ColdIds(m) == {op \in Ops : m[op] # None}
Earliest(S) == IF "old" \in S THEN "old" ELSE "new"
ArchiveEligible(m) == {op \in HotIds(m) : op \notin pendingMerge}
Pick(m, S) == [op \in Ops |-> IF op \in S THEN m[op] ELSE None]
Remove(m, S) == [op \in Ops |-> IF op \in S THEN None ELSE m[op]]

Init ==
  /\ hotRows = Canonical /\ coldRows = [op \in Ops |-> None]
  /\ pending = {} /\ pendingRows = [op \in Ops |-> None] /\ pendingMerge = {"new"}
  /\ generation = 0 /\ ledgerGeneration = 0
  /\ ledgerId = "NO_LEDGER" /\ trustedId = "ledger" /\ ledgerPresent = FALSE /\ initialized = FALSE /\ initPending = FALSE
  /\ verified = FALSE /\ sourceValid = TRUE /\ phase = "migration"
  /\ blocked = FALSE /\ deleting = FALSE /\ erased = FALSE
  /\ attemptLookup = "old" /\ targetLookup = "new" /\ served = FALSE /\ recoveryPath = "none"

InitializeMetadata ==
  /\ ~blocked /\ ~initialized /\ phase \in {"migration", "recover"}
  /\ HotIds(hotRows) = Ops /\ generation = 0 /\ ~ledgerPresent
  /\ initialized' = TRUE /\ initPending' = TRUE /\ phase' = "ledger-create-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, verified, sourceValid, blocked, deleting,
      erased, attemptLookup, targetLookup, served, recoveryPath>>

CreateInitialLedger ==
  /\ ~blocked /\ phase = "ledger-create-pending" /\ initPending
  /\ HotIds(hotRows) = Ops /\ generation = 0 /\ pending = {}
  /\ ledgerPresent' = TRUE /\ ledgerId' = trustedId /\ ledgerGeneration' = 0
  /\ initPending' = FALSE /\ verified' = TRUE /\ phase' = "idle"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, trustedId,
      initialized, sourceValid, blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

RecoverInitialLedger ==
  /\ ~blocked /\ phase = "recover" /\ initPending /\ ~ledgerPresent
  /\ HotIds(hotRows) = Ops /\ generation = 0 /\ pending = {}
  /\ ledgerPresent' = TRUE /\ ledgerId' = trustedId /\ ledgerGeneration' = 0
  /\ initPending' = FALSE /\ verified' = TRUE /\ phase' = "idle"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, trustedId,
      initialized, sourceValid, blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

SelectBatch ==
  /\ ~blocked /\ verified /\ initialized /\ phase = "idle" /\ ~deleting /\ pending = {}
  /\ ArchiveEligible(hotRows) # {}
  /\ pending' = {Earliest(ArchiveEligible(hotRows))}
  /\ pendingRows' = Pick(hotRows, {Earliest(ArchiveEligible(hotRows))})
  /\ phase' = "described"
  /\ UNCHANGED <<hotRows, coldRows, pendingMerge, generation, ledgerGeneration, ledgerId,
      trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, blocked,
      deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

CommitArchive ==
  /\ ~blocked /\ verified /\ ~deleting /\ phase = "described" /\ ledgerPresent
  /\ ledgerId = trustedId /\ ledgerGeneration = generation
  /\ sourceValid /\ pendingRows = Pick(hotRows, pending)
  /\ coldRows' = [op \in Ops |-> IF op \in pending THEN pendingRows[op] ELSE coldRows[op]]
  /\ ledgerGeneration' = generation + 1 /\ phase' = "archived"
  /\ UNCHANGED <<hotRows, pending, pendingRows, pendingMerge, generation, ledgerId, trustedId,
      ledgerPresent, initialized, initPending, verified, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

PublishRemoval ==
  /\ ~blocked /\ verified /\ ~deleting /\ phase = "archived" /\ sourceValid
  /\ pendingRows = Pick(hotRows, pending) /\ ledgerGeneration = generation + 1
  /\ hotRows' = Remove(hotRows, pending) /\ generation' = generation + 1
  /\ pending' = {} /\ pendingRows' = [op \in Ops |-> None] /\ phase' = "idle"
  /\ UNCHANGED <<coldRows, pendingMerge, ledgerGeneration, ledgerId, trustedId, ledgerPresent,
      initialized, initPending, verified, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

Crash ==
  /\ ~blocked /\ ~deleting /\ phase # "recover" /\ phase # "restore-pending" /\ phase # "source-pending" /\ phase # "missing-pending" /\ phase # "generation-pending"
  /\ verified' = FALSE /\ phase' = "recover" /\ served' = FALSE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting,
      erased, attemptLookup, targetLookup, recoveryPath>>

CrashDeletion ==
  /\ deleting /\ phase = "deleting"
  /\ phase' = "deletion-recover" /\ verified' = FALSE /\ served' = FALSE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked,
      deleting, erased, attemptLookup, targetLookup, recoveryPath>>

RecoverParent ==
  /\ ~blocked /\ ~deleting /\ phase = "recover" /\ initialized /\ ledgerPresent
  /\ pending # {} /\ pendingRows = Pick(hotRows, pending)
  /\ ledgerId = trustedId /\ ledgerGeneration = generation
  /\ sourceValid
  /\ coldRows' = [op \in Ops |-> IF op \in pending THEN pendingRows[op] ELSE coldRows[op]]
  /\ ledgerGeneration' = generation + 1 /\ phase' = "recovered-archive"
  /\ verified' = FALSE /\ recoveryPath' = "parent"
  /\ UNCHANGED <<hotRows, pending, pendingRows, pendingMerge, generation, ledgerId, trustedId,
      ledgerPresent, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served>>

RecoverFinish ==
  /\ ~blocked /\ ~deleting /\ phase = "recovered-archive" /\ pending # {}
  /\ pendingRows = Pick(hotRows, pending) /\ ledgerId = trustedId
  /\ ledgerGeneration = generation + 1
  /\ hotRows' = Remove(hotRows, pending) /\ generation' = generation + 1
  /\ pending' = {} /\ pendingRows' = [op \in Ops |-> None]
  /\ phase' = "idle" /\ verified' = TRUE
  /\ UNCHANGED <<coldRows, pendingMerge, ledgerGeneration, ledgerId, trustedId, ledgerPresent,
      initialized, initPending, sourceValid, blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

RecoverTarget ==
  /\ ~blocked /\ ~deleting /\ phase = "recover" /\ initialized /\ ledgerPresent
  /\ pending # {} /\ pendingRows = Pick(hotRows, pending)
  /\ ledgerId = trustedId /\ ledgerGeneration = generation + 1
  /\ sourceValid /\ coldRows = [op \in Ops |-> IF op \in pending THEN pendingRows[op] ELSE coldRows[op]]
  /\ hotRows' = Remove(hotRows, pending) /\ generation' = generation + 1
  /\ pending' = {} /\ pendingRows' = [op \in Ops |-> None]
  /\ phase' = "idle" /\ verified' = TRUE /\ recoveryPath' = "target"
  /\ UNCHANGED <<coldRows, pendingMerge, ledgerGeneration, ledgerId, trustedId, ledgerPresent,
      initialized, initPending, sourceValid, blocked, deleting, erased, attemptLookup, targetLookup, served>>

VerifyAligned ==
  /\ ~blocked /\ ~deleting /\ phase = "recover" /\ pending = {}
  /\ initialized /\ ledgerPresent /\ ledgerId = trustedId /\ ledgerGeneration = generation
  /\ verified' = TRUE /\ phase' = "idle"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting,
      erased, attemptLookup, targetLookup, served, recoveryPath>>

CorruptRestore ==
  /\ ~blocked /\ ~deleting /\ phase = "idle" /\ verified /\ pending = {}
  /\ ledgerId' = "foreign-ledger" /\ verified' = FALSE /\ phase' = "restore-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

RestoreMismatch ==
  /\ ~blocked /\ phase = "restore-pending" /\ ledgerId # trustedId
  /\ IF SkipRestoreBlock THEN blocked' = FALSE /\ phase' = "recover"
     ELSE blocked' = TRUE /\ phase' = "blocked-foreign"
  /\ verified' = FALSE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

TamperSource ==
  /\ ~blocked /\ verified /\ phase = "described" /\ pending # {}
  /\ sourceValid' = FALSE /\ verified' = FALSE /\ phase' = "source-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

RestoreSourceMismatch ==
  /\ ~blocked /\ phase = "source-pending" /\ ~sourceValid
  /\ IF SkipSourceBlock THEN blocked' = FALSE /\ phase' = "recover"
     ELSE blocked' = TRUE /\ phase' = "blocked-source"
  /\ verified' = FALSE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

RestoreMissingLedger ==
  /\ ~blocked /\ ~deleting /\ phase = "idle" /\ verified /\ initialized
  /\ ledgerPresent' = FALSE /\ verified' = FALSE /\ phase' = "missing-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

CheckMissingLedger ==
  /\ ~blocked /\ phase = "missing-pending" /\ ~ledgerPresent
  /\ blocked' = TRUE /\ verified' = FALSE /\ phase' = "blocked-missing"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid,
      deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

RestoreAhead ==
  /\ ~blocked /\ ~deleting /\ phase = "idle" /\ verified /\ initialized /\ ledgerPresent
  /\ ledgerGeneration' = generation + 1
  /\ verified' = FALSE /\ phase' = "generation-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerId,
      trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

RestoreBehind ==
  /\ ~blocked /\ ~deleting /\ phase = "idle" /\ verified /\ initialized /\ ledgerPresent
  /\ generation > 0
  /\ ledgerGeneration' = generation - 1 /\ verified' = FALSE /\ phase' = "generation-pending"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerId,
      trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

CheckWrongGeneration ==
  /\ ~blocked /\ phase = "generation-pending" /\ ledgerGeneration # generation
  /\ blocked' = TRUE /\ verified' = FALSE /\ phase' = "blocked-generation"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

Lookup ==
  /\ ~blocked /\ verified /\ initialized /\ phase = "idle" /\ ~deleting
  /\ attemptLookup' = Earliest(HotIds(hotRows) \cup ColdIds(coldRows))
  /\ targetLookup' = IF {op \in Ops : Canonical[op][3] # Absent} # {}
       THEN Earliest({op \in Ops : Canonical[op][3] # Absent})
       ELSE Earliest(HotIds(hotRows) \cup ColdIds(coldRows))
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
      blocked, deleting, erased, served, recoveryPath>>

UnsafeLookup ==
  /\ UnsafeReads /\ ~blocked /\ ~verified /\ phase \in {"restore-pending", "source-pending", "missing-pending", "generation-pending"}
  /\ served' = TRUE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
      blocked, deleting, erased, attemptLookup, targetLookup, recoveryPath>>

SelectNewestAttempt ==
  /\ NewestWins /\ verified /\ phase = "idle" /\ ~blocked
  /\ attemptLookup' = "new"
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
      blocked, deleting, erased, targetLookup, served, recoveryPath>>

UnsafeSelect ==
  /\ UnsafeArchiveAdmission /\ ~blocked /\ ~verified /\ phase \in {"restore-pending", "source-pending", "missing-pending", "generation-pending"}
  /\ HotIds(hotRows) # {}
  /\ pending' = {Earliest(HotIds(hotRows))} /\ pendingRows' = Pick(hotRows, {Earliest(HotIds(hotRows))})
  /\ phase' = "described"
  /\ UNCHANGED <<hotRows, coldRows, pendingMerge, generation, ledgerGeneration, ledgerId, trustedId,
      ledgerPresent, initialized, initPending, verified, sourceValid, blocked, deleting,
      erased, attemptLookup, targetLookup, served, recoveryPath>>

BrokenDrop ==
  /\ DropBeforeDurable /\ verified /\ phase = "described" /\ pending # {}
  /\ hotRows' = Remove(hotRows, pending) /\ pending' = {} /\ phase' = "idle"
  /\ verified' = TRUE
  /\ UNCHANGED <<coldRows, pendingRows, pendingMerge, generation, ledgerGeneration, ledgerId,
      trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

BrokenLoseRename ==
  /\ LoseRename /\ verified /\ phase = "described" /\ pending = {"old"}
  /\ coldRows' = [coldRows EXCEPT !["old"] = <<"attempt-7", "hash-old", Absent, "NO_RENAME", "directory-result-2", "aborted", 1>>]
  /\ ledgerGeneration' = generation + 1 /\ phase' = "archived"
  /\ UNCHANGED <<hotRows, pending, pendingRows, pendingMerge, generation, ledgerId, trustedId,
      ledgerPresent, initialized, initPending, verified, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

BrokenCollapseBase ==
  /\ CollapseAbsentNull /\ verified /\ phase = "described" /\ pending = {"old"}
  /\ coldRows' = [coldRows EXCEPT !["old"] = <<"attempt-7", "hash-old", NullBase, "rename-pair-3", "directory-result-2", "aborted", 1>>]
  /\ ledgerGeneration' = generation + 1 /\ phase' = "archived"
  /\ UNCHANGED <<hotRows, pending, pendingRows, pendingMerge, generation, ledgerId, trustedId,
      ledgerPresent, initialized, initPending, verified, sourceValid, blocked, deleting, erased,
      attemptLookup, targetLookup, served, recoveryPath>>

CompletePendingMerge ==
  /\ ~blocked /\ verified /\ ~deleting /\ phase = "idle" /\ pending = {}
  /\ pendingMerge = {"new"} /\ "new" \in HotIds(hotRows)
  /\ pendingMerge' = {}
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid,
      phase, blocked, deleting, erased, attemptLookup, targetLookup, served, recoveryPath>>

BeginDelete ==
  /\ ~blocked /\ verified /\ ~deleting /\ phase = "idle" /\ pending = {}
  /\ deleting' = TRUE /\ phase' = "deleting" /\ verified' = FALSE /\ served' = FALSE
  /\ UNCHANGED <<hotRows, coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, sourceValid, blocked, erased,
      attemptLookup, targetLookup, recoveryPath>>

Erase ==
  /\ deleting /\ ~erased /\ phase \in {"deleting", "deletion-recover"}
  /\ hotRows' = [op \in Ops |-> None] /\ coldRows' = [op \in Ops |-> None]
  /\ pending' = {} /\ pendingRows' = [op \in Ops |-> None] /\ erased' = TRUE /\ phase' = "erased"
  /\ UNCHANGED <<pendingMerge, generation, ledgerGeneration, ledgerId, trustedId, ledgerPresent,
      initialized, initPending, verified, sourceValid, blocked, deleting, attemptLookup, targetLookup, served, recoveryPath>>

StaleWriter ==
  /\ AllowStaleWriter /\ deleting /\ erased /\ ~blocked
  /\ hotRows' = [hotRows EXCEPT !["old"] = Canonical["old"]] /\ erased' = erased
  /\ UNCHANGED <<coldRows, pending, pendingRows, pendingMerge, generation, ledgerGeneration,
      ledgerId, trustedId, ledgerPresent, initialized, initPending, verified, sourceValid, phase,
      blocked, deleting, attemptLookup, targetLookup, served, recoveryPath>>

BlockedStutter == blocked /\ UNCHANGED vars
ErasedStutter == erased /\ ~AllowStaleWriter /\ UNCHANGED vars
Next == InitializeMetadata \/ CreateInitialLedger \/ RecoverInitialLedger \/ SelectBatch \/ CommitArchive \/ PublishRemoval \/ Crash \/ CrashDeletion \/ RecoverParent \/ RecoverFinish \/ RecoverTarget \/ VerifyAligned \/ CorruptRestore \/ RestoreMismatch \/ TamperSource \/ RestoreSourceMismatch \/ RestoreMissingLedger \/ CheckMissingLedger \/ RestoreAhead \/ RestoreBehind \/ CheckWrongGeneration \/ Lookup \/ UnsafeLookup \/ UnsafeSelect \/ SelectNewestAttempt \/ BrokenDrop \/ BrokenLoseRename \/ BrokenCollapseBase \/ CompletePendingMerge \/ BeginDelete \/ Erase \/ StaleWriter \/ BlockedStutter \/ ErasedStutter
Spec == Init /\ [][Next]_vars

LogicalEvidencePreserved == erased \/ \A op \in Ops :
  (hotRows[op] = Canonical[op] \/ coldRows[op] = Canonical[op]) /\
  (hotRows[op] = None \/ coldRows[op] = None \/ hotRows[op] = coldRows[op])
NoEvidenceLoss == LogicalEvidencePreserved
PendingMergeHot == erased \/ pendingMerge \subseteq HotIds(hotRows)
GenerationConsistent ==
  IF ~initialized THEN ~ledgerPresent /\ generation = 0 /\ HotIds(hotRows) = Ops
  ELSE IF initPending
    THEN ~ledgerPresent /\ generation = 0 /\ HotIds(hotRows) = Ops
    ELSE IF pending # {}
      THEN ledgerPresent /\ ledgerId = trustedId /\ ledgerGeneration \in {generation, generation + 1}
      ELSE (ledgerPresent /\ ledgerId = trustedId /\ ledgerGeneration = generation)
        \/ phase \in {"restore-pending", "missing-pending", "generation-pending"} \/ blocked
RestoreFailsClosed == ledgerId = trustedId \/ blocked \/ ~initialized \/ initPending \/ phase = "restore-pending"
LedgerPresenceFailsClosed == ~initialized \/ initPending \/ ledgerPresent \/ blocked \/ phase = "missing-pending"
GenerationRestoreFailsClosed == ledgerGeneration = generation \/ blocked \/ phase = "generation-pending" \/ pending # {}
NoArchiveAdmissionUnverified == phase # "described" \/ verified \/ phase \in {"recover", "recovered-archive"}
SourceMismatchFailsClosed == sourceValid \/ blocked \/ phase = "source-pending"
LedgerIdentityTrusted == ledgerId = trustedId \/ blocked \/ ~verified
LookupPreservesEarliest == attemptLookup = "old" /\ targetLookup = "new"
NoServeUnverified == ~served
NoResurrection == ~erased \/ (HotIds(hotRows) = {} /\ ColdIds(coldRows) = {} /\ pending = {})
NoWriteWhenUnverified == ~verified => ~served
NoInitializationWitness == ~(initialized /\ phase = "ledger-create-pending")
NoRecoveryWitness == recoveryPath # "parent"
NoTargetRecoveryWitness == recoveryPath # "target"
NoRestoreBlockWitness == ~(blocked /\ phase = "blocked-foreign")
NoMissingBlockWitness == ~(blocked /\ phase = "blocked-missing")
NoGenerationBlockWitness == ~(blocked /\ phase = "blocked-generation")
NoBehindWitness == ~(phase = "generation-pending" /\ ledgerGeneration < generation)
NoAheadWitness == ~(phase = "generation-pending" /\ ledgerGeneration > generation)
NoDeletionWitness == ~erased
Integrity == NoEvidenceLoss /\ PendingMergeHot /\ GenerationConsistent /\ RestoreFailsClosed /\ LedgerPresenceFailsClosed /\ GenerationRestoreFailsClosed /\ SourceMismatchFailsClosed /\ LedgerIdentityTrusted /\ LookupPreservesEarliest /\ NoServeUnverified /\ NoResurrection /\ NoWriteWhenUnverified /\ NoArchiveAdmissionUnverified
====
