/**
 * Vehicle and battery command handlers.
 *
 * `chargeFromBattery` delegates the limit math to `src/utils/energy.ts`
 * (pure, kWh-based); this file owns only I/O and user-facing reporting.
 */

import {
  describeError,
  log,
  MAX_EV_CHARGE_LIMIT,
  MIN_EV_CHARGE_LIMIT,
  type CommandContext,
  type CommandResult,
} from './context.js';
import * as paint from '../utils/color.js';
import { computeChargeLimit, DEFAULT_ENERGY_CONFIG } from '../utils/energy.js';

export async function getEvBatterySoc(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, paint.warning('Tesla not connected'));
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, paint.info('Getting EV battery state of charge...'));
    const soc = await ctx.tesla.getStateOfCharge();
    log(ctx, paint.success('EV Battery SoC: ') + paint.successBold(`${soc}%`));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function getBatterySoc(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.franklin?.isAuthenticated()) {
    log(ctx, paint.warning('Solar battery not connected'));
    return { ok: false, error: 'Solar battery not connected' };
  }
  try {
    log(ctx, paint.info('Getting solar battery state of charge...'));
    const soc = await ctx.franklin.getStateOfCharge();
    log(ctx, paint.success('Solar Battery SoC: ') + paint.successBold(`${soc}%`));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function setEvChargeLimit(
  ctx: CommandContext,
  percent: number
): Promise<CommandResult> {
  if (Number.isNaN(percent) || percent < MIN_EV_CHARGE_LIMIT || percent > MAX_EV_CHARGE_LIMIT) {
    const message = `Charge limit must be between ${MIN_EV_CHARGE_LIMIT} and ${MAX_EV_CHARGE_LIMIT}`;
    log(ctx, paint.warning(message));
    return { ok: false, error: message };
  }
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, paint.warning('Tesla not connected'));
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, paint.info('Setting EV charge limit...'));
    await ctx.tesla.setChargeLimit(percent);
    log(ctx, paint.success(`✓ EV charge limit set to ${percent}%`));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function startEvCharging(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, paint.warning('Tesla not connected'));
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, paint.info('Starting EV charging...'));
    await ctx.tesla.startCharging();
    log(ctx, paint.success('✓ EV charging started'));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function stopEvCharging(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, 'Tesla not connected');
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, paint.info('Stopping EV charging...'));
    await ctx.tesla.stopCharging();
    log(ctx, paint.success('✓ EV charging stopped'));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function setBatteryBuffer(
  ctx: CommandContext,
  percent: number
): Promise<CommandResult> {
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    const message = 'Buffer must be between 0 and 100';
    log(ctx, paint.warning(message));
    return { ok: false, error: message };
  }
  try {
    await ctx.store.setBatteryBuffer(percent);
    log(ctx, paint.success(`✓ Battery buffer set to ${percent}%`));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

/**
 * Set the EV's charge limit from the energy the solar battery can spare.
 *
 * offerToStart is true on the interactive path (the REPL), false for the
 * one-shot command: after the limit is set, ask whether to begin charging now.
 */
export async function chargeFromBattery(
  ctx: CommandContext,
  options: { offerToStart: boolean }
): Promise<CommandResult> {
  if (!ctx.franklin?.isAuthenticated() || !ctx.tesla?.isAuthenticated()) {
    const message = 'Both FranklinWH and Tesla must be connected';
    log(ctx, paint.warning(message));
    return { ok: false, error: message };
  }

  try {
    log(ctx, paint.info('Getting solar battery state...'));
    const batterySoc = await ctx.franklin.getStateOfCharge();
    if (!Number.isFinite(batterySoc)) {
      // The proxy may omit battery_soc; refuse rather than compute with NaN.
      const message = 'Solar battery SoC unavailable (proxy returned no battery_soc)';
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }
    const buffer = await ctx.store.getBatteryBuffer();

    log(ctx, paint.info('Getting EV state of charge...'));
    const evSoc = await ctx.tesla.getStateOfCharge();
    if (!Number.isFinite(evSoc)) {
      const message = 'EV SoC unavailable';
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }

    const limit = computeChargeLimit(evSoc, batterySoc, {
      ...DEFAULT_ENERGY_CONFIG,
      bufferPercent: buffer,
    });

    log(ctx, paint.positive(`Solar Battery: ${batterySoc}% (buffer ${buffer}%)`));
    log(
      ctx,
      paint.positive(
        `Battery available: ${limit.batteryAvailableKwh.toFixed(1)} kWh - ` +
          `EV now: ${limit.evCurrentKwh.toFixed(1)} kWh -> target ${limit.targetPercent}%`
      )
    );

    if (limit.limitedBy === 'battery') {
      const message =
        `Not enough charge available ` +
        `(spare ${limit.batteryAvailableKwh.toFixed(1)} kWh is below the ` +
        `${DEFAULT_ENERGY_CONFIG.minChargeKwh} kWh minimum)`;
      log(ctx, paint.warning(message));
      return { ok: false, error: 'not enough charge available' };
    }

    if (limit.targetPercent <= evSoc) {
      // Rounding can put the target at or under the current SoC; asking Tesla
      // to set it would gain nothing.
      log(
        ctx,
        paint.info(
          `EV already at or above the computed target ` +
            `(${evSoc}% -> ${limit.targetPercent}%) - nothing to charge`
        )
      );
      return { ok: true };
    }

    if (limit.limitedBy === 'tesla-minimum') {
      log(
        ctx,
        paint.warning(
          `Energy math says ${limit.rawPercent.toFixed(1)}%, below Tesla's ` +
            `${MIN_EV_CHARGE_LIMIT}% minimum - setting ${MIN_EV_CHARGE_LIMIT}%`
        )
      );
    } else if (limit.limitedBy === 'ev-capacity') {
      log(ctx, paint.info(`Target limited by the EV pack capacity (${MAX_EV_CHARGE_LIMIT}%)`));
    }

    await ctx.tesla.setChargeLimit(limit.targetPercent);
    log(ctx, paint.success(`✓ EV charge limit set to ${limit.targetPercent}%`));

    if (options.offerToStart) {
      const answer = await ctx.ask('Start charging now? (y/n): ');
      if (answer.trim().toLowerCase() === 'y') {
        await ctx.tesla.startCharging();
        log(ctx, paint.success('✓ EV charging started'));
      }
    }
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

export async function showStatus(ctx: CommandContext): Promise<CommandResult> {
  log(ctx, paint.info('\n--- System Status ---'));
  log(
    ctx,
    `FranklinWH: ${
      ctx.franklin?.isAuthenticated() ? paint.positive('✓ Connected') : paint.error('✗ Not connected')
    }`
  );
  log(
    ctx,
    `Tesla: ${
      ctx.tesla?.isAuthenticated() ? paint.positive('✓ Connected') : paint.error('✗ Not connected')
    }`
  );
  log(ctx, `Battery Buffer: ${await ctx.store.getBatteryBuffer()}%`);
  log(ctx, '');
  return { ok: true };
}