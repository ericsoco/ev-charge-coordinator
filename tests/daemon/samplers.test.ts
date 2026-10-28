/**
 * Sampler wiring: real tmp store + fake services, tasks driven by calling
 * run() directly (no timers) — deterministic. Covers the workplan's three
 * named cases: rows land, counter deltas feed session aggregates, weather
 * skips without the secret.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as evStore from '../../src/store/EvStore.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import * as weatherStore from '../../src/store/WeatherForecastStore.js';
import { createBatterySampler } from '../../src/daemon/BatterySampler.js';
import { createEvPoller } from '../../src/daemon/EvPoller.js';
import { createWeatherSampler, type ForecastHour } from '../../src/daemon/WeatherSampler.js';
import { formatLocalTimestamp } from '../../src/utils/time.js';
import type { BatteryFullStats } from '../../src/types/battery.js';
import type { EVStatus } from '../../src/types/ev.js';

let dir: string;
let db: DatabaseSync;

const VIN = 'VIN-TEST';
const GW = 'GW-TEST';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-samp-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function franklinFixture(): BatteryFullStats {
  return {
    current: {
      // The franklinwh wire format is kW (live-verified 2026-10-21);
      // BatterySampler converts to the store's W columns.
      solarProduction: 4.2,
      generatorProduction: 0,
      generatorEnabled: false,
      batteryUse: -0.5,
      gridUse: 0,
      homeLoad: 3.7,
      batterySoc: 62.5,
      switch1Load: 0,
      switch2Load: 0,
      v2lUse: 0,
      gridStatus: 'NORMAL',
    },
    totals: {
      batteryCharge: 12.3,
      batteryDischarge: 45.6,
      gridImport: 1.2,
      gridExport: 8.8,
      solar: 30.1,
      generator: 0,
      homeUse: 55.5,
      switch1Use: 0,
      switch2Use: 0,
      v2lExport: 0,
      v2lImport: 0,
    },
  };
}

function evStatus(chargingState: string, soc = 50, energyAdded = 0): EVStatus {
  return {
    vin: VIN,
    displayName: 'Test',
    state: 'online',
    battery: {
      soc,
      chargeLimit: 80,
      isCharging: chargingState === 'Charging',
      chargingState,
      chargeRate: 7.2,
      minutesToFull: 30,
      chargeEnergyAdded: energyAdded,
    },
  };
}

/** Fake EV service: mutable probe/state fields; counts every call. */
function fakeEv(initialState = 'Disconnected') {
  return {
    probe: 'online' as string,
    status: evStatus(initialState),
    probes: 0,
    reads: 0,
    async getVehicleState() {
      this.probes++;
      return { state: this.probe };
    },
    async getStatus() {
      this.reads++;
      return this.status;
    },
  };
}

function eventKinds(): string[] {
  const rows = db
    .prepare('SELECT kind FROM events ORDER BY ts_ms, id')
    .all() as unknown as { kind: string }[];
  return rows.map((row) => row.kind);
}

