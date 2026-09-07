# Persistence And Recovery Contract

## Authoritative State

- **Vault content history:** per-vault server Git object database and protected refs.
- **Canonical directory state and workflow metadata:** metadata store records coordinated with Git operations.
- **Visible device state:** the device's visible vault, with `.obts/git` as its durable journal and recovery substrate.
- **Device coordination:** journals, queues, credentials, cursors, scan state, directory intent, and recovery evidence under `.obts/`.
- **OBTS Bridge device state:** its persistent visible headless vault and `.obts/` state; these may hold the only copy of a pending agent edit.
- **OBTS Bridge PostgreSQL:** mixed state. Content-derived note, file, link, block, search, embedding, revision, and projection-cursor rows are rebuildable from verified headless state; retained access/audit history is not reconstructable and remains authoritative for its retention window. Neither class replaces or repairs uncertain headless client state.

### OBTS-BRG-PROJ-001: Derived-Only Bridge Projection

Derived indexes may accelerate history, search, graph, or projection but never override Git or visible headless content. Rebuilding content projection must preserve retained non-derived access/audit records. PostgreSQL is a derived query store, not a raw-body authority. It may retain a projection-produced normalized lowercase plaintext lexical index, including body-derived text, to preserve legacy arbitrary-substring matching and title-weight scoring without scanning all filesystem bodies per query. This representation is not raw Markdown and must never supply exact reads or response snippets. Legacy raw Markdown/Bases/block-body and raw search-source columns remain purged; naming a column differently is not evidence of derivation. Database copies and backups containing the lexical index contain normalized plaintext and require the same confidentiality controls as other content-derived data.

Production state, startup, request maps, and workers must not hydrate full database snapshots or retain a corpus-sized raw-body or derived lexical-text RAM mirror. Projection inventory pages metadata/OIDs. Corpus total is not an admission limit; the supported input-file boundary remains 64 MiB by default. Readiness advances only after all required rows of every file through the target (metadata, lexical index, tags, links, blocks and completion/deletion effects) commit and pending operations, singleton ownership and body leases are cleaned up. Partial commits do not publish a complete-file marker or cursor. Cancellation, failure, and restart retain the old cursor and replay idempotently, including cleanup of partial or superseded rows; retained access/audit history must survive.

Background projection is principal-independent and includes every supported synced note, including private notes. Bodies come from the ordinary visible filesystem or protected Git under the shared headless/filesystem lock and are revision/OID-attested before derived use. Foreground denial remains normal 403/404 without dirtying global projection or becoming 503. Source-integrity, storage, parse, or database failures drain work and fail readiness closed. PostgreSQL outage never selects a stale-body or corpus-text fallback or replaces uncertain headless state.

### OBTS-BRG-BODY-001: Attested Bounded Body Acquisition

The persistent authoritative body source for reads, projection, context, and embeddings is the ordinary headless filesystem and protected Git history. Foreground policy applies before hydration; background projection has no requesting principal. Acquisition and revision/OID verification are separate obligations. Retain a finite in-flight body lease throughout parsing, derived use, and any body-bearing response/serialization copies, including MCP conversion, until the operation releases that ownership. Input bytes obey the configured per-file limit (64 MiB default) and finite shared in-flight ownership budget. Token-budgeted multi-note context assembly may retain one operation lease and reuse it for sequential attested input hydration: only one full input/parse is active in that operation, each full input is discarded before the next read, and only token-budgeted output plus explicit response metadata survives through final serialization/drop. It must not reacquire the same global slot for every retained output fragment or retain multiple full inputs under one slot. Exact raw reads remain per-file leased. Publicly limited search/query-note snippet responses likewise retain one operation lease through sequential selected-input hydration and final response processing; only selected output fragments, not an input-body collection, survive between reads. No corpus-body RAM mirror is permitted.

Normal derived-write batches must obey both configured row count and actual encoded-parameter payload bytes (128 rows and 8 MiB defaults), including metadata, lexical-index, tag, link and block writes. If one indivisible row exceeds the normal byte budget, flush the normal batch first, then execute that row ALONE under its retained per-file body lease and one shared singleton permit across oversized operations. Keep the permit and body ownership through execution and cleanup, including driver/payload disposal, cancellation and failure; release them before another oversized operation. An oversized derived row is not grounds to reject an otherwise supported file or increase the normal batch settings.

Hard guarantees are input-file bytes, finite in-flight body ownership, normal-batch encoded payload and row count, and singleton concurrency/ownership. There is no defensible numerical hard encoded-singleton ceiling or process RSS bound: YAML parser trees, normalization/encoding expansion, derived singletons and driver copies are separately costed and measured, not bounded by an invented expansion factor. A supported file may be fully parsed; arbitrarily large individual files are not promised. Failure drains acquired work before settling and never serves stale PostgreSQL body text.

