/**
 * Tesla Fleet API OAuth wire format + endpoint resolution.
 *
 * These are the request shapes the CLI sends to Tesla. Everything here is pure, so
 * the assertions pin the exact parameter sets rather than mocking axios: an extra
 * or missing parameter on these endpoints fails the flow server-side with a
 * confusing error, which is precisely what this module exists to prevent.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationCodeTokenForm,
  buildAuthorizeUrl,
  buildClientCredentialsTokenForm,
  buildRefreshTokenForm,
  classifyTokenEndpointError,
  createNonce,
  createOAuthState,
  createPkcePair,
  describeAxiosHttpError,
  describeTeslaError,
  rateLimitedRetrySeconds,
  RATE_LIMIT_FALLBACK_SEC,
  RATE_LIMIT_MAX_SLEEP_SEC,
  isValidPkceVerifier,
  parseTokenResponse,
  probeClientCredentials,
  PROBE_REFRESH_TOKEN,
  TOKEN_FORM_HEADERS,
} from '../../src/services/tesla/oauth.js';
import {
  buildRevokeConsentUrl,
  isTeslaRegion,
  resolveRegion,
  TESLA_AUTHORIZE_URL,
  TESLA_PARTNER_SCOPES,
  TESLA_PARTNER_SCOPE_STRING,
  TESLA_SCOPES,
  TESLA_SCOPE_STRING,
  TESLA_TOKEN_URL,
} from '../../src/services/tesla/endpoints.js';

/** Fixed 32-byte source so the verifier and challenge can be derived by hand. */
function fixedRandom(byte: number): () => Buffer {
  return () => Buffer.alloc(32, byte);
}

