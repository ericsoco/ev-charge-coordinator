/**
 * Tesla Fleet API Service
 *
 * Communicates with Tesla vehicles using the official Fleet API.
 * Handles OAuth2 authentication, token management, and vehicle commands.
 *
 * The OAuth wire format lives in ./tesla/oauth.ts and the hostnames in
 * ./tesla/endpoints.ts; both were derived from the live Tesla Fleet API docs and
 * are unit tested. This file owns orchestration: the local callback server, token
 * persistence, and the vehicle commands.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as http from 'http';
import * as https from 'https';
import type { EVService, EVCredentials, EVStatus, EVVehicleState, VehicleLocation, EVBatteryStats, TeslaTokens } from '../types/ev.js';
import { credentialStore } from '../utils/credentials.js';
import * as paint from '../utils/color.js';
import {
  buildRevokeConsentUrl,
  resolveRegion,
  TESLA_SCOPE_STRING,
  TESLA_TOKEN_URL,
  type TeslaRegionInfo,
} from './tesla/endpoints.js';
import {
  buildAuthorizeUrl,
  buildAuthorizationCodeTokenForm,
  buildRefreshTokenForm,
  classifyTokenEndpointError,
  describeAxiosHttpError as describeAxiosError,
  rateLimitedRetrySeconds,
  createNonce,
  createOAuthState,
  createPkcePair,
  describeTeslaError,
  parseTokenResponse,
  redactSecrets,
  TOKEN_FORM_HEADERS,
  type PkcePair,
} from './tesla/oauth.js';

/** Default loopback port for the OAuth redirect; also register this with Tesla. */
const DEFAULT_CALLBACK_PORT = 8089;

interface TeslaVehicle {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: string;
}

interface TeslaChargeState {
  battery_level: number;
  charge_limit_soc: number;
  charging_state: string;
  charge_rate?: number;
  minutes_to_full_charge?: number;
  battery_range?: number;
  charge_energy_added?: number;
}

interface TeslaVehicleData {
  id: number;
  vin: string;
  display_name: string;
  state: string;
  charge_state: TeslaChargeState;
}

/** Why consent is or is not present. See TeslaService.checkConsent. */
export type ConsentReason = 'ok' | 'not-signed-in' | 'not-authorized' | 'not-registered' | 'unknown';

export interface ConsentState {
  granted: boolean;
  reason: ConsentReason;
  /** One line explaining the result, suitable for printing verbatim. */
  detail: string;
}

/**
 * Read an HTTP status out of an error thrown anywhere in this service.
 *
 * The response interceptor wraps axios failures in a plain Error, so the status
 * is either on that error's `cause` (the axios error) or, when the caller
 * called checkConsent directly, on the axios error itself.
 */
function readStatusFrom(error: unknown): number | undefined {
  const record = error as { status?: unknown; response?: { status?: unknown }; cause?: unknown };
  if (typeof record?.status === 'number') return record.status;
  if (typeof record?.response?.status === 'number') return record.response.status;
  const cause = record?.cause as
    | { status?: unknown; response?: { status?: unknown } }
    | undefined;
  if (typeof cause?.status === 'number') return cause.status;
  if (typeof cause?.response?.status === 'number') return cause.response.status;
  return undefined;
}

/**
 * Reasons a vehicle command reports (Fleet REST `result:false`, or the signed
 * proxy's wrapped `car could not execute command: …`) that mean the requested
 * end state already holds — a no-op, not a failure.
 */
const BENIGN_COMMAND_REASONS = new Set(['requested', 'is_charging', 'not_charging', 'already_set']);

/** Extra guidance for the failure reasons the Fleet docs enumerate. */
function rejectedReasonHint(reason: string): string {
  switch (reason) {
    case 'disconnected':
      return 'the vehicle is not connected to a charger';
    case 'no_power':
      return 'the connected charger provides no power';
    case 'complete':
      return 'charging has already completed';
    case 'already_stopped':
      return 'charging is already stopped';
    default:
      return '';
  }
}

/** Extra guidance when a command was accepted but charging never started. */
function notChargingHint(chargingState: string): string {
  switch (chargingState) {
    case 'Disconnected':
      return 'plug in the vehicle';
    case 'NoPower':
      return 'the connected charger provides no power';
    case 'Complete':
      return 'charging already completed (battery at the charge limit)';
    case 'Stopped':
    case 'Idle':
      return 'check whether the charge limit is at or below the current battery level';
    default:
      return '';
  }
}

