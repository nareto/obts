---- MODULE OBTSApplyJournalHeal ----
EXTENDS Naturals, TLC

(***************************************************************************
FM001 companion; architecture revision 72.
Refines OBTS-PER-JOURNAL-001 and the preservation obligations of
OBTS-SAF-001, OBTS-SAF-002 and OBTS-SAF-005.

One client, one apply, one affected path, one complete candidate bundle,
at most one crash, and corruption injectable at every durable phase including
the committed tail. Values are symbolic content bytes; the durable phase is
the journal's phase, the tear phase is model evidence, and the active journal
file is either readable, unreadable, or absent.

The model separates the containment order the contract requires: unreadable
bytes are copied, flushed, re-read and verified before the active journal may
be replaced or removed. Reconstruction is identity-bound to a durable apply
carrier, lands at the file-writing phase, and ignores the copy's phase and
claimed step; existing byte classification then finishes the apply. The
no-bundle branch retires a journal only under the no-visible-mutation proof
and requests one full inventory; an empty-directory intent applied without a
bundle is the named residual and is not treated as a file mutation.

A carrier qualifies only while the window it names is still open. A completed
apply can leave its stale-provenance horizon and its verified bundle behind, so
`PriorApplySettled` models that residue: it must never authorize reconstruction
of the interrupted window, and it must not block retirement either. Retirement
additionally needs the window's own durable identity, which is the apply lock:
`TearLock` models the lock lost in the same no-fsync window as the journal, and
a window identified only by weaker carriers may still be reconstructed but can
never be proven empty. Reconstruction itself repairs that tear: the
reconstructed journal owns the window again, so its identity-less marker is
replaced and the resume is not rejected by the lock protocol that follows.

PublishBundle means the bundle manifest, snapshots, journal copy, checksum
manifest and completion marker are flushed and verify after restart, as in
OBTS-FM-001. The model does not prove filesystem atomicity, checksum
implementation, adapter behaviour, or production conformance. Quarantine and
journal replacement share the host barrier; a second loss in the same window
is outside the model.
***************************************************************************)

CONSTANTS QuarantineFirst, BundleIdentityChecked, PhaseFromEvidence,
          RetireNeedsProof, RetireNeedsLock, SettledCarrierQualifies, MaxCrashes
ASSUME QuarantineFirst \in BOOLEAN
ASSUME BundleIdentityChecked \in BOOLEAN
ASSUME PhaseFromEvidence \in BOOLEAN
ASSUME RetireNeedsProof \in BOOLEAN
ASSUME RetireNeedsLock \in BOOLEAN
ASSUME SettledCarrierQualifies \in BOOLEAN
ASSUME MaxCrashes \in Nat

Local0 == "local-0"
LocalEdit == "local-edit"
Target == "target"

Versions == {Local0, LocalEdit, Target}
LocalVersions == {Local0, LocalEdit}

ActiveAbsent == "absent"
ActiveReadable == "readable"
ActiveTorn == "torn"
ActiveStates == {ActiveAbsent, ActiveReadable, ActiveTorn}

NoBundle == "none"
ApplyId == "A"
OtherId == "B"
SettledId == "S"

NoCarrier == "none"

LockHeld == "held"
LockTorn == "torn"

SelectionUnattempted == "unattempted"
SelectionAbsent == "absent"
SelectionInvalid == "invalid"
Selections == {SelectionUnattempted, SelectionAbsent, SelectionInvalid, ApplyId, OtherId, SettledId}

QuarantineNone == "none"
QuarantineStaged == "staged"
QuarantineVerified == "verified"
QuarantineStates == {QuarantineNone, QuarantineStaged, QuarantineVerified}

NoRecon == "none"
Phases == {"idle", "planned", "recoveryRecorded", "writing", "verifying",
           "refsCommitted", "done"}

VARIABLE s
vars == <<s>>

Acting == ~s.latched /\ ~s.retired /\ ~s.rebuilt

