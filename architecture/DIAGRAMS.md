# Architecture Diagrams

_Generated from `workspace.dsl`; do not edit by hand._

## structurizr Containers

```mermaid
graph LR

  subgraph diagram ["Container View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Operator [Person]"]
    4["Automation agent [Person]"]
    5["Obsidian [Software System]"]

    subgraph 6 ["Obsidian True Sync"]

      17["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      24["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      33["OBTS Bridge API and indexer [Container: Rust, Axum, SQLx]"]
      34["Headless OBTS client [Container: Node.js, TypeScript]"]
      35["Bridge visible vault and .obts state [Container: Filesystem]"]
      36[("Bridge PostgreSQL state [Container: PostgreSQL, pgvector]")]
      37["Visible vault [Container: Obsidian Vault API, filesystem]"]
      38[".obts local store [Container: Filesystem]"]
      39[("Metadata store [Container: JSON file adapter]")]
      40["Vault Git stores [Container: Native Git bare repositories]"]
      41["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      42["Semantic merge workspace [Container: Temporary filesystem]"]
      7["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    1-. "Connects devices and reviews conflicts [HTTPS]" .->17
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->7
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->24
    4-. "Uses context-scoped note, search, graph, Base, create, and edit tools [REST, MCP]" .->33
    7-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->5
    24-. "Serves static dashboard assets [HTTP]" .->17
    17-. "Calls authenticated dashboard and conflict APIs [HTTPS]" .->24
    7-. "Uploads immutable Git/directory proposals, polls processing outcomes, pulls canonical state, and reports status [HTTPS]" .->24
    33-. "Supervises lifecycle and sends administrative or synchronization commands [JSON Lines over stdin/stdout]" .->34
    33-. "Reads selected ordinary files under the shared headless/filesystem lock, verifies revision/OID, and atomically writes authorized files; releases bounded body work after each operation [Filesystem]" .->35
    33-. "Queries paginated ACL-visible metadata and candidates, writes verified derived batches/cursors, and retains access/audit records without a full snapshot or raw-body fallback [PostgreSQL]" .->36
    34-. "Owns visible-state reconciliation, hidden Git, credentials, journals, queues, apply, and recovery [Filesystem]" .->35
    34-. "Pairs and synchronizes as a normal protected OBTS device [HTTPS]" .->24
    7-. "Scans and safely applies visible vault content [Obsidian Vault API]" .->37
    7-. "Persists local journal, immutable upload identity, credentials, cursors, and recovery evidence [Filesystem]" .->38
    24-. "Reads and atomically replaces application metadata [Filesystem]" .->39
    24-. "Validates objects and maintains canonical, device, and conflict refs [Git object and ref operations]" .->40
    24-. "Persists resumable chunks, staged objects, and asynchronous terminal results [Filesystem]" .->41
    24-. "Materializes only overlapping candidates requiring semantic validation [Filesystem]" .->42

  end

```

## structurizr DashboardComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Dashboard SPA"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 17 ["Dashboard SPA"]

        18["API client [Component: TypeScript]"]
        19["Session and vault state [Component: Svelte]"]
        20["Overview and device views [Component: Svelte]"]
        21["Conflict workbench [Component: Svelte]"]
        22["History and restore view [Component: Svelte]"]
        23["Diagnostics and maintenance views [Component: Svelte]"]
      end

    end

  end

```

## structurizr PluginComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Obsidian plugin"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 7 ["Obsidian plugin"]

        10["Scan journal [Component: JSON under .obts]"]
        11["Snapshot engine [Component: isomorphic-git]"]
        12["Upload journal [Component: JSON under .obts]"]
        13["Transport client [Component: HTTPS]"]
        14["Directory tracker [Component: JSON under .obts]"]
        15["Apply and recovery engine [Component: Obsidian Vault API]"]
        16["Status surface [Component: Obsidian UI]"]
        8["Vault watcher [Component: Obsidian Vault API]"]
        9["Sync coordinator [Component: JavaScript]"]
      end

      24["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      37["Visible vault [Container: Obsidian Vault API, filesystem]"]
      38[".obts local store [Container: Filesystem]"]
    end

    8-. "Queues durable invalidated paths [In-process calls]" .->9
    9-. "Checks durable inventory and complete-audit deadlines [In-process calls]" .->10
    10-. "Persists scan-state.json and scan-cache.json [Filesystem]" .->38
    9-. "Requests targeted reconciliation or a fallback audit only when no upload target is in flight [In-process calls]" .->11
    11-. "Inventories paths and reads only invalidated, metadata-changed, or audit-selected files [Obsidian DataAdapter]" .->37
    11-. "Writes Git objects and local refs [isomorphic-git filesystem adapter]" .->38
    9-. "Creates or resumes exactly one immutable attempt [In-process calls]" .->12
    12-. "Persists upload-transfer.json until terminal result consumption [Filesystem]" .->38
    9-. "Uploads or retrieves the journaled attempt before scanning later edits [In-process calls]" .->13
    13-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->24
    14-. "Persists observed directories, causal intent generations, and stale-baseline recovery journal [Filesystem]" .->38
    9-. "Applies canonical main only after pending proposal outcomes settle [In-process calls]" .->15
    15-. "Writes accepted files and safely creates/removes explicit directories [Obsidian Vault API]" .->37
    15-. "Stages recovery bundles and crash journals before mutation [Filesystem]" .->38
    16-. "Observes monotonic operation progress [In-process calls]" .->9

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 24 ["Server API and CLI"]

        25["Auth service [Component: TypeScript]"]
        26["Connection service [Component: TypeScript]"]
        27["Chunk transfer service [Component: TypeScript]"]
        28["Sync service [Component: TypeScript]"]
        29["Git service [Component: Native Git]"]
        30["Metadata store [Component: TypeScript]"]
        31["Diagnostic service [Component: TypeScript]"]
        32["Dashboard host [Component: Fastify]"]
      end

      17["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      39[("Metadata store [Container: JSON file adapter]")]
      40["Vault Git stores [Container: Native Git bare repositories]"]
      41["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      42["Semantic merge workspace [Container: Temporary filesystem]"]
      7["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    7-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->27
    27-. "Stores receipts, staged objects, processing state, and terminal results [Filesystem]" .->41
    27-. "Queues a validated immutable proposal for canonical integration [In-process calls]" .->28
    28-. "Checks ancestry, validates trees, and creates merge or protected conflict history [In-process calls]" .->29
    28-. "Persists operation phases, merge order, events, acknowledgements, and conflicts [In-process calls]" .->30
    29-. "Runs batched tree inspection, object promotion, temporary-index read-tree/write-tree merges, commit-tree, and ref CAS [Native Git]" .->40
    29-. "Reads validated staged objects and promotes them after policy checks [Git alternates and filesystem]" .->41
    29-. "Materializes semantic overlap candidates only [Filesystem]" .->42
    30-. "Atomically reads and replaces durable metadata [Filesystem]" .->39
    32-. "Serves built assets [HTTP]" .->17
    31-. "Stores consented redacted diagnostic events [Filesystem]" .->39

  end

```

## structurizr SystemContext

```mermaid
graph LR

  subgraph diagram ["System Context View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Operator [Person]"]
    4["Automation agent [Person]"]
    5["Obsidian [Software System]"]
    6["Obsidian True Sync [Software System]"]

    1-. "Connects devices and reviews conflicts [HTTPS]" .->6
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->6
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->6
    4-. "Uses context-scoped note, search, graph, Base, create, and edit tools [REST, MCP]" .->6
    6-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->5

  end

```

