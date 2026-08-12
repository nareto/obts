---- MODULE OBTSApplyRecovery ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
Model ID: OBTS-FM-001
Status: accepted bounded pilot
Architecture revision: 2
Refines: OBTS-SAF-001, OBTS-SAF-002, OBTS-SAF-005

One client and one path are modeled. Values represent exact content bytes plus
path identity and provenance. Every variable is a durable observation; volatile
call-stack state is omitted. Separating visible mutation, journal phase, refs,
coordination, acknowledgement intent, and cleanup permits crashes between their
durable boundaries. Restart enters explicit validation/classification before
normal progress can resume.

PublishInitialBundle and PublishPostWriteBundle each mean that complete marker,
checksum-verifiable snapshots, and required Git closure survive restart and are
discoverable after atomic publish. The model does not prove that a concrete
filesystem realizes this durability assumption.
***************************************************************************)

CONSTANTS MaxCrashes,
          RequireRecoveryBeforeMutation,
          CheckFreshAtMutation,
          AllowEarlyCleanup,
          InferCompletionOnRestart

ASSUME MaxCrashes \in Nat
ASSUME RequireRecoveryBeforeMutation \in BOOLEAN
ASSUME CheckFreshAtMutation \in BOOLEAN
ASSUME AllowEarlyCleanup \in BOOLEAN
ASSUME InferCompletionOnRestart \in BOOLEAN

Local0 == "local-0"
LocalEdit == "local-edit"
Target == "target"
NoVersion == "none"

Versions == {Local0, LocalEdit, Target}
LocalVersions == {Local0, LocalEdit}
Phases == {
  "Idle",
  "Planned",
  "RecoveryRecorded",
  "Writing",
  "Verifying",
  "RefsCommitted",
  "CoordinationCommitted",
  "AckIntentPersisted",
  "Blocked",
  "Done"
}
BundleStates == {"None", "Staged", "Complete", "Failed"}

VARIABLES phase,
          running,
          recovering,
          crashCount,
          visible,
          preflight,
          initialBundleState,
          postWriteBundleState,
          recoveryVersions,
          gitVersions,
          observedLocalVersions,
          overwrittenVersions,
          refsMain,
          coordinationMain,
          ackIntentDurable,
          editOccurred,
          journalPresent

vars == <<phase,
          running,
          recovering,
          crashCount,
          visible,
          preflight,
          initialBundleState,
          postWriteBundleState,
          recoveryVersions,
          gitVersions,
          observedLocalVersions,
          overwrittenVersions,
          refsMain,
          coordinationMain,
          ackIntentDurable,
          editOccurred,
          journalPresent>>

Rooted(version) ==
  \/ visible = version
  \/ version \in gitVersions
  \/ version \in recoveryVersions

Init ==
  /\ phase = "Idle"
  /\ running = TRUE
  /\ recovering = FALSE
  /\ crashCount = 0
  /\ visible = Local0
  /\ preflight = NoVersion
  /\ initialBundleState = "None"
  /\ postWriteBundleState = "None"
  /\ recoveryVersions = {}
  /\ gitVersions = {Local0}
  /\ observedLocalVersions = {Local0}
  /\ overwrittenVersions = {}
  /\ refsMain = Local0
  /\ coordinationMain = Local0
  /\ ackIntentDurable = FALSE
  /\ editOccurred = FALSE
  /\ journalPresent = FALSE

Normal == running /\ ~recovering

StartApply ==
  /\ Normal
  /\ phase = "Idle"
  /\ phase' = "Planned"
  /\ preflight' = visible
  /\ journalPresent' = TRUE
  /\ UNCHANGED <<running, recovering, crashCount, visible,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred>>

StageInitialBundle ==
  /\ Normal
  /\ phase = "Planned"
  /\ initialBundleState = "None"
  /\ initialBundleState' = "Staged"
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  postWriteBundleState, recoveryVersions, observedLocalVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

PublishInitialBundle ==
  /\ Normal
  /\ phase = "Planned"
  /\ initialBundleState = "Staged"
  /\ initialBundleState' = "Complete"
  /\ recoveryVersions' = recoveryVersions \cup {preflight}
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  postWriteBundleState, gitVersions, observedLocalVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

