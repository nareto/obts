# Obsidian Plugin Artifact

Copy this directory to `.obsidian/plugins/obts/` in a copied test vault and
enable `Obsidian True Sync` from Obsidian's community plugin settings.

The Phase 1 plugin is desktop-only. It uses the native `git` executable to keep
hidden local history under `.obts/git`, consumes pairing tokens, uploads local
commits to the server device ref, pulls accepted server `main`, writes recovery
bundles and apply journals under `.obts/`, and applies server changes through
Obsidian's vault adapter.

Recovery bundles include affected-file snapshots, text patch artifacts for text
files, local Git refs packs, and checksum manifests. Pairing intentionally
blocks when an existing `.obts/` directory contains partial or prior device
state so the owner can recover or reset it explicitly.

Commands:

- `Pair device`
- `Sync once`
- `Confirm initial import and sync`
- `Replace local with server state`

No visible vault `.git` directory is created.
