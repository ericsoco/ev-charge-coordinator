/**
 * Tesla Fleet API errors surfacing through the real axios interceptor.
 *
 * These are the paths a user actually hits: an ordinary vehicle read failing
 * because the app was never registered with Tesla. `describeTeslaError` was
 * unit tested in isolation while the mapper was unreachable from these calls,
 * so the 412 reached the terminal as Tesla's bare sentence with no advice. These
 * tests drive a real axios instance through the service's own interceptors, which
 * is the only way to catch that class of wiring mistake again.
 */
import axios, { AxiosError, type AxiosInstance } from 'axios';
import { describe, expect, it } from 'vitest';
import { TeslaService } from '../../src/services/TeslaService.js';

/** Build a service whose HTTP calls fail with the given status and body. */
function serviceFailingWith(status: number, body: unknown): TeslaService {
  const service = new TeslaService({ region: 'na' });
  // The axios client is private, and the adapter is the only seam that can drive
  // the real interceptor chain without a socket.
  const client = (service as unknown as { client: AxiosInstance }).client;
  client.defaults.adapter = async (config) => {
    throw new AxiosError(
      `Request failed with status code ${status}`,
      String(status),
      config,
      undefined,
      { status, data: body, statusText: '', headers: {}, config }
    );
  };
  return service;
}

describe('TeslaService.authenticate with an unregistered app', () => {
  // The deadlock: authenticate() ends by resolving a VIN, which calls
  // listVehicles(), which 412s until the app is registered -- and registration
  // needs the client ID/secret that the CLI used to save only AFTER authenticate()
  // returned. A user who had not registered could therefore never store them.
  // authenticate() now treats that 412 as a partial success.

  /**
   * Stub out the two things authenticate() does that are not under test: the
   * token exchange, and the real HTTP callback server (which would otherwise
   * bind port 8089 and make these tests depend on machine state).
   */
  function withStubbedExchange(service: TeslaService): TeslaService {
    const internals = service as unknown as {
      exchangeCode: () => Promise<unknown>;
      waitForOAuthCallback: () => Promise<string>;
    };
    internals.exchangeCode = async () => ({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
    });
    internals.waitForOAuthCallback = async () => 'auth-code';
    return service;
  }

  it('does not throw when listing vehicles is refused with 412', async () => {
    const service = withStubbedExchange(
      serviceFailingWith(412, {
        error: 'Account 2fc1d3f9 must be registered in the current region',
      })
    );

    await expect(service.authenticate(() => {})).resolves.toBe(false);
  });

  it('flags needsRegistration so the caller can direct the user to register', async () => {
    const service = withStubbedExchange(
      serviceFailingWith(412, {
        error: 'Account 2fc1d3f9 must be registered in the current region',
      })
    );
    expect(service.needsRegistration).toBe(false);

    await service.authenticate(() => {});

    expect(service.needsRegistration).toBe(true);
    expect(service.hasVin).toBe(false);
  });

  it('still reports a real failure that registration would not fix', async () => {
    // A 500 is not the registration precondition; it must still propagate.
    const service = withStubbedExchange(serviceFailingWith(500, { error: 'boom' }));

    await expect(service.authenticate(() => {})).rejects.toThrow(/HTTP 500/);
    expect(service.needsRegistration).toBe(false);
  });
});

describe('TeslaService error reporting', () => {
  it('explains HTTP 412 on a vehicle read and points at the registration step', async () => {
    // The reported bug: after consenting in the browser, get-ev-bsoc failed with
    // "Account ... must be registered in the current region" and no guidance,
    // because registering the app is a separate step from granting consent.
    const service = serviceFailingWith(412, {
      error:
        'Account 2fc1d3f9-753b-4b9f-8648-ec112c146567 must be registered in the current ' +
        'region https://fleet-api.prd.na.vn.cloud.tesla.com',
    });
    service.setVin('5YJTESTVIN000001');

    await expect(service.getStateOfCharge()).rejects.toThrow(/pair-tesla-key/);
  });

  it('keeps the original error as cause so the response body stays available', async () => {
    const service = serviceFailingWith(412, { error: 'must be registered in the current region' });
    service.setVin('5YJTESTVIN000001');

    const thrown = await service.getStateOfCharge().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    // The cause is what makes this a diagnostic rather than a lossy string.
    expect((thrown as Error & { cause?: unknown }).cause).toBeDefined();
    expect(axios.isAxiosError((thrown as Error & { cause?: unknown }).cause)).toBe(true);
  });

  it('explains HTTP 421 as a region problem', async () => {
    const service = serviceFailingWith(421, { error: 'Misdirected Request' });
    service.setVin('5YJTESTVIN000001');

    await expect(service.getStateOfCharge()).rejects.toThrow(/region/);
  });

  it('does not wrap an error that is not an axios failure', async () => {
    // Guard against the interceptor converting unrelated throws (a coding error
    // inside the response mapper, say) into a flattened message.
    const service = new TeslaService({ region: 'na' });
    const client = (service as unknown as { client: AxiosInstance }).client;
    client.defaults.adapter = async () => {
      throw new TypeError('boom');
    };
    service.setVin('5YJTESTVIN000001');

    await expect(service.getStateOfCharge()).rejects.toThrow(TypeError);
  });
});
