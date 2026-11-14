/**
 * PushSubscriptionStore round-trip: endpoint-keyed upsert (keys rotate,
 * created_ts_ms survives), idempotent removal, list shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as push from '../../src/store/PushSubscriptionStore.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pushsub-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  endpoint: 'https://push.example/abc',
  p256dh: 'BP-key',
  auth: 'auth-key',
  createdTsMs: 1_000,
};

describe('upsertSubscription / removeSubscription / listSubscriptions', () => {
  it('inserts a subscription with site attribution', () => {
    push.upsertSubscription(db, BASE);
    expect(push.listSubscriptions(db)).toEqual([
      { id: 1, siteId: 'home', endpoint: BASE.endpoint, p256dh: 'BP-key', auth: 'auth-key', createdTsMs: 1_000 },
    ]);
  });

  it('re-subscribing the same endpoint upserts keys without duplicating', () => {
    push.upsertSubscription(db, BASE);
    push.upsertSubscription(db, { ...BASE, p256dh: 'BP-rotated', auth: 'auth-rotated', createdTsMs: 2_000 });
    const rows = push.listSubscriptions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('BP-rotated');
    expect(rows[0].auth).toBe('auth-rotated');
    expect(rows[0].createdTsMs).toBe(1_000); // first write wins
  });

  it('removeSubscription reports whether a row dropped', () => {
    push.upsertSubscription(db, BASE);
    expect(push.removeSubscription(db, BASE.endpoint)).toBe(true);
    expect(push.removeSubscription(db, BASE.endpoint)).toBe(false);
    expect(push.listSubscriptions(db)).toEqual([]);
  });
});