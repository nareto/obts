# Formal Models

Formal models are bounded refinements of stable contracts in `architecture/contracts/`. They do not define product behavior independently. Protocol-changing code or architecture changes must update an affected model and its declared revision or explicitly retire it. Mechanical revision agreement does not prove semantic conformance.

## Validation Families

`npm run test:formal` runs the complete TLC chain, including the focused atomic-rename family. CI can select complete family entrypoints: `sync` (FM001/FM002), `bridge-body`, `workers`, `deletion`, `bridge-protocol`, `bridge-read`, `onboarding` (including recovery), `diagnostics`, `client-state` (FM008 and FM010 upload recovery), `vault-settings`, `headless-ownership` (FM013), and `atomic-rename` (FM014). Isolated model/config/check-manifest edits can run their entire affected family; shared model modules, checker infrastructure, unknown paths, and shared dependencies require broad formal validation. The fast metadata command invokes `--validate-only` only for sync, bridge-body, workers, deletion, bridge-protocol, and onboarding entrypoints; diagnostic admission, onboarding recovery, and client-state do not implement metadata-only mode and must never receive that flag. A selected family is a complete checker matrix, not a partial check list. Unchanged models do not prove implementation conformance; executable and operator evidence remain independently required.

## OBTS-FM-001: Local Apply And Recovery

| Field | Value |
| --- | --- |
| Status | Accepted bounded pilot |
| Architecture revision | 2 |
| Refined contracts | `OBTS-SAF-001`, `OBTS-SAF-002`, `OBTS-SAF-005` |
| Specification | `OBTSApplyRecovery.tla` |
| TLC configuration | `OBTSApplyRecovery.cfg`, `OBTSApplyRecoveryLiveness.cfg` |
| Executable check | `npm run test:formal` |
| In-place companion / revision | `OBTSApplyInPlace.tla`, revision 36; gated modify/delete safety, liveness, recovery/seam witnesses and gate-off/external controls; `OBTSStaleProposal.tla` provenance companion (revision 36) |

The model covers one client, one path, the captured local version, one concurrent local edit, a target server version, recovery staging/publication, mutation, verification, ref and coordination publication, acknowledgement intent, cleanup, one crash, and restart. Values stand for exact bytes plus path identity and provenance.

### Durability and fairness assumptions

`PublishInitialBundle` and `PublishPostWriteBundle` mean all required snapshots, manifest data, checksums, completion marker, and local-only Git closure have been flushed as supported, atomically published, remain discoverable after restart, and verify successfully. The model deliberately does not equate a successful filesystem Promise or rename with that guarantee.

Visible mutation, journal phase, reachable local Git versions, refs, coordination, acknowledgement intent, and cleanup are durable observations and move independently at their concrete durable boundaries. `running`, `recovering`, and `crashCount` are model control state; observed/overwritten sets are ghost state used to check preservation. A crash preserves whichever durable boundaries completed; restart enters explicit validation/classification actions that resume, roll a completed boundary forward, or block.

The liveness check uses weak fairness for protocol progress and bounds crashes to one. Safety does not depend on fairness. Terminal states stutter explicitly so deadlock checking remains enabled.

### Checked properties

- every captured or subsequently observed local version retains a preservation root;
- every displaced version was present in complete recovery evidence before mutation;
- active mixed states retain a discoverable journal and recovery evidence;
- cleanup cannot claim completion before refs, coordination state, and acknowledgement intent are durable;
- failed initial recovery publication before mutation is non-destructive;
- a started apply eventually finishes or blocks under the stated fairness and crash bound.

### Negative controls and promoted counterexample

The checker requires four deliberately broken configurations to fail:

- mutation before recovery publication;
- stale-preflight overwrite without revalidation at the mutation seam;
- early journal cleanup;
- restart inferring completion from an incomplete phase.

The stale-preflight trace was promoted to `tests/plugin-large-vault.test.ts`: target-byte loading triggers a concurrent local edit, and the implementation must revalidate the path immediately before mutation rather than overwrite it.

### TLC evidence

On `tla-tools` 1.7.4 / TLC 2.19 with one worker and fingerprint polynomial 0:

- safety: 237 generated states, 163 distinct states, depth 20;
- liveness: 237 generated states, 163 distinct states, depth 20;
- all four negative controls produced bounded invariant counterexamples;
- total runtime remained below one second per check on the evaluation host.

`check-formal-model.mjs` enforces a 60-second subprocess timeout, a 1 GiB Java heap, and fewer than 100,000 distinct states. Set `TLA2TOOLS_JAR` in CI to use a pinned downloaded JAR; otherwise the installed `tla2sany` and `tlc` commands are used.

### Implementation and evidence map

| Model boundary | Concrete implementation/evidence |
| --- | --- |
| `StartApply` / planned journal | `ObtsObsidianClient.applyTargetMain` publishes `.obts/apply-journal.json` before destructive work; phase/restart tests live in `tests/phase1.test.ts`. |
| `StageInitialBundle`, `PublishInitialBundle`, `RecordRecoveryPublication` | `stageRecoveryBundleFiles` and `finalizeRecoveryBundle` stage snapshots, manifest, Git closure, checksums, completion marker, rename, then journal the bundle ID. |
| `BeginWriting`, `WriteTarget`, `BlockChangedPath`; companion copy/compare/modify/delete/recovery actions | `writeTargetFilesFromJournal` / mutation helpers are Phase-2 regression sites: verified copy outside the gate; final raw freshness compare + raw write/remove/create inside it; no live-file rename or Vault call under the claim. Directory/restore seams require expected-state guards. Production implements the revision-36 adapter gate and stale proposals, with executable assertions in `tests/plugin-adapter-write-gate.test.ts`, `tests/plugin-in-place-apply.test.ts`, `tests/plugin-large-vault.test.ts` and `tests/plugin-stale-proposal.test.ts`. |
| Post-write bundle actions | `localChangedPathsFromTree` plus `createRecoveryBundle` preserve edits detected after materialization before refs advance. |
| Ref, coordination, acknowledgement, cleanup actions | `updateRef`, `writeState`, `writePendingAppliedAcknowledgement`, and `clearApplyState` are separate durable calls. |
| `Crash`, `Restart`, recovery classifiers | `initialize`, `recoverIncompleteApplyJournal`, and `recoverBlockedApplyWithPreservedLocalChanges` classify persisted journal, visible tree, target commit, refs, and preservation evidence. |

### Gated compare/mutate companion (revision 36)

`OBTSApplyInPlace.tla` keeps the original pilot unchanged and extends the companion's verified-copy/separate-compare/separate-mutate seam. `gateHeld` excludes same-adapter writers after comparison, is released after modification/removal or error/crash, and is reacquired only after restart classification. `DeleteMutation=TRUE` interprets Target as absence; it uses `DeleteExistingFile` rather than interrupted-write behavior. Gate-off uses the historical `NonAtomicWrite=TRUE` config/ID; `ExternalWriter=TRUE` deliberately bypasses the held gate. Both modify and delete controls must fail `NoLocalVersionLost`, documenting implementation bugs or the external residual, respectively. The compare-held crash witness distinguishes a crash while the gate is actually held, not merely an arbitrary pre-write crash. Old/target/unknown recovery remains explicit; partial bytes are preserved, not inferred away from copy presence.

Final measured generated/distinct/depth baselines are in `checks.json`; each check runs below the default limits. The unchanged pilot preserves historical safety/liveness/control evidence. TLC checks the bounded intended same-adapter design, not implementation conformance or arbitrary filesystem atomicity; the implemented gate and executable regressions provide separate evidence.

### Focused stale-proposal companion (revision 36)

`OBTSStaleProposal.tla` connects FM001 preservation to FM002 immutable proposal/server semantics without widening the composed state space. Four symbolic paths are p (touched stale text/binary/delete), q (inherited canonical change, optionally a known fresh revert after horizon expiry/drain), u (untouched ordinary work), and b (a stale cohort path identical to current main in mixed binary/delete scenarios). M0 precedes natural parent K; K and D trees freeze independently at commit creation. In the mixed scenarios canonical main independently reaches D[b], while K[b] differs. Token sets and kinds stand for exact symbolic values, not actual parsing or Git algorithms. There are eight integration scenarios plus four isolated publication projections described below, two local generations, one crash, one q canonical advance and at most one later apply with a distinct newer M1. The common transition relation bounds first q/u edits before capture and the second sticky edit just after queue publication; it does not enumerate all runtime schedules.

D1/D2 classification is derived, not a scenario answer: `Changed(NaturalTree,ProposalTree)` gives the device-authored set; kind-and-content equality computes per-path identities, which are removed from divergence. Symbolic one-sided/native-text eligibility inspects that divergent set to select conflict or three-way output for each authored path. q values equal to K never enter authored changes; `InheritedCanonicalRetained` requires **exact** equality with pre-integration main on all inherited paths, including the later `new-remote-q` token, not merely retention of the original token. `AuthoredFromNaturalBase`, `IdentitySetExact`, `IdentityFilteredPerPath` and clean/mixed merge invariants independently audit those derived sets and outcomes. Mixed binary and mixed deletion witnesses combine `{b}` identity with `{p}` clean text divergence. Using the older explicit-base diff yields a false authored set and a separately witnessed false conflict after main advances q; all-or-nothing identity filtering yields a false mixed conflict.

`StaleProposalUsesAuthoringBase` checks outstanding sticky obligations/pinned base, commit intent, queued base and integration base. Admission separately freezes `admittedBase`; requests explicitly offer a base. Equal offers resume, mismatches reject without changing base/ref/main, and a matching request after rejection can progress. `RetryAdmissionImmutable` and `RejectedRetryDidNotMoveState` check the admission identity and rejection snapshot. Crash resets volatile retry observation; restart records the same captured commit. The required ref-crash retry trace is now **Crash → Restart → offered M0 → equal-ref retry → integration with M0**, not a pre-crash retry followed by restart. A rebinding mutant fails immutable admission. At most one differing offer and two matching offers around one crash keep retry exploration finite.

`NoSilentRemoteReplacement` checks true-base decisions, unchanged canonical main on conflict and remote-token retention on clean merge. `OriginCohortsSeparated` keeps known fresh work outside stale trees. Latest-generation settlement applies the server result before clearing an obligation; conflicts hand ownership to pending-conflict rules. The later-apply lane first settles generation 1, then defers still-sticky generation 2 under newer pre-apply M1 and a newer canonical target. It retains M0 and proposes from the newer applied parent/tree with M0 as explicit ancestor. `OldestBaseSurvivesLaterApply` and its successor-proposal witness challenge this branch; replacing the obligation with M1 fails the designated invariant.

