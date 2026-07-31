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
      <h2>Troubleshooting diagnostics</h2>
      <p class="muted">
        Sanitized failure and troubleshooting reports shared explicitly by your obts plugins. Reports are retained for
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
      <p class="muted">Plugins send nothing unless “Share sanitized troubleshooting diagnostics” is enabled.</p>
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
          {#if event.schema_version === 2}
            <dl class="diagnostic-context">
              <div><dt>Attempt</dt><dd><code>{event.context.attempt_id}</code></dd></div>
              <div><dt>Trigger</dt><dd>{event.context.trigger.replaceAll('_', ' ')}</dd></div>
              <div><dt>Phase</dt><dd>{event.context.phase.replaceAll('_', ' ')}</dd></div>
              <div><dt>Outcome</dt><dd>{event.context.outcome.replaceAll('_', ' ')}</dd></div>
              <div><dt>Safe error</dt><dd>{event.context.safe_error_code.replaceAll('_', ' ')}</dd></div>
              <div><dt>Client / lease</dt><dd>{event.context.client_state} / {event.context.lease_state.replaceAll('_', ' ')}</dd></div>
              <div><dt>Local state</dt><dd>{event.context.state_source} / {event.context.status_class}</dd></div>
              <div><dt>Paired / queue</dt><dd>{event.context.paired ? 'paired' : 'unpaired'} / {event.context.queue_state.replaceAll('_', ' ')}</dd></div>
              <div><dt>Apply / onboarding</dt><dd>{event.context.apply_journal.replaceAll('_', ' ')} / {event.context.onboarding_journal.replaceAll('_', ' ')}</dd></div>
              <div><dt>Transfer / pending ack</dt><dd>{event.context.transfer_journal} / {event.context.pending_applied_ack}</dd></div>
              <div><dt>Reconcile guard</dt><dd>{event.context.reconcile_guard.replaceAll('_', ' ')} ({event.context.reconcile_timestamp} timestamp, {event.context.reconcile_error} error, {event.context.reconcile_cursors} cursors)</dd></div>
              <div><dt>Cursor guard</dt><dd>{event.context.cursor_guard.replaceAll('_', ' ')}</dd></div>
              <div><dt>Server</dt><dd>{event.context.server_device_status.replaceAll('_', ' ')} / {event.context.server_vault_status.replaceAll('_', ' ')}</dd></div>
              <div><dt>Request</dt><dd>{event.context.request_outcome.replaceAll('_', ' ')} / {event.context.http_status.replaceAll('_', ' ')}</dd></div>
              <div><dt>Head → main</dt><dd>{event.context.cursor_relations.local_head_to_local_main.replaceAll('_', ' ')}</dd></div>
              <div><dt>Server ref → head</dt><dd>{event.context.cursor_relations.server_ref_to_local_head.replaceAll('_', ' ')}</dd></div>
              <div><dt>Local → server main</dt><dd>{event.context.cursor_relations.local_main_to_server_main.replaceAll('_', ' ')}</dd></div>
              <div><dt>Event → applied / server</dt><dd>{event.context.cursor_relations.event_to_applied} / {event.context.cursor_relations.event_to_server}</dd></div>
            </dl>
          {/if}
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
      Delete all diagnostics
    </button>
  </div>
</section>
