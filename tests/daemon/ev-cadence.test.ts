/** Cadence predicate: first observation always, then plugged-vs-idle timing. */
import { describe, expect, it } from 'vitest';
import { shouldSampleRich } from '../../src/daemon/EvPoller.js';

const BASE = {
  lastRichSampleMs: null,
  plugged: false,
  samplePluggedSec: 60,
  sampleIdleSec: 300,
};

describe('shouldSampleRich', () => {
  it('always samples when there is no previous rich read (boot seed)', () => {
    expect(shouldSampleRich({ ...BASE, nowMs: 1_000 })).toBe(true);
  });

  it('respects the idle cadence when not plugged', () => {
    const lastRichSampleMs = 1_000;
    expect(shouldSampleRich({ ...BASE, nowMs: 10_000, lastRichSampleMs })).toBe(false);
    expect(shouldSampleRich({ ...BASE, nowMs: 300_999, lastRichSampleMs })).toBe(false);
    // Boundary is inclusive: 1_000 + 300_000 is exactly due.
    expect(shouldSampleRich({ ...BASE, nowMs: 301_000, lastRichSampleMs })).toBe(true);
  });

  it('uses the fast cadence while plugged', () => {
    const lastRichSampleMs = 1_000;
    expect(
      shouldSampleRich({ ...BASE, nowMs: 60_999, lastRichSampleMs, plugged: true })
    ).toBe(false);
    expect(
      shouldSampleRich({ ...BASE, nowMs: 61_001, lastRichSampleMs, plugged: true })
    ).toBe(true);
  });

  it('flipping pluggedness switches cadence immediately', () => {
    // Just sampled while idle at t=0; plug in at t=10s — the plugged cadence
    // (60s) governs from then, not the remaining idle window.
    expect(
      shouldSampleRich({ ...BASE, nowMs: 10_000, lastRichSampleMs: 0, plugged: true })
    ).toBe(false);
    expect(
      shouldSampleRich({ ...BASE, nowMs: 61_000, lastRichSampleMs: 0, plugged: true })
    ).toBe(true);
  });
});
