<script lang="ts">
  import type { NoteHistoryQueryResponse, NoteHistoryVersion, NoteHistoryVersionResponse } from '../api/types';
  import { exactTime, shortId } from '../presentation';

  export let historyPath = '';
  export let history: NoteHistoryQueryResponse | null = null;
  export let selectedHistory: NoteHistoryVersion | null = null;
  export let historyVersion: NoteHistoryVersionResponse | null = null;
  export let historyDiffTab: 'rendered' | 'source' = 'source';
  export let historyError = '';
  export let historyLoading = false;
  export let busy = false;
  export let onSearch: () => void | Promise<void> = () => {};
  export let onSelectVersion: (version: NoteHistoryVersion) => void | Promise<void> = () => {};
  export let onReveal: () => void | Promise<void> = () => {};
  export let onRestore: () => void | Promise<void> = () => {};
</script>

<main class="history-page">
  <section class="page-intro">
    <div>
      <p class="eyebrow">Vault provenance</p>
      <h2>History</h2>
      <p class="muted">Inspect canonical versions for one vault path. Restore creates a new history entry.</p>
    </div>
    {#if history}<div class="history-current"><span>Current main</span><code title={history.current_main}>{shortId(history.current_main)}</code></div>{/if}
  </section>

  <section class="panel history-search" aria-labelledby="history-search-title">
    <div class="section-heading">
      <div>
        <h2 id="history-search-title">Find a path</h2>
        <p class="muted">Use the vault-relative path, for example <code>notes/example.md</code>.</p>
      </div>
      {#if historyLoading}<span class="loading-label" aria-live="polite">Loading history…</span>{/if}
    </div>
    <form class="inline-form history-form" on:submit|preventDefault={() => onSearch()}>
      <label>Path<input bind:value={historyPath} placeholder="notes/example.md" autocomplete="off" disabled={busy} /></label>
      <button class="primary" disabled={busy || !historyPath.trim()}>Search</button>
    </form>
    {#if historyError}<p class="inline-error" role="alert">{historyError}</p>{/if}
  </section>

  <div class="history-columns">
    <section class="timeline" aria-labelledby="history-versions-title">
      <div class="section-heading">
        <div><p class="eyebrow">Canonical record</p><h2 id="history-versions-title">Versions</h2></div>
        {#if history}<span class="section-count">{history.versions.length}</span>{/if}
      </div>
      {#if historyLoading && !history}
        <p class="loading-state-inline" aria-live="polite">Loading versions…</p>
      {:else if history}
        {#each history.versions as version}
          <button
            type="button"
            class:active={selectedHistory?.commit === version.commit && selectedHistory?.path === version.path}
            aria-pressed={selectedHistory?.commit === version.commit && selectedHistory?.path === version.path}
            on:click={() => onSelectVersion(version)}
          >
            <span class="timeline-main"><strong>{version.operation_type}</strong><time datetime={version.timestamp} title={exactTime(version.timestamp)}>{new Date(version.timestamp).toLocaleString()}</time></span>
            <span class="timeline-subject">{version.subject || 'No description'}</span>
            {#if version.previous_path}<small>{version.previous_path} → {version.path}</small>{/if}
            <span class="timeline-provenance">
              {#if version.device_id}<small>Device {shortId(version.device_id)}</small>{/if}
              {#if version.user_id}<small>User {shortId(version.user_id)}</small>{/if}
              {#if version.conflict_id}<small>Conflict {shortId(version.conflict_id)}</small>{/if}
              {#if version.merge_sequence}<small>Merge #{version.merge_sequence}</small>{/if}
            </span>
            <code title={version.commit}>{shortId(version.commit)}</code>
          </button>
        {:else}
          <div class="empty-state"><strong>No versions found</strong><p class="muted">This path has no canonical history in the selected vault.</p></div>
        {/each}
      {:else}
        <div class="empty-state"><strong>Search a vault path</strong><p class="muted">Versions and provenance will appear here.</p></div>
      {/if}
    </section>

    <section class="preview" aria-labelledby="history-preview-title">
      <div class="section-heading">
        <div><p class="eyebrow">Read-only inspection</p><h2 id="history-preview-title">Preview</h2></div>
        {#if historyVersion}<span class="section-count">Selected version</span>{/if}
      </div>
      {#if historyLoading && selectedHistory && !historyVersion}
        <p class="loading-state-inline" aria-live="polite">Loading selected version…</p>
      {:else if historyVersion}
        <div class="preview-target">
          <span>Selected source</span>
          <code title={historyVersion.path}>{historyVersion.path}</code>
          <small>Commit {shortId(historyVersion.commit)}</small>
        </div>
        {#if selectedHistory}
          <dl class="history-provenance">
            <div><dt>Operation</dt><dd>{selectedHistory.operation_type}</dd></div>
            <div><dt>Author</dt><dd>{selectedHistory.author_name || 'Unknown author'}</dd></div>
            <div><dt>Recorded</dt><dd>{exactTime(selectedHistory.timestamp)}</dd></div>
          </dl>
        {/if}
        {#if historyVersion.content_redacted}
          <div class="redaction-notice" role="status">
            <strong>Plugin content is redacted</strong>
            <p class="muted">Sensitive plugin bodies stay hidden until you explicitly reveal this selected version with recent authentication.</p>
            <button class="secondary" disabled={busy} on:click={() => onReveal()}>Reveal plugin content</button>
          </div>
        {:else}
          <div class="tabs" role="tablist" aria-label="History preview format">
            <button type="button" role="tab" aria-selected={historyDiffTab === 'rendered'} class:active={historyDiffTab === 'rendered'} disabled={!historyVersion.rendered_markdown_diff} on:click={() => (historyDiffTab = 'rendered')}>Rendered</button>
            <button type="button" role="tab" aria-selected={historyDiffTab === 'source'} class:active={historyDiffTab === 'source'} on:click={() => (historyDiffTab = 'source')}>Source</button>
          </div>
          {#if historyDiffTab === 'rendered' && historyVersion.rendered_markdown_diff}
            <div class="rendered">{@html historyVersion.rendered_markdown_diff}</div>
          {:else}
            <pre>{historyVersion.source_diff || historyVersion.content || 'The selected version deletes this path.'}</pre>
          {/if}
        {/if}
        <div class="restore-target">
          <div><strong>Restore target</strong><span>{history?.path ?? historyVersion.path}</span></div>
          <button class="primary" disabled={busy || !selectedHistory} on:click={() => onRestore()}>Restore this version</button>
        </div>
      {:else}
        <div class="empty-state"><strong>Select a version</strong><p class="muted">Choose a canonical version to inspect its content and provenance.</p></div>
      {/if}
    </section>
  </div>
</main>
