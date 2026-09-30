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
  VirtualKeyStore,
} from '../../src/services/tesla/VirtualKeyService.js';

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
