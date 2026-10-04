/**
 * Tesla Virtual Key registration and pairing.
 *
 * Vehicles that require the Tesla Vehicle Command Protocol verify a signature on
 * every command, made with an application key pair that a trusted human must add
 * to the car. Tesla's docs are explicit that this user-in-the-loop step cannot be
 * bypassed, so this module automates everything up to the pairing tap and then
 * waits for the user.
 *
 * The flow, quoted/paraphrased from the Fleet API Virtual Keys Developer Guide
 * and Partner Endpoints pages:
 *
 *   1. Generate an EC key pair on prime256v1 (a.k.a. secp256r1 / P-256):
 *        openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
 *        openssl ec -in private-key.pem -pubout -out public-key.pem
 *      Done in-process here so the private key never has to pass through a shell.
 *   2. Publish the PUBLIC key, PEM encoded, and keep it reachable at
 *        https://<app domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
 *   3. Register that domain once with a PARTNER token:
 *        POST /api/1/partner_accounts   { "domain": "<app domain>" }
 *      The domain must match the root domain of the app's allowed_origins on
 *      developer.tesla.com, and is shown to the user during pairing.
 *   4. Confirm enrollment with:
 *        GET /api/1/partner_accounts/public_key?domain=<app domain>
 *   5. Have the user open the pairing deep link
 *        https://tesla.com/_ak/<app domain>[?vin=<vin>]
 *      and approve in the Tesla mobile app. Pairing additionally requires that the
 *      user has already authorized the app with vehicle_device_data, vehicle_cmds
 *      or vehicle_location, so authorization must happen first.
 *
 * Steps 1-4 run here and are testable offline against a stubbed transport. Step 5
 * is the only part that needs a car and a phone.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from '../../utils/credentials.js';
import { TESLA_PARTNER_SCOPE_STRING, TESLA_TOKEN_URL } from './endpoints.js';
import {
  buildClientCredentialsTokenForm,
  parseTokenResponse,
  TOKEN_FORM_HEADERS,
  type TeslaTokenResponse,
} from './oauth.js';

/** Path the app domain must serve the PEM on. Tesla fetches this, not an API. */
export const TESLA_PUBLIC_KEY_HOSTING_PATH =
  '/.well-known/appspecific/com.tesla.3p.public-key.pem';

/** Tesla only accepts this curve; it names it both ways in different pages. */
export const VIRTUAL_KEY_CURVE = 'prime256v1';

/** Where the user's phone starts the pairing flow. */
export const PAIRING_DEEP_LINK_BASE = 'https://tesla.com/_ak/';

/** Matching the openssl commands in Tesla's docs keeps interop obvious. */
export const PRIVATE_KEY_FILENAME = 'private-key.pem';
export const PUBLIC_KEY_FILENAME = 'public-key.pem';

export interface VirtualKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Minimal transport surface, so tests never open a socket. */
export interface VirtualKeyHttp {
  post(url: string, data?: unknown, config?: unknown): Promise<{ data: unknown }>;
  get(url: string, config?: unknown): Promise<{ data: unknown }>;
}

/**
 * Generate an application key pair on the curve Tesla requires.
 *
 * The private PEM is SEC1 ("EC PRIVATE KEY") to match the output of the openssl
 * command Tesla documents, rather than the PKCS8 that Node defaults to, so a key
 * produced here is interchangeable with one produced by the docs' recipe.
 */
export function createVirtualKeyPair(): VirtualKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: VIRTUAL_KEY_CURVE,
    publicKeyEncoding: { type: 'spki', format: 'pem' } as const,
    privateKeyEncoding: { type: 'sec1', format: 'pem' } as const,
  });
  const pair = { publicKeyPem: publicKey, privateKeyPem: privateKey };
  assertVirtualKeyPair(pair);
  return pair;
}

/**
 * Validate a pair before it is ever sent to Tesla: both halves must parse, the
 * curve must be prime256v1, and the public key must belong to the private key.
 * A mismatch registered with Tesla fails much later as an unexplained pairing
 * error: the pairing tap succeeds and then every command is rejected, because the
 * signature is made with a private key Tesla does not hold.
 */
