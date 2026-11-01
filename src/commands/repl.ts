/**
 * Interactive-shell command metadata.
 *
 * One source for what `help` prints, what tab completion offers, and how the
 * dispatch switch parses inline flags. The names mirror the dispatch switch in
 * start.ts's `start` action (a switch cannot be enumerated at runtime without
 * indirection that would obscure it), so a new REPL command must be added both
 * here and there.
 */

import { info } from '../utils/color.js';
import { TESLA_REGIONS } from '../services/tesla/endpoints.js';

export interface ReplCommand {
  readonly name: string;
  readonly description: string;
}

export const REPL_COMMANDS: readonly ReplCommand[] = [
  { name: 'help', description: 'Show available commands' },
  { name: 'authenticate', description: 'Sign in to Tesla and store the credentials' },
  {
    name: 'get-ev-bsoc',
    description: 'Get the current battery state of charge from the EV',
  },
  {
    name: 'get-battery-soc',
    description: 'Get the current battery state of charge from the solar battery',
  },
  {
    name: 'get-charging-state',
    description: 'Get the current charging state from the EV',
  },
  { name: 'set-ev-charge-limit', description: "Set the EV's charge limit" },
  { name: 'start-ev-charging', description: 'Start charging the EV' },
  { name: 'stop-ev-charging', description: 'Stop charging the EV' },
  {
    name: 'charge-from-battery',
    description: 'Set the EV charge limit from the energy the solar battery can spare (kWh math)',
  },
  { name: 'config', description: 'Show or update configuration' },
  {
    name: 'pair-tesla-key',
    description: "Register this application's virtual key with Tesla and print the vehicle pairing link",
  },
  { name: 'status', description: 'Show daemon, store, proxy, and config status' },
  { name: 'sessions', description: 'Show recent charging sessions' },
  {
    name: 'set-home-location',
    description: 'Set the home location (secret): from arguments, or from the vehicle',
  },
  {
    name: 'notify',
    description: 'Manage notification secrets (ntfy, Slack) and test delivery',
  },
  { name: 'exit', description: 'Exit the application' },
];

/**
 * Flag tables for commands that take inline arguments, mirroring Commander's
 * flags exactly (pinned by the drift guard in repl-commands.test.ts). Value
 * flags consume the next token; boolean flags stand alone.
 */
export const VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  authenticate: ['client-id', 'client-secret'],
  config: [
    'tesla-region',
    'tesla-domain',
    'set-battery-kwh',
    'set-buffer',
    'set-ev-kwh',
    'set-efficiency',
  ],
  'pair-tesla-key': ['domain', 'vin'],
  sessions: ['limit'],
};

export const BOOLEAN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  authenticate: ['reauth', 'help'],
  config: ['clear-franklin', 'clear-tesla', 'clear-credentials', 'show-public-key', 'help'],
  'pair-tesla-key': ['check-only', 'skip-registration', 'rotate-key', 'help'],
  'charge-from-battery': ['start', 'dry-run', 'help'],
  status: ['json', 'help'],
  sessions: ['open', 'help'],
};

export interface ParsedArgs {
  /** Commander-shaped options: --kebab-case mapped to camelCase keys. */
  options: Record<string, string | boolean>;
  /** Commander-style error text, or null when the tokens are valid. */
  error: string | null;
}

function camelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Subcommands of `notify`, mirroring the one-shot command's structure
 * (`help` is Commander's implicit subcommand, pinned by the drift guard).
 */
export const NOTIFY_SUBCOMMANDS: readonly string[] = ['set', 'clear', 'test', 'help'];

/** Value flags of `notify set`, mirroring commands/notify.ts. */
export const NOTIFY_SET_VALUE_FLAGS: readonly string[] = ['topic', 'webhook-url'];

export interface ParsedNotify {
  /** The subcommand (set | clear | test | help); null when none was given. */
  subcommand: string | null;
  /** The positional after `set` — the notifier kind (ntfy | slack). */
  kind: string | null;
  /** Commander-shaped options for the subcommand. */
  options: Record<string, string | boolean>;
  /** Set when help was requested; names the command it was requested for. */
  helpFor: string | null;
  /** Commander-style error text, or null when the tokens are valid. */
  error: string | null;
}

/**
 * Parse the tokens after `notify` into its subcommand, kind, and flags.
 *
 * `notify` has a subcommand structure that parseCommandArgs (flat flags for one
 * command) cannot express, so it gets its own parser — same contract: mirror
 * the one-shot command's accepts/rejects exactly, with Commander-style error
 * text. The one-shot rejects stray positionals and unknown flags here too
 * (allowExcessArguments(false) on the notify command, which addCommand does
 * not inherit from the program).
 */
export function parseNotifyArgs(tokens: string[]): ParsedNotify {
  const empty: ParsedNotify = {
    subcommand: null,
    kind: null,
    options: {},
    helpFor: null,
    error: null,
  };
  const [first, ...rest] = tokens;
  if (first === undefined) return empty; // bare `notify`: the caller shows help
  if (first === 'help') {
    // `notify help [sub]`: an unknown or absent topic falls back to notify's
    // own help, exactly like the one-shot's implicit help subcommand.
    const topic = rest[0];
    return {
      ...empty,
      subcommand: 'help',
      helpFor: topic !== undefined && NOTIFY_SUBCOMMANDS.includes(topic) ? topic : 'notify',
    };
  }
  if (first === '--help' || first === '-h') return { ...empty, helpFor: 'notify' };
  if (!NOTIFY_SUBCOMMANDS.includes(first)) {
    return {
      ...empty,
      error: first.startsWith('-')
        ? `error: unknown option '${first}'`
        : `error: unknown command '${first}'`,
    };
  }

  const valueFlags = new Set(first === 'set' ? NOTIFY_SET_VALUE_FLAGS : []);
  const options: Record<string, string | boolean> = {};
  let kind: string | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '-h' || token === '--help') {
      return { ...empty, subcommand: first, helpFor: first };
    }
    if (token.startsWith('-')) {
      const flag = token.startsWith('--') ? token.slice(2) : null;
      if (flag !== null && valueFlags.has(flag)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { ...empty, error: `error: option '--${flag} <value>' argument missing` };
        }
        options[camelCase(flag)] = value;
        i += 1;
        continue;
      }
      return { ...empty, error: `error: unknown option '${token}'` };
    }
    if (first !== 'set') {
      // clear/test declare no positional; the one-shot rejects these as excess.
      return {
        ...empty,
        error: `error: too many arguments for '${first}'. Expected 0 arguments but got 1.`,
      };
    }
    if (kind !== null) {
      return {
        ...empty,
        error: `error: too many arguments for 'set'. Expected 1 argument but got 2.`,
      };
    }
    kind = token;
  }

  if (first === 'set') {
    if (kind === null) {
      return { ...empty, subcommand: 'set', error: "error: missing required argument 'kind'" };
    }
    if (kind !== 'ntfy' && kind !== 'slack') {
      return {
        ...empty,
        subcommand: 'set',
        error: `error: unknown notifier kind '${kind}' (expected ntfy or slack)`,
      };
    }
  }

  return { subcommand: first, kind, options, helpFor: null, error: null };
}

/**
 * Turn the tokens after a REPL command into Commander-shaped options, matching
 * the one-shot behavior: unknown options and stray positional tokens are
 * errors, a value flag missing its value is an error too (no silent fallback
 * -- the REPL must not run a different command than the CLI would), and
 * `--help` / `-h` parse as a boolean the dispatch turns into the command's help.
 */
export function parseCommandArgs(name: string, tokens: string[]): ParsedArgs {
  const valueFlags = new Set(VALUE_FLAGS[name] ?? []);
  const booleanFlags = new Set(BOOLEAN_FLAGS[name] ?? []);
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-h') {
      // Commander's short help flag; `--help` rides through the boolean table.
      options.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      // Single-dash (`-reauth`) is a mistyped flag, not a positional —
      // Commander rejects it as an unknown option too.
      return {
        options: {},
        error: token.startsWith('-')
          ? `error: unknown option '${token}'`
          : `error: unknown argument '${token}'`,
      };
    }
    const flag = token.slice(2);
    if (valueFlags.has(flag)) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { options: {}, error: `error: option '--${flag} <value>' argument missing` };
      }
      options[camelCase(flag)] = value;
      i += 1;
      continue;
    }
    if (booleanFlags.has(flag)) {
      options[camelCase(flag)] = true;
      continue;
    }
    return { options: {}, error: `error: unknown option '--${flag}'` };
  }
  return { options, error: null };
}

/** The body of the REPL's `help` command. One Info color for the whole block. */
export function renderHelp(): string {
  const width = Math.max(...REPL_COMMANDS.map((command) => command.name.length)) + 2;
  return info(
    [
      '',
      'Available commands:',
      ...REPL_COMMANDS.map((command) => `  ${command.name.padEnd(width)}${command.description}`),
      '',
    ].join('\n')
  );
}

const COMMAND_NAMES: readonly string[] = REPL_COMMANDS.map((command) => command.name);

function completeCommandNames(current: string): [string[], string] {
  return [COMMAND_NAMES.filter((name) => name.startsWith(current)), current];
}

