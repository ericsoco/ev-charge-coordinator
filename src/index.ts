#!/usr/bin/env node
/**
 * EV Charge Coordinator CLI
 *
 * Coordinate EV charging with home solar battery storage.
 * Supports Tesla vehicles and FranklinWH battery systems.
 *
 * This file is wiring only: argument parsing, the Commander definitions, and the
 * REPL dispatch. Each command's behaviour lives once in src/commands/, because
 * the logic used to exist twice -- here and in the REPL switch -- and the two
 * copies had already drifted.
 */

import { Command } from 'commander';
import axios from 'axios';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { FranklinWHService, ProxyStartupError, setProxyLogSink, TeslaService } from './services/index.js';
import type { ConsentState } from './services/TeslaService.js';
import {
  normalizeDomain,
  VirtualKeyService,
  VirtualKeyStore,
} from './services/tesla/VirtualKeyService.js';
import { resolveRegion } from './services/tesla/endpoints.js';
import { credentialStore } from './utils/credentials.js';

import {
  describeError,
  MAX_EV_CHARGE_LIMIT,
  MIN_EV_CHARGE_LIMIT,
  type CommandContext,
  type CommandResult,
} from './commands/context.js';
import { completeCommand, isReplCommand, LOCAL_WHILE_BUSY, renderHelp } from './commands/repl.js';
import * as paint from './utils/color.js';
import {
  chargeFromBattery,
  getBatterySoc,
  getEvBatterySoc,
  setBatteryBuffer,
  setEvChargeLimit,
  showStatus,
  startEvCharging,
  stopEvCharging,
} from './commands/vehicle.js';

import {
  clearRuntimeState,
  isProcessAlive,
  readRuntimeState,
  terminateProcess,
  writeRuntimeState,
} from './services/ProcessManager.js';

/** Loopback port the Python proxy listens on. Mirrors FranklinWHService's default. */
const DEFAULT_PROXY_PORT = 3001;


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
 * Report a proxy listening on the port with no state file.
 *
 * Deliberately reports rather than kills: without a recorded PID there is no way
 * to know the process is ours, and killing whatever holds the port could take out
 * something unrelated.
 */
function reportOrphanedProxy(): void {
  console.log(
    paint.positive(
      `If a proxy is still listening on port ${DEFAULT_PROXY_PORT}, stop it with:\n` +
        `  lsof -ti tcp:${DEFAULT_PROXY_PORT} | xargs kill`
    )
  );
}

/**
 * Print the stack trace and raw upstream body for a failed service, under --debug.
 *
 * The one-line form deliberately drops detail, so `--debug` is the only way to see
 * what the upstream actually said. In the case that prompted this, the useful
 * detail (a 502 URL from FranklinWH's cloud) was buried several levels down a
 * printed AxiosError while the actionable line above it said only "failed".
 */
