# ADR 0012: Durable Early Onboarding Disposition

- Status: Accepted
- Date: 2026-09-25
- Architecture revision: 21

## Context

Setup ran a full local content summary before opening the browser, repeated it after approval, and for any non-empty local vault downloaded and indexed server Git history before presenting the use-server versus merge choice. Mobile users also reported that iOS suspension repeatedly interrupted setup, and the interruption left unclassifiable apply journals that blocked re-setup. The replacement choice existed, but reaching it was itself the dominant cost on mobile, and a no-notes fresh vault still counted as non-empty because Obsidian configuration is syncable content.

## Decision

The first setup screen records a durable early content disposition before the browser request: replace syncable local contents from the selected existing server vault, or keep local contents and run the existing classification. The disposition and its content fingerprint persist in the local onboarding journal (`OBTS-FM-006` `PublishConsent` boundary, contract `OBTS-SYNC-ONB-001`).

When the user pre-authorizes replacement from an existing vault:

- Approval-to-confirmation skips pre-registration classification and skips remote object download entirely; setup confirms the selected vault and replacement scope before any destructive work.
- Registration still requires the persisted consent snapshot to match current local content, publishes recovery before destructive replacement, consumes the browser approval, and keeps post-registration transfer, acknowledgement, catch-up, and activation unchanged.
- A browser new-vault selection under replacement consent is a durable terminal mismatch that must be explicitly restarted; it never becomes automatic initialization, upload, or deletion.

The separate server-prepared bounded bootstrap artifact and reduced-history transports described in `docs/snapshot-bootstrap-proposal.md` remain future work and are not authorized by this decision.

## Consequences

- Mobile setup no longer hashes local files twice or downloads server history merely to present a choice the user already made.
- The existing analysis/classification flow remains the default and remains required for keep-local, merge, and new-vault imports.
- Formal model `OBTS-FM-006` gains the `PublishConsent` boundary, a `ConsentBeforeRegistration` invariant, and a `RegisterWithoutConsent` negative control.
- Contracts `OBTS-SYNC-ONB-001` (consent scope), `OBTS-PER-OP` onboarding journal boundaries, and the verification contract's onboarding evidence bullet gain the early-disposition requirements.
- No HTTP surface change is required in this increment; approval metadata already carries the vault identity and pinned baseline.
