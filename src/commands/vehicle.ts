/**
 * Vehicle and battery command handlers.
 *
 * `chargeFromBattery` resolves energy config from config.json (prompting for
 * missing values on a first run) and delegates the limit math to
 * `src/utils/energy.ts`; this file owns I/O and user-facing reporting.
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
import { describeConfigProblems, energyConfigPath } from '../utils/config.js';
import {
  computeChargeLimit,
  energyConfigFieldProblem,
  type EnergyConfig,
} from '../utils/energy.js';

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
    ctx.config.setField({ bufferPercent: percent });
    log(ctx, paint.success(`✓ Battery buffer set to ${percent}%`));
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

/** First-run questions in schema order. The hints are advice, not defaults. */
const CONFIG_QUESTIONS: Record<keyof EnergyConfig, string> = {
  batteryCapacityKwh: 'FranklinWH battery capacity in kWh (aPower 2 is 13.5): ',
  evBatteryKwh: 'EV battery capacity in kWh (Model Y is about 75): ',
  bufferPercent: 'Battery buffer to keep in reserve, percent (0-100): ',
  chargeEfficiency: 'Charge efficiency, 0-1 (0.9 covers typical losses): ',
  minChargeKwh: 'Minimum spare energy to bother charging, kWh (1 is typical): ',
};

type ConfigOutcome = { config: EnergyConfig } | { error: string };

/**
 * Config for one command run: echo-and-fail on invalid values (a hand-edit
 * mistake should be fixed, not papered over), prompt for missing ones on a
 * TTY and write config.json, echo-and-fail when there is no TTY.
 */
async function requireEnergyConfig(ctx: CommandContext): Promise<ConfigOutcome> {
  const resolved = ctx.config.resolve();
  if (resolved.config !== null) return { config: resolved.config };

  if (resolved.invalid.length > 0) {
    for (const line of describeConfigProblems(resolved)) log(ctx, paint.error(line));
    return { error: 'invalid energy config' };
  }

  const problemLines = describeConfigProblems(resolved);
  const askNumeric = ctx.askNumeric;
  if (!ctx.interactive || askNumeric === undefined) {
    for (const line of problemLines) log(ctx, paint.warning(line));
    log(ctx, paint.info('Set values with config --set-<field> <value>, or edit the file directly.'));
    return { error: 'energy config incomplete' };
  }

  for (const line of problemLines) log(ctx, paint.info(line));
  const answers: Partial<EnergyConfig> = { ...resolved.partial };
  for (const field of resolved.missing) {
    const value = await askForConfigField(ctx, field, askNumeric);
    if (value === null) {
      log(ctx, paint.warning('Cancelled -- energy config not written.'));
      return { error: 'energy config setup cancelled' };
    }
    answers[field] = value;
  }

  ctx.config.save(answers as EnergyConfig);
  log(ctx, paint.success(`✓ Energy config saved to ${energyConfigPath()}`));
  return { config: answers as EnergyConfig };
}

/** Ask for one config value until it parses and validates; null on cancel. */
async function askForConfigField(
  ctx: CommandContext,
  field: keyof EnergyConfig,
  askNumeric: NonNullable<CommandContext['askNumeric']>
): Promise<number | null> {
  for (;;) {
    const raw = await askNumeric(CONFIG_QUESTIONS[field], { decimal: true });
    if (raw === null) return null;
    if (raw === '') {
      log(ctx, paint.warning('Enter a number (ESC to cancel).'));
      continue;
    }
    const value = Number(raw);
    const problem = energyConfigFieldProblem(field, value);
    if (problem === null) return value;
    log(ctx, paint.warning(`${problem} -- try again (ESC to cancel).`));
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
    // Config first: report a broken or missing config before touching any
    // service (first-run prompts must not run after waking the vehicle).
    const outcome = await requireEnergyConfig(ctx);
    if ('error' in outcome) return { ok: false, error: outcome.error };
    const cfg = outcome.config;

    log(ctx, paint.info('Getting solar battery state...'));
    const batterySoc = await ctx.franklin.getStateOfCharge();
    if (!Number.isFinite(batterySoc)) {
      // The proxy may omit battery_soc; refuse rather than compute with NaN.
      const message = 'Solar battery SoC unavailable (proxy returned no battery_soc)';
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }

    log(ctx, paint.info('Getting EV state of charge...'));
    const evSoc = await ctx.tesla.getStateOfCharge();
    if (!Number.isFinite(evSoc)) {
      const message = 'EV SoC unavailable';
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }

    const limit = computeChargeLimit(evSoc, batterySoc, cfg);

    log(ctx, paint.positive(`Solar Battery: ${batterySoc}% (buffer ${cfg.bufferPercent}%)`));
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
        `${cfg.minChargeKwh} kWh minimum)`;
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
  const energy = ctx.config.resolve();
  let buffer = '(unset)';
  if (energy.config) buffer = `${energy.config.bufferPercent}%`;
  else if (energy.invalid.length > 0) buffer = '(invalid -- see `config`)';
  log(ctx, `Battery Buffer: ${buffer}`);
  log(ctx, '');
  return { ok: true };
}