# Phase 2 Manual Smoke Test

This smoke test starts from empty persistent state and verifies the deployable
Phase 2 dashboard conflict-resolution workflow without using test harness code.

1. Build the server, dashboard, plugin, and image:

   ```sh
   npm ci
   npm run build
   docker build -t obts:phase2 .
   ```

2. Start the server from the OCI image:

   ```sh
   docker volume create obts-phase2-smoke-data
   docker run --rm --name obts-phase2-smoke -p 3000:3000 \
     -e OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
     -e OBTS_SESSION_SECRET=replace-with-a-long-random-secret \
     -v obts-phase2-smoke-data:/var/lib/obts \
     obts:phase2
   ```

3. Open `http://127.0.0.1:3000/`, create the initial admin account, and create
   a vault from the dashboard.

4. Use the dashboard `Pair device` dialog to create a pairing token for the
   first copied test vault. Install the plugin from `obsidian-plugin/` into the
   copied vault's `.obsidian/plugins/obts/` directory, then enter the server
   URL, pairing token, and issued device name in plugin settings.

5. Pair a second copied test vault through the same dashboard flow.

6. Create `shared.md` with the same base content on the first device and sync
   it. Let the second device pull and apply that server state.

7. Edit `shared.md` differently on both devices before the second device pulls
   the first device's accepted change. Sync the first device, then sync the
   second device. The second sync should report `Review needed`.

8. In the dashboard Conflicts page, open the conflict. Verify affected-path
   metadata, rendered Markdown diff, source diff, current server commit, device
   commit, and resolution choices are visible.

9. Resolve the conflict. Use one of the available choices and submit from the
   existing dashboard session; verify there is no password re-authentication
   prompt. Verify the conflict becomes resolved, the activity list includes
   conflict resolution and `main_advanced`, and the current server `main`
   changes.

10. Sync both paired devices. Verify they apply the resolved server state
    through the normal safe apply flow and do not create a visible `.git`
    directory.

11. Verify stale-review protection manually:

    - create another conflict and open its review package in the dashboard;
    - advance server `main` with an unrelated accepted edit from another
      device;
    - submit the old review package;
    - confirm the dashboard reports a stale review and `main` is unchanged by
      the stale submission.

12. Stop the server and either keep the Docker volume for restore testing or
    remove it:

    ```sh
    docker rm -f obts-phase2-smoke
    docker volume rm obts-phase2-smoke-data
    ```
