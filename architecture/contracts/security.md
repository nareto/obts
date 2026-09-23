# Security Contract

## Trust Boundary

OBTS v1 trusts the server process and operator with runtime plaintext. The server may read vault paths, content, Git objects, metadata, and temporary merge/history material only for authorized sync, validation, merge, conflict review, history, restore, diagnostics, maintenance, and recovery workflows.

This is not true E2EE or zero knowledge. A compromised live process, malicious deployment, or operator with runtime/storage access can read vault content.

## Account And Vault Isolation

- The instance may contain multiple users, but every vault has exactly one owner.
- Administrator status does not grant another owner's vault-content access.
- Every vault, device, ref/object, conflict, history, event, diagnostic, connection, and maintenance boundary enforces user/vault/device scope.
- Cross-owner vault-resource requests return `404` without useful existence leakage.
- Disabling a user revokes sessions, pending/approved connections, device tokens, and event streams.
- Revoking administrator status must not remove the final enabled administrator.
- User creation/disable/enable, administrator grant/revoke, reset-token creation, login, connection approval/completion, failed authentication, token rotation, and revocation write redacted audit records.
- Revoking a device or rotating its token takes effect server-side immediately; local credential deletion is best-effort cleanup.

## Dashboard Sessions

Dashboard authentication uses server-side sessions with at least 128 bits of entropy. Cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, have no `Domain` attribute, and use the hardened `__Host-`/`Secure` form when served over HTTPS. Sessions have a 30-day absolute lifetime and a seven-day idle lifetime refreshed by authenticated dashboard use; logout or account disable invalidates them immediately.

Cookie-authenticated mutations require a session-bound CSRF token. The active authenticated user is not asked to re-enter username or password for dashboard operations. Consequential actions instead use explicit target-specific typed confirmation or ordinary confirmation according to the product contract. Server authorization and state preconditions remain mandatory regardless of frontend confirmation.

Passwords are at least 12 characters and use Argon2id with minimum parameters `m=19456`, `t=2`, `p=1`. Five failed logins for one account/source within ten minutes trigger exponential backoff starting at one minute and capped at one hour. Connection creation/review/polling is rate-limited by source and connection identity. Local account recovery uses audited one-time reset credentials; v1 does not depend on email recovery.

### OBTS-SEC-DEL-001: Owner-Scoped Destructive Deletion

A vault deletion request requires the ordinary authenticated owner session, a valid session-bound CSRF token, and an explicit typed target phrase bound to the captured full vault ID. It does not require recent-auth or password re-entry. Authorization is checked against the target before confirmation errors; unknown and cross-owner resources remain indistinguishable `404` responses. A request cannot change target when selection or account context changes.

The deletion coordinator rechecks owner scope and lifecycle state at its durable acceptance boundary. All pending, active, and completed deletion status is owner-scoped and redacted to opaque IDs, timestamps, status, and fixed safe error categories. No receipt or pending record retains names, paths, commits, content, manifests, tokens, connection secrets, device names, or diagnostics. Revocation and the deletion barrier prevent new device, transfer, connection, diagnostic, sync, history, or mutation admissions for the target while another vault remains independently accessible.

## Device And Connection Credentials

Connection secrets and device tokens have at least 256 bits of entropy and are stored server-side only as hashes with non-secret lookup prefixes. An unapproved browser connection is one-time, expires ten minutes after creation, and binds approval to the matching plugin-held secret and verification code. Approval atomically replaces that deadline with a finite one-hour enrollment lease; polling does not renew it. Denial, owner disablement, vault deletion, or lease expiry remains terminal. Device registration consumes the connection before bulk transfer, after which restart and transfer recovery use the scoped device credential rather than extending or recreating browser authorization.

Device tokens are scoped to one owner, vault, and device and live only under `.obts/auth/device-token.json`. An initializing device may pull, apply, and acknowledge its selected vault but may publish at most its one approved initialization/merge proposal and may not publish ordinary follow-up proposals until onboarding completes. That path is excluded from sync, Git content, recovery snapshots, diagnostics, and exports. Desktop permissions are owner-only; mobile relies on the Obsidian application sandbox.

Bridge headless progress is a liveness signal, not authority. Startup and operation progress events use a closed, byte-bounded schema containing only redacted status and diagnostic-point identifiers, never paths, manifests, content, tokens, secrets, or browser URLs. Only schema-valid correlated responses, at most one closed-schema state event per request, and closed-schema progress events reset the configured inactivity timer; missing, extra, oversized, invalid, or unrelated traffic fails the protocol and quarantines the child. Request writes, startup recovery, complete stdout frames, and response reads are all bounded. Cancellation synchronously marks the child unhealthy and starts quarantine before releasing request ownership. Progress cannot extend enrollment authority, mutate durable transfer state, or bypass the bounded restart circuit.

## Deployment Protection

Persistent state is ordinary sensitive application data. Deployments provide restrictive ownership/permissions, HTTPS, encrypted disks/volumes/snapshots/backups where required, separately protected storage credentials, and point-in-time-consistent backup of metadata and Git state.

OBTS makes no claim that a copied plaintext database, Git store, headless vault, recovery bundle, diagnostic export, or unencrypted backup is unreadable.

## Logging, Events, Diagnostics, And Exports

Default logs, errors, events, audit records, metrics, and diagnostic exports omit passwords, tokens, auth headers, request bodies containing content, raw paths, note/plugin bodies, Git packs/blobs, recovery-bundle content, and operation manifests. They use opaque resource IDs, operation class, duration, status, and fixed safe error categories.

Content-bearing history or recovery export is an explicit owner action and remains scoped and audited. Bridge Markdown export uses the authenticated automation context's current read policy, selects policy before hydration, and never reports denied paths or their count. Export audit data may include the opaque context, export revision, selected and unavailable counts, duration, status, and cache outcome, but not bodies, raw paths, authorization rules, or filtered counts. Archive entry validation prevents path traversal and collisions; temporary ZIP/body spools are owner-only plaintext and are removed on completion, failure, cancellation, or response drop. Opt-in diagnostic ingestion accepts a closed schema, bounded size/rate/quota, and finite retention. Backups may retain deleted diagnostics until backup rotation.

## Temporary Plaintext

Authorized Git quarantine, semantic merge, conflict, history, and restore workspaces may contain plaintext. They are transaction-scoped, permission-restricted, single-vault, and cleaned on success or failure; durable recovery residue is treated as protected persistent state.

Bridge request, export, and projection memory is not a second persistent body store. Config.yaml/runtime auth is the sole ACL-policy authority; PostgreSQL only executes predicates derived from that policy. Foreground denied callers receive normal 403/404 handling, while principal-independent background projection indexes all supported synced notes, including private notes. Authorized body hydration retains finite ownership through processing and body-bearing response copies, including MCP JSON conversion; normal encoded batches are bounded and oversized derived rows execute alone under the file lease and shared singleton permit through cleanup; source-integrity/storage failures drain work and fail closed, never making PostgreSQL-derived text or an all-text process cache the fallback source. This memory rule does not claim allocator-byte, SQL-ACL, or physical-durability properties; those remain executable verification obligations.

The permitted derived normalized lowercase plaintext lexical index retains body-derived text in PostgreSQL and any backups that capture it, including private-note content. Apply content confidentiality, access and backup protections; do not claim that PostgreSQL contains no body-derived plaintext. Legacy raw columns remain purged and the lexical index must never supply exact bodies/snippets.
