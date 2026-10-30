/**
 * The notifier surface (design.md §3.7): one interface per event type, the
 * union as their sum, and the client interface + naming for failure logs.
 * Config-file shapes live in utils/daemonConfig — this package stays
 * config-free.
 */
import type { DecisionReasonCode } from '../store/types.js';

export interface PlugInDetectedEvent {
  type: 'plug-in-detected';
  tsMs: number;
  sessionId: number;
  vehicleId: string;
  evSocPercent: number | null;
}

export interface DecisionMadeEvent {
  type: 'decision-made';
  tsMs: number;
  sessionId: number | null;
  vehicleId: string;
  accepted: boolean;
  dryRun: boolean;
  reasonCode: DecisionReasonCode;
  reasonDetail: string | null;
  targetPercent: number | null;
  evSocPercent: number | null;
}

export interface ChargingStartedEvent {
  type: 'charging-started';
  tsMs: number;
  sessionId: number | null;
  vehicleId: string;
  evSocPercent: number | null;
}

export interface ChargingStoppedEvent {
  type: 'charging-stopped';
  tsMs: number;
  sessionId: number | null;
  vehicleId: string;
  evSocPercent: number | null;
}

export interface FailureEvent {
  type: 'failure';
  tsMs: number;
  component: string;
  message: string;
}

/** `evcc notify test` — never produced by the daemon. */
export interface TestEvent {
  type: 'test';
  tsMs: number;
}

export type NotificationEvent =
  | PlugInDetectedEvent
  | DecisionMadeEvent
  | ChargingStartedEvent
  | ChargingStoppedEvent
  | FailureEvent
  | TestEvent;

/**
 * Runtime list — the single source `NotifierType` is derived from, so error
 * messages, validation, and types can never drift apart.
 */
export const NOTIFIER_TYPES = ['log', 'ntfy', 'slack'] as const;
export type NotifierType = (typeof NOTIFIER_TYPES)[number];

/**
 * A configured notification client (design.md §3.7). Non-secret knobs only —
 * ntfy topics and Slack webhook URLs live in the credential store.
 */
export interface NotifierConfigEntry {
  type: NotifierType;
  /** ntfy only: push priority. Default 'default'. */
  priority?: 'default' | 'high';
  /** ntfy only: self-hosted server URL. Default https://ntfy.sh. */
  server?: string;
}

/**
 * Design.md §3.7 — the pluggable surface. A client may reject; isolation is
 * the fanout's job, never the caller's.
 */
export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

/** A configured client: `name` identifies it in failure logs. */
export interface NamedNotifier {
  name: string;
  notifier: Notifier;
}
