<script lang="ts">
  import type { DashboardDevice } from '../api/types';
  import Status from './Status.svelte';

  export let devices: DashboardDevice[];
  export let nowMs: number;
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;

  let openDeviceId = '';

  function shortId(value: string | null | undefined) {
    return value ? `${value.slice(0, 10)}...` : '-';
  }

  function localDetail(device: DashboardDevice) {
    if (device.local_error_code) return device.local_error_code;
    if (device.local_queue_status) return `queue: ${device.local_queue_status}`;
    return '-';
  }

  function effectiveStatus(device: DashboardDevice) {
    if (
      device.status_label === 'Synced' &&
      (!device.last_status_report_at || nowMs - Date.parse(device.last_status_report_at) > 5 * 60 * 1000)
    ) {
      return 'Status unknown';
    }
    return device.status_label;
  }

  function relationDetail(device: DashboardDevice) {
    if (!device.status_report_fresh || !device.last_status_report_at || nowMs - Date.parse(device.last_status_report_at) > 5 * 60 * 1000) return 'Unknown locally';
    if (device.ahead_of_main) return 'Ahead';
    if (device.behind_main) return 'Behind';
    return 'Current';
  }

  function toggleMenu(deviceId: string) {
    openDeviceId = openDeviceId === deviceId ? '' : deviceId;
  }

  async function revoke(device: DashboardDevice) {
    openDeviceId = '';
    await onRevoke(device);
  }
</script>

<table>
  <thead>
    <tr>
      <th>Device</th>
      <th>Status</th>
      <th>Last seen</th>
      <th>Ahead/behind</th>
      <th>Applied version</th>
      <th>Local detail</th>
      <th>Last sync</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each devices as device}
      <tr>
        <td>{device.device_name}</td>
        <td><Status label={effectiveStatus(device)} /></td>
        <td>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : '-'}</td>
        <td>{relationDetail(device)}</td>
        <td class="mono">{shortId(device.last_applied_main)}</td>
        <td>{localDetail(device)}</td>
        <td>{device.last_successful_sync_at ? new Date(device.last_successful_sync_at).toLocaleString() : '-'}</td>
        <td class="action-cell">
          <button
            class="icon-button"
            disabled={device.status === 'revoked'}
            title={device.status === 'revoked' ? 'Device already revoked' : 'Device actions'}
            aria-label={`${device.device_name} actions`}
            on:click={() => toggleMenu(device.device_id)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {#if openDeviceId === device.device_id}
            <div class="action-menu">
              <button class="danger" on:click={() => revoke(device)}>Revoke device</button>
            </div>
          {/if}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