function reportDebugDetails(debug: boolean | undefined, cause: unknown): void {
  if (!debug || cause === undefined || cause === null) return;
  const error = cause as Error & { response?: { status?: number; data?: unknown } };
  console.error(paint.debug('  --- debug ---'));
  if (error.stack) {
    console.error(paint.debug(error.stack));
  } else {
    console.error(paint.debug(String(cause)));
  }
  if (error.response?.status !== undefined) {
    console.error(paint.debug(`  HTTP ${error.response.status} body: ${JSON.stringify(error.response.data)}`));
  }
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
 * Outcome of starting a service.
 *
 * These initializers used to return a bare boolean and print any failure as a
 * side effect, which meant the caller had nothing to report: `start` printed an
 * unconditional "✓ Services started successfully" even when one service had failed
 * outright, and told the user to run `exit` when there was nothing to stop. Carrying
 * the error lets the caller state what actually happened per service.
 *
 * `cause` is the original thrown value, kept for `--debug` output. The `error`
 * string is the one-line form and must not contain a stack trace.
 */
export type ServiceStart =
  | { ok: true }
  | { ok: false; error: string; cause?: unknown };

/**
 * Describe a FranklinWH startup failure in one line.
 *
 * The failure arrives from the local Python proxy, which wraps upstream
 * exceptions with its own HTTP status. What matters to the user is whether the
 * problem is theirs -- credentials, gateway id -- or FranklinWH's outage. A 5xx is
 * emphatically the latter, and saying so stops the retry loop of retyping a
 * password that was never wrong.
 *
 * The upstream detail is kept out of the one-line form only in the sense that it
 * is not printed *first*: `--debug` shows the stack and the raw body, which is
 * where the real message was buried last time.
 */
function describeFranklinFailure(error: unknown): ServiceStart {
  const axiosError = error as {
    response?: { status?: number; data?: { error?: unknown; details?: unknown } };
  };
  const status = axiosError?.response?.status;
  const body = axiosError?.response?.data;

  if (typeof status === 'number' && status >= 500) {
    return {
      ok: false,
      error: `HTTP ${status} — FranklinWH's service returned an internal error (not a credentials problem)`,
      cause: error,
    };
  }
  if (typeof status === 'number') {
    const detail =
      typeof body?.error === 'string' ? body.error : describeError(error) || 'request failed';
    return { ok: false, error: `HTTP ${status} — ${detail}`, cause: error };
  }

  return { ok: false, error: describeError(error) || 'authentication failed', cause: error };
}

/** Tesla equivalent: the errors are already mapped to advice by describeTeslaError. */
function describeTeslaFailure(error: unknown): ServiceStart {
  return { ok: false, error: describeError(error) || 'authentication failed', cause: error };
}

const program = new Command();
let franklinService: FranklinWHService | null = null;
let teslaService: TeslaService | null = null;

/**
 * A readline for one-off questions, or -- with a completer -- the REPL prompt.
 *
 * Tab completion comes from readline's `completer` hook (no package needed);
 * arrow-key history is built into node:readline already. Value prompts pass no
 * completer, so a stray Tab cannot splice a command name into an answer.
 */
function createReadline(options: { completer?: (line: string) => [string[], string] } = {}) {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(options.completer ? { completer: options.completer } : {})
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createReadline();
  return new Promise((resolve) => {
    // Category: Question -- every readline question in the CLI funnels here.
    rl.question(paint.question(question), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for a secret with the input masked.
 *
 * The previous implementation was a readline placeholder that echoed whatever was
 * typed, which put passwords and client secrets on screen and into terminal
 * scrollback. inquirer is already a dependency and has native ESM support; it is
 * imported lazily so a non-interactive run (and the test suite, which never
 * reaches a TTY) does not pay to load it.
 *
 * If inquirer cannot be loaded the fallback warns that it is unmasked rather than
 * silently echoing a secret.
 */
async function promptPassword(question: string): Promise<string> {
  try {
    const { default: inquirer } = await import('inquirer');
    const answer = await inquirer.prompt([
      { type: 'password', name: 'secret', message: question },
    ]);
    return String(answer.secret ?? '');
  } catch (error) {
    console.warn(
      paint.warning(
        `Warning: could not mask the prompt (${error instanceof Error ? error.message : error});` +
          '\n  falling back to an UNMASKED prompt.'
      )
    );
    const rl = createReadline();
    return new Promise((resolve) => {
      rl.question(paint.question(question), (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

async function initializeFranklin(): Promise<ServiceStart> {
  if (franklinService?.isAuthenticated()) {
    return { ok: true };
  }

  const stored = await credentialStore.getFranklinCredentials();
  let lastFailure: ServiceStart | null = null;
  
  if (stored) {
    console.log(paint.info('Using stored FranklinWH credentials...'));
    franklinService = new FranklinWHService();
    try {
      await franklinService.initialize({
        username: stored.username,
        password: stored.password,
        gatewayId: stored.gatewayId
      });
      console.log(paint.positive('✓ Connected to FranklinWH'));
      return { ok: true };
    } catch (error) {
      // Deliberately NOT `franklinService = null`. That discarded the only
      // reference to a proxy that initialize() may have just spawned, leaving an
      // orphan listening on the port with no runtime.json recording it -- so
      // `exit` had nothing to stop and a stray Python process survived. Keeping
      // the instance means a later disconnect() can still clean up, and the retry
      // below replaces it anyway.
      await franklinService.disconnect().catch(() => undefined);
      if (error instanceof ProxyStartupError) {
        // The proxy never came up -- a port conflict, missing Python deps --
        // which is not a credentials problem. Retrying the password cannot fix
        // it, so return the failure instead of falling through to the prompt.
        return { ok: false, error: describeError(error), cause: error };
      }
      lastFailure = describeFranklinFailure(error);
    }
  }

  console.log(paint.info('\nFranklinWH authentication required.'));
  // Same as the Tesla path: the stored attempt already failed, so say why before
  // prompting. Without this the only trace of the real cause was buried in a
  // stack trace further up.
  if (lastFailure && !lastFailure.ok) {
    console.log(paint.error(`Stored credentials did not work: ${lastFailure.error}`));
    reportDebugDetails(process.env.ECC_DEBUG === '1', lastFailure.cause);
  }
  const username = await prompt('Email: ');
  const password = await promptPassword('Password: ');
  const gatewayId = await prompt('Gateway ID (found in app under More -> Site Devices): ');

  franklinService = new FranklinWHService();
  try {
    await franklinService.initialize({ username, password, gatewayId });

    const save = await prompt('Save credentials for future use? (y/n): ');
    if (save.trim().toLowerCase() === 'y') {
      await credentialStore.setFranklinCredentials(username, password, gatewayId);
      console.log(paint.positive('✓ Credentials saved securely'));
    }

    console.log(paint.positive('✓ Connected to FranklinWH'));
    return { ok: true };
  } catch (error) {
    // Same reasoning as above: disconnect() only stops a proxy this instance
    // spawned, so this cannot kill somebody else's.
    await franklinService.disconnect().catch(() => undefined);
    franklinService = null;
    // A failure while retrying interactively supersedes the stored-credentials
    // attempt: it is the latest thing the user actually did.
    return describeFranklinFailure(error);
  }
}

async function initializeTesla(): Promise<ServiceStart> {
  if (teslaService?.isAuthenticated()) {
    return { ok: true };
  }

  const stored = await credentialStore.getTeslaCredentials();
  let lastFailure: ServiceStart | null = null;
  
  // A stored refresh token can be used to refresh the session without any
  // interaction, so the only genuinely missing piece may be the client ID/secret.
  // Re-prompting for all four used to be what made a half-populated credential
  // record look like "not signed in" on every single run.
  const storedClientId = stored?.clientId;
  const storedClientSecret = stored?.clientSecret;
  const needsClientCredentials = !storedClientId || !storedClientSecret;

  if (stored?.accessToken && stored?.refreshToken && storedClientId && storedClientSecret) {
    console.log(paint.info('Using stored Tesla credentials...'));
    teslaService = new TeslaService({
      region: stored.region,
      callbackPort: stored.callbackPort
    });
    try {
      await teslaService.initialize({
        clientId: storedClientId,
        clientSecret: storedClientSecret,
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        vin: stored.vin
      });
      
      if (stored.vin) {
        teslaService.setVin(stored.vin);
      }
      
      console.log(paint.positive('✓ Connected to Tesla'));
      return { ok: true };
    } catch (error) {
      lastFailure = describeTeslaFailure(error);
      teslaService = null;
    }
  }

  console.log(paint.info('\nTesla Fleet API authentication required.'));
  // The stored attempt already failed; say why before prompting, so a user with
  // genuinely bad stored credentials is not silently asked for them again.
  if (lastFailure && !lastFailure.ok) {
    console.log(paint.error(`Stored credentials did not work: ${lastFailure.error}`));
    reportDebugDetails(process.env.ECC_DEBUG === '1', lastFailure.cause);
  }
  console.log(paint.info('You need a Tesla Developer account with a registered application.'));
  console.log(paint.positive('Visit https://developer.tesla.com to create one.'));
  if (needsClientCredentials) {
    console.log(paint.info('The stored session is missing its Client ID/secret; enter them to complete it.'));
  }
  console.log(paint.positive('To sign in without any other side effects, run: node dist/index.js authenticate\n'));
  
  // Reuse whatever is already stored, so a record that is only missing the
  // secret (the common case after a key rotation) asks for one thing, not four.
  const clientId = storedClientId ?? (await prompt('Client ID: '));
  const clientSecret = storedClientSecret ?? (await promptPassword('Client Secret: '));

  // Persist the app credentials BEFORE the OAuth round trip, not after it.
  //
  // They are static values from developer.tesla.com: nothing about exchanging a
  // code for tokens can invalidate them, and nothing downstream should be able
  // to lose them. Saving them after authenticate() created a deadlock, because
  // authenticate() ends by resolving a VIN (TeslaService.resolveVin ->
  // listVehicles), which fails with HTTP 412 until this app is registered with
  // Tesla -- and registration needs these very credentials. A user who had not
  // registered yet could therefore never reach the save.
  const save = await prompt('Store these credentials in the keychain? (y/n): ');
  if (save.trim().toLowerCase() === 'y') {
    await credentialStore.setTeslaCredentials({ clientId, clientSecret });
    console.log(paint.positive('✓ Client ID/secret saved'));
  } else {
    // Not stored, but still remembered for this process: pair-tesla-key may be
    // run separately later and would otherwise have nothing to register with.
    console.log(paint.info('  Not saved. Re-run this command later to store them.'));
  }

  teslaService = new TeslaService();
  await teslaService.initialize({ clientId, clientSecret });
  
  console.log(paint.info('\nStarting OAuth authentication...'));
  console.log(paint.info('A browser window should open. If not, copy and paste the URL below.\n'));
  
  try {
    await teslaService.authenticate((authUrl) => {
      console.log(paint.info('Please visit this URL to authorize:\n'));
      console.log(paint.positive(authUrl));
      console.log(paint.info('\nWaiting for authorization...'));
    });

    // Registration (POST /api/1/partner_accounts) is a step separate from OAuth
    // consent. Without it Tesla answers every /api/1 call with HTTP 412, so the
    // token exchange succeeds and the vehicle list does not. Report that as the
    // partial success it is -- tokens are stored and usable -- rather than as a
    // failed login.
    if (teslaService.needsRegistration) {
      console.log(paint.positive('\n✓ Authorized, and the tokens were saved.'));
      console.log(
        paint.info(
          '  Tesla has not yet registered this application, so vehicles cannot be\n' +
            '  listed and no command will work until it is. That is a separate step\n' +
            '  from signing in -- setting an Allowed Origin does not do it either.\n'
        )
      );
      console.log(paint.positive('  Next: node dist/index.js pair-tesla-key --domain <your-domain>'));
      return { ok: true };
    }

    // List vehicles and let user select
    const vehicles = await teslaService.listVehicles();
    if (vehicles.length === 0) {
      console.log(paint.warning('No vehicles found in your Tesla account.'));
      return { ok: false, error: 'No vehicles found in this Tesla account.' };
    }
    
    console.log(paint.info('\nAvailable vehicles:'));
    vehicles.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.displayName} (${v.vin})`);
    });
    
    let selectedVin: string;
    if (vehicles.length === 1) {
      selectedVin = vehicles[0].vin;
      console.log(paint.info(`\nUsing vehicle: ${vehicles[0].displayName}`));
    } else {
      const selection = await prompt('Select vehicle number: ');
      const index = parseInt(selection) - 1;
      if (index < 0 || index >= vehicles.length) {
        console.log(paint.warning('Invalid selection'));
        return { ok: false, error: 'Invalid vehicle selection' };
      }
      selectedVin = vehicles[index].vin;
    }
    
    teslaService.setVin(selectedVin);

    // Persist the selection now rather than gating it behind a prompt: a stale
    // default VIN would later operate on the wrong car. A VIN is not a secret,
    // so storing it needs no consent. The client ID/secret were already saved
    // above, before the OAuth round trip.
    await credentialStore.setTeslaVin(selectedVin);

    console.log(paint.positive('✓ Connected to Tesla'));
    return { ok: true };
  } catch (error) {
    teslaService = null;
    // An interactive failure supersedes any earlier stored-credentials attempt:
    // it is the latest thing the user actually did.
    return describeTeslaFailure(error);
  }
}

// CLI Commands
program
  .name('ev-charge-coordinator')
  .description('Coordinate EV charging with home solar battery storage')
  .version('1.0.0');

program
  .command('start')
  .description('Start the Python API proxy and NodeJS server')
  .option('--daemon', 'Stay resident without the interactive prompt')
  .option('--debug', 'Print full stack traces for service startup failures')
  .action(async (options) => {
    console.log(paint.info('Starting EV Charge Coordinator...\n'));

    // Service status reported per service.
    // Each line states what actually happened for one service.
    const franklin = await initializeFranklin();
    const tesla = await initializeTesla();

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

    if (!franklin.ok && !tesla.ok) {
      console.log(paint.error('\nNo services available. Exiting.'));
      process.exitCode = 1;
      return;
    }

    // Record the proxy so `exit` can stop it from a different process. Only
    // written when this process actually spawned one -- attaching to a proxy that
    // someone else started must not overwrite their recorded PID.
    const spawnedPid = franklinService?.spawnedProxyPid ?? null;
    if (spawnedPid) {
      writeRuntimeState({
        pid: spawnedPid,
        port: DEFAULT_PROXY_PORT,
        startedAt: Date.now(),
        // Raw token, owner-only file; see RuntimeState for why not a hash.
        token: franklinService?.sharedToken ?? undefined,
      });
    }

    if (franklin.ok) {
      const pid = franklinService?.spawnedProxyPid;
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

    const handleCommand = async (input: string): Promise<void> => {
      const cmd = input.trim().toLowerCase();

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
        await dispatchCommand(cmd);
      } finally {
        if (!LOCAL_WHILE_BUSY.has(cmd)) blocker = false;
        // Clamp at zero: a stray extra decrement must not drive the counter
        // negative, which would make `active === 0` unreachable and leave the
        // prompt unrestored for the rest of the session.
        active = Math.max(0, active - 1);
        if (active === 0 && !closed) {
          rl.setPrompt(paint.prompt('ev-charge> '));
          awaitingInput = true;
          rl.prompt();
        }
      }
    };

    const dispatchCommand = async (cmd: string): Promise<void> => {
      
      switch (cmd) {
        case 'help':
          console.log(renderHelp());
          break;
          
        case 'authenticate':
          // Same helper the standalone command uses, so the REPL and
          // `ev-charge-coordinator authenticate` cannot drift apart.
          await runAuthenticate();
          break;

        case 'status':
          await showStatus(currentContext());
          break;

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

        case 'set-ev-charge-limit': {
          const limitStr = await prompt('Enter charge limit (50-100%): ');
          const limit = parseInt(limitStr);
          if (isNaN(limit)) {
            console.log(paint.warning('Invalid charge limit. Must be a number between 50 and 100.'));
            break;
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

        case 'charge-from-battery':
          // offerToStart is true here: the interactive path asks whether to
          // begin charging once the limit is set. The one-shot command does not.
          await chargeFromBattery(currentContext(), { offerToStart: true });
          break;

        case 'set-battery-buffer': {
          const bufferStr = await prompt('Enter battery buffer percentage (0-100): ');
          const buffer = parseInt(bufferStr);
          if (isNaN(buffer)) {
            console.log(paint.warning('Invalid buffer. Must be a number between 0 and 100.'));
            break;
          }
          await setBatteryBuffer(currentContext(), buffer);
          break;
        }
          
        case 'exit':
        case 'quit':
          closed = true;
          rl.close();
          return;
          
        case '':
          break;
          
        default:
          console.log(paint.warning(`Unknown command: ${cmd}. Type "help" for available commands.`));
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
      awaitingInput = false;
      setProxyLogSink(null);
      console.log(paint.info('\nShutting down...'));

      // disconnect() only stops a proxy this process spawned, so quitting a REPL
      // that attached to somebody else's proxy leaves it running on purpose. The
      // state file is cleared only when we own it, so `exit` from another terminal
      // still has a PID to work with.
      if (franklinService) {
        if (franklinService.spawnedProxyPid) {
          await franklinService.disconnect();
          clearRuntimeState();
        } else {
          console.log(paint.info('  Solar battery proxy was reused, not started here; leaving it running.'));
        }
      }
      if (teslaService) {
        await teslaService.disconnect();
      }

      console.log(paint.info('Goodbye!'));
      process.exit(0);
    });
  });

program
  .command('exit')
  .description('Terminate the Python API proxy and NodeJS server')
  .action(async () => {
    console.log(paint.info('Shutting down services...\n'));

    // Stop in-process services first, when this process has any. A fresh process
    // has none, which is exactly the case this command used to silently no-op on
    // while reporting success.
    if (teslaService) {
      await teslaService.disconnect();
    }

    const state = readRuntimeState();
    if (!state) {
      console.log(paint.info('No runtime state file; no proxy was started by `start`.'));
      reportOrphanedProxy();
      console.log(paint.positive('\n✓ Nothing to stop'));
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log(paint.info(`Recorded proxy (pid ${state.pid}) is no longer running; clearing stale state.`));
      clearRuntimeState();
      console.log(paint.positive('\n✓ Nothing to stop'));
      return;
    }

    console.log(paint.info(`Stopping proxy on port ${state.port} (pid ${state.pid})...`));

    // Ask the proxy to shut down first so it can close cleanly: it replies,
    // then SIGTERMs itself into a normal interpreter exit (no os._exit). The
    // response can still lose that race, so terminateProcess below remains
    // the real guarantee that the process ends.
    try {
      await axios.post(`http://127.0.0.1:${state.port}/shutdown`, undefined, {
        timeout: 5000,
        // A state file from before Phase 3 carries no token; the proxy then
        // 401s and the SIGTERM path performs the same clean shutdown anyway.
        ...(state.token ? { headers: { 'X-Proxy-Token': state.token } } : {}),
      });
    } catch {
      // A lost response is a race, not a failure; the escalation below is the
      // guarantee that the process ends.
    }

    const outcome = await terminateProcess(state.pid);
    clearRuntimeState();

    const verb =
      outcome === 'exited' ? 'stopped cleanly' :
      outcome === 'killed' ? 'stopped (SIGKILL required)' :
      'already gone';
    console.log(paint.positive(`✓ Proxy ${verb}`));
    console.log(paint.positive('\n✓ Services stopped'));
  });

/**
 * Build a CommandContext from the module-level services.
 *
 * The services stay module-level because the REPL owns their lifecycle, but the
 * handlers only ever see this object, so they are testable without them.
 */
function currentContext(): CommandContext {
  return { franklin: franklinService, tesla: teslaService, store: credentialStore, ask: prompt };
}

/**
 * Run a handler and set the process exit code on failure.
 *
 * Every one-shot command funnels through here so failures always exit non-zero.
 * The REPL calls the handlers directly instead, because a failed command there
 * must not kill an interactive session.
 */
async function runCommand(
  run: (ctx: CommandContext) => Promise<CommandResult>
): Promise<void> {
  const result = await run(currentContext());
  if (!result.ok) {
    process.exitCode = 1;
  }
}

/**
 * One-shot commands: report a failed initialization and stop.
 *
 * The old guards negated the awaited initializer result directly, which can
 * never fire: both initializers return a ServiceStart *object*, and every
 * object is truthy -- so the check beneath them was dead code. Failures fell
 * through into the command handler instead, and on one path into
 * `franklinService!.disconnect()` with a null service.
 */
function requireService(name: 'Tesla' | 'FranklinWH', init: ServiceStart): void {
  if (init.ok) return;
  console.log(paint.error(`✗ ${name} service not started. Error: ${init.error}`));
  process.exit(1);
}

program
  .command('get-ev-bsoc')
  .description('Get the current battery state of charge from the EV')
  .action(async () => {
    requireService('Tesla', await initializeTesla());
    await runCommand(getEvBatterySoc);
  });

program
  .command('get-battery-soc')
  .description('Get the current battery state of charge from the solar battery')
  .action(async () => {
    requireService('FranklinWH', await initializeFranklin());
    try {
      await runCommand(getBatterySoc);
    } finally {
      // Phase 2 fixes the teardown bug: this stops a proxy this command started,
      // but today it also stops one an earlier `start` owns.
      await franklinService!.disconnect();
    }
  });

program
  .command('set-ev-charge-limit')
  .description('Set the EV charge limit')
  .argument('<percent>', 'Charge limit percentage (50-100)')
  .action(async (percent: string) => {
    const limit = parseInt(percent);
    if (isNaN(limit) || limit < MIN_EV_CHARGE_LIMIT || limit > MAX_EV_CHARGE_LIMIT) {
      console.error(paint.warning(`Charge limit must be between ${MIN_EV_CHARGE_LIMIT} and ${MAX_EV_CHARGE_LIMIT}`));
      process.exit(1);
    }

    requireService('Tesla', await initializeTesla());
    await runCommand((ctx) => setEvChargeLimit(ctx, limit));
  });

program
  .command('start-ev-charging')
  .description('Start charging the EV')
  .action(async () => {
    requireService('Tesla', await initializeTesla());
    await runCommand(startEvCharging);
  });

program
  .command('stop-ev-charging')
  .description('Stop charging the EV')
  .action(async () => {
    requireService('Tesla', await initializeTesla());
    await runCommand(stopEvCharging);
  });

program
  .command('charge-from-battery')
  .description('Set EV charge limit based on solar battery SoC minus buffer')
  .action(async () => {
    // Short-circuit preserved: Franklin's failure exits before Tesla is asked
    // for anything, which is also what `||` did here.
    requireService('FranklinWH', await initializeFranklin());
    requireService('Tesla', await initializeTesla());
    
    try {
      // offerToStart is false here, preserving the one-shot behaviour: it sets
      // the limit and stops. The REPL passes true. That difference is now
      // explicit rather than an accident of which copy you happen to read.
      await runCommand((ctx) => chargeFromBattery(ctx, { offerToStart: false }));
    } catch (error) {
      console.error(paint.error(`Error: ${error instanceof Error ? error.message : error}`));
      process.exit(1);
    } finally {
      await franklinService!.disconnect();
    }
  });

program
  .command('set-battery-buffer')
  .description('Set the amount of charge to keep in the solar battery')
  .argument('<percent>', 'Buffer percentage (0-100)')
  .action(async (percent: string) => {
    const buffer = parseInt(percent);
    if (isNaN(buffer) || buffer < 0 || buffer > 100) {
      console.error(paint.warning('Buffer must be between 0 and 100'));
      process.exit(1);
    }

    await runCommand((ctx) => setBatteryBuffer(ctx, buffer));
  });

/**
 * Sign in to Tesla and store the credentials.
 *
 * Deliberately does no other work: it makes no /api/1 call, resolves no VIN, and
 * touches no battery state. That matters because the obvious way to sign in was
 * to run a command like get-ev-bsoc, which (a) does not describe what it is
 * doing and (b) fails with HTTP 412 before the app is registered with Tesla --
 * so it could not be used to fix a not-yet-registered app. Login is a distinct
 * step from every data command, and this is it.
 */
async function runAuthenticate(
  options: { clientId?: string; clientSecret?: string; force?: boolean } = {}
): Promise<boolean> {
  const existing = await credentialStore.getTeslaCredentials();

  // Without --force, an intact session is left alone rather than sending the user
  // through consent again for no reason.
  const hasSession =
    Boolean(existing?.accessToken) &&
    Boolean(existing?.refreshToken) &&
    Boolean(existing?.clientId) &&
    Boolean(existing?.clientSecret);
  if (hasSession && !options.force) {
    const expiresAt = existing?.expiresAt ?? 0;
    console.log(paint.info('Already signed in to Tesla.'));
    console.log(
      paint.info(
        expiresAt > Date.now()
          ? `  Stored tokens valid until ${new Date(expiresAt).toISOString()}.`
          : '  Stored tokens have expired; the CLI will refresh them on next use.'
      )
    );
    console.log(paint.positive('  Re-authorize anyway with: node dist/index.js authenticate --force'));
    return true;
  }

  // Reuse stored app credentials unless overridden, so a re-auth does not force
  // the user to re-paste the secret they already saved.
  const clientId = options.clientId ?? existing?.clientId ?? (await prompt('Client ID: '));
  const clientSecret =
    options.clientSecret ?? existing?.clientSecret ?? (await promptPassword('Client Secret: '));

  if (!clientId.trim() || !clientSecret.trim()) {
    console.error(paint.warning('A Client ID and Client Secret are both required.'));
    return false;
  }

  console.log(paint.info('\nStarting OAuth authentication...'));
  console.log(paint.info('A browser window should open. If not, copy and paste the URL below.\n'));

  const service = new TeslaService({ region: existing?.region });
  try {
    await service.initialize({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    await service.authenticate((authUrl) => {
      console.log(paint.info('Please visit this URL to authorize:\n'));
      console.log(paint.positive(authUrl));
      console.log(paint.info('\nWaiting for authorization...'));
    });

    // Store the app credentials only after a successful exchange. authenticate()
    // already saved the tokens; this adds the client ID/secret alongside them.
    await credentialStore.setTeslaCredentials({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      region: service.region as 'na' | 'eu' | 'cn',
    });
    console.log(paint.positive('✓ Signed in, and the credentials were stored securely'));

    // authenticate() resolves a VIN, which is a /api/1 call. If the app is not
    // registered that is expected, and it is not a reason to call login a
    // failure -- registration is a separate step this command deliberately does
    // not perform.
    if (service.needsRegistration) {
      console.log(
        paint.positive(
          '  Tesla has not registered this application yet, so vehicles cannot be listed.\n' +
            '  Register it with: node dist/index.js pair-tesla-key --domain <your-domain>'
        )
      );
    }
    return true;
  } catch (error) {
    console.error(paint.error(`Authentication failed: ${error instanceof Error ? error.message : error}`));
    return false;
  }
}

program
  .command('authenticate')
  .description('Sign in to Tesla and store the credentials (no other side effects)')
  .option('--client-id <id>', 'Client ID from developer.tesla.com (default: the stored one)')
  .option('--client-secret <secret>', 'Client Secret (default: the stored one)')
  .option('--force', 'Re-authorize even if credentials are already stored')
  .action(async (options) => {
    if (!(await runAuthenticate(options))) {
      process.exitCode = 1;
    }
  });

program
  .command('config')
  .description('Show or update configuration')
  .option('--clear-franklin', 'Clear FranklinWH credentials')
  .option('--clear-tesla', 'Clear Tesla credentials')
  .option('--clear-all', 'Clear all stored credentials')
  .option('--tesla-region <region>', 'Set the Tesla Fleet API deployment (na | eu | cn)')
  .option('--tesla-domain <domain>', 'Set the domain that hosts the virtual key public key')
  .option('--show-public-key', 'Print the virtual key public key that Tesla reads')
  .action(async (options) => {
    if (options.showPublicKey) {
      const service = new VirtualKeyService({ apiBaseUrl: resolveRegion().apiBaseUrl });
      console.log(await service.getPublicKeyPem());
      return;
    }
    if (options.teslaDomain) {
      // Validated the same way pair-tesla-key validates it, so a bad domain is
      // rejected here rather than after the key has been published to it.
      try {
        const domain = normalizeDomain(options.teslaDomain);
        await credentialStore.setTeslaCredentials({ domain });
        console.log(paint.positive(`✓ Tesla key domain set to ${domain}`));
        console.log(paint.info('  Run pair-tesla-key to register it with Tesla.'));
      } catch (error) {
        console.error(paint.error(describeError(error)));
        process.exitCode = 1;
      }
    } else if (options.teslaRegion) {
      // Validated through resolveRegion so a typo fails here instead of surfacing
      // later as an HTTP 421 "incorrect region" from Tesla.
      try {
        const { region, coverage } = resolveRegion(options.teslaRegion);
        await credentialStore.setTeslaCredentials({ region });
        console.log(paint.positive(`✓ Tesla region set to ${region} (${coverage})`));
        console.log(paint.info('  Re-run the pairing step if this moves you to a different deployment.'));
      } catch (error) {
        console.error(paint.error(describeError(error)));
        process.exitCode = 1;
      }
    } else if (options.clearFranklin) {
      await credentialStore.clearFranklinCredentials();
      console.log(paint.positive('✓ FranklinWH credentials cleared'));
    } else if (options.clearTesla) {
      await credentialStore.clearTeslaCredentials();
      console.log(paint.positive('✓ Tesla credentials cleared'));
    } else if (options.clearAll) {
      await credentialStore.clearAll();
      console.log(paint.positive('✓ All credentials cleared'));
    } else {
      // Show current config
      const franklin = await credentialStore.getFranklinCredentials();
      const tesla = await credentialStore.getTeslaCredentials();
      const buffer = await credentialStore.getBatteryBuffer();
      
      console.log(paint.info('\n--- Configuration ---'));
      console.log(`FranklinWH: ${franklin ? `Configured (Gateway: ${franklin.gatewayId})` : 'Not configured'}`);
      console.log(`Tesla: ${tesla ? `Configured${tesla.vin ? ` (VIN: ${tesla.vin})` : ''}${tesla.region ? ` Region: ${tesla.region}` : ''}${tesla.domain ? ` Key domain: ${tesla.domain}` : ''}` : 'Not configured'}`);
      console.log(`Battery Buffer: ${buffer}%`);
      console.log('');
    }
  });

program
  .command('pair-tesla-key')
  .description("Register this application's virtual key with Tesla and print the vehicle pairing link")
  .option('--domain <domain>', 'Domain that hosts the public key (defaults to the stored value)')
  .option('--vin <vin>', 'Vehicle to pair (defaults to the stored VIN)')
  .option('--check-only', 'Only report the current key/registration state; change nothing')
  .option('--skip-registration', 'Do not call Tesla; only verify the hosted key and print the link')
  .action(async (options) => {
    const stored = await credentialStore.getTeslaCredentials();
    const regionInfo = resolveRegion(stored?.region);

    // A plain axios instance, separate from TeslaService's: the hosted-key probe
    // deliberately fetches a third-party URL and must not carry a Tesla bearer
    // token, and TeslaService's client attaches one to every request.
    const virtualKeys = new VirtualKeyService({
      apiBaseUrl: regionInfo.apiBaseUrl,
      http: axios.create({ timeout: 30000 }),
    });

    const domainInput = options.domain ?? stored?.domain;
    if (!domainInput) {
      console.error(
        paint.error(
          'No domain configured. Pass --domain <domain> or save one with:\n' +
            '  node dist/index.js config --tesla-domain <domain>'
        )
      );
      process.exitCode = 1;
      return;
    }

    let domain: string;
    try {
      // Validated up front so a typo fails before any key material is touched.
      domain = normalizeDomain(domainInput);
    } catch (error) {
      console.error(paint.error(describeError(error)));
      process.exitCode = 1;
      return;
    }

    const vin = options.vin ?? stored?.vin;

    if (options.checkOnly) {
      await reportKeyState(virtualKeys, domain, { verifyWithTesla: true, credentials: stored });
      return;
    }

    // Step 1: the key must exist locally before anything is published or sent.
    const instructions = await virtualKeys.getHostingInstructions(domain);
    console.log(paint.info('\n--- Step 1 of 3: host the public key ---'));
    console.log(paint.info(`\nKey pair: ${virtualKeys.privateKeyPath} (keep this file; it signs every command)`));
    console.log(paint.info(`Public key: ${virtualKeys.publicKeyPath}`));
    console.log(paint.positive(`\nServe this file at exactly:\n  ${instructions.url}`));
    console.log(paint.info('\nIt must be the PEM itself, over HTTPS, with no redirect and no HTML page in front.'));
    if (process.stdin.isTTY) {
      console.log(`\nPublic key contents:\n${instructions.publicKeyPem.trim()}`);
    }

    // Step 2: check what Tesla would actually fetch. Registering is not a consumable
    // -- POST /api/1/partner_accounts can be called repeatedly -- but if Tesla
    // ends up holding a key whose private half is not on this machine, the
    // pairing appears to succeed and every later command is rejected, so it is
    // much cheaper to notice a bad URL here.
    console.log(paint.info('\n--- Step 2 of 3: verify the published key ---'));
    const hosted = await virtualKeys.checkHostedPublicKey(domain);
    if (!hosted.matchesLocalKey) {
      console.error(paint.error(`\n✗ ${hosted.error ?? 'The published key could not be verified.'}`));
      // The preview earns its own line only when the server actually answered
      // with a body; on a transport failure it just repeats the reason above.
      if (hosted.bodyPreview && hosted.reachable === false && hosted.status !== undefined) {
        console.error(paint.error(`  Got instead: ${hosted.bodyPreview}`));
      }
      if (hosted.status !== undefined) {
        console.error(paint.error(`  HTTP status: ${hosted.status}`));
      }
      console.error(paint.info('\nFix the hosting above and re-run. Nothing has been sent to Tesla yet.'));
      process.exitCode = 1;
      return;
    }
    console.log(paint.positive(`✓ ${hosted.url} serves the matching public key`));

    if (options.skipRegistration) {
      console.log(paint.info('\nSkipping Tesla registration (--skip-registration).'));
      await printPairingLinkIfReady(virtualKeys, domain, vin);
      return;
    }

    await registerDomainWithTesla(virtualKeys, domain, stored);
    await printPairingLinkIfReady(virtualKeys, domain, vin);
  });

/**
 * Step 3: register the domain with Tesla and confirm it stored our key.
 *
 * Returns whether registration succeeded, so the caller can decide whether the
 * pairing link is still worth printing.
 */
async function registerDomainWithTesla(
  virtualKeys: VirtualKeyService,
  domain: string,
  stored: { clientId?: string; clientSecret?: string } | undefined
): Promise<boolean> {
  console.log(paint.info('\n--- Step 3 of 3: register the domain with Tesla ---'));

  // Registration needs a *partner* token, minted from the application's own
  // client_id/secret (the client_credentials grant), not the user's third-party
  // token. These are static values from developer.tesla.com.
  //
  // Prompting for them here rather than demanding a prior login is what breaks
  // the deadlock: registration cannot happen until the app is registered, so a
  // user who has never registered cannot have been able to store these yet.
  let clientId = stored?.clientId;
  let clientSecret = stored?.clientSecret;
  if (!clientId || !clientSecret) {
    console.log(
      paint.info(
        'This step authenticates the application itself (a "partner" token), which\n' +
          'needs the Client ID and Secret from developer.tesla.com > your app.'
      )
    );
    if (!process.stdin.isTTY) {
      console.error(
        paint.error(
          '\nCannot prompt for credentials when stdin is not a terminal. Either run this\n' +
            'command interactively, or store the credentials first with a Tesla command.'
        )
      );
      process.exitCode = 1;
      return false;
    }
    clientId = (await prompt('Client ID: ')).trim();
    clientSecret = await promptPassword('Client Secret: ');
    if (!clientId || !clientSecret) {
      console.error(paint.error('Client ID and Secret are both required to register.'));
      process.exitCode = 1;
      return false;
    }
    const save = await prompt('Store them for next time? (y/n): ');
    if (save.trim().toLowerCase() === 'y') {
      await credentialStore.setTeslaCredentials({ clientId, clientSecret });
      console.log(paint.positive('✓ Client ID/secret saved'));
    }
  }

  try {
    const partnerToken = await virtualKeys.fetchPartnerToken(clientId, clientSecret);
    await virtualKeys.registerKey(partnerToken.accessToken, domain);
    console.log(paint.positive(`✓ Registered ${domain}`));

    const verification = await virtualKeys.verifyRegistration(partnerToken.accessToken, domain);
    if (!verification.registered) {
      console.error(paint.error('✗ Tesla did not return a registered key for this domain.'));
      console.error(paint.info('  It may take a moment to propagate; re-run --check-only in a minute.'));
      process.exitCode = 1;
      return false;
    }
    if (!verification.matchesLocalKey) {
      // The dangerous case: Tesla holds a key whose private half is not on this
      // machine. Pairing here would appear to succeed and then fail every command.
      console.error(
        paint.error(
          `✗ Tesla holds a different public key for ${domain} than the one on this machine.\n` +
            '  Commands signed locally would be rejected. Check which domain you registered,\n' +
            '  and re-publish the public key at the path shown above.'
        )
      );
      process.exitCode = 1;
      return false;
    }
    console.log(paint.positive('✓ Tesla holds the matching public key'));

    // Remember the domain so later runs do not need --domain.
    const current = await credentialStore.getTeslaCredentials();
    if (current?.domain !== domain) {
      await credentialStore.setTeslaCredentials({ domain });
      console.log(paint.positive('✓ Domain saved to configuration'));
    }
    return true;
  } catch (error) {
    console.error(paint.error(`Registration failed: ${error instanceof Error ? error.message : error}`));
    process.exitCode = 1;
    return false;
  }
}

/**
 * Whether the user has authorized this app for their Tesla account.
 *
 * Pairing via tesla.com/_ak/ fails with "you have not granted <domain> access to
 * your account" unless consent is already in place, and that is only discoverable
 * by tapping through to the error in the Tesla app. Checked here so the failure is
 * reported before the link is printed.
 *
 * Returns null when consent cannot be determined (e.g. offline), so a network
 * problem never blocks a pairing the user could otherwise complete.
 */
async function checkUserConsent(): Promise<ConsentState | null> {
  const stored = await credentialStore.getTeslaCredentials();
  if (!stored?.accessToken || !stored?.refreshToken) {
    return {
      granted: false,
      reason: 'not-signed-in',
      detail: 'No stored Tesla tokens; the user has never authorized this app.',
    };
  }
  const service = new TeslaService({ region: stored.region });
  await service.initialize({
    clientId: stored.clientId ?? '',
    clientSecret: stored.clientSecret ?? '',
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    expiresAt: stored.expiresAt,
    vin: stored.vin,
  });
  const state = await service.checkConsent();
  // Not-signed-in and not-authorized are actionable; anything else (offline,
  // 412 before registration) is not a reason to withhold the pairing link.
  return state.reason === 'unknown' ? null : state;
}

/**
 * Print the pairing link, but only after consent is confirmed.
 *
 * Tesla's Virtual Key developer guide requires the user to have authorized the
 * application before the _ak/ flow will add a key, and the failure appears
 * several taps deep in the mobile app.
 */
async function printPairingLinkIfReady(
  virtualKeys: VirtualKeyService,
  domain: string,
  vin?: string
): Promise<void> {
  console.log(paint.info('\n--- Pair the vehicle ---'));

  const consent = await checkUserConsent();
  if (consent && !consent.granted) {
    console.error(paint.error(`\n✗ ${consent.detail}`));
    if (consent.reason === 'not-signed-in' || consent.reason === 'not-authorized') {
      console.error(
        paint.positive(
          '\nThe pairing link only works after you authorize this app. Sign in first:\n' +
            '  node dist/index.js authenticate\n' +
            '  (approve in the browser, then re-run pair-tesla-key)'
        )
      );
    } else {
      console.error(
        paint.info(
          '  Finish the previous step, then re-run this command.'
        )
      );
    }
    process.exitCode = 1;
    return;
  }
  if (consent) {
    console.log(paint.positive('✓ This app has been granted access to your Tesla account.'));
  }

  console.log(paint.info('\nOpen this link on a device signed in to the Tesla app that owns the car:'));
  console.log(paint.positive(`\n  ${virtualKeys.buildPairingUrl(domain, vin)}\n`));
  console.log(paint.info('Approve the key in the app when it prompts. Pairing is a manual,'));
  console.log(paint.info('in-the-car step: Tesla documents no API that reports per-vehicle key'));
  console.log(paint.info('pairing, so this cannot be verified from the command line.'));
  console.log(
    paint.info(
      'To confirm afterwards, run a command (for example `get-ev-bsoc`); a vehicle that\n' +
        'rejects the key answers "your public key has not been paired with the vehicle".'
    )
  );
}

/** Report key/registration state without mutating anything (--check-only). */
async function reportKeyState(
  virtualKeys: VirtualKeyService,
  domain: string,
  options: { verifyWithTesla: boolean; credentials?: { clientId?: string; clientSecret?: string } }
): Promise<void> {
  console.log(paint.info(`\n--- Virtual key state for ${domain} ---`));

  // Read through the service rather than stat()ing the path directly, so the
  // same code path that would create a key is the one being reported on.
  const stored = await new VirtualKeyStore().load();
  console.log(
    paint.info(
      stored
        ? `Local key pair: ${virtualKeys.privateKeyPath}`
        : 'Local key pair: not created yet (run pair-tesla-key to generate one)'
    )
  );

  const hosted = await virtualKeys.checkHostedPublicKey(domain);
  if (hosted.matchesLocalKey) {
    console.log(paint.positive(`Hosted key: OK ${hosted.url} serves the matching public key`));
  } else {
    console.log(paint.error(`Hosted key: PROBLEM ${hosted.error ?? 'could not be verified'}`));
    if (hosted.status !== undefined) console.log(paint.error(`  HTTP status: ${hosted.status}`));
    if (hosted.bodyPreview && hosted.reachable === false && hosted.status !== undefined) {
      console.log(paint.error(`  Got instead: ${hosted.bodyPreview}`));
    }
  }

  if (!options.verifyWithTesla) return;
  if (!options.credentials?.clientId || !options.credentials?.clientSecret) {
    console.log(paint.info('Tesla registration: skipped (no stored client ID/secret)'));
  } else {
    try {
      const token = await virtualKeys.fetchPartnerToken(
        options.credentials.clientId,
        options.credentials.clientSecret
      );
      const result = await virtualKeys.verifyRegistration(token.accessToken, domain);
      if (!result.registered) {
        console.log(paint.warning('Tesla registration: no key registered for this domain'));
      } else if (result.matchesLocalKey) {
        console.log(paint.positive('Tesla registration: OK Tesla holds the matching public key'));
      } else {
        console.log(paint.error('Tesla registration: PROBLEM Tesla holds a DIFFERENT public key for this domain'));
      }
    } catch (error) {
      console.log(
        paint.warning(
          `Tesla registration: could not be checked (${error instanceof Error ? error.message : error})`
        )
      );
    }
  }

  // Consent is the third and last gate before pairing, and the only one the
  // user cannot check by looking at a file. Report it here so one command
  // answers "what is still outstanding" rather than requiring three.
  const consent = await checkUserConsent();
  if (consent === null) {
    console.log(paint.info('Account access: unknown (could not reach Tesla)'));
  } else if (consent.granted) {
    console.log(paint.positive('Account access: OK the user has granted this app access to their account'));
  } else if (consent.reason === 'not-signed-in') {
    console.log(paint.warning('Account access: MISSING never authorized (run `authenticate` and approve)'));
  } else if (consent.reason === 'not-authorized') {
    console.log(paint.warning('Account access: MISSING token rejected; re-authorize (run `authenticate --force`)'));
  } else {
    console.log(paint.warning(`Account access: not confirmed (${consent.reason}) - ${consent.detail}`));
  }

}

program.parse();
