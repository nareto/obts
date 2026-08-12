# AGENTS.md

`architecture/` is the source of truth for product boundaries, safety properties, system behavior, and architectural decisions; read `architecture/README.md` before changing sync, recovery, persistence, conflict, security, dashboard workflow, or Bridge behavior. `prd.md` was retired and must not be recreated as a competing specification.

For every code-bearing commit, review architecture impact. If the change affects an authoritative contract or model, update the affected architecture artifacts in the same commit and increment `architecture/manifest.yaml` by one. If architecture remains valid, add the exact commit trailer `Architecture-Impact: none`. The push check enforces acknowledgement but does not prove that the conclusion is correct.

Future TLA+/PlusCal models belong under `architecture/models/formal/`, refine named safety contract IDs, and remain subordinate to the architecture authority map.

When changing the Obsidian plugin, run `just plugin-version <patch|minor|major|VERSION>` before committing. Do not edit generated plugin artifacts manually.

For the user to be able to use the updated plugin, you need to create a new github release for it so it appears as updateable in BRAT (main installation vehicle).
