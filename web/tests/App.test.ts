import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.svelte';
import { session } from '../src/lib/apiSession.svelte';

/** Minimal Response stand-ins — jsdom need not implement the real class. */
const ok = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
const unauthorized = (): Response =>
  ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response;

function payload(): unknown {
  return {
    nowMs: 1,
    vehicle: null,
    battery: { socPercent: 71, ageMs: 1000, solarW: 0, homeLoadW: 500 },
    session: null,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

// The Now tab fetches /api/now on mount (P2 step 3); stub a minimal payload
// so the shell tests stay offline and deterministic.
beforeEach(() => {
  window.localStorage.clear();
  session.needsToken = false;
  fetchMock = vi.fn().mockResolvedValue(ok(payload()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The shell renders a bottom bar AND a rail (CSS swaps them). Depending on
 * how jsdom resolves the media query, either set can be the accessible one —
 * sometimes both — so click every match; selecting a tab twice is idempotent.
 */
async function clickTab(label: RegExp): Promise<void> {
  for (const button of screen.getAllByRole('button', { name: label })) {
    await fireEvent.click(button);
  }
}

describe('app shell', () => {
  it('opens on the Now tab', async () => {
    render(App);
    // Now renders its battery card from the stubbed /api/now payload.
    expect(await screen.findByText('Home battery')).toBeDefined();
    expect(screen.getByRole('main').textContent).toContain('Now');
  });

  it('switches tabs from the navigation', async () => {
    render(App);
    await clickTab(/Then/);
    expect(screen.getByRole('main').textContent).toContain('P2 steps 4');
    await clickTab(/Messages/);
    expect(screen.getByRole('main').textContent).toContain('P2 step 7');
    await clickTab(/Now/);
    expect(await screen.findByText('Home battery')).toBeDefined();
  });

  it('raises the shared token panel on 401 and resumes after save', async () => {
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok(payload()));
    render(App);

    // The gate is App-level: whichever page load hits 401 raises it.
    await screen.findByText('API token required');
    await fireEvent.input(screen.getByLabelText(/paste the read api token/i), {
      target: { value: 'sekrit' },
    });
    await fireEvent.submit(screen.getByRole('form', { name: 'API token' }));

    expect(await screen.findByText('Home battery')).toBeDefined();
    expect(window.localStorage.getItem('evcc.apiToken')).toBe('sekrit');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/now', {
      headers: { Authorization: 'Bearer sekrit' },
    });
  });
});