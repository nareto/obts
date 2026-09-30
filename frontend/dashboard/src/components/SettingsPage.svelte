<script lang="ts">
  import type { DiagnosticEventsResponse, MetadataConflictRule, Session, VaultDeletionStatus, VaultSummary, VaultSyncSettings, VaultSyncSettingsPreview } from '../api/types';
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
  export let currentMain = '';
  export let vaultDeleting = false;
  export let deletionBusy = false;
  export let onOpenVaultDeletion: () => void = () => {};
  export let syncSettings: VaultSyncSettings | null = null;
  export let syncSettingsError = '';
  export let syncSettingsLoading = false;
  export let syncSettingsSaving = false;
  export let onLoadSyncSettings: () => boolean | void | Promise<boolean | void> = () => {};
  export let onPreviewSyncSettings: (rootIgnore: string | null, rules: MetadataConflictRule[]) => Promise<VaultSyncSettingsPreview> = async () => { throw new Error('Settings preview is unavailable.'); };
  export let onSaveSyncSettings: (rootIgnore: string | null, rules: MetadataConflictRule[], preview: VaultSyncSettingsPreview) => void | Promise<void> = () => {};

  let settingsKey = '';
  let draftOwnerKey = '';
  let settingsRequestGeneration = 0;
  let hasRootIgnore = false;
  let rootIgnoreDraft = '';
  let conflictFieldsDraft = '';
  let settingsPreview: VaultSyncSettingsPreview | null = null;
  let settingsMessage = '';
  let settingsBusy = false;

  $: if (draftOwnerKey !== `${session.user_id}:${selectedVault?.vault_id ?? ''}`) {
    draftOwnerKey = `${session.user_id}:${selectedVault?.vault_id ?? ''}`;
    settingsKey = '';
    settingsRequestGeneration += 1;
    settingsPreview = null;
    settingsMessage = '';
    settingsBusy = false;
  }
  $: if (selectedVault?.status === 'active' && !syncSettings && !syncSettingsLoading && !syncSettingsError) void onLoadSyncSettings();
  $: if (settingsPreview && currentMain && settingsPreview.expected_main !== currentMain) {
    settingsPreview = null;
    settingsMessage = 'Vault main advanced. Your draft is preserved; reload settings and preview again before saving.';
  }
  $: if (syncSettings && settingsKey !== `${draftOwnerKey}:${syncSettings.current_main}:${syncSettings.root_ignore_oid ?? 'absent'}:${JSON.stringify(syncSettings.metadata_conflict_rules)}`) {
    settingsKey = `${draftOwnerKey}:${syncSettings.current_main}:${syncSettings.root_ignore_oid ?? 'absent'}:${JSON.stringify(syncSettings.metadata_conflict_rules)}`;
    if (!settingsBusy) settingsRequestGeneration += 1;
    hasRootIgnore = syncSettings.root_ignore !== null;
    rootIgnoreDraft = syncSettings.root_ignore ?? '';
    conflictFieldsDraft = syncSettings.metadata_conflict_rules.map((rule) => rule.field).join('\n');
    settingsPreview = null;
    settingsMessage = '';
  }

  function invalidateSettingsPreview() {
    settingsRequestGeneration += 1;
    settingsPreview = null;
  }

  async function reloadSettings() {
    const dirty = syncSettings && (hasRootIgnore !== (syncSettings.root_ignore !== null) ||
      rootIgnoreDraft !== (syncSettings.root_ignore ?? '') ||
      conflictFieldsDraft !== syncSettings.metadata_conflict_rules.map((rule) => rule.field).join('\n'));
    if (dirty && !window.confirm('Discard your unsaved sync rule changes and reload the server settings?')) return;
    invalidateSettingsPreview();
    const ownerKey = draftOwnerKey;
    const reloaded = await onLoadSyncSettings();
    if (reloaded && ownerKey === draftOwnerKey) settingsKey = '';
  }

  function editedRules(): MetadataConflictRule[] {
    const fields = conflictFieldsDraft.split(/\r?\n/u).map((field) => field.trim()).filter(Boolean);
    if (new Set(fields).size !== fields.length || fields.some((field) => !/^[A-Za-z0-9_-]{1,128}$/u.test(field))) {
      throw new Error('Use one unique top-level field name per line (letters, numbers, _ and -).');
    }
    if (fields.length > 64) throw new Error('Configure at most 64 fields.');
    return fields.map((field) => ({ field, strategy: 'latest_timestamp' }));
  }

  async function previewSettings() {
    if (!syncSettings) return;
    settingsBusy = true;
    settingsMessage = '';
    const generation = ++settingsRequestGeneration;
    const ownerKey = draftOwnerKey;
    try {
      const result = await onPreviewSyncSettings(hasRootIgnore ? rootIgnoreDraft : null, editedRules());
      if (generation !== settingsRequestGeneration || ownerKey !== draftOwnerKey) return;
      settingsPreview = result;
      settingsMessage = 'Preview is current. Review the affected paths before saving.';
    } catch (error) {
      if (generation === settingsRequestGeneration && ownerKey === draftOwnerKey) {
        settingsPreview = null;
        settingsMessage = error instanceof Error ? error.message : 'Unable to preview settings.';
      }
    } finally {
      if (generation === settingsRequestGeneration && ownerKey === draftOwnerKey) settingsBusy = false;
    }
  }

  async function saveSettings() {
    if (!syncSettings || !settingsPreview) return;
    settingsBusy = true;
    const generation = settingsRequestGeneration;
    const ownerKey = draftOwnerKey;
    try {
      await onSaveSyncSettings(hasRootIgnore ? rootIgnoreDraft : null, editedRules(), settingsPreview);
      if (generation !== settingsRequestGeneration || ownerKey !== draftOwnerKey) return;
      settingsPreview = null;
      settingsMessage = 'Settings saved.';
    } catch (error) {
      if (generation === settingsRequestGeneration && ownerKey === draftOwnerKey) {
        settingsMessage = error instanceof Error ? error.message : 'Unable to save settings.';
      }
    } finally {
      if (generation === settingsRequestGeneration && ownerKey === draftOwnerKey) settingsBusy = false;
    }
  }
