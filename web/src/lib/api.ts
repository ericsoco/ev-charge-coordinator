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
  SeriesMetricName,
  SeriesResult,
  SessionSummary,
  SessionsResponse,
} from '../../../src/api/types';

export type {
  NowBattery,
  NowResponse,
  NowSession,
  NowVehicle,
  SeriesMetricName,
  SeriesResult,
  SessionSummary,
  SessionsResponse,
};

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

/** GET a read-API route with the stored bearer token. Throws AuthError on 401. */
async function apiGet<T>(path: string): Promise<T> {
  const token = getApiToken();
  const response = await fetch(path, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new AuthError('API token missing or invalid');
  if (!response.ok) throw new Error(await failureMessage(response));
  return (await response.json()) as T;
}

/** Status line plus the server's {error} text when the body carries one. */
async function failureMessage(response: Response): Promise<string> {
  const base = `read API responded ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? `${base}: ${body.error}` : base;
  } catch {
    return base;
  }
}

/** GET /api/now. */
export async function fetchNow(): Promise<NowResponse> {
  return apiGet<NowResponse>('/api/now');
}

/** GET /api/series for one metric over [fromMs, toMs]; server auto-buckets. */
export async function fetchSeries(
  metric: SeriesMetricName,
  fromMs: number,
  toMs: number
): Promise<SeriesResult> {
  // dataZoom windows are fractional (percent→time math); the API takes
  // integer epoch ms and 400s on anything else.
  const query = new URLSearchParams({
    metric,
    from: String(Math.round(fromMs)),
    to: String(Math.round(toMs)),
  });
  return apiGet<SeriesResult>(`/api/series?${query}`);
}

/** GET /api/sessions page (newest first). */
export async function fetchSessions(limit: number, offset: number): Promise<SessionsResponse> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return apiGet<SessionsResponse>(`/api/sessions?${query}`);
}
