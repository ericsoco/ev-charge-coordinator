/**
 * Where vehicle commands go: the signed-command proxy when one is configured,
 * the plain Fleet client otherwise.
 *
 * The adapter is the seam (same pattern as tesla-error-reporting): it records
 * exactly where axios was about to send each request, including which client
 * (Fleet vs proxy) and which https agent, without opening a socket.
 */
import { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertVehicleCommandAccepted,
  TeslaService,
  type TeslaServiceConfig,
} from '../../src/services/TeslaService.js';

const VIN = '5YJTESTVIN00000000';
const FAKE_CA_PEM = '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----';

interface Recorded {
  base: string | undefined;
  url: string | undefined;
  data: unknown;
  params: unknown;
}

/** Recorded requests that were the narrow charge_state read (confirmation/getStatus). */
function chargeStateReads(recorded: Recorded[]): Recorded[] {
  return recorded.filter(
    (entry) => (entry.params as { endpoints?: unknown } | undefined)?.endpoints === 'charge_state'
  );
}

function recordOn(
  client: AxiosInstance,
  into: Recorded[],
  chargingStates: string[] = []
): void {
  let chargeReads = 0;
  client.defaults.adapter = async (config) => {
    into.push({ base: config.baseURL, url: config.url, data: config.data, params: config.params });
    // The narrow charge_state read (post-command confirmation) asks via the
    // endpoints param and gets a charging_state from the sequence; everything
    // else is answered as a wake-up poll (state online), which wakeUp accepts.
    if ((config.params as { endpoints?: unknown } | undefined)?.endpoints === 'charge_state') {
      const index = Math.min(chargeReads++, Math.max(chargingStates.length - 1, 0));
      return {
        status: 200,
        data: {
          response: {
            charge_state: {
              battery_level: 50,
              charge_limit_soc: 80,
              charging_state: chargingStates[index] ?? 'Stopped',
              charge_rate: 30,
              minutes_to_full_charge: 45,
              battery_range: 200,
            },
          },
        },
        statusText: 'OK',
        headers: {},
        config,
      };
    }
    return {
      status: 200,
      data: { result: true, response: { state: 'online' } },
      statusText: 'OK',
      headers: {},
      config,
    };
  };
}

/** A service with tokens, a VIN, and a resolver pointing at a fake proxy port. */
async function withProxyRoute(
  route: { port: number; caPem: string } | null = { port: 4443, caPem: FAKE_CA_PEM },
  serviceConfig: Partial<TeslaServiceConfig> = {},
  mainChargingStates: string[] = []
): Promise<{ service: TeslaService; main: Recorded[]; commands: Recorded[] }> {
  const service = new TeslaService({
    region: 'na',
    // Tiny window/interval so state-confirmation failures fail fast in tests.
    chargingConfirm: { windowMs: 250, intervalMs: 10 },
    commandProxy: async () => route,
    ...serviceConfig,
  });
  await service.initialize({
    clientId: 'cid',
    clientSecret: 'secret',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  });
  (service as unknown as { vin: string }).vin = VIN;

  const main: Recorded[] = [];
  const commands: Recorded[] = [];
  recordOn((service as unknown as { client: AxiosInstance }).client, main, mainChargingStates);

  // Build the proxy client through the real path (createClient + https.Agent
  // with the route's CA), then stub its adapter for recording. Skipped when
  // the resolver has no route: resolving then would throw, which is what the
  // command call itself is expected to demonstrate.
  if (route) {
    const proxyClient = await (service as unknown as {
      vehicleCommandClient: () => Promise<AxiosInstance>;
    }).vehicleCommandClient();
    recordOn(proxyClient, commands);
  }
  return { service, main, commands };
}

