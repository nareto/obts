import { diffLines, diffWordsWithSpace } from 'diff';

import type { ConflictPreviewFile, ConflictResolutionSubmission, ConflictReviewFile, ConflictReviewPath } from './api/types.js';

export type LineResolution = 'server' | 'device' | 'both';

export type DiffToken = {
  text: string;
  changed: boolean;
};

export type ManualPathTarget = {
  label: string;
  path: string;
  deleted: boolean;
};

export type ConflictDiffRow =
  | {
      kind: 'context';
      id: string;
      serverLine: number;
      deviceLine: number;
      text: string;
    }
  | {
      kind: 'change';
      id: string;
      serverLine: number | null;
      deviceLine: number | null;
      serverText: string | null;
      deviceText: string | null;
      serverTokens: DiffToken[];
      deviceTokens: DiffToken[];
    };

export const DIFF_CONTEXT_LINES = 3;
const MIN_COLLAPSED_LINES = 4;

export type DiffLineRange = {
  start: number;
  count: number;
};

export type CollapsedDiffGap = {
  id: string;
  hidden: number;
  server: DiffLineRange;
  device: DiffLineRange;
};

export type ConflictDiffDisplayItem =
  | ConflictDiffRow
  | {
      kind: 'hunk';
      id: string;
      gap: CollapsedDiffGap | null;
      lines: { server: DiffLineRange; device: DiffLineRange } | null;
    };

export function hasDivergentFinalPaths(group: ConflictReviewPath): boolean {
  return group.server_path !== group.device_path;
}

export function isAgreedFileDeletion(file: ConflictReviewFile): boolean {
  return file.server_content === null && file.device_content === null && file.server_bytes === null && file.device_bytes === null;
}

export function validateManualPathTargets(existingPaths: string[], groups: ManualPathTarget[]): string {
  const targets = new Set(existingPaths);
  for (const group of groups) {
    if (group.deleted) continue;
    const path = group.path.trim();
    if (!path) return `Choose a final path or explicitly delete ${group.label}.`;
    if (targets.has(path)) return `Final path ${path} is selected more than once.`;
    targets.add(path);
  }
  return '';
}

export function buildConflictDiff(file: ConflictReviewFile): ConflictDiffRow[] {
  if (file.content_kind !== 'text') return [];
  const server = file.server_content ?? '';
  const device = file.device_content ?? '';
  const parts = diffLines(server, device);
  const rows: ConflictDiffRow[] = [];
  let serverLine = 1;
  let deviceLine = 1;
  let contextIndex = 0;
  let changeIndex = 0;

  for (let index = 0; index < parts.length; ) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      for (const text of splitLines(part.value)) {
        rows.push({ kind: 'context', id: `context-${contextIndex++}`, serverLine, deviceLine, text });
        serverLine += 1;
        deviceLine += 1;
      }
      index += 1;
      continue;
    }

    const serverLines: string[] = [];
    const deviceLines: string[] = [];
    while (index < parts.length && (parts[index]!.added || parts[index]!.removed)) {
      const changed = parts[index]!;
      if (changed.removed) serverLines.push(...splitLines(changed.value));
      if (changed.added) deviceLines.push(...splitLines(changed.value));
      index += 1;
    }
    const count = Math.max(serverLines.length, deviceLines.length);
    for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
      const serverText = serverLines[rowIndex] ?? null;
      const deviceText = deviceLines[rowIndex] ?? null;
      const wordDiff = wordTokens(serverText, deviceText);
      rows.push({
        kind: 'change',
        id: `change-${changeIndex++}`,
        serverLine: serverText === null ? null : serverLine++,
        deviceLine: deviceText === null ? null : deviceLine++,
        serverText,
        deviceText,
        serverTokens: wordDiff.server,
        deviceTokens: wordDiff.device
      });
    }
  }
  return rows;
}

