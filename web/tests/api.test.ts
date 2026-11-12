import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  clearApiToken,
  fetchNow,
  fetchSeries,
  fetchSessions,
  getApiToken,
  setApiToken,
} from '../src/lib/api';

const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token storage', () => {
  it('round-trips through localStorage and treats empty as absent', () => {
    expect(getApiToken()).toBeNull();
    setApiToken('abc123');
    expect(getApiToken()).toBe('abc123');
    setApiToken('');
    expect(getApiToken()).toBeNull();
    clearApiToken();
    expect(getApiToken()).toBeNull();
  });
});

describe('fetchNow', () => {
  const NOW = { nowMs: 1, vehicle: null, battery: null, session: null };

  it('attaches the stored bearer token', async () => {
    setApiToken('tok-1');
    fetchMock.mockResolvedValue(ok(NOW));
    await fetchNow();
    expect(fetchMock).toHaveBeenCalledWith('/api/now', {
      headers: { Authorization: 'Bearer tok-1' },
    });
  });

  it('sends no Authorization header when no token is stored', async () => {
    fetchMock.mockResolvedValue(ok(NOW));
    await fetchNow();
    expect(fetchMock).toHaveBeenCalledWith('/api/now', { headers: {} });
  });

  it('throws AuthError on 401 and a plain error on other failures', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);
    await expect(fetchNow()).rejects.toBeInstanceOf(AuthError);

    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as unknown as Response);
    await expect(fetchNow()).rejects.toThrow(/500/);
  });
});

describe('fetchSeries', () => {
  const SERIES = {
    metric: 'ev_soc',
    unit: 'percent',
    aggregation: 'avg',
    from: 1000,
    to: 2000,
    bucketMs: 300_000,
    points: [],
  };

  it('builds the metric/from/to query with the stored token', async () => {
    setApiToken('tok-2');
    fetchMock.mockResolvedValue(ok(SERIES));
    await fetchSeries('ev_soc', 1000, 2000);
    expect(fetchMock).toHaveBeenCalledWith('/api/series?metric=ev_soc&from=1000&to=2000', {
      headers: { Authorization: 'Bearer tok-2' },
    });
  });

  it('throws AuthError on 401', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);
    await expect(fetchSeries('battery_soc', 1, 2)).rejects.toBeInstanceOf(AuthError);
  });
});

describe('fetchSessions', () => {
  const PAGE = { total: 0, limit: 200, offset: 400, sessions: [] };

  it('builds the limit/offset query with the stored token', async () => {
    setApiToken('tok-3');
    fetchMock.mockResolvedValue(ok(PAGE));
    await fetchSessions(200, 400);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?limit=200&offset=400', {
      headers: { Authorization: 'Bearer tok-3' },
    });
  });

  it('throws AuthError on 401', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);
    await expect(fetchSessions(50, 0)).rejects.toBeInstanceOf(AuthError);
  });
});