Reachability retains pre-mutation deferral, gate-queued save, post-apply flush, expiry then drain, first/second captures, clean merge/conflict, inherited advance, sequential held fresh work and all four crash seams. Wrong C base, cleanup provenance loss, null retry and mixed fresh revert controls remain required, alongside the five review-added classification/rebinding/oldest-base controls. The wrong-base integration control independently fails `NoSilentRemoteReplacement` for a lost remote token.

The companion assumes crash-safe publication, protected Git closure, ordered M0/M1 ancestry and symbolic merge-validator results. It does not prove actual Git merge-base computation, tree/hierarchy assembly, parser/content merge algorithms, directory structural identity, real gate scheduling, filesystem durability, arbitrary editor timing or host reload. Repeated capture failure is abstracted by waiting ready with durable obligations. Conflict resolution remains delegated. The action map identifies existing Phase-2 code/test regression sites, not implementation conformance. The phase-2c fixes update the sync/persistence contracts within revision 36; the ADR and static allocation remain unchanged.

The stale-proposal companion also checks acknowledged P as the global authoring base, the recorded older base for P's own stale cohort, and missing/already-contained fallbacks; atomic retirement-to-old-base horizon handover with a late buffer save; and drained no-diff local settlement with a fresh covering horizon, followed by expiry/drain before unpinning. Three bounded publication projections isolate these seams without multiplying the integration state space. The ordinary-retirement and no-op retire-before-horizon mutants violate `RetirementKeepsOldBase`; using P's older proposal base for the held fresh q revert when main re-changes q violates `KnownFreshRevertNotLost`. These projections assume validated durable identities and do not model accepted-record JSON parsing or the queue-clear crash seams, which have real-process regressions.

The held-P rebuild projection records P identity and fallback before mutation, keeps older independent evidence, and waits for acknowledgment before proposing continued same-line work at P (or its recorded root-policy successor). Crash/restart preserves that evidence. Rejection/conflict uses the recorded fallback, never advanced C. `HeldOwnEditNoFalseConflict` rejects acknowledged continuation proposed at pre-P M0; `NoSilentRemoteReplacement` rejects a newer fallback that silently overwrites remote work. These bounded symbolic own-edit/fallback checks do not prove parser, host filesystem or implementation conformance. Baselines (generated/distinct/depth): held 228/97/7; old-base mutant 32/22/4; newer-fallback mutant 29/20/4.

The isolated `held-repair` extension snapshots original pins in `PrepareOriginalPins` before any held or F5 fallback publication, choosing an older pin present or absent nondeterministically. `CorruptCompanion` loses path association but retains pins; `RepairCompanion` uses M0 when an older original pin exists, otherwise permitting P. A separate prior-held path durably publishes the M0 fallback in `HoldPDerived`, advances canonical to C while P stays queued (`AdvanceHeldCanonical`), and then corrupts/repairs with that fallback pin retained. This covers first corruption with/without older evidence and corruption after a prior canonical rebuild without conflating pre-publication and durable-held ordering. The required repair-horizon held-exemption mutant fails `HeldOlderWins` at `RepairCompanion` through `PrepareOriginalPins -> CorruptCompanion -> RepairCompanion`, not parsing or resource failure. The trace map uses exact plugin method ranges; `PrepareOriginalPins` maps to `rebuildFromServerMain:2584–2812`, specifically its original-ref snapshot block at lines 2609–2627. This bounded extension assumes comparable validated ancestry; implementation ambiguity fails closed. Repair baselines (generated/distinct/depth): positive 614/261/11; exemption mutant 22/15/4.

### Revision-36 companion TLC evidence

TLC 2.19, one worker, fingerprint polynomial 0, 1 GiB heap. `REACHED` and `REJECTED` mean required invariant-counterexample witnesses, not unexpected failures. Measured generated/distinct/depth baselines and half-baseline floors are enforced in `checks.json`.

| Check | Result | Generated | Distinct | Depth |
| --- | --- | ---: | ---: | ---: |
| `fm001-in-place-safety` | PASS | 548 | 411 | 23 |
| `fm001-in-place-liveness` | PASS | 548 | 411 | 23 |
| `fm001-in-place-reach-old` | REACHED | 91 | 71 | 10 |
| `fm001-in-place-reach-target` | REACHED | 134 | 110 | 12 |
| `fm001-in-place-reach-unknown` | REACHED | 107 | 85 | 11 |
| `fm001-in-place-negative-non-atomic` | REJECTED | 87 | 66 | 10 |
| `fm001-in-place-delete-safety` | PASS | 522 | 393 | 23 |
| `fm001-in-place-negative-external` | REJECTED | 87 | 67 | 10 |
| `fm001-in-place-delete-negative-gate-off` | REJECTED | 86 | 65 | 10 |
| `fm001-in-place-delete-negative-external` | REJECTED | 86 | 66 | 10 |
| `fm001-in-place-delete-liveness` | PASS | 522 | 393 | 23 |
| `fm001-in-place-reach-gate-crash` | REACHED | 67 | 53 | 9 |
| `fm001-in-place-reach-delete-seam` | REACHED | 66 | 52 | 9 |
| `fm001-stale-disjoint` | PASS | 93,810 | 52,872 | 36 |
| `fm001-stale-overlap` | PASS | 23,412 | 12,912 | 24 |
| `fm001-stale-binary` | PASS | 23,412 | 12,912 | 24 |
| `fm001-stale-delete` | PASS | 23,412 | 12,912 | 24 |
| `fm001-stale-identical` | PASS | 93,810 | 52,872 | 36 |
| `fm001-stale-reach-disjoint-merge` | REACHED | 475 | 303 | 9 |
| `fm001-stale-reach-overlapping-conflict` | REACHED | 475 | 303 | 9 |
| `fm001-stale-reach-sticky-second-edit` | REACHED | 94 | 48 | 6 |
| `fm001-stale-reach-pre-mutation-save` | REACHED | 2 | 2 | 2 |
| `fm001-stale-reach-gate-queued-save` | REACHED | 5 | 5 | 3 |
| `fm001-stale-reach-post-apply-flush` | REACHED | 7 | 6 | 3 |
| `fm001-stale-reach-commit-crash` | REACHED | 97 | 51 | 6 |
| `fm001-stale-reach-queue-crash` | REACHED | 172 | 98 | 7 |
| `fm001-stale-reach-cleanup-crash` | REACHED | 289 | 177 | 8 |
| `fm001-stale-reach-device-ref-retry` | REACHED | 3,329 | 2,257 | 13 |
| `fm001-stale-reach-horizon-drain` | REACHED | 71 | 38 | 5 |
| `fm001-stale-reach-sequential-fresh-revert` | REACHED | 7,173 | 4,724 | 15 |
| `fm001-stale-reach-latest-sticky-settlement` | REACHED | 24,120 | 14,397 | 19 |
| `fm001-stale-reach-inherited-canonical` | REACHED | 758 | 496 | 10 |
| `fm001-stale-negative-base-c` | REJECTED | 14 | 11 | 4 |
| `fm001-stale-negative-cleanup-provenance` | REJECTED | 95 | 49 | 6 |
| `fm001-stale-negative-retry-null` | REJECTED | 761 | 498 | 10 |
| `fm001-stale-negative-mixed-fresh-revert` | REJECTED | 244 | 146 | 8 |
| `fm001-stale-negative-silent-replacement` | REJECTED | 475 | 302 | 9 |
| `fm001-stale-reach-untouched-fresh` | REACHED | 1,930 | 1,310 | 12 |
| `fm001-stale-reach-different-retry-base` | REACHED | 764 | 500 | 10 |
| `fm001-stale-reach-active-horizon-restart` | REACHED | 97 | 51 | 6 |
| `fm001-stale-mixed-binary` | PASS | 93,810 | 52,872 | 36 |
| `fm001-stale-mixed-delete` | PASS | 93,810 | 52,872 | 36 |
| `fm001-stale-later-apply` | PASS | 163,416 | 91,512 | 37 |
| `fm001-stale-reach-mixed-binary` | REACHED | 475 | 303 | 9 |
| `fm001-stale-reach-mixed-delete` | REACHED | 475 | 303 | 9 |
| `fm001-stale-reach-later-apply-oldest-base` | REACHED | 26,850 | 15,974 | 19 |
| `fm001-stale-reach-rejected-then-same-base` | REACHED | 3,316 | 2,251 | 13 |
| `fm001-stale-negative-older-base-diff` | REJECTED | 475 | 303 | 9 |
| `fm001-stale-negative-older-base-false-conflict` | REJECTED | 758 | 496 | 10 |
| `fm001-stale-negative-all-or-nothing-identity` | REJECTED | 475 | 303 | 9 |
| `fm001-stale-negative-rebind-retry` | REJECTED | 764 | 500 | 10 |
| `fm001-stale-negative-replace-oldest-base` | REJECTED | 1,974 | 1,339 | 12 |

| `fm001-stale-handover` | PASS | 8 | 3 | 3 |
| `fm001-stale-ack` | PASS | 17 | 6 | 2 |
| `fm001-stale-noop` | PASS | 26 | 9 | 6 |
| `fm001-stale-negative-noop-retire-first` | REJECTED | 6 | 3 | 3 |
| `fm001-stale-negative-retire-first` | REJECTED | 5 | 3 | 3 |
| `fm001-stale-reach-retirement-save` | REACHED | 5 | 3 | 3 |
| `fm001-stale-reach-noop` | REACHED | 3 | 2 | 2 |
| `fm001-stale-reach-ack` | REACHED | 3 | 2 | 2 |
| `fm001-stale-negative-noncohort-base` | REJECTED | 5 | 4 | 2 |
| `fm001-stale-held` | PASS | 228 | 97 | 7 |
| `fm001-stale-negative-held-old-base` | REJECTED | 32 | 22 | 4 |
| `fm001-stale-negative-held-new-fallback` | REJECTED | 29 | 20 | 4 |
| `fm001-stale-held-repair` | PASS | 614 | 261 | 11 |
| `fm001-stale-negative-held-repair-exemption` | REJECTED | 22 | 15 | 4 |

### Known omissions

