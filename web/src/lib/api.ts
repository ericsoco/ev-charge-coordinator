/**
 * Typed transport for the daemon's read API (docs/api.md). Same-origin in
 * both environments: the Vite dev proxy folds /api to the daemon in
 * development, the daemon serves the built app in production. The bearer
 * token is stored per device (P2 decision) — localStorage under evcc.apiToken.
 *
 * Response shapes are NOT declared here: they live in src/api/types.ts, the
 * single definition shared with the server, and are re-exported below so web
 * code keeps one import site.
 */
import type {
  NowBattery,
  NowResponse,
  NowSession,
  NowVehicle,
} from '../../../src/api/types';

export type { NowBattery, NowResponse, NowSession, NowVehicle };

const TOKEN_KEY = 'evcc.apiToken';

/** The stored bearer token, or null when the device has none yet. */
export function getApiToken(): string | null {
  const token = window.localStorage.getItem(TOKEN_KEY);
  return token !== null && token.length > 0 ? token : null;
}

export function setApiToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearApiToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

/** The API rejected our token (or none is stored) — render the token panel. */
export class AuthError extends Error {}

/** GET /api/now with the stored bearer token. Throws AuthError on 401. */
export async function fetchNow(): Promise<NowResponse> {
  const token = getApiToken();
  const response = await fetch('/api/now', {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new AuthError('API token missing or invalid');
  if (!response.ok) throw new Error(`read API responded ${response.status}`);
  return (await response.json()) as NowResponse;
}
