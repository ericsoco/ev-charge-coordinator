/**
 * Daemon tunables: `<config-dir>/daemon-config.json`.
 *
 * The file is the single source of truth for effective config: the daemon
 * creates it with the documented defaults on first start (migrating a legacy
 * `daemon.json` if present) and reconciles missing keys into an existing file
 * on start (defaults merged under operator edits — values are never changed);
 * readers that run before that first start see the same defaults in code. No
 * CLI setters — hand-edit afterwards; an *invalid* value is reported as a
 * problem and blocks the daemon — never clamped or guessed at. Secrets (home
 * location, notifier topics/webhook URLs) never live here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './credentials.js';

/** A filter the decision chain runs at every vehicle plug-in event. */
export type DecisionFilterType = 'always' | 'geofence';

export interface DecisionFilterConfig {
  type: DecisionFilterType;
  /** geofence only: distance-to-home within which acting is allowed, meters. */
  radiusM?: number;
}

export interface AutoStartConfig {
  /**
   * Master actuation switch. Default false: decisions are evaluated and
   * recorded, but nothing charges until the operator flips this on.
   */
  enabled: boolean;
  /** Ordered filter chain evaluated at every plug-in. */
  filters: DecisionFilterConfig[];
}

export type NotifierType = 'log' | 'ntfy' | 'slack';

/**
 * A configured notification client (design.md §3.7). Non-secret knobs only —
 * ntfy topics and Slack webhook URLs live in the credential store.
 */
export interface NotifierConfigEntry {
  type: NotifierType;
  /** ntfy only: push priority. Default 'default'. */
  priority?: 'default' | 'high';
  /** ntfy only: self-hosted server URL. Default https://ntfy.sh. */
  server?: string;
}

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
  /** Auto-start decision settings (nested block, validated field-by-field). */
  autoStart: AutoStartConfig;
  /**
   * Notification clients invoked for every typed event; all are called and
   * failures are isolated. `[]` disables notifications entirely.
   */
  notifiers: NotifierConfigEntry[];
}

export const DEFAULT_DAEMON_CONFIG: Readonly<DaemonConfig> = Object.freeze<DaemonConfig>({
  batterySampleSec: 120,
  evStatusPollSec: 60,
  evSamplePluggedSec: 60,
  evSampleIdleSec: 300,
  weatherFetchSec: 86_400,
  retentionDays: 90,
  autoStart: {
    enabled: false,
    filters: [{ type: 'always' }],
  },
  notifiers: [{ type: 'log' }],
});

/** Derived from the defaults so template and defaults cannot drift. */
export const DAEMON_CONFIG_TEMPLATE: string =
  JSON.stringify(DEFAULT_DAEMON_CONFIG, null, 2) + '\n';

export function daemonConfigPath(): string {
  return path.join(getConfigDir(), 'daemon-config.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defaults merged UNDER the operator's file content: file values win (arrays
 * wholesale, never element-merged), missing keys fill in, unknown keys stay.
 */
function deepMergeDefaults(
  fallback: Record<string, unknown>,
  fileValue: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...fallback };
  for (const [key, value] of Object.entries(fileValue)) {
    const base = merged[key];
    merged[key] =
      isPlainObject(base) && isPlainObject(value) ? deepMergeDefaults(base, value) : value;
  }
  return merged;
}

/**
 * Add missing documented keys so the file stays self-documenting — only when
 * it validates and only when the bytes would change; an invalid file is left
 * byte-untouched so the operator can see the edit to fix. Atomic write
 * (temp + rename, private mode). Returns true when the file was rewritten.
 */
function reconcileDaemonConfigFile(targetPath: string): boolean {
  if (resolveDaemonConfig(targetPath).config === null) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // resolveDaemonConfig just accepted it; defensive only
  }
  if (!isPlainObject(parsed)) return false;
  const merged = JSON.stringify(deepMergeDefaults({ ...DEFAULT_DAEMON_CONFIG }, parsed), null, 2) + '\n';
  if (merged === raw) return false;
  const temp = `${targetPath}.tmp`;
  fs.writeFileSync(temp, merged, { mode: 0o600 });
  fs.renameSync(temp, targetPath);
  return true;
}

