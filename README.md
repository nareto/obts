<div align="center">

# Obsidian True Sync

**Git-backed Obsidian sync with durable conflicts, recoverable local applies, and a history you can inspect.**

Self-hosted server · Desktop and mobile plugin · Browser dashboard

</div>

> [!IMPORTANT]
> Obsidian True Sync is under active development and should be tested with copied vaults before it is trusted with primary data. Mobile sync runs while Obsidian is in the foreground; iOS and Android do not guarantee background execution.

## Why Obsidian True Sync?

Most sync tools answer one question: "What is the latest copy?" Obsidian True Sync also keeps the history needed to answer how it got there, what changed concurrently, and how to recover safely.

Each vault has a canonical Git history on the server. Devices submit their own commits, the server validates and merges them, and clients apply accepted changes through Obsidian's vault API. Git stays behind the scenes: no visible `.git` directory is created in your vault.

- **Full-vault sync** for notes, attachments, Canvas files, Bases, themes, snippets, and community plugin data, with explicit safety exclusions.
- **Durable conflict handling** instead of last-writer-wins replacement.
- **Browser-based review** for conflicts, device status, note history, and restores.
- **Rename-aware history** with source and rendered Markdown diffs.
- **Safe restoration** that creates a new commit rather than rewriting existing history.
- **Recovery before replacement** through local snapshots, patches, ref packs, checksums, and replayable apply journals.
- **Empty-folder synchronization** using explicit directory intent outside Git.
- **Integrity-first operations** with readiness checks, redacted diagnostics, and non-destructive Git maintenance.
- **Multi-user isolation** where each vault has exactly one owner.

## How It Works

```mermaid
flowchart LR
    A[Obsidian plugin] -->|device commits and events| B[Obsidian True Sync server]
    C[Obsidian plugin] -->|device commits and events| B
    B --> D[(Canonical Git history)]
    B --> E[(Accounts, devices, conflicts)]
    F[Browser dashboard] -->|review, resolve, restore| B
    B -->|accepted server main| A
    B -->|accepted server main| C
```

The server owns canonical `main`. Each paired device has a protected device ref and cannot advance `main` directly. Concurrent work is either merged safely or recorded as a conflict for review. Pulls use recovery bundles and apply journals before changing local files.

## Security Model

The server is trusted and can read vault content while syncing, merging, rendering conflicts, and serving history. This is **not** an end-to-end encrypted or zero-knowledge system.

A production deployment should provide:

- HTTPS at the public endpoint;
- a long, randomly generated `OBTS_SESSION_SECRET`;
- restrictive ownership and permissions for persistent state;
- encrypted disks, volumes, snapshots, or backups where required;
- point-in-time-consistent backups of metadata and Git stores;
- protected operator access to local recovery commands.

See [Persistent State and Backup](docs/persistent-state.md) for the complete backup and restore contract.

## Quick Start With Docker

Requirements: Docker and an installation of Obsidian on desktop, Android, or iOS.

```sh
git clone https://github.com/nareto/obts.git
cd obts

docker build -t obts .
docker volume create obts-data

docker run -d --name obts \
  -p 3000:3000 \
  -e OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
  -e OBTS_SESSION_SECRET=replace-with-a-long-random-value \
  -e OBTS_DIAGNOSTIC_INGEST_ENABLED=false \
  -v obts-data:/var/lib/obts \
  obts
```

Open `http://127.0.0.1:3000` and complete the initial account setup. Vaults can be created from the dashboard or directly from the plugin onboarding flow.

Check readiness at any time:

```sh
docker exec obts node dist/src/cli.js health ready --json
```

For anything beyond local evaluation, place the service behind HTTPS and replace every example credential before starting it.

## Install The Obsidian Plugin

