---- MODULE OBTSDeltaApply ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
OBTS-FM-002 change-proportional apply and capture companion, architecture
revision 47. Refines OBTS-SYNC-DELTA-001 with OBTS-SYNC-ACK-001,
OBTS-SYNC-STALE-001 and OBTS-SAF-002 for one client and a symbolic server.

Values are fresh symbolic file versions per path (0 is the initial version).
`head` is the local commit tree; once every captured change is pushed it is
the pre-apply authoring base M0 of OBTS-SYNC-STALE-001. A push is one atomic
server integration: an unchanged canonical path accepts the local version,
otherwise canonical bytes stay and the local version is preserved (conflict
copy). Every push advances the canonical commit even when the tree does not
change, as the server's merge commit does.

Apply admits target T = canonical main only when no captured change awaits
upload. Its footprint is {p : T[p] # M0[p]}; directory intents, policy
changes and held work are abstracted (the contract widens the footprint for
them, and a larger footprint is behavior-preserving). Footprint paths are
re-read in the gate: a path whose visible bytes differ from M0 is deferred,
keeps M0 (or an older sticky base) as its proposal base and stays visible.
Paths outside the footprint are neither read nor written. The ref-only apply
is the empty-footprint case with no sticky obligations; it moves refs only.
Journal, recovery publication, acknowledgement durability, crash and restart
are OBTS-FM-001/FM-002 obligations and are not repeated here.

Watcher hints may be lost. Ordinary capture consumes only durable hints; a
whole-vault metadata inventory may run at any time (startup, resume, request)
and must run before more than InventoryPeriod background cycles elapse.
Byte-identical edits that a metadata inventory cannot see belong to the
scheduled full audit and are outside this model.

Mutants: RefOnlyIgnoresTree moves refs without comparing trees,
PreflightTrustsHints treats unhinted paths as clean instead of re-reading
them, and SkipInventory never runs the scheduled inventory.
***************************************************************************)
CONSTANTS Paths, MaxUserEdits, MaxRemoteEdits, InventoryPeriod,
          RefOnlyIgnoresTree, PreflightTrustsHints, SkipInventory

ASSUME IsFiniteSet(Paths) /\ Paths # {}
ASSUME MaxUserEdits \in Nat /\ MaxRemoteEdits \in Nat
ASSUME InventoryPeriod \in Nat /\ InventoryPeriod > 0
ASSUME RefOnlyIgnoresTree \in BOOLEAN /\ PreflightTrustsHints \in BOOLEAN /\ SkipInventory \in BOOLEAN

Values == 0..(MaxUserEdits + MaxRemoteEdits)
CycleCap == InventoryPeriod + 1
ApplyKinds == {"none", "ref-only", "footprint"}

VARIABLES
  server,      \* canonical main tree
  epoch,       \* canonical main commit counter
  preserved,   \* local versions integrated or conflict-preserved by the server
  disk,        \* visible local vault
  head,        \* local commit tree; M0 once every capture is pushed
  abase,       \* per-path proposal base
  stale,       \* paths whose sticky base outlives an apply (OBTS-SYNC-STALE-001)
  pushed,      \* no captured change awaits upload
  applied,     \* canonical commit counter last applied locally
  hinted,      \* durable watcher hints
  missed,      \* ghost: paths whose latest edit event was lost
  dirty,       \* ghost: paths edited since their last capture
  latest,      \* ghost: latest user-authored version per path (0 = none)
  userEdits,
  remoteEdits,
  cycles,      \* background cycles since the last whole-vault inventory
  age,         \* background cycles the oldest missed edit has waited
  lastApply,   \* ghost witness of the latest apply
  rescued      \* ghost: an inventory captured an edit whose event was lost

vars == <<server, epoch, preserved, disk, head, abase, stale, pushed, applied,
          hinted, missed, dirty, latest, userEdits, remoteEdits, cycles, age,
          lastApply, rescued>>

