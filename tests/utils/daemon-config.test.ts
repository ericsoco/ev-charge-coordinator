/**
 * daemon-config.json resolution: documented defaults + fail-loud validation,
 * plus creation/migration/reconcile (ensureDaemonConfigFile).
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

describe('autoStart block (P1b decision config)', () => {
  it('defaults to dark: disabled with the trivial always filter', () => {
    const resolved = resolveDaemonConfig(fixture());
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.autoStart).toEqual({ enabled: false, filters: [{ type: 'always' }] });
  });

  it('the template carries the autoStart default (dark on first start)', () => {
    expect(JSON.parse(DAEMON_CONFIG_TEMPLATE).autoStart).toEqual({
      enabled: false,
      filters: [{ type: 'always' }],
    });
  });

  it('partial overrides merge with defaults; unknown block keys are ignored', () => {
    const resolved = resolveDaemonConfig(
      fixture('{"autoStart": {"enabled": true, "surprise": 1}}')
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.autoStart).toEqual({ enabled: true, filters: [{ type: 'always' }] });
  });

  it('a full block replaces the chain wholesale', () => {
    const resolved = resolveDaemonConfig(
      fixture('{"autoStart": {"enabled": false, "filters": [{"type": "geofence", "radiusM": 80}]}}')
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.autoStart).toEqual({
      enabled: false,
      filters: [{ type: 'geofence', radiusM: 80 }],
    });
  });

  it('an empty filter chain is valid (interlocks still apply)', () => {
    const resolved = resolveDaemonConfig(fixture('{"autoStart": {"filters": []}}'));
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.autoStart.filters).toEqual([]);
  });

  it('resolved config never shares references with the defaults', () => {
    const resolved = resolveDaemonConfig(fixture());
    resolved.config!.autoStart.filters.push({ type: 'geofence', radiusM: 10 });
    expect(DEFAULT_DAEMON_CONFIG.autoStart.filters).toEqual([{ type: 'always' }]);
  });

  const invalids: [string, string, RegExp][] = [
    ['non-object autoStart', '{"autoStart": true}', /autoStart = true \(must be an object\)/],
    ['array autoStart', '{"autoStart": []}', /autoStart = \[\] \(must be an object\)/],
    [
      'non-boolean enabled',
      '{"autoStart": {"enabled": "yes"}}',
      /autoStart\.enabled = "yes" \(must be a boolean\)/,
    ],
    [
      'non-array filters',
      '{"autoStart": {"filters": "always"}}',
      /autoStart\.filters = "always" \(must be an array\)/,
    ],
    [
      'non-object filter entry',
      '{"autoStart": {"filters": [7]}}',
      /autoStart\.filters\[0\] = 7 \(must be an object with a type\)/,
    ],
    [
      'missing filter type',
      '{"autoStart": {"filters": [{}]}}',
      /autoStart\.filters\[0\]\.type = undefined \(unknown filter type/,
    ],
    [
      'unknown filter type',
      '{"autoStart": {"filters": [{"type": "geofencex"}]}}',
      /unknown filter type; expected "always" or "geofence"/,
    ],
    [
      'geofence without radius',
      '{"autoStart": {"filters": [{"type": "geofence"}]}}',
      /autoStart\.filters\[0\] \(geofence requires radiusM — meters\)/,
    ],
    [
      'non-numeric radius',
      '{"autoStart": {"filters": [{"type": "geofence", "radiusM": "far"}]}}',
      /radiusM = "far" \(must be a positive number of meters\)/,
    ],
    [
      'zero radius',
      '{"autoStart": {"filters": [{"type": "geofence", "radiusM": 0}]}}',
      /radiusM = 0 \(must be a positive number of meters\)/,
    ],
    [
      'negative radius',
      '{"autoStart": {"filters": [{"type": "geofence", "radiusM": -10}]}}',
      /radiusM = -10 \(must be a positive number of meters\)/,
    ],
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

  it('reports autoStart problems alongside numeric ones', () => {
    const resolved = resolveDaemonConfig(
      fixture('{"batterySampleSec": -1, "autoStart": {"enabled": "dark"}}')
    );
    expect(resolved.config).toBeNull();
    expect(resolved.problems).toHaveLength(2);
  });
});

describe('notifiers block (P1b notifications, design §3.7)', () => {
  it('defaults to log-only: visible but harmless', () => {
    const resolved = resolveDaemonConfig(fixture());
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.notifiers).toEqual([{ type: 'log' }]);
  });

  it('carries the default in the template (a fresh file notifies to the log)', () => {
    expect(JSON.parse(DAEMON_CONFIG_TEMPLATE).notifiers).toEqual([{ type: 'log' }]);
  });

  it('ntfy knobs resolve when present', () => {
    const resolved = resolveDaemonConfig(
      fixture(
        '{"notifiers": [{"type": "ntfy", "priority": "high", "server": "https://ntfy.example.com"}]}'
      )
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.notifiers).toEqual([
      { type: 'ntfy', priority: 'high', server: 'https://ntfy.example.com' },
    ]);
  });

  it('ntfy defaults (no priority/server) resolve to the bare entry', () => {
    const resolved = resolveDaemonConfig(fixture('{"notifiers": [{"type": "ntfy"}]}'));
    expect(resolved.config?.notifiers).toEqual([{ type: 'ntfy' }]);
  });

  it('an empty list is valid — notifications fully off', () => {
    const resolved = resolveDaemonConfig(fixture('{"notifiers": []}'));
    expect(resolved.problems).toEqual([]);
    expect(resolved.config?.notifiers).toEqual([]);
  });

  it('a full list replaces the default wholesale (no element-merge)', () => {
    const resolved = resolveDaemonConfig(fixture('{"notifiers": [{"type": "slack"}]}'));
    expect(resolved.config?.notifiers).toEqual([{ type: 'slack' }]);
  });

  it('resolved config never shares references with the defaults', () => {
    const first = resolveDaemonConfig(fixture()).config!.notifiers;
    first.push({ type: 'slack' });
    expect(DEFAULT_DAEMON_CONFIG.notifiers).toEqual([{ type: 'log' }]);
    expect(resolveDaemonConfig(fixture()).config?.notifiers).toEqual([{ type: 'log' }]);
  });

  const invalids: [string, string, RegExp][] = [
    ['a non-array notifiers', '{"notifiers": {"type": "log"}}', /must be an array/],
    ['an unknown notifier type', '{"notifiers": [{"type": "pigeon"}]}', /unknown notifier type/],
    ['a non-object entry', '{"notifiers": ["ntfy"]}', /must be an object with a type/],
    [
      'a bad ntfy priority',
      '{"notifiers": [{"type": "ntfy", "priority": "urgent"}]}',
      /expected "default" or "high"/,
    ],
    [
      'a non-URL ntfy server',
      '{"notifiers": [{"type": "ntfy", "server": "ntfy.sh"}]}',
      /must be an http\(s\) URL/,
    ],
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

  it('reconcile fills a missing notifiers key into an existing file', () => {
    const target = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-daemon-ensure-')),
      'daemon-config.json'
    );
    dirs.push(path.dirname(target));
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');

    expect(ensureDaemonConfigFile(target)).toBe('updated');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.notifiers).toEqual([{ type: 'log' }]);
    expect(parsed.evSampleIdleSec).toBe(60);
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

  it('fills missing keys into an existing file, preserving operator values', () => {
    const target = path.join(dir(), 'daemon-config.json');
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');

    expect(ensureDaemonConfigFile(target)).toBe('updated');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.evSampleIdleSec).toBe(60);
    expect(parsed.batterySampleSec).toBe(DEFAULT_DAEMON_CONFIG.batterySampleSec);
    expect(parsed.autoStart).toEqual({ enabled: false, filters: [{ type: 'always' }] });
    expect(resolveDaemonConfig(target)).toEqual({
      config: { ...DEFAULT_DAEMON_CONFIG, evSampleIdleSec: 60 },
      problems: [],
    });
  });

  it('reconciled output is byte-stable and leaves no temp file behind', () => {
    const target = path.join(dir(), 'daemon-config.json');
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');
    expect(ensureDaemonConfigFile(target)).toBe('updated');
    const once = fs.readFileSync(target, 'utf8');

    expect(ensureDaemonConfigFile(target)).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it('preserves unknown keys while reconciling', () => {
    const target = path.join(dir(), 'daemon-config.json');
    fs.writeFileSync(target, '{"surpriseKey": true}');

    expect(ensureDaemonConfigFile(target)).toBe('updated');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.surpriseKey).toBe(true);
    expect(resolveDaemonConfig(target).problems).toEqual([]);
  });

  it('reconcile never element-merges arrays (operator geofence chain survives)', () => {
    const target = path.join(dir(), 'daemon-config.json');
    const chain = [{ type: 'geofence', radiusM: 80 }];
    fs.writeFileSync(target, JSON.stringify({ autoStart: { enabled: true, filters: chain } }));

    expect(ensureDaemonConfigFile(target)).toBe('updated');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).autoStart).toEqual({
      enabled: true,
      filters: chain,
    });
  });

  it('an invalid file stays byte-untouched', () => {
    const target = path.join(dir(), 'daemon-config.json');
    fs.writeFileSync(target, '{"batterySampleSec": 5}');

    expect(ensureDaemonConfigFile(target)).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"batterySampleSec": 5}');
  });

  it('migrates a legacy daemon.json, preserving its hand-edits (then reconciles)', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'daemon.json'), '{"evSampleIdleSec": 45}');
    const target = path.join(d, 'daemon-config.json');

    expect(ensureDaemonConfigFile(target)).toBe('migrated');
    expect(fs.existsSync(path.join(d, 'daemon.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).evSampleIdleSec).toBe(45);
    expect(resolveDaemonConfig(target).config).toEqual({
      ...DEFAULT_DAEMON_CONFIG,
      evSampleIdleSec: 45,
    });
  });

  it('prefers daemon-config.json when both files are present (reconciles it)', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'daemon.json'), '{"evSampleIdleSec": 45}');
    const target = path.join(d, 'daemon-config.json');
    fs.writeFileSync(target, '{"evSampleIdleSec": 60}');

    expect(ensureDaemonConfigFile(target)).toBe('updated');
    expect(fs.existsSync(path.join(d, 'daemon.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).evSampleIdleSec).toBe(60);
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
    expect(indexSource).toContain('daemon-config.json updated');
    expect(systemSource).not.toContain('ensureDaemonConfigFile');
  });
});
