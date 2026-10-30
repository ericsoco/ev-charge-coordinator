/**
 * ntfy + Slack client wire shapes (design.md §3.7): URL, headers, body, and
 * honest non-2xx rejections — the fanout logs them, never the caller.
 */
import { describe, expect, it } from 'vitest';
import { createNtfyNotifier, NTFY_DEFAULT_SERVER } from '../../src/notifiers/ntfy.js';
import { createSlackNotifier } from '../../src/notifiers/slack.js';
import type { NotificationEvent } from '../../src/notifiers/types.js';

const event: NotificationEvent = {
  type: 'failure',
  tsMs: 1_000,
  component: 'ev-poll',
  message: 'boom',
};

function fakeFetch(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 200 ? 'ok' : 'nope', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function headers(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('createNtfyNotifier', () => {
  it('POSTs the formatted line to <server>/<topic> with title + priority', async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createNtfyNotifier({
      topic: 'ev cc?',
      server: 'https://ntfy.example.com/',
      priority: 'high',
      fetchImpl,
    }).notify(event);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ntfy.example.com/ev%20cc%3F');
    expect(calls[0].init?.method).toBe('POST');
    expect(headers(calls[0].init).Title).toBe('evcc failure');
    expect(headers(calls[0].init).Priority).toBe('high');
    expect(calls[0].init?.body).toBe('⚠️ ev-poll failed: boom');
  });

  it('defaults to ntfy.sh and omits Priority when unset', async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createNtfyNotifier({ topic: 'evcc', fetchImpl }).notify(event);
    expect(calls[0].url).toBe(`${NTFY_DEFAULT_SERVER}/evcc`);
    expect(headers(calls[0].init).Priority).toBeUndefined();
  });

  it('rejects on a non-2xx response (the fanout logs it)', async () => {
    const { fetchImpl } = fakeFetch(500);
    await expect(
      createNtfyNotifier({ topic: 'evcc', fetchImpl }).notify(event)
    ).rejects.toThrow('ntfy responded 500');
  });
});

describe('createSlackNotifier', () => {
  it('POSTs {"text": <line>} to the webhook URL', async () => {
    const { calls, fetchImpl } = fakeFetch();
    await createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
      fetchImpl,
    }).notify(event);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
    expect(calls[0].init?.method).toBe('POST');
    expect(headers(calls[0].init)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: '⚠️ ev-poll failed: boom' });
  });

  it('rejects on a non-2xx response (the fanout logs it)', async () => {
    const { fetchImpl } = fakeFetch(404);
    await expect(
      createSlackNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchImpl }).notify(event)
    ).rejects.toThrow('slack responded 404');
  });
});
