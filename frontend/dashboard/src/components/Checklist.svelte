<script lang="ts">
  import Status from './Status.svelte';

  export let health: {
    status: 'ready' | 'not_ready';
    checks: Record<string, boolean>;
    detail: string | null;
    git_version: string;
  };

  const rows = [
    ['metadata_store', 'Postgres'],
    ['git_store', 'Server Git store'],
    ['temp_workspace', 'Temp workspace'],
    ['migrations', 'Migrations'],
    ['git', 'Native git'],
    ['metadata_store', 'Filesystem permissions'],
    ['persistent_state', 'Event delivery'],
    ['persistent_state', 'Persistent-state backup contract']
  ] as const;
</script>

<div class="checklist">
  {#each rows as row}
    <div>
      <span>{row[1]}</span>
      <Status label={health.checks[row[0]] ? 'Synced' : 'Integrity failure'} />
      <small>{health.checks[row[0]] ? 'Last checked now' : health.detail ?? 'Check failed'}</small>
    </div>
  {/each}
</div>
