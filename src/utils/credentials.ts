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

interface StoredCredentials {
  franklin?: {
    username: string;
    password: string;
    gatewayId: string;
  };
  tesla?: {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    vin?: string;
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

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    const kt = await getKeytar();
    
    if (kt) {
      // Try to load from system keychain
      try {
        const stored = await kt.getPassword(SERVICE_NAME, 'credentials');
        if (stored) {
          this.credentials = JSON.parse(stored);
          this.initialized = true;
          return;
        }
      } catch {
        // Fall through to file-based storage
      }
    }
    
    // Fall back to encrypted file storage
    this.credentials = await loadCredentialsFile();
    this.initialized = true;
  }

  private async save(): Promise<void> {
    const kt = await getKeytar();
    
    if (kt) {
      try {
        await kt.setPassword(SERVICE_NAME, 'credentials', JSON.stringify(this.credentials));
        return;
      } catch {
        // Fall through to file-based storage
      }
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

  async setTeslaCredentials(
    clientId: string,
    clientSecret: string,
    accessToken?: string,
    refreshToken?: string,
    expiresAt?: number,
    vin?: string
  ): Promise<void> {
    await this.initialize();
    this.credentials.tesla = {
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      expiresAt,
      vin
    };
    await this.save();
  }

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
