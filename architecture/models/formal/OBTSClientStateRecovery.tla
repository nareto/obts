---------------- MODULE OBTSClientStateRecovery ----------------
EXTENDS Naturals, TLC

(***************************************************************************
FM008, architecture revision 41. One client, an immutable pending proposal and
 two ordered server observations. Primary/backup publication, one process
 crash and one stale local-cursor write are separate boundaries. Ref equality
 and server ancestry are already verified symbolic facts. No missing-object,
 byte preservation or filesystem durability claim is made. Split local refs
 stand for incomparable head histories; they cannot select a whole backup.

 The independent lane g covers a comparable split: the local Git ref is a
 strict ancestor of local_head after a conflict resolution was applied. P is
 the conflicted proposal, M the resolution containing P, and D a new cohort
 committed on M. A legacy start is a device that was already split by an
 earlier client. Main-ref agreement, absence of an apply journal, catch-up or
 queued attempt, and whether every path changed between the ref and local_head
 still holds the ref's visible bytes are verified symbolic inputs.
***************************************************************************)
CONSTANT Mutation
VARIABLES s, g
vars == <<s, g>>
SInit == s = [phase |-> "before", running |-> TRUE, crashed |-> FALSE,
  damaged |-> FALSE, split |-> FALSE, observed |-> FALSE, read |-> FALSE,
  primary |-> [local |-> 1, head |-> 2, server |-> 0, blocked |-> TRUE],
  backup |-> [local |-> 0, head |-> 2, server |-> 0, blocked |-> TRUE],
  queueExpected |-> 0, queueCommit |-> 2]
GFresh == [phase |-> "conflicted", legacy |-> FALSE, ref |-> "P", head |-> "P",
  pending |-> "P", bytes |-> "ancestor", parent |-> "none", revert |-> FALSE,
  proposed |-> FALSE]
GLegacy(bytes) == [phase |-> "applied", legacy |-> TRUE, ref |-> "P", head |-> "M",
  pending |-> "none", bytes |-> bytes, parent |-> "none", revert |-> FALSE,
  proposed |-> FALSE]
Init == SInit /\ g \in {GFresh, GLegacy("applied"), GLegacy("ancestor")}
Observe ==
  /\ s.running /\ s.phase = "before"
  /\ s' = [s EXCEPT !.backup = s.primary,
    !.primary = [local |-> 1, head |-> 2, server |-> 2, blocked |-> FALSE],
    !.observed = TRUE, !.phase = "published"]
  /\ UNCHANGED g
StaleLocalWrite ==
  /\ s.running /\ s.phase = "published" /\ ~s.damaged
  /\ s' = [s EXCEPT !.primary.local = 0, !.damaged = TRUE]
  /\ UNCHANGED g
EqualServerRef ==
  /\ s.running /\ s.phase = "published" /\ s.backup.server # s.primary.server
  /\ s' = [s EXCEPT !.backup.server = s.primary.server]
  /\ UNCHANGED g
SplitLocalRefs ==
  /\ s.running /\ s.phase = "published" /\ ~s.split
  /\ s' = [s EXCEPT !.primary.local = 0, !.backup.head = 3, !.split = TRUE]
  /\ UNCHANGED g
Crash ==
  /\ s.running /\ ~s.crashed /\ s.phase # "done"
  /\ s' = [s EXCEPT !.running = FALSE, !.crashed = TRUE]
  /\ UNCHANGED g
Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE]
  /\ UNCHANGED g
Read ==
  /\ s.running /\ s.phase = "published"
  /\ LET recoverLocal == s.primary.local # 1 /\ s.backup.local = 1 /\ ~s.split
         queueWins == Mutation = "queue-authority" /\ s.backup.server = s.queueExpected
         wholeBackup == s.split /\ Mutation = "incomparable-head"
         local == IF wholeBackup \/ (recoverLocal /\ Mutation # "always-primary") THEN s.backup.local ELSE s.primary.local
         head == IF wholeBackup THEN s.backup.head ELSE s.primary.head
         server == IF queueWins THEN s.backup.server ELSE s.primary.server
         oldError == Mutation = "copy-backup-error" /\ recoverLocal /\ s.primary.server = s.backup.server
         blocked == IF queueWins \/ oldError THEN s.backup.blocked ELSE s.primary.blocked
     IN s' = [s EXCEPT !.primary = [local |-> local, head |-> head, server |-> server, blocked |-> blocked],
       !.queueExpected = IF Mutation = "rewrite-attempt" THEN server ELSE @,
       !.phase = "done", !.read = TRUE]
  /\ UNCHANGED g
