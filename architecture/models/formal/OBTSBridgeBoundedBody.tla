---- MODULE OBTSBridgeBoundedBody ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
OBTS-FM-003, revision 6. Finite input sizes and independently sized/kinded
required rows are symbolic fixtures, NOT a parser expansion ratio or RSS
proof. Principal-independent projection includes private files. SQL compiler,
lexical/response equivalence and physical durability remain outside the model.
Ordered file acquisition and per-file row streams reduce interleavings, not
row obligations. Restart checks replay one interrupted target; healthy checks
also replay a second target. Superseded-row deletion is abstract cleanup.
***************************************************************************)

CONSTANTS F1, F2, F3, F4, NoFile, PrivateFile,
          Rev0, RevDrift, Oid0, OidDrift, Audit1, Audit2,
          BodySlots, BatchRows, PerFileLimit, LegacyAggregateLimit,
          InFlightBodyBytes, BatchByteBudget,
          DriftFile, DeniedFile, Scenario, FaultMode

Corpus == {F1, F2, F3, F4}
BodySizes == [f \in Corpus |->
  IF f = F1 THEN 1 ELSE IF f = F2 THEN 3 ELSE IF f = F3 THEN 2 ELSE 4]
TotalBodySize == BodySizes[F1] + BodySizes[F2] + BodySizes[F3] + BodySizes[F4]
RequiredRows == 1..13
RowFile == [r \in RequiredRows |->
  IF r <= 7 THEN F1 ELSE IF r <= 9 THEN F2 ELSE IF r <= 11 THEN F3 ELSE F4]
RowKind == <<"metadata", "tag", "tag", "link", "link", "block", "block",
             "metadata", "tag", "metadata", "link", "metadata", "block">>
