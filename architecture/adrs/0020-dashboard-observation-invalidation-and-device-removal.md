# ADR 0020: Dashboard Observation, Invalidation, And Device Removal

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decision owners:** Product owner / architecture
- **Architecture revision:** 55

## Context

Dashboard requests currently share expensive readiness and metadata paths; owner-visible updates need timely propagation without introducing a second durable event authority. Device credential revocation must remain distinct from erasing the revoked device's server-side identity and ref. Routes and asynchronous refreshes also need an explicit scope/draft ownership contract.

## Decisions

1. Dashboard and maintenance health use a server-owned single-flight sample of completed deep readiness checks. The initial and five-minute-default periodic sampler run independently of UI reads. Explicit readiness remains fresh and shares in-flight work. A health snapshot is observation only and must report freshness honestly; current authoritative failures override cached results. Session reads revalidate authoritative user/session state every time while coalescing last-seen durability to at most once per minute. Heartbeats do not prolong idle sessions.
2. One same-origin owner-session SSE endpoint sends a fixed refresh-on-connect event and bounded live invalidations after durable metadata publication. It is not a second durable event history and never replaces existing per-vault durable sync events/cursors. Send-time authorization, bounded subscriptions/backpressure and teardown are required. In-flight refreshes retain a trailing invalidation obligation.
3. Device revocation shuts down credentials only. Permanent removal requires a durable per-device intent, barrier and drain, exact ref expected-OID CAS, conflict/prepared-work rejection, and explicit stronger confirmation for unmerged-work discard. Each expected OID is immutable within its durable attempt generation; if admitted work advances the ref during drain, retain the barrier and publish a new attempt generation against a newly verified OID rather than rebinding the old attempt. Startup resumes removal before integrity/recovery can misclassify the missing ref. Completion waits for attributable cleanup; no force-prune/history rewrite occurs. Whole-vault deletion dominates.
4. Dashboard URLs own route/scope state; transitions use account/vault generation guards. Same-scope drafts survive background refresh, while stale conflict drafts remain non-submittable and consequential dirty drafts cannot be silently discarded.

## Consequences

- Reconnect consistency comes from a fresh authorized snapshot, not replay of an invalidation ledger.
- Health UI is not authorization, sync admission, or a promise of verified current health when stale/unavailable.
- Revoked device records remain inspectable/retryable until durable removal completes; merged canonical history and unrelated identities remain intact.
- The bounded models remain design evidence only; conformance of the implementation rests on the executable evidence mapped below.

## Bounded model boundary

`OBTS-FM-016` checks a health-sample freshness projection, a counted single-flight sampler with an overlap mutant, a bounded persisted-liveness interval with a throttle mutant, post-commit invalidation, captured-revision refresh responses, reconnect obligations, trailing refresh, and owner isolation. The device-removal companion checks covered and unmerged branches, an admitted detached callback that may advance the ref or create conflict after intent, per-attempt expected-OID CAS and retry generation, intent/barrier ordering, separate credential/replay and attributable-residue cleanup, crash/restart after ref deletion with barrier restoration before readiness, canonical/other-device preservation and owner isolation. Exact mutations challenge stale-health projection, overlapping samplers, excess liveness writes, precommit notification, fabricated refresh freshness, lost trailing refresh, missing intent, skipped drain/conflict/prepared/unmerged/CAS gates, early completion, preserved state, and owner scope. These bounded symbolic transitions do not prove real HTTP/SSE framing, wall-clock scheduling, metadata/Git durability, strict absent-vs-error ref lookup, actual CAS/fsync, callback/lock ownership, residue/path safety, whole-vault deletion arbitration, browser navigation, or implementation conformance; executable fault tests remain required. Focused executable fault and integration tests remain mandatory.

## Implementation / regression mapping

| Contract/model seam | Implementation | Executable evidence |
| --- | --- | --- |
| Dashboard read projection and session touches | `src/server/readinessSampler.ts` single-flight sampler; `src/server/app.ts` dashboard/readiness routes; `src/server/authService.ts` `authenticateSession`; `src/server/metadataStore.ts` `read` / `readOrMutate` | `tests/readiness-sampler.test.ts`, `tests/dashboard-health-cost.test.ts`, `tests/session-auth-cost.test.ts` |
| Commit-bound invalidation and stream lifecycle | `src/server/metadataStore.ts` post-commit publication; `src/server/dashboardEvents.ts` impact projection and owner-scoped SSE hub; `GET /api/v1/dashboard/events` in `src/server/app.ts` | `tests/dashboard-events-hub.test.ts`, `tests/dashboard-events-http.test.ts`, `tests/openapi-contract.test.ts` |
| Refused/removal lifecycle | `src/server/deviceRemovalService.ts` durable intent, fence, drain, expected-OID ref CAS and restart recovery; `src/server/vaultLifecycleCoordinator.ts`, `src/server/gitService.ts`, `src/server/chunkTransferService.ts`; sticky revocation in `src/server/metadataStore.ts` | `tests/device-removal.test.ts`, `tests/device-revocation-invariant.test.ts`, `tests/git-ancestry-verdict.test.ts` |
| Routes, draft ownership and live refresh | `frontend/dashboard/src/router.ts`, `liveUpdates.ts`, `refreshScheduler.ts`, `App.svelte` and device/removal components | `tests/dashboard-router.test.ts`, `tests/dashboard-live-updates.test.ts`, `tests/dashboard-refresh-scheduler.test.ts`, `tests/dashboard-presentation.test.ts`, `scripts/check-dashboard-browser.mjs` |
| Bounded models | `architecture/models/formal/OBTSDashboardProtocols.tla`, `OBTSDeviceRemoval.tla` | `npm run test:formal:dashboard-protocols`, `tests/formal-dashboard-protocols.test.ts` |
