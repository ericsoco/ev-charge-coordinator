/**
 * Secure credential storage and management.
 * 
 * Uses keytar for secure system keychain storage, with fallback to
 * encrypted file storage when keychain is not available.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

const SERVICE_NAME = 'ev-charge-coordinator';
// ECC_CONFIG_DIR redirects all credential I/O at another directory; it exists so the
// test suite can run against a temp dir instead of a real ~/.ev-charge-coordinator.
const CONFIG_DIR = process.env.ECC_CONFIG_DIR
  ? path.resolve(process.env.ECC_CONFIG_DIR)
  : path.join(os.homedir(), '.ev-charge-coordinator');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.enc');
const KEY_FILE = path.join(CONFIG_DIR, '.key');

/**
 * Resolved directory for all file-backed secrets. Exported so other modules
 * (e.g. the virtual key store) place their files beside the credential store
 * and inherit the ECC_CONFIG_DIR redirection used by the test suite.
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Stored shape of the Tesla credentials. */
export interface TeslaCredentialInput {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Absolute unix time in milliseconds, matching the existing stored format. */
  expiresAt?: number;
  vin?: string;
  /** Tesla deployment region. Determines the Fleet API base URL and audience. */
  region?: 'na' | 'eu' | 'cn';
  /** Externally reachable HTTPS domain hosting the registered app specifics. */
  domain?: string;
  /** Loopback port the OAuth redirect listener binds to. */
  callbackPort?: number;
}

interface StoredCredentials {
  franklin?: {
    username: string;
    password: string;
    gatewayId: string;
  };
  tesla?: {
    // Optional because setTeslaCredentials merges partial updates, so a record
    // can legitimately exist before the app credentials have been supplied.
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    vin?: string;
    region?: 'na' | 'eu' | 'cn';
    domain?: string;
    callbackPort?: number;
  };
  settings?: {
    batteryBuffer: number;
  };
}

let keytar: typeof import('keytar') | null = null;

async function getKeytar(): Promise<typeof import('keytar') | null> {
  if (keytar !== null) return keytar;

  // ECC_DISABLE_KEYCHAIN forces the encrypted-file path. Required in tests (a real
  // macOS keychain is shared state) and in CI/headless runs.
  if (process.env.ECC_DISABLE_KEYCHAIN) {
    return null;
  }

  try {
    keytar = await import('keytar');
    return keytar;
  } catch {
    // keytar not available (common in headless environments)
    return null;
  }
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

function getOrCreateKey(): Buffer {
  ensureConfigDir();
  
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE);
  }
  
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

function encrypt(data: string): string {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return JSON.stringify({
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted
  });
}

