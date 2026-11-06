/**
 * Legacy-store fixture: builds a real store frozen at `version` by applying
 * the migration chain up to it — the exact shape a machine running an older
 * daemon build has on disk (used to pin stale-schema behavior everywhere
 * readers meet a store the daemon has not restarted against yet).
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../src/store/migrations/index.js';

export function makeLegacyStoreAt(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    migration.up(db);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  db.close();
}