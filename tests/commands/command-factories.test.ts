/**
 * Commander wiring for the per-command factories.
 *
 * Every createXCommand is constructed with fake deps and asserted on its
 * observable command shape — name, options, arguments, subcommands, and
 * allowExcessArguments(false) — plus action routing through a fake session.
 * The runners' behavior lives in the vehicle/system/notify/authenticate
 * tests; this file pins the factories themselves, which previously had no
 * executing tests at all (index.ts could not be imported: it parses argv on
 * module load).
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_SOURCE } from '../helpers/commandSources.js';
import type { Session } from '../../src/commands/session.js';
import type { CommandContext, CommandResult } from '../../src/commands/context.js';
import type { NotifyDeps } from '../../src/commands/notify.js';
import { createNotifyCommand } from '../../src/commands/notify.js';
import { createStartCommand } from '../../src/commands/start.js';
import { createExitCommand } from '../../src/commands/exit.js';
import { createDaemonCommand } from '../../src/commands/daemon.js';
import {
  createSessionsCommand,
  createSetHomeLocationCommand,
  createStatusCommand,
} from '../../src/commands/system.js';
import {
  createChargeFromBatteryCommand,
  createGetBatterySocCommand,
  createGetChargingStateCommand,
  createGetEvBsocCommand,
  createSetEvChargeLimitCommand,
  createStartEvChargingCommand,
  createStopEvChargingCommand,
} from '../../src/commands/vehicle.js';
import { createAuthenticateCommand } from '../../src/commands/authenticate.js';
import { createConfigCommand } from '../../src/commands/config.js';
import { createPairTeslaKeyCommand } from '../../src/commands/pairTeslaKey.js';

// Belt and braces: if an allowExcessArguments guard ever regressed, a parse
// below would RUN its action instead of rejecting — `exit` would reach the
// real proxy teardown APIs. The mocks keep even a broken guard harmless.
vi.mock('../../src/services/TeslaCommandProxy.js', () => ({
  startTeslaProxy: vi.fn(async () => {
    throw new Error('proxy must not start in unit tests');
  }),
  stopTeslaProxy: vi.fn(async () => false),
  spawnedTeslaProxyPid: vi.fn(() => null),
}));
vi.mock('../../src/services/ProcessManager.js', () => ({
  readRuntimeState: vi.fn(() => null),
  writeRuntimeState: vi.fn(),
  clearRuntimeState: vi.fn(),
  isProcessAlive: vi.fn(() => false),
  terminateProcess: vi.fn(async () => 'already gone'),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  session: Session;
  calls: string[];
  routed: ((ctx: CommandContext) => Promise<CommandResult>)[];
  logs: string[];
  ctx: CommandContext;
}

/** A session whose runCommand records the handler instead of executing it. */
function makeHarness(): Harness {
  const calls: string[] = [];
  const routed: ((ctx: CommandContext) => Promise<CommandResult>)[] = [];
  const logs: string[] = [];
  const franklin = {
    disconnect: async () => {
      calls.push('franklin.disconnect');
    },
  };
  const ctx: CommandContext = {
    franklin: null,
    tesla: null,
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
    initializeFranklin: async () => {
      calls.push('initializeFranklin');
      return { ok: true };
    },
    initializeTesla: async () => {
      calls.push('initializeTesla');
      return { ok: true };
    },
    getFranklin: () => franklin as unknown as NonNullable<ReturnType<Session['getFranklin']>>,
    getTesla: () => null,
    currentContext: () => ctx,
    runCommand: async (run) => {
      calls.push('runCommand');
      routed.push(run);
    },
    requireService: (name, init) => {
      calls.push(`requireService:${name}:${init.ok}`);
    },
  };
  return { session, calls, routed, logs, ctx };
}

