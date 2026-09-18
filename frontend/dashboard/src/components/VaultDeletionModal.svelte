<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  export let displayName = '';
  export let vaultId = '';
  export let busy = false;
  export let error = '';
  export let onSubmit: (confirmation: string) => void | Promise<void> = () => {};
  export let onCancel: () => void | Promise<void> = () => {};

  let dialog: HTMLElement | null = null;
  let confirmationInput: HTMLInputElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let closing = false;
  let confirmation = '';

  $: expectedPhrase = `DELETE ${vaultId}`;

  function focusableElements() {
    return [...(dialog?.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
  }

  async function cancel() {
    if (closing || busy) return;
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
      if (!busy) void cancel();
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
    void tick().then(() => confirmationInput?.focus());
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown);
    if (!closing) restoreFocus();
  });
</script>

<div class="modal" aria-hidden="false">
  <div bind:this={dialog} class="dialog deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-deletion-title" aria-describedby="vault-deletion-description" tabindex="-1">
    <p class="eyebrow danger-text">Destructive server operation</p>
    <h2 id="vault-deletion-title">Delete server vault?</h2>
    <p id="vault-deletion-description">This permanently deletes the server-held vault named <strong>{displayName}</strong>.</p>
    <dl class="deletion-target-facts">
      <div><dt>Display name</dt><dd>{displayName}</dd></div>
      <div><dt>Full vault ID</dt><dd><code>{vaultId}</code></dd></div>
    </dl>
    <div class="deletion-scope" aria-label="Deletion scope and unaffected data">
      <p><strong>Deleted from the server:</strong> Git content and history, metadata, transfers and temporary material, devices, tokens, connections, and vault diagnostics.</p>
      <p><strong>Not deleted:</strong> local client files, independent Bridge state, and existing backups.</p>
    </div>
    <p class="muted">The server accepts this operation without a password or recent-authentication step. Once accepted, deletion cannot be cancelled. Acceptance means <strong>Deleting</strong>, not that content is already gone.</p>
    <form on:submit|preventDefault={() => onSubmit(confirmation)}>
      <label>Type <code>{expectedPhrase}</code> to confirm
        <input bind:this={confirmationInput} bind:value={confirmation} aria-label={`Type ${expectedPhrase}`} autocomplete="off" autocapitalize="off" spellcheck="false" disabled={busy} />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="secondary" disabled={busy} on:click={() => void cancel()}>Cancel</button>
        <button class="danger" disabled={busy || confirmation !== expectedPhrase}>Delete server vault</button>
      </div>
    </form>
  </div>
</div>
