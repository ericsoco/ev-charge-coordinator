/**
 * Phase 0 characterization suite: the `charge-from-battery` percent rule.
 *
 * This pins the behavior Phase 4 deliberately DELETES (see workplan.md Phase 4b: kWh
 * energy math replaces the percent comparison). Two layers on purpose:
 *
 *  1. A source guard: the formula lives inline inside index.ts in two places and is not
 *     importable (index.ts runs program.parse() at module load), so the only way to pin
 *     it without refactoring first is to assert the exact expression is still there.
 *  2. A behavior mirror: the truth table the CLI produces today, including the
 *     dimensionally-invalid case that motivated the rewrite.
 *
 * When Phase 4 lands, this file should be deleted - that is the signal the old rule is
 * really gone from both call sites.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';

/**
 * Source guard for the legacy percent rule.
 *
 * Phase 1.5 moved the rule out of index.ts -- where it was duplicated between the
 * Commander action and the REPL switch -- into src/commands/vehicle.ts, where it
 * exists once and is called from both. The rule's *text* is therefore expected
 * exactly once now, not twice.
 *
 * The count is still the signal that matters: when Phase 4b replaces this with
 * energy math and deletes this file, the expression must stop being present at
 * all. A count of 1 in the right file catches that as well as a count of 2 in
 * the old one did.
 */
const RULE_SOURCE = fs.readFileSync(
  new URL('../../src/commands/vehicle.ts', import.meta.url),
  'utf8'
);

/** Where the rule used to be duplicated; must no longer contain it. */
const WIRING_SOURCE = fs.readFileSync(
  new URL('../../src/index.ts', import.meta.url),
  'utf8'
);

const AVAILABLE_EXPRESSION = 'const availableCharge = Math.max(0, batterySoc - buffer);';
const LIMIT_EXPRESSION =
  'const evLimit = Math.max(MIN_EV_CHARGE_LIMIT, Math.min(MAX_EV_CHARGE_LIMIT, availableCharge));';
const GUARD_EXPRESSION = 'if (evLimit <= MIN_EV_CHARGE_LIMIT) {';

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** Mirror of the rule in src/commands/vehicle.ts. */
function legacyRule(batterySoc: number, buffer: number) {
  const availableCharge = Math.max(0, batterySoc - buffer);
  const evLimit = Math.max(50, Math.min(100, availableCharge));
  return { availableCharge, evLimit, proceeds: evLimit > 50 };
}

describe('charge-from-battery - legacy percent rule is still in the source', () => {
  it('exists exactly once, in the shared handler', () => {
    expect(countOccurrences(RULE_SOURCE, AVAILABLE_EXPRESSION)).toBe(1);
  });

  it('clamps the EV limit in that single definition', () => {
    expect(countOccurrences(RULE_SOURCE, LIMIT_EXPRESSION)).toBe(1);
  });

  it('guards against a limit at or below Tesla 50% minimum there', () => {
    expect(countOccurrences(RULE_SOURCE, GUARD_EXPRESSION)).toBe(1);
  });

  it('is not duplicated back into the CLI wiring', () => {
    // Phase 1.5's whole point: the rule existed twice in index.ts and the copies
    // had already drifted. It must never return there. This guard is what makes
    // "defined in exactly one place" an enforced property rather than a habit.
    expect(countOccurrences(WIRING_SOURCE, AVAILABLE_EXPRESSION)).toBe(0);
    expect(countOccurrences(WIRING_SOURCE, LIMIT_EXPRESSION)).toBe(0);
    expect(countOccurrences(WIRING_SOURCE, GUARD_EXPRESSION)).toBe(0);
  });
});

describe('charge-from-battery - legacy percent rule behavior table', () => {
  it('subtracts the buffer and floors at zero', () => {
    expect(legacyRule(100, 20)).toEqual({ availableCharge: 80, evLimit: 80, proceeds: true });
    expect(legacyRule(60, 20)).toEqual({ availableCharge: 40, evLimit: 50, proceeds: false });
    expect(legacyRule(10, 80)).toEqual({ availableCharge: 0, evLimit: 50, proceeds: false });
  });

  it('treats a zero buffer as the whole battery being available', () => {
    expect(legacyRule(100, 0)).toEqual({ availableCharge: 100, evLimit: 100, proceeds: true });
  });

  it('clamps a very full battery plus negative buffer to 100', () => {
    expect(legacyRule(120, -10).evLimit).toBe(100);
  });

  it('stalls at exactly the 50% floor and reports not-enough-charge', () => {
    // availableCharge 50 -> evLimit 50 -> the `evLimit <= 50` guard aborts.
    expect(legacyRule(70, 20)).toEqual({ availableCharge: 50, evLimit: 50, proceeds: false });
    // One point of headroom is enough to proceed.
    expect(legacyRule(71, 20)).toEqual({ availableCharge: 51, evLimit: 51, proceeds: true });
  });

  it('pins the dimensionally-invalid case Phase 4 exists to fix', () => {
    // 100% house battery - 20% buffer reads as "80% available for the EV", so the CLI
    // asks for an 80% limit. On a 75 kWh Model Y that is ~60 kWh of energy, while a
    // 13.5 kWh aPower at 80% available holds only ~10.8 kWh. The command over-promises
    // by roughly 5.5x because two different denominators are being compared.
    const { evLimit, proceeds } = legacyRule(100, 20);
    const evBatteryKwh = 75;
    const batteryCapacityKwh = 13.5;

    const requestedKwh = (evLimit / 100) * evBatteryKwh;
    const actuallyAvailableKwh = ((100 - 20) / 100) * batteryCapacityKwh;

    expect(proceeds).toBe(true);
    expect(requestedKwh).toBe(60);
    expect(actuallyAvailableKwh).toBeCloseTo(10.8, 1);
    expect(requestedKwh / actuallyAvailableKwh).toBeGreaterThan(5);
  });
});
