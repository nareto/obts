import { describe, expect, it } from 'vitest';

import { mergeLatestTimestampFrontmatter, validateMetadataConflictRules } from '../src/server/frontmatterTimestampMerge.js';

const updatedRule = [{ field: 'updated', strategy: 'latest_timestamp' as const }];

function note(updated: string, body = 'body\n', prefix = ''): string {
  return `---\n${prefix}updated: ${updated}\n---\n${body}`;
}

describe('frontmatter timestamp merge', () => {
  it('selects the newer explicit-offset timestamp and preserves source formatting', () => {
    const server = '---\r\ntitle: Note\r\nupdated: "2026-01-01T00:00:00.1Z" # keep this comment\r\n---\r\nbody\r\n';
    const device = '---\r\ntitle: Note\r\nupdated: "2025-12-31T19:00:00.200000000-05:00" # keep this comment\r\n---\r\nbody\r\n';
    const result = mergeLatestTimestampFrontmatter(server, device, updatedRule);
    expect(result?.content).toBe(device);
    expect(result?.fields).toEqual([{ field: 'updated', winner: 'device' }]);
  });

  it('compares fractions exactly and keeps server spelling for equal instants', () => {
    const server = note('2026-01-01T00:00:00.123456789Z');
    const newer = note('2026-01-01T00:00:00.123456790Z');
    expect(mergeLatestTimestampFrontmatter(server, newer, updatedRule)?.content).toBe(newer);
    const equivalent = note('2026-01-01T01:00:00.123456789+01:00');
    expect(mergeLatestTimestampFrontmatter(server, equivalent, updatedRule)).toMatchObject({
      content: server,
      fields: [{ field: 'updated', winner: 'tie_server' }]
    });
  });

  it('merges each configured timestamp independently', () => {
    const rules = [
      { field: 'updated', strategy: 'latest_timestamp' as const },
      { field: 'created', strategy: 'latest_timestamp' as const }
    ];
    const server = '---\nupdated: 2026-01-01T00:00:00Z\ncreated: 2026-01-02T00:00:00Z\n---\nbody\n';
    const device = '---\nupdated: 2026-01-03T00:00:00Z\ncreated: 2026-01-01T00:00:00Z\n---\nbody\n';
    expect(mergeLatestTimestampFrontmatter(server, device, rules)).toMatchObject({
      content: '---\nupdated: 2026-01-03T00:00:00Z\ncreated: 2026-01-02T00:00:00Z\n---\nbody\n',
      fields: [
        { field: 'updated', winner: 'device' },
        { field: 'created', winner: 'server' }
      ]
    });
  });

  it('does not merge when body or unconfigured metadata differs', () => {
    expect(mergeLatestTimestampFrontmatter(note('2026-01-01T00:00:00Z'), note('2026-01-02T00:00:00Z', 'changed\n'), updatedRule)).toBeNull();
    expect(mergeLatestTimestampFrontmatter(
      note('2026-01-01T00:00:00Z', 'body\n', 'title: Server\n'),
      note('2026-01-02T00:00:00Z', 'body\n', 'title: Device\n'),
      updatedRule
    )).toBeNull();
  });

  it.each([
    ['no configured rule', [], note('2026-01-01T00:00:00Z'), note('2026-01-02T00:00:00Z')],
    ['missing field', updatedRule, note('2026-01-01T00:00:00Z'), '---\ntitle: No timestamp\n---\nbody\n'],
    ['unzoned timestamp', updatedRule, note('2026-01-01T00:00:00'), note('2026-01-02T00:00:00')],
    ['invalid calendar date', updatedRule, note('2026-02-30T00:00:00Z'), note('2026-03-01T00:00:00Z')],
    ['invalid offset', updatedRule, note('2026-01-01T00:00:00+24:00'), note('2026-01-02T00:00:00Z')],
    ['unknown offset', updatedRule, note('2026-01-01T00:00:00-00:00'), note('2026-01-02T00:00:00Z')],
    ['fraction beyond nanoseconds', updatedRule, note('2026-01-01T00:00:00.1234567890Z'), note('2026-01-02T00:00:00Z')],
    ['malformed YAML', updatedRule, '---\nupdated: [broken\n---\nbody\n', note('2026-01-02T00:00:00Z')],
    ['duplicate field', updatedRule, '---\nupdated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:01Z\n---\nbody\n', note('2026-01-02T00:00:00Z')],
    ['alias value', updatedRule, '---\nvalue: &stamp 2026-01-01T00:00:00Z\nupdated: *stamp\n---\nbody\n', '---\nvalue: &stamp 2026-01-02T00:00:00Z\nupdated: *stamp\n---\nbody\n'],
    ['anchored configured value', updatedRule, '---\nupdated: &stamp 2026-01-01T00:00:00Z\nother: *stamp\n---\nbody\n', '---\nupdated: &stamp 2026-01-02T00:00:00Z\nother: *stamp\n---\nbody\n'],
    ['tagged value', updatedRule, note('!!str 2026-01-01T00:00:00Z'), note('!!str 2026-01-02T00:00:00Z')],
    ['nested value', updatedRule, '---\nupdated:\n  time: 2026-01-01T00:00:00Z\n---\nbody\n', '---\nupdated:\n  time: 2026-01-02T00:00:00Z\n---\nbody\n'],
    ['unconfigured anchor', updatedRule, '---\nupdated: 2026-01-01T00:00:00Z\nother: &value plain\n---\nbody\n', '---\nupdated: 2026-01-02T00:00:00Z\nother: &value plain\n---\nbody\n'],
    ['nested alias', updatedRule, '---\nupdated: 2026-01-01T00:00:00Z\nother:\n  value: &x plain\n  copy: *x\n---\nbody\n', '---\nupdated: 2026-01-02T00:00:00Z\nother:\n  value: &x plain\n  copy: *x\n---\nbody\n'],
    ['unconfigured tag', updatedRule, '---\nupdated: 2026-01-01T00:00:00Z\nother: !custom value\n---\nbody\n', '---\nupdated: 2026-01-02T00:00:00Z\nother: !custom value\n---\nbody\n']
  ])('falls back for %s', (_name, rules, server, device) => {
    expect(mergeLatestTimestampFrontmatter(server, device, rules)).toBeNull();
  });

  it('validates explicit rules without duplicates or unsupported strategies', () => {
    expect(validateMetadataConflictRules([{ field: 'updated', strategy: 'latest_timestamp' }])).toEqual(updatedRule);
    expect(() => validateMetadataConflictRules([{ field: 'updated', strategy: 'ignore' }])).toThrow(/supported/u);
    expect(() => validateMetadataConflictRules([
      { field: 'updated', strategy: 'latest_timestamp' },
      { field: 'updated', strategy: 'latest_timestamp' }
    ])).toThrow(/more than once/u);
  });
});
