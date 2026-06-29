import { extname, posix } from 'node:path';

import type { SyncProfile } from './types.js';

export type PathPolicyResult =
  | { ok: true; path: string }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export type SyncPathPolicy = {
  profile: SyncProfile;
  syncPlugins: boolean;
  attachmentLocation?:
    | { mode: 'vault_folder' }
    | { mode: 'specified_folder'; folder: string }
    | { mode: 'same_folder_as_note' }
    | { mode: 'subfolder_under_note_folder'; subfolder: string };
};

const NOTE_EXTENSIONS = new Set(['.md', '.canvas', '.base']);
const ATTACHMENT_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.wav',
  '.webm',
  '.3gp',
  '.mkv',
  '.mov',
  '.mp4',
  '.ogv',
  '.pdf'
]);
const OBSIDIAN_ALLOWLIST = new Set([
  '.obsidian/app.json',
  '.obsidian/appearance.json',
  '.obsidian/backlinks.json',
  '.obsidian/bookmarks.json',
  '.obsidian/command-palette.json',
  '.obsidian/core-plugins.json',
  '.obsidian/core-plugins-migration.json',
  '.obsidian/daily-notes.json',
  '.obsidian/editor.json',
  '.obsidian/graph.json',
  '.obsidian/hotkeys.json',
  '.obsidian/outgoing-link.json',
  '.obsidian/page-preview.json',
  '.obsidian/properties.json',
  '.obsidian/switcher.json',
  '.obsidian/templates.json',
  '.obsidian/types.json'
]);
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
]);

export function normalizeVaultPath(input: string): PathPolicyResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, code: 'invalid_path', message: 'Vault path must be a non-empty string.' };
  }

  const slashPath = input.replaceAll('\\', '/').normalize('NFC');
  const trimmedPrefix = slashPath.startsWith('./') ? slashPath.slice(2) : slashPath;
  if (
    trimmedPrefix.startsWith('/') ||
    /^[A-Za-z]:\//.test(trimmedPrefix) ||
    trimmedPrefix === '.' ||
    trimmedPrefix === '..'
  ) {
    return { ok: false, code: 'invalid_path', message: 'Vault path must be relative.' };
  }
  if (trimmedPrefix.includes('\0') || /[\u0000-\u001f\u007f]/u.test(trimmedPrefix)) {
    return { ok: false, code: 'invalid_path', message: 'Vault path contains a control character.' };
  }
  if (trimmedPrefix.length > 4096) {
    return { ok: false, code: 'path_too_long', message: 'Vault path exceeds the v1 path length limit.' };
  }

  const normalized = posix.normalize(trimmedPrefix);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return { ok: false, code: 'invalid_path', message: 'Vault path must not traverse outside the vault.' };
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return { ok: false, code: 'invalid_path', message: 'Vault path contains an empty or traversal segment.' };
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      return { ok: false, code: 'invalid_path', message: 'Vault path has a trailing space or dot segment.' };
    }
    const withoutExtension = segment.split('.')[0]?.toLowerCase() ?? '';
    if (WINDOWS_RESERVED.has(withoutExtension)) {
      return { ok: false, code: 'invalid_path', message: 'Vault path uses a reserved device name.' };
    }
  }

  if (segments[0] === '.obts') {
    return { ok: false, code: 'excluded_internal_path', message: '.obts is client-local state and cannot be synced.' };
  }
  if (segments.includes('.git')) {
    return { ok: false, code: 'excluded_git_path', message: 'Visible .git directories cannot be synced.' };
  }

  return { ok: true, path: normalized };
}

export function isSyncableVaultPath(path: string, policy: SyncPathPolicy): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized.ok) {
    return false;
  }
  const cleanPath = normalized.path;
  const firstSegment = cleanPath.split('/')[0] ?? '';
  const extension = extname(cleanPath).toLowerCase();

  if (firstSegment === '.trash') {
    return false;
  }
  if (isOsOrEditorMetadata(cleanPath)) {
    return false;
  }
  if (NOTE_EXTENSIONS.has(extension)) {
    return true;
  }
  if (policy.profile === 'notes_only') {
    return false;
  }
  if (policy.profile === 'notes_plus_attachments') {
    return isAttachmentPath(cleanPath, policy);
  }
  if (cleanPath.startsWith('.obsidian/plugins/')) {
    return policy.syncPlugins && !cleanPath.startsWith('.obsidian/plugins/obts/');
  }
  if (cleanPath.startsWith('.obsidian/snippets/') && cleanPath.endsWith('.css')) {
    return true;
  }
  if (OBSIDIAN_ALLOWLIST.has(cleanPath)) {
    return true;
  }
  if (cleanPath.startsWith('.obsidian/')) {
    return false;
  }
  return isAttachmentPath(cleanPath, policy);
}

export function assertSyncableTreePaths(paths: string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    if (!normalized.ok) {
      throw new PathPolicyViolation(normalized.code, normalized.message, normalized.details);
    }
    const collisionKey = normalized.path.normalize('NFC').toLocaleLowerCase('en-US');
    const existing = seen.get(collisionKey);
    if (existing !== undefined && existing !== normalized.path) {
      throw new PathPolicyViolation('path_collision', 'Vault paths collide on case-insensitive filesystems.', {
        path_count: 2
      });
    }
    seen.set(collisionKey, normalized.path);
  }
}

export class PathPolicyViolation extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function isAttachmentPath(path: string, policy: SyncPathPolicy): boolean {
  const extension = extname(path).toLowerCase();
  if (!ATTACHMENT_EXTENSIONS.has(extension)) {
    return false;
  }
  if (!policy.attachmentLocation || policy.attachmentLocation.mode === 'vault_folder') {
    return !path.includes('/');
  }
  if (policy.attachmentLocation.mode === 'specified_folder') {
    const folder = policy.attachmentLocation.folder.replaceAll('\\', '/').replace(/\/+$/u, '');
    return path.startsWith(`${folder}/`);
  }
  if (policy.attachmentLocation.mode === 'same_folder_as_note') {
    return true;
  }
  const subfolder = policy.attachmentLocation.subfolder.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  return path.split('/').includes(subfolder);
}

function isOsOrEditorMetadata(path: string): boolean {
  const basename = path.split('/').at(-1) ?? path;
  return (
    basename === '.DS_Store' ||
    basename === 'Thumbs.db' ||
    basename.endsWith('~') ||
    basename.endsWith('.swp') ||
    basename.endsWith('.tmp')
  );
}
