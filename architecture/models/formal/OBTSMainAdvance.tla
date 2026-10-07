---- MODULE OBTSMainAdvance ----
EXTENDS Naturals, TLC

(***************************************************************************
OBTS-FM-002 canonical commit selection companion, architecture revision 48.
Refines OBTS-SYNC-IMM-001 and OBTS-PER-OP-001. The composed distributed model
tracks preserved versions rather than exact commit identity. This companion
checks the identity choice without widening that model's state space.

The proposal is already admitted and policy integration has computed its
result tree. Shape summarizes immutable facts: exactly one proposal parent,
that parent equals the serialized current main, and proposal/result trees
are equal. No shortcut bypasses integration or its policy validation.

Preparing a durable target, CAS publication, and result publication retain
the existing order. One crash can interrupt any boundary; restart uses the
same durable target. Vault serialization and CAS failure/integrity recovery
remain covered by the composed model; byte equality and Git parent parsing
are implementation obligations. A fresh device commit may have the same
file tree as old main and is still a new canonical identity.
***************************************************************************)
CONSTANTS IgnoreParentGuard, IgnoreTreeGuard
ASSUME IgnoreParentGuard \in BOOLEAN /\ IgnoreTreeGuard \in BOOLEAN

VARIABLES shape, phase, target, main, running, crashed, crashPhase
vars == <<shape, phase, target, main, running, crashed, crashPhase>>
Phases == {"idle", "prepared", "applied", "committed"}
Eligible == shape.soleParent /\ shape.currentParent /\ shape.sameTree
Selected == IF (IgnoreParentGuard \/ (shape.soleParent /\ shape.currentParent))
               /\ (IgnoreTreeGuard \/ shape.sameTree)
            THEN "device" ELSE "merge"

Init ==
  /\ shape \in [soleParent : BOOLEAN, currentParent : BOOLEAN, sameTree : BOOLEAN]
  /\ phase = "idle"
  /\ target = "none"
  /\ main = "old"
  /\ running = TRUE
  /\ crashed = FALSE
  /\ crashPhase = "none"

Prepare ==
  /\ running /\ phase = "idle"
  /\ target' = Selected
  /\ phase' = "prepared"
  /\ UNCHANGED <<shape, main, running, crashed, crashPhase>>

Advance ==
  /\ running /\ phase = "prepared"
  /\ main = "old"
  /\ main' = target
  /\ phase' = "applied"
  /\ UNCHANGED <<shape, target, running, crashed, crashPhase>>

Publish ==
  /\ running /\ phase = "applied"
  /\ main = target
  /\ phase' = "committed"
  /\ UNCHANGED <<shape, target, main, running, crashed, crashPhase>>

Crash ==
  /\ running /\ ~crashed /\ phase # "committed"
  /\ running' = FALSE
  /\ crashed' = TRUE
  /\ crashPhase' = phase
  /\ UNCHANGED <<shape, phase, target, main>>

Restart ==
  /\ ~running
  /\ running' = TRUE
  /\ UNCHANGED <<shape, phase, target, main, crashed, crashPhase>>

Next == Prepare \/ Advance \/ Publish \/ Crash \/ Restart
        \/ (phase = "committed" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Prepare) /\ WF_vars(Advance)
                 /\ WF_vars(Publish) /\ WF_vars(Restart)

TypeOK ==
  /\ shape \in [soleParent : BOOLEAN, currentParent : BOOLEAN, sameTree : BOOLEAN]
  /\ phase \in Phases
  /\ target \in {"none", "device", "merge"}
  /\ main \in {"old", "device", "merge"}
  /\ running \in BOOLEAN /\ crashed \in BOOLEAN
  /\ crashPhase \in Phases \cup {"none"}
ParentGuard == main = "device" => shape.soleParent /\ shape.currentParent
TreeGuard == main = "device" => shape.sameTree
PreparedBeforeAdvance == main # "old" => target = main /\ phase \in {"applied", "committed"}
EligibleUsesDevice == phase = "committed" /\ Eligible => main = "device"
EventuallyCommitted == <> (phase = "committed")

NoFastForward == main # "device"
NoMergeFallback == main # "merge"
NoRecoveredPublication == ~(phase = "committed" /\ crashPhase = "applied")

CompanionActions == {
  "Prepare",
  "Advance",
  "Publish",
  "Crash",
  "Restart"
}
=============================================================================
