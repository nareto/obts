# Server-Managed Vault Sync Settings

- Status: accepted
- Date: 2026-09-30
- Deciders: OBTS maintainers

## Context

Timestamp-only edits to Markdown frontmatter can create avoidable conflicts. Shared exclusions also need one understandable place to manage them across devices. The existing root `.gitignore` already supplies a versioned, capability-checked policy consumed before client transfers; replacing it with another server policy would split behavior and require migration.

## Decision

Expose selected-vault sync settings in the authenticated dashboard. Store explicitly configured top-level frontmatter field rules in per-vault metadata. The first supported strategy is `latest_timestamp`, disabled unless a field is configured. Merge only when all non-configured value spans and note body bytes match, parse timestamp instants without precision loss, and preserve original source bytes. Ambiguity and unsupported YAML/timestamp forms use ordinary conflict review. Persist the captured rules and validator outcome in the prepared merge operation.

Keep the vault-root `.gitignore` as the sole shared exclusions policy and backing store. Dashboard preview/save edits its exact versioned bytes and reconciles canonical Git and explicit directory state through the existing forward-only prepared ref-transition protocol. Clients continue to consume the file before transfer/apply and retain newly excluded visible files as local-only. The plugin displays the effective file read-only and links to dashboard settings; direct file edits remain ordinary proposals. The server retains a device's advertised `path_capabilities.root_ignore` capability only when its reported value is exactly boolean `true`.

## Consequences

- Owners configure shared settings once per vault and get server-side preview, stale-state checks, and auditable automatic merge outcomes.
- Historical accepted objects remain protected. Unignore does not resurrect old content, and exclusions never delete local visible files.
- Dashboard settings require a reachable server and current selected-vault state.
- Timestamps with no explicit zone, invalid calendar/offset, or more than nine fractional digits remain conflicts; the UI explains the supported format.
- Git object identity, ancestry, and compare-and-swap remain authoritative. Timestamps choose only the configured metadata value after independent content equality checks.
