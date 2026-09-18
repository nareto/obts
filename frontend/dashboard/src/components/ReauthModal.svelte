<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  export let username = '';
  export let password = '';
  export let authError = '';
  export let busy = false;
  export let onSubmit: () => void | Promise<void> = () => {};
  export let onCancel: () => void | Promise<void> = () => {};

  let dialog: HTMLElement | null = null;
  let usernameInput: HTMLInputElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let closing = false;

  function focusableElements() {
    return [...(dialog?.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
  }

  async function cancel() {
    if (closing) return;
    closing = true;
    await onCancel();
    await tick();
    restoreFocus();
  }

  function restoreFocus() {
    const target = previousFocus?.isConnected && previousFocus.getClientRects().length > 0 && !previousFocus.closest('[inert]') && !previousFocus.hasAttribute('disabled')
      ? previousFocus
      : document.querySelector<HTMLElement>('.app-header h1, .connection-panel h1');
    target?.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
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
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => usernameInput?.focus());
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown);
    if (!closing) restoreFocus();
  });
</script>

<div class="modal" aria-hidden="false">
  <div bind:this={dialog} class="dialog reauth-dialog" role="dialog" aria-modal="true" aria-labelledby="reauth-title" aria-describedby="reauth-description" tabindex="-1">
    <p class="eyebrow">Protected action</p>
    <h2 id="reauth-title">Recent authentication</h2>
    <p id="reauth-description" class="muted">Confirm your active account to continue this action. The current dashboard remains unchanged.</p>
    <form on:submit|preventDefault={() => onSubmit()}>
      <label>Username<input bind:this={usernameInput} bind:value={username} autocomplete="username" disabled={busy} /></label>
      <label>Password<input bind:value={password} type="password" autocomplete="current-password" disabled={busy} /></label>
      {#if authError}<p class="error" role="alert">{authError}</p>{/if}
      <div class="actions">
        <button type="button" class="secondary" on:click={() => void cancel()}>Cancel</button>
        <button class="primary" disabled={busy}>Continue</button>
      </div>
    </form>
  </div>
</div>
