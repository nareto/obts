import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentHistoryIndex,
  initHistoryIndex,
  navigate,
  parseLocation,
  restoreLocation,
  routeHref,
  shouldInterceptClick,
  subscribe,
  undoNavigation,
  vaultRoute,
  SECTIONS,
  type AnchorLike,
  type ClickEventLike,
  type Route
} from '../frontend/dashboard/src/router.js';

function roundTrip(route: Route): Route {
  const href = routeHref(route);
  const queryAt = href.indexOf('?');
  return parseLocation(queryAt === -1 ? href : href.slice(0, queryAt), queryAt === -1 ? '' : href.slice(queryAt));
}

describe('dashboard router grammar', () => {
  it('parses every vault section and round-trips it', () => {
    for (const section of SECTIONS) {
      const route = parseLocation(`/dashboard/vaults/sample-vault/${section}`);
      expect(route).toEqual({ kind: 'vault', vaultId: 'sample-vault', section });
      expect(routeHref(route)).toBe(`/dashboard/vaults/sample-vault/${section}`);
      expect(roundTrip(route)).toEqual(route);
    }
  });

  it('treats a vault path without a section as overview', () => {
    expect(parseLocation('/dashboard/vaults/sample-vault')).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'overview' });
    expect(routeHref(parseLocation('/dashboard/vaults/sample-vault'))).toBe('/dashboard/vaults/sample-vault/overview');
  });

  it('parses conflict ids only under the conflicts section', () => {
    const route = parseLocation('/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    expect(route).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'conflicts', conflictId: 'sample-conflict' });
    expect(routeHref(route)).toBe('/dashboard/vaults/sample-vault/conflicts/sample-conflict');
    expect(parseLocation('/dashboard/vaults/sample-vault/devices/sample-conflict').kind).toBe('not-found');
    expect(parseLocation('/dashboard/vaults/sample-vault/conflicts/a/b').kind).toBe('not-found');
    expect(parseLocation('/dashboard/vaults/sample-vault/conflicts/')).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'conflicts' });
  });

  it('parses root, account settings and connect routes', () => {
    for (const path of ['/', '/dashboard', '/dashboard/']) expect(parseLocation(path)).toEqual({ kind: 'root' });
    expect(parseLocation('/dashboard/settings')).toEqual({ kind: 'account-settings' });
    expect(parseLocation('/dashboard/settings/')).toEqual({ kind: 'account-settings' });
    expect(routeHref({ kind: 'account-settings' })).toBe('/dashboard/settings');
    expect(routeHref({ kind: 'root' })).toBe('/dashboard');
    expect(parseLocation('/connect/demo')).toEqual({ kind: 'connect', connectionId: 'demo' });
    expect(routeHref({ kind: 'connect', connectionId: 'demo' })).toBe('/connect/demo');
    expect(parseLocation('/connect/')).toMatchObject({ kind: 'not-found' });
    expect(parseLocation('/connect/a/b')).toMatchObject({ kind: 'not-found' });
  });

  it('tolerates one trailing slash on every route form', () => {
    expect(parseLocation('/dashboard/vaults/sample-vault/devices/')).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'devices' });
    expect(parseLocation('/dashboard/vaults/sample-vault/conflicts/sample-conflict/')).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'conflicts', conflictId: 'sample-conflict' });
    expect(parseLocation('/dashboard/vaults/sample-vault/')).toEqual({ kind: 'vault', vaultId: 'sample-vault', section: 'overview' });
    expect(parseLocation('/connect/demo/')).toEqual({ kind: 'connect', connectionId: 'demo' });
    expect(parseLocation('/dashboard//')).toMatchObject({ kind: 'not-found' });
  });

  it('rejects unknown sections, extra segments and unrelated paths', () => {
    for (const path of [
      '/dashboard/vaults', '/dashboard/vaults/', '/dashboard/vaults//overview', '/dashboard/vaults/sample-vault/unknown',
      '/dashboard/vaults/sample-vault/Overview', '/dashboard/vaults/sample-vault/overview/extra', '/dashboard/other',
      '/dashboard/settings/extra', '/elsewhere', '/api/v1/vaults', 'relative/path', ''
    ]) {
      expect(parseLocation(path).kind, path).toBe('not-found');
    }
    expect(parseLocation('/elsewhere')).toEqual({ kind: 'not-found', path: '/elsewhere' });
  });

  it('bounds the not-found path kept for display', () => {
    const route = parseLocation(`/${'x'.repeat(500)}`);
    expect(route.kind).toBe('not-found');
    expect(route.kind === 'not-found' && route.path.length).toBeLessThanOrEqual(200);
  });
});

