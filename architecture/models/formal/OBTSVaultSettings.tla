---- MODULE OBTSVaultSettings ----
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
OBTS-FM-009, architecture revision 34. Focused bounded refinement of
server-managed vault configuration and timestamp-only Markdown overlap.
Git bytes, Git-ignore matching, YAML parsing, timestamp parsing, and runtime
operation durability are represented by verified symbolic inputs. Concrete
byte preservation and parser behavior require implementation regressions.
***************************************************************************)
CONSTANT FaultMode, Scenario

Versions == {"base", "main-next"}
PolicyIds == {"policy-v1", "policy-v2"}
RuleIds == {"rules-v1", "rules-v2", "no-rules"}
NoId == "none"
NoValue == "none"

VARIABLES main, policy, rules, localNote, localOnly, preview, operation,
          operationPhase, candidateOutsideEqual, timestampInputsValid,
          timestampWinner, capturedMerge, automaticMerge, conflictRequired,
          lastAction
vars == <<main, policy, rules, localNote, localOnly, preview, operation,
          operationPhase, candidateOutsideEqual, timestampInputsValid,
          timestampWinner, capturedMerge, automaticMerge, conflictRequired,
          lastAction>>

Init ==
  /\ main = "base"
  /\ policy = "policy-v1"
  /\ rules = "rules-v1"
  /\ localNote = "present"
  /\ localOnly = FALSE
  /\ preview = [main |-> NoId, policy |-> NoId, rules |-> NoValue,
                tree |-> NoValue, directories |-> NoValue]
  /\ operation = [kind |-> "none", main |-> NoId, policy |-> NoId,
                  rules |-> NoValue, tree |-> "unchanged", result |-> NoValue]
  /\ operationPhase = "idle"
  /\ candidateOutsideEqual = (Scenario = "EligibleTimestampMerge" \/ Scenario = "InvalidTimestampFallback")
  /\ timestampInputsValid = (Scenario = "EligibleTimestampMerge")
  /\ timestampWinner = IF Scenario = "EligibleTimestampMerge" THEN "device" ELSE "none"
  /\ capturedMerge = [rules |-> NoValue, result |-> NoValue]
  /\ automaticMerge = FALSE
  /\ conflictRequired = FALSE
  /\ lastAction = "Init"

PreviewExclusions ==
  /\ operationPhase = "idle"
  /\ Scenario = "General"
  /\ preview' = [main |-> main, policy |-> policy, rules |-> rules,
                  tree |-> "note-excluded", directories |-> policy]
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "PreviewExclusions"

AdvanceMain ==
  /\ Scenario = "General"
  /\ main = "base"
  /\ operationPhase = "idle"
  /\ main' = "main-next"
  /\ UNCHANGED <<policy, rules, localNote, localOnly, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "AdvanceMain"

ChangeRootPolicy ==
  /\ Scenario = "General"
  /\ policy = "policy-v1"
  /\ operationPhase = "idle"
  /\ policy' = "policy-v2"
  /\ UNCHANGED <<main, rules, localNote, localOnly, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "ChangeRootPolicy"

ChangeMergeRules ==
  /\ rules = "rules-v1"
  /\ operationPhase \in {"idle", "merge-prepared", "merge-ref-moved", "merge-recovering"}
  /\ rules' = "rules-v2"
  /\ UNCHANGED <<main, policy, localNote, localOnly, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "ChangeMergeRules"

PrepareExclusionOperation ==
  /\ Scenario = "General"
  /\ preview.main # NoId  /\ preview.main = main
  /\ preview.policy = policy
  /\ preview.rules = rules
  /\ preview.directories = policy
  /\ preview.tree = "note-excluded"
  /\ operationPhase = "idle"
  /\ operation' = [kind |-> "exclusions", main |-> main, policy |-> policy,
                   rules |-> NoValue, tree |-> preview.tree, result |-> NoValue]
  /\ operationPhase' = "settings-prepared"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "PrepareExclusionOperation"

UnsafePrepareStaleSettings ==
  /\ FaultMode = "StaleSettingsSave"
  /\ preview.main # NoId
  /\ (preview.main # main \/ preview.policy # policy \/ preview.rules # rules)
  /\ operationPhase = "idle"
  /\ operation' = [kind |-> "exclusions", main |-> preview.main, policy |-> preview.policy,
                   rules |-> NoValue, tree |-> "note-excluded", result |-> NoValue]
  /\ operationPhase' = "settings-prepared"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "UnsafePrepareStaleSettings"

MovePreparedSettingsRef ==
  /\ operationPhase = "settings-prepared"
  /\ main = operation.main
  /\ policy = operation.policy
  /\ main' = "main-next"
  /\ operationPhase' = "settings-ref-moved"
  /\ UNCHANGED <<policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "MovePreparedSettingsRef"

