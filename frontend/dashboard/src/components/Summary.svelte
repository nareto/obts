<script lang="ts">
  export let title: string;
  export let value: string;
  export let role: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  export let detail: string;

  $: icon = roleIcon(role);

  function roleIcon(value: typeof role) {
    if (value === 'success') return '✓';
    if (value === 'info') return 'i';
    if (value === 'warning') return '!';
    if (value === 'danger') return '×';
    return '•';
  }
</script>

<section class="panel summary">
  <p>{title}</p>
  <strong class={role}><i aria-hidden="true">{icon}</i>{value}</strong>
  <code>{detail}</code>
</section>