describe('dashboard router encoding', () => {
  const ids = ['plain-id', 'with space', 'a/b', '100%', 'percent%2Fliteral', 'ünï-中文', 'emoji-😀', 'q?x=1#h', 'dot.dot', "quote's"];

  it('encodes each segment and round-trips awkward identifiers', () => {
    for (const id of ids) {
      const route = vaultRoute(id, 'conflicts', { conflictId: `c/${id}` });
      const href = routeHref(route);
      expect(href).toBe(`/dashboard/vaults/${encodeURIComponent(id)}/conflicts/${encodeURIComponent(`c/${id}`)}`);
      expect(href.split('?')[0]).not.toMatch(/\/\/|[ ]/u);
      expect(roundTrip(route)).toEqual(route);
    }
  });

  it('keeps a slash inside an id from creating extra path segments', () => {
    expect(routeHref(vaultRoute('a/b', 'overview'))).toBe('/dashboard/vaults/a%2Fb/overview');
    expect(parseLocation('/dashboard/vaults/a%2Fb/overview')).toEqual({ kind: 'vault', vaultId: 'a/b', section: 'overview' });
    expect(parseLocation('/dashboard/vaults/with%20space/overview')).toEqual({ kind: 'vault', vaultId: 'with space', section: 'overview' });
    expect(parseLocation('/dashboard/vaults/100%25/overview')).toEqual({ kind: 'vault', vaultId: '100%', section: 'overview' });
    expect(parseLocation('/dashboard/vaults/%E4%B8%AD/overview')).toEqual({ kind: 'vault', vaultId: '中', section: 'overview' });
  });

  it('turns malformed escapes into not-found instead of throwing', () => {
    for (const path of [
      '/dashboard/vaults/%E0%A4%A/overview', '/dashboard/vaults/%/overview', '/dashboard/vaults/%zz/overview',
      '/dashboard/vaults/sample-vault/conflicts/%E0%A4%A', '/connect/%', '/dashboard/vaults/%C0%AF/overview'
    ]) {
      expect(() => parseLocation(path)).not.toThrow();
      expect(parseLocation(path).kind, path).toBe('not-found');
    }
  });

  it('produces idempotent canonical hrefs', () => {
    for (const path of ['/dashboard/vaults/ab%63/overview', '/dashboard/vaults/a%2fb/devices/', '/dashboard/vaults/x']) {
      const first = routeHref(parseLocation(path));
      expect(routeHref(parseLocation(first))).toBe(first);
    }
  });
});

