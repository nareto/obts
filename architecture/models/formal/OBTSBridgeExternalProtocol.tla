---- MODULE OBTSBridgeExternalProtocol ----
EXTENDS FiniteSets, Naturals, Sequences, TLC

(***************************************************************************
OBTS-FM-005, architecture revision 12. This focused bounded model separates
mandatory caller revision admission from the source-revision CAS seam, and
policy selection from bounded Markdown export hydration/serialization. It is
not a hashing, ZIP, SQL-policy, filesystem-permission, HTTP-streaming, or
implementation-conformance proof.
***************************************************************************)

CONSTANTS FileA, FileB, DeniedFile, NoFile,
          Revision0, Revision1, Revision2, NoRevision,
          Mode, FaultMode

Corpus == {FileA, FileB, DeniedFile}
AllowedFiles == {FileA, FileB}
TerminalPhases == {"Written", "Rejected", "Ready", "FailedReleased"}

ASSUME FileA # FileB /\ FileA # DeniedFile /\ FileB # DeniedFile
ASSUME NoFile \notin Corpus
ASSUME Cardinality({Revision0, Revision1, Revision2, NoRevision}) = 4
ASSUME Mode \in {"revision", "export"}

VARIABLES phase, currentRevision, expectedRevision, capturedRevision,
          writeAuthorized, seamMatched, mutationCount,
          candidates, spooled, bodyLease, manifestWritten, archived,
          cleanupDone, lastAction

vars == <<phase, currentRevision, expectedRevision, capturedRevision,
          writeAuthorized, seamMatched, mutationCount,
          candidates, spooled, bodyLease, manifestWritten, archived,
          cleanupDone, lastAction>>

Init ==
  /\ phase = "Idle"
  /\ currentRevision = Revision0
  /\ expectedRevision =
       IF FaultMode \in {"missing", "missing-bypass"} THEN NoRevision
       ELSE IF FaultMode \in {"stale", "stale-bypass"} THEN Revision1
       ELSE Revision0
  /\ capturedRevision = NoRevision
  /\ writeAuthorized = FALSE
  /\ seamMatched = FALSE
  /\ mutationCount = 0
  /\ candidates = {}
  /\ spooled = {}
  /\ bodyLease = NoFile
  /\ manifestWritten = FALSE
  /\ archived = {}
  /\ cleanupDone = FALSE
  /\ lastAction = "Init"

BeginRevision ==
  /\ Mode = "revision" /\ phase = "Idle"
  /\ phase' = "Read"
  /\ lastAction' = "BeginRevision"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived, cleanupDone>>

ValidateRevision ==
  /\ Mode = "revision" /\ phase = "Read"
  /\ expectedRevision # NoRevision
  /\ expectedRevision = currentRevision
  /\ phase' = "Prepared"
  /\ capturedRevision' = currentRevision
  /\ writeAuthorized' = TRUE
  /\ lastAction' = "ValidateRevision"
  /\ UNCHANGED <<currentRevision, expectedRevision, seamMatched, mutationCount,
       candidates, spooled, bodyLease, manifestWritten, archived, cleanupDone>>

RejectRevision ==
  /\ Mode = "revision" /\ phase = "Read"
  /\ expectedRevision = NoRevision \/ expectedRevision # currentRevision
  /\ phase' = "Rejected"
  /\ cleanupDone' = TRUE
  /\ lastAction' = "RejectRevision"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived>>

ExternalChange ==
  /\ Mode = "revision" /\ phase = "Prepared"
  /\ FaultMode \in {"drift", "drift-bypass"}
  /\ currentRevision = Revision0
  /\ currentRevision' = Revision1
  /\ lastAction' = "ExternalChange"
  /\ UNCHANGED <<phase, expectedRevision, capturedRevision, writeAuthorized,
       seamMatched, mutationCount, candidates, spooled, bodyLease,
       manifestWritten, archived, cleanupDone>>

AtomicRevisionWrite ==
  /\ Mode = "revision" /\ phase = "Prepared"
  /\ capturedRevision = currentRevision
  /\ phase' = "Written"
  /\ currentRevision' = Revision2
  /\ seamMatched' = TRUE
  /\ mutationCount' = mutationCount + 1
  /\ cleanupDone' = TRUE
  /\ lastAction' = "AtomicRevisionWrite"
  /\ UNCHANGED <<expectedRevision, capturedRevision, writeAuthorized,
       candidates, spooled, bodyLease, manifestWritten, archived>>