describe('BatterySampler', () => {
  it('writes the instantaneous sample and the counter snapshot from one read', async () => {
    const task = createBatterySampler({
      db,
      franklin: { getStats: async () => franklinFixture(), reconnect: async () => {} },
      homeBatteryId: GW,
      sampleSec: 120,
      nowMs: () => 5_000,
    });
    await task.run();

    expect(homeBattery.latestSample(db)).toMatchObject({
      siteId: 'home',
      homeBatteryId: GW,
      tsMs: 5_000,
      socPercent: 62.5,
      socKwh: null,
      powerW: -500,
      homeLoadW: 3700,
      solarW: 4200,
      gridW: 0,
    });
    expect(homeBattery.latestCounters(db)).toMatchObject({
      homeBatteryId: GW,
      tsMs: 5_000,
      batteryChargeKwh: 12.3,
      batteryDischargeKwh: 45.6,
      gridImportKwh: 1.2,
      gridExportKwh: 8.8,
      solarKwh: 30.1,
      homeUseKwh: 55.5,
    });
  });

  it('a failed read reconnects, retries, and lands the row', async () => {
    let reads = 0;
    let reconnects = 0;
    const task = createBatterySampler({
      db,
      franklin: {
        getStats: async () => {
          reads += 1;
          if (reads === 1) throw new Error('gateway unreachable');
          return franklinFixture();
        },
        reconnect: async () => {
          reconnects += 1;
        },
      },
      homeBatteryId: GW,
      sampleSec: 120,
      nowMs: () => 7_000,
    });
    await task.run();

    expect(reconnects).toBe(1);
    expect(homeBattery.latestSample(db)).toMatchObject({ tsMs: 7_000, socPercent: 62.5 });
    expect(homeBattery.latestCounters(db)).not.toBeNull();
  });

  it('a read failure whose retry still fails rejects and writes nothing', async () => {
    const task = createBatterySampler({
      db,
      franklin: {
        getStats: async () => {
          throw new Error('gateway unreachable');
        },
        reconnect: async () => {},
      },
      homeBatteryId: GW,
      sampleSec: 120,
    });
    await expect(task.run()).rejects.toThrow('gateway unreachable');
    expect(homeBattery.latestSample(db)).toBeNull();
    expect(homeBattery.latestCounters(db)).toBeNull();
  });

  it('a failed reconnect rejects (the proxy cannot be recovered) and writes nothing', async () => {
    const task = createBatterySampler({
      db,
      franklin: {
        getStats: async () => {
          throw new Error('gateway unreachable');
        },
        reconnect: async () => {
          throw new Error('proxy respawn failed');
        },
      },
      homeBatteryId: GW,
      sampleSec: 120,
    });
    await expect(task.run()).rejects.toThrow('proxy respawn failed');
    expect(homeBattery.latestSample(db)).toBeNull();
    expect(homeBattery.latestCounters(db)).toBeNull();
  });
});