RecordRecoveryPublication ==
  /\ Normal
  /\ phase = "Planned"
  /\ initialBundleState = "Complete"
  /\ phase' = "RecoveryRecorded"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

InitialPublicationFailure ==
  /\ Normal
  /\ phase = "Planned"
  /\ initialBundleState = "Staged"
  /\ phase' = "Blocked"
  /\ initialBundleState' = "Failed"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  postWriteBundleState, recoveryVersions, observedLocalVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

ConcurrentEdit ==
  /\ Normal
  /\ ~editOccurred
  /\ phase \notin {"Idle", "Blocked", "Done"}
  /\ visible # LocalEdit
  /\ visible' = LocalEdit
  /\ observedLocalVersions' = observedLocalVersions \cup {LocalEdit}
  /\ editOccurred' = TRUE
  /\ UNCHANGED <<phase, running, recovering, crashCount, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, journalPresent>>

CanBeginWriting ==
  \/ phase = "RecoveryRecorded"
  \/ (~RequireRecoveryBeforeMutation /\ phase = "Planned")

BeginWriting ==
  /\ Normal
  /\ CanBeginWriting
  /\ phase' = "Writing"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

WriteTarget ==
  /\ Normal
  /\ phase = "Writing"
  /\ visible # Target
  /\ (~CheckFreshAtMutation \/ visible = preflight)
  /\ overwrittenVersions' = overwrittenVersions \cup {visible}
  /\ visible' = Target
  /\ UNCHANGED <<phase, running, recovering, crashCount, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

BlockChangedPath ==
  /\ Normal
  /\ CheckFreshAtMutation
  /\ phase = "Writing"
  /\ visible \notin {preflight, Target}
  /\ phase' = "Blocked"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecordFilesWritten ==
  /\ Normal
  /\ phase = "Writing"
  /\ visible = Target
  /\ phase' = "Verifying"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

StagePostWriteBundle ==
  /\ Normal
  /\ phase = "Writing"
  /\ visible = LocalEdit
  /\ Local0 \in overwrittenVersions
  /\ postWriteBundleState = "None"
  /\ postWriteBundleState' = "Staged"
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  initialBundleState, recoveryVersions, observedLocalVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

PublishPostWriteBundle ==
  /\ Normal
  /\ phase = "Writing"
  /\ visible = LocalEdit
  /\ postWriteBundleState = "Staged"
  /\ postWriteBundleState' = "Complete"
  /\ recoveryVersions' = recoveryVersions \cup {LocalEdit}
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  initialBundleState, gitVersions, observedLocalVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

RecordPostWritePreservation ==
  /\ Normal
  /\ phase = "Writing"
  /\ visible = LocalEdit
  /\ postWriteBundleState = "Complete"
  /\ phase' = "Verifying"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

PostWritePublicationFailure ==
  /\ Normal
  /\ phase = "Writing"
  /\ postWriteBundleState = "Staged"
  /\ phase' = "Blocked"
  /\ postWriteBundleState' = "Failed"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, recoveryVersions, observedLocalVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

MoveRefs ==
  /\ Normal
  /\ phase = "Verifying"
  /\ refsMain = Local0
  /\ refsMain' = Target
  /\ gitVersions' = {Target}
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  observedLocalVersions, overwrittenVersions,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecordRefsCommitted ==
  /\ Normal
  /\ phase = "Verifying"
  /\ refsMain = Target
  /\ phase' = "RefsCommitted"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

CommitCoordination ==
  /\ Normal
  /\ phase = "RefsCommitted"
  /\ coordinationMain = Local0
  /\ coordinationMain' = Target
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  ackIntentDurable, editOccurred, journalPresent>>

RecordCoordinationCommitted ==
  /\ Normal
  /\ phase = "RefsCommitted"
  /\ coordinationMain = Target
  /\ phase' = "CoordinationCommitted"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

PersistAckIntent ==
  /\ Normal
  /\ phase = "CoordinationCommitted"
  /\ ~ackIntentDurable
  /\ ackIntentDurable' = TRUE
  /\ UNCHANGED <<phase, running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, editOccurred, journalPresent>>

RecordAckIntent ==
  /\ Normal
  /\ phase = "CoordinationCommitted"
  /\ ackIntentDurable
  /\ phase' = "AckIntentPersisted"
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

