/**
 * Color gating: plain strings unless stdout is a TTY and NO_COLOR is unset.
 *
 * The theming must be a no-op wherever output is captured -- vitest workers,
 * redirects, CI -- because the string-asserting tests (and the user piping
 * output to a file) depend on receiving the exact bytes the code produced
 * before colors existed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as paint from '../../src/utils/color.js';

const ESC = String.fromCharCode(27);

/** Force the gate into a known state for one assertion. */
function withTty(isTty: boolean, noColor: string | undefined, run: () => void): void {
  const stdout = process.stdout as { isTTY?: boolean };
  const hadTty = stdout.isTTY;
  const hadNoColor = process.env.NO_COLOR;
  stdout.isTTY = isTty;
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  try {
    run();
  } finally {
    stdout.isTTY = hadTty;
    if (hadNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = hadNoColor;
  }
}

describe('color themes', () => {
  afterEach(() => {
    // withTty restores, but guard against a failed run leaving state behind.
    delete process.env.NO_COLOR;
  });

  it('returns plain text when stdout is not a TTY', () => {
    withTty(false, undefined, () => {
      expect(paint.error('boom')).toBe('boom');
      expect(paint.successBold('99.9%')).toBe('99.9%');
      expect(paint.prompt('ev-charge> ')).toBe('ev-charge> ');
    });
  });

  it('returns plain text when NO_COLOR is set, even on a TTY', () => {
    withTty(true, '1', () => {
      expect(paint.error('boom')).toBe('boom');
    });
  });

  it('emits truecolor SGR on a TTY', () => {
    withTty(true, undefined, () => {
      expect(paint.error('boom')).toBe(`${ESC}[38;2;224;90;81mboom${ESC}[0m`);
      expect(paint.prompt('ev-charge> ')).toBe(`${ESC}[1;38;2;142;200;205mev-charge> ${ESC}[0m`);
      expect(paint.success('✓ done')).toBe(`${ESC}[38;2;95;206;144m✓ done${ESC}[0m`);
    });
  });

  it('adds bold for successBold, the value half of label/value pairs', () => {
    withTty(true, undefined, () => {
      expect(paint.successBold('99.9%')).toBe(`${ESC}[1;38;2;95;206;144m99.9%${ESC}[0m`);
    });
  });

  it('never wraps an empty string', () => {
    withTty(true, undefined, () => {
      expect(paint.info('')).toBe('');
    });
  });

  it('pins the whole chosen palette', () => {
    // The user's RGB choices; a regression here silently re-themes the CLI.
    withTty(true, undefined, () => {
      const sgr = (r: number, g: number, b: number, bold = false) =>
        `${ESC}[${bold ? '1;' : ''}38;2;${r};${g};${b}mX${ESC}[0m`;
      expect(paint.prompt('X')).toBe(sgr(142, 200, 205, true));
      expect(paint.info('X')).toBe(sgr(190, 190, 190));
      expect(paint.debug('X')).toBe(sgr(160, 160, 160));
      expect(paint.warning('X')).toBe(sgr(168, 91, 75));
      expect(paint.error('X')).toBe(sgr(224, 90, 81));
      expect(paint.positive('X')).toBe(sgr(120, 168, 117));
      expect(paint.success('X')).toBe(sgr(95, 206, 144));
      expect(paint.successBold('X')).toBe(sgr(95, 206, 144, true));
      expect(paint.question('X')).toBe(sgr(87, 140, 229));
    });
  });
});
