# ADR 0006: Make local reconciliation durable and watcher-first

- Status: Accepted
- Date: 2026-07-29

## Context

The original product design included a periodic full or incremental scanner as a safety net for watcher events missed while Obsidian was stopped, suspended, externally modified, or interrupted during apply. The first background implementation instead ran the complete local snapshot path every ten seconds. Commit `84122ae` separated remote polling from local scanning and reduced the full-scan cadence to five minutes, but the fixed interval was an implementation mitigation rather than a measured product requirement.

A complete snapshot reads and hashes every syncable file. On a 6,000-file, roughly 500 MiB vault, this made a routine fallback appear as a long-running foreground `Checking` operation and repeated the same work after plugin reload because the completion timestamp existed only in process memory.

Directory causality had a separate restart problem. An upgraded device could retain a trusted canonical `local_main` and queued descendant commit while losing its applied-event cursor. The client rebuilt legacy pending directory intents against the local cursor and the server correctly rejected the proposal as `stale_directory_proposal_base`, because accepting it against a different acknowledged explicit-directory snapshot could resurrect or delete folders. The terminal transfer remained queued, so upload recovery ran before baseline reconciliation and repeatedly presented the safe server rejection as `Unsafe local state`.

## Decision

Normal local reconciliation is watcher-first:

- Obsidian watcher paths are persisted in the durable queue, including hints arriving while an immutable upload is in flight.
- `.obts/scan-cache.json` pairs filesystem size and reliable change identity with the Git blob OID previously proven for each path. A cached file is reused only when its blob OID still matches the local Git base and its reliable filesystem identity is unchanged. Watcher-invalidated paths always bypass the cache.
- `.obts/scan-state.json` records scanner schema, vault/device identity, local head, directory generation, inventory completion, and the next complete-audit deadline. Plugin reload therefore does not itself trigger traversal.
- Idle metadata inventory is a six-hour fallback for missed watcher events. Complete byte-level verification is weekly and available immediately through `Verify local vault contents`. UI labels distinguish `Checking changes` from `Verifying contents`.
- A converged idle client upgrading from the former five-minute scanner may seed cache metadata without reading content only when the visible path set exactly equals its trusted local Git tree. Because this is migration evidence rather than a new byte audit, the first complete audit is scheduled within 24 hours. Any queue, error, cursor divergence, or path mismatch requires full verification instead.

A stale directory proposal baseline is repaired causally:

- `.obts/directory-baseline-recovery.json` protects the rejected transfer identity, local refs/cursors, queued commit, and original intent generations across crashes.
- Recovery requires the server-acknowledged main to exist locally and be an ancestor of both trusted local main and the queued commit.
- The client requests the authoritative historical directory snapshot for its already-materialized local main, acknowledges only that main/event pair, and rebuilds effective local intents relative to that snapshot.
- The rejected immutable checkpoint identity remains in the recovery journal until the authoritative baseline is acknowledged, then the checkpoint is removed and a fresh proposal is created because directory proposal provenance is immutable. Visible files and queued Git history are never rewritten.
- Missing historical evidence, invalid ancestry, or journal identity mismatch fails closed.

The server records stable `AuthError` codes, including `stale_directory_proposal_base`, as sync-operation abort reasons instead of collapsing them to `unexpected_error`.

## Consequences

- Ten-second remote polling remains lightweight and plugin reload no longer forces a vault scan.
- Most watcher-driven syncs read only changed files; large unchanged attachments are not repeatedly loaded into memory.
- Filesystems without reliable change identity do not receive unsafe cache reuse and are protected by complete audits.
- A same-size edit missed by both watcher and filesystem identity may be delayed until the weekly audit, which is why the explicit verification command and bounded fallback remain required.
- Upgrading converged clients avoids one immediate redundant whole-vault read while retaining a near-term complete audit.
- Directory baseline mismatch is presented as `Repairing baseline`, not local corruption, and survives interruption without losing queue or intent evidence.
- Fresh directory provenance requires a new proposal/transfer identity; preserving an invalid causal proposal would be less safe than reusing its protected Git commit in a corrected proposal.