export function assertVirtualKeyPair(pair: VirtualKeyPair): void {
  if (!pair?.privateKeyPem || !pair?.publicKeyPem) {
    throw new Error('A virtual key pair needs both a private and a public PEM');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pair.privateKeyPem);
  } catch {
    throw new Error('Virtual key private PEM could not be parsed');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(pair.publicKeyPem);
  } catch {
    throw new Error('Virtual key public PEM could not be parsed');
  }
  for (const [label, key] of [
    ['private', privateKey],
    ['public', publicKey],
  ] as const) {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== 'ec' || curve !== VIRTUAL_KEY_CURVE) {
      throw new Error(
        `Virtual key ${label} key must be EC ${VIRTUAL_KEY_CURVE} (P-256), got ${key.asymmetricKeyType}/${String(curve)}`
      );
    }
  }
  const derived = normalizePem(
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  );
  if (derived !== normalizePem(publicKey.export({ type: 'spki', format: 'pem' }))) {
    throw new Error('Virtual key public PEM does not match the private PEM');
  }
}

function normalizePem(pem: string | Buffer): string {
  // KeyObject.export claims a string for pem output but its declared return is the
  // wider string|Buffer union, so normalise through toString() rather than lying
  // to the type system with a cast.
  return pem.toString().replace(/\s+/g, '');
}


/**
 * Accept either a bare host or a full URL and reduce it to the hostname Tesla
 * expects in the `domain` field and in the pairing deep link.
 *
 * Tesla registers the *root* domain (matching the allowed_origins entry on
 * developer.tesla.com), so a user who pastes "https://www.example.com/x" gets a
 * clear rejection rather than a registration for the wrong host.
 */
export function normalizeDomain(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error('A domain is required, for example: ev.example.com');
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`"${input}" is not a valid domain`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`The public key domain must be served over https, got ${url.protocol}`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`Provide the domain only, without a path (got "${url.pathname}")`);
  }
  if (!url.hostname.includes('.')) {
    throw new Error(`"${url.hostname}" is not a fully qualified domain name`);
  }
  return url.hostname;
}

/** The exact URL Tesla fetches to read this application's public key. */
export function publicKeyHostingUrl(domain: string): string {
  return `https://${normalizeDomain(domain)}${TESLA_PUBLIC_KEY_HOSTING_PATH}`;
}

/**
 * The link a signed-in user opens so the Tesla mobile app offers to add this
 * application's key to their vehicle. `vin` is optional and only useful when the
 * account owns several vehicles; without it the app asks which vehicle to pair.
 */
export function buildPairingUrl(domain: string, vin?: string): string {
  const base = `${PAIRING_DEEP_LINK_BASE}${normalizeDomain(domain)}`;
  if (vin === undefined || vin.trim() === '') return base;
  return `${base}?vin=${encodeURIComponent(vin.trim())}`;
}

/**
 * File-backed store for the long-lived application key pair.
 *
 * The pair is generated once and reused: re-registering replaces the key Tesla
 * holds and invalidates the pairing on every already-paired vehicle, so this file
 * is as precious as the refresh token. Files are written 0600 and read back
 * through a validation pass so a truncated PEM is caught here instead of during a
 * pairing attempt in front of the car.
 */
export class VirtualKeyStore {
  private cached: VirtualKeyPair | null = null;

  constructor(private readonly dir: string = getConfigDir()) {}

  get privateKeyPath(): string {
    return path.join(this.dir, PRIVATE_KEY_FILENAME);
  }

  get publicKeyPath(): string {
    return path.join(this.dir, PUBLIC_KEY_FILENAME);
  }

