import { describe, expect, it } from 'vitest';

import {
  buildConflictDiff,
  changedRows,
  choicesForAllRows,
  collapseConflictDiff,
  formatDiffLineRange,
  hasDivergentFinalPaths,
  isAgreedFileDeletion,
  previewOutcomeLabel,
  previewProvenanceLabel,
  resolveConflictFile,
  submissionCandidateKey,
  unresolvedLineCount,
  validateManualPathTargets
} from '../frontend/dashboard/src/conflictDiff.js';
import type { ConflictPreviewFile, ConflictResolutionSubmission, ConflictReviewFile } from '../frontend/dashboard/src/api/types.js';

describe('conflict diff workbench', () => {
  it('builds line-addressable changes with word-level emphasis and reconstructs mixed choices', () => {
    const file = textFile('notes/example.md', 'title\nserver first\nserver second\ntail\n', 'title\ndevice first\ndevice second\ntail\n');
    const rows = buildConflictDiff(file);
    const changes = changedRows(rows);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ serverLine: 2, deviceLine: 2, serverText: 'server first\n', deviceText: 'device first\n' });
    expect(changes[0]?.serverTokens.some((token) => token.changed && token.text.includes('server'))).toBe(true);
    expect(changes[0]?.deviceTokens.some((token) => token.changed && token.text.includes('device'))).toBe(true);

    const resolved = resolveConflictFile(file, rows, {
      [changes[0]!.id]: 'server',
      [changes[1]!.id]: 'device'
    });
    expect(resolved).toBe('title\nserver first\ndevice second\ntail\n');
  });

  it('preserves additions, deletions, both-line choices, and final newlines', () => {
    const file = textFile('notes/example.md', 'one\nremoved\n', 'one\nadded\nextra\n');
    const rows = buildConflictDiff(file);
    const changes = changedRows(rows);
    expect(changes).toHaveLength(2);

    expect(resolveConflictFile(file, rows, {
      [changes[0]!.id]: 'both',
      [changes[1]!.id]: 'device'
    })).toBe('one\nremoved\nadded\nextra\n');
  });

  it('requires every changed line and can bulk-select an entire review', () => {
    const first = textFile('one.md', 'server\n', 'device\n');
    const second = textFile('two.md', 'left\n', 'right\n');
    const diffs = {
      [first.path]: buildConflictDiff(first),
      [second.path]: buildConflictDiff(second)
    };

    expect(unresolvedLineCount(diffs, {})).toBe(2);
    const choices = choicesForAllRows(diffs, 'device');
    expect(unresolvedLineCount(diffs, choices)).toBe(0);
    expect(resolveConflictFile(first, diffs[first.path]!, choices[first.path]!)).toBe('device\n');
  });

  it('collapses long unchanged runs into expandable hunks while keeping row ids and line numbers', () => {
    const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');
    const file = textFile(
      'long.md',
      `${lines(20, 'head')}server first\n${lines(30, 'body')}server second\n${lines(10, 'tail')}`,
      `${lines(20, 'head')}device first\n${lines(30, 'body')}device second\nextra device\n${lines(10, 'tail')}`
    );
    const rows = buildConflictDiff(file);
    const items = collapseConflictDiff(rows);
    const hunks = items.filter((item) => item.kind === 'hunk');
    const shown = items.filter((item) => item.kind !== 'hunk');

    expect(hunks).toHaveLength(3);
    expect(hunks[0]).toMatchObject({ gap: { hidden: 17, server: { start: 1, count: 17 } }, lines: { server: { start: 18, count: 7 }, device: { start: 18, count: 7 } } });
    expect(hunks[1]).toMatchObject({ gap: { hidden: 24, server: { start: 25, count: 24 }, device: { start: 25, count: 24 } }, lines: { server: { start: 49, count: 7 }, device: { start: 49, count: 8 } } });
    expect(hunks[2]).toMatchObject({ gap: { hidden: 7, server: { start: 56, count: 7 }, device: { start: 57, count: 7 } }, lines: null });
    expect(shown.every((row) => rows.includes(row as (typeof rows)[number]))).toBe(true);
    expect(changedRows(shown as typeof rows)).toEqual(changedRows(rows));
    expect(shown.find((row) => row.kind === 'context')).toMatchObject({ serverLine: 18, deviceLine: 18, text: 'head 18\n' });

    const expanded = collapseConflictDiff(rows, { [hunks[0]!.gap!.id]: true });
    expect(expanded.filter((item) => item.kind !== 'hunk')).toHaveLength(shown.length + 17);
    expect(expanded[0]).toMatchObject({ kind: 'hunk', gap: null, lines: { server: { start: 1, count: 24 } } });
    expect(collapseConflictDiff(rows, Object.fromEntries(hunks.map((hunk) => [hunk.gap!.id, true]))).filter((item) => item.kind !== 'hunk')).toEqual(rows);
  });

  it('keeps short unchanged runs inline instead of hiding a handful of lines', () => {
    const file = textFile('short.md', 'a\nb\nc\nserver\nd\ne\nf\ng\nh\ni\nserver again\nj\n', 'a\nb\nc\ndevice\nd\ne\nf\ng\nh\ni\ndevice again\nj\n');
    const rows = buildConflictDiff(file);
    const items = collapseConflictDiff(rows);

    expect(items[0]).toMatchObject({ kind: 'hunk', gap: null, lines: { server: { start: 1, count: 12 } } });
    expect(items.slice(1)).toEqual(rows);
    expect(formatDiffLineRange({ start: 4, count: 1 })).toBe('line 4');
    expect(formatDiffLineRange({ start: 4, count: 0 })).toBe('no lines');
    expect(formatDiffLineRange({ start: 4, count: 3 })).toBe('lines 4\u20136');
  });

  it('distinguishes an absent side from an empty text file', () => {
    const deleted = textFile('deleted.md', 'server content\n', null);
    const rows = buildConflictDiff(deleted);
    const changes = changedRows(rows);

    expect(resolveConflictFile(deleted, rows, { [changes[0]!.id]: 'device' })).toBeNull();
    expect(resolveConflictFile(deleted, rows, { [changes[0]!.id]: 'server' })).toBe('server content\n');

    const emptyOnBoth = textFile('empty.md', '', '');
    expect(resolveConflictFile(emptyOnBoth, buildConflictDiff(emptyOnBoth), {})).toBe('');

    const emptyServer = textFile('empty-server.md', '', 'device content\n');
    const emptyServerRows = buildConflictDiff(emptyServer);
    const emptyServerChange = changedRows(emptyServerRows)[0]!;
    expect(resolveConflictFile(emptyServer, emptyServerRows, { [emptyServerChange.id]: 'server' })).toBe('');
  });

  it('keeps agreed deletions distinct from binary files whose text fields are intentionally absent', () => {
    expect(isAgreedFileDeletion(textFile('old.md', null, null))).toBe(true);
    expect(isAgreedFileDeletion({
      ...textFile('asset.bin', null, null),
      content_kind: 'binary',
      server_bytes: 4,
      device_bytes: 4
    })).toBe(false);
  });

  it('rejects empty and duplicate manual path targets unless deletion is explicit', () => {
    expect(validateManualPathTargets([], [{ label: 'rename group', path: '', deleted: false }])).toContain('Choose a final path');
    expect(validateManualPathTargets(['existing.md'], [{ label: 'rename group', path: 'existing.md', deleted: false }])).toContain('selected more than once');
    expect(validateManualPathTargets([], [
      { label: 'first', path: 'same.md', deleted: false },
      { label: 'second', path: 'same.md', deleted: false }
    ])).toContain('selected more than once');
    expect(validateManualPathTargets([], [{ label: 'rename group', path: '', deleted: true }])).toBe('');
  });

  it('does not mistake concurrent additions to the same final path for a title conflict', () => {
    expect(hasDivergentFinalPaths({
      group_id: 'a'.repeat(20),
      kind: 'path_overlap',
      base_path: null,
      server_path: 'shared.md',
      device_path: 'shared.md',
      server_operation: 'added',
      device_operation: 'added',
      affected_paths: ['shared.md']
    })).toBe(false);
    expect(hasDivergentFinalPaths({
      group_id: 'b'.repeat(20),
      kind: 'rename_rename',
      base_path: 'old.md',
      server_path: 'server.md',
      device_path: 'device.md',
      server_operation: 'renamed',
      device_operation: 'renamed',
      affected_paths: ['old.md', 'server.md', 'device.md']
    })).toBe(true);
  });

  it('refuses to turn binary review metadata into text', () => {
    const file: ConflictReviewFile = {
      ...textFile('asset.bin', null, null),
      content_kind: 'binary',
      server_bytes: 4,
      device_bytes: 4
    };
    expect(buildConflictDiff(file)).toEqual([]);
    expect(() => resolveConflictFile(file, [], {})).toThrow('Binary files cannot be resolved as text.');
  });

  it('keys a resolution candidate by policy and content so any edit invalidates it', () => {
    const base: ConflictResolutionSubmission = { resolutionKind: 'manual', manualFiles: { 'b.md': 'two\n', 'a.md': 'one\n' } };
    expect(submissionCandidateKey(base)).toBe(
      submissionCandidateKey({ resolutionKind: 'manual', manualFiles: { 'a.md': 'one\n', 'b.md': 'two\n' } })
    );
    expect(submissionCandidateKey(base)).not.toBe(
      submissionCandidateKey({ resolutionKind: 'manual', manualFiles: { 'a.md': 'one\n', 'b.md': 'edited\n' } })
    );
    expect(submissionCandidateKey(base)).not.toBe(submissionCandidateKey({ resolutionKind: 'keep_server' }));
    expect(submissionCandidateKey({ resolutionKind: 'manual', manualFilePlan: [{ path: 'new.md', content: 'x' }] })).not.toBe(
      submissionCandidateKey({ resolutionKind: 'manual', manualFilePlan: [{ path: 'new.md', content: 'y' }] })
    );
    expect(submissionCandidateKey({ resolutionKind: 'per_file', perFile: [{ paths: ['a.md'], choice: 'keep_server' }] })).not.toBe(
      submissionCandidateKey({ resolutionKind: 'per_file', perFile: [{ paths: ['a.md'], choice: 'use_device' }] })
    );
  });

  it('labels final outcomes and provenance in text rather than color', () => {
    const file = (overrides: Partial<ConflictPreviewFile>): ConflictPreviewFile => ({
      path: 'notes/a.md',
      operation: 'updated',
      provenance: 'device',
      source_path: null,
      content_kind: 'text',
      content: 'x\n',
      bytes: 2,
      sha256: null,
      ...overrides
    });
    expect(previewOutcomeLabel(file({ operation: 'deleted' }))).toBe('Deleted');
    expect(previewOutcomeLabel(file({ operation: 'copied' }))).toBe('Device copy');
    expect(previewProvenanceLabel(file({ provenance: 'server' }), 'Tablet')).toBe('Server main');
    expect(previewProvenanceLabel(file({ provenance: 'device' }), 'Tablet')).toBe('Device: Tablet');
    expect(previewProvenanceLabel(file({ provenance: 'both' }), 'Tablet')).toContain('Tablet');
  });
});

function textFile(path: string, server: string | null, device: string | null): ConflictReviewFile {
  return {
    path,
    content_kind: 'text',
    base_content: null,
    server_content: server,
    device_content: device,
    base_bytes: null,
    server_bytes: server === null ? null : Buffer.byteLength(server),
    device_bytes: device === null ? null : Buffer.byteLength(device),
    base_sha256: null,
    server_sha256: null,
    device_sha256: null,
    source_diff: '',
    rendered_markdown_diff: null
  };
}
