# Conflict Reviews Survive Unrelated Main Advances

- Status: accepted
- Date: 2026-10-19
- Deciders: OBTS maintainers

## Context

Until this decision, a conflict review package was stale as soon as server main moved past the main it was built on. Main moves whenever any device syncs, so an owner reviewing a conflict while other devices kept syncing could not resolve it. Each refresh rebuilt the package on the newest main, and the next sync made it stale again. Canonical history is append-only, so an advance that touches none of the reviewed paths changes nothing the owner reviewed.

The dashboard made the problem worse. Refreshing a review publishes an update event. The resulting dashboard refresh superseded the in-flight review refresh, discarded its result, and marked the old review stale again. Refresh review could therefore loop forever even on a quiet vault.

## Decision

A review package records the main it was reviewed on (`expected_main`) and stays current across main advances that do not touch what it reviewed. It is stale when:

- its directory context sequence changed;
- the reviewed main or current main is missing, or current main does not descend from the reviewed main;
- a path changed since the reviewed main intersects the affected paths or directory roots, the device's authored changes since its merge base with current main, or the root `.gitignore`.

When staleness cannot be determined, the package is stale.

Resolution of a current package applies on current main and never rewrites history. The server computes the reviewed candidate on `expected_main` and the applied candidate on current main. It rejects the submission with `stale_conflict_review` unless both make identical path changes to their main. The reviewed-tree check (`expected_tree`, `stale_conflict_preview`) stays bound to the reviewed candidate. The resolution merge commit has current main and the device commit as parents, and the prepared operation's expected main is current main. Labels derived from the reviewed main, such as insert-both headers, keep the reviewed main so the applied text equals the reviewed text.

The dashboard trusts the server's `stale` flag and compares reviewed mains; it no longer compares current main against the reviewed main. A conflict review refresh is registered as a manual refresh, so live updates it causes run afterwards as a trailing refresh. A dashboard snapshot requested before a review request cannot discard that review.

## Rejected Alternatives

- Keep exact-main staleness and only fix the dashboard loop. Busy vaults would still make reviews unresolvable while devices sync.
- Resolve on the reviewed main and rebase or rewrite later commits. That rewrites canonical history that devices have already applied.
- Auto-refresh stale packages in the background. The owner's draft would silently change under them, and a review would never be stable.
- Compare only affected paths. An advance can change the device's other authored paths, directory roots, or the root ignore policy, which would change the merge outcome without being visible in the review.

## Consequences

- A review stays resolvable while unrelated work syncs. A review goes stale only when the advance could change what the owner reviewed or what resolution applies.
- Resolution can land on a main the owner never saw. The applied change is still exactly the reviewed change, and the advance is preserved as an ancestor.
- Computing `stale` costs a few Git reads for each open conflict when a dashboard or conflict list is read. Verdicts are cached per conflict, reviewed main, and current main, within a bounded cache.
- `OBTS-FM-002` (`OBTSDistributedSync.tla`) still abstracts resolution as compare-and-swap from the conflict's recorded main. A resolution after an outside advance refines a trace in which the package is refreshed onto current main with an unchanged review, then resolved. The staleness rules ensure that such a refresh would not change the affected paths, contents, or directory context. Executable tests carry this argument; the bounded model is not extended.

## Implementation / regression mapping

| Seam | Implementation | Executable evidence |
| --- | --- | --- |
| Staleness verdict | `src/server/syncService.ts` `isConflictReviewStale`, `staleConflictReviewIds`, `reviewedMainAdvanceOverlaps`; `src/server/app.ts` `buildDashboardConflicts` | `tests/phase2.test.ts` outside-advance, overlapping-advance and refresh cases |
| Resolution on current main | `src/server/syncService.ts` `loadResolutionTarget`, `buildResolutionCandidate`, `sameTreeChanges`, `previewConflictResolution`, `resolveConflict` | `tests/phase2.test.ts` outside-advance resolution and changed-candidate rejection |
| Dashboard refresh ownership | `frontend/dashboard/src/App.svelte` `refreshConflictReview`, `refreshDashboardStatusNow` | `scripts/check-dashboard-browser.mjs` live conflict-refresh scenarios |
