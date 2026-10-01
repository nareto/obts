---- MODULE OBTSStaleProposal ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
FM001/FM002 focused provenance companion, architecture revision 36.
Refines OBTS-SAF-002, OBTS-SAF-005, OBTS-SYNC-STALE-001,
OBTS-SYNC-BASE-001, OBTS-SYNC-IMM-001, OBTS-PER-STALE-001. Four paths:
p touched/stale, q inherited/known fresh revert, u untouched/fresh,
b a mixed-cohort identity (binary or absence). M0[q]={}, C[q]=RemoteQ; M0[u]=C[u]={}.
M0 -> C -> D ancestry is symbolic; K is the captured applied parent even
when canonical main advances. Recapture uses the newly applied parent/tree.
Token sets abstract exact per-path bytes/deltas, not Markdown algorithms.
Scenario chooses disjoint/overlap/binary/delete/identity, mixed binary/delete
identity with clean text, or a later apply. One crash, two local generations,
one q canonical advance and at most one later apply with ordered M0 < M1. Journal intent,
queue/base, horizon and obligations are durable; running is volatile. Clock
expiry abstracts >=3s, queue drain is a separate event. Publication is assumed.
Four isolated bounded publication projections additionally cover acknowledged P,
retirement handover, drained no-op settlement and held-P rebuild continuation. For the held fresh q revert,
a wrong proposal-base attribution makes local equal base and selects remote;
P attribution detects overlapping changes instead.
No fair delivery/liveness or actual implementation conformance is claimed.
***************************************************************************)
CONSTANTS Scenario, WrongBase, ClearAtCleanup, NullRetry, MixFresh,
          OlderBaseDiff, AllOrNothingIdentity, RebindRetry, ReplaceOldBase
ASSUME Scenario \in {"disjoint", "overlap", "binary", "delete", "identical",
                   "mixed-binary", "mixed-delete", "later-apply", "handover", "ack", "noop", "held", "held-repair"}
ASSUME WrongBase \in BOOLEAN /\ ClearAtCleanup \in BOOLEAN
ASSUME NullRetry \in BOOLEAN /\ MixFresh \in BOOLEAN
ASSUME OlderBaseDiff \in BOOLEAN /\ AllOrNothingIdentity \in BOOLEAN
ASSUME RebindRetry \in BOOLEAN /\ ReplaceOldBase \in BOOLEAN

M0 == "M0"
C == "C"
M1 == "M1"
Paths == {"p", "q", "u", "b"}
Value(kind, bytes) == [kind |-> kind, bytes |-> bytes]
Mixed == Scenario \in {"mixed-binary", "mixed-delete"}
BKind == IF Scenario = "mixed-delete" THEN "absent" ELSE "binary"
BInitial == IF Scenario = "mixed-delete" THEN {} ELSE {"identical-b"}
BNatural == IF Scenario = "mixed-delete" THEN {"old-b"} ELSE {}
None == "none"
Remote == {"remote"}
RemoteQ == {"remote-q"}
Local(g) == IF Scenario = "delete" THEN {} ELSE
            IF Scenario = "identical" THEN Remote ELSE
            IF g = 1 THEN {"local-1"} ELSE {"local-1", "local-2"}
Stages == {"plan", "ready", "commit", "queue", "clean", "admitted",
           "ref", "result", "applied", "ordinary", "pins", "rebuilt", "corrupt", "done"}