Init ==
  s = [running |-> TRUE, crashes |-> 0, phase |-> "idle",
       active |-> ActiveAbsent, activePhase |-> "none",
       bundle |-> NoBundle, bundleStaged |-> FALSE, copyPhase |-> "none",
       carrier |-> NoCarrier, lock |-> LockTorn,
       selection |-> SelectionUnattempted,
       lingering |-> FALSE,
       validationOk |-> FALSE, quarantine |-> QuarantineNone,
       activeTouched |-> FALSE, reconPhase |-> NoRecon,
       reconstructed |-> FALSE, retired |-> FALSE, rebuilt |-> FALSE,
       latched |-> FALSE, inventory |-> FALSE,
       visible |-> Local0, displaced |-> FALSE, overwritten |-> {},
       observed |-> {Local0}, preserved |-> {}, queued |-> FALSE,
       gitVersions |-> {Local0}, refs |-> Local0, coordination |-> Local0,
       ack |-> FALSE, edited |-> FALSE, dirIntent |-> FALSE]

(***************************************************************************
Forward apply. The apply lock that carries the apply identity is durable
before the journal, so the carrier exists from StartApply onward.
***************************************************************************)

StartApply ==
  /\ s.running /\ s.phase = "idle"
  /\ Acting
  /\ s' = [s EXCEPT !.phase = "planned", !.active = ActiveReadable,
             !.carrier = ApplyId, !.lock = LockHeld]

StageBundle ==
  /\ s.running /\ s.phase = "planned" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.bundle = NoBundle /\ ~s.bundleStaged
  /\ s' = [s EXCEPT !.bundleStaged = TRUE]

PublishBundle ==
  /\ s.running /\ s.phase = "planned" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.bundle = NoBundle /\ s.bundleStaged
  /\ s' = [s EXCEPT !.bundleStaged = FALSE, !.bundle = ApplyId,
             !.copyPhase = "planned",
             !.preserved = s.preserved \cup {Local0}]

RecordRecovery ==
  /\ s.running /\ s.phase = "planned" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.bundle = ApplyId
  /\ s' = [s EXCEPT !.phase = "recoveryRecorded"]

CanBeginWriting ==
  \/ s.phase = "recoveryRecorded"
  \/ s.phase = "planned" /\ s.bundle # NoBundle

BeginWriting ==
  /\ s.running /\ s.active = ActiveReadable /\ CanBeginWriting
  /\ Acting
  /\ s' = [s EXCEPT !.phase = "writing"]

WriteTarget ==
  /\ s.running /\ s.phase = "writing" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.visible = Local0 /\ Local0 \in s.preserved
  /\ s' = [s EXCEPT !.visible = Target, !.displaced = TRUE,
             !.overwritten = s.overwritten \cup {Local0}]

PreserveChangedBytes ==
  /\ s.running /\ s.phase \in {"writing", "verifying"}
  /\ s.active = ActiveReadable
  /\ Acting
  /\ s.visible = LocalEdit
  /\ s' = [s EXCEPT !.preserved = s.preserved \cup {LocalEdit},
             !.queued = TRUE, !.phase = "verifying"]

CompleteWrites ==
  /\ s.running /\ s.phase = "writing" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.visible = Target
  /\ s' = [s EXCEPT !.phase = "verifying"]

AdvanceRefs ==
  /\ s.running /\ s.phase = "verifying" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.refs = Local0
  /\ (s.visible = Target \/ LocalEdit \in s.preserved)
  /\ s' = [s EXCEPT !.refs = Target, !.gitVersions = {Target}]

RecordRefsCommitted ==
  /\ s.running /\ s.phase = "verifying" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.refs = Target
  /\ s' = [s EXCEPT !.phase = "refsCommitted"]

CommitCoordination ==
  /\ s.running /\ s.phase = "refsCommitted" /\ s.coordination = Local0
  /\ Acting
  /\ s' = [s EXCEPT !.coordination = Target]

PreserveLocalWork ==
  /\ s.running /\ s.phase = "refsCommitted" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.visible = LocalEdit /\ LocalEdit \notin s.preserved
  /\ s' = [s EXCEPT !.preserved = s.preserved \cup {LocalEdit},
             !.queued = TRUE]

WriteAck ==
  /\ s.running /\ s.phase = "refsCommitted" /\ ~s.ack
  /\ Acting
  /\ s.coordination = Target
  /\ (s.visible = Target \/ LocalEdit \in s.preserved)
  /\ s' = [s EXCEPT !.ack = TRUE]

ClearJournal ==
  /\ s.running /\ s.phase = "refsCommitted" /\ s.ack
  /\ Acting
  /\ (s.visible = Target \/ s.queued)
  /\ s' = [s EXCEPT !.phase = "done", !.active = ActiveAbsent]

(***************************************************************************
A bundle-less apply affects no file path. Its empty-directory intent is the
named residual of the no-visible-mutation proof; it is compressed into one
completion action because this companion bounds journal containment, not the
ordinary directory-only tail.
***************************************************************************)

