---- MODULE OBTSManagedHeadlessOwnership ----
EXTENDS Naturals, FiniteSets, TLC

\* OBTS-FM-013, architecture revision 44. Bound: two actors and two launches.
\* Descendant process-group membership is bounded by one descendant per actor.
\* Linux signaling/flock are abstracted; executable launcher tests remain required.
\* Catch-up reporting preserves authority fields at publication.
CONSTANT Mutation
Actors == {"a", "b"}
NoOwner == "none"
VARIABLES children, descendants, supervisors, osOwners, generation, byGeneration,
          markerKind, markerOwner, markerGeneration, apply, journal,
          refs, queue, evidence, caughtFailure, reported, eventCount,
          unknownReclaimed, liveReclaimed, replacementDeleted
vars == <<children, descendants, supervisors, osOwners, generation, byGeneration,
          markerKind, markerOwner, markerGeneration, apply, journal,
          refs, queue, evidence, caughtFailure, reported, eventCount,
          unknownReclaimed, liveReclaimed, replacementDeleted>>

Init ==
  /\ children = {} /\ descendants = {} /\ supervisors = {} /\ osOwners = {}
  /\ generation = 0 /\ byGeneration = [a \in Actors |-> 0]
  /\ markerKind = "none" /\ markerOwner = NoOwner /\ markerGeneration = 0
  /\ apply = "idle" /\ journal = "valid" /\ refs = "base"
  /\ queue = "pending" /\ evidence = "retained"
  /\ caughtFailure = FALSE /\ reported = FALSE /\ eventCount = 0
  /\ unknownReclaimed = FALSE /\ liveReclaimed = FALSE
  /\ replacementDeleted = FALSE

Launch(a) ==
  /\ a \in Actors \ children /\ generation < 2
  /\ (osOwners = {} \/ Mutation = "duplicate-owner")
  /\ children' = children \cup {a}
  /\ supervisors' = supervisors \cup {a}
  /\ osOwners' = osOwners \cup {a}
  /\ generation' = generation + 1
  /\ byGeneration' = [byGeneration EXCEPT ![a] = generation + 1]
  /\ UNCHANGED <<descendants, markerKind, markerOwner, markerGeneration, apply,
       journal, refs, queue, evidence, caughtFailure, reported, eventCount,
       unknownReclaimed, liveReclaimed, replacementDeleted>>

SpawnDescendant(a) ==
  /\ a \in children
  /\ descendants' = descendants \cup {a}
  /\ UNCHANGED <<children, supervisors, osOwners, generation, byGeneration,
       markerKind, markerOwner, markerGeneration, apply, journal, refs, queue,
       evidence, caughtFailure, reported, eventCount, unknownReclaimed,
       liveReclaimed, replacementDeleted>>

TerminateOwnedGroup(a) ==
  /\ a \in children /\ a \in osOwners
  /\ children' = children \ {a} /\ descendants' = descendants \ {a}
  /\ osOwners' = osOwners \ {a} /\ supervisors' = supervisors \ {a}
  /\ UNCHANGED <<generation, byGeneration, markerKind, markerOwner,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, liveReclaimed, replacementDeleted>>

SupervisorDies(a) ==
  /\ a \in supervisors
  /\ supervisors' = supervisors \ {a}
  /\ osOwners' = IF Mutation = "supervisor-release" THEN osOwners \ {a} ELSE osOwners
  /\ UNCHANGED <<children, descendants, generation, byGeneration, markerKind,
       markerOwner, markerGeneration, apply, journal, refs, queue, evidence,
       caughtFailure, reported, eventCount, unknownReclaimed, liveReclaimed,
       replacementDeleted>>

ChildExits(a) ==
  /\ a \in children /\ a \notin descendants
  /\ children' = children \ {a} /\ osOwners' = osOwners \ {a}
  /\ supervisors' = supervisors \ {a}
  /\ UNCHANGED <<descendants, generation, byGeneration, markerKind, markerOwner,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, liveReclaimed,
       replacementDeleted>>

LeaderExitsBeforeGroup(a) ==
  /\ a \in children /\ a \in descendants /\ Mutation = "leader-exit-release"
  /\ children' = children \ {a} /\ osOwners' = osOwners \ {a}
  /\ supervisors' = supervisors \ {a}
  /\ UNCHANGED <<descendants, generation, byGeneration, markerKind, markerOwner,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, liveReclaimed, replacementDeleted>>

BeginApply(a) ==
  /\ a \in osOwners /\ Cardinality(osOwners) = 1
  /\ markerKind = "none" /\ apply = "idle"
  /\ markerKind' = "managed-v2" /\ markerOwner' = a
  /\ markerGeneration' = byGeneration[a] /\ apply' = "active"
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       journal, refs, queue, evidence, caughtFailure, reported, eventCount,
       unknownReclaimed, liveReclaimed, replacementDeleted>>

ApplyCrashes(a) ==
  /\ a \in osOwners /\ apply = "active" /\ markerOwner = a
  /\ apply' = "idle"
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerKind, markerOwner, markerGeneration, journal, refs, queue,
       evidence, caughtFailure, reported, eventCount, unknownReclaimed,
       liveReclaimed, replacementDeleted>>

