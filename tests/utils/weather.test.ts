/**
 * Weather-adjustment policy (pure): window integral, staleness, coverage,
 * threshold, off-switch — and the exact detail phrasing.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEATHER_POLICY,
  daylightIntegral24h,
  weatherAdjustment,
  type ForecastVintageRow,
  type WeatherPolicy,
} from '../../src/utils/weather.js';

const NOW = Date.parse('2026-11-05T12:30:00Z');
const HOUR_MS = 60 * 60 * 1000;

/** A full-coverage vintage: 48 hourly rows starting at NOW, irradiance 100. */
function fullVintage(fetchedTsMs: number, irradianceWm2: number | null = 100): ForecastVintageRow[] {
  return Array.from({ length: 48 }, (_, i) => ({
    fetchedTsMs,
    hourTsMs: NOW + i * HOUR_MS,
    irradianceWm2,
  }));
}

const ON: WeatherPolicy = {
  ...DEFAULT_WEATHER_POLICY,
  bufferAdjPercent: 5,
};

describe('daylightIntegral24h', () => {
  it('sums daylight rows inside [now, now+24h) only', () => {
    const rows: ForecastVintageRow[] = [
      { fetchedTsMs: NOW, hourTsMs: NOW - HOUR_MS, irradianceWm2: 999 }, // before window
      { fetchedTsMs: NOW, hourTsMs: NOW + 24 * HOUR_MS, irradianceWm2: 999 }, // at end: excluded
      ...Array.from({ length: 24 }, (_, i) => ({
        fetchedTsMs: NOW,
        hourTsMs: NOW + i * HOUR_MS,
        irradianceWm2: i < 12 ? 100 : 0, // half daylight, half dark
      })),
    ];
    expect(daylightIntegral24h(rows, NOW)).toEqual({ integralWhM2: 1200, hours: 24 });
  });

  it('counts night rows as coverage but zero contribution', () => {
    const rows = fullVintage(NOW, 0);
    expect(daylightIntegral24h(rows, NOW)).toEqual({ integralWhM2: 0, hours: 24 });
  });
});

describe('weatherAdjustment', () => {
  it('is null when disabled (default policy) even on a dark outlook', () => {
    const dark = fullVintage(NOW, 0);
    expect(weatherAdjustment(dark, NOW)).toBeNull();
  });

  it('raises the reserve on a low-solar outlook, with the numbers in detail', () => {
    const dark = fullVintage(NOW, 25); // 24h × 25 W/m² = 600 < 2000
    expect(weatherAdjustment(dark, NOW, ON)).toEqual({
      adjustmentPercent: 5,
      detail: 'low solar next 24h (600 < 2000 Wh/m²)',
    });
  });

  it('is null when the outlook is not low (strict threshold)', () => {
    // Integer-exact: 100 × 24h = 2400 = threshold → not low (>= is not low).
    const exact: WeatherPolicy = { ...ON, solarThresholdWhM2: 2400 };
    expect(weatherAdjustment(fullVintage(NOW, 100), NOW, exact)).toBeNull();
    expect(weatherAdjustment(fullVintage(NOW, 200), NOW, exact)).toBeNull();
  });

  it('is null on a stale vintage', () => {
    const stale = fullVintage(NOW - DEFAULT_WEATHER_POLICY.maxVintageAgeMs - 1, 0);
    expect(weatherAdjustment(stale, NOW, ON)).toBeNull();
  });

  it('is null when the window has thin coverage', () => {
    const rows = fullVintage(NOW, 0).slice(0, DEFAULT_WEATHER_POLICY.minCoverageHours - 1);
    expect(weatherAdjustment(rows, NOW, ON)).toBeNull();
  });

  it('is null with no rows', () => {
    expect(weatherAdjustment([], NOW, ON)).toBeNull();
  });
});