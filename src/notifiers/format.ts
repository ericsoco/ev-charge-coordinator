/**
 * The one pure renderer: event → the single line every client ships.
 * Deliberately timestamp-free — push services stamp delivery time, and
 * daemon.log already prefixes its own local timestamps.
 *
 * `notificationTitle` is its pair: the human headline for the Messages tab
 * and the Web Push payload (P2 step 7).
 */
import type { NotificationEvent } from './types.js';
import type { SessionStopReason } from '../store/types.js';

type DecisionEvent = Extract<NotificationEvent, { type: 'decision-made' }>;

export function formatNotificationEvent(event: NotificationEvent): string {
  switch (event.type) {
    case 'plug-in-detected':
      return `🔌 plugged in (session ${event.sessionId}, ${soc(event.evSocPercent)}) — evaluating auto-start…`;
    case 'decision-made':
      return formatDecision(event);
    case 'charging-started':
      return `⚡️ charging started (${soc(event.evSocPercent)})`;
    case 'charging-stopped':
      return `🛑 charging stopped (${soc(event.evSocPercent)})${stopReason(event.reason)}`;
    case 'session-retargeted':
      return `${event.direction === 'raise' ? '📈' : '📉'} ${event.detail}`;
    case 'failure':
      return `⚠️ ${event.component} failed: ${event.message}`;
    case 'test':
      return '🧪 evcc test notification — notifiers are wired';
  }
}

function soc(value: number | null): string {
  return value === null ? 'SoC unknown' : `SoC ${value}%`;
}

/** Suffix for a monitor-initiated stop; empty for manual/car stops. */
function stopReason(reason: SessionStopReason | null): string {
  if (reason === 'target_reached') return ' — target reached';
  if (reason === 'battery_buffer') return ' — battery hit buffer';
  return '';
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

/**
 * Headline for the Messages list / push payload — short, glanceable, and
 * paired with formatNotificationEvent's body (the line ntfy/Slack show).
 */
export function notificationTitle(event: NotificationEvent): string {
  switch (event.type) {
    case 'plug-in-detected':
      return 'Vehicle plugged in';
    case 'decision-made':
      if (event.dryRun) return 'Auto-start dry-run';
      return event.accepted ? 'Auto-start accepted' : 'Auto-start declined';
    case 'charging-started':
      return 'Charging started';
    case 'charging-stopped':
      return 'Charging stopped';
    case 'session-retargeted':
      return event.direction === 'raise' ? 'Target raised' : 'Target lowered';
    case 'failure':
      return `Failure: ${event.component}`;
    case 'test':
      return 'Test notification';
  }
}
