/**
 * Shared command handlers.
 *
 * These handlers are why Phase 1.5 extracted them: with the services and
 * credential store injected through CommandContext they can be tested directly,
 * which the inline Commander actions and REPL cases could not be. Both paths call
 * these, so a test here covers the REPL and the one-shot CLI at once.
 *
 * Nothing here reaches a network, a Python proxy, or a real keychain.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/commands/context.js';
import type { ResolvedEnergyConfig } from '../../src/utils/config.js';
import type { EnergyConfig } from '../../src/utils/energy.js';
import {
  chargeFromBattery,
  getBatterySoc,
  getChargingState,
  getEvBatterySoc,
  setEvChargeLimit,
  startEvCharging,
  stopEvCharging,
} from '../../src/commands/vehicle.js';

/** The config the handler runs against unless a test overrides the resolution. */
function makeConfig(buffer = 20): EnergyConfig {
  return {
    batteryCapacityKwh: 13.5,
    evBatteryKwh: 75,
    bufferPercent: buffer,
    chargeEfficiency: 0.9,
  };
}

const ALL_FIELDS_MISSING: (keyof EnergyConfig)[] = [
  'batteryCapacityKwh',
  'evBatteryKwh',
  'bufferPercent',
  'chargeEfficiency',
];

/** Minimal fakes; only the methods the handlers actually call are present. */
function makeContext(overrides: {
  franklin?: Record<string, unknown> | null;
  tesla?: Record<string, unknown> | null;
  buffer?: number;
  ask?: (q: string) => Promise<string>;
  /** Replaces fields of the default complete-config resolution. */
  energyConfig?: Partial<ResolvedEnergyConfig>;
  askNumeric?: (q: string, opts?: { decimal?: boolean }) => Promise<string | null>;
  interactive?: boolean;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Record<string, unknown[][]> = {};

  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls[name] = calls[name] ?? [];
      calls[name].push(args);
    };

  const franklin =
    overrides.franklin === null
      ? null
      : {
          isAuthenticated: () => true,
          getStateOfCharge: async () => 60,
          disconnect: record('franklin.disconnect'),
          ...overrides.franklin,
        };
  const tesla =
    overrides.tesla === null
      ? null
      : {
          isAuthenticated: () => true,
          getStateOfCharge: async () => 55,
          getStatus: async () => ({
            battery: {
              soc: 55,
              chargeLimit: 80,
              isCharging: false,
              chargingState: 'Stopped',
              chargeRate: 0,
              minutesToFull: null,
              batteryRange: 200,
            },
          }),
          setChargeLimit: record('setChargeLimit'),
          startCharging: record('startCharging'),
          stopCharging: record('stopCharging'),
          ...overrides.tesla,
        };

  const cfg = makeConfig(overrides.buffer);
  const resolved: ResolvedEnergyConfig = {
    config: cfg,
    missing: [],
    invalid: [],
    partial: cfg,
    ...overrides.energyConfig,
  };

  const ctx = {
    franklin,
    tesla,
    config: {
      resolve: () => resolved,
      setField: record('setField'),
      save: record('save'),
    },
    ask: overrides.ask ?? (async () => 'n'),
    askNumeric: overrides.askNumeric,
    interactive: overrides.interactive ?? false,
    log: (m: string) => out.push(m),
    errorLog: (m: string) => err.push(m),
  } as unknown as CommandContext;

  return { ctx, out, err, calls };
}

