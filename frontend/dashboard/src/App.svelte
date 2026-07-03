<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, DashboardApi } from './api/client';
  import Attention from './components/Attention.svelte';
  import Checklist from './components/Checklist.svelte';
  import DeviceTable from './components/DeviceTable.svelte';
  import Status from './components/Status.svelte';
  import Summary from './components/Summary.svelte';
  import type {
    DashboardConflict,
    ConflictResolutionKind,
    ConflictReviewPackage,
    DashboardDevice,
    DashboardSummary,
    MaintenanceRow,
    NoteHistoryQueryResponse,
    NoteHistoryVersion,
    NoteHistoryVersionResponse,
    Session,
    StatusLabel,
    VaultSummary
  } from './api/types';

  const api = new DashboardApi();
  const nav = ['Overview', 'Devices', 'Conflicts', 'History', 'Maintenance', 'Settings'] as const;
  type Page = (typeof nav)[number];

  let session: Session | null = null;
  let setupComplete = true;
  let username = '';
  let password = '';
  let authError = '';
  let page: Page = 'Overview';
  let mobileNavOpen = false;
  let vaults: VaultSummary[] = [];
  let vaultId = '';
  let newVaultName = '';
  let dashboard: DashboardSummary | null = null;
  let conflicts: DashboardConflict[] = [];
  let selectedConflictId = '';
  let review: ConflictReviewPackage | null = null;
  let selectedReviewPath = '';
  let resolutionKind: ConflictResolutionKind = 'keep_server';
  let manualTextByPath: Record<string, string> = {};
  let diffTab: 'rendered' | 'source' = 'source';
  let pairOpen = false;
  let pairDeviceName = '';
  let pairing: { pairing_token: string; pairing_url: string; expires_at: string } | null = null;
  let reauthOpen = false;
  let reauthAction: (() => Promise<void>) | null = null;
  let historyPath = '';
  let history: NoteHistoryQueryResponse | null = null;
  let selectedHistory: NoteHistoryVersion | null = null;
  let historyVersion: NoteHistoryVersionResponse | null = null;
  let maintenanceDetailOpen = false;
  let busy = false;
  let notice = '';
  let lastRefreshed: string | null = null;
  let nowMs = Date.now();

  $: selectedVault = vaults.find((vault) => vault.vault_id === vaultId) ?? null;
  $: unresolvedCount = conflicts.filter((conflict) => conflict.status === 'open').length || dashboard?.unresolved_conflict_count || 0;
  $: selectedConflict = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId) ?? null;
  $: selectedReviewFile = review?.files.find((file) => file.path === selectedReviewPath) ?? review?.files[0] ?? null;
  $: recentAuthValid = session ? Date.parse(session.recent_auth_expires_at) > nowMs : false;
  $: pairingExpiresIn = pairing ? formatCountdown(Date.parse(pairing.expires_at) - nowMs) : '';

  onMount(() => {
    void bootstrap();
    const interval = window.setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => window.clearInterval(interval);
  });

  async function bootstrap() {
    try {
      setupComplete = (await api.setupStatus()).setup_complete;
      if (setupComplete) {
        session = await api.session();
        await refreshAll();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        session = null;
        return;
      }
      authError = error instanceof Error ? error.message : 'Unable to load dashboard.';
    }
  }

  async function authenticate() {
    authError = '';
    busy = true;
    try {
      session = setupComplete ? await api.login(username, password) : await api.setup(username, password);
      setupComplete = true;
      username = '';
      password = '';
      await refreshAll();
      if (reauthAction) {
        const action = reauthAction;
        reauthAction = null;
        reauthOpen = false;
        await action();
      }
    } catch (error) {
      authError = error instanceof Error ? error.message : 'Authentication failed.';
    } finally {
      busy = false;
    }
  }

  async function refreshAll() {
    if (!session) return;
    const listed = await api.vaults();
    vaults = listed.vaults;
    if (!vaultId && vaults[0]) {
      vaultId = vaults[0].vault_id;
    }
    await refreshVault();
  }

  async function refreshVault() {
    if (!vaultId) return;
    [dashboard, conflicts] = await Promise.all([api.dashboard(vaultId), api.conflicts(vaultId).then((value) => value.conflicts)]);
    conflicts = [...conflicts].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    });
    if (!selectedConflictId && conflicts[0]) {
      selectedConflictId = conflicts[0].conflict_id;
    }
    if (selectedConflictId) {
      await loadReview(selectedConflictId);
    }
    lastRefreshed = new Date().toLocaleTimeString();
  }

  async function createVault() {
    if (!newVaultName.trim()) return;
    const created = await api.createVault(newVaultName.trim());
    vaults = [...vaults, created];
    vaultId = created.vault_id;
    newVaultName = '';
    notice = 'Vault created.';
    await refreshVault();
  }

  async function loadReview(conflictId: string) {
    if (!vaultId) return;
    selectedConflictId = conflictId;
    setReview(await api.conflict(vaultId, conflictId));
  }

  function setReview(nextReview: ConflictReviewPackage) {
    review = nextReview;
    resolutionKind = 'keep_server';
    selectedReviewPath = review.files[0]?.path ?? '';
    manualTextByPath = Object.fromEntries(
      review.files.map((file) => [file.path, file.server_content ?? file.device_content ?? ''])
    );
    diffTab = review.files[0]?.rendered_markdown_diff ? 'rendered' : 'source';
  }

  async function refreshReview() {
    if (!vaultId || !review) return;
    setReview(await api.refreshConflict(vaultId, review.conflict.conflict_id));
    conflicts = sortConflicts((await api.conflicts(vaultId)).conflicts);
    notice = 'Conflict review refreshed.';
  }

  function selectReviewPath(path: string) {
    selectedReviewPath = path;
    const file = review?.files.find((candidate) => candidate.path === path);
    diffTab = file?.rendered_markdown_diff ? 'rendered' : 'source';
  }

  function updateManualText(path: string, event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    manualTextByPath = { ...manualTextByPath, [path]: target.value };
  }

  function withRecentAuth(action: () => Promise<void>) {
    if (recentAuthValid) {
      void action();
      return;
    }
    reauthAction = action;
    reauthOpen = true;
  }

  async function createPairing() {
    if (!vaultId || !pairDeviceName.trim()) return;
    withRecentAuth(async () => {
      pairing = await api.createPairingToken(vaultId, pairDeviceName.trim());
      notice = 'Pairing token created.';
    });
  }

  async function revokeDevice(device: DashboardDevice) {
    if (!vaultId) return;
    withRecentAuth(async () => {
      if (!confirm(`Revoke ${device.device_name}?`)) return;
      await api.revokeDevice(vaultId, device.device_id);
      notice = 'Device revoked.';
      await refreshVault();
    });
  }

  async function submitResolution() {
    if (!vaultId || !review || review.stale) return;
    withRecentAuth(async () => {
      const manualFiles =
        resolutionKind === 'manual'
          ? Object.fromEntries(review!.files.map((file) => [file.path, manualTextByPath[file.path] ?? '']))
          : undefined;
      await api.resolveConflict({
        vaultId,
        conflictId: review!.conflict.conflict_id,
        expectedMain: review!.expected_main,
        resolutionKind,
        manualFiles
      });
      notice = 'Conflict resolved.';
      await refreshVault();
    });
  }

  async function searchHistory() {
    if (!vaultId || !historyPath.trim()) return;
    history = await api.historyQuery(vaultId, historyPath.trim());
    selectedHistory = history.versions[0] ?? null;
    historyVersion = null;
    if (selectedHistory) {
      await loadHistoryVersion(selectedHistory);
    }
  }

  async function loadHistoryVersion(version: NoteHistoryVersion) {
    if (!vaultId || !history) return;
    selectedHistory = version;
    historyVersion = await api.historyVersion(vaultId, version.path, version.commit);
  }

  async function restoreSelectedVersion() {
    if (!vaultId || !history || !selectedHistory) return;
    withRecentAuth(async () => {
      await api.restoreHistoryVersion(vaultId, history!.path, selectedHistory!.commit, history!.current_main);
      notice = 'Note restored.';
      await refreshVault();
      await searchHistory();
    });
  }

  function handleMaintenanceAction(action: NonNullable<MaintenanceRow['action']>) {
    if (action === 'view_backup_contract') {
      maintenanceDetailOpen = !maintenanceDetailOpen;
      return;
    }
    if (!vaultId) return;
    withRecentAuth(async () => {
      const result = await api.startGitMaintenance(vaultId);
      notice = result.detail;
      await refreshVault();
    });
  }

  async function logout() {
    await api.logout();
    session = null;
    dashboard = null;
    vaults = [];
  }

  function shortId(value: string | null | undefined) {
    return value ? `${value.slice(0, 10)}...` : '-';
  }

  function sortConflicts(items: DashboardConflict[]) {
    return [...items].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    });
  }

  function formatCountdown(milliseconds: number) {
    if (milliseconds <= 0) return 'expired';
    const seconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  function choiceLabel(choice: ConflictResolutionKind) {
    switch (choice) {
      case 'keep_server':
        return 'Keep server version';
      case 'use_device':
        return 'Use device version';
      case 'keep_both_files':
        return 'Keep both files';
      case 'insert_both_blocks':
        return 'Insert both blocks';
      case 'manual':
        return 'Manually edit final result';
    }
  }

</script>

{#if !session}
  <main class="auth">
    <form class="auth-panel" on:submit|preventDefault={authenticate}>
      <h1>{setupComplete ? 'Sign in' : 'Initial setup'}</h1>
      <label>
        Username
        <input bind:value={username} autocomplete="username" />
      </label>
      <label>
        Password
        <input bind:value={password} type="password" autocomplete={setupComplete ? 'current-password' : 'new-password'} />
      </label>
      {#if authError}<p class="error">{authError}</p>{/if}
      <button class="primary" disabled={busy}>{setupComplete ? 'Sign in' : 'Create admin'}</button>
    </form>
  </main>
{:else}
  <div class="shell">
    <aside class:open={mobileNavOpen}>
      <select bind:value={vaultId} on:change={refreshVault} aria-label="Current vault">
        {#each vaults as vault}
          <option value={vault.vault_id}>{vault.display_name}</option>
        {/each}
      </select>
      <nav>
        {#each nav as item}
          <button class:active={page === item} on:click={() => { page = item; mobileNavOpen = false; }}>
            <span>{item}</span>
            {#if item === 'Conflicts' && unresolvedCount > 0}<b>{unresolvedCount}</b>{/if}
          </button>
        {/each}
      </nav>
      <button class="secondary bottom" on:click={logout}>Sign out</button>
    </aside>

    <section class="content">
      <header>
        <button class="icon" title="Open navigation" aria-label="Open navigation" on:click={() => (mobileNavOpen = !mobileNavOpen)}>
          <span aria-hidden="true">☰</span>
        </button>
        <div>
          <h1>{page}</h1>
          <p>{selectedVault?.display_name ?? 'No vault selected'}{dashboard ? ` / ${dashboard.vault.status}` : ''}</p>
        </div>
        <span class="refresh">Refreshed {lastRefreshed ?? '-'}</span>
        <button class="secondary" on:click={refreshVault}>Refresh</button>
        {#if page === 'Overview' && vaultId}<button class="primary" on:click={() => (pairOpen = true)}>Pair device</button>{/if}
      </header>

      {#if notice}<p class="notice">{notice}</p>{/if}

      {#if vaults.length === 0}
        <main class="page">
          <section class="panel full">
            <h2>Create vault</h2>
            <form class="inline-form" on:submit|preventDefault={createVault}>
              <label>Vault name<input bind:value={newVaultName} /></label>
              <button class="primary">Create vault</button>
            </form>
          </section>
        </main>
      {:else if page === 'Overview' && dashboard}
        <main class="grid">
          <Summary title="Sync status" value={dashboard.vault.status === 'active' ? 'Synced' : 'Integrity failure'} role={dashboard.vault.status === 'active' ? 'success' : 'danger'} detail={shortId(dashboard.vault.current_main)} />
          <Summary title="Unresolved conflicts" value={String(unresolvedCount)} role={unresolvedCount ? 'warning' : 'success'} detail="Review queue" />
          <Summary title="Paired devices" value={String(dashboard.devices.length)} role="neutral" detail="Registered devices" />
          <Summary title="Health/readiness" value={dashboard.health.status === 'ready' ? 'Ready' : 'Not ready'} role={dashboard.health.status === 'ready' ? 'success' : 'danger'} detail={dashboard.health.detail ?? dashboard.health.git_version} />
          <section class="panel wide">
            <h2>Devices</h2>
            <DeviceTable devices={dashboard.devices} onRevoke={revokeDevice} />
          </section>
          <section class="panel narrow">
            <h2>Attention</h2>
            <Attention {dashboard} {conflicts} />
          </section>
          <section class="panel wide">
            <h2>Recent activity</h2>
            <table>
              <thead><tr><th>Event</th><th>When</th><th>Main</th><th>Resource</th></tr></thead>
              <tbody>
                {#each dashboard.recent_activity as event}
                  <tr>
                    <td>{event.label}</td>
                    <td>{new Date(event.created_at).toLocaleString()}</td>
                    <td class="mono">{shortId(event.main)}</td>
                    <td class="mono">{shortId(event.conflict_id ?? event.device_id)}</td>
                  </tr>
                {:else}
                  <tr><td colspan="4" class="muted">No activity yet.</td></tr>
                {/each}
              </tbody>
            </table>
          </section>
          <section class="panel narrow">
            <h2>Maintenance and backup</h2>
            <Checklist health={dashboard.health} rows={dashboard.maintenance} onAction={handleMaintenanceAction} />
          </section>
        </main>
      {:else if page === 'Devices' && dashboard}
        <main class="page">
          <section class="panel full">
            <h2>Devices</h2>
            <DeviceTable devices={dashboard.devices} onRevoke={revokeDevice} />
          </section>
        </main>
      {:else if page === 'Conflicts'}
        <main class="conflict-layout">
          <section class="panel list">
            <h2>Conflict center</h2>
            <table>
              <thead><tr><th>Path</th><th>Device</th><th>Conflict type</th><th>Created</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {#each conflicts as conflict}
                  <tr>
                    <td>{conflict.affected_paths[0] ?? '-'}</td>
                    <td>{conflict.device_name}</td>
                    <td>{conflict.conflict_type}</td>
                    <td>{new Date(conflict.created_at).toLocaleString()}</td>
                    <td><Status label={conflict.status_label} /></td>
                    <td><button class="secondary" on:click={() => loadReview(conflict.conflict_id)}>{conflict.stale ? 'Refresh' : 'Open'}</button></td>
                  </tr>
                {:else}
                  <tr><td colspan="6" class="muted">No conflicts.</td></tr>
                {/each}
              </tbody>
            </table>
          </section>
          {#if review}
            <section class="workbench">
              <aside class="rail">
                <h2>{selectedReviewFile?.path ?? 'Conflict'}</h2>
                <p class="muted">Device {review.device_name}</p>
                <p class="mono">Server {shortId(review.expected_main)}</p>
                <p class="mono">Device {shortId(review.conflict.device_commit)}</p>
                <p>{selectedConflict?.conflict_type ?? 'Path overlap'}</p>
                <Status label={review.stale ? 'Stale review' : 'Review needed'} />
                <div class="path-list" aria-label="Affected paths">
                  {#each review.files as file}
                    <button class:active={selectedReviewPath === file.path} on:click={() => selectReviewPath(file.path)}>
                      <span>{file.path}</span>
                    </button>
                  {/each}
                </div>
              </aside>
              <section class="diff">
                {#if review.stale}
                  <p class="warning">This review is stale. Refresh before submitting a resolution.</p>
                {/if}
                <div class="tabs">
                  <button class:active={diffTab === 'rendered'} disabled={!selectedReviewFile?.rendered_markdown_diff} on:click={() => (diffTab = 'rendered')}>Rendered</button>
                  <button class:active={diffTab === 'source'} on:click={() => (diffTab = 'source')}>Source</button>
                </div>
                {#if diffTab === 'rendered' && selectedReviewFile?.rendered_markdown_diff}
                  <div class="rendered">{@html selectedReviewFile.rendered_markdown_diff}</div>
                {:else}
                  <pre>{selectedReviewFile?.source_diff ?? 'No file selected.'}</pre>
                {/if}
                {#if resolutionKind === 'manual' && selectedReviewFile}
                  <textarea
                    value={manualTextByPath[selectedReviewFile.path] ?? ''}
                    on:input={(event) => updateManualText(selectedReviewFile!.path, event)}
                    aria-label={`Manual final result for ${selectedReviewFile.path}`}
                  ></textarea>
                {/if}
              </section>
              <aside class="rail right">
                <h2>Resolution</h2>
                {#each review.choices as choice}
                  <label class="radio"><input type="radio" bind:group={resolutionKind} value={choice} /> {choiceLabel(choice)}</label>
                {/each}
                {#if review.stale}<p class="muted">Refresh review before submitting.</p>{/if}
                {#if review.stale}
                  <button class="primary" on:click={refreshReview}>Refresh review</button>
                {:else}
                  <button class="primary" on:click={submitResolution}>Submit resolution</button>
                {/if}
              </aside>
            </section>
          {:else}
            <section class="panel full"><p class="muted">No conflict selected.</p></section>
          {/if}
        </main>
      {:else if page === 'History'}
        <main class="history-layout">
          <section class="panel history-search">
            <h2>Note history</h2>
            <form class="inline-form" on:submit|preventDefault={searchHistory}>
              <label>Path<input bind:value={historyPath} placeholder="notes/example.md" /></label>
              <button class="primary">Search</button>
            </form>
            {#if history}
              <p class="muted">Current main <code>{shortId(history.current_main)}</code></p>
            {/if}
          </section>
          <section class="timeline">
            <h2>Versions</h2>
            {#if history}
              {#each history.versions as version}
                <button class:active={selectedHistory?.commit === version.commit} on:click={() => loadHistoryVersion(version)}>
                  <span>{version.operation_type}</span>
                  <small>{new Date(version.timestamp).toLocaleString()}</small>
                  {#if version.previous_path}<small>{version.previous_path} → {version.path}</small>{/if}
                  <code>{shortId(version.commit)}</code>
                </button>
              {:else}
                <p class="muted">No versions found for this path.</p>
              {/each}
            {:else}
              <p class="muted">Search for a vault path to inspect its versions.</p>
            {/if}
          </section>
          <section class="preview">
            <h2>Preview</h2>
            {#if historyVersion}
              <p class="mono">{shortId(historyVersion.commit)} / {historyVersion.path}</p>
              <pre>{historyVersion.source_diff || historyVersion.content || 'The selected version deletes this path.'}</pre>
              <button class="primary" disabled={!selectedHistory} on:click={restoreSelectedVersion}>Restore version</button>
            {:else}
              <p class="muted">Select a version to preview it.</p>
            {/if}
          </section>
        </main>
      {:else if page === 'Maintenance' && dashboard}
        <main class="page">
          <section class="panel full">
            <h2>Maintenance</h2>
            <Checklist health={dashboard.health} rows={dashboard.maintenance} onAction={handleMaintenanceAction} />
            {#if maintenanceDetailOpen}
              <p class="muted">Backups must cover metadata and the server Git store at the same point in time, and deployment storage controls are responsible for at-rest protection.</p>
            {/if}
          </section>
        </main>
      {:else}
        <main class="page"><section class="panel full"><p class="muted">Settings are managed through deployment configuration and account administration in this release.</p></section></main>
      {/if}
    </section>
  </div>
{/if}

{#if pairOpen}
  <div class="modal">
    <form class="dialog" on:submit|preventDefault={createPairing}>
      <h2>Pair device</h2>
      <label>Device display name<input bind:value={pairDeviceName} /></label>
      {#if pairing}
        <p class="muted">Expires in {pairingExpiresIn} at {new Date(pairing.expires_at).toLocaleString()}</p>
        <div class="copy">
          <code>{pairing.pairing_url}</code>
          <button
            type="button"
            class="icon-button"
            title="Copy pairing URL"
            aria-label="Copy pairing URL"
            on:click={() => navigator.clipboard.writeText(pairing!.pairing_url)}
          >
            <span aria-hidden="true">⧉</span>
          </button>
        </div>
      {/if}
      <div class="actions">
        <button type="button" class="secondary" on:click={() => { pairOpen = false; pairing = null; }}>Close</button>
        <button class="primary">Create token</button>
      </div>
    </form>
  </div>
{/if}

{#if reauthOpen}
  <div class="modal">
    <form class="dialog" on:submit|preventDefault={authenticate}>
      <h2>Recent authentication</h2>
      <label>Username<input bind:value={username} autocomplete="username" /></label>
      <label>Password<input bind:value={password} type="password" autocomplete="current-password" /></label>
      {#if authError}<p class="error">{authError}</p>{/if}
      <div class="actions">
        <button type="button" class="secondary" on:click={() => (reauthOpen = false)}>Cancel</button>
        <button class="primary">Continue</button>
      </div>
    </form>
  </div>
{/if}
