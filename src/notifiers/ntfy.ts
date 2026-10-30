/**
 * ntfy client (design.md §3.7): POST the formatted line to `<server>/<topic>`
 * with a title + optional priority header. A non-2xx response rejects — the
 * fanout logs it; this client never swallows its own failures. ntfy's config
 * knobs are parsed here too — the daemon keeps no ntfy knowledge.
 */
import { formatNotificationEvent } from './format.js';
import type { NotificationEvent, Notifier, NotifierConfigEntry } from './types.js';

export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';
export const NTFY_PRIORITIES = ['default', 'high'] as const;
export type NtfyPriority = (typeof NTFY_PRIORITIES)[number];

export interface NtfyOptions {
  /** Topic path segment; treated as a secret path, URL-encoded. */
  topic: string;
  /** Self-hosted ntfy server. Default https://ntfy.sh. */
  server?: string;
  priority?: 'default' | 'high';
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Validate one ntfy entry's knobs; `entry: null` when a problem was found. */
export function parseNtfyEntry(
  record: Record<string, unknown>,
  where: string
): { entry: NotifierConfigEntry | null; problems: string[] } {
  const entry: NotifierConfigEntry = { type: 'ntfy' };

  const priority = record.priority;
  if (priority !== undefined && priority !== null) {
    if (
      typeof priority !== 'string' ||
      !(NTFY_PRIORITIES as readonly string[]).includes(priority)
    ) {
      return {
        entry: null,
        problems: [
          `${where}.priority = ${JSON.stringify(priority)} (expected ` +
            `${NTFY_PRIORITIES.map((value) => `"${value}"`).join(' or ')})`,
        ],
      };
    }
    entry.priority = priority as NtfyPriority;
  }

  const server = record.server;
  if (server !== undefined && server !== null) {
    if (typeof server !== 'string' || !/^https?:\/\/\S+$/.test(server)) {
      return {
        entry: null,
        problems: [`${where}.server = ${JSON.stringify(server)} (must be an http(s) URL)`],
      };
    }
    entry.server = server;
  }

  return { entry, problems: [] };
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
