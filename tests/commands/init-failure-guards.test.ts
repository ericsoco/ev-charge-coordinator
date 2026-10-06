/**
 * One-shot initialization guards, asserted against the real source.
 *
 * Two live defects are pinned here:
 *
 * 1. The guards negated the awaited initializer, which can never be satisfied:
 *    both initializers return a ServiceStart object, and every object is
 *    truthy -- so `process.exit(1)` below them was dead code and failures fell
 *    through into the command handler (and, on one path, into a null-service
 *    disconnect).
 * 2. When the proxy failed to start (port conflict, missing deps), the flow
 *    fell through to the credential prompt -- asking for a password that could
 *    not fix a dead proxy.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

describe('one-shot service initialization', () => {
  it('checks the .ok field through requireService, not the always-truthy object', () => {
    expect(INDEX_SOURCE).not.toContain('!(await initialize');
    expect(INDEX_SOURCE).toContain('function requireService');
    expect(INDEX_SOURCE).toContain('if (init.ok) return;');

    const sites = INDEX_SOURCE.match(/requireService\('(Tesla|FranklinWH)', await initialize/g) ?? [];
    // Five single-service actions plus charge-from-battery, which needs both.
    expect(sites).toHaveLength(7);
  });

  it('skips the credential prompt when the proxy itself failed to start', () => {
    const guard = INDEX_SOURCE.indexOf('instanceof ProxyStartupError');
    const prompt = INDEX_SOURCE.indexOf('FranklinWH authentication required.');
    expect(guard).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(prompt);
  });
});
