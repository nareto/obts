# Obsidian True Sync Architecture Overview

This document is a navigational summary. Normative behavior and safety live in [`../contracts/`](../contracts/), runtime allocation in [`../models/system-overview.md`](../models/system-overview.md), structure in [`../workspace.dsl`](../workspace.dsl), and decisions in [`../adrs/`](../adrs/).

## Canonical Model

Each vault has one server-authoritative `refs/heads/main`. Devices capture visible local changes as hidden Git history under `.obts/git` and upload immutable proposals through protected per-device refs. The server validates accepted bytes, orders integration per vault, merges deterministic safe cases, and protects ambiguous content or directory state as a dashboard conflict.

Clients never advance canonical main directly. Git ancestry establishes content identity and proposal relationships; timestamps are presentation metadata only.

## Local Preservation

The visible vault is the device source of truth. Durable watcher hints, scan/cache state, local Git, immutable transfer journals, directory intent, apply journals, and recovery bundles make interrupted work discoverable after restart.

Before destructive apply, a client publishes recovery evidence and revalidates every affected path immediately before mutation. A restart rolls forward idempotently or blocks; it does not infer a winner or overwrite an unexpected local change. The governing preservation invariant is `OBTS-SAF-001` in [`../contracts/safety.md`](../contracts/safety.md).

## Directory State

Empty directories are causal product metadata because Git does not represent them. A directory proposal carries stable identity, intent generations, and an acknowledged canonical baseline. The server merges disjoint/equivalent intent and creates directory or mixed conflicts for opposing subtree changes. Git and directory outcomes settle atomically.

Physical removal remains client-safe: only verified empty directories are removed, deepest first and non-recursively. Canonical acceptance never authorizes recursive deletion of local content.

## Durable Transfer And Server Integration

Large uploads are immutable durable proposals with stable attempt and transfer identity. Durable receipt is separate from canonical processing. Lost responses become result lookup, internal failures remain bounded retryable processing, ancestry-safe device-ref movement remains accepted, covered targets remain idempotent, and divergence becomes protected conflict history.

Server operations persist every post-ref metadata/event/conflict/directory effect before compare-and-swap ref movement. Startup aborts transitions that never moved, rolls forward exact prepared targets that did, and blocks irreconcilable state.

## Dashboard

The Svelte SPA is an authenticated operational UI for validated vault context, device status, conflict review, history, diagnostics, and maintenance. It is not authoritative for sync state. Server-versus-named-device provenance remains explicit throughout conflict review, and stale expected-main packages cannot resolve.

The dashboard relies on valid session, ownership, CSRF, and operation preconditions. Consequential intent uses an explicit confirmation appropriate to the target; it does not ask an active authenticated user to enter the password again.

## OBTS Bridge

The Bridge is part of the current architecture. Rust exposes scoped REST/MCP tools, ACL/revision enforcement, ordinary visible-file mutation, SQL-backed metadata/query planning, and bounded on-demand body hydration. A supervised Node process runs the same client core as the plugin and owns pairing, hidden Git, queues, synchronization, apply, and recovery.

The persistent headless visible vault and `.obts/` directory are authoritative device state and may contain the only copy of pending agent work. Config.yaml/runtime auth is the sole ACL-policy authority; PostgreSQL stores paginated metadata and predicates derived from current policy. Foreground denial remains 403/404 without dirtying global projection, while principal-independent background projection indexes all supported synced notes, including private notes. Raw Markdown, Bases, blocks and response bodies remain authoritative in ordinary files/Git. PostgreSQL may retain a projection-produced normalized lowercase plaintext lexical index to preserve legacy substring/title-weight scoring; its DB/backups contain derived plaintext, not a raw-body authority. Each body is read under the shared lock, attested against its projected revision/OID, and retained under finite body ownership through body-bearing use. Normal batches obey row/encoded-byte budgets; oversized indivisible rows execute alone under the file lease and a shared singleton permit through cleanup. Input bytes are limited, but parser/encoding/driver expansion has no defensible numeric singleton ceiling or hard RSS bound. Source-integrity/storage failures drain work, retain the cursor, and fail closed. A corpus total above a legacy aggregate cap is not rejected, but an individual file above the configured per-file limit remains unsupported. PostgreSQL may be rebuilt from verified headless state; it must never replace uncertain client state or trigger an all-text memory fallback. The Bridge pairs and synchronizes as a normal protected OBTS device.

## Trust And Persistence

The server is trusted with plaintext. At-rest protection is deployment-managed; OBTS does not implement per-vault application encryption or zero knowledge. Account/vault isolation, scoped device credentials, HTTPS, restrictive storage permissions, redacted diagnostics, and point-in-time-consistent backups define the v1 boundary.

Server Git plus coordinated metadata are authoritative. Bridge PostgreSQL is mixed state: content-derived query/projection rows are rebuildable, while retained access/audit history is non-reconstructable and backed up for its retention window. History/search indexes outside that audit state are derived. Missing or inconsistent authoritative state fails closed, while the authenticated diagnostic and repair surface remains available where safe.

## Verification

Architecture revision and code-impact acknowledgement keep synchronization decisions visible on every push. They do not prove correctness. Required proof combines contract traceability, automated integration/property/fault tests, subprocess crash/restart evidence, copied-vault real-device tests, Bridge end-to-end validation, backup/restore drills, and independent review.

TLA+/PlusCal remains a bounded refinement under `architecture/models/formal/`. `OBTS-FM-001` and `OBTS-FM-002` are accepted synchronization models, and `OBTS-FM-003` is the accepted architecture-stage focused Bridge bounded-body/query model; none alone proves production implementation conformance.
