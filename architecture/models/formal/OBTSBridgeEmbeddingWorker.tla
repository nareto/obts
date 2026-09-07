-------------------- MODULE OBTSBridgeEmbeddingWorker --------------------
EXTENDS Naturals, TLC
CONSTANTS WorkKind, Drift, Fault, Mutation
VARIABLE s
vars == <<s>>

Init == s = [w |-> "Idle", api |-> "Idle", headless |-> "none",
  body |-> "none", input |-> FALSE, payload |-> 0, chunk |-> 0,
  fsRev |-> 1, sqlRev |-> 1, blockEpoch |-> 1, blockHash |-> 1,
  schema |-> 1, qSchema |-> 0, vectorSchema |-> 0, retrySchema |-> 0,
  schemaReady |-> FALSE, resetPendingSQL |-> FALSE,
  qRev |-> 0, qEpoch |-> 0, qHash |-> 0, attested |-> FALSE,
  vectorRev |-> 0, vectorEpoch |-> 0, vectorHash |-> 0,
  retryRev |-> 0, retryEpoch |-> 0, retryHash |-> 0, retries |-> 0,
  ready |-> FALSE, failureUsed |-> FALSE, cancelUsed |-> FALSE,
  cancelled |-> FALSE, failed |-> FALSE, matched |-> 0,
  staleWrite |-> FALSE, staleSuccess |-> FALSE, staleFailure |-> FALSE,
  oldSourceResult |-> FALSE, lateIgnored |-> FALSE, newReady |-> FALSE,
  attestationRejected |-> FALSE, last |-> "Init"]

ContentCurrent == s.qRev = s.sqlRev /\
  (WorkKind = "note" \/ (s.qEpoch = s.blockEpoch /\ s.qHash = s.blockHash))
Current == ContentCurrent /\ s.qSchema = s.schema
MayWrite == ~s.cancelled /\ (Current \/
  (Mutation = "id-only-success" /\ ~s.failed) \/
  (Mutation = "id-only-failure" /\ s.failed) \/
  (Mutation = "ignore-hash" /\ s.qSchema = s.schema /\ s.qRev = s.sqlRev /\ s.qEpoch = s.blockEpoch) \/
  (Mutation = "ignore-epoch" /\ s.qSchema = s.schema /\ s.qRev = s.sqlRev /\ s.qHash = s.blockHash) \/
  (Mutation = "ignore-schema-success" /\ ContentCurrent /\ ~s.failed) \/
  (Mutation = "ignore-schema-failure" /\ ContentCurrent /\ s.failed))

TakeQueue ==
  /\ s.w = "Idle" /\ ~s.ready /\ Mutation # "empty-inner"
  /\ s' = [s EXCEPT !.w = "Queued", !.qRev = s.sqlRev,
       !.qEpoch = s.blockEpoch, !.qHash = s.blockHash, !.qSchema = s.schema,
       !.chunk = 0, !.cancelled = FALSE, !.failed = FALSE,
       !.attested = FALSE, !.last = "TakeQueue"]
LegacyEmptySnapshot ==
  /\ Mutation = "empty-inner" /\ s.w = "Idle"
  /\ s' = [s EXCEPT !.w = "Starved", !.last = "LegacyEmptySnapshot"]
WorkerHeadless ==
  /\ s.w = "Queued" /\ s.headless = "none" /\ Mutation # "inverse-acquire"
  /\ s' = [s EXCEPT !.headless = "worker", !.w = "Headless", !.last = "WorkerHeadless"]
WorkerBody ==
  /\ s.w = "Headless" /\ s.body = "none"
  /\ s' = [s EXCEPT !.body = "worker", !.w = "Attest", !.last = "WorkerBody"]
InverseBody ==
  /\ Mutation = "inverse-acquire" /\ s.w = "Queued" /\ s.body = "none"
  /\ s' = [s EXCEPT !.body = "worker", !.w = "WantHeadless", !.last = "InverseBody"]
InverseHeadless ==
  /\ s.w = "WantHeadless" /\ s.headless = "none"
  /\ s' = [s EXCEPT !.headless = "worker", !.w = "Attest", !.last = "InverseHeadless"]
AttestBody ==
  /\ s.w = "Attest" /\ s.headless = "worker" /\ s.qRev = s.fsRev
  /\ s' = [s EXCEPT !.input = TRUE, !.attested = TRUE,
       !.headless = "none", !.w = "Build", !.last = "AttestBody"]
RejectAttestation ==
  /\ s.w = "Attest" /\ s.qRev # s.fsRev
  /\ s' = [s EXCEPT !.headless = "none", !.w = "Drain",
       !.attestationRejected = TRUE, !.last = "RejectAttestation"]
BuildBatch ==
  /\ s.w = "Build" /\ s.chunk < 2 /\ s.payload = 0
  /\ s' = [s EXCEPT !.payload = 1, !.chunk = @ + 1,
       !.w = "Provider", !.last = "BuildBatch"]
ProviderReply ==
  /\ s.w = "Provider"
  /\ s' = [s EXCEPT !.w = "Reply", !.last = "ProviderReply"]
