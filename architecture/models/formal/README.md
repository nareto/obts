# Formal Models

Formal models are bounded refinements of stable contracts in `architecture/contracts/`. They do not define product behavior independently. Protocol-changing code or architecture changes must update an affected model and its declared revision or explicitly retire it. Mechanical revision agreement does not prove semantic conformance.

## OBTS-FM-001: Local Apply And Recovery

| Field | Value |
| --- | --- |
| Status | Accepted bounded pilot |
| Architecture revision | 2 |
| Refined contracts | `OBTS-SAF-001`, `OBTS-SAF-002`, `OBTS-SAF-005` |
| Specification | `OBTSApplyRecovery.tla` |
| TLC configuration | `OBTSApplyRecovery.cfg`, `OBTSApplyRecoveryLiveness.cfg` |
| Executable check | `npm run test:formal` |

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
| `BeginWriting`, `WriteTarget`, `BlockChangedPath` | `writeTargetFilesFromJournal` atomically displaces each affected path into journal-addressed `.obts/apply-displaced` preservation, verifies displaced identity/content, and creates the target through Obsidian `Vault.createBinary` (documented to fail if the path exists) or Node `writeFile(..., {flag:"wx"})`; cleanup archives displaced inodes under `.obts/recovery-displaced` rather than deleting them. Stale-file, ancestor, directory, primitive-boundary, and restart races live in `tests/plugin-large-vault.test.ts`. |
| Post-write bundle actions | `localChangedPathsFromTree` plus `createRecoveryBundle` preserve edits detected after materialization before refs advance. |
| Ref, coordination, acknowledgement, cleanup actions | `updateRef`, `writeState`, `writePendingAppliedAcknowledgement`, and `clearApplyState` are separate durable calls. |
| `Crash`, `Restart`, recovery classifiers | `initialize`, `recoverIncompleteApplyJournal`, and `recoverBlockedApplyWithPreservedLocalChanges` classify persisted journal, visible tree, target commit, refs, and preservation evidence. |

### Known omissions

The model does not cover directories, multiple paths, write concurrency, editor-buffer capture, Git object structure, network/server acknowledgement, byte/checksum implementation, mobile lifecycle, process kill, power loss, filesystem semantics, corrupted finalized bundles, or competing client instances. Those require executable fault tests and platform evidence; a green TLC result makes no claim about them.

## OBTS-FM-002: Composed Distributed Synchronization

| Field | Value |
| --- | --- |
| Status | Accepted bounded composed model |
| Architecture revision | 4 |
| Refined contracts | `OBTS-SAF-001` through `OBTS-SAF-006`, `OBTS-SYNC-IMM-001`, `OBTS-SYNC-ACK-001`, `OBTS-PER-OP-001`, `OBTS-BRG-PROJ-001` |
| Root specification | `OBTSDistributedSync.tla` |
| Check matrix | `checks.json` (exactly 52 required checks) |
| Static transition map / future trace schema | `trace/transition-map.json`, `trace/trace-schema.json` |
| Executable check | `npm run test:formal` |

`OBTSDistributedSync.tla` is the sole composed `Init`, `CoreNext`/`Next`, safety, and liveness authority. Every positive scenario uses the same composed transition relation; scenario constants and guards bound edits, messages, faults, and their meaningful causal seams without state constraints or scenario-specific action whitelists. The composition always contains Plugin1, Plugin2, Bridge Node, Rust Bridge write/projection, server proposal/classification/CAS/conflict/recovery, client apply/ack, directory, and bounded request/reply bag actions. Focused reachability configurations prove claimed triggers rather than relying on one explosive scenario to establish all coverage.

### Durable state and abstraction boundary

- Canonical content is a per-path finite tree. Clean disjoint proposals union their path versions, while same-path divergence enters conflict metadata and three separately durable protection refs.
- Observation and watcher hints are not capture. `ghost.captured` advances only after local Git and coordination publication; restart classifies durable journal, roots, queue/ref, and visible facts as resume, roll-forward, or block.
- Immutable attempts include target, expected device ref, base, directory proposal, object plan, attempt ID, and transfer ID. Bounded message bags permit delay, duplication, request/reply loss, stable retry/query, server idempotence, and reply loss after durable outcome.
- Device/main CAS preparation, side effect, observed old/target/foreign/uncertain reading, and metadata commit are independent. Recovery classifies the durable ref reading rather than trusting an operation phase.
- Directory proposal/intent identity, generation, acknowledged main/event baseline, prepared/committed result, event identity, and target local deletion are journaled. Physical deletion requires a committed canonical tombstone plus identity and emptiness revalidation.
- Projection separately verifies manifest, base, and path OIDs, writes complete derived rows, then publishes the cursor/readiness. Failure retains the prior cursor; PostgreSQL never preserves or repairs client state. Audit retention is not modeled or claimed.

