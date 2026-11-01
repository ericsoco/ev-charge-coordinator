/**
 * `authenticate`: sign in to Tesla and store the credentials.
 *
 * The selection rules this encodes all address one trap: the stored client
 * ID/secret belong to a Tesla application that may have been recreated or had
 * its secret rotated, and re-running OAuth with the dead pair produces an
 * authorize URL that can only fail in the browser:
 *
 *  - explicit flags always win and are never silently paired with a stored
 *    counterpart (a new client ID with the old stored secret is broken);
 *  - stored credentials are reused only after the operator says so;
 *  - a dead pair is detected up front (token-endpoint probe) instead of at the
 *    browser, and 'unknown' probe results never block the flow.
 *
 * The selection matrix is injectable (ask / askSecret / probe) so it is unit
 * testable; runAuthenticate below wires the real prompt and probe
 * implementations, and is shared by the Commander action and the REPL dispatch.
 */
import { Command } from 'commander';
import axios from 'axios';
import { TeslaService } from '../services/TeslaService.js';
import { probeClientCredentials } from '../services/tesla/oauth.js';
import { credentialStore } from '../utils/credentials.js';
import { formatLocalTimestamp } from '../utils/time.js';
import * as paint from '../utils/color.js';
import { prompt, promptSecret } from './prompt.js';

export interface AppCredentialSource {
  clientId?: string;
  clientSecret?: string;
}

