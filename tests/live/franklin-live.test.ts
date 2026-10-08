/**
 * Live FranklinWH round trip through the token-checked proxy.
 *
 * Gated behind RUN_LIVE_TESTS=1 (the repo-wide convention): everything else,
 * including the proxy smoke suite, must run without credentials or network
 * access to Franklin. Credentials come from environment variables only --
 * the suite force-disables the keychain, so there is nothing stored to read.
 *
 *   RUN_LIVE_TESTS=1 \
 *   FRANKLIN_USERNAME=... FRANKLIN_PASSWORD=... FRANKLIN_GATEWAY_ID=... \
 *   npm test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROXY_SCRIPT = path.join(PROJECT_ROOT, 'python/franklin_proxy.py');
const PROXY_PORT = 3403;
const TOKEN = 'live-test-token';
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

const USERNAME = process.env.FRANKLIN_USERNAME;
const PASSWORD = process.env.FRANKLIN_PASSWORD;
const GATEWAY_ID = process.env.FRANKLIN_GATEWAY_ID;
const runLive = process.env.RUN_LIVE_TESTS === '1' && Boolean(USERNAME && PASSWORD && GATEWAY_ID);

const suite = runLive ? describe : describe.skip;
if (process.env.RUN_LIVE_TESTS === '1' && !runLive) {
  // Skipped for a reason the user should see rather than a silent green.
  console.warn(
    'live Franklin test skipped: set FRANKLIN_USERNAME, FRANKLIN_PASSWORD, FRANKLIN_GATEWAY_ID'
  );
}

suite('live FranklinWH through the token-checked proxy', () => {
  let proxy: ChildProcess | null = null;

  beforeAll(async () => {
    const venvPython = path.join(PROJECT_ROOT, '.venv/bin/python');
    let stderr = '';
    proxy = spawn(venvPython, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        FRANKLIN_PROXY_TOKEN: TOKEN,
        FRANKLIN_PROXY_PORT: String(PROXY_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const deadline = Date.now() + 30_000;
    while (!stderr.includes('Running on')) {
      if (Date.now() > deadline) throw new Error(`proxy did not start:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 60_000);

  afterAll(async () => {
    if (proxy && proxy.exitCode === null) {
      proxy.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it('authenticates and reads the battery SoC with a valid token', async () => {
    const auth = await fetch(`${BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': TOKEN },
      body: JSON.stringify({
        username: USERNAME,
        password: PASSWORD,
        gateway_id: GATEWAY_ID,
      }),
    });
    expect(auth.status).toBe(200);

    // Three attempts: Franklin's result:null flakiness is retried by the proxy,
    // but a live run is also the one place upstream being fully down is visible.
    let soc: number | undefined;
    for (let attempt = 0; attempt < 3 && soc === undefined; attempt++) {
      const res = await fetch(`${BASE}/soc`, { headers: { 'X-Proxy-Token': TOKEN } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { battery_soc?: number };
      if (typeof body.battery_soc === 'number') soc = body.battery_soc;
      else await new Promise((r) => setTimeout(r, 1_500));
    }
    expect(soc).toBeTypeOf('number');
  }, 60_000);

  it('still rejects the same read without the token', async () => {
    const res = await fetch(`${BASE}/soc`);
    expect(res.status).toBe(401);
  }, 15_000);
});