describe('dashboard router query handling', () => {
  it('honors devices=revoked only on the devices section', () => {
    expect(parseLocation('/dashboard/vaults/v/devices', '?devices=revoked')).toEqual({ kind: 'vault', vaultId: 'v', section: 'devices', devicesView: 'revoked' });
    expect(routeHref({ kind: 'vault', vaultId: 'v', section: 'devices', devicesView: 'revoked' })).toBe('/dashboard/vaults/v/devices?devices=revoked');
    expect(parseLocation('/dashboard/vaults/v/devices', '?devices=active')).toEqual({ kind: 'vault', vaultId: 'v', section: 'devices' });
    expect(parseLocation('/dashboard/vaults/v/devices', '?devices=other')).toEqual({ kind: 'vault', vaultId: 'v', section: 'devices' });
    for (const section of SECTIONS.filter((value) => value !== 'devices')) {
      expect(parseLocation(`/dashboard/vaults/v/${section}`, '?devices=revoked')).toEqual({ kind: 'vault', vaultId: 'v', section });
      expect(routeHref({ kind: 'vault', vaultId: 'v', section, devicesView: 'revoked' })).toBe(`/dashboard/vaults/v/${section}`);
    }
    expect(roundTrip({ kind: 'vault', vaultId: 'v', section: 'devices', devicesView: 'revoked' })).toEqual({ kind: 'vault', vaultId: 'v', section: 'devices', devicesView: 'revoked' });
    expect(vaultRoute('v', 'overview', { devicesView: 'revoked' })).toEqual({ kind: 'vault', vaultId: 'v', section: 'overview' });
  });

  it('marks the legacy ?vault= query only on the root', () => {
    expect(parseLocation('/', '?vault=old-test-vault')).toEqual({ kind: 'root', legacyVault: 'old-test-vault' });
    expect(parseLocation('/dashboard', '?vault=a%2Fb')).toEqual({ kind: 'root', legacyVault: 'a/b' });
    expect(parseLocation('/dashboard/', '?vault=x')).toEqual({ kind: 'root', legacyVault: 'x' });
    expect(parseLocation('/', '?vault=')).toEqual({ kind: 'root' });
    expect(parseLocation('/', '?other=1')).toEqual({ kind: 'root' });
    expect(parseLocation('/dashboard/vaults/v/overview', '?vault=x')).toEqual({ kind: 'vault', vaultId: 'v', section: 'overview' });
    expect(routeHref({ kind: 'root', legacyVault: 'a/b' })).toBe('/dashboard?vault=a%2Fb');
  });
});

describe('dashboard click interception', () => {
  const origin = 'http://127.0.0.1:4173';
  const click = (overrides: Partial<ClickEventLike> = {}): ClickEventLike => ({
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...overrides
  });
  const anchor = (href: string, attributes: Record<string, string> = {}): AnchorLike => ({
    href,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes
  });
  const local = anchor(`${origin}/dashboard/vaults/v/devices`);

  it('intercepts an unmodified primary same-origin click', () => {
    expect(shouldInterceptClick(click(), local, origin)).toBe(true);
    expect(shouldInterceptClick(click(), anchor(`${origin}/dashboard`, { target: '_self' }), origin)).toBe(true);
  });

  it('leaves non-primary buttons and modified clicks to the browser', () => {
    expect(shouldInterceptClick(click({ button: 1 }), local, origin)).toBe(false);
    expect(shouldInterceptClick(click({ button: 2 }), local, origin)).toBe(false);
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(shouldInterceptClick(click({ [modifier]: true }), local, origin), modifier).toBe(false);
    }
  });

  it('leaves handled, targeted, download and cross-origin links alone', () => {
    expect(shouldInterceptClick(click({ defaultPrevented: true }), local, origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor(local.href, { target: '_blank' }), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor(local.href, { target: 'other-frame' }), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor(local.href, { download: '' }), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor('https://example.invalid/dashboard'), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor('http://127.0.0.1:9999/dashboard'), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor('javascript:void(0)'), origin)).toBe(false);
    expect(shouldInterceptClick(click(), anchor(''), origin)).toBe(false);
  });
});

