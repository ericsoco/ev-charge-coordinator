/**
 * Interactive-shell command metadata.
 *
 * One source for what `help` prints and what tab completion offers. The names
 * mirror the dispatch switch in index.ts's `start` action (a switch cannot be
 * enumerated at runtime without indirection that would obscure it), so a new
 * REPL command must be added both here and there.
 */

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

/** The body of the REPL's `help` command. */
export function renderHelp(): string {
  const width = Math.max(...REPL_COMMANDS.map((command) => command.name.length)) + 2;
  return [
    '',
    'Available commands:',
    ...REPL_COMMANDS.map((command) => `  ${command.name.padEnd(width)}${command.description}`),
    '',
  ].join('\n');
}

/**
 * readline completer: the commands starting with what has been typed.
 * Returns the hit list and the untouched line, readline's expected shape.
 */
export function completeCommand(line: string): [string[], string] {
  const hits = REPL_COMMANDS.map((command) => command.name).filter((name) => name.startsWith(line));
  return [hits, line];
}