/**
 * Fail a vehicle command whose *response body* says it did not happen.
 *
 * HTTP status alone is not evidence of success: tesla-http-proxy reports an
 * action the car refused as **HTTP 200** with an error envelope
 * (`{response:null, error:"car could not execute command: …"}` — the proxy's
 * nominal-error path), and the Fleet REST fallback uses
 * `{response:{result:false, reason:"disconnected"}}`. Both were previously
 * treated as success, so `charge_start` on an unplugged car printed
 * "✓ EV charging started". A response with no evidence of failure is accepted
 * (forward-compatible with envelope variants).
 */
export function assertVehicleCommandAccepted(data: unknown): void {
  const body = data as
    | {
        response?: { result?: unknown; reason?: unknown } | null;
        error?: unknown;
        error_description?: unknown;
      }
    | null
    | undefined;

  const response = body?.response;
  const envelopeReason =
    response && response.result === false
      ? typeof response.reason === 'string' && response.reason
        ? response.reason
        : 'unknown reason'
      : undefined;

  // The proxy can deliver the car's own reason behind this prefix in either
  // envelope (set_charge_limit reports `already_set` when the limit already
  // matches); benign "end state already holds" answers pass through either way.
  const wrapped = (envelopeReason ?? (typeof body?.error === 'string' ? body.error : '')).match(
    /car could not execute command:\s*(.+)$/
  );
  const carReason = wrapped?.[1]?.trim();
  if (carReason && BENIGN_COMMAND_REASONS.has(carReason)) return;

  if (envelopeReason !== undefined) {
    if (BENIGN_COMMAND_REASONS.has(envelopeReason)) return; // end state already holds
    // Hint on the car's own reason when the proxy wrapped it, else directly.
    const hint = rejectedReasonHint(carReason ?? envelopeReason);
    throw new Error(`Vehicle rejected the command: ${envelopeReason}${hint ? ` (${hint})` : ''}`);
  }

  if (typeof body?.error === 'string' && body.error.length > 0) {
    const detail =
      typeof body.error_description === 'string' && body.error_description
        ? ` (${body.error_description})`
        : '';
    const hint = carReason ? rejectedReasonHint(carReason) : '';
    throw new Error(
      `Vehicle rejected the command: ${body.error}${hint ? ` (${hint})` : ''}${detail}`
    );
  }
}

export interface TeslaServiceConfig {
  /** Tesla deployment region; selects the API base URL and token audience. */
  region?: string;
  /** Loopback port the OAuth redirect listener binds to. */
  callbackPort?: number;
  /**
   * Attach PKCE to the authorize URL and send the verifier on the exchange.
   * Enabled by default, but Tesla's documented parameter lists for /authorize and
   * /token do not include PKCE, so ECC_TESLA_PKCE=0 restores the strictly
   * documented request shape without a code change if the live flow ever rejects
   * the extra parameters.
   */
  pkce?: boolean;
  /**
   * How long startCharging/stopCharging poll `charge_state` to confirm the
   * vehicle actually reached the requested state, and the poll interval.
   * Overridable so tests do not sleep for real seconds.
   */
  chargingConfirm?: { windowMs?: number; intervalMs?: number };
  /**
   * Resolve the local signed-command proxy (tesla-http-proxy) before sending a
   * vehicle command. Production passes the TeslaCommandProxy starter, so a
   * one-shot command lazy-spawns the sidecar; absent (tests), commands go out
   * on the plain Fleet client exactly as before.
   */
  commandProxy?: () => Promise<TeslaCommandProxyRoute | null>;
}

/** Where the signed-command sidecar listens and the PEM that signs its TLS. */
export interface TeslaCommandProxyRoute {
  port: number;
  caPem: string;
}

/** Wake budget: honest-failure ceiling for wakeUp (matches the charge path's ~3 min). */
const WAKE_WALL_BUDGET_MS = 180_000;
/** Bounded wake cycles (each = wake POST + light state poll); rate-limit waits do not count. */
const WAKE_MAX_CYCLES = 10;
/** Pause between wake cycles while the car is not yet online. */
const WAKE_POLL_MS = 2_000;

