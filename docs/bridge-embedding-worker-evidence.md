# Bounded embedding worker: local implementation evidence

This unlanded change implements `OBTS-BRG-EMBED-001` against the reviewed FM003 worker companion. Architecture revision **6** and crate **0.1.3** are unchanged. Independent implementation review and both final synthetic stack profiles passed. Live activation/client acceptance and soak remain separate; these results do not certify the deployed service.

## Implementation

- `main.rs` constructs the shared `VaultBridgeService` before spawning either production embedding mode. Thin SQL pages contain note revision/embedding epoch and block hash/source revision/derived epoch/embedding epoch. Candidate selection also requires the configured provider model/dimension in the same SQL snapshot, so an old process cannot capture a new model's epochs. SQL errors propagate; legacy store-only workers and ID-only embedding helpers are test-only. Unused raw-body reindex loaders were removed.
- `service.rs::capture_embedding_source` shares the existing write/headless/projection guard order, then acquires the global body slot and verifies filesystem revision/OID. No caller ACL is involved. One captured file is retained across its note embedding and bounded block pages; provider completion never reacquires headless. Cancellation flags an owned drain task, retains its input through the pending provider/SQL work, discards late provider results, and prevents another capture until the body slot is released.
- Note chunk selection performs two incremental boundary scans, selects the existing evenly spaced sample of at most 256 chunks, retains at most 128 request inputs (and the configured smaller batch), and incrementally aggregates byte-weighted vectors. Existing data-URI/opaque-token normalization and frontmatter exclusion remain. Heading/paragraph/semantic extraction emits blocks incrementally and is shared with the verified projection/rebuild path; a block page contains at most 128 thin tokens, and block requests contain one input. No independent all-body reindex pipeline was added.
- Migration `0021_embedding_generations.sql` supplies non-reusable epochs and revision/hash/breadcrumb/source invalidation triggers. Success AND failure first lock/validate the captured global schema epoch (`FOR SHARE`), then lock the parent note, compare current note revision/embedding epoch, and mutate the matching note/block generation on that same transaction connection. Reset locks the schema row (`FOR UPDATE`) before its target-row updates and atomically advances the global epoch; rows inserted after either reset scan are therefore fenced too. This is a held transactional guard, not a snapshot/preflight check. Block mutation additionally checks its embedding epoch, source revision, derived epoch and hash. Schema reset advances epochs even for already-empty rows. Completion reports actual matched rows and uses actual encoded parameter accounting with shared singleton ownership. Schema reset remains a coordinated SQL transaction; its database scan/row-lock cost is not a process-memory guarantee.

## Regression evidence

New executable coverage lives in `store/sql/tests/embedding.rs`, two initial regressions in `store/sql/tests.rs`, `markdown/stream.rs`, and `workers.rs`:

- Actual PostgreSQL and controllable HTTP provider: private note/block completion; no frontmatter sent; empty note queue completion; stale success AND failure for parent revision, hash-only, derived-only and schema-only changes; replacement vectors/retries preserved; SQL outage has no empty-map fallback. A global block-provider outage is distinguished by the legacy health probe, does not increment/quarantine per-block retries, and retries successfully once the provider recovers.
- Actual blocked PostgreSQL statements: note/block success AND failure after same-dimension model reset of already-NULL rows; parent replacement/hash/derived/combined runtime guard changes; matched zero; replacement-generation retry; Pool `max_connections=1` for the worker. A child Rust test process is SIGKILLed while its actual PostgreSQL schema/parent-guard statement remains blocked. Four note/block success/failure schedules verify that the backend outlives its owner, drains after reset, and never issues a stale mutation. This tests the concrete schema-guard/parent-guard/mutation transaction, not a claim that a joined UPDATE snapshot is serializable.
- Real Rust `HeadlessClient` and its shared filesystem mutex, backed by a synthetic Node ready-event process: note/block × success/failure × normal/cancel schedules, one body slot, API holding headless while waiting for body. Worker acquisition waits for headless without taking body; completion is SQL-only; cancellation retains ownership until the fake provider replies, ignores the reply, and allows the API to finish. The synthetic process is a lock harness, not another full Node sync/restore test.
- Bounded pages/rebuild: 134 notes across 128+6 candidates; 270 blocks consumed from one captured file; replacement cleanup, missing-block backfill through verified projection, deletion and source-attestation rejection. Streaming block output matches the legacy splitter across Unicode, headings, fenced headings, CRLF, merge thresholds and overlap settings; incremental note boundaries match legacy whitespace/Unicode/hard-split behavior.

### Measured synthetic near-limit case

`postgres_worker_near_64mib_bounded_selection_no_corpus_admission` uses one **63 MiB** opaque-text file and actual PostgreSQL plus HTTP provider. Measured highwaters/results:

| Counter | Value |
| --- | ---: |
| Input bytes | 66,060,288 |
| Concurrent captured inputs | 1 |
| Selected note chunks | 256 |
| Raw selected chunk bytes | 4,096 |
| Provider batch inputs | 8 |
| Provider requests | 32 |
| Largest normalized provider input | 20 bytes |
| Normal projection rows | 128 |
| Normal encoded parameter bytes | 24,594 |
| Largest encoded singleton | 66,560,317 bytes |
| Resident note/file/link body maps after work | 0 entries |