The pilot does not cover directories, multiple paths, write concurrency, editor-buffer capture, Git object structure, network/server acknowledgement, byte/checksum implementation, mobile lifecycle, process kill, power loss, filesystem semantics, corrupted finalized bundles, or competing client instances. The companion adds the bounded compare/write interleaving and one symbolic interrupted write, not a proof of byte-level storage atomicity. Those require executable fault tests and platform evidence; a green TLC result makes no claim about them.

## OBTS-FM-013: Managed Headless Ownership And Maintenance Failure

| Field | Value |
| --- | --- |
| Status | Focused bounded model |
| Architecture revision | 45 |
| Refined contracts | `OBTS-SYNC-ACK-001`, `OBTS-SYNC-STALE-001` |
| Specification / configuration | `OBTSManagedHeadlessOwnership.tla`, `OBTSManagedHeadlessOwnership.cfg` |
| Executable check | `npm run test:formal:headless-ownership` |

The bounded companion uses two competing actors and at most two launches. It covers process-lock ownership surviving supervisor death, descendants retaining ownership after leader exit, explicit owned-process-group termination before lock release/relaunch, generation-bound stale-marker reconciliation after a replacement launch, same-generation contention, unknown-marker preservation, delayed old-owner cleanup against a replacement marker, and truthful catch-up reporting. Its status projection distinguishes progressing work from blocked preserved edits, constrains guidance to fixed redacted category/action values, and requires no active apply lock after the maintenance failure is published. The model deliberately does not claim preservation of general ref/queue/evidence publication histories; that remains an executable-test obligation. Mandatory mutants challenge duplicate owners, same-generation reclamation, deleting a replacement marker, unknown-marker reclamation, supervisor-death release, leader reaping while a descendant remains, report mutation, and duplicate events. It abstracts Linux group signaling and flock implementation; executable process tests must establish containment, lock release, and descriptor/inode behavior. Supported managed commands must not daemonize or escape their process group. No cross-host/network-filesystem or external-writer guarantees are modeled.

## OBTS-FM-012: Bridge Write Admission

| Field | Value |
| --- | --- |
| Status | Focused bounded model |
| Architecture revision | 42 |
| Refined contracts | `OBTS-BRG-WRITE-001`, `OBTS-BRG-READ-001` |
| Specification / configurations | `OBTSBridgeWriteAdmission.tla`, `configs/write-admission-*.cfg` |
| Checker | `npm run test:formal:bridge-read` |

The companion bounds one foreground writer across service then headless mutex admission with one deadline, permits a read while queued, and revalidates the revision at ownership. Success liveness assumes maintenance releases before the deadline; it is not satisfied merely because no writer is queued initially. Eleven checks cover four positive cases, five mandatory success/read/timeout/cancel/stale witnesses and unsafe-write/healthy-child-cancellation controls. TLC generated/distinct/depth positive baselines are success 17/13/7, timeout 78/47/7, stale 177/99/9 and cancel 141/71/7; both negative controls produce their exact invariant/witness at depth 2. The checker bounds subprocess time, heap, state/depth, isolates metadirs, and supports the pinned CI JAR. This model does not prove multiple-writer FIFO, wall-clock timing, protocol-in-flight cancellation or runtime lock implementation; executable tests cover second-writer and real mutex behavior. FM011 remains architecture-stage at revision 40 with its original 14 checks unchanged.

## OBTS-FM-010: Upload Checkpoint Handoff

| Field | Value |
| --- | --- |
| Status | Accepted bounded model |
| Architecture revision | 39 |
| Refined contracts | `OBTS-SYNC-IMM-001`, `OBTS-PER-CLIENT-001`, local publication |
| Specification / configuration | `OBTSUploadCheckpointRecovery.tla`, `OBTSUploadCheckpointRecovery.cfg` |
| Executable check | `node scripts/check-upload-recovery-model.mjs` (also selected by `test:formal:client-state`) |
| Implementation / regression | `recoverUploadCheckpointIfNeeded`, `settleUploadCheckpointHandoff`; `tests/plugin-upload-recovery.test.ts` |

The bounded model starts with either a matching or already-replaced queue. It checks protected old/base and successor evidence, watcher hints, fresh replay of the same target/base, real integration results, and restart after queue publication. Device-ref movement can precede integration and cannot authorize a fabricated result. Processing must complete before settlement; missing/expired/open/rejected sessions replay through a real server result without cancellation. Eight negative controls independently remove protection, retire early, lose successor/hints, rebind either base, infer acceptance from the ref, or forget a published settlement.

The runner requires nontrivial state/depth counts and each negative control's exact invariant failure. Safety explores 604 distinct states at depth 9. It abstracts authenticated server responses, Git closure and atomic filesystem publication; executable real-server and fault tests cover those boundaries. It does not prove filesystem power-loss durability, mobile lifecycle behavior, conflict-review internals, or unbounded liveness.

## OBTS-FM-002: Composed Distributed Synchronization

| Field | Value |
| --- | --- |
| Status | Accepted bounded composed model |
| Architecture revision | 32 |
| Refined contracts | `OBTS-SAF-001` through `OBTS-SAF-006`, `OBTS-SAF-010`, `OBTS-SYNC-IMM-001`, `OBTS-SYNC-IGN-001`, `OBTS-SYNC-ACK-001`, `OBTS-PER-OP-001`, `OBTS-PER-CLIENT-001`, `OBTS-BRG-PROJ-001` |
| Root specification | `OBTSDistributedSync.tla` |
| Check matrix | `checks.json` (revision-36 matrix retains all 115 previous checks and adds bounded gate/provenance checks; revision 47 adds ten delta-companion checks; exact required IDs and measured baselines are machine-readable) |
| Static transition map / future trace schema | `trace/transition-map.json`, `trace/trace-schema.json` |
| Delta companion / revision | `OBTSDeltaApply.tla`, revision 47; change-proportional apply and capture (`OBTS-SYNC-DELTA-001`) |
| Executable check | `npm run test:formal` |

`OBTSDistributedSync.tla` is the sole composed `Init`, `CoreNext`/`Next`, safety, and liveness authority. Every positive scenario uses the same composed transition relation; scenario constants and guards bound edits, messages, faults, and their meaningful causal seams without state constraints or scenario-specific action whitelists. The composition always contains Plugin1, Plugin2, Bridge Node, Rust Bridge write/projection, server proposal/classification/CAS/conflict/recovery, client apply/ack, directory, and bounded request/reply bag actions. Focused reachability configurations prove claimed triggers rather than relying on one explosive scenario to establish all coverage.

### Durable state and abstraction boundary

- Canonical content is a per-path finite tree. Clean disjoint proposals union their path versions, while same-path divergence enters conflict metadata and three separately durable protection refs.
- Observation and watcher hints are not capture. `ghost.captured` advances only after local Git and coordination publication; restart classifies durable journal, roots, queue/ref, and visible facts as resume, roll-forward, or block.
- Immutable attempts include target, expected device ref, base, directory proposal, object plan, attempt ID, and transfer ID. Bounded message bags permit delay, duplication, request/reply loss, stable retry/query, server idempotence, and reply loss after durable outcome.
- Device/main CAS preparation, side effect, observed old/target/foreign/uncertain reading, and metadata commit are independent. Recovery classifies the durable ref reading rather than trusting an operation phase.
- Directory proposal/intent identity, generation, acknowledged main/event baseline, prepared/committed result, event identity, and target local deletion are journaled. Physical deletion requires a committed canonical tombstone plus identity and emptiness revalidation.
- Projection separately verifies manifest, base, and path OIDs, writes complete derived rows, then publishes the cursor/readiness. Failure retains the prior cursor; PostgreSQL never preserves or repairs client state. The model abstracts commit ancestry and the choice of incremental versus complete inventory at base verification: a non-ancestor cursor uses the complete inventory and the same row-verification/publication ordering, but selection and audit retention specifically across this divergence/rebuild path are not modeled or claimed; FM002 and FM003 retain their separate symbolic audit-retention checks.

Local apply state projects non-vacuously through `modules/OBTSApplyRefinement.tla`; `fm002-apply-refinement` is a positive projection check and `fm002-reach-apply-refinement` proves durable coordination is reachable. This remains a state projection, not a claimed full temporal refinement. Accepted `OBTS-FM-001` continues to run independently with its safety, liveness, and four original controls.

### Check matrix and assumptions

The required matrix contains the original six FM-001 checks plus the revision-36 gate/provenance companion checks; seven FM-002 positive safety checks; four separately fair liveness checks; twenty-one trigger/action reachability checks; and sixteen distributed negative controls. Revision 15 adds four positive root-policy safety checks, nine non-vacuity witnesses, and nine independent negative controls. Revision 17 adds the acknowledgement-evidence reach and negative checks above. Revision 27 adds five directory-baseline safety checks, five progress/reconstruction witnesses, and four negative controls for the exact-cursor block, unsafe rebase, missing history, and mislabeled historical snapshot. Revision 32 adds four legacy-retirement witnesses, a full positive safety exploration, ten additional witnesses for queue changes, transfer outcomes, uploads, and restart, and three single-fault negative controls. Removing or retyping any required check fails validation. Accepted architecture status requires zero candidate counterexamples and all required positives.

Liveness is conditional on bounded edits/crashes, eventual restart, retry/delivery, and no permanent storage failure. Fairness is attached to the concrete action/actor sequence for proposal/result consumption, Rust write to Node capture, server restart/recovery, and main event to durable apply/server acknowledgement. Each obligation has a separate reachable-trigger check; there is no broad fairness disjunction.

The safety bounds include two same-path plugin edits; two disjoint Plugin1/Bridge paths; meaningful client/server/Rust crash seams; and at most two symbolic message copies. The all-actors bound retains every claimed interaction but causally orders the three proposals and bounds each crash/network fault to one relevant seam. Equal, covered, and divergent classifications are independently reachable; divergence never moves the device ref.

### Root `.gitignore` policy bound (revision 15)

