/**
 * Startup reporting.
 *
 * `start` used to print an unconditional "✓ Services started successfully" and
 * then, one line later, the accurate "Solar battery proxy: not running" -- so the
 * banner contradicted the detail beside it. It also told the user to run `exit`
 * on a run where `exit` had already been shown to find nothing to stop.
 *
 * The status lines and the exit guidance are what a user trusts to know whether
 * the thing works, so the exact wording is pinned here rather than left to a
 * manual read.
 *
 * The rendering is mirrored from the `start` action because index.ts runs
 * program.parse() on import and cannot be imported by a test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ServiceStart = { ok: true } | { ok: false; error: string; cause?: unknown };

/** The real source, so these assertions can describe what actually ships. */
const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

/** Mirrors the per-service block in the `start` action. */
function report(status: { tesla: ServiceStart; franklin: ServiceStart }): string {
  const out: string[] = [];
  if (status.tesla.ok) {
    out.push('✓ Tesla service started successfully');
  } else {
    out.push(`✗ Tesla service not started. Error: ${status.tesla.error}`);
  }
  if (status.franklin.ok) {
    out.push('✓ FranklinWH service started successfully');
  } else {
    out.push(`✗ FranklinWH service not started. Error: ${status.franklin.error}`);
  }
  return out.join('\n');
}

/** Mirrors the daemon guidance, which must depend on there being something to stop. */
function guidance(spawnedPid: number | null): string {
  return spawnedPid
    ? 'Running in the background. Stop with: node dist/index.js exit'
    : 'Running in the background. The solar battery proxy is not running, so\n  `exit` has nothing to stop.';
}

describe('start service status lines', () => {
  it('reports both services when both are up', () => {
    const text = report({ tesla: { ok: true }, franklin: { ok: true } });
    expect(text).toContain('✓ Tesla service started successfully');
    expect(text).toContain('✓ FranklinWH service started successfully');
    expect(text).not.toContain('✗');
  });

  it('names the failed service and its error, and no longer claims overall success', () => {
    // The exact scenario reported: FranklinWH's backend was returning 500 while
    // Tesla authenticated fine, and `start` reported success anyway.
    const text = report({
      tesla: { ok: true },
      franklin: {
        ok: false,
        error:
          "HTTP 500 — FranklinWH's service returned an internal error (not a credentials problem)",
      },
    });

    expect(text).toContain('✓ Tesla service started successfully');
    expect(text).toContain('✗ FranklinWH service not started.');
    expect(text).toContain('not a credentials problem');
    expect(text).not.toContain('✓ Services started successfully');
  });

  it('reports both failures independently', () => {
    const text = report({
      tesla: { ok: false, error: 'HTTP 401 — token expired or revoked' },
      franklin: { ok: false, error: 'HTTP 503 — gateway offline' },
    });

    expect(text).toContain('✗ Tesla service not started. Error: HTTP 401');
    expect(text).toContain('✗ FranklinWH service not started. Error: HTTP 503');
  });

  it('never renders a stack trace in the one-line form', () => {
    const text = report({
      tesla: { ok: true },
      franklin: {
        ok: false,
        error: 'HTTP 500 — internal error',
        cause: new Error('AxiosError: boom\n    at settle (...)'),
      },
    });

    expect(text).not.toContain('AxiosError');
    expect(text).not.toMatch(/\n\s+at /);
    // Exactly one line per service.
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('exit guidance in start --daemon', () => {
  it('advertises exit when a proxy PID was recorded', () => {
    expect(guidance(4242)).toContain('Stop with: node dist/index.js exit');
  });

  it('does not advertise exit when nothing was recorded', () => {
    // The reported bug: `exit` was suggested on a run where it had just been
    // shown to find nothing to stop.
    expect(guidance(null)).not.toContain('Stop with');
    expect(guidance(null)).toContain('has nothing to stop');
  });

  it('gates the guidance in src/index.ts, not just in this mirror', () => {
    // Assert against the real source. A mirrored helper can drift from the code
    // it mirrors, and then its tests pass while the bug is live -- which is
    // exactly what happened the first time this was written.
    const daemon = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf('if (options.daemon)'));
    const advice = daemon.slice(0, daemon.indexOf('await keepResident();'));

    expect(advice).toContain('if (spawnedPid)');
    // The "Stop with" advice must come after the guard, not before it.
    expect(advice.indexOf('if (spawnedPid)')).toBeLessThan(advice.indexOf('Stop with'));
  });

  it('does not claim overall success in the start action', () => {
    // The unconditional banner contradicted the accurate per-service line printed
    // immediately beneath it. Asserted on console output rather than the whole
    // file, so the explanatory comments that quote the old string -- which are
    // worth keeping, since they record why it went -- do not trip this.
    const printed = INDEX_SOURCE.split('\n').filter(
      (l) => l.includes('console.log') && l.includes('✓ Services started successfully')
    );
    expect(printed).toEqual([]);
  });
});