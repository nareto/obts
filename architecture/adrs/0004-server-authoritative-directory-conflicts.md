# ADR 0004: Make directory conflicts server-authoritative

- Status: Accepted
- Date: 2026-07-24

## Context

Git does not represent empty directories, so obts synchronizes directory state as product metadata attached to device proposals. Earlier clients reduced directory changes to `{op,path}` on upload and attempted to infer ambiguous recovery locally. Plugin reloads could leave stale empty-directory creates that were indistinguishable from intentional recreation, resulting in a client-side keep-local/accept-server modal.

That workflow put semantic conflict authority on one device, discarded causal provenance at the transport boundary, and could resurrect a directory already deleted from canonical state.

## Decision

Directory changes are versioned device proposals. Each proposal and intent carries stable identity, generation, and the device's acknowledged main/event baseline. The server compares the proposal with the acknowledged explicit-directory snapshot and current canonical directory state before advancing `main`.

Disjoint and equivalent directory operations merge automatically. Opposing create/delete operations on the same or ancestor/descendant paths create a durable `directory` or `mixed` conflict. The dashboard is the only UI that chooses the semantic winner.

The plugin owns local observation, crash journals, recovery evidence, and physical apply safety. It removes directories only through deepest-first non-recursive empty-directory operations. Local content or changed identities can block physical removal or become new local work, but never choose the canonical winner.

Proposal outcomes and exact intent-generation acknowledgements are durable and idempotent. Git and directory metadata from one proposal are committed or conflicted together. Startup reconciliation replays directory metadata from the prepared server operation when a ref moved before metadata persistence.

During rollout, the server conservatively lifts legacy `{op,path}` uploads against the device's server-known acknowledged snapshot. The new plugin requires the `directory-proposals-v2` capability and never silently falls back. Legacy local recovery journals are migration evidence only and do not expose a user decision flow.

## Consequences

- Normal folder deletion converges without client prompts.
- Genuine concurrent directory recreation is reviewed in the dashboard.
- Conflict records and review packages support content, directory, and mixed conflicts.
- Server metadata schema v6 persists directory proposal outcomes.
- The protocol and persistence model are more explicit, but no CRDT or per-path vector clock is required.
- The server cannot bypass client filesystem safety; canonical acceptance never authorizes recursive local deletion.
