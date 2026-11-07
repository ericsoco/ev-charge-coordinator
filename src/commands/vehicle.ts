/**
 * Vehicle and battery command handlers.
 *
 * `chargeFromBattery` resolves energy config from config.json (prompting for
 * missing values on a first run) and delegates the limit math to
 * `src/utils/energy.ts`; this file owns I/O and user-facing reporting.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import {
  describeError,
  log,
  type CommandContext,
  type CommandResult,
} from './context.js';
import type { Session } from './session.js';
import * as paint from '../utils/color.js';
import { describeConfigProblems, energyConfigPath } from '../utils/config.js';
import {
  DEFAULT_CHARGE_LIMIT_BOUNDS,
  computeChargeLimit,
  energyConfigFieldProblem,
  type EnergyConfig,
} from '../utils/energy.js';
import { storePath, openStoreReadOnly } from '../store/database.js';
import { recentEfficiencySamples } from '../store/SessionStore.js';
import {
  EFFICIENCY_FETCH_LIMIT,
  applyEfficiency,
  efficiencyClause,
  estimateEfficiency,
  type ObservedEfficiency,
} from '../utils/efficiency.js';
import * as weatherStore from '../store/WeatherForecastStore.js';
import { resolveDaemonConfig } from '../utils/daemonConfig.js';
import {
  DEFAULT_WEATHER_POLICY,
  weatherAdjustment,
  type WeatherAdjustment,
  type WeatherPolicy,
} from '../utils/weather.js';

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
  const { minPercent, maxPercent } = DEFAULT_CHARGE_LIMIT_BOUNDS;
  if (Number.isNaN(percent) || percent < minPercent || percent > maxPercent) {
    const message = `Charge limit must be between ${minPercent} and ${maxPercent}`;
    log(ctx, paint.warning(message));
    return { ok: false, error: message };
  }
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, paint.warning('Tesla not connected'));
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(
      ctx,
      paint.info(
        'Setting the EV charge limit (waking the vehicle if needed; asleep cars take up to a minute)...'
      )
    );
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
    log(ctx, paint.info('Starting EV charging (waking the vehicle if needed; asleep cars take up to a minute)...'));
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
    log(ctx, paint.info('Stopping EV charging (waking the vehicle if needed)...'));
    await ctx.tesla.stopCharging();
    log(ctx, paint.success('✓ EV charging stopped'));
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
 * Read the vehicle's charging state via getStatus(), which is already the
 * narrow `vehicle_data?endpoints=charge_state` read.
 *
 * Like every Tesla read, this does NOT wake the vehicle: an asleep car answers
 * HTTP 408 and describeError surfaces the mapped message, which now carries
 * asleep/timeout advice (wake happens only on the three command paths -- see
 * the workplan's wake inventory).
 */
