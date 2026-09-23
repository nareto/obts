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
| `BeginWriting`, `WriteTarget`, `BlockChangedPath` | `writeTargetFilesFromJournal` captures each affected path into journal-addressed `.obts/apply-displaced` preservation as a verified copy (never by renaming a vault-visible path), removes the live path only after the copy validates against the preflight identity, and creates the target through Obsidian `Vault.createBinary` (documented to fail if the path exists) or Node `writeFile(..., {flag:"wx"})`; cleanup archives displaced evidence under `.obts/recovery-displaced` rather than deleting it. Stale-file, ancestor, directory, primitive-boundary, and restart races live in `tests/plugin-large-vault.test.ts`. |
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
| Architecture revision | 13 |
| Refined contracts | `OBTS-SYNC-ONB-001`, `OBTS-SAF-002`, `OBTS-SAF-005`, `OBTS-SAF-009` |
| Specification | `OBTSOnboarding.tla` |
| Check matrix | `checks-fm006.json` (11 required checks) |
| Executable check | `npm run test:formal:onboarding`; included in the repository formal entry point |

The model separates the pending browser deadline from the approved enrollment lease, pins one immutable server baseline while canonical state may advance, consumes authorization at device registration, transfers with a durable chunk cursor and target-bound complete final checkpoint, publishes recovery before replacing non-empty local state, and records local apply, durable acknowledgement (which permits checkpoint cleanup), catch-up transfer/checkpoint/apply/acknowledgement, and activation as separate boundaries. It preserves those durable boundaries across one crash/restart. Protocol fields denote already published durable records; `running`, `crashCount`, and `lastAction` are the execution layer. Crash therefore discards execution while retaining published state, and the negative controls model incorrect publication ordering. Host flush behavior remains an implementation obligation.

Four positive checks cover empty and non-empty safety/liveness. One reachability check proves transfer restart after durable chunk progress. Six negative controls deliberately reuse the pending deadline after approval, retarget the approved snapshot, transfer before credential publication, apply before recovery, enter the post-transfer phase without a complete checkpoint, or activate before durable acknowledgement. Each must violate its named invariant with the declared action witness.

Actual TLC 2.19 used one worker and fingerprint polynomial 0. Empty safety explored 943 generated / 631 distinct states at depth 17; empty liveness 150/102/14; non-empty safety 1061/689/18; and non-empty liveness 155/106/15. The restart witness reached 45/39/7. All six controls reached their intended violations between depth 3 and 8. SANY passed before the matrix.

The model does not prove cryptography, Git object or manifest correctness, filesystem durability, wall-clock scheduling, iOS background execution, Rust/Node process supervision, HTTP proxy behavior, or implementation conformance. Executable fault tests and real-device/deployed-Bridge evidence remain mandatory.
