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

Commands:

- `Set up sync`
- `Sync once`
- `Replace local with server state`
- `Rebuild from server main`

No visible vault `.git` directory is created.
