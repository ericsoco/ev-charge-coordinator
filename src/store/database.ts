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
import { EXPECTED_SCHEMA } from './schema.js';

/** The store lives beside config.json — same owner-only directory. */
export function storePath(): string {
  return path.join(getConfigDir(), 'data.sqlite');
}

/** The file's schema version (PRAGMA user_version). */
function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as {
    user_version: number | bigint;
  };
  return Number(row.user_version);
}

function newerStoreError(dbPath: string, current: number): Error {
  return new Error(
    `Store ${dbPath} has schema version ${current}, newer than this build ` +
      `understands (${CURRENT_SCHEMA_VERSION}). Upgrade the app or point ` +
      `ECC_CONFIG_DIR at the right store.`
  );
}

function staleStoreError(dbPath: string, current: number): Error {
  return new Error(
    `Store ${dbPath} is at schema version ${current}, but this build expects ` +
      `${CURRENT_SCHEMA_VERSION}. The daemon applies migrations when it starts — ` +
      `run it once with this build, then retry.`
  );
}

function schemaMismatchError(dbPath: string, current: number, missing: string[]): Error {
  return new Error(
    `Store ${dbPath} is stamped schema version ${current} but is missing ` +
      `${missing.join(', ')} — the stamp does not match the schema (likely stamped ` +
      `by a different build's same-numbered migration). Repair: back up the store, ` +
      `rewind the stamp to the newest version whose schema is actually present ` +
      `(PRAGMA user_version = <n>), then run this build again so migrations can apply.`
  );
}

/**
 * The post-open schema guard: every expected table and column must actually
 * exist (PRAGMA table_info). Catches a version stamp that lies before any
 * query meets a missing column at runtime. Table names come from the pinned
 * EXPECTED_SCHEMA manifest (PRAGMA names cannot be bound).
 */
function verifySchema(db: DatabaseSync, dbPath: string): void {
  const missing: string[] = [];
  for (const { table, columns } of EXPECTED_SCHEMA) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (info.length === 0) {
      missing.push(`table ${table}`);
      continue;
    }
    const present = new Set(info.map((column) => column.name));
    for (const column of columns) {
      if (!present.has(column)) missing.push(`column ${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw schemaMismatchError(dbPath, readSchemaVersion(db), missing);
  }
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Fails loudly instead of guessing:
 * - the file's version is NEWER than this build (a downgraded binary) → refuse;
 * - a migration throws → rolled back, rethrown with the store path, file closed.
 */
function migrate(db: DatabaseSync, dbPath: string): void {
  const current = readSchemaVersion(db);

  if (current > CURRENT_SCHEMA_VERSION) {
    throw newerStoreError(dbPath, current);
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
    verifySchema(db, dbPath);
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
 * first" wording. A store whose schema is behind this build is refused with
 * the restart guidance — readers must fail helpfully instead of on a raw
 * missing column, and must never quietly run a migration a read-only open
 * promised not to run.
 */
export function openStoreReadOnly(dbPath: string = storePath()): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  const current = readSchemaVersion(db);
  if (current !== CURRENT_SCHEMA_VERSION) {
    db.close();
    throw current < CURRENT_SCHEMA_VERSION
      ? staleStoreError(dbPath, current)
      : newerStoreError(dbPath, current);
  }
  try {
    verifySchema(db, dbPath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Read-WRITE connection for CLI commands that must record (ownership claims,
 * `release-charging`): never migrates — migrations belong to the daemon's
 * `openStore` — and refuses a version mismatch exactly like
 * openStoreReadOnly. WAL + busy_timeout keep a write here lock-free beside
 * the daemon's writer; throws when the file does not exist ("run the daemon
 * first").
 */
export function openStoreWritable(dbPath: string = storePath()): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Store ${dbPath} does not exist — run the daemon (or start) first.`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  const current = readSchemaVersion(db);
  if (current !== CURRENT_SCHEMA_VERSION) {
    db.close();
    throw current < CURRENT_SCHEMA_VERSION
      ? staleStoreError(dbPath, current)
      : newerStoreError(dbPath, current);
  }
  try {
    verifySchema(db, dbPath);
  } catch (error) {
    db.close();
    throw error;
  }
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
