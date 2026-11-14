import { describe, expect, it } from 'vitest';
import {
  adjacentTabId,
  classifySwipe,
  SWIPE_DOMINANCE,
  SWIPE_MAX_DURATION_MS,
  SWIPE_MIN_DISTANCE_PX,
} from '../src/lib/swipe';

describe('classifySwipe', () => {
  it('classifies horizontal flicks in both directions', () => {
    expect(classifySwipe(-SWIPE_MIN_DISTANCE_PX, 0, 200)).toBe('left');
    expect(classifySwipe(SWIPE_MIN_DISTANCE_PX, 0, 200)).toBe('right');
    expect(classifySwipe(-200, 10, 100)).toBe('left');
  });

  it('ignores movements below the minimum distance', () => {
    expect(classifySwipe(-(SWIPE_MIN_DISTANCE_PX - 1), 0, 100)).toBeNull();
    expect(classifySwipe(1, 0, 100)).toBeNull();
    expect(classifySwipe(0, 0, 100)).toBeNull();
  });

  it('ignores vertical scrolling and steep diagonals', () => {
    // Pure vertical: zero horizontal travel regardless of distance.
    expect(classifySwipe(0, -300, 100)).toBeNull();
    // Past the distance floor but not dominant over dy.
    const dx = SWIPE_MIN_DISTANCE_PX;
    const dy = dx / SWIPE_DOMINANCE; // exactly at dominance — still a swipe…
    expect(classifySwipe(dx, dy, 100)).toBe('right');
    expect(classifySwipe(dx, dy + 1, 100)).toBeNull(); // …one px steeper is not
  });

  it('ignores slow drags past the duration cap', () => {
    expect(classifySwipe(-200, 0, SWIPE_MAX_DURATION_MS + 1)).toBeNull();
    expect(classifySwipe(-200, 0, SWIPE_MAX_DURATION_MS)).toBe('left');
    expect(classifySwipe(-200, 0, -1)).toBeNull(); // nonsense clock
  });
});

describe('adjacentTabId', () => {
  it('steps through the tab order without wrapping', () => {
    expect(adjacentTabId('now', 'left')).toBe('then');
    expect(adjacentTabId('then', 'left')).toBe('messages');
    expect(adjacentTabId('messages', 'left')).toBeNull();
    expect(adjacentTabId('messages', 'right')).toBe('then');
    expect(adjacentTabId('then', 'right')).toBe('now');
    expect(adjacentTabId('now', 'right')).toBeNull();
  });
});