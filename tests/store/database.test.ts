/**
 * openStore / openStoreReadOnly / migrate — schema v1 and its guards.
 *
 * Isolation: explicit tmp-dir paths (openStore takes dbPath), so nothing here
 * touches a real store; storePath() is asserted against the ECC_CONFIG_DIR
 * that vitest.config.ts sets for every suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, storePath } from '../../src/store/database.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/store/migrations/index.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-store-'));
  dbPath = path.join(dir, 'data.sqlite');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return row[name];
}

describe('storePath', () => {
  it('lives in the configured config dir', () => {
    expect(storePath()).toBe(
      path.join(process.env.ECC_CONFIG_DIR ?? '', 'data.sqlite')
    );
  });
});

describe('openStore', () => {
  it('creates the file with WAL and every v1 table', () => {
    const db = openStore(dbPath);
    try {
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(pragma(db, 'journal_mode')).toBe('wal');
      expect(pragma(db, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);

      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .all() as unknown as { name: string }[]
      )
        .map((row) => row.name)
        .sort();
      expect(tables).toEqual(
        [
          'decisions',
          'events',
          'ev_samples',
          'home_battery_samples',
          'home_energy_counters',
          'sessions',
          'weather_forecasts',
        ].sort()
      );
    } finally {
      db.close();
    }
  });

  it('creates a missing containing directory owner-only', () => {
    const nested = path.join(dir, 'deeper', 'data.sqlite');
    const db = openStore(nested);
    db.close();
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
  });

  it('re-opening is idempotent and keeps data', () => {
    let db = openStore(dbPath);
    db.prepare(
      "INSERT INTO events (site_id, vehicle_id, ts_ms, kind) VALUES ('home', 'VIN', 1, 'plug_in')"
    ).run();
    db.close();

    db = openStore(dbPath);
    try {
      expect(pragma(db, 'user_version')).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  it('refuses a store written by a newer build instead of guessing', () => {
    const newer = new DatabaseSync(dbPath);
    newer.exec('PRAGMA user_version = 999');
    newer.close();

    expect(() => openStore(dbPath)).toThrow(/newer than this build/);
    // The refused open must not have rewritten the version.
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(pragma(check, 'user_version')).toBe(999);
    check.close();
  });

  it('enforces the site_id CHECK enum at the storage layer', () => {
    const db = openStore(dbPath);
    try {
      expect(() =>
        db
          .prepare(
            "INSERT INTO home_battery_samples (site_id, home_battery_id, ts_ms) VALUES ('cabin', 'GW', 1)"
          )
          .run()
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
