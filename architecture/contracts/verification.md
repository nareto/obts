# Verification And Assurance Contract

## Evidence Chain

OBTS assurance follows one traceable chain rather than parallel specification systems:

```text
architecture contract ID
  -> state/interaction model and ADR
  -> implementation boundary
  -> executable unit/property/fault/integration test
  -> copied-vault and operational evidence
```

Code does not redefine a contract because tests pass. A failed test is classified as implementation defect, executable-test defect, stale architecture, or proposed contract change before expectations are edited.

## Required Automated Evidence

- Shared path-policy, validation, authorization, redaction, and status rules.
- Local commit/import, queue, immutable transfer, apply/recovery, and directory-causality transitions.
- Server ref/metadata operation interruption at every durable boundary.
- Equal, descendant, covered, divergent, stale, duplicate, and retry outcomes.
- Merge validators for Markdown, Canvas, Bases, binary, rename, delete/edit, and hierarchy collisions.
- Conflict package, stale review, resolution, history, restore, integrity, and maintenance behavior.
- Bridge ACL, revision checking, filesystem projection, restart containment, and derived-state replay.
- Bridge bounded-body/query evidence: no startup/request/worker corpus-body mirror; 64 MiB default input-file limit and finite leases through response copies; exact normal encoded-byte/row accounting for metadata/lexical/tag/link/block writes; owned oversized singletons without file rejection or raised normal budgets; complete markers/cursors only after every required row and cleanup. Preserve private-note projection, runtime policy authority, normal caller denial, source attestation, audit history and fail-closed cursor retention through cancellation/restart/replay.
- OpenAPI and packaged-plugin conformance.

Property/state-machine tests should explore generated command sequences against the safety contract. Deterministic fault points should cover filesystem, Git, metadata, network, clock, process lifecycle, and response loss. Failures retain a seed or exact transition trace.

Mutation testing may be used selectively for the safety kernel. Critical mutants that skip recovery publication, advance phases early, omit preservation paths, move refs backward, acknowledge before durability, or misclassify divergence must not survive.

## Crash And Durability Evidence

In-process exception tests are not sufficient evidence for restart semantics. Safety-critical transitions require subprocess termination and restart on the same persistent state, followed by exact-byte, ref-reachability, journal, checksum, and integrity inspection.

### N-1 Persisted-State Upgrade Gate

Every server release or change that tightens durable filename, schema, accounting, ownership, recovery, or validation rules must carry a separately identifiable N-1 persisted-state compatibility result. The result must identify the exact previously deployed server producer revision from deployment history, not only a release tag, and use either that historical writer or a reproducible pinned generator.

The generated state must include every relevant legacy artifact and a healthy second vault/device for failure-scope isolation. The current built server—not only an isolated service class—must start over that state and prove listening, canonical metadata preservation, durable cleanup of supported residue, ownership adoption where allowed, durable accounting repair, bounded/read-only readiness, an unrelated chunked upload, and an existing pull. Unknown or unattributed residue remains fail-closed where the contract requires it, and only genuine transfer-root, durable-write, or Git-durability failures may suspend transfer service globally.

The fixture producer, generation command, included durable artifacts, and checksum/freshness mechanism belong in the release assurance record. The gate is exposed through a dedicated command such as `npm run test:upgrade-compat` and its CI/release result remains distinct from aggregate unit, formal, OpenAPI, and synthetic browser counts.

Supported platforms require representative filesystem and application-lifecycle exercises. Mobile force-close coverage is mandatory; sudden-power-loss claims require separate storage evidence and cannot be inferred from process kill alone.

## Formal Methods

TLA+/PlusCal is an optional bounded technique inside the architecture model set. Adopt a model only when it:

- refines stable named safety contracts;
- states durability, fairness, and fault assumptions;
- remains small enough for independent review;
- records TLC configuration and explored-state evidence;
- turns useful counterexamples into executable regression tests;
- is updated or explicitly retired when its refined protocol changes.

