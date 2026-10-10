/**
 * Secret prompts must not echo.
 *
 * Secrets go through promptSecret in src/commands/prompt.ts, which borrows the
 * one shared readline interface and masks keystroke by keystroke -- there is no
 * second prompter to double-echo against. Pinned here: the implementation must
 * not import a prompt library, the masking lives in the shared sub-prompt
 * module (not a second interface in index.ts), and the no-TTY fallback warns
 * rather than silently echoing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
const PROMPT_SOURCE = readFileSync(new URL('../../src/commands/prompt.ts', import.meta.url), 'utf8');
const PACKAGE = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { dependencies?: Record<string, string> };

describe('promptSecret', () => {
  it('masks keystrokes instead of echoing them', () => {
    expect(PROMPT_SOURCE).toContain('export function promptSecret');
    expect(PROMPT_SOURCE).toContain("this.output.write('*')");
  });

  it('keeps the secret out of the line buffer and the shared history', () => {
    // Nothing typed reaches readline's buffer, so the secret can never echo,
    // resurface via arrow-up, or read as a command name for the main handler.
    expect(PROMPT_SOURCE).toContain('secret += s');
    expect(PROMPT_SOURCE).toContain('finish(secret)');
  });

  it('uses no prompt library', () => {
    expect(PROMPT_SOURCE).not.toContain('inquirer');
    expect(INDEX_SOURCE).not.toContain('inquirer');
    expect(INDEX_SOURCE).not.toMatch(/async function promptPassword\(/);
    expect(PACKAGE.dependencies ?? {}).not.toHaveProperty('inquirer');
  });

  it('warns when it falls back, so an unmasked prompt is never silent', () => {
    // Without a TTY there is nothing to patch; asking for a secret and hiding
    // that it is visible is worse than echoing it.
    expect(PROMPT_SOURCE).toContain('UNMASKED prompt');
    expect(PROMPT_SOURCE).toContain('console.warn');
  });

  it('borrows the shared interface instead of opening a second one', () => {
    expect(PROMPT_SOURCE).toContain('export function promptSecret');
    expect(INDEX_SOURCE).toContain('setReplReadline(rl)');
    expect(INDEX_SOURCE).not.toMatch(/async function promptSecret\(/);
  });

  it('is used for both the gateway password and the client secret', () => {
    expect(INDEX_SOURCE).toMatch(/promptSecret\('Client Secret: '\)/);
    expect(INDEX_SOURCE).toMatch(/promptSecret\('Password: '\)/);
  });
});