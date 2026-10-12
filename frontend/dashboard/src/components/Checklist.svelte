<script lang="ts">
  import type { DashboardHealth, MaintenanceRow } from '../api/types';
  import { checkedLabel, checkedTitle, effectiveHealthState } from '../presentation';
  import Status from './Status.svelte';

  export let health: DashboardHealth;
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

  // Without server rows, only a verified or not-ready sample says anything per check; every other state admits it.
  $: observed = ['verified', 'not_ready'].includes(effectiveHealthState(health));
  $: visibleRows =
    rows ??
    fallbackRows.map(
      (row) =>
        ({
          key: row[0],
          label: row[1],
          status_label: !observed ? (health.checking ? 'Checking' : 'Status unknown') : health.checks[row[0]] ? 'Synced' : 'Integrity failure',
          last_checked_at: health.checked_at,
          detail: !observed ? health.detail ?? 'Readiness is not verified.' : health.checks[row[0]] ? 'Check passed.' : health.detail ?? 'Check failed.'
        }) satisfies MaintenanceRow
    );
</script>

<div class="checklist">
  {#each visibleRows as row}
    <div>
      <span>{row.label}</span>
      <Status label={row.status_label} />
      <small>{#if row.detail.trim()}{row.detail.trim().replace(/[.\s]+$/u, '')}{' · '}{/if}<span class="checked-at" title={checkedTitle(row.last_checked_at)}>{checkedLabel(row.last_checked_at)}</span></small>
      {#if row.action}
        <button class="secondary row-action" on:click={() => onAction(row.action!)}>{row.action === 'start_git_maintenance' ? 'Run' : 'View'}</button>
      {/if}
    </div>
  {/each}
</div>
