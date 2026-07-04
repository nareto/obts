<script lang="ts">
  import type { MaintenanceRow } from '../api/types';
  import Status from './Status.svelte';

  export let health: {
    status: 'ready' | 'not_ready';
    checks: Record<string, boolean>;
    detail: string | null;
    git_version: string;
  };
  export let rows: MaintenanceRow[] | null = null;
  export let onAction: (action: NonNullable<MaintenanceRow['action']>) => void | Promise<void> = () => {};

  const fallbackRows = [
    ['metadata_store', 'Postgres'],
    ['git_store', 'Server Git store'],
    ['temp_workspace', 'Temp workspace'],
    ['migrations', 'Migrations'],
    ['git', 'Native git'],
    ['filesystem_permissions', 'Filesystem permissions'],
    ['event_delivery', 'Event delivery'],
    ['persistent_state', 'Persistent-state backup contract']
  ] as const;

  $: visibleRows = rows ?? fallbackRows.map((row) => ({
    key: row[0],
    label: row[1],
    status_label: health.checks[row[0]] ? 'Synced' : 'Integrity failure',
    last_checked_at: new Date().toISOString(),
    detail: health.checks[row[0]] ? 'Last checked now' : health.detail ?? 'Check failed'
  } satisfies MaintenanceRow));
</script>

<div class="checklist">
  {#each visibleRows as row}
    <div>
      <span>{row.label}</span>
      <Status label={row.status_label} />
      <small>{row.detail} Checked {new Date(row.last_checked_at).toLocaleString()}.</small>
      {#if row.action}
        <button class="secondary row-action" on:click={() => onAction(row.action!)}>{row.action === 'start_git_maintenance' ? 'Run' : 'View'}</button>
      {/if}
    </div>
  {/each}
</div>
