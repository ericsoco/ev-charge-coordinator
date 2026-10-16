/**
 * Tesla's signed-command sidecar: the official `tesla-http-proxy` from
 * teslamotors/vehicle-command.
 *
 * Vehicles built from 2021 reject plain-REST commands with "Vehicle Command
 * Protocol required"; every command must be signed with a key in the
 * vehicle's keychain. The proxy exposes the identical Fleet API REST paths on
 * a local TLS port, signs each `/command/*` request with the application's
 * virtual key (the private-key.pem that pair-tesla-key generates and the user
 * enrolls via the tesla.com/_ak link), and forwards to Fleet API with the
 * OAuth bearer it receives. Same lifecycle as the FranklinWH Python proxy:
 * started here, recorded on disk, stopped by `exit`.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { getConfigDir } from '../utils/credentials.js';
import { isProcessAlive, terminateProcess } from './ProcessManager.js';
import { VirtualKeyStore } from './tesla/VirtualKeyService.js';

/** Non-privileged port; the proxy's own default is 443. */
export const TESLA_PROXY_DEFAULT_PORT = 4443;

const PROXY_SUBDIR = 'tesla-proxy';
const CERT_FILENAME = 'tls-cert.pem';
const TLS_KEY_FILENAME = 'tls-key.pem';
const STATE_FILENAME = 'tesla-proxy.json';
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

export interface TeslaProxyHandle {
  port: number;
  /** PEM of the proxy's self-signed certificate; the CA that signs its TLS. */
  certPem: string;
  /** PID when this process started the proxy; null when attached to one. */
  spawnedPid: number | null;
}

interface TeslaProxyState {
  pid: number;
  port: number;
  startedAt: number;
}

/** PID of the proxy this process spawned; null when attached or none. */
let spawnedPidLocal: number | null = null;

/** Whether this process started the proxy (REPL close stops only those). */
export function spawnedTeslaProxyPid(): number | null {
  return spawnedPidLocal;
}

/**
 * The binary, or null when it is not installed. ECC_TESLA_PROXY_BIN is taken
 * verbatim (a wrong path fails at spawn with its own message, not silently);
 * otherwise PATH plus ~/go/bin, where `go build` puts it by default.
 */
export function findTeslaProxyBinary(): string | null {
  const explicit = process.env.ECC_TESLA_PROXY_BIN;
  if (explicit) return explicit;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter)];
  dirs.push(path.join(os.homedir(), 'go', 'bin'));
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'tesla-http-proxy');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

export function teslaProxyTlsPaths(): { certPath: string; keyPath: string } {
  const dir = path.join(getConfigDir(), PROXY_SUBDIR);
  return {
    certPath: path.join(dir, CERT_FILENAME),
    keyPath: path.join(dir, TLS_KEY_FILENAME),
  };
}

/**
 * Generate the proxy's TLS pair once (owner-only). A dedicated self-signed
 * certificate with SAN localhost/127.0.0.1 -- the TLS key must NOT be the
 * command key, which the proxy refuses on boot. The config-file form of
 * `openssl req` is used because LibreSSL (macOS) lacks `-addext`.
 */
export function ensureTeslaProxyTls(): { certPath: string; keyPath: string } {
  const paths = teslaProxyTlsPaths();
  if (fs.existsSync(paths.certPath) && fs.existsSync(paths.keyPath)) return paths;

  fs.mkdirSync(path.dirname(paths.certPath), { recursive: true, mode: OWNER_ONLY_DIR });
  const cnfPath = `${paths.certPath}.cnf`;
  fs.writeFileSync(
    cnfPath,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_req',
      'prompt = no',
      '[dn]',
      'CN = localhost',
      '[v3_req]',
      'keyUsage = critical, digitalSignature, keyAgreement',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt_names',
      '[alt_names]',
      'DNS = localhost',
      'IP = 127.0.0.1',
      '',
    ].join('\n'),
    { mode: OWNER_ONLY_FILE }
  );

  const result = spawnSync('openssl', [
    'req', '-x509', '-nodes', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:secp384r1',
    '-pkeyopt', 'ec_param_enc:named_curve',
    '-config', cnfPath,
    '-keyout', paths.keyPath,
    '-out', paths.certPath,
    '-sha256', '-days', '3650',
  ]);
  fs.rmSync(cnfPath, { force: true });

  if (result.status !== 0) {
    throw new Error(
      `Failed to generate TLS material for the Tesla command proxy with openssl: ` +
        `${result.stderr?.toString().trim() || `exit ${result.status}`}`
    );
  }
  fs.chmodSync(paths.keyPath, OWNER_ONLY_FILE);
  fs.chmodSync(paths.certPath, OWNER_ONLY_FILE);
  return paths;
}

