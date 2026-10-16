/**
 * Where vehicle commands go: the signed-command proxy when one is configured,
 * the plain Fleet client otherwise.
 *
 * The adapter is the seam (same pattern as tesla-error-reporting): it records
 * exactly where axios was about to send each request, including which client
 * (Fleet vs proxy) and which https agent, without opening a socket.
 */
import { AxiosError, type AxiosInstance } from 'axios';
import { describe, expect, it } from 'vitest';
import { TeslaService } from '../../src/services/TeslaService.js';

const VIN = '5YJTESTVIN00000000';
const FAKE_CA_PEM = '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----';

interface Recorded {
  base: string | undefined;
  url: string | undefined;
  data: unknown;
}

function recordOn(client: AxiosInstance, into: Recorded[]): void {
  client.defaults.adapter = async (config) => {
    into.push({ base: config.baseURL, url: config.url, data: config.data });
    // wakeUp polls vehicle_data until state is online; answering anything else
    // makes it sleep-and-retry ten times before failing.
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
  route: { port: number; caPem: string } | null = { port: 4443, caPem: FAKE_CA_PEM }
): Promise<{ service: TeslaService; main: Recorded[]; commands: Recorded[] }> {
  const service = new TeslaService({
    region: 'na',
    commandProxy: async () => route,
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
  recordOn((service as unknown as { client: AxiosInstance }).client, main);

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

    // wake_up rode the direct Fleet client: the wake POST, then the
    // vehicle_data poll that confirms the car came online.
    expect(main.map((entry) => entry.url)).toEqual([
      `/api/1/vehicles/${VIN}/wake_up`,
      `/api/1/vehicles/${VIN}/vehicle_data`,
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
    const { service, commands } = await withProxyRoute();

    await service.startCharging();
    await service.stopCharging();

    expect(commands.map((entry) => entry.url)).toEqual([
      `/api/1/vehicles/${VIN}/command/charge_start`,
      `/api/1/vehicles/${VIN}/command/charge_stop`,
    ]);
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
      `/api/1/vehicles/${VIN}/vehicle_data`,
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