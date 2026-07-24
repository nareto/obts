workspace "Obsidian True Sync (obts)" "Implementation-derived architecture for the Obsidian plugin, Fastify server, dashboard, and Git-backed synchronization model." {
  !identifiers hierarchical

  model {
    vaultOwner = person "Vault owner" "Connects devices, reviews conflicts, and operates the self-hosted service."
    deviceUser = person "Device user" "Edits notes in Obsidian and observes synchronization state."
    operator = person "Operator" "Deploys, upgrades, diagnoses, backs up, and repairs the service."

    obsidian = softwareSystem "Obsidian" "Desktop and mobile note-taking application hosting the obts community plugin."

    obts = softwareSystem "Obsidian True Sync" "Self-hosted, full-vault synchronization with local Git journals, server-authoritative merge, durable conflicts, history, and recovery." {
      !docs docs
      !adrs adrs

      plugin = container "Obsidian plugin" "Scans the visible vault, journals immutable local snapshots, uploads durable proposals, applies canonical main, and reports status." "JavaScript, TypeScript, Obsidian Plugin API" {
        vaultWatcher = component "Vault watcher" "Records change hints without replacing an in-flight upload target." "Obsidian Vault API"
        syncCoordinator = component "Sync coordinator" "Serializes local operations and drives scan, upload, result retrieval, pull, and apply phases." "JavaScript"
        snapshotEngine = component "Snapshot engine" "Hashes visible files with bounded concurrency and writes local Git commits under .obts/git." "isomorphic-git"
        uploadJournal = component "Upload journal" "Persists one immutable target, directory proposal, object groups, attempt ID, and transfer ID until an authoritative result is consumed." "JSON under .obts"
        transportClient = component "Transport client" "Creates/resumes chunk transfers, uploads missing chunks, requests asynchronous finalization, and polls terminal outcomes." "HTTPS"
        directoryTracker = component "Directory tracker" "Persists causal empty-directory intents and exact acknowledgement generations." "JSON under .obts"
        applyEngine = component "Apply and recovery engine" "Stages recovery evidence and safely materializes accepted files and explicit directories through Obsidian APIs." "Obsidian Vault API"
        statusSurface = component "Status surface" "Shows monotonic checking, preparing, uploading, merging, applying, and settled states." "Obsidian UI"
      }

      dashboard = container "Dashboard SPA" "Authenticated device status, conflict review, diagnostics, history, and maintenance UI served by the server." "Svelte, TypeScript, Vite" {
        apiClient = component "API client" "Calls authenticated dashboard endpoints." "TypeScript"
        deviceViews = component "Device views" "Shows fresh server-derived device convergence and health." "Svelte"
        conflictWorkbench = component "Conflict workbench" "Reviews and resolves content, directory, and mixed conflicts." "Svelte"
        diagnosticsView = component "Diagnostics view" "Shows consented redacted client diagnostics and operational status." "Svelte"
      }

      server = container "Server API and CLI" "Authenticates clients, receives immutable proposals, fairly serializes canonical integration, merges Git history, persists conflicts, serves the dashboard, and exposes operator commands." "TypeScript, Node.js, Fastify" {
        authService = component "Auth service" "Authenticates dashboard sessions, connection requests, and vault-scoped device tokens." "TypeScript"
        connectionService = component "Connection service" "Runs browser-assisted device onboarding and idempotent registration." "TypeScript"
        chunkTransferService = component "Chunk transfer service" "Persists bounded Git chunks and transfer descriptors, returns prompt asynchronous acceptance, and resumes processing when clients poll after restart." "TypeScript"
        syncService = component "Sync service" "Validates proposals and serializes each vault's integration. Ref movement changes merge classification rather than acceptance of valid uploaded bytes." "TypeScript"
        gitService = component "Git service" "Uses batched tree inspection and object-level merge operations for refs, validation, merge, history, and conflict retention." "Native Git"
        metadataStoreService = component "Metadata store" "Atomically persists users, vaults, devices, operations, transfer-independent proposal outcomes, events, and conflicts." "TypeScript"
        diagnosticService = component "Diagnostic service" "Accepts and retains opt-in redacted client diagnostics." "TypeScript"
        dashboardHost = component "Dashboard host" "Serves the built SPA and dashboard APIs." "Fastify"
      }

      localVault = container "Visible vault" "User-controlled Obsidian files. The filesystem is the device source of truth." "Obsidian Vault API, filesystem" "File System"
      localStore = container ".obts local store" "Local Git journal, immutable upload journal, queue, causal directory state, apply journal, credentials, and recovery bundles. Excluded from synchronization." "Filesystem" "File System"
      metadataStore = container "Metadata store" "Durable JSON metadata for accounts, devices, operations, events, conflicts, and directory proposal outcomes." "JSON file adapter" "Database"
      gitStore = container "Vault Git stores" "Bare repositories containing canonical main, protected device refs, conflict refs, and immutable Git objects." "Native Git bare repositories" "File System"
      transferStore = container "Transfer quarantine" "Durable resumable transfer sessions and validated staged Git objects, including processing and terminal outcomes." "Filesystem, temporary bare Git repositories" "File System"
      mergeWorkspace = container "Semantic merge workspace" "Transaction-scoped plaintext materialization used only for overlapping content requiring semantic validation." "Temporary filesystem" "File System"
    }

    vaultOwner -> obts.dashboard "Connects devices and reviews conflicts" "HTTPS" {
      properties {
        "ops" "admin,read,write"
        "protocol" "HTTPS"
      }
    }
    deviceUser -> obts.plugin "Edits notes and observes synchronization" "Obsidian UI" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian UI"
      }
    }
    operator -> obts.server "Runs setup, health, repair, and maintenance commands" "CLI and HTTPS" {
      properties {
        "ops" "admin"
        "protocol" "CLI,HTTPS"
      }
    }
    obts.plugin -> obsidian "Uses plugin lifecycle, vault, workspace, request, and status APIs" "Obsidian Plugin API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Plugin API"
      }
    }
    obts.server -> obts.dashboard "Serves static dashboard assets" "HTTP" {
      properties {
        "ops" "read"
        "protocol" "HTTP"
      }
    }
    obts.dashboard -> obts.server "Calls authenticated dashboard and conflict APIs" "HTTPS" {
      properties {
        "ops" "read,write,admin"
        "protocol" "HTTPS"
        "data" "device metadata, conflict reviews, resolutions, diagnostics"
      }
    }
    obts.plugin -> obts.server "Uploads immutable Git/directory proposals, polls processing outcomes, pulls canonical state, and reports status" "HTTPS" {
      properties {
        "ops" "read,write"
        "protocol" "HTTPS"
        "data" "Git object chunks, proposal metadata, directory intents, pull packs, events"
      }
    }
    obts.plugin -> obts.localVault "Scans and safely applies visible vault content" "Obsidian Vault API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Vault API"
        "write-surface" "vault files excluding .obts"
      }
    }
    obts.plugin -> obts.localStore "Persists local journal, immutable upload identity, credentials, cursors, and recovery evidence" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/"
      }
    }
    obts.server -> obts.metadataStore "Reads and atomically replaces application metadata" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "accounts, devices, operations, events, conflicts, directory state"
      }
    }
    obts.server -> obts.gitStore "Validates objects and maintains canonical, device, and conflict refs" "Git object and ref operations" {
      properties {
        "ops" "read,write"
        "protocol" "native-git,filesystem"
        "data" "commits, trees, blobs, refs"
      }
    }
    obts.server -> obts.transferStore "Persists resumable chunks, staged objects, and asynchronous terminal results" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "data" "transfer descriptors, receipts, staged Git objects"
      }
    }
    obts.server -> obts.mergeWorkspace "Materializes only overlapping candidates requiring semantic validation" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" "transaction-scoped temporary directory"
      }
    }

    obts.plugin.vaultWatcher -> obts.plugin.syncCoordinator "Queues durable change hints" "In-process calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }
    obts.plugin.syncCoordinator -> obts.plugin.snapshotEngine "Requests a coherent snapshot only when no upload target is in flight" "In-process calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }
    obts.plugin.snapshotEngine -> obts.localVault "Reads syncable files" "Obsidian DataAdapter" {
      properties {
        "ops" "read"
        "protocol" "Obsidian DataAdapter"
      }
    }
    obts.plugin.snapshotEngine -> obts.localStore "Writes Git objects and local refs" "isomorphic-git filesystem adapter" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/git"
      }
    }
    obts.plugin.syncCoordinator -> obts.plugin.uploadJournal "Creates or resumes exactly one immutable attempt" "In-process calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }
    obts.plugin.uploadJournal -> obts.localStore "Persists upload-transfer.json until terminal result consumption" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/upload-transfer.json"
      }
    }
    obts.plugin.syncCoordinator -> obts.plugin.transportClient "Uploads or retrieves the journaled attempt before scanning later edits" "In-process calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }
    obts.plugin.transportClient -> obts.server.chunkTransferService "Creates/resumes transfers, uploads missing packs, requests async processing, and polls" "HTTPS" {
      properties {
        "ops" "read,write"
        "protocol" "HTTPS"
        "data" "attempt ID, plan digest, Git chunks, transfer status"
      }
    }
    obts.plugin.directoryTracker -> obts.localStore "Persists observed directories and causal intent generations" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/directory-state.json"
      }
    }
    obts.plugin.syncCoordinator -> obts.plugin.applyEngine "Applies canonical main only after pending proposal outcomes settle" "In-process calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }
    obts.plugin.applyEngine -> obts.localVault "Writes accepted files and safely creates/removes explicit directories" "Obsidian Vault API" {
      properties {
        "ops" "read,write"
        "protocol" "Obsidian Vault API"
      }
    }
    obts.plugin.applyEngine -> obts.localStore "Stages recovery bundles and crash journals before mutation" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
        "write-surface" ".obts/recovery,.obts/apply-journal.json"
      }
    }
    obts.plugin.statusSurface -> obts.plugin.syncCoordinator "Observes monotonic operation progress" "In-process calls" {
      properties {
        "ops" "read"
        "protocol" "in-process"
      }
    }

    obts.server.chunkTransferService -> obts.transferStore "Stores receipts, staged objects, processing state, and terminal results" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
      }
    }
    obts.server.chunkTransferService -> obts.server.syncService "Queues a validated immutable proposal for canonical integration" "In-process calls" {
      properties {
        "ops" "write"
        "protocol" "in-process"
      }
    }
    obts.server.syncService -> obts.server.gitService "Checks ancestry, validates trees, and creates merge or protected conflict history" "In-process calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }
    obts.server.syncService -> obts.server.metadataStoreService "Persists operation phases, merge order, events, acknowledgements, and conflicts" "In-process calls" {
      properties {
        "ops" "read,write"
        "protocol" "in-process"
      }
    }
    obts.server.gitService -> obts.gitStore "Runs batched tree inspection, object promotion, merge-tree, commit-tree, and ref CAS" "Native Git" {
      properties {
        "ops" "read,write"
        "protocol" "native-git"
      }
    }
    obts.server.gitService -> obts.transferStore "Reads validated staged objects and promotes them after policy checks" "Git alternates and filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "native-git,filesystem"
      }
    }
    obts.server.gitService -> obts.mergeWorkspace "Materializes semantic overlap candidates only" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
      }
    }
    obts.server.metadataStoreService -> obts.metadataStore "Atomically reads and replaces durable metadata" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
      }
    }
    obts.server.dashboardHost -> obts.dashboard "Serves built assets" "HTTP" {
      properties {
        "ops" "read"
        "protocol" "HTTP"
      }
    }
    obts.server.diagnosticService -> obts.metadataStore "Stores consented redacted diagnostic events" "Filesystem" {
      properties {
        "ops" "read,write"
        "protocol" "filesystem"
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

    component obts.dashboard "DashboardComponents" {
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