Cleanup ==
  /\ Normal
  /\ \/ phase = "AckIntentPersisted"
     \/ (AllowEarlyCleanup /\ phase = "Writing")
  /\ phase' = "Done"
  /\ journalPresent' = FALSE
  /\ UNCHANGED <<running, recovering, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred>>

Crash ==
  /\ Normal
  /\ phase \notin {"Idle", "Blocked", "Done"}
  /\ crashCount < MaxCrashes
  /\ running' = FALSE
  /\ crashCount' = crashCount + 1
  /\ UNCHANGED <<phase, recovering, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

Restart ==
  /\ ~running
  /\ running' = TRUE
  /\ IF InferCompletionOnRestart /\ phase \in {"Writing", "Verifying"}
        THEN /\ phase' = "Done"
             /\ recovering' = FALSE
             /\ journalPresent' = FALSE
        ELSE /\ phase' = phase
             /\ recovering' = TRUE
             /\ journalPresent' = journalPresent
  /\ UNCHANGED <<crashCount, visible, preflight, initialBundleState,
                  postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred>>

RecoverPlannedUnpublished ==
  /\ running /\ recovering
  /\ phase = "Planned"
  /\ initialBundleState \in {"None", "Staged"}
  /\ visible = preflight
  /\ recovering' = FALSE
  /\ initialBundleState' = "None"
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
                  postWriteBundleState, recoveryVersions, observedLocalVersions,
                  gitVersions,
                  overwrittenVersions, refsMain, coordinationMain,
                  ackIntentDurable, editOccurred, journalPresent>>

RecoverPlannedPublished ==
  /\ running /\ recovering
  /\ phase = "Planned"
  /\ initialBundleState = "Complete"
  /\ visible = preflight
  /\ phase' = "RecoveryRecorded"
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverRecordedBeforeWrite ==
  /\ running /\ recovering
  /\ phase = "RecoveryRecorded"
  /\ visible = preflight
  /\ recovering' = FALSE
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverWritingBeforeWrite ==
  /\ running /\ recovering
  /\ phase = "Writing"
  /\ visible = preflight
  /\ recovering' = FALSE
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverFilesWritten ==
  /\ running /\ recovering
  /\ phase \in {"Writing", "RecoveryRecorded"}
  /\ visible = Target
  /\ phase' = "Verifying"
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverPreservedPostWrite ==
  /\ running /\ recovering
  /\ phase = "Writing"
  /\ visible = LocalEdit
  /\ postWriteBundleState = "Complete"
  /\ LocalEdit \in recoveryVersions
  /\ phase' = "Verifying"
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverVerifyingBeforeRefs ==
  /\ running /\ recovering
  /\ phase = "Verifying"
  /\ refsMain = Local0
  /\ visible \in {Target, LocalEdit}
  /\ (visible = Target \/ LocalEdit \in recoveryVersions)
  /\ recovering' = FALSE
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverMovedRefs ==
  /\ running /\ recovering
  /\ phase = "Verifying"
  /\ refsMain = Target
  /\ phase' = "RefsCommitted"
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverRefsCommitted ==
  /\ running /\ recovering
  /\ phase = "RefsCommitted"
  /\ refsMain = Target
  /\ IF coordinationMain = Target
        THEN phase' = "CoordinationCommitted"
        ELSE phase' = phase
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverCoordinationCommitted ==
  /\ running /\ recovering
  /\ phase = "CoordinationCommitted"
  /\ coordinationMain = Target
  /\ IF ackIntentDurable
        THEN phase' = "AckIntentPersisted"
        ELSE phase' = phase
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverAckIntent ==
  /\ running /\ recovering
  /\ phase = "AckIntentPersisted"
  /\ ackIntentDurable
  /\ recovering' = FALSE
  /\ UNCHANGED <<phase, running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