/** Hermetic notify deps: records writes instead of touching the credential store. */
function makeNotifyDeps(log: string[] = []): { deps: NotifyDeps; state: NotifyState } {
  const state: NotifyState = { topics: [], slack: [], cleared: 0 };
  const deps: NotifyDeps = {
    getNotifierEntries: () => [],
    getSecrets: async () => undefined,
    setNtfyTopic: async (topic) => {
      state.topics.push(topic);
    },
    setSlackWebhookUrl: async (url) => {
      state.slack.push(url);
    },
    clearNotifierSecrets: async () => {
      state.cleared += 1;
    },
    promptSecret: async () => 'secret',
    log: (message) => log.push(message),
    nowMs: () => 0,
  };
  return { deps, state };
}

interface NotifyState {
  topics: string[];
  slack: string[];
  cleared: number;
}

interface FactorySpec {
  name: string;
  make: (h: Harness) => Command;
  options: string[];
  arguments?: string[];
  subcommands?: string[];
}

const SPECS: FactorySpec[] = [
  {
    name: 'start',
    make: (h) =>
      createStartCommand({
        session: h.session,
        printCommandHelp: () => true,
        buildNotifyDeps: () => makeNotifyDeps().deps,
      }),
    options: ['--daemon', '--debug'],
  },
  { name: 'exit', make: (h) => createExitCommand({ session: h.session }), options: [] },
  {
    name: 'daemon',
    make: (h) => createDaemonCommand({ session: h.session }),
    options: ['--once', '--dry-run', '--debug'],
    subcommands: ['stop', 'restart', 'install', 'uninstall', 'logs'],
  },
  { name: 'status', make: (h) => createStatusCommand({ session: h.session }), options: ['--json'] },
  {
    name: 'sessions',
    make: (h) => createSessionsCommand({ session: h.session }),
    options: ['--limit <n>', '--open'],
  },
  {
    name: 'set-home-location',
    make: (h) => createSetHomeLocationCommand({ session: h.session }),
    options: [],
    arguments: ['latitude', 'longitude'],
  },
  { name: 'get-ev-bsoc', make: (h) => createGetEvBsocCommand({ session: h.session }), options: [] },
  {
    name: 'get-battery-soc',
    make: (h) => createGetBatterySocCommand({ session: h.session }),
    options: [],
  },
  {
    name: 'get-charging-state',
    make: (h) => createGetChargingStateCommand({ session: h.session }),
    options: [],
  },
  {
    name: 'set-ev-charge-limit',
    make: (h) => createSetEvChargeLimitCommand({ session: h.session }),
    options: [],
    arguments: ['percent'],
  },
  {
    name: 'start-ev-charging',
    make: (h) => createStartEvChargingCommand({ session: h.session }),
    options: [],
  },
  {
    name: 'stop-ev-charging',
    make: (h) => createStopEvChargingCommand({ session: h.session }),
    options: [],
  },
  {
    name: 'charge-from-battery',
    make: (h) => createChargeFromBatteryCommand({ session: h.session }),
    options: ['--start', '--dry-run'],
  },
  {
    name: 'authenticate',
    make: () => createAuthenticateCommand(),
    options: ['--client-id <id>', '--client-secret <secret>', '--reauth'],
  },
  {
    name: 'notify',
    make: () => createNotifyCommand(makeNotifyDeps().deps),
    options: [],
    subcommands: ['set', 'clear', 'test'],
  },
  {
    name: 'config',
    make: () => createConfigCommand(),
    options: [
      '--clear-franklin',
      '--clear-tesla',
      '--clear-credentials',
      '--tesla-region <region>',
      '--tesla-domain <domain>',
      '--show-public-key',
      '--set-battery-kwh <n>',
      '--set-ev-kwh <n>',
      '--set-efficiency <0-1>',
      '--set-buffer <percent>',
    ],
  },
  {
    name: 'pair-tesla-key',
    make: () => createPairTeslaKeyCommand(),
    options: [
      '--domain <domain>',
      '--vin <vin>',
      '--check-only',
      '--skip-registration',
      '--rotate-key',
    ],
  },
];

