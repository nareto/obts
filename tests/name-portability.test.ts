import { describe, expect, it } from 'vitest';

import { findUnportablePaths, isRestrictedNamePlatform } from '../src/shared/namePortability.cjs';
import {
  planNameRepair,
  rewriteCanvasLinks,
  rewriteMarkdownLinks,
  sanitizeSegment,
  VaultLinkIndex
} from '../src/server/nameRepair.js';

function rewriteContext(files: string[], sourceOld: string) {
  const plan = planNameRepair(files, []);
  const map = (path: string) => plan.fileMap.get(path) ?? path;
  return {
    plan,
    context: {
      sourceOld,
      sourceNew: map(sourceOld),
      oldIndex: new VaultLinkIndex(files),
      newIndex: new VaultLinkIndex(plan.files),
      map
    }
  };
}

describe('OBTS-SYNC-NAME-001 shared rule', () => {
  it('reports reserved characters and case-only collisions on files, directories, and prefixes', () => {
    expect(isRestrictedNamePlatform('android')).toBe(true);
    expect(isRestrictedNamePlatform('ios')).toBe(false);
    expect(findUnportablePaths([
      'ok.md',
      'Q: what?.md',
      'Notes/a.md',
      'notes/b.md',
      'Same.md',
      'same.md',
      'pipe|dir/file.md'
    ], ['Empty"Dir'])).toEqual([
      { path: 'Empty"Dir', kind: 'directory', reasons: ['reserved_characters'] },
      { path: 'Notes/a.md', kind: 'file', reasons: ['case_collision'] },
      { path: 'Q: what?.md', kind: 'file', reasons: ['reserved_characters'] },
      { path: 'Same.md', kind: 'file', reasons: ['case_collision'] },
      { path: 'notes/b.md', kind: 'file', reasons: ['case_collision'] },
      { path: 'pipe|dir/file.md', kind: 'file', reasons: ['reserved_characters'] },
      { path: 'same.md', kind: 'file', reasons: ['case_collision'] }
    ]);
    expect(findUnportablePaths(['a.md', 'dir/b.md'], ['dir', 'other'])).toEqual([]);
  });
});

describe('OBTS-DASH-NAME-001 deterministic mapping', () => {
  it('maps reserved characters and keeps file extensions', () => {
    expect(sanitizeSegment('Q: what?.md', true, false)).toBe('Q - what.md');
    expect(sanitizeSegment('say "hi" | bye.md', true, false)).toBe("say 'hi' - bye.md");
    expect(sanitizeSegment('a\\b*c<d>.png', true, false)).toBe('a-bcd.png');
    expect(sanitizeSegment('v1.2: draft', true, false)).toBe('v1.2 - draft');
    expect(sanitizeSegment('???.md', true, false)).toBe('Untitled.md');
    expect(sanitizeSegment('plain.md', true, false)).toBe('plain.md');
  });

  it('unifies case-variant directories, suffixes collisions, and leaves portable paths alone', () => {
    const plan = planNameRepair([
      'keep.md',
      'Notes/a.md',
      'notes/b.md',
      'notes/a.md',
      'Q?.md',
      'Q.md',
      'Same.md',
      'same.md'
    ], ['notes/empty']);
    expect(plan.renames).toEqual([
      { from: 'Q?.md', to: 'Q (2).md', kind: 'file', reasons: ['reserved_characters'] },
      { from: 'notes/a.md', to: 'Notes/a (2).md', kind: 'file', reasons: ['case_collision'] },
      { from: 'notes/b.md', to: 'Notes/b.md', kind: 'file', reasons: ['case_collision'] },
      { from: 'same.md', to: 'same (2).md', kind: 'file', reasons: ['case_collision'] },
      { from: 'notes/empty', to: 'Notes/empty', kind: 'directory', reasons: ['case_collision'] }
    ]);
    expect(plan.fileMap.get('keep.md')).toBe('keep.md');
    expect(plan.fileMap.get('Q.md')).toBe('Q.md');
    expect(plan.fileMap.get('Same.md')).toBe('Same.md');
    expect(findUnportablePaths(plan.files, plan.directories)).toEqual([]);
  });

  it('is idempotent on an already portable tree', () => {
    const plan = planNameRepair(['a.md', 'dir/b.md'], ['dir/c']);
    expect(plan.renames).toEqual([]);
  });
});

describe('OBTS-DASH-NAME-001 link rewriting', () => {
  it('rewrites wikilinks and embeds while preserving aliases, headings, and code', () => {
    const { context } = rewriteContext(['Q: what?.md', 'img?1.png', 'index.md'], 'index.md');
    const text = [
      'See [[Q: what?]] and [[Q: what?#Heading|alias]] and ![[img?1.png]].',
      '`[[Q: what?]]` stays',
      '```',
      '[[Q: what?]]',
      '```',
      '| table [[Q: what?\\|alias]] |'
    ].join('\n');
    const result = rewriteMarkdownLinks(text, context);
    expect(result?.text).toBe([
      'See [[Q - what]] and [[Q - what#Heading|alias]] and ![[img1.png]].',
      '`[[Q: what?]]` stays',
      '```',
      '[[Q: what?]]',
      '```',
      '| table [[Q - what\\|alias]] |'
    ].join('\n'));
    expect(result?.count).toBe(4);
  });

  it('rewrites relative, absolute, percent-encoded, and angle-bracketed Markdown links', () => {
    const { context } = rewriteContext(['dir/Q: what?.md', 'dir/index.md', 'other.md'], 'dir/index.md');
    const text = [
      '[a](Q%3A%20what%3F.md)',
      '[b](</dir/Q: what?.md#Top>)',
      '[c](https://example.com/Q:what?)',
      '[d](../other.md)'
    ].join('\n');
    expect(rewriteMarkdownLinks(text, context)?.text).toBe([
      '[a](Q%20-%20what.md)',
      '[b](</dir/Q - what.md#Top>)',
      '[c](https://example.com/Q:what?)',
      '[d](../other.md)'
    ].join('\n'));
  });

  it('keeps shortest-path wikilinks short and disambiguates when needed', () => {
    const { context } = rewriteContext(['a/Note?.md', 'b/Note.md', 'index.md'], 'index.md');
    expect(rewriteMarkdownLinks('[[a/Note?]]', context)?.text).toBe('[[a/Note]]');
    const unique = rewriteContext(['deep/Only?.md', 'index.md'], 'index.md');
    expect(rewriteMarkdownLinks('[[Only?]]', unique.context)?.text).toBe('[[Only]]');
  });

  it('returns null when no link changes', () => {
    const { context } = rewriteContext(['a.md', 'index.md'], 'index.md');
    expect(rewriteMarkdownLinks('[[a]] and [x](a.md)', context)).toBeNull();
  });

  it('rewrites Canvas file nodes byte-preservingly', () => {
    const text = '{\n  "nodes": [\n    { "id": "1", "type": "file", "file": "Q: what?.md" },\n    { "id": "2", "file": "keep.md" }\n  ]\n}\n';
    const result = rewriteCanvasLinks(text, new Map([['Q: what?.md', 'Q - what.md']]));
    expect(result?.text).toBe(text.replace('"Q: what?.md"', '"Q - what.md"'));
    expect(result?.count).toBe(1);
  });
});
