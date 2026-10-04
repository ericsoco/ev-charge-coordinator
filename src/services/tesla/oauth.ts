/**
 * Tesla Fleet API OAuth wire format.
 *
 * Everything here is pure (no network, no storage) so the request shapes can be
 * unit tested without touching Tesla. Every parameter list below was checked
 * against developer.tesla.com's Partner Tokens and Third-Party Tokens pages.
 *
 * Findings that contradict the pre-existing implementation in this repo:
 *  - Token endpoints take application/x-www-form-urlencoded bodies, NOT JSON.
 *    The docs warn explicitly: "DO NOT use JSON encoded string as payload."
 *  - `audience` is required on the authorization_code and client_credentials
 *    exchanges; it selects the Fleet API deployment the token is minted for.
 *  - `refresh_token` grants take only grant_type, client_id and refresh_token.
 *    They take NO client_secret, so sending one is at best noise.
 *  - Refresh returns a NEW refresh_token every time; callers must persist it.
 *  - PKCE is NOT part of Tesla's documented parameter list for either the
 *    authorize URL or the token endpoint. See buildAuthorizeUrl for why the
 *    extra parameters are opt-in rather than always sent.
 */

import { randomBytes, createHash } from 'node:crypto';
import { TESLA_AUTHORIZE_URL } from './endpoints.js';

/** RFC 7636 4.1: 43..128 characters from the unreserved set. */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface OAuthRandomSource {
  (size: number): Buffer;
}

/**
 * Generate a PKCE verifier/challenge pair. `random` is injectable so tests can
 * assert the derivation deterministically; it defaults to crypto.randomBytes.
 */
export function createPkcePair(random: OAuthRandomSource = randomBytes): PkcePair {
  // 32 random bytes -> 43 base64url characters, the minimum verifier length.
  const codeVerifier = random(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** Opaque per-request value, checked on return to the redirect URI. */
export function createOAuthState(random: OAuthRandomSource = randomBytes): string {
  return random(32).toString('base64url');
}

/** ID token replay-prevention value documented on the authorize endpoint. */
export function createNonce(random: OAuthRandomSource = randomBytes): string {
  return random(16).toString('base64url');
}

export function isValidPkceVerifier(verifier: string | undefined): verifier is string {
  return typeof verifier === 'string' && PKCE_VERIFIER_RE.test(verifier);
}


export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  /**
   * Send code_challenge / code_challenge_method. Tesla's documented authorize
   * parameters are client_id, state, response_type, redirect_uri, scope, nonce,
   * prompt_missing_scopes and show_keypair_step -- PKCE is absent from that list.
   * This is a confidential client that authenticates the exchange with
   * client_secret, so PKCE adds little, and sending an unrecognised parameter to
   * an OAuth endpoint is a reasonable way to fail the whole flow. It is therefore
   * off unless the operator opts in, at which point the matching verifier is
   * sent on the token exchange.
   */
  pkce?: PkcePair;
  /**
   * Tell the user a second (virtual key pairing) step will follow. Documented as
   * `show_keypair_step`; the CLI sets it when the user is about to pair.
   */
  showKeypairStep?: boolean;
  /** Re-prompt for any scope the user has not yet granted. */
  promptMissingScopes?: boolean;
  authorizeUrl?: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(options.authorizeUrl ?? TESLA_AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('state', options.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scope);
  url.searchParams.set('nonce', options.nonce);
  if (options.promptMissingScopes) {
    url.searchParams.set('prompt_missing_scopes', 'true');
  }
  if (options.showKeypairStep) {
    url.searchParams.set('show_keypair_step', 'true');
  }
  if (options.pkce) {
    url.searchParams.set('code_challenge', options.pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', options.pkce.codeChallengeMethod);
  }
  // Render spaces as %20 instead of the '+' URLSearchParams produces. Tesla's own
  // examples use %20, and a literal '+' is a plausible way to be handed back a
  // single-scope token. Nothing else in this URL can contain a '+': client_id,
  // state and nonce are opaque ASCII/base64url values.
  return url.toString().replace(/\+/g, '%20');
}

/** Headers shared by every token exchange. */
export const TOKEN_FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
} as const;

export function buildClientCredentialsTokenForm(options: {
  clientId: string;
  clientSecret: string;
  audience: string;
  /**
   * Optional because not every caller needs one. Tesla's Partner Tokens page
   * sends `scope` on this grant, and the partner-token flow is what registers
   * the application domain, so VirtualKeyService passes its scope set; it stays
   * optional here so a caller can request a bare application-level token.
   */
  scope?: string;
}): URLSearchParams {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', options.clientId);
  form.set('client_secret', options.clientSecret);
  form.set('audience', options.audience);
  if (options.scope !== undefined) {
    form.set('scope', options.scope);
  }
  return form;
}

export function buildAuthorizationCodeTokenForm(options: {
  clientId: string;
  clientSecret: string;
  audience: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
}): URLSearchParams {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', options.clientId);
  form.set('client_secret', options.clientSecret);
  form.set('audience', options.audience);
  // Docs note: this must equal the authorize redirect URI exactly, or Tesla
  // answers 400 invalid_redirect_url.
  form.set('redirect_uri', options.redirectUri);
  form.set('code', options.code);
  if (options.codeVerifier !== undefined) {
    form.set('code_verifier', options.codeVerifier);
  }
  return form;
}

export function buildRefreshTokenForm(options: {
  clientId: string;
  refreshToken: string;
}): URLSearchParams {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', options.clientId);
  // Deliberately no client_secret and no audience: neither is documented for this
  // grant, and the refresh token is already bound to the original audience.
  form.set('refresh_token', options.refreshToken);
  return form;
}

/** Raw token response as Tesla returns it (snake_case, seconds-based expiry). */
export interface TeslaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Patterns for credentials that must never reach a terminal, a log, or a pasted
 * bug report. Tesla's client secrets are `ta-secret.<base64ish>` and its access
 * and refresh tokens are long JWT/opaque strings, so they are matched by shape
 * rather than by exact value.
 *
 * `describeTeslaError` is the single funnel for every message the CLI shows, so
 * redacting there covers all of them at once.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Tesla client secret, e.g. ta-secret.EXAMPLEonlyAAaa11
  /ta-secret\.[A-Za-z0-9+/=_-]{4,}/g,
  // A JWT access token (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Tesla refresh tokens: NA_a90869e9d... / NA_8f1c...
  /\bNA_[A-Za-z0-9_-]{8,}\b/g,
];

/**
 * Replace anything credential-shaped with a short marker.
 *
 * Error strings are frequently pasted into issues and chat, and a single leaked
 * secret in a transcript has to be treated as compromised. This makes that less
 * likely; it cannot make it impossible, since a user can always paste by hand.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

export interface TokenSet {
  accessToken: string;
  /** Absent only for grants that cannot produce one (see requireRefreshToken). */
  refreshToken: string;
  /** Absolute unix time in milliseconds, the format the credential store uses. */
  expiresAt: number;
}