function decrypt(encryptedData: string): string {
  const key = getOrCreateKey();
  const { iv, authTag, data } = JSON.parse(encryptedData);
  
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

async function loadCredentialsFile(): Promise<StoredCredentials> {
  ensureConfigDir();
  
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return {};
  }
  
  try {
    const encrypted = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const decrypted = decrypt(encrypted);
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

async function saveCredentialsFile(credentials: StoredCredentials): Promise<void> {
  ensureConfigDir();
  
  const encrypted = encrypt(JSON.stringify(credentials));
  fs.writeFileSync(CREDENTIALS_FILE, encrypted, { mode: 0o600 });
}

export class CredentialStore {
  private credentials: StoredCredentials = {};
  private initialized = false;
  /**
   * Which backend this instance resolved to on first load.
   *
   * Pinning this is the fix for a real bug: save() and initialize() each used to
   * try the keychain and silently fall back to the file, independently. If the
   * keychain ever held a different payload from the file -- which it did, after
   * a test wrote to it -- a load could come from the keychain while a save went
   * to the file. The two then disagreed forever, and because the keychain wins on
   * read, writes became invisible and the CLI re-prompted for credentials on
   * every run. Resolving once, then using that backend for the life of the
   * instance, makes the two halves agree by construction.
   *
   * null means "not resolved yet"; once initialize() runs it is decided.
   */
  private backend: 'keychain' | 'file' | null = null;

  /** Backend in use, for diagnostics and for tests that assert on it. */
  get storageBackend(): 'keychain' | 'file' | null {
    return this.backend;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const kt = await getKeytar();

    if (kt) {
      try {
        const stored = await kt.getPassword(SERVICE_NAME, 'credentials');
        if (stored) {
          this.credentials = JSON.parse(stored);
          this.backend = 'keychain';
          this.initialized = true;
          return;
        }
      } catch (error) {
        // A corrupt keychain entry used to fall through to the file silently,
        // which is precisely how the two backends drifted apart. Surfaced as a
        // warning because the user would otherwise see credentials "forget"
        // themselves with no explanation.
        console.warn(
          `Warning: could not read the ${SERVICE_NAME} keychain entry ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            'falling back to the encrypted file.'
        );
      }
    }

    this.credentials = await loadCredentialsFile();
    this.backend = 'file';
    this.initialized = true;
  }

  private async save(): Promise<void> {
    // Reuse the backend chosen at load time rather than re-deciding. A store
    // that loaded from the file must save to the file, even if the keychain
    // becomes reachable later in the same process.
    if (this.backend === 'keychain') {
      const kt = await getKeytar();
      if (kt) {
        await kt.setPassword(SERVICE_NAME, 'credentials', JSON.stringify(this.credentials));
        return;
      }
      // The keychain went away after we resolved to it. Write the file rather
      // than dropping the write on the floor, and switch for subsequent calls.
      this.backend = 'file';
    }
    await saveCredentialsFile(this.credentials);
  }

  // FranklinWH credentials
  async getFranklinCredentials(): Promise<StoredCredentials['franklin'] | undefined> {
    await this.initialize();
    return this.credentials.franklin;
  }

  async setFranklinCredentials(username: string, password: string, gatewayId: string): Promise<void> {
    await this.initialize();
    this.credentials.franklin = { username, password, gatewayId };
    await this.save();
  }

  async clearFranklinCredentials(): Promise<void> {
    await this.initialize();
    delete this.credentials.franklin;
    await this.save();
  }

  // Tesla credentials
  async getTeslaCredentials(): Promise<StoredCredentials['tesla'] | undefined> {
    await this.initialize();
    return this.credentials.tesla;
  }

  /**
   * Accepts clientId/clientSecret with or without a token. The previous
   * positional signature rebuilt the whole record on every call, so saving the
   * client credentials after authenticating silently blanked the freshly issued
   * token. Fields are now merged, and omitted fields keep their stored value.
   */
  async setTeslaCredentials(input: TeslaCredentialInput): Promise<void> {
    await this.initialize();
    const existing = this.credentials.tesla ?? {};
    this.credentials.tesla = {
      ...existing,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
      ...(input.accessToken !== undefined ? { accessToken: input.accessToken } : {}),
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.vin !== undefined ? { vin: input.vin } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.callbackPort !== undefined ? { callbackPort: input.callbackPort } : {}),
    };
    await this.save();
  }

  /**
   * Persist a rotated access/refresh token pair. Tesla rotates refresh tokens on
   * every refresh, so this must be called after each successful refresh.
   */
  async updateTeslaTokens(
    accessToken: string,
    refreshToken: string,
    expiresAt: number
  ): Promise<void> {
    await this.initialize();
    if (!this.credentials.tesla) {
      throw new Error('Tesla credentials not configured');
    }
    this.credentials.tesla.accessToken = accessToken;
    this.credentials.tesla.refreshToken = refreshToken;
    this.credentials.tesla.expiresAt = expiresAt;
    await this.save();
  }

  async setTeslaVin(vin: string): Promise<void> {
    await this.initialize();
    if (!this.credentials.tesla) {
      throw new Error('Tesla credentials not configured');
    }
    this.credentials.tesla.vin = vin;
    await this.save();
  }

  async clearTeslaCredentials(): Promise<void> {
    await this.initialize();
    delete this.credentials.tesla;
    await this.save();
  }

  // Settings
  async getBatteryBuffer(): Promise<number> {
    await this.initialize();
    return this.credentials.settings?.batteryBuffer ?? 20; // Default 20%
  }

  async setBatteryBuffer(buffer: number): Promise<void> {
    await this.initialize();
    if (!this.credentials.settings) {
      this.credentials.settings = { batteryBuffer: buffer };
    } else {
      this.credentials.settings.batteryBuffer = buffer;
    }
    await this.save();
  }

  // Clear all
  async clearAll(): Promise<void> {
    this.credentials = {};
    await this.save();
    
    const kt = await getKeytar();
    if (kt) {
      try {
        await kt.deletePassword(SERVICE_NAME, 'credentials');
      } catch {
        // Ignore errors
      }
    }
    
    // Also remove file-based credentials
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
  }
}

export const credentialStore = new CredentialStore();