Local apply state projects non-vacuously through `modules/OBTSApplyRefinement.tla`; `fm002-apply-refinement` is a positive projection check and `fm002-reach-apply-refinement` proves durable coordination is reachable. This remains a state projection, not a claimed full temporal refinement. Accepted `OBTS-FM-001` continues to run independently with its safety, liveness, and four original controls.

### Check matrix and assumptions

The required matrix contains six FM-001 checks; seven FM-002 positive safety checks; four separately fair liveness checks; twenty trigger/action reachability checks; and fifteen distributed negative controls. Removing or retyping any required check fails validation. Accepted architecture status requires zero candidate counterexamples and all required positives.

Liveness is conditional on bounded edits/crashes, eventual restart, retry/delivery, and no permanent storage failure. Fairness is attached to the concrete action/actor sequence for proposal/result consumption, Rust write to Node capture, server restart/recovery, and main event to durable apply/server acknowledgement. Each obligation has a separate reachable-trigger check; there is no broad fairness disjunction.

The safety bounds include two same-path plugin edits; two disjoint Plugin1/Bridge paths; meaningful client/server/Rust crash seams; and at most two symbolic message copies. The all-actors bound retains every claimed interaction but causally orders the three proposals and bounds each crash/network fault to one relevant seam. Equal, covered, and divergent classifications are independently reachable; divergence never moves the device ref.

### Implementation recovery check

`configs/server-recovery-implementation.cfg` constructs a real divergent second proposal, commits conflict metadata and all three protection refs, prepares a `conflict_resolve` operation, moves `main`, crashes, and recovers from the target ref reading. Startup recovery now commits the complete prepared effect set: resolving-user attribution, audit, both resolution events, device last-success time, and directory result. `ExactPreparedOperationRecovery` passes across 11,389 generated and 3,772 distinct states at depth 56.

The production regression in `tests/phase2.test.ts` performs a genuine conflict resolution, retains the moved Git `main`, rewinds metadata to the prepared state, restarts the server, and verifies the same effects. New conflict-resolution operations persist the resolving user in their prepared manifest; incomplete legacy manifests fail closed rather than fabricating attribution.

### Negative controls and harness

The fifteen distributed controls mutate one behavior after realistic setup: in-flight target replacement, accepted-root loss, covered-ref rewind, divergent-proposal discard, main move without preparation, early apply acknowledgement, uncaptured Bridge overwrite, recursive tombstone deletion, moved-ref abort, duplicate non-idempotent processing, retry identity mutation, conflict metadata without complete protection, uncertain-CAS abort, seen/applied cursor conflation, and projection cursor publication before complete verification.

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

All twenty reachability checks produced their required witness. All four FM-001 and fifteen FM-002 negative controls violated exactly their intended invariant with the required meaningful prefix. See the executable summary from `npm run test:formal` for every generated/distinct/depth tuple.

### Traceability and omissions

`trace/transition-map.json` maps every root action and the required production families to existing, range-validated code/test evidence. It cites `obsidian-plugin/src/main.cjs` only within its current 9,652 lines. The schema/map are static design artifacts only: runtime transition instrumentation and replay do not exist, so no runtime trace conformance or implementation proof is claimed.

FM-002 remains bounded and does not prove byte/checksum correctness, Git ancestry implementation, semantic merge formats, filesystem/power-loss durability, editor-buffer flushing, authorization, onboarding, restore, event-pruning recovery, transfer expiry, rename graphs, garbage collection, backup/restore, or real process supervision. Transfer expiry and event-cursor expiry appear in the static production-family map but are not modeled transitions. Audit retention is omitted. The contract-required integrated server/Rust/Node/PostgreSQL deployment fault test remains outstanding.
