# OBTS Bridge

OBTS Bridge is the agent-facing companion service for OBTS. It runs on a trusted host with a persistent headless vault, pairs through the normal OBTS device flow, and exposes the scoped REST and MCP capabilities used by coding agents.

## Runtime architecture

```text
Granularix agents
       |
       | REST / MCP
       v
OBTS Bridge on Titania
  Rust API, ACL, query and index process
       |
       | JSON-lines stdin/stdout
       v
  Node headless OBTS client
       |
       | normal device sync API
       v
OBTS server on Interstellar
```

The bridge image contains both runtimes from the same source revision. The Obsidian plugin and headless adapter instantiate the same mobile-safe client core; the Node adapter supplies filesystem and HTTP host ports without replacing sync or recovery behavior. Rust supervises the Node process. Node owns `.obts`, local Git, pairing, queues, pull/apply, recovery, and synchronization. Rust owns public authentication, `config.yaml` policy, visible-vault reads and writes, parsing, PostgreSQL/pgvector, REST, and MCP. Rust never mutates `.obts/**`.

## Persistent state

The headless client directory is critical device state. It can contain the only copy of a pending agent edit and must not be discarded or replaced as index recovery.

PostgreSQL is a derived-only query projection. It stores parsed frontmatter, tags, aliases, links, language-neutral `tsvector` data, embeddings, block locations and hashes, audit data, per-file revisions, and a durable indexed-commit cursor. Raw Markdown, Bases content, search source text, and block bodies remain only in the headless client filesystem and Git object store. Runtime memory is hydrated from that filesystem before serving; exact reads are revalidated there.

Node reports an immutable `local_head` plus an add/modify/delete delta from the durable indexed commit. While holding the shared client/filesystem lock, Rust verifies changed-file SHA-256 values against commit blobs, applies the derived delta, audits the complete visible snapshot, and advances the PostgreSQL cursor only after success. A crash replays idempotently from the old cursor. Missing or non-ancestor cursors, content drift, pending persistence, and projection failures remain fail-closed with `503`; they never rewrite or replace client state.

## Headless administration

Every client-core action needed without Obsidian is available through the JSON-lines adapter and the authenticated admin REST endpoint:

```text
POST /api/v1/admin/headless/command
X-Api-Key: <token mapped to the admin context>
Content-Type: application/json

{"command":"read-state","arguments":{}}
```

Supported commands include pairing, onboarding analysis/completion, synchronization, event polling, rename, unpair, local pairing reset, server replacement/rebuild recovery, queue inspection, state inspection, and `reset-index-projection`. The last command clears only the derived commit cursor so the next worker pass performs an explicit full projection rebuild; it never changes the vault or `.obts` state. Destructive commands remain explicit one-shot operations; they are not persistent startup configuration.

## Write semantics

Rust validates the effective ACL, prepares the complete candidate content, and writes ordinary vault files atomically. It then wakes the headless client, which detects the change and processes it through the normal OBTS commit, queue, push, merge, conflict, and recovery path.

Exact replacement and anchored patch operations are naturally state-sensitive. Blind append/prepend operations additionally require `expected_sha256` from the latest `get_vault_file` response; stale preconditions return HTTP 409 rather than duplicating a retry.

## Search

Lexical search uses PostgreSQL's language-neutral `simple` text-search configuration so English and Italian notes share one predictable index without applying the wrong language stemmer. Semantic note and block search uses the configured LocalAI embedding endpoint. The managed deployment uses `BAAI/bge-m3` as `bge-m3`, an explicitly multilingual 1024-dimension model; changing model identity or dimensions invalidates existing vectors and triggers re-embedding.

## Development

```sh
npm run build
npm test
cargo test -p obts_bridge
docker build -f crates/obts-bridge/Dockerfile -t obts-bridge:dev .
```

The generic application configuration is in `crates/obts-bridge/config.example.yaml`. Environment-specific deployment belongs in `infra/titania/obts-bridge`.
