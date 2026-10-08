/**
 * Phase 3 proxy security smoke test.
 *
 * Builds a temp venv from python/requirements.txt (cached in the OS tmpdir so
 * only the first run pays pip -- and so the pin in that file is exactly what
 * gets installed), boots the real Flask proxy on a non-default port, and
 * asserts the Phase 3 contract end to end:
 *
 *  - /health answers 200 without a token and without gateway_id
 *  - protected routes reject missing and wrong tokens (401 naming the token)
 *  - a correct token without /auth falls through to require_client, proving
 *    the decorator order
 *  - the proxy refuses to boot without FRANKLIN_PROXY_TOKEN
 *  - the proxy refuses a non-loopback FRANKLIN_PROXY_HOST
 *  - /shutdown replies 200 and the process exits with code 0 (no os._exit)
 *
 * No FranklinWH credentials are used: /auth is never called. Skips when
 * python3 is unavailable; the first run on a new machine needs network for pip.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(PROJECT_ROOT, 'python/franklin_proxy.py');
const VENV_DIR = path.join(os.tmpdir(), 'ecc-proxy-smoke-venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin/python');
const PROXY_PORT = 3401; // non-default: a live session on 3001 must be untouched
const TOKEN = 'smoke-test-token';
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

function pythonAvailable(): boolean {
  return spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Create the cached venv from requirements.txt; only the first run downloads. */
function ensureVenv(): void {
  if (!existsSync(VENV_PYTHON)) {
    const created = spawnSync('python3', ['-m', 'venv', VENV_DIR], { encoding: 'utf8' });
    if (created.status !== 0) {
      throw new Error(`python3 -m venv failed:\n${created.stderr ?? ''}`);
    }
  }
  // The first run downloads every wheel, and a transient network failure is
  // not worth failing the suite over -- one retry, with pip's output captured
  // (stdio inherit would vanish into vitest's report and leave only this
  // message to debug from).
  let installed = pipInstall();
  if (installed.status !== 0) installed = pipInstall();
  if (installed.status !== 0) {
    throw new Error(
      `pip install -r python/requirements.txt failed:\n${installed.stdout ?? ''}${installed.stderr ?? ''}`
    );
  }
}

function pipInstall() {
  return spawnSync(
    VENV_PYTHON,
    ['-m', 'pip', 'install', '-q', '-r', path.join(PROJECT_ROOT, 'python/requirements.txt')],
    { encoding: 'utf8', timeout: 300_000 }
  );
}

interface SpawnedProxy {
  child: ChildProcess;
  stderr: () => string;
}

function spawnProxy(env: Record<string, string | undefined>): SpawnedProxy {
  let stderr = '';
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    // undefined deletes: the refusal tests must not inherit a token the
    // developer happens to have exported in their shell.
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn(VENV_PYTHON, [PROXY_SCRIPT], {
    env: childEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  return { child, stderr: () => stderr };
}

async function waitForExit(child: ChildProcess, ms: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitUntil(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const suite = pythonAvailable() ? describe : describe.skip;

suite('proxy security smoke (Phase 3)', () => {
  let proxy: SpawnedProxy | null = null;

  beforeAll(async () => {
    ensureVenv();
    proxy = spawnProxy({
      FRANKLIN_PROXY_TOKEN: TOKEN,
      FRANKLIN_PROXY_PORT: String(PROXY_PORT),
    });
    await waitUntil(
      () => (proxy?.stderr() ?? '').includes('Running on'),
      30_000,
      'proxy to report Running on'
    );
  }, 240_000);

  afterAll(async () => {
    if (proxy?.child.exitCode === null) {
      proxy.child.kill('SIGKILL');
      await waitForExit(proxy.child, 5_000);
    }
  });

  it('serves /health without a token and without gateway_id', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    // Phase 3 item 2: the site id is account data no caller uses.
    expect(body).not.toHaveProperty('gateway_id');
  }, 15_000);

  it('rejects a protected route with no token, naming the token', async () => {
    const res = await fetch(`${BASE}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'self_consumption' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('X-Proxy-Token');
  }, 15_000);

  it('rejects a wrong token the same way', async () => {
    const res = await fetch(`${BASE}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': 'wrong' },
      body: JSON.stringify({ mode: 'self_consumption' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('X-Proxy-Token');
  }, 15_000);

  it('checks the token before require_client (decorator order)', async () => {
    // With the right token but no /auth, the answer must be require_client's
    // message, not the token's -- an unauthenticated caller learns nothing and
    // an authorized one reaches the next layer.
    const res = await fetch(`${BASE}/soc`, { headers: { 'X-Proxy-Token': TOKEN } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('Not authenticated');
  }, 15_000);

  it('refuses to boot without FRANKLIN_PROXY_TOKEN', async () => {
    const child = spawnProxy({ FRANKLIN_PROXY_TOKEN: undefined, FRANKLIN_PROXY_PORT: '3402' });
    const code = await waitForExit(child.child, 15_000);
    expect(code).not.toBe(0);
    expect(child.stderr()).toContain('FRANKLIN_PROXY_TOKEN is not set');
  }, 20_000);

  it('refuses a non-loopback bind', async () => {
    const child = spawnProxy({
      FRANKLIN_PROXY_TOKEN: TOKEN,
      FRANKLIN_PROXY_PORT: '3402',
      FRANKLIN_PROXY_HOST: '0.0.0.0',
    });
    const code = await waitForExit(child.child, 15_000);
    expect(code).not.toBe(0);
    expect(child.stderr()).toContain('Refusing to bind');
  }, 20_000);

  it('shuts down on /shutdown with a clean exit code, not os._exit', async () => {
    // Last on purpose: it stops the proxy the suite boots.
    const res = await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      headers: { 'X-Proxy-Token': TOKEN },
    });
    expect(res.status).toBe(200);
    const code = await waitForExit(proxy!.child, 10_000);
    expect(code).toBe(0);
    // A hard kill or crash would leave a mark in stderr.
    expect(proxy!.stderr()).not.toContain('Traceback');
  }, 20_000);
});
