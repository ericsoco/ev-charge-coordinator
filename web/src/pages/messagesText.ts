/**
 * Messages-tab text helpers — pure formatting, the nowText.ts pattern
 * (no DOM, tested headlessly).
 */

/** Local wall-clock stamp for a row: YYYY-MM-DD HH:MM (seconds dropped). */
export function formatMessageTime(tsMs: number): string {
  const date = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Empty-state copy — the standing answer before the first event lands. */
export const MESSAGES_EMPTY =
  'No notifications yet — the daemon records every notifier event here.';