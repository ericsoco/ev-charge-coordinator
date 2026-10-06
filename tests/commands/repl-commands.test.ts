/**
 * REPL command metadata: `help` and tab completion share one source.
 *
 * The dispatch switch in index.ts cannot be enumerated at runtime, so the
 * sync between it and REPL_COMMANDS is asserted against the real source --
 * a mirrored list alone could drift while every test stayed green.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPL_COMMANDS, completeCommand, renderHelp } from '../../src/commands/repl.js';

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

describe('index.ts wiring', () => {
  it('passes the completer to the REPL readline and renders help from the list', () => {
    expect(INDEX_SOURCE).toContain('createReadline({ completer: completeCommand })');
    expect(INDEX_SOURCE).toContain('console.log(renderHelp())');
  });

  it('keeps REPL_COMMANDS in sync with the dispatch switch', () => {
    const start = INDEX_SOURCE.indexOf('switch (cmd)');
    const end = INDEX_SOURCE.indexOf('rl.setPrompt');
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
  });
});
