/**
 * `evcc notify set|clear|test` — notifier secret management + delivery test
 * (design.md §3.7: secrets live in the credential store, never config.json).
 * All I/O sits behind NotifyDeps so tests dispatch through a fake store.
 */
import { Command } from 'commander';
import type { NotifierConfigEntry } from '../notifiers/types.js';
import { buildNotifiers, type NotifierSecrets } from '../notifiers/build.js';
import { createNotifierFanout } from '../notifiers/fanout.js';

export interface NotifyDeps {
  /** Resolved daemon config's notifiers; null = the config file is invalid. */
  getNotifierEntries: () => NotifierConfigEntry[] | null;
  getSecrets: () => Promise<NotifierSecrets | undefined>;
  setNtfyTopic: (topic: string) => Promise<void>;
  setSlackWebhookUrl: (url: string) => Promise<void>;
  clearNotifierSecrets: () => Promise<void>;
  /** Masked prompt used when the flag is omitted. */
  promptSecret: (question: string) => Promise<string>;
  log: (message: string) => void;
  nowMs: () => number;
  /** Injectable for tests; forwarded to the HTTP clients. */
  fetchImpl?: typeof fetch;
}

type SetKind = 'ntfy' | 'slack';

/** Store a secret (flag value or prompted) and remind about the config entry. */
export async function runNotifySet(
  kind: SetKind,
  value: string | undefined,
  deps: NotifyDeps
): Promise<void> {
  // SetKind is type-level only — a caller can coerce `any` past it. The
  // boundary checks for real, before any prompt or store write. (PR #47 ⑬)
  if (kind !== 'ntfy' && kind !== 'slack') {
    throw new Error(`unknown notifier kind '${kind}' (expected ntfy or slack)`);
  }
  const secret = value ?? (await deps.promptSecret(`${kind} ${kind === 'ntfy' ? 'topic' : 'webhook URL'}: `));
  if (kind === 'ntfy') {
    await deps.setNtfyTopic(secret);
  } else {
    await deps.setSlackWebhookUrl(secret);
  }
  deps.log(`✓ ${kind} secret stored in the credential store`);

  const entries = deps.getNotifierEntries();
  if (entries !== null && !entries.some((entry) => entry.type === kind)) {
    deps.log(
      `  note: ${kind} is not in \`notifiers\` — add {"type": "${kind}"} to daemon-config.json to enable it`
    );
  }
}

/** Drop both notifier secrets (config entries are left alone). */
export async function runNotifyClear(deps: NotifyDeps): Promise<void> {
  await deps.clearNotifierSecrets();
  deps.log('✓ notifier secrets cleared');
}

/**
 * Send one labeled test event through every configured client. Returns true
 * only when at least one client accepted it (empty/invalid config = nothing
 * sent = false, with the reason logged).
 */
export async function runNotifyTest(deps: NotifyDeps): Promise<boolean> {
  const entries = deps.getNotifierEntries();
  if (entries === null) {
    deps.log('daemon-config.json is invalid — fix it before testing notifications');
    return false;
  }
  if (entries.length === 0) {
    deps.log('notifications are disabled (notifiers: []) — nothing to test');
    return false;
  }

  const secrets = await deps.getSecrets();
  const targets = buildNotifiers({
    entries,
    secrets,
    log: deps.log,
    fetchImpl: deps.fetchImpl,
  });
  if (targets.length === 0) {
    deps.log('no notifier has its secret configured — nothing to test');
    return false;
  }

  const names = targets.map((target) => target.name);
  await createNotifierFanout(targets, deps.log).notify({ type: 'test', tsMs: deps.nowMs() });
  deps.log(`✓ test notification sent to: ${names.join(', ')}`);
  return true;
}

/** Top-level `notify` command with set/clear/test subcommands. */
export function createNotifyCommand(deps: NotifyDeps): Command {
  const notify = new Command('notify')
    .description('Manage notification secrets (ntfy, Slack) and test delivery')
    // addCommand does not inherit the program's setting, so stray positionals
    // (`notify clear extra`) must be rejected here to match the REPL parser.
    .allowExcessArguments(false)
    .showHelpAfterError();

  notify
    .command('set')
    .description('Store an ntfy topic or Slack webhook URL in the credential store')
    .argument('<kind>', 'ntfy | slack')
    .option('--topic <topic>', 'ntfy topic (masked prompt when omitted)')
    .option('--webhook-url <url>', 'Slack incoming-webhook URL (masked prompt when omitted)')
    .action(async (kind: string, options: { topic?: string; webhookUrl?: string }) => {
      if (kind !== 'ntfy' && kind !== 'slack') {
        notify.error(`error: unknown notifier kind '${kind}' (expected ntfy or slack)`);
        return;
      }
      try {
        await runNotifySet(kind, kind === 'ntfy' ? options.topic : options.webhookUrl, deps);
      } catch (error) {
        deps.log(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  notify
    .command('clear')
    .description('Remove the stored ntfy topic and Slack webhook URL')
    .action(async () => {
      try {
        await runNotifyClear(deps);
      } catch (error) {
        deps.log(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  notify
    .command('test')
    .description('Send a test event through every configured notifier')
    .action(async () => {
      if (!(await runNotifyTest(deps))) process.exitCode = 1;
    });

  return notify;
}
