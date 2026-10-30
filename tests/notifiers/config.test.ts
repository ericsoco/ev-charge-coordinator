/**
 * validateNotifierEntries — notifier-owned config parsing (PR #47: the
 * daemon delegates here). The daemon-level behavior (reconcile, template,
 * file paths) is pinned in tests/utils/daemon-config.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  cloneNotifiers,
  DEFAULT_NOTIFIERS,
  validateNotifierEntries,
} from '../../src/notifiers/config.js';
import { NTFY_DEFAULT_SERVER, parseNtfyEntry } from '../../src/notifiers/ntfy.js';

const FILE = '/tmp/daemon-config.json';

describe('validateNotifierEntries', () => {
  it('absent → the log-only default; arrays replace wholesale', () => {
    expect(validateNotifierEntries(undefined, FILE)).toEqual({
      value: [{ type: 'log' }],
      problems: [],
    });
    expect(validateNotifierEntries([], FILE)).toEqual({ value: [], problems: [] });
    expect(validateNotifierEntries([{ type: 'slack' }], FILE)).toEqual({
      value: [{ type: 'slack' }],
      problems: [],
    });
  });

  it('delegates ntfy knobs and keeps plain entries bare', () => {
    expect(
      validateNotifierEntries(
        [
          { type: 'ntfy', priority: 'high', server: 'https://ntfy.example.com' },
          { type: 'log' },
          { type: 'ntfy' },
        ],
        FILE
      )
    ).toEqual({
      value: [
        { type: 'ntfy', priority: 'high', server: 'https://ntfy.example.com' },
        { type: 'log' },
        { type: 'ntfy' },
      ],
      problems: [],
    });
  });

  const invalids: [string, unknown, RegExp][] = [
    ['a non-array', { type: 'log' }, /must be an array/],
    ['an unknown type', [{ type: 'pigeon' }], /unknown notifier type.*"log".*"ntfy".*"slack"/],
    ['a non-object entry', ['ntfy'], /must be an object with a type/],
    ['a bad ntfy priority', [{ type: 'ntfy', priority: 'urgent' }], /expected "default" or "high"/],
    ['a non-URL ntfy server', [{ type: 'ntfy', server: 'ntfy.sh' }], /must be an http\(s\) URL/],
  ];
  for (const [label, raw, pattern] of invalids) {
    it(`rejects ${label} with a null value`, () => {
      const result = validateNotifierEntries(raw, FILE);
      expect(result.value).toBeNull();
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(pattern);
      expect(result.problems[0]).toContain(FILE);
    });
  }

  it('clones never alias the defaults', () => {
    const first = cloneNotifiers(DEFAULT_NOTIFIERS);
    first.push({ type: 'slack' });
    expect(DEFAULT_NOTIFIERS).toEqual([{ type: 'log' }]);
    expect(cloneNotifiers(DEFAULT_NOTIFIERS)).toEqual([{ type: 'log' }]);
  });
});

describe('parseNtfyEntry', () => {
  it('accepts bare, priority-only, and full knob sets', () => {
    expect(parseNtfyEntry({}, 'w')).toEqual({ entry: { type: 'ntfy' }, problems: [] });
    expect(parseNtfyEntry({ priority: 'default' }, 'w')).toEqual({
      entry: { type: 'ntfy', priority: 'default' },
      problems: [],
    });
    expect(parseNtfyEntry({ server: NTFY_DEFAULT_SERVER }, 'w')).toEqual({
      entry: { type: 'ntfy', server: NTFY_DEFAULT_SERVER },
      problems: [],
    });
  });

  it('one problem at a time, naming the field', () => {
    const bad = parseNtfyEntry({ priority: 'urgent' }, 'cfg: notifiers[0]');
    expect(bad.entry).toBeNull();
    expect(bad.problems).toEqual([
      'cfg: notifiers[0].priority = "urgent" (expected "default" or "high")',
    ]);
    expect(parseNtfyEntry({ server: 'ftp://x' }, 'w').problems).toHaveLength(1);
  });
});
