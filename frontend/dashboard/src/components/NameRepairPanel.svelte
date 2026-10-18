<script lang="ts">
  import type { NamePortabilitySummary, NameRepairPreview, NameRepairRename } from '../api/types';
  import { ApiError } from '../api/client';
  import Icon from './Icon.svelte';

  export let vaultId: string;
  export let summary: NamePortabilitySummary;
  export let currentMain: string;
  export let disabled = false;
  export let onPreview: () => Promise<NameRepairPreview>;
  export let onApply: (preview: NameRepairPreview) => Promise<void>;

  const PREVIEW_ROWS = 25;
  const platformNames: Record<string, string> = { android: 'Android' };

  let preview: NameRepairPreview | null = null;
  let message = '';
  let errorMessage = '';
  let busy = false;
  let showAll = false;
  let ownerKey = vaultId;
  let generation = 0;

  $: if (ownerKey !== vaultId) {
    ownerKey = vaultId;
    generation += 1;
    preview = null;
    message = '';
    errorMessage = '';
    busy = false;
  }
  $: if (preview && currentMain && preview.expected_main !== currentMain) {
    preview = null;
    showAll = false;
    message = 'The vault changed after this preview. Preview the repair again before applying it.';
  }
  $: platforms = summary.restricted_platforms.map((platform) => platformNames[platform] ?? platform).join(' and ') || 'Android';
  $: count = summary.unportable_path_count;
  $: blockedCount = summary.restricted_devices.filter((device) => device.blocked).length;
  $: shownRenames = preview ? (showAll ? preview.renames : preview.renames.slice(0, PREVIEW_ROWS)) : [];
  $: linkCount = preview ? preview.link_updates.reduce((total, update) => total + update.link_count, 0) : 0;

  function plural(value: number, one: string, many = `${one}s`) {
    return `${value} ${value === 1 ? one : many}`;
  }

  function split(path: string) {
    const index = path.lastIndexOf('/');
    return index < 0 ? { parent: '', leaf: path } : { parent: path.slice(0, index + 1), leaf: path.slice(index + 1) };
  }

  function reasonLabel(reason: NameRepairRename['reasons'][number]) {
    return reason === 'case_collision' ? 'Case clash' : 'Reserved characters';
  }

  async function runPreview() {
    const request = ++generation;
    busy = true;
    message = '';
    errorMessage = '';
    showAll = false;
    try {
      const result = await onPreview();
      if (request !== generation) return;
      preview = result;
      message = result.renames.length === 0 ? 'Nothing to repair: every name on the server is already portable.' : '';
    } catch (error) {
      if (request !== generation) return;
      preview = null;
      errorMessage = error instanceof Error ? error.message : 'Unable to preview the repair.';
    } finally {
      if (request === generation) busy = false;
    }
  }

  async function runApply() {
    if (!preview || preview.renames.length === 0) return;
    const request = ++generation;
    const reviewed = preview;
    busy = true;
    message = '';
    errorMessage = '';
    try {
      await onApply(reviewed);
      if (request !== generation) return;
      preview = null;
    } catch (error) {
      if (request !== generation) return;
      if (error instanceof ApiError && error.code === 'stale_name_repair') {
        preview = null;
        message = 'The vault changed after this preview. Preview the repair again before applying it.';
      } else {
        errorMessage = error instanceof Error ? error.message : 'Unable to apply the repair.';
      }
    } finally {
      if (request === generation) busy = false;
    }
  }
</script>