describe('vehicle command routing', () => {
  it('sends commands through the proxy client with the proxy CA; reads stay direct', async () => {
    const { service, main, commands } = await withProxyRoute();

    await service.setChargeLimit(60);

    // wake_up rode the direct Fleet client: the wake POST, then the light
    // state probe that confirms the car came online.
    expect(main.map((entry) => entry.url)).toEqual([
      `/api/1/vehicles/${VIN}/wake_up`,
      `/api/1/vehicles/${VIN}`,
    ]);
    for (const entry of main) {
      expect(entry.base).toBe(service.apiBaseUrl);
    }

    // ...the command rode the proxy client.
    expect(commands).toHaveLength(1);
    expect(commands[0].base).toBe('https://127.0.0.1:4443');
    expect(commands[0].url).toBe(`/api/1/vehicles/${VIN}/command/set_charge_limit`);
    // Axios serializes before the adapter; parse to compare the payload.
    expect(JSON.parse(commands[0].data as string)).toEqual({ percent: 60 });

    // The proxy client trusts exactly the proxy's self-signed certificate.
    const agent = (service as unknown as { commandRoute: { client: AxiosInstance } }).commandRoute
      .client.defaults.httpsAgent as { options?: { ca?: unknown } } | undefined;
    const ca = agent?.options?.ca;
    expect(JSON.stringify(ca)).toContain('TESTCA');
  });

  it('routes charge_start and charge_stop the same way', async () => {
    const { service, commands } = await withProxyRoute(undefined, {}, ['Charging', 'Stopped']);

    await service.startCharging();
    await service.stopCharging();

    expect(commands.map((entry) => entry.url)).toEqual([
      `/api/1/vehicles/${VIN}/command/charge_start`,
      `/api/1/vehicles/${VIN}/command/charge_stop`,
    ]);
  });

  it('resolves the proxy for every command (the alive-check/respawn runs each time)', async () => {
    let resolutions = 0;
    const { service } = await withProxyRoute(undefined, {
      commandProxy: async () => {
        resolutions += 1;
        return { port: 4443, caPem: FAKE_CA_PEM };
      },
    });

    await service.setChargeLimit(60);
    await service.setChargeLimit(65);

    // 1 pre-resolve from the harness building the recording client, then 1
    // per command — a dead sidecar is re-checked and respawned every time.
    expect(resolutions).toBe(3);
  });

  it('fails with guidance when the resolver says no proxy is available', async () => {
    const { service, commands } = await withProxyRoute(null);

    await expect(service.setChargeLimit(60)).rejects.toThrow(/signed-command sidecar/);
    expect(commands).toHaveLength(0); // never fell back to sending it unsigned
  });

  it('uses the plain Fleet client when no resolver is configured (legacy/tests)', async () => {
    const service = new TeslaService({ region: 'na' });
    await service.initialize({
      clientId: 'cid',
      clientSecret: 'secret',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    });
    (service as unknown as { vin: string }).vin = VIN;
    const main: Recorded[] = [];
    recordOn((service as unknown as { client: AxiosInstance }).client, main);

    await service.setChargeLimit(60);

    expect(main.map((entry) => entry.url)).toEqual([
      `/api/1/vehicles/${VIN}/wake_up`,
      `/api/1/vehicles/${VIN}`,
      `/api/1/vehicles/${VIN}/command/set_charge_limit`,
    ]);
    expect(main[2].base).toBe(service.apiBaseUrl);
  });

  it('maps a refused proxy connection to run-start guidance', async () => {
    const { service } = await withProxyRoute();
    const proxyClient = (service as unknown as { commandRoute: { client: AxiosInstance } })
      .commandRoute.client;
    proxyClient.defaults.adapter = async (config) => {
      throw new AxiosError('connect ECONNREFUSED 127.0.0.1:4443', 'ECONNREFUSED', config);
    };

    await expect(service.setChargeLimit(60)).rejects.toThrow(/not reachable.*start/is);
  });
});

