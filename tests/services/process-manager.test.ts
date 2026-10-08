/**
 * ProcessManager: the state file that makes `exit` work from a fresh process.
 *
 * Before this existed, `exit` only ever saw module-level services, which are null
 * in any process that did not itself run `start` -- so `exit` did nothing and then
 * reported success. These tests pin the file handling, stale-PID handling, and
 * signal escalation, none of which need a proxy or Python.
 *
 * Every case runs against a temp ECC_CONFIG_DIR (set globally in
 * vitest.config.ts) so the developer's real runtime.json is never touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearRuntimeState,
  isProcessAlive,
  readRuntimeState,
  runtimeStatePath,
  terminateProcess,
  terminateProcessWith,
  writeRuntimeState,
} from '../../src/services/ProcessManager.js';

/** Long-lived process used as a stand-in for the Python proxy. */
function spawnSleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (child.pid === undefined) throw new Error('failed to spawn');
  return child.pid;
}

function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!isProcessAlive(pid)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  });
}

describe('runtime state file', () => {
  // No per-test config dir on purpose. credentials.ts captures ECC_CONFIG_DIR once
  // at module load, so reassigning process.env mid-suite has no effect -- and an
  // earlier version of this file did exactly that, which made every case share one
  // directory and the "no file exists" case fail. vitest.config.ts already points
  // ECC_CONFIG_DIR at a temp dir for the whole run, so the isolation is real; here
  // it just has to be cleaned between cases.
  beforeEach(() => {
    clearRuntimeState();
  });

  it('round-trips a state', () => {
    const state = { pid: 4242, port: 3001, startedAt: 1700000000000 };
    writeRuntimeState(state);
    expect(readRuntimeState()).toEqual(state);
  });

  it('round-trips the proxy token when present (Phase 3)', () => {
    writeRuntimeState({ pid: 4242, port: 3001, startedAt: 1, token: 'secret-token' });
    expect(readRuntimeState()?.token).toBe('secret-token');
  });

  it('still parses a state file written before Phase 3, without a token', () => {
    // Transitional: an old file must not read as corrupt -- `exit` degrades to
    // SIGTERM and attach lets the proxy's 401 speak, both honest outcomes.
    fs.writeFileSync(runtimeStatePath(), JSON.stringify({ pid: 1, port: 3001, startedAt: 1 }));
    expect(readRuntimeState()?.token).toBeUndefined();
  });

  it('treats a non-string token as corrupt rather than sending it', () => {
    fs.writeFileSync(
      runtimeStatePath(),
      JSON.stringify({ pid: 1, port: 3001, startedAt: 1, token: 42 })
    );
    expect(readRuntimeState()).toBeNull();
  });

  it('reports nothing when no file exists', () => {
    expect(readRuntimeState()).toBeNull();
  });

  it('writes the file owner-only, since it records a live PID and port', () => {
    writeRuntimeState({ pid: 1, port: 3001, startedAt: Date.now() });
    // 0o600: owner read/write only. A world-readable file tells any local user
    // which process to target.
    expect(fs.statSync(runtimeStatePath()).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on an already world-readable file', () => {
    // A file written by an older version, or copied, could arrive 0644. rename
    // preserves the temp file's mode, so this is not automatic.
    fs.writeFileSync(runtimeStatePath(), JSON.stringify({ pid: 1, port: 3001, startedAt: 1 }));
    fs.chmodSync(runtimeStatePath(), 0o644);

    writeRuntimeState({ pid: 2, port: 3001, startedAt: Date.now() });
    expect(fs.statSync(runtimeStatePath()).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    writeRuntimeState({ pid: 1, port: 3001, startedAt: Date.now() });
    const dir = path.dirname(runtimeStatePath());
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('treats a corrupt file as absent rather than throwing', () => {
    // A half-written or hand-edited file must not make every later `exit` fail.
    fs.writeFileSync(runtimeStatePath(), '{ not json');
    expect(readRuntimeState()).toBeNull();
  });

  it('rejects a file missing required fields', () => {
    fs.writeFileSync(runtimeStatePath(), JSON.stringify({ pid: 'abc' }));
    expect(readRuntimeState()).toBeNull();
  });

  it('clears idempotently', () => {
    writeRuntimeState({ pid: 1, port: 3001, startedAt: Date.now() });
    clearRuntimeState();
    expect(readRuntimeState()).toBeNull();
    expect(() => clearRuntimeState()).not.toThrow();
  });

  it('overwrites a stale state rather than appending', () => {
    writeRuntimeState({ pid: 1, port: 3001, startedAt: 1 });
    writeRuntimeState({ pid: 2, port: 3001, startedAt: 2 });
    expect(readRuntimeState()?.pid).toBe(2);
  });
});

describe('isProcessAlive', () => {
  it('finds a live process', () => {
    const pid = spawnSleeper();
    try {
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });

  it('reports a dead pid as dead', async () => {
    const pid = spawnSleeper();
    process.kill(pid, 'SIGKILL');
    // SIGKILL is delivered asynchronously, so the pid is still visible for a
    // moment after the call. Asserting immediately would be a race that passes or
    // fails depending on machine load.
    await expect(waitForExit(pid)).resolves.toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it.each([0, -1, Number.NaN, 1.5])('rejects %s without signalling', (bad) => {
    expect(isProcessAlive(bad)).toBe(false);
  });
});

describe('terminateProcess', () => {
  it('reports gone when nothing is running', async () => {
    await expect(terminateProcess(999999)).resolves.toBe('gone');
  });

  it('stops a live process and confirms it is gone', async () => {
    const pid = spawnSleeper();
    // The escalation must verify rather than assume: the proxy's /shutdown
    // replies before its deferred SIGTERM lands, so "the endpoint returned" is
    // not evidence the process ended.
    await expect(terminateProcess(pid)).resolves.toMatch(/exited|killed/);
    await expect(waitForExit(pid)).resolves.toBe(true);
  });

  it('escalates to SIGKILL for a process that ignores SIGTERM', async () => {
    // Simulated through the injectable signal seam rather than with a real
    // process. Spawning something that genuinely ignores SIGTERM proved
    // unreliable as a fixture: a Node child with a SIGTERM listener and a
    // `trap '' TERM` subshell both exited under vitest, even though the trap works
    // in a plain shell. A test whose outcome depends on how the runner schedules
    // signals is worse than a simulated one, so the escalation is asserted
    // directly: which signals, in which order, and what gets reported.
    const sent: string[] = [];
    let alive = true;

    const outcome = await terminateProcessWith(4242, {
      graceMs: 0,
      pollMs: 1,
      isAlive: () => alive,
      send: (_pid, signal) => {
        sent.push(signal);
        // Refuse to die on SIGTERM, the way a wedged proxy does.
        if (signal === 'SIGKILL') alive = false;
      },
    });

    expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(outcome).toBe('killed');
  });

  it('does not escalate when SIGTERM is honoured', async () => {
    const sent: string[] = [];
    const outcome = await terminateProcessWith(4242, {
      graceMs: 50,
      pollMs: 1,
      isAlive: () => sent.length === 0, // alive until the first signal arrives
      send: (_pid, signal) => sent.push(signal),
    });

    expect(sent).toEqual(['SIGTERM']);
    expect(outcome).toBe('exited');
  });
});