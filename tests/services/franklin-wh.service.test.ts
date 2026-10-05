/**
 * Phase 0 characterization suite: FranklinWHService <-> Python proxy wire contract.
 *
 * The service talks to a local Flask proxy over axios. These tests swap the axios
 * instance for a recorder so the mapping from the proxy's snake_case payload to the
 * camelCase BatteryFullStats DTO is pinned without spawning Python.
 *
 * startProxy() is never exercised: it spawns `python3 ../../python/franklin_proxy.py`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AxiosInstance } from 'axios';
import { FranklinWHService } from '../../src/services/FranklinWHService.js';

interface RecordedCall {
  method: 'get' | 'post';
  url: string;
  body?: unknown;
}

type Handlers = Record<string, unknown | (() => unknown)>;

/** Install a fake axios client and pre-authenticate the service. */
function withFakeClient(
  service: FranklinWHService,
  handlers: Handlers,
  opts: { authenticated?: boolean; fakeProcess?: boolean } = {}
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const resolve = (method: 'get' | 'post', url: string, body?: unknown): unknown => {
    calls.push({ method, url, body });
    const handler = handlers[url];
    if (typeof handler === 'function') return (handler as () => unknown)();
    if (handler === undefined) {
      throw Object.assign(new Error(`No handler for ${method.toUpperCase()} ${url}`), {
        response: { status: 404 },
      });
    }
    return handler;
  };

  const client = {
    get: async (url: string) => ({ data: resolve('get', url) }),
    post: async (url: string, body?: unknown) => ({ data: resolve('post', url, body) }),
  };

  const internals = service as unknown as Record<string, unknown>;
  internals.client = client;
  internals.authenticated = opts.authenticated ?? true;
  if (opts.fakeProcess) {
    internals.proxyProcess = { killed: false, kill: () => true };
  }
  return calls;
}

const STATS_PAYLOAD = {
  current: {
    solar_production: 4211,
    generator_production: 0,
    generator_enabled: false,
    battery_use: -1500,
    grid_use: 120,
    home_load: 2831,
    battery_soc: 68.4,
    switch_1_load: 0,
    switch_2_load: 0,
    v2l_use: 0,
    grid_status: 'Grid On',
  },
  totals: {
    battery_charge: 18.2,
    battery_discharge: 12.7,
    grid_import: 3.4,
    grid_export: 21.9,
    solar: 34.5,
    generator: 0,
    home_use: 41.1,
    switch_1_use: 0,
    switch_2_use: 0,
    v2l_export: 0,
    v2l_import: 0,
  },
};

describe('FranklinWHService - identity', () => {
  it('reports the aPower product name and starts unauthenticated', () => {
    const service = new FranklinWHService();
    expect(service.getName()).toBe('FranklinWH aPower');
    expect(service.isAuthenticated()).toBe(false);
  });
});

describe('FranklinWHService - stats DTO mapping', () => {
  it('maps every snake_case current field to the camelCase DTO', async () => {
    const service = new FranklinWHService();
    const calls = withFakeClient(service, { '/stats': STATS_PAYLOAD });

    const { current } = await service.getStats();

    expect(calls).toEqual([{ method: 'get', url: '/stats' }]);
    expect(current).toEqual({
      solarProduction: 4211,
      generatorProduction: 0,
      generatorEnabled: false,
      batteryUse: -1500,
      gridUse: 120,
      homeLoad: 2831,
      batterySoc: 68.4,
      switch1Load: 0,
      switch2Load: 0,
      v2lUse: 0,
      gridStatus: 'Grid On',
    });
  });

  it('maps every snake_case totals field to the camelCase DTO', async () => {
    const service = new FranklinWHService();
    withFakeClient(service, { '/stats': STATS_PAYLOAD });

    const { totals } = await service.getStats();

    expect(totals).toEqual({
      batteryCharge: 18.2,
      batteryDischarge: 12.7,
      gridImport: 3.4,
      gridExport: 21.9,
      solar: 34.5,
      generator: 0,
      homeUse: 41.1,
      switch1Use: 0,
      switch2Use: 0,
      v2lExport: 0,
      v2lImport: 0,
    });
  });

  it('passes negative battery_use through unchanged (discharging is sign-encoded)', async () => {
    const service = new FranklinWHService();
    withFakeClient(service, {
      '/stats': { ...STATS_PAYLOAD, current: { ...STATS_PAYLOAD.current, battery_use: -1500 } },
    });

    const { current } = await service.getStats();
    expect(current.batteryUse).toBeLessThan(0);
  });
});

