<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import Status from './Status.svelte';
  import {
    buildConflictDiff,
    changedRows,
    collapseConflictDiff,
    formatDiffLineRange,
    isAgreedFileDeletion,
    previewOutcomeLabel,
    previewProvenanceLabel,
    resolveConflictFile,
    submissionCandidateKey,
    validateManualPathTargets,
    type CollapsedDiffGap,
    type ConflictDiffRow,
    type DiffLineRange,
    type LineResolution
  } from '../conflictDiff';
  import {
    buildDecisionUnits,
    decisionCapabilities,
    fileChoiceLabel,
    perFileSubmission,
    unitStatus,
    type DecisionCapabilities,
    type DecisionUnit,
    type FileChoice,
    type UnitStatus
  } from '../conflictDecisions';
  import type {
    ConflictResolutionKind,
    ConflictResolutionPreview,
    ConflictResolutionSubmission,
    ConflictReviewFile,
    ConflictReviewPackage,
    ConflictReviewPath,
    ManualFilePlanEntry,
    PerFileResolutionEntry
  } from '../api/types';

  export let review: ConflictReviewPackage;
  export let conflictType = 'Path overlap';
  export let onSubmit: (submission: ConflictResolutionSubmission, expectedTree?: string) => Promise<void> = async () => {};
  export let onPreview: (submission: ConflictResolutionSubmission) => Promise<ConflictResolutionPreview> = async () => {
    throw new Error('Resolution preview is unavailable.');
  };
  export let onRefresh: () => Promise<void> = async () => {};
  export let onDirtyChange: (dirty: boolean) => void = () => {};

  type PreviewState =
    | { kind: 'idle' }
    | { kind: 'loading'; candidateKey: string }
    | { kind: 'ready'; candidateKey: string; preview: ConflictResolutionPreview; reviewRef: ConflictReviewPackage }
    | { kind: 'error'; candidateKey: string; message: string };

  type DirectoryChoice = 'keep_server' | 'use_device';
  type ExtraChoice = 'keep_both_files' | 'insert_both_blocks' | 'manual';
  const DIRECTORY_CHOICES: DirectoryChoice[] = ['keep_server', 'use_device'];

  let initializedKey = '';
  let activePath = '';
  let fileChoices: Record<string, FileChoice> = {};
  let directoryChoice: DirectoryChoice | null = null;
  let lineChoices: Record<string, Record<string, LineResolution>> = {};
  let diffs: Record<string, ConflictDiffRow[]> = {};
  let expandedGaps: Record<string, Record<string, boolean>> = {};
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
  let draftTouched = false;
  const fileNodes = new Map<string, HTMLElement>();
  let fileObserver: IntersectionObserver | null = null;

  $: reviewKey = `${review.conflict.conflict_id}:${review.expected_main}:${review.files.map((file) => file.path).join('|')}:${review.directory_conflicts.map((group) => group.root).join('|')}`;
  $: if (reviewKey !== initializedKey) initializeReview();
  $: affectedPaths = new Set(review.conflict.affected_paths);
  $: allUnits = buildDecisionUnits(review.files, review.path_conflicts, review.conflict.affected_paths);
  $: units = allUnits.filter((unit) => unit.files.length > 0);
  $: contentlessPaths = allUnits.filter((unit) => unit.files.length === 0).flatMap((unit) => unit.paths);
  $: unitByPath = new Map(units.flatMap((unit) => unit.paths.map((path) => [path, unit] as const)));
  $: hasDirectoryConflicts = review.directory_conflicts.length > 0;
  $: perFileDecisions = !hasDirectoryConflicts && units.length > 0;
  $: capabilities = Object.fromEntries(units.map((unit) => [unit.id, decisionCapabilities(unit, diffs)])) as Record<string, DecisionCapabilities>;
  $: statuses = Object.fromEntries(
    units.map((unit) => [unit.id, unitStatus(unit, fileChoices[unit.id], diffs, lineChoices)])
  ) as Record<string, UnitStatus>;
  $: decidedFileCount = review.files.filter((file) => statuses[unitByPath.get(file.path)?.id ?? '']?.decided).length;
  $: firstUndecided = units.find((unit) => !statuses[unit.id]?.decided) ?? null;
  $: manualErrors = manualPlanErrors(units, fileChoices, manualPathByGroup, manualDeleteByGroup);
  $: reviewResolved = review.conflict.status === 'resolved';
  $: statusLabel = reviewResolved ? 'Synced' : review.stale ? 'Stale review' : 'Review needed';
  $: if (candidateRevision >= 0 && units && contentlessPaths && statuses && manualErrors) {
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
    fileChoices = {};
    directoryChoice = null;
    diffs = Object.fromEntries(review.files.map((file) => [file.path, buildConflictDiff(file)]));
    expandedGaps = {};
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
    draftTouched = false;
  }

  function candidateChanged() {
    candidateRevision += 1;
    draftTouched = true;
  }

  $: onDirtyChange(draftTouched && !reviewResolved);
  onDestroy(() => onDirtyChange(false));

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
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    fileNodes.get(path)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function jumpToSelectedFile(event: Event) {
    scrollToFile((event.currentTarget as HTMLSelectElement).value);
  }

  function jumpToUndecided() {
    const path = firstUndecided?.files[0]?.path;
    if (!path) return;
    scrollToFile(path);
    fileNodes.get(path)?.querySelector<HTMLElement>('.decision-segment button')?.focus({ preventScroll: true });
  }

  function pathGroup(file: ConflictReviewFile): ConflictReviewPath | null {
    return review.path_conflicts.find((group) => group.affected_paths.includes(file.path)) ?? null;
  }

  function choiceOffered(choice: ConflictResolutionKind): boolean {
    return review.choices.includes(choice);
  }

  function hasStructuralChange(group: ConflictReviewPath): boolean {
    return group.base_path !== group.server_path || group.base_path !== group.device_path;
  }

  function groupLabel(group: ConflictReviewPath): string {
    if (group.server_path === group.device_path) return group.base_path ?? group.server_path ?? group.device_path ?? 'Path overlap';
    return `${group.base_path ?? '(new file)'} -> ${group.server_path ?? '(deleted)'} / ${group.device_path ?? '(deleted)'}`;
  }

  function unitLabel(unit: DecisionUnit): string {
    return unit.titleGroup ? groupLabel(unit.titleGroup) : unit.files.length === 1 ? unit.files[0]!.path : unit.paths.join(', ');
  }

  function defaultGroupContent(group: ConflictReviewPath): string {
    const server = group.server_path ? review.files.find((file) => file.path === group.server_path)?.server_content : null;
    const device = group.device_path ? review.files.find((file) => file.path === group.device_path)?.device_content : null;
    return server ?? device ?? '';
  }

  function belongsToTitleGroup(unit: DecisionUnit, path: string): boolean {
    return unit.titleGroup?.affected_paths.includes(path) ?? false;
  }

  function isExtraChoice(choice: FileChoice | undefined): choice is ExtraChoice {
    return choice === 'keep_both_files' || choice === 'insert_both_blocks' || choice === 'manual';
  }

  function setUnitChoice(unitId: string, choice: FileChoice) {
    if (fileChoices[unitId] === choice) return;
    fileChoices = { ...fileChoices, [unitId]: choice };
    candidateChanged();
  }

  function chooseMore(unitId: string, event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === 'keep_both_files' || value === 'insert_both_blocks' || value === 'manual') setUnitChoice(unitId, value);
  }

  function setAllFiles(choice: DirectoryChoice) {
    fileChoices = Object.fromEntries(units.map((unit) => [unit.id, choice]));
    candidateChanged();
  }

  function setDirectoryChoice(choice: DirectoryChoice) {
    if (directoryChoice === choice) return;
    directoryChoice = choice;
    candidateChanged();
  }

  function setLineChoice(path: string, rowId: string, choice: LineResolution) {
    lineChoices = {
      ...lineChoices,
      [path]: { ...(lineChoices[path] ?? {}), [rowId]: choice }
    };
    candidateChanged();
  }

  function chooseAllLines(unit: DecisionUnit, choice: LineResolution) {
    const next = { ...lineChoices };
    for (const file of unit.files) {
      next[file.path] = Object.fromEntries(changedRows(diffs[file.path] ?? []).map((row) => [row.id, choice]));
    }
    lineChoices = next;
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

  function manualPlanErrors(
    decisionUnits: DecisionUnit[],
    choices: Record<string, FileChoice>,
    paths: Record<string, string>,
    deletes: Record<string, boolean>
  ): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const unit of decisionUnits) {
      const group = unit.titleGroup;
      if (choices[unit.id] !== 'manual' || !group) continue;
      const error = validateManualPathTargets(
        review.files.filter((file) => !unit.paths.includes(file.path) && !isAgreedFileDeletion(file)).map((file) => file.path),
        [{ label: groupLabel(group), path: paths[group.group_id] ?? '', deleted: Boolean(deletes[group.group_id]) }]
      );
      if (error) errors[unit.id] = error;
    }
    return errors;
  }

  function decidedPaths(unit: DecisionUnit): string[] {
    return unit.paths.filter((path) => affectedPaths.has(path));
  }

  function unitFilePlan(unit: DecisionUnit, choice: 'lines' | 'manual'): ManualFilePlanEntry[] {
    const plan = new Map<string, string | null>(decidedPaths(unit).map((path) => [path, null]));
    for (const file of unit.files) {
      if (choice === 'lines') {
        plan.set(file.path, resolveConflictFile(file, diffs[file.path] ?? [], lineChoices[file.path] ?? {}));
      } else {
        plan.set(file.path, belongsToTitleGroup(unit, file.path) || isAgreedFileDeletion(file) ? null : manualTextByPath[file.path] ?? '');
      }
    }
    const group = unit.titleGroup;
    if (choice === 'manual' && group && !manualDeleteByGroup[group.group_id]) {
      plan.set((manualPathByGroup[group.group_id] ?? '').trim(), manualContentByGroup[group.group_id] ?? '');
    }
    return [...plan.entries()].map(([path, content]) => ({ path, content }));
  }

  function unitEntry(unit: DecisionUnit, choice: FileChoice): PerFileResolutionEntry {
    if (choice === 'lines' || choice === 'manual') {
      return { paths: decidedPaths(unit), choice: 'manual', manual_file_plan: unitFilePlan(unit, choice) };
    }
    return { paths: decidedPaths(unit), choice };
  }

  function buildSubmission(): ConflictResolutionSubmission | null {
    if (reviewResolved) return null;
    if (hasDirectoryConflicts) return directoryChoice ? { resolutionKind: directoryChoice } : null;
    if (Object.keys(manualErrors).length > 0) return null;
    const entries: PerFileResolutionEntry[] = [];
    for (const unit of units) {
      const choice = fileChoices[unit.id];
      if (!choice || !unitStatus(unit, choice, diffs, lineChoices).decided) return null;
      try {
        entries.push(unitEntry(unit, choice));
      } catch {
        return null;
      }
    }
    return perFileSubmission(entries, contentlessPaths);
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
      case 'manual': return 'Edited final files';
      case 'per_file': return 'Per-file decisions';
    }
  }

  function resultPolicyLabel(): string {
    if (!currentSubmission) return 'Final result';
    if (currentSubmission.resolutionKind === 'per_file' || hasDirectoryConflicts) return choiceLabel(currentSubmission.resolutionKind);
    return `${choiceLabel(currentSubmission.resolutionKind)} for every file`;
  }

  function decisionSummary(): string {
    if (hasDirectoryConflicts) return '';
    const counts = new Map<string, number>();
    for (const unit of units) {
      const label = fileChoiceLabel(fileChoices[unit.id] ?? null);
      counts.set(label, (counts.get(label) ?? 0) + unit.files.length);
    }
    return [...counts.entries()].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(' \u00b7 ');
  }

  function decisionState(status: UnitStatus | undefined): string {
    if (!status?.choice) return 'undecided';
    if (status.choice === 'lines' && !status.decided) return 'partial';
    return status.choice;
  }

  function decisionStateLabel(status: UnitStatus | undefined): string {
    if (!status?.choice) return 'Undecided';
    if (status.choice === 'lines' && !status.decided) return `${status.remainingLines} line${status.remainingLines === 1 ? '' : 's'} left`;
    return fileChoiceLabel(status.choice);
  }

  function expandGap(path: string, gapId: string) {
    expandedGaps = { ...expandedGaps, [path]: { ...(expandedGaps[path] ?? {}), [gapId]: true } };
  }

  function hunkLabel(server: DiffLineRange, device: DiffLineRange): string {
    return `Server main ${formatDiffLineRange(server)} \u2194 Device: ${review.device_name} ${formatDiffLineRange(device)}`;
  }

  function gapLabel(gap: CollapsedDiffGap): string {
    return `Show ${gap.hidden} unchanged line${gap.hidden === 1 ? '' : 's'} (${hunkLabel(gap.server, gap.device)})`;
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
    {:else if !perFileDecisions}
      <div class="decision-progress">
        <span><strong>{directoryChoice ? choiceLabel(directoryChoice) : 'Undecided'}</strong></span>
        <span class="decision-summary">One choice covers the complete conflict package.</span>
      </div>
      <div class="bulk-decision" role="group" aria-label="Outcome for the complete conflict package">
        <span>Whole package</span>
        {#each DIRECTORY_CHOICES as choice}
          <button
            class="secondary"
            class:active={directoryChoice === choice}
            aria-pressed={directoryChoice === choice}
            on:click={() => setDirectoryChoice(choice)}
          >{choice === 'keep_server' ? 'Server' : 'Device'}</button>
        {/each}
      </div>
    {:else}
      <div class="decision-progress" aria-live="polite">
        <span><strong>{decidedFileCount}</strong> of {review.files.length} file{review.files.length === 1 ? '' : 's'} decided</span>
        {#if firstUndecided}
          <button class="link-button" on:click={jumpToUndecided}>Next undecided</button>
        {:else}
          <span class="decision-summary">{decisionSummary()}</span>
        {/if}
      </div>
      <div class="bulk-decision" role="group" aria-label="Set every file to one version">
        <span>Set all files</span>
        <button class="secondary" aria-label="Set all files to Server main" on:click={() => setAllFiles('keep_server')}>Server</button>
        <button class="secondary" aria-label={`Set all files to Device: ${review.device_name}`} on:click={() => setAllFiles('use_device')}>Device</button>
      </div>
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

  {#if previewState.kind === 'error' && previewState.candidateKey === currentCandidateKey}<p class="warning resolution-banner" role="alert">{previewState.message}</p>{/if}

  {#if hasDirectoryConflicts}
    <section class="directory-conflict-panel" aria-label="Directory conflicts">
      <div>
        <p class="eyebrow">Directory state</p>
        <h3>Choose the canonical directory outcome</h3>
        <p>One server or device choice covers the complete package, including every file listed below. The server records the decision. Devices only perform non-recursive, empty-directory-safe materialization.</p>
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
            {@const navStatus = statuses[unitByPath.get(file.path)?.id ?? '']}
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
                {#if perFileDecisions && !reviewResolved}
                  <b class="file-nav-decision" data-state={decisionState(navStatus)}>{decisionStateLabel(navStatus)}</b>
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
              {@const unit = unitByPath.get(file.path)}
              {@const unitChoice = unit ? fileChoices[unit.id] : undefined}
              {@const status = unit ? statuses[unit.id] : undefined}
              {@const caps = unit ? capabilities[unit.id] : undefined}
              {@const leadsUnit = unit?.files[0]?.path === file.path}
              {@const showLineChoices = perFileDecisions && !reviewResolved && unitChoice === 'lines'}
              {@const editing = perFileDecisions && !reviewResolved && unitChoice === 'manual'}
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
                </header>

                {#if perFileDecisions && unit && !reviewResolved}
                  {#if leadsUnit}
                    <div class="file-decision" data-state={decisionState(status)} role="group" aria-label={`Decision for ${unitLabel(unit)}`}>
                      <span class="decision-state" data-state={decisionState(status)}>{decisionStateLabel(status)}</span>
                      <div class="decision-segment">
                        <button
                          class:active={unitChoice === 'keep_server'}
                          aria-pressed={unitChoice === 'keep_server'}
                          aria-label={`Keep Server main for ${unitLabel(unit)}`}
                          on:click={() => setUnitChoice(unit.id, 'keep_server')}
                        >Server</button>
                        <button
                          class:active={unitChoice === 'use_device'}
                          aria-pressed={unitChoice === 'use_device'}
                          aria-label={`Use Device: ${review.device_name} for ${unitLabel(unit)}`}
                          on:click={() => setUnitChoice(unit.id, 'use_device')}
                        >Device</button>
                        <button
                          class:active={unitChoice === 'lines'}
                          aria-pressed={unitChoice === 'lines'}
                          aria-label={`Choose line by line for ${unitLabel(unit)}`}
                          disabled={!caps?.lines || !choiceOffered('manual')}
                          on:click={() => setUnitChoice(unit.id, 'lines')}
                        >Line by line</button>
                      </div>
                      <label class="decision-more">
                        <span class="visually-hidden">Other choices for {unitLabel(unit)}</span>
                        <select class:active={isExtraChoice(unitChoice)} value={isExtraChoice(unitChoice) ? unitChoice : ''} on:change={(event) => chooseMore(unit.id, event)}>
                          <option value="" disabled>More...</option>
                          <option value="keep_both_files" disabled={!choiceOffered('keep_both_files')}>Keep both copies</option>
                          <option value="insert_both_blocks" disabled={!caps?.insertBoth || !choiceOffered('insert_both_blocks')}>Insert both blocks</option>
                          <option value="manual" disabled={!caps?.edit || !choiceOffered('manual')}>Edit final content</option>
                        </select>
                      </label>
                      {#if unitChoice === 'lines'}
                        <div class="file-bulk-actions" role="group" aria-label={`Choose every changed line in ${unitLabel(unit)}`}>
                          <span>All lines</span>
                          <button class="secondary" on:click={() => chooseAllLines(unit, 'server')}>Server</button>
                          <button class="secondary" on:click={() => chooseAllLines(unit, 'device')}>Device</button>
                          <button class="secondary" on:click={() => chooseAllLines(unit, 'both')}>Both</button>
                        </div>
                      {/if}
                      {#if unit.files.length > 1}
                        <p class="decision-note">
                          Decided together with {unit.files.slice(1).map((linked) => linked.path).join(', ')}: a rename or overlapping path links them.
                        </p>
                      {/if}
                      {#if caps && !caps.lines && caps.reason}<p class="decision-note">{caps.reason}</p>{/if}
                    </div>
                  {:else}
                    <p class="decision-linked">
                      Decided with <code>{unit.files[0]?.path}</code>: <strong>{decisionStateLabel(status)}</strong>
                    </p>
                  {/if}
                {/if}

                {#if editing && leadsUnit && unit?.titleGroup}
                  {@const titleGroup = unit.titleGroup}
                  <section class="structure-editor">
                    <strong>Final path for {groupLabel(titleGroup)}</strong>
                    <p class="muted">Divergent renames require an explicit final path and complete content.</p>
                    <label class="checkbox-label">
                      <input type="checkbox" checked={manualDeleteByGroup[titleGroup.group_id] ?? false} on:change={(event) => updateManualDelete(titleGroup.group_id, event)} />
                      Delete this path group in the final result
                    </label>
                    {#if !manualDeleteByGroup[titleGroup.group_id]}
                      <label>
                        Final path
                        <input value={manualPathByGroup[titleGroup.group_id] ?? ''} on:input={(event) => updateManualPath(titleGroup.group_id, event)} />
                      </label>
                      <label>
                        Final content
                        <textarea value={manualContentByGroup[titleGroup.group_id] ?? ''} on:input={(event) => updateManualGroupContent(titleGroup.group_id, event)}></textarea>
                      </label>
                    {/if}
                    {#if manualErrors[unit.id]}<p class="warning" role="alert">{manualErrors[unit.id]}</p>{/if}
                  </section>
                {/if}

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
                        ? 'Choose server, device, or keep both copies for this file. obts preserves the original bytes.'
                        : 'This file exceeds the interactive diff limit. Choose server, device, keep both, or insert both so the dashboard does not freeze or truncate content.'}
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
                    {#each collapseConflictDiff(rows, expandedGaps[file.path]) as row (row.id)}
                      {#if row.kind === 'hunk'}
                        <div class="diff-hunk-header" class:has-gap={row.gap !== null}>
                          {#if row.gap}
                            {@const gap = row.gap}
                            <button class="diff-expand" title={gapLabel(gap)} aria-label={gapLabel(gap)} on:click={() => expandGap(file.path, gap.id)}>
                              <Icon name="expand" size={16} />
                            </button>
                          {:else}
                            <span class="line-number">...</span><span class="line-number">...</span>
                          {/if}
                          <code>{#if row.lines}<span class="diff-hunk-range">@@ {hunkLabel(row.lines.server, row.lines.device)} @@</span>{/if}{#if row.gap}<span class="diff-gap-note">{row.gap.hidden} unchanged line{row.gap.hidden === 1 ? '' : 's'} hidden</span>{/if}</code>
                        </div>
                      {:else if row.kind === 'context'}
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
                          {#if showLineChoices}
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

                {/if}

                {#if editing && unit && file.content_kind === 'text' && !belongsToTitleGroup(unit, file.path) && !isAgreedFileDeletion(file)}
                  <label class="manual-file-editor">
                    Complete final content for {file.path}
                    <textarea value={manualTextByPath[file.path] ?? ''} on:input={(event) => updateManualText(file.path, event)}></textarea>
                  </label>
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
              {#if currentSubmission?.resolutionKind === 'per_file'}<p class="result-scope">{decisionSummary()}</p>{/if}
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