export function collapseConflictDiff(
  rows: ConflictDiffRow[],
  expandedGaps: Readonly<Record<string, boolean>> = {},
  context = DIFF_CONTEXT_LINES
): ConflictDiffDisplayItem[] {
  const visible = rows.map((row) => row.kind === 'change');
  rows.forEach((row, index) => {
    if (row.kind !== 'change') return;
    for (let offset = Math.max(0, index - context); offset <= Math.min(rows.length - 1, index + context); offset += 1) {
      visible[offset] = true;
    }
  });

  const gaps = new Map<number, CollapsedDiffGap>();
  for (let start = 0; start < rows.length; ) {
    if (visible[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < rows.length && !visible[end + 1]) end += 1;
    const hidden = rows.slice(start, end + 1);
    const id = `gap-${rows[start]!.id}`;
    if (hidden.length < MIN_COLLAPSED_LINES || expandedGaps[id]) {
      for (let index = start; index <= end; index += 1) visible[index] = true;
    } else {
      gaps.set(start, { id, hidden: hidden.length, server: lineRange(hidden, 'serverLine'), device: lineRange(hidden, 'deviceLine') });
    }
    start = end + 1;
  }

  const items: ConflictDiffDisplayItem[] = [];
  let pendingGap: CollapsedDiffGap | null = null;
  for (let index = 0; index < rows.length; ) {
    const gap = gaps.get(index);
    if (gap) {
      pendingGap = gap;
      index += gap.hidden;
      continue;
    }
    let end = index;
    while (end + 1 < rows.length && !gaps.has(end + 1)) end += 1;
    const hunkRows = rows.slice(index, end + 1);
    items.push({
      kind: 'hunk',
      id: `hunk-${hunkRows[0]!.id}`,
      gap: pendingGap,
      lines: { server: lineRange(hunkRows, 'serverLine'), device: lineRange(hunkRows, 'deviceLine') }
    });
    items.push(...hunkRows);
    pendingGap = null;
    index = end + 1;
  }
  if (pendingGap) items.push({ kind: 'hunk', id: `trailing-${pendingGap.id}`, gap: pendingGap, lines: null });
  return items;
}

export function formatDiffLineRange(range: DiffLineRange): string {
  if (range.count === 0) return 'no lines';
  if (range.count === 1) return `line ${range.start}`;
  return `lines ${range.start}\u2013${range.start + range.count - 1}`;
}

function lineRange(rows: ConflictDiffRow[], side: 'serverLine' | 'deviceLine'): DiffLineRange {
  const lines = rows.map((row) => row[side]).filter((line): line is number => line !== null);
  return { start: lines[0] ?? 0, count: lines.length };
}

export function changedRows(rows: ConflictDiffRow[]): Array<Extract<ConflictDiffRow, { kind: 'change' }>> {
  return rows.filter((row): row is Extract<ConflictDiffRow, { kind: 'change' }> => row.kind === 'change');
}

export function resolveConflictFile(
  file: ConflictReviewFile,
  rows: ConflictDiffRow[],
  choices: Record<string, LineResolution>
): string | null {
  if (file.content_kind !== 'text') throw new Error('Binary files cannot be resolved as text.');
  const changes = changedRows(rows);
  if (changes.length === 0) {
    if (file.server_content === file.device_content) return file.server_content;
    throw new Error(`A whole-file choice is required for ${file.path}.`);
  }
  const unresolved = changes.find((row) => !choices[row.id]);
  if (unresolved) throw new Error(`Every changed line in ${file.path} requires a choice.`);

  let output = '';
  let selectedPresentContent = false;
  for (const row of rows) {
    if (row.kind === 'context') {
      output += row.text;
      selectedPresentContent = true;
      continue;
    }
    const choice = choices[row.id]!;
    if (choice === 'server' || choice === 'both') {
      if (file.server_content !== null) selectedPresentContent = true;
      if (row.serverText !== null) output += row.serverText;
    }
    if (choice === 'device' || choice === 'both') {
      if (file.device_content !== null) selectedPresentContent = true;
      if (row.deviceText !== null) output += row.deviceText;
    }
  }
  return selectedPresentContent ? output : null;
}

export function unresolvedLineCount(
  diffs: Record<string, ConflictDiffRow[]>,
  choices: Record<string, Record<string, LineResolution>>
): number {
  return Object.entries(diffs).reduce(
    (count, [path, rows]) => count + changedRows(rows).filter((row) => !choices[path]?.[row.id]).length,
    0
  );
}

export function submissionCandidateKey(submission: ConflictResolutionSubmission): string {
  return JSON.stringify({
    resolution_kind: submission.resolutionKind,
    manual_files: submission.manualFiles
      ? Object.fromEntries(Object.entries(submission.manualFiles).sort(([left], [right]) => left.localeCompare(right)))
      : null,
    manual_file_plan: submission.manualFilePlan ?? null,
    per_file: submission.perFile ?? null
  });
}

export function previewOutcomeLabel(file: ConflictPreviewFile): string {
  switch (file.operation) {
    case 'retained': return 'Retained';
    case 'updated': return 'Updated';
    case 'added': return 'Added';
    case 'copied': return 'Device copy';
    case 'deleted': return 'Deleted';
  }
}

export function previewProvenanceLabel(file: ConflictPreviewFile, deviceName: string): string {
  switch (file.provenance) {
    case 'server': return 'Server main';
    case 'device': return `Device: ${deviceName}`;
    case 'both': return `Server main + Device: ${deviceName}`;
    case 'manual': return 'Manual final content';
  }
}

export function choicesForAllRows(
  diffs: Record<string, ConflictDiffRow[]>,
  choice: LineResolution
): Record<string, Record<string, LineResolution>> {
  return Object.fromEntries(
    Object.entries(diffs).map(([path, rows]) => [
      path,
      Object.fromEntries(changedRows(rows).map((row) => [row.id, choice]))
    ])
  );
}

function wordTokens(serverText: string | null, deviceText: string | null): { server: DiffToken[]; device: DiffToken[] } {
  const server = stripLineEnding(serverText ?? '');
  const device = stripLineEnding(deviceText ?? '');
  const parts = diffWordsWithSpace(server, device);
  return {
    server: parts.filter((part) => !part.added).map((part) => ({ text: part.value, changed: Boolean(part.removed) })),
    device: parts.filter((part) => !part.removed).map((part) => ({ text: part.value, changed: Boolean(part.added) }))
  };
}

function splitLines(value: string): string[] {
  if (!value) return [];
  return value.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? [];
}

function stripLineEnding(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)$/u, '');
}
