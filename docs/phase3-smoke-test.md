# Phase 3 Smoke Test

This smoke test proves a Phase 2-to-Phase 3 upgrade without exposing raw Git to
the note owner.

1. Preserve a running Phase 2 data directory containing a paired device, note
   edits, an event log, and—when practical—an unresolved conflict.
2. Stop Phase 2, capture metadata and all Git repositories consistently, deploy
   Phase 3 over the same state, and start it.
3. Confirm `/health/ready` is `ready`, existing devices and conflicts remain,
   and the existing note history can be queried in the dashboard.
4. Edit and rename a Markdown note from a paired client. Confirm History shows
   create/update/rename and merge provenance, source/rendered views, and device
   or user provenance where recorded.
5. Select an earlier version and restore it. Confirm `main` advances to a new
   commit and a paired client applies it through normal safe apply.
6. Sync a community-plugin data file. Confirm its history preview is redacted
   until the owner explicitly reveals it after recent authentication.
7. Export diagnostics. Confirm note bodies, raw paths, plugin bodies/settings,
   tokens, Git payloads, recovery content, and operation manifests are absent.
8. Run Git maintenance. Re-query and preview the earlier version, confirm open
   conflicts still have their commits, and confirm readiness remains `ready`.
9. Restore a deliberately inconsistent backup copy (for example, omit a
   required Git object or mismatch metadata and `main`) in an isolated test
   deployment. Confirm `/health/ready` returns `503` and history/restore are not
   served for the blocked vault.

Do not perform step 9 against the only production copy. Backup schedules,
destinations, and restore automation remain deployment concerns.
