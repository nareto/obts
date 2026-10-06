---- MODULE OBTSAtomicRename ----
EXTENDS Naturals, FiniteSets, TLC

\* OBTS-FM-014, architecture revision 46. One pair, three paths, two local versions.
\* Trees/bytes, Git ancestry and content-merge eligibility are finite abstractions.
CONSTANT Mutation
Paths == {"A", "B", "C"}
Contents == {"absent", "source-v0", "rename-edit-v1", "successor-v2", "remote"}
BaseTree == [p \in Paths |-> IF p = "A" THEN "source-v0" ELSE IF p = "C" THEN "absent" ELSE "absent"]
NoPath == "none"
NoBase == "none"
NoTree == [p \in Paths |-> "absent"]
Rename == <<"A", "B">>
SuccessorRename == <<"B", "C">>
VARIABLES phase, renamePairs, localTree, proposalTree, captured, capturedContent,
          frozen, frozenPair, frozenBase, frozenTree, frozenTarget,
          requestPair, requestBase, requestTree, requestTarget, attempts,
          restarted, successorChanged, successorPair, admitted, integrationResult,
          canonicalTree, conflictSnapshot, protected, protectedProposalContent,
          retired, resultApplied
vars == <<phase, renamePairs, localTree, proposalTree, captured, capturedContent,
          frozen, frozenPair, frozenBase, frozenTree, frozenTarget,
          requestPair, requestBase, requestTree, requestTarget, attempts,
          restarted, successorChanged, successorPair, admitted, integrationResult,
          canonicalTree, conflictSnapshot, protected, protectedProposalContent,
          retired, resultApplied>>

Init ==
  /\ phase = "watching" /\ renamePairs = {}
  /\ localTree = BaseTree /\ proposalTree = BaseTree
  /\ captured = FALSE /\ capturedContent = "absent"
  /\ frozen = FALSE /\ frozenPair = <<NoPath, NoPath>>
  /\ frozenBase = NoBase /\ frozenTree = NoTree /\ frozenTarget = "none"
  /\ requestPair = <<NoPath, NoPath>> /\ requestBase = NoBase
  /\ requestTree = NoTree /\ requestTarget = "none" /\ attempts = 0
  /\ restarted = FALSE /\ successorChanged = FALSE
  /\ successorPair = <<NoPath, NoPath>> /\ admitted = FALSE
  /\ integrationResult = "pending" /\ canonicalTree = BaseTree
  /\ conflictSnapshot = NoTree /\ protected = FALSE
  /\ protectedProposalContent = "absent" /\ retired = FALSE /\ resultApplied = FALSE

RecordWatcherPair ==
  /\ phase = "watching" /\ renamePairs = {}
  /\ renamePairs' = {Rename}
  /\ localTree' = [BaseTree EXCEPT !["A"] = "absent", !["B"] = "rename-edit-v1"]
  /\ phase' = "recorded"
  /\ UNCHANGED <<proposalTree, captured, capturedContent, frozen, frozenPair,
       frozenBase, frozenTree, frozenTarget, requestPair, requestBase,
       requestTree, requestTarget, attempts, restarted, successorChanged,
       successorPair, admitted, integrationResult, canonicalTree,
       conflictSnapshot, protected, protectedProposalContent, retired, resultApplied>>

CapturePair ==
  /\ phase = "recorded" /\ renamePairs = {Rename}
  /\ localTree["A"] = "absent" /\ localTree["B"] = "rename-edit-v1"
  /\ captured' = TRUE /\ capturedContent' = localTree["B"]
  /\ proposalTree' = IF Mutation = "half-capture"
       THEN [localTree EXCEPT !["B"] = "absent"]
       ELSE localTree
  /\ protectedProposalContent' = localTree["B"]
  /\ phase' = "captured"
  /\ UNCHANGED <<renamePairs, localTree, frozen, frozenPair, frozenBase,
       frozenTree, frozenTarget, requestPair, requestBase, requestTree,
       requestTarget, attempts, restarted, successorChanged, successorPair,
       admitted, integrationResult, canonicalTree, conflictSnapshot, protected,
       retired, resultApplied>>

CapturedPairComplete == captured => proposalTree["A"] = "absent"
  /\ proposalTree["B"] = capturedContent /\ capturedContent # "absent"

