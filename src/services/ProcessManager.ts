/**
 * Tracks the running Python proxy so `exit` can stop it from a *different*
 * process.
 *
 * Before this existed, `exit` only ever saw module-level services, which are
 * `null` in any process that did not itself run `start`. So `exit` from a fresh
 * terminal did nothing and then printed "✓ Services stopped" -- reporting a
 * success it had not achieved. A PID on disk is the minimum needed to make that
 * command honest.
 *
 * Note on the stored fields: there is deliberately no token hash here. A secret
 * is not introduced until Phase 3 adds the shared proxy token, and storing a
 * hash of a credential nobody can yet authenticate against would be a field
 * with no reader and a needless thing to reason about.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../utils/credentials.js';

/** File mode: owner may read and write; nobody else may touch it. */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

const STATE_FILENAME = 'runtime.json';

export interface RuntimeState {
  /** OS process id of the Python proxy. */
  pid: number;
  /** Loopback port the proxy listens on. */
  port: number;
  /** Unix ms, so a stale file can be recognised as stale. */
  startedAt: number;
}

export function runtimeStatePath(): string {
  return path.join(getConfigDir(), STATE_FILENAME);
}

/**
 * True when a process with this id exists.
 *
 * `kill(pid, 0)` performs the permission and existence checks without sending a
 * signal: it throws ESRCH when nothing is there and EPERM when the process
 * belongs to another user. Both mean "not ours to use", so both read as dead.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but is owned by someone else, so it is not the proxy
    // we started. Treating it as alive would make `exit` kill a stranger's
    // process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the recorded state, or null when there is none.
 *
 * A corrupt file is reported as absent rather than thrown: a half-written or
 * hand-edited runtime.json must not make every later `exit` fail. The user is
 * far better served by "nothing is running" than by a stack trace, and clearing
 * the file is recoverable either way.
 */
export function readRuntimeState(): RuntimeState | null {
  try {
    const raw = fs.readFileSync(runtimeStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    if (
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.port !== 'number' ||
      typeof parsed?.startedAt !== 'number'
    ) {
      return null;
    }
    return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/**
 * Write the state atomically.
 *
 * A plain writeFile can be interrupted partway, leaving truncated JSON that the
 * next `exit` cannot parse. Writing to a sibling temp file and renaming means
 * readers only ever observe the complete old file or the complete new one.
 */
export function writeRuntimeState(state: RuntimeState): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });

  const target = runtimeStatePath();
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: OWNER_ONLY_FILE });
  fs.renameSync(temp, target);
  // rename preserves the temp file's mode, but an existing target keeps its own,
  // so set it explicitly: an older world-readable file must not survive.
  fs.chmodSync(target, OWNER_ONLY_FILE);
}

/** Remove the state file. Safe to call when it does not exist. */
export function clearRuntimeState(): void {
  try {
    fs.unlinkSync(runtimeStatePath());
  } catch {
    // Already gone; nothing to do.
  }
}

/** Injectable process-control seam, so the escalation can be tested deterministically. */
export interface SignalDeps {
  /** Whether the pid is still running. */
  isAlive: (pid: number) => boolean;
  /** Deliver a signal. Must not throw for a dead process. */
  send: (pid: number, signal: NodeJS.Signals) => void;
  /** Wait helper, injectable so tests need no real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Send a signal and wait for the process to actually disappear.
 *
 * Escalates SIGTERM -> SIGKILL rather than assuming the signal was honoured,
 * which matters here specifically because the Python proxy's /shutdown endpoint
 * calls os._exit(0): the process does go away, but by a path that leaves no
 * chance for cleanup, so nothing guarantees it is gone by the time the request
 * returns.
 */
export async function terminateProcessWith(
  pid: number,
  options: { graceMs?: number; pollMs?: number } & Partial<SignalDeps> = {}
): Promise<'exited' | 'killed' | 'gone'> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const send = options.send ?? ((target: number, signal: NodeJS.Signals) => {
    process.kill(target, signal);
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = options.graceMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;

  if (!isAlive(pid)) return 'gone';

  try {
    send(pid, 'SIGTERM');
  } catch {
    return 'gone';
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return 'exited';
    await sleep(pollMs);
  }

  try {
    send(pid, 'SIGKILL');
  } catch {
    return 'gone';
  }

  // SIGKILL is not instant on every platform; give it a moment before declaring
  // failure so the caller can report accurately.
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!isAlive(pid)) return 'killed';
    await sleep(pollMs);
  }
  return 'killed';
}

/** terminateProcess against the real process table. */
export function terminateProcess(
  pid: number,
  options: { graceMs?: number; pollMs?: number } = {}
): Promise<'exited' | 'killed' | 'gone'> {
  return terminateProcessWith(pid, options);
}