<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { DashboardSummary, VaultSummary } from '../api/types';
  import Icon, { type IconName } from './Icon.svelte';

  export let page: string;
  export let nav: readonly string[];
  export let vaults: VaultSummary[];
  export let vaultId: string;
  export let selectedVault: VaultSummary | null;
  export let dashboard: DashboardSummary | null;
  export let unresolvedCount: number;
  export let lastRefreshed: string | null;
  export let dashboardStatusCurrent: boolean;
  export let busy: boolean;
  export let refreshing = false;
  export let modalOpen = false;
  export let vaultDeleting = false;
  export let onPageChange: (nextPage: string) => void = () => {};
  export let onVaultChange: (nextVaultId: string) => void | Promise<void> = () => {};
  export let onRefresh: () => void | Promise<void> = () => {};
  export let onLogout: () => void | Promise<void> = () => {};

  let isMobile = false;
  let mobileNavOpen = false;
  let menuButton: HTMLButtonElement | null = null;
  let drawer: HTMLElement | null = null;
  let header: HTMLElement | null = null;
  let pageHeading: HTMLHeadingElement | null = null;
  let headerHeight = 72;
  let previousFocus: HTMLElement | null = null;
  let previousOverflow: string | null = null;

  function iconFor(item: string): IconName {
    const icons: Record<string, IconName> = {
      Overview: 'overview', Devices: 'devices', Conflicts: 'conflicts',
      History: 'history', Maintenance: 'maintenance', Settings: 'settings'
    };
    return icons[item] ?? 'dot';
  }

  function unlockScroll() {
    if (previousOverflow !== null) document.body.style.overflow = previousOverflow;
    previousOverflow = null;
  }

  async function openNavigation() {
    if (!isMobile || mobileNavOpen) return;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : menuButton;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mobileNavOpen = true;
    await tick();
    if (isMobile && mobileNavOpen) drawer?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled)')?.focus();
  }

  async function closeNavigation(restoreFocus = true) {
    if (!mobileNavOpen) return;
    mobileNavOpen = false;
    unlockScroll();
    if (restoreFocus) {
      await tick();
      if (mobileNavOpen) return;
      const target = previousFocus?.isConnected && previousFocus.getClientRects().length && !previousFocus.closest('[inert]') ? previousFocus : menuButton;
      (isMobile ? target : pageHeading)?.focus();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!mobileNavOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeNavigation();
      return;
    }
    if (event.key !== 'Tab' || !drawer) return;
    const focusable = [...drawer.querySelectorAll<HTMLElement>('button, select, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(() => {
    const media = window.matchMedia('(max-width: 1099px)');
    const updateViewport = async () => {
      const focusInRail = drawer?.contains(document.activeElement);
      const focusOnMenu = document.activeElement === menuButton;
      const wasOpen = mobileNavOpen;
      isMobile = media.matches;
      if (!isMobile && mobileNavOpen) {
        mobileNavOpen = false;
        unlockScroll();
      }
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (isMobile && !mobileNavOpen && focusInRail) menuButton?.focus();
      else if (!isMobile && (wasOpen || focusOnMenu || focusInRail)) pageHeading?.focus();
    };
    void updateViewport();
    media.addEventListener('change', updateViewport);
    const observer = new ResizeObserver(() => { headerHeight = header?.offsetHeight ?? 72; });
    if (header) observer.observe(header);
    return () => {
      media.removeEventListener('change', updateViewport);
      observer.disconnect();
      unlockScroll();
    };
  });
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="shell" inert={modalOpen} style:--app-header-height={`${headerHeight}px`}>
  {#if mobileNavOpen}
    <button class="drawer-backdrop" tabindex="-1" aria-label="Close navigation backdrop" on:click={() => void closeNavigation()}></button>
  {/if}

  <aside
    bind:this={drawer}
    class="app-sidebar"
    class:open={mobileNavOpen}
    inert={isMobile && !mobileNavOpen}
    role={mobileNavOpen ? 'dialog' : 'complementary'}
    aria-label="Primary navigation"
    aria-modal={mobileNavOpen ? 'true' : undefined}
  >
    <div class="sidebar-heading">
      <div class="brand-mark" aria-hidden="true"><Icon name="refresh" size={20} /></div>
      <div class="brand-copy"><strong>OBTS</strong><span>True Sync</span></div>
      <button class="sidebar-close icon-button" type="button" aria-label="Close navigation" on:click={() => void closeNavigation()}>
        <Icon name="close" size={18} />
      </button>
    </div>

    <label class="vault-selector">
      <span>Current vault</span>
      <select value={vaultId} disabled={busy} on:change={(event) => onVaultChange((event.currentTarget as HTMLSelectElement).value)} aria-label="Current vault">
        {#each vaults as vault}
          <option value={vault.vault_id}>{vault.display_name}</option>
        {/each}
      </select>
      {#if selectedVault && (dashboard?.vault.status ?? selectedVault.status) === 'deleting' || vaultDeleting}
        <small class="status-blocked">Deleting</small>
      {:else if selectedVault && (dashboard?.vault.status ?? selectedVault.status) === 'blocked_integrity'}
        <small class="status-blocked">Integrity blocked</small>
      {/if}
    </label>

    <nav aria-label="Dashboard sections">
      {#each nav as item}
        <button class:active={page === item} class="nav-item" aria-current={page === item ? 'page' : undefined} on:click={() => { onPageChange(item); void closeNavigation(); }}>
          <Icon name={iconFor(item)} size={17} />
          <span>{item}</span>
          {#if item === 'Conflicts' && unresolvedCount > 0}<b aria-label={`${unresolvedCount} unresolved conflicts`}>{unresolvedCount}</b>{/if}
        </button>
      {/each}
    </nav>

    <div class="sidebar-footer">
      <div class="sidebar-status"><span class:offline={!dashboardStatusCurrent}></span>{dashboardStatusCurrent ? 'Auto-refresh · 15s' : 'Status needs refresh'}</div>
      <button class="secondary sidebar-action" disabled={busy} on:click={() => onLogout()}><Icon name="logout" size={16} /><span>Sign out</span></button>
    </div>
  </aside>

  <section class="content" inert={mobileNavOpen}>
    <header bind:this={header} class="app-header">
      <button bind:this={menuButton} class="menu-toggle icon-button" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} on:click={openNavigation}>
        <Icon name="menu" size={19} />
      </button>
      <div class="header-context">
        <h1 bind:this={pageHeading} tabindex="-1">{page}</h1>
        <p title={selectedVault?.display_name}>{selectedVault?.display_name ?? 'No vault selected'}{#if vaultDeleting || dashboard?.vault.status === 'deleting'}<span class="header-status"> · Deleting</span>{:else if dashboard?.vault.status === 'blocked_integrity' || selectedVault?.status === 'blocked_integrity'}<span class="header-status danger-text"> · Integrity blocked</span>{/if}</p>
      </div>
      <div class="header-tools">
        <span class="refresh" class:refresh-stale={!dashboardStatusCurrent} title="Server status refreshes every 15 seconds while this tab is visible.">
          {refreshing ? 'Updating…' : dashboardStatusCurrent && lastRefreshed ? `Updated ${lastRefreshed}` : dashboard ? 'Status needs refresh' : 'Awaiting vault status'}
        </span>
        <button class="secondary refresh-button" class:refreshing disabled={busy || refreshing || !selectedVault || vaultDeleting} aria-label="Refresh" title="Refresh vault status" on:click={() => onRefresh()}>
          <Icon name="refresh" size={16} /><span>Refresh</span>
        </button>
        <div class="header-actions"><slot name="actions" /></div>
      </div>
    </header>
    <slot />
  </section>
</div>