ReconcileManagedMarker(a) ==
  /\ a \in osOwners /\ Cardinality(osOwners) = 1
  /\ markerKind = "managed-v2" /\ apply = "idle"
  /\ markerGeneration < byGeneration[a]
  /\ markerOwner \notin osOwners
  /\ markerKind' = "none" /\ markerOwner' = NoOwner /\ apply' = "recovered"
  /\ journal' = "valid"
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerGeneration, refs, queue, evidence, caughtFailure, reported,
       eventCount, unknownReclaimed, liveReclaimed, replacementDeleted>>

ReclaimSameGeneration(a) ==
  /\ a \in osOwners /\ markerKind = "managed-v2"
  /\ markerOwner \in osOwners /\ markerGeneration = byGeneration[a]
  /\ Mutation = "same-generation-reclaim"
  /\ markerKind' = "none" /\ markerOwner' = NoOwner /\ liveReclaimed' = TRUE
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, replacementDeleted>>

InstallUnknownMarker ==
  /\ osOwners = {} /\ markerKind = "none"
  /\ markerKind' = "unknown" /\ markerOwner' = NoOwner
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, liveReclaimed,
       replacementDeleted>>

ReclaimUnknown(a) ==
  /\ a \in osOwners /\ Cardinality(osOwners) = 1
  /\ markerKind = "unknown" /\ Mutation = "steal-unknown"
  /\ markerKind' = "none" /\ markerOwner' = NoOwner
  /\ unknownReclaimed' = TRUE
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, liveReclaimed, replacementDeleted>>

DelayedOwnerCleanup(a) ==
  /\ a \in Actors /\ markerKind = "managed-v2"
  /\ (markerOwner # a \/ markerGeneration # byGeneration[a])
  /\ IF Mutation = "replacement-delete" THEN
       markerKind' = "none" /\ markerOwner' = NoOwner
       /\ replacementDeleted' = TRUE
     ELSE
       markerKind' = markerKind /\ markerOwner' = markerOwner
       /\ replacementDeleted' = replacementDeleted
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerGeneration, apply, journal, refs, queue, evidence, caughtFailure,
       reported, eventCount, unknownReclaimed, liveReclaimed>>

FailCatchup(a) ==
  /\ a \in osOwners /\ Cardinality(osOwners) = 1 /\ ~caughtFailure
  /\ caughtFailure' = TRUE /\ apply' = "failed"
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerKind, markerOwner, markerGeneration, journal, refs, queue,
       evidence, reported, eventCount, unknownReclaimed, liveReclaimed,
       replacementDeleted>>

ReportMaintenanceFailure ==
  /\ caughtFailure /\ ~reported /\ eventCount = 0
  /\ reported' = TRUE
  /\ eventCount' = IF Mutation = "duplicate-event" THEN 2 ELSE 1
  /\ refs' = IF Mutation = "report-mutates-state" THEN "changed" ELSE refs
  /\ queue' = IF Mutation = "report-mutates-state" THEN "changed" ELSE queue
  /\ evidence' = IF Mutation = "report-mutates-state" THEN "changed" ELSE evidence
  /\ UNCHANGED <<children, descendants, supervisors, osOwners, generation, byGeneration,
       markerKind, markerOwner, markerGeneration, apply, journal, caughtFailure,
       unknownReclaimed, liveReclaimed, replacementDeleted>>

Next == (\E a \in Actors : Launch(a) \/ SupervisorDies(a) \/ ChildExits(a)
        \/ SpawnDescendant(a) \/ TerminateOwnedGroup(a) \/ LeaderExitsBeforeGroup(a)
        \/ BeginApply(a) \/ ApplyCrashes(a) \/ ReconcileManagedMarker(a)
        \/ ReclaimSameGeneration(a) \/ ReclaimUnknown(a)
        \/ DelayedOwnerCleanup(a) \/ FailCatchup(a))
        \/ InstallUnknownMarker \/ ReportMaintenanceFailure \/ UNCHANGED vars

OneProcessOwner == Cardinality(osOwners) <= 1
OwnedLockHasLiveChild == osOwners = children \cup descendants
SupervisorDeathKeepsChildLock == (children \cup descendants) \cap osOwners # {}
SurvivingDescendantKeepsLock == descendants \subseteq osOwners
NeverTerminatedGroup == descendants = {}
NeverAllExited == osOwners # {}
MarkerBoundToLaunch == markerKind = "managed-v2" => markerGeneration > 0 /\ markerGeneration <= generation
UnknownMarkerWasNotReclaimed == ~unknownReclaimed
LiveMarkerWasNotReclaimed == ~liveReclaimed
ReplacementWasNotDeleted == ~replacementDeleted
TruthfulFailureReport == reported => caughtFailure /\ eventCount = 1
NoDuplicateStateEvent == eventCount <= 1
NeverDetachedChild == children \ supervisors = {}
NeverReconciled == apply # "recovered"
NeverRestarted == generation < 2
Safety == OneProcessOwner /\ OwnedLockHasLiveChild /\ SurvivingDescendantKeepsLock /\ UnknownMarkerWasNotReclaimed
  /\ MarkerBoundToLaunch /\ LiveMarkerWasNotReclaimed /\ ReplacementWasNotDeleted
  /\ TruthfulFailureReport /\ NoDuplicateStateEvent

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(ReportMaintenanceFailure)
FailureReportedAfterFailure == [] (caughtFailure => <>reported)
=============================================================================
