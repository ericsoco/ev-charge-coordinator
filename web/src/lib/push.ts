/**
 * Web Push enablement (P2 step 7) — the browser-facing flow kept behind an
 * injectable PushPlatform so tests run under jsdom without Notification /
 * serviceWorker / PushManager. Every platform touch is explicit; enablePush
 * is called from a click handler (the permission prompt MUST follow a direct
 * user gesture — the iOS/iPadOS rule, and good practice everywhere).
 *
 * iOS/iPadOS reality (WebKit, 16.4+): Web Push works only for the app added
 * to the Home Screen — hence 'needs-install' guidance instead of a button.
 */
import {
  fetchPushPublicKey,
  postPushSubscribe,
  postPushUnsubscribe,
} from './api';

export type PushSupport = 'supported' | 'insecure' | 'unsupported' | 'needs-install';

export interface PushEnv {
  secure: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** iOS/iPadOS Safari (classic UA + desktop-UA iPads with touch). */
  isIos: boolean;
  /** Running as an installed home-screen app. */
  standalone: boolean;
}

export function pushSupport(env: PushEnv): PushSupport {
  if (!env.secure) return 'insecure';
  // iOS: push exists only inside the installed app (16.4+) — guide first.
  if (env.isIos && !env.standalone) return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return 'unsupported';
  }
  return 'supported';
}

/** The stored subscription shape (PushSubscriptionJSON subset). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Browser touchpoints — the seam tests replace with fakes. */
export interface PushPlatform {
  registerServiceWorker(): Promise<void>;
  requestPermission(): Promise<NotificationPermission>;
  getPublicKey(): Promise<string>;
  /** null when this browser has no existing subscription. */
  getSubscription(): Promise<PushSubscriptionJson | null>;
  subscribe(publicKey: string): Promise<PushSubscriptionJson>;
  postSubscribe(subscription: PushSubscriptionJson): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  postUnsubscribe(endpoint: string): Promise<void>;
}

export type EnableResult = 'enabled' | 'denied' | 'dismissed' | 'failed';

/** The real browser platform. */
export function browserPlatform(): PushPlatform {
  return {
    async registerServiceWorker() {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    },
    async requestPermission() {
      return Notification.requestPermission();
    },
    async getPublicKey() {
      return (await fetchPushPublicKey()).publicKey;
    },
    async getSubscription() {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return subscription === null ? null : (subscription.toJSON() as PushSubscriptionJson);
    },
    async subscribe(publicKey: string) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // PushManager accepts the base64url applicationServerKey directly.
        applicationServerKey: publicKey,
      });
      return subscription.toJSON() as PushSubscriptionJson;
    },
    async postSubscribe(subscription) {
      await postPushSubscribe(subscription);
    },
    async unsubscribe(endpoint: string) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription !== null && subscription.endpoint === endpoint) {
        await subscription.unsubscribe();
      }
    },
    async postUnsubscribe(endpoint) {
      await postPushUnsubscribe(endpoint);
    },
  };
}

/**
 * One enable attempt: register SW → prompt (user gesture) → subscribe →
 * upsert server-side. Never throws — the UI renders the outcome.
 */
export async function enablePush(platform: PushPlatform): Promise<EnableResult> {
  try {
    await platform.registerServiceWorker();
    const permission = await platform.requestPermission();
    if (permission === 'denied') return 'denied';
    if (permission !== 'granted') return 'dismissed';
    const existing = await platform.getSubscription();
    const subscription = existing ?? (await platform.subscribe(await platform.getPublicKey()));
    // Re-post even an existing subscription — refreshes the server copy.
    await platform.postSubscribe(subscription);
    return 'enabled';
  } catch {
    return 'failed';
  }
}

/** Unsubscribe browser-side, then drop the server row. Never throws. */
export async function disablePush(
  platform: PushPlatform
): Promise<'disabled' | 'failed'> {
  try {
    const subscription = await platform.getSubscription();
    if (subscription !== null) {
      await platform.unsubscribe(subscription.endpoint);
      await platform.postUnsubscribe(subscription.endpoint);
    }
    return 'disabled';
  } catch {
    return 'failed';
  }
}

/** Whether this device currently holds a subscription (card init). */
export async function pushEnabled(platform: PushPlatform): Promise<boolean> {
  try {
    return (await platform.getSubscription()) !== null;
  } catch {
    return false;
  }
}

/** Feature/environment probe for card placement (no permissions asked). */
export function detectPushEnv(): PushEnv {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop UA; maxTouchPoints + Mac is the tell.
  const isIos =
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  return {
    secure: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    isIos,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}