# 1. Record PRD-derived architecture skeleton

Date: 2026-06-25

## Status

Superseded by the architecture authority migration at revision 1.

## Context

The `obts` repository currently contains `prd.md` and no implementation files. The PRD defines the intended product boundaries, runtime containers, storage model, API contracts, and security constraints for Obsidian True Sync.

## Decision

The first Structurizr model represents the PRD-specified v1 architecture as a doc-derived skeleton. Element descriptions and relationships intentionally say "PRD-specified" or "planned" where no code exists yet.

When implementation lands, the model must be refreshed from source code, manifests, executable configuration, schemas, and tests before relying on PRD text.

## Consequences

This gave agents and maintainers a concrete C4 starting point before code existed, while preserving the distinction between intended architecture and implemented architecture.

The proof-of-concept PRD was retired after implementation. `architecture/README.md` now defines the authoritative contract/model/ADR structure, and `workspace.dsl` is maintained from current runtime evidence rather than PRD intent.
