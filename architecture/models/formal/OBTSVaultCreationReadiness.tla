----------------------- MODULE OBTSVaultCreationReadiness -----------------------
(***************************************************************************)
(* OBTS-PER-READY-001: one vault creation races one readiness check.        *)
(* Creation reserves the vault ID before the repository path exists,        *)
(* initializes the repository (partial, then complete), commits the vault   *)
(* row and only then releases the reservation; it may instead fail at any   *)
(* point before the commit and release. Readiness snapshots metadata,       *)
(* enumerates the repository, then concludes against metadata read after    *)
(* the enumeration. The enumeration reads repository existence and the      *)
(* reservation at one instant; in the implementation existence is observed  *)
(* first and only grows here, so reading the reservation later is no weaker.*)
(***************************************************************************)
EXTENDS TLC

CONSTANTS Mutation
ASSUME Mutation \in {"none", "no-reservation", "no-skip", "no-recheck",
                     "early-release", "leak-reservation", "ignore-unknown"}

VARIABLES creator, repo, meta, reserved, check, snap, listed, verdict, orphanAtStart
vars == <<creator, repo, meta, reserved, check, snap, listed, verdict, orphanAtStart>>
creatorVars == <<creator, repo, meta, reserved>>
checkVars == <<check, snap, listed, verdict, orphanAtStart>>

Init ==
  /\ creator = "idle"
  /\ repo = "absent"
  /\ meta = FALSE
  /\ reserved = FALSE
  /\ check = "idle"
  /\ snap = FALSE
  /\ listed = "none"
  /\ verdict = "none"
  /\ orphanAtStart = FALSE

Reserve == creator = "idle" /\ creator' = "reserved" /\ reserved' = (Mutation # "no-reservation") /\ UNCHANGED <<repo, meta>> /\ UNCHANGED checkVars
InitPartial == creator = "reserved" /\ creator' = "initializing" /\ repo' = "partial" /\ UNCHANGED <<meta, reserved>> /\ UNCHANGED checkVars
InitDone == creator = "initializing" /\ creator' = "initialized" /\ repo' = "present" /\ UNCHANGED <<meta, reserved>> /\ UNCHANGED checkVars
Commit == creator = "initialized" /\ Mutation # "early-release" /\ creator' = "committed" /\ meta' = TRUE /\ UNCHANGED <<repo, reserved>> /\ UNCHANGED checkVars
Release == creator = "committed" /\ creator' = "done" /\ reserved' = FALSE /\ UNCHANGED <<repo, meta>> /\ UNCHANGED checkVars
ReleaseEarly == creator = "initialized" /\ Mutation = "early-release" /\ creator' = "released_early" /\ reserved' = FALSE /\ UNCHANGED <<repo, meta>> /\ UNCHANGED checkVars
CommitAfterRelease == creator = "released_early" /\ creator' = "done" /\ meta' = TRUE /\ UNCHANGED <<repo, reserved>> /\ UNCHANGED checkVars
Fail == creator \in {"reserved", "initializing", "initialized"} /\ creator' = "failed" /\ reserved' = (Mutation = "leak-reservation" /\ reserved) /\ UNCHANGED <<repo, meta>> /\ UNCHANGED checkVars

StartCheck ==
  /\ check = "idle"
  /\ check' = "snapshotted"
  /\ snap' = meta
  /\ orphanAtStart' = (creator = "failed" /\ repo # "absent")
  /\ UNCHANGED <<listed, verdict>> /\ UNCHANGED creatorVars

List ==
  /\ check = "snapshotted"
  /\ check' = "listed"
  /\ listed' = CASE repo = "absent" -> "absent"
                 [] reserved /\ Mutation # "no-skip" -> "skipped"
                 [] repo = "partial" -> "malformed"
                 [] OTHER -> "present"
  /\ UNCHANGED <<snap, verdict, orphanAtStart>> /\ UNCHANGED creatorVars

Conclude ==
  /\ check = "listed"
  /\ check' = "done"
  /\ LET fresh == IF Mutation = "no-recheck" THEN snap ELSE meta
     IN verdict' = CASE listed = "malformed" -> "malformed"
                     [] listed = "present" /\ ~snap /\ ~fresh /\ Mutation # "ignore-unknown" -> "orphan"
                     [] OTHER -> "ready"
  /\ UNCHANGED <<snap, listed, orphanAtStart>> /\ UNCHANGED creatorVars

Terminal == creator \in {"done", "failed"} /\ check = "done" /\ UNCHANGED vars

Next == Reserve \/ InitPartial \/ InitDone \/ Commit \/ Release \/ ReleaseEarly \/ CommitAfterRelease \/ Fail
        \/ StartCheck \/ List \/ Conclude \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ creator \in {"idle", "reserved", "initializing", "initialized", "committed", "released_early", "done", "failed"}
  /\ repo \in {"absent", "partial", "present"}
  /\ meta \in BOOLEAN /\ reserved \in BOOLEAN /\ snap \in BOOLEAN /\ orphanAtStart \in BOOLEAN
  /\ check \in {"idle", "snapshotted", "listed", "done"}
  /\ listed \in {"none", "absent", "skipped", "malformed", "present"}
  /\ verdict \in {"none", "ready", "orphan", "malformed"}

\* Readiness fails only for a repository whose creation actually failed.
NoFalseOrphan == verdict \in {"orphan", "malformed"} => creator = "failed"
\* A repository already orphaned when the check starts is never reported ready.
FailClosedOnOrphan == verdict = "ready" => ~orphanAtStart

ReachSkippedCreation == (verdict = "ready" /\ listed = "skipped") => FALSE
ReachRecheckRescue == (verdict = "ready" /\ listed = "present" /\ ~snap) => FALSE
ReachOrphanDetected == verdict = "orphan" => FALSE

=============================================================================
