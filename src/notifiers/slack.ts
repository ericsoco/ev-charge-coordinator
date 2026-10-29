/**
 * Slack incoming-webhook client (design.md §3.7): POST {"text": <line>}.
 * A non-2xx response rejects — the fanout logs it.
 */
import { formatNotificationEvent } from './format.js';
import type { NotificationEvent, Notifier } from './types.js';

export interface SlackOptions {
  webhookUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createSlackNotifier(options: SlackOptions): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      const response = await fetchImpl(options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: formatNotificationEvent(event) }),
      });
      if (!response.ok) throw new Error(`slack responded ${response.status}`);
    },
  };
}
