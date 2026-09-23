# OBTS Bridge

OBTS Bridge is the agent-facing companion service for OBTS. It runs on a trusted host with a persistent headless vault, pairs through the normal OBTS device flow, and exposes the scoped REST and MCP capabilities used by coding agents.

## Runtime architecture

```text
Automation agents
       |
       | REST / MCP
       v
OBTS Bridge deployment
  Rust API, ACL, query and index process
       |
       | JSON-lines stdin/stdout
       v
  Node headless OBTS client
       |
       | normal device sync API
       v
OBTS server
```

The bridge image contains both runtimes from the same source revision. The Obsidian plugin and headless adapter instantiate the same mobile-safe client core; the Node adapter supplies filesystem and HTTP host ports without replacing sync or recovery behavior. Rust supervises the Node process. Node owns `.obts`, local Git, pairing, queues, pull/apply, recovery, and synchronization. Rust owns public authentication, `config.yaml` policy, SQL-first metadata/ACL/query planning, selected attested body reads and writes, input-limited parsing and leased, generation-guarded embedding workers, PostgreSQL/pgvector, REST, and MCP. Rust never mutates `.obts/**`.

## Persistent state

The headless client directory is critical device state. It can contain the only copy of a pending agent edit and must not be discarded or replaced as index recovery.

PostgreSQL contains mixed state. Parsed frontmatter, tags, aliases, links, a projection-produced normalized lowercase plaintext lexical index, optional language-neutral `tsvector` data, embeddings, block locations and hashes, per-file revisions/OIDs, policy-derived predicates, ACL-visible metadata, and the indexed-commit cursor are content-derived projection that can be rebuilt from verified headless state. Retained access/audit history is not reconstructable and must be preserved for its configured retention period. Raw Markdown, Bases content, legacy raw search-source columns and block bodies remain purged from PostgreSQL; exact bodies remain authoritative in the headless filesystem/Git. The derived lexical index intentionally retains normalized body-derived plaintext in the DB and any backups that capture it. It is not raw Markdown, must not be an exact-read/snippet source, and requires content confidentiality controls. Migration 0020 introduces the separately produced lexical representation and invalidates old complete-file markers, including same-commit upgrades, without changing the old cursor or audit records. Config.yaml/runtime auth is the sole ACL-policy authority; PostgreSQL only executes predicates derived from the current policy. PostgreSQL is not loaded as a full startup snapshot and is never the fallback body source.

Node reports an immutable `local_head` plus a metadata-only path/blob-OID manifest and add/modify/delete delta from the durable indexed commit. Clean idle generations do not enter the child or filesystem projection paths. SQL selects foreground caller-authorized metadata/candidates in pages first. While holding the shared client/filesystem lock, Rust acquires only selected bodies, verifies path identity plus expected revision/OID, parses input within the per-file limit, writes normal bounded batches or owned oversized singletons as specified below, releases body and driver/payload work, and advances the PostgreSQL cursor only after every required row through the target succeeds. Background projection has no requesting principal and indexes every supported synced note, including private notes. A caller denial remains 403/404 and does not dirty global projection; source-integrity/storage failure drains acquired leases, retains the cursor, and fails readiness closed. A crash replays idempotently from the old cursor, including when a later target reverts an already-partially-projected change.

The supported corpus total is not an admission limit. One supported file may be fully parsed, but the configured per-file input-byte limit remains a hard support boundary; arbitrary gigantic single-file streaming is not promised. Hard guarantees cover input bytes, finite body ownership, normal encoded-batch payload/row count and singleton concurrency. Parser trees, normalization/encoding expansion, derived singletons, response metadata and driver copies require separate costing/measurement; no numerical hard singleton-byte ceiling or RSS bound is claimed. Body drift, missing/source access failure, parse/read failure, database/batch failure, or an unhealthy cursor remains fail-closed with `503`, releases/drains in-flight work, retains the prior cursor and audit history, and never creates an all-text memory fallback. Caller authorization denial is deliberately excluded from this failure path and keeps its existing 403/404 response. Repeated child process failures use bounded exponential backoff and open a restart circuit instead of creating an unlimited restart loop; restarting the bridge explicitly resets that fail-closed circuit. Status and Prometheus metrics expose fixed-cardinality child, projection-failure, and audit-freshness counters.

