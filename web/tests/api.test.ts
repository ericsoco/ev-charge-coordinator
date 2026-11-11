import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  clearApiToken,
  fetchNow,
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
