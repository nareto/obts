# Obsidian Plugin Artifact

Copy this directory to `.obsidian/plugins/obts/` in a copied test vault and
enable `Obsidian True Sync` from Obsidian's community plugin settings.

The Phase 1 plugin is desktop-only. It uses the native `git` executable to keep
hidden local history under `.obts/git`, consumes pairing tokens, uploads local
commits to the server device ref, pulls accepted server `main`, writes recovery
bundles and apply journals under `.obts/`, and applies server changes through
Obsidian's vault adapter.

Commands:

- `Pair device`
- `Sync once`
- `Confirm initial import and sync`
- `Replace local with server state`

No visible vault `.git` directory is created.