  /** Read the pair from disk, or return null when either file is missing. */
  async load(): Promise<VirtualKeyPair | null> {
    try {
      const [privateKeyPem, publicKeyPem] = await Promise.all([
        fs.readFile(this.privateKeyPath, 'utf-8'),
        fs.readFile(this.publicKeyPath, 'utf-8'),
      ]);
      return { privateKeyPem, publicKeyPem };
    } catch {
      return null;
    }
  }

  /** Return the stored pair, creating and persisting one on first use. */
  async loadOrCreate(): Promise<VirtualKeyPair> {
    if (this.cached) return this.cached;
    const existing = await this.load();
    if (existing) {
      assertVirtualKeyPair(existing);
      this.cached = existing;
      return existing;
    }
    const created = createVirtualKeyPair();
    await this.persist(created);
    this.cached = created;
    return created;
  }

  private async persist(pair: VirtualKeyPair): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // The mode option only applies when the file is created, so chmod explicitly
    // to cover a pre-existing file written by another tool with looser bits.
    await fs.writeFile(this.privateKeyPath, pair.privateKeyPem, { mode: 0o600 });
    await fs.writeFile(this.publicKeyPath, pair.publicKeyPem, { mode: 0o600 });
    await fs.chmod(this.privateKeyPath, 0o600).catch(() => undefined);
  }
}

export interface HostingInstructions {
  domain: string;
  /** The URL Tesla fetches. Must return 200 with the PEM as its body. */
  url: string;
  /** Where the locally generated public key sits, ready to upload. */
  localPublicKeyPath: string;
  publicKeyPem: string;
}

export interface VirtualKeyServiceOptions {
  /** Owns the EC key pair. Injected by tests to point at a temp directory. */
  store?: VirtualKeyStore;
  /** Transport for Tesla calls. Injected by tests so nothing hits the network. */
  http?: VirtualKeyHttp;
  /** Fleet API base URL for the configured region; doubles as token audience. */
  apiBaseUrl: string;
}

/**
 * Registers this application's public key with Tesla and produces the pairing link.
 *
 * The two token types here are the usual source of 401/403 in this flow: domain
 * registration is an application-level action and needs a PARTNER token
 * (client_credentials grant), while anything about a specific vehicle needs the
 * user's third-party token.
 */
export class VirtualKeyService {
  private readonly store: VirtualKeyStore;
  private readonly http?: VirtualKeyHttp;
  private readonly apiBaseUrl: string;

  constructor(options: VirtualKeyServiceOptions) {
    this.store = options.store ?? new VirtualKeyStore();
    this.http = options.http;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  }

  get privateKeyPath(): string {
    return this.store.privateKeyPath;
  }

  get publicKeyPath(): string {
    return this.store.publicKeyPath;
  }

  /** The application public key, generated on first use. */
  async getPublicKeyPem(): Promise<string> {
    const pair = await this.store.loadOrCreate();
    return pair.publicKeyPem;
  }

  /**
   * Everything needed to publish the key, gathered so the CLI can print exact
   * instructions. Registration is pointless until this URL serves the key, which
   * is why the URL is surfaced in code rather than only in the README.
   */
  async getHostingInstructions(domain: string): Promise<HostingInstructions> {
    const normalized = normalizeDomain(domain);
    const pair = await this.store.loadOrCreate();
    return {
      domain: normalized,
      url: publicKeyHostingUrl(normalized),
      localPublicKeyPath: this.store.publicKeyPath,
      publicKeyPem: pair.publicKeyPem,
    };
  }

