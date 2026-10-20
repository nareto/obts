import { describe, expect, it } from 'vitest';

import { buildConflictDiff, changedRows } from '../frontend/dashboard/src/conflictDiff.js';
import {
  buildDecisionUnits,
  decisionCapabilities,
  perFileSubmission,
  unitStatus
} from '../frontend/dashboard/src/conflictDecisions.js';
import type { ConflictReviewFile, ConflictReviewPath } from '../frontend/dashboard/src/api/types.js';

describe('per-file conflict decisions', () => {
  it('decides independent files separately and linked rename paths together', () => {
    const files = [
      textFile('Plain.md', 'server\n', 'device\n'),
      textFile('Old.md', null, null),
      textFile('Title A.md', 'a\n', null),
      textFile('Title B.md', null, 'b\n'),
      textFile('Folder', 'file\n', null),
      textFile('Folder/Child.md', null, 'child\n')
    ];
    const rename = renameGroup('rename', 'Old.md', 'Title A.md', 'Title B.md');
    const units = buildDecisionUnits(files, [rename], [...files.map((file) => file.path), 'Missing.md']);

    expect(units.map((unit) => unit.paths)).toEqual([
      ['Plain.md'],
      ['Old.md', 'Title A.md', 'Title B.md'],
      ['Folder', 'Folder/Child.md'],
      ['Missing.md']
    ]);
    expect(units[1]?.titleGroup).toBe(rename);
    expect(units[0]?.titleGroup).toBeNull();
    expect(units[3]?.files).toEqual([]);
  });

  it('offers line choices only where the unit content allows them', () => {
    const text = textFile('Text.md', 'one\n', 'two\n');
    const binary = { ...textFile('Image.png', null, null), content_kind: 'binary' as const };
    const large = { ...textFile('Large.md', null, null), content_kind: 'large_text' as const };
    const emptyAdd = textFile('Empty.md', '', null);
    const files = [text, binary, large, emptyAdd];
    const diffs = Object.fromEntries(files.map((file) => [file.path, buildConflictDiff(file)]));
    const units = buildDecisionUnits(files, [], files.map((file) => file.path));
    const capabilities = units.map((unit) => decisionCapabilities(unit, diffs));

    expect(capabilities[0]).toEqual({ lines: true, insertBoth: true, edit: true, reason: '' });
    expect(capabilities[1]).toMatchObject({ lines: false, insertBoth: false, edit: false });
    expect(capabilities[1]?.reason).toContain('Binary');
    expect(capabilities[2]).toMatchObject({ lines: false, insertBoth: true, edit: false });
    expect(capabilities[3]).toMatchObject({ lines: false, insertBoth: true, edit: true });
  });

  it('counts a line-by-line unit as decided only once every changed line has a choice', () => {
    const file = textFile('Text.md', 'a\nserver one\nb\nserver two\n', 'a\ndevice one\nb\ndevice two\n');
    const diffs = { [file.path]: buildConflictDiff(file) };
    const [unit] = buildDecisionUnits([file], [], [file.path]);
    const [first] = changedRows(diffs[file.path]!);

    expect(unitStatus(unit!, undefined, diffs, {})).toEqual({ choice: null, decided: false, remainingLines: 0 });
    expect(unitStatus(unit!, 'keep_server', diffs, {})).toMatchObject({ decided: true });
    expect(unitStatus(unit!, 'lines', diffs, { [file.path]: { [first!.id]: 'device' } })).toEqual({
      choice: 'lines',
      decided: false,
      remainingLines: 1
    });
  });

  it('collapses uniform whole-file choices and keeps mixed choices per file', () => {
    expect(perFileSubmission([])).toBeNull();
    expect(
      perFileSubmission([
        { paths: ['a.md'], choice: 'use_device' },
        { paths: ['b.md'], choice: 'use_device' }
      ], ['gone.md'])
    ).toEqual({ resolutionKind: 'use_device' });
    expect(perFileSubmission([{ paths: ['a.md'], choice: 'manual', manual_file_plan: [{ path: 'a.md', content: 'x' }] }])).toEqual({
      resolutionKind: 'per_file',
      perFile: [{ paths: ['a.md'], choice: 'manual', manual_file_plan: [{ path: 'a.md', content: 'x' }] }]
    });
    expect(
      perFileSubmission([
        { paths: ['a.md'], choice: 'keep_server' },
        { paths: ['b.md'], choice: 'keep_both_files' }
      ], ['gone.md'])
    ).toEqual({
      resolutionKind: 'per_file',
      perFile: [
        { paths: ['a.md'], choice: 'keep_server' },
        { paths: ['b.md'], choice: 'keep_both_files' },
        { paths: ['gone.md'], choice: 'keep_server' }
      ]
    });
  });
});

function renameGroup(groupId: string, base: string, server: string, device: string): ConflictReviewPath {
  return {
    group_id: groupId,
    kind: 'rename_rename',
    base_path: base,
    server_path: server,
    device_path: device,
    server_operation: 'renamed',
    device_operation: 'renamed',
    affected_paths: [base, server, device]
  };
}

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
