<script lang="ts">
  import type { DashboardConflict, DashboardSummary } from '../api/types';
  import Status from './Status.svelte';

  export let dashboard: DashboardSummary;
  export let conflicts: DashboardConflict[];
  export let onAction: (item: AttentionItem) => void | Promise<void> = () => {};

  export type AttentionItem =
    | { kind: 'maintenance'; label: string; action: string }
    | { kind: 'devices'; label: string; action: string }
    | { kind: 'conflict'; label: string; action: string; conflictId: string }
    | { kind: 'stale_conflict'; label: string; action: string; conflictId: string };

  $: items = [
    ...(dashboard.health.checks.persistent_state
      ? []
      : [{ kind: 'maintenance', label: 'Integrity failure', action: 'Open maintenance' } satisfies AttentionItem]),
    ...dashboard.devices
      .filter((device) => device.blocked)
      .map((device) => ({ kind: 'devices', label: `Blocked device: ${device.device_name}`, action: 'Open devices' }) satisfies AttentionItem),
    ...conflicts
      .filter((conflict) => conflict.status === 'open' && !conflict.stale)
      .map(
        (conflict) =>
          ({
            kind: 'conflict',
            label: `Conflict: ${conflict.affected_paths[0] ?? conflict.conflict_id}`,
            action: 'Review',
            conflictId: conflict.conflict_id
          }) satisfies AttentionItem
      ),
    ...conflicts
      .filter((conflict) => conflict.status === 'open' && conflict.stale)
      .map(
        (conflict) =>
          ({
            kind: 'stale_conflict',
            label: `Stale review: ${conflict.affected_paths[0] ?? conflict.conflict_id}`,
            action: 'Refresh',
            conflictId: conflict.conflict_id
          }) satisfies AttentionItem
      ),
    ...dashboard.devices
      .filter((device) => device.status_label === 'Unsafe local state')
      .map((device) => ({ kind: 'devices', label: `Unsafe local state: ${device.device_name}`, action: 'Open devices' }) satisfies AttentionItem),
    ...dashboard.devices
      .filter((device) => device.offline)
      .map((device) => ({ kind: 'devices', label: `Offline device: ${device.device_name}`, action: 'Open devices' }) satisfies AttentionItem)
  ] satisfies AttentionItem[];
</script>

{#if items.length === 0}
  <Status label="Synced" />
{:else}
  <ul class="attention">
    {#each items as item}
      <li>
        <span>{item.label}</span>
        <button class="secondary" on:click={() => onAction(item)}>{item.action}</button>
      </li>
    {/each}
  </ul>
{/if}
