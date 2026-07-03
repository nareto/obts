<script lang="ts">
  import type { DashboardDevice } from '../api/types';
  import Status from './Status.svelte';

  export let devices: DashboardDevice[];
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;

  function shortId(value: string | null | undefined) {
    return value ? `${value.slice(0, 10)}...` : '-';
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
      <th>Last sync</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    {#each devices as device}
      <tr>
        <td>{device.device_name}</td>
        <td><Status label={device.status_label} /></td>
        <td>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : '-'}</td>
        <td>{device.ahead_of_main ? 'Ahead' : device.behind_main ? 'Behind' : 'Current'}</td>
        <td class="mono">{shortId(device.last_applied_main)}</td>
        <td>{device.last_successful_sync_at ? new Date(device.last_successful_sync_at).toLocaleString() : '-'}</td>
        <td><button class="danger" disabled={device.status === 'revoked'} on:click={() => onRevoke(device)}>Revoke</button></td>
      </tr>
    {/each}
  </tbody>
</table>