<section class="panel name-repair" aria-labelledby="name-repair-title">
  <div class="name-repair-heading">
    <span class="name-repair-icon" aria-hidden="true"><Icon name="warning" size={18} /></span>
    <div>
      <p class="eyebrow">Vault scope</p>
      <h2 id="name-repair-title">File names need repair</h2>
    </div>
  </div>
  <p class="name-repair-lead">
    {plural(count, 'file or folder', 'files or folders')} on the server {count === 1 ? 'has a name' : 'have names'} that {platforms} can't store:
    characters such as <code>: ? | " &lt; &gt; *</code>, or names that differ only in upper and lower case.
    Other devices handle them fine, but {platforms} devices pause syncing instead of half-applying the vault.
  </p>

  {#if summary.restricted_devices.length}
    <ul class="name-repair-devices" aria-label="Affected devices">
      {#each summary.restricted_devices as device (device.device_id)}
        <li class:blocked={device.blocked}>
          <Icon name={device.blocked ? 'danger' : 'dot'} size={14} />
          <strong>{device.device_name}</strong>
          <span>{device.blocked ? 'Sync paused until the names are repaired' : 'Will pause when it next receives these names'}</span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted name-repair-note">No {platforms} device is paired yet. Repairing now lets one join without stopping.</p>
  {/if}

  <p class="muted name-repair-note">
    The repair renames everything in one server commit and updates wikilinks, Markdown links, embeds and Canvas cards that point to the renamed files.
    Every device picks up the new names on its next sync; unsynced edits to the same notes merge normally.
  </p>

  <div class="settings-actions">
    <button class="secondary" disabled={disabled || busy} on:click={runPreview}>{busy && !preview ? 'Preparing preview…' : preview ? 'Refresh preview' : 'Preview repair'}</button>
    <button class="primary" disabled={disabled || busy || !preview || preview.renames.length === 0} on:click={runApply}>
      {busy && preview ? 'Applying…' : preview ? `Rename ${plural(preview.renames.length, 'item')}` : 'Apply repair'}
    </button>
  </div>
  {#if blockedCount && !preview && !message && !errorMessage}
    <p class="muted name-repair-note">Preview first: nothing changes until you confirm the exact list.</p>
  {/if}
  {#if message}<p class="muted" role="status">{message}</p>{/if}
  {#if errorMessage}<div class="inline-error" role="alert"><p>{errorMessage}</p></div>{/if}

  {#if preview && preview.renames.length}
    <div class="name-repair-preview" aria-live="polite">
      <div class="name-repair-facts">
        <div><span>Renames</span><strong>{preview.renames.length}</strong></div>
        <div><span>Notes with updated links</span><strong>{preview.link_updates.length}</strong></div>
        <div><span>Links rewritten</span><strong>{linkCount}</strong></div>
      </div>
      <div class="name-repair-table-wrap">
        <table class="name-repair-table">
          <colgroup><col /><col class="name-repair-arrow-col" /><col /><col class="name-repair-why-col" /></colgroup>
          <thead><tr><th scope="col">Current name</th><th scope="col"><span class="visually-hidden">Becomes</span></th><th scope="col">New name</th><th scope="col">Why</th></tr></thead>
          <tbody>
            {#each shownRenames as rename (rename.from)}
              {@const from = split(rename.from)}
              {@const to = split(rename.to)}
              <tr>
                <td data-label="Current"><code><span class="name-repair-parent">{from.parent}</span><span class="name-repair-old">{from.leaf}</span></code>{#if rename.kind === 'directory'}<small class="name-repair-kind">folder</small>{/if}</td>
                <td class="name-repair-arrow" aria-hidden="true">→</td>
                <td data-label="New"><code><span class="name-repair-parent">{to.parent}</span><span class="name-repair-new">{to.leaf}</span></code></td>
                <td data-label="Why"><span class="name-repair-reasons">{#each rename.reasons as reason}<span class="name-repair-chip" class:case={reason === 'case_collision'}>{reasonLabel(reason)}</span>{/each}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if preview.renames.length > PREVIEW_ROWS}
        <button class="secondary name-repair-more" on:click={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${preview.renames.length} renames`}</button>
      {/if}
      {#if preview.link_updates.length}
        <details class="name-repair-links">
          <summary>Links updated in {plural(preview.link_updates.length, 'note')}</summary>
          <ul>
            {#each preview.link_updates as update (update.path)}
              <li><code>{update.path}</code><span class="muted">{plural(update.link_count, 'link')}</span></li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
  {/if}
</section>
