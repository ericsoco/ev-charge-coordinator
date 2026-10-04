/**
 * Tesla virtual key (Fleet Telemetry / key pairing) primitives.
 *
 * Pairing burns the application key registered against a domain, and a wrong key
 * or a wrong domain only shows up as a failed pairing in front of the car. These
 * tests pin the local validation that catches that before anything is sent, plus
 * the on-disk key store that must not silently regenerate a key pair (which would
 * invalidate every already-paired vehicle).
 */
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertVirtualKeyPair,
  buildPairingUrl,
  createVirtualKeyPair,
  normalizeDomain,
  PAIRING_DEEP_LINK_BASE,
  publicKeyHostingUrl,
  PRIVATE_KEY_FILENAME,
  PUBLIC_KEY_FILENAME,
  TESLA_PUBLIC_KEY_HOSTING_PATH,
  VIRTUAL_KEY_CURVE,
  VirtualKeyService,
  VirtualKeyStore,
} from '../../src/services/tesla/VirtualKeyService.js';
import {
  describeTeslaError,
  redactSecrets,
} from '../../src/services/tesla/oauth.js';

/** A key pair on a curve Tesla does not accept. */
function createP384Pair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp384r1',
    publicKeyEncoding: { type: 'spki', format: 'pem' } as const,
    privateKeyEncoding: { type: 'sec1', format: 'pem' } as const,
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

