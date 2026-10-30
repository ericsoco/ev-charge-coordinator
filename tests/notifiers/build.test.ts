/**
 * buildNotifiers: config entries + credential-store secrets → clients, with
 * deny-by-default skips that name the command fixing each missing secret.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildNotifiers, notifierRequiresSecret } from '../../src/notifiers/build.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';

const event: NotificationEvent = { type: 'test', tsMs: 1_000 };

function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('buildNotifiers', () => {
  it('builds the log client from the default entry', () => {
    const log = vi.fn();
    const targets = buildNotifiers({ entries: [{ type: 'log' }], log });
    expect(targets.map((target) => target.name)).toEqual(['log']);
    void targets[0].notifier.notify(event);
    expect(log).toHaveBeenCalledWith('[notify] 🧪 evcc test notification — notifiers are wired');
  });

  it('skips ntfy without its secret, loudly naming the fix', () => {
    const log = vi.fn();
    const targets = buildNotifiers({ entries: [{ type: 'ntfy' }], log });
    expect(targets).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('evcc notify set ntfy --topic'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ntfy skipped'));
  });

  it('skips slack without its secret, loudly naming the fix', () => {
    const log = vi.fn();
    const targets = buildNotifiers({ entries: [{ type: 'slack' }], log });
    expect(targets).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('evcc notify set slack --webhook-url'));
  });

  it('builds ntfy with its secret (server + priority knobs forwarded)', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const targets = buildNotifiers({
      entries: [{ type: 'ntfy', server: 'https://ntfy.example.com', priority: 'high' }],
      secrets: { ntfyTopic: 'evcc-secret' },
      log: vi.fn(),
      fetchImpl,
    });
    expect(targets.map((target) => target.name)).toEqual(['ntfy']);
    await targets[0].notifier.notify(event);
    expect(calls[0].url).toBe('https://ntfy.example.com/evcc-secret');
    expect((calls[0].init?.headers as Record<string, string>).Priority).toBe('high');
  });

  it('builds slack with its secret', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const targets = buildNotifiers({
      entries: [{ type: 'slack' }],
      secrets: { slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx' },
      log: vi.fn(),
      fetchImpl,
    });
    expect(targets.map((target) => target.name)).toEqual(['slack']);
    await targets[0].notifier.notify(event);
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
  });

  it('an empty config builds no clients', () => {
    expect(buildNotifiers({ entries: [], log: vi.fn() })).toEqual([]);
  });

  it('notifierRequiresSecret answers for every entry type', () => {
    expect(notifierRequiresSecret({ type: 'log' })).toBe(false);
    expect(notifierRequiresSecret({ type: 'ntfy' })).toBe(true);
    expect(notifierRequiresSecret({ type: 'slack' })).toBe(true);
  });

  it('a mixed list keeps configured clients and skips secretless ones', () => {
    const log = vi.fn();
    const targets = buildNotifiers({
      entries: [{ type: 'log' }, { type: 'ntfy' }, { type: 'slack' }],
      secrets: { ntfyTopic: 'evcc-secret' },
      log,
    });
    expect(targets.map((target) => target.name)).toEqual(['log', 'ntfy']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slack skipped'));
  });
});
