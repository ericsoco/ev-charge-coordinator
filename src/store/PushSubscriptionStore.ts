/**
 * Browser Web Push subscriptions (P2 step 7) — written by POST /api/push/
 * subscribe, read by the daemon's webpush notifier, dropped on unsubscribe
 * or a 404/410 push answer. `endpoint` is the device's identity: a
 * re-subscription upserts the keys instead of duplicating the row.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type NewPushSubscription,
  type PushSubscriptionRow,
  type SiteId,
} from './types.js';

/** Aliased to camelCase — the schema-pin test pins this list. */
const COLUMNS = 'id, site_id AS siteId, endpoint, p256dh, auth, created_ts_ms AS createdTsMs';

/** Insert, or refresh this endpoint's keys (created_ts_ms keeps its first write). */
export function upsertSubscription(
  db: DatabaseSync,
  subscription: NewPushSubscription,
  siteId: SiteId = HOME_SITE
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (site_id, endpoint, p256dh, auth, created_ts_ms)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth`
  ).run(
    siteId,
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth,
    subscription.createdTsMs
  );
}

/** Remove by endpoint; true when a row was dropped (false = already gone). */
export function removeSubscription(
  db: DatabaseSync,
  endpoint: string,
  siteId: SiteId = HOME_SITE
): boolean {
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE site_id = ? AND endpoint = ?')
    .run(siteId, endpoint);
  return Number(result.changes) > 0;
}

/** Every live subscription for the site (the webpush notifier's fan-out list). */
export function listSubscriptions(
  db: DatabaseSync,
  siteId: SiteId = HOME_SITE
): PushSubscriptionRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM push_subscriptions WHERE site_id = ? ORDER BY id`)
    .all(siteId) as unknown as PushSubscriptionRow[];
}