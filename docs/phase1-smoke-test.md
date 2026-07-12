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

3. Open `http://127.0.0.1:3000`, complete initial account setup, and verify readiness:

   ```sh
   docker exec obts-smoke node dist/src/cli.js health ready
   ```

4. Install the Obsidian plugin package from `obsidian-plugin/` into the first copied test vault's `.obsidian/plugins/obts/` directory. Enter the server URL and device name, then run **Set up sync**.

5. In the browser page opened by the plugin, verify the displayed code matches Obsidian, authenticate, choose **Create a new synced vault**, approve, and return to Obsidian. Confirm the exact local file summary and run **Create vault and upload**.

6. Install the plugin into a second copied test vault and run **Set up sync**. Approve the existing smoke vault. Exercise both divergent choices on disposable copies: **Use the server vault** must create a recovery bundle before replacement; **Merge local content** must preserve disjoint paths and direct overlapping changes to dashboard review.

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
