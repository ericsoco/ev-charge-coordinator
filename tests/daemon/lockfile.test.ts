/**
 * Lockfile: single-instance acquire, live-holder refusal, stale recovery,
 * corrupt refusal, ownership-checked release.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireLock,
  isPidAlive,
  readLock,
  CorruptLockError,
  DaemonAlreadyRunningError,
} from '../../src/daemon/lockfile.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-lock-'));
  file = path.join(dir, 'daemon.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that provably belonged to a process which has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  await once(child, 'exit');
  expect(pid).toBeGreaterThan(0);
  return pid;
}

describe('acquireLock', () => {
  it('acquires a fresh lock carrying our pid', async () => {
    const handle = await acquireLock(file);
    expect(handle.info.pid).toBe(process.pid);
    expect(fs.existsSync(file)).toBe(true);
    expect(readLock(file)).toEqual(handle.info);
    handle.release();
  });

  it('refuses a second acquire while the holder is alive', async () => {
    const first = await acquireLock(file);
    await expect(acquireLock(file)).rejects.toThrow(DaemonAlreadyRunningError);
    try {
      await acquireLock(file);
      expect.unreachable('second acquire must throw');
    } catch (error) {
      expect((error as Error).message).toContain(`pid ${process.pid}`);
      expect((error as Error).message).toContain('remove');
    }
    first.release();
  });

  it('recovers a stale lock whose holder is dead', async () => {
    fs.writeFileSync(file, JSON.stringify({ pid: await deadPid(), takenAt: 1 }));
    const handle = await acquireLock(file);
    expect(handle.info.pid).toBe(process.pid);
    handle.release();
  });

  it('refuses a corrupt lock instead of stealing it', async () => {
    fs.writeFileSync(file, 'garbage');
    await expect(acquireLock(file)).rejects.toThrow(CorruptLockError);
    expect(fs.existsSync(file)).toBe(true); // left intact for the operator
    // The message must say how to recover.
    await acquireLock(file).catch((error) => {
      expect((error as Error).message).toContain('remove');
    });
  });
});

describe('release', () => {
  it('removes our own lock', async () => {
    const handle = await acquireLock(file);
    handle.release();
    expect(fs.existsSync(file)).toBe(false);
    // Idempotent: a second release after removal is a no-op, not an error.
    handle.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a lock that no longer holds our pid', async () => {
    const handle = await acquireLock(file);
    fs.writeFileSync(file, JSON.stringify({ pid: 424_242, takenAt: 1 }));
    handle.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('readLock / isPidAlive', () => {
  it('readLock is null when no lock exists', () => {
    expect(readLock(file)).toBeNull();
  });

  it('isPidAlive distinguishes living and dead pids', async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-7)).toBe(false);
  });
});