const BASE_AUTHORIZE = {
  clientId: 'cid',
  redirectUri: 'http://localhost:8089/callback',
  scope: TESLA_SCOPE_STRING,
  state: 'state-value',
  nonce: 'nonce-value',
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('randomness helpers', () => {
  it('derives the S256 challenge from the verifier with SHA-256', () => {
    const verifier = fixedRandom(7)().toString('base64url');
    const expected = createHash('sha256').update(verifier).digest('base64url');

    const pair = createPkcePair(fixedRandom(7));

    expect(pair.codeVerifier).toBe(verifier);
    expect(pair.codeChallenge).toBe(expected);
    expect(pair.codeChallenge).not.toBe(verifier);
    expect(pair.codeChallengeMethod).toBe('S256');
  });

  it('produces verifiers inside the RFC 7636 43..128 character window', () => {
    const { codeVerifier } = createPkcePair();
    expect(codeVerifier.length).toBe(43);
    expect(isValidPkceVerifier(codeVerifier)).toBe(true);
  });

  it('never reuses a verifier, state or nonce across calls', () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
    expect(createOAuthState()).not.toBe(createOAuthState());
    expect(createNonce()).not.toBe(createNonce());
  });

  it('rejects verifiers outside the unreserved set or too short to be legal', () => {
    expect(isValidPkceVerifier('short')).toBe(false);
    expect(isValidPkceVerifier('a'.repeat(43) + '+')).toBe(false);
    expect(isValidPkceVerifier('a'.repeat(42))).toBe(false);
    expect(isValidPkceVerifier(undefined)).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('sends the documented parameter set and nothing else', () => {
    const url = buildAuthorizeUrl(BASE_AUTHORIZE);
    const params = paramsOf(url);

    expect(new URL(url).origin + new URL(url).pathname).toBe(TESLA_AUTHORIZE_URL);
    expect([...params.keys()].sort()).toEqual(
      ['client_id', 'nonce', 'redirect_uri', 'response_type', 'scope', 'state'].sort()
    );
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('redirect_uri')).toBe('http://localhost:8089/callback');
    expect(params.get('state')).toBe('state-value');
    expect(params.get('nonce')).toBe('nonce-value');
  });

  it('keeps the scope list readable as %20-separated rather than pluses', () => {
    const url = buildAuthorizeUrl(BASE_AUTHORIZE);

    expect(url).toContain('scope=openid%20offline_access');
    expect(url).not.toContain('+');
    expect(paramsOf(url).get('scope')).toBe(TESLA_SCOPE_STRING);
  });

  it('omits PKCE by default because Tesla does not document it on /authorize', () => {
    const url = buildAuthorizeUrl(BASE_AUTHORIZE);

    expect(url).not.toContain('code_challenge');
    expect(url).not.toContain('code_challenge_method');
  });

  it('appends both PKCE parameters when the operator opts in', () => {
    const url = buildAuthorizeUrl({ ...BASE_AUTHORIZE, pkce: createPkcePair() });
    const params = paramsOf(url);

    expect(params.get('code_challenge')).toHaveLength(43);
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('adds show_keypair_step and prompt_missing_scopes only when asked', () => {
    expect(buildAuthorizeUrl(BASE_AUTHORIZE)).not.toContain('show_keypair_step');
    expect(buildAuthorizeUrl(BASE_AUTHORIZE)).not.toContain('prompt_missing_scopes');

    const url = buildAuthorizeUrl({
      ...BASE_AUTHORIZE,
      showKeypairStep: true,
      promptMissingScopes: true,
    });
    expect(paramsOf(url).get('show_keypair_step')).toBe('true');
    expect(paramsOf(url).get('prompt_missing_scopes')).toBe('true');
  });
});

describe('token exchange forms', () => {
  it('posts form-urlencoded bodies, never JSON', () => {
    expect(TOKEN_FORM_HEADERS['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = buildAuthorizationCodeTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      redirectUri: 'http://localhost:8089/callback',
      code: 'the-code',
    }).toString();

    expect(body).not.toContain('{');
    expect(new URLSearchParams(body).get('code')).toBe('the-code');
  });

  it('sends audience and redirect_uri on the authorization_code grant', () => {
    const form = buildAuthorizationCodeTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      redirectUri: 'http://localhost:8089/callback',
      code: 'the-code',
    });

    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBe('secret');
    expect(form.get('audience')).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');
    expect(form.get('redirect_uri')).toBe('http://localhost:8089/callback');
    expect(form.has('code_verifier')).toBe(false);
  });

  it('sends code_verifier only when a PKCE challenge was presented', () => {
    const form = buildAuthorizationCodeTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'aud',
      redirectUri: 'redirect',
      code: 'c',
      codeVerifier: 'a'.repeat(43),
    });

    expect(form.get('code_verifier')).toBe('a'.repeat(43));
  });

  it('omits client_secret and audience on the refresh_token grant', () => {
    const form = buildRefreshTokenForm({ clientId: 'cid', refreshToken: 'rt' });

    expect([...form.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.has('client_secret')).toBe(false);
    expect(form.has('audience')).toBe(false);
  });

  it('sends audience on client_credentials and nothing else', () => {
    const form = buildClientCredentialsTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'aud',
    });

    expect([...form.keys()].sort()).toEqual([
      'audience',
      'client_id',
      'client_secret',
      'grant_type',
    ]);
    expect(form.get('grant_type')).toBe('client_credentials');
  });

  it('includes scope on client_credentials when one is supplied, and omits it otherwise', () => {
    // The Partner Tokens page sends `scope` on this grant; the form builder must
    // support it, and must stay silent when a caller wants a bare app-level token.
    const withScope = buildClientCredentialsTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'aud',
      scope: 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds',
    });
    expect(withScope.get('scope')).toBe(
      'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds'
    );

    const withoutScope = buildClientCredentialsTokenForm({
      clientId: 'cid',
      clientSecret: 'secret',
      audience: 'aud',
    });
    expect(withoutScope.has('scope')).toBe(false);
  });

  it('never asks for offline_access on the partner-token grant', () => {
    // A partner token is re-minted from client credentials and never refreshed,
    // so requesting a refresh token would be meaningless.
    expect(TESLA_PARTNER_SCOPE_STRING).not.toContain('offline_access');
    expect(TESLA_PARTNER_SCOPES).toEqual([
      'openid',
      'vehicle_device_data',
      'vehicle_cmds',
      'vehicle_charging_cmds',
    ]);
    // The user-facing scope set is a superset, which is what makes this a real
    // distinction rather than a duplicate constant.
    expect(TESLA_SCOPES).toContain('offline_access');
  });
});