VARIABLE r
vars == <<r>>
Init == r = [stage |-> IF Scenario = "handover" THEN "result" ELSE IF Scenario = "noop" THEN "ready" ELSE "plan", running |-> TRUE, crashes |-> 0,
  mutated |-> FALSE, journal |-> TRUE, journalBase |-> M0,
  \* The no-op projection starts after the settlement claim's initial drain.
  touched |-> IF Mixed THEN {"p", "q", "b"} ELSE {"p", "q"}, horizon |-> FALSE, expired |-> FALSE, drained |-> Scenario = "noop",
  obligation |-> IF Scenario \in {"handover", "noop"} THEN M0 ELSE None, pinned |-> TRUE, generation |-> IF Scenario \in {"handover", "noop"} THEN 1 ELSE 0, settled |-> 0,
  local |-> IF Scenario = "noop" THEN Remote ELSE {}, mainP |-> Remote, mainQ |-> RemoteQ, advanced |-> FALSE,
  captured |-> 0, proposalP |-> {}, proposalQ |-> RemoteQ,
  parent |-> None, appliedParent |-> C, naturalQ |-> RemoteQ, intentBase |-> None, queueBase |-> None, boundBase |-> None,
  outcome |-> "none", integrationBase |-> None, retry |-> FALSE,
  saveKind |-> None, secondSticky |-> FALSE, crashSeam |-> None,
  restartedSeam |-> None, freshHeld |-> FALSE, freshKnown |-> FALSE, pendingConflict |-> FALSE,
  untouched |-> {}, mainU |-> {}, proposalU |-> {}, rejectedRetry |-> FALSE,
  naturalP |-> Remote, naturalU |-> {}, mainB |-> BInitial,
  naturalB |-> IF Mixed THEN Value("binary", BNatural) ELSE Value(BKind, BInitial),
  admittedBase |-> None, offeredBase |-> None, retryOffers |-> 0, differentOffered |-> FALSE,
  deviceRef |-> 0, lastRetryOutcome |-> "none", rejectedState |-> <<>>,
  postRestartRetry |-> FALSE, postRestartIntegrated |-> FALSE, restartCommit |-> 0,
  authored |-> {}, identities |-> {}, divergent |-> {}, integrationBefore |-> [x \in Paths |-> Value("absent", {})],
  laterApplied |-> FALSE, laterProposal |-> FALSE, newerBaseP |-> {}, ackKind |-> None, ackBase |-> None, retirementBase |-> None, heldKind |-> None, heldBase |-> None, heldFallback |-> M0, heldIdentity |-> "P", heldOlder |-> FALSE, heldResult |-> None, heldAssociation |-> TRUE, heldPin |-> None, heldRepaired |-> FALSE, heldRecordedMain |-> M0]

Run == r.running /\ Scenario \notin {"handover", "ack", "noop", "held", "held-repair"}
Save(kind) ==
  /\ Run /\ r.generation = 0
  /\ (r.journal \/ r.horizon) /\ "p" \in r.touched
  /\ r' = [r EXCEPT !.generation = 1, !.local = Local(1),
           !.obligation = r.journalBase, !.saveKind = kind]
PreMutationSave == /\ ~r.mutated /\ Save("pre")
GateQueuedSave == /\ r.mutated /\ r.horizon /\ Save("queued")
PostApplyFlush == /\ r.mutated /\ r.horizon /\ Save("flush")
ApplyMutation ==
  /\ Run /\ r.stage = "plan"
  \* A pre-mutation save is deferred; either route still completes C ancestry.
  /\ r' = [r EXCEPT !.mutated = TRUE, !.horizon = TRUE, !.stage = "ready"]
HorizonElapsed ==
  /\ (Run \/ Scenario = "noop") /\ r.horizon /\ ~r.expired
  /\ r' = [r EXCEPT !.expired = TRUE]
DrainAdapterQueue ==
  /\ (Run \/ Scenario = "noop") /\ r.horizon /\ r.expired /\ ~r.drained
  /\ r' = [r EXCEPT !.drained = TRUE]
EndHorizon ==
  /\ (Run \/ Scenario = "noop") /\ r.horizon /\ r.expired /\ r.drained
  /\ r' = [r EXCEPT !.horizon = FALSE,
    !.stage = IF Scenario = "noop" /\ r.stage = "applied" THEN "done" ELSE @,
    !.pinned = IF Scenario = "noop" /\ r.obligation = None THEN FALSE ELSE @]
KnownFreshRevert ==
  \* Actor authors from observed C; expiry alone is NOT evidence of reload.
  /\ Run /\ r.mutated /\ ~r.horizon /\ ~r.freshKnown
  /\ r.stage = "ready" /\ r.captured = 0
  /\ r' = [r EXCEPT !.freshKnown = TRUE, !.freshHeld = TRUE]
UntouchedFreshEdit ==
  \* A later post-settlement edit remains visible for a subsequent ordinary scan.
  /\ Run /\ r.untouched = {} /\ r.stage = "ready" /\ r.captured = 0
  /\ r' = [r EXCEPT !.untouched = {"user-u"}]
StickySecondEdit ==
  /\ Run /\ r.generation = 1 /\ r.settled < 1
  /\ r.stage = "queue"
  /\ r' = [r EXCEPT !.generation = 2, !.local = Local(2),
           !.secondSticky = TRUE]
