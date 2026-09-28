# ADR 0015: Resolve Superseded Directory Baselines Client-Side

- Status: accepted
- Date: 2026-09-28
- Refines: OBTS-SYNC-DIR-002
- Issue: bnh/obts#23
- Supersedes: none; extends ADR 0014

## Context

Issue #24's fail-closed branch protects a device whose directory proposal base can no longer be proven because real directory changes happened on the server between its baseline and the proposal. When that happens, the device holds a queued directory-intent commit and can neither push it (the baseline is unprovable) nor pull forward (a pending commit is present). The client's recovery journal stays in `planned` and every maintenance tick fails with `directory_baseline_recovery_unsafe`. The device is wedged until an operator acts.

Observed live on a production headless bridge device (`dev_01M37AS2T2CHFAEEQ9MF`, vault `vlt_01M34MVS6VK964BD4968`): the queued intent (delete `.smart-env`, base event 623) was superseded by the owner's server-side conflict resolution (event 626, main `c2e44faf → be451b17`, same deletion applied server-side). The existing one-shot commands do not fit this state:

- `replace-local-with-server` refuses it (gated on `replace_local_with_server_required`);
- `rebuild-from-server-main` classifies the pending commit as `fast_forward` and preserves the poisoned commit, so the next push fail-closes with the same `stale_directory_proposal_base`;
- `reset-local-pairing` works but requires re-onboarding;
- the server dashboard has no conflict surface for this failure class at all.

## Decision

Extend the client's `recoverStaleDirectoryProposalBase` flow with a deterministic resolution branch for exactly this case, keyed on the recovery proof pull returning a well-formed historical snapshot whose event cursor is provably behind the device cursor:

1. **Gate.** The pivot only runs while the journal is in phase `planned` (nothing has been proven or acknowledged yet) and only when the queued pending commit is content-empty relative to the rejected base (`sameCommitTree`).
2. **Pull forward.** The client requests `latest` (after retiring the proof pull's completed transfer checkpoint, which the device state provably covers), then validates that the current server main is a linear descendant of the rejected base, exists locally, and carries sane cursors.
3. **Record.** The journal moves to phase `main_advanced`, recording `target_main`, the advanced explicit-directory snapshot, and the advanced event cursor before any state mutation.
4. **Apply.** `applyTargetMain` materializes the new server main (which preserves local content and directory work under the existing contracts), moves both refs, and writes the applied-snapshot acknowledgement.
5. **Rebuild.** The directory intents are rebuilt from the current disk state against the new snapshot: satisfied intents disappear (their goal already holds server-side), satisfiable intents are rebased onto the new main with a fresh base, and the flow then re-enters the normal sync tail (checkpoint removal, queue reset, error clear).

Any precondition failure — content in the queued commit, divergent server history, a bad manifest — fails closed exactly as before.

## Constraints

- No device-side user interaction, ever. Escalation only reaches the existing server-side conflict machinery and dashboard review.
- Dropping an intent is permitted only when the server state provably already satisfies it; content changes are never discarded by this flow.
- Fail closed remains the fallback when evidence is missing or ambiguous.

## Consequences

- Devices stuck in this wedge self-heal through the normal maintenance loop with zero operator action and zero data loss.
- The old content-empty proposal commit becomes unreachable; its objects remain inert in the local object database.
- Content-bearing pending commits still fail closed (distinct error message) — extending the flow to rebase content is future work.
- Formal model: the `stale-baseline` fixture chain in `OBTSDistributedSync.tla` proves content is never destroyed and the settle is deterministic, with the content-pending fault variant proving the fail-closed branch.
