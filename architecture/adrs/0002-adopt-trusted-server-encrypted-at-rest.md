# 2. Adopt trusted-server encrypted-at-rest v1 architecture

Date: 2026-06-26

## Status

Accepted

## Context

The first PRD-derived architecture modeled `obts` as a true end-to-end encrypted system. That model forced browser/plugin key derivation, vault passphrase prompts, client-side conflict decrypt/re-encrypt flows, HMAC path IDs, and client-side semantic merge. Those choices made server-side Git-style merge and simple dashboard UX substantially harder.

The intended v1 deployment is self-hosted. The server operator is trusted, but different users on the same server must remain isolated from each other.

## Decision

v1 uses a trusted-server model with encrypted-at-rest storage.

The server is authorized to decrypt vault content for sync, merge, conflict review, backup, and recovery. Persistent vault content is encrypted with per-vault data keys wrapped by server master key material. The dashboard does not require a separate vault passphrase after normal login.

Account and vault authorization, TLS, token handling, log redaction, backup discipline, and server key management are the v1 security boundary. True E2EE is not a v1 requirement.

## Consequences

Server-side semantic merge, dashboard conflict review, and recovery become simpler and more coherent.

Offline database, content-store, and backup copies are less useful without server key material, but a compromised live server or operator with runtime key access can read vault content. This is an accepted v1 tradeoff and must be documented honestly.
