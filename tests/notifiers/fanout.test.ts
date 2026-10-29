/**
 * Failure isolation (design.md §3.4): one dead client is logged by name and
 * never blocks the rest, and the fanout itself never rejects — call sites can
 * await it without a try/catch.
 */
import { describe, expect, it, vi } from 'vitest';
import { createNotifierFanout } from '../../src/notifiers/fanout.js';
import type { NamedNotifier, NotificationEvent, Notifier } from '../../src/notifiers/types.js';

const event: NotificationEvent = {
  type: 'failure',
  tsMs: 1_000,
  component: 'ev-poll',
  message: 'boom',
};

function named(
  name: string,
  behavior: Notifier['notify'] | 'sync-throw'
): NamedNotifier & { calls: NotificationEvent[] } {
  const calls: NotificationEvent[] = [];
  return {
    name,
    calls,
    notifier: {
      notify: (received) => {
        calls.push(received);
        if (behavior === 'sync-throw') throw new Error(`${name} exploded`);
        return behavior(received);
      },
    },
  };
}

describe('createNotifierFanout', () => {
  it('invokes every client with the same event, in order', async () => {
    const a = named('a', async () => {});
    const b = named('b', async () => {});
    const log = vi.fn();

    await createNotifierFanout([a, b], log).notify(event);

    expect(a.calls).toEqual([event]);
    expect(b.calls).toEqual([event]);
    expect(log).not.toHaveBeenCalled();
  });

  it('a sync throw in one client never blocks the rest and never rejects', async () => {
    const bad = named('bad', 'sync-throw');
    const good = named('good', async () => {});
    const log = vi.fn();

    await expect(createNotifierFanout([bad, good], log).notify(event)).resolves.toBeUndefined();

    expect(good.calls).toEqual([event]);
    expect(log).toHaveBeenCalledWith('[notify] bad failed: bad exploded');
  });

  it('an async rejection is caught the same way', async () => {
    const flaky = named('flaky', async () => {
      throw new Error('webhook 500');
    });
    const log = vi.fn();

    await expect(createNotifierFanout([flaky], log).notify(event)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[notify] flaky failed: webhook 500');
  });

  it('an empty list resolves quietly', async () => {
    const log = vi.fn();
    await expect(createNotifierFanout([], log).notify(event)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
