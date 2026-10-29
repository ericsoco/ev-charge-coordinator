/**
 * The one pure renderer: event → the single line every client ships.
 * Deliberately timestamp-free — push services stamp delivery time, and
 * daemon.log already prefixes its own local timestamps.
 */
import type { NotificationEvent } from './types.js';

type DecisionEvent = Extract<NotificationEvent, { type: 'decision-made' }>;

export function formatNotificationEvent(event: NotificationEvent): string {
  switch (event.type) {
    case 'plug-in-detected':
      return `🔌 plugged in (session ${event.sessionId}, ${soc(event.evSocPercent)}) — evaluating auto-start…`;
    case 'decision-made':
      return formatDecision(event);
    case 'charging-started':
      return `⚡ charging started (${soc(event.evSocPercent)})`;
    case 'charging-stopped':
      return `🛑 charging stopped (${soc(event.evSocPercent)})`;
    case 'failure':
      return `⚠ ${event.component} failed: ${event.message}`;
  }
}

function soc(value: number | null): string {
  return value === null ? 'SoC unknown' : `SoC ${value}%`;
}

/** Reason-shaped wording — the interlock and dry-run get their own voices. */
function formatDecision(event: DecisionEvent): string {
  const detail = event.reasonDetail ? ` — ${event.reasonDetail}` : '';
  switch (event.reasonCode) {
    case 'started':
      return `✅ auto-start: set limit ${event.targetPercent ?? '?'}% → charging (${soc(event.evSocPercent)})${detail}`;
    case 'dry_run':
      return `🧪 dry-run: would set limit ${event.targetPercent ?? '?'}% and start charging (autoStart off or --dry-run)`;
    case 'below_buffer':
      return `⛔ interlock: home battery below the buffer — not starting${detail}`;
    case 'service_error':
      return `❌ auto-start failed${detail}`;
    default:
      return `⛔ not started: ${event.reasonCode}${detail}`;
  }
}
