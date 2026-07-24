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

      15["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      20["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      29["Visible vault [Container: Obsidian Vault API, filesystem]"]
      30[".obts local store [Container: Filesystem]"]
      31[("Metadata store [Container: JSON file adapter]")]
      32["Vault Git stores [Container: Native Git bare repositories]"]
      33["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      34["Semantic merge workspace [Container: Temporary filesystem]"]
      6["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    1-. "Connects devices and reviews conflicts [HTTPS]" .->15
    2-. "Edits notes and observes synchronization [Obsidian UI]" .->6
    3-. "Runs setup, health, repair, and maintenance commands [CLI and HTTPS]" .->20
    6-. "Uses plugin lifecycle, vault, workspace, request, and status APIs [Obsidian Plugin API]" .->4
    20-. "Serves static dashboard assets [HTTP]" .->15
    15-. "Calls authenticated dashboard and conflict APIs [HTTPS]" .->20
    6-. "Uploads immutable Git/directory proposals, polls processing outcomes, pulls canonical state, and reports status [HTTPS]" .->20
    6-. "Scans and safely applies visible vault content [Obsidian Vault API]" .->29
    6-. "Persists local journal, immutable upload identity, credentials, cursors, and recovery evidence [Filesystem]" .->30
    20-. "Reads and atomically replaces application metadata [Filesystem]" .->31
    20-. "Validates objects and maintains canonical, device, and conflict refs [Git object and ref operations]" .->32
    20-. "Persists resumable chunks, staged objects, and asynchronous terminal results [Filesystem]" .->33
    20-. "Materializes only overlapping candidates requiring semantic validation [Filesystem]" .->34

  end

```

## structurizr DashboardComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Dashboard SPA"]

    subgraph 5 ["Obsidian True Sync"]

      subgraph 15 ["Dashboard SPA"]

        16["API client [Component: TypeScript]"]
        17["Device views [Component: Svelte]"]
        18["Conflict workbench [Component: Svelte]"]
        19["Diagnostics view [Component: Svelte]"]
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

        10["Upload journal [Component: JSON under .obts]"]
        11["Transport client [Component: HTTPS]"]
        12["Directory tracker [Component: JSON under .obts]"]
        13["Apply and recovery engine [Component: Obsidian Vault API]"]
        14["Status surface [Component: Obsidian UI]"]
        7["Vault watcher [Component: Obsidian Vault API]"]
        8["Sync coordinator [Component: JavaScript]"]
        9["Snapshot engine [Component: isomorphic-git]"]
      end

      20["Server API and CLI [Container: TypeScript, Node.js, Fastify]"]
      29["Visible vault [Container: Obsidian Vault API, filesystem]"]
      30[".obts local store [Container: Filesystem]"]
    end

    7-. "Queues durable change hints [In-process calls]" .->8
    8-. "Requests a coherent snapshot only when no upload target is in flight [In-process calls]" .->9
    9-. "Reads syncable files [Obsidian DataAdapter]" .->29
    9-. "Writes Git objects and local refs [isomorphic-git filesystem adapter]" .->30
    8-. "Creates or resumes exactly one immutable attempt [In-process calls]" .->10
    10-. "Persists upload-transfer.json until terminal result consumption [Filesystem]" .->30
    8-. "Uploads or retrieves the journaled attempt before scanning later edits [In-process calls]" .->11
    11-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->20
    12-. "Persists observed directories and causal intent generations [Filesystem]" .->30
    8-. "Applies canonical main only after pending proposal outcomes settle [In-process calls]" .->13
    13-. "Writes accepted files and safely creates/removes explicit directories [Obsidian Vault API]" .->29
    13-. "Stages recovery bundles and crash journals before mutation [Filesystem]" .->30
    14-. "Observes monotonic operation progress [In-process calls]" .->8

  end

```

## structurizr ServerComponents

```mermaid
graph LR

  subgraph diagram ["Component View: Obsidian True Sync - Server API and CLI"]

    subgraph 5 ["Obsidian True Sync"]

      subgraph 20 ["Server API and CLI"]

        21["Auth service [Component: TypeScript]"]
        22["Connection service [Component: TypeScript]"]
        23["Chunk transfer service [Component: TypeScript]"]
        24["Sync service [Component: TypeScript]"]
        25["Git service [Component: Native Git]"]
        26["Metadata store [Component: TypeScript]"]
        27["Diagnostic service [Component: TypeScript]"]
        28["Dashboard host [Component: Fastify]"]
      end

      15["Dashboard SPA [Container: Svelte, TypeScript, Vite]"]
      31[("Metadata store [Container: JSON file adapter]")]
      32["Vault Git stores [Container: Native Git bare repositories]"]
      33["Transfer quarantine [Container: Filesystem, temporary bare Git repositories]"]
      34["Semantic merge workspace [Container: Temporary filesystem]"]
      6["Obsidian plugin [Container: JavaScript, TypeScript, Obsidian Plugin API]"]
    end

    6-. "Creates/resumes transfers, uploads missing packs, requests async processing, and polls [HTTPS]" .->23
    23-. "Stores receipts, staged objects, processing state, and terminal results [Filesystem]" .->33
    23-. "Queues a validated immutable proposal for canonical integration [In-process calls]" .->24
    24-. "Checks ancestry, validates trees, and creates merge or protected conflict history [In-process calls]" .->25
    24-. "Persists operation phases, merge order, events, acknowledgements, and conflicts [In-process calls]" .->26
    25-. "Runs batched tree inspection, object promotion, merge-tree, commit-tree, and ref CAS [Native Git]" .->32
    25-. "Reads validated staged objects and promotes them after policy checks [Git alternates and filesystem]" .->33
    25-. "Materializes semantic overlap candidates only [Filesystem]" .->34
    26-. "Atomically reads and replaces durable metadata [Filesystem]" .->31
    28-. "Serves built assets [HTTP]" .->15
    27-. "Stores consented redacted diagnostic events [Filesystem]" .->31

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

