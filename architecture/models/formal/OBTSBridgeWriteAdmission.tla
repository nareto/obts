---- MODULE OBTSBridgeWriteAdmission ----
EXTENDS Naturals, TLC

(***************************************************************************
OBTS-FM-012, architecture revision 42. One writer starts its bounded deadline
before the service mutex and retains the same budget at the headless mutex.
Success assumes healthy maintenance releases before expiry. Cancellation is
only before child-request ownership; in-flight cancellation is out of scope.
Symbolic ticks are not wall-clock or implementation-conformance evidence.
***************************************************************************)
CONSTANT Scenario
VARIABLES phase, serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
          expectedRevision, admittedRevision, bytesChanged, hadOwnership,
          readDone, childHealthy, lastAction
vars == <<phase, serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
          expectedRevision, admittedRevision, bytesChanged, hadOwnership,
          readDone, childHealthy, lastAction>>
Waiting == phase \in {"service", "headless"}
Terminal == phase \in {"done", "timeout", "cancel", "stale"}

Init ==
  /\ phase = "service" /\ serviceHeld = TRUE /\ syncHeld = TRUE
  /\ elapsed = 0 /\ serviceSpent = 0 /\ sourceRevision = 0
  /\ expectedRevision = 0 /\ admittedRevision = 99
  /\ bytesChanged = FALSE /\ hadOwnership = FALSE
  /\ readDone = FALSE /\ childHealthy = TRUE /\ lastAction = "Init"

ReleaseService ==
  /\ phase = "service" /\ serviceHeld /\ elapsed < 3
  /\ serviceHeld' = FALSE /\ elapsed' = elapsed + 1
  /\ lastAction' = "ReleaseService"
  /\ UNCHANGED <<phase, syncHeld, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

AcquireService ==
  /\ phase = "service" /\ ~serviceHeld /\ elapsed < 3
  /\ phase' = "headless" /\ serviceSpent' = elapsed
  /\ lastAction' = "AcquireService"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

ReadDuringWait ==
  /\ Waiting /\ ~readDone
  /\ readDone' = TRUE /\ lastAction' = "ReadDuringWait"
  /\ UNCHANGED <<phase, serviceHeld, syncHeld, elapsed, serviceSpent,
       sourceRevision, expectedRevision, admittedRevision, bytesChanged,
       hadOwnership, childHealthy>>

ChangeRevision ==
  /\ Scenario = "stale" /\ phase = "headless" /\ sourceRevision = 0
  /\ sourceRevision' = 1 /\ lastAction' = "ChangeRevision"
  /\ UNCHANGED <<phase, serviceHeld, syncHeld, elapsed, serviceSpent,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

ReleaseSync ==
  /\ phase = "headless" /\ syncHeld /\ elapsed < 3
  /\ Scenario \in {"success", "stale"}
  /\ Scenario # "stale" \/ sourceRevision = 1
  /\ syncHeld' = FALSE /\ lastAction' = "ReleaseSync"
  /\ UNCHANGED <<phase, serviceHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

AcquireWriter ==
  /\ phase = "headless" /\ ~syncHeld /\ elapsed < 3 /\ readDone
  /\ phase' = "owned" /\ admittedRevision' = sourceRevision
  /\ hadOwnership' = TRUE /\ lastAction' = "AcquireWriter"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, bytesChanged, readDone, childHealthy>>

WaitTick ==
  /\ Waiting /\ elapsed < 3 /\ Scenario # "success"
  /\ elapsed' = elapsed + 1 /\ lastAction' = "WaitTick"
  /\ UNCHANGED <<phase, serviceHeld, syncHeld, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

Timeout ==
  /\ Waiting /\ elapsed = 3
  /\ phase' = "timeout" /\ lastAction' = "Timeout"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

CancelWait ==
  /\ Waiting /\ Scenario \in {"cancel", "unsafe-cancel"}
  /\ phase' = "cancel"
  /\ childHealthy' = (Scenario # "unsafe-cancel")
  /\ lastAction' = "CancelWait"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership, readDone>>

WriteCurrent ==
  /\ phase = "owned" /\ admittedRevision = expectedRevision
  /\ bytesChanged' = TRUE /\ sourceRevision' = 2
  /\ phase' = "done" /\ lastAction' = "WriteCurrent"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent,
       expectedRevision, admittedRevision, hadOwnership, readDone, childHealthy>>

RejectStale ==
  /\ phase = "owned" /\ admittedRevision # expectedRevision
  /\ phase' = "stale" /\ lastAction' = "RejectStale"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, bytesChanged, hadOwnership,
       readDone, childHealthy>>

UnsafeWrite ==
  /\ Scenario = "unsafe-write" /\ Waiting /\ syncHeld
  /\ bytesChanged' = TRUE /\ phase' = "done" /\ lastAction' = "UnsafeWrite"
  /\ UNCHANGED <<serviceHeld, syncHeld, elapsed, serviceSpent, sourceRevision,
       expectedRevision, admittedRevision, hadOwnership, readDone, childHealthy>>

Next == ReleaseService \/ AcquireService \/ ReadDuringWait \/ ChangeRevision
        \/ ReleaseSync \/ AcquireWriter \/ WaitTick \/ Timeout \/ CancelWait
        \/ WriteCurrent \/ RejectStale \/ UnsafeWrite \/ (Terminal /\ UNCHANGED vars)

OwnedRevisionWrite == bytesChanged =>
  hadOwnership /\ ~syncHeld /\ phase = "done" /\ admittedRevision = expectedRevision
HealthyWaitPreserved == childHealthy
AbortedWritePreserved == phase \in {"timeout", "cancel", "stale"} => ~bytesChanged
SingleBudget == phase \in {"headless", "owned", "done", "stale"} => elapsed >= serviceSpent
Safety == OwnedRevisionWrite /\ HealthyWaitPreserved /\ AbortedWritePreserved /\ SingleBudget
NeverDone == phase # "done"
NeverReadQueued == ~readDone
NeverTimedOut == phase # "timeout"
NeverCancelled == phase # "cancel"
NeverStale == phase # "stale"
WriterDone == <> (phase = "done")
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(ReleaseService) /\ WF_vars(AcquireService)
  /\ WF_vars(ReadDuringWait) /\ WF_vars(ReleaseSync) /\ WF_vars(AcquireWriter)
  /\ WF_vars(WriteCurrent)
=============================================================================
