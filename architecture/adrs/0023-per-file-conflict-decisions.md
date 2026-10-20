# Per-File Conflict Decisions

- Status: accepted
- Date: 2026-10-20
- Deciders: OBTS maintainers

## Context

A conflict package can cover many files, but resolution accepted one kind for the whole package. The dashboard matched that with one mode switch and one policy select. To keep the server version of one file and the device version of another, the owner had to switch to line-by-line mode and choose every changed line in every file. That workaround did not work for binary or large files, which have no lines, so a package containing one binary file could only be resolved all one way.

The owner thinks about a conflict file by file. The resolution contract should let each file carry its own decision, and the toolbar choice should set every file at once rather than be the only way to decide.

## Decision

Resolution accepts `resolution_kind: per_file` with a `per_file` list. Each entry names `paths`, a `choice` (`keep_server`, `use_device`, `keep_both_files`, `insert_both_blocks`, or `manual`), and, only for `manual`, a `manual_file_plan` limited to its own paths. The server builds the final tree from those decisions in the same way it builds the plain kinds, so binary bytes are still copied from Git objects and never pass through the browser.

A decision unit is the smallest set of paths that can be decided apart without inventing a state that neither side wrote:

- the paths of one rename or path-collision group form one unit;
- a file and a path beneath it form one unit;
- every other affected path is its own unit.

The server rejects a `per_file` request unless every affected path appears in exactly one entry and no entry splits a unit. Directory and mixed file/directory conflicts do not offer `per_file`; they stay a whole-package server or device choice.

In the dashboard, every unit starts undecided and has its own choice: server, device, line by line (ordinary text only), keep both, insert both blocks (non-binary), or edit final content (non-binary, non-large). Line-by-line and edited units are submitted as `manual` entries with complete final content. A progress count and `Next undecided` lead the owner through the package. `Review result` stays disabled until every unit is decided, and Apply still requires a matching reviewed preview. `Set all files` in the toolbar sets every unit to server or device. A uniform whole-file choice is submitted as the plain kind, so existing previews, logs, and idempotency keys are unchanged for the common case.

## Rejected Alternatives

- Keep one package-wide kind and improve line-by-line. Binary and large files still could not be split, and choosing every line is slow for whole-file intent.
- Build the final tree in the browser and always submit `manual`. Binary content would need to be uploaded back to the server, and the server would lose the provenance of each file.
- Let each path be decided independently even inside a rename group. A rename decided half one way and half the other produces a tree with both names or neither, which neither side wrote.
- Keep a separate whole-conflict mode next to per-file controls. Two places to decide the same thing hide which choice wins; one bulk action that sets the per-file choices is clearer.

## Consequences

- Owners can resolve mixed packages, including binary files, without line-by-line work.
- The preview and resolution request carry more data. The resolution idempotency hash covers the `per_file` entries, and the dashboard's reviewed-candidate key includes them, so changing one file's decision invalidates a reviewed result.
- Operational logs record `per_file` as the resolution kind. Per-entry choices are not logged, because they can name private paths.
- The bounded TLA+ model abstracts resolution as one compare-and-swap of a reviewed candidate tree. Per-file decisions change only how that candidate is built, so the model is unchanged.

## Implementation / regression mapping

| Seam | Implementation | Executable evidence |
| --- | --- | --- |
| Request contract | `openapi/openapi.yaml` `PerFileResolutionEntry`; `src/server/app.ts` `readPerFileResolution`; `src/shared/types.ts` | `tests/openapi-contract.test.ts` |
| Decision units and candidate tree | `src/server/syncService.ts` `validatePerFileDecisionUnits`, `buildResolutionArtifacts`, `buildManualFilePlanChanges` | `tests/phase2.test.ts` per-file and rename-group cases, directory rejection |
| Dashboard units and submission | `frontend/dashboard/src/conflictDecisions.ts` `buildDecisionUnits`, `decisionCapabilities`, `unitStatus`, `perFileSubmission` | `tests/conflict-decisions.test.ts` |
| Workbench controls | `frontend/dashboard/src/components/ConflictWorkbench.svelte` | `tests/conflict-workbench-ui.test.ts`; `scripts/check-dashboard-browser.mjs` per-file, binary, and line-by-line scenarios |
