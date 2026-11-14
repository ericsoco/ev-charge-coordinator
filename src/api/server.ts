/**
 * Display-only read API hosted in the daemon (design §7 HTTP seam): express
 * on loopback, bearer auth on every /api route, CORS for the Vite dev origin,
 * optional static web/dist. Read-only by construction in P2 step 2 — no
 * control endpoints; the actuator rides app.locals for the start/stop
 * fast-follow.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { credentialStore } from '../utils/credentials.js';
import { ApiError } from './ApiError.js';
import { readMessages, readNow, readSessions } from './reads.js';
import { parseSeriesParams, querySeries } from './series.js';
import * as pushStore from '../store/PushSubscriptionStore.js';
import type { PushSubscribeRequest } from './types.js';

/** The Vite dev origin (P2 step 1's dev server); prod is same-origin. */
export const DEV_ORIGIN = 'http://localhost:5173';
/** Port 3002 — pinned by the step-1 dev proxy (/api → 127.0.0.1:3002). */
export const DEFAULT_API_PORT = 3002;

/**
 * Design §7 seam: the actuator surface an HTTP handler wraps. Step 2 wires it
 * through (app.locals.actuator) and registers NO control routes — start/stop
 * is the fast-follow.
 */
export interface ActuatorPort {
  setChargeLimit(percent: number): Promise<void>;
  startCharging(): Promise<void>;
  stopCharging(): Promise<void>;
}

