# AGENTS.md

`architecture/` is the source of truth for product boundaries, safety properties, system behavior, and architectural decisions. Before fixing a bug, implementing a feature, or refactoring production behavior, read `architecture/README.md` and assess which authoritative artifacts it indexes are affected. `prd.md` was retired and must not be recreated as a competing specification.

Treat production code and `architecture/` as one synchronized system. Before editing protocol behavior in the shared plugin/headless client, server, or Rust Bridge writer/projection path, classify the change and identify the affected contract IDs, formal-model actions and checks, OpenAPI operations, and C4 boundaries. For an intended behavioral change, update the relevant contract and bounded TLA+ model/checks first and run TLC before implementation; then update production code, executable regressions, and formal traceability. If a bug exposes a model gap, first model the current implementation until the discrepancy is reproducible. If code violates an already-correct model, keep that model and add an implementation regression before fixing the code. Stop for a product decision rather than encoding ambiguous semantics.

Update C4 only when component responsibilities, relationships, trust boundaries, or deployment structure change, and update OpenAPI when the HTTP surface changes. Land affected architecture, code, tests, and traceability in the same commit with one increment to `architecture/manifest.yaml`. For a behavior-preserving refactor or implementation-only fix whose architecture remains complete and accurate, add the exact commit trailer `Architecture-Impact: none`. The push check enforces acknowledgement but does not prove that the conclusion is correct.

TLA+/PlusCal models live under `architecture/models/formal/`, refine named contract IDs, and remain subordinate to the architecture authority map.

When changing the Obsidian plugin, run `just plugin-version <patch|minor|major|VERSION>` before committing. Do not edit generated plugin artifacts manually.

For the user to be able to use the updated plugin, you need to create a new github release for it so it appears as updateable in BRAT (main installation vehicle).