## Headless administration

Every client-core action needed without Obsidian is available through the JSON-lines adapter and the authenticated admin REST endpoint:

```text
POST /api/v1/admin/headless/command
X-Api-Key: <token mapped to the admin context>
Content-Type: application/json

{"command":"read-state","arguments":{}}
```

Supported commands include pairing, onboarding analysis/completion, synchronization, event polling, rename, unpair, local pairing reset, server replacement/rebuild recovery, queue inspection, state inspection, and `reset-index-projection`. The last command clears only the derived commit cursor so the next worker pass performs an explicit full projection rebuild; it never changes the vault or `.obts` state. Destructive commands remain explicit one-shot operations; they are not persistent startup configuration.

Long headless operations emit redacted startup and operation progress events. `client.request_inactivity_timeout_seconds` (default 300) bounds silence between closed-schema protocol messages rather than total command duration during startup recovery, request writes, and response reads; each valid progress event resets the inactivity window. Child stdout frames are capped at 1 MiB; `read-index-delta` inventories are returned in cursor-bound pages below that cap and reassembled under the Bridge filesystem lock. State events precede their correlated response, are schema-checked, and are limited to one per request; missing or extra protocol fields fail closed. Invalid, unrelated, oversized, cancelled, or silent child traffic is quarantined and restarted through the bounded circuit, while onboarding and transfer authority remains in the Node client's durable `.obts` journals rather than Rust memory.

## Write semantics

Rust validates the effective ACL, prepares the complete candidate content, and writes ordinary vault files atomically. It then wakes the headless client, which detects the change and processes it through the normal OBTS commit, queue, push, merge, conflict, and recovery path.

Every exact note/file read and successful write receipt returns an opaque whole-file `revision` (`v1:sha256:...`). Every existing-file mutation, including metadata-only and tag-only edits, must return that value unchanged as `expected_revision`. Missing preconditions return HTTP 428, stale preconditions return HTTP 412, and unknown mutation fields are rejected. The bridge compares the token against the authorized exact raw bytes before transformation and then carries the internal source revision to the atomic filesystem CAS seam; create-if-absent remains exclusive and does not take a revision. `content_sha256` remains informational and cannot authorize a write.

## Markdown export

`GET /api/v1/vault-files/export?include=markdown` returns the current policy-visible, exact-source Markdown set as a deterministic schema-2 ZIP. `manifest.json` is first, paths are bytewise sorted and safe, each entry carries its whole-file revision and SHA-256, and denied paths/counts are never disclosed. Exact bodies unavailable from the pinned projection are omitted with only an aggregate count; PostgreSQL lexical text is never reconstructed as a body fallback. Strong ETags and weak `If-None-Match` matching support 304 responses.

Exports are limited to 10,000 visible candidates and 256 MiB of uncompressed Markdown. One process-wide export may run at a time. The bridge holds the projection read lock, hydrates one leased exact body at a time in each of two passes, writes a mode-0600 disk-backed ZIP, streams that file, and removes the temporary archive while releasing the export permit on completion, disconnect, or error.

## Search

Legacy `query_notes` arbitrary-substring matching and title-weight scoring must be preserved in SQL using a derived normalized lowercase plaintext lexical index. PostgreSQL `simple` token search/ranking alone is not equivalent (for example, `quartz` must match `uniquequartz`); the SQL implementation counts non-overlapping occurrences after Rust lowercase normalization, preserving the legacy filename title source and weight of two. The separate `/search` endpoint retains PostgreSQL FTS semantics. SQL policy/candidate work must precede hydration; no full-corpus filesystem scan or resident lexical/body mirror is permitted. Actual snippets and exact bodies still require authorized, attested FS/Git reads. Internal candidate/metadata pages do not authorize silently truncating requested graph/link/backlink results at 500. Response metadata costs are output-proportional; context candidates must page/rank before token-budget selection and must never retain all candidate bodies. Semantic note and block search uses the configured LocalAI embedding endpoint. A configured multilingual model must match the configured vector dimensions; changing model identity or dimensions invalidates existing vectors and triggers re-embedding. The request-serving path ranks existing note/block vectors and attests selected block snippets. Embedding workers use thin SQL candidates, trusted attested filesystem capture, incremental chunk sampling/aggregation and matched-generation success/failure writes in both Local and LocalAI modes. Schema reset and completion share a transactional epoch guard; reindex/backfill reuses verified bounded projection. See [implementation and synthetic stack evidence](bridge-embedding-worker-evidence.md) for measured scope and remaining live-delivery limits.

