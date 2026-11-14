/**
 * Web Push fanout target: payload shape (title/body = the Messages row),
 * per-subscription fan-out, dead-endpoint dropping (404/410), and the
 * no-subscription no-op that never touches the VAPID keychain.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createWebPushNotifier,
  VAPID_SUBJECT,
  type WebPushOptions,
  type WebPushSubscription,
} from '../../src/notifiers/webPush.js';
import type { PushSubscriptionRow } from '../../src/store/types.js';

const SUB: PushSubscriptionRow = {
  id: 1,
  siteId: 'home',
  endpoint: 'https://push.example/a',
  p256dh: 'k',
  auth: 'a',
  createdTsMs: 1,
};

const EVENT = {
  type: 'charging-started',
  tsMs: 5,
  sessionId: 9,
  vehicleId: 'VIN',
  evSocPercent: 54,
} as const;

function makeNotifier(overrides: Partial<WebPushOptions> = {}): {
  options: WebPushOptions;
  notifier: ReturnType<typeof createWebPushNotifier>;
} {
  const options: WebPushOptions = {
    getVapid: vi.fn(async () => ({ publicKey: 'pub', privateKey: 'priv' })),
    listSubscriptions: () => [SUB],
    removeSubscription: vi.fn(),
    sendImpl: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
  return { options, notifier: createWebPushNotifier(options) };
}

describe('createWebPushNotifier', () => {
  it('sends the Messages title/body payload to every subscription with VAPID details', async () => {
    const second: PushSubscriptionRow = { ...SUB, id: 2, endpoint: 'https://push.example/b' };
    const { options, notifier } = makeNotifier({ listSubscriptions: () => [SUB, second] });

    await notifier.notify(EVENT);

    const send = vi.mocked(options.sendImpl!);
    expect(send).toHaveBeenCalledTimes(2);
    const [firstSub, payload, sendOptions] = send.mock.calls[0] as [
      WebPushSubscription,
      string,
      { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number },
    ];
    expect(firstSub.endpoint).toBe(SUB.endpoint);
    expect(firstSub.keys).toEqual({ p256dh: 'k', auth: 'a' });
    expect(JSON.parse(payload)).toEqual({
      title: 'Charging started',
      body: '⚡️ charging started (SoC 54%)',
      type: 'charging-started',
      tsMs: 5,
      url: '/',
    });
    expect(sendOptions.vapidDetails).toEqual({
      subject: VAPID_SUBJECT,
      publicKey: 'pub',
      privateKey: 'priv',
    });
    expect(sendOptions.TTL).toBeGreaterThan(0);
    expect(send.mock.calls[1][0].endpoint).toBe(second.endpoint);
  });

  it('never reads VAPID keys when nobody subscribed (the common case)', async () => {
    const { options, notifier } = makeNotifier({ listSubscriptions: () => [] });

    await notifier.notify(EVENT);

    expect(options.getVapid).not.toHaveBeenCalled();
    expect(options.sendImpl).not.toHaveBeenCalled();
  });

  it('drops a subscription the push service reports gone (404/410)', async () => {
    const gone = Object.assign(new Error('Gone'), { statusCode: 410 });
    const { options, notifier } = makeNotifier({
      sendImpl: vi.fn(async () => {
        throw gone;
      }),
    });

    await expect(notifier.notify(EVENT)).resolves.toBeUndefined();

    expect(options.removeSubscription).toHaveBeenCalledWith(SUB.endpoint);
    expect(options.log).toHaveBeenCalledWith('[notify] webpush dropped expired subscription (410)');
  });

  it('logs other send failures without removing the subscription', async () => {
    const { options, notifier } = makeNotifier({
      sendImpl: vi.fn(async () => {
        throw new Error('push 500');
      }),
    });

    await expect(notifier.notify(EVENT)).resolves.toBeUndefined();

    expect(options.removeSubscription).not.toHaveBeenCalled();
    expect(options.log).toHaveBeenCalledWith('[notify] webpush failed: push 500');
  });

  it('propagates a VAPID-keychain failure for the fanout to isolate', async () => {
    const { notifier } = makeNotifier({
      getVapid: vi.fn(async () => {
        throw new Error('keychain locked');
      }),
    });

    await expect(notifier.notify(EVENT)).rejects.toThrow('keychain locked');
  });
});