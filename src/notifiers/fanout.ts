/**
 * Invoke every configured client; a dead one (sync throw or rejection) is
 * logged by name and never blocks the rest or rejects the caller — design.md
 * §3.4: a dead webhook never blocks or rolls back an action.
 *
 * An optional `record` hook runs FIRST under the same isolation (P2 step 7:
 * the Messages history is written even when a client is down, and a failed
 * write never blocks delivery).
 */
import type { NamedNotifier, NotificationEvent, Notifier } from './types.js';

export function createNotifierFanout(
  targets: NamedNotifier[],
  log: (message: string) => void = console.log,
  record?: (event: NotificationEvent) => void
): Notifier {
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      if (record !== undefined) {
        try {
          record(event);
        } catch (error) {
          log(`[notify] record failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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
