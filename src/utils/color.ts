/**
 * Truecolor output themes for the CLI.
 *
 * Zero-dependency by design: the repo has no color library, and a dozen
 * SGR wrappers do not justify adding one. Every helper is gated at *call*
 * time on stdout being a TTY with NO_COLOR unset, so tests (piped workers),
 * redirected output, and NO_COLOR users all keep receiving the exact plain
 * strings the code produced before theming existed -- which is also what the
 * string-asserting test suite depends on.
 *
 * Palette is the user's choice, expressed as 24-bit RGB:
 * Prompt 142,200,205 | Info 190,190,190 | Debug 160,160,160 |
 * Warning 168,91,75 | Error 224,90,81 | Positive 120,168,117 |
 * Success 95,206,144 | Question 87,140,229
 */

/** ESC via fromCharCode: written literally, the editor layer mangles it. */
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

function enabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function rgb(r: number, g: number, b: number, options: { bold?: boolean } = {}) {
  return (text: string): string => {
    if (!enabled() || text === '') return text;
    const codes = options.bold ? `1;38;2;${r};${g};${b}` : `38;2;${r};${g};${b}`;
    return `${ESC}[${codes}m${text}${RESET}`;
  };
}

/** The REPL prompt -- bold, so it stands apart from command output. */
export const prompt = rgb(142, 200, 205, { bold: true });

/** Progress, hints, status headers, forwarded [proxy] lines. */
export const info = rgb(190, 190, 190);

/** --debug dumps: present, but deliberately quieter than info. */
export const debug = rgb(160, 160, 160);

/** Warnings, guards, and soft failures -- including the busy-gate skip. */
export const warning = rgb(168, 91, 75);

/** Command errors and startup failures. */
export const error = rgb(224, 90, 81);

/** Confirmations outside command results: startup ✓ lines, links, commands to run. */
export const positive = rgb(120, 168, 117);

/** Command success: ✓ confirmations and result labels. */
export const success = rgb(95, 206, 144);

/** Result values (SoC readings) -- the bold half of the label/value pair. */
export const successBold = rgb(95, 206, 144, { bold: true });

/** Interactive question text before the user's answer. */
export const question = rgb(87, 140, 229);
