/**
 * Page-agnostic load session for API-backed pages — the "shim into any
 * pageload". Two concerns live here so no page owns them:
 *
 * - `session.needsToken` — a module-global flag raised by ANY endpoint's 401.
 *   With URL deeplinks any page can be the first load, so App renders the
 *   token panel off this flag instead of each page re-implementing auth.
 * - `createApiLoader` — the refresh state machine every page load shares:
 *   initial fetch, optional interval poll, refresh on tab focus, keep-last-
 *   good-data on transient errors, and a refetch wave after `saveToken`.
 *
 * `.svelte.ts` because module- and function-level runes require it (Svelte 5).
 */
import { AuthError, setApiToken } from './api';

/** Global auth flag — App renders TokenPanel while this is true. */
export const session = $state({ needsToken: false });

/** Live loaders; saveToken makes every started page refetch after a paste. */
const refetchers = new Set<() => Promise<void>>();

export interface ApiLoader<T> {
  /**
   * Reactive load state. A `$state` object (not loose bindings) — values
   * returned from function scope would snapshot instead of staying reactive.
   */
  state: { data: T | null; error: string | null; loaded: boolean };
  /** One fetch: success fills data; AuthError raises the global flag; other failures keep last good data and set error. */
  refresh(): Promise<void>;
  /** Initial refresh + poll interval + focus refresh + token-save hook. Returns the teardown (onMount's cleanup). */
  start(): () => void;
}

export function createApiLoader<T>(
  fetcher: () => Promise<T>,
  options: { pollMs?: number } = {}
): ApiLoader<T> {
  const state = $state<{ data: T | null; error: string | null; loaded: boolean }>({
    data: null,
    error: null,
    loaded: false,
  });

  async function refresh(): Promise<void> {
    try {
      state.data = await fetcher();
      state.error = null;
    } catch (cause) {
      if (cause instanceof AuthError) {
        session.needsToken = true;
        state.error = null;
      } else {
        state.error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      state.loaded = true;
    }
  }

  function start(): () => void {
    void refresh();
    const timer =
      options.pollMs === undefined
        ? null
        : setInterval(() => void refresh(), options.pollMs);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    refetchers.add(refresh);
    return () => {
      if (timer !== null) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      refetchers.delete(refresh);
    };
  }

  return { state, refresh, start };
}

/** Store the pasted token, clear the global flag, refetch every live loader. */
export function saveToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed === '') return;
  setApiToken(trimmed);
  session.needsToken = false;
  for (const refetch of refetchers) void refetch();
}
