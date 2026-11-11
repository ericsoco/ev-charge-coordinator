/**
 * Read-API HTTP surface: bearer auth on every /api route, dev-origin CORS,
 * /api/now + /api/series + /api/sessions + /api/messages shapes, JSON 404s
 * (no control endpoints), static/placeholder serving, and lifecycle.
 * Offline: temp store, ephemeral port (0), injected token + clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as homeBattery from '../../src/store/HomeBatteryStore.js';
import * as evStore from '../../src/store/EvStore.js';
import * as sessionStore from '../../src/store/SessionStore.js';
import {
  DEFAULT_API_PORT,
  DEV_ORIGIN,
  createApiApp,
  resolveApiPort,
  resolveApiToken,
  startApiServer,
  type ApiServerHandle,
} from '../../src/api/server.js';

const VIN = 'VIN-TEST';
const GW = 'GW-TEST';
const TOKEN = 'test-token-123';
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

let db: DatabaseSync;
let dir: string;
let handle: ApiServerHandle;
let port: number;

interface GetOpts {
  token?: string | null; // null = no Authorization header
  headers?: Record<string, string>;
  method?: string;
}

function get(pathname: string, opts: GetOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method ?? 'GET',
    headers,
  });
}

/** Body.json() is Promise<unknown> under these types; tests assert shapes loosely. */
async function json(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-api-'));
  db = openStore(path.join(dir, 'data.sqlite'));

  for (const [tsMs, soc] of [
    [NOW - 600_000, 70],
    [NOW - 300_000, 71],
    [NOW - 50_000, 72],
  ] as const) {
    homeBattery.insertSample(db, {
      homeBatteryId: GW,
      tsMs,
      socPercent: soc,
      powerW: 100,
      homeLoadW: 500,
      solarW: 200,
      gridW: -50,
    });
  }
  for (const [tsMs, soc, chargingState] of [
    [NOW - 600_000, 50, 'Charging'],
    [NOW - 300_000, 55, 'Charging'],
    [NOW - 50_000, 60, 'Stopped'],
  ] as const) {
    evStore.insertSample(db, {
      vehicleId: VIN,
      tsMs,
      state: 'online',
      chargingState,
      socPercent: soc,
      chargeLimitSoc: 80,
    });
  }

  // Closed session with tooltip data, then a still-open one (newest first).
  const closedId = sessionStore.openSession(db, {
    vehicleId: VIN,
    homeBatteryId: GW,
    plugTsMs: NOW - 650_000,
  });
  sessionStore.closeOpenSession(db, VIN, NOW - 250_000);
  sessionStore.setSessionTarget(db, closedId, 55);
  sessionStore.setSessionTarget(db, closedId, 60, 'raised 55 → 60 (solar surplus)');
  sessionStore.setSessionStopReason(db, closedId, 'target_reached');
  sessionStore.openSession(db, { vehicleId: VIN, homeBatteryId: GW, plugTsMs: NOW - 100_000 });

  handle = await startApiServer({
    db,
    vehicleId: VIN,
    token: TOKEN,
    port: 0,
    webDistDir: path.join(dir, 'no-web-dist'),
    nowMs: () => NOW,
  });
  port = handle.port;
});

afterAll(async () => {
  await handle.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bearer auth (every /api route)', () => {
  it('401s without a header, with a wrong token, or with a non-Bearer scheme', async () => {
    for (const opts of [{ token: null }, { token: 'wrong' }, { token: null, headers: { Authorization: 'Basic dXNlcjpwdw==' } }]) {
      const res = await get('/api/now', opts);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await json(res)).toEqual({ error: 'unauthorized' });
    }
  });

  it('200s with the exact bearer token', async () => {
    const res = await get('/api/now');
    expect(res.status).toBe(200);
  });

  it('applies to every endpoint, not just /api/now', async () => {
    for (const p of ['/api/series?metric=ev_soc&from=1&to=2', '/api/sessions', '/api/messages']) {
      expect((await get(p, { token: null })).status, p).toBe(401);
    }
  });
});

