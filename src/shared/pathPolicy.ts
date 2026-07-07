export type PathPolicyResult =
  | { ok: true; path: string }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

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

  const segments = trimmedPrefix.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return { ok: false, code: 'invalid_path', message: 'Vault path contains an empty or traversal segment.' };
    }
  }

  if (segments[0] === '.obts') {
    return { ok: false, code: 'excluded_internal_path', message: '.obts is client-local state and cannot be synced.' };
  }
  if (segments.includes('.git')) {
    return { ok: false, code: 'excluded_git_path', message: 'Visible .git directories cannot be synced.' };
  }

  return { ok: true, path: trimmedPrefix };
}

export function isSyncableVaultPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized.ok) {
    return false;
  }
  const cleanPath = normalized.path;

  if (isOsOrEditorMetadata(cleanPath)) {
    return false;
  }
  if (cleanPath === '.obsidian/workspace.json' || cleanPath === '.obsidian/workspace-mobile.json') {
    return false;
  }
  if (cleanPath === '.obsidian/cache' || cleanPath.startsWith('.obsidian/cache/')) {
    return false;
  }
  if (cleanPath === '.obsidian/plugins/obts' || cleanPath.startsWith('.obsidian/plugins/obts/')) {
    return false;
  }
  return true;
}

export function assertSyncableTreePaths(paths: string[]): void {
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    if (!normalized.ok) {
      throw new PathPolicyViolation(normalized.code, normalized.message, { ...(normalized.details ?? {}), path });
    }
    if (!isSyncableVaultPath(normalized.path)) {
      throw new PathPolicyViolation('excluded_path', 'Vault path is excluded from full-vault sync.', { path: normalized.path });
    }
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
