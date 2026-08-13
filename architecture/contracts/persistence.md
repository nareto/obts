# Persistence And Recovery Contract

## Authoritative State

- **Vault content history:** per-vault server Git object database and protected refs.
- **Canonical directory state and workflow metadata:** metadata store records coordinated with Git operations.
- **Visible device state:** the device's visible vault, with `.obts/git` as its durable journal and recovery substrate.
- **Device coordination:** journals, queues, credentials, cursors, scan state, directory intent, and recovery evidence under `.obts/`.
- **OBTS Bridge device state:** its persistent visible headless vault and `.obts/` state; these may hold the only copy of a pending agent edit.
- **OBTS Bridge PostgreSQL:** mixed state. Content-derived note, file, link, block, search, embedding, revision, and projection-cursor rows are rebuildable from verified headless state; retained access/audit history is not reconstructable and remains authoritative for its retention window. Neither class replaces or repairs uncertain headless client state.

### OBTS-BRG-PROJ-001: Derived-Only Bridge Projection

Derived indexes may accelerate history, search, graph, or projection but never override Git or visible headless content. Rebuilding content projection must preserve retained non-derived access/audit records.

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
