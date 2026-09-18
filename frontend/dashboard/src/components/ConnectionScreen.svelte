<script lang="ts">
  import type { ConnectionReview } from '../api/types';

  export let connectionReview: ConnectionReview | null = null;
  export let connectionSelection: 'new_vault' | 'existing_vault' = 'new_vault';
  export let connectionVaultId = '';
  export let connectionVaultName = '';
  export let connectionApproved = false;
  export let operationPending = false;
  export let modalOpen = false;
  export let actionError = '';
  export let onApprove: () => void | Promise<void> = () => {};
  export let onDeny: () => void | Promise<void> = () => {};
</script>

<main class="connection-page" inert={modalOpen}>
  <section class="connection-panel" aria-labelledby="connection-title">
    {#if connectionApproved || connectionReview?.status === 'approved' || connectionReview?.status === 'consumed'}
      <p class="eyebrow">Device authorized</p>
      <h1 id="connection-title">Return to Obsidian</h1>
      <p>The plugin will compare the local and server vaults and ask how to handle their contents. You can close this browser tab.</p>
      <div class="connection-code"><span>Verification code</span><strong>{connectionReview?.verification_code}</strong></div>
    {:else if connectionReview?.status === 'denied' || connectionReview?.status === 'expired'}
      <p class="eyebrow">Connection {connectionReview.status}</p>
      <h1 id="connection-title">This request cannot continue</h1>
      <p>Return to Obsidian and start setup again.</p>
    {:else if connectionReview}
      <p class="eyebrow">Authorize Obsidian device</p>
      <h1 id="connection-title">Connect {connectionReview.local_vault_name}</h1>
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
          <input type="radio" bind:group={connectionSelection} value="new_vault" disabled={operationPending} />
          <span><strong>Create a new synced vault</strong><small>The local plugin will confirm its initial upload separately.</small></span>
        </label>
        {#if connectionSelection === 'new_vault'}
          <label>Vault name<input bind:value={connectionVaultName} disabled={operationPending} /></label>
        {/if}
        <label>
          <input type="radio" bind:group={connectionSelection} value="existing_vault" disabled={operationPending} />
          <span><strong>Connect to an existing vault</strong><small>The plugin will compare content before changing anything.</small></span>
        </label>
        {#if connectionSelection === 'existing_vault'}
          <label>
            Existing vault
            <select bind:value={connectionVaultId} disabled={operationPending}>
              {#each connectionReview.vaults as vault}
                <option value={vault.vault_id} disabled={vault.status !== 'active'}>{vault.display_name}{vault.status === 'deleting' ? ' — deleting' : vault.status === 'blocked_integrity' ? ' — integrity blocked' : ''}</option>
              {/each}
            </select>
          </label>
        {/if}
      </fieldset>
      {#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}
      <div class="actions connection-actions">
        <button class="secondary" disabled={operationPending} on:click={async () => await onDeny()}>Deny</button>
        <button class="primary" disabled={operationPending} on:click={async () => await onApprove()}>Approve connection</button>
      </div>
    {:else}
      <p class="eyebrow">Obsidian connection</p>
      <h1 id="connection-title">Loading connection request</h1>
      <p class="muted" aria-live="polite">Waiting for the server to return this request.</p>
    {/if}
  </section>
</main>
