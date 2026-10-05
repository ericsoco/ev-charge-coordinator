/**
 * FranklinWH Battery Service
 * 
 * Communicates with the FranklinWH API through the Python proxy server.
 */

import axios, { AxiosInstance } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  BatteryService,
  BatteryCredentials,
  BatteryFullStats,
  BatteryCurrentStats,
  BatteryTotals
} from '../types/battery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VENV_FIX = 'python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt';

/**
 * Locate a Python interpreter that can run the proxy.
 *
 * Order is deliberate: the project-local .venv first, because that is where
 * `python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt`
 * puts the dependencies, while a globally installed franklinwh may be missing or
 * a different version. $ECC_PYTHON lets an operator point at an interpreter
 * elsewhere. Plain `python3` is the last resort, and it is also the option that
 * produces the most common failure, which is why hardcoding it was not enough.
 */
function resolvePythonInterpreter(): { command: string; source: string } {
  const venvPython = path.join(__dirname, '../../.venv/bin/python');
  if (fs.existsSync(venvPython)) {
    return { command: venvPython, source: 'the project .venv' };
  }
  const override = process.env.ECC_PYTHON;
  if (override) {
    return { command: override, source: 'ECC_PYTHON' };
  }
  return { command: 'python3', source: 'the system python3' };
}

/**
 * Turn a proxy exit into something the user can act on.
 *
 * The old code reported only `Proxy exited with code 1`, which is useless: the two
 * failures that actually happen -- the port already being taken, and the
 * `franklinwh` package missing -- look identical from the outside. Both are
 * detected from the traceback Flask wrote to stderr, and each carries the exact
 * command that fixes it.
 */