RejectRevisionDrift ==
  /\ Mode = "revision" /\ phase = "Prepared"
  /\ capturedRevision # currentRevision
  /\ phase' = "Rejected"
  /\ cleanupDone' = TRUE
  /\ lastAction' = "RejectRevisionDrift"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived>>

WriteWithoutPrecondition ==
  /\ Mode = "revision" /\ phase = "Read"
  /\ FaultMode \in {"missing-bypass", "stale-bypass"}
  /\ expectedRevision = NoRevision \/ expectedRevision # currentRevision
  /\ phase' = "Written"
  /\ currentRevision' = Revision2
  /\ mutationCount' = mutationCount + 1
  /\ cleanupDone' = TRUE
  /\ lastAction' = "WriteWithoutPrecondition"
  /\ UNCHANGED <<expectedRevision, capturedRevision, writeAuthorized,
       seamMatched, candidates, spooled, bodyLease, manifestWritten, archived>>

WriteAfterDrift ==
  /\ Mode = "revision" /\ phase = "Prepared"
  /\ FaultMode = "drift-bypass"
  /\ capturedRevision # currentRevision
  /\ phase' = "Written"
  /\ currentRevision' = Revision2
  /\ mutationCount' = mutationCount + 1
  /\ cleanupDone' = TRUE
  /\ lastAction' = "WriteAfterDrift"
  /\ UNCHANGED <<expectedRevision, capturedRevision, writeAuthorized,
       seamMatched, candidates, spooled, bodyLease, manifestWritten, archived>>

BeginExport ==
  /\ Mode = "export" /\ phase = "Idle"
  /\ phase' = "Planning"
  /\ candidates' = AllowedFiles
  /\ lastAction' = "BeginExport"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, spooled, bodyLease,
       manifestWritten, archived, cleanupDone>>

AcquireExportBody(f) ==
  /\ Mode = "export" /\ phase \in {"Planning", "Spooling"}
  /\ f \in candidates \ spooled
  /\ bodyLease = NoFile
  /\ f = FileA \/ FileA \in spooled
  /\ phase' = "Spooling"
  /\ bodyLease' = f
  /\ lastAction' = "AcquireExportBody"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       manifestWritten, archived, cleanupDone>>

SpoolExportBody ==
  /\ Mode = "export" /\ phase = "Spooling"
  /\ bodyLease \in candidates
  /\ spooled' = spooled \cup {bodyLease}
  /\ bodyLease' = NoFile
  /\ lastAction' = "SpoolExportBody"
  /\ UNCHANGED <<phase, currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates,
       manifestWritten, archived, cleanupDone>>

WriteManifest ==
  /\ Mode = "export" /\ phase \in {"Planning", "Spooling"}
  /\ spooled = candidates /\ bodyLease = NoFile
  /\ phase' = "Manifest"
  /\ manifestWritten' = TRUE
  /\ lastAction' = "WriteManifest"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, archived, cleanupDone>>

WriteExportEntry(f) ==
  /\ Mode = "export" /\ phase \in {"Manifest", "Entries"}
  /\ manifestWritten
  /\ f \in spooled \ archived
  /\ f = FileA \/ FileA \in archived
  /\ phase' = "Entries"
  /\ archived' = archived \cup {f}
  /\ lastAction' = "WriteExportEntry"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, cleanupDone>>

CompleteExport ==
  /\ Mode = "export" /\ phase \in {"Manifest", "Entries"}
  /\ manifestWritten /\ archived = candidates /\ bodyLease = NoFile
  /\ phase' = "Ready"
  /\ cleanupDone' = TRUE
  /\ lastAction' = "CompleteExport"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived>>

CancelExport ==
  /\ Mode = "export" /\ FaultMode = "cancel"
  /\ phase \in {"Planning", "Spooling", "Manifest", "Entries"}
  /\ phase' = "Cancelled"
  /\ lastAction' = "CancelExport"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived, cleanupDone>>

DrainExport ==
  /\ Mode = "export" /\ phase = "Cancelled"
  /\ phase' = "FailedReleased"
  /\ bodyLease' = NoFile
  /\ cleanupDone' = TRUE
  /\ lastAction' = "DrainExport"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       manifestWritten, archived>>

AcquireDeniedBody ==
  /\ Mode = "export" /\ FaultMode = "denied-hydration"
  /\ phase = "Planning" /\ bodyLease = NoFile
  /\ bodyLease' = DeniedFile
  /\ phase' = "Spooling"
  /\ lastAction' = "AcquireDeniedBody"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       manifestWritten, archived, cleanupDone>>

