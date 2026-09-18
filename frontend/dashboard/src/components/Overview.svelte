<script lang="ts">
  import type { DashboardConflict, DashboardSummary, MaintenanceRow } from '../api/types';
  import Attention from './Attention.svelte';
  import type { AttentionItem } from './Attention.svelte';
  import Checklist from './Checklist.svelte';
  import DeviceTable from './DeviceTable.svelte';
  import Summary from './Summary.svelte';
  import Status from './Status.svelte';
  import type { DashboardDevice } from '../api/types';
  import { exactTime, relativeTime } from '../presentation';

  export let dashboard: DashboardSummary;
  export let conflicts: DashboardConflict[];
  export let unresolvedCount: number;
  export let statusCurrent: boolean;
  export let syncSummary: {
    label: string;
    role: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  };
  export let onAttention: (item: AttentionItem) => void | Promise<void>;
  export let onMaintenance: (action: NonNullable<MaintenanceRow['action']>) => void;
  export let onRename: (device: DashboardDevice, deviceName: string) => void | Promise<void>;
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;

  $: checksPassed = dashboard.health.status === 'ready' && dashboard.maintenance.every((row) => row.status_label === 'Synced');
</script>

<main class="overview-page">
  <section class="summary-strip" aria-label="Vault summary">
    <Summary title="Sync status" value={syncSummary.label} role={syncSummary.role} detail={dashboard.vault.current_main} technical />
    <Summary title="Unresolved conflicts" value={String(unresolvedCount)} role={unresolvedCount ? 'warning' : 'success'} detail="Review queue" />
    <Summary title="Paired devices" value={String(dashboard.devices.length)} role="neutral" detail="Registered devices" />
    <Summary title="Server readiness" value={dashboard.health.status === 'ready' ? 'Ready' : 'Integrity failure'} role={dashboard.health.status === 'ready' ? 'success' : 'danger'} detail={dashboard.health.detail ?? dashboard.health.git_version} />
  </section>

  <div class="overview-columns overview-primary-columns">
    <section class="panel overview-section devices-overview">
      <div class="section-heading">
        <h2>Devices</h2>
        <span class="section-count">{dashboard.devices.length} paired</span>
      </div>
      <DeviceTable compact={true} devices={dashboard.devices} recommendedPluginVersion={dashboard.recommended_plugin_version} statusCurrent={statusCurrent} onRename={onRename} onRevoke={onRevoke} />
    </section>

    <section class="panel overview-section attention-overview">
      <div class="section-heading">
        <h2>Attention</h2>
      </div>
      <Attention {dashboard} {conflicts} onAction={onAttention} />
    </section>
  </div>

  <div class="overview-columns overview-secondary-columns">
    <section class="panel overview-section activity-overview">
      <div class="section-heading">
        <h2>Recent activity</h2>
      </div>
      <div class="activity-table-wrap">
        <table class="activity-table">
          <thead><tr><th>Event</th><th>When</th><th>Main</th><th>Resource</th></tr></thead>
          <tbody>
            {#each dashboard.recent_activity as event}
              <tr>
                <td>
                  {event.label}
                  <details class="activity-meta">
                    <summary>Event details</summary>
                    <dl>
                      <div><dt>When</dt><dd>{exactTime(event.created_at)}</dd></div>
                      <div><dt>Main</dt><dd class="mono">{event.main ?? '—'}</dd></div>
                      <div><dt>Resource</dt><dd class="mono">{event.conflict_id ?? event.device_id ?? '—'}</dd></div>
                    </dl>
                  </details>
                </td>
                <td>
                  <time datetime={event.created_at} title={exactTime(event.created_at)} aria-label={exactTime(event.created_at)}>{relativeTime(event.created_at)}</time>
                </td>
                <td class="mono activity-identifier" title={event.main ?? ''}>{event.main ?? '—'}</td>
                <td class="mono activity-identifier" title={event.conflict_id ?? event.device_id ?? ''}>{event.conflict_id ?? event.device_id ?? '—'}</td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">No activity yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel overview-section maintenance-overview">
      <div class="section-heading">
        <h2>Maintenance and backup</h2>
      </div>
      <details class="maintenance-checks" open={!checksPassed}>
        <summary><Status label={checksPassed ? 'Current' : 'Review needed'} /><span>{dashboard.maintenance.length} readiness checks</span></summary>
        <Checklist health={dashboard.health} rows={dashboard.maintenance} onAction={onMaintenance} />
      </details>
      <p class="muted maintenance-note">Readiness checks do not verify backup freshness.</p>
      <button class="secondary" on:click={() => onMaintenance('view_backup_contract')}>Backup requirements</button>
    </section>
  </div>
</main>