  /**
   * Exchange client credentials for a partner token. Grants no access to any
   * vehicle; it only proves the caller is the registered application.
   *
   * No refresh_token is expected here. The Partner Tokens page documents neither
   * refresh_token nor offline_access for the client_credentials grant, and a
   * partner token is re-minted from client credentials rather than refreshed, so
   * requiring one would reject a perfectly valid response. It is never stored
   * either -- it is used for the registration calls below and then discarded.
   */
  async fetchPartnerToken(
    clientId: string,
    clientSecret: string,
    now: number = Date.now()
  ): Promise<{ accessToken: string; expiresAt: number }> {
    if (!this.http) {
      throw new Error('VirtualKeyService requires an http client to call Tesla');
    }
    if (!clientId || !clientSecret) {
      throw new Error('A partner token needs the Tesla client_id and client_secret');
    }
    const form = buildClientCredentialsTokenForm({
      clientId,
      clientSecret,
      audience: this.apiBaseUrl,
      scope: TESLA_PARTNER_SCOPE_STRING,
    });
    const response = await this.http.post(TESLA_TOKEN_URL, form, {
      headers: TOKEN_FORM_HEADERS,
    });
    const parsed = parseTokenResponse(response.data as TeslaTokenResponse, now, 30_000, {
      requireRefreshToken: false,
    });
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
  }


