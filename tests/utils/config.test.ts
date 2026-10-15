/**
 * The hand-editable config.json: single source of truth for EnergyConfig.
 *
 * Isolation: config.ts resolves its path through getConfigDir(), which reads
 * ECC_CONFIG_DIR at credentials.ts import time, so the env var must be set
 * before the module loads -- hence the dynamic import in beforeAll (the same
 * pattern credentials.test.ts uses).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type ConfigModule = typeof import('../../src/utils/config.js');
type EnergyConfig = import('../../src/utils/energy.js').EnergyConfig;

let mod: ConfigModule;
let configDir: string;

const FULL: EnergyConfig = {
  batteryCapacityKwh: 13.5,
  evBatteryKwh: 75,
  bufferPercent: 20,
  chargeEfficiency: 0.9,
};

function cfgPath(): string {
  return path.join(configDir, 'config.json');
}

function writeRaw(text: string): void {
  fs.writeFileSync(cfgPath(), text);
}

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-config-'));
  process.env.ECC_CONFIG_DIR = configDir;
  mod = await import('../../src/utils/config.js');
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  delete process.env.ECC_CONFIG_DIR;
});

beforeEach(() => {
  for (const entry of fs.readdirSync(configDir)) {
    fs.rmSync(path.join(configDir, entry), { recursive: true, force: true });
  }
});

describe('resolveEnergyConfig - reading the hand-edited file', () => {
  it('reports every field missing when the file does not exist', () => {
    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.invalid).toEqual([]);
    expect(resolved.missing).toEqual([
      'batteryCapacityKwh',
      'evBatteryKwh',
      'bufferPercent',
      'chargeEfficiency',
    ]);
  });

  it('returns a complete valid config', () => {
    writeRaw(JSON.stringify(FULL, null, 2));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toEqual(FULL);
    expect(resolved.missing).toEqual([]);
    expect(resolved.invalid).toEqual([]);
  });

  it('reports absent fields as missing without calling them invalid', () => {
    writeRaw(JSON.stringify({ batteryCapacityKwh: 13.5, bufferPercent: 20 }));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.missing).toEqual(['evBatteryKwh', 'chargeEfficiency']);
    expect(resolved.invalid).toEqual([]);
  });

  it('reports an out-of-range value with the field, the value, and the path', () => {
    writeRaw(JSON.stringify({ ...FULL, chargeEfficiency: 1.5 }));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.invalid).toHaveLength(1);
    expect(resolved.invalid[0]).toContain('chargeEfficiency = 1.5 (must be in (0, 1])');
    expect(resolved.invalid[0]).toContain(cfgPath());
  });

  it('reports a wrong-typed value as invalid, not missing', () => {
    writeRaw(JSON.stringify({ ...FULL, bufferPercent: '20' }));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.missing).toEqual([]);
    expect(resolved.invalid[0]).toContain('bufferPercent = "20" (must be a number)');
  });

  it('reports unparseable JSON with the path instead of throwing', () => {
    writeRaw('{ oops');

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.invalid).toHaveLength(1);
    expect(resolved.invalid[0]).toContain(cfgPath());
    expect(resolved.invalid[0]).toContain('not valid JSON');
  });

  it('reports a non-object file instead of crashing on it', () => {
    writeRaw('[1, 2, 3]');

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toBeNull();
    expect(resolved.invalid[0]).toContain('must contain a JSON object');
  });

  it('ignores unknown keys the operator may have added', () => {
    writeRaw(JSON.stringify({ ...FULL, note: 'hand-written' }));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toEqual(FULL);
  });
});

describe('describeConfigProblems - the lines the CLI echoes', () => {
  it('is empty for a usable config', () => {
    writeRaw(JSON.stringify(FULL));

    expect(mod.describeConfigProblems(mod.resolveEnergyConfig())).toEqual([]);
  });

  it('names every invalid value and the file', () => {
    writeRaw(JSON.stringify({ ...FULL, evBatteryKwh: -1, chargeEfficiency: 0 }));

    const lines = mod.describeConfigProblems(mod.resolveEnergyConfig());

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('evBatteryKwh = -1');
    expect(lines[1]).toContain('chargeEfficiency = 0');
    expect(lines[2]).toBe(`Fix ${cfgPath()} and try again.`);
  });

  it('lists the missing fields and the path for an incomplete config', () => {
    const lines = mod.describeConfigProblems(mod.resolveEnergyConfig());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Energy config incomplete at ${cfgPath()}`);
    expect(lines[0]).toContain('missing: batteryCapacityKwh, evBatteryKwh');
  });
});

describe('saveEnergyConfig - the first-run flow writes the whole file', () => {
  it('round-trips through an owner-only file', () => {
    mod.saveEnergyConfig(FULL);

    expect(fs.statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(mod.resolveEnergyConfig().config).toEqual(FULL);
  });

  it('refuses to write an invalid config', () => {
    expect(() => mod.saveEnergyConfig({ ...FULL, bufferPercent: 101 })).toThrow(
      /Invalid energy config/
    );
    expect(fs.existsSync(cfgPath())).toBe(false);
  });
});

describe('setEnergyConfigField - the config --set-* flags write here', () => {
  it('creates the file from a single field', () => {
    mod.setEnergyConfigField({ bufferPercent: 25 });

    const resolved = mod.resolveEnergyConfig();
    expect(resolved.config).toBeNull();
    expect(resolved.missing).toEqual([
      'batteryCapacityKwh',
      'evBatteryKwh',
      'chargeEfficiency',
    ]);
    expect(JSON.parse(fs.readFileSync(cfgPath(), 'utf8'))).toEqual({ bufferPercent: 25 });
  });

  it('merges without touching the other fields', () => {
    mod.saveEnergyConfig(FULL);

    mod.setEnergyConfigField({ chargeEfficiency: 0.8 });

    expect(mod.resolveEnergyConfig().config).toEqual({ ...FULL, chargeEfficiency: 0.8 });
  });

  it('rejects a bad value and leaves the file unchanged', () => {
    mod.saveEnergyConfig(FULL);

    expect(() => mod.setEnergyConfigField({ bufferPercent: 150 })).toThrow(
      /bufferPercent = 150 \(must be 0-100\)/
    );
    expect(mod.resolveEnergyConfig().config).toEqual(FULL);
  });

  it('blocks the write when an existing value in the file is already invalid', () => {
    writeRaw(JSON.stringify({ ...FULL, chargeEfficiency: 9 }));

    expect(() => mod.setEnergyConfigField({ bufferPercent: 30 })).toThrow(
      /chargeEfficiency = 9/
    );
    expect(JSON.parse(fs.readFileSync(cfgPath(), 'utf8')).bufferPercent).toBe(20);
  });

  it('refuses to clobber a file that does not parse', () => {
    writeRaw('{ oops');

    expect(() => mod.setEnergyConfigField({ chargeEfficiency: 0.8 })).toThrow(/Fix the JSON first/);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe('{ oops');
  });

  it('drops unknown keys on write, including a legacy minChargeKwh', () => {
    writeRaw(JSON.stringify({ ...FULL, note: 'hand-written', minChargeKwh: 1 }));

    mod.setEnergyConfigField({ bufferPercent: 30 });

    const written = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    expect(written).toEqual({ ...FULL, bufferPercent: 30 });
    expect(written).not.toHaveProperty('note');
    expect(written).not.toHaveProperty('minChargeKwh');
  });

  it('ignores a leftover minChargeKwh on read (old-schema files stay usable)', () => {
    writeRaw(JSON.stringify({ ...FULL, minChargeKwh: 1 }));

    const resolved = mod.resolveEnergyConfig();

    expect(resolved.config).toEqual(FULL);
    expect(resolved.missing).toEqual([]);
    expect(resolved.invalid).toEqual([]);
  });
});
