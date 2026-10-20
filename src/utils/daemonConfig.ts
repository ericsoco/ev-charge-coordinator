/**
 * Daemon tunables: `<config-dir>/daemon.json`.
 *
 * Unlike energy config (`config.ts`), these are ops knobs with documented
 * defaults: an absent file is perfectly valid (all defaults apply), while an
 * *invalid* value is reported as a problem and blocks the daemon — never
 * clamped or guessed at. The file is hand-edited (no CLI setters in P1a);
 * secrets (home location) never live here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './credentials.js';

export interface DaemonConfig {
  /** Home-battery sample cadence, seconds. */
  batterySampleSec: number;
  /** Cheap vehicle status probe (online/asleep), seconds. */
  evStatusPollSec: number;
  /**
   * `vehicle_data` cadence while the vehicle is plugged in
   * (charging_state !== 'Disconnected' — Stopped/Charging/Complete/NoPower),
   * seconds. Not "while charging": the plug-in event usually arrives as
   * Disconnected→Stopped, and that pre-charge window is when decisions run.
   */
  evSamplePluggedSec: number;
  /** `vehicle_data` cadence while awake and NOT plugged, seconds. */
  evSampleIdleSec: number;
  /** Weather forecast fetch cadence, seconds. */
  weatherFetchSec: number;
  /** Raw-sample retention window in days (the daemon prunes daily). */
  retentionDays: number;
}

export const DEFAULT_DAEMON_CONFIG: Readonly<DaemonConfig> = Object.freeze({
  batterySampleSec: 120,
  evStatusPollSec: 60,
  evSamplePluggedSec: 60,
  evSampleIdleSec: 300,
  weatherFetchSec: 86_400,
  retentionDays: 90,
});

/** Derived from the defaults so template and defaults cannot drift. */
export const DAEMON_CONFIG_TEMPLATE: string =
  JSON.stringify(DEFAULT_DAEMON_CONFIG, null, 2) + '\n';

export function daemonConfigPath(): string {
  return path.join(getConfigDir(), 'daemon.json');
}

function checkRange(min: number, max: number): (value: number) => string | null {
  return (value) => {
    if (!Number.isInteger(value)) return 'must be an integer';
    if (value < min || value > max) return `must be between ${min} and ${max}`;
    return null;
  };
}

const FIELD_CHECKS: { [K in keyof DaemonConfig]: (value: number) => string | null } = {
  batterySampleSec: checkRange(10, 86_400),
  evStatusPollSec: checkRange(10, 86_400),
  evSamplePluggedSec: checkRange(10, 86_400),
  evSampleIdleSec: checkRange(10, 86_400),
  weatherFetchSec: checkRange(60, 604_800),
  retentionDays: checkRange(1, 3_650),
};

const FIELD_NAMES = Object.keys(DEFAULT_DAEMON_CONFIG) as (keyof DaemonConfig)[];

function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export interface ResolvedDaemonConfig {
  /** Complete, defaults-merged config — null when anything is invalid. */
  config: DaemonConfig | null;
  /** One message per problem, each naming the file. */
  problems: string[];
}

/**
 * Read + validate the file. Never throws. Absent file → all defaults and no
 * problems; any invalid field → config null with one problem per bad field
 * (refuse rather than run on a half-understood config).
 */
export function resolveDaemonConfig(file: string = daemonConfigPath()): ResolvedDaemonConfig {
  const config: DaemonConfig = { ...DEFAULT_DAEMON_CONFIG };
  if (!fs.existsSync(file)) return { config, problems: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { config: null, problems: [`${file}: ${String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { config: null, problems: [`${file} is not valid JSON: ${reason}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { config: null, problems: [`${file} must contain a JSON object mapping field names to numbers`] };
  }

  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of FIELD_NAMES) {
    const value = record[field];
    if (value === undefined || value === null) continue; // documented default applies
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${file}: ${field} = ${show(value)} (must be a number)`);
      continue;
    }
    const problem = FIELD_CHECKS[field](value);
    if (problem !== null) {
      problems.push(`${file}: ${field} = ${show(value)} (${problem})`);
      continue;
    }
    config[field] = value;
  }

  // Unknown keys are ignored (hand-edit tolerance), consistent with energy config.
  if (problems.length > 0) return { config: null, problems };
  return { config, problems: [] };
}
