# ADR 0010: Server-owned whole-vault deletion lifecycle

- Status: Accepted for architecture and formalization; production implementation forthcoming
- Date: 2026-09-10
- Architecture revision: 7

## Context

The dashboard needs a real destructive operation for deleting one server-held vault. Hiding a vault, deleting only a directory, or waiting for all work before publishing intent would permit new admissions or make an unavailable retry processor prevent durable acceptance. The operation must remain safe across asynchronous transfers, detached callbacks, partial filesystem failure, final metadata failure, and restart without changing the independent local/Bridge/backup boundary.

## Decision

Allocate a server-owned per-vault deletion coordinator. `OBTS-PER-DEL-001` is the explicit whole-vault lifecycle-record exception to ordinary `OBTS-PER-OP-001`; all ordinary sync/merge/ref-transition operations retain the prepared/CAS protocol. A valid authenticated owner request requires session CSRF and an explicit typed target phrase, with no password re-entry. Unknown and cross-owner resources remain indistinguishable 404 responses.

The coordinator closes target admission, durably publishes intent and access revocation, then wakes/cancels retryable target work and drains all pre-existing admitted, detached, and late work. It releases no callback ownership early: a detached callback cannot reuse an already released request/HTTP lease. Only after drain does it erase the exact attributable server Git/history, metadata, transfer/temp, device/connection/credential, and diagnostics residue. Each class is retried idempotently after finite faults or restart. Completion requires empty attributable residue and durable final metadata plus a minimal receipt. The receipt expires 30 days after completion; unfinished deletion state never expires, and completion/expiry cannot reopen or recreate the vault.

The lifecycle is active or integrity-blocked -> deleting -> completed receipt -> expired. Local client files, independent Bridge filesystem/PostgreSQL state, and backups remain untouched. The claim is logical application-data deletion under ordinary filesystem durability, not physical secure erasure.

## Formalization

`OBTS-FM-004` (`architecture/models/formal/OBTSVaultDeletion.tla`) is a focused bounded refinement. It models two owners/vaults, captured request identity and typed owner/target authorization, admission closure, durable intent/revocation/job ordering, observable response acceptance, one admitted and one detached work slot, five grouped server residue classes, finite erase/final-publication faults, crash/restart barrier restoration, blocked-integrity deletion, receipt expiry, and preservation boundaries. SANY runs before the corrected 29-check TLC matrix: four positive checks (normal deletion safety/liveness, blocked-integrity safety, and receipt-expiry liveness) plus 25 reachability/negative controls (nine reachability checks and sixteen negative controls). Reachability checks cover crash/restart, erase and final-publication faults, receipt expiry, blocked targets, pre-intent recovery, intent-publication failure, and response acceptance. Negative controls intentionally violate publication/response ordering, owner/target authorization and target capture, erase-before-intent, admission-after-close, premature completion, unfinished expiry, early lease release/late reuse, residue attribution, startup recreation, preservation boundaries, other-vault isolation, and ambiguous reopening.

The model uses three logical receipt-clock ticks as a bounded abstraction of the contractual 30-day interval. It does not claim wall-clock correctness, physical erasure, cross-process/distributed locking, or implementation conformance. Parent implementation work must add the concrete API/UI/coordinator allocation, subprocess/fault regressions, and runtime traceability.

## Consequences

- Durable intent/revocation is observable before the operation can report acceptance, while drain cannot block publication of the intent.
- Partial erasure and final publication failures remain retryable without reopening admissions or recreating resources.
- Receipt data is intentionally minimal and finite-retention; target-scoped historical rows are not an indefinite audit substitute.
- Existing local, Bridge, and backup data is explicitly outside the deletion boundary.
- Production implementation must preserve the model's ordering and promote its counterexamples to executable race/fault tests.
