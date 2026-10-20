# Phase 2 Operations

Phase 2 adds the browser dashboard and dashboard conflict resolution workflow on
top of the Phase 1 sync server and Obsidian plugin behavior.

## Configuration

Use the same server configuration as Phase 1:

- `OBTS_DATA_DIR`: persistent state root. Defaults to `./.obts-server` for
  local development and `/var/lib/obts` in the OCI image.
- `OBTS_PUBLIC_BASE_URL`: public URL used for dashboard and browser onboarding links.
- `OBTS_SESSION_SECRET`: session signing secret for dashboard sessions.
- `OBTS_GIT_STORE_DIR`: optional Git store override. Defaults to
  `$OBTS_DATA_DIR/git`.
- `OBTS_TEMP_DIR`: optional temporary workspace override. Defaults to
  `$OBTS_DATA_DIR/tmp`.
- `OBTS_GIT_BINARY`: native Git executable. Defaults to `git`.
- `OBTS_MAX_UPLOAD_BYTES`: legacy single-request multipart and per-object
  validation limit. Defaults to `104857600`.
- `OBTS_TRANSFER_CHUNK_BYTES`: maximum independently importable Git pack chunk.
  Defaults to `16777216`.
- `OBTS_MAX_TRANSFER_BYTES`: aggregate logical object/transfer limit. Defaults
  to `2147483648`.
- `OBTS_MAX_TRANSFER_CHUNKS`: maximum chunks in one transfer. Defaults to `4096`.
- `OBTS_MAX_TRANSFER_STORAGE_BYTES`: global server quarantine cap. Defaults to
  `4294967296`.
- `OBTS_TRANSFER_TTL_SECONDS`: resumable push lifetime. Defaults to `86400`.
- `OBTS_HOST` and `OBTS_PORT`: bind address for `obts serve`.

Persistent-state backup and restore requirements are documented in
`docs/persistent-state.md`.

## Dashboard Workflow

Build and start the server:

```sh
npm ci
npm run build
export OBTS_DATA_DIR="$PWD/.obts-server"
export OBTS_PUBLIC_BASE_URL="http://127.0.0.1:3000"
export OBTS_SESSION_SECRET="replace-with-a-long-random-secret"
node dist/src/cli.js serve --host 0.0.0.0 --port 3000
```

Open `http://127.0.0.1:3000/` in a browser. The dashboard is a static Svelte
SPA served by the Fastify server; there is no second application server.

From the plugin and dashboard:

1. Complete initial setup or sign in.
2. In Obsidian, enter the server URL and device name, then choose `Set up sync`.
3. Review the matching verification code in the browser and approve either a new vault or an existing owned vault. Approval requires recent dashboard authentication.
4. Return to Obsidian to review the local/server analysis and confirm use-server, initialize, or merge behavior.
5. Inspect the Overview, Devices, Conflicts, History, and Maintenance pages for vault status, device state, unresolved conflicts, readiness, and activity.
6. Resolve review-needed conflicts from the Conflicts page. The workbench displays every affected file in one scrollable review, with a file navigator, unified line numbers, and word-level emphasis inside changed lines. Resolution submission uses the authenticated dashboard session without another password prompt and includes the expected current `main` commit from the review package.

Each affected file is decided on its own. A file can keep the server version, use the device version, or, for ordinary text, be resolved line by line; every changed line must then be assigned to the server, device, or both. The per-file menu also offers keep both, insert both blocks, and editing the complete final content. Files start undecided, a progress count and `Next undecided` lead to the remaining ones, and `Review result` is enabled only after every file is decided. `Set all files` in the toolbar sets every file to the server or device version in one step; it is a shortcut, not a separate mode.

Paths that cannot be decided apart are one decision: the paths of a rename or path conflict are decided together, and so are a file and a path beneath it. Rename/path conflicts keep path-aware editing of their final files. Binary files expose sizes and hashes without lossy text rendering and allow only byte-preserving choices (server, device, keep both). Text sides larger than 512 KiB use metadata-only review so rendering cannot freeze the dashboard; their original bytes remain available to whole-file choices. Directory or mixed file/directory conflicts are decided as one package: keep the server version or use the device version.

The dashboard submits a uniform whole-file choice as the plain resolution kind. Any mix is submitted as `resolution_kind: per_file` with one entry per decision, so the server still builds the final tree and binary bytes are preserved. The available choices per file are:

- keep the current server version;
- use the device version;
- keep both by writing a device copy next to the server version;
- insert both blocks for text review;
- manually edit complete final content and paths (line-by-line results are sent this way).

If server `main` advances while a review is open, the review stays current as
long as the advance does not touch its affected paths or directories, the
device's own changes, or the root `.gitignore`. Resolving it then applies the
reviewed change on top of the new `main`, keeping the advance. An advance that
touches any of those makes the review stale: submission fails with
`409 stale_conflict_review`, and the dashboard marks the review stale so it can
be refreshed before trying again. Duplicate submission of the same accepted
resolution is idempotent.

## Upgrade From Phase 1

Phase 2 uses the same metadata file and per-vault Git stores as Phase 1. No
operator migration command is required for the current file-backed metadata
adapter.

Before upgrading:

1. Stop the Phase 1 server.
2. Take a point-in-time backup of `OBTS_DATA_DIR/metadata/phase1.json` and
   `OBTS_DATA_DIR/git/*.git`.
3. Deploy the Phase 2 image or build output.
4. Start the server and verify `GET /health/ready` or
   `node dist/src/cli.js health ready`.

Readiness fails closed when restored metadata and Git refs disagree, when
conflict commits are missing, or when storage and native Git checks fail.

## OCI Image

Build and run the repository image:

```sh
docker build -t obts:phase2 .
docker run --rm -p 3000:3000 \
  -e OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
  -e OBTS_SESSION_SECRET=replace-with-a-long-random-secret \
  -v obts-data:/var/lib/obts \
  obts:phase2
```

The image includes the compiled dashboard assets, native `git`, and a readiness
healthcheck that runs `obts health ready`.