export async function getChargingState(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.tesla?.isAuthenticated()) {
    log(ctx, paint.warning('Tesla not connected'));
    return { ok: false, error: 'Tesla not connected' };
  }
  try {
    log(ctx, paint.info('Getting charging state...'));
    const status = await ctx.tesla.getStatus();
    const battery = status.battery;
    log(ctx, paint.success(`Charging state: ${battery.chargingState}`));
    log(ctx, paint.success(`Battery: ${battery.soc}% (charge limit ${battery.chargeLimit}%)`));
    if (battery.isCharging) {
      log(ctx, paint.success(`Charge rate: ${battery.chargeRate ?? 'n/a'}`));
      log(ctx, paint.success(`Minutes to full: ${battery.minutesToFull ?? 'n/a'}`));
    }
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

/** Whether to apply the computed plan; only called on an interactive TTY. */
async function confirmStartNow(ctx: CommandContext, targetPercent: number): Promise<boolean> {
  const answer = (
    await ctx.ask(`Set the EV charge limit to ${targetPercent}% and start charging? (y/n): `)
  ).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * Set the EV's charge limit from the energy the solar battery can spare, and
 * start charging only with consent.
 *
 * Consent: `start` sets the limit and starts charging without prompting;
 * `dryRun` computes and prints the plan, sending nothing. With neither flag,
 * a terminal is shown the computed plan and asked
 * "Set the EV charge limit to N% and start charging? (y/n)": declining sends
 * nothing, and a run without a TTY (scripted) is a no-op that names `--start`
 * and `--dry-run`.
 */
/**
 * Measured-efficiency overlay (P1c step 2): read-only store beside a running
 * daemon (never migrates). Missing or unreadable history falls back to the
 * config — the printed clause always says which value shaped the math.
 */
function observedEfficiencyFor(
  cfg: EnergyConfig,
  dbPath?: string
): { observed: ObservedEfficiency; problem: string | null } {
  const fallback = (problem: string | null) => ({
    observed: applyEfficiency(cfg, { efficiency: null, samples: 0 }),
    problem,
  });
  try {
    const store = dbPath ?? storePath();
    if (!fs.existsSync(store)) return fallback(null); // fresh install: the clause says it
    const db = openStoreReadOnly(store);
    try {
      return {
        observed: applyEfficiency(
          cfg,
          estimateEfficiency(recentEfficiencySamples(db, EFFICIENCY_FETCH_LIMIT))
        ),
        problem: null,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return fallback(
      `session store unreadable — using config efficiency (${describeError(error)})`
    );
  }
}

/**
 * Low-solar reserve for the CLI (P1c step 3): the newest vintage from the
 * same read-only store, the policy from daemon-config.json (injected by
 * tests). No store, no vintage, or an unreadable anything → null: the base
 * plan runs and nothing extra is printed.
 */
function cliWeatherAdjustment(
  dbPath?: string,
  policy?: WeatherPolicy
): WeatherAdjustment | null {
  try {
    const store = dbPath ?? storePath();
    if (!fs.existsSync(store)) return null;
    const db = openStoreReadOnly(store);
    try {
      const vintage = weatherStore.latestVintage(db);
      if (vintage.length === 0) return null;
      const resolved = resolveDaemonConfig().config;
      const effective: WeatherPolicy =
        policy ??
        (resolved !== null
          ? {
              ...DEFAULT_WEATHER_POLICY,
              bufferAdjPercent: resolved.weatherBufferAdjPercent,
              solarThresholdWhM2: resolved.weatherSolarThresholdWhM2,
            }
          : DEFAULT_WEATHER_POLICY);
      return weatherAdjustment(vintage, Date.now(), effective);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function chargeFromBattery(
  ctx: CommandContext,
  options: {
    start?: boolean;
    dryRun?: boolean;
    dbPath?: string;
    /** Tests inject the policy; omitted reads daemon-config.json. */
    weatherPolicy?: WeatherPolicy;
  } = {}
): Promise<CommandResult> {
  if (options.start && options.dryRun) {
    const message = '--start and --dry-run are mutually exclusive';
    log(ctx, paint.warning(message));
    return { ok: false, error: message };
  }

  // Scripted runs: with no one to prompt and set-limit-only retired, say what
  // the run would have needed and do nothing at all.
  if (!options.start && !options.dryRun && !ctx.interactive) {
    log(
      ctx,
      paint.info(
        'Non-interactive run: pass --start to set the limit and start charging, or --dry-run to preview.'
      )
    );
    return { ok: true };
  }

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
    // Measured efficiency (P1c step 2): overlay first — the math below runs on
    // the observed value, and the clause line reports which one that was.
    const { observed, problem } = observedEfficiencyFor(cfg, options.dbPath);
    // Weather-adjusted reserve (P1c step 3): same read-only store; no vintage
    // or an off policy means no adjustment and no extra line.
    const weather = cliWeatherAdjustment(options.dbPath, options.weatherPolicy);
    const effBufferPercent =
      weather !== null
        ? Math.min(100, cfg.bufferPercent + weather.adjustmentPercent)
        : cfg.bufferPercent;
    const weatherNote =
      weather !== null
        ? ` — weather +${weather.adjustmentPercent}%: ${weather.detail}`
        : '';

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

    const limit = computeChargeLimit(
      evSoc,
      batterySoc,
      weather !== null ? { ...observed.config, bufferPercent: effBufferPercent } : observed.config
    );

    log(ctx, paint.positive(`Solar Battery: ${batterySoc}% (buffer ${cfg.bufferPercent}%)`));
    log(
      ctx,
      paint.positive(
        `Battery available: ${limit.batteryAvailableKwh.toFixed(1)} kWh - ` +
          `EV now: ${limit.evCurrentKwh.toFixed(1)} kWh -> target ${limit.targetPercent}%`
      )
    );
    log(ctx, paint.info(`Charge efficiency: ${efficiencyClause(observed)}`));
    if (weather !== null) {
      log(ctx, paint.info(`Reserve: buffer ${effBufferPercent}%${weatherNote}`));
    }
    if (problem !== null) {
      log(ctx, paint.warning(problem));
    }

    if (limit.limitedBy === 'battery') {
      // Insufficient energy: name the reason and the numbers behind it. The
      // kWh breakdown above is the evidence for this line.
      const message =
        evSoc >= DEFAULT_CHARGE_LIMIT_BOUNDS.maxPercent
          ? 'Cannot charge: the EV is already fully charged'
          : limit.batteryAvailableKwh <= 0
            ? `Not enough energy to charge: the solar battery has no energy above its ${effBufferPercent}% buffer${weatherNote}`
            : `Not enough energy to charge: the solar battery's ` +
              `${limit.batteryAvailableKwh.toFixed(1)} kWh above its ${effBufferPercent}% buffer ` +
              `cannot raise the EV charge limit above its current ${evSoc}%${weatherNote}`;
      log(ctx, paint.warning(message));
      return { ok: false, error: message };
    }

    if (limit.limitedBy === 'vehicle-minimum') {
      log(
        ctx,
        paint.warning(
          `Energy math says ${limit.rawPercent.toFixed(1)}%, below the vehicle's ` +
            `${DEFAULT_CHARGE_LIMIT_BOUNDS.minPercent}% minimum - setting ` +
            `${DEFAULT_CHARGE_LIMIT_BOUNDS.minPercent}%`
        )
      );
    } else if (limit.limitedBy === 'ev-capacity') {
      log(
        ctx,
        paint.info(
          `Target limited by the EV pack capacity (${DEFAULT_CHARGE_LIMIT_BOUNDS.maxPercent}%)`
        )
      );
    }

    if (options.dryRun) {
      log(
        ctx,
        paint.success(`✓ Dry run: would set the EV charge limit to ${limit.targetPercent}%`)
      );
      return { ok: true };
    }

    if (!options.start && !(await confirmStartNow(ctx, limit.targetPercent))) {
      log(ctx, paint.info('No changes made.'));
      return { ok: true };
    }

    log(ctx, paint.info('Setting the EV charge limit (waking the vehicle if needed; asleep cars take up to a minute)...'));
    await ctx.tesla.setChargeLimit(limit.targetPercent);
    log(ctx, paint.success(`✓ EV charge limit set to ${limit.targetPercent}%`));

    log(ctx, paint.info('Starting EV charging...'));
    await ctx.tesla.startCharging();
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    log(ctx, paint.error(`Error: ${message}`));
    return { ok: false, error: message };
  }
}

// showStatus moved to ./system.ts — it was never vehicle-specific, and the
// system-status surface (daemon/store/proxies/config) lives there now.

/**
 * Commander wiring for the vehicle/battery commands.
 *
 * Each factory is the one-shot CLI definition; the REPL dispatch switch (in
 * start.ts) calls the same handlers directly, so the behavior lives once above.
 */

export function createGetEvBsocCommand(deps: { session: Session }): Command {
  return new Command('get-ev-bsoc')
    .allowExcessArguments(false)
    .description('Get the current battery state of charge from the EV')
    .action(async () => {
      deps.session.requireService('Tesla', await deps.session.initializeTesla());
      await deps.session.runCommand(getEvBatterySoc);
    });
}

export function createGetBatterySocCommand(deps: { session: Session }): Command {
  return new Command('get-battery-soc')
    .allowExcessArguments(false)
    .description('Get the current battery state of charge from the solar battery')
    .action(async () => {
      deps.session.requireService('FranklinWH', await deps.session.initializeFranklin());
      try {
        await deps.session.runCommand(getBatterySoc);
      } finally {
        // Phase 2 fixes the teardown bug: this stops a proxy this command started,
        // but today it also stops one an earlier `start` owns.
        await deps.session.getFranklin()!.disconnect();
      }
    });
}

export function createGetChargingStateCommand(deps: { session: Session }): Command {
  return new Command('get-charging-state')
    .allowExcessArguments(false)
    .description('Get the current charging state from the EV (charge_state)')
    .action(async () => {
      deps.session.requireService('Tesla', await deps.session.initializeTesla());
      await deps.session.runCommand(getChargingState);
    });
}

export function createSetEvChargeLimitCommand(deps: { session: Session }): Command {
  return new Command('set-ev-charge-limit')
    .allowExcessArguments(false)
    .description('Set the EV charge limit')
    .argument(
      '<percent>',
      `Charge limit percentage (${DEFAULT_CHARGE_LIMIT_BOUNDS.minPercent}-${DEFAULT_CHARGE_LIMIT_BOUNDS.maxPercent})`
    )
    .action(async (percent: string) => {
      const { minPercent, maxPercent } = DEFAULT_CHARGE_LIMIT_BOUNDS;
      const limit = parseInt(percent);
      if (isNaN(limit) || limit < minPercent || limit > maxPercent) {
        console.error(paint.warning(`Charge limit must be between ${minPercent} and ${maxPercent}`));
        process.exit(1);
      }

      deps.session.requireService('Tesla', await deps.session.initializeTesla());
      await deps.session.runCommand((ctx) => setEvChargeLimit(ctx, limit));
    });
}

export function createStartEvChargingCommand(deps: { session: Session }): Command {
  return new Command('start-ev-charging')
    .allowExcessArguments(false)
    .description('Start charging the EV')
    .action(async () => {
      deps.session.requireService('Tesla', await deps.session.initializeTesla());
      await deps.session.runCommand(startEvCharging);
    });
}

export function createStopEvChargingCommand(deps: { session: Session }): Command {
  return new Command('stop-ev-charging')
    .allowExcessArguments(false)
    .description('Stop charging the EV')
    .action(async () => {
      deps.session.requireService('Tesla', await deps.session.initializeTesla());
      await deps.session.runCommand(stopEvCharging);
    });
}

export function createChargeFromBatteryCommand(deps: { session: Session }): Command {
  return new Command('charge-from-battery')
    .allowExcessArguments(false)
    .description('Set the EV charge limit from the energy the solar battery can spare (kWh math)')
    .option('--start', 'Set the charge limit and start charging, without prompting')
    .option('--dry-run', 'Compute and print the limit without sending anything to the vehicle')
    .action(async (options) => {
      // Short-circuit preserved: Franklin's failure exits before Tesla is asked
      // for anything, which is also what `||` did here.
      deps.session.requireService('FranklinWH', await deps.session.initializeFranklin());
      deps.session.requireService('Tesla', await deps.session.initializeTesla());

      try {
        await deps.session.runCommand((ctx) =>
          chargeFromBattery(ctx, { start: options.start === true, dryRun: options.dryRun === true })
        );
      } catch (error) {
        console.error(paint.error(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      } finally {
        await deps.session.getFranklin()!.disconnect();
      }
    });
}