The composed `SafetySpec` retains all prior actors and actions. In `root-ignore`, `PathB` is the root `.gitignore` and `PathA` is one tracked note newly matched by it. `empty` and `exclude-a` stand for exact policy-byte/blob identities, **not** an implementation of Git matching. Plugin1 changes and captures the root policy, then persists an immutable attempt containing that policy; the server checks the symbolic policy identity against its proposed commit and rejects a candidate retaining excluded `PathA` with a durable attempt outcome. Canonical integration removes only the current `PathA` tree entry and retains the old `BaseVersion` in `mainHistory` and local Git. Plugin2 starts incapable and can observe/capture/queue an offline local edit but cannot pull/ack or submit a request until it explicitly upgrades; apply pins the event policy in its journal and skips mutation/displacement of the local-only path. A stale Plugin2 proposal under `empty` enters protected review rather than moving the ref. The Bridge projection pins the policy, removes `PathA` from current derived rows before cursor publication, and retains audit. Bridge local writes remain permitted regardless of the policy and retain their visible bytes; capture omits an ignored path from a candidate tree. In `root-ignore-bridge-race`, a Bridge write starts before policy integration and finishes afterward; the local write survives, while the excluded version cannot enter the current candidate tree or derived rows. A negative control discards the ignored local write and violates preservation. The separate `root-ignore-invalid` bound proposes a policy-bearing tree that still contains `PathA`; rejection remains queryable and cannot move canonical content. Negative controls break each of these independent boundaries.

`root-ignore-legacy` begins with a **pre-existing** root policy byte identity `exclude-a` and a canonical tree that still contains the matched tracked `PathA`; `policyActive = FALSE` marks this historical state, not a valid newly admitted tree. All pull/ack and proposal activity remains closed until `ActivateLegacyPolicy` reconciles the current tree forward and emits a policy-bound event; the old content remains rooted. The mutant that enables policy without reconciliation violates the current-tree invariant. This bound is an explicit activation choice, not an assertion that every historical tree was always policy-valid.

The 22 added checks passed TLC 2.19 / Java 21: safety generated/distinct/depth 10,116/1,718/61 (`root-ignore`), 602/136/21 (legacy), 18,295/2,662/39 (Bridge race with a reachable pre-activation write), and 31/13/13 (invalid candidate). Nine reachability counterexamples witness policy integration (depth 19), protected stale review with three separately protected conflict roots (42), local-only apply (47), derived cursor (28), legacy activation (2), a permitted Bridge write before activation, a stale Bridge validation after policy integration (20), offline old-client local capture/queue before upgrade (31), and a server-side rejected malformed candidate (8). Nine single-fault controls violated their designated invariants with exact witness actions: local-only displacement, incapable-client pull, stale main admission, in-flight policy mutation, excluded Bridge write, excluded projection row publication, activation without reconciliation, excluded candidate admission, and stale Bridge write-seam bypass. The executable checker enforces their witness and trace-depth floors.

This is a **bounded design model**, not feature implementation evidence. The actual Git matcher, blob-byte calculation, full candidate trees, subtree/rename/collision behavior, capability authentication, concurrent root-file edits during capture or in-flight transfer, other unscheduled Bridge write interleavings, arbitrary embedded policy-bearing paths, and policy updates during partial projection/restart need implementation tests or stronger models. Static transition mappings for these new actions point to existing ownership families, not a claim that the root-ignore feature already exists in production.

### Acknowledgement evidence bound (revision 17)

`server.deliveredAckEpoch[c]` captures, at each planned local apply, the canonical epoch whose directory snapshot the pull delivered. `AcknowledgeEvidence(c)` admits an acknowledgement through the current main (server recomputation), the retained delivered snapshot, or reconstruction from contiguous retained event history (`server.historyRetained`). In `disjoint-directory`, Plugin1/Bridge proposals can integrate a newer canonical main while Plugin2's apply pipeline is between its plan and its acknowledgement: before this revision the acknowledgement was permanently blocked there, which is exactly the production `applied_snapshot_unavailable` failure. `AcknowledgeHistorical` marks the reconstructed-evidence acknowledgement. `fm002-reach-ack-reconstruction` proves the historical acknowledgement still completes after a newer pull replaces the delivered snapshot, and `fm002-negative-ack-evidence-loss` proves the model reproduces the stuck state and fails closed when the delivered snapshot is replaced and no event history remains. `AckIntentResolvable` joins the safety invariant set.

### Directory-baseline cursor bound (revision 27)

The bounded `directory-baseline` scenario starts with a locally applied main and queued local work at cursor 1, then advances the server cursor through either a neutral event or a directory intent before acknowledgement. The delivered-snapshot case keeps the cursor aligned. The compatibility case accepts a trailing proposal cursor only when the retained interval is neutral and the snapshot matches; an intervening directory intent or unavailable history rejects it. A second main advance exercises historical reconstruction: a newer acknowledged snapshot may be returned for an older main only with its true cursor and neutral intervening history. Negative controls require exact-cursor rejection, unsupported rebasing over a directory intent or missing history, and the former older-cursor/newer-snapshot label to violate their target properties.

The model abstracts the event interval as a contiguous-retained flag plus its latest directory-affecting sequence. It does not implement event storage or payload parsing; executable regressions cover those production details.

### Completed legacy advance retirement (revision 32)

The `legacy-retirement` scenario models archived queue identity, changing hints and visible edits, nondeterministic transfer status, open-transfer cancellation, processing/accepted rejection, and late acceptance after a missing, expired, or ambiguously cancelled transfer. The late acceptance moves the device ref and prevents a later upload with the old expected ref; an already completed new upload likewise prevents the old transfer's CAS. After authorization a newer queued commit may remain identical to the archived one or advance to a known descendant; an unrelated commit blocks. A separate settled-state invariant enforces this even when the action guard is mutated. The archive is published before authorization, the obsolete upload, queue and pull coordination retire in order, and the journal is cleared last. Plugin1 may crash after any write and resume with a changed volatile counter that does not invalidate the archived stable evidence.

The 109-check matrix includes bounded positive safety exploration, 14 legacy reachability witnesses, and three permanent negative controls. Removing the archived newer-queue binding violates `LegacyArchivedQueueBound` on journal clearance; requiring volatile archive equality violates `LegacyArchiveReusable` after restart; clearing the journal early violates `LegacyRetirementSafe`. A temporary mutation that uploads the ignored delete also violated `AllSafety` at `LegacyNormalUpload`. The model uses symbolic commit ancestry, status, and one preserved edit; the plugin and real local-server tests check Git content, persisted checkpoints, and HTTP cancellation separately. Late acceptance after transfer expiry is modeled but has no end-to-end race test.

### Implementation recovery check

`configs/server-recovery-implementation.cfg` constructs a real divergent second proposal, commits conflict metadata and all three protection refs, prepares a `conflict_resolve` operation, moves `main`, crashes, and recovers from the target ref reading. Startup recovery now commits the complete prepared effect set: resolving-user attribution, audit, both resolution events, device last-success time, and directory result. `ExactPreparedOperationRecovery` passes across 11,389 generated and 3,772 distinct states at depth 56.

The production regression in `tests/phase2.test.ts` performs a genuine conflict resolution, retains the moved Git `main`, rewinds metadata to the prepared state, restarts the server, and verifies the same effects. New conflict-resolution operations persist the resolving user in their prepared manifest; incomplete legacy manifests fail closed rather than fabricating attribution.

### Negative controls and harness

The original fifteen distributed controls mutate one behavior after realistic setup: in-flight target replacement, accepted-root loss, covered-ref rewind, divergent-proposal discard, main move without preparation, early apply acknowledgement, uncaptured Bridge overwrite, recursive tombstone deletion, moved-ref abort, duplicate non-idempotent processing, retry identity mutation, conflict metadata without complete protection, uncertain-CAS abort, seen/applied cursor conflation, and projection cursor publication before complete verification.

The checker requires the exact invariant, witness action, and minimum meaningful trace depth. It rejects timeout, parse/semantic failure, deadlock, wrong invariant, absent/shallow witness, state/depth overflow, required-matrix removal, status mismatch, stale evidence, path traversal, invalid source ranges, state-space collapse, and unexplained greater-than-twofold growth. `tests/formal-checker.test.ts` covers these gates; formal CI runs it before TLC.

### TLC evidence

Final checked run: TLC 2.19, Java 21, one worker, fingerprint polynomial 0. Baselines and lower/upper gates are authoritative in `checks.json`.

| Positive check | Generated | Distinct | Depth |
| --- | ---: | ---: | ---: |
| FM-001 safety / liveness (each) | 237 | 163 | 20 |
| same-path safety | 116,864 | 28,029 | 77 |
| disjoint/directory safety | 383,858 | 47,581 | 73 |
| server recovery contract | 188,452 | 62,080 | 80 |
| Bridge handoff safety | 378,569 | 61,396 | 44 |
| all-actors safety | 2,071,813 | 385,576 | 95 |
| apply projection safety | 496 | 157 | 34 |
| proposal liveness | 106 | 42 | 27 |
| Bridge liveness | 16,963 | 2,846 | 39 |
| server-recovery liveness | 871 | 307 | 48 |
| apply/ack liveness | 484 | 151 | 34 |
| implementation recovery | 11,389 | 3,772 | 56 |

All original twenty reachability checks produced their required witness. All four FM-001 and original fifteen FM-002 negative controls violated exactly their intended invariant with the required meaningful prefix. See the executable summary from `npm run test:formal` for every generated/distinct/depth tuple.

### Traceability and omissions

`trace/transition-map.json` maps every root action and the required production families to existing, range-validated code/test evidence. It cites `obsidian-plugin/src/main.cjs` only within its current 9,652 lines. The schema/map are static design artifacts only: runtime transition instrumentation and replay do not exist, so no runtime trace conformance or implementation proof is claimed.

FM-002 remains bounded and does not prove byte/checksum correctness, Git ancestry implementation, Git-ignore matching semantics, semantic merge formats, filesystem/power-loss durability, editor-buffer flushing, authorization, onboarding, restore, event-pruning recovery, transfer expiry, rename graphs, garbage collection, backup/restore, or real process supervision. Transfer expiry and event-cursor expiry appear in the static production-family map but are not modeled transitions. Audit retention is omitted. The contract-required integrated server/Rust/Node/PostgreSQL deployment fault test remains outstanding.

### Change-proportional apply and capture companion (revision 47)

`OBTSDeltaApply.tla` refines `OBTS-SYNC-DELTA-001` without widening the composed state space. `OBTSDistributedSync.tla` keeps cumulative per-path version sets and abstracts commit and tree identity, so it cannot express whether a target tree equals the authoring base; the companion uses exact symbolic values instead. It has one client, a symbolic server and two paths. `head` is the local commit tree, which is the authoring base M0 once every capture is pushed. A push integrates atomically: an unchanged canonical path takes the local version, otherwise canonical bytes stay and the local version is preserved. Every push advances the canonical commit even when the tree is unchanged, matching the server's merge commit.