RowSize == <<1, 1, 1, 1, 1, 4, 4, 9, 1, 1, 2, 8, 1>>
FileOrdinal == [f \in Corpus |-> IF f = F1 THEN 1 ELSE IF f = F2 THEN 2 ELSE IF f = F3 THEN 3 ELSE 4]
FileRows(f) == {r \in RequiredRows: RowFile[r] = f}
LegacyRows(f) == {r \in FileRows(f): RowKind[r] # "block"}
Oversized(r) == RowSize[r] > BatchByteBudget
RECURSIVE Bytes(_)
Bytes(rows) == IF rows = {} THEN 0 ELSE
  LET r == CHOOSE x \in rows: TRUE IN RowSize[r] + Bytes(rows \ {r})

ASSUME Cardinality(Corpus) > BodySlots /\ BodySlots > 0 /\ BatchRows > 0
ASSUME PerFileLimit > 0 /\ LegacyAggregateLimit > 0
ASSUME InFlightBodyBytes > 0 /\ BatchByteBudget > 0
ASSUME \A f \in Corpus: BodySizes[f] > 0 /\ BodySizes[f] <= PerFileLimit
ASSUME TotalBodySize > LegacyAggregateLimit
ASSUME DriftFile \in Corpus /\ DeniedFile \in Corpus \cup {NoFile}
ASSUME PrivateFile \in Corpus

VARIABLES phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted, lastAction
vars == <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted, lastAction>>

LeaseBytes ==
  (IF F1 \in bodyLeases THEN BodySizes[F1] ELSE 0)
  + (IF F2 \in bodyLeases THEN BodySizes[F2] ELSE 0)
  + (IF F3 \in bodyLeases THEN BodySizes[F3] ELSE 0)
  + (IF F4 \in bodyLeases THEN BodySizes[F4] ELSE 0)
PendingBytes == Bytes(pendingRows)
SeenRows == pendingRows \cup committedRows
EffectiveRows == IF FaultMode = "omitted-row" THEN RequiredRows \ {13} ELSE RequiredRows
BodyAttested(f) == f \notin drifted
NormalShape == Cardinality(pendingRows) <= BatchRows /\ PendingBytes <= BatchByteBudget
SingletonShape == singletonRow # 0 /\ pendingRows = {singletonRow}
  /\ Oversized(singletonRow) /\ singletonOwner = RowFile[singletonRow]
  /\ singletonOwner \in bodyLeases
RowReady(r) ==
  /\ r \in EffectiveRows \ SeenRows
  /\ RowFile[r] \in bodyLeases \cap bodyVerified
  /\ {q \in EffectiveRows: RowFile[q] = RowFile[r] /\ q < r} \subseteq SeenRows

Init ==
  /\ phase = "Idle"
  /\ projectionCursor = 1
  /\ priorCursor = 1
  /\ projectionTarget = 1
  /\ drifted = {}
  /\ bodyLeases = {}
  /\ bodyVerified = {}
  /\ pendingRows = {}
  /\ committedRows = {}
  /\ attestedRows = {}
  /\ retainedBodies = {}
  /\ failedBodies = {}
  /\ auditRecords = {Audit1, Audit2}
  /\ singletonRow = 0
  /\ singletonOwner = NoFile
  /\ cleanupDone = FALSE
  /\ restarted = FALSE
  /\ lastAction = "Init"

BeginProjection ==
  /\ phase = "Idle"
  /\ projectionCursor < 3
  /\ phase' = "Running"
  /\ priorCursor' = projectionCursor
  /\ projectionTarget' = projectionCursor + 1
  /\ lastAction' = "BeginProjection"
  /\ UNCHANGED <<projectionCursor, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

PrepareReplay ==
  /\ phase = "Ready"
  /\ projectionCursor = 2
  /\ FaultMode # "restart"
  /\ phase' = "Idle"
  /\ priorCursor' = projectionCursor
  /\ bodyVerified' = {}
  /\ committedRows' = {}
  /\ attestedRows' = {}
  /\ cleanupDone' = FALSE
  /\ lastAction' = "PrepareReplay"
  /\ UNCHANGED <<projectionCursor, projectionTarget, drifted, bodyLeases, pendingRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, restarted>>

AcquireBody(f) ==
  /\ phase = "Running"
  /\ f \in Corpus \ (bodyLeases \cup bodyVerified \cup failedBodies)
  /\ {g \in Corpus: FileOrdinal[g] < FileOrdinal[f]} \subseteq (bodyLeases \cup bodyVerified)
  /\ Cardinality(bodyLeases) < BodySlots
  /\ LeaseBytes + BodySizes[f] <= InFlightBodyBytes
  /\ bodyLeases' = bodyLeases \cup {f}
  /\ lastAction' = "AcquireBody"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

VerifyBody(f) ==
  /\ phase = "Running"
  /\ f \in bodyLeases \ bodyVerified
  /\ BodyAttested(f)
  /\ BodySizes[f] <= PerFileLimit
  /\ bodyVerified' = bodyVerified \cup {f}
  /\ lastAction' = "VerifyBody"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

EnqueueRow(r) ==
  /\ phase = "Running"
  /\ RowReady(r)
  /\ singletonRow = 0 /\ singletonOwner = NoFile
  /\ ~Oversized(r)
  /\ Cardinality(pendingRows) + 1 <= BatchRows
  /\ PendingBytes + RowSize[r] <= BatchByteBudget
  /\ pendingRows' = pendingRows \cup {r}
  /\ attestedRows' = attestedRows \cup {r}
  /\ lastAction' = "EnqueueRow"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, committedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

EnqueueSingleton(r) ==
  /\ phase = "Running"
  /\ FaultMode # "oversized-starvation"
  /\ RowReady(r) /\ Oversized(r)
  /\ pendingRows = {} /\ singletonRow = 0 /\ singletonOwner = NoFile
  /\ pendingRows' = {r}
  /\ attestedRows' = attestedRows \cup {r}
  /\ singletonRow' = r
  /\ singletonOwner' = RowFile[r]
  /\ lastAction' = "EnqueueSingleton"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, committedRows, retainedBodies, failedBodies, auditRecords, cleanupDone, restarted>>

CommitBatch ==
  /\ phase = "Running"
  /\ pendingRows # {}
  /\ NormalShape \/ SingletonShape
  /\ FaultMode # "db-failure"
  /\ committedRows' = committedRows \cup pendingRows
  /\ pendingRows' = {}
  /\ lastAction' = "CommitBatch"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

FinishSingleton ==
  /\ phase = "Running"
  /\ singletonRow # 0 /\ pendingRows = {}
  /\ singletonRow \in committedRows
  /\ singletonRow' = 0
  /\ singletonOwner' = NoFile
  /\ lastAction' = "FinishSingleton"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, cleanupDone, restarted>>

ReleaseBody(f) ==
  /\ phase \in {"Running", "Failed"}
  /\ f \in bodyLeases
  /\ singletonOwner # f
  /\ phase = "Failed" \/ (f \in bodyVerified /\ (FileRows(f) \cap EffectiveRows) \subseteq SeenRows)
  /\ bodyLeases' = bodyLeases \ {f}
  /\ lastAction' = "ReleaseBody"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

CleanupProjection ==
  /\ phase = "Running"
  /\ committedRows = EffectiveRows
  /\ pendingRows = {} /\ singletonRow = 0 /\ singletonOwner = NoFile
  /\ bodyLeases = {} /\ bodyVerified = Corpus
  /\ ~cleanupDone
  /\ cleanupDone' = TRUE
  /\ lastAction' = "CleanupProjection"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, restarted>>

AdvanceCursor ==
  /\ phase = "Running"
  /\ committedRows = EffectiveRows /\ bodyVerified = Corpus
  /\ pendingRows = {} /\ bodyLeases = {}
  /\ singletonRow = 0 /\ singletonOwner = NoFile /\ cleanupDone
  /\ projectionCursor' = projectionTarget
  /\ phase' = "Ready"
  /\ lastAction' = "AdvanceCursor"
  /\ UNCHANGED <<priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

DriftRevision ==
  /\ FaultMode = "revision-drift"
  /\ phase = "Running"
  /\ DriftFile \notin bodyVerified
  /\ DriftFile \notin drifted
  /\ drifted' = drifted \cup {DriftFile}
  /\ lastAction' = "DriftRevision"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

FailBodyVerification(f) ==
  /\ FaultMode = "revision-drift"
  /\ phase = "Running"
  /\ f \in bodyLeases /\ ~BodyAttested(f)
  /\ phase' = "Failed"
  /\ failedBodies' = failedBodies \cup {f}
  /\ lastAction' = "FailBodyVerification"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

FailBodyAcquisition(f) ==
  /\ FaultMode = "source-failure"
  /\ phase = "Running"
  /\ f \in bodyLeases
  /\ phase' = "Failed"
  /\ failedBodies' = failedBodies \cup {f}
  /\ lastAction' = "FailBodyAcquisition"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

CallerDenied ==
  /\ FaultMode = "caller-denied"
  /\ DeniedFile \in Corpus
  /\ phase = "Running"
  /\ lastAction' = "CallerDenied"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

FailBatchCommit ==
  /\ FaultMode = "db-failure"
  /\ phase = "Running"
  /\ pendingRows # {}
  /\ phase' = "Failed"
  /\ lastAction' = "FailBatchCommit"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

CancelProjection ==
  /\ FaultMode \in {"cancel", "restart"}
  /\ ~restarted /\ phase = "Running"
  /\ committedRows # {} /\ committedRows # RequiredRows
  /\ phase' = "Failed"
  /\ lastAction' = "CancelProjection"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

DrainPending ==
  /\ phase = "Failed"
  /\ pendingRows # {} \/ singletonRow # 0
  /\ pendingRows' = {}
  /\ singletonRow' = 0
  /\ singletonOwner' = NoFile
  /\ lastAction' = "DrainPending"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, cleanupDone, restarted>>

FinishDrain ==
  /\ phase = "Failed"
  /\ pendingRows = {} /\ bodyLeases = {}
  /\ singletonRow = 0 /\ singletonOwner = NoFile
  /\ phase' = "FailedReleased"
  /\ lastAction' = "FinishDrain"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

RestartProjection ==
  /\ FaultMode = "restart"
  /\ phase = "FailedReleased" /\ ~restarted
  /\ phase' = "Running"
  /\ bodyVerified' = {}
  /\ restarted' = TRUE
  /\ cleanupDone' = FALSE
  /\ lastAction' = "RestartProjection"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner>>

RejectByCorpusTotal ==
  /\ FaultMode = "total-admission"
  /\ phase = "Running"
  /\ phase' = "FailedReleased"
  /\ lastAction' = "RejectByCorpusTotal"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

RetainAllCorpusBodies ==
  /\ FaultMode = "all-corpus-retention"
  /\ phase = "Running"
  /\ retainedBodies' = Corpus
  /\ lastAction' = "RetainAllCorpusBodies"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

CommitUnverifiedRows ==
  /\ FaultMode = "unverified-rows"
  /\ phase = "Running"
  /\ pendingRows # {} /\ attestedRows # RequiredRows
  /\ committedRows' = RequiredRows
  /\ pendingRows' = {}
  /\ lastAction' = "CommitUnverifiedRows"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

SkipReleaseOnFailure ==
  /\ FaultMode = "skip-release"
  /\ phase = "Running" /\ bodyLeases # {}
  /\ phase' = "FailedReleased"
  /\ lastAction' = "SkipReleaseOnFailure"
  /\ UNCHANGED <<projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

AdvanceCursorEarly ==
  /\ FaultMode = "cursor-early"
  /\ phase = "Running"
  /\ phase' = "Ready"
  /\ projectionCursor' = projectionTarget
  /\ lastAction' = "AdvanceCursorEarly"
  /\ UNCHANGED <<priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

DropAuditRecords ==
  /\ FaultMode = "drop-audit"
  /\ phase = "Running"
  /\ auditRecords' = {}
  /\ lastAction' = "DropAuditRecords"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, singletonRow, singletonOwner, cleanupDone, restarted>>

EnqueueLegacyFanout(f) ==
  /\ FaultMode = "row-overflow"
  /\ phase = "Running"
  /\ f \in bodyLeases \cap bodyVerified
  /\ LegacyRows(f) \cap SeenRows = {}
  /\ \A r \in LegacyRows(f): ~Oversized(r)
  /\ pendingRows' = pendingRows \cup LegacyRows(f)
  /\ attestedRows' = attestedRows \cup LegacyRows(f)
  /\ lastAction' = "EnqueueLegacyFanout"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, committedRows, retainedBodies, failedBodies, auditRecords, singletonRow, singletonOwner, cleanupDone, restarted>>

MixOversizedRow(r) ==
  /\ FaultMode = "mixed-oversized"
  /\ phase = "Running" /\ RowReady(r) /\ Oversized(r)
  /\ pendingRows # {} /\ singletonRow = 0
  /\ pendingRows' = pendingRows \cup {r}
  /\ attestedRows' = attestedRows \cup {r}
  /\ singletonRow' = r
  /\ singletonOwner' = RowFile[r]
  /\ lastAction' = "MixOversizedRow"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, committedRows, retainedBodies, failedBodies, auditRecords, cleanupDone, restarted>>

ReleasePermitEarly ==
  /\ FaultMode = "early-permit-release"
  /\ phase = "Running" /\ singletonRow # 0
  /\ pendingRows = {}
  /\ singletonOwner' = NoFile
  /\ lastAction' = "ReleasePermitEarly"
  /\ UNCHANGED <<phase, projectionCursor, priorCursor, projectionTarget, drifted, bodyLeases, bodyVerified, pendingRows, committedRows, attestedRows, retainedBodies, failedBodies, auditRecords, singletonRow, cleanupDone, restarted>>

CoreNext ==
  BeginProjection \/ PrepareReplay
  \/ (\E f \in Corpus: AcquireBody(f) \/ VerifyBody(f) \/ ReleaseBody(f))
  \/ (\E r \in RequiredRows: EnqueueRow(r) \/ EnqueueSingleton(r))
  \/ CommitBatch \/ FinishSingleton \/ CleanupProjection \/ AdvanceCursor
  \/ DriftRevision
  \/ (\E f \in Corpus: FailBodyVerification(f) \/ FailBodyAcquisition(f))
  \/ CallerDenied \/ FailBatchCommit \/ CancelProjection
  \/ DrainPending \/ FinishDrain \/ RestartProjection
FaultNext == RejectByCorpusTotal \/ RetainAllCorpusBodies \/ CommitUnverifiedRows
  \/ SkipReleaseOnFailure \/ AdvanceCursorEarly \/ DropAuditRecords
  \/ (\E f \in Corpus: EnqueueLegacyFanout(f))
  \/ (\E r \in RequiredRows: MixOversizedRow(r)) \/ ReleasePermitEarly
Next == CoreNext \/ FaultNext \/ UNCHANGED vars

NoCorpusRetention == retainedBodies = {}
BodyLeaseBounded == Cardinality(bodyLeases) <= BodySlots
BodyLeaseBytesBounded == LeaseBytes <= InFlightBodyBytes
BatchBounded == Cardinality(pendingRows) <= BatchRows
BatchBytesBounded == NormalShape \/ SingletonShape
SingletonOwned == singletonRow # 0 =>
  singletonOwner = RowFile[singletonRow] /\ singletonOwner \in bodyLeases
SingletonPermitClean == singletonRow = 0 => singletonOwner = NoFile
NoCorpusAdmissionGuard == phase # "FailedReleased" \/ FaultMode # "total-admission"
AllCommittedRowsVerified == committedRows \subseteq attestedRows
CursorAfterVerifiedRows == projectionCursor > priorCursor =>
  phase = "Ready" /\ committedRows = RequiredRows /\ bodyVerified = Corpus
  /\ pendingRows = {} /\ bodyLeases = {} /\ singletonRow = 0
  /\ singletonOwner = NoFile /\ cleanupDone
NoLeakedBodyLeases == phase \in {"Ready", "FailedReleased"} =>
  bodyLeases = {} /\ pendingRows = {} /\ singletonRow = 0 /\ singletonOwner = NoFile
FailureRetainsCursor == phase \in {"Failed", "FailedReleased"} => projectionCursor = priorCursor
AuditRecordsPreserved == auditRecords = {Audit1, Audit2}
CallerDenialDoesNotDirtyProjection == lastAction = "CallerDenied" =>
  phase = "Running" /\ projectionCursor = priorCursor /\ auditRecords = {Audit1, Audit2}
FiniteCorpusExceedsSlots == Cardinality(Corpus) > BodySlots
CorpusIncludesPrivate == PrivateFile \in Corpus
LargeSupportedCorpus == TotalBodySize > LegacyAggregateLimit
AllSafety ==
  /\ NoCorpusRetention /\ BodyLeaseBounded /\ BodyLeaseBytesBounded
  /\ BatchBounded /\ BatchBytesBounded /\ SingletonOwned /\ SingletonPermitClean
  /\ NoCorpusAdmissionGuard /\ AllCommittedRowsVerified /\ CursorAfterVerifiedRows
  /\ NoLeakedBodyLeases /\ FailureRetainsCursor /\ AuditRecordsPreserved
  /\ CallerDenialDoesNotDirtyProjection /\ FiniteCorpusExceedsSlots
  /\ CorpusIncludesPrivate /\ LargeSupportedCorpus

NeverTwoBodyLeases == Cardinality(bodyLeases) < BodySlots
NeverAcquireBody == lastAction # "AcquireBody"
NeverReleaseBody == lastAction # "ReleaseBody"
NeverFailureRelease == ~(lastAction = "ReleaseBody" /\ phase = "Failed")
NeverFailBodyAcquisition == lastAction # "FailBodyAcquisition"
NeverFailBodyVerification == lastAction # "FailBodyVerification"
NeverFailBatchCommit == lastAction # "FailBatchCommit"
NeverCallerDenied == lastAction # "CallerDenied"
NeverDriftRevision == lastAction # "DriftRevision"
NeverNormalBytePressure == ~ (phase = "Running" /\ singletonRow = 0
  /\ Cardinality(pendingRows) < BatchRows
  /\ \E r \in RequiredRows: RowReady(r) /\ ~Oversized(r)
       /\ PendingBytes + RowSize[r] > BatchByteBudget)
NeverSingleton == lastAction # "EnqueueSingleton"
NeverFinishSingleton == lastAction # "FinishSingleton"
NeverRestart == lastAction # "RestartProjection"
NeverReplayReady == ~(restarted /\ phase = "Ready")
NeverCancelSingleton == ~(phase = "Failed" /\ singletonRow # 0)
NeverMultirowFile == ~FileRows(F1) \subseteq committedRows
NeverFinalCursor == projectionCursor # 3

ProjectionSettles == (phase = "Running") ~> (phase = "Ready" \/ phase = "FailedReleased")
ProjectionCompletes == <> (phase = "Ready")
FailureLeaseDrains == (phase = "Failed") ~> (phase = "FailedReleased")
SafetySpec == Init /\ [][Next]_vars
LiveSpec == SafetySpec
  /\ WF_vars(BeginProjection) /\ WF_vars(PrepareReplay)
  /\ (\A f \in Corpus: WF_vars(AcquireBody(f)) /\ WF_vars(VerifyBody(f)) /\ WF_vars(ReleaseBody(f)))
  /\ (\A r \in RequiredRows: WF_vars(EnqueueRow(r)) /\ WF_vars(EnqueueSingleton(r)))
  /\ WF_vars(CommitBatch) /\ WF_vars(FinishSingleton) /\ WF_vars(CleanupProjection)
  /\ WF_vars(AdvanceCursor) /\ WF_vars(DrainPending) /\ WF_vars(FinishDrain)
  /\ WF_vars(RestartProjection)
FailureLiveSpec == LiveSpec
  /\ (\A f \in Corpus: WF_vars(FailBodyAcquisition(f)))

=============================================================================
