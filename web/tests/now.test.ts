import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Now from '../src/pages/Now.svelte';
import { session } from '../src/lib/apiSession.svelte';
import {
  formatAge,
  formatKw,
  formatSocPercent,
  formatTime,
  sessionLine,
  vehicleCaption,
} from '../src/pages/nowText';
import type { NowResponse } from '../src/lib/api';

/** Minimal Response stand-ins — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
const unauthorized = (): Response =>
  ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response;

const PLUG_TS = Date.UTC(2026, 10, 11, 20, 5, 0);

function fixture(overrides: Partial<NowResponse> = {}): NowResponse {
  return {
    nowMs: PLUG_TS + 3_600_000,
    vehicle: {
      vehicleId: 'VIN-TEST',
      socPercent: 62,
      chargingState: 'Charging',
      chargeLimitSoc: 80,
      sampleTsMs: PLUG_TS + 3_500_000,
      ageMs: 60_000,
    },
    battery: {
      socPercent: 71,
      powerW: -5000,
      homeLoadW: 5100,
      solarW: 200,
      gridW: -300,
      sampleTsMs: PLUG_TS + 3_540_000,
      ageMs: 20_000,
    },
    session: { id: 7, plugTsMs: PLUG_TS, targetPercent: 60, stopReason: null },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Now tab — live data', () => {
  it('renders both big numbers and the session sentence', async () => {
    fetchMock.mockResolvedValue(ok(fixture()));
    render(Now);

    await screen.findByText('62.0');
    expect(screen.getByText('71.0')).toBeDefined();
    expect(screen.getByText('Vehicle')).toBeDefined();
    expect(screen.getByText('Home battery')).toBeDefined();

    const expected = `Charging since ${formatTime(PLUG_TS)}, target 60%`;
    expect(screen.getByText(expected)).toBeDefined();
    // Captions: state + limit + freshness, solar/load.
    expect(screen.getByText(/Charging · limit 80% · updated 1m ago/)).toBeDefined();
    expect(screen.getByText(/solar 0.20 kW · load 5.10 kW · updated 20s ago/)).toBeDefined();
  });

  it('rounds displayed BSoC to one decimal digit', async () => {
    const base = fixture();
    fetchMock.mockResolvedValue(
      ok({
        ...base,
        vehicle: { ...base.vehicle!, socPercent: 54.263 },
        battery: { ...base.battery!, socPercent: 54 },
      })
    );
    render(Now);

    await screen.findByText('54.3');
    expect(screen.getByText('54.0')).toBeDefined();
  });

  it('shows a friendly empty state for an empty store (no crash)', async () => {
    fetchMock.mockResolvedValue(
      ok({ nowMs: 1, vehicle: null, battery: null, session: null })
    );
    render(Now);

    await screen.findByText(/No samples yet/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Now tab — auth, stale, polling, errors', () => {
  it('raises the shared session flag on 401 — the gate itself is App-level', async () => {
    fetchMock.mockResolvedValue(unauthorized());
    render(Now);

    // The page does NOT render auth UI; App's TokenPanel keys off this flag.
    await waitFor(() => expect(session.needsToken).toBe(true));
    expect(screen.queryByText('API token required')).toBeNull();
  });

  it('flags stale sampling when the battery age passes 5 minutes', async () => {
    const base = fixture();
    fetchMock.mockResolvedValue(
      ok({ ...base, battery: { ...base.battery!, ageMs: 6 * 60_000 } })
    );
    render(Now);

    await screen.findByText(/Sampling delayed/);
    expect(screen.getByText('62.0')).toBeDefined();
  });

  it('keeps the last good data and warns when a refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(fixture()))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(ok(fixture()));
    render(Now);

    await screen.findByText('62.0');
    document.dispatchEvent(new Event('visibilitychange'));
    await screen.findByText(/Refresh failed: connection lost/);
    expect(screen.getByText('62.0')).toBeDefined(); // stale-but-shown data
  });

  it('polls on its interval and again when the tab becomes visible', async () => {
    fetchMock.mockResolvedValue(ok(fixture()));
    render(Now, { props: { pollMs: 25 } });

    await screen.findByText('62.0');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    const before = fetchMock.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows an error card with Retry when the very first load fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok(fixture()));
    render(Now);

    await screen.findByText("Can't reach the read API");
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('62.0');
  });
});

describe('Now text formatting (pure)', () => {
  it('sessionLine: not charging, stop reasons, null target, no data', () => {
    const base = fixture();
    expect(sessionLine(null)).toBe('');
    expect(sessionLine({ ...base, session: null })).toBe('Not charging');
    expect(
      sessionLine({
        ...base,
        session: { ...base.session!, targetPercent: null, stopReason: 'battery_buffer' },
      })
    ).toBe(`Charging since ${formatTime(PLUG_TS)} · stopped: battery buffer`);
    expect(
      sessionLine({
        ...base,
        vehicle: { ...base.vehicle!, chargingState: 'Stopped' },
      })
    ).toBe(`Plugged in since ${formatTime(PLUG_TS)}, target 60%`);
  });

  it('formatAge / formatKw / vehicleCaption buckets', () => {
    expect(formatAge(12_000)).toBe('12s ago');
    expect(formatAge(60_000)).toBe('1m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatKw(null)).toBe('—');
    expect(formatKw(5117)).toBe('5.12 kW');
    expect(vehicleCaption(null)).toBe('—');
    expect(vehicleCaption(fixture().vehicle)).toBe('Charging · limit 80%');
  });

  it('formatSocPercent: rounds BSoC to one decimal digit, null-safe', () => {
    expect(formatSocPercent(54.263)).toBe('54.3');
    expect(formatSocPercent(54)).toBe('54.0');
    expect(formatSocPercent(100)).toBe('100.0');
    expect(formatSocPercent(0)).toBe('0.0');
    expect(formatSocPercent(62.44)).toBe('62.4');
    expect(formatSocPercent(62.46)).toBe('62.5');
    expect(formatSocPercent(null)).toBe('—');
    expect(formatSocPercent(undefined)).toBe('—');
  });
});