CreateCohortCommit ==
  /\ Run /\ r.stage = "ready" /\ r.generation > r.settled
  /\ r' = [r EXCEPT !.stage = "commit", !.captured = r.generation,
    !.proposalP = r.local, !.proposalQ = IF MixFresh /\ r.freshHeld THEN {} ELSE r.mainQ,
    !.naturalQ = r.mainQ, !.naturalP = r.mainP, !.naturalU = r.mainU,
    !.naturalB = IF Mixed /\ r.captured = 0 THEN Value("binary", BNatural) ELSE Value(BKind, r.mainB),
    !.parent = r.appliedParent, !.intentBase = IF WrongBase THEN C ELSE r.obligation,
    !.queueBase = None, !.boundBase = None, !.admittedBase = None, !.outcome = "none",
    !.offeredBase = None, !.retryOffers = 0, !.differentOffered = FALSE, !.retry = FALSE,
    !.lastRetryOutcome = "none", !.postRestartRetry = FALSE,
    !.postRestartIntegrated = FALSE, !.laterProposal = r.laterApplied]
PublishQueue ==
  /\ Run /\ r.stage = "commit"
  /\ r' = [r EXCEPT !.stage = "queue", !.queueBase = r.intentBase]
CleanupJournal ==
  /\ Run /\ r.stage = "queue"
  \* Horizon, obligation and intent already have durable queue/state ownership.
  /\ r' = [r EXCEPT !.stage = "clean", !.journal = FALSE,
    !.obligation = IF ClearAtCleanup THEN None ELSE @]
AdmitProposal ==
  /\ Run /\ r.stage = "clean"
  /\ r' = [r EXCEPT !.stage = "admitted", !.boundBase = r.queueBase, !.admittedBase = r.queueBase]
AdvanceCanonical ==
  /\ Run /\ r.stage = "admitted" /\ ~r.advanced
  /\ r' = [r EXCEPT !.advanced = TRUE, !.mainQ = RemoteQ \cup {"new-remote-q"}]
MoveDeviceRef ==
  /\ Run /\ r.stage = "admitted"
  /\ r' = [r EXCEPT !.stage = "ref", !.deviceRef = r.captured]
\* K and D are independently frozen at commit creation. Kind is part of identity.
\* In mixed scenarios M0[b] precedes K[b], while canonical main has independently
\* reached the same b value as the stale cohort. q remains inherited from K.
NaturalTree == [x \in Paths |-> CASE x = "p" -> Value(IF Scenario = "binary" THEN "binary" ELSE "text", r.naturalP)
  [] x = "q" -> Value("binary", r.naturalQ)
  [] x = "u" -> Value("text", r.naturalU)
  [] OTHER -> r.naturalB]
ProposalTree == [x \in Paths |-> CASE x = "p" ->
    Value(IF Scenario = "delete" THEN "absent" ELSE IF Scenario = "binary" THEN "binary" ELSE "text", r.proposalP)
  [] x = "q" -> Value("binary", r.proposalQ)
  [] x = "u" -> Value("text", r.proposalU)
  [] OTHER -> Value(BKind, BInitial)]
MainTree == [x \in Paths |-> CASE x = "p" ->
    Value(IF Scenario = "binary" THEN "binary" ELSE "text", r.mainP)
  [] x = "q" -> Value("binary", r.mainQ)
  [] x = "u" -> Value("text", r.mainU)
  [] OTHER -> Value(BKind, r.mainB)]
BaseTree(base) == IF base \in {C, None} THEN NaturalTree ELSE
  [x \in Paths |-> CASE x = "p" ->
      Value(IF Scenario = "binary" THEN "binary" ELSE "text", IF base = M1 THEN r.newerBaseP ELSE {})
    [] x = "q" -> Value("binary", {})
    [] x = "u" -> Value("text", {})
    [] OTHER -> IF Mixed THEN Value("binary", {"base-b"}) ELSE Value(BKind, BInitial)]
