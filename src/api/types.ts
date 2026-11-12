/**
 * Response contracts for the read API — the single source of truth for the
 * shapes documented in docs/api.md. Deliberately pure (no imports) so both
 * toolchains consume the same file: the server under NodeNext (`./types.js`)
 * and the web app under bundler resolution (`../../../src/api/types`).
 * Server code defines nothing here — it implements against these; future
 * endpoints (series/sessions/messages) add their envelopes beside them.
 */

/** Mirror of GET /api/now's vehicle block. */
export interface NowVehicle {
  vehicleId: string;
  socPercent: number | null;
  chargingState: string | null;
  chargeLimitSoc: number | null;
  sampleTsMs: number;
  ageMs: number;
}

/** Mirror of GET /api/now's battery block. */
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

/** Mirror of GET /api/now. */
export interface NowResponse {
  nowMs: number;
  vehicle: NowVehicle | null;
  battery: NowBattery | null;
  session: NowSession | null;
}