The opaque-token normalizer intentionally reduces this fixture's HTTP input; it is not a measurement of a 63 MiB HTTP request. Block projection uses a 256 KiB implementation chunk setting for this fixture, while normal SQL budgets remain 128 rows / 8 MiB. The supported input was not rejected at 8 MiB and no aggregate admission cap was introduced.

Allocation accounting remains distinct from these counters: UTF-8 capture, frontmatter-stripped body and breadcrumb-prefixed note text can each retain a per-file copy; the Markdown tree, heading/range metadata and a current heading section/paragraph can also be input-proportional. Only sampled/provider chunks and weighted accumulation are bounded incremental intermediates. YAML/parser expansion, JSON normalization/encoding, driver copies and RSS were **not** separately instrumented here. `/usr/bin/time` was unavailable and was neither installed nor substituted; the parent explicitly retained RSS measurement in its existing stack harness. No hard singleton-byte, parser-expansion or RSS ceiling is claimed.

## Commands and outcomes

All Rust commands used `CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target` to avoid NFS artifact faults.

```sh
CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target cargo check -p obts_bridge
CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target cargo test -p obts_bridge
CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target \
  OBTS_SYNTHETIC_POSTGRES_URL=postgresql://obts_bridge_test@127.0.0.1:32785/obts_bridge_test \
  cargo test -p obts_bridge postgres_ -- --ignored --nocapture
```

Final results: check passed without warnings; **160 unit tests passed**, 27 opt-in PG tests ignored by the default command; explicit PostgreSQL run **27 passed** (**13 preserved core + 14 worker/correction tests**), 109.79 seconds. An earlier combined check/unit/PG shell exceeded its 210-second tool timeout during the last core PG test; it was not treated as success. The isolated final PG command was rerun with a 300-second tool timeout and passed completely. Initial two regression-first PG tests failed because the required epoch columns did not exist, then passed after implementation. A red-first provider-outage regression subsequently caught retry classification during self-review; it passed after restoring the legacy block health-probe classification, followed by the final full check/unit/PG rerun above. All databases left by those deliberately red tests and the interrupted command were uniquely identified and dropped with `FORCE`; the parent-owned PostgreSQL container was left intact.

The unchanged 48 worker TLC checks, 39 projection checks and 52 baseline checks remain the preimplementation gate, not proof of these Rust/SQL changes. No model or harness was changed or TLC matrix rerun in this lane. `node scripts/check-bridge-bounded-model.mjs --worker-companion --validate-only` passed all 48 manifest/trace checks, and `npx vitest run tests/formal-embedding-worker.test.ts` passed 20 focused tests after the local trace update. At that implementation-stage checkpoint the worker trace still used its preimplementation `forthcoming-stage2` restriction. After independent review and both final stack runs, the parent promoted it to `checked-worker`; the checker now requires an acceptance receipt and passing disabled/local reports identifying the same binary. This is executable evidence validation, not instrumented TLA runtime refinement.

## Acceptance boundary

Independent implementation review and synthetic worker-inclusive Rust/Node/PostgreSQL acceptance passed; the final receipts below supersede the earlier worker-disabled-only checkpoint. Combined schema/source/hash runtime guard tests do not extend the companion's one-replacement formal bound. No live data, credentials, deployment configuration, releases, remotes, staging or commits were changed.


## Independent-review corrections (6dafa023)

The review's two P1 findings violated the existing BODY/QUERY/EMBED contract and atomic `CompleteSQL`/`SchemaReset` abstraction; no model semantics, C4 boundary or HTTP operation changed. Both were reproduced with red-first actual-PostgreSQL tests before production fixes:

- **P1A:** `postgres_review_context_provider_pool_body_order` initially failed its 3-second progress assertion: a full-content context owned the sole pool connection while waiting for the worker's sole body slot. Context now acquires its operation lease before opening its planning transaction, still under the existing service guard and before any hydration. Four schedules cover success/failure and normal/forced-singleton completion; context returns the expected full body without waiting for SQLx's acquisition timeout.
- **P1B:** `postgres_review_insert_during_schema_reset_fences_new_note_and_block` initially reported matched **1** for an old-model new-note token. It locks an existing block, pauses reset after the note update, projects a new note and block through the real verified projection, captures the old visible model token, then commits reset. Four note/block success/failure schedules now return matched **0**, preserve NULL vectors/zero retries, and successfully retry the new schema. The global schema guard also covers worker projection invalidation; reset and completion consistently acquire schema before parent/target row locks.
- **Resource-order audit:** exact note/file reads, writes, search/query-note hydration and link snippets finish pooled metadata work before their first body acquisition. Context was the one body-hydrating path retaining a planning transaction across its first acquisition. Base/graph/ranking/status transactions do not acquire body slots. Projection flushes its normal transaction before acquiring the singleton permit; completion acquires optional singleton ownership before its pool transaction. Reset and persistence-only metadata paths acquire neither body nor singleton permits. The resulting shared order is source/headless coordination → body → optional singleton → pool transaction → schema guard → parent/target rows where applicable.
- **Optional golden:** `localai_streamed_sampling_matches_input_dependent_weighted_golden` compares production streamed aggregation against the legacy small-fixture sample and raw-byte-weighted aggregate, using the existing input-length-dependent HTTP provider. It exercises more than 256 unequal chunks, a batch size of seven, and explicitly distinguishes weighted from unweighted output without allocating a near-63-MiB legacy chunk vector.

