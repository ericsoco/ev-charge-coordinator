/**
 * REPL dispatch: every `case` of the start session's switch, executed
 * against a fake DispatchEnv — no services, no network, no real stores.
 *
 * The dispatch calls handlers DIRECTLY with env.session.currentContext()
 * (session.runCommand is the one-shot seam and must not run in the REPL: a
 * failed interactive command must not set exit codes or stop proxies). So the
 * hermetic model here is: handlers whose first act is a null-service check or
 * a flag validation execute inline against the fake context; handlers that do
 * real I/O (`status`, `sessions`, the set-home-location manual flow) are only
 * dispatched through their help/error branches, never their valid paths —
 * their behavior is covered by their own handler tests and their dispatch
 * wiring by the source pins in repl-commands.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchCommand, type DispatchEnv } from '../../src/commands/start.js';
import type { Session } from '../../src/commands/session.js';
import type { CommandContext, CommandResult } from '../../src/commands/context.js';
import type { NotifyDeps } from '../../src/commands/notify.js';

interface Harness {
  env: DispatchEnv;
  logs: string[];
  out: string[];
  notify: { topics: string[]; cleared: number; logs: string[] };
}

function makeHarness(options: { tesla?: CommandContext['tesla'] } = {}): Harness {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    out.push(values.map(String).join(' '));
  });

  const logs: string[] = [];
  const ctx: CommandContext = {
    franklin: null,
    tesla: options.tesla ?? null,
    config: {
      resolve: () => ({ config: null, missing: [], invalid: [], partial: {} }),
      setField: () => {},
      save: () => {},
    },
    ask: async () => 'n',
    askNumeric: async () => null,
    interactive: false,
    log: (message) => logs.push(message),
    errorLog: (message) => logs.push(message),
  };

  const session: Session = {
    initializeFranklin: async () => ({ ok: true }),
    initializeTesla: async () => ({ ok: true }),
    getFranklin: () => null,
    getTesla: () => null,
    currentContext: () => ctx,
    // The REPL dispatch never calls runCommand; record if it ever does.
    runCommand: async (_run: (c: CommandContext) => Promise<CommandResult>) => {
      throw new Error('dispatch must call handlers directly, not through runCommand');
    },
    requireService: () => {},
  };

  const notify = { topics: [] as string[], cleared: 0, logs: [] as string[] };
  const notifyDeps: NotifyDeps = {
    getNotifierEntries: () => [],
    getSecrets: async () => undefined,
    setNtfyTopic: async (topic) => {
      notify.topics.push(topic);
    },
    setSlackWebhookUrl: async () => {},
    clearNotifierSecrets: async () => {
      notify.cleared += 1;
    },
    promptSecret: async () => 'secret',
    log: (message) => notify.logs.push(message),
    nowMs: () => 0,
  };

  const env: DispatchEnv = {
    session,
    printCommandHelp: vi.fn(() => true),
    buildNotifyDeps: () => notifyDeps,
    onExit: vi.fn(),
  };

  return { env, logs, out, notify };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('help', () => {
  it('bare `help` renders the command list', async () => {
    const h = makeHarness();
    await dispatchCommand('help', [], h.env);
    expect(h.out.join('\n')).toContain('Available commands:');
  });

  it('`help <command>` prints that command’s help from the Commander definition', async () => {
    const h = makeHarness();
    await dispatchCommand('help', ['config'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('config');
  });

  it('a value flag missing its value errors before any runner', async () => {
    const h = makeHarness();
    await dispatchCommand('config', ['--set-buffer'], h.env);
    expect(h.out.join('\n')).toContain("option '--set-buffer <value>' argument missing");
    expect(h.env.printCommandHelp).not.toHaveBeenCalled();
  });

  it('`config --help` intercepts before runConfig (which would write config.json)', async () => {
    const h = makeHarness();
    await dispatchCommand('config', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('config');
  });

  it('unknown command warns', async () => {
    const h = makeHarness();
    await dispatchCommand('frobnicate', [], h.env);
    expect(h.out.join('\n')).toContain('Unknown command: frobnicate');
  });

  it('empty input is silent', async () => {
    const h = makeHarness();
    await dispatchCommand('', [], h.env);
    expect(h.env.printCommandHelp).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
  });
});

describe('positional commands', () => {
  it('set-ev-charge-limit 80 passes the value to the shared handler', async () => {
    const setChargeLimit = vi.fn(async (percent: number) => percent);
    const h = makeHarness({
      tesla: {
        isAuthenticated: () => true,
        setChargeLimit,
      } as unknown as CommandContext['tesla'],
    });
    await dispatchCommand('set-ev-charge-limit', ['80'], h.env);
    expect(setChargeLimit).toHaveBeenCalledWith(80);
    expect(h.logs.join('\n')).toContain('EV charge limit set to 80%');
  });

  it('set-ev-charge-limit 40 is rejected by the shared handler message', async () => {
    const h = makeHarness();
    await dispatchCommand('set-ev-charge-limit', ['40'], h.env);
    expect(h.logs.join('\n')).toContain('Charge limit must be between 50 and 100');
  });

  it('set-ev-charge-limit rejects stray positionals before the handler', async () => {
    const h = makeHarness();
    await dispatchCommand('set-ev-charge-limit', ['80', '90'], h.env);
    expect(h.out.join('\n')).toContain("too many arguments for 'set-ev-charge-limit'");
    expect(h.logs).toEqual([]);
  });

  it('set-ev-charge-limit --help prints the one-shot help instead of prompting', async () => {
    const h = makeHarness();
    await dispatchCommand('set-ev-charge-limit', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('set-ev-charge-limit');
    expect(h.logs).toEqual([]);
  });

  it('set-home-location --help prints help; >2 positionals are rejected before the handler', async () => {
    const h = makeHarness();
    await dispatchCommand('set-home-location', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('set-home-location');
    await dispatchCommand('set-home-location', ['1', '2', '3'], h.env);
    expect(h.out.join('\n')).toContain("too many arguments for 'set-home-location'");
    expect(h.logs).toEqual([]);
    // The valid 2-coordinate path is not dispatched here: the handler reads the
    // real home location from the credential store (covered by
    // system-commands.test.ts).
  });
});

describe('vehicle handlers run inline against the session context', () => {
  it.each([
    'get-ev-bsoc',
    'get-battery-soc',
    'get-charging-state',
    'start-ev-charging',
    'stop-ev-charging',
  ])('%s reports the null-service state', async (command) => {
    const h = makeHarness();
    await dispatchCommand(command, [], h.env);
    expect(h.logs.join('\n')).toMatch(/not connected/);
  });

  it('charge-from-battery without flags on a non-TTY says what a run would need', async () => {
    const h = makeHarness();
    await dispatchCommand('charge-from-battery', [], h.env);
    expect(h.logs.join('\n')).toContain('Non-interactive run: pass --start');
  });

  it('charge-from-battery --start --dry-run is refused by the shared handler', async () => {
    const h = makeHarness();
    await dispatchCommand('charge-from-battery', ['--start', '--dry-run'], h.env);
    expect(h.logs.join('\n')).toContain('--start and --dry-run are mutually exclusive');
  });
});

describe('flag parsing intercepts before handlers run', () => {
  it('`status --help`/`-h` print help; a bad flag prints a Commander-style error', async () => {
    const h = makeHarness();
    await dispatchCommand('status', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('status');
    await dispatchCommand('status', ['-h'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenLastCalledWith('status');
    await dispatchCommand('status', ['--bogus'], h.env);
    expect(h.out.join('\n')).toContain("unknown option '--bogus'");
    // The valid `status` path is not dispatched here: showStatus probes
    // localhost and reads the credential store (covered by
    // system-commands.test.ts; wiring pinned in repl-commands.test.ts).
  });

  it('`sessions --help` prints help; a stray positional is rejected', async () => {
    const h = makeHarness();
    await dispatchCommand('sessions', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('sessions');
    await dispatchCommand('sessions', ['5'], h.env);
    expect(h.out.join('\n')).toContain("unknown argument '5'");
  });

  it('`sessions --limit 5 --open` parses and resolves (the store read is read-only)', async () => {
    const h = makeHarness();
    await expect(
      dispatchCommand('sessions', ['--limit', '5', '--open'], h.env)
    ).resolves.toBeUndefined();
  });

  it('`authenticate --help` never starts the real OAuth flow', async () => {
    const h = makeHarness();
    await dispatchCommand('authenticate', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('authenticate');
    expect(h.out.join('\n')).not.toContain('Starting OAuth');
  });

  it('`pair-tesla-key --help` prints help; an unknown flag errors out', async () => {
    const h = makeHarness();
    await dispatchCommand('pair-tesla-key', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenCalledWith('pair-tesla-key');
    await dispatchCommand('pair-tesla-key', ['--bogus'], h.env);
    expect(h.out.join('\n')).toContain("unknown option '--bogus'");
  });
});

describe('notify dispatch (shared deps, hermetic runners)', () => {
  it('bare `notify` prints help; `notify --help` targets notify; `notify help set` the subcommand', async () => {
    const h = makeHarness();
    await dispatchCommand('notify', [], h.env);
    expect(h.env.printCommandHelp).toHaveBeenLastCalledWith('notify');
    await dispatchCommand('notify', ['--help'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenLastCalledWith('notify', undefined);
    await dispatchCommand('notify', ['help', 'set'], h.env);
    expect(h.env.printCommandHelp).toHaveBeenLastCalledWith('notify', 'set');
  });

  it('`notify set ntfy --topic` stores the secret through the injected deps', async () => {
    const h = makeHarness();
    await dispatchCommand('notify', ['set', 'ntfy', '--topic', 'my-topic'], h.env);
    expect(h.notify.topics).toEqual(['my-topic']);
    expect(h.notify.logs.join('\n')).toContain('ntfy secret stored');
  });

  it('`notify clear` and `notify test` run their runners', async () => {
    const h = makeHarness();
    await dispatchCommand('notify', ['clear'], h.env);
    expect(h.notify.cleared).toBe(1);
    await dispatchCommand('notify', ['test'], h.env);
    expect(h.notify.logs.join('\n')).toContain('notifications are disabled');
  });

  it('parse errors are reported Commander-style without running anything', async () => {
    const h = makeHarness();
    await dispatchCommand('notify', ['bogus'], h.env);
    expect(h.out.join('\n')).toContain("unknown command 'bogus'");
    await dispatchCommand('notify', ['set', 'pigeon'], h.env);
    expect(h.out.join('\n')).toContain("unknown notifier kind 'pigeon'");
    await dispatchCommand('notify', ['set', 'ntfy', '--nope'], h.env);
    expect(h.out.join('\n')).toContain("unknown option '--nope'");
    expect(h.notify.topics).toEqual([]);
    expect(h.notify.cleared).toBe(0);
  });
});

describe('session lifecycle cases', () => {
  it('`exit` and `quit` close the REPL through onExit', async () => {
    const h = makeHarness();
    await dispatchCommand('exit', [], h.env);
    await dispatchCommand('quit', [], h.env);
    expect(h.env.onExit).toHaveBeenCalledTimes(2);
  });
});
