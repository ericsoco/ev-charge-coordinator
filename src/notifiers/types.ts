/**
 * The notifier surface (design.md §3.7): typed events, a pluggable client
 * interface, and the fanout's naming for failure logs. Config-file shapes
 * live in utils/daemonConfig — this package stays config-free.
 */
import type { DecisionReasonCode } from '../store/types.js';

/**
 * Every event a client can render. A discriminated union so each format is
 * exhaustive at compile time; adding a kind is additive for existing clients.
 */
export type NotificationEvent =
  | {
      type: 'plug-in-detected';
      tsMs: number;
      sessionId: number;
      vehicleId: string;
      evSocPercent: number | null;
    }
  | {
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
  | {
      type: 'charging-started';
      tsMs: number;
      sessionId: number | null;
      vehicleId: string;
      evSocPercent: number | null;
    }
  | {
      type: 'charging-stopped';
      tsMs: number;
      sessionId: number | null;
      vehicleId: string;
      evSocPercent: number | null;
    }
  | {
      type: 'failure';
      tsMs: number;
      component: string;
      message: string;
    }
  /** `evcc notify test` — never produced by the daemon. */
  | { type: 'test'; tsMs: number };

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