A green model checker does not prove implementation conformance, filesystem durability, byte/path correctness, performance, or operational recovery.

The accepted bounded `OBTS-FM-001` model refines `OBTS-SAF-001`, `OBTS-SAF-002`, and `OBTS-SAF-005` for one-client, one-path apply/recovery. `npm run test:formal` checks its safety, liveness, and negative controls. Its exact bounds, assumptions, evidence, promoted regression, and omissions live in `architecture/models/formal/README.md` and ADR 0007.

The accepted `OBTS-FM-002` composed distributed model adds multiple bounded safety scenarios, conditional per-obligation liveness, deliberate negative controls, and a machine-readable action-to-contract/code/test map. Its implementation-recovery check verifies that startup reconstructs the same prepared conflict-resolution effects as online completion. The trace schema and conformance boundary do not claim runtime instrumentation or implementation proof until executable trace replay is delivered.

The accepted `OBTS-FM-003` refines `OBTS-BRG-PROJ-001`, `OBTS-BRG-BODY-001` and ownership aspects of `OBTS-BRG-QUERY-001`. Its independent required row IDs/kinds/sizes include per-file tag/link/block fanout, two oversized metadata rows, normal byte pressure and a corpus exceeding body slots and the retired aggregate cap. It separates acquisition/verification/enqueue/commit/cleanup, retains a shared singleton permit and file lease, and covers cancellation/draining, partial commit/restart/replay, final completion, denial, drift and audit retention. The matrix requires positive safety/liveness plus explicit reachability and old-overflow/oversized-starvation/mixed-row/omitted-row/early-permit negative controls. It proves neither a parser expansion factor/RSS bound nor SQL compiler, lexical matching, response format/order or production conformance.

The FM003 worker companion separately refines `OBTS-BRG-EMBED-001` with one-slot headless/body ordering, bounded thin queue/input/provider ownership, source versus SQL generations, inflight note revision and independent block hash/epoch changes, guarded success/failure/reindex, cancellation/late reply and stable-generation retry. Its 48 required checks include actual empty-inner starvation, stale-ID/hash/epoch/failure controls, independent same-source embedding schema/model reset, and both inverse-acquisition and completion-reacquisition deadlocks. Schema-specific checks cover note/block success AND failure, guarded reindex, reset while completion SQL is pending and retry of the current schema generation. Trace action mappings require nonzero TLC-generated successors in the mapped configurations; model/configuration digests bind stored coverage evidence, and live checks validate fresh coverage. Reduced TLC counterexamples are static model evidence, not production trace replay. The default formal command runs the unchanged 52-check baseline, unchanged 39-check projection matrix and this independent companion.

`OBTS-VER-DEL-001` requires the focused `OBTS-FM-004` lifecycle lane before production deletion implementation is accepted. It refines `OBTS-SAF-008`, `OBTS-SEC-DEL-001`, `OBTS-PER-DEL-001`, and `OBTS-DASH-DEL-001` for two vaults/owners, one target lifecycle, bounded admitted and detached work, finite erase/final-publication faults, one crash/restart, owner/CSRF/typed-confirmation scope, blocked-integrity admission, partial erasure, receipt expiry and preservation boundaries. Positive safety/liveness must pass with fair retry and restart assumptions. Negative controls must produce bounded witnesses for erase-before-intent, admission after closure, premature completion, wrong owner/target, unfinished-intent expiry, and early lease release followed by late callback reuse. SANY runs before TLC; unexpected deadlock, parse/semantic error, timeout, resource overflow, wrong invariant, missing/shallow witness, and state-space collapse fail the checker. The model's three logical clock ticks abstract the contractual 30-day post-completion retention window; it does not model wall-clock persistence or physical secure erasure.

The FM004 model has no production source map or conformance claim: the server coordinator, API, UI, and executable fault tests remain planned implementation evidence. Useful model counterexamples are the required promotion targets for those tests.

