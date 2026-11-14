/**
 * Web Push client (P2 step 7): a fanout target that fans an event out to
 * every stored browser subscription with the same title/body the Messages
 * tab shows. Dead endpoints (404/410 from the push service) are dropped;
 * other failures are logged per subscription — the fanout's isolation
 * still wraps this client.
 */
import * as webpush from 'web-push';
import type { PushSubscriptionRow } from '../store/types.js';
import { formatNotificationEvent, notificationTitle } from './format.js';
import type { NotificationEvent, Notifier } from './types.js';

/** VAPID subject — a mailto: or https: URL per RFC 8292. */
export const VAPID_SUBJECT = 'mailto:evcc@localhost';

/** Delivery lifetime; stale events are worthless once the tab is opened. */
const TTL_SECONDS = 3600;

/** Payload the service worker renders (web/public/sw.js). */
export interface WebPushPayload {
  title: string;
  body: string;
  type: string;
  tsMs: number;
  /** App path to open on notification click. */
  url: string;
}

/** The subset of PushSubscriptionJSON this app stores/serializes. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushOptions {
  /** Mint-on-first-use keypair; only called when a subscription exists. */
  getVapid: () => Promise<{ publicKey: string; privateKey: string }>;
  listSubscriptions: () => PushSubscriptionRow[];
  removeSubscription: (endpoint: string) => void;
  /** Injectable for tests; defaults to web-push's sendNotification. */
  sendImpl?: (
    subscription: WebPushSubscription,
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      TTL: number;
    }
  ) => Promise<unknown>;
  log?: (message: string) => void;
}

export function createWebPushNotifier(options: WebPushOptions): Notifier {
  const send =
    options.sendImpl ??
    ((subscription, payload, sendOptions): Promise<unknown> =>
      webpush.sendNotification(subscription, payload, sendOptions));
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      const subscriptions = options.listSubscriptions();
      // Nobody opted in → no keychain read, no send (the common case).
      if (subscriptions.length === 0) return;
      const vapid = await options.getVapid();
      const payload: WebPushPayload = {
        title: notificationTitle(event),
        body: formatNotificationEvent(event),
        type: event.type,
        tsMs: event.tsMs,
        url: '/',
      };
      const json = JSON.stringify(payload);
      for (const subscription of subscriptions) {
        try {
          await send(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            json,
            {
              vapidDetails: {
                subject: VAPID_SUBJECT,
                publicKey: vapid.publicKey,
                privateKey: vapid.privateKey,
              },
              TTL: TTL_SECONDS,
            }
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            options.removeSubscription(subscription.endpoint);
            options.log?.(`[notify] webpush dropped expired subscription (${status})`);
          } else {
            options.log?.(
              `[notify] webpush failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    },
  };
}