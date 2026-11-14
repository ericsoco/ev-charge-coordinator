/**
 * Migration 6 — P2 step 7: Messages + Web Push plumbing.
 *
 * - `notifications`: one row per event dispatched by the notifier fanout
 *   (design §3.7) — the Messages tab's history. `title`/`body` arrive
 *   pre-rendered by notifiers/format.ts; `type` carries the same value set
 *   as NotificationEvent.type (store/types.ts's NotificationEventType).
 * - `push_subscriptions`: browser Web Push endpoints, UNIQUE on `endpoint`
 *   so a device's re-subscription upserts its keys instead of duplicating.
 *   Retention does not prune these — devices own their rows; dead endpoints
 *   are dropped when a push answers 404/410 or the app unsubscribes.
 */
import type { DatabaseSync } from 'node:sqlite';

export const version = 6;

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      ts_ms INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN (
        'plug-in-detected', 'decision-made', 'charging-started',
        'charging-stopped', 'session-retargeted', 'failure', 'test'
      )),
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_site_ts
      ON notifications (site_id, ts_ms);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL CHECK (site_id = 'home'),
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_ts_ms INTEGER NOT NULL
    );
  `);
}