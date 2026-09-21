# Deployment canary

`npm run test:deployment-canary` runs the candidate image against a synthetic copy of the N-1 persisted-state fixture. It requires `OBTS_CANARY_IMAGE` to be digest-pinned, unless `OBTS_CANARY_ALLOW_LOCAL_TAG=1` is explicitly set for local testing.

The runner:

- creates the fixture in a temporary directory;
- starts the candidate with only that directory mounted at `/var/lib/obts`;
- uses `--network none`, a read-only container root, a temporary `/tmp`, and synthetic credentials;
- checks live, bounded readiness, an unrelated chunked upload/finalize, and an existing pull;
- removes the container and temporary directory in `finally` handling.

It does not mount production data, connect to a live service, read external secrets, or use production credentials. The candidate process is exercised inside the container, not through production routing.

This is a local synthetic test, not a production promotion gate. Deployment integration and rollback policy belong in the operator's private infrastructure repository.