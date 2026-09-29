# AGENTS.md

`architecture/` is the source of truth for product boundaries, safety properties, system behavior, and architectural decisions. Before fixing a bug, implementing a feature, or refactoring production behavior, read `architecture/README.md` and assess which authoritative artifacts it indexes are affected. `prd.md` was retired and must not be recreated as a competing specification.

Treat production code and `architecture/` as one synchronized system. For an ordinary implementation fix, reproduce the defect, add a regression, fix it, and run affected validation; do not edit architecture when the existing contract/model is complete and accurate. For contract changes or changes to ordering, concurrency, preservation, recovery, or other modeled semantics, identify affected contracts/model checks, update the model, and run TLC before implementation. Escalate ambiguous semantics for a product decision. A model gap alone does not require modeling unrelated implementation minutiae.

Update C4 only when allocation, component responsibilities, relationships, or trust boundaries change; update OpenAPI only when the HTTP contract changes. Do not mechanically edit every architecture artifact. Increment `architecture/manifest.yaml` once when authoritative architecture changes. For a behavior-preserving refactor or implementation-only fix whose architecture remains complete and accurate, add the exact commit trailer `Architecture-Impact: none`; this acknowledgement does not prove the conclusion correct. During development use `npm run test:fast` plus focused tests; CI is the authoritative complete selected gate. Comprehensive validation is not required repeatedly on a developer machine for ordinary fixes.

TLA+/PlusCal models live under `architecture/models/formal/`, refine named contract IDs, and remain subordinate to the architecture authority map.

When changing the Obsidian plugin, run `just plugin-version <patch|minor|major|VERSION>` before committing. Do not edit generated plugin artifacts manually.

For the user to be able to use the updated plugin, you need to create a new github release for it so it appears as updateable in BRAT (main installation vehicle).

## Public source boundary

This branch is mirrored publicly. Review every commit for private deployment details before committing, including commits pushed only to Forgejo; deleting a file later does not erase it from history. Keep application instructions and CI public-safe under `AGENTS.md` and `.github/workflows/`, and keep environment-specific operations in a separate private infrastructure repository. Do not track `.forgejo/` workflows on this shared branch.
