# Architecture Diagrams

_Generated from `workspace.dsl`; do not edit by hand._

## structurizr Containers

```mermaid
graph LR

  subgraph diagram ["Container View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Operator [Person]"]
    4["Obsidian [Software System]"]

    subgraph 5 ["Obsidian True Sync"]

      16["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      21["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      30["Visible vault [Container: Obsidian Vault API, filesystem]"]
      31[".obts local store [Container: Filesystem]"]
      32[("Metadata store [Container: JSON file adapter]")]
      33["Vault Git stores [Container: Native Git bare repositories]"]
      34["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      35["Semantic merge workspace [Container: Temporary filesystem]"]
      6["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    1-. "Connects devices and reviews conflicts [HTTPS]" .->16
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->6
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->21
    6-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->4
    21-. "Serves static dashboard assets [HTTP]" .->16
    16-. "Calls authenticated dashboard and conflict APIs [HTTPS]" .->21
    6-. "Uploads immutable Git/directory proposals, polls processing outcomes, pulls canonical state, and reports status [HTTPS]" .->21
    6-. "Scans and safely applies visible vault content [Obsidian Vault API]" .->30
    6-. "Persists local journal, immutable upload identity, credentials, cursors, and recovery evidence [Filesystem]" .->31
    21-. "Reads and atomically replaces application metadata [Filesystem]" .->32
    21-. "Validates objects and maintains canonical, device, and conflict refs [Git object and ref operations]" .->33
    21-. "Persists resumable chunks, staged objects, and asynchronous terminal results [Filesystem]" .->34
    21-. "Materializes only overlapping candidates requiring semantic validation [Filesystem]" .->35

  end

```

## structurizr DashboardComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Dashboard SPA"]

    subgraph 5 ["Obsidian True Sync"]

      subgraph 16 ["Dashboard SPA"]

        17["API client [Component: TypeScript]"]
        18["Device views [Component: Svelte]"]
        19["Conflict workbench [Component: Svelte]"]
        20["Diagnostics view [Component: Svelte]"]
      end

    end

  end

```

## structurizr PluginComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Obsidian plugin"]

    subgraph 5 ["Obsidian True Sync"]

      subgraph 6 ["Obsidian plugin"]

        10["Snapshot engine [Component: isomorphic-git]"]
        11["Upload journal [Component: JSON under .obts]"]
        12["Transport client [Component: HTTPS]"]
        13["Directory tracker [Component: JSON under .obts]"]
        14["Apply and recovery engine [Component: Obsidian Vault API]"]
        15["Status surface [Component: Obsidian UI]"]
        7["Vault watcher [Component: Obsidian Vault API]"]
        8["Sync coordinator [Component: JavaScript]"]
        9["Scan journal [Component: JSON under .obts]"]
      end

      21["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      30["Visible vault [Container: Obsidian Vault API, filesystem]"]
      31[".obts local store [Container: Filesystem]"]
    end

    7-. "Queues durable invalidated paths [In-process calls]" .->8
    8-. "Checks durable inventory and complete-audit deadlines [In-process calls]" .->9
    9-. "Persists scan-state.json and scan-cache.json [Filesystem]" .->31
    8-. "Requests targeted reconciliation or a fallback audit only when no upload target is in flight [In-process calls]" .->10
    10-. "Inventories paths and reads only invalidated, metadata-changed, or audit-selected files [Obsidian DataAdapter]" .->30
    10-. "Writes Git objects and local refs [isomorphic-git filesystem adapter]" .->31
    8-. "Creates or resumes exactly one immutable attempt [In-process calls]" .->11
    11-. "Persists upload-transfer.json until terminal result consumption [Filesystem]" .->31
    8-. "Uploads or retrieves the journaled attempt before scanning later edits [In-process calls]" .->12
    12-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->21
    13-. "Persists observed directories, causal intent generations, and stale-baseline recovery journal [Filesystem]" .->31
    8-. "Applies canonical main only after pending proposal outcomes settle [In-process calls]" .->14
    14-. "Writes accepted files and safely creates/removes explicit directories [Obsidian Vault API]" .->30
    14-. "Stages recovery bundles and crash journals before mutation [Filesystem]" .->31
    15-. "Observes monotonic operation progress [In-process calls]" .->8

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    subgraph 5 ["Obsidian True Sync"]

      subgraph 21 ["Server API and CLI"]

        22["Auth service [Component: TypeScript]"]
        23["Connection service [Component: TypeScript]"]
        24["Chunk transfer service [Component: TypeScript]"]
        25["Sync service [Component: TypeScript]"]
        26["Git service [Component: Native Git]"]
        27["Metadata store [Component: TypeScript]"]
        28["Diagnostic service [Component: TypeScript]"]
        29["Dashboard host [Component: Fastify]"]
      end

      16["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      32[("Metadata store [Container: JSON file adapter]")]
      33["Vault Git stores [Container: Native Git bare repositories]"]
      34["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      35["Semantic merge workspace [Container: Temporary filesystem]"]
      6["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    6-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->24
    24-. "Stores receipts, staged objects, processing state, and terminal results [Filesystem]" .->34
    24-. "Queues a validated immutable proposal for canonical integration [In-process calls]" .->25
    25-. "Checks ancestry, validates trees, and creates merge or protected conflict history [In-process calls]" .->26
    25-. "Persists operation phases, merge order, events, acknowledgements, and conflicts [In-process calls]" .->27
    26-. "Runs batched tree inspection, object promotion, temporary-index read-tree/write-tree merges, commit-tree, and ref CAS [Native Git]" .->33
    26-. "Reads validated staged objects and promotes them after policy checks [Git alternates and filesystem]" .->34
    26-. "Materializes semantic overlap candidates only [Filesystem]" .->35
    27-. "Atomically reads and replaces durable metadata [Filesystem]" .->32
    29-. "Serves built assets [HTTP]" .->16
    28-. "Stores consented redacted diagnostic events [Filesystem]" .->32

  end

```

## structurizr SystemContext

```mermaid
graph LR

  subgraph diagram ["System Context View: Obsidian True Sync"]

    1["Vault owner [Person]"]
    2["Device user [Person]"]
    3["Operator [Person]"]
    4["Obsidian [Software System]"]
    5["Obsidian True Sync [Software System]"]

    1-. "Connects devices and reviews conflicts [HTTPS]" .->5
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->5
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->5
    5-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->4

  end

```

