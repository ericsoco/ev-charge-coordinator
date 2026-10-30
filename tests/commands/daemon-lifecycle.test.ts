/**
 * daemon stop/restart/install/uninstall: label derivation from the template,
 * launchctl sequences through the injectable exec seam, script spawning with
 * --dry-run passthrough. Nothing here touches the real launchd domain.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import {
  deriveLabel,
  followLogs,
  restartDaemon,
  runDaemonScript,
  stopDaemon,
  strayParentFlagProblem,
  type ExecFn,
} from '../../src/commands/daemonLifecycle.js';

const TEMPLATE = `<?xml version="1.0"?>
<plist><dict>
  <key>Label</key>
  <string>com.transmote.ev-charge-coordinator.daemon</string>
</dict></plist>`;

const TARGET = `gui/${process.getuid?.()}/com.transmote.ev-charge-coordinator.daemon`;

const dirs: string[] = [];
let templatePath: string;
let launchAgentsDir: string;
let scriptDir: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-lifecycle-'));
  dirs.push(dir);
  templatePath = path.join(dir, 'evcc-daemon.plist');
  fs.writeFileSync(templatePath, TEMPLATE);
  launchAgentsDir = path.join(dir, 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir);
  scriptDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptDir);
});

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Exec seam: records every command; handler decides the exit status. */
function recorder(handler: (command: string[]) => number | null = () => 0) {
  const calls: { command: string[]; inherit: boolean | undefined }[] = [];
  const exec: ExecFn = (command, options) => {
    calls.push({ command, inherit: options?.inherit });
    const status = handler(command);
    return { status, stdout: '', stderr: status === 0 ? '' : 'boom' };
  };
  return { calls, exec };
}

describe('deriveLabel', () => {
  it('takes the first com.* string (the Label) from the template', () => {
    expect(deriveLabel(TEMPLATE)).toBe('com.transmote.ev-charge-coordinator.daemon');
  });

  it('fails loudly when the template carries no label', () => {
    expect(() => deriveLabel('<plist><dict></dict></plist>')).toThrow(/could not derive/);
  });

  it('the repo template still yields the label the scripts derive', () => {
    const repoTemplate = fs.readFileSync(
      new URL('../../scripts/evcc-daemon.plist', import.meta.url),
      'utf8'
    );
    expect(deriveLabel(repoTemplate)).toBe('com.transmote.ev-charge-coordinator.daemon');
  });
});

describe('stopDaemon', () => {
  it('probes first and boots out a loaded agent', () => {
    const { calls, exec } = recorder();
    const result = stopDaemon({ exec, templatePath });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('stopped');
    expect(calls.map((call) => call.command)).toEqual([
      ['/bin/launchctl', 'print', TARGET],
      ['/bin/launchctl', 'bootout', TARGET],
    ]);
  });

  it('a not-loaded agent is a friendly success without bootout', () => {
    const { calls, exec } = recorder(() => 1);
    const result = stopDaemon({ exec, templatePath });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not loaded');
    expect(calls).toHaveLength(1);
  });

  it('reports a failing bootout', () => {
    const { exec } = recorder((command) => (command[1] === 'bootout' ? 1 : 0));
    const result = stopDaemon({ exec, templatePath });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('bootout');
  });
});

describe('restartDaemon', () => {
  const PLIST_NAME = 'com.transmote.ev-charge-coordinator.daemon.plist';

  it('refuses with guidance when the agent was never installed', () => {
    const { calls, exec } = recorder();
    const result = restartDaemon({ exec, templatePath, launchAgentsDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('daemon install');
    expect(calls).toEqual([]);
  });

  it('loaded agent: print, bootout, bootstrap', () => {
    const plist = path.join(launchAgentsDir, PLIST_NAME);
    fs.writeFileSync(plist, TEMPLATE);
    const { calls, exec } = recorder(() => 0);
    const result = restartDaemon({ exec, templatePath, launchAgentsDir });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.command[1])).toEqual(['print', 'bootout', 'bootstrap']);
    expect(calls[2].command[3]).toBe(plist);
  });

  it('not loaded: print, bootstrap (no bootout)', () => {
    const plist = path.join(launchAgentsDir, PLIST_NAME);
    fs.writeFileSync(plist, TEMPLATE);
    const { calls, exec } = recorder((command) => (command[1] === 'print' ? 1 : 0));
    const result = restartDaemon({ exec, templatePath, launchAgentsDir });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.command[1])).toEqual(['print', 'bootstrap']);
  });
});

describe('runDaemonScript', () => {
  it('runs the script through bash with --dry-run passthrough (inherited stdio)', () => {
    const scriptPath = path.join(scriptDir, 'install-daemon.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\n');
    const { calls, exec } = recorder();

    const result = runDaemonScript('install', true, { exec, scriptDir });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('');
    expect(calls).toEqual([
      { command: ['/bin/bash', scriptPath, '--dry-run'], inherit: true },
    ]);
  });

  it('omits --dry-run for a real install', () => {
    const scriptPath = path.join(scriptDir, 'uninstall-daemon.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\n');
    const { calls, exec } = recorder();

    runDaemonScript('uninstall', false, { exec, scriptDir });
    expect(calls[0].command).toEqual(['/bin/bash', scriptPath]);
  });

  it('a missing script is a loud failure (running outside the repo?)', () => {
    const { exec } = recorder();
    const result = runDaemonScript('install', false, { exec, scriptDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('a non-zero child exit fails the command', () => {
    const scriptPath = path.join(scriptDir, 'install-daemon.sh');
    fs.writeFileSync(scriptPath, '#!/bin/bash\n');
    const { exec } = recorder(() => 1);
    const result = runDaemonScript('install', false, { exec, scriptDir });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited with status 1');
  });
});


describe('strayParentFlagProblem (flag before a lifecycle subcommand)', () => {
  it('is silent when no parent flag is set', () => {
    expect(strayParentFlagProblem({})).toBeNull();
    expect(strayParentFlagProblem({ dryRun: false })).toBeNull();
  });

  it('names the flag and shows where it belongs', () => {
    const message = strayParentFlagProblem({ dryRun: true })!;
    expect(message).toContain('--dry-run');
    expect(message).toContain('daemon install --dry-run');
    expect(strayParentFlagProblem({ once: true, debug: true })).toContain('--once, --debug');
  });
});

describe('subcommand flag routing (Commander positional-mode guard)', () => {
  const INDEX_SOURCE = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  it('index pins the wiring this quirk requires', () => {
    expect(INDEX_SOURCE).toContain('program.enablePositionalOptions()');
    const start = INDEX_SOURCE.indexOf(`.command('daemon')`);
    const block = INDEX_SOURCE.slice(start, INDEX_SOURCE.indexOf('.action(', start));
    expect(block).toContain('.passThroughOptions()');
    expect(INDEX_SOURCE).toContain("daemonCommand.hook('preAction'");
  });

  /** The same tree shape as index.ts: parent --dry-run/--once + dup sub flag. */
  function mirror() {
    const tree = new Command();
    tree.enablePositionalOptions();
    const daemon = tree
      .command('daemon')
      .passThroughOptions()
      .option('--dry-run', 'parent')
      .option('--once', 'parent')
      .action(() => {
        // Foreground path — present so Commander does not demand a subcommand.
      });
    let subOpts: Record<string, unknown> = {};
    daemon.command('uninstall').option('--dry-run', 'sub').action((options) => {
      subOpts = options as Record<string, unknown>;
    });
    return { tree, daemon, subOpts: () => subOpts };
  }

  it('canonical form: the subcommand receives its --dry-run', () => {
    const { tree, subOpts } = mirror();
    tree.parse(['node', 'test', 'daemon', 'uninstall', '--dry-run'], { from: 'node' });
    expect(subOpts()).toEqual({ dryRun: true });
  });

  it('stray form: the flag lands on the parent — the guard\'s exact input', () => {
    const { tree, daemon, subOpts } = mirror();
    tree.parse(['node', 'test', 'daemon', '--dry-run', 'uninstall'], { from: 'node' });
    expect(subOpts()).toEqual({});
    expect(daemon.opts()).toEqual({ dryRun: true });
    expect(strayParentFlagProblem(daemon.opts() as { dryRun?: boolean })).toContain('--dry-run');
  });

  it('parent flags without a subcommand still reach the foreground action', () => {
    const { tree, daemon } = mirror();
    tree.parse(['node', 'test', 'daemon', '--once'], { from: 'node' });
    expect(daemon.opts()).toEqual({ once: true });
    // The stray guard only runs when a subcommand is executing (the hook's
    // check); with none, the foreground action receives the flag untouched.
  });
});

describe('followLogs (evcc daemon logs)', () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-logs-'));
    dirs.push(logsDir);
  });

  const paths = (dir: string): string[] => [
    path.join(dir, 'daemon.log'),
    path.join(dir, 'daemon.err.log'),
  ];

  it("spawns tail -F on both streams with the default 50 lines, stdio inherited", () => {
    const { calls, exec } = recorder();

    const result = followLogs({ exec, logsDir });

    expect(result).toEqual({ ok: true, message: '' });
    expect(calls).toEqual([
      {
        command: ['/usr/bin/tail', '-F', '-n', '50', ...paths(logsDir)],
        inherit: true,
      },
    ]);
  });

  it('passes --lines through', () => {
    const { calls, exec } = recorder();

    followLogs({ exec, logsDir, lines: 5 });

    expect(calls[0].command).toEqual([
      '/usr/bin/tail',
      '-F',
      '-n',
      '5',
      ...paths(logsDir),
    ]);
  });

  it('refuses when the logs directory does not exist — install first', () => {
    const { calls, exec } = recorder();

    const result = followLogs({ exec, logsDir: path.join(logsDir, 'nope') });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('run `evcc daemon install` first');
    expect(calls).toEqual([]);
  });

  it('propagates a non-zero tail exit as a failure', () => {
    const { exec } = recorder(() => 2);

    const result = followLogs({ exec, logsDir });

    expect(result).toEqual({ ok: false, message: 'following logs failed: tail exited 2' });
  });

  it('treats a signal exit (Ctrl-C) as a clean stop', () => {
    const { exec } = recorder(() => null);

    const result = followLogs({ exec, logsDir });

    expect(result).toEqual({ ok: true, message: '' });
  });
});

