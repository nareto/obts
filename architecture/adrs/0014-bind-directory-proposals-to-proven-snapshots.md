# ADR 0014: Bind Directory Proposal Cursors To Proven Snapshots

- Status: Accepted
- Date: 2026-09-27

## Context

A directory proposal carries the cursor of the directory snapshot on which the client based its intents. The server can receive the apply acknowledgement after unrelated events have advanced the vault event cursor. Recording that newer cursor without reconciling the client leaves a valid proposal apparently stale. Conversely, accepting a stale cursor without evidence can apply intents against a different directory baseline.

Historical snapshot reconstruction has the same requirement: a cursor and its explicit-directory state must describe one coherent baseline. Reusing a newer baseline for an older main is valid only when the intervening event history proves the directory state did not change.

## Decision

The server records the retained delivered directory snapshot when acknowledging an apply. If that evidence is unavailable, it may reconstruct or advance the cursor only through contiguous retained events that contain no directory intents. An incomplete or malformed history is not proof of neutrality.

For compatibility with deployed clients, the server accepts a proposal whose cursor trails the device's acknowledged cursor only when the proposal's base main still matches and the complete intervening event range is retained and directory-neutral. The proposal payload and identity remain unchanged; directory intents are classified against the acknowledged explicit-directory snapshot as usual. Future cursors, intervening directory intents, or unavailable history remain rejected.

Historical reconstruction may reuse a newer acknowledged directory snapshot for an older target only when contiguous retained history proves that no directory intents intervened. The response cursor identifies the reused snapshot. Otherwise the server fails closed rather than pairing newer directory state with an older cursor.

## Consequences

- Neutral event advances no longer strand queued directory proposals or require a client rebuild.
- Already-deployed clients can recover through a narrow server-side compatibility path.
- Genuine directory divergence retains existing conflict behavior; incomplete evidence blocks automatic recovery rather than guessing.
- Event cursors identify directory-snapshot evidence, not a claim that the client observed every unrelated event.
- No HTTP shape or C4 boundary changes; the server behavior, sync contract, and composed synchronization model change together.
