/**
 * Hand-editable energy config: `<config dir>/config.json`.
 *
 * The single source of truth for EnergyConfig. The operator creates and edits
 * the file (first-run prompts, `config --set-*`, or a text editor); the app
 * validates it on every read so manual edits are caught immediately, echoes
 * the problems with the path, and writes atomically with owner-only mode.
 * There are no built-in defaults: an absent field is "missing", never 0.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './credentials.js';
import {
  ENERGY_CONFIG_FIELDS,
  energyConfigFieldProblem,
  validateEnergyConfig,
  type EnergyConfig,
} from './energy.js';

/** JSON example of the file, for error messages and docs. */
export const ENERGY_CONFIG_TEMPLATE = `{
  "batteryCapacityKwh": 13.5,
  "evBatteryKwh": 75,
  "bufferPercent": 20,
  "chargeEfficiency": 0.9
}`;

export function energyConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export interface ResolvedEnergyConfig {
  /** Usable config, or null when anything is missing or invalid. */
  config: EnergyConfig | null;
  /** Absent fields, in schema order. */
  missing: (keyof EnergyConfig)[];
  /** One message per invalid value / parse failure. */
  invalid: string[];
  /** Fields that are present and valid, whatever else is wrong. */
  partial: Partial<EnergyConfig>;
}

/** Read + validate the file. Never throws: problems come back structured for echoing. */
export function resolveEnergyConfig(): ResolvedEnergyConfig {
  const file = energyConfigPath();
  if (!fs.existsSync(file)) {
    return { config: null, missing: [...ENERGY_CONFIG_FIELDS], invalid: [], partial: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      config: null,
      missing: [],
      invalid: [`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      partial: {},
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      config: null,
      missing: [],
      invalid: [`${file} must contain a JSON object mapping field names to numbers`],
      partial: {},
    };
  }

  const record = raw as Record<string, unknown>;
  const missing: (keyof EnergyConfig)[] = [];
  const invalid: string[] = [];
  const config = {} as Partial<EnergyConfig>;

  for (const field of ENERGY_CONFIG_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    const problem = energyConfigFieldProblem(field, value);
    if (problem !== null) {
      invalid.push(`${file}: ${problem}`);
      continue;
    }
    (config as Record<string, unknown>)[field] = value;
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { config: null, missing, invalid, partial: config };
  }
  return { config: config as EnergyConfig, missing: [], invalid: [], partial: config };
}

/**
 * Lines describing why a resolve failed, ready to log -- one per problem, the
 * file path, and how to fix it. Empty when the config is usable.
 */
export function describeConfigProblems(resolved: ResolvedEnergyConfig): string[] {
  if (resolved.invalid.length > 0) {
    return [...resolved.invalid, `Fix ${energyConfigPath()} and try again.`];
  }
  if (resolved.missing.length > 0) {
    return [
      `Energy config incomplete at ${energyConfigPath()} ` +
        `(missing: ${resolved.missing.join(', ')}).`,
    ];
  }
  return [];
}

/** Validate and write the complete config atomically (owner-only, 0600). */
export function saveEnergyConfig(config: EnergyConfig): void {
  validateEnergyConfig(config);
  writeConfigFile(config);
}

/**
 * Merge one or more fields into the file and write it. Present values are
 * validated (a bad hand-edited value already in the file blocks the write
 * instead of being clobbered), absent fields stay absent, and unknown keys
 * from the file are dropped -- the file is app-owned. Creates the file.
 */
export function setEnergyConfigField(patch: Partial<EnergyConfig>): void {
  const file = energyConfigPath();
  const current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Cannot update ${file}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Fix the JSON first.'
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Cannot update ${file}: it must contain a JSON object.`);
    }
    const record = parsed as Record<string, unknown>;
    for (const field of ENERGY_CONFIG_FIELDS) {
      if (record[field] !== undefined && record[field] !== null) current[field] = record[field];
    }
  }

  const merged = { ...current, ...patch } as EnergyConfig;
  const problems: string[] = [];
  for (const field of ENERGY_CONFIG_FIELDS) {
    if (merged[field] === undefined || merged[field] === null) continue;
    const problem = energyConfigFieldProblem(field, merged[field]);
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid energy config: ${problems.join('; ')}`);
  }

  writeConfigFile(merged);
}

function writeConfigFile(config: object): void {
  const file = energyConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
