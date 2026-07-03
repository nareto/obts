<script lang="ts">
  export let title: string;
  export let value: string;
  export let role: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  export let detail: string;
</script>

<section class="panel summary">
  <p>{title}</p>
  <strong class={role}>{value}</strong>
  <code>{detail}</code>
</section>
