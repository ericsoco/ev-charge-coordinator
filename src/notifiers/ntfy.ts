/**
 * ntfy client (design.md §3.7): POST the formatted line to `<server>/<topic>`
 * with a title + optional priority header. A non-2xx response rejects — the
 * fanout logs it; this client never swallows its own failures.
 */
import { formatNotificationEvent } from './format.js';
import type { NotificationEvent, Notifier } from './types.js';

export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

export interface NtfyOptions {
  /** Topic path segment; treated as a secret path, URL-encoded. */
  topic: string;
  /** Self-hosted ntfy server. Default https://ntfy.sh. */
  server?: string;
  priority?: 'default' | 'high';
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createNtfyNotifier(options: NtfyOptions): Notifier {
  const server = (options.server ?? NTFY_DEFAULT_SERVER).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      const response = await fetchImpl(`${server}/${encodeURIComponent(options.topic)}`, {
        method: 'POST',
        headers: {
          Title: `evcc ${event.type}`,
          ...(options.priority !== undefined ? { Priority: options.priority } : {}),
        },
        body: formatNotificationEvent(event),
      });
      if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
    },
  };
}
