/**
 * Local wall-clock timestamps for human-facing log lines: YYYY-MM-DD
 * HH:MM:SS in the machine's zone. Machine surfaces (status --json,
 * store-report, SQLite ts_ms) keep ISO-8601 UTC — never format those with
 * this helper.
 */
import { format } from 'node:util';

export function formatLocalTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}


/**
 * Prepend local timestamps to every console line — installed once by the
 * daemon command so daemon.log and daemon.err.log share one format. Args
 * follow console's own formatting; multiline output (leftover tracebacks) is
 * stamped per line. Event times inside messages stay: they are data, not the
 * log clock.
 */
export function installConsoleTimestamps(nowMs: () => number = Date.now): void {
  const wrap =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      const stamp = formatLocalTimestamp(nowMs());
      const text = format(...args);
      if (text === '') {
        original(stamp);
        return;
      }
      for (const line of text.split('\n')) original(`${stamp} ${line}`);
    };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.info = wrap(console.info.bind(console));
  console.debug = wrap(console.debug.bind(console));
}

