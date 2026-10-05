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
import { FranklinWHService, TeslaService } from './services/index.js';
import type { ConsentState } from './services/TeslaService.js';
import {
  normalizeDomain,
  VirtualKeyService,
  VirtualKeyStore,
} from './services/tesla/VirtualKeyService.js';
import { resolveRegion } from './services/tesla/endpoints.js';
import { credentialStore } from './utils/credentials.js';

import {
  MAX_EV_CHARGE_LIMIT,
  MIN_EV_CHARGE_LIMIT,
  type CommandContext,
  type CommandResult,
} from './commands/context.js';
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
 * Print the PID and port actually in use, so `start` tells the user something they
 * can act on rather than a bare "started successfully".
 */
function reportResolvedProcesses(
  franklin: FranklinWHService | null,
  tesla: TeslaService | null
): void {
  if (franklin?.isAuthenticated()) {
    const pid = franklin.spawnedProxyPid;
    if (pid) {
      console.log(`  Solar battery proxy: pid ${pid}, port ${DEFAULT_PROXY_PORT} (started here)`);
    } else {
      console.log(
        `  Solar battery proxy: port ${DEFAULT_PROXY_PORT} (already running, reused)`
      );
    }
  } else {
    console.log('  Solar battery proxy: not running');
  }
  console.log(`  EV: ${tesla?.isAuthenticated() ? '✓ authenticated' : '✗ not authenticated'}`);
}

/**
 * Stay alive without a prompt, for `start --daemon`.
 *
 * The promise only settles on a shutdown signal, so the process keeps its child
 * proxy and the recorded runtime state valid until `exit` stops them.
 */
function keepResident(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      console.log(`\nReceived ${signal}; exiting. The proxy is left running.`);
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
    `If a proxy is still listening on port ${DEFAULT_PROXY_PORT}, stop it with:\n` +
      `  lsof -ti tcp:${DEFAULT_PROXY_PORT} | xargs kill`
  );
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
    `\nWarning: something is listening on port ${DEFAULT_PROXY_PORT} but no runtime\n` +
      `  state records it, so \`exit\` will not stop it. If it is an orphaned proxy:\n` +
      `    lsof -ti tcp:${DEFAULT_PROXY_PORT} | xargs kill`
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

const program = new Command();
let franklinService: FranklinWHService | null = null;
let teslaService: TeslaService | null = null;

