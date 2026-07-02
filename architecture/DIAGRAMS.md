# Architecture Diagrams

_Generated from `workspace.dsl`; do not edit by hand._

## structurizr Containers

```mermaid
graph LR

  subgraph diagram ["Container View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Maintainer/operator [Person]"]
    4["Obsidian [Software System]"]
    5["Deployment secret source [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      22["Dashboard SPA [Container: TypeScript, static SPA]"]
      29["Obsidian plugin [Container: TypeScript, Obsidian Plugin API]"]
      42["User-visible vault files [Container: Obsidian Vault API and local filesystem]"]
      43[".obts local store [Container: Local filesystem and platform secure storage]"]
      44[("Server metadata database [Container: PostgreSQL]")]
      45["Encrypted-at-rest content store [Container: Local filesystem]"]
      46["Internal history store [Container: Git-compatible local filesystem]"]
      47["Temporary merge workspace [Container: Local filesystem]"]
      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    3-. "Runs server CLI commands such as doctor, backup, restore, compact, key rewrap, and version. [CLI]" .->7
    3-. "Provides and rotates server master key material outside the app repository. [Operational procedure]" .->5
    1-. "Uses setup, device dashboard, conflict center, and maintenance views after dashboard login. [HTTPS]" .->22
    2-. "Uses sync status, commands, and conflict alerts while editing in Obsidian. [Obsidian UI]" .->29
    7-. "Serves static dashboard assets. [HTTP]" .->22
    22-. "Calls setup, dashboard, conflict, resolution, key rewrap, compact, and health APIs. [HTTPS]" .->7
    29-. "Uses vault, workspace, settings, status bar, command, and request APIs. [Obsidian Plugin API]" .->4
    29-. "Pairs devices, rehydrates identity/ref metadata, uploads content and proposals, pulls diffs, receives conflict state, and subscribes to events. [HTTPS/WSS]" .->7
    29-. "Reads local vault content as the device source of truth and applies accepted server main changes after local recovery snapshots. [Obsidian Vault API]" .->42
    29-. "Persists local Git journal, recoverable metadata, durable local proposals, content cache, recovery bundles, cursors, diagnostics, and device token state. [Local filesystem and platform secure storage]" .->43
    7-. "Loads server master key material for per-vault data key unwrap and rewrap operations. [Environment variable, secret mount, or KMS API]" .->5
    7-. "Reads and writes account, vault, wrapped key, device, token, content catalog, proposal, conflict, audit, and history metadata. [SQL]" .->44
    7-. "Stores and reads vault content encrypted at rest. [Filesystem]" .->45
    7-. "Maintains canonical main refs, immutable commit graph, manifests, and merge provenance. [Git-compatible local filesystem]" .->46
    7-. "Uses ephemeral plaintext working trees for server-side merge transactions. [Filesystem]" .->47
    7-. "Emits main advancement, conflict, device state, and maintenance events. [WebSocket]" .->29

  end

```

## structurizr DashboardComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Dashboard SPA"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 22 ["Dashboard SPA"]

        23["AuthSession [Component: TypeScript]"]
        24["DeviceDashboard [Component: TypeScript]"]
        25["ConflictList [Component: TypeScript]"]
        26["MarkdownDiffViewer [Component: TypeScript]"]
        27["SourceDiffViewer [Component: TypeScript]"]
        28["ResolutionEditor [Component: TypeScript]"]
      end

      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    23-. "Authenticates dashboard sessions and calls setup/admin APIs. [HTTPS]" .->7
    24-. "Reads authorized device state, server main status, and maintenance summaries. [HTTPS]" .->7
    25-. "Lists unresolved conflicts and fetches authorized conflict review content. [HTTPS]" .->7
    26-. "Fetches Markdown conflict variants and merge previews for rendering. [HTTPS]" .->7
    27-. "Fetches source-level conflict diffs for review. [HTTPS]" .->7
    28-. "Submits selected or manually edited resolution content for server persistence and main advancement. [HTTPS]" .->7

  end

