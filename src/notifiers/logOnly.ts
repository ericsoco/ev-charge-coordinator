/** The default client: one daemon-log line per event. */
import { formatNotificationEvent } from './format.js';
import type { NotificationEvent, Notifier } from './types.js';

export function createLogNotifier(log: (message: string) => void = console.log): Notifier {
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      log(`[notify] ${formatNotificationEvent(event)}`);
    },
  };
}
