import { changedRows, hasDivergentFinalPaths, type ConflictDiffRow, type LineResolution } from './conflictDiff.js';
import type {
  ConflictResolutionSubmission,
  ConflictReviewFile,
  ConflictReviewPath,
  PerFileResolutionEntry
} from './api/types.js';

export type FileChoice = 'keep_server' | 'use_device' | 'lines' | 'keep_both_files' | 'insert_both_blocks' | 'manual';

export type DecisionUnit = {
  id: string;
  paths: string[];
  files: ConflictReviewFile[];
  titleGroup: ConflictReviewPath | null;
};

export type DecisionCapabilities = {
  lines: boolean;
  insertBoth: boolean;
  edit: boolean;
  reason: string;
};

export type UnitStatus = {
  choice: FileChoice | null;
  decided: boolean;
  remainingLines: number;
};

/**
 * Partitions the affected paths into the units the server accepts as one per-file decision: paths that a review
 * group links, or whose paths overlap as file and directory, are always decided together. A unit without content
 * holds paths absent from every compared tree.
 */
export function buildDecisionUnits(
  files: ConflictReviewFile[],
  pathConflicts: ConflictReviewPath[],
  affectedPaths: string[]
): DecisionUnit[] {
  const order = new Map(files.map((file, index) => [file.path, index]));
  const parent = new Map<string, string>();
  const find = (path: string): string => {
    let root = path;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(path, root);
    return root;
  };
  const add = (path: string) => {
    if (!parent.has(path)) parent.set(path, path);
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const path of affectedPaths) add(path);
  for (const file of files) add(file.path);
  for (const group of pathConflicts) {
    group.affected_paths.forEach(add);
    for (const path of group.affected_paths.slice(1)) union(group.affected_paths[0]!, path);
  }
  const paths = [...parent.keys()];
  for (const path of paths) {
    for (const other of paths) {
      if (other !== path && other.startsWith(`${path}/`)) union(path, other);
    }
  }
  const members = new Map<string, string[]>();
  for (const path of paths) {
    const root = find(path);
    members.set(root, [...(members.get(root) ?? []), path]);
  }
  const position = (path: string) => order.get(path) ?? Number.MAX_SAFE_INTEGER;
  return [...members.values()]
    .map((unitPaths) => {
      const sorted = [...unitPaths].sort((left, right) => position(left) - position(right) || left.localeCompare(right));
      const groups = pathConflicts.filter((group) => group.affected_paths.some((path) => unitPaths.includes(path)));
      return {
        id: sorted[0]!,
        paths: sorted,
        files: sorted.flatMap((path) => files.filter((file) => file.path === path)),
        titleGroup: groups.find(hasDivergentFinalPaths) ?? null
      };
    })
    .sort((left, right) => position(left.id) - position(right.id) || left.id.localeCompare(right.id));
}

export function decisionCapabilities(unit: DecisionUnit, diffs: Record<string, ConflictDiffRow[]>): DecisionCapabilities {
  const binary = unit.files.some((file) => file.content_kind === 'binary');
  const large = unit.files.some((file) => file.content_kind === 'large_text');
  const unlineable = unit.files.some(
    (file) => file.content_kind === 'text' && changedRows(diffs[file.path] ?? []).length === 0 && file.server_content !== file.device_content
  );
  const hasChanges = unit.files.some((file) => changedRows(diffs[file.path] ?? []).length > 0);
  const reason = binary
    ? 'Binary content keeps whole-file choices so its bytes stay intact.'
    : large
      ? 'Large text keeps whole-file choices so the dashboard does not truncate it.'
      : unit.titleGroup
        ? 'Divergent renames need a final path, so choose a side, keep both, or edit.'
        : unlineable
          ? 'An empty-file add or delete has no lines to choose.'
          : !hasChanges
            ? 'Server and device text are identical.'
            : '';
  return {
    lines: !binary && !large && !unit.titleGroup && !unlineable && hasChanges,
    insertBoth: !binary,
    edit: !binary && !large,
    reason
  };
}

export function unitStatus(
  unit: DecisionUnit,
  choice: FileChoice | undefined,
  diffs: Record<string, ConflictDiffRow[]>,
  lineChoices: Record<string, Record<string, LineResolution>>
): UnitStatus {
  if (!choice) return { choice: null, decided: false, remainingLines: 0 };
  if (choice !== 'lines') return { choice, decided: true, remainingLines: 0 };
  const remainingLines = unit.files.reduce(
    (total, file) => total + changedRows(diffs[file.path] ?? []).filter((row) => !lineChoices[file.path]?.[row.id]).length,
    0
  );
  return { choice, decided: remainingLines === 0, remainingLines };
}

export function fileChoiceLabel(choice: FileChoice | null): string {
  switch (choice) {
    case 'keep_server': return 'Server';
    case 'use_device': return 'Device';
    case 'lines': return 'Line by line';
    case 'keep_both_files': return 'Keep both copies';
    case 'insert_both_blocks': return 'Insert both blocks';
    case 'manual': return 'Edited';
    case null: return 'Undecided';
  }
}

/**
 * Sends one whole-package kind when every file shares it, so a uniform choice keeps the established request shape.
 * Paths without content in any compared tree have no outcome to choose and are kept as the server has them.
 */
export function perFileSubmission(
  entries: PerFileResolutionEntry[],
  contentlessPaths: string[] = []
): ConflictResolutionSubmission | null {
  if (entries.length === 0) return null;
  const first = entries[0]!.choice;
  if (first !== 'manual' && entries.every((entry) => entry.choice === first)) return { resolutionKind: first };
  return {
    resolutionKind: 'per_file',
    perFile: [
      ...entries.map((entry) => ({ ...entry, paths: [...entry.paths] })),
      ...(contentlessPaths.length > 0 ? [{ paths: [...contentlessPaths], choice: 'keep_server' as const }] : [])
    ]
  };
}
