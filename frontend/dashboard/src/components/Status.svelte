<script lang="ts">
  export let label: string;

  const activeStatusBases = ['Verifying contents', 'Preparing upload', 'Uploading', 'Applying', 'Checking', 'Merging', 'Server retrying', 'Repairing baseline', 'Finishing update', 'Waiting for operation'];

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
    if (base === 'Synced') return 'success';
    if (activeStatusBases.includes(base)) return 'info';
    if (['Ahead', 'Behind', 'Offline', 'Status unknown', 'Review needed', 'Stale review'].includes(base)) return 'warning';
    if (['Blocked', 'Needs recovery', 'Unsafe local state', 'Integrity failure'].includes(base)) return 'danger';
    return 'neutral';
  }

  function statusIcon(value: string) {
    const base = baseLabel(value);
    if (base === 'Synced') return '✓';
    if (base === 'Preparing upload') return '…';
    if (base === 'Uploading') return '↑';
    if (base === 'Applying') return '↓';
    if (base === 'Merging') return '↔';
    if (activeStatusBases.includes(base)) return '…';
    if (base === 'Ahead') return '↑';
    if (base === 'Behind') return '↓';
    if (base === 'Offline' || base === 'Status unknown') return '○';
    if (base === 'Review needed' || base === 'Stale review') return '!';
    if (base === 'Blocked' || base === 'Needs recovery' || base === 'Unsafe local state' || base === 'Integrity failure') return '×';
    return '•';
  }
</script>

<span class="status {role}"><i aria-hidden="true">{icon}</i>{label}</span>
