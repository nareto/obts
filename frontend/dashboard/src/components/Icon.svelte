<script lang="ts">
  export type IconName =
    | 'overview'
    | 'devices'
    | 'conflicts'
    | 'history'
    | 'maintenance'
    | 'settings'
    | 'menu'
    | 'close'
    | 'refresh'
    | 'more'
    | 'logout'
    | 'check'
    | 'info'
    | 'warning'
    | 'danger'
    | 'dot';

  export let name: IconName;
  export let size = 18;
</script>

<svg class="icon-svg" aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 20 20" fill="none">
  {#if name === 'overview'}
    <path d="M3 3.5h5.5v5H3zM11.5 3.5H17v5h-5.5zM3 11.5h5.5v5H3zM11.5 11.5H17v5h-5.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  {:else if name === 'devices'}
    <rect x="2.5" y="4" width="15" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6" />
    <path d="M6 17h8M10 14v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  {:else if name === 'conflicts'}
    <path d="M10 2.75 17 5v4.6c0 3.8-2.6 6.4-7 7.65-4.4-1.25-7-3.85-7-7.65V5l7-2.25Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    <path d="M10 6.5v3.6M10 13.1v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  {:else if name === 'history'}
    <path d="M3.25 9.75A6.75 6.75 0 1 0 5 5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    <path d="M3.25 4v5.75H9M10 6.5v3.75l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  {:else if name === 'maintenance'}
    <path d="m12.7 3.1 1.2 1.2-2.05 2.05 1.8 1.8 2.05-2.05 1.2 1.2-2.05 2.05a4.7 4.7 0 0 1-5.65 5.65l-5.1 5.1-1.8-1.8 5.1-5.1a4.7 4.7 0 0 1 5.65-5.65L12.7 3.1Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
  {:else if name === 'settings'}
    <path d="m8.8 2.9.45 1.65a5.9 5.9 0 0 1 1.5 0l.45-1.65 2.05.85-.72 1.55c.42.27.8.6 1.14.94l1.55-.72.85 2.05-1.65.45a5.9 5.9 0 0 1 0 1.5l1.65.45-.85 2.05-1.55-.72c-.27.42-.6.8-.94 1.14l.72 1.55-2.05.85-.45-1.65a5.9 5.9 0 0 1-1.5 0l-.45 1.65-2.05-.85.72-1.55a5.9 5.9 0 0 1-1.14-.94l-1.55.72-.85-2.05 1.65-.45a5.9 5.9 0 0 1 0-1.5l-1.65-.45.85-2.05 1.55.72c.27-.42.6-.8.94-1.14L6.75 3.75 8.8 2.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
    <circle cx="10" cy="8.8" r="2.1" stroke="currentColor" stroke-width="1.5" />
  {:else if name === 'menu'}
    <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  {:else if name === 'close'}
    <path d="m4 4 12 12M16 4 4 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  {:else if name === 'refresh'}
    <path d="M16.1 7.2A6.5 6.5 0 0 0 4.8 5.1L3 7M3 3.75V7h3.25M3.9 12.8a6.5 6.5 0 0 0 11.3 2.1l1.8-1.9M17 16.25V13h-3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  {:else if name === 'more'}
    <circle cx="4.5" cy="10" r="1.2" fill="currentColor" /><circle cx="10" cy="10" r="1.2" fill="currentColor" /><circle cx="15.5" cy="10" r="1.2" fill="currentColor" />
  {:else if name === 'logout'}
    <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8M12 6l4 4-4 4M16 10H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  {:else if name === 'check'}
    <path d="m4 10.3 3.7 3.7L16 5.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  {:else if name === 'info'}
    <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6" /><path d="M10 9.1v4M10 6.8v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  {:else if name === 'warning'}
    <path d="m10 2.8 7.2 13H2.8L10 2.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M10 7v4M10 13.5v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  {:else if name === 'danger'}
    <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6" /><path d="m7.2 7.2 5.6 5.6M12.8 7.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  {:else}
    <circle cx="10" cy="10" r="3.2" fill="currentColor" />
  {/if}
</svg>
