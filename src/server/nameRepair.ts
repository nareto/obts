import { posix } from 'node:path';

import { findUnportablePaths, foldPathCase, segmentHasReservedCharacters, type UnportableReason } from '../shared/namePortability.cjs';
import { isSyncableVaultPath, normalizeVaultPath } from '../shared/pathPolicy.js';

export type NameRepairRename = {
  from: string;
  to: string;
  kind: 'file' | 'directory';
  reasons: UnportableReason[];
};

export type NameRepairPlan = {
  renames: NameRepairRename[];
  fileMap: Map<string, string>;
  directoryMap: Map<string, string>;
  files: string[];
  directories: string[];
};

const FORBIDDEN_RESULT_SEGMENTS = new Set(['', '.', '..', '.git']);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeText(text: string): string {
  return text
    .replace(/[:|]/gu, ' - ')
    .replace(/"/gu, "'")
    .replace(/\\/gu, '-')
    .replace(/[*<>?\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function sanitizeSegment(segment: string, isFile: boolean, isRoot: boolean): string {
  if (!segmentHasReservedCharacters(segment)) return segment;
  const extensionMatch = isFile ? /\.[A-Za-z0-9]{1,16}$/u.exec(segment) : null;
  const extension = extensionMatch && extensionMatch.index > 0 ? extensionMatch[0] : '';
  let stem = sanitizeText(extension ? segment.slice(0, -extension.length) : segment);
  if (FORBIDDEN_RESULT_SEGMENTS.has(stem) || (isRoot && stem === '.obts')) stem = 'Untitled';
  return `${stem}${extension}`;
}

function withSuffix(path: string, attempt: number): string {
  const directory = posix.dirname(path);
  const base = posix.basename(path);
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? `${base.slice(0, dot)} (${attempt})${base.slice(dot)}` : `${base} (${attempt})`;
  return directory === '.' ? name : `${directory}/${name}`;
}

/**
 * OBTS-DASH-NAME-001 deterministic mapping. Unchanged segments keep their
 * exact bytes; unchanged portable files keep their paths.
 */
export function planNameRepair(files: string[], explicitDirectories: string[]): NameRepairPlan {
  const sortedFiles = [...new Set(files)].sort(compare);
  const sortedDirectories = [...new Set(explicitDirectories)].sort(compare);
  const unportable = new Map(findUnportablePaths(sortedFiles, sortedDirectories).map((entry) => [entry.path, entry.reasons]));

  const prefixes = new Set<string>();
  for (const path of [...sortedFiles.map((file) => posix.dirname(file)), ...sortedDirectories]) {
    if (path === '.') continue;
    const segments = path.split('/');
    for (let index = 1; index <= segments.length; index += 1) prefixes.add(segments.slice(0, index).join('/'));
  }
  const orderedPrefixes = [...prefixes].sort((left, right) =>
    left.split('/').length - right.split('/').length || compare(left, right));
  const directoryMap = new Map<string, string>();
  const directoryByKey = new Map<string, string>();
  for (const prefix of orderedPrefixes) {
    const parent = posix.dirname(prefix);
    const segment = posix.basename(prefix);
    const newParent = parent === '.' ? '' : directoryMap.get(parent)!;
    const sanitized = sanitizeSegment(segment, false, newParent === '');
    const candidate = newParent ? `${newParent}/${sanitized}` : sanitized;
    const key = foldPathCase(candidate);
    const existing = directoryByKey.get(key);
    if (existing !== undefined) {
      directoryMap.set(prefix, existing);
    } else {
      directoryByKey.set(key, candidate);
      directoryMap.set(prefix, candidate);
    }
  }

  const taken = new Set(directoryByKey.keys());
  const candidates = sortedFiles.map((file) => {
    const parent = posix.dirname(file);
    const newParent = parent === '.' ? '' : directoryMap.get(parent)!;
    const name = sanitizeSegment(posix.basename(file), true, newParent === '');
    return { file, candidate: newParent ? `${newParent}/${name}` : name };
  });
  const fileMap = new Map<string, string>();
  for (const { file, candidate } of candidates) {
    if (candidate !== file || taken.has(foldPathCase(file))) continue;
    taken.add(foldPathCase(file));
    fileMap.set(file, file);
  }
  for (const { file, candidate } of candidates) {
    if (fileMap.has(file)) continue;
    let target = candidate;
    for (let attempt = 2; taken.has(foldPathCase(target)); attempt += 1) target = withSuffix(candidate, attempt);
    taken.add(foldPathCase(target));
    fileMap.set(file, target);
  }

  const renames: NameRepairRename[] = [];
  for (const file of sortedFiles) {
    const target = fileMap.get(file)!;
    if (target !== file) {
      renames.push({ from: file, to: target, kind: 'file', reasons: unportable.get(file) ?? ['case_collision'] });
    }
  }
  const newDirectories: string[] = [];
  for (const directory of sortedDirectories) {
    const target = directoryMap.get(directory)!;
    newDirectories.push(target);
    if (target !== directory) {
      renames.push({ from: directory, to: target, kind: 'directory', reasons: unportable.get(directory) ?? ['case_collision'] });
    }
  }
  const newFiles = sortedFiles.map((file) => fileMap.get(file)!);
  for (const path of [...newFiles, ...newDirectories]) {
    const normalized = normalizeVaultPath(path);
    if (!normalized.ok || normalized.path !== path || !isSyncableVaultPath(path)) {
      throw new NameRepairError('name_repair_unresolvable', 'A repaired name is not a valid vault path.');
    }
  }
  if (findUnportablePaths(newFiles, newDirectories).length > 0) {
    throw new NameRepairError('name_repair_unresolvable', 'The repaired names still contain unrepresentable paths.');
  }
  return {
    renames,
    fileMap,
    directoryMap,
    files: newFiles.sort(compare),
    directories: [...new Set(newDirectories)].sort(compare)
  };
}

export class NameRepairError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type LinkStyle = 'wiki' | 'markdown';

/** Approximates Obsidian link resolution over one immutable path set. */
export class VaultLinkIndex {
  private readonly exact = new Set<string>();
  private readonly byKey = new Map<string, string[]>();
  private readonly byBasenameKey = new Map<string, string[]>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      this.exact.add(path);
      const key = foldPathCase(path);
      (this.byKey.get(key) ?? this.byKey.set(key, []).get(key)!).push(path);
      const base = foldPathCase(posix.basename(path));
      (this.byBasenameKey.get(base) ?? this.byBasenameKey.set(base, []).get(base)!).push(path);
    }
  }

  private lookup(path: string): string | null {
    for (const candidate of [path, `${path}.md`]) {
      if (this.exact.has(candidate)) return candidate;
    }
    for (const candidate of [path, `${path}.md`]) {
      const matches = this.byKey.get(foldPathCase(candidate));
      if (matches?.length === 1) return matches[0]!;
    }
    return null;
  }

  private suffixMatch(linkpath: string, sourceDirectory: string): string | null {
    const options = [linkpath, `${linkpath}.md`].map(foldPathCase);
    const matches = new Set<string>();
    for (const option of options) {
      for (const path of this.byBasenameKey.get(posix.basename(option)) ?? []) {
        const key = foldPathCase(path);
        if (key === option || key.endsWith(`/${option}`)) matches.add(path);
      }
    }
    if (matches.size === 0) return null;
    const ordered = [...matches].sort((left, right) => {
      const leftLocal = posix.dirname(left) === sourceDirectory ? 0 : 1;
      const rightLocal = posix.dirname(right) === sourceDirectory ? 0 : 1;
      return leftLocal - rightLocal || left.split('/').length - right.split('/').length || compare(left, right);
    });
    return ordered[0]!;
  }

  resolve(linkpath: string, sourcePath: string, style: LinkStyle): { path: string; form: 'absolute' | 'relative' | 'suffix' } | null {
    if (!linkpath) return null;
    const sourceDirectory = posix.dirname(sourcePath) === '.' ? '' : posix.dirname(sourcePath);
    const explicitRelative = linkpath.startsWith('./') || linkpath.startsWith('../');
    const relative = posix.normalize(posix.join(sourceDirectory || '.', linkpath));
    const relativeValid = !relative.startsWith('../') && relative !== '..' && relative !== '.';
    const absolute = linkpath.replace(/^\/+/u, '');
    if (explicitRelative || style === 'markdown') {
      const found = relativeValid ? this.lookup(relative) : null;
      if (found) return { path: found, form: 'relative' };
      if (explicitRelative) return null;
    }
    const absoluteFound = this.lookup(absolute);
    if (absoluteFound) return { path: absoluteFound, form: 'absolute' };
    const suffix = this.suffixMatch(absolute, sourceDirectory);
    return suffix ? { path: suffix, form: 'suffix' } : null;
  }
}

function stripMarkdownExtension(path: string, keepExtension: boolean): string {
  return !keepExtension && path.endsWith('.md') ? path.slice(0, -3) : path;
}

function relativeLink(fromDirectory: string, target: string): string {
  const relative = posix.relative(fromDirectory || '.', target);
  return relative || posix.basename(target);
}

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*$/gmu;
  let open: { start: number; marker: string } | null = null;
  for (const match of text.matchAll(fence)) {
    const marker = match[2]!;
    if (!open) {
      open = { start: match.index!, marker };
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && match[0].trim() === marker) {
      ranges.push([open.start, match.index! + match[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, text.length]);
  const inline = /(`+)(?!`)(?:[^\n]|\n(?![ \t]*\n))*?(?<!`)\1(?!`)/gu;
  for (const match of text.matchAll(inline)) {
    const start = match.index!;
    if (!ranges.some(([from, to]) => start >= from && start < to)) ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

export type LinkRewriteContext = {
  sourceOld: string;
  sourceNew: string;
  oldIndex: VaultLinkIndex;
  newIndex: VaultLinkIndex;
  map: (oldPath: string) => string;
};

function rewriteTarget(
  linkpath: string,
  style: LinkStyle,
  context: LinkRewriteContext
): string | null {
  const resolved = context.oldIndex.resolve(linkpath, context.sourceOld, style);
  if (!resolved) return null;
  const intended = context.map(resolved.path);
  const current = context.newIndex.resolve(linkpath, context.sourceNew, style);
  if (current?.path === intended) return null;
  const keepExtension = /\.[^/.]+$/u.test(posix.basename(linkpath)) && linkpath.toLowerCase().endsWith(posix.extname(resolved.path).toLowerCase());
  const leadingSlash = linkpath.startsWith('/') ? '/' : '';
  const sourceDirectory = posix.dirname(context.sourceNew) === '.' ? '' : posix.dirname(context.sourceNew);
  const candidates: string[] = [];
  if (resolved.form === 'relative') {
    const relative = relativeLink(sourceDirectory, intended);
    candidates.push(stripMarkdownExtension(linkpath.startsWith('./') && !relative.startsWith('.') ? `./${relative}` : relative, keepExtension));
  } else if (resolved.form === 'suffix') {
    const segments = intended.split('/');
    for (let count = 1; count <= segments.length; count += 1) {
      candidates.push(stripMarkdownExtension(segments.slice(-count).join('/'), keepExtension));
    }
  }
  candidates.push(`${leadingSlash}${stripMarkdownExtension(intended, keepExtension)}`);
  for (const candidate of candidates) {
    if (context.newIndex.resolve(candidate, context.sourceNew, style)?.path === intended) return candidate;
  }
  return `${leadingSlash}${intended}`;
}

function encodeMarkdownDestination(path: string): string {
  return encodeURI(path).replace(/[()#?]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Rewrites wikilinks and Markdown links outside code; returns null when unchanged. */
export function rewriteMarkdownLinks(text: string, context: LinkRewriteContext): { text: string; count: number } | null {
  const excluded = codeRanges(text);
  const inCode = (index: number) => excluded.some(([from, to]) => index >= from && index < to);
  const edits: Array<{ start: number; end: number; value: string }> = [];

  for (const match of text.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/gu)) {
    if (inCode(match.index!)) continue;
    const inner = match[2]!;
    const pipe = inner.indexOf('|');
    const separatorStart = pipe > 0 && inner[pipe - 1] === '\\' ? pipe - 1 : pipe;
    const left = pipe >= 0 ? inner.slice(0, separatorStart) : inner;
    const rest = pipe >= 0 ? inner.slice(separatorStart) : '';
    const hash = left.indexOf('#');
    const linkpath = (hash >= 0 ? left.slice(0, hash) : left).trim();
    const subpath = hash >= 0 ? left.slice(hash) : '';
    const replacement = rewriteTarget(linkpath, 'wiki', context);
    if (replacement === null) continue;
    const start = match.index! + match[1]!.length + 2;
    edits.push({ start, end: start + inner.length, value: `${replacement}${subpath}${rest}` });
  }

  const markdownLink = /(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(([ \t]*)(<[^<>\n]+>|[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)/gu;
  for (const match of text.matchAll(markdownLink)) {
    if (inCode(match.index!)) continue;
    const destination = match[4]!;
    const angled = destination.startsWith('<');
    const raw = angled ? destination.slice(1, -1) : destination;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('#')) continue;
    const hash = raw.indexOf('#');
    const encodedPath = hash >= 0 ? raw.slice(0, hash) : raw;
    const fragment = hash >= 0 ? raw.slice(hash) : '';
    const linkpath = angled ? encodedPath : safeDecode(encodedPath);
    if (!linkpath) continue;
    const replacement = rewriteTarget(linkpath, 'markdown', context);
    if (replacement === null) continue;
    const value = angled ? `<${replacement}${fragment}>` : `${encodeMarkdownDestination(replacement)}${fragment}`;
    const start = match.index! + match[0].length - destination.length;
    edits.push({ start, end: start + destination.length, value });
  }

  if (edits.length === 0) return null;
  edits.sort((left, right) => left.start - right.start);
  let output = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    output += text.slice(cursor, edit.start) + edit.value;
    cursor = edit.end;
  }
  output += text.slice(cursor);
  return output === text ? null : { text: output, count: edits.length };
}

/** Rewrites Canvas `"file"` references byte-preservingly; returns null when unchanged. */
export function rewriteCanvasLinks(text: string, fileMap: Map<string, string>): { text: string; count: number } | null {
  let count = 0;
  const output = text.replace(/("file"\s*:\s*)("(?:[^"\\\n]|\\.)*")/gu, (whole, prefix: string, literal: string) => {
    let value: unknown;
    try {
      value = JSON.parse(literal);
    } catch {
      return whole;
    }
    if (typeof value !== 'string') return whole;
    const target = fileMap.get(value);
    if (target === undefined || target === value) return whole;
    count += 1;
    return `${prefix}${JSON.stringify(target)}`;
  });
  return count === 0 ? null : { text: output, count };
}
