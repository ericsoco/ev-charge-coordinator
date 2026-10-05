/**
 * Secret prompts must not echo.
 *
 * `promptPassword` was a readline placeholder that printed whatever was typed, so
 * passwords and client secrets landed on screen and in terminal scrollback. It now
 * masks via inquirer (already a declared dependency, with native ESM support).
 *
 * The implementation lives in index.ts, which runs program.parse() on import and so
 * cannot be imported by a test. What is pinned here is the property that matters and
 * the one thing that could silently regress: the fallback must announce that it is
 * unmasked rather than quietly echoing a secret.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

describe('promptPassword', () => {
  function body(): string {
    const start = INDEX_SOURCE.indexOf('async function promptPassword');
    expect(start).toBeGreaterThan(-1);
    return INDEX_SOURCE.slice(start, INDEX_SOURCE.indexOf('\nasync function ', start + 10));
  }

  it('masks input using inquirer', () => {
    expect(body()).toContain("import('inquirer')");
    expect(body()).toContain("type: 'password'");
  });

  it('uses inquirer on the primary path, not readline', () => {
    // The old implementation was exactly `rl.question(question, ...)` and nothing
    // else. The primary path must now be inquirer; rl.question may survive only
    // inside the catch as an announced fallback, which the next test checks.
    const primary = body().slice(0, body().indexOf('catch'));
    expect(primary).toContain("import('inquirer')");
    expect(primary).not.toContain('rl.question');
  });

  it('warns when it falls back, so an unmasked prompt is never silent', () => {
    // Asking for a secret and hiding that it is visible is worse than echoing it.
    expect(body()).toContain('UNMASKED prompt');
    expect(body()).toContain('console.warn');
  });

  it('keeps the old behaviour available as a fallback rather than failing', () => {
    // A broken import must not lock the user out of the CLI entirely.
    expect(body()).toContain('createReadline()');
  });

  it('is used for both the gateway password and the client secret', () => {
    expect(INDEX_SOURCE).toMatch(/promptPassword\('Client Secret: '\)/);
    expect(INDEX_SOURCE).toMatch(/promptPassword\('Password: '\)/);
  });
});