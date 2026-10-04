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
import type { EVService, EVCredentials, EVStatus, EVBatteryStats, TeslaTokens } from '../types/ev.js';
import { credentialStore } from '../utils/credentials.js';
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
}

interface TeslaVehicleData {
  id: number;
  vin: string;
  display_name: string;
  state: string;
  charge_state: TeslaChargeState;
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
}

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

    this.client = axios.create({
      baseURL: this.regionInfo.apiBaseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor to include auth token
    this.client.interceptors.request.use(async (config) => {
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
    this.client.interceptors.response.use(
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
              return this.client.request(config);
            }
          } catch (refreshError) {
            // Refresh failed, will need to re-authenticate. The reason is logged
            // because the caller only ever sees the original 401 otherwise, and
            // "your refresh token was burned" and "wrong region" look identical.
            this.authenticated = false;
            console.error('Token refresh failed:', describeAxiosError(refreshError));
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
    return buildRevokeConsentUrl(this.clientId, this.regionInfo.region);
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

    const response = await axios.post(TESLA_TOKEN_URL, form, {
      headers: TOKEN_FORM_HEADERS,
    });

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

  async wakeUp(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    // Wake up can take a while
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.client.post(`/api/1/vehicles/${this.vin}/wake_up`);
        
        // Check if vehicle is online
        const response = await this.client.get<{ response: TeslaVehicleData }>(
          `/api/1/vehicles/${this.vin}/vehicle_data`
        );
        
        if (response.data.response.state === 'online') {
          return;
        }
      } catch (error) {
        if (i === maxAttempts - 1) throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
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
      batteryRange: chargeState.battery_range
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

  async setChargeLimit(percent: number): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    // Validate percent
    if (percent < 50 || percent > 100) {
      throw new Error('Charge limit must be between 50 and 100 percent');
    }

    await this.wakeUp();
    
    await this.client.post(`/api/1/vehicles/${this.vin}/command/set_charge_limit`, {
      percent
    });
  }

  async startCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.client.post(`/api/1/vehicles/${this.vin}/command/charge_start`);
  }

  async stopCharging(): Promise<void> {
    if (!this.vin) {
      throw new Error('No VIN configured');
    }

    await this.wakeUp();
    await this.client.post(`/api/1/vehicles/${this.vin}/command/charge_stop`);
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
 * Reduce an axios failure to the single line worth showing a user. Tesla reports
 * OAuth failures as `{ error, error_description }` and Fleet API failures as
 * `{ error, response }`, both in the response body, and describeTeslaError turns
 * the documented codes into advice instead of leaving a bare status code.
 */
function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: unknown; error_description?: unknown; description?: unknown }
      | undefined;
    const raw = [data?.error, data?.error_description ?? data?.description]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(': ');
    return describeTeslaError(error.response?.status, raw || error.message);
  }
  return error instanceof Error ? error.message : String(error);
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