export interface ParseTokenOptions {
  /**
   * Whether a refresh_token is mandatory.
   *
   * True for the authorization_code and refresh_token grants, where Tesla issues
   * one and its absence means the caller forgot the offline_access scope.
   *
   * MUST be false for client_credentials (partner) tokens: the Partner Tokens
   * page documents neither refresh_token nor offline_access for that grant, and
   * such a token is re-minted from client credentials rather than refreshed.
   * Requiring one there rejected valid responses -- see fetchPartnerToken.
   */
  requireRefreshToken?: boolean;
}

/**
 * Convert Tesla's token response into the stored shape.
 *
 * `now` is injectable for deterministic expiry assertions. The 30s safety margin
 * keeps the caller from presenting a token that expires in flight.
 */
export function parseTokenResponse(
  data: TeslaTokenResponse,
  now: number = Date.now(),
  marginMs = 30_000,
  options: ParseTokenOptions = {}
): TokenSet {
  const requireRefreshToken = options.requireRefreshToken ?? true;
  if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Token response did not contain an access_token');
  }
  if (
    requireRefreshToken &&
    (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0)
  ) {
    // Only reachable on the grants that do issue refresh tokens, so naming
    // offline_access here is accurate and actionable.
    throw new Error(
      'Token response did not contain a refresh_token (was the offline_access scope granted?)'
    );
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 0;
  return {
    accessToken: data.access_token,
    // Empty string rather than undefined when not required, so callers that do
    // consume it never see `undefined` and accidentally persist the word.
    refreshToken: data.refresh_token ?? '',
    expiresAt: now + expiresIn * 1000 - marginMs,
  };
}

/**
 * Map the error strings Tesla documents on the token and API endpoints into
 * something actionable, keeping the raw message alongside the advice.
 */
export function describeTeslaError(status: number | undefined, raw: string): string {
  // Control characters are stripped because this string can arrive straight from
  // the browser's redirect query and is then written both to the terminal and into
  // the callback page: ANSI escapes and CR/LF must not survive into either.
  // Secrets are redacted first because this is the one function every CLI error
  // message passes through, and its output is what gets pasted into issues.
  const safeRaw = redactSecrets(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const known: Record<string, string> = {
    // There is no `authenticate` command; any Tesla command triggers the OAuth
    // flow, so naming one here would send the user after a command that does
    // not exist. get-ev-bsoc is the cheapest one that does.
    invalid_auth_code:
      'authorization code already used or expired; run get-ev-bsoc to authorize again',
    invalid_redirect_url:
      'redirect URI mismatch; the URI registered with Tesla must equal the one sent here',
    unsupported_grant_type:
      'unsupported grant_type; use one of client_credentials, refresh_token, authorization_code',
    unauthorized_client: 'client_id and client_secret combination is not recognised',
    // Confirmed live: an unknown client_id comes back as this rather than
    // unauthorized_client, so it needs its own advice.
    client_not_found: 'client_id not found; copy it from developer.tesla.com > your app > Details',
    invalid_client: 'client credentials rejected; check the client_id/secret pair',
    access_denied: 'consent was declined in the browser; run get-ev-bsoc and approve',
    mobile_access_disabled: 'remote access is switched off in the vehicle',
    login_required:
      'Tesla account password reset, this refresh token already consumed, or access revoked; run get-ev-bsoc to sign in again',
  };
  const statusText = status === undefined ? '' : `HTTP ${status}: `;
  for (const [code, advice] of Object.entries(known)) {
    if (safeRaw.includes(code)) return `${statusText}${safeRaw} - ${advice}`;
  }
  if (status === 412) {
    // Observed live: "Account <uuid> must be registered in the current region
    // <base url>". This is the POST /api/1/partner_accounts step, which is
    // separate from granting consent: authorizing the app in the browser does
    // not perform it, and setting an Allowed Origin in the developer console
    // does not either. The region in the message is the one the token was
    // minted for, so it is not necessarily a misconfiguration.
    return (
      `${statusText}${safeRaw} - this app is not registered with Tesla in this region. ` +
      'Run `pair-tesla-key --domain <domain>` to register it. The domain must match an ' +
      'Allowed Origin on developer.tesla.com, and its public key must be hosted first.'
    );
  }
  if (status === 421) return `${statusText}${safeRaw} - wrong region for this account; check the region setting`;
  if (status === 401) return `${statusText}${safeRaw} - token expired or revoked`;
  return `${statusText}${safeRaw}`;
}

