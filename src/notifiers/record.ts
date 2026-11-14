/**
 * The fanout's record hook (P2 step 7): persist every dispatched event for
 * the Messages tab. Title/body come from the shared renderers so the list
 * matches what ntfy/Slack ship. Failures belong to the fanout's isolation —
 * this hook simply throws and the fanout logs.
 */
import type { DatabaseSync } from 'node:sqlite';
import { insertNotification } from '../store/NotificationStore.js';
import { formatNotificationEvent, notificationTitle } from './format.js';
import type { NotificationEvent } from './types.js';

export function createNotificationRecorder(
  db: DatabaseSync
): (event: NotificationEvent) => void {
  return (event) => {
    insertNotification(db, {
      tsMs: event.tsMs,
      type: event.type,
      title: notificationTitle(event),
      body: formatNotificationEvent(event),
    });
  };
}