describe('createVirtualKeyPair', () => {
  it('emits SEC1 private and SPKI public PEMs, matching the openssl recipe', () => {
    const pair = createVirtualKeyPair();

    expect(pair.privateKeyPem).toContain('-----BEGIN EC PRIVATE KEY-----');
    expect(pair.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(() => assertVirtualKeyPair(pair)).not.toThrow();
  });

  it('generates a distinct key every time and on the required curve', () => {
    expect(createVirtualKeyPair().publicKeyPem).not.toBe(createVirtualKeyPair().publicKeyPem);
    expect(VIRTUAL_KEY_CURVE).toBe('prime256v1');
  });
});

describe('assertVirtualKeyPair', () => {
  it('rejects a pair that is missing either half', () => {
    const pair = createVirtualKeyPair();

    expect(() => assertVirtualKeyPair({ ...pair, publicKeyPem: '' })).toThrow(/both/);
    expect(() =>
      assertVirtualKeyPair({ publicKeyPem: pair.publicKeyPem, privateKeyPem: '' })
    ).toThrow(/both/);
  });

  it('rejects PEMs that do not parse instead of sending them to Tesla', () => {
    const pair = createVirtualKeyPair();

    expect(() =>
      assertVirtualKeyPair({ ...pair, privateKeyPem: 'not a pem' })
    ).toThrow(/private PEM could not be parsed/);
    expect(() =>
      assertVirtualKeyPair({ ...pair, publicKeyPem: 'not a pem' })
    ).toThrow(/public PEM could not be parsed/);
  });

  it('rejects a valid key pair on the wrong curve', () => {
    expect(() => assertVirtualKeyPair(createP384Pair())).toThrow(/EC prime256v1 \(P-256\)/);
    expect(() => assertVirtualKeyPair(createP384Pair())).toThrow(/secp384r1/);
  });

  it('rejects a public key that does not belong to the private key', () => {
    const a = createVirtualKeyPair();
    const b = createVirtualKeyPair();

    expect(() => assertVirtualKeyPair({ privateKeyPem: a.privateKeyPem, publicKeyPem: b.publicKeyPem })).toThrow(
      /does not match the private PEM/
    );
  });
});

describe('normalizeDomain', () => {
  it('accepts a bare host and a bare https URL alike', () => {
    expect(normalizeDomain('ev.example.com')).toBe('ev.example.com');
    expect(normalizeDomain('https://ev.example.com')).toBe('ev.example.com');
    expect(normalizeDomain('  https://ev.example.com/  ')).toBe('ev.example.com');
    expect(normalizeDomain('https://ev.example.com:8443')).toBe('ev.example.com');
  });

  it('rejects http, because the PEM must be served over https', () => {
    expect(() => normalizeDomain('http://ev.example.com')).toThrow(/https/);
  });

  it('rejects a URL carrying a path rather than silently dropping it', () => {
    expect(() => normalizeDomain('https://ev.example.com/register')).toThrow(/without a path/);
  });

  it('rejects a host that cannot host the well-known PEM', () => {
    expect(() => normalizeDomain('localhost')).toThrow(/fully qualified/);
    expect(() => normalizeDomain('   ')).toThrow(/domain is required/);
  });
});

describe('publicKeyHostingUrl and buildPairingUrl', () => {
  it('points Tesla at the fixed well-known path under https', () => {
    expect(publicKeyHostingUrl('ev.example.com')).toBe(
      'https://ev.example.com/.well-known/appspecific/com.tesla.3p.public-key.pem'
    );
    // The path is a fixed constant Tesla fetches; nothing may append to it.
    expect(publicKeyHostingUrl('ev.example.com')).toBe(
      `https://ev.example.com${TESLA_PUBLIC_KEY_HOSTING_PATH}`
    );
    expect(() => publicKeyHostingUrl('http://ev.example.com')).toThrow(/https/);
  });

  it('builds the mobile pairing deep link for the registered domain', () => {
    expect(buildPairingUrl('ev.example.com')).toBe(`${PAIRING_DEEP_LINK_BASE}ev.example.com`);
    expect(buildPairingUrl('https://ev.example.com')).toBe(
      `${PAIRING_DEEP_LINK_BASE}ev.example.com`
    );
  });

  it('appends a VIN only when one is supplied, and trims it', () => {
    expect(buildPairingUrl('ev.example.com', ' 5YJ...123 ')).toBe(
      `${PAIRING_DEEP_LINK_BASE}ev.example.com?vin=5YJ...123`
    );
    expect(buildPairingUrl('ev.example.com', '   ')).toBe(
      `${PAIRING_DEEP_LINK_BASE}ev.example.com`
    );
    expect(buildPairingUrl('ev.example.com', 'a b')).toContain('vin=a%20b');
  });
});

describe('VirtualKeyService.checkHostedPublicKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-vkey-host-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a service whose transport answers the hosted-key GET with the body
   * returned by `get` (wrapped into the axios response shape the service reads).
   */
  function serviceWith(get: (url: string) => Promise<unknown>) {
    return new VirtualKeyService({
      apiBaseUrl: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      store: new VirtualKeyStore(dir),
      http: { get: async (url: string) => ({ data: await get(url) }), post: async () => ({ data: {} }) },
    });
  }

  it('confirms a correct hosting and never sends an Authorization header', async () => {
    const service = serviceWith(async () => service.getPublicKeyPem());
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.matchesLocalKey).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.url).toBe(
      'https://ev.example.com/.well-known/appspecific/com.tesla.3p.public-key.pem'
    );
  });

  it('flags a key that does not match the local private key', async () => {
    // The failure this whole check exists for: a stale public key left on the
    // domain by a previous machine. Pairing would succeed and every command
    // would then be rejected.
    const service = serviceWith(async () => createVirtualKeyPair().publicKeyPem);
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.matchesLocalKey).toBe(false);
    expect(result.reachable).toBe(true);
    expect(result.error).toMatch(/does not match the private key on this machine/);
  });

  it('flags a 200 that serves an HTML error page instead of a PEM', async () => {
    const service = serviceWith(async () => '<html><body>404 Not Found</body></html>');
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.matchesLocalKey).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.bodyPreview).toContain('404 Not Found');
    expect(result.error).toMatch(/did not return a PEM public key/);
  });

  it('strips control characters out of the body preview', async () => {
    // The body is remote content printed to the terminal; ANSI escapes and CR/LF
    // in it would let a hostile page rewrite the CLI's output.
    const service = serviceWith(
      async () => '\u001b[31mFAKE KEY\u0007 bogus-line\nsecond line'
    );
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.bodyPreview).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(result.bodyPreview).not.toContain('\n');
    expect(result.bodyPreview).toContain('FAKE KEY bogus-line second line');
  });

  it('reports a transport failure without throwing', async () => {
    const service = serviceWith(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND ev.example.com'), {
        response: { status: 502 },
      });
    });
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.reachable).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/Could not fetch/);
  });

  it('explains a failure whose Error has an empty message', async () => {
    // Node reports a refused connection as an AggregateError with message === ''.
    // Trusting `message` alone renders "Could not fetch ...: " and says nothing,
    // so the code is used and the text is never empty.
    const service = serviceWith(async () => {
      throw Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    });
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.error).toMatch(/refused/);
    expect(result.error).not.toMatch(/:\s*$/);
  });

  it('reads a nested cause code when the outer error carries none', async () => {
    const service = serviceWith(async () => {
      throw new AggregateError(
        [Object.assign(new Error('x'), { code: 'ENOTFOUND' })],
        ''
      );
    });
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.error).toMatch(/ENOTFOUND/);
  });

  it('always produces some text, even for a bare rejection', async () => {
    const service = serviceWith(async () => {
      throw {};
    });
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.error).toMatch(/unknown reason/);
    expect(result.bodyPreview.length).toBeGreaterThan(0);
  });

  it('creates the local key on first use so a check works before any key exists', async () => {
    const service = serviceWith(async () => {
      throw new Error('should not be reached');
    });
    // No key on disk yet: the check must still return a structured result rather
    // than throwing, so --check-only works on a fresh machine.
    const result = await service.checkHostedPublicKey('ev.example.com');

    expect(result.matchesLocalKey).toBe(false);
    expect(fs.existsSync(path.join(dir, PRIVATE_KEY_FILENAME))).toBe(true);
  });
});

