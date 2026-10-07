# ADR 0019: Make Apply And Capture Change-Proportional

- Status: Accepted
- Date: 2026-10-07

## Context

Steady-state sync cost grows with vault size and history instead of with the change. A client that is synced at A and needs B repeats work proportional to the whole vault: every sync runs a full metadata inventory, apply inventories the vault and collects directory metadata, post-apply stale capture walks the whole vault twice, and a changed local head forces another rescan. Git access separately degraded with the number of pulled packs. Writers that commit every few minutes, such as the Bridge's periodic notes, turn this into continuous full-vault work, and mobile clients take tens of minutes to settle. Many accepted pushes do not change canonical content seen by the pushing client, yet their acknowledgement still runs a full apply.

## Decision

Add OBTS-SYNC-DELTA-001. Apply visits the footprint of T over the authoring base M0: changed paths, their hierarchy, deferred, held and sticky paths and directory intents. Policy changes and an unsettled baseline widen it to the whole vault. Footprint paths are always re-read inside the adapter gate; outside the footprint apply neither reads nor writes. An empty footprint with equal trees is a ref-only apply that keeps the lock, committed journal and pending acknowledgement, but publishes no bundle and touches no file. Ordinary capture follows durable watcher hints; whole-vault inventory runs at startup, resume, invalid scan state, policy change, directory hints, on request and on a bounded schedule. Client Git maintenance consolidates pulled packs without deleting any unverified object.

The wording is permissive: the current full-vault behavior remains a valid refinement, so implementation can land in stages.

## Rejected Options

- Modeling tree equality in `OBTSDistributedSync.tla`: it keeps cumulative version sets per path and abstracts commit identity, so it cannot express the ref-only precondition without a state-space increase. A focused FM-002 companion with exact symbolic values checks it instead.
- Trusting scan caches or absent hints for footprint paths: the companion shows this loses a concurrent unhinted edit.
- Hint-only capture: a lost event would stay uncaptured indefinitely; the schedule bounds the delay.
- Ancestry bounded by the last checkpoint: merge parents can lie outside the checkpoint, so ancestry checks remain exact and are only memoized.
- Suppressing server merge commits for unchanged pushes as the primary fix: client cost is the bottleneck; a server fast-forward is a separate, later decision.
- Streaming transport first: it lowers latency, not per-change work.

## Consequences And Evidence

No HTTP, wire or persisted-format change. `OBTSDeltaApply.tla` checks `NoLocalEditLost`, `NoPhantomEdit`, `StaleBaseRetained` and `MissedEditBoundedDelay`, capture and convergence liveness, four witnesses, and three mutants for the forbidden shortcuts. Executable cost tests count vault adapter calls per scenario. Byte-identical edits invisible to metadata remain the full audit's responsibility. Watcher behavior on iOS backgrounding is not verified; the inventory schedule and resume trigger are the mitigation.