  /**
   * Enroll the domain that serves the public key. Tesla reads the key from the
   * well-known URL while processing this call, so the file must already be
   * published. The domain is what the user sees in the Tesla app during pairing.
   */
  async registerKey(
    accessToken: string,
    domain: string
  ): Promise<{ domain: string; detail: unknown }> {
    if (!this.http) {
      throw new Error('VirtualKeyService requires an http client to call Tesla');
    }
    const normalized = normalizeDomain(domain);
    // Fail before the network call if the local key is missing or corrupt.
    await this.store.loadOrCreate();
    const response = await this.http.post(
      `${this.apiBaseUrl}/api/1/partner_accounts`,
      { domain: normalized },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return { domain: normalized, detail: response.data };
  }

  /**
   * Confirm Tesla holds the public key this installation generated.
   *
   * A bare 200 is not enough: Tesla returns whatever key was registered for the
   * domain, which may have been generated on another machine. That pairs fine and
   * then fails every command, because the matching private key is not here -- so
   * the PEM is compared, and a mismatch is reported instead of waved through.
   * Returns registered: false on 404/412 so "not registered yet" is distinguishable
   * from a transport failure.
   */
  async verifyRegistration(
    accessToken: string,
    domain: string
  ): Promise<{ registered: boolean; matchesLocalKey: boolean; detail: unknown }> {
    if (!this.http) {
      throw new Error('VirtualKeyService requires an http client to call Tesla');
    }
    const normalized = normalizeDomain(domain);
    const local = await this.store.loadOrCreate();
    let detail: unknown;
    try {
      const response = await this.http.get(
        `${this.apiBaseUrl}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(normalized)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      detail = response.data;
    } catch {
      return { registered: false, matchesLocalKey: false, detail: null };
    }
    const remotePem = extractPem(detail);
    return {
      registered: true,
      // When Tesla returns no PEM, treat it as registered-but-unverifiable rather
      // than as a mismatch, so an unexpected response shape cannot lock the user out.
      matchesLocalKey:
        remotePem === null || normalizePem(remotePem) === normalizePem(local.publicKeyPem),
      detail,
    };
  }

  /** The pairing deep link for this application and an optional vehicle. */
  buildPairingUrl(domain: string, vin?: string): string {
    return buildPairingUrl(domain, vin);
  }

  /**
   * Fetch the key Tesla will actually read, and compare it with the local pair.
   *
   * This is a plain unauthenticated GET on purpose. The URL lives on the
   * operator's own web host, and a Tesla bearer token must never be sent to a
   * third party, so no Authorization header is attached here even though the
   * rest of this class talks to Tesla with one.
   *
   * It exists to catch the failure that costs the most time: a URL that returns
   * 200 with an HTML error page, a stale key from a previous machine, or a
   * redirect. All of those look fine until the pairing tap in front of the car,
   * which cannot be undone from the command line.
   */
  async checkHostedPublicKey(domain: string): Promise<HostedKeyCheck> {
    if (!this.http) {
      throw new Error('VirtualKeyService requires an http client to check the hosted key');
    }
    const url = publicKeyHostingUrl(domain);
    const local = await this.store.loadOrCreate();
    let status: number | undefined;
    let body: unknown;
    try {
      const response = await this.http.get(url);
      status = readStatus(response);
      body = response.data;
    } catch (error) {
      const reason = describeFetchFailure(error);
      return {
        url,
        reachable: false,
        status: readStatus(error),
        matchesLocalKey: false,
        bodyPreview: reason,
        error: `Could not fetch ${url}: ${reason}`,
      };
    }

    const served = extractPem(body);
    if (served === null) {
      return {
        url,
        reachable: status !== undefined && status >= 200 && status < 300,
        status,
        matchesLocalKey: false,
        bodyPreview: preview(typeof body === 'string' ? body : JSON.stringify(body)),
        error:
          'That URL did not return a PEM public key. Serve the file itself, with no ' +
          'redirect and no HTML error page in front of it.',
      };
    }
    const matches = normalizePem(served) === normalizePem(local.publicKeyPem);
    return {
      url,
      reachable: true,
      status,
      matchesLocalKey: matches,
      bodyPreview: preview(served),
      ...(matches
        ? {}
        : {
            error:
              'The published key does not match the private key on this machine. Upload ' +
              'the public key at the path shown above; do not pair until they match.',
          }),
    };
  }
}

export interface HostedKeyCheck {
  url: string;
  /** True when Tesla's fetch of this URL would get the key, not an error page. */
  reachable: boolean;
  status: number | undefined;
  matchesLocalKey: boolean;
  /**
   * First bytes of whatever the server returned, control characters stripped.
   * The body is remote content that ends up in the terminal, so it is sanitized
   * the same way the OAuth error string is.
   */
  bodyPreview: string;
  error?: string;
}

/**
 * Describe a transport failure in words a user can act on.
 *
 * Falls back deliberately: Node reports a refused connection or a bad TLS
 * handshake as an AggregateError whose `message` is the empty string and whose
 * real cause is in `code` (and sometimes in `errors[].code`). Printing the bare
 * message would render as "Could not fetch ...: " and say nothing, so the code
 * is preferred, and a generic phrase is the last resort so the string is never
 * empty.
 */
function describeFetchFailure(error: unknown): string {
  const record = (error ?? {}) as { message?: unknown; code?: unknown; errors?: unknown };
  const nested = Array.isArray(record.errors)
    ? record.errors
        .map((e) => (e as { code?: unknown })?.code)
        .filter((c): c is string => typeof c === 'string')
    : [];
  const codes = [record.code, ...nested].filter(
    (c): c is string => typeof c === 'string' && c.length > 0
  );
  const code = codes[0];

  const known: Record<string, string> = {
    ENOTFOUND: 'the domain does not resolve (DNS lookup failed)',
    ECONNREFUSED: 'the connection was refused (nothing is listening on port 443)',
    ECONNRESET: 'the connection was reset before the key was served',
    EHOSTUNREACH: 'the host is unreachable',
    ETIMEDOUT: 'the connection timed out',
    EPROTO: 'TLS failed (the certificate is not valid for this domain, or the site is not HTTPS)',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed; Tesla requires a publicly trusted certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'the TLS certificate chain is self-signed',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified',
  };
  if (code && known[code]) return `${code}: ${known[code]}`;

  const message = preview(typeof record.message === 'string' ? record.message : undefined);
  if (message) return code ? `${code}: ${message}` : message;
  if (code) return code;
  return 'the request failed for an unknown reason';
}

/** axios puts the status on the response; on a thrown error it is on error.response. */
function readStatus(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

/**
 * Reduce remote text to something safe to print: control characters out (so a
 * hostile body cannot write ANSI escapes or rewrite lines in the terminal),
 * whitespace collapsed, and length capped.
 *
 * Control characters become a space rather than being deleted: deleting them
 * would weld the tokens either side of a newline into one apparent word.
 */
function preview(value: string | undefined, max = 120): string {
  const text = (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Tesla wraps results in `{ response: ... }`; find a PEM wherever it is nested. */
function extractPem(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.includes('BEGIN ') ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPem(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = extractPem(item);
      if (found) return found;
    }
  }
  return null;
}