describe('getEvBatterySoc', () => {
  it('reports the SoC when connected', async () => {
    const { ctx, out } = makeContext();
    const result = await getEvBatterySoc(ctx);

    expect(result.ok).toBe(true);
    expect(out.join('\n')).toContain('EV Battery SoC: 55%');
  });

  it('fails cleanly when Tesla is absent, without calling the service', async () => {
    const { ctx, calls } = makeContext({ tesla: null });
    const result = await getEvBatterySoc(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Tesla not connected');
    expect(calls.setChargeLimit).toBeUndefined();
  });
});

describe('getChargingState', () => {
  it('reports a charging vehicle with its rate and time to full', async () => {
    const { ctx, out } = makeContext({
      tesla: {
        getStatus: async () => ({
          battery: {
            soc: 42,
            chargeLimit: 80,
            isCharging: true,
            chargingState: 'Charging',
            chargeRate: 30,
            minutesToFull: 45,
            batteryRange: 150,
          },
        }),
      },
    });
    const result = await getChargingState(ctx);

    expect(result.ok).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('Charging state: Charging');
    expect(text).toContain('Battery: 42% (charge limit 80%)');
    expect(text).toContain('Charge rate: 30');
    expect(text).toContain('Minutes to full: 45');
  });

  it('omits the rate lines when the vehicle is not charging', async () => {
    const { ctx, out } = makeContext();
    const result = await getChargingState(ctx);

    expect(result.ok).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('Charging state: Stopped');
    expect(text).toContain('Battery: 55% (charge limit 80%)');
    expect(text).not.toContain('Charge rate');
  });

  it('fails cleanly when Tesla is absent, without calling the service', async () => {
    const { ctx, calls } = makeContext({ tesla: null });
    const result = await getChargingState(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Tesla not connected');
    expect(calls.setChargeLimit).toBeUndefined();
  });

  it('surfaces a sleeping-vehicle 408 verbatim (reads do not wake)', async () => {
    const { ctx, out } = makeContext({
      tesla: {
        getStatus: async () => {
          throw new Error('HTTP 408: vehicle unavailable: vehicle is offline or asleep');
        },
      },
    });
    const result = await getChargingState(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('408');
    expect(out.join('\n')).toContain('Error: HTTP 408');
  });
});

describe('setEvChargeLimit', () => {
  it('forwards a valid limit', async () => {
    const { ctx, calls, out } = makeContext();
    const result = await setEvChargeLimit(ctx, 80);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([80]);
    expect(out.join('\n')).toContain('✓ EV charge limit set to 80%');
  });

  // Tesla rejects anything under 50, so the floor is enforced before the call
  // rather than clamping silently into a limit the user did not ask for.
  it.each([49, 0, 101, Number.NaN])('rejects %s without calling Tesla', async (bad) => {
    const { ctx, calls } = makeContext();
    const result = await setEvChargeLimit(ctx, bad);

    expect(result.ok).toBe(false);
    expect(calls.setChargeLimit).toBeUndefined();
  });

  it('surfaces a service failure as a result, not a throw', async () => {
    const { ctx, out } = makeContext({
      tesla: {
        setChargeLimit: async () => {
          throw new Error('vehicle asleep');
        },
      },
    });
    const result = await setEvChargeLimit(ctx, 80);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('vehicle asleep');
    expect(out.join('\n')).toContain('Error: vehicle asleep');
  });
});

describe('chargeFromBattery', () => {
  it('fails with the reason when the battery sits at its buffer (no spare)', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 20 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Not enough energy to charge: the solar battery has no energy above its 20% buffer'
    );
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Not enough energy to charge');
    expect(out.join('\n')).toContain('Battery available: 0.0 kWh');
  });

  it('fails when the spare cannot raise the rounded limit', async () => {
    // 0.27 kWh spare moves the raw target to 55.32%, which rounds to 55% --
    // exactly where the EV already is.
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 22 },
      tesla: { getStateOfCharge: async () => 55 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot raise the EV charge limit above its current 55%');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Battery available: 0.3 kWh');
  });

  it('sets the kWh-derived limit when there is enough charge', async () => {
    // 90% - 20% buffer = 9.45 kWh spare, x0.9 = 8.505 kWh delivered onto
    // 41.25 kWh (55% of 75) -> 49.755 kWh = 66.34% -> 66%.
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([66]);
    expect(out.join('\n')).toContain(
      'Battery available: 9.4 kWh - EV now: 41.3 kWh -> target 66%'
    );
  });

  it('proceeds on a tiny spare that moves the target (no minimum threshold)', async () => {
    // 0.27 kWh above the buffer used to abort at the minChargeKwh threshold;
    // now only the target moving matters: 50.4% -> 51%.
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 22 },
      tesla: { getStateOfCharge: async () => 50.4 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([51]);
  });

  it('folds the EV SoC into the limit', async () => {
    // EV at 80% (60 kWh) + 8.505 kWh -> 68.505 kWh = 91.34% -> 91%.
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      tesla: { getStateOfCharge: async () => 80 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([91]);
  });

  it("falls back to Tesla's 50% floor and says why", async () => {
    // 40% - 20% buffer = 2.7 kWh spare; EV at 20% lands at raw 23.2%.
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 40 },
      tesla: { getStateOfCharge: async () => 20 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([50]);
    expect(out.join('\n')).toContain("below Tesla's 50% minimum");
  });

  it('refuses to compute when the proxy omits battery_soc', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => undefined as unknown as number },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Solar battery SoC unavailable');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Solar battery SoC unavailable');
  });

  it('refuses to compute when the EV SoC is unreadable', async () => {
    const { ctx, calls, out } = makeContext({
      tesla: { getStateOfCharge: async () => undefined as unknown as number },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('EV SoC unavailable');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('EV SoC unavailable');
  });

  it('fails when the EV is already full, rather than writing a no-op limit', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      tesla: { getStateOfCharge: async () => 100 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Cannot charge: the EV is already fully charged');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('the EV is already fully charged');
  });

  // The flags are the consent model, identical in the REPL and one-shot path.
  it('sets the limit without starting (or prompting) when no TTY is attached', async () => {
    const ask = vi.fn(async () => 'y');
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask,
      interactive: false,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([66]);
    // Scripted runs must never block on stdin, even for a would-be 'y'.
    expect(ask).not.toHaveBeenCalled();
    expect(calls.startCharging).toBeUndefined();
  });

  it('prompts after setting the limit and starts on y, with no confirmation line', async () => {
    const ask = vi.fn(async () => 'y');
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask,
      interactive: true,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(ask).toHaveBeenCalledWith('Start charging now? (y/n): ');
    expect(calls.setChargeLimit[0]).toEqual([66]);
    expect(calls.startCharging).toBeDefined();
    expect(out.join('\n')).toContain('Starting EV charging...');
    // The start is announced, not confirmed afterwards.
    expect(out.join('\n')).not.toContain('✓ EV charging started');
  });

  it('stops after the limit when the prompt is declined', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask: async () => 'n',
      interactive: true,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([66]);
    expect(calls.startCharging).toBeUndefined();
    expect(out.join('\n')).not.toContain('Starting EV charging...');
  });

  it('starts charging when --start is given, after setting the limit, without prompting', async () => {
    const ask = vi.fn(async () => 'n');
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask,
      interactive: true,
    });
    const result = await chargeFromBattery(ctx, { start: true });

    expect(result.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(calls.setChargeLimit[0]).toEqual([66]);
    expect(calls.startCharging).toBeDefined();
    expect(out.join('\n')).toContain('Starting EV charging...');
    expect(out.join('\n')).not.toContain('✓ EV charging started');
  });

  it('sends nothing on a dry run, but reports the target', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit).toBeUndefined();
    expect(calls.startCharging).toBeUndefined();
    expect(out.join('\n')).toContain('✓ Dry run: would set the EV charge limit to 66%');
  });

  it('rejects --start combined with --dry-run before touching anything', async () => {
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx, { start: true, dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('--start and --dry-run are mutually exclusive');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(calls.startCharging).toBeUndefined();
    expect(out.join('\n')).toContain('mutually exclusive');
  });

  it('requires both systems', async () => {
    const { ctx } = makeContext({ franklin: null });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be connected/);
  });

  it('echoes hand-edit problems and touches no service when config is invalid', async () => {
    const { ctx, calls, out } = makeContext({
      energyConfig: {
        config: null,
        missing: [],
        invalid: ['config.json: chargeEfficiency = 1.5 (must be in (0, 1])'],
        partial: {},
      },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid energy config');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('chargeEfficiency = 1.5 (must be in (0, 1])');
  });

  it('fails with instructions when config is missing and no TTY is attached', async () => {
    const { ctx, calls, out } = makeContext({
      energyConfig: { config: null, missing: ALL_FIELDS_MISSING, invalid: [], partial: {} },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('energy config incomplete');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Energy config incomplete');
    expect(out.join('\n')).toContain('config --set-<field>');
  });

  it('prompts for missing values on first run, saves config.json, and proceeds', async () => {
    const answers = ['13.5', '75', '20', '0.9'];
    const asked: string[] = [];
    const { ctx, calls, out } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      energyConfig: { config: null, missing: ALL_FIELDS_MISSING, invalid: [], partial: {} },
      interactive: true,
      askNumeric: async (q) => {
        asked.push(q);
        return answers[asked.length - 1] ?? null;
      },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain('battery capacity'); // schema order starts with the house pack
    expect(calls.save[0][0]).toEqual(makeConfig());
    expect(calls.setChargeLimit[0]).toEqual([66]); // same math as the complete-config path
    expect(out.join('\n')).toContain('Energy config saved');
  });

  it('prompts only for the fields that are missing', async () => {
    const asked: string[] = [];
    const { ctx, calls } = makeContext({
      energyConfig: {
        config: null,
        missing: ['chargeEfficiency'],
        invalid: [],
        partial: {
          batteryCapacityKwh: 13.5,
          evBatteryKwh: 75,
          bufferPercent: 20,
        },
      },
      interactive: true,
      askNumeric: async (q) => {
        asked.push(q);
        return '0.9';
      },
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(calls.save[0][0]).toEqual(makeConfig()); // the answered field joins the loaded ones
  });

  it('writes nothing when the first-run prompt is cancelled', async () => {
    const { ctx, calls, out } = makeContext({
      energyConfig: { config: null, missing: ALL_FIELDS_MISSING, invalid: [], partial: {} },
      interactive: true,
      askNumeric: async () => null,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('energy config setup cancelled');
    expect(calls.save).toBeUndefined();
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Cancelled');
  });

  it('re-asks when an answer fails validation', async () => {
    const answers = ['-5', '13.5', '75', '20', '0.9'];
    let prompts = 0;
    const { ctx, calls, out } = makeContext({
      energyConfig: { config: null, missing: ALL_FIELDS_MISSING, invalid: [], partial: {} },
      interactive: true,
      askNumeric: async () => answers[prompts++] ?? null,
    });
    const result = await chargeFromBattery(ctx);

    expect(result.ok).toBe(true);
    expect(prompts).toBe(5); // the out-of-range answer cost one extra prompt
    expect(calls.save[0][0]).toEqual(makeConfig());
    expect(out.join('\n')).toContain('batteryCapacityKwh = -5 (must be > 0)');
  });
});

describe('buffer and charging controls', () => {
  it('starts and stops charging', async () => {
    const start = makeContext();
    await startEvCharging(start.ctx);
    expect(start.calls.startCharging).toBeDefined();

    const stop = makeContext();
    await stopEvCharging(stop.ctx);
    expect(stop.calls.stopCharging).toBeDefined();
  });

  it('reports the solar SoC', async () => {
    const { ctx, out } = makeContext();
    const result = await getBatterySoc(ctx);

    expect(result.ok).toBe(true);
    expect(out.join('\n')).toContain('Solar Battery SoC: 60%');
  });
});

describe('handlers route all output through the injected sinks', () => {
  // Output must go through ctx.log so it is capturable in tests; a stray
  // console.log would print straight past an assertion.
  it('never writes to console directly', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { ctx } = makeContext();
      await getEvBatterySoc(ctx);
      await getBatterySoc(ctx);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});