ProviderFailure ==
  /\ s.w = "Provider" /\ Fault = "failure" /\ ~s.failureUsed
  /\ s' = [s EXCEPT !.w = "Reply", !.failed = TRUE,
       !.failureUsed = TRUE, !.last = "ProviderFailure"]
ConsumeReply ==
  /\ s.w = "Reply"
  /\ s' = [s EXCEPT !.payload = 0,
       !.w = IF s.failed \/ s.chunk = 2 THEN "Complete" ELSE "Build",
       !.last = "ConsumeReply"]
SourceEdit ==
  /\ Drift = "note" /\ s.w = "Provider" /\ s.fsRev = 1
  /\ s' = [s EXCEPT !.fsRev = 2, !.last = "SourceEdit"]
PublishProjection ==
  /\ s.fsRev = 2 /\ s.sqlRev = 1
  /\ s' = [s EXCEPT !.sqlRev = 2, !.blockEpoch = 2, !.blockHash = 2,
       !.ready = FALSE, !.vectorRev = 0, !.vectorEpoch = 0, !.vectorHash = 0,
       !.retries = 0, !.retryRev = 0, !.retryEpoch = 0, !.retryHash = 0,
       !.last = "PublishProjection"]
ReplaceBlock ==
  /\ Drift \in {"hash", "epoch"} /\ s.w = "Provider"
  /\ IF Drift = "hash" THEN s.blockHash = 1 ELSE s.blockEpoch = 1
  /\ s' = [s EXCEPT !.blockHash = IF Drift = "hash" THEN 2 ELSE @,
       !.blockEpoch = IF Drift = "epoch" THEN 2 ELSE @,
       !.ready = FALSE, !.vectorRev = 0, !.vectorEpoch = 0, !.vectorHash = 0,
       !.retries = 0, !.retryRev = 0, !.retryEpoch = 0, !.retryHash = 0,
       !.last = "ReplaceBlock"]
SchemaReset ==
  /\ Drift = "schema" /\ s.schema = 1 /\ s.w \in {"Provider", "Complete"}
  /\ s' = [s EXCEPT !.schema = 2, !.ready = FALSE,
       !.vectorRev = 0, !.vectorEpoch = 0, !.vectorHash = 0, !.vectorSchema = 0,
       !.retries = 0, !.retryRev = 0, !.retryEpoch = 0, !.retryHash = 0, !.retrySchema = 0,
       !.resetPendingSQL = (s.w = "Complete"), !.last = "SchemaReset"]
CompleteSQL ==
  /\ s.w = "Complete"
  /\ Mutation # "completion-lock" \/ s.headless = "none"
  /\ s' = [s EXCEPT !.w = "Drain", !.matched = IF MayWrite THEN 1 ELSE 0,
       !.staleWrite = @ \/ (MayWrite /\ ~Current),
       !.staleSuccess = @ \/ (~Current /\ ~s.failed /\ ~MayWrite),
       !.staleFailure = @ \/ (~Current /\ s.failed /\ ~MayWrite),
       !.oldSourceResult = @ \/ (MayWrite /\ ~s.failed /\ s.qRev # s.fsRev),
       !.newReady = @ \/ (MayWrite /\ ~s.failed /\ s.sqlRev = 2),
       !.schemaReady = @ \/ (MayWrite /\ ~s.failed /\ s.schema = 2),
       !.vectorSchema = IF MayWrite /\ ~s.failed THEN s.qSchema ELSE @,
       !.retrySchema = IF MayWrite /\ s.failed THEN s.qSchema ELSE @,
       !.ready = IF MayWrite /\ ~s.failed THEN TRUE ELSE @,
       !.vectorRev = IF MayWrite /\ ~s.failed THEN s.qRev ELSE @,
       !.vectorEpoch = IF MayWrite /\ ~s.failed THEN s.qEpoch ELSE @,
       !.vectorHash = IF MayWrite /\ ~s.failed THEN s.qHash ELSE @,
       !.retries = IF MayWrite /\ s.failed THEN 1 ELSE @,
       !.retryRev = IF MayWrite /\ s.failed THEN s.qRev ELSE @,
       !.retryEpoch = IF MayWrite /\ s.failed THEN s.qEpoch ELSE @,
       !.retryHash = IF MayWrite /\ s.failed THEN s.qHash ELSE @,
       !.last = "CompleteSQL"]
Cancel ==
  /\ Fault = "cancel" /\ s.w = "Provider" /\ ~s.cancelUsed
  /\ s' = [s EXCEPT !.w = "Cancelled", !.cancelled = TRUE,
       !.cancelUsed = TRUE, !.matched = 0, !.last = "Cancel"]
LateReply ==
  /\ s.w = "Cancelled"
  /\ s' = [s EXCEPT !.w = "Drain", !.lateIgnored = TRUE,
       !.matched = IF Mutation = "cancelled-write" THEN 1 ELSE 0, !.last = "LateReply"]
Drain ==
  /\ s.w = "Drain"
  /\ s' = [s EXCEPT !.input = FALSE, !.payload = 0, !.body = "none",
       !.w = "Idle", !.last = "Drain"]