function readState(): TeslaProxyState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(getConfigDir(), STATE_FILENAME), 'utf8')
    ) as Partial<TeslaProxyState>;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.port !== 'number') return null;
    return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt ?? Date.now() };
  } catch {
    return null;
  }
}

function writeState(state: TeslaProxyState): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: OWNER_ONLY_DIR });
  const target = path.join(getConfigDir(), STATE_FILENAME);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: OWNER_ONLY_FILE });
  fs.renameSync(temp, target);
  fs.chmodSync(target, OWNER_ONLY_FILE);
}

function clearState(): void {
  try {
    fs.rmSync(path.join(getConfigDir(), STATE_FILENAME));
  } catch {
    // Already gone.
  }
}

/** Wait until the proxy answers a TLS handshake signed by its own certificate. */
async function waitForTls(port: number, caPem: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, ca: [caPem], servername: 'localhost' });
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(1000, () => done(false));
      socket.once('secureConnect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Tesla command proxy did not become reachable on port ${port} in ${timeoutMs}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Start the proxy, or attach to the recorded running one. Throws with guidance
 * on every failure mode: no binary, no command key, TLS generation failure,
 * early exit (including port-in-use), or a readiness timeout.
 */
export async function startTeslaProxy(): Promise<TeslaProxyHandle> {
  // Attach first, before any prerequisite checks: a recorded live proxy was
  // started with TLS material and a key that still exist on disk.
  const state = readState();
  if (state && isProcessAlive(state.pid)) {
    const certPem = fs.readFileSync(teslaProxyTlsPaths().certPath, 'utf8');
    return { port: state.port, certPem, spawnedPid: null };
  }

  // Cheap prerequisites before anything is generated or spawned, so each
  // failure names the one thing the user must fix.
  const binary = findTeslaProxyBinary();
  if (!binary) {
    throw new Error(
      'Tesla command proxy binary (tesla-http-proxy) not found. Install it with:\n' +
        '  git clone https://github.com/teslamotors/vehicle-command && ' +
        '(cd vehicle-command && go build -o ~/go/bin/tesla-http-proxy ./cmd/tesla-http-proxy)\n' +
        'or set ECC_TESLA_PROXY_BIN to its location. See README (Signed commands).'
    );
  }

  const fleetKey = new VirtualKeyStore().privateKeyPath;
  if (!fs.existsSync(fleetKey)) {
    throw new Error(
      `Tesla command key not found at ${fleetKey}. Run pair-tesla-key first: it generates ` +
        'the key and walks through enrolling it in the vehicle.'
    );
  }

  const { certPath, keyPath } = ensureTeslaProxyTls();
  const certPem = fs.readFileSync(certPath, 'utf8');
  const port = TESLA_PROXY_DEFAULT_PORT;
  const child = spawn(
    binary,
    [
      '-cert', certPath,
      '-tls-key', keyPath,
      '-key-file', fleetKey,
      '-host', 'localhost',
      '-port', String(port),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
  });

  const exitedEarly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => {
      const hint = /address already in use/i.test(stderrTail)
        ? `\nPort ${port} is in use. Stop it with: lsof -ti tcp:${port} | xargs kill`
        : '';
      reject(
        new Error(
          `Tesla command proxy exited with code ${code} during startup:` +
            `${stderrTail.trim() ? `\n${stderrTail.trim()}` : ''}${hint}`
        )
      );
    });
  });
  // Marked handled so an early exit after readiness cannot surface as an
  // unhandled rejection; Promise.race still delivers the failure when it wins.
  exitedEarly.catch(() => undefined);

  try {
    await Promise.race([waitForTls(port, certPem, 8000), exitedEarly]);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  writeState({ pid: child.pid ?? 0, port, startedAt: Date.now() });
  spawnedPidLocal = child.pid ?? null;
  return { port, certPem, spawnedPid: child.pid ?? null };
}

/**
 * Stop a running proxy (started here or by an earlier process).
 * Returns whether a live proxy was actually stopped.
 */
export async function stopTeslaProxy(): Promise<boolean> {
  const state = readState();
  spawnedPidLocal = null;
  if (!state) return false;
  const wasAlive = isProcessAlive(state.pid);
  if (wasAlive) await terminateProcess(state.pid);
  clearState();
  return wasAlive;
}

/** Whether a live proxy is recorded (for status reporting). */
export function isTeslaProxyRunning(): boolean {
  const state = readState();
  return state !== null && isProcessAlive(state.pid);
}

