---- MODULE OBTSApplyInPlace ----
EXTENDS OBTSApplyRecovery

(***************************************************************************
FM001 companion; architecture revision 34.
Refines OBTS-SAF-001, OBTS-SAF-002, OBTS-SAF-005.

Existing regular file -> regular file: publish a verified pre-image COPY, leave
its live path intact, compare its current bytes, then modify in place. Copy
presence does not imply removal. Crash/restart classifies old, target, or unknown
bytes (including an interrupted write); unknown bytes are durably preserved and
retained as local work, never replaced on the strength of the copy alone.

The unchanged losslessness predicates describe the required conditional mutation
seam. NonAtomicWrite=TRUE exposes the actual compare-to-storage-write gap, also
present before delete in the previous implementation. Its required negative
control records the unresolved implementation defect tracked as OBTS issue #33;
positive TLC does NOT prove modifyBinary is a conditional byte-write primitive.

One client, one regular path, one complete local edit, one crash, one symbolic
partial target. Inherited bundle publication assumptions remain unchanged.
RecoverUnknownImage / DeferChangedImage abstract COMPLETE durable preservation
publication plus local-work scheduling, not a successful write Promise alone.
Deletion, exclusive new-file creation and type changes retain the FM001 pilot
and executable coverage; this companion does not model those filesystem types.
***************************************************************************)

CONSTANT NonAtomicWrite
ASSUME NonAtomicWrite \in BOOLEAN

PartialTarget == "partial-target"
VARIABLES copiedPreimage, comparisonComplete, recoveredImage
extraVars == <<copiedPreimage, comparisonComplete, recoveredImage>>
inPlaceVars == <<vars, extraVars>>

InPlaceInit ==
  /\ Init
  /\ copiedPreimage = NoVersion
  /\ comparisonComplete = FALSE
  /\ recoveredImage = "none"

CopyVerifiedPreimage ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = NoVersion
  /\ visible = preflight /\ preflight \in recoveryVersions
  /\ copiedPreimage' = visible
  /\ UNCHANGED <<vars, comparisonComplete, recoveredImage>>

CompareCurrentBytes ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = preflight
  /\ ~comparisonComplete
  /\ comparisonComplete' = TRUE
  /\ UNCHANGED <<vars, copiedPreimage, recoveredImage>>

CanModify ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ comparisonComplete
  /\ visible # Target
  /\ (NonAtomicWrite \/ visible = preflight)

ModifyExistingFile ==
  /\ CanModify
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = Target
  /\ UNCHANGED <<phase, running, recovering, crashCount, preflight,
       initialBundleState, postWriteBundleState, recoveryVersions, gitVersions,
       observedLocalVersions, refsMain, coordinationMain, ackIntentDurable,
       editOccurred, journalPresent, extraVars>>

InterruptExistingWrite ==
  /\ CanModify /\ crashCount < MaxCrashes
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = PartialTarget
  /\ running' = FALSE /\ crashCount' = crashCount + 1
  /\ comparisonComplete' = FALSE
  /\ UNCHANGED <<phase, recovering, preflight, initialBundleState,
       postWriteBundleState, recoveryVersions, gitVersions, observedLocalVersions,
       refsMain, coordinationMain, ackIntentDurable, editOccurred, journalPresent,
       copiedPreimage, recoveredImage>>

LocalWriteBetweenCompareAndModify ==
  /\ comparisonComplete /\ ConcurrentEdit
  /\ UNCHANGED extraVars

OtherConcurrentEdit ==
  /\ ~comparisonComplete /\ ConcurrentEdit
  /\ UNCHANGED extraVars

InPlaceCrash ==
  /\ Crash
  /\ comparisonComplete' = FALSE
  /\ UNCHANGED <<copiedPreimage, recoveredImage>>

RecoverOldImage ==
  /\ running /\ recovering /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = preflight
  /\ recovering' = FALSE /\ recoveredImage' = "old"
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
       initialBundleState, postWriteBundleState, recoveryVersions, gitVersions,
       observedLocalVersions, overwrittenVersions, refsMain, coordinationMain,
       ackIntentDurable, editOccurred, journalPresent, copiedPreimage,
       comparisonComplete>>

RecoverTargetImage ==
  /\ running /\ recovering /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = Target
  /\ phase' = "Verifying" /\ recovering' = FALSE
  /\ recoveredImage' = "target"
  /\ UNCHANGED <<running, crashCount, visible, preflight, initialBundleState,
       postWriteBundleState, recoveryVersions, gitVersions, observedLocalVersions,
       overwrittenVersions, refsMain, coordinationMain, ackIntentDurable,
       editOccurred, journalPresent, copiedPreimage, comparisonComplete>>

