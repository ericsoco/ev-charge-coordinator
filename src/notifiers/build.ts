/**
 * Config entries + credential-store secrets → concrete clients. A configured
 * ntfy/Slack entry without its secret is skipped with a loud log naming the
 * command that fixes it (deny-by-default — design.md §3.8).
 */
import type { NotifierConfigEntry } from '../utils/daemonConfig.js';
import { createLogLocalNotifier } from './logLocal.js';
import { createNtfyNotifier } from './ntfy.js';
import { createSlackNotifier } from './slack.js';
import type { NamedNotifier } from './types.js';

export interface NotifierSecrets {
  ntfyTopic?: string;
  slackWebhookUrl?: string;
}

export interface BuildNotifiersDeps {
  entries: NotifierConfigEntry[];
  secrets?: NotifierSecrets | undefined;
  log?: (message: string) => void;
  /** Injectable for tests; forwarded to the HTTP clients. */
  fetchImpl?: typeof fetch;
}

export function buildNotifiers(deps: BuildNotifiersDeps): NamedNotifier[] {
  const log = deps.log ?? console.log;
  const targets: NamedNotifier[] = [];
  for (const entry of deps.entries) {
    switch (entry.type) {
      case 'log':
        targets.push({ name: 'log', notifier: createLogLocalNotifier(log) });
        break;
      case 'ntfy':
        if (!deps.secrets?.ntfyTopic) {
          log(
            '[notify] ntfy configured but has no topic secret — run `evcc notify set ntfy --topic <topic>`; ntfy skipped'
          );
          break;
        }
        targets.push({
          name: 'ntfy',
          notifier: createNtfyNotifier({
            topic: deps.secrets.ntfyTopic,
            server: entry.server,
            priority: entry.priority,
            fetchImpl: deps.fetchImpl,
          }),
        });
        break;
      case 'slack':
        if (!deps.secrets?.slackWebhookUrl) {
          log(
            '[notify] slack configured but has no webhook secret — run `evcc notify set slack --webhook-url <url>`; slack skipped'
          );
          break;
        }
        targets.push({
          name: 'slack',
          notifier: createSlackNotifier({
            webhookUrl: deps.secrets.slackWebhookUrl,
            fetchImpl: deps.fetchImpl,
          }),
        });
        break;
    }
  }
  return targets;
}