describe('VirtualKeyService.fetchPartnerToken', () => {
  // The reported failure: registration died with "Token response did not contain
  // a refresh_token (was the offline_access scope granted?)". The client_credentials
  // grant issues no refresh token at all -- the Partner Tokens page documents
  // neither refresh_token nor offline_access for it -- so requiring one rejected a
  // valid response. Nothing exercised this method, so it shipped broken.
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-vkey-partner-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A service whose token POST returns exactly `body`. */
  function serviceReturning(body: unknown, captured: URLSearchParams[] = []) {
    return new VirtualKeyService({
      apiBaseUrl: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      store: new VirtualKeyStore(dir),
      http: {
        get: async () => ({ data: {} }),
        post: async (_url: string, data?: unknown) => {
          captured.push(data as URLSearchParams);
          return { data: body };
        },
      },
    });
  }

  it('accepts a partner token response, which has no refresh_token', async () => {
    // The shape Tesla documents for client_credentials.
    const service = serviceReturning({
      access_token: 'partner-access-token',
      token_type: 'Bearer',
      expires_in: 28800,
    });

    const token = await service.fetchPartnerToken('cid', 'secret');
    expect(token.accessToken).toBe('partner-access-token');
  });

  it('applies the expiry margin to the partner token', async () => {
    const now = 1_700_000_000_000;
    const service = serviceReturning({
      access_token: 'at',
      expires_in: 28800,
    });

    const token = await service.fetchPartnerToken('cid', 'secret', now);
    expect(token.expiresAt).toBe(now + 28_800_000 - 30_000);
  });

  it('still rejects a response with no access_token', async () => {
    // Opting out of the refresh_token requirement must not weaken this check.
    const service = serviceReturning({ token_type: 'Bearer', expires_in: 28800 });
    await expect(service.fetchPartnerToken('cid', 'secret')).rejects.toThrow(/access_token/);
  });

  it('sends the documented partner-token form and no offline_access', async () => {
    const sent: URLSearchParams[] = [];
    const service = serviceReturning({ access_token: 'at', expires_in: 28800 }, sent);

    await service.fetchPartnerToken('cid', 'secret');

    expect(sent).toHaveLength(1);
    const form = sent[0];
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('secret');
    expect(form.get('audience')).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');
    // offline_access is not a partner-token scope, and asking for it cannot make
    // a refresh token appear.
    expect(form.has('scope') && form.get('scope')).not.toContain('offline_access');
  });

  it('requires both client credentials before calling Tesla', async () => {
    const sent: URLSearchParams[] = [];
    const service = serviceReturning({ access_token: 'at' }, sent);

    await expect(service.fetchPartnerToken('', 'secret')).rejects.toThrow(/client_id/);
    await expect(service.fetchPartnerToken('cid', '')).rejects.toThrow(/client_secret/);
    expect(sent).toHaveLength(0);
  });
});

