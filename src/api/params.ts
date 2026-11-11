/** Query-string coercion shared by the read handlers; junk → 400. */
import { ApiError } from './ApiError.js';

/** Integer query param, or undefined when absent. Arrays/objects/junk are 400s. */
export function intParam(query: Record<string, unknown>, name: string): number | undefined {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    throw new ApiError(400, `${name} must be an integer`);
  }
  return Number(raw);
}

/** Integer query param with a default (still validates when present). */
export function intParamOr(query: Record<string, unknown>, name: string, fallback: number): number {
  return intParam(query, name) ?? fallback;
}
