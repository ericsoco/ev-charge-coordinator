import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Messages from '../src/pages/Messages.svelte';
import { MESSAGES_EMPTY } from '../src/pages/messagesText';
import { session } from '../src/lib/apiSession.svelte';

/** Minimal Response stand-ins — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
const unauthorized = (): Response =>
  ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response;

function messagesPayload(): unknown {
  return {
    messages: [
      {
        id: 2,
        tsMs: Date.UTC(2026, 10, 14, 14, 3),
        type: 'charging-stopped',
        title: 'Charging stopped',
        body: '🛑 charging stopped (SoC 60%) — target reached',
      },
      {
        id: 1,
        tsMs: Date.UTC(2026, 10, 14, 14, 0),
        type: 'charging-started',
        title: 'Charging started',
        body: '⚡️ charging started (SoC 54%)',
      },
    ],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  fetchMock = vi.fn().mockResolvedValue(ok(messagesPayload()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Messages page', () => {
  it('renders recorded notifications newest-first', async () => {
    render(Messages);
    expect(await screen.findByText('Charging stopped')).toBeDefined();
    expect(screen.getByText('⚡️ charging started (SoC 54%)')).toBeDefined();

    // Newest first: the stopped row precedes the started row in the list.
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Charging stopped');
    expect(rows[1].textContent).toContain('Charging started');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/messages?limit=200&offset=0',
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  it('shows the empty state when nothing has been sent', async () => {
    fetchMock.mockResolvedValue(ok({ messages: [] }));
    render(Messages);
    expect(await screen.findByText(MESSAGES_EMPTY)).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows error + retry when the first load fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as unknown as Response);
    render(Messages);
    expect(await screen.findByText("Can't reach the read API")).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('raises the shared token gate on 401 instead of page-local auth UI', async () => {
    fetchMock.mockResolvedValue(unauthorized());
    render(Messages);
    // The loader flips session.needsToken; App renders the token panel.
    await vi.waitFor(() => expect(session.needsToken).toBe(true));
    expect(screen.getByText('Messages')).toBeDefined();
  });
});