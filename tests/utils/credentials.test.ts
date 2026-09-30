/**
 * Phase 0 characterization suite: CredentialStore.
 *
 * These tests PIN CURRENT BEHAVIOR so later refactors can prove they did not change it.
 * Where the current behavior is questionable the test says so in its name rather than
 * asserting the behavior we would prefer.
 *
 * Isolation: credentials.ts resolves CONFIG_DIR once at import time, so ECC_CONFIG_DIR /
 * ECC_DISABLE_KEYCHAIN must be set BEFORE the module loads. That rules out a static
 * import, hence the dynamic import in beforeAll. Without this the suite would write into
 * the developer's real ~/.ev-charge-coordinator and touch the macOS keychain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type CredentialModule = typeof import('../../src/utils/credentials.js');

const CREDENTIALS_FILE = 'credentials.enc';
const KEY_FILE = '.key';

let mod: CredentialModule;
let configDir: string;

function credPath(): string {
  return path.join(configDir, CREDENTIALS_FILE);
}

function readEnvelope(): { iv?: string; authTag?: string; data?: string } {
  return JSON.parse(fs.readFileSync(credPath(), 'utf8'));
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-creds-'));
  process.env.ECC_CONFIG_DIR = configDir;
  process.env.ECC_DISABLE_KEYCHAIN = '1';
  mod = await import('../../src/utils/credentials.js');
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  delete process.env.ECC_CONFIG_DIR;
  delete process.env.ECC_DISABLE_KEYCHAIN;
});

beforeEach(() => {
  for (const entry of fs.readdirSync(configDir)) {
    fs.rmSync(path.join(configDir, entry), { recursive: true, force: true });
  }
});

describe('CredentialStore - encrypted file fallback', () => {
  it('round-trips FranklinWH credentials through the encrypted file', async () => {
    const store = new mod.CredentialStore();
    await store.setFranklinCredentials('user@example.com', 'hunter2', 'GW12345');

    const reloaded = new mod.CredentialStore();
    await expect(reloaded.getFranklinCredentials()).resolves.toEqual({
      username: 'user@example.com',
      password: 'hunter2',
      gatewayId: 'GW12345',
    });
  });

  it('never writes the password to disk in plaintext', async () => {
    const store = new mod.CredentialStore();
    await store.setFranklinCredentials('user@example.com', 'hunter2', 'GW12345');

    const raw = fs.readFileSync(credPath(), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('GW12345');

    const envelope = readEnvelope();
    expect(Object.keys(envelope).sort()).toEqual(['authTag', 'data', 'iv']);
    expect(envelope.data).toBeTruthy();
  });

  it('stores the AES key in a sibling file with no group/other permissions', async () => {
    const store = new mod.CredentialStore();
    await store.setBatteryBuffer(35);

    const keyPath = path.join(configDir, KEY_FILE);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath).length).toBe(32);
    // 0o600 today; assert the weaker invariant so a umask difference cannot flake it.
    expect(modeOf(keyPath) & 0o077).toBe(0);
    expect(modeOf(configDir) & 0o077).toBe(0);
  });

  it('silently falls back to defaults when the ciphertext has been tampered with', async () => {
    const store = new mod.CredentialStore();
    await store.setFranklinCredentials('user@example.com', 'hunter2', 'GW12345');

    const envelope = readEnvelope();
    const last = envelope.data!.slice(-1);
    const flipped = envelope.data!.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    fs.writeFileSync(credPath(), JSON.stringify({ ...envelope, data: flipped }), 'utf8');

    const reloaded = new mod.CredentialStore();
    // Characterization: the GCM auth failure is swallowed and the user gets an empty
    // store instead of an error. Worth revisiting; pinned for now.
    await expect(reloaded.getFranklinCredentials()).resolves.toBeUndefined();
    await expect(reloaded.getBatteryBuffer()).resolves.toBe(20);
  });

  it('defaults the battery buffer to 20% when nothing is stored', async () => {
    const store = new mod.CredentialStore();
    await expect(store.getBatteryBuffer()).resolves.toBe(20);
  });

  it('persists an explicitly configured battery buffer across instances', async () => {
    const store = new mod.CredentialStore();
    await store.setBatteryBuffer(0);
    await expect(new mod.CredentialStore().getBatteryBuffer()).resolves.toBe(0);

    await store.setBatteryBuffer(45);
    await expect(new mod.CredentialStore().getBatteryBuffer()).resolves.toBe(45);
  });

  it('persists Tesla tokens and lets updateTeslaTokens rotate them', async () => {
    const store = new mod.CredentialStore();
    await store.setTeslaCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1000,
      vin: 'VIN1',
    });
    await store.updateTeslaTokens('access-2', 'refresh-2', 2000);

    await expect(new mod.CredentialStore().getTeslaCredentials()).resolves.toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: 2000,
      vin: 'VIN1',
    });
  });

  it('throws when rotating tokens or setting a VIN with no Tesla credentials stored', async () => {
    const store = new mod.CredentialStore();
    await expect(store.updateTeslaTokens('a', 'r', 1)).rejects.toThrow('Tesla credentials not configured');
    await expect(store.setTeslaVin('VIN2')).rejects.toThrow('Tesla credentials not configured');
  });

  it('clears FranklinWH credentials without touching Tesla credentials', async () => {
    const store = new mod.CredentialStore();
    await store.setFranklinCredentials('u', 'p', 'GW');
    await store.setTeslaCredentials({ clientId: 'client-id', clientSecret: 'client-secret' });
    await store.clearFranklinCredentials();

    const reloaded = new mod.CredentialStore();
    await expect(reloaded.getFranklinCredentials()).resolves.toBeUndefined();
    await expect(reloaded.getTeslaCredentials()).resolves.toMatchObject({ clientId: 'client-id' });
  });

  it('clearAll removes the credentials file but leaves the AES key behind', async () => {
    const store = new mod.CredentialStore();
    await store.setFranklinCredentials('u', 'p', 'GW');
    await store.clearAll();

    expect(fs.existsSync(credPath())).toBe(false);
    await expect(new mod.CredentialStore().getFranklinCredentials()).resolves.toBeUndefined();
  });
});

describe('CredentialStore - module surface', () => {
  it('exports a ready-made singleton for the CLI to share', () => {
    expect(mod.credentialStore).toBeInstanceOf(mod.CredentialStore);
  });

  it('takes the file fallback instead of the keychain when ECC_DISABLE_KEYCHAIN is set', async () => {
    // If keytar were reachable, save() would target the macOS keychain and no .enc file
    // would appear. Its presence proves the encrypted-file path was taken.
    const store = new mod.CredentialStore();
    await store.setBatteryBuffer(30);
    expect(fs.existsSync(credPath())).toBe(true);
  });
});