describe('parseTokenResponse', () => {
  const NOW = 1_700_000_000_000;

  it('converts seconds into an absolute expiry with a 30s safety margin', () => {
    const tokens = parseTokenResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      NOW
    );

    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: NOW + 3_600_000 - 30_000,
    });
  });

  it('treats a missing expires_in as already expired rather than eternal', () => {
    const tokens = parseTokenResponse({ access_token: 'at', refresh_token: 'rt' }, NOW);

    expect(tokens.expiresAt).toBe(NOW - 30_000);
  });

  it('rejects a response with no access_token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'rt' }, NOW)).toThrow(/access_token/);
  });

  it('names the offline_access scope when no refresh_token came back', () => {
    expect(() => parseTokenResponse({ access_token: 'at', expires_in: 10 }, NOW)).toThrow(
      /offline_access scope/
    );
  });
});

describe('describeTeslaError', () => {
  it('turns documented error strings into actionable advice', () => {
    // Must name a command that exists. `authenticate` is the login command: it
    // stores credentials and issues no other API call.
    expect(describeTeslaError(400, 'invalid_auth_code')).toContain('authenticate');
    expect(describeTeslaError(400, 'invalid_redirect_url')).toContain('must equal');
    expect(describeTeslaError(401, 'unauthorized_client')).toContain('client_secret');
    expect(describeTeslaError(401, 'login_required')).toContain('already consumed');
    expect(describeTeslaError(403, 'mobile_access_disabled')).toContain('switched off');
  });

  it('maps the region and registration status codes Tesla only documents in passing', () => {
    expect(describeTeslaError(412, 'Precondition Failed')).toContain('pair-tesla-key');
    expect(describeTeslaError(422, 'Unprocessable')).toContain('Allowed Origins');
    expect(
      describeTeslaError(422, 'Validation failed: Public key hash has already been taken')
    ).toContain('--rotate-key');
    expect(describeTeslaError(421, 'Misdirected Request')).toContain('region');
    expect(describeTeslaError(401, 'nope')).toContain('token expired or revoked');
    expect(describeTeslaError(429, 'Retry in 12 seconds')).toContain('rate limit');
  });

  it('explains the not-registered error Tesla actually returns', () => {
    // Observed live from GET /api/1/vehicles. The registration step is separate
    // from OAuth consent, so the advice has to say so: a user who has already
    // authorized the app would otherwise assume they were misconfigured.
    const mapped = describeTeslaError(
      412,
      'Account 2fc1d3f9-753b-4b9f-8648-ec112c146567 must be registered in the current region ' +
        'https://fleet-api.prd.na.vn.cloud.tesla.com'
    );

    expect(mapped).toContain('pair-tesla-key');
    // Must not tell the user to fix a region, since the region in the message is
    // simply where the token was minted.
    expect(mapped).not.toContain('wrong region');
    expect(mapped).toContain('Allowed Origin');
  });

  it('maps the strings observed from the live token endpoint', () => {
    // HTTP 400 {"error":"client_not_found","error_description":"The specified
    // client was not found."} is what a wrong client_id actually returns.
    expect(describeTeslaError(400, 'client_not_found')).toContain('developer.tesla.com');
    expect(describeTeslaError(400, 'invalid_client')).toContain('client_id/secret');
    expect(describeTeslaError(undefined, 'access_denied')).toContain('declined');
  });

  it('never tells the user to run a command that does not exist', () => {
    // Regression guard. Three advice strings named an `authenticate` command that
    // was never registered, and one named `register-key` after it was renamed --
    // each time the test asserted the stale text, so the suite protected the bug.
    // This walks the real command names out of src/index.ts and checks every
    // message that mentions one, so renaming a command can no longer silently
    // orphan its advice.
    const source = readFileSync(
      new URL('../../src/index.ts', import.meta.url),
      'utf8'
    );
    const commands = new Set(
      [...source.matchAll(/\.command\('([^']+)'\)/g)].map((m) => m[1])
    );
    expect(commands.size).toBeGreaterThan(5);

    // Every error message, probed against every known status and code.
    const probes = [
      ...['invalid_auth_code', 'invalid_redirect_url', 'access_denied', 'login_required',
          'client_not_found', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type',
          'mobile_access_disabled'],
      ...['Precondition Failed', 'Misdirected Request', 'boom'],
    ];
    for (const status of [undefined, 400, 401, 412, 421, 500]) {
      for (const raw of probes) {
        const message = describeTeslaError(status, raw);
        // A backticked word in the advice is meant to be a command the user can
        // run, so each one must resolve to a registered command.
        for (const [, name] of message.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
          expect(
            commands.has(name),
            `"${name}" in advice for ${String(status)}/${raw} is not a command`
          ).toBe(true);
        }
      }
    }
  });

  it('strips control characters so a redirect cannot write to the terminal', () => {
    const mapped = describeTeslaError(400, 'evil\u001b[31mred\u001b[0m\u000a\u000dfake');

    // The escape introducer and the CR/LF are what do the damage; with ESC gone the
    // leftover "[31m" is inert text, so the result is pinned exactly rather than
    // pretending the sequence is removed wholesale.
    expect(mapped).toBe('HTTP 400: evil[31mred[0mfake');
    expect(mapped).not.toContain('\u001b');
    expect(mapped).not.toContain('\u000a');
    expect(mapped).not.toContain('\u000d');
  });

  it('passes unknown failures through with the status attached', () => {
    expect(describeTeslaError(undefined, 'socket hang up')).toBe('socket hang up');
    expect(describeTeslaError(500, 'boom')).toBe('HTTP 500: boom');
  });
});

describe('endpoint and region resolution', () => {
  it('defaults to the na deployment, matching the Tesla default', () => {
    expect(resolveRegion().apiBaseUrl).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');
    expect(resolveRegion('').region).toBe('na');
  });

  it('pins one base URL per deployment and flags China as a separate portal', () => {
    expect(resolveRegion('eu').apiBaseUrl).toBe('https://fleet-api.prd.eu.vn.cloud.tesla.com');
    expect(resolveRegion('cn').apiBaseUrl).toBe('https://fleet-api.prd.cn.vn.cloud.tesla.cn');
    expect(resolveRegion('cn').separatePortal).toBe(true);
    expect(resolveRegion('eu').separatePortal).toBe(false);
    // Asia-Pacific rides on the na deployment, so there is no apac host to offer.
    expect(isTeslaRegion('apac')).toBe(false);
  });

  it('fails loudly on an unknown region instead of defaulting silently', () => {
    expect(() => resolveRegion('NA')).toThrow(/Unknown Tesla region "NA"/);
    expect(() => resolveRegion('NA')).toThrow(/na, eu, cn/);
  });

  it('sends token exchanges to the fleet-auth host the docs mandate', () => {
    expect(TESLA_TOKEN_URL).toBe('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');
    expect(TESLA_TOKEN_URL).not.toBe('https://auth.tesla.com/oauth2/v3/token');
  });

  it('requests the scopes the commands need plus offline_access', () => {
    expect(TESLA_SCOPES).toContain('offline_access');
    expect(TESLA_SCOPES).toContain('vehicle_charging_cmds');
    expect(TESLA_SCOPES).toContain('vehicle_location');
    expect(TESLA_SCOPE_STRING).toBe(
      'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location'
    );
  });

  it('builds the consent-manager revoke URL for the selected region', () => {
    expect(buildRevokeConsentUrl('cid', 'eu')).toBe(
      'https://fleet-api.prd.eu.vn.cloud.tesla.com/oauth2/v3/consent?client_id=cid'
    );
  });
});

describe('client-credential probe (dead app detection)', () => {
  it('classifies thrown token-endpoint errors by the OAuth error field', () => {
    // Tesla's observed values (live probes 2026-10-24).
    expect(classifyTokenEndpointError({ response: { data: { error: 'client_not_found' } } })).toBe(
      'invalid-client'
    );
    expect(classifyTokenEndpointError({ response: { data: { error: 'login_required' } } })).toBe(
      'invalid-grant'
    );
    // RFC 6749 values kept as belts for other deployments.
    expect(classifyTokenEndpointError({ response: { data: { error: 'invalid_client' } } })).toBe(
      'invalid-client'
    );
    expect(classifyTokenEndpointError({ response: { data: { error: 'invalid_grant' } } })).toBe(
      'invalid-grant'
    );
    expect(classifyTokenEndpointError(new Error('network down'))).toBe('unknown');
    expect(classifyTokenEndpointError({ response: { data: { error: 'server_error' } } })).toBe(
      'unknown'
    );
    expect(classifyTokenEndpointError(undefined)).toBe('unknown');
  });

  it('probe sends only grant_type / client_id / a dummy refresh token', async () => {
    const calls: Array<{ url: string; form: string; headers: Record<string, string> }> = [];
    const result = await probeClientCredentials({
      clientId: 'cid',
      post: async (url, form, headers) => {
        calls.push({ url, form, headers });
        return { data: { error: 'invalid_grant' } };
      },
    });

    expect(result).toBe('ok');
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0].form);
    expect([...form.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
    // The probe must never carry a real (single-use) refresh token.
    expect(form.get('refresh_token')).toBe(PROBE_REFRESH_TOKEN);
    expect(calls[0].url).toBe(TESLA_TOKEN_URL);
    expect(calls[0].headers).toEqual(TOKEN_FORM_HEADERS);
  });

  it('maps the observed Tesla token-endpoint payloads (live probes 2026-10-24)', async () => {
    const verdict = (data: unknown) =>
      probeClientCredentials({ clientId: 'cid', post: async () => ({ data }) });
    // Dead client: HTTP 400, verbatim response body.
    expect(
      await verdict({
        error: 'client_not_found',
        error_description: 'The specified client was not found.',
      })
    ).toBe('invalid');
    // Live client + dummy refresh: HTTP 401, verbatim response body.
    expect(
      await verdict({
        error: 'login_required',
        error_description: 'The refresh_token is invalid',
      })
    ).toBe('ok');
    // RFC 6749 values kept as belts.
    expect(await verdict({ error: 'invalid_client' })).toBe('invalid');
    expect(await verdict({ error: 'invalid_grant' })).toBe('ok');
  });

  it('reports unknown (never blocks) on network failure or unexpected bodies', async () => {
    const failing = await probeClientCredentials({
      clientId: 'cid',
      post: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(failing).toBe('unknown');
    expect(await probeClientCredentials({ clientId: 'cid', post: async () => ({}) })).toBe('unknown');
    expect(
      await probeClientCredentials({ clientId: 'cid', post: async () => ({ data: {} }) })
    ).toBe('unknown');
  });

  it('honors the tokenUrl override (hermetic tests / endpoint changes)', async () => {
    let seen = '';
    await probeClientCredentials({
      clientId: 'cid',
      tokenUrl: 'http://localhost:1/token',
      post: async (url) => {
        seen = url;
        return { data: {} };
      },
    });
    expect(seen).toBe('http://localhost:1/token');
  });
});

describe('describeAxiosHttpError', () => {
  it('surfaces status and body through the describeTeslaError funnel', () => {
    const error = {
      response: {
        status: 422,
        data: { error: 'validation_error', description: 'Allowed Origins must include the origin' },
      },
    };
    const line = describeAxiosHttpError(error);
    expect(line).toContain('HTTP 422');
    expect(line).toContain('validation_error: Allowed Origins must include the origin');
    expect(line).toContain('Allowed Origins'); // the 422 advice from the funnel
  });

  it('passes a string body through intact', () => {
    const line = describeAxiosHttpError({ response: { status: 500, data: 'boom {not json}' } });
    expect(line).toContain('HTTP 500');
    expect(line).toContain('boom');
  });

  it('falls back to the plain message without a response', () => {
    expect(describeAxiosHttpError(new Error('socket hang up'))).toBe('socket hang up');
    expect(describeAxiosHttpError('weird')).toBe('weird');
  });
});

describe('rateLimitedRetrySeconds', () => {
  const limited = (over: { status?: number; data?: unknown; headers?: Record<string, unknown> }) => ({
    response: { status: 429, data: undefined, headers: {}, ...over },
  });

  it('prefers the retry-after header when present', () => {
    expect(rateLimitedRetrySeconds(limited({ headers: { 'retry-after': '7' } }))).toBe(7);
    // Fractional seconds round up; zero is a floor of one.
    expect(rateLimitedRetrySeconds(limited({ headers: { 'retry-after': '0.5' } }))).toBe(1);
    expect(rateLimitedRetrySeconds(limited({ headers: { 'retry-after': '0' } }))).toBe(1);
    // Broken telemetry (huge or garbage) clamps instead of sleeping for a year.
    expect(rateLimitedRetrySeconds(limited({ headers: { 'retry-after': '99999' } }))).toBe(
      RATE_LIMIT_MAX_SLEEP_SEC
    );
    expect(rateLimitedRetrySeconds(limited({ headers: { 'retry-after': 'soon' } }))).toBe(15);
  });

  it('parses the plain-text body Tesla actually sends', () => {
    expect(rateLimitedRetrySeconds(limited({ data: 'Retry in 12 seconds' }))).toBe(12);
    expect(
      rateLimitedRetrySeconds(
        limited({ data: { error: 'too_many_requests', description: 'Retry in 30 seconds' } })
      )
    ).toBe(30);
  });

  it('falls back (never hammers) on an unparseable 429', () => {
    expect(rateLimitedRetrySeconds(limited({ data: { error: 'slow_down' } }))).toBe(
      RATE_LIMIT_FALLBACK_SEC
    );
    expect(rateLimitedRetrySeconds(limited({ data: undefined }))).toBe(RATE_LIMIT_FALLBACK_SEC);
  });

  it('returns null for everything that is not a 429', () => {
    expect(rateLimitedRetrySeconds(new Error('nope'))).toBeNull();
    expect(
      rateLimitedRetrySeconds({ response: { status: 500, data: 'Retry in 12 seconds' } })
    ).toBeNull();
    expect(
      rateLimitedRetrySeconds({ response: { status: 400, data: 'client_not_found' } })
    ).toBeNull();
  });

  it('follows one cause hop: the Fleet interceptor re-wraps axios errors', () => {
    const wrapped = new Error('HTTP 429: Retry in 12 seconds - Tesla rate limit', {
      cause: limited({ data: 'Retry in 12 seconds' }),
    });
    expect(rateLimitedRetrySeconds(wrapped)).toBe(12);
    // ...and a wrapped non-429 stays null even when its message mentions 429.
    expect(rateLimitedRetrySeconds(new Error('HTTP 429: Retry in 12 seconds'))).toBeNull();
  });
});

