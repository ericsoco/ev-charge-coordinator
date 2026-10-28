/**
 * formatLocalTimestamp: local wall-clock YYYY-MM-DD HH:MM:SS, TZ-agnostic by
 * construction (rebuilt from the same local getters on both sides).
 * installConsoleTimestamps: the daemon process's log-line prefix.
 */
import { describe, expect, it } from 'vitest';
import { format } from 'node:util';
import { formatLocalTimestamp, installConsoleTimestamps } from '../../src/utils/time.js';

describe('formatLocalTimestamp', () => {
  const ms = Date.UTC(2026, 9, 25, 14, 30, 45);

  it('formats from LOCAL getters (the wall clock an operator reads)', () => {
    const d = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, '0');
    expect(formatLocalTimestamp(ms)).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  });

  it('never renders the ISO/Zulu shape this replaces', () => {
    const rendered = formatLocalTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(rendered).not.toContain('T');
    expect(rendered).not.toMatch(/Z$/);
  });
});

describe('installConsoleTimestamps', () => {
  it('prefixes every line, keeping console argument formatting', () => {
    const instant = Date.UTC(2026, 9, 28, 2, 3, 4);
    const stamp = formatLocalTimestamp(instant);
    const captured: string[] = [];
    const savedLog = console.log;
    const savedError = console.error;
    try {
      console.log = (...args: unknown[]) => {
        captured.push(format(...args));
      };
      installConsoleTimestamps(() => instant);
      console.log('tick %d\nnext line', 7);
    } finally {
      console.log = savedLog;
      console.error = savedError;
    }
    // Multiline output is stamped per line; %d follows console semantics.
    expect(captured).toEqual([`${stamp} tick 7`, `${stamp} next line`]);
  });
});

