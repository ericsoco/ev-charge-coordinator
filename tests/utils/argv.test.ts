/**
 * normalizeNegativePositionals: the one-shot CLI used to reject negative home
 * coordinates ("unknown option '-33.9'") while the REPL accepted them, because
 * Commander reads a leading-dash token as an option. The one-shot path
 * normalizes them to positionals before parsing; these cases pin exactly which
 * argv shapes are rewritten and which are left alone.
 */
import { describe, expect, it } from 'vitest';
import { normalizeNegativePositionals } from '../../src/utils/argv.js';

describe('normalizeNegativePositionals', () => {
  it('inserts -- before a leading negative latitude', () => {
    expect(
      normalizeNegativePositionals(['node', 'cli', 'set-home-location', '-33.9', '151.2'])
    ).toEqual(['node', 'cli', 'set-home-location', '--', '-33.9', '151.2']);
  });

  it('inserts -- before a trailing negative longitude only', () => {
    expect(
      normalizeNegativePositionals(['node', 'cli', 'set-home-location', '37.7', '-122.5'])
    ).toEqual(['node', 'cli', 'set-home-location', '37.7', '--', '-122.5']);
  });

  it('leaves non-negative invocations untouched', () => {
    const argv = ['node', 'cli', 'set-home-location', '37.7', '122.5'];
    expect(normalizeNegativePositionals(argv)).toEqual(argv);
  });

  it('leaves the vehicle flow (no operands) untouched', () => {
    const argv = ['node', 'cli', 'set-home-location'];
    expect(normalizeNegativePositionals(argv)).toEqual(argv);
  });

  it('leaves other commands untouched', () => {
    const argv = ['node', 'cli', 'status', '--json'];
    expect(normalizeNegativePositionals(argv)).toEqual(argv);
  });

  it('respects an existing -- before the negative numbers', () => {
    // A second -- would be read back as an operand (the latitude).
    const argv = ['node', 'cli', 'set-home-location', '--', '-90', '-120'];
    expect(normalizeNegativePositionals(argv)).toEqual(argv);
  });

  it('does not treat -h or --help as a negative coordinate', () => {
    const argv = ['node', 'cli', 'set-home-location', '--help'];
    expect(normalizeNegativePositionals(argv)).toEqual(argv);
  });
});
