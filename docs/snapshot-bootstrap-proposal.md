# Snapshot bootstrap proposal

Status: partially accepted; see ADR 0012, `architecture/adrs/0012-durable-early-onboarding-disposition.md` (architecture revision 18). The early disposition runtime increment is implemented; the server-prepared bounded bootstrap artifact stays future work in the section below.

## Observed setup behavior

`ObtsOnboardingModal.renderStart` opens the browser only after `startOnboarding` computes `localSnapshotSummary`. That summary inventories the vault and reads/hashes every syncable file. After approval, `analyzeOnboarding` repeats the summary. Non-empty existing-vault analysis then downloads/imports Git packs and compares trees before `renderConfirmation` offers use-server versus merge. Finishing setup computes another summary before recovery and registration.

The empty-file branch already avoids pre-registration remote bootstrap. A vault with no notes may still contain syncable Obsidian configuration and other plugins, so it does not necessarily take this branch. Existing tests cover a physically empty directory, not the full fresh-mobile-vault experience.

Current bootstrap packs contain reachable history, not only current files. Mobile transport and storage expose whole-response/whole-file buffers. A monolithic ZIP is therefore not a demonstrated streaming or bounded-memory solution. The diagnostic reader's 256 KiB limit does not limit the actual apply-journal reader and is not evidence of a recovery failure cause.

## Recommended interaction

1. Choose local-content disposition on the first setup screen, before opening the browser: replace from an existing server vault, or preserve/merge/create using the current flow.
2. Persist that intent independently of registration/submission state. Use a cheap metadata/occupancy check for a non-empty warning; do not hash local files or fetch remote history merely to present the choice. Exact counts are not necessary for the warning.
3. After approval, show the selected server vault identity and replacement scope before any destructive work. Replacement bypasses ancestry/equality classification. New-server-vault selection cannot silently turn replacement intent into an upload or deletion; the UI must require switching to the existing create flow.
4. Show actual download, installation, catch-up and paused/resuming progress. Browser approval is not the appropriate label once authorized work starts.

## Recommended implementation boundary

Implement the early replacement route first, then a server-prepared, immutable bootstrap artifact for that route. Retain the existing merge/create path. Negotiate support explicitly; an old server must not silently reinterpret destructive consent.

Deliver bounded independently usable archive parts with a durable manifest/plan, hashes, compressed and expanded limits, and a pinned Git target, root-ignore identity, directory/event baseline and device/vault binding. Prepare reusable Git pack indexes on the server where compatibility can be validated, rather than re-indexing every downloaded pack on the phone. Stage imported data and materialized files with checkpoints; do not extract arbitrary archive paths into the live vault. Keep credentials and client coordination state locally authored.

The first implementation should retain the Git object availability expected by ordinary sync. Current-files-only transfer is a separate partial-history protocol decision: ordinary `rev-list target ^have` pulls can omit historical objects absent from a snapshot-only client, including blobs reused by a later revert. It requires explicit missing-object/delta semantics and ancestry/recovery compatibility tests. A ZIP plus fabricated refs is insufficient.

Checkpoint completed download units and verified installation batches. A restart should reuse their durable progress and repeat at most the interrupted unit, rather than restarting setup or repeating classification. Preserve existing enrollment-before-bulk-transfer, recovery-before-replacement, acknowledgement and catch-up/activation boundaries. File integrity, safe paths, case collisions, local-write collision checks and resource bounds remain necessary. Background execution is not assumed; progress continues when the host resumes the plugin.

## Product decision before implementation

Recommend replacement of syncable visible contents while retaining OBTS runtime/internal state and ordinary ignored local files, with recovery of existing affected content before replacement. The requested phrase "completely remove local vault" could instead mean deliberate irreversible discard, including ignored content. That is materially different from the existing use-server contract and must be decided explicitly. Do not delete local content before authorization, artifact validation and the selected preservation boundary.

## Architecture and validation

This changes OBTS-SYNC-ONB-001 and potentially persistence/allocation and HTTP contracts. Review OBTS-SAF-001/002/005/006/009/010 and OBTS-SYNC-ACK-001. Update the affected contracts and FM-006 model/checks before implementation; review FM-001/FM-002 for installation/recovery changes. Update OpenAPI, traceability and the architecture revision with accepted changes. This proposal does not change normative contracts.

Required evidence includes:

- Fresh vault with normal Obsidian/BRAT files: replacement choice before browser, no body hashing or Git bootstrap to decide replacement; existing merge/create behavior remains covered.
- Restart after approval, registration response loss, each download unit, final checkpoint and installation batch; no duplicate device, repeated completed bulk transfer, false completion, or loss of consent scope.
- Corrupt/oversized archives, unsafe members, wrong target/device, root-ignore and directory effects, local edits during setup, storage failures and moving canonical main.
- First local edit/upload and later ordinary pulls, including historical-content reuse if partial-history support is proposed.
- Real iOS foreground responsiveness, peak memory, lock/app-switch suspension and resume. Mock adapters alone do not establish these results.

Implemented increment (ADR 0012): the modal start screen offers keep-local versus replace-from-existing-vault before the browser request; the disposition and its content fingerprint persist in the local onboarding journal (`pending_summary`, `early_disposition`); an approved existing-vault selection under replacement consent goes directly to a replacement confirmation and finishOnboarding without pre-registration classification or remote bootstrap; a browser new-vault selection renders a durable terminal mismatch screen requiring explicit restart. Registration, recovery-before-replacement, consent-fingerprint revalidation, catch-up, and activation are unchanged. FM-006 gains the PublishConsent boundary, ConsentBeforeRegistration invariant, and RegisterWithoutConsent negative control with updated states.

Further implementation (bounded server artifact, reduced-history snapshot baseline, mobile materialization checkpoints) stays future work per the boundary section above.

Investigation used source and existing test inspection only; executable regressions and the FM-006 model rejection were later added in the accepted increment. Real-device evidence remains an open obligation.
