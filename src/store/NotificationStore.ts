/**
 * Sent-notification history (notifications) — one row per event dispatched
 * by the notifier fanout; read by GET /api/messages for the Messages tab.
 * Title/body arrive pre-rendered (notifiers/format.ts) so the list matches
 * what ntfy/Slack show.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  HOME_SITE,
  type NewNotification,
  type NotificationRow,
  type SiteId,
} from './types.js';

/** Aliased to camelCase — the schema-pin test pins this list. */
const COLUMNS = 'id, site_id AS siteId, ts_ms AS tsMs, type, title, body';

/** Record one dispatched event; returns the row id. */
export function insertNotification(
  db: DatabaseSync,
  notification: NewNotification,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare(
      'INSERT INTO notifications (site_id, ts_ms, type, title, body) VALUES (?, ?, ?, ?, ?)'
    )
    .run(siteId, notification.tsMs, notification.type, notification.title, notification.body);
  return Number(result.lastInsertRowid);
}

/** Newest-first page for GET /api/messages. */
export function recentNotifications(
  db: DatabaseSync,
  page: { limit: number; offset: number },
  siteId: SiteId = HOME_SITE
): NotificationRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM notifications
        WHERE site_id = ?
        ORDER BY ts_ms DESC, id DESC
        LIMIT ? OFFSET ?`
    )
    .all(siteId, page.limit, page.offset) as unknown as NotificationRow[];
}

/** Retention prune; returns rows removed (the daemon's daily task). */
export function pruneNotifications(
  db: DatabaseSync,
  retentionDays: number,
  nowMs: number,
  siteId: SiteId = HOME_SITE
): number {
  const result = db
    .prepare('DELETE FROM notifications WHERE site_id = ? AND ts_ms < ?')
    .run(siteId, nowMs - retentionDays * 86_400_000);
  return Number(result.changes);
}