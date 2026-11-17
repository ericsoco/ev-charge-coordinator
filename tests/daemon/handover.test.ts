/**
 * Hand-over stage (2026-11-14 ownership work; + 2026-11-17): user-limit
 * restore at EVCC episode conclusion, on foreign episodes (D4, once per
 * episode), and the prioritize-scheduled-charging release (D5) — window
 * activation and the handOverAt fallback, charging or idle, live + shadow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import { createHandoverStage, type HandoverDeps } from '../../src/daemon/handover.js';
import type { ChargingScheduleSnapshot } from '../../src/types/ev.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';

const VEHICLE = 'VIN-TEST';
const BATTERY = 'GW-TEST';

/** A start-at window whose start lands inside (from, to] of the test ticks. */
function windowAt(startMinute: number): ChargingScheduleSnapshot {
  return {
    windows: [
      {
        kind: 'charging',
        daysOfWeek: null,
        startMinute,
        endMinute: (startMinute + 300) % 1440,
        enabled: true,
      },
    ],
  };
}

describe('createHandoverStage', () => {
  let dir: string;
  let db: DatabaseSync;
  let logs: string[];
  let events: NotificationEvent[];
  let limitCalls: number[];
  let sessionId: number;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-handover-'));
    db = openStore(path.join(dir, 'data.sqlite'));
    logs = [];
    events = [];
    limitCalls = [];
    now = 1_000_000;
    sessionId = sessionStore.openSession(db, {
      vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: now - 60_000,
    });
    homeBattery.insertSample(db, { homeBatteryId: BATTERY, tsMs: 1, socPercent: 60 });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stage(overrides: Partial<HandoverDeps> = {}) {
    return createHandoverStage({
      db,
      vehicleId: VEHICLE,
      autoStart: { enabled: true, filters: [] },
      dryRun: false,
      setChargeLimit: async (percent) => {
        limitCalls.push(percent);
      },
      nowMs: () => now,
      log: (message) => logs.push(message),
      notify: async (event) => {
        events.push(event);
      },
      ...overrides,
    });
  }

  const charging = (chargeLimitPercent: number) => ({
    tsMs: now,
    evSocPercent: 50,
    chargingState: 'Charging',
    chargeLimitPercent,
  });

  it('restores the user limit on a foreign episode, once per episode', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'scheduled', now - 30_000);
    const run = stage();
    await run(charging(50));
    await run(charging(50)); // second tick: no repeat
    expect(limitCalls).toEqual([80]);
    expect(logs.join('\n')).toContain('restored the user charge limit to 80%');
  });

  it('shadow mode logs would-restore and never touches the car', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'manual', now - 30_000);
    await stage({ autoStart: { enabled: false, filters: [] } })(charging(50));
    expect(limitCalls).toEqual([]);
    expect(logs.join('\n')).toContain('would restore the user charge limit to 80%');
  });

  it('never restores on an EVCC-owned episode', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    await stage()(charging(50));
    expect(limitCalls).toEqual([]);
  });

  it('auto-releases when a start-at window activates mid-managed-episode', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    const run = stage({
      getChargingSchedule: async () => windowAt(at.getHours() * 60 + at.getMinutes()),
    });
    await run(charging(50)); // tick before the window opens
    now = at.getTime() + 60_000; // window started in (prev tick, now]
    await run(charging(50));

    const row = sessionStore.openSessionFor(db, VEHICLE)!;
    expect(row.releasedTsMs).toBe(now);
    expect(limitCalls).toEqual([80]); // user limit restored
    expect(logs.join('\n')).toContain('released EVCC control to the scheduled charge');
    expect(events).toMatchObject([{ type: 'session-released', sessionId }]);
  });

  it('the handOverAt fallback releases without schedule introspection', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(22, 30, 0, 0);
    const run = stage({ scheduledCharging: { prioritize: true, leadMinutes: 15, handOverAt: '22:30' } });
    await run(charging(50));
    now = at.getTime() + 60_000;
    await run(charging(50));
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBe(now);
    expect(logs.join('\n')).toContain('handOverAt 22:30');
  });

  it('preference off and released plug-ins never auto-release', async () => {
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    const off = stage({
      getChargingSchedule: async () => windowAt(at.getHours() * 60),
      scheduledCharging: { prioritize: false, leadMinutes: 15, handOverAt: null },
    });
    await off(charging(50));
    now = at.getTime() + 60_000;
    await off(charging(50));
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBeNull();

    sessionStore.releaseSession(db, sessionId, now + 1);
    const managedAgain = stage({
      getChargingSchedule: async () => windowAt(at.getHours() * 60),
    });
    now += 60_000;
    await managedAgain(charging(50));
    expect(events).toHaveLength(0);
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBe(now - 60_000 + 1);
  });

  it('caches the schedule snapshot across ticks (never fetches per tick)', async () => {
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    let fetches = 0;
    const run = stage({
      getChargingSchedule: async () => {
        fetches += 1;
        return windowAt(0); // never active at the test's hours
      },
    });
    await run(charging(50));
    now += 60_000;
    await run(charging(50));
    now += 60_000;
    await run(charging(50));
    expect(fetches).toBe(1);
  });

  // --- Episode-conclusion restore (2026-11-17) ---

  /** An idle-but-plugged observation: EVCC's episode has ended. */
  const idle = (chargeLimitPercent: number, chargingState = 'Complete') => ({
    tsMs: now,
    evSocPercent: 54,
    chargingState,
    chargeLimitPercent,
  });

  /** EVCC claimed the episode `claimAgo` back; the car stopped charging `stopAgo` back. */
  function evccEpisodeConcluded(claimAgo: number, stopAgo: number) {
    sessionStore.recordSessionUserLimit(db, sessionId, 60);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - claimAgo);
    sessionStore.insertEvent(db, { vehicleId: VEHICLE, tsMs: now - stopAgo, kind: 'charging_stop' });
  }

  it('restores the user limit when EVCC’s episode concludes, once per conclusion', async () => {
    evccEpisodeConcluded(300_000, 60_000); // claim 17:08-style, stop 17:41-style
    const run = stage();
    await run(idle(54));
    await run(idle(54)); // second tick: keyed on the stop, no repeat
    expect(limitCalls).toEqual([60]);
    expect(logs.join('\n')).toContain(
      'episode concluded — restored the user charge limit to 60%'
    );
  });

  it('never restores in the start/resume gap (claim newer than the last stop)', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 60);
    sessionStore.insertEvent(db, { vehicleId: VEHICLE, tsMs: now - 600_000, kind: 'charging_stop' });
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 60_000); // claim AFTER the stop
    await stage()(idle(54, 'Stopped')); // decision accepted, car not started yet
    expect(limitCalls).toEqual([]);
  });

  it('never restores while EVCC is still charging', async () => {
    evccEpisodeConcluded(300_000, 60_000);
    await stage()(charging(54));
    expect(limitCalls).toEqual([]);
  });

  it('shadow mode logs a would-restore at conclusion and never touches the car', async () => {
    evccEpisodeConcluded(300_000, 60_000);
    await stage({ autoStart: { enabled: false, filters: [] } })(idle(54));
    expect(limitCalls).toEqual([]);
    expect(logs.join('\n')).toContain('would restore the user charge limit to 60%');
  });

  it('retries a failed conclusion restore on the next tick', async () => {
    evccEpisodeConcluded(300_000, 60_000);
    let attempts = 0;
    const run = stage({
      setChargeLimit: async (percent) => {
        attempts += 1;
        limitCalls.push(percent);
        if (attempts === 1) throw new Error('vehicle asleep');
      },
    });
    await run(idle(54)); // write fails → not keyed → retried
    await run(idle(54));
    expect(limitCalls).toEqual([60, 60]);
    expect(logs.join('\n')).toContain('[hand-over] failed: vehicle asleep');
  });

  // --- Idle hand-over (the Charging gate removed, 2026-11-17) ---

  it('auto-releases when a start-at window activates while the session is idle', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    // Claim with no stop after it: job 1 stays out, isolating the release.
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    const run = stage({
      getChargingSchedule: async () => windowAt(at.getHours() * 60 + at.getMinutes()),
    });
    await run(idle(50, 'Stopped')); // tick before the window opens
    now = at.getTime() + 60_000;
    await run(idle(50, 'Stopped'));
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBe(now);
    expect(limitCalls).toEqual([80]);
    expect(logs.join('\n')).toContain('released EVCC control to the scheduled charge');
    expect(events).toMatchObject([{ type: 'session-released', sessionId }]);
  });

  it('the handOverAt fallback releases while the session is idle', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(22, 30, 0, 0);
    const run = stage({
      scheduledCharging: { prioritize: true, leadMinutes: 15, handOverAt: '22:30' },
    });
    await run(idle(50, 'Stopped'));
    now = at.getTime() + 60_000;
    await run(idle(50, 'Stopped'));
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBe(now);
    expect(logs.join('\n')).toContain('handOverAt 22:30');
  });

  it('departure windows never trigger a hand-over (attribution heuristic only)', async () => {
    sessionStore.recordSessionUserLimit(db, sessionId, 80);
    sessionStore.appendSessionOwner(db, sessionId, 'evcc', now - 30_000);
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    const startMinute = at.getHours() * 60 + at.getMinutes();
    const run = stage({
      getChargingSchedule: async (): Promise<ChargingScheduleSnapshot> => ({
        windows: [
          {
            kind: 'departure',
            daysOfWeek: null,
            startMinute,
            endMinute: (startMinute + 300) % 1440,
            enabled: true,
          },
        ],
      }),
    });
    await run(idle(50, 'Stopped'));
    now = at.getTime() + 60_000;
    await run(idle(50, 'Stopped'));
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBeNull();
    expect(limitCalls).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('the incident night: conclusion restores once, later activation releases without a second write', async () => {
    evccEpisodeConcluded(300_000, 60_000); // EVCC left 54% on the car; user limit 60
    const at = new Date(now);
    at.setHours(23, 0, 0, 0);
    const run = stage({
      getChargingSchedule: async () => windowAt(at.getHours() * 60 + at.getMinutes()),
    });
    await run(idle(54)); // conclusion restore lands while the car is awake
    now = at.getTime() + 60_000;
    await run(idle(60)); // fresh read: window activates → release, limit already home
    expect(limitCalls).toEqual([60]);
    expect(sessionStore.openSessionFor(db, VEHICLE)!.releasedTsMs).toBe(now);
    expect(logs.join('\n')).toContain('episode concluded — restored the user charge limit to 60%');
    expect(logs.join('\n')).toContain('released EVCC control to the scheduled charge');
  });
});