User edits deliver a durable hint or lose it. Hint capture reads only hinted paths; inventory reads every path and may run at any time, and a background tick cannot pass `InventoryPeriod` without one. Apply admits T only when no captured change awaits upload. The footprint is every path where T and M0 differ; each footprint path is re-read in the gate, and a locally changed one is deferred with M0 (or an older sticky base) as its proposal base and stays visible. Paths outside the footprint are neither read nor written. Ref-only apply is the empty-footprint case with no sticky obligation. Journal, recovery publication, acknowledgement durability, crash and restart stay FM-001/FM-002 obligations; directory intents, policy changes and held work are abstracted because the contract widens the footprint for them. Byte-identical edits that a metadata inventory cannot detect belong to the full audit and are not modeled.

`NoLocalEditLost` requires the latest user version to stay visible, captured or server-preserved. `NoPhantomEdit` requires visible bytes outside the dirty set to equal the local commit, so moving refs never turns unchanged bytes into an apparent revert. `StaleBaseRetained` keeps a deferred path's older base until its edit settles, and `MissedEditBoundedDelay` bounds how many background cycles a lost event can delay capture. Liveness `EditsEventuallyCaptured` and `EventuallyConverged` assume weak fairness of hint capture, inventory, push and footprint apply.

| Check | Kind | Generated | Distinct | Depth |
| --- | --- | ---: | ---: | ---: |
| `fm002-delta-safety` (2 user, 1 remote edit) | positive safety | 35,692 | 12,015 | 12 |
| `fm002-delta-safety-wide` (3 user, 2 remote edits) | positive safety | 3,426,554 | 1,042,881 | 17 |
| `fm002-delta-liveness` | positive liveness | 35,692 | 12,015 | 12 |
| `fm002-delta-reach-ref-only` | witness `ApplyRefOnly` | 496 | 342 | 5 |
| `fm002-delta-reach-deferred` | witness `ApplyFootprint` | 111 | 87 | 4 |
| `fm002-delta-reach-untouched` | witness `ApplyFootprint` | 217 | 161 | 4 |
| `fm002-delta-reach-inventory-rescue` | witness `Inventory` | 32 | 28 | 3 |
| `fm002-delta-negative-ref-only-tree` | fails `NoPhantomEdit` | 58 | 48 | 3 |
| `fm002-delta-negative-trust-hints` | fails `NoLocalEditLost` | 210 | 157 | 4 |
| `fm002-delta-negative-skip-inventory` | fails `MissedEditBoundedDelay` | 661 | 481 | 5 |

The three mutants are the shortcuts this contract forbids: moving refs without comparing trees, treating unhinted footprint paths as clean instead of re-reading them, and relying on hints alone. Skipping the inventory also fails `EditsEventuallyCaptured` under the liveness configuration. The transition map cites current full-vault code as a superset refinement until the ref-only, footprint and hint-scoped implementation lands.

## OBTS-FM-003: Focused Bridge Bounded-Body Projection

| Field | Value |
| --- | --- |
| Status | Accepted bounded architecture model; independently reviewed implementation and synthetic-stack receipts recorded separately |
| Architecture revision | 6 (same unlanded change) |
| Refined contracts | `OBTS-BRG-PROJ-001`, `OBTS-BRG-BODY-001`, ownership aspects of `OBTS-BRG-QUERY-001` |
| Specification | `OBTSBridgeBoundedBody.tla` |
| Check matrix | `checks-fm003.json` (39 required checks: original 22 retained and 17 added) |
| Executable check | `npm run test:formal:bridge`; also in default `npm run test:formal` |
| Trace map | `trace/fm003-trace-map.json` |

### Bounds and correction

The original agent-authored draft equated one row with one file and its body size; that abstraction could not expose reviewed tag/link row overflow or oversized metadata starvation. The corrected model has four files (including a private file), two body slots, input sizes 1/3/2/4, input-file limit 4, shared in-flight input budget 6 and aggregate 10 above the retired limit 6. Thirteen independently identified/kinded/sized rows include F1 metadata plus two tags, two links and two blocks; F2/F4 metadata sizes 9/8 exceed the normal batch-byte budget 6. Normal rows obey count 2 and bytes 6; two normal block rows of size 4 make byte pressure non-vacuous. These are symbolic fixtures, not MiB conversion factors or a parser expansion ratio.

Acquisition and revision/OID verification are separate from row enqueue and commit. A normal batch must flush before a singleton can acquire the shared permit; the singleton retains both permit and file body ownership through commit and cleanup. Failed/cancelled work drains before settling. Required rows are independent of the implementation's completion predicate: the omitted-row control deliberately omits row 13 from that predicate while the cursor invariant still demands all thirteen. Cursor publication additionally requires empty pending work, no body leases/singleton owner and cleanup completion.

File acquisition and each file's row stream are ordered to bound the search while allowing two bodies and interleaved row streams. Healthy projection begins at cursor 1 and reaches cursor 3 through a second target; restart scenarios instead replay one interrupted target with previously committed rows retained. Partial/superseded-row deletion is abstract cleanup, not a proof of SQL deletion or revert behavior. Weak fairness applies to each finite acquisition/verification/release/enqueue action and commit, singleton cleanup, failure drain, restart and completion. Source-failure drain additionally uses the existing source-failure fairness. No liveness guarantee is made under endless external cancellation or unavailable source/DB.

### Checked evidence

The corrected run used actual TLC 2.19 / Java 21, one worker and fingerprint polynomial 0, with SANY first. All original 52 FM001/FM002 checks remain unchanged and passing. FM003 has nine positive checks and thirty reachability/negative controls. Positive generated/distinct/depth baselines and half-baseline floors are recorded in the manifest; the largest positive search is 23,798 distinct states (below the 100,000 ceiling), not an unbounded production proof.

| Positive checks | Generated | Distinct | Depth |
| --- | ---: | ---: | ---: |
| bounded safety / liveness | 7,602 | 2,506 | 78 |
| source-failure safety / drain | 64,088 | 23,798 | 78 |
| caller-denial safety | 16,884 | 4,166 | 78 |
| cancellation safety / drain | 34,884 | 12,416 | 78 |
| partial-restart safety / liveness | 54,999 | 18,063 | 51 |

New reachability witnesses include singleton enqueue/cleanup (depths 6/8), partial restart (10), replay reaching Ready (45), cancellation while owning a singleton (8), all seven F1 rows committed (15), second target cursor (78), and normal byte pressure (13). Existing failure-release checks now require release while actually Failed rather than accepting an unrelated successful release.

| New negative control | Required violation | Generated / distinct / depth |
| --- | --- | --- |
| old unbatched metadata/tag/link fanout | `BatchBounded` via `EnqueueLegacyFanout` | 11 / 8 / 5 |
| oversized row has no singleton admission | `ProjectionCompletes` temporal counterexample with fair normal actions and supported input | 448 / 160 / 24 |
| oversized row mixed with normal rows | `BatchBytesBounded` via `MixOversizedRow` | 50 / 29 / 8 |
| omitted row / premature completion | `CursorAfterVerifiedRows` via `AdvanceCursor` | 3,488 / 1,148 / 37 |
| permit released after commit but before singleton cleanup | `SingletonOwned` via `ReleasePermitEarly` | 79 / 40 / 8 |

The old fanout control enqueues five normal metadata/tag/link rows totaling five bytes: it isolates row-count overflow without violating the six-byte budget. The starvation check requires the sole configured temporal property to fail, an actual verification prefix and a complete finite search; the harness distinguishes temporal counterexamples from invariant failures. It does not turn a hand-authored rejection into alleged starvation evidence. All six original negative controls still reach their declared violations.

```text
npm run test:formal
Formal checks complete: 52 required checks; 0 current candidate counterexample(s).
FM003 passed: 39 checks; 9 positive, 30 reachability/negative controls.
```

### Conformance boundary

Hard obligations concern input-file bytes, finite body ownership, normal encoded-parameter payload/row count and singleton concurrency/ownership. There is no numerical encoded-singleton ceiling or hard RSS bound: parser trees, normalization/encoding, derived singletons and driver/response copies require separate costing and high-water measurements. The model does not prove the SQL compiler/authorization implementation, legacy lexical equivalence, graph completeness, context ranking, response format/order, parser behavior or physical durability.

The independently cleared core 0.1.3 lane has since corrected those original gaps: normal/singleton batching, lexical equivalence, complete graph queries and response ownership have component evidence in `trace/fm003-trace-map.json` (157 units and 13 actual-PostgreSQL checks, parent-reported). The parent also reports Node 299 and 30 local full-stack checks including distributed 8-to-72-MiB RSS, pending-edit SIGKILL and client-volume restore. This architecture-only worker gate does not rerun or reinterpret that evidence as worker acceptance. Worker implementation, near-64-MiB input counters and the final post-worker stack were subsequently completed; see `trace/fm003-worker-trace-map.json` and `docs/bridge-embedding-worker-evidence.md`. Its `checked-worker` status requires independent-review attribution and passing disabled/local stack reports for the same binary. Isolated near-limit RSS, live delivery and complete runtime/TLA trace conformance are not claimed. Derived normalized plaintext in PostgreSQL/backups remains permitted query projection, never raw body authority; output metadata remains output-proportional, not capped at an internal page size.

### FM003 independent embedding-worker companion

| Field | Value |
| --- | --- |
| Contract / revision | `OBTS-BRG-EMBED-001`, `OBTS-BRG-BODY-001`; revision 6, unchanged |
| Specification | `OBTSBridgeEmbeddingWorker.tla` |
| Matrix | `checks-fm003-workers.json`: 48 required checks, independent of the unchanged 39 projection and 52 baseline checks |
| Entry point | `npm run test:formal:workers`; included in `test:formal:bridge` and default `test:formal` |
| Mapping / reduced actual traces | `trace/fm003-worker-trace-map.json`, `trace/fm003-worker-counterexamples.json` |
| Actual action exercise | `trace/fm003-worker-action-coverage.json`, bound to model/configuration digests |
| Implementation status | Forthcoming; static mapping only, not runtime trace replay |

