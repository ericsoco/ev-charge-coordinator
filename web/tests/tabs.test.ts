import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, TABS, isTabId } from '../src/lib/tabs';

describe('tab registry', () => {
  it('lists the three required tabs in order with their icons', () => {
    expect(TABS.map((tab) => [tab.id, tab.label, tab.icon])).toEqual([
      ['now', 'Now', '⚡️'],
      ['then', 'Then', '🔄'],
      ['messages', 'Messages', '💬'],
    ]);
  });

  it('defaults to Now and validates tab ids', () => {
    expect(DEFAULT_TAB).toBe('now');
    expect(isTabId('then')).toBe(true);
    expect(isTabId('nope')).toBe(false);
  });
});