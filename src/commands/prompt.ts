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
 *
 * `promptSecret` wraps `_ttyWrite` the other way: typed characters never reach
 * readline's line buffer (so they cannot echo or leak into history) and each
 * one prints as `*`. Editing keys that would desync the mask are dropped;
 * without a TTY there is nothing to patch, so it warns and falls back
 * unmasked rather than echoing a secret silently.
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
  output: NodeJS.WritableStream;
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
  return (await ask(question, {})) ?? '';
}

/**
 * Ask a numeric question. Only digit keystrokes are accepted (everything else
 * is swallowed before it can echo), and a cancel resolves as null so the
 * caller can distinguish "cancelled" from "entered something invalid".
 */
export function promptNumeric(question: string): Promise<string | null> {
  return ask(question, { digitsOnly: true });
}

/**
 * Ask for a secret with each keystroke masked as `*`.
 *
 * Borrows the one interface like every other sub-prompt -- there is no second
 * prompter to double-echo against. A cancel (ESC, Ctrl+C, the interface
 * closing) folds into '', so call sites behave as if Enter was pressed on an
 * empty line and their existing empty-value validation rejects it.
 */
export function promptSecret(question: string): Promise<string> {
  return ask(question, { mask: true }).then((answer) => answer ?? '');
}

function ask(
  question: string,
  opts: { digitsOnly?: boolean; mask?: boolean }
): Promise<string | null> {
  const shared = replRl !== null;
  const rl = (replRl ?? createStandalone()) as PromptInterface;
  const owned = !shared;
  const masking = opts.mask === true && typeof rl._ttyWrite === 'function';

  if (opts.mask === true && !masking) {
    // No terminal to patch (piped input, CI): say so instead of silently echoing.
    console.warn(
      paint.warning('Warning: terminal masking is unavailable; falling back to an UNMASKED prompt.')
    );
  }

  const originalCompleter = rl.completer;
  const originalTtyWrite = opts.digitsOnly === true || masking ? rl._ttyWrite : undefined;

  return new Promise((resolve) => {
    let settled = false;
    // Masked keystrokes bypass readline's buffer entirely, so the secret lives
    // here until Enter hands it over. Unmasked prompts leave this unused.
    let secret = '';

    const onLine = (line: string): void => {
      if (masking) {
        // `line` is always '' here -- nothing typed reached the buffer -- so a
        // secret that reads as a command name can never leak to the main handler.
        finish(secret);
        return;
      }
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

    if (masking && originalTtyWrite) {
      const writeMasked = originalTtyWrite;
      rl._ttyWrite = function (s?: string, key?: Key): void {
        if (s === undefined) {
          writeMasked.call(this, s, key);
          return;
        }
        // Control combos carry no secret characters; readline still owns them
        // so Ctrl+C keeps cancelling via the SIGINT listener and Ctrl+D closes.
        if (key?.ctrl === true || key?.meta === true) {
          writeMasked.call(this, s, key);
          return;
        }
        const name = key?.name;
        if (name === 'enter' || name === 'return' || s === '\r' || s === '\n') {
          writeMasked.call(this, s, key);
          return;
        }
        if (name === 'escape') return; // the keypress listener turns this into a cancel
        if (name === 'backspace') {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            this.output.write('\b \b');
          }
          return;
        }
        // Arrows, tab, and friends would move a cursor the mask cannot see;
        // dropping them keeps the asterisks and the buffer in sync.
        if (name !== undefined && name.length > 1) return;
        secret += s;
        this.output.write('*');
      };
    } else if (originalTtyWrite) {
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
