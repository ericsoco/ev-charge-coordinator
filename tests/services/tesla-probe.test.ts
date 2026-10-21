/**
 * The vehicle state probe and the chargeEnergyAdded passthrough.
 *
 * Adapter is the seam (same pattern as tesla-command-routing): requests are
 * recorded without opening a socket, so these tests can assert exactly which
 * endpoints the probe touches — the contract that keeps the daemon from
 * waking the car or provoking a 408.
 */
import { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { TeslaService } from '../../src/services/TeslaService.js';

const VIN = '5YJTESTVIN00000000';

interface Recorded {
  url: string | undefined;
  params: unknown;
}

function ok(config: InternalAxiosRequestConfig, data: unknown) {
  return { status: 200, data, statusText: 'OK', headers: {}, config };
}

/**
 * Answer the three read shapes the tests exercise:
 * - narrow charge_state read (getStatus) — includes charge_energy_added when given;
 * - vehicle list (resolveVin fallback);
 * - singular vehicle probe — state from a sequence (asleep → online etc.).
 */
function recordOn(
  client: AxiosInstance,
  into: Recorded[],
  states: string[],
  chargeEnergyAdded?: number
): void {
  let stateIndex = 0;
  client.defaults.adapter = async (config) => {
    into.push({ url: config.url, params: config.params });
    if ((config.params as { endpoints?: unknown } | undefined)?.endpoints === 'charge_state') {
      return ok(config, {
        response: {
          vin: VIN,
          display_name: 'Test',
          state: 'online',
          charge_state: {
            battery_level: 50,
            charge_limit_soc: 80,
            charging_state: 'Charging',
            charge_energy_added: chargeEnergyAdded,
          },
        },
      });
    }
    if (config.url === '/api/1/vehicles') {
      return ok(config, {
        response: [{ id: 1, vehicle_id: 1, vin: VIN, display_name: 'Test', state: 'online' }],
      });
    }
    const state = states[Math.min(stateIndex++, Math.max(states.length - 1, 0))];
    return ok(config, { response: { id: 1, vehicle_id: 1, vin: VIN, display_name: 'Test', state } });
  };
}

async function service(states: string[] = ['asleep'], chargeEnergyAdded?: number): Promise<{
  tesla: TeslaService;
  recorded: Recorded[];
}> {
  const tesla = new TeslaService({ region: 'na' });
  await tesla.initialize({
    clientId: 'cid',
    clientSecret: 'secret',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
  });
  tesla.setVin(VIN);
  const recorded: Recorded[] = [];
  recordOn((tesla as unknown as { client: AxiosInstance }).client, recorded, states, chargeEnergyAdded);
  return { tesla, recorded };
}

describe('getVehicleState probe', () => {
  it('touches only the cheap singular endpoint — no wake, no vehicle_data', async () => {
    const { tesla, recorded } = await service(['asleep', 'online']);

    expect(await tesla.getVehicleState()).toEqual({ state: 'asleep' });
    expect(await tesla.getVehicleState()).toEqual({ state: 'online' });

    expect(recorded).toHaveLength(2);
    for (const entry of recorded) {
      expect(entry.url).toBe(`/api/1/vehicles/${VIN}`);
      expect(entry.params).toBeUndefined();
    }
  });

  it('resolves a missing VIN through the list endpoint first', async () => {
    const { tesla, recorded } = await service(['online']);
    // No setVin: the probe must list vehicles before probing the singular URL.
    (tesla as unknown as { vin: string | undefined }).vin = undefined;

    expect(await tesla.getVehicleState()).toEqual({ state: 'online' });
    expect(recorded.map((entry) => entry.url)).toEqual([
      '/api/1/vehicles',
      `/api/1/vehicles/${VIN}`,
    ]);
  });
});

describe('getStatus chargeEnergyAdded', () => {
  it('passes charge_energy_added through from charge_state', async () => {
    const { tesla } = await service(['online'], 4.2);
    const status = await tesla.getStatus();
    expect(status.battery.chargeEnergyAdded).toBe(4.2);
  });

  it('stays undefined when the field is absent (e.g., long unplugged)', async () => {
    const { tesla } = await service(['online'], undefined);
    const status = await tesla.getStatus();
    expect(status.battery.chargeEnergyAdded).toBeUndefined();
  });
});
