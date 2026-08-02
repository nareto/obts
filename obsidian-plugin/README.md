# Obsidian Plugin Artifact

Copy this directory to `.obsidian/plugins/obts/` in a copied test vault and
enable `Obsidian True Sync` from Obsidian's community plugin settings.

The plugin supports desktop, Android, and iOS. It uses `isomorphic-git` with
Obsidian's cross-platform vault adapter to keep hidden local history under
`.obts/git`, completes browser-approved onboarding, uploads local
commits to the server device ref, pulls accepted server `main`, writes recovery
bundles and apply journals under `.obts/`, and applies server changes through
Obsidian's vault adapter.

Recovery bundles include affected-file snapshots, text patch artifacts for text
files, local Git refs packs, and checksum manifests. Onboarding intentionally
blocks when an existing `.obts/` directory contains partial or active device
state so the owner can recover or reset it explicitly. Authentication happens
in the server dashboard; the plugin stores neither dashboard credentials nor
connection secrets in plugin settings.

If an existing-vault merge needs dashboard conflict review, the onboarding
screen keeps the submission pending and provides **Open dashboard** followed by
**Check resolution**. Return to that screen after resolving the conflict; do not
submit the local merge again. Interrupted registered onboarding appears as
**Setup incomplete** in plugin settings and resumes from the accepted server
device ref rather than creating another proposal.

A plugin hot reload never steals an active vault-operation lease. A replacement
waits for the prior operation to finish and, if it cannot quiesce safely, asks
for a full Obsidian restart instead of allowing overlapping writes.

The desktop status-bar indicator remains visible while Obsidian is active, with
a matching mobile ribbon indicator where the status bar is unavailable. They
show healthy, active, warning, and blocked states; report determinate
upload/apply steps when available; and open the dashboard for conflict review
or plugin settings for other states. Settings identify the current operation and
its elapsed time, refresh progress while the tab remains open, keep **Sync now**
and **Unpair** visible but disabled while recovery owns the vault lease, and
distinguish slow progress from a reload that requires restart. Actionable
transitions produce one notice, while brief routine polling and catch-up do not.

A paired device can be renamed from plugin settings. The server owns the
canonical display name, and the plugin reconciles owner-side renames made in
the dashboard during status reporting. Device renames do not affect vault
content or local filesystem paths.

Commands:

- `Set up sync`
- `Sync once`
- `Verify local vault contents`
- `Replace local with server state`
- `Rebuild from server main`

Troubleshooting diagnostics are optional and off by default. The **Share sanitized troubleshooting diagnostics** toggle sends failures, stalled startup checkpoints, and stale-block reconciliation snapshots only to the configured backend using fixed sanitized schemas. Reports can include plugin/platform versions, fixed error codes, coarse queue/journal/lease states, and cursor relationships without cursor values; they exclude note content, vault and file names, paths, credentials, commit IDs, Git objects, packfiles, stacks, and raw logs. Changing the backend URL or expanding the diagnostic schema turns sharing off until consent is renewed. Use **Send troubleshooting snapshot now** to report the current classifications without starting or interrupting sync.

No visible vault `.git` directory is created.