describe('CORS (Vite dev origin only)', () => {
  it('answers preflight for the dev origin without needing the token', async () => {
    const res = await get('/api/now', {
      token: null,
      method: 'OPTIONS',
      headers: { Origin: DEV_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('echoes the dev origin on real requests, and nothing for other origins', async () => {
    const dev = await get('/api/now', { headers: { Origin: DEV_ORIGIN } });
    expect(dev.status).toBe(200);
    expect(dev.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);

    const other = await get('/api/now', { headers: { Origin: 'http://evil.example' } });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const none = await get('/api/now');
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('GET /api/now', () => {
  it('returns latest SoC, charging state, session summary, and freshness', async () => {
    const body = await json(await get('/api/now'));
    expect(body.nowMs).toBe(NOW);
    expect(body.vehicle).toEqual({
      vehicleId: VIN,
      socPercent: 60,
      chargingState: 'Stopped',
      chargeLimitSoc: 80,
      sampleTsMs: NOW - 50_000,
      ageMs: 50_000,
    });
    expect(body.battery).toMatchObject({ socPercent: 72, solarW: 200, ageMs: 50_000 });
    expect(body.session).toEqual({
      id: expect.any(Number),
      plugTsMs: NOW - 100_000,
      targetPercent: null,
      stopReason: null,
    });
    expect(body.session.id).not.toBe(0);
  });

  it('nulls vehicle/session for an unknown vehicle (battery still served)', async () => {
    const other = await startApiServer({
      db,
      vehicleId: 'VIN-OTHER',
      token: TOKEN,
      port: 0,
      webDistDir: path.join(dir, 'no-web-dist'),
      nowMs: () => NOW,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${other.port}/api/now`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await json(res);
      expect(body.vehicle).toBeNull();
      expect(body.session).toBeNull();
      expect(body.battery).not.toBeNull();
    } finally {
      await other.close();
    }
  });
});

describe('GET /api/series', () => {
  it('downsamples battery SoC into epoch-aligned buckets', async () => {
    const query = `metric=battery_soc&from=${NOW - 600_000}&to=${NOW + 600_000}&bucket=300000`;
    const body = await json(await get(`/api/series?${query}`));
    expect(body).toMatchObject({
      metric: 'battery_soc',
      unit: 'percent',
      aggregation: 'avg',
      bucketMs: 300_000,
      from: NOW - 600_000,
      to: NOW + 600_000,
    });
    // Absolute epoch boundaries: [NOW-600s, NOW-300s) holds only the 70
    // sample; [NOW-300s, NOW) holds 71 and the NOW-50s sample → 71.5.
    expect(body.points).toEqual([
      [NOW - 600_000, 70],
      [NOW - 300_000, 71.5],
    ]);
  });

  it('400s on unknown metrics and missing/invalid params', async () => {
    const bad = [
      'metric=nope&from=1&to=2',
      'metric=ev_soc',
      `metric=ev_soc&from=abc&to=${NOW}`,
      `metric=ev_soc&from=${NOW}&to=${NOW - 1}`,
    ];
    for (const query of bad) {
      const res = await get(`/api/series?${query}`);
      expect(res.status, query).toBe(400);
      expect((await json(res)).error).toEqual(expect.any(String));
    }
  });
});

describe('GET /api/sessions', () => {
  it('paginates newest-first with date+time labels', async () => {
    const all = await json(await get('/api/sessions'));
    expect(all.total).toBe(2);
    expect(all.limit).toBe(50);
    expect(all.offset).toBe(0);
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions[0].open).toBe(true);
    expect(all.sessions[1].open).toBe(false);
    for (const session of all.sessions) {
      expect(session.label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }

    const page = await json(await get('/api/sessions?limit=1&offset=1'));
    expect(page.total).toBe(2);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0].id).toBe(all.sessions[1].id);
  });

  it('includes target, stop_reason, and SoC start/end for tooltips', async () => {
    const body = await json(await get('/api/sessions'));
    const open = body.sessions[0];
    const closed = body.sessions[1];

    // Open: start known, end deliberately null until the session closes.
    expect(open).toMatchObject({
      evSocStartPercent: 60,
      evSocEndPercent: null,
      batterySocStartPercent: 72,
      batterySocEndPercent: null,
      targetPercent: null,
      stopReason: null,
    });

    expect(closed).toMatchObject({
      targetPercent: 60,
      initialTargetPercent: 55,
      targetChangeReason: 'raised 55 → 60 (solar surplus)',
      stopReason: 'target_reached',
      evSocStartPercent: 50,
      evSocEndPercent: 55,
      batterySocStartPercent: 70,
      batterySocEndPercent: 71,
      open: false,
    });
    expect(closed.unplugTsMs).toBe(NOW - 250_000);
  });

  it('rejects bad pagination with 400', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1']) {
      const res = await get(`/api/sessions?${query}`);
      expect(res.status, query).toBe(400);
    }
  });
});

describe('GET /api/messages and /api 404s', () => {
  it('returns the final envelope with an empty list (notifications land in step 7)', async () => {
    const body = await json(await get('/api/messages'));
    expect(body).toEqual({ messages: [] });
  });

  it('404s unknown paths and non-GET verbs as JSON — no control endpoints exist', async () => {
    const unknown = await get('/api/nope');
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ error: 'no such endpoint: GET /api/nope' });

    const post = await get('/api/now', { method: 'POST' });
    expect(post.status).toBe(404);
    expect((await json(post)).error).toContain('POST /api/now');
  });
});

describe('static serving (graceful without step 1)', () => {
  it('serves a plain placeholder when web/dist is missing', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('web/dist');
  });

  it('serves the built app + SPA fallback when web/dist exists', async () => {
    const distDir = path.join(dir, 'web-dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<div id="app">seed</div>');
    fs.writeFileSync(path.join(distDir, 'app.js'), 'console.log(1)');
    const staticServer = await startApiServer({
      db,
      vehicleId: VIN,
      token: TOKEN,
      port: 0,
      webDistDir: distDir,
      nowMs: () => NOW,
    });
    try {
      const base = `http://127.0.0.1:${staticServer.port}`;
      const auth = { Authorization: `Bearer ${TOKEN}` };
      const index = await (await fetch(`${base}/`)).text();
      expect(index).toContain('<div id="app">seed</div>');
      const asset = await (await fetch(`${base}/app.js`)).text();
      expect(asset).toContain('console.log(1)');
      // Client-side route → app shell.
      const spa = await (await fetch(`${base}/then/deep`)).text();
      expect(spa).toContain('<div id="app">seed</div>');
      // /api keeps its JSON contract behind static.
      const api = await fetch(`${base}/api/now`, { headers: auth });
      expect(api.status).toBe(200);
      expect((await json(api)).nowMs).toBe(NOW);
    } finally {
      await staticServer.close();
    }
  });
});

describe('actuator seam (design §7, no control routes)', () => {
  it('parks the wrapped actuator on app.locals for the fast-follow', () => {
    const actuator = {
      setChargeLimit: async () => {},
      startCharging: async () => {},
      stopCharging: async () => {},
    };
    const withActuator = createApiApp({ db, token: TOKEN, actuator });
    expect(withActuator.locals.actuator).toBe(actuator);
    expect(createApiApp({ db, token: TOKEN }).locals.actuator).toBeNull();
  });
});

describe('port + token + lifecycle', () => {
  it('defaults to 3002, honors ECC_API_PORT, and rejects junk', () => {
    expect(resolveApiPort({})).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ ECC_API_PORT: '' })).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ ECC_API_PORT: '4001' })).toBe(4001);
    expect(resolveApiPort({ ECC_API_PORT: '0' })).toBe(0);
    expect(() => resolveApiPort({ ECC_API_PORT: 'abc' })).toThrow(/ECC_API_PORT/);
    expect(() => resolveApiPort({ ECC_API_PORT: '70000' })).toThrow(/ECC_API_PORT/);
  });

  it('prefers an explicit token override over the credential store', async () => {
    await expect(resolveApiToken('given-token')).resolves.toBe('given-token');
  });

  it('close() stops serving', async () => {
    const shortLived = await startApiServer({
      db,
      vehicleId: VIN,
      token: TOKEN,
      port: 0,
      webDistDir: path.join(dir, 'no-web-dist'),
      nowMs: () => NOW,
    });
    const url = `http://127.0.0.1:${shortLived.port}/api/messages`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(url, { headers: auth })).status).toBe(200);
    await shortLived.close();
    await expect(fetch(url, { headers: auth })).rejects.toThrow();
  });
});