Changed(left, right) == {x \in Paths : left[x] # right[x]}
ActualAuthored == Changed(NaturalTree, ProposalTree)
Authored == IF OlderBaseDiff THEN Changed(BaseTree(r.boundBase), ProposalTree) ELSE ActualAuthored
Identities == {x \in Authored : MainTree[x] = ProposalTree[x]}
Divergent == IF AllOrNothingIdentity /\ Identities # Authored THEN Authored ELSE Authored \ Identities
CanMergePath(x) ==
  \/ MainTree[x] = BaseTree(r.boundBase)[x]
  \/ ProposalTree[x] = BaseTree(r.boundBase)[x]
  \/ (MainTree[x].kind = "text" /\ ProposalTree[x].kind = "text"
       /\ (x # "p" \/ Scenario \in {"disjoint", "mixed-binary", "mixed-delete", "later-apply"}))
MergePath(x) == IF ProposalTree[x] = BaseTree(r.boundBase)[x] THEN MainTree[x]
  ELSE IF MainTree[x] = BaseTree(r.boundBase)[x] THEN ProposalTree[x]
  ELSE Value("text", MainTree[x].bytes \cup ProposalTree[x].bytes)
RetryState == <<r.admittedBase, r.boundBase, r.deviceRef, r.mainP, r.mainQ, r.mainU, r.mainB>>
OfferRetryBase(base) ==
  /\ Run /\ r.stage = "ref" /\ r.offeredBase = None /\ ~r.retry
  /\ r' = [r EXCEPT !.offeredBase = base, !.retryOffers = @ + 1,
    !.differentOffered = IF base # r.admittedBase THEN TRUE ELSE @]
OfferSameRetryBase == OfferRetryBase(r.admittedBase)
OfferDifferentRetryBase == /\ ~r.differentOffered /\ OfferRetryBase(C)
RetryExistingDeviceCommit ==
  /\ Run /\ r.stage = "ref" /\ r.offeredBase # None
  /\ r.offeredBase = r.admittedBase /\ ~r.retry
  /\ r' = [r EXCEPT !.retry = TRUE, !.offeredBase = None,
    !.boundBase = IF NullRetry THEN None ELSE r.admittedBase,
    !.lastRetryOutcome = "accepted",
    !.postRestartRetry = r.restartedSeam = "ref" /\ r.restartCommit = r.captured]
RejectDifferentRetryBase ==
  /\ Run /\ r.stage = "ref" /\ r.offeredBase # None
  /\ r.offeredBase # r.admittedBase /\ ~RebindRetry
  /\ r' = [r EXCEPT !.rejectedRetry = TRUE, !.offeredBase = None,
    !.lastRetryOutcome = "rejected", !.rejectedState = RetryState]
RebindDifferentRetryBase ==
  /\ Run /\ r.stage = "ref" /\ r.offeredBase # None
  /\ r.offeredBase # r.admittedBase /\ RebindRetry
  /\ r' = [r EXCEPT !.rejectedRetry = TRUE, !.admittedBase = r.offeredBase,
    !.boundBase = r.offeredBase, !.offeredBase = None, !.lastRetryOutcome = "accepted"]
IntegrateThreeWay ==
  /\ Run /\ r.stage = "ref" /\ r.offeredBase = None
  /\ r.lastRetryOutcome # "rejected"
  /\ LET conflict == \E x \in Divergent : ~CanMergePath(x)
         result == [x \in Paths |-> IF conflict \/ x \notin Divergent THEN MainTree[x] ELSE MergePath(x)]
     IN r' = [r EXCEPT !.stage = "result", !.integrationBase = r.boundBase,
       !.outcome = IF conflict THEN "conflict" ELSE "merged",
       !.integrationBefore = MainTree, !.authored = Authored,
       !.identities = Identities, !.divergent = Divergent,
       !.mainP = result["p"].bytes, !.mainQ = result["q"].bytes,
       !.mainU = result["u"].bytes, !.mainB = result["b"].bytes,
       !.postRestartIntegrated = r.postRestartRetry /\ r.boundBase = M0]
ApplySettledContent ==
  /\ Run /\ r.stage = "result" /\ r.outcome = "merged"
  /\ r' = [r EXCEPT !.stage = "applied", !.settled = r.captured, !.appliedParent = "settled-C",
    !.obligation = IF r.captured = r.generation THEN None ELSE @,
    !.local = IF r.captured = r.generation THEN r.mainP ELSE @]
HandoverPendingConflict ==
  /\ Run /\ r.stage = "result" /\ r.outcome = "conflict"
  /\ r' = [r EXCEPT !.stage = "done", !.pendingConflict = TRUE,
           !.obligation = None]
LaterApplyDefersSticky ==
  /\ Run /\ Scenario = "later-apply" /\ r.stage = "applied"
  /\ r.generation > r.settled /\ ~r.laterApplied
  \* M1 is the already-settled canonical parent, newer than M0. A second apply
  \* advances canonical again but defers p's generation-2 local bytes.
  /\ r' = [r EXCEPT !.laterApplied = TRUE, !.journalBase = M1,
    !.newerBaseP = r.mainP, !.mainP = @ \cup {"later-remote"},
    !.appliedParent = "later-C", !.obligation = IF ReplaceOldBase THEN M1 ELSE @]
