workspace "Obsidian True Sync (obts)" "PRD-derived architecture model for the doc-only obts repository." {
  !identifiers hierarchical

  model {
    vaultOwner = person "Vault owner" "Installs the self-hosted server, creates vaults, pairs devices, reviews conflicts, and runs maintenance."
    deviceUser = person "Device user" "Edits notes in Obsidian and observes sync status on paired devices."
    maintainer = person "Maintainer/operator" "Upgrades the server and plugin, runs backups, rotates server key material, and reviews diagnostics."

    obsidian = softwareSystem "Obsidian" "External desktop and mobile note-taking application that hosts the community plugin and owns vault APIs."
    masterKeySource = softwareSystem "Deployment secret source" "Operator-provided runtime source for the server master key, such as an environment variable, mounted secret, or future KMS integration."

    obts = softwareSystem "Obsidian True Sync" "Self-hosted Obsidian sync system using a trusted server model with encrypted-at-rest vault storage. This model is derived from prd.md; implementation files are not present yet." {
      !docs docs
      !adrs adrs

      server = container "Server API and CLI" "PRD-specified Node/Fastify service that authenticates users/devices, stores vault content encrypted at rest, performs server-side merge/conflict workflows, serves the dashboard, and provides operator commands." "TypeScript, Node.js, Fastify" {
        authService = component "AuthService" "Authenticates dashboard sessions, device tokens, and one-time pairing tokens while storing only token hashes." "TypeScript"
        vaultService = component "VaultService" "Creates vaults, manages owner isolation, and coordinates initial per-vault data key creation." "TypeScript"
        deviceService = component "DeviceService" "Registers, tracks, revokes, and updates paired devices and their server-known state." "TypeScript"
        keyManager = component "AtRestKeyManager" "Loads server master key material, creates and wraps per-vault data keys, unwraps keys in memory, and rewraps keys during rotation." "TypeScript, Node crypto"
        contentStoreService = component "ContentStoreService" "Encrypts/decrypts vault content at persistence boundaries and maintains content catalog metadata." "TypeScript"
        proposalService = component "ProposalService" "Receives idempotent per-device proposals and records their lifecycle." "TypeScript"
        historyService = component "HistoryService" "Maintains canonical main, commit graph, manifests, refs, and merge provenance." "TypeScript"
        mergeCoordinator = component "MergeCoordinator" "Runs server-side merge and resolution transactions, advancing main or routing ambiguous changes to conflicts." "TypeScript"
        semanticMergeService = component "SemanticMergeService" "Performs conservative text, Markdown, frontmatter, and block-aware merge in a server temp workspace." "TypeScript"
        conflictService = component "ConflictService" "Creates, lists, renders, and resolves structured conflict records." "TypeScript"
        notificationHub = component "NotificationHub" "Publishes main, conflict, device, and maintenance events with polling fallback." "TypeScript"
        backupService = component "BackupService" "Creates and restores consistent server backups across metadata, wrapped keys, encrypted content, and history." "TypeScript"
        auditLogService = component "AuditLogService" "Writes redacted operational audit events." "TypeScript"
        healthService = component "HealthService" "Reports liveness, readiness, version, migration, storage, and key-manager health." "TypeScript"
      }

      web = container "Dashboard SPA" "PRD-specified browser UI for setup, device state, conflict review, resolution, and maintenance after normal dashboard login." "TypeScript, static SPA" {
        authSession = component "AuthSession" "Manages dashboard session state." "TypeScript"
        deviceDashboard = component "DeviceDashboard" "Shows paired devices, server main, and stale/offline status." "TypeScript"
        conflictList = component "ConflictList" "Lists unresolved conflicts and opens review workflows." "TypeScript"
        markdownDiffViewer = component "MarkdownDiffViewer" "Renders Markdown conflict variants and merge previews returned by server APIs." "TypeScript"
        sourceDiffViewer = component "SourceDiffViewer" "Shows source-level conflict diffs without writing raw conflict markers into notes." "TypeScript"
        resolutionEditor = component "ResolutionEditor" "Lets the owner accept server, accept device, keep both, or author a manual merged result." "TypeScript"
      }

      plugin = container "Obsidian plugin" "Obsidian community plugin that treats visible vault files as the device source of truth, journals them in local Git, rehydrates recoverable metadata, uploads device refs, applies server main, and exposes sync status." "TypeScript, Obsidian Plugin API" {
        settingsView = component "SettingsView" "Collects server URL, pairing token/login, and device name." "TypeScript"
        statusBar = component "StatusBar" "Displays Synced, Ahead, Behind, Uploading, Applying, Offline, Blocked, Unsafe local error, and Needs recovery states." "TypeScript"
        vaultWatcher = component "VaultWatcher" "Observes local vault changes through Obsidian APIs." "TypeScript, Obsidian Vault API"
        periodicScanner = component "PeriodicScanner" "Finds missed changes and supports recovery after watcher or client crashes." "TypeScript"
        pathNormalizer = component "PathNormalizer" "Creates canonical vault-relative paths using slash separators and normalized Unicode." "TypeScript"
        snapshotEngine = component "SnapshotEngine" "Persists local edits as durable proposals before upload or destructive apply operations." "TypeScript"
        localQueue = component "LocalQueue" "Stores pending proposal, retry, cache, recovery, lock, diagnostic, and managed-config state under .obts." "TypeScript"
        localContentCache = component "LocalContentCache" "Caches content needed for retry, pull, apply, and recovery." "TypeScript"
        metadataRepair = component "MetadataRepair" "Uses device-token auth and local Git refs to rehydrate lost state.json metadata before normal sync decisions." "TypeScript"
        transportClient = component "TransportClient" "Calls server APIs, rehydrates device identity metadata, uploads full-vault content/proposals, pulls diffs, and subscribes to events with polling fallback." "TypeScript"
        applyEngine = component "ApplyEngine" "Applies accepted server main changes inside the full-vault path policy after creating local recovery snapshots." "TypeScript, Obsidian Vault API"
        diagnosticsExporter = component "DiagnosticsExporter" "Exports redacted diagnostics for support and recovery workflows." "TypeScript"
      }

      localVault = container "User-visible vault files" "Local Obsidian vault content on a paired device. This visible filesystem is the device source of truth; the plugin reads/writes it through Obsidian APIs and must not place a .git directory here." "Obsidian Vault API and local filesystem" "File System"
      localStore = container ".obts local store" "Client-local Git journal, recoverable state.json metadata, queue, cache, recovery bundles, locks, diagnostics, and device token state. It is excluded from sync scanning and manifest creation." "Local filesystem and platform secure storage" "File System"
      postgres = container "Server metadata database" "Stores users, vaults, wrapped data keys, devices, token hashes, content catalog, commits, manifest entries, proposals, conflicts, and audit records." "PostgreSQL" "Database"
      contentStore = container "Encrypted-at-rest content store" "Stores vault file bytes, attachments, conflict payloads, recovery bundles, and compacted snapshots encrypted with per-vault data keys." "Local filesystem" "File System"
      historyStore = container "Internal history store" "Stores immutable commit graph, branch-like refs, manifests, and merge provenance. Content bytes are persisted through the encrypted content store." "Git-compatible local filesystem" "File System"
      mergeWorkspace = container "Temporary merge workspace" "Ephemeral plaintext working trees used by server merge operations and cleaned after each merge transaction." "Local filesystem" "File System"
    }

    vaultOwner -> obts "Self-hosts, creates vaults, pairs devices, reviews conflicts, and runs maintenance." "HTTPS and Obsidian UI" {
      properties {
        "ops" "admin,read,write"
        "protocol" "HTTPS"
      }
    }

    deviceUser -> obts "Edits notes and observes sync status through paired Obsidian clients." "Obsidian UI" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian UI"
      }
    }

    maintainer -> obts.server "Runs server CLI commands such as doctor, backup, restore, compact, key rewrap, and version." "CLI" {
      properties {
        "ops" "admin"
        "protocol" "CLI"
      }
    }

    maintainer -> masterKeySource "Provides and rotates server master key material outside the app repository." "Operational procedure" {
      properties {
        "ops" "admin"
        "protocol" "deployment-secret"
      }
    }

    obts -> obsidian "Integrates as a community plugin and uses vault/workspace/plugin lifecycle APIs." "Obsidian Plugin API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Plugin API"
      }
    }

    vaultOwner -> obts.web "Uses setup, device dashboard, conflict center, and maintenance views after dashboard login." "HTTPS" {
      properties {
        "ops" "admin,read,write"
        "protocol" "HTTPS"
      }
    }

    deviceUser -> obts.plugin "Uses sync status, commands, and conflict alerts while editing in Obsidian." "Obsidian UI" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian UI"
      }
    }

    obts.server -> obts.web "Serves static dashboard assets." "HTTP" {
      properties {
        "ops" "read"
        "protocol" "HTTP"
      }
    }

    obts.web -> obts.server "Calls setup, dashboard, conflict, resolution, key rewrap, compact, and health APIs." "HTTPS" {
      properties {
        "ops" "read,write,admin"
        "protocol" "HTTPS"
        "data" "authorized dashboard data, conflict content, resolutions, device metadata"
      }
    }

    obts.plugin -> obsidian "Uses vault, workspace, settings, status bar, command, and request APIs." "Obsidian Plugin API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Plugin API"
      }
    }

    obts.plugin -> obts.server "Pairs devices, rehydrates identity/ref metadata, uploads content and proposals, pulls diffs, receives conflict state, and subscribes to events." "HTTPS/WSS" {
      properties {
        "ops" "read,write,consume"
        "protocol" "HTTPS,WSS"
        "data" "non-secret device metadata, vault paths, content, proposals, diffs, events over TLS"
      }
    }

    obts.plugin -> obts.localVault "Reads local vault content as the device source of truth and applies accepted server main changes after local recovery snapshots." "Obsidian Vault API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Vault API"
        "write-surface" "vault files excluding .obts"
      }
    }

    obts.plugin -> obts.localStore "Persists local Git journal, recoverable metadata, durable local proposals, content cache, recovery bundles, cursors, diagnostics, and device token state." "Local filesystem and platform secure storage" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem,secure-storage"
        "write-surface" ".obts/"
      }
    }

    obts.server -> masterKeySource "Loads server master key material for per-vault data key unwrap and rewrap operations." "Environment variable, secret mount, or KMS API" {
      properties {
        "ops" "read"
        "protocol" "deployment-secret"
        "config" "OBTS_MASTER_KEY or equivalent secret source"
      }
    }

    obts.server -> obts.postgres "Reads and writes account, vault, wrapped key, device, token, content catalog, proposal, conflict, audit, and history metadata." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "metadata and wrapped data keys"
      }
    }

    obts.server -> obts.contentStore "Stores and reads vault content encrypted at rest." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "encrypted content bytes, conflict payloads, recovery bundles"
      }
    }

    obts.server -> obts.historyStore "Maintains canonical main refs, immutable commit graph, manifests, and merge provenance." "Git-compatible local filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "commit graph, refs, manifests"
      }
    }

    obts.server -> obts.mergeWorkspace "Uses ephemeral plaintext working trees for server-side merge transactions." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "temporary plaintext merge files"
        "write-surface" "transaction-scoped temp directory"
      }
    }

    obts.server.authService -> obts.postgres "Reads users and token hashes; writes auth audit metadata." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "users,api_tokens,audit_log"
      }
    }

    obts.server.vaultService -> obts.postgres "Manages vault records, setup state, owner isolation, and wrapped key metadata." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "vaults,vault_keys"
      }
    }

    obts.server.vaultService -> obts.server.keyManager "Requests per-vault data key creation for new vaults." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.server.deviceService -> obts.postgres "Registers, updates, and revokes devices." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "devices,api_tokens"
      }
    }

    obts.server.keyManager -> masterKeySource "Reads runtime master key material without printing or persisting it." "Environment variable, secret mount, or KMS API" {
      properties {
        "ops" "read"
        "protocol" "deployment-secret"
        "config" "OBTS_MASTER_KEY or equivalent secret source"
      }
    }

    obts.server.keyManager -> obts.postgres "Stores and reads wrapped per-vault data keys and key version metadata." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "vault_keys"
      }
    }

    obts.server.contentStoreService -> obts.server.keyManager "Requests per-vault data keys for encryption/decryption at persistence boundaries." "TypeScript calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.server.contentStoreService -> obts.contentStore "Writes encrypted-at-rest content bytes and reads them for authorized workflows." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "encrypted content bytes"
      }
    }

    obts.server.contentStoreService -> obts.postgres "Records content catalog metadata, hashes, sizes, and storage refs." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "content_objects"
      }
    }

    obts.server.proposalService -> obts.server.contentStoreService "Persists uploaded content before accepting proposals." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.server.proposalService -> obts.server.mergeCoordinator "Submits proposal manifests for server-side merge or conflict routing." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.server.historyService -> obts.historyStore "Reads and writes commit graph, manifests, refs, and merge provenance." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "commits,refs,manifests"
      }
    }

    obts.server.historyService -> obts.postgres "Records main refs, commit indexes, and transaction state." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "commits,manifest_entries"
      }
    }

    obts.server.mergeCoordinator -> obts.server.historyService "Reads base/current/proposed manifests and advances main after clean merge or resolution." "TypeScript calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }

    obts.server.mergeCoordinator -> obts.server.contentStoreService "Decrypts candidate content for merge and persists merged results encrypted at rest." "TypeScript calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }

    obts.server.mergeCoordinator -> obts.mergeWorkspace "Checks out transaction-scoped plaintext working trees for content-aware merge." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "temporary plaintext merge files"
      }
    }

    obts.server.mergeCoordinator -> obts.server.semanticMergeService "Requests conservative text and Markdown merge for same-path changes." "TypeScript calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }

    obts.server.semanticMergeService -> obts.mergeWorkspace "Reads and writes plaintext merge candidates inside the transaction workspace." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "temporary plaintext merge files"
      }
    }

    obts.server.mergeCoordinator -> obts.server.conflictService "Creates conflict records when server-side merge is ambiguous or unsafe." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.server.conflictService -> obts.postgres "Stores conflict state, affected paths, base/current/proposed refs, and resolution refs." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "conflicts"
      }
    }

    obts.server.conflictService -> obts.server.contentStoreService "Reads conflict variants and persists resolution content encrypted at rest." "TypeScript calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }

    obts.server.notificationHub -> obts.plugin "Emits main advancement, conflict, device state, and maintenance events." "WebSocket" {
      properties {
        "ops" "publish"
        "protocol" "WSS"
        "data" "authorized event metadata"
      }
    }

    obts.server.backupService -> obts.postgres "Reads or snapshots server metadata and wrapped key metadata for backup and restore." "SQL" {
      properties {
        "ops" "read,write"
        "protocol" "SQL"
        "data" "consistent metadata snapshot"
      }
    }

    obts.server.backupService -> obts.contentStore "Copies encrypted-at-rest content during backup and restore." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "encrypted content files"
      }
    }

    obts.server.backupService -> obts.historyStore "Copies internal history state during backup and restore." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "history store"
      }
    }

    obts.server.auditLogService -> obts.postgres "Writes redacted audit events without raw tokens, passwords, key material, or full note bodies." "SQL" {
      properties {
        "ops" "write"
        "protocol" "SQL"
        "data" "audit_log"
      }
    }

    obts.server.healthService -> obts.postgres "Checks database readiness." "SQL" {
      properties {
        "ops" "read"
        "protocol" "SQL"
      }
    }

    obts.server.healthService -> obts.contentStore "Checks encrypted content store writability." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
      }
    }

    obts.server.healthService -> obts.historyStore "Checks internal history store accessibility." "Filesystem" {
      properties {
        "ops" "read"
        "protocol" "filesystem"
      }
    }

    obts.server.healthService -> obts.server.keyManager "Checks key-manager readiness and master key availability." "TypeScript calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.plugin.settingsView -> obts.server "Consumes pairing tokens and stores device registration metadata locally." "HTTPS" {
      properties {
        "ops" "write"
        "protocol" "HTTPS"
        "data" "pairing token, device capabilities, device token response"
      }
    }

    obts.plugin.vaultWatcher -> obsidian "Receives vault change notifications through supported APIs." "Obsidian Vault API" {
      properties {
        "ops" "read"
        "protocol" "Obsidian Vault API"
      }
    }

    obts.plugin.periodicScanner -> obts.localVault "Scans vault files to detect missed watcher events, commit filesystem differences, and drive crash recovery work." "Obsidian Vault API" {
      properties {
        "ops" "read"
        "protocol" "Obsidian Vault API"
      }
    }

    obts.plugin.snapshotEngine -> obts.plugin.pathNormalizer "Canonicalizes vault-relative paths before proposal creation." "TypeScript calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.plugin.snapshotEngine -> obts.localVault "Reads changed content before enqueueing proposal data." "Obsidian Vault API" {
      properties {
        "ops" "read"
        "protocol" "Obsidian Vault API"
      }
    }

    obts.plugin.snapshotEngine -> obts.plugin.localQueue "Persists proposal state before upload or destructive local apply." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.plugin.localQueue -> obts.localStore "Stores queue state, proposal payloads, recovery bundles, locks, and diagnostics under .obts." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/"
      }
    }

    obts.plugin.localContentCache -> obts.localStore "Caches content required for retry, pull, apply, and recovery." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/content"
      }
    }

    obts.plugin.metadataRepair -> obts.localStore "Reads device token and local Git refs, then rewrites recoverable state.json metadata after server rehydration." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "device token presence, Git refs, state metadata"
        "write-surface" ".obts/"
      }
    }

    obts.plugin.metadataRepair -> obts.plugin.transportClient "Requests device self metadata without needing a vault ID from state.json." "TypeScript calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.plugin.transportClient -> obts.server "Calls device self metadata repair, uploads full-vault content and proposals, pulls diffs, lists conflict state, and subscribes to events." "HTTPS/WSS" {
      properties {
        "ops" "read,write,consume"
        "protocol" "HTTPS,WSS"
        "data" "non-secret device metadata, vault content, scoped proposals, diffs, events over TLS"
      }
    }

    obts.plugin.applyEngine -> obts.plugin.snapshotEngine "Requires local recovery snapshot before applying destructive server changes." "TypeScript calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }

    obts.plugin.applyEngine -> obts.localVault "Materializes accepted server main entries into vault files and managed Obsidian configuration targets." "Obsidian Vault API" {
      properties {
        "ops" "write"
        "protocol" "Obsidian Vault API"
        "write-surface" "vault files and managed config targets"
      }
    }

    obts.plugin.statusBar -> obts.plugin.localQueue "Reads local queue state to show ahead, blocked, retry, and recovery statuses." "TypeScript calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.plugin.diagnosticsExporter -> obts.localStore "Reads local state and writes redacted diagnostic bundles." "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "redacted diagnostics"
      }
    }

    obts.web.authSession -> obts.server "Authenticates dashboard sessions and calls setup/admin APIs." "HTTPS" {
      properties {
        "ops" "read,write,admin"
        "protocol" "HTTPS"
      }
    }

    obts.web.deviceDashboard -> obts.server "Reads authorized device state, server main status, and maintenance summaries." "HTTPS" {
      properties {
        "ops" "read"
        "protocol" "HTTPS"
        "data" "device metadata, main IDs, maintenance status"
      }
    }

    obts.web.conflictList -> obts.server "Lists unresolved conflicts and fetches authorized conflict review content." "HTTPS" {
      properties {
        "ops" "read"
        "protocol" "HTTPS"
        "data" "conflict metadata and review content"
      }
    }

    obts.web.markdownDiffViewer -> obts.server "Fetches Markdown conflict variants and merge previews for rendering." "HTTPS" {
      properties {
        "ops" "read"
        "protocol" "HTTPS"
        "data" "authorized conflict content"
      }
    }

    obts.web.sourceDiffViewer -> obts.server "Fetches source-level conflict diffs for review." "HTTPS" {
      properties {
        "ops" "read"
        "protocol" "HTTPS"
        "data" "authorized conflict content"
      }
    }

    obts.web.resolutionEditor -> obts.server "Submits selected or manually edited resolution content for server persistence and main advancement." "HTTPS" {
      properties {
        "ops" "write"
        "protocol" "HTTPS"
        "data" "authorized resolution content"
      }
    }
  }

  views {
    systemContext obts "SystemContext" {
      include *
      autoLayout lr
    }

    container obts "Containers" {
      include *
      autoLayout lr
    }

    component obts.server "ServerComponents" {
      include *
      autoLayout lr
    }

    component obts.plugin "PluginComponents" {
      include *
      autoLayout lr
    }

    component obts.web "DashboardComponents" {
      include *
      autoLayout lr
    }

    styles {
      element "Person" {
        shape person
      }
      element "Software System" {
        background "#1168bd"
        color "#ffffff"
      }
      element "Container" {
        background "#438dd5"
        color "#ffffff"
      }
      element "Component" {
        background "#85bbf0"
        color "#000000"
      }
      element "Database" {
        shape cylinder
      }
      relationship "Relationship" {
        color "#707070"
      }
    }
  }

  configuration {
    scope softwaresystem
  }
}