ApiHeadless ==
  /\ s.api = "Idle" /\ s.headless = "none" /\ s.body = "worker"
  /\ s' = [s EXCEPT !.headless = "api", !.api = "WaitBody", !.last = "ApiHeadless"]
ApiBody ==
  /\ s.api = "WaitBody" /\ s.body = "none"
  /\ s' = [s EXCEPT !.body = "api", !.api = "Body", !.last = "ApiBody"]
ApiRelease ==
  /\ s.api = "Body"
  /\ s' = [s EXCEPT !.body = "none", !.headless = "none",
       !.api = "Done", !.last = "ApiRelease"]
Terminal ==
  /\ ((s.w = "Idle" /\ s.ready /\ s.api \in {"Idle", "Done"} /\ s.fsRev = s.sqlRev)
      \/ s.w = "Starved")
  /\ UNCHANGED vars
Next == TakeQueue \/ LegacyEmptySnapshot \/ WorkerHeadless \/ WorkerBody \/
  InverseBody \/ InverseHeadless \/ AttestBody \/ RejectAttestation \/ BuildBatch \/
  ProviderReply \/ ProviderFailure \/ ConsumeReply \/ SourceEdit \/ PublishProjection \/
  ReplaceBlock \/ SchemaReset \/ CompleteSQL \/ Cancel \/ LateReply \/ Drain \/
  ApiHeadless \/ ApiBody \/ ApiRelease \/ Terminal
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(TakeQueue) /\ WF_vars(WorkerHeadless) /\ WF_vars(WorkerBody)
  /\ WF_vars(AttestBody) /\ WF_vars(RejectAttestation) /\ WF_vars(BuildBatch)
  /\ WF_vars(ProviderReply) /\ WF_vars(ConsumeReply) /\ WF_vars(CompleteSQL)
  /\ WF_vars(PublishProjection) /\ WF_vars(LateReply) /\ WF_vars(Drain)
  /\ WF_vars(ApiBody) /\ WF_vars(ApiRelease) /\ WF_vars(LegacyEmptySnapshot)

TypeOK == s.w \in {"Idle", "Queued", "Headless", "Attest", "WantHeadless", "Build",
  "Provider", "Reply", "Complete", "Cancelled", "Drain", "Starved"}
  /\ s.api \in {"Idle", "WaitBody", "Body", "Done"}
  /\ s.headless \in {"none", "worker", "api"} /\ s.body \in {"none", "worker", "api"}
  /\ s.fsRev \in 1..2 /\ s.sqlRev \in 1..2 /\ s.blockEpoch \in 1..2 /\ s.blockHash \in 1..2
  /\ s.qRev \in 0..2 /\ s.qEpoch \in 0..2 /\ s.qHash \in 0..2
  /\ s.schema \in 1..2 /\ s.qSchema \in 0..2 /\ s.vectorSchema \in 0..2 /\ s.retrySchema \in 0..2
  /\ s.chunk \in 0..2 /\ s.payload \in 0..1 /\ s.retries \in 0..1 /\ s.matched \in 0..1
Owned == (s.input \/ s.payload > 0) => s.body = "worker"
ProviderOutsideHeadless == s.w \in {"Provider", "Reply", "Cancelled"} => s.headless # "worker"
AttestedUse == s.payload > 0 => s.attested /\ s.input
GenerationSafe == ~s.staleWrite /\
  ((s.last = "CompleteSQL" /\ ~Current) => s.matched = 0) /\
  (s.ready => s.vectorSchema = s.schema /\ s.vectorRev = s.sqlRev /\ (WorkKind = "note" \/
    (s.vectorEpoch = s.blockEpoch /\ s.vectorHash = s.blockHash))) /\
  (s.retries > 0 => s.retrySchema = s.schema /\ s.retryRev = s.sqlRev /\ (WorkKind = "note" \/
    (s.retryEpoch = s.blockEpoch /\ s.retryHash = s.blockHash)))
CancelledSafe == s.cancelled => s.w \in {"Cancelled", "Drain", "Idle"} /\ s.matched = 0
EventuallyReady == <>[](s.ready)
EventuallyDrained == (s.w = "Drain" \/ s.w = "Cancelled") ~> s.body # "worker"
ApiProgress == s.api = "WaitBody" ~> s.api = "Done"
CurrentGenerationRetry == (s.sqlRev = 2 /\ ~s.ready) ~> (s.ready /\ s.vectorRev = 2)
NeverStaleSuccess == ~s.staleSuccess
NeverStaleFailure == ~s.staleFailure
NeverOldSourceResult == ~s.oldSourceResult
NeverLateIgnored == ~s.lateIgnored
NeverNewReady == ~s.newReady
NeverApiWait == ~(s.api = "WaitBody" /\ s.w = "Provider")
NeverRejected == ~s.attestationRejected
SchemaGenerationRetry == (s.schema = 2 /\ ~s.ready) ~> (s.ready /\ s.vectorSchema = 2)
NeverSchemaReady == ~s.schemaReady
NeverResetPendingSQL == ~s.resetPendingSQL
NeverInverseHeadless == ~(s.w = "Attest" /\ Mutation = "inverse-acquire")
=============================================================================
