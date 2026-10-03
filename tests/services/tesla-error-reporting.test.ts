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
