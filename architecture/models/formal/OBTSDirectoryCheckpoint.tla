---- MODULE OBTSDirectoryCheckpoint ----
EXTENDS Naturals, Sequences, TLC

(***************************************************************************
OBTS-FM-002 directory retention checkpoint companion, architecture revision 63.
Refines OBTS-SYNC-DIR-001 and OBTS-SAF-009. The composed distributed model
abstracts retained directory history as one flag. This companion checks the
retention checkpoint without widening that model's state space.

Every event advances main and may carry one directory intent over two nested
directories. Retention removes the oldest retained event and, in the same
metadata transaction, folds that event's intent into the vault checkpoint.
A device pins one historical main for its whole transfer while main keeps
advancing and retention keeps pruning. Serving that target replays the
retained contiguous events after the checkpoint; the current main is served
from the live directory state.

A legacy server prunes without a checkpoint. The upgrade seeds the checkpoint
from the live state at the later of the last directory-changing event and the
newest pruned event, the only cursors at which the live state is exact for
the pruned prefix. Path normalization, JSON persistence, write atomicity, and
retention timing are implementation obligations.
***************************************************************************)
CONSTANTS MaxEvents, LegacyStart, FaultMode
ASSUME MaxEvents \in Nat /\ MaxEvents >= 2 /\ LegacyStart \in BOOLEAN
ASSUME FaultMode \in {"None", "NoFold", "StaleFold", "SeedAtOldest"}

Dirs == {"p", "p/c"}
Ops == {"none", "create", "delete"}
Events == [op : Ops, dir : Dirs]
Outcomes == {"Pending", "Available", "Unavailable"}

Prefixes(d) == IF d = "p/c" THEN {"p"} ELSE {}
Within(path, root) == path = root \/ (root = "p" /\ path = "p/c")

ApplyIntent(s, e) ==
  CASE e.op = "create" -> s \cup Prefixes(e.dir) \cup {e.dir}
    [] e.op = "delete" -> {path \in s : ~Within(path, e.dir)}
    [] OTHER -> s

RECURSIVE ReplayRange(_, _, _, _)
ReplayRange(s, log, from, to) ==
  IF from > to THEN s ELSE ReplayRange(ApplyIntent(s, log[from]), log, from + 1, to)

SnapshotAt(log, k) == ReplayRange({}, log, 1, k)

VARIABLES log, live, lastDirSeq, retainedFrom, ckSeq, ckDirs, upgraded, seeded,
          pinned, outcome, served
vars == <<log, live, lastDirSeq, retainedFrom, ckSeq, ckDirs, upgraded, seeded,
          pinned, outcome, served>>

Init ==
  /\ log = <<>>
  /\ live = {}
  /\ lastDirSeq = 0
  /\ retainedFrom = 1
  /\ ckSeq = 0
  /\ ckDirs = {}
  /\ upgraded = ~LegacyStart
  /\ seeded = FALSE
  /\ pinned = 0
  /\ outcome = "Pending"
  /\ served = {}

\* metadataStore.appendEvent plus the caller's live directory update.
AppendEvent ==
  /\ Len(log) < MaxEvents
  /\ \E e \in Events:
       /\ log' = Append(log, e)
       /\ live' = ApplyIntent(live, e)
       /\ lastDirSeq' = IF e.op = "none" THEN lastDirSeq ELSE Len(log) + 1
  /\ UNCHANGED <<retainedFrom, ckSeq, ckDirs, upgraded, seeded, pinned, outcome, served>>

\* Retention keeps at least the newest event and prunes only the oldest retained one.
Prune ==
  /\ retainedFrom < Len(log)
  /\ retainedFrom' = retainedFrom + 1
  /\ IF ~upgraded \/ FaultMode = "NoFold" \/ retainedFrom <= ckSeq
       THEN UNCHANGED <<ckSeq, ckDirs>>
       ELSE /\ retainedFrom = ckSeq + 1
            /\ ckSeq' = retainedFrom
            /\ ckDirs' = IF FaultMode = "StaleFold" THEN ckDirs ELSE ApplyIntent(ckDirs, log[retainedFrom])
  /\ UNCHANGED <<log, live, lastDirSeq, upgraded, seeded, pinned, outcome, served>>

