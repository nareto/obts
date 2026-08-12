# Dashboard Contract

## Application Shell

The dashboard is a compact authenticated Svelte/Vite/TypeScript SPA served by the Fastify server. It is an operational application, not a marketing site or decorative analytics dashboard.

Primary navigation is Overview, Devices, Conflicts, History, Maintenance, and Settings. The current vault selector is persistent across refresh for the authenticated user, but any remembered vault ID is revalidated against current ownership before use. The content header shows page title, selected vault/status context, refresh state, and at most one primary action.

Desktop uses a fixed navigation rail, compact tables, and a scrollable content region; below the responsive breakpoint it uses one-column layouts and touch-sized controls. Technical identifiers are monospace, truncated by default, copyable, and never the primary human explanation.

## Status Vocabulary

Statuses combine text and icon; color is never the sole signal.

- **Success:** Synced, healthy, complete.
- **Active/information:** Uploading, Applying, Checking, Verifying contents, Preparing upload, Merging, Server retrying, Repairing baseline, Finishing update.
- **Warning:** Ahead, Behind, Offline, Status unknown, Review needed, Stale review.
- **Danger:** Blocked, Needs recovery, Unsafe local state, Integrity failure.

Long-running local work remains an active truthful operation with elapsed/detail information. It does not become Offline solely because local processing took time. Device convergence comes from fresh server/client reports, not browser-side aging guesses.

## Overview And Devices

Overview summarizes synchronization, unresolved conflicts, paired devices, readiness, attention items, recent activity, maintenance, and backup contract state. Devices are shown in a compact table with name, status, plugin version versus server recommendation, last seen, ahead/behind state, applied version, local detail, last successful sync, and actions.

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

## Visual Constraints

Use system sans-serif UI text and monospace identifiers, compact 13–14px table/body text, 24px page titles, a 4/8/12/16/24/32px spacing scale, one-pixel panel borders, and restrained 6px radii. Avoid nested card grids, heroes, marketing copy, illustrations, gradients, oversized decorative typography, and color-only status meaning.