CommitPreparedSettings ==
  /\ operationPhase = "settings-ref-moved"
  /\ operationPhase' = "settings-committed"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "CommitPreparedSettings"

CrashAfterSettingsRefMove ==
  /\ operationPhase = "settings-ref-moved"
  /\ operationPhase' = "settings-recovering"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "CrashAfterSettingsRefMove"

RecoverPreparedSettings ==
  /\ operationPhase = "settings-recovering"
  /\ operationPhase' = "settings-committed"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "RecoverPreparedSettings"

ApplyExcludedTarget ==
  /\ operationPhase = "settings-committed"
  /\ operation.tree = "note-excluded"
  /\ localOnly' = TRUE
  /\ UNCHANGED <<main, policy, rules, localNote, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "ApplyExcludedTarget"

UnsafeApplyExcludedTarget ==
  /\ FaultMode = "DeleteLocalOnExclusion"
  /\ operationPhase = "settings-committed"
  /\ operation.tree = "note-excluded"
  /\ localNote' = "absent"
  /\ localOnly' = FALSE
  /\ UNCHANGED <<main, policy, rules, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "UnsafeApplyExcludedTarget"

ObserveEligibleTimestampOverlap ==
  /\ operationPhase = "idle"
  /\ Scenario = "General"
  /\ rules # "no-rules"
  /\ candidateOutsideEqual' = TRUE
  /\ timestampInputsValid' = TRUE
  /\ timestampWinner' = "device"
  /\ automaticMerge' = FALSE
  /\ conflictRequired' = FALSE
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation, operationPhase, capturedMerge>>
  /\ lastAction' = "ObserveEligibleTimestampOverlap"

ObserveInvalidTimestampOverlap ==
  /\ operationPhase = "idle"
  /\ Scenario = "General"
  /\ rules # "no-rules"
  /\ candidateOutsideEqual' = TRUE
  /\ timestampInputsValid' = FALSE
  /\ timestampWinner' = "none"
  /\ automaticMerge' = FALSE
  /\ conflictRequired' = FALSE
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation, operationPhase, capturedMerge>>
  /\ lastAction' = "ObserveInvalidTimestampOverlap"

ObserveDifferentOutsideConfiguredFields ==
  /\ operationPhase = "idle"
  /\ Scenario = "General"
  /\ candidateOutsideEqual' = FALSE
  /\ timestampInputsValid' = TRUE
  /\ timestampWinner' = "none"
  /\ automaticMerge' = FALSE
  /\ conflictRequired' = FALSE
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation, operationPhase, capturedMerge>>
  /\ lastAction' = "ObserveDifferentOutsideConfiguredFields"

AutomaticTimestampMerge ==
  /\ operationPhase = "idle"
  /\ rules # "no-rules"
  /\ candidateOutsideEqual
  /\ timestampInputsValid
  /\ timestampWinner \in {"server", "device", "tie_server"}
  /\ operation' = [kind |-> "timestamp-merge", main |-> main, policy |-> policy,
                   rules |-> rules, tree |-> "note-merged", result |-> timestampWinner]
  /\ capturedMerge' = [rules |-> rules, result |-> timestampWinner]
  /\ operationPhase' = "merge-prepared"
  /\ automaticMerge' = TRUE
  /\ conflictRequired' = FALSE
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner>>
  /\ lastAction' = "AutomaticTimestampMerge"

RequireConflict ==
  /\ operationPhase = "idle"
  /\ (~candidateOutsideEqual \/ ~timestampInputsValid \/ rules = "no-rules")
  /\ conflictRequired' = TRUE
  /\ automaticMerge' = FALSE
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge>>
  /\ lastAction' = "RequireConflict"

MovePreparedMergeRef ==
  /\ operationPhase = "merge-prepared"
  /\ main = operation.main
  /\ main' = "main-next"
  /\ operationPhase' = "merge-ref-moved"
  /\ UNCHANGED <<policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "MovePreparedMergeRef"

CommitPreparedMerge ==
  /\ operationPhase = "merge-ref-moved"
  /\ operationPhase' = "merge-committed"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "CommitPreparedMerge"

CrashAfterMergeRefMove ==
  /\ operationPhase = "merge-ref-moved"
  /\ operationPhase' = "merge-recovering"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "CrashAfterMergeRefMove"

RecoverPreparedMerge ==
  /\ operationPhase = "merge-recovering"
  /\ operationPhase' = "merge-committed"
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operation,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "RecoverPreparedMerge"

UnsafeRecomputeMergeAfterPolicyChange ==
  /\ FaultMode = "RecomputeMergeAfterPolicyChange"
  /\ operationPhase = "merge-ref-moved"
  /\ rules # operation.rules
  /\ operation' = [operation EXCEPT !.rules = rules, !.result = "server"]
  /\ UNCHANGED <<main, policy, rules, localNote, localOnly, preview, operationPhase,
                  candidateOutsideEqual, timestampInputsValid, timestampWinner,
                  capturedMerge, automaticMerge, conflictRequired>>
  /\ lastAction' = "UnsafeRecomputeMergeAfterPolicyChange"

