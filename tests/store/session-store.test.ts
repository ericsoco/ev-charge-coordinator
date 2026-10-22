/**
 * SessionStore: event append + CHECK enum, session open/close lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as sessions from '../../src/store/SessionStore.js';

let dir: string;
let db: DatabaseSync;

const VEHICLE = 'VIN-TEST';
const BATTERY = 'GW-TEST';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-sess-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('events', () => {
  it('round-trips a transition', () => {
    const id = sessions.insertEvent(db, {
      vehicleId: VEHICLE,
      tsMs: 1_000,
      kind: 'plug_in',
      fromState: 'Disconnected',
      toState: 'Stopped',
    });
    expect(id).toBeGreaterThan(0);

    const recent = sessions.recentSessions(db, 1); // same shape read path
    expect(recent).toEqual([]); // events are not sessions — no cross-talk

    const row = db
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(id) as unknown as {
      site_id: string;
      kind: string;
      from_state: string;
      to_state: string;
      ts_ms: number;
    };
    expect(row).toMatchObject({
      site_id: 'home',
      kind: 'plug_in',
      from_state: 'Disconnected',
      to_state: 'Stopped',
      ts_ms: 1_000,
    });
  });

  it('accepts every enum kind', () => {
    const kinds = [
      'plug_in',
      'unplug',
      'charging_start',
      'charging_stop',
      'daemon_start',
      'daemon_stop',
    ] as const;
    for (const kind of kinds) {
      expect(
        sessions.insertEvent(db, { vehicleId: VEHICLE, tsMs: 1, kind })
      ).toBeGreaterThan(0);
    }
  });

  it('rejects a kind outside the CHECK enum', () => {
    expect(() =>
      sessions.insertEvent(db, {
        vehicleId: VEHICLE,
        tsMs: 1,
        // TS stops bad kinds at compile time; this probes the storage-level CHECK.
        kind: 'exploded' as never,
      })
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('sessions lifecycle', () => {
  it('opens, exposes, and closes a session', () => {
    const openId = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
    });
    expect(openId).toBeGreaterThan(0);

    const open = sessions.openSessionFor(db, VEHICLE);
    expect(open).toMatchObject({
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
      unplugTsMs: null,
      // aggregates stay NULL while open (P1a never computes them)
      energyKwh: null,
      energyPercent: null,
      elapsedMs: null,
      houseEnergyKwh: null,
      efficiency: null,
    });

    const closedId = sessions.closeOpenSession(db, VEHICLE, 5_000);
    expect(closedId).toBe(openId);
    expect(sessions.openSessionFor(db, VEHICLE)).toBeNull();
  });

  it('closes the most recently opened open session', () => {
    const first = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
    });
    const second = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 2_000,
    });
    expect(sessions.closeOpenSession(db, VEHICLE, 9_000)).toBe(second);
    // The older one is untouched — single-open is the daemon's invariant,
    // so the store does not silently close it too.
    const still = sessions.openSessionFor(db, VEHICLE);
    expect(still?.id).toBe(first);
  });

  it('closeOpenSession with nothing open returns null', () => {
    expect(sessions.closeOpenSession(db, VEHICLE, 1)).toBeNull();
  });

  it('openSessionFor is null when the session closed', () => {
    sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
    });
    sessions.closeOpenSession(db, VEHICLE, 2_000);
    expect(sessions.openSessionFor(db, VEHICLE)).toBeNull();
  });
});

describe('recentSessions', () => {
  it('returns sessions newest-first, capped by limit', () => {
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 100 });
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 300 });
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 200 });

    const recent = sessions.recentSessions(db, 2);
    expect(recent.map((row) => row.plugTsMs)).toEqual([300, 200]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => sessions.recentSessions(db, 0)).toThrow(/limit/);
    expect(() => sessions.recentSessions(db, 1.5)).toThrow(/limit/);
  });
});

describe('finalizeSession', () => {
  it('writes every closing aggregate onto a closed session', () => {
    const id = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
    });
    sessions.closeOpenSession(db, VEHICLE, 61_000);

    expect(
      sessions.finalizeSession(db, id, {
        energyKwh: 12.5,
        energyPercent: 18,
        elapsedMs: 60_000,
        houseEnergyKwh: 14.2,
        efficiency: 12.5 / 14.2,
      })
    ).toBe(id);

    const row = sessions.recentSessions(db, 1)[0];
    expect(row).toMatchObject({
      id,
      energyKwh: 12.5,
      energyPercent: 18,
      elapsedMs: 61_000 - 1_000,
      houseEnergyKwh: 14.2,
    });
    expect(row.efficiency).toBeCloseTo(0.8803, 4);
  });

  it('stores nulls for aggregates that were not computable', () => {
    const id = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 1_000,
    });
    sessions.finalizeSession(db, id, {
      energyKwh: null,
      energyPercent: null,
      elapsedMs: null,
      houseEnergyKwh: null,
      efficiency: null,
    });
    const row = sessions.recentSessions(db, 1)[0];
    expect(row.energyKwh).toBeNull();
    expect(row.efficiency).toBeNull();
  });

  it('returns null for an unknown session id', () => {
    expect(
      sessions.finalizeSession(db, 9_999, {
        energyKwh: 1,
        energyPercent: 1,
        elapsedMs: 1,
        houseEnergyKwh: 1,
        efficiency: 1,
      })
    ).toBeNull();
  });
});

describe('sessionStats / openSessions', () => {
  it('aggregates totals and averages across closed sessions', () => {
    for (const [i, plug] of [1_000, 2_000].entries()) {
      const id = sessions.openSession(db, {
        vehicleId: VEHICLE,
        homeBatteryId: BATTERY,
        plugTsMs: plug,
      });
      sessions.closeOpenSession(db, VEHICLE, plug + 60_000);
      sessions.finalizeSession(db, id, {
        energyKwh: 10 + i,
        energyPercent: 10,
        elapsedMs: 60_000,
        houseEnergyKwh: 12 + i,
        efficiency: (10 + i) / (12 + i),
      });
    }
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 3_000 });

    const stats = sessions.sessionStats(db);
    expect(stats).toMatchObject({ total: 3, open: 1, closed: 2 });
    expect(stats.avgEnergyKwh).toBeCloseTo(10.5, 10);
    expect(stats.avgElapsedMs).toBe(60_000);
    expect(stats.avgEfficiency).toBeCloseTo((10 / 12 + 11 / 13) / 2, 10);
  });

  it('reports zeros and nulls on an empty store', () => {
    expect(sessions.sessionStats(db)).toEqual({
      total: 0,
      open: 0,
      closed: 0,
      avgEnergyKwh: null,
      avgEfficiency: null,
      avgElapsedMs: null,
    });
    expect(sessions.openSessions(db)).toEqual([]);
  });

  it('openSessions returns only open sessions, newest plug first', () => {
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 100 });
    sessions.openSession(db, { vehicleId: VEHICLE, homeBatteryId: BATTERY, plugTsMs: 200 });
    // closeOpenSession closes the newest-plug session (plug order = open order
    // in real flows), so the closed one is the last opened here.
    const closedId = sessions.openSession(db, {
      vehicleId: VEHICLE,
      homeBatteryId: BATTERY,
      plugTsMs: 300,
    });
    sessions.closeOpenSession(db, VEHICLE, 350);

    const open = sessions.openSessions(db);
    expect(open.map((row) => row.id)).not.toContain(closedId);
    expect(open.map((row) => row.plugTsMs)).toEqual([200, 100]);
  });
});