describe('dashboard navigation helpers', () => {
  type Handler = () => void;
  let url: { pathname: string; search: string };
  let entries: string[];
  let handlers: Handler[];

  const setUrl = (href: string) => {
    const [pathname = '', search = ''] = href.split(/(?=\?)/u);
    url = { pathname, search };
  };

  beforeEach(() => {
    url = { pathname: '/dashboard', search: '' };
    entries = [];
    handlers = [];
    vi.stubGlobal('window', {
      location: new Proxy({}, { get: (_target, key) => (key === 'pathname' ? url.pathname : key === 'search' ? url.search : undefined) }),
      history: {
        state: null,
        pushState: (_state: unknown, _title: string, href: string) => { entries.push(`push:${href}`); setUrl(href); },
        replaceState: (_state: unknown, _title: string, href: string) => { entries.push(`replace:${href}`); setUrl(href); }
      },
      addEventListener: (_type: string, handler: Handler) => { handlers.push(handler); },
      removeEventListener: (_type: string, handler: Handler) => { handlers = handlers.filter((candidate) => candidate !== handler); }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pushes or replaces and notifies subscribers with the re-parsed route', () => {
    const seen: Array<[Route, string]> = [];
    const unsubscribe = subscribe((route, source) => seen.push([route, source]));
    navigate(vaultRoute('a b', 'devices', { devicesView: 'revoked' }));
    navigate({ kind: 'account-settings' }, { replace: true });
    expect(entries).toEqual(['push:/dashboard/vaults/a%20b/devices?devices=revoked', 'replace:/dashboard/settings']);
    expect(seen).toEqual([
      [{ kind: 'vault', vaultId: 'a b', section: 'devices', devicesView: 'revoked' }, 'push'],
      [{ kind: 'account-settings' }, 'replace']
    ]);
    unsubscribe();
  });

  it('forwards popstate once and detaches its window listener with the last subscriber', () => {
    const seen: Array<[Route, string]> = [];
    const first = subscribe((route, source) => seen.push([route, source]));
    const second = subscribe(() => undefined);
    expect(handlers).toHaveLength(1);
    setUrl('/dashboard/vaults/v/history');
    handlers[0]?.();
    expect(seen).toEqual([[{ kind: 'vault', vaultId: 'v', section: 'history' }, 'popstate']]);
    first();
    expect(handlers).toHaveLength(1);
    second();
    expect(handlers).toHaveLength(0);
  });

  it('restores a previous location without notifying subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    restoreLocation('/dashboard/vaults/v/settings');
    expect(entries).toEqual(['push:/dashboard/vaults/v/settings']);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('dashboard history index bookkeeping', () => {
  type Entry = { href: string; state: unknown };
  let stack: Entry[];
  let position: number;
  let popHandlers: Array<() => void>;
  let goCalls: number[];

  const split = (href: string) => {
    const [pathname = '', search = ''] = href.split(/(?=\?)/u);
    return { pathname, search };
  };

  const firePop = () => { for (const handler of [...popHandlers]) handler(); };

  beforeEach(() => {
    stack = [{ href: '/dashboard/vaults/v/overview', state: null }];
    position = 0;
    popHandlers = [];
    goCalls = [];
    vi.stubGlobal('window', {
      location: new Proxy({}, {
        get: (_target, key) => {
          const entry = stack[position] as Entry;
          return key === 'pathname' ? split(entry.href).pathname : key === 'search' ? split(entry.href).search : key === 'hash' ? '' : undefined;
        }
      }),
      history: {
        get state() { return (stack[position] as Entry).state; },
        pushState: (state: unknown, _title: string, href: string) => {
          stack = [...stack.slice(0, position + 1), { href, state }];
          position += 1;
        },
        replaceState: (state: unknown, _title: string, href: string) => { stack[position] = { href, state }; },
        go: (delta: number) => {
          goCalls.push(delta);
          const target = position + delta;
          if (target < 0 || target >= stack.length) return;
          position = target;
          queueMicrotask(firePop);
        }
      },
      addEventListener: (_type: string, handler: () => void) => { popHandlers.push(handler); },
      removeEventListener: (_type: string, handler: () => void) => { popHandlers = popHandlers.filter((candidate) => candidate !== handler); }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('stamps an unindexed entry once and keeps its URL and other state keys', () => {
    stack[0] = { href: '/dashboard/vaults/v/overview?x=1', state: { other: 'kept' } };
    expect(currentHistoryIndex()).toBeNull();
    initHistoryIndex();
    expect(currentHistoryIndex()).toBe(0);
    expect(stack[0]).toEqual({ href: '/dashboard/vaults/v/overview?x=1', state: { other: 'kept', obtsIndex: 0 } });
    initHistoryIndex();
    expect(stack).toHaveLength(1);
  });

  it('increases the index on every push and keeps it on replace', () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    navigate(vaultRoute('v', 'history'));
    expect(stack.map((entry) => (entry.state as { obtsIndex: number }).obtsIndex)).toEqual([0, 1, 2]);
    navigate(vaultRoute('v', 'maintenance'), { replace: true });
    expect(currentHistoryIndex()).toBe(2);
    expect(stack[2]?.href).toBe('/dashboard/vaults/v/maintenance');
  });

  it('preserves existing state keys when replacing', () => {
    stack[0] = { href: '/dashboard/vaults/v/overview', state: { other: 'kept', obtsIndex: 4 } };
    navigate(vaultRoute('v', 'devices'), { replace: true });
    expect(stack[0]?.state).toEqual({ other: 'kept', obtsIndex: 4 });
  });

  it('never pushes an entry equal to the current URL but still replaces in place', () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'overview'));
    expect(stack).toHaveLength(1);
    navigate(vaultRoute('v', 'devices'));
    navigate(vaultRoute('v', 'devices'));
    expect(stack).toHaveLength(2);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    navigate(vaultRoute('v', 'devices'));
    expect(listener).not.toHaveBeenCalled();
    navigate(vaultRoute('v', 'devices'), { replace: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stack).toHaveLength(2);
    unsubscribe();
  });

  it('restarts the index after a push from a truncated position', () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    navigate(vaultRoute('v', 'history'));
    position = 0;
    navigate(vaultRoute('v', 'settings'));
    expect(stack.map((entry) => (entry.state as { obtsIndex: number }).obtsIndex)).toEqual([0, 1]);
  });

  it('undoes a cancelled Back with history.go and swallows exactly that popstate', async () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    const seen: string[] = [];
    const unsubscribe = subscribe((_route, source) => seen.push(source));
    const committedHref = '/dashboard/vaults/v/devices';
    const committedIndex = currentHistoryIndex();
    window.history.go(-1);
    await tick();
    expect(seen).toEqual(['popstate']);
    seen.length = 0;
    goCalls.length = 0;

    expect(undoNavigation(committedHref, committedIndex)).toBe(1);
    expect(goCalls).toEqual([1]);
    await tick();
    expect(seen).toEqual([]);
    expect(stack).toHaveLength(2);
    expect(stack[position]?.href).toBe(committedHref);

    window.history.go(-1);
    await tick();
    expect(seen).toEqual(['popstate']);
    window.history.go(1);
    await tick();
    expect(seen).toEqual(['popstate', 'popstate']);
    expect(stack[position]?.href).toBe(committedHref);
    unsubscribe();
  });

  it('undoes a multi-entry jump with a matching distance', async () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    navigate(vaultRoute('v', 'history'));
    const unsubscribe = subscribe(() => undefined);
    const committedIndex = currentHistoryIndex();
    window.history.go(-2);
    await tick();
    goCalls.length = 0;
    undoNavigation('/dashboard/vaults/v/history', committedIndex);
    expect(goCalls).toEqual([2]);
    await tick();
    expect(stack[position]?.href).toBe('/dashboard/vaults/v/history');
    unsubscribe();
  });

  it('forwards a popstate that does not match the pending undo', async () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    navigate(vaultRoute('v', 'history'));
    const seen: string[] = [];
    const unsubscribe = subscribe((route) => seen.push(routeHref(route)));
    const committedIndex = currentHistoryIndex();
    window.history.go(-1);
    await tick();
    seen.length = 0;
    undoNavigation('/dashboard/vaults/v/history', committedIndex);
    window.history.go(-1);
    await tick();
    expect(seen.length).toBeGreaterThan(0);
    unsubscribe();
  });

  it('falls back to pushing the committed URL for a foreign popped entry', () => {
    initHistoryIndex();
    navigate(vaultRoute('v', 'devices'));
    stack[0] = { href: '/elsewhere', state: null };
    position = 0;
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const result = undoNavigation('/dashboard/vaults/v/devices', 1);
    expect(goCalls).toEqual([]);
    expect(stack[position]?.href).toBe('/dashboard/vaults/v/devices');
    expect(stack).toHaveLength(2);
    expect(result).toBe(currentHistoryIndex());
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('falls back when the committed entry has no index', () => {
    const result = undoNavigation('/dashboard/vaults/v/devices', null);
    expect(goCalls).toEqual([]);
    expect(stack[position]?.href).toBe('/dashboard/vaults/v/devices');
    expect(result).toBe(currentHistoryIndex());
  });

  it('does nothing when the popped entry is the committed one', () => {
    initHistoryIndex();
    expect(undoNavigation('/dashboard/vaults/v/overview', 0)).toBe(0);
    expect(goCalls).toEqual([]);
  });
});