describe('redactSecrets', () => {
  it('removes a Tesla client secret', () => {
    const out = redactSecrets('failed for client ta-secret.EXAMPLEonlyAAaa11 (cid 2fc1d3f9)');
    expect(out).not.toContain('EXAMPLEonlyAAaa11');
    expect(out).toContain('[redacted]');
    // The non-secret context must survive, or the message stops being useful.
    expect(out).toContain('2fc1d3f9');
  });

  it('removes a JWT access token', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiIsImtpZCI6IlI0b3Z1cE5uNGpxX0xaQmF4ZHZQRkZ4RGFQVSJ9.' +
      'eyJhY2NvdW50X3R5cGUiOiJwZXJzb24ifQ.a2YT0Sh0QVtNwvlExk5aqc7me23eeYv4';
    const out = redactSecrets(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain('eyJ');
    expect(out).toBe('Authorization: Bearer [redacted]');
  });

  it('removes a Tesla refresh token', () => {
    expect(redactSecrets('refresh NA_a90869e9dabcdef1234 expired')).toBe(
      'refresh [redacted] expired'
    );
  });

  it('is applied to every error message the CLI prints', () => {
    // The funnel, not a helper nobody calls: a secret arriving inside a Tesla
    // error body must not reach the terminal or a pasted bug report.
    const mapped = describeTeslaError(401, 'invalid_client for ta-secret.EXAMPLEonlyAAaa11');
    expect(mapped).not.toContain('EXAMPLEonlyAAaa11');
    expect(mapped).toContain('client_id/secret');
  });
});

describe('VirtualKeyStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-vkey-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing stored until a pair is created', async () => {
    await expect(new VirtualKeyStore(dir).load()).resolves.toBeNull();
  });

  it('creates the pair once, keeps the private key owner-only, and reuses it', async () => {
    const created = await new VirtualKeyStore(dir).loadOrCreate();

    const privateKeyPath = path.join(dir, PRIVATE_KEY_FILENAME);
    const publicKeyPath = path.join(dir, PUBLIC_KEY_FILENAME);
    expect(fs.existsSync(privateKeyPath)).toBe(true);
    expect(fs.existsSync(publicKeyPath)).toBe(true);
    expect(fs.statSync(privateKeyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(publicKeyPath, 'utf8')).toBe(created.publicKeyPem);

    // A fresh instance must read the same key back: regenerating here would
    // replace the key Tesla holds and unpair every vehicle already paired.
    await expect(new VirtualKeyStore(dir).loadOrCreate()).resolves.toEqual(created);
  });

  it('serves the cached pair without touching disk again', async () => {
    const store = new VirtualKeyStore(dir);
    const first = await store.loadOrCreate();
    fs.rmSync(path.join(dir, PUBLIC_KEY_FILENAME), { force: true });

    await expect(store.loadOrCreate()).resolves.toBe(first);
    await expect(new VirtualKeyStore(dir).load()).resolves.toBeNull();
  });

  it('refuses to load a directory whose halves no longer belong together', async () => {
    await new VirtualKeyStore(dir).loadOrCreate();
    fs.writeFileSync(
      path.join(dir, PUBLIC_KEY_FILENAME),
      createVirtualKeyPair().publicKeyPem,
      'utf8'
    );

    await expect(new VirtualKeyStore(dir).loadOrCreate()).rejects.toThrow(
      /does not match the private PEM/
    );
  });
});
