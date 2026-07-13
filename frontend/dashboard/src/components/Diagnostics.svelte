<script lang="ts">
  import type { DiagnosticEventsResponse } from '../api/types';

  export let diagnostics: DiagnosticEventsResponse;
  export let busy = false;
  export let onLoadMore: () => void;
  export let onDelete: () => void;
</script>

<section class="panel full diagnostics-panel">
  <div class="diagnostics-heading">
    <div>
      <p class="eyebrow">Private server log</p>
      <h2>Error diagnostics</h2>
      <p class="muted">
        Sanitized failure reports shared explicitly by your obts plugins. Reports are retained for
        {diagnostics.retention_days} days.
      </p>
    </div>
    <span class:status-enabled={diagnostics.ingestion_enabled} class="diagnostic-status">
      {diagnostics.ingestion_enabled ? 'Ingestion enabled' : 'Ingestion disabled'}
    </span>
  </div>

  {#if diagnostics.events.length === 0}
    <div class="empty-diagnostics">
      <strong>No shared errors</strong>
      <p class="muted">Plugins send nothing unless “Share error diagnostics with this obts server” is enabled.</p>
    </div>
  {:else}
    <div class="diagnostic-list">
      {#each diagnostics.events as event}
        <article class="diagnostic-card">
          <div class="diagnostic-card-heading">
            <div>
              <strong>{event.failure_code.replaceAll('_', ' ')}</strong>
              <span>{event.flow} / {event.stage}</span>
            </div>
            <time datetime={event.received_at}>{new Date(event.received_at).toLocaleString()}</time>
          </div>
          <div class="diagnostic-facts">
            <span>{event.platform_family}</span>
            <span>Plugin {event.plugin_version}</span>
            <span>Obsidian {event.obsidian_version}</span>
            <span>{event.error_class.replaceAll('_', ' ')}</span>
          </div>
          {#if event.breadcrumbs.length > 0}
            <ol class="diagnostic-trace">
              {#each event.breadcrumbs as breadcrumb}
                <li>
                  <code>{breadcrumb.point}</code>
                  <span>{breadcrumb.outcome}</span>
                  <span>{breadcrumb.value_kind}</span>
                  <span>{breadcrumb.size_bucket}</span>
                  {#if breadcrumb.error_code !== 'none'}<strong>{breadcrumb.error_code}</strong>{/if}
                </li>
              {/each}
            </ol>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <div class="actions diagnostics-actions">
    {#if diagnostics.next_cursor}
      <button class="secondary" disabled={busy} on:click={onLoadMore}>Load more</button>
    {/if}
    <button class="secondary danger" disabled={busy || diagnostics.events.length === 0} on:click={onDelete}>
      Delete all error diagnostics
    </button>
  </div>
</section>