Next ==
  \/ PreviewExclusions
  \/ AdvanceMain
  \/ ChangeRootPolicy
  \/ ChangeMergeRules
  \/ PrepareExclusionOperation
  \/ UnsafePrepareStaleSettings
  \/ MovePreparedSettingsRef
  \/ CommitPreparedSettings
  \/ CrashAfterSettingsRefMove
  \/ RecoverPreparedSettings
  \/ ApplyExcludedTarget
  \/ UnsafeApplyExcludedTarget
  \/ ObserveEligibleTimestampOverlap
  \/ ObserveInvalidTimestampOverlap
  \/ ObserveDifferentOutsideConfiguredFields
  \/ AutomaticTimestampMerge
  \/ RequireConflict
  \/ MovePreparedMergeRef
  \/ CommitPreparedMerge
  \/ CrashAfterMergeRefMove
  \/ RecoverPreparedMerge
  \/ UnsafeRecomputeMergeAfterPolicyChange
  \/ (operationPhase \in {"settings-committed", "merge-committed"} /\ UNCHANGED vars)

TypeOK ==
  /\ main \in Versions
  /\ policy \in PolicyIds
  /\ rules \in RuleIds
  /\ localNote \in {"present", "absent"}
  /\ localOnly \in BOOLEAN
  /\ preview \in [main: Versions \cup {NoId}, policy: PolicyIds \cup {NoId},
                   rules: RuleIds \cup {NoValue}, tree: STRING, directories: PolicyIds \cup {NoValue}]
  /\ operation \in [kind: {"none", "exclusions", "timestamp-merge"},
                     main: Versions \cup {NoId}, policy: PolicyIds \cup {NoId},
                     rules: RuleIds \cup {NoValue},
                     tree: {"unchanged", "note-excluded", "note-merged"},
                     result: {"none", "server", "device", "tie_server"}]
  /\ operationPhase \in {"idle", "settings-prepared", "settings-ref-moved", "settings-recovering", "settings-committed", "merge-prepared", "merge-ref-moved", "merge-recovering", "merge-committed"}
  /\ candidateOutsideEqual \in BOOLEAN
  /\ timestampInputsValid \in BOOLEAN
  /\ timestampWinner \in {"none", "server", "device", "tie_server"}
  /\ capturedMerge \in [rules: RuleIds \cup {NoValue}, result: {"none", "server", "device", "tie_server"}]
  /\ automaticMerge \in BOOLEAN
  /\ conflictRequired \in BOOLEAN
  /\ lastAction \in STRING

LocalCopyNeverDeleted == localNote = "present"
ExcludedApplyRemainsLocalOnly == localOnly => localNote = "present"
PreparedDecisionIsPinned ==
  operationPhase \in {"settings-prepared", "settings-ref-moved", "settings-recovering", "settings-committed"}
    => operation.policy \in PolicyIds /\ operation.tree = "note-excluded"
PreparedSettingsCurrent ==
  operationPhase \in {"settings-prepared", "settings-ref-moved", "settings-recovering", "settings-committed"}
    => operation.main = preview.main /\ operation.policy = preview.policy
       /\ (operationPhase # "settings-prepared" \/ (operation.main = main /\ operation.policy = policy))
MergeRequiresProvenance == automaticMerge => candidateOutsideEqual /\ timestampInputsValid
MergeWinnerIsConfiguredFieldOnly == automaticMerge => timestampWinner \in {"server", "device", "tie_server"}
MergeManifestPinned ==
  operationPhase \in {"merge-prepared", "merge-ref-moved", "merge-recovering", "merge-committed"}
    => operation.kind = "timestamp-merge" /\ operation.rules = capturedMerge.rules
       /\ operation.result = capturedMerge.result /\ operation.tree = "note-merged"
MergeResultUsesObservedWinner ==
  operationPhase \in {"merge-prepared", "merge-ref-moved", "merge-recovering", "merge-committed"}
    => operation.result = timestampWinner
MergeOutcomesExclusive == ~(automaticMerge /\ conflictRequired)

FairAutoMergeSpec ==
  Init /\ [][Next]_vars
  /\ WF_vars(AutomaticTimestampMerge)
  /\ WF_vars(MovePreparedMergeRef)
  /\ WF_vars(CommitPreparedMerge)
  /\ WF_vars(CrashAfterMergeRefMove)
  /\ WF_vars(RecoverPreparedMerge)
EventuallyMergeCommitted == <> (operationPhase = "merge-committed")
FairConflictSpec == Init /\ [][Next]_vars /\ WF_vars(RequireConflict)
EventuallyConflictRequired == <> conflictRequired

Spec == Init /\ [][Next]_vars
====
