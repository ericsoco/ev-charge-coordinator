/**
 * NotificationStore round-trip: rendered rows land as written, newest-first
 * paging for GET /api/messages, the type CHECK, and the retention prune.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/store/database.js';
import * as notifications from '../../src/store/NotificationStore.js';
import type { NewNotification } from '../../src/store/types.js';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-notification-'));
  db = openStore(path.join(dir, 'data.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE: NewNotification = {
  tsMs: 1_000,
  type: 'charging-started',
  title: 'Charging started',
  body: '⚡️ charging started (SoC 54%)',
};

describe('insertNotification / recentNotifications', () => {
  it('round-trips a rendered event', () => {
    const id = notifications.insertNotification(db, BASE);
    expect(notifications.recentNotifications(db, { limit: 10, offset: 0 })).toEqual([
      { id, siteId: 'home', tsMs: 1_000, type: 'charging-started', title: 'Charging started', body: '⚡️ charging started (SoC 54%)' },
    ]);
  });

  it('pages newest-first (ts_ms, then id)', () => {
    notifications.insertNotification(db, { ...BASE, tsMs: 3, title: 'oldest-first-check' });
    notifications.insertNotification(db, { ...BASE, tsMs: 1 });
    notifications.insertNotification(db, { ...BASE, tsMs: 2 });
    const titles = notifications
      .recentNotifications(db, { limit: 2, offset: 1 })
      .map((row) => row.tsMs);
    expect(titles).toEqual([2, 1]);
  });

  it('rejects a type outside the CHECK enum', () => {
    const bad = { ...BASE, type: 'bogus-type' } as unknown as NewNotification;
    expect(() => notifications.insertNotification(db, bad)).toThrow(/CHECK constraint/i);
  });

  it('pruneNotifications drops rows older than retention and counts them', () => {
    const dayMs = 86_400_000;
    notifications.insertNotification(db, { ...BASE, tsMs: 10 }); // ancient
    notifications.insertNotification(db, { ...BASE, tsMs: 20 });
    notifications.insertNotification(db, { ...BASE, tsMs: 100 * dayMs }); // recent
    expect(notifications.pruneNotifications(db, 30, 100 * dayMs)).toBe(2);
    expect(notifications.recentNotifications(db, { limit: 10, offset: 0 })).toHaveLength(1);
  });
});