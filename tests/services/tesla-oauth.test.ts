/**
 * Tesla Fleet API OAuth wire format + endpoint resolution.
 *
 * These are the request shapes the CLI sends to Tesla. Everything here is pure, so
 * the assertions pin the exact parameter sets rather than mocking axios: an extra
 * or missing parameter on these endpoints fails the flow server-side with a
 * confusing error, which is precisely what this module exists to prevent.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationCodeTokenForm,
  buildAuthorizeUrl,
  buildClientCredentialsTokenForm,
  buildRefreshTokenForm,
  createNonce,
  createOAuthState,
  createPkcePair,
  describeTeslaError,
  isValidPkceVerifier,
  parseTokenResponse,
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
    expect(describeTeslaError(400, 'invalid_auth_code')).toContain('run authenticate again');
    expect(describeTeslaError(400, 'invalid_redirect_url')).toContain('must equal');
    expect(describeTeslaError(401, 'unauthorized_client')).toContain('client_secret');
    expect(describeTeslaError(401, 'login_required')).toContain('already consumed');
    expect(describeTeslaError(403, 'mobile_access_disabled')).toContain('switched off');
  });

  it('maps the region and registration status codes Tesla only documents in passing', () => {
    expect(describeTeslaError(412, 'Precondition Failed')).toContain('pair-tesla-key');
    expect(describeTeslaError(421, 'Misdirected Request')).toContain('region');
    expect(describeTeslaError(401, 'nope')).toContain('token expired or revoked');
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
    expect(TESLA_SCOPE_STRING).toBe(
      'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds'
    );
  });

  it('builds the consent-manager revoke URL for the selected region', () => {
    expect(buildRevokeConsentUrl('cid', 'eu')).toBe(
      'https://fleet-api.prd.eu.vn.cloud.tesla.com/oauth2/v3/consent?client_id=cid'
    );
  });
});

