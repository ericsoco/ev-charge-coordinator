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
 * Where forwarded proxy stderr lines ([proxy] ...) are written.
 *
 * The REPL installs a sink that rewrites its prompt afterwards, so a log line
 * arriving while the user is at the prompt does not land inside the prompt text.
 * Everything else keeps the default: straight to the console.
 */
let proxyLogSink: ((text: string) => void) | null = null;

/** Install (or with null, remove) the sink for forwarded proxy output. */
export function setProxyLogSink(sink: ((text: string) => void) | null): void {
  proxyLogSink = sink;
}

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

/**
 * The local proxy could not be brought up.
 *
 * Separates "the Python process never became usable" from a failure the proxy
 * itself reported over HTTP. The CLI needs the difference: when a spawn fails --
 * a port conflict above all -- re-prompting for a password cannot help, so the
 * credential prompt must be skipped rather than asked and answered in vain.
 */
export class ProxyStartupError extends Error {}

/** Remove the ANSI colour codes the Flask dev server emits, so forwarded lines are plain text. */
function stripAnsi(text: string): string {
  return text.replaceAll(String.fromCharCode(27), '').replace(/\[[0-9;]*m/g, '');
}

/** True when the failure came with an HTTP response (i.e. from the proxy). */
function hasHttpResponse(error: unknown): error is { response: { status?: number; data?: unknown } } {
  const response = (error as { response?: { status?: number } } | null)?.response;
  return typeof response?.status === 'number';
}

/**
 * Render a proxy HTTP failure as one readable line.
 *
 * The proxy answers errors as JSON -- `{"error": ..., "details": ...}` -- and
 * `details` carries the upstream reason (a franklinwh assertion, a JSON decode
 * failure, a gateway timeout). axios's own message discards all of it: the
 * user-visible symptom of FranklinWH's backend failing was
 * "Request failed with status code 500", with nothing to tell whose fault it
 * was and no --debug flag that would have helped, since --debug only enriches
 * startup failures. Non-HTTP failures (ECONNREFUSED, timeouts) never reach this
 * function; their own messages are already specific.
 */
export function describeProxyHttpError(error: unknown): string {
  if (!hasHttpResponse(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const status = error.response.status;
  const data = error.response.data;
  let detail = '';
  if (data !== null && typeof data === 'object') {
    const body = data as { error?: unknown; details?: unknown };
    detail = [body.error, body.details]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(': ');
  } else if (typeof data === 'string') {
    detail = data.trim().slice(0, 200);
  }
  const fallback = error instanceof Error ? error.message : String(error);
  return detail ? `HTTP ${status} — ${detail}` : `HTTP ${status} — ${fallback}`;
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
      // The proxy's worst case is three attempts plus retry sleeps, and a
      // queued request also waits its turn behind the proxy's loop lock.
      // At 30s axios could cut it off mid-retry with a timeout error that
      // hides the real upstream failure.
      timeout: 60000,
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
   *
   * Readiness is detected from `Running on`, which Werkzeug prints only after
   * the socket is bound. The script's own "Starting FranklinWH API Proxy" line
   * used to count as well, but it is printed *before* app.run(): a bind failure
   * (EADDRINUSE) happened after it, so the child was declared started, the exit
   * handler stayed silent, and describeProxyExit -- the message that names the
   * port and the command that frees it -- never ran. The user saw a bare HTTP
   * error from whatever already squatted the port instead, and was prompted for
   * a password that was never the problem.
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
      const noteStarted = () => {
        if (started) return;
        started = true;
        // Give it a moment to fully start
        setTimeout(() => resolve(), 500);
      };

      this.proxyProcess.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('Running on')) noteStarted();
      });

      // Two jobs, one stream:
      // 1. Keep a bounded tail so a fast failure can explain itself -- Flask
      //    writes startup output and tracebacks to stderr, and without this the
      //    only signal would be a bare exit code or the generic timeout.
      // 2. Once started, forward every line to the console as `[proxy] ...`.
      //    Post-startup stderr used to accumulate in an in-memory buffer that
      //    nothing ever read again: request logs and crash tracebacks were
      //    invisible, unbounded, and gone when the session ended. Startup-era
      //    lines are not forwarded -- the banner is noise, and a pre-bind
      //    traceback belongs to describeProxyExit below.
      const STDERR_TAIL_MAX = 4096;
      let stderrTail = '';
      let partialLine = '';
      this.proxyProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
        partialLine += text;
        const lines = partialLine.split('\n');
        partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (/Running on|Press CTRL\+C/.test(line)) {
            noteStarted();
            continue;
          }
          if (started && !/WARNING: This is a development server/.test(line)) {
            const clean = stripAnsi(line);
            const formatted = `[proxy] ${clean}`;
            if (proxyLogSink) proxyLogSink(formatted);
            else console.log(formatted);
          }
        }
      });

      this.proxyProcess.on('error', (err) => {
        if (!started) {
          reject(new ProxyStartupError(`Failed to start proxy using ${source}: ${err.message}`));
        }
      });

      this.proxyProcess.on('exit', (code) => {
        if (!started) {
          reject(new ProxyStartupError(describeProxyExit(code, stderrTail, this.proxyPort, source)));
        }
        this.proxyProcess = null;
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!started) {
          this.stopProxy();
          const tail = stderrTail.trim().slice(-300);
          reject(
            new ProxyStartupError(
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

  /**
   * GET a proxy route, rethrowing HTTP failures as one readable line.
   *
   * The proxy's JSON body carries `details` with the upstream reason; axios's
   * default message ("Request failed with status code 500") drops it, which is
   * how a FranklinWH backend outage reached the user as a bare 500 with no way
   * to tell whose fault it was. The original error stays attached as `cause`.
   *
   * `/auth` deliberately does NOT go through here: the startup path reads the
   * raw response shape (`describeFranklinFailure`) to distinguish a credentials
   * problem from an outage, and wrapping would hide it.
   */
  private async getProxy<T>(url: string): Promise<T> {
    try {
      const response = await this.client.get<T>(url);
      return response.data;
    } catch (error) {
      if (!hasHttpResponse(error)) throw error;
      throw new Error(describeProxyHttpError(error), { cause: error });
    }
  }

  async getStateOfCharge(): Promise<number> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const data = await this.getProxy<{ battery_soc: number }>('/soc');
    return data.battery_soc;
  }

  async getStats(): Promise<BatteryFullStats> {
    if (!this.authenticated) {
      throw new Error('Not authenticated with FranklinWH');
    }

    const data = await this.getProxy<FranklinStatsResponse>('/stats');

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