RecaptureLatestSticky ==
  /\ Run /\ r.stage = "applied" /\ r.generation > r.settled
  /\ r' = [r EXCEPT !.stage = "ready"]
SettleFreshSequentially ==
  /\ Run /\ r.stage = "applied" /\ r.generation = r.settled
  /\ r' = [r EXCEPT !.stage = "ordinary", !.mainQ = IF r.freshHeld THEN {} ELSE @,
    !.mainU = r.untouched, !.freshHeld = FALSE]
Finish ==
  /\ Run /\ r.stage = "ordinary"
  /\ r' = [r EXCEPT !.stage = "done"]
Crash ==
  /\ Run /\ r.crashes = 0
  /\ r.stage \in {"commit", "queue", "clean", "ref"}
  /\ r' = [r EXCEPT !.running = FALSE, !.crashes = 1, !.crashSeam = r.stage,
    !.retry = FALSE, !.offeredBase = None, !.lastRetryOutcome = "none",
    !.postRestartRetry = FALSE]
Restart ==
  /\ ~Run
  /\ r' = [r EXCEPT !.running = TRUE, !.restartedSeam = r.crashSeam, !.restartCommit = r.captured]
\* Bounded physical-publication projections: one retirement save or no-op.
RetirementPublication ==
  /\ r.running /\ Scenario = "handover" /\ r.stage = "result"
  /\ r' = [r EXCEPT !.stage = "applied", !.obligation = None,
    !.horizon = ~ClearAtCleanup, !.retirementBase = IF ClearAtCleanup THEN C ELSE M0]
LateRetirementSave ==
  /\ r.running /\ Scenario \in {"handover", "noop"} /\ r.stage = "applied"
  /\ Scenario = "handover" \/ r.horizon \/ ClearAtCleanup
  /\ r' = [r EXCEPT !.stage = "done", !.local = Local(1),
    !.obligation = r.retirementBase, !.saveKind = "retirement"]
NoopSettlement ==
  /\ r.running /\ Scenario = "noop" /\ r.stage = "ready"
  /\ ~r.horizon /\ r.drained /\ r.local = r.mainP
  /\ r' = [r EXCEPT !.stage = "applied", !.settled = r.generation,
    !.obligation = None, !.horizon = ~ClearAtCleanup, !.pinned = ~ClearAtCleanup,
    !.expired = FALSE, !.drained = FALSE,
    !.retirementBase = IF ClearAtCleanup THEN C ELSE M0]
AckQBase == IF WrongBase THEN {} ELSE RemoteQ
AckQTarget == RemoteQ \cup {"second-remote-q"}
AckQConflict == AckQTarget # AckQBase /\ {} # AckQBase /\ AckQTarget # {}
AckQResult == IF AckQConflict \/ {} = AckQBase THEN AckQTarget ELSE {}
AcknowledgeProposal ==
  /\ r.running /\ Scenario = "ack" /\ r.stage = "plan"
  /\ \E kind \in {"ordinary", "stale", "stale-remote-q", "missing", "contained"} :
    r' = [r EXCEPT !.stage = "done", !.ackKind = kind,
      !.ackBase = IF kind \in {"missing", "contained"} THEN M0 ELSE "P",
      !.retirementBase = IF kind \in {"stale", "stale-remote-q"} THEN M0 ELSE None,
      !.freshHeld = kind = "stale-remote-q",
      !.mainQ = IF kind = "stale-remote-q" THEN AckQResult ELSE @,
      !.proposalQ = IF kind = "stale-remote-q" THEN {} ELSE @,
      !.pendingConflict = kind = "stale-remote-q" /\ AckQConflict]
\* Rebuild holds a later same-line edit on P's recorded footprint. Independent
\* older evidence cannot be upgraded. Durable identity/fallback survive a crash.
PrepareOriginalPins ==
  /\ r.running /\ Scenario = "held-repair" /\ r.stage = "plan"
  \* Snapshot before either held publication or F5 creates a fallback pin.
  /\ \E older \in BOOLEAN : r' = [r EXCEPT !.stage = "pins",
       !.heldOlder = older, !.heldPin = IF older THEN M0 ELSE None,
       !.heldBase = IF older THEN M0 ELSE None]