RecoverBlock ==
  /\ running /\ recovering
  /\ \/ phase = "Planned" /\ (visible # preflight \/ initialBundleState = "Failed")
     \/ phase = "RecoveryRecorded" /\ visible # preflight /\ visible # Target
     \/ phase = "Writing" /\ visible # preflight /\ visible # Target /\
          ~(visible = LocalEdit /\ postWriteBundleState = "Complete" /\ LocalEdit \in recoveryVersions)
     \/ phase = "Verifying" /\
          ~((refsMain = Target) \/ (refsMain = Local0 /\
            (visible = Target \/ (visible = LocalEdit /\ LocalEdit \in recoveryVersions))))
     \/ phase = "RefsCommitted" /\ refsMain # Target
     \/ phase = "CoordinationCommitted" /\ coordinationMain # Target
     \/ phase = "AckIntentPersisted" /\ ~ackIntentDurable
  /\ phase' = "Blocked"
  /\ recovering' = FALSE
  /\ UNCHANGED <<running, crashCount, visible, preflight,
                  initialBundleState, postWriteBundleState, recoveryVersions,
                  gitVersions,
                  observedLocalVersions, overwrittenVersions, refsMain,
                  coordinationMain, ackIntentDurable, editOccurred,
                  journalPresent>>

TerminalStutter ==
  /\ phase \in {"Blocked", "Done"}
  /\ UNCHANGED vars

Progress ==
  StartApply
  \/ StageInitialBundle
  \/ PublishInitialBundle
  \/ RecordRecoveryPublication
  \/ InitialPublicationFailure
  \/ BeginWriting
  \/ WriteTarget
  \/ BlockChangedPath
  \/ RecordFilesWritten
  \/ StagePostWriteBundle
  \/ PublishPostWriteBundle
  \/ RecordPostWritePreservation
  \/ PostWritePublicationFailure
  \/ MoveRefs
  \/ RecordRefsCommitted
  \/ CommitCoordination
  \/ RecordCoordinationCommitted
  \/ PersistAckIntent
  \/ RecordAckIntent
  \/ Cleanup
  \/ Restart
  \/ RecoverPlannedUnpublished
  \/ RecoverPlannedPublished
  \/ RecoverRecordedBeforeWrite
  \/ RecoverWritingBeforeWrite
  \/ RecoverFilesWritten
  \/ RecoverPreservedPostWrite
  \/ RecoverVerifyingBeforeRefs
  \/ RecoverMovedRefs
  \/ RecoverRefsCommitted
  \/ RecoverCoordinationCommitted
  \/ RecoverAckIntent
  \/ RecoverBlock

Next == Progress \/ ConcurrentEdit \/ Crash \/ TerminalStutter

SafetySpec == Init /\ [][Next]_vars
LiveSpec == SafetySpec /\ WF_vars(Progress)

TypeOK ==
  /\ phase \in Phases
  /\ running \in BOOLEAN
  /\ recovering \in BOOLEAN
  /\ crashCount \in 0..MaxCrashes
  /\ visible \in Versions
  /\ preflight \in Versions \cup {NoVersion}
  /\ initialBundleState \in BundleStates
  /\ postWriteBundleState \in BundleStates
  /\ recoveryVersions \subseteq LocalVersions
  /\ gitVersions \subseteq Versions
  /\ observedLocalVersions \subseteq LocalVersions
  /\ overwrittenVersions \subseteq LocalVersions
  /\ refsMain \in {Local0, Target}
  /\ coordinationMain \in {Local0, Target}
  /\ ackIntentDurable \in BOOLEAN
  /\ editOccurred \in BOOLEAN
  /\ journalPresent \in BOOLEAN

CapturedRecoverable == Rooted(Local0)

RecoveryBeforeMutation == overwrittenVersions \subseteq recoveryVersions

NoLocalVersionLost ==
  \A version \in observedLocalVersions: Rooted(version)

MixedStateDiscoverable ==
  phase \in {
    "Writing",
    "Verifying",
    "RefsCommitted",
    "CoordinationCommitted",
    "AckIntentPersisted"
  } => journalPresent /\ recoveryVersions # {}

NoFalseCompletion ==
  phase = "Done" =>
    /\ ~journalPresent
    /\ refsMain = Target
    /\ coordinationMain = Target
    /\ ackIntentDurable
    /\ \A version \in observedLocalVersions: Rooted(version)

InitialPublicationFailureIsNonDestructive ==
  phase = "Blocked" /\ initialBundleState = "Failed" => overwrittenVersions = {}

RestartClassifiesBeforeProgress == running /\ recovering => phase \notin {"Idle", "Done"}

Terminal == phase \in {"Blocked", "Done"}
ApplyStarted == phase # "Idle"
EventuallyTerminal == ApplyStarted ~> Terminal

=============================================================================
