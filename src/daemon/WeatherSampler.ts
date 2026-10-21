/**
 * Weather sampler: one Open-Meteo forecast fetch per cadence tick, appended
 * as a vintage (never replaced — history feeds actual-vs-forecast analysis).
 *
 * Spike-verified shape (2026-10-20): `hourly.{time,shortwave_radiation,
 * temperature_2m}` with `timezone=UTC` requested so `time` values are naive
 * ISO-UTC ("2026-10-21T00:00") — parsed with an appended ":00Z". Fits the
 * step-1 weather columns as provisioned; no migration was needed.
 *
 * Without the home-location secret the task skips with a one-time notice —
 * collection degrades gracefully until `set-home-location` runs (step 5).
 */
import axios from 'axios';
import type { DatabaseSync } from 'node:sqlite';
import type { HomeLocation } from '../utils/credentials.js';
import * as weather from '../store/WeatherForecastStore.js';
import type { NewWeatherForecast } from '../store/types.js';
import type { ScheduledTask } from './scheduler.js';

/** One forecast hour, already mapped to store-row shape. */
export interface ForecastHour extends NewWeatherForecast {
  hourTsMs: number;
}

export type FetchForecast = (latitude: number, longitude: number) => Promise<ForecastHour[]>;

/** Default fetcher: Open-Meteo, 3 days of hourly data, UTC. */
export async function fetchOpenMeteo(latitude: number, longitude: number): Promise<ForecastHour[]> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${latitude}&longitude=${longitude}` +
    '&hourly=shortwave_radiation,temperature_2m&forecast_days=3&timezone=UTC';
  const response = await axios.get(url);
  const hourly = (response.data as { hourly?: unknown }).hourly as
    | { time?: unknown; shortwave_radiation?: unknown; temperature_2m?: unknown }
    | undefined;
  const times = Array.isArray(hourly?.time) ? (hourly.time as string[]) : null;
  const radiation = Array.isArray(hourly?.shortwave_radiation)
    ? (hourly.shortwave_radiation as (number | null)[])
    : null;
  const temperature = Array.isArray(hourly?.temperature_2m)
    ? (hourly.temperature_2m as (number | null)[])
    : null;
  if (!times || !radiation || !temperature || times.length !== radiation.length || times.length !== temperature.length) {
    throw new Error('Open-Meteo response missing matching hourly arrays');
  }
  return times.map((time, index) => ({
    hourTsMs: Date.parse(`${time}:00Z`),
    irradianceWm2: radiation[index],
    temperatureC: temperature[index],
    rawJson: JSON.stringify({
      time,
      shortwave_radiation: radiation[index],
      temperature_2m: temperature[index],
    }),
  }));
}

export interface WeatherSamplerDeps {
  db: DatabaseSync;
  /** Credential-store read; tests stub it. */
  getHomeLocation: () => Promise<HomeLocation | undefined>;
  fetchSec: number;
  fetchForecast?: FetchForecast;
  /** Skip/failure notices; default no-op. */
  log?: (message: string) => void;
  nowMs?: () => number;
}

export function createWeatherSampler(deps: WeatherSamplerDeps): ScheduledTask {
  const nowMs = deps.nowMs ?? Date.now;
  const fetchForecast = deps.fetchForecast ?? fetchOpenMeteo;
  const log = deps.log ?? (() => {});
  let skipLogged = false;

  return {
    name: 'weather-fetch',
    everyMs: deps.fetchSec * 1000,
    run: async () => {
      const location = await deps.getHomeLocation();
      if (!location) {
        if (!skipLogged) {
          skipLogged = true;
          log('weather-fetch: skipped — home location secret not set (use set-home-location)');
        }
        return;
      }
      const rows = await fetchForecast(location.latitude, location.longitude);
      if (rows.length === 0) {
        throw new Error('Open-Meteo returned no forecast hours');
      }
      weather.insertForecast(deps.db, rows, nowMs());
    },
  };
}