describe('EvPoller', () => {
  function poller(
    ev: ReturnType<typeof fakeEv>,
    nowMs: () => number,
    idleSec = 0,
    log?: (message: string) => void
  ) {
    return createEvPoller({
      db,
      ev,
      vehicleId: VIN,
      homeBatteryId: GW,
      statusPollSec: 1,
      samplePluggedSec: 0,
      sampleIdleSec: idleSec,
      nowMs,
      log,
    });
  }

  it('logs probe transitions and exactly one due-line per cadence window', async () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const ev = fakeEv();
    ev.probe = 'asleep';
    const task = poller(ev, () => now, 300, (message) => lines.push(message));

    await task.run(); // baseline probe — silent except the asleep heartbeat
    expect(lines).toEqual([
      '[ev-poll] vehicle asleep — waiting (poll-while-awake; wakes are observed, not triggered)',
    ]);
    expect(ev.reads).toBe(0);

    ev.probe = 'online';
    now += 60_000;
    await task.run(); // transition logged, first rich read runs (seed)
    expect(lines.slice(1)).toEqual(['[ev-poll] vehicle asleep → online']);
    expect(ev.reads).toBe(1);

    now += 60_000;
    await task.run(); // gated: due-line for this window
    now += 60_000;
    await task.run(); // gated: same window — no duplicate
    const dueLines = lines.filter((message) => message.includes('rich read due'));
    expect(dueLines).toHaveLength(1);
    // Human log lines are local wall-clock (the Zulu/ISO rendering was the bug).
    expect(dueLines[0]).toContain(formatLocalTimestamp(1_000_000 + 60_000 + 300_000));
    expect(dueLines[0]).not.toContain('T00:');
    expect(dueLines[0]).toContain('cadence 300s, idle');

    ev.probe = 'asleep';
    now += 60_000;
    await task.run();
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('[ev-poll] vehicle online → asleep');
    expect(lines[4]).toContain('waiting'); // heartbeat re-armed after the wake
    expect(ev.reads).toBe(1); // gating never reached the rich read
  });

  it('the first online tick seeds a baseline sample with no events', async () => {
    const ev = fakeEv('Disconnected');
    await poller(ev, () => 1_000).run();

    expect(evStore.latestSample(db, VIN)?.chargingState).toBe('Disconnected');
    expect(eventKinds()).toEqual([]);
    expect(sessionStore.openSessionFor(db, VIN)).toBeNull();
  });

  it('an asleep probe skips the rich read entirely', async () => {
    const ev = fakeEv('Charging');
    ev.probe = 'asleep';
    await poller(ev, () => 1_000).run();

    expect(ev.probes).toBe(1);
    expect(ev.reads).toBe(0);
    expect(evStore.latestSample(db, VIN)).toBeNull();
  });

  it('skips the rich read while the idle cadence has not elapsed', async () => {
    let clock = 0;
    const ev = fakeEv('Disconnected');
    const task = poller(ev, () => clock, 300);
    await task.run(); // seeds
    clock = 10_000;
    await task.run();
    expect(ev.reads).toBe(1);
    clock = 301_000;
    await task.run();
    expect(ev.reads).toBe(2);
  });

  it('drives the full plug-in lifecycle: events, session, closing aggregates', async () => {
    let clock = 1_000;
    const ev = fakeEv('Disconnected');
    const task = poller(ev, () => clock);

    await task.run(); // t=1000: baseline (Disconnected, soc 50, 0 kWh)

    clock = 2_000;
    ev.status = evStatus('Stopped', 50, 0);
    await task.run(); // plug_in → session opens

    clock = 3_000;
    ev.status = evStatus('Charging', 52, 2);
    await task.run(); // charging_start

    // House side of the session: counters inside [plug=2000, unplug].
    homeBattery.insertCounters(db, { homeBatteryId: GW, tsMs: 2_000, batteryDischargeKwh: 100 });
    homeBattery.insertCounters(db, { homeBatteryId: GW, tsMs: 4_000, batteryDischargeKwh: 105 });

    clock = 4_000;
    ev.status = evStatus('Charging', 55, 4);
    await task.run();

    clock = 5_000;
    ev.status = evStatus('Disconnected', 56, 4);
    await task.run(); // unplug → close + finalize

    // Charging → Disconnected emits charging_stop then unplug (exit ordering).
    expect(eventKinds()).toEqual(['plug_in', 'charging_start', 'charging_stop', 'unplug']);
    expect(sessionStore.openSessionFor(db, VIN)).toBeNull();

    const session = sessionStore.recentSessions(db, 1)[0];
    expect(session).toMatchObject({
      vehicleId: VIN,
      homeBatteryId: GW,
      plugTsMs: 2_000,
      unplugTsMs: 5_000,
      elapsedMs: 3_000,
    });
    expect(session.energyKwh).toBe(4); // monotonic charge_energy_added in range
    expect(session.houseEnergyKwh).toBe(5); // counter delta in range
    expect(session.energyPercent).toBe(6); // 50 → 56
    expect(session.efficiency).toBeCloseTo(4 / 5, 10);
  });

  it('self-heals a stale open session on the next plug_in', async () => {
    // A session left open by a missed unplug (e.g. car slept through it).
    sessionStore.openSession(db, { vehicleId: VIN, homeBatteryId: GW, plugTsMs: 500 });

    let clock = 1_000;
    const ev = fakeEv('Disconnected');
    const task = poller(ev, () => clock);
    await task.run(); // baseline: Disconnected, no events

    clock = 2_000;
    ev.status = evStatus('Stopped', 50, 0);
    await task.run(); // plug_in with an already-open session

    const recent = sessionStore.recentSessions(db, 2);
    expect(recent).toHaveLength(2);
    // Stale one closed at the observation time; new one open.
    expect(recent[0]).toMatchObject({ plugTsMs: 2_000, unplugTsMs: null });
    expect(recent[1]).toMatchObject({ plugTsMs: 500, unplugTsMs: 2_000 });
  });

  it('reconstructs last state from the store across poller restarts', async () => {
    // First poller observes a plug-in; a fresh poller (restart) must know the
    // car is plugged without re-deriving it from memory.
    let clock = 1_000;
    const ev = fakeEv('Disconnected');
    await poller(ev, () => clock).run();
    clock = 2_000;
    ev.status = evStatus('Stopped');
    await poller(ev, () => clock).run();

    const restarted = poller(ev, () => 3_000);
    expect(evStore.latestSample(db, VIN)?.chargingState).toBe('Stopped');
    await restarted.run(); // Stopped → Stopped: no duplicate plug_in
    expect(eventKinds()).toEqual(['plug_in']);
    expect(sessionStore.recentSessions(db, 5)).toHaveLength(1);
  });

  it('heartbeats while the vehicle sleeps — first observation, then hourly', async () => {
    let now = 2_000_000;
    const lines: string[] = [];
    const ev = fakeEv();
    ev.probe = 'asleep';
    const task = poller(ev, () => now, 300, (message) => lines.push(message));

    await task.run(); // baseline probe — heartbeat fires, nothing else
    const heartbeats = () => lines.filter((message) => message.includes('waiting'));
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0]).toContain('vehicle asleep');
    expect(heartbeats()[0]).toContain('observed, not triggered');

    now += 60_000;
    await task.run(); // still asleep, within the hour: quiet
    expect(heartbeats()).toHaveLength(1);

    now += 3_600_000;
    await task.run(); // hourly repeat
    expect(heartbeats()).toHaveLength(2);
  });

  it('re-arms the heartbeat after the vehicle wakes', async () => {
    let now = 3_000_000;
    const lines: string[] = [];
    const ev = fakeEv();
    ev.probe = 'asleep';
    const task = poller(ev, () => now, 300, (message) => lines.push(message));
    const heartbeats = () => lines.filter((message) => message.includes('waiting'));

    await task.run(); // heartbeat #1
    expect(heartbeats()).toHaveLength(1);

    ev.probe = 'online';
    now += 60_000;
    await task.run(); // wakes: transition + rich read
    ev.probe = 'asleep';
    now += 60_000;
    await task.run(); // sleeps again: the next heartbeat is immediate
    expect(heartbeats()).toHaveLength(2);
  });
});