describe('vehicle command response envelopes', () => {
  it('accepts the success envelope and bodies with no failure evidence', () => {
    expect(() => assertVehicleCommandAccepted({ response: { result: true, reason: '' } })).not.toThrow();
    expect(() => assertVehicleCommandAccepted({})).not.toThrow();
    expect(() => assertVehicleCommandAccepted(undefined)).not.toThrow();
  });

  it('accepts "already in that state" reasons as no-ops', () => {
    for (const reason of ['requested', 'is_charging', 'not_charging', 'already_set']) {
      expect(() => assertVehicleCommandAccepted({ response: { result: false, reason } })).not.toThrow();
    }
  });

  it('accepts benign reasons wrapped by the proxy, in either envelope', () => {
    // set_charge_limit reports `already_set` (limit already at target); throwing
    // on it aborted `charge-from-battery` right before the start step. The
    // proxy surfaces the car's reason in either of two shapes, both observed live.
    const wrapped = 'car could not execute command: already_set';
    expect(() =>
      assertVehicleCommandAccepted({
        response: null,
        error: wrapped,
        error_description: '',
        txid: '00000000-0000-0000-0000-000000000000',
      })
    ).not.toThrow();
    expect(() =>
      assertVehicleCommandAccepted({ response: { result: false, reason: wrapped } })
    ).not.toThrow();
    // Non-benign wrapped reasons keep the full message in both shapes, and get
    // the per-reason hint exactly as a bare Fleet reason would.
    expect(() =>
      assertVehicleCommandAccepted({
        response: { result: false, reason: 'car could not execute command: charging not allowed' },
      })
    ).toThrow('Vehicle rejected the command: car could not execute command: charging not allowed');
    expect(() =>
      assertVehicleCommandAccepted({
        response: { result: false, reason: 'car could not execute command: disconnected' },
      })
    ).toThrow(/car could not execute command: disconnected \(the vehicle is not connected to a charger\)/);
  });

  it('fails on a Fleet REST refusal, naming the reason and its meaning', () => {
    expect(() => assertVehicleCommandAccepted({ response: { result: false, reason: 'disconnected' } }))
      .toThrow(/Vehicle rejected the command: disconnected \(the vehicle is not connected to a charger\)/);
  });

  it('fails on the proxy nominal-error envelope that arrives as HTTP 200', () => {
    // Literal body shape tesla-http-proxy returns for an action the car
    // refused (e.g. charge_start while unplugged) -- nominally HTTP 200.
    const body = {
      response: null,
      error: 'car could not execute command: charging not allowed',
      error_description: '',
      txid: '00000000-0000-0000-0000-000000000000',
    };
    expect(() => assertVehicleCommandAccepted(body)).toThrow(
      /Vehicle rejected the command: car could not execute command: charging not allowed/
    );
  });
});

describe('charging-state confirmation', () => {
  it('startCharging resolves once charge_state reports Charging', async () => {
    const { service, main } = await withProxyRoute(undefined, {}, ['Charging']);

    await service.startCharging();

    expect(chargeStateReads(main)).toHaveLength(1);
  });

  it('startCharging polls through a transitional state until Charging', async () => {
    const { service, main } = await withProxyRoute(undefined, {}, ['Starting', 'Charging']);

    await service.startCharging();

    expect(chargeStateReads(main)).toHaveLength(2);
  });

  it('startCharging fails with the observed state when the car never charges', async () => {
    const { service } = await withProxyRoute(undefined, {}, ['Disconnected']);

    await expect(service.startCharging()).rejects.toThrow(
      /is not charging \(state: Disconnected\) - plug in the vehicle/
    );
  });

  it('startCharging explains a charger that provides no power', async () => {
    const { service } = await withProxyRoute(undefined, {}, ['NoPower']);

    await expect(service.startCharging()).rejects.toThrow(
      /NoPower\) - the connected charger provides no power/
    );
  });

  it('startCharging explains a charge limit at or below the battery level', async () => {
    const { service } = await withProxyRoute(undefined, {}, ['Stopped']);

    await expect(service.startCharging()).rejects.toThrow(
      /Stopped\) - check whether the charge limit is at or below the current battery level/
    );
  });

  it('stopCharging resolves once charge_state leaves Charging', async () => {
    const { service, main } = await withProxyRoute(undefined, {}, ['Stopped']);

    await service.stopCharging();

    expect(chargeStateReads(main)).toHaveLength(1);
  });

  it('stopCharging fails while the car still reports charging', async () => {
    const { service } = await withProxyRoute(undefined, {}, ['Charging']);

    await expect(service.stopCharging()).rejects.toThrow(
      /still reports charging \(state: Charging\)/
    );
  });

  it('fails from the response envelope before any state polling', async () => {
    const { service, main } = await withProxyRoute(undefined, {}, ['Charging']);
    const proxyClient = (service as unknown as { commandRoute: { client: AxiosInstance } })
      .commandRoute.client;
    proxyClient.defaults.adapter = async (config) => ({
      status: 200, // the proxy's nominal-error path is nominally HTTP 200
      data: {
        response: null,
        error: 'car could not execute command: vehicle error',
        error_description: '',
        txid: '00000000-0000-0000-0000-000000000000',
      },
      statusText: 'OK',
      headers: {},
      config,
    });

    await expect(service.startCharging()).rejects.toThrow(/car could not execute command: vehicle error/);
    expect(chargeStateReads(main)).toHaveLength(0);
  });
});