**Why separate:** projection `DriftRevision` only permits an unverified file to drift. It cannot expose updates after capture while a provider is pending, nor a headless/body lock cycle. The companion keeps the already-correct complete-row/cursor/audit projection model unchanged rather than exploding its thirteen-row state space or implying temporal composition.

**Exact finite bounds:** one symbolic note (trusted background, no caller/private-note exclusion), one reused block ID, one worker, one API operation and one shared body slot. A queue contains at most one thin expected note-revision/embedding-schema-epoch/block-epoch/hash tuple, not a body. Source and SQL revisions each range over 1/2; block hash and epoch independently range over 1/2. Each attempt extracts two chunks sequentially with one symbolic payload unit per provider batch. The embedding schema/model epoch independently ranges over 1/2, with captured/vector/retry schema tokens over 0/1/2. There is at most one source OR hash OR block-epoch OR embedding-schema replacement, one failure OR cancellation, and one API operation. Source and schema replacement are checked in separate configurations, not concurrently combined. There is no numerical connection from these symbolic units to input MiB, encoded bytes or RSS; the existing 64-MiB default input and normal derived-write/singleton contracts are unchanged.

**Actions and ownership:** `TakeQueue`, `WorkerHeadless`, `WorkerBody`, `AttestBody` acquire in headless-before-body order and release headless before `BuildBatch`/`ProviderReply`/`ProviderFailure`. Input and payload stay under the body permit until consumption/disposal; `Drain` releases before another capture. `SourceEdit` occurs while provider input is already captured; `PublishProjection` may precede or follow result completion and invalidates prior vectors/retries. `ReplaceBlock` independently changes hash or epoch even with unchanged parent note revision. `CompleteSQL` atomically compares captured SQL-generation tokens, including the embedding schema/model epoch for notes AND blocks, returns matched zero and preserves current vector/readiness/retries for stale success/failure. An old attested source result may match an old SQL projection until publication; `RejectAttestation` prevents a fresh capture against an obsolete source token. Reindex uses the same abstract guarded block publication, not a concrete SQL block-stream proof. `SchemaReset` may occur during `Provider` or `Complete` (completion SQL pending before its atomic mutation), advances only the SQL embedding epoch and invalidates vectors/readiness/retries. These schema configurations keep source revision, note revision, block hash and block epoch unchanged: the old model result must not apply even for equal dimensions. `AttestBody` deliberately checks only source revision, not the embedding epoch or a filesystem model fingerprint. The pending SQL abstraction covers an old statement reaching its mutation after reset; process death/backend lifecycle and actual MVCC interleavings are not modeled.

`Cancel` retains input/payload ownership while `LateReply` ignores the result, then `Drain` disposes it. The model does not prove that an unresponsive transport is interruptible: actual shutdown/cancellation must either dispose transport ownership or safely retain-and-drain it. Positive `ApiProgress` checks an API holding headless while waiting for the provider-owned sole body slot; correct completion is SQL-only. The inverse-acquisition mutant takes body before headless; the completion-lock mutant waits for headless before releasing body. Both reach actual TLC deadlocks with `body=worker`, `headless=api`, `api=WaitBody`, and worker respectively `WantHeadless` or `Complete`.

**Fairness:** safety uses no fairness. Liveness adds individual weak fairness for queue/capture/attestation/build/provider reply/consume/SQL completion/projection publication/drain/API continuation (and the legacy empty-snapshot action in its negative control). Edits, schema reset, failure, cancellation and API start are optional, not forced. Source/SQL remain available, provider replies eventually, external mutations/faults are finite and generations stabilize. Checked temporal obligations are eventual stable readiness, drain, waiting-API progress and retry of pending new source and schema SQL generations. Sixteen reachability checks prevent vacuity: the original nine cover stale note/block success and failure, old-source result before index catch-up, late cancelled reply, new-generation retry, API wait and fresh-capture attestation rejection. Seven added checks cover schema-stale note/block success and failure, current-schema retry, reset while completion SQL is pending and actual inverse-order headless acquisition.

**Actual TLC evidence:** TLC 2.19, one worker, fp 0, SANY before each normal matrix run. All 48 pass their declared outcome. Eighteen positive checks pair safety/liveness; sixteen reachability checks and fourteen negative controls require exact outcomes/witnesses and meaningful trace depth. State-space baselines/floors and budgets live in the matrix; largest positive is 908 distinct states.

| Positive pair (each) | Generated | Distinct | Depth |
| --- | ---: | ---: | ---: |
| note / reindex (each pair) | 287 | 196 | 30 |
| block hash / block epoch (each pair) | 141 | 104 | 29 |
| provider failure | 1,334 | 908 | 39 |
| cancellation | 1,126 | 759 | 38 |
| schema note / block / reindex (each pair, failure enabled) | 924 | 671 | 38 |

Negative controls reproduce empty-inner starvation (`EventuallyReady`), ID-only success/failure and reindex, independently ignored hash and epoch (`GenerationSafe`), late cancelled matched result (`CancelledSafe`), and the two real lock-cycle deadlocks. Their generated/distinct/depth tuples are respectively 3/2/2, 118/76/14, 119/84/11, 118/76/14, 63/47/13, 63/47/13, 19/19/8, 6/6/5 and 32/27/13. Reduced actual TLC traces are retained for review, not claimed as implementation regression replay. Five added ignore-schema controls fail `GenerationSafe`: note success, block success and reindex each explore 128/93/13; note/block failure each explore 50/41/10. Same-source schema retry reaches 437/325/22; pending-SQL reset reaches 29/26/9; inverse headless reaches 4/4/4. All original 30 worker baselines remain unchanged.

Review 9e4558bf identified false action-to-check attribution despite correct model semantics. The corrected mapping uses inverse-acquisition, failure, hash/epoch and cancellation configurations that actually exercise those actions, plus failure/drift for attestation rejection. Every mapped action/check pair must have nonzero generated-successor coverage from TLC, not merely a known ID or syntactically present action. `--validate-only` verifies stored coverage and exact model/configuration SHA-256 digests; normal TLC runs independently enforce mappings against fresh `-coverage 1` output. This is finite model-action exercise, not implementation coverage or trace conformance. The Bridge baseline entry points retain 52 + 39 + 48 = 139 existing checks without modifying those baseline, projection, or worker models. The repository default additionally runs the independent FM004 deletion and FM005 Bridge external-protocol matrices.

**Omissions and handoff:** `CompleteSQL` and replacement are atomic abstract linearization points. A READ COMMITTED `UPDATE blocks ... FROM notes` revision predicate alone does not prove that atomicity: use a parent-row transactional guard/consistent lock order or a target-row epoch and coordinated replacement. Schema/model invalidation must likewise serialize with note/block mutation: update a target-row schema epoch with invalidation or use consistent transactional guarding. A source-only CAS or separate global-schema preflight/snapshot does not protect against an old SQL statement completing after a reset, including after process death. Multiworker scheduling, backend/process lifecycle, combined source-plus-schema changes, SQL/MVCC execution, source SHA/OID computation, filesystem faults/durability, block cleanup details, embedding arithmetic/quality, parser/HTTP encoding/driver allocations and RSS are not proved. The worker trace map gives exact existing seams and actual-PG/fake-provider/shared-headless regressions still required; neither core evidence nor green TLC establishes worker implementation conformance.

## OBTS-FM-004: Whole-Vault Deletion Lifecycle (accepted formal architecture)

| Field | Value |
| --- | --- |
| Status | Accepted formal architecture; repository gate evidence approved by independent review |
| Architecture revision | 7 (preserved; no additional bump) |
| Refined contracts | `OBTS-SAF-008`, `OBTS-SEC-DEL-001`, `OBTS-PER-DEL-001`, `OBTS-DASH-DEL-001`, `OBTS-VER-DEL-001` |
| Specification | `OBTSVaultDeletion.tla` |
| Check matrix | `checks-fm004.json` (29 required checks) |
| Checker | `scripts/check-deletion-model.mjs`; SANY before each TLC matrix run |
| Implementation map | `src/server/vaultLifecycleCoordinator.ts`, `src/server/metadataStore.ts`, `src/server/chunkTransferService.ts`, `src/server/app.ts`, `src/server/syncService.ts`, `src/server/connectionService.ts`, `src/shared/types.ts`, `frontend/dashboard/src/api/client.ts`, `frontend/dashboard/src/api/types.ts`, `frontend/dashboard/src/components/SettingsPage.svelte`, `openapi/openapi.yaml`, and `tests/vault-deletion.test.ts` provide the current implementation/evidence map |

### Corrected lifecycle boundaries

The accepted model separates volatile request/captured identity, runtime admission closure, durable intent/revocation/job publication, observable 202 acceptance, durable restart discovery, erasure, final completion, and relative receipt expiry. `CaptureRequest` captures route target, owner, and typed confirmation identity. `CloseAdmissions` closes target admission without waiting for drain. `PublishIntent` durably writes intent, revocation, target, and the deleting lifecycle record; only `PublishResponse202` may set observable acceptance. `RejectIntentPublication` leaves all durable deletion state unchanged and permits reopening only when publication is unambiguously rejected. An ambiguous outcome remains closed and cannot be reopened by the model. `Crash` clears volatile request/capture state; `Restart` discovers only a durable deleting job after `RestoreDeletionBarrier`. The mapped implementation now covers the core HTTP, metadata, coordinator, transfer marker/inventory, startup barrier, shared client types, and Settings seam. Runtime conformance is not claimed for every listed vault-touching path, physical secure erasure, distributed locking, or all model counterexample families; those remain residual verification obligations.

The accepted model binds the typed confirmation identity to the captured target, models same-owner wrong confirmation and stale live-selection mutants, and retains wrong-owner/unknown-target controls. HTTP 404 equivalence, repeated-request idempotence, exact API schema, and status/list redaction remain explicitly runtime/API obligations rather than claims of this bounded state model.

### Scope, preservation, and fail-closed behavior

Five finite residue classes stand for exact target-owned server scope: Git/history; metadata/history (sync, operation, directory, conflict, history-index and event state); transfer/temp; device credentials/connections; and diagnostics. An unattributed-residue state blocks correct completion; a mutant that completes anyway is rejected. Startup repair/recreation after receipt/expiry, protected local/Bridge/backup mutation, and other-vault mutation each have focused negative controls. Exact-path validation, symlink safety, complete legacy residue inventory, and ownership attribution remain runtime obligations.