The recommended installation path is [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Obsidian's community plugin browser.
2. Run **BRAT: Add a beta plugin for testing** and enter `nareto/obts`.
3. Track the latest release, then enable **Obsidian True Sync**.
4. Enter the server URL and device name. Optionally enable **Share error diagnostics with this obts server**, then run **Set up sync**.
5. Authenticate in the browser, approve a new or existing vault, and return to Obsidian.
6. If local and server content differ, explicitly choose **Use the server vault** or **Merge local content** after reviewing the recovery/conflict warning.
7. If merge submission creates a conflict, open the dashboard from the plugin, resolve the conflict, return to the same plugin screen, and choose **Check resolution**. Do not submit the merge again.
8. Connect a second copied vault and complete the [manual smoke test](docs/phase3-smoke-test.md) before using primary data.

The server reports minimum and recommended plugin versions. Compatible older clients continue syncing and receive an update notice; clients below the minimum are blocked with an actionable BRAT update command. For manual installation, copy `main.js`, `manifest.json`, and `styles.css` from a GitHub release into `<vault>/.obsidian/plugins/obts/`.

Plugin commands include:

- `Set up sync`
- `Sync once`
- `Replace local with server state`
- `Rebuild from server main`

Local runtime state and hidden client history live under `.obts/`, which is never synchronized as vault content.

Error diagnostics are separate from sync status and are off by default. When enabled, the plugin sends failures only to the configured obts backend using a closed, sanitized schema; it never sends note content, vault or file names, paths, credentials, Git objects, packfiles, stacks, or raw logs. Changing the backend URL disables consent. Owners can inspect and delete retained reports from the dashboard Settings page.

## Develop From Source

Requirements:

- Node.js 24 or newer
- native `git`
- npm

```sh
npm ci
npm test
npm run build

export OBTS_DATA_DIR="$PWD/.obts-server"
export OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000
export OBTS_SESSION_SECRET=replace-with-a-long-random-value
node dist/src/cli.js serve
```

Useful commands:

```sh
npm run check       # TypeScript and dashboard build checks
npm test            # Full Vitest suite
npm run build       # Dashboard, plugin, and server build
just plugin-version patch  # Select and build the next plugin release
just arch           # Render and serve the Structurizr architecture model
```

Run `node dist/src/cli.js help` for setup, vault, device, conflict, health, integrity, and local admin-recovery commands. Password-bearing automation should use `--password-env` rather than command-line values.

Plugin releases use `obsidian-plugin/manifest.json` as their canonical version. Run `just setup-hooks` once per checkout; the pre-push hook prevents plugin changes without a version increase. After `just plugin-version patch` (or an explicit version) reaches GitHub `main`, the release workflow tests the build and publishes the BRAT assets automatically.

## What Gets Synchronized?

Obsidian True Sync synchronizes the full vault after hard safety exclusions.

Included examples:

- Markdown, Canvas, and Bases files;
- attachments and `.trash/` content;
- themes, snippets, and most `.obsidian/` configuration;
- community plugin files other than this plugin's own installation directory.

Always excluded:

- `.obts/**`;
- visible `.git/**` repositories;
- Obsidian cache and workspace files;
- `.obsidian/plugins/obts/**`.

Community plugin history is metadata-only by default in the dashboard; revealing a selected historical body requires an explicit, recently authenticated action.

## Operations And Documentation

- [Phase 1 operations](docs/phase1-operations.md) — configuration, CLI, container, and recovery basics
- [Phase 2 operations](docs/phase2-operations.md) — dashboard conflict resolution
- [Phase 3 operations](docs/phase3-operations.md) — history, restore, diagnostics, integrity, and maintenance
- [Persistent state and backup](docs/persistent-state.md) — authoritative state and consistency requirements
- [OpenAPI contract](openapi/openapi.yaml) — HTTP API definition
- [Architecture overview](architecture/docs/01-overview.md) — system boundaries and Git model
- [Product requirements](prd.md) — detailed behavior and design constraints

## Current Boundaries

Obsidian True Sync deliberately does not provide guaranteed background mobile sync, shared vault membership, real-time collaborative editing, zero-knowledge storage, or destructive history compaction. These boundaries keep recovery behavior explicit and Git history authoritative while the core sync model matures.
