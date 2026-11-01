/**
 * The shipped CLI source, for the drift guards that assert against real code.
 *
 * Command definitions and behavior live in src/index.ts (wiring) plus the
 * per-command modules under src/commands/, so the guards scan their
 * concatenation — file-marked, so a failure can name where a string lives.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** index.ts alone: for negative assertions about the wiring file itself. */
export const INDEX_SOURCE = readFileSync(
  new URL('../../src/index.ts', import.meta.url),
  'utf8'
);

const COMMANDS_DIR = fileURLToPath(new URL('../../src/commands/', import.meta.url));

const moduleSources = new Map<string, string>(
  readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => [file, readFileSync(join(COMMANDS_DIR, file), 'utf8')])
);

/** One src/commands module by file name ('start.ts'); throws when absent. */
export function commandSource(file: string): string {
  const source = moduleSources.get(file);
  if (source === undefined) throw new Error(`no command module at src/commands/${file}`);
  return source;
}

/** index.ts plus every src/commands module, in a stable, marker-separated order. */
export const COMMAND_SOURCE = [
  `// ===== src/index.ts =====\n${INDEX_SOURCE}`,
  ...[...moduleSources.entries()].map(
    ([file, source]) => `// ===== src/commands/${file} =====\n${source}`
  ),
].join('\n');