describe('FranklinWHService - state of charge', () => {
  it('reads battery_soc from GET /soc', async () => {
    const service = new FranklinWHService();
    const calls = withFakeClient(service, { '/soc': { battery_soc: 61.5 } });

    await expect(service.getStateOfCharge()).resolves.toBe(61.5);
    expect(calls).toEqual([{ method: 'get', url: '/soc' }]);
  });

  it('resolves undefined (not 0) when the proxy omits battery_soc', async () => {
    // Characterization: index.ts feeds this straight into `Math.max(0, batterySoc - buffer)`,
    // where undefined yields NaN. Pinned so Phase 4 energy math has to handle it.
    const service = new FranklinWHService();
    withFakeClient(service, { '/soc': {} });

    await expect(service.getStateOfCharge()).resolves.toBeUndefined();
  });

  it('refuses to read state of charge before authenticating', async () => {
    const service = new FranklinWHService();
    withFakeClient(service, { '/soc': { battery_soc: 50 } }, { authenticated: false });

    await expect(service.getStateOfCharge()).rejects.toThrow('Not authenticated with FranklinWH');
  });

  it('refuses to read stats before authenticating', async () => {
    const service = new FranklinWHService();
    withFakeClient(service, { '/stats': STATS_PAYLOAD }, { authenticated: false });

    await expect(service.getStats()).rejects.toThrow('Not authenticated with FranklinWH');
  });
});

describe('FranklinWHService - proxy health', () => {
  it('reports healthy only when the proxy says status ok', async () => {
    const ok = new FranklinWHService();
    withFakeClient(ok, { '/health': { status: 'ok' } }, { authenticated: false });
    await expect(ok.isProxyHealthy()).resolves.toBe(true);

    const degraded = new FranklinWHService();
    withFakeClient(degraded, { '/health': { status: 'degraded' } }, { authenticated: false });
    await expect(degraded.isProxyHealthy()).resolves.toBe(false);

    const unreachable = new FranklinWHService();
    withFakeClient(
      unreachable,
      { '/health': () => { throw new Error('ECONNREFUSED'); } },
      { authenticated: false }
    );
    await expect(unreachable.isProxyHealthy()).resolves.toBe(false);
  });
});

describe('FranklinWHService - proxy auth contract', () => {
  it('probes proxy health before authenticating', async () => {
    const service = new FranklinWHService();
    const calls = withFakeClient(
      service,
      { '/health': { status: 'ok' }, '/auth': { success: true } },
      { authenticated: false }
    );

    await service.initialize({ username: 'user@example.com', password: 'hunter2', gatewayId: 'GW12345' });

    // Characterization: /health gates startProxy(); a healthy proxy means no new process.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['get /health', 'post /auth']);
    expect((service as unknown as Record<string, unknown>).proxyProcess).toBeNull();
    expect(service.isAuthenticated()).toBe(true);
  });

  it('posts credentials using the proxy snake_case key names', async () => {
    const service = new FranklinWHService();
    const calls = withFakeClient(
      service,
      { '/health': { status: 'ok' }, '/auth': { success: true } },
      { authenticated: false }
    );

    await service.initialize({ username: 'user@example.com', password: 'hunter2', gatewayId: 'GW12345' });

    expect(calls[1]).toEqual({
      method: 'post',
      url: '/auth',
      body: { username: 'user@example.com', password: 'hunter2', gateway_id: 'GW12345' },
    });
    expect(service.isAuthenticated()).toBe(true);
  });

  it('starts unauthenticated when the proxy reports an unhealthy gate', async () => {
    // Characterization: an unreachable /health is treated as "not running" rather than
    // surfacing an error, so initialize() proceeds to startProxy() (a spawn in real use).
    const service = new FranklinWHService();
    withFakeClient(
      service,
      { '/health': { status: 'degraded' }, '/auth': { success: true } },
      { authenticated: false }
    );
    // Neutralize the spawn path so the test does not launch python3.
    (service as unknown as { startProxy(): Promise<void> }).startProxy = async () => {};

    await service.initialize({ username: 'u', password: 'p', gatewayId: 'GW' });

    expect(service.isAuthenticated()).toBe(true);
  });

  it('surfaces the proxy-provided auth error message', async () => {
    const service = new FranklinWHService();
    withFakeClient(
      service,
      { '/health': { status: 'ok' }, '/auth': { success: false, error: 'InvalidCredentials' } },
      { authenticated: false }
    );

    await expect(
      service.initialize({ username: 'u', password: 'p', gatewayId: 'GW' })
    ).rejects.toThrow('InvalidCredentials');
    expect(service.isAuthenticated()).toBe(false);
  });

  it('falls back to a generic message when the proxy reports failure without one', async () => {
    const service = new FranklinWHService();
    withFakeClient(
      service,
      { '/health': { status: 'ok' }, '/auth': { success: false } },
      { authenticated: false }
    );

    await expect(
      service.initialize({ username: 'u', password: 'p', gatewayId: 'GW' })
    ).rejects.toThrow('Authentication failed');
  });
});

