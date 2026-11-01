/**
 * The process session: service singletons, their initialization, and the
 * one-shot command plumbing.
 *
 * The services are session-scoped because their lifecycle spans commands: the
 * REPL owns them, `exit` can stop a proxy from another process via runtime
 * state, and one-shot commands create and disconnect them per run. Handlers
 * only ever see a CommandContext (built here), so they stay testable without a
 * real keychain, a Python proxy, or the network.
 */
import { FranklinWHService, ProxyStartupError, TeslaService } from '../services/index.js';
import {
  spawnedTeslaProxyPid,
  startTeslaProxy,
  stopTeslaProxy,
} from '../services/TeslaCommandProxy.js';
import { credentialStore } from '../utils/credentials.js';
import {
  resolveEnergyConfig,
  saveEnergyConfig,
  setEnergyConfigField,
} from '../utils/config.js';
import * as paint from '../utils/color.js';
import { describeError, type CommandContext, type CommandResult } from './context.js';
import { prompt, promptNumeric, promptSecret } from './prompt.js';

/** Loopback port the Python proxy listens on. Mirrors FranklinWHService's default. */
export const DEFAULT_PROXY_PORT = 3001;

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
 * Print the stack trace and raw upstream body for a failed service, under --debug.
 *
 * The one-line form deliberately drops detail, so `--debug` is the only way to see
 * what the upstream actually said. In the case that prompted this, the useful
 * detail (a 502 URL from FranklinWH's cloud) was buried several levels down a
 * printed AxiosError while the actionable line above it said only "failed".
 */
export function reportDebugDetails(debug: boolean | undefined, cause: unknown): void {
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

/**
 * The live process session. One per CLI process (created by index.ts and
 * injected into every command factory that needs a service).
 */
export interface Session {
  /** Authenticate to FranklinWH (stored credentials first, then prompt). */
  initializeFranklin(): Promise<ServiceStart>;
  /** Authenticate to Tesla (stored session first, then interactive OAuth). */
  initializeTesla(): Promise<ServiceStart>;
  /** The FranklinWH service of this session; null until initialized. */
  getFranklin(): FranklinWHService | null;
  /** The Tesla service of this session; null until initialized. */
  getTesla(): TeslaService | null;
  /**
   * Build a CommandContext from the session's services.
   *
   * The services stay session-scoped because the REPL owns their lifecycle, but
   * the handlers only ever see this object, so they are testable without them.
   */
  currentContext(): CommandContext;
  /**
   * Run a handler, stop this run's sidecar proxy, and exit non-zero on failure.
   *
   * Every one-shot command funnels through here so failures always exit non-zero
   * and any signed-command proxy this run spawned is stopped before the process
   * ends -- a running child would keep the event loop alive and hang the CLI.
   * The REPL calls the handlers directly instead, because a failed command there
   * must not kill an interactive session; it stops its proxy at session close.
   */
  runCommand(run: (ctx: CommandContext) => Promise<CommandResult>): Promise<void>;
  /**
   * One-shot commands: report a failed initialization and stop.
   *
   * The old guards negated the awaited initializer result, which can never fire:
   * both initializers return a ServiceStart *object*, and every object is truthy
   * -- so the check beneath them was dead code and failures fell through into
   * the command handler.
   */
  requireService(name: 'Tesla' | 'FranklinWH', init: ServiceStart): void;
}

export function createSession(): Session {
  let franklinService: FranklinWHService | null = null;
  let teslaService: TeslaService | null = null;

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
    const password = await promptSecret('Password: ');
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
        callbackPort: stored.callbackPort,
        // Vehicle commands route through the signed-command sidecar, which this
        // resolver lazy-spawns (and records) the first time a command is sent.
        commandProxy: async () => {
          const handle = await startTeslaProxy();
          return { port: handle.port, caPem: handle.certPem };
        },
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
    const clientSecret = storedClientSecret ?? (await promptSecret('Client Secret: '));

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
        const selection = await promptNumeric('Select vehicle number (ESC to cancel): ');
        if (selection === null) {
          // ESC never submits a line, so start a fresh one for the notice.
          console.log(paint.warning('\nVehicle selection cancelled.'));
          return { ok: false, error: 'Vehicle selection cancelled' };
        }
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

  function currentContext(): CommandContext {
    return {
      franklin: franklinService,
      tesla: teslaService,
      config: {
        resolve: resolveEnergyConfig,
        setField: setEnergyConfigField,
        save: saveEnergyConfig,
      },
      ask: prompt,
      askNumeric: promptNumeric,
      interactive: process.stdin.isTTY === true,
    };
  }

  async function runCommand(run: (ctx: CommandContext) => Promise<CommandResult>): Promise<void> {
    try {
      const result = await run(currentContext());
      if (!result.ok) {
        process.exitCode = 1;
      }
    } finally {
      // Only a proxy this process spawned: one that was merely attached to
      // (REPL or daemon) belongs to whoever started it.
      if (spawnedTeslaProxyPid() !== null) {
        await stopTeslaProxy();
      }
    }
  }

  function requireService(name: 'Tesla' | 'FranklinWH', init: ServiceStart): void {
    if (init.ok) return;
    console.log(paint.error(`✗ ${name} service not started. Error: ${init.error}`));
    process.exit(1);
  }

  return {
    initializeFranklin,
    initializeTesla,
    getFranklin: () => franklinService,
    getTesla: () => teslaService,
    currentContext,
    runCommand,
    requireService,
  };
}