/** TCP port: env ECC_API_PORT (0 = ephemeral, for tests) or 3002. */
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ECC_API_PORT;
  if (raw === undefined || raw === '') return DEFAULT_API_PORT;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65_535) {
    throw new Error(`ECC_API_PORT must be an integer 0-65535 (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

/** The bearer token: an explicit override (tests) or the credential store. */
export async function resolveApiToken(override?: string): Promise<string> {
  return override ?? (await credentialStore.ensureApiToken());
}

/** Constant-time compare (hash first so lengths never leak). */
function tokensMatch(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function requireBearer(token: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      if (tokensMatch(header.slice('Bearer '.length), token)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
  };
}

/**
 * CORS for the Vite dev origin only — prod serves same-origin behind the
 * tunnel and needs none. Preflight is answered here so OPTIONS never needs
 * the token (browsers omit Authorization on preflight).
 */
function devCors(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.origin === DEV_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', DEV_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Handler wrapper: ApiError → its status, anything else → 500. Async-safe. */
function route(
  handler: (req: Request, res: Response) => void | Promise<void>
): RequestHandler {
  const fail = (res: Response, error: unknown): void => {
    if (res.headersSent) return;
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  };
  return (req, res) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch((error) => fail(res, error));
    } catch (error) {
      fail(res, error);
    }
  };
}

/** Served at `/` while web/dist has not been built (step 1 lands separately). */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ev-charge-coordinator</title></head>
<body>
  <h1>ev-charge-coordinator read API</h1>
  <p>The web UI is not built yet (<code>web/dist</code> is missing).</p>
  <p>API base: <code>/api</code> — bearer token required. See <code>docs/api.md</code>.</p>
</body>
</html>
`;

/** <repo>/web/dist — same depth from src/api (dev) and dist/api (built). */
function defaultWebDistDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

export interface ApiAppOptions {
  db: DatabaseSync;
  token: string;
  /** VIN for EV reads; undefined (no Tesla) → vehicle/session fields null. */
  vehicleId?: string;
  /** Directory served at `/` when it exists; defaults to <repo>/web/dist. */
  webDistDir?: string;
  /** Design §7 seam — retained on app.locals; no control route reads it yet. */
  actuator?: ActuatorPort;
  nowMs?: () => number;
  /**
   * VAPID keypair provider for GET /api/push/public-key (P2 step 7).
   * Defaults to the credential store (mint-on-first-use); tests inject.
   */
  vapidKeys?: () => Promise<{ publicKey: string; privateKey: string }>;
}

export function createApiApp(options: ApiAppOptions): Application {
  const app = express();
  const nowMs = options.nowMs ?? Date.now;
  const vapidKeys = options.vapidKeys ?? (() => credentialStore.ensureVapidKeys());

  // Design §7: the wrapped actuator waits here for the start/stop fast-follow;
  // step 2 registered no control routes (GET-only reads below). Step 7 added
  // the push subscription POSTs — app plumbing, still no vehicle control.
  app.locals.actuator = options.actuator ?? null;

  app.use(devCors);
  app.use('/api', requireBearer(options.token));
  // Step 7's push POSTs carry JSON bodies; query-string reads pass through
  // this parser untouched.
  app.use('/api', express.json());

  app.get(
    '/api/now',
    route((_req, res) => {
      res.json(readNow({ db: options.db, vehicleId: options.vehicleId, nowMs }));
    })
  );

  app.get(
    '/api/series',
    route((req, res) => {
      res.json(querySeries(options.db, parseSeriesParams(req.query)));
    })
  );

  app.get(
    '/api/sessions',
    route((req, res) => {
      res.json(readSessions(options.db, req.query));
    })
  );

  app.get(
    '/api/messages',
    route((req, res) => {
      res.json(readMessages(options.db, req.query));
    })
  );

  // Web Push plumbing (P2 step 7): key distribution + subscription storage.
  app.get(
    '/api/push/public-key',
    route(async (_req, res) => {
      const { publicKey } = await vapidKeys();
      res.json({ publicKey });
    })
  );

  app.post(
    '/api/push/subscribe',
    route((req, res) => {
      const body = req.body as Partial<PushSubscribeRequest> | undefined;
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
      const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
      const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
      if (endpoint === '' || p256dh === '' || auth === '') {
        throw new ApiError(
          400,
          'body must be { endpoint, keys: { p256dh, auth } } with non-empty strings'
        );
      }
      // Upsert: a device re-subscribing rotates its keys, never duplicates.
      pushStore.upsertSubscription(options.db, { endpoint, p256dh, auth, createdTsMs: nowMs() });
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/push/unsubscribe',
    route((req, res) => {
      const body = req.body as { endpoint?: unknown } | undefined;
      if (typeof body?.endpoint !== 'string' || body.endpoint === '') {
        throw new ApiError(400, 'body must be { endpoint }');
      }
      // Idempotent: dropping an unknown endpoint still answers ok.
      pushStore.removeSubscription(options.db, body.endpoint);
      res.json({ ok: true });
    })
  );

  // JSON 404 for anything else under /api — unknown paths AND verbs no route
  // registered (still no vehicle-control endpoints; the actuator waits above).
  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.baseUrl}${req.path}` });
  });

  // JSON for errors that escape a route (e.g. express.json's parse failure on
  // a malformed POST body), so the /api contract never answers HTML.
  app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status =
      typeof err === 'object' &&
      err !== null &&
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  const distDir = options.webDistDir ?? defaultWebDistDir();
  const indexFile = path.join(distDir, 'index.html');
  if (fs.existsSync(indexFile)) {
    app.use(express.static(distDir));
    // SPA fallback: non-API GETs get the app shell (client-side routing).
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(indexFile);
    });
  } else {
    app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(PLACEHOLDER_HTML);
    });
  }

  return app;
}

export interface ApiServerOptions extends ApiAppOptions {
  /** TCP port; 0 = ephemeral (tests). Default: resolveApiPort() (ECC_API_PORT ?? 3002). */
  port?: number;
}

export interface ApiServerHandle {
  /** The bound port (differs from the request when port was 0). */
  port: number;
  /** Stop accepting connections, drain, destroy keep-alives. */
  close(): Promise<void>;
}

/** Bind loopback only; rejects on bind failure (e.g. EADDRINUSE). */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const app = createApiApp(options);
  const requested = options.port ?? resolveApiPort();
  // No listen callback: express routes listen ERRORS into the callback
  // (once-wrapped) when one is passed, which would swallow EADDRINUSE here.
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(requested, '127.0.0.1');
    listening.once('listening', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requested;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets (fetch agents) would otherwise hold close() open.
        server.closeAllConnections();
      }),
  };
}

