/**
 * Vehicle and battery command handlers.
 *
 * The percent rule in chargeFromBattery is the one Phase 4b deletes, and it used
 * to exist twice -- once in the Commander action and once in the REPL switch.
 * tests/characterization/legacy-charge-limit.test.ts pins both the truth table
 * and the presence of the inline formula; its source guard now points here, so
 * it still fails if the expression stops being present and Phase 4b's signal
 * that the file should be deleted keeps working.
 */

import {
  describeError,
  log,
  MAX_EV_CHARGE_LIMIT,
  MIN_EV_CHARGE_LIMIT,
  type CommandContext,
  type CommandResult,
} from './context.js';

export async function getEvBatterySoc(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, 'Tesla not connected');
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, 'Getting EV battery state of charge...');
    const soc = await ctx.tesla.getStateOfCharge();
    log(ctx, `EV Battery SoC: ${soc}%`);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function getBatterySoc(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.franklin?.isAuthenticated()) {
    log(ctx, 'Solar battery not connected');
    return { ok: false, error: 'Solar battery not connected' };
  }
  try {
    log(ctx, 'Getting solar battery state of charge...');
    const soc = await ctx.franklin.getStateOfCharge();
    log(ctx, `Solar Battery SoC: ${soc}%`);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function setEvChargeLimit(
  ctx: CommandContext,
  percent: number
): Promise<CommandResult> {
  if (Number.isNaN(percent) || percent < MIN_EV_CHARGE_LIMIT || percent > MAX_EV_CHARGE_LIMIT) {
    const message = `Charge limit must be between ${MIN_EV_CHARGE_LIMIT} and ${MAX_EV_CHARGE_LIMIT}`;
    log(ctx, message);
    return { ok: false, error: message };
  }
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, 'Tesla not connected');
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, 'Setting EV charge limit...');
    await ctx.tesla.setChargeLimit(percent);
    log(ctx, `✓ EV charge limit set to ${percent}%`);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function startEvCharging(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, 'Tesla not connected');
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, 'Starting EV charging...');
    await ctx.tesla.startCharging();
    log(ctx, '✓ EV charging started');
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function stopEvCharging(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, 'Tesla not connected');
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, 'Stopping EV charging...');
    await ctx.tesla.stopCharging();
    log(ctx, '✓ EV charging stopped');
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function setBatteryBuffer(
  ctx: CommandContext,
  percent: number
): Promise<CommandResult> {
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    const message = 'Buffer must be between 0 and 100';
    log(ctx, message);
    return { ok: false, error: message };
  }
  try {
    await ctx.store.setBatteryBuffer(percent);
    log(ctx, `✓ Battery buffer set to ${percent}%`);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Set the EV's charge limit from what the solar battery can spare.
 *
 * offerToStart is what the REPL passed and the Commander path did not. It is
 * now an explicit argument, so the difference is visible in one place instead of
 * being an accident of which copy you happen to read.
 *
 * NOTE (Phase 4b): this percent comparison is dimensionally invalid -- a battery
 * percentage minus a reserve percentage says nothing about the kWh available to
 * a car with a different pack size. It is kept exactly as-is so this refactor
 * stays behaviour-preserving; Phase 4b replaces it with energy math and deletes
 * tests/characterization/legacy-charge-limit.test.ts.
 */
export async function chargeFromBattery(
  ctx: CommandContext,
  options: { offerToStart: boolean }
): Promise<CommandResult> {
  if (!ctx.franklin?.isAuthenticated() || !ctx.tesla?.isAuthenticated()) {
    const message = 'Both FranklinWH and Tesla must be connected';
    log(ctx, message);
    return { ok: false, error: message };
  }

  try {
    log(ctx, 'Getting solar battery state...');
    const batterySoc = await ctx.franklin.getStateOfCharge();
    const buffer = await ctx.store.getBatteryBuffer();

    const availableCharge = Math.max(0, batterySoc - buffer);
    const evLimit = Math.max(MIN_EV_CHARGE_LIMIT, Math.min(MAX_EV_CHARGE_LIMIT, availableCharge));

    log(ctx, `Solar Battery: ${batterySoc}%`);
    log(ctx, `Buffer: ${buffer}%`);
    log(ctx, `Available for EV: ${availableCharge}%`);
    log(ctx, `Setting EV limit to: ${evLimit}%`);

    if (evLimit <= MIN_EV_CHARGE_LIMIT) {
      log(ctx, `Not enough charge available (minimum EV limit is ${MIN_EV_CHARGE_LIMIT}%)`);
      return { ok: false, error: 'not enough charge available' };
    }

    await ctx.tesla.setChargeLimit(evLimit);
    log(ctx, `✓ EV charge limit set to ${evLimit}%`);

    if (options.offerToStart) {
      const answer = await ctx.ask('Start charging now? (y/n): ');
      if (answer.trim().toLowerCase() === 'y') {
        await ctx.tesla.startCharging();
        log(ctx, '✓ EV charging started');
      }
    }
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, `Error: ${message}`);
    return { ok: false, error: message };
  }
}

export async function showStatus(ctx: CommandContext): Promise<CommandResult> {
  log(ctx, '\n--- System Status ---');
  log(ctx, `FranklinWH: ${ctx.franklin?.isAuthenticated() ? '✓ Connected' : '✗ Not connected'}`);
  log(ctx, `Tesla: ${ctx.tesla?.isAuthenticated() ? '✓ Connected' : '✗ Not connected'}`);
  log(ctx, `Battery Buffer: ${await ctx.store.getBatteryBuffer()}%`);
  log(ctx, '');
  return { ok: true };
}