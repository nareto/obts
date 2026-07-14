<script lang="ts">
  import { tick } from 'svelte';
  import type { DashboardDevice } from '../api/types';
  import Status from './Status.svelte';

  export let devices: DashboardDevice[];
  export let nowMs: number;
  export let onRename: (device: DashboardDevice, deviceName: string) => void | Promise<void>;
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;

  let openDeviceId = '';
  let editingDeviceId = '';
  let renameDraft = '';
  let renameError = '';
  let renameBusy = false;
  let renameInput: HTMLInputElement | null = null;

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

  async function startRename(device: DashboardDevice) {
    openDeviceId = '';
    editingDeviceId = device.device_id;
    renameDraft = device.device_name;
    renameError = '';
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function cancelRename() {
    editingDeviceId = '';
    renameDraft = '';
    renameError = '';
  }

  async function rename(device: DashboardDevice) {
    if (!renameDraft.trim()) {
      renameError = 'Enter a device name.';
      return;
    }
    renameBusy = true;
    renameError = '';
    try {
      await onRename(device, renameDraft);
      cancelRename();
    } catch (error) {
      renameError = error instanceof Error ? error.message : 'Unable to rename this device.';
    } finally {
      renameBusy = false;
    }
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
        <td>
          {#if editingDeviceId === device.device_id}
            <form class="device-name-editor" on:submit|preventDefault={() => rename(device)}>
              <input bind:this={renameInput} bind:value={renameDraft} maxlength="80" aria-label={`New name for ${device.device_name}`} disabled={renameBusy} />
              <button class="primary" disabled={renameBusy}>Save</button>
              <button type="button" class="secondary" disabled={renameBusy} on:click={cancelRename}>Cancel</button>
              {#if renameError}<small class="danger-text" role="alert">{renameError}</small>{/if}
            </form>
          {:else}
            {device.device_name}
          {/if}
        </td>
        <td><Status label={effectiveStatus(device)} /></td>
        <td>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : '-'}</td>
        <td>{relationDetail(device)}</td>
        <td class="mono">{shortId(device.last_applied_main)}</td>
        <td>{localDetail(device)}</td>
        <td>{device.last_successful_sync_at ? new Date(device.last_successful_sync_at).toLocaleString() : '-'}</td>
        <td class="action-cell">
          <button
            class="icon-button"
            disabled={renameBusy || device.status === 'revoked'}
            title={device.status === 'revoked' ? 'Device already revoked' : renameBusy ? 'A device rename is in progress' : 'Device actions'}
            aria-label={`${device.device_name} actions`}
            on:click={() => toggleMenu(device.device_id)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {#if openDeviceId === device.device_id}
            <div class="action-menu">
              <button on:click={() => startRename(device)}>Rename device</button>
              <button class="danger" on:click={() => revoke(device)}>Revoke device</button>
            </div>
          {/if}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
