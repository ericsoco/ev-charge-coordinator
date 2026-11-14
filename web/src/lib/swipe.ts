/**
 * Horizontal swipe classification for tab navigation. Pure (no DOM APIs) so
 * every rule is unit-testable (the bsocChart.ts pattern); the touch wiring in
 * App.svelte feeds it. Touch-only by construction — the DOM layer listens to
 * touch events exclusively, so mouse/trackpad input never reaches here.
 */
import { TABS, type TabId } from './tabs';

/** Minimum horizontal travel (px) — taps and jitter are not swipes. */
export const SWIPE_MIN_DISTANCE_PX = 48;
/** Horizontal dominance factor over vertical — scrolling never switches tabs. */
export const SWIPE_DOMINANCE = 1.5;
/** Above this duration (ms) a movement is a slow drag/scroll, not a flick. */
export const SWIPE_MAX_DURATION_MS = 700;

/**
 * Marks elements that own their own gestural interface (charts) or controls
 * (nav) — swipes starting on them are ignored. Written literally in the
 * markup; the component tests pin the two together.
 */
export const SWIPE_IGNORE_ATTR = 'data-evcc-swipe-ignore';

export type SwipeDirection = 'left' | 'right';

/**
 * A deliberate horizontal flick: `dx` beyond the minimum distance, dominant
 * over `dy`, within the duration cap. Direction is `dx`'s sign (a left swipe
 * moves to the next tab). Everything else is null.
 */
export function classifySwipe(
  dx: number,
  dy: number,
  durationMs: number
): SwipeDirection | null {
  if (durationMs < 0 || durationMs > SWIPE_MAX_DURATION_MS) return null;
  const ax = Math.abs(dx);
  if (ax < SWIPE_MIN_DISTANCE_PX) return null;
  if (ax < Math.abs(dy) * SWIPE_DOMINANCE) return null;
  return dx < 0 ? 'left' : 'right';
}

/**
 * Tab one step away in TABS order — left advances, right goes back — or null
 * at the ends (no wrap-around).
 */
export function adjacentTabId(active: TabId, direction: SwipeDirection): TabId | null {
  const index = TABS.findIndex((tab) => tab.id === active);
  const next = index + (direction === 'left' ? 1 : -1);
  return TABS[next]?.id ?? null;
}