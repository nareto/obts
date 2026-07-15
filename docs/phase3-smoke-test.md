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

## Mobile Acceptance

Run this section separately on current iOS and Android Obsidian releases using
copied vaults. Mobile sync is foreground-only; do not expect the operating
system to keep Obsidian running in the background.

1. Install the release through BRAT and confirm Obsidian allows the plugin to be
   enabled without a desktop-only warning.
2. Complete browser-assisted onboarding against an HTTPS server and return to
   Obsidian. Confirm `.obts/git`, device state, and recovery state survive an app
   restart.
3. Sync Markdown, Unicode filenames, a binary attachment, an empty folder, and
   community-plugin data between mobile and desktop clients.
4. During existing-vault onboarding, create an overlapping edit, choose **Submit
   for merge**, and confirm the plugin replaces that action with explicit
   dashboard instructions. Resolve the conflict, return to the still-open modal,
   choose **Check resolution**, and confirm the resolved main is applied. Repeat
   from a force-closed/reopened app and confirm **Setup incomplete** offers
   **Resume setup** without creating another proposal or `stale_device_ref`.
5. Start with the phone offline, edit notes, restart Obsidian, reconnect, and
   confirm the queued local commit uploads without losing edits.
6. Force-close Obsidian during a disposable pull/apply test. Reopen it and
   confirm journal recovery either completes safely or blocks without replacing
   unpreserved local content.
7. Leave Obsidian in the background long enough for mobile timers to suspend,
   then foreground it and confirm scanning and sync resume without duplicate
   operations. Update the plugin while a disposable operation is active and
   confirm the replacement either waits for safe handoff or requires a full
   Obsidian restart; it must never clear the lease by elapsed time.
8. With diagnostic sharing still off, trigger a disposable error and confirm no
   diagnostic request or server record is created. Enable **Share error
   diagnostics with this obts server**, reproduce one failure, and confirm one
   sanitized report appears on the owner Settings page.
9. Confirm the report contains only fixed operation checkpoints and coarse
   runtime values, with no note content, vault/file names, paths, credentials,
   commit IDs, Git objects, pack bytes, messages, or stacks. Change the server
   URL and confirm sharing turns off. Delete all reports through recent
   authentication and confirm the list is empty.
10. Add more than 100 MiB of disposable files while keeping every individual
    file below the advertised object limit. Confirm the client reports
    **Preparing upload**, then uploads several bounded chunks without building a
    whole-transfer multipart body.
11. Force-close after the first chunk receipt, reopen, and sync again. Confirm
    the same transfer attempt resumes from its received-chunk list, advances the
    device ref once, and eventually appears on a second device. Force-close and
    reopen once more after the completed transfer; confirm the vault becomes
    interactive before background obts initialization finishes and subsequent
    sync can still read the imported history.
12. Leave one device without a fresh status report for over five minutes while
    another device advances main. Confirm the dashboard shows **Status unknown**
    or **Behind**, never **Synced**, until the stale device freshly reports its
    local main, local head, and idle queue after applying the canonical main.