ApplyDirectoryIntent ==
  /\ s.running /\ s.phase = "planned" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.bundle = NoBundle
  /\ s' = [s EXCEPT !.dirIntent = TRUE]

CompleteDirectoryOnlyApply ==
  /\ s.running /\ s.phase = "planned" /\ s.active = ActiveReadable
  /\ Acting
  /\ s.bundle = NoBundle /\ s.dirIntent
  /\ s' = [s EXCEPT !.refs = Target, !.coordination = Target,
             !.gitVersions = {Target}, !.ack = TRUE, !.phase = "done",
             !.active = ActiveAbsent]

(***************************************************************************
One concurrent local edit, only inside an apply that owns a bundle. Crash and
corruption are separate so the tear is injectable at every durable phase.
***************************************************************************)

ConcurrentEdit ==
  /\ s.running /\ ~s.edited /\ s.active = ActiveReadable
  /\ s.bundle # NoBundle
  /\ s.visible # LocalEdit
  /\ s' = [s EXCEPT !.visible = LocalEdit,
             !.observed = s.observed \cup {LocalEdit}, !.edited = TRUE]

\* The lock tears in the same no-fsync window as the journal. Its identity is
\* then unreadable, which removes the only carrier a retirement may rely on
\* without removing the weaker carriers a reconstruction may use.
TearLock ==
  /\ ~s.running /\ s.lock = LockHeld
  /\ s.phase \notin {"idle", "done"}
  /\ s' = [s EXCEPT !.lock = LockTorn]

\* A previous apply settled and left its stale-provenance horizon and verified
\* bundle in the vault. Its base predates this window's local state, which is
\* what the implementation's carrier condition checks; the model records only
\* that the residue exists.
PriorApplySettled ==
  /\ s.running /\ s.phase = "idle" /\ ~s.lingering
  /\ s' = [s EXCEPT !.lingering = TRUE]

Crash ==
  /\ s.running /\ s.crashes < MaxCrashes
  /\ s.phase \notin {"idle", "done"}
  /\ ~s.retired /\ ~s.latched /\ ~s.rebuilt
  /\ s' = [s EXCEPT !.running = FALSE, !.crashes = s.crashes + 1]

CorruptJournal ==
  /\ ~s.running /\ s.active = ActiveReadable
  /\ s' = [s EXCEPT !.active = ActiveTorn, !.activePhase = s.phase]

Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE]

(***************************************************************************
Containment and reconstruction. Copy, barrier and digest verification are two
durable steps so a loss between them cannot authorize replacing the journal.
***************************************************************************)

ForeignBundleAvailable ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.bundle = NoBundle
  /\ s' = [s EXCEPT !.bundle = OtherId, !.copyPhase = "planned"]

StageQuarantine ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.quarantine = QuarantineNone
  /\ s' = [s EXCEPT !.quarantine = QuarantineStaged]

VerifyQuarantine ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.quarantine = QuarantineStaged
  /\ s' = [s EXCEPT !.quarantine = QuarantineVerified]

QuarantineReady ==
  \/ s.quarantine = QuarantineVerified
  \/ ~QuarantineFirst

IdentityQualifies ==
  \/ s.bundle = ApplyId
  \/ ~BundleIdentityChecked /\ s.bundle = OtherId

\* The residue of a settled earlier apply is never this window's identity: its
\* recorded base predates the current local state, so it cannot qualify.
SettledQualifies ==
  SettledCarrierQualifies /\ s.lingering

SemanticQualifies ==
  \/ IdentityQualifies /\ s.bundle # NoBundle
  \/ SettledQualifies

SelectCandidate ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.selection = SelectionUnattempted
  /\ \/ /\ IdentityQualifies /\ s.bundle # NoBundle
        /\ \/ /\ s' = [s EXCEPT !.selection = s.bundle, !.validationOk = TRUE]
           \/ /\ s' = [s EXCEPT !.selection = SelectionInvalid, !.validationOk = FALSE]
     \/ /\ ~IdentityQualifies /\ SettledQualifies
        /\ \/ /\ s' = [s EXCEPT !.selection = SettledId, !.validationOk = TRUE]
           \/ /\ s' = [s EXCEPT !.selection = SelectionInvalid, !.validationOk = FALSE]
     \/ /\ ~SemanticQualifies
        /\ s' = [s EXCEPT !.selection = SelectionAbsent, !.validationOk = FALSE]