Before worker acceptance, execute actual-PostgreSQL regressions with a paused fake provider for stale note/block success AND failure, matched-row count zero, newer vector/readiness/retry preservation, transactional parent-note replacement, hash-only and epoch-only replacement, version-bound reindex/backfill, private-note hydration, source attestation, cancellation/late result and drain. Exercise the real shared headless guard at body-slot count one (a `headless=None` SQL fixture cannot prove this ordering), both LocalAI/simulated loops, bounded candidate/chunk/provider highwaters, near-64-MiB input and final post-worker stack/RSS runs. A READ COMMITTED parent-note join alone is not evidence of atomic generation checking. Add same-dimension model/schema reset races with unchanged source revision: pause note/block success AND failure SQL before its mutation, reset the embedding generation, and verify matched zero with replacement vectors/readiness/retries preserved, including an old backend statement surviving its originating process. Schema epoch validation and mutation must serialize with invalidation, not rely on a separate preflight or snapshot read.

## Manual And Deployment Evidence

Before trusted primary-vault use:

- run the candidate deployment canary over an isolated synthetic N-1 state; prove live, bounded readiness with useful failure detail, an existing pull, and an unrelated chunked upload before authoritative service state changes; clean up the canary state on success or failure;
- run disposable-vault server/plugin smoke tests from empty state;
- validate desktop and foreground iOS/Android onboarding, offline edits, reconnect, concurrent edits, deletes, renames, conflict review, restore, and interrupted apply;
- run large-vault and long-running-operation checks within memory/resource budgets;
- restore intentionally inconsistent server backup state in isolation and confirm fail-closed readiness;
- perform a point-in-time-consistent backup/restore drill and verify every protected ref and history surface;
- complete an agreed multi-device soak with recorded rollback criteria.

OBTS Bridge requires an end-to-end deployment test that launches the server, Rust Bridge, supervised Node headless client, and PostgreSQL; pairs through the normal browser flow; proves scoped read/write and conflict behavior; kills/restarts runtimes with pending work; rebuilds the derived projection without replacing client state; and restores the authoritative client volume. Component tests alone do not satisfy this obligation.

The stage-2 harness must use synthetic corpus text above the retired aggregate cap, many small files, a file near 64 MiB input, oversized metadata/lexical rows and many tags/links/blocks. Assert exact normal encoded-parameter bytes and row counts, singleton isolation/retained ownership and permit cleanup on success/cancellation/failure, and partial-commit/restart/revert completion without omitted rows. Record measured RSS/heap/allocator high-water and separately cost parser trees, encoding/normalization, derived singletons, driver/response copies and output metadata; do not infer a hard RSS or encoded-singleton ceiling from symbolic TLC sizes or the input budget. Verify no corpus-body mirror, paged startup, policy-before-hydration, private-note projection, denial isolation, source/drift/DB failures with old-cursor/audit preservation, MCP lease lifetime, lexical substring/title-weight equivalence (including quartz/uniquequartz), graph/link/backlink completeness above 500 results, paged/ranked context selection and unchanged REST/MCP format/order. Exact responses must use attested FS/Git, never the derived lexical index. The lexical migration must purge raw legacy columns, preserve audit history and document normalized plaintext in DB/backups. Embedding workers and end-to-end deployment acceptance remain required.

Dashboard UI changes with consequential visual meaning use disposable local Docker deployments and Playwright. Representative real states are rendered at relevant viewport sizes, screenshots are captured and inspected, and all containers, networks, volumes, and temporary data are torn down afterward.

## Independent Review And Release Record

Safety/protocol changes receive a fresh-context review from someone or an agent that did not author the transition. Review covers the contract, assumptions, state model, persistence boundaries, fault inventory, executable evidence, and residual risks.

A release assurance record identifies the source revision, architecture revision, changed contract IDs, validation commands/results, formal-model revision/results when applicable, copied-vault/manual evidence, reviewer findings/dispositions, and known gaps. This is evidence, not a certification claim. For this redesign, stage 1 records architecture/FM003 evidence only; stage 2 must replace the forthcoming implementation/test entries in the FM003 trace map before claiming conformance.
