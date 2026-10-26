# Directory Retention Checkpoint

- Status: accepted
- Date: 2026-10-26
- Deciders: OBTS maintainers

## Context

Git does not carry empty directories, so a vault's explicit-directory state exists only as the directory intents carried by its events. Rebuilding that state for any main other than the current one meant replaying every event from the first. Event retention removes events older than 30 days or beyond the newest 100,000. Once it had removed the first event, no older main could be rebuilt.

Onboarding pins one server target for the whole chunked transfer, and `OBTS-SAF-009` forbids dropping or retargeting that verified cursor. Main advances whenever any device or the Bridge syncs. On a vault older than the retention window, a new device whose transfer spanned one advance requested a main that was no longer current. Every later chunk then failed with `directory_snapshot_unavailable` ("not contiguous through the requested main"), and the device could never finish setup. The directory state itself was not lost: the server's live state was exact, and the retained events after the last directory change were all directory-neutral.

## Decision

The server keeps one directory checkpoint per vault, `directory_checkpoint_by_vault`: an explicit-directory snapshot and the event cursor it is exact after.

- Retention removes only a contiguous prefix of the vault's events. The same metadata transaction folds that prefix's directory intents into the checkpoint, using the same create-with-ancestors and delete-with-descendants semantics as the live state. The checkpoint never moves backward.
- If the checkpoint and the pruned prefix are not contiguous, the server withdraws the checkpoint instead of guessing. Historical reconstruction for that vault then fails closed, as it did before this decision.
- Historical directory snapshots, for both transfer targets and legacy device migration, replay the checkpoint plus the contiguous retained events through the target main's event. A target older than the checkpoint, or any missing event after it, fails closed.
- A device baseline older than the retained interval receives the net difference to the target snapshot. The current-main path already does this.
- At load, a store without a checkpoint for a pruned vault seeds one from the live directory state. Its cursor is the later of the live state's last directory-changing event and the newest pruned event. The live state is exact at every cursor from its last directory change onward, and at load no append is in flight. Seeding at the newest pruned event alone would claim later directory changes too early, so it is rejected.
- Deleting a vault removes its checkpoint.

The pinned transfer target, the plugin, and the API are unchanged.

## Rejected Alternatives

- Restart the transfer from the newest main when its target becomes historical. This discards a verified transfer cursor and checkpoint, which `OBTS-SAF-009` forbids; `OBTSOnboardingRecovery.tla` rejects it as `DropCheckpoint`.
- Retain directory-carrying events forever, or keep full per-event directory history. Storage stays unbounded for a fact that one snapshot captures.
- Infer historical directories from Git trees. Git cannot represent empty directories or right-click folder deletion (`OBTS-SAF-006`).

## Consequences

- A device can finish a chunked transfer on a busy, long-lived vault even if main advances during the transfer.
- Metadata grows by one directory list per vault. Retention does a little more work for each pruned event.
- A target older than the checkpoint is still unavailable. A device would need that only after more than a retention window of inactivity during one transfer.
- `OBTS-FM-002` gains the companion `OBTSDirectoryCheckpoint.tla` (revision 63). The composed model keeps its single retained-history flag, which this checkpoint now implements.

## Implementation / regression mapping

| Seam | Implementation | Executable evidence |
| --- | --- | --- |
| Prune and fold | `src/server/metadataStore.ts` `pruneVaultEvents`, `foldDirectoryCheckpoint` | `tests/directory-checkpoint.test.ts` fold, repeated fold, out-of-order retention and gap cases |
| Legacy seed | `src/server/metadataStore.ts` `seedDirectoryCheckpoints`, `normalizeLoadedDb` | `tests/directory-checkpoint.test.ts` seed after the last directory change, no seed while the first event is retained |
| Historical snapshot | `src/server/metadataStore.ts` `directorySnapshotAtEvent`, `metadataDirectorySnapshotForMain`; `src/server/app.ts` `eventSnapshotForTarget`, `checkpointedEventSnapshot` | `tests/phase1.test.ts` pinned chunked transfer across a main advance after pruning; `tests/directory-checkpoint.test.ts` missing retained event |
| Vault deletion | `src/server/vaultLifecycleCoordinator.ts` | `tests/device-removal.test.ts` whole-vault deletion |
