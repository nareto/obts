# Divergent apply recovery assurance

Candidate: plugin 0.5.4, server 0.3.31 unchanged, architecture revision 24. Source base: `8863bcf44fca490be03d0ec054ceaf5ae317d7b0`. Full-suite and physical-device results are recorded at delivery; this is not a device-completion record.

## Problem

An interrupted apply whose journal reached `blocked_recovery` with `local_files_diverge_from_journal` was terminal. That category is recorded when an affected path matches neither the journal's recorded pre-apply state nor the target, which in practice is a note the user edited while the apply was suspended. Recovery refused the category, `recoverIncompleteApplyJournal` refused the blocked phase, and a new apply could not replace the operation, so the device stayed out of sync indefinitely while its edit had to be preserved.

## Change

`recoverBlockedApplyWithPreservedLocalChanges` now routes that category to `recoverDivergedApplyWithPreservedLocalChanges`, which validates the same journal evidence and completes the interrupted operation through the shared `completeInterruptedApply` path:

- paths that still match pre-apply or target state resume exactly as before;
- a path that matches neither holds user content: it is excluded from the write/removal set, and after refs advance it is captured in a `rebuild_from_server` recovery bundle and queued as a preserved local change for the next proposal. When the journal has no recovery bundle yet, the pre-write bundle created by the completion records the current bytes, including the diverged ones;
- an affected write or removal that is an ancestor or descendant of preserved content is deferred the same way, so replacing a directory around a preserved file no longer retries against its own descendant guard;
- a verified displaced entry stays valid evidence when resuming from the blocked phase, so a path that was displaced but not yet written is restored to the target instead of being treated as divergent;
- only paths that were already divergent, and paths conflicting with them, may remain behind: the completion revalidates after writing, and a new edit during the writes re-blocks the journal with a bounded category (`local_changed_during_apply` for a plain path, `local_files_diverge_from_journal` for a structural conflict).

Missing or corrupt evidence, policy mismatch and every other blocked category keep the previous behavior: the journal is preserved and the operation stays blocked. Late user edits are never overwritten, and the operation does not restart under a new identity.

The FM006 onboarding-recovery companion moves to revision 24 with a `DivergeEdit` action, a `divergence-preserved` positive check, a `divergence-reachable` witness that proves the divergent path is exercised, and a `discard-divergence` negative control that completes the apply while dropping the edit and must violate `DivergencePreserved`. The companion now runs twelve checks.

## Evidence

- `tests/onboarding-recovery.test.ts` reproduces the terminal state first: an interrupted apply, an edit on the affected path, restart one classifies `blocked_recovery` / `local_files_diverge_from_journal` and keeps the journal; restart two completes the apply at the target, keeps the edit byte-for-byte, leaves a `queued_local` proposal at `local_head`, and removes the journal. The diverged-recovery assertions fail on `8863bcf` and pass with the change.
- A second regression resumes a blocked journal where one path was displaced but unwritten and another diverged: the displaced path is restored to the target while the edited path is preserved and queued.
- A third regression covers the structural conflict: the target replaces a directory with a file while a child of that directory was edited, so the parent write conflicts with preserved content. The parent is deferred with the child, the local directory keeps the edit, the rest of the apply completes, and the preserved subtree is queued.
- The former `concurrent-edit` blocking-matrix case moved to the recovery test because that state is now recoverable; the remaining matrix cases (missing/corrupt recovery, checksum, policy, corrupt displacement) still block and preserve their evidence.
- The companion checker passes SANY and all twelve checks: safety, liveness and divergence-preserved each explored 357 generated / 232 distinct states at depth 22, divergence-reachable witnesses the divergent path at 47 generated / 37 distinct states depth 9, and the discard-divergence control reaches its violation at depth 10. Exact invariant/action witnesses and bounded exploration are enforced.
- `npm run check` and the versioned plugin build pass for plugin 0.5.4.

## Limits

The model abstracts symbolic paths, bytes and Git objects; it does not prove the concrete fingerprint, bundle or policy validators, filesystem durability, mobile suspension or power loss. The queued preserved file becomes an ordinary proposal after onboarding, so the server still classifies it normally (equal, covered or conflict) and no content is silently discarded. Physical iPhone recovery of the existing enrollment remains to be confirmed after the device updates to 0.5.4 and resumes.
