<script lang="ts">
  import type { DashboardConflict, DashboardSummary } from '../api/types';
  import Status from './Status.svelte';

  export let dashboard: DashboardSummary;
  export let conflicts: DashboardConflict[];

  $: items = [
    ...(dashboard.health.checks.persistent_state ? [] : ['Integrity failure']),
    ...dashboard.devices.filter((device) => device.blocked).map((device) => `Blocked device: ${device.device_name}`),
    ...conflicts.filter((conflict) => conflict.status === 'open').map((conflict) => `Conflict: ${conflict.affected_paths[0] ?? conflict.conflict_id}`),
    ...conflicts.filter((conflict) => conflict.stale).map((conflict) => `Stale review: ${conflict.affected_paths[0] ?? conflict.conflict_id}`),
    ...dashboard.devices.filter((device) => device.status_label === 'Unsafe local state').map((device) => `Unsafe local state: ${device.device_name}`),
    ...dashboard.devices.filter((device) => device.offline).map((device) => `Offline device: ${device.device_name}`)
  ];
</script>

{#if items.length === 0}
  <Status label="Synced" />
{:else}
  <ul class="attention">
    {#each items as item}
      <li>{item}</li>
    {/each}
  </ul>
{/if}
