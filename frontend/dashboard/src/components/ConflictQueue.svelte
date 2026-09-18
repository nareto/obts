<script lang="ts">
  import type { DashboardConflict } from '../api/types';
  import Status from './Status.svelte';

  export let conflicts: DashboardConflict[] = [];
  export let unresolvedCount = 0;
  export let selectedConflictId = '';
  export let listOpen = false;
  export let showList = true;
  export let onSelect: (event: Event) => void | Promise<void> = () => {};
  export let onOpen: (conflict: DashboardConflict) => void | Promise<void> = () => {};
  export let onToggleList: () => void = () => {};
</script>

<section class="conflict-queue-toolbar" aria-labelledby="conflict-queue-title">
  <div>
    <p class="eyebrow">Review queue</p>
    <strong id="conflict-queue-title">Conflicts</strong>
    <span>{unresolvedCount} open / {conflicts.length} total</span>
  </div>
  {#if conflicts.length > 0}
    <label>
      <span>Current review</span>
      <select value={selectedConflictId} on:change={onSelect} aria-label="Current review">
        {#each conflicts as conflict}
          <option value={conflict.conflict_id}>
            {conflict.affected_paths[0] ?? 'Path conflict'} — {conflict.device_name} — {conflict.status_label}
          </option>
        {/each}
      </select>
    </label>
    <button class="secondary" aria-expanded={listOpen} on:click={onToggleList}>
      {listOpen ? 'Hide queue' : 'Browse queue'}
    </button>
  {/if}
</section>

{#if showList}
  <section class="panel conflict-queue-list" aria-labelledby="conflict-queue-list-title">
    <div class="queue-list-heading"><h2 id="conflict-queue-list-title">All conflicts</h2><span class="muted">Review status and provenance before opening a package.</span></div>
    <div class="conflict-queue-table">
      <table>
        <thead><tr><th scope="col">Path</th><th scope="col">Device</th><th scope="col">Conflict type</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
        <tbody>
          {#each conflicts as conflict}
            <tr class:queue-selected={selectedConflictId === conflict.conflict_id}>
              <td data-label="Path"><code title={conflict.affected_paths[0] ?? ''}>{conflict.affected_paths[0] ?? '-'}</code>{#if conflict.affected_path_count > 1}<small class="queue-more-paths">+{conflict.affected_path_count - 1} more path{conflict.affected_path_count === 2 ? '' : 's'}</small>{/if}</td>
              <td data-label="Device">{conflict.device_name}</td>
              <td data-label="Conflict type">{conflict.conflict_type}</td>
              <td data-label="Created"><time datetime={conflict.created_at}>{new Date(conflict.created_at).toLocaleString()}</time></td>
              <td data-label="Status"><Status label={conflict.status_label} /></td>
              <td data-label="Action"><button class="secondary" on:click={() => onOpen(conflict)}>{conflict.stale ? 'Refresh' : 'Review'}</button></td>
            </tr>
          {:else}
            <tr><td colspan="6" class="muted">No conflicts in this vault.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="conflict-queue-cards">
      {#each conflicts as conflict}
        <article class:queue-selected={selectedConflictId === conflict.conflict_id} class="conflict-queue-card">
          <div class="queue-card-heading"><code title={conflict.affected_paths[0] ?? ''}>{conflict.affected_paths[0] ?? 'Path conflict'}</code><Status label={conflict.status_label} /></div>
          {#if conflict.affected_path_count > 1}<small class="queue-more-paths">+{conflict.affected_path_count - 1} more path{conflict.affected_path_count === 2 ? '' : 's'}</small>{/if}
          <dl>
            <div><dt>Device</dt><dd>{conflict.device_name}</dd></div>
            <div><dt>Type</dt><dd>{conflict.conflict_type}</dd></div>
            <div><dt>Created</dt><dd><time datetime={conflict.created_at}>{new Date(conflict.created_at).toLocaleString()}</time></dd></div>
          </dl>
          <button class="secondary" on:click={() => onOpen(conflict)}>{conflict.stale ? 'Refresh review' : 'Review conflict'}</button>
        </article>
      {:else}
        <p class="muted">No conflicts in this vault.</p>
      {/each}
    </div>
  </section>
{/if}