The lifecycle is active or `blocked_integrity` -> deleting -> deleted receipt -> expired. A completed or expired target cannot be recreated/reopened. Local client files, independent Bridge filesystem/PostgreSQL state, and backups remain outside the erasable set. Receipt retention is the approved 30 days after completion; `ReceiptDays = 3` logical ticks are a relative bounded abstraction and cannot advance before completion. The relative receipt age persists through restart and `ReceiptEventuallyExpires` is checked under explicit fairness.

### Bounds and assumptions

Two vaults/two owners, one target, one admitted slot, one detached slot, one crash/restart, one finite erase fault, one finite final-publication fault, and five residue classes keep the state space reviewable. Positive liveness assumes finite faults, fair scheduling, one owner/process per data directory with prior subprocesses stopped at restart, and ordinary supported filesystem durability. No distributed-lock, wall-clock, physical secure-erasure, or implementation-conformance claim is made.

### Matrix and required controls

Positive checks cover safety, conditional deletion liveness, blocked-integrity deletion safety, and conditional receipt-expiry liveness. Reachability checks require deletion-state crash/restart barrier restoration, erase-fault retry, final-publication retry, post-final-fault crash/restart, receipt expiry, blocked target, pre-intent crash/restart, intent-publication rejection, and durable 202 acceptance. Negative controls require exact witnesses for failed-publication mistaken acceptance, response-before-durability, same-owner wrong phrase, stale live selection, wrong owner/unknown target, erase-before-intent, admission after closure, premature completion, unfinished expiry, early lease release/late reuse, unattributed residue completion, startup recreation, protected boundary mutation, other-vault mutation, and ambiguous-publication reopening.

The checker rejects parse/semantic failure, unexpected deadlock, timeout, resource overflow, wrong invariant, missing/shallow witness, state-space collapse, and matrix drift. It has no production source map.

### Accepted formal architecture/repository-gate evidence

Actual run: Java 21.0.12.1, TLC 2.19, SANY first, one worker, fingerprint polynomial 0. Full logs and witnesses are under `/tmp/obts-dashboard-stage2/fm004-corrections/evidence/`.

| Check family | Outcome | Generated | Distinct | Depth |
| --- | --- | ---: | ---: |
| deletion safety/liveness (each) | PASS | 20,846 | 3,153 | 21 |
| blocked safety | PASS | 20,250 | 3,039 | 21 |
| receipt expiry liveness | PASS | 20,846 | 3,153 | 21 |
| deletion crash/restart witness | REACHED | 81 | 40 | 6 |
| erase fault then retry | REACHED | 41 | 22 | 6 |
| final publication fault then completion | REACHED | 2,031 | 290 | 11 |
| final fault then crash/restart | REACHED | 2,056 | 296 | 12 |
| receipt expiry | REACHED | 2,050 | 293 | 14 |
| all remaining reachability/negative controls | REACHED | see result artifact | see result artifact | exact witnesses |

Independent review approved this evidence for the repository gate. FM004 acceptance is an architecture/formal gate only: no backend/API/UI implementation or runtime conformance is claimed, and all runtime obligations remain.

## OBTS-FM-005: Bridge External Write And Export Protocol

| Field | Value |
| --- | --- |
| Status | Accepted focused bounded model |
| Architecture revision | 12 |
| Refined contracts | `OBTS-BRG-WRITE-001`, `OBTS-BRG-EXPORT-001`, export ownership aspects of `OBTS-BRG-BODY-001` |
| Specification | `OBTSBridgeExternalProtocol.tla` |
| Check matrix | `checks-fm005.json` (20 required checks) |
| Executable check | `npm run test:formal:bridge-protocol`; included in the Bridge and repository formal entry points |

The revision lane separates caller admission from the atomic source-revision seam. Matching preconditions authorize one mutation; missing and stale inputs reject without mutation; a source change after preparation rejects at the seam. Three controls deliberately accept missing, stale, or post-validation-drift writes and must violate `RevisionMutationAuthorized`.

The export lane selects the policy-visible candidate set before hydration, owns at most one candidate body, releases it after private spooling, writes the manifest before entries, and reaches terminal state only after archive completion or cancellation drain. Three controls deliberately hydrate a denied file, write an entry before the manifest, or claim completion while retaining a body lease.

Actual TLC 2.19 used one worker and fingerprint polynomial 0. Nine positive safety/liveness checks passed; five reachability checks and six negative controls produced their declared invariant witnesses. The largest positive search was 50 generated / 24 distinct states at depth 11. Revision safety/liveness used 8/4/4; missing 7/3/3; stale 6/3/3; drift 12/6/5; export safety/liveness 20/10/10; export cancellation safety/drain 50/24/11. SANY passed before the matrix.

The model assumes a finite two-file visible export plus one denied file, one export body slot, deterministic eventual progress, and one symbolic external source change. It does not model token hashing, file bytes, SQL policy compilation, ZIP/path implementation, disk permissions/capacity, HTTP response-drop mechanics, timestamps, ETag parsing, database isolation, filesystem durability, or runtime conformance. Those remain executable and operational evidence obligations.

## OBTS-FM-006: Durable Browser-Assisted Onboarding

| Field | Value |
| --- | --- |
| Status | Accepted focused bounded model |
| Architecture revision | 21 |
| Refined contracts | `OBTS-SYNC-ONB-001`, `OBTS-SAF-002`, `OBTS-SAF-005`, `OBTS-SAF-009` |
| Specification | `OBTSOnboarding.tla` |
| Check matrix | `checks-fm006.json` (11 required checks) |
| Executable check | `npm run test:formal:onboarding`; included in the repository formal entry point |

The model separates the pending browser deadline from the approved enrollment lease, publishes durable consent before registration (the early disposition choice made before browser approval or confirmed afterward), pins one immutable server baseline while canonical state may advance, consumes authorization at device registration, transfers with a durable chunk cursor and target-bound complete final checkpoint, publishes recovery before replacing non-empty local state, and records local apply, durable acknowledgement (which permits checkpoint cleanup), catch-up transfer/checkpoint/apply/acknowledgement, and activation as separate boundaries. It preserves those durable boundaries across one crash/restart. Protocol fields denote already published durable records; `running`, `crashCount`, and `lastAction` are the execution layer. Crash therefore discards execution while retaining published state, and the negative controls model incorrect publication ordering. Host flush behavior remains an implementation obligation.

Four positive checks cover empty and non-empty safety/liveness. One reachability check proves transfer restart after durable chunk progress. Six negative controls deliberately reuse the pending deadline after approval, retarget the approved snapshot, transfer before credential publication, apply before recovery, enter the post-transfer phase without a complete checkpoint, or activate before durable acknowledgement. Each must violate its named invariant with the declared action witness.

Actual TLC 2.19 used one worker and fingerprint polynomial 0. Empty safety explored 1199 generated / 781 distinct states at depth 21; empty liveness 179/123/18; non-empty safety 1527/921/22; and non-empty liveness 196/134/19. The restart witness reached 59/48/8. All seven negative controls reached their intended violations between depth 3 and 9. SANY passed before the matrix.

The model does not prove cryptography, Git object or manifest correctness, filesystem durability, wall-clock scheduling, iOS background execution, Rust/Node process supervision, HTTP proxy behavior, or implementation conformance. Executable fault tests and real-device/deployed-Bridge evidence remain mandatory.

### Enrollment receipt and recovery companion (revision 45)

`OBTSOnboardingRecovery.tla` extends the evidence without changing the original matrix. The previous abstraction treated registration and durable client context as one publication. The `legacy-context` control now reproduces the actual missing-analysis failure: context remains only in modal memory, the server accepts enrollment, process termination removes volatile context, and restart violates `ResumeHasContext`. Correct publication retains identity, original approval baseline, mode and consent before `Accept`; `PublishReceipt` remains separate so lost replies can be replayed. One crash, two heads and two symbolic chunks bound the search.

`Recover`, `Apply`, `CompleteLiveApply`, `Ack` and `CatchUp` impose unresolved-journal admission and acknowledgement ordering. Controls reproduce overwriting an unresolved journal after restart, discarding a complete checkpoint after main advancement, applying a new head before settling the pending acknowledgement, losing a durable catch-up obligation after acknowledgement, and publishing an upload captured from intermediate rollback ancestry. Revision 26 models edits during a live apply and a second edit during snapshot capture: the changed path remains visible while the apply completes, a captured snapshot may lag the latest edit without blocking completion, and the latest visible version remains recoverable for follow-up capture. Revision 45 adds durable catch-up edit capture against a validated exact intermediate tree, binds captured paths to pre-apply M0 (with an older path obligation taking precedence), and retains a durable edit obligation until final-canonical proposal scheduling. Completion and retirement cannot bypass capture or handoff. Negative controls reach skipped capture, wrong intermediate-tree identity, dropped handoff, and intermediate-ancestry upload. Crash/restart witnesses cover durable capture and the handoff phase. `current-live-edit-block` reproduces the previous visible setup failure; `discard-live-edit` proves completion cannot drop the edit; `multi-edit-capture` requires the second edit interleaving to be reachable. The earlier interrupted-apply divergence and discard controls remain. Model state represents validated tree identity and durable capture/scheduling records; it does not prove their concrete validators or storage durability. Fair liveness assumes successful storage/network retry and one eventual restart.

The TLC checker passes SANY and twenty four companion checks. Safety, base retention, eventual completion, and eventual edit scheduling each explore 3,502 generated / 1,969 distinct states at depth 28. The skipped-capture, wrong-tree, dropped-handoff, and both crash/restart witnesses reach their designated states. `scripts/check-onboarding-recovery-model.mjs` requires exact invariant/action witnesses, bounded state/depth exploration, successful positive completion and no parse/resource/deadlock failure. Both onboarding and full formal commands include it.

