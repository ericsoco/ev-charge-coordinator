/**
 * openStoreReadOnly: the CLI's connection.
 *
 * - can read rows the daemon's writer connection committed (WAL cross-connection);
 * - cannot write (SQLITE_READONLY) — the single-writer rule is enforced by the
 *   driver, not just convention;
 * - never migrates: opening a schema-less file leaves it schema-less.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, openStoreReadOnly } from '../../src/store/database.js';
import * as ev from '../../src/store/EvStore.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ro-'));
  dbPath = path.join(dir, 'data.sqlite');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it('reads rows committed by a concurrent writer connection', () => {
  const writer = openStore(dbPath);
  ev.insertSample(writer, { vehicleId: 'VIN-A', tsMs: 10, socPercent: 50 });

  const reader = openStoreReadOnly(dbPath);
  try {
    expect(ev.latestSample(reader, 'VIN-A')?.socPercent).toBe(50);
    expect(
      (reader.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
    ).toBe('wal');
  } finally {
    reader.close();
    writer.close();
  }
});

it('rejects writes with a readonly error', () => {
  const writer = openStore(dbPath);
  writer.close();

  const reader = openStoreReadOnly(dbPath);
  try {
    expect(() =>
      reader
        .prepare(
          "INSERT INTO events (site_id, vehicle_id, ts_ms, kind) VALUES ('home', 'VIN', 1, 'plug_in')"
        )
        .run()
    ).toThrow(/readonly/i);
  } finally {
    reader.close();
  }
});

it('never migrates: a schema-less file stays schema-less', () => {
  // A bare file with no tables and no schema version.
  const bare = new DatabaseSync(dbPath);
  bare.close();

  const reader = openStoreReadOnly(dbPath);
  try {
    const tables = reader
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number | bigint };
    expect(Number(tables.n)).toBe(0);
  } finally {
    reader.close();
  }
});