PreserveChangedImage ==
  /\ phase = "Writing" /\ visible \in {LocalEdit, PartialTarget}
  /\ recoveryVersions' = recoveryVersions \cup {visible}
  /\ observedLocalVersions' = observedLocalVersions \cup {visible}
  /\ phase' = "Verifying"
  /\ UNCHANGED <<running, crashCount, visible, preflight, initialBundleState,
       postWriteBundleState, gitVersions, overwrittenVersions, refsMain,
       coordinationMain, ackIntentDurable, editOccurred, journalPresent,
       copiedPreimage, comparisonComplete>>

RecoverUnknownImage ==
  /\ running /\ recovering /\ copiedPreimage = preflight
  /\ PreserveChangedImage /\ recovering' = FALSE
  /\ recoveredImage' = "unknown"

DeferChangedImage ==
  /\ Normal /\ PreserveChangedImage
  /\ UNCHANGED <<recovering, recoveredImage>>

OtherProtocolProgress ==
  /\ (StartApply \/ StageInitialBundle \/ PublishInitialBundle
      \/ RecordRecoveryPublication \/ InitialPublicationFailure \/ BeginWriting
      \/ RecordFilesWritten \/ StagePostWriteBundle \/ PublishPostWriteBundle
      \/ RecordPostWritePreservation \/ PostWritePublicationFailure \/ MoveRefs
      \/ RecordRefsCommitted \/ CommitCoordination \/ RecordCoordinationCommitted
      \/ PersistAckIntent \/ RecordAckIntent \/ Cleanup \/ Restart
      \/ RecoverPlannedUnpublished \/ RecoverPlannedPublished
      \/ RecoverRecordedBeforeWrite
      \/ (copiedPreimage = NoVersion /\ RecoverWritingBeforeWrite)
      \/ RecoverFilesWritten \/ RecoverPreservedPostWrite
      \/ RecoverVerifyingBeforeRefs \/ RecoverMovedRefs \/ RecoverRefsCommitted
      \/ RecoverCoordinationCommitted \/ RecoverAckIntent
      \/ (~(phase = "Writing" /\ copiedPreimage # NoVersion) /\ RecoverBlock))
  /\ UNCHANGED extraVars

InPlaceProgress ==
  CopyVerifiedPreimage \/ CompareCurrentBytes \/ ModifyExistingFile
  \/ RecoverOldImage \/ RecoverTargetImage \/ RecoverUnknownImage
  \/ DeferChangedImage \/ OtherProtocolProgress

InPlaceNext ==
  InPlaceProgress \/ LocalWriteBetweenCompareAndModify \/ OtherConcurrentEdit
  \/ InPlaceCrash \/ InterruptExistingWrite
  \/ (Terminal /\ UNCHANGED inPlaceVars)

InPlaceSafetySpec == InPlaceInit /\ [][InPlaceNext]_inPlaceVars
InPlaceLiveSpec == InPlaceSafetySpec /\ WF_inPlaceVars(InPlaceProgress)

InPlaceTypeOK ==
  /\ phase \in Phases /\ running \in BOOLEAN /\ recovering \in BOOLEAN
  /\ crashCount \in 0..MaxCrashes
  /\ visible \in Versions \cup {PartialTarget}
  /\ preflight \in Versions \cup {NoVersion}
  /\ initialBundleState \in BundleStates /\ postWriteBundleState \in BundleStates
  /\ recoveryVersions \subseteq LocalVersions \cup {PartialTarget}
  /\ gitVersions \subseteq Versions
  /\ observedLocalVersions \subseteq LocalVersions \cup {PartialTarget}
  /\ overwrittenVersions \subseteq LocalVersions
  /\ refsMain \in {Local0, Target} /\ coordinationMain \in {Local0, Target}
  /\ ackIntentDurable \in BOOLEAN /\ editOccurred \in BOOLEAN
  /\ journalPresent \in BOOLEAN
  /\ copiedPreimage \in LocalVersions \cup {NoVersion}
  /\ comparisonComplete \in BOOLEAN
  /\ recoveredImage \in {"none", "old", "target", "unknown"}

NoOldImageRecovery == recoveredImage # "old"
NoTargetImageRecovery == recoveredImage # "target"
NoUnknownImageRecovery == ~(recoveredImage = "unknown" /\ visible = PartialTarget)

=============================================================================