| Boundary | Implementation | Executable evidence |
| --- | --- | --- |
| `PublishContext`, `Accept`, `PublishReceipt`, `Restart` | `prepareReplacementOnboarding`, `finishOnboarding`, `finishOnboardingInternal`; `ConnectionService.statusInternal` and `existingCompletion` | `tests/onboarding-mobile-restart.test.ts`: real packaged modal, historical null-analysis migrations and separate credential/identity/marker SIGKILL seams |
| `PlanApply`, `DivergeEdit`, `BeginLocalCapture`, `SecondEditDuringCapture`, `FinishLocalCapture`, `CompleteLiveApply`, `Recover`, `Apply` | `admitApplyRecovery`, `applyRecoveryValidationReason`, `validateApplyJournalPolicy`, `initialize`, `applyTargetMain`, `writeTargetFilesFromJournal`, `localChangedPathsFromTree`, `queuePreservedLocalChanges`, `recoverDivergedApplyWithPreservedLocalChanges`, `completeInterruptedApply` | `tests/onboarding-recovery.test.ts` and `tests/phase1.test.ts`: live edit survival during apply, repeated edits during snapshot capture, queued local proposal, server-side conflict outcome, damaged recovery/displacement and interrupted-apply resume; mobile process restart at recovery/files/committed boundaries |
| `Chunk`, `AdvanceMain`, `Ack`, `CatchUp`, `LoseCatchUp`, `CaptureInterim` | `pull`, `retryPendingAppliedAcknowledgement`, `settlePreviouslyAppliedPullCheckpoint`, retained catch-up marker, intermediate-ancestry admission | `tests/retained-catchup.test.ts`: retired-checkpoint catch-up with empty events and blocked intermediate-ancestry upload after restart; mobile immutable-checkpoint and pending-ack tests with advanced main, cold checkpoint/ack/activation restart |
| `CaptureCatchupEdit`, `HandoffCatchupEdit`, `DropCatchupHandoff`, `SkipCatchupCapture`, `Crash`, `Restart` | Versioned retained-catch-up record validation, exact intermediate-tree identity check, durable edit snapshot/provenance publication, final-canonical stale-proposal handoff | `tests/retained-catchup.test.ts`: edit preservation, durable handoff, restart boundaries, original-base retention and no intermediate upload |

These mappings identify executable seams, not runtime TLA trace replay. Persistent mobile-shaped adapters exercise DataAdapter metadata barriers and actual subprocess termination; they do not establish physical iPhone suspension or power-loss durability.

## OBTS-FM-007: Diagnostic Admission (revision 23)

`OBTSDiagnosticAdmission.tla` refines `OBTS-SEC-DIAG-001`. Six report IDs share finite automatic/manual partitions within one owner/instance. Acceptance is serialized; duplicate/quota rejection, one acceptance-window expiry, independent stored-row expiry and connection enrollment are separate actions. Reusing an expired row ID produces a distinct admission token. Connection-origin claims cannot change lane at enrollment. This abstraction represents one acceptance window; executable tests cover real hourly/daily clocks and startup reconstruction.

`scripts/check-diagnostic-admission-model.mjs` runs SANY and seven checks: safety, manual-after-automatic-saturation and expiry witnesses, plus broken shared-budget, duplicate-charge, rejected-charge and connection-promotion controls. Final positive exploration: 834,689 generated / 123,712 distinct states, depth 20. Exact invariant/action witnesses and bounded exploration are required. The model starts with empty partitions and does not establish availability with saturated legacy storage, queue latency, deletion before process restart, or physical persistence.

## OBTS-FM-008: Client State Recovery (revision 41)

`OBTSClientStateRecovery.tla` refines `OBTS-PER-CLIENT-001` and `OBTS-SYNC-IMM-001`. Durable server observation, stale local state, equal server refs with different block observations, split incomparable local heads, immutable proposal identity and one crash/restart are independent facts. Local repair cannot regress the observation or rewrite the attempt; ambiguous split heads retain their existing primary evidence.

An independent lane covers a comparable split after a conflict resolution is applied: the conflicted proposal is contained in the resolution, so it must not reclaim the local Git ref, and preserved edits become a cohort on the resolution. It starts either from an open conflict or from a device already split by an earlier client, where the local ref is a strict ancestor of `local_head`. Repair fast-forwards the ref only when no attempt artifact (queue, upload or pull checkpoint, apply journal or catch-up) is present and no changed path still holds the ref's visible bytes; otherwise the split is preserved and blocked.

`scripts/check-client-state-model.mjs` runs SANY and twelve checks: safety, fair liveness, restarted recovery, queue-driven rollback, blanket-primary selection, attempt rewriting, equal-ref error restoration, incomparable-head replacement, settled-proposal ref restore, state following the rewound ref, repair over ancestor bytes, and a missing repair (a liveness counterexample). Positive safety/liveness each explore 945 generated / 387 distinct states, depth 11. Git pointer/ancestry facts and visible-byte comparison are already verified symbolic inputs; actual object existence, ancestry and file fingerprints are exercised with real Git fixtures in `tests/client-state-authority.test.ts` and `tests/plugin-stale-proposal.test.ts`. Failed publication, immutable checkpoint bytes and later visible edits are executable obligations rather than formal filesystem claims.

Both checkers run through `npm run test:formal`; `trace/fm007-fm008-map.json` maps implementation and executable tests. That map is static documentation, not runtime trace conformance or a checker-validated proof of code equivalence.

## OBTS-FM-009: Server-Managed Vault Settings (revision 35)

`OBTSVaultSettings.tla` is a focused bounded model of root-ignore dashboard save and timestamp-only metadata overlap. It refines `OBTS-SYNC-MERGE-001`, `OBTS-SYNC-IGN-001`, `OBTS-PER-OP-001`, and `OBTS-DASH-SET-001`. Byte comparison and timestamp/YAML parsing remain verified symbolic inputs. The model records preview heads/policy IDs, prepared policy/tree identity, ref CAS and recovery, local-copy preservation, explicit valid/outside-equal merge eligibility, invalid-timestamp conflict fallback, and automatic merge rules/result pinned in the durable operation across ref movement and restart recovery.

`scripts/check-vault-settings-model.mjs` runs SANY and six TLC checks as part of `npm run test:formal`: safety explores 3,815 generated / 1,001 distinct states at depth 11; eligible merge recovery liveness explores 28 / 19 / depth 6; invalid-timestamp fallback liveness explores 8 / 5 / depth 3. The stale-save and local-delete mutants still reach their intended invariant violations. `negative/VaultSettingsRecomputeMerge.cfg` changes rules after prepare and proves that recomputing the durable merge result violates `MergeManifestPinned`. These checks do not model concrete YAML parser or byte behavior.

## OBTS-FM-011: Bridge Read Availability During Sync (revision 40)

`OBTSBridgeReadAvailability.tla` is the bounded companion for `OBTS-BRG-READ-001` (numbered FM-011 at architecture revision 40 after FM-010 went to the upload-recovery model). It separates the long-held headless sync mutex from brief SQL projection publication and body attestation. Symbolic source/row revisions stand for exact selected source revision/OID agreement. It checks pending freshness during held sync, own projected-write visibility before global sync completion, per-operation mismatch rejection with unrelated-read admission still reachable (the unrelated path's hydration is abstracted and requires executable evidence), and no admission during partial/failed publication. Negative controls bypass publication, body attestation, and authorization.

`scripts/check-bridge-read-availability.mjs` runs SANY and fourteen TLC checks: six positive configurations (two also check conditional liveness), four reachability witnesses, and four negative controls. Sync may remain held forever; fair selection and hydration still complete a healthy read. The sync-lock control must violate liveness, while publication, attestation and authorization bypasses violate their respective safety invariants. Source drift after a completed response remains legal. The largest positive configuration has eleven distinct states; these small bounds describe one read/publication cycle, not arbitrary concurrent histories. This model does not claim MVCC generations, SQL lock implementation, actual hash validation, response metadata wiring, or implementation conformance. Export retains stricter current-projection admission and embedding retains its separately modeled headless-before-body order.

## OBTS-FM-014: Atomic Rename Proposals (revision 46)

`OBTSAtomicRename.tla` refines `OBTS-SYNC-RENAME-001` and `OBTS-PER-RENAME-001`. Three finite paths A/B/C have explicit base, local, proposal, frozen-attempt and canonical trees. A local A->B move carries edited content; one crash/restart, an immutable retry, a successor B->C rename with a newer edit, and a server occupation of B exercise the key seams. The server admits a pair only when the selected base contains A and not B and the frozen target contains B and not A. Clean integration installs both endpoints; destination occupancy creates a protected conflict without changing canonical state. Invariants bind pair/base/tree/target through retries and restart, prohibit early retirement, and require complete paired installation. Content preservation assumes the immutable base, frozen tree, and protected proposal content remain available: the model does not explore Git root release or pruning, so its preservation predicate does not independently prove those roots' lifetimes. Concrete retention and cleanup require separate executable evidence. The model also abstracts Git ancestry and path validation, content-merge eligibility and algorithms, filesystem durability, capability rollout, and implementation conformance.

`npm run test:formal:atomic-rename` runs SANY and the complete nine-check family. TLC 2.19 checks one positive safety matrix, four action-and-depth-checked capture/restart/successor/conflict witnesses, and four required mutants: split capture, split integration, early retirement, and retry rebinding. The positive matrix explores 286 generated / 108 distinct states at depth 12. Witnesses reach capture-to-merge (22 distinct/depth 6), restart-to-merge (35/7), successor-rename-to-merge (37/7), and occupied-destination conflict (39/7). Each mutant reaches its designated invariant failure. The finite bound includes one pair, one retry, one successor rename, and one canonical destination occupant; it is a focused design check, not a complete sync state-space expansion.

| Boundary | Implementation | Executable evidence |
| --- | --- | --- |
| Watcher relation and capture | `recordLocalRenameHint`, `queueStaleCohort`, and `createStaleCohortCommit` in the shared plugin core | `tests/plugin-stale-proposal.test.ts`: registered watcher retry, pinned capture, chain collapse, source recreation and safe blocking |
| Immutable multipart/chunk request | `uploadQueuedCommit`, upload checkpoints, and terminal handoff in the shared plugin core | Paired queue mismatch, both transports, stranded capture and terminal restart cases in `tests/plugin-stale-proposal.test.ts`; existing checkpoint matrix in `tests/plugin-upload-recovery.test.ts` |
| Admission and merge | `src/shared/validators.ts`, `src/server/syncService.ts`, `src/server/gitService.ts`, and `src/server/chunkTransferService.ts` | `tests/server-stale-proposal.test.ts`: explicit-pair admission, low-similarity/semantic/binary moves, retries, collisions and paired resolution |
| Crash/restart and conflict handoff | Client protected provenance and server admitted pair recovery | Client successor/restart cases and server interrupted-admission/corrupt-evidence cases in the stale-proposal suites |

This table maps intended boundaries to source and executable regressions; it does not establish automatic trace conformance between the implementation and TLC.
