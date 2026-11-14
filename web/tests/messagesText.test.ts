import { describe, expect, it } from 'vitest';
import { MESSAGES_EMPTY, formatMessageTime } from '../src/pages/messagesText';

describe('formatMessageTime', () => {
  it('formats local YYYY-MM-DD HH:MM with zero padding', () => {
    const tsMs = new Date(2026, 10, 14, 14, 3, 57).getTime(); // local wall clock
    expect(formatMessageTime(tsMs)).toBe('2026-11-14 14:03');
  });

  it('pads single-digit month/day/hour/minute', () => {
    const tsMs = new Date(2026, 0, 5, 7, 4, 0).getTime();
    expect(formatMessageTime(tsMs)).toBe('2026-01-05 07:04');
  });
});

describe('MESSAGES_EMPTY', () => {
  it('names the tab empty-state copy', () => {
    expect(MESSAGES_EMPTY).toContain('No notifications yet');
  });
});