describe('WeatherSampler', () => {
  const HOURS: ForecastHour[] = [
    { hourTsMs: 1_000, irradianceWm2: 120.5, temperatureC: 18.2, rawJson: '{"t":1}' },
    { hourTsMs: 2_000, irradianceWm2: 0, temperatureC: 12.1, rawJson: '{"t":2}' },
  ];

  it('skips with a one-time notice when the home-location secret is missing', async () => {
    const fetched: number[] = [];
    const logged: string[] = [];
    const task = createWeatherSampler({
      db,
      getHomeLocation: async () => undefined,
      fetchSec: 86_400,
      fetchForecast: async () => {
        fetched.push(1);
        return HOURS;
      },
      log: (message) => logged.push(message),
      nowMs: () => 1,
    });

    await task.run();
    await task.run(); // second skip must not re-log

    expect(fetched).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/home location secret not set/);
    expect(weatherStore.countForecasts(db)).toBe(0);
  });

  it('lands a forecast vintage through the injected fetcher', async () => {
    const task = createWeatherSampler({
      db,
      getHomeLocation: async () => ({ latitude: 37.77, longitude: -122.42 }),
      fetchSec: 86_400,
      fetchForecast: async (lat, lng) => {
        expect(lat).toBe(37.77);
        expect(lng).toBe(-122.42);
        return HOURS;
      },
      nowMs: () => 9_999,
    });
    await task.run();

    const rows = weatherStore.latestVintage(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fetchedTsMs: 9_999, hourTsMs: 1_000, irradianceWm2: 120.5 });
    expect(rows[1].rawJson).toBe('{"t":2}');
  });

  it('a fetch failure rejects and writes nothing (scheduler isolates it)', async () => {
    const task = createWeatherSampler({
      db,
      getHomeLocation: async () => ({ latitude: 1, longitude: 2 }),
      fetchSec: 86_400,
      fetchForecast: async () => {
        throw new Error('open-meteo down');
      },
    });
    await expect(task.run()).rejects.toThrow('open-meteo down');
    expect(weatherStore.countForecasts(db)).toBe(0);
  });

  it('an empty forecast is treated as a failure, not a silent success', async () => {
    const task = createWeatherSampler({
      db,
      getHomeLocation: async () => ({ latitude: 1, longitude: 2 }),
      fetchSec: 86_400,
      fetchForecast: async () => [],
    });
    await expect(task.run()).rejects.toThrow(/no forecast hours/);
  });
});


