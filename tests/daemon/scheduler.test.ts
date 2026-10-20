/**
 * Scheduler adapter over toad-scheduler: cadence, error isolation,
 * no-overlap, drain-on-stop, runOnce. Fake timers throughout — this suite
 * is also the toad-scheduler-under-vitest verification step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../../src/daemon/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cadence', () => {
  it('runs immediately on start, then on the configured interval', async () => {
    let runs = 0;
    const handle = createScheduler(
      [{ name: 'tick', everyMs: 1000, run: () => { runs++; } }],
      () => {}
    );
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    await handle.stop();
  });

  it('never overlaps a slow tick (preventOverrun drops, not queues)', async () => {
    let concurrent = 0;
    let max = 0;
    let done = 0;
    const handle = createScheduler(
      [
        {
          name: 'slow',
          everyMs: 50,
          run: async () => {
            concurrent++;
            max = Math.max(max, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 200));
            concurrent--;
            done++;
          },
        },
      ],
      () => {}
    );
    handle.start();
    await vi.advanceTimersByTimeAsync(0); // first tick starts
    await vi.advanceTimersByTimeAsync(500); // interval fires repeatedly mid-tick
    expect(max).toBe(1);
    expect(done).toBeGreaterThanOrEqual(1);
    // With fake timers, drain requires: stop first (no new ticks), then
    // advance time to complete the in-flight sleep, then await stop().
    const stopPromise = handle.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopPromise;
  });
});

describe('error isolation', () => {
  it('a sync-throwing tick calls onError and the schedule continues', async () => {
    const onError = vi.fn();
    let runs = 0;
    const handle = createScheduler(
      [
        {
          name: 'boom',
          everyMs: 1000,
          run: () => {
            runs++;
            throw new Error('tick failed');
          },
        },
      ],
      onError
    );
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][1] as Error).message).toBe('tick failed');

    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2);
    await handle.stop();
  });

  it('a rejected async tick is routed to onError', async () => {
    const onError = vi.fn();
    const handle = createScheduler(
      [{ name: 'rejects', everyMs: 1000, run: async () => { throw new Error('async boom'); } }],
      onError
    );
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][1] as Error).message).toBe('async boom');
    await handle.stop();
  });
});

describe('stop', () => {
  it('halts future ticks and awaits the in-flight one', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const handle = createScheduler(
      [
        {
          name: 'drain',
          everyMs: 1000,
          run: () => {
            runs++;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      () => {}
    );
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    let stopped = false;
    const stopPromise = handle.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(1); // nothing scheduled after stop
    expect(stopped).toBe(false); // still draining the pending tick
    release();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

describe('runOnce', () => {
  it('runs every task once, collecting errors, without invoking onError', async () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('once boom');
    });
    const onError = vi.fn();
    const handle = createScheduler(
      [
        { name: 'good', everyMs: 1000, run: good },
        { name: 'bad', everyMs: 1000, run: bad },
      ],
      onError
    );

    const results = await handle.runOnce();
    expect(results.good).toBeNull();
    expect(results.bad).toBeInstanceOf(Error);
    expect((results.bad as Error).message).toBe('once boom');
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('task validation', () => {
  it('rejects non-positive intervals and duplicate names', () => {
    expect(() =>
      createScheduler([{ name: 'x', everyMs: 0, run: () => {} }], () => {})
    ).toThrow(/everyMs/);
    expect(() =>
      createScheduler(
        [
          { name: 'x', everyMs: 100, run: () => {} },
          { name: 'x', everyMs: 200, run: () => {} },
        ],
        () => {}
      )
    ).toThrow(/unique/);
  });
});
