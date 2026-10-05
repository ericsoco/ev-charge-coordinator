/**
 * Startup failure wording, mirrored from src/index.ts.
 *
 * A 5xx from FranklinWH must not read like a credentials problem: during the
 * outage that prompted this, the CLI printed a 40-line AxiosError stack trace and
 * the actionable fact -- their backend was down, so the password was never wrong --
 * was buried in `data.details` several levels down.
 *
 * Mirrored rather than imported because index.ts calls program.parse() at module
 * load, so it cannot be imported by a test.
 */
import { describe, expect, it } from 'vitest';

type ServiceStart = { ok: true } | { ok: false; error: string; cause?: unknown };

function describeFranklinFailure(error: unknown): ServiceStart {
  const axiosError = error as {
    response?: { status?: number; data?: { error?: unknown } };
  };
  const status = axiosError?.response?.status;
  const body = axiosError?.response?.data;

  if (typeof status === 'number' && status >= 500) {
    return {
      ok: false,
      error: `HTTP ${status} — FranklinWH's service returned an internal error (not a credentials problem)`,
      cause: error,
    };
  }
  if (typeof status === 'number') {
    const detail = typeof body?.error === 'string' ? body.error : 'request failed';
    return { ok: false, error: `HTTP ${status} — ${detail}`, cause: error };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

describe('describeFranklinFailure', () => {
  it('blames the upstream, not the user, on a 5xx', () => {
    // Verified live against the real outage: three consecutive 500s from
    // energy.franklinwh.com while the site root itself returned 200.
    const result = describeFranklinFailure({
      response: { status: 500, data: { error: 'Internal error' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error).toContain('not a credentials problem');
  });

  it('surfaces the proxy error message on a 4xx', () => {
    const result = describeFranklinFailure({
      response: { status: 401, data: { error: 'Invalid credentials' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error).toBe('HTTP 401 — Invalid credentials');
    expect(result.error).not.toContain('not a credentials problem');
  });

  it('keeps the original error as cause for --debug', () => {
    const cause = new Error('boom');
    const result = describeFranklinFailure(cause);
    expect(result.ok).toBe(false);
    expect((result as { cause?: unknown }).cause).toBe(cause);
  });
});