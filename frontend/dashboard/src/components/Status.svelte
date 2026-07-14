<script lang="ts">
  export let label: string;

  $: role = statusRole(label);
  $: icon = statusIcon(label);

  function statusRole(value: string) {
    if (value === 'Synced') return 'success';
    if (['Preparing upload', 'Uploading', 'Applying', 'Checking', 'Merging'].includes(value)) return 'info';
    if (['Ahead', 'Behind', 'Offline', 'Status unknown', 'Review needed', 'Stale review'].includes(value)) return 'warning';
    if (['Blocked', 'Needs recovery', 'Unsafe local state', 'Integrity failure'].includes(value)) return 'danger';
    return 'neutral';
  }

  function statusIcon(value: string) {
    if (value === 'Synced') return '✓';
    if (value === 'Preparing upload') return '…';
    if (value === 'Uploading') return '↑';
    if (value === 'Applying') return '↓';
    if (value === 'Checking') return '…';
    if (value === 'Merging') return '↔';
    if (value === 'Ahead') return '↑';
    if (value === 'Behind') return '↓';
    if (value === 'Offline' || value === 'Status unknown') return '○';
    if (value === 'Review needed' || value === 'Stale review') return '!';
    if (value === 'Blocked' || value === 'Needs recovery' || value === 'Unsafe local state' || value === 'Integrity failure') return '×';
    return '•';
  }
</script>

<span class="status {role}"><i aria-hidden="true">{icon}</i>{label}</span>
