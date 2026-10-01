# ADR 0018: Serialize In-App Writers Through The Adapter Gate

- Status: Accepted
- Date: 2026-09-30

## Context

Apply's private scheduler does not exclude editor autosave, Obsidian core or other plugins between final comparison and asynchronous overwrite/removal. Verified pre-image copies preserve A, not a new B written at that seam. Keeping the live note avoids editor tab rebinding but does not make compare/write atomic. Separately, a saved buffer authored on A can land after C and be recommitted with parent C; using that parent as merge base silently replaces remote work. Equal-device-ref retries also currently lose an explicit proposal base.

## Decision

Refine OBTS-SAF-002 with same-adapter exclusion, not an external-filesystem guarantee. A shared per-adapter owner/refcount gate wraps present mutators before entering the host adapter queue, uses normalized case-insensitive equal/ancestor claims, atomically acquires multi-endpoint footprints, fairly serializes conflicting claims and permits independent siblings. Only `.obts` internals bypass it. Installation precedes recovery and drains pre-admitted work; unload restores descriptors conditionally or makes orphaned wrappers pass-through. Apply holds final raw freshness compare through raw mutation completion; raw captures are never previous wrappers, Vault calls or awaited global bypass flags. Pre-image publication remains outside, guarded again inside. All mutation/recovery/restore seams use the gate, with expected-state protection for restores. Crash releases volatile claims.

Journal M0 and touched hierarchy before mutation. Durably retain a post-apply horizon until at least three seconds after the last mutation AND a subsequent adapter-queue drain; crash keeps it active conservatively. Touched-path deferrals and horizon saves retain M0. Sticky path/base/generation obligations keep the oldest unsettled base until the latest generation is server-settled and its result applied, or handed to existing conflict rules. Persist and protect intent/base before commit creation, queue publication and journal cleanup; every retry/rebuild/repair keeps it.

Build D parented on C as C plus only stale cohort bytes/absences, using a partial-tree helper and existing scalar `base_commit=M0`. Hold known-fresh/non-stale work for sequential ordinary settlement with the then-current base. Keep accepted/intermediate no-upload and catch-up guards. The server derives device-authored paths from natural merge base K, uses explicit M0 only as their three-way ancestor, filters per-path identical main/device overlaps before divergence classification, and immutably binds the original base before device-ref movement for every retry. No client content merge or HTTP extension is introduced. Compatibility is byte-identical when base=K, not a claim that every current initial flow has that equality: re-pair can reuse D2 atop already-integrated D1 with recorded/sent M0 older than K=D1. The older explicit ancestor remains legal; inherited D1-only paths no longer generate false conflicts, while D2-authored paths retain conservative three-way merge/conflict behavior.

## Rejected Options

- Removing awaits does not make asynchronous storage comparison/mutation atomic; `vault.process` alone neither gates other writer methods nor covers deletion/hierarchy seams.
- Renaming a live file into hidden evidence rebinds editor tabs; keep verified-copy/in-place updates instead.
- Reentrancy bypass flags span awaits and admit unrelated writers; captured raw methods provide explicit non-reentrant capability instead.
- Per-path-base HTTP protocol widens scope; sequential truthful cohorts use the existing scalar base. A global older base over mixed origins hides known fresh reverts and conflates intent, so it is rejected without cohorts.

## Consequences And Evidence

Runtime component allocation and wire shape stay unchanged; this is an internal synchronization/provenance responsibility of apply/recovery and existing server integration. Contracts OBTS-PER-GATE-001, OBTS-PER-STALE-001, OBTS-SYNC-STALE-001, OBTS-SYNC-BASE-001 and OBTS-VER-GATE-001 define the normative details. FM001's gate and provenance companions connect preservation to server integration; required controls expose gate-off, external writers, wrong base, lost cleanup provenance, null retry and mixed-origin bugs.

External writers, pre-captured/private adapter bypasses, watchdog continuation, unobservable same-metadata events, unverified native/iOS behavior and unbased legacy queues remain named residuals. The bounded horizon is conservative, not proof of editor reload. Legacy journals use recorded pre-apply canonical bases; do not invent a base for old queues. This architecture stage does not claim production implementation conformance; executable fault and real-device evidence precede rollout.
