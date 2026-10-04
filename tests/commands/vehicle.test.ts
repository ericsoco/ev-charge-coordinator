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
import {
  chargeFromBattery,
  getBatterySoc,
  getEvBatterySoc,
  setBatteryBuffer,
  setEvChargeLimit,
  startEvCharging,
  stopEvCharging,
} from '../../src/commands/vehicle.js';

/** Minimal fakes; only the methods the handlers actually call are present. */
function makeContext(overrides: {
  franklin?: Record<string, unknown> | null;
  tesla?: Record<string, unknown> | null;
  buffer?: number;
  ask?: (q: string) => Promise<string>;
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
          setChargeLimit: record('setChargeLimit'),
          startCharging: record('startCharging'),
          stopCharging: record('stopCharging'),
          ...overrides.tesla,
        };

  const ctx = {
    franklin,
    tesla,
    store: {
      getBatteryBuffer: async () => overrides.buffer ?? 20,
      setBatteryBuffer: record('setBatteryBuffer'),
    },
    ask: overrides.ask ?? (async () => 'n'),
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
  it('reports insufficient charge without issuing a command', async () => {
    // 60 - 20 = 40, which is below Tesla's 50% floor.
    const { ctx, calls, out } = makeContext({ buffer: 20 });
    const result = await chargeFromBattery(ctx, { offerToStart: false });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('not enough charge available');
    expect(calls.setChargeLimit).toBeUndefined();
    expect(out.join('\n')).toContain('Available for EV: 40%');
    expect(out.join('\n')).toContain('Not enough charge available');
  });

  it('sets the limit when there is enough charge', async () => {
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
    });
    const result = await chargeFromBattery(ctx, { offerToStart: false });

    expect(result.ok).toBe(true);
    expect(calls.setChargeLimit[0]).toEqual([70]);
  });

  // The only behavioural difference between the REPL and the one-shot path is now
  // an explicit argument rather than an accident of which copy you read.
  it('offers to start charging when asked and the user agrees', async () => {
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask: async () => 'y',
    });
    await chargeFromBattery(ctx, { offerToStart: true });

    expect(calls.startCharging).toBeDefined();
  });

  it('never prompts when not asked', async () => {
    const ask = vi.fn(async () => 'y');
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask,
    });
    await chargeFromBattery(ctx, { offerToStart: false });

    expect(ask).not.toHaveBeenCalled();
    expect(calls.startCharging).toBeUndefined();
  });

  it('does not start charging when the user declines', async () => {
    const { ctx, calls } = makeContext({
      franklin: { getStateOfCharge: async () => 90 },
      buffer: 20,
      ask: async () => 'n',
    });
    await chargeFromBattery(ctx, { offerToStart: true });

    expect(calls.startCharging).toBeUndefined();
  });

  it('requires both systems', async () => {
    const { ctx } = makeContext({ franklin: null });
    const result = await chargeFromBattery(ctx, { offerToStart: false });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be connected/);
  });
});

describe('buffer and charging controls', () => {
  it('persists a valid buffer', async () => {
    const { ctx, calls } = makeContext();
    const result = await setBatteryBuffer(ctx, 30);

    expect(result.ok).toBe(true);
    expect(calls.setBatteryBuffer[0]).toEqual([30]);
  });

  it.each([-1, 101, Number.NaN])('rejects buffer %s', async (bad) => {
    const { ctx, calls } = makeContext();
    const result = await setBatteryBuffer(ctx, bad);

    expect(result.ok).toBe(false);
    expect(calls.setBatteryBuffer).toBeUndefined();
  });

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