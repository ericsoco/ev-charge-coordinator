/**
 * Single-instance guard: exactly one daemon per config dir.
 *
 * Why it exists: two daemons would race signed charge commands (P1b), break
 * the store's single-writer rule, and double API usage — so `runDaemon`
 * acquires this BEFORE opening the store. The lock is daemon-vs-daemon only:
 * CLI readers never take it (WAL + the read-only connection cover them).
 *
 * Mechanics: exclusive create (`wx`), `{ pid, takenAt }` written in one shot.
 * On conflict: holder alive (or EPERM) → refuse loudly; holder dead (ESRCH)
 * → stale after a crash → replace (this is what makes launchd KeepAlive
 * restarts self-healing); unparseable → refuse and tell the operator — a
 * lock we cannot identify is never silently stolen. Known limit: OS pid
 * reuse can make a stale lock look alive (documented in the error text).
 * `release()` deletes the file only while it still holds OUR pid.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../utils/credentials.js';
import { formatLocalTimestamp } from '../utils/time.js';

export interface LockInfo {
  pid: number;
  takenAt: number;
}

export class DaemonAlreadyRunningError extends Error {
  readonly lock: LockInfo;
  constructor(lock: LockInfo, file: string) {
    super(
      `Daemon already running (pid ${lock.pid}, since ` +
        `${formatLocalTimestamp(lock.takenAt)}). Stop it first — if no ` +
        `daemon is actually running, remove ${file}.`
    );
    this.name = 'DaemonAlreadyRunningError';
    this.lock = lock;
  }
}

export class CorruptLockError extends Error {
  constructor(file: string) {
    super(
      `Lock file ${file} is not a readable { pid, takenAt } JSON object. ` +
        `If no daemon is running, remove it.`
    );
    this.name = 'CorruptLockError';
  }
}

export function lockPath(): string {
  return path.join(getConfigDir(), 'daemon.lock');
}

/** True when a process answers to the pid (EPERM = alive, not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** null = missing; throws CorruptLockError = unreadable content. */
function readLockInfo(file: string): LockInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptLockError(file);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CorruptLockError(file);
  const { pid, takenAt } = parsed as Record<string, unknown>;
  if (typeof pid !== 'number' || typeof takenAt !== 'number') throw new CorruptLockError(file);
  return { pid, takenAt };
}

/** Read-only view for `status`. Throws CorruptLockError on unreadable content. */
export function readLock(file: string = lockPath()): LockInfo | null {
  return readLockInfo(file);
}

export interface LockHandle {
  readonly info: LockInfo;
  /** Deletes the file only if it still holds our pid. Never throws. */
  release(): void;
}

/**
 * Acquire the lock for this process. Rejects with
 * DaemonAlreadyRunningError (live holder, including our own pid) or
 * CorruptLockError; resolves stale locks (dead pid) automatically.
 */
export async function acquireLock(file: string = lockPath()): Promise<LockHandle> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid: process.pid, takenAt: Date.now() };

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'wx'); // O_EXCL — only one creator can win
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return { info, release: () => release(file, info.pid) };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      // Lock exists. A just-created one may still be mid-write → one retry
      // before believing its content.
      let existing: LockInfo | null;
      try {
        existing = readLockInfo(file);
      } catch (error2) {
        if (!(error2 instanceof CorruptLockError)) throw error2;
        await sleep(25);
        existing = readLockInfo(file); // still corrupt → propagates (loud)
      }

      if (existing === null) continue; // released between open and read → retry
      if (isPidAlive(existing.pid)) {
        // Live holder — including our own pid (double acquire in-process).
        throw new DaemonAlreadyRunningError(existing, file);
      }
      // Stale: the holder crashed. Remove and retry.
      try {
        fs.unlinkSync(file);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire lock ${file} after 3 attempts.`);
}

function release(file: string, pid: number): void {
  try {
    const current = readLockInfo(file);
    if (current !== null && current.pid === pid) fs.unlinkSync(file);
    // Foreign or missing → leave it alone.
  } catch {
    // Corrupt/unreadable → never delete a lock we cannot identify.
  }
}