## Configuration migration

The old `client.projection_max_text_bytes` setting described an aggregate text-admission behavior and is rejected at startup. Replace it explicitly with `client.projection_max_file_text_bytes`; the default and supported desktop boundary is 64 MiB per file. Do not silently reinterpret an old aggregate value as unlimited input.

`projection_max_inflight_bodies` (default 2) bounds simultaneously acquired bodies, `projection_batch_rows` (default 128) bounds rows per normal derived-write batch, and `projection_batch_bytes` (default 8 MiB) bounds its encoded-parameter payload bytes. These settings bound in-flight work, not the supported corpus total.

The required normal limits apply to metadata, lexical index, tags, links and blocks, not only block batches. An indivisible row above the byte budget must flush the normal batch, execute ALONE under a retained per-file body lease plus one shared singleton permit, and dispose of its payload/driver work before releasing that permit and allowing another oversized operation. It must not reject the supported file or increase normal settings. There is no defensible numeric bound on singleton encoding expansion from the current YAML/parser pipeline. Body leases must also survive MCP JSON conversion and subsequent body-bearing processing. A token-budgeted multi-note context holds one operation lease through response assembly and serialization; it reuses that slot for sequential attested reads, discards each full input before the next read, and retains only selected token-budgeted output plus explicit metadata. This avoids deadlock with one configured body slot without permitting simultaneous input parsing. Exact raw file reads remain per-file leased. Publicly limited search/query-note snippet responses likewise retain one operation lease through sequential selected-input hydration and final response processing; only selected output fragments, not an input-body collection, survive between reads.

The 0.1.3 core SQL lane uses one encoded-parameter writer for files, note metadata, lexical projection, tags, links, blocks, deletion/cleanup and completion markers. It invalidates completion before partial commits, verifies expected row counts and the target revision manifest before publishing the cursor, and drains detached per-file work after caller cancellation. Metadata query filters and runtime-policy predicates run in SQL; Rust regex evaluation remains the authority for regex rules. Base pages select only referenced properties (or explicitly requested whole properties), filter link targets by policy, and use SQL default/numeric ordering; heterogeneous or complex Base ordering retains the bounded legacy evaluator fallback. Exact graph centrality retains ID-only topology, while context scalar candidates are ranked and paged in PostgreSQL before token-budget selection. Embedding-worker ownership/reindex remains a separate lane. Configuration values must be positive and finite. Missing/invalid migration must fail closed, never select legacy full-map fixtures or reconstruct uncertain client state.

The migration preserves REST/MCP operation names and ACL behavior while intentionally strengthening mutation schemas to mandatory whole-file revisions and adding the Markdown export route. Operators must rebuild projection from verified headless state after changing projection/index settings; the rebuild must preserve retained access/audit history and must not replace `.obts` or visible files.

## Development

```sh
npm run build
npm test
cargo test -p obts_bridge
docker build -f crates/obts-bridge/Dockerfile -t obts-bridge:dev .
```

The generic application configuration is in `crates/obts-bridge/config.example.yaml`. Environment-specific deployment belongs in a separate private infrastructure repository.

### Synthetic PostgreSQL lane checks

Run the SQL checks explicitly against a disposable synthetic PostgreSQL server with pgvector available and permission to create databases:

```sh
OBTS_SYNTHETIC_POSTGRES_URL=postgresql://obts_bridge_test@127.0.0.1:32785/obts_bridge_test \
  CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target \
  cargo test -p obts_bridge postgres_ -- --ignored
```

Each check owns a separate database and removes it on success. These explicit integration tests fail, rather than silently skipping, when PostgreSQL is unavailable. They cover SQL metadata/pagination/Bases/graph, existing semantic vectors and attested block snippets, exact raw/parsed reads, ACL reload and private-note indexing, CAS writes, missing/drifting sources, partial-block-write replay/revert, cursor/audit retention, body lease lifetime, a 520-file policy-visible Markdown export with weak-ETag validation, and a 72,194,048-byte distributed corpus with empty resident body maps. The ordinary `cargo test -p obts_bridge` suite lists these database-dependent tests as ignored; run both commands for this lane.

