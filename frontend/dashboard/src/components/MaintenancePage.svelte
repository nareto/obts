<script lang="ts">
  import type { DashboardSummary, MaintenanceRow } from '../api/types';
  import Checklist from './Checklist.svelte';
  import Status from './Status.svelte';

  export let health: DashboardSummary['health'];
  export let rows: MaintenanceRow[] = [];
  export let detailOpen = false;
  export let onAction: (action: NonNullable<MaintenanceRow['action']>) => void | Promise<void> = () => {};
</script>

<main class="page maintenance-page">
  <section class="page-intro">
    <div>
      <p class="eyebrow">Operational checks</p>
      <h2>Maintenance</h2>
      <p class="muted">Review server health and run only the maintenance actions provided by this vault.</p>
    </div>
    <div class="maintenance-health">
      <Status label={health.status === 'ready' ? 'Synced' : 'Integrity failure'} />
      <span>{health.git_version}</span>
    </div>
  </section>

  <section class="panel maintenance-panel" aria-labelledby="maintenance-checks-title">
    <div class="section-heading">
      <div><h2 id="maintenance-checks-title">Readiness checks</h2><p class="muted">A passing check does not prove backup freshness.</p></div>
      <span class="section-count">{rows.length} checks</span>
    </div>
    {#if health.detail}<p class="maintenance-health-detail" role="alert">{health.detail}</p>{/if}
    <Checklist {health} rows={rows} onAction={onAction} />
  </section>

  <section class="panel backup-panel" aria-labelledby="backup-title">
    <div class="section-heading">
      <div><p class="eyebrow">Recovery boundary</p><h2 id="backup-title">Backup contract</h2></div>
      <button class="secondary" on:click={() => onAction('view_backup_contract')}>{detailOpen ? 'Hide requirements' : 'View requirements'}</button>
    </div>
    {#if detailOpen}
      <div class="backup-detail">
        <p>Backups must cover metadata and the server Git store at the same point in time. Deployment storage controls are responsible for at-rest protection.</p>
        <p class="muted">This dashboard does not verify backup freshness.</p>
      </div>
    {:else}
      <p class="muted">Read the required metadata and Git-store coverage before relying on a backup.</p>
    {/if}
  </section>
</main>