FreezeAttempt ==
  /\ phase = "captured" /\ CapturedPairComplete
  /\ frozen' = TRUE /\ frozenPair' = Rename /\ frozenBase' = "M0"
  /\ frozenTree' = proposalTree /\ frozenTarget' = "device-commit-1"
  /\ requestPair' = Rename /\ requestBase' = "M0"
  /\ requestTree' = proposalTree /\ requestTarget' = "device-commit-1"
  /\ phase' = "frozen"
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       attempts, restarted, successorChanged, successorPair, admitted,
       integrationResult, canonicalTree, conflictSnapshot, protected,
       protectedProposalContent, retired, resultApplied>>

RetryAttempt ==
  /\ frozen /\ phase \in {"frozen", "restarted", "admitted"} /\ attempts < 1
  /\ attempts' = attempts + 1
  /\ requestPair' = IF Mutation = "rebind" THEN SuccessorRename ELSE frozenPair
  /\ requestBase' = IF Mutation = "rebind" THEN "M1" ELSE frozenBase
  /\ requestTree' = IF Mutation = "rebind" THEN localTree ELSE frozenTree
  /\ requestTarget' = frozenTarget
  /\ UNCHANGED <<phase, renamePairs, localTree, proposalTree, captured,
       capturedContent, frozen, frozenPair, frozenBase, frozenTree, frozenTarget,
       restarted, successorChanged, successorPair, admitted, integrationResult,
       canonicalTree, conflictSnapshot, protected, protectedProposalContent,
       retired, resultApplied>>

CrashAndRestart ==
  /\ frozen /\ ~restarted /\ phase \in {"frozen", "restarted"}
  /\ restarted' = TRUE /\ phase' = "restarted"
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, successorChanged,
       successorPair, admitted, integrationResult, canonicalTree,
       conflictSnapshot, protected, protectedProposalContent, retired, resultApplied>>

SuccessorRenameWithEdit ==
  /\ frozen /\ ~successorChanged
  /\ localTree' = [localTree EXCEPT !["B"] = "absent", !["C"] = "successor-v2"]
  /\ successorChanged' = TRUE /\ successorPair' = SuccessorRename
  /\ phase' = "successor-edited"
  /\ UNCHANGED <<renamePairs, proposalTree, captured, capturedContent, frozen,
       frozenPair, frozenBase, frozenTree, frozenTarget, requestPair, requestBase,
       requestTree, requestTarget, attempts, restarted, admitted, integrationResult,
       canonicalTree, conflictSnapshot, protected, protectedProposalContent,
       retired, resultApplied>>

RemoteOccupyDestination ==
  /\ captured /\ canonicalTree["B"] = "absent" /\ phase \notin {"integrated", "conflict", "applied", "settled"}
  /\ canonicalTree' = [canonicalTree EXCEPT !["B"] = "remote"]
  /\ UNCHANGED <<phase, renamePairs, localTree, proposalTree, captured,
       capturedContent, frozen, frozenPair, frozenBase, frozenTree, frozenTarget,
       requestPair, requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, integrationResult,
       conflictSnapshot, protected, protectedProposalContent, retired, resultApplied>>

AdmitExplicitPair ==
  /\ frozen /\ requestBase = frozenBase /\ requestPair = frozenPair
  /\ requestTree = frozenTree /\ requestTarget = frozenTarget
  /\ requestPair = Rename /\ requestBase = "M0"
  /\ BaseTree["A"] # "absent" /\ BaseTree["B"] = "absent"
  /\ requestTree["A"] = "absent" /\ requestTree["B"] # "absent"
  /\ phase \in {"frozen", "restarted", "successor-edited"}
  /\ admitted' = TRUE /\ phase' = "admitted"
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, integrationResult, canonicalTree,
       conflictSnapshot, protected, protectedProposalContent, retired, resultApplied>>

IntegrateClean ==
  /\ admitted /\ integrationResult = "pending"
  /\ canonicalTree["A"] = BaseTree["A"] /\ canonicalTree["B"] = "absent"
  /\ integrationResult' = "merged" /\ phase' = "integrated"
  /\ canonicalTree' = IF Mutation = "half-integration"
       THEN [canonicalTree EXCEPT !["A"] = "absent"]
       ELSE frozenTree
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, conflictSnapshot, protected,
       protectedProposalContent, retired, resultApplied>>

