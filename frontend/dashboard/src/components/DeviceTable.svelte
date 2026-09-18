<script lang="ts">
  import { tick } from 'svelte';
  import type { DashboardDevice } from '../api/types';
  import { exactTime, relativeTime } from '../presentation';
  import Icon from './Icon.svelte';
  import Status from './Status.svelte';

  export let devices: DashboardDevice[];
  export let recommendedPluginVersion: string;
  export let statusCurrent: boolean;
  export let compact = false;
  export let onRename: (device: DashboardDevice, deviceName: string) => void | Promise<void>;
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;

  let openDeviceId = '';
  let expandedDeviceId = '';
  let editingDeviceId = '';
  let renameDraft = '';
  let renameError = '';
  let renameBusy = false;
  let renameInput: HTMLInputElement | null = null;
  let menuTrigger: HTMLButtonElement | null = null;
  let menuPanel: HTMLDivElement | null = null;

  function localDetail(device: DashboardDevice) {
    if (device.local_error_code) return device.local_error_code;
    if (device.local_queue_status) return `queue: ${device.local_queue_status}`;
    return 'No local detail';
  }

  function effectiveStatus(device: DashboardDevice) {
    if (!statusCurrent) return 'Status unknown';
    return device.status === 'revoked' ? 'Revoked' : device.status_label;
  }

  function relationDetail(device: DashboardDevice) {
    if (!statusCurrent || !device.status_report_fresh || !device.last_status_report_at) return 'Unknown locally';
    if (device.ahead_of_main) return 'Ahead';
    if (device.behind_main) return 'Behind';
    return 'Current';
  }

  function pluginVersionTitle(device: DashboardDevice) {
    if (!device.plugin_version) return `Plugin version unknown. Recommended version is ${recommendedPluginVersion}.`;
    if (device.plugin_version === recommendedPluginVersion) return `Plugin ${device.plugin_version}; recommended.`;
    return `Plugin ${device.plugin_version}; update recommended to ${recommendedPluginVersion}.`;
  }

  function pluginSummary(device: DashboardDevice) {
    if (!device.plugin_version) return 'Version unknown';
    return device.plugin_version === recommendedPluginVersion ? 'Up to date' : 'Update recommended';
  }

  async function toggleMenu(deviceId: string, trigger: HTMLButtonElement) {
    if (openDeviceId === deviceId) {
      await closeMenu(true);
      return;
    }
    menuTrigger = trigger;
    openDeviceId = deviceId;
    await tick();
    menuPanel?.querySelector<HTMLButtonElement>('button')?.focus();
  }

  async function closeMenu(restoreFocus = false) {
    openDeviceId = '';
    if (restoreFocus) {
      await tick();
      if (menuTrigger?.isConnected) menuTrigger.focus();
    }
  }

  function dismissMenu(event: PointerEvent) {
    if (event.target instanceof Node && !menuPanel?.contains(event.target) && !menuTrigger?.contains(event.target)) void closeMenu();
  }

  function handleMenuKeydown(event: KeyboardEvent) {
    if (!openDeviceId) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      void closeMenu(true);
      return;
    }
    const items = [...(menuPanel?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = items.findIndex((item) => item === document.activeElement);
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  }

  function toggleDetails(deviceId: string) {
    expandedDeviceId = expandedDeviceId === deviceId ? '' : deviceId;
    void closeMenu();
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

  async function cancelRename() {
    editingDeviceId = '';
    renameDraft = '';
    renameError = '';
    await tick();
    if (menuTrigger?.isConnected) menuTrigger.focus();
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
      await cancelRename();
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

<svelte:window on:keydown={handleMenuKeydown} on:pointerdown={dismissMenu} />

<div class="device-table-wrap">
  <table class="device-table" class:device-table-compact={compact}>
    <thead>
      <tr>
        <th scope="col" class="device-name-heading">Device</th>
        {#if !compact}<th scope="col">Plugin</th>{/if}
        <th scope="col">Last seen</th>
        <th scope="col">Sync relation</th>
        {#if !compact}<th scope="col">Last sync</th>{/if}
        <th scope="col" class="device-actions-heading">Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each devices as device (device.device_id)}
        <tr class="device-row" class:device-revoked={device.status === 'revoked'}>
          <td class="device-primary" data-label="Device">
            {#if editingDeviceId === device.device_id}
              <form class="device-name-editor" on:submit|preventDefault={() => rename(device)}>
                <input bind:this={renameInput} bind:value={renameDraft} maxlength="80" aria-label={`New name for ${device.device_name}`} disabled={renameBusy} />
                <button class="primary" disabled={renameBusy}>Save</button>
                <button type="button" class="secondary" disabled={renameBusy} on:click={cancelRename}>Cancel</button>
                {#if renameError}<small class="danger-text" role="alert">{renameError}</small>{/if}
              </form>
            {:else}
              <div class="device-identity">
                <strong title={device.device_name}>{device.device_name}</strong>
                <Status label={effectiveStatus(device)} />
                {#if compact && device.plugin_version !== recommendedPluginVersion}
                  <span class="plugin-summary" title={pluginVersionTitle(device)}>Plugin {device.plugin_version ?? 'unknown'} · {pluginSummary(device)}</span>
                {/if}
              </div>
            {/if}
          </td>
          {#if !compact}
            <td class="plugin-version" data-label="Plugin" class:success={device.plugin_version === recommendedPluginVersion} class:warning={device.plugin_version !== recommendedPluginVersion} title={pluginVersionTitle(device)} aria-label={pluginVersionTitle(device)}>
              <span>{device.plugin_version ?? 'Unknown'}</span>
              <small>{pluginSummary(device)}</small>
            </td>
          {/if}
          <td data-label="Last seen">
            {#if device.last_seen_at}
              <time datetime={device.last_seen_at} title={exactTime(device.last_seen_at)} aria-label={`Last seen ${relativeTime(device.last_seen_at)}; ${exactTime(device.last_seen_at)}`}>{relativeTime(device.last_seen_at)}</time>
            {:else}<span class="muted">Not reported</span>{/if}
          </td>
          <td data-label="Sync relation"><Status label={relationDetail(device)} /></td>
          {#if !compact}
            <td data-label="Last sync">
              {#if device.last_successful_sync_at}
                <time datetime={device.last_successful_sync_at} title={exactTime(device.last_successful_sync_at)} aria-label={`Last successful sync ${relativeTime(device.last_successful_sync_at)}; ${exactTime(device.last_successful_sync_at)}`}>{relativeTime(device.last_successful_sync_at)}</time>
              {:else}<span class="muted">Not synced</span>{/if}
            </td>
          {/if}
          <td class="action-cell device-actions" data-label="Actions">
            <div class="device-action-buttons">
              <button class="secondary details-button" aria-label={`${expandedDeviceId === device.device_id ? 'Hide' : 'Show'} details for ${device.device_name}`} aria-expanded={expandedDeviceId === device.device_id} aria-controls={`device-details-${device.device_id}`} on:click={() => toggleDetails(device.device_id)}>
                <span>{expandedDeviceId === device.device_id ? 'Hide' : 'Details'}</span>
              </button>
              <button
                class="icon-button device-actions-trigger"
                disabled={renameBusy || device.status === 'revoked'}
                title={device.status === 'revoked' ? 'Device already revoked' : renameBusy ? 'A device rename is in progress' : 'Device actions'}
                aria-label={`${device.device_name} actions`}
                aria-haspopup="menu"
                aria-expanded={openDeviceId === device.device_id}
                aria-controls={openDeviceId === device.device_id ? `device-actions-${device.device_id}` : undefined}
                on:click={(event) => toggleMenu(device.device_id, event.currentTarget)}
              ><Icon name="more" size={17} /></button>
            </div>
            {#if openDeviceId === device.device_id}
              <div bind:this={menuPanel} id={`device-actions-${device.device_id}`} class="action-menu" role="menu" aria-label={`${device.device_name} actions`}>
                <button role="menuitem" on:click={() => startRename(device)}>Rename device</button>
                <button role="menuitem" class="danger" on:click={() => revoke(device)}>Revoke device</button>
              </div>
            {/if}
          </td>
        </tr>
        {#if expandedDeviceId === device.device_id}
          <tr class="device-details-row">
            <td colspan={compact ? 4 : 6}>
              <div id={`device-details-${device.device_id}`} class="technical-details" role="region" aria-label={`${device.device_name} technical details`}>
                <div class="details-heading"><strong>Technical details</strong><span>Full identifiers can be selected and copied.</span></div>
                <dl>
                  <div><dt>Device ID</dt><dd class="mono">{device.device_id}</dd></div>
                  <div><dt>Device ref head</dt><dd class="mono">{device.device_ref_head ?? 'Not reported'}</dd></div>
                  <div><dt>Applied version</dt><dd class="mono">{device.last_applied_main ?? 'Not reported'}</dd></div>
                  <div><dt>Local main</dt><dd class="mono">{device.local_main ?? 'Not reported'}</dd></div>
                  <div><dt>Local head</dt><dd class="mono">{device.local_head ?? 'Not reported'}</dd></div>
                  <div><dt>Plugin version</dt><dd>{device.plugin_version ?? 'Unknown'} · Recommended {recommendedPluginVersion}</dd></div>
                  <div><dt>Last seen</dt><dd>{exactTime(device.last_seen_at)}</dd></div>
                  <div><dt>Local detail</dt><dd>{localDetail(device)}</dd></div>
                  <div><dt>Status report age</dt><dd>{device.status_report_age_seconds === null ? 'Unknown' : `${device.status_report_age_seconds}s`}</dd></div>
                  <div><dt>Last status report</dt><dd>{device.last_status_report_at ? exactTime(device.last_status_report_at) : 'Not reported'}</dd></div>
                  <div><dt>Last successful sync</dt><dd>{device.last_successful_sync_at ? exactTime(device.last_successful_sync_at) : 'Not synced'}</dd></div>
                  <div><dt>Path capabilities</dt><dd>{device.path_capabilities ? Object.keys(device.path_capabilities).join(', ') || 'None reported' : 'Not reported'}</dd></div>
                </dl>
              </div>
            </td>
          </tr>
        {/if}
      {:else}
        <tr><td colspan={compact ? 4 : 6} class="muted">No paired devices.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
