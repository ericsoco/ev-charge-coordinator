/**
 * The fanout's record hook: event → rendered notifications row, and the
 * store's type enum staying pinned to the notifier union (compile-time) so
 * a new NotificationEvent.type cannot skip the store CHECK by accident.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import { recentNotifications } from '../../src/store/NotificationStore.js';
import { createNotificationRecorder } from '../../src/notifiers/record.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';
import type { NotificationEventType } from '../../src/store/types.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-record-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createNotificationRecorder', () => {
  it('writes title + rendered body for a dispatched event', () => {
    createNotificationRecorder(db)({
      type: 'charging-started',
      tsMs: 5,
      sessionId: 9,
      vehicleId: 'VIN',
      evSocPercent: 54,
    });
    expect(recentNotifications(db, { limit: 1, offset: 0 })).toEqual([
      {
        id: 1,
        siteId: 'home',
        tsMs: 5,
        type: 'charging-started',
        title: 'Charging started',
        body: '⚡️ charging started (SoC 54%)',
      },
    ]);
  });

  it('store enum and notifier union cannot drift (compile-time)', () => {
    expectTypeOf<NotificationEvent['type']>().toEqualTypeOf<NotificationEventType>();
  });
});