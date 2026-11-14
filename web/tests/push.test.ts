/**
 * Push support classification + the enable/disable flow against a fake
 * platform — jsdom has no Notification/serviceWorker/PushManager, which is
 * exactly why every browser touch sits behind PushPlatform.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  disablePush,
  enablePush,
  pushEnabled,
  pushSupport,
  type PushEnv,
  type PushPlatform,
} from '../src/lib/push';

const SUPPORTED: PushEnv = {
  secure: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isIos: false,
  standalone: false,
};

describe('pushSupport', () => {
  it('is supported on a modern desktop/Android secure context', () => {
    expect(pushSupport(SUPPORTED)).toBe('supported');
  });

  it('flags an insecure origin first (https/tunnel required)', () => {
    expect(pushSupport({ ...SUPPORTED, secure: false })).toBe('insecure');
  });

  it('guides iOS browsers to install before anything else', () => {
    expect(pushSupport({ ...SUPPORTED, isIos: true, standalone: false })).toBe('needs-install');
    // Installed home-screen app with full APIs → supported.
    expect(pushSupport({ ...SUPPORTED, isIos: true, standalone: true })).toBe('supported');
    // Insecure still wins over the install guidance.
    expect(pushSupport({ ...SUPPORTED, secure: false, isIos: true })).toBe('insecure');
  });

  it('is unsupported when a required API is missing', () => {
    expect(pushSupport({ ...SUPPORTED, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...SUPPORTED, hasNotification: false })).toBe('unsupported');
    expect(pushSupport({ ...SUPPORTED, hasServiceWorker: false })).toBe('unsupported');
  });
});

const SUBSCRIPTION = {
  endpoint: 'https://push.example/x',
  keys: { p256dh: 'k', auth: 'a' },
};

function fakePlatform(overrides: Partial<PushPlatform> = {}): PushPlatform {
  return {
    registerServiceWorker: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    getPublicKey: vi.fn(async () => 'pub-key'),
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => SUBSCRIPTION),
    postSubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    postUnsubscribe: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('enablePush', () => {
  it('registers, prompts, subscribes, and upserts server-side', async () => {
    const platform = fakePlatform();

    await expect(enablePush(platform)).resolves.toBe('enabled');

    expect(platform.registerServiceWorker).toHaveBeenCalled();
    expect(platform.requestPermission).toHaveBeenCalled();
    expect(platform.subscribe).toHaveBeenCalledWith('pub-key');
    expect(platform.postSubscribe).toHaveBeenCalledWith(SUBSCRIPTION);
  });

  it('reuses an existing subscription and refreshes the server copy', async () => {
    const existing = { endpoint: 'https://push.example/existing', keys: { p256dh: 'k2', auth: 'a2' } };
    const platform = fakePlatform({ getSubscription: vi.fn(async () => existing) });

    await expect(enablePush(platform)).resolves.toBe('enabled');

    expect(platform.subscribe).not.toHaveBeenCalled();
    expect(platform.postSubscribe).toHaveBeenCalledWith(existing);
  });

  it('maps blocked/dismissed permission without subscribing', async () => {
    const denied = fakePlatform({
      requestPermission: vi.fn(async () => 'denied' as NotificationPermission),
    });
    await expect(enablePush(denied)).resolves.toBe('denied');
    expect(denied.subscribe).not.toHaveBeenCalled();
    expect(denied.postSubscribe).not.toHaveBeenCalled();

    const dismissed = fakePlatform({
      requestPermission: vi.fn(async () => 'default' as NotificationPermission),
    });
    await expect(enablePush(dismissed)).resolves.toBe('dismissed');
    expect(dismissed.subscribe).not.toHaveBeenCalled();
  });

  it('swallows platform failures into "failed"', async () => {
    const broken = fakePlatform({
      registerServiceWorker: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(enablePush(broken)).resolves.toBe('failed');
  });
});

describe('disablePush / pushEnabled', () => {
  it('unsubscribes browser-side then drops the server row', async () => {
    const existing = { endpoint: 'https://push.example/existing', keys: { p256dh: 'k', auth: 'a' } };
    const platform = fakePlatform({ getSubscription: vi.fn(async () => existing) });

    await expect(disablePush(platform)).resolves.toBe('disabled');

    expect(platform.unsubscribe).toHaveBeenCalledWith(existing.endpoint);
    expect(platform.postUnsubscribe).toHaveBeenCalledWith(existing.endpoint);
  });

  it('is a no-op when nothing is subscribed (still "disabled")', async () => {
    const platform = fakePlatform();

    await expect(disablePush(platform)).resolves.toBe('disabled');

    expect(platform.unsubscribe).not.toHaveBeenCalled();
    expect(platform.postUnsubscribe).not.toHaveBeenCalled();
  });

  it('pushEnabled reports subscription state, false on failure', async () => {
    expect(await pushEnabled(fakePlatform())).toBe(false);
    expect(
      await pushEnabled(fakePlatform({ getSubscription: vi.fn(async () => SUBSCRIPTION) }))
    ).toBe(true);
    const broken = fakePlatform({
      getSubscription: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    expect(await pushEnabled(broken)).toBe(false);
  });
});