ReconstructJournal ==
  /\ s.running /\ s.active = ActiveTorn
  /\ ~s.latched /\ ~s.retired /\ ~s.rebuilt
  /\ s.selection \in {ApplyId, OtherId, SettledId} /\ s.validationOk
  /\ QuarantineReady
  /\ s' = [s EXCEPT !.active = ActiveReadable, !.activeTouched = TRUE,
             !.reconstructed = TRUE,
             !.lock = LockHeld,
             !.reconPhase = IF PhaseFromEvidence THEN "writing" ELSE s.copyPhase,
             !.phase = IF PhaseFromEvidence THEN "writing" ELSE s.copyPhase]

WriteFromCopiedStep ==
  /\ s.running /\ s.phase = "writing" /\ s.reconPhase = "planned"
  /\ s.visible # Target
  /\ s' = [s EXCEPT !.visible = Target,
             !.overwritten = s.overwritten \cup {s.visible}]

ProveNoVisibleMutation ==
  /\ s.bundle \in {NoBundle, OtherId}
  /\ s.refs = Local0
  /\ s.coordination = Local0
  /\ ~s.displaced
  /\ s.overwritten = {}
  /\ ~s.ack

RetireJournal ==
  /\ s.running /\ s.active = ActiveTorn
  /\ ~s.latched /\ ~s.retired /\ ~s.rebuilt
  /\ s.selection # SelectionUnattempted
  /\ QuarantineReady
  /\ (RetireNeedsProof => ProveNoVisibleMutation)
  /\ (RetireNeedsLock => s.lock = LockHeld)
  /\ s' = [s EXCEPT !.retired = TRUE, !.active = ActiveAbsent,
             !.activeTouched = TRUE, !.inventory = TRUE, !.latched = FALSE]

BlockJournal ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.selection \in {SelectionAbsent, SelectionInvalid}
  /\ QuarantineReady
  /\ s' = [s EXCEPT !.latched = TRUE]

UserRebuildPastJournal ==
  /\ s.running /\ s.active = ActiveTorn
  /\ s.selection # SelectionUnattempted
  /\ QuarantineReady
  /\ s' = [s EXCEPT !.rebuilt = TRUE, !.active = ActiveAbsent,
             !.activeTouched = TRUE,
             !.preserved = s.preserved \cup {s.visible},
             !.queued = TRUE, !.latched = FALSE, !.inventory = TRUE]

(***************************************************************************
Schedule and properties.
***************************************************************************)

Terminal ==
  \/ s.phase = "done"
  \/ s.retired \/ s.latched \/ s.rebuilt

TerminalStutter ==
  Terminal /\ UNCHANGED s

Progress ==
  StartApply \/ StageBundle \/ PublishBundle \/ RecordRecovery \/ BeginWriting
  \/ ApplyDirectoryIntent \/ CompleteDirectoryOnlyApply
  \/ WriteTarget \/ PreserveChangedBytes \/ CompleteWrites \/ AdvanceRefs
  \/ RecordRefsCommitted \/ CommitCoordination \/ PreserveLocalWork \/ WriteAck
  \/ ClearJournal \/ StageQuarantine \/ VerifyQuarantine \/ SelectCandidate
  \/ ReconstructJournal \/ WriteFromCopiedStep \/ RetireJournal \/ BlockJournal
  \/ UserRebuildPastJournal \/ Restart

Environment ==
  ConcurrentEdit \/ ForeignBundleAvailable \/ PriorApplySettled \/ TearLock

Next ==
  Progress \/ Environment \/ Crash \/ CorruptJournal \/ TerminalStutter

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Progress)

Rooted(version) ==
  \/ s.visible = version
  \/ version \in s.preserved
  \/ version \in s.gitVersions

