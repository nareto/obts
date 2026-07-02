# Phase 1 Manual Smoke Test

This smoke test starts from empty persistent state and verifies the deployable
Phase 1 workflow without using test harness code.

1. Build the server and plugin artifacts:

   ```sh
   npm ci
   npm run build
   docker build -t obts:phase1 .
   ```

2. Start the server from the OCI image:

   ```sh
   docker volume create obts-smoke-data
   docker run --rm --name obts-smoke -p 3000:3000 \
     -e OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
     -e OBTS_SESSION_SECRET=replace-with-a-long-random-secret \
     -v obts-smoke-data:/var/lib/obts \
     obts:phase1
   ```

3. In another shell, create the initial admin and vault:

   ```sh
   docker exec obts-smoke node dist/src/cli.js setup \
     --username admin \
     --password 'change-this-password'
   docker exec obts-smoke node dist/src/cli.js vault create \
     --username admin \
     --password 'change-this-password' \
     --display-name "Smoke Vault" \
     --json
   docker exec obts-smoke node dist/src/cli.js health ready
   ```

4. Create a pairing token for the first copied test vault:

   ```sh
   docker exec obts-smoke node dist/src/cli.js pairing-token create \
     --username admin \
     --password 'change-this-password' \
     --vault-id vlt_... \
     --device-name "Laptop"
   ```

5. Install the Obsidian plugin package from `obsidian-plugin/` into the copied
   test vault's `.obsidian/plugins/obts/` directory. Enter the server URL,
   pairing token, and device name in the plugin settings, then pair the device.

6. Repeat pairing for a second copied test vault.

7. Edit different Markdown files on both devices and run sync. Verify both
   devices converge to the same server `main` and that no visible `.git`
   directory appears in either vault.

8. Edit the same Markdown file differently on both devices before either device
   pulls the other's change. Verify the server creates a durable conflict
   record and the plugin reports `Review needed` or a blocked state rather than
   overwriting local content:

   ```sh
   docker exec obts-smoke node dist/src/cli.js conflicts list \
     --username admin \
     --password 'change-this-password' \
     --vault-id vlt_...
   ```

9. Confirm destructive local apply paths have recovery state:

   ```sh
   find copied-vault/.obts -maxdepth 3 -type f | sort
   ```

   Recovery bundles should exist before destructive replacement/apply actions,
   and apply journals should appear while apply work is in progress.

10. Stop the server and keep the Docker volume for restore/readiness testing, or
    remove it after the smoke test:

    ```sh
    docker rm -f obts-smoke
    docker volume rm obts-smoke-data
    ```