export class TeslaService implements EVService {
  private client: AxiosInstance;
  private authenticated = false;
  private tokens: TeslaTokens | null = null;
  private clientId: string = '';
  private clientSecret: string = '';
  private vin: string = '';
  private regionInfo: TeslaRegionInfo;
  private readonly callbackPort: number;
  private readonly pkceEnabled: boolean;
  private readonly commandProxy?: TeslaServiceConfig['commandProxy'];
  /** Poll window/interval for charging-state confirmation; see chargingConfirm. */
  private readonly confirmWindowMs: number;
  private readonly confirmIntervalMs: number;
  /** Cached signed-command client, keyed by the proxy port it targets. */
  private commandRoute: { port: number; client: AxiosInstance } | null = null;
  /** Single-use values held only for the duration of one authorize round trip. */
  private pendingNonce?: string;
  private pendingPkce?: PkcePair;
  /** Set when authenticate() could not list vehicles because registration is pending. */
  private registrationRequired = false;
  /** Set when the last authenticate() resolved and persisted a VIN. */
  private vinResolved = false;

  constructor(config: TeslaServiceConfig = {}) {
    this.regionInfo = resolveRegion(config.region);
    this.callbackPort = config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.pkceEnabled = config.pkce ?? process.env.ECC_TESLA_PKCE !== '0';
    this.commandProxy = config.commandProxy;
    this.confirmWindowMs = config.chargingConfirm?.windowMs ?? 12_000;
    this.confirmIntervalMs = config.chargingConfirm?.intervalMs ?? 3_000;
    this.client = this.createClient(this.regionInfo.apiBaseUrl);
  }

