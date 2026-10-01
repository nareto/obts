---- MODULE OBTSApplyInPlace ----
EXTENDS OBTSApplyRecovery

(***************************************************************************
FM001 companion; architecture revision 36.
Refines OBTS-SAF-001, OBTS-SAF-002, OBTS-SAF-005, OBTS-PER-GATE-001.
Split final compare and raw mutation, with a volatile same-adapter gate held
across both actions. NonAtomicWrite disables that gate (historical control ID).
ExternalWriter bypasses it and documents the unsupported writer residual.
DeleteMutation interprets Target as absence: verified copy, compare, raw remove.
A crash releases the gate; restart reclassifies durable old/target/unknown bytes.
One path, one local edit, one crash, one symbolic interrupted regular-file write.
Atomic bundle publication is inherited, not proven. Gate lifecycle, hierarchy,
FIFO, watchdog and native storage semantics need separate executable evidence.
***************************************************************************)

CONSTANTS NonAtomicWrite, ExternalWriter, DeleteMutation
ASSUME NonAtomicWrite \in BOOLEAN
ASSUME ExternalWriter \in BOOLEAN
ASSUME DeleteMutation \in BOOLEAN

PartialTarget == "partial-target"
VARIABLES copiedPreimage, comparisonComplete, recoveredImage, gateHeld
extraVars == <<copiedPreimage, comparisonComplete, recoveredImage, gateHeld>>
inPlaceVars == <<vars, extraVars>>

InPlaceInit ==
  /\ Init
  /\ copiedPreimage = NoVersion
  /\ comparisonComplete = FALSE
  /\ recoveredImage = "none"
  /\ gateHeld = FALSE

CopyVerifiedPreimage ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = NoVersion
  /\ visible = preflight /\ preflight \in recoveryVersions
  /\ copiedPreimage' = visible
  /\ UNCHANGED <<vars, comparisonComplete, recoveredImage, gateHeld>>

CompareCurrentBytes ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = preflight
  /\ ~comparisonComplete
  /\ comparisonComplete' = TRUE
  /\ gateHeld' = ~NonAtomicWrite
  /\ UNCHANGED <<vars, copiedPreimage, recoveredImage>>

CanModify ==
  /\ Normal /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ comparisonComplete
  /\ visible # Target
  /\ (NonAtomicWrite \/ gateHeld)

ModifyExistingFile ==
  /\ ~DeleteMutation /\ CanModify
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = Target
  /\ gateHeld' = FALSE /\ comparisonComplete' = FALSE
  /\ UNCHANGED <<phase, running, recovering, crashCount, preflight,
       initialBundleState, postWriteBundleState, recoveryVersions, gitVersions,
       observedLocalVersions, refsMain, coordinationMain, ackIntentDurable,
       editOccurred, journalPresent, copiedPreimage, recoveredImage>>

DeleteExistingFile ==
  /\ DeleteMutation /\ CanModify
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = Target
  /\ gateHeld' = FALSE /\ comparisonComplete' = FALSE
  /\ UNCHANGED <<phase, running, recovering, crashCount, preflight,
       initialBundleState, postWriteBundleState, recoveryVersions, gitVersions,
       observedLocalVersions, refsMain, coordinationMain, ackIntentDurable,
       editOccurred, journalPresent, copiedPreimage, recoveredImage>>

InterruptExistingWrite ==
  /\ ~DeleteMutation /\ CanModify /\ crashCount < MaxCrashes
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = PartialTarget
  /\ running' = FALSE /\ crashCount' = crashCount + 1
  /\ comparisonComplete' = FALSE
  /\ gateHeld' = FALSE
  /\ UNCHANGED <<phase, recovering, preflight, initialBundleState,
       postWriteBundleState, recoveryVersions, gitVersions, observedLocalVersions,
       refsMain, coordinationMain, ackIntentDurable, editOccurred, journalPresent,
       copiedPreimage, recoveredImage>>

LocalWriteBetweenCompareAndModify ==
  /\ comparisonComplete /\ (~gateHeld \/ ExternalWriter) /\ ConcurrentEdit
  /\ UNCHANGED extraVars

OtherConcurrentEdit ==
  /\ ~comparisonComplete /\ ConcurrentEdit
  /\ UNCHANGED extraVars

InPlaceCrash ==
  /\ Crash
  /\ comparisonComplete' = FALSE
  /\ gateHeld' = FALSE
  /\ recoveredImage' = IF gateHeld THEN "gate-crash" ELSE recoveredImage
  /\ UNCHANGED copiedPreimage

RecoverOldImage ==
  /\ running /\ recovering /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = preflight
  /\ recovering' = FALSE /\ recoveredImage' = "old"
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
       initialBundleState, postWriteBundleState, recoveryVersions, gitVersions,
       observedLocalVersions, overwrittenVersions, refsMain, coordinationMain,
       ackIntentDurable, editOccurred, journalPresent, copiedPreimage,
       comparisonComplete, gateHeld>>

RecoverTargetImage ==
  /\ running /\ recovering /\ phase = "Writing"
  /\ copiedPreimage = preflight /\ visible = Target
  /\ phase' = "Verifying" /\ recovering' = FALSE
  /\ recoveredImage' = "target"
  /\ UNCHANGED <<running, crashCount, visible, preflight, initialBundleState,
       postWriteBundleState, recoveryVersions, gitVersions, observedLocalVersions,
       overwrittenVersions, refsMain, coordinationMain, ackIntentDurable,
       editOccurred, journalPresent, copiedPreimage, comparisonComplete, gateHeld>>

PreserveChangedImage ==
  /\ phase = "Writing" /\ visible \in {LocalEdit, PartialTarget}
  /\ recoveryVersions' = recoveryVersions \cup {visible}
  /\ observedLocalVersions' = observedLocalVersions \cup {visible}
  /\ phase' = "Verifying"
  /\ gateHeld' = FALSE /\ comparisonComplete' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight, initialBundleState,
       postWriteBundleState, gitVersions, overwrittenVersions, refsMain,
       coordinationMain, ackIntentDurable, editOccurred, journalPresent,
       copiedPreimage>>

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
  CopyVerifiedPreimage \/ CompareCurrentBytes \/ ModifyExistingFile \/ DeleteExistingFile
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
  /\ gateHeld \in BOOLEAN
  /\ (~running => ~gateHeld)
  /\ recoveredImage \in {"none", "old", "target", "unknown", "gate-crash"}

NoGateCrashRelease == recoveredImage # "gate-crash"
NoDeleteSeam == ~(DeleteMutation /\ visible = Target /\ phase = "Writing")

NoOldImageRecovery == recoveredImage # "old"
NoTargetImageRecovery == recoveredImage # "target"
NoUnknownImageRecovery == ~(recoveredImage = "unknown" /\ visible = PartialTarget)

CompanionActions == {
  "CopyVerifiedPreimage",
  "CompareCurrentBytes",
  "ModifyExistingFile",
  "DeleteExistingFile",
  "InterruptExistingWrite",
  "LocalWriteBetweenCompareAndModify",
  "OtherConcurrentEdit",
  "InPlaceCrash",
  "RecoverOldImage",
  "RecoverTargetImage",
  "RecoverUnknownImage",
  "DeferChangedImage",
  "OtherProtocolProgress"
}
=============================================================================
