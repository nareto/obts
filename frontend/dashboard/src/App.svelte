<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, DashboardApi } from './api/client';
  import Attention from './components/Attention.svelte';
  import Checklist from './components/Checklist.svelte';
  import DeviceTable from './components/DeviceTable.svelte';
  import Status from './components/Status.svelte';
  import Summary from './components/Summary.svelte';
  import type {
    ConflictRecord,
    ConflictResolutionKind,
    ConflictReviewPackage,
    DashboardDevice,
    DashboardSummary,
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
  let dashboard: DashboardSummary | null = null;
  let conflicts: ConflictRecord[] = [];
  let selectedConflictId = '';
  let review: ConflictReviewPackage | null = null;
  let resolutionKind: ConflictResolutionKind = 'keep_server';
  let manualText = '';
  let pairOpen = false;
  let pairDeviceName = '';
  let pairing: { pairing_token: string; pairing_url: string; expires_at: string } | null = null;
  let reauthOpen = false;
  let reauthAction: (() => Promise<void>) | null = null;
  let busy = false;
  let notice = '';
  let lastRefreshed: string | null = null;

  $: selectedVault = vaults.find((vault) => vault.vault_id === vaultId) ?? null;
  $: unresolvedCount = conflicts.filter((conflict) => conflict.status === 'open').length || dashboard?.unresolved_conflict_count || 0;
  $: selectedConflict = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId) ?? null;
  $: recentAuthValid = session ? Date.parse(session.recent_auth_expires_at) > Date.now() : false;

  onMount(async () => {
    await bootstrap();
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

  async function loadReview(conflictId: string) {
    if (!vaultId) return;
    selectedConflictId = conflictId;
    review = await api.conflict(vaultId, conflictId);
    resolutionKind = 'keep_server';
    manualText = review.files[0]?.server_content ?? '';
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
      const firstPath = review?.files[0]?.path;
      const manualFiles = resolutionKind === 'manual' && firstPath ? { [firstPath]: manualText } : undefined;
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

  async function logout() {
    await api.logout();
    session = null;
    dashboard = null;
    vaults = [];
  }

  function shortId(value: string | null | undefined) {
    return value ? `${value.slice(0, 10)}...` : '-';
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
        <button class="icon" title="Open navigation" on:click={() => (mobileNavOpen = !mobileNavOpen)}>Menu</button>
        <div>
          <h1>{page}</h1>
          <p>{selectedVault?.display_name ?? 'No vault selected'}{dashboard ? ` / ${dashboard.vault.status}` : ''}</p>
        </div>
        <span class="refresh">Refreshed {lastRefreshed ?? '-'}</span>
        <button class="secondary" on:click={refreshVault}>Refresh</button>
        {#if page === 'Overview'}<button class="primary" on:click={() => (pairOpen = true)}>Pair device</button>{/if}
      </header>

      {#if notice}<p class="notice">{notice}</p>{/if}

      {#if page === 'Overview' && dashboard}
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
            <p class="muted">Main {shortId(dashboard.vault.current_main)} is the current server version.</p>
          </section>
          <section class="panel narrow">
            <h2>Maintenance and backup</h2>
            <Checklist health={dashboard.health} />
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
              <thead><tr><th>Path</th><th>Device</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {#each conflicts as conflict}
                  <tr>
                    <td>{conflict.affected_paths[0] ?? '-'}</td>
                    <td class="mono">{shortId(conflict.device_id)}</td>
                    <td><Status label={conflict.status === 'open' ? 'Review needed' : 'Synced'} /></td>
                    <td><button class="secondary" on:click={() => loadReview(conflict.conflict_id)}>Open</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>
          {#if review}
            <section class="workbench">
              <aside class="rail">
                <h2>{review.conflict.affected_paths[0] ?? 'Conflict'}</h2>
                <p class="muted">Device {review.device_name}</p>
                <p class="mono">Server {shortId(review.expected_main)}</p>
                <p class="mono">Device {shortId(review.conflict.device_commit)}</p>
                <Status label={review.stale ? 'Stale review' : 'Review needed'} />
              </aside>
              <section class="diff">
                {#if review.stale}
                  <p class="warning">This review is stale. Refresh before submitting a resolution.</p>
                {/if}
                <h2>Source diff</h2>
                <pre>{review.files[0]?.source_diff ?? 'No file selected.'}</pre>
                {#if resolutionKind === 'manual'}
                  <textarea bind:value={manualText} aria-label="Manual final result"></textarea>
                {/if}
              </section>
              <aside class="rail right">
                <h2>Resolution</h2>
                {#each review.choices as choice}
                  <label class="radio"><input type="radio" bind:group={resolutionKind} value={choice} /> {choice.replaceAll('_', ' ')}</label>
                {/each}
                <button class="primary" disabled={review.stale} on:click={submitResolution}>Submit resolution</button>
              </aside>
            </section>
          {:else}
            <section class="panel full"><p class="muted">No conflict selected.</p></section>
          {/if}
        </main>
      {:else if page === 'Maintenance' && dashboard}
        <main class="page">
          <section class="panel full">
            <h2>Maintenance</h2>
            <Checklist health={dashboard.health} />
          </section>
        </main>
      {:else}
        <main class="page"><section class="panel full"><p class="muted">This page is ready for the next Phase 2 slice.</p></section></main>
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
        <p class="muted">Expires {new Date(pairing.expires_at).toLocaleString()}</p>
        <div class="copy"><code>{pairing.pairing_url}</code><button type="button" class="secondary" on:click={() => navigator.clipboard.writeText(pairing!.pairing_url)}>Copy</button></div>
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
