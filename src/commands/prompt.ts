/**
 * Sub-prompts: asking a question while a REPL command is running.
 *
 * The previous implementation opened a SECOND readline Interface on the same
 * stdin while the REPL's interface was still live, which caused four bugs:
 *
 * 1. Every keystroke echoed twice (both interfaces were in terminal mode).
 * 2. Numeric questions accepted alphabetic keystrokes; they were only rejected
 *    after Enter, leaving the garbage visible on screen.
 * 3. There was no way to cancel -- rl.question has no cancellation path.
 * 4. Closing the nested interface tore down stdin state the main prompt still
 *    needed: afterwards the terminal echoed input but readline stopped
 *    dispatching lines ("the prompt is broken").
 *
 * There is now exactly one Interface: the REPL's. A sub-prompt borrows it by
 * attaching one-shot listeners and removes every listener on every exit path:
 *
 * - `line` answers the question. Lines that name a REPL command are left to
 *   the main handler (`help` mid-question still prints help), and answers are
 *   stripped from the shared history so `25` cannot resurface via arrow-up.
 * - `keypress` on the input stream catches ESC. Node only resolves a lone ESC
 *   after its 500ms escape-code timeout (so it never eats a real escape
 *   sequence), which is why cancel lands half a second after the keypress.
 * - `SIGINT` on the interface turns Ctrl+C into a cancel: readline takes its
 *   default (kill the process) only when nothing is listening.
 * - the tab completer is swapped out for the duration, preserving the old
 *   guarantee that completion cannot splice a command name into an answer.
 *
 * One-shot flows (no REPL registered) create their own interface and close it
 * when done, as before -- two interfaces are never open at once.
 *
 * `promptNumeric` additionally wraps `_ttyWrite` -- readline's single
 * keystroke processor (instance method, verified against Node 24 -- an
 * instance-level patch intercepts every key before it is echoed) -- so only
 * digit keystrokes reach the line buffer. Non-digit keys are never echoed and
 * never accepted; validation runs on a buffer that can only hold digits.
 */

import { createInterface, type Completer, type Interface, type Key } from 'node:readline';
import * as paint from '../utils/color.js';
import { isReplCommand } from './repl.js';

/**
 * The readline internals this module relies on that @types/node does not
 * declare on the class: `input`, `completer`, and `_ttyWrite` all exist at
 * runtime (probed against Node 24).
 */
interface PromptInterface extends Interface {
  input: NodeJS.ReadableStream;
  completer?: Completer | undefined;
  _ttyWrite?: (this: PromptInterface, s?: string, key?: Key) => void;
}

/** The session's REPL interface, while one is open. */
let replRl: Interface | null = null;

/** The question currently on screen, if any -- lets the REPL redraw it after a whitelisted `help`/`status` blanked the prompt line. */
let pending: string | null = null;

/** index.ts registers the session interface at REPL start and clears it on close. */
export function setReplReadline(rl: Interface | null): void {
  replRl = rl;
}

/** The question currently waiting for an answer, or null. */
export function pendingQuestion(): string | null {
  return pending;
}

/**
 * Ask a free-text question.
 *
 * A cancel (ESC, Ctrl+C, the interface closing) folds into '', so every
 * call site keeps behaving exactly as if the user had pressed Enter on an
 * empty line: y/n prompts answer "no", validation rejects the empty value.
 */
export async function prompt(question: string): Promise<string> {
  return (await ask(question, false)) ?? '';
}

/**
 * Ask a numeric question. Only digit keystrokes are accepted (everything else
 * is swallowed before it can echo), and a cancel resolves as null so the
 * caller can distinguish "cancelled" from "entered something invalid".
 */
export function promptNumeric(question: string): Promise<string | null> {
  return ask(question, true);
}

function ask(question: string, digitsOnly: boolean): Promise<string | null> {
  const shared = replRl !== null;
  const rl = (replRl ?? createStandalone()) as PromptInterface;
  const owned = !shared;
  const originalCompleter = rl.completer;
  const originalTtyWrite = digitsOnly ? rl._ttyWrite : undefined;

  return new Promise((resolve) => {
    let settled = false;

    const onLine = (line: string): void => {
      if (!owned) {
        // A command name belongs to the main handler, not to this answer.
        if (isReplCommand(line)) return;
        // The shared history is the REPL's: an answer must not resurface via
        // arrow-up and be dispatched as a command later.
        const history = (rl as { history?: string[] }).history;
        if (history && history[0] === line) history.shift();
      }
      finish(line);
    };

    const onKeypress = (_s: string | undefined, key?: Key): void => {
      if (key?.name === 'escape') finish(null);
    };

    const onSigint = (): void => {
      finish(null);
    };

    const onClose = (): void => {
      finish(null);
    };

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      rl.removeListener('line', onLine);
      rl.removeListener('SIGINT', onSigint);
      rl.removeListener('close', onClose);
      rl.input.removeListener('keypress', onKeypress);
      rl.completer = originalCompleter;
      if (originalTtyWrite) rl._ttyWrite = originalTtyWrite;
      if (pending === question) pending = null;
      if (owned) rl.close();
      resolve(value);
    }

    if (originalTtyWrite) {
      rl._ttyWrite = function (s?: string, key?: Key): void {
        if (shouldDropKey(s, key)) return; // never echoed, never buffered
        originalTtyWrite.call(this, s, key);
      };
    }

    rl.on('line', onLine);
    rl.on('SIGINT', onSigint);
    rl.on('close', onClose);
    rl.input.on('keypress', onKeypress);
    // Completions splice text into the line buffer; an answer must not get any.
    rl.completer = undefined;

    pending = question;
    // Category: Question -- every readline question in the CLI funnels here.
    rl.setPrompt(paint.question(question));
    rl.prompt();
  });
}

/** One-shot mode: a private interface on the real stdin, closed on finish. */
function createStandalone(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

/**
 * Which keys a numeric sub-prompt swallows. Everything that is not a digit
 * (and not an editing key the answer needs: backspace, arrows, Enter, ESC)
 * is dropped before readline can echo or buffer it.
 */
function shouldDropKey(s: string | undefined, key: Key | undefined): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (key && (key.ctrl || key.meta)) return false; // Ctrl+C, arrows (ESC-prefixed)
  if (key && key.name && key.name.length > 1) {
    // Named specials: enter, backspace, escape... -- everything except tab,
    // which has no completion to offer here and would inject a literal tab.
    return key.name === 'tab';
  }
  return !/^[0-9]+$/.test(s);
}
