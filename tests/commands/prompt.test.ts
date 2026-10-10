/**
 * Sub-prompts borrow the REPL's readline instead of opening a second one.
 *
 * The four bugs these pin: double echo (two terminal interfaces on one
 * stdin), alphabetic keystrokes accepted by numeric questions, no cancel
 * key, and the broken prompt left behind by closing the nested interface.
 * The fake REPL below is a real readline over PassThrough streams -- the
 * same arrangement production has: one interface, terminal mode, completer.
 */
import { readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { pendingQuestion, prompt, promptNumeric, promptSecret, setReplReadline } from '../../src/commands/prompt.js';

interface Repl {
  rl: Interface;
  written: string[];
  type: (text: string) => void;
  completerCalls: () => number;
}

const open: Repl[] = [];

function makeRepl(): Repl {
  const input = new PassThrough();
  const output = new PassThrough();
  (output as { columns?: number }).columns = 80;
  let completerCalls = 0;
  const rl = createInterface({
    input,
    output,
    terminal: true,
    completer: (line: string) => {
      completerCalls += 1;
      return [[], line];
    },
  });
  const written: string[] = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  setReplReadline(rl);
  const repl: Repl = {
    rl,
    written,
    type: (text: string) => input.write(text),
    completerCalls: () => completerCalls,
  };
  open.push(repl);
  return repl;
}

afterEach(() => {
  for (const repl of open.splice(0)) {
    setReplReadline(null);
    repl.rl.close();
  }
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('prompt (shared interface)', () => {
  it('answers from the shared readline and leaves it open', async () => {
    const h = makeRepl();
    const lines: string[] = [];
    h.rl.on('line', (l) => lines.push(l)); // the REPL's handleCommand
    const p = prompt('Q: ');
    h.type('hello\n');
    await expect(p).resolves.toBe('hello');
    h.type('next\n'); // still listening afterwards
    await delay(20);
    expect(lines).toContain('next');
  });

  it('leaves command names to the main handler', async () => {
    const h = makeRepl();
    const lines: string[] = [];
    h.rl.on('line', (l) => lines.push(l));
    const p = prompt('Q: ');
    let done = false;
    p.then(() => {
      done = true;
    });
    h.type('help\n');
    await delay(30);
    expect(done).toBe(false); // not consumed as the answer
    expect(lines).toContain('help'); // the main handler saw it
    h.type('answer\n');
    await expect(p).resolves.toBe('answer');
  });

  it('keeps answers out of the shared history', async () => {
    const h = makeRepl();
    const p = prompt('Q: ');
    h.type('my-answer\n');
    await p;
    const history = (h.rl as unknown as { history?: string[] }).history ?? [];
    expect(history).not.toContain('my-answer');
  });

  it('settles a cancel as an empty answer', async () => {
    const h = makeRepl();
    const p = prompt('Q: ');
    h.type('\x1b'); // ESC resolves after readline's 500ms escape timeout
    await expect(p).resolves.toBe('');
  });

  it('settles when the interface closes mid-question', async () => {
    const h = makeRepl();
    const p = prompt('Q: ');
    h.rl.close();
    await expect(p).resolves.toBe('');
  });

  it('suspends tab completion for the duration of the question', async () => {
    const h = makeRepl();
    const p = prompt('Q: ');
    h.type('\t');
    await delay(20);
    expect(h.completerCalls()).toBe(0);
    h.type('x\n');
    await p;
    h.type('\t');
    await delay(20);
    expect(h.completerCalls()).toBe(1);
  });
});

describe('promptNumeric', () => {
  it('drops non-digit keystrokes before they can echo or buffer', async () => {
    const h = makeRepl();
    const p = promptNumeric('N: ');
    h.type('7');
    h.type('a');
    h.type('x5');
    await delay(20);
    h.type('\n');
    await expect(p).resolves.toBe('75');
    const out = h.written.join('');
    expect(out).toContain('7');
    expect(out).not.toContain('a'); // never echoed
    expect(out).not.toContain('x');
  });

  it('accepts backspace as editing', async () => {
    const h = makeRepl();
    const p = promptNumeric('N: ');
    h.type('12\x7f\n');
    await expect(p).resolves.toBe('1');
  });

  it('settles null on ESC and keeps the interface usable', async () => {
    const h = makeRepl();
    const p = promptNumeric('N: ');
    h.type('\x1b');
    await expect(p).resolves.toBeNull();
    const again = promptNumeric('N: ');
    h.type('9\n');
    await expect(again).resolves.toBe('9');
  });

  it('settles an empty Enter as an empty answer', async () => {
    const h = makeRepl();
    const p = promptNumeric('N: ');
    h.type('\n');
    await expect(p).resolves.toBe('');
  });

  it('drops tab instead of injecting it into the answer', async () => {
    const h = makeRepl();
    const p = promptNumeric('N: ');
    h.type('\t3\n');
    await expect(p).resolves.toBe('3');
  });

  it('reports the open question for the REPL to redraw', async () => {
    const h = makeRepl();
    const p = promptNumeric('Number please: ');
    expect(pendingQuestion()).toBe('Number please: ');
    h.type('1\n');
    await p;
    expect(pendingQuestion()).toBeNull();
  });
});

describe('promptSecret', () => {
  it('masks each keystroke and returns the real secret', async () => {
    const h = makeRepl();
    const p = promptSecret('Secret: ');
    h.type('s3cr');
    h.type('et');
    await delay(20);
    h.type('\n');
    await expect(p).resolves.toBe('s3cret');
    const out = h.written.join('');
    expect(out).not.toContain('s3cret'); // the plaintext never reaches the terminal
    expect(out).toContain('******'); // six keystrokes, six asterisks
  });

  it('edits with backspace without desyncing the mask', async () => {
    const h = makeRepl();
    const p = promptSecret('Secret: ');
    h.type('ab\x7fc\n');
    await expect(p).resolves.toBe('ac');
  });

  it('never hands a secret to the main handler, even one naming a command', async () => {
    const h = makeRepl();
    const lines: string[] = [];
    h.rl.on('line', (l) => lines.push(l));
    const p = promptSecret('Secret: ');
    h.type('help\n');
    await expect(p).resolves.toBe('help');
    await delay(20);
    // The line event fired with the empty buffer, not the secret.
    expect(lines).not.toContain('help');
  });

  it('settles a cancel as an empty answer and restores echo afterwards', async () => {
    const h = makeRepl();
    const p = promptSecret('Secret: ');
    h.type('\x1b'); // ESC resolves after readline's 500ms escape timeout
    await expect(p).resolves.toBe('');
    const again = prompt('Q: ');
    h.type('visible\n');
    await expect(again).resolves.toBe('visible');
    expect(h.written.join('')).toContain('visible'); // echo is back
  });

  it('leaves the shared interface open and the completer restored', async () => {
    const h = makeRepl();
    const p = promptSecret('Secret: ');
    h.type('x\n');
    await p;
    h.type('\t');
    await delay(20);
    expect(h.completerCalls()).toBe(1);
    expect(pendingQuestion()).toBeNull();
  });
});

describe('index.ts wiring', () => {
  const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  it('registers the REPL interface instead of opening a second one', () => {
    expect(INDEX_SOURCE).toContain('setReplReadline(rl)');
    expect(INDEX_SOURCE).toContain('setReplReadline(null)');
    // The old implementation was a second-interface factory inside index.ts.
    expect(INDEX_SOURCE).not.toMatch(/async function prompt\(/);
  });

  it('routes every numeric sub-prompt through promptNumeric with a cancel path', () => {
    expect(INDEX_SOURCE).toContain("promptNumeric('Enter charge limit");
    expect(INDEX_SOURCE).toContain("promptNumeric('Enter battery buffer");
    expect(INDEX_SOURCE).toContain("promptNumeric('Select vehicle number");
    expect(INDEX_SOURCE).toContain("paint.info('\\nCancelled.')");
  });

  it('redraws the open question after a whitelisted command', () => {
    // Reachable live only from free-text prompts: numeric prompts keystroke-
    // block command letters by design, and the free-text check was blocked by
    // Tesla's upstream 403 on setChargeLimit (recorded in the workplan), so
    // the branch itself is pinned here.
    expect(INDEX_SOURCE).toContain('const openQuestion = pendingQuestion();');
    expect(INDEX_SOURCE).toMatch(/else if \(openQuestion && !closed\)/);
  });
});


