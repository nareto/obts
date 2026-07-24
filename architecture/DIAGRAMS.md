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

      23["Dashboard SPA [Container: TypeScript, static SPA]"]
      31["Obsidian plugin [Container: TypeScript, Obsidian Plugin API]"]
      45["User-visible vault files [Container: Obsidian Vault API and local filesystem]"]
      46[".obts local store [Container: Local filesystem and platform secure storage]"]
      47[("Server metadata database [Container: PostgreSQL]")]
      48["Encrypted-at-rest content store [Container: Local filesystem]"]
      49["Internal history store [Container: Git-compatible local filesystem]"]
      50["Temporary merge workspace [Container: Local filesystem]"]
      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    3-. "Runs server CLI commands such as doctor, backup, restore, compact, key rewrap, and version. [CLI]" .->7
    3-. "Provides and rotates server master key material outside the app repository. [Operational procedure]" .->5
    1-. "Uses setup, device dashboard, conflict center, and maintenance views after dashboard login. [HTTPS]" .->23
    2-. "Uses sync status, commands, and conflict alerts while editing in Obsidian. [Obsidian UI]" .->31
    7-. "Serves static dashboard assets. [HTTP]" .->23
    23-. "Calls setup, dashboard, conflict, resolution, key rewrap, compact, and health APIs. [HTTPS]" .->7
    31-. "Uses vault, workspace, settings, status bar, command, and request APIs. [Obsidian Plugin API]" .->4
    31-. "Pairs devices, rehydrates identity/ref metadata, uploads actor-device proposals with optional trusted base_commit metadata, pulls diffs, receives conflict state, and subscribes to events. [HTTPS/WSS]" .->7
    31-. "Reads local vault content as the device source of truth and applies accepted server main changes after local recovery snapshots. [Obsidian Vault API]" .->45
    31-. "Persists local Git journal, recoverable metadata, durable local proposals, content cache, recovery bundles, cursors, diagnostics, and device token state. [Local filesystem and platform secure storage]" .->46
    7-. "Loads server master key material for per-vault data key unwrap and rewrap operations. [Environment variable, secret mount, or KMS API]" .->5
    7-. "Reads and writes account, vault, wrapped key, device, token, content catalog, proposal, conflict, audit, and history metadata. [SQL]" .->47
    7-. "Stores and reads vault content encrypted at rest. [Filesystem]" .->48
    7-. "Maintains canonical main refs, immutable commit graph, manifests, and merge provenance. [Git-compatible local filesystem]" .->49
    7-. "Uses ephemeral plaintext working trees for server-side merge transactions. [Filesystem]" .->50
    7-. "Emits main advancement, conflict, device state, and maintenance events. [WebSocket]" .->31

  end

```

## structurizr DashboardComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Dashboard SPA"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 23 ["Dashboard SPA"]

        24["AuthSession [Component: TypeScript]"]
        25["ConnectionAuthorizationView [Component: Svelte, TypeScript]"]
        26["DeviceDashboard [Component: TypeScript]"]
        27["ConflictList [Component: TypeScript]"]
        28["MarkdownDiffViewer [Component: TypeScript]"]
        29["SourceDiffViewer [Component: TypeScript]"]
        30["ResolutionEditor [Component: TypeScript]"]
      end

      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    25-. "Reviews, approves, or denies browser connection requests. [HTTPS]" .->7
    24-. "Authenticates dashboard sessions and calls setup/admin APIs. [HTTPS]" .->7
    26-. "Reads authorized device state, server main status, and maintenance summaries. [HTTPS]" .->7
    27-. "Lists unresolved conflicts and fetches authorized conflict review content. [HTTPS]" .->7
    28-. "Fetches Markdown conflict variants and merge previews for rendering. [HTTPS]" .->7
    29-. "Fetches source-level conflict diffs for review. [HTTPS]" .->7
    30-. "Submits selected or manually edited resolution content for server persistence and main advancement. [HTTPS]" .->7

  end

```