\* A new device pins the current main as its immutable transfer target.
Pin ==
  /\ pinned = 0 /\ Len(log) > 0
  /\ pinned' = Len(log)
  /\ UNCHANGED <<log, live, lastDirSeq, retainedFrom, ckSeq, ckDirs, upgraded, seeded, outcome, served>>

\* Startup migration of a legacy metadata store.
Upgrade ==
  /\ ~upgraded
  /\ upgraded' = TRUE
  /\ seeded' = (retainedFrom > 1)
  /\ IF retainedFrom = 1
       THEN UNCHANGED <<ckSeq, ckDirs>>
       ELSE /\ ckSeq' = IF FaultMode = "SeedAtOldest" THEN retainedFrom - 1
                         ELSE IF lastDirSeq > retainedFrom - 1 THEN lastDirSeq ELSE retainedFrom - 1
            /\ ckDirs' = live
  /\ outcome' = "Pending"
  /\ served' = {}
  /\ UNCHANGED <<log, live, lastDirSeq, retainedFrom, pinned>>

\* One transfer chunk request bound to the pinned target.
Serve ==
  /\ pinned # 0
  /\ LET current == pinned = Len(log)
         legacyOk == retainedFrom = 1
         checkpointOk == ckSeq <= pinned /\ retainedFrom <= ckSeq + 1
         ok == current \/ (IF upgraded THEN checkpointOk ELSE legacyOk)
     IN /\ outcome' = IF ok THEN "Available" ELSE "Unavailable"
        /\ served' = IF ~ok THEN {}
                     ELSE IF current THEN live
                     ELSE IF upgraded THEN ReplayRange(ckDirs, log, ckSeq + 1, pinned)
                     ELSE SnapshotAt(log, pinned)
  /\ UNCHANGED <<log, live, lastDirSeq, retainedFrom, ckSeq, ckDirs, upgraded, seeded, pinned>>

Next == AppendEvent \/ Prune \/ Pin \/ Upgrade \/ Serve
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(Upgrade) /\ WF_vars(Pin) /\ WF_vars(Serve)

TypeOK ==
  /\ log \in Seq(Events) /\ Len(log) <= MaxEvents
  /\ live \in SUBSET Dirs /\ ckDirs \in SUBSET Dirs /\ served \in SUBSET Dirs
  /\ lastDirSeq \in 0..MaxEvents /\ retainedFrom \in 1..MaxEvents /\ ckSeq \in 0..MaxEvents
  /\ pinned \in 0..MaxEvents /\ upgraded \in BOOLEAN /\ seeded \in BOOLEAN
  /\ outcome \in Outcomes

LiveExact == live = SnapshotAt(log, Len(log))
CheckpointExact == upgraded => ckDirs = SnapshotAt(log, ckSeq)
CheckpointContiguous == upgraded => retainedFrom <= ckSeq + 1
ServedExact == outcome = "Available" => served = SnapshotAt(log, pinned)
UnavailableOnlyBeyondCheckpoint == upgraded /\ outcome = "Unavailable" => ckSeq > pinned
CheckpointMonotonic == [][upgraded => ckSeq' >= ckSeq]_vars
PinnedEventuallyResolved == (pinned # 0) ~> (upgraded /\ outcome # "Pending")

NoPrunedHistoricalServe == ~(upgraded /\ outcome = "Available" /\ pinned < Len(log) /\ retainedFrom > 1)
NoSeededHistoricalServe == ~(seeded /\ outcome = "Available" /\ pinned < Len(log))

CompanionActions == {
  "AppendEvent",
  "Prune",
  "Pin",
  "Upgrade",
  "Serve"
}
=============================================================================
