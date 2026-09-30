import { isAlias, isMap, isScalar, parseDocument } from 'yaml';

export type MetadataConflictRule = {
  field: string;
  strategy: 'latest_timestamp';
};

type TimestampInstant = { seconds: bigint; nanos: bigint };
type FieldSpan = { start: number; end: number; raw: string; instant: TimestampInstant };
type Frontmatter = { body: string; fields: Map<string, FieldSpan> };

const FIELD_NAME = /^[A-Za-z0-9_-]+$/u;
const ISO_OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export function validateMetadataConflictRules(value: unknown): MetadataConflictRule[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Configure at most 64 metadata conflict rules.');
  const fields = new Set<string>();
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Metadata conflict rules must be objects.');
    const rule = item as Record<string, unknown>;
    if (typeof rule.field !== 'string' || !FIELD_NAME.test(rule.field) || rule.field.length > 128) {
      throw new Error('Metadata conflict fields must be top-level YAML keys.');
    }
    if (rule.strategy !== 'latest_timestamp') throw new Error('The supported metadata conflict strategy is latest_timestamp.');
    if (fields.has(rule.field)) throw new Error(`Metadata conflict field ${rule.field} is configured more than once.`);
    fields.add(rule.field);
    return { field: rule.field, strategy: 'latest_timestamp' };
  });
}

export function mergeLatestTimestampFrontmatter(
  serverSource: string,
  deviceSource: string,
  rules: MetadataConflictRule[]
): { content: string; fields: Array<{ field: string; winner: 'server' | 'device' | 'tie_server' }> } | null {
  if (rules.length === 0) return null;
  const server = parseMarkdownFrontmatter(serverSource, rules);
  const device = parseMarkdownFrontmatter(deviceSource, rules);
  if (!server || !device || server.body !== device.body) return null;

  const serverSpans = rules.map((rule) => server.fields.get(rule.field));
  const deviceSpans = rules.map((rule) => device.fields.get(rule.field));
  if (serverSpans.some((span) => !span) || deviceSpans.some((span) => !span)) return null;
  if (!equalOutsideSpans(serverSource, serverSpans as FieldSpan[], deviceSource, deviceSpans as FieldSpan[])) return null;

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const outcomes: Array<{ field: string; winner: 'server' | 'device' | 'tie_server' }> = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const serverField = serverSpans[index]!;
    const deviceField = deviceSpans[index]!;
    const comparison = compareTimestamp(serverField.instant, deviceField.instant);
    if (comparison >= 0) {
      outcomes.push({ field: rule.field, winner: comparison === 0 ? 'tie_server' : 'server' });
    } else {
      replacements.push({ start: serverField.start, end: serverField.end, value: deviceField.raw });
      outcomes.push({ field: rule.field, winner: 'device' });
    }
  }
  let content = serverSource;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
  }
  return { content, fields: outcomes };
}

function parseMarkdownFrontmatter(source: string, rules: MetadataConflictRule[]): Frontmatter | null {
  const opening = /^(---)[ \t]*(\r\n|\n|\r)/u.exec(source);
  if (!opening) return null;
  const yamlStart = opening[0].length;
  const closing = /(?:^|\r\n|\n|\r)(---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
  closing.lastIndex = yamlStart;
  const end = closing.exec(source);
  if (!end) return null;
  const delimiterStart = end.index + (end[0].startsWith('\r\n') ? 2 : end[0].startsWith('\n') || end[0].startsWith('\r') ? 1 : 0);
  const yamlText = source.slice(yamlStart, delimiterStart);
  const document = parseDocument(yamlText, { version: '1.2', uniqueKeys: true, strict: true, prettyErrors: false });
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents) || hasUnsupportedYamlNode(document.contents)) return null;

  const pairs = new Map<string, { start: number; end: number; node: unknown }>();
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const key = pair.key.value;
    if (pairs.has(key)) return null;
    if (rules.some((rule) => rule.field === key)) {
      if (!isScalar(pair.value) || isAlias(pair.value) || pair.value.tag !== undefined || pair.value.anchor !== undefined || typeof pair.value.value !== 'string') {
        return null;
      }
      const range = pair.value.range;
      if (!range || range[0] === undefined || range[1] === undefined) return null;
      const raw = yamlText.slice(range[0], range[1]);
      const instant = parseTimestamp(String(pair.value.value));
      if (!instant) return null;
      pairs.set(key, { start: yamlStart + range[0], end: yamlStart + range[1], node: { raw, instant } });
    }
  }
  const fields = new Map<string, FieldSpan>();
  for (const rule of rules) {
    const entry = pairs.get(rule.field);
    if (!entry) return null;
    const node = entry.node as { raw: string; instant: TimestampInstant };
    fields.set(rule.field, { start: entry.start, end: entry.end, raw: node.raw, instant: node.instant });
  }
  return { body: source.slice(end.index + end[0].length), fields };
}

function hasUnsupportedYamlNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (isAlias(node)) return true;
  const candidate = node as { anchor?: unknown; tag?: unknown; items?: unknown[] };
  if (candidate.anchor !== undefined || candidate.tag !== undefined) return true;
  if (!Array.isArray(candidate.items)) return false;
  return candidate.items.some((item) => {
    if (typeof item !== 'object' || item === null) return hasUnsupportedYamlNode(item);
    const pair = item as { key?: unknown; value?: unknown };
    if ('key' in pair || 'value' in pair) return hasUnsupportedYamlNode(pair.key) || hasUnsupportedYamlNode(pair.value);
    return hasUnsupportedYamlNode(item);
  });
}

function parseTimestamp(value: string): TimestampInstant | null {
  const match = ISO_OFFSET_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetSeconds = 0;
  if (zone === '-00:00') return null;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const sign = zone[0] === '+' ? 1 : -1;
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  }
  const seconds = BigInt(Math.trunc(date.getTime() / 1000) - offsetSeconds);
  const nanos = BigInt(fraction.padEnd(9, '0') || '0');
  return { seconds, nanos };
}

function equalOutsideSpans(left: string, leftSpans: FieldSpan[], right: string, rightSpans: FieldSpan[]): boolean {
  const leftSorted = [...leftSpans].sort((a, b) => a.start - b.start);
  const rightSorted = [...rightSpans].sort((a, b) => a.start - b.start);
  let leftCursor = 0;
  let rightCursor = 0;
  for (let index = 0; index < leftSorted.length; index += 1) {
    const leftSpan = leftSorted[index]!;
    const rightSpan = rightSorted[index]!;
    if (left.slice(leftCursor, leftSpan.start) !== right.slice(rightCursor, rightSpan.start)) return false;
    leftCursor = leftSpan.end;
    rightCursor = rightSpan.end;
  }
  return left.slice(leftCursor) === right.slice(rightCursor);
}

function compareTimestamp(left: TimestampInstant, right: TimestampInstant): number {
  if (left.seconds !== right.seconds) return left.seconds > right.seconds ? 1 : -1;
  if (left.nanos === right.nanos) return 0;
  return left.nanos > right.nanos ? 1 : -1;
}
