<script lang="ts">
  import Icon from './Icon.svelte';

  export let title: string;
  export let value: string;
  export let role: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  export let detail: string;
  export let technical = false;

  $: icon = role === 'success' ? 'check' : role === 'danger' ? 'danger' : role === 'warning' ? 'warning' : role === 'info' ? 'info' : 'dot';
</script>

<section class="panel summary">
  <p>{title}</p>
  <strong class={role}><Icon name={icon} size={17} />{value}</strong>
  <span class="summary-detail" class:mono={technical} title={detail}>{detail}</span>
</section>
