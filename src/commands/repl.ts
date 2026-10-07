/**
 * Interactive-shell command metadata.
 *
 * One source for what `help` prints and what tab completion offers. The names
 * mirror the dispatch switch in index.ts's `start` action (a switch cannot be
 * enumerated at runtime without indirection that would obscure it), so a new
 * REPL command must be added both here and there.
 */

import { info } from '../utils/color.js';

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
  { name: 'set-ev-charge-limit', description: "Set the EV's charge limit" },
  { name: 'start-ev-charging', description: 'Start charging the EV' },
  { name: 'stop-ev-charging', description: 'Stop charging the EV' },
  {
    name: 'charge-from-battery',
    description: 'Set the EV charge limit based on solar battery SoC',
  },
  { name: 'set-battery-buffer', description: 'Set the amount of charge to keep in the solar battery' },
  { name: 'status', description: 'Show current status of all systems' },
  { name: 'exit', description: 'Exit the application' },
];

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

/**
 * readline completer: the commands starting with what has been typed.
 * Returns the hit list and the untouched line, readline's expected shape.
 */
export function completeCommand(line: string): [string[], string] {
  const hits = REPL_COMMANDS.map((command) => command.name).filter((name) => name.startsWith(line));
  return [hits, line];
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
