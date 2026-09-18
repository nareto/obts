<script lang="ts">
  export let setupComplete = true;
  export let username = '';
  export let password = '';
  export let authError = '';
  export let busy = false;
  export let logoutFailed = false;
  export let logoutInFlight = false;
  export let onSubmit: () => void | Promise<void> = () => {};
  export let onRetryLogout: () => void | Promise<void> = () => {};
</script>

<main class="auth">
  <section class="auth-frame" aria-labelledby="auth-title">
    <div class="auth-brand" aria-hidden="true"><span>↗</span></div>
    <p class="eyebrow">Obsidian True Sync</p>
    <h1 id="auth-title">{setupComplete ? 'Sign in' : 'Initial setup'}</h1>
    <p class="auth-intro">
      {setupComplete ? 'Continue to your local sync workspace.' : 'Create the administrator account for this server.'}
    </p>
    <form class="auth-form" on:submit|preventDefault={() => onSubmit()}>
      <label>
        Username
        <input bind:value={username} autocomplete="username" disabled={logoutInFlight} />
      </label>
      <label>
        Password
        <input bind:value={password} type="password" autocomplete={setupComplete ? 'current-password' : 'new-password'} disabled={logoutInFlight} />
      </label>
      {#if authError}<p class="error" role="alert">{authError}</p>{/if}
      <button class="primary auth-submit" disabled={busy || logoutInFlight}>{setupComplete ? 'Sign in' : 'Create admin'}</button>
      {#if logoutFailed}
        <button type="button" class="secondary" disabled={busy || logoutInFlight} on:click={() => onRetryLogout()}>Retry sign out</button>
      {/if}
    </form>
    <p class="auth-footnote">Your vault data stays on the server and paired devices.</p>
  </section>
</main>