/**
 * Ensure the config file exists and knows every documented knob — DAEMON START
 * ONLY (`status` must never call this: it reads only, starts nothing). Creates
 * it with the documented defaults, migrates a legacy `daemon.json`, reconciles
 * missing keys into an existing file (defaults merged under the operator's
 * edits — values never changed; an invalid file stays byte-untouched). When
 * several apply the status precedence is migrated → updated → created → exists.
 */
export function ensureDaemonConfigFile(
  targetPath: string = daemonConfigPath()
): 'created' | 'migrated' | 'updated' | 'exists' {
  let status: 'created' | 'migrated' | 'exists';
  if (fs.existsSync(targetPath)) {
    status = 'exists';
  } else {
    const dir = path.dirname(targetPath);
    const legacy = path.join(dir, 'daemon.json');
    if (fs.existsSync(legacy)) {
      fs.renameSync(legacy, targetPath);
      status = 'migrated';
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(targetPath, DAEMON_CONFIG_TEMPLATE, { mode: 0o600 });
      status = 'created';
    }
  }
  if (status === 'created') return status; // template == defaults: nothing to reconcile
  const reconciled = reconcileDaemonConfigFile(targetPath);
  if (!reconciled || status === 'migrated') return status;
  return 'updated';
}

function checkRange(min: number, max: number): (value: number) => string | null {
  return (value) => {
    if (!Number.isInteger(value)) return 'must be an integer';
    if (value < min || value > max) return `must be between ${min} and ${max}`;
    return null;
  };
}

/** Numeric tunables only — the nested `autoStart`/`notifiers` blocks validate separately. */
type NumericDaemonField = Exclude<keyof DaemonConfig, 'autoStart' | 'notifiers'>;

const FIELD_CHECKS: { [K in NumericDaemonField]: (value: number) => string | null } = {
  batterySampleSec: checkRange(10, 86_400),
  evStatusPollSec: checkRange(10, 86_400),
  evSamplePluggedSec: checkRange(10, 86_400),
  evSampleIdleSec: checkRange(10, 86_400),
  weatherFetchSec: checkRange(60, 604_800),
  retentionDays: checkRange(1, 3_650),
};

const FIELD_NAMES = Object.keys(DEFAULT_DAEMON_CONFIG).filter(
  (name) => name !== 'autoStart' && name !== 'notifiers'
) as NumericDaemonField[];

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function cloneAutoStart(source: AutoStartConfig): AutoStartConfig {
  return { ...source, filters: source.filters.map((filter) => ({ ...filter })) };
}

function cloneNotifiers(source: NotifierConfigEntry[]): NotifierConfigEntry[] {
  return source.map((entry) => ({ ...entry }));
}

/** Fresh working copy — resolved configs never share references with defaults. */
function defaultConfig(): DaemonConfig {
  return {
    ...DEFAULT_DAEMON_CONFIG,
    autoStart: cloneAutoStart(DEFAULT_DAEMON_CONFIG.autoStart),
    notifiers: cloneNotifiers(DEFAULT_DAEMON_CONFIG.notifiers),
  };
}

const FILTER_TYPES: readonly DecisionFilterType[] = ['always', 'geofence'];

/**
 * Validate the nested `autoStart` block field-by-field (absent fields keep
 * their defaults, mirroring the numeric loop). Any problem returns a null
 * value — the whole config refuses rather than running half-understood.
 */