function describeProxyExit(
  code: number | null,
  stderrOutput: string,
  port: number,
  source: string
): string {
  const head = `Proxy exited with code ${code ?? 'unknown'} (using ${source}, port ${port}).`;

  if (/Address already in use|Errno 98|EADDRINUSE/i.test(stderrOutput)) {
    return (
      `${head}\n` +
      `  Port ${port} is already in use by another process.\n` +
      `  Stop it with: lsof -ti tcp:${port} | xargs kill`
    );
  }

  if (/franklinwh/i.test(stderrOutput) && /ModuleNotFoundError|No module named/i.test(stderrOutput)) {
    return `${head}\n  The franklinwh package is missing.\n  Fix: ${VENV_FIX}`;
  }

  if (/No module named ['"]?flask/i.test(stderrOutput)) {
    return `${head}\n  Flask is missing.\n  Fix: ${VENV_FIX}`;
  }

  // Anything else: the traceback tail beats a bare exit code even when it is not
  // one of the cases above.
  const tail = stderrOutput.trim().slice(-400);
  return tail ? `${head}\n  ${tail}` : `${head}\n  The proxy produced no output.`;
}

interface FranklinStatsResponse {
  current: {
    solar_production: number;
    generator_production: number;
    generator_enabled: boolean;
    battery_use: number;
    grid_use: number;
    home_load: number;
    battery_soc: number;
    switch_1_load: number;
    switch_2_load: number;
    v2l_use: number;
    grid_status: string;
  };
  totals: {
    battery_charge: number;
    battery_discharge: number;
    grid_import: number;
    grid_export: number;
    solar: number;
    generator: number;
    home_use: number;
    switch_1_use: number;
    switch_2_use: number;
    v2l_export: number;
    v2l_import: number;
  };
}

export class FranklinWHService implements BatteryService {
  private client: AxiosInstance;
  private proxyProcess: ChildProcess | null = null;
  private authenticated = false;
  private proxyPort: number;
  /**
   * Whether *this instance* spawned the proxy.
   *
   * The distinction the old code did not make. `disconnect()` called
   * `stopProxy()` unconditionally, so a one-shot `get-battery-soc` would kill a
   * proxy that a resident `start` owned, and the next command paid a full cold
   * start.
   */
  private ownsProxyProcess = false;
  /** True when we attached to a proxy that someone else started. */
  private attachedToExistingProxy = false;

  constructor(proxyPort = 3001) {
    this.proxyPort = proxyPort;
    this.client = axios.create({
      baseURL: `http://127.0.0.1:${proxyPort}`,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  getName(): string {
    return 'FranklinWH aPower';
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Start the Python proxy server.
   */
  async startProxy(): Promise<void> {
    if (this.proxyProcess) {
      return; // Already running
    }

    const pythonScript = path.join(__dirname, '../../python/franklin_proxy.py');
    const { command, source } = resolvePythonInterpreter();
    
    return new Promise((resolve, reject) => {
      this.proxyProcess = spawn(command, [pythonScript], {
        env: {
          ...process.env,
          FRANKLIN_PROXY_PORT: String(this.proxyPort)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let started = false;

      this.proxyProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (output.includes('Starting FranklinWH API Proxy') || output.includes('Running on')) {
          if (!started) {
            started = true;
            // Give it a moment to fully start
            setTimeout(() => resolve(), 500);
          }
        }
      });

      // Buffer stderr so a fast failure can explain itself. Flask writes its startup
      // output and tracebacks to stderr, and without this the only signal is a
      // bare exit code or the generic timeout below.
      let stderrOutput = '';
      this.proxyProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderrOutput += output;
        // Flask outputs to stderr, check for running message
        if (output.includes('Running on') || output.includes('Press CTRL+C')) {
          if (!started) {
            started = true;
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.proxyProcess.on('error', (err) => {
        if (!started) {
          reject(new Error(`Failed to start proxy using ${source}: ${err.message}`));
        }
      });

      this.proxyProcess.on('exit', (code) => {
        if (!started) {
          reject(new Error(describeProxyExit(code, stderrOutput, this.proxyPort, source)));
        }
        this.proxyProcess = null;
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!started) {
          this.stopProxy();
          const tail = stderrOutput.trim().slice(-300);
          reject(
            new Error(
              `Proxy did not start within 10s (using ${source}, port ${this.proxyPort}).\n` +
                (tail ? `  ${tail}\n` : '') +
                `  If the Python dependencies are missing: ${VENV_FIX}`
            )
          );
        }
      }, 10000);
    });
  }

  /**
   * Stop the Python proxy server.
   *
   * Only kills a process this instance spawned. A proxy that was already running
   * when we attached belongs to someone else -- typically a resident `start` --
   * and stopping it here is how a one-shot `get-battery-soc` used to tear down the
   * proxy the user had started.
   */
  async stopProxy(): Promise<void> {
    if (this.attachedToExistingProxy) {
      // Not ours to stop. Clear the local handles so a later attachOrStartProxy()
      // re-checks health rather than assuming a child that never existed.
      this.proxyProcess = null;
      this.attachedToExistingProxy = false;
      this.ownsProxyProcess = false;
      this.authenticated = false;
      return;
    }

    if (!this.proxyProcess) {
      return;
    }

    try {
      await this.client.post('/shutdown');
    } catch {
      // The proxy's /shutdown calls os._exit(0) when Werkzeug's shutdown hook is
      // absent, which it is on Werkzeug >= 2.1. The endpoint does stop the
      // process, but it discards the response body on the way out, so a timeout
      // here is expected rather than exceptional. The caller's SIGTERM/SIGKILL
      // escalation is what confirms the process is gone.
    }

    this.proxyProcess.kill('SIGTERM');
    this.proxyProcess = null;
    this.ownsProxyProcess = false;
    this.authenticated = false;
  }

  /**
   * Ensure a proxy is listening, and record whether we are responsible for it.
   *
   * Returns 'spawned' when this instance started the proxy and 'attached' when a
   * healthy one was already running. That distinction is what makes "run
   * get-battery-soc twice and reuse a single proxy" true, and what keeps
   * `disconnect()` from stopping somebody else's process.
   */
  async attachOrStartProxy(): Promise<'spawned' | 'attached'> {
    if (this.proxyProcess) {
      return this.ownsProxyProcess ? 'spawned' : 'attached';
    }

    if (await this.isProxyHealthy()) {
      this.attachedToExistingProxy = true;
      this.ownsProxyProcess = false;
      return 'attached';
    }

    await this.startProxy();
    this.ownsProxyProcess = true;
    this.attachedToExistingProxy = false;
    return 'spawned';
  }

  /** PID of the proxy this instance spawned, or null when it attached to one. */
  get spawnedProxyPid(): number | null {
    return this.ownsProxyProcess && this.proxyProcess?.pid ? this.proxyProcess.pid : null;
  }

  /** True when a proxy is running that this instance did not start. */
  get isAttachedProxy(): boolean {
    return this.attachedToExistingProxy;
  }

  /**
   * Check if the proxy is running and healthy.
   */
  async isProxyHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return response.data.status === 'ok';
    } catch {
      return false;
    }
  }

  async initialize(credentials: BatteryCredentials): Promise<void> {
    // Ensure a proxy is running, and record whether we own it so that
    // disconnect() can leave someone else's proxy running.
    const started = await this.attachOrStartProxy();

    // Authenticate with the proxy.
    //
    // The proxy is already running by this point, so a failure here -- a wrong
    // password above all -- used to leak it: the ChildProcess handle was the only
    // reference to the child, and the CLI's error path then discarded the whole
    // service. The orphan kept listening on the port with no runtime.json
    // recording it, so `exit` correctly reported nothing to stop while a stray
    // Python process survived. If *we* started it and authentication fails, the
    // child is of no use to anyone, so stop it before propagating the error.
    try {
      const response = await this.client.post('/auth', {
        username: credentials.username,
        password: credentials.password,
        gateway_id: credentials.gatewayId
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Authentication failed');
      }
    } catch (error) {
      if (started === 'spawned') {
        await this.stopProxy();
      }
      throw error;
    }

    this.authenticated = true;
  }

  async getStateOfCharge(): Promise<number> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const response = await this.client.get('/soc');
    return response.data.battery_soc;
  }

  async getStats(): Promise<BatteryFullStats> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const response = await this.client.get<FranklinStatsResponse>('/stats');
    const data = response.data;

    const current: BatteryCurrentStats = {
      solarProduction: data.current.solar_production,
      generatorProduction: data.current.generator_production,
      generatorEnabled: data.current.generator_enabled,
      batteryUse: data.current.battery_use,
      gridUse: data.current.grid_use,
      homeLoad: data.current.home_load,
      batterySoc: data.current.battery_soc,
      switch1Load: data.current.switch_1_load,
      switch2Load: data.current.switch_2_load,
      v2lUse: data.current.v2l_use,
      gridStatus: data.current.grid_status
    };

    const totals: BatteryTotals = {
      batteryCharge: data.totals.battery_charge,
      batteryDischarge: data.totals.battery_discharge,
      gridImport: data.totals.grid_import,
      gridExport: data.totals.grid_export,
      solar: data.totals.solar,
      generator: data.totals.generator,
      homeUse: data.totals.home_use,
      switch1Use: data.totals.switch_1_use,
      switch2Use: data.totals.switch_2_use,
      v2lExport: data.totals.v2l_export,
      v2lImport: data.totals.v2l_import
    };

    return { current, totals };
  }

  async disconnect(): Promise<void> {
    await this.stopProxy();
  }
}
