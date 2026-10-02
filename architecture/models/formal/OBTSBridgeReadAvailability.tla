---- MODULE OBTSBridgeReadAvailability ----
EXTENDS Integers, TLC

(***************************************************************************
OBTS-FM-010, architecture revision 39. One bounded read/publication cycle.
Selection holds the projection view until attestation, independently of the
headless mutex. Source changes may race with hydration. Completed responses
retain their selected revision even when source or projection later advances.
This does not prove SQL, hashing, operating-system locks or runtime latency.
***************************************************************************)
CONSTANTS Scenario, Fault
VARIABLES syncHeld, ownWritten, sourceRevision, rowRevision, publication,
          projectionAttempted, reader, selectedRevision, selectedComplete,
          selectedHealthy, capturedPending, bodyRevision, hydrated,
          unrelatedRead, lastAction
vars == <<syncHeld, ownWritten, sourceRevision, rowRevision, publication,
          projectionAttempted, reader, selectedRevision, selectedComplete,
          selectedHealthy, capturedPending, bodyRevision, hydrated,
          unrelatedRead, lastAction>>

Init ==
  /\ syncHeld = (Scenario # "own-write")
  /\ ownWritten = FALSE
  /\ sourceRevision = 0
  /\ rowRevision = 0
  /\ publication = IF Scenario = "failed" THEN "failed" ELSE "complete"
  /\ projectionAttempted = FALSE
  /\ reader = "idle"
  /\ selectedRevision = -1
  /\ selectedComplete = FALSE
  /\ selectedHealthy = FALSE
  /\ capturedPending = FALSE
  /\ bodyRevision = -1
  /\ hydrated = FALSE
  /\ unrelatedRead = FALSE
  /\ lastAction = "Init"

OwnWrite ==
  /\ Scenario = "own-write" /\ ~ownWritten /\ ~syncHeld
  /\ reader = "idle"
  /\ sourceRevision' = 1 /\ rowRevision' = 1 /\ ownWritten' = TRUE
  /\ lastAction' = "OwnWrite"
  /\ UNCHANGED <<syncHeld, publication, projectionAttempted, reader,
       selectedRevision, selectedComplete, selectedHealthy, capturedPending,
       bodyRevision, hydrated, unrelatedRead>>

StartSync ==
  /\ Scenario = "own-write" /\ ownWritten /\ ~syncHeld
  /\ syncHeld' = TRUE /\ lastAction' = "StartSync"
  /\ UNCHANGED <<ownWritten, sourceRevision, rowRevision, publication,
       projectionAttempted, reader, selectedRevision, selectedComplete,
       selectedHealthy, capturedPending, bodyRevision, hydrated, unrelatedRead>>

BeginProjection ==
  /\ Scenario = "publication" /\ ~projectionAttempted
  /\ reader # "selected"
  /\ publication' = "active" /\ projectionAttempted' = TRUE
  /\ lastAction' = "BeginProjection"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision, reader,
       selectedRevision, selectedComplete, selectedHealthy, capturedPending,
       bodyRevision, hydrated, unrelatedRead>>

PublishProjection ==
  /\ publication = "active" /\ reader # "selected"
  /\ publication' = "complete" /\ rowRevision' = sourceRevision
  /\ lastAction' = "PublishProjection"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, projectionAttempted,
       reader, selectedRevision, selectedComplete, selectedHealthy,
       capturedPending, bodyRevision, hydrated, unrelatedRead>>

FailProjection ==
  /\ publication = "active" /\ reader # "selected"
  /\ publication' = "failed" /\ lastAction' = "FailProjection"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision,
       projectionAttempted, reader, selectedRevision, selectedComplete,
       selectedHealthy, capturedPending, bodyRevision, hydrated, unrelatedRead>>

SelectRead ==
  /\ reader = "idle"
  /\ publication = "complete" \/ (Fault = "early" /\ publication = "active")
  /\ Scenario # "unauthorized" \/ Fault = "authorization"
  /\ Scenario # "own-write" \/ (ownWritten /\ syncHeld)
  /\ Fault # "sync-lock" \/ ~syncHeld
  /\ reader' = "selected" /\ selectedRevision' = rowRevision
  /\ selectedComplete' = (publication = "complete")
  /\ selectedHealthy' = (publication # "failed")
  /\ capturedPending' = (syncHeld \/ ownWritten)
  /\ lastAction' = "SelectRead"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision, publication,
       projectionAttempted, bodyRevision, hydrated, unrelatedRead>>

ChangeSource ==
  /\ Scenario = "race" /\ sourceRevision = 0
  /\ reader \in {"selected", "done"}
  /\ sourceRevision' = 1 /\ lastAction' = "ChangeSource"
  /\ UNCHANGED <<syncHeld, ownWritten, rowRevision, publication,
       projectionAttempted, reader, selectedRevision, selectedComplete,
       selectedHealthy, capturedPending, bodyRevision, hydrated, unrelatedRead>>

HydrateRead ==
  /\ reader = "selected"
  /\ sourceRevision = selectedRevision \/ Fault = "body"
  /\ reader' = "done" /\ bodyRevision' = sourceRevision /\ hydrated' = TRUE
  /\ lastAction' = "HydrateRead"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision, publication,
       projectionAttempted, selectedRevision, selectedComplete, selectedHealthy,
       capturedPending, unrelatedRead>>

RejectMismatch ==
  /\ reader = "selected" /\ sourceRevision # selectedRevision
  /\ reader' = "retry" /\ lastAction' = "RejectMismatch"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision, publication,
       projectionAttempted, selectedRevision, selectedComplete, selectedHealthy,
       capturedPending, bodyRevision, hydrated, unrelatedRead>>

ReadUnrelated ==
  /\ reader = "retry" /\ publication = "complete" /\ ~unrelatedRead
  /\ unrelatedRead' = TRUE /\ lastAction' = "ReadUnrelated"
  /\ UNCHANGED <<syncHeld, ownWritten, sourceRevision, rowRevision, publication,
       projectionAttempted, reader, selectedRevision, selectedComplete,
       selectedHealthy, capturedPending, bodyRevision, hydrated>>

Next == OwnWrite \/ StartSync \/ BeginProjection \/ PublishProjection
        \/ FailProjection \/ SelectRead \/ ChangeSource \/ HydrateRead
        \/ RejectMismatch \/ ReadUnrelated

BodyAttested == hydrated => bodyRevision = selectedRevision
CompleteSelection == reader \in {"selected", "done"} => selectedComplete
HealthySelection == reader \in {"selected", "done"} => selectedHealthy
AuthorizedHydration == hydrated => Scenario # "unauthorized"
PendingAtSelection == reader \in {"selected", "done"} => capturedPending
NoOwnWriteLost == Scenario = "own-write" /\ reader = "done" => bodyRevision = 1
Safety == BodyAttested /\ CompleteSelection /\ HealthySelection
          /\ AuthorizedHydration /\ PendingAtSelection /\ NoOwnWriteLost
NeverHeldRead == ~(syncHeld /\ reader = "done")
NeverOwnRead == ~(ownWritten /\ reader = "done")
NeverUnrelatedRead == ~unrelatedRead
NeverPostResponseDrift == ~(reader = "done" /\ bodyRevision # sourceRevision)
ReadEventually == <> (reader = "done")
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ WF_vars(OwnWrite) /\ WF_vars(StartSync)
                /\ WF_vars(SelectRead) /\ WF_vars(HydrateRead)
=============================================================================
