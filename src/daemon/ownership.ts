/**
 * Ownership attribution policy — pure. The core rule (2026-11-14): whoever
 * STARTS a charging episode owns it; EVCC never manages an episode it did
 * not start. EVCC's own starts are claimed at command time (an 'evcc' row in
 * session_owners); everything else is attributed at the observed
 * charging_start — 'scheduled' when an OEM schedule window is active,
 * otherwise 'manual'. The manual/scheduled split is a documented heuristic
 * (D7): a manual start inside a schedule window labels as 'scheduled', but
 * management behavior is identical for both.
 */
import type { SessionOwnerKind, SessionOwnerRow } from '../store/types.js';

/**
 * How long an EVCC claim written at command time covers a later observed
 * start (the car needs a wake beat, and the daemon detects transitions at
 * its next rich read). A claim whose start never materialized lapses into
 * ordinary attribution.
 */
export const EVCC_CLAIM_WINDOW_MS = 5 * 60_000;

export interface AttributionInput {
  chargingState: string;
  /** The most recent ownership row of the session; null = none yet. */
  lastOwner: SessionOwnerRow | null;
  /** Newest charging_stop event timestamp for the vehicle; null = none. */
  lastStopTsMs: number | null;
}

/**
 * Whether the current charging episode still needs an ownership row. A row
 * covers the episode when it was written after the last charging_stop (an
 * EVCC claim at command time, or an earlier attribution of this same
 * episode). Runs every rich read while charging, so it covers both observed
 * transitions and daemon-restart reconciliation with one rule.
 */
export function needsOwnerAttribution(input: AttributionInput): boolean {
  if (input.chargingState !== 'Charging') return false;
  if (input.lastOwner === null) return true;
  return input.lastStopTsMs !== null && input.lastOwner.fromTsMs <= input.lastStopTsMs;
}

/** Label for a start EVCC did not claim. */
export function foreignOwner(scheduleWindowActive: boolean): Exclude<SessionOwnerKind, 'evcc'> {
  return scheduleWindowActive ? 'scheduled' : 'manual';
}

/**
 * Whether EVCC may manage the session's current episode: it started the
 * episode (or the session predates attribution) and has not released the
 * plug-in. Manual/scheduled episodes are never managed.
 */
export function isManagedEpisode(input: {
  lastOwner: SessionOwnerRow | null;
  releasedTsMs: number | null;
}): boolean {
  if (input.releasedTsMs !== null) return false;
  return input.lastOwner === null || input.lastOwner.owner === 'evcc';
}