Fresh == 1 + userEdits + remoteEdits
Footprint == {p \in Paths : server[p] # head[p]}
CanApply == pushed /\ applied # epoch
GateClean(p) == IF PreflightTrustsHints THEN p \notin hinted ELSE disk[p] = head[p]

Init ==
  /\ server = [p \in Paths |-> 0]
  /\ epoch = 0
  /\ preserved = {}
  /\ disk = [p \in Paths |-> 0]
  /\ head = [p \in Paths |-> 0]
  /\ abase = [p \in Paths |-> 0]
  /\ stale = {}
  /\ pushed = TRUE
  /\ applied = 0
  /\ hinted = {}
  /\ missed = {}
  /\ dirty = {}
  /\ latest = [p \in Paths |-> 0]
  /\ userEdits = 0
  /\ remoteEdits = 0
  /\ cycles = 0
  /\ age = 0
  /\ lastApply = [kind |-> "none", deferred |-> {}, untouched |-> {}]
  /\ rescued = FALSE

UserEdit(p, delivered) ==
  /\ userEdits < MaxUserEdits
  /\ disk' = [disk EXCEPT ![p] = Fresh]
  /\ latest' = [latest EXCEPT ![p] = Fresh]
  /\ dirty' = dirty \cup {p}
  /\ hinted' = IF delivered THEN hinted \cup {p} ELSE hinted
  /\ missed' = IF delivered THEN missed \ {p} ELSE missed \cup {p}
  /\ userEdits' = userEdits + 1
  /\ UNCHANGED <<server, epoch, preserved, head, abase, stale, pushed, applied,
                 remoteEdits, cycles, age, lastApply, rescued>>

\* The watcher delivered a durable hint for the edit.
UserEditHinted == \E p \in Paths : UserEdit(p, TRUE)

\* The edit's watcher event was lost (backgrounded app, platform drop).
UserEditMissedHint == \E p \in Paths : UserEdit(p, FALSE)

CaptureSet(S) ==
  /\ head' = [p \in Paths |-> IF p \in S THEN disk[p] ELSE head[p]]
  /\ pushed' = (pushed /\ \A p \in S : disk[p] = head[p])
  /\ dirty' = dirty \ S
  /\ hinted' = hinted \ S
  /\ missed' = missed \ S

\* Ordinary background capture reads only hinted paths.
HintCapture ==
  /\ hinted # {}
  /\ CaptureSet(hinted)
  /\ age' = IF missed \ hinted = {} THEN 0 ELSE age
  /\ UNCHANGED <<server, epoch, preserved, disk, abase, stale, applied, latest,
                 userEdits, remoteEdits, cycles, lastApply, rescued>>

\* Whole-vault metadata inventory: startup, resume, invalid scan state,
\* request, or the bounded schedule.
Inventory ==
  /\ ~SkipInventory
  /\ CaptureSet(Paths)
  /\ cycles' = 0
  /\ age' = 0
  /\ rescued' = (rescued \/ \E p \in missed : disk[p] # head[p])
  /\ UNCHANGED <<server, epoch, preserved, disk, abase, stale, applied, latest,
                 userEdits, remoteEdits, lastApply>>

\* One background cycle elapses; the schedule forces an inventory first.
Tick ==
  /\ cycles < (IF SkipInventory THEN CycleCap ELSE InventoryPeriod)
  /\ cycles' = cycles + 1
  /\ age' = IF missed = {} THEN 0 ELSE age + 1
  /\ UNCHANGED <<server, epoch, preserved, disk, head, abase, stale, pushed,
                 applied, hinted, missed, dirty, latest, userEdits, remoteEdits,
                 lastApply, rescued>>

\* Another client's accepted proposal changes canonical main.
RemoteEdit ==
  /\ remoteEdits < MaxRemoteEdits
  /\ \E p \in Paths : server' = [server EXCEPT ![p] = Fresh]
  /\ epoch' = epoch + 1
  /\ remoteEdits' = remoteEdits + 1
  /\ UNCHANGED <<preserved, disk, head, abase, stale, pushed, applied, hinted,
                 missed, dirty, latest, userEdits, cycles, age, lastApply, rescued>>

\* Upload and server integration of every captured change.
Push ==
  /\ ~pushed
  /\ LET changes == {p \in Paths : head[p] # abase[p]}
     IN /\ server' = [p \in Paths |->
                        IF p \in changes /\ server[p] = abase[p] THEN head[p] ELSE server[p]]
        /\ preserved' = preserved \cup {head[p] : p \in changes}
  /\ epoch' = epoch + 1
  /\ pushed' = TRUE
  /\ UNCHANGED <<disk, head, abase, stale, applied, hinted, missed, dirty, latest,
                 userEdits, remoteEdits, cycles, age, lastApply, rescued>>

\* Empty footprint and no sticky obligation: move refs and acknowledge only.
ApplyRefOnly ==
  /\ CanApply
  /\ stale = {}
  /\ RefOnlyIgnoresTree \/ Footprint = {}
  /\ head' = server
  /\ abase' = server
  /\ applied' = epoch
  /\ lastApply' = [kind |-> "ref-only", deferred |-> {}, untouched |-> dirty]
  /\ UNCHANGED <<server, epoch, preserved, disk, stale, pushed, hinted, missed,
                 dirty, latest, userEdits, remoteEdits, cycles, age, rescued>>

\* Footprint-scoped apply with in-gate re-read of every footprint path.
ApplyFootprint ==
  /\ CanApply
  /\ LET F == Footprint
         W == {p \in F : GateClean(p)}
         D == F \ W
         Sticky == {p \in stale : p \in dirty}
     IN /\ disk' = [p \in Paths |-> IF p \in W THEN server[p] ELSE disk[p]]
        /\ abase' = [p \in Paths |->
                       IF p \in Sticky THEN abase[p]
                       ELSE IF p \in D THEN head[p]
                       ELSE server[p]]
        /\ stale' = Sticky \cup D
        /\ lastApply' = [kind |-> "footprint", deferred |-> D, untouched |-> dirty \ F]
  /\ head' = server
  /\ applied' = epoch
  /\ UNCHANGED <<server, epoch, preserved, pushed, hinted, missed, dirty, latest,
                 userEdits, remoteEdits, cycles, age, rescued>>

