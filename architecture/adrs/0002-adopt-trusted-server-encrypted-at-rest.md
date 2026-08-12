# 2. Adopt a trusted-server, deployment-protected architecture

Date: 2026-06-26

## Status

Accepted; corrected by architecture revision 1 to match the implemented storage boundary.

## Context

The first proof-of-concept architecture modeled OBTS as a true end-to-end encrypted system. That forced browser/plugin key derivation, vault passphrase prompts, client-side conflict decryption/re-encryption, opaque path identifiers, and client-side semantic merge. Those choices made server-side Git merge, dashboard review, history, and recovery substantially harder.

The intended deployment is self-hosted. The server operator is trusted, but users on the same server remain isolated from one another.

An earlier version of this ADR incorrectly retained application-managed per-vault data keys after the implementation and product contract had adopted deployment-managed at-rest protection. That contradiction is removed here.

## Decision

OBTS uses a trusted-server model. The server is authorized to read plaintext vault paths, content, Git state, and sensitive metadata for authorized sync, merge, conflict review, history, maintenance, backup validation, and recovery.

Persistent server and Bridge client state is ordinary sensitive application data. Restrictive permissions plus deployment-managed disk, volume, snapshot, database-backup, and offsite-storage encryption provide at-rest protection where required. OBTS does not implement per-vault application data keys, a server master content key, app-managed key rotation, true E2EE, or zero knowledge.

The dashboard does not require a separate vault passphrase. Account/vault authorization, scoped device credentials, TLS, redaction, backup discipline, and operator access controls define the security boundary.

## Consequences

Server-side semantic merge, dashboard conflict review, history, and recovery remain coherent.

Copied plaintext application stores or dumps are readable unless deployment controls protect them. A compromised live server or operator with runtime/storage access can read vault content. This is an explicit accepted tradeoff, not an encryption claim.
