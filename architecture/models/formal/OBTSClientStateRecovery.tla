---------------- MODULE OBTSClientStateRecovery ----------------
EXTENDS Naturals, TLC

(***************************************************************************
FM008, architecture revision 23. One client, an immutable pending proposal and
 two ordered server observations. Primary/backup publication, one process
 crash and one stale local-cursor write are separate boundaries. Ref equality
 and server ancestry are already verified symbolic facts. No missing-object,
 byte preservation or filesystem durability claim is made. Split local refs
 stand for incomparable head histories; they cannot select a whole backup.
***************************************************************************)
CONSTANT Mutation
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "before", running |-> TRUE, crashed |-> FALSE,
  damaged |-> FALSE, split |-> FALSE, observed |-> FALSE, read |-> FALSE,
  primary |-> [local |-> 1, head |-> 2, server |-> 0, blocked |-> TRUE],
  backup |-> [local |-> 0, head |-> 2, server |-> 0, blocked |-> TRUE],
  queueExpected |-> 0, queueCommit |-> 2]
Observe ==
  /\ s.running /\ s.phase = "before"
  /\ s' = [s EXCEPT !.backup = s.primary,
    !.primary = [local |-> 1, head |-> 2, server |-> 2, blocked |-> FALSE],
    !.observed = TRUE, !.phase = "published"]
StaleLocalWrite ==
  /\ s.running /\ s.phase = "published" /\ ~s.damaged
  /\ s' = [s EXCEPT !.primary.local = 0, !.damaged = TRUE]
EqualServerRef ==
  /\ s.running /\ s.phase = "published" /\ s.backup.server # s.primary.server
  /\ s' = [s EXCEPT !.backup.server = s.primary.server]
SplitLocalRefs ==
  /\ s.running /\ s.phase = "published" /\ ~s.split
  /\ s' = [s EXCEPT !.primary.local = 0, !.backup.head = 3, !.split = TRUE]
Crash ==
  /\ s.running /\ ~s.crashed /\ s.phase # "done"
  /\ s' = [s EXCEPT !.running = FALSE, !.crashed = TRUE]
Restart ==
  /\ ~s.running
  /\ s' = [s EXCEPT !.running = TRUE]
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
Done == /\ s.phase = "done" /\ UNCHANGED s
Next == Observe \/ StaleLocalWrite \/ EqualServerRef \/ SplitLocalRefs \/ Crash \/ Restart \/ Read \/ Done
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Observe) /\ WF_vars(Restart) /\ WF_vars(Read)
ObservationPreserved == s.read => (s.primary.server = 2 /\ ~s.primary.blocked)
LocalRefsRecovered == (s.read /\ ~s.split) => s.primary.local = 1
SplitRefsPreserved == (s.read /\ s.split) => (s.primary.local = 0 /\ s.primary.head = 2)
AttemptUnchanged == s.queueExpected = 0 /\ s.queueCommit = 2
Safety == ObservationPreserved /\ LocalRefsRecovered /\ SplitRefsPreserved /\ AttemptUnchanged
EventuallyRead == <> s.read
NeverRestartedRecovery == ~(s.read /\ s.crashed /\ s.damaged)
=============================================================================