describe('factory command metadata', () => {
  for (const spec of SPECS) {
    it(`${spec.name}: name, description, options${spec.arguments ? ', arguments' : ''}${
      spec.subcommands ? ', subcommands' : ''
    }`, () => {
      const cmd = spec.make(makeHarness());
      expect(cmd.name()).toBe(spec.name);
      expect(cmd.description().length).toBeGreaterThan(0);
      expect(cmd.options.map((option) => option.flags)).toEqual(spec.options);
      if (spec.arguments) {
        expect(cmd.registeredArguments.map((argument) => argument.name())).toEqual(spec.arguments);
      }
      if (spec.subcommands) {
        expect(cmd.commands.map((sub) => sub.name()).sort()).toEqual([...spec.subcommands].sort());
      }
    });
  }

  it('set-ev-charge-limit requires its percent; set-home-location takes optional coordinates', () => {
    const limit = createSetEvChargeLimitCommand({ session: makeHarness().session });
    expect(limit.registeredArguments.map((argument) => argument.required)).toEqual([true]);
    const home = createSetHomeLocationCommand({ session: makeHarness().session });
    expect(home.registeredArguments.map((argument) => argument.required)).toEqual([false, false]);
  });
});

/**
 * Every one-shot command rejects stray positionals before its action runs
 * (addCommand does not inherit the program's allowExcessArguments setting, so
 * each factory sets it). Actions are swapped for a recorder first, so even a
 * regression cannot cause side effects — the test then fails on the recorder.
 */