Next ==
  \/ UserEditHinted
  \/ UserEditMissedHint
  \/ HintCapture
  \/ Inventory
  \/ Tick
  \/ RemoteEdit
  \/ Push
  \/ ApplyRefOnly
  \/ ApplyFootprint

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ WF_vars(HintCapture)
  /\ WF_vars(Inventory)
  /\ WF_vars(Push)
  /\ WF_vars(ApplyFootprint)

TypeOK ==
  /\ server \in [Paths -> Values]
  /\ epoch \in Nat
  /\ preserved \subseteq Values
  /\ disk \in [Paths -> Values]
  /\ head \in [Paths -> Values]
  /\ abase \in [Paths -> Values]
  /\ stale \subseteq Paths
  /\ pushed \in BOOLEAN
  /\ applied \in Nat
  /\ hinted \subseteq Paths
  /\ missed \subseteq Paths
  /\ dirty \subseteq Paths
  /\ latest \in [Paths -> Values]
  /\ userEdits \in 0..MaxUserEdits
  /\ remoteEdits \in 0..MaxRemoteEdits
  /\ cycles \in 0..CycleCap
  /\ age \in 0..CycleCap
  /\ lastApply \in [kind : ApplyKinds, deferred : SUBSET Paths, untouched : SUBSET Paths]
  /\ rescued \in BOOLEAN

\* OBTS-SAF-002: the latest local version stays visible, captured, or preserved by the server.
NoLocalEditLost ==
  \A p \in Paths :
    latest[p] # 0 => (latest[p] = disk[p] \/ latest[p] = head[p] \/ latest[p] \in preserved)

\* Moving refs never makes unchanged visible bytes look like a local edit
\* (which a later capture would upload as a revert of canonical content).
NoPhantomEdit ==
  \A p \in Paths \ dirty : disk[p] = head[p]

\* A deferred path keeps a base no newer than M0 until its edit settles.
StaleBaseRetained ==
  \A p \in stale : abase[p] # head[p] \/ p \notin dirty

\* The schedule bounds how long a lost watcher event can delay capture.
MissedEditBoundedDelay == age <= InventoryPeriod

SafetyInvariant ==
  /\ TypeOK
  /\ NoLocalEditLost
  /\ NoPhantomEdit
  /\ StaleBaseRetained
  /\ MissedEditBoundedDelay

EditsEventuallyCaptured == \A p \in Paths : (p \in dirty) ~> (p \notin dirty)
EventuallyConverged == <>[](dirty = {} /\ pushed /\ applied = epoch)

\* Reachability targets (each is violated by its witness).
NoRefOnlyApply == lastApply.kind # "ref-only"
NoDeferredFootprintPath == lastApply.deferred = {}
NoUntouchedEditAcrossApply == ~(lastApply.kind = "footprint" /\ lastApply.untouched \cap missed # {})
NoMissedEditRescued == ~rescued

CompanionActions == {
  "UserEditHinted",
  "UserEditMissedHint",
  "HintCapture",
  "Inventory",
  "Tick",
  "RemoteEdit",
  "Push",
  "ApplyRefOnly",
  "ApplyFootprint"
}
=============================================================================
