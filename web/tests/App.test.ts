import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.svelte';

// The Now tab fetches /api/now on mount (P2 step 3); stub a minimal payload
// so the shell tests stay offline and deterministic.
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        nowMs: 1,
        vehicle: null,
        battery: { socPercent: 71, ageMs: 1000, solarW: 0, homeLoadW: 500 },
        session: null,
      }),
    })
  );
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
});