## structurizr PluginComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Obsidian plugin"]

    4["Obsidian [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 31 ["Obsidian plugin"]

        32["SettingsView [Component: TypeScript]"]
        33["OnboardingCoordinator [Component: TypeScript]"]
        34["StatusBar [Component: TypeScript]"]
        35["VaultWatcher [Component: TypeScript, Obsidian Vault API]"]
        36["PeriodicScanner [Component: TypeScript]"]
        37["PathNormalizer [Component: TypeScript]"]
        38["SnapshotEngine [Component: TypeScript]"]
        39["LocalQueue [Component: TypeScript]"]
        40["LocalContentCache [Component: TypeScript]"]
        41["MetadataRepair [Component: TypeScript]"]
        42["TransportClient [Component: TypeScript]"]
        43["ApplyEngine [Component: TypeScript, Obsidian Vault API]"]
        44["DiagnosticsExporter [Component: TypeScript]"]
      end

      45["User-visible vault files [Container: Obsidian Vault API and local filesystem]"]
      46[".obts local store [Container: Local filesystem and platform secure storage]"]
      7["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
    end

    32-. "Starts or resumes browser-assisted setup. [TypeScript calls]" .->33
    33-. "Starts and polls connection requests, downloads bootstrap state, completes device registration, and acknowledges onboarding. [HTTPS]" .->7
    35-. "Receives vault change notifications through supported APIs. [Obsidian Vault API]" .->4
    36-. "Scans vault files to detect missed watcher events, commit filesystem differences, and drive crash recovery work. [Obsidian Vault API]" .->45
    38-. "Canonicalizes vault-relative paths before proposal creation. [TypeScript calls]" .->37
    38-. "Reads changed content before enqueueing proposal data. [Obsidian Vault API]" .->45
    38-. "Persists proposal state before upload or destructive local apply. [TypeScript calls]" .->39
    39-. "Stores queue state, proposal payloads, recovery bundles, locks, and diagnostics under .obts. [Filesystem]" .->46
    40-. "Caches content required for retry, pull, apply, and recovery. [Filesystem]" .->46
    41-. "Reads device token and local Git refs, then rewrites recoverable state.json metadata after server rehydration. [Filesystem]" .->46
    41-. "Requests device self metadata without needing a vault ID from state.json. [TypeScript calls]" .->42
    42-. "Calls device self metadata repair, uploads full-vault and causal directory proposals, pulls accepted diffs and exact acknowledgements, observes dashboard conflict state, and subscribes to events. [HTTPS/WSS]" .->7
    43-. "Requires local recovery snapshot before applying destructive server changes. [TypeScript calls]" .->38
    43-. "Materializes accepted server main entries into vault files and managed Obsidian configuration targets. [Obsidian Vault API]" .->45
    34-. "Reads local queue state to show ahead, blocked, retry, and recovery statuses. [TypeScript calls]" .->39
    44-. "Reads local state and writes redacted diagnostic bundles. [Filesystem]" .->46

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    5["Deployment secret source [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 7 ["Server API and CLI"]

        10["VaultService [Component: TypeScript]"]
        11["DeviceService [Component: TypeScript]"]
        12["AtRestKeyManager [Component: TypeScript, Node crypto]"]
        13["ContentStoreService [Component: TypeScript]"]
        14["ProposalService [Component: TypeScript]"]
        15["HistoryService [Component: TypeScript]"]
        16["MergeCoordinator [Component: TypeScript]"]
        17["SemanticMergeService [Component: TypeScript]"]
        18["ConflictService [Component: TypeScript]"]
        19["NotificationHub [Component: TypeScript]"]
        20["BackupService [Component: TypeScript]"]
        21["AuditLogService [Component: TypeScript]"]
        22["HealthService [Component: TypeScript]"]
        8["AuthService [Component: TypeScript]"]
        9["ConnectionService [Component: TypeScript]"]
      end

      23["Dashboard SPA [Container: TypeScript, static SPA]"]
      31["Obsidian plugin [Container: TypeScript, Obsidian Plugin API]"]
      47[("Server metadata database [Container: PostgreSQL]")]
      48["Encrypted-at-rest content store [Container: Local filesystem]"]
      49["Internal history store [Container: Git-compatible local filesystem]"]
      50["Temporary merge workspace [Container: Local filesystem]"]
    end

    22-. "Checks internal history store accessibility. [Filesystem]" .->49
    22-. "Checks key-manager readiness and master key availability. [TypeScript calls]" .->12
    31-. "Starts and polls connection requests, downloads bootstrap state, completes device registration, and acknowledges onboarding. [HTTPS]" .->9
    23-. "Reviews, approves, or denies browser connection requests. [HTTPS]" .->9
    9-. "Stores hashed connection secrets, approval selection, expiry, and onboarding lifecycle state. [Metadata adapter calls]" .->47
    8-. "Reads users and token hashes; writes auth audit metadata. [SQL]" .->47
    10-. "Manages vault records, setup state, owner isolation, and wrapped key metadata. [SQL]" .->47
    10-. "Requests per-vault data key creation for new vaults. [TypeScript calls]" .->12
    11-. "Registers, updates, and revokes devices. [SQL]" .->47
    12-. "Reads runtime master key material without printing or persisting it. [Environment variable, secret mount, or KMS API]" .->5
    12-. "Stores and reads wrapped per-vault data keys and key version metadata. [SQL]" .->47
    13-. "Requests per-vault data keys for encryption/decryption at persistence boundaries. [TypeScript calls]" .->12
    13-. "Writes encrypted-at-rest content bytes and reads them for authorized workflows. [Filesystem]" .->48
    13-. "Records content catalog metadata, hashes, sizes, and storage refs. [SQL]" .->47
    14-. "Persists uploaded content before accepting proposals. [TypeScript calls]" .->13
    14-. "Submits actor-device proposal manifests for server-side merge or conflict routing without adopting another device ref. [TypeScript calls]" .->16
    15-. "Reads and writes commit graph, manifests, refs, and merge provenance. [Filesystem]" .->49
    15-. "Records main refs, commit indexes, and transaction state. [SQL]" .->47
    16-. "Reads base/current/proposed manifests and advances main after clean merge or resolution. [TypeScript calls]" .->15
    16-. "Decrypts candidate content for merge and persists merged results encrypted at rest. [TypeScript calls]" .->13
    16-. "Checks out transaction-scoped plaintext working trees for content-aware merge. [Filesystem]" .->50
    16-. "Requests conservative text and Markdown merge for same-path changes. [TypeScript calls]" .->17
    17-. "Reads and writes plaintext merge candidates inside the transaction workspace. [Filesystem]" .->50
    16-. "Creates conflict records when server-side merge is ambiguous or unsafe. [TypeScript calls]" .->18
    18-. "Stores conflict state, affected paths, base/current/proposed refs, and resolution refs. [SQL]" .->47
    18-. "Reads conflict variants and persists resolution content encrypted at rest. [TypeScript calls]" .->13
    19-. "Emits main advancement, conflict, device state, and maintenance events. [WebSocket]" .->31
    20-. "Reads or snapshots server metadata and wrapped key metadata for backup and restore. [SQL]" .->47
    20-. "Copies encrypted-at-rest content during backup and restore. [Filesystem]" .->48
    20-. "Copies internal history state during backup and restore. [Filesystem]" .->49
    21-. "Writes redacted audit events without raw tokens, passwords, key material, or full note bodies. [SQL]" .->47
    22-. "Checks database readiness. [SQL]" .->47
    22-. "Checks encrypted content store writability. [Filesystem]" .->48

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

    1-. "Self-hosts, creates vaults, approves device connections, reviews conflicts, and runs maintenance. [HTTPS and Obsidian UI]" .->6
    2-. "Edits notes and observes sync status through connected Obsidian clients. [Obsidian UI]" .->6
    3-. "Runs server CLI commands such as doctor, backup, restore, compact, key rewrap, and version. [CLI]" .->6
    3-. "Provides and rotates server master key material outside the app repository. [Operational procedure]" .->5
    6-. "Integrates as a community plugin and uses vault/workspace/plugin lifecycle APIs. [Obsidian Plugin API]" .->4
    6-. "Loads server master key material for per-vault data key unwrap and rewrap operations. [Environment variable, secret mount, or KMS API]" .->5

  end

```

