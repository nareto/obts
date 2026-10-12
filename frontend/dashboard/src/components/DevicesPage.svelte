<script lang="ts">
  import type { DashboardDevice } from '../api/types';
  import { isDeviceRevoked } from '../presentation';
  import { routeHref, vaultRoute, type DevicesView, type Route } from '../router';
  import DeviceTable from './DeviceTable.svelte';
  import RevokedDevices from './RevokedDevices.svelte';

  export let vaultId: string;
  export let devices: DashboardDevice[];
  export let view: DevicesView;
  export let recommendedPluginVersion: string;
  export let statusCurrent: boolean;
  export let busy = false;
  export let onNavigate: (event: MouseEvent, route: Route) => void;
  export let onRename: (device: DashboardDevice, deviceName: string) => void | Promise<void>;
  export let onRevoke: (device: DashboardDevice) => void | Promise<void>;
  export let onRemove: (device: DashboardDevice, trigger: HTMLElement) => void;

  $: active = devices.filter((device) => !isDeviceRevoked(device));
  $: revoked = devices.filter((device) => isDeviceRevoked(device));
  $: activeRoute = vaultRoute(vaultId, 'devices');
  $: revokedRoute = vaultRoute(vaultId, 'devices', { devicesView: 'revoked' });
</script>

<main class="page">
  <section class="panel full devices-page">
    <div class="section-heading">
      <h2>Devices</h2>
      <div class="view-switch" role="group" aria-label="Device view">
        <a href={routeHref(activeRoute)} class:selected={view === 'active'} aria-current={view === 'active' ? 'true' : undefined} on:click={(event) => onNavigate(event, activeRoute)}>Active <span class="view-count">({active.length})</span></a>
        <a href={routeHref(revokedRoute)} class:selected={view === 'revoked'} aria-current={view === 'revoked' ? 'true' : undefined} on:click={(event) => onNavigate(event, revokedRoute)}>Revoked <span class="view-count">({revoked.length})</span></a>
      </div>
    </div>
    {#if view === 'revoked'}
      <RevokedDevices devices={revoked} disabled={busy} {onRemove} />
    {:else}
      <DeviceTable devices={active} {recommendedPluginVersion} {statusCurrent} {onRename} {onRevoke} />
    {/if}
  </section>
</main>
