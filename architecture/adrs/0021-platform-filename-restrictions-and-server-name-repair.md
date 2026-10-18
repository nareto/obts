# Platform Filename Restrictions And Server Name Repair

- Status: accepted
- Date: 2026-10-18
- Deciders: OBTS maintainers

## Context

Android shared storage rejects `" * : < > ? \ |` and folds letter case. Desktop Linux and iOS accept those names and case-only variants. A vault authored there can therefore contain canonical paths that an Android device cannot write. Before this decision, an Android device discovered the problem only while writing files during apply. It stopped with `apply_journal_recovery_required` after partially replacing visible files, and generic error mapping hid the cause.

## Decision

Define one shared, versioned restriction rule (`OBTS-SYNC-NAME-001`). Its only restricted platform today is `android`. A restricted device evaluates the complete target before any local effect and blocks with the retryable `unportable_target_paths` outcome. The block leaves every local, Git, journal, and canonical state unchanged. Canonical history stays platform-neutral: the server never rejects proposals because of platform names.

Repair existing names with one owner-reviewed, server-authored commit from the dashboard (`OBTS-DASH-NAME-001`). It uses a deterministic rename mapping, rewrites Obsidian and Markdown links and Canvas file references, and runs as an ordinary prepared ref-transition operation. Devices receive the repair as ordinary sync changes.

Advertise the restricted platforms of the vault's active paired devices through device self-description. Unrestricted plugins then reject interactive renames to unrepresentable names and warn about new files with such names. This guard is advisory and keeps no client setting.

## Rejected Alternatives

- Server-wide rejection of reserved names. It breaks valid desktop and iOS workflows to protect one platform, and it cannot repair existing history.
- Per-device encoded filenames with a mapping table. Every client would need a second path namespace, and recovery, link resolution, and external tools would become ambiguous.
- Client-side repair. Several devices would race to rename the same files, and the repair would depend on which device ran first.

## Consequences

- Android devices fail safe and explain how to fix the problem. Repair is centralized, previewable, auditable, and stale-checked.
- A repair changes note paths on every device. Links outside the vault, plugin configuration, and dynamic queries that mention old names are not rewritten.
- The advisory guard cannot prevent reserved names created while no restricted device is paired, or created outside Obsidian. The dashboard count and the device block remain the backstop.
