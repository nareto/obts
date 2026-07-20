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

The bridge image contains both runtimes from the same source revision. Rust supervises the Node process. Node owns `.obts`, local Git, pairing, queues, pull/apply, recovery, and synchronization. Rust owns public authentication, `config.yaml` policy, visible-vault reads and writes, parsing, PostgreSQL/pgvector, REST, and MCP. Rust never mutates `.obts/**`.

## Persistent state

The headless client directory is critical device state. It can contain the only copy of a pending agent edit and must not be discarded or replaced as index recovery.

PostgreSQL is the query projection. It stores parsed notes, frontmatter, tags, aliases, links, full-text data, embeddings, audit data, and per-file content revisions. Exact raw reads are revalidated against the visible filesystem. If the filesystem manifest and projection differ, authenticated query and write routes fail with `503` while the projection catches up.

Index recovery scans the visible vault, compares per-file SHA-256 revisions, projects changes and deletions, and updates its in-memory manifest watermark only after successful projection. It may rebuild PostgreSQL state, but it never repairs the index by changing the headless vault.

## Headless administration

Every client-core action needed without Obsidian is available through the JSON-lines adapter and the authenticated admin REST endpoint:

```text
POST /api/v1/admin/headless/command
X-Api-Key: <token mapped to the admin context>
Content-Type: application/json

{"command":"read-state","arguments":{}}
```

Supported commands include pairing, onboarding analysis/completion, synchronization, event polling, rename, unpair, local pairing reset, server replacement/rebuild recovery, queue inspection, and state inspection. Destructive commands remain explicit one-shot operations; they are not persistent startup configuration.

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
