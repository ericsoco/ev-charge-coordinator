/** Failure-notification throttle: first per component, then hourly (design §3.7). */
import { describe, expect, it } from 'vitest';
import { createFailureThrottle } from '../../src/notifiers/throttle.js';
import type { NotificationEvent, Notifier } from '../../src/notifiers/types.js';

function recordingNotifier() {
  const events: NotificationEvent[] = [];
  return {
    events,
    notifier: {
      notify: async (event: NotificationEvent) => {
        events.push(event);
      },
    } satisfies Notifier,
  };
}

describe('createFailureThrottle', () => {
  it('notifies the first failure per component, then suppresses repeats in-window', async () => {
    let now = 1_000_000;
    const { events, notifier } = recordingNotifier();
    const throttle = createFailureThrottle(notifier, { nowMs: () => now });

    await throttle({ type: 'failure', tsMs: now, component: 'ev-poll', message: 'boom' });
    now += 60_000;
    await throttle({ type: 'failure', tsMs: now, component: 'ev-poll', message: 'boom again' });
    now += 60_000;
    await throttle({ type: 'failure', tsMs: now, component: 'ev-poll', message: 'still down' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ component: 'ev-poll', message: 'boom' });
  });

  it('throttles components independently', async () => {
    const { events, notifier } = recordingNotifier();
    const throttle = createFailureThrottle(notifier, { nowMs: () => 1_000_000 });

    await throttle({ type: 'failure', tsMs: 1, component: 'ev-poll', message: 'a' });
    await throttle({ type: 'failure', tsMs: 1, component: 'battery-sample', message: 'b' });

    expect(events.map((event) => (event.type === 'failure' ? event.component : ''))).toEqual([
      'ev-poll',
      'battery-sample',
    ]);
  });

  it('notifies again once the window has passed', async () => {
    let now = 1_000_000;
    const { events, notifier } = recordingNotifier();
    const throttle = createFailureThrottle(notifier, { nowMs: () => now });

    await throttle({ type: 'failure', tsMs: now, component: 'ev-poll', message: 'first' });
    now += 3_600_000;
    await throttle({ type: 'failure', tsMs: now, component: 'ev-poll', message: 'second' });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ message: 'second' });
  });

  it('passes rejections through — call sites isolate with .catch', async () => {
    const rejecting: Notifier = {
      notify: async () => {
        throw new Error('raw notifier down');
      },
    };
    const throttle = createFailureThrottle(rejecting, { nowMs: () => 1 });
    await expect(
      throttle({ type: 'failure', tsMs: 1, component: 'ev-poll', message: 'x' })
    ).rejects.toThrow('raw notifier down');
  });
});