Fourteen real-PostgreSQL checks now cover the original four scenarios plus 9 MiB frontmatter and oversized lexical rows under default limits, tiny-budget fanout/omitted rows/failure/restart/revert/migration, singleton cancellation/drain, lexical/order/ACL parity, 505-node graph/count completeness, hub position ties, late-ranked context candidates, negative semantic scores, single-slot multi-note context, and paged SQL-backed Markdown export. The distributed corpus is 72,194,048 bytes (~68.85 MiB), not 72 MiB. Observed synthetic writer highwaters were 128 normal rows / 18,560 encoded bytes and a 10,000,040-byte singleton under defaults; tiny 3-row/256-byte settings reached 3 rows / 203 normal encoded bytes and a 4,345-byte singleton. These are fixture measurements, not parser/RSS ceilings. Four review regressions additionally cover cancellation before the initial incomplete-file commit with replay started while the writer remains blocked, nonempty context with one database connection, Base properties named date/today/now, and endpoint-specific backlink/BFS ordering without changing positional note references. MCP/REST ownership checks run in the ordinary unit suite. Embedding-worker and end-to-end deployment acceptance remain separate evidence.

### Disposable full-stack and RSS check

On Linux with Node 24+, Cargo, Git and `psql`, set `OBTS_SYNTHETIC_POSTGRES_URL` to a loopback, trust-authenticated disposable PostgreSQL server with pgvector and database-creation permission, then run:

```sh
CARGO_TARGET_DIR=/tmp/obts-bounded-memory-target npm run test:bridge:stack
```

The opt-in `scripts/check-bridge-stack.mjs` creates its own database, server, peer vault and Rust-supervised Node vault. It uses the real cookie/CSRF approval protocol, then checks scoped REST/MCP reads, exact hashes, mandatory/stale revision handling, unknown mutation fields, policy-aware Markdown export with weak-ETag caching, peer synchronization/deletion, derived rebuild and audit retention. It also accepts an edit while its local sync server is stopped, SIGKILLs the owned Rust/Node process group, copies/restores the stopped authoritative client directory, and verifies the pending edit reaches the peer after restart. This is process/volume recovery evidence, not power-loss durability. It generates temporary credentials without printing them. PostgreSQL commands use a private empty passfile, isolated environment, noninteractive authentication and timeouts, rather than inheriting `PGHOSTADDR`, `PGSERVICE`, passwords or home-directory configuration. Node environment-proxy options, including quoted and underscore spellings, are rejected. The in-process server runs from the private temporary directory with a minimal environment and no user/system Git configuration; inherited Git object/common-directory routing is not retained. The test requires the explicitly selected server to be disposable; it does not select a real vault or deployment.

Normal exit and catchable interruption stop continuation, drain work, and confirm the owned process group has stopped before deleting or restoring its files. Cleanup is idempotent and failures are reported rather than silently treated as success. SIGKILL of the harness itself, host failure, or unconfirmed cleanup can leave owned resources; failure reports identify possible residue. Do not remove directories while an owned runtime may still be using them.

The harness compares sampled Rust and supervised Node RSS/anonymous memory at 8 MiB and 72 MiB of fixed-size notes. Embeddings are disabled by default; set `OBTS_BRIDGE_STACK_EMBEDDINGS=local` to exercise deterministic note/block workers without an external provider. That mode also waits for both profiles and post-recovery queues to complete and checks trusted private-note/block embedding. Both profiles explicitly use 4 KiB block chunks, 64 vector dimensions and a one-second worker poll; the report records these settings. Its JSON report contains steady medians, sampled maxima and valid observation counts; absent observations are null, not zero, and valid Rust/Node samples are required for both profiles. Sampled maxima can miss short spikes and are not a universal RSS ceiling. The report defaults to a unique temporary file; `OBTS_BRIDGE_STACK_REPORT` can name a new output file (the configured path is not echoed). Failures use safe operation/category identifiers, not raw responses, SQL errors or credentials. This local HTTP-driven check does not replace visual browser, live Mole/iPhone, conflict, soak, or production client-volume acceptance. The core-lane run passed all 30 checks; rerun against the final worker-inclusive binary before using that result as full redesign evidence.
