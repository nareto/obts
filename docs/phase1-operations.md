# Phase 1 Operations

Phase 1 can be operated without the browser dashboard. The `obts` CLI exposes
first-run setup, vault creation, pairing-token creation, device listing,
conflict listing, readiness checks, and local admin recovery against the same
persistent state used by the HTTP API and plugin.

## Configuration

Set these environment variables for the server process and for CLI commands
that operate on the same state:

- `OBTS_DATA_DIR`: persistent state root. Defaults to `./.obts-server` for
  local development and `/var/lib/obts` in the OCI image.
- `OBTS_PUBLIC_BASE_URL`: public URL used when creating pairing links.
- `OBTS_SESSION_SECRET`: session signing secret for HTTP sessions.
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

## CLI Workflow

Build the project and run commands through the compiled CLI:

```sh
npm ci
npm run build
export OBTS_DATA_DIR="$PWD/.obts-server"
export OBTS_PUBLIC_BASE_URL="http://127.0.0.1:3000"
export OBTS_SESSION_SECRET="replace-with-a-long-random-secret"

node dist/src/cli.js setup \
  --username admin \
  --password 'change-this-password' \
  --display-name Admin

node dist/src/cli.js vault create \
  --username admin \
  --password 'change-this-password' \
  --display-name "Main Vault" \
  --json

node dist/src/cli.js pairing-token create \
  --username admin \
  --password 'change-this-password' \
  --vault-id vlt_... \
  --device-name "Laptop" \
  --sync-profile notes_only

node dist/src/cli.js devices list \
  --username admin \
  --password 'change-this-password' \
  --vault-id vlt_...

node dist/src/cli.js conflicts list \
  --username admin \
  --password 'change-this-password' \
  --vault-id vlt_...

node dist/src/cli.js health ready
```

Start the API server with:

```sh
node dist/src/cli.js serve --host 0.0.0.0 --port 3000
```

If all dashboard credentials are lost but the operator still has local access
to `OBTS_DATA_DIR`, create a one-time reset token for an existing admin:

```sh
node dist/src/cli.js admin-recovery create-reset-token --username admin
```

Use the token with `POST /api/v1/auth/password-reset`.

If no enabled admin account remains, local recovery can create a new admin
account from the server host:

```sh
node dist/src/cli.js admin-recovery create-admin \
  --username breakglass \
  --password 'change-this-password'
```

The command is rejected while any enabled admin account still exists.

## OCI Image

Build and run the repository image:

```sh
docker build -t obts:phase1 .
docker run --rm -p 3000:3000 \
  -e OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
  -e OBTS_SESSION_SECRET=replace-with-a-long-random-secret \
  -v obts-data:/var/lib/obts \
  obts:phase1
```

The image includes the native `git` CLI and a readiness healthcheck that runs
`obts health ready`.