WriteEntryBeforeManifest ==
  /\ Mode = "export" /\ FaultMode = "entry-before-manifest"
  /\ phase = "Planning"
  /\ archived' = {FileA}
  /\ phase' = "Entries"
  /\ lastAction' = "WriteEntryBeforeManifest"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, cleanupDone>>

CompleteWithLease ==
  /\ Mode = "export" /\ FaultMode = "lease-leak"
  /\ phase = "Spooling" /\ bodyLease # NoFile
  /\ phase' = "Ready"
  /\ lastAction' = "CompleteWithLease"
  /\ UNCHANGED <<currentRevision, expectedRevision, capturedRevision,
       writeAuthorized, seamMatched, mutationCount, candidates, spooled,
       bodyLease, manifestWritten, archived, cleanupDone>>

RevisionCoreNext ==
  BeginRevision \/ ValidateRevision \/ RejectRevision \/ ExternalChange
  \/ AtomicRevisionWrite \/ RejectRevisionDrift
RevisionFaultNext == WriteWithoutPrecondition \/ WriteAfterDrift
RevisionNext == RevisionCoreNext \/ RevisionFaultNext \/ UNCHANGED vars

ExportCoreNext ==
  BeginExport \/ (\E f \in Corpus: AcquireExportBody(f))
  \/ SpoolExportBody \/ WriteManifest
  \/ (\E f \in Corpus: WriteExportEntry(f))
  \/ CompleteExport \/ CancelExport \/ DrainExport
ExportFaultNext == AcquireDeniedBody \/ WriteEntryBeforeManifest \/ CompleteWithLease
ExportNext == ExportCoreNext \/ ExportFaultNext \/ UNCHANGED vars

RevisionMutationAuthorized ==
  phase = "Written" =>
    writeAuthorized /\ seamMatched /\ expectedRevision = capturedRevision
    /\ mutationCount = 1 /\ currentRevision = Revision2
RejectedWritePreservesSource ==
  phase = "Rejected" => mutationCount = 0 /\ currentRevision \in {Revision0, Revision1}
AllRevisionSafety == RevisionMutationAuthorized /\ RejectedWritePreservesSource

PolicyBeforeHydration == bodyLease = NoFile \/ bodyLease \in candidates
DeniedFileNotSelected == DeniedFile \notin candidates
ManifestFirst == archived = {} \/ manifestWritten
ExportCompleteSafe ==
  phase = "Ready" =>
    manifestWritten /\ archived = candidates /\ bodyLease = NoFile /\ cleanupDone
ExportDrainSafe ==
  phase = "FailedReleased" => bodyLease = NoFile /\ cleanupDone
AllExportSafety ==
  PolicyBeforeHydration /\ DeniedFileNotSelected /\ ManifestFirst
  /\ ExportCompleteSafe /\ ExportDrainSafe

NeverRejected == phase # "Rejected"
NeverRejectDrift == ~(phase = "Rejected" /\ currentRevision = Revision1)
NeverReady == phase # "Ready"
NeverCancelled == phase # "Cancelled"
NeverAcquireDenied == lastAction # "AcquireDeniedBody"
NeverEntryBeforeManifest == lastAction # "WriteEntryBeforeManifest"
NeverCompleteWithLease == lastAction # "CompleteWithLease"

RevisionSpec == Init /\ [][RevisionNext]_vars
RevisionLiveSpec == RevisionSpec
  /\ WF_vars(BeginRevision) /\ WF_vars(ValidateRevision)
  /\ WF_vars(RejectRevision) /\ WF_vars(AtomicRevisionWrite)
  /\ WF_vars(RejectRevisionDrift)
RevisionSettles ==
  (Mode = "revision" /\ phase = "Idle") ~> (phase \in {"Written", "Rejected"})

ExportSpec == Init /\ [][ExportNext]_vars
ExportLiveSpec == ExportSpec
  /\ WF_vars(BeginExport)
  /\ (\A f \in Corpus: WF_vars(AcquireExportBody(f)))
  /\ WF_vars(SpoolExportBody) /\ WF_vars(WriteManifest)
  /\ (\A f \in Corpus: WF_vars(WriteExportEntry(f)))
  /\ WF_vars(CompleteExport) /\ WF_vars(CancelExport) /\ WF_vars(DrainExport)
ExportSettles ==
  (Mode = "export" /\ phase = "Idle") ~> (phase \in {"Ready", "FailedReleased"})
CancelledDrains == phase = "Cancelled" ~> phase = "FailedReleased"

=============================================================================
