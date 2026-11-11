/**
 * Typed client for the daemon's read API (docs/api.md). Same-origin in both
 * environments: the Vite dev proxy folds /api to the daemon in development,
 * the daemon serves the built app in production. The bearer token is stored
 * per device (P2 decision) — localStorage under evcc.apiToken.
 */

/** Mirror of GET /api/now's vehicle block (docs/api.md). */
export interface NowVehicle {
  vehicleId: string;
  socPercent: number | null;
  chargingState: string | null;
  chargeLimitSoc: number | null;
  sampleTsMs: number;
  ageMs: number;
}

/** Mirror of GET /api/now's battery block (docs/api.md). */
export interface NowBattery {
  socPercent: number | null;
  powerW: number | null;
  homeLoadW: number | null;
  solarW: number | null;
  gridW: number | null;
  sampleTsMs: number;
  ageMs: number;
}

export interface NowSession {
  id: number;
  plugTsMs: number;
  targetPercent: number | null;
  stopReason: 'target_reached' | 'battery_buffer' | null;
}

/** Mirror of GET /api/now (docs/api.md). */
export interface NowResponse {
  nowMs: number;
  vehicle: NowVehicle | null;
  battery: NowBattery | null;
  session: NowSession | null;
}

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
