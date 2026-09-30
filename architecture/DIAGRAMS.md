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
      25["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      35["OBTS Bridge API and indexer [Container: Rust, Axum, SQLx]"]
      36["Headless OBTS client [Container: Node.js, TypeScript]"]
      37["Bridge visible vault and .obts state [Container: Filesystem]"]
      38[("Bridge PostgreSQL state [Container: PostgreSQL, pgvector]")]
      39["Visible vault [Container: Obsidian Vault API, filesystem]"]
      40[".obts local store [Container: Filesystem]"]
      41[("Metadata store [Container: JSON file adapter]")]
      42["Vault Git stores [Container: Native Git bare repositories]"]
      43["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      44["Semantic merge workspace [Container: Temporary filesystem]"]
      7["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    1-. "Connects devices and reviews conflicts [HTTPS]" .->17
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->7
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->25
    4-. "Uses context-scoped note, search, graph, Base, create, and edit tools [REST, MCP]" .->35
    7-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->5
    25-. "Serves static dashboard assets [HTTP]" .->17
    17-. "Calls authenticated dashboard, conflict, and vault sync-settings APIs [HTTPS]" .->25
    7-. "Uploads immutable Git/directory proposals, polls processing outcomes, pulls canonical state, and reports status [HTTPS]" .->25
    35-. "Supervises lifecycle and sends administrative or synchronization commands [JSON Lines over stdin/stdout]" .->36
    35-. "Reads selected ordinary files under the shared headless/filesystem lock, verifies revision/OID, and atomically writes authorized files; releases bounded body work after each operation [Filesystem]" .->37
    35-. "Queries paginated ACL-visible metadata and candidates, writes verified derived batches/cursors, and retains access/audit records without a full snapshot or raw-body fallback [PostgreSQL]" .->38
    36-. "Owns visible-state reconciliation, hidden Git, credentials, journals, queues, apply, and recovery [Filesystem]" .->37
    36-. "Pairs and synchronizes as a normal protected OBTS device [HTTPS]" .->25
    7-. "Scans and safely applies visible vault content [Obsidian Vault API]" .->39
    7-. "Persists local journal, immutable upload identity, credentials, cursors, and recovery evidence [Filesystem]" .->40
    25-. "Reads and atomically replaces application metadata [Filesystem]" .->41
    25-. "Validates objects and maintains canonical, device, and conflict refs [Git object and ref operations]" .->42
    25-. "Persists resumable chunks, staged objects, and asynchronous terminal results [Filesystem]" .->43
    25-. "Materializes only overlapping candidates requiring semantic validation [Filesystem]" .->44

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
        24["Vault sync settings [Component: Svelte]"]
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

      25["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      39["Visible vault [Container: Obsidian Vault API, filesystem]"]
      40[".obts local store [Container: Filesystem]"]
    end

    8-. "Queues durable invalidated paths [In-process calls]" .->9
    9-. "Checks durable inventory and complete-audit deadlines [In-process calls]" .->10
    10-. "Persists scan-state.json and scan-cache.json [Filesystem]" .->40
    9-. "Requests targeted reconciliation or a fallback audit only when no upload target is in flight [In-process calls]" .->11
    11-. "Inventories paths and reads only invalidated, metadata-changed, or audit-selected files [Obsidian DataAdapter]" .->39
    11-. "Writes Git objects and local refs [isomorphic-git filesystem adapter]" .->40
    9-. "Creates or resumes exactly one immutable attempt [In-process calls]" .->12
    12-. "Persists upload-transfer.json until terminal result consumption [Filesystem]" .->40
    9-. "Uploads or retrieves the journaled attempt before scanning later edits [In-process calls]" .->13
    13-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->25
    14-. "Persists observed directories, causal intent generations, and stale-baseline recovery journal [Filesystem]" .->40
    9-. "Applies canonical main only after pending proposal outcomes settle [In-process calls]" .->15
    15-. "Writes accepted files and safely creates/removes explicit directories [Obsidian Vault API]" .->39
    15-. "Stages recovery bundles and crash journals before mutation [Filesystem]" .->40
    16-. "Observes monotonic operation progress [In-process calls]" .->9

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    subgraph 6 ["Obsidian True Sync"]

      subgraph 25 ["Server API and CLI"]

        26["Auth service [Component: TypeScript]"]
        27["Connection service [Component: TypeScript]"]
        28["Chunk transfer service [Component: TypeScript]"]
        29["Sync service [Component: TypeScript]"]
        30["Git service [Component: Native Git]"]
        31["Metadata store [Component: TypeScript]"]
        32["Diagnostic service [Component: TypeScript]"]
        33["Vault deletion coordinator [Component: TypeScript]"]
        34["Dashboard host [Component: Fastify]"]
      end

      17["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      41[("Metadata store [Container: JSON file adapter]")]
      42["Vault Git stores [Container: Native Git bare repositories]"]
      43["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      44["Semantic merge workspace [Container: Temporary filesystem]"]
      7["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    33-. "Erases attributable transfer/temp residue and fails closed on uncertain ownership [Filesystem]" .->43
    34-. "Serves built assets [HTTP]" .->17
    32-. "Stores consented redacted diagnostic events [Filesystem]" .->41
    7-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->28
    28-. "Stores receipts, staged objects, processing state, and terminal results [Filesystem]" .->43
    28-. "Queues a validated immutable proposal for canonical integration [In-process calls]" .->29
    29-. "Checks ancestry, validates trees, and creates merge or protected conflict history [In-process calls]" .->30
    29-. "Persists operation phases, merge order, events, acknowledgements, and conflicts [In-process calls]" .->31
    30-. "Runs batched tree inspection, object promotion, temporary-index read-tree/write-tree merges, commit-tree, and ref CAS [Native Git]" .->42
    30-. "Reads validated staged objects and promotes them after policy checks [Git alternates and filesystem]" .->43
    30-. "Materializes semantic overlap candidates only [Filesystem]" .->44
    31-. "Atomically reads and replaces durable metadata [Filesystem]" .->41
    33-. "Closes new per-vault sync admission and rejects target work after durable revocation [In-process calls]" .->29
    33-. "Stops or drains target transfer processors and detached callbacks without reusing released request leases [In-process calls]" .->28
    33-. "Revokes target devices/connections and closes new approval/completion admission [In-process calls]" .->27
    33-. "Stops target diagnostic ingestion and erases attributable diagnostics [In-process calls]" .->32
    33-. "Owns the transactional MetadataStore mutation seam for intent/revocation, final purge, and minimal receipt at durable boundaries [In-process calls]" .->31
    33-. "Erases the exact target Git store and protected refs after drain [In-process calls]" .->30

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