\* Applying M writes its bytes and moves both cursors under the apply journal.
ApplyResolution ==
  /\ g.phase = "conflicted"
  /\ g' = [g EXCEPT !.phase = "applying", !.ref = "M", !.head = "M", !.bytes = "applied"]
  /\ UNCHANGED s
\* The conflicted proposal P is contained in M, so it is settled and owns no
\* cursor; edits preserved through the apply become cohort D on M.
PreserveEdits ==
  /\ g.phase = "applying"
  /\ g' = IF Mutation = "restore-settled"
          THEN [g EXCEPT !.phase = "applied", !.ref = "P", !.pending = "none"]
          ELSE [g EXCEPT !.phase = "queued", !.ref = "D", !.head = "D", !.pending = "D", !.parent = "M"]
  /\ UNCHANGED s
\* Fast-forward the ref to local_head only when no visible path still holds
\* the ref's bytes; otherwise the split stays blocked with its evidence.
Repair ==
  /\ g.phase = "applied" /\ g.pending = "none"
  /\ g.ref = "P" /\ g.head = "M"
  /\ Mutation # "no-repair"
  /\ (g.bytes = "applied" \/ Mutation = "unverified-repair")
  /\ g' = IF Mutation = "state-follows-ref" THEN [g EXCEPT !.head = g.ref] ELSE [g EXCEPT !.ref = g.head]
  /\ UNCHANGED s
\* Committing a cohort compares-and-swaps the ref against local_head.
QueueCohort ==
  /\ g.phase = "applied" /\ g.pending = "none" /\ g.ref = g.head
  /\ g' = [g EXCEPT !.phase = "queued", !.ref = "D", !.head = "D", !.pending = "D",
       !.parent = g.head, !.revert = (g.bytes = "ancestor" /\ g.head = "M")]
  /\ UNCHANGED s
Propose ==
  /\ g.phase = "queued"
  /\ g' = [g EXCEPT !.phase = "proposed", !.proposed = TRUE]
  /\ UNCHANGED s
Done == /\ s.phase = "done" /\ UNCHANGED vars
Next == Observe \/ StaleLocalWrite \/ EqualServerRef \/ SplitLocalRefs \/ Crash \/ Restart \/ Read
  \/ ApplyResolution \/ PreserveEdits \/ Repair \/ QueueCohort \/ Propose \/ Done
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Observe) /\ WF_vars(Restart) /\ WF_vars(Read)
  /\ WF_vars(ApplyResolution) /\ WF_vars(PreserveEdits) /\ WF_vars(Repair) /\ WF_vars(QueueCohort) /\ WF_vars(Propose)
ObservationPreserved == s.read => (s.primary.server = 2 /\ ~s.primary.blocked)
LocalRefsRecovered == (s.read /\ ~s.split) => s.primary.local = 1
SplitRefsPreserved == (s.read /\ s.split) => (s.primary.local = 0 /\ s.primary.head = 2)
AttemptUnchanged == s.queueExpected = 0 /\ s.queueCommit = 2
StateCursorNotRegressed == g.phase # "conflicted" => g.head # "P"
ApplyKeepsRefWithState == (~g.legacy /\ g.phase # "conflicted") => g.ref = g.head
NoAncestorRevertProposal == g.proposed => ~g.revert
ProposalOnResolution == g.proposed => g.parent = "M"
Safety == ObservationPreserved /\ LocalRefsRecovered /\ SplitRefsPreserved /\ AttemptUnchanged
  /\ StateCursorNotRegressed /\ ApplyKeepsRefWithState /\ NoAncestorRevertProposal /\ ProposalOnResolution
EventuallyRead == <> s.read
SplitPreserved == g.phase = "applied" /\ g.ref = "P" /\ g.head = "M" /\ g.bytes = "ancestor"
EventuallyProposedOrPreserved == <> (g.proposed \/ SplitPreserved)
NeverRestartedRecovery == ~(s.read /\ s.crashed /\ s.damaged)
=============================================================================
