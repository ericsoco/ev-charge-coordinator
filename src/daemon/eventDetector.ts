/**
 * Pure transition detector for the EV poller.
 *
 * Turns (previous charging_state, current charging_state) into ordered
 * events. The plugged rule is deliberately state-agnostic — plugged in means
 * `state !== 'Disconnected'` — so future firmware values (e.g. 'Initializing')
 * classify correctly without touching this file. Ordering rule: entry events
 * first (plug_in before charging_start), exit events last (charging_stop
 * before unplug): charging cannot outlive the cable.
 *
 * Total, unlike energy.ts: unreadable input (missing baseline, empty state)
 * yields no events rather than throwing — a mid-tick crash in the daemon is
 * worse than an unobserved transition, and the caller keeps the raw samples.
 * The caller stamps vehicleId/tsMs when persisting; this returns kinds only.
 */
import type { EventKind } from '../store/types.js';

export interface DetectedTransition {
  kind: EventKind;
  fromState: string | null;
  toState: string;
}

const DISCONNECTED = 'Disconnected';
const CHARGING = 'Charging';

/** Plugged in = anything except Disconnected (unknown states included). */
function isPlugged(state: string): boolean {
  return state !== DISCONNECTED;
}

export function detectTransitions(
  prevChargingState: string | null | undefined,
  chargingState: string | null | undefined
): DetectedTransition[] {
  if (!prevChargingState || !chargingState) return [];
  if (prevChargingState === chargingState) return [];

  const events: DetectedTransition[] = [];
  const wasPlugged = isPlugged(prevChargingState);
  const nowPlugged = isPlugged(chargingState);

  if (!wasPlugged && nowPlugged) {
    // Entry: the cable went on. Plug-in first, then charging if it began
    // in the same observed step.
    events.push({ kind: 'plug_in', fromState: prevChargingState, toState: chargingState });
    if (chargingState === CHARGING) {
      events.push({ kind: 'charging_start', fromState: prevChargingState, toState: chargingState });
    }
    return events;
  }

  if (wasPlugged && !nowPlugged) {
    // Exit: the cable came off. Charging stop first — it cannot outlive the
    // cable — then unplug.
    if (prevChargingState === CHARGING) {
      events.push({ kind: 'charging_stop', fromState: prevChargingState, toState: chargingState });
    }
    events.push({ kind: 'unplug', fromState: prevChargingState, toState: chargingState });
    return events;
  }

  // Still plugged (possibly with an unknown state on either side).
  if (prevChargingState !== CHARGING && chargingState === CHARGING) {
    events.push({ kind: 'charging_start', fromState: prevChargingState, toState: chargingState });
  } else if (prevChargingState === CHARGING && chargingState !== CHARGING) {
    events.push({ kind: 'charging_stop', fromState: prevChargingState, toState: chargingState });
  }
  return events;
}