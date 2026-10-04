/**
 * Shared plumbing for command handlers.
 *
 * Every command's behaviour is defined once and invoked from two places: the
 * Commander action and the `start` REPL switch. Before this existed the logic
 * lived twice, and the copies had already drifted -- the REPL printed "Setting EV
 * limit to" and offered to start charging, the Commander path did neither, and
 * they disagreed about the not-enough-charge case. Phase 4b replaces the percent
 * math, so a second copy would have meant the change was made twice.
 *
 * Services and the credential store arrive through CommandContext rather than
 * being imported, so a handler can be tested without a real keychain, a Python
 * proxy, or the network.
 */

import type { FranklinWHService } from '../services/FranklinWHService.js';
import type { TeslaService } from '../services/TeslaService.js';
import type { CredentialStore } from '../utils/credentials.js';

/** Outcome of a handler. The caller decides how to render it and what to exit with. */
export interface CommandResult {
  ok: boolean;
  /** Set when ok is false. */
  error?: string;
}

export interface CommandContext {
  franklin: FranklinWHService | null;
  tesla: TeslaService | null;
  store: CredentialStore;
  /** Ask the user a question; injected so handlers are testable without a TTY. */
  ask: (question: string) => Promise<string>;
  /** Output sinks, defaulting to the console; injected by tests. */
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export function log(ctx: CommandContext, message: string): void {
  (ctx.log ?? console.log)(message);
}

export function logError(ctx: CommandContext, message: string): void {
  (ctx.errorLog ?? console.error)(message);
}

/**
 * Render a thrown value as one line.
 *
 * Shared so failures read the same everywhere. Previously some paths printed
 * `error.message`, others the raw object, and some called process.exit(1)
 * directly -- which meant the REPL could not continue past a failure that the
 * one-shot path treated as fatal.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tesla rejects a charge limit below 50%, so both the explicit setter and the
 * "charge from battery" rule treat 50 as the floor rather than clamping a
 * request the user did not make.
 */
export const MIN_EV_CHARGE_LIMIT = 50;
export const MAX_EV_CHARGE_LIMIT = 100;