export interface CredentialIO {
  ask: (question: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
}

/** Token-endpoint probe verdict; 'unknown' means "do not block". */
export type ClientCredentialProbe = 'ok' | 'invalid' | 'unknown';

export interface SelectAppCredentialsDeps {
  existing: AppCredentialSource | undefined;
  flags: AppCredentialSource;
  io: CredentialIO;
  /**
   * Best-effort liveness check for a client ID. Called only when no flags were
   * given and stored credentials exist. Implementations must never receive —
   * and must not be able to receive — a real refresh token: Tesla refresh
   * tokens are single-use, and burning one forces a full re-pair.
   */
  probe: (clientId: string) => Promise<ClientCredentialProbe>;
  /** User-facing informational line (status, not errors). */
  note: (message: string) => void;
}

/** How resolved credentials were obtained; drives the post-reauth guidance. */
export type CredentialSource = 'stored' | 'entered' | 'flags';

export type SelectedAppCredentials =
  | { clientId: string; clientSecret: string; source: CredentialSource }
  | { rejected: true };

export function reuseQuestion(clientId: string): string {
  return `Re-use the stored app credentials (client ID ${clientId})? (y/n): `;
}

async function promptForNewCredentials(
  io: CredentialIO
): Promise<{ clientId: string; clientSecret: string; source: 'entered' }> {
  return {
    clientId: (await io.ask('Client ID: ')).trim(),
    clientSecret: (await io.askSecret('Client Secret: ')).trim(),
    source: 'entered',
  };
}

export async function selectAppCredentials(
  deps: SelectAppCredentialsDeps
): Promise<SelectedAppCredentials> {
  const { existing, flags, io } = deps;

  // Flags are explicit intent: use them, prompt only for what is missing, and
  // never fall back to the stored counterpart of a supplied flag.
  if (flags.clientId !== undefined || flags.clientSecret !== undefined) {
    return {
      clientId: flags.clientId ?? (await io.ask('Client ID: ')).trim(),
      clientSecret: flags.clientSecret ?? (await io.askSecret('Client Secret: ')).trim(),
      source: 'flags',
    };
  }

  if (existing?.clientId && existing.clientSecret) {
    // Auto-detection: a stored pair Tesla no longer recognizes is a dead end
    // at the browser; say so here and take new values instead of asking.
    if ((await deps.probe(existing.clientId)) === 'invalid') {
      deps.note(
        'Tesla does not recognize the stored client ID/secret (app recreated or rotated?).'
      );
      const entered = await promptForNewCredentials(io);
      if ((await deps.probe(entered.clientId)) === 'invalid') {
        return { rejected: true };
      }
      return entered;
    }
    // 'ok' and 'unknown' both land here: the reuse question is the safe
    // default and the probe never blocks an uncertain network.
    const answer = (await io.ask(reuseQuestion(existing.clientId))).trim().toLowerCase();
    if (answer === 'y') {
      return {
        clientId: existing.clientId,
        clientSecret: existing.clientSecret,
        source: 'stored',
      };
    }
    return promptForNewCredentials(io);
  }

  return promptForNewCredentials(io);
}

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
export async function runAuthenticate(
  options: { clientId?: string; clientSecret?: string; reauth?: boolean } = {}
): Promise<boolean> {
  const existing = await credentialStore.getTeslaCredentials();

  // Without --reauth, an intact session is left alone rather than sending the user
  // through consent again for no reason.
  const hasSession =
    Boolean(existing?.accessToken) &&
    Boolean(existing?.refreshToken) &&
    Boolean(existing?.clientId) &&
    Boolean(existing?.clientSecret);
  if (hasSession && !options.reauth) {
    const expiresAt = existing?.expiresAt ?? 0;
    console.log(paint.info('Already signed in to Tesla.'));
    console.log(
      paint.info(
        expiresAt > Date.now()
          ? `  Stored tokens valid until ${formatLocalTimestamp(expiresAt)}.`
          : '  Stored tokens have expired; the CLI will refresh them on next use.'
      )
    );
    console.log(paint.positive('  Re-authorize anyway with: node dist/index.js authenticate --reauth'));
    return true;
  }

  // Selection rules (see the module header): flags win and are never
  // paired with a stored counterpart; stored credentials are reused only on an
  // explicit yes; a stored pair Tesla no longer recognizes (app recreated or
  // secret rotated) is detected by the token-endpoint probe instead of failing
  // at the browser.
  const selected = await selectAppCredentials({
    existing: existing ?? undefined,
    flags: { clientId: options.clientId, clientSecret: options.clientSecret },
    io: { ask: prompt, askSecret: promptSecret },
    probe: (clientId) =>
      probeClientCredentials({
        clientId,
        post: (url, form, headers) =>
          axios.post(url, form, { headers, validateStatus: () => true }),
      }),
    note: (message) => console.log(paint.info(message)),
  });
  if ('rejected' in selected) {
    console.error(
      paint.error(
        'Tesla rejected these client credentials too; check them and run authenticate again.'
      )
    );
    return false;
  }
  const { clientId, clientSecret, source } = selected;

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
    if (source !== 'stored') {
      const next = existing?.domain
        ? `node dist/index.js pair-tesla-key --domain ${existing.domain}`
        : 'node dist/index.js pair-tesla-key --domain <your-domain>';
      console.log(
        paint.info(
          '\nYour application key pair (~/.ev-charge-coordinator/private-key.pem) is usually\n' +
            'reusable and not tied to the client ID. If registration answers "public key hash\n' +
            'has already been taken", the recreated app cannot claim the old key: rotate with\n' +
            'pair-tesla-key --rotate-key (re-uploads the new public key and re-pairs every vehicle).'
        )
      );
      console.log(paint.info(`Next: ${next}`));
    }
    return true;
  } catch (error) {
    console.error(paint.error(`Authentication failed: ${error instanceof Error ? error.message : error}`));
    return false;
  }
}

export function createAuthenticateCommand(): Command {
  return new Command('authenticate')
    .allowExcessArguments(false)
    .description('Sign in to Tesla and store the credentials (no other side effects)')
    .option('--client-id <id>', 'Client ID from developer.tesla.com (default: the stored one)')
    .option('--client-secret <secret>', 'Client Secret (default: the stored one)')
    .option('--reauth', 'Re-authorize even if credentials are already stored')
    .action(async (options) => {
      if (!(await runAuthenticate(options))) {
        process.exitCode = 1;
      }
    });
}
