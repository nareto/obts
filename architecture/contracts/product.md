# Product Contract

## Purpose

OBTS is a self-hosted, Git-backed synchronization system for Obsidian vaults. It preserves local-first editing, one canonical server state, recoverable history, explicit conflict review, and observable device status without exposing Git as the normal user workflow or creating a visible vault `.git` directory.

OBTS is intended for individuals and small trusted multi-user deployments. The server is trusted with plaintext vault content, but every vault has exactly one owner and application authorization must prevent other users, including unrelated administrators, from accessing that vault.

## Actors

- **Vault owner:** creates vaults, pairs and revokes devices, reviews conflicts, restores history, and initiates maintenance.
- **Device user:** edits notes and observes synchronization through Obsidian.
- **Operator:** deploys, upgrades, backs up, restores, diagnoses, and repairs the service.
- **Automation agent:** reads and writes through the scoped OBTS Bridge API or MCP surface.

## Supported Product Boundary

- Full-vault synchronization after deterministic hard exclusions and the shared plugin-managed root `.gitignore` policy. Ignored tracked paths become local-only without deleting local copies; historical versions remain recoverable. Obsidian plugin settings offer an explicit preview and save for the plugin-managed vault-root file; saving creates or overwrites it and never deletes it.
- Browser-assisted device onboarding without copied long-lived account credentials.
- Offline local edits captured as hidden Git history.
- Server-authoritative canonical `main`, deterministic safe merge, and durable conflict review.
- Empty-directory synchronization through causal metadata attached to Git proposals.
- Note history, forward-only restore, diagnostics, integrity checks, and non-destructive Git maintenance.
- Desktop Linux, macOS, and Windows support plus foreground Android and iOS support within documented memory and lifecycle limits.
- An agent-facing OBTS Bridge that pairs as a normal device, treats its headless client state as authoritative device state, treats PostgreSQL search/index rows as rebuildable projection, and preserves retained non-reconstructable access/audit history.

## Product Non-Goals

- True end-to-end encryption or zero-knowledge server operation.
- Shared vault membership, collaborative cursors, CRDT/OT sessions, or real-time co-editing.
- Hiding paths, content, Git objects, or metadata from the trusted live server process.
- A separate vault passphrase after dashboard login.
- A visible or user-operated Git repository inside the vault.
- Native Git inside the Obsidian plugin.
- Application-managed backup scheduling, offsite storage, or deployment-specific secret paths.
- Destructive history truncation or baseline compaction.
- Guaranteed background execution on mobile operating systems.

## User-Controlled Consequences

OBTS must not silently select a semantic winner for ambiguous content or directory changes. Consequential operations identify their target and effect before submission. A valid authenticated dashboard session is sufficient identity for dashboard workflows; explicit typed confirmation is used where deliberate destructive intent must be demonstrated, rather than asking the active user to enter the account password again.

## Support Claim

OBTS remains an active-development system until the verification contract has produced copied-vault, real-device, Bridge, backup/restore, and sustained soak evidence. Passing unit tests or a formal model alone is not sufficient to remove that qualification.
