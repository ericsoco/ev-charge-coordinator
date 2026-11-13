/**
 * Pure text formatting for the Now tab — no DOM, unit-testable. Product
 * copy: big numbers, a brief session sentence, local wall-clock times.
 */
import type { NowResponse, NowVehicle, NowBattery } from '../lib/api';

const STOP_REASON_LABELS: Record<string, string> = {
  target_reached: 'target reached',
  battery_buffer: 'battery buffer',
};

/** Local HH:MM — session times are human-facing (requirements 2a). */
export function formatTime(tsMs: number): string {
  const date = new Date(tsMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Sample age: "12s ago" / "12m ago" / "3h ago". */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Watts → compact kW caption ("5.12 kW"), null-safe ("—"). */
export function formatKw(watts: number | null): string {
  if (watts === null) return '—';
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW`;
}

/**
 * BSoC → rounded to one decimal digit, trailing zero suppressed ("54.3",
 * "54"), null-safe ("—"). The % unit is rendered separately (styled span),
 * so only the digits are returned.
 */
export function formatSocPercent(socPercent: number | null | undefined): string {
  if (socPercent === null || socPercent === undefined) return '—';
  return socPercent.toFixed(1).replace(/\.0$/, '');
}

/** Vehicle card caption: charging state + charge limit. */
export function vehicleCaption(vehicle: NowVehicle | null): string {
  if (vehicle === null) return '—';
  const state = vehicle.chargingState ?? 'unknown';
  return vehicle.chargeLimitSoc === null
    ? state
    : `${state} · limit ${vehicle.chargeLimitSoc}%`;
}

/** Battery card caption: solar + home load right now. */
export function batteryCaption(battery: NowBattery | null): string {
  if (battery === null) return '—';
  return `solar ${formatKw(battery.solarW)} · load ${formatKw(battery.homeLoadW)}`;
}

/**
 * The brief active-session sentence (requirements 2a):
 * "Charging since 14:03, target 60%" / "Plugged in since 14:03 · stopped: …"
 * / "Not charging".
 */
export function sessionLine(data: NowResponse | null): string {
  if (data === null) return '';
  const session = data.session;
  if (session === null) return 'Not charging';
  const charging = data.vehicle?.chargingState === 'Charging';
  const head = charging
    ? `Charging since ${formatTime(session.plugTsMs)}`
    : `Plugged in since ${formatTime(session.plugTsMs)}`;
  const target = session.targetPercent === null ? '' : `, target ${session.targetPercent}%`;
  const stopped =
    session.stopReason === null
      ? ''
      : ` · stopped: ${STOP_REASON_LABELS[session.stopReason] ?? session.stopReason}`;
  return `${head}${target}${stopped}`;
}