function createReadline() {
  return createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createReadline();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * The intent of having promptPassword separate from prompt is be able to
 * hide the password input in the terminal. LLM provided a borked implementation,
 * so this is a placeholder for now.
 * 
 * TODO: try a lib like 'readline-sync' or 'inquirer' to handle hidden input properly.
 */
async function promptPassword(question: string): Promise<string> {
  const rl = createReadline();

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function initializeFranklin(): Promise<boolean> {
  if (franklinService?.isAuthenticated()) {
    return true;
  }

  const stored = await credentialStore.getFranklinCredentials();
  
  if (stored) {
    console.log('Using stored FranklinWH credentials...');
    franklinService = new FranklinWHService();
    try {
      await franklinService.initialize({
        username: stored.username,
        password: stored.password,
        gatewayId: stored.gatewayId
      });
      console.log('✓ Connected to FranklinWH');
      return true;
    } catch (error) {
      console.error('Failed to connect with stored credentials:', error);
      // Deliberately NOT `franklinService = null`. That discarded the only
      // reference to a proxy that initialize() may have just spawned, leaving an
      // orphan listening on the port with no runtime.json recording it -- so
      // `exit` had nothing to stop and a stray Python process survived. Keeping
      // the instance means a later disconnect() can still clean up, and the retry
      // below replaces it anyway.
      await franklinService.disconnect().catch(() => undefined);
    }
  }

  console.log('\nFranklinWH authentication required.');
  const username = await prompt('Email: ');
  const password = await promptPassword('Password: ');
  const gatewayId = await prompt('Gateway ID (found in app under More -> Site Devices): ');

  franklinService = new FranklinWHService();
  try {
    await franklinService.initialize({ username, password, gatewayId });

    const save = await prompt('Save credentials for future use? (y/n): ');
    if (save.trim().toLowerCase() === 'y') {
      await credentialStore.setFranklinCredentials(username, password, gatewayId);
      console.log('✓ Credentials saved securely');
    }

    console.log('✓ Connected to FranklinWH');
    return true;
  } catch (error) {
    console.error('Authentication failed:', error);
    // Same reasoning as above: disconnect() only stops a proxy this instance
    // spawned, so this cannot kill somebody else's.
    await franklinService.disconnect().catch(() => undefined);
    franklinService = null;
    return false;
  }
}

async function initializeTesla(): Promise<boolean> {
  if (teslaService?.isAuthenticated()) {
    return true;
  }

  const stored = await credentialStore.getTeslaCredentials();
  
  // A stored refresh token can be used to refresh the session without any
  // interaction, so the only genuinely missing piece may be the client ID/secret.
  // Re-prompting for all four used to be what made a half-populated credential
  // record look like "not signed in" on every single run.
  const storedClientId = stored?.clientId;
  const storedClientSecret = stored?.clientSecret;
  const needsClientCredentials = !storedClientId || !storedClientSecret;

  if (stored?.accessToken && stored?.refreshToken && storedClientId && storedClientSecret) {
    console.log('Using stored Tesla credentials...');
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
      
      console.log('✓ Connected to Tesla');
      return true;
    } catch (error) {
      console.error('Failed to connect with stored credentials:', error);
      teslaService = null;
    }
  }

  console.log('\nTesla Fleet API authentication required.');
  console.log('You need a Tesla Developer account with a registered application.');
  console.log('Visit https://developer.tesla.com to create one.');
  if (needsClientCredentials) {
    console.log('The stored session is missing its Client ID/secret; enter them to complete it.');
  }
  console.log('To sign in without any other side effects, run: node dist/index.js authenticate\n');
  
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
    console.log('✓ Client ID/secret saved');
  } else {
    // Not stored, but still remembered for this process: pair-tesla-key may be
    // run separately later and would otherwise have nothing to register with.
    console.log('  Not saved. Re-run this command later to store them.');
  }

  teslaService = new TeslaService();
  await teslaService.initialize({ clientId, clientSecret });
  
  console.log('\nStarting OAuth authentication...');
  console.log('A browser window should open. If not, copy and paste the URL below.\n');
  
  try {
    await teslaService.authenticate((authUrl) => {
      console.log('Please visit this URL to authorize:\n');
      console.log(authUrl);
      console.log('\nWaiting for authorization...');
    });

    // Registration (POST /api/1/partner_accounts) is a step separate from OAuth
    // consent. Without it Tesla answers every /api/1 call with HTTP 412, so the
    // token exchange succeeds and the vehicle list does not. Report that as the
    // partial success it is -- tokens are stored and usable -- rather than as a
    // failed login.
    if (teslaService.needsRegistration) {
      console.log('\n✓ Authorized, and the tokens were saved.');
      console.log(
        '  Tesla has not yet registered this application, so vehicles cannot be\n' +
          '  listed and no command will work until it is. That is a separate step\n' +
          '  from signing in -- setting an Allowed Origin does not do it either.\n'
      );
      console.log('  Next: node dist/index.js pair-tesla-key --domain <your-domain>');
      return true;
    }

    // List vehicles and let user select
    const vehicles = await teslaService.listVehicles();
    if (vehicles.length === 0) {
      console.log('No vehicles found in your Tesla account.');
      return false;
    }
    
    console.log('\nAvailable vehicles:');
    vehicles.forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.displayName} (${v.vin})`);
    });
    
    let selectedVin: string;
    if (vehicles.length === 1) {
      selectedVin = vehicles[0].vin;
      console.log(`\nUsing vehicle: ${vehicles[0].displayName}`);
    } else {
      const selection = await prompt('Select vehicle number: ');
      const index = parseInt(selection) - 1;
      if (index < 0 || index >= vehicles.length) {
        console.log('Invalid selection');
        return false;
      }
      selectedVin = vehicles[index].vin;
    }
    
    teslaService.setVin(selectedVin);

    // Persist the selection now rather than gating it behind a prompt: a stale
    // default VIN would later operate on the wrong car. A VIN is not a secret,
    // so storing it needs no consent. The client ID/secret were already saved
    // above, before the OAuth round trip.
    await credentialStore.setTeslaVin(selectedVin);

    console.log('✓ Connected to Tesla');
    return true;
  } catch (error) {
    console.error('Authentication failed:', error);
    teslaService = null;
    return false;
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
  .action(async (options) => {
    console.log('Starting EV Charge Coordinator...\n');

    if (!(await initializeFranklin())) {
      console.log('Warning: FranklinWH service not available');
    }
    if (!(await initializeTesla())) {
      console.log('Warning: Tesla service not available');
    }

    if (!franklinService?.isAuthenticated() && !teslaService?.isAuthenticated()) {
      console.log('\nNo services available. Exiting.');
      process.exitCode = 1;
      return;
    }

    // Record the proxy so `exit` can stop it from a different process. Only
    // written when this process actually spawned one -- attaching to a proxy that
    // someone else started must not overwrite their recorded PID.
    const spawnedPid = franklinService?.spawnedProxyPid ?? null;
    if (spawnedPid) {
      writeRuntimeState({ pid: spawnedPid, port: DEFAULT_PROXY_PORT, startedAt: Date.now() });
    }

    console.log('\n✓ Services started successfully');
    reportResolvedProcesses(franklinService, teslaService);
    await warnAboutUntrackedProxy(spawnedPid);
    console.log('Type "help" for available commands or "exit" to quit.\n');

    // `--daemon` stays resident without the REPL, so `start --daemon` can be
    // backgrounded and `exit` run from another terminal. Exiting instead would
    // orphan the proxy and defeat the point of the flag.
    if (options.daemon) {
      console.log('Running in the background. Stop with: node dist/index.js exit');
      await keepResident();
      return;
    }

    // Interactive command loop
    const rl = createReadline();
    
    const handleCommand = async (input: string) => {
      const cmd = input.trim().toLowerCase();
      
      switch (cmd) {
        case 'help':
          console.log(`
Available commands:
  authenticate         Sign in to Tesla and store the credentials
  get-ev-bsoc         Get the current battery state of charge from the EV
  get-battery-soc     Get the current battery state of charge from the solar battery
  set-ev-charge-limit Set the EV's charge limit
  start-ev-charging   Start charging the EV
  stop-ev-charging    Stop charging the EV
  charge-from-battery Set the EV charge limit based on solar battery SoC
  set-battery-buffer  Set the amount of charge to keep in the solar battery
  status              Show current status of all systems
  exit                Exit the application
`);
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
            console.log('Invalid charge limit. Must be a number between 50 and 100.');
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
            console.log('Invalid buffer. Must be a number between 0 and 100.');
            break;
          }
          await setBatteryBuffer(currentContext(), buffer);
          break;
        }
          
        case 'exit':
        case 'quit':
          rl.close();
          return;
          
        case '':
          break;
          
        default:
          console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
      }
      
      rl.prompt();
    };
    
    rl.setPrompt('ev-charge> ');
    rl.prompt();
    
    rl.on('line', handleCommand);
    
    rl.on('close', async () => {
      console.log('\nShutting down...');

      // disconnect() only stops a proxy this process spawned, so quitting a REPL
      // that attached to somebody else's proxy leaves it running on purpose. The
      // state file is cleared only when we own it, so `exit` from another terminal
      // still has a PID to work with.
      if (franklinService) {
        if (franklinService.spawnedProxyPid) {
          await franklinService.disconnect();
          clearRuntimeState();
        } else {
          console.log('  Solar battery proxy was reused, not started here; leaving it running.');
        }
      }
      if (teslaService) {
        await teslaService.disconnect();
      }

      console.log('Goodbye!');
      process.exit(0);
    });
  });

program
  .command('exit')
  .description('Terminate the Python API proxy and NodeJS server')
  .action(async () => {
    console.log('Shutting down services...\n');

    // Stop in-process services first, when this process has any. A fresh process
    // has none, which is exactly the case this command used to silently no-op on
    // while reporting success.
    if (teslaService) {
      await teslaService.disconnect();
    }

    const state = readRuntimeState();
    if (!state) {
      console.log('No runtime state file; no proxy was started by `start`.');
      reportOrphanedProxy();
      console.log('\n✓ Nothing to stop');
      return;
    }

    if (!isProcessAlive(state.pid)) {
      console.log(`Recorded proxy (pid ${state.pid}) is no longer running; clearing stale state.`);
      clearRuntimeState();
      console.log('\n✓ Nothing to stop');
      return;
    }

    console.log(`Stopping proxy on port ${state.port} (pid ${state.pid})...`);

    // Ask the proxy to shut down first so it can close cleanly. It calls
    // os._exit(0) under Werkzeug >= 2.1, so the response body is discarded and the
    // HTTP call can time out; that is fine, because terminateProcess verifies the
    // process is actually gone and escalates if it is not.
    try {
      await axios.post(`http://127.0.0.1:${state.port}/shutdown`, undefined, { timeout: 5000 });
    } catch {
      // Expected on most Werkzeug versions; the escalation below is the real
      // guarantee that the process ends.
    }

    const outcome = await terminateProcess(state.pid);
    clearRuntimeState();

    const verb =
      outcome === 'exited' ? 'stopped cleanly' :
      outcome === 'killed' ? 'stopped (SIGKILL required)' :
      'already gone';
    console.log(`✓ Proxy ${verb}`);
    console.log('\n✓ Services stopped');
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

