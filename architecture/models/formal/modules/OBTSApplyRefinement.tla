---- MODULE OBTSApplyRefinement ----
EXTENDS TLC

(***************************************************************************
OBTS-FM-002 local-apply abstraction boundary to OBTS-FM-001.

The distributed model keeps network, server, directory, and Bridge activity
outside this vocabulary. For one selected client/path, the phase projection is:
  Idle                 -> Idle
  Planned              -> Planned
  RecoveryPublished    -> RecoveryRecorded
  Writing              -> Writing
  Verifying            -> Verifying
  RefsCommitted        -> RefsCommitted
  CoordinationCommitted-> CoordinationCommitted
  AckIntent            -> AckIntentPersisted
  Cleaned              -> Done
  Blocked              -> Blocked

ApplyBoundaryOK is checked by the root model. It establishes the explicit
state-refinement seam; OBTS-FM-001 remains independently checked as the leaf
apply/recovery proof and is not replaced by this module.
***************************************************************************)

ApplyPhases == {
  "Idle", "Planned", "RecoveryPublished", "Writing", "Verifying",
  "RefsCommitted", "CoordinationCommitted", "AckIntent", "Cleaned",
  "Blocked"
}

FM001Phase(phase) ==
  CASE phase = "RecoveryPublished" -> "RecoveryRecorded"
    [] phase = "AckIntent" -> "AckIntentPersisted"
    [] phase = "Cleaned" -> "Done"
    [] OTHER -> phase

ApplyBoundaryOK(phase, journalPresent, recoveryPublished, durableApplied,
                ackIntentDurable) ==
  /\ phase \in ApplyPhases
  /\ (phase \in {"Planned", "RecoveryPublished", "Writing", "Verifying",
                  "RefsCommitted", "CoordinationCommitted", "AckIntent"}
      => journalPresent)
  /\ (phase \in {"Writing", "Verifying", "RefsCommitted",
                  "CoordinationCommitted", "AckIntent", "Cleaned"}
      => recoveryPublished)
  /\ (phase \in {"CoordinationCommitted", "AckIntent", "Cleaned"}
      => durableApplied)
  /\ (phase = "Cleaned" => ackIntentDurable /\ ~journalPresent)

=============================================================================
