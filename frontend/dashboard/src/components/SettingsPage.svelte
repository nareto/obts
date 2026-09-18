<script lang="ts">
  import type { DiagnosticEventsResponse, Session, VaultDeletionStatus, VaultSummary } from '../api/types';
  import Diagnostics from './Diagnostics.svelte';
  import Status from './Status.svelte';

  export let session: Session;
  export let recentAuthValid = false;
  export let diagnostics: DiagnosticEventsResponse | null = null;
  export let diagnosticsError = '';
  export let diagnosticsLoading = false;
  export let busy = false;
  export let onRefreshDiagnostics: () => void | Promise<void> = () => {};
  export let onLoadMoreDiagnostics: () => void | Promise<void> = () => {};
  export let onDeleteDiagnostics: () => void | Promise<void> = () => {};
  export let onSignOut: () => void | Promise<void> = () => {};
  export let deletions: VaultDeletionStatus[] = [];
  export let selectedVault: VaultSummary | null = null;
  export let vaultDeleting = false;
  export let deletionBusy = false;
  export let onOpenVaultDeletion: () => void = () => {};
</script>

<main class="page settings-page">
  <section class="page-intro">
    <div>
      <p class="eyebrow">Account controls</p>
      <h2>Settings</h2>
      <p class="muted">Manage the active session and consented troubleshooting data.</p>
    </div>
    <button class="danger settings-signout" disabled={busy} on:click={() => onSignOut()}>Sign out</button>
  </section>

  <section class="settings-grid">
    <section class="panel session-panel" aria-labelledby="session-title">
      <div class="section-heading"><div><h2 id="session-title">Session</h2><p class="muted">This account is currently authenticated in this browser.</p></div><Status label={recentAuthValid ? 'Current' : 'Review needed'} /></div>
      <dl class="settings-facts">
        <div><dt>Account</dt><dd><code title={session.user_id}>{session.user_id}</code></dd></div>
        <div><dt>Recent authentication</dt><dd>{recentAuthValid ? 'Valid for consequential actions' : 'Reauthentication required when needed'}</dd></div>
      </dl>
      <p class="muted settings-note">Signing out clears this dashboard view immediately. If server sign-out fails, retry is offered without implying the remote session ended.</p>
    </section>

    <section class="panel diagnostics-settings" aria-labelledby="diagnostics-title">
      <div class="section-heading">
        <div><p class="eyebrow">Consent and redaction</p><h2 id="diagnostics-title">Troubleshooting diagnostics</h2></div>
        <button class="secondary" disabled={busy || diagnosticsLoading} on:click={() => onRefreshDiagnostics()}>Refresh</button>
      </div>
      {#if diagnosticsError}
        <div class="inline-error" role="alert"><strong>Diagnostics unavailable</strong><p>{diagnosticsError}</p><button class="secondary" disabled={busy || diagnosticsLoading} on:click={() => onRefreshDiagnostics()}>Try again</button></div>
      {/if}
      {#if diagnostics}
        <Diagnostics {diagnostics} busy={busy || diagnosticsLoading} onLoadMore={onLoadMoreDiagnostics} onDelete={onDeleteDiagnostics} />
      {:else if !diagnosticsError}
        <p class="loading-state-inline" aria-live="polite">Loading consented diagnostics…</p>
      {/if}
    </section>
  </section>

  <section class="panel deletion-settings" aria-labelledby="vault-deletion-action-title">
    <div class="section-heading">
      <div><p class="eyebrow">Server scope</p><h2 id="vault-deletion-action-title">Delete a vault</h2></div>
      {#if vaultDeleting}<Status label="Deleting" />{/if}
    </div>
    {#if selectedVault}
      <p>Delete the server-held vault <strong>{selectedVault.display_name}</strong>. This does not delete local client files, independent Bridge state, or existing backups.</p>
      <dl class="deletion-target-facts">
        <div><dt>Display name</dt><dd>{selectedVault.display_name}</dd></div>
        <div><dt>Full vault ID</dt><dd><code>{selectedVault.vault_id}</code></dd></div>
      </dl>
      <button class="danger" disabled={busy || vaultDeleting || deletionBusy} on:click={onOpenVaultDeletion}>{vaultDeleting ? 'Deletion in progress' : 'Delete this server vault'}</button>
    {:else}
      <p class="muted">No active vault is selected. Create a vault below or review pending and recent deletion receipts.</p>
    {/if}
  </section>

  <section class="panel" aria-labelledby="vault-deletions-title">
    <div class="section-heading"><div><p class="eyebrow">Receipts and operations</p><h2 id="vault-deletions-title">Vault deletion status</h2></div></div>
    {#if deletions.length === 0}
      <p class="muted">No pending or recent server vault deletions.</p>
    {:else}
      <ul class="deletion-status-list">
        {#each deletions as deletion}
          <li>
            <div class="deletion-status-heading"><code>{deletion.vault_id}</code><Status label={deletion.status === 'deleting' ? 'Deleting' : 'Deleted'} /></div>
            {#if deletion.status === 'deleting'}
              <p class="muted">Deletion accepted; server work is still in progress. It is not yet confirmed complete.</p>
              {#if deletion.error_code}<p class="deletion-retry" role="status"><strong>Retry needed:</strong> {deletion.error_code === 'storage_unavailable' ? 'Server storage is temporarily unavailable.' : deletion.error_code === 'unattributed_residue' ? 'The server found residue it cannot safely attribute.' : 'Server deletion metadata is temporarily unavailable.'}</p>{/if}
              {#if deletion.retry_at}<p class="muted">The server will retry after <time datetime={deletion.retry_at}>{new Date(deletion.retry_at).toLocaleString()}</time>.</p>{/if}
            {:else}
              <p class="muted">Completed deletion receipt. This opaque receipt remains available until <time datetime={deletion.receipt_expires_at ?? ''}>{deletion.receipt_expires_at ? new Date(deletion.receipt_expires_at).toLocaleString() : 'receipt expiry'}.</time></p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  <slot name="destructive-actions" />
</main>
