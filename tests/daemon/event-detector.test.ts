/**
 * Transition matrix for the pure EV event detector: Disconnected→* = plug_in,
 * *→Disconnected = unplug, in/out of Charging = start/stop — plus ordering
 * rules and the state-agnostic plugged rule for unknown firmware values.
 */
import { describe, expect, it } from 'vitest';
import { detectTransitions } from '../../src/daemon/eventDetector.js';

const D = 'Disconnected';
const C = 'Charging';
const S = 'Stopped';
const F = 'Complete';
const N = 'NoPower';

describe('baselines and no-ops', () => {
  it('no baseline (null / undefined prev) yields no events', () => {
    expect(detectTransitions(null, C)).toEqual([]);
    expect(detectTransitions(undefined, S)).toEqual([]);
  });

  it('unreadable current state (null / undefined / empty) yields no events', () => {
    expect(detectTransitions(D, null)).toEqual([]);
    expect(detectTransitions(D, undefined)).toEqual([]);
    expect(detectTransitions(D, '')).toEqual([]);
  });

  it('an unchanged state yields no events', () => {
    expect(detectTransitions(D, D)).toEqual([]);
    expect(detectTransitions(C, C)).toEqual([]);
    expect(detectTransitions(S, S)).toEqual([]);
  });

  it('plugged non-charging reshuffles yield no events', () => {
    expect(detectTransitions(S, F)).toEqual([]);
    expect(detectTransitions(F, S)).toEqual([]);
    expect(detectTransitions(N, S)).toEqual([]);
  });
});

describe('plug-in (Disconnected → anything)', () => {
  it('Disconnected → Stopped is a plug_in carrying from/to', () => {
    expect(detectTransitions(D, S)).toEqual([
      { kind: 'plug_in', fromState: D, toState: S },
    ]);
  });

  it('Disconnected → Charging is plug_in then charging_start, in that order', () => {
    expect(detectTransitions(D, C)).toEqual([
      { kind: 'plug_in', fromState: D, toState: C },
      { kind: 'charging_start', fromState: D, toState: C },
    ]);
  });

  it('Disconnected → Complete / NoPower still counts as plug_in', () => {
    expect(detectTransitions(D, F)).toEqual([{ kind: 'plug_in', fromState: D, toState: F }]);
    expect(detectTransitions(D, N)).toEqual([{ kind: 'plug_in', fromState: D, toState: N }]);
  });

  it('an unknown future state after Disconnected still plugs in', () => {
    expect(detectTransitions(D, 'Initializing')).toEqual([
      { kind: 'plug_in', fromState: D, toState: 'Initializing' },
    ]);
  });
});

describe('unplug (anything → Disconnected)', () => {
  it('each plugged state → Disconnected is an unplug', () => {
    for (const prev of [S, F, N]) {
      expect(detectTransitions(prev, D)).toEqual([
        { kind: 'unplug', fromState: prev, toState: D },
      ]);
    }
  });

  it('Charging → Disconnected is charging_stop then unplug, in that order', () => {
    expect(detectTransitions(C, D)).toEqual([
      { kind: 'charging_stop', fromState: C, toState: D },
      { kind: 'unplug', fromState: C, toState: D },
    ]);
  });

  it('an unknown plugged state → Disconnected still unplugs', () => {
    expect(detectTransitions('Initializing', D)).toEqual([
      { kind: 'unplug', fromState: 'Initializing', toState: D },
    ]);
  });
});

describe('charging transitions while staying plugged', () => {
  it('into Charging is a charging_start (from every non-charging state)', () => {
    for (const prev of [S, F, N, 'Initializing']) {
      expect(detectTransitions(prev, C)).toEqual([
        { kind: 'charging_start', fromState: prev, toState: C },
      ]);
    }
  });

  it('out of Charging is a charging_stop (to every non-charging state)', () => {
    for (const next of [S, F, N, 'Initializing']) {
      expect(detectTransitions(C, next)).toEqual([
        { kind: 'charging_stop', fromState: C, toState: next },
      ]);
    }
  });
});

describe('robustness', () => {
  it('never throws on odd inputs', () => {
    const weird: (string | null | undefined)[] = [null, undefined, '', ' ', C, D, 'x'];
    for (const prev of weird) {
      for (const next of weird) {
        expect(() => detectTransitions(prev, next)).not.toThrow();
      }
    }
  });
});