describe('FranklinWHService - shutdown', () => {
  it('asks the proxy to shut down and clears auth state', async () => {
    const service = new FranklinWHService();
    const calls = withFakeClient(service, { '/shutdown': { status: 'bye' } }, { fakeProcess: true });

    await service.disconnect();

    expect(calls).toEqual([{ method: 'post', url: '/shutdown' }]);
    expect(service.isAuthenticated()).toBe(false);
  });

  it('still kills the process when the shutdown endpoint is unavailable', async () => {
    // Characterization: POST /shutdown failing is swallowed, then SIGTERM is sent.
    let killed: string | undefined;
    const service = new FranklinWHService();
    const calls = withFakeClient(service, {}, { fakeProcess: true });
    (service as unknown as Record<string, unknown>).proxyProcess = {
      killed: false,
      kill: (signal: string) => {
        killed = signal;
        return true;
      },
    };

    await service.disconnect();

    expect(killed).toBe('SIGTERM');
    expect(calls).toEqual([{ method: 'post', url: '/shutdown' }]);
  });
});

describe('FranklinWHService proxy lifecycle when authentication is rejected', () => {
  // `initialize()` spawns the proxy BEFORE authenticating, so a wrong password used
  // to leave the child running. The CLI's error path then set the service to null,
  // discarding the only handle to it -- so the orphan kept listening on the port
  // with no runtime.json recording it. `exit` was then correct to report nothing to
  // stop while a stray Python process survived.
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-franklin-auth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Service whose /health and /auth are stubbed; records the URLs requested. */
  function serviceWithAuthFailure() {
    const service = new FranklinWHService(3999);
    const calls: string[] = [];
    const client = (service as unknown as { client: AxiosInstance }).client;
    client.defaults.adapter = async (config) => {
      const url = config.url ?? '';
      calls.push(url);
      const reply = (data: unknown): never => ({
        status: 200,
        statusText: 'OK',
        data,
        headers: {},
        config,
      }) as never;
      if (url === '/health') {
        // Healthy: attachOrStartProxy() therefore takes the "someone else owns it"
        // path instead of spawning, which is what the attached-proxy case needs.
        return reply({ status: 'ok' });
      }
      if (url === '/auth') {
        // What the proxy answers for a wrong password.
        return reply({ success: false, error: 'Invalid credentials' });
      }
      return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };
    return { service, calls };
  }

  /** Pretend a spawn already happened, with an observable child handle. */
  function pretendSpawned(service: FranklinWHService): { wasKilled: () => boolean } {
    let killed = false;
    const internals = service as unknown as {
      attachedToExistingProxy: boolean;
      ownsProxyProcess: boolean;
      proxyProcess: unknown;
    };
    internals.attachedToExistingProxy = false;
    internals.ownsProxyProcess = true;
    internals.proxyProcess = {
      kill: () => {
        killed = true;
      },
    };
    return { wasKilled: () => killed };
  }

  it('stops the child it spawned when authentication is rejected', async () => {
    const { service } = serviceWithAuthFailure();
    const child = pretendSpawned(service);

    await expect(
      service.initialize({ username: 'u@example.com', password: 'wrong', gatewayId: 'GW1' })
    ).rejects.toThrow(/Invalid credentials/);

    // Nobody else knows about this child, so leaving it running orphans a process
    // that `exit` can never reach.
    expect(child.wasKilled()).toBe(true);
  });

  it('leaves a proxy it did not start alone when authentication is rejected', async () => {
    const { service, calls } = serviceWithAuthFailure();
    const internals = service as unknown as { attachedToExistingProxy: boolean };
    // Attached to somebody else's healthy proxy: stopping it would break the
    // `start` that owns it.
    internals.attachedToExistingProxy = true;

    await expect(
      service.initialize({ username: 'u@example.com', password: 'wrong', gatewayId: 'GW1' })
    ).rejects.toThrow(/Invalid credentials/);

    expect(calls).not.toContain('/shutdown');
  });
});
