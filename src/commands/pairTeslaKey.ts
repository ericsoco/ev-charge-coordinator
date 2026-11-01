/**
 * `pair-tesla-key`: register this application's virtual key with Tesla and
 * print the vehicle pairing link.
 *
 * `runPairTeslaKey` is shared by the Commander action and the REPL dispatch
 * (modeled on runAuthenticate): it returns success, and only the Commander
 * wrapper turns failure into a process exit code. The helpers below (hosting
 * verification, registration, consent, pairing link) are steps of the same
 * flow and live here with it.
 */
import { Command } from 'commander';
import axios from 'axios';
import { TeslaService, type ConsentState } from '../services/TeslaService.js';
import { describeAxiosHttpError } from '../services/tesla/oauth.js';
import { resolveRegion } from '../services/tesla/endpoints.js';
import {
  normalizeDomain,
  VirtualKeyService,
  VirtualKeyStore,
} from '../services/tesla/VirtualKeyService.js';
import { credentialStore } from '../utils/credentials.js';
import * as paint from '../utils/color.js';
import { describeError } from './context.js';
import { prompt, promptSecret } from './prompt.js';

/** Options of the `pair-tesla-key` command; the REPL builds the same shape from flags. */
export interface PairTeslaKeyOptions {
  domain?: string;
  vin?: string;
  checkOnly?: boolean;
  skipRegistration?: boolean;
  rotateKey?: boolean;
  [key: string]: unknown;
}

export async function runPairTeslaKey(options: PairTeslaKeyOptions): Promise<boolean> {
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
    return false;
  }

  let domain: string;
  try {
    // Validated up front so a typo fails before any key material is touched.
    domain = normalizeDomain(domainInput);
  } catch (error) {
    console.error(paint.error(describeError(error)));
    return false;
  }

  const vin = options.vin ?? stored?.vin;

  if (options.checkOnly) {
    await reportKeyState(virtualKeys, domain, { verifyWithTesla: true, credentials: stored });
    return true;
  }

  if (options.rotateKey) {
    console.log(
      paint.warning(
        '\nRotating the application key pair: every vehicle that has approved this key\n' +
          'must re-approve the new one.'
      )
    );
    await virtualKeys.rotateKeyPair();
    console.log(paint.positive(`✓ New key pair written to ${virtualKeys.privateKeyPath}`));
    console.log(
      paint.info(
        'Upload the public key printed below to the well-known URL, then re-run\n' +
          'pair-tesla-key WITHOUT --rotate-key (rotating again replaces the key yet again).'
      )
    );
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
    return false;
  }
  console.log(paint.positive(`✓ ${hosted.url} serves the matching public key`));

  if (options.skipRegistration) {
    console.log(paint.info('\nSkipping Tesla registration (--skip-registration).'));
    await printPairingLinkIfReady(virtualKeys, domain, vin);
    return true;
  }

  if (!(await registerDomainWithTesla(virtualKeys, domain, stored))) return false;
  await printPairingLinkIfReady(virtualKeys, domain, vin);
  return true;
}

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
    clientSecret = await promptSecret('Client Secret: ');
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

  let phase = 'mint a partner token';
  try {
    const partnerToken = await virtualKeys.fetchPartnerToken(clientId, clientSecret);
    phase = 'register the domain (POST /api/1/partner_accounts)';
    await virtualKeys.registerKey(partnerToken.accessToken, domain);
    console.log(paint.positive(`✓ Registered ${domain}`));

    phase = 'confirm the registration';
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
    console.error(
      paint.error(
        `Registration failed while trying to ${phase}: ${describeAxiosHttpError(error)}`
      )
    );
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
    console.log(paint.warning('Account access: MISSING token rejected; re-authorize (run `authenticate --reauth`)'));
  } else {
    console.log(paint.warning(`Account access: not confirmed (${consent.reason}) - ${consent.detail}`));
  }
}

export function createPairTeslaKeyCommand(): Command {
  return new Command('pair-tesla-key')
    .allowExcessArguments(false)
    .description("Register this application's virtual key with Tesla and print the vehicle pairing link")
    .option('--domain <domain>', 'Domain that hosts the public key (defaults to the stored value)')
    .option('--vin <vin>', 'Vehicle to pair (defaults to the stored VIN)')
    .option('--check-only', 'Only report the current key/registration state; change nothing')
    .option('--skip-registration', 'Do not call Tesla; only verify the hosted key and print the link')
    .option('--rotate-key', 'Generate a fresh key pair (invalidates every already-paired vehicle)')
    .action(async (options) => {
      // exitCode stays here so a REPL session cannot inherit it.
      if (!(await runPairTeslaKey(options))) process.exitCode = 1;
    });
}
