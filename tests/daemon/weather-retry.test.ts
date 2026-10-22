/**
 * Open-Meteo client retries: transient 5xx / network failures are retried
 * with the injected zero-delay backoff; a 400 fails fast; persistent failure
 * rejects after the configured attempts. Adapter-seam pattern (failures are
 * thrown as AxiosErrors, matching how axios's own adapter settles them),
 * real timers throughout.
 */
import { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { createOpenMeteoClient, fetchOpenMeteo } from '../../src/daemon/WeatherSampler.js';

const PAYLOAD = {
  hourly: { time: ['2026-10-21T00:00'], shortwave_radiation: [120.5], temperature_2m: [18.2] },
};

/** Scripted adapter: each attempt returns the next status (last repeats). */
function scriptedAdapter(
  client: AxiosInstance,
  script: (number | 'network')[]
): { calls: () => number } {
  let attempt = 0;
  let calls = 0;
  client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    calls++;
    const step = script[Math.min(attempt++, script.length - 1)];
    if (step === 'network') {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, undefined);
    }
    if (step >= 400) {
      throw new AxiosError(
        `Request failed with status code ${step}`,
        AxiosError.ERR_BAD_RESPONSE,
        config,
        undefined,
        { status: step, data: { reason: 'scripted' }, statusText: '', headers: {}, config } as never
      );
    }
    return { status: 200, data: PAYLOAD, statusText: 'OK', headers: {}, config };
  };
  return { calls: () => calls };
}

function fastClient(retries: number) {
  return createOpenMeteoClient({ retries, timeoutMs: 1_000, retryDelay: () => 0 });
}

describe('fetchOpenMeteo retries', () => {
  it('retries transient 5xx and returns the eventual success', async () => {
    const client = fastClient(3);
    const scripted = scriptedAdapter(client, [500, 500, 200]);

    const rows = await fetchOpenMeteo(37.77, -122.42, client);

    expect(scripted.calls()).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hourTsMs: Date.parse('2026-10-21T00:00:00Z'),
      irradianceWm2: 120.5,
      temperatureC: 18.2,
    });
  });

  it('retries network errors too', async () => {
    const client = fastClient(3);
    const scripted = scriptedAdapter(client, ['network', 'network', 200]);

    await expect(fetchOpenMeteo(1, 2, client)).resolves.toHaveLength(1);
    expect(scripted.calls()).toBe(3);
  });

  it('gives up after the configured attempts', async () => {
    const client = fastClient(2);
    const scripted = scriptedAdapter(client, [500]);

    await expect(fetchOpenMeteo(1, 2, client)).rejects.toThrow(/status code 500/);
    expect(scripted.calls()).toBe(3); // first + 2 retries
  });

  it('never retries a non-transient 4xx', async () => {
    const client = fastClient(3);
    const scripted = scriptedAdapter(client, [400]);

    await expect(fetchOpenMeteo(1, 2, client)).rejects.toThrow(/status code 400/);
    expect(scripted.calls()).toBe(1);
  });
});