async function expectExcessRejected(spec: FactorySpec, argv: string[]): Promise<void> {
  const cmd = spec.make(makeHarness());
  let ran = false;
  // exitOverride/configureOutput do NOT propagate to subcommands created
  // before the call (settings are copied at .command() time), so harden every
  // level recursively.
  const harden = (command: Command): void => {
    command.action(async () => {
      ran = true;
    });
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    command.commands.forEach(harden);
  };
  harden(cmd);

  let thrown: unknown;
  try {
    await cmd.parseAsync(['node', 'evcc', ...argv], { from: 'node' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${spec.name} ${argv.join(' ')} must be rejected`).toBeDefined();
  expect(String((thrown as Error).message)).toMatch(/too many arguments/);
  expect(ran, `${spec.name} action must not run on excess arguments`).toBe(false);
}

describe('one-shot commands reject stray positionals', () => {
  const cases: [commandName: string, argv: string[]][] = [
    ['start', ['extra']],
    ['exit', ['extra']],
    ['daemon', ['extra']],
    ['daemon', ['stop', 'extra']],
    ['status', ['extra']],
    ['sessions', ['extra']],
    ['set-home-location', ['1', '2', '3']],
    ['get-ev-bsoc', ['extra']],
    ['get-battery-soc', ['extra']],
    ['get-charging-state', ['extra']],
    ['set-ev-charge-limit', ['80', '90']],
    ['start-ev-charging', ['extra']],
    ['stop-ev-charging', ['extra']],
    ['charge-from-battery', ['extra']],
    ['authenticate', ['extra']],
    ['notify', ['clear', 'extra']],
    ['notify', ['set', 'ntfy', 'extra']],
    ['config', ['extra']],
    ['pair-tesla-key', ['extra']],
  ];

  for (const [name, argv] of cases) {
    it(`${name} ${argv.join(' ')}`, async () => {
      const spec = SPECS.find((candidate) => candidate.name === name);
      expect(spec, name).toBeDefined();
      await expectExcessRejected(spec!, argv);
    });
  }
});

describe('factory actions route through the session', () => {
  it('set-ev-charge-limit validates the value, requires Tesla, and runs the handler', async () => {
    const h = makeHarness();
    const cmd = createSetEvChargeLimitCommand({ session: h.session });
    await cmd.parseAsync(['node', 'evcc', '80'], { from: 'node' });
    expect(h.calls).toEqual(['initializeTesla', 'requireService:Tesla:true', 'runCommand']);
    expect(h.routed).toHaveLength(1);
  });

  it('set-ev-charge-limit rejects an out-of-range value with exit 1, before any service', async () => {
    const h = makeHarness();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cmd = createSetEvChargeLimitCommand({ session: h.session });
    await expect(cmd.parseAsync(['node', 'evcc', '40'], { from: 'node' })).rejects.toThrow(
      'process.exit(1)'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.calls).toEqual([]);
  });

  it('get-battery-soc requires FranklinWH and disconnects in finally', async () => {
    const h = makeHarness();
    const cmd = createGetBatterySocCommand({ session: h.session });
    await cmd.parseAsync(['node', 'evcc'], { from: 'node' });
    expect(h.calls).toEqual([
      'initializeFranklin',
      'requireService:FranklinWH:true',
      'runCommand',
      'franklin.disconnect',
    ]);
  });

  it('charge-from-battery requires both services in order, then disconnects', async () => {
    const h = makeHarness();
    const cmd = createChargeFromBatteryCommand({ session: h.session });
    await cmd.parseAsync(['node', 'evcc', '--start'], { from: 'node' });
    expect(h.calls).toEqual([
      'initializeFranklin',
      'requireService:FranklinWH:true',
      'initializeTesla',
      'requireService:Tesla:true',
      'runCommand',
      'franklin.disconnect',
    ]);
  });

  it.each([
    ['get-ev-bsoc', createGetEvBsocCommand],
    ['get-charging-state', createGetChargingStateCommand],
    ['start-ev-charging', createStartEvChargingCommand],
    ['stop-ev-charging', createStopEvChargingCommand],
  ])('%s requires Tesla and routes to its handler', async (name, make) => {
    const h = makeHarness();
    await make({ session: h.session }).parseAsync(['node', 'evcc'], { from: 'node' });
    expect(h.calls).toEqual(['initializeTesla', 'requireService:Tesla:true', 'runCommand']);
    expect(h.routed).toHaveLength(1);
  });

  it('set-home-location with no arguments takes the vehicle flow (requires Tesla)', async () => {
    const h = makeHarness();
    const cmd = createSetHomeLocationCommand({ session: h.session });
    await cmd.parseAsync(['node', 'evcc'], { from: 'node' });
    expect(h.calls).toEqual(['initializeTesla', 'requireService:Tesla:true', 'runCommand']);
  });

  it('notify set stores the secret through the shared deps (hermetic)', async () => {
    const { deps, state } = makeNotifyDeps();
    const cmd = createNotifyCommand(deps);
    await cmd.parseAsync(['node', 'evcc', 'set', 'ntfy', '--topic', 'my-topic'], { from: 'node' });
    expect(state.topics).toEqual(['my-topic']);
    expect(state.cleared).toBe(0);
  });

  it('notify clear wipes both secrets through the shared deps', async () => {
    const { deps, state } = makeNotifyDeps();
    const cmd = createNotifyCommand(deps);
    await cmd.parseAsync(['node', 'evcc', 'clear'], { from: 'node' });
    expect(state.cleared).toBe(1);
  });

  it('notify rejects an unknown kind with the one-shot action message', async () => {
    const { deps } = makeNotifyDeps();
    const cmd = createNotifyCommand(deps);
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(
      cmd.parseAsync(['node', 'evcc', 'set', 'pigeon'], { from: 'node' })
    ).rejects.toThrow(/unknown notifier kind 'pigeon'/);
  });
});

describe('index.ts registration order (--help listing)', () => {
  it('adds the commands in the documented order', () => {
    const registered = [...COMMAND_SOURCE.matchAll(/program\.addCommand\(\s*create(\w+)Command/g)].map(
      (match) => match[1]
    );
    expect(registered).toEqual([
      'Start',
      'Exit',
      'Daemon',
      'Status',
      'Sessions',
      'SetHomeLocation',
      'GetEvBsoc',
      'GetBatterySoc',
      'GetChargingState',
      'SetEvChargeLimit',
      'StartEvCharging',
      'StopEvCharging',
      'ChargeFromBattery',
      'Authenticate',
      'Notify',
      'Config',
      'PairTeslaKey',
    ]);
  });
});


