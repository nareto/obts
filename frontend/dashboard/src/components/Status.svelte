<script lang="ts">
  export let label: string;

  $: role = statusRole(label);
  $: icon = statusIcon(label);

  function statusRole(value: string) {
    if (value === 'Synced' || value === 'Ready' || value === 'Completed') return 'success';
    if (['Uploading', 'Applying', 'Checking', 'Merging'].includes(value)) return 'info';
    if (['Ahead', 'Behind', 'Offline', 'Review needed', 'Stale review'].includes(value)) return 'warning';
    if (['Blocked', 'Needs recovery', 'Unsafe local state', 'Integrity failure', 'Not ready'].includes(value)) return 'danger';
    return 'neutral';
  }

  function statusIcon(value: string) {
    if (value === 'Synced' || value === 'Ready' || value === 'Completed') return '✓';
    if (value === 'Uploading') return '↑';
    if (value === 'Applying') return '↓';
    if (value === 'Checking') return '…';
    if (value === 'Merging') return '↔';
    if (value === 'Ahead') return '↑';
    if (value === 'Behind') return '↓';
    if (value === 'Offline') return '○';
    if (value === 'Review needed' || value === 'Stale review') return '!';
    if (value === 'Blocked' || value === 'Needs recovery' || value === 'Unsafe local state' || value === 'Integrity failure' || value === 'Not ready') return '×';
    return '•';
  }
</script>

<span class="status {role}"><i aria-hidden="true">{icon}</i>{label}</span>
