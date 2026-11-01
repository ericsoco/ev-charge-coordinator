/**
 * `start`: initialize the services, report their state, then either stay
 * resident (--daemon) or run the interactive REPL.
 *
 * The REPL dispatch switch lives here because the REPL belongs to this
 * command. Each case routes to the same shared handler the one-shot CLI path
 * uses, because the logic used to exist twice -- here and in the Commander
 * actions -- and the two copies had already drifted.
 */
import { Command } from 'commander';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { setProxyLogSink } from '../services/index.js';
import {
  clearRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from '../services/ProcessManager.js';
import {
  spawnedTeslaProxyPid,
  startTeslaProxy,
  stopTeslaProxy,
} from '../services/TeslaCommandProxy.js';
import { describeConfigProblems, energyConfigPath, resolveEnergyConfig } from '../utils/config.js';
import * as paint from '../utils/color.js';
import { pendingQuestion, promptNumeric, setReplReadline } from './prompt.js';
import {
  completeCommand,
  isReplCommand,
  LOCAL_WHILE_BUSY,
  parseCommandArgs,
  parseNotifyArgs,
  renderHelp,
} from './repl.js';
import { runAuthenticate } from './authenticate.js';
import { runConfig } from './config.js';
import { runPairTeslaKey } from './pairTeslaKey.js';
import {
  chargeFromBattery,
  getBatterySoc,
  getChargingState,
  getEvBatterySoc,
  setEvChargeLimit,
  startEvCharging,
  stopEvCharging,
} from './vehicle.js';
import { setHomeLocationCommand, showSessions, showStatus } from './system.js';
import { runNotifySet, runNotifyClear, runNotifyTest, type NotifyDeps } from './notify.js';
import { describeError } from './context.js';
import { DEFAULT_PROXY_PORT, reportDebugDetails, type Session } from './session.js';

/**
 * Stay alive without a prompt, for `start --daemon`.
 *
 * The promise only settles on a shutdown signal, so the process keeps its child
 * proxy and the recorded runtime state valid until `exit` stops them.
 */
function keepResident(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      console.log(paint.info(`\nReceived ${signal}; exiting. The proxy is left running.`));
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}

/**
 * Warn when something is listening on the proxy port that no state file records.
 *
 * A proxy in this position is invisible to `exit`, which is how an orphan
 * survives: the state file is only written when this process spawned the proxy,
 * so a proxy left behind by an earlier failed run is never stopped by anything.
 * Reporting it turns a silent orphan into something the user can act on.
 */
async function warnAboutUntrackedProxy(spawnedPid: number | null): Promise<void> {
  if (spawnedPid) return; // our own; it is recorded and exit can stop it
  if (readRuntimeState()) return; // someone else's, and recorded
  if (!(await isProxyPortOpen(DEFAULT_PROXY_PORT))) return;

  console.log(
    paint.warning(
      `\nWarning: something is listening on port ${DEFAULT_PROXY_PORT} but no runtime\n` +
        `  state records it, so \`exit\` will not stop it. If it is an orphaned proxy:\n` +
        `    lsof -ti tcp:${DEFAULT_PROXY_PORT} | xargs kill`
    )
  );
}

/**
 * True when something accepts a TCP connection on the loopback port.
 *
 * A refused connection means nothing is listening. A timeout is reported as open,
 * so the warning errs toward telling the user rather than hiding a possible
 * orphan behind a firewall.
 */
function isProxyPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false)); // ECONNREFUSED: nothing listening
    socket.once('timeout', () => finish(true));
    socket.setTimeout(timeoutMs);
  });
}

/**
 * The REPL's readline.
 *
 * Tab completion comes from readline's `completer` hook (no package needed);
 * arrow-key history is built into node:readline already. Sub-prompts borrow
 * this one interface instead of opening a second on the same stdin -- see
 * commands/prompt.ts for why that doubling was a bug. Secrets go through
 * promptSecret on that same interface, masked keystroke by keystroke.
 */
function createReadline(options: { completer?: (line: string) => [string[], string] } = {}) {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(options.completer ? { completer: options.completer } : {})
  });
}