### OBTS-BRG-QUERY-001: Bounded Metadata Query And Hydration

REST/MCP shapes, graph/link/backlink completeness, lexical matching/scoring, ordering and authorization semantics remain unchanged. Config.yaml/runtime auth is the sole ACL-policy authority; PostgreSQL executes predicates derived from current policy. SQL policy, metadata, graph, Base, lexical/semantic candidate work and pagination precede selected body hydration. Legacy `query_notes` arbitrary-substring and title-weight scoring must use the derived normalized lowercase plaintext lexical representation, not be replaced by PostgreSQL token-only ranking. Preserve the legacy query title source, lowercase normalization and non-overlapping substring occurrence counts: score = 2 × title hits + projected plaintext hits (the `fulltext_ranking` behavior); SQL collation/normalization must not silently change those results. Actual response bodies/snippets must still come from authorized revision/OID-attested filesystem/Git reads, never the lexical index.

Bounded pages and intermediate candidate buffers are implementation budgets, not silent result limits: explicitly requested graph/link/backlink results must not be truncated to 500 or any internal page size. Output metadata has an explicit output-proportional cost; existing public pagination/limits remain unchanged. Context candidates must page/rank before token-budget selection and hydrate selected bodies incrementally without retaining all candidate bodies. Worker queues and request planning must not retain all corpus text. Caller denial remains 403/404 without dirtying projection; unhealthy source/storage/projection retains existing fail-closed behavior with no all-text fallback. FM003 models ownership and row lifecycle, not SQL compiler correctness, lexical equivalence, response format or ordering; those require executable regressions.

### OBTS-BRG-EMBED-001: Version-Bound Trusted Background Workers

Embedding and block reindex/backfill queues page bounded thin SQL candidates: note ID plus expected note revision and embedding schema/model epoch, or block ID plus expected parent note revision, embedding schema/model epoch, block source/derived epoch and content hash. They must not hydrate candidates through the legacy empty `StoreInner`, fall back to memory on SQL failure, retain all bodies, or materialize a corpus-wide chunk vector. Background acquisition is trusted and principal-independent, including private notes; it shares the existing headless/filesystem guard and backend, not a caller ACL or a bypass of headless coordination.

Acquire the shared headless/filesystem guard BEFORE the shared body permit, attest the expected source SHA/OID, capture only one file at a time, then release the filesystem guard before awaiting a provider. Retain input and body-bearing payload ownership until used or disposed; extract/sample incrementally into finite chunk/provider batches rather than splitting all text before selecting a bounded sample. Provider completion must not reacquire the filesystem guard while retaining a body permit: an API may already hold that guard while waiting for the sole body slot. SQL-only guarded completion is valid. Success, failure, cancellation and shutdown drain input/payload ownership and release permits before another capture; a late cancelled result is discarded, not applied. This does not require a hung provider to become responsive: cancellation must dispose or retain-and-drain outstanding owned work safely.

Success AND failure mutate only a matching current SQL generation. A note result checks its expected note revision AND embedding schema/model epoch; a block result additionally checks expected block content hash and source/derived epoch. Stale completion has matched-row count zero and changes neither newer content's vector, embedding readiness, nor retry count. Reindex/backfill publication and cleanup are equally version-bound. A new SQL projection invalidates superseded vectors and queued tokens; previously captured tokens may remain in flight but cannot mutate its replacement generation. Counts report matched rows, not submitted IDs. Filesystem source version and SQL projection generation are distinct: while projection catches up, an attested old result may still belong to the old SQL generation, but cannot overwrite a NEW SQL generation. SQL tokens do not replace source/blob attestation as body authority. The embedding schema/model epoch is a separate SQL-derived generation: changing model or schema invalidates vectors, readiness, retry state and queued tokens even if embedding dimensions, raw note revision and source bytes are unchanged. Source/body attestation checks SHA/OID, not a filesystem model fingerprint.

The version comparison and mutation must serialize with concurrent projection replacement. In PostgreSQL READ COMMITTED, an `UPDATE blocks ... FROM notes WHERE notes.revision = expected` snapshot alone does not establish this: lock/guard the parent note row transactionally with a consistent lock order, or store and compare the relevant source epoch on the target block row with a replacement protocol that serializes there. An ID-only join assumption is not a CAS. Schema/model invalidation must also serialize atomically with every note/block success AND failure: update the target-row embedding epoch with invalidation (including already-empty rows with pending results) and compare it in the mutation, or use a consistent transactional guarding protocol. A separate preflight or snapshot read of a global schema fingerprint is insufficient. Old SQL statements may remain in flight even after the originating process dies; they must not overwrite a reset generation with old-model vectors or retry failures. Stable current work is eventually retried under fair scheduling, available source/SQL and responsive provider; no liveness promise holds under endless edits, permanent faults or cancellation.

