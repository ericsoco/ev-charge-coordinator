/**
 * formatLocalTimestamp: local wall-clock YYYY-MM-DD HH:MM:SS, TZ-agnostic by
 * construction (rebuilt from the same local getters on both sides).
 */
import { describe, expect, it } from 'vitest';
import { formatLocalTimestamp } from '../../src/utils/time.js';

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
