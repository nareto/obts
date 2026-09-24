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
- **Warning:** Out of sync, Ahead, Behind, Offline, Status unknown, Stale review.
- **Danger:** Conflict resolution needed, Out of sync — file exceeds upload limit (blob), Out of sync — upload limit exceeded (other Git object), Out of sync — local recovery required, Blocked, Needs recovery, Integrity failure.

### OBTS-DASH-STATUS-001: Truthful Local Sync Failure Presentation

“Unsafe local state” is not an active user-facing status, including for persisted older reports. A pending upload, retry or deferred local edit is out of sync, not a conflict or evidence of corruption. “Conflict resolution needed” is reserved for an actual unresolved server conflict. Recovery required means automatic safe continuation could not be established and must identify the reason and supported next action; unknown failures remain neutral and show a bounded safe code without promising that all work was uploaded or independently preserved. Transfer size failures show the actual limit and locally available object size, type, version, and path when known; historical objects without a current path are identified honestly. Oversized-object paths, object OIDs, exact object sizes, content and arbitrary exception messages stay local, never in shared status or diagnostic telemetry. Commit-reference OIDs already carried as device sync cursors (`local_main`, `local_head`) remain available in authenticated dashboard details; they must not be confused with the oversized-object OID. Legacy error codes remain interpretable and old status labels are normalized at presentation boundaries.

Long-running local work remains an active truthful operation with elapsed/detail information. The shared dashboard displays coarse progress (10% buckets) rather than exact client-reported counts; exact progress stays local. It does not become Offline solely because local processing took time. Device convergence comes from fresh server/client reports, not browser-side aging guesses.

### OBTS-DASH-IGN-001: Advanced Root-Ignore Editing

The plugin's Advanced view edits the shared vault-root `.gitignore` as a normal user file, not a hidden server policy. It shows the current bytes, local-only effect on already tracked paths, and a preview under the same full Git matcher used for scanning. Save rechecks the file's original identity and refuses to overwrite concurrent edits; failure preserves the draft. Creating, editing or deleting the file uses normal local capture and immutable proposal flow. The editor does not silently rewrite rules, delete matched local files, truncate queued history, or promise that changing a rule fixes an oversized object already in queued ancestry. If this client or server cannot safely interpret or activate the policy, editing/sync blocks with an explicit update action rather than producing a scanner-only partial result.

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
