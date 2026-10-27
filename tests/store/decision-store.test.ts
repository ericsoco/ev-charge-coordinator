/**
 * DecisionStore round-trip: boolean → INTEGER mapping, session lookup (the
 * idempotency read), reason_code CHECK enforcement, newest-row-wins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as decisions from '../../src/store/DecisionStore.js';
import type { NewDecision } from '../../src/store/types.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-decision-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE: NewDecision = {
  vehicleId: 'VIN',
  homeBatteryId: 'GW',
  tsMs: 1000,
  sessionId: 7,
  accepted: false,
  dryRun: true,
  reasonCode: 'dry_run',
  reasonDetail: 'would start (autoStart disabled): charge limit 51% (none)',
  filterResultsJson: '[{"type":"always","pass":true,"reason":"always"}]',
  limitedBy: 'none',
};

describe('insertDecision / decisionForSession', () => {
  it('round-trips with booleans mapped to 1/0', () => {
    const id = decisions.insertDecision(db, BASE);
    expect(decisions.decisionForSession(db, 7)).toEqual({
      id,
      siteId: 'home',
      vehicleId: 'VIN',
      homeBatteryId: 'GW',
      tsMs: 1000,
      sessionId: 7,
      accepted: 0,
      dryRun: 1,
      reasonCode: 'dry_run',
      reasonDetail: 'would start (autoStart disabled): charge limit 51% (none)',
      filterResultsJson: '[{"type":"always","pass":true,"reason":"always"}]',
      limitedBy: 'none',
    });
  });

  it('a live accepted decision lands as 1/0', () => {
    decisions.insertDecision(db, {
      ...BASE,
      accepted: true,
      dryRun: false,
      reasonCode: 'started',
    });
    const row = decisions.decisionForSession(db, 7)!;
    expect(row.accepted).toBe(1);
    expect(row.dryRun).toBe(0);
    expect(row.reasonCode).toBe('started');
  });

  it('omitted optional fields land as NULL', () => {
    decisions.insertDecision(db, {
      vehicleId: 'VIN',
      tsMs: 1,
      sessionId: 9,
      accepted: false,
      dryRun: false,
      reasonCode: 'below_buffer',
    });
    const row = decisions.decisionForSession(db, 9)!;
    expect(row.homeBatteryId).toBeNull();
    expect(row.reasonDetail).toBeNull();
    expect(row.filterResultsJson).toBeNull();
    expect(row.limitedBy).toBeNull();
  });

  it('a session without a decision returns null', () => {
    expect(decisions.decisionForSession(db, 42)).toBeNull();
  });

  it('the newest row wins for a session', () => {
    decisions.insertDecision(db, { ...BASE, tsMs: 1, reasonCode: 'below_buffer' });
    decisions.insertDecision(db, { ...BASE, tsMs: 2, reasonCode: 'filter_declined' });
    expect(decisions.decisionForSession(db, 7)?.reasonCode).toBe('filter_declined');
  });

  it('accepts the insufficient_energy verdict (migration 003)', () => {
    decisions.insertDecision(db, { ...BASE, reasonCode: 'insufficient_energy' });
    expect(decisions.decisionForSession(db, 7)?.reasonCode).toBe('insufficient_energy');
  });

  it('rejects a reason_code outside the CHECK', () => {
    const bad = { ...BASE, reasonCode: 'not_a_reason' } as unknown as NewDecision;
    expect(() => decisions.insertDecision(db, bad)).toThrow(/CHECK constraint/i);
  });
});