HoldPDerived ==
  /\ r.running /\ Scenario \in {"held", "held-repair"}
  /\ r.stage = IF Scenario = "held-repair" THEN "pins" ELSE "plan"
  /\ \E older \in (IF Scenario = "held-repair" THEN {r.heldOlder} ELSE BOOLEAN) :
    r' = [r EXCEPT !.stage = "ready", !.heldOlder = older,
       !.heldBase = IF older THEN M0 ELSE "P",
       \* A durably recorded M0 fallback is protected even when the base is P.
       !.heldPin = IF Scenario = "held-repair" \/ older THEN M0 ELSE None]
HeldCrash ==
  /\ r.running /\ Scenario \in {"held", "held-repair"} /\ r.stage \in {"ready", "applied"} /\ r.crashes = 0
  /\ r' = [r EXCEPT !.running = FALSE, !.crashes = 1, !.crashSeam = r.stage]
AdvanceHeldCanonical ==
  /\ r.running /\ Scenario = "held-repair" /\ r.stage = "ready" /\ ~r.heldRepaired
  \* Rebuild applies remote C while P is still held/queued (before P settles).
  /\ r' = [r EXCEPT !.stage = "rebuilt", !.heldRecordedMain = C]
\* First corruption precedes held publication; prior-held corruption follows
\* canonical advancement with the recorded M0 fallback pin still protected.
\* Path association is lost, so even another path's pin covers repair paths.
CorruptCompanion ==
  /\ r.running /\ Scenario = "held-repair" /\ ~r.heldRepaired
  /\ r.stage \in {"pins", "rebuilt"}
  /\ r' = [r EXCEPT !.stage = "corrupt", !.heldAssociation = FALSE]
RepairCompanion ==
  /\ r.running /\ Scenario = "held-repair" /\ r.stage = "corrupt" /\ ~r.heldAssociation
  /\ r' = [r EXCEPT !.stage = "ready", !.heldRepaired = TRUE,
       !.heldOlder = r.heldPin = M0,
       !.heldBase = IF r.heldPin = M0 /\ ~WrongBase THEN M0 ELSE r.heldIdentity,
       !.heldFallback = IF r.heldPin = M0 /\ ~WrongBase THEN M0 ELSE r.heldRecordedMain,
       \* Only after using the original snapshot may repair publish its own pin.
       !.heldPin = M0]
ReplaceHeldP ==
  /\ r.running /\ Scenario \in {"held", "held-repair"} /\ r.stage = "ready" /\ r.heldIdentity = "P"
  /\ r' = [r EXCEPT !.heldIdentity = "P-successor"]
SettleHeldP ==
  /\ r.running /\ Scenario \in {"held", "held-repair"} /\ r.stage = "ready"
  /\ \E kind \in {"acknowledged", "conflicted", "rejected"} :
    r' = [r EXCEPT !.stage = "applied", !.heldKind = kind,
      !.heldBase = IF r.heldOlder THEN M0 ELSE
        IF kind = "acknowledged" THEN IF WrongBase THEN M0 ELSE r.heldIdentity
        ELSE IF ReplaceOldBase THEN C ELSE r.heldFallback]
ProposeHeldP ==
  /\ r.running /\ Scenario \in {"held", "held-repair"} /\ r.stage = "applied"
  \* Same-line values: pre-P="old", P="typed", local="continued".
  \* With fallback, remote="remote"; selecting newer C makes a false fast-forward.
  /\ LET base == IF r.heldBase = C THEN "remote" ELSE
                   IF r.heldBase = M0 THEN "old" ELSE "typed"
         remote == IF r.heldKind = "acknowledged" THEN "typed" ELSE "remote"
         conflict == remote # base /\ "continued" # base
     IN r' = [r EXCEPT !.stage = "done", !.pendingConflict = conflict,
       !.heldResult = IF conflict THEN remote ELSE "continued"]
HeldOwnEditNoFalseConflict == Scenario \in {"held", "held-repair"} /\ r.stage = "done" /\
  r.heldKind = "acknowledged" /\ ~r.heldOlder =>
    ~r.pendingConflict /\ r.heldResult = "continued"
HeldOlderWins == Scenario \in {"held", "held-repair"} /\ r.heldOlder => r.heldBase = M0
HeldFallbackRecorded == Scenario \in {"held", "held-repair"} /\ r.stage \in {"applied", "done"} /\
  r.heldKind # "acknowledged" => r.heldBase = r.heldFallback