function resolveAutoStart(
  raw: unknown,
  file: string
): { value: AutoStartConfig | null; problems: string[] } {
  const value = cloneAutoStart(DEFAULT_DAEMON_CONFIG.autoStart);
  if (raw === undefined || raw === null) return { value, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: null, problems: [`${file}: autoStart = ${show(raw)} (must be an object)`] };
  }

  const problems: string[] = [];
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled;
  if (enabled !== undefined && enabled !== null) {
    if (typeof enabled !== 'boolean') {
      problems.push(`${file}: autoStart.enabled = ${show(enabled)} (must be a boolean)`);
    } else {
      value.enabled = enabled;
    }
  }

  const filters = record.filters;
  if (filters !== undefined && filters !== null) {
    if (!Array.isArray(filters)) {
      problems.push(`${file}: autoStart.filters = ${show(filters)} (must be an array)`);
    } else {
      value.filters = [];
      for (const [index, entry] of filters.entries()) {
        const where = `${file}: autoStart.filters[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          problems.push(`${where} = ${show(entry)} (must be an object with a type)`);
          continue;
        }
        const filter = entry as Record<string, unknown>;
        const type = filter.type;
        if (typeof type !== 'string' || !FILTER_TYPES.includes(type as DecisionFilterType)) {
          problems.push(
            `${where}.type = ${show(type)} (unknown filter type; expected "always" or "geofence")`
          );
          continue;
        }
        if (type === 'always') {
          value.filters.push({ type: 'always' });
          continue;
        }
        const radius = filter.radiusM;
        if (radius === undefined || radius === null) {
          problems.push(`${where} (geofence requires radiusM — meters)`);
          continue;
        }
        if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
          problems.push(`${where}.radiusM = ${show(radius)} (must be a positive number of meters)`);
          continue;
        }
        value.filters.push({ type: 'geofence', radiusM: radius });
      }
    }
  }

  if (problems.length > 0) return { value: null, problems };
  return { value, problems: [] };
}

const NOTIFIER_TYPES: readonly NotifierType[] = ['log', 'ntfy', 'slack'];
const NTFTY_PRIORITIES = ['default', 'high'];

/**
 * Validate the `notifiers` array (design.md §3.7): one entry per configured
 * client, arrays replaced wholesale like filters, ntfy knobs checked only for
 * ntfy entries. Absent → the log-only default.
 */
function resolveNotifiers(
  raw: unknown,
  file: string
): { value: NotifierConfigEntry[] | null; problems: string[] } {
  const value = cloneNotifiers(DEFAULT_DAEMON_CONFIG.notifiers);
  if (raw === undefined || raw === null) return { value, problems: [] };
  if (!Array.isArray(raw)) {
    return { value: null, problems: [`${file}: notifiers = ${show(raw)} (must be an array)`] };
  }

  const problems: string[] = [];
  const entries: NotifierConfigEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `${file}: notifiers[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${where} = ${show(entry)} (must be an object with a type)`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !NOTIFIER_TYPES.includes(type as NotifierType)) {
      problems.push(
        `${where}.type = ${show(type)} (unknown notifier type; expected "log", "ntfy" or "slack")`
      );
      continue;
    }
    const resolved: NotifierConfigEntry = { type: type as NotifierType };
    if (type === 'ntfy') {
      const priority = record.priority;
      if (priority !== undefined && priority !== null) {
        if (typeof priority !== 'string' || !NTFTY_PRIORITIES.includes(priority)) {
          problems.push(`${where}.priority = ${show(priority)} (expected "default" or "high")`);
          continue;
        }
        resolved.priority = priority as 'default' | 'high';
      }
      const server = record.server;
      if (server !== undefined && server !== null) {
        if (typeof server !== 'string' || !/^https?:\/\/\S+$/.test(server)) {
          problems.push(`${where}.server = ${show(server)} (must be an http(s) URL)`);
          continue;
        }
        resolved.server = server;
      }
    }
    entries.push(resolved);
  }

  if (problems.length > 0) return { value: null, problems };
  return { value: entries, problems: [] };
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
  const config: DaemonConfig = defaultConfig();
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

  const autoStart = resolveAutoStart(record.autoStart, file);
  problems.push(...autoStart.problems);
  if (autoStart.value !== null) config.autoStart = autoStart.value;

  const notifiers = resolveNotifiers(record.notifiers, file);
  problems.push(...notifiers.problems);
  if (notifiers.value !== null) config.notifiers = notifiers.value;

  // Unknown keys are ignored (hand-edit tolerance), consistent with energy config.
  if (problems.length > 0) return { config: null, problems };
  return { config, problems: [] };
}
