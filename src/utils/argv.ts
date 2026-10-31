/**
 * CLI argument normalization before Commander parses.
 *
 * Commander treats any token starting with `-` as an option, so the one-shot
 * `set-home-location -33.9 151.2` failed with "unknown option '-33.9'" while
 * the REPL, which passes positional tokens raw, accepted it — any home south
 * of the equator or west of the prime meridian (including all of the Americas)
 * was unsettable from the one-shot CLI. Inserting `--` before the first
 * negative-number operand makes Commander read the rest as positionals,
 * matching the REPL.
 */

/** A token that looks like a negative number (e.g. `-90`, `-122.5`). */
function isNegativeNumber(token: string): boolean {
  return /^-\d/.test(token);
}

export function normalizeNegativePositionals(argv: string[]): string[] {
  const index = argv.indexOf('set-home-location');
  if (index === -1) return argv;
  const rest = argv.slice(index + 1);
  const firstNegative = rest.findIndex(isNegativeNumber);
  if (firstNegative === -1) return argv;
  // A `--` before the first negative number already ends option parsing; a
  // second one would be read back as an operand (the latitude).
  const endOfOptions = rest.indexOf('--');
  if (endOfOptions !== -1 && endOfOptions < firstNegative) return argv;
  const insertAt = index + 1 + firstNegative;
  return [...argv.slice(0, insertAt), '--', ...argv.slice(insertAt)];
}
