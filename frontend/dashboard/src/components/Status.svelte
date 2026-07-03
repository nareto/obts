<script lang="ts">
  export let label: string;

  $: role = statusRole(label);

  function statusRole(value: string) {
    if (value === 'Synced' || value === 'Ready' || value === 'Completed') return 'success';
    if (['Uploading', 'Applying', 'Checking', 'Merging'].includes(value)) return 'info';
    if (['Ahead', 'Behind', 'Offline', 'Review needed', 'Stale review'].includes(value)) return 'warning';
    if (['Blocked', 'Needs recovery', 'Unsafe local state', 'Integrity failure', 'Not ready'].includes(value)) return 'danger';
    return 'neutral';
  }
</script>

<span class="status {role}"><i></i>{label}</span>
