<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, DashboardApi } from './api/client';
  import Attention from './components/Attention.svelte';
  import type { AttentionItem } from './components/Attention.svelte';
  import Checklist from './components/Checklist.svelte';
  import DeviceTable from './components/DeviceTable.svelte';
  import Status from './components/Status.svelte';
  import Summary from './components/Summary.svelte';
  import type {
    DashboardConflict,
    ConnectionReview,
    ConflictResolutionKind,
    ConflictReviewPackage,
    ConflictReviewPath,
    DashboardDevice,
    DashboardSummary,
    MaintenanceRow,
    ManualFilePlanEntry,
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
  let createVaultOpen = false;
  let dashboard: DashboardSummary | null = null;
  let conflicts: DashboardConflict[] = [];
  let selectedConflictId = '';
  let review: ConflictReviewPackage | null = null;
  let selectedReviewPath = '';
  let resolutionKind: ConflictResolutionKind = 'keep_server';
  let manualTextByPath: Record<string, string> = {};
  let manualPathByConflict: Record<string, string> = {};
  let manualContentByConflict: Record<string, string> = {};
  let diffTab: 'rendered' | 'source' = 'source';
  const connectionId = window.location.pathname.match(/^\/connect\/([^/]+)$/u)?.[1] ?? '';
  let connectionReview: ConnectionReview | null = null;
  let connectionSelection: 'new_vault' | 'existing_vault' = 'new_vault';
  let connectionVaultId = '';
  let connectionVaultName = '';
  let connectionApproved = false;
  let reauthOpen = false;
  let reauthAction: (() => Promise<void>) | null = null;
  let historyPath = '';
  let history: NoteHistoryQueryResponse | null = null;
  let selectedHistory: NoteHistoryVersion | null = null;
  let historyVersion: NoteHistoryVersionResponse | null = null;
  let historyDiffTab: 'rendered' | 'source' = 'source';
  let maintenanceDetailOpen = false;
  let busy = false;
  let notice = '';
  let actionError = '';
  let lastRefreshed: string | null = null;
  let nowMs = Date.now();

  $: selectedVault = vaults.find((vault) => vault.vault_id === vaultId) ?? null;
  $: unresolvedCount = conflicts.filter((conflict) => conflict.status === 'open').length || dashboard?.unresolved_conflict_count || 0;
  $: selectedConflict = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId) ?? null;
  $: selectedReviewFile = review?.files.find((file) => file.path === selectedReviewPath) ?? review?.files[0] ?? null;
  $: selectedPathConflict = selectedReviewFile
    ? review?.path_conflicts.find((item) => item.affected_paths.includes(selectedReviewFile.path)) ?? review?.path_conflicts[0] ?? null
    : review?.path_conflicts[0] ?? null;
  $: selectedPathConflictKey = selectedPathConflict ? pathConflictKey(selectedPathConflict) : '';
  $: selectedPathHasTitleConflict = selectedPathConflict ? pathConflictHasTitleChange(selectedPathConflict) : false;
  $: reviewResolved = review?.conflict.status === 'resolved';
  $: reviewStatusLabel = reviewResolved ? 'Synced' : review?.stale ? 'Stale review' : 'Review needed';
  $: recentAuthValid = session ? Date.parse(session.recent_auth_expires_at) > nowMs : false;

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
      if (reauthAction && session) {
        session = await api.reauthenticate(username, password);
        const action = reauthAction;
        username = '';
        password = '';
        reauthAction = null;
        reauthOpen = false;
        await action();
      } else {
        session = setupComplete ? await api.login(username, password) : await api.setup(username, password);
        setupComplete = true;
        username = '';
        password = '';
        await refreshAll();
      }
    } catch (error) {
      authError = error instanceof Error ? error.message : 'Authentication failed.';
    } finally {
      busy = false;
    }
  }

  async function refreshAll() {
    if (!session) return;
    if (connectionId) {
      connectionReview = await api.connectionReview(connectionId);
      connectionVaultName ||= connectionReview.local_vault_name;
      connectionVaultId ||= connectionReview.vaults.find((vault) => vault.status === 'active')?.vault_id ?? '';
      return;
    }
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
    const currentConflictExists = conflicts.some((conflict) => conflict.conflict_id === selectedConflictId);
    if (!currentConflictExists) {
      selectedConflictId = '';
      review = null;
    }
    if (!selectedConflictId) {
      selectedConflictId = conflicts.find((conflict) => conflict.status === 'open')?.conflict_id ?? '';
    }
    if (selectedConflictId) {
      await loadReview(selectedConflictId);
    } else {
      review = null;
    }
    lastRefreshed = new Date().toLocaleTimeString();
  }

  async function createVault() {
    if (!newVaultName.trim()) return;
    const created = await api.createVault(newVaultName.trim());
    vaults = [...vaults, created];
    vaultId = created.vault_id;
    newVaultName = '';
    createVaultOpen = false;
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
    manualPathByConflict = Object.fromEntries(
      review.path_conflicts.map((item) => [pathConflictKey(item), item.server_path ?? item.device_path ?? item.base_path ?? item.affected_paths[0] ?? ''])
    );
    manualContentByConflict = Object.fromEntries(
      review.path_conflicts.map((item) => [pathConflictKey(item), defaultPathConflictContent(item, review!)])
    );
    diffTab = review.files[0]?.rendered_markdown_diff ? 'rendered' : 'source';
  }

  async function refreshReview() {
    if (!vaultId || !review) return;
    await refreshConflictReview(review.conflict.conflict_id);
  }

  async function refreshConflictReview(conflictId: string) {
    if (!vaultId) return;
    actionError = '';
    selectedConflictId = conflictId;
    setReview(await api.refreshConflict(vaultId, conflictId));
    conflicts = sortConflicts((await api.conflicts(vaultId)).conflicts);
    notice = 'Conflict review refreshed.';
  }

  async function openConflictFromList(conflict: DashboardConflict) {
    if (conflict.stale) {
      await refreshConflictReview(conflict.conflict_id);
      return;
    }
    await loadReview(conflict.conflict_id);
  }

  async function handleAttentionAction(item: AttentionItem) {
    if (item.kind === 'maintenance') {
      page = 'Maintenance';
      return;
    }
    if (item.kind === 'devices') {
      page = 'Devices';
      return;
    }
    page = 'Conflicts';
    if (item.kind === 'stale_conflict') {
      await refreshConflictReview(item.conflictId);
      return;
    }
    await loadReview(item.conflictId);
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

  function updateManualPath(key: string, event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    manualPathByConflict = { ...manualPathByConflict, [key]: target.value };
  }

  function updateManualPathContent(key: string, event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    manualContentByConflict = { ...manualContentByConflict, [key]: target.value };
  }

  function pathConflictKey(item: ConflictReviewPath) {
    return item.base_path ?? item.affected_paths.join('|');
  }

  function pathConflictHasTitleChange(item: ConflictReviewPath) {
    return item.base_path !== item.server_path || item.base_path !== item.device_path || item.server_path !== item.device_path;
  }

  function pathConflictLabel(item: ConflictReviewPath) {
    if (!pathConflictHasTitleChange(item)) return item.base_path ?? item.server_path ?? item.device_path ?? 'Path overlap';
    return `${item.base_path ?? '(new file)'} -> ${item.server_path ?? '(deleted)'} / ${item.device_path ?? '(deleted)'}`;
  }

  function defaultPathConflictContent(item: ConflictReviewPath, conflictReview: ConflictReviewPackage) {
    const server = item.server_path ? conflictReview.files.find((file) => file.path === item.server_path)?.server_content : null;
    const device = item.device_path ? conflictReview.files.find((file) => file.path === item.device_path)?.device_content : null;
    return server ?? device ?? '';
  }

  function buildManualFilePlan(conflictReview: ConflictReviewPackage): ManualFilePlanEntry[] {
    const plan = new Map<string, string | null>();
    for (const path of conflictReview.conflict.affected_paths) {
      plan.set(path, null);
    }
    for (const item of conflictReview.path_conflicts.filter(pathConflictHasTitleChange)) {
      const key = pathConflictKey(item);
      const path = (manualPathByConflict[key] ?? '').trim();
      if (path) {
        plan.set(path, manualContentByConflict[key] ?? '');
      }
    }
    return [...plan.entries()].map(([path, content]) => ({ path, content }));
  }

  function withRecentAuth(action: () => Promise<void>) {
    if (recentAuthValid) {
      void action();
      return;
    }
    authError = '';
    reauthAction = action;
    reauthOpen = true;
  }

  async function approvePendingConnection() {
    if (!connectionReview) return;
    withRecentAuth(async () => {
      actionError = '';
      if (connectionSelection === 'new_vault') {
        if (!connectionVaultName.trim()) return;
        await api.approveConnection(connectionReview!.connection_id, {
          selection: 'new_vault',
          display_name: connectionVaultName.trim()
        });
      } else {
        if (!connectionVaultId) return;
        await api.approveConnection(connectionReview!.connection_id, {
          selection: 'existing_vault',
          vault_id: connectionVaultId
        });
      }
      connectionApproved = true;
    });
  }

  async function denyPendingConnection() {
    if (!connectionReview) return;
    await api.denyConnection(connectionReview.connection_id);
    connectionReview = { ...connectionReview, status: 'denied' };
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
    actionError = '';
    notice = '';
    const conflictId = review.conflict.conflict_id;
    const hasTitleConflict = review.path_conflicts.some(pathConflictHasTitleChange);
    const manualFiles =
      resolutionKind === 'manual' && !hasTitleConflict
        ? Object.fromEntries(review.files.map((file) => [file.path, manualTextByPath[file.path] ?? '']))
        : undefined;
    const manualFilePlan = resolutionKind === 'manual' && hasTitleConflict ? buildManualFilePlan(review) : undefined;
    try {
      await api.resolveConflict({
        vaultId,
        conflictId,
        expectedMain: review.expected_main,
        resolutionKind,
        manualFiles,
        manualFilePlan
      });
      notice = 'Conflict resolved.';
      selectedConflictId = '';
      review = null;
      await refreshVault();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_conflict_review' && review?.conflict.conflict_id === conflictId) {
        review = { ...review, stale: true };
        conflicts = conflicts.map((conflict) =>
          conflict.conflict_id === conflictId ? { ...conflict, stale: true, status_label: 'Stale review' } : conflict
        );
        actionError = 'This conflict review is stale. Refresh it before submitting a resolution.';
        return;
      }
      actionError = error instanceof Error ? error.message : 'Unable to resolve this conflict.';
    }
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
    historyDiffTab = historyVersion.rendered_markdown_diff ? 'rendered' : 'source';
  }

  function revealPluginHistoryContent() {
    if (!vaultId || !selectedHistory) return;
    withRecentAuth(async () => {
      historyVersion = await api.historyVersion(vaultId, selectedHistory!.path, selectedHistory!.commit, true);
      historyDiffTab = 'source';
      notice = 'Sensitive plugin file content revealed for this selected version.';
    });
  }

  async function restoreSelectedVersion() {
    if (!vaultId || !history || !selectedHistory) return;
    withRecentAuth(async () => {
      await api.restoreHistoryVersion(vaultId, history!.path, selectedHistory!.commit, history!.current_main, selectedHistory!.path);
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

  function choiceLabel(choice: ConflictResolutionKind) {
    switch (choice) {
      case 'keep_server':
        return 'Keep server version';
      case 'use_device':
        return 'Use device version';
      case 'keep_both_files':
        return 'Keep both notes/files';
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
{:else if connectionId}
  <main class="connection-page">
    <section class="connection-panel">
      {#if connectionApproved || connectionReview?.status === 'approved' || connectionReview?.status === 'consumed'}
        <p class="eyebrow">Device authorized</p>
        <h1>Return to Obsidian</h1>
        <p>The plugin will compare the local and server vaults and ask how to handle their contents. You can close this browser tab.</p>
        <div class="connection-code"><span>Verification code</span><strong>{connectionReview?.verification_code}</strong></div>
      {:else if connectionReview?.status === 'denied' || connectionReview?.status === 'expired'}
        <p class="eyebrow">Connection {connectionReview.status}</p>
        <h1>This request cannot continue</h1>
        <p>Return to Obsidian and start setup again.</p>
      {:else if connectionReview}
        <p class="eyebrow">Authorize Obsidian device</p>
        <h1>Connect {connectionReview.local_vault_name}</h1>
        <p>Review the identity shown in Obsidian before approving this request.</p>
        <div class="connection-code"><span>Verification code</span><strong>{connectionReview.verification_code}</strong></div>
        <dl class="connection-details">
          <div><dt>Device</dt><dd>{connectionReview.device_name}</dd></div>
          <div><dt>Plugin</dt><dd>{connectionReview.plugin_version}</dd></div>
          <div><dt>Local content</dt><dd>{connectionReview.local_summary.syncable_file_count.toLocaleString()} files</dd></div>
        </dl>
        <fieldset class="connection-choice">
          <legend>Server vault</legend>
          <label>
            <input type="radio" bind:group={connectionSelection} value="new_vault" />
            <span><strong>Create a new synced vault</strong><small>The local plugin will confirm its initial upload separately.</small></span>
          </label>
          {#if connectionSelection === 'new_vault'}
            <label>Vault name<input bind:value={connectionVaultName} /></label>
          {/if}
          <label>
            <input type="radio" bind:group={connectionSelection} value="existing_vault" />
            <span><strong>Connect to an existing vault</strong><small>The plugin will compare content before changing anything.</small></span>
          </label>
          {#if connectionSelection === 'existing_vault'}
            <label>
              Existing vault
              <select bind:value={connectionVaultId}>
                {#each connectionReview.vaults as vault}
                  <option value={vault.vault_id} disabled={vault.status !== 'active'}>{vault.display_name}{vault.status !== 'active' ? ' — integrity blocked' : ''}</option>
                {/each}
              </select>
            </label>
          {/if}
        </fieldset>
        {#if actionError}<p class="action-error">{actionError}</p>{/if}
        <div class="actions">
          <button class="secondary" on:click={denyPendingConnection}>Deny</button>
          <button class="primary" on:click={approvePendingConnection}>Approve connection</button>
        </div>
      {:else}
        <h1>Loading connection request</h1>
      {/if}
    </section>
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
        {#if page === 'Overview'}<button class="primary" on:click={() => { createVaultOpen = true; newVaultName = ''; }}>New vault</button>{/if}
      </header>

      {#if notice}<p class="notice">{notice}</p>{/if}
      {#if actionError}<p class="action-error">{actionError}</p>{/if}

      {#if createVaultOpen}
        <main class="page">
          <section class="panel full">
            <h2>Create vault</h2>
            <form class="inline-form" on:submit|preventDefault={createVault}>
              <label>Vault name<input bind:value={newVaultName} /></label>
              <button type="button" class="secondary" on:click={() => (createVaultOpen = false)}>Cancel</button>
              <button class="primary">Create vault</button>
            </form>
          </section>
        </main>
      {:else if vaults.length === 0}
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
          <Summary title="Health/readiness" value={dashboard.health.status === 'ready' ? 'Synced' : 'Integrity failure'} role={dashboard.health.status === 'ready' ? 'success' : 'danger'} detail={dashboard.health.detail ?? dashboard.health.git_version} />
          <section class="panel wide">
            <h2>Devices</h2>
            <DeviceTable devices={dashboard.devices} onRevoke={revokeDevice} />
          </section>
          <section class="panel narrow">
            <h2>Attention</h2>
            <Attention {dashboard} {conflicts} onAction={handleAttentionAction} />
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
                    <td><button class="secondary" on:click={() => openConflictFromList(conflict)}>{conflict.stale ? 'Refresh' : 'Open'}</button></td>
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
                <h2>{selectedPathConflict ? pathConflictLabel(selectedPathConflict) : selectedReviewFile?.path ?? 'Conflict'}</h2>
                <p class="muted">Device {review.device_name}</p>
                <p class="mono">Server {shortId(review.expected_main)}</p>
                <p class="mono">Device {shortId(review.conflict.device_commit)}</p>
                <p>{selectedConflict?.conflict_type ?? 'Path overlap'}</p>
                <Status label={reviewStatusLabel} />
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
                {#if selectedPathConflict}
                  <div class:path-warning={selectedPathHasTitleConflict} class="path-review">
                    <div>
                      <span>Base title</span>
                      <code>{selectedPathConflict.base_path ?? '(absent)'}</code>
                    </div>
                    <div>
                      <span>Server title</span>
                      <code>{selectedPathConflict.server_path ?? '(deleted)'}</code>
                      <small>{selectedPathConflict.server_operation}</small>
                    </div>
                    <div>
                      <span>Device title</span>
                      <code>{selectedPathConflict.device_path ?? '(deleted)'}</code>
                      <small>{selectedPathConflict.device_operation}</small>
                    </div>
                  </div>
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
                {#if resolutionKind === 'manual' && selectedPathHasTitleConflict && selectedPathConflict}
                  <label class="manual-title">
                    Final title/path
                    <input
                      value={manualPathByConflict[selectedPathConflictKey] ?? ''}
                      on:input={(event) => updateManualPath(selectedPathConflictKey, event)}
                      aria-label="Manual final note title or path"
                    />
                  </label>
                  <textarea
                    value={manualContentByConflict[selectedPathConflictKey] ?? ''}
                    on:input={(event) => updateManualPathContent(selectedPathConflictKey, event)}
                    aria-label={`Manual final content for ${manualPathByConflict[selectedPathConflictKey] ?? 'custom path'}`}
                  ></textarea>
                {:else if resolutionKind === 'manual' && selectedReviewFile}
                  <textarea
                    value={manualTextByPath[selectedReviewFile.path] ?? ''}
                    on:input={(event) => updateManualText(selectedReviewFile!.path, event)}
                    aria-label={`Manual final result for ${selectedReviewFile.path}`}
                  ></textarea>
                {/if}
              </section>
              <aside class="rail right">
                <h2>Resolution</h2>
                {#if reviewResolved}
                  <p class="muted">Resolved {review.conflict.resolved_at ? new Date(review.conflict.resolved_at).toLocaleString() : ''}</p>
                  {#if review.conflict.resolution_kind}<p>{choiceLabel(review.conflict.resolution_kind)}</p>{/if}
                  {#if review.conflict.resolution_commit}<p class="mono">{shortId(review.conflict.resolution_commit)}</p>{/if}
                {:else}
                  {#each review.choices as choice}
                    <label class="radio"><input type="radio" bind:group={resolutionKind} value={choice} /> {choiceLabel(choice)}</label>
                  {/each}
                  {#if selectedPathHasTitleConflict}
                    <p class="muted">Title conflicts are resolved as file-path changes. Use manual edit for a custom final title.</p>
                  {/if}
                  {#if review.stale}<p class="muted">Refresh review before submitting.</p>{/if}
                {/if}
                {#if review.stale}
                  <button class="primary" on:click={refreshReview}>Refresh review</button>
                {:else if !reviewResolved}
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
                  {#if version.device_id}<small>Device {shortId(version.device_id)}</small>{/if}
                  {#if version.user_id}<small>User {shortId(version.user_id)}</small>{/if}
                  {#if version.conflict_id}<small>Conflict {shortId(version.conflict_id)}</small>{/if}
                  {#if version.merge_sequence}<small>Merge #{version.merge_sequence}</small>{/if}
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
              {#if historyVersion.content_redacted}
                <p class="muted">Plugin file content is redacted by default. Revealing it is an explicit, recently authenticated owner action.</p>
                <button class="secondary" on:click={revealPluginHistoryContent}>Reveal plugin content</button>
              {:else}
                <div class="tabs">
                  <button class:active={historyDiffTab === 'rendered'} disabled={!historyVersion.rendered_markdown_diff} on:click={() => (historyDiffTab = 'rendered')}>Rendered</button>
                  <button class:active={historyDiffTab === 'source'} on:click={() => (historyDiffTab = 'source')}>Source</button>
                </div>
                {#if historyDiffTab === 'rendered' && historyVersion.rendered_markdown_diff}
                  <div class="rendered">{@html historyVersion.rendered_markdown_diff}</div>
                {:else}
                  <pre>{historyVersion.source_diff || historyVersion.content || 'The selected version deletes this path.'}</pre>
                {/if}
              {/if}
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

{#if reauthOpen}
  <div class="modal">
    <form class="dialog" on:submit|preventDefault={authenticate}>
      <h2>Recent authentication</h2>
      <label>Username<input bind:value={username} autocomplete="username" /></label>
      <label>Password<input bind:value={password} type="password" autocomplete="current-password" /></label>
      {#if authError}<p class="error">{authError}</p>{/if}
      <div class="actions">
        <button type="button" class="secondary" on:click={() => { reauthOpen = false; reauthAction = null; }}>Cancel</button>
        <button class="primary">Continue</button>
      </div>
    </form>
  </div>
{/if}
