/**
 * LaunchAgent lifecycle behind `evcc daemon stop|restart|install|uninstall`,
 * plus the `logs` terminal follower.
 *
 * The bash scripts stay the single source of truth for install/uninstall
 * (spawned, not re-implemented); stop/restart are the two operations the
 * scripts do not expose separately — a pure bootout, and a pure reload of the
 * already-installed plist (upgrades remain `daemon install`). The label comes
 * from the template plist, the same single source the scripts derive it from.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { getConfigDir } from '../utils/credentials.js';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string[], options?: { inherit?: boolean }) => ExecResult;

export interface LifecycleResult {
  ok: boolean;
  message: string;
}

export interface LifecycleDeps {
  exec?: ExecFn;
  /** Defaults to the repo's template plist; tests pass fixtures. */
  templatePath?: string;
  /** Defaults to ~/Library/LaunchAgents; tests pass temp dirs. */
  launchAgentsDir?: string;
  /** Defaults to the repo's scripts/ dir; tests pass temp dirs. */
  scriptDir?: string;
}

const SCRIPTS_DIR = fileURLToPath(new URL('../../scripts/', import.meta.url));

const defaultExec: ExecFn = (command, options) => {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: options?.inherit ? 'inherit' : 'pipe',
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
};

/** The template's first `com.*` string — the Label the scripts also derive. */
export function deriveLabel(plistTemplate: string): string {
  const match = plistTemplate.match(/<string>(com\.[^<]*)<\/string>/);
  if (!match) {
    throw new Error('could not derive the launchd Label from the plist template');
  }
  return match[1];
}

function guiDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchd lifecycle requires a POSIX user (no uid on this platform)');
  }
  return `gui/${uid}`;
}

function readLabel(templatePath: string): string {
  return deriveLabel(fs.readFileSync(templatePath, 'utf8'));
}

function failure(prefix: string, result: ExecResult): LifecycleResult {
  const detail = (result.stderr || result.stdout).trim();
  return { ok: false, message: `${prefix}: ${detail || `exit ${result.status}`}` };
}

/** Boot the LaunchAgent out of the gui domain; stopping twice is fine. */
export function stopDaemon(deps: LifecycleDeps = {}): LifecycleResult {
  const exec = deps.exec ?? defaultExec;
  const label = readLabel(deps.templatePath ?? path.join(SCRIPTS_DIR, 'evcc-daemon.plist'));
  const target = `${guiDomain()}/${label}`;
  if (exec(['/bin/launchctl', 'print', target]).status !== 0) {
    return { ok: true, message: `daemon not loaded (${target}) — nothing to stop.` };
  }
  const bootout = exec(['/bin/launchctl', 'bootout', target]);
  if (bootout.status !== 0) return failure(`bootout of ${target} failed`, bootout);
  return { ok: true, message: `daemon stopped (${target}).` };
}

/** Reload the already-installed plist: stop if loaded, then bootstrap. */
export function restartDaemon(deps: LifecycleDeps = {}): LifecycleResult {
  const exec = deps.exec ?? defaultExec;
  const label = readLabel(deps.templatePath ?? path.join(SCRIPTS_DIR, 'evcc-daemon.plist'));
  const launchAgents = deps.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plist = path.join(launchAgents, `${label}.plist`);
  if (!fs.existsSync(plist)) {
    return { ok: false, message: `${plist} not found — run \`evcc daemon install\` first.` };
  }
  const target = `${guiDomain()}/${label}`;
  if (exec(['/bin/launchctl', 'print', target]).status === 0) {
    const bootout = exec(['/bin/launchctl', 'bootout', target]);
    if (bootout.status !== 0) return failure(`bootout of ${target} failed`, bootout);
  }
  const bootstrap = exec(['/bin/launchctl', 'bootstrap', guiDomain(), plist]);
  if (bootstrap.status !== 0) return failure(`bootstrap of ${plist} failed`, bootstrap);
  return { ok: true, message: `daemon restarted (${target}).` };
}

export interface FollowLogsDeps {
  exec?: ExecFn;
  /** Default: `<config-dir>/logs`; tests pass temp dirs. */
  logsDir?: string;
  /** Recent lines shown before following (default 50). */
  lines?: number;
}

/**
 * Attach this terminal to the running daemon's log output: `tail -F` over
 * BOTH streams (daemon.log, and daemon.err.log where launchd sends stderr —
 * [proxy] lines and [daemon] task failures), stdio inherited so Ctrl-C ends
 * it. `-F` (by name, not descriptor): waits for files the daemon has not
 * written yet and survives the documented `: > daemon.log` truncation.
 */
export function followLogs(deps: FollowLogsDeps = {}): LifecycleResult {
  const logsDir = deps.logsDir ?? path.join(getConfigDir(), 'logs');
  if (!fs.existsSync(logsDir)) {
    return { ok: false, message: `${logsDir} not found — run \`evcc daemon install\` first.` };
  }
  const lines = deps.lines ?? 50;
  const files = ['daemon.log', 'daemon.err.log'].map((name) => path.join(logsDir, name));
  const exec = deps.exec ?? defaultExec;
  // stdio inherited: tail's output IS this process's output, and the
  // foreground group's Ctrl-C reaches both processes.
  const result = exec(['/usr/bin/tail', '-F', '-n', String(lines), ...files], { inherit: true });
  if (result.status !== 0 && result.status !== null) {
    return { ok: false, message: `following logs failed: tail exited ${result.status}` };
  }
  return { ok: true, message: '' };
}

/**
 * A daemon-level flag placed before a lifecycle subcommand — the positional
 * parse gives it to the parent, whose action never runs when a subcommand is
 * present, so it would otherwise be silently dropped (e.g. `daemon --dry-run
 * uninstall` running a REAL uninstall). Refuse instead of guessing.
 */
export function strayParentFlagProblem(opts: {
  once?: boolean;
  dryRun?: boolean;
  debug?: boolean;
}): string | null {
  const stray = [
    ...(opts.once === true ? ['--once'] : []),
    ...(opts.dryRun === true ? ['--dry-run'] : []),
    ...(opts.debug === true ? ['--debug'] : []),
  ];
  if (stray.length === 0) return null;
  return (
    `${stray.join(', ')} belongs to the foreground daemon command but was placed before a ` +
    'lifecycle subcommand — put options after it (e.g. `daemon install --dry-run`)'
  );
}

/** Run scripts/{install,uninstall}-daemon.sh with optional --dry-run passthrough. */
export function runDaemonScript(
  script: 'install' | 'uninstall',
  dryRun: boolean,
  deps: LifecycleDeps = {}
): LifecycleResult {
  const exec = deps.exec ?? defaultExec;
  const scriptPath = path.join(deps.scriptDir ?? SCRIPTS_DIR, `${script}-daemon.sh`);
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, message: `${scriptPath} not found (running outside the repo checkout?)` };
  }
  const result = exec(['/bin/bash', scriptPath, ...(dryRun ? ['--dry-run'] : [])], {
    inherit: true,
  });
  if (result.status !== 0) {
    return { ok: false, message: `${script}-daemon.sh exited with status ${result.status}` };
  }
  // The script printed its own output; nothing left to report.
  return { ok: true, message: '' };
}