program
  .command('get-ev-bsoc')
  .description('Get the current battery state of charge from the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    await runCommand(getEvBatterySoc);
  });

program
  .command('get-battery-soc')
  .description('Get the current battery state of charge from the solar battery')
  .action(async () => {
    if (!(await initializeFranklin())) {
      process.exit(1);
    }
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
      console.error(`Charge limit must be between ${MIN_EV_CHARGE_LIMIT} and ${MAX_EV_CHARGE_LIMIT}`);
      process.exit(1);
    }

    if (!(await initializeTesla())) {
      process.exit(1);
    }
    await runCommand((ctx) => setEvChargeLimit(ctx, limit));
  });

program
  .command('start-ev-charging')
  .description('Start charging the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    await runCommand(startEvCharging);
  });

program
  .command('stop-ev-charging')
  .description('Stop charging the EV')
  .action(async () => {
    if (!(await initializeTesla())) {
      process.exit(1);
    }
    await runCommand(stopEvCharging);
  });

program
  .command('charge-from-battery')
  .description('Set EV charge limit based on solar battery SoC minus buffer')
  .action(async () => {
    if (!(await initializeFranklin()) || !(await initializeTesla())) {
      console.error('Both FranklinWH and Tesla must be connected');
      process.exit(1);
    }
    
    try {
      // offerToStart is false here, preserving the one-shot behaviour: it sets
      // the limit and stops. The REPL passes true. That difference is now
      // explicit rather than an accident of which copy you happen to read.
      await runCommand((ctx) => chargeFromBattery(ctx, { offerToStart: false }));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
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
      console.error('Buffer must be between 0 and 100');
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
    console.log('Already signed in to Tesla.');
    console.log(
      expiresAt > Date.now()
        ? `  Stored tokens valid until ${new Date(expiresAt).toISOString()}.`
        : '  Stored tokens have expired; the CLI will refresh them on next use.'
    );
    console.log('  Re-authorize anyway with: node dist/index.js authenticate --force');
    return true;
  }

  // Reuse stored app credentials unless overridden, so a re-auth does not force
  // the user to re-paste the secret they already saved.
  const clientId = options.clientId ?? existing?.clientId ?? (await prompt('Client ID: '));
  const clientSecret =
    options.clientSecret ?? existing?.clientSecret ?? (await promptPassword('Client Secret: '));

  if (!clientId.trim() || !clientSecret.trim()) {
    console.error('A Client ID and Client Secret are both required.');
    return false;
  }

  console.log('\nStarting OAuth authentication...');
  console.log('A browser window should open. If not, copy and paste the URL below.\n');

  const service = new TeslaService({ region: existing?.region });
  try {
    await service.initialize({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    await service.authenticate((authUrl) => {
      console.log('Please visit this URL to authorize:\n');
      console.log(authUrl);
      console.log('\nWaiting for authorization...');
    });

    // Store the app credentials only after a successful exchange. authenticate()
    // already saved the tokens; this adds the client ID/secret alongside them.
    await credentialStore.setTeslaCredentials({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      region: service.region as 'na' | 'eu' | 'cn',
    });
    console.log('✓ Signed in, and the credentials were stored securely');

    // authenticate() resolves a VIN, which is a /api/1 call. If the app is not
    // registered that is expected, and it is not a reason to call login a
    // failure -- registration is a separate step this command deliberately does
    // not perform.
    if (service.needsRegistration) {
      console.log(
        '  Tesla has not registered this application yet, so vehicles cannot be listed.\n' +
          '  Register it with: node dist/index.js pair-tesla-key --domain <your-domain>'
      );
    }
    return true;
  } catch (error) {
    console.error('Authentication failed:', error instanceof Error ? error.message : error);
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
        console.log(`✓ Tesla key domain set to ${domain}`);
        console.log('  Run pair-tesla-key to register it with Tesla.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    } else if (options.teslaRegion) {
      // Validated through resolveRegion so a typo fails here instead of surfacing
      // later as an HTTP 421 "incorrect region" from Tesla.
      try {
        const { region, coverage } = resolveRegion(options.teslaRegion);
        await credentialStore.setTeslaCredentials({ region });
        console.log(`✓ Tesla region set to ${region} (${coverage})`);
        console.log('  Re-run the pairing step if this moves you to a different deployment.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    } else if (options.clearFranklin) {
      await credentialStore.clearFranklinCredentials();
      console.log('✓ FranklinWH credentials cleared');
    } else if (options.clearTesla) {
      await credentialStore.clearTeslaCredentials();
      console.log('✓ Tesla credentials cleared');
    } else if (options.clearAll) {
      await credentialStore.clearAll();
      console.log('✓ All credentials cleared');
    } else {
      // Show current config
      const franklin = await credentialStore.getFranklinCredentials();
      const tesla = await credentialStore.getTeslaCredentials();
      const buffer = await credentialStore.getBatteryBuffer();
      
      console.log('\n--- Configuration ---');
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
        'No domain configured. Pass --domain <domain> or save one with:\n' +
          '  node dist/index.js config --tesla-domain <domain>'
      );
      process.exitCode = 1;
      return;
    }

    let domain: string;
    try {
      // Validated up front so a typo fails before any key material is touched.
      domain = normalizeDomain(domainInput);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
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
    console.log('\n--- Step 1 of 3: host the public key ---');
    console.log(`\nKey pair: ${virtualKeys.privateKeyPath} (keep this file; it signs every command)`);
    console.log(`Public key: ${virtualKeys.publicKeyPath}`);
    console.log(`\nServe this file at exactly:\n  ${instructions.url}`);
    console.log('\nIt must be the PEM itself, over HTTPS, with no redirect and no HTML page in front.');
    if (process.stdin.isTTY) {
      console.log(`\nPublic key contents:\n${instructions.publicKeyPem.trim()}`);
    }

    // Step 2: check what Tesla would actually fetch. Registering is not a consumable
    // -- POST /api/1/partner_accounts can be called repeatedly -- but if Tesla
    // ends up holding a key whose private half is not on this machine, the
    // pairing appears to succeed and every later command is rejected, so it is
    // much cheaper to notice a bad URL here.
    console.log('\n--- Step 2 of 3: verify the published key ---');
    const hosted = await virtualKeys.checkHostedPublicKey(domain);
    if (!hosted.matchesLocalKey) {
      console.error(`\n✗ ${hosted.error ?? 'The published key could not be verified.'}`);
      // The preview earns its own line only when the server actually answered
      // with a body; on a transport failure it just repeats the reason above.
      if (hosted.bodyPreview && hosted.reachable === false && hosted.status !== undefined) {
        console.error(`  Got instead: ${hosted.bodyPreview}`);
      }
      if (hosted.status !== undefined) {
        console.error(`  HTTP status: ${hosted.status}`);
      }
      console.error('\nFix the hosting above and re-run. Nothing has been sent to Tesla yet.');
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ${hosted.url} serves the matching public key`);

    if (options.skipRegistration) {
      console.log('\nSkipping Tesla registration (--skip-registration).');
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
  console.log('\n--- Step 3 of 3: register the domain with Tesla ---');

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
      'This step authenticates the application itself (a "partner" token), which\n' +
        'needs the Client ID and Secret from developer.tesla.com > your app.'
    );
    if (!process.stdin.isTTY) {
      console.error(
        '\nCannot prompt for credentials when stdin is not a terminal. Either run this\n' +
          'command interactively, or store the credentials first with a Tesla command.'
      );
      process.exitCode = 1;
      return false;
    }
    clientId = (await prompt('Client ID: ')).trim();
    clientSecret = await promptPassword('Client Secret: ');
    if (!clientId || !clientSecret) {
      console.error('Client ID and Secret are both required to register.');
      process.exitCode = 1;
      return false;
    }
    const save = await prompt('Store them for next time? (y/n): ');
    if (save.trim().toLowerCase() === 'y') {
      await credentialStore.setTeslaCredentials({ clientId, clientSecret });
      console.log('✓ Client ID/secret saved');
    }
  }

  try {
    const partnerToken = await virtualKeys.fetchPartnerToken(clientId, clientSecret);
    await virtualKeys.registerKey(partnerToken.accessToken, domain);
    console.log(`✓ Registered ${domain}`);

    const verification = await virtualKeys.verifyRegistration(partnerToken.accessToken, domain);
    if (!verification.registered) {
      console.error('✗ Tesla did not return a registered key for this domain.');
      console.error('  It may take a moment to propagate; re-run --check-only in a minute.');
      process.exitCode = 1;
      return false;
    }
    if (!verification.matchesLocalKey) {
      // The dangerous case: Tesla holds a key whose private half is not on this
      // machine. Pairing here would appear to succeed and then fail every command.
      console.error(
        `✗ Tesla holds a different public key for ${domain} than the one on this machine.\n` +
          '  Commands signed locally would be rejected. Check which domain you registered,\n' +
          '  and re-publish the public key at the path shown above.'
      );
      process.exitCode = 1;
      return false;
    }
    console.log('✓ Tesla holds the matching public key');

    // Remember the domain so later runs do not need --domain.
    const current = await credentialStore.getTeslaCredentials();
    if (current?.domain !== domain) {
      await credentialStore.setTeslaCredentials({ domain });
      console.log('✓ Domain saved to configuration');
    }
    return true;
  } catch (error) {
    console.error('Registration failed:', error instanceof Error ? error.message : error);
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
  console.log('\n--- Pair the vehicle ---');

  const consent = await checkUserConsent();
  if (consent && !consent.granted) {
    console.error(`\n✗ ${consent.detail}`);
    if (consent.reason === 'not-signed-in' || consent.reason === 'not-authorized') {
      console.error(
        '\nThe pairing link only works after you authorize this app. Sign in first:\n' +
          '  node dist/index.js authenticate\n' +
          '  (approve in the browser, then re-run pair-tesla-key)'
      );
    } else {
      console.error(
        '  Finish the previous step, then re-run this command.'
      );
    }
    process.exitCode = 1;
    return;
  }
  if (consent) {
    console.log('✓ This app has been granted access to your Tesla account.');
  }

  console.log('\nOpen this link on a device signed in to the Tesla app that owns the car:');
  console.log(`\n  ${virtualKeys.buildPairingUrl(domain, vin)}\n`);
  console.log('Approve the key in the app when it prompts. Pairing is a manual,');
  console.log('in-the-car step: Tesla documents no API that reports per-vehicle key');
  console.log('pairing, so this cannot be verified from the command line.');
  console.log(
    'To confirm afterwards, run a command (for example `get-ev-bsoc`); a vehicle that\n' +
      'rejects the key answers "your public key has not been paired with the vehicle".'
  );
}

/** Report key/registration state without mutating anything (--check-only). */
async function reportKeyState(
  virtualKeys: VirtualKeyService,
  domain: string,
  options: { verifyWithTesla: boolean; credentials?: { clientId?: string; clientSecret?: string } }
): Promise<void> {
  console.log(`\n--- Virtual key state for ${domain} ---`);

  // Read through the service rather than stat()ing the path directly, so the
  // same code path that would create a key is the one being reported on.
  const stored = await new VirtualKeyStore().load();
  console.log(
    stored
      ? `Local key pair: ${virtualKeys.privateKeyPath}`
      : 'Local key pair: not created yet (run pair-tesla-key to generate one)'
  );

  const hosted = await virtualKeys.checkHostedPublicKey(domain);
  if (hosted.matchesLocalKey) {
    console.log(`Hosted key: OK ${hosted.url} serves the matching public key`);
  } else {
    console.log(`Hosted key: PROBLEM ${hosted.error ?? 'could not be verified'}`);
    if (hosted.status !== undefined) console.log(`  HTTP status: ${hosted.status}`);
    if (hosted.bodyPreview && hosted.reachable === false && hosted.status !== undefined) {
      console.log(`  Got instead: ${hosted.bodyPreview}`);
    }
  }

  if (!options.verifyWithTesla) return;
  if (!options.credentials?.clientId || !options.credentials?.clientSecret) {
    console.log('Tesla registration: skipped (no stored client ID/secret)');
  } else {
    try {
      const token = await virtualKeys.fetchPartnerToken(
        options.credentials.clientId,
        options.credentials.clientSecret
      );
      const result = await virtualKeys.verifyRegistration(token.accessToken, domain);
      if (!result.registered) {
        console.log('Tesla registration: no key registered for this domain');
      } else if (result.matchesLocalKey) {
        console.log('Tesla registration: OK Tesla holds the matching public key');
      } else {
        console.log('Tesla registration: PROBLEM Tesla holds a DIFFERENT public key for this domain');
      }
    } catch (error) {
      console.log(
        `Tesla registration: could not be checked (${error instanceof Error ? error.message : error})`
      );
    }
  }

  // Consent is the third and last gate before pairing, and the only one the
  // user cannot check by looking at a file. Report it here so one command
  // answers "what is still outstanding" rather than requiring three.
  const consent = await checkUserConsent();
  if (consent === null) {
    console.log('Account access: unknown (could not reach Tesla)');
  } else if (consent.granted) {
    console.log('Account access: OK the user has granted this app access to their account');
  } else if (consent.reason === 'not-signed-in') {
    console.log('Account access: MISSING never authorized (run `authenticate` and approve)');
  } else if (consent.reason === 'not-authorized') {
    console.log('Account access: MISSING token rejected; re-authorize (run `authenticate --force`)');
  } else {
    console.log(`Account access: not confirmed (${consent.reason}) - ${consent.detail}`);
  }

}

program.parse();