The 64 MiB default per-file input boundary and normal derived-batch/singleton contract above are unchanged. Worker/provider batches have explicit finite implementation budgets, not a new numerical parser, HTTP-encoding, driver-copy, singleton or RSS ceiling. `OBTS-FM-003`'s independent worker companion checks symbolic ownership, post-capture SQL drift, guarded completion/failure and lock schedules; the projection model remains authoritative for complete-row/cursor/audit ordering.

## OBTS-PER-OP-001: Server Write Protocol

Every operation capable of changing Git refs and associated metadata uses one durable operation record:

1. acquire the per-vault mutation lock;
2. persist an operation identity and expected refs;
3. validate authorization, objects, ancestry, path policy, limits, and operation invariants in quarantine;
4. persist a prepared manifest containing every metadata, directory, conflict, audit, event, derived-index, and result effect required after ref movement;
5. promote validated objects;
6. update the target ref with compare-and-swap semantics;
7. atomically apply the prepared metadata effects and mark the operation committed;
8. publish notifications only from committed events.

Startup aborts operations with no prepared side effects or no ref movement, rolls forward an exact prepared target whose ref already moved, and blocks the vault when state cannot be reconciled deterministically. A bounded live prepared transition may remain ready only when both expected old and target new state prove that exact transition.

## Local Publication

Journals and recovery artifacts use crash-safe publication semantics appropriate to the host: write/stage incomplete state, flush supported data, atomically publish, and advance the enclosing phase only after publication. The architecture does not equate a resolved Promise with power-loss durability.

A recovery bundle is complete only when its manifest, affected file snapshots, text patches, required local-only Git closure, journal copy, checksum manifest, and completion marker are discoverable and verified. Incomplete unreferenced staging may be removed; a journal-referenced bundle is never silently discarded.

## Apply Journal

The apply journal records schema version, operation identity, target main, expected prior refs/state, affected paths, typed preflight fingerprints, directory effects, preservation policy, target event cursor, recovery bundle, current phase, and last completed step.

Immediately before destructive replacement, the client atomically displaces the validated current path into journal-addressed `.obts/apply-displaced/<apply-id>/` storage, verifies the displaced identity/content, and creates the target only through a non-overwriting primitive. Displaced entries remain discoverable across restart and are moved to `.obts/recovery-displaced/<apply-id>/` quarantine before journal cleanup; they are never automatically deleted because an open file descriptor could mutate a renamed inode after validation. Quarantine pruning requires a separately approved destructive-lifecycle design.

Phases distinguish at least planning, recovery publication, file writes, verification, committed local refs/state, and blocked recovery. Journal cleanup occurs only after visible state, local refs, preservation queueing, and local applied-event cursor are durable. Missing server acknowledgement is recoverable independently.

## Backup Boundary

A server backup captures metadata and every per-vault Git store at one consistent point in time, plus any separately configured durable store. Deployment encryption keys and storage credentials are protected separately from the captured data.

An OBTS Bridge backup captures the complete persistent headless client volume and PostgreSQL access/audit records that must survive for their configured retention period. Content-derived PostgreSQL projection may be rebuilt only when authoritative headless state is restored and preservation checks pass; rebuilding it must not discard retained access/audit history. An unknown, pending, conflicted, or divergent client state must never be replaced from the server merely to repair an index.

Backup schedules, offsite destinations, retention, and secret-store paths are deployment decisions. Restore proof is an OBTS verification obligation.

## Integrity And Repair

Readiness verifies storage access, migrations, native Git, repository/object integrity, metadata/ref agreement, device refs, conflict protection, operation recovery, and derived-index references. Missing or inconsistent authoritative state fails closed.

Operator repair validates and clears a block only after the underlying state has been restored or reconciled deliberately. It never invents missing objects, selects among mismatched refs, reconstructs uncertain device work, or discards metadata to make readiness pass.

## Retention And Maintenance

Events are retained for the configured bounded period/count and expose cursor expiry. Diagnostics use separate finite retention. Git maintenance verifies and repacks, pruning only unreachable objects. Commits reachable from canonical, device, unresolved-conflict, and recovery refs are retained indefinitely until a separately approved destructive-lifecycle design exists.