  /**
   * A Fleet-API-shaped client carrying the full interceptor chain (auth,
   * refresh, error wrapping). The main client targets the region host; a
   * vehicle-command call targets the local signed-command proxy instead,
   * which serves identical REST paths and needs the same behavior.
   */
  private createClient(baseURL: string, httpsAgent?: https.Agent): AxiosInstance {
    const client = axios.create({
      baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      },
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    // Add request interceptor to include auth token
    client.interceptors.request.use(async (config) => {
      if (this.tokens?.accessToken) {
        // Check if token is expired
        if (this.tokens.expiresAt && Date.now() >= this.tokens.expiresAt - 60000) {
          await this.refreshTokens();
        }
        config.headers.Authorization = `Bearer ${this.tokens.accessToken}`;
      }
      return config;
    });

    // Add response interceptor for token refresh on 401
    client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as (typeof error.config & { _eccRetried?: boolean }) | undefined;
        // The retry is guarded because Tesla refresh tokens are single-use: an
        // unguarded retry loop on a token Tesla keeps rejecting would burn every
        // refresh token in turn and force a full re-pair.
        if (error.response?.status === 401 && this.tokens?.refreshToken && !config?._eccRetried) {
          try {
            await this.refreshTokens();
            // Retry the request
            if (config) {
              config._eccRetried = true;
              config.headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
              // Retried on the same client it was issued from, so a proxy
              // command 401 retries against the proxy, never the Fleet host.
              return client.request(config);
            }
          } catch (refreshError) {
            // Refresh failed, will need to re-authenticate. The reason is logged
            // because the caller only ever sees the original 401 otherwise, and
            // "your refresh token was burned" and "wrong region" look identical.
            this.authenticated = false;
            console.error(paint.error(`Token refresh failed: ${describeAxiosError(refreshError)}`));
          }
        }
        // Every vehicle/command call fails through here, so this is where a Fleet
        // API failure (412 not-registered, 421 wrong-region) becomes one readable
        // line instead of a raw AxiosError. Without it the mapper was only reached
        // from the refresh and token-exchange paths, so a 412 raised by an ordinary
        // vehicle_data read reached the user as Tesla's bare sentence with no
        // advice attached. The original is kept as `cause`, so the response body
        // and stack stay available for debugging.
        throw axios.isAxiosError(error)
          ? new Error(describeAxiosError(error), { cause: error })
          : error;
      }
    );
    return client;
  }

  /** The resolved region name, e.g. "na". */
  get region(): string {
    return this.regionInfo.region;
  }

  /** The Fleet API base URL in use, which is also the token audience. */
  get apiBaseUrl(): string {
    return this.regionInfo.apiBaseUrl;
  }

  /** The OAuth redirect URI; must match the one registered on developer.tesla.com. */
  get redirectUri(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  /** URL a user visits to withdraw this application's access. */
  getRevokeConsentUrl(): string {
    return buildRevokeConsentUrl();
  }

  getName(): string {
    return 'Tesla Fleet API';
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Generate OAuth2 authorization URL.
   *
   * `nonce` is documented by Tesla and is what makes the returned ID token
   * replay-resistant; `show_keypair_step` warns the user that a virtual key
   * pairing follows. PKCE parameters are appended only when enabled.
   */
  private generateAuthUrl(state: string, options: { showKeypairStep?: boolean } = {}): string {
    return buildAuthorizeUrl({
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      scope: TESLA_SCOPE_STRING,
      state,
      nonce: this.pendingNonce ?? createNonce(),
      pkce: this.pendingPkce,
      showKeypairStep: options.showKeypairStep,
      promptMissingScopes: true,
    });
  }

  /**
   * Exchange authorization code for tokens.
   *
   * Three corrections over the previous version: the token endpoint is on
   * fleet-auth.prd.vn.cloud.tesla.com rather than auth.tesla.com, the body is
   * application/x-www-form-urlencoded rather than JSON (the docs say "DO NOT use
   * JSON encoded string as payload"), and `audience` is supplied because it is
   * what selects the Fleet API deployment the token is minted for.
   */
  private async exchangeCode(code: string): Promise<TeslaTokens> {
    const form = buildAuthorizationCodeTokenForm({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      audience: this.regionInfo.apiBaseUrl,
      redirectUri: this.redirectUri,
      code,
      codeVerifier: this.pendingPkce?.codeVerifier,
    });

    const response = await axios.post(TESLA_TOKEN_URL, form, {
      headers: TOKEN_FORM_HEADERS,
    });

    return toTeslaTokens(parseTokenResponse(response.data));
  }

  /**
   * Refresh the access token using refresh token.
   *
   * Form-encoded, and sends only grant_type / client_id / refresh_token: Tesla
   * documents no client_secret for this grant. Tesla rotates the refresh token on
   * every call and the old one becomes unusable, so the new pair is persisted
   * immediately -- losing it forces a full re-pair.
   */
  private async refreshTokens(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const form = buildRefreshTokenForm({
      clientId: this.clientId,
      refreshToken: this.tokens.refreshToken,
    });

    let response;
    try {
      response = await axios.post(TESLA_TOKEN_URL, form, {
        headers: TOKEN_FORM_HEADERS,
      });
    } catch (error) {
      // Two ways this grant dies, with opposite remedies: a recreated/rotated
      // app (invalid_client — new client credentials needed) vs a dead
      // refresh token (invalid_grant — just re-authenticate). Same error
      // field the CLI's client-credential probe reads.
      const kind = classifyTokenEndpointError(error);
      if (kind === 'invalid-client') {
        throw new Error(
          'Tesla no longer recognizes this application (client ID/secret invalid - app recreated or rotated?). Run `authenticate --reauth` and enter the new client credentials.',
          { cause: error }
        );
      }
      if (kind === 'invalid-grant') {
        throw new Error(
          'Tesla rejected the refresh token (expired or revoked). Re-run `authenticate`.',
          { cause: error }
        );
      }
      throw error;
    }

    // Same parse path as the code exchange, so the 30s expiry margin and the
    // access_token presence check are not silently reimplemented here. Tesla
    // returns a new refresh token on every call; if one is ever omitted, keep the
    // current one, which stays valid for ~24h after rotation.
    this.tokens = toTeslaTokens(
      parseTokenResponse({
        ...response.data,
        refresh_token: response.data?.refresh_token ?? this.tokens.refreshToken,
      })
    );

    // Save updated tokens
    await credentialStore.updateTeslaTokens(
      this.tokens.accessToken,
      this.tokens.refreshToken,
      this.tokens.expiresAt
    );
  }

  /**
   * Start local OAuth callback server and wait for authorization.
   */
  private async waitForOAuthCallback(
    state: string,
    onAuthUrl: (url: string) => void,
    options: { showKeypairStep?: boolean } = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // The timeout is cleared on every exit path: an uncancelled 5-minute timer
      // keeps the Node event loop alive, so a successful login still left the CLI
      // hanging around for five minutes afterwards. Both `timeout` and `server`
      // are referenced from these closures before their declarations below, which
      // is safe because the handlers only ever run after this block completes.
      const stop = (): void => {
        clearTimeout(timeout);
        server.close();
      };
      const server = http.createServer((req, res) => {
        // WHATWG URL with a throwaway base rather than the deprecated url.parse():
        // the request target is attacker-controlled input, and url.parse's
        // leniency about exactly that has had CVEs filed against it.
        const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

        if (parsedUrl.pathname === '/callback') {
          const code = parsedUrl.searchParams.get('code') ?? undefined;
          const returnedState = parsedUrl.searchParams.get('state') ?? undefined;
          const error = parsedUrl.searchParams.get('error') ?? undefined;

          if (error) {
            // Mapped so "access_denied" reads as "you declined consent" rather than
            // the bare token Tesla returned, and escaped into the page because part
            // of that text originated in the browser's redirect query.
            const reason = describeTeslaError(undefined, error);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(errorPage(reason));
            stop();
            reject(new Error(`OAuth error: ${reason}`));
            return;
          }

          if (!code) {
            // Without a code the exchange would fail later as an opaque
            // invalid_auth_code; say what actually arrived.
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(errorPage('The callback returned no authorization code.'));
            stop();
            reject(new Error('OAuth callback returned no authorization code'));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Invalid State</h1></body></html>');
            stop();
            reject(new Error('OAuth state mismatch - possible CSRF, run authentication again'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; text-align: center; padding: 50px;">
                <h1>✓ Authorization Successful</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          
          stop();
          resolve(code);
        }
      });

      server.listen(this.callbackPort, '127.0.0.1', () => {
        const authUrl = this.generateAuthUrl(state, options);
        onAuthUrl(authUrl);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `Port ${this.callbackPort} is already in use; close the other process or set a different callbackPort`
              : `Failed to start OAuth server: ${err.message}`
          )
        );
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('OAuth timeout - authorization not completed within 5 minutes'));
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Initialize with stored credentials or prompt for new auth.
   */
  async initialize(credentials: EVCredentials): Promise<void> {
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;

    if (credentials.region) {
      this.regionInfo = resolveRegion(credentials.region);
      this.client.defaults.baseURL = this.regionInfo.apiBaseUrl;
    }

    if (credentials.accessToken && credentials.refreshToken) {
      // Use provided tokens. The real stored expiry is honoured rather than a
      // fabricated hour: pretending a token minted days ago is fresh makes the
      // first request after every restart a guaranteed 401 round trip.
      const expiresAt = credentials.expiresAt ?? Date.now() + 3600000;
      this.tokens = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresIn: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
        expiresAt
      };
      this.authenticated = true;

      if (credentials.vin) {
        this.vin = credentials.vin;
      }
    }
  }

  /**
   * Perform interactive OAuth authentication.
   *
   * Resolves true when a VIN was also resolved, false when authentication
   * succeeded but listing vehicles did not (the app is not registered with
   * Tesla yet -- see needsRegistration). The tokens are stored and valid in both
   * cases; only the VIN is missing.
   */
  async authenticate(
    onAuthUrl: (url: string) => void,
    options: { showKeypairStep?: boolean } = {}
  ): Promise<boolean> {
    const state = createOAuthState();
    this.pendingNonce = createNonce();
    this.pendingPkce = this.pkceEnabled ? createPkcePair() : undefined;

    // `state` is a fresh 32-byte value rather than Math.random(): it is the only
    // thing binding the browser callback to this process, and Math.random is
    // neither cryptographically secure nor unguessable.
    let code: string;
    try {
      code = await this.waitForOAuthCallback(state, onAuthUrl, options);
    } finally {
      // Single-use values; do not leave them reachable after the exchange.
      this.pendingNonce = undefined;
      this.pendingPkce = undefined;
    }
    try {
      this.tokens = await this.exchangeCode(code);
    } catch (error) {
      // Re-thrown as one readable line: the CLI's catch-all otherwise prints a
      // whole AxiosError for what Tesla reports as a plain client_not_found.
      throw new Error(`Token exchange failed: ${describeAxiosError(error)}`, { cause: error });
    }
    this.authenticated = true;

    // setTeslaCredentials merges, so the stored client_id/client_secret survive.
    await credentialStore.setTeslaCredentials({
      accessToken: this.tokens.accessToken,
      refreshToken: this.tokens.refreshToken,
      expiresAt: this.tokens.expiresAt,
      region: this.regionInfo.region
    });

    // Resolve and persist a VIN; commands previously used an unset value.
    //
    // A VIN is a convenience here, not part of authentication, so a failure to
    // list vehicles must not discard tokens that were just issued and stored.
    // The common case is HTTP 412: this app is not yet registered with Tesla,
    // which pair-tesla-key fixes and which no retry can resolve. Propagating it
    // is what previously turned a successful login into a failure, leaving the
    // user with credentials that had never been stored.
    //
    // Returns whether a VIN was resolved, so the caller can report a partial
    // success honestly instead of claiming a full login.
    this.vinResolved = false;
    try {
      await this.resolveVin();
      this.vinResolved = true;
      return true;
    } catch (error) {
      const status = (error as { cause?: { response?: { status?: number } } })?.cause?.response
        ?.status;
      if (status === 412) {
        // Tokens are stored above and stay valid; only the vehicle lookup was
        // blocked. Flag it and return so the caller can direct the user to
        // registration rather than reporting a failed login.
        this.registrationRequired = true;
        return false;
      }
      throw error;
    }
  }

  /**
   * True when the last authenticate() could not list vehicles because this app
   * is not registered with Tesla yet. The tokens are valid either way.
   */
  get needsRegistration(): boolean {
    return this.registrationRequired;
  }

  /** True when the last authenticate() resolved and stored a VIN. */
  get hasVin(): boolean {
    return this.vinResolved;
  }

  /**
   * Pick the vehicle to operate on and persist its VIN, so the charge commands
   * work without a hand-edited config.
   */
  private async resolveVin(): Promise<string | undefined> {
    if (this.vin) return this.vin;
    const vehicles = await this.listVehicles();
    const vin = vehicles[0]?.vin;
    if (!vin) {
      throw new Error('No vehicles are associated with this Tesla account');
    }
    this.vin = vin;
    await credentialStore.setTeslaVin(vin);
    return vin;
  }

  async listVehicles(): Promise<Array<{ vin: string; displayName: string }>> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with Tesla');
    }

    const response = await this.client.get<{ response: TeslaVehicle[] }>('/api/1/vehicles');
    return response.data.response.map(v => ({
      vin: v.vin,
      displayName: v.display_name
    }));
  }

  setVin(vin: string): void {
    this.vin = vin;
  }

  /**
   * Whether the user has granted this application access to their Tesla account.
   *
   * This is a separate gate from registering the application with Tesla
   * (POST /api/1/partner_accounts) and from the virtual key itself. Pairing via
   * the tesla.com/_ak/ deep link requires that the user has already authorized
   * the application and granted the vehicle_device_data, vehicle_cmds or
   * vehicle_location scopes -- Tesla's Virtual Key developer guide states this
   * explicitly -- and Tesla's own error when it is missing is "Adding a virtual
   * key for <domain> is forbidden because you have not granted <domain> access to
   * your account".
   *
   * A cheap GET /api/1/vehicles distinguishes the cases by status code:
   *   200 -> consent present (and registered, since 412 would otherwise apply)
   *   401 -> tokens rejected: no consent, revoked, or a stale refresh token
   *   412 -> consent may be fine, but the app is not registered in this region
   *
   * Anything else (DNS failure, TLS error) is reported as unknown rather than
   * being folded into "no consent", so a network problem is never mistaken for
   * a permissions problem.
   */
  async checkConsent(): Promise<ConsentState> {
    if (!this.authenticated || !this.tokens?.accessToken) {
      return {
        granted: false,
        reason: 'not-signed-in',
        detail: 'No stored Tesla tokens; the user has never authorized this app.',
      };
    }
    try {
      await this.client.get('/api/1/vehicles');
      return {
        granted: true,
        reason: 'ok',
        detail: 'The user has granted this app access to their account.',
      };
    } catch (error) {
      const status = readStatusFrom(error);
      if (status === 401) {
        return {
          granted: false,
          reason: 'not-authorized',
          detail:
            'The stored token was rejected (401). Consent is missing, revoked, or the ' +
            'refresh token is stale; re-run a Tesla command and approve in the browser.',
        };
      }
      if (status === 412) {
        return {
          granted: false,
          reason: 'not-registered',
          detail:
            'The app is not registered in this region yet, so consent cannot be ' +
            'confirmed. Complete registration first.',
        };
      }
      return {
        granted: false,
        reason: 'unknown',
        detail: `Could not determine consent: ${(error as Error)?.message ?? error}`,
      };
    }
  }

  /**
   * Wake the car and wait honestly for it to come online.
   *
   * Rate limits are honored, not hammered: a 429 sleeps exactly as long as
   * Tesla asked (retry-after header or the "Retry in N seconds" body) WITHOUT
   * consuming a wake cycle — the pre-rework loop waited a flat 2 s and
   * re-fired, turning one command into ~10 rejected POSTs. Confirmation polls
   * the light state probe: this loop only reads `state`, and the full
   * vehicle_data read it used to pull is the heaviest call Tesla offers. A
   * car that never comes online now FAILS (the old loop resolved silently).
   */
  async wakeUp(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    const deadlineMs = Date.now() + WAKE_WALL_BUDGET_MS;
    const budgetLabel = `${Math.round(WAKE_WALL_BUDGET_MS / 60_000)}-minute wake budget`;
    let lastError: unknown = null;
    let cycle = 0;

    while (cycle < WAKE_MAX_CYCLES) {
      try {
        await this.client.post(`/api/1/vehicles/${this.vin}/wake_up`);
        const vehicle = await this.getVehicleState();
        if (vehicle.state === 'online') return;
      } catch (error) {
        const retrySec = rateLimitedRetrySeconds(error);
        if (retrySec !== null) {
          const waitMs = retrySec * 1000;
          if (Date.now() + waitMs >= deadlineMs) {
            throw new Error(
              `Rate-limited for longer than the ${budgetLabel}; wait a minute and re-run.`,
              { cause: error }
            );
          }
          console.log(
            paint.info(`  Rate limited by Tesla; waiting ${retrySec}s before retrying the wake`)
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue; // the rate limit did not burn a wake cycle
        }
        lastError = error;
      }

      cycle += 1;
      if (cycle >= WAKE_MAX_CYCLES) break;
      if (Date.now() + WAKE_POLL_MS >= deadlineMs) {
        throw new Error(`Vehicle did not come online within the ${budgetLabel}.`, {
          cause: lastError,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    }

    if (lastError !== null) throw lastError;
    throw new Error(`Vehicle did not come online after ${WAKE_MAX_CYCLES} wake attempts`);
  }

  /**
   * Connectivity probe via GET /api/1/vehicles/{vin}. Tesla answers with the
   * vehicle's state without waking it or waiting on it, so unlike
   * vehicle_data this cannot 408 — the daemon's poll-while-awake loop gates
   * its expensive read on this result.
   */
  async getVehicleState(): Promise<EVVehicleState> {
    if (!this.vin) {
      await this.resolveVin();
    }
    const response = await this.client.get<{ response: { state: string } }>(
      `/api/1/vehicles/${this.vin}`
    );
    return { state: response.data.response.state };
  }

  /**
   * Position via `vehicle_data?endpoints=location_data`.
   *
   * `location_data` is the selector that gates latitude/longitude — confirmed
   * live 2026-10-24 against this account: `drive_state` alone returns only
   * power/shift_state/speed/timestamp, while `location_data` restores the full
   * GPS set (community-documented: timdorr/tesla-api#786, fleet-telemetry#460).
   * The fields still land under `drive_state` in the response. Read-only:
   * never wakes.
   */
  async getVehicleLocation(): Promise<VehicleLocation> {
    if (!this.vin) {
      await this.resolveVin();
    }
    const response = await this.client.get<{
      response: { drive_state?: { latitude?: number; longitude?: number } };
    }>(`/api/1/vehicles/${this.vin}/vehicle_data`, {
      params: { endpoints: 'location_data' },
    });
    const driveState = response.data.response.drive_state;
    if (typeof driveState?.latitude !== 'number' || typeof driveState?.longitude !== 'number') {
      throw new Error(
        'Location is not in the vehicle response. The read uses the location_data selector; ' +
          'if it stays empty, the vehicle_location scope may be missing from this ACCOUNT ' +
          'grant (app config is not enough) — revoke the app at accounts.tesla.com ' +
          '(Account Settings > Security > Third-party apps) and re-run `authenticate`.'
      );
    }
    return { latitude: driveState.latitude, longitude: driveState.longitude };
  }

  async getStatus(): Promise<EVStatus> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    const response = await this.client.get<{ response: TeslaVehicleData }>(
      `/api/1/vehicles/${this.vin}/vehicle_data`,
      { params: { endpoints: 'charge_state' } }
    );

    const data = response.data.response;
    const chargeState = data.charge_state;

    const battery: EVBatteryStats = {
      soc: chargeState.battery_level,
      chargeLimit: chargeState.charge_limit_soc,
      isCharging: chargeState.charging_state === 'Charging',
      chargingState: chargeState.charging_state,
      chargeRate: chargeState.charge_rate,
      minutesToFull: chargeState.minutes_to_full_charge,
      batteryRange: chargeState.battery_range,
      chargeEnergyAdded: chargeState.charge_energy_added
    };

    return {
      vin: data.vin,
      displayName: data.display_name,
      state: data.state,
      battery
    };
  }

  async getStateOfCharge(): Promise<number> {
    const status = await this.getStatus();
    return status.battery.soc;
  }

  async getChargeLimit(): Promise<number> {
    const status = await this.getStatus();
    return status.battery.chargeLimit;
  }

  /**
   * Send a vehicle command through the signed-command proxy when one is
   * configured. Tesla's REST command endpoints reject unsigned commands with
   * HTTP 403 ("Vehicle Command Protocol required"); tesla-http-proxy signs
   * them with the enrolled virtual key and forwards to Fleet API. Without a
   * configured resolver (tests), the plain Fleet client is used as before.
   */
  private async postVehicleCommand(endpoint: string, body: object): Promise<void> {
    const client = await this.vehicleCommandClient();
    try {
      const response = await client.post(`/api/1/vehicles/${this.vin}${endpoint}`, body);
      assertVehicleCommandAccepted(response.data);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        throw new Error(
          'Tesla command proxy is not reachable. Run `start`, or check its output ' +
            'for why the proxy is not running.',
          { cause: error }
        );
      }
      throw error;
    }
  }

  /** The client for vehicle commands: the local proxy when configured, else the Fleet client. */
  private async vehicleCommandClient(): Promise<AxiosInstance> {
    if (!this.commandProxy) return this.client;
    const route = await this.commandProxy();
    if (!route) {
      throw new Error(
        'Tesla command proxy unavailable. Vehicle commands need the signed-command ' +
          'sidecar: run `start`, and install tesla-http-proxy if its status line says it is missing.'
      );
    }
    if (this.commandRoute?.port !== route.port) {
      this.commandRoute = {
        port: route.port,
        client: this.createClient(
          `https://127.0.0.1:${route.port}`,
          new https.Agent({ ca: [route.caPem] })
        ),
      };
    }
    return this.commandRoute.client;
  }

  /**
   * Confirm the vehicle reached the requested charging state.
   *
   * "Command accepted" is not "charging happened": the car can accept
   * charge_start while unplugged (and the proxy reports refused actions as
   * HTTP 200 with an error body). Poll `charge_state` — the car is awake from
   * wakeUp() — until the state matches or the window expires, then fail with
   * the observed state and its likely meaning.
   */
  private async confirmChargingState(wantCharging: boolean): Promise<void> {
    const deadline = Date.now() + this.confirmWindowMs;
    let observed = 'unknown';
    for (;;) {
      let status;
      try {
        status = await this.getStatus();
      } catch (error) {
        throw new Error(
          `the vehicle accepted the command but its charging state could not be read: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      observed = status.battery.chargingState || 'unknown';
      if (status.battery.isCharging === wantCharging) return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, this.confirmIntervalMs));
    }

    if (wantCharging) {
      const hint = notChargingHint(observed);
      throw new Error(
        `the vehicle accepted the command but is not charging (state: ${observed})` +
          (hint ? ` - ${hint}` : '')
      );
    }
    throw new Error(
      `the vehicle accepted the command but still reports charging (state: ${observed})`
    );
  }

  async setChargeLimit(percent: number): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    // Validate percent
    if (percent < 50 || percent > 100) {
      throw new Error('Charge limit must be between 50 and 100 percent');
    }

    await this.wakeUp();
    
    await this.postVehicleCommand('/command/set_charge_limit', { percent });
  }

  async startCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.postVehicleCommand('/command/charge_start', {});
    await this.confirmChargingState(true);
  }

  async stopCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.postVehicleCommand('/command/charge_stop', {});
    await this.confirmChargingState(false);
  }

  async disconnect(): Promise<void> {
    this.authenticated = false;
    this.tokens = null;
  }
}

/**
 * The loopback listener's failure page. The message is escaped rather than
 * interpolated because part of it can come straight from the browser's redirect
 * query, and this HTML is rendered in the user's own browser session.
 */
function errorPage(message: string): string {
  // Redacted as well as escaped: this text originates in a browser redirect query
  // and is written back into a page, so it must not be able to surface a token.
  const safe = redactSecrets(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<html><body style="font-family: system-ui; text-align: center; padding: 50px;">
    <h1>Authorization Failed</h1><p>${safe}</p></body></html>`;
}

/**
 * Convert a parsed token response into the shape this service stores, deriving
 * `expiresIn` from the absolute expiry so existing call sites keep working.
 */
function toTeslaTokens(tokenSet: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): TeslaTokens {
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    expiresIn: Math.max(0, Math.round((tokenSet.expiresAt - Date.now()) / 1000)),
    expiresAt: tokenSet.expiresAt
  };
}