Correction validation used the same commands above: check passed without warnings, 160 units passed, and all 27 PG regressions passed (including all prior 25 and the killed-owner/schema regressions). Logs: `/tmp/obts-worker-review-red.log`, `/tmp/obts-worker-review-green.log`, `/tmp/obts-worker-review-golden.log`, `/tmp/obts-worker-review-check.log`, `/tmp/obts-worker-review-units.log`, `/tmp/obts-worker-review-pg.log`. The two red tests clean their synthetic databases before asserting; no leftover `bounded_*` databases remain. The near-limit highwaters above were reproduced unchanged. The subsequent independent re-review cleared both P1 corrections and independently reran the two new PostgreSQL regressions; final stack results are recorded below.

The unlanded migration 0021 was amended, not version-bumped; fresh isolated fixture databases passed migration and existing upgrade regressions. A database that applied the earlier unlanded 0021 has a different checksum and must be handled by the parent's disposable harness lifecycle, not silently reused or repaired by this lane. Parent-owned runtime/stack scripts, harness tests and opt-in documentation were untouched by the Rust implementation lane.

## Final independent review and stack receipts

The memory/semantic review passed; the corrective concurrency re-review (`41fe65ca`) cleared both P1s and independently reran their PostgreSQL regressions. Harness review (`84673254`) cleared proxy/environment isolation, process-group cleanup and evidence scope after all 12 focused harness tests passed.

Repository evidence reports (synthetic data only; the change remains uncommitted):

- [Disabled-worker profile](bridge-bounded-memory-evidence/stack-disabled.json): **30/30 checks**, 1,046 process samples.
- [Local-worker profile](bridge-bounded-memory-evidence/stack-local.json): **34/34 checks**, 1,523 process samples; both note/block queues finished at each profile and after recovery, including trusted private note/block embeddings.

Both reports identify the same Rust binary SHA-256 and Node **v24.14.1**. Each explicitly configures 64 vector dimensions, 4 KiB block chunks and a one-second worker poll. Normal configuration row/byte/body budgets are unchanged. The corpus sizes are **8,388,608 → 75,497,472 bytes (8 → 72 MiB)** of fixed-size synthetic notes, plus small functional fixtures.

| Profile/process | Small steady RSS | Large steady RSS | Large sampled maximum RSS |
| --- | ---: | ---: | ---: |
| Disabled / Rust | 63,582,208 | 68,120,576 | 79,990,784 |
| Disabled / supervised Node | 176,009,216 | 244,858,880 | 248,385,536 |
| Local / Rust | 77,246,464 | 75,120,640 | 81,735,680 |
| Local / supervised Node | 168,542,208 | 177,414,144 | 241,815,552 |

Values are bytes. Steady values are medians; maxima are sampled lower bounds, not allocator ceilings. Independent runs include allocator/GC/scheduling variance: lower values with more input or with embeddings enabled do not demonstrate that either reduces memory. Missing observations are null, and valid Rust/Node samples are required for both profiles. PostgreSQL, the test server/controller and system cache are outside these process figures. Isolated near-63-MiB RSS and separate parser/JSON/driver allocation remain unmeasured; the near-limit counters above remain distinct evidence.

Both runs cover REST SHA/policy/query/create/edit/stale-409, peer synchronization, MCP initialize/raw parity, projection reset/rebuild/audit, offline accepted edit, confirmed runtime-group SIGKILL, stopped client-directory copy/restore, pending edit resynchronization and peer deletion. All per-run runtimes, databases and fixture roots were removed. This is process/client-volume recovery, not power-loss durability, a full `rebuild-from-server-main`, live Mole/iPhone/conflict acceptance, visual browser acceptance, provider-service integration or deployment/soak proof.

After receipt promotion and scoped rustfmt, final `cargo fmt --check`, `cargo check` and build passed; **160 unit tests** and **27 actual PostgreSQL tests** passed (104.19 seconds for PG). Final `npm test` passed **333 tests in 20 files** and all **52 + 39 + 48 = 139** actual TLC checks. Both stack profiles were then rerun against the rebuilt binary and the saved reports above refreshed. Independent evidence-gate review (`f94f5ad1`) passed; source references were mechanically remapped after formatting. Logs are `/tmp/obts-final-closeout-{fmt,check,build,units,pg,node-formal}.log` and `/tmp/obts-final-formatted-stack-{disabled,local}.log`. Raw `/tmp` logs are optional working artifacts; the reports above and executable regression names preserve the durable evidence. After all validation completed, the parent-owned, label-verified disposable PostgreSQL container was removed too; reruns need a fresh explicitly supplied synthetic database server.
