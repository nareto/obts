# ADR 0016: Retire A Completed Legacy Directory Advance

- Status: Accepted
- Date: 2026-09-29

## Context

An older, withdrawn client implementation durably recorded `main_advanced` before writing a pull apply. The current directory-baseline validator intentionally no longer accepts that phase. An interrupted apply can subsequently complete correctly while the obsolete coordination journal and rejected upload checkpoint remain, preventing ordinary sync.

## Decision

Handle only completed legacy advances in a separate settlement before current-phase directory recovery. An outstanding apply journal remains exclusively owned by apply recovery. Prove the old pending commit is a content-empty child of the recorded base, that refs/cursors cover the applied target, and that the original delete is excluded by the target policy. Require matching immutable checkpoint identities, a complete verified pull transfer and a fresh server-device-ref proving non-acceptance of the old commit. Publish and verify a durable archive, then journal authorization before cancelling a matching open transfer or removing obsolete checkpoints or queue bookkeeping. Preserve newer queued descendants and changed-path hints; clear the obsolete journal last. Reuse the verified archive across restart even if timestamps, counters, or other non-authoritative fields churn, but never replace its digest or accept a changed stable fact. An authorized archive containing newer queued work binds settlement to that commit or a proven descendant, not an unrelated target descendant. Unrelated client errors, pending apply validation, and missing or changed stable evidence block.

## Consequences

- No general client-side stale-directory pivot is reinstated; current-phase validation remains unchanged.
- Visible edits and ignored directories are never removed during settlement. The regular sync path captures edits afterward.
- A matching open transfer is cancelled when possible; a processing or accepted transfer blocks. A missing/expired transfer or an acceptance racing cancellation still requires an unchanged fresh device ref. Its old commit is content-empty, and the new proposal's expected-device-ref CAS prevents silent overwrites; late acceptance requires ordinary retry or conflict handling.
- Archival and recovery ordering are normative; the runtime allocation and HTTP contract do not change.
