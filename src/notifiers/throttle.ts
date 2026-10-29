/**
 * Failure-notification throttle: a task failing every 60 s must not push a
 * phone every 60 s. The first failure per component notifies; the next is
 * allowed once `intervalMs` has passed (mirrors the scheduler's late-tick
 * reporting). Rejections pass through — daemon call sites isolate with .catch.
 */
import type { NotificationEvent, Notifier } from './types.js';

export const FAILURE_NOTIFY_INTERVAL_MS = 3_600_000;

export interface FailureThrottleOptions {
  nowMs?: () => number;
  intervalMs?: number;
}

export function createFailureThrottle(
  notifier: Notifier,
  options: FailureThrottleOptions = {}
): (event: NotificationEvent & { type: 'failure' }) => Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const intervalMs = options.intervalMs ?? FAILURE_NOTIFY_INTERVAL_MS;
  const lastSentAt = new Map<string, number>();
  return async (event) => {
    const now = nowMs();
    const last = lastSentAt.get(event.component);
    if (last !== undefined && now - last < intervalMs) return;
    lastSentAt.set(event.component, now);
    await notifier.notify(event);
  };
}