</script>

<main class="page settings-page">
  <section class="page-intro">
    <div>
      <p class="eyebrow">Vault and account controls</p>
      <h2>Settings</h2>
      <p class="muted">Manage shared sync rules, your session, and troubleshooting data.</p>
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

  {#if selectedVault}
    <section class="panel vault-sync-settings" aria-labelledby="vault-sync-settings-title">
      <div class="section-heading">
        <div><p class="eyebrow">Vault scope</p><h2 id="vault-sync-settings-title">Sync rules</h2><p class="muted">These settings apply only to <strong>{selectedVault.display_name}</strong>.</p></div>
        <button class="secondary" disabled={settingsBusy || syncSettingsSaving || syncSettingsLoading || selectedVault.status !== 'active'} on:click={reloadSettings}>{syncSettingsLoading ? 'Loading…' : 'Reload settings'}</button>
      </div>
      {#if selectedVault.status !== 'active'}
        <div class="inline-error" role="status"><p>{selectedVault.status === 'deleting' ? 'Sync rules are unavailable while this vault is being deleted.' : 'Sync rules are unavailable while this vault is blocked. Resolve the vault status before editing.'}</p></div>
      {/if}
      {#if syncSettingsError}
        <div class="inline-error" role="alert"><p>{syncSettingsError}</p></div>
      {/if}
      {#if syncSettings}
        <fieldset disabled={settingsBusy || syncSettingsSaving || syncSettingsLoading || selectedVault.status !== 'active'}>
          <label class="settings-check"><input type="checkbox" bind:checked={hasRootIgnore} on:change={invalidateSettingsPreview} /> Use shared sync exclusions</label>
          <p class="muted">Rules are stored in the shared <code>.gitignore</code> file. Newly excluded files stop syncing; existing local copies and server history are preserved.</p>
          {#if hasRootIgnore}
            <label class="settings-editor-label">Excluded files and folders<textarea class="settings-textarea" bind:value={rootIgnoreDraft} spellcheck="false" rows="9" placeholder={'private/\n*.tmp'} on:input={invalidateSettingsPreview}></textarea></label>
            <p class="muted">One gitignore-style pattern per line. Unexcluding a path does not automatically restore its old server version.</p>
          {/if}
          <label class="settings-editor-label">Frontmatter fields for timestamp conflict resolution<textarea class="settings-textarea settings-fields" bind:value={conflictFieldsDraft} spellcheck="false" rows="4" placeholder={'updated\nmodified'} on:input={invalidateSettingsPreview}></textarea></label>
          <p class="muted"><strong>Latest timestamp:</strong> keep the newer value only when the rest of the note is identical. Enter one top-level field name per line.</p>
          <p class="muted">Supported values look like <code>2026-04-12T14:30:00+02:00</code> or <code>2026-04-12T12:30:00Z</code>, with up to nine fractional digits. Unzoned, invalid, or unsupported values remain conflicts. Rules affect future merges; existing conflicts still need review.</p>
          <div class="settings-actions"><button class="secondary" disabled={settingsBusy || syncSettingsSaving} on:click={previewSettings}>Preview changes</button><button class="primary" disabled={settingsBusy || syncSettingsSaving || !settingsPreview} on:click={saveSettings}>Save settings</button></div>
        </fieldset>
        {#if settingsMessage}<p class="muted" role="status">{settingsMessage}</p>{/if}
        {#if settingsPreview}
          <div class="settings-preview" aria-live="polite">
            <h3>Preview</h3>
            <p>{settingsPreview.affected_paths.length} tracked files and {settingsPreview.affected_directories.length} explicit directories will become excluded. {settingsPreview.changes_main ? 'Saving advances the shared main ref.' : 'The root policy bytes do not change.'}</p>
            {#if settingsPreview.affected_paths.length}<p><strong>Files:</strong> {settingsPreview.affected_paths.slice(0, 12).join(', ')}{settingsPreview.affected_paths.length > 12 ? ' (and more)' : ''}</p>{/if}
            {#if settingsPreview.affected_directories.length}<p><strong>Directories:</strong> {settingsPreview.affected_directories.slice(0, 12).join(', ')}{settingsPreview.affected_directories.length > 12 ? ' (and more)' : ''}</p>{/if}
          </div>
        {/if}
      {:else if selectedVault.status === 'active' && !syncSettingsLoading && !syncSettingsError}
        <p class="muted">Sync settings are not loaded yet.</p>
      {/if}
    </section>
  {/if}

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
