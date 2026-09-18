<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';

  export let label: string;

  const activeStatusBases = ['Deleting', 'Verifying contents', 'Preparing upload', 'Uploading', 'Applying', 'Checking', 'Merging', 'Server retrying', 'Repairing baseline', 'Finishing update', 'Waiting for operation'];

  $: role = statusRole(label);
  $: icon = statusIcon(label);

  function baseLabel(value: string) {
    for (const base of activeStatusBases) {
      if (value === base || value.startsWith(`${base} `)) return base;
    }
    return value;
  }

  function statusRole(value: string) {
    const base = baseLabel(value);
    if (base === 'Synced' || base === 'Current') return 'success';
    if (activeStatusBases.includes(base)) return 'info';
    if (['Ahead', 'Behind', 'Offline', 'Status unknown', 'Review needed', 'Stale review'].includes(base)) return 'warning';
    if (['Blocked', 'Needs recovery', 'Unsafe local state', 'Integrity failure', 'Revoked'].includes(base)) return 'danger';
    return 'neutral';
  }

  function statusIcon(value: string): IconName {
    const base = baseLabel(value);
    if (base === 'Synced' || base === 'Current') return 'check';
    if (base === 'Preparing upload' || base === 'Uploading' || activeStatusBases.includes(base)) return 'info';
    if (base === 'Applying' || base === 'Behind') return 'info';
    if (base === 'Ahead') return 'warning';
    if (base === 'Offline' || base === 'Status unknown') return 'dot';
    if (base === 'Review needed' || base === 'Stale review') return 'warning';
    if (base === 'Blocked' || base === 'Needs recovery' || base === 'Unsafe local state' || base === 'Integrity failure' || base === 'Revoked') return 'danger';
    return 'dot';
  }
</script>

<span class="status {role}"><Icon name={icon} size={14} />{label}</span>
