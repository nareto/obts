# Phase 2 Operations

Phase 2 adds the browser dashboard and dashboard conflict resolution workflow on
top of the Phase 1 sync server and Obsidian plugin behavior.

## Configuration

Use the same server configuration as Phase 1:

- `OBTS_DATA_DIR`: persistent state root. Defaults to `./.obts-server` for
  local development and `/var/lib/obts` in the OCI image.
- `OBTS_PUBLIC_BASE_URL`: public URL used for dashboard links and pairing URLs.
- `OBTS_SESSION_SECRET`: session signing secret for dashboard sessions.
- `OBTS_GIT_STORE_DIR`: optional Git store override. Defaults to
  `$OBTS_DATA_DIR/git`.
- `OBTS_TEMP_DIR`: optional temporary workspace override. Defaults to
  `$OBTS_DATA_DIR/tmp`.
- `OBTS_GIT_BINARY`: native Git executable. Defaults to `git`.
- `OBTS_MAX_UPLOAD_BYTES`: multipart upload limit in bytes. Defaults to
  `104857600`.
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

From the dashboard:

1. Complete initial setup or sign in.
2. Create a vault when no vault exists.
3. Use `Pair device` to create a one-time pairing URL or token. Pairing token
   creation requires recent dashboard authentication.
4. Inspect the Overview, Devices, Conflicts, History, and Maintenance pages for
   vault status, device state, unresolved conflicts, readiness, and activity.
5. Resolve review-needed conflicts from the Conflicts page. Resolution
   submission uses the authenticated dashboard session without another password
   prompt and includes the expected current `main` commit from the review package.

The dashboard offers the Phase 2 conflict choices:

- keep the current server version;
- use the device version for affected paths;
- keep both by writing device copies next to the server version;
- insert both blocks for text review;
- manually edit final content.

If server `main` advances while a review is open, resolution submission fails
with `409 stale_conflict_review`; the dashboard marks the review stale so it can
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
