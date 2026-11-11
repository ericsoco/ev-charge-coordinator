import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App.svelte';

afterEach(cleanup);

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
  it('opens on the Now tab', () => {
    render(App);
    expect(screen.getByRole('main').textContent).toContain('P2 step 3');
  });

  it('switches tabs from the navigation', async () => {
    render(App);
    await clickTab(/Then/);
    expect(screen.getByRole('main').textContent).toContain('P2 steps 4');
    await clickTab(/Messages/);
    expect(screen.getByRole('main').textContent).toContain('P2 step 7');
    await clickTab(/Now/);
    expect(screen.getByRole('main').textContent).toContain('P2 step 3');
  });
});