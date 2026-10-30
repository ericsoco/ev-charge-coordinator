/**
 * evcc notify set|clear|test: flag-vs-prompt secret input, config-aware
 * reminders, and test delivery through injected clients. One Command dispatch
 * per behavior (the commander quirk: subcommand flags are exercised through
 * parseAsync, not just the functions).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNotifyCommand,
  runNotifyClear,
  runNotifySet,
  runNotifyTest,
  type NotifyDeps,
} from '../../src/commands/notify.js';
import type { NotifierConfigEntry } from '../../src/notifiers/types.js';

interface FakeState {
  topic?: string;
  webhook?: string;
  cleared: number;
  prompted: string[];
  logLines: string[];
}

function fakeDeps(overrides: Partial<NotifyDeps> = {}): { deps: NotifyDeps; state: FakeState } {
  const state: FakeState = { cleared: 0, prompted: [], logLines: [] };
  const deps: NotifyDeps = {
    getNotifierEntries: (): NotifierConfigEntry[] => [{ type: 'log' }],
    getSecrets: async () => undefined,
    setNtfyTopic: async (value) => {
      state.topic = value;
    },
    setSlackWebhookUrl: async (value) => {
      state.webhook = value;
    },
    clearNotifierSecrets: async () => {
      state.cleared += 1;
    },
    promptSecret: async (question) => {
      state.prompted.push(question);
      return 'prompted-secret';
    },
    log: (message) => state.logLines.push(message),
    nowMs: () => 1_000,
    ...overrides,
  };
  return { deps, state };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('runNotifySet', () => {
  it('stores the flag value and reminds when the config lacks the entry', async () => {
    const { deps, state } = fakeDeps();
    await runNotifySet('ntfy', 'topic-1', deps);
    expect(state.topic).toBe('topic-1');
    expect(state.prompted).toEqual([]);
    expect(state.logLines.join('\n')).toContain('ntfy secret stored');
    expect(state.logLines.join('\n')).toContain('add {"type": "ntfy"} to daemon-config.json');
  });

  it('prompts (masked) when the flag is omitted', async () => {
    const { deps, state } = fakeDeps({ getNotifierEntries: () => [{ type: 'slack' }] });
    await runNotifySet('slack', undefined, deps);
    expect(state.prompted).toEqual(['slack webhook URL: ']);
    expect(state.webhook).toBe('prompted-secret');
    // Entry already configured → no reminder noise.
    expect(state.logLines.join('\n')).not.toContain('daemon-config.json');
  });

  it('surfaces store validation (bad URL) to the caller', async () => {
    const { deps, state } = fakeDeps({
      setSlackWebhookUrl: async () => {
        throw new Error('Slack webhook URL must be an http(s) URL');
      },
    });
    await expect(runNotifySet('slack', 'not-a-url', deps)).rejects.toThrow('http(s) URL');
    expect(state.logLines).toEqual([]);
  });
});

describe('runNotifyClear', () => {
  it('clears both secrets and reports it', async () => {
    const { deps, state } = fakeDeps();
    await runNotifyClear(deps);
    expect(state.cleared).toBe(1);
    expect(state.logLines).toEqual(['✓ notifier secrets cleared']);
  });
});

describe('runNotifyTest', () => {
  it('fails when the config file is invalid', async () => {
    const { deps, state } = fakeDeps({ getNotifierEntries: () => null });
    await expect(runNotifyTest(deps)).resolves.toBe(false);
    expect(state.logLines.join('\n')).toContain('daemon-config.json is invalid');
  });

  it('fails when notifications are disabled ([])', async () => {
    const { deps, state } = fakeDeps({ getNotifierEntries: () => [] });
    await expect(runNotifyTest(deps)).resolves.toBe(false);
    expect(state.logLines.join('\n')).toContain('notifiers: []');
  });

  it('fails when no configured client has its secret', async () => {
    const { deps, state } = fakeDeps({ getNotifierEntries: () => [{ type: 'ntfy' }] });
    await expect(runNotifyTest(deps)).resolves.toBe(false);
    expect(state.logLines.join('\n')).toContain('no notifier has its secret');
  });

  it('sends through log-only and reports the client list', async () => {
    const { deps, state } = fakeDeps();
    await expect(runNotifyTest(deps)).resolves.toBe(true);
    expect(state.logLines).toContain('[notify] 🧪 evcc test notification — notifiers are wired');
    expect(state.logLines).toContain('✓ test notification sent to: log');
  });

  it('sends through ntfy when its secret exists', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { deps, state } = fakeDeps({
      getNotifierEntries: () => [{ type: 'ntfy' }],
      getSecrets: async () => ({ ntfyTopic: 'evcc-secret' }),
      fetchImpl,
    });
    await expect(runNotifyTest(deps)).resolves.toBe(true);
    expect(calls).toEqual(['https://ntfy.sh/evcc-secret']);
    expect(state.logLines).toContain('✓ test notification sent to: ntfy');
  });
});

describe('createNotifyCommand dispatch', () => {
  it('routes `set ntfy --topic …` through the store', async () => {
    const { deps, state } = fakeDeps({ getNotifierEntries: () => [{ type: 'ntfy' }] });
    await createNotifyCommand(deps).parseAsync(['set', 'ntfy', '--topic', 'via-flag'], {
      from: 'user',
    });
    expect(state.topic).toBe('via-flag');
  });

  it('routes `clear`', async () => {
    const { deps, state } = fakeDeps();
    await createNotifyCommand(deps).parseAsync(['clear'], { from: 'user' });
    expect(state.cleared).toBe(1);
  });

  it('rejects an unknown kind without touching the store', async () => {
    const { deps, state } = fakeDeps();
    const command = createNotifyCommand(deps);
    command.exitOverride();
    await expect(command.parseAsync(['set', 'pigeon'], { from: 'user' })).rejects.toThrow(
      /unknown notifier kind/
    );
    expect(state.topic).toBeUndefined();
    expect(state.webhook).toBeUndefined();
  });
});
