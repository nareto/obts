# System And State Ownership Model

## Runtime Allocation

### Obsidian plugin

Owns local observation, visible-vault reconciliation, hidden local Git, immutable upload journal, directory intent, apply/recovery, browser-assisted onboarding state, and user-visible plugin status. It uses Obsidian APIs and a mobile-safe isomorphic-git implementation; it does not use native Git or Node/Electron-only APIs on the sync path.

### OBTS server

Owns dashboard/device authentication, account and vault authorization, connection approval, transfer receipt, proposal validation, canonical integration order, native-Git refs and objects, canonical directory state, conflicts, event/audit metadata, history/restore, integrity, and maintenance.

### Dashboard SPA

Owns authenticated presentation and user intent collection. It does not decide sync outcomes independently of server state and does not maintain an authoritative convergence clock.

### OBTS Bridge

The Rust service owns scoped REST/MCP authentication, SQL-backed metadata/ACL/query planning, atomic ordinary-vault-file mutation, and bounded on-demand body hydration. The supervised Node headless client owns pairing, visible headless vault, `.obts/`, local Git, queue, transfer, pull/apply, and recovery. Rust never mutates `.obts/**`, retains a corpus-sized raw-body or derived `search_text` map, or substitutes a rebuilt index for uncertain client state.

Config.yaml/runtime auth is the sole ACL-policy authority; PostgreSQL stores note metadata and executes predicates derived from the current policy. It owns paginated metadata, policy-derived search/graph/Base candidates, revision/OID, and projection-cursor state plus retained audit history. Raw Markdown, Bases, blocks and exact response bodies remain authoritative in ordinary files/Git; PostgreSQL may retain a derived normalized lowercase plaintext lexical index (also plaintext in DB backups), never used for exact reads/snippets. Foreground caller denial remains 403/404 and does not dirty global projection. Principal-independent background projection indexes every supported synced note, including private notes. Each selected body is read under the existing shared filesystem/headless lock, checked against the projected revision/OID, parsed within the configured input-file limit, and owned until body-bearing use and copies are released. Normal derived batches obey row/encoded-byte budgets; an indivisible oversized row executes alone under the file lease and one shared singleton permit through cleanup. Parser trees/singletons/driver copies are separately measured, with no numerical hard singleton ceiling or RSS claim. Source-integrity/storage failures drain work, retain the cursor, and fail readiness closed. A corpus whose total text exceeds a legacy aggregate cap remains eligible; an individual file above the configured per-file read/parse limit remains unsupported.

## Persistent Stores

- **Visible device vault:** local user or agent content; the immediate device source of truth.
- **Device `.obts/`:** local Git, credentials, journals, queues, scan/directory state, and recovery evidence.
- **Server Git store:** canonical, device, conflict, and recovery history.
- **Server metadata store:** users, sessions, vault/device state, operation manifests, directory outcomes, conflicts, events, audits, diagnostics, and derived history metadata.
- **Transfer quarantine:** resumable chunks, staged objects, processing state, and terminal outcomes.
- **Semantic workspace:** transaction-scoped materialization only for overlapping content requiring semantic validation.
- **Bridge PostgreSQL:** mixed state: rebuildable content-derived metadata/full-text/vector/graph/revision/projection rows plus non-reconstructable retained access/audit history.

## Principal Flows

### Local edit to canonical main

1. Plugin/headless host records a watcher hint.
2. Client obtains a coherent snapshot and creates reachable local Git.
3. One immutable proposal is journaled and uploaded.
4. Server validates and protects the actor device history.
5. Server integrates against canonical state or creates a protected conflict.
6. Committed events advertise the outcome.
7. Clients pull, publish recovery, apply, preserve concurrent local work, and acknowledge durable application.

### Conflict resolution

1. Server materializes authorized base/server/device variants from protected history.
2. Dashboard shows persistent server-versus-named-device provenance.
3. Owner submits a scoped result against expected main.
4. Server verifies freshness, constructs the exact final tree/directory state, records a two-parent resolution commit, and commits metadata/events.
5. Devices consume the new main through normal safe apply.

### Bridge write and projection

1. Rust authenticates the context and validates ACL plus revision preconditions.
2. Rust atomically writes the ordinary visible vault file under the shared client/filesystem lock.
3. Node observes and processes the edit through the normal device protocol.
4. Projection obtains a bounded metadata page, acquires only selected bodies, verifies revision/OID against the ordinary source, writes every required row via normal batches or owned singletons, cleans up partial/superseded rows and body work, and advances PostgreSQL's cursor only after complete success.
5. Drift, source/storage denial, parse/read, batch, or database failure retains the prior cursor and fails readiness closed; no stale DB body or all-text RAM fallback is permitted.

## Fail-Closed Boundaries

- Missing/unusable native Git, metadata, store, workspace, migration, or permission state blocks readiness.
- Unreconciled Git/metadata state blocks only safe repair-capable operation; it never fabricates history.
- Unsafe local apply, invalid ancestry, missing historical directory baseline, corrupt journal, uncertain Bridge client state, projection drift, or unhealthy projection blocks unsafe body use and preserves evidence.
- Dashboard, diagnostic, and repair surfaces remain available where routing them cannot expose or mutate blocked vault content unsafely.

The authored topology remains in `architecture/workspace.dsl`; this model supplies state ownership and interaction semantics that C4 cannot express alone.

Query planning pages/ranks intermediate candidates without a corpus-body mirror. This does not cap explicitly requested graph/link/backlink outputs at 500: response metadata has output-proportional cost. Legacy arbitrary-substring/title-weight scoring must be preserved by the derived lexical index, and selected response bodies require original-source attestation.