export interface StartCommandDeps {
  session: Session;
  /**
   * Print a registered command's (sub)command help. Injected because the
   * lookup needs the Commander program, which assembles the commands in
   * index.ts.
   */
  printCommandHelp: (name: string, subcommand?: string) => boolean;
  /** Shared with the one-shot `notify` registration (see index.ts). */
  buildNotifyDeps: () => NotifyDeps;
}

/**
 * REPL command dispatch: the interactive switch the `start` session runs.
 *
 * Extracted as a module-level function so tests can dispatch commands against
 * a fake environment (tests/commands/repl-dispatch.test.ts) without starting
 * the services. The busy gate, prompt handling, and readline lifecycle stay
 * in the start action, which owns the interface.
 */
export interface DispatchEnv {
  session: Session;
  printCommandHelp: (name: string, subcommand?: string) => boolean;
  buildNotifyDeps: () => NotifyDeps;
  /** Close the REPL: marks the session closed and closes the readline. */
  onExit: () => void;
}

export async function dispatchCommand(
  cmd: string,
  args: string[],
  env: DispatchEnv
): Promise<void> {
  const { session, printCommandHelp, buildNotifyDeps } = env;
  const currentContext = () => session.currentContext();

  switch (cmd) {
    case 'help': {
      // `help <command>` matches the CLI's `help <command>`; unknown or
      // bare `help` falls through to the general list.
      const topic = args[0];
      if (topic !== undefined && printCommandHelp(topic)) break;
      console.log(renderHelp());
      break;
    }

    case 'authenticate': {
      // Same helper the standalone command uses, so the REPL and
      // `ev-charge-coordinator authenticate` cannot drift apart — flags
      // included: parseCommandArgs mirrors Commander's definitions.
      const { options, error } = parseCommandArgs('authenticate', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      if (options.help) {
        printCommandHelp('authenticate');
        break;
      }
      await runAuthenticate({
        clientId: typeof options.clientId === 'string' ? options.clientId : undefined,
        clientSecret:
          typeof options.clientSecret === 'string' ? options.clientSecret : undefined,
        reauth: options.reauth === true,
      });
      break;
    }

    case 'status': {
      const { options, error } = parseCommandArgs('status', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      if (options.help) {
        printCommandHelp('status');
        break;
      }
      await showStatus(currentContext(), { json: options.json === true });
      break;
    }

    case 'sessions': {
      const { options, error } = parseCommandArgs('sessions', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      if (options.help) {
        printCommandHelp('sessions');
        break;
      }
      const limit = options.limit === undefined ? 10 : Number(options.limit);
      await showSessions(currentContext(), {
        limit,
        openOnly: options.open === true,
      });
      break;
    }

    case 'set-home-location': {
      // Positional arguments only, no flags: `set-home-location` uses the
      // vehicle; `set-home-location <lat> <lng>` sets manually. The handler
      // always confirms before writing (the stored value is otherwise
      // invisible). --help is intercepted so it prints the command help
      // rather than being parsed as a latitude, like the one-shot CLI.
      if (args.includes('--help') || args.includes('-h')) {
        printCommandHelp('set-home-location');
        break;
      }
      if (args.length > 2) {
        // Mirrors the one-shot's Commander rejection of stray positionals.
        console.log(
          paint.warning(`error: too many arguments for 'set-home-location'. Expected 2 arguments but got ${args.length}.`)
        );
        break;
      }
      await setHomeLocationCommand(currentContext(), args[0], args[1]);
      break;
    }

    // Everything below dispatches to the same handler the one-shot CLI path
    // uses. These cases used to carry their own copies of the logic and had
    // already drifted: the REPL printed 'Setting EV limit to' and offered to
    // start charging, the one-shot path did neither.
    case 'get-ev-bsoc':
      await getEvBatterySoc(currentContext());
      break;

    case 'get-battery-soc':
      await getBatterySoc(currentContext());
      break;

    case 'get-charging-state':
      await getChargingState(currentContext());
      break;

    case 'set-ev-charge-limit': {
      // Inline value mirrors the one-shot `<percent>` argument; no value
      // falls back to the REPL's numeric prompt. --help prints the same
      // help the one-shot command would show (Commander renders it from
      // its own definition, so the two cannot drift).
      if (args.includes('--help') || args.includes('-h')) {
        printCommandHelp('set-ev-charge-limit');
        break;
      }
      if (args.length > 1) {
        console.log(
          paint.warning(`error: too many arguments for 'set-ev-charge-limit'. Expected 1 argument but got ${args.length}.`)
        );
        break;
      }
      let limit: number;
      if (args.length === 1) {
        // The handler validates NaN and range with the same message the
        // one-shot action prints, so no check is needed here.
        limit = parseInt(args[0]);
      } else {
        const limitStr = await promptNumeric('Enter charge limit (50-100%, ESC to cancel): ');
        if (limitStr === null) {
          // ESC never submits a line, so start a fresh one for the notice.
          console.log(paint.info('\nCancelled.'));
          break;
        }
        limit = parseInt(limitStr);
        if (isNaN(limit)) {
          console.log(paint.warning('Invalid charge limit. Must be a number between 50 and 100.'));
          break;
        }
      }
      await setEvChargeLimit(currentContext(), limit);
      break;
    }

    case 'start-ev-charging':
      await startEvCharging(currentContext());
      break;

    case 'stop-ev-charging':
      await stopEvCharging(currentContext());
      break;

    case 'charge-from-battery': {
      const { options, error } = parseCommandArgs('charge-from-battery', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      if (options.help) {
        printCommandHelp('charge-from-battery');
        break;
      }
      await chargeFromBattery(currentContext(), {
        start: options.start === true,
        dryRun: options.dryRun === true,
      });
      break;
    }

    case 'config': {
      const { options, error } = parseCommandArgs('config', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      // --help wins over the other flags, exactly like Commander.
      if (options.help) {
        printCommandHelp('config');
        break;
      }
      await runConfig(options);
      break;
    }

    case 'pair-tesla-key': {
      const { options, error } = parseCommandArgs('pair-tesla-key', args);
      if (error) {
        console.log(paint.warning(error));
        break;
      }
      if (options.help) {
        printCommandHelp('pair-tesla-key');
        break;
      }
      await runPairTeslaKey(options);
      break;
    }

    case 'notify': {
      // Subcommand structure (`set <kind> [--topic|--webhook-url]`,
      // `clear`, `test`) that parseCommandArgs cannot express — same
      // accepts/rejects via parseNotifyArgs, shared deps via
      // buildNotifyDeps, and the same runners the one-shot dispatches to.
      const parsed = parseNotifyArgs(args);
      if (parsed.error !== null) {
        console.log(paint.warning(parsed.error));
        break;
      }
      if (parsed.helpFor !== null) {
        printCommandHelp('notify', parsed.helpFor === 'notify' ? undefined : parsed.helpFor);
        break;
      }
      if (parsed.subcommand === null) {
        // Bare `notify`: the one-shot prints its help; do the same here.
        printCommandHelp('notify');
        break;
      }
      const notifyDeps = buildNotifyDeps();
      try {
        if (parsed.subcommand === 'set') {
          const kind = parsed.kind as 'ntfy' | 'slack';
          const value =
            kind === 'ntfy'
              ? typeof parsed.options.topic === 'string'
                ? parsed.options.topic
                : undefined
              : typeof parsed.options.webhookUrl === 'string'
                ? parsed.options.webhookUrl
                : undefined;
          await runNotifySet(kind, value, notifyDeps);
        } else if (parsed.subcommand === 'clear') {
          await runNotifyClear(notifyDeps);
        } else if (parsed.subcommand === 'test') {
          // false = nothing sent; the reason is already logged by the runner.
          await runNotifyTest(notifyDeps);
        }
      } catch (error) {
        console.log(paint.error(`error: ${describeError(error)}`));
      }
      break;
    }

    case 'exit':
    case 'quit':
      env.onExit();
      return;

    case '':
      break;

    default:
      console.log(paint.warning(`Unknown command: ${cmd}. Type \"help\" for available commands.`));
  }
}

export function createStartCommand(deps: StartCommandDeps): Command {
  const { session } = deps;

  return new Command('start')
    .allowExcessArguments(false)
    .description('Start the Python API proxy and NodeJS server')
    .option('--daemon', 'Stay resident without the interactive prompt')
    .option('--debug', 'Print full stack traces for service startup failures')
    .action(async (options) => {
      console.log(paint.info('Starting EV Charge Coordinator...\n'));

      // Service status reported per service.
      // Each line states what actually happened for one service.
      const franklin = await session.initializeFranklin();
      const tesla = await session.initializeTesla();

      if (tesla.ok) {
        console.log(paint.positive('✓ Tesla service started successfully'));
      } else {
        console.log(paint.error(`✗ Tesla service not started. Error: ${tesla.error}`));
        reportDebugDetails(options.debug, tesla.cause);
      }
      if (franklin.ok) {
        console.log(paint.positive('✓ FranklinWH service started successfully'));
      } else {
        console.log(paint.error(`✗ FranklinWH service not started. Error: ${franklin.error}`));
        reportDebugDetails(options.debug, franklin.cause);
      }

      // Energy config status, reported like the services above. Non-fatal: only
      // charge-from-battery needs it, so a session without it is still worth
      // having.
      const energy = resolveEnergyConfig();
      if (energy.config) {
        console.log(paint.positive(`✓ Energy config ready (${energyConfigPath()})`));
      } else if (energy.invalid.length > 0) {
        console.log(paint.error(`✗ Energy config invalid (${energyConfigPath()}):`));
        for (const problem of describeConfigProblems(energy)) {
          console.log(paint.error(`  ${problem}`));
        }
      } else {
        console.log(
          paint.warning(
            `✗ Energy config missing at ${energyConfigPath()} - run \`config\` for the template,` +
              ' or charge-from-battery to be prompted'
          )
        );
      }

      // Signed-command sidecar: without it, Tesla rejects every vehicle command
      // with HTTP 403 (Vehicle Command Protocol required). Non-fatal, like the
      // service lines above -- reads work without it, charging commands do not.
      try {
        const handle = await startTeslaProxy();
        console.log(
          paint.positive(
            handle.spawnedPid
              ? `✓ Tesla command proxy: pid ${handle.spawnedPid}, port ${handle.port} (started here)`
              : `✓ Tesla command proxy: port ${handle.port} (already running, reused)`
          )
        );
      } catch (error) {
        console.log(
          paint.error(
            `✗ Tesla command proxy not started. Error: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }

      if (!franklin.ok && !tesla.ok) {
        console.log(paint.error('\nNo services available. Exiting.'));
        process.exitCode = 1;
        return;
      }

      // Record the proxy so `exit` can stop it from a different process. Only
      // written when this process actually spawned one -- attaching to a proxy that
      // someone else started must not overwrite their recorded PID.
      const spawnedPid = session.getFranklin()?.spawnedProxyPid ?? null;
      if (spawnedPid) {
        writeRuntimeState({
          pid: spawnedPid,
          port: DEFAULT_PROXY_PORT,
          startedAt: Date.now(),
          // Raw token, owner-only file; see RuntimeState for why not a hash.
          token: session.getFranklin()?.sharedToken ?? undefined,
        });
      }

      if (franklin.ok) {
        const pid = session.getFranklin()?.spawnedProxyPid;
        console.log(
          paint.positive(
            pid
              ? `  Solar battery proxy: pid ${pid}, port ${DEFAULT_PROXY_PORT} (started here)`
              : `  Solar battery proxy: port ${DEFAULT_PROXY_PORT} (already running, reused)`
          )
        );
      } else {
        console.log(paint.error('  Solar battery proxy: not running'));
      }
      await warnAboutUntrackedProxy(spawnedPid);
      console.log(paint.info('Type "help" for available commands or "exit" to quit.\n'));

      // `--daemon` stays resident without the REPL, so `start --daemon` can be
      // backgrounded and `exit` run from another terminal. Exiting instead would
      // orphan the proxy and defeat the point of the flag.
      if (options.daemon) {
        // Only advertise `exit` when it would actually have something to stop.
        if (spawnedPid) {
          console.log(paint.info('Running in the background. Stop with: node dist/index.js exit'));
        } else {
          console.log(paint.info('The solar battery proxy is not running, so `exit` has nothing to stop.'));
        }
        await keepResident();
        return;
      }

      // Interactive command loop
      const rl = createReadline({ completer: completeCommand });
      // Sub-prompts borrow this interface; opening a second one on the same
      // stdin is what caused the double-echo and the broken-prompt bugs.
      setReplReadline(rl);

      // A [proxy] line can arrive while the prompt is on screen; write it, then
      // re-render the prompt so the line never lands inside the prompt text.
      let awaitingInput = false;
      const renderProxyLog = (text: string): void => {
        console.log(paint.info(text));
        if (awaitingInput) rl.prompt(true);
      };
      setProxyLogSink(renderProxyLog);

      // The gate. Readline keeps emitting 'line' while an async handler is still
      // running, so without this two commands overlap: their output interleaves
      // and both hit the proxy at once, doubling the load on an already-flaky
      // upstream. Non-local commands are skipped with an explicit line rather
      // than queued -- a queue hides the delay and still fires every accidental
      // duplicate at Franklin. Input that is not a command name (sub-prompt
      // answers, stray Enter presses) is dropped silently while busy.
      //
      // `blocker` is what the skip check tests; `active` counts everything
      // running, so a whitelisted `help` finishing early cannot re-prompt over a
      // command still in flight. `closed` keeps the finally off a closed readline.
      let blocker = false;
      let active = 0;
      let closed = false;

      const env: DispatchEnv = {
        session,
        printCommandHelp: deps.printCommandHelp,
        buildNotifyDeps: deps.buildNotifyDeps,
        onExit: () => {
          closed = true;
          rl.close();
        },
      };

      const handleCommand = async (input: string): Promise<void> => {
        // First token is the command; the rest are its inline flags (config,
        // pair-tesla-key). Values keep their case -- only the command name is
        // lowercased.
        const [first, ...rest] = input.trim().split(/\s+/);
        const cmd = (first ?? '').toLowerCase();

        if (blocker && !LOCAL_WHILE_BUSY.has(cmd)) {
          if (isReplCommand(cmd)) {
            console.log(paint.warning(`'${cmd}' skipped: a command is still running. Wait for it to finish.`));
          }
          return;
        }

        active += 1;
        if (!LOCAL_WHILE_BUSY.has(cmd)) blocker = true;
        awaitingInput = false;
        // Blank prompt while busy: typing must not render a stale `ev-charge> `.
        rl.setPrompt('');
        try {
          await dispatchCommand(cmd, rest, env);
        } finally {
          if (!LOCAL_WHILE_BUSY.has(cmd)) blocker = false;
          // Clamp at zero: a stray extra decrement must not drive the counter
          // negative, which would make `active === 0` unreachable and leave the
          // prompt unrestored for the rest of the session.
          active = Math.max(0, active - 1);
          const openQuestion = pendingQuestion();
          if (active === 0 && !closed) {
            rl.setPrompt(paint.prompt('ev-charge> '));
            awaitingInput = true;
            rl.prompt();
          } else if (openQuestion && !closed) {
            // `help`/`status` ran while a sub-prompt was open and the busy-gate
            // had blanked the prompt; put the question back on screen.
            rl.setPrompt(paint.question(openQuestion));
            rl.prompt();
          }
        }
      };

      rl.setPrompt(paint.prompt('ev-charge> '));
      awaitingInput = true;
      rl.prompt();

      rl.on('line', handleCommand);

      rl.on('close', async () => {
        // No more prompts to redraw, and the default console sink is fine once
        // the interface is gone -- calling prompt() on a closed readline would not
        // be. `closed` also stops a handler still unwinding from prompting.
        closed = true;
        setReplReadline(null);
        awaitingInput = false;
        setProxyLogSink(null);
        console.log(paint.info('\nShutting down...'));

        // disconnect() only stops a proxy this process spawned, so quitting a REPL
        // that attached to somebody else's proxy leaves it running on purpose. The
        // state file is cleared only when we own it, so `exit` from another terminal
        // still has a PID to work with.
        const franklin = session.getFranklin();
        if (franklin) {
          if (franklin.spawnedProxyPid) {
            await franklin.disconnect();
            clearRuntimeState();
          } else {
            console.log(paint.info('  Solar battery proxy was reused, not started here; leaving it running.'));
          }
        }
        const tesla = session.getTesla();
        if (tesla) {
          await tesla.disconnect();
        }
        // Same ownership rule as the Franklin proxy: a sidecar this session
        // started stops with it; one it attached to keeps running for others.
        if (spawnedTeslaProxyPid() !== null) {
          await stopTeslaProxy();
          console.log(paint.info('  Tesla command proxy stopped.'));
        }

        console.log(paint.info('Goodbye!'));
        process.exit(0);
      });
    });
}
