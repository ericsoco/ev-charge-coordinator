/**
 * REPL command metadata: `help` and tab completion share one source.
 *
 * The dispatch switch in index.ts cannot be enumerated at runtime, so the
 * sync between it and REPL_COMMANDS is asserted against the real source --
 * a mirrored list alone could drift while every test stayed green.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPL_COMMANDS, completeCommand, isReplCommand, LOCAL_WHILE_BUSY, parseCommandArgs, renderHelp } from '../../src/commands/repl.js';

const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

const names = REPL_COMMANDS.map((command) => command.name);

describe('renderHelp', () => {
  it('lists every command with its description', () => {
    const help = renderHelp();
    expect(help).toContain('Available commands:');
    for (const { name, description } of REPL_COMMANDS) {
      expect(help).toContain(name);
      expect(help).toContain(description);
    }
  });

  it('aligns descriptions on one column', () => {
    const rows = renderHelp()
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line));
    expect(rows).toHaveLength(REPL_COMMANDS.length);

    const columns = new Set(
      rows.map((row) => {
        const match = row.match(/^ {2}(\S+)( +)(.*)$/);
        if (!match) throw new Error(`unexpected help row: ${row}`);
        expect(match[3].length).toBeGreaterThan(0);
        return 2 + match[1].length + match[2].length;
      })
    );
    expect(columns.size).toBe(1);
  });
});

describe('completeCommand', () => {
  it('offers the commands with the typed prefix', () => {
    expect(completeCommand('get-')).toEqual([
      ['get-ev-bsoc', 'get-battery-soc'],
      'get-',
    ]);
    expect(completeCommand('status')).toEqual([['status'], 'status']);
  });

  it('returns no hits, and the untouched line, for an unknown prefix', () => {
    expect(completeCommand('xyz')).toEqual([[], 'xyz']);
  });

  it('offers everything on an empty line', () => {
    expect(completeCommand('')).toEqual([names, '']);
  });
});

describe('busy-state metadata', () => {
  it('whitelists only commands that touch no network', () => {
    expect([...LOCAL_WHILE_BUSY].sort()).toEqual(['exit', 'help', 'quit', 'status']);
  });

  it('tells command names apart from sub-prompt answers', () => {
    // The gate prints a skip message only for input the switch would have
    // run; a charge-limit answer like `80` or a stray Enter must be silent.
    for (const name of [...names, 'quit']) {
      expect(isReplCommand(name)).toBe(true);
    }
    expect(isReplCommand('nope')).toBe(false);
    expect(isReplCommand('80')).toBe(false);
    expect(isReplCommand('')).toBe(false);
  });
});

describe('index.ts wiring', () => {
  it('passes the completer to the REPL readline and renders help from the list', () => {
    expect(INDEX_SOURCE).toContain('createReadline({ completer: completeCommand })');
    expect(INDEX_SOURCE).toContain('console.log(renderHelp())');
  });

  it('gates non-local commands before they reach the dispatcher', () => {
    // Asserted on the real source: a mirrored gate could drift while its tests
    // stayed green -- the same failure mode as the start-reporting mirror.
    const gate = INDEX_SOURCE.indexOf('skipped: a command is still running');
    const dispatch = INDEX_SOURCE.indexOf('const dispatchCommand');
    expect(gate).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(gate);
    expect(INDEX_SOURCE).toContain('if (blocker && !LOCAL_WHILE_BUSY.has(cmd))');
    // The finally must restore the prompt only when nothing else is running.
    expect(INDEX_SOURCE).toContain('if (active === 0 && !closed)');
  });

  it('keeps REPL_COMMANDS in sync with the dispatch switch', () => {
    const start = INDEX_SOURCE.indexOf('switch (cmd)');
    // Bound from `start`: the gate's rl.setPrompt('') now appears earlier.
    const end = INDEX_SOURCE.indexOf('rl.setPrompt', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const switchBody = INDEX_SOURCE.slice(start, end);
    const cases = [...switchBody.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]);
    expect(cases.length).toBeGreaterThan(5);

    const advertised = new Set(names);
    // `quit` is an accepted alias the help text deliberately does not advertise.
    const aliases = new Set(['quit']);
    for (const command of cases) {
      expect(advertised.has(command) || aliases.has(command)).toBe(true);
    }
    // And the reverse, which is how `config` and `pair-tesla-key` went missing
    // from help while still being real Commander commands: every advertised
    // command must actually run in the REPL.
    for (const name of names) {
      expect(cases).toContain(name);
    }
  });

  it('routes config and pair-tesla-key through the shared runners', () => {
    expect(INDEX_SOURCE).toContain("case 'config':");
    expect(INDEX_SOURCE).toContain("case 'pair-tesla-key':");
    expect(INDEX_SOURCE).toContain('await runConfig(options)');
    expect(INDEX_SOURCE).toContain('await runPairTeslaKey(options)');
    // The Commander wrappers stay the only place failure becomes an exit code.
    expect(INDEX_SOURCE).toContain('if (!(await runConfig(options))) process.exitCode = 1;');
    expect(INDEX_SOURCE).toContain('if (!(await runPairTeslaKey(options))) process.exitCode = 1;');
  });

  it('splits the command token from its inline flags', () => {
    expect(INDEX_SOURCE).toContain('const [first, ...rest] = input.trim().split(/\\s+/)');
    expect(INDEX_SOURCE).toContain('await dispatchCommand(cmd, rest)');
  });

  it('turns --help into the command help, before anything runs', () => {
    expect(INDEX_SOURCE).toContain('if (options.help)');
    expect(INDEX_SOURCE).toContain('printCommandHelp');
    // Rendered from Commander's own definition, so descriptions cannot drift.
    expect(INDEX_SOURCE).toContain('command.helpInformation()');
    expect(INDEX_SOURCE).toContain("printCommandHelp('config')");
    expect(INDEX_SOURCE).toContain("printCommandHelp('pair-tesla-key')");
  });

  it('routes `help <command>` to the same renderer', () => {
    expect(INDEX_SOURCE).toContain('if (topic !== undefined && printCommandHelp(topic)) break;');
  });
});

describe('parseCommandArgs - REPL inline flags match Commander', () => {
  it('returns empty options for no tokens', () => {
    expect(parseCommandArgs('config', [])).toEqual({ options: {}, error: null });
  });

  it('maps value flags to camelCase options', () => {
    expect(parseCommandArgs('config', ['--set-efficiency', '0.9'])).toEqual({
      options: { setEfficiency: '0.9' },
      error: null,
    });
    expect(parseCommandArgs('config', ['--tesla-domain', 'example.com'])).toEqual({
      options: { teslaDomain: 'example.com' },
      error: null,
    });
  });

  it('accepts boolean flags', () => {
    expect(parseCommandArgs('config', ['--clear-tesla'])).toEqual({
      options: { clearTesla: true },
      error: null,
    });
    expect(parseCommandArgs('pair-tesla-key', ['--check-only'])).toEqual({
      options: { checkOnly: true },
      error: null,
    });
  });

  it('mixes value and boolean flags in any order', () => {
    expect(
      parseCommandArgs('pair-tesla-key', ['--domain', 'example.com', '--skip-registration'])
    ).toEqual({ options: { domain: 'example.com', skipRegistration: true }, error: null });
  });

  it('keeps value case (only the command name is lowercased)', () => {
    expect(parseCommandArgs('config', ['--tesla-region', 'NA'])).toEqual({
      options: { teslaRegion: 'NA' },
      error: null,
    });
  });

  it('accepts --help and -h as booleans, alongside other flags', () => {
    expect(parseCommandArgs('config', ['--help'])).toEqual({
      options: { help: true },
      error: null,
    });
    expect(parseCommandArgs('pair-tesla-key', ['-h'])).toEqual({
      options: { help: true },
      error: null,
    });
    // Commander prints help and ignores the rest; the parse reflects that.
    expect(parseCommandArgs('config', ['--help', '--set-efficiency', '0.9'])).toEqual({
      options: { help: true, setEfficiency: '0.9' },
      error: null,
    });
  });

  it('rejects unknown options with a Commander-style message', () => {
    expect(parseCommandArgs('config', ['--nope'])).toEqual({
      options: {},
      error: "error: unknown option '--nope'",
    });
  });

  it('rejects stray positional arguments', () => {
    expect(parseCommandArgs('config', ['extra'])).toEqual({
      options: {},
      error: "error: unknown argument 'extra'",
    });
  });

  it('rejects a value flag missing its value', () => {
    expect(parseCommandArgs('pair-tesla-key', ['--domain'])).toEqual({
      options: {},
      error: "error: option '--domain <value>' argument missing",
    });
    expect(parseCommandArgs('pair-tesla-key', ['--domain', '--check-only'])).toEqual({
      options: {},
      error: "error: option '--domain <value>' argument missing",
    });
  });
});