```

## structurizr PluginComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Obsidian plugin"]

    4["Obsidian [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 29 ["Obsidian plugin"]

        30["SettingsView [Component: TypeScript]"]
        31["StatusBar [Component: TypeScript]"]
        32["VaultWatcher [Component: TypeScript, Obsidian Vault API]"]
        33["PeriodicScanner [Component: TypeScript]"]
        34["PathNormalizer [Component: TypeScript]"]
        35["SnapshotEngine [Component: TypeScript]"]
        36["LocalQueue [Component: TypeScript]"]
        37["LocalContentCache [Component: TypeScript]"]
        38["MetadataRepair [Component: TypeScript]"]
        39["TransportClient [Component: TypeScript]"]
        40["ApplyEngine [Component: TypeScript, Obsidian Vault API]"]
        41["DiagnosticsExporter [Component: TypeScript]"]
      end

      42["User-visible vault files [Container: Obsidian Vault API and local filesystem]"]
      43[".obts local store [Container: Local filesystem and platform secure storage]"]
      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    32-. "Receives vault change notifications through supported APIs. [Obsidian Vault API]" .->4
    33-. "Scans vault files to detect missed watcher events, commit filesystem differences, and drive crash recovery work. [Obsidian Vault API]" .->42
    35-. "Canonicalizes vault-relative paths before proposal creation. [TypeScript calls]" .->34
    35-. "Reads changed content before enqueueing proposal data. [Obsidian Vault API]" .->42
    35-. "Persists proposal state before upload or destructive local apply. [TypeScript calls]" .->36
    36-. "Stores queue state, proposal payloads, recovery bundles, locks, and diagnostics under .obts. [Filesystem]" .->43
    37-. "Caches content required for retry, pull, apply, and recovery. [Filesystem]" .->43
    38-. "Reads device token and local Git refs, then rewrites recoverable state.json metadata after server rehydration. [Filesystem]" .->43
    38-. "Requests device self metadata without needing a vault ID from state.json. [TypeScript calls]" .->39
    39-. "Calls device self metadata repair, uploads full-vault content and proposals, pulls diffs, lists conflict state, and subscribes to events. [HTTPS/WSS]" .->7
    40-. "Requires local recovery snapshot before applying destructive server changes. [TypeScript calls]" .->35
    40-. "Materializes accepted server main entries into vault files and managed Obsidian configuration targets. [Obsidian Vault API]" .->42
    31-. "Reads local queue state to show ahead, blocked, retry, and recovery statuses. [TypeScript calls]" .->36
    41-. "Reads local state and writes redacted diagnostic bundles. [Filesystem]" .->43
    30-. "Consumes pairing tokens and stores device registration metadata locally. [HTTPS]" .->7

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    5["Deployment secret source [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 7 ["Server API and CLI"]

        10["DeviceService [Component: TypeScript]"]
        11["AtRestKeyManager [Component: TypeScript, Node crypto]"]
        12["ContentStoreService [Component: TypeScript]"]
        13["ProposalService [Component: TypeScript]"]
        14["HistoryService [Component: TypeScript]"]
        15["MergeCoordinator [Component: TypeScript]"]
        16["SemanticMergeService [Component: TypeScript]"]
        17["ConflictService [Component: TypeScript]"]
        18["NotificationHub [Component: TypeScript]"]
        19["BackupService [Component: TypeScript]"]
        20["AuditLogService [Component: TypeScript]"]
        21["HealthService [Component: TypeScript]"]
        8["AuthService [Component: TypeScript]"]
        9["VaultService [Component: TypeScript]"]
      end

      29["Obsidian plugin [Container: TypeScript, Obsidian Plugin API]"]
      44[("Server metadata database [Container: PostgreSQL]")]
      45["Encrypted-at-rest content store [Container: Local filesystem]"]
      46["Internal history store [Container: Git-compatible local filesystem]"]
      47["Temporary merge workspace [Container: Local filesystem]"]
    end

    8-. "Reads users and token hashes; writes auth audit metadata. [SQL]" .->44
    9-. "Manages vault records, setup state, owner isolation, and wrapped key metadata. [SQL]" .->44
    9-. "Requests per-vault data key creation for new vaults. [TypeScript calls]" .->11
    10-. "Registers, updates, and revokes devices. [SQL]" .->44
    11-. "Reads runtime master key material without printing or persisting it. [Environment variable, secret mount, or KMS API]" .->5
    11-. "Stores and reads wrapped per-vault data keys and key version metadata. [SQL]" .->44
    12-. "Requests per-vault data keys for encryption/decryption at persistence boundaries. [TypeScript calls]" .->11
    12-. "Writes encrypted-at-rest content bytes and reads them for authorized workflows. [Filesystem]" .->45
    12-. "Records content catalog metadata, hashes, sizes, and storage refs. [SQL]" .->44
    13-. "Persists uploaded content before accepting proposals. [TypeScript calls]" .->12
    13-. "Submits proposal manifests for server-side merge or conflict routing. [TypeScript calls]" .->15
    14-. "Reads and writes commit graph, manifests, refs, and merge provenance. [Filesystem]" .->46
    14-. "Records main refs, commit indexes, and transaction state. [SQL]" .->44
    15-. "Reads base/current/proposed manifests and advances main after clean merge or resolution. [TypeScript calls]" .->14
    15-. "Decrypts candidate content for merge and persists merged results encrypted at rest. [TypeScript calls]" .->12
    15-. "Checks out transaction-scoped plaintext working trees for content-aware merge. [Filesystem]" .->47
    15-. "Requests conservative text and Markdown merge for same-path changes. [TypeScript calls]" .->16
    16-. "Reads and writes plaintext merge candidates inside the transaction workspace. [Filesystem]" .->47
    15-. "Creates conflict records when server-side merge is ambiguous or unsafe. [TypeScript calls]" .->17
    17-. "Stores conflict state, affected paths, base/current/proposed refs, and resolution refs. [SQL]" .->44
    17-. "Reads conflict variants and persists resolution content encrypted at rest. [TypeScript calls]" .->12
    18-. "Emits main advancement, conflict, device state, and maintenance events. [WebSocket]" .->29
    19-. "Reads or snapshots server metadata and wrapped key metadata for backup and restore. [SQL]" .->44
    19-. "Copies encrypted-at-rest content during backup and restore. [Filesystem]" .->45
    19-. "Copies internal history state during backup and restore. [Filesystem]" .->46
    20-. "Writes redacted audit events without raw tokens, passwords, key material, or full note bodies. [SQL]" .->44
    21-. "Checks database readiness. [SQL]" .->44
    21-. "Checks encrypted content store writability. [Filesystem]" .->45
    21-. "Checks internal history store accessibility. [Filesystem]" .->46
    21-. "Checks key-manager readiness and master key availability. [TypeScript calls]" .->11

  end

```

## structurizr SystemContext

```mermaid
graph LR

  subgraph diagram ["System Context View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Maintainer/operator [Person]"]
    4["Obsidian [Software System]"]
    5["Deployment secret source [Software System]"]
    6["Obsidian True Sync [Software System]"]

    1-. "Self-hosts, creates vaults, pairs devices, reviews conflicts, and runs maintenance. [HTTPS and Obsidian UI]" .->6
    2-. "Edits notes and observes sync status through paired Obsidian clients. [Obsidian UI]" .->6
    3-. "Runs server CLI commands such as doctor, backup, restore, compact, key rewrap, and version. [CLI]" .->6
    3-. "Provides and rotates server master key material outside the app repository. [Operational procedure]" .->5
    6-. "Integrates as a community plugin and uses vault/workspace/plugin lifecycle APIs. [Obsidian Plugin API]" .->4
    6-. "Loads server master key material for per-vault data key unwrap and rewrap operations. [Environment variable, secret mount, or KMS API]" .->5

  end

```

