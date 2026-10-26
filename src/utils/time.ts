/**
 * Local wall-clock timestamps for human-facing log lines: YYYY-MM-DD
 * HH:MM:SS in the machine's zone. Machine surfaces (status --json,
 * store-report, SQLite ts_ms) keep ISO-8601 UTC — never format those with
 * this helper.
 */
export function formatLocalTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
