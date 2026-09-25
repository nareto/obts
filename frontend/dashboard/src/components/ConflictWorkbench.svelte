<script lang="ts">
  import Status from './Status.svelte';
  import {
    buildConflictDiff,
    changedRows,
    choicesForAllRows,
    hasDivergentFinalPaths,
    isAgreedFileDeletion,
    previewOutcomeLabel,
    previewProvenanceLabel,
    resolveConflictFile,
    submissionCandidateKey,
    unresolvedLineCount,
    validateManualPathTargets,
    type ConflictDiffRow,
    type LineResolution
  } from '../conflictDiff';
  import type {
    ConflictResolutionKind,
    ConflictResolutionPreview,
    ConflictResolutionSubmission,
    ConflictReviewFile,
    ConflictReviewPackage,
    ConflictReviewPath,
    ManualFilePlanEntry
  } from '../api/types';

  export let review: ConflictReviewPackage;
  export let conflictType = 'Path overlap';
  export let onSubmit: (submission: ConflictResolutionSubmission, expectedTree?: string) => Promise<void> = async () => {};
  export let onPreview: (submission: ConflictResolutionSubmission) => Promise<ConflictResolutionPreview> = async () => {
    throw new Error('Resolution preview is unavailable.');
  };
  export let onRefresh: () => Promise<void> = async () => {};

  type PreviewState =
    | { kind: 'idle' }
    | { kind: 'loading'; candidateKey: string }
    | { kind: 'ready'; candidateKey: string; preview: ConflictResolutionPreview; reviewRef: ConflictReviewPackage }
    | { kind: 'error'; candidateKey: string; message: string };

  let initializedKey = '';
  let activePath = '';
  let mode: 'whole' | 'lines' = 'whole';
  let resolutionKind: ConflictResolutionKind = 'keep_server';
  let lineChoices: Record<string, Record<string, LineResolution>> = {};
  let diffs: Record<string, ConflictDiffRow[]> = {};
  let manualTextByPath: Record<string, string> = {};
  let manualPathByGroup: Record<string, string> = {};
  let manualContentByGroup: Record<string, string> = {};
  let manualDeleteByGroup: Record<string, boolean> = {};
  let submitting = false;
  let view: 'compare' | 'result' = 'compare';
  let previewState: PreviewState = { kind: 'idle' };
  let previewGeneration = 0;
  let candidateRevision = 0;
  let currentSubmission: ConflictResolutionSubmission | null = null;
  let currentCandidateKey = '';
  const fileNodes = new Map<string, HTMLElement>();
  let fileObserver: IntersectionObserver | null = null;

  $: reviewKey = `${review.conflict.conflict_id}:${review.expected_main}:${review.files.map((file) => file.path).join('|')}:${review.directory_conflicts.map((group) => group.root).join('|')}`;
  $: if (reviewKey !== initializedKey) initializeReview();
  $: structuralGroups = review.path_conflicts.filter(hasStructuralChange);
  $: titleGroups = review.path_conflicts.filter(hasTitleConflict);
  $: hasBinary = review.files.some((file) => file.content_kind === 'binary');
  $: hasLargeText = review.files.some((file) => file.content_kind === 'large_text');
  $: hasDirectoryConflicts = review.directory_conflicts.length > 0;
  $: hasNonInteractiveContent = hasBinary || hasLargeText;
  $: hasUnlineableText = review.files.some(
    (file) => file.content_kind === 'text' && changedRows(diffs[file.path] ?? []).length === 0 && file.server_content !== file.device_content
  );
  $: individualAvailable = !hasDirectoryConflicts && !hasNonInteractiveContent && !hasUnlineableText && titleGroups.length === 0;
  $: unresolved = unresolvedLineCount(diffs, lineChoices);
  $: reviewResolved = review.conflict.status === 'resolved';
  $: manualPlanError = mode === 'whole' && resolutionKind === 'manual' ? validateManualPlan() : '';
  $: statusLabel = reviewResolved ? 'Synced' : review.stale ? 'Stale review' : 'Review needed';
  $: if (candidateRevision >= 0) {
    currentSubmission = buildSubmission();
    currentCandidateKey = currentSubmission ? submissionCandidateKey(currentSubmission) : '';
  }
  $: reviewedPreview = previewState.kind === 'ready'
    && previewState.reviewRef === review
    && previewState.candidateKey === currentCandidateKey
    && currentCandidateKey !== ''
    && !review.stale
    && !reviewResolved
    ? previewState.preview
    : null;
  $: canApply = reviewedPreview !== null;

  function initializeReview() {
    initializedKey = reviewKey;
    activePath = review.files[0]?.path ?? '';
    mode = 'whole';
    resolutionKind = 'keep_server';
    diffs = Object.fromEntries(review.files.map((file) => [file.path, buildConflictDiff(file)]));
    lineChoices = {};
    manualTextByPath = Object.fromEntries(
      review.files.map((file) => [file.path, file.server_content ?? file.device_content ?? ''])
    );
    manualPathByGroup = Object.fromEntries(
      review.path_conflicts.map((group) => [group.group_id, group.server_path ?? group.device_path ?? group.base_path ?? group.affected_paths[0] ?? ''])
    );
    manualContentByGroup = Object.fromEntries(
      review.path_conflicts.map((group) => [group.group_id, defaultGroupContent(group)])
    );
    manualDeleteByGroup = Object.fromEntries(review.path_conflicts.map((group) => [group.group_id, false]));
    view = 'compare';
    previewState = { kind: 'idle' };
    previewGeneration += 1;
    candidateChanged();
  }

  function candidateChanged() {
    candidateRevision += 1;
  }

  function trackFile(node: HTMLElement, path: string) {
    fileNodes.set(path, node);
    if (typeof IntersectionObserver !== 'undefined') {
      fileObserver ??= new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
          const path = visible?.target.getAttribute('data-conflict-path');
          if (path) activePath = path;
        },
        { rootMargin: '-18% 0px -68% 0px', threshold: [0, 0.01] }
      );
      fileObserver.observe(node);
    }
    return {
      destroy() {
        fileObserver?.unobserve(node);
        fileNodes.delete(path);
      }
    };
  }

  function scrollToFile(path: string) {
    activePath = path;
    fileNodes.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function jumpToSelectedFile(event: Event) {
    scrollToFile((event.currentTarget as HTMLSelectElement).value);
  }

  function pathGroup(file: ConflictReviewFile): ConflictReviewPath | null {
    return review.path_conflicts.find((group) => group.affected_paths.includes(file.path)) ?? null;
  }

  function hasStructuralChange(group: ConflictReviewPath): boolean {
    return group.base_path !== group.server_path || group.base_path !== group.device_path;
  }

  function hasTitleConflict(group: ConflictReviewPath): boolean {
    return hasDivergentFinalPaths(group);
  }

  function groupLabel(group: ConflictReviewPath): string {
    if (!hasTitleConflict(group)) return group.base_path ?? group.server_path ?? group.device_path ?? 'Path overlap';
    return `${group.base_path ?? '(new file)'} -> ${group.server_path ?? '(deleted)'} / ${group.device_path ?? '(deleted)'}`;
  }

  function defaultGroupContent(group: ConflictReviewPath): string {
    const server = group.server_path ? review.files.find((file) => file.path === group.server_path)?.server_content : null;
    const device = group.device_path ? review.files.find((file) => file.path === group.device_path)?.device_content : null;
    return server ?? device ?? '';
  }

  function belongsToTitleGroup(path: string): boolean {
    return titleGroups.some((group) => group.affected_paths.includes(path));
  }

  function setMode(next: 'whole' | 'lines') {
    if (mode === next) return;
    mode = next;
    candidateChanged();
  }

  function changeResolutionKind(event: Event) {
    resolutionKind = (event.currentTarget as HTMLSelectElement).value as ConflictResolutionKind;
    candidateChanged();
  }

  function setLineChoice(path: string, rowId: string, choice: LineResolution) {
    lineChoices = {
      ...lineChoices,
      [path]: { ...(lineChoices[path] ?? {}), [rowId]: choice }
    };
    candidateChanged();
  }

  function chooseFile(path: string, choice: LineResolution) {
    lineChoices = {
      ...lineChoices,
      [path]: Object.fromEntries(changedRows(diffs[path] ?? []).map((row) => [row.id, choice]))
    };
    candidateChanged();
  }

  function chooseAll(choice: LineResolution) {
    lineChoices = choicesForAllRows(diffs, choice);
    candidateChanged();
  }

  function updateManualText(path: string, event: Event) {
    manualTextByPath = { ...manualTextByPath, [path]: (event.currentTarget as HTMLTextAreaElement).value };
    candidateChanged();
  }

  function updateManualPath(groupId: string, event: Event) {
    manualPathByGroup = { ...manualPathByGroup, [groupId]: (event.currentTarget as HTMLInputElement).value };
    candidateChanged();
  }

  function updateManualGroupContent(groupId: string, event: Event) {
    manualContentByGroup = { ...manualContentByGroup, [groupId]: (event.currentTarget as HTMLTextAreaElement).value };
    candidateChanged();
  }

  function updateManualDelete(groupId: string, event: Event) {
    manualDeleteByGroup = { ...manualDeleteByGroup, [groupId]: (event.currentTarget as HTMLInputElement).checked };
    candidateChanged();
  }

  function validateManualPlan(): string {
    return validateManualPathTargets(
      review.files.filter((file) => !belongsToTitleGroup(file.path) && !isAgreedFileDeletion(file)).map((file) => file.path),
      titleGroups.map((group) => ({
        label: groupLabel(group),
        path: manualPathByGroup[group.group_id] ?? '',
        deleted: Boolean(manualDeleteByGroup[group.group_id])
      }))
    );
  }

  function buildManualFilePlan(): ManualFilePlanEntry[] {
    const error = validateManualPlan();
    if (error) throw new Error(error);
    const plan = new Map<string, string | null>(review.conflict.affected_paths.map((path) => [path, null]));
    for (const file of review.files) {
      if (!belongsToTitleGroup(file.path) && !isAgreedFileDeletion(file)) plan.set(file.path, manualTextByPath[file.path] ?? '');
    }
    for (const group of titleGroups) {
      if (manualDeleteByGroup[group.group_id]) continue;
      const path = (manualPathByGroup[group.group_id] ?? '').trim();
      plan.set(path, manualContentByGroup[group.group_id] ?? '');
    }
    return [...plan.entries()].map(([path, content]) => ({ path, content }));
  }

  function buildSubmission(): ConflictResolutionSubmission | null {
    if (reviewResolved) return null;
    if (mode === 'lines') {
      if (!individualAvailable || unresolved > 0) return null;
      try {
        const manualFiles = Object.fromEntries(
          review.files.map((file) => [file.path, resolveConflictFile(file, diffs[file.path] ?? [], lineChoices[file.path] ?? {})])
        );
        return { resolutionKind: 'manual', manualFiles };
      } catch {
        return null;
      }
    }
    if (resolutionKind !== 'manual') return { resolutionKind };
    if (manualPlanError) return null;
    if (structuralGroups.length > 0) {
      try {
        return { resolutionKind: 'manual', manualFilePlan: buildManualFilePlan() };
      } catch {
        return null;
      }
    }
    return {
      resolutionKind: 'manual',
      manualFiles: Object.fromEntries(review.files.map((file) => [file.path, manualTextByPath[file.path] ?? '']))
    };
  }

  async function reviewResult() {
    const submission = buildSubmission();
    if (!submission || review.stale || reviewResolved || previewState.kind === 'loading') return;
    const candidateKey = submissionCandidateKey(submission);
    const generation = ++previewGeneration;
    previewState = { kind: 'loading', candidateKey };
    try {
      const preview = await onPreview(submission);
      if (generation !== previewGeneration) return;
      if (currentCandidateKey !== candidateKey) {
        previewState = { kind: 'idle' };
        return;
      }
      previewState = { kind: 'ready', candidateKey, preview, reviewRef: review };
      view = 'result';
    } catch (error) {
      if (generation !== previewGeneration) return;
      previewState = {
        kind: 'error',
        candidateKey,
        message: error instanceof Error ? error.message : 'Unable to review this result.'
      };
    }
  }

  function showResult() {
    view = 'result';
    if (!reviewedPreview && !reviewResolved && !review.stale && previewState.kind !== 'loading' && currentSubmission) {
      void reviewResult();
    }
  }

  async function applyResolution() {
    const preview = reviewedPreview;
    const submission = buildSubmission();
    if (!preview || !submission || submitting) return;
    submitting = true;
    try {
      await onSubmit(submission, preview.tree);
    } finally {
      submitting = false;
    }
  }

  function choiceLabel(choice: ConflictResolutionKind): string {
    switch (choice) {
      case 'keep_server': return hasDirectoryConflicts ? 'Keep server directory state' : 'Keep server version';
      case 'use_device': return hasDirectoryConflicts ? 'Use device directory state' : 'Use device version';
      case 'keep_both_files': return 'Keep both notes/files';
      case 'insert_both_blocks': return 'Insert both blocks';
      case 'manual': return 'Edit complete final files';
    }
  }

  function resultPolicyLabel(): string {
    return mode === 'lines' ? 'Line-by-line final content' : choiceLabel(resolutionKind);
  }

  function displayLine(value: string): string {
    return value.replace(/(?:\r\n|\n|\r)$/u, '');
  }

  function formatBytes(value: number | null): string {
    if (value === null) return 'absent';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function formatDigest(value: string | null): string {
    return value ? `${value.slice(0, 12)}...` : '-';
  }

  function addedLineCount(rows: ConflictDiffRow[]): number {
    return changedRows(rows).filter((row) => row.deviceText !== null).length;
  }

  function removedLineCount(rows: ConflictDiffRow[]): number {
    return changedRows(rows).filter((row) => row.serverText !== null).length;
  }

  function isChoiceDisabled(choice: ConflictResolutionKind): boolean {
    return (choice === 'manual' && hasNonInteractiveContent) || (choice === 'insert_both_blocks' && hasBinary);
  }
</script>

<section class="conflict-workbench">
  <section class="conflict-review-header">
    <div class="conflict-review-title">
      <p class="eyebrow">Conflict review</p>
      <h2>{conflictType}</h2>
      <p>
        Changes from <strong>{review.device_name}</strong> overlap server main across
        {review.files.length} file{review.files.length === 1 ? '' : 's'}{hasDirectoryConflicts ? ` and ${review.directory_conflicts.length} directory subtree${review.directory_conflicts.length === 1 ? '' : 's'}` : ''}.
      </p>
    </div>
    <div class="conflict-compare" aria-label="Compared revisions">
      <div><span>Server</span><code>{review.expected_main.slice(0, 10)}</code></div>
      <span class="compare-arrow" aria-hidden="true">&harr;</span>
      <div><span>Device</span><code>{review.conflict.device_commit.slice(0, 10)}</code></div>
    </div>
    <Status label={statusLabel} />
  </section>

  {#if review.stale}
    <div class="stale-banner" role="alert">
      <strong>This review is stale.</strong>
      <span>The server changed after this package was created. Refresh before resolving.</span>
    </div>
  {/if}

  <section class="conflict-resolution-toolbar" aria-label="Conflict resolution controls">
    {#if review.files.length > 0}
      <label class="conflict-file-jump">
        <span>Jump to file</span>
        <select value={activePath} on:change={jumpToSelectedFile}>
          {#each review.files as file}
            <option value={file.path}>{file.path}</option>
          {/each}
        </select>
      </label>
    {:else}
      <div class="conflict-file-jump"><span>Directory conflict</span><strong>{review.directory_conflicts.length} subtree{review.directory_conflicts.length === 1 ? '' : 's'}</strong></div>
    {/if}

    {#if reviewResolved}
      <div class="resolved-summary">
        <strong>{review.conflict.resolution_kind ? choiceLabel(review.conflict.resolution_kind) : 'Resolved'}</strong>
        <span>{review.conflict.resolved_at ? new Date(review.conflict.resolved_at).toLocaleString() : ''}</span>
        {#if review.conflict.resolution_commit}<code>{review.conflict.resolution_commit.slice(0, 10)}</code>{/if}
      </div>
    {:else}
      <div class="resolution-mode" role="group" aria-label="Resolution mode">
        <button aria-pressed={mode === 'whole'} class:active={mode === 'whole'} on:click={() => setMode('whole')}>Whole conflict</button>
        <button aria-pressed={mode === 'lines'} class:active={mode === 'lines'} disabled={!individualAvailable} on:click={() => setMode('lines')}>Line by line</button>
      </div>

      {#if mode === 'whole'}
        <label class="resolution-policy">
          <span>Resolution</span>
          <select value={resolutionKind} on:change={changeResolutionKind}>
            {#each review.choices as choice}
              <option value={choice} disabled={isChoiceDisabled(choice)}>{choiceLabel(choice)}</option>
            {/each}
          </select>
        </label>
        <p class="resolution-context">One decision applies to the complete conflict package.</p>
      {:else}
        <div class="review-bulk-actions" aria-label="Choose every changed line">
          <span><strong>{unresolved}</strong> unresolved</span>
          <button class="secondary" on:click={() => chooseAll('server')}>All server</button>
          <button class="secondary" on:click={() => chooseAll('device')}>All device</button>
          <button class="secondary" on:click={() => chooseAll('both')}>Keep all both</button>
        </div>
      {/if}
    {/if}

    {#if review.stale}
      <button class="primary resolve-action" disabled={submitting} on:click={onRefresh}>Refresh review</button>
    {:else if !reviewResolved}
      {#if canApply}
        <button class="primary resolve-action" disabled={submitting} on:click={applyResolution}>
          {submitting ? 'Applying...' : 'Apply resolution'}
        </button>
      {:else}
        <button
          class="primary resolve-action"
          disabled={submitting || previewState.kind === 'loading' || !currentSubmission}
          on:click={reviewResult}
        >
          {previewState.kind === 'loading' ? 'Reviewing...' : 'Review result'}
        </button>
      {/if}
    {/if}
  </section>

  {#if manualPlanError}<p class="warning resolution-banner">{manualPlanError}</p>{/if}
  {#if previewState.kind === 'error' && previewState.candidateKey === currentCandidateKey}<p class="warning resolution-banner" role="alert">{previewState.message}</p>{/if}

  {#if hasDirectoryConflicts}
    <section class="directory-conflict-panel" aria-label="Directory conflicts">
      <div>
        <p class="eyebrow">Directory state</p>
        <h3>Choose the canonical directory outcome</h3>
        <p>The server records the decision. Devices only perform non-recursive, empty-directory-safe materialization.</p>
      </div>
      <div class="directory-conflict-list">
        {#each review.directory_conflicts as group}
          {@const reviewedDirectory = reviewedPreview?.directory_conflicts.find((candidate) => candidate.root === group.root)}
          <article>
            <code>{group.root}</code>
            <span>Server: <strong>{group.server_state}</strong></span>
            <span>Device: <strong>{group.device_state}</strong></span>
            {#if reviewedDirectory}
              <span class="directory-result">Reviewed result: <strong>{reviewedDirectory.outcome === 'server' ? reviewedDirectory.server_state : reviewedDirectory.device_state}</strong></span>
            {/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}

  {#if !reviewResolved && !individualAvailable && !hasDirectoryConflicts}
    <p class="resolution-banner">
      Line-by-line resolution is unavailable for {hasBinary ? 'binary content' : hasLargeText ? 'large text content' : hasUnlineableText ? 'an empty-file add/delete' : 'path or rename conflicts'}.
      Choose a whole-conflict policy so bytes and paths remain safe.
    </p>
  {/if}

  {#if review.files.length > 0 || hasDirectoryConflicts}
  <div class="conflict-review-body" class:no-file-navigator={review.files.length === 0}>
    {#if review.files.length > 0}
      <aside class="conflict-file-navigator">
        <div class="file-navigator-heading">
          <strong>Files changed</strong>
          <span>{review.files.length}</span>
        </div>
        <nav class="path-list" aria-label="Affected files">
          {#each review.files as file}
            {@const fileRows = diffs[file.path] ?? []}
            {@const added = addedLineCount(fileRows)}
            {@const removed = removedLineCount(fileRows)}
            <button
              class:active={activePath === file.path}
              aria-current={activePath === file.path ? 'location' : undefined}
              title={file.path}
              on:click={() => scrollToFile(file.path)}
            >
              <span class="file-nav-path">{file.path}</span>
              <span class="file-nav-stats">
                {#if file.content_kind === 'binary'}
                  <b class="file-kind">BIN</b>
                {:else if file.content_kind === 'large_text'}
                  <b class="file-kind">LARGE</b>
                {:else if added === 0 && removed === 0}
                  <b class="no-content-delta">no content delta</b>
                {:else}
                  <b class="addition">+{added}</b><b class="deletion">-{removed}</b>
                {/if}
              </span>
            </button>
          {/each}
        </nav>
      </aside>
    {/if}

    <section class="conflict-document">
      {#if !reviewResolved}
        <div class="conflict-view-tabs" role="group" aria-label="Conflict detail view">
          <button aria-pressed={view === 'compare'} class:active={view === 'compare'} on:click={() => (view = 'compare')}>Compare</button>
          <button aria-pressed={view === 'result'} class:active={view === 'result'} on:click={showResult}>Result</button>
        </div>
      {/if}

      {#if view === 'compare' || reviewResolved}
        {#if mode === 'whole' && resolutionKind === 'manual' && titleGroups.length > 0}
          <section class="structure-editor panel">
            <h2>Final paths</h2>
            <p class="muted">Path conflicts require an explicit final path and complete content.</p>
            {#each titleGroups as group}
              <div class="structure-group">
                <strong>{groupLabel(group)}</strong>
                <label class="checkbox-label">
                  <input type="checkbox" checked={manualDeleteByGroup[group.group_id] ?? false} on:change={(event) => updateManualDelete(group.group_id, event)} />
                  Delete this path group in the final result
                </label>
                {#if !manualDeleteByGroup[group.group_id]}
                  <label>
                    Final path
                    <input value={manualPathByGroup[group.group_id] ?? ''} on:input={(event) => updateManualPath(group.group_id, event)} />
                  </label>
                  <label>
                    Final content
                    <textarea value={manualContentByGroup[group.group_id] ?? ''} on:input={(event) => updateManualGroupContent(group.group_id, event)}></textarea>
                  </label>
                {/if}
              </div>
            {/each}
          </section>
        {/if}

        {#if review.files.length > 0}
          <div class="diff-source-legend" aria-label="Diff source legend">
            <span class="legend-entry legend-server"><b aria-hidden="true">&minus;</b> Server main</span>
            <span class="legend-entry legend-device"><b aria-hidden="true">+</b> Device: {review.device_name}</span>
            <span class="legend-note">Colors identify versions, not which changes you've chosen to keep.</span>
          </div>
          <div class="conflict-file-stack">
            {#each review.files as file, fileIndex (file.path)}
              {@const group = pathGroup(file)}
              {@const rows = diffs[file.path] ?? []}
              {@const changes = changedRows(rows)}
              <article
                class="conflict-file"
                id={`conflict-file-${fileIndex}`}
                data-conflict-path={file.path}
                use:trackFile={file.path}
              >
                <header class="conflict-file-header">
                  <div class="conflict-file-identity">
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M3.75 1.75A1.75 1.75 0 0 0 2 3.5v9A1.75 1.75 0 0 0 3.75 14.25h8.5A1.75 1.75 0 0 0 14 12.5V6.06a1.75 1.75 0 0 0-.513-1.237l-2.31-2.31A1.75 1.75 0 0 0 9.94 2H3.75Zm6.5 1.81c.02.012.04.027.057.044l2.09 2.09a.25.25 0 0 1 .043.056h-1.69a.5.5 0 0 1-.5-.5V3.56ZM3.5 3.5a.25.25 0 0 1 .25-.25H9v2a1.75 1.75 0 0 0 1.75 1.75h2v5.5a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25v-9Z" /></svg>
                    <code title={file.path}>{file.path}</code>
                  </div>
                  <div class="conflict-file-stats">
                    {#if file.content_kind === 'binary'}
                      <span class="file-kind">Binary</span>
                    {:else if file.content_kind === 'large_text'}
                      <span class="file-kind">Large text</span>
                    {:else}
                      <span class="addition">+{addedLineCount(rows)}</span>
                      <span class="deletion">-{removedLineCount(rows)}</span>
                    {/if}
                  </div>
                  {#if mode === 'lines' && file.content_kind === 'text' && changes.length > 0}
                    <div class="file-bulk-actions" aria-label={`Choose all changes in ${file.path}`}>
                      <button class="secondary" on:click={() => chooseFile(file.path, 'server')}>All server</button>
                      <button class="secondary" on:click={() => chooseFile(file.path, 'device')}>All device</button>
                      <button class="secondary" on:click={() => chooseFile(file.path, 'both')}>Keep both</button>
                    </div>
                  {/if}
                </header>

                {#if group && hasStructuralChange(group)}
                  <section class:path-warning={hasTitleConflict(group)} class="path-review">
                    <div class="path-review-heading"><code>@@ path operation @@</code></div>
                    <div><span>Base</span><code>{group.base_path ?? '(absent)'}</code></div>
                    <div><span>Server / {group.server_operation}</span><code>{group.server_path ?? '(deleted)'}</code></div>
                    <div><span>Device / {group.device_operation}</span><code>{group.device_path ?? '(deleted)'}</code></div>
                  </section>
                {/if}

                {#if file.content_kind !== 'text'}
                  <div class="binary-review">
                    <strong>{file.content_kind === 'binary' ? 'Binary preview unavailable' : 'Large text preview limited'}</strong>
                    <p>
                      {file.content_kind === 'binary'
                        ? 'Use a whole-conflict server, device, or keep-both resolution. obts will preserve the original bytes.'
                        : 'This file exceeds the interactive diff limit. Use a whole-conflict action so the dashboard does not freeze or truncate content.'}
                    </p>
                    <dl>
                      <div><dt>Base</dt><dd>{formatBytes(file.base_bytes)}</dd><dd><code title={file.base_sha256 ?? ''}>{formatDigest(file.base_sha256)}</code></dd></div>
                      <div><dt>Server</dt><dd>{formatBytes(file.server_bytes)}</dd><dd><code title={file.server_sha256 ?? ''}>{formatDigest(file.server_sha256)}</code></dd></div>
                      <div><dt>Device</dt><dd>{formatBytes(file.device_bytes)}</dd><dd><code title={file.device_sha256 ?? ''}>{formatDigest(file.device_sha256)}</code></dd></div>
                    </dl>
                  </div>
                {:else if changes.length === 0}
                  <div class="no-content-diff">
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="20" height="20"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" /></svg>
                    <div>
                      <strong>No content delta</strong>
                      <p>The server and device bytes are identical. This file remains in the review because it belongs to the conflict package.</p>
                    </div>
                  </div>
                {:else}
                  <div class="github-diff" aria-label={`Server and device changes for ${file.path}`}>
                    <div class="diff-hunk-header">
                      <span class="line-number">...</span><span class="line-number">...</span><code>@@ Server main &harr; Device: {review.device_name} @@</code>
                    </div>
                    {#each rows as row}
                      {#if row.kind === 'context'}
                        <div class="diff-code-row context">
                          <span class="line-number">{row.serverLine}</span>
                          <span class="line-number">{row.deviceLine}</span>
                          <span class="diff-marker"> </span>
                          <code>{displayLine(row.text)}</code>
                        </div>
                      {:else}
                        <div class="diff-change-group" class:resolved={Boolean(lineChoices[file.path]?.[row.id])}>
                          {#if row.serverText !== null}
                            <div class="diff-code-row removed">
                              <span class="line-number">{row.serverLine}</span>
                              <span class="line-number"></span>
                              <span class="diff-marker" aria-hidden="true">-</span>
                              <code><span class="visually-hidden">Server main: </span>{#each row.serverTokens as token}<span class:word-change={token.changed}>{token.text}</span>{/each}</code>
                            </div>
                          {/if}
                          {#if row.deviceText !== null}
                            <div class="diff-code-row added">
                              <span class="line-number"></span>
                              <span class="line-number">{row.deviceLine}</span>
                              <span class="diff-marker" aria-hidden="true">+</span>
                              <code><span class="visually-hidden">Device {review.device_name}: </span>{#each row.deviceTokens as token}<span class:word-change={token.changed}>{token.text}</span>{/each}</code>
                            </div>
                          {/if}
                          {#if mode === 'lines'}
                            <div class="line-choice" aria-label={`Resolution for changed line ${row.id}`}>
                              <button
                                class:active={lineChoices[file.path]?.[row.id] === 'server'}
                                aria-pressed={lineChoices[file.path]?.[row.id] === 'server'}
                                aria-label={`Use server for ${file.path}, server line ${row.serverLine ?? 'absent'}, device line ${row.deviceLine ?? 'absent'}`}
                                on:click={() => setLineChoice(file.path, row.id, 'server')}
                              >Use server</button>
                              <button
                                class:active={lineChoices[file.path]?.[row.id] === 'device'}
                                aria-pressed={lineChoices[file.path]?.[row.id] === 'device'}
                                aria-label={`Use device for ${file.path}, server line ${row.serverLine ?? 'absent'}, device line ${row.deviceLine ?? 'absent'}`}
                                on:click={() => setLineChoice(file.path, row.id, 'device')}
                              >Use device</button>
                              <button
                                class:active={lineChoices[file.path]?.[row.id] === 'both'}
                                aria-pressed={lineChoices[file.path]?.[row.id] === 'both'}
                                aria-label={`Keep both for ${file.path}, server line ${row.serverLine ?? 'absent'}, device line ${row.deviceLine ?? 'absent'}`}
                                on:click={() => setLineChoice(file.path, row.id, 'both')}
                              >Keep both</button>
                            </div>
                          {/if}
                        </div>
                      {/if}
                    {:else}
                      <p class="muted no-diff">The server and device text are identical; this conflict is structural.</p>
                    {/each}
                  </div>

                  {#if file.rendered_markdown_diff}
                    <details class="rendered-preview">
                      <summary>Rendered Markdown comparison</summary>
                      <div class="rendered">{@html file.rendered_markdown_diff}</div>
                    </details>
                  {/if}

                  {#if mode === 'whole' && resolutionKind === 'manual' && !belongsToTitleGroup(file.path) && !isAgreedFileDeletion(file)}
                    <label class="manual-file-editor">
                      Complete final content for {file.path}
                      <textarea value={manualTextByPath[file.path] ?? ''} on:input={(event) => updateManualText(file.path, event)}></textarea>
                    </label>
                  {/if}
                {/if}
              </article>
            {/each}
          </div>
        {:else}
          <p class="muted conflict-empty-document">This conflict affects directory state only. Review the result to see the canonical directory outcome.</p>
        {/if}
      {:else}
        <section class="conflict-result" aria-label="Reviewed resolution result">
          <header class="conflict-result-header">
            <div>
              <p class="eyebrow">Reviewed result</p>
              <h3>{resultPolicyLabel()}</h3>
              <p class="muted">Nothing is applied until you choose Apply resolution. This is the complete final state obts would commit.</p>
            </div>
          </header>

          {#if reviewedPreview}
            {#if reviewedPreview.files.length > 0}
              {#each reviewedPreview.files as file (file.path)}
                <article class="conflict-result-file" class:result-deleted={file.operation === 'deleted'}>
                  <header>
                    <code title={file.path}>{file.path}</code>
                    <span class="result-operation" data-operation={file.operation}>{previewOutcomeLabel(file)}</span>
                    <span class="result-provenance">{previewProvenanceLabel(file, review.device_name)}</span>
                  </header>
                  {#if file.operation === 'copied' && file.source_path}
                    <p class="result-detail">Copied from <code>{file.source_path}</code> so the server version stays at its original path.</p>
                  {/if}
                  {#if file.operation === 'deleted'}
                    <p class="result-detail">This path is removed from the resolved vault. A deletion is not an empty file.</p>
                  {:else if file.content_kind === 'text' && file.content !== null}
                    {#if file.content.length === 0}
                      <p class="result-empty">The final file is empty (0 bytes).</p>
                    {:else}
                      <pre class="result-content">{file.content}</pre>
                    {/if}
                  {:else if file.content_kind === 'large_text'}
                    <p class="result-limit">
                      <strong>Large text not displayed.</strong>
                      The final bytes are {formatBytes(file.bytes)} and are preserved exactly; the dashboard does not truncate them.
                      SHA-256 <code title={file.sha256 ?? ''}>{formatDigest(file.sha256)}</code>.
                    </p>
                  {:else}
                    <p class="result-limit">
                      <strong>Binary content not displayed.</strong>
                      The final bytes are {formatBytes(file.bytes)} and are preserved exactly.
                      SHA-256 <code title={file.sha256 ?? ''}>{formatDigest(file.sha256)}</code>.
                    </p>
                  {/if}
                </article>
              {/each}
            {/if}
            {#if reviewedPreview.directory_conflicts.length > 0}
              <section class="result-directories">
                <h4>Directory outcomes</h4>
                {#each reviewedPreview.directory_conflicts as group}
                  <div>
                    <code>{group.root}</code>
                    <span>
                      Final: <strong>{group.outcome === 'server' ? group.server_state : group.device_state}</strong>
                      ({group.outcome === 'server' ? 'Server main' : `Device: ${review.device_name}`})
                    </span>
                  </div>
                {/each}
              </section>
            {/if}
          {:else if previewState.kind === 'loading' && previewState.candidateKey === currentCandidateKey}
            <p class="muted result-prompt" aria-live="polite">Building the complete final result...</p>
          {:else if previewState.kind === 'error' && previewState.candidateKey === currentCandidateKey}
            <p class="warning result-prompt" role="alert">{previewState.message}</p>
          {:else if previewState.kind === 'ready'}
            <p class="muted result-prompt">Your choices changed after this result was reviewed. Review the result again before applying.</p>
          {:else}
            <p class="muted result-prompt">Review the result to see the complete final files before applying.</p>
          {/if}
        </section>
      {/if}
    </section>
  </div>
  {/if}
</section>
