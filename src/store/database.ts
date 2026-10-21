/**
 * Opening the store: path, pragmas, migrations.
 *
 * One SQLite file at <config-dir>/data.sqlite (honors ECC_CONFIG_DIR). The
 * daemon is the only writer (openStore); CLI readers use openStoreReadOnly so
 * a read command can never race or block the writer. WAL keeps readers
 * lock-free while a write transaction is in flight.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getConfigDir } from '../utils/credentials.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';

/** The store lives beside config.json — same owner-only directory. */
export function storePath(): string {
  return path.join(getConfigDir(), 'data.sqlite');
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Fails loudly instead of guessing:
 * - the file's version is NEWER than this build (a downgraded binary) → refuse;
 * - a migration throws → rolled back, rethrown with the store path, file closed.
 */
function migrate(db: DatabaseSync, dbPath: string): void {
  const row = db.prepare('PRAGMA user_version').get() as {
    user_version: number | bigint;
  };
  const current = Number(row.user_version);

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Store ${dbPath} has schema version ${current}, newer than this build ` +
        `understands (${CURRENT_SCHEMA_VERSION}). Upgrade the app or point ` +
        `ECC_CONFIG_DIR at the right store.`
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      // PRAGMA cannot be parameterized; the value is this build's own integer.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.version} failed on ${dbPath}: ${message}`);
    }
  }
}

/**
 * Open (creating the directory/file as needed) with the daemon's pragmas and
 * apply pending migrations. This is the writer connection.
 */
export function openStore(dbPath: string = storePath()): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    migrate(db, dbPath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Read-only connection for CLI commands: never migrates, cannot write (a
 * write attempt rejects with SQLITE_READONLY — verified in tests).
 * Throws if the file does not exist; callers surface the "run the daemon
 * first" wording.
 */
export function openStoreReadOnly(dbPath: string = storePath()): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Run fn inside BEGIN IMMEDIATE/COMMIT; roll back and rethrow if it throws.
 * For multi-row units of work (one sampler tick = sample + counters).
 * The connection must not already hold a transaction.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
