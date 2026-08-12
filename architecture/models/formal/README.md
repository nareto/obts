# Formal Models

Formal models are bounded refinements of stable contracts in `architecture/contracts/`. They do not define product behavior independently. Protocol-changing code or architecture changes must update an affected model and its declared revision or explicitly retire it. Mechanical revision agreement does not prove semantic conformance.

## OBTS-FM-001: Local Apply And Recovery

| Field | Value |
| --- | --- |
| Status | Accepted bounded pilot |
| Architecture revision | 2 |
| Refined contracts | `OBTS-SAF-001`, `OBTS-SAF-002`, `OBTS-SAF-005` |
| Specification | `OBTSApplyRecovery.tla` |
| TLC configuration | `OBTSApplyRecovery.cfg`, `OBTSApplyRecoveryLiveness.cfg` |
| Executable check | `npm run test:formal` |

The model covers one client, one path, the captured local version, one concurrent local edit, a target server version, recovery staging/publication, mutation, verification, ref and coordination publication, acknowledgement intent, cleanup, one crash, and restart. Values stand for exact bytes plus path identity and provenance.

### Durability and fairness assumptions

`PublishInitialBundle` and `PublishPostWriteBundle` mean all required snapshots, manifest data, checksums, completion marker, and local-only Git closure have been flushed as supported, atomically published, remain discoverable after restart, and verify successfully. The model deliberately does not equate a successful filesystem Promise or rename with that guarantee.

Visible mutation, journal phase, reachable local Git versions, refs, coordination, acknowledgement intent, and cleanup are durable observations and move independently at their concrete durable boundaries. `running`, `recovering`, and `crashCount` are model control state; observed/overwritten sets are ghost state used to check preservation. A crash preserves whichever durable boundaries completed; restart enters explicit validation/classification actions that resume, roll a completed boundary forward, or block.

The liveness check uses weak fairness for protocol progress and bounds crashes to one. Safety does not depend on fairness. Terminal states stutter explicitly so deadlock checking remains enabled.

### Checked properties

- every captured or subsequently observed local version retains a preservation root;
- every displaced version was present in complete recovery evidence before mutation;
- active mixed states retain a discoverable journal and recovery evidence;
- cleanup cannot claim completion before refs, coordination state, and acknowledgement intent are durable;
- failed initial recovery publication before mutation is non-destructive;
- a started apply eventually finishes or blocks under the stated fairness and crash bound.

### Negative controls and promoted counterexample

The checker requires four deliberately broken configurations to fail:

- mutation before recovery publication;
- stale-preflight overwrite without revalidation at the mutation seam;
- early journal cleanup;
- restart inferring completion from an incomplete phase.

The stale-preflight trace was promoted to `tests/plugin-large-vault.test.ts`: target-byte loading triggers a concurrent local edit, and the implementation must revalidate the path immediately before mutation rather than overwrite it.

### TLC evidence

On `tla-tools` 1.7.4 / TLC 2.19 with one worker and fingerprint polynomial 0:

- safety: 237 generated states, 163 distinct states, depth 20;
- liveness: 237 generated states, 163 distinct states, depth 20;
- all four negative controls produced bounded invariant counterexamples;
- total runtime remained below one second per check on the evaluation host.

`check-formal-model.mjs` enforces a 60-second subprocess timeout, a 1 GiB Java heap, and fewer than 100,000 distinct states. Set `TLA2TOOLS_JAR` in CI to use a pinned downloaded JAR; otherwise the installed `tla2sany` and `tlc` commands are used.

### Implementation and evidence map

| Model boundary | Concrete implementation/evidence |
| --- | --- |
| `StartApply` / planned journal | `ObtsObsidianClient.applyTargetMain` publishes `.obts/apply-journal.json` before destructive work; phase/restart tests live in `tests/phase1.test.ts`. |
| `StageInitialBundle`, `PublishInitialBundle`, `RecordRecoveryPublication` | `stageRecoveryBundleFiles` and `finalizeRecoveryBundle` stage snapshots, manifest, Git closure, checksums, completion marker, rename, then journal the bundle ID. |
| `BeginWriting`, `WriteTarget`, `BlockChangedPath` | `writeTargetFilesFromJournal` atomically displaces each affected path into journal-addressed `.obts/apply-displaced` preservation, verifies displaced identity/content, and creates the target through Obsidian `Vault.createBinary` (documented to fail if the path exists) or Node `writeFile(..., {flag:"wx"})`; cleanup archives displaced inodes under `.obts/recovery-displaced` rather than deleting them. Stale-file, ancestor, directory, primitive-boundary, and restart races live in `tests/plugin-large-vault.test.ts`. |
| Post-write bundle actions | `localChangedPathsFromTree` plus `createRecoveryBundle` preserve edits detected after materialization before refs advance. |
| Ref, coordination, acknowledgement, cleanup actions | `updateRef`, `writeState`, `writePendingAppliedAcknowledgement`, and `clearApplyState` are separate durable calls. |
| `Crash`, `Restart`, recovery classifiers | `initialize`, `recoverIncompleteApplyJournal`, and `recoverBlockedApplyWithPreservedLocalChanges` classify persisted journal, visible tree, target commit, refs, and preservation evidence. |

### Known omissions

The model does not cover directories, multiple paths, write concurrency, editor-buffer capture, Git object structure, network/server acknowledgement, byte/checksum implementation, mobile lifecycle, process kill, power loss, filesystem semantics, corrupted finalized bundles, or competing client instances. Those require executable fault tests and platform evidence; a green TLC result makes no claim about them.
