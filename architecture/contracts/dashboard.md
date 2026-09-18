# Dashboard Contract

## Application Shell

The dashboard is a compact authenticated Svelte/Vite/TypeScript SPA served by the Fastify server. It is an operational application, not a marketing site or decorative analytics dashboard.

Primary navigation is Overview, Devices, Conflicts, History, Maintenance, and Settings. Status refreshes retain the selected vault for the authenticated user, but any remembered vault ID is revalidated against current ownership before use. The content header shows page title, selected vault/status context, unobtrusive refresh state, and practical primary/secondary actions without decorative controls.

Desktop uses a persistent 240px navigation rail with icon+label navigation and a clear active state, compact tables, and a scrollable content region. Below the responsive breakpoint the rail becomes a touch-sized drawer with a backdrop, close/Escape behavior, focus return/trapping, background scroll suppression, and no interaction with inert content. Technical identifiers are monospace, truncated by default, copyable, and never the primary human explanation.

## Request Ownership

Changing vault clears its review/history content and scoped actions before loading the next vault. Account transitions additionally clear account-scoped presentation state. Dashboard snapshots, conflict reviews, history responses, and vault/device mutation completions must not repopulate another account or vault. Newer status snapshots invalidate pending older review requests; changed or unavailable conflicts preserve an open draft only as non-submittable stale content. Successful renames supersede older dashboard snapshots. Polling does not supersede an active manual refresh or reset an unchanged conflict draft.

Sign-out clears the local view immediately and blocks another sign-in until its request finishes. A failed server sign-out is reported as incomplete and offers retry; the UI must not imply that the remote session was terminated successfully.

## Status Vocabulary

Statuses combine text and icon; color is never the sole signal.

- **Success:** Synced, healthy, complete.
- **Active/information:** Uploading, Applying, Checking, Verifying contents, Preparing upload, Merging, Server retrying, Repairing baseline, Finishing update.
- **Warning:** Ahead, Behind, Offline, Status unknown, Review needed, Stale review.
- **Danger:** Blocked, Needs recovery, Unsafe local state, Integrity failure.

Long-running local work remains an active truthful operation with elapsed/detail information. It does not become Offline solely because local processing took time. Device convergence comes from fresh server/client reports, not browser-side aging guesses.

## Overview And Devices

Overview summarizes synchronization, unresolved conflicts, paired devices, readiness, attention items, recent activity, maintenance, and backup contract state. Its four summaries are a compact adaptive status strip, followed by independently sized Devices/Attention and Activity/Maintenance columns; informational content remains available without stretched empty panels. Devices are shown in a concise operational table with name/status as the primary explanation, plugin version versus server recommendation, human relative times with exact accessible timestamps, ahead/behind state, and touch-sized actions. Expandable technical details retain identifiers, cursors, local detail, and exact report timestamps. A compact Overview table variant may omit secondary columns, while the Devices page keeps the full operational view. Status always combines readable text and icon; plugin mismatch is understandable without color alone.

Device revocation is a danger action with explicit confirmation. Rename changes server display metadata only and does not rename a physical vault folder.

## Conflict Workbench

The conflict queue identifies path, named device, type, created time, status, and action. The review workbench provides affected-file navigation, provenance, server revision, named-device revision, rendered/source comparison, structural Base/Server/Device paths, directory outcomes, and available resolutions.

Every diff and resolution choice must identify **Server main** and **Device: <display name>** persistently and accessibly. Meaning cannot depend on red/green color, `+`/`-` familiarity, or an earlier caption. Keep-both ordering and manually prefilled content provenance are explicit.

A stale package blocks submission and makes refresh the primary action. Before a consequential submission, the UI states the complete scope of the choice. Conflict resolution uses the authenticated session and CSRF token without password re-entry.

Any future short-window reversal is governed by an accepted RFC and `OBTS-SAF-007`; no UI-only ref reset qualifies as undo.

## History

History selects a vault path, lists canonical versions and provenance, and presents source or rendered comparison according to file kind. Restore is disabled until a version is selected and clearly states the target. Sensitive plugin bodies remain redacted until an explicit owner action.

Restore advances history; it does not rewrite it.

## Maintenance And Settings

Maintenance presents checklist rows for metadata/database, Git store, temporary workspace, migrations, native Git, permissions, event delivery, and backup contract. Actions explain blocking state and preserve the dashboard/repair surface when one vault is integrity-blocked.

Settings exposes consented redacted diagnostics and account/session actions. Confirmation dialogs state target and consequence. An active authenticated session is not interrupted by username/password re-entry; high-impact destructive intent uses an operation-specific typed phrase.

### OBTS-DASH-DEL-001: Truthful Whole-Vault Deletion Workflow

Settings presents deletion as a server-scope destructive operation using the name and full vault ID in the typed phrase `DELETE <vault_id>`. The dialog states that server Git/history, metadata, transfers/temp material, devices/tokens/connections, and vault diagnostics are deleted, while local client files, independent Bridge state, and existing backups remain untouched. It distinguishes accepted/deleting from completed and never reports content gone from a `202` response.

Pending deletion remains visibly `Deleting` and discoverable after reload/reconnect. Completed vaults leave ordinary selection and may appear only as a minimal recent receipt for 30 days after completion. An unfinished deletion never expires at that receipt deadline. Receipt expiry means not-found and never recreates or reopens the vault. Status/list results are owner-scoped and expose no retained names, paths, commits, content, credentials, or diagnostics.

## Visual Constraints

Use a strong sans-serif UI stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif) and monospace identifiers, compact 13–14px table/body text, 24px page titles, a 4/8/12/16/24/32px spacing scale, one-pixel panel borders, restrained 8–12px radii, warm off-white/deep-ink/teal light tokens, and a matching dark theme with theme-appropriate primary-button foregrounds. New shell transitions respect reduced-motion preferences; breakpoint changes keep keyboard focus on a visible, non-inert control. Avoid nested card grids, heroes, marketing copy, illustrations, gradients, oversized decorative typography, and color-only status meaning. This visual presentation contract does not change polling cadence, API/protocol behavior, conflict draft preservation, or server-derived convergence truth.
