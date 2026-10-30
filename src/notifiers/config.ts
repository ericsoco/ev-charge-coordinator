/**
 * Notifier-owned config parsing: the default list, cloning, and entry
 * validation (PR #47: notifier concerns live in the notifier package —
 * daemonConfig delegates here and keeps only the field plumbing).
 */
import { parseNtfyEntry } from './ntfy.js';
import {
  NOTIFIER_TYPES,
  type NotifierConfigEntry,
  type NotifierType,
} from './types.js';

/** The shipped default: visible-but-harmless local log lines. */
export const DEFAULT_NOTIFIERS: readonly NotifierConfigEntry[] = Object.freeze([
  { type: 'log' },
] as const);

export function cloneNotifiers(
  source: readonly NotifierConfigEntry[]
): NotifierConfigEntry[] {
  return source.map((entry) => ({ ...entry }));
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function typeList(): string {
  return NOTIFIER_TYPES.map((type) => `"${type}"`).join(' or ');
}

/**
 * Validate the `notifiers` array: one entry per configured client, arrays
 * replaced wholesale, ntfy knobs delegated to ntfy.ts. Absent → the log-only
 * default. Any problem returns a null value — the whole config refuses
 * rather than running half-understood.
 */
export function validateNotifierEntries(
  raw: unknown,
  file: string
): { value: NotifierConfigEntry[] | null; problems: string[] } {
  const value = cloneNotifiers(DEFAULT_NOTIFIERS);
  if (raw === undefined || raw === null) return { value, problems: [] };
  if (!Array.isArray(raw)) {
    return { value: null, problems: [`${file}: notifiers = ${show(raw)} (must be an array)`] };
  }

  const problems: string[] = [];
  const entries: NotifierConfigEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `${file}: notifiers[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${where} = ${show(entry)} (must be an object with a type)`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !NOTIFIER_TYPES.includes(type as NotifierType)) {
      problems.push(
        `${where}.type = ${show(type)} (unknown notifier type; expected ${typeList()})`
      );
      continue;
    }
    if (type === 'ntfy') {
      const parsed = parseNtfyEntry(record, where);
      problems.push(...parsed.problems);
      if (parsed.entry !== null) entries.push(parsed.entry);
      continue;
    }
    entries.push({ type: type as NotifierType });
  }

  if (problems.length > 0) return { value: null, problems };
  return { value: entries, problems: [] };
}
