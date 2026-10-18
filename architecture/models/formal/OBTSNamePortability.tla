---- MODULE OBTSNamePortability ----
EXTENDS Naturals, TLC

(***************************************************************************
OBTS-FM-017, architecture revision 58. Focused bounded refinement of
platform filename restrictions (OBTS-SYNC-NAME-001) and the server-authored
dashboard name repair (OBTS-DASH-NAME-001). One restricted device, one
optional concurrent canonical advance, one repair operation and one crash
after ref movement are explored. The restriction predicate, rename mapping,
and link rewriting are symbolic: "m0"/"m1" are canonical trees containing
unrepresentable paths and Repaired maps each to its deterministic portable
candidate. Concrete character, case-fold, collision-suffix and link-syntax
behavior require implementation regressions.
***************************************************************************)
CONSTANT FaultMode

BadMains == {"m0", "m1"}
Mains == BadMains \cup {"r0", "r1", "collided"}
NoId == "none"

Repaired(m) ==
  IF FaultMode = "CollidingMapping" THEN "collided"
  ELSE IF m = "m0" THEN "r0" ELSE "r1"

Portable(m) == m \in {"r0", "r1"}

VARIABLES main, advanced, preview, phase, operation,
          deviceMain, deviceFiles, deviceBlock, journal, lastAction
vars == <<main, advanced, preview, phase, operation,
          deviceMain, deviceFiles, deviceBlock, journal, lastAction>>
serverVars == <<main, advanced, preview, phase, operation>>
deviceVars == <<deviceMain, deviceFiles, deviceBlock, journal>>

Init ==
  /\ main = "m0"
  /\ advanced = FALSE
  /\ preview = NoId
  /\ phase = "idle"
  /\ operation = [main |-> NoId, tree |-> NoId]
  /\ deviceMain = NoId
  /\ deviceFiles = "local"
  /\ deviceBlock = "none"
  /\ journal = "none"
  /\ lastAction = "Init"

\* Another device publishes ordinary edits while names remain unrepaired.
AdvanceMain ==
  /\ ~advanced
  /\ main = "m0"
  /\ phase = "idle"
  /\ main' = "m1"
  /\ advanced' = TRUE
  /\ UNCHANGED <<preview, phase, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "AdvanceMain"

\* The restricted device evaluates the whole target before any local effect.
DeviceSync ==
  /\ deviceBlock \in {"none", "unportable"}
  /\ deviceMain # main
  /\ IF Portable(main)
       THEN /\ deviceMain' = main
            /\ deviceFiles' = "target"
            /\ deviceBlock' = "none"
            /\ UNCHANGED journal
       ELSE /\ deviceBlock' = "unportable"
            /\ UNCHANGED <<deviceMain, deviceFiles, journal>>
  /\ FaultMode # "LateCheck" \/ Portable(main)
  /\ UNCHANGED serverVars
  /\ lastAction' = "DeviceSync"

\* Mutation: discovering unrepresentable names only while writing files.
UnsafeLateCheckSync ==
  /\ FaultMode = "LateCheck"
  /\ deviceBlock \in {"none", "unportable"}
  /\ deviceMain # main
  /\ ~Portable(main)
  /\ journal' = "writing"
  /\ deviceFiles' = "partial"
  /\ deviceBlock' = "recovery_required"
  /\ UNCHANGED deviceMain
  /\ UNCHANGED serverVars
  /\ lastAction' = "UnsafeLateCheckSync"

PreviewRepair ==
  /\ phase = "idle"
  /\ ~Portable(main)
  /\ preview # main
  /\ preview' = main
  /\ UNCHANGED <<main, advanced, phase, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "PreviewRepair"

\* Apply recomputes the reviewed outcome under the vault lock.
PrepareRepair ==
  /\ phase = "idle"
  /\ preview = main
  /\ ~Portable(main)
  /\ operation' = [main |-> main, tree |-> Repaired(main)]
  /\ phase' = "prepared"
  /\ UNCHANGED <<main, advanced, preview>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "PrepareRepair"

\* Mutation: trusting a reviewed fingerprint after main advanced.
UnsafePrepareStaleRepair ==
  /\ FaultMode = "StaleRepairSave"
  /\ phase = "idle"
  /\ preview \in BadMains
  /\ preview # main
  /\ operation' = [main |-> preview, tree |-> Repaired(preview)]
  /\ phase' = "prepared"
  /\ UNCHANGED <<main, advanced, preview>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "UnsafePrepareStaleRepair"

MoveRepairRef ==
  /\ phase = "prepared"
  /\ main = operation.main
  /\ main' = operation.tree
  /\ phase' = "ref-moved"
  /\ UNCHANGED <<advanced, preview, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "MoveRepairRef"

CommitRepair ==
  /\ phase = "ref-moved"
  /\ phase' = "committed"
  /\ UNCHANGED <<main, advanced, preview, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "CommitRepair"

CrashAfterRepairRefMove ==
  /\ phase = "ref-moved"
  /\ phase' = "recovering"
  /\ UNCHANGED <<main, advanced, preview, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "CrashAfterRepairRefMove"

RecoverRepair ==
  /\ phase = "recovering"
  /\ main = operation.tree
  /\ phase' = "committed"
  /\ UNCHANGED <<main, advanced, preview, operation>>
  /\ UNCHANGED deviceVars
  /\ lastAction' = "RecoverRepair"

Settled ==
  /\ phase = "committed"
  /\ (deviceMain = main \/ deviceBlock = "recovery_required")
  /\ UNCHANGED vars

Next ==
  \/ AdvanceMain
  \/ DeviceSync
  \/ UnsafeLateCheckSync
  \/ PreviewRepair
  \/ PrepareRepair
  \/ UnsafePrepareStaleRepair
  \/ MoveRepairRef
  \/ CommitRepair
  \/ CrashAfterRepairRefMove
  \/ RecoverRepair
  \/ Settled

TypeOK ==
  /\ main \in Mains
  /\ advanced \in BOOLEAN
  /\ preview \in Mains \cup {NoId}
  /\ phase \in {"idle", "prepared", "ref-moved", "recovering", "committed"}
  /\ operation \in [main: Mains \cup {NoId}, tree: Mains \cup {NoId}]
  /\ deviceMain \in Mains \cup {NoId}
  /\ deviceFiles \in {"local", "partial", "target"}
  /\ deviceBlock \in {"none", "unportable", "recovery_required"}
  /\ journal \in {"none", "writing"}
  /\ lastAction \in STRING

UnportableTargetNeverJournaled == journal = "none" /\ deviceFiles # "partial"
DeviceAppliesOnlyPortable == deviceMain # NoId => Portable(deviceMain)
BlockLeavesLocalUntouched == deviceBlock = "unportable" => deviceFiles = "local" /\ deviceMain = NoId
NeverRecoveryRequired == deviceBlock # "recovery_required"
PreparedRepairCurrent == phase = "prepared" => operation.main = main
RepairTreePinned == phase # "idle" => operation.tree = Repaired(operation.main)
RepairedMainPortable == phase = "committed" => Portable(main)
NeverBlocked == deviceBlock # "unportable"

FairSpec ==
  Init /\ [][Next]_vars
  /\ WF_vars(DeviceSync)
  /\ WF_vars(PreviewRepair)
  /\ WF_vars(PrepareRepair)
  /\ WF_vars(MoveRepairRef)
  /\ WF_vars(CommitRepair)
  /\ WF_vars(RecoverRepair)
EventuallyDeviceSynced == <> (phase = "committed" /\ deviceMain = main /\ deviceBlock = "none")

Spec == Init /\ [][Next]_vars
====