TypeOK ==
  /\ s.running \in BOOLEAN /\ s.crashes \in 0..MaxCrashes
  /\ s.phase \in Phases
  /\ s.active \in ActiveStates /\ s.activePhase \in Phases \cup {"none"}
  /\ s.bundle \in {NoBundle, ApplyId, OtherId}
  /\ s.bundleStaged \in BOOLEAN
  /\ s.copyPhase \in {"none", "planned"}
  /\ s.carrier \in {NoCarrier, ApplyId}
  /\ s.lock \in {LockHeld, LockTorn}
  /\ s.lingering \in BOOLEAN
  /\ s.selection \in Selections /\ s.validationOk \in BOOLEAN
  /\ s.quarantine \in QuarantineStates /\ s.activeTouched \in BOOLEAN
  /\ s.reconPhase \in {"none", "planned", "writing"}
  /\ s.reconstructed \in BOOLEAN /\ s.retired \in BOOLEAN
  /\ s.rebuilt \in BOOLEAN /\ s.latched \in BOOLEAN
  /\ s.inventory \in BOOLEAN
  /\ s.visible \in Versions /\ s.displaced \in BOOLEAN
  /\ s.overwritten \subseteq LocalVersions
  /\ s.observed \subseteq LocalVersions
  /\ s.preserved \subseteq Versions /\ s.queued \in BOOLEAN
  /\ s.gitVersions \subseteq Versions
  /\ s.refs \in {Local0, Target} /\ s.coordination \in {Local0, Target}
  /\ s.ack \in BOOLEAN /\ s.edited \in BOOLEAN /\ s.dirIntent \in BOOLEAN

NoLocalVersionLost ==
  \A version \in s.observed: Rooted(version)

NoBlindOverwrite ==
  s.overwritten \subseteq s.preserved

CorruptBytesPreserved ==
  s.activeTouched => s.quarantine = QuarantineVerified

ReconstructOnlyMatchingBundle ==
  s.reconstructed => s.carrier # NoCarrier /\ s.selection = s.carrier

PhaseDerivedFromEvidence ==
  s.reconstructed => s.reconPhase = "writing"

\* The reconstructed journal owns the window again, so the tear's own
\* identity-less marker is replaced before the resume asks for the lock.
ReconstructRepairsLock ==
  s.reconstructed => s.lock = LockHeld

NoRetireWithoutProof ==
  s.retired => ProveNoVisibleMutation

NoRetireWithoutLockIdentity ==
  s.retired => s.lock = LockHeld

RetireRequestsInventory ==
  s.retired => s.inventory

BlockKeepsEvidence ==
  s.latched =>
    /\ s.active = ActiveTorn
    /\ s.quarantine = QuarantineVerified
    /\ ~s.reconstructed /\ ~s.retired /\ ~s.rebuilt

NoFalseCompletion ==
  s.phase = "done" =>
    /\ s.active = ActiveAbsent
    /\ s.refs = Target
    /\ s.coordination = Target
    /\ s.ack
    /\ \A version \in s.observed: Rooted(version)

CompletionQueuesPreservedWork ==
  s.phase = "done" /\ s.visible = LocalEdit => s.queued

Safety ==
  /\ TypeOK
  /\ NoLocalVersionLost
  /\ NoBlindOverwrite
  /\ CorruptBytesPreserved
  /\ ReconstructOnlyMatchingBundle
  /\ PhaseDerivedFromEvidence
  /\ ReconstructRepairsLock
  /\ NoRetireWithoutProof
  /\ NoRetireWithoutLockIdentity
  /\ RetireRequestsInventory
  /\ BlockKeepsEvidence
  /\ NoFalseCompletion
  /\ CompletionQueuesPreservedWork

NoResume == ~s.reconstructed
NoRetirement == ~s.retired
NoRetireWithHistory == ~(s.retired /\ s.lingering)
NoBlock == ~s.latched
NoCommittedTailRecovery ==
  ~(s.activePhase = "refsCommitted" /\ s.reconstructed /\ s.ack /\ s.phase = "done")

ApplyStarted == s.phase # "idle"
EventuallyTerminal == ApplyStarted ~> Terminal

CompanionActions == {
  "StartApply",
  "StageBundle",
  "PublishBundle",
  "RecordRecovery",
  "BeginWriting",
  "WriteTarget",
  "PreserveChangedBytes",
  "CompleteWrites",
  "AdvanceRefs",
  "RecordRefsCommitted",
  "CommitCoordination",
  "PreserveLocalWork",
  "WriteAck",
  "ClearJournal",
  "ApplyDirectoryIntent",
  "CompleteDirectoryOnlyApply",
  "ConcurrentEdit",
  "PriorApplySettled",
  "TearLock",
  "Crash",
  "CorruptJournal",
  "Restart",
  "ForeignBundleAvailable",
  "StageQuarantine",
  "VerifyQuarantine",
  "SelectCandidate",
  "ReconstructJournal",
  "WriteFromCopiedStep",
  "RetireJournal",
  "BlockJournal",
  "UserRebuildPastJournal"
}

=============================================================================
