/**
 * daemon-config.json resolution: documented defaults + fail-loud validation,
 * plus first-start creation/migration (ensureDaemonConfigFile).
 * Explicit tmp-file paths (the database.ts precedent) — no env juggling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DAEMON_CONFIG_TEMPLATE,
  DEFAULT_DAEMON_CONFIG,
  ensureDaemonConfigFile,
  resolveDaemonConfig,
} from '../../src/utils/daemonConfig.js';

const dirs: string[] = [];

function fixture(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-cfg-'));
  dirs.push(dir);
  if (content === undefined) return path.join(dir, 'daemon-config.json');
  const file = path.join(dir, 'daemon-config.json');
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('defaults', () => {
  it('an absent file yields every documented default and no problems', () => {
    const resolved = resolveDaemonConfig(fixture());
    expect(resolved.problems).toEqual([]);
    expect(resolved.config).toEqual(DEFAULT_DAEMON_CONFIG);
  });

  it('present fields override; absent fields keep their defaults', () => {
    const resolved = resolveDaemonConfig(fixture('{"evSampleIdleSec": 999}'));
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.evSampleIdleSec).toBe(999);
    expect(resolved.config?.evSamplePluggedSec).toBe(DEFAULT_DAEMON_CONFIG.evSamplePluggedSec);
    expect(resolved.config?.batterySampleSec).toBe(DEFAULT_DAEMON_CONFIG.batterySampleSec);
  });

  it('the template parses to exactly the defaults (no drift)', () => {
    expect(JSON.parse(DAEMON_CONFIG_TEMPLATE)).toEqual(DEFAULT_DAEMON_CONFIG);
  });

  it('unknown keys are ignored (hand-edit tolerance)', () => {
    const resolved = resolveDaemonConfig(
      fixture('{"surpriseKey": true, "batterySampleSec": 300}')
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.batterySampleSec).toBe(300);
  });
});

describe('invalid values refuse loudly (config null, one problem each)', () => {
  const invalids: [string, string, RegExp][] = [
    ['non-numeric', '{"batterySampleSec": "fast"}', /batterySampleSec = "fast" \(must be a number\)/],
    ['fractional', '{"evStatusPollSec": 12.5}', /evStatusPollSec = 12\.5 \(must be an integer\)/],
    ['below interval floor', '{"evSamplePluggedSec": 5}', /must be between 10 and 86400/],
    ['below weather floor', '{"weatherFetchSec": 30}', /must be between 60 and 604800/],
    ['retention out of range', '{"retentionDays": 0}', /retentionDays = 0 \(must be between 1 and 3650\)/],
  ];
  for (const [label, content, pattern] of invalids) {
    it(`rejects ${label}`, () => {
      const file = fixture(content);
      const resolved = resolveDaemonConfig(file);
      expect(resolved.config).toBeNull();
      expect(resolved.problems).toHaveLength(1);
      expect(resolved.problems[0]).toMatch(pattern);
      expect(resolved.problems[0]).toContain(file);
    });
  }

  it('reports bad JSON with the file path', () => {
    const file = fixture('{ nope');
    const resolved = resolveDaemonConfig(file);
    expect(resolved.config).toBeNull();
    expect(resolved.problems[0]).toMatch(/not valid JSON/);
    expect(resolved.problems[0]).toContain(file);
  });

  it('rejects a non-object file', () => {
    const resolved = resolveDaemonConfig(fixture('[1, 2]'));
    expect(resolved.config).toBeNull();
    expect(resolved.problems[0]).toMatch(/must contain a JSON object/);
  });

  it('reports every invalid field, not just the first', () => {
    const resolved = resolveDaemonConfig(
      fixture('{"batterySampleSec": -1, "retentionDays": "two"}')
    );
    expect(resolved.config).toBeNull();
    expect(resolved.problems).toHaveLength(2);
  });
});

describe('ensureDaemonConfigFile (daemon start only)', () => {
  function dir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-ensure-'));
    dirs.push(d);
    return d;
  }

  it('creates the file with the documented defaults, and it resolves clean', () => {
    const target = path.join(dir(), 'daemon-config.json');

    expect(ensureDaemonConfigFile(target)).toBe('created');
    expect(fs.readFileSync(target, 'utf8')).toBe(DAEMON_CONFIG_TEMPLATE);
    const resolved = resolveDaemonConfig(target);
    expect(resolved.problems).toEqual([]);
    expect(resolved.config).toEqual(DEFAULT_DAEMON_CONFIG);
  });

  it('never overwrites an existing file (operator edits are the truth)', () => {
    const target = path.join(dir(), 'daemon-config.json');
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');

    expect(ensureDaemonConfigFile(target)).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"evSampleIdleSec": 60}');
  });

  it('migrates a legacy daemon.json, preserving its hand-edits', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'daemon.json'), '{"evSampleIdleSec": 45}');
    const target = path.join(d, 'daemon-config.json');

    expect(ensureDaemonConfigFile(target)).toBe('migrated');
    expect(fs.existsSync(path.join(d, 'daemon.json'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"evSampleIdleSec": 45}');
    expect(resolveDaemonConfig(target).config).toEqual({
      ...DEFAULT_DAEMON_CONFIG,
      evSampleIdleSec: 45,
    });
  });

  it('prefers daemon-config.json when both files are present', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'daemon.json'), '{"evSampleIdleSec": 45}');
    const target = path.join(d, 'daemon-config.json');
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');

    expect(ensureDaemonConfigFile(target)).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"evSampleIdleSec": 60}');
  });
});

describe('creation wiring', () => {
  const indexSource = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const systemSource = fs.readFileSync(
    new URL('../../src/commands/system.ts', import.meta.url),
    'utf8'
  );

  it('only the daemon command ensures the file — status never creates', () => {
    expect(indexSource).toContain('ensureDaemonConfigFile()');
    expect(indexSource).toContain('daemon-config.json not found');
    expect(indexSource).toContain('migrated legacy daemon.json');
    expect(systemSource).not.toContain('ensureDaemonConfigFile');
  });
});
