/** The default client: logs locally (as opposed to a push service). */
import { formatNotificationEvent } from './format.js';
import type { NotificationEvent, Notifier } from './types.js';

export function createLogLocalNotifier(log: (message: string) => void = console.log): Notifier {
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      log(`[notify] ${formatNotificationEvent(event)}`);
    },
  };
}
