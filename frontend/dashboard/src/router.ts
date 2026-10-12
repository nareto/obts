export const SECTIONS = ['overview', 'devices', 'conflicts', 'history', 'maintenance', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];
export type DevicesView = 'active' | 'revoked';

export type VaultRoute = {
  kind: 'vault';
  vaultId: string;
  section: Section;
  conflictId?: string;
  devicesView?: DevicesView;
};

export type Route =
  | VaultRoute
  | { kind: 'account-settings' }
  | { kind: 'root'; legacyVault?: string }
  | { kind: 'connect'; connectionId: string }
  | { kind: 'not-found'; path: string };

export type NavigationSource = 'push' | 'replace' | 'popstate';
export type RouteListener = (route: Route, source: NavigationSource) => void;

const MAX_NOT_FOUND_PATH = 200;

function decodeSegment(segment: string): string | null {
  if (segment === '') return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

function notFound(pathname: string): Route {
  return { kind: 'not-found', path: pathname.slice(0, MAX_NOT_FOUND_PATH) };
}

function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

/**
 * Parses a location into a route. Never throws: malformed escapes, empty
 * segments, unknown sections and extra segments become `not-found`.
 * One trailing slash is tolerated. `?devices=revoked` is only honored on the
 * devices section; `?vault=<id>` is only recognized on the root as a legacy marker.
 */
export function parseLocation(pathname: string, search = ''): Route {
  if (!pathname.startsWith('/')) return notFound(pathname);
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/' || path === '/dashboard') {
    const legacy = new URLSearchParams(search).get('vault');
    return legacy ? { kind: 'root', legacyVault: legacy } : { kind: 'root' };
  }
  const segments = path.slice(1).split('/');
  if (segments[0] === 'connect') {
    const connectionId = segments.length === 2 ? decodeSegment(segments[1] ?? '') : null;
    return connectionId ? { kind: 'connect', connectionId } : notFound(pathname);
  }
  if (segments[0] !== 'dashboard') return notFound(pathname);
  if (segments.length === 2 && segments[1] === 'settings') return { kind: 'account-settings' };
  if (segments[1] !== 'vaults' || segments.length < 3 || segments.length > 5) return notFound(pathname);
  const vaultId = decodeSegment(segments[2] ?? '');
  if (!vaultId) return notFound(pathname);
  if (segments.length === 3) return { kind: 'vault', vaultId, section: 'overview' };
  const section = segments[3] ?? '';
  if (!isSection(section)) return notFound(pathname);
  if (segments.length === 5) {
    if (section !== 'conflicts') return notFound(pathname);
    const conflictId = decodeSegment(segments[4] ?? '');
    return conflictId ? { kind: 'vault', vaultId, section, conflictId } : notFound(pathname);
  }
  if (section === 'devices' && new URLSearchParams(search).get('devices') === 'revoked') {
    return { kind: 'vault', vaultId, section, devicesView: 'revoked' };
  }
  return { kind: 'vault', vaultId, section };
}

/** Canonical URL for a route; each dynamic segment is percent-encoded. */
export function routeHref(route: Route): string {
  switch (route.kind) {
    case 'root':
      return route.legacyVault ? `/dashboard?vault=${encodeURIComponent(route.legacyVault)}` : '/dashboard';
    case 'account-settings':
      return '/dashboard/settings';
    case 'connect':
      return `/connect/${encodeURIComponent(route.connectionId)}`;
    case 'not-found':
      return route.path;
    case 'vault': {
      const base = `/dashboard/vaults/${encodeURIComponent(route.vaultId)}/${route.section}`;
      if (route.section === 'conflicts' && route.conflictId) return `${base}/${encodeURIComponent(route.conflictId)}`;
      if (route.section === 'devices' && route.devicesView === 'revoked') return `${base}?devices=revoked`;
      return base;
    }
  }
}

export function vaultRoute(vaultId: string, section: Section, extra: { conflictId?: string; devicesView?: DevicesView } = {}): VaultRoute {
  const route: VaultRoute = { kind: 'vault', vaultId, section };
  if (extra.conflictId && section === 'conflicts') route.conflictId = extra.conflictId;
  if (extra.devicesView && section === 'devices') route.devicesView = extra.devicesView;
  return route;
}

export function currentLocationHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function currentRoute(): Route {
  return parseLocation(window.location.pathname, window.location.search);
}

const listeners = new Set<RouteListener>();
let popstateAttached = false;

function notify(source: NavigationSource) {
  const route = currentRoute();
  for (const listener of [...listeners]) listener(route, source);
}

const INDEX_KEY = 'obtsIndex';

function readIndex(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)[INDEX_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function withIndex(state: unknown, index: number): Record<string, unknown> {
  const base = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  return { ...base, [INDEX_KEY]: index };
}

/**
 * Position of the current history entry among entries created by this router, or null for a foreign
 * entry (one this router never stamped). Pushing from entry N stores N + 1, so the value increases
 * along the history stack and a difference of two indexes is exactly the `history.go` distance.
 */
export function currentHistoryIndex(): number | null {
  return readIndex(window.history.state);
}

/** Stamps the current entry with index 0 when it has none, keeping its URL and any existing state keys. */
export function initHistoryIndex(): void {
  if (currentHistoryIndex() !== null) return;
  window.history.replaceState(withIndex(window.history.state, 0), '', `${window.location.pathname}${window.location.search}${window.location.hash ?? ''}`);
}

let ignoredPop: { index: number; href: string } | null = null;

function handlePopstate() {
  const ignored = ignoredPop;
  ignoredPop = null;
  if (ignored && currentHistoryIndex() === ignored.index && currentLocationHref() === ignored.href) return;
  notify('popstate');
}

/** Subscribes to programmatic navigation and browser Back/Forward (popstate). */
export function subscribe(listener: RouteListener): () => void {
  listeners.add(listener);
  if (!popstateAttached) {
    window.addEventListener('popstate', handlePopstate);
    popstateAttached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && popstateAttached) {
      window.removeEventListener('popstate', handlePopstate);
      popstateAttached = false;
    }
  };
}

/** Pushes or replaces the browser URL for a route and notifies subscribers. */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = routeHref(route);
  if (!options.replace && href === currentLocationHref()) return;
  const index = currentHistoryIndex();
  if (options.replace) window.history.replaceState(withIndex(window.history.state, index ?? 0), '', href);
  else window.history.pushState({ [INDEX_KEY]: (index ?? 0) + 1 }, '', href);
  ignoredPop = null;
  notify(options.replace ? 'replace' : 'push');
}

/**
 * Fallback for a cancelled history navigation whose popped entry is foreign: pushes the previous URL
 * again (this truncates forward history). Subscribers are not notified.
 */
export function restoreLocation(href: string): void {
  window.history.pushState({ [INDEX_KEY]: (currentHistoryIndex() ?? 0) + 1 }, '', href);
}

/**
 * Undoes a cancelled Back/Forward without losing the other entries: travels back to the committed
 * entry with `history.go` and swallows exactly the popstate that produces. Falls back to
 * `restoreLocation` when either entry has no index. Returns the index of the committed entry.
 */
export function undoNavigation(committedHref: string, committedIndex: number | null): number | null {
  const popped = currentHistoryIndex();
  if (popped === null || committedIndex === null) {
    restoreLocation(committedHref);
    return currentHistoryIndex();
  }
  const delta = committedIndex - popped;
  if (delta === 0) return committedIndex;
  ignoredPop = { index: committedIndex, href: committedHref };
  window.history.go(delta);
  return committedIndex;
}

export type ClickEventLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

export type AnchorLike = {
  href: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
};

/**
 * True only for an unmodified primary-button click on a same-origin anchor that
 * would otherwise load in this browsing context. Everything else (new tab,
 * copy link, downloads, other targets, cross-origin) is left to the browser.
 */
export function shouldInterceptClick(event: ClickEventLike, anchor: AnchorLike, origin: string = window.location.origin): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = anchor.getAttribute('target');
  if (target && target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  try {
    return new URL(anchor.href).origin === origin;
  } catch {
    return false;
  }
}
