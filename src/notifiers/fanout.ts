/**
 * Invoke every configured client; a dead one (sync throw or rejection) is
 * logged by name and never blocks the rest or rejects the caller — design.md
 * §3.4: a dead webhook never blocks or rolls back an action.
 */
import type { NamedNotifier, NotificationEvent, Notifier } from './types.js';

export function createNotifierFanout(
  targets: NamedNotifier[],
  log: (message: string) => void = console.log
): Notifier {
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      for (const { name, notifier } of targets) {
        try {
          await notifier.notify(event);
        } catch (error) {
          log(`[notify] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
