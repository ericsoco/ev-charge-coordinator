/**
 * The signed-command sidecar manager (TeslaCommandProxy).
 *
 * Isolation: the config dir resolves at credentials.ts import time, so
 * ECC_CONFIG_DIR must be set before the module loads -- the same dynamic
 * import pattern credentials.test.ts uses. Everything here is local: TLS
 * material via the host's openssl, and (when the binary is installed) booting
 * the real tesla-http-proxy on loopback with a throwaway key. No Tesla
 * network calls: the proxy only dials Tesla when a command is sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as tls from 'node:tls';

type ProxyModule = typeof import('../../src/services/TeslaCommandProxy.js');
type ProcessModule = typeof import('../../src/services/ProcessManager.js');

let mod: ProxyModule;
let pm: ProcessModule;
let configDir: string;
let savedEnv: Record<string, string | undefined>;

function generateFleetKey(): void {
  const result = spawnSync('openssl', [
    'ecparam', '-name', 'prime256v1', '-genkey', '-noout',
    '-out', path.join(configDir, 'private-key.pem'),
  ]);
  expect(result.status).toBe(0);
}

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-vcp-'));
  savedEnv = {
    ECC_CONFIG_DIR: process.env.ECC_CONFIG_DIR,
    ECC_TESLA_PROXY_BIN: process.env.ECC_TESLA_PROXY_BIN,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  process.env.ECC_CONFIG_DIR = configDir;
  process.env.ECC_DISABLE_KEYCHAIN = '1';
  mod = await import('../../src/services/TeslaCommandProxy.js');
  pm = await import('../../src/services/ProcessManager.js');
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.ECC_DISABLE_KEYCHAIN;
});

beforeEach(() => {
  for (const entry of fs.readdirSync(configDir)) {
    fs.rmSync(path.join(configDir, entry), { recursive: true, force: true });
  }
});

describe('findTeslaProxyBinary', () => {
  it('honours ECC_TESLA_PROXY_BIN verbatim', () => {
    process.env.ECC_TESLA_PROXY_BIN = '/custom/place/tesla-http-proxy';
    try {
      expect(mod.findTeslaProxyBinary()).toBe('/custom/place/tesla-http-proxy');
    } finally {
      delete process.env.ECC_TESLA_PROXY_BIN;
    }
  });

  it('returns null when neither PATH nor ~/go/bin has it', () => {
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '';
    process.env.HOME = configDir; // no go/bin inside
    try {
      expect(mod.findTeslaProxyBinary()).toBeNull();
    } finally {
      process.env.PATH = savedPath;
      process.env.HOME = savedHome;
    }
  });
});

describe('ensureTeslaProxyTls', () => {
  it('generates an owner-only pair once that a client can trust via the cert', async () => {
    const { certPath, keyPath } = mod.ensureTeslaProxyTls();

    expect(fs.existsSync(certPath)).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(certPath).mode & 0o777).toBe(0o600);

    // The cert must actually work as a CA for localhost TLS: start a server
    // with the generated pair and handshake a client that trusts it, and
    // refuse one that does not. This is exactly what TeslaService's https
    // agent does against the proxy.
    const server = tls.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const caPem = fs.readFileSync(certPath, 'utf8');

    const handshake = (ca?: string): Promise<boolean> =>
      new Promise((resolve) => {
        const socket = tls.connect(
          { host: '127.0.0.1', port, servername: 'localhost', ...(ca ? { ca: [ca] } : {}) },
          () => {
            socket.destroy();
            resolve(true);
          }
        );
        socket.once('error', () => resolve(false));
      });

    try {
      // Trusting the cert: success (SAN covers localhost / 127.0.0.1).
      expect(await handshake(caPem)).toBe(true);
      // Default trust store only: this self-signed cert must be rejected.
      const untrusted = await new Promise<boolean>((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      expect(untrusted).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reuses an existing pair instead of regenerating', () => {
    const first = mod.ensureTeslaProxyTls();
    const certBefore = fs.readFileSync(first.certPath, 'utf8');
    const second = mod.ensureTeslaProxyTls();
    expect(second.certPath).toBe(first.certPath);
    expect(fs.readFileSync(second.certPath, 'utf8')).toBe(certBefore);
  });
});

/** Collection-time install check (mod is not loaded yet in describe bodies). */
function binaryInstalled(): boolean {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), 'go', 'bin')];
  return dirs.some((dir) => dir && fs.existsSync(path.join(dir, 'tesla-http-proxy')));
}
const itWithBinary = it.skipIf(!binaryInstalled());

describe('startTeslaProxy / stopTeslaProxy', () => {
  itWithBinary(
    'boots the real proxy, attaches to it, and stops it',
    async () => {
      generateFleetKey();
      let started: Awaited<ReturnType<typeof mod.startTeslaProxy>> | null = null;
      try {
        started = await mod.startTeslaProxy();
        expect(started.spawnedPid).toBeTypeOf('number');
        expect(pm.isProcessAlive(started.spawnedPid!)).toBe(true);
        expect(mod.spawnedTeslaProxyPid()).toBe(started.spawnedPid);
        expect(mod.isTeslaProxyRunning()).toBe(true);
        expect(fs.existsSync(path.join(configDir, 'tesla-proxy.json'))).toBe(true);

        const attached = await mod.startTeslaProxy();
        expect(attached.spawnedPid).toBeNull(); // attached, not respawned
        expect(attached.port).toBe(started.port);
        expect(mod.spawnedTeslaProxyPid()).toBe(started.spawnedPid); // this process still owns it
      } finally {
        if (started) await mod.stopTeslaProxy();
      }

      expect(pm.isProcessAlive(started!.spawnedPid!)).toBe(false);
      expect(mod.isTeslaProxyRunning()).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'tesla-proxy.json'))).toBe(false);
      expect(await mod.stopTeslaProxy()).toBe(false);
    },
    20_000
  );

  it('guides the user when the binary is missing', async () => {
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    const savedBin = process.env.ECC_TESLA_PROXY_BIN;
    process.env.PATH = '';
    process.env.HOME = configDir;
    delete process.env.ECC_TESLA_PROXY_BIN;
    try {
      await expect(mod.startTeslaProxy()).rejects.toThrow(/tesla-http-proxy\) not found/);
    } finally {
      process.env.PATH = savedPath;
      process.env.HOME = savedHome;
      if (savedBin !== undefined) process.env.ECC_TESLA_PROXY_BIN = savedBin;
    }
  });

  itWithBinary('guides the user when the command key is missing', async () => {
    // beforeEach cleaned the config dir: no private-key.pem, so the proxy
    // cannot sign anything and must say so before spawning.
    await expect(mod.startTeslaProxy()).rejects.toThrow(/pair-tesla-key first/);
  });
});