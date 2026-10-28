/**
 * launchd assets: the plist template and the install/uninstall scripts.
 *
 * The scripts' --dry-run mode is the test seam: it renders the plist and prints
 * the launchctl actions without touching ~/Library/LaunchAgents or launchd.
 * Every run points HOME at a throwaway directory, so these tests are safe on a
 * developer Mac and on CI (ubuntu) alike; plutil checks are darwin-gated.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const TEMPLATE = path.join(SCRIPTS, 'evcc-daemon.plist');
const LAUNCHER_TEMPLATE = path.join(SCRIPTS, 'evcc-daemon-launcher.sh');
const INSTALL = path.join(SCRIPTS, 'install-daemon.sh');
const UNINSTALL = path.join(SCRIPTS, 'uninstall-daemon.sh');
const LABEL = 'com.transmote.ev-charge-coordinator.daemon';
const LAUNCHER_NAME = 'EV Charge Coordinator';

function bash(script: string, args: string[], home: string) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

/** A HOME nothing in the repo knows about: a broken dry-run still cannot touch the real one. */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-launchd-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('evcc-daemon.plist template', () => {
  it('uses the com.transmote label first and launches via the launcher shim', () => {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    expect(tpl).toContain(`<string>${LABEL}</string>`);
    const labelIdx = tpl.indexOf('<key>Label</key>');
    const firstStringIdx = tpl.indexOf('<string>');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeLessThan(firstStringIdx); // Label precedes every value
    // argv[0] is the launcher so macOS names the Login Item after it.
    expect(tpl).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>__LAUNCHER__<\/string>\s*<\/array>/
    );
  });

  it('keeps the run contract: RunAtLoad + KeepAlive, logs under the config dir', () => {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    expect(tpl).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(tpl).toMatch(/<key>KeepAlive<\/key><true\/>/);
    expect(tpl).toContain('<string>__CONFIG_DIR__/logs/daemon.log</string>');
    expect(tpl).toContain('<string>__CONFIG_DIR__/logs/daemon.err.log</string>');
    expect(tpl).toContain('/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('has exactly the three placeholders the installer substitutes', () => {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    const found = tpl.match(/__[A-Z_]+__/g) ?? [];
    expect(new Set(found)).toEqual(
      new Set(['__LAUNCHER__', '__REPO_DIR__', '__CONFIG_DIR__'])
    );
  });
});

describe('evcc-daemon-launcher.sh template', () => {
  it('resolves node at launch (nvm or PATH) and execs the daemon entry point', () => {
    const tpl = fs.readFileSync(LAUNCHER_TEMPLATE, 'utf8');
    expect(tpl).toContain('__REPO_DIR__');
    expect(tpl).toContain('NVM_DIR');
    expect(tpl).toContain('command -v node');
    expect(tpl).toMatch(/exec "\$NODE_BIN" "\$REPO_DIR\/dist\/index\.js" daemon/);
    const found = tpl.match(/__[A-Z_]+__/g) ?? [];
    expect(new Set(found)).toEqual(new Set(['__REPO_DIR__'])); // repo dir is the only substitution
  });

  it('holds PreventSystemSleep via caffeinate on AC (lid-closed polling)', () => {
    const tpl = fs.readFileSync(LAUNCHER_TEMPLATE, 'utf8');
    expect(tpl).toContain('caffeinate -s');
    // The plain exec remains as the fallback for machines without caffeinate.
    expect(tpl).toMatch(/^exec "\$NODE_BIN" "\$REPO_DIR\/dist\/index\.js" daemon$/m);
  });
});

describe('install-daemon.sh --dry-run', () => {
  it('renders machine paths with no placeholder residue and performs no writes', () => {
    withTempHome((home) => {
      const res = bash(INSTALL, ['--dry-run'], home);
      expect(res.status, res.stderr).toBe(0);
      const out = res.stdout;
      expect(out).toContain(`<string>${LABEL}</string>`);
      expect(out).toContain(`REPO_DIR="${REPO_ROOT}"`); // launcher's rendered repo root
      expect(out).toContain(path.join(home, '.ev-charge-coordinator', LAUNCHER_NAME));
      expect(out).not.toMatch(/__[A-Z_]+__/);
      expect(out).toContain('[dry-run]');
      expect(out).toContain(path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`));
      expect(fs.readdirSync(home)).toEqual([]); // nothing was written
    });
  });

  it.skipIf(process.platform !== 'darwin')('renders a plist that plutil accepts', () => {
    withTempHome((home) => {
      const res = bash(INSTALL, ['--dry-run'], home);
      expect(res.status, res.stderr).toBe(0);
      const match = res.stdout.match(/--- rendered plist <<<\n([\s\S]*?)\n>>> --- end rendered plist/);
      if (!match) throw new Error('rendered plist markers missing from dry-run output');
      const rendered = path.join(home, 'rendered.plist');
      fs.writeFileSync(rendered, `${match[1]}\n`);
      const lint = spawnSync('plutil', ['-lint', rendered], { encoding: 'utf8' });
      expect(lint.status, lint.stderr).toBe(0);
    });
  });
});

describe('install-daemon.sh bootstrap retry', () => {
  it('retries bootstrap — bootout teardown is async and races an immediate attempt', () => {
    const src = fs.readFileSync(INSTALL, 'utf8');
    expect(src).toMatch(/for attempt in 1 2 3 4 5; do/);
    expect(src).toMatch(/launchctl bootstrap "\$DOMAIN" "\$TARGET"/);
    expect(src).toMatch(/sleep 1/);
    expect(src).toContain('bootstrap failed after 5 attempts');
  });
});

describe('uninstall-daemon.sh --dry-run', () => {
  it('prints bootout + rm for the template label and performs no writes', () => {
    withTempHome((home) => {
      const res = bash(UNINSTALL, ['--dry-run'], home);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('bootout');
      expect(res.stdout).toContain(LABEL);
      expect(res.stdout).toContain(`rm -f ${path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`)}`);
      expect(res.stdout).toContain(`rm -f "${path.join(home, '.ev-charge-coordinator', LAUNCHER_NAME)}"`);
      expect(fs.readdirSync(home)).toEqual([]);
    });
  });
});

describe('script syntax', () => {
  it('all scripts parse under bash -n', () => {
    for (const script of [INSTALL, UNINSTALL, LAUNCHER_TEMPLATE]) {
      const res = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
    }
  });
});