IntegrateConflict ==
  /\ admitted /\ integrationResult = "pending"
  /\ (canonicalTree["B"] # "absent" \/ canonicalTree["A"] # BaseTree["A"])
  /\ integrationResult' = "conflict" /\ phase' = "conflict"
  /\ protected' = TRUE /\ conflictSnapshot' = canonicalTree
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, canonicalTree,
       protectedProposalContent, retired, resultApplied>>

ApplyMergedResult ==
  /\ integrationResult = "merged" /\ ~resultApplied
  /\ resultApplied' = TRUE /\ phase' = "applied"
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, integrationResult, canonicalTree,
       conflictSnapshot, protected, protectedProposalContent, retired>>

RetireSettledPair ==
  /\ resultApplied /\ ~retired /\ integrationResult = "merged"
  /\ retired' = TRUE /\ phase' = "settled"
  /\ UNCHANGED <<renamePairs, localTree, proposalTree, captured, capturedContent,
       frozen, frozenPair, frozenBase, frozenTree, frozenTarget, requestPair,
       requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, integrationResult, canonicalTree,
       conflictSnapshot, protected, protectedProposalContent, resultApplied>>

EarlyRetire ==
  /\ Mutation = "early-retire" /\ frozen /\ ~retired
  /\ retired' = TRUE
  /\ UNCHANGED <<phase, renamePairs, localTree, proposalTree, captured,
       capturedContent, frozen, frozenPair, frozenBase, frozenTree, frozenTarget,
       requestPair, requestBase, requestTree, requestTarget, attempts, restarted,
       successorChanged, successorPair, admitted, integrationResult,
       canonicalTree, conflictSnapshot, protected, protectedProposalContent,
       resultApplied>>

Next == RecordWatcherPair \/ CapturePair \/ FreezeAttempt \/ RetryAttempt
  \/ CrashAndRestart \/ SuccessorRenameWithEdit \/ RemoteOccupyDestination
  \/ AdmitExplicitPair \/ IntegrateClean \/ IntegrateConflict \/ ApplyMergedResult
  \/ RetireSettledPair \/ EarlyRetire \/ UNCHANGED vars

ImmutableAttempt == frozen => requestPair = frozenPair /\ requestBase = frozenBase
  /\ requestTree = frozenTree /\ requestTarget = frozenTarget
OldestApplicableBaseRetained == frozen => frozenBase = "M0"
AdmissionValidatesTreePair == admitted => BaseTree["A"] # "absent"
  /\ BaseTree["B"] = "absent" /\ requestTree["A"] = "absent"
  /\ requestTree["B"] # "absent"
MergedTreeContainsPair == integrationResult = "merged" => canonicalTree["A"] = "absent"
  /\ canonicalTree["B"] = frozenTree["B"] /\ canonicalTree["B"] # "absent"
NoEarlyRetirement == retired => resultApplied /\ integrationResult = "merged"
ConflictKeepsPairedEvidence == integrationResult = "conflict" =>
  protected /\ ~retired /\ canonicalTree = conflictSnapshot
  /\ protectedProposalContent = capturedContent /\ frozenTree["B"] = capturedContent
NoSourceOrCapturedVersionLost == captured =>
  BaseTree["A"] # "absent" /\
  (localTree["B"] = capturedContent \/ localTree["C"] = capturedContent \/
   proposalTree["B"] = capturedContent \/ frozenTree["B"] = capturedContent \/
   canonicalTree["B"] = capturedContent \/ protectedProposalContent = capturedContent)
SuccessorCannotRewriteAttempt == frozen => requestPair = Rename
  /\ requestTree["A"] = "absent" /\ requestTree["B"] = "rename-edit-v1"
CanonicalChangesOnlyAsCompleteRename == integrationResult = "merged" =>
  canonicalTree["A"] = "absent" /\ canonicalTree["B"] # "absent"
AllSafety == CapturedPairComplete /\ ImmutableAttempt /\ OldestApplicableBaseRetained
  /\ AdmissionValidatesTreePair /\ MergedTreeContainsPair /\ NoEarlyRetirement
  /\ ConflictKeepsPairedEvidence /\ NoSourceOrCapturedVersionLost
  /\ SuccessorCannotRewriteAttempt /\ CanonicalChangesOnlyAsCompleteRename

WitnessNotReached ==
  CASE Mutation = "reach-capture-integration" -> integrationResult # "merged"
    [] Mutation = "reach-restart-integration" -> ~(restarted /\ integrationResult = "merged")
    [] Mutation = "reach-successor-integration" -> ~(successorChanged /\ integrationResult = "merged")
    [] Mutation = "reach-conflict-ownership" -> integrationResult # "conflict"
    [] OTHER -> TRUE
Spec == Init /\ [][Next]_vars
=============================================================================
