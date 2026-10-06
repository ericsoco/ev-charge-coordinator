/**
 * Franklin proxy error reporting.
 *
 * The incident: `get-battery-soc` printed "Request failed with status code 500"
 * while the proxy's JSON body carried the real upstream reason in `details`.
 * The body was discarded, the proxy logged no traceback, and proxy stderr lived
 * only in memory, so when the session ended every trace of the failure was gone.
 * These tests pin the
 * half Node controls: the body must reach the user's screen with no --debug
 * flag, while /auth must stay raw so the startup wording (5xx = "not a
 * credentials problem") keeps working.
 */
import { describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';
import type { AxiosInstance } from 'axios';
import { FranklinWHService, describeProxyHttpError } from '../../src/services/FranklinWHService.js';

/** A duck-typed axios failure carrying the proxy's error body. */
function proxyHttpError(status: number, data: unknown): Error & { response: unknown } {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

describe('describeProxyHttpError', () => {
  it('surfaces the proxy error and the upstream detail from the body', () => {
    const error = proxyHttpError(500, {
      error: 'Internal error',
      details: "AssertionError: 502: FranklinWH's backend is unavailable",
    });
    expect(describeProxyHttpError(error)).toBe(
      "HTTP 500 — Internal error: AssertionError: 502: FranklinWH's backend is unavailable"
    );
  });

  it('falls back to the status when the body carries no detail', () => {
    expect(describeProxyHttpError(proxyHttpError(502, {}))).toBe(
      'HTTP 502 — Request failed with status code 502'
    );
  });

  it('keeps a network failure wording untouched', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3001');
    expect(describeProxyHttpError(error)).toBe('connect ECONNREFUSED 127.0.0.1:3001');
  });
});

describe('FranklinWHService command reads', () => {
  /** A pre-authenticated service whose GETs reject with the given error. */
  function serviceFailingWith(error: unknown): FranklinWHService {
    const service = new FranklinWHService();
    const internals = service as unknown as Record<string, unknown>;
    internals.authenticated = true;
    internals.client = {
      get: async () => {
        throw error;
      },
      post: async () => ({ data: {} }),
    };
    return service;
  }

  it('rejects getStateOfCharge with the body, original kept as cause', async () => {
    const original = proxyHttpError(500, {
      error: 'Internal error',
      details: 'KeyError: runtimeData',
    });
    const service = serviceFailingWith(original);

    await expect(service.getStateOfCharge()).rejects.toThrow(
      'HTTP 500 — Internal error: KeyError: runtimeData'
    );

    let thrown: unknown;
    try {
      await service.getStateOfCharge();
    } catch (failure) {
      thrown = failure;
    }
    expect((thrown as { cause?: unknown }).cause).toBe(original);
  });

  it('propagates a network failure as the same object', async () => {
    const original = new Error('connect ECONNREFUSED 127.0.0.1:3001');
    const service = serviceFailingWith(original);
    await expect(service.getStateOfCharge()).rejects.toBe(original);
  });

  it('leaves /auth responses raw so the startup wording can read them', async () => {
    // index.ts's describeFranklinFailure inspects error.response.status and
    // response.data directly; wrapping /auth would destroy the verified 5xx
    // wording ("not a credentials problem").
    const service = new FranklinWHService(4999);
    const client = (service as unknown as { client: AxiosInstance }).client;
    client.defaults.adapter = async (config) => {
      const url = config.url ?? '';
      if (url === '/health') {
        return { status: 200, statusText: 'OK', data: { status: 'ok' }, headers: {}, config };
      }
      if (url === '/auth') {
        // Adapter seam: statuses >= 400 must throw an AxiosError carrying the
        // response, because a custom adapter is not run through validateStatus.
        const response = {
          status: 401,
          statusText: 'Unauthorized',
          data: { error: 'Invalid credentials', details: 'rejected by upstream' },
          headers: {},
          config,
        };
        throw new AxiosError('Request failed with status code 401', '401', config, undefined, response);
      }
      return { status: 404, statusText: 'Not Found', data: {}, headers: {}, config };
    };

    const failure = service.initialize({ username: 'u@example.com', password: 'x', gatewayId: 'GW1' });
    await expect(failure).rejects.toMatchObject({
      response: { status: 401, data: { error: 'Invalid credentials' } },
    });
  });
});