describe('wakeUp rate limiting and budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function ok(config: InternalAxiosRequestConfig, data: unknown) {
    return { status: 200, statusText: 'OK', data, headers: {}, config };
  }

  function limited(body: string, headers: Record<string, string> = {}) {
    return Object.assign(new AxiosError('Request failed with status code 429'), {
      response: { status: 429, data: body, headers, config: {} },
    });
  }

  async function wakeService() {
    const service = new TeslaService({ region: 'na' });
    await service.initialize({
      clientId: 'cid',
      clientSecret: 'secret',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    });
    (service as unknown as { vin: string }).vin = VIN;
    return service;
  }

  /** Wakes POSTs counted; wake answers 429 per `wakeFailures`, state per `state`. */
  function armWake(
    service: TeslaService,
    opts: { wakeFailures?: () => Error | null; state?: () => string } = {}
  ) {
    const urls: string[] = [];
    (service as unknown as { client: AxiosInstance }).client.defaults.adapter = async (config) => {
      urls.push(config.url ?? '');
      if (config.url?.endsWith('/wake_up')) {
        const failure = opts.wakeFailures?.() ?? null;
        if (failure) throw failure;
        return ok(config, { result: true });
      }
      return ok(config, { response: { state: opts.state?.() ?? 'online' } });
    };
    return urls;
  }

  it('sleeps the stated 429 delay without burning a wake cycle, then succeeds', async () => {
    const service = await wakeService();
    let limitedCount = 0;
    const urls = armWake(service, {
      wakeFailures: () => (limitedCount < 2 ? ((limitedCount += 1), limited('Retry in 5 seconds')) : null),
    });

    const start = Date.now();
    const waking = service.wakeUp();
    await vi.runAllTimersAsync();
    await waking;

    expect(urls.filter((url) => url.endsWith('/wake_up')).length).toBe(3);
    // Two rate-limit waits of the stated 5s each.
    expect(Date.now() - start).toBeGreaterThanOrEqual(10_000);
  });

  it('prefers the retry-after header over the body', async () => {
    const service = await wakeService();
    let limitedCount = 0;
    const urls = armWake(service, {
      wakeFailures: () =>
        limitedCount < 1 ? ((limitedCount += 1), limited('', { 'retry-after': '7' })) : null,
    });

    const start = Date.now();
    const waking = service.wakeUp();
    await vi.runAllTimersAsync();
    await waking;

    expect(urls.filter((url) => url.endsWith('/wake_up')).length).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(7_000);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('gives up with a budget error when rate-limited beyond the wake budget', async () => {
    const service = await wakeService();
    const urls = armWake(service, {
      wakeFailures: () => limited('Retry in 100 seconds'),
    });

    const waking = service.wakeUp();
    const expectation = expect(waking).rejects.toThrow(/Rate-limited for longer than the .* wake budget/);
    await vi.runAllTimersAsync();
    await expectation;
    // 100s clamps to the 60s cap: waits at t=0, t=60 land POSTs at 0/60/120;
    // the third wait (120+60=180) crosses the budget. Three POSTs, no burst.
    expect(urls.filter((url) => url.endsWith('/wake_up')).length).toBe(3);
  });

  it('bounds non-429 errors to the wake cycles and rethrows the original', async () => {
    const service = await wakeService();
    const urls: string[] = [];
    // A plain 500: not a rate limit, so every cycle is consumed.
    (service as unknown as { client: AxiosInstance }).client.defaults.adapter = async (config) => {
      urls.push(config.url ?? '');
      throw Object.assign(new AxiosError('boom'), {
        response: { status: 500, data: 'boom', headers: {}, config: {} },
      });
    };

    const waking = service.wakeUp();
    const expectation = expect(waking).rejects.toThrow('boom');
    await vi.runAllTimersAsync();
    await expectation;
    expect(urls.filter((url) => url.endsWith('/wake_up')).length).toBe(10);
  });

  it('fails loudly when the car never comes online', async () => {
    const service = await wakeService();
    const urls = armWake(service, { state: () => 'asleep' });

    const waking = service.wakeUp();
    const expectation = expect(waking).rejects.toThrow(/did not come online after 10 wake attempts/);
    await vi.runAllTimersAsync();
    await expectation;
    expect(urls.filter((url) => url.endsWith('/wake_up')).length).toBe(10);
    // The confirmation poll is the light probe, never full vehicle_data.
    expect(urls.some((url) => url.endsWith('/vehicle_data'))).toBe(false);
  });
});