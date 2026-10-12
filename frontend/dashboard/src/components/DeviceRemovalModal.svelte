<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  export type RemovalMode = 'standard' | 'discard';
  export type DiscardReason = 'device_ref' | 'staged_transfer' | 'device_ref_inconsistent';

  export let deviceName = '';
  export let deviceId = '';
  export let mode: RemovalMode = 'standard';
  export let discardReason: DiscardReason | null = null;
  export let busy = false;
  export let failureText = '';
  export let error = '';
  export let conflictsHref: string | null = null;
  export let onSubmit: (confirmation: string, discardUnmerged: boolean) => void | Promise<void> = () => {};
  export let onCancel: () => void | Promise<void> = () => {};
  export let onOpenConflicts: () => void | Promise<void> = () => {};

  let dialog: HTMLElement | null = null;
  let confirmationInput: HTMLInputElement | null = null;
  let cancelButton: HTMLButtonElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let closing = false;
  let confirmation = '';
  let understood = false;
  let lastMode: RemovalMode = mode;
  let wasBusy = busy;

  $: expectedPhrase = mode === 'discard' ? `DELETE ${deviceId} AND DISCARD UNMERGED WORK` : `DELETE ${deviceId}`;
  $: ready = confirmation === expectedPhrase && (mode === 'standard' || understood);
  $: if (mode !== lastMode) {
    lastMode = mode;
    confirmation = '';
    understood = false;
    void tick().then(() => confirmationInput?.focus());
  }
  $: if (busy !== wasBusy) {
    wasBusy = busy;
    void tick().then(() => (busy ? cancelButton : confirmationInput)?.focus());
  }

  $: describedBy = ['device-removal-description', failureText ? 'device-removal-failure' : '', mode === 'discard' ? 'device-removal-warning' : ''].filter(Boolean).join(' ');

  const reasonText: Record<DiscardReason, string> = {
    device_ref: 'This device has changes that were never merged into the vault.',
    staged_transfer: 'This device has an upload in progress that was never merged into the vault.',
    device_ref_inconsistent: "This device's server-side state is inconsistent, so unmerged work cannot be ruled out."
  };

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

  function openConflicts(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    closing = true;
    void onOpenConflicts();
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
  <div bind:this={dialog} class="dialog deletion-dialog device-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="device-removal-title" aria-describedby={describedBy} aria-busy={busy} tabindex="-1">
    <p class="eyebrow danger-text">Destructive server operation</p>
    <h2 id="device-removal-title">{mode === 'discard' ? 'Remove device and discard unmerged work?' : 'Remove device permanently?'}</h2>
    <p id="device-removal-description">This permanently removes the revoked device <strong>{deviceName}</strong> from this vault.</p>
    <dl class="deletion-target-facts">
      <div><dt>Device name</dt><dd>{deviceName}</dd></div>
      <div><dt>Full device ID</dt><dd><code>{deviceId}</code></dd></div>
    </dl>
    <div class="deletion-scope" aria-label="What removal does">
      <p><strong>Removed:</strong> the device's identity and credentials, its server-side ref, and any pending transfer data.</p>
      <p><strong>Kept:</strong> history that was already merged into the vault. Data that can no longer be reached is cleaned up by normal maintenance and backup rotation, not immediately.</p>
    </div>
    <p class="muted">This cannot be undone. No password is needed.</p>
    {#if failureText}
      <p id="device-removal-failure" class="removal-failure">{failureText}</p>
    {/if}
    {#if mode === 'discard'}
      <div id="device-removal-warning" class="inline-error discard-warning" role="group" aria-label="Unmerged work warning">
        <strong>Unmerged work will be lost</strong>
        <p>{reasonText[discardReason ?? 'device_ref']}</p>
      </div>
    {/if}
    <form on:submit|preventDefault={() => onSubmit(confirmation, mode === 'discard')}>
      {#if mode === 'discard'}
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={understood} disabled={busy} />
          <span>I understand unmerged work from this device will be permanently discarded</span>
        </label>
      {/if}
      <label><span>Type <code class="phrase">{expectedPhrase}</code> to confirm</span>
        <input bind:this={confirmationInput} bind:value={confirmation} aria-label={`Type ${expectedPhrase}`} autocomplete="off" autocapitalize="off" spellcheck="false" disabled={busy} />
      </label>
      <p class="error removal-status" role="alert" aria-live="assertive" aria-atomic="true">{#if error}{error}{#if conflictsHref} <a href={conflictsHref} on:click={openConflicts}>Open conflicts</a>{/if}{/if}</p>
      <div class="actions">
        <button bind:this={cancelButton} type="button" class="secondary" on:click={() => void cancel()}>Cancel</button>
        <button class="danger" disabled={busy || !ready}>{busy ? 'Removing…' : 'Remove device permanently'}</button>
      </div>
    </form>
  </div>
</div>