/**
 * Completion inside `notify`: subcommand names, then the kind values and
 * flags of `notify set`. `clear`/`test` take no arguments, and `help` takes
 * a subcommand name — all matching what parseNotifyArgs would accept.
 */
function completeNotify(args: string[], current: string): [string[], string] {
  if (args.length === 0) {
    if (current !== '' && !current.startsWith('-')) {
      return [NOTIFY_SUBCOMMANDS.filter((name) => name.startsWith(current)), current];
    }
    const flags = [...NOTIFY_SUBCOMMANDS, '--help', '-h'];
    return [flags.filter((flag) => flag.startsWith(current)), current];
  }

  const [sub, ...rest] = args;
  if (!NOTIFY_SUBCOMMANDS.includes(sub)) return [[], current];
  if (sub === 'help') {
    return [NOTIFY_SUBCOMMANDS.filter((name) => name.startsWith(current)), current];
  }

  // A value slot: the previous token expects its value, not another flag.
  const previous = rest[rest.length - 1];
  if (previous !== undefined && NOTIFY_SET_VALUE_FLAGS.includes(previous.slice(2))) {
    return [[], current];
  }

  // `set` takes the kind as its first positional; clear/test take nothing.
  // Walk the tokens, skipping flag values, to see whether the kind was given.
  let kindGiven = false;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      if (NOTIFY_SET_VALUE_FLAGS.includes(token.slice(2))) i += 1; // skip its value
      continue;
    }
    if (!token.startsWith('-')) kindGiven = true;
  }
  if (sub !== 'set' || (kindGiven && current !== '' && !current.startsWith('-'))) {
    return [[], current];
  }
  const flags = [...NOTIFY_SET_VALUE_FLAGS.map((flag) => `--${flag}`), '--help', '-h'];
  const values = sub === 'set' && !kindGiven ? ['ntfy', 'slack'] : [];
  return [
    [...values, ...flags].filter((hit) => hit.startsWith(current)),
    current,
  ];
}

/**
 * readline completer: command names while a command is being typed, its flags
 * once one has been, and accepted values inside a value flag's slot.
 *
 * Returns the hit list and the token being completed, readline's expected
 * shape: readline replaces the trailing token (back to the last space before
 * the cursor) with the hits' common prefix and lists the hits on a repeated
 * Tab. The completer is handed the line up to the cursor, never past it, so
 * every hit must be the full replacement token.
 */
export function completeCommand(line: string): [string[], string] {
  // The trailing token starts at the earliest position from which the rest of
  // the typed text contains no whitespace; a finished word followed by a
  // space matches at the end (an empty token).
  const current = line.slice(line.search(/\S*$/));
  const before = line.slice(0, line.length - current.length);

  if (!before.trim()) return completeCommandNames(current);

  const [command, ...args] = before.trim().split(/\s+/);
  if (!COMMAND_NAMES.includes(command)) return [[], current];
  if (command === 'help') return completeCommandNames(current);
  if (command === 'notify') return completeNotify(args, current);

  // A value slot: the previous token expects its value, not another flag.
  const previous = args[args.length - 1];
  const previousFlag = previous?.startsWith('--') ? previous.slice(2) : undefined;
  if (previousFlag === 'tesla-region') {
    return [Object.keys(TESLA_REGIONS).filter((value) => value.startsWith(current)), current];
  }
  if (previousFlag !== undefined && (VALUE_FLAGS[command] ?? []).includes(previousFlag)) {
    return [[], current];
  }

  // A flag slot: offer what parseCommandArgs would accept here. An empty
  // token (command + space) is a flag slot too; only a stray positional is not.
  if (current !== '' && !current.startsWith('-')) return [[], current];
  const flags = [
    ...(VALUE_FLAGS[command] ?? []).map((flag) => `--${flag}`),
    ...(BOOLEAN_FLAGS[command] ?? []).map((flag) => `--${flag}`),
    '-h',
  ];
  return [flags.filter((flag) => flag.startsWith(current)), current];
}

/**
 * Commands the REPL still accepts while another command is in flight.
 *
 * They touch no network: `help` prints, `status` reads the local store,
 * `exit` tears the session down -- and being able to exit during a hung
 * command is exactly when it matters most.
 */
export const LOCAL_WHILE_BUSY: ReadonlySet<string> = new Set(['help', 'status', 'exit', 'quit']);

/**
 * True for input the dispatch switch would actually run.
 *
 * The busy-gate uses this to tell a mistyped command (worth a skip message)
 * from a sub-prompt answer like `80` or a stray Enter (worth silence).
 */
export function isReplCommand(name: string): boolean {
  return REPL_COMMANDS.some((command) => command.name === name) || LOCAL_WHILE_BUSY.has(name);
}
