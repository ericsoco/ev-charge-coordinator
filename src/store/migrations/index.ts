/**
 * The ordered migration chain.
 *
 * One file per version (NNN-name.ts), integer versions — a linear chain, not
 * semver: DDL evolution has no patch/minor/major meaning, only "what has been
 * applied". The list here is explicit rather than filesystem-scanned so it is
 * deterministic and visible to tsc: a new migration file must be imported
 * below.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as initialSchema from './001-initial-schema.js';

export interface Migration {
  /** Monotonic schema version; equals PRAGMA user_version after up() runs. */
  version: number;
  /** Applies this step's DDL. Called inside a transaction by migrate(). */
  up: (db: DatabaseSync) => void;
}

/** Explicit ordered list — append new migrations at the end. */
export const MIGRATIONS: readonly Migration[] = [initialSchema];

/** The schema version this build writes and understands. */
export const CURRENT_SCHEMA_VERSION: number =
  MIGRATIONS[MIGRATIONS.length - 1].version;
