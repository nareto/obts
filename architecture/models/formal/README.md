# Formal Models

No formal model is currently accepted.

TLA+/PlusCal models may be added here as bounded refinements of stable contracts in `architecture/contracts/`. They do not define product behavior independently.

Every model must declare:

- model ID and status;
- refined contract IDs;
- `architecture_revision` matching `architecture/manifest.yaml` when last reviewed;
- state variables and abstraction boundary;
- safety and liveness properties;
- durability, fairness, and fault assumptions;
- TLC configuration, bounds, and reproducible command;
- known omissions and counterexamples promoted to executable tests.

A protocol-changing code or architecture change must either update affected models and their declared revision or explicitly retire them. Mechanical revision agreement does not prove semantic conformance.

The first proposed pilot should model one client, one path, a captured version, a concurrent edit, recovery publication, destructive apply, crash, and restart against `OBTS-SAF-001`, `OBTS-SAF-002`, and `OBTS-SAF-005`.
