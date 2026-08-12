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

## Device And Connection Credentials

Connection secrets and device tokens have at least 256 bits of entropy and are stored server-side only as hashes with non-secret lookup prefixes. Connections are one-time, expire after ten minutes, and bind browser approval to the matching plugin-held secret and verification code.

Device tokens are scoped to one owner, vault, and device and live only under `.obts/auth/device-token.json`. That path is excluded from sync, Git content, recovery snapshots, diagnostics, and exports. Desktop permissions are owner-only; mobile relies on the Obsidian application sandbox.

## Deployment Protection

Persistent state is ordinary sensitive application data. Deployments provide restrictive ownership/permissions, HTTPS, encrypted disks/volumes/snapshots/backups where required, separately protected storage credentials, and point-in-time-consistent backup of metadata and Git state.

OBTS makes no claim that a copied plaintext database, Git store, headless vault, recovery bundle, diagnostic export, or unencrypted backup is unreadable.

## Logging, Events, Diagnostics, And Exports

Default logs, errors, events, audit records, metrics, and diagnostic exports omit passwords, tokens, auth headers, request bodies containing content, raw paths, note/plugin bodies, Git packs/blobs, recovery-bundle content, and operation manifests. They use opaque resource IDs, operation class, duration, status, and fixed safe error categories.

Content-bearing history or recovery export is an explicit owner action and remains scoped and audited. Opt-in diagnostic ingestion accepts a closed schema, bounded size/rate/quota, and finite retention. Backups may retain deleted diagnostics until backup rotation.

## Temporary Plaintext

Authorized Git quarantine, semantic merge, conflict, history, and restore workspaces may contain plaintext. They are transaction-scoped, permission-restricted, single-vault, and cleaned on success or failure; durable recovery residue is treated as protected persistent state.
