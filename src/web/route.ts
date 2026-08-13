import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The address bar as selection state.
 *
 * Which conversation is open, and which of its two views, used to live only in
 * React state: every reload dropped you back on whatever trace happened to be
 * newest, and a captured session could not be linked to or reopened. Both facts
 * are cheap to spell in a URL, so they are spelled there and the components read
 * them back — there is no second copy to keep in sync.
 *
 * Deliberately hand-rolled rather than a router dependency. Two shapes exist
 * (`/` and `/c/<id>`, plus a `view` query), the SPA already falls back to
 * `index.html` for unknown paths in both dev (Vite) and production
 * (`src/server/api.ts`), and a router would be more code than the thing it
 * replaces.
 */

export type RouteView = 'trace' | 'network';

export interface Route {
  /** The conversation the UI is scoped to, when one is selected. */
  conversationId?: string;
  view: RouteView;
}

/** Anything else — including `/` — means "no conversation picked yet". */
const CONVERSATION_PREFIX = 'c/';

/** The default view is left out of the URL, so the common address stays `/c/<id>`. */
const DEFAULT_VIEW: RouteView = 'trace';

/**
 * The path the app is mounted at, with a leading and trailing slash.
 *
 * `/` when the devtools server serves the SPA, and `/<repo>/` for the static
 * preview on project Pages. Read from Vite's `BASE_URL` rather than passed in,
 * because it is fixed at build time — but every entry point takes it as a
 * defaulted argument so the routing rules stay testable under plain Node, where
 * `import.meta.env` does not exist.
 */
export function basePath(): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export function readRoute(
  location: { pathname: string; search: string },
  base: string = basePath(),
): Route {
  const view = new URLSearchParams(location.search).get('view');
  const conversationId = readConversationId(location.pathname, base);
  return {
    ...(conversationId ? { conversationId } : {}),
    view: view === 'network' ? 'network' : DEFAULT_VIEW,
  };
}

function readConversationId(pathname: string, base: string): string | undefined {
  const prefix = `${base}${CONVERSATION_PREFIX}`;
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length).replace(/\/+$/, '');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    // A hand-typed address can hold a stray `%`. The id it names will simply
    // not be found, which is already handled — throwing here would blank the app.
    return raw;
  }
}

export function routeHref(
  { conversationId, view }: Route,
  base: string = basePath(),
): string {
  const path = conversationId
    ? `${base}${CONVERSATION_PREFIX}${encodeURIComponent(conversationId)}`
    : base;
  return view === DEFAULT_VIEW ? path : `${path}?view=${encodeURIComponent(view)}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.conversationId === b.conversationId && a.view === b.view;
}

export interface NavigateOptions {
  /**
   * Rewrites the current entry instead of adding one. Used for everything the
   * app decides on its own — following the newest trace, correcting an address
   * whose conversation is gone — so Back returns to the previous *page*, not
   * through a queue of moves the user never made.
   */
  replace?: boolean;
}

export type Navigate = (
  next: Route | ((previous: Route) => Route),
  options?: NavigateOptions,
) => void;

/**
 * Binds `Route` to the browser's history.
 *
 * The write happens in `navigate` rather than in an effect on the resulting
 * state: under StrictMode an effect (and a state updater) runs twice, and a
 * doubled `pushState` would need two Back presses to undo one click.
 */
export function useUrlRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() => readRoute(window.location));
  // The authority during a burst of navigations: `route` is a render snapshot
  // and would be stale for a second call in the same tick.
  const current = useRef(route);

  useEffect(() => {
    const onPopState = () => {
      const next = readRoute(window.location);
      current.current = next;
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback<Navigate>((next, options = {}) => {
    const previous = current.current;
    const value = typeof next === 'function' ? next(previous) : next;
    if (sameRoute(previous, value)) return;
    current.current = value;
    const href = routeHref(value);
    if (options.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    setRoute(value);
  }, []);

  return [route, navigate];
}
