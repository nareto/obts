# ADR 0005: Accept immutable upload proposals independently of ref movement

- Status: Accepted
- Date: 2026-07-24

## Context

A large device proposal can take longer to hash, transfer, validate, and merge than a normal proxied HTTP request remains open. The server previously performed validation and merge synchronously during transfer finalization. If the server committed after the client or reverse proxy lost the response, the client retained an unacknowledged queue entry.

The client then scanned the vault before recovering the prior outcome. Pending directory intents could create a new metadata-only descendant commit, replacing the original transfer target and defeating the server's idempotent attempt record. A retry could therefore upload the same objects again. The server also treated any mismatch between the advisory expected device ref and its current device ref as `stale_device_ref`, even when the uploaded target safely descended from the current ref.

Large-tree validation amplified the problem by spawning one Git process per blob, while clean disjoint merge materialized every changed file in a temporary worktree.

## Decision

One client upload is an immutable durable proposal. The plugin persists its target commit, expected device ref, directory proposal, object groups, attempt ID, and transfer ID under `.obts/upload-transfer.json`. Watcher hints and later edits remain queued but cannot replace the target until the plugin consumes a terminal server result.

The server separates durable receipt from canonical integration. After all chunks are present, capable clients request asynchronous finalization and receive a processing descriptor immediately. The client polls the transfer resource. Processing and terminal results remain in the transfer session, and polling restarts interrupted processing after a server restart.

Device-ref movement is classified by commit ancestry:

- equal targets return the prior result or an idempotent no-op;
- a target descending from the current device ref is accepted as an ancestry-safe fast-forward even when the expected ref is stale;
- a target already covered by the current device ref is accepted as superseded and never moves the ref backwards;
- divergent same-device history is promoted into protected conflict history and routed to dashboard review without moving the device ref.

Movement of canonical `main` never invalidates a valid proposal. Per-vault integration serializes proposals and merges each against the canonical state current at its turn. Rejection remains available for authentication, authorization, integrity, path policy, provenance, capacity, abuse, revocation, and pre-existing blocked-state failures.

Tree path and size validation uses one batched `git ls-tree -r -l -z` operation. Clean disjoint merge uses object-level `git merge-tree` and `git commit-tree`; temporary plaintext worktrees remain limited to overlapping content requiring semantic validation.

## Consequences

- A lost finalization response becomes transfer-result retrieval, not a rescan or re-upload.
- Concurrent devices may upload while another proposal is processing; canonical integration remains serialized and deterministic.
- Stale advisory refs no longer waste a completed transfer when ancestry proves safety.
- Genuine same-device divergence remains recoverable and reviewable rather than being discarded.
- Transfer descriptors gain `processing` and `rejected` terminal semantics and advertise a polling interval.
- Zero-chunk transfers are valid for retrieving or completing an already-present target and its directory acknowledgement.
- The plugin and server require a coordinated capability-gated rollout so older clients retain the synchronous finalization contract.