RetirementKeepsOldBase == Scenario \in {"handover", "noop"} /\ r.saveKind = "retirement" => r.obligation = M0
AcknowledgedAuthoringBase == Scenario = "ack" /\ r.stage = "done" =>
  /\ r.ackBase = IF r.ackKind \in {"missing", "contained"} THEN M0 ELSE "P"
  /\ (r.ackKind \in {"stale", "stale-remote-q"} => r.retirementBase = M0)
KnownFreshRevertNotLost == Scenario = "ack" /\ r.stage = "done" /\ r.freshHeld =>
  r.pendingConflict \/ r.mainQ = {}
NoopReleasesPin == Scenario = "noop" /\ r.obligation = None =>
  (r.horizon /\ r.pinned) \/ (r.stage = "done" /\ ~r.pinned /\ r.expired /\ r.drained /\ r.local = r.mainP)
NoRetirementSave == ~(Scenario = "handover" /\ r.stage = "done")
NoNoopSettlement == ~(Scenario = "noop" /\ r.stage = "applied")
NoAcknowledgedProposal == ~(Scenario = "ack" /\ r.stage = "done")
Next == PreMutationSave \/ GateQueuedSave \/ PostApplyFlush \/ ApplyMutation
  \/ HorizonElapsed \/ DrainAdapterQueue \/ EndHorizon \/ KnownFreshRevert
  \/ UntouchedFreshEdit \/ StickySecondEdit
  \/ CreateCohortCommit \/ PublishQueue \/ CleanupJournal \/ AdmitProposal
  \/ AdvanceCanonical \/ MoveDeviceRef \/ OfferSameRetryBase \/ OfferDifferentRetryBase
  \/ RetryExistingDeviceCommit \/ RebindDifferentRetryBase
  \/ RejectDifferentRetryBase \/ IntegrateThreeWay \/ ApplySettledContent \/ HandoverPendingConflict \/ LaterApplyDefersSticky \/ RecaptureLatestSticky
  \/ SettleFreshSequentially \/ Finish \/ Crash \/ Restart
  \/ RetirementPublication \/ LateRetirementSave \/ NoopSettlement \/ AcknowledgeProposal
  \/ PrepareOriginalPins \/ AdvanceHeldCanonical \/ CorruptCompanion \/ RepairCompanion \/ HeldCrash \/ HoldPDerived \/ ReplaceHeldP \/ SettleHeldP \/ ProposeHeldP
  \/ (r.stage \in {"ready", "done"} /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ r.stage \in Stages /\ r.running \in BOOLEAN /\ r.crashes \in 0..1
  /\ r.generation \in 0..2 /\ r.settled \in 0..r.generation
  /\ r.captured \in 0..r.generation
  /\ r.obligation \in {None, M0, M1, C} /\ r.intentBase \in {None, M0, M1, C}
  /\ r.queueBase \in {None, M0, M1, C} /\ r.boundBase \in {None, M0, M1, C}
  /\ r.admittedBase \in {None, M0, M1, C} /\ r.offeredBase \in {None, M0, M1, C}
  /\ r.retryOffers \in 0..3 /\ r.deviceRef \in 0..2
StaleProposalUsesAuthoringBase ==
  /\ (r.generation > r.settled /\ ~r.pendingConflict => r.obligation = M0 /\ r.pinned)
  /\ (r.stage \in {"commit", "queue", "clean", "admitted", "ref", "result"}
       => r.intentBase = M0)
  /\ (r.stage \in {"queue", "clean", "admitted", "ref", "result"}
       => r.queueBase = M0)
  /\ (r.stage \in {"admitted", "ref", "result"} => r.boundBase = M0)
NoSilentRemoteReplacement ==
  IF Scenario \in {"held", "held-repair"} THEN
    (r.stage = "done" /\ r.heldKind # "acknowledged" => r.pendingConflict /\ r.heldResult = "remote")
  ELSE
  /\ (r.outcome = "merged" => r.integrationBase = M0)
  /\ (r.outcome = "conflict" => r.mainP = Remote)
  /\ (Scenario \in {"disjoint", "mixed-binary", "mixed-delete", "later-apply"} => Remote \subseteq r.mainP)
OriginCohortsSeparated ==
  r.stage \in {"commit", "queue", "clean", "admitted", "ref", "result"}
    => r.proposalQ = r.naturalQ /\ r.proposalU = {}
Integrated == r.stage \in {"result", "applied"} \/ r.pendingConflict
AuthoredFromNaturalBase == Integrated => r.authored = ActualAuthored
IdentitySetExact == Integrated => r.identities = {x \in r.authored : r.integrationBefore[x] = ProposalTree[x]}
IdentityFilteredPerPath == Integrated => r.divergent = r.authored \ r.identities
InheritedCanonicalRetained == Integrated =>
  \A x \in Paths \ ActualAuthored : MainTree[x] = r.integrationBefore[x]
CleanTextProposalMerged == Scenario \in {"disjoint", "mixed-binary", "mixed-delete", "later-apply"} /\ Integrated => r.outcome = "merged"
MixedProposalMerged == Mixed /\ Integrated => r.outcome = "merged"
RetryAdmissionImmutable == r.stage \in {"admitted", "ref", "result"} => r.admittedBase = r.intentBase
RejectedRetryDidNotMoveState == r.lastRetryOutcome = "rejected" => RetryState = r.rejectedState
OldestBaseSurvivesLaterApply == r.laterApplied /\ r.generation > r.settled => r.obligation = M0
NoDisjointMerge == ~(r.outcome = "merged" /\ r.mainP = Remote \cup Local(r.captured))
NoOverlappingConflict == r.outcome # "conflict"
NoStickySecondEdit == ~r.secondSticky
NoPreMutationSave == r.saveKind # "pre"
NoGateQueuedSave == r.saveKind # "queued"
NoPostApplyFlush == r.saveKind # "flush"
NoCommitCrashRestart == r.restartedSeam # "commit"
NoQueueCrashRestart == r.restartedSeam # "queue"
NoCleanupCrashRestart == r.restartedSeam # "clean"
NoRefCrashRetry == ~(r.postRestartIntegrated /\ r.outcome = "merged" /\ r.integrationBase = M0)
NoHorizonDrain == ~(r.expired /\ r.drained /\ ~r.horizon)
NoSequentialFreshRevert == ~(r.stage = "ordinary" /\ r.freshKnown /\ r.mainQ = {})
NoLaterStickySettlement == ~(r.settled = 2 /\ r.stage = "applied")
NoUntouchedFreshSettlement == ~(r.stage = "ordinary" /\ r.mainU = {"user-u"})
NoDifferentRetryRejected == ~(r.rejectedRetry /\ r.lastRetryOutcome = "rejected" /\ RetryState = r.rejectedState)
NoHorizonCrashRestart == ~(r.restartedSeam # None /\ r.horizon)
NoRejectedThenSameBaseIntegration == ~(r.rejectedRetry /\ r.retry /\ r.outcome = "merged" /\ r.admittedBase = M0)
NoMixedIdentityMerge == ~(Mixed /\ r.outcome = "merged" /\ r.identities = {"b"} /\ r.divergent = {"p"})
NoLaterApplyProposal == ~(r.laterProposal /\ r.stage = "result" /\ r.integrationBase = M0 /\ r.outcome = "merged" /\ "later-remote" \in r.mainP)
NoInheritedAdvance == ~(r.advanced /\ r.outcome = "merged" /\ "new-remote-q" \in r.mainQ)
CompanionActions == {
  "PreMutationSave",
  "GateQueuedSave",
  "PostApplyFlush",
  "ApplyMutation",
  "HorizonElapsed",
  "DrainAdapterQueue",
  "EndHorizon",
  "KnownFreshRevert",
  "UntouchedFreshEdit",
  "StickySecondEdit",
  "CreateCohortCommit",
  "PublishQueue",
  "CleanupJournal",
  "AdmitProposal",
  "AdvanceCanonical",
  "MoveDeviceRef",
  "OfferSameRetryBase",
  "OfferDifferentRetryBase",
  "RetryExistingDeviceCommit",
  "RebindDifferentRetryBase",
  "RejectDifferentRetryBase",
  "IntegrateThreeWay",
  "ApplySettledContent",
  "HandoverPendingConflict",
  "LaterApplyDefersSticky",
  "RecaptureLatestSticky",
  "SettleFreshSequentially",
  "Finish",
  "Crash",
  "Restart",
  "RetirementPublication",
  "LateRetirementSave",
  "NoopSettlement",
  "AcknowledgeProposal",
  "PrepareOriginalPins",
  "AdvanceHeldCanonical",
  "CorruptCompanion",
  "RepairCompanion",
  "HeldCrash",
  "HoldPDerived",
  "ReplaceHeldP",
  "SettleHeldP",
  "ProposeHeldP"
}
=============================================================================
