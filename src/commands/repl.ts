/**
 * Interactive-shell command metadata.
 *
 * One source for what `help` prints, what tab completion offers, and how the
 * dispatch switch parses inline flags. The names mirror the dispatch switch in
 * index.ts's `start` action (a switch cannot be enumerated at runtime without
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
  authenticate: ['force', 'help'],
  config: ['clear-franklin', 'clear-tesla', 'clear-credentials', 'show-public-key', 'help'],
  'pair-tesla-key': ['check-only', 'skip-registration', 'help'],
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
      // Single-dash (`-force`) is a mistyped flag, not a